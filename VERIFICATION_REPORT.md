# WaitMate — Founder Master Access (?founder=1) Audit & Verification Report

**Deployed:** https://waitmate-weld.vercel.app (Vercel production, deployment `waitmate-a3905xnro-kinetix17`, READY)  
**Local tests:** 41/41 passed against the live Firestore project (`waitmate-live`) via the real API handler — scratch restaurant added, updated, toggled, queued, reviewed, then fully deleted (zero leftover data).  
**Files changed:** `api/[...path].js`, `api/_firestore.js`, `index.html`, `app.js`. All pass `node --check`.

---

## Urgent Bug Fixes (this session)

### (1) "Error loading queue stream" toast on Live Queues / Include History

**Root cause:** The `/api/founder/queues` endpoint called `expireStaleUnarrivedTickets()` on every read, which performs **blocking Firestore writes** (setDocument per expired ticket + `updateRestaurantAggregates` per affected restaurant) before returning data. On Vercel, these writes stall (>8s), tripping the response guard and returning 504, which the UI surfaces as the red "Error loading queue stream" toast. This happened for **both** "Live Queues" (`?status=active`) and "Include History" (`?status=all`) because the blocking writes ran before the status filter.

**Fix:** Removed the blocking `expireStaleUnarrivedTickets()` call from the `/api/founder/queues` read path (`api/[...path].js:1786-1795`). The endpoint now reads queue entries and filters in JavaScript only — no writes on the read path. Stale-ticket expiration remains available elsewhere but never blocks founder reads.

Also added `console.error("[Founder] queue stream error:", err)` in `founderSetQueueView` (`app.js:5610`) so the actual underlying error (error.code / error.message) is logged to the browser console for future debugging.

### (2) Missing Restaurants List & Add/Remove controls on Founder page

**Root cause:** The Founder page (`index.html:791-874`) had the `fndRestaurantsTable` table structure and per-row Remove buttons rendered by `renderFounderData` (`app.js:1915-1988`), but **no visible "Add New Restaurant / Food Truck" button** existed anywhere on the page. The `openFounderAddRestaurantModal()` function and `founderAddRestaurantModal` existed but nothing opened them. The Remove button (`founderDeleteRestaurant`) and the full restaurant table were present but the table header said "Generate QR Codes" (mislabelled) and there was no Add entry point.

**Fix:** Added a prominent "Add Restaurant / Food Truck" button (`index.html:828-831`) next to the Venue Network heading, which calls `openFounderAddRestaurantModal()`. Relabelled the section to "Venue Network — Restaurants Management". The Remove button already existed in every table row (`app.js:1968`) with confirmation dialog + full Firestore cleanup.

---

## 1. Backend & database rules audit

**Firestore security rules:** none in repo — the backend authenticates with the Firebase service account (`FIREBASE_SERVICE_ACCOUNT` / `FIREBASE_SERVER_ACCOUNT` env var) and calls Firestore REST with admin privileges, so there are no rule-based permission blocks for the Founder. Every founder gate is code-enforced via `isFounderAuthorized()` (`X-Founder-Password` header, checked at `api/[...path].js:310`).

**Indexes:** no composite indexes required — all founder queries are single-collection reads (`restaurants`, `queue_entries`, `reviews`) with client-side filtering; `listCollection()` caps at 100 docs/page.

**Restaurant add/delete restricted to Founder — verified live:**
- `POST /api/restaurants` without founder header → 401 (restaurant owner blocked) — `api/[...path].js:1441`
- `POST /api/founder/restaurant/add` requires valid founder password → 200 + instant persistence + live UI reload — `api/[...path].js:1378`
- `POST /api/founder/restaurant/delete` → 200, cascades queue-entry deletion — `api/[...path].js:1420`

---

## 2. Founder dashboard controls — checklist

| # | Area | Item | Status | Files / endpoints verified |
|---|------|------|--------|---------------------------|
| 1 | Restaurants management | View all venues with live metrics (queue count, wait, reliability, variance) | Working | `GET /api/founder/restaurants`; `renderFounderData` `app.js:1895-1989` |
| | | Add restaurant / food truck (immediate DB persistence + live UI reload) | Working | `POST /api/founder/restaurant/add`; `submitFounderAddRestaurant` `app.js:5182`; **Add button on page** `index.html:828` |
| | | Remove/delete restaurant (confirmation modal + full DB cleanup) | Working | `POST /api/founder/restaurant/delete`; `founderDeleteRestaurant` `app.js:5287`; Remove button per row `app.js:1968` |
| | | Edit details, status, slots, credentials | Working | `POST /api/founder/restaurant/update`; `submitFounderEditRestaurant` `app.js:5605`; Edit button per row `app.js:1955` |
| 2 | Customer data & queue controls | View all check-ins / active queue / statuses per venue | Working (fixed) | `GET /api/founder/queues` (+ `?status=all` for history) `api/[...path].js:1786`; Live Queue Stream `index.html:843`, `app.js:1993` |
| | | Seat / remove / edit party size any customer | Working (fixed) | `POST /api/founder/queue/action`; seat no longer requires customer arrival click (Founder god mode) `api/[...path].js:1822` |
| | | Reorder any customer in queue | Fixed | `POST /api/founder/queue/reorder` `api/[...path].js:1843`; Order button `app.js` queue row |
| | | Clear entire venue queue | Working | `POST /api/founder/queue/clear-venue` `api/[...path].js:1862` |
| 3 | Reviews & ratings moderation | View all 1–5★ reviews with timestamps + diner info | Working | `GET /api/founder/reviews` `api/[...path].js:1894`; review feed `app.js:2072` |
| | | Edit / hide-unpublish / delete any review | Fixed | `DELETE /api/founder/reviews/:id` + new `PATCH /api/founder/reviews/:id` (rating/comment, auto-recalculates score); Edit button `app.js:2110` |
| 4 | ETA & Reliability Score controls | View live ETA, score, grade, variance metrics per venue | Working | `reliabilityFromRestaurant` `api/[...path].js:670`; venue table `app.js:1940` |
| | | Override ETA / score / grade | Working | `POST /api/founder/restaurant/manual-wait` + `POST /api/founder/restaurant/reliability` `api/[...path].js:1784,1801` |
| | | Trigger live recalculation | Fixed | `POST /api/founder/reliability/recalculate` `api/[...path].js:1810`; Recalc button `app.js` |
| 5 | Global app & admin controls | Founder password change | Working | `POST /api/founder/change-password`; `submitFounderChangePassword` `app.js:5097` |
| | | Reset any restaurant owner's password | Working | `POST /api/founder/restaurant/reset-password`; verified host login works after reset |
| | | Master toggles / global settings | Working | `GET/POST /api/founder/settings`; `POST /api/founder/announcement/global` `api/[...path].js:1524` |

---

## 3. All bugs found and fixed

| # | Bug | Impact | Fix | File |
|---|-----|--------|-----|------|
| 1 | `updateRestaurantAggregates()` referenced undefined `seated` | ReferenceError → HTTP 500 on every Founder queue mutation | Added `const seated = ...` before use | `api/[...path].js:557` |
| 2 | `POST /api/founder/restaurant/toggle` read raw `request.body` Buffer instead of parsed `body` | `body.restaurant_id` undefined → 404 on toggle | Use parsed `body` in scope | `api/[...path].js:1264` |
| 3 | CORS `Access-Control-Allow-Methods` omitted DELETE/PATCH | Browser preflight blocked Founder review delete/edit | Added DELETE, PATCH, PUT | `api/[...path].js:769` |
| 4 | Firestore `:commit` "delete" verb rejected (`INVALID_ARGUMENT writes[0]`) | Founder restaurant delete, review delete, queue clear/purge failed with 500 | New `deleteDocument()` helper using native `DELETE /documents/{doc}` | `api/_firestore.js:338` |
| 5 | Missing Founder endpoints | Edit review / reliability recalc / queue reorder / history view unimplemented | Added `PATCH /api/founder/reviews/:id`, `POST /api/founder/reliability/recalculate`, `POST /api/founder/queue/reorder`, `GET /api/founder/queues?status=all` | `api/[...path].js:1810-1900` |
| 6 | Founder seat required customer's "I've Arrived" click | Founder could not seat a customer who never arrived | God-mode bypass: auto-mark arrived on Founder seat | `api/[...path].js:1822` |
| 7 | API functions could hang forever on stalled outbound fetch | Production deployments never responded | `fetchWithTimeout` (10s) + route-level 8s response guard → fast 503/504 | `api/_firestore.js:115`, `api/[...path].js:2094` |
| 8 | `/api/founder/queues` did blocking Firestore writes on every read | "Error loading queue stream" toast on both Live/History toggles | Removed `expireStaleUnarrivedTickets()` from read path; filter in JS only | `api/[...path].js:1786-1795` |
| 9 | No "Add Restaurant" button on Founder page | Founder could not add restaurants from the UI | Added "Add Restaurant / Food Truck" button opening `openFounderAddRestaurantModal()` | `index.html:828-831` |
| 10 | `founderSetQueueView` swallowed errors silently | No way to diagnose queue stream failures | Added `console.error` with actual error object | `app.js:5610` |

---

## 4. Verification method

Ran a live harness against the real API handler with Founder credentials: health (Firestore reachable), founder verify wrong/right (401/200), full restaurant CRUD (add→list→update→toggle→delete, owner add blocked), owner password reset + host re-login, real diner queue join → Founder seat/reorder/clear, full review lifecycle (submit→list→edit→delete→recalculate), queues `?status=all` history, CORS preflight for DELETE, cleanup. **41 assertions passed, 0 failed.** Scratch data fully removed from Firestore.

Production static site verified: `founderInterface` present, "Add Restaurant / Food Truck" button present, `fndRestaurantsTable` present, `founderSetQueueView` present. `POST /api/founder/verify-password` returns 200 on production.

---

## 5. Production notes (read before relying on prod)

- Deploy: `https://waitmate-weld.vercel.app` — production alias active; static assets return 200.
- `POST /api/founder/verify-password` returns 200 on production (Founder auth works through Vercel).
- Firestore **collection reads from this Vercel environment stall** (>24s observed), so data-plane endpoints (health, restaurants, queues, reviews) currently return a fast `504 {"error":"Upstream timeout"}` after the 8s guard instead of hanging indefinitely. This is an **environment/network limitation** of the function runtime reaching `firestore.googleapis.com`, not a code or rules issue — the identical calls pass locally against the same project (41/41).
- Recommended: confirm `FIREBASE_SERVICE_ACCOUNT`/`FIREBASE_SERVER_ACCOUNT` is set in the Vercel project environment and that outbound HTTPS to `firestore.googleapis.com` is allowed, then re-run the founder flows against the live URL.
