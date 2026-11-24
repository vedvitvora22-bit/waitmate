/**
 * WaitMate India — Shared Ghost Guest Spawner
 *
 * A single, reusable implementation of the AI ghost guest spawning logic used
 * by both the Vercel API (api/[...path].js) and the standalone seed script
 * (scripts/seed-ghosts.js). Writes standardized `source: "ghost"` records to
 * Firestore so the restaurant portal can display Ghost badges immediately.
 *
 * Every ghost record saved here explicitly stores:
 *   - source: "ghost"   (one of "walk-in" | "remote" | "ghost")
 *   - entry_type: "ghost"
 *   - is_ghost / isGhost: true
 *   - channel: "remote"
 */

const { setDocument, commitWrites, PROJECT_ID, encodeSegment } = require("./_firestore");

const GHOST_NAMES = [
  "Aarav Patel", "Diya Sharma", "Vihaan Singh", "Ananya Reddy", "Kabir Nair",
  "Myra Desai", "Ishaan Mehta", "Zoya Khan", "Reyansh Iyer", "Aanya Joshi",
  "Arjun Malhotra", "Kiara Verma", "Advait Rao", "Saanvi Pillai", "Raghav Menon",
];

function formatIST(ms) {
  const d = new Date(ms);
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }) + " IST";
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
    "source": e.source || (e.entry_type === "ghost" ? "ghost" : channel),
    "13_joined_time_ist": e.joined_time_ist || ist(joinedMs) || "",
    "14_arrived_time_ist": e.arrived_time_ist || ist(e.arrived_at) || null,
    "15_notified_time_ist": e.notified_time_ist || ist(e.notified_at) || null,
    "16_seated_time_ist": e.seated_time_ist || ist(e.seated_at) || null,
    "17_actual_wait_mins": e.actual_wait_mins === undefined || e.actual_wait_mins === null ? null : Number(e.actual_wait_mins),
    "18_rated": Boolean(e.rated),
    "19_rating": e.rating === undefined || e.rating === null ? null : Number(e.rating),
    "20_review_comment": e.review_comment || e.comment || "",
    "21_rated_time_ist": e.rated_time_ist || ist(e.rated_at) || null,
    "22_joined_at_ms": joinedMs,
  };
  if (e.is_ghost || e.isGhost || e.entry_type === "ghost") {
    numbered.is_ghost = true;
    numbered.isGhost = true;
    numbered.entry_type = "ghost";
  }
  return numbered;
}

async function safeCommit(writes) {
  try {
    return await commitWrites(writes);
  } catch (error) {
    if (error.status === 503 || error.status === 403 || error.status === 404 || error instanceof SyntaxError) {
      console.warn("Firestore commit skipped (demo/unconfigured mode):", error.status);
      return null;
    }
    throw error;
  }
}

/**
 * Spawn a batch of AI ghost guests for a restaurant, bypassing the Mumbai
 * peak-window and zero-open-tables gating used by runSimulationTick.
 *
 * @param {string} restaurantId
 * @param {{name?: string, total_tables?: number}} restaurant
 * @param {number} count — desired total ghost count (existing ghosts are subtracted)
 * @returns {{spawned: number, existingGhosts: number, target: number}}
 */
async function spawnGhostsForRestaurant(restaurantId, restaurant, count = 5) {
  const now = Date.now();
  const existingGhosts = 0; // caller may pass pre-fetched entries if needed
  const toSpawn = Math.max(0, Number(count) - existingGhosts);
  const writes = [];
  let spawned = 0;
  for (let i = 0; i < toSpawn; i++) {
    const ghostId = `ghost-dev-${String(now * 1000 + i).slice(-8)}`;
    const ticketNumber = `WM-G${String(Math.floor(now / 1000) % 100000).padStart(5, "0")}`;
    const partySize = 2 + Math.floor(Math.random() * 3);
    const ghostName = GHOST_NAMES[(existingGhosts + i) % GHOST_NAMES.length];
    const ghost = {
      id: ghostId,
      ticket_number: ticketNumber,
      restaurant_id: restaurantId,
      restaurant_name: restaurant.name || "",
      guest_name: ghostName,
      customer_name: ghostName,
      phone: "",
      party_size: partySize,
      seating_pref: "First Available",
      special_requests: "",
      channel: "remote",
      entry_type: "ghost",
      source: "ghost",
      "09_channel": "remote",
      status: "waiting",
      estimated_wait_mins: 1 + Math.floor(Math.random() * 45),
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
    writes.push(setDocument("queue_entries", ghostId, toNumberedEntry(ghost)));
    spawned++;
  }
  if (writes.length) await safeCommit(writes);
  return { spawned, existingGhosts, target: count };
}

module.exports = {
  spawnGhostsForRestaurant,
  toNumberedEntry,
  GHOST_NAMES,
  formatIST,
};