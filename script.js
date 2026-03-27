/* ===================================
   SpeedCheck – Speed Test JavaScript
   =================================== */

// ---- State ----
let isTesting = false;

// ---- DOM refs ----
const btnStart       = document.getElementById('btn-start');
const speedValue     = document.getElementById('speed-value');
const speedUnit      = document.getElementById('speed-unit');
const speedLabel     = document.getElementById('speed-label');
const needleContainer= document.getElementById('needle-container');
const gaugeArc       = document.getElementById('gauge-arc');
const progressWrapper= document.getElementById('progress-wrapper');
const progressFill   = document.getElementById('progress-fill');
const progressText   = document.getElementById('progress-text');
const resultsCard    = document.getElementById('results-card');
const phasePing      = document.getElementById('phase-ping');
const phaseDownload  = document.getElementById('phase-download');
const phaseUpload    = document.getElementById('phase-upload');
const valPing        = document.getElementById('val-ping');
const valDownload    = document.getElementById('val-download');
const valUpload      = document.getElementById('val-upload');
const rPing          = document.getElementById('r-ping');
const rDownload      = document.getElementById('r-download');
const rUpload        = document.getElementById('r-upload');
const speedRating    = document.getElementById('speed-rating');

// ---- Gauge constants ----
// SVG arc length for a semicircle with radius 80 ≈ 251.2
const ARC_LENGTH = 251.2;
// Needle rotates from -90deg (left/slow) to +90deg (right/fast)
// Maps 0–200 Mbps onto -90 to +90 degrees
const MAX_SPEED_MBPS = 200;

function setGauge(mbps) {
  const clamped = Math.min(mbps, MAX_SPEED_MBPS);
  const fraction = clamped / MAX_SPEED_MBPS;
  // Arc: dashoffset goes from ARC_LENGTH (empty) to 0 (full)
  gaugeArc.style.strokeDashoffset = ARC_LENGTH - fraction * ARC_LENGTH;
  // Needle: -90deg = far left (0 Mbps), +90deg = far right (MAX_SPEED_MBPS)
  const deg = -90 + fraction * 180;
  needleContainer.style.transform = `translateX(-50%) rotate(${deg}deg)`;
}

function setSpeedDisplay(value, unit, label) {
  speedValue.textContent = typeof value === 'number' ? value.toFixed(1) : value;
  speedUnit.textContent  = unit;
  speedLabel.textContent = label;
}

function setProgress(percent, text) {
  progressFill.style.width = percent + '%';
  progressText.textContent = text;
}

function setPhaseActive(phaseEl) {
  [phasePing, phaseDownload, phaseUpload].forEach(p => {
    p.classList.remove('active');
  });
  if (phaseEl) phaseEl.classList.add('active');
}

function setPhaseResult(phaseEl, valueEl, text) {
  phaseEl.classList.remove('active');
  phaseEl.classList.add('done');
  valueEl.textContent = text;
}

// ---- Ping measurement ----
// Uses fetch to a small known endpoint and measures RTT
async function measurePing() {
  const urls = [
    'https://www.cloudflare.com/cdn-cgi/trace',
    'https://www.google.com/generate_204',
    'https://httpbin.org/get',
  ];
  const attempts = 5;
  const pings = [];

  for (let i = 0; i < attempts; i++) {
    const url = urls[i % urls.length] + '?_=' + Date.now();
    const t0 = performance.now();
    try {
      await fetch(url, { method: 'GET', cache: 'no-store', mode: 'no-cors' });
    } catch (_) { /* no-cors – the fetch itself still measures timing */ }
    const t1 = performance.now();
    pings.push(t1 - t0);
    await sleep(80);
  }

  // Drop highest outlier
  pings.sort((a, b) => a - b);
  const trimmed = pings.slice(0, pings.length - 1);
  return Math.round(trimmed.reduce((a, b) => a + b, 0) / trimmed.length);
}

// ---- Download measurement ----
// Downloads a ~5MB chunk from a public CDN file and measures throughput
async function measureDownload(onProgress) {
  // Use multiple differently-sized public resources for accuracy
  const testUrls = [
    { url: 'https://speed.cloudflare.com/__down?bytes=5000000', size: 5000000 },
    { url: 'https://proof.ovh.net/files/5Mb.dat', size: 5000000 },
    { url: 'https://httpbin.org/bytes/3000000', size: 3000000 },
  ];

  for (const { url, size } of testUrls) {
    try {
      const result = await downloadTest(url + '&_=' + Date.now(), size, onProgress);
      if (result > 0) return result;
    } catch (_) { /* try next */ }
  }

  // Fallback: generate data client-side (measures JS overhead, not network)
  return 0;
}

function downloadTest(url, expectedBytes, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.timeout = 20000;

    let startTime = null;
    let lastLoaded = 0;
    let lastTime = null;
    const INTERVAL = 200; // ms

    xhr.onprogress = (e) => {
      if (!startTime) {
        startTime = performance.now();
        lastTime = startTime;
        return;
      }
      const now = performance.now();
      if (now - lastTime > INTERVAL) {
        const bytesLoaded = e.loaded - lastLoaded;
        const elapsed = (now - lastTime) / 1000;
        const mbps = (bytesLoaded * 8) / (elapsed * 1_000_000);
        onProgress(Math.max(0, mbps));
        lastLoaded = e.loaded;
        lastTime   = now;
      }
    };

    xhr.onload = () => {
      if (!startTime) { resolve(0); return; }
      const elapsed = (performance.now() - startTime) / 1000;
      const bytes = xhr.response ? xhr.response.byteLength : expectedBytes;
      resolve((bytes * 8) / (elapsed * 1_000_000));
    };

    xhr.onerror = () => reject(new Error('Download failed'));
    xhr.ontimeout = () => reject(new Error('Download timeout'));
    xhr.send();
  });
}

// ---- Upload measurement ----
async function measureUpload(onProgress) {
  const MB = 1024 * 1024;
  const size = 2 * MB; // 2MB payload
  const data = new Uint8Array(size);
  // Fill with random-ish pattern to prevent compression
  for (let i = 0; i < size; i++) data[i] = (i * 137) & 0xff;
  const blob = new Blob([data]);

  const uploadUrls = [
    'https://speed.cloudflare.com/__up',
    'https://httpbin.org/post',
  ];

  for (const url of uploadUrls) {
    try {
      const result = await uploadTest(url, blob, size, onProgress);
      if (result > 0) return result;
    } catch (_) { /* try next */ }
  }
  return 0;
}

function uploadTest(url, blob, totalBytes, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.timeout = 25000;

    let startTime = null;
    let lastTime = null;
    let lastLoaded = 0;
    const INTERVAL = 200;

    xhr.upload.onprogress = (e) => {
      if (!startTime) {
        startTime = performance.now();
        lastTime = startTime;
        return;
      }
      const now = performance.now();
      if (now - lastTime > INTERVAL) {
        const bytesSent = e.loaded - lastLoaded;
        const elapsed = (now - lastTime) / 1000;
        const mbps = (bytesSent * 8) / (elapsed * 1_000_000);
        onProgress(Math.max(0, mbps));
        lastLoaded = e.loaded;
        lastTime   = now;
      }
    };

    xhr.onload = () => {
      if (!startTime) { resolve(0); return; }
      const elapsed = (performance.now() - startTime) / 1000;
      resolve((totalBytes * 8) / (elapsed * 1_000_000));
    };

    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.ontimeout = () => reject(new Error('Upload timeout'));
    xhr.send(blob);
  });
}

// ---- Animate speed display ----
let animFrame;
function animateSpeed(targetMbps, label) {
  let current = parseFloat(speedValue.textContent) || 0;
  const step = (targetMbps - current) / 12;
  cancelAnimationFrame(animFrame);

  function tick() {
    current += step;
    const display = Math.abs(current - targetMbps) < 0.2 ? targetMbps : current;
    setSpeedDisplay(display, 'Mbps', label);
    setGauge(display);
    if (Math.abs(current - targetMbps) > 0.2) {
      animFrame = requestAnimationFrame(tick);
    }
  }
  tick();
}

// ---- Speed rating ----
function getRating(mbps) {
  if (mbps <= 0)   return { text: '⚠️ Could not measure speed accurately', bg: '#1e1e2e', color: '#7a83a8' };
  if (mbps < 5)    return { text: '🐢 Very Slow – Suitable for basic browsing only', bg: '#1a0e0e', color: '#ff5252' };
  if (mbps < 25)   return { text: '🌐 Good – Handles video streaming & browsing', bg: '#1a1200', color: '#ffb300' };
  if (mbps < 100)  return { text: '🚀 Fast – Great for HD streaming & video calls', bg: '#0e1a12', color: '#00e676' };
  return              { text: '⚡ Ultra Fast – Excellent for everything including 4K!', bg: '#0a1020', color: '#00d4ff' };
}

// ---- Helper ----
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Main test flow ----
async function startTest() {
  if (isTesting) return;
  isTesting = true;

  // Reset UI
  btnStart.disabled = true;
  resultsCard.classList.remove('visible');
  [phasePing, phaseDownload, phaseUpload].forEach(p => p.classList.remove('active', 'done'));
  valPing.textContent = '– ms';
  valDownload.textContent = '– Mbps';
  valUpload.textContent = '– Mbps';
  progressWrapper.classList.add('visible');
  setProgress(0, 'Initializing…');
  setSpeedDisplay('0.0', 'Mbps', 'Starting…');
  setGauge(0);

  await sleep(400);

  /* ---- PHASE 1: Ping ---- */
  setPhaseActive(phasePing);
  setProgress(5, 'Measuring ping…');
  setSpeedDisplay('–', 'ms', 'Ping');

  let ping = 0;
  try {
    ping = await measurePing();
  } catch (_) { ping = 0; }

  setPhaseResult(phasePing, valPing, `${ping} ms`);
  setSpeedDisplay(ping, 'ms', 'Ping');
  setGauge(0);
  setProgress(15, 'Ping done. Starting download test…');
  await sleep(500);

  /* ---- PHASE 2: Download ---- */
  setPhaseActive(phaseDownload);
  setProgress(20, 'Downloading… measuring speed');
  setSpeedDisplay('0.0', 'Mbps', 'Download');

  let downloadMbps = 0;
  let lastDownloadMbps = 0;


  try {
    downloadMbps = await measureDownload((liveMbps) => {
      lastDownloadMbps = liveMbps;
      animateSpeed(liveMbps, 'Download');
      const p = 20 + Math.min(35, (liveMbps / MAX_SPEED_MBPS) * 35);
      setProgress(p, `Downloading… ${liveMbps.toFixed(1)} Mbps`);
    });

    // If live measurement was better than final, use the better value
    if (lastDownloadMbps > downloadMbps && lastDownloadMbps > 0) {
      downloadMbps = lastDownloadMbps;
    }
  } catch (_) { downloadMbps = 0; }

  downloadMbps = Math.round(downloadMbps * 10) / 10;
  animateSpeed(downloadMbps, 'Download');
  setPhaseResult(phaseDownload, valDownload, `${downloadMbps.toFixed(1)} Mbps`);
  setProgress(60, 'Download done. Starting upload test…');
  await sleep(600);

  /* ---- PHASE 3: Upload ---- */
  setPhaseActive(phaseUpload);
  setProgress(65, 'Uploading… measuring speed');
  setSpeedDisplay('0.0', 'Mbps', 'Upload');
  setGauge(0);

  let uploadMbps = 0;
  let lastUploadMbps = 0;

  try {
    uploadMbps = await measureUpload((liveMbps) => {
      lastUploadMbps = liveMbps;
      animateSpeed(liveMbps, 'Upload');
      const p = 65 + Math.min(25, (liveMbps / MAX_SPEED_MBPS) * 25);
      setProgress(p, `Uploading… ${liveMbps.toFixed(1)} Mbps`);
    });
    if (lastUploadMbps > uploadMbps && lastUploadMbps > 0) {
      uploadMbps = lastUploadMbps;
    }
  } catch (_) { uploadMbps = 0; }

  uploadMbps = Math.round(uploadMbps * 10) / 10;
  animateSpeed(uploadMbps, 'Upload');
  setPhaseResult(phaseUpload, valUpload, `${uploadMbps.toFixed(1)} Mbps`);
  setProgress(100, '✅ Test complete!');
  await sleep(700);

  /* ---- Show Results ---- */
  setGauge(downloadMbps);
  animateSpeed(downloadMbps, 'Download');

  rPing.textContent     = ping;
  rDownload.textContent = downloadMbps.toFixed(1);
  rUpload.textContent   = uploadMbps.toFixed(1);

  const rating = getRating(downloadMbps);
  speedRating.textContent       = rating.text;
  speedRating.style.background  = rating.bg;
  speedRating.style.color       = rating.color;
  speedRating.style.borderColor = rating.color + '55';

  progressWrapper.classList.remove('visible');
  resultsCard.classList.add('visible');
  isTesting = false;
  btnStart.disabled = false;
}

function resetTest() {
  resultsCard.classList.remove('visible');
  [phasePing, phaseDownload, phaseUpload].forEach(p => p.classList.remove('active', 'done'));
  valPing.textContent = '– ms';
  valDownload.textContent = '– Mbps';
  valUpload.textContent = '– Mbps';
  setSpeedDisplay('0.0', 'Mbps', 'Ready');
  setGauge(0);
}
