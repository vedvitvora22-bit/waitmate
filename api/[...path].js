const {
  listCollection,
  getDocument,
  commitWrites,
  setDocument
} = require("./_firestore");

const now = Date.now();

const fallbackRestaurants = [
  { id: "rest-1", name: "The Rameshwaram Cafe", category: "Iconic South Indian & Filter Coffee", type: "restaurant", city: "Bengaluru", address: "100ft Road, HAL 2nd Stage, Indiranagar, Bengaluru", distance_km: 0.8, price_range: "₹", image_url: "https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800&auto=format&fit=crop&q=80", description: "Famous for crispy ghee podi dosa, medu vada, and authentic filter coffee.", base_prep_time: 8, available_tables: 2, total_tables: 18, is_queue_open: true, manual_override_wait: null, created_at: now - 86400000 },
  { id: "rest-2", name: "Meghana Foods", category: "Spicy Andhra Biryani & Thalis", type: "restaurant", city: "Bengaluru", address: "Koramangala 5th Block, Bengaluru", distance_km: 1.6, price_range: "₹₹", image_url: "https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800&auto=format&fit=crop&q=80", description: "Legendary boneless chicken biryani and traditional Andhra meals.", base_prep_time: 16, available_tables: 1, total_tables: 22, is_queue_open: true, manual_override_wait: null, created_at: now - 172800000 },
  { id: "rest-3", name: "Bademiya Street Kebab Truck & Rolls", category: "Late-Night Charcoal Kebabs & Baida Roti", type: "food_truck", city: "Mumbai", address: "Colaba, Mumbai", distance_km: 0.5, price_range: "₹₹", image_url: "https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=800&auto=format&fit=crop&q=80", description: "Mumbai's iconic street food institution.", base_prep_time: 7, available_tables: 0, total_tables: 10, is_queue_open: true, manual_override_wait: null, created_at: now - 259200000 },
  { id: "rest-4", name: "Toit Brewpub & Kitchen", category: "Craft Microbrewery & Woodfired Pizza", type: "restaurant", city: "Bengaluru", address: "Indiranagar, Bengaluru", distance_km: 1.2, price_range: "₹₹₹", image_url: "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&auto=format&fit=crop&q=80", description: "Craft beer and woodfired sourdough pizza.", base_prep_time: 22, available_tables: 2, total_tables: 26, is_queue_open: true, manual_override_wait: null, created_at: now - 345600000 },
  { id: "rest-5", name: "Chai Sutta Bar & Bun Maska Express", category: "Kulhad Chai, Bun Maska & Samosas", type: "food_truck", city: "Pune", address: "FC Road, Pune", distance_km: 0.4, price_range: "₹", image_url: "https://images.unsplash.com/photo-1576092768241-dec231879fc3?w=800&auto=format&fit=crop&q=80", description: "Kulhad chai, bun maska, and hot samosas.", base_prep_time: 5, available_tables: 0, total_tables: 6, is_queue_open: true, manual_override_wait: null, created_at: now - 432000000 },
  { id: "rest-6", name: "Punjab Grill & Royal Tandoor", category: "North Indian, Dal Makhani & Kebabs", type: "restaurant", city: "Delhi NCR", address: "Connaught Place, New Delhi", distance_km: 3.2, price_range: "₹₹₹", image_url: "https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&auto=format&fit=crop&q=80", description: "North Indian dining with dal makhani and tandoori platters.", base_prep_time: 20, available_tables: 1, total_tables: 20, is_queue_open: true, manual_override_wait: null, created_at: now - 518400000 }
];

function send(response, status, data) {
  response.status(status);
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.send(JSON.stringify(data));
}

function reliabilityFallback() {
  return { score: 92, grade: "A", verdict: "Verified demo data", badge_color: "emerald", avg_variance_mins: 2.5, total_verified_checkins: 0, on_time_pct: 90, early_pct: 5, slight_late_pct: 5, severe_late_pct: 0, recent_reviews: [] };
}

async function ensureRestaurants() {
  try {
    const restaurants = await listCollection("restaurants");
    if (restaurants.length) return restaurants;
    await commitWrites(fallbackRestaurants.map(restaurant => setDocument("restaurants", restaurant.id, restaurant)));
    return fallbackRestaurants;
  } catch (error) {
    if (error.status === 403 || error.status === 404) return fallbackRestaurants;
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
  const path = `/${pathParts.join("/")}`;

  if (request.method === "OPTIONS") return send(response, 204, {});

  if (request.method === "GET" && path === "/api/restaurants") {
    const restaurants = await ensureRestaurants();
    let queueEntries = [];
    try { queueEntries = await listCollection("queue_entries"); } catch (error) { if (error.status !== 403 && error.status !== 404) throw error; }
    const result = [];
    for (const restaurant of restaurants) {
      const liveStats = await getLiveStats(restaurant, queueEntries);
      result.push({ ...restaurant, live_stats: liveStats, reliability: reliabilityFallback() });
    }
    return send(response, 200, { restaurants: result });
  }

  if (request.method === "GET" && path.startsWith("/api/restaurants/")) {
    const id = pathParts[pathParts.length - 1];
    const restaurant = await getDocument("restaurants", id);
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    let queueEntries = [];
    try { queueEntries = await listCollection("queue_entries"); } catch {}
    return send(response, 200, { ...restaurant, live_stats: await getLiveStats(restaurant, queueEntries), reliability: reliabilityFallback() });
  }

  if (request.method === "POST" && path === "/api/queue/join") {
    const body = request.body || {};
    if (!body.restaurant_id || !String(body.name || "").trim()) return send(response, 400, { error: "Missing required fields" });
    const restaurant = await getDocument("restaurants", body.restaurant_id);
    if (!restaurant) return send(response, 404, { error: "Invalid restaurant" });
    if (!restaurant.is_queue_open) return send(response, 400, { error: "Queue is currently closed" });

    const entries = await listCollection("queue_entries");
    const ticketId = `q-${Date.now().toString().slice(-6)}`;
    const ticketNumber = `WM-${entries.length + 101}`;
    const joinedAt = Date.now();
    const partySize = Number(body.party_size || 2);
    await commitWrites([setDocument("queue_entries", ticketId, {
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
    })]);
    return send(response, 200, { success: true, ticket_id: ticketId, ticket_number: ticketNumber, estimated_wait_mins: 10, message: `Spot confirmed! Your ticket is ${ticketNumber}.` });
  }

  if (request.method === "GET" && path.startsWith("/api/queue/ticket/")) {
    const id = pathParts[pathParts.length - 1];
    const ticket = await getDocument("queue_entries", id);
    if (!ticket) return send(response, 404, { error: "Ticket not found" });
    const restaurant = await getDocument("restaurants", ticket.restaurant_id);
    const entries = await listCollection("queue_entries");
    const ahead = entries.filter(entry => entry.restaurant_id === ticket.restaurant_id && ["waiting", "notified", "delayed"].includes(entry.status) && Number(entry.joined_at) < Number(ticket.joined_at)).length;
    const position = ahead + 1;
    const elapsed = Math.floor((Date.now() - Number(ticket.joined_at || Date.now())) / 60000);
    const remaining = ticket.status === "waiting" || ticket.status === "delayed" ? Math.max(1, Number(ticket.estimated_wait_mins || 10) + Number(ticket.delay_mins || 0) - elapsed) : 0;
    return send(response, 200, { ...ticket, position_in_line: position, parties_ahead: ahead, estimated_remaining_mins: remaining, is_table_near: ["waiting", "delayed"].includes(ticket.status) && (position <= 2 || remaining <= 7), is_table_ready: ticket.status === "notified", restaurant: restaurant ? { name: restaurant.name, address: restaurant.address, category: restaurant.category, image_url: restaurant.image_url } : null });
  }

  if (request.method === "GET" && path.startsWith("/api/host/queue/")) {
    const id = pathParts[pathParts.length - 1];
    const restaurant = await getDocument("restaurants", id);
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    const queue = await listCollection("queue_entries");
    const entries = queue.filter(entry => entry.restaurant_id === id).sort((a, b) => Number(a.joined_at || 0) - Number(b.joined_at || 0));
    return send(response, 200, { restaurant, live_stats: await getLiveStats(restaurant, entries), reliability: reliabilityFallback(), queue: entries.map((entry, index) => ({ ...entry, position_rank: index + 1, is_table_near: index < 2 && ["waiting", "delayed"].includes(entry.status) })) });
  }

  if (request.method === "GET" && path === "/api/founder/analytics") {
    const restaurants = await ensureRestaurants();
    const queueEntries = await listCollection("queue_entries").catch(() => []);
    const active = queueEntries.filter(entry => ["waiting", "notified", "delayed"].includes(entry.status));
    const seated = queueEntries.filter(entry => entry.status === "seated");
    const enriched = [];
    for (const restaurant of restaurants) enriched.push({ ...restaurant, live_stats: await getLiveStats(restaurant, queueEntries), reliability: reliabilityFallback() });
    return send(response, 200, { summary: { total_restaurants: restaurants.length, total_cities: new Set(restaurants.map(r => r.city)).size, cities_list: [...new Set(restaurants.map(r => r.city))], active_parties_in_queue: active.length, active_diners_in_queue: active.reduce((sum, entry) => sum + Number(entry.party_size || 0), 0), total_seated_parties: seated.length, total_seated_diners: seated.reduce((sum, entry) => sum + Number(entry.party_size || 0), 0), platform_avg_reliability: 92 }, restaurants: enriched, recent_queues: queueEntries.slice(-15).reverse(), recent_reviews: [] });
  }

  if (request.method === "POST" && path === "/api/queue/action") {
    const body = request.body || {};
    const ticket = await getDocument("queue_entries", body.ticket_id);
    if (!ticket) return send(response, 404, { error: "Ticket not found" });
    const updates = { ...ticket };
    if (body.action === "arrived") updates.has_arrived = true;
    else if (body.action === "delay") updates.delay_mins = Number(ticket.delay_mins || 0) + Number(body.minutes || 5), updates.status = "delayed";
    else if (body.action === "cancel") updates.status = "cancelled";
    else return send(response, 400, { error: "Unknown action" });
    await commitWrites([setDocument("queue_entries", ticket.id, updates)]);
    return send(response, 200, { success: true, message: "Queue action saved." });
  }

  if (request.method === "POST" && path === "/api/host/action") {
    const body = request.body || {};
    if (body.action === "notify" || body.action === "seat" || body.action === "remove") {
      const ticket = await getDocument("queue_entries", body.ticket_id);
      if (!ticket) return send(response, 404, { error: "Ticket not found" });
      const updates = { ...ticket };
      if (body.action === "notify") updates.status = "notified", updates.notified_at = Date.now();
      if (body.action === "seat") updates.status = "seated", updates.seated_at = Date.now();
      if (body.action === "remove") updates.status = "no_show";
      await commitWrites([setDocument("queue_entries", ticket.id, updates)]);
      return send(response, 200, { success: true, message: "Host action saved." });
    }
    if (body.action === "toggle_queue") {
      const restaurant = await getDocument("restaurants", body.restaurant_id);
      if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
      await commitWrites([setDocument("restaurants", restaurant.id, { ...restaurant, is_queue_open: Boolean(body.is_open) })]);
      return send(response, 200, { success: true, message: "Queue status updated." });
    }
    if (body.action === "update_wait_estimate") {
      const restaurant = await getDocument("restaurants", body.restaurant_id);
      if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
      await commitWrites([setDocument("restaurants", restaurant.id, { ...restaurant, manual_override_wait: body.manual_wait_mins })]);
      return send(response, 200, { success: true, message: "Wait time estimate updated." });
    }
    return send(response, 400, { error: "Unknown host action" });
  }

  if (request.method === "POST" && path === "/api/founder/restaurant/toggle") {
    const body = request.body || {};
    const restaurant = await getDocument("restaurants", body.restaurant_id);
    if (!restaurant) return send(response, 404, { error: "Restaurant not found" });
    const newState = !Boolean(restaurant.is_queue_open);
    await commitWrites([setDocument("restaurants", restaurant.id, { ...restaurant, is_queue_open: newState })]);
    return send(response, 200, { success: true, new_state: newState ? 1 : 0, message: "Restaurant queue state updated." });
  }

  if (request.method === "POST" && path === "/api/owner/restaurants/create") {
    const body = request.body || {};
    if (!body.name || !body.category || !body.address) return send(response, 400, { error: "Please provide Restaurant Name, Cuisine Category, and Address." });
    const id = `rest-${Date.now().toString().slice(-6)}`;
    const restaurant = { id, name: body.name, category: body.category, type: body.type || "restaurant", city: body.city || "Bengaluru", address: body.address, distance_km: 1.0, price_range: body.price_range || "₹₹", image_url: body.image_url || "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80", description: body.description || "", owner_name: body.owner_name || "Owner", owner_phone: body.owner_phone || "", base_prep_time: Number(body.base_prep_time || 12), available_tables: Math.max(1, Math.floor(Number(body.total_tables || 16) / 4)), total_tables: Number(body.total_tables || 16), manual_override_wait: null, is_queue_open: true, created_at: Date.now() };
    await commitWrites([setDocument("restaurants", id, restaurant)]);
    return send(response, 200, { success: true, restaurant_id: id, message: `Congratulations! '${body.name}' is now live on WaitMate India.`, restaurant });
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
    if (error.status === 403) return send(response, 503, { error: "Firebase permissions are not configured yet." });
    if (error.status === 404) return send(response, 503, { error: "Firebase database is not available yet." });
    return send(response, 500, { error: error.message || "Unexpected server error." });
  }
};
