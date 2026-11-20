# ⏳ WaitMate India 🇮🇳

> **Less time waiting, more time enjoying food.**  
> A transparent restaurant queue management platform powered by remote waitlists and crowd-verified **Reliability Scores™**, tailored for busy dining hubs across India (Bengaluru, Mumbai, Delhi NCR, Pune).

---

## 💡 The Problem WaitMate Solves in India

Anyone who has craved weekend breakfast at **The Rameshwaram Cafe** in Indiranagar, biryani at **Meghana Foods**, or late-night street rolls at **Bademiya** knows the ordeal:
- **The Sidewalk Bottleneck**: Diners battle traffic, spend 15 minutes finding parking, and then get told *"Sir, 35–45 minutes wait."* Diners are trapped outside on dusty sidewalks, afraid to explore nearby shops.
- **The "15-Minute" Myth**: Host desks frequently underestimate queue times to prevent walk-ins from going to neighboring spots.
- **Lost Tokens Due to Noise & Parking**: Host numbers are shouted through noisy crowds. Diners parking or walking over arrive 2 minutes late only to find their token was cancelled or given away.
- **Zero Predatory Commissions**: Unlike aggregator apps that charge high per-diner fees or heavy platform cuts, WaitMate is pure, transparent queue management for high-turnover dining spots and street food trucks.

---

## 🏛️ Tri-Interface Architecture

WaitMate is built with three live, dedicated interfaces accessible right from the top navigation bar:

### 1. 🍽️ Customer Interface
- **City Switcher**: Select between All India, Bengaluru, Mumbai, Delhi NCR, and Pune.
- **Smart Discovery**: Live waiting times, active queue sizes, pricing tiers (`₹`, `₹₹`, `₹₹₹`), and category filters (Restaurants vs. Food Trucks).
- **Remote Queue Pass**: Join the queue from up to 5 km away with Indian `+91` mobile numbers.
- **Digital Boarding Pass**: Live rank tracking, progress ring, dynamic remaining time, and verified arrival check-in.
- **Enhanced "Table is Near" System**:
  - High-urgency alert when rank $\le 2$ or wait $\le 7$ mins.
  - Walking distance countdown guidance.
  - Realistic WhatsApp alert card with 5-minute table hold notice.
  - Synthesized dual-tone audio chime and "+5m Grace" buffer for Indian metro parking delays.
- **Crowd-Verified Accuracy**: 1-tap post-seating check-in directly updates the venue's live Reliability Score™.

### 2. 🏪 Restaurant Owner Interface
- **Add New Restaurant to WaitMate**:
  - Live self-serve registration form for restaurant and food truck owners.
  - Input brand name, cuisine category, venue type, city, price tier, street address, owner contact (`+91`), table capacity, dining pace, and cover photo.
  - Instant live activation on the WaitMate India network.
- **Live Host Stand & Queue Manager**:
  - Manage any registered restaurant from a unified host console.
  - Live waitlist sorted by priority rank with arrival indicators (`✓ At Entrance`).
  - 1-click **Notify** (WhatsApp/SMS chime), **Seat**, and **Mark No-Show**.
  - Add walk-in guests with `+91` phone numbers.
  - Manual wait time override with **Anti-Overpromising Warnings** to protect accuracy scores.
  - Instant Pause/Open Queue toggle.

### 3. 🛡️ Founder Command Center
- **Executive Platform Surveillance**:
  - Live platform KPIs: Total registered venues across Indian hubs, active diners in queues, total seated throughput today, and platform average reliability score.
- **Registered Restaurant Network Directory**:
  - Live operational table with queue load, pricing, and 1-click Founder emergency Pause/Open controls.
- **Live Cross-Platform Queue Stream**:
  - Real-time audit log of diners joining across India via Remote App vs. Walk-in.
- **Reliability Audit Watchdog**:
  - Live feed of diner-verified check-ins comparing promised wait vs. actual seated wait to flag restaurants underestimating queue times.

---

## 🍽️ Featured Indian Partner Venues
1. **The Rameshwaram Cafe** (100ft Road, Indiranagar, Bengaluru) — *Iconic Ghee Podi Dosa & Filter Coffee, 96% Reliability (Grade A+), ₹*
2. **Meghana Foods** (Koramangala 5th Block, Bengaluru) — *Famous Spicy Andhra Biryani & Thalis, 92% Reliability (Grade A), ₹₹*
3. **Bademiya Street Kebab Truck & Rolls** (Colaba, Mumbai) — *Late-Night Charcoal Kebabs & Baida Roti, 94% Reliability (Grade A), ₹₹*
4. **Toit Brewpub & Kitchen** (Indiranagar, Bengaluru) — *Craft Microbrewery & Woodfired Pizza, 84% Reliability (Grade B), ₹₹₹*
5. **Chai Sutta Bar & Bun Maska Express** (FC Road, Pune) — *Kulhad Chai, Bun Maska & Hot Samosas, 97% Reliability (Grade A+), ₹*
6. **Punjab Grill & Royal Tandoor** (Connaught Place, New Delhi) — *North Indian, Dal Makhani & Kebabs, 72% Reliability (Grade C), ₹₹₹*

---

## 🏃 Running the Application

The application runs with zero external package dependencies on standard Python 3.

```bash
python3 server.py
```
Open **`http://localhost:8080`** in your browser.

- Direct file links:
  - Frontend: [`index.html`](file:///Users/vedvitvora/.gemini/antigravity/scratch/waitmate/index.html)
  - Client Application Logic: [`app.js`](file:///Users/vedvitvora/.gemini/antigravity/scratch/waitmate/app.js)
  - Backend Server & SQLite Store: [`server.py`](file:///Users/vedvitvora/.gemini/antigravity/scratch/waitmate/server.py)
  - Styling: [`style.css`](file:///Users/vedvitvora/.gemini/antigravity/scratch/waitmate/style.css)
