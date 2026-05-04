'use strict';

const { WebcastPushConnection } = require('tiktok-live-connector');
const fetch = require('node-fetch');
const fs    = require('fs');

// ── Config ─────────────────────────────────────────────────────────────────

const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || 'fsblaker';
const BASE_URL        = (process.env.QUEUE_API_URL || 'https://siegequeue.com').replace(/\/api.*$/, '');
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD || process.env.ADMIN_SECRET || '';
const DATA_FILE       = './users.json';
const POLL_MS         = 5_000; // how often to fetch live queue state

// ── Persistent user store ───────────────────────────────────────────────────
// Saves: tiktokId → { name, queued }
// "name"   = their saved Ubisoft/game name
// "queued" = whether we believe they are currently in the queue

function loadUsers() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('Could not load users.json:', e.message); }
  return {};
}

function saveUsers(users) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2)); }
  catch (e) { console.error('Could not save users.json:', e.message); }
}

function getRecord(users, tiktokId) {
  const r = users[tiktokId];
  if (!r) return { name: '', queued: false };
  if (typeof r === 'string') return { name: r, queued: false }; // legacy
  return { name: r.name || '', queued: Boolean(r.queued) };
}

function setRecord(users, tiktokId, record) {
  users[tiktokId] = { name: record.name || '', queued: Boolean(record.queued) };
  saveUsers(users);
}

// ── Name sanitiser ──────────────────────────────────────────────────────────

function cleanName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_.\-]/g, '')
    .slice(0, 20);
}

// ── API helpers ─────────────────────────────────────────────────────────────

function authHeaders() {
  return { 'Content-Type': 'application/json', 'x-admin-password': ADMIN_PASSWORD };
}

/** Fetch the live queue state — returns { queue, playing } or null on failure. */
async function fetchQueueState() {
  try {
    const r = await fetch(`${BASE_URL}/api/state`, { timeout: 8_000 });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/**
 * Add a player to the queue via the admin endpoint.
 * Returns: 'added' | 'already' | 'error'
 */
async function addToQueue(name) {
  const clean = cleanName(name);
  if (!clean) return 'error';
  if (!ADMIN_PASSWORD) { console.error('ADMIN_PASSWORD not set'); return 'error'; }

  try {
    const r = await fetch(`${BASE_URL}/api/admin/add-to-queue`, {
      method : 'POST',
      headers: authHeaders(),
      body   : JSON.stringify({ name: clean }),
      timeout: 8_000,
    });
    const text = await r.text();
    if (r.ok) return 'added';
    if (text.includes('already') || text.includes('taken') || text.includes('queue')) return 'already';
    console.error(`addToQueue failed for ${clean}: ${r.status} ${text}`);
    return 'error';
  } catch (e) {
    console.error('addToQueue error:', e.message);
    return 'error';
  }
}

// ── Live queue state (in-memory, refreshed by poller) ─────────────────────

let liveQueue   = [];   // array of { name, position (1-based) }
let livePlaying = [];   // array of { name }

function isInQueue(name) {
  const n = name.toLowerCase();
  return liveQueue.some(p => p.name.toLowerCase() === n);
}

function isPlaying(name) {
  const n = name.toLowerCase();
  return livePlaying.some(p => p.name.toLowerCase() === n);
}

function getPosition(name) {
  const n   = name.toLowerCase();
  const idx = liveQueue.findIndex(p => p.name.toLowerCase() === n);
  return idx === -1 ? null : idx + 1; // 1-based
}

// ── Queue state poller ──────────────────────────────────────────────────────
// Polls the server every POLL_MS and:
//   1. Updates liveQueue / livePlaying
//   2. Detects players who were kicked/removed and resets their queued flag
//      so they can rejoin with !q

const users = loadUsers();

async function pollQueue() {
  const state = await fetchQueueState();
  if (!state) return;

  liveQueue   = (state.queue   || []).map((p, i) => ({ name: p.name, position: i + 1 }));
  livePlaying = (state.playing || []).map(p => ({ name: p.name }));

  // Build a set of everyone currently in the queue or playing
  const activeNames = new Set([
    ...liveQueue.map(p => p.name.toLowerCase()),
    ...livePlaying.map(p => p.name.toLowerCase()),
  ]);

  // Any TikTok user we thought was queued but is no longer in the queue → reset
  let changed = false;
  for (const [tiktokId, raw] of Object.entries(users)) {
    const record = getRecord(users, tiktokId);
    if (record.queued && record.name && !activeNames.has(record.name.toLowerCase())) {
      console.log(`↩  ${tiktokId} (${record.name}) was removed from queue — unlocked for rejoin`);
      users[tiktokId] = { name: record.name, queued: false };
      changed = true;
    }
  }
  if (changed) saveUsers(users);
}

setInterval(pollQueue, POLL_MS);
pollQueue(); // run immediately on startup

// ── TikTok bot ─────────────────────────────────────────────────────────────

const tiktok = new WebcastPushConnection(TIKTOK_USERNAME);

function connectTikTok() {
  tiktok.connect()
    .then(() => {
      console.log(`✓ Connected to TikTok Live @${TIKTOK_USERNAME}`);
      console.log('  Commands: !q YourName  |  !q  |  !p');
    })
    .catch(err => {
      console.error('✗ TikTok connect failed:', err.message);
      console.log('  Retrying in 30 seconds…');
      setTimeout(connectTikTok, 30_000);
    });
}

connectTikTok();

// ── Chat handler ────────────────────────────────────────────────────────────

tiktok.on('chat', async (data) => {
  const tiktokId = data.uniqueId;
  const msg      = (data.comment || '').trim();
  const lower    = msg.toLowerCase();

  // ── !c — clear saved name ──────────────────────────────────────────────
  if (lower === '!c') {
    const record = getRecord(users, tiktokId);
    if (!record.name) {
      console.log(`[!c] ${tiktokId} has no saved name to clear`);
      return;
    }
    console.log(`[!c] ${tiktokId} cleared saved name "${record.name}"`);
    setRecord(users, tiktokId, { name: '', queued: false });
    return;
  }

  // ── !p — check queue position ──────────────────────────────────────────
  if (lower === '!p') {
    const record = getRecord(users, tiktokId);

    if (!record.name) {
      console.log(`[!p] ${tiktokId} has no saved name — needs to use !q YourName first`);
      return;
    }

    if (isPlaying(record.name)) {
      console.log(`[!p] ${tiktokId} (${record.name}) → Currently playing!`);
      return;
    }

    const pos = getPosition(record.name);
    if (pos !== null) {
      const total = liveQueue.length;
      console.log(`[!p] ${tiktokId} (${record.name}) → Position ${pos} of ${total}`);
    } else {
      if (record.queued) {
        setRecord(users, tiktokId, { name: record.name, queued: false });
      }
      console.log(`[!p] ${tiktokId} (${record.name}) → Not in queue. Type !q to join.`);
    }
    return;
  }

  // ── !q — join / rejoin queue ───────────────────────────────────────────
  if (!lower.startsWith('!q')) return;

  const typedName = msg.split(/\s+/).slice(1).join('').trim();
  const record    = getRecord(users, tiktokId);

  // ── Case 1: player is actively in the queue right now ─────────────────
  if (record.queued && record.name && isInQueue(record.name)) {
    const pos = getPosition(record.name);
    console.log(`[!q] ${tiktokId} already in queue as ${record.name} (pos ${pos})`);
    return;
  }

  // ── Case 2: they provided a new name ──────────────────────────────────
  if (typedName) {
    const clean = cleanName(typedName);
    if (!clean) {
      console.log(`[!q] ${tiktokId} typed invalid name: "${typedName}"`);
      return;
    }

    // Check if this name is already taken by someone else in the live queue
    if (isNameTakenByOther(clean, tiktokId)) {
      console.log(`[!q] ✗ ${tiktokId} → name "${clean}" is already in the queue`);
      return;
    }

    // Save the new name regardless so future !q / !p works
    setRecord(users, tiktokId, { name: clean, queued: false });
    console.log(`[!q] ${tiktokId} saved name: ${clean}`);

    const result = await addToQueue(clean);
    if (result === 'added') {
      setRecord(users, tiktokId, { name: clean, queued: true });
      const pos = getPosition(clean);
      console.log(`[!q] ✓ ${tiktokId} → ${clean} added to queue${pos ? ` (pos ${pos})` : ''}`);
    } else if (result === 'already') {
      setRecord(users, tiktokId, { name: clean, queued: true });
      console.log(`[!q] ${tiktokId} → ${clean} already in queue`);
    } else {
      console.log(`[!q] ✗ ${tiktokId} → could not add ${clean} to queue`);
    }
    return;
  }

  // ── Case 3: !q with no name — use saved name ──────────────────────────
  if (record.name) {
    // Check if someone else already has this name in the queue
    if (isNameTakenByOther(record.name, tiktokId)) {
      console.log(`[!q] ✗ ${tiktokId} → name "${record.name}" is already taken. Use !c to clear and pick a new name.`);
      return;
    }

    const result = await addToQueue(record.name);
    if (result === 'added') {
      setRecord(users, tiktokId, { name: record.name, queued: true });
      const pos = getPosition(record.name);
      console.log(`[!q] ✓ ${tiktokId} → ${record.name} rejoined queue${pos ? ` (pos ${pos})` : ''}`);
    } else if (result === 'already') {
      setRecord(users, tiktokId, { name: record.name, queued: true });
      console.log(`[!q] ${tiktokId} → ${record.name} already in queue`);
    } else {
      console.log(`[!q] ✗ ${tiktokId} → could not add ${record.name} to queue`);
    }
    return;
  }

  // ── Case 4: no name at all ─────────────────────────────────────────────
  console.log(`[!q] ${tiktokId} has no saved name — needs !q YourName`);
});

// ── Connection events ───────────────────────────────────────────────────────

tiktok.on('disconnected', () => {
  console.log('TikTok disconnected — reconnecting in 15 seconds…');
  setTimeout(connectTikTok, 15_000);
});

tiktok.on('error', err => {
  console.error('TikTok error:', err.message || err);
});
