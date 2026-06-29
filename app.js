/**
 * app.js — PWA main logic
 * Replaces: background.js + popup.js + reminder.js (Chrome extension)
 */

// ═════════════════════════════════════════════════════════════════════════════
// IndexedDB helpers
// ═════════════════════════════════════════════════════════════════════════════

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
async function dbRemove(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Constants
// ═════════════════════════════════════════════════════════════════════════════

const KEYWORDS_DEFAULT = ['lecture', 'tutorial', 'lab', 'practical'];
const LOOK_AHEAD_HRS   = 12;
const CALENDAR_API     = 'https://www.googleapis.com/calendar/v3';

// ═════════════════════════════════════════════════════════════════════════════
// Firestore (appointment reminders)
// ═════════════════════════════════════════════════════════════════════════════

const FIRESTORE_API = 'https://firestore.googleapis.com/v1/projects/appointmentappstud/databases/(default)/documents';

// Fetch approved upcoming appointments for a given email using Firestore REST API
async function fetchAppointments(email, targetDate = null) {
  try {
    let timeMin, timeMax;
    if (targetDate) {
      const start = new Date(targetDate); start.setHours(0, 0, 0, 0);
      const end   = new Date(targetDate); end.setHours(23, 59, 59, 999);
      timeMin = start.toISOString();
      timeMax = end.toISOString();
    } else {
      const now = new Date();
      timeMin = now.toISOString();
      timeMax = new Date(now.getTime() + LOOK_AHEAD_HRS * 3_600_000).toISOString();
    }

    // Firestore structured query via REST
    const body = {
      structuredQuery: {
        from: [{ collectionId: 'appointments' }],
        where: {
          fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'approved' } },
        },
      },
    };

    const res = await fetch(`${FIRESTORE_API}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) return [];
    const rows = await res.json();

    const appts = [];
    for (const row of rows) {
      if (!row.document) continue;
      const f = row.document.fields || {};
      const startTs = f.start?.timestampValue;
      const endTs   = f.end?.timestampValue;
      if (!startTs) continue;

      const startDate = new Date(startTs);
      const endDate   = endTs ? new Date(endTs) : null;
      const startIso  = startDate.toISOString();

      // Filter to the requested time window
      if (startIso < timeMin || startIso > timeMax) continue;

      appts.push({
        _isAppointment: true,
        id:       row.document.name.split('/').pop(),
        summary:  f.type?.stringValue || 'Appointment',
        start:    { dateTime: startIso },
        end:      endDate ? { dateTime: endDate.toISOString() } : undefined,
        location: f.location?.stringValue || '',
        description: f.notes?.stringValue || '',
        refCode:  f.refCode?.stringValue || '',
        apptType: f.type?.stringValue || '',
      });
    }
    return appts;
  } catch (e) {
    console.warn('[App] Appointments fetch failed:', e.message);
    return [];
  }
}

// Get the signed-in Google account email from the People API
async function getGoogleEmail(token) {
  const cached = await dbGet('userEmail');
  if (cached) return cached;
  try {
    const res  = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.email) { await dbSet('userEmail', data.email); return data.email; }
  } catch (_) {}
  return null;
}

const THEMES = {
  lecture:   { icon: '📚', iconBg: 'rgba(37,99,235,.25)',  badgeBg: '#2563eb', accent: '#60a5fa' },
  tutorial:  { icon: '✏️', iconBg: 'rgba(22,163,74,.25)',  badgeBg: '#16a34a', accent: '#4ade80' },
  lab:       { icon: '🔬', iconBg: 'rgba(147,51,234,.25)', badgeBg: '#7e22ce', accent: '#c084fc' },
  practical: { icon: '🧪', iconBg: 'rgba(234,88,12,.25)',  badgeBg: '#ea580c', accent: '#fb923c' },
  default:   { icon: '🎓', iconBg: 'rgba(180,83,9,.25)',   badgeBg: '#b45309', accent: '#fbbf24' },
};

// ═════════════════════════════════════════════════════════════════════════════
// UI helpers
// ═════════════════════════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);

function showView(name) {
  ['setup-view', 'auth-view', 'classes-view', 'detail-view'].forEach(v => {
    $(v).classList.toggle('hidden', v !== name);
  });
  const isClasses = (name === 'classes-view');
  $('footer').style.display = isClasses ? 'flex' : 'none';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function classType(title) {
  const tl = (title || '').toLowerCase();
  if (tl.includes('tutorial'))  return 'tutorial';
  if (tl.includes('lab'))       return 'lab';
  if (tl.includes('practical')) return 'practical';
  if (tl.includes('lecture'))   return 'lecture';
  return 'default';
}

// ═════════════════════════════════════════════════════════════════════════════
// Auth — OAuth implicit flow via redirect
// ═════════════════════════════════════════════════════════════════════════════

function getRedirectUri() {
  // Always use the root path — avoids index.html vs / mismatch on GitHub Pages
  const url = window.location.href.split('#')[0].split('?')[0];
  return url.endsWith('/index.html') ? url.slice(0, -'index.html'.length) : url;
}

async function handleOAuthCallback() {
  const hash = window.location.hash.slice(1);
  if (!hash.includes('access_token')) return false;

  const params     = new URLSearchParams(hash);
  const token      = params.get('access_token');
  const expiresIn  = parseInt(params.get('expires_in') || '3600', 10);
  const expiresAt  = Date.now() + expiresIn * 1000;

  await dbSet('tokenData', { access_token: token, expiresAt });
  history.replaceState(null, '', window.location.pathname);
  return true;
}

async function signIn() {
  const settings = (await dbGet('settings')) || {};
  const clientId = (settings.clientId || '').replace(/^https?:\/\//i, '').trim();

  if (!clientId) {
    $('auth-note').textContent = 'Set your Client ID in Settings first.';
    return;
  }
  if (!clientId.endsWith('.apps.googleusercontent.com')) {
    $('auth-note').textContent = `Invalid Client ID: "${clientId}" — must end with .apps.googleusercontent.com`;
    return;
  }

  // Show what is being used so user can verify
  $('auth-note').style.color = '#60a5fa';
  $('auth-note').textContent = `Using: ${clientId.slice(0, 20)}...${clientId.slice(-30)}`;
  await new Promise(r => setTimeout(r, 2500));
  const params = new URLSearchParams({
    response_type: 'token',
    client_id:     clientId,
    redirect_uri:  getRedirectUri(),
    scope:         'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email',
    prompt:        'consent',
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function signOut() {
  await dbRemove('tokenData');
  await dbRemove('firedReminders');
  await dbRemove('userEmail');
  clearPolling();
  $('auth-note').textContent = '';
  $('status-label').textContent = 'Not signed in';
  showView('auth-view');
}

async function getToken() {
  const tokenData = await dbGet('tokenData');
  if (!tokenData) return null;
  if (Date.now() >= (tokenData.expiresAt || 0) - 60_000) return null;
  return tokenData.access_token;
}

// ═════════════════════════════════════════════════════════════════════════════
// Date navigation
// ═════════════════════════════════════════════════════════════════════════════

let _viewDate = new Date();
_viewDate.setHours(0, 0, 0, 0);

function viewDateOffset() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((_viewDate - today) / 86_400_000);
}

function updateDateNav() {
  const offset = viewDateOffset();
  const labels  = { '-1': 'Yesterday', '0': 'Today', '1': 'Tomorrow' };
  const secLabels = { '-1': "YESTERDAY'S CLASSES", '0': "TODAY'S CLASSES", '1': "TOMORROW'S CLASSES" };

  $('date-label').textContent = labels[offset] ??
    _viewDate.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

  $('date-sub').textContent = offset === 0 ? '' :
    _viewDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  $('section-label').textContent = secLabels[offset] ??
    _viewDate.toLocaleDateString([], { month: 'long', day: 'numeric' }).toUpperCase() + ' CLASSES';

  // Disable prev beyond 7 days back, next beyond 7 days forward
  $('prev-date-btn').disabled = offset <= -7;
  $('next-date-btn').disabled = offset >= 7;
}

// ═════════════════════════════════════════════════════════════════════════════
// Calendar
// ═════════════════════════════════════════════════════════════════════════════

async function fetchEvents(token, targetDate = null) {
  const keywordList = await dbGet('keywordList');
  const keywords    = keywordList?.length ? keywordList : KEYWORDS_DEFAULT;

  let timeMin, timeMax;
  if (targetDate) {
    const start = new Date(targetDate); start.setHours(0, 0, 0, 0);
    const end   = new Date(targetDate); end.setHours(23, 59, 59, 999);
    timeMin = start.toISOString();
    timeMax = end.toISOString();
  } else {
    const now = new Date();
    timeMin = now.toISOString();
    timeMax = new Date(now.getTime() + LOOK_AHEAD_HRS * 3_600_000).toISOString();
  }

  const url = `${CALENDAR_API}/calendars/primary/events?` + new URLSearchParams({
    timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '50',
  });

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return (data.items || []).filter(ev => {
    const t = (ev.summary || '').toLowerCase();
    return keywords.some(kw => t.includes(kw));
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Reminder logic (foreground polling)
// ═════════════════════════════════════════════════════════════════════════════

let _pollInterval = null;

function clearPolling() {
  if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
}

function startPolling() {
  clearPolling();
  checkAndRemind();
  _pollInterval = setInterval(checkAndRemind, 60_000);
}

async function checkAndRemind() {
  const token = await getToken();
  if (!token) return;

  const settings = (await dbGet('settings')) || {};
  const remindAt = [settings.remind1 ?? 30, settings.remind2 ?? 10].filter(Boolean);

  let events;
  try {
    const email = await getGoogleEmail(token);
    const [classEvents, apptEvents] = await Promise.all([
      fetchEvents(token),
      email ? fetchAppointments(email) : Promise.resolve([]),
    ]);
    events = [...classEvents, ...apptEvents];
  } catch (e) {
    console.warn('[App] Calendar fetch failed:', e.message);
    return;
  }

  const now = Date.now();
  const firedReminders = (await dbGet('firedReminders')) || {};

  const cutoff = now - 2 * 3_600_000;
  for (const key of Object.keys(firedReminders)) {
    if (firedReminders[key] < cutoff) delete firedReminders[key];
  }

  let changed = false;
  for (const ev of events) {
    const startRaw = ev.start?.dateTime;
    if (!startRaw) continue;
    const minsUntil = (new Date(startRaw).getTime() - now) / 60_000;

    for (const remindMin of remindAt) {
      const key = `${ev.id}_${remindMin}`;
      if (minsUntil >= remindMin - 0.5 && minsUntil < remindMin + 2 && !firedReminders[key]) {
        firedReminders[key] = now;
        changed = true;
        const reminder = {
          title:    ev.summary || 'Class',
          start:    startRaw,
          location: ev.location || '',
          minsLeft: Math.round(minsUntil),
        };
        await dbSet('pendingReminder', reminder);
        await fireReminder(ev, Math.round(minsUntil), reminder);
      }
    }
  }

  if (changed) await dbSet('firedReminders', firedReminders);
}

async function fireReminder(ev, minsLeft, reminderData) {
  // System notification via service worker
  if ('serviceWorker' in navigator && Notification.permission === 'granted') {
    try {
      const reg  = await navigator.serviceWorker.ready;
      const title = ev.summary || 'Class';
      const body  = `Starts in ${minsLeft} min${ev.location ? ' · ' + ev.location : ''}`;
      reg.showNotification(`⏰ ${title}`, {
        body,
        icon:               'icons/icon128.png',
        badge:              'icons/icon48.png',
        tag:                `${ev.id}_${minsLeft}`,
        data:               reminderData,
        vibrate:            [200, 100, 200],
        requireInteraction: minsLeft <= 10,
      });
    } catch (_) {}
  }

  // In-app overlay
  showReminderOverlay(reminderData);
}

// ═════════════════════════════════════════════════════════════════════════════
// Reminder overlay
// ═════════════════════════════════════════════════════════════════════════════

let _overlayAcIv = null;
let _overlayCdIv = null;

function showReminderOverlay(reminder) {
  if (!reminder) return;
  const { title, start, location, minsLeft } = reminder;

  const type  = classType(title);
  const theme = THEMES[type] || THEMES.default;

  // Apply theme via CSS variables
  const card = $('overlay-card');
  card.style.setProperty('--ov-icon-bg',  theme.iconBg);
  card.style.setProperty('--ov-badge-bg', theme.badgeBg);
  card.style.setProperty('--ov-accent',   theme.accent);

  $('overlay-icon').textContent  = theme.icon;
  $('overlay-badge').textContent = type === 'default' ? 'REMINDER' : type.toUpperCase() + ' REMINDER';
  $('overlay-title').textContent = title;

  if (start) {
    const d = new Date(start);
    $('overlay-time').textContent = d.toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    $('overlay-time-row').classList.remove('hidden');
  } else {
    $('overlay-time-row').classList.add('hidden');
  }

  if (location) {
    $('overlay-loc').textContent = location;
    $('overlay-loc-row').classList.remove('hidden');
  } else {
    $('overlay-loc-row').classList.add('hidden');
  }

  // Countdown
  let totalSecs = minsLeft * 60;
  const startSecs = totalSecs;
  clearInterval(_overlayCdIv);
  function updateCd() {
    if (totalSecs <= 0) {
      $('overlay-countdown').innerHTML = '0<small> min</small>';
      $('overlay-progress').style.width = '0%';
      return;
    }
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    $('overlay-countdown').innerHTML = `${m}<small> min ${String(s).padStart(2, '0')}s</small>`;
    $('overlay-progress').style.width = `${(totalSecs / startSecs) * 100}%`;
    totalSecs--;
  }
  updateCd();
  _overlayCdIv = setInterval(updateCd, 1000);

  // Auto-close
  dbGet('settings').then(s => {
    let ac = (s?.autoclose ?? 30);
    $('overlay-autotimer').textContent = ac;
    clearInterval(_overlayAcIv);
    _overlayAcIv = setInterval(() => {
      ac--;
      $('overlay-autotimer').textContent = ac;
      if (ac <= 0) closeReminderOverlay();
    }, 1000);
  });

  $('overlay').classList.remove('hidden');
}

function closeReminderOverlay() {
  clearInterval(_overlayAcIv);
  clearInterval(_overlayCdIv);
  $('overlay').classList.add('hidden');
  dbRemove('pendingReminder');
}

// ═════════════════════════════════════════════════════════════════════════════
// Classes list
// ═════════════════════════════════════════════════════════════════════════════

let _badgeInterval = null;

async function loadClasses(token, targetDate = null) {
  const list = $('classes-list');
  list.innerHTML = '<div class="loading">Loading...</div>';
  $('no-classes').classList.add('hidden');
  updateDateNav();

  try {
    const email = await getGoogleEmail(token);
    const [classEvents, apptEvents] = await Promise.all([
      fetchEvents(token, targetDate),
      email ? fetchAppointments(email, targetDate) : Promise.resolve([]),
    ]);

    // Merge and sort by start time
    const events = [...classEvents, ...apptEvents].sort((a, b) => {
      const aT = a.start?.dateTime ? new Date(a.start.dateTime) : 0;
      const bT = b.start?.dateTime ? new Date(b.start.dateTime) : 0;
      return aT - bT;
    });

    list.innerHTML = '';

    if (events.length === 0) {
      $('no-classes').classList.remove('hidden');
      return;
    }

    const now = new Date();
    events.forEach(ev => {
      const title    = ev.summary || 'Class';
      const startRaw = ev.start?.dateTime;
      const loc      = ev.location || '';
      const type     = classType(title);

      let timeStr = '';
      if (startRaw) {
        const d = new Date(startRaw);
        timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (d.toDateString() !== now.toDateString()) {
          timeStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + timeStr;
        }
      }

      const isPast = startRaw && new Date(startRaw) < new Date();
      const badgeHtml = startRaw
        ? isPast ? `<span class="badge past-badge">Done</span>`
                 : `<span class="badge" data-start="${startRaw}"></span>`
        : '';

      const card = document.createElement('div');
      if (ev._isAppointment) {
        card.className = `class-card appointment${isPast ? ' past' : ''}`;
        card.innerHTML = `
          <div class="card-dot" style="background:#0891b2"></div>
          <div style="flex:1;min-width:0">
            <div class="card-title">📅 ${escapeHtml(title)}${badgeHtml}</div>
            ${timeStr ? `<div class="card-time">🕐 ${timeStr}</div>` : ''}
            ${loc     ? `<div class="card-loc">📍 ${escapeHtml(loc)}</div>` : ''}
            <div class="card-appt-tag">APPOINTMENT</div>
          </div>
          <div class="card-chevron">›</div>`;
      } else {
        card.className = `class-card ${type}${isPast ? ' past' : ''}`;
        card.innerHTML = `
          <div class="card-dot"></div>
          <div style="flex:1;min-width:0">
            <div class="card-title">${escapeHtml(title)}${badgeHtml}</div>
            ${timeStr ? `<div class="card-time">🕐 ${timeStr}</div>` : ''}
            ${loc      ? `<div class="card-loc">📍 ${escapeHtml(loc)}</div>` : ''}
          </div>
          <div class="card-chevron">›</div>`;
      }
      card.addEventListener('click', () => showDetail(ev));
      list.appendChild(card);
    });

    if (_badgeInterval) clearInterval(_badgeInterval);
    updateBadges();
    _badgeInterval = setInterval(updateBadges, 1000);

  } catch (e) {
    list.innerHTML = `<div class="error">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function updateBadges() {
  document.querySelectorAll('.badge[data-start]').forEach(el => {
    const secsUntil = Math.round((new Date(el.dataset.start) - Date.now()) / 1000);
    let label, soon;
    if (secsUntil <= 0) {
      label = 'NOW'; soon = true;
    } else if (secsUntil < 3600) {
      const m = Math.floor(secsUntil / 60), s = secsUntil % 60;
      label = `${m}m ${String(s).padStart(2, '0')}s`;
      soon  = secsUntil < 600;
    } else {
      const h = Math.floor(secsUntil / 3600);
      const m = Math.floor((secsUntil % 3600) / 60);
      label = `${h}h ${m}m`;
      soon  = false;
    }
    el.textContent = label;
    el.className   = soon ? 'badge soon' : 'badge';
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Detail view
// ═════════════════════════════════════════════════════════════════════════════

function showDetail(ev) {
  const title = ev._isAppointment ? (ev.apptType || ev.summary || 'Appointment') : (ev.summary || 'Class');
  const type  = ev._isAppointment ? 'appointment' : classType(title);
  const theme = ev._isAppointment
    ? { icon: '📅', iconBg: 'rgba(8,145,178,.25)', badgeBg: '#0891b2', accent: '#22d3ee' }
    : (THEMES[type] || THEMES.lecture);
  const now   = new Date();

  $('detail-icon').textContent  = theme.icon;
  $('detail-badge').textContent = ev._isAppointment ? 'APPOINTMENT' : type.toUpperCase();
  $('detail-badge').className   = `detail-badge ${ev._isAppointment ? 'appointment' : type}`;
  $('detail-title').textContent = title;

  const startRaw = ev.start?.dateTime;
  if (startRaw) {
    const d       = new Date(startRaw);
    const sameDay = d.toDateString() === now.toDateString();
    $('detail-time').textContent = sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric',
                                hour: '2-digit', minute: '2-digit' });
    $('detail-time-row').classList.remove('hidden');
  } else {
    $('detail-time-row').classList.add('hidden');
  }

  if (startRaw) {
    const minsUntil = Math.round((new Date(startRaw) - now) / 60_000);
    if (minsUntil <= 0)      $('detail-countdown').textContent = 'Started';
    else if (minsUntil < 60) $('detail-countdown').textContent = `In ${minsUntil} min`;
    else {
      const h = Math.floor(minsUntil / 60), m = minsUntil % 60;
      $('detail-countdown').textContent = `In ${h}h ${m > 0 ? m + 'm' : ''}`.trim();
    }
    $('detail-countdown-row').classList.remove('hidden');
  } else {
    $('detail-countdown-row').classList.add('hidden');
  }

  if (ev.location) {
    $('detail-loc').textContent = ev.location;
    $('detail-loc-row').classList.remove('hidden');
  } else {
    $('detail-loc-row').classList.add('hidden');
  }

  if (ev.description) {
    $('detail-desc').textContent = ev.description.replace(/<[^>]*>/g, '').trim();
    $('detail-desc-row').classList.remove('hidden');
  } else {
    $('detail-desc-row').classList.add('hidden');
  }

  $('detail-preview-btn').onclick = async () => {
    const minsLeft = startRaw
      ? Math.max(0, Math.round((new Date(startRaw) - Date.now()) / 60_000))
      : 0;
    const reminder = { title, start: startRaw || '', location: ev.location || '', minsLeft };
    await dbSet('pendingReminder', reminder);
    showReminderOverlay(reminder);
  };

  showView('detail-view');
}

// ═════════════════════════════════════════════════════════════════════════════
// Contrast mode
// ═════════════════════════════════════════════════════════════════════════════

async function loadContrastMode() {
  const settings = (await dbGet('settings')) || {};
  applyContrast(!!settings.contrastMode);
}

function applyContrast(on) {
  document.body.classList.toggle('contrast', on);
  const btn = $('contrast-btn');
  if (!btn) return;
  btn.textContent = on ? '🌙' : '☀';
  btn.title = on ? 'Switch to Dark Mode' : 'Switch to Light Mode';
}

async function toggleContrast() {
  const on = document.body.classList.toggle('contrast');
  applyContrast(on);
  const settings = (await dbGet('settings')) || {};
  settings.contrastMode = on;
  await dbSet('settings', settings);
}

// ═════════════════════════════════════════════════════════════════════════════
// Notifications
// ═════════════════════════════════════════════════════════════════════════════

async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  const result = await Notification.requestPermission();
  if (result === 'granted') $('notif-banner').classList.add('hidden');
}

function updateNotifBanner() {
  if (!('Notification' in window) || Notification.permission === 'granted') {
    $('notif-banner').classList.add('hidden');
  } else {
    $('notif-banner').classList.remove('hidden');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Service worker registration
// ═════════════════════════════════════════════════════════════════════════════

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');

    if ('periodicSync' in reg) {
      try {
        const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
        if (perm.state === 'granted') {
          await reg.periodicSync.register('check-calendar', { minInterval: 60_000 });
        }
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[App] SW registration failed:', e);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// App init
// ═════════════════════════════════════════════════════════════════════════════

async function init() {
  await handleOAuthCallback();

  const settings  = (await dbGet('settings')) || {};
  const tokenData = await dbGet('tokenData');

  if (!settings.clientId) {
    $('status-label').textContent = 'Setup required';
    showView('setup-view');
    $('footer').style.display = 'none';
    return;
  }

  if (!tokenData) {
    $('status-label').textContent = 'Not signed in';
    showView('auth-view');
    $('footer').style.display = 'none';
    return;
  }

  if (Date.now() >= (tokenData.expiresAt || 0) - 60_000) {
    $('status-label').textContent = 'Session expired';
    $('auth-note').textContent    = 'Please sign in again.';
    showView('auth-view');
    $('footer').style.display = 'none';
    return;
  }

  $('status-label').textContent = 'Active';
  showView('classes-view');
  updateNotifBanner();

  await loadClasses(tokenData.access_token, _viewDate);
  startPolling();

  // Show any pending reminder (e.g. from SW notification tap)
  const pending = await dbGet('pendingReminder');
  if (pending) showReminderOverlay(pending);
}

// ═════════════════════════════════════════════════════════════════════════════
// Bootstrap
// ═════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  await loadContrastMode();
  await registerSW();
  await init();

  $('signin-btn').addEventListener('click', signIn);
  $('signout-btn').addEventListener('click', signOut);
  $('back-btn').addEventListener('click', () => showView('classes-view'));
  $('settings-btn').addEventListener('click', () => { window.location.href = 'settings.html'; });
  $('goto-settings-btn').addEventListener('click', () => { window.location.href = 'settings.html'; });

  $('prev-date-btn').addEventListener('click', async () => {
    _viewDate.setDate(_viewDate.getDate() - 1);
    const token = await getToken();
    if (token) await loadClasses(token, _viewDate);
  });

  $('next-date-btn').addEventListener('click', async () => {
    _viewDate.setDate(_viewDate.getDate() + 1);
    const token = await getToken();
    if (token) await loadClasses(token, _viewDate);
  });

  $('check-btn').addEventListener('click', async () => {
    $('check-btn').textContent = 'Checking…';
    await checkAndRemind();
    const token = await getToken();
    if (token) await loadClasses(token, _viewDate);
    $('check-btn').textContent = 'Check now';
  });

  $('test-btn').addEventListener('click', async () => {
    const reminder = {
      title:    'Test Lecture — Preview',
      start:    new Date(Date.now() + 10 * 60_000).toISOString(),
      location: 'Room A101',
      minsLeft: 10,
    };
    await dbSet('pendingReminder', reminder);
    showReminderOverlay(reminder);
  });

  $('contrast-btn').addEventListener('click', toggleContrast);
  $('overlay-dismiss-btn').addEventListener('click', closeReminderOverlay);

  $('notif-enable-btn').addEventListener('click', requestNotificationPermission);

  // Re-check when app comes back to foreground
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) return;
    const token = await getToken();
    if (token) {
      await loadClasses(token, _viewDate);
      await checkAndRemind();
    }
    const pending = await dbGet('pendingReminder');
    if (pending && $('overlay').classList.contains('hidden')) {
      showReminderOverlay(pending);
    }
  });
});
