// ==========================================================================
// WaitMate India • QR Code Generator & Printable Standee Downloader
// Encodes the scan-to-join deep link: https://<origin>/?restaurant=<id>&join=1
// Works for the main app URL and every individual restaurant's direct join link.
// ==========================================================================

// Build the QR deep link for a venue (origin-aware: vercel prod or localhost)
function venueJoinUrl(venueId) {
  return `${window.location.origin}/?restaurant=${encodeURIComponent(venueId)}&join=1`;
}

let currentVenueQrId = null;

// Open the printable QR poster modal for a venue
function openVenueQrModal(venueId) {
  currentVenueQrId = venueId;
  const r = allRestaurants.find((x) => x.id === venueId) || fallbackRestaurants.find((x) => x.id === venueId);
  if (!r) return;

  document.getElementById('qrModalVenueName').textContent = r.name;
  document.getElementById('qrModalVenueAddress').textContent = r.address || 'Mumbai, India';

  const logoImg = document.getElementById('qrModalLogo');
  if (logoImg) logoImg.src = '/logo.png?v=2';

  const joinUrl = venueJoinUrl(venueId);
  const directUrlEl = document.getElementById('qrModalDirectUrl');
  if (directUrlEl) directUrlEl.textContent = joinUrl;

  const canvas = document.getElementById('venueQrCodeCanvas');
  canvas.innerHTML = '';
  new QRCode(canvas, {
    text: joinUrl,
    width: 320,
    height: 320,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.H,
    quietZone: 4
  });
  document.getElementById('venueQrModal').classList.remove('hidden');
}

function closeVenueQrModal() {
  document.getElementById('venueQrModal').classList.add('hidden');
  currentVenueQrId = null;
}

function copyVenueQrLink() {
  if (!currentVenueQrId) return;
  const joinUrl = venueJoinUrl(currentVenueQrId);
  navigator.clipboard.writeText(joinUrl).then(() => {
    showToast('Venue QR link copied to clipboard', 'success');
  }).catch(() => {
    showToast('Unable to copy link', 'error');
  });
}

// Export a high-resolution printable QR card (PNG) via HTML5 Canvas
function downloadVenueQrPng() {
  const venueId = currentVenueQrId;
  if (!venueId) return;
  const r = allRestaurants.find((x) => x.id === venueId) || fallbackRestaurants.find((x) => x.id === venueId);
  if (!r) return;

  const joinUrl = venueJoinUrl(venueId);
  const name = r.name || 'Restaurant';
  const address = r.address || 'Mumbai, India';

  const W = 1080;
  const H = 1440;
  const card = document.createElement('canvas');
  card.width = W;
  card.height = H;
  const ctx = card.getContext('2d');

  // Pure white printable card with high-contrast quiet zone
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // WaitMate India header band
  ctx.fillStyle = '#ea580c';
  ctx.fillRect(0, 0, W, 210);

  // Restaurant name (dark on white below the band)
  ctx.fillStyle = '#0f172a';
  ctx.textAlign = 'center';
  ctx.font = 'bold 34px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(name, W / 2, 320);
  ctx.font = '17px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#475569';
  ctx.fillText(address, W / 2, 362);
  ctx.font = '16px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText('Scan to join the live queue • WaitMate India', W / 2, 396);

  // High-resolution QR code (dark modules on pure white quiet zone)
  const qrCanvas = document.createElement('canvas');
  qrCanvas.width = 720;
  qrCanvas.height = 720;
  new QRCode(qrCanvas, {
    text: joinUrl,
    width: 720,
    height: 720,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.H,
    quietZone: 4
  });
  ctx.drawImage(qrCanvas, 180, 440, 720, 720);

  // Footer: deep link + brand line
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 17px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('Scan with Phone Camera to Join Live Queue', W / 2, 1240);
  ctx.font = '14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText(joinUrl, W / 2, 1276);
  ctx.fillText('WaitMate India • Zero waiting, verified seating.', W / 2, 1308);

  // WaitMate logo in header (same-origin; graceful fallback if it fails to load)
  const logo = new Image();
  logo.src = '/logo.png?v=2';
  logo.onload = () => {
    ctx.drawImage(logo, W / 2 - 42, 34, 84, 84);
    finalize();
  };
  logo.onerror = finalize;

  function finalize() {
    const link = document.createElement('a');
    link.download = `waitmate-${venueId}-qr-print.png`;
    link.href = card.toDataURL('image/png');
    link.click();
    showToast('Printable QR poster downloaded', 'success');
  }
}

// Auto-open the Walk-In / Join Queue modal when a customer scans a venue QR:
// https://<origin>/?restaurant=<id>&join=1
function handleScanToJoinDeepLink() {
  try {
    const params = new URLSearchParams(window.location.search);
    const restaurantId = params.get('restaurant');
    const join = params.get('join');
    if (!restaurantId || join !== '1') return;

    const r = allRestaurants.find((x) => x.id === restaurantId) || fallbackRestaurants.find((x) => x.id === restaurantId);
    if (!r) return;

    // Keep the URL clean after handling the deep link
    window.history.replaceState({}, document.title, window.location.pathname);
    openJoinModal(restaurantId, 'walk_in');

    // Scroll the opened modal into view
    const modal = document.getElementById('joinQueueModal');
    if (modal) {
      setTimeout(() => {
        modal.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }, 100);
    }
  } catch (err) {
    console.warn('Scan-to-join deep link failed:', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', handleScanToJoinDeepLink);
} else {
  handleScanToJoinDeepLink();
}
