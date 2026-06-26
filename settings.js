/**
 * settings.js — Settings page logic (PWA version of options.js)
 */

// ── IndexedDB helpers ─────────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('classReminder', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}
async function dbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function dbSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULTS = {
  clientId:  '',
  keywords:  'lecture, tutorial, lab, practical',
  remind1:   30,
  remind2:   10,
  autoclose: 30,
};

// ── Redirect URI (this is what goes into Google Cloud Console) ────────────────
function getAppRedirectUri() {
  // Point to index.html regardless of which page we're on
  return new URL('index.html', window.location.href).href.split('?')[0].split('#')[0];
}

// ── Load saved settings ───────────────────────────────────────────────────────
async function loadSettings() {
  const saved = (await dbGet('settings')) || {};
  document.getElementById('clientId').value  = saved.clientId  ?? DEFAULTS.clientId;
  document.getElementById('keywords').value  = saved.keywords  ?? DEFAULTS.keywords;
  document.getElementById('remind1').value   = saved.remind1   ?? DEFAULTS.remind1;
  document.getElementById('remind2').value   = saved.remind2   ?? DEFAULTS.remind2;
  document.getElementById('autoclose').value = saved.autoclose ?? DEFAULTS.autoclose;
}

// ── Save ──────────────────────────────────────────────────────────────────────
document.getElementById('saveBtn').addEventListener('click', async () => {
  // Strip accidental http:// or https:// prefix from Client ID
  const rawId = document.getElementById('clientId').value.trim();
  const cleanId = rawId.replace(/^https?:\/\//i, '').trim();
  document.getElementById('clientId').value = cleanId;

  const settings = {
    clientId:  cleanId,
    keywords:  document.getElementById('keywords').value.trim(),
    remind1:   parseInt(document.getElementById('remind1').value, 10)   || DEFAULTS.remind1,
    remind2:   parseInt(document.getElementById('remind2').value, 10)   || DEFAULTS.remind2,
    autoclose: parseInt(document.getElementById('autoclose').value, 10) || DEFAULTS.autoclose,
  };

  const keywordList = settings.keywords
    .split(',').map(k => k.trim().toLowerCase()).filter(Boolean);

  await dbSet('settings', settings);
  await dbSet('keywordList', keywordList);

  showToast('✓ Settings saved');
});

// ── Reset ─────────────────────────────────────────────────────────────────────
document.getElementById('resetBtn').addEventListener('click', async () => {
  await dbSet('settings', { ...DEFAULTS });
  await dbSet('keywordList', DEFAULTS.keywords.split(',').map(k => k.trim().toLowerCase()));
  await loadSettings();
  showToast('↺ Reset to defaults');
});

// ── Back ──────────────────────────────────────────────────────────────────────
document.getElementById('back-btn').addEventListener('click', () => {
  window.location.href = 'index.html';
});

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.getElementById('redirectUri').textContent = getAppRedirectUri();
loadSettings();
// Apply saved contrast mode
dbGet('settings').then(s => { if (s?.contrastMode) document.body.classList.add('contrast'); });
