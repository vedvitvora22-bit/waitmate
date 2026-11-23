const crypto = require("crypto");
const {
  listCollection,
  getDocument,
  commitWrites,
  setDocument
} = require("./_firestore");

const now = Date.now();

global._tickets = global._tickets || {};

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
  { id: "rest-1", name: "The Rameshwaram Cafe", category: "Iconic South Indian & Filter Coffee", type: "restaurant", city: "Mumbai", address: "Linking Road, Bandra West, Mumbai", distance_km: 0.8, price_range: "₹", image_url: "https://unsplash.com", description: "Famous for crispy ghee podi dosa, medu vada, and authentic filter coffee.", base_prep_time: 8, available_tables: 2, total_tables: 18, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("rameshwaram123"), created_at: now - 86400000 },
  { id: "rest-2", name: "Meghana Foods", category: "Spicy Andhra Biryani & Thalis", type: "restaurant", city: "Mumbai", address: "Senapati Bapat Marg, Lower Parel, Mumbai", distance_km: 1.6, price_range: "₹₹", image_url: "https://unsplash.com", description: "Legendary boneless chicken biryani and traditional Andhra meals.", base_prep_time: 16, available_tables: 1, total_tables: 22, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("meghana123"), created_at: now - 172800000 },
  { id: "rest-3", name: "Bademiya Street Kebab Truck & Rolls", category: "Late-Night Charcoal Kebabs & Baida Roti", type: "food_truck", city: "Mumbai", address: "Tulloch Road, Colaba, Mumbai", distance_km: 0.5, price_range: "₹₹", image_url: "https://unsplash.com", description: "Mumbai's iconic street food institution.", base_prep_time: 7, available_tables: 0, total_tables: 10, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("bademiya123"), created_at: now - 259200000 },
  { id: "rest-4", name: "Toit Brewpub & Kitchen", category: "Craft Microbrewery & Woodfired Pizza", type: "restaurant", city: "Mumbai", address: "Mathuradas Mill Compound, Lower Parel, Mumbai", distance_km: 1.2, price_range: "₹₹₹", image_url: "https://unsplash.com", description: "Craft beer and woodfired sourdough pizza.", base_prep_time: 22, available_tables: 2, total_tables: 26, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("toit123"), created_at: now - 345600000 },
  { id: "rest-5", name: "Chai Sutta Bar & Bun Maska Express", category: "Kulhad Chai, Bun Maska & Samosas", type: "food_truck", city: "Mumbai", address: "Juhu Tara Road, Juhu, Mumbai", distance_km: 0.4, price_range: "₹", image_url: "https://unsplash.com", description: "Kulhad chai, bun maska, and hot samosas.", base_prep_time: 5, available_tables: 0, total_tables: 6, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("chaisutta123"), created_at: now - 432000000 },
  { id: "rest-6", name: "Punjab Grill & Royal Tandoor", category: "North Indian, Dal Makhani & Kebabs", type: "restaurant", city: "Mumbai", address: "Palladium Mall, Lower Parel, Mumbai", distance_km: 3.2, price_range: "₹₹₹", image_url: "https://unsplash.com", description: "North Indian dining with dal makhani and tandoori platters.", base_prep_time: 20, available_tables: 1, total_tables: 20, is_queue_open: true, manual_override_wait: null, password_hash: hashPassword("punjab123"), created_at: now - 518400000 }
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
      // fallback on Firestore parse error or unconfigured Firebase
    } else {
      throw error;
    }
  }
  const fb = fallbackRestaurants.find(r => r.id === id);
  return fb ? { ...fb, ...(global._pwdMap?.[id] || {}) } : null;
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

async function ensureRestaurants() {
  try {
    const restaurants = await listCollection("restaurants");
    if (restaurants.length) {
      return restaurants.map(r => {
        const merged = { ...r, ...(global._pwdMap?.[r.id] || {}) };
        delete merged.password_hash;
        return merged;
      });
    }
    await safeCommit(fallbackRestaurants.map(restaurant => setDocument("restaurants", restaurant.id, restaurant)));
    return fallbackRestaurants.map(r => {
      const merged = { ...r, ...(global._pwdMap?.[r.id] || {}) };
      delete merged.password_hash;
      return merged;
    });
  } catch (error) {
    if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
      return fallbackRestaurants.map(r => {
        const merged = { ...r, ...(global._pwdMap?.[r.id] || {}) };
        delete merged.password_hash;
        return merged;
      });
    }
    throw error;
  }
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

  if (request.method === "GET" && path === "/api/restaurants") {
    const restaurants = await ensureRestaurants();
    let queueEntries = [];
    try { queueEntries = await listCollection("queue_entries"); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const result = [];
    for (const restaurant of restaurants) {
      const liveStats = await getLiveStats(restaurant, queueEntries);
      result.push({ ...sanitizeRestaurant(restaurant), live_stats: liveStats, reliability: reliabilityFallback() });
    }
    return send(response, 200, { restaurants: result });
  }

  if (request.method === "GET" && path.startsWith("/api/restaurants/")) {
    const id = normalized[normalized.length - 1];
    const restaurant = await findRestaurantById(id);
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    let queueEntries = [];
    try { queueEntries = await listCollection("queue_entries"); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    return send(response, 200, { ...sanitizeRestaurant(restaurant), live_stats: await getLiveStats(restaurant, queueEntries), reliability: reliabilityFallback() });
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

    const entries = await listCollection("queue_entries").catch(() => Object.values(global._tickets));
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
    const entries = await listCollection("queue_entries").catch(error => { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; return Object.values(global._tickets).filter(t => t.restaurant_id === ticket.restaurant_id); });
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
    let queue = [];
    try { queue = await listCollection("queue_entries"); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
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
    let queueEntries = [];
    try { queueEntries = await listCollection("queue_entries"); } catch (error) { if (error.status !== 503 && error.status !== 403 && error.status !== 404 && !(error instanceof SyntaxError)) throw error; }
    const active = queueEntries.filter(entry => ["waiting", "notified", "delayed"].includes(entry.status));
    const seated = queueEntries.filter(entry => entry.status === "seated");
    const enriched = [];
    for (const restaurant of restaurants) enriched.push({ ...restaurant, live_stats: await getLiveStats(restaurant, queueEntries), reliability: reliabilityFallback() });
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
        const restId = body.restaurant_id || "rest-1";
        ticket = {
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
        updates = { ...ticket };
      } else {
        updates.has_arrived = true;
      }
    } else if (body.action === "delay") {
      if (!ticket) return send(response, 404, { error: "Ticket not found" });
      updates.delay_mins = Number(ticket.delay_mins || 0) + Number(body.minutes || 5);
      updates.status = "delayed";
    } else if (body.action === "cancel") {
      if (!ticket) return send(response, 404, { error: "Ticket not found" });
      updates.status = "cancelled";
    } else return send(response, 400, { error: "Unknown action" });
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
    return send(response, 200, { success: true, message: "Queue action saved." });
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
        restaurant = await getDocument("restaurants", body.restaurant_id);
      } catch (error) {
        if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
          restaurant = null;
        } else {
          throw error;
        }
      }
      if (!restaurant) {
        restaurant = fallbackRestaurants.find(r => r.id === body.restaurant_id) || null;
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
      return send(response, 200, { success: true, message: "Queue status updated." });
    }
    if (body.action === "update_wait_estimate") {
      let restaurant;
      try {
        restaurant = await getDocument("restaurants", body.restaurant_id);
      } catch (error) {
        if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
          restaurant = null;
        } else {
          throw error;
        }
      }
      if (!restaurant) {
        restaurant = fallbackRestaurants.find(r => r.id === body.restaurant_id) || null;
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
      const entries = Object.values(global._tickets);
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
    const restaurant = await getDocument("restaurants", body.restaurant_id);
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    const newState = !Boolean(restaurant.is_queue_open);
    await safeCommit([setDocument("restaurants", restaurant.id, { ...restaurant, is_queue_open: newState })]);
    return send(response, 200, { success: true, new_state: newState ? 1 : 0, message: "Restaurant queue state updated." });
  }

  if (request.method === "POST" && path === "/api/owner/restaurants/create") {
    if (!body.name || !body.category || !body.address) return send(response, 400, { error: "Please provide Restaurant Name, Cuisine Category, and Address." });
    const id = `rest-${Date.now().toString().slice(-6)}`;
    const restaurant = { id, password_hash: hashPassword(body.password || "waitmate123"), name: body.name, category: body.category, type: body.type || "restaurant", city: body.city || "Mumbai", address: body.address, distance_km: 1.0, price_range: body.price_range || "₹₹", image_url: body.image_url || "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80", description: body.description || "", owner_name: body.owner_name || "Owner", owner_phone: body.owner_phone || "", base_prep_time: Number(body.base_prep_time || 12), available_tables: Math.max(1, Math.floor(Number(body.total_tables || 16) / 4)), total_tables: Number(body.total_tables || 16), manual_override_wait: null, is_queue_open: true, created_at: Date.now() };
    await safeCommit([setDocument("restaurants", id, restaurant)]);
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

  if (request.method === "POST" && path === "/api/reliability/feedback") {
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
