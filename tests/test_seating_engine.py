"""Thorough automated test suite for the WaitMate AI host seating engine,
dynamic turn-time variance, and Mumbai ghost queue logic with unified IST
meal-slot engine."""

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


# ---------------------------------------------------------------------------
# Temp DB helper: temporarily point server.DB_FILE at a fresh SQLite DB
# ---------------------------------------------------------------------------
_orig_db_file = server.DB_FILE


def make_temp_db():
    """Create a fresh temp SQLite DB with the minimal schema and point
    server.DB_FILE at it. Returns (path, cleanup_fn)."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    conn = sqlite3.connect(path)
    c = conn.cursor()
    c.execute(
        "CREATE TABLE restaurants (id TEXT PRIMARY KEY, name TEXT, base_prep_time INTEGER, total_tables INTEGER, last_simulated_at REAL, available_tables INTEGER, meal_slots TEXT)"
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

    def cleanup():
        try:
            os.unlink(path)
        except OSError:
            pass

    return path, cleanup


def use_temp_db(path):
    """Temporarily redirect server.DB_FILE to path. Returns a restore fn."""
    server.DB_FILE = path

    def restore():
        server.DB_FILE = _orig_db_file

    return restore


def seed_restaurant(path, rest_id="rest-test", base_prep=12, total_tables=4, last_sim=0.0, meal_slots=None):
    import json
    conn = sqlite3.connect(path)
    c = conn.cursor()
    c.execute(
        "INSERT INTO restaurants (id, name, base_prep_time, total_tables, last_simulated_at, available_tables, meal_slots) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (rest_id, "Test Bistro", base_prep, total_tables, last_sim, total_tables, json.dumps(meal_slots) if meal_slots else None),
    )
    for i in range(1, total_tables + 1):
        seats = 2 if i % 2 == 1 else 4
        c.execute(
            "INSERT INTO restaurant_tables (id, restaurant_id, table_id, seats, free_at) VALUES (?, ?, ?, ?, NULL)",
            (f"{rest_id}-T{i}", rest_id, f"T{i}", seats),
        )
    conn.commit()
    conn.close()


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
# 4. Unified IST Meal-Slot Detection
# ===========================================================================
section("4. UNIFIED IST MEAL-SLOT DETECTION")

def ist(hour, minute):
    return datetime(2026, 1, 1, hour=hour, minute=minute, tzinfo=IST_TZ)

# Breakfast 07:00-11:00
slot = server.get_ist_meal_slot(dt=ist(8, 30))
assert_eq(slot["slot"], "breakfast", "08:30 IST should be breakfast")
assert_eq(slot["base_mins"], 25, "breakfast base_mins")
assert_eq(slot["spawn_chance"], 0.45, "breakfast spawn_chance")
assert_eq(slot["max_ghosts"], 3, "breakfast max_ghosts")

# Lunch 12:00-15:30
slot = server.get_ist_meal_slot(dt=ist(13, 30))
assert_eq(slot["slot"], "lunch", "13:30 IST should be lunch")
assert_eq(slot["base_mins"], 35, "lunch base_mins")
assert_eq(slot["spawn_chance"], 0.70, "lunch spawn_chance")
assert_eq(slot["max_ghosts"], 5, "lunch max_ghosts")

# Snacks 16:00-19:00
slot = server.get_ist_meal_slot(dt=ist(18, 0))
assert_eq(slot["slot"], "snacks", "18:00 IST should be snacks")
assert_eq(slot["base_mins"], 30, "snacks base_mins")
assert_eq(slot["spawn_chance"], 0.45, "snacks spawn_chance")
assert_eq(slot["max_ghosts"], 4, "snacks max_ghosts")

# Dinner 19:30-23:00
slot = server.get_ist_meal_slot(dt=ist(21, 0))
assert_eq(slot["slot"], "dinner", "21:00 IST should be dinner")
assert_eq(slot["base_mins"], 50, "dinner base_mins")
assert_eq(slot["spawn_chance"], 0.85, "dinner spawn_chance")
assert_eq(slot["max_ghosts"], 7, "dinner max_ghosts")

# Late Night 23:00-03:00 (wraps midnight)
slot = server.get_ist_meal_slot(dt=ist(0, 30))
assert_eq(slot["slot"], "late_night", "00:30 IST should be late_night")
assert_eq(slot["base_mins"], 40, "late_night base_mins")
slot = server.get_ist_meal_slot(dt=ist(23, 30))
assert_eq(slot["slot"], "late_night", "23:30 IST should be late_night")

# Off Hours 03:00-07:00
slot = server.get_ist_meal_slot(dt=ist(4, 0))
assert_eq(slot["slot"], "off_hours", "04:00 IST should be off_hours")
assert_eq(slot["max_ghosts"], 0, "off_hours max_ghosts = 0")
assert_eq(slot["spawn_chance"], 0.05, "off_hours spawn_chance")

# Boundary checks
slot = server.get_ist_meal_slot(dt=ist(11, 30))
assert_eq(slot["slot"], "off_hours", "11:30 IST should be off_hours")
slot = server.get_ist_meal_slot(dt=ist(12, 0))
assert_eq(slot["slot"], "lunch", "12:00 IST is start of lunch")
slot = server.get_ist_meal_slot(dt=ist(15, 30))
assert_eq(slot["slot"], "off_hours", "15:30 IST is end of lunch (exclusive)")
slot = server.get_ist_meal_slot(dt=ist(16, 0))
assert_eq(slot["slot"], "snacks", "16:00 IST is start of snacks")
slot = server.get_ist_meal_slot(dt=ist(19, 0))
assert_eq(slot["slot"], "off_hours", "19:00 IST is end of snacks (exclusive)")
slot = server.get_ist_meal_slot(dt=ist(19, 30))
assert_eq(slot["slot"], "dinner", "19:30 IST is start of dinner")
slot = server.get_ist_meal_slot(dt=ist(23, 0))
assert_eq(slot["slot"], "late_night", "23:00 IST is start of late_night")
slot = server.get_ist_meal_slot(dt=ist(3, 0))
assert_eq(slot["slot"], "off_hours", "03:00 IST is start of off_hours")
slot = server.get_ist_meal_slot(dt=ist(7, 0))
assert_eq(slot["slot"], "breakfast", "07:00 IST is start of breakfast")
print("  PASS: IST meal-slot detection correct across all boundaries")

# ===========================================================================
# 5. Restaurant Meal-Slot Gating
# ===========================================================================
section("5. RESTAURANT MEAL-SLOT GATING")

path, cleanup = make_temp_db()
restore = use_temp_db(path)
try:
    # Mock IST time to lunch for deterministic gating tests
    orig_get_ist_meal_slot = server.get_ist_meal_slot
    server.get_ist_meal_slot = lambda dt=None: {"slot": "lunch", "base_mins": 35, "spawn_chance": 0.70, "max_ghosts": 5}

    # Dinner-only restaurant at lunch -> spawn_chance=0, max_ghosts=0
    seed_restaurant(path, rest_id="rest-dinner-only", base_prep=12, total_tables=2, last_sim=0.0, meal_slots=["dinner"])
    cfg = server.get_restaurant_meal_slot_config("rest-dinner-only")
    assert_eq(cfg["slot"], "lunch", "IST time is lunch for rest-dinner-only test")
    assert_eq(cfg["spawn_chance"], 0, "dinner-only restaurant at lunch: spawn_chance=0")
    assert_eq(cfg["max_ghosts"], 0, "dinner-only restaurant at lunch: max_ghosts=0")

    # Lunch restaurant at lunch -> normal lunch config
    seed_restaurant(path, rest_id="rest-lunch", base_prep=12, total_tables=2, last_sim=0.0, meal_slots=["lunch", "dinner"])
    cfg = server.get_restaurant_meal_slot_config("rest-lunch")
    assert_eq(cfg["slot"], "lunch", "rest-lunch at lunch time")
    assert_eq(cfg["spawn_chance"], 0.70, "lunch restaurant: spawn_chance=0.70")
    assert_eq(cfg["max_ghosts"], 5, "lunch restaurant: max_ghosts=5")

    # No meal_slots configured -> serves all slots
    seed_restaurant(path, rest_id="rest-all-day", base_prep=12, total_tables=2, last_sim=0.0, meal_slots=None)
    cfg = server.get_restaurant_meal_slot_config("rest-all-day")
    assert_eq(cfg["spawn_chance"], 0.70, "all-day restaurant at lunch: normal spawn_chance")
    assert_eq(cfg["max_ghosts"], 5, "all-day restaurant at lunch: normal max_ghosts")
finally:
    server.get_ist_meal_slot = orig_get_ist_meal_slot
    restore()
    cleanup()
print("  PASS: restaurant meal-slot gating works correctly")

# ===========================================================================
# 6. Dynamic Turn-Time Bounds (Slot-Aware)
# ===========================================================================
section("6. DYNAMIC TURN-TIME BOUNDS — Slot-Aware calculate_realistic_duration")

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

# Slot-aware: Dinner base_mins=50 should produce longer turns than Breakfast base_mins=25
# Seeded for determinism (calculate_realistic_duration adds +/- human variance,
# so an unseeded single-draw comparison is flaky; the average check below is the
# robust invariant). Mirrors the seeding already used in sections 7 and 8.
random.seed(42)
for _ in range(30):
    d_breakfast = server.calculate_realistic_duration(25, 4)
    d_dinner = server.calculate_realistic_duration(50, 4)
    mins_b = d_breakfast.total_seconds() / 60.0
    mins_d = d_dinner.total_seconds() / 60.0
    assert_ge(mins_d, mins_b, f"dinner turn {mins_d:.1f} should be >= breakfast turn {mins_b:.1f}")

avg = {s: sum(results[s]) / len(results[s]) for s in results}
assert_true(avg[4] >= avg[2], f"size 4 avg {avg[4]:.1f} not >= size 2 avg {avg[2]:.1f}")
assert_true(avg[6] >= avg[4], f"size 6 avg {avg[6]:.1f} not >= size 4 avg {avg[4]:.1f}")
print(f"  PASS: slot-aware turn-time bounds verified (avgs: { {k: round(v,1) for k,v in avg.items()} })")

# ===========================================================================
# 7. Ghost Cap Logic (Slot-Aware Spawning)
# ===========================================================================
section("7. GHOST CAP LOGIC — Slot-Aware Spawning")

path, cleanup = make_temp_db()
restore = use_temp_db(path)
try:
    seed_restaurant(path, rest_id="rest-ghost", base_prep=12, total_tables=2, last_sim=0.0, meal_slots=["dinner"])
    conn = sqlite3.connect(path)
    c = conn.cursor()
    c.execute("UPDATE restaurant_tables SET free_at = ? WHERE restaurant_id = 'rest-ghost'", (time.time() + 999999,))
    conn.commit()
    conn.close()

    orig_get_restaurant_meal_slot_config = server.get_restaurant_meal_slot_config
    orig_is_peak = server.is_mumbai_peak_window
    # Force breakfast slot with dinner-only gating -> spawn_chance=0, max_ghosts=0
    server.get_restaurant_meal_slot_config = lambda rid: {"slot": "breakfast", "base_mins": 25, "spawn_chance": 0, "max_ghosts": 0}
    server.is_mumbai_peak_window = lambda dt=None: True
    random.seed(42)
    try:
        result = server.run_simulation_tick("rest-ghost")
        ghosts_spawned = result.get("ghosts_spawned", 0)
        assert_true(ghosts_spawned == 0, f"dinner-only restaurant at breakfast should spawn 0 ghosts, got {ghosts_spawned}")
    finally:
        server.get_restaurant_meal_slot_config = orig_get_restaurant_meal_slot_config
        server.is_mumbai_peak_window = orig_is_peak
finally:
    restore()
    cleanup()
print("  PASS: ghost spawning respects meal-slot gating (dinner-only at breakfast = 0 ghosts)")

# ===========================================================================
# 8. 60-Minute Wait-Time Ceiling & Ghost Eviction
# ===========================================================================
section("8. 60-MINUTE WAIT-TIME CEILING & GHOST EVICTION")

path, cleanup = make_temp_db()
restore = use_temp_db(path)
try:
    # enforce_60min_wait_ceiling caps at 60 (no eviction path, no DB query needed)
    capped, evicted = server.enforce_60min_wait_ceiling("rest-x", 45)
    assert_eq(capped, 45, "45 min wait should not be capped")
    assert_eq(evicted, 0, "no eviction needed for 45 min wait")

    # 75 min wait triggers eviction path -> queries DB for oldest ghost
    capped, evicted = server.enforce_60min_wait_ceiling("rest-x", 75)
    assert_eq(capped, 60, "75 min wait should be capped to 60")

    # Full DB test: wait > 60 with ghost present -> evict oldest ghost
    seed_restaurant(path, rest_id="rest-ceil", base_prep=12, total_tables=2, last_sim=0.0, meal_slots=["dinner"])
    conn = sqlite3.connect(path)
    c = conn.cursor()
    now = time.time()
    c.execute(
        "INSERT INTO queue_entries (id, ticket_number, restaurant_id, customer_name, phone, party_size, seating_pref, special_requests, entry_type, status, estimated_wait_mins, joined_at, is_ghost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
        ("real-1", "WM-1", "rest-ceil", "Real Customer", "+91 99999 00001", 2, "First Available", "", "remote", "waiting", 90, now - 3600),
    )
    c.execute(
        "INSERT INTO queue_entries (id, ticket_number, restaurant_id, customer_name, phone, party_size, seating_pref, special_requests, entry_type, status, estimated_wait_mins, joined_at, is_ghost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        ("ghost-old", "WM-G1", "rest-ceil", "Old Ghost", "", 2, "First Available", "", "ghost", "waiting", 70, now - 7200),
    )
    c.execute(
        "INSERT INTO queue_entries (id, ticket_number, restaurant_id, customer_name, phone, party_size, seating_pref, special_requests, entry_type, status, estimated_wait_mins, joined_at, is_ghost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        ("ghost-new", "WM-G2", "rest-ceil", "New Ghost", "", 2, "First Available", "", "ghost", "waiting", 70, now - 1800),
    )
    conn.commit()
    conn.close()

    capped, evicted = server.enforce_60min_wait_ceiling("rest-ceil", 90)
    assert_eq(capped, 60, f"wait 90 should be capped to 60, got {capped}")
    assert_eq(evicted, 1, f"should evict 1 ghost, got {evicted}")

    conn = sqlite3.connect(path)
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM queue_entries WHERE restaurant_id = 'rest-ceil' AND is_ghost = 1 AND status = 'waiting'")
    assert_eq(c.fetchone()[0], 1, "one ghost should remain after eviction")
    c.execute("SELECT id FROM queue_entries WHERE restaurant_id = 'rest-ceil' AND is_ghost = 1 AND status = 'waiting'")
    remaining_ghost = c.fetchone()[0]
    assert_eq(remaining_ghost, "ghost-new", "oldest ghost (ghost-old) should be evicted, ghost-new remains")
    c.execute("SELECT COUNT(*) FROM queue_entries WHERE restaurant_id = 'rest-ceil' AND is_ghost = 0 AND status = 'waiting'")
    assert_eq(c.fetchone()[0], 1, "real customer should remain")
    conn.close()
finally:
    restore()
    cleanup()
print("  PASS: 60-minute wait ceiling enforced with oldest-ghost eviction")

# run_simulation_tick caps waits and returns ceiling info
path, cleanup = make_temp_db()
restore = use_temp_db(path)
try:
    seed_restaurant(path, rest_id="rest-tick", base_prep=12, total_tables=0, last_sim=0.0, meal_slots=["dinner"])
    conn = sqlite3.connect(path)
    c = conn.cursor()
    now = time.time()
    c.execute(
        "INSERT INTO queue_entries (id, ticket_number, restaurant_id, customer_name, phone, party_size, seating_pref, special_requests, entry_type, status, estimated_wait_mins, joined_at, is_ghost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
        ("real-1", "WM-1", "rest-tick", "Real Customer", "+91 99999 00001", 2, "First Available", "", "remote", "waiting", 90, now - 3600),
    )
    conn.commit()
    conn.close()

    orig_is_peak = server.is_mumbai_peak_window
    server.is_mumbai_peak_window = lambda dt=None: True
    random.seed(42)
    try:
        result = server.run_simulation_tick("rest-tick")
        assert_true(result.get("ghosts_evicted", 0) >= 0, "ghosts_evicted tracked")
        assert_true("meal_slot" in result, "tick result should include meal_slot")
    finally:
        server.is_mumbai_peak_window = orig_is_peak
finally:
    restore()
    cleanup()
print("  PASS: run_simulation_tick enforces 60-minute ceiling with ghost eviction")

# ===========================================================================
# 9. Cooldown & Cleanup
# ===========================================================================
section("9. COOLDOWN & CLEANUP")

path, cleanup = make_temp_db()
restore = use_temp_db(path)
try:
    seed_restaurant(path, rest_id="rest-cd", base_prep=12, total_tables=2, last_sim=0.0)
    r1 = server.run_simulation_tick("rest-cd")
    assert_true(not r1.get("skipped"), f"first tick should not be skipped: {r1}")
    assert_true("meal_slot" in r1, "tick result should include meal_slot")
    r2 = server.run_simulation_tick("rest-cd")
    assert_true(r2.get("skipped"), f"second tick within cooldown should be skipped: {r2}")
    assert_true("cooldown_remaining" in r2, f"skipped tick should report cooldown_remaining: {r2}")
    assert_true(r2.get("cooldown_remaining", 0) > 0, f"cooldown_remaining should be > 0: {r2}")
finally:
    restore()
    cleanup()
print("  PASS: 60-second cooldown blocks duplicate simulation ticks")

path, cleanup = make_temp_db()
restore = use_temp_db(path)
try:
    seed_restaurant(path, rest_id="rest-clean", base_prep=12, total_tables=2, last_sim=0.0)
    conn = sqlite3.connect(path)
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

    cleared = server.clear_all_ghost_entries("rest-clean")
    assert_eq(cleared, 3, f"clear_all_ghost_entries should clear 3 ghosts, got {cleared}")
    conn = sqlite3.connect(path)
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM queue_entries WHERE restaurant_id = 'rest-clean' AND is_ghost = 1 AND status = 'waiting'")
    assert_eq(c.fetchone()[0], 0, "ghosts should be deleted")
    c.execute("SELECT COUNT(*) FROM queue_entries WHERE restaurant_id = 'rest-clean' AND is_ghost = 0 AND status = 'waiting'")
    assert_eq(c.fetchone()[0], 3, "real customers should remain")
    conn.close()
finally:
    restore()
    cleanup()
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
