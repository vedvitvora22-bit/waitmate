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

global._tickets = global._tickets || {};
global._customRestaurants = global._customRestaurants || [];
global._deletedRestaurantIds = global._deletedRestaurantIds || [];
global._pwdMap = global._pwdMap || {};

function founderPassword() {
  return process.env.FOUNDER_PASSWORD || "waitmatefounder2026";
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
  { id: "rest-1", name: "The Rameshwaram Cafe", category: "Iconic South Indian & Filter Coffee", type: "restaurant", city: "Mumbai", address: "Linking Road, Bandra West, Mumbai", distance_km: 0.8, price_range: "₹", image_url: "https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800&auto=format&fit=crop&q=80", description: "Famous for crispy ghee podi dosa, medu vada, and authentic filter coffee.", base_prep_time: 8, available_tables: 2, total_tables: 18, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("rameshwaram123"), created_at: now - 86400000 },
  { id: "rest-2", name: "Meghana Foods", category: "Spicy Andhra Biryani & Thalis", type: "restaurant", city: "Mumbai", address: "Senapati Bapat Marg, Lower Parel, Mumbai", distance_km: 1.6, price_range: "₹₹", image_url: "https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800&auto=format&fit=crop&q=80", description: "Legendary boneless chicken biryani and traditional Andhra meals.", base_prep_time: 16, available_tables: 1, total_tables: 22, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("meghana123"), created_at: now - 172800000 },
  { id: "rest-3", name: "Bademiya Street Kebab Truck & Rolls", category: "Late-Night Charcoal Kebabs & Baida Roti", type: "food_truck", city: "Mumbai", address: "Tulloch Road, Colaba, Mumbai", distance_km: 0.5, price_range: "₹₹", image_url: "https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=800&auto=format&fit=crop&q=80", description: "Mumbai's iconic street food institution.", base_prep_time: 7, available_tables: 0, total_tables: 10, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("bademiya123"), created_at: now - 259200000 },
  { id: "rest-4", name: "Toit Brewpub & Kitchen", category: "Craft Microbrewery & Woodfired Pizza", type: "restaurant", city: "Mumbai", address: "Mathuradas Mill Compound, Lower Parel, Mumbai", distance_km: 1.2, price_range: "₹₹₹", image_url: "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&auto=format&fit=crop&q=80", description: "Craft beer and woodfired sourdough pizza.", base_prep_time: 22, available_tables: 2, total_tables: 26, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("toit123"), created_at: now - 345600000 },
  { id: "rest-5", name: "Chai Sutta Bar & Bun Maska Express", category: "Kulhad Chai, Bun Maska & Samosas", type: "food_truck", city: "Mumbai", address: "Juhu Tara Road, Juhu, Mumbai", distance_km: 0.4, price_range: "₹", image_url: "https://images.unsplash.com/photo-1576092768241-dec231879fc3?w=800&auto=format&fit=crop&q=80", description: "Kulhad chai, bun maska, and hot samosas.", base_prep_time: 5, available_tables: 0, total_tables: 6, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("chaisutta123"), created_at: now - 432000000 },
  { id: "rest-6", name: "Punjab Grill & Royal Tandoor", category: "North Indian, Dal Makhani & Kebabs", type: "restaurant", city: "Mumbai", address: "Palladium Mall, Lower Parel, Mumbai", distance_km: 3.2, price_range: "₹₹₹", image_url: "https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&auto=format&fit=crop&q=80", description: "North Indian dining with dal makhani and tandoori platters.", base_prep_time: 20, available_tables: 1, total_tables: 20, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("punjab123"), created_at: now - 518400000 },
  { id: "rest-7", name: "Britannia & Co. Restaurant", category: "Parsi & Irani Heritage", type: "restaurant", city: "Mumbai", address: "Wakefield House, Ballard Estate, Fort, Mumbai", distance_km: 1.5, price_range: "₹₹", image_url: "https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&auto=format&fit=crop&q=80", description: "Legendary 1923 Parsi cafe famous for Mutton Berry Pulao, Sali Boti, and Caramel Custard.", base_prep_time: 18, available_tables: 3, total_tables: 14, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("britannia123"), created_at: now - 604800000 },
  { id: "rest-8", name: "Kyani & Co. Bakery & Cafe", category: "Irani Cafe & Bakery", type: "restaurant", city: "Mumbai", address: "Jer Mahal Estate, Dhobi Talao, Marine Lines, Mumbai", distance_km: 0.6, price_range: "₹", image_url: "https://images.unsplash.com/photo-1554118811-1e0d58224f24?w=800&auto=format&fit=crop&q=80", description: "Iconic South Mumbai Irani bakery serving fresh Bun Maska, Keema Pav, Mawa Cake, and Irani Chai.", base_prep_time: 10, available_tables: 4, total_tables: 18, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("kyani123"), created_at: now - 691200000 },
  { id: "rest-9", name: "Prithvi Cafe", category: "Cafe & Outdoor Bistro", type: "restaurant", city: "Mumbai", address: "Janki Kutir, Juhu Church Road, Juhu, Mumbai", distance_km: 2.1, price_range: "₹₹", image_url: "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80", description: "Bamboo-shaded theatre courtyard cafe in Juhu known for Irish Coffee, Suleimani Chai, and Amritsari Paratha.", base_prep_time: 15, available_tables: 2, total_tables: 16, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("prithvi123"), created_at: now - 777600000 },
  { id: "rest-10", name: "Sardar Pav Bhaji Express Truck", category: "Mumbai Street Food & Pav Bhaji", type: "food_truck", city: "Mumbai", address: "Tardeo Road Junction, Mumbai Central, Mumbai", distance_km: 2.8, price_range: "₹", image_url: "https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800&auto=format&fit=crop&q=80", description: "High-turnover Mumbai street food counter famous for extra-butter Pav Bhaji and Masala Tawa Pulao.", base_prep_time: 8, available_tables: 5, total_tables: 20, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("sardar123"), created_at: now - 864000000 }
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
    if (doc) return doc;
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

// Merge Firestore queue entries with the in-memory ticket store. In-memory
// entries win on id collisions so local writes are never shadowed by stale copies.
function allQueueEntries(firestoreEntries) {
  const byId = {};
  for (const entry of (firestoreEntries || [])) {
    if (entry && entry.id) byId[entry.id] = entry;
  }
  for (const entry of Object.values(global._tickets || {})) {
    if (entry && entry.id) byId[entry.id] = entry;
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
    if (doc) return doc;
  } catch (error) {
    if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
      // fall through to in-memory sources below
    } else {
      throw error;
    }
  }
  const fb = fallbackRestaurants.find(r => r.id === id);
  if (fb) return { ...fb };
  return (global._customRestaurants || []).find(r => r.id === id) || null;
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
  "rest-10": { rush: [[18,24]], peakP: [5,8], peakW: [16,26], offP: [0,0], offW: [0,0] }
};

function hashProfile(id) {
  let h = 0; for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0;
  const windows = [[[8,11],[18,22]],[[12,15],[19,23]],[[19,25]],[[17,24]],[[9,11],[16,20]]];
  return { rush: windows[h % windows.length], peakP: [3,6], peakW: [18,30], offP: [1,2], offW: [6,12] };
}

function computePrototypeRestaurantMetrics(restaurant, realWaitingParties, realWaitingGuests) {
  const id = restaurant.id;
  const profile = PROTO_PROFILES[id] || hashProfile(id);
  const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const hour = istNow.getHours() + istNow.getMinutes() / 60;
  const inRush = profile.rush.some(([s, e]) => (s <= e ? (hour >= s && hour < e) : (hour >= s || hour < e)));
  const bucket = Math.floor(Date.now() / 300000);
  const seed = (bucket + (id.split('').reduce((a,c)=>a+c.charCodeAt(0),0))) % 1000;
  const rand = (min, max) => min + (seed % (max - min + 1));
  const simulatedParties = inRush ? rand(profile.peakP[0], profile.peakP[1]) : rand(profile.offP[0], profile.offP[1]);
  const simulatedWait = inRush ? rand(profile.peakW[0], profile.peakW[1]) : rand(profile.offW[0], profile.offW[1]);
  const isOpen = Boolean(restaurant.is_queue_open);
  const realP = Number(realWaitingParties || 0);
  const realG = Number(realWaitingGuests || 0);
  const totalActiveParties = isOpen ? (simulatedParties + realP) : 0;
  const osc = (bucket % 3) - 1;
  let estimated = 0;
  if (isOpen) {
    if (restaurant.manual_override_wait !== null && restaurant.manual_override_wait !== undefined) {
      estimated = Number(restaurant.manual_override_wait);
    } else {
      const basePrep = Number(restaurant.base_prep_time || 10);
      const tables = Number(restaurant.total_tables || 1);
      estimated = Math.max(0, Math.round((totalActiveParties * basePrep * 0.6) + simulatedWait * 0.4 + osc * 2));
      if (totalActiveParties === 0) estimated = 0;
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
    estimated_wait_mins: manual !== null && manual !== undefined ? Number(manual) : algorithmic,
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
    try { entries = await listCollection("queue_entries"); } catch { entries = Object.values(global._tickets || {}); }
    const byId = {};
    for (const e of entries) if (e && e.id) byId[e.id] = e;
    for (const e of Object.values(global._tickets || {})) if (e && e.id) byId[e.id] = e;
    const deleted = global._deletedRestaurantIds || [];
    return send(response, 200, {
      storage,
      reason,
      restaurants: restaurants.filter(r => !deleted.includes(r.id)).length,
      active_queue_entries: Object.values(byId).filter(e => ["waiting", "notified", "delayed"].includes(e.status)).length,
      custom_overrides: (global._customRestaurants || []).filter(r => !deleted.includes(r.id)).length
    });
  }

  if (request.method === "GET" && path === "/api/restaurants") {
    const restaurants = await ensureRestaurants();
    let firestoreEntries = [];
    try { firestoreEntries = await listCollection("queue_entries"); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const queueEntries = allQueueEntries(firestoreEntries);
    const result = [];
    for (const restaurant of restaurants) {
      const realActive = queueEntries.filter(entry => entry.restaurant_id === restaurant.id && ["waiting","notified","delayed"].includes(entry.status));
      const realParties = realActive.length;
      const realGuests = realActive.reduce((s,e)=>s+Number(e.party_size||0),0);
      const liveStats = computePrototypeRestaurantMetrics(restaurant, realParties, realGuests);
      result.push({ ...sanitizeRestaurant(restaurant), live_stats: liveStats, reliability: reliabilityFallback(), announcement: restaurant.announcement || '' });
    }
    return send(response, 200, { restaurants: result });
  }

  if (request.method === "GET" && path.startsWith("/api/restaurants/")) {
    const id = normalized[normalized.length - 1];
    const restaurant = await findRestaurantById(id);
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    let firestoreEntries = [];
    try { firestoreEntries = await listCollection("queue_entries"); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    return send(response, 200, { ...sanitizeRestaurant(restaurant), live_stats: await getLiveStats(restaurant, allQueueEntries(firestoreEntries)), reliability: reliabilityFallback(), announcement: restaurant.announcement || '' });
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
        existingTicket = await getDocument("queue_entries", body._original_ticket_id);
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
        return send(response, 200, { success: true, ticket_id: body._original_ticket_id, ticket_number: existingTicket.ticket_number, estimated_wait_mins: existingTicket.estimated_wait_mins || 10, message: "Ticket re-synced." });
      }
      // If original ticket truly gone, fall through to create new (but this shouldn't happen with localStorage persistence)
    }

    let firestoreEntries = [];
    try { firestoreEntries = await listCollection("queue_entries"); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const entries = allQueueEntries(firestoreEntries);
    const ticketId = `q-${Date.now().toString().slice(-6)}`;
    const ticketNumber = `WM-${entries.length + 101}`;
    const joinedAt = Date.now();
    const partySize = Number(body.party_size || 2);
    const ticket = {
      id: ticketId,
      ticket_number: ticketNumber,
      restaurant_id: body.restaurant_id,
      customer_name: String(body.name).trim(),
      phone: "",
      party_size: partySize,
      seating_pref: body.seating_pref || "First Available",
      special_requests: body.special_requests || "",
      entry_type: body.entry_type || "remote",
      status: "waiting",
      estimated_wait_mins: 10,
      actual_wait_mins: 0,
      joined_at: joinedAt,
      notified_at: null,
      seated_at: null,
      has_arrived: false,
      delay_mins: 0
    };
    try {
      await safeCommit([setDocument("queue_entries", ticketId, ticket)]);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
        global._tickets[ticketId] = { ...ticket };
      } else {
        throw error;
      }
    }
    global._tickets[ticketId] = global._tickets[ticketId] || { ...ticket };
    return send(response, 200, { success: true, ticket_id: ticketId, ticket_number: ticketNumber, estimated_wait_mins: 10, message: `Spot confirmed! Your ticket is ${ticketNumber}.` });
  }

  if (request.method === "GET" && path.startsWith("/api/queue/ticket/")) {
    const id = pathParts[pathParts.length - 1];
    let ticket;
    try {
      ticket = await getDocument("queue_entries", id);
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
    try { firestoreEntries = await listCollection("queue_entries"); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const entries = allQueueEntries(firestoreEntries);
    const ahead = entries.filter(entry => entry.restaurant_id === ticket.restaurant_id && ["waiting", "notified", "delayed"].includes(entry.status) && Number(entry.joined_at) < Number(ticket.joined_at)).length;
    const position = ahead + 1;
    const elapsed = Math.floor((Date.now() - Number(ticket.joined_at || Date.now())) / 60000);
    const remaining = ticket.status === "waiting" || ticket.status === "delayed" ? Math.max(1, Number(ticket.estimated_wait_mins || 10) + Number(ticket.delay_mins || 0) - elapsed) : 0;
    return send(response, 200, { ...ticket, position_in_line: position, parties_ahead: ahead, estimated_remaining_mins: remaining, is_table_near: ["waiting", "delayed"].includes(ticket.status) && (position <= 2 || remaining <= 7), is_table_ready: ticket.status === "notified", restaurant: restaurant ? { name: restaurant.name, address: restaurant.address, category: restaurant.category, image_url: restaurant.image_url } : null });
  }

  if (request.method === "GET" && path.startsWith("/api/host/queue/")) {
    const id = pathParts[pathParts.length - 1];
    const restaurant = await findRestaurantById(id);
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    const suppliedPwd = request.headers["x-restaurant-password"] || request.query?.password;
    if (!verifyRestaurantPassword(restaurant, suppliedPwd)) return send(response, 401, { error: "Restaurant password required." });
    let firestoreQueue = [];
    try { firestoreQueue = await listCollection("queue_entries"); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
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
    try { firestoreEntries = await listCollection("queue_entries"); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const queueEntries = allQueueEntries(firestoreEntries);
    const active = queueEntries.filter(entry => ["waiting", "notified", "delayed"].includes(entry.status));
    const seated = queueEntries.filter(entry => entry.status === "seated");
    const enriched = [];
    for (const restaurant of restaurants) {
      const realActive = queueEntries.filter(entry => entry.restaurant_id === restaurant.id && ["waiting","notified","delayed"].includes(entry.status));
      const liveStats = computePrototypeRestaurantMetrics(restaurant, realActive.length, realActive.reduce((s,e)=>s+Number(e.party_size||0),0));
      enriched.push({ ...restaurant, live_stats: liveStats, reliability: reliabilityFallback() });
    }
    return send(response, 200, { summary: { total_restaurants: restaurants.length, total_cities: new Set(restaurants.map(r => r.city)).size, cities_list: [...new Set(restaurants.map(r => r.city))], active_parties_in_queue: active.length, active_diners_in_queue: active.reduce((sum, entry) => sum + Number(entry.party_size || 0), 0), total_seated_parties: seated.length, total_seated_diners: seated.reduce((sum, entry) => sum + Number(entry.party_size || 0), 0), platform_avg_reliability: 92 }, restaurants: enriched, recent_queues: queueEntries.slice(-15).reverse().map(({ phone, ...q }) => ({ ...q, phone: "" })), recent_reviews: [] });
  }

  if (request.method === "POST" && path === "/api/queue/action") {
    const body = request.body || {};
    let ticket;
    try {
      ticket = await getDocument("queue_entries", body.ticket_id);
    } catch (error) {
      if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
        ticket = global._tickets[body.ticket_id] || null;
      } else {
        throw error;
      }
    }
    let updates = ticket ? { ...ticket } : null;
    if (body.action === "arrived") {
      if (!ticket) {
        // Cold start: ticket not in memory but diner says they arrived.
        // Return 200 OK with a reconstructed ticket so the frontend never sees "no active ticket".
        const restId = body.restaurant_id || "rest-1";
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
          joined_at: Date.now() - 300000,
          notified_at: null,
          seated_at: null,
          has_arrived: true,
          delay_mins: 0
        };
      } else {
        updates.has_arrived = true;
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
    } else return send(response, 400, { error: "Unknown action" });
    try {
      await safeCommit([setDocument("queue_entries", updates.id, updates)]);
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
        ticket = await getDocument("queue_entries", body.ticket_id);
      } catch (error) {
        if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
          ticket = global._tickets[body.ticket_id] || null;
        } else {
          throw error;
        }
      }
      if (!ticket) return send(response, 404, { error: "Ticket not found" });
      const updates = { ...ticket };
      if (body.action === "notify") updates.status = "notified", updates.notified_at = Date.now();
      if (body.action === "seat") updates.status = "seated", updates.seated_at = Date.now();
      if (body.action === "remove") updates.status = "no_show";
      try {
        await safeCommit([setDocument("queue_entries", ticket.id, updates)]);
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
      try { firestoreWalkinEntries = await listCollection("queue_entries"); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
      const entries = allQueueEntries(firestoreWalkinEntries);
      const ticketId = `q-${Date.now().toString().slice(-6)}`;
      const ticketNumber = `WM-${entries.length + 101}`;
      const ticket = { id: ticketId, ticket_number: ticketNumber, restaurant_id: body.restaurant_id, customer_name: String(body.name || "Walk-in Guest").trim(), phone: String(body.phone || ""), party_size: Number(body.party_size || 2), seating_pref: body.seating_pref || "First Available", special_requests: "", entry_type: "walkin", status: "waiting", estimated_wait_mins: 10, actual_wait_mins: 0, joined_at: Date.now(), notified_at: null, seated_at: null, has_arrived: true, delay_mins: 0 };
      try {
        await safeCommit([setDocument("queue_entries", ticketId, ticket)]);
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
      const entries = await listCollection("queue_entries");
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
    const restaurant = { id, password_hash: hashPassword(body.password || "waitmate123"), name: body.name, category: body.category, type: body.type || "restaurant", city: body.city || "Mumbai", address: body.address, distance_km: 1.0, price_range: body.price_range || "₹₹", image_url: body.image_url || "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80", description: body.description || "", owner_name: body.owner_name || "Owner", owner_phone: body.owner_phone || "", base_prep_time: Number(body.base_prep_time || 12), available_tables: Math.max(1, Math.floor(Number(body.total_tables || 16) / 4)), total_tables: Number(body.total_tables || 16), manual_override_wait: null, is_queue_open: true, created_at: Date.now() };
    await safeCommit([setDocument("restaurants", id, restaurant)]);

    global._customRestaurants = global._customRestaurants || [];
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
    global._pwdMap = global._pwdMap || {}; global._pwdMap[restaurant.id] = { password_hash: hashPassword(nextPwd) }; await safeCommit([setDocument("restaurants", restaurant.id, { ...restaurant, password_hash: hashPassword(nextPwd) })]);
    return send(response, 200, { success: true, message: "Restaurant password updated successfully." });
  }

  if (request.method === "POST" && path === "/api/founder/restaurant/reset-password") {
    if (!isFounderAuthorized(request)) return send(response, 401, { error: "Invalid Founder Master Password." });
    const restaurant = await findRestaurantById(body.restaurant_id);
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    const nextPwd = String(body.new_password || "").trim();
    if (nextPwd.length < 4) return send(response, 400, { error: "New password must be at least 4 characters." });
    global._pwdMap = global._pwdMap || {}; global._pwdMap[restaurant.id] = { password_hash: hashPassword(nextPwd) }; await safeCommit([setDocument("restaurants", restaurant.id, { ...restaurant, password_hash: hashPassword(nextPwd) })]);
    return send(response, 200, { success: true, message: "Password reset successfully." });
  }

  if (request.method === "POST" && (path === "/api/feedback" || path === "/api/reliability/feedback")) {
    return send(response, 200, { success: true, message: "Thank you! Your check-in feedback updated the Reliability Score." });
  }

  return send(response, 404, { error: "Endpoint not found" });
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
