"""Local unit tests for /api/host/verify-password when Firestore is down.

Verifies:
  - Wrong password -> HTTP 401 {"success": False, "error": "Incorrect password"}
    and NEVER "Quota exceeded" / never HTTP 500.
  - Correct password -> HTTP 200 {"success": True} and unlocks the Host Stand
    even when Firestore raises ResourceExhausted (quota exceeded).

No live Firestore is touched: server._firestore_read_restaurant_password is
monkeypatched to raise ResourceExhausted on every call.
"""

import json
import os
import sqlite3
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/..")
import server

# ---------------------------------------------------------------------------
# ResourceExhausted stand-in (google.api_core is not installed locally)
# ---------------------------------------------------------------------------
try:
    from google.api_core.exceptions import ResourceExhausted  # noqa: F401
except Exception:
    class ResourceExhausted(Exception):
        """Stand-in mirroring google.api_core.exceptions.ResourceExhausted."""


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


def assert_not_in(needle, haystack, label):
    global passed, failed
    try:
        assert needle not in haystack, f"{label}: found {needle!r} in {haystack!r}"
        passed += 1
    except AssertionError as exc:
        failed += 1
        failures.append(str(exc))
        print(f"  FAIL: {exc}")


def section(title):
    print(f"\n{'=' * 60}\n{title}\n{'=' * 60}")


# ---------------------------------------------------------------------------
# Temp DB: minimal restaurants table mirroring server schema
# ---------------------------------------------------------------------------
_orig_db_file = server.DB_FILE


def make_temp_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    conn = sqlite3.connect(path)
    c = conn.cursor()
    c.execute(
        "CREATE TABLE restaurants (id TEXT PRIMARY KEY, name TEXT, password_hash TEXT)"
    )
    conn.commit()
    conn.close()

    def cleanup():
        try:
            os.unlink(path)
        except OSError:
            pass

    return path, cleanup


def use_temp_db(path):
    server.DB_FILE = path

    def restore():
        server.DB_FILE = _orig_db_file

    return restore


def insert_restaurant(path, rest_id, password):
    conn = sqlite3.connect(path)
    c = conn.cursor()
    c.execute(
        "INSERT INTO restaurants (id, name, password_hash) VALUES (?, ?, ?)",
        (rest_id, "Test Bistro", server.hash_password(password)),
    )
    conn.commit()
    conn.close()


def run():
    global passed, failed

    rest_id = "rest-t1"
    correct = "correctpass"
    wrong = "wrongpass"

    path, cleanup = make_temp_db()
    restore = use_temp_db(path)
    try:
        insert_restaurant(path, rest_id, correct)

        # Monkeypatch Firestore read: always raises ResourceExhausted (quota).
        firestore_calls = []

        def boom(rid):
            firestore_calls.append(rid)
            raise ResourceExhausted("Quota exceeded for quota 'ReadRequests'")

        orig_firestore_read = server._firestore_read_restaurant_password
        server._firestore_read_restaurant_password = boom
        server.RESTAURANT_PWD_CACHE.clear()

        try:
            # ===============================================================
            section("A. WRONG PASSWORD WITH FIRESTORE DOWN -> 401, NEVER QUOTA")
            # ===============================================================
            status, body = server.verify_host_password(rest_id, wrong)
            assert_eq(status, 401, "wrong password -> 401")
            assert_eq(
                body,
                {"success": False, "error": "Incorrect password"},
                "wrong password body",
            )
            body_text = json.dumps(body).lower()
            assert_not_in("quota", body_text, "wrong-password body mentions quota")
            assert_not_in("500", body_text, "wrong-password body mentions 500")
            print("  PASS: wrong password returns 401 Incorrect password (no quota leak)")

            # ===============================================================
            section("B. CORRECT PASSWORD WITH FIRESTORE DOWN -> 200 UNLOCKED")
            # ===============================================================
            status, body = server.verify_host_password(rest_id, correct)
            assert_eq(status, 200, "correct password -> 200")
            assert_true(body.get("success") is True, "correct password success=true")
            assert_true("unlocked" in json.dumps(body).lower(), "body signals unlocked")
            body_text = json.dumps(body).lower()
            assert_not_in("quota", body_text, "success body mentions quota")
            print("  PASS: correct password returns 200 Unlocked despite Firestore down")

            # ===============================================================
            section("C. FRESH IN-MEMORY CACHE -> NO FIRESTORE CALL AT ALL")
            # ===============================================================
            server.RESTAURANT_PWD_CACHE.clear()
            server.RESTAURANT_PWD_CACHE["rest-cache"] = {
                "hash": server.hash_password("cachepass"),
                "cached_at": time.time(),
            }
            firestore_calls.clear()
            # "rest-cache" does not even exist in SQLite; cache must short-circuit.
            status, body = server.verify_host_password("rest-cache", "cachepass")
            assert_eq(status, 200, "fresh cache -> 200 without Firestore")
            assert_true(
                "rest-cache" not in firestore_calls,
                "Firestore not consulted for fresh cache hit",
            )
            status, body = server.verify_host_password("rest-cache", "nope")
            assert_eq(status, 401, "fresh cache wrong password -> 401")
            assert_true(
                "rest-cache" not in firestore_calls,
                "Firestore not consulted on cache mismatch",
            )
            print("  PASS: fresh cache verified directly, Firestore never queried")

            # ===============================================================
            section("D. STALE (EXPIRED) CACHE -> FIRESTORE (RAISES) -> SQLITE")
            # ===============================================================
            server.RESTAURANT_PWD_CACHE["rest-t1"] = {
                "hash": server.hash_password("oldpass"),
                "cached_at": time.time()
                - server.RESTAURANT_PWD_CACHE_TTL_SECONDS
                - 10,
            }
            firestore_calls.clear()
            status, body = server.verify_host_password(rest_id, correct)
            assert_eq(
                status,
                200,
                "expired cache -> offline fallback (SQLite) -> 200",
            )
            assert_true(
                rest_id in firestore_calls,
                "expired cache consulted Firestore before falling back",
            )
            print("  PASS: expired cache falls through to SQLite fallback via Firestore failure")

            # ===============================================================
            section("E. ENV FALLBACK MAP (FALLBACK_RESTAURANT_PASSWORDS)")
            # ===============================================================
            server.FALLBACK_RESTAURANT_PASSWORDS = {"rest-fb": "fbpass"}
            server.RESTAURANT_PWD_CACHE.clear()
            firestore_calls.clear()
            status, body = server.verify_host_password("rest-fb", "fbpass")
            assert_eq(status, 200, "env fallback map -> 200")
            assert_true(body.get("success") is True, "env fallback success=true")
            status, body = server.verify_host_password("rest-fb", "nope")
            assert_eq(status, 401, "env fallback map wrong -> 401")
            server.FALLBACK_RESTAURANT_PASSWORDS = {}
            print("  PASS: env fallback map unlocks / rejects offline")

            # ===============================================================
            section("F. UNKNOWN RESTAURANT -> 404 (FIRESTORE REACHABLE, NO DOC)")
            # ===============================================================
            server._firestore_read_restaurant_password = lambda rid: server._FIRESTORE_MISSING
            try:
                status, body = server.verify_host_password("does-not-exist", "anything")
                assert_eq(status, 404, "unknown restaurant -> 404")
            finally:
                server._firestore_read_restaurant_password = boom
            print("  PASS: unknown restaurant -> 404 Restaurant not found")

        finally:
            server._firestore_read_restaurant_password = orig_firestore_read
            server.RESTAURANT_PWD_CACHE.clear()
    finally:
        restore()
        cleanup()

    # ------------------------------------------------------------------
    # Accuracy report
    # ------------------------------------------------------------------
    total = passed + failed
    accuracy = (passed / total * 100) if total else 0.0

    print(f"\n{'=' * 60}")
    print(f"VERIFY-PASSWORD OFFLINE TESTS")
    print(f"{'=' * 60}")
    print(f"Passed assertions: {passed}")
    print(f"Failed assertions: {failed}")
    print(f"Total assertions:  {total}")
    print(f"Overall Accuracy:  {accuracy:.2f}%")
    if failures:
        print("\nFailures:")
        for f in failures:
            print(f"  - {f}")
    print(f"{'=' * 60}")
    sys.exit(1 if accuracy < 100.0 else 0)


if __name__ == "__main__":
    run()
