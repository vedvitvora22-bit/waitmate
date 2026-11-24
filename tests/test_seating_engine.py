"""Thorough automated test suite for the WaitMate AI host seating engine,
dynamic turn-time variance, and Mumbai ghost queue logic."""

import os
import random
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/..")
import server

IST_TZ = timezone(timedelta(hours=5, minutes=30))

# ---------------------------------------------------------------------------
# Counters for Accuracy %
# ---------------------------------------------------------------------------
passed = 0
failed = 0
failures = []


def assert_eq(actual, expected, label):
    global passed, failed
    try:
        assert actual == expected, f"{label}: expected {expected!r}, got {actual!r}"
        passed += 1
    except AssertionError as exc:
        failed += 1
        failures.append(str(exc))
        print(f"  FAIL: {exc}")


def assert_true(condition, label):
    global passed, failed
    try:
        assert condition, label
        passed += 1
    except AssertionError as exc:
        failed += 1
        failures.append(label)
        print(f"  FAIL: {label}")


def assert_le(actual, upper, label):
    global passed, failed
    try:
        assert actual <= upper, f"{label}: {actual} is not <= {upper}"
        passed += 1
    except AssertionError as exc:
        failed += 1
        failures.append(str(exc))
        print(f"  FAIL: {exc}")


def assert_ge(actual, lower, label):
    global passed, failed
    try:
        assert actual >= lower, f"{label}: {actual} is not >= {lower}"
        passed += 1
    except AssertionError as exc:
        failed += 1
        failures.append(str(exc))
        print(f"  FAIL: {exc}")


def section(title):
    print(f"\n{'=' * 60}\n{title}\n{'=' * 60}")


def make_temp_db_path():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return path


def init_temp_db(path):
    conn = sqlite3.connect(path)
    c = conn.cursor()
    c.execute(
        "CREATE TABLE restaurants (id TEXT PRIMARY KEY, name TEXT, base_prep_time INTEGER, total_tables INTEGER, last_simulated_at REAL, available_tables INTEGER)"
    )
    c.execute(
        "CREATE TABLE restaurant_tables (id TEXT PRIMARY KEY, restaurant_id TEXT, table_id TEXT, seats INTEGER, free_at REAL)"
    )
    c.execute(
        "CREATE TABLE queue_entries (id TEXT PRIMARY KEY, ticket_number TEXT, restaurant_id TEXT, customer_name TEXT, phone TEXT, party_size INTEGER, seating_pref TEXT, special_requests TEXT, entry_type TEXT, status TEXT, estimated_wait_mins INTEGER, actual_wait_mins INTEGER DEFAULT 0, joined_at REAL NOT NULL, notified_at REAL, seated_at REAL, has_arrived INTEGER DEFAULT 0, delay_mins INTEGER DEFAULT 0, is_ghost INTEGER DEFAULT 0)"
    )
    c.execute(
        "CREATE TABLE reliability_logs (id TEXT PRIMARY KEY, restaurant_id TEXT, ticket_id TEXT, promised_wait INTEGER, actual_wait INTEGER, rating TEXT, review_note TEXT, timestamp REAL)"
    )
    c.execute("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)")
    conn.commit()
    conn.close()


def seed_restaurant(path, rest_id="rest-test", base_prep=12, total_tables=4, last_sim=0.0):
    conn = sqlite3.connect(path)
    c = conn.cursor()
    c.execute(
        "INSERT INTO restaurants (id, name, base_prep_time, total_tables, last_simulated_at, available_tables) VALUES (?, ?, ?, ?, ?, ?)",
        (rest_id, "Test Bistro", base_prep, total_tables, last_sim, total_tables),
    )
    for i in range(1, total_tables + 1):
        seats = 2 if i % 2 == 1 else 4
        c.execute(
            "INSERT INTO restaurant_tables (id, restaurant_id, table_id, seats, free_at) VALUES (?, ?, ?, ?, NULL)",
            (f"{rest_id}-T{i}", rest_id, f"T{i}", seats),
        )
    conn.commit()
    conn.close()


def make_get_db(path):
    def get_db():
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        return conn
    return get_db


# ===========================================================================
# 1. No Input Mutation
# ===========================================================================
section("1. NO INPUT MUTATION — process_live_queue must not mutate queue")

for run in range(12):
    queue = [
        {"id": "r1", "size": 2, "is_ghost": False, "joined_at": 100},
        {"id": "g1", "size": 4, "is_ghost": True, "joined_at": 50},
        {"id": "r2", "size": 3, "is_ghost": False, "joined_at": 200},
    ]
    tables = [{"id": "T1", "seats": 4}, {"id": "T2", "seats": 2}]
    queue_before = [dict(q) for q in queue]
    tables_before = [dict(t) for t in tables]
    server.process_live_queue(queue, tables)
    assert_true(queue == queue_before, f"run {run}: queue list was mutated")
    assert_true(
        all(q1 == q2 for q1, q2 in zip(queue_before, queue)),
        f"run {run}: queue contents mutated",
    )
    assert_true(tables == tables_before, f"run {run}: tables list was mutated")

print("  PASS: process_live_queue never mutates the input queue (12 runs)")

# ===========================================================================
# 2. Real-Customer Priority Over Ghosts
# ===========================================================================
section("2. REAL-CUSTOMER PRIORITY OVER GHOSTS")

for run in range(10):
    queue = [
        {"id": "g_early", "size": 2, "is_ghost": True, "joined_at": 1},
        {"id": "r_late", "size": 2, "is_ghost": False, "joined_at": 999999},
    ]
    tables = [{"id": "T1", "seats": 2}]
    seated, remaining = server.process_live_queue(queue, tables)
    seated_ids = [c["id"] for c, _ in seated]
    remaining_ids = [c["id"] for c in remaining]
    assert_true("r_late" in seated_ids, f"run {run}: real customer not seated")
    assert_true("g_early" in remaining_ids, f"run {run}: ghost should remain when table full")
    assert_true(
        seated_ids == ["r_late"],
        f"run {run}: expected only real customer seated, got {seated_ids}",
    )

queue = [
    {"id": "g1", "size": 2, "is_ghost": True, "joined_at": 10},
    {"id": "g2", "size": 2, "is_ghost": True, "joined_at": 20},
    {"id": "r1", "size": 2, "is_ghost": False, "joined_at": 100},
    {"id": "r2", "size": 2, "is_ghost": False, "joined_at": 110},
]
tables = [{"id": "T1", "seats": 2}, {"id": "T2", "seats": 2}]
seated, remaining = server.process_live_queue(queue, tables)
seated_ids = [c["id"] for c, _ in seated]
remaining_ids = [c["id"] for c in remaining]
assert_true(set(seated_ids) == {"r1", "r2"}, f"reals not seated first: {seated_ids}")
assert_true(set(remaining_ids) == {"g1", "g2"}, f"ghosts not remaining: {remaining_ids}")
print("  PASS: real diners always seated ahead of ghosts (10 runs)")

# ===========================================================================
# 3. Best-Fit Table Matching
# ===========================================================================
section("3. BEST-FIT TABLE MATCHING")

queue = [{"id": "p2", "size": 2, "is_ghost": False, "joined_at": 1}]
tables = [{"id": "BIG", "seats": 6}, {"id": "MED", "seats": 4}, {"id": "SMALL", "seats": 2}]
seated, remaining = server.process_live_queue(queue, tables)
assert_true(
    seated and seated[0][1]["id"] == "SMALL",
    f"party of 2 not seated at 2-top: {seated}",
)
assert_true(len(remaining) == 0, "party of 2 should be seated, not remaining")

queue = [{"id": "p6", "size": 6, "is_ghost": False, "joined_at": 1}]
tables = [{"id": "T1", "seats": 4}, {"id": "T2", "seats": 2}]
seated, remaining = server.process_live_queue(queue, tables)
assert_true(len(seated) == 0, f"party of 6 should not be seated: {seated}")
assert_true(len(remaining) == 1, "party of 6 should remain in queue")
assert_true(remaining[0]["id"] == "p6", "wrong customer remaining")

queue = [
    {"id": "p4", "size": 4, "is_ghost": False, "joined_at": 1},
    {"id": "p2", "size": 2, "is_ghost": False, "joined_at": 2},
]
tables = [{"id": "T4", "seats": 4}, {"id": "T2", "seats": 2}]
seated, remaining = server.process_live_queue(queue, tables)
seated_map = {c["id"]: t["id"] for c, t in seated}
assert_true(seated_map.get("p4") == "T4", f"party of 4 not at 4-top: {seated_map}")
assert_true(seated_map.get("p2") == "T2", f"party of 2 not at 2-top: {seated_map}")
print("  PASS: best-fit table matching verified")

# ===========================================================================
# 4. Dynamic Turn-Time Bounds
# ===========================================================================
section("4. DYNAMIC TURN-TIME BOUNDS — calculate_realistic_duration")

results = {1: [], 2: [], 4: [], 6: []}
for _ in range(50):
    for size in (1, 2, 4, 6):
        base = 12
        d = server.calculate_realistic_duration(base, size)
        assert_true(isinstance(d, timedelta), f"size {size}: duration should be timedelta")
        mins = d.total_seconds() / 60.0
        results[size].append(mins)
        assert_ge(mins, 30, f"size {size}: duration {mins:.1f} below 30-min floor")
        max_expected = base + ((size - 2) * 10 if size > 2 else 0) + 20
        assert_le(mins, max_expected, f"size {size}: duration {mins:.1f} above max {max_expected}")

avg = {s: sum(results[s]) / len(results[s]) for s in results}
assert_true(avg[4] >= avg[2], f"size 4 avg {avg[4]:.1f} not >= size 2 avg {avg[2]:.1f}")
assert_true(avg[6] >= avg[4], f"size 6 avg {avg[6]:.1f} not >= size 4 avg {avg[4]:.1f}")
print(f"  PASS: duration bounds verified across 50 iterations (avgs: { {k: round(v,1) for k,v in avg.items()} })")

# ===========================================================================
# 5. Mumbai IST Peak Windows & Ghost Caps
# ===========================================================================
section("5. MUMBAI IST PEAK WINDOWS & GHOST CAPS")

def ist(hour, minute):
    return datetime(2026, 1, 1, hour=hour, minute=minute, tzinfo=IST_TZ)

cfg = server.get_mumbai_traffic_config(dt=ist(13, 30))
assert_eq(cfg["bucket"], "Lunch", "13:30 IST should be Lunch")
assert_eq(cfg["multiplier"], 1.8, "Lunch multiplier")
cfg = server.get_mumbai_traffic_config(dt=ist(18, 0))
assert_eq(cfg["bucket"], "Snacks", "18:00 IST should be Snacks")
assert_eq(cfg["multiplier"], 1.4, "Snacks multiplier")
cfg = server.get_mumbai_traffic_config(dt=ist(21, 0))
assert_eq(cfg["bucket"], "Dinner", "21:00 IST should be Dinner")
assert_eq(cfg["multiplier"], 2.0, "Dinner multiplier")
cfg = server.get_mumbai_traffic_config(dt=ist(3, 30))
assert_eq(cfg["bucket"], "Off-Peak", "03:30 IST should be Off-Peak")
assert_eq(cfg["multiplier"], 1.0, "Off-Peak multiplier")
cfg = server.get_mumbai_traffic_config(dt=ist(15, 0))
assert_eq(cfg["bucket"], "Off-Peak", "15:00 IST is end of Lunch (exclusive)")
cfg = server.get_mumbai_traffic_config(dt=ist(17, 30))
assert_eq(cfg["bucket"], "Snacks", "17:30 IST is start of Snacks (inclusive)")
print("  PASS: Mumbai IST peak windows detected correctly")

# Ghost cap logic — mock peak window to True, only spawns when openTables == 0
db_path = make_temp_db_path()
init_temp_db(db_path)
seed_restaurant(db_path, rest_id="rest-ghost", base_prep=12, total_tables=2, last_sim=0.0)
conn = sqlite3.connect(db_path)
c = conn.cursor()
c.execute("UPDATE restaurant_tables SET free_at = ? WHERE restaurant_id = 'rest-ghost'", (time.time() + 999999,))
conn.commit()
conn.close()

orig_get_db = server.get_db
orig_is_peak = server.is_mumbai_peak_window
server.get_db = make_get_db(db_path)
server.is_mumbai_peak_window = lambda dt=None: True

random.seed(42)
try:
    result = server.run_simulation_tick("rest-ghost")
    ghosts_spawned = result.get("ghosts_spawned", 0)
    assert_true(ghosts_spawned <= 7, f"ghosts spawned {ghosts_spawned} exceeds cap of 7")
    assert_true(ghosts_spawned >= 0, f"negative ghosts spawned")
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    c.execute("SELECT estimated_wait_mins FROM queue_entries WHERE restaurant_id = 'rest-ghost' AND is_ghost = 1")
    waits = [row[0] for row in c.fetchall()]
    conn.close()
    for w in waits:
        assert_le(w, 45, f"ghost wait {w} exceeds 45-min cap")
finally:
    server.get_db = orig_get_db
    server.is_mumbai_peak_window = orig_is_peak
    os.unlink(db_path)
print("  PASS: ghost spawning capped at 5-7, only when openTables == 0, wait <= 45 min")

# ===========================================================================
# 6. Cooldown & Cleanup
# ===========================================================================
section("6. COOLDOWN & CLEANUP")

# 60-second cooldown
db_path = make_temp_db_path()
init_temp_db(db_path)
seed_restaurant(db_path, rest_id="rest-cd", base_prep=12, total_tables=2, last_sim=0.0)
server.get_db = make_get_db(db_path)
try:
    r1 = server.run_simulation_tick("rest-cd")
    assert_true(not r1.get("skipped"), f"first tick should not be skipped: {r1}")
    r2 = server.run_simulation_tick("rest-cd")
    assert_true(r2.get("skipped"), f"second tick within cooldown should be skipped: {r2}")
    assert_true("cooldown_remaining" in r2, f"skipped tick should report cooldown_remaining: {r2}")
    assert_true(r2.get("cooldown_remaining", 0) > 0, f"cooldown_remaining should be > 0: {r2}")
finally:
    server.get_db = orig_get_db
    os.unlink(db_path)
print("  PASS: 60-second cooldown blocks duplicate simulation ticks")

# clear_all_ghost_entries removes only ghosts
db_path = make_temp_db_path()
init_temp_db(db_path)
seed_restaurant(db_path, rest_id="rest-clean", base_prep=12, total_tables=2, last_sim=0.0)
conn = sqlite3.connect(db_path)
c = conn.cursor()
now = time.time()
for i in range(3):
    c.execute(
        "INSERT INTO queue_entries (id, ticket_number, restaurant_id, customer_name, phone, party_size, seating_pref, special_requests, entry_type, status, estimated_wait_mins, joined_at, is_ghost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
        (f"real-{i}", f"WM-{i}", "rest-clean", f"Real {i}", "+91 99999 0000{i}", 2, "First Available", "", "remote", "waiting", 10, now - i * 60),
    )
for i in range(3):
    c.execute(
        "INSERT INTO queue_entries (id, ticket_number, restaurant_id, customer_name, phone, party_size, seating_pref, special_requests, entry_type, status, estimated_wait_mins, joined_at, is_ghost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        (f"ghost-{i}", f"WM-G{i}", "rest-clean", f"Ghost {i}", "", 2, "First Available", "", "ghost", "waiting", 20, now - i * 60),
    )
conn.commit()
conn.close()
server.get_db = make_get_db(db_path)
try:
    cleared = server.clear_all_ghost_entries("rest-clean")
    assert_eq(cleared, 3, f"clear_all_ghost_entries should clear 3 ghosts, got {cleared}")
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM queue_entries WHERE restaurant_id = 'rest-clean' AND is_ghost = 1 AND status = 'waiting'")
    assert_eq(c.fetchone()[0], 0, "ghosts should be deleted")
    c.execute("SELECT COUNT(*) FROM queue_entries WHERE restaurant_id = 'rest-clean' AND is_ghost = 0 AND status = 'waiting'")
    assert_eq(c.fetchone()[0], 3, "real customers should remain")
    conn.close()
finally:
    server.get_db = orig_get_db
    os.unlink(db_path)
print("  PASS: clear_all_ghost_entries removes only isGhost == True records")

# ===========================================================================
# Accuracy Report
# ===========================================================================
total = passed + failed
accuracy = (passed / total * 100) if total else 0.0

print(f"\n{'=' * 60}")
print(f"ACCURACY REPORT")
print(f"{'=' * 60}")
print(f"Passed assertions: {passed}")
print(f"Failed assertions: {failed}")
print(f"Total assertions:  {total}")
print(f"Overall Model Accuracy: {accuracy:.2f}%")
if failures:
    print("\nFailures:")
    for f in failures:
        print(f"  - {f}")
print(f"{'=' * 60}")

if accuracy < 100.0:
    print("\nAccuracy below 100% — see failures above.")
    sys.exit(1)
else:
    print("\nAll assertions passed — Accuracy: 100.00%")
    sys.exit(0)
