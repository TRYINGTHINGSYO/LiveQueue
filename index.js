'use strict';

const { WebcastPushConnection } = require('tiktok-live-connector');
const fs = require('fs');

// Prefer Node 18+/22 built-in fetch. Fall back to node-fetch v2 if present.
let fetchImpl = global.fetch;
try {
  const maybeFetch = require('node-fetch');
  fetchImpl = maybeFetch.default || maybeFetch || fetchImpl;
} catch (_) {
  if (!fetchImpl) throw new Error('No fetch implementation found. Use Node 18+ or install node-fetch@2.');
}

// ── Config ─────────────────────────────────────────────────────────────────
// Env-vars are the baseline defaults.
// fetchBotConfigFromServer() overwrites these at startup and every ~60 s.

function normalizeTikTokUsername(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function parseTikTokUserList(value) {
  return String(value || '')
    .split(',')
    .map(normalizeTikTokUsername)
    .filter(Boolean);
}

function uniqueTikTokUsers(list) {
  return [...new Set(list.map(normalizeTikTokUsername).filter(Boolean))];
}

function getStreamUsers() {
  return uniqueTikTokUsers([TIKTOK_USERNAME, ...EXTRA_TIKTOK_USERNAMES]);
}

let TIKTOK_USERNAME  = normalizeTikTokUsername(process.env.TIKTOK_USERNAME || 'fsblaker');
let EXTRA_TIKTOK_USERNAMES = parseTikTokUserList(
  process.env.EXTRA_TIKTOK_USERNAMES || process.env.TIKTOK_USERNAME_2 || 'barbariandino'
);
const BASE_URL       = (process.env.QUEUE_API_URL || 'https://siegequeue.com').replace(/\/api.*$/, '').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_SECRET || '';
const SESSION_ID     = process.env.TIKTOK_SESSION_ID || '';
const DATA_FILE      = process.env.USER_DATA_FILE || './users.json';

// These are mutable — overwritten when server config is fetched.
let POLL_MS        = Number(process.env.POLL_MS      || 5_000);
let COOLDOWN_MS    = Number(process.env.COOLDOWN_MS  || 8_000);
let MAX_RETRY_MS   = Number(process.env.MAX_RETRY_MS || 120_000);

// Optional blocklists — also overwritten by server config.
let BANNED_TIKTOK_USERS = new Set(
  String(process.env.BANNED_TIKTOK_USERS || '')
    .split(',').map(s => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean),
);
let BLOCKED_EXACT_NAMES = new Set(
  String(process.env.BLOCKED_NAMES || '')
    .split(',').map(s => normalizeForFilter(s)).filter(Boolean),
);

// ── Terminal colours ────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m', magenta: '\x1b[35m', blue: '\x1b[34m',
};

function ts() { return new Date().toLocaleTimeString(); }
function log(tag, color, ...args) { console.log(`${C.dim}[${ts()}]${C.reset} ${color}${tag}${C.reset}`, ...args); }
const info = (...a) => log('INFO ', C.cyan, ...a);
const ok   = (...a) => log('OK   ', C.green, ...a);
const warn = (...a) => log('WARN ', C.yellow, ...a);
const err  = (...a) => log('ERR  ', C.red, ...a);
const cmd  = (...a) => log('CMD  ', C.magenta, ...a);
const poll = (...a) => log('POLL ', C.blue, ...a);

function printBanner() {
  console.log(`
${C.cyan}${C.bold}╔══════════════════════════════════════════╗
║       TikTok Queue Bot  •  siegequeue    ║
╚══════════════════════════════════════════╝${C.reset}
  Users : ${C.yellow}${getStreamUsers().map(u => '@' + u).join(' + ')}${C.reset}
  API   : ${C.yellow}${BASE_URL}${C.reset}
  Auth  : ${ADMIN_PASSWORD ? `${C.green}✓ set${C.reset}` : `${C.red}✗ missing${C.reset}`}
  Cookie: ${SESSION_ID ? `${C.green}✓ set${C.reset}` : `${C.yellow}⚠ not set (may fail if stream is private)${C.reset}`}
  Sync  : ${C.green}Admin panel config sync ENABLED${C.reset}

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
  if (typeof r === 'string') return { name: r, queued: false };
  return { name: r.name || '', queued: Boolean(r.queued) };
}

function setRecord(users, tiktokId, record) {
  users[tiktokId] = { name: record.name || '', queued: Boolean(record.queued) };
  saveUsers(users);
}

// ── Name sanitiser and filters ──────────────────────────────────────────────

function normalizeForFilter(raw) {
  return String(raw || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[@$]/g, 'a')
    .replace(/[!1|]/g, 'i')
    .replace(/[0]/g, 'o')
    .replace(/[3]/g, 'e')
    .replace(/[4]/g, 'a')
    .replace(/[5]/g, 's')
    .replace(/[7]/g, 't')
    .replace(/[^a-z0-9]/g, '');
}

const RESERVED_NAMES = new Set(['admin', 'owner', 'host', 'mod', 'moderator', 'null', 'undefined', 'everyone']);
const BAD_NAME_PATTERNS = [
  /n+i+g+g+/, /f+a+g+/, /r+e+t+a+r+d+/, /k+i+l+l+y+o+u+/, /k+y+s+/, /h+i+t+l+e+r+/, /n+a+z+i+/,
  /c+u+n+t+/, /b+i+t+c+h+/, /p+u+s+s+y+/, /d+i+c+k+/, /c+o+c+k+/, /s+h+i+t+/, /f+u+c+k+/,
];

function validateName(rawName) {
  const raw = String(rawName || '').trim();
  if (!raw) return { ok: false, reason: 'Type one name after !q. Example: !q Blake' };
  if (/\s/.test(raw)) return { ok: false, reason: 'Use one name only. No spaces. Example: !q Blake' };
  const clean = raw.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 20);
  if (clean.length < 3) return { ok: false, reason: 'Name must be at least 3 characters.' };
  if (!/[a-zA-Z]/.test(clean)) return { ok: false, reason: 'Name must include at least one letter.' };
  if (clean !== raw) return { ok: false, reason: 'Use letters, numbers, _ . - only. No weird symbols.' };
  const normalized = normalizeForFilter(clean);
  if (RESERVED_NAMES.has(normalized)) return { ok: false, reason: 'That name is reserved. Pick a different name.' };
  if (BLOCKED_EXACT_NAMES.has(normalized)) return { ok: false, reason: 'That name is blocked. Pick a different name.' };
  if (BAD_NAME_PATTERNS.some(re => re.test(normalized))) return { ok: false, reason: 'That name is not allowed. Pick a clean name.' };
  return { ok: true, name: clean };
}

function cleanName(raw) {
  const result = validateName(raw);
  return result.ok ? result.name : '';
}

// ── API helpers ─────────────────────────────────────────────────────────────

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-admin-password': ADMIN_PASSWORD,
    'x-admin-secret': ADMIN_PASSWORD,
    Authorization: ADMIN_PASSWORD ? `Bearer ${ADMIN_PASSWORD}` : '',
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8_000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchQueueState() {
  try {
    const r = await fetchWithTimeout(`${BASE_URL}/api/state`, {}, 8_000);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function bodyLooksAlready(text) {
  const t = String(text || '').toLowerCase();
  return t.includes('already') || t.includes('taken') || t.includes('duplicate') || t.includes('in queue') || t.includes('playing');
}

async function addToQueue(name) {
  const valid = validateName(name);
  if (!valid.ok) return 'error';
  const clean = valid.name;
  if (!ADMIN_PASSWORD) { err('ADMIN_PASSWORD not set — cannot add to queue'); return 'error'; }

  const attempts = [
    { url: `${BASE_URL}/api/admin/add-to-queue`, body: { name: clean } },
    { url: `${BASE_URL}/api/admin/add`,          body: { name: clean } },
  ];

  for (const attempt of attempts) {
    try {
      const r = await fetchWithTimeout(attempt.url, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify(attempt.body),
      }, 8_000);
      const text = await r.text();
      if (r.ok) return 'added';
      if (r.status === 404) continue;
      if (r.status === 409 || bodyLooksAlready(text)) return 'already';
      err(`addToQueue failed at ${attempt.url} for ${clean}: ${r.status} ${text}`);
      return 'error';
    } catch (e) {
      err(`addToQueue network error at ${attempt.url}:`, e.message);
    }
  }
  err('No working admin add endpoint found.');
  return 'error';
}

// ── Server config sync ──────────────────────────────────────────────────────

let _pollIntervalHandle = null;
let _lastConfigUsername = TIKTOK_USERNAME;

/**
 * Fetch bot config from the server admin panel.
 * Applies mutable settings live; reconnects TikTok if username changed.
 */
async function fetchBotConfigFromServer() {
  if (!ADMIN_PASSWORD) return; // nothing to sync without auth
  try {
    const r = await fetchWithTimeout(`${BASE_URL}/api/bot/config`, { headers: authHeaders() }, 6_000);
    if (!r.ok) {
      if (r.status !== 404) warn(`[sync] /api/bot/config returned ${r.status} — skipping`);
      return;
    }
    const cfg = await r.json();

    // Apply mutable settings
    if (Number.isFinite(cfg.cooldownMs) && cfg.cooldownMs >= 1_000) {
      if (cfg.cooldownMs !== COOLDOWN_MS) {
        info(`[sync] cooldownMs updated: ${COOLDOWN_MS} → ${cfg.cooldownMs}`);
        COOLDOWN_MS = cfg.cooldownMs;
      }
    }
    if (Number.isFinite(cfg.maxRetryMs) && cfg.maxRetryMs >= 5_000) {
      MAX_RETRY_MS = cfg.maxRetryMs;
    }

    // Banned users
    if (Array.isArray(cfg.bannedUsers)) {
      BANNED_TIKTOK_USERS = new Set(cfg.bannedUsers.map(normalizeTikTokUsername).filter(Boolean));
    }

    // Blocked names (server stores raw; we normalize here)
    if (Array.isArray(cfg.blockedNames)) {
      BLOCKED_EXACT_NAMES = new Set(cfg.blockedNames.map(n => normalizeForFilter(n)).filter(Boolean));
    }

    // Poll interval — restart interval if changed
    if (Number.isFinite(cfg.pollMs) && cfg.pollMs >= 1_000 && cfg.pollMs !== POLL_MS) {
      info(`[sync] pollMs updated: ${POLL_MS} → ${cfg.pollMs}`);
      POLL_MS = cfg.pollMs;
      if (_pollIntervalHandle) {
        clearInterval(_pollIntervalHandle);
        _pollIntervalHandle = setInterval(pollQueue, POLL_MS);
        info(`[sync] Queue poll interval restarted at ${POLL_MS}ms`);
      }
    }

    // Primary username from admin panel — reconnect if changed.
    // Extra usernames still come from env: TIKTOK_USERNAME_2 or EXTRA_TIKTOK_USERNAMES.
    if (typeof cfg.username === 'string' && normalizeTikTokUsername(cfg.username) && normalizeTikTokUsername(cfg.username) !== _lastConfigUsername) {
      const newUsername = normalizeTikTokUsername(cfg.username);
      info(`[sync] Primary TikTok username changed: ${_lastConfigUsername} → ${newUsername}`);
      TIKTOK_USERNAME = newUsername;
      _lastConfigUsername = newUsername;
      rebuildTikTokConnections();
      connectAllTikTok();
    }
  } catch (e) {
    if (!e.message?.includes('aborted')) warn(`[sync] Config fetch error: ${e.message}`);
  }
}

/**
 * Post the bot's current live status to the server.
 */
async function postBotStatusToServer(extra = {}) {
  if (!ADMIN_PASSWORD) return;
  const knownUsers = Object.keys(users).length;
  const queuedRecords = Object.values(users).filter(r => r?.queued).length;
  try {
    await fetchWithTimeout(`${BASE_URL}/api/bot/status`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        connected    : extra.connected    ?? botConnected,
        connecting   : extra.connecting   ?? false,
        error        : extra.error        ?? null,
        viewers      : extra.viewers      ?? currentViewers,
        roomId       : extra.roomId       ?? currentRoomId,
        lastActivity : new Date().toISOString(),
        processUptime: Math.floor(process.uptime()),
        knownUsers,
        queuedRecords,
        liveQueueLen : liveQueue.length,
      }),
    }, 5_000);
  } catch (_) { /* non-critical */ }
}

// ── Live queue state (refreshed by poller) ─────────────────────────────────

let liveQueue   = [];
let livePlaying = [];
let lastPollOk  = false;

// Bot connection state (used by status reporter)
let botConnected   = false;
let currentViewers = 0;
let currentRoomId  = null;

function playerName(p) {
  return String(p?.name || p?.playerName || p?.username || p || '').trim();
}
function isInQueue(name) {
  const n = String(name || '').toLowerCase();
  return Boolean(n) && liveQueue.some(p => p.name.toLowerCase() === n);
}
function isPlaying(name) {
  const n = String(name || '').toLowerCase();
  return Boolean(n) && livePlaying.some(p => p.name.toLowerCase() === n);
}
function getPosition(name) {
  const n = String(name || '').toLowerCase();
  const idx = liveQueue.findIndex(p => p.name.toLowerCase() === n);
  return idx === -1 ? null : idx + 1;
}
function ownNameIsActive(record) {
  return Boolean(record.name) && (record.queued || isInQueue(record.name) || isPlaying(record.name));
}
function isNameTakenByOther(name, tiktokId) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (!isInQueue(name) && !isPlaying(name)) return false;
  const ownRecord = getRecord(users, tiktokId);
  return ownRecord.name.toLowerCase() !== n;
}

// ── Queue state poller ──────────────────────────────────────────────────────

const users = loadUsers();

async function refreshLiveQueueFromServer() {
  const state = await fetchQueueState();
  if (!state) return false;
  const rawQueue   = Array.isArray(state.queue)   ? state.queue   : [];
  const rawPlaying = Array.isArray(state.playing) ? state.playing : [];
  liveQueue   = rawQueue.map((p, i) => ({ name: playerName(p), position: i + 1 })).filter(p => p.name);
  livePlaying = rawPlaying.map(p => ({ name: playerName(p) })).filter(p => p.name);
  return true;
}

async function pollQueue() {
  const prevQueue = new Set(liveQueue.map(p => p.name.toLowerCase()));
  const okState   = await refreshLiveQueueFromServer();

  if (!okState) {
    if (lastPollOk) warn('Queue API unreachable — will keep retrying…');
    lastPollOk = false;
    return;
  }
  if (!lastPollOk) poll('Queue API back online ✓');
  lastPollOk = true;

  const currQueue = new Set(liveQueue.map(p => p.name.toLowerCase()));
  for (const n of currQueue) if (!prevQueue.has(n)) poll(`  + ${n} joined queue`);
  for (const n of prevQueue) if (!currQueue.has(n)) poll(`  - ${n} left queue`);

  const activeNames = new Set([
    ...liveQueue.map(p => p.name.toLowerCase()),
    ...livePlaying.map(p => p.name.toLowerCase()),
  ]);

  let changed = false;
  for (const [tiktokId, raw] of Object.entries(users)) {
    const record = getRecord(users, tiktokId);
    if (record.queued && record.name && !activeNames.has(record.name.toLowerCase())) {
      warn(`↩  @${tiktokId} (${record.name}) removed from queue/playing — unlocked for rejoin`);
      users[tiktokId] = { name: record.name, queued: false };
      changed = true;
    }
  }
  if (changed) saveUsers(users);
}

_pollIntervalHandle = setInterval(pollQueue, POLL_MS);
pollQueue();

// ── Per-user cooldown (anti-spam) ───────────────────────────────────────────

const cooldowns = new Map();
function isOnCooldown(tiktokId) { return Date.now() - (cooldowns.get(tiktokId) || 0) < COOLDOWN_MS; }
function setCooldown(tiktokId)  { cooldowns.set(tiktokId, Date.now()); }

// ── TikTok connections ──────────────────────────────────────────────────────
// Supports more than one live at the same time.
// Example env:
//   TIKTOK_USERNAME=fsblaker
//   TIKTOK_USERNAME_2=barbariandino
// or:
//   EXTRA_TIKTOK_USERNAMES=barbariandino,anotherstreamer

function buildTikTokOptions() {
  return {
    enableExtendedGiftInfo  : false,
    enableWebsocketUpgrade  : true,
    requestPollingIntervalMs: 2_000,
    ...(SESSION_ID ? { sessionId: SESSION_ID } : {}),
  };
}

const streams = new Map();

function updateAggregateBotState() {
  const list = [...streams.values()];
  botConnected = list.some(s => s.connected);
  currentViewers = list.reduce((sum, s) => sum + Number(s.currentViewers || 0), 0);
  const roomIds = list.filter(s => s.currentRoomId).map(s => `${s.username}:${s.currentRoomId}`);
  currentRoomId = roomIds.length ? roomIds.join(', ') : null;
}

function ensureStream(username) {
  username = normalizeTikTokUsername(username);
  if (!username) return null;
  if (streams.has(username)) return streams.get(username);

  const conn = new WebcastPushConnection(username, buildTikTokOptions());
  const entry = {
    username,
    conn,
    retryDelay: 15_000,
    reconnectTimer: null,
    connecting: false,
    connected: false,
    currentViewers: 0,
    currentRoomId: null,
  };
  streams.set(username, entry);
  registerTikTokEvents(entry);
  return entry;
}

function disconnectStream(username) {
  const entry = streams.get(username);
  if (!entry) return;
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  try { entry.conn.disconnect(); } catch (_) {}
  streams.delete(username);
  updateAggregateBotState();
}

function rebuildTikTokConnections() {
  const wanted = new Set(getStreamUsers());

  for (const username of [...streams.keys()]) {
    if (!wanted.has(username)) {
      warn(`[sync] Removing TikTok connection @${username}`);
      disconnectStream(username);
    }
  }

  for (const username of wanted) {
    if (!streams.has(username)) {
      info(`[sync] Adding TikTok connection @${username}`);
      ensureStream(username);
    }
  }

  updateAggregateBotState();
}

function scheduleReconnect(username, delayMs) {
  const entry = ensureStream(username);
  if (!entry) return;
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    connectTikTok(username);
  }, delayMs);
}

function connectTikTok(username) {
  const entry = ensureStream(username);
  if (!entry || entry.connecting) return;

  entry.connecting = true;
  info(`Connecting to @${entry.username}…`);
  updateAggregateBotState();
  postBotStatusToServer({ connecting: true, connected: botConnected });

  entry.conn.connect()
    .then(state => {
      entry.connecting = false;
      entry.retryDelay = 15_000;
      entry.connected = true;
      entry.currentRoomId = state?.roomId ? String(state.roomId) : null;
      ok(`Connected to TikTok Live @${entry.username}`);
      if (state?.roomId) info(`@${entry.username} Room ID: ${state.roomId}`);
      updateAggregateBotState();
      postBotStatusToServer({ connected: botConnected, connecting: false, roomId: currentRoomId });
    })
    .catch(e => {
      entry.connecting = false;
      entry.connected = false;
      const hint = e?.exception?.retryAfter ?? e?.retryAfter;
      const delay = hint ? hint * 1_000 : entry.retryDelay;
      entry.retryDelay = Math.min(entry.retryDelay * 2, MAX_RETRY_MS);
      updateAggregateBotState();
      err(`TikTok connect failed for @${entry.username}: ${e.message || e}`);
      if (!SESSION_ID) warn('Tip: set TIKTOK_SESSION_ID env var to your TikTok sessionid cookie.');
      info(`Retrying @${entry.username} in ${delay / 1000}s…`);
      postBotStatusToServer({ connected: botConnected, connecting: false, error: `@${entry.username}: ${String(e.message || e)}` });
      scheduleReconnect(entry.username, delay);
    });
}

function connectAllTikTok() {
  rebuildTikTokConnections();
  for (const username of getStreamUsers()) connectTikTok(username);
}

// tiktok-live-connector is read-only; this logs what the bot would say.
function respond(tiktokId, message, sourceUsername = '') {
  log('CHAT ←', C.cyan, `${sourceUsername ? '[' + sourceUsername + '] ' : ''}@${tiktokId}: ${message}`);
}

// ── Chat handler ────────────────────────────────────────────────────────────

function registerTikTokEvents(entry) {
  const tiktok = entry.conn;
  const sourceUsername = entry.username;

  tiktok.on('chat', async (data) => {
    const tiktokId = normalizeTikTokUsername(data.uniqueId || '');
    const display  = data.nickname || data.uniqueId || tiktokId;
    const msg      = String(data.comment || '').trim();
    const lower    = msg.toLowerCase();

    const isCmd = lower === '!c' || lower === '!p' || lower === '!help' || lower === '!queue' || lower.startsWith('!q');
    if (!isCmd) return;

    if (BANNED_TIKTOK_USERS.has(tiktokId)) {
      cmd(`[${sourceUsername}] [blocked] @${display} tried command: ${msg}`);
      return;
    }

    if (lower !== '!help' && isOnCooldown(tiktokId)) {
      cmd(`[${sourceUsername}] [cooldown] @${tiktokId} — ignored (${COOLDOWN_MS / 1000}s cooldown)`);
      return;
    }
    setCooldown(tiktokId);

    if (lower === '!help') {
      respond(tiktokId, '!q <name> = join queue | !q = rejoin | !p = position | !c = clear saved name', sourceUsername);
      cmd(`[${sourceUsername}] [!help] @${display}`);
      return;
    }

    if (lower === '!c') {
      const record = getRecord(users, tiktokId);
      if (!record.name) {
        respond(tiktokId, 'You have no saved name to clear.', sourceUsername);
        cmd(`[${sourceUsername}] [!c] @${display} — no saved name`);
        return;
      }
      if (ownNameIsActive(record)) {
        respond(tiktokId, `${record.name} is still active in queue/playing. Ask the host to remove you first.`, sourceUsername);
        cmd(`[${sourceUsername}] [!c] @${display} blocked clear while active as ${record.name}`);
        return;
      }
      const old = record.name;
      setRecord(users, tiktokId, { name: '', queued: false });
      respond(tiktokId, `Cleared saved name "${old}". Use !q <name> to set a new one.`, sourceUsername);
      cmd(`[${sourceUsername}] [!c] @${display} cleared "${old}"`);
      return;
    }

    if (lower === '!p' || lower === '!queue') {
      const record = getRecord(users, tiktokId);
      if (!record.name) {
        respond(tiktokId, 'No saved name. Use !q <YourName> to join the queue.', sourceUsername);
        cmd(`[${sourceUsername}] [!p] @${display} — no saved name`);
        return;
      }
      if (isPlaying(record.name)) {
        respond(tiktokId, `${record.name} is currently playing!`, sourceUsername);
        cmd(`[${sourceUsername}] [!p] @${display} (${record.name}) → PLAYING`);
        return;
      }
      const pos = getPosition(record.name);
      if (pos !== null) {
        respond(tiktokId, `${record.name} is #${pos} of ${liveQueue.length} in the queue.`, sourceUsername);
        cmd(`[${sourceUsername}] [!p] @${display} (${record.name}) → #${pos}/${liveQueue.length}`);
      } else {
        if (record.queued) setRecord(users, tiktokId, { name: record.name, queued: false });
        respond(tiktokId, `${record.name} is not in the queue. Type !q to rejoin.`, sourceUsername);
        cmd(`[${sourceUsername}] [!p] @${display} (${record.name}) → not in queue`);
      }
      return;
    }

    if (!lower.startsWith('!q')) return;

    const afterCommand = msg.replace(/^!q(?:ueue)?/i, '').trim();
    const record       = getRecord(users, tiktokId);

    await refreshLiveQueueFromServer();

    if (ownNameIsActive(record)) {
      const pos    = getPosition(record.name);
      const status = isPlaying(record.name) ? 'currently playing' : `already in queue${pos ? ` at #${pos}` : ''}`;
      respond(tiktokId, `${record.name} is ${status}. You cannot add another name.`, sourceUsername);
      cmd(`[${sourceUsername}] [!q] @${display} blocked duplicate while active as ${record.name}`);
      return;
    }

    if (afterCommand) {
      const valid = validateName(afterCommand);
      if (!valid.ok) {
        respond(tiktokId, valid.reason, sourceUsername);
        cmd(`[${sourceUsername}] [!q] @${display} invalid name: "${afterCommand}" (${valid.reason})`);
        return;
      }
      const clean = valid.name;
      if (isNameTakenByOther(clean, tiktokId)) {
        respond(tiktokId, `"${clean}" is already active. Try a different name.`, sourceUsername);
        cmd(`[${sourceUsername}] [!q] @${display} ✗ name "${clean}" taken by another user`);
        return;
      }
      setRecord(users, tiktokId, { name: clean, queued: false });
      cmd(`[${sourceUsername}] [!q] @${display} saved name: ${clean}`);
      const result = await addToQueue(clean);
      if (result === 'added' || result === 'already') {
        await refreshLiveQueueFromServer();
        setRecord(users, tiktokId, { name: clean, queued: true });
        const pos = getPosition(clean) || '?';
        respond(tiktokId, result === 'added' ? `${clean} added to queue! Position: #${pos}` : `${clean} is already in the queue.`, sourceUsername);
        ok(`[${sourceUsername}] [!q] @${display} → ${clean} ${result} (#${pos})`);
      } else {
        setRecord(users, tiktokId, { name: clean, queued: false });
        respond(tiktokId, `Could not add "${clean}" to the queue. Try again shortly.`, sourceUsername);
        err(`[${sourceUsername}] [!q] @${display} → could not add ${clean}`);
      }
      return;
    }

    if (record.name) {
      if (isNameTakenByOther(record.name, tiktokId)) {
        respond(tiktokId, `"${record.name}" is taken. Use !c to clear your name after the host removes the old slot.`, sourceUsername);
        cmd(`[${sourceUsername}] [!q] @${display} ✗ saved name "${record.name}" taken by another`);
        return;
      }
      const result = await addToQueue(record.name);
      if (result === 'added' || result === 'already') {
        await refreshLiveQueueFromServer();
        setRecord(users, tiktokId, { name: record.name, queued: true });
        const pos = getPosition(record.name) || '?';
        respond(tiktokId, result === 'added' ? `${record.name} rejoined the queue at #${pos}!` : `${record.name} is already in the queue.`, sourceUsername);
        ok(`[${sourceUsername}] [!q] @${display} → ${record.name} ${result} (#${pos})`);
      } else {
        respond(tiktokId, `Could not rejoin queue as "${record.name}". Try again shortly.`, sourceUsername);
        err(`[${sourceUsername}] [!q] @${display} → could not add ${record.name}`);
      }
      return;
    }

    respond(tiktokId, 'No saved name! Type !q <YourUbisoftName> to join the queue.', sourceUsername);
    cmd(`[${sourceUsername}] [!q] @${display} — no saved name`);
  });

  tiktok.on('disconnected', () => {
    entry.connected = false;
    entry.connecting = false;
    updateAggregateBotState();
    warn(`TikTok disconnected @${sourceUsername} — reconnecting in 15 seconds…`);
    entry.retryDelay = 15_000;
    postBotStatusToServer({ connected: botConnected, connecting: false, error: `@${sourceUsername} disconnected` });
    scheduleReconnect(sourceUsername, 15_000);
  });

  tiktok.on('error', e => {
    err(`TikTok stream error @${sourceUsername}:`, e.message || JSON.stringify(e));
    postBotStatusToServer({ connected: botConnected, error: `@${sourceUsername}: ${String(e.message || e)}` });
  });

  tiktok.on('roomUser', d => {
    if (d?.viewerCount != null) {
      entry.currentViewers = Number(d.viewerCount);
      updateAggregateBotState();
      info(`@${sourceUsername} Viewers: ${entry.currentViewers}`);
      postBotStatusToServer({ viewers: currentViewers });
    }
  });
}

// Build initial stream objects.
rebuildTikTokConnections();

// ── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown(signal) {
  warn(`\nReceived ${signal} — saving state and exiting…`);
  saveUsers(users);
  for (const entry of streams.values()) { try { entry.conn.disconnect(); } catch (_) {} }
  postBotStatusToServer({ connected: false, connecting: false, error: `Shutdown: ${signal}` })
    .finally(() => process.exit(0));
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', e => err('Unhandled promise rejection:', e?.message || e));
process.on('uncaughtException',  e => err('Uncaught exception:', e?.message || e));

// ── Periodic status report ──────────────────────────────────────────────────
// Posts live status to the server every 30 s so the admin panel stays current.

setInterval(() => postBotStatusToServer(), 30_000);

// ── Periodic config sync ────────────────────────────────────────────────────
// Re-fetches admin-panel config from the server every 60 s.
// Changes to cooldown, blocked lists, poll interval apply live.
// A username change triggers a full reconnect.

setInterval(fetchBotConfigFromServer, 60_000);

// ── Stats printer (every 5 min) ─────────────────────────────────────────────

setInterval(() => {
  const knownUsers    = Object.keys(users).length;
  const queued        = Object.values(users).filter(r => r?.queued).length;
  info(`Stats — streams: ${getStreamUsers().map(u => '@' + u).join(', ')}, known users: ${knownUsers}, queued records: ${queued}, live queue: ${liveQueue.length}, playing: ${livePlaying.length}, viewers: ${currentViewers}`);
}, 5 * 60_000);

// ── Start ───────────────────────────────────────────────────────────────────

printBanner();

// Fetch server config FIRST so we use the admin-set username, cooldown, etc.
fetchBotConfigFromServer()
  .then(() => {
    ok('[sync] Config loaded from server — starting TikTok connection');
    connectAllTikTok();
  })
  .catch(() => {
    warn('[sync] Could not fetch server config (server may be down) — using env defaults');
    connectAllTikTok();
  });
