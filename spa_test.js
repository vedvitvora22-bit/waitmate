const { JSDOM } = require('jsdom');
const fs = require('fs');

async function test(url) {
  const html = fs.readFileSync('/Users/vedvitvora/Downloads/waitmate final/waitmate/index.html','utf8');
  const js = fs.readFileSync('/Users/vedvitvora/Downloads/waitmate final/waitmate/app.js','utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url, pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = async (u) => {
    const uStr = String(u);
    if (uStr.includes('/api/restaurants')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({restaurants:[], global_announcement:''}), json: async () => ({restaurants:[], global_announcement:''}) };
    }
    if (uStr.includes('/api/founder/verify-password')) {
      return { ok: false, status: 401, text: async () => JSON.stringify({error:'Incorrect Founder Master Password.'}), json: async () => ({error:'Incorrect Founder Master Password.'}) };
    }
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
  };
  window.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  window.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  window.history.replaceState = () => {};
  window.lucide = { createIcons() {} };
  // expose debug
  window.__dbg = { url, path: window.location.pathname, search: window.location.search };
  // inject app.js as inline script so DOMContentLoaded fires naturally
  const scriptEl = window.document.createElement('script');
  scriptEl.textContent = js;
  window.document.head.appendChild(scriptEl);
  await new Promise(r => setTimeout(r, 1500));
  const modal = window.document.getElementById('founderLoginModal');
  const visible = modal && !modal.classList.contains('hidden');
  console.log(url, '-> path:', window.location.pathname, '| modal visible:', visible);
}

(async () => {
  await test('http://localhost:8080/founder');
  await test('http://localhost:8080/?founder=1');
  await test('http://localhost:8080/');
})();
