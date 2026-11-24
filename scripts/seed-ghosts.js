#!/usr/bin/env node
/**
 * WaitMate India — Ghost Guest Seed Script
 *
 * Seeds a batch of AI ghost guests into Firebase Firestore for a given
 * restaurant so the restaurant portal and Host Stand can be tested
 * immediately without waiting for the Mumbai peak-window / zero-open-tables
 * gating in runSimulationTick.
 *
 * Usage:
 *   node scripts/seed-ghosts.js <restaurant_id> [count]
 *
 * Environment:
 *   FIREBASE_SERVICE_ACCOUNT  — required (service account JSON, see .env)
 *   DEMO_MODE=true           — skips Founder password check (optional)
 *
 * Example:
 *   DEMO_MODE=true node scripts/seed-ghosts.js rest-1 8
 */

const { spawnGhostsForRestaurant } = require("../api/_seed-ghosts");

async function main() {
  const [, , restaurantId, countArg] = process.argv;
  if (!restaurantId) {
    console.error("Usage: node scripts/seed-ghosts.js <restaurant_id> [count]");
    process.exit(1);
  }
  const count = Number(countArg || 5);
  if (!Number.isFinite(count) || count < 1) {
    console.error("Count must be a positive integer.");
    process.exit(1);
  }

  // Load the restaurant document so we can pass its name to the spawner.
  const { getDocument } = require("../api/_firestore");
  const restaurant = await getDocument("restaurants", restaurantId);
  if (!restaurant) {
    console.error(`Restaurant "${restaurantId}" not found in Firestore.`);
    process.exit(1);
  }

  const result = await spawnGhostsForRestaurant(restaurantId, restaurant, count);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

main().catch((err) => {
  console.error("Seed script failed:", err?.message || err);
  process.exit(1);
});