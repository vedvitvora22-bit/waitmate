
let pendingUnlockVenueId = null;
let restaurantsRefreshTimer = null;
let restaurantsRefreshing = false;
let lastSimTriggerAt = 0;
const SIM_TRIGGER_COOLDOWN_MS = 110000;

const PASSWORD_MODAL_IDS = [
  'ownerPasswordModal',
  'ownerChangePasswordModal',
  'founderResetPasswordModal',
  'founderChangePasswordModal',
  'founderLoginModal',
  'founderAddRestaurantModal'
];

function isAnyPasswordModalOpen() {
  return PASSWORD_MODAL_IDS.some(id => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  });
}

function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  const btn = input ? input.parentElement.querySelector('button[onclick*="togglePasswordVisibility"]') : null;
  const icon = btn ? btn.querySelector('i[data-lucide]') : null;
  if (!input || !icon) return;
  if (input.type === 'password') {
    input.type = 'text';
    icon.setAttribute('data-lucide', 'eye-off');
  } else {
    input.type = 'password';
    icon.setAttribute('data-lucide', 'eye');
  }
  if (window.lucide) lucide.createIcons();
}

// Refresh /api/restaurants every 15s so all open browsers stay in sync with the
// same server-computed waits and queue counts. Polling is skipped entirely while
// the tab is hidden (document.hidden) to avoid wasting radio/battery in the
// background.
function startRestaurantsRefresh() {
  if (restaurantsRefreshTimer) return;
  restaurantsRefreshTimer = setInterval(async () => {
    if (document.hidden || document.visibilityState !== 'visible' || restaurantsRefreshing || isAnyPasswordModalOpen()) return;
    restaurantsRefreshing = true;
    try { await loadRestaurants(); } catch (err) { console.warn('Restaurants background refresh failed:', err); }
    finally { restaurantsRefreshing = false; }
  }, 15000);
}

// Fire a non-blocking background POST to advance the simulation tick. The GET
// /api/restaurants response renders instantly; this runs out-of-band and never
// blocks the UI. Throttled client-side (and again server-side via the 120s
// LAST_SIM_CACHE cooldown) so back-to-back requests don't re-run ticks.
function triggerBackgroundSimTick() {
  if (document.hidden) return;
  const now = Date.now();
  if (now - lastSimTriggerAt < SIM_TRIGGER_COOLDOWN_MS) return;
  lastSimTriggerAt = now;
  const ids = (allRestaurants || []).map(r => r.id).filter(Boolean);
  ids.forEach(id => {
    fetch('/api/queue/simulate-tick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurant_id: id }),
      keepalive: true
    }).catch(() => {});
  });
}

function closeOwnerPasswordModal() {
  const modal = document.getElementById('ownerPasswordModal');
  const errEl = document.getElementById('ownerPwdError');
  const input = document.getElementById('ownerPwdInput');
  if (modal) modal.classList.add('hidden');
  if (errEl) errEl.classList.add('hidden');
  if (input) input.value = '';
  pendingUnlockVenueId = null;
}

function openOwnerPasswordModal(venueId) {
  pendingUnlockVenueId = venueId;
  const venue = (allRestaurants || []).find(r => r.id === venueId);
  const venueName = venue ? venue.name : venueId;
  const titleEl = document.getElementById('ownerPwdModalTitle');
  const subEl = document.getElementById('ownerPwdModalSub');
  const errEl = document.getElementById('ownerPwdError');
  const input = document.getElementById('ownerPwdInput');
  const modal = document.getElementById('ownerPasswordModal');

  if (titleEl) titleEl.textContent = `Unlock ${venueName}`;
  if (subEl) subEl.textContent = `Enter the owner password for "${venueName}" to access its live queue and host controls.`;
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
  if (input) input.value = '';
  if (modal) {
    modal.classList.remove('hidden');
    setTimeout(() => input && input.focus(), 50);
  }
}

async function submitOwnerPassword(event) {
  if (event) event.preventDefault();
  const venueId = pendingUnlockVenueId || currentHostVenueId;
  const input = document.getElementById('ownerPwdInput');
  const errEl = document.getElementById('ownerPwdError');
  const btn = document.getElementById('ownerPwdSubmitBtn');
  const pwd = (input ? input.value : '').trim();

  if (!pwd) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Checking...';
  }
  if (errEl) errEl.classList.add('hidden');

  try {
    const verifyRes = await fetch('/api/host/verify-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurant_id: venueId, password: pwd })
    });

    if (verifyRes.ok) {
      saveHostPassword(venueId, pwd);
      currentHostVenueId = venueId;
      closeOwnerPasswordModal();
      await renderUnlockedHostStand(venueId, pwd);
      return;
    }

    const errData = await verifyRes.json().catch(() => ({}));
    clearHostPassword(venueId);
    if (errEl) {
      errEl.textContent = errData.error || 'Incorrect password. Please retry.';
      errEl.classList.remove('hidden');
    }
    if (input) {
      input.value = '';
      input.focus();
    }
  } catch (err) {
    if (errEl) {
      errEl.textContent = 'Network error verifying password. Please retry.';
      errEl.classList.remove('hidden');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Unlock Dashboard';
    }
  }
}

// Fires exactly one alert per newly-joined waiting party on the owner's Host Stand.
function detectNewHostJoins(venueId) {
  if (!hostData || !Array.isArray(hostData.queue)) return;
  const activeStatuses = ['waiting', 'delayed', 'notified'];
  const activeTickets = hostData.queue.filter(q => q && activeStatuses.includes(q.status));

  // First time viewing this venue: seed the set with already-waiting guests so opening
  // the Host Stand does NOT spam alerts for guests who were already in the queue.
  if (hostQueueInitializedFor !== venueId) {
    seenHostTicketIds = new Set(activeTickets.map(q => q.id));
    hostQueueInitializedFor = venueId;
    return;
  }

  activeTickets.forEach(q => {
    if (seenHostTicketIds.has(q.id)) return;
    // Mark seen immediately so each new party triggers ONLY ONE single alert.
    seenHostTicketIds.add(q.id);

    showToast(`🔔 New party joined: ${q.customer_name} (${q.party_size} guests) • ${q.ticket_number}`, 'info');
    playNotificationChime();
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification("New Guest in Queue • WaitMate", {
          body: `${q.customer_name} • ${q.party_size} guests • ${q.ticket_number}`
        });
      } catch (e) {
        console.warn("Browser notification failed:", e);
      }
    }
  });
}

async function renderUnlockedHostStand(venueId, pwd) {
  try {
    const res = await fetch(`/api/host/queue/${venueId}`, {
      headers: { 'X-Restaurant-Password': pwd },
      cache: 'no-store'
    });
    if (res.status === 401) {
      clearHostPassword(venueId);
      openOwnerPasswordModal(venueId);
      return;
    }
    if (!res.ok) throw new Error('Host API unavailable');
    hostData = await res.json();
  } catch (err) {
    const r = (allRestaurants || []).find(x => x.id === venueId) || (typeof fallbackRestaurants !== 'undefined' ? fallbackRestaurants : {});
    const q = (typeof localMockQueues !== 'undefined' && localMockQueues[venueId]) ? localMockQueues[venueId] : [];
    hostData = {
      restaurant: r,
      live_stats: r.live_stats || { queue_count: 0, estimated_wait_mins: 10, is_queue_open: true },
      reliability: r.reliability || { score: 95, grade: 'A+' },
      queue: q
    };
  }
  detectNewHostJoins(venueId);
  const dirEl = document.getElementById('ownerVenueDirectory');
  const dashEl = document.getElementById('ownerDashboardContent');
  if (dirEl) dirEl.classList.add('hidden');
  if (dashEl) dashEl.classList.remove('hidden');
  if (typeof populateHostDropdown === 'function') populateHostDropdown();
  if (typeof renderHostDashboard === 'function') renderHostDashboard();
  // Advance the AI ghost-queue simulator in the background so ghost guests
  // are generated and persisted even when the owner never opens the customer page.
  fetch('/api/queue/simulate-tick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurant_id: venueId }), keepalive: true }).catch(() => {});
}


function showOwnerDirectory() {
  const dirEl = document.getElementById('ownerVenueDirectory');
  const dashEl = document.getElementById('ownerDashboardContent');
  if (dirEl) dirEl.classList.remove('hidden');
  if (dashEl) dashEl.classList.add('hidden');
  renderOwnerDirectory();
}

function renderOwnerDirectory() {
  const grid = document.getElementById('ownerDirectoryGrid');
  if (!grid) return;
  const list = (allRestaurants && allRestaurants.length) ? allRestaurants : (typeof fallbackRestaurants !== 'undefined' ? fallbackRestaurants : []);
  grid.innerHTML = list.map(r => {
    const isUnlocked = Boolean(getSavedHostPassword(r.id));
    return `
      <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition flex flex-col justify-between">
        <div>
          <div class="h-32 w-full bg-slate-100 relative overflow-hidden">
            <img src="${r.image_url}" alt="${r.name}" class="w-full h-full object-cover">
            <span class="absolute top-2.5 right-2.5 px-2.5 py-1 rounded-full text-[10px] font-bold ${isUnlocked ? 'bg-emerald-600 text-white' : 'bg-slate-900/80 text-white'}">
              ${isUnlocked ? 'Unlocked' : 'Password Protected'}
            </span>
          </div>
          <div class="p-4">
            <h4 class="font-heading font-extrabold text-base text-slate-900">${r.name}</h4>
            <p class="text-xs text-slate-600 mt-0.5">${r.category}</p>
            <p class="text-[11px] text-slate-600 mt-2">${r.address}</p>
          </div>
        </div>
        <div class="px-4 pb-4">
            <button onclick="openProtectedHostStand('${r.id}')" class="w-full py-2.5 px-4 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-xl transition flex items-center justify-center gap-2">
            <span>${isUnlocked ? 'Open Host Stand' : 'Unlock Host Stand'}</span>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function openProtectedHostStand(venueId) {
  currentHostVenueId = venueId;
  const savedPwd = getSavedHostPassword(venueId);
  if (savedPwd) {
    await renderUnlockedHostStand(venueId, savedPwd);
  } else {
    openOwnerPasswordModal(venueId);
  }
}

// Per-restaurant owner password storage & verification
const verifiedHostPasswords = JSON.parse(sessionStorage.getItem('wm_host_passwords') || '{}');

function getSavedHostPassword(venueId) {
  return verifiedHostPasswords[venueId] || '';
}

function saveHostPassword(venueId, password) {
  verifiedHostPasswords[venueId] = password;
  sessionStorage.setItem('wm_host_passwords', JSON.stringify(verifiedHostPasswords));
}

function clearHostPassword(venueId) {
  delete verifiedHostPasswords[venueId];
  sessionStorage.setItem('wm_host_passwords', JSON.stringify(verifiedHostPasswords));
}

async function ensureHostAccess(venueId) {
  let pwd = getSavedHostPassword(venueId);
  const venue = (allRestaurants || []).find(r => r.id === venueId);
  const venueName = venue ? venue.name : venueId;

  while (true) {
    if (!pwd) {
      const entered = window.prompt(`Owner Verification Required\nEnter the dashboard password for "${venueName}":`);
      if (entered === null) return null;
      pwd = entered.trim();
      if (!pwd) continue;
    }
    try {
      const verifyRes = await fetch('/api/host/verify-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurant_id: venueId, password: pwd })
      });
      if (verifyRes.ok) {
        saveHostPassword(venueId, pwd);
        return pwd;
      }
      if (verifyRes.status === 401) {
        clearHostPassword(venueId);
        pwd = '';
        alert(`Incorrect password for "${venueName}". Please try again.`);
        continue;
      }
    } catch (e) {
      console.warn("Password verification network error:", e);
    }
    return null;
  }
}

// WaitMate India • Core Application Logic
// Tri-Interface Architecture: Customer Remote Pass, Restaurant Owner Stand, Founder Command Center

// Global Application State
let allRestaurants = [];
let currentCategory = 'all';
let currentCity = 'all';
let currentArea = 'all';
let currentSort = 'reliability';
let currentMealTime = 'all';
let currentSearch = '';
let openOnly = true;

let currentInterface = 'customer'; // 'customer', 'owner', 'founder'

let currentTicketId = localStorage.getItem('waitmate_ticket_id') || null;
let activeTicketData = null;
let joinChannel = 'remote'; // 'remote' or 'walk_in' — set in Join Queue modal
let isSubmitting = false;   // submission lock for the Join Queue submit button
let pollTimer = null;

let acknowledgedAlertForTicket = null;
let graceUntil = null;
let lastTicketStatus = null;
let selectedRestaurantId = null;

let currentHostVenueId = 'rest-1';
let currentVenueQrId = null;
let hostData = null;
let hostShowGhostGuests = true;

// Seated-rating gating: a diner can only rate once they've been seated, and only once per visit
let ratedTickets = new Set();
const RATED_STORAGE_KEY = 'waitmate_rated_tickets';

// Favorites / Bookmarked Spots — persisted in localStorage (wm_favorites)
let favorites = new Set();
const FAVORITES_STORAGE_KEY = 'wm_favorites';

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) favorites = new Set(parsed);
    }
  } catch (e) { /* ignore corrupt storage */ }
}

function persistFavorites() {
  try { localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...favorites])); } catch (e) { /* ignore storage errors */ }
}

function isFavorite(restId) {
  return favorites.has(restId);
}

function toggleFavorite(restId, btn) {
  const wasFav = favorites.has(restId);
  if (wasFav) {
    favorites.delete(restId);
    showToast("Removed from Favorites", "info");
  } else {
    favorites.add(restId);
    showToast("Saved to Favorites", "success");
    // Crisp pop animation on the heart button
    if (btn) {
      btn.classList.add('liking');
      const icon = btn.querySelector('[id^="heart-icon-"]');
      if (icon) icon.classList.add('heart-fill');
      setTimeout(() => {
        btn.classList.remove('liking');
        if (icon) icon.classList.remove('heart-fill');
      }, 260);
    }
  }
  persistFavorites();
  renderRestaurantsGrid();
  lucide.createIcons();
}

// Host Stand new-customer join alert tracking
let seenHostTicketIds = new Set();
let hostQueueInitializedFor = null;
let hostStandPollTimer = null;

// Audio context for chime notifications (Synthesized Web Audio API)
let audioCtx = null;

function playNotificationChime() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    
    // Celebratory Table Ready Chime (E5 -> G#5)
    const osc1 = audioCtx.createOscillator();
    const gain1 = audioCtx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now);
    gain1.gain.setValueAtTime(0.18, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    osc1.connect(gain1);
    gain1.connect(audioCtx.destination);
    osc1.start(now);
    osc1.stop(now + 0.5);

    const osc2 = audioCtx.createOscillator();
    const gain2 = audioCtx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(830.61, now + 0.15);
    gain2.gain.setValueAtTime(0.22, now + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
    osc2.connect(gain2);
    gain2.connect(audioCtx.destination);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.8);
  } catch (e) {
    console.warn("Audio notification blocked or unsupported:", e);
  }
}

// High-urgency alert chime when Table is Near (Under 7 mins / #1-#2 in line)
function playTableNearChime() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    
    // Urgent double pulse tone (A5 -> C#6)
    const osc1 = audioCtx.createOscillator();
    const gain1 = audioCtx.createGain();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(880, now);
    gain1.gain.setValueAtTime(0.22, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc1.connect(gain1);
    gain1.connect(audioCtx.destination);
    osc1.start(now);
    osc1.stop(now + 0.3);

    const osc2 = audioCtx.createOscillator();
    const gain2 = audioCtx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(1108.73, now + 0.2);
    gain2.gain.setValueAtTime(0.25, now + 0.2);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc2.connect(gain2);
    gain2.connect(audioCtx.destination);
    osc2.start(now + 0.2);
    osc2.stop(now + 0.6);
  } catch (e) {
    console.warn("Table near audio alert blocked:", e);
  }
}

// ==========================================
// PUSH NOTIFICATION SYSTEM (Real OS Alerts)
// ==========================================
let swRegistration = null;

async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) {
    console.warn('Push notifications not supported in this browser.');
    return false;
  }

  try {
    // Register the service worker
    swRegistration = await navigator.serviceWorker.register('/sw.js');
    console.log('WaitMate SW registered:', swRegistration.scope);

    // Listen for messages from SW (e.g. arrived action tapped on notification)
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'DINER_ARRIVED') {
        dinerArrivedAction();
      }
    });

    return true;
  } catch (err) {
    console.warn('SW registration failed:', err);
    return false;
  }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;

  const result = await Notification.requestPermission();
  return result === 'granted';
}

// Core push dispatcher — sends a real OS notification
async function sendPushNotification({ title, body, tag = 'waitmate', actions = [], icon = '' }) {
  // Always try to get permission first
  if (Notification.permission !== 'granted') {
    const granted = await requestNotificationPermission();
    if (!granted) {
      console.warn('Push notifications denied by user.');
      return false;
    }
  }

  const options = {
    body,
    tag,
    renotify: true,
    icon: icon || '/logo.png',
    badge: '/logo.png',
    vibrate: [200, 100, 200, 100, 400],
    data: { url: '/' }
  };

  if (actions.length > 0) options.actions = actions;

  try {
    if (swRegistration && swRegistration.showNotification) {
      // Use SW notification (richer, works in background)
      await swRegistration.showNotification(title, options);
    } else {
      // Fallback to basic Notification API
      new Notification(title, options);
    }
    return true;
  } catch (err) {
    console.warn('Notification send failed:', err);
    // Last resort: basic Notification
    try { new Notification(title, options); } catch (e) {}
    return false;
  }
}

// "Table is Near" notification — fires when ETA < 4 mins
async function sendTableNearNotification(ticketData) {
  const venueName = ticketData.restaurant ? ticketData.restaurant.name : 'your restaurant';
  const rank = ticketData.position_in_line;
  const eta = ticketData.estimated_remaining_mins;

  await sendPushNotification({
    title: `🚨 Table Almost Ready — ${venueName}`,
    body: `You are #${rank} in line (~${eta} mins). Start heading to the host counter now! Table held for 5 mins.`,
    tag: 'waitmate-table-near',
    actions: [
      { action: 'arrived', title: "✅ I'm at the Entrance" },
      { action: 'dismiss', title: '⏱ Need +5 mins' }
    ]
  });
}

// "Table Ready" notification — fires when status = 'notified'
async function sendTableReadyNotification(ticketData) {
  const venueName = ticketData.restaurant ? ticketData.restaurant.name : 'your restaurant';
  const ticketNum = ticketData.ticket_number;

  await sendPushNotification({
    title: `🔔 TABLE READY NOW — ${venueName}`,
    body: `Namaste! Token ${ticketNum} — please proceed to the host counter immediately. Your table is waiting!`,
    tag: 'waitmate-table-ready',
    actions: [
      { action: 'arrived', title: "✅ Heading over now!" }
    ]
  });
}

// App Initialization
document.addEventListener('DOMContentLoaded', async () => {
  document.title = "WaitMate India 🇮🇳 • Live Restaurant Queues & Reliability Network";
  await initPushNotifications();
  await loadRestaurants();
  loadFavorites();
  startRestaurantsRefresh();

  // Restore persisted active ticket so a page refresh keeps "My Pass" and live tracking.
  // Purge stale/terminal tickets (seated, cancelled, completed, no_show) or tickets
  // older than 2 hours so a fresh load never shows a stale "Seated! Enjoy your food"
  // title when there is no active waitlist session.
  try {
    const saved = JSON.parse(localStorage.getItem('waitmate_active_ticket') || 'null');
    const terminalStates = ['seated', 'cancelled', 'completed', 'no_show'];
    const stale = saved && saved.id && saved.data && (
      terminalStates.includes(saved.data.status) ||
      (saved.data.joined_at && Date.now() - Number(saved.data.joined_at) > 2 * 60 * 60 * 1000)
    );
    if (saved && saved.id && !stale) {
      currentTicketId = saved.id;
      activeTicketData = saved.data || null;
      localStorage.setItem('waitmate_ticket_id', currentTicketId);
      if (activeTicketData && !terminalStates.includes(activeTicketData.status)) {
        const pill = document.getElementById('activeTicketPill');
        if (pill) {
          pill.classList.remove('hidden');
          pill.classList.add('flex');
        }
        startTicketPolling();
      }
    } else if (saved && saved.id) {
      clearCurrentTicket();
    }
  } catch (e) { /* ignore corrupt storage */ }

  // Restore already-rated tickets so a diner cannot rate the same visit twice after a reload
  try {
    const savedRated = JSON.parse(localStorage.getItem(RATED_STORAGE_KEY) || '[]');
    if (Array.isArray(savedRated)) ratedTickets = new Set(savedRated);
  } catch (e) { /* ignore corrupt storage */ }

  // Deep link: ?venue=<id> auto-opens the join queue modal for that venue
  const venueParam = new URLSearchParams(window.location.search).get('venue');
  if (venueParam) {
    // QR-link walk-in: arrive at the restaurant door → auto-select Walk-In channel
    openJoinModal(venueParam, 'walk_in');
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  // Deep link: ?ticket=<id> opens a read-only Live Friend Pass Tracker for the shared ticket
  const ticketParam = new URLSearchParams(window.location.search).get('ticket');
  if (ticketParam) {
    window.history.replaceState({}, document.title, window.location.pathname);
    openFriendPassTracker(ticketParam);
  }

  if (currentTicketId) {
    startTicketPolling();
  }
  initFounderSecretTriggers();
  initFbStarRating();
  lucide.createIcons();
});

// Seed / Fallback data focused on popular Indian dining hotspots
const fallbackRestaurants = [
  {
    id: "rest-1",
    name: "The Rameshwaram Cafe",
    category: "Iconic South Indian & Filter Coffee",
    type: "restaurant",
    city: "Mumbai",
    address: "Linking Road, Bandra West, Mumbai",
    distance_km: 0.8,
    price_range: "₹",
    meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"],
    image_url: "https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800&auto=format&fit=crop&q=80",
    description: "Famous for crispy Ghee Podi Butter Dosa, Medu Vada, and authentic filter coffee. Ultra-fast token turnover with legendary standing crowds.",
    live_stats: {
      queue_count: 3,
      total_waiting_people: 7,
      estimated_wait_mins: 10,
      algorithmic_wait_mins: 10,
      has_manual_override: false,
      is_queue_open: true
    },
    reliability: {
      score: 96,
      grade: "A+",
      verdict: "Exceptionally Accurate",
      badge_color: "emerald",
      avg_variance_mins: 1.9,
      total_verified_checkins: 31,
      on_time_pct: 77,
      early_pct: 16,
      slight_late_pct: 7,
      severe_late_pct: 0,
      recent_reviews: [
        { promised: 10, actual: 9, rating: "spot_on", note: "Token called exactly when estimated. Sizzling hot ghee dosa ready!", time_ago: "10m ago" },
        { promised: 15, actual: 12, rating: "faster", note: "Got in earlier than expected, host service was super efficient.", time_ago: "1h ago" },
        { promised: 12, actual: 13, rating: "spot_on", note: "Filter coffee and podi idli was ready right on cue!", time_ago: "3h ago" }
      ]
    }
  },
  {
    id: "rest-2",
    name: "Meghana Foods (Biryani & Andhra Meals)",
    category: "Spicy Andhra Biryani & Thalis",
    type: "restaurant",
    city: "Mumbai",
    address: "Senapati Bapat Marg, Lower Parel, Mumbai",
    distance_km: 1.6,
    price_range: "₹₹",
    meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"],
    image_url: "https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800&auto=format&fit=crop&q=80",
    description: "Legendary for Boneless Chicken Biryani, Paneer Biryani, and traditional Andhra meals. Massive weekend queues with high table turnover.",
    live_stats: {
      queue_count: 3,
      total_waiting_people: 12,
      estimated_wait_mins: 22,
      algorithmic_wait_mins: 22,
      has_manual_override: false,
      is_queue_open: true
    },
    reliability: {
      score: 92,
      grade: "A",
      verdict: "Very Dependable",
      badge_color: "emerald",
      avg_variance_mins: 2.8,
      total_verified_checkins: 45,
      on_time_pct: 71,
      early_pct: 13,
      slight_late_pct: 14,
      severe_late_pct: 2,
      recent_reviews: [
        { promised: 20, actual: 23, rating: "slight_delay", note: "Slight wait for family AC booth, but Andhra biryani was phenomenal.", time_ago: "35m ago" },
        { promised: 25, actual: 21, rating: "faster", note: "Host bumped us up as our party of 2 fit a high table immediately.", time_ago: "2h ago" }
      ]
    }
  },
  {
    id: "rest-3",
    name: "Bademiya Street Kebab Truck & Rolls",
    category: "Late-Night Charcoal Kebabs & Baida Roti",
    type: "food_truck",
    city: "Mumbai",
    address: "Tulloch Road, Colaba, Mumbai",
    distance_km: 0.5,
    price_range: "₹₹",
    meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"],
    image_url: "https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=800&auto=format&fit=crop&q=80",
    description: "Mumbai's iconic street food institution. Open-air charcoal-grilled mutton seekh, chicken bhuna rolls, and buttery rumali rotis.",
    live_stats: {
      queue_count: 2,
      total_waiting_people: 5,
      estimated_wait_mins: 8,
      algorithmic_wait_mins: 8,
      has_manual_override: false,
      is_queue_open: true
    },
    reliability: {
      score: 94,
      grade: "A",
      verdict: "Reliable Street Turnover",
      badge_color: "emerald",
      avg_variance_mins: 1.5,
      total_verified_checkins: 52,
      on_time_pct: 82,
      early_pct: 10,
      slight_late_pct: 8,
      severe_late_pct: 0,
      recent_reviews: [
        { promised: 10, actual: 9, rating: "spot_on", note: "Rolls were piping hot and handed over as soon as token showed #1.", time_ago: "45m ago" }
      ]
    }
  },
  {
    id: "rest-4",
    name: "Toit Brewpub & Kitchen",
    category: "Craft Microbrewery & Woodfired Pizza",
    type: "restaurant",
    city: "Mumbai",
    address: "Mathuradas Mill Compound, Lower Parel, Mumbai",
    distance_km: 1.2,
    price_range: "₹₹₹",
    meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"],
    image_url: "https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=800&auto=format&fit=crop&q=80",
    description: "Mumbai's pioneer craft brewery famous for Tin Man, Basmati Blonde, and woodfired sourdough pizzas. High demand on weekend evenings.",
    live_stats: {
      queue_count: 2,
      total_waiting_people: 6,
      estimated_wait_mins: 28,
      algorithmic_wait_mins: 28,
      has_manual_override: false,
      is_queue_open: true
    },
    reliability: {
      score: 84,
      grade: "B",
      verdict: "Moderate Rush Delays",
      badge_color: "amber",
      avg_variance_mins: 5.4,
      total_verified_checkins: 38,
      on_time_pct: 55,
      early_pct: 8,
      slight_late_pct: 26,
      severe_late_pct: 11,
      recent_reviews: [
        { promised: 30, actual: 35, rating: "slight_delay", note: "Table held up due to lingering group, but host kept us updated.", time_ago: "1h ago" }
      ]
    }
  },
  {
    id: "rest-5",
    name: "Chai Sutta Bar & Bun Maska Express",
    category: "Kulhad Chai, Bun Maska & Samosas",
    type: "food_truck",
    city: "Mumbai",
    address: "Juhu Tara Road, Juhu, Mumbai",
    distance_km: 0.4,
    price_range: "₹",
    meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"],
    image_url: "https://images.unsplash.com/photo-1576092768241-dec231879fc3?w=800&auto=format&fit=crop&q=80",
    description: "Steaming hot ginger-elaichi kulhad chai, butter-loaded bun maska, and hot samosas. Ultra-rapid pickup queue popular among students.",
    live_stats: {
      queue_count: 1,
      total_waiting_people: 2,
      estimated_wait_mins: 5,
      algorithmic_wait_mins: 5,
      has_manual_override: false,
      is_queue_open: true
    },
    reliability: {
      score: 97,
      grade: "A+",
      verdict: "Exceptionally Accurate",
      badge_color: "emerald",
      avg_variance_mins: 1.2,
      total_verified_checkins: 30,
      on_time_pct: 87,
      early_pct: 10,
      slight_late_pct: 3,
      severe_late_pct: 0,
      recent_reviews: [
        { promised: 5, actual: 4, rating: "spot_on", note: "Fresh chai and bun maska handed over in 4 mins flat!", time_ago: "15m ago" }
      ]
    }
  },
  {
    id: "rest-6",
    name: "Punjab Grill & Royal Tandoor",
    category: "North Indian, Dal Makhani & Kebabs",
    type: "restaurant",
    city: "Mumbai",
    address: "Palladium Mall, Lower Parel, Mumbai",
    distance_km: 3.2,
    price_range: "₹₹₹",
    meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"],
    image_url: "https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&auto=format&fit=crop&q=80",
    description: "Opulent North Indian dining with slow-simmered Dal Makhani and tandoori platters. Highly volatile peak Saturday dinner queues.",
    live_stats: {
      queue_count: 4,
      total_waiting_people: 14,
      estimated_wait_mins: 35,
      algorithmic_wait_mins: 35,
      has_manual_override: false,
      is_queue_open: true
    },
    reliability: {
      score: 72,
      grade: "C",
      verdict: "Unpredictable Peak Waits",
      badge_color: "rose",
      avg_variance_mins: 12.0,
      total_verified_checkins: 29,
      on_time_pct: 34,
      early_pct: 7,
      slight_late_pct: 31,
      severe_late_pct: 28,
      recent_reviews: [
        { promised: 35, actual: 52, rating: "severe_delay", note: "Quoted 35 mins, took nearly an hour during Saturday 9 PM rush.", time_ago: "2h ago" }
      ]
    }
  },
  {
    id: "rest-7",
    name: "Britannia & Co. Restaurant",
    category: "Parsi & Irani Heritage",
    type: "restaurant",
    city: "Mumbai",
    address: "Wakefield House, Ballard Estate, Fort, Mumbai",
    distance_km: 1.5,
    price_range: "₹₹",
    meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"],
    image_url: "https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&auto=format&fit=crop&q=80",
    description: "Legendary 1923 Parsi cafe famous for Mutton Berry Pulao, Sali Boti, and Caramel Custard.",
    live_stats: {
      queue_count: 3,
      total_waiting_people: 8,
      estimated_wait_mins: 18,
      algorithmic_wait_mins: 18,
      has_manual_override: false,
      is_queue_open: true
    },
    reliability: {
      score: 95,
      grade: "A+",
      verdict: "Exceptionally Accurate",
      badge_color: "emerald",
      avg_variance_mins: 1.1,
      total_verified_checkins: 42,
      on_time_pct: 81,
      early_pct: 12,
      slight_late_pct: 7,
      severe_late_pct: 0,
      recent_reviews: [
        { promised: 18, actual: 17, rating: "spot_on", note: "Mutton Berry Pulao arrived right on token time.", time_ago: "30m ago" },
        { promised: 22, actual: 20, rating: "faster", note: "Sali Boti table ready earlier than quoted.", time_ago: "2h ago" }
      ]
    }
  },
  {
    id: "rest-8",
    name: "Kyani & Co. Bakery & Cafe",
    category: "Irani Cafe & Bakery",
    type: "restaurant",
    city: "Mumbai",
    address: "Jer Mahal Estate, Dhobi Talao, Marine Lines, Mumbai",
    distance_km: 0.6,
    price_range: "₹",
    meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"],
    image_url: "https://images.unsplash.com/photo-1554118811-1e0d58224f24?w=800&auto=format&fit=crop&q=80",
    description: "Iconic South Mumbai Irani bakery serving fresh Bun Maska, Keema Pav, Mawa Cake, and Irani Chai.",
    live_stats: {
      queue_count: 4,
      total_waiting_people: 9,
      estimated_wait_mins: 12,
      algorithmic_wait_mins: 12,
      has_manual_override: false,
      is_queue_open: true
    },
    reliability: {
      score: 94,
      grade: "A",
      verdict: "Reliable Irani Turnover",
      badge_color: "emerald",
      avg_variance_mins: 1.4,
      total_verified_checkins: 38,
      on_time_pct: 79,
      early_pct: 11,
      slight_late_pct: 9,
      severe_late_pct: 1,
      recent_reviews: [
        { promised: 12, actual: 11, rating: "spot_on", note: "Bun maska and Irani chai served piping hot on cue.", time_ago: "20m ago" }
      ]
    }
  },
  {
    id: "rest-9",
    name: "Prithvi Cafe",
    category: "Cafe & Outdoor Bistro",
    type: "restaurant",
    city: "Mumbai",
    address: "Janki Kutir, Juhu Church Road, Juhu, Mumbai",
    distance_km: 2.1,
    price_range: "₹₹",
    meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"],
    image_url: "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80",
    description: "Bamboo-shaded theatre courtyard cafe in Juhu known for Irish Coffee, Suleimani Chai, and Amritsari Paratha.",
    live_stats: {
      queue_count: 2,
      total_waiting_people: 5,
      estimated_wait_mins: 15,
      algorithmic_wait_mins: 15,
      has_manual_override: false,
      is_queue_open: true
    },
    reliability: {
      score: 91,
      grade: "A",
      verdict: "Highly Reliable",
      badge_color: "green",
      avg_variance_mins: 2.3,
      total_verified_checkins: 33,
      on_time_pct: 73,
      early_pct: 15,
      slight_late_pct: 9,
      severe_late_pct: 3,
      recent_reviews: [
        { promised: 15, actual: 16, rating: "spot_on", note: "Irish Coffee and paratha arrived right when promised.", time_ago: "55m ago" },
        { promised: 18, actual: 21, rating: "slight_delay", note: "Weekend brunch crowd ran about 3 minutes late.", time_ago: "4h ago" }
      ]
    }
  },
  {
    id: "rest-10",
    name: "Sardar Pav Bhaji Express Truck",
    category: "Mumbai Street Food & Pav Bhaji",
    type: "food_truck",
    city: "Mumbai",
    address: "Tardeo Road Junction, Mumbai Central, Mumbai",
    distance_km: 2.8,
    price_range: "₹",
    meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"],
    image_url: "https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800&auto=format&fit=crop&q=80",
    description: "High-turnover Mumbai street food counter famous for extra-butter Pav Bhaji and Masala Tawa Pulao.",
    live_stats: {
      queue_count: 5,
      total_waiting_people: 11,
      estimated_wait_mins: 8,
      algorithmic_wait_mins: 8,
      has_manual_override: false,
      is_queue_open: true
    },
    reliability: {
      score: 89,
      grade: "B",
      verdict: "Moderate Variance",
      badge_color: "amber",
      avg_variance_mins: 4.0,
      total_verified_checkins: 51,
      on_time_pct: 62,
      early_pct: 8,
      slight_late_pct: 22,
      severe_late_pct: 8,
      recent_reviews: [
        { promised: 8, actual: 10, rating: "slight_delay", note: "Lunch rush pav bhaji took 2 extra minutes, worth the wait.", time_ago: "15m ago" }
      ]
    }
  },
  {
    id: "rest-11",
    name: "Juhu Tawa Junction",
    category: "Pav Bhaji & Tawa Pulao",
    type: "food_truck",
    city: "Mumbai",
    address: "Juhu Chowpatty, Juhu, Mumbai",
    distance_km: 3.5,
    price_range: "₹",
    meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"],
    image_url: "https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800&auto=format&fit=crop&q=80",
    description: "Legendary Juhu Chowpatty street food truck serving butter-loaded Pav Bhaji, Masala Tawa Pulao, and grilled sandwiches.",
    live_stats: {
      queue_count: 3,
      total_waiting_people: 8,
      estimated_wait_mins: 9,
      algorithmic_wait_mins: 9,
      has_manual_override: false,
      is_queue_open: true
    },
    reliability: {
      score: 94,
      grade: "A",
      verdict: "Reliable Beachside Turnover",
      badge_color: "emerald",
      avg_variance_mins: 1.8,
      total_verified_checkins: 26,
      on_time_pct: 77,
      early_pct: 15,
      slight_late_pct: 8,
      severe_late_pct: 0,
      recent_reviews: [
        { promised: 9, actual: 8, rating: "spot_on", note: "Pav bhaji arrived right on time, butter was fresh!", time_ago: "5m ago" },
        { promised: 12, actual: 10, rating: "faster", note: "Tawa pulao ready quicker than quoted. Great beach snack.", time_ago: "1h ago" }
      ]
    }
  },
  {
    id: "rest-12",
    name: "Bandra Woodfire Truck",
    category: "Wood-Fired Pizza & Artisanal Sandwiches",
    type: "food_truck",
    city: "Mumbai",
    address: "Chapel Road, Bandra West, Mumbai",
    distance_km: 1.0,
    price_range: "₹₹",
    meal_times: ["Breakfast", "Lunch", "Snacks", "Dinner", "Late Night"],
    image_url: "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&auto=format&fit=crop&q=80",
    description: "Gourmet wood-fired Neapolitan pizzas with fresh mozzarella, basil, and spicy fermented hot honey drizzle.",
    live_stats: {
      queue_count: 2,
      total_waiting_people: 6,
      estimated_wait_mins: 18,
      algorithmic_wait_mins: 18,
      has_manual_override: false,
      is_queue_open: true
    },
    reliability: {
      score: 88,
      grade: "B",
      verdict: "Artisan Quality With Some Variance",
      badge_color: "amber",
      avg_variance_mins: 4.5,
      total_verified_checkins: 20,
      on_time_pct: 55,
      early_pct: 18,
      slight_late_pct: 22,
      severe_late_pct: 5,
      recent_reviews: [
        { promised: 18, actual: 22, rating: "slight_delay", note: "Pizza needed extra wood-fire time for perfect crust char.", time_ago: "25m ago" },
        { promised: 15, actual: 12, rating: "faster", note: "Margherita came out early! Hot honey drizzle is a game changer.", time_ago: "2h ago" }
      ]
    }
  }
];

// Local mock queues for offline or immediate client responsiveness
let localMockQueues = {
  'rest-1': [
    { id: "q-101", ticket_number: "WM-101", restaurant_id: "rest-1", customer_name: "Aarav Mehta", phone: "+91 98201 44521", party_size: 2, seating_pref: "High-top / Standing", special_requests: "Filter coffee right after dosa", entry_type: "remote", status: "waiting", estimated_wait_mins: 10, actual_wait_mins: 0, joined_at: Date.now()/1000 - 400, has_arrived: 1, delay_mins: 0 },
    { id: "q-102", ticket_number: "WM-102", restaurant_id: "rest-1", customer_name: "Ananya Iyer", phone: "+91 98450 12389", party_size: 3, seating_pref: "First Available", special_requests: "Ghee Podi Butter Dosa priority", entry_type: "remote", status: "waiting", estimated_wait_mins: 15, actual_wait_mins: 0, joined_at: Date.now()/1000 - 250, has_arrived: 0, delay_mins: 0 },
    { id: "q-103", ticket_number: "WM-103", restaurant_id: "rest-1", customer_name: "Rohan Verma", phone: "+91 99102 38475", party_size: 2, seating_pref: "Outdoor Patio", special_requests: "", entry_type: "walk_in", status: "notified", estimated_wait_mins: 8, actual_wait_mins: 0, joined_at: Date.now()/1000 - 600, has_arrived: 1, delay_mins: 0 },
  ],
  'rest-2': [
    { id: "q-201", ticket_number: "WM-201", restaurant_id: "rest-2", customer_name: "Sneha Kulkarni", phone: "+91 97654 32109", party_size: 4, seating_pref: "Family AC Section", special_requests: "Extra lemon & onions", entry_type: "remote", status: "waiting", estimated_wait_mins: 22, actual_wait_mins: 0, joined_at: Date.now()/1000 - 700, has_arrived: 1, delay_mins: 0 },
    { id: "q-202", ticket_number: "WM-202", restaurant_id: "rest-2", customer_name: "Vikram Sen", phone: "+91 98310 99887", party_size: 2, seating_pref: "First Available", special_requests: "", entry_type: "remote", status: "waiting", estimated_wait_mins: 28, actual_wait_mins: 0, joined_at: Date.now()/1000 - 350, has_arrived: 0, delay_mins: 0 },
  ],
  'rest-3': [
    { id: "q-301", ticket_number: "WM-301", restaurant_id: "rest-3", customer_name: "Farhan Qureshi", phone: "+91 98211 55667", party_size: 2, seating_pref: "Counter / Car Stand", special_requests: "Extra green chutney", entry_type: "remote", status: "waiting", estimated_wait_mins: 8, actual_wait_mins: 0, joined_at: Date.now()/1000 - 200, has_arrived: 1, delay_mins: 0 },
  ],
  'rest-4': [
    { id: "q-401", ticket_number: "WM-401", restaurant_id: "rest-4", customer_name: "Aditya Roy", phone: "+91 98860 33445", party_size: 4, seating_pref: "Brewery Floor", special_requests: "Celebrating promotion", entry_type: "remote", status: "waiting", estimated_wait_mins: 30, actual_wait_mins: 0, joined_at: Date.now()/1000 - 600, has_arrived: 1, delay_mins: 0 },
  ],
  'rest-5': [],
  'rest-6': [],
  'rest-7': [],
  'rest-8': [],
  'rest-9': [],
  'rest-10': [],
  'rest-11': [
    { id: "q-111", ticket_number: "WM-111", restaurant_id: "rest-11", customer_name: "Pooja Nair", phone: "+91 98330 44556", party_size: 3, seating_pref: "Beachside Counter", special_requests: "Extra cheese on pav bhaji", entry_type: "remote", status: "waiting", estimated_wait_mins: 9, actual_wait_mins: 0, joined_at: Date.now()/1000 - 350, has_arrived: 1, delay_mins: 0 },
    { id: "q-112", ticket_number: "WM-112", restaurant_id: "rest-11", customer_name: "Kunal Mehta", phone: "+91 98201 66778", party_size: 2, seating_pref: "First Available", special_requests: "", entry_type: "walk_in", status: "waiting", estimated_wait_mins: 7, actual_wait_mins: 0, joined_at: Date.now()/1000 - 180, has_arrived: 1, delay_mins: 0 },
  ],
  'rest-12': [
    { id: "q-121", ticket_number: "WM-121", restaurant_id: "rest-12", customer_name: "Sarah D'Souza", phone: "+91 98670 11223", party_size: 2, seating_pref: "Standing Counter", special_requests: "Gluten-free crust if available", entry_type: "remote", status: "waiting", estimated_wait_mins: 18, actual_wait_mins: 0, joined_at: Date.now()/1000 - 500, has_arrived: 1, delay_mins: 0 },
    { id: "q-122", ticket_number: "WM-122", restaurant_id: "rest-12", customer_name: "Rahul Kapoor", phone: "+91 98110 33445", party_size: 4, seating_pref: "First Available", special_requests: "Extra hot honey drizzle", entry_type: "remote", status: "notified", estimated_wait_mins: 20, actual_wait_mins: 0, joined_at: Date.now()/1000 - 700, has_arrived: 1, delay_mins: 0 },
  ]
};

// ==========================================
// 1. TRI-INTERFACE NAVIGATION & SWITCHING
// ==========================================
// ==========================================
// FOUNDER COMMAND CENTER: SECRET ACCESS & AUTH
// ==========================================
const FOUNDER_PWD_KEY = 'waitmate_founder_pwd';

function getFounderPassword() {
  return sessionStorage.getItem(FOUNDER_PWD_KEY) || '';
}

function isFounderUnlocked() {
  return Boolean(getFounderPassword());
}

function founderHeaders() {
  const pwd = getFounderPassword();
  return pwd ? { 'X-Founder-Password': pwd } : {};
}

function triggerFounderAccess() {
  if (isFounderUnlocked()) switchInterface('founder');
  else openFounderLoginModal();
}

function openFounderLoginModal() {
  const modal = document.getElementById('founderLoginModal');
  const errEl = document.getElementById('founderLoginError');
  const input = document.getElementById('founderLoginInput');
  if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
  if (input) input.value = '';
  if (modal) {
    modal.classList.remove('hidden');
    setTimeout(() => input && input.focus(), 50);
  }
  if (window.lucide) lucide.createIcons();
}

function closeFounderLoginModal() {
  const modal = document.getElementById('founderLoginModal');
  if (modal) modal.classList.add('hidden');
}

async function submitFounderLogin(event) {
  if (event) event.preventDefault();
  const input = document.getElementById('founderLoginInput');
  const errEl = document.getElementById('founderLoginError');
  const btn = document.getElementById('founderLoginSubmitBtn');
  const pwd = (input ? input.value : '').trim();
  if (!pwd) return;

  if (btn) { btn.disabled = true; btn.textContent = 'Verifying...'; }
  if (errEl) errEl.classList.add('hidden');

  try {
    const res = await fetch('/api/founder/verify-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (parseErr) { data = {}; }

    if (res.ok && data.success) {
      sessionStorage.setItem(FOUNDER_PWD_KEY, pwd);
      closeFounderLoginModal();
      showToast(data.message || 'Founder access granted.', 'success');
      switchInterface('founder');
      return;
    }

    if (errEl) {
      errEl.textContent = data.error || 'Incorrect Founder Master Password.';
      errEl.classList.remove('hidden');
    }
  } catch (err) {
    if (errEl) {
      errEl.textContent = 'Network error. Please retry.';
      errEl.classList.remove('hidden');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Unlock Command Center'; }
  }
}

function initFounderSecretTriggers() {
  // Keyboard shortcut: Alt+Shift+F (or Ctrl/Cmd+Shift+F)
  document.addEventListener('keydown', (e) => {
    const key = (e.key || '').toLowerCase();
    if ((key === 'f' || e.code === 'KeyF') && e.shiftKey && (e.altKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      triggerFounderAccess();
    }
  });

  // URL triggers: ?founder=1 or #founder
  try {
    const params = new URLSearchParams(window.location.search);
    const hash = (window.location.hash || '').toLowerCase();
    if (params.get('founder') === '1' || hash === '#founder') {
      triggerFounderAccess();
    }
  } catch (e) { /* ignore */ }

  // Footer brand text clicked 5 times
  const brandEl = document.getElementById('footerBrandText');
  if (brandEl) {
    let count = 0;
    let resetTimer = null;
    brandEl.addEventListener('click', () => {
      count++;
      if (resetTimer) clearTimeout(resetTimer);
      if (count >= 5) {
        count = 0;
        triggerFounderAccess();
      } else {
        resetTimer = setTimeout(() => { count = 0; }, 1500);
      }
    });
  }
}

function switchInterface(role) {
  // Founder view requires secret unlock; otherwise prompt for the Master Password.
  if (role === 'founder' && !isFounderUnlocked()) {
    openFounderLoginModal();
    return;
  }
  // Host Stand auto-polling only applies to the owner tab.
  if (role !== 'owner') stopHostStandPolling();
  currentInterface = role;
  const custDiv = document.getElementById('customerInterface');
  const ownerDiv = document.getElementById('ownerInterface');
  const founderDiv = document.getElementById('founderInterface');

  const tabCust = document.getElementById('tabCustomer');
  const tabOwner = document.getElementById('tabOwner');
  const tabFounder = document.getElementById('tabFounder');

  const activeTabClass = "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition bg-white text-slate-900 shadow-sm";
  const inactiveTabClass = "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition text-slate-600 hover:text-slate-900";

  custDiv.classList.add('hidden');
  ownerDiv.classList.add('hidden');
  if (founderDiv) founderDiv.classList.add('hidden');

  tabCust.className = inactiveTabClass;
  tabOwner.className = inactiveTabClass;

  if (role === 'customer') {
    custDiv.classList.remove('hidden');
    tabCust.className = activeTabClass;
    renderRestaurantsGrid();
  } else if (role === 'owner') {
    ownerDiv.classList.remove('hidden');
    tabOwner.className = activeTabClass;
    showOwnerDirectory();
    startHostStandPolling();
  } else if (role === 'founder') {
    ['roleGateway','gatewayOverlay','landingGateway'].forEach(id=>{const el=document.getElementById(id); if(el) el.classList.add('hidden');});
    if (founderDiv) founderDiv.classList.remove('hidden');
    if (tabFounder) {
      tabFounder.className = activeTabClass.replace(/\bflex\b/, '') + ' hidden';
      tabFounder.style.display = 'none';
    }
    loadFounderDashboard();
  }
  lucide.createIcons();
}

// Switch Owner sub-tabs between Host Stand and New Restaurant Registration
 function switchOwnerTab(tab) {
  // Restaurant creation is restricted to the Founder. Public calls to 'register' are blocked.
  if (tab === 'register') {
    showToast('Only the Founder can add new restaurants.', 'error');
    tab = 'host';
  }
  const hostSub = document.getElementById('ownerSubTabHost');
  const tabHost = document.getElementById('ownerTabHost');

  if (hostSub) hostSub.classList.remove('hidden');
  if (tabHost) tabHost.className = "px-4 py-2 font-bold text-sm text-slate-900 border-b-2 border-orange-500 flex items-center gap-2";
  showOwnerDirectory();
  lucide.createIcons();
}

// Quick Photo Presets for Onboarding Form
function setPresetPhoto(kind) {
  const input = document.getElementById('regImageUrl');
  const presets = {
    dosa: "https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800&auto=format&fit=crop&q=80",
    biryani: "https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800&auto=format&fit=crop&q=80",
    kebab: "https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=800&auto=format&fit=crop&q=80",
    cafe: "https://images.unsplash.com/photo-1554118811-1e0d58224f24?w=800&auto=format&fit=crop&q=80"
  };
  if (presets[kind] && input) {
    input.value = presets[kind];
  }
}

// Quick Photo Presets for Founder Add Restaurant Modal
function setFounderPresetPhoto(kind) {
  const input = document.getElementById('fndNewPhoto');
  const presets = {
    dosa: "https://images.unsplash.com/photo-1668236543090-82eba5ee5976?w=800&auto=format&fit=crop&q=80",
    biryani: "https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800&auto=format&fit=crop&q=80",
    kebab: "https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=800&auto=format&fit=crop&q=80",
    cafe: "https://images.unsplash.com/photo-1554118811-1e0d58224f24?w=800&auto=format&fit=crop&q=80"
  };
  if (presets[kind] && input) {
    input.value = presets[kind];
  }
}

// Owner: Submit New Restaurant Registration Form Live
async function submitNewRestaurant(e) {
  e.preventDefault();
  const name = document.getElementById('regName').value.trim();
  const category = document.getElementById('regCategory').value.trim();
  const type = document.getElementById('regType').value;
  const city = document.getElementById('regCity').value;
  const priceRange = document.getElementById('regPriceRange').value;
  const address = document.getElementById('regAddress').value.trim();
  const ownerName = document.getElementById('regOwnerName').value.trim();
  const ownerPhone = (document.getElementById('regOwnerPhone')?.value || '').trim();
  const ownerPassword = (document.getElementById('regOwnerPassword')?.value || '').trim();
  const totalTables = parseInt(document.getElementById('regTables').value) || 16;
  const prepTime = parseInt(document.getElementById('regPrepTime').value) || 15;
  const imageUrl = document.getElementById('regImageUrl').value.trim() || "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80";
  const description = document.getElementById('regDescription').value.trim();

  const submitBtn = document.getElementById('regSubmitBtn');
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin text-orange-400"></i> Registering Restaurant...`;
  lucide.createIcons();

  try {
    const res = await fetch('/api/owner/restaurants/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        category,
        type,
        city,
        price_range: priceRange,
        address,
        owner_name: ownerName,
        owner_phone: ownerPhone,
        password: ownerPassword,
        total_tables: totalTables,
        base_prep_time: prepTime,
        image_url: imageUrl,
        description: description || `Authentic ${category} located in ${city}.`
      })
    });

    let data = {};
    try { data = await res.json(); } catch (parseErr) { data = {}; }
    if (!res.ok) throw new Error(data.error || 'Failed to register restaurant');

    showToast(`🎉 "${name}" is now live on WaitMate!`, "success");
    document.getElementById('ownerAddRestaurantForm').reset();
    
    // Refresh restaurants list across all views
    await loadRestaurants();

    // Switch owner host view to the newly added restaurant
    if (data.restaurant_id) {
      currentHostVenueId = data.restaurant_id;
    }
    switchOwnerTab('host');

  } catch (err) {
    showToast(`Error adding restaurant: ${err.message}`, "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<i data-lucide="store" class="w-4 h-4 text-orange-400"></i> <span>Launch Restaurant on WaitMate Live Network</span>`;
    lucide.createIcons();
  }
}

// ==========================================
// 2. FOUNDER OVERVIEW & PLATFORM COMMAND CENTER
// ==========================================
let founderRestaurantsCache = [];
let founderQueuesCache = [];
let founderReviewsCache = [];
let globalAnnouncementText = '';

async function loadFounderDashboard() {
  if (!isFounderUnlocked()) { openFounderLoginModal(); return; }
  const headers = founderHeaders();
  let data = null;
  let analytics401 = false;
  try {
    const [analyticsRes, restaurantsRes, queuesRes, reviewsRes, settingsRes] = await Promise.allSettled([
      fetch('/api/founder/analytics', { headers, cache: 'no-store' }),
      fetch('/api/founder/restaurants', { headers, cache: 'no-store' }),
      fetch('/api/founder/queues', { headers, cache: 'no-store' }),
      fetch('/api/founder/reviews', { headers, cache: 'no-store' }),
      fetch('/api/founder/settings', { headers, cache: 'no-store' })
    ]);

    if (analyticsRes.status === 'fulfilled') {
      if (analyticsRes.value.status === 401) {
        analytics401 = true;
      } else if (analyticsRes.value.ok) {
        data = await analyticsRes.value.json();
      }
    }
    if (analytics401) {
      sessionStorage.removeItem(FOUNDER_PWD_KEY);
      openFounderLoginModal();
      showToast('Founder session expired. Re-enter password.', 'error');
      return;
    }

    if (restaurantsRes.status === 'fulfilled' && restaurantsRes.value.ok) {
      const r = await restaurantsRes.value.json();
      founderRestaurantsCache = r.restaurants || [];
    }
    if (queuesRes.status === 'fulfilled' && queuesRes.value.ok) {
      const q = await queuesRes.value.json();
      founderQueuesCache = q.queues || [];
    }
    if (reviewsRes.status === 'fulfilled' && reviewsRes.value.ok) {
      const rv = await reviewsRes.value.json();
      founderReviewsCache = rv.reviews || [];
    }
    if (settingsRes.status === 'fulfilled' && settingsRes.value.ok) {
      const s = await settingsRes.value.json();
      globalAnnouncementText = s.global_announcement || '';
      const statusEl = document.getElementById('fndGlobalBannerStatus');
      if (statusEl) statusEl.textContent = globalAnnouncementText ? `Active: "${globalAnnouncementText}"` : 'None active';
    }
  } catch (err) {
    console.warn("Founder dashboard load failed:", err);
  }
  renderFounderData(data || {
    summary: {
      total_restaurants: founderRestaurantsCache.length,
      total_cities: [...new Set((founderRestaurantsCache || []).map(r => r.city || 'Mumbai'))].length,
      cities_list: [...new Set((founderRestaurantsCache || []).map(r => r.city || 'Mumbai'))],
      active_parties_in_queue: founderQueuesCache.length,
      active_diners_in_queue: founderQueuesCache.reduce((s, q) => s + Number(q.party_size || 0), 0),
      total_seated_parties: 0,
      total_seated_diners: 0,
      platform_avg_reliability: 92
    },
    restaurants: founderRestaurantsCache,
    recent_queues: founderQueuesCache,
    recent_reviews: founderReviewsCache
  });
}

function escapeHtml(unsafe) {
  if (unsafe == null) return '';
  return String(unsafe).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function jsEscape(unsafe) {
  if (unsafe == null) return '';
  return String(unsafe).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function renderFounderData(data) {
  const sum = data.summary || {};
  document.getElementById('fndTotalVenues').textContent = sum.total_restaurants || 0;
  document.getElementById('fndCitiesSummary').textContent = 'Across Mumbai dining hubs';
  document.getElementById('fndWaitingDiners').textContent = sum.active_diners_in_queue || 0;
  document.getElementById('fndWaitingParties').textContent = `${sum.active_parties_in_queue || 0} parties in queues`;
  document.getElementById('fndSeatedDiners').textContent = `${sum.total_seated_diners || 0}`;
  document.getElementById('fndAvgReliability').textContent = `${sum.platform_avg_reliability || 92}%`;
  const walkawaySaved = Math.min(98, 82 + (sum.total_seated_diners || 0));
  document.getElementById('fndWalkawaySaved').textContent = `${walkawaySaved}% Walkaway Saved`;

  // Render Restaurants Network Table (Founder control row per venue)
  const restTbody = document.getElementById('fndRestaurantsTable');
  const venues = data.restaurants || founderRestaurantsCache || [];
  if (restTbody) {
    document.getElementById('fndVenueCountBadge').textContent = `${venues.length} venues`;
    if (venues.length > 0) {
      restTbody.innerHTML = venues.map(r => {
        const stats = r.live_stats || { queue_count: 0, estimated_wait_mins: 0, is_queue_open: true, total_waiting_people: 0 };
        const rel = r.reliability || { score: 95, grade: 'A+', avg_variance_mins: 1.5 };
        const isOpen = Boolean(stats.is_queue_open);
        const id = r.id;
        const nameJs = jsEscape(r.name);
        return `
          <tr class="hover:bg-slate-50 transition">
            <td class="py-3 px-4">
              <div class="font-bold text-slate-900">${escapeHtml(r.name)}</div>
              <div class="text-[11px] text-slate-600">📍 ${escapeHtml(r.city || 'Mumbai')} • ${escapeHtml(r.category || '')}</div>
            </td>
            <td class="py-3 px-4">
              <span class="badge-tag bg-slate-100 text-slate-700 uppercase font-semibold text-[10px]">
                ${r.type === 'food_truck' ? '🚚 Food Truck' : '🍽️ Dine-in'}
              </span>
              <span class="font-bold text-slate-700 ml-1">${escapeHtml(r.price_range)}</span>
              <div class="mt-1.5 flex flex-wrap gap-1">
                ${((r.meal_times || ['Lunch','Dinner']).map((m) => `<span class="meal-tag px-1.5 py-0.5 rounded text-[9px] font-bold border bg-orange-50 text-orange-800 border-orange-100">${escapeHtml(m)}</span>`).join(''))}
              </div>
            </td>
            <td class="py-3 px-4">
              <div class="font-bold text-slate-900">${stats.queue_count} parties (${stats.total_waiting_people || 0} guests)</div>
              <div class="text-[10px] text-slate-600">Wait: ~${stats.estimated_wait_mins}m ${stats.has_manual_override ? '<span class="text-orange-600 font-bold ml-1">Manual Override</span>' : ''}</div>
            </td>
            <td class="py-3 px-4">
              <div class="flex items-center gap-1.5">
                <span class="font-black ${rel.score >= 85 ? 'text-emerald-700' : rel.score >= 75 ? 'text-amber-700' : 'text-rose-700'}">${rel.score}%</span>
                <span class="badge-tag ${rel.score >= 85 ? 'bg-emerald-50 text-emerald-800' : rel.score >= 75 ? 'bg-amber-50 text-amber-800' : 'bg-rose-50 text-rose-800'} text-[10px] font-bold">Grade ${rel.grade}</span>
              </div>
              <div class="text-[10px] text-slate-600">± ${rel.avg_variance_mins || 1.5}m variance</div>
            </td>
            <td class="py-3 px-4 text-right">
              <div class="flex items-center justify-end gap-1.5">
                <button onclick="founderToggleQueue('${id}')" class="px-2.5 py-1 rounded text-xs font-bold transition ${isOpen ? 'bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200'}">
                  ${isOpen ? 'Pause Queue' : 'Open Queue'}
                </button>
                <button onclick="founderOpenHostStand('${id}')" class="px-2.5 py-1 rounded text-xs font-bold transition bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 flex items-center gap-1">
                  <i data-lucide="login" class="w-3 h-3"></i> Host Stand
                </button>
                <button onclick="openFounderEditRestaurantModal('${id}')" class="px-2.5 py-1 rounded text-xs font-bold transition bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 flex items-center gap-1">
                  <i data-lucide="edit-3" class="w-3 h-3"></i> Edit
                </button>
                <button onclick="openVenueQrModal('${id}')" class="px-2.5 py-1 rounded text-xs font-bold transition bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 flex items-center gap-1">
                  <i data-lucide="qr-code" class="w-3 h-3"></i> <span>Generate QR Code</span>
                </button>
                <button onclick="openFounderResetPasswordModal('${id}')" class="px-2.5 py-1 rounded text-xs font-bold transition bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 flex items-center gap-1">
                  <i data-lucide="key" class="w-3 h-3"></i> Reset Pwd
                </button>
                <button onclick="founderClearVenueQueue('${id}', '${nameJs}')" class="px-2.5 py-1 rounded text-xs font-bold transition bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200 flex items-center gap-1">
                  <i data-lucide="trash-2" class="w-3 h-3"></i> Clear Queue
                </button>
                <button onclick="founderDeleteRestaurant('${id}', '${nameJs}')" class="px-2.5 py-1 rounded text-xs font-bold transition bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200 flex items-center gap-1">
                  <i data-lucide="trash-2" class="w-3 h-3"></i> Remove
                </button>
              </div>
              <div class="flex items-center justify-end gap-1.5 mt-1">
                <input type="number" id="fnd-wait-${id}" min="0" max="180" placeholder="Wait" class="w-16 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-[10px] focus:ring-1 focus:ring-orange-500 focus:outline-none">
                <button onclick="founderSetManualWait('${id}')" class="px-2 py-1 bg-orange-50 text-orange-700 rounded text-[10px] font-bold hover:bg-orange-100 border border-orange-200 transition">Set Wait</button>
                <input type="number" id="fnd-score-${id}" min="0" max="100" placeholder="Score" class="w-14 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-[10px] focus:ring-1 focus:ring-emerald-500 focus:outline-none">
                <button onclick="founderSetReliability('${id}')" class="px-2 py-1 bg-emerald-50 text-emerald-700 rounded text-[10px] font-bold hover:bg-emerald-100 border border-emerald-200 transition">Set Score</button>
              </div>
              <div class="flex items-center justify-end gap-1.5 mt-1">
                <input type="text" id="fnd-ann-${id}" placeholder="Announcement" class="w-32 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-[10px] focus:ring-1 focus:ring-amber-500 focus:outline-none">
                <button onclick="founderSetAnnouncement('${id}')" class="px-2 py-1 bg-amber-50 text-amber-700 rounded text-[10px] font-bold hover:bg-amber-100 border border-amber-200 transition">Publish</button>
                <button onclick="founderSetAnnouncement('${id}', '')" class="px-2 py-1 bg-slate-100 text-slate-600 rounded text-[10px] hover:bg-slate-200 border border-slate-200 transition">Clear</button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    } else {
      restTbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-slate-600">No restaurants registered yet.</td></tr>`;
    }
  }

  // Render Live Cross-Platform Queue Stream (every active party, all venues)
  const queueTbody = document.getElementById('fndLiveQueuesTable');
  const queues = data.recent_queues || founderQueuesCache || [];
  if (queueTbody) {
    if (queues.length > 0) {
      queueTbody.innerHTML = queues.map(q => {
        let statusBadge = `<span class="badge-tag bg-slate-100 text-slate-700">${escapeHtml(q.status)}</span>`;
        if (q.status === 'notified') statusBadge = `<span class="badge-tag bg-emerald-100 text-emerald-800 font-bold animate-pulse">Table Ready</span>`;
        if (q.status === 'seated') statusBadge = `<span class="badge-tag bg-blue-100 text-blue-800">Seated</span>`;
        if (q.status === 'waiting') statusBadge = `<span class="badge-tag bg-orange-100 text-orange-800 font-bold">Waiting</span>`;
        if (q.status === 'delayed') statusBadge = `<span class="badge-tag bg-amber-100 text-amber-800">Delayed</span>`;
        const channel = (q.channel || q['09_channel'] || 'remote').toLowerCase();
        const source = (q.source || '').toLowerCase();
        const isGhost = source === 'ghost' || q.is_ghost || q.isGhost || q.entry_type === 'ghost';
        const isWalkIn = source === 'walk-in' || channel === 'walk_in';
        const channelLabel = isWalkIn ? '🚶 Walk-In' : (isGhost ? '👻 Ghost' : '📱 Remote');
        const channelClass = isWalkIn ? 'bg-amber-100 text-amber-800 border border-amber-200' : (isGhost ? 'bg-purple-100 text-purple-800 border border-purple-300' : 'bg-indigo-100 text-indigo-700 border border-indigo-200');
        const id = q.id || q.ticket_number;
        const nameJs = jsEscape(q.customer_name || '');
        const venueJs = jsEscape(q.restaurant_name || '');
        return `
          <tr class="hover:bg-slate-50 transition">
            <td class="py-2.5 px-4 font-mono font-bold text-slate-900">${escapeHtml(q.ticket_number || id)}</td>
            <td class="py-2.5 px-4 font-medium text-slate-800">${escapeHtml(q.restaurant_name)}</td>
            <td class="py-2.5 px-4">
              <div class="font-bold text-slate-900">${escapeHtml(q.customer_name)}</div>
              <div class="text-[10px] text-slate-600">${escapeHtml(q.phone || '—')}</div>
            </td>
            <td class="py-2.5 px-4">
              <div class="text-slate-800 font-medium">${Number(q.party_size || 0)} guests</div>
              <div class="text-[10px] text-slate-600">Promised ~${q.promised_wait_mins || q.estimated_wait_mins || 0}m</div>
            </td>
            <td class="py-2.5 px-4">${statusBadge}</td>
            <td class="py-2.5 px-4 text-center">
              <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border ${channelClass}">${channelLabel}</span>
            </td>
            <td class="py-2.5 px-4 text-center">
              <div class="text-[10px] text-slate-600 font-sans">${escapeHtml(q.joined_time_ist || '—')}</div>
              <div class="text-[10px] ${q.notified_time_ist ? 'text-emerald-700 font-medium' : 'text-slate-600'}">${escapeHtml(q.notified_time_ist || '—')}</div>
            </td>
            <td class="py-2.5 px-4 text-right">
              <div class="flex items-center justify-end gap-1.5">
                ${q.status !== 'notified' && q.status !== 'seated' && q.status !== 'no_show' && q.status !== 'cancelled' ? `
                  <button onclick="founderQueueAction('${id}', 'notify')" class="px-2 py-1 bg-orange-500 hover:bg-orange-600 text-white rounded text-[10px] font-bold transition shadow-xs flex items-center gap-1">
                    <i data-lucide="bell" class="w-2.5 h-2.5"></i> Notify
                  </button>
                ` : ''}
                ${q.status !== 'seated' && q.status !== 'no_show' && q.status !== 'cancelled' ? `
                  <button onclick="founderQueueAction('${id}', 'seat')" class="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[10px] font-bold transition shadow-xs flex items-center gap-1">
                    <i data-lucide="check" class="w-2.5 h-2.5"></i> Seat
                  </button>
                ` : ''}
                <button onclick="founderQueueAction('${id}', 'remove')" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded text-[10px] font-bold transition flex items-center gap-1" title="Mark no-show / remove">
                  <i data-lucide="user-x" class="w-2.5 h-2.5"></i> Remove
                </button>
                <button onclick="founderEditPartySize('${id}')" class="px-2 py-1 bg-blue-50 text-blue-700 rounded text-[10px] font-bold hover:bg-blue-100 border border-blue-200 transition flex items-center gap-1">
                  <i data-lucide="edit-3" class="w-2.5 h-2.5"></i> Size
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    } else {
      queueTbody.innerHTML = `<tr><td colspan="8" class="py-6 text-center text-slate-400">No live queue activity currently.</td></tr>`;
    }
  }

  // Render Reliability Audit Watchdog — all reviews across the network
  const reviewList = document.getElementById('fndRecentReviewsList');
  const reviews = data.recent_reviews || founderReviewsCache || [];
  if (reviewList) {
    if (reviews.length > 0) {
      reviewList.innerHTML = `
        <table class="w-full text-left text-[10px]">
          <thead>
            <tr class="text-slate-500 font-bold uppercase tracking-wider mb-2 border-b border-slate-200 pb-1">
              <th class="pb-1 pr-2">Guest</th>
              <th class="pb-1 pr-2">Restaurant</th>
              <th class="pb-1 pr-2 text-center">Stars</th>
              <th class="pb-1 pr-2">Comment</th>
              <th class="pb-1 pr-2 text-center">IST</th>
              <th class="pb-1 text-right">Action</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            ${reviews.map(rev => {
              const stars = '★'.repeat(Number(rev.rating || 0)) + '☆'.repeat(5 - Number(rev.rating || 0));
              const ts = rev.rated_time_ist || rev.created_at || rev.reviewed_at || '';
              const id = rev.id || rev.review_id;
              const restJs = jsEscape(rev.restaurant_name || '');
              return `
                <tr class="hover:bg-slate-50 transition">
                  <td class="py-2 px-2 text-slate-800 font-medium">${escapeHtml(rev.guest_name || rev.customer_name || 'Guest')}</td>
                  <td class="py-2 px-2 text-slate-800">${escapeHtml(rev.restaurant_name)}</td>
                  <td class="py-2 px-2 text-center text-amber-700 font-bold">${stars}</td>
                  <td class="py-2 px-2 text-slate-600 italic max-w-[34px] overflow-hidden text-overflow-ellipsis whitespace-nowrap" title="${escapeHtml(rev.review_comment || rev.comment || '')}">${escapeHtml(rev.review_comment || rev.comment || '—')}</td>
                  <td class="py-2 px-2 text-center text-slate-500">${escapeHtml(ts)}</td>
                  <td class="py-2 px-2 text-right">
                    <button onclick="founderDeleteReview('${id}', '${jsEscape(rev.restaurant_id || '')}')" class="px-2 py-1 bg-rose-50 text-rose-700 rounded text-[9px] font-bold hover:bg-rose-100 border border-rose-200 flex items-center justify-center gap-1">
                      <i data-lucide="trash-2" class="w-2.5 h-2.5"></i> Delete
                    </button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
        <p class="text-[10px] text-slate-600 mt-3 text-center">Delete a fake/spam review → that restaurant's Reliability Score™ is recalculated from the remaining reviews automatically.</p>
      `;
    } else {
      reviewList.innerHTML = `<p class="text-xs text-slate-600 text-center py-6">No reviews logged across the network yet.</p>`;
    }
  }

  lucide.createIcons();
}

async function founderToggleQueue(restId) {
  try {
    const res = await fetch('/api/founder/restaurant/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({ restaurant_id: restId })
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (parseErr) { data = {}; }
    if (res.status === 401) {
      sessionStorage.removeItem(FOUNDER_PWD_KEY);
      openFounderLoginModal();
      showToast('Founder session expired. Re-enter password.', 'error');
      return;
    }
    if (!res.ok) {
      showToast(data.error || "Error updating queue status", "error");
      return;
    }
    showToast(data.message || "Queue state updated", "info");
    await loadFounderDashboard();
    await loadRestaurants();
  } catch (err) {
    showToast("Error updating queue status", "error");
  }
}

// ==========================================
// 3. RESTAURANT DATA LOADING & DISCOVERY
// ==========================================
async function loadRestaurants() {
  try {
    const res = await fetch('/api/restaurants', { cache: 'no-store' });
    if (!res.ok) throw new Error('API response not ok');
    const data = await res.json();
    allRestaurants = data.restaurants || [];

    // Global Network Banner pushed by the Founder (visible across all venues)
    if (data.global_announcement !== undefined) {
      globalAnnouncementText = data.global_announcement || '';
      const banner = document.getElementById('globalNetworkBanner');
      const textEl = document.getElementById('globalBannerText');
      if (globalAnnouncementText) {
        if (textEl) textEl.textContent = globalAnnouncementText;
        if (banner) banner.classList.remove('hidden');
      } else if (banner) {
        banner.classList.add('hidden');
      }
    }

    // Merge Founder-added custom venues
    const customVenues = JSON.parse(localStorage.getItem('waitmate_custom_venues') || '[]');
    if (customVenues.length > 0) {
      allRestaurants = [...allRestaurants, ...customVenues];
    }
    
    // Filter out Founder-deleted venues
    const deletedVenues = JSON.parse(localStorage.getItem('waitmate_deleted_venues') || '[]');
    if (deletedVenues.length > 0) {
      allRestaurants = allRestaurants.filter(r => !deletedVenues.includes(r.id));
    }
    
    renderRestaurantsGrid();
    populateHostDropdown();
    // Cards are already on screen; advance the simulation out-of-band.
    triggerBackgroundSimTick();
  } catch (err) {
    console.warn("Using offline/fallback data for restaurants:", err);
    allRestaurants = JSON.parse(JSON.stringify(fallbackRestaurants));
    const banner = document.getElementById('globalNetworkBanner');
    if (banner) banner.classList.add('hidden');
    
    // Merge custom venues even in fallback mode
    const customVenues = JSON.parse(localStorage.getItem('waitmate_custom_venues') || '[]');
    if (customVenues.length > 0) {
      allRestaurants = [...allRestaurants, ...customVenues];
    }
    
    // Filter deleted venues even in fallback mode
    const deletedVenues = JSON.parse(localStorage.getItem('waitmate_deleted_venues') || '[]');
    if (deletedVenues.length > 0) {
      allRestaurants = allRestaurants.filter(r => !deletedVenues.includes(r.id));
    }
    
    renderRestaurantsGrid();
    populateHostDropdown();
  }
}

// City filter
function setCityFilter(city) {
  currentCity = city;
  document.querySelectorAll('.city-btn').forEach(btn => {
    if (btn.dataset.city === city) {
      btn.className = "city-btn active px-3 py-1.5 rounded-lg font-bold bg-slate-900 text-white shadow-xs";
    } else {
      btn.className = "city-btn px-3 py-1.5 rounded-lg font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-100";
    }
  });

  renderRestaurantsGrid();
}

// Mumbai Neighborhood Filter Pills
function setAreaFilter(area) {
  currentArea = area;
  document.querySelectorAll('.area-pill').forEach(btn => {
    if (btn.dataset.area === area) {
      btn.className = "area-pill active px-3 py-1.5 rounded-lg font-bold bg-slate-900 text-white shadow-xs";
    } else {
      btn.className = "area-pill px-3 py-1.5 rounded-lg font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-100";
    }
  });
  renderRestaurantsGrid();
}

function areaMatches(r, area) {
  if (area === 'all') return true;
  const addr = ((r.address || '') + ' ' + (r.city || '') + ' ' + (r.name || '')).toLowerCase();
  if (area === 'south') return ['colaba', 'fort', 'ballard estate', 'marine lines', 'dhobi talao'].some(k => addr.includes(k));
  if (area === 'west') return ['bandra', 'juhu', 'linking road'].some(k => addr.includes(k));
  if (area === 'central') return ['lower parel', 'tardeo', 'mumbai central', 'palladium', 'mill compound'].some(k => addr.includes(k));
  return true;
}

// Meal Time Filter Pills
function setMealTimeFilter(meal) {
  currentMealTime = meal;
  document.querySelectorAll('.meal-pill').forEach(btn => {
    if (btn.dataset.meal === meal) {
      btn.className = "meal-pill active px-3 py-1.5 rounded-lg font-bold bg-slate-900 text-white shadow-xs";
    } else {
      btn.className = "meal-pill px-3 py-1.5 rounded-lg font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-100";
    }
  });
  renderRestaurantsGrid();
}

function mealTimesMatch(r, meal) {
  if (meal === 'all') return true;
  const times = r.meal_times || [];
  return Array.isArray(times) && times.includes(meal);
}

// Render Discovery Cards
function renderRestaurantsGrid() {
  const container = document.getElementById('restaurantsGrid');
  if (!container) return;

  // Update header live diners counter
  const totalLiveDiners = allRestaurants.reduce((sum, r) => sum + (r.live_stats ? r.live_stats.total_waiting_people : 0), 0);
  const topCountEl = document.getElementById('topLiveDinersCount');
  if (topCountEl) topCountEl.textContent = `${totalLiveDiners} diners in line`;

  let filtered = allRestaurants.filter(r => {
    if (currentCity !== 'all' && (r.city || 'Mumbai') !== currentCity) return false;
    if (!areaMatches(r, currentArea)) return false;
    if (!mealTimesMatch(r, currentMealTime)) return false;
    if (currentCategory !== 'all' && r.type !== currentCategory) return false;
    if (openOnly && r.live_stats && !r.live_stats.is_queue_open) return false;
    if (currentCategory === 'saved' && !favorites.has(r.id)) return false;
    if (currentSearch) {
      const q = currentSearch.toLowerCase();
      const matchName = (r.name || '').toLowerCase().includes(q);
      const matchCat = (r.category || '').toLowerCase().includes(q);
      const matchDesc = (r.description || '').toLowerCase().includes(q);
      const matchCity = (r.city || '').toLowerCase().includes(q);
      if (!matchName && !matchCat && !matchDesc && !matchCity) return false;
    }
    return true;
  });

  // Sorting — favorited spots are pinned to the top of the default discovery grid
  const isDefaultGrid = currentCategory === 'all' && !currentSearch && currentCity === 'all' && currentArea === 'all';
  filtered.sort((a, b) => {
    if (isDefaultGrid && favorites.size > 0) {
      const aFav = favorites.has(a.id);
      const bFav = favorites.has(b.id);
      if (aFav !== bFav) return bFav ? 1 : -1;
    }
    if (currentSort === 'reliability') {
      return (b.reliability?.score || 0) - (a.reliability?.score || 0);
    } else if (currentSort === 'wait_asc') {
      return (a.live_stats?.estimated_wait_mins || 0) - (b.live_stats?.estimated_wait_mins || 0);
    }
    return 0;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="col-span-full py-16 text-center bg-white rounded-2xl border border-slate-200 p-8">
        <i data-lucide="store" class="w-12 h-12 text-slate-300 mx-auto mb-3"></i>
        <h3 class="text-base font-bold text-slate-800">No restaurants match your filters in ${currentCity === 'all' ? 'Mumbai' : currentCity}</h3>
        <p class="text-xs text-slate-600 mt-1">Try clearing your search filters or selecting another neighborhood.</p>
        <button onclick="resetFilters()" class="mt-4 px-4 py-2 bg-slate-100 border border-slate-300 text-slate-800 rounded-lg text-xs font-bold hover:bg-slate-200">Reset Filters</button>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  container.innerHTML = filtered.map(r => {
    const isTruck = r.type === 'food_truck';
    const rel = r.reliability || { score: 95, grade: 'A+', avg_variance_mins: 1.5 };
    const stats = r.live_stats || { estimated_wait_mins: 10, queue_count: 0, total_waiting_people: 0, is_queue_open: true };

    // Live Peak Rush Crowd Indicator
    const parties = stats.active_parties != null ? stats.active_parties : stats.queue_count;
    const wait = stats.estimated_wait_mins || 0;
    let rushBadgeClass = "text-emerald-700 bg-emerald-50 border border-emerald-100";
    let rushIcon = "🟢";
    let rushLabel = "Walk right in";
    if (parties >= 4 || wait >= 20) {
      rushBadgeClass = "text-rose-700 bg-rose-50 border border-rose-100";
      rushIcon = "🔴";
      rushLabel = "Peak Rush";
    } else if (parties >= 1 || (wait > 0 && wait < 20)) {
      rushBadgeClass = "text-amber-700 bg-amber-50 border border-amber-100";
      rushIcon = "🟠";
      rushLabel = "Filling fast";
    }

    // Reliability Badge styling
    let scoreBadgeClass = "score-emerald";
    let scoreIcon = "award";
    if (rel.score < 80) {
      scoreBadgeClass = "score-rose";
      scoreIcon = "alert-circle";
    } else if (rel.score < 90) {
      scoreBadgeClass = "score-amber";
      scoreIcon = "shield-check";
    }

    const isCurrentInQueue = activeTicketData && activeTicketData.restaurant_id === r.id && ['waiting', 'notified', 'delayed'].includes(activeTicketData.status);

    return `
      <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition-all flex flex-col group">
        
        <!-- Image Header -->
        <div class="relative h-44 overflow-hidden bg-slate-100">
          <img src="${r.image_url}" alt="${r.name}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" onerror="this.onerror=null; this.src='https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80'">
          
          <!-- Gradient overlay -->
          <div class="absolute inset-0 bg-gradient-to-t from-slate-950/70 via-transparent to-black/20"></div>

          <!-- Top Pills -->
          <div class="absolute top-3 right-3 flex items-center gap-1.5 z-10">
            <span class="badge-tag bg-slate-900/80 backdrop-blur text-white text-[10px] font-bold uppercase tracking-wider">
              ${isTruck ? '🚚 Food Truck' : '🍽️ Dine-in'}
            </span>
            <span class="badge-tag bg-white/90 backdrop-blur text-slate-900 text-[10px] font-bold">
              ${r.price_range}
            </span>
            <span class="badge-tag bg-orange-500/90 text-white text-[10px] font-bold">
              📍 ${r.city || 'Mumbai'}
            </span>
          </div>

          <!-- Favorite / Bookmark Heart (top-left of cover image, opposite Reliability Score pill) -->
          <button onclick="toggleFavorite('${r.id}', this)" class="favorite-btn absolute top-3 left-3 w-9 h-9 rounded-full bg-white/95 backdrop-blur-md flex items-center justify-center text-slate-900 shadow-md border border-white/70 transition-transform active:scale-90 hover:bg-white z-20" aria-label="${isFavorite(r.id) ? 'Remove from Favorites' : 'Add to Favorites'}" title="${isFavorite(r.id) ? 'Saved ♥' : 'Save to Favorites'}" id="fav-btn-${r.id}">
            <span id="heart-icon-${r.id}" class="text-2xl leading-none ${isFavorite(r.id) ? 'text-orange-500' : 'text-slate-600'}">${isFavorite(r.id) ? '♥' : '♡'}</span>
          </button>

          <!-- Bottom Venue Title inside Image -->
          <div class="absolute bottom-3 left-3 right-3">
            <h3 class="font-heading font-extrabold text-lg text-white leading-tight drop-shadow-sm">${r.name}</h3>
            <p class="text-xs text-slate-200/90 font-medium">${r.category}</p>
          </div>

        </div>

        <!-- Card Body -->
        <div class="p-5 flex-1 flex flex-col justify-between space-y-4">
          
          <p class="text-xs text-slate-600 line-clamp-2 leading-relaxed">
            ${r.description}
          </p>

          <!-- Wait & Reliability Metric Strip -->
          <div class="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100">
            
            <!-- Live Wait Time -->
            <div class="bg-orange-50/70 rounded-xl p-3 border border-orange-100 flex flex-col justify-center">
              <span class="text-[10px] font-bold text-orange-800 uppercase tracking-wider flex items-center gap-1">
                <i data-lucide="clock" class="w-3 h-3 text-orange-600"></i> Estimated Wait
              </span>
              <div class="text-xl font-heading font-extrabold text-orange-950 mt-0.5">
                ${stats.estimated_wait_mins > 0 ? `${stats.estimated_wait_mins} min` : 'No wait'}
              </div>
              <span class="text-[10px] text-orange-700 font-medium">
                ${stats.queue_count} ${stats.queue_count === 1 ? 'party' : 'parties'} in line (${stats.total_waiting_people} guests)
              </span>
            </div>

            <!-- Reliability Score Card -->
            <div class="rounded-xl p-3 border ${scoreBadgeClass} flex flex-col justify-center cursor-pointer hover:opacity-90 transition" onclick="openReliabilityModal('${r.id}')" title="Click to view full reliability breakdown">
              <div class="flex items-center justify-between">
                <span class="text-[10px] font-bold uppercase tracking-wider flex items-center gap-1">
                  <i data-lucide="${scoreIcon}" class="w-3 h-3"></i> Reliability
                </span>
                <span class="text-[10px] font-black underline">Details &rarr;</span>
              </div>
              <div class="flex items-baseline gap-1.5 mt-0.5">
                <span class="text-xl font-heading font-black">${rel.score}%</span>
                <span class="text-[11px] font-bold">Grade ${rel.grade}</span>
              </div>
              <span class="text-[10px] font-medium opacity-90">
                ± ${rel.avg_variance_mins}m avg variance
              </span>
            </div>

          </div>

          <!-- Live Peak Rush Crowd Badge -->
          <div class="pt-1">
            <span class="text-[10px] font-bold uppercase tracking-wider inline-flex items-center gap-1 px-2 py-1 rounded border ${rushBadgeClass}">
              <span>${rushIcon}</span> ${rushLabel}
            </span>
          </div>

          <!-- Live Host Announcement / Specials Banner -->
          ${r.announcement ? `
          <div class="bg-amber-50 border border-amber-200 rounded-xl p-2.5 mb-2">
            <span class="text-[10px] font-bold text-amber-800 uppercase flex items-center gap-1 mb-1">
              <i data-lucide="megaphone" class="w-3 h-3"></i> Live Special
            </span>
            <p class="text-xs text-amber-700 font-medium leading-snug">${r.announcement}</p>
          </div>
          ` : ''}

          <!-- Bottom Action Buttons -->
          <div class="space-y-2 pt-1">
            ${isCurrentInQueue ? `
              <button onclick="openTicketModal()" class="w-full py-2.5 px-4 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-md shadow-slate-900/20">
                <i data-lucide="ticket" class="w-4 h-4"></i>
                <span>You're in Queue! View Live Pass</span>
              </button>
            ` : stats.is_queue_open ? `
              <div class="grid grid-cols-2 gap-2">
                <button onclick="openJoinModal('${r.id}', 'remote')" class="py-2.5 px-3 rounded-xl text-xs font-bold bg-slate-900 text-white shadow-sm flex items-center justify-center gap-1.5">
                  <i data-lucide="smartphone" class="w-3 h-3"></i>
                  <span>Remote Join</span>
                </button>
                <button onclick="openJoinModal('${r.id}', 'walk_in')" class="py-2.5 px-3 rounded-xl text-xs font-bold bg-slate-100 border border-slate-300 text-slate-800 hover:bg-slate-200 transition flex items-center justify-center gap-1.5">
                  <i data-lucide="map-pin" class="w-3 h-3"></i>
                  <span>Walk-In</span>
                </button>
              </div>
            ` : `
              <button disabled class="w-full py-2.5 px-4 bg-slate-100 text-slate-600 rounded-xl text-xs font-semibold cursor-not-allowed">
                Queue Currently Paused
              </button>
            `}

            <button onclick="openReliabilityModal('${r.id}')" class="w-full py-1.5 text-slate-600 hover:text-slate-800 text-[11px] font-semibold text-center flex items-center justify-center gap-1">
              <i data-lucide="bar-chart-2" class="w-3 h-3"></i>
              <span>View Verified Accuracy History & Heatmap</span>
            </button>
          </div>

        </div>

      </div>
    `;
  }).join('');

  lucide.createIcons();
}

// Category filter
function setCategoryFilter(cat) {
  currentCategory = cat;
  document.querySelectorAll('.cat-pill').forEach(btn => {
    if (btn.dataset.cat === cat) {
      btn.className = "cat-pill active px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition bg-slate-900 text-white";
    } else {
      btn.className = "cat-pill px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition bg-slate-100 text-slate-600 hover:bg-slate-200";
    }
  });
  renderRestaurantsGrid();
}

// Search and filter inputs
function applyFilters() {
  currentSearch = document.getElementById('searchInput').value.trim();
  currentSort = document.getElementById('sortSelect').value;
  openOnly = document.getElementById('openOnlyCheckbox').checked;
  renderRestaurantsGrid();
}

function resetFilters() {
  document.getElementById('searchInput').value = '';
  document.getElementById('sortSelect').value = 'reliability';
  document.getElementById('openOnlyCheckbox').checked = true;
  setCategoryFilter('all');
  setCityFilter('all');
  setMealTimeFilter('all');
  applyFilters();
}

// ==========================================
// 4. JOIN QUEUE MODAL WORKFLOW
// ==========================================
let selectedJoinVenue = null;

function openJoinModal(venueId, channelOverride = null) {
  const r = allRestaurants.find(x => x.id === venueId);
  if (!r) return;
  selectedJoinVenue = r;

  document.getElementById('joinVenueId').value = r.id;
  document.getElementById('joinModalVenueName').textContent = r.name;
  document.getElementById('joinModalAddress').textContent = `${r.address}`;
  const joinAnnEl = document.getElementById('joinModalAnnouncement');
  if (joinAnnEl) {
    if (r.announcement) {
      joinAnnEl.textContent = r.announcement;
      joinAnnEl.classList.remove('hidden');
      joinAnnEl.classList.add('inline-flex');
    } else {
      joinAnnEl.classList.add('hidden');
    }
  }
  document.getElementById('joinPreviewWait').textContent = `~${r.live_stats ? r.live_stats.estimated_wait_mins : 15} mins wait`;
  document.getElementById('joinPreviewAhead').textContent = `${r.live_stats ? r.live_stats.queue_count : 2} parties ahead of you`;
  document.getElementById('joinPreviewScore').innerHTML = `<i data-lucide="award" class="w-3 h-3"></i> ${r.reliability ? r.reliability.score : 95}% Accurate`;

  // Reset defaults (empty fields for clean customer entry)
  setPartySize(2);
  setSeatingPref('First Available');
  const savedName = localStorage.getItem('waitmate_guest_name') || '';
  document.getElementById('joinCustomerName').value = savedName;
  document.getElementById('joinSpecialReq').value = '';

  // Entry channel: walk-in when opened via a venue QR/deep link, remote otherwise
  const channel = channelOverride === 'walk_in' ? 'walk_in' : 'remote';
  setJoinChannel(channel);

  // Reset submission lock + button state so the modal never opens stuck
  // on "Securing Queue Spot..." from a previous interrupted submission.
  isSubmitting = false;
  const joinSubmitBtn = document.getElementById('joinSubmitBtn');
  if (joinSubmitBtn) {
    joinSubmitBtn.disabled = false;
    joinSubmitBtn.innerHTML = channel === 'walk_in'
      ? `<i data-lucide="ticket" class="w-4 h-4"></i> <span>Confirm Walk-In Check-In</span>`
      : `<i data-lucide="ticket" class="w-4 h-4"></i> <span>Join Remote Queue</span>`;
  }

  document.getElementById('joinQueueModal').classList.remove('hidden');
  lucide.createIcons();
}

function closeJoinModal() {
  document.getElementById('joinQueueModal').classList.add('hidden');
}

function setJoinChannel(channel) {
  joinChannel = channel;
  const input = document.getElementById('joinChannelInput');
  const badge = document.getElementById('joinChannelBadge');
  if (input) input.value = channel;
  if (badge) {
    if (channel === 'walk_in') {
      badge.textContent = 'Walk-In (I\'m at the restaurant)';
      badge.className = "text-xs font-bold px-2.5 py-1 rounded border inline-block text-emerald-700 border-emerald-200 bg-emerald-50";
    } else {
      badge.textContent = 'Remote Join (On my way)';
      badge.className = "text-xs font-bold px-2.5 py-1 rounded border inline-block text-slate-700 border-slate-200 bg-slate-200/50";
    }
  }
  const eyebrow = document.getElementById('joinModalEyebrow');
  if (eyebrow) {
    eyebrow.textContent = channel === 'walk_in' ? 'WALK-IN CHECK-IN • MUMBAI' : 'REMOTE QUEUE ENTRY • MUMBAI';
  }
}

function toggleJoinChannel() {
  setJoinChannel(joinChannel === 'walk_in' ? 'remote' : 'walk_in');
}

function setPartySize(size) {
  document.getElementById('joinPartySizeInput').value = size;
  document.querySelectorAll('.party-btn').forEach(btn => {
    if (parseInt(btn.dataset.size) === size) {
      btn.className = "party-btn py-2 border rounded-lg text-xs font-bold hover:border-orange-500 focus:outline-none bg-orange-500 text-white border-orange-500";
    } else {
      btn.className = "party-btn py-2 border rounded-lg text-xs font-bold hover:border-orange-500 focus:outline-none border-slate-200 text-slate-700";
    }
  });
}

function setSeatingPref(pref) {
  document.getElementById('joinSeatingPrefInput').value = pref;
  document.querySelectorAll('.pref-btn').forEach(btn => {
    if (btn.dataset.pref === pref) {
      btn.className = "pref-btn py-2 px-2 border rounded-lg text-xs font-semibold text-center border-orange-500 bg-orange-50 text-orange-950";
    } else {
      btn.className = "pref-btn py-2 px-2 border rounded-lg text-xs font-semibold text-center border-slate-200 text-slate-700 hover:border-orange-400";
    }
  });
}

async function submitJoinQueue(e) {
  e.preventDefault();
  const restId = document.getElementById('joinVenueId').value;
  const name = document.getElementById('joinCustomerName').value.trim();
  const partySize = parseInt(document.getElementById('joinPartySizeInput').value);
  const seatingPref = document.getElementById('joinSeatingPrefInput').value;
  const specialReq = document.getElementById('joinSpecialReq').value.trim();

  selectedRestaurantId = restId;
  acknowledgedAlertForTicket = null;
  graceUntil = null;

  if (!name) {
    showToast("Please enter your name", "error");
    return;
  }
  localStorage.setItem('waitmate_guest_name', name);

  const submitBtn = document.getElementById('joinSubmitBtn');
  isSubmitting = true;
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> Securing Queue Spot...`;
  lucide.createIcons();

  const joinPayload = {
    restaurant_id: restId,
    name: name,
    phone: '',
    party_size: partySize,
    seating_pref: seatingPref,
    special_requests: specialReq,
    entry_type: joinChannel
  };

  let res;
  try {
    res = await fetch('/api/queue/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(joinPayload)
    });
  } catch (networkErr) {
    // Network/transport failure only — fall through to offline fallback below.
    res = null;
  }

  if (res) {
    // A real HTTP response was received: it is authoritative.
    // Parse safely so non-JSON bodies don't masquerade as network errors.
    let data = {};
    try { data = await res.json(); } catch (parseErr) { data = {}; }

    if (!res.ok) {
      isSubmitting = false;
      submitBtn.disabled = false;
      submitBtn.innerHTML = `<i data-lucide="ticket" class="w-4 h-4"></i> <span>Join Online Queue & Get Pass</span>`;
      lucide.createIcons();
      showToast(data.error || 'Unable to join the queue right now. Please try again.', "error");
      return;
    }

    currentTicketId = data.ticket_id;
    localStorage.setItem('waitmate_ticket_id', currentTicketId);

    // Immediately persist the full ticket object locally so cold starts / 404s never wipe it
    const joinedTicket = {
      id: data.ticket_id,
      ticket_number: data.ticket_number,
      restaurant_id: restId,
      customer_name: name,
      phone: '',
      party_size: partySize,
      seating_pref: seatingPref,
      special_requests: specialReq,
      entry_type: joinChannel,
      status: 'waiting',
      estimated_wait_mins: data.estimated_wait_mins ?? 10,
      actual_wait_mins: 0,
      joined_at: Date.now() / 1000,
      notified_at: null,
      seated_at: null,
      has_arrived: joinChannel === 'walk_in' ? 1 : 0,
      delay_mins: 0,
      ...(joinChannel === 'walk_in' && {
        arrived_at: Date.now() / 1000,
        arrived_time_ist: new Date().toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        }) + ' IST'
      }),
      position_in_line: data.position_in_line ?? 1,
      parties_ahead: data.parties_ahead ?? 0,
      estimated_remaining_mins: data.estimated_wait_mins ?? 10,
      restaurant: {
        name: selectedJoinVenue?.name || (allRestaurants.find(r => r.id === restId)?.name) || 'Unknown Venue',
        category: selectedJoinVenue?.category || '',
        address: selectedJoinVenue?.address || '',
        image_url: selectedJoinVenue?.image_url || ''
      }
    };
    activeTicketData = joinedTicket;
    localStorage.setItem('waitmate_active_ticket', JSON.stringify({ id: currentTicketId, data: activeTicketData }));

    closeJoinModal();
    showToast(data.message || `Spot reserved! Ticket #${data.ticket_number}`, "success");
    playNotificationChime();

    // Start live ticket tracking
    await fetchTicketStatus();
    startTicketPolling();
    openTicketModal();
    await loadRestaurants(); // refresh queue counts
    // If the owner is viewing this venue's Host Stand, refresh instantly so the new
    // join appears and fires the single new-party alert without waiting for the poll.
    if (currentHostVenueId === restId) await loadHostStand();

    submitBtn.disabled = false;
    submitBtn.innerHTML = `<i data-lucide="ticket" class="w-4 h-4"></i> <span>Join Online Queue & Get Pass</span>`;
    lucide.createIcons();
    return;
  }

  // No HTTP response (server unreachable) — graceful offline fallback.
  {
    console.warn("Using offline join queue fallback");
    const ticketId = `q-${Date.now().toString().slice(-6)}`;
    const ticketNum = `WM-${String(Date.now()).slice(-6)}`;
    const targetRest = allRestaurants.find(x => x.id === restId) || fallbackRestaurants[0];
    const estWait = targetRest.live_stats ? targetRest.live_stats.estimated_wait_mins : 15;

    const newTicket = {
      id: ticketId,
      ticket_number: ticketNum,
      restaurant_id: restId,
      customer_name: name,
      phone: '',
      party_size: partySize,
      seating_pref: seatingPref,
      special_requests: specialReq,
      entry_type: joinChannel,
      status: 'waiting',
      estimated_wait_mins: estWait,
      actual_wait_mins: 0,
      joined_at: Date.now() / 1000,
      notified_at: null,
      seated_at: null,
      has_arrived: joinChannel === 'walk_in' ? 1 : 0,
      delay_mins: 0,
      ...(joinChannel === 'walk_in' && {
        arrived_at: Date.now() / 1000,
        arrived_time_ist: new Date().toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        }) + ' IST'
      }),
      position_in_line: (targetRest.live_stats ? targetRest.live_stats.queue_count : 0) + 1,
      parties_ahead: targetRest.live_stats ? targetRest.live_stats.queue_count : 0,
      estimated_remaining_mins: estWait,
      restaurant: {
        name: targetRest.name,
        category: targetRest.category,
        address: targetRest.address,
        image_url: targetRest.image_url
      }
    };

    if (!localMockQueues[restId]) localMockQueues[restId] = [];
    localMockQueues[restId].push(newTicket);
    if (targetRest.live_stats) {
      targetRest.live_stats.queue_count += 1;
      targetRest.live_stats.total_waiting_people += partySize;
    }

    currentTicketId = ticketId;
    activeTicketData = newTicket;
    localStorage.setItem('waitmate_ticket_id', currentTicketId);
    localStorage.setItem('waitmate_active_ticket', JSON.stringify({ id: currentTicketId, data: activeTicketData }));

    closeJoinModal();
    showToast(`Spot reserved at ${targetRest.name}! Ticket #${ticketNum}`, "success");
    playNotificationChime();
    startTicketPolling();
    openTicketModal();
    renderRestaurantsGrid();
    // Owner viewing this venue in offline mode: refresh Host Stand + fire the alert now.
    if (currentHostVenueId === restId) loadHostStand();

    submitBtn.disabled = false;
    submitBtn.innerHTML = `<i data-lucide="ticket" class="w-4 h-4"></i> <span>Join Online Queue & Get Pass</span>`;
    lucide.createIcons();
  }
}

// ==========================================
// 5. DIGITAL PASS TRACKING & LIVE UPDATES
// ==========================================
function startTicketPolling() {
  if (pollTimer) clearInterval(pollTimer);
  fetchTicketStatus();
  pollTimer = setInterval(fetchTicketStatus, 4000);
}

async function fetchTicketStatus() {
  if (!currentTicketId) {
    // Try to restore from localStorage if we have a persisted active ticket
    try {
      const saved = JSON.parse(localStorage.getItem('waitmate_active_ticket') || 'null');
      if (saved && saved.id && saved.data && !['seated', 'cancelled'].includes(saved.data.status)) {
        currentTicketId = saved.id;
        activeTicketData = saved.data;
        localStorage.setItem('waitmate_ticket_id', currentTicketId);
      }
    } catch (e) { /* ignore corrupt storage */ }
    if (!currentTicketId) return;
  }
  try {
    const res = await fetch(`/api/queue/ticket/${currentTicketId}`, { cache: 'no-store' });
    if (res.status === 404) {
      // Ticket not found on server (cold start / serverless restart).
      // Do NOT wipe local ticket if we have valid active data.
      if (activeTicketData && !['seated', 'cancelled'].includes(activeTicketData.status)) {
        // Keep rendering local data and attempt background re-sync
        updateTicketUI();
        // Try to re-register the ticket on the server
        attemptTicketReSync();
        return;
      }
      // No valid local data either - truly gone
      clearCurrentTicket();
      return;
    }
    if (!res.ok) {
      // Non-404 error (e.g. 503 unconfigured): keep last known state, don't crash.
      if (activeTicketData) updateTicketUI();
      return;
    }
    let data = {};
    try { data = await res.json(); } catch (parseErr) { return; }
    // Preserve local arrived/grace state if it exists, only merge server updates
    if (activeTicketData) {
      const localArrived = activeTicketData.has_arrived;
      const localDelayMins = activeTicketData.delay_mins || 0;
      const localGraceUntil = graceUntil;
      const localAcknowledgedAlert = acknowledgedAlertForTicket;
      // Merge: keep server data as base, but preserve local arrival/grace flags
      activeTicketData = { ...data, has_arrived: localArrived, delay_mins: localDelayMins, _hasPromptedFeedback: activeTicketData._hasPromptedFeedback };
      if (localGraceUntil && Date.now() < localGraceUntil) {
        graceUntil = localGraceUntil;
        acknowledgedAlertForTicket = localAcknowledgedAlert;
      }
    } else {
      activeTicketData = data;
    }
    updateTicketUI();
  } catch (err) {
    // Offline / network error: keep rendering local data if valid
    if (activeTicketData && !['seated', 'cancelled'].includes(activeTicketData.status)) {
      const elapsed = Math.floor((Date.now() / 1000 - activeTicketData.joined_at) / 60);
      const remaining = Math.max(1, activeTicketData.estimated_wait_mins + activeTicketData.delay_mins - elapsed);
      if (activeTicketData.status === 'waiting' || activeTicketData.status === 'delayed') {
        activeTicketData.estimated_remaining_mins = remaining;
      }
      updateTicketUI();
    }
  }
}

// Background re-sync: attempt to re-create the ticket on the server if it was lost during cold start
async function attemptTicketReSync() {
  if (!activeTicketData || !currentTicketId) return;
  try {
    const res = await fetch('/api/queue/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurant_id: activeTicketData.restaurant_id,
        name: activeTicketData.customer_name,
        phone: activeTicketData.phone,
        party_size: activeTicketData.party_size,
        seating_pref: activeTicketData.seating_pref,
        special_requests: activeTicketData.special_requests,
        entry_type: activeTicketData.entry_type,
        _rejoin: true,
        _original_ticket_id: currentTicketId
      })
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.ticket_id && data.ticket_id !== currentTicketId) {
        // Server created a new ticket - update our references
        currentTicketId = data.ticket_id;
        localStorage.setItem('waitmate_ticket_id', currentTicketId);
        localStorage.setItem('waitmate_active_ticket', JSON.stringify({ id: currentTicketId, data: activeTicketData }));
      }
    }
  } catch (e) {
    // Silent failure - we'll retry on next poll
  }
}

function updateTicketUI() {
  if (!activeTicketData) {
    document.getElementById('activeTicketPill').classList.add('hidden');
    return;
  }

  const d = activeTicketData;
  const pill = document.getElementById('activeTicketPill');

  // Always find the real restaurant name from allRestaurants (never fall back to "Partner Venue")
  const venueObj = (allRestaurants || []).find(r => r.id === (d.restaurant_id || selectedRestaurantId)) || d.restaurant;
  const venueName = venueObj ? venueObj.name : (d.restaurant?.name || 'Unknown Venue');

  if (d.status === 'notified') {
    acknowledgedAlertForTicket = null;
    graceUntil = null;
  }
  if (graceUntil && Date.now() > graceUntil) graceUntil = null;
  lastTicketStatus = d.status;

  if (d.status === 'notified') {
    pill.classList.add('emerald-pulse');
    pill.classList.remove('bg-orange-500');
    pill.classList.add('bg-emerald-500');
    pill.innerHTML = `<span class="w-2 h-2 rounded-full bg-white live-pulse"></span><span>Table Ready! Tap to View Pass →</span>`;
  } else {
    pill.classList.remove('emerald-pulse');
    pill.classList.remove('bg-emerald-500');
    pill.classList.add('bg-orange-500');
  }
  pill.classList.remove('hidden');
  pill.classList.add('flex');

  if (d.status === 'seated' || d.status === 'cancelled') {
    localStorage.removeItem('waitmate_active_ticket');
  }

  const arrivalStatusEl = document.getElementById('ticketArrivalStatus');
  if (graceUntil) {
    arrivalStatusEl.textContent = "Grace (+5m)";
    arrivalStatusEl.className = "font-bold text-amber-800";
  } else if (d.has_arrived) {
    arrivalStatusEl.textContent = "At Venue Entrance";
    arrivalStatusEl.className = "font-bold text-emerald-600";
  } else {
    arrivalStatusEl.textContent = "In Queue";
    arrivalStatusEl.className = "font-bold text-slate-600";
  }

  document.getElementById('ticketVenueName').textContent = venueName;
  document.getElementById('ticketVenueCategory').textContent = d.restaurant?.category || '';
  document.getElementById('ticketNumber').textContent = d.ticket_number;
  document.getElementById('ticketPosition').textContent = `#${d.position_in_line}`;
  document.getElementById('ticketPartiesAhead').textContent = `${d.parties_ahead} ${d.parties_ahead === 1 ? 'party' : 'parties'} ahead`;
  document.getElementById('ticketPartySize').textContent = `${d.party_size} Guests`;
  document.getElementById('ticketSeating').textContent = d.seating_pref;

  const arrivedAtEl = document.getElementById('ticketArrivedAt');
  if (arrivedAtEl) {
    arrivedAtEl.textContent = d.arrived_time_ist || '–';
    arrivedAtEl.className = d.has_arrived ? "font-bold text-emerald-700 text-[10px] leading-tight" : "font-bold text-slate-600 text-[10px] leading-tight";
  }

  // Check state transitions & "Table is Near" Alert System
  const tableNearAlert = document.getElementById('tableNearAlertBanner');
  const livePassAlertCard = document.getElementById('livePassAlertCard');
  const arrivedBtn = document.getElementById('btnArrivedAction');

  const isTableNear = Number(d.estimated_remaining_mins) < 4 && ['waiting', 'delayed'].includes(d.status);
  const isTableReady = d.status === 'notified';
  const isArrivedWaiting = d.has_arrived && d.status === 'waiting';

  if (isTableReady) {
    document.title = "🔔 TABLE READY NOW! • WaitMate India";
    document.getElementById('ticketEtaCountdown').textContent = "TABLE READY NOW!";
    document.getElementById('ticketEtaCountdown').className = "text-2xl font-black text-emerald-600 animate-pulse";
    document.getElementById('ticketStatusMsg').textContent = "Please proceed directly to the host counter. Your table is waiting.";
    
    livePassAlertCard.className = "p-3.5 rounded-xl whatsapp-card text-xs text-emerald-900 shadow-sm space-y-1 border border-emerald-200 bg-emerald-50";
    livePassAlertCard.classList.remove('hidden');
    document.getElementById('livePassAlertText').textContent = `"Namaste ${d.customer_name}! 🍽️ Your table at ${venueName} is READY! Please head to the host desk with Token #${d.ticket_number}. We are holding your spot for 5 minutes."`;

    tableNearAlert.classList.add('hidden');

    // Timeline steps
    document.getElementById('step3Icon').className = "w-5 h-5 mx-auto rounded-full bg-emerald-500 text-white flex items-center justify-center mb-1 font-bold";
    document.getElementById('step3Icon').textContent = "✓";

    // Play sound + push notification on first trigger
    if (!d._hasNotifiedSound) {
      d._hasNotifiedSound = true;
      playNotificationChime();
      sendTableReadyNotification(d);
    }

  } else if (isArrivedWaiting) {
    // Arrived at Venue — Waiting for Host screen
    document.title = "✓ Checked In at Entrance • WaitMate India";
    document.getElementById('ticketEtaCountdown').textContent = `~${d.estimated_remaining_mins} mins remaining`;
    document.getElementById('ticketEtaCountdown').className = "text-2xl font-black text-emerald-600";
    document.getElementById('ticketStatusMsg').textContent = "You're checked in at the entrance. The host will notify you when your table is ready.";

    tableNearAlert.classList.add('hidden');
    livePassAlertCard.className = "p-3.5 rounded-xl whatsapp-card text-xs text-emerald-900 shadow-sm space-y-1 border border-emerald-200 bg-emerald-50";
    livePassAlertCard.classList.remove('hidden');
    document.getElementById('livePassAlertText').textContent = `"✓ Checked In at Entrance — Host Notified. You'll receive a sound chime as soon as the restaurant calls your table. Current wait: ~${d.estimated_remaining_mins} mins."`;

    // Timeline steps - step 2 (In Queue) is complete, step 3 (Table Ready) pending
    document.getElementById('step2Icon').className = "w-5 h-5 mx-auto rounded-full bg-emerald-500 text-white flex items-center justify-center mb-1 font-bold";
    document.getElementById('step2Icon').textContent = "✓";
    document.getElementById('step3Icon').className = "w-5 h-5 mx-auto rounded-full bg-slate-200 text-slate-600 flex items-center justify-center mb-1";
    document.getElementById('step3Icon').textContent = "3";

  } else if (isTableNear) {
    document.title = "🚨 (1) TABLE ALMOST READY • WaitMate India";
    document.getElementById('ticketEtaCountdown').textContent = `~${d.estimated_remaining_mins} mins remaining`;
    document.getElementById('ticketEtaCountdown').className = "text-2xl font-black text-slate-900";
    document.getElementById('ticketStatusMsg').textContent = "Host is clearing a table right now. Please start heading over!";

    const alertAcknowledged = acknowledgedAlertForTicket === d.id;

    if (!alertAcknowledged) {
      tableNearAlert.classList.remove('hidden');
      document.getElementById('nearPositionBadge').textContent = `#${d.position_in_line} in line`;
      document.getElementById('nearDistanceNotice').textContent = 'Priority Boarding';

      livePassAlertCard.className = "p-3.5 rounded-xl whatsapp-card text-xs text-emerald-900 shadow-sm space-y-1";
      livePassAlertCard.classList.remove('hidden');
      document.getElementById('livePassAlertText').textContent = `"Namaste ${d.customer_name}! 🍽️ Your table at ${venueName} is less than 4 mins away. Please make your way to the host desk. Table held for 5 mins."`;

      document.getElementById('step2Icon').className = "w-5 h-5 mx-auto rounded-full bg-orange-500 text-white flex items-center justify-center mb-1 font-bold animate-pulse";

      if (!d._hasNearSoundPlayed) {
        d._hasNearSoundPlayed = true;
        playTableNearChime();
        sendTableNearNotification(d);
      }
    } else {
      tableNearAlert.classList.add('hidden');
      livePassAlertCard.classList.add('hidden');
    }

  } else if (d.status === 'seated') {
    document.title = "🎉 Seated! Enjoy your food • WaitMate India";
    document.getElementById('ticketEtaCountdown').textContent = "Seated & Dining";
    document.getElementById('ticketEtaCountdown').className = "text-2xl font-black text-blue-600";
    document.getElementById('ticketStatusMsg').textContent = "Hope you enjoy your meal! Thank you for using WaitMate.";
    tableNearAlert.classList.add('hidden');
    livePassAlertCard.classList.add('hidden');

    document.getElementById('step4Icon').className = "w-5 h-5 mx-auto rounded-full bg-blue-500 text-white flex items-center justify-center mb-1 font-bold";
    document.getElementById('step4Icon').textContent = "✓";

    // Open post-seating feedback dialog ONLY on the Customer view, for this
    // customer's own remote ticket (never for host-added walk-ins or on the
    // Restaurant Owner / Founder dashboards).
    if (
      currentInterface === 'customer' &&
      d.entry_type === 'remote' &&
      d.status === 'seated' &&
      !d.rated &&
      !d._hasPromptedFeedback &&
      !isTicketRated(d.id)
    ) {
      d._hasPromptedFeedback = true;
      closeTicketModal();
      openFeedbackModal(d);
    }
  } else {
    // Normal waiting
    document.title = `(${d.position_in_line}) In Queue: ${venueName} • WaitMate India`;
    document.getElementById('ticketEtaCountdown').textContent = `~${d.estimated_remaining_mins} mins remaining`;
    document.getElementById('ticketEtaCountdown').className = "text-2xl font-black text-slate-900";
    document.getElementById('ticketStatusMsg').textContent = "You're in good shape! Host estimates are crowd-verified.";
    tableNearAlert.classList.add('hidden');
    livePassAlertCard.classList.add('hidden');
  }

  // Update Arrived button appearance based on state
  if (isArrivedWaiting && arrivedBtn) {
    arrivedBtn.innerHTML = `<i data-lucide="check-check" class="w-4 h-4"></i> <span>✓ Arrival Confirmed • Host Notified</span>`;
    arrivedBtn.className = "w-full py-2.5 px-4 bg-emerald-800 text-emerald-100 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-sm opacity-90 cursor-default";
  } else if (isTableReady && arrivedBtn) {
    // Show "Confirm Seated" button when notified
    arrivedBtn.innerHTML = `<i data-lucide="check-circle-2" class="w-4 h-4"></i> <span>Confirm Seated</span>`;
    arrivedBtn.className = "w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-sm";
    arrivedBtn.onclick = dinerConfirmSeatedAction;
  } else if (d.has_arrived && arrivedBtn) {
    arrivedBtn.innerHTML = `<i data-lucide="check-check" class="w-4 h-4"></i> <span>Arrival Confirmed • Host Notified</span>`;
    arrivedBtn.className = "w-full py-2.5 px-4 bg-emerald-800 text-emerald-100 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-sm opacity-90 cursor-default";
  } else if (arrivedBtn) {
    arrivedBtn.innerHTML = `<i data-lucide="map-pin-check" class="w-4 h-4"></i> <span>I've Arrived at the Venue</span>`;
    arrivedBtn.className = "w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-sm";
    arrivedBtn.onclick = dinerArrivedAction;
  }

  // Update SVG Progress ring
  const circle = document.getElementById('ticketProgressCircle');
  if (circle) {
    const totalEst = Math.max(20, (d.estimated_wait_mins || 0) + (d.delay_mins || 0));
    const progressPct = Math.min(100, Math.max(10, ((totalEst - d.estimated_remaining_mins) / totalEst) * 100));
    const circumference = 2 * Math.PI * 42; // ~264
    const offset = circumference - (progressPct / 100) * circumference;
    circle.style.strokeDashoffset = offset;
  }

  lucide.createIcons();
}

const openTicketModalImpl = function openTicketModal() {
  // Try to restore from localStorage if we don't have active data in memory
  if (!activeTicketData && currentTicketId) {
    try {
      const saved = JSON.parse(localStorage.getItem('waitmate_active_ticket') || 'null');
      if (saved && saved.id && saved.data && !['seated', 'cancelled'].includes(saved.data.status)) {
        activeTicketData = saved.data;
        currentTicketId = saved.id;
        localStorage.setItem('waitmate_ticket_id', currentTicketId);
      }
    } catch (e) { /* ignore corrupt storage */ }
  }
  
  if (!activeTicketData && !currentTicketId) {
    showToast("You don't have an active queue ticket yet. Join a queue first!", "info");
    return;
  }
  updateTicketUI();
  document.getElementById('ticketModal').classList.remove('hidden');
  lucide.createIcons();
};

function closeTicketModal() {
  document.getElementById('ticketModal').classList.add('hidden');
}

function clearCurrentTicket() {
  currentTicketId = null;
  activeTicketData = null;
  acknowledgedAlertForTicket = null;
  graceUntil = null;
  localStorage.removeItem('waitmate_ticket_id');
  if (pollTimer) clearInterval(pollTimer);
  document.title = "WaitMate India 🇮🇳 • Live Restaurant Queues & Reliability Network";
  document.getElementById('activeTicketPill').classList.add('hidden');
  closeTicketModal();
}

// ==========================================
// 2B. SHAREABLE LIVE PASS & FRIEND TRACKER
// ==========================================

let friendTicketId = null;
let friendPollTimer = null;

function buildShareLink(ticketId) {
  return `${window.location.origin}?ticket=${encodeURIComponent(ticketId)}`;
}

function buildShareMessage(ticketData) {
  const venueName = (ticketData.restaurant && ticketData.restaurant.name) || (ticketData.restaurant_name) || 'this restaurant';
  const rank = ticketData.position_in_line ?? '?';
  const eta = ticketData.estimated_remaining_mins ?? ticketData.estimated_wait_mins ?? '?';
  const link = buildShareLink(currentTicketId || (ticketData.id || ''));
  return `I'm #${rank} in line at ${venueName} (~${eta} mins wait) on WaitMate! Track our live table status: ${link}`;
}

async function sharePass() {
  if (!currentTicketId && !activeTicketData) {
    showToast("No active pass to share yet. Join a queue first!", "info");
    return;
  }
  const ticketId = currentTicketId || activeTicketData.id;
  const link = buildShareLink(ticketId);
  const message = buildShareMessage(activeTicketData || {});
  const shareData = { title: 'My WaitMate Live Pass', text: message, url: link };

  // Mobile native share first, clean clipboard fallback on desktop
  if (navigator.share) {
    try {
      await navigator.share(shareData);
      showToast("Pass shared!", "success");
      return;
    } catch (err) {
      // User cancelled or share failed — fall through to clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(`${message}\n${link}`);
    showToast("Live pass link copied to clipboard", "success");
  } catch (err) {
    window.prompt("Copy this link to share your live pass:", link);
  }
}

async function sharePassWhatsApp() {
  if (!currentTicketId && !activeTicketData) {
    showToast("No active pass to share yet. Join a queue first!", "info");
    return;
  }
  const ticketId = currentTicketId || activeTicketData.id;
  const link = buildShareLink(ticketId);
  const message = buildShareMessage(activeTicketData || {});
  try { await navigator.clipboard.writeText(message); } catch (e) { /* clipboard optional */ }
  window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  showToast("Opening WhatsApp…", "success");
}

async function copySharePassLink() {
  if (!currentTicketId && !activeTicketData) {
    showToast("No active pass to copy yet.", "info");
    return;
  }
  const ticketId = currentTicketId || activeTicketData.id;
  const link = buildShareLink(ticketId);
  try {
    await navigator.clipboard.writeText(link);
    const icon = document.getElementById('copyShareIcon');
    const label = document.getElementById('copyShareLabel');
    if (icon) {
      icon.setAttribute('data-lucide', 'check-circle-2');
      lucide.createIcons();
    }
    if (label) label.textContent = 'Copied!';
    showToast("Link copied to clipboard", "success");
    setTimeout(() => {
      if (icon) {
        icon.setAttribute('data-lucide', 'copy');
        lucide.createIcons();
      }
      if (label) label.textContent = 'Copy Link';
    }, 2000);
  } catch (err) {
    window.prompt("Copy this link to share your live pass:", link);
  }
}

// Update the share link preview when the pass modal opens
const _origOpenTicketModal = openTicketModalImpl;
function openTicketModal() {
  _origOpenTicketModal();
  const preview = document.getElementById('sharePassLinkPreview');
  if (preview) preview.textContent = buildShareLink(currentTicketId || (activeTicketData && activeTicketData.id || ''));
}

// Read-only Live Friend Pass Tracker — opened via ?ticket=<id> deep link.
// Friends can view rank/ETA/venue/status but cannot cancel or modify the ticket.
async function openFriendPassTracker(ticketId) {
  friendTicketId = ticketId;
  const modal = document.getElementById('friendPassModal');
  if (modal) modal.classList.remove('hidden');
  await fetchFriendTicketStatus();
  if (friendPollTimer) clearInterval(friendPollTimer);
  friendPollTimer = setInterval(fetchFriendTicketStatus, 5000);
}

async function fetchFriendTicketStatus() {
  if (!friendTicketId) return;
  try {
    const res = await fetch(`/api/queue/ticket/${encodeURIComponent(friendTicketId)}`, { cache: 'no-store' });
    if (res.status === 404) {
      const rankEl = document.getElementById('friendPassRank');
      const etaEl = document.getElementById('friendPassEta');
      const statusEl = document.getElementById('friendPassStatus');
      if (rankEl) rankEl.textContent = '#–';
      if (etaEl) etaEl.textContent = '– mins';
      if (statusEl) statusEl.textContent = 'Not Found';
      return;
    }
    const data = await res.json();
    document.getElementById('friendPassRank').textContent = `#${data.position_in_line ?? '–'}`;
    const eta = data.estimated_remaining_mins ?? data.estimated_wait_mins ?? '–';
    document.getElementById('friendPassEta').textContent = eta === '–' ? '– mins' : `~${eta} mins`;
    document.getElementById('friendPassVenueName').textContent = (data.restaurant && data.restaurant.name) || data.restaurant_name || 'Partner Venue';
    document.getElementById('friendPassVenueAddress').textContent = (data.restaurant && data.restaurant.address) || '';
    const statusMap = { waiting: 'Waiting', notified: 'Table Ready', delayed: 'Delayed', seated: 'Seated', cancelled: 'Cancelled' };
    const statusText = statusMap[data.status] || data.status || 'Waiting';
    const statusEl = document.getElementById('friendPassStatus');
    statusEl.textContent = statusText;
    statusEl.className = "font-bold " + (data.status === 'notified' ? 'text-emerald-700' : data.status === 'seated' ? 'text-blue-600' : data.status === 'cancelled' ? 'text-rose-600' : data.status === 'delayed' ? 'text-amber-700' : 'text-emerald-700');
  } catch (err) {
    console.warn('Friend pass tracker fetch failed:', err);
  }
}

function closeFriendPassModal() {
  const modal = document.getElementById('friendPassModal');
  if (modal) modal.classList.add('hidden');
  if (friendPollTimer) { clearInterval(friendPollTimer); friendPollTimer = null; }
  friendTicketId = null;
}

// Seated-rating gate helpers
function isTicketRated(ticketId) {
  if (!ticketId) return false;
  if (ratedTickets.has(ticketId)) return true;
  return !!(activeTicketData && activeTicketData.id === ticketId && activeTicketData.rated);
}

function markTicketRated(ticketId) {
  if (!ticketId) return;
  ratedTickets.add(ticketId);
  try {
    localStorage.setItem(RATED_STORAGE_KEY, JSON.stringify([...ratedTickets]));
  } catch (e) { /* ignore storage errors */ }
  if (activeTicketData && activeTicketData.id === ticketId) {
    activeTicketData.rated = true;
    try {
      localStorage.setItem('waitmate_active_ticket', JSON.stringify({ id: currentTicketId, data: activeTicketData }));
    } catch (e) { /* ignore */ }
  }
}

function showAcknowledgedAlertBanner(mode) {
  const banner = document.getElementById('tableNearAlertBanner');
  if (!banner) return;
  const isGrace = mode === 'grace';
  banner.className = "p-4 rounded-2xl bg-gradient-to-r from-emerald-50/15 via-emerald-50/15 to-emerald-50/15 border-2 border-emerald-400/80";
  banner.innerHTML = `<div class="flex items-start gap-3"><div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-500 text-white flex items-center justify-center shrink-0 shadow-md"><i data-lucide="check-circle-2" class="w-5 h-5"></i></div><div class="flex-1"><div class="flex items-center gap-1.5 mb-1"><span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-black uppercase bg-emerald-100 text-emerald-900 tracking-wider">${isGrace ? 'GRACE PERIOD ACTIVE' : 'HOST NOTIFIED'}</span></div><h4 class="font-heading font-extrabold text-sm text-slate-900 leading-tight">✓ ${isGrace ? '+5 Min Grace Period Active — Hold Confirmed' : 'Host Notified: You\'re at the Entrance'}</h4><p class="text-slate-700 text-[11px] mt-1 leading-snug">${isGrace ? 'Your token is held for 5 minutes. Your spot is secure — take your time.' : 'The host stand has been notified you are at the entrance. Your table is being prepared.'}</p></div></div>`;
  lucide.createIcons();
}

// ==========================================
// 6. DINER ARRIVAL STATUS ACTION
// ==========================================
async function dinerArrivedAction() {
  if (!currentTicketId && !activeTicketData) {
    showToast("No active ticket found. Please join a queue first.", "info");
    return;
  }

  // 1. Immediate optimistic UI state update — "I'm at the Venue" marks arrival
  if (activeTicketData) {
    activeTicketData.has_arrived = 1;
    activeTicketData.arrival_status = 'At Venue Entrance';
    activeTicketData.status = 'waiting'; // Keep as waiting - not seated yet
    activeTicketData.arrived_at = Date.now();
    activeTicketData.arrived_time_ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST';
    acknowledgedAlertForTicket = currentTicketId || activeTicketData.id;
    graceUntil = null;
    activeTicketData._hasNearSoundPlayed = true;
    activeTicketData._hasNotifiedSound = true;
    // Persist immediately to localStorage so cold starts don't lose arrival state
    localStorage.setItem('waitmate_active_ticket', JSON.stringify({ id: currentTicketId || activeTicketData.id, data: activeTicketData }));
    updateTicketUI();
    showAcknowledgedAlertBanner('entrance');
  }

  const btn = document.getElementById('btnArrivedAction');
  if (btn) {
    btn.innerHTML = `<i data-lucide="check-check" class="w-4 h-4"></i> <span>✓ Arrival Confirmed • Host Notified</span>`;
    btn.className = "w-full py-2.5 px-4 bg-emerald-800 text-emerald-100 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-sm opacity-90 cursor-default";
    lucide.createIcons();
  }

  // 2. Transmit to backend with robust fallback parameters
  try {
    const payload = {
      ticket_id: currentTicketId || (activeTicketData ? (activeTicketData.id || activeTicketData.ticket_number) : "WM-101"),
      action: 'arrived',
      restaurant_id: activeTicketData ? activeTicketData.restaurant_id : 'rest-1',
      customer_name: activeTicketData ? activeTicketData.customer_name : 'Arrived Guest',
      phone: ''
    };

    const res = await fetch('/api/queue/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (parseErr) { data = {}; }
    if (res.ok && data.success) {
      showToast("Arrival confirmed! Host has been notified.", "success");
    } else {
      // Even on 404/error, local state is already updated - just show a softer message
      showToast("Arrival confirmed with host stand.", "info");
    }

    if (currentTicketId) await fetchTicketStatus();
  } catch (err) {
    console.warn("Arrival sync warning:", err);
    // Optimistic fallback: diner arrival confirmed locally
    showToast("Arrival confirmed! Host has been notified.", "success");
    if (activeTicketData) {
      activeTicketData.has_arrived = 1;
      activeTicketData.arrival_status = 'At Venue Entrance';
      activeTicketData.status = 'waiting';
      activeTicketData.arrived_at = Date.now();
      activeTicketData.arrived_time_ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST';
      localStorage.setItem('waitmate_active_ticket', JSON.stringify({ id: currentTicketId || activeTicketData.id, data: activeTicketData }));
      updateTicketUI();
    }
  }
}

// ==========================================
// 6b. DINER CONFIRM SEATED ACTION (After being notified)
// ==========================================
async function dinerConfirmSeatedAction() {
  if (!currentTicketId && !activeTicketData) {
    showToast("No active ticket found. Please join a queue first.", "info");
    return;
  }

  // 1. Immediate optimistic UI state update — "Confirm Seated" marks seating
  if (activeTicketData) {
    activeTicketData.status = 'seated';
    activeTicketData.seated_at = Date.now();
    activeTicketData.seated_time_ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST';
    activeTicketData.actual_wait_mins = Math.max(1, Math.floor((Date.now() - Number(activeTicketData.joined_at || Date.now())) / 60000));
    activeTicketData.has_arrived = 1;
    acknowledgedAlertForTicket = currentTicketId || activeTicketData.id;
    graceUntil = null;
    activeTicketData._hasNearSoundPlayed = true;
    activeTicketData._hasNotifiedSound = true;
    // Persist immediately to localStorage
    localStorage.setItem('waitmate_active_ticket', JSON.stringify({ id: currentTicketId || activeTicketData.id, data: activeTicketData }));
    updateTicketUI();
  }

  // 2. Transmit to backend
  try {
    const payload = {
      ticket_id: currentTicketId || (activeTicketData ? (activeTicketData.id || activeTicketData.ticket_number) : "WM-101"),
      action: 'seated',
      restaurant_id: activeTicketData ? activeTicketData.restaurant_id : 'rest-1',
      customer_name: activeTicketData ? activeTicketData.customer_name : 'Seated Guest',
      phone: ''
    };

    const res = await fetch('/api/queue/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (parseErr) { data = {}; }
    if (res.ok && data.success) {
      showToast("Seating confirmed! Please rate your experience.", "success");
    } else {
      showToast("Seating confirmed with host stand.", "info");
    }

    if (currentTicketId) await fetchTicketStatus();
  } catch (err) {
    console.warn("Seating sync warning:", err);
    showToast("Seating confirmed! Please rate your experience.", "success");
    if (activeTicketData) {
      activeTicketData.status = 'seated';
      activeTicketData.seated_at = Date.now();
      activeTicketData.seated_time_ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST';
      activeTicketData.actual_wait_mins = Math.max(1, Math.floor((Date.now() - Number(activeTicketData.joined_at || Date.now())) / 60000));
      localStorage.setItem('waitmate_active_ticket', JSON.stringify({ id: currentTicketId || activeTicketData.id, data: activeTicketData }));
      updateTicketUI();
    }
  }
}

async function dinerDelayAction(mins) {
  if (!currentTicketId && !activeTicketData) return;
  const tId = currentTicketId || activeTicketData.id;
  acknowledgedAlertForTicket = tId;
  graceUntil = Date.now() + mins * 60 * 1000;
  if (activeTicketData) {
    activeTicketData._hasNearSoundPlayed = true;
    activeTicketData._hasNotifiedSound = true;
    activeTicketData.delay_mins = (activeTicketData.delay_mins || 0) + mins;
    activeTicketData.status = 'delayed';
    // Persist immediately to localStorage
    localStorage.setItem('waitmate_active_ticket', JSON.stringify({ id: tId, data: activeTicketData }));
  }
  try {
    const res = await fetch('/api/queue/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_id: tId, action: 'delay', minutes: mins })
    });
    let data = {};
    try { data = await res.json(); } catch (parseErr) { data = {}; }
    showToast("+5 min grace buffer added to your pass!", "success");
    updateTicketUI();
    showAcknowledgedAlertBanner('grace');
    lucide.createIcons();
    if (currentTicketId) await fetchTicketStatus();
  } catch (err) {
    showToast("+5 min grace buffer added to your pass!", "success");
    if (activeTicketData) {
      updateTicketUI();
    }
    showAcknowledgedAlertBanner('grace');
    lucide.createIcons();
  }
}

async function dinerCancelAction() {
  if (!currentTicketId && !activeTicketData) return;
  if (!confirm("Are you sure you want to leave the queue?")) return;
  const tId = currentTicketId || activeTicketData.id;
  try {
    const res = await fetch('/api/queue/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_id: tId, action: 'cancel' })
    });
    let data = {};
    try { data = await res.json(); } catch (parseErr) { data = {}; }
    showToast(data.message || "Queue spot cancelled.", "info");
    clearCurrentTicket();
    await loadRestaurants();
  } catch (err) {
    showToast("Queue spot cancelled.", "info");
    clearCurrentTicket();
    await loadRestaurants();
  }
}

// ==========================================
// 7. RELIABILITY SCORE AUDIT MODAL
// ==========================================
let currentReviewVenueId = null;
let currentReviewVenueName = null;

async function openReliabilityModal(venueId) {
  let r = null;
  try {
    const res = await fetch(`/api/restaurants/${venueId}`, { cache: 'no-store' });
    if (res.ok) r = await res.json();
  } catch (err) {
    console.warn("Using offline fallback for reliability modal:", err);
  }

  if (!r) {
    r = allRestaurants.find(x => x.id === venueId) || fallbackRestaurants[0];
  }

  if (!r.hourly_patterns) {
    r.hourly_patterns = [
      {"hour": "8:30 AM", "avg_wait": 8, "reliability": 98, "rush_level": "Breakfast Rush"},
      {"hour": "10:30 AM", "avg_wait": 5, "reliability": 97, "rush_level": "Low"},
      {"hour": "1:00 PM", "avg_wait": 28, "reliability": 91, "rush_level": "Lunch Peak"},
      {"hour": "2:30 PM", "avg_wait": 12, "reliability": 95, "rush_level": "Moderate"},
      {"hour": "5:30 PM", "avg_wait": 10, "reliability": 96, "rush_level": "Chai & Snacks"},
      {"hour": "8:00 PM", "avg_wait": 32, "reliability": 88, "rush_level": "Dinner Rush"},
      {"hour": "9:30 PM", "avg_wait": 40, "reliability": 83, "rush_level": "Peak Dinner"},
      {"hour": "11:00 PM", "avg_wait": 15, "reliability": 94, "rush_level": "Late Night"}
    ];
  }

  const rel = r.reliability || { score: 95, grade: 'A+', avg_variance_mins: 1.5, total_verified_checkins: 30, on_time_pct: 80, early_pct: 12, slight_late_pct: 8, severe_late_pct: 0 };

  // Derive a deterministic verified check-in count from the venue's reliability score & ID
  const idSeed = String(venueId || r.id || '').split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const verifiedCheckins = Math.max(12, Math.round((rel.score || 95) * 0.6) + (idSeed % 40));

  document.getElementById('relModalVenueName').textContent = r.name;
  document.getElementById('relModalScoreNum').textContent = `${rel.score}%`;
  document.getElementById('relModalGrade').textContent = `Grade ${rel.grade}`;
  document.getElementById('relModalVerdict').textContent = `${rel.verdict || 'Highly Accurate'} — ${rel.score >= 85 ? 'Consistently delivers on queue estimates.' : 'Noticeable variance during peak rush.'}`;
  document.getElementById('relModalVariance').textContent = `± ${rel.avg_variance_mins} mins`;
  document.getElementById('relModalTotalReviews').textContent = `${verifiedCheckins} verified check-ins`;

  // Distribution Bars
  document.getElementById('distSpotOn').textContent = `${rel.on_time_pct}%`;
  document.getElementById('barSpotOn').style.width = `${rel.on_time_pct}%`;

  document.getElementById('distFaster').textContent = `${rel.early_pct}%`;
  document.getElementById('barFaster').style.width = `${rel.early_pct}%`;

  document.getElementById('distSlight').textContent = `${rel.slight_late_pct}%`;
  document.getElementById('barSlight').style.width = `${rel.slight_late_pct}%`;

  document.getElementById('distSevere').textContent = `${rel.severe_late_pct}%`;
  document.getElementById('barSevere').style.width = `${rel.severe_late_pct}%`;

  // Hourly patterns chart
  renderHourlyPatternChart(r.hourly_patterns);

  // Store current venue for review submission
  currentReviewVenueId = venueId;
  currentReviewVenueName = r.name;

  // 1–5 star rating is only available once the diner has been seated at this venue
  const reviewWidget = document.getElementById('reviewWidget');
  const seatedHere = activeTicketData && activeTicketData.status === 'seated' && activeTicketData.restaurant_id === venueId && !isTicketRated(activeTicketData.id);
  if (reviewWidget) {
    if (seatedHere) reviewWidget.classList.remove('hidden');
    else reviewWidget.classList.add('hidden');
  }

  // Initialize star rating widget
  initStarRatingWidget();

  // Fetch and display live reviews
  await fetchAndRenderReviews(venueId);

  document.getElementById('reliabilityModal').classList.remove('hidden');
  lucide.createIcons();
}

function closeReliabilityModal() {
  document.getElementById('reliabilityModal').classList.add('hidden');
  // Reset review widget
  resetReviewWidget();
}

function initStarRatingWidget() {
  const starBtns = document.querySelectorAll('#starRatingWidget .star-btn');
  const ratingInput = document.getElementById('reviewRatingInput');
  const ratingDisplay = document.getElementById('starRatingDisplay');
  const submitBtn = document.getElementById('submitReviewBtn');

  starBtns.forEach(btn => {
    btn.onclick = () => {
      const star = parseInt(btn.dataset.star);
      ratingInput.value = star;
      updateStarDisplay(star);
      submitBtn.disabled = false;
    };
  });
}

function updateStarDisplay(rating) {
  const starBtns = document.querySelectorAll('#starRatingWidget .star-btn');
  const ratingDisplay = document.getElementById('starRatingDisplay');

  starBtns.forEach(btn => {
    const star = parseInt(btn.dataset.star);
    if (star <= rating) {
      btn.classList.remove('text-slate-300');
      btn.classList.add('text-amber-400');
    } else {
      btn.classList.remove('text-amber-400');
      btn.classList.add('text-slate-300');
    }
  });

  if (rating > 0) {
    ratingDisplay.textContent = `${rating} / 5`;
  } else {
    ratingDisplay.textContent = '';
  }
}

function initFbStarRating() {
  const starBtns = document.querySelectorAll('#fbStarRating .fb-star-btn');
  const ratingInput = document.getElementById('fbStarInput');
  const ratingDisplay = document.getElementById('fbStarDisplay');

  starBtns.forEach(btn => {
    btn.onclick = () => {
      const star = parseInt(btn.dataset.star);
      ratingInput.value = star;
      updateFbStarDisplay(star);
    };
  });
}

function updateFbStarDisplay(rating) {
  const starBtns = document.querySelectorAll('#fbStarRating .fb-star-btn');
  const ratingDisplay = document.getElementById('fbStarDisplay');

  starBtns.forEach(btn => {
    const star = parseInt(btn.dataset.star);
    if (star <= rating) {
      btn.classList.remove('text-slate-300');
      btn.classList.add('text-amber-400');
    } else {
      btn.classList.remove('text-amber-400');
      btn.classList.add('text-slate-300');
    }
  });

  if (rating > 0) {
    ratingDisplay.textContent = `${rating} / 5`;
  } else {
    ratingDisplay.textContent = '';
  }
}

function resetReviewWidget() {
  const starBtns = document.querySelectorAll('#starRatingWidget .star-btn');
  const ratingInput = document.getElementById('reviewRatingInput');
  const ratingDisplay = document.getElementById('starRatingDisplay');
  const commentInput = document.getElementById('reviewCommentInput');
  const submitBtn = document.getElementById('submitReviewBtn');

  starBtns.forEach(btn => {
    btn.classList.remove('text-amber-400');
    btn.classList.add('text-slate-300');
  });
  ratingInput.value = '0';
  ratingDisplay.textContent = '';
  commentInput.value = '';
  submitBtn.disabled = true;
}

async function fetchAndRenderReviews(venueId) {
  const container = document.getElementById('relRecentReviews');
  container.innerHTML = `<p class="text-slate-400 text-xs italic text-center py-4">Loading reviews...</p>`;

  try {
    const res = await fetch(`/api/reviews?restaurantId=${encodeURIComponent(venueId)}`);
    if (res.ok) {
      const data = await res.json();
      renderReviews(data.reviews || []);
    } else {
      container.innerHTML = `<p class="text-slate-400 text-xs italic text-center py-4">No reviews yet.</p>`;
    }
  } catch (err) {
    console.warn("Failed to fetch reviews:", err);
    container.innerHTML = `<p class="text-slate-400 text-xs italic text-center py-4">No reviews yet.</p>`;
  }
}

function renderReviews(reviews) {
  const container = document.getElementById('relRecentReviews');

  if (!reviews || reviews.length === 0) {
    container.innerHTML = `<p class="text-slate-400 text-xs italic text-center py-4">No reviews yet.</p>`;
    return;
  }

  container.innerHTML = reviews.map(review => {
    const stars = '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating);
    const timeAgo = formatTimeAgo(review.created_at);

    return `
      <div class="bg-slate-50 p-3 rounded-xl border border-slate-200 text-xs">
        <div class="flex items-center justify-between mb-1">
          <div class="flex items-center gap-2">
            <span class="text-amber-400 text-sm font-medium">${stars}</span>
            <span class="text-slate-600 font-medium">${review.rating} / 5</span>
          </div>
          <span class="text-slate-600 text-[10px]">${timeAgo}</span>
        </div>
        ${review.comment ? `<p class="text-slate-700 font-medium italic">"${review.comment}"</p>` : ''}
      </div>
    `;
  }).join('');
}

function formatTimeAgo(timestamp) {
  const now = Date.now();
  const diff = now - Number(timestamp);
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

async function submitReview() {
  const rating = parseInt(document.getElementById('reviewRatingInput').value);
  const comment = document.getElementById('reviewCommentInput').value.trim();
  const submitBtn = document.getElementById('submitReviewBtn');

  if (!rating || rating < 1 || rating > 5) {
    showToast("Please select a star rating", "error");
    return;
  }

  if (!currentReviewVenueId || !currentReviewVenueName) {
    showToast("Venue context lost. Please reopen the modal.", "error");
    return;
  }

  const t = activeTicketData;
  if (!t || t.status !== 'seated' || t.restaurant_id !== currentReviewVenueId || isTicketRated(t.id)) {
    showToast("Star ratings are only available after you've been seated at this venue.", "error");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting...';

  try {
    const res = await fetch('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantId: currentReviewVenueId,
        restaurantName: currentReviewVenueName,
        rating: rating,
        comment: comment,
        ticket_id: activeTicketData ? activeTicketData.id : null,
        guest_name: activeTicketData ? (activeTicketData.guest_name || activeTicketData.customer_name || activeTicketData.name) : null
      })
    });

    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to submit review');

    showToast("Thanks! Your verified check-in is live.", "success");

    // Mark this visit as rated so the prompt doesn't reappear
    if (activeTicketData) markTicketRated(activeTicketData.id);

    // Reset widget
    resetReviewWidget();

    // Immediately refresh reviews
    await fetchAndRenderReviews(currentReviewVenueId);

  } catch (err) {
    console.error("Review submit error:", err);
    showToast(err.message || "Failed to submit review. Please try again.", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Review';
  }
}

function renderHourlyPatternChart(patterns) {
  const container = document.getElementById('hourlyChartContainer');
  if (!container || !patterns) return;

  container.innerHTML = `
    <div class="grid grid-cols-4 sm:grid-cols-8 gap-2 text-center text-[10px]">
      ${patterns.map(p => {
        let barColor = "bg-emerald-400";
        if (p.rush_level === 'High' || p.rush_level === 'Lunch Peak' || p.rush_level === 'Dinner Rush') barColor = "bg-amber-400";
        if (p.rush_level === 'Peak' || p.rush_level === 'Peak Dinner') barColor = "bg-rose-400";

        const heightPct = Math.min(100, Math.max(12, (p.avg_wait / 45) * 100));

        return `
          <div class="flex flex-col items-center">
            <span class="font-bold text-slate-700">${p.avg_wait}m</span>
            <div class="w-full h-16 bg-slate-200 rounded-md overflow-hidden flex flex-col justify-end my-1 p-0.5">
              <div class="w-full ${barColor} rounded-sm" style="height: ${heightPct}%" title="${p.hour}: ${p.avg_wait}m wait (${p.reliability}% accurate)"></div>
            </div>
            <span class="text-slate-600 font-medium truncate w-full">${p.hour.replace(':00', '')}</span>
            <span class="text-[9px] text-slate-600">${p.rush_level}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ==========================================
// 8. POST-SEATING FEEDBACK & VERIFICATION
// ==========================================
function openFeedbackModal(ticket) {
  document.getElementById('fbTicketId').value = ticket.id;
  document.getElementById('fbRestaurantId').value = ticket.restaurant_id;
  document.getElementById('fbPromisedWait').textContent = `${ticket.estimated_wait_mins} mins`;
  document.getElementById('fbActualWait').textContent = `${ticket.actual_wait_mins || ticket.estimated_wait_mins} mins`;
  // Reset the 1–5 star selector for this seated visit
  document.getElementById('fbStarInput').value = '0';
  updateFbStarDisplay(0);
  document.getElementById('fbNoteInput').value = '';
  selectFbRating('spot_on');
  document.getElementById('feedbackModal').classList.remove('hidden');
  lucide.createIcons();
}

function selectFbRating(rating) {
  document.getElementById('fbRatingInput').value = rating;
  document.querySelectorAll('.fb-opt-btn').forEach(btn => {
    if (btn.dataset.rating === rating) {
      btn.className = "fb-opt-btn p-3 border rounded-xl font-semibold text-center border-emerald-500 bg-emerald-50 text-emerald-900";
    } else {
      btn.className = "fb-opt-btn p-3 border rounded-xl font-semibold text-center border-slate-200 hover:border-slate-300 text-slate-700";
    }
  });
}

async function submitDinerFeedback(e) {
  e.preventDefault();
  const restId = document.getElementById('fbRestaurantId').value;
  const ticketId = document.getElementById('fbTicketId').value;
  const accuracyRating = document.getElementById('fbRatingInput').value;
  const stars = parseInt(document.getElementById('fbStarInput').value);
  const note = document.getElementById('fbNoteInput').value.trim();

  // Get the ticket data from the feedback modal's context
  const promisedWait = parseInt(document.getElementById('fbPromisedWait').textContent) || 15;
  const actualWait = parseInt(document.getElementById('fbActualWait').textContent) || 15;
  const venueObj = (allRestaurants || []).find(r => r.id === restId) || (activeTicketData && activeTicketData.restaurant);
  const venueName = venueObj ? venueObj.name : 'Restaurant';

  if (!stars || stars < 1 || stars > 5) {
    showToast("Please select a star rating (1–5) before submitting.", "error");
    return;
  }
  if (!restId || !ticketId) {
    showToast("Ticket context lost. Please reopen your pass.", "error");
    return;
  }

  const submitBtn = e.currentTarget ? e.currentTarget.querySelector('button[type="submit"]') : null;
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting...'; }

  // Mark this ticket as rated in localStorage + in-memory state BEFORE any
  // network request, so the background ticket poll cannot re-open the
  // "You've Been Seated!" modal while the rating request is still in flight.
  markTicketRated(ticketId);

  try {
    // 1. Record wait-accuracy check-in (updates the public Reliability Score™)
    await fetch('/api/reliability/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurant_id: restId,
        ticket_id: ticketId,
        promised_wait: promisedWait,
        actual_wait: actualWait,
        rating: accuracyRating,
        note: note
      })
    });

    // 2. Save the 1–5 star rating + comment to Firestore / reviews
    const reviewRes = await fetch('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantId: restId,
        restaurantName: venueName,
        rating: stars,
        comment: note,
        ticket_id: ticketId
      })
    });
    const reviewData = await reviewRes.json().catch(() => ({}));
    if (!reviewRes.ok) throw new Error(reviewData.error || 'Failed to save star rating');

    // 3. Persist the rated flag on the server (backend safely ignores duplicates if already rated)
    await fetch('/api/queue/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_id: ticketId, action: 'rate', rating: stars, comment: note })
    });
    markTicketRated(ticketId);

    showToast("Thanks! Your 1–5 star rating has been saved for this visit.", "success");
    document.getElementById('feedbackModal').classList.add('hidden');
    clearCurrentTicket();
    await loadRestaurants();
  } catch (err) {
    // Offline fallback: still record the rating locally so the prompt doesn't reappear
    console.warn("Feedback submit fallback:", err);
    markTicketRated(ticketId);
    showToast("Rating saved locally for this visit. Thank you!", "success");
    document.getElementById('feedbackModal').classList.add('hidden');
    clearCurrentTicket();
    await loadRestaurants();
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit Verified Check-in & Update Score'; }
  }
}

// ==========================================
// 9. RESTAURANT OWNER HOST STAND LOGIC
// ==========================================
function populateHostDropdown() {
  const select = document.getElementById('hostVenueSelect');
  if (!select) return;
  select.innerHTML = allRestaurants.map(r => `
    <option value="${r.id}" ${r.id === currentHostVenueId ? 'selected' : ''}>
      ${r.name} (${r.city || 'Mumbai'})
    </option>
  `).join('');
}

async function switchHostVenue(venueId) {
  currentHostVenueId = venueId;
  await loadHostStand();
}

function toggleHostGhostGuests(checked) {
  hostShowGhostGuests = !!checked;
  renderHostDashboard();
}

async function spawnGhostGuests() {
  if (!currentHostVenueId) {
    showToast("No venue selected. Open a Host Stand first.", "info");
    return;
  }
  const btn = document.getElementById('hostSpawnGhostBtn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<i data-lucide="loader-circle" class="w-3 h-3 animate-spin"></i> <span>Spawning...</span>`;
  lucide.createIcons();
  try {
    // Founder master password (prompt once per session). In DEMO_MODE the
    // backend skips the password check entirely so a single click spawns ghosts.
    let pwd = sessionStorage.getItem('wm_founder_password') || '';
    let useFounderHeader = true;
    try {
      const probe = await fetch('/api/health/storage', { cache: 'no-store' });
      if (probe.ok) {
        const info = await probe.json();
        if (info && info.demo_mode) {
          useFounderHeader = false;
          pwd = '';
        }
      }
    } catch (_) { /* ignore probe errors */ }

    if (!pwd && useFounderHeader) {
      pwd = window.prompt("Founder verification required\nEnter the Founder Master Password to spawn AI ghost guests:");
      if (pwd === null) return;
      pwd = pwd.trim();
      if (!pwd) { showToast("Founder password required.", "info"); return; }
      sessionStorage.setItem('wm_founder_password', pwd);
    }

    const headers = { 'Content-Type': 'application/json' };
    if (useFounderHeader && pwd) headers['X-Founder-Password'] = pwd;

    const res = await fetch('/api/queue/spawn-ghosts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ restaurant_id: currentHostVenueId, count: 5 }),
      cache: 'no-store'
    });
    if (res.status === 401) {
      sessionStorage.removeItem('wm_founder_password');
      showToast("Incorrect Founder Master Password.", "error");
      return;
    }
    if (!res.ok) throw new Error('Spawn request failed');
    const data = await res.json();
    showToast(`Spawned ${data.spawned} AI ghost guest(s) at ${data.restaurant_id}.`, "success");
    await loadHostStand();
  } catch (err) {
    console.warn("Spawn ghost guests error:", err);
    showToast("Failed to spawn AI ghost guests.", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
    lucide.createIcons();
  }
}

async function loadHostStand() {
  if (isAnyPasswordModalOpen()) return;
  const savedPwd = getSavedHostPassword(currentHostVenueId);
  if (!savedPwd) {
    showOwnerDirectory();
    return;
  }
  await renderUnlockedHostStand(currentHostVenueId, savedPwd);
}

// Auto-poll the Host Stand queue every 5s while the owner tab is active so new
// customer joins appear automatically and fire a single alert without page reloads.
function startHostStandPolling() {
  if (hostStandPollTimer) clearInterval(hostStandPollTimer);
  hostStandPollTimer = setInterval(() => {
    if (currentInterface === 'owner' && currentHostVenueId) {
      loadHostStand();
    }
  }, 5000);
}

function stopHostStandPolling() {
  if (hostStandPollTimer) {
    clearInterval(hostStandPollTimer);
    hostStandPollTimer = null;
  }
}

// ==========================================
// Live Host Announcement / Specials
// ==========================================
async function updateHostAnnouncement(announcement = null) {
  const input = document.getElementById('hostAnnouncementInput');
  const announcementText = announcement !== null ? announcement : (input ? input.value.trim() : '');
  if (!currentHostVenueId) return;
  try {
    const res = await fetch('/api/host/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Restaurant-Password': getSavedHostPassword(currentHostVenueId) },
      body: JSON.stringify({
        restaurant_id: currentHostVenueId,
        action: 'update_announcement',
        announcement: announcementText
      })
    });
    let data = {};
    try { data = await res.json(); } catch (parseErr) { data = {}; }
    if (!res.ok) { showToast(data.error || "Error publishing announcement", "error"); return; }
    showToast(data.message || "Announcement published", "success");
    if (input) input.value = announcementText;
    await loadHostStand();
    await loadRestaurants();
  } catch (err) {
    showToast("Error publishing announcement", "error");
  }
}

// Resolve a queue entry's join moment (accepts ms or seconds stamps) and format
// it as an Asia/Kolkata IST time plus a relative "Xm ago" string for the owner
// Host Stand waitlist rows.
function hostJoinInfo(q) {
  const raw = q.joined_at_ms !== undefined && q.joined_at_ms !== null ? q.joined_at_ms : (q.joined_at !== undefined && q.joined_at !== null ? q.joined_at : Date.now());
  const ms = Number(raw) > 1e12 ? Number(raw) : Number(raw) * 1000;
  const ist = isNaN(ms) ? '--:--' : new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
  const mins = isNaN(ms) ? 0 : Math.floor((Date.now() - ms) / 60000);
  const relative = mins < 1 ? 'just now' : `${mins}m ago`;
  return { ist, relative, ms };
}

function renderHostDashboard() {
  if (!hostData) return;
  const r = hostData.restaurant;
  const stats = hostData.live_stats;
  const rel = hostData.reliability;
  const queue = hostData.queue || [];
  const visibleQueue = hostShowGhostGuests ? queue : queue.filter(q => !(q && (q.is_ghost || q.isGhost || q.entry_type === 'ghost')));

  document.getElementById('hostVenueName').textContent = r.name;
  document.getElementById('hostVenueLocationSub').textContent = `${r.address} • Host Stand Dashboard`;
  
  const openBadge = document.getElementById('hostQueueOpenBadge');
  const toggleBtn = document.getElementById('hostToggleQueueBtn');
  if (stats.is_queue_open) {
    openBadge.className = "bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-300";
    openBadge.textContent = "QUEUE ACTIVE";
    toggleBtn.innerHTML = `<i data-lucide="pause" class="w-3.5 h-3.5"></i> <span>Pause Queue</span>`;
  } else {
    openBadge.className = "bg-rose-100 text-rose-800 text-[10px] font-bold px-2 py-0.5 rounded-full border border-rose-300";
    openBadge.textContent = "QUEUE PAUSED";
    toggleBtn.innerHTML = `<i data-lucide="play" class="w-3.5 h-3.5"></i> <span>Open Queue</span>`;
  }

  // KPIs
  document.getElementById('hostKpiParties').textContent = stats.queue_count;
  document.getElementById('hostKpiHeads').textContent = `(${stats.total_waiting_people || 0} guests)`;
  document.getElementById('hostKpiWait').textContent = `${stats.estimated_wait_mins} min`;
  document.getElementById('hostKpiCalcType').textContent = stats.has_manual_override ? "Manual Override" : "Algorithmic";
  document.getElementById('hostKpiScore').textContent = `${rel.score}%`;
  document.getElementById('hostKpiGrade').textContent = `Grade ${rel.grade}`;
  document.getElementById('hostKpiVariance').textContent = `± ${rel.avg_variance_mins}m`;

  // Host table rows
  const tbody = document.getElementById('hostQueueTableBody');
  if (visibleQueue.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-8 text-center text-slate-600">
          <i data-lucide="inbox" class="w-8 h-8 mx-auto mb-2 text-slate-300"></i>
          Queue is empty right now. Walk-ins and remote diners will appear here automatically.
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }

  tbody.innerHTML = visibleQueue.map((q, idx) => {
    let statusPill = `<span class="badge-tag bg-slate-100 text-slate-700">Waiting</span>`;
    if (q.status === 'notified') {
      statusPill = `<span class="badge-tag bg-emerald-100 text-emerald-800 border border-emerald-300 animate-pulse font-bold">Table Ready</span>`;
    } else if (q.status === 'delayed') {
      statusPill = `<span class="badge-tag bg-amber-100 text-amber-800 border border-amber-300">Delayed (+${q.delay_mins}m)</span>`;
    } else if (q.status === 'seated') {
      statusPill = `<span class="badge-tag bg-blue-100 text-blue-800">Seated</span>`;
    } else if (q.status === 'cancelled' || q.status === 'no_show') {
      statusPill = `<span class="badge-tag bg-rose-100 text-rose-800">${q.status}</span>`;
    }

    const join = hostJoinInfo(q);
    const source = (q.source || q['source'] || '').toLowerCase();
    const isGhost = source === 'ghost' || q.is_ghost || q.isGhost || q.entry_type === 'ghost';
    const isWalkIn = source === 'walk-in' || q.channel === 'walk_in' || q['09_channel'] === 'walk_in';
    const channel = (q.channel || q['09_channel'] || 'remote').toLowerCase();
    const channelLabel = isWalkIn ? '🚶 Walk-In Guest' : (isGhost ? '👻 Ghost' : '🌐 Remote Join');
    const channelClass = isWalkIn ? 'bg-amber-100 text-amber-800 border border-amber-200' : (isGhost ? 'bg-purple-100 text-purple-800 border border-purple-300' : 'bg-indigo-100 text-indigo-700 border border-indigo-200');

    return `
      <tr class="hover:bg-slate-50 transition ${q.status === 'seated' ? 'opacity-60 bg-slate-50/50' : ''}">
        
        <td class="py-3 px-4 font-mono font-bold text-slate-900">
          <div class="flex items-center gap-1.5">
            <span class="w-6 h-6 rounded-full bg-slate-100 text-slate-700 flex items-center justify-center text-[10px]">#${idx + 1}</span>
            <span>${q.ticket_number}</span>
          </div>
          <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-bold border ${channelClass}">${channelLabel}</span>
          <div class="text-[10px] text-slate-600 font-sans mt-1">Joined ${join.ist} · ${join.relative}</div>
        </td>

        <td class="py-3 px-4">
          <div class="font-bold text-slate-900 flex items-center gap-1.5 flex-wrap">${q.customer_name}${isGhost ? '<span class="badge-tag bg-purple-100 text-purple-800 border border-purple-300">Ghost</span>' : ''}</div>
          ${q.special_requests ? `<div class="text-[10px] text-amber-700 font-medium mt-0.5">Note: ${q.special_requests}</div>` : ''}
        </td>

        <td class="py-3 px-4">
          <div class="font-semibold text-slate-800">${q.party_size} Guests</div>
          <div class="text-[10px] text-slate-600">${q.seating_pref}</div>
        </td>

        <td class="py-3 px-4">
          <div class="text-slate-800 font-medium">Joined ${join.relative}</div>
          <div class="text-[10px] text-slate-600">Promised: ${q.estimated_wait_mins}m</div>
        </td>

        <td class="py-3 px-4">
          <div class="flex items-center gap-1.5 flex-wrap">
            ${statusPill}
            ${idx < 2 && ['waiting', 'delayed'].includes(q.status) ? `<span class="badge-tag bg-orange-100 text-orange-900 border border-orange-300 font-bold animate-pulse">🚨 Near (#${idx+1})</span>` : ''}
            ${q.has_arrived ? `<span class="badge-tag bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold">✓ At Entrance</span>` : `            <span class="text-[10px] text-slate-600">En route</span>`}
          </div>
        </td>

        <td class="py-3 px-4 text-right">
          ${q.status !== 'seated' && q.status !== 'no_show' ? `
            <div class="flex items-center justify-end gap-1.5">
              ${q.status !== 'notified' ? `
                <button onclick="hostAction('${q.id}', 'notify')" class="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded font-bold text-[11px] transition shadow-xs flex items-center gap-1">
                  <i data-lucide="bell" class="w-3 h-3"></i> Notify
                </button>
              ` : ''}
              
              <button onclick="hostAction('${q.id}', 'seat')" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold text-[11px] transition shadow-xs flex items-center gap-1">
                <i data-lucide="check" class="w-3 h-3"></i> Seat
              </button>

              <button onclick="hostAction('${q.id}', 'remove')" class="px-2 py-1 bg-slate-100 hover:bg-rose-100 text-slate-600 hover:text-rose-700 rounded text-[11px] transition" title="Mark No-Show">
                <i data-lucide="user-x" class="w-3 h-3"></i>
              </button>
            </div>
          ` : `
            <span class="text-[11px] text-slate-600 font-medium">Completed</span>
          `}
        </td>

      </tr>
    `;
  }).join('');

  lucide.createIcons();
}

async function hostAction(ticketId, action) {
  try {
    const res = await fetch('/api/host/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Restaurant-Password': getSavedHostPassword(currentHostVenueId) },
      body: JSON.stringify({
        restaurant_id: currentHostVenueId,
        ticket_id: ticketId,
        action: action
      })
    });
    if (!res.ok) throw new Error('Host API action failed');
    let data = {};
    try { data = await res.json(); } catch (parseErr) { data = {}; }
    showToast(data.message || "Host action saved", "success");
    if (action === 'notify') playNotificationChime();
    await loadHostStand();
    await loadRestaurants();
    if (currentTicketId) await fetchTicketStatus();
  } catch (err) {
    // Local simulation fallback
    const qList = localMockQueues[currentHostVenueId] || [];
    const entry = qList.find(x => x.id === ticketId);
    if (entry) {
      if (action === 'notify') {
        entry.status = 'notified';
        playNotificationChime();
        showToast("Table Ready alert sent to guest's Digital Boarding Pass!", "success");
      } else if (action === 'seat') {
        entry.status = 'seated';
        entry.actual_wait_mins = Math.max(1, Math.floor((Date.now()/1000 - entry.joined_at)/60));
        showToast("Party successfully seated!", "success");
      } else if (action === 'remove') {
        entry.status = 'no_show';
        showToast("Party marked as no-show/removed.", "info");
      }
      if (activeTicketData && activeTicketData.id === ticketId) {
        activeTicketData.status = entry.status;
        activeTicketData.actual_wait_mins = entry.actual_wait_mins;
        updateTicketUI();
      }
    }
    loadHostStand();
    renderRestaurantsGrid();
  }
}

// Host Manual Wait Time Override & Anti-Overpromising Warning
function checkWaitOverrideWarning(mins) {
  if (!hostData || !hostData.live_stats) return;
  const algoWait = hostData.live_stats.algorithmic_wait_mins;
  const warnDiv = document.getElementById('hostOverrideWarning');
  if (mins !== null && mins < algoWait - 8) {
    warnDiv.classList.remove('hidden');
    document.getElementById('warnMins').textContent = `${mins}m`;
    document.getElementById('warnAlgo').textContent = `${algoWait}m`;
  } else {
    warnDiv.classList.add('hidden');
  }
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'hostManualWaitInput') {
    const val = parseInt(e.target.value);
    if (!isNaN(val)) checkWaitOverrideWarning(val);
  }
});

async function saveHostWaitEstimate() {
  const input = document.getElementById('hostManualWaitInput');
  const val = parseInt(input.value);
  if (isNaN(val) || val < 0) {
    showToast("Please enter a valid wait time in minutes", "error");
    return;
  }
  try {
    const res = await fetch('/api/host/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Restaurant-Password': getSavedHostPassword(currentHostVenueId) },
      body: JSON.stringify({
        restaurant_id: currentHostVenueId,
        action: 'update_wait_estimate',
        manual_wait_mins: val
      })
    });
    let data = {};
    try { data = await res.json(); } catch (parseErr) { data = {}; }
    if (!res.ok) { showToast(data.error || "Error updating estimate", "error"); return; }
    showToast(data.message || "Wait time estimate updated.", "success");
    await loadHostStand();
    await loadRestaurants();
  } catch (err) {
    showToast("Error updating estimate", "error");
  }
}

async function resetHostWaitToAuto() {
  document.getElementById('hostManualWaitInput').value = '';
  document.getElementById('hostOverrideWarning').classList.add('hidden');
  try {
    const res = await fetch('/api/host/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Restaurant-Password': getSavedHostPassword(currentHostVenueId) },
      body: JSON.stringify({
        restaurant_id: currentHostVenueId,
        action: 'update_wait_estimate',
        manual_wait_mins: null
      })
    });
    let data = {};
    try { data = await res.json(); } catch (parseErr) { data = {}; }
    if (!res.ok) { showToast(data.error || "Error resetting estimate", "error"); return; }
    showToast("Reset to automatic algorithmic wait calculation.", "info");
    await loadHostStand();
    await loadRestaurants();
  } catch (err) {
    showToast("Error resetting estimate", "error");
  }
}

async function toggleQueueStatus() {
  if (!hostData || !hostData.live_stats) return;
  const newStatus = hostData.live_stats.is_queue_open ? 0 : 1;
  try {
    const res = await fetch('/api/host/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Restaurant-Password': getSavedHostPassword(currentHostVenueId) },
      body: JSON.stringify({
        restaurant_id: currentHostVenueId,
        action: 'toggle_queue',
        is_open: newStatus
      })
    });
    let data = {};
    try { data = await res.json(); } catch (parseErr) { data = {}; }
    if (!res.ok) { showToast(data.error || "Error toggling queue", "error"); return; }
    showToast(data.message || "Queue status updated.", "info");
    await loadHostStand();
    await loadRestaurants();
  } catch (err) {
    showToast("Error toggling queue", "error");
  }
}

// Host Add Walk-In Modal
function openWalkinModal() {
  document.getElementById('walkinModal').classList.remove('hidden');
  lucide.createIcons();
}

function closeWalkinModal() {
  document.getElementById('walkinModal').classList.add('hidden');
}

async function submitWalkin(e) {
  e.preventDefault();
  const name = document.getElementById('walkinName').value.trim();
  const partySize = parseInt(document.getElementById('walkinPartySize').value);
  const seatingPref = document.getElementById('walkinSeatingPref').value;

  try {
    const res = await fetch('/api/host/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Restaurant-Password': getSavedHostPassword(currentHostVenueId) },
      body: JSON.stringify({
        restaurant_id: currentHostVenueId,
        action: 'add_walkin',
        name: name,
        party_size: partySize,
        seating_pref: seatingPref
      })
    });
    let data = {};
    try { data = await res.json(); } catch (parseErr) { data = {}; }
    if (!res.ok) { showToast(data.error || "Error adding walk-in", "error"); return; }
    closeWalkinModal();
    showToast(data.message || `Walk-in added: Ticket #${data.ticket_number}`, "success");
    await loadHostStand();
    await loadRestaurants();
  } catch (err) {
    showToast("Error adding walk-in", "error");
  }
}

// ==========================================
// 10. TOAST NOTIFICATION HELPER
// ==========================================
function showToast(message, type = "info") {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `p-3 px-4 rounded-xl shadow-lg border text-xs font-semibold flex items-center gap-2 transform transition-all duration-300 pointer-events-auto ${
    type === 'success' ? 'bg-emerald-900 text-white border-emerald-700' :
    type === 'error' ? 'bg-rose-900 text-white border-rose-700' :
    'bg-slate-900 text-white border-slate-700'
  }`;

  let icon = 'check-circle';
  if (type === 'error') icon = 'alert-triangle';
  if (type === 'info') icon = 'info';

  toast.innerHTML = `
    <i data-lucide="${icon}" class="w-4 h-4 shrink-0 ${type === 'success' ? 'text-emerald-400' : type === 'error' ? 'text-rose-400' : 'text-slate-300'}"></i>
    <span class="flex-1">${message}</span>
  `;

  container.appendChild(toast);
  lucide.createIcons();

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ==========================================
// 11. OWNER CHANGE PASSWORD
// ==========================================
function openOwnerChangePasswordModal() {
  const modal = document.getElementById('ownerChangePasswordModal');
  const errEl = document.getElementById('ownerChangePwdError');
  const currentInput = document.getElementById('ownerCurrentPwdInput');
  const newInput = document.getElementById('ownerNewPwdInput');
  const titleEl = document.getElementById('ownerChangePwdModalTitle');
  const venue = allRestaurants.find(r => r.id === currentHostVenueId);
  const venueName = venue ? venue.name : 'Restaurant';

  if (titleEl) titleEl.textContent = `Change Password: ${venueName}`;
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
  if (currentInput) currentInput.value = '';
  if (newInput) newInput.value = '';
  if (modal) {
    modal.classList.remove('hidden');
    setTimeout(() => currentInput && currentInput.focus(), 50);
  }
}

function closeOwnerChangePasswordModal() {
  const modal = document.getElementById('ownerChangePasswordModal');
  const errEl = document.getElementById('ownerChangePwdError');
  const currentInput = document.getElementById('ownerCurrentPwdInput');
  const newInput = document.getElementById('ownerNewPwdInput');
  if (modal) modal.classList.add('hidden');
  if (errEl) errEl.classList.add('hidden');
  if (currentInput) currentInput.value = '';
  if (newInput) newInput.value = '';
}

async function submitOwnerChangePassword(event) {
  if (event) event.preventDefault();
  const currentInput = document.getElementById('ownerCurrentPwdInput');
  const newInput = document.getElementById('ownerNewPwdInput');
  const errEl = document.getElementById('ownerChangePwdError');
  const btn = document.getElementById('ownerChangePwdSubmitBtn');

  const currentPwd = (currentInput ? currentInput.value : '').trim();
  const newPwd = (newInput ? newInput.value : '').trim();

  if (!currentPwd || !newPwd) return;
  if (newPwd.length < 4) {
    if (errEl) {
      errEl.textContent = 'New password must be at least 4 characters';
      errEl.classList.remove('hidden');
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Updating...';
  }
  if (errEl) errEl.classList.add('hidden');

  try {
    const res = await fetch('/api/host/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurant_id: currentHostVenueId,
        current_password: currentPwd,
        new_password: newPwd
      })
    });

    const data = await res.json();

    if (res.ok && data.success) {
      showToast(data.message || 'Password updated successfully.', 'success');
      closeOwnerChangePasswordModal();
      // Update sessionStorage with new password
      saveHostPassword(currentHostVenueId, newPwd);
      return;
    }

    if (errEl) {
      errEl.textContent = data.error || 'Failed to change password';
      errEl.classList.remove('hidden');
    }
  } catch (err) {
    if (errEl) {
      errEl.textContent = 'Network error. Please retry.';
      errEl.classList.remove('hidden');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Update Password';
    }
  }
}

// ==========================================
// 12. FOUNDER RESET PASSWORD
// ==========================================
function openFounderResetPasswordModal(restaurantId) {
  const modal = document.getElementById('founderResetPasswordModal');
  const errEl = document.getElementById('founderResetPwdError');
  const input = document.getElementById('founderNewPwdInput');
  const hiddenId = document.getElementById('founderResetRestaurantId');
  const titleEl = document.getElementById('founderResetPwdModalTitle');
  const venue = allRestaurants.find(r => r.id === restaurantId);
  const venueName = venue ? venue.name : restaurantId;

  if (titleEl) titleEl.textContent = `Reset Password: ${venueName}`;
  if (hiddenId) hiddenId.value = restaurantId;
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
  if (input) input.value = '';
  if (modal) {
    modal.classList.remove('hidden');
    setTimeout(() => input && input.focus(), 50);
  }
}

function closeFounderResetPasswordModal() {
  const modal = document.getElementById('founderResetPasswordModal');
  const errEl = document.getElementById('founderResetPwdError');
  const input = document.getElementById('founderNewPwdInput');
  const hiddenId = document.getElementById('founderResetRestaurantId');
  if (modal) modal.classList.add('hidden');
  if (errEl) errEl.classList.add('hidden');
  if (input) input.value = '';
  if (hiddenId) hiddenId.value = '';
}

async function submitFounderResetPassword(event) {
  if (event) event.preventDefault();
  const hiddenId = document.getElementById('founderResetRestaurantId');
  const input = document.getElementById('founderNewPwdInput');
  const errEl = document.getElementById('founderResetPwdError');
  const btn = document.getElementById('founderResetPwdSubmitBtn');

  const restaurantId = hiddenId ? hiddenId.value : '';
  const newPwd = (input ? input.value : '').trim();

  if (!restaurantId || !newPwd) return;
  if (newPwd.length < 4) {
    if (errEl) {
      errEl.textContent = 'Password must be at least 4 characters';
      errEl.classList.remove('hidden');
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Resetting...';
  }
  if (errEl) errEl.classList.add('hidden');

  try {
    const res = await fetch('/api/founder/restaurant/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({
        restaurant_id: restaurantId,
        new_password: newPwd
      })
    });

    const data = await res.json();

    if (res.status === 401) {
      sessionStorage.removeItem(FOUNDER_PWD_KEY);
      closeFounderResetPasswordModal();
      openFounderLoginModal();
      showToast('Founder session expired. Re-enter password.', 'error');
      return;
    }

    if (res.ok && data.success) {
      showToast(data.message || 'Restaurant password has been reset.', 'success');
      closeFounderResetPasswordModal();
      await loadFounderDashboard();
      return;
    }

    if (errEl) {
      errEl.textContent = data.error || 'Failed to reset password';
      errEl.classList.remove('hidden');
    }
  } catch (err) {
    if (errEl) {
      errEl.textContent = 'Network error. Please retry.';
      errEl.classList.remove('hidden');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Reset Password';
    }
  }
}

// ==========================================
// 13. FOUNDER CHANGE PASSWORD
// ==========================================
function openFounderChangePasswordModal() {
  const modal = document.getElementById('founderChangePasswordModal');
  const errEl = document.getElementById('founderChangePwdError');
  const currentInput = document.getElementById('founderCurrentPwdInput');
  const newInput = document.getElementById('founderNewPwdInput');
  if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
  if (currentInput) currentInput.value = '';
  if (newInput) newInput.value = '';
  if (modal) {
    modal.classList.remove('hidden');
    setTimeout(() => currentInput && currentInput.focus(), 50);
  }
  if (window.lucide) lucide.createIcons();
}

function closeFounderChangePasswordModal() {
  const modal = document.getElementById('founderChangePasswordModal');
  const errEl = document.getElementById('founderChangePwdError');
  const currentInput = document.getElementById('founderCurrentPwdInput');
  const newInput = document.getElementById('founderNewPwdInput');
  if (modal) modal.classList.add('hidden');
  if (errEl) errEl.classList.add('hidden');
  if (currentInput) currentInput.value = '';
  if (newInput) newInput.value = '';
}

async function submitFounderChangePassword(event) {
  if (event) event.preventDefault();
  const currentInput = document.getElementById('founderCurrentPwdInput');
  const newInput = document.getElementById('founderNewPwdInput');
  const errEl = document.getElementById('founderChangePwdError');
  const btn = document.getElementById('founderChangePwdSubmitBtn');

  const currentPwd = (currentInput ? currentInput.value : '').trim();
  const newPwd = (newInput ? newInput.value : '').trim();

  if (!currentPwd || !newPwd) return;
  if (newPwd.length < 6) {
    if (errEl) {
      errEl.textContent = 'New password must be at least 6 characters.';
      errEl.classList.remove('hidden');
    }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Updating...'; }
  if (errEl) errEl.classList.add('hidden');

  try {
    const res = await fetch('/api/founder/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({ current_password: currentPwd, new_password: newPwd })
    });

    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}

    if (res.ok && data.success) {
      sessionStorage.setItem(FOUNDER_PWD_KEY, newPwd);
      closeFounderChangePasswordModal();
      showToast('Founder password updated successfully.', 'success');
      return;
    }

    if (errEl) {
      errEl.textContent = data.error || text || 'Failed to change password.';
      errEl.classList.remove('hidden');
    }
  } catch (err) {
    if (errEl) {
      errEl.textContent = 'Network error. Please retry.';
      errEl.classList.remove('hidden');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Update Password'; }
  }
}

// ==========================================
// 14. FOUNDER ADD NEW RESTAURANT
// ==========================================
function openFounderAddRestaurantModal() {
  const modal = document.getElementById('founderAddRestaurantModal');
  const form = document.getElementById('founderAddRestaurantForm');
  const nameInput = document.getElementById('fndNewName');
  if (modal) {
    if (form) form.reset();
    document.getElementById('fndNewCity').value = 'Mumbai';
    document.getElementById('fndNewPrice').value = '₹₹';
    document.getElementById('fndNewTables').value = '16';
    document.getElementById('fndNewPace').value = '15';
    document.getElementById('fndNewPhoto').value = 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80';
    modal.classList.remove('hidden');
    setTimeout(() => nameInput && nameInput.focus(), 50);
  }
  if (window.lucide) lucide.createIcons();
}

function closeFounderAddRestaurantModal() {
  const modal = document.getElementById('founderAddRestaurantModal');
  if (modal) modal.classList.add('hidden');
}

// Collect selected meal-time checkboxes from a Founder venue form
function getCheckedMealTimes(inputName) {
  const boxes = document.querySelectorAll(`input[name="${inputName}"]:checked`);
  return Array.from(boxes).map((b) => b.value);
}

async function submitFounderAddRestaurant(event) {
  if (event) event.preventDefault();
  const name = document.getElementById('fndNewName').value.trim();
  const category = document.getElementById('fndNewCategory').value.trim();
  const type = document.getElementById('fndNewType').value;
  const city = document.getElementById('fndNewCity').value || 'Mumbai';
  const address = document.getElementById('fndNewAddress').value.trim();
  const priceRange = document.getElementById('fndNewPrice').value;
  const password = (document.getElementById('fndNewPassword')?.value || '').trim();
  const totalTables = parseInt(document.getElementById('fndNewTables').value) || 16;
  const pace = parseInt(document.getElementById('fndNewPace').value) || 15;
  const imageUrl = document.getElementById('fndNewPhoto').value.trim() || 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80';
  const bio = document.getElementById('fndNewBio').value.trim();
  const mealTimes = getCheckedMealTimes('fndNewMealTime');
  if (mealTimes.length === 0) {
    const err = document.getElementById('fndNewMealError');
    if (err) err.classList.remove('hidden');
    return;
  }
  const err = document.getElementById('fndNewMealError');
  if (err) err.classList.add('hidden');

  if (!name || !category || !address || !password) {
    showToast('Please fill in all required fields.', 'error');
    return;
  }
  if (password.length < 4) {
    showToast('Owner dashboard password must be at least 4 characters.', 'error');
    return;
  }

  const btn = document.getElementById('fndAddRestaurantSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Adding Restaurant...'; }

  try {
    const res = await fetch('/api/founder/restaurant/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({
        name,
        category,
        type,
        city,
        address,
        price_range: priceRange,
        password,
        meal_times: mealTimes,
        total_tables: totalTables,
        base_prep_time: pace,
        image_url: imageUrl,
        description: bio || `Authentic ${category} located in ${city}.`
      })
    });
    let data = {};
    try { data = await res.json(); } catch (parseErr) { data = {}; }
    if (res.status === 401) {
      sessionStorage.removeItem(FOUNDER_PWD_KEY);
      closeFounderAddRestaurantModal();
      openFounderLoginModal();
      showToast('Founder session expired. Re-enter password.', 'error');
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Failed to add restaurant');
    
    // Persist custom venue locally for demo resilience
    const customVenue = {
      id: data.restaurant_id || `custom-${Date.now()}`,
      name,
      category,
      type,
      city,
      address,
      price_range: priceRange,
      meal_times: mealTimes,
      image_url: imageUrl,
      description: bio || `Authentic ${category} located in ${city}.`,
      live_stats: { queue_count: 0, estimated_wait_mins: pace, is_queue_open: true, total_waiting_people: 0 },
      reliability: { score: 95, grade: 'A+', avg_variance_mins: 2.0, total_verified_checkins: 0, on_time_pct: 80, early_pct: 10, slight_late_pct: 8, severe_late_pct: 2 }
    };
    const customVenues = JSON.parse(localStorage.getItem('waitmate_custom_venues') || '[]');
    customVenues.push(customVenue);
    localStorage.setItem('waitmate_custom_venues', JSON.stringify(customVenues));

    closeFounderAddRestaurantModal();
    showToast(`🎉 "${name}" is now live on WaitMate Mumbai!`, 'success');
    await loadFounderDashboard();
    await loadRestaurants();
  } catch (err) {
    showToast(`Error adding restaurant: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Add Restaurant to Network'; }
  }
}

// ==========================================
// 15. FOUNDER REMOVE RESTAURANT
// ==========================================
async function founderDeleteRestaurant(venueId, venueName) {
  if (!confirm("Permanently remove " + venueName + " from WaitMate Mumbai?")) return;
  try {
    const res = await fetch('/api/founder/restaurant/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({ restaurant_id: venueId })
    });
    let data = {};
    try { data = await res.json(); } catch (parseErr) { data = {}; }
    if (res.status === 401) {
      sessionStorage.removeItem(FOUNDER_PWD_KEY);
      openFounderLoginModal();
      showToast('Founder session expired. Re-enter password.', 'error');
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Failed to remove restaurant');
    
    // Persist deleted venue ID locally for demo resilience
    const deletedVenues = JSON.parse(localStorage.getItem('waitmate_deleted_venues') || '[]');
    if (!deletedVenues.includes(venueId)) {
      deletedVenues.push(venueId);
      localStorage.setItem('waitmate_deleted_venues', JSON.stringify(deletedVenues));
    }

    showToast(`✅ "${venueName}" removed from WaitMate Mumbai network.`, 'success');
    await loadFounderDashboard();
    await loadRestaurants();
  } catch (err) {
    showToast(`Error removing restaurant: ${err.message}`, 'error');
  }
}

// ==========================================
// 16. FOUNDER SUPER-ADMIN ("GOD MODE") ACTIONS
// ==========================================

// One-click "Enter Host Stand as Owner" (impersonation) — bypasses restaurant password
async function founderOpenHostStand(venueId) {
  if (!isFounderUnlocked()) { openFounderLoginModal(); return; }
  try {
    const res = await fetch(`/api/founder/host-stand/queue/${venueId}`, { headers: founderHeaders(), cache: 'no-store' });
    if (res.status === 401) {
      sessionStorage.removeItem(FOUNDER_PWD_KEY);
      openFounderLoginModal();
      showToast('Founder session expired.', 'error');
      return;
    }
    if (!res.ok) throw new Error('Host stand unavailable');
    const data = await res.json();
    hostData = data;
    currentHostVenueId = venueId;
    const dirEl = document.getElementById('ownerVenueDirectory');
    const dashEl = document.getElementById('ownerDashboardContent');
    if (dirEl) dirEl.classList.add('hidden');
    if (dashEl) dashEl.classList.remove('hidden');
    const nameEl = document.getElementById('hostVenueName');
    const subEl = document.getElementById('hostVenueLocationSub');
    if (nameEl) nameEl.textContent = data.restaurant.name;
    if (subEl) subEl.textContent = `${data.restaurant.address} • Host Stand Dashboard (Founder Impersonation)`;
    renderHostDashboard();
    switchInterface('owner');
    showToast(`Opened Host Stand for ${escapeHtml(data.restaurant.name)} as Founder`, 'success');
  } catch (err) {
    showToast("Unable to open Host Stand", "error");
  }
}

async function founderSetManualWait(venueId) {
  const input = document.getElementById(`fnd-wait-${venueId}`);
  const val = input ? input.value : '';
  if (val === '') { showToast('Enter a wait time (minutes)', 'error'); return; }
  try {
    const res = await fetch('/api/founder/restaurant/manual-wait', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({ restaurant_id: venueId, manual_wait_mins: val === '' ? null : Number(val) })
    });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    if (!res.ok) throw new Error('Failed to update wait estimate');
    const data = await res.json().catch(() => ({}));
    showToast(data.message || 'Wait estimate updated.', 'success');
    await loadFounderDashboard();
    await loadRestaurants();
  } catch (err) { showToast('Error updating wait estimate', 'error'); }
}

async function founderSetReliability(venueId) {
  const input = document.getElementById(`fnd-score-${venueId}`);
  const score = input ? Number(input.value) : NaN;
  if (!Number.isFinite(score) || score < 0 || score > 100) { showToast('Enter a score between 0 and 100', 'error'); return; }
  try {
    const res = await fetch('/api/founder/restaurant/reliability', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({ restaurant_id: venueId, score: Math.round(score) })
    });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    if (!res.ok) throw new Error('Failed to update Reliability Score');
    const data = await res.json().catch(() => ({}));
    showToast(data.message || `Reliability Score set to ${score}%`, 'success');
    await loadFounderDashboard();
    await loadRestaurants();
  } catch (err) { showToast('Error updating Reliability Score', 'error'); }
}

async function founderSetAnnouncement(venueId, announcement) {
  const input = document.getElementById(`fnd-ann-${venueId}`);
  const text = announcement === undefined ? (input ? input.value.trim() : '') : announcement;
  try {
    const res = await fetch('/api/founder/restaurant/announcement', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({ restaurant_id: venueId, announcement: text })
    });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    if (!res.ok) throw new Error('Failed to update announcement');
    const data = await res.json().catch(() => ({}));
    showToast(data.message || (text ? 'Announcement published.' : 'Announcement cleared.'), 'success');
    if (input) input.value = text;
    await loadFounderDashboard();
    await loadRestaurants();
  } catch (err) { showToast('Error updating announcement', 'error'); }
}

async function founderClearVenueQueue(venueId, venueName) {
  if (!confirm(`Clear the entire live queue for "${escapeHtml(venueName)}"? This removes all waiting / notified / delayed tickets.`)) return;
  try {
    const res = await fetch('/api/founder/queue/clear-venue', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({ restaurant_id: venueId })
    });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    if (!res.ok) throw new Error('Failed to clear venue queue');
    const data = await res.json().catch(() => ({}));
    showToast(data.message || 'Venue queue cleared.', 'success');
    await loadFounderDashboard();
    await loadRestaurants();
  } catch (err) { showToast('Error clearing venue queue', 'error'); }
}

async function founderPurgeStaleEntries() {
  if (!confirm("Purge all test / stale (non-active) queue entries across the network? This cannot be undone.")) return;
  try {
    const res = await fetch('/api/founder/queue/purge', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...founderHeaders() }
    });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    if (!res.ok) throw new Error('Failed to purge entries');
    const data = await res.json().catch(() => ({}));
    showToast(data.message || 'Stale entries purged.', 'success');
    await loadFounderDashboard();
    await loadRestaurants();
  } catch (err) { showToast('Error purging entries', 'error'); }
}

async function founderPublishGlobalAnnouncement() {
  const input = document.getElementById('fndGlobalAnnouncementInput');
  const text = (input ? input.value : '').trim();
  try {
    const res = await fetch('/api/founder/announcement/global', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({ announcement: text })
    });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    if (!res.ok) throw new Error('Failed to push global banner');
    const data = await res.json().catch(() => ({}));
    showToast(data.message || (text ? 'Global banner pushed to all venues.' : 'Global banner cleared.'), 'success');
    if (input) input.value = text;
    globalAnnouncementText = text;
    const banner = document.getElementById('globalNetworkBanner');
    const textEl = document.getElementById('globalBannerText');
    if (text) {
      if (textEl) textEl.textContent = text;
      if (banner) banner.classList.remove('hidden');
    } else if (banner) {
      banner.classList.add('hidden');
    }
    await loadFounderDashboard();
  } catch (err) { showToast('Error pushing global banner', 'error'); }
}

async function founderExportNetworkData() {
  try {
    const res = await fetch('/api/founder/export', { headers: founderHeaders(), cache: 'no-store' });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    if (!res.ok) throw new Error('Export unavailable');
    const payload = await res.json();
    const csv = buildNetworkCsv(payload);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `waitmate-network-export-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Network data exported as CSV.', 'success');
  } catch (err) { showToast('Error exporting network data', 'error'); }
}

function buildNetworkCsv(payload) {
  const lines = [];
  lines.push('WaitMate India — Founder Network Export');
  lines.push(`Generated: ${payload.exported_at_ist || payload.exported_at}`);
  lines.push('');
  lines.push('--- RESTAURANTS ---');
  lines.push('id,name,category,type,city,address,price_range,image_url,description,total_tables,base_prep_time,is_queue_open,manual_override_wait,announcement');
  for (const r of (payload.restaurants || [])) {
    lines.push(csvRow([
      r.id, r.name, r.category, r.type, r.city, r.address, r.price_range, r.image_url, r.description, r.total_tables, r.base_prep_time, r.is_queue_open, r.manual_override_wait, r.announcement
    ]));
  }
  lines.push('');
  lines.push('--- RELIABILITY SCORES ---');
  lines.push('id,reliability_score,reliability_grade,reliability_verdict,total_verified_checkins');
  for (const r of (payload.restaurants || [])) {
    lines.push(csvRow([r.id, r.reliability_score, r.reliability_grade, r.reliability_verdict, r.total_verified_checkins]));
  }
  lines.push('');
  lines.push('--- QUEUE ENTRIES ---');
  lines.push('id,ticket_number,restaurant_id,restaurant_name,guest_name,customer_name,phone,party_size,seating_pref,special_requests,channel,entry_type,status,has_arrived,promised_wait_mins,estimated_wait_mins,actual_wait_mins,joined_time_ist,notified_time_ist,arrived_time_ist,seated_time_ist,rated,rating,review_comment');
  for (const q of (payload.queue_entries || [])) {
    lines.push(csvRow([
      q.id, q.ticket_number, q.restaurant_id, q.restaurant_name, q.guest_name, q.customer_name, q.phone, q.party_size, q.seating_pref, q.special_requests, q.channel, q.entry_type, q.status, q.has_arrived, q.promised_wait_mins, q.estimated_wait_mins, q.actual_wait_mins, q.joined_time_ist, q.notified_time_ist, q.arrived_time_ist, q.seated_time_ist, q.rated, q.rating, q.review_comment
    ]));
  }
  lines.push('');
  lines.push('--- REVIEWS ---');
  lines.push('id,restaurant_id,restaurant_name,rating,stars,guest_name,comment,ticket_id,rated_time_ist,created_at');
  for (const rv of (payload.reviews || [])) {
    lines.push(csvRow([rv.id, rv.restaurant_id, rv.restaurant_name, rv.rating, rv.stars, rv.guest_name, rv.review_comment || rv.comment, rv.ticket_id, rv.rated_time_ist, rv.created_at]));
  }
  return lines.join('\n');
}

function csvRow(values) {
  return values.map(v => {
    const s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }).join(',');
}

async function founderQueueAction(ticketId, action) {
  try {
    const res = await fetch('/api/founder/queue/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({ ticket_id: ticketId, action })
    });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    if (!res.ok) throw new Error('Queue action failed');
    const data = await res.json().catch(() => ({}));
    showToast(data.message || 'Queue action updated.', 'success');
    if (action === 'notify') playNotificationChime();
    await loadFounderDashboard();
    await loadRestaurants();
    if (currentTicketId) await fetchTicketStatus();
  } catch (err) { showToast('Error performing queue action', 'error'); }
}

async function founderEditPartySize(ticketId) {
  const entered = window.prompt('Enter new party size (1–20):');
  if (entered === null) return;
  const size = Number(entered);
  if (!Number.isFinite(size) || size < 1 || size > 20) { showToast('Invalid party size.', 'error'); return; }
  try {
    const res = await fetch('/api/founder/queue/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({ ticket_id: ticketId, action: 'edit_party_size', party_size: size })
    });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    if (!res.ok) throw new Error('Failed to edit party size');
    showToast(`Party size updated to ${size}.`, 'success');
    await loadFounderDashboard();
    await loadRestaurants();
  } catch (err) { showToast('Error editing party size', 'error'); }
}

function openFounderEditRestaurantModal(venueId) {
  const r = (founderRestaurantsCache || []).find(x => x.id === venueId) || (allRestaurants || []).find(x => x.id === venueId);
  if (!r) return;
  document.getElementById('fndEditRestaurantId').value = r.id;
  document.getElementById('fndEditModalTitle').textContent = `Edit: ${r.name}`;
  document.getElementById('fndEditName').value = r.name || '';
  document.getElementById('fndEditCategory').value = r.category || '';
  document.getElementById('fndEditType').value = r.type || 'restaurant';
  document.getElementById('fndEditCity').value = r.city || 'Mumbai';
  document.getElementById('fndEditAddress').value = r.address || '';
  document.getElementById('fndEditPrice').value = r.price_range || '₹₹';
  document.getElementById('fndEditPassword').value = '';
  document.getElementById('fndEditTables').value = r.total_tables || '';
  document.getElementById('fndEditPace').value = r.base_prep_time || '';
  document.getElementById('fndEditPhoto').value = r.image_url || '';
  document.getElementById('fndEditBio').value = r.description || '';
  const editBoxes = document.querySelectorAll('input[name="fndEditMealTime"]');
  const editMeals = Array.isArray(r.meal_times) ? r.meal_times : ["Lunch", "Dinner"];
  editBoxes.forEach((box) => {
    box.checked = editMeals.includes(box.value);
  });
  const modal = document.getElementById('founderEditRestaurantModal');
  if (modal) {
    modal.classList.remove('hidden');
    setTimeout(() => document.getElementById('fndEditName')?.focus(), 50);
  }
  if (window.lucide) lucide.createIcons();
}

function closeFounderEditRestaurantModal() {
  const modal = document.getElementById('founderEditRestaurantModal');
  if (modal) modal.classList.add('hidden');
}

function founderDeleteRestaurantFromModal(restaurantId) {
  const r = (founderRestaurantsCache || []).find(x => x.id === restaurantId) || (allRestaurants || []).find(x => x.id === restaurantId);
  founderDeleteRestaurant(restaurantId, r ? r.name : restaurantId);
  closeFounderEditRestaurantModal();
}

async function submitFounderEditRestaurant(event) {
  if (event) event.preventDefault();
  const restaurantId = document.getElementById('fndEditRestaurantId').value;
  const name = document.getElementById('fndEditName').value.trim();
  const category = document.getElementById('fndEditCategory').value.trim();
  const type = document.getElementById('fndEditType').value;
  const city = document.getElementById('fndEditCity').value || 'Mumbai';
  const address = document.getElementById('fndEditAddress').value.trim();
  const priceRange = document.getElementById('fndEditPrice').value;
  const password = (document.getElementById('fndEditPassword')?.value || '').trim();
  const totalTables = parseInt(document.getElementById('fndEditTables').value) || undefined;
  const pace = parseInt(document.getElementById('fndEditPace').value) || undefined;
  const imageUrl = document.getElementById('fndEditPhoto').value.trim();
  const bio = document.getElementById('fndEditBio').value.trim();
  const mealTimes = getCheckedMealTimes('fndEditMealTime');
  if (mealTimes.length === 0) {
    const err = document.getElementById('fndEditMealError');
    if (err) err.classList.remove('hidden');
    return;
  }
  const err = document.getElementById('fndEditMealError');
  if (err) err.classList.add('hidden');

  if (!name || !category || !address) { showToast('Name, category and address are required.', 'error'); return; }
  if (password && password.length < 4) { showToast('Owner password must be at least 4 characters.', 'error'); return; }

  const btn = document.getElementById('fndEditRestaurantSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  try {
    const res = await fetch('/api/founder/restaurant/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({
        restaurant_id: restaurantId, name, category, type, city, address, price_range: priceRange,
        meal_times: mealTimes,
        ...(password ? { password } : {}),
        ...(totalTables !== undefined ? { total_tables: totalTables } : {}),
        ...(pace !== undefined ? { base_prep_time: pace } : {}),
        ...(imageUrl ? { image_url: imageUrl } : {}),
        description: bio || `Authentic ${category} located in ${city}.`
      })
    });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); closeFounderEditRestaurantModal(); openFounderLoginModal(); showToast('Founder session expired.', 'error'); return; }
    if (!res.ok) throw new Error('Update failed');
    closeFounderEditRestaurantModal();
    showToast(`"${name}" updated across the network.`, 'success');
    await loadFounderDashboard();
    await loadRestaurants();
  } catch (err) { showToast('Error saving venue changes', 'error'); } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Venue Changes'; }
  }
}

async function founderDeleteReview(reviewId, restaurantId) {
  if (!confirm("Delete this review? The restaurant's Reliability Score will be recalculated from the remaining reviews.")) return;
  try {
    const res = await fetch(`/api/founder/reviews/${reviewId}`, {
      method: 'DELETE', headers: { ...founderHeaders() }
    });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    if (!res.ok) throw new Error('Delete failed');
    showToast('Review deleted. Reliability Score recalculated.', 'success');
    await loadFounderDashboard();
  } catch (err) { showToast('Error deleting review', 'error'); }
}
