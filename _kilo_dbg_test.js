const { JSDOM } = require('jsdom');
const fs = require('fs');

async function test() {
  const html = fs.readFileSync('index.html','utf8');
  const js = fs.readFileSync('app.js','utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;

  // Simulate an empty-queue restaurant with NO manual override
  const fakeStats = {
    queue_count: 0,
    total_waiting_people: 0,
    estimated_wait_mins: 0,
    algorithmic_wait_mins: 0,
    has_manual_override: false,
    is_queue_open: true
  };
  const fakeRel = { score: 96, grade: 'A+', avg_variance_mins: 1.9, verdict: 'Highly Reliable', badge_color: 'emerald', total_verified_checkins: 31, on_time_pct: 77, early_pct: 16, slight_late_pct: 7, severe_late_pct: 0, recent_reviews: [] };
  const fakeRest = { id: 'rest-2', name: 'Test Cafe', address: 'Mumbai', live_stats: fakeStats, reliability: fakeRel };

  window.fetch = async (u) => {
    const uStr = String(u);
    if (uStr.includes('/api/host/queue/rest-2')) {
      return { ok: true, status: 200, json: async () => ({ restaurant: fakeRest, live_stats: fakeStats, reliability: fakeRel, queue: [] }) };
    }
    if (uStr.includes('/api/host/verify-password')) {
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    if (uStr.includes('/api/restaurants')) {
      return { ok: true, status: 200, json: async () => ({ restaurants: [fakeRest], global_announcement: '' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  window.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  window.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  window.history.replaceState = () => {};
  window.lucide = { createIcons() {} };
  window.Notification = { permission: 'denied' };

  const scriptEl = window.document.createElement('script');
  scriptEl.textContent = js;
  window.document.head.appendChild(scriptEl);

  await new Promise(r => setTimeout(r, 2000));

  // Now simulate owner unlocking rest-2
  window.currentHostVenueId = 'rest-2';
  window.verifiedHostPasswords = {};
  window.saveHostPassword = (id,pwd)=>{window.verifiedHostPasswords[id]=pwd;};
  window.getSavedHostPassword = (id)=>window.verifiedHostPasswords[id]||'';
  window.hostData = null;

  // Call renderUnlockedHostStand directly
  await window.renderUnlockedHostStand('rest-2', 'rameshwaram123');

  const waitEl = window.document.getElementById('hostKpiWait');
  const scoreEl = window.document.getElementById('hostKpiScore');
  const partiesEl = window.document.getElementById('hostKpiParties');
  const warnEl = window.document.getElementById('hostOverrideWarning');
  console.log('hostKpiWait:', JSON.stringify(waitEl ? waitEl.textContent : null));
  console.log('hostKpiScore:', JSON.stringify(scoreEl ? scoreEl.textContent : null));
  console.log('hostKpiParties:', JSON.stringify(partiesEl ? partiesEl.textContent : null));
  console.log('warning hidden:', warnEl ? warnEl.classList.contains('hidden') : null);
  console.log('hostData.queue:', JSON.stringify(window.hostData && window.hostData.queue));
  console.log('hostData.live_stats:', JSON.stringify(window.hostData && window.hostData.live_stats));
}
test().catch(e=>{console.error('TEST ERROR', e); process.exit(1);});
