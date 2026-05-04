'use strict';

const { WebcastPushConnection } = require('tiktok-live-connector');
const fetch = require('node-fetch');
const fs    = require('fs');

// ── Config ─────────────────────────────────────────────────────────────────

const TIKTOK_USERNAME  = process.env.TIKTOK_USERNAME  || 'fsblaker';
const BASE_URL         = (process.env.QUEUE_API_URL || 'https://siegequeue.com').replace(/\/api.*$/, '');
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD   || process.env.ADMIN_SECRET || '';
const SESSION_ID       = process.env.TIKTOK_SESSION_ID || ''; // ← fix for InitialFetchError
const DATA_FILE        = './users.json';
const POLL_MS          = 5_000;
const COOLDOWN_MS      = 8_000;   // per-user command cooldown (ms)
const MAX_RETRY_MS     = 120_000; // cap reconnect delay at 2 min

// ── Terminal colours ────────────────────────────────────────────────────────

const C = {
  reset  : '\x1b[0m',
  bold   : '\x1b[1m',
  dim    : '\x1b[2m',
  green  : '\x1b[32m',
  yellow : '\x1b[33m',
  cyan   : '\x1b[36m',
  red    : '\x1b[31m',
  magenta: '\x1b[35m',
  blue   : '\x1b[34m',
};

function ts()    { return new Date().toLocaleTimeString(); }
function log(tag, color, ...args) {
  console.log(`${C.dim}[${ts()}]${C.reset} ${color}${tag}${C.reset}`, ...args);
}
const info  = (...a) => log('INFO ', C.cyan,    ...a);
const ok    = (...a) => log('OK   ', C.green,   ...a);
const warn  = (...a) => log('WARN ', C.yellow,  ...a);
const err   = (...a) => log('ERR  ', C.red,     ...a);
const cmd   = (...a) => log('CMD  ', C.magenta, ...a);
const poll  = (...a) => log('POLL ', C.blue,    ...a);

// ── Startup banner ──────────────────────────────────────────────────────────

function printBanner() {
  console.log(`
${C.cyan}${C.bold}╔══════════════════════════════════════════╗
║       TikTok Queue Bot  •  siegequeue    ║
╚══════════════════════════════════════════╝${C.reset}
  User  : ${C.yellow}@${TIKTOK_USERNAME}${C.reset}
  API   : ${C.yellow}${BASE_URL}${C.reset}
  Auth  : ${ADMIN_PASSWORD ? `${C.green}✓ set${C.reset}` : `${C.red}✗ missing${C.reset}`}
  Cookie: ${SESSION_ID     ? `${C.green}✓ set${C.reset}` : `${C.yellow}⚠ not set (may fail if stream is private)${C.reset}`}

  ${C.dim}Commands: !q <name>  •  !q  •  !p  •  !c  •  !help${C.reset}
`);
}

// ── Persistent user store ───────────────────────────────────────────────────

function loadUsers() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { err('Could not load users.json:', e.message); }
  return {};
}

function saveUsers(users) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2)); }
  catch (e) { err('Could not save users.json:', e.message); }
}

function getRecord(users, tiktokId) {
  const r = users[tiktokId];
  if (!r) return { name: '', queued: false };
  if (typeof r === 'string') return { name: r, queued: false }; // legacy migration
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
  if (!ADMIN_PASSWORD) { err('ADMIN_PASSWORD not set — cannot add to queue'); return 'error'; }

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
    err(`addToQueue failed for ${clean}: ${r.status} ${text}`);
    return 'error';
  } catch (e) {
    err('addToQueue network error:', e.message);
    return 'error';
  }
}

// ── Live queue state (refreshed by poller) ─────────────────────────────────

let liveQueue   = [];
let livePlaying = [];
let lastPollOk  = false;

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

/**
 * Returns true if `name` is in the live queue and is NOT owned by `tiktokId`.
 * Prevents two TikTok accounts from fighting over the same game name.
 */
function isNameTakenByOther(name, tiktokId) {
  if (!isInQueue(name)) return false;         // not in queue at all → not taken
  const ownRecord = getRecord(users, tiktokId);
  return ownRecord.name.toLowerCase() !== name.toLowerCase(); // taken by someone else
}

// ── Queue state poller ──────────────────────────────────────────────────────

const users = loadUsers();

async function pollQueue() {
  const state = await fetchQueueState();

  if (!state) {
    if (lastPollOk) warn('Queue API unreachable — will keep retrying…');
    lastPollOk = false;
    return;
  }

  if (!lastPollOk) poll('Queue API back online ✓');
  lastPollOk = true;

  const prevQueue = new Set(liveQueue.map(p => p.name.toLowerCase()));

  liveQueue   = (state.queue   || []).map((p, i) => ({ name: p.name, position: i + 1 }));
  livePlaying = (state.playing || []).map(p => ({ name: p.name }));

  // Log any newly added or removed entries
  const currQueue = new Set(liveQueue.map(p => p.name.toLowerCase()));
  for (const n of currQueue) if (!prevQueue.has(n)) poll(`  + ${n} joined queue`);
  for (const n of prevQueue) if (!currQueue.has(n)) poll(`  - ${n} left queue`);

  // Build set of everyone currently active
  const activeNames = new Set([
    ...liveQueue.map(p => p.name.toLowerCase()),
    ...livePlaying.map(p => p.name.toLowerCase()),
  ]);

  // Reset queued flag for anyone who was removed from the queue server-side
  let changed = false;
  for (const [tiktokId, raw] of Object.entries(users)) {
    const record = getRecord(users, tiktokId);
    if (record.queued && record.name && !activeNames.has(record.name.toLowerCase())) {
      warn(`↩  @${tiktokId} (${record.name}) removed from queue — unlocked for rejoin`);
      users[tiktokId] = { name: record.name, queued: false };
      changed = true;
    }
  }
  if (changed) saveUsers(users);
}

setInterval(pollQueue, POLL_MS);
pollQueue();

// ── Per-user cooldown (anti-spam) ───────────────────────────────────────────

const cooldowns = new Map();

function isOnCooldown(tiktokId) {
  const last = cooldowns.get(tiktokId) || 0;
  return Date.now() - last < COOLDOWN_MS;
}

function setCooldown(tiktokId) {
  cooldowns.set(tiktokId, Date.now());
}

// ── TikTok connection ───────────────────────────────────────────────────────

const tiktokOptions = {
  enableExtendedGiftInfo : true,
  enableWebsocketUpgrade : true,
  requestPollingIntervalMs: 2_000,
  ...(SESSION_ID ? { sessionId: SESSION_ID } : {}),
};

const tiktok = new WebcastPushConnection(TIKTOK_USERNAME, tiktokOptions);

let retryDelay = 15_000;

function connectTikTok() {
  info(`Connecting to @${TIKTOK_USERNAME}…`);
  tiktok.connect()
    .then(state => {
      retryDelay = 15_000; // reset on success
      ok(`Connected to TikTok Live @${TIKTOK_USERNAME}`);
      if (state?.roomId) info(`Room ID: ${state.roomId}`);
    })
    .catch(e => {
      // Honour the retryAfter hint from the library if present
      const hint = e?.exception?.retryAfter ?? e?.retryAfter;
      const delay = hint ? hint * 1_000 : retryDelay;
      retryDelay  = Math.min(retryDelay * 2, MAX_RETRY_MS); // exponential back-off

      err(`TikTok connect failed: ${e.message || e}`);
      if (!SESSION_ID) {
        warn('Tip: set TIKTOK_SESSION_ID env var to your TikTok sessionid cookie.');
        warn('     This is often needed for accounts that are live but returning InitialFetchError.');
      }
      info(`Retrying in ${delay / 1000}s…`);
      setTimeout(connectTikTok, delay);
    });
}

// ── Chat response helper ────────────────────────────────────────────────────
// tiktok-live-connector is read-only — we can't send chat messages back.
// All feedback goes to the console. If you later add a Puppeteer/Playwright
// layer you can swap this out.

function respond(tiktokId, message) {
  // Prefix with @ so it's easy to spot in the log as an "outbound" response
  log('CHAT ←', C.cyan, `@${tiktokId}: ${message}`);
}

// ── Chat handler ────────────────────────────────────────────────────────────

tiktok.on('chat', async (data) => {
  const tiktokId = data.uniqueId;
  const display  = data.nickname || tiktokId;
  const msg      = (data.comment || '').trim();
  const lower    = msg.toLowerCase();

  // Only handle recognised commands
  const isCmd = lower === '!c'
    || lower === '!p'
    || lower === '!help'
    || lower.startsWith('!q');

  if (!isCmd) return;

  // Cooldown check (skip for !help)
  if (lower !== '!help' && isOnCooldown(tiktokId)) {
    cmd(`[cooldown] @${tiktokId} — ignored (${COOLDOWN_MS / 1000}s cooldown)`);
    return;
  }
  setCooldown(tiktokId);

  // ── !help ──────────────────────────────────────────────────────────────
  if (lower === '!help') {
    respond(tiktokId, '!q <name> = join queue | !q = rejoin | !p = check position | !c = clear name');
    cmd(`[!help] @${display}`);
    return;
  }

  // ── !c — clear saved name ──────────────────────────────────────────────
  if (lower === '!c') {
    const record = getRecord(users, tiktokId);
    if (!record.name) {
      respond(tiktokId, 'You have no saved name to clear.');
      cmd(`[!c] @${display} — no saved name`);
      return;
    }
    const old = record.name;
    setRecord(users, tiktokId, { name: '', queued: false });
    respond(tiktokId, `Cleared saved name "${old}". Use !q <name> to set a new one.`);
    cmd(`[!c] @${display} cleared "${old}"`);
    return;
  }

  // ── !p — check queue position ──────────────────────────────────────────
  if (lower === '!p') {
    const record = getRecord(users, tiktokId);

    if (!record.name) {
      respond(tiktokId, 'No saved name. Use !q <YourName> to join the queue.');
      cmd(`[!p] @${display} — no saved name`);
      return;
    }

    if (isPlaying(record.name)) {
      respond(tiktokId, `${record.name} is currently playing! Good luck!`);
      cmd(`[!p] @${display} (${record.name}) → PLAYING`);
      return;
    }

    const pos = getPosition(record.name);
    if (pos !== null) {
      const total = liveQueue.length;
      respond(tiktokId, `${record.name} is #${pos} of ${total} in the queue.`);
      cmd(`[!p] @${display} (${record.name}) → #${pos}/${total}`);
    } else {
      if (record.queued) setRecord(users, tiktokId, { name: record.name, queued: false });
      respond(tiktokId, `${record.name} is not in the queue. Type !q to rejoin.`);
      cmd(`[!p] @${display} (${record.name}) → not in queue`);
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
    respond(tiktokId, `${record.name} is already in queue at #${pos}.`);
    cmd(`[!q] @${display} already queued as ${record.name} (#${pos})`);
    return;
  }

  // ── Case 2: they provided a new name ──────────────────────────────────
  if (typedName) {
    const clean = cleanName(typedName);
    if (!clean) {
      respond(tiktokId, 'Invalid name. Use letters, numbers, _ . - only (max 20 chars).');
      cmd(`[!q] @${display} invalid name: "${typedName}"`);
      return;
    }

    if (isNameTakenByOther(clean, tiktokId)) {
      respond(tiktokId, `"${clean}" is already in the queue. Try a different name.`);
      cmd(`[!q] @${display} ✗ name "${clean}" taken by another user`);
      return;
    }

    // Save new name immediately
    setRecord(users, tiktokId, { name: clean, queued: false });
    cmd(`[!q] @${display} saved name: ${clean}`);

    const result = await addToQueue(clean);
    if (result === 'added') {
      setRecord(users, tiktokId, { name: clean, queued: true });
      const pos = getPosition(clean) || '?';
      respond(tiktokId, `${clean} added to queue! Position: #${pos}`);
      ok(`[!q] @${display} → ${clean} added (#${pos})`);
    } else if (result === 'already') {
      setRecord(users, tiktokId, { name: clean, queued: true });
      respond(tiktokId, `${clean} is already in the queue.`);
      cmd(`[!q] @${display} → ${clean} already in queue`);
    } else {
      respond(tiktokId, `Could not add "${clean}" to the queue. Try again shortly.`);
      err(`[!q] @${display} → could not add ${clean}`);
    }
    return;
  }

  // ── Case 3: !q with no name — use saved name ──────────────────────────
  if (record.name) {
    if (isNameTakenByOther(record.name, tiktokId)) {
      respond(tiktokId, `"${record.name}" is taken. Use !c to clear your name and pick a new one.`);
      cmd(`[!q] @${display} ✗ saved name "${record.name}" taken by another`);
      return;
    }

    const result = await addToQueue(record.name);
    if (result === 'added') {
      setRecord(users, tiktokId, { name: record.name, queued: true });
      const pos = getPosition(record.name) || '?';
      respond(tiktokId, `${record.name} rejoined the queue at #${pos}!`);
      ok(`[!q] @${display} → ${record.name} rejoined (#${pos})`);
    } else if (result === 'already') {
      setRecord(users, tiktokId, { name: record.name, queued: true });
      respond(tiktokId, `${record.name} is already in the queue.`);
      cmd(`[!q] @${display} → ${record.name} already in queue`);
    } else {
      respond(tiktokId, `Could not rejoin queue as "${record.name}". Try again shortly.`);
      err(`[!q] @${display} → could not add ${record.name}`);
    }
    return;
  }

  // ── Case 4: no name at all ─────────────────────────────────────────────
  respond(tiktokId, 'No saved name! Type !q <YourUbisoftName> to join the queue.');
  cmd(`[!q] @${display} — no saved name`);
});

// ── Connection events ───────────────────────────────────────────────────────

tiktok.on('disconnected', () => {
  warn('TikTok disconnected — reconnecting in 15 seconds…');
  retryDelay = 15_000;
  setTimeout(connectTikTok, 15_000);
});

tiktok.on('error', e => {
  err('TikTok stream error:', e.message || JSON.stringify(e));
});

tiktok.on('roomUser', d => {
  if (d?.viewerCount != null) info(`Viewers: ${d.viewerCount}`);
});

// ── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown(signal) {
  warn(`\nReceived ${signal} — saving state and exiting…`);
  saveUsers(users);
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Stats printer (every 5 min) ─────────────────────────────────────────────

setInterval(() => {
  const knownUsers = Object.keys(users).length;
  const queued     = Object.values(users).filter(r => r?.queued).length;
  info(`Stats — known users: ${knownUsers}, queued: ${queued}, live queue length: ${liveQueue.length}`);
}, 5 * 60_000);

// ── Start ───────────────────────────────────────────────────────────────────

printBanner();
connectTikTok();
