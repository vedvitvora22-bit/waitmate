const crypto = require("crypto");
const {
  getAccessToken,
  firestoreRequest,
  listCollection,
  getDocument,
  commitWrites,
  setDocument,
  PROJECT_ID,
  encodeSegment
} = require("./_firestore");

const now = Date.now();

// In-memory cooldown guard (module scope) so warm Vercel invocations can short-
// circuit repeated simulation ticks on back-to-back requests without touching
// Firestore. Mirrors the persisted last_simulated_at cooldown (120s here is
// intentionally stricter than the 60s persistence guard).
global._lastSimCache = global._lastSimCache || {};
const LAST_SIM_COOLDOWN_MS = 120000;

global._tickets = global._tickets || {};
global._customRestaurants = global._customRestaurants || [];
global._deletedRestaurantIds = global._deletedRestaurantIds || [];
global._pwdMap = global._pwdMap || {};

function founderPassword() {
  return process.env.FOUNDER_PASSWORD || "waitmatefounder2026";
}

function universalHostPassword() {
  return process.env.UNIVERSAL_HOST_PASSWORD || "waitmatehost2026";
}

function getActiveUniversalHostHash() {
  if (global._universalHostPwdHash) return global._universalHostPwdHash;
  return hashPassword(universalHostPassword());
}

function isUniversalHostPassword(password) {
  const provided = String(password || "").trim();
  if (!provided) return false;
  return hashPassword(provided) === getActiveUniversalHostHash();
}

function getActiveFounderHash() {
  if (global._founderPwdHash) return global._founderPwdHash;
  return hashPassword(founderPassword());
}

function isFounderAuthorized(request) {
  const supplied = request.headers["x-founder-password"];
  if (!supplied) return false;
  return hashPassword(supplied) === getActiveFounderHash();
}

function verifyFounderPassword(password) {
  const provided = String(password || "").trim();
  if (!provided) return false;
  return hashPassword(provided) === getActiveFounderHash();
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password || "").trim()).digest("hex");
}

const fallbackRestaurants = [
  { id: "rest-1", name: "The Rameshwaram Cafe", category: "Iconic South Indian & Filter Coffee", type: "restaurant", city: "Mumbai", address: "Linking Road, Bandra West, Mumbai", distance_km: 0.8, price_range: "₹", meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"], image_url: "https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800&auto=format&fit=crop&q=80", description: "Famous for crispy ghee podi dosa, medu vada, and authentic filter coffee.", base_prep_time: 8, available_tables: 2, total_tables: 18, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("rameshwaram123"), created_at: now - 86400000 },
  { id: "rest-2", name: "Meghana Foods", category: "Spicy Andhra Biryani & Thalis", type: "restaurant", city: "Mumbai", address: "Senapati Bapat Marg, Lower Parel, Mumbai", distance_km: 1.6, price_range: "₹₹", meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"], image_url: "https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800&auto=format&fit=crop&q=80", description: "Legendary boneless chicken biryani and traditional Andhra meals.", base_prep_time: 16, available_tables: 1, total_tables: 22, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("meghana123"), created_at: now - 172800000 },
  { id: "rest-3", name: "Bademiya Street Kebab Truck & Rolls", category: "Late-Night Charcoal Kebabs & Baida Roti", type: "food_truck", city: "Mumbai", address: "Tulloch Road, Colaba, Mumbai", distance_km: 0.5, price_range: "₹₹", meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"], image_url: "https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=800&auto=format&fit=crop&q=80", description: "Mumbai's iconic street food institution.", base_prep_time: 7, available_tables: 0, total_tables: 10, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("bademiya123"), created_at: now - 259200000 },
  { id: "rest-4", name: "Toit Brewpub & Kitchen", category: "Craft Microbrewery & Woodfired Pizza", type: "restaurant", city: "Mumbai", address: "Mathuradas Mill Compound, Lower Parel, Mumbai", distance_km: 1.2, price_range: "₹₹₹", meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"], image_url: "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&auto=format&fit=crop&q=80", description: "Craft beer and woodfired sourdough pizza.", base_prep_time: 22, available_tables: 2, total_tables: 26, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("toit123"), created_at: now - 345600000 },
  { id: "rest-5", name: "Chai Sutta Bar & Bun Maska Express", category: "Kulhad Chai, Bun Maska & Samosas", type: "food_truck", city: "Mumbai", address: "Juhu Tara Road, Juhu, Mumbai", distance_km: 0.4, price_range: "₹", meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"], image_url: "https://images.unsplash.com/photo-1576092768241-dec231879fc3?w=800&auto=format&fit=crop&q=80", description: "Kulhad chai, bun maska, and hot samosas.", base_prep_time: 5, available_tables: 0, total_tables: 6, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("chaisutta123"), created_at: now - 432000000 },
  { id: "rest-6", name: "Punjab Grill & Royal Tandoor", category: "North Indian, Dal Makhani & Kebabs", type: "restaurant", city: "Mumbai", address: "Palladium Mall, Lower Parel, Mumbai", distance_km: 3.2, price_range: "₹₹₹", meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"], image_url: "https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&auto=format&fit=crop&q=80", description: "North Indian dining with dal makhani and tandoori platters.", base_prep_time: 20, available_tables: 1, total_tables: 20, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("punjab123"), created_at: now - 518400000 },
  { id: "rest-7", name: "Britannia & Co. Restaurant", category: "Parsi & Irani Heritage", type: "restaurant", city: "Mumbai", address: "Wakefield House, Ballard Estate, Fort, Mumbai", distance_km: 1.5, price_range: "₹₹", meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"], image_url: "https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&auto=format&fit=crop&q=80", description: "Legendary 1923 Parsi cafe famous for Mutton Berry Pulao, Sali Boti, and Caramel Custard.", base_prep_time: 18, available_tables: 3, total_tables: 14, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("britannia123"), created_at: now - 604800000 },
  { id: "rest-8", name: "Kyani & Co. Bakery & Cafe", category: "Irani Cafe & Bakery", type: "restaurant", city: "Mumbai", address: "Jer Mahal Estate, Dhobi Talao, Marine Lines, Mumbai", distance_km: 0.6, price_range: "₹", meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"], image_url: "https://images.unsplash.com/photo-1554118811-1e0d58224f24?w=800&auto=format&fit=crop&q=80", description: "Iconic South Mumbai Irani bakery serving fresh Bun Maska, Keema Pav, Mawa Cake, and Irani Chai.", base_prep_time: 10, available_tables: 4, total_tables: 18, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("kyani123"), created_at: now - 691200000 },
  { id: "rest-9", name: "Prithvi Cafe", category: "Cafe & Outdoor Bistro", type: "restaurant", city: "Mumbai", address: "Janki Kutir, Juhu Church Road, Juhu, Mumbai", distance_km: 2.1, price_range: "₹₹", meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"], image_url: "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80", description: "Bamboo-shaded theatre courtyard cafe in Juhu known for Irish Coffee, Suleimani Chai, and Amritsari Paratha.", base_prep_time: 15, available_tables: 2, total_tables: 16, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("prithvi123"), created_at: now - 777600000 },
  { id: "rest-10", name: "Sardar Pav Bhaji Express Truck", category: "Mumbai Street Food & Pav Bhaji", type: "food_truck", city: "Mumbai", address: "Tardeo Road Junction, Mumbai Central, Mumbai", distance_km: 2.8, price_range: "₹", meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"], image_url: "https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800&auto=format&fit=crop&q=80", description: "High-turnover Mumbai street food counter famous for extra-butter Pav Bhaji and Masala Tawa Pulao.", base_prep_time: 8, available_tables: 5, total_tables: 20, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("sardar123"), created_at: now - 864000000 },
  { id: "rest-11", name: "Juhu Tawa Junction", category: "Pav Bhaji & Tawa Pulao", type: "food_truck", city: "Mumbai", address: "Juhu Chowpatty, Juhu, Mumbai", distance_km: 3.5, price_range: "₹", meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"], image_url: "https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800&auto=format&fit=crop&q=80", description: "Legendary Juhu Chowpatty street food truck serving butter-loaded Pav Bhaji, Masala Tawa Pulao, and grilled sandwiches.", base_prep_time: 6, available_tables: 0, total_tables: 8, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("juhutawa789"), created_at: now - 950400000 },
  { id: "rest-12", name: "Bandra Woodfire Truck", category: "Wood-Fired Pizza & Artisanal Sandwiches", type: "food_truck", city: "Mumbai", address: "Chapel Road, Bandra West, Mumbai", distance_km: 1.0, price_range: "₹₹", meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"], image_url: "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&auto=format&fit=crop&q=80", description: "Gourmet wood-fired Neapolitan pizzas with fresh mozzarella, basil, and spicy fermented hot honey drizzle.", base_prep_time: 12, available_tables: 0, total_tables: 6, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("bandrapizza456"), created_at: now - 1036800000 }
];

function sanitizeRestaurant(restaurant) {
  const copy = { ...restaurant };
  delete copy.password_hash;
  delete copy.password;
  return copy;
}

function verifyRestaurantPassword(restaurant, password) {
  const provided = String(password || "").trim();
  if (!provided) return false;
  if (isUniversalHostPassword(provided)) return true;
  const lower = provided.toLowerCase();
  if (restaurant.password_hash) {
    if (hashPassword(provided) === restaurant.password_hash || hashPassword(lower) === restaurant.password_hash) {
      return true;
    }
  }
  const fallback = fallbackRestaurants.find(r => r.id === restaurant.id || String(r.name || "").toLowerCase() === String(restaurant.name || "").toLowerCase());
  if (fallback && fallback.password_hash) {
    if (hashPassword(provided) === fallback.password_hash || hashPassword(lower) === fallback.password_hash) {
      return true;
    }
  }
  return lower === "waitmate123";
}

function send(response, status, data) {
  response.status(status);
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Restaurant-Password, X-Founder-Password");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  // Live queue/ticket data must never be cached by browsers or proxies, so the
  // Host Stand and diner passes always reflect the latest Firestore state.
  response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");
  response.send(JSON.stringify(data));
}

function parseBody(request) {
  if (!request.body) return {};
  if (Buffer.isBuffer(request.body)) {
    try { return JSON.parse(request.body.toString("utf8")); } catch { return {}; }
  }
  if (typeof request.body === "object") return request.body;
  try {
    return JSON.parse(request.body);
  } catch {
    return {};
  }
}

function reliabilityFallback() {
  return { score: 92, grade: "A", verdict: "Verified demo data", badge_color: "emerald", avg_variance_mins: 2.5, total_verified_checkins: 0, on_time_pct: 90, early_pct: 5, slight_late_pct: 5, severe_late_pct: 0, recent_reviews: [] };
}

async function findRestaurantById(id) {
  try {
    const doc = await getDocument("restaurants", id);
    if (doc) {
      const pwdMap = global._pwdMap || {};
      if (pwdMap[id]) {
        return { ...doc, ...pwdMap[id] };
      }
      return doc;
    }
  } catch (error) {
    if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
      // fall through to in-memory sources below
    } else {
      throw error;
    }
  }
  const fb = fallbackRestaurants.find(r => r.id === id) || (global._customRestaurants || []).find(r => r.id === id);
  return fb ? { ...fb, ...(global._pwdMap?.[id] || {}) } : null;
}

// ---------------------------------------------------------------------------
// queue_entries schema helpers
//
// Firestore documents are stored with numbered field prefixes (01_ … 22_) so
// the Firebase Console lists them top-to-bottom in a logical order. The diner
// app and Founder dashboard keep reading the original unprefixed field names,
// so every read passes through normalizeQueueEntry() (which understands both
// the new numbered documents and legacy unprefixed documents) and every write
// passes through toNumberedEntry() (which emits the clean 22-field document).
// ---------------------------------------------------------------------------

// Map an unprefixed/numbered queue entry to the canonical unprefixed shape the
// frontend consumes. Accepts both new (01_…) and legacy documents seamlessly.
function normalizeQueueEntry(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const pick = (...keys) => {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== null) return raw[k];
    }
    return undefined;
  };
  const channelRaw = pick("09_channel", "channel", "entry_type");
  let channel;
  if (channelRaw !== undefined && channelRaw !== null && String(channelRaw).trim() !== "") {
    channel = (channelRaw === "walkin" || channelRaw === "walk-in" || channelRaw === "walk_in") ? "walk_in" : "remote";
  } else {
    // Fall back to the legacy is_walk_in boolean when no explicit channel is stored.
    channel = pick("is_walk_in") ? "walk_in" : "remote";
  }
  const guestName = pick("04_guest_name", "guest_name", "customer_name") || "";
  const joinedMsRaw = pick("22_joined_at_ms", "joined_at");
  const joinedMs = joinedMsRaw !== undefined ? Number(joinedMsRaw) : Date.now();
  const ratingRaw = pick("19_rating", "rating", "stars");
  const actualRaw = pick("17_actual_wait_mins", "actual_wait_mins");
  const promisedRaw = pick("12_promised_wait_mins", "promised_wait_mins", "estimated_wait_mins");

  const entry = {
    ticket_number: pick("01_ticket_number", "ticket_number"),
    restaurant_id: pick("02_restaurant_id", "restaurant_id"),
    restaurant_name: pick("03_restaurant_name", "restaurant_name") || "",
    guest_name: guestName,
    customer_name: guestName,
    phone: pick("05_phone", "phone") || "",
    party_size: Number(pick("06_party_size", "party_size") || 2),
    seating_pref: pick("07_seating_pref", "seating_pref") || "First Available",
    special_requests: pick("08_special_requests", "special_requests") || "",
    channel,
    entry_type: channel,
    source: pick("source") || (Boolean(pick("is_ghost", "isGhost")) ? 'ai-ghost' : channel),
    status: pick("10_status", "status") || "waiting",
    has_arrived: Boolean(pick("11_has_arrived", "has_arrived")),
    is_ghost: Boolean(pick("is_ghost", "isGhost")),
    isGhost: Boolean(pick("is_ghost", "isGhost")),
    promised_wait_mins: Number(promisedRaw || 0),
    estimated_wait_mins: Number(promisedRaw || 0),
    joined_time_ist: pick("13_joined_time_ist", "joined_time_ist") || (joinedMs ? formatIST(joinedMs) : null),
    arrived_time_ist: pick("14_arrived_time_ist", "arrived_time_ist") || null,
    notified_time_ist: pick("15_notified_time_ist", "notified_time_ist") || null,
    seated_time_ist: pick("16_seated_time_ist", "seated_time_ist") || null,
    actual_wait_mins: actualRaw === undefined || actualRaw === null ? null : Number(actualRaw),
    rated: Boolean(pick("18_rated", "rated")),
    rating: ratingRaw === undefined || ratingRaw === null ? null : Number(ratingRaw),
    review_comment: pick("20_review_comment", "review_comment", "comment") || "",
    comment: pick("20_review_comment", "comment", "review_comment") || "",
    rated_time_ist: pick("21_rated_time_ist", "rated_time_ist") || null,
    joined_at_ms: joinedMs,
    joined_at: joinedMs,
    id: raw.id
  };

  // Preserve any legacy/auxiliary fields the UI still relies on (delay_mins,
  // parties_ahead, *_at ms stamps, arrival_status, etc.) while dropping the
  // numbered storage keys so API responses stay clean.
  for (const [key, value] of Object.entries(raw)) {
    if (/^\d{2}_/.test(key)) continue;
    if (entry[key] === undefined) entry[key] = value;
  }
  // "stars" was a legacy duplicate of rating; never surface it.
  delete entry.stars;
  return entry;
}

// Map a canonical (unprefixed) queue entry to the numbered 22-field Firestore
// document. Missing *_ist strings are derived from their ms timestamps.
function toNumberedEntry(entry) {
  const e = entry || {};
  const chanRaw = e.channel || e.entry_type || "remote";
  const channel = chanRaw === "walkin" || chanRaw === "walk-in" || chanRaw === "walk_in" ? "walk_in" : "remote";
  const guestName = e.guest_name || e.customer_name || "";
  const joinedMs = e.joined_at_ms !== undefined && e.joined_at_ms !== null
    ? Number(e.joined_at_ms)
    : (e.joined_at !== undefined && e.joined_at !== null ? Number(e.joined_at) : Date.now());
  const ist = (ms) => (ms === undefined || ms === null || ms === "" ? null : formatIST(ms));
  const promised = e.promised_wait_mins !== undefined ? e.promised_wait_mins : (e.estimated_wait_mins || 0);

  const numbered = {
    "01_ticket_number": e.ticket_number || "",
    "02_restaurant_id": e.restaurant_id || "",
    "03_restaurant_name": e.restaurant_name || "",
    "04_guest_name": guestName,
    "05_phone": e.phone || "",
    "06_party_size": Number(e.party_size || 2),
    "07_seating_pref": e.seating_pref || "First Available",
    "08_special_requests": e.special_requests || "",
    "09_channel": channel,
    "10_status": e.status || "waiting",
    "11_has_arrived": Boolean(e.has_arrived),
    "12_promised_wait_mins": Number(promised || 0),
    "source": e.source || (e.entry_type === 'ghost' ? 'ai-ghost' : channel),
    "13_joined_time_ist": e.joined_time_ist || ist(joinedMs) || "",
    "14_arrived_time_ist": e.arrived_time_ist || ist(e.arrived_at) || null,
    "15_notified_time_ist": e.notified_time_ist || ist(e.notified_at) || null,
    "16_seated_time_ist": e.seated_time_ist || ist(e.seated_at) || null,
    "17_actual_wait_mins": e.actual_wait_mins === undefined || e.actual_wait_mins === null ? null : Number(e.actual_wait_mins),
    "18_rated": Boolean(e.rated),
    "19_rating": e.rating === undefined || e.rating === null ? null : Number(e.rating),
    "20_review_comment": e.review_comment || e.comment || "",
    "21_rated_time_ist": e.rated_time_ist || ist(e.rated_at) || null,
    "22_joined_at_ms": joinedMs
  };
  if (e.is_ghost || e.isGhost || e.entry_type === 'ghost') {
    numbered.is_ghost = true;
    numbered.isGhost = true;
    numbered.entry_type = 'ghost';
  }
  return numbered;
}

// Read helpers that normalize on the way out so callers always get the
// canonical unprefixed shape regardless of how the document is stored.
async function fetchQueueEntries() {
  const docs = await listCollection("queue_entries");
  return docs.map(normalizeQueueEntry);
}

async function fetchQueueEntry(id) {
  const doc = await getDocument("queue_entries", id);
  return normalizeQueueEntry(doc);
}

// Force the seated invariants (status = seated, has_arrived = true, seated IST
// populated) used by both the owner "Seat" action and any rating submission.
function markSeated(updates) {
  const now = Date.now();
  updates.status = "seated";
  updates.has_arrived = true;
  if (!updates.arrived_at) updates.arrived_at = now;
  if (!updates.arrived_time_ist) updates.arrived_time_ist = formatIST(updates.arrived_at);
  if (!updates.seated_at) updates.seated_at = now;
  if (!updates.seated_time_ist) updates.seated_time_ist = formatIST(updates.seated_at);
  return updates;
}

// Merge Firestore queue entries with the in-memory ticket store. In-memory
// entries win on id collisions so local writes are never shadowed by stale copies.
function allQueueEntries(firestoreEntries) {
  const byId = {};
  for (const entry of (firestoreEntries || [])) {
    const normalized = normalizeQueueEntry(entry);
    if (normalized && normalized.id) byId[normalized.id] = normalized;
  }
  for (const entry of Object.values(global._tickets || {})) {
    const normalized = normalizeQueueEntry(entry);
    if (normalized && normalized.id) byId[normalized.id] = normalized;
  }
  return Object.values(byId);
}

async function safeCommit(writes) {
  try {
    return await commitWrites(writes);
  } catch (error) {
    if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
      console.warn("Firestore write skipped (demo/unconfigured mode):", error.status);
      return null;
    }
    throw error;
  }
}

// Raw restaurant lookup that preserves password_hash for write-backs, falling
// back to fallback seeds and Founder-added custom restaurants when Firestore is unavailable.
async function getRawRestaurant(id) {
  try {
    const doc = await getDocument("restaurants", id);
    if (doc) {
      const pwdMap = global._pwdMap || {};
      if (pwdMap[id]) {
        return { ...doc, ...pwdMap[id] };
      }
      return doc;
    }
  } catch (error) {
    if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
      // fall through to in-memory sources below
    } else {
      throw error;
    }
  }
  const fb = fallbackRestaurants.find(r => r.id === id);
  if (fb) return { ...fb, ...(global._pwdMap?.[id] || {}) };
  const custom = (global._customRestaurants || []).find(r => r.id === id);
  if (custom) return { ...custom, ...(global._pwdMap?.[id] || {}) };
  return null;
}

function publicRestaurant(r) {
  const merged = { ...r, ...(global._pwdMap?.[r.id] || {}) };
  delete merged.password_hash;
  return merged;
}

async function ensureRestaurants() {
  const deleted = global._deletedRestaurantIds || [];
  const pwdMap = global._pwdMap || {};
  const publicFallback = fallbackRestaurants.map(r => publicRestaurant({ ...r, ...(pwdMap[r.id] || {}) }));
  const publicCustom = (global._customRestaurants || [])
    .filter(r => !deleted.includes(r.id))
    .map(r => publicRestaurant({ ...r, ...(pwdMap[r.id] || {}) }));
  let firestorePublic = [];
  try {
    const docs = await listCollection("restaurants");
    firestorePublic = docs.filter(r => !deleted.includes(r.id)).map(publicRestaurant);
  } catch (error) {
    if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error;
  }
  const byId = {};
  for (const r of [...publicFallback, ...publicCustom]) byId[r.id] = r;
  for (const r of firestorePublic) byId[r.id] = r; // Firestore wins when reachable
  // Ensure every default venue carries its assigned meal_times even when the
  // Firestore document was created without them (keeps customer filters
  // and the wait engine deterministic across local + production).
  const fallbackMeals = {};
  for (const r of publicFallback) {
    if (r.meal_times && r.meal_times.length) fallbackMeals[r.id] = r.meal_times;
  }
  for (const r of Object.values(byId)) {
    if (!r.meal_times || r.meal_times.length === 0) {
      r.meal_times = fallbackMeals[r.id] || ["Lunch", "Dinner"];
    }
  }
  if (!firestorePublic.length && !global._customRestaurants.length) {
    try {
      await safeCommit(fallbackRestaurants.map(restaurant => setDocument("restaurants", restaurant.id, restaurant)));
    } catch { /* best-effort seed; in-memory fallback already covers it */ }
  }
  return Object.values(byId).filter(r => !deleted.includes(r.id));
}

const PROTO_PROFILES = {
  "rest-1": { rush: [[8,11],[18,22]], peakP: [4,7], peakW: [22,34], offP: [2,3], offW: [12,18] },
  "rest-2": { rush: [[12,15],[19,23]], peakP: [5,8], peakW: [28,42], offP: [2,2], offW: [14,14] },
  "rest-3": { rush: [[19,25]], peakP: [6,9], peakW: [20,32], offP: [0,1], offW: [0,6] },
  "rest-4": { rush: [[17,24]], peakP: [4,7], peakW: [30,48], offP: [0,0], offW: [0,0] },
  "rest-5": { rush: [[9,11],[16,20]], peakP: [3,6], peakW: [10,18], offP: [1,1], offW: [5,5] },
  "rest-6": { rush: [[13,15],[20,22.5]], peakP: [3,5], peakW: [24,36], offP: [0,0], offW: [0,0] },
  "rest-7": { rush: [[12,15.5]], peakP: [6,9], peakW: [32,45], offP: [1,2], offW: [8,12] },
  "rest-8": { rush: [[8,11.5],[16,19]], peakP: [3,5], peakW: [12,20], offP: [0,0], offW: [0,0] },
  "rest-9": { rush: [[17,22]], peakP: [5,8], peakW: [25,38], offP: [2,2], offW: [10,10] },
  "rest-10": { rush: [[18,24]], peakP: [5,8], peakW: [16,26], offP: [0,0], offW: [0,0] },
  "rest-11": { rush: [[17,22]], peakP: [4,7], peakW: [12,20], offP: [0,1], offW: [3,8] },
  "rest-12": { rush: [[18,23]], peakP: [3,6], peakW: [18,30], offP: [1,2], offW: [8,14] }
};

function hashProfile(id) {
  let h = 0; for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0;
  const windows = [[[8,11],[18,22]],[[12,15],[19,23]],[[19,25]],[[17,24]],[[9,11],[16,20]]];
  return { rush: windows[h % windows.length], peakP: [3,6], peakW: [18,30], offP: [1,2], offW: [6,12] };
}

const VALID_MEAL_TIMES = ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"];

const MEAL_RUSH_WINDOWS = {
  Breakfast: [[7, 11]],
  Lunch: [[12, 15]],
  Snacks: [[15, 17]],
  Dinner: [[18, 22]],
  "Late Night": [[22, 26]]
};

function rushWindowsForMealTimes(mealTimes) {
  const windows = [];
  for (const m of (mealTimes || [])) {
    if (MEAL_RUSH_WINDOWS[m]) windows.push(...MEAL_RUSH_WINDOWS[m]);
  }
  return windows.length ? windows : null;
}

function normalizeMealTimes(mealTimes) {
  if (!Array.isArray(mealTimes) || mealTimes.length === 0) return ["Lunch", "Dinner"];
  const cleaned = mealTimes.filter(m => VALID_MEAL_TIMES.includes(m));
  return cleaned.length ? cleaned : ["Lunch", "Dinner"];
}

// ---------------------------------------------------------------------------
// AI host seating engine (mirror of server.py) + Mumbai ghost-queue simulator
// ---------------------------------------------------------------------------

const GHOST_NAMES_JS = [
  "Aarav Patel", "Diya Sharma", "Vihaan Singh", "Ananya Reddy", "Kabir Nair",
  "Myra Desai", "Ishaan Mehta", "Zoya Khan", "Reyansh Iyer", "Aanya Joshi",
  "Arjun Malhotra", "Kiara Verma", "Advait Rao", "Saanvi Pillai", "Raghav Menon",
];

// Mumbai IST peak windows: Lunch 13:00-15:00, Snacks 17:30-19:00, Dinner 20:00-22:30
function isMumbaiPeakWindow() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const t = d.getHours() * 60 + d.getMinutes();
  return [[13 * 60, 15 * 60], [17 * 60 + 30, 19 * 60], [20 * 60, 22 * 60 + 30]].some(([s, e]) => t >= s && t < e);
}

function calculateRealisticDuration(baseMinutes, partySize) {
  const sizeBuffer = partySize > 2 ? (partySize - 2) * 10 : 0;
  const variance = Math.floor(Math.random() * 31) - 10; // -10 .. +20
  return Math.max(30, baseMinutes + sizeBuffer + variance);
}

function defaultTables(n) {
  n = Math.max(1, Number(n || 1));
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ id: `T${i}`, seats: i % 2 === 1 ? 2 : 4, freeAt: null });
  return out;
}

// Seat waiting customers into open tables without mutating the inputs. Real
// customers (is_ghost falsy) are sorted ahead of ghost entries; arrival order
// is preserved within each group. Returns { seated: [...], remaining: [...] }.
function processLiveQueue(queue, availableTables) {
  const ordered = [...queue].sort((a, b) => {
    const ghostA = Number(!!a.is_ghost || !!a.isGhost || a.entry_type === 'ghost');
    const ghostB = Number(!!b.is_ghost || !!b.isGhost || b.entry_type === 'ghost');
    if (ghostA !== ghostB) return ghostA - ghostB;
    return Number(a.joined_at || a.joinedAt || 0) - Number(b.joined_at || b.joinedAt || 0);
  });
  const remaining = [...ordered];
  const seated = [];
  for (const table of [...availableTables].sort((a, b) => a.seats - b.seats)) {
    const i = remaining.findIndex((c) => Number(c.size || 2) <= Number(table.seats));
    if (i !== -1) {
      seated.push({ customer: remaining[i], table });
      remaining.splice(i, 1);
    }
  }
  return { seated, remaining };
}

async function clearAllGhostEntriesJs(restaurantId) {
  let entries = [];
  try { entries = await fetchQueueEntries(); } catch (error) { entries = Object.values(global._tickets || {}); }
  const targets = entries.filter((e) => e.restaurant_id === restaurantId && e.status === 'waiting' && (e.is_ghost || e.isGhost || e.entry_type === 'ghost'));
  const deletes = targets.map((e) => ({ delete: { name: `projects/${PROJECT_ID}/databases/(default)/documents/queue_entries/${encodeSegment(e.id)}` } }));
  if (deletes.length) await safeCommit(deletes);
  for (const e of targets) delete global._tickets[e.id];
  return targets.length;
}

async function runSimulationTick(restaurantId) {
  try {
    const now = Date.now();
    // Fast in-memory guard: skip before any Firestore work if a tick already ran
    // within the 120s cooldown window (prevents back-to-back repeat ticks).
    const lastCached = Number((global._lastSimCache || {})[restaurantId] || 0);
    if (lastCached && now - lastCached < LAST_SIM_COOLDOWN_MS) {
      return { skipped: true, cooldown_remaining: Math.ceil((LAST_SIM_COOLDOWN_MS - (now - lastCached)) / 1000) };
    }
    const restaurant = await getRawRestaurant(restaurantId);
    if (!restaurant) return { skipped: true, error: 'restaurant not found' };
    const last = Number(restaurant.last_simulated_at || 0);
    if (now - last < 60000) {
      return { skipped: true, cooldown_remaining: Math.ceil((60000 - (now - last)) / 1000) };
    }

    // 1. Free expired tables (freeAt <= now)
    const tables = Array.isArray(restaurant.tables) && restaurant.tables.length ? restaurant.tables : defaultTables(restaurant.total_tables || 1);
    let freed = 0;
    for (const t of tables) {
      if (t.freeAt && now >= t.freeAt) { t.freeAt = null; freed++; }
    }

    // 2. Open tables + waiting real customers
    const openTables = tables.filter((t) => !t.freeAt);
    let entries = [];
    try { entries = await fetchQueueEntries(); } catch (error) { entries = Object.values(global._tickets || {}); }
    const waiting = entries
      .filter((e) => e.restaurant_id === restaurantId && e.status === 'waiting' && !e.is_ghost && !e.isGhost && e.entry_type !== 'ghost')
      .sort((a, b) => Number(a.joined_at || 0) - Number(b.joined_at || 0));

    const queue = waiting.map((e) => ({ id: e.id, size: Number(e.party_size || 2), is_ghost: false }));
    const available = openTables.map((t) => ({ id: t.id, seats: Number(t.seats) }));
    const { seated, remaining } = processLiveQueue(queue, available);

    const byId = {};
    for (const e of waiting) byId[e.id] = e;
    const seatedResults = [];
    const basePrep = Number(restaurant.base_prep_time || 12);
    const writes = [];
    for (const { customer, table } of seated) {
      const entry = byId[customer.id];
      const seatedAt = now;
      const actualWait = Math.max(1, Math.floor((seatedAt - Number(entry.joined_at || now)) / 60000));
      const merged = { ...entry, status: 'seated', seated_at: seatedAt, seated_time_ist: formatIST(seatedAt), has_arrived: true, actual_wait_mins: actualWait };
      writes.push(setDocument('queue_entries', customer.id, toNumberedEntry(merged)));
      const t = tables.find((x) => x.id === table.id);
      if (t) t.freeAt = seatedAt + calculateRealisticDuration(basePrep, Number(customer.size)) * 60000;
      seatedResults.push({ ticket_id: customer.id, ticket_number: entry.ticket_number, table_id: table.id, actual_wait_mins: actualWait });
    }

    // 3. Mumbai peak-hour ghost spawn when no tables are open
    const openCount = tables.filter((t) => !t.freeAt).length;
    let ghostsSpawned = 0;
    if (isMumbaiPeakWindow() && openCount === 0) {
      const existingGhosts = entries.filter((e) => e.restaurant_id === restaurantId && e.status === 'waiting' && (e.is_ghost || e.isGhost || e.entry_type === 'ghost')).length;
      const target = 5 + Math.floor(Math.random() * 3); // 5-7
      const toSpawn = Math.max(0, target - existingGhosts);
      for (let i = 0; i < toSpawn; i++) {
        const ghostId = `ghost-${String(now * 1000 + i).slice(-8)}`;
        const ticketNumber = `WM-G${String(Math.floor(now / 1000) % 100000).padStart(5, '0')}`;
        const partySize = 2 + Math.floor(Math.random() * 3);
        const ghostName = GHOST_NAMES_JS[i % GHOST_NAMES_JS.length];
        const ghost = {
          id: ghostId,
          ticket_number: ticketNumber,
          restaurant_id: restaurantId,
          restaurant_name: restaurant.name || '',
          guest_name: ghostName,
          customer_name: ghostName,
          phone: '',
          party_size: partySize,
          seating_pref: 'First Available',
          special_requests: '',
          channel: 'remote',
          entry_type: 'ghost',
          source: 'ai-ghost',
          '09_channel': 'remote',
          status: 'waiting',
          estimated_wait_mins: 1 + Math.floor(Math.random() * 45), // max 45 minutes
          actual_wait_mins: 0,
          joined_at: now,
          joined_time_ist: formatIST(now),
          is_ghost: true,
          isGhost: true,
          notified_at: null,
          seated_at: null,
          has_arrived: false,
          delay_mins: 0,
        };
        writes.push(setDocument('queue_entries', ghostId, toNumberedEntry(ghost)));
        global._tickets[ghostId] = { ...ghost };
        ghostsSpawned++;
      }
    }

    // 4. Persist restaurant state (tables + cooldown) to Firestore
    writes.push(setDocument('restaurants', restaurantId, { ...restaurant, tables, available_tables: openCount, last_simulated_at: now }));
    if (writes.length) await safeCommit(writes);

    // Mirror into the memory cache so Host Stand reads stay consistent
    global._pwdMap = global._pwdMap || {};
    if (!global._pwdMap[restaurantId]) global._pwdMap[restaurantId] = {};
    global._pwdMap[restaurantId].tables = tables;
    global._pwdMap[restaurantId].available_tables = openCount;
    global._pwdMap[restaurantId].last_simulated_at = now;
    global._lastSimCache[restaurantId] = now;

    return {
      skipped: false,
      restaurant_id: restaurantId,
      freed_tables: freed,
      open_tables: openCount,
      seated: seatedResults,
      seated_count: seatedResults.length,
      remaining_count: remaining.length,
      ghosts_spawned: ghostsSpawned,
      simulated_at: now,
    };
  } catch (error) {
    console.error(`simulation tick failed for ${restaurantId}:`, error);
    return { skipped: true, error: String(error.message || error) };
  }
}

// Current 5-minute IST time bucket. Every request within the same bucket
// shares the same bucket key, so all browsers see identical simulated waits.
function istBucket() {
  const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return Math.floor(istNow.getTime() / 300000);
}

// Deterministic seeded pseudo-random value keyed by restaurant.id + bucket.
// No Math.random(): same restaurant + same bucket always yields the same draw.
function seededDraw(key, min, max) {
  let h = 0;
  for (let i = 0; i < String(key).length; i++) h = (h * 31 + String(key).charCodeAt(i)) >>> 0;
  return min + (h % (max - min + 1));
}

function computePrototypeRestaurantMetrics(restaurant, realWaitingParties, realWaitingGuests) {
  const id = restaurant.id;
  const profile = PROTO_PROFILES[id] || hashProfile(id);
  const bucket = istBucket();
  const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const hour = istNow.getHours() + istNow.getMinutes() / 60;
  const mealTimes = Array.isArray(restaurant.meal_times) && restaurant.meal_times.length ? restaurant.meal_times : null;
  const rushWindows = mealTimes ? rushWindowsForMealTimes(mealTimes) : profile.rush;
  const inRush = rushWindows.some(([s, e]) => (s <= e ? (hour >= s && hour < e) : (hour >= s || hour < e)));
  const seed = String(id) + '|' + bucket;
  const rand = (min, max) => seededDraw(seed, min, max);
  const simulatedParties = inRush ? rand(profile.peakP[0], profile.peakP[1]) : rand(profile.offP[0], profile.offP[1]);
  const simulatedWait = inRush ? rand(profile.peakW[0], profile.peakW[1]) : rand(profile.offW[0], profile.offP ? profile.offW[1] : profile.offW[1]);
  const isOpen = Boolean(restaurant.is_queue_open);
  const realP = Number(realWaitingParties || 0);
  const realG = Number(realWaitingGuests || 0);
  const totalActiveParties = isOpen ? (simulatedParties + realP) : 0;
  const osc = (bucket % 3) - 1;
  let estimated = 0;
  if (isOpen) {
    if (restaurant.manual_override_wait !== null && restaurant.manual_override_wait !== undefined) {
      estimated = Math.min(60, Number(restaurant.manual_override_wait));
    } else {
      const basePrep = Number(restaurant.base_prep_time || 10);
      const tables = Number(restaurant.total_tables || 1);
      estimated = Math.max(0, Math.round((totalActiveParties * basePrep * 0.6) + simulatedWait * 0.4 + osc * 2));
      if (totalActiveParties === 0) estimated = 0;
      estimated = Math.min(estimated, 60);
    }
  }
  return {
    queue_count: totalActiveParties,
    total_waiting_people: totalActiveParties * 2 + realG,
    estimated_wait_mins: estimated,
    algorithmic_wait_mins: estimated,
    has_manual_override: restaurant.manual_override_wait !== null && restaurant.manual_override_wait !== undefined,
    is_queue_open: isOpen,
    active_parties: totalActiveParties,
    active_guests: totalActiveParties * 2 + realG
  };
}

async function getLiveStats(restaurant, queueEntries) {
  const active = queueEntries.filter(entry => entry.restaurant_id === restaurant.id && ["waiting", "notified", "delayed"].includes(entry.status));
  const queueCount = active.length;
  const people = active.reduce((sum, entry) => sum + Number(entry.party_size || 0), 0);
  const availableTables = Number(restaurant.available_tables || 0);
  const basePrep = Number(restaurant.base_prep_time || 10);
  const algorithmic = queueCount === 0 ? 0 : Math.max(4, Math.round((Math.max(0, queueCount - availableTables) * basePrep * 0.75) + (availableTables === 0 ? basePrep : 0)));
  const manual = restaurant.manual_override_wait;
  return {
    queue_count: queueCount,
    total_waiting_people: people,
    estimated_wait_mins: manual !== null && manual !== undefined ? Math.min(60, Number(manual)) : algorithmic,
    algorithmic_wait_mins: algorithmic,
    has_manual_override: manual !== null && manual !== undefined,
    is_queue_open: Boolean(restaurant.is_queue_open)
  };
}

async function route(request, response, pathParts) {
  const normalized = pathParts[0] === "api" ? pathParts : ["api", ...pathParts];
  const path = `/${normalized.join("/")}`;
  const body = parseBody(request);

  if (request.method === "OPTIONS") return send(response, 204, {});

  // Diagnostic: reports the active storage backend and live data counts
  if (request.method === "GET" && path === "/api/health/storage") {
    let storage = "in_memory_fallback";
    let reason = "Firebase is not reachable or not configured";
    try {
      await getAccessToken();
      await listCollection("restaurants");
      storage = "firebase_firestore";
      reason = null;
    } catch (error) {
      reason = String(error.message || error || "Firebase unreachable");
    }
    let restaurants = [];
    try { restaurants = await listCollection("restaurants"); } catch { /* ignore */ }
    let entries = [];
    try { entries = await fetchQueueEntries(); } catch { entries = Object.values(global._tickets || {}); }
    const byId = {};
    for (const e of entries) if (e && e.id) byId[e.id] = e;
    for (const e of Object.values(global._tickets || {})) if (e && e.id) byId[e.id] = e;
    const deleted = global._deletedRestaurantIds || [];
    return send(response, 200, {
      storage,
      storage_status: storage === "firebase_firestore" ? "firebase" : "memory",
      reason,
      restaurants: restaurants.filter(r => !deleted.includes(r.id)).length,
      active_queue_entries: Object.values(byId).filter(e => ["waiting", "notified", "delayed"].includes(e.status)).length,
      custom_overrides: (global._customRestaurants || []).filter(r => !deleted.includes(r.id)).length
    });
  }

  if (request.method === "GET" && path === "/api/restaurants") {
    // Lightweight storage-status probe: only verify that Firebase auth is
    // reachable (the access token is cached at module scope, so this is ~free
    // when warm). We deliberately DO NOT do a separate listCollection() probe
    // here — ensureRestaurants() below is the single authoritative restaurants
    // read, so the hot GET path issues one restaurants query, not two.
    let storageStatus = "firebase";
    let storageReason = null;
    try {
      await getAccessToken();
    } catch (error) {
      storageStatus = "memory";
      storageReason = String(error.message || error || "Firebase unreachable").slice(0, 250);
    }
    const restaurants = await ensureRestaurants();
    let firestoreEntries = [];
    try { firestoreEntries = await fetchQueueEntries(); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const queueEntries = allQueueEntries(firestoreEntries);
    // GET stays a fast, non-blocking read: simulation ticks are NOT triggered
    // here. The frontend fires a background POST /api/queue/simulate-tick when
    // a tick is actually due, so customer page loads never block on writes.
    let globalAnnouncement = "";
    try {
      const g = await getDocument("settings", "global_announcement");
      if (g && g.value !== undefined) globalAnnouncement = String(g.value);
    } catch { /* ignore */ }
    const result = [];
    for (const restaurant of restaurants) {
      const realActive = queueEntries.filter(entry => entry.restaurant_id === restaurant.id && ["waiting","notified","delayed"].includes(entry.status));
      const realParties = realActive.length;
      const realGuests = realActive.reduce((s,e)=>s+Number(e.party_size||0),0);
      const liveStats = computePrototypeRestaurantMetrics(restaurant, realParties, realGuests);
      result.push({ ...sanitizeRestaurant(restaurant), live_stats: liveStats, reliability: reliabilityFromRestaurant(restaurant), announcement: restaurant.announcement || '' });
    }
    const body = { 
      restaurants: result,
      global_announcement: globalAnnouncement,
      storage_status: storageReason ? `memory: ${storageReason}` : "firebase",
      storage_backend: storageStatus,
      ...(storageReason ? { storage_error: storageReason, storage_reason: storageReason } : {})
    };
    return send(response, 200, body);
  }

  if (request.method === "GET" && path.startsWith("/api/restaurants/")) {
    const id = normalized[normalized.length - 1];
    const restaurant = await findRestaurantById(id);
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    // GET stays a fast, non-blocking read — no simulation tick here.
    let firestoreEntries = [];
    try { firestoreEntries = await fetchQueueEntries(); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    return send(response, 200, { ...sanitizeRestaurant(restaurant), live_stats: await getLiveStats(restaurant, allQueueEntries(firestoreEntries)), reliability: reliabilityFromRestaurant(restaurant), announcement: restaurant.announcement || '' });
  }

  if (request.method === "POST" && path === "/api/queue/simulate-tick") {
    if (!body.restaurant_id) return send(response, 400, { error: "restaurant_id is required" });
    return send(response, 200, await runSimulationTick(body.restaurant_id));
  }

  if (request.method === "POST" && path === "/api/queue/clear-ghosts") {
    if (!body.restaurant_id) return send(response, 400, { error: "restaurant_id is required" });
    const cleared = await clearAllGhostEntriesJs(body.restaurant_id);
    return send(response, 200, { success: true, cleared, restaurant_id: body.restaurant_id });
  }

  if (request.method === "POST" && path === "/api/host/verify-password") {
    const restaurant = await findRestaurantById(body.restaurant_id);
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    if (!verifyRestaurantPassword(restaurant, body.password)) {
      return send(response, 401, { error: "Incorrect restaurant password." });
    }
    return send(response, 200, { success: true, message: "Access granted." });
  }

  if (request.method === "POST" && path === "/api/queue/join") {
    if (!body.restaurant_id || !String(body.name || "").trim()) return send(response, 400, { error: "Missing required fields" });
    const restaurant = await findRestaurantById(body.restaurant_id);
    if (!restaurant) return send(response, 404, { error: "Invalid restaurant" });
    if (!restaurant.is_queue_open) return send(response, 400, { error: "Queue is currently closed" });

    // Handle background re-sync (_rejoin flag from frontend after cold start)
    if (body._rejoin && body._original_ticket_id) {
      let existingTicket;
      try {
        existingTicket = await fetchQueueEntry(body._original_ticket_id);
      } catch (error) {
        if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
          existingTicket = global._tickets[body._original_ticket_id] || null;
        } else {
          throw error;
        }
      }
      if (existingTicket) {
        // Ticket exists, return it with the same ID
        global._tickets[body._original_ticket_id] = { ...existingTicket };
        return send(response, 200, { success: true, ticket_id: body._original_ticket_id, ticket_number: existingTicket.ticket_number, estimated_wait_mins: existingTicket.estimated_wait_mins ?? 10, message: "Ticket re-synced." });
      }
      // If original ticket truly gone, fall through to create new (but this shouldn't happen with localStorage persistence)
    }

    let firestoreEntries = [];
    try { firestoreEntries = await fetchQueueEntries(); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const entries = allQueueEntries(firestoreEntries);

    // Compute the exact same baseline + live queue calculation that the
    // restaurant discovery card (GET /api/restaurants) shows, so the Digital
    // Boarding Pass starts at the promised wait time instead of snapping down
    // to a hardcoded value on Join Queue.
    const realActive = entries.filter(entry => entry.restaurant_id === body.restaurant_id && ["waiting","notified","delayed"].includes(entry.status));
    const realParties = realActive.length;
    const realGuests = realActive.reduce((sum, entry) => sum + Number(entry.party_size || 0), 0);
    const liveStats = computePrototypeRestaurantMetrics(restaurant, realParties, realGuests);
    const estWait = Number.isFinite(liveStats.estimated_wait_mins) ? liveStats.estimated_wait_mins : 10;

    const revTs = String(9999999999999 - Date.now()).padStart(13, "0");
    const ticketId = `q-${revTs}-${Math.floor(100 + Math.random() * 900)}`;
    const ticketNumber = `WM-${entries.length + 101}`;
    const joinedAt = Date.now();
    const partySize = Number(body.party_size || 2);
    // Entry channel: "walk_in" when the diner is already at the venue (QR/deep
    // link or the in-modal channel selector), otherwise "remote".
    const isWalkin = body.entry_type === "walk_in" || body.entry_type === "walkin" || body.channel === "walk_in";
    const partiesAhead = entries.filter(entry => entry.restaurant_id === body.restaurant_id && ["waiting","notified","delayed"].includes(entry.status) && Number(entry.joined_at) < joinedAt).length;
    const ticket = {
      id: ticketId,
      ticket_number: ticketNumber,
      restaurant_id: body.restaurant_id,
      restaurant_name: restaurant.name || "",
      customer_name: String(body.name).trim(),
      phone: "",
      party_size: partySize,
      seating_pref: body.seating_pref || "First Available",
      special_requests: body.special_requests || "",
      "09_channel": isWalkin ? "walk_in" : "remote",
      channel: isWalkin ? "walk_in" : "remote",
      entry_type: isWalkin ? "walk_in" : "remote",
      source: (isWalkin ? "walk-in" : "remote"),
      status: "waiting",
      estimated_wait_mins: estWait,
      actual_wait_mins: 0,
      joined_at: joinedAt,
      joined_time_ist: new Date(joinedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST',
      notified_at: null,
      arrived_at: isWalkin ? joinedAt : null,
      arrived_time_ist: isWalkin ? new Date(joinedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST' : null,
      seated_at: null,
      seated_time_ist: null,
      has_arrived: isWalkin,
      delay_mins: 0,
      parties_ahead: partiesAhead
    };
    try {
      await safeCommit([setDocument("queue_entries", ticketId, toNumberedEntry(ticket))]);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
        global._tickets[ticketId] = { ...ticket };
      } else {
        throw error;
      }
    }
    global._tickets[ticketId] = global._tickets[ticketId] || { ...ticket };
    return send(response, 200, { success: true, ticket_id: ticketId, ticket_number: ticketNumber, estimated_wait_mins: estWait, parties_ahead: partiesAhead, position_in_line: partiesAhead + 1, message: `Spot confirmed! Your ticket is ${ticketNumber}.` });
  }

  if (request.method === "GET" && path.startsWith("/api/queue/ticket/")) {
    const id = pathParts[pathParts.length - 1];
    let ticket;
    try {
      ticket = await fetchQueueEntry(id);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
        ticket = global._tickets[id] || null;
      } else {
        throw error;
      }
    }
    // Cold-start reconstruction: if ticket not found but query params provide fallback hints,
    // reconstruct a minimal active ticket so the diner's "View Live Pass" never shows 404.
    if (!ticket && request.query) {
      const { restaurant_id, name, party_size, ticket_number } = request.query;
      if (restaurant_id && name) {
        ticket = {
          id,
          ticket_number: ticket_number || `WM-${id.slice(-3)}`,
          restaurant_id,
          customer_name: name,
          phone: "",
          party_size: Number(party_size || 2),
          seating_pref: "First Available",
          special_requests: "",
          entry_type: "remote",
          status: "waiting",
          estimated_wait_mins: 10,
          actual_wait_mins: 0,
          joined_at: Date.now() - 300000,
          notified_at: null,
          seated_at: null,
          has_arrived: false,
          delay_mins: 0
        };
        // Cache for subsequent requests
        global._tickets[id] = { ...ticket };
      }
    }
    if (!ticket) return send(response, 404, { error: "Ticket not found" });
    let restaurant;
    try {
      restaurant = await getDocument("restaurants", ticket.restaurant_id);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
        restaurant = null;
      } else {
        throw error;
      }
    }
    if (!restaurant) {
      restaurant = await findRestaurantById(ticket.restaurant_id).catch(() => null);
    }
    let firestoreEntries = [];
    try { firestoreEntries = await fetchQueueEntries(); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const entries = allQueueEntries(firestoreEntries);
    const ahead = entries.filter(entry => entry.restaurant_id === ticket.restaurant_id && ["waiting", "notified", "delayed"].includes(entry.status) && Number(entry.joined_at) < Number(ticket.joined_at)).length;
    const position = ahead + 1;
    const elapsed = Math.floor((Date.now() - Number(ticket.joined_at || Date.now())) / 60000);
    const remaining = ticket.status === "waiting" || ticket.status === "delayed" ? Math.max(1, Number(ticket.estimated_wait_mins ?? 10) + Number(ticket.delay_mins ?? 0) - elapsed) : 0;
    return send(response, 200, { ...ticket, position_in_line: position, parties_ahead: ahead, estimated_remaining_mins: remaining, is_table_near: ["waiting", "delayed"].includes(ticket.status) && (position <= 2 || remaining <= 7), is_table_ready: ticket.status === "notified", restaurant: restaurant ? { name: restaurant.name, address: restaurant.address, category: restaurant.category, image_url: restaurant.image_url } : null });
  }

  if (request.method === "GET" && path.startsWith("/api/host/queue/")) {
    const id = pathParts[pathParts.length - 1];
    const restaurant = await findRestaurantById(id);
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    const suppliedPwd = request.headers["x-restaurant-password"] || request.query?.password;
    if (!verifyRestaurantPassword(restaurant, suppliedPwd)) return send(response, 401, { error: "Restaurant password required." });
    let firestoreQueue = [];
    try { firestoreQueue = await fetchQueueEntries(); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const queue = allQueueEntries(firestoreQueue);
    const entries = queue.filter(entry => entry.restaurant_id === id).sort((a, b) => Number(a.joined_at || 0) - Number(b.joined_at || 0));
    return send(response, 200, { restaurant: sanitizeRestaurant(restaurant), live_stats: await getLiveStats(restaurant, entries), reliability: reliabilityFallback(), queue: entries.map((entry, index) => { const { phone, ...safe } = entry; return { ...safe, phone: "", position_rank: index + 1, is_table_near: index < 2 && ["waiting", "delayed"].includes(safe.status) }; }) });
  }

  if (request.method === "POST" && path === "/api/founder/verify-password") {
    const provided = String(body.password || "");
    if (provided && hashPassword(provided) === getActiveFounderHash()) {
      return send(response, 200, { success: true, message: "Founder access granted." });
    }
    return send(response, 401, { error: "Incorrect Founder Master Password." });
  }

  if (request.method === "POST" && path === "/api/founder/change-password") {
    if (!verifyFounderPassword(body.current_password)) {
      return send(response, 401, { error: "Current Founder password is incorrect." });
    }
    const nextPwd = String(body.new_password || "").trim();
    if (nextPwd.length < 6) {
      return send(response, 400, { error: "New password must be at least 6 characters." });
    }
    global._founderPwdHash = hashPassword(nextPwd);
    await safeCommit([setDocument("settings", "founder", { password_hash: global._founderPwdHash })]);
    return send(response, 200, { success: true, message: "Founder password updated successfully." });
  }

  if (request.method === "GET" && path === "/api/founder/analytics") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const restaurants = await ensureRestaurants();
    let firestoreEntries = [];
    try { firestoreEntries = await fetchQueueEntries(); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const queueEntries = allQueueEntries(firestoreEntries);
    const active = queueEntries.filter(entry => ["waiting", "notified", "delayed"].includes(entry.status));
    const seated = queueEntries.filter(entry => entry.status === "seated");
    const enriched = [];
    for (const restaurant of restaurants) {
      const realActive = queueEntries.filter(entry => entry.restaurant_id === restaurant.id && ["waiting","notified","delayed"].includes(entry.status));
      const liveStats = computePrototypeRestaurantMetrics(restaurant, realActive.length, realActive.reduce((s,e)=>s+Number(e.party_size||0),0));
      enriched.push({ ...restaurant, live_stats: liveStats, reliability: reliabilityFromRestaurant(restaurant) });
    }
    return send(response, 200, { summary: { total_restaurants: restaurants.length, total_cities: new Set(restaurants.map(r => r.city)).size, cities_list: [...new Set(restaurants.map(r => r.city))], active_parties_in_queue: active.length, active_diners_in_queue: active.reduce((sum, entry) => sum + Number(entry.party_size || 0), 0), total_seated_parties: seated.length, total_seated_diners: seated.reduce((sum, entry) => sum + Number(entry.party_size || 0), 0), platform_avg_reliability: 92 }, restaurants: enriched, recent_queues: queueEntries.slice(-15).reverse().map(({ phone, ...q }) => ({ ...q, phone: "" })), recent_reviews: [] });
  }

  if (request.method === "POST" && path === "/api/queue/action") {
    const body = request.body || {};
    let ticket;
    try {
      ticket = await fetchQueueEntry(body.ticket_id);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
        ticket = global._tickets[body.ticket_id] || null;
      } else {
        throw error;
      }
    }
    let updates = ticket ? { ...ticket } : null;
    if (body.action === "seat_self") {
      if (!ticket) {
        const restId = body.restaurant_id || "rest-1";
        const now = Date.now();
        updates = {
          id: body.ticket_id,
          ticket_number: `WM-${Date.now().toString().slice(-3)}`,
          restaurant_id: restId,
          customer_name: body.customer_name || "Arrived Guest",
          phone: "",
          party_size: 2,
          seating_pref: "First Available",
          special_requests: "",
          entry_type: "remote",
          status: "seated",
          estimated_wait_mins: 8,
          actual_wait_mins: 0,
          joined_at: now - 300000,
          notified_at: null,
          arrived_at: now,
          arrived_time_ist: new Date(now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST',
          seated_at: now,
          seated_time_ist: new Date(now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST',
          has_arrived: true,
          delay_mins: 0,
          rated: false
        };
      } else {
        updates.status = "seated";
        updates.arrived_at = Date.now();
        updates.arrived_time_ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST';
        updates.seated_at = Date.now();
        updates.seated_time_ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST';
        updates.has_arrived = true;
      }
    } else if (body.action === "arrived") {
      if (!ticket) {
        // Cold start: ticket not in memory but diner says they arrived.
        // Return 200 OK with a reconstructed ticket so the frontend never sees "no active ticket".
        const restId = body.restaurant_id || "rest-1";
        const now = Date.now();
        updates = {
          id: body.ticket_id,
          ticket_number: `WM-${Date.now().toString().slice(-3)}`,
          restaurant_id: restId,
          customer_name: body.customer_name || "Arrived Guest",
          phone: "",
          party_size: 2,
          seating_pref: "First Available",
          special_requests: "",
          entry_type: "remote",
          status: "waiting",
          estimated_wait_mins: 8,
          actual_wait_mins: 0,
          joined_at: now - 300000,
          notified_at: null,
          arrived_at: now,
          arrived_time_ist: new Date(now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST',
          seated_at: null,
          seated_time_ist: null,
          has_arrived: true,
          delay_mins: 0
        };
      } else {
        updates.has_arrived = true;
        updates.arrived_at = Date.now();
        updates.arrived_time_ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST';
        // Keep status as "waiting" - customer has arrived but not yet seated
        updates.status = "waiting";
      }
    } else if (body.action === "delay") {
      if (!ticket) {
        // Cold start: create a minimal delayed ticket and return 200 OK
        const restId = body.restaurant_id || "rest-1";
        updates = {
          id: body.ticket_id,
          ticket_number: `WM-${Date.now().toString().slice(-3)}`,
          restaurant_id: restId,
          customer_name: body.customer_name || "Delayed Guest",
          phone: "",
          party_size: 2,
          seating_pref: "First Available",
          special_requests: "",
          entry_type: "remote",
          status: "delayed",
          estimated_wait_mins: 10,
          actual_wait_mins: 0,
          joined_at: Date.now() - 300000,
          notified_at: null,
          seated_at: null,
          has_arrived: false,
          delay_mins: Number(body.minutes || 5)
        };
      } else {
        updates.delay_mins = Number(ticket.delay_mins || 0) + Number(body.minutes || 5);
        updates.status = "delayed";
      }
    } else if (body.action === "cancel") {
      if (!ticket) {
        return send(response, 404, { error: "Ticket not found" });
      }
      updates.status = "cancelled";
    } else if (body.action === "seated") {
      // Diner confirms they've been seated ("I'm at the Venue" post-seating check-in)
      if (!ticket) {
        // Cold start: reconstruct a seated ticket so the diner's pass stays valid
        const restId = body.restaurant_id || "rest-1";
        const now = Date.now();
        updates = {
          id: body.ticket_id,
          ticket_number: `WM-${Date.now().toString().slice(-3)}`,
          restaurant_id: restId,
          customer_name: body.customer_name || "Seated Guest",
          phone: "",
          party_size: 2,
          seating_pref: "First Available",
          special_requests: "",
          entry_type: "remote",
          status: "seated",
          estimated_wait_mins: 8,
          actual_wait_mins: 10,
          joined_at: now - 600000,
          notified_at: null,
          arrived_at: now,
          arrived_time_ist: new Date(now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST',
          seated_at: now,
          seated_time_ist: new Date(now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST',
          has_arrived: true,
          delay_mins: 0
        };
      } else {
        const now = Date.now();
        updates.status = "seated";
        updates.arrived_at = now;
        updates.arrived_time_ist = new Date(now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST';
        updates.seated_at = now;
        updates.seated_time_ist = new Date(now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST';
        updates.has_arrived = true;
        updates.actual_wait_mins = Math.max(1, Math.floor((now - Number(ticket.joined_at || now)) / 60000));
      }
    } else if (body.action === "rate") {
      // Save the post-seating 1-5 star rating and mark the ticket as rated.
      // A submitted rating always implies the party was seated, so enforce the
      // seated invariants here (fixes entries where status stayed "notified"
      // and seated_time_ist stayed null even though a rating was recorded).
      if (!ticket) return send(response, 404, { error: "Ticket not found" });
      // Idempotency: a ticket can only be rated once per visit. If it was
      // already rated (e.g. a duplicate submission while the first request was
      // still in flight), ignore it safely instead of double-counting the
      // reliability_score.
      if (ticket.rated) return send(response, 200, { success: true, message: "Ticket already rated. Duplicate submission ignored.", ticket: ticket });
      const stars = Number(body.rating) || 0;
      if (stars < 1 || stars > 5) return send(response, 400, { error: "Rating must be between 1 and 5" });
      markSeated(updates);
      if (updates.actual_wait_mins === undefined || updates.actual_wait_mins === null) {
        updates.actual_wait_mins = Math.max(1, Math.floor((Date.now() - Number(ticket.joined_at || Date.now())) / 60000));
      }
      updates.rated = true;
      updates.rating = stars;
      updates.comment = String(body.comment || "");
      updates.review_comment = updates.comment;
      updates.rated_at = Date.now();
      updates.rated_time_ist = formatIST(updates.rated_at);
    } else return send(response, 400, { error: "Unknown action" });
    try {
      await safeCommit([setDocument("queue_entries", updates.id, toNumberedEntry(updates))]);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
        console.warn("Firestore write skipped (demo/unconfigured mode):", error.status);
      } else {
        throw error;
      }
    }
    global._tickets[updates.id] = updates;
    return send(response, 200, { success: true, message: "Queue action saved.", ticket: updates });
  }

  if (request.method === "POST" && path === "/api/host/action") {
    const suppliedPwd = request.headers["x-restaurant-password"] || body.password;
    if (body.action === "notify" || body.action === "seat" || body.action === "remove") {
      let ticket;
      try {
        ticket = await fetchQueueEntry(body.ticket_id);
      } catch (error) {
        if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
          ticket = global._tickets[body.ticket_id] || null;
        } else {
          throw error;
        }
      }
      if (!ticket) return send(response, 404, { error: "Ticket not found" });
      const restaurant = await findRestaurantById(ticket.restaurant_id);
      if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
      if (!verifyRestaurantPassword(restaurant, suppliedPwd)) {
        return send(response, 401, { error: "Invalid restaurant password." });
      }
      const updates = { ...ticket };
      if (body.action === "notify") updates.status = "notified", updates.notified_at = Date.now(), updates.notified_time_ist = formatIST(updates.notified_at);
      if (body.action === "seat") { 
        const now = Date.now();
        markSeated(updates);
        updates.actual_wait_mins = Math.max(1, Math.floor((now - Number(ticket.joined_at || now)) / 60000)); 
      }
      if (body.action === "remove") updates.status = "no_show";
      try {
        await safeCommit([setDocument("queue_entries", ticket.id, toNumberedEntry(updates))]);
      } catch (error) {
        if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
          console.warn("Firestore write skipped (demo/unconfigured mode):", error.status);
        } else {
          throw error;
        }
      }
      global._tickets[ticket.id] = updates;
      return send(response, 200, { success: true, message: "Host action saved." });
    }
    if (body.action === "toggle_queue") {
      let restaurant;
      try {
        restaurant = await getRawRestaurant(body.restaurant_id);
      } catch (error) {
        if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
          restaurant = null;
        } else {
          throw error;
        }
      }
      if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
      if (!verifyRestaurantPassword(restaurant, suppliedPwd)) {
        return send(response, 401, { error: "Invalid restaurant password." });
      }
      const newState = Boolean(body.is_open);
      try {
        await safeCommit([setDocument("restaurants", restaurant.id, { ...restaurant, is_queue_open: newState })]);
      } catch (error) {
        if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
          console.warn("Firestore write skipped (demo/unconfigured mode):", error.status);
        } else {
          throw error;
        }
      }
      global._pwdMap = global._pwdMap || {};
      if (!global._pwdMap[restaurant.id]) global._pwdMap[restaurant.id] = {};
      global._pwdMap[restaurant.id].is_queue_open = newState;
      return send(response, 200, { success: true, message: "Queue status updated." });
    }

    if (body.action === "update_announcement") {
      let restaurant;
      try {
        restaurant = await getRawRestaurant(body.restaurant_id);
      } catch (error) {
        if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
          restaurant = null;
        } else {
          throw error;
        }
      }
      if (!restaurant) {
        restaurant = null;
      }
      if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
      if (!verifyRestaurantPassword(restaurant, suppliedPwd)) {
        return send(response, 401, { error: "Invalid restaurant password." });
      }
      const announcement = String(body.announcement || '');
      try {
        await safeCommit([setDocument("restaurants", restaurant.id, { ...restaurant, announcement })]);
      } catch (error) {
        if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
          console.warn("Firestore write skipped (demo/unconfigured mode):", error.status);
        } else {
          throw error;
        }
      }
      global._pwdMap = global._pwdMap || {};
      if (!global._pwdMap[restaurant.id]) global._pwdMap[restaurant.id] = {};
      global._pwdMap[restaurant.id].announcement = announcement;
      return send(response, 200, { success: true, message: "Announcement published.", announcement });
    }

    if (body.action === "update_wait_estimate") {
      let restaurant;
      try {
        restaurant = await getRawRestaurant(body.restaurant_id);
      } catch (error) {
        if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
          restaurant = null;
        } else {
          throw error;
        }
      }
      if (!restaurant) {
        restaurant = null;
      }
      if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
      if (!verifyRestaurantPassword(restaurant, suppliedPwd)) {
        return send(response, 401, { error: "Invalid restaurant password." });
      }
      try {
        await safeCommit([setDocument("restaurants", restaurant.id, { ...restaurant, manual_override_wait: body.manual_wait_mins })]);
      } catch (error) {
        if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
          console.warn("Firestore write skipped (demo/unconfigured mode):", error.status);
        } else {
          throw error;
        }
      }
      global._pwdMap = global._pwdMap || {};
      if (!global._pwdMap[restaurant.id]) global._pwdMap[restaurant.id] = {};
      global._pwdMap[restaurant.id].manual_override_wait = body.manual_wait_mins;
      return send(response, 200, { success: true, message: "Wait time estimate updated." });
    }
    if (body.action === "add_walkin") {
      let restaurant;
      try {
        restaurant = await findRestaurantById(body.restaurant_id);
      } catch (error) {
        if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
          restaurant = null;
        } else {
          throw error;
        }
      }
      if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
      if (!verifyRestaurantPassword(restaurant, suppliedPwd)) return send(response, 401, { error: "Invalid restaurant password." });
      let firestoreWalkinEntries = [];
      try { firestoreWalkinEntries = await fetchQueueEntries(); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
      const entries = allQueueEntries(firestoreWalkinEntries);
      const ticketNumber = `WM-${entries.length + 101}`;
      const revTs2 = String(9999999999999 - Date.now()).padStart(13, "0");
    const ticketId = `q-${revTs2}-${Math.floor(100 + Math.random() * 900)}`;
    const now = Date.now();
    const ticket = { id: ticketId, ticket_number: ticketNumber, restaurant_id: body.restaurant_id, restaurant_name: restaurant.name || "", customer_name: String(body.name || "Walk-in Guest").trim(), guest_name: String(body.name || "Walk-in Guest").trim(), phone: String(body.phone || ""), party_size: Number(body.party_size || 2),     seating_pref: body.seating_pref || "First Available", special_requests: "", "09_channel": "walk_in", channel: "walk_in", entry_type: "walk_in", status: "waiting", estimated_wait_mins: 10, actual_wait_mins: 0, joined_at: now, joined_time_ist: formatIST(now), notified_at: null, arrived_at: now, arrived_time_ist: formatIST(now), seated_at: null, seated_time_ist: null, has_arrived: true, delay_mins: 0 };
      try {
        await safeCommit([setDocument("queue_entries", ticketId, toNumberedEntry(ticket))]);
      } catch (error) {
        if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
          global._tickets[ticketId] = { ...ticket };
        } else {
          throw error;
        }
      }
      global._tickets[ticketId] = global._tickets[ticketId] || { ...ticket };
      return send(response, 200, { success: true, ticket_id: ticketId, ticket_number: ticketNumber, message: "Walk-in guest added." });
    }
    return send(response, 400, { error: "Unknown host action" });
  }

  if (request.method === "POST" && path === "/api/founder/restaurant/toggle") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const body = request.body || {};
    let restaurant;
    try {
      restaurant = await getRawRestaurant(body.restaurant_id);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
        restaurant = null;
      } else {
        throw error;
      }
    }
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    const newState = !Boolean(restaurant.is_queue_open);
    try {
      await safeCommit([setDocument("restaurants", restaurant.id, { ...restaurant, is_queue_open: newState })]);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
        console.warn("Firestore write skipped (demo/unconfigured mode):", error.status);
      } else {
        throw error;
      }
    }
    global._pwdMap = global._pwdMap || {};
    if (!global._pwdMap[restaurant.id]) global._pwdMap[restaurant.id] = {};
    global._pwdMap[restaurant.id].is_queue_open = newState;
    return send(response, 200, { success: true, new_state: newState ? 1 : 0, message: "Restaurant queue state updated." });
  }

  if (request.method === "POST" && path === "/api/founder/restaurant/add") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const name = String(body.name || "").trim();
    const category = String(body.category || "").trim();
    const type = body.type || "restaurant";
    const city = "Mumbai";
    const address = String(body.address || "").trim();
    const priceRange = body.price_range || "₹₹";
    const password = String(body.password || "").trim();
    const totalTables = Number(body.total_tables || 16);
    const basePrepTime = Number(body.base_prep_time || 15);
    const imageUrl = body.image_url || "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80";
    const description = body.description || `Authentic ${category} located in ${city}.`;
    const mealTimes = normalizeMealTimes(body.meal_times);

    if (!name || !address || !password) return send(response, 400, { error: "Restaurant name, address, and owner dashboard password are required." });
    if (password.length < 4) return send(response, 400, { error: "Owner dashboard password must be at least 4 characters." });

    const id = `rest-${Date.now()}`;
    const restaurant = {
      id,
      name,
      category,
      type,
      city,
      address,
      distance_km: 1.0,
      price_range: priceRange,
      meal_times: mealTimes,
      image_url: imageUrl,
      description,
      password_hash: hashPassword(password),
      base_prep_time: basePrepTime,
      available_tables: Math.max(1, Math.floor(totalTables / 4)),
      total_tables: totalTables,
      manual_override_wait: null,
      is_queue_open: true,
      reliability_score: 94,
      created_at: Date.now()
    };

    await safeCommit([setDocument("restaurants", id, restaurant)]);

    global._customRestaurants = global._customRestaurants || [];
    global._pwdMap = global._pwdMap || {};
    global._pwdMap[id] = { password_hash: restaurant.password_hash };
    const publicCopy = { ...restaurant };
    delete publicCopy.password_hash;
    global._customRestaurants.push(publicCopy);

    return send(response, 200, { success: true, restaurant_id: id, message: `Congratulations! '${name}' is now live on WaitMate India.`, restaurant: sanitizeRestaurant(restaurant) });
  }

  if (request.method === "POST" && path === "/api/founder/restaurant/delete") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const restaurantId = body.restaurant_id;
    if (!restaurantId) return send(response, 400, { error: "Missing restaurant_id" });

    // Remove queue entries for this restaurant from Firestore
    try {
      const entries = await fetchQueueEntries();
      const deletes = entries.filter(e => e.restaurant_id === restaurantId).map(e => ({
        delete: { name: `projects/${PROJECT_ID}/databases/(default)/documents/queue_entries/${encodeSegment(e.id)}` }
      }));
      if (deletes.length) await safeCommit(deletes);
    } catch (error) {
      if (!(error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError)) throw error;
    }

    // Remove the restaurant document from Firestore
    try {
      await safeCommit([{ delete: { name: `projects/${PROJECT_ID}/databases/(default)/documents/restaurants/${encodeSegment(restaurantId)}` } }]);
    } catch (error) {
      if (!(error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError)) throw error;
    }

    // Tombstone so deleted venues stay deleted even without Firestore
    global._deletedRestaurantIds = global._deletedRestaurantIds || [];
    if (!global._deletedRestaurantIds.includes(restaurantId)) global._deletedRestaurantIds.push(restaurantId);
    global._customRestaurants = (global._customRestaurants || []).filter(r => r.id !== restaurantId);

    return send(response, 200, { success: true, message: "Restaurant removed from WaitMate Mumbai network." });
  }

  if (request.method === "POST" && (path === "/api/restaurants" || path === "/api/owner/restaurants/create")) {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Unauthorized. Only the Founder can add new restaurants." });
    if (!body.name || !body.category || !body.address) return send(response, 400, { error: "Please provide Restaurant Name, Cuisine Category, and Address." });
    const id = `rest-${Date.now().toString().slice(-6)}`;
    const restaurant = { id, password_hash: hashPassword(body.password || "waitmate123"), name: body.name, category: body.category, type: body.type || "restaurant", city: body.city || "Mumbai", address: body.address, distance_km: 1.0, price_range: body.price_range || "₹₹", meal_times: normalizeMealTimes(body.meal_times), image_url: body.image_url || "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80", description: body.description || "", owner_name: body.owner_name || "Owner", owner_phone: body.owner_phone || "", base_prep_time: Number(body.base_prep_time || 12), available_tables: Math.max(1, Math.floor(Number(body.total_tables || 16) / 4)), total_tables: Number(body.total_tables || 16), manual_override_wait: null, is_queue_open: true, created_at: Date.now() };
    await safeCommit([setDocument("restaurants", id, restaurant)]);

    global._customRestaurants = global._customRestaurants || [];
    global._pwdMap = global._pwdMap || {};
    global._pwdMap[id] = { password_hash: restaurant.password_hash };
    global._customRestaurants.push(sanitizeRestaurant(restaurant));

    return send(response, 200, { success: true, restaurant_id: id, message: `Congratulations! '${body.name}' is now live on WaitMate India.`, restaurant: sanitizeRestaurant(restaurant) });
  }

  if (request.method === "POST" && path === "/api/host/change-password") {
    const restaurant = await findRestaurantById(body.restaurant_id);
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    if (!verifyRestaurantPassword(restaurant, body.current_password)) {
      return send(response, 401, { error: "Current password is incorrect." });
    }
    const nextPwd = String(body.new_password || "").trim();
    if (nextPwd.length < 4) return send(response, 400, { error: "New password must be at least 4 characters." });
    const newHash = hashPassword(nextPwd);
    global._pwdMap = global._pwdMap || {};
    global._pwdMap[restaurant.id] = { ...(global._pwdMap[restaurant.id] || {}), password_hash: newHash };
    await safeCommit([setDocument("restaurants", restaurant.id, { ...restaurant, password_hash: newHash })]);
    return send(response, 200, { success: true, message: "Restaurant password updated successfully." });
  }

  if (request.method === "POST" && path === "/api/founder/restaurant/reset-password") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const restaurant = await findRestaurantById(body.restaurant_id);
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    const nextPwd = String(body.new_password || "").trim();
    if (nextPwd.length < 4) return send(response, 400, { error: "New password must be at least 4 characters." });
    const newHash = hashPassword(nextPwd);
    global._pwdMap = global._pwdMap || {};
    global._pwdMap[restaurant.id] = { ...(global._pwdMap[restaurant.id] || {}), password_hash: newHash };
    await safeCommit([setDocument("restaurants", restaurant.id, { ...restaurant, password_hash: newHash })]);
    return send(response, 200, { success: true, message: "Password reset successfully." });
  }

  if (request.method === "POST" && (path === "/api/feedback" || path === "/api/reliability/feedback")) {
    return send(response, 200, { success: true, message: "Thank you! Your check-in feedback updated the Reliability Score." });
  }

  // POST /api/reviews - Submit a new review
  if (request.method === "POST" && path === "/api/reviews") {
    const { restaurantId, restaurantName, rating, comment } = body;
    if (!restaurantId || !restaurantName || !rating || rating < 1 || rating > 5) {
      return send(response, 400, { error: "Missing required fields: restaurantId, restaurantName, rating (1-5)" });
    }

    const ticketId = body.ticket_id;
    const delta = {5:2,4:0.5,3:-0.5,2:-2,1:-3}[Number(rating)] || 0;
    const now = Date.now();
    const review = {
      id: ticketId || `rev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      restaurant_id: restaurantId,
      restaurant_name: restaurantName,
      rating: Number(rating),
      stars: Number(rating),
      review_comment: String(comment || '').trim(),
      comment: String(comment || '').trim(),
      guest_name: String(body.guest_name || body.name || 'Guest').trim(),
      ticket_id: ticketId || null,
      accuracy_tag: body.accuracy_tag || null,
      rated: true,
      rated_at: now,
      rated_time_ist: new Date(now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST',
      created_at: now
    };
    if (ticketId) {
      try {
        const t = await fetchQueueEntry(ticketId);
        if (t) {
          // Idempotency: a ticket can only be rated once per visit. Ignore
          // duplicate submissions instead of double-counting the score.
          if (t.rated) return send(response, 200, { success: true, message: "Ticket already rated. Duplicate submission ignored.", ticket: t });
          // A submitted rating implies the party was seated: enforce the seated
          // invariants so status/seated_time_ist can never stay "notified"/null.
          const merged = markSeated({ ...t });
          merged.rated = true;
          merged.rating = Number(rating);
          merged.comment = String(comment || '').trim();
          merged.review_comment = merged.comment;
          merged.rated_at = now;
          merged.rated_time_ist = review.rated_time_ist;
          merged.restaurant_name = merged.restaurant_name || restaurantName;
          delete merged.stars; // no duplicate "stars" field in queue_entries
          const numbered = toNumberedEntry(merged);
          await safeCommit([setDocument("queue_entries", ticketId, numbered)]);
          const mem = { ...t, ...merged };
          delete mem.stars;
          global._tickets[ticketId] = mem;
        }
      } catch (e) { console.warn("ticket rating update failed:", e?.message || e); }
      if (global._tickets && global._tickets[ticketId] && !global._tickets[ticketId].rated) global._tickets[ticketId] = { ...global._tickets[ticketId], ...review };
    }
    try {
      const rest = await findRestaurantById(restaurantId);
      if (rest) {
        let entries = [];
        try { entries = await fetchQueueEntries(); } catch (e) {}
        const rated = entries.filter(e => e.restaurant_id === restaurantId && e.rated);
        const ratingCount = rated.length;
        const avgRating = ratingCount ? rated.reduce((s, e) => s + Number(e.rating || e.stars || 0), 0) / ratingCount : 0;
        const recentCheckins = rated.slice(-10).reverse();
        let score = Number(rest.reliability_score || 90) + delta;
        score = Math.max(50, Math.min(99, score));
        const grade = score >= 95 ? "A+" : score >= 90 ? "A" : score >= 80 ? "B" : "C";
        await safeCommit([setDocument("restaurants", rest.id, { ...rest, reliability_score: score, grade, rating_count: ratingCount, average_rating: avgRating, recent_checkins: recentCheckins, recent_reviews: recentCheckins })]);
      }
    } catch (e) { console.warn("restaurant update failed:", e?.message || e); }
    global._reviews = global._reviews || [];
    global._reviews.push(review);
    return send(response, 200, { success: true, message: "Review submitted successfully!", review });
  }

  // GET /api/reviews?restaurantId=... - Fetch reviews for a restaurant
  if (request.method === "GET" && path === "/api/reviews") {
    const restaurantId = request.query?.restaurantId;
    if (!restaurantId) {
      return send(response, 400, { error: "restaurantId query parameter is required" });
    }

    let firestoreReviews = [];
    try {
      const docs = await listCollection("reviews");
      firestoreReviews = docs.filter(r => r.restaurant_id === restaurantId);
    } catch (error) {
      if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error;
    }

    const memoryReviews = (global._reviews || []).filter(r => r.restaurant_id === restaurantId);
    const allReviews = [...firestoreReviews, ...memoryReviews];
    const uniqueReviews = Object.values(allReviews.reduce((acc, r) => { acc[r.id] = r; return acc; }, {}));

    uniqueReviews.sort((a, b) => Number(b.created_at) - Number(a.created_at));

    return send(response, 200, { reviews: uniqueReviews });
  }

  // -----------------------------------------------------------------------
  // Reliability derived from a restaurant record (manual founder overrides
  // stored on the restaurant document win over the algorithmic fallback).
  // -----------------------------------------------------------------------
  function reliabilityFromRestaurant(r) {
    if (!r) return reliabilityFallback();
    if (r.reliability_score !== undefined || r.reliability_grade || r.grade) {
      const score = Math.max(0, Math.min(100, Number(r.reliability_score || 92)));
      const grade = r.reliability_grade || r.grade || (score >= 95 ? "A+" : score >= 90 ? "A" : score >= 80 ? "B" : "C");
      return {
        score,
        grade,
        verdict: r.reliability_verdict || "Founder override",
        badge_color: r.reliability_badge_color || (score >= 85 ? "emerald" : score >= 75 ? "amber" : "rose"),
        avg_variance_mins: r.avg_variance_mins !== undefined ? Number(r.avg_variance_mins) : 2.5,
        total_verified_checkins: Number(r.total_verified_checkins || 0),
        on_time_pct: r.on_time_pct !== undefined ? Number(r.on_time_pct) : 90,
        early_pct: r.early_pct !== undefined ? Number(r.early_pct) : 5,
        slight_late_pct: r.slight_late_pct !== undefined ? Number(r.slight_late_pct) : 5,
        severe_late_pct: r.severe_late_pct !== undefined ? Number(r.severe_late_pct) : 0,
        recent_reviews: Array.isArray(r.recent_reviews) ? r.recent_reviews : []
      };
    }
    return reliabilityFallback();
  }

  // -----------------------------------------------------------------------
  // FOUNDER SUPER-ADMIN ("GOD MODE") ENDPOINTS
  // Every endpoint below is protected with isFounderAuthorized(request).
  // -----------------------------------------------------------------------

  // Full restaurant directory for the Founder edit table (no password hashes)
  if (request.method === "GET" && path === "/api/founder/restaurants") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const restaurants = await ensureRestaurants();
    let firestoreEntries = [];
    try { firestoreEntries = await fetchQueueEntries(); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const queueEntries = allQueueEntries(firestoreEntries);
    const result = restaurants.map(r => {
      const realActive = queueEntries.filter(e => e.restaurant_id === r.id && ["waiting","notified","delayed"].includes(e.status));
      return { ...sanitizeRestaurant(r), live_stats: getLiveStats(r, queueEntries), reliability: reliabilityFromRestaurant(r), announcement: r.announcement || '', active_parties: realActive.length };
    });
    return send(response, 200, { success: true, restaurants: result });
  }

  // Update any restaurant: name, category, type, city, address, price tier,
  // table capacity, dining pace, cover photo, bio, queue state.
  if (request.method === "POST" && path === "/api/founder/restaurant/update") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const restaurantId = body.restaurant_id;
    if (!restaurantId) return send(response, 400, { error: "Missing restaurant_id" });
    let restaurant;
    try {
      restaurant = await getRawRestaurant(restaurantId);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) { restaurant = null; } else { throw error; }
    }
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    const updatable = ["name","category","type","city","address","price_range","image_url","description","total_tables","base_prep_time","is_queue_open","meal_times"];
    const updates = { ...restaurant };
    let changed = false;
    for (const field of updatable) {
      if (body[field] !== undefined) {
        if (field === "meal_times") {
          const normalized = normalizeMealTimes(body[field]);
          updates[field] = normalized;
        } else {
          updates[field] = field === "is_queue_open" ? Boolean(body[field]) : body[field];
        }
        changed = true;
      }
    }
    if (!changed) return send(response, 400, { error: "No updatable fields provided" });
    if (Number.isFinite(Number(updates.total_tables))) updates.available_tables = Math.max(1, Math.floor(Number(updates.total_tables) / 4));
    try {
      await safeCommit([setDocument("restaurants", restaurantId, updates)]);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
        console.warn("Firestore write skipped (demo/unconfigured mode):", error.status);
      } else { throw error; }
    }
    global._pwdMap = global._pwdMap || {};
    if (!global._pwdMap[restaurantId]) global._pwdMap[restaurantId] = {};
    for (const k of ["is_queue_open","manual_override_wait","announcement"]) if (updates[k] !== undefined) global._pwdMap[restaurantId][k] = updates[k];
    return send(response, 200, { success: true, message: "Restaurant updated.", restaurant: sanitizeRestaurant(updates) });
  }

  // Direct override of a restaurant's Reliability Score and Grade
  if (request.method === "POST" && path === "/api/founder/restaurant/reliability") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const restaurantId = body.restaurant_id;
    if (!restaurantId) return send(response, 400, { error: "Missing restaurant_id" });
    let restaurant;
    try {
      restaurant = await getRawRestaurant(restaurantId);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) { restaurant = null; } else { throw error; }
    }
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    const score = Math.max(0, Math.min(100, parseInt(body.score, 10) || 0));
    if (Number.isNaN(score)) return send(response, 400, { error: "Invalid reliability score" });
    const grade = score >= 95 ? "A+" : score >= 90 ? "A" : score >= 80 ? "B" : "C";
    const verdicts = { "A+": "Exceptionally Accurate", "A": "Highly Reliable", "B": "Moderate Variance", "C": "Unpredictable Peak Waits" };
    const badgeColors = { "A+": "emerald", "A": "emerald", "B": "amber", "C": "rose" };
    const updates = {
      ...restaurant,
      reliability_score: score,
      reliability_grade: grade,
      reliability_verdict: body.verdict || verdicts[grade],
      reliability_badge_color: body.badge_color || badgeColors[grade],
      reliability_manual_override: true,
      avg_variance_mins: body.avg_variance_mins !== undefined ? Number(body.avg_variance_mins) : restaurant.avg_variance_mins || 2.5,
      total_verified_checkins: body.total_verified_checkins !== undefined ? Number(body.total_verified_checkins) : restaurant.total_verified_checkins || 0
    };
    try {
      await safeCommit([setDocument("restaurants", restaurantId, updates)]);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
        console.warn("Firestore write skipped (demo/unconfigured mode):", error.status);
      } else { throw error; }
    }
    return send(response, 200, { success: true, message: `Reliability Score overridden to ${score}% (Grade ${grade}).`, reliability: reliabilityFromRestaurant(updates) });
  }

  // Publish / edit / clear a single venue's live announcement
  if (request.method === "POST" && path === "/api/founder/restaurant/announcement") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const restaurantId = body.restaurant_id;
    if (!restaurantId) return send(response, 400, { error: "Missing restaurant_id" });
    let restaurant;
    try {
      restaurant = await getRawRestaurant(restaurantId);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) { restaurant = null; } else { throw error; }
    }
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    const announcement = String(body.announcement === undefined ? "" : body.announcement);
    const updates = { ...restaurant, announcement };
    try {
      await safeCommit([setDocument("restaurants", restaurantId, updates)]);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
        console.warn("Firestore write skipped (demo/unconfigured mode):", error.status);
      } else { throw error; }
    }
    global._pwdMap = global._pwdMap || {};
    if (!global._pwdMap[restaurantId]) global._pwdMap[restaurantId] = {};
    global._pwdMap[restaurantId].announcement = announcement;
    return send(response, 200, { success: true, message: announcement ? "Announcement published." : "Announcement cleared.", announcement });
  }

  // Force-override a restaurant's live estimated wait time
  if (request.method === "POST" && path === "/api/founder/restaurant/manual-wait") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const restaurantId = body.restaurant_id;
    if (!restaurantId) return send(response, 400, { error: "Missing restaurant_id" });
    let restaurant;
    try {
      restaurant = await getRawRestaurant(restaurantId);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) { restaurant = null; } else { throw error; }
    }
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    const manualWait = body.manual_wait_mins === null || body.manual_wait_mins === undefined || body.manual_wait_mins === "" ? null : Number(body.manual_wait_mins);
    if (manualWait !== null && (Number.isNaN(manualWait) || manualWait < 0 || manualWait > 180)) {
      return send(response, 400, { error: "Manual wait must be between 0 and 180 minutes" });
    }
    const updates = { ...restaurant, manual_override_wait: manualWait };
    try {
      await safeCommit([setDocument("restaurants", restaurantId, updates)]);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
        console.warn("Firestore write skipped (demo/unconfigured mode):", error.status);
      } else { throw error; }
    }
    global._pwdMap = global._pwdMap || {};
    if (!global._pwdMap[restaurantId]) global._pwdMap[restaurantId] = {};
    global._pwdMap[restaurantId].manual_override_wait = manualWait;
    return send(response, 200, { success: true, message: manualWait === null ? "Wait estimate reset to algorithmic." : `Wait estimate overridden to ${manualWait} mins.`, manual_override_wait: manualWait });
  }

  // Global network banner shown across all venues
  if (request.method === "POST" && path === "/api/founder/announcement/global") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const value = String(body.announcement === undefined ? "" : body.announcement);
    try {
      await safeCommit([setDocument("settings", "global_announcement", { value, updated_at: Date.now() })]);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
        console.warn("Firestore write skipped (demo/unconfigured mode):", error.status);
      } else { throw error; }
    }
    return send(response, 200, { success: true, message: value ? "Global network banner published." : "Global network banner cleared.", announcement: value });
  }

  // Read runtime settings (global banner, etc.)
  if (request.method === "GET" && path === "/api/founder/settings") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    let settings = [];
    try {
      settings = await listCollection("settings");
    } catch (error) {
      if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error;
    }
    const found = settings.find(s => s.id === "global_announcement");
    return send(response, 200, { success: true, settings, global_announcement: found ? (found.value || "") : "" });
  }

  // Live cross-platform queue stream: every active party across all venues
  if (request.method === "GET" && path === "/api/founder/queues") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    let firestoreEntries = [];
    try { firestoreEntries = await fetchQueueEntries(); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const entries = allQueueEntries(firestoreEntries);
    const restaurants = await ensureRestaurants();
    const byId = {};
    for (const r of restaurants) byId[r.id] = r;
    const active = entries.filter(e => ["waiting","notified","delayed"].includes(e.status));
    const enriched = active.map(e => {
      const r = byId[e.restaurant_id];
      return {
        ...e,
        phone: e.phone || "",
        restaurant_name: (r ? r.name : e.restaurant_name) || "Unknown Venue",
        joined_time_ist: e.joined_time_ist || formatIST(e.joined_at),
        notified_time_ist: e.notified_time_ist || (e.notified_at ? formatIST(e.notified_at) : null),
        arrived_time_ist: e.arrived_time_ist || (e.arrived_at ? formatIST(e.arrived_at) : null),
        seated_time_ist: e.seated_time_ist || (e.seated_at ? formatIST(e.seated_at) : null)
      };
    });
    enriched.sort((a, b) => Number(b.joined_at || 0) - Number(a.joined_at || 0));
    return send(response, 200, { success: true, queues: enriched });
  }

  // Founder queue action on any ticket: notify / seat / remove / edit party size
  if (request.method === "POST" && path === "/api/founder/queue/action") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    let ticket;
    try { ticket = await fetchQueueEntry(body.ticket_id); } catch (error) { if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) { ticket = global._tickets[body.ticket_id] || null; } else { throw error; } }
    if (!ticket) return send(response, 404, { error: "Ticket not found" });
    const updates = { ...ticket };
    if (body.action === "notify") {
      updates.status = "notified";
      updates.notified_at = Date.now();
      updates.notified_time_ist = formatIST(updates.notified_at);
    } else if (body.action === "seat") {
      const now = Date.now();
      markSeated(updates);
      updates.actual_wait_mins = Math.max(1, Math.floor((now - Number(ticket.joined_at || now)) / 60000));
    } else if (body.action === "remove") {
      updates.status = "no_show";
    } else if (body.action === "edit_party_size") {
      const size = Number(body.party_size);
      if (!Number.isFinite(size) || size < 1 || size > 20) return send(response, 400, { error: "Party size must be between 1 and 20" });
      updates.party_size = size;
    } else {
      return send(response, 400, { error: "Unknown queue action" });
    }
    try {
      await safeCommit([setDocument("queue_entries", ticket.id, toNumberedEntry(updates))]);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
        console.warn("Firestore write skipped (demo/unconfigured mode):", error.status);
      } else { throw error; }
    }
    global._tickets[ticket.id] = updates;
    return send(response, 200, { success: true, message: "Queue action updated.", ticket: updates });
  }

  // Clear a venue's active queue (waiting / notified / delayed tickets removed)
  if (request.method === "POST" && path === "/api/founder/queue/clear-venue") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const restaurantId = body.restaurant_id;
    if (!restaurantId) return send(response, 400, { error: "Missing restaurant_id" });
    let firestoreEntries = [];
    try { firestoreEntries = await fetchQueueEntries(); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const entries = allQueueEntries(firestoreEntries);
    const targets = entries.filter(e => e.restaurant_id === restaurantId && ["waiting","notified","delayed"].includes(e.status));
    const deletes = targets.map(e => ({ delete: { name: `projects/${PROJECT_ID}/databases/(default)/documents/queue_entries/${encodeSegment(e.id)}` } }));
    if (deletes.length) await safeCommit(deletes);
    for (const e of targets) delete global._tickets[e.id];
    return send(response, 200, { success: true, message: `Cleared ${targets.length} active ticket(s) from the venue queue.`, cleared: targets.length });
  }

  // Purge test / stale entries: all historical (non-active) queue entries
  if (request.method === "POST" && path === "/api/founder/queue/purge") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    let firestoreEntries = [];
    try { firestoreEntries = await fetchQueueEntries(); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const entries = allQueueEntries(firestoreEntries);
    const targets = entries.filter(e => !["waiting","notified","delayed"].includes(e.status));
    const deletes = targets.map(e => ({ delete: { name: `projects/${PROJECT_ID}/databases/(default)/documents/queue_entries/${encodeSegment(e.id)}` } }));
    if (deletes.length) await safeCommit(deletes);
    for (const e of targets) delete global._tickets[e.id];
    return send(response, 200, { success: true, message: `Purged ${targets.length} stale/test queue entry(ies).`, purged: targets.length });
  }

  // Full network review feed for the Reliability Audit Watchdog
  if (request.method === "GET" && path === "/api/founder/reviews") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    let firestoreReviews = [];
    try {
      const docs = await listCollection("reviews");
      firestoreReviews = docs;
    } catch (error) {
      if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error;
    }
    const memoryReviews = (global._reviews || []);
    const allReviews = [...firestoreReviews, ...memoryReviews];
    const unique = Object.values(allReviews.reduce((acc, r) => { if (r && r.id) acc[r.id] = r; return acc; }, {}));
    unique.sort((a, b) => Number(b.created_at || b.rated_at || 0) - Number(a.created_at || a.rated_at || 0));
    const restaurants = await ensureRestaurants();
    const byId = {};
    for (const r of restaurants) byId[r.id] = r;
    const enriched = unique.map(r => ({ ...r, restaurant_name: (byId[r.restaurant_id] || {}).name || r.restaurant_name || "Unknown Venue" }));
    return send(response, 200, { success: true, reviews: enriched });
  }

  // Delete / hide a review and recalculate the restaurant's Reliability Score
  if (request.method === "DELETE" && path.startsWith("/api/founder/reviews/")) {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const reviewId = path.split("/").pop();
    if (!reviewId) return send(response, 400, { error: "Missing review id" });
    let firestoreReviews = [];
    try {
      const docs = await listCollection("reviews");
      firestoreReviews = docs;
    } catch (error) {
      if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error;
    }
    const target = firestoreReviews.find(r => r.id === reviewId);
    const restaurantId = target ? target.restaurant_id : null;
    const deletes = [];
    if (target) deletes.push({ delete: { name: `projects/${PROJECT_ID}/databases/(default)/documents/reviews/${encodeSegment(reviewId)}` } });
    if (deletes.length) await safeCommit(deletes);
    global._reviews = (global._reviews || []).filter(r => r.id !== reviewId);
    // Also un-rate the linked ticket so it can't be double counted
    if (target && target.ticket_id) {
      try {
        const t = await fetchQueueEntry(target.ticket_id);
        if (t) {
          const unticket = { ...t, rated: false, rating: null, review_comment: "", comment: "", rated_at: null, rated_time_ist: null };
          await safeCommit([setDocument("queue_entries", target.ticket_id, toNumberedEntry(unticket))]);
          global._tickets[target.ticket_id] = unticket;
        }
      } catch (e) { console.warn("un-rate ticket failed:", e?.message || e); }
    }
    // Recalculate Reliability Score from remaining reviews
    if (restaurantId) {
      try {
        const all = await listCollection("reviews");
        const rated = [...(all.filter(r => r.restaurant_id === restaurantId)), ...((global._reviews || []).filter(r => r.restaurant_id === restaurantId))];
        const uniq = Object.values(rated.reduce((acc, r) => { acc[r.id] = r; return acc; }, {}));
        if (uniq.length) {
          const avg = uniq.reduce((s, r) => s + Number(r.rating || 0), 0) / uniq.length;
          const score = Math.max(50, Math.min(99, Math.round(55 + (avg - 1) * 11)));
          const grade = score >= 95 ? "A+" : score >= 90 ? "A" : score >= 80 ? "B" : "C";
          const rest = await findRestaurantById(restaurantId);
          if (rest) {
            await safeCommit([setDocument("restaurants", rest.id, { ...rest, reliability_score: score, reliability_grade: grade, reliability_manual_override: false, total_verified_checkins: uniq.length, average_rating: avg })]);
          }
        }
      } catch (e) { console.warn("recalculate reliability failed:", e?.message || e); }
    }
    return send(response, 200, { success: true, message: "Review deleted and Reliability Score recalculated." });
  }

  // Export full network data (JSON). CSV is rendered client-side from this payload.
  if (request.method === "GET" && path === "/api/founder/export") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const restaurants = await ensureRestaurants().then(list => list.map(sanitizeRestaurant));
    let firestoreEntries = [];
    try { firestoreEntries = await fetchQueueEntries(); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const queueEntries = allQueueEntries(firestoreEntries);
    let firestoreReviews = [];
    try {
      const docs = await listCollection("reviews");
      firestoreReviews = docs;
    } catch (error) {
      if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error;
    }
    const settings = [];
    try { settings = await listCollection("settings"); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) {} }
    const reviews = Object.values([...firestoreReviews, ...((global._reviews || []))].reduce((acc, r) => { if (r && r.id) acc[r.id] = r; return acc; }, {}));
    return send(response, 200, {
      success: true,
      exported_at: new Date().toISOString(),
      exported_at_ist: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST',
      restaurants,
      queue_entries: queueEntries,
      reviews,
      settings
    });
  }

  // Founder impersonation: open any restaurant's Host Stand Dashboard without
  // the restaurant owner password (Founder authorization only).
  if (request.method === "GET" && path.startsWith("/api/founder/host-stand/queue/")) {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const id = pathParts[pathParts.length - 1];
    const restaurant = await findRestaurantById(id);
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    let firestoreQueue = [];
    try { firestoreQueue = await fetchQueueEntries(); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const queue = allQueueEntries(firestoreQueue);
    const entries = queue.filter(entry => entry.restaurant_id === id).sort((a, b) => Number(a.joined_at || 0) - Number(b.joined_at || 0));
    return send(response, 200, {
      restaurant: sanitizeRestaurant(restaurant),
      live_stats: getLiveStats(restaurant, entries),
      reliability: reliabilityFromRestaurant(restaurant),
      announcement: restaurant.announcement || '',
      queue: entries.map((entry, index) => { const { phone, ...safe } = entry; return { ...safe, phone: "", position_rank: index + 1, is_table_near: index < 2 && ["waiting", "delayed"].includes(safe.status) }; })
    });
  }

  return send(response, 404, { error: "Endpoint not found" });
}


function formatIST(ms) {
  return new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }) + " IST";
}
module.exports = async function handler(request, response) {
  if (request.method === "OPTIONS") return send(response, 204, {});

  let pathParts = Array.isArray(request.query?.path)
    ? request.query.path
    : String(request.query?.path || "").split("/").filter(Boolean);

  if (!pathParts.length && request.url) {
    const requestUrl = new URL(request.url, "http://localhost");
    pathParts = requestUrl.pathname.split("/").filter(Boolean);
  }

  try {
    await route(request, response, pathParts);
  } catch (error) {
    console.error("WaitMate API error:", error);
    if (error.status === 503 || error.status === 403) return send(response, 503, { error: "Firebase permissions are not configured yet." });
    if (error.status === 404) return send(response, 503, { error: "Firebase database is not available yet." });
    if (error instanceof SyntaxError) return send(response, 503, { error: "Firebase credentials are malformed." });
    return send(response, 500, { error: error.message || "Unexpected server error." });
  }
};
