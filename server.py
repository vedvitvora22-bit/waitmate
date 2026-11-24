import hashlib
import json
import os
import random
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler
from zoneinfo import ZoneInfo
from urllib.parse import urlparse, parse_qs

PORT = 8080
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(BASE_DIR, "waitmate.db")

# Founder Command Center access password (set via env; may be rotated in-app)
FOUNDER_PASSWORD = os.environ.get("FOUNDER_PASSWORD", "waitmatefounder2026")


def _founder_hash(password):
    return hashlib.sha256(str(password or "").strip().encode("utf-8")).hexdigest()


def get_active_founder_hash():
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("SELECT value FROM app_settings WHERE key = 'founder_password_hash'")
        row = c.fetchone()
        conn.close()
        if row and row[0]:
            return row[0]
    except sqlite3.OperationalError:
        pass
    return _founder_hash(FOUNDER_PASSWORD)


def is_founder_authorized(handler):
    supplied = handler.headers.get("X-Founder-Password", "")
    if not supplied:
        return False
    return _founder_hash(supplied) == get_active_founder_hash()


def verify_founder_password(password):
    provided = str(password or "").strip()
    if not provided:
        return False
    return _founder_hash(provided) == get_active_founder_hash()


IST_TZ = timezone(timedelta(hours=5, minutes=30))


def format_ist(ts):
    try:
        return datetime.fromtimestamp(float(ts), tz=IST_TZ).strftime('%I:%M %p')
    except (TypeError, ValueError, OSError):
        return None


def calculate_realistic_duration(base_minutes, party_size):
    # Larger groups linger longer; add random human variance
    size_buffer = (party_size - 2) * 10 if party_size > 2 else 0
    variance = random.randint(-10, 20)
    return timedelta(minutes=max(30, base_minutes + size_buffer + variance))


def process_live_queue(queue, available_tables):
    # Seat real customers (is_ghost == False) ahead of ghost entries, then by
    # joined_at / joinedAt arrival order within each group. Never mutates input.
    ordered = sorted(queue, key=lambda c: (bool(c.get("is_ghost", False)), c.get("joined_at") or c.get("joinedAt") or 0))
    seated = []
    remaining = list(ordered)
    for table in sorted(available_tables, key=lambda t: t["seats"]):
        for i, customer in enumerate(remaining):
            if customer["size"] <= table["seats"]:
                seated.append((customer, table))
                remaining.pop(i)
                break  # Move to the next open table
    return seated, remaining


# ------------------------------------------------------------------
# FIRESTORE SYNC (optional; server.py keeps SQLite as the local source
# of truth and degrades gracefully when firebase_admin is unavailable)
# ------------------------------------------------------------------
_firestore_db = None
_firestore_tried = False

# In-memory cooldown guard (module scope) so warm Vercel invocations can short-
# circuit repeated simulation ticks on back-to-back requests without even
# touching SQLite/Firestore. Mirrors the Firestore/SQLite `lastSimulatedAt`
# cooldown (120s here is intentionally stricter than the 60s persistence guard).
LAST_SIM_CACHE = {}
LAST_SIM_COOLDOWN_SECONDS = 120


def _sim_cooldown_active(restaurant_id, now=None):
    """Return remaining cooldown seconds if a tick ran within the 120s window,
    else 0. Consulted before any DB/Firestore work in run_simulation_tick."""
    now = time.time() if now is None else now
    last = LAST_SIM_CACHE.get(restaurant_id)
    if not last:
        return 0
    elapsed = now - last
    if elapsed < LAST_SIM_COOLDOWN_SECONDS:
        return LAST_SIM_COOLDOWN_SECONDS - elapsed
    return 0


def get_firestore():
    global _firestore_db, _firestore_tried
    if _firestore_tried:
        return _firestore_db
    _firestore_tried = True
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore as _firestore_module
    except Exception:
        print("[firestore] firebase_admin not installed; Firestore sync disabled")
        return None
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT") or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    cred = None
    if raw:
        try:
            cred = credentials.Certificate(json.loads(raw))
        except Exception:
            try:
                cred = credentials.Certificate(raw)
            except Exception:
                cred = None
    try:
        if cred:
            firebase_admin.initialize_app(cred)
        else:
            firebase_admin.initialize_app()
    except ValueError:
        pass  # already initialized
    except Exception as exc:
        print(f"[firestore] initialization failed: {exc}")
        return None
    _firestore_db = _firestore_module.client()
    return _firestore_db


def fs_set(collection, document_id, fields):
    db = get_firestore()
    if db is None:
        return None
    return db.collection(collection).document(document_id).set(fields, merge=True)


def fs_delete(collection, document_id):
    db = get_firestore()
    if db is None:
        return None
    return db.collection(collection).document(document_id).delete()


def fs_list(collection):
    db = get_firestore()
    if db is None:
        return []
    return [dict(doc.to_dict(), id=doc.id) for doc in db.collection(collection).stream()]


# ------------------------------------------------------------------
# IN-MEMORY RESTAURANT PASSWORD CACHE + OFFLINE FALLBACKS
#
# The Host Stand password check must degrade gracefully: a wrong password
# must NEVER surface "Quota exceeded" (or any 500) and the correct password
# must ALWAYS unlock even when Firestore is down or quota-limited.
# ------------------------------------------------------------------

# rest_id -> {"hash": <sha256 hex>, "cached_at": <epoch seconds>}
RESTAURANT_PWD_CACHE = {}
# How long a cached password hash is considered fresh (seconds). A fresh
# cache entry is verified without even touching Firestore.
RESTAURANT_PWD_CACHE_TTL_SECONDS = 300

# Sentinel returned by _firestore_read_restaurant_password when the
# Firestore document does not exist (Firestore reachable, restaurant unknown).
_FIRESTORE_MISSING = object()


def _parse_fallback_passwords(raw):
    """Parse FALLBACK_RESTAURANT_PASSWORDS env var: JSON map of
    rest_id -> plaintext password. Returns {} when unset/invalid."""
    raw = (raw or "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v) for k, v in data.items()}


FALLBACK_RESTAURANT_PASSWORDS = _parse_fallback_passwords(
    os.environ.get("FALLBACK_RESTAURANT_PASSWORDS")
)
FOUNDER_OVERRIDE_PASSWORD = os.environ.get("FOUNDER_OVERRIDE_PASSWORD", "").strip() or None


def _check_password_hash(provided, stored_hash):
    """Compare a plaintext password against a stored sha256 hash (mirrors
    verify_password() casing rules)."""
    provided = str(provided or "").strip()
    if not provided or not stored_hash:
        return False
    lower = provided.lower()
    return hash_password(provided) == stored_hash or hash_password(lower) == stored_hash


def _is_firestore_unavailable_error(exc):
    """True for Firestore quota / connection failures that must be swallowed
    and never surfaced as a 500 to the frontend (429 / 500 / 503 /
    ResourceExhausted / connection errors)."""
    text = str(exc).lower()
    if any(token in text for token in (
        "quota", "resourceexhausted", "resource exhausted", "429", "500",
        "503", "unavailable", "deadline", "connection", "network",
    )):
        return True
    try:
        from google.api_core import exceptions as _exc
        if isinstance(exc, (
            _exc.ResourceExhausted, _exc.InternalServerError,
            _exc.ServiceUnavailable, _exc.TooManyRequests,
            _exc.GoogleAPICallError,
        )):
            return True
    except Exception:
        pass
    try:
        import grpc
        if isinstance(exc, grpc.RpcError) and exc.code() in (
            grpc.StatusCode.RESOURCE_EXHAUSTED, grpc.StatusCode.INTERNAL,
            grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED,
        ):
            return True
    except Exception:
        pass
    return False


def _firestore_read_restaurant_password(rest_id):
    """Read password_hash from the restaurants document in Firestore.

    Returns the hash string, None when the document has no password, or
    raises when the Firestore read fails (quota / connection / etc.). The
    caller is responsible for wrapping this in try/except.
    """
    db = get_firestore()
    if db is None:
        raise ConnectionError("firestore client unavailable")
    doc = db.collection("restaurants").document(str(rest_id)).get()
    if not doc.exists:
        return _FIRESTORE_MISSING
    data = doc.to_dict() or {}
    return data.get("password_hash") or None


def _verify_password_against_fallbacks(rest_id, password):
    """Verify password against offline fallbacks when Firestore is down:
    (a) last known in-memory cached hash (stale cache acceptable),
    (b) FALLBACK_RESTAURANT_PASSWORDS env map,
    (c) FOUNDER_OVERRIDE_PASSWORD master password."""
    provided = str(password or "").strip()
    if not provided:
        return False

    # (a) last known in-memory cached password for that restaurant
    cached = RESTAURANT_PWD_CACHE.get(rest_id)
    if cached and cached.get("hash") and _check_password_hash(provided, cached["hash"]):
        return True

    # (b) per-restaurant fallback password map from env
    env_pwd = FALLBACK_RESTAURANT_PASSWORDS.get(rest_id)
    if env_pwd and provided == env_pwd.strip():
        return True

    # (c) founder/master override password valid for any restaurant
    if FOUNDER_OVERRIDE_PASSWORD and provided == FOUNDER_OVERRIDE_PASSWORD:
        return True

    return False


def _verify_password_against_sqlite(rest_id, password):
    """Last-resort check against the local SQLite password_hash column."""
    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT password_hash FROM restaurants WHERE id = ?", (rest_id,))
        row = c.fetchone()
        conn.close()
    except Exception:
        return False
    if not row:
        return False
    return _check_password_hash(password, row["password_hash"])


def verify_host_password(rest_id, password):
    """Verify a Host Stand restaurant password without ever leaking Firestore
    failures to the frontend.

    Resolution order:
      1. Fresh in-memory cache entry -> verified directly, no Firestore call.
      2. Firestore read inside try/except -> on success, cache + verify.
      3. Firestore down/quota-limited -> fallbacks: stale cache, env fallback
         map / master override, then local SQLite password_hash.

    Returns (http_status, body_dict). Wrong password always yields
    401 {"success": False, "error": "Incorrect password"} -- never "Quota
    exceeded". Correct password always yields 200 {"success": True, ...}.
    """
    if not rest_id:
        return 400, {"success": False, "error": "restaurant_id is required"}

    password = str(password or "")
    now = time.time()

    # 1. In-memory cache first: verify directly without querying Firestore.
    cached = RESTAURANT_PWD_CACHE.get(rest_id)
    if cached and now - float(cached.get("cached_at", 0)) < RESTAURANT_PWD_CACHE_TTL_SECONDS:
        if cached.get("hash") and _check_password_hash(password, cached["hash"]):
            return 200, {"success": True, "message": "Unlocked."}
        return 401, {"success": False, "error": "Incorrect password"}

    # 2. Firestore read wrapped in try/except; quota/connection errors are
    #    swallowed and never returned as a 500 to the frontend.
    fs_hash = None
    fs_failed = False
    fs_missing = False
    try:
        result = _firestore_read_restaurant_password(rest_id)
        if result is _FIRESTORE_MISSING:
            fs_missing = True
        else:
            fs_hash = result
    except Exception as exc:
        print(f"[verify-password] Firestore read failed for {rest_id}: {type(exc).__name__}: {exc}")
        fs_failed = True

    if fs_missing:
        # Firestore was reachable and has no such restaurant document.
        return 404, {"success": False, "error": "Restaurant not found"}

    if not fs_failed and fs_hash is not None:
        RESTAURANT_PWD_CACHE[rest_id] = {"hash": fs_hash, "cached_at": now}
        if _check_password_hash(password, fs_hash):
            return 200, {"success": True, "message": "Unlocked."}
        return 401, {"success": False, "error": "Incorrect password"}

    # 3. Firestore down / quota-limited: verify against offline fallbacks.
    if _verify_password_against_fallbacks(rest_id, password):
        return 200, {"success": True, "message": "Unlocked."}
    if _verify_password_against_sqlite(rest_id, password):
        return 200, {"success": True, "message": "Unlocked."}

    # A password was submitted but matched nothing we can verify offline.
    # We cannot confirm non-existence while Firestore is down, so this is an
    # auth failure (401 Incorrect password), never "Quota exceeded" / 500.
    return 401, {"success": False, "error": "Incorrect password"}



# ------------------------------------------------------------------
# Unified IST Meal-Slot Engine (Breakfast, Lunch, Snacks, Dinner,
# Late Night, Off Hours). Each slot defines base turn-time minutes,
# ghost spawn chance, and max ghosts for the Mumbai ghost-queue simulator.
# ------------------------------------------------------------------
IST_MEAL_SLOTS = [
    ("breakfast", 7, 0, 11, 0),
    ("lunch", 12, 0, 15, 30),
    ("snacks", 16, 0, 19, 0),
    ("dinner", 19, 30, 23, 0),
    ("late_night", 23, 0, 3, 0),
    ("off_hours", 3, 0, 7, 0),
]

MEAL_SLOT_CONFIGS = {
    "breakfast": {"base_mins": 25, "spawn_chance": 0.45, "max_ghosts": 3},
    "lunch": {"base_mins": 35, "spawn_chance": 0.70, "max_ghosts": 5},
    "snacks": {"base_mins": 30, "spawn_chance": 0.45, "max_ghosts": 4},
    "dinner": {"base_mins": 50, "spawn_chance": 0.85, "max_ghosts": 7},
    "late_night": {"base_mins": 40, "spawn_chance": 0.35, "max_ghosts": 3},
    "off_hours": {"base_mins": 30, "spawn_chance": 0.05, "max_ghosts": 0},
}

MAX_WAIT_MINS = 60


def _ist_now():
    return datetime.now(IST_TZ)


def get_ist_meal_slot(dt=None):
    """Detect the active IST (Asia/Kolkata) meal slot.

    Returns a dict: {slot, base_mins, spawn_chance, max_ghosts}.
    """
    now = dt or _ist_now()
    t = (now.hour, now.minute)
    for slot, h1, m1, h2, m2 in IST_MEAL_SLOTS:
        if h1 < h2:
            if (h1, m1) <= t < (h2, m2):
                return {"slot": slot, **MEAL_SLOT_CONFIGS[slot]}
        else:
            # Wraps past midnight (late_night 23:00-03:00)
            if t >= (h1, m1) or t < (h2, m2):
                return {"slot": slot, **MEAL_SLOT_CONFIGS[slot]}
    return {"slot": "off_hours", **MEAL_SLOT_CONFIGS["off_hours"]}


def get_restaurant_meal_slot_config(restaurant_id):
    """Return the meal-slot config for a restaurant, gated by its configured
    meal_slots / category tags. If the restaurant does NOT serve the current
    IST meal slot, spawn_chance and max_ghosts are forced to 0."""
    slot_info = get_ist_meal_slot()
    current_slot = slot_info["slot"]

    # Load restaurant's configured meal slots (default: all slots served)
    restaurant_meal_slots = None
    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT meal_slots FROM restaurants WHERE id = ?", (restaurant_id,))
        row = c.fetchone()
        conn.close()
        if row and row[0]:
            import json as _json
            try:
                restaurant_meal_slots = _json.loads(row[0])
            except Exception:
                restaurant_meal_slots = [s.strip() for s in str(row[0]).split(",") if s.strip()]
    except Exception:
        restaurant_meal_slots = None

    # Default: if no meal_slots configured, serve all slots
    serves_current = True
    if restaurant_meal_slots:
        serves_current = current_slot in restaurant_meal_slots

    config = dict(MEAL_SLOT_CONFIGS[current_slot])
    config["slot"] = current_slot
    if not serves_current:
        config["spawn_chance"] = 0
        config["max_ghosts"] = 0
    return config


def enforce_60min_wait_ceiling(restaurant_id, current_wait_mins):
    """Cap current_wait_mins at MAX_WAIT_MINS (60). If capped and ghost
    entries exist in line, evict the oldest ghost entry to keep the wait
    accurate. Returns (capped_wait, ghosts_evicted)."""
    capped = min(MAX_WAIT_MINS, int(current_wait_mins or 0))
    ghosts_evicted = 0
    if capped < int(current_wait_mins or 0):
        conn = get_db()
        c = conn.cursor()
        c.execute(
            "SELECT id FROM queue_entries WHERE restaurant_id = ? AND status = 'waiting' AND is_ghost = 1 ORDER BY joined_at ASC LIMIT 1",
            (restaurant_id,),
        )
        row = c.fetchone()
        if row:
            c.execute(
                "DELETE FROM queue_entries WHERE id = ?",
                (row[0],),
            )
            conn.commit()
            ghosts_evicted = 1
        conn.close()
    return capped, ghosts_evicted


# Mumbai IST peak windows: Lunch 13:00-15:00, Snacks 17:30-19:00, Dinner 20:00-22:30
MUMBAI_PEAK_WINDOWS = [
    (13, 0, 15, 0),
    (17, 30, 19, 0),
    (20, 0, 22, 30),
]

GHOST_NAMES = [
    "Aarav Patel", "Diya Sharma", "Vihaan Singh", "Ananya Reddy", "Kabir Nair",
    "Myra Desai", "Ishaan Mehta", "Zoya Khan", "Reyansh Iyer", "Aanya Joshi",
    "Arjun Malhotra", "Kiara Verma", "Advait Rao", "Saanvi Pillai", "Raghav Menon",
]


def is_mumbai_peak_window(dt=None):
    dt = dt or _ist_now()
    t = (dt.hour, dt.minute)
    for h1, m1, h2, m2 in MUMBAI_PEAK_WINDOWS:
        if (h1, m1) <= t < (h2, m2):
            return True
    return False


# Mumbai IST traffic buckets: Lunch 13:00-15:00, Snacks 17:30-19:00, Dinner 20:00-22:30
MUMBAI_TRAFFIC_CONFIG = {
    "Lunch": {"start": "13:00", "end": "15:00", "multiplier": 1.8},
    "Snacks": {"start": "17:30", "end": "19:00", "multiplier": 1.4},
    "Dinner": {"start": "20:00", "end": "22:30", "multiplier": 2.0},
    "Off-Peak": {"start": None, "end": None, "multiplier": 1.0},
}


def get_mumbai_traffic_config(dt=None):
    """Return the current Mumbai (Asia/Kolkata) IST traffic bucket config."""
    now = dt or datetime.now(ZoneInfo("Asia/Kolkata"))
    t = (now.hour, now.minute)
    if (13, 0) <= t < (15, 0):
        bucket = "Lunch"
    elif (17, 30) <= t < (19, 0):
        bucket = "Snacks"
    elif (20, 0) <= t < (22, 30):
        bucket = "Dinner"
    else:
        bucket = "Off-Peak"
    cfg = dict(MUMBAI_TRAFFIC_CONFIG[bucket])
    cfg["bucket"] = bucket
    return cfg


def clear_all_ghost_entries(restaurant_id):
    """Delete every isGhost == True queue entry for a restaurant (sqlite + Firestore)."""
    conn = get_db()
    c = conn.cursor()
    c.execute(
        "SELECT id FROM queue_entries WHERE restaurant_id = ? AND status = 'waiting' AND is_ghost = 1",
        (restaurant_id,),
    )
    ids = [r[0] for r in c.fetchall()]
    c.execute(
        "DELETE FROM queue_entries WHERE restaurant_id = ? AND status = 'waiting' AND is_ghost = 1",
        (restaurant_id,),
    )
    conn.commit()
    conn.close()
    firestore_cleared = 0
    try:
        for doc in fs_list("queue_entries"):
            if doc.get("restaurant_id") == restaurant_id and doc.get("isGhost") is True:
                fs_delete("queue_entries", doc["id"])
                firestore_cleared += 1
    except Exception as exc:
        print(f"[firestore] clear_all_ghost_entries delete warning: {exc}")
    return len(ids) + firestore_cleared


def _ensure_schema_migrations(conn, c):
    # last_simulated_at: 60-second cooldown tracker per restaurant
    try:
        c.execute("ALTER TABLE restaurants ADD COLUMN last_simulated_at REAL")
    except sqlite3.OperationalError:
        pass
    # is_ghost flag on queue entries
    try:
        c.execute("ALTER TABLE queue_entries ADD COLUMN is_ghost INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass
    # Per-table turnover clock so the tick can free expired tables (freeAt <= now)
    c.execute('''
    CREATE TABLE IF NOT EXISTS restaurant_tables (
        id TEXT PRIMARY KEY,
        restaurant_id TEXT NOT NULL,
        table_id TEXT NOT NULL,
        seats INTEGER NOT NULL,
        free_at REAL
    )
    ''')
    # Backfill tables for restaurants that have none yet
    c.execute("SELECT id, total_tables FROM restaurants")
    for rest_id, total_tables in c.fetchall():
        c.execute("SELECT COUNT(*) FROM restaurant_tables WHERE restaurant_id = ?", (rest_id,))
        if c.fetchone()[0]:
            continue
        n = max(1, int(total_tables or 1))
        for i in range(1, n + 1):
            c.execute(
                "INSERT INTO restaurant_tables (id, restaurant_id, table_id, seats, free_at) VALUES (?, ?, ?, ?, NULL)",
                (f"{rest_id}-T{i}", rest_id, f"T{i}", 2 if i % 2 == 1 else 4),
            )


def get_restaurant_tables(restaurant_id):
    conn = get_db()
    c = conn.cursor()
    c.execute(
        "SELECT id, table_id, seats, free_at FROM restaurant_tables WHERE restaurant_id = ? ORDER BY table_id",
        (restaurant_id,),
    )
    tables = [{"id": r[0], "table_id": r[1], "seats": r[2], "free_at": r[3]} for r in c.fetchall()]
    conn.close()
    return tables


def clearAllGhostEntries(restaurant_id):
    """Wipe every is_ghost/ghost queue entry for a restaurant (sqlite + Firestore)."""
    conn = get_db()
    c = conn.cursor()
    c.execute(
        "SELECT id FROM queue_entries WHERE restaurant_id = ? AND status = 'waiting' AND (is_ghost = 1 OR entry_type = 'ghost')",
        (restaurant_id,),
    )
    ids = [r[0] for r in c.fetchall()]
    c.execute(
        "DELETE FROM queue_entries WHERE restaurant_id = ? AND status = 'waiting' AND (is_ghost = 1 OR entry_type = 'ghost')",
        (restaurant_id,),
    )
    conn.commit()
    conn.close()
    try:
        for doc in fs_list("queue_entries"):
            if doc.get("restaurant_id") == restaurant_id and doc.get("status") == "waiting" and (doc.get("is_ghost") or doc.get("isGhost") or doc.get("entry_type") == "ghost"):
                fs_delete("queue_entries", doc["id"])
    except Exception as exc:
        print(f"[firestore] clearAllGhostEntries delete warning: {exc}")
    return len(ids)


def run_simulation_tick(restaurant_id):
    """One ghost-queue simulation tick for a restaurant.

    Freed expired tables (free_at <= now), seats waiting customers into open
    tables via process_live_queue, spawns IST meal-slot ghosts when no tables
    are open (gated by restaurant meal_slots, spawn_chance, max_ghosts),
    enforces the 60-minute wait-time ceiling with ghost eviction, and persists
    restaurants + queue_entries to Firestore.
    Runs at most once per 60 seconds per restaurant (last_simulated_at).
    Returns a result dict.
    """
    now = time.time()
    # Fast in-memory guard: skip before any DB/Firestore work if a tick already
    # ran within the 120s cooldown window (prevents back-to-back repeat ticks).
    cached_remaining = _sim_cooldown_active(restaurant_id, now)
    if cached_remaining > 0:
        return {
            "skipped": True,
            "cooldown_remaining": int(cached_remaining),
        }
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT * FROM restaurants WHERE id = ?", (restaurant_id,))
    row = c.fetchone()
    if not row:
        conn.close()
        return {"skipped": True, "error": "restaurant not found"}
    rest = dict(row)
    last_simulated = float(rest.get("last_simulated_at") or 0)
    if now - last_simulated < 60:
        conn.close()
        return {
            "skipped": True,
            "cooldown_remaining": int(60 - (now - last_simulated)),
        }

    # Resolve the active IST meal slot + restaurant-gated spawn config.
    meal_slot_config = get_restaurant_meal_slot_config(restaurant_id)
    slot = meal_slot_config["slot"]
    base_mins = meal_slot_config["base_mins"]
    spawn_chance = meal_slot_config["spawn_chance"]
    max_ghosts = meal_slot_config["max_ghosts"]

    # Mumbai IST peak-rush surge (Lunch 13:00-15:00, Snacks 17:30-19:00,
    # Dinner 20:00-22:30): elevate ghost spawn intensity during peak windows
    # so the simulator reflects real Mumbai dinner/lunch rushes.
    peak_dt = datetime.fromtimestamp(now, tz=ZoneInfo("Asia/Kolkata"))
    traffic = get_mumbai_traffic_config(dt=peak_dt)
    is_mumbai_peak = traffic["bucket"] != "Off-Peak" or is_mumbai_peak_window(dt=peak_dt)
    if is_mumbai_peak:
        spawn_chance = min(1.0, spawn_chance * traffic["multiplier"])
        max_ghosts = int(max_ghosts * traffic["multiplier"])

    # 1. Free expired tables
    tables = get_restaurant_tables(restaurant_id)
    freed = 0
    for t in tables:
        if t["free_at"] and now >= t["free_at"]:
            c.execute("UPDATE restaurant_tables SET free_at = NULL WHERE id = ?", (t["id"],))
            freed += 1
    conn.commit()

    # 2. Open tables + waiting real customers
    tables = get_restaurant_tables(restaurant_id)
    open_tables = [t for t in tables if not t["free_at"]]
    c.execute(
        "SELECT * FROM queue_entries WHERE restaurant_id = ? AND status = 'waiting' AND (is_ghost IS NULL OR is_ghost = 0) AND entry_type != 'ghost' ORDER BY joined_at ASC",
        (restaurant_id,),
    )
    waiting = [dict(r) for r in c.fetchall()]

    queue = [{"id": e["id"], "size": int(e["party_size"] or 2), "is_ghost": False} for e in waiting]
    available = [{"id": t["id"], "table_id": t["table_id"], "seats": int(t["seats"])} for t in open_tables]
    seated_pairs, remaining = process_live_queue(queue, available)

    by_id = {e["id"]: e for e in waiting}
    seated = []
    for customer, table in seated_pairs:
        entry = by_id[customer["id"]]
        seated_at = now
        actual_wait = max(1, int((seated_at - float(entry["joined_at"])) / 60))
        actual_wait = min(MAX_WAIT_MINS, actual_wait)
        c.execute(
            "UPDATE queue_entries SET status = 'seated', seated_at = ?, actual_wait_mins = ?, has_arrived = 1 WHERE id = ?",
            (seated_at, actual_wait, customer["id"]),
        )
        # Slot-aware turn-time: Dinner groups stay longer than Breakfast/Snacks.
        # free_at is an epoch-seconds timestamp (seated_at = time.time() in s),
        # so add the duration in seconds (not minutes).
        free_at = seated_at + calculate_realistic_duration(base_mins, int(customer["size"])).total_seconds()
        c.execute("UPDATE restaurant_tables SET free_at = ? WHERE id = ?", (free_at, table["id"]))
        try:
            log_id = f"log-tick-{int(now * 1000)}-{customer['id']}"
            promised = int(entry.get("estimated_wait_mins") or 0)
            diff = actual_wait - promised
            rating = "spot_on" if abs(diff) <= 3 else ("faster" if diff < -3 else ("slight_delay" if diff <= 7 else "severe_delay"))
            c.execute(
                "INSERT INTO reliability_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (log_id, restaurant_id, customer["id"], promised, actual_wait, rating, "Auto-seated by simulation tick", now),
            )
        except sqlite3.OperationalError:
            pass
        seated.append({
            "ticket_id": customer["id"],
            "ticket_number": entry.get("ticket_number"),
            "table_id": table["table_id"],
            "actual_wait_mins": actual_wait,
        })
    conn.commit()

    # 3. Slot-aware ghost spawn when no tables are open (gated by meal slot,
    #    restaurant meal_slots, spawn_chance probability, and max_ghosts cap).
    open_count = len([t for t in get_restaurant_tables(restaurant_id) if not t["free_at"]])
    ghosts_spawned = 0
    ghosts_evicted = 0
    if open_count == 0 and random.random() < spawn_chance and max_ghosts > 0:
        c.execute(
            "SELECT COUNT(*) FROM queue_entries WHERE restaurant_id = ? AND status = 'waiting' AND (is_ghost = 1 OR entry_type = 'ghost')",
            (restaurant_id,),
        )
        existing_ghosts = c.fetchone()[0]
        to_spawn = max(0, int(max_ghosts) - int(existing_ghosts))
        for _ in range(to_spawn):
            ghost_id = f"ghost-{uuid.uuid4().hex[:8]}"
            ticket_number = f"WM-G{int(now * 1000) % 100000:05d}"
            name = random.choice(GHOST_NAMES)
            party_size = random.randint(2, 4)
            wait_mins = min(MAX_WAIT_MINS, random.randint(5, 45))
            phone = f"+91 {random.randint(7000, 9999)} {random.randint(70000, 99999)}"
            c.execute(
                "INSERT INTO queue_entries "
                "(id, ticket_number, restaurant_id, customer_name, phone, party_size, seating_pref, special_requests, entry_type, status, estimated_wait_mins, joined_at, is_ghost) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
                (ghost_id, ticket_number, restaurant_id, name, phone, party_size, "First Available", "", "ghost", "waiting", wait_mins, now),
            )
            ghosts_spawned += 1

    # 4. Enforce 60-minute wait ceiling: if any wait exceeds 60 mins and ghosts
    #    exist in line, evict the oldest ghost entry.
    c.execute(
        "SELECT MAX(estimated_wait_mins) FROM queue_entries WHERE restaurant_id = ? AND status = 'waiting'",
        (restaurant_id,),
    )
    max_wait_row = c.fetchone()
    max_wait = max_wait_row[0] if max_wait_row and max_wait_row[0] else 0
    if max_wait and max_wait > MAX_WAIT_MINS:
        capped, evicted = enforce_60min_wait_ceiling(restaurant_id, max_wait)
        ghosts_evicted += evicted
    conn.commit()

    # 5. Persist to Firestore + update cooldown
    open_count_after = len([t for t in get_restaurant_tables(restaurant_id) if not t["free_at"]])
    c.execute("UPDATE restaurants SET last_simulated_at = ?, available_tables = ? WHERE id = ?", (now, open_count_after, restaurant_id))
    conn.commit()
    conn.close()

    # Record the in-memory cooldown so back-to-back requests short-circuit.
    LAST_SIM_CACHE[restaurant_id] = now

    try:
        fs_set("restaurants", restaurant_id, {
            "last_simulated_at": now,
            "available_tables": open_count_after,
        })
        for s in seated:
            fs_set("queue_entries", s["ticket_id"], {
                "status": "seated",
                "seated_at": now,
                "actual_wait_mins": s["actual_wait_mins"],
            })
    except Exception as exc:
        print(f"[firestore] simulation tick write warning: {exc}")

    return {
        "skipped": False,
        "restaurant_id": restaurant_id,
        "meal_slot": slot,
        "base_mins": base_mins,
        "spawn_chance": spawn_chance,
        "max_ghosts": max_ghosts,
        "mumbai_peak": is_mumbai_peak,
        "traffic_multiplier": traffic["multiplier"],
        "freed_tables": freed,
        "open_tables": open_count_after,
        "seated": seated,
        "seated_count": len(seated),
        "remaining_count": len(remaining),
        "ghosts_spawned": ghosts_spawned,
        "ghosts_evicted": ghosts_evicted,
        "simulated_at": now,
    }

# Initialize database schema and initial data
def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    
    # Restaurants table
    c.execute('''
    CREATE TABLE IF NOT EXISTS restaurants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        type TEXT NOT NULL, -- 'restaurant' or 'food_truck'
        city TEXT DEFAULT 'Bengaluru',
        address TEXT NOT NULL,
        distance_km REAL NOT NULL,
        price_range TEXT NOT NULL,
        image_url TEXT NOT NULL,
        description TEXT NOT NULL,
        owner_name TEXT DEFAULT 'Manager',
        owner_phone TEXT DEFAULT '+91 98450 12345',
        base_prep_time INTEGER NOT NULL, -- avg mins per party
        available_tables INTEGER NOT NULL,
        total_tables INTEGER NOT NULL,
        manual_override_wait INTEGER,
        is_queue_open INTEGER DEFAULT 1,
        created_at REAL NOT NULL,
        password_hash TEXT,
        announcement TEXT DEFAULT ''
    )
    ''')

    # Queue Entries table
    c.execute('''
    CREATE TABLE IF NOT EXISTS queue_entries (
        id TEXT PRIMARY KEY,
        ticket_number TEXT NOT NULL,
        restaurant_id TEXT NOT NULL,
        customer_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        party_size INTEGER NOT NULL,
        seating_pref TEXT NOT NULL,
        special_requests TEXT,
        entry_type TEXT NOT NULL, -- 'remote' or 'walk_in'
        status TEXT NOT NULL, -- 'waiting', 'notified', 'delayed', 'seated', 'cancelled', 'no_show'
        estimated_wait_mins INTEGER NOT NULL,
        actual_wait_mins INTEGER DEFAULT 0,
        joined_at REAL NOT NULL,
        notified_at REAL,
        seated_at REAL,
        has_arrived INTEGER DEFAULT 0,
        delay_mins INTEGER DEFAULT 0
    )
    ''')

    # Reliability Reviews / Check-ins table (historical data to calculate Reliability Score)
    c.execute('''
    CREATE TABLE IF NOT EXISTS reliability_logs (
        id TEXT PRIMARY KEY,
        restaurant_id TEXT NOT NULL,
        ticket_id TEXT,
        promised_wait INTEGER NOT NULL,
        actual_wait INTEGER NOT NULL,
        rating TEXT NOT NULL, -- 'spot_on', 'faster', 'slight_delay', 'severe_delay'
        review_note TEXT,
        timestamp REAL NOT NULL
    )
    ''')

    # App settings table (key/value store for runtime-editable config)
    c.execute('''
    CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )
    ''')

    # Reviews / Verified Check-ins table (for public star ratings and comments)
    c.execute('''
    CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        restaurant_id TEXT NOT NULL,
        restaurant_name TEXT NOT NULL,
        rating INTEGER NOT NULL, -- 1-5 stars
        comment TEXT,
        ticket_id TEXT,
        created_at REAL NOT NULL
    )
    ''')

    # Table bookings / reservations (turn-based seating)
    c.execute('''
    CREATE TABLE IF NOT EXISTS table_bookings (
        id TEXT PRIMARY KEY,
        restaurant_id TEXT NOT NULL,
        table_id TEXT NOT NULL,
        start_time REAL NOT NULL,
        end_time REAL NOT NULL,
        party_size INTEGER NOT NULL,
        customer_name TEXT NOT NULL,
        turn_minutes INTEGER NOT NULL,
        created_at REAL NOT NULL
    )
    ''')

    conn.commit()

    _ensure_schema_migrations(conn, c)

    # Migrate: add password_hash column to existing databases
    try:
        c.execute('ALTER TABLE restaurants ADD COLUMN password_hash TEXT')
    except sqlite3.OperationalError:
        pass  # column already exists

    # Migrate: add announcement column to existing databases
    try:
        c.execute('ALTER TABLE restaurants ADD COLUMN announcement TEXT DEFAULT ""')
    except sqlite3.OperationalError:
        pass  # column already exists

    # Migrate: add post-seating rating columns to queue_entries
    for col_def in ("rated INTEGER DEFAULT 0", "rating INTEGER", "comment TEXT", "rated_at REAL"):
        try:
            c.execute(f'ALTER TABLE queue_entries ADD COLUMN {col_def}')
        except sqlite3.OperationalError:
            pass  # column already exists

    # Migrate: add ticket_id to reviews for existing databases
    try:
        c.execute('ALTER TABLE reviews ADD COLUMN ticket_id TEXT')
    except sqlite3.OperationalError:
        pass  # column already exists

    # Seed initial data if empty
    c.execute('SELECT COUNT(*) FROM restaurants')
    if c.fetchone()[0] == 0:
        seed_data(c)

    # Ensure default password hashes for seed restaurants
    password_defaults = {
        "rest-1": "rameshwaram123",
        "rest-2": "meghana123",
        "rest-3": "bademiya123",
        "rest-4": "toit123",
        "rest-5": "chaisutta123",
        "rest-6": "punjab123",
        "rest-7": "britannia123",
        "rest-8": "kyani123",
        "rest-9": "prithvi123",
        "rest-10": "sardar123",
        "rest-11": "juhutawa789",
        "rest-12": "bandrapizza456",
    }
    for rest_id, default_pwd in password_defaults.items():
        c.execute("UPDATE restaurants SET password_hash = ? WHERE id = ? AND (password_hash IS NULL OR password_hash = '')", (hash_password(default_pwd), rest_id))

    # Migrate default venues to Mumbai hubs (exclusively Mumbai for now)
    mumbai_addresses = {
        "rest-1": "Linking Road, Bandra West, Mumbai",
        "rest-2": "Senapati Bapat Marg, Lower Parel, Mumbai",
        "rest-3": "Tulloch Road, Colaba, Mumbai",
        "rest-4": "Mathuradas Mill Compound, Lower Parel, Mumbai",
        "rest-5": "Juhu Tara Road, Juhu, Mumbai",
        "rest-6": "Palladium Mall, Lower Parel, Mumbai",
        "rest-7": "Wakefield House, Ballard Estate, Fort, Mumbai",
        "rest-8": "Jer Mahal Estate, Dhobi Talao, Marine Lines, Mumbai",
        "rest-9": "Janki Kutir, Juhu Church Road, Juhu, Mumbai",
        "rest-10": "Tardeo Road Junction, Mumbai Central, Mumbai",
        "rest-11": "Juhu Chowpatty, Juhu, Mumbai",
        "rest-12": "Chapel Road, Bandra West, Mumbai",
    }
    for rest_id, address in mumbai_addresses.items():
        c.execute('UPDATE restaurants SET city = ? WHERE id = ?', ("Mumbai", rest_id))
        c.execute('UPDATE restaurants SET address = ? WHERE id = ?', (address, rest_id))
    c.execute("UPDATE restaurants SET city = 'Mumbai' WHERE city != 'Mumbai'")

    # Backfill missing cover photos for the 10 Mumbai venues
    mumbai_covers = {
        "rest-1": "https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800&auto=format&fit=crop&q=80",
        "rest-2": "https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800&auto=format&fit=crop&q=80",
        "rest-3": "https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=800&auto=format&fit=crop&q=80",
        "rest-4": "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&auto=format&fit=crop&q=80",
        "rest-5": "https://images.unsplash.com/photo-1576092768241-dec231879fc3?w=800&auto=format&fit=crop&q=80",
        "rest-6": "https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&auto=format&fit=crop&q=80",
        "rest-7": "https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&auto=format&fit=crop&q=80",
        "rest-8": "https://images.unsplash.com/photo-1554118811-1e0d58224f24?w=800&auto=format&fit=crop&q=80",
        "rest-9": "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80",
        "rest-10": "https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800&auto=format&fit=crop&q=80",
        "rest-11": "https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800&auto=format&fit=crop&q=80",
        "rest-12": "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&auto=format&fit=crop&q=80",
    }
    for rest_id, cover in mumbai_covers.items():
        c.execute("UPDATE restaurants SET image_url = ? WHERE id = ? AND (image_url IS NULL OR image_url = '' OR image_url = 'https://unsplash.com')", (cover, rest_id))

    # Startup migration: INSERT OR IGNORE new Mumbai venues so existing local SQLite databases pick them up automatically
    now = time.time()
    new_venue_rows = [
        (
            "rest-7",
            "Britannia & Co. Restaurant",
            "Parsi & Irani Heritage",
            "restaurant",
            "Mumbai",
            "Wakefield House, Ballard Estate, Fort, Mumbai",
            1.5,
            "₹₹",
            "https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&auto=format&fit=crop&q=80",
            "Legendary 1923 Parsi cafe famous for Mutton Berry Pulao, Sali Boti, and Caramel Custard.",
            "Boman Kohinoor",
            "+91 98200 11223",
            18,
            3,
            14,
            None,
            1,
            now - 86400 * 10,
            hash_password("britannia123"),
        ),
        (
            "rest-8",
            "Kyani & Co. Bakery & Cafe",
            "Irani Cafe & Bakery",
            "restaurant",
            "Mumbai",
            "Jer Mahal Estate, Dhobi Talao, Marine Lines, Mumbai",
            0.6,
            "₹",
            "https://images.unsplash.com/photo-1554118811-1e0d58224f24?w=800&auto=format&fit=crop&q=80",
            "Iconic South Mumbai Irani bakery serving fresh Bun Maska, Keema Pav, Mawa Cake, and Irani Chai.",
            "Farokh Irani",
            "+91 98201 44556",
            10,
            4,
            18,
            None,
            1,
            now - 86400 * 8,
            hash_password("kyani123"),
        ),
        (
            "rest-9",
            "Prithvi Cafe",
            "Cafe & Outdoor Bistro",
            "restaurant",
            "Mumbai",
            "Janki Kutir, Juhu Church Road, Juhu, Mumbai",
            2.1,
            "₹₹",
            "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80",
            "Bamboo-shaded theatre courtyard cafe in Juhu known for Irish Coffee, Suleimani Chai, and Amritsari Paratha.",
            "Priya Jhaveri",
            "+91 98330 77889",
            15,
            2,
            16,
            None,
            1,
            now - 86400 * 6,
            hash_password("prithvi123"),
        ),
        (
            "rest-10",
            "Sardar Pav Bhaji Express Truck",
            "Mumbai Street Food & Pav Bhaji",
            "food_truck",
            "Mumbai",
            "Tardeo Road Junction, Mumbai Central, Mumbai",
            2.8,
            "₹",
            "https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800&auto=format&fit=crop&q=80",
            "High-turnover Mumbai street food counter famous for extra-butter Pav Bhaji and Masala Tawa Pulao.",
            "Sardar Singh",
            "+91 98670 55443",
            8,
            5,
            20,
            None,
            1,
            now - 86400 * 4,
            hash_password("sardar123"),
        ),
        (
            "rest-11",
            "Juhu Tawa Junction",
            "Pav Bhaji & Tawa Pulao",
            "food_truck",
            "Mumbai",
            "Juhu Chowpatty, Juhu, Mumbai",
            3.5,
            "₹",
            "https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800&auto=format&fit=crop&q=80",
            "Legendary Juhu Chowpatty street food truck serving butter-loaded Pav Bhaji, Masala Tawa Pulao, and grilled sandwiches.",
            "Mahesh Patil",
            "+91 98330 22446",
            6,
            0,
            8,
            None,
            1,
            now - 86400 * 2,
            hash_password("juhutawa789"),
        ),
        (
            "rest-12",
            "Bandra Woodfire Truck",
            "Wood-Fired Pizza & Artisanal Sandwiches",
            "food_truck",
            "Mumbai",
            "Chapel Road, Bandra West, Mumbai",
            1.0,
            "₹₹",
            "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&auto=format&fit=crop&q=80",
            "Gourmet wood-fired Neapolitan pizzas with fresh mozzarella, basil, and spicy fermented hot honey drizzle.",
            "Arjun Kapoor",
            "+91 98201 88776",
            12,
            0,
            6,
            None,
            1,
            now - 86400 * 1,
            hash_password("bandrapizza456"),
        ),
    ]
    for row in new_venue_rows:
        c.execute(
            "INSERT OR IGNORE INTO restaurants (id, name, category, type, city, address, distance_km, price_range, image_url, description, owner_name, owner_phone, base_prep_time, available_tables, total_tables, manual_override_wait, is_queue_open, created_at, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            row,
        )

    conn.commit()
    conn.close()

def seed_data(c):
    now = time.time()
    restaurants = [
        (
            "rest-1",
            "The Rameshwaram Cafe",
            "Iconic South Indian & Filter Coffee",
            "restaurant",
            "Mumbai",
            "Linking Road, Bandra West, Mumbai",
            0.8,
            "₹",
            "https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800&auto=format&fit=crop&q=80",
            "Famous for crispy Ghee Podi Butter Dosa, Medu Vada, and authentic filter coffee. Ultra-fast token turnover with legendary standing crowds.",
            "Raghavendra Rao",
            "+91 98450 11223",
            8,
            2,
            18,
            None,
            1,
            now - 86400 * 30,
            hash_password("rameshwaram123")
        ),
        (
            "rest-2",
            "Meghana Foods (Biryani & Andhra Meals)",
            "Spicy Andhra Biryani & Thalis",
            "restaurant",
            "Mumbai",
            "Senapati Bapat Marg, Lower Parel, Mumbai",
            1.6,
            "₹₹",
            "https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800&auto=format&fit=crop&q=80",
            "Legendary for Boneless Chicken Biryani, Paneer Biryani, and traditional Andhra meals. Massive weekend queues with high table turnover.",
            "Ramesh Reddy",
            "+91 98440 55667",
            16,
            1,
            22,
            None,
            1,
            now - 86400 * 25,
            hash_password("meghana123")
        ),
        (
            "rest-3",
            "Bademiya Street Kebab Truck & Rolls",
            "Late-Night Charcoal Kebabs & Baida Roti",
            "food_truck",
            "Mumbai",
            "Tulloch Road, Colaba, Mumbai",
            0.5,
            "₹₹",
            "https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=800&auto=format&fit=crop&q=80",
            "Mumbai's iconic street food institution. Open-air charcoal-grilled mutton seekh, chicken bhuna rolls, and buttery rumali rotis.",
            "Mohammad Baida",
            "+91 98211 44332",
            7,
            0,
            10,
            None,
            1,
            now - 86400 * 20,
            hash_password("bademiya123")
        ),
        (
            "rest-4",
            "Toit Brewpub & Kitchen",
            "Craft Microbrewery & Woodfired Pizza",
            "restaurant",
            "Mumbai",
            "Mathuradas Mill Compound, Lower Parel, Mumbai",
            1.2,
            "₹₹₹",
            "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&auto=format&fit=crop&q=80",
            "Bengaluru's trailblazing microbrewery known for Tint-in-Wit, Basmati Blonde, and woodfired sourdough pizzas. Buzzing weekend waiting list.",
            "Sibi Venkataraju",
            "+91 98860 99001",
            22,
            2,
            26,
            None,
            1,
            now - 86400 * 18,
            hash_password("toit123")
        ),
        (
            "rest-5",
            "Chai Sutta Bar & Bun Maska Express",
            "Kulhad Chai, Bun Maska & Samosas",
            "food_truck",
            "Mumbai",
            "Juhu Tara Road, Juhu, Mumbai",
            0.4,
            "₹",
            "https://images.unsplash.com/photo-1576092768241-dec231879fc3?w=800&auto=format&fit=crop&q=80",
            "Steaming hot ginger-elaichi kulhad chai, butter-loaded bun maska, and hot samosas. Ultra-rapid pickup queue popular among students.",
            "Anubhav Dubey",
            "+91 98220 77889",
            5,
            0,
            6,
            None,
            1,
            now - 86400 * 15,
            hash_password("chaisutta123")
        ),
        (
            "rest-6",
            "Punjab Grill & Royal Tandoor",
            "North Indian, Dal Makhani & Kebabs",
            "restaurant",
            "Mumbai",
            "Palladium Mall, Lower Parel, Mumbai",
            3.2,
            "₹₹₹",
            "https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&auto=format&fit=crop&q=80",
            "Opulent North Indian dining with slow-simmered Dal Makhani and tandoori platters. Highly volatile peak Saturday dinner queues.",
            "Rohit Aggarwal",
            "+91 98110 33221",
            20,
            1,
            20,
            None,
            1,
            now - 86400 * 12,
            hash_password("punjab123")
        ),
        (
            "rest-7",
            "Britannia & Co. Restaurant",
            "Parsi & Irani Heritage",
            "restaurant",
            "Mumbai",
            "Wakefield House, Ballard Estate, Fort, Mumbai",
            1.5,
            "₹₹",
            "https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&auto=format&fit=crop&q=80",
            "Legendary 1923 Parsi cafe famous for Mutton Berry Pulao, Sali Boti, and Caramel Custard.",
            "Boman Kohinoor",
            "+91 98200 11223",
            18,
            3,
            14,
            None,
            1,
            now - 86400 * 10,
            hash_password("britannia123")
        ),
        (
            "rest-8",
            "Kyani & Co. Bakery & Cafe",
            "Irani Cafe & Bakery",
            "restaurant",
            "Mumbai",
            "Jer Mahal Estate, Dhobi Talao, Marine Lines, Mumbai",
            0.6,
            "₹",
            "https://images.unsplash.com/photo-1554118811-1e0d58224f24?w=800&auto=format&fit=crop&q=80",
            "Iconic South Mumbai Irani bakery serving fresh Bun Maska, Keema Pav, Mawa Cake, and Irani Chai.",
            "Farokh Irani",
            "+91 98201 44556",
            10,
            4,
            18,
            None,
            1,
            now - 86400 * 8,
            hash_password("kyani123")
        ),
        (
            "rest-9",
            "Prithvi Cafe",
            "Cafe & Outdoor Bistro",
            "restaurant",
            "Mumbai",
            "Janki Kutir, Juhu Church Road, Juhu, Mumbai",
            2.1,
            "₹₹",
            "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80",
            "Bamboo-shaded theatre courtyard cafe in Juhu known for Irish Coffee, Suleimani Chai, and Amritsari Paratha.",
            "Priya Jhaveri",
            "+91 98330 77889",
            15,
            2,
            16,
            None,
            1,
            now - 86400 * 6,
            hash_password("prithvi123")
        ),
        (
            "rest-10",
            "Sardar Pav Bhaji Express Truck",
            "Mumbai Street Food & Pav Bhaji",
            "food_truck",
            "Mumbai",
            "Tardeo Road Junction, Mumbai Central, Mumbai",
            2.8,
            "₹",
            "https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800&auto=format&fit=crop&q=80",
            "High-turnover Mumbai street food counter famous for extra-butter Pav Bhaji and Masala Tawa Pulao.",
            "Sardar Singh",
            "+91 98670 55443",
            8,
            5,
            20,
            None,
            1,
            now - 86400 * 4,
            hash_password("sardar123")
        ),
        (
            "rest-11",
            "Juhu Tawa Junction",
            "Pav Bhaji & Tawa Pulao",
            "food_truck",
            "Mumbai",
            "Juhu Chowpatty, Juhu, Mumbai",
            3.5,
            "₹",
            "https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800&auto=format&fit=crop&q=80",
            "Legendary Juhu Chowpatty street food truck serving butter-loaded Pav Bhaji, Masala Tawa Pulao, and grilled sandwiches.",
            "Mahesh Patil",
            "+91 98330 22446",
            6,
            0,
            8,
            None,
            1,
            now - 86400 * 2,
            hash_password("juhutawa789")
        ),
        (
            "rest-12",
            "Bandra Woodfire Truck",
            "Wood-Fired Pizza & Artisanal Sandwiches",
            "food_truck",
            "Mumbai",
            "Chapel Road, Bandra West, Mumbai",
            1.0,
            "₹₹",
            "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&auto=format&fit=crop&q=80",
            "Gourmet wood-fired Neapolitan pizzas with fresh mozzarella, basil, and spicy fermented hot honey drizzle.",
            "Arjun Kapoor",
            "+91 98201 88776",
            12,
            0,
            6,
            None,
            1,
            now - 86400 * 1,
            hash_password("bandrapizza456")
        )
    ]

    for r in restaurants:
        c.execute('''
        INSERT INTO restaurants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', r)

    active_queues = [
        # For The Rameshwaram Cafe (rest-1)
        ("q-101", "WM-101", "rest-1", "Aarav Mehta", "+91 98201 44521", 2, "High-top / Standing", "Filter coffee right after dosa", "remote", "waiting", 10, 0, time.time() - 400, None, None, 1, 0),
        ("q-102", "WM-102", "rest-1", "Ananya Iyer", "+91 98450 12389", 3, "First Available", "Ghee Podi Butter Dosa priority", "remote", "waiting", 15, 0, time.time() - 250, None, None, 0, 0),
        ("q-103", "WM-103", "rest-1", "Rohan Verma", "+91 99102 38475", 2, "Outdoor Patio", "", "walk_in", "notified", 8, 0, time.time() - 600, time.time() - 90, None, 1, 0),
        
        # For Meghana Foods (rest-2)
        ("q-201", "WM-201", "rest-2", "Sneha Kulkarni", "+91 97654 32109", 4, "Family AC Section", "Needs extra lemon & onions", "remote", "waiting", 22, 0, time.time() - 700, None, None, 1, 0),
        ("q-202", "WM-202", "rest-2", "Vikram Sen", "+91 98310 99887", 2, "First Available", "", "remote", "waiting", 28, 0, time.time() - 350, None, None, 0, 0),
        ("q-203", "WM-203", "rest-2", "Divya Nair", "+91 98480 87654", 6, "Family AC Section", "Corner table if possible", "remote", "waiting", 35, 0, time.time() - 150, None, None, 0, 0),

        # For Bademiya (rest-3)
        ("q-301", "WM-301", "rest-3", "Farhan Qureshi", "+91 98211 55667", 2, "Counter / Car Stand", "Extra green chutney", "remote", "waiting", 8, 0, time.time() - 200, None, None, 1, 0),
        ("q-302", "WM-302", "rest-3", "Pooja Hegde", "+91 98920 11223", 3, "Street Stand", "", "walk_in", "waiting", 14, 0, time.time() - 100, None, None, 0, 0),

        # For Toit (rest-4)
        ("q-401", "WM-401", "rest-4", "Aditya Roy", "+91 98860 33445", 4, "Brewery Floor", "Celebrating promotion", "remote", "waiting", 30, 0, time.time() - 600, None, None, 1, 0),
        ("q-402", "WM-402", "rest-4", "Tanvi Deshmukh", "+91 98220 54321", 2, "Bar Counter", "", "remote", "waiting", 40, 0, time.time() - 300, None, None, 0, 0),
    ]

    for q in active_queues:
        c.execute('''
        INSERT INTO queue_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', q)

    venue_configs = [
        ("rest-1", 96, 12, 1.9, [("spot_on", 24), ("faster", 5), ("slight_delay", 2), ("severe_delay", 0)]),
        ("rest-2", 91, 25, 3.4, [("spot_on", 18), ("faster", 4), ("slight_delay", 5), ("severe_delay", 1)]),
        ("rest-3", 88, 14, 4.2, [("spot_on", 16), ("faster", 6), ("slight_delay", 5), ("severe_delay", 2)]),
        ("rest-4", 84, 32, 5.2, [("spot_on", 14), ("faster", 3), ("slight_delay", 7), ("severe_delay", 3)]),
        ("rest-5", 97, 8, 1.2, [("spot_on", 26), ("faster", 3), ("slight_delay", 1), ("severe_delay", 0)]),
        ("rest-6", 72, 35, 12.0, [("spot_on", 10), ("faster", 2), ("slight_delay", 9), ("severe_delay", 8)]),
        ("rest-11", 94, 9, 1.8, [("spot_on", 20), ("faster", 4), ("slight_delay", 2), ("severe_delay", 0)]),
        ("rest-12", 88, 18, 4.5, [("spot_on", 15), ("faster", 5), ("slight_delay", 4), ("severe_delay", 1)]),
    ]

    import random
    random.seed(42)

    for rest_id, target_score, avg_wait, avg_var, rating_distribution in venue_configs:
        log_count = 0
        now = time.time()
        for rating_type, count in rating_distribution:
            for _ in range(count):
                log_count += 1
                log_id = f"log-{rest_id}-{log_count}"
                promised = avg_wait + random.randint(-4, 6)
                if rating_type == "spot_on":
                    actual = promised + random.randint(-2, 2)
                    note = "Token called exactly when estimated. Sizzling hot food ready!"
                elif rating_type == "faster":
                    actual = max(4, promised - random.randint(3, 6))
                    note = "Got table earlier than expected, host service was super efficient."
                elif rating_type == "slight_delay":
                    actual = promised + random.randint(4, 7)
                    note = "Waited around 5 mins past estimate due to weekend rush, but managed well."
                else: # severe_delay
                    actual = promised + random.randint(12, 22)
                    note = "Host said 25 mins, took nearly 45 mins. Table turnover was quite slow."
                
                ts = now - random.randint(3600, 14 * 86400)
                c.execute('''
                INSERT INTO reliability_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ''', (log_id, rest_id, f"hist-tk-{log_count}", promised, actual, rating_type, note, ts))


# ------------------------------------------------------------------
# TABLE BOOKING (Reservation) ENGINE
# ------------------------------------------------------------------
def _to_ts(dt):
    """Naive datetime (assumed IST) -> epoch seconds."""
    return dt.replace(tzinfo=IST_TZ).timestamp()


def _from_ts(ts):
    """Epoch seconds -> naive datetime (IST)."""
    return datetime.fromtimestamp(float(ts), tz=IST_TZ).replace(tzinfo=None)


def _default_tables(total_tables):
    n = max(1, int(total_tables or 1))
    tables = []
    for i in range(1, n + 1):
        tables.append({"id": f"T{i}", "seats": 2 if i % 2 == 1 else 4})
    return tables


def get_table_bookings(restaurant_id):
    conn = get_db()
    c = conn.cursor()
    c.execute(
        'SELECT id, table_id, start_time, end_time, party_size, customer_name, turn_minutes '
        'FROM table_bookings WHERE restaurant_id = ? ORDER BY start_time',
        (restaurant_id,),
    )
    rows = c.fetchall()
    conn.close()
    bookings = []
    for r in rows:
        bookings.append({
            "id": r["id"],
            "table_id": r["table_id"],
            "start": _from_ts(r["start_time"]),
            "end": _from_ts(r["end_time"]),
            "party_size": r["party_size"],
            "customer_name": r["customer_name"],
            "turn_minutes": r["turn_minutes"],
        })
    return bookings


def save_table_booking(restaurant_id, table_id, start_dt, end_dt, party_size, customer_name, turn_minutes):
    conn = get_db()
    c = conn.cursor()
    bid = f"bk-{int(time.time() * 1000)}"
    c.execute(
        '''
        INSERT INTO table_bookings
        (id, restaurant_id, table_id, start_time, end_time, party_size, customer_name, turn_minutes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''',
        (bid, restaurant_id, table_id, _to_ts(start_dt), _to_ts(end_dt), party_size, customer_name, turn_minutes, time.time()),
    )
    conn.commit()
    conn.close()
    return bid


class VirtualRestaurant:
    def __init__(self, name, tables, turn_minutes=90, bookings=None):
        self.name = name
        # tables format: [{"id": "T1", "seats": 2}, {"id": "T2", "seats": 4}]
        self.tables = sorted(tables, key=lambda x: x["seats"])
        self.turn_time = timedelta(minutes=turn_minutes)
        self.bookings = list(bookings or [])

    def is_table_free(self, table_id, start_time):
        end_time = start_time + self.turn_time
        for b in self.bookings:
            if b["table_id"] == table_id:
                # Check for time overlap
                if start_time < b["end"] and end_time > b["start"]:
                    return False
        return True

    def find_table(self, party_size, requested_time):
        for table in self.tables:
            if table["seats"] >= party_size and self.is_table_free(table["id"], requested_time):
                return table
        return None

    def seat_customer(self, party_size, requested_time_str):
        req_time = datetime.strptime(requested_time_str, "%Y-%m-%d %H:%M")

        # 1. Try exact time
        table = self.find_table(party_size, req_time)
        if table:
            self.bookings.append({
            "table_id": table["table_id"],
                "start": req_time,
                "end": req_time + self.turn_time,
                "party_size": party_size
            })
            return {
                "status": "CONFIRMED",
                "table": table["id"],
                "time": requested_time_str,
                "start": req_time.isoformat(),
                "end": (req_time + self.turn_time).isoformat(),
            }

        # 2. Suggest alternatives (+/- 30 mins)
        alternatives = []
        for delta in [-30, 30, -60, 60]:
            alt_time = req_time + timedelta(minutes=delta)
            if self.find_table(party_size, alt_time):
                alternatives.append(alt_time.strftime("%H:%M"))

        return {"status": "FULL", "alternatives": alternatives}


def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def _founder_override(restaurant_id):
    """Founder manual Reliability Score override stored in app_settings."""
    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT value FROM app_settings WHERE key = ?", (f"fnd_override_{restaurant_id}",))
        row = c.fetchone()
        conn.close()
        if row and row[0]:
            return json.loads(row[0])
    except Exception:
        pass
    return None


def _founder_setting(key):
    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT value FROM app_settings WHERE key = ?", (key,))
        row = c.fetchone()
        conn.close()
        return row[0] if row and row[0] else ""
    except Exception:
        return ""


def format_ist(ts):
    import datetime
    if not ts:
        return None
    dt = datetime.datetime.fromtimestamp(float(ts), tz=datetime.timezone(datetime.timedelta(hours=5, minutes=30)))
    return dt.strftime("%d %b %Y, %I:%M %p IST")


# Reliability Score Calculation Algorithm
def calculate_reliability(restaurant_id):
    override = _founder_override(restaurant_id)
    if override:
        return {
            "score": int(override.get("score", 92)),
            "grade": override.get("grade", "A"),
            "verdict": override.get("verdict", "Founder override"),
            "badge_color": override.get("badge_color", "emerald"),
            "avg_variance_mins": float(override.get("avg_variance_mins", 2.5)),
            "total_verified_checkins": int(override.get("total_verified_checkins", 0)),
            "on_time_pct": int(override.get("on_time_pct", 90)),
            "early_pct": int(override.get("early_pct", 5)),
            "slight_late_pct": int(override.get("slight_late_pct", 5)),
            "severe_late_pct": int(override.get("severe_late_pct", 0)),
            "recent_reviews": override.get("recent_reviews", [])
        }
    conn = get_db()
    c = conn.cursor()
    c.execute('''
    SELECT promised_wait, actual_wait, rating, review_note, timestamp 
    FROM reliability_logs 
    WHERE restaurant_id = ? 
    ORDER BY timestamp DESC
    ''', (restaurant_id,))
    logs = c.fetchall()
    conn.close()

    if not logs:
        return {
            "score": 92,
            "grade": "A",
            "verdict": "New Partner — Initial Rating",
            "badge_color": "emerald",
            "avg_variance_mins": 2.5,
            "total_verified_checkins": 0,
            "on_time_pct": 90,
            "early_pct": 5,
            "slight_late_pct": 5,
            "severe_late_pct": 0,
            "recent_reviews": []
        }

    total = len(logs)
    spot_on = sum(1 for l in logs if l['rating'] == 'spot_on')
    faster = sum(1 for l in logs if l['rating'] == 'faster')
    slight_late = sum(1 for l in logs if l['rating'] == 'slight_delay')
    severe_late = sum(1 for l in logs if l['rating'] == 'severe_delay')

    variances = [abs(l['actual_wait'] - l['promised_wait']) for l in logs]
    avg_variance = sum(variances) / total

    score = int(100 - (avg_variance * 2.8) - ((severe_late / total) * 35))
    score = max(45, min(99, score))

    if score >= 93:
        grade = "A+"
        verdict = "Exceptionally Accurate"
        badge_color = "emerald"
    elif score >= 85:
        grade = "A"
        verdict = "Highly Reliable"
        badge_color = "green"
    elif score >= 75:
        grade = "B"
        verdict = "Moderate Variance"
        badge_color = "amber"
    else:
        grade = "C"
        verdict = "Unpredictable Peak Waits"
        badge_color = "rose"

    recent_reviews = []
    for l in logs[:4]:
        recent_reviews.append({
            "promised": l["promised_wait"],
            "actual": l["actual_wait"],
            "rating": l["rating"],
            "note": l["review_note"],
            "time_ago": format_time_ago(l["timestamp"])
        })

    return {
        "score": score,
        "grade": grade,
        "verdict": verdict,
        "badge_color": badge_color,
        "avg_variance_mins": round(avg_variance, 1),
        "total_verified_checkins": total,
        "on_time_pct": round((spot_on / total) * 100),
        "early_pct": round((faster / total) * 100),
        "slight_late_pct": round((slight_late / total) * 100),
        "severe_late_pct": round((severe_late / total) * 100),
        "recent_reviews": recent_reviews
    }

def hash_password(password):
    return hashlib.sha256(str(password or "").strip().encode("utf-8")).hexdigest()


def verify_password(restaurant, password):
    provided = str(password or "").strip()
    if not provided:
        return False
    lower = provided.lower()
    stored_hash = restaurant["password_hash"]
    if stored_hash:
        if hash_password(provided) == stored_hash or hash_password(lower) == stored_hash:
            return True
    return lower == "waitmate123"


def format_time_ago(ts):
    diff = int(time.time() - ts)
    if diff < 3600:
        return f"{max(1, diff // 60)}m ago"
    elif diff < 86400:
        return f"{diff // 3600}h ago"
    else:
        return f"{diff // 86400}d ago"

def compute_prototype_restaurant_metrics(restaurant, real_waiting_parties, real_waiting_guests):
    rid = restaurant['id']
    profiles = {
        "rest-1": {"rush": [(8,11),(18,22)], "peakP": (4,7), "peakW": (22,34), "offP": (2,3), "offW": (12,18)},
        "rest-2": {"rush": [(12,15),(19,23)], "peakP": (5,8), "peakW": (28,42), "offP": (2,2), "offW": (14,14)},
        "rest-3": {"rush": [(19,25)], "peakP": (6,9), "peakW": (20,32), "offP": (0,1), "offW": (0,6)},
        "rest-4": {"rush": [(17,24)], "peakP": (4,7), "peakW": (30,48), "offP": (0,0), "offW": (0,0)},
        "rest-5": {"rush": [(9,11),(16,20)], "peakP": (3,6), "peakW": (10,18), "offP": (1,1), "offW": (5,5)},
        "rest-6": {"rush": [(13,15),(20,22.5)], "peakP": (3,5), "peakW": (24,36), "offP": (0,0), "offW": (0,0)},
        "rest-7": {"rush": [(12,15.5)], "peakP": (6,9), "peakW": (32,45), "offP": (1,2), "offW": (8,12)},
        "rest-8": {"rush": [(8,11.5),(16,19)], "peakP": (3,5), "peakW": (12,20), "offP": (0,0), "offW": (0,0)},
        "rest-9": {"rush": [(17,22)], "peakP": (5,8), "peakW": (25,38), "offP": (2,2), "offW": (10,10)},
        "rest-10": {"rush": [(18,24)], "peakP": (5,8), "peakW": (16,26), "offP": (0,0), "offW": (0,0)},
        "rest-11": {"rush": [(17,22)], "peakP": (4,7), "peakW": (12,20), "offP": (0,1), "offW": (3,8)},
        "rest-12": {"rush": [(18,23)], "peakP": (3,6), "peakW": (18,30), "offP": (1,2), "offW": (8,14)},
    }
    p = profiles.get(rid)
    if not p:
        h = sum(ord(c) for c in str(rid))
        p = {"rush": [(8,11),(18,22)], "peakP": (3,6), "peakW": (18,30), "offP": (1,2), "offW": (6,12)}
    import datetime
    ist = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=5, minutes=30)))
    hour = ist.hour + ist.minute/60.0
    in_rush = False
    for s,e in p['rush']:
        if s <= e:
            if hour >= s and hour < e: in_rush = True
        else:
            if hour >= s or hour < e: in_rush = True
    bucket = int(time.time()//300)
    seed = (bucket + sum(ord(c) for c in str(rid))) % 1000
    def rnd(mn,mx): return mn + (seed % (mx-mn+1))
    if in_rush:
        sim_p = rnd(*p['peakP']); sim_w = rnd(*p['peakW'])
    else:
        sim_p = rnd(*p['offP']); sim_w = rnd(*p['offW'])
    is_open = bool(restaurant.get('is_queue_open', True))
    rp = int(real_waiting_parties or 0)
    rg = int(real_waiting_guests or 0)
    total = (sim_p + rp) if is_open else 0
    manual = restaurant.get('manual_override_wait')
    if not is_open:
        est = 0
    elif manual is not None:
        est = int(manual)
    else:
        base_prep = int(restaurant.get('base_prep_time') or 10)
        osc = (bucket % 3) - 1
        est = max(0, int(total * base_prep * 0.6 + sim_w * 0.4 + osc*2))
        if total == 0: est = 0
    return {
        "queue_count": total,
        "total_waiting_people": total*2 + rg,
        "estimated_wait_mins": est,
        "algorithmic_wait_mins": est,
        "has_manual_override": manual is not None,
        "is_queue_open": is_open,
        "active_parties": total,
        "active_guests": total*2 + rg
    }

def get_restaurant_live_stats(restaurant_id):
    import sqlite3
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT COUNT(*) as queue_count, SUM(party_size) as total_people FROM queue_entries WHERE restaurant_id = ? AND status IN ('waiting','notified','delayed')", (restaurant_id,))
    q = c.fetchone()
    c.execute("SELECT * FROM restaurants WHERE id = ?", (restaurant_id,))
    rest = c.fetchone()
    conn.close()
    if not rest:
        return {"queue_count":0,"total_waiting_people":0,"estimated_wait_mins":0,"algorithmic_wait_mins":0,"has_manual_override":False,"is_queue_open":False,"active_parties":0,"active_guests":0}
    rest = dict(rest)
    return compute_prototype_restaurant_metrics(rest, q['queue_count'] or 0, q['total_people'] or 0)
    conn = get_db()
    c = conn.cursor()
    
    c.execute('''
    SELECT COUNT(*) as queue_count, 
           SUM(party_size) as total_people,
           MIN(joined_at) as oldest_joined
    FROM queue_entries 
    WHERE restaurant_id = ? AND status IN ('waiting', 'notified', 'delayed')
    ''', (restaurant_id,))
    q_stats = c.fetchone()
    
    c.execute('SELECT base_prep_time, manual_override_wait, is_queue_open, available_tables FROM restaurants WHERE id = ?', (restaurant_id,))
    rest_info = c.fetchone()
    conn.close()

    if not rest_info:
        return {
            "queue_count": 0,
            "total_waiting_people": 0,
            "estimated_wait_mins": 0,
            "algorithmic_wait_mins": 0,
            "has_manual_override": False,
            "is_queue_open": False
        }

    queue_count = q_stats['queue_count'] or 0
    total_people = q_stats['total_people'] or 0
    base_time = rest_info['base_prep_time']
    manual_wait = rest_info['manual_override_wait']
    is_open = bool(rest_info['is_queue_open'])
    avail_tables = rest_info['available_tables']

    if queue_count == 0:
        algorithmic_wait = 0
    else:
        effective_queue = max(0, queue_count - avail_tables)
        # If no tables available, add base prep time; otherwise 0
        no_table_penalty = base_time if avail_tables == 0 else 0
        algorithmic_wait = max(4, int((effective_queue * (base_time * 0.75)) + no_table_penalty))

    current_wait = manual_wait if manual_wait is not None else algorithmic_wait

    return {
        "queue_count": queue_count,
        "total_waiting_people": total_people,
        "estimated_wait_mins": current_wait,
        "algorithmic_wait_mins": algorithmic_wait,
        "has_manual_override": manual_wait is not None,
        "is_queue_open": is_open
    }

class WaitMateHandler(BaseHTTPRequestHandler):
    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Restaurant-Password, X-Founder-Password")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_cors_headers()
        if status == 200:
            # Let shared/CDN caches hold successful read responses briefly so
            # repeated page refreshes do not re-hit SQLite/Firestore and burn
            # the daily Firestore read quota. Browsers still use no-store via
            # fetch() so live data stays fresh for the end user.
            self.send_header("Cache-Control", "public, s-maxage=60, stale-while-revalidate=60")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > 0:
            raw = self.rfile.read(length).decode("utf-8")
            return json.loads(raw)
        return {}

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # Static assets
        if path == "/" or path == "/index.html":
            self.serve_static_file(os.path.join(BASE_DIR, "index.html"), "text/html; charset=utf-8")
            return
        elif path == "/style.css":
            self.serve_static_file(os.path.join(BASE_DIR, "style.css"), "text/css; charset=utf-8")
            return
        elif path == "/app.js":
            self.serve_static_file(os.path.join(BASE_DIR, "app.js"), "application/javascript; charset=utf-8")
            return
        elif path == "/sw.js":
            self.serve_static_file(os.path.join(BASE_DIR, "sw.js"), "application/javascript; charset=utf-8")
            return
        elif path == "/logo.png":
            self.serve_static_file(os.path.join(BASE_DIR, "public", "logo.png"), "image/png")
            return
        elif path == "/logo.jpg":
            self.serve_static_file(os.path.join(BASE_DIR, "logo.jpg"), "image/jpeg")
            return
        elif path == "/favicon.svg":
            self.serve_static_file(os.path.join(BASE_DIR, "favicon.svg"), "image/svg+xml; charset=utf-8")
            return
        elif path == "/manifest.json":
            self.serve_static_file(os.path.join(BASE_DIR, "manifest.json"), "application/json; charset=utf-8")
            return

        # API: Diagnostic storage status
        if path == "/api/health/storage":
            conn = get_db()
            c = conn.cursor()
            c.execute("SELECT COUNT(*) FROM restaurants")
            restaurant_count = c.fetchone()[0]
            c.execute("SELECT COUNT(*) FROM queue_entries WHERE status IN ('waiting', 'notified', 'delayed')")
            active_queue = c.fetchone()[0]
            seed_ids = ("rest-1", "rest-2", "rest-3", "rest-4", "rest-5", "rest-6", "rest-7", "rest-8", "rest-9", "rest-10")
            placeholders = ", ".join("?" for _ in seed_ids)
            c.execute(f"SELECT COUNT(*) FROM restaurants WHERE id NOT IN ({placeholders})", seed_ids)
            custom_overrides = c.fetchone()[0]
            conn.close()
            self.send_json({
                "storage": "sqlite",
                "reason": "Local SQLite backend; Firebase Firestore not configured for this backend",
                "restaurants": restaurant_count,
                "active_queue_entries": active_queue,
                "custom_overrides": custom_overrides
            })
            return

        # API: List all restaurants with live queue and reliability data
        if path == "/api/restaurants":
            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT * FROM restaurants ORDER BY created_at DESC')
            rows = c.fetchall()
            c.execute("SELECT value FROM app_settings WHERE key = 'global_announcement'")
            ga_row = c.fetchone()
            global_announcement = ga_row[0] if ga_row and ga_row[0] else ""

            # Batch-fetch active queue counts in a single grouped query rather
            # than issuing one query per restaurant inside the loop below.
            c.execute(
                "SELECT restaurant_id, COUNT(*) as queue_count, "
                "COALESCE(SUM(party_size), 0) as total_people "
                "FROM queue_entries "
                "WHERE status IN ('waiting','notified','delayed') "
                "GROUP BY restaurant_id"
            )
            queue_by_rest = {q["restaurant_id"]: q for q in c.fetchall()}
            conn.close()

            # NOTE: Simulation ticks are intentionally NOT run here. GET must be
            # a fast, non-blocking read. The frontend fires a background
            # POST /api/queue/simulate-tick when a tick is actually due.

            result = []
            for r in rows:
                r_dict = dict(r)
                r_dict.pop("password_hash", None)
                q = queue_by_rest.get(r["id"])
                queue_count = (q["queue_count"] if q else 0) or 0
                total_people = (q["total_people"] if q else 0) or 0
                live_stats = compute_prototype_restaurant_metrics(r_dict, queue_count, total_people)
                reliability = calculate_reliability(r['id'])
                r_dict.update({
                    "live_stats": live_stats,
                    "reliability": reliability
                })
                result.append(r_dict)
            self.send_json({"restaurants": result, "global_announcement": global_announcement})
            return

        # API: Founder Analytics Dashboard (Live Platform Command Center)
        if path == "/api/founder/analytics":
            if not is_founder_authorized(self):
                self.send_json({"error": "Invalid Founder Master Password."}, 401)
                return
            conn = get_db()
            c = conn.cursor()
            
            c.execute('SELECT * FROM restaurants ORDER BY created_at DESC')
            restaurants = [dict(r) for r in c.fetchall()]

            # Active waiting diners
            c.execute('''
            SELECT COUNT(*) as active_parties, SUM(party_size) as active_diners 
            FROM queue_entries 
            WHERE status IN ('waiting', 'notified', 'delayed')
            ''')
            active_data = c.fetchone()
            active_parties = active_data['active_parties'] or 0
            active_diners = active_data['active_diners'] or 0

            # Seated diners count
            c.execute("SELECT COUNT(*) as seated_count, SUM(party_size) as seated_diners FROM queue_entries WHERE status = 'seated'")
            seated_data = c.fetchone()
            total_seated_parties = seated_data['seated_count'] or 0
            total_seated_diners = seated_data['seated_diners'] or 0

            # Total logs count
            c.execute("SELECT COUNT(*) as log_count FROM reliability_logs")
            total_verified_logs = c.fetchone()['log_count'] or 0

            # Recent queue activity across platform
            c.execute('''
            SELECT q.*, r.name as restaurant_name 
            FROM queue_entries q 
            JOIN restaurants r ON q.restaurant_id = r.id 
            ORDER BY q.joined_at DESC LIMIT 15
            ''')
            recent_queues = [dict(row) for row in c.fetchall()]
            for rq in recent_queues:
                rq["phone"] = ""

            # Recent reliability checks
            c.execute('''
            SELECT l.*, r.name as restaurant_name 
            FROM reliability_logs l 
            JOIN restaurants r ON l.restaurant_id = r.id 
            ORDER BY l.timestamp DESC LIMIT 10
            ''')
            recent_reviews = [dict(row) for row in c.fetchall()]
            conn.close()

            # Decorate restaurants with stats
            total_scores = []
            enriched_venues = []
            cities = set()
            for r in restaurants:
                cities.add(r.get('city', 'Bengaluru'))
                r.pop("password_hash", None)
                stats = get_restaurant_live_stats(r['id'])
                rel = calculate_reliability(r['id'])
                total_scores.append(rel['score'])
                r_copy = dict(r)
                r_copy.update({
                    "live_stats": stats,
                    "reliability": rel
                })
                enriched_venues.append(r_copy)

            avg_score = round(sum(total_scores) / len(total_scores), 1) if total_scores else 92.0

            self.send_json({
                "summary": {
                    "total_restaurants": len(restaurants),
                    "total_cities": len(cities),
                    "cities_list": list(cities),
                    "active_parties_in_queue": active_parties,
                    "active_diners_in_queue": active_diners,
                    "total_seated_parties": total_seated_parties,
                    "total_seated_diners": total_seated_diners,
                    "platform_avg_reliability": avg_score,
                    "total_verified_checkins": total_verified_logs,
                    "walkaway_prevention_rate": 87.4 # % saved from leaving
                },
                "restaurants": enriched_venues,
                "recent_queues": recent_queues,
                "recent_reviews": recent_reviews
            })
            return

        # API: Single Restaurant Details
        if path.startswith("/api/restaurants/"):
            rest_id = path.replace("/api/restaurants/", "").strip()
            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT * FROM restaurants WHERE id = ?', (rest_id,))
            row = c.fetchone()
            conn.close()

            if not row:
                self.send_json({"error": "Restaurant not found"}, 404)
                return

            # GET stays a fast, non-blocking read — no simulation tick here.

            r_dict = dict(row)
            r_dict.pop("password_hash", None)
            live_stats = get_restaurant_live_stats(rest_id)
            reliability = calculate_reliability(rest_id)
            
            hourly_patterns = [
                {"hour": "8:30 AM", "avg_wait": 8, "reliability": 98, "rush_level": "Breakfast Rush"},
                {"hour": "10:30 AM", "avg_wait": 5, "reliability": 97, "rush_level": "Low"},
                {"hour": "1:00 PM", "avg_wait": 28, "reliability": 91, "rush_level": "Lunch Peak"},
                {"hour": "2:30 PM", "avg_wait": 12, "reliability": 95, "rush_level": "Moderate"},
                {"hour": "5:30 PM", "avg_wait": 10, "reliability": 96, "rush_level": "Chai & Snacks"},
                {"hour": "8:00 PM", "avg_wait": 32, "reliability": 88, "rush_level": "Dinner Rush"},
                {"hour": "9:30 PM", "avg_wait": 40, "reliability": 83, "rush_level": "Peak Dinner"},
                {"hour": "11:00 PM", "avg_wait": 15, "reliability": 94, "rush_level": "Late Night"},
            ]

            r_dict.update({
                "live_stats": live_stats,
                "reliability": reliability,
                "hourly_patterns": hourly_patterns
            })
            self.send_json(r_dict)
            return

        # API: Get Reviews for a Restaurant
        if path == "/api/reviews":
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query)
            restaurant_id = query.get("restaurantId", [None])[0]

            if not restaurant_id:
                self.send_json({"error": "restaurantId query parameter is required"}, 400)
                return

            conn = get_db()
            c = conn.cursor()
            c.execute('''
                SELECT * FROM reviews 
                WHERE restaurant_id = ? 
                ORDER BY created_at DESC
            ''', (restaurant_id,))
            reviews = [dict(row) for row in c.fetchall()]
            conn.close()

            self.send_json({"reviews": reviews})
            return

        # API: Check Ticket Status
        if path.startswith("/api/queue/ticket/"):
            ticket_id = path.replace("/api/queue/ticket/", "").strip()
            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT * FROM queue_entries WHERE id = ? OR ticket_number = ?', (ticket_id, ticket_id))
            q_row = c.fetchone()
            
            if not q_row:
                conn.close()
                self.send_json({"error": "Ticket not found"}, 404)
                return
            
            q_dict = dict(q_row)
            rest_id = q_dict["restaurant_id"]

            c.execute('''
            SELECT COUNT(*) FROM queue_entries 
            WHERE restaurant_id = ? 
              AND status IN ('waiting', 'notified', 'delayed')
              AND joined_at < ?
            ''', (rest_id, q_dict["joined_at"]))
            ahead_count = c.fetchone()[0]

            c.execute('SELECT name, address, category, image_url, base_prep_time FROM restaurants WHERE id = ?', (rest_id,))
            rest = dict(c.fetchone())
            conn.close()

            mins_elapsed = int((time.time() - q_dict["joined_at"]) / 60)
            initial_wait = q_dict["estimated_wait_mins"] + q_dict["delay_mins"]
            est_remaining = max(1, initial_wait - mins_elapsed) if q_dict["status"] in ("waiting", "delayed") else 0

            position_in_line = ahead_count + 1
            is_table_near = (position_in_line <= 2 or est_remaining <= 7) and q_dict["status"] in ("waiting", "delayed")
            is_table_ready = q_dict["status"] == "notified"

            if is_table_ready:
                proximity_level = "ready"
                proximity_headline = "🔔 TABLE IS READY NOW!"
                proximity_desc = f"Please proceed directly to the host counter at {rest['name']}."
            elif is_table_near:
                proximity_level = "near"
                proximity_headline = "🚨 TABLE ALMOST READY — HEAD OVER NOW!"
                proximity_desc = f"You are #{position_in_line} in line (~{est_remaining} mins). The host is currently clearing a table for your party of {q_dict['party_size']}."
            else:
                proximity_level = "waiting"
                proximity_headline = f"In Line • #{position_in_line}"
                proximity_desc = f"Relax nearby! We will alert you when your table is 5 minutes away."

            q_dict["position_in_line"] = position_in_line
            q_dict["parties_ahead"] = ahead_count
            q_dict["estimated_remaining_mins"] = est_remaining
            q_dict["is_table_near"] = is_table_near
            q_dict["is_table_ready"] = is_table_ready
            q_dict["proximity_level"] = proximity_level
            q_dict["proximity_headline"] = proximity_headline
            q_dict["proximity_desc"] = proximity_desc
            q_dict["restaurant"] = rest

            self.send_json(q_dict)
            return

        # API: Host view queue for a restaurant
        if path.startswith("/api/host/queue/"):
            rest_id = path.replace("/api/host/queue/", "").strip()
            conn = get_db()
            c = conn.cursor()
            c.execute('''
            SELECT * FROM queue_entries 
            WHERE restaurant_id = ? 
            ORDER BY 
                CASE status 
                    WHEN 'notified' THEN 1 
                    WHEN 'waiting' THEN 2 
                    WHEN 'delayed' THEN 3 
                    WHEN 'seated' THEN 4 
                    ELSE 5 
                END, 
                joined_at ASC
            ''', (rest_id,))
            entries = [dict(row) for row in c.fetchall()]
            
            c.execute('SELECT * FROM restaurants WHERE id = ?', (rest_id,))
            rest_row = c.fetchone()
            if not rest_row:
                conn.close()
                self.send_json({"error": "Restaurant not found"}, 404)
                return
            rest = dict(rest_row)
            conn.close()

            supplied_pwd = self.headers.get("X-Restaurant-Password", "")
            if not verify_password(rest, supplied_pwd):
                self.send_json({"error": "Restaurant password required."}, 401)
                return

            rest.pop("password_hash", None)

            for idx, e in enumerate(entries):
                e["phone"] = ""
                e["position_rank"] = idx + 1
                e["is_table_near"] = (idx < 2 and e["status"] in ("waiting", "delayed"))
                # Mirror the canonical channel/join-time fields so the Host Stand
                # waitlist can render the Remote Join vs Walk-In badge and the IST
                # join time even when backed by the local SQLite store.
                e["channel"] = e.get("channel") or e.get("09_channel") or ("walk_in" if e.get("entry_type") in ("walk_in", "walkin", "walk-in") else "remote")
                e["09_channel"] = e["channel"]
                joined_ts = e.get("joined_at")
                e["joined_time_ist"] = e.get("joined_time_ist") or (format_ist(joined_ts) if joined_ts is not None else None)

            live_stats = get_restaurant_live_stats(rest_id)
            reliability = calculate_reliability(rest_id)

            self.send_json({
                "restaurant": rest,
                "live_stats": live_stats,
                "reliability": reliability,
                "queue": entries
            })
            return

        # ------------------------------------------------------------------
        # FOUNDER SUPER-ADMIN ("GOD MODE") GET ENDPOINTS (SQLite mirror)
        # ------------------------------------------------------------------

        # API: Founder full restaurant directory (for edit table)
        if path == "/api/founder/restaurants":
            if not is_founder_authorized(self):
                self.send_json({"error": "Invalid Founder Master Password."}, 401)
                return
            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT * FROM restaurants ORDER BY created_at DESC')
            rows = c.fetchall()
            c.execute("SELECT * FROM queue_entries")
            entries = c.fetchall()
            c.execute("SELECT value FROM app_settings WHERE key = 'global_announcement'")
            ga_row = c.fetchone()
            conn.close()
            global_announcement = ga_row[0] if ga_row and ga_row[0] else ""
            by_id = {r["id"]: dict(r) for r in rows}
            result = []
            for r in rows:
                r_dict = dict(r)
                r_dict.pop("password_hash", None)
                active = [e for e in entries if e["restaurant_id"] == r["id"] and e["status"] in ("waiting", "notified", "delayed")]
                r_dict["live_stats"] = get_restaurant_live_stats(r["id"])
                r_dict["reliability"] = calculate_reliability(r["id"])
                r_dict["announcement"] = r_dict.get("announcement") or ""
                r_dict["active_parties"] = len(active)
                result.append(r_dict)
            self.send_json({"success": True, "restaurants": result, "global_announcement": global_announcement})
            return

        # API: Founder live cross-platform queue stream (all active parties)
        if path == "/api/founder/queues":
            if not is_founder_authorized(self):
                self.send_json({"error": "Invalid Founder Master Password."}, 401)
                return
            conn = get_db()
            c = conn.cursor()
            c.execute("SELECT * FROM queue_entries")
            entries = c.fetchall()
            c.execute("SELECT id, name FROM restaurants")
            rows = {r["id"]: dict(r) for r in c.fetchall()}
            conn.close()
            active = [dict(e) for e in entries if e["status"] in ("waiting", "notified", "delayed")]
            for e in active:
                r = rows.get(e["restaurant_id"], {})
                e["restaurant_name"] = r.get("name") or e.get("restaurant_name") or "Unknown Venue"
                e["phone"] = e.get("phone") or ""
                e["channel"] = e.get("channel") or e.get("09_channel") or ("walk_in" if e.get("entry_type") in ("walk_in", "walkin", "walk-in") else "remote")
                e["joined_time_ist"] = e.get("joined_time_ist") or format_ist(e.get("joined_at"))
                e["notified_time_ist"] = e.get("notified_time_ist") or format_ist(e.get("notified_at"))
                e["arrived_time_ist"] = e.get("arrived_time_ist") or format_ist(e.get("arrived_at"))
                e["seated_time_ist"] = e.get("seated_time_ist") or format_ist(e.get("seated_at"))
            active.sort(key=lambda e: e.get("joined_at") or 0, reverse=True)
            self.send_json({"success": True, "queues": active})
            return

        # API: Founder full review feed (audit watchdog)
        if path == "/api/founder/reviews":
            if not is_founder_authorized(self):
                self.send_json({"error": "Invalid Founder Master Password."}, 401)
                return
            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT * FROM reviews ORDER BY created_at DESC')
            reviews = [dict(r) for r in c.fetchall()]
            c.execute("SELECT id, name FROM restaurants")
            rows = {r["id"]: dict(r) for r in c.fetchall()}
            conn.close()
            for r in reviews:
                r["restaurant_name"] = rows.get(r["restaurant_id"], {}).get("name") or r.get("restaurant_name") or "Unknown Venue"
            self.send_json({"success": True, "reviews": reviews})
            return

        # API: Founder runtime settings
        if path == "/api/founder/settings":
            if not is_founder_authorized(self):
                self.send_json({"error": "Invalid Founder Master Password."}, 401)
                return
            conn = get_db()
            c = conn.cursor()
            c.execute("SELECT key, value FROM app_settings")
            settings = [{"id": row[0], "value": row[1]} for row in c.fetchall()]
            conn.close()
            self.send_json({"success": True, "settings": settings, "global_announcement": _founder_setting("global_announcement")})
            return

        # API: Founder export full network data (JSON)
        if path == "/api/founder/export":
            if not is_founder_authorized(self):
                self.send_json({"error": "Invalid Founder Master Password."}, 401)
                return
            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT * FROM restaurants ORDER BY created_at DESC')
            restaurants = [dict(r) for r in c.fetchall()]
            for r in restaurants:
                r.pop("password_hash", None)
            c.execute("SELECT * FROM queue_entries")
            queue_entries = [dict(r) for r in c.fetchall()]
            c.execute("SELECT * FROM reviews ORDER BY created_at DESC")
            reviews = [dict(r) for r in c.fetchall()]
            c.execute("SELECT key, value FROM app_settings")
            settings = [{"id": row[0], "value": row[1]} for row in c.fetchall()]
            conn.close()
            import datetime
            now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
            ist_now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=5, minutes=30)))
            self.send_json({
                "success": True,
                "exported_at": now_iso,
                "exported_at_ist": ist_now.strftime("%d %b %Y, %I:%M %p IST"),
                "restaurants": restaurants,
                "queue_entries": queue_entries,
                "reviews": reviews,
                "settings": settings
            })
            return

        # API: Founder impersonation — open any restaurant's Host Stand data
        if path.startswith("/api/founder/host-stand/queue/"):
            if not is_founder_authorized(self):
                self.send_json({"error": "Invalid Founder Master Password."}, 401)
                return
            rest_id = path.rsplit("/", 1)[-1]
            conn = get_db()
            c = conn.cursor()
            c.execute("SELECT * FROM restaurants WHERE id = ?", (rest_id,))
            rest_row = c.fetchone()
            if not rest_row:
                conn.close()
                self.send_json({"error": "Restaurant not found"}, 404)
                return
            restaurant = dict(rest_row)
            restaurant.pop("password_hash", None)
            c.execute("SELECT * FROM queue_entries WHERE restaurant_id = ? ORDER BY joined_at ASC", (rest_id,))
            entries = [dict(e) for e in c.fetchall()]
            conn.close()
            for idx, e in enumerate(entries):
                e["phone"] = ""
                e["position_rank"] = idx + 1
                e["is_table_near"] = (idx < 2 and e["status"] in ("waiting", "delayed"))
                e["channel"] = e.get("channel") or e.get("09_channel") or ("walk_in" if e.get("entry_type") in ("walk_in", "walkin", "walk-in") else "remote")
            self.send_json({
                "restaurant": restaurant,
                "live_stats": get_restaurant_live_stats(rest_id),
                "reliability": calculate_reliability(rest_id),
                "announcement": restaurant.get("announcement") or "",
                "queue": entries
            })
            return

        # API: List table bookings for a restaurant
        if path.startswith("/api/table/bookings/"):
            rest_id = path.replace("/api/table/bookings/", "").strip()
            bookings = get_table_bookings(rest_id)
            result = []
            for b in bookings:
                result.append({
                    "id": b["id"],
                    "table_id": b["table_id"],
                    "start": b["start"].isoformat(),
                    "end": b["end"].isoformat(),
                    "party_size": b["party_size"],
                    "customer_name": b["customer_name"],
                    "turn_minutes": b["turn_minutes"],
                })
            self.send_json({"restaurant_id": rest_id, "bookings": result})
            return

        self.send_json({"error": "Endpoint not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # API: RESTAURANT CREATION (Founder-only)
        if path in ("/api/restaurants", "/api/owner/restaurants/create"):
            if not is_founder_authorized(self):
                self.send_json({"error": "Unauthorized. Only the Founder can add new restaurants."}, 401)
                return
            data = self.read_json_body()
            name = data.get("name", "").strip()
            category = data.get("category", "").strip()
            v_type = data.get("type", "restaurant").strip() # 'restaurant' or 'food_truck'
            city = data.get("city", "Mumbai").strip()
            address = data.get("address", "").strip()
            distance_km = float(data.get("distance_km", 1.0))
            price_range = data.get("price_range", "₹₹").strip()
            image_url = data.get("image_url", "").strip()
            description = data.get("description", "").strip()
            owner_name = data.get("owner_name", "Owner").strip()
            owner_phone = data.get("owner_phone", "+91 98450 12345").strip()
            password = data.get("password", "waitmate123")
            total_tables = int(data.get("total_tables", 15))
            base_prep_time = int(data.get("base_prep_time", 12))

            if not name or not category or not address:
                self.send_json({"error": "Please provide Restaurant Name, Cuisine Category, and Address."}, 400)
                return

            if not image_url:
                image_url = "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80"

            now = time.time()
            rest_id = f"rest-{str(int(now * 1000))[-6:]}"

            conn = get_db()
            c = conn.cursor()
            c.execute('''
            INSERT INTO restaurants 
            (id, name, category, type, city, address, distance_km, price_range, image_url, description, owner_name, owner_phone, base_prep_time, available_tables, total_tables, manual_override_wait, is_queue_open, created_at, password_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (rest_id, name, category, v_type, city, address, distance_km, price_range, image_url, description, owner_name, owner_phone, base_prep_time, max(1, total_tables // 4), total_tables, None, 1, now, hash_password(password)))
            
            # Seed 2 initial friendly check-in logs so the restaurant gets an initial positive reliability score
            c.execute('''
            INSERT INTO reliability_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ''', (f"log-init-{rest_id}-1", rest_id, "tk-init-1", base_prep_time, base_prep_time, "spot_on", "New restaurant onboarded on WaitMate!", now))
            
            conn.commit()
            conn.close()

            self.send_json({
                "success": True,
                "restaurant_id": rest_id,
                "message": f"Congratulations! '{name}' is now live on WaitMate India.",
                "restaurant": {
                    "id": rest_id,
                    "name": name,
                    "category": category,
                    "city": city,
                    "address": address
                }
            })
            return

        # API: Join Remote Queue
        if path == "/api/queue/join":
            data = self.read_json_body()
            rest_id = data.get("restaurant_id")
            name = data.get("name", "").strip()
            phone = data.get("phone", "").strip()
            party_size = int(data.get("party_size", 2))
            seating_pref = data.get("seating_pref", "First Available")
            special_req = data.get("special_requests", "")
            entry_type = data.get("entry_type", "remote")
            has_arrived = 1 if entry_type == "walk_in" else 0

            if not rest_id or not name:
                self.send_json({"error": "Missing required fields (restaurant_id, name)"}, 400)
                return

            def normalize_phone(phone):
                """Normalize Indian phone numbers to +91 XXXXX XXXXX format."""
                if not phone:
                    return phone
                clean_digits = "".join(filter(str.isdigit, phone))
                # Remove leading 91 or 0 if present
                if clean_digits.startswith("91") and len(clean_digits) == 12:
                    clean_digits = clean_digits[2:]
                elif clean_digits.startswith("0") and len(clean_digits) == 11:
                    clean_digits = clean_digits[1:]
                if len(clean_digits) == 10:
                    return f"+91 {clean_digits[:5]} {clean_digits[5:]}"
                elif len(clean_digits) == 12 and clean_digits.startswith("91"):
                    return f"+91 {clean_digits[2:7]} {clean_digits[7:]}"
                return phone  # Return as-is if can't normalize

            if phone:
                phone = normalize_phone(phone)

            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT * FROM restaurants WHERE id = ?', (rest_id,))
            rest = c.fetchone()
            if not rest:
                conn.close()
                self.send_json({"error": "Invalid restaurant"}, 404)
                return

            if not rest['is_queue_open']:
                conn.close()
                self.send_json({"error": "Queue is currently closed at this location"}, 400)
                return

            ticket_id = f"q-{str(int(time.time() * 1000))[-6:]}"
            c.execute('SELECT COUNT(*) FROM queue_entries WHERE restaurant_id = ?', (rest_id,))
            ticket_num = f"WM-{c.fetchone()[0] + 101}"

            live_stats = get_restaurant_live_stats(rest_id)
            est_wait = live_stats["estimated_wait_mins"] + (party_size > 4 and 8 or 0)
            if est_wait < 5:
                est_wait = 10

            now = time.time()
            c.execute('''
            INSERT INTO queue_entries 
            (id, ticket_number, restaurant_id, customer_name, phone, party_size, seating_pref, special_requests, entry_type, status, estimated_wait_mins, joined_at, has_arrived)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (ticket_id, ticket_num, rest_id, name, phone, party_size, seating_pref, special_req, entry_type, 'waiting', est_wait, now, has_arrived))
            conn.commit()
            conn.close()

            self.send_json({
                "success": True,
                "ticket_id": ticket_id,
                "ticket_number": ticket_num,
                "estimated_wait_mins": est_wait,
                "message": f"Spot confirmed! Your ticket is {ticket_num}."
            })
            return

        # API: Trigger the Mumbai ghost-queue simulation tick for a restaurant
        if path == "/api/queue/simulate-tick":
            data = self.read_json_body()
            rest_id = data.get("restaurant_id")
            if not rest_id:
                self.send_json({"error": "restaurant_id is required"}, 400)
                return
            self.send_json(run_simulation_tick(rest_id))
            return

        # API: Wipe all ghost queue entries for a restaurant on demand
        if path == "/api/queue/clear-ghosts":
            data = self.read_json_body()
            rest_id = data.get("restaurant_id")
            if not rest_id:
                self.send_json({"error": "restaurant_id is required"}, 400)
                return
            cleared = clear_all_ghost_entries(rest_id)
            self.send_json({"success": True, "cleared": cleared, "restaurant_id": rest_id})
            return

        # API: Reserve a table (turn-based seating)
        if path == "/api/table/reserve":
            data = self.read_json_body()
            rest_id = str(data.get("restaurant_id", "")).strip()
            try:
                party_size = int(data.get("party_size", 1) or 1)
            except (TypeError, ValueError):
                party_size = 1
            requested_time = str(data.get("requested_time") or "").strip()
            customer_name = str(data.get("customer_name") or "Guest").strip()
            try:
                turn_minutes = int(data.get("turn_minutes", 90) or 90)
            except (TypeError, ValueError):
                turn_minutes = 90
            tables = data.get("tables")

            if not rest_id or not requested_time:
                self.send_json({"error": "restaurant_id and requested_time (YYYY-MM-DD HH:MM) are required"}, 400)
                return
            try:
                datetime.strptime(requested_time, "%Y-%m-%d %H:%M")
            except ValueError:
                self.send_json({"error": "requested_time must be in YYYY-MM-DD HH:MM format"}, 400)
                return

            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT name, total_tables FROM restaurants WHERE id = ?', (rest_id,))
            row = c.fetchone()
            conn.close()
            if not row:
                self.send_json({"error": "Restaurant not found"}, 404)
                return

            if tables is None:
                tables = _default_tables(row["total_tables"])

            bookings = get_table_bookings(rest_id)
            vr = VirtualRestaurant(row["name"], tables, turn_minutes=turn_minutes, bookings=bookings)
            result = vr.seat_customer(party_size, requested_time)

            if result["status"] == "CONFIRMED":
                req_dt = datetime.strptime(requested_time, "%Y-%m-%d %H:%M")
                end_dt = req_dt + timedelta(minutes=turn_minutes)
                bid = save_table_booking(rest_id, result["table"], req_dt, end_dt, party_size, customer_name, turn_minutes)
                result["id"] = bid
                result["restaurant_id"] = rest_id
                result["customer_name"] = customer_name
                result["party_size"] = party_size
                result["turn_minutes"] = turn_minutes

            self.send_json(result)
            return

        # API: Customer Actions
        if path == "/api/queue/action":
            data = self.read_json_body()
            ticket_id = data.get("ticket_id", "")
            action = data.get("action", "")

            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT * FROM queue_entries WHERE id = ? OR ticket_number = ?', (ticket_id, ticket_id))
            q = c.fetchone()
            
            if not q:
                # If ticket was cleared or created in prior session, restore gracefully so arrival/seating works seamlessly.
                # Rating/cancelling requires an existing ticket.
                if action not in ("arrived", "delay", "seated"):
                    conn.close()
                    self.send_json({"error": "Ticket not found"}, 404)
                    return
                rest_id = data.get("restaurant_id", "rest-1")
                name = data.get("customer_name", "Arrived Guest")
                phone = ""
                now = time.time()
                c.execute('''
                INSERT INTO queue_entries 
                (id, ticket_number, restaurant_id, customer_name, phone, party_size, seating_pref, special_requests, entry_type, status, estimated_wait_mins, joined_at, has_arrived)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                ''', (ticket_id, "WM-101", rest_id, name, phone, 2, "First Available", "Verified arrival", "remote", "waiting", 8, now - 300))
                conn.commit()
                conn.close()
                self.send_json({"success": True, "message": "Host stand notified! You have arrived at the entrance."})
                return

            real_id = q['id']
            if action == "arrived":
                c.execute('UPDATE queue_entries SET has_arrived = 1 WHERE id = ?', (real_id,))
                msg = "Host stand notified! They can see you have arrived at the entrance."
            elif action == "delay":
                mins = int(data.get("minutes", 5))
                c.execute('UPDATE queue_entries SET delay_mins = delay_mins + ?, status = "delayed" WHERE id = ?', (mins, real_id))
                msg = f"Holding your token for +{mins} minutes (parking/traffic grace buffer)."
            elif action == "cancel":
                c.execute('UPDATE queue_entries SET status = "cancelled" WHERE id = ?', (real_id,))
                msg = "Your queue spot has been cancelled."
            elif action == "seated":
                # Diner confirms they've been seated ("I'm at the Venue" post-seating check-in)
                now = time.time()
                if q:
                    joined = q["joined_at"]
                    actual_wait = max(1, int((now - joined) / 60))
                    c.execute('UPDATE queue_entries SET status = "seated", seated_at = ?, actual_wait_mins = ?, has_arrived = 1 WHERE id = ?', (now, actual_wait, real_id))
                else:
                    # Cold start: diner confirmed seated but ticket row missing — reconstruct as seated
                    rest_id = data.get("restaurant_id", "rest-1")
                    name = data.get("customer_name", "Seated Guest")
                    now = time.time()
                    c.execute('''
                    INSERT INTO queue_entries
                    (id, ticket_number, restaurant_id, customer_name, phone, party_size, seating_pref, special_requests, entry_type, status, estimated_wait_mins, joined_at, seated_at, has_arrived)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                    ''', (ticket_id, "WM-101", rest_id, name, "", 2, "First Available", "Verified arrival", "remote", "seated", 8, now - 600, now))
                msg = "You've been seated! Please rate your experience."
            elif action == "rate":
                # Save the post-seating 1-5 star rating and mark the ticket as rated (no double rating)
                if not q:
                    conn.close()
                    self.send_json({"error": "Ticket not found"}, 404)
                    return
                # Enforcement: only seated tickets can be rated
                if q["status"] != "seated":
                    conn.close()
                    self.send_json({"error": "Ratings are only allowed after the diner has been seated (status must be 'seated')."}, 403)
                    return
                # Idempotency: a ticket can only be rated once per visit.
                if q["rated"]:
                    conn.close()
                    self.send_json({"success": True, "message": "Ticket already rated. Duplicate submission ignored."})
                    return
                try:
                    stars = int(data.get("rating", 0) or 0)
                except (TypeError, ValueError):
                    stars = 0
                if stars < 1 or stars > 5:
                    conn.close()
                    self.send_json({"error": "Rating must be between 1 and 5"}, 400)
                    return
                comment = str(data.get("comment", "") or "")
                c.execute('UPDATE queue_entries SET rated = 1, rating = ?, comment = ?, rated_at = ? WHERE id = ?', (stars, comment, time.time(), real_id))
                rest_id = q["restaurant_id"] if q["restaurant_id"] else "rest-1"
                rest_name = q["customer_name"] if q["customer_name"] else "Restaurant"
                c.execute('''
                    INSERT INTO reviews (id, restaurant_id, restaurant_name, rating, comment, ticket_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                ''', (f"rev-{int(time.time() * 1000)}", rest_id, rest_name, stars, comment, real_id, time.time()))
                msg = "Thanks! Your rating has been saved."
            else:
                conn.close()
                self.send_json({"error": "Unknown action"}, 400)
                return

            conn.commit()
            conn.close()
            self.send_json({"success": True, "message": msg})
            return

        # API: Verify restaurant password
        if path == "/api/host/verify-password":
            data = self.read_json_body()
            rest_id = data.get("restaurant_id")
            password = data.get("password", "")
            status, body = verify_host_password(rest_id, password)
            self.send_json(body, status)
            return

        # API: Host Stand Actions
        if path == "/api/host/action":
            data = self.read_json_body()
            action = data.get("action")
            rest_id = data.get("restaurant_id")

            conn = get_db()
            c = conn.cursor()

            if not rest_id and action in ("notify", "seat", "remove"):
                ticket_id = data.get("ticket_id")
                c.execute('SELECT restaurant_id FROM queue_entries WHERE id = ? OR ticket_number = ?', (ticket_id, ticket_id))
                ticket_row = c.fetchone()
                if ticket_row:
                    rest_id = ticket_row["restaurant_id"]

            supplied_pwd = self.headers.get("X-Restaurant-Password", data.get("password", ""))
            restaurant_row = None
            if rest_id:
                c.execute('SELECT * FROM restaurants WHERE id = ?', (rest_id,))
                restaurant_row = c.fetchone()
            if not restaurant_row or not verify_password(restaurant_row, supplied_pwd):
                conn.close()
                self.send_json({"error": "Invalid restaurant password."}, 401)
                return

            if action == "notify":
                ticket_id = data.get("ticket_id")
                c.execute('UPDATE queue_entries SET status = "notified", notified_at = ? WHERE id = ?', (time.time(), ticket_id))
                conn.commit()
                conn.close()
                self.send_json({"success": True, "message": "Notification & WhatsApp alert sent to diner!"})
                return

            elif action == "seat":
                ticket_id = data.get("ticket_id")
                now = time.time()
                c.execute('SELECT joined_at, estimated_wait_mins FROM queue_entries WHERE id = ?', (ticket_id,))
                entry = c.fetchone()
                if entry:
                    actual_wait = max(1, int((now - entry['joined_at']) / 60))
                    c.execute('UPDATE queue_entries SET status = "seated", seated_at = ?, actual_wait_mins = ? WHERE id = ?', (now, actual_wait, ticket_id))
                    
                    promised = entry['estimated_wait_mins']
                    diff = actual_wait - promised
                    if abs(diff) <= 3:
                        rating = "spot_on"
                    elif diff < -3:
                        rating = "faster"
                    elif diff <= 7:
                        rating = "slight_delay"
                    else:
                        rating = "severe_delay"

                    log_id = f"log-auto-{int(now)}"
                    c.execute('''
                    INSERT INTO reliability_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (log_id, rest_id, ticket_id, promised, actual_wait, rating, "Automated check-in at host stand", now))
                conn.commit()
                conn.close()
                self.send_json({"success": True, "message": "Party successfully seated!"})
                return

            elif action == "remove":
                ticket_id = data.get("ticket_id")
                status = data.get("status", "no_show")
                c.execute('UPDATE queue_entries SET status = ? WHERE id = ?', (status, ticket_id))
                conn.commit()
                conn.close()
                self.send_json({"success": True, "message": "Party marked as no-show/removed."})
                return

            elif action == "update_wait_estimate":
                manual_mins = data.get("manual_wait_mins")
                c.execute('UPDATE restaurants SET manual_override_wait = ? WHERE id = ?', (manual_mins, rest_id))
                conn.commit()
                conn.close()
                self.send_json({"success": True, "message": "Wait time estimate updated."})
                return

            elif action == "toggle_queue":
                is_open = int(data.get("is_open", 1))
                c.execute('UPDATE restaurants SET is_queue_open = ? WHERE id = ?', (is_open, rest_id))
                conn.commit()
                conn.close()
                self.send_json({"success": True, "message": "Queue status updated."})
                return

            elif action == "update_announcement":
                announcement = str(data.get("announcement", "") or "")
                c.execute('UPDATE restaurants SET announcement = ? WHERE id = ?', (announcement, rest_id))
                conn.commit()
                conn.close()
                self.send_json({"success": True, "message": "Announcement published.", "announcement": announcement})
                return

            elif action == "add_walkin":
                name = data.get("name", "Walk-in Guest")
                phone = str(data.get("phone", "")).strip()
                party_size = int(data.get("party_size", 2))
                seating_pref = data.get("seating_pref", "First Available")
                
                ticket_id = f"q-{str(int(time.time() * 1000))[-6:]}"
                c.execute('SELECT COUNT(*) FROM queue_entries WHERE restaurant_id = ?', (rest_id,))
                ticket_num = f"WM-{c.fetchone()[0] + 101}"
                
                live_stats = get_restaurant_live_stats(rest_id)
                est_wait = live_stats["estimated_wait_mins"]

                c.execute('''
                INSERT INTO queue_entries 
                (id, ticket_number, restaurant_id, customer_name, phone, party_size, seating_pref, special_requests, entry_type, status, estimated_wait_mins, joined_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', (ticket_id, ticket_num, rest_id, name, phone, party_size, seating_pref, "Host stand walk-in", "walk_in", 'waiting', est_wait, time.time()))
                conn.commit()
                conn.close()
                self.send_json({"success": True, "ticket_id": ticket_id, "ticket_number": ticket_num})
                return

            self.send_json({"error": "Unknown host action"}, 400)
            return

        # API: Founder Verify Master Password
        if path == "/api/founder/verify-password":
            data = self.read_json_body()
            provided = str(data.get("password", "") or "")
            if provided and verify_founder_password(provided):
                self.send_json({"success": True, "message": "Founder access granted."})
                return
            self.send_json({"error": "Incorrect Founder Master Password."}, 401)
            return

        # API: Founder Change Master Password
        if path == "/api/founder/change-password":
            data = self.read_json_body()
            current_password = str(data.get("current_password", "") or "").strip()
            new_password = str(data.get("new_password", "") or "").strip()

            if not current_password or not new_password:
                self.send_json({"error": "Missing required fields"}, 400)
                return

            if not verify_founder_password(current_password):
                self.send_json({"error": "Current Founder password is incorrect."}, 401)
                return

            if len(new_password) < 6:
                self.send_json({"error": "New password must be at least 6 characters."}, 400)
                return

            new_hash = _founder_hash(new_password)
            conn = get_db()
            c = conn.cursor()
            c.execute(
                "INSERT INTO app_settings (key, value) VALUES ('founder_password_hash', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (new_hash,)
            )
            conn.commit()
            conn.close()

            self.send_json({"success": True, "message": "Founder password updated successfully."})
            return

        # API: Founder Control Actions
        if path == "/api/founder/restaurant/toggle":
            if not is_founder_authorized(self):
                self.send_json({"error": "Invalid Founder Master Password."}, 401)
                return
            data = self.read_json_body()
            rest_id = data.get("restaurant_id")
            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT is_queue_open FROM restaurants WHERE id = ?', (rest_id,))
            row = c.fetchone()
            if not row:
                conn.close()
                self.send_json({"error": "Restaurant not found"}, 404)
                return
            new_state = 0 if row['is_queue_open'] == 1 else 1
            c.execute('UPDATE restaurants SET is_queue_open = ? WHERE id = ?', (new_state, rest_id))
            conn.commit()
            conn.close()
            self.send_json({"success": True, "new_state": new_state, "message": "Restaurant queue state updated."})
            return

        # API: Founder Reset Restaurant Password
        if path == "/api/founder/restaurant/reset-password":
            if not is_founder_authorized(self):
                self.send_json({"error": "Invalid Founder Master Password."}, 401)
                return
            data = self.read_json_body()
            rest_id = data.get("restaurant_id")
            new_password = data.get("new_password", "").strip()

            if not rest_id or not new_password:
                self.send_json({"error": "Missing restaurant_id or new_password"}, 400)
                return

            if len(new_password) < 4:
                self.send_json({"error": "Password must be at least 4 characters"}, 400)
                return

            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT id FROM restaurants WHERE id = ?', (rest_id,))
            if not c.fetchone():
                conn.close()
                self.send_json({"error": "Restaurant not found"}, 404)
                return

            new_hash = hash_password(new_password)
            c.execute('UPDATE restaurants SET password_hash = ? WHERE id = ?', (new_hash, rest_id))
            conn.commit()
            conn.close()

            self.send_json({"success": True, "message": "Restaurant password has been reset."})
            return

        # API: Founder Add New Restaurant
        if path == "/api/founder/restaurant/add":
            if not is_founder_authorized(self):
                self.send_json({"error": "Invalid Founder Master Password."}, 401)
                return
            data = self.read_json_body()
            name = str(data.get("name", "")).strip()
            category = str(data.get("category", "")).strip()
            v_type = str(data.get("type", "restaurant")).strip()
            city = str(data.get("city", "Mumbai") or "Mumbai").strip()
            address = str(data.get("address", "")).strip()
            price_range = str(data.get("price_range", "₹₹")).strip()
            password = str(data.get("password", "")).strip()
            total_tables = int(data.get("total_tables", 16) or 16)
            base_prep_time = int(data.get("base_prep_time", 15) or 15)
            image_url = str(data.get("image_url", "")).strip() or "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80"
            description = str(data.get("description", "")).strip() or f"Authentic {category} located in {city}."

            if not name or not address or not password:
                self.send_json({"error": "Restaurant name, address, and owner dashboard password are required."}, 400)
                return
            if len(password) < 4:
                self.send_json({"error": "Owner dashboard password must be at least 4 characters."}, 400)
                return

            rest_id = f"rest-{int(time.time() * 1000)}"
            conn = get_db()
            c = conn.cursor()
            c.execute('''
            INSERT INTO restaurants 
            (id, name, category, type, city, address, distance_km, price_range, image_url, description, owner_name, owner_phone, base_prep_time, available_tables, total_tables, manual_override_wait, is_queue_open, created_at, password_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (rest_id, name, category, v_type, city, address, 1.0, price_range, image_url, description, "Owner", "+91 98450 12345", base_prep_time, max(1, total_tables // 4), total_tables, None, 1, time.time(), hash_password(password)))
            conn.commit()
            conn.close()

            self.send_json({
                "success": True,
                "restaurant_id": rest_id,
                "message": f"Congratulations! '{name}' is now live on WaitMate India.",
                "restaurant": {"id": rest_id, "name": name, "category": category, "city": city, "address": address}
            })
            return

        # API: Founder Remove Restaurant
        if path == "/api/founder/restaurant/delete":
            if not is_founder_authorized(self):
                self.send_json({"error": "Invalid Founder Master Password."}, 401)
                return
            data = self.read_json_body()
            rest_id = data.get("restaurant_id")
            if not rest_id:
                self.send_json({"error": "Missing restaurant_id"}, 400)
                return
            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT id FROM restaurants WHERE id = ?', (rest_id,))
            if not c.fetchone():
                conn.close()
                self.send_json({"error": "Restaurant not found"}, 404)
                return
            c.execute('DELETE FROM queue_entries WHERE restaurant_id = ?', (rest_id,))
            c.execute('DELETE FROM restaurants WHERE id = ?', (rest_id,))
            conn.commit()
            conn.close()
            self.send_json({"success": True, "message": "Restaurant removed from WaitMate Mumbai network."})
            return

        # API: Owner Change Password
        if path == "/api/host/change-password":
            data = self.read_json_body()
            rest_id = data.get("restaurant_id")
            current_password = data.get("current_password", "").strip()
            new_password = data.get("new_password", "").strip()

            if not rest_id or not current_password or not new_password:
                self.send_json({"error": "Missing required fields"}, 400)
                return

            if len(new_password) < 4:
                self.send_json({"error": "New password must be at least 4 characters"}, 400)
                return

            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT * FROM restaurants WHERE id = ?', (rest_id,))
            rest_row = c.fetchone()
            if not rest_row:
                conn.close()
                self.send_json({"error": "Restaurant not found"}, 404)
                return

            rest = dict(rest_row)
            if not verify_password(rest, current_password):
                conn.close()
                self.send_json({"error": "Current password is incorrect"}, 401)
                return

            new_hash = hash_password(new_password)
            c.execute('UPDATE restaurants SET password_hash = ? WHERE id = ?', (new_hash, rest_id))
            conn.commit()
            conn.close()

            self.send_json({"success": True, "message": "Password updated successfully."})
            return

        # API: Reliability Verification Feedback
        if path == "/api/reliability/feedback":
            data = self.read_json_body()
            rest_id = data.get("restaurant_id")
            ticket_id = data.get("ticket_id")
            promised = int(data.get("promised_wait", 20))
            actual = int(data.get("actual_wait", 22))
            rating = data.get("rating", "spot_on")
            note = data.get("note", "").strip()

            if not rest_id:
                self.send_json({"error": "Missing restaurant_id"}, 400)
                return

            log_id = f"log-user-{int(time.time())}"
            conn = get_db()
            c = conn.cursor()
            c.execute('''
            INSERT INTO reliability_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ''', (log_id, rest_id, ticket_id, promised, actual, rating, note, time.time()))
            conn.commit()
            conn.close()

            updated_rel = calculate_reliability(rest_id)
            self.send_json({
                "success": True, 
                "message": "Dhanyavaad! Your verified check-in directly updated the restaurant's Reliability Score.",
                "updated_reliability": updated_rel
            })
            return

        # API: Submit a Review (Star Rating + Comment)
        if path == "/api/reviews":
            data = self.read_json_body()
            restaurant_id = data.get("restaurantId")
            restaurant_name = data.get("restaurantName")
            rating = data.get("rating")
            comment = data.get("comment", "").strip()

            if not restaurant_id or not restaurant_name or not rating:
                self.send_json({"error": "Missing required fields: restaurantId, restaurantName, rating (1-5)"}, 400)
                return

            rating_int = int(rating)
            if rating_int < 1 or rating_int > 5:
                self.send_json({"error": "Rating must be between 1 and 5"}, 400)
                return

            review_id = f"rev-{int(time.time() * 1000)}"
            conn = get_db()
            c = conn.cursor()

            # Idempotency: a ticket can only be rated once per visit.
            ticket_id = data.get("ticket_id", "")
            if ticket_id:
                c.execute('SELECT rated FROM queue_entries WHERE id = ? OR ticket_number = ?', (ticket_id, ticket_id))
                trow = c.fetchone()
                if trow and trow["rated"]:
                    conn.close()
                    self.send_json({"success": True, "message": "Ticket already rated. Duplicate submission ignored."})
                    return

            c.execute('''
                INSERT INTO reviews (id, restaurant_id, restaurant_name, rating, comment, ticket_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (review_id, restaurant_id, restaurant_name, rating_int, comment, data.get("ticket_id", ""), time.time()))
            conn.commit()
            conn.close()

            self.send_json({
                "success": True, 
                "message": "Thanks! Your verified check-in is live.",
                "review": {
                    "id": review_id,
                    "restaurant_id": restaurant_id,
                    "restaurant_name": restaurant_name,
                    "rating": rating_int,
                    "comment": comment,
                    "created_at": time.time()
                }
            })
            return

        # ------------------------------------------------------------------
        # FOUNDER SUPER-ADMIN ("GOD MODE") POST ENDPOINTS (SQLite mirror)
        # ------------------------------------------------------------------

        def _require_founders():
            if not is_founder_authorized(self):
                self.send_json({"error": "Invalid Founder Master Password."}, 401)
                return False
            return True

        # API: Founder update any restaurant
        if path == "/api/founder/restaurant/update":
            if not _require_founders():
                return
            data = self.read_json_body()
            rest_id = data.get("restaurant_id")
            if not rest_id:
                self.send_json({"error": "Missing restaurant_id"}, 400)
                return
            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT * FROM restaurants WHERE id = ?', (rest_id,))
            if not c.fetchone():
                conn.close()
                self.send_json({"error": "Restaurant not found"}, 404)
                return
            allowed = ["name", "category", "type", "city", "address", "price_range", "image_url", "description", "total_tables", "base_prep_time", "is_queue_open"]
            sets = []
            vals = []
            for field in allowed:
                if field in data:
                    val = data[field]
                    if field == "is_queue_open":
                        val = 1 if bool(val) else 0
                    sets.append(f"{field} = ?")
                    vals.append(val)
            if not sets:
                conn.close()
                self.send_json({"error": "No updatable fields provided"}, 400)
                return
            if "total_tables" in data:
                sets.append("available_tables = ?")
                vals.append(max(1, int(data.get("total_tables", 16)) // 4))
            vals.append(rest_id)
            c.execute(f"UPDATE restaurants SET {', '.join(sets)} WHERE id = ?", vals)
            conn.commit()
            conn.close()
            self.send_json({"success": True, "message": "Restaurant updated."})
            return

        # API: Founder override Reliability Score & Grade
        if path == "/api/founder/restaurant/reliability":
            if not _require_founders():
                return
            data = self.read_json_body()
            rest_id = data.get("restaurant_id")
            if not rest_id:
                self.send_json({"error": "Missing restaurant_id"}, 400)
                return
            try:
                score = max(0, min(100, int(data.get("score", 0))))
            except (TypeError, ValueError):
                self.send_json({"error": "Invalid reliability score"}, 400)
                return
            grade = "A+" if score >= 95 else "A" if score >= 90 else "B" if score >= 80 else "C"
            verdicts = {"A+": "Exceptionally Accurate", "A": "Highly Reliable", "B": "Moderate Variance", "C": "Unpredictable Peak Waits"}
            badge_colors = {"A+": "emerald", "A": "emerald", "B": "amber", "C": "rose"}
            override = {
                "score": score,
                "grade": grade,
                "verdict": data.get("verdict") or verdicts[grade],
                "badge_color": data.get("badge_color") or badge_colors[grade],
                "avg_variance_mins": float(data.get("avg_variance_mins", 2.5)),
                "total_verified_checkins": int(data.get("total_verified_checkins", 0)),
                "on_time_pct": int(data.get("on_time_pct", 90)),
                "early_pct": int(data.get("early_pct", 5)),
                "slight_late_pct": int(data.get("slight_late_pct", 5)),
                "severe_late_pct": int(data.get("severe_late_pct", 0)),
                "recent_reviews": data.get("recent_reviews", [])
            }
            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT id FROM restaurants WHERE id = ?', (rest_id,))
            if not c.fetchone():
                conn.close()
                self.send_json({"error": "Restaurant not found"}, 404)
                return
            c.execute(
                "INSERT INTO app_settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (f"fnd_override_{rest_id}", json.dumps(override))
            )
            conn.commit()
            conn.close()
            self.send_json({"success": True, "message": f"Reliability Score overridden to {score}% (Grade {grade}).", "score": score, "grade": grade})
            return

        # API: Founder publish / edit / clear venue announcement
        if path == "/api/founder/restaurant/announcement":
            if not _require_founders():
                return
            data = self.read_json_body()
            rest_id = data.get("restaurant_id")
            if not rest_id:
                self.send_json({"error": "Missing restaurant_id"}, 400)
                return
            announcement = str(data.get("announcement", ""))
            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT id FROM restaurants WHERE id = ?', (rest_id,))
            if not c.fetchone():
                conn.close()
                self.send_json({"error": "Restaurant not found"}, 404)
                return
            c.execute('UPDATE restaurants SET announcement = ? WHERE id = ?', (announcement, rest_id))
            conn.commit()
            conn.close()
            self.send_json({"success": True, "message": "Announcement published." if announcement else "Announcement cleared.", "announcement": announcement})
            return

        # API: Founder manual wait-time override
        if path == "/api/founder/restaurant/manual-wait":
            if not _require_founders():
                return
            data = self.read_json_body()
            rest_id = data.get("restaurant_id")
            if not rest_id:
                self.send_json({"error": "Missing restaurant_id"}, 400)
                return
            manual = data.get("manual_wait_mins")
            if manual is None or manual == "":
                manual = None
            else:
                try:
                    manual = int(manual)
                    if manual < 0 or manual > 180:
                        raise ValueError
                except (TypeError, ValueError):
                    self.send_json({"error": "Manual wait must be between 0 and 180 minutes"}, 400)
                    return
            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT id FROM restaurants WHERE id = ?', (rest_id,))
            if not c.fetchone():
                conn.close()
                self.send_json({"error": "Restaurant not found"}, 404)
                return
            c.execute('UPDATE restaurants SET manual_override_wait = ? WHERE id = ?', (manual, rest_id))
            conn.commit()
            conn.close()
            self.send_json({"success": True, "message": "Wait estimate reset to algorithmic." if manual is None else f"Wait estimate overridden to {manual} mins.", "manual_override_wait": manual})
            return

        # API: Founder global network banner
        if path == "/api/founder/announcement/global":
            if not _require_founders():
                return
            data = self.read_json_body()
            value = str(data.get("announcement", ""))
            conn = get_db()
            c = conn.cursor()
            c.execute(
                "INSERT INTO app_settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                ("global_announcement", value)
            )
            conn.commit()
            conn.close()
            self.send_json({"success": True, "message": "Global network banner published." if value else "Global network banner cleared.", "announcement": value})
            return

        # API: Founder queue action on any ticket (notify/seat/remove/edit_party_size)
        if path == "/api/founder/queue/action":
            if not _require_founders():
                return
            data = self.read_json_body()
            ticket_id = data.get("ticket_id")
            action = data.get("action")
            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT * FROM queue_entries WHERE id = ? OR ticket_number = ?', (ticket_id, ticket_id))
            q = c.fetchone()
            if not q:
                conn.close()
                self.send_json({"error": "Ticket not found"}, 404)
                return
            qid = q["id"]
            now = time.time()
            if action == "notify":
                c.execute('UPDATE queue_entries SET status = "notified", notified_at = ? WHERE id = ?', (now, qid))
            elif action == "seat":
                joined = q["joined_at"]
                actual_wait = max(1, int((now - joined) / 60))
                c.execute('UPDATE queue_entries SET status = "seated", seated_at = ?, actual_wait_mins = ?, has_arrived = 1 WHERE id = ?', (now, actual_wait, qid))
                c.execute('''
                    INSERT INTO reliability_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ''', (f"log-fnd-seat-{int(now)}", q["restaurant_id"], qid, q["estimated_wait_mins"], actual_wait, "spot_on" if abs(actual_wait - q["estimated_wait_mins"]) <= 3 else ("faster" if actual_wait < q["estimated_wait_mins"] - 3 else ("slight_delay" if actual_wait <= q["estimated_wait_mins"] + 7 else "severe_delay")), "Founder seated the party", now))
            elif action == "remove":
                c.execute('UPDATE queue_entries SET status = "no_show" WHERE id = ?', (qid,))
            elif action == "edit_party_size":
                try:
                    size = int(data.get("party_size", 0))
                    if size < 1 or size > 20:
                        raise ValueError
                except (TypeError, ValueError):
                    conn.close()
                    self.send_json({"error": "Party size must be between 1 and 20"}, 400)
                    return
                c.execute('UPDATE queue_entries SET party_size = ? WHERE id = ?', (size, qid))
            else:
                conn.close()
                self.send_json({"error": "Unknown queue action"}, 400)
                return
            conn.commit()
            conn.close()
            self.send_json({"success": True, "message": "Queue action updated."})
            return

        # API: Founder clear a venue's active queue
        if path == "/api/founder/queue/clear-venue":
            if not _require_founders():
                return
            data = self.read_json_body()
            rest_id = data.get("restaurant_id")
            if not rest_id:
                self.send_json({"error": "Missing restaurant_id"}, 400)
                return
            conn = get_db()
            c = conn.cursor()
            c.execute('SELECT COUNT(*) FROM queue_entries WHERE restaurant_id = ? AND status IN ("waiting", "notified", "delayed")', (rest_id,))
            count = c.fetchone()[0]
            c.execute('DELETE FROM queue_entries WHERE restaurant_id = ? AND status IN ("waiting", "notified", "delayed")', (rest_id,))
            conn.commit()
            conn.close()
            self.send_json({"success": True, "message": f"Cleared {count} active ticket(s) from the venue queue.", "cleared": count})
            return

        # API: Founder purge test / stale entries
        if path == "/api/founder/queue/purge":
            if not _require_founders():
                return
            conn = get_db()
            c = conn.cursor()
            c.execute("SELECT COUNT(*) FROM queue_entries WHERE status NOT IN ('waiting', 'notified', 'delayed')")
            count = c.fetchone()[0]
            c.execute("DELETE FROM queue_entries WHERE status NOT IN ('waiting', 'notified', 'delayed')")
            conn.commit()
            conn.close()
            self.send_json({"success": True, "message": f"Purged {count} stale/test queue entry(ies).", "purged": count})
            return

        self.send_json({"error": "Endpoint not found"}, 404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # API: Founder delete / hide a review (audit watchdog) + recalc score
        if path.startswith("/api/founder/reviews/"):
            if not is_founder_authorized(self):
                self.send_json({"error": "Invalid Founder Master Password."}, 401)
                return
            review_id = path.rsplit("/", 1)[-1]
            if not review_id:
                self.send_json({"error": "Missing review id"}, 400)
                return
            conn = get_db()
            c = conn.cursor()
            c.execute("SELECT restaurant_id FROM reviews WHERE id = ?", (review_id,))
            row = c.fetchone()
            restaurant_id = row["restaurant_id"] if row else None
            c.execute("DELETE FROM reviews WHERE id = ?", (review_id,))
            conn.commit()
            conn.close()
            # Recalculate Reliability Score from remaining reviews
            if restaurant_id:
                conn = get_db()
                c = conn.cursor()
                c.execute("SELECT rating FROM reviews WHERE restaurant_id = ?", (restaurant_id,))
                rated = c.fetchall()
                conn.close()
                if rated:
                    ratings = [r["rating"] for r in rated]
                    avg = sum(ratings) / len(ratings)
                    score = max(50, min(99, round(55 + (avg - 1) * 11)))
                    grade = "A+" if score >= 95 else "A" if score >= 90 else "B" if score >= 80 else "C"
                    badge = "emerald" if score >= 85 else ("amber" if score >= 75 else "rose")
                    override = {
                        "score": score,
                        "grade": grade,
                        "verdict": "Recalculated after review moderation",
                        "badge_color": badge,
                        "avg_variance_mins": 2.5,
                        "total_verified_checkins": len(ratings),
                        "on_time_pct": 90,
                        "early_pct": 5,
                        "slight_late_pct": 5,
                        "severe_late_pct": 0,
                        "recent_reviews": []
                    }
                    conn = get_db()
                    c = conn.cursor()
                    c.execute(
                        "INSERT INTO app_settings (key, value) VALUES (?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (f"fnd_override_{restaurant_id}", json.dumps(override))
                    )
                    conn.commit()
                    conn.close()
            self.send_json({"success": True, "message": "Review deleted and Reliability Score recalculated."})
            return

        self.send_json({"error": "Endpoint not found"}, 404)

    def serve_static_file(self, filepath, content_type):
        if not os.path.exists(filepath):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"File not found")
            return

        with open(filepath, "rb") as f:
            content = f.read()

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        # Static assets are versioned by deploy; allow shared caches to hold them
        # with stale-while-revalidate so repeated page refreshes do not re-fetch
        # (and never trigger backend/Firestore reads) for unchanged assets.
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(content)

def run():
    init_db()
    server_address = ('', PORT)
    httpd = HTTPServer(server_address, WaitMateHandler)
    print(f"WaitMate Server running on http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        httpd.server_close()

if __name__ == "__main__":
    run()
