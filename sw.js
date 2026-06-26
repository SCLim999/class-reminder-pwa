/**
 * sw.js — Service Worker
 * Handles offline caching, periodic background calendar checks, and push notifications.
 */

const CACHE_NAME = 'class-reminder-v1';
const STATIC_ASSETS = [
  './', './index.html', './style.css', './app.js',
  './settings.html', './settings.js',
  './icons/icon48.png', './icons/icon128.png',
];

// ── IndexedDB helpers (mirrored from app.js — SW cannot share modules easily) ──
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

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch (cache-first for static assets only) ───────────────────────────────
self.addEventListener('fetch', event => {
  // Let API calls and HTML page navigations pass through unmodified
  if (event.request.url.includes('googleapis.com')) return;
  if (event.request.mode === 'navigate') return;

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// ── Periodic background sync ──────────────────────────────────────────────────
self.addEventListener('periodicsync', event => {
  if (event.tag === 'check-calendar') {
    event.waitUntil(checkAndRemindSW());
  }
});

// ── Messages from the app ─────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'CHECK_NOW') {
    checkAndRemindSW();
  }
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('./');
    })
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// Core reminder logic (runs in SW context)
// ═════════════════════════════════════════════════════════════════════════════

const KEYWORDS_DEFAULT = ['lecture', 'tutorial', 'lab', 'practical'];
const LOOK_AHEAD_HRS   = 12;
const CALENDAR_API     = 'https://www.googleapis.com/calendar/v3';

async function checkAndRemindSW() {
  const tokenData = await dbGet('tokenData');
  if (!tokenData) return;
  if (Date.now() >= (tokenData.expiresAt || 0) - 60_000) return;

  const settings     = (await dbGet('settings')) || {};
  const keywordList  = await dbGet('keywordList');
  const keywords     = keywordList?.length ? keywordList : KEYWORDS_DEFAULT;
  const remindAt     = [settings.remind1 ?? 30, settings.remind2 ?? 10].filter(Boolean);

  let events;
  try {
    events = await fetchCalendarEventsSW(tokenData.access_token, keywords);
  } catch (e) {
    console.warn('[SW] Calendar fetch failed:', e.message);
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
        await dbSet('pendingReminder', {
          title: ev.summary || 'Class',
          start: startRaw,
          location: ev.location || '',
          minsLeft: Math.round(minsUntil),
        });
        await fireNotificationSW(ev, Math.round(minsUntil));
      }
    }
  }

  if (changed) await dbSet('firedReminders', firedReminders);
}

async function fetchCalendarEventsSW(token, keywords) {
  const now    = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + LOOK_AHEAD_HRS * 3_600_000).toISOString();
  const url = `${CALENDAR_API}/calendars/primary/events?` +
    new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || []).filter(ev => {
    const t = (ev.summary || '').toLowerCase();
    return keywords.some(kw => t.includes(kw));
  });
}

async function fireNotificationSW(ev, minsLeft) {
  const title = ev.summary || 'Class';
  const tl = title.toLowerCase();
  let type = 'Class';
  if (tl.includes('lecture'))   type = 'Lecture';
  else if (tl.includes('tutorial'))  type = 'Tutorial';
  else if (tl.includes('lab'))       type = 'Lab';
  else if (tl.includes('practical')) type = 'Practical';

  const body = `${type} starts in ${minsLeft} minute${minsLeft !== 1 ? 's' : ''}` +
    (ev.location ? ` · ${ev.location}` : '');

  await self.registration.showNotification(`⏰ ${title}`, {
    body,
    icon:             './icons/icon128.png',
    badge:            './icons/icon48.png',
    tag:              `${ev.id}_${minsLeft}`,
    data:             { title, minsLeft, location: ev.location || '', start: ev.start?.dateTime || '' },
    vibrate:          [200, 100, 200],
    requireInteraction: minsLeft <= 10,
  });
}
