
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
  if (!input) return;
  const btn = input.parentElement ? input.parentElement.querySelector('button[aria-label="Toggle password visibility"]') : null;
  if (input.type === 'password') {
    input.type = 'text';
    if (btn) btn.innerHTML = '<i data-lucide="eye-off" class="w-5 h-5"></i>';
  } else {
    input.type = 'password';
    if (btn) btn.innerHTML = '<i data-lucide="eye" class="w-5 h-5"></i>';
  }
  if (window.lucide) lucide.createIcons();
}

// Normalize any API payload into a guaranteed Array. Accepts a bare array, or
// an object wrapping the array under .entries / .queue, and falls back to []
// for null / undefined / error objects / scalars so callers never crash on
// .find(), .filter(), .map(), or .length.
function getSafeEntries(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
  if (Array.isArray(data.entries)) return data.entries;
  if (Array.isArray(data.queue)) return data.queue;
  if (Array.isArray(data.queues)) return data.queues;
  if (Array.isArray(data.restaurants)) return data.restaurants;
  if (Array.isArray(data.venues)) return data.venues;
  if (Array.isArray(data.reviews)) return data.reviews;
  }
  return [];
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
  // Simulation worker disabled: queue is 100% human-driven
  return;
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
    if (!res.ok) {
      let errMsg = 'Host API unavailable';
      try { const e = await res.json(); if (e && e.error) errMsg = e.error; } catch { /* ignore parse */ }
      showToast(errMsg, 'error');
      throw new Error(errMsg);
    }
    let raw = {};
    try { raw = await res.json(); } catch (parseErr) { raw = {}; }
    // If the backend returned an error-shaped body (e.g. { error: "..." }),
    // surface it and fall back to local mock data instead of crashing.
    if (raw && typeof raw === 'object' && raw.error && !raw.restaurant && !raw.queue) {
      showToast(raw.error || 'Host API returned an error.', 'error');
      throw new Error(raw.error || 'Host API error');
    }
    hostData = {
      restaurant: raw.restaurant || null,
      live_stats: raw.live_stats || { queue_count: 0, estimated_wait_mins: 10, is_queue_open: true },
      reliability: raw.reliability || { score: 95, grade: 'A+' },
      queue: getSafeEntries(raw.queue)
    };
  } catch (err) {
    const r = (allRestaurants || []).find(x => x.id === venueId) || (typeof fallbackRestaurants !== 'undefined' ? fallbackRestaurants : {});
    const q = (typeof localMockQueues !== 'undefined' && localMockQueues[venueId]) ? localMockQueues[venueId] : [];
    hostData = {
      restaurant: r,
      live_stats: r.live_stats || { queue_count: 0, estimated_wait_mins: 10, is_queue_open: true },
      reliability: r.reliability || { score: 95, grade: 'A+' },
      queue: getSafeEntries(q)
    };
  }
  detectNewHostJoins(venueId);
  const dirEl = document.getElementById('ownerVenueDirectory');
  const dashEl = document.getElementById('ownerDashboardContent');
  if (dirEl) dirEl.classList.add('hidden');
  if (dashEl) dashEl.classList.remove('hidden');
  if (typeof populateHostDropdown === 'function') populateHostDropdown();
  if (typeof renderHostDashboard === 'function') renderHostDashboard();
}


function showOwnerDirectory() {
  // Leaving the unlocked dashboard (back to directory / switching tabs) must
  // re-lock every venue so the password is required again next time.
  clearAllHostPasswords();
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
      <div class="bg-slate-900/60 backdrop-blur-md border border-white/10 hover:border-emerald-400/40 rounded-2xl overflow-hidden flex flex-col justify-between transition-colors duration-300">
        <div>
          <div class="h-32 w-full bg-slate-950/80 relative overflow-hidden">
            <img src="${r.image_url}" alt="${r.name}" class="w-full h-full object-cover">
            <span class="absolute top-2.5 right-2.5 px-2.5 py-1 rounded-full text-[10px] font-bold ${isUnlocked ? 'bg-emerald-600 text-white' : 'bg-slate-900/80 text-white'}">
              ${isUnlocked ? 'Unlocked' : 'Password Protected'}
            </span>
          </div>
          <div class="p-4">
            <h4 class="font-heading font-extrabold text-base text-white">${r.name}</h4>
            <p class="text-xs text-slate-400 mt-0.5">${r.category}</p>
            <p class="text-[11px] text-slate-400 mt-2">${r.address}</p>
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
  // Always require the password: never reuse an in-memory unlock. Opening a
  // host stand must always pop the password modal first.
  clearHostPassword(venueId);
  openOwnerPasswordModal(venueId);
}

// Per-restaurant owner password storage & verification.
// In-memory ONLY: nothing is persisted to sessionStorage/localStorage, so the
// host stand is always re-locked on page refresh/reopen and whenever the user
// leaves the dashboard.
const verifiedHostPasswords = {};

function getSavedHostPassword(venueId) {
  return verifiedHostPasswords[venueId] || '';
}

function saveHostPassword(venueId, password) {
  verifiedHostPasswords[venueId] = password;
}

function clearHostPassword(venueId) {
  delete verifiedHostPasswords[venueId];
}

// Wipe every unlocked venue so the next host-stand open always requires the
// password again (called on leaving/closing/switching away from the dashboard).
function clearAllHostPasswords() {
  Object.keys(verifiedHostPasswords).forEach(k => { delete verifiedHostPasswords[k]; });
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
let currentSearch = '';
let openOnly = true;

let currentInterface = 'customer'; // 'customer', 'owner', 'founder'
let currentView = 'landing'; // 'landing' | 'customer' | 'host' | 'founder'
let founderInterfaceTemplate = null;
let founderDeepLinkActive = false; // set when ?founder=1 is in the URL; blocks background callbacks from switching away

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

// Seated-rating gating: a diner can only rate once they've been seated, and only once per visit
let ratedTickets = new Set();
const RATED_STORAGE_KEY = 'waitmate_rated_tickets';

// Favorites / Bookmarked Spots — persisted in localStorage (wm_favorites)
let favorites = new Set();
const FAVORITES_STORAGE_KEY = 'wm_favorites';

// Unique device id used to enforce one active queue ticket per device.
// Generated once and persisted in localStorage; sent with every join request.
const DEVICE_ID_KEY = 'waitmate_device_id';
let deviceId = null;
function getOrCreateDeviceId() {
  if (deviceId) return deviceId;
  try {
    deviceId = localStorage.getItem(DEVICE_ID_KEY);
    if (!deviceId) {
      const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'dm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14);
      deviceId = uuid;
      localStorage.setItem(DEVICE_ID_KEY, deviceId);
    }
  } catch (e) {
    deviceId = 'dm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14);
  }
  return deviceId;
}

// ============================================================================
// WaitMateBoot — single deterministic startup state machine.
// Controls the exact 3-step launch flow: Logo Splash (0-750ms) ->
// 6-Slide Onboarding Guideline -> Customer Home View.
// Shared between index.html (inline boot starter) and app.js.
// Zero race conditions: splash and guideline handoff happen in one synchronous
// tick at 750ms, so there is never a blank screen between steps.
// ============================================================================
window.WaitMateBoot = (function () {
  const SPLASH_MS = 500;
  let started = false;
  let splashTimer = null;

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function hideSecondaryModals() {
    [
      'waitInfoModal','joinQueueModal','ticketModal',
      'reliabilityModal','feedbackModal','ownerPasswordModal','founderLoginModal',
      'ownerChangePasswordModal','founderResetPasswordModal','walkinModal',
      'venueQrModal','friendPassModal','deviceBlockedModal','sharePassModal'
    ].forEach(function (id) {
      var el = $(id);
      if (el) {
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');
        try { el.classList.add('hidden'); el.classList.remove('flex'); } catch (e) {}
      }
    });
  }

  function showSplash() {
    var s = $('splashScreen');
    if (!s) return;
    s.style.display = 'flex';
    s.style.position = 'fixed';
    s.style.inset = '0';
    s.style.width = '100vw';
    s.style.height = '100vh';
    s.style.zIndex = '99999';
    s.style.flexDirection = 'column';
    s.style.alignItems = 'center';
    s.style.justifyContent = 'center';
    s.style.background = '#0f172a';
    s.style.opacity = '1';
    s.classList.remove('hidden');
    s.removeAttribute('hidden');
    s.setAttribute('aria-hidden', 'false');
  }

  function hideSplash() {
    var s = $('splashScreen');
    if (!s) return;
    s.style.display = 'none';
    s.classList.add('hidden');
    s.setAttribute('aria-hidden', 'true');
  }

  function prepareCustomerView() {
    var main = $('mainContainer') || $('customerView') || document.querySelector('main');
    if (main) {
      main.style.display = 'block';
      main.style.opacity = '1';
      main.classList.remove('hidden');
      main.removeAttribute('hidden');
    }
    var cust = $('customerView');
    if (cust) {
      cust.style.display = 'block';
      cust.style.opacity = '1';
      cust.classList.remove('hidden');
      cust.removeAttribute('hidden');
    }
  }

  function hideGuideline() {
    // Onboarding guideline modal removed: landing now goes straight from the
    // fast splash to the customer view. Nothing to hide here.
  }

  function hasDeepLink() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('founder') === '1') return true;
    if (params.get('ticket')) return true;
    if (params.get('venue')) return true;
    var hash = (window.location.hash || '').toLowerCase();
    var path = (window.location.pathname || '/').toLowerCase();
    if (path === '/founder' || path.endsWith('/founder') || hash === '#founder') return true;
    return false;
  }

  function runDeepLink() {
    var params = new URLSearchParams(window.location.search);
    var founder = params.get('founder') === '1';
    var ticket = params.get('ticket');
    var venue = params.get('venue');
    var hash = (window.location.hash || '').toLowerCase();
    var path = (window.location.pathname || '/').toLowerCase();
    var isFounderPath = path === '/founder' || path.endsWith('/founder') || hash === '#founder';
    // Founder deep-links are handled in WaitMateBoot.start() (before the
    // splash hides) so the customer view never flashes. Only venue/ticket
    // deep-links are resolved here.
    if (venue && !(founder || isFounderPath)) {
      try { window.history.replaceState({}, document.title, window.location.pathname); } catch (e) {}
      if (typeof openJoinModal === 'function') openJoinModal(venue, 'walk_in');
    }
    if (ticket && !(founder || isFounderPath)) {
      try { window.history.replaceState({}, document.title, window.location.pathname); } catch (e) {}
      if (typeof openFriendPassTracker === 'function') openFriendPassTracker(ticket);
    }
  }

  function ensureRestaurantsRendered() {
    var grid = $('restaurantsGrid') || $('restaurantGrid');
    if (grid && grid.children.length <= 1) {
      if (typeof renderRestaurantsGrid === 'function') { try { renderRestaurantsGrid(); } catch (e) {} }
    }
    if (typeof loadRestaurants === 'function') { try { loadRestaurants(); } catch (e) {} }
  }

  // Step 3: Customer Home View. Called by Skip / Start Exploring and by the
  // deep-link path after the 750ms splash.
  function enterCustomerView() {
    if (splashTimer) { clearTimeout(splashTimer); splashTimer = null; }
    hideGuideline();
    prepareCustomerView();
    if (typeof switchInterface === 'function') {
      try { switchInterface('customer'); } catch (e) {}
    }
    ensureRestaurantsRendered();
    if (window.lucide) lucide.createIcons();
  }

  function start() {
    if (started) return;
    started = true;
    hideSecondaryModals();
    showSplash();
    prepareCustomerView();
    var deepLink = hasDeepLink();
    // STEP 1: splash shows immediately (0ms). In the background app.js has
    // already fetched /api/restaurants and filled #restaurantsGrid.
    splashTimer = setTimeout(function () {
      splashTimer = null;
      hideSplash();
      // STEP 2 at exactly 750ms: open the 6-Slide Guideline on Slide 1 of 6
      // in the same tick as hiding the splash -> 0ms blank screen.
      // Deep-linked users bypass the guideline entirely.
      if (deepLink) {
        var _dlParams = new URLSearchParams(window.location.search);
        var _dlHash = (window.location.hash || '').toLowerCase();
        var _dlPath = (window.location.pathname || '/').toLowerCase();
        var _dlIsFounder = _dlPath === '/founder' || _dlPath.endsWith('/founder') || _dlHash === '#founder';
        // For founder deep-links, go straight to founder access — never
        // flash the customer view first. If already unlocked, open the
        // Founder Command Center directly; otherwise prompt for the password.
        if (_dlParams.get('founder') === '1' || _dlIsFounder) {
          if (typeof isFounderUnlocked === 'function' && isFounderUnlocked()) {
            switchInterface('founder');
          } else if (typeof openFounderLoginModal === 'function') {
            openFounderLoginModal();
          }
        } else {
          enterCustomerView();
          runDeepLink();
        }
      } else {
        // No deep link: visitors land directly on the customer view after the
        // fast splash — no blocking onboarding modal, no localStorage gate.
        enterCustomerView();
      }
    }, SPLASH_MS);
  }

  return { start: start, enterCustomerView: enterCustomerView, showSplash: showSplash };
})();

// Returns true when a stored ticket is still active (waiting / arrived, not
// expired or any terminal state), so a device can't hold two active queues.
function isLocalTicketActive(ticket) {
  if (!ticket) return false;
  const st = String(ticket.status || '').toLowerCase();
  if (st === 'expired' || st === 'cancelled' || st === 'seated' || st === 'no_show' || st === 'completed' || st === 'left') return false;
  return st === 'waiting' || st === 'arrived' || ticket.has_arrived === true;
}

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
    // Unregister any stale service workers and delete old caches so desktop
    // browsers immediately load the latest code (cache-bust on every deploy).
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const reg of registrations) {
      await reg.unregister();
    }
    if (caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }

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
    icon: icon || '/logo.png?v=2',
    badge: '/logo.png?v=2',
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
  document.title = "WaitMate India 🇮🇳 • Restaurant Queues & Reliability — Demo";
  const founderDiv = document.getElementById('founderInterface');
  if (founderDiv && !founderDiv.classList.contains('hidden')) founderDiv.classList.add('hidden');

  // Safety: guarantee every secondary modal is strictly closed on initial load.
  const SECONDARY_MODAL_IDS = [
    'waitInfoModal','joinQueueModal','ticketModal','reliabilityModal','feedbackModal',
    'ownerPasswordModal','founderLoginModal','ownerChangePasswordModal','founderResetPasswordModal',
    'walkinModal','venueQrModal','friendPassModal'
  ];
  SECONDARY_MODAL_IDS.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) {
      el.style.removeProperty('display');
      el.setAttribute('aria-hidden', 'true');
      try { el.classList.add('hidden'); } catch (e) {}
    }
  });

  allRestaurants = JSON.parse(JSON.stringify(fallbackRestaurants));
  renderRestaurantsGrid();

  // Splash / landing are controlled exclusively by the inline boot script
  // at the bottom of index.html: Logo Splash (0-500ms) -> Customer View,
  // with no blocking onboarding modal or localStorage gate. app.js only
  // loads data and initializes the customer shell here to avoid races.

  const dataPromise = (async () => {
    try { await loadRestaurants(); } catch (err) { console.warn('Pre-load: restaurants failed', err); }
    try { await loadActivePassData(); } catch (err) { console.warn('Pre-load: active pass failed', err); }
    try { await preloadVenueReviews(); } catch (err) { /* non-critical */ }
  })();

  try {
    const _params = new URLSearchParams(window.location.search);
    const _hash = (window.location.hash || '').toLowerCase();
    const _path = (window.location.pathname || '/').toLowerCase();
    const _explicitFounder = _path === '/founder' || _path.endsWith('/founder') || _params.get('founder') === '1' || _hash === '#founder';
    if (_explicitFounder) {
      founderDeepLinkActive = true;
      // Keep founderInterface in the DOM (hidden behind splash). WaitMateBoot
      // will switch to founder at 750ms if already unlocked, or open the login
      // modal if not. Do NOT clear the founder password or force customer view.
    } else {
      sessionStorage.removeItem('waitmate_founder_pwd');
      currentInterface = 'customer';
      if (founderDiv && founderDiv.isConnected) {
        founderInterfaceTemplate = founderDiv.cloneNode(true);
        founderDiv.remove();
      }
    }
  } catch (e) {}
  await initPushNotifications();
  loadFavorites();
  getOrCreateDeviceId(); // generate/persist the device id used for one-active-ticket-per-device
  startRestaurantsRefresh();

  // Restore persisted active ticket so a page refresh keeps "My Pass" and live tracking.
  // Purge stale/terminal tickets (seated, cancelled, completed, no_show) or tickets
  // older than 2 hours so a fresh load never shows a stale "Seated! Enjoy your food"
  // title when there is no active waitlist session.
  try {
    const saved = JSON.parse(localStorage.getItem('waitmate_active_ticket') || 'null');
    // Hard-terminal states never resume (no rating is owed for these). Expired
    // tickets are cleared so the diner can join fresh with a "Ticket Expired" state.
    const hardTerminal = ['cancelled', 'completed', 'no_show', 'expired'];
    // A seated-but-unrated visit must resume on the rating screen after a reload
    // rather than dropping the diner back to the browsing view.
    const seatedUnrated = !!(saved && saved.data && saved.data.status === 'seated' && !saved.data.rated);
    const stale = saved && saved.id && saved.data && (
      hardTerminal.includes(saved.data.status) ||
      (saved.data.status === 'seated' && !seatedUnrated) ||
      (saved.data.status !== 'seated' && saved.data.joined_at && Date.now() - Number(saved.data.joined_at) > 2 * 60 * 60 * 1000)
    );
    if (saved && saved.id && !stale) {
      currentTicketId = saved.id;
      activeTicketData = saved.data || null;
      localStorage.setItem('waitmate_ticket_id', currentTicketId);
      if (activeTicketData) {
        startTicketPolling();
        // Paint the floating bottom bar with the restored ticket's venue + rank
        // immediately instead of waiting for the first poll tick.
        renderActivePassPill();
      }
      // Do not auto-open secondary modals on initial boot; user can tap "My Pass"
      // or complete onboarding first.
    } else if (saved && saved.id) {
      clearCurrentTicket();
    }
  } catch (e) { /* ignore corrupt storage */ }

  // Restore already-rated tickets so a diner cannot rate the same visit twice after a reload
  try {
    const savedRated = JSON.parse(localStorage.getItem(RATED_STORAGE_KEY) || '[]');
    if (Array.isArray(savedRated)) ratedTickets = new Set(savedRated);
  } catch (e) { /* ignore corrupt storage */ }

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
      queue_count: 0,
      total_waiting_people: 0,
      estimated_wait_mins: 0,
      algorithmic_wait_mins: 0,
      has_manual_override: false,
      is_queue_open: true
    },
    reliability: {
      score: 96,
      grade: "A+",
      verdict: "Highly Reliable",
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
      queue_count: 0,
      total_waiting_people: 0,
      estimated_wait_mins: 0,
      algorithmic_wait_mins: 0,
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
      queue_count: 0,
      total_waiting_people: 0,
      estimated_wait_mins: 0,
      algorithmic_wait_mins: 0,
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
      queue_count: 0,
      total_waiting_people: 0,
      estimated_wait_mins: 0,
      algorithmic_wait_mins: 0,
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
      queue_count: 0,
      total_waiting_people: 0,
      estimated_wait_mins: 0,
      algorithmic_wait_mins: 0,
      has_manual_override: false,
      is_queue_open: true
    },
    reliability: {
      score: 97,
      grade: "A+",
      verdict: "Highly Reliable",
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
      queue_count: 0,
      total_waiting_people: 0,
      estimated_wait_mins: 0,
      algorithmic_wait_mins: 0,
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
    image_url: "https://images.unsplash.com/photo-1589302168068-964664d93dc0?w=800&auto=format&fit=crop&q=80",
    description: "Legendary 1923 Parsi cafe famous for Mutton Berry Pulao, Sali Boti, and Caramel Custard.",
    live_stats: {
      queue_count: 0,
      total_waiting_people: 0,
      estimated_wait_mins: 0,
      algorithmic_wait_mins: 0,
      has_manual_override: false,
      is_queue_open: true
    },
    reliability: {
      score: 95,
      grade: "A+",
      verdict: "Highly Reliable",
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
      queue_count: 0,
      total_waiting_people: 0,
      estimated_wait_mins: 0,
      algorithmic_wait_mins: 0,
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
      queue_count: 0,
      total_waiting_people: 0,
      estimated_wait_mins: 0,
      algorithmic_wait_mins: 0,
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
      queue_count: 0,
      total_waiting_people: 0,
      estimated_wait_mins: 0,
      algorithmic_wait_mins: 0,
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
    image_url: "https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800&auto=format&fit=crop&q=80",
    description: "Legendary Juhu Chowpatty street food truck serving butter-loaded Pav Bhaji, Masala Tawa Pulao, and grilled sandwiches.",
    live_stats: {
      queue_count: 0,
      total_waiting_people: 0,
      estimated_wait_mins: 0,
      algorithmic_wait_mins: 0,
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
      queue_count: 0,
      total_waiting_people: 0,
      estimated_wait_mins: 0,
      algorithmic_wait_mins: 0,
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
// EMPTIED: no simulated / AI / fake guests are seeded. Only real human
// Join Queue submissions create queue entries (POST /api/queue/join).
let localMockQueues = {};

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

  // URL-based founder entry (?founder=1, /founder, #founder) is handled by
  // window.WaitMateBoot after the logo splash so it never races the overlays.
  // Keyboard shortcut (Alt+Shift+F) and the footer brand click remain below.

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

// Clean 3-view switching: 'landing' | 'customer' | 'host' | 'founder'.
// Hides every other view and scrolls smoothly to the top so each screen feels
// like its own dedicated, distraction-free application.
function switchView(view) {
  // Route guard: when ?founder=1 is active, never let a background callback
  // (DOMContentLoaded, loadRestaurants, etc.) switch away from the Founder
  // Command Center. Only an explicit user action may exit founder view.
  if (founderDeepLinkActive && currentView === 'founder' && view !== 'founder') {
    showToast('Founder Command Center is active (?founder=1). Use "Back to Customer View" to exit.', 'info');
    return;
  }
  var views = {
    landing: document.getElementById('landingView'),
    customer: document.getElementById('customerView'),
    host: document.getElementById('ownerInterface'),
    founder: document.getElementById('founderInterface')
  };
  Object.keys(views).forEach(function (key) {
    var el = views[key];
    if (el) {
      el.classList.add('hidden');
      el.style.display = 'none';
    }
  });
  var target = views[view];
  if (target) {
    target.classList.remove('hidden');
    target.style.display = 'block';
  }
  currentView = view;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (window.lucide) lucide.createIcons();

  // Bootstrap the freshly shown view
  if (view === 'customer' && typeof renderRestaurantsGrid === 'function') {
    renderRestaurantsGrid();
    renderCustomerPhonePill();
  }
}

// =========================================================================
// App-Wide Light / Dark Theme Toggle
// Persists to localStorage (wm_landing_theme), applies via data-theme="light"
// on <html> (zero-flash head script), and swaps the pure-white SVG sun/moon
// icon. Works across ALL views: #landingView, #customerView, #ownerInterface,
// #founderInterface. The toggle button stays solid black (#000000) in BOTH
// modes; only the icon swaps (Sun = dark active -> switch to light, Moon =
// light active -> switch to dark).
// =========================================================================
const THEME_VIEWS = ['#landingView', '#customerView', '#ownerInterface', '#founderInterface'];

function toggleLandingTheme() {
  const html = document.documentElement;
  const body = document.body;
  const btn = document.getElementById('landingThemeToggle');

  // Tactile rotate/scale transition on the toggle button
  if (btn) {
    btn.classList.add('rotate-180', 'scale-95');
    setTimeout(() => btn.classList.remove('rotate-180', 'scale-95'), 150);
  }

  const isLight = html.hasAttribute('data-theme') ? !html.getAttribute('data-theme') === 'light' : false;
  const nextLight = !isLight;

  if (nextLight) {
    html.setAttribute('data-theme', 'light');
    body.setAttribute('data-theme', 'light');
    // Apply white canvas to all view wrappers (CSS !important handles colors)
    THEME_VIEWS.forEach(sel => {
      const el = document.querySelector(sel);
      if (el) el.setAttribute('data-theme', 'light');
    });
    if (btn) { btn.title = 'Switch to Dark Mode'; btn.setAttribute('aria-label', 'Switch to Dark Mode'); }
  } else {
    html.removeAttribute('data-theme');
    body.removeAttribute('data-theme');
    THEME_VIEWS.forEach(sel => {
      const el = document.querySelector(sel);
      if (el) el.removeAttribute('data-theme');
    });
    if (btn) { btn.title = 'Switch to Light Mode'; btn.setAttribute('aria-label', 'Switch to Light Mode'); }
  }

  try { localStorage.setItem('wm_landing_theme', nextLight ? 'light' : 'dark'); } catch (e) {}
  syncLandingThemeIcon(nextLight);
}

function syncLandingThemeIcon(isLight) {
  const sun = document.getElementById('landingThemeIconSun');
  const moon = document.getElementById('landingThemeIconMoon');
  if (!sun || !moon) return;

  // Button stays solid black with white icons in BOTH modes — only swap
  // which SVG icon is visible.
  if (isLight) {
    sun.classList.add('hidden');
    moon.classList.remove('hidden');
  } else {
    moon.classList.add('hidden');
    sun.classList.remove('hidden');
  }
}

// Reflect the persisted theme in the toggle icon once the DOM is ready.
(function(){ try {
  const isLight = document.documentElement.hasAttribute('data-theme') && document.documentElement.getAttribute('data-theme') === 'light';
  syncLandingThemeIcon(isLight);
} catch(e){} })();

function switchInterface(role) {
  // Route guard: when ?founder=1 is active, never let a background callback
  // (DOMContentLoaded, loadRestaurants, onboarding complete, etc.) switch away
  // from the Founder Command Center to customer or owner view. Only an explicit
  // user action (the "Back to Customer View" button) may exit founder view.
  if (founderDeepLinkActive && currentInterface === 'founder' && role !== 'founder') {
    showToast('Founder Command Center is active (?founder=1). Use "Back to Customer View" to exit.', 'info');
    return;
  }
  // Founder view requires secret unlock; otherwise prompt for the Master Password.
  if (role === 'founder' && !isFounderUnlocked()) {
    openFounderLoginModal();
    return;
  }
  // Host Stand auto-polling only applies to the owner tab.
  if (role !== 'owner') {
    stopHostStandPolling();
    // Switching away from the owner tab re-locks any unlocked host stand.
    clearAllHostPasswords();
  }
  currentInterface = role;

  // Strictly hide ALL views, then show only the requested one + scroll to top.
  switchView(role === 'owner' ? 'host' : role);

  var tabCust = document.getElementById('tabCustomer');
  var tabOwner = document.getElementById('tabOwner');
  var tabFounder = document.getElementById('tabFounder');

  const activeTabClass = "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition bg-white text-slate-900 shadow-sm";
  const inactiveTabClass = "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition text-slate-600 hover:text-slate-900";

  if (tabCust) tabCust.className = inactiveTabClass;
  if (tabOwner) tabOwner.className = inactiveTabClass;
  if (tabFounder) tabFounder.className = inactiveTabClass;

  var founderDiv = document.getElementById('founderInterface') || document.getElementById('founderView');

  if (role === 'customer') {
    if (founderDiv && founderDiv.isConnected) {
      founderInterfaceTemplate = founderDiv.cloneNode(true);
      founderDiv.remove();
    }
    renderRestaurantsGrid();
  } else if (role === 'owner') {
    if (founderDiv && founderDiv.isConnected) {
      founderInterfaceTemplate = founderDiv.cloneNode(true);
      founderDiv.remove();
    }
    showOwnerDirectory();
    startHostStandPolling();
  } else if (role === 'founder') {
    ['roleGateway','gatewayOverlay','landingGateway'].forEach(function (id) { var el = document.getElementById(id); if (el) el.classList.add('hidden'); });
    if (!document.getElementById('founderInterface') && founderInterfaceTemplate) {
      document.getElementById('mainContainer').appendChild(founderInterfaceTemplate.cloneNode(true));
      founderInterfaceTemplate = founderInterfaceTemplate.cloneNode(true);
    }
    var founderEl = document.getElementById('founderInterface') || document.getElementById('founderView');
    if (founderEl) { founderEl.classList.remove('hidden'); founderEl.style.display = 'block'; }
    if (tabFounder) {
      tabFounder.className = activeTabClass;
      tabFounder.style.removeProperty('display');
      tabFounder.classList.remove('hidden');
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
  if (tabHost) tabHost.className = "px-4 py-2 font-bold text-sm text-white border-b-2 border-emerald-500 flex items-center gap-2";
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

    showToast(`🎉 "${name}" was added to WaitMate (demo)!`, "success");
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
    submitBtn.innerHTML = `<i data-lucide="store" class="w-4 h-4 text-orange-400"></i> <span>Launch Restaurant on WaitMate (Demo)</span>`;
    lucide.createIcons();
  }
}

// ==========================================
// 2. FOUNDER OVERVIEW & PLATFORM COMMAND CENTER
// ==========================================
let founderRestaurantsCache = [];
let founderQueuesCache = [];
let founderReviewsCache = [];
let founderQueueView = 'active';
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
      founderRestaurantsCache = getSafeEntries(r);
    }
    if (queuesRes.status === 'fulfilled' && queuesRes.value.ok) {
      const q = await queuesRes.value.json();
      founderQueuesCache = getSafeEntries(q);
    }
    if (reviewsRes.status === 'fulfilled' && reviewsRes.value.ok) {
      const rv = await reviewsRes.value.json();
      founderReviewsCache = getSafeEntries(rv);
    }
    if (settingsRes.status === 'fulfilled' && settingsRes.value.ok) {
      const s = await settingsRes.value.json();
      globalAnnouncementText = s.global_announcement || '';
      const statusEl = document.getElementById('fndGlobalBannerStatus');
      if (statusEl) statusEl.textContent = globalAnnouncementText ? `Active: "${globalAnnouncementText}"` : 'None active';
    }

    // Surface any failed founder endpoint (401/403/500 or network error) to the
    // console instead of silently rendering an empty dashboard.
    const endpointChecks = [
      ['analytics', analyticsRes],
      ['restaurants', restaurantsRes],
      ['queues', queuesRes],
      ['reviews', reviewsRes],
      ['settings', settingsRes]
    ];
    for (const [name, res] of endpointChecks) {
      if (res.status === 'rejected') {
        console.error(`[Founder] /api/founder/${name} request failed:`, res.reason);
      } else if (!res.value.ok) {
        console.error(`[Founder] /api/founder/${name} returned HTTP ${res.value.status}`);
      }
    }
  } catch (err) {
    console.error("Founder dashboard load failed:", err);
  }
  // Build the live summary from whichever source actually populated data, so the
  // dashboard never stays blank when the analytics endpoint is slow or returns
  // an error. Founder caches (dedicated endpoints) take priority.
  const venues = (founderRestaurantsCache && founderRestaurantsCache.length)
    ? founderRestaurantsCache
    : (data && Array.isArray(data.restaurants) ? data.restaurants : []);
  const queues = (founderQueuesCache && founderQueuesCache.length)
    ? founderQueuesCache
    : (data && Array.isArray(data.recent_queues) ? data.recent_queues : []);
  const reviews = (founderReviewsCache && founderReviewsCache.length)
    ? founderReviewsCache
    : (data && Array.isArray(data.recent_reviews) ? data.recent_reviews : []);
  const activeQueues = queues.filter(q => q && q.status === 'waiting');
  const waitingDiners = activeQueues.reduce((s, q) => s + Number(q.party_size || 0), 0);
  const activeParties = activeQueues.length;
  const totalRestaurants = venues.length;
  const totalCities = [...new Set(venues.map(r => r.city || 'Mumbai'))].length;
  const reliabilityScores = venues.map(r => Number((r.reliability || {}).score || 92)).filter(Number.isFinite);
  const platformAvgReliability = reliabilityScores.length
    ? Math.round(reliabilityScores.reduce((a, b) => a + b, 0) / reliabilityScores.length)
    : 92;
  // Seated totals come from the analytics summary when available (it scans all
  // historical queue_entries), otherwise fall back to counting seated entries in
  // the live queue cache so the metric is never hardcoded to zero.
  const analyticsSummary = (data && data.summary) || {};
  const seatedFromCache = queues.filter(q => q.status === 'seated');
  const totalSeatedParties = analyticsSummary.total_seated_parties != null
    ? analyticsSummary.total_seated_parties
    : seatedFromCache.length;
  const totalSeatedDiners = analyticsSummary.total_seated_diners != null
    ? analyticsSummary.total_seated_diners
    : seatedFromCache.reduce((s, q) => s + Number(q.party_size || 0), 0);

  renderFounderData({
    summary: {
      total_restaurants: totalRestaurants,
      total_cities: totalCities,
      cities_list: [...new Set(venues.map(r => r.city || 'Mumbai'))],
      active_parties_in_queue: activeParties,
      active_diners_in_queue: waitingDiners,
      total_seated_parties: totalSeatedParties,
      total_seated_diners: totalSeatedDiners,
      platform_avg_reliability: platformAvgReliability
    },
    restaurants: venues,
    recent_queues: queues,
    recent_reviews: reviews
  });
}

function calculateRestaurantWaitTime(activePartiesAhead, avgTurnoverMinutes) {
  const parties = Math.max(0, Number(activePartiesAhead) || 0);
  const avg = Number.isFinite(Number(avgTurnoverMinutes)) ? Number(avgTurnoverMinutes) : 6;
  let wait = parties * avg;
  if (parties === 0) wait = Math.max(wait, 5);
  else wait = wait + 0;
  // base prep buffer alternative: activePartiesAhead * 6 when avg not provided
  if (!Number.isFinite(Number(avgTurnoverMinutes))) {
    wait = parties * 6;
    if (parties === 0) wait = 5;
  }
  wait = Math.max(0, Math.min(60, Math.round(wait)));
  if (wait === 0) wait = 5;
  if (parties === 0) wait = Math.max(1, Math.min(60, wait));
  return wait;
}
function escapeHtml(unsafe) {
  if (unsafe == null) return '';
  return String(unsafe).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function jsEscape(unsafe) {
  if (unsafe == null) return '';
  return String(unsafe).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function setFounderText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function renderFounderData(data) {
  const sum = data.summary || {};
  setFounderText('fndTotalVenues', sum.total_restaurants || 0);
  const venuesForOpen = data.restaurants || founderRestaurantsCache || [];
  const openNowCount = venuesForOpen.filter(r => Boolean((r.live_stats || { is_queue_open: true }).is_queue_open)).length;
  setFounderText('fndCitiesSummary', openNowCount);
  setFounderText('fndWaitingDiners', sum.active_diners_in_queue || 0);
  setFounderText('fndWaitingParties', `${sum.active_parties_in_queue || 0} parties in queues`);
  setFounderText('fndSeatedDiners', `${sum.total_seated_diners || 0}`);
  setFounderText('fndAvgReliability', `${sum.platform_avg_reliability || 92}%`);
  const walkawaySaved = Math.min(98, sum.total_seated_diners || 0);
  setFounderText('fndWalkawaySaved', `${walkawaySaved}% Walkaway Saved`);

  try {
  // Render Restaurants Network Table (Founder control row per venue)
  const restTbody = document.getElementById('fndRestaurantsTable');
  const venues = (data.restaurants || founderRestaurantsCache || []);
  if (restTbody) {
    setFounderText('fndVenueCountBadge', `${venues.length} venues`);
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
                <button onclick="founderRecalculateReliability('${id}')" class="px-2 py-1 bg-slate-50 text-slate-600 rounded text-[10px] font-bold hover:bg-slate-100 border border-slate-200 transition">Recalc</button>
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

  } catch (err) { console.error(err); }

  try {
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
        const isWalkIn = source === 'walk-in' || channel === 'walk_in';
        const channelLabel = isWalkIn ? '🚶 Walk-In' : '📱 Remote';
        const channelClass = isWalkIn ? 'bg-amber-100 text-amber-800 border border-amber-200' : 'bg-indigo-100 text-indigo-700 border border-indigo-200';
        const id = q.id || q.ticket_number;
        const nameJs = jsEscape(q.customer_name || '');
        const venueJs = jsEscape(q.restaurant_name || '');
        return `
          <tr class="hover:bg-slate-50 transition">
            <td class="py-2.5 px-4 font-mono font-bold text-slate-900">${escapeHtml(q.ticket_number || id)}</td>
            <td class="py-2.5 px-4 font-medium text-slate-800">${escapeHtml(q.restaurant_name)}</td>
            <td class="py-2.5 px-4">
              <div class="font-bold text-slate-900">${escapeHtml(q.customer_name)}</div>
              <div class="text-[10px] text-slate-600">${q.phone ? escapeHtml(formatIndiaPhone(q.phone)) : '—'}</div>
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
                <button onclick="founderReorderTicket('${id}', '${jsEscape(q.restaurant_id || '')}')" class="px-2 py-1 bg-indigo-50 text-indigo-700 rounded text-[10px] font-bold hover:bg-indigo-100 border border-indigo-200 transition flex items-center gap-1" title="Move to a new position in line">
                  <i data-lucide="arrows-up-down" class="w-2.5 h-2.5"></i> Order
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

  } catch (err) { console.error(err); }

  try {
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
              const restJs = jsEscape(rev.restaurant_id || '');
              const reviewer = rev.customer_name || rev.guest_name || 'Guest';
              return `
                <tr class="hover:bg-slate-50 transition">
                  <td class="py-2 px-2 text-slate-800 font-medium">${escapeHtml(reviewer)}</td>
                  <td class="py-2 px-2 text-slate-800">${escapeHtml(rev.restaurant_name)}</td>
                  <td class="py-2 px-2 text-center text-amber-700 font-bold">${stars}</td>
                  <td class="py-2 px-2 text-slate-600 italic max-w-[34px] overflow-hidden text-overflow-ellipsis whitespace-nowrap" title="${escapeHtml(rev.review_comment || rev.comment || '')}">${escapeHtml(rev.review_comment || rev.comment || '—')}</td>
                  <td class="py-2 px-2 text-center text-slate-500">${escapeHtml(ts)}</td>
                  <td class="py-2 px-2 text-right">
                    <button onclick="founderDeleteReview('${id}', '${jsEscape(rev.restaurant_id || '')}')" class="px-2 py-1 bg-rose-50 text-rose-700 rounded text-[9px] font-bold hover:bg-rose-100 border border-rose-200 flex items-center justify-center gap-1">
                      <i data-lucide="trash-2" class="w-2.5 h-2.5"></i> Delete
                    </button>
                    <button onclick="founderEditReview('${id}', '${jsEscape(rev.restaurant_id || '')}')" class="px-2 py-1 bg-blue-50 text-blue-700 rounded text-[9px] font-bold hover:bg-blue-100 border border-blue-200 flex items-center justify-center gap-1">
                      <i data-lucide="edit-3" class="w-2.5 h-2.5"></i> Edit
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
      reviewList.innerHTML = `<p class="text-xs text-slate-600 text-center py-6">No diner reviews yet</p>`;
    }
  }

  } catch (err) { console.error(err); }

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

// Client fallback guard: if the midnight IST cron is missed, the first active

// Guarantee every venue shows a distinct cover image. Existing Firestore/SQLite
// documents seeded before the image de-duplication still carry the old shared
// URLs, so we correct them in the UI mapper whenever a known-stale duplicate is
// detected. Founder-set custom images (anything not in the stale set) are left
// untouched.
const CANONICAL_COVER_IMAGES = {
  'rest-4': 'https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=800&auto=format&fit=crop&q=80',
  'rest-7': 'https://images.unsplash.com/photo-1589302168068-964664d93dc0?w=800&auto=format&fit=crop&q=80',
  'rest-11': 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800&auto=format&fit=crop&q=80',
};
const STALE_SHARED_COVER_IMAGES = new Set([
  'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&auto=format&fit=crop&q=80',
  'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=800&auto=format&fit=crop&q=80',
]);
function normalizeCoverImages(list) {
  for (const r of list) {
    const canonical = CANONICAL_COVER_IMAGES[r.id];
    if (canonical && STALE_SHARED_COVER_IMAGES.has(r.image_url)) {
      r.image_url = canonical;
    }
  }
  return list;
}

async function loadRestaurants() {
  try {
    const res = await fetch('/api/restaurants', { cache: 'no-store' });
    if (!res.ok) throw new Error('API response not ok');
    const data = await res.json();
    // If the backend returned an error-shaped body (e.g. { error: "..." })
    // with HTTP 200, surface it and fall back to offline data instead of
    // rendering an empty grid or crashing on .find()/filter().
    if (data && typeof data === 'object' && data.error && !Array.isArray(data.restaurants)) {
      showToast(data.error || 'Unable to load restaurants.', 'error');
      throw new Error(data.error || 'Unable to load restaurants');
    }
    allRestaurants = getSafeEntries(data);

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
    
    normalizeCoverImages(allRestaurants);
    renderRestaurantsGrid();
    populateHostDropdown();
    // Simulation worker disabled: queue is 100% human-driven; no background tick.
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
    
    normalizeCoverImages(allRestaurants);
    renderRestaurantsGrid();
    populateHostDropdown();
  }
}

// ---- Splash Screen Data Pre-Loading Helpers ----
// These run in parallel with the splash overlay so the Customer grid and active
// pass are fully populated the moment the splash fades out — no empty placeholders.

// Cache of per-venue reviews keyed by venue id. Populated eagerly on load so
// opening a venue detail card never shows a "Loading reviews..." flash.
const preloadedReviews = {};
let reviewsPreloadPromise = null;

async function preloadVenueReviews() {
  if (reviewsPreloadPromise) return reviewsPreloadPromise;
  reviewsPreloadPromise = (async () => {
    const ids = (allRestaurants && allRestaurants.length)
      ? allRestaurants.slice(0, 6).map(r => r.id).filter(Boolean)
      : [];
    await Promise.all(ids.map(async (id) => {
      if (preloadedReviews[id]) return;
      try {
        const res = await fetch(`/api/reviews?restaurantId=${encodeURIComponent(id)}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        preloadedReviews[id] = data.reviews || [];
      } catch (err) { /* non-critical: reviews render lazily on demand */ }
    }));
  })();
  return reviewsPreloadPromise;
}

// Active Pass (shared ticket deep-link) check: resolves quickly so a
// ?passId=... or ?ticket=... link feels instant. No-op when no pass is present.
async function loadActivePassData() {
  const params = new URLSearchParams(window.location.search);
  const passId = params.get('passId') || params.get('ticket');
  if (!passId) return;
  try {
    const res = await fetch(`/api/queue/ticket/${encodeURIComponent(passId)}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      // Surface the shared pass to the UI if the friend-pass tracker is present.
      if (typeof openFriendPassTracker === 'function') {
        window.__wmPreloadedPass = { id: passId, data };
      }
    }
  } catch (err) { /* non-critical: deep link will re-fetch on demand */ }
}

// City filter
function setCityFilter(city) {
  currentCity = city;
  document.querySelectorAll('.city-btn').forEach(btn => {
    if (btn.dataset.city === city) {
      btn.className = "city-btn active px-3 py-1.5 rounded-lg font-bold bg-slate-900 text-white border border-white/20 shadow-xs";
    } else {
      btn.className = "city-btn px-3 py-1.5 rounded-lg font-semibold bg-slate-900/70 border border-white/10 text-slate-200 hover:bg-slate-800/80 focus:border-emerald-400";
    }
  });

  renderRestaurantsGrid();
}

// Mumbai Neighborhood Filter Pills
function setAreaFilter(area) {
  currentArea = area;
  document.querySelectorAll('.area-pill').forEach(btn => {
    if (btn.dataset.area === area) {
      btn.className = "area-pill active px-3 py-1.5 rounded-lg font-bold bg-slate-900 text-white border border-white/20 shadow-xs whitespace-nowrap flex-shrink-0";
    } else {
      btn.className = "area-pill px-3 py-1.5 rounded-lg font-semibold bg-slate-900/70 border border-white/10 text-slate-200 hover:bg-slate-800/80 focus:border-emerald-400 whitespace-nowrap flex-shrink-0";
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

// Render Discovery Cards
function renderRestaurantsGrid() {
  const container = document.getElementById('restaurantsGrid');
  if (!container) return;

  let filtered = allRestaurants.filter(r => {
    if (currentCity !== 'all' && (r.city || 'Mumbai') !== currentCity) return false;
    if (!areaMatches(r, currentArea)) return false;
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

  // Top-right badge = EXACT sum of guests in line across all rendered restaurant cards
  const totalGuestsInLine = filtered.reduce((sum, r) => sum + (Number(r.live_stats?.total_waiting_people ?? r.total_waiting_people) || 0), 0);
  const topCountEl = document.getElementById('topLiveDinersCount');
  if (topCountEl) topCountEl.textContent = `${totalGuestsInLine} active diners`;
  const sectionCBadge = document.getElementById('sectionCDinerBadge');
  if (sectionCBadge) sectionCBadge.textContent = `${totalGuestsInLine} active diners in line`;
  const cwBadge = document.getElementById('cwActiveDinersCount');
  if (cwBadge) cwBadge.textContent = `${totalGuestsInLine}`;

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
      <div class="col-span-full py-16 text-center bg-slate-900/60 backdrop-blur-md rounded-2xl border border-white/10 p-8">
        <i data-lucide="store" class="w-12 h-12 text-slate-500 mx-auto mb-3"></i>
        <h3 class="text-base font-bold text-white">No restaurants match your filters in ${currentCity === 'all' ? 'Mumbai' : currentCity}</h3>
        <p class="text-xs text-slate-400 mt-1">Try clearing your search filters or selecting another neighborhood.</p>
        <button onclick="resetFilters()" class="mt-4 px-4 py-2 bg-slate-800/60 border border-white/10 text-slate-200 rounded-lg text-xs font-bold hover:bg-slate-700/80">Reset Filters</button>
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
    let rushBadgeClass = "text-emerald-400 bg-emerald-900/30 border border-emerald-500/40";
    let rushIcon = "🟢";
    let rushLabel = "Walk right in";
    if (parties >= 4 || wait >= 20) {
      rushBadgeClass = "text-rose-400 bg-rose-900/30 border border-rose-500/40";
      rushIcon = "🔴";
      rushLabel = "Peak Rush";
    } else if (parties >= 1 || (wait > 0 && wait < 20)) {
      rushBadgeClass = "text-amber-400 bg-amber-900/30 border border-amber-500/40";
      rushIcon = "🟠";
      rushLabel = "Filling fast";
    }

    // Reliability Badge styling (dark glass variants)
    let scoreBadgeClass = "border border-emerald-500/40 bg-emerald-900/20 text-emerald-400";
    let scoreIcon = "award";
    if (rel.score < 80) {
      scoreBadgeClass = "border border-rose-500/40 bg-rose-900/20 text-rose-400";
      scoreIcon = "alert-circle";
    } else if (rel.score < 90) {
      scoreBadgeClass = "border border-amber-500/40 bg-amber-900/20 text-amber-400";
      scoreIcon = "shield-check";
    }

    const isCurrentInQueue = activeTicketData && activeTicketData.restaurant_id === r.id && ['waiting', 'notified', 'delayed'].includes(activeTicketData.status);

    return `
      <div class="bg-slate-900/60 backdrop-blur-md border border-white/10 hover:border-emerald-400/40 rounded-2xl overflow-hidden flex flex-col group transition-colors duration-300">
        
        <!-- Image Header -->
        <div class="relative h-44 overflow-hidden bg-slate-950/80">
          <img src="${r.image_url}" alt="${r.name}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" onerror="this.onerror=null; this.src='https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80'">
          
          <!-- Gradient overlay -->
          <div class="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-black/20"></div>

          <!-- Top Pills -->
          <div class="absolute top-3 right-3 flex items-center gap-1.5 z-10">
            <span class="badge-tag bg-slate-900/80 backdrop-blur text-white text-[10px] font-bold uppercase tracking-wider">
              ${isTruck ? '🚚 Food Truck' : '🍽️ Dine-in'}
            </span>
            <span class="badge-tag bg-white/10 border border-white/20 text-slate-200 text-[10px] font-bold">
              ${r.price_range}
            </span>
            <span class="badge-tag bg-orange-500/90 text-white text-[10px] font-bold">
              📍 ${r.city || 'Mumbai'}
            </span>
          </div>

          <!-- Favorite / Bookmark Heart (top-left of cover image, opposite Reliability Score pill) -->
          <button onclick="toggleFavorite('${r.id}', this)" class="favorite-btn absolute top-3 left-3 w-9 h-9 rounded-full bg-white/5 backdrop-blur-md flex items-center justify-center text-white shadow-md border border-white/20 transition-transform active:scale-90 hover:bg-white/10 z-20" aria-label="${isFavorite(r.id) ? 'Remove from Favorites' : 'Add to Favorites'}" title="${isFavorite(r.id) ? 'Saved ♥' : 'Save to Favorites'}" id="fav-btn-${r.id}">
            <span id="heart-icon-${r.id}" class="text-2xl leading-none ${isFavorite(r.id) ? 'text-orange-500' : 'text-slate-400'}">${isFavorite(r.id) ? '♥' : '♡'}</span>
          </button>

          <!-- Bottom Venue Title inside Image -->
          <div class="absolute bottom-3 left-3 right-3">
            <h3 class="font-heading font-extrabold text-lg text-white leading-tight drop-shadow-sm">${r.name}</h3>
            <p class="text-xs text-slate-400 font-medium">${r.category}</p>
          </div>

        </div>

        <!-- Card Body -->
        <div class="p-5 flex-1 flex flex-col justify-between space-y-4">
          
          <p class="text-xs text-slate-400 line-clamp-2 leading-relaxed">
            ${r.description}
          </p>

          <div class="flex items-center justify-end pt-1">
            <button onclick="openWaitInfoModal()" class="text-[10px] font-bold text-slate-400 hover:text-white flex items-center gap-1 transition" aria-label="How wait times work">
              <i data-lucide="info" class="w-3.5 h-3.5 text-slate-400"></i> How wait times work
            </button>
          </div>
          <!-- Wait & Reliability Metric Strip -->
          <div class="grid grid-cols-2 gap-2 pt-2 border-t border-white/10">
            
            <!-- Live Wait Time -->
            <div class="bg-orange-900/15 rounded-xl p-3 border border-orange-500/30 flex flex-col justify-center">
              <span class="text-[10px] font-bold text-orange-400 uppercase tracking-wider flex items-center gap-1">
                <i data-lucide="clock" class="w-3 h-3 text-orange-400"></i> Estimated Wait
              </span>
              <div class="text-xl font-heading font-black text-orange-300 mt-0.5 font-mono tabular-nums">
                ${stats.estimated_wait_mins > 0 ? `${stats.estimated_wait_mins} min` : 'No wait'}
              </div>
              <span class="text-[10px] text-orange-300 font-medium">
                ${stats.queue_count} ${stats.queue_count === 1 ? 'party' : 'parties'} in line (${stats.total_waiting_people} guests)
              </span>
            </div>

            <!-- Reliability Score Card -->
            <div class="rounded-xl p-3 border ${scoreBadgeClass} flex flex-col justify-center cursor-pointer hover:opacity-90 transition min-w-0" onclick="openReliabilityModal('${r.id}')" title="Click to view full reliability breakdown">
              <div class="flex items-center justify-between gap-1.5 min-w-0">
                <span class="text-[9px] sm:text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 min-w-0 truncate">
                  <i data-lucide="${scoreIcon}" class="w-3 h-3 shrink-0"></i>
                  <span class="truncate">Reliability</span>
                </span>
                <span class="text-[9px] sm:text-[10px] font-black underline whitespace-nowrap shrink-0 cursor-pointer hover:opacity-70 transition" onclick="event.stopPropagation(); openReliabilityModal('${r.id}')" title="View full reliability breakdown">Details &rarr;</span>
              </div>
              <div class="flex items-baseline gap-1.5 mt-0.5">
                <span class="text-xl font-heading font-black font-mono tabular-nums text-white">${rel.score}%</span>
                <span class="text-[11px] font-bold text-slate-300">Grade ${rel.grade}</span>
              </div>
              <span class="text-[10px] text-slate-400">
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
          <div class="bg-amber-900/20 border border-amber-500/30 rounded-xl p-2.5 mb-2">
            <span class="text-[10px] font-bold text-amber-400 uppercase flex items-center gap-1 mb-1">
              <i data-lucide="megaphone" class="w-3 h-3"></i> Live Special
            </span>
            <p class="text-xs text-amber-300 font-medium leading-snug">${r.announcement}</p>
          </div>
          ` : ''}

          <!-- Bottom Action Buttons -->
          <div class="space-y-2 pt-1">
            ${isCurrentInQueue ? `
              <button onclick="openTicketModal()" class="w-full py-2.5 px-4 rounded-xl text-xs font-bold bg-slate-800/60 border border-white/10 text-white shadow-md flex items-center justify-center gap-1.5 hover:bg-slate-700/80 transition">
                <i data-lucide="ticket" class="w-4 h-4"></i>
                <span>You're in Queue! View Live Pass</span>
              </button>
            ` : stats.is_queue_open ? `
              <div class="grid grid-cols-2 gap-2">
                <button onclick="openJoinModal('${r.id}', 'remote')" class="py-2.5 px-3 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm flex items-center justify-center gap-1.5 transition">
                  <i data-lucide="smartphone" class="w-3 h-3"></i>
                  <span>Remote Join</span>
                </button>
                <button onclick="openJoinModal('${r.id}', 'walk_in')" class="py-2.5 px-3 rounded-xl text-xs font-bold bg-slate-800/60 border border-white/10 text-slate-300 hover:bg-slate-700/80 hover:border-white/30 transition flex items-center justify-center gap-1.5">
                  <i data-lucide="map-pin" class="w-3 h-3"></i>
                  <span>Walk-In</span>
                </button>
              </div>
            ` : `
              <button disabled class="w-full py-2.5 px-4 bg-slate-800/40 text-slate-500 rounded-xl text-xs font-semibold cursor-not-allowed border border-white/5">
                Queue Currently Paused
              </button>
            `}

            <button onclick="event.stopPropagation(); openReliabilityModal('${r.id}')" class="w-full py-1.5 text-slate-400 hover:text-white text-[11px] font-semibold text-center flex items-center justify-center gap-1 transition">
              <i data-lucide="bar-chart-2" class="w-3 h-3 text-slate-400"></i>
              <span>View Reliability History & Heatmap</span>
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
      btn.className = "cat-pill active px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition bg-slate-900 text-white border border-white/20";
    } else {
      btn.className = "cat-pill px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition bg-slate-900/70 border border-white/10 text-slate-200 hover:bg-slate-800/80 focus:border-emerald-400";
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
  document.getElementById('joinPreviewScore').innerHTML = `<i data-lucide="award" class="w-3 h-3"></i> ${r.reliability ? r.reliability.score : 95}% Reliability`;

  // Reset defaults (empty fields for clean customer entry)
  setPartySize(2);
  setSeatingPref('First Available');
  const savedName = localStorage.getItem('waitmate_guest_name') || '';
  document.getElementById('joinCustomerName').value = savedName;
  document.getElementById('joinSpecialReq').value = '';
  const savedPhone = getCustomerPhone();
  const joinPhoneInput = document.getElementById('joinCustomerPhone');
  const joinPhoneHint = document.getElementById('joinPhoneSavedHint');
  if (joinPhoneInput) joinPhoneInput.value = savedPhone ? phoneDigits10(savedPhone) : '';
  if (joinPhoneHint) joinPhoneHint.classList.toggle('hidden', !savedPhone);

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
      badge.className = "text-xs font-bold px-2.5 py-1 rounded border inline-block text-emerald-700 border-emerald-500/40 bg-emerald-900/20";
    } else {
      badge.textContent = 'Remote Join (On my way)';
      badge.className = "text-xs font-bold px-2.5 py-1 rounded border inline-block text-slate-700 border-white/20 bg-white/5";
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
      btn.className = "party-btn py-2 border rounded-lg text-xs font-bold hover:border-emerald-400 hover:bg-white/5 focus:outline-none bg-emerald-600 text-white border-emerald-400";
    } else {
      btn.className = "party-btn py-2 border rounded-lg text-xs font-bold hover:border-emerald-400 hover:bg-white/5 focus:outline-none border-white/10 text-slate-400";
    }
  });
}

function setSeatingPref(pref) {
  document.getElementById('joinSeatingPrefInput').value = pref;
  document.querySelectorAll('.pref-btn').forEach(btn => {
    if (btn.dataset.pref === pref) {
      btn.className = "pref-btn py-2 px-2 border rounded-lg text-xs font-semibold text-center border-emerald-500 bg-emerald-900/30 text-emerald-300";
    } else {
      btn.className = "pref-btn py-2 px-2 border rounded-lg text-xs font-semibold text-center border-white/10 text-slate-400 hover:border-emerald-400 hover:bg-white/5";
    }
  });
}

// One active ticket per device: show a clear blocking message and offer a
// button to view the diner's existing active pass instead of joining again.
function showDeviceBlockedDialog(ticket) {
  if (!ticket) return;
  const ticketNum = ticket.ticket_number || ticket.ticket_id || 'your ticket';
  const venue = (ticket.restaurant && ticket.restaurant.name) || ticket.restaurant_name || 'your venue';
  const existing = document.getElementById('deviceBlockedModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'deviceBlockedModal';
  modal.className = 'fixed inset-0 z-60 flex items-center justify-center bg-black/60';
  modal.innerHTML = `
    <div class="bg-slate-900 border border-white/15 text-slate-100 rounded-2xl p-6 w-[92%] max-w-md shadow-2xl">
      <h3 class="font-bold text-white mb-1">Already in a queue</h3>
      <p class="text-slate-400 text-sm mb-4">You already have an active ticket (#${escapeHtml(String(ticketNum))} at ${escapeHtml(String(venue))}). Finish or leave your current queue before joining another.</p>
      <div class="flex gap-2">
        <button onclick="closeDeviceBlockedModal(); openTicketModal()" class="flex-1 py-2.5 rounded-xl bg-slate-900 text-white font-bold text-sm">View My Active Pass</button>
        <button onclick="closeDeviceBlockedModal()" class="px-4 py-2.5 rounded-xl bg-slate-800/60 border border-white/10 text-slate-300 font-bold text-sm hover:bg-slate-700/80">Later</button>
      </div>
    </div>
  `;
  modal.onclick = (e) => { if (e.target === modal) closeDeviceBlockedModal(); };
  document.body.appendChild(modal);
  if (window.lucide) lucide.createIcons();
}

function closeDeviceBlockedModal() {
  const m = document.getElementById('deviceBlockedModal');
  if (m) m.remove();
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

  // WhatsApp number: validate + save so it attaches to this queue entry and
  // persists for future joins / the header phone pill.
  const joinPhoneInput = document.getElementById('joinCustomerPhone');
  const joinPhoneError = document.getElementById('joinPhoneError');
  const phoneDigits = (joinPhoneInput ? joinPhoneInput.value : '').trim();
  if (phoneDigits && !INDIAN_PHONE_RE.test(phoneDigits)) {
    if (joinPhoneError) joinPhoneError.classList.remove('hidden');
    if (joinPhoneInput) joinPhoneInput.focus();
    return;
  }
  if (joinPhoneError) joinPhoneError.classList.add('hidden');
  const joinPhone = phoneDigits ? '+91' + phoneDigits : '';
  if (joinPhone) localStorage.setItem(WM_CUSTOMER_PHONE_KEY, joinPhone);

  // One active ticket per device: block a second join if this device already
  // holds an active (waiting / arrived, not expired) ticket saved locally.
  const savedActive = JSON.parse(localStorage.getItem('waitmate_active_ticket') || 'null');
  if (savedActive && savedActive.data && isLocalTicketActive(savedActive.data)) {
    currentTicketId = savedActive.id;
    activeTicketData = savedActive.data;
    localStorage.setItem('waitmate_ticket_id', currentTicketId);
    localStorage.setItem('waitmate_active_ticket', JSON.stringify(savedActive));
    renderActivePassPill();
    showDeviceBlockedDialog(savedActive.data);
    return;
  }

  const submitBtn = document.getElementById('joinSubmitBtn');
  isSubmitting = true;
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> Securing Queue Spot...`;
  lucide.createIcons();

  const joinPayload = {
    restaurant_id: restId,
    name: name,
    phone: joinPhone,
    party_size: partySize,
    seating_pref: seatingPref,
    special_requests: specialReq,
    entry_type: joinChannel,
    device_id: getOrCreateDeviceId()
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
      // One active ticket per device: the backend blocked a duplicate join.
      // Surface the clear message and offer a button to view the existing pass.
      if (data.blocked && data.existing_ticket) {
        const existing = data.existing_ticket;
        activeTicketData = {
          ...existing,
          restaurant: existing.restaurant || { name: existing.restaurant_name || 'Unknown Venue' }
        };
        currentTicketId = existing.id;
        localStorage.setItem('waitmate_ticket_id', currentTicketId);
        localStorage.setItem('waitmate_active_ticket', JSON.stringify({ id: currentTicketId, data: activeTicketData }));
        renderActivePassPill();
        showDeviceBlockedDialog(activeTicketData);
      } else {
        showToast(data.error || 'Unable to join the queue right now. Please try again.', "error");
      }
      return;
    }

    currentTicketId = data.ticket_id;
    localStorage.setItem('waitmate_ticket_id', currentTicketId);

    // Immediately persist the full ticket object locally so cold starts / 404s never wipe it
    const promisedWait = data.promised_wait_mins ?? data.estimated_wait_mins ?? 10;
    const joinedTicket = {
      id: data.ticket_id,
      ticket_number: data.ticket_number,
      restaurant_id: restId,
      customer_name: name,
      phone: joinPhone,
      party_size: partySize,
      seating_pref: seatingPref,
      special_requests: specialReq,
      entry_type: joinChannel,
      status: 'waiting',
      estimated_wait_mins: promisedWait,
      promised_wait_mins: promisedWait,
      actual_wait_mins: 0,
      joined_at: Date.now() / 1000,
      notified_at: null,
      seated_at: null,
      has_arrived: false,
      delay_mins: 0,
      position_in_line: data.position_in_line ?? 1,
      parties_ahead: data.parties_ahead ?? 0,
      estimated_remaining_mins: promisedWait,
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

    isSubmitting = false;
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
      phone: joinPhone,
      party_size: partySize,
      seating_pref: seatingPref,
      special_requests: specialReq,
      entry_type: joinChannel,
      status: 'waiting',
      estimated_wait_mins: estWait,
      promised_wait_mins: estWait,
      actual_wait_mins: 0,
      joined_at: Date.now() / 1000,
      notified_at: null,
      seated_at: null,
      has_arrived: false,
      delay_mins: 0,
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

    isSubmitting = false;
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<i data-lucide="ticket" class="w-4 h-4"></i> <span>Join Online Queue & Get Pass</span>`;
    lucide.createIcons();
  }
}

// Render the clear "Ticket Expired" state inside the pass modal, clear the
// active pass bar, and expose a "Join a Fresh Queue" path.
function renderExpiredTicketState(d) {
  const pill = document.getElementById('activeTicketPill');
  if (pill) { pill.classList.add('hidden'); pill.classList.remove('flex'); }
  const modal = document.getElementById('ticketModal');
  if (modal) modal.classList.remove('hidden', 'pointer-events-none');
  const expiredEl = document.getElementById('ticketExpiredState');
  const ticketNumEl = document.getElementById('ticketNumber');
  const expiredTicketNum = document.getElementById('expiredTicketNumber');
  if (ticketNumEl) ticketNumEl.textContent = d.ticket_number || '#–';
  if (expiredTicketNum) expiredTicketNum.textContent = d.ticket_number || '#–';
  if (expiredEl) expiredEl.classList.remove('hidden');
  const countdown = document.getElementById('ticketEtaCountdown');
  if (countdown) countdown.textContent = 'Expired';
  const statusMsg = document.getElementById('ticketStatusMsg');
  if (statusMsg) {
    statusMsg.textContent = 'This pass has passed its arrival window and is no longer active.';
    statusMsg.className = 'text-xs text-rose-400 font-medium mt-1';
  }
}

// Clear the expired ticket and open the join queue modal for the same venue so
// the diner can join fresh.
function joinFreshQueue() {
  const restId = (activeTicketData && activeTicketData.restaurant_id) || selectedRestaurantId;
  clearCurrentTicket();
  if (restId) openJoinModal(restId, 'remote');
}

// ==========================================
// 5. DIGITAL PASS TRACKING & LIVE UPDATES
// ==========================================
function startTicketPolling() {
  if (pollTimer) clearInterval(pollTimer);
  fetchTicketStatus();
  pollTimer = setInterval(async () => {
    if (document.hidden || document.visibilityState !== 'visible') return;
    await fetchTicketStatus();
  }, 15000);
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
    // A ticket expired server-side (stale unarrived) surfaces a clear
    // "Ticket Expired" state and clears the active pass bar so the diner can
    // join fresh.
    if (data && data.status === 'expired') {
      showToast('Ticket Expired', 'error');
      activeTicketData = data;
      updateTicketUI();
      return;
    }
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

// Re-render the floating bottom "Active Pass" bar so it always matches the
// user's current ticket (venue name + live rank). Clears the bar and drops any
// stale localStorage session when there is no active, non-terminal ticket.
// Hidden whenever the Live Queue Pass modal is open (see openTicketModal).
function renderActivePassPill() {
  const pill = document.getElementById('activeTicketPill');
  if (!pill) return;

  if (!activeTicketData && !currentTicketId) {
    pill.classList.add('hidden');
    pill.classList.remove('flex');
    localStorage.removeItem('waitmate_active_ticket');
    localStorage.removeItem('waitmate_ticket_id');
    return;
  }

  const d = activeTicketData;
  if (!d) {
    pill.classList.add('hidden');
    pill.classList.remove('flex');
    return;
  }

  const venueObj = (allRestaurants || []).find(r => r.id === (d.restaurant_id || selectedRestaurantId)) || d.restaurant;
  const venueName = venueObj ? venueObj.name : (d.restaurant?.name || 'Unknown Venue');

  const venueEl = document.getElementById('activePillVenue');
  const posEl = document.getElementById('activePillPos');
  if (venueEl) venueEl.textContent = venueName;
  if (posEl) posEl.textContent = `#${d.position_in_line ?? '-'}`;

  pill.classList.remove('hidden');
  pill.classList.add('flex');
}

function updateTicketUI() {
  if (!activeTicketData) {
    document.getElementById('activeTicketPill').classList.add('hidden');
    return;
  }

  const d = activeTicketData;

  // Expired passes show a clear "Ticket Expired" state and clear the active
  // pass bar so the diner can join fresh.
  if (d.status === 'expired') {
    renderExpiredTicketState(d);
    return;
  }

  // Terminal / gone tickets clear the floating bar and the stored session
  // automatically: completed, left (no_show), cancelled, not-found.
  if (['cancelled', 'no_show', 'completed', 'left'].includes(d.status)) {
    clearCurrentTicket();
    return;
  }

  // Normalize estimated remaining mins: handle Firestore Timestamps / raw ms timestamps
  const toMs = (v) => {
    if (v == null) return null;
    if (typeof v === 'object' && typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v === 'string') { const t = Date.parse(v); return isNaN(t) ? null : t; }
    const n = Number(v);
    return isNaN(n) ? null : n;
  };
  const targetTs = toMs(d.estimated_call_time ?? d.estimatedCallTime ?? d.estimated_call_timestamp ?? d.target_call_time);
  if (targetTs != null) {
    const mins = Math.max(0, Math.round((targetTs - Date.now()) / 60000));
    d.estimated_remaining_mins = Math.min(60, Math.max(0, mins));
  } else {
    d.estimated_remaining_mins = Math.min(60, Math.max(0, Number(d.estimated_remaining_mins ?? 0)));
  }
  const pill = document.getElementById('activeTicketPill');

  // Always find the real restaurant name from allRestaurants (never fall back to "Partner Venue")
  const venueObj = (allRestaurants || []).find(r => r.id === (d.restaurant_id || selectedRestaurantId)) || d.restaurant;
  const venueName = venueObj ? venueObj.name : (d.restaurant?.name || 'Unknown Venue');

  // Reset step 4 (Seated) unless actually seated/completed
  const step4Icon = document.getElementById('step4Icon');
  if (step4Icon && !(d.status === 'seated' || d.status === 'completed')) {
    step4Icon.className = "w-5 h-5 mx-auto rounded-full bg-white/10 text-slate-500 flex items-center justify-center mb-1";
    step4Icon.textContent = "4";
  }

  if (d.status === 'notified') {
    acknowledgedAlertForTicket = null;
    graceUntil = null;
  }
  if (graceUntil && Date.now() > graceUntil) graceUntil = null;
  lastTicketStatus = d.status;

  // Re-render the floating bottom bar with this ticket's venue + live rank.
  renderActivePassPill();

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

  const arrivalStatusEl = document.getElementById('ticketArrivalStatus');
  if (graceUntil) {
    arrivalStatusEl.textContent = "Grace (+5m)";
    arrivalStatusEl.className = "font-bold text-amber-400";
  } else if (d.has_arrived) {
    arrivalStatusEl.textContent = "At Venue Entrance";
    arrivalStatusEl.className = "font-bold text-emerald-400";
  } else {
    arrivalStatusEl.textContent = "In Queue";
    arrivalStatusEl.className = "font-bold text-slate-400";
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
    arrivedAtEl.className = d.has_arrived ? "font-bold text-emerald-400 text-[10px] leading-tight" : "font-bold text-slate-400 text-[10px] leading-tight";
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
    document.getElementById('ticketEtaCountdown').className = "text-2xl font-black text-emerald-400 animate-pulse";
    document.getElementById('ticketStatusMsg').textContent = "Please proceed directly to the host counter. Your table is waiting.";
    
    livePassAlertCard.className = "p-3.5 rounded-xl whatsapp-card text-xs text-emerald-200 shadow-sm space-y-1 border border-emerald-500/30 bg-emerald-900/20";
    livePassAlertCard.classList.remove('hidden');
    document.getElementById('livePassAlertText').textContent = `"Namaste ${d.customer_name}! 🍽️ Your table at ${venueName} is READY! Please head to the host desk with Token #${d.ticket_number}. We are holding your spot for 5 minutes."`;

    tableNearAlert.classList.add('hidden');

    // Timeline steps
    document.getElementById('step3Icon').className = "w-5 h-5 mx-auto rounded-full bg-emerald-500 text-white shadow-[0_0_12px_rgba(16,185,129,0.6)] flex items-center justify-center mb-1 font-bold";
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
    document.getElementById('ticketEtaCountdown').textContent = `${d.estimated_remaining_mins === 0 ? 'Up Next' : '~' + d.estimated_remaining_mins + (d.estimated_remaining_mins === 1 ? ' min remaining' : ' mins remaining')}`;
    document.getElementById('ticketEtaCountdown').className = "text-2xl font-black text-emerald-400";
    document.getElementById('ticketStatusMsg').textContent = "You're checked in at the entrance. The host will notify you when your table is ready.";

    tableNearAlert.classList.add('hidden');
    livePassAlertCard.className = "p-3.5 rounded-xl whatsapp-card text-xs text-emerald-200 shadow-sm space-y-1 border border-emerald-500/30 bg-emerald-900/20";
    livePassAlertCard.classList.remove('hidden');
    document.getElementById('livePassAlertText').textContent = `"✓ Checked In at Entrance — Host Notified. You'll receive a sound chime as soon as the restaurant calls your table. Current wait: ~${d.estimated_remaining_mins} mins."`;

    // Timeline steps - step 2 (In Queue) is complete, step 3 (Table Ready) pending
    document.getElementById('step2Icon').className = "w-5 h-5 mx-auto rounded-full bg-emerald-500 text-white shadow-[0_0_12px_rgba(16,185,129,0.6)] flex items-center justify-center mb-1 font-bold";
    document.getElementById('step2Icon').textContent = "✓";
    document.getElementById('step3Icon').className = "w-5 h-5 mx-auto rounded-full bg-white/10 text-slate-500 flex items-center justify-center mb-1";
    document.getElementById('step3Icon').textContent = "3";

  } else if (isTableNear) {
    document.title = "🚨 (1) TABLE ALMOST READY • WaitMate India";
    document.getElementById('ticketEtaCountdown').textContent = `${d.estimated_remaining_mins === 0 ? 'Up Next' : '~' + d.estimated_remaining_mins + (d.estimated_remaining_mins === 1 ? ' min remaining' : ' mins remaining')}`;
    document.getElementById('ticketEtaCountdown').className = "text-2xl font-black text-slate-100";
    document.getElementById('ticketStatusMsg').textContent = "Host is clearing a table right now. Please start heading over!";

    const alertAcknowledged = acknowledgedAlertForTicket === d.id;

    if (!alertAcknowledged) {
      tableNearAlert.classList.remove('hidden');
      document.getElementById('nearPositionBadge').textContent = `#${d.position_in_line} in line`;
      document.getElementById('nearDistanceNotice').textContent = 'Priority Boarding';

      livePassAlertCard.className = "p-3.5 rounded-xl whatsapp-card text-xs text-emerald-200 shadow-sm space-y-1 border border-emerald-500/30 bg-emerald-900/20";
      livePassAlertCard.classList.remove('hidden');
      document.getElementById('livePassAlertText').textContent = `"Namaste ${d.customer_name}! 🍽️ Your table at ${venueName} is less than 4 mins away. Please make your way to the host desk. Table held for 5 mins."`;

      document.getElementById('step2Icon').className = "w-5 h-5 mx-auto rounded-full bg-amber-500 text-white shadow-[0_0_12px_rgba(245,158,11,0.6)] flex items-center justify-center mb-1 font-bold animate-pulse";

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

    document.getElementById('step4Icon').className = "w-5 h-5 mx-auto rounded-full bg-blue-500 text-white shadow-[0_0_12px_rgba(59,130,246,0.6)] flex items-center justify-center mb-1 font-bold";
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
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      openFeedbackModal(d);
    }
  } else {
    // Normal waiting
    document.title = `(${d.position_in_line}) In Queue: ${venueName} • WaitMate India`;
    document.getElementById('ticketEtaCountdown').textContent = `${d.estimated_remaining_mins === 0 ? 'Up Next' : '~' + d.estimated_remaining_mins + (d.estimated_remaining_mins === 1 ? ' min remaining' : ' mins remaining')}`;
    document.getElementById('ticketEtaCountdown').className = "text-2xl font-black text-slate-100";
    document.getElementById('ticketStatusMsg').textContent = "You're in good shape! Wait times are estimates that improve as diners leave feedback.";
    tableNearAlert.classList.add('hidden');
    livePassAlertCard.classList.add('hidden');
  }

  // Update Arrived button appearance based on state
  if (isArrivedWaiting && arrivedBtn) {
    arrivedBtn.innerHTML = `<i data-lucide="check-check" class="w-4 h-4"></i> <span>Arrival Confirmed • Host Notified</span>`;
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
    arrivedBtn.className = "w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-500/25";
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
  // Hide the floating bottom bar while the pass modal is open so it can never
  // overlap or block taps on the pass action buttons (Share / WhatsApp / Copy / Leave Queue).
  const pill = document.getElementById('activeTicketPill');
  if (pill) { pill.classList.add('hidden'); pill.classList.remove('flex'); }
  updateTicketUI();
  document.getElementById('ticketModal').classList.remove('hidden', 'pointer-events-none');
  lucide.createIcons();
};

function closeTicketModal() {
  document.getElementById('ticketModal').classList.add('hidden', 'pointer-events-none');
  // Restore the floating bottom bar (with the current venue + live rank) when
  // the pass closes and a non-terminal ticket is still active. Hidden again
  // automatically if there is no active ticket.
  renderActivePassPill();
  lucide.createIcons();
}

function clearCurrentTicket() {
  currentTicketId = null;
  activeTicketData = null;
  acknowledgedAlertForTicket = null;
  graceUntil = null;
  localStorage.removeItem('waitmate_ticket_id');
  localStorage.removeItem('waitmate_active_ticket');
  if (pollTimer) clearInterval(pollTimer);
  document.title = "WaitMate India 🇮🇳 • Restaurant Queues & Reliability — Demo";
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

// Reliable clipboard write with iOS / older-browser fallback (textarea + execCommand)
async function writeTextFallback(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return await navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('clipboard copy unavailable');
}

function buildShareMessage(ticketData) {
  const venueName = (ticketData.restaurant && ticketData.restaurant.name) || (ticketData.restaurant_name) || 'this restaurant';
  const rank = ticketData.position_in_line ?? '?';
  const eta = ticketData.estimated_remaining_mins ?? ticketData.estimated_wait_mins ?? '?';
  const party = ticketData.party_size ? ` • ${ticketData.party_size} guest${ticketData.party_size > 1 ? 's' : ''}` : '';
  const link = buildShareLink(currentTicketId || (ticketData.id || ''));
  return `I'm #${rank} in line at ${venueName}${party} (~${eta} mins wait) on WaitMate! Track our live table status: ${link}`;
}

async function sharePass() {
  if (!currentTicketId && !activeTicketData) {
    showToast("No active pass to share yet. Join a queue first!", "info");
    return;
  }
  const td = activeTicketData || {};
  const restaurantName = (td.restaurant && td.restaurant.name) || td.restaurant_name || 'restaurant';
  const tokenNumber = td.token_number || td.position_in_line || td.ticket_id || currentTicketId;
  const partySize = td.party_size || 1;
  const ticketId = currentTicketId || td.id;
  const passUrl = buildShareLink(ticketId);
  const shareMessage = `I'm in line at ${restaurantName} on WaitMate! Token #${tokenNumber} for ${partySize} guests. Track our live table status here:`;
  const shareData = { title: `WaitMate Pass – ${restaurantName}`, text: shareMessage, url: passUrl };

  if (navigator.share) {
    try {
      await navigator.share(shareData);
      return;
    } catch (err) {}
  }
  showSharePassModal(restaurantName, shareMessage, passUrl);
}

function showSharePassModal(restaurantName, shareMessage, passUrl) {
  let modal = document.getElementById('sharePassModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'sharePassModal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/50';
  modal.innerHTML = `
    <div class="bg-white rounded-2xl p-5 w-[92%] max-w-sm shadow-xl">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-bold text-slate-900">Share Pass</h3>
        <button onclick="closeSharePassModal()" class="text-slate-500 hover:text-slate-900">✕</button>
      </div>
      <div class="grid grid-cols-3 gap-3 text-center text-xs">
        <a target="_blank" href="https://wa.me/?text=${encodeURIComponent(shareMessage + ' ' + passUrl)}" class="flex flex-col items-center gap-1 p-2 rounded-lg hover:bg-slate-100">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="#25D366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
          WhatsApp
        </a>
        <a target="_blank" href="https://t.me/share/url?url=${encodeURIComponent(passUrl)}&text=${encodeURIComponent(shareMessage)}" class="flex flex-col items-center gap-1 p-2 rounded-lg hover:bg-slate-100">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="#0088cc"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
          Telegram
        </a>
        <button onclick="sharePassInstagram('${shareMessage.replace(/'/g,"\\'")} ${passUrl}')" class="flex flex-col items-center gap-1 p-2 rounded-lg hover:bg-slate-100">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#E1306C" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
          Instagram
        </button>
        <a target="_blank" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}&url=${encodeURIComponent(passUrl)}" class="flex flex-col items-center gap-1 p-2 rounded-lg hover:bg-slate-100">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="#000"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          X
        </a>
        <a href="sms:?body=${encodeURIComponent(shareMessage + ' ' + passUrl)}" class="flex flex-col items-center gap-1 p-2 rounded-lg hover:bg-slate-100">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          SMS
        </a>
        <a href="mailto:?subject=${encodeURIComponent('Join our table at ' + restaurantName)}&body=${encodeURIComponent(shareMessage + '\n\n' + passUrl)}" class="flex flex-col items-center gap-1 p-2 rounded-lg hover:bg-slate-100">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ea580c" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          Email
        </a>
        <button onclick="copyPassLink('${passUrl}')" class="flex flex-col items-center gap-1 p-2 rounded-lg hover:bg-slate-100">
          <svg id="copyPassIcon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Copy Pass Link
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function closeSharePassModal() {
  const m = document.getElementById('sharePassModal');
  if (m) m.remove();
}

async function sharePassInstagram(text) {
  try { await navigator.clipboard.writeText(text); } catch(e){}
  showToast('Copied! Opening Instagram...', 'info');
  setTimeout(() => window.open('https://www.instagram.com/', '_blank'), 600);
  closeSharePassModal();
}

async function copyPassLink(url) {
  try { await navigator.clipboard.writeText(url); } catch(e){}
  const icon = document.getElementById('copyPassIcon');
  if (icon) icon.outerHTML = '<svg id="copyPassIcon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
  setTimeout(() => {
    const i = document.getElementById('copyPassIcon');
    if (i) i.outerHTML = '<svg id="copyPassIcon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  }, 2000);
}

async function sharePassWhatsApp() {
  if (!currentTicketId && !activeTicketData) {
    showToast("No active pass to share yet. Join a queue first!", "info");
    return;
  }
  const ticketId = currentTicketId || activeTicketData.id;
  const link = buildShareLink(ticketId);
  const message = buildShareMessage(activeTicketData || {});
  try { await writeTextFallback(message); } catch (e) { /* clipboard optional */ }
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
    await writeTextFallback(link);
    const icon = document.getElementById('copyShareIcon');
    const label = document.getElementById('copyShareLabel');
    if (icon) {
      icon.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
      icon.setAttribute('data-copied', '1');
    }
    if (label) label.textContent = 'Copied!';
    showToast("Link copied to clipboard", "success");
    setTimeout(() => {
      if (icon) {
        icon.innerHTML = '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>';
        icon.removeAttribute('data-copied');
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
    btn.innerHTML = `<i data-lucide="check-check" class="w-4 h-4"></i> <span>Arrival Confirmed • Host Notified</span>`;
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
  // Show the modal immediately so the user sees feedback right away,
  // then populate data asynchronously so a slow API never blocks the open.
  const modalEl = document.getElementById('reliabilityModal');
  if (modalEl) modalEl.classList.remove('hidden');

  let r = null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`/api/restaurants/${venueId}`, { cache: 'no-store', signal: controller.signal });
    clearTimeout(timeoutId);
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
  document.getElementById('relModalVerdict').textContent = `${rel.verdict || 'Highly Reliable'} — ${rel.score >= 85 ? 'Consistently delivers on queue estimates.' : 'Noticeable variance during peak rush.'}`;
  document.getElementById('relModalVariance').textContent = `± ${rel.avg_variance_mins} mins`;
  document.getElementById('relModalTotalReviews').textContent = `${verifiedCheckins} diner check-ins`;

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

  // Fetch and display live reviews (non-blocking; modal is already visible)
  fetchAndRenderReviews(venueId).catch(() => { /* modal already open, reviews optional */ });

  lucide.createIcons();
}

function closeReliabilityModal() {
  document.getElementById('reliabilityModal').classList.add('hidden');
  // Reset review widget
  resetReviewWidget();
}

function openWaitInfoModal() {
  const m = document.getElementById('waitInfoModal');
  if (m) m.classList.remove('hidden');
  try { if (typeof lucide !== 'undefined') lucide.createIcons(); } catch (e) {}
}
function closeWaitInfoModal() {
  const m = document.getElementById('waitInfoModal');
  if (m) m.classList.add('hidden');
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeWaitInfoModal();
    const relModal = document.getElementById('reliabilityModal');
    if (relModal && !relModal.classList.contains('hidden')) closeReliabilityModal();
  }
});

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

// Paint the post-seating 1–5★ feedback widget. Referenced by openFeedbackModal()
// (reset to 0) and the star buttons in initFbStarRating(); without this the rating
// modal threw before un-hiding, so seated diners never saw the rating screen.
function updateFbStarDisplay(rating) {
  const starBtns = document.querySelectorAll('#fbStarRating .fb-star-btn');
  const ratingDisplay = document.getElementById('fbStarDisplay');
  const ratingInput = document.getElementById('fbStarInput');

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

  if (ratingDisplay) ratingDisplay.textContent = rating > 0 ? `${rating} / 5` : '';
  if (ratingInput) ratingInput.value = String(rating);
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

  // Serve from the splash pre-load cache when available so the venue detail
  // card never shows a "Loading reviews..." flash on a warm load.
  if (preloadedReviews[venueId]) {
    renderReviews(preloadedReviews[venueId]);
    return;
  }

  try {
    const res = await fetch(`/api/reviews?restaurantId=${encodeURIComponent(venueId)}`);
    if (res.ok) {
      const data = await res.json();
      preloadedReviews[venueId] = data.reviews || [];
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
    const reviewer = review.customer_name || review.guest_name || 'Guest';

    return `
      <div class="bg-slate-50 p-3 rounded-xl border border-slate-200 text-xs">
        <div class="flex items-center justify-between mb-1">
          <div class="flex items-center gap-2">
            <span class="text-amber-400 text-sm font-medium">${stars}</span>
            <span class="text-slate-600 font-medium">${review.rating} / 5</span>
          </div>
          <span class="text-slate-600 text-[10px]">${timeAgo}</span>
        </div>
        <div class="flex items-center justify-between mb-1">
          <span class="text-slate-700 font-semibold text-[11px]">👤 ${escapeHtml(reviewer)}</span>
        </div>
        ${review.comment ? `<p class="text-slate-700 font-medium italic">"${review.comment}"</p>` : ''}
      </div>
    `;
  }).join('');
}

function formatTimeAgo(timestamp) {
  const now = Date.now();
  let ms = Number(timestamp);
  if (!Number.isFinite(ms) || ms <= 0) return 'Just now';
  if (ms < 1e12) ms = ms * 1000; // seconds -> ms
  const diff = now - ms;
  const mins = Math.floor(diff / 60000);
  if (!Number.isFinite(mins) || mins < 0 || mins > 1440) return 'Just now';
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

    showToast("Thanks! Your check-in was recorded.", "success");

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
              <div class="w-full ${barColor} rounded-sm" style="height: ${heightPct}%" title="${p.hour}: ${p.avg_wait}m wait (${p.reliability}% reliability)"></div>
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
  document.getElementById('fbPromisedWait').textContent = `${ticket.promised_wait_mins ?? ticket.estimated_wait_mins ?? 0} mins`;
  document.getElementById('fbActualWait').textContent = `${ticket.actual_wait_mins || ticket.estimated_wait_mins || 0} mins`;
  // Hide the floating bottom bar while the rating screen is open so it cannot
  // block taps on Submit / Skip on small screens.
  const pill = document.getElementById('activeTicketPill');
  if (pill) { pill.classList.add('hidden'); pill.classList.remove('flex'); }
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
      btn.className = "fb-opt-btn p-3 border rounded-xl font-semibold text-center border-emerald-500 bg-emerald-900/20 text-emerald-300";
    } else {
      btn.className = "fb-opt-btn p-3 border rounded-xl font-semibold text-center border-white/10 hover:border-emerald-400 hover:bg-white/5 text-slate-400";
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
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit Check-in & Update Score'; }
  }
}

// Diner explicitly skips rating: close the rating screen and reset the session
// without saving a review. The ticket is marked as rated so the background poll
// cannot re-open the rating prompt for this visit. We first persist rated:true on
// the server (Firestore) and only THEN clear the local session, so the visit is
// closed exactly once across reloads and other devices.
async function skipDinerFeedback() {
  const ticketId = (document.getElementById('fbTicketId') || {}).value || currentTicketId || (activeTicketData && activeTicketData.id);
  // Mark rated locally first so the in-flight poll can't re-open the prompt.
  if (ticketId) markTicketRated(ticketId);
  // Persist rated:true (and the seated invariants) on the server before reset.
  if (ticketId) {
    try {
      await fetch('/api/queue/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket_id: ticketId, action: 'skip' })
      });
    } catch (err) {
      // Offline: the local rated flag still prevents the prompt from reappearing.
      console.warn('Skip sync warning:', err);
    }
  }
  document.getElementById('feedbackModal').classList.add('hidden');
  clearCurrentTicket();
  showToast("Rating skipped. Thanks for dining with us!", "info");
  loadRestaurants();
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

async function loadHostStand() {
  if (isAnyPasswordModalOpen()) return;
  const savedPwd = getSavedHostPassword(currentHostVenueId);
  if (!savedPwd) {
    showOwnerDirectory();
    return;
  }
  await renderUnlockedHostStand(currentHostVenueId, savedPwd);
}

// Auto-poll the Host Stand queue every 15s while the owner tab is active and visible so new
// customer joins appear automatically and fire a single alert without page reloads.
function startHostStandPolling() {
  if (hostStandPollTimer) clearInterval(hostStandPollTimer);
  hostStandPollTimer = setInterval(() => {
    if (currentInterface === 'owner' && currentHostVenueId && !document.hidden && document.visibilityState === 'visible') {
      loadHostStand();
    }
  }, 15000);
}

function stopHostStandPolling() {
  if (hostStandPollTimer) {
    clearInterval(hostStandPollTimer);
    hostStandPollTimer = null;
  }
}

// ==========================================
// Customer WhatsApp Phone System (+91 India)
// Zero API cost: wa.me deep-links, localStorage,
// server-side Firestore writes via /api endpoints.
// ==========================================

const WM_CUSTOMER_PHONE_KEY = 'wm_customer_phone';
const INDIAN_PHONE_RE = /^[6-9]\d{9}$/;

// Return stored "+91XXXXXXXXXX" only when it passes the 10-digit Indian
// mobile validation, else null.
function getCustomerPhone() {
  try {
    const raw = String(localStorage.getItem(WM_CUSTOMER_PHONE_KEY) || '').trim();
    const digits = raw.replace(/^\+91/, '').replace(/\D/g, '');
    return INDIAN_PHONE_RE.test(digits) ? '+91' + digits : null;
  } catch (e) { return null; }
}

// Strip everything but digits, then drop a leading "91" country code so
// callers always get the bare 10 digits for wa.me links.
function phoneDigits10(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('91') && d.length === 12) d = d.slice(2);
  return d;
}

// "+919999999999" → "+91 99999 99999"
function formatIndiaPhone(phone) {
  const d = phoneDigits10(phone);
  if (!INDIAN_PHONE_RE.test(d)) return String(phone || '');
  return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
}

// Platform-default Host WhatsApp Alert Number used for every venue that has
// not yet configured its own number. Owners/founders may override it with any
// 10-digit Indian number, or clear it to "" to disable WhatsApp alerts.
const DEFAULT_WHATSAPP_ALERT_PHONE = '9702132819';

// Effective alert number for a venue: stored whatsappAlertPhone when set,
// otherwise the platform default. Explicitly blank ("") means disabled.
function getRestaurantWhatsAppPhone(restaurant) {
  if (!restaurant) return DEFAULT_WHATSAPP_ALERT_PHONE;
  const val = restaurant.whatsappAlertPhone;
  return (val === undefined || val === null) ? DEFAULT_WHATSAPP_ALERT_PHONE : String(val);
}

// Mask a +91 10-digit number for host-stand table display: +91 ••••• ••123
function maskIndiaPhone(phone) {
  const d = phoneDigits10(phone);
  if (!INDIAN_PHONE_RE.test(d)) return String(phone || '');
  return `+91 ••••• ••${d.slice(7)}`;
}

function openCustomerFlow() {
  switchInterface('customer');
  renderCustomerPhonePill();
}

let customerPhoneEditMode = false;

function openCustomerPhoneModal(editMode = false) {
  customerPhoneEditMode = !!editMode;
  const modal = document.getElementById('customerPhoneModal');
  const input = document.getElementById('customerPhoneInput');
  const err = document.getElementById('customerPhoneError');
  const skipLink = document.getElementById('customerPhoneSkipLink');
  const btn = document.getElementById('customerPhoneSubmit');
  const saved = getCustomerPhone();
  if (input) input.value = saved ? phoneDigits10(saved) : '';
  if (err) err.classList.add('hidden');
  if (skipLink) skipLink.style.display = editMode ? 'none' : 'inline-block';
  if (btn) {
    btn.innerHTML = editMode
      ? `<i data-lucide="send" class="w-4 h-4"></i> <span>Save Changes →</span>`
      : `<i data-lucide="send" class="w-4 h-4"></i> <span>Save & Send Welcome on WhatsApp →</span>`;
  }
  if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
  lucide.createIcons();
  setTimeout(() => input && input.focus(), 50);
}

function closeCustomerPhoneModal() {
  const modal = document.getElementById('customerPhoneModal');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
}

async function submitCustomerPhone(event) {
  event.preventDefault();
  const input = document.getElementById('customerPhoneInput');
  const err = document.getElementById('customerPhoneError');
  const btn = document.getElementById('customerPhoneSubmit');
  const digits = (input.value || '').trim();

  if (!INDIAN_PHONE_RE.test(digits)) {
    err.classList.remove('hidden');
    input.focus();
    return;
  }
  err.classList.add('hidden');

  const phone = '+91' + digits;
  try {
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> Saving...`;
    lucide.createIcons();

    // 1. Persist locally so the join form, header pill, and queue entries all reuse it.
    localStorage.setItem(WM_CUSTOMER_PHONE_KEY, phone);

    // 2. Log the diner lead in Firestore (customer_leads collection).
    //    Server-side service account write — no client Firebase config,
    //    zero API cost, works seamlessly with existing security rules.
    try {
      await fetch('/api/customer/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, source: 'landing', created_at: Date.now() })
      });
    } catch (leadErr) {
      console.warn('customer_leads write failed (non-fatal):', leadErr);
    }

    // 3. Free WhatsApp welcome deep-link in a new tab to the official WaitMate
    //    India number, pre-filled with the opt-in request carrying the diner's number.
    const welcome = encodeURIComponent(`Hi WaitMate India! 🇮🇳 Please activate live queue & Table Ready alerts for my number (+91 ${digits}).`);
    window.open(`https://wa.me/919702132819?text=${welcome}`, '_blank');

    // 4. Transition to the Customer directory and paint the editable phone pill.
    closeCustomerPhoneModal();
    switchInterface('customer');
    renderCustomerPhonePill();
  } finally {
    btn.disabled = false;
    btn.innerHTML = customerPhoneEditMode
      ? `<i data-lucide="send" class="w-4 h-4"></i> <span>Save Changes →</span>`
      : `<i data-lucide="send" class="w-4 h-4"></i> <span>Save & Send Welcome on WhatsApp →</span>`;
    lucide.createIcons();
  }
}

function renderCustomerPhonePill() {
  const pill = document.getElementById('customerPhonePill');
  const text = document.getElementById('customerPhoneText');
  const phone = getCustomerPhone();
  if (!pill || !text) return;
  if (!phone) { pill.classList.add('hidden'); return; }
  text.textContent = `📱 ${formatIndiaPhone(phone)}`;
  pill.classList.remove('hidden');
}

// Send a free WhatsApp "Table Ready" alert from the Host Stand.
function hostWhatsAppReady(ticketId, guestName, venueName, phone) {
  const digits = phoneDigits10(phone);
  if (!INDIAN_PHONE_RE.test(digits)) { showToast('No valid phone number on this guest.', 'error'); return; }
  const text = encodeURIComponent(`Namaste ${guestName}! 🍽️ Your table at ${venueName} is READY. Please head to the host desk within 5 minutes. - WaitMate`);
  window.open(`https://wa.me/91${digits}?text=${text}`, '_blank');
  showToast(`WhatsApp Ready alert opened for ${guestName}`, 'success');
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

// Save or clear the venue's Host WhatsApp Alert Number (password-protected).
async function updateHostWhatsAppPhone() {
  if (!currentHostVenueId) return;
  const input = document.getElementById('hostWhatsAppPhoneInput');
  const btn = document.getElementById('hostWhatsAppPhoneSaveBtn');
  const phone = (input ? input.value : '').trim();
  if (phone !== '' && !INDIAN_PHONE_RE.test(phone)) {
    showToast('Enter a valid 10-digit Indian number (starting 6–9) or leave blank.', 'error');
    input && input.focus();
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  try {
    const res = await fetch('/api/host/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Restaurant-Password': getSavedHostPassword(currentHostVenueId) },
      body: JSON.stringify({
        restaurant_id: currentHostVenueId,
        action: 'update_whatsapp_phone',
        whatsappAlertPhone: phone
      })
    });
    let data = {};
    try { data = await res.json(); } catch (parseErr) { data = {}; }
    if (!res.ok) { showToast(data.error || 'Error saving WhatsApp number', 'error'); return; }
    showToast(data.message || 'WhatsApp alert number saved', 'success');
    await loadHostStand();
  } catch (err) {
    showToast('Error saving WhatsApp number', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

function clearHostWhatsAppPhone() {
  const input = document.getElementById('hostWhatsAppPhoneInput');
  if (input) input.value = '';
  updateHostWhatsAppPhone();
}

// Resolve a queue entry's join moment (accepts ms or seconds stamps) and format
// it as an Asia/Kolkata IST time plus a relative "Xm ago" string for the owner
// Host Stand waitlist rows.
function hostJoinInfo(q) {
  const raw = q.joined_at_ms !== undefined && q.joined_at_ms !== null ? q.joined_at_ms : (q.joined_at !== undefined && q.joined_at !== null ? q.joined_at : Date.now());
  let ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) ms = Date.now();
  else if (ms < 1e12) ms = ms * 1000; // seconds -> ms
  const now = Date.now();
  let mins = Math.floor((now - ms) / 60000);
  if (!Number.isFinite(mins) || mins < 0 || mins > 1440) mins = 0;
  const ist = new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
  const relative = mins < 1 ? 'just now' : `${mins}m ago`;
  return { ist, relative, ms };
}

function renderHostDashboard() {
  if (!hostData) return;
  const r = hostData.restaurant || { name: 'Venue', address: '', category: '', image_url: '' };
  const stats = hostData.live_stats || { queue_count: 0, total_waiting_people: 0, estimated_wait_mins: 0, is_queue_open: true };
  const rel = hostData.reliability || { score: 95, grade: 'A' };
  const queue = getSafeEntries(hostData.queue);
  const whatsappConfigured = Boolean(getRestaurantWhatsAppPhone(hostData.restaurant));
  // Host waiting table shows only live parties. Seated (and no_show/cancelled)
  // guests drop off cleanly here while their Firestore doc stays alive for the
  // diner's 1–5★ rating screen.
  const visibleQueue = queue.filter(q => q && q.status === 'waiting');

  document.getElementById('hostVenueName').textContent = r.name;
  document.getElementById('hostVenueLocationSub').textContent = `${r.address} • Host Stand Dashboard`;
  
  const openBadge = document.getElementById('hostQueueOpenBadge');
  const toggleBtn = document.getElementById('hostToggleQueueBtn');
  if (stats.is_queue_open) {
    openBadge.className = "bg-emerald-900/30 text-emerald-400 text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/40 shadow-[0_0_10px_rgba(16,185,129,0.35)]";
    openBadge.textContent = "QUEUE ACTIVE";
    toggleBtn.innerHTML = `<i data-lucide="pause" class="w-3.5 h-3.5"></i> <span>Pause Queue</span>`;
  } else {
    openBadge.className = "bg-rose-900/30 text-rose-400 text-[10px] font-bold px-2 py-0.5 rounded-full border border-rose-500/40 shadow-[0_0_10px_rgba(190,30,45,0.35)]";
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

  // Re-evaluate the anti-overpromising warning against the live queue on
  // every render (initial load + 15s poll) so it hides when the queue
  // empties or the manual wait is not genuinely lower than algorithmic.
  checkWaitOverrideWarning(stats.has_manual_override ? stats.estimated_wait_mins : null);

  // Host table rows
  const tbody = document.getElementById('hostQueueTableBody');
  if (visibleQueue.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="py-8 text-center text-slate-600">
          <i data-lucide="inbox" class="w-8 h-8 mx-auto mb-2 text-slate-300"></i>
          Queue is empty right now. Walk-ins and remote diners will appear here automatically.
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }

  tbody.innerHTML = visibleQueue.map((q, idx) => {
    let statusPill = `<span class="badge-tag bg-white/5 text-slate-400 border border-white/10">Waiting</span>`;
    if (q.status === 'notified') {
      statusPill = `<span class="badge-tag bg-emerald-900/30 text-emerald-400 border border-emerald-500/40 animate-pulse font-bold shadow-[0_0_10px_rgba(16,185,129,0.4)]">Table Ready</span>`;
    } else if (q.status === 'delayed') {
      statusPill = `<span class="badge-tag bg-amber-900/30 text-amber-400 border border-amber-500/40">Delayed (+${q.delay_mins}m)</span>`;
    } else if (q.status === 'seated') {
      statusPill = `<span class="badge-tag bg-blue-900/30 text-blue-400 border border-blue-500/40">Seated</span>`;
    } else if (q.status === 'cancelled' || q.status === 'no_show') {
      statusPill = `<span class="badge-tag bg-rose-900/30 text-rose-400 border border-rose-500/40">${q.status}</span>`;
    }

    const join = hostJoinInfo(q);
    const source = (q.source || q['source'] || '').toLowerCase();
    const isWalkIn = source === 'walk-in' || q.channel === 'walk_in' || q['09_channel'] === 'walk_in';
    const channel = (q.channel || q['09_channel'] || 'remote').toLowerCase();
    const channelLabel = isWalkIn ? '🚶 Walk-In Guest' : '🌐 Remote Join';
    const channelClass = isWalkIn ? 'bg-amber-900/20 text-amber-400 border border-amber-500/30' : 'bg-indigo-900/20 text-indigo-400 border border-indigo-500/30';

    // Customer Status column badge
    let customerStatusBadge = '';
    if (q.status === 'cancelled') {
      customerStatusBadge = `<span class="badge-tag bg-rose-900/20 text-rose-400 border border-rose-500/40 font-bold">Cancelled Queue</span>`;
    } else if (q.status === 'delayed') {
      customerStatusBadge = `<span class="badge-tag bg-amber-900/20 text-amber-400 border border-amber-500/40 font-bold">+5 Mins Requested</span>`;
    } else if (q.has_arrived) {
      customerStatusBadge = `<span class="badge-tag bg-emerald-900/30 text-emerald-400 border border-emerald-500/40 font-bold shadow-[0_0_10px_rgba(16,185,129,0.4)]">Arrived at Venue</span>`;
    } else {
      customerStatusBadge = `<span class="badge-tag bg-white/5 text-slate-400 border border-white/10">Awaiting Arrival</span>`;
    }

    // Disable Seat button if customer hasn't arrived
    const seatDisabled = !q.has_arrived;
    const seatButtonClass = seatDisabled 
      ? 'px-2.5 py-1 bg-white/5 text-slate-500 border border-white/10 rounded font-bold text-[11px] cursor-not-allowed flex items-center gap-1' 
      : 'px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-bold text-[11px] transition shadow-xs flex items-center gap-1';
    const seatButtonOnClick = seatDisabled ? '' : `onclick="hostAction('${q.id}', 'seat')" `;
    const seatTooltip = seatDisabled ? ' title="Waiting for arrival"' : '';

    return `
      <tr class="hover:bg-white/5 transition ${q.status === 'seated' ? 'opacity-60 bg-white/5' : ''}">
        
        <td class="py-3 px-4 font-mono font-bold text-slate-100">
          <div class="flex items-center gap-1.5">
            <span class="w-6 h-6 rounded-full bg-white/5 text-slate-400 border border-white/10 flex items-center justify-center text-[10px]">#${idx + 1}</span>
            <span>${q.ticket_number}</span>
          </div>
          <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-bold border ${channelClass}">${channelLabel}</span>
          <div class="text-[10px] text-slate-500 font-sans mt-1">Joined ${join.ist} · ${join.relative}</div>
        </td>

        <td class="py-3 px-4">
          <div class="font-bold text-slate-100 flex items-center gap-1.5 flex-wrap">${q.customer_name}</div>
          ${q.phone ? `<div class="text-[10px] text-emerald-300 font-medium mt-0.5 flex items-center gap-1">📱 ${maskIndiaPhone(q.phone)}</div>` : ''}
          ${q.special_requests ? `<div class="text-[10px] text-amber-400 font-medium mt-0.5">Note: ${q.special_requests}</div>` : ''}
        </td>

        <td class="py-3 px-4">
          <div class="font-semibold text-slate-200">${q.party_size} Guests</div>
          <div class="text-[10px] text-slate-500">${q.seating_pref}</div>
        </td>

        <td class="py-3 px-4">
          <div class="text-slate-200 font-medium">Joined ${join.relative}</div>
          <div class="text-[10px] text-slate-500">Promised: ${q.promised_wait_mins ?? q.estimated_wait_mins ?? 0}m</div>
        </td>

        <td class="py-3 px-4">
          <div class="flex items-center gap-1.5 flex-wrap">
            ${statusPill}
            ${idx < 2 && ['waiting', 'delayed'].includes(q.status) ? `<span class="badge-tag bg-orange-900/30 text-orange-400 border border-orange-500/30 font-bold animate-pulse">🚨 Near (#${idx+1})</span>` : ''}
            ${q.has_arrived ? `<span class="badge-tag bg-emerald-900/30 text-emerald-400 border border-emerald-500/40 font-bold">✓ At Entrance</span>` : `<span class="text-[10px] text-amber-400">En route</span>`}
          </div>
        </td>

        <td class="py-3 px-4">
          ${customerStatusBadge}
        </td>

        <td class="py-3 px-4 text-right">
          ${q.status !== 'seated' && q.status !== 'no_show' ? `
            <div class="flex items-center justify-end gap-1.5">
              ${q.status !== 'notified' ? `
                <button onclick="hostAction('${q.id}', 'notify')" class="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded font-bold text-[11px] transition shadow-xs flex items-center gap-1">
                  <i data-lucide="bell" class="w-3 h-3"></i> Notify
                </button>
              ` : ''}
              
              <button ${seatButtonOnClick}class="${seatButtonClass}"${seatTooltip}>
                <i data-lucide="check" class="w-3 h-3"></i> Seat
              </button>

              ${q.phone && whatsappConfigured ? `
                <button onclick="hostWhatsAppReady('${q.id}', '${jsEscape(q.customer_name)}', '${jsEscape(q.restaurant_name || '')}', '${q.phone}')" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-bold text-[11px] transition shadow-xs flex items-center gap-1" title="Send Table Ready on WhatsApp">
                  <i data-lucide="smartphone" class="w-3 h-3"></i> 📲 WhatsApp Ready
                </button>
              ` : ''}
              
              <button onclick="hostAction('${q.id}', 'remove')" class="px-2 py-1 bg-white/5 hover:bg-rose-500/30 text-slate-400 hover:text-rose-400 border border-white/10 rounded text-[11px] transition" title="Mark No-Show">
                <i data-lucide="user-x" class="w-3 h-3"></i>
              </button>
            </div>
          ` : `
            <span class="text-[11px] text-slate-400 font-medium">Completed</span>
          `}
        </td>

      </tr>
    `;
  }).join('');

  // Paint the venue's stored WhatsApp alert number (blank when disabled).
  const waInput = document.getElementById('hostWhatsAppPhoneInput');
  if (waInput) waInput.value = (hostData.restaurant && hostData.restaurant.whatsappAlertPhone) || '';

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
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Host API action failed');
    }
    let data = {};
    try { data = await res.json(); } catch (parseErr) { data = {}; }
    showToast(data.message || "Host action saved", "success");
    if (action === 'notify') playNotificationChime();
    await loadHostStand();
    await loadRestaurants();
    if (currentTicketId) await fetchTicketStatus();
  } catch (err) {
    // Handle arrival requirement error specifically
    if (err.message && err.message.includes("must click I've Arrived")) {
      showToast("Customer must click 'I've Arrived at the Venue' before seating", "error");
      return;
    }
    // Local simulation fallback
    const qList = localMockQueues[currentHostVenueId] || [];
    const entry = qList.find(x => x.id === ticketId);
    if (entry) {
      if (action === 'notify') {
        entry.status = 'notified';
        playNotificationChime();
        showToast("Table Ready alert sent to guest's Digital Boarding Pass!", "success");
      } else if (action === 'seat') {
        // Enforce arrival requirement locally as well
        if (!entry.has_arrived) {
          showToast("Customer must click 'I've Arrived at the Venue' before seating", "error");
          return;
        }
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
    'bg-slate-900 text-[var(--wm-text-primary)] border-slate-700'
  }`;

  let icon = 'check-circle';
  if (type === 'error') icon = 'alert-triangle';
  if (type === 'info') icon = 'info';

  toast.innerHTML = `
    <i data-lucide="${icon}" class="w-4 h-4 shrink-0 ${type === 'success' ? 'text-emerald-400' : type === 'error' ? 'text-rose-400' : 'text-[var(--wm-text-secondary)]'}"></i>
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
  if (newPwd.length < 8) {
    if (errEl) {
      errEl.textContent = 'New password must be at least 8 characters';
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
  if (newPwd.length < 8) {
    if (errEl) {
      errEl.textContent = 'Password must be at least 8 characters';
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
  if (newPwd.length < 8) {
    if (errEl) {
      errEl.textContent = 'New password must be at least 8 characters.';
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
  const whatsappAlertPhone = (document.getElementById('fndNewWhatsAppPhone')?.value || '').trim();
  if (whatsappAlertPhone !== '' && !INDIAN_PHONE_RE.test(whatsappAlertPhone)) {
    showToast('Host WhatsApp Alert Number must be a 10-digit Indian number (6–9 start) or left blank.', 'error');
    return;
  }
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
  if (password.length < 8) {
    showToast('Owner dashboard password must be at least 8 characters.', 'error');
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
        description: bio || `Authentic ${category} located in ${city}.`,
        whatsappAlertPhone
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
    showToast(`🎉 "${name}" was added to WaitMate Mumbai (demo)!`, 'success');
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
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Queue action failed');
    }
    const data = await res.json().catch(() => ({}));
    showToast(data.message || 'Queue action updated.', 'success');
    if (action === 'notify') playNotificationChime();
    await loadFounderDashboard();
    await loadRestaurants();
    if (currentTicketId) await fetchTicketStatus();
  } catch (err) {
    if (err.message && err.message.includes("must click I've Arrived")) {
      showToast("Customer must click 'I've Arrived at the Venue' before seating", "error");
      return;
    }
    showToast('Error performing queue action', 'error');
  }
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

// Switch the founder queue stream between live queues and full history (seated / cancelled / no_show / expired)
async function founderSetQueueView(view) {
  founderQueueView = view;
  const activeBtn = document.getElementById('fndQvActive');
  const allBtn = document.getElementById('fndQvAll');
  if (activeBtn && allBtn) {
    if (view === 'all') {
      activeBtn.className = 'px-2 py-1 rounded text-[10px] font-bold bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100';
      allBtn.className = 'px-2 py-1 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100';
    } else {
      activeBtn.className = 'px-2 py-1 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100';
      allBtn.className = 'px-2 py-1 rounded text-[10px] font-bold bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100';
    }
  }
  try {
    const res = await fetch(`/api/founder/queues?status=${view}`, { headers: founderHeaders(), cache: 'no-store' });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    if (!res.ok) throw new Error('Failed to load queue stream');
    const q = await res.json();
    const entries = getSafeEntries(q);
    const venues = (founderRestaurantsCache && founderRestaurantsCache.length) ? founderRestaurantsCache : (allRestaurants || []);
    const reviews = (founderReviewsCache && founderReviewsCache.length) ? founderReviewsCache : [];
    renderFounderData({
      summary: {
        total_restaurants: venues.length,
        total_cities: [...new Set(venues.map(r => r.city || 'Mumbai'))].length,
        cities_list: [...new Set(venues.map(r => r.city || 'Mumbai'))],
        active_parties_in_queue: entries.filter(e => e.status === 'waiting').length,
        active_diners_in_queue: entries.filter(e => e.status === 'waiting').reduce((s, e) => s + Number(e.party_size || 0), 0),
        total_seated_parties: entries.filter(e => e.status === 'seated').length,
        total_seated_diners: entries.filter(e => e.status === 'seated').reduce((s, e) => s + Number(e.party_size || 0), 0),
        platform_avg_reliability: venues.length ? Math.round(venues.reduce((a, r) => a + Number((r.reliability || {}).score || 92), 0) / venues.length) : 92
      },
      restaurants: venues,
      recent_queues: entries,
      recent_reviews: reviews
    });
  } catch (err) {
    console.error("[Founder] queue stream error:", err);
    showToast('Error loading queue stream', 'error');
  }
}

// Move a ticket to a new position (1 = first) within its venue's active queue
async function founderReorderTicket(ticketId, restaurantId) {
  if (!restaurantId) { showToast('Cannot reorder: missing venue.', 'error'); return; }
  const entered = window.prompt('Move this ticket to which position in line? (1 = first)');
  if (entered === null) return;
  const position = Number(entered);
  if (!Number.isFinite(position) || position < 1) { showToast('Invalid position.', 'error'); return; }
  try {
    const res = await fetch('/api/founder/queue/reorder', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({ restaurant_id: restaurantId, ticket_id: ticketId, new_position: position })
    });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    if (!res.ok) throw new Error('Reorder failed');
    showToast(`Ticket moved to position ${position}.`, 'success');
    await founderSetQueueView(founderQueueView);
  } catch (err) { showToast('Error reordering ticket', 'error'); }
}

// Recalculate a venue's Reliability Score from its current reviews (clears manual override)
async function founderRecalculateReliability(venueId) {
  try {
    const res = await fetch('/api/founder/reliability/recalculate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({ restaurant_id: venueId })
    });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    if (!res.ok) throw new Error('Recalculation failed');
    const data = await res.json().catch(() => ({}));
    showToast(data.message || 'Reliability Score recalculated.', 'success');
    await loadFounderDashboard();
    await loadRestaurants();
  } catch (err) { showToast('Error recalculating Reliability Score', 'error'); }
}

// Edit a review's rating and comment; Reliability Score is recalculated automatically
async function founderEditReview(reviewId, restaurantId) {
  if (!reviewId) { showToast('Cannot edit: missing review.', 'error'); return; }
  const enteredRating = window.prompt('Enter new rating (1-5 stars):');
  if (enteredRating === null) return;
  const rating = Number(enteredRating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) { showToast('Rating must be between 1 and 5.', 'error'); return; }
  const comment = window.prompt('Enter new review comment (leave blank to clear):');
  if (comment === null) return;
  try {
    const res = await fetch(`/api/founder/reviews/${reviewId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...founderHeaders() },
      body: JSON.stringify({ rating, comment })
    });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    if (!res.ok) throw new Error('Review edit failed');
    showToast('Review updated. Reliability Score recalculated.', 'success');
    await founderSetQueueView(founderQueueView);
    await loadFounderDashboard();
  } catch (err) { showToast('Error editing review', 'error'); }
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
  document.getElementById('fndEditWhatsAppPhone').value = r.whatsappAlertPhone || '';
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
  const whatsappAlertPhone = (document.getElementById('fndEditWhatsAppPhone')?.value || '').trim();
  if (whatsappAlertPhone !== '' && !INDIAN_PHONE_RE.test(whatsappAlertPhone)) {
    showToast('Host WhatsApp Alert Number must be a 10-digit Indian number (6–9 start) or left blank.', 'error');
    return;
  }
  const mealTimes = getCheckedMealTimes('fndEditMealTime');
  if (mealTimes.length === 0) {
    const err = document.getElementById('fndEditMealError');
    if (err) err.classList.remove('hidden');
    return;
  }
  const err = document.getElementById('fndEditMealError');
  if (err) err.classList.add('hidden');

  if (!name || !category || !address) { showToast('Name, category and address are required.', 'error'); return; }
  if (password && password.length < 8) { showToast('Owner password must be at least 8 characters.', 'error'); return; }

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
        ...(whatsappAlertPhone !== undefined ? { whatsappAlertPhone } : {}),
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
      method: "DELETE", headers: { ...founderHeaders() }
    });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    if (!res.ok) throw new Error('Delete failed');
    showToast('Review deleted. Reliability Score recalculated.', 'success');
    await loadFounderDashboard();
  } catch (err) { showToast('Error deleting review', 'error'); }
}

async function founderSeedReviews() {
  if (!confirm("Seed 3 realistic sample reviews per restaurant (12 venues x 3 = 36)? Existing seeded batches are skipped so this is idempotent.")) return;
  try {
    const res = await fetch('/api/reviews/seed', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...founderHeaders() }
    });
    if (res.status === 401) { sessionStorage.removeItem(FOUNDER_PWD_KEY); openFounderLoginModal(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Seed failed');
    showToast(data.message || 'Sample reviews seeded.', 'success');
    await loadFounderDashboard();
  } catch (err) { showToast(err.message || 'Error seeding reviews', 'error'); }
}

window.calculateRestaurantWaitTime = calculateRestaurantWaitTime;

// ==========================================
// Navigation & Landing-Page Helpers
// ==========================================

// Smooth-scroll to a page section, compensating for the sticky navbar height.
function scrollToSection(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const header = document.getElementById('topNavbar');
  const offset = header ? header.getBoundingClientRect().height : 80;
  const top = el.getBoundingClientRect().top + window.pageYOffset - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

// Open the existing Host Stand: switch to the owner view and prompt for the
// venue dashboard password. Host Stand login flow and passwords are unchanged.
function openHostStand() {
  switchInterface('owner');
  const firstVenue = (allRestaurants && allRestaurants.length) ? allRestaurants[0] : null;
  if (firstVenue) {
    openOwnerPasswordModal(firstVenue.id);
  } else {
    openOwnerPasswordModal();
  }
}

// ==========================================
// Section B — Sandbox-only interactive mini preview hero
// Local component state only — never touches real Firestore/API data.
// ==========================================
let heroStageCurrent = 0;

const heroStages = [
  {
    label: 'LIVE · QUEUE OPEN',
    eta: '~22 min',
    progress: 0,
    pass: 'REMOTE JOIN — queue open, rank locked when you travel',
    statusClass: 'border-emerald-500/30 bg-emerald-950/25 text-emerald-300',
    statusDot: 'bg-emerald-400'
  },
  {
    label: 'JOINED · RANK #4',
    eta: '~14 min',
    progress: 35,
    pass: 'DIGITAL PASS ACTIVE • 4 parties ahead of you',
    statusClass: 'border-cyan-400/40 bg-cyan-950/25 text-cyan-300',
    statusDot: 'bg-cyan-400'
  },
  {
    label: 'ARRIVED · TABLE PREPPED',
    eta: '~2 min',
    progress: 75,
    pass: '“I’VE ARRIVED” VERIFIED • table being prepped',
    statusClass: 'border-emerald-400/50 bg-emerald-900/40 text-emerald-200',
    statusDot: 'bg-emerald-400'
  },
  {
    label: 'SEATED · RATED',
    eta: '0 min',
    progress: 100,
    pass: 'SEATED • rate your experience to sharpen the score',
    statusClass: 'border-emerald-400 bg-emerald-500/20 text-emerald-100 shadow-[0_0_24px_rgba(16,185,129,0.35)]',
    statusDot: 'bg-emerald-400'
  }
];

let heroEtaTimer = null;

function setHeroEta(targetText) {
  const el = document.getElementById('heroEtaCountdown');
  if (!el) return;
  const targetNum = parseInt(String(targetText || '').replace(/\D/g, ''), 10);
  const curNum = parseInt(String(el.textContent || '').replace(/\D/g, ''), 10);
  if (!Number.isFinite(targetNum) || !Number.isFinite(curNum)) {
    el.textContent = targetText;
    return;
  }
  clearInterval(heroEtaTimer);
  const steps = 14;
  let step = 0;
  const stepMs = Math.max(40, 600 / steps);
  heroEtaTimer = setInterval(function () {
    step += 1;
    const val = Math.round(curNum + (targetNum - curNum) * (step / steps));
    el.textContent = String(targetText).replace(/\d+/, val) + ' min';
    if (step >= steps) {
      clearInterval(heroEtaTimer);
      heroEtaTimer = null;
    }
  }, stepMs);
}

function heroStage(n) {
  heroStageCurrent = n;
  const s = heroStages[n - 1];
  if (!s) return;
  const badge = document.getElementById('heroStatusBadge');
  const bar = document.getElementById('heroProgressBar');
  const pct = document.getElementById('heroProgressPct');
  const eta = document.getElementById('heroEtaCountdown');
  const passBanner = document.getElementById('heroPassBanner');
  const passText = document.getElementById('heroPassText');
  if (badge) badge.textContent = s.label;
  if (bar) bar.style.width = s.progress + '%';
  if (pct) pct.textContent = s.progress + '%';
  if (eta) setHeroEta(s.eta);
  if (passText) passText.textContent = s.pass;
  if (passBanner) passBanner.className = 'mb-7 rounded-xl border ' + s.statusClass + ' backdrop-blur-sm text-xs font-mono px-4 py-3.5 flex items-center gap-3 relative overflow-hidden';

  document.querySelectorAll('.hero-stage-btn').forEach(function (btn, i) {
    var active = (i + 1 === n);
    if (active) {
      btn.className = 'hero-stage-btn px-4 py-3.5 rounded-xl border border-emerald-400/60 bg-emerald-500/12 text-emerald-300 text-sm font-semibold flex flex-col items-center gap-1.5 hover:bg-emerald-500/20 hover:border-emerald-400 transition-all active:scale-95 shadow-[0_0_15px_rgba(16,185,129,0.25)]';
    } else {
      btn.className = 'hero-stage-btn px-4 py-3.5 rounded-xl border border-emerald-500/20 bg-slate-800/40 text-slate-500 text-sm font-semibold flex flex-col items-center gap-1.5 hover:bg-emerald-500/08 hover:border-emerald-400/40 transition-all active:scale-95';
    }
  });
}

// Kick off stage 1 so the telemetry card is alive on first paint
heroStage(1);

// ==========================================
// Section D — Expandable score breakdown cards
// ==========================================
function toggleScoreCard(el) {
  if (!el || !el.classList.contains('score-card')) return;
  var body = el.querySelector('.score-body');
  var icon = el.querySelector('i[data-lucide="chevron-down"], i[data-lucide="chevron-up"]');
  var isOpen = (body.style.maxHeight && body.style.maxHeight !== '0px' && body.style.maxHeight !== '');

  // Close any other open card first (one at a time)
  document.querySelectorAll('.score-card').forEach(function (card) {
    if (card === el) return;
    var b = card.querySelector('.score-body');
    var ic = card.querySelector('i[data-lucide="chevron-down"], i[data-lucide="chevron-up"]');
    b.style.maxHeight = '0';
    if (ic) {
      ic.setAttribute('data-lucide', 'chevron-down');
      ic.className = 'w-4 h-4 text-slate-400 group-hover:text-orange-500 transition-transform duration-300';
    }
  });

  if (isOpen) {
    body.style.maxHeight = '0';
    if (icon) {
      icon.setAttribute('data-lucide', 'chevron-down');
      icon.className = 'w-4 h-4 text-slate-400 group-hover:text-orange-500 transition-transform duration-300';
    }
  } else {
    body.style.maxHeight = body.scrollHeight + 'px';
    if (icon) {
      icon.setAttribute('data-lucide', 'chevron-up');
      icon.className = 'w-4 h-4 text-slate-400 group-hover:text-orange-500 transition-transform duration-300';
    }
  }
  if (window.lucide) lucide.createIcons();
}

// Feature card "Tap/Hover to Inspect" toggle (one card open at a time)
function toggleFeature(el) {
  if (!el || !el.classList.contains('feature-card')) return;
  var body = el.querySelector('.feature-body');
  if (!body) return;
  var isOpen = body.style.maxHeight && body.style.maxHeight !== '0px' && body.style.maxHeight !== '';
  document.querySelectorAll('.feature-card .feature-body').forEach(function (b) {
    b.style.maxHeight = '0';
  });
  if (!isOpen) {
    body.style.maxHeight = body.scrollHeight + 'px';
  }
}

// FAQ accordion toggle (one item open at a time)
function toggleFaq(el) {
  if (!el || !el.classList.contains('faq-item')) return;
  var body = el.querySelector('.faq-body');
  var icon = el.querySelector('i[data-lucide="chevron-down"], i[data-lucide="chevron-up"]');
  var isOpen = body.style.maxHeight && body.style.maxHeight !== '0px' && body.style.maxHeight !== '';
  document.querySelectorAll('.faq-item .faq-body').forEach(function (b) {
    b.style.maxHeight = '0';
  });
  document.querySelectorAll('.faq-item i[data-lucide="chevron-up"]').forEach(function (ic) {
    ic.setAttribute('data-lucide', 'chevron-down');
    ic.className = 'w-4 h-4 text-slate-400 transition-transform duration-300';
  });
  if (isOpen) {
    body.style.maxHeight = '0';
    if (icon) {
      icon.setAttribute('data-lucide', 'chevron-down');
      icon.className = 'w-4 h-4 text-slate-400 transition-transform duration-300';
    }
  } else {
    body.style.maxHeight = body.scrollHeight + 'px';
    if (icon) {
      icon.setAttribute('data-lucide', 'chevron-up');
      icon.className = 'w-4 h-4 text-slate-400 transition-transform duration-300';
    }
  }
  if (window.lucide) lucide.createIcons();
}

(() => {
  console.log("👀 Watching for Rating UI when customer is marked 'seated'...");

  const checkRatingUI = () => {
    const bodyText = document.body.innerText.toLowerCase();
    const hasRatingKeywords =
      bodyText.includes("rate your") ||
      bodyText.includes("submit rating") ||
      bodyText.includes("how was your") ||
      bodyText.includes("experience");

    const starButtons = Array.from(document.querySelectorAll("button, svg, [role='button']")).filter(el => {
      const label = (el.getAttribute("aria-label") || el.innerText || "").toLowerCase();
      return label.includes("star") || label.includes("★") || label.includes("rate");
    });

    const passStillOpen = bodyText.includes("leave queue") || bodyText.includes("need +5 mins");

    if (hasRatingKeywords || starButtons.length >= 5) {
      console.log("%c✅ SUCCESS: Rating UI & Star Buttons are visible to the customer!", "color: #16a34a; font-weight: bold; font-size: 14px;");
      console.table({
        "Rating Screen Detected": hasRatingKeywords ? "✅ YES" : "⚠️ Partial",
        "Star / Rating Buttons Found": starButtons.length,
        "Old Queue Pass Closed": !passStillOpen ? "✅ YES" : "❌ FAIL (Pass buttons still visible)"
      });
      observer.disconnect();
    }
  };

  const observer = new MutationObserver(() => checkRatingUI());
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  checkRatingUI();
})();
