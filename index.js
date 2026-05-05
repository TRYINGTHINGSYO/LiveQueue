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

function envBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(v)) return false;
  return fallback;
}

function cfgBool(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  return envBool(value, fallback);
}

function uniqueTikTokUsers(list) {
  return [...new Set(list.map(normalizeTikTokUsername).filter(Boolean))];
}

function getStreamUsers() {
  const list = [];
  if (TIKTOK_USERNAME_ENABLED) list.push(TIKTOK_USERNAME);
  if (TIKTOK_USERNAME_2_ENABLED) list.push(...EXTRA_TIKTOK_USERNAMES);
  return uniqueTikTokUsers(list);
}

let TIKTOK_USERNAME = normalizeTikTokUsername(process.env.TIKTOK_USERNAME || 'fsblaker');
let TIKTOK_USERNAME_ENABLED = envBool(process.env.TIKTOK_USERNAME_ENABLED, Boolean(TIKTOK_USERNAME));
let EXTRA_TIKTOK_USERNAMES = parseTikTokUserList(
  process.env.EXTRA_TIKTOK_USERNAMES || process.env.TIKTOK_USERNAME_2 || 'barbariandino'
);
let TIKTOK_USERNAME_2_ENABLED = envBool(process.env.TIKTOK_USERNAME_2_ENABLED, EXTRA_TIKTOK_USERNAMES.length > 0);
const BASE_URL       = (process.env.QUEUE_API_URL || 'https://siegequeue.com').replace(/\/api.*$/, '').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_SECRET || '';
const SESSION_ID     = process.env.TIKTOK_SESSION_ID || '';
const SESSION_ID_2   = process.env.TIKTOK_SESSION_ID_2 || '';
const DATA_FILE      = process.env.USER_DATA_FILE || './users.json';

function parseSessionIdMap(value) {
  const out = new Map();
  String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(pair => {
      const eq = pair.indexOf('=');
      if (eq === -1) return;
      const user = normalizeTikTokUsername(pair.slice(0, eq));
      const sid = pair.slice(eq + 1).trim();
      if (user && sid) out.set(user, sid);
    });
  return out;
}

// Optional per-stream session IDs.
// Examples:
//   TIKTOK_SESSION_ID=your sessionid
//   TIKTOK_SESSION_ID_2=her sessionid
// or for many streams:
//   TIKTOK_SESSION_IDS=barbariandino=herSession,anothername=theirSession
const SESSION_IDS_BY_USER = parseSessionIdMap(process.env.TIKTOK_SESSION_IDS || '');

function getSessionIdForUsername(username) {
  const user = normalizeTikTokUsername(username);
  if (SESSION_IDS_BY_USER.has(user)) return SESSION_IDS_BY_USER.get(user);
  if (user && user === normalizeTikTokUsername(TIKTOK_USERNAME)) return SESSION_ID;

  const extraIndex = EXTRA_TIKTOK_USERNAMES.findIndex(u => normalizeTikTokUsername(u) === user);
  if (extraIndex === 0 && SESSION_ID_2) return SESSION_ID_2;

  // Fallback: one sessionid can often read multiple public lives.
  return SESSION_ID;
}

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
  Users : ${C.yellow}${getStreamUsers().length ? getStreamUsers().map(u => '@' + u).join(' + ') : 'none enabled'}${C.reset}
  Main  : ${TIKTOK_USERNAME_ENABLED ? C.green + 'ON ' + C.reset : C.red + 'OFF' + C.reset} @${TIKTOK_USERNAME || 'not set'}
  Extra : ${TIKTOK_USERNAME_2_ENABLED ? C.green + 'ON ' + C.reset : C.red + 'OFF' + C.reset} ${EXTRA_TIKTOK_USERNAMES.map(u => '@' + u).join(', ') || 'none'}
  API   : ${C.yellow}${BASE_URL}${C.reset}
  Auth  : ${ADMIN_PASSWORD ? `${C.green}✓ set${C.reset}` : `${C.red}✗ missing${C.reset}`}
  Cookie: ${SESSION_ID ? `${C.green}✓ primary set${C.reset}` : `${C.yellow}⚠ primary not set${C.reset}`} | Extra: ${SESSION_ID_2 || SESSION_IDS_BY_USER.size ? `${C.green}✓ set${C.reset}` : `${C.yellow}⚠ not set${C.reset}`}
  Sync  : ${C.green}Admin panel config sync ENABLED${C.reset}

  ${C.dim}Commands: !q <name>  •  !q  •  !p  •  !c  •  !r  •  !help${C.reset}
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

function getRecord(users, userKey) {
  const r = users[userKey];
  if (!r) return { name: '', queued: false };
  if (typeof r === 'string') return { name: r, queued: false };
  return { name: r.name || '', queued: Boolean(r.queued) };
}

function setRecord(users, userKey, record) {
  users[userKey] = { name: record.name || '', queued: Boolean(record.queued) };
  saveUsers(users);
  // Keep the admin panel's TikTok Saved Names list current after !q, !c, or !r.
  setTimeout(() => {
    try { postBotStatusToServer().catch(() => {}); } catch (_) {}
  }, 0);
}

// Saved-name/lock key is GLOBAL per TikTok account, not per stream.
// This means @somebody has ONE Ubisoft name across @fsblaker and @barbariandino.
// They cannot use one Ubisoft name in your queue and a different one in hers.
function streamUserKey(sourceUsername, tiktokId) {
  return normalizeTikTokUsername(tiktokId || 'unknown');
}

function displayUserKey(key) {
  const parts = String(key || '').split(':');
  return parts.length > 1 ? parts.slice(1).join(':') : String(key || '');
}

function canonicalName(raw) {
  return normalizeForFilter(raw);
}

function nameSkeleton(raw) {
  return canonicalName(raw).replace(/[il]/g, 'l');
}

function boundedEditDistance(a, b, maxDistance = 2) {
  a = String(a || '');
  b = String(b || '');
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    prev = curr;
  }
  return prev[b.length];
}

function namesAreTooClose(candidate, existing) {
  const a = canonicalName(candidate);
  const b = canonicalName(existing);
  if (!a || !b) return false;
  if (a === b) return true;

  const minLen = Math.min(a.length, b.length);
  const allowedDistance = minLen >= 8 ? 2 : 1;
  if (minLen >= 4 && (a.includes(b) || b.includes(a))) return true;
  if (minLen >= 5 && boundedEditDistance(a, b, allowedDistance) <= allowedDistance) return true;

  const sa = nameSkeleton(candidate);
  const sb = nameSkeleton(existing);
  if (sa === sb) return true;
  if (minLen >= 5 && boundedEditDistance(sa, sb, allowedDistance) <= allowedDistance) return true;

  return false;
}

function migrateUsersToGlobalKeys() {
  let changed = false;
  for (const key of Object.keys(users)) {
    if (!key.includes(':')) continue;
    const globalKey = normalizeTikTokUsername(displayUserKey(key));
    if (!globalKey) continue;
    const oldRecord = getRecord(users, key);
    const existing = getRecord(users, globalKey);
    if (!existing.name && oldRecord.name) {
      users[globalKey] = oldRecord;
    } else if (existing.name && oldRecord.name && canonicalName(existing.name) === canonicalName(oldRecord.name)) {
      users[globalKey] = { name: existing.name, queued: existing.queued || oldRecord.queued };
    }
    delete users[key];
    changed = true;
  }
  if (changed) saveUsers(users);
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

function findQueuedPlayerByName(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return null;
  return liveQueue.find(p => String(p.name || '').toLowerCase() === n) || null;
}

async function postPositionSpotlight(name, tiktokId = '') {
  const clean = String(name || '').trim();
  if (!clean) return false;
  if (!ADMIN_PASSWORD) {
    warn('ADMIN_PASSWORD not set — cannot update position overlay');
    return false;
  }

  try {
    const r = await fetchWithTimeout(`${BASE_URL}/api/admin/position-spotlight`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: clean, tiktok: displayUserKey(tiktokId) }),
    }, 6_000);
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      warn(`position overlay update failed for ${clean}: ${r.status} ${text}`);
      return false;
    }
    return true;
  } catch (e) {
    warn(`position overlay network error for ${clean}: ${e.message}`);
    return false;
  }
}

async function removeFromQueue(name) {
  const clean = String(name || '').trim();
  if (!clean) return 'not_found';
  if (!ADMIN_PASSWORD) { err('ADMIN_PASSWORD not set — cannot remove from queue'); return 'error'; }

  await refreshLiveQueueFromServer();
  const queuedPlayer = findQueuedPlayerByName(clean);
  if (!queuedPlayer) return 'not_found';

  const attempts = [];
  if (queuedPlayer.id) {
    attempts.push({ url: `${BASE_URL}/api/admin/kick`, body: { id: queuedPlayer.id } });
    attempts.push({ url: `${BASE_URL}/api/admin/remove`, body: { id: queuedPlayer.id } });
  }
  attempts.push({ url: `${BASE_URL}/api/admin/kick`, body: { name: clean } });
  attempts.push({ url: `${BASE_URL}/api/admin/remove`, body: { name: clean } });
  attempts.push({ url: `${BASE_URL}/api/admin/remove-from-queue`, body: { name: clean } });

  for (const attempt of attempts) {
    try {
      const r = await fetchWithTimeout(attempt.url, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify(attempt.body),
      }, 8_000);
      const text = await r.text();
      if (r.ok) {
        await refreshLiveQueueFromServer();
        return 'removed';
      }
      if (r.status === 404) continue;
      err(`removeFromQueue failed at ${attempt.url} for ${clean}: ${r.status} ${text}`);
      return 'error';
    } catch (e) {
      err(`removeFromQueue network error at ${attempt.url}:`, e.message);
    }
  }

  err('No working admin remove/kick endpoint found.');
  return 'error';
}

// ── Server config sync ──────────────────────────────────────────────────────

let _pollIntervalHandle = null;
let _lastStreamUsersKey = JSON.stringify(getStreamUsers());

async function applyAdminSavedNameOverrides() {
  if (!ADMIN_PASSWORD) return;
  try {
    const r = await fetchWithTimeout(`${BASE_URL}/api/admin/bot-user-overrides`, { headers: authHeaders() }, 6_000);
    if (!r.ok) return;
    const data = await r.json();
    const edits = data.edits || data.overrides || {};
    let changed = false;

    for (const [rawTikTok, entry] of Object.entries(edits)) {
      const tiktok = normalizeTikTokUsername(displayUserKey(rawTikTok));
      const desired = String(entry?.ubisoft || entry?.name || entry || '').trim();
      if (!tiktok || !desired) continue;
      const valid = validateName(desired);
      if (!valid.ok) continue;
      const clean = valid.name;
      const old = getRecord(users, tiktok);
      if (canonicalName(old.name) === canonicalName(clean)) continue;

      // If their old saved name is currently in queue/playing, rename it on the website too.
      if (old.name && (isInQueue(old.name) || isPlaying(old.name))) {
        await renamePlayerOnServer(old.name, clean);
        await refreshLiveQueueFromServer();
      }

      users[tiktok] = { name: clean, queued: old.queued };
      changed = true;
      cmd(`[admin-sync] @${tiktok} saved Ubisoft name set to ${clean}`);
    }

    if (changed) {
      saveUsers(users);
      postBotStatusToServer().catch(() => {});
    }
  } catch (e) {
    if (!String(e.message || '').includes('aborted')) warn(`[sync] bot-user-overrides fetch error: ${e.message}`);
  }
}

async function renamePlayerOnServer(oldName, newName) {
  if (!ADMIN_PASSWORD) return 'error';
  try {
    const r = await fetchWithTimeout(`${BASE_URL}/api/admin/rename-player`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ oldName, newName }),
    }, 8_000);
    const text = await r.text();
    if (r.ok) return 'renamed';
    warn(`[admin-sync] rename-player failed ${oldName} → ${newName}: ${r.status} ${text}`);
    return 'error';
  } catch (e) {
    warn(`[admin-sync] rename-player network error ${oldName} → ${newName}: ${e.message}`);
    return 'error';
  }
}

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
    await applyAdminSavedNameOverrides();

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

    // TikTok usernames + enabled toggles from the admin panel.
    // The admin can turn either live chat on/off without removing the saved usernames.
    const beforeUsersKey = JSON.stringify(getStreamUsers());

    if (typeof cfg.username === 'string') {
      const nextPrimary = normalizeTikTokUsername(cfg.username);
      if (nextPrimary) TIKTOK_USERNAME = nextPrimary;
    }

    // Missing enabled fields default to true for backwards compatibility with older admin files.
    TIKTOK_USERNAME_ENABLED = cfgBool(cfg.usernameEnabled ?? cfg.primaryEnabled ?? cfg.enabled, Boolean(TIKTOK_USERNAME));

    const rawExtraUsers = Array.isArray(cfg.extraUsernames)
      ? cfg.extraUsernames
      : [cfg.username2 ?? cfg.secondaryUsername ?? cfg.extraUsername].filter(Boolean);
    const nextExtraUsers = uniqueTikTokUsers(rawExtraUsers);
    if (nextExtraUsers.length || 'username2' in cfg || 'secondaryUsername' in cfg || 'extraUsernames' in cfg) {
      EXTRA_TIKTOK_USERNAMES = nextExtraUsers;
    }

    TIKTOK_USERNAME_2_ENABLED = cfgBool(
      cfg.username2Enabled ?? cfg.secondaryEnabled ?? cfg.extraUsernamesEnabled ?? cfg.extraEnabled,
      EXTRA_TIKTOK_USERNAMES.length > 0
    );

    const afterUsersKey = JSON.stringify(getStreamUsers());
    if (afterUsersKey !== beforeUsersKey || afterUsersKey !== _lastStreamUsersKey) {
      info(`[sync] TikTok streams now enabled: ${getStreamUsers().length ? getStreamUsers().map(u => '@' + u).join(', ') : 'none'}`);
      _lastStreamUsersKey = afterUsersKey;
      rebuildTikTokConnections();
      connectAllTikTok();
    }
  } catch (e) {
    if (!e.message?.includes('aborted')) warn(`[sync] Config fetch error: ${e.message}`);
  }
}

function getSavedUsersForAdmin() {
  const activeNames = new Set([
    ...liveQueue.map(p => p.name.toLowerCase()),
    ...livePlaying.map(p => p.name.toLowerCase()),
  ]);

  return Object.entries(users)
    .map(([tiktok, raw]) => {
      const record = getRecord(users, tiktok);
      const name = String(record.name || '').trim();
      if (!name) return null;

      const pos = getPosition(name);
      const playing = isPlaying(name);
      const queued = pos !== null;
      const active = activeNames.has(name.toLowerCase());

      return {
        tiktok,
        tiktokUsername: displayUserKey(tiktok),
        username: displayUserKey(tiktok),
        ubisoft: name,
        ubisoftName: name,
        name,
        queued,
        playing,
        active,
        position: pos,
        status: playing ? 'playing' : queued ? 'queued' : record.queued ? 'saved' : 'saved',
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.tiktok.localeCompare(b.tiktok));
}

/**
 * Post the bot's current live status to the server.
 */
async function postBotStatusToServer(extra = {}) {
  if (!ADMIN_PASSWORD) return;
  const knownUsers = Object.keys(users).length;
  const queuedRecords = Object.values(users).filter(r => r?.queued).length;
  const savedUsers = getSavedUsersForAdmin();
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
        savedUsers,
        tiktokSavedUsers: savedUsers,
        streams      : [...streams.values()].map(s => ({
          username: s.username,
          connected: Boolean(s.connected),
          connecting: Boolean(s.connecting),
          viewers: Number(s.currentViewers || 0),
          roomId: s.currentRoomId || null,
        })),
        usernames: {
          username: TIKTOK_USERNAME,
          usernameEnabled: TIKTOK_USERNAME_ENABLED,
          username2: EXTRA_TIKTOK_USERNAMES[0] || '',
          username2Enabled: TIKTOK_USERNAME_2_ENABLED,
          extraUsernames: EXTRA_TIKTOK_USERNAMES,
        },
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
function findNameTakenByOther(name, tiktokId) {
  const key = canonicalName(name);
  if (!key) return null;

  const self = normalizeTikTokUsername(tiktokId);

  // 1) Block against every saved TikTok → Ubisoft mapping, even if they are not
  // currently in queue. Names stay static until admin edits them or the user resets.
  for (const [ownerKey] of Object.entries(users)) {
    const owner = normalizeTikTokUsername(displayUserKey(ownerKey));
    if (owner === self) continue;
    const record = getRecord(users, ownerKey);
    if (record.name && namesAreTooClose(name, record.name)) {
      return record.name;
    }
  }

  // 2) Also block against names currently in the live website queue / playing list.
  const ownRecord = getRecord(users, tiktokId);
  const ownKey = canonicalName(ownRecord.name);
  for (const p of [...liveQueue, ...livePlaying]) {
    if (!p.name) continue;
    if (ownKey && canonicalName(p.name) === ownKey) continue;
    if (namesAreTooClose(name, p.name)) return p.name;
  }

  return null;
}

function isNameTakenByOther(name, tiktokId) {
  return Boolean(findNameTakenByOther(name, tiktokId));
}

function nameTakenMessage(name, tiktokId) {
  const conflict = findNameTakenByOther(name, tiktokId);
  if (!conflict) return '';
  if (canonicalName(name) === canonicalName(conflict)) return `"${name}" is already taken.`;
  return `"${name}" is too close to "${conflict}". Pick a more different Ubisoft name.`;
}

// ── Queue state poller ──────────────────────────────────────────────────────

const users = loadUsers();
migrateUsersToGlobalKeys();

async function refreshLiveQueueFromServer() {
  const state = await fetchQueueState();
  if (!state) return false;
  const rawQueue   = Array.isArray(state.queue)   ? state.queue   : [];
  const rawPlaying = Array.isArray(state.playing) ? state.playing : [];
  liveQueue   = rawQueue.map((p, i) => ({ name: playerName(p), id: p?.id || p?._id || p?.playerId || p?.queueId || null, position: i + 1 })).filter(p => p.name);
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
  for (const n of currQueue) if (!prevQueue.has(n)) poll(`  + ${n} already on website queue`);
  for (const n of prevQueue) if (!currQueue.has(n)) poll(`  - ${n} left website queue`);

  const activeNames = new Set([
    ...liveQueue.map(p => p.name.toLowerCase()),
    ...livePlaying.map(p => p.name.toLowerCase()),
  ]);

  let changed = false;
  for (const [storedKey, raw] of Object.entries(users)) {
    const record = getRecord(users, storedKey);
    if (record.queued && record.name && !activeNames.has(record.name.toLowerCase())) {
      warn(`↩  @${displayUserKey(storedKey)} (${record.name}) removed from queue/playing — unlocked for rejoin`);
      users[storedKey] = { name: record.name, queued: false };
      changed = true;
    }
  }
  if (changed) {
    saveUsers(users);
    postBotStatusToServer().catch(() => {});
  }
}

_pollIntervalHandle = setInterval(pollQueue, POLL_MS);
pollQueue();

// ── Per-user cooldown (anti-spam) ───────────────────────────────────────────

const cooldowns = new Map();
function isOnCooldown(key) { return Date.now() - (cooldowns.get(key) || 0) < COOLDOWN_MS; }
function setCooldown(key)  { cooldowns.set(key, Date.now()); }

// ── TikTok connections ──────────────────────────────────────────────────────
// Supports more than one live at the same time.
// Example env:
//   TIKTOK_USERNAME=fsblaker
//   TIKTOK_USERNAME_2=barbariandino
// or:
//   EXTRA_TIKTOK_USERNAMES=barbariandino,anotherstreamer

function buildTikTokOptions(username) {
  const sessionId = getSessionIdForUsername(username);
  return {
    enableExtendedGiftInfo  : false,
    enableWebsocketUpgrade  : true,
    requestPollingIntervalMs: 2_000,
    ...(sessionId ? { sessionId } : {}),
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

function createFreshTikTokConnection(entry) {
  // Important: tiktok-live-connector can get stuck after a failed/offline connect.
  // Make a brand-new connection object every time we retry, so one offline stream
  // never blocks the other stream and nobody has to redeploy when going live later.
  try {
    if (entry.conn) entry.conn.disconnect();
  } catch (_) {}

  entry.conn = new WebcastPushConnection(entry.username, buildTikTokOptions(entry.username));
  registerTikTokEvents(entry);
  return entry.conn;
}

function ensureStream(username) {
  username = normalizeTikTokUsername(username);
  if (!username) return null;
  if (streams.has(username)) return streams.get(username);

  const entry = {
    username,
    conn: null,
    retryDelay: 15_000,
    reconnectTimer: null,
    connecting: false,
    connected: false,
    currentViewers: 0,
    currentRoomId: null,
    lastConnectAttempt: 0,
  };
  streams.set(username, entry);
  createFreshTikTokConnection(entry);
  return entry;
}

function disconnectStream(username) {
  const entry = streams.get(username);
  if (!entry) return;
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  entry.reconnectTimer = null;
  entry.connecting = false;
  entry.connected = false;
  try { if (entry.conn) entry.conn.disconnect(); } catch (_) {}
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
  username = normalizeTikTokUsername(username);
  if (!getStreamUsers().includes(username)) return;
  const entry = ensureStream(username);
  if (!entry) return;
  const safeDelay = Math.max(5_000, Number(delayMs || 15_000));
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    connectTikTok(username);
  }, safeDelay);
}

function connectTikTok(username) {
  username = normalizeTikTokUsername(username);
  if (!getStreamUsers().includes(username)) return;
  const entry = ensureStream(username);
  if (!entry || entry.connecting || entry.connected) return;

  entry.connecting = true;
  entry.lastConnectAttempt = Date.now();
  createFreshTikTokConnection(entry);

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
      entry.currentRoomId = null;
      const hint = e?.exception?.retryAfter ?? e?.retryAfter;
      const delay = hint ? hint * 1_000 : entry.retryDelay;
      entry.retryDelay = Math.min(entry.retryDelay * 2, MAX_RETRY_MS);
      updateAggregateBotState();

      const message = String(e?.message || e || 'unknown error');
      err(`TikTok connect failed for @${entry.username}: ${message}`);
      if (!getSessionIdForUsername(entry.username)) warn(`Tip: set a sessionid for @${entry.username}. Use TIKTOK_SESSION_ID for primary, TIKTOK_SESSION_ID_2 for the second stream, or TIKTOK_SESSION_IDS=username=sessionid.`);
      info(`Keeping @${entry.username} armed. Retrying in ${Math.round(delay / 1000)}s so you do NOT have to redeploy when that live starts.`);
      postBotStatusToServer({ connected: botConnected, connecting: false, error: `@${entry.username}: ${message}` });
      scheduleReconnect(entry.username, delay);
    });
}

function connectAllTikTok() {
  rebuildTikTokConnections();
  const activeUsers = getStreamUsers();
  if (!activeUsers.length) {
    warn('No TikTok accounts are enabled. Turn one on in the admin panel to start watching chat.');
    postBotStatusToServer({ connected: false, connecting: false, error: 'No TikTok accounts enabled' });
    return;
  }

  // Stagger connection attempts slightly. This avoids TikTok rate-limit/weirdness
  // where trying both rooms at the exact same millisecond can make one say it
  // cannot reach the room even though the other works.
  activeUsers.forEach((username, i) => {
    setTimeout(() => connectTikTok(username), i * 5_000);
  });
}

function keepTikTokConnectionsAlive() {
  const activeUsers = getStreamUsers();
  for (const username of activeUsers) {
    const entry = ensureStream(username);
    if (!entry) continue;
    if (!entry.connected && !entry.connecting && !entry.reconnectTimer) {
      info(`Watchdog: @${entry.username} is not connected — trying again now.`);
      connectTikTok(entry.username);
    }
  }
}

setInterval(keepTikTokConnectionsAlive, 30_000);

// tiktok-live-connector is read-only; this logs what the bot would say.
function respond(tiktokId, message, sourceUsername = '') {
  log('CHAT ←', C.cyan, `${sourceUsername ? '[' + sourceUsername + '] ' : ''}@${tiktokId}: ${message}`);
}

// ── Chat handler ────────────────────────────────────────────────────────────

function registerTikTokEvents(entry) {
  const tiktok = entry.conn;
  const sourceUsername = entry.username;
  const recentCommands = new Map();

  // Some TikTok Live connector versions/accounts emit comments as `chat`;
  // others emit them as `comment`. Register BOTH for every stream so the
  // second live, like @barbariandino, can also use !q / !c / !r.
  const handleChatCommand = async (data, eventName = 'chat') => {
    const rawTikTokId = normalizeTikTokUsername(data?.uniqueId || data?.user?.uniqueId || data?.userId || data?.user?.id || '');
    const tiktokId = rawTikTokId;
    const userKey = streamUserKey(sourceUsername, rawTikTokId);
    const display  = data?.nickname || data?.user?.nickname || data?.uniqueId || rawTikTokId;
    const msg      = String(data?.comment || data?.text || data?.content || data?.msg || '').trim();
    const lower    = msg.toLowerCase();

    const isCmd = lower === '!c' || lower === '!clear' || lower === '!r' || lower === '!reset' || lower === '!p' || lower === '!help' || lower === '!queue' || lower.startsWith('!q');
    if (!isCmd) return;

    cmd(`[${sourceUsername}] command heard from @${display} / key=${userKey}: ${msg}`);

    // Prevent duplicate handling if a connector emits both `chat` and `comment`
    // for the same message. Keeps one person from being queued twice.
    const now = Date.now();
    for (const [key, t] of recentCommands) {
      if (now - t > 2500) recentCommands.delete(key);
    }
    const dedupeKey = `${sourceUsername}|${rawTikTokId}|${lower}`;
    if (recentCommands.has(dedupeKey)) return;
    recentCommands.set(dedupeKey, now);

    if (BANNED_TIKTOK_USERS.has(tiktokId)) {
      cmd(`[${sourceUsername}] [blocked] @${display} tried command: ${msg}`);
      return;
    }

    // Only rate-limit queue JOIN commands.
    // Do NOT let !r / !c / !p consume the cooldown, because TikTok can deliver
    // messages in a burst. Example: !r followed immediately by !q name should work.
    const isJoinCommand = lower.startsWith('!q');
    const cooldownKey = `${userKey}:join`;
    if (isJoinCommand && isOnCooldown(cooldownKey)) {
      cmd(`[${sourceUsername}] [cooldown] @${tiktokId} — ignored join (${COOLDOWN_MS / 1000}s cooldown)`);
      return;
    }

    if (lower === '!help') {
      respond(tiktokId, '!q <name> = save name + join | !q = rejoin saved name | !p = position | !c = clear from queue | !r = reset saved name', sourceUsername);
      cmd(`[${sourceUsername}] [!help] @${display}`);
      return;
    }

    if (lower === '!c' || lower === '!clear') {
      const record = getRecord(users, userKey);
      if (!record.name) {
        respond(tiktokId, 'You have no saved name. Use !q <YourName> to join the queue.', sourceUsername);
        cmd(`[${sourceUsername}] [!c] @${display} — no saved name`);
        return;
      }

      await refreshLiveQueueFromServer();

      if (isPlaying(record.name)) {
        respond(tiktokId, `${record.name} is currently playing. Ask the host to clear playing when the match is done.`, sourceUsername);
        cmd(`[${sourceUsername}] [!c] @${display} blocked while playing as ${record.name}`);
        return;
      }

      if (!isInQueue(record.name)) {
        setRecord(users, userKey, { name: record.name, queued: false });
        respond(tiktokId, `${record.name} is not in the queue. Your saved name is still set. Use !q to rejoin or !r to reset it.`, sourceUsername);
        cmd(`[${sourceUsername}] [!c] @${display} (${record.name}) — not in queue`);
        return;
      }

      const result = await removeFromQueue(record.name);
      if (result === 'removed') {
        setRecord(users, userKey, { name: record.name, queued: false });
        respond(tiktokId, `${record.name} cleared from the queue. Saved name kept. Type !q to rejoin or !r to reset your name.`, sourceUsername);
        ok(`[${sourceUsername}] [!c] @${display} removed ${record.name} from queue`);
      } else if (result === 'not_found') {
        setRecord(users, userKey, { name: record.name, queued: false });
        respond(tiktokId, `${record.name} was not detected in the queue, so there was nothing to clear. Saved name kept.`, sourceUsername);
        cmd(`[${sourceUsername}] [!c] @${display} ${record.name} not detected in queue`);
      } else {
        respond(tiktokId, `Could not clear ${record.name} from the queue. Ask the host to remove it.`, sourceUsername);
        err(`[${sourceUsername}] [!c] @${display} failed to remove ${record.name}`);
      }
      return;
    }

    if (lower === '!r' || lower === '!reset') {
      const record = getRecord(users, userKey);
      if (!record.name) {
        respond(tiktokId, 'You have no saved name to reset. Use !q <YourName> to set one.', sourceUsername);
        cmd(`[${sourceUsername}] [!r] @${display} — no saved name`);
        return;
      }

      await refreshLiveQueueFromServer();

      if (isPlaying(record.name)) {
        respond(tiktokId, `${record.name} is currently playing. Ask the host to clear playing before resetting your name.`, sourceUsername);
        cmd(`[${sourceUsername}] [!r] @${display} blocked while playing as ${record.name}`);
        return;
      }

      if (isInQueue(record.name)) {
        respond(tiktokId, `${record.name} is still in the queue. Use !c first, then use !r to reset your saved name.`, sourceUsername);
        cmd(`[${sourceUsername}] [!r] @${display} blocked reset while queued as ${record.name}`);
        return;
      }

      const old = record.name;
      setRecord(users, userKey, { name: '', queued: false });
      respond(tiktokId, `Reset saved name "${old}". Use !q <NewUbisoftName> to set a new one.`, sourceUsername);
      cmd(`[${sourceUsername}] [!r] @${display} reset "${old}"`);
      return;
    }

    if (lower === '!p' || lower === '!position' || lower === '!queue') {
      const record = getRecord(users, userKey);
      if (!record.name) {
        respond(tiktokId, 'No saved name. Use !q <YourName> to join the queue.', sourceUsername);
        cmd(`[${sourceUsername}] [!p] @${display} — no saved name`);
        return;
      }

      await refreshLiveQueueFromServer();
      await postPositionSpotlight(record.name, tiktokId);

      if (isPlaying(record.name)) {
        respond(tiktokId, `${record.name} is currently playing!`, sourceUsername);
        cmd(`[${sourceUsername}] [!p] @${display} (${record.name}) → PLAYING + overlay`);
        return;
      }
      const pos = getPosition(record.name);
      if (pos !== null) {
        respond(tiktokId, `${record.name} is #${pos} of ${liveQueue.length} in the queue.`, sourceUsername);
        cmd(`[${sourceUsername}] [!p] @${display} (${record.name}) → #${pos}/${liveQueue.length} + overlay`);
      } else {
        if (record.queued) setRecord(users, userKey, { name: record.name, queued: false });
        respond(tiktokId, `${record.name} is not in the queue. Type !q to rejoin.`, sourceUsername);
        cmd(`[${sourceUsername}] [!p] @${display} (${record.name}) → not in queue + overlay`);
      }
      return;
    }

    if (!lower.startsWith('!q')) return;
    setCooldown(cooldownKey);

    const afterCommand = msg.replace(/^!q(?:ueue)?/i, '').trim();
    const record       = getRecord(users, userKey);

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

      // Saved Ubisoft names are permanent until !r.
      // If they already have a saved name, !q <different name> will NOT change the file.
      // They must use !r first, then !q <new name>.
      if (record.name && record.name.toLowerCase() !== clean.toLowerCase()) {
        respond(tiktokId, `Your saved Ubisoft name is ${record.name}. Type !q to join with it, or use !r first if you need to change it.`, sourceUsername);
        cmd(`[${sourceUsername}] [!q] @${display} tried to change ${record.name} → ${clean} without !r`);
        return;
      }

      const takenMsg = nameTakenMessage(clean, userKey);
      if (takenMsg) {
        respond(tiktokId, takenMsg, sourceUsername);
        cmd(`[${sourceUsername}] [!q] @${display} ✗ name "${clean}" blocked by name checker`);
        return;
      }
      setRecord(users, userKey, { name: clean, queued: false });
      cmd(`[${sourceUsername}] [!q] @${display} saved name: ${clean}`);
      const result = await addToQueue(clean);
      if (result === 'added' || result === 'already') {
        await refreshLiveQueueFromServer();
        setRecord(users, userKey, { name: clean, queued: true });
        const pos = getPosition(clean) || '?';
        respond(tiktokId, result === 'added' ? `${clean} added to queue! Position: #${pos}` : `${clean} is already in the queue.`, sourceUsername);
        ok(`[${sourceUsername}] [!q] @${display} → ${clean} ${result} (#${pos})`);
      } else {
        setRecord(users, userKey, { name: clean, queued: false });
        respond(tiktokId, `Could not add "${clean}" to the queue. Try again shortly.`, sourceUsername);
        err(`[${sourceUsername}] [!q] @${display} → could not add ${clean}`);
      }
      return;
    }

    if (record.name) {
      const takenMsg = nameTakenMessage(record.name, userKey);
      if (takenMsg) {
        respond(tiktokId, `${takenMsg} Use !r to reset your saved name after the host removes the old slot.`, sourceUsername);
        cmd(`[${sourceUsername}] [!q] @${display} ✗ saved name "${record.name}" blocked by name checker`);
        return;
      }
      const result = await addToQueue(record.name);
      if (result === 'added' || result === 'already') {
        await refreshLiveQueueFromServer();
        setRecord(users, userKey, { name: record.name, queued: true });
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
  };

  tiktok.on('chat', data => handleChatCommand(data, 'chat'));
  tiktok.on('comment', data => handleChatCommand(data, 'comment'));

  tiktok.on('disconnected', () => {
    entry.connected = false;
    entry.connecting = false;
    entry.currentRoomId = null;
    updateAggregateBotState();
    warn(`TikTok disconnected @${sourceUsername} — reconnecting in 15 seconds. No redeploy needed.`);
    entry.retryDelay = 15_000;
    postBotStatusToServer({ connected: botConnected, connecting: false, error: `@${sourceUsername} disconnected` });
    scheduleReconnect(sourceUsername, 15_000);
  });

  tiktok.on('error', e => {
    err(`TikTok stream error @${sourceUsername}:`, e.message || JSON.stringify(e));
    postBotStatusToServer({ connected: botConnected, error: `@${sourceUsername}: ${String(e.message || e)}` });
  });

  // Viewer count updates only. Do NOT queue anyone from roomUser/join events.
  // The bot only adds a player when that TikTok user types !q in chat.
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
// Apply admin name edits quickly so saved names are written into users.json soon after you finish editing.
setInterval(applyAdminSavedNameOverrides, 5_000);

// ── Stats printer (every 5 min) ─────────────────────────────────────────────

setInterval(() => {
  const knownUsers    = Object.keys(users).length;
  const queued        = Object.values(users).filter(r => r?.queued).length;
  info(`Stats — enabled streams: ${getStreamUsers().map(u => '@' + u).join(', ') || 'none'}, known users: ${knownUsers}, queued records: ${queued}, live queue: ${liveQueue.length}, playing: ${livePlaying.length}, viewers: ${currentViewers}`);
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
