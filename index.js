'use strict';

// Env Twitch force-on guard.
// If TWITCH_ENABLED=true is set in Railway, admin config sync is not allowed to turn Twitch off.
// This prevents stale website config from overriding the bot service at startup.
const TWITCH_ENV_FORCE_ENABLED =
  String(process.env.TWITCH_ENABLED || '').toLowerCase() === 'true' ||
  String(process.env.TWITCH_ENABLED || '') === '1' ||
  String(process.env.TWITCH_ENABLED || '').toLowerCase() === 'yes' ||
  String(process.env.TWITCH_ENABLED || '').toLowerCase() === 'on';

function boolFromConfigOrEnv(value, fallback = false) {
  if (TWITCH_ENV_FORCE_ENABLED) return true;
  if (value === true || value === 'true' || value === 1 || value === '1' || value === 'on' || value === 'yes') return true;
  if (value === false || value === 'false' || value === 0 || value === '0' || value === 'off' || value === 'no') return false;
  return fallback;
}

const fs = require('fs');
const { parseBotCommandMessage } = require('./bot-command-parser');
const {
  cfgBool,
  envBool,
  normalizeTikTokUsername,
  parseTikTokUserList,
  parseTwitchChannelList,
  uniqueTikTokUsers,
} = require('./livequeue-utils');

// TikTok chat support. Keep this optional so a stale Railway build without the
// dependency does not crash before Twitch/status logging can start.
let WebcastPushConnection = null;
let TIKTOK_CONNECTOR_LOAD_ERROR = '';
try {
  ({ WebcastPushConnection } = require('tiktok-live-connector'));
} catch (e) {
  TIKTOK_CONNECTOR_LOAD_ERROR = e?.message || String(e || 'tiktok-live-connector is not installed');
}

// Optional Twitch chat support. Install with: npm install tmi.js
let tmi = null;
try {
  tmi = require('tmi.js');
} catch (_) {
  // Safe to ignore unless Twitch is enabled. TikTok-only deployments keep working.
}

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
function twitchChannelsKey(channels = TWITCH_CHANNELS) {
  return JSON.stringify(parseTwitchChannelList(channels).sort());
}

function twitchChannelsDisplay(channels = TWITCH_CHANNELS) {
  return parseTwitchChannelList(channels).map(c => '#' + c).join(', ');
}

let TWITCH_CHANNELS = parseTwitchChannelList(process.env.TWITCH_CHANNELS || process.env.TWITCH_CHANNEL || '');
let TWITCH_ENABLED = envBool(process.env.TWITCH_ENABLED, TWITCH_CHANNELS.length > 0);
const TWITCH_BOT_USERNAME = String(process.env.TWITCH_BOT_USERNAME || '').trim();
const TWITCH_OAUTH_TOKEN = String(process.env.TWITCH_OAUTH_TOKEN || '').trim();

const BASE_URL       = (process.env.QUEUE_API_URL || 'https://siegequeue.com').replace(/\/api.*$/, '').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_SECRET || '';
const SESSION_ID     = String(process.env.TIKTOK_SESSION_ID || '').trim();
const SESSION_ID_2   = String(process.env.TIKTOK_SESSION_ID_2 || '').trim();
const DATA_FILE      = process.env.BOT_USERS_FILE || process.env.USER_DATA_FILE || './users.json';

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
let MAX_RETRY_MS   = Number(process.env.MAX_RETRY_MS || 30_000);
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 20_000);
const LIVE_SCAN_MS       = Number(process.env.LIVE_SCAN_MS || 5_000);
// If TikTok says it is connected but stops sending room/chat events, rebuild the connection.
// This fixes the common post-restart-live stale cursor issue.
// NOTE: 20s was too aggressive — busy lives can have natural 20-30s gaps between roomUser/chat
// pushes, causing needless reconnects that drop messages during the ~8s reconnect window.
// 90s gives enough headroom while still catching genuinely stale connections.
const STALE_CONNECTED_MS = Number(process.env.STALE_CONNECTED_MS || 90_000);

// Prevent Missing Cursor from causing an infinite rebuild spam loop.
// TikTok can return several bad fetch responses while the old live session is closing.
// Raised from 15s to 30s to further reduce reconnect-induced message loss.
const REBUILD_COOLDOWN_MS = Number(process.env.REBUILD_COOLDOWN_MS || 30_000);
const rebuildingUntil = new Map();

// ── Name normalizer (needed for blocklist init below) ───────────────────────
// Full definition lives later next to the other name helpers; this copy is
// identical and lets us use it during module-level initialisation.
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

let lastTikTokDependencyWarnAt = 0;

function hasTikTokConnector() {
  return typeof WebcastPushConnection === 'function';
}

function warnMissingTikTokConnector(context = '') {
  const now = Date.now();
  if (now - lastTikTokDependencyWarnAt < 60_000) return;
  lastTikTokDependencyWarnAt = now;

  const message = 'TikTok dependency missing: install tiktok-live-connector or deploy the updated package.json.';
  warn(`${message}${context ? ` (${context})` : ''}`);
  if (TIKTOK_CONNECTOR_LOAD_ERROR) warn(`TikTok dependency load error: ${TIKTOK_CONNECTOR_LOAD_ERROR}`);
  try {
    postAdminLog('error', 'tiktok', message, { context, error: TIKTOK_CONNECTOR_LOAD_ERROR }).catch(() => {});
    postBotStatusToServer({ connected: botConnected || twitchConnected, connecting: false, error: message }).catch(() => {});
  } catch (_) {}
}

function printBanner() {
  console.log(`
${C.cyan}${C.bold}╔══════════════════════════════════════════╗
║     TikTok/Twitch Queue Bot • siegequeue  ║
╚══════════════════════════════════════════╝${C.reset}
  Users : ${C.yellow}${getStreamUsers().length ? getStreamUsers().map(u => '@' + u).join(' + ') : 'none enabled'}${C.reset}
  Main  : ${TIKTOK_USERNAME_ENABLED ? C.green + 'ON ' + C.reset : C.red + 'OFF' + C.reset} @${TIKTOK_USERNAME || 'not set'}
  Extra : ${TIKTOK_USERNAME_2_ENABLED ? C.green + 'ON ' + C.reset : C.red + 'OFF' + C.reset} ${EXTRA_TIKTOK_USERNAMES.map(u => '@' + u).join(', ') || 'none'}
  API   : ${C.yellow}${BASE_URL}${C.reset}
  Auth  : ${ADMIN_PASSWORD ? `${C.green}✓ set${C.reset}` : `${C.red}✗ missing${C.reset}`}
  Cookie: ${SESSION_ID ? `${C.green}✓ primary set${C.reset}` : `${C.yellow}⚠ primary not set${C.reset}`} | Extra: ${SESSION_ID_2 || SESSION_IDS_BY_USER.size ? `${C.green}✓ set${C.reset}` : `${C.yellow}⚠ not set${C.reset}`}
  Users : ${C.yellow}${DATA_FILE}${C.reset}
  TikTok: ${hasTikTokConnector() ? `${C.green}module loaded${C.reset}` : `${C.red}module missing${C.reset}`}
  Twitch: ${TWITCH_ENABLED ? C.green + 'ON ' + C.reset + TWITCH_CHANNELS.map(c => '#' + c).join(', ') : C.red + 'OFF' + C.reset}
  Sync  : ${C.green}Admin panel config sync ENABLED${C.reset}

  ${C.dim}Commands: queue/q <UbisoftName> to save/join  |  queue/q to rejoin saved name  |  temp <UbisoftName> to join once without saving  |  leave to leave queue  |  reset clears saved name  |  bare-name fallback OFF${C.reset}
`);
}


// Command parsing lives in bot-command-parser.js so it can be edited without digging through index.js.


// Bare-name mode is OFF by default so normal TikTok chat words do not get saved as Ubisoft names.
// Users must type: queue UbisoftName.
// Set BARE_NAME_MODE=true only if you intentionally want plain-name fallback again.
let BARE_NAME_MODE = false;
const DEBUG_BARE_NAME = envBool(process.env.DEBUG_BARE_NAME, false);
const BARE_NAME_BLOCKLIST = new Set([
  'hi','hey','hello','yo','yes','no','ok','okay','lol','lmao','bro','bruh','nah','nahh','nahhh',
  'ready','start','stop','queue','join','play','game','ranked','custom','customs','siege','rainbow',
  'again','wait','hold','invite','inv','me','mine','name','username','ubisoft','ubi','clear','reset'
]);

function looksLikeKnownPlayerName(candidate, userKey = '') {
  const clean = String(candidate || '').replace(/\s+/g, '');
  if (!clean) return '';

  // Own saved name is always safe. This lets someone type only their saved name
  // when a viewer uses their exact saved/known name in internal checks.
  const ownRecord = getRecord(users, userKey);
  if (ownRecord.name && namesAreTooClose(clean, ownRecord.name)) return ownRecord.name;

  // If the exact/near name is already known from saved users or the current website queue,
  // allow the bare message and normalize to the known spelling. This is what catches
  // "lilcoper tretch" -> "LilcoperStretch" without accepting random chat.
  const knownName = findKnownNameForInput(clean, userKey);
  if (knownName) return knownName;

  return '';
}

function debugBareDecision(rawMsg, userKey, passed, reason, normalizedName = '') {
  if (!DEBUG_BARE_NAME) return;
  const safeMsg = String(rawMsg || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const key = userKey || '-';
  const result = passed ? `PASS → ${normalizedName}` : 'BLOCK';
  cmd(`[bare-debug] ${result} key=${key} msg="${safeMsg}" reason=${reason}`);
}

function getBareJoinName(rawMsg, userKey = '') {
  const pass = (name, reason) => {
    debugBareDecision(rawMsg, userKey, true, reason, name);
    return name;
  };
  const block = (reason) => {
    debugBareDecision(rawMsg, userKey, false, reason);
    return '';
  };

  if (!BARE_NAME_MODE) return block('BARE_NAME_MODE disabled');
  const text = String(rawMsg || '').trim();
  if (!text) return block('empty message');

  // Never treat real commands or normal punctuation-heavy chat as bare names.
  if (text.startsWith('!') || text.startsWith('/')) return block('starts with command prefix');
  if (text.length > 32) return block('too long before compaction');
  if (/[?"'`~:;,#$%^&*()[\]{}=+\\|<>]/.test(text)) return block('blocked punctuation');

  const words = text.split(/\s+/).filter(Boolean);

  const compact = text.replace(/\s+/g, '');
  if (compact.length < 3) return block('compacted length below 3');
  if (compact.length > 20) return block('compacted length above 20');
  if (!/^[A-Za-z0-9_.\-\s]+$/.test(text)) return block('invalid bare-name characters');
  if (!/[A-Za-z]/.test(compact)) return block('no letters');

  const normalized = normalizeForFilter(compact);
  if (!normalized) return block('normalizes to empty');
  if (BARE_NAME_BLOCKLIST.has(normalized)) return block(`blocklisted bare word: ${normalized}`);

  // Safest path: allow bare messages that match this viewer's saved name,
  // another known saved name that is not taken by someone else, or a current queue slot.
  const known = looksLikeKnownPlayerName(compact, userKey);
  if (known) return pass(known, 'known saved/queued name match');

  // Do not turn normal sentences into names. Example TikTok chat like
  // "I got 975" used to compact into "Igot975" and pass because it had a number.
  // Bare fallback should only guess short username-looking text, not phrases.
  const naturalPhraseWords = new Set([
    'i','im',"i\'m",'ive',"i\'ve",'id',"i\'d",'me','my','mine','we','us','you','your','yall',
    'got','get','have','has','had','need','want','wanna','can','cant','cannot','could','would','should',
    'am','are','is','was','were','be','been','being','do','does','did','done','go','going','play','playing',
    'add','invite','join','queue','put','let','make','run','start','stop','wait','hold','ready',
    'the','a','an','to','for','of','in','on','with','and','or','but','if','so','then','just','only','it',
    'gg','lol','lmao','bro','bruh','nah','yes','no','ok','okay','hi','hey','hello','yo'
  ]);
  const normalizedWords = words.map((w) => normalizeForFilter(w));

  // New bare names with 3+ words are too risky. Known/saved/queued matches already returned above.
  if (words.length > 2) return block('3+ words, likely normal chat');

  // If the message contains sentence words, ignore it as chat unless it matched a known player above.
  if (words.length > 1 && normalizedWords.some((w) => naturalPhraseWords.has(w))) {
    return block('multi-word sentence word detected');
  }

  // For new bare names, be MUCH stricter than command mode so normal chat does not flood the queue.
  // Accept only if it has clear username signals:
  //   braybray15, bray bray15, kouncil.b0t, SIMZER-_-, xXBlakeXx, LilcoperStretch
  // Reject normal words/phrases like: hello, can i play, add me, bray bray, I got 975.
  const hasNumber = /[0-9]/.test(compact);
  const hasSeparator = /[_.-]/.test(compact);
  const hasMixedCase = /[a-z]/.test(compact) && /[A-Z]/.test(compact);
  const hasAllCapsStyle = /^[A-Z0-9_.-]{4,}$/.test(compact) && /[A-Z]/.test(compact);
  const hasXxStyle = /^x{1,2}[A-Za-z0-9_.-]{3,}x{1,2}$/i.test(compact);

  // Phrase-smash guard: catch sentences typed as one token (no spaces) before we accept them.
  // "Igot975"    → alpha segment "igot" → split into "i"+"got" → both phrase words → BLOCK
  // "imready2"   → alpha segment "imready" → "im"+"ready" → both phrase words → BLOCK
  // "addme1"     → alpha segment "addme" → "add"+"me" → both phrase words → BLOCK
  // "caniplay9"  → alpha segment "caniplay" → "can"+"i"+"play" → all phrase words → BLOCK
  // "braybray15" → alpha segment "braybray" → no split produces phrase words → PASS
  if (hasNumber || words.length > 1) {
    const rawWordNorms = words.map(w => normalizeForFilter(w));
    // Direct word match (catches multi-word spaced phrases)
    const phraseWord = rawWordNorms.find(w => w.length > 0 && naturalPhraseWords.has(w));
    if (phraseWord) return block(`phrase word detected: ${phraseWord}`);

    // Segment split match (catches single-token smashed phrases)
    const alphaSegments = compact.split(/[0-9]+/).filter(Boolean).map(s => normalizeForFilter(s));
    for (const seg of alphaSegments) {
      if (!seg) continue;
      // Whole segment is a phrase word
      if (naturalPhraseWords.has(seg)) return block(`phrase-smash segment is word: ${seg}`);
      // Try every 2-part prefix+suffix split
      for (let cut = 1; cut < seg.length; cut++) {
        const prefix = seg.slice(0, cut);
        const suffix = seg.slice(cut);
        if (naturalPhraseWords.has(prefix) && naturalPhraseWords.has(suffix)) {
          return block(`phrase-smash split: ${prefix}+${suffix}`);
        }
      }
      // Try every 3-part split (catches "caniplay" → "can"+"i"+"play")
      for (let c1 = 1; c1 < seg.length - 1; c1++) {
        for (let c2 = c1 + 1; c2 < seg.length; c2++) {
          const p1 = seg.slice(0, c1), p2 = seg.slice(c1, c2), p3 = seg.slice(c2);
          if (naturalPhraseWords.has(p1) && naturalPhraseWords.has(p2) && naturalPhraseWords.has(p3)) {
            return block(`phrase-smash split: ${p1}+${p2}+${p3}`);
          }
        }
      }
    }
  }

  // Spaces are risky. Only allow spaced bare messages if they also have a number,
  // username punctuation, mixed caps, or match a known queue/saved name above.
  if (words.length > 1 && !(hasNumber || hasSeparator || hasMixedCase || hasAllCapsStyle || hasXxStyle)) {
    return block('spaced message without username signal');
  }

  // Single all-lowercase words with no numbers/punctuation are usually normal chat.
  // They can still join by typing queue name. Bare fallback should not guess these.
  if (!(hasNumber || hasSeparator || hasMixedCase || hasAllCapsStyle || hasXxStyle)) {
    return block('missing username signal');
  }

  const valid = validateName(text);
  if (!valid.ok) return block(`validateName failed: ${valid.error || 'invalid name'}`);
  return pass(valid.name, 'new bare username signal accepted');
}

// ── Persistent user store ───────────────────────────────────────────────────

function normalizeUsersObject(raw) {
  if (Array.isArray(raw)) {
    const out = {};
    for (const item of raw) {
      const key = normalizeTikTokUsername(displayUserKey(item?.tiktok || item?.tiktokId || item?.username || item?.user || item?.key || ''));
      const name = String(item?.name || item?.ubisoft || item?.ubisoftName || '').trim();
      if (!key || !name) continue;
      out[key] = { ...(item && typeof item === 'object' ? item : {}), name };
    }
    return out;
  }
  return raw && typeof raw === 'object' ? raw : {};
}

function loadUsers() {
  try {
    if (fs.existsSync(DATA_FILE)) return normalizeUsersObject(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (e) { err('Could not load users.json:', e.message); }
  return {};
}

function saveUsers(users) {
  try {
    // Merge with the current disk copy first so a stale in-memory bot cannot erase
    // admin edits that happened through /api/admin/bot-users/update.
    let disk = {};
    if (fs.existsSync(DATA_FILE)) {
      try { disk = normalizeUsersObject(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
      catch (_) { disk = {}; }
    }
    const merged = { ...disk, ...(users && typeof users === 'object' ? users : {}) };
    fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2));
    replaceUsersInMemory(merged);
  } catch (e) { err('Could not save users.json:', e.message); }
}


function replaceUsersInMemory(nextUsers) {
  for (const key of Object.keys(users)) delete users[key];
  for (const [key, value] of Object.entries(nextUsers || {})) {
    users[normalizeTikTokUsername(displayUserKey(key)) || key] = value;
  }
}

function reloadUsersFromDisk() {
  try {
    if (!fs.existsSync(DATA_FILE)) return false;
    const fresh = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!fresh || typeof fresh !== 'object' || Array.isArray(fresh)) return false;

    const currentKey = JSON.stringify(users);
    const freshKey = JSON.stringify(fresh);
    if (currentKey === freshKey) return false;

    replaceUsersInMemory(fresh);
    migrateUsersToGlobalKeys();
    return true;
  } catch (e) {
    warn(`Could not reload users.json: ${e.message}`);
    return false;
  }
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
  // Keep the admin panel's TikTok Saved Names list current after queue/q.
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

function platformUserKey(platform, username) {
  const clean = normalizeTikTokUsername(username || 'unknown');
  if (!clean || clean === 'unknown') return 'unknown';
  return platform === 'twitch' ? `twitch_${clean}` : clean;
}

function displayUserKey(key) {
  const parts = String(key || '').split(':');
  return parts.length > 1 ? parts.slice(1).join(':') : String(key || '');
}

// Build a stable key for saved names and cooldowns. TikTok usually gives uniqueId,
// but if it does not, do NOT store everybody under one shared "unknown" key.
function safeTikTokIdentity(data, display, sourceUsername = '') {
  const unique = normalizeTikTokUsername(
    data?.uniqueId ||
    data?.user?.uniqueId ||
    data?.userId ||
    data?.user?.id ||
    data?.user?.secUid ||
    ''
  );
  if (unique && unique !== 'unknown') return unique;

  const fallbackDisplay = normalizeTikTokUsername(display || data?.nickname || data?.user?.nickname || '');
  if (fallbackDisplay && fallbackDisplay !== 'unknown') return `display-${fallbackDisplay}`;

  return `anon-${normalizeTikTokUsername(sourceUsername || 'stream')}`;
}

function cooldownRemainingMs(key) {
  const last = cooldowns.get(key) || 0;
  return Math.max(0, COOLDOWN_MS - (Date.now() - last));
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

  // Tightened thresholds to reduce false "name taken" blocks on real different players.
  // Edit distance 2 only for long names (10+ chars). Distance 1 for medium (7-9).
  // Short names (<=6 chars like "Blake", "Scott") only match on exact canonical or skeleton — no fuzzy.
  const allowedDistance = minLen >= 10 ? 2 : minLen >= 7 ? 1 : 0;

  // Substring inclusion: require both sides to be at least 6 chars so short words
  // like "bray" don't accidentally swallow "braybray15".
  if (minLen >= 6 && (a.includes(b) || b.includes(a))) return true;

  // Fuzzy edit distance (skip when allowedDistance === 0 to avoid short-name false positives)
  if (allowedDistance > 0 && boundedEditDistance(a, b, allowedDistance) <= allowedDistance) return true;

  const sa = nameSkeleton(candidate);
  const sb = nameSkeleton(existing);
  if (sa === sb) return true;
  if (allowedDistance > 0 && boundedEditDistance(sa, sb, allowedDistance) <= allowedDistance) return true;

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
// (normalizeForFilter is defined earlier so it can be used during init)

const RESERVED_NAMES = new Set(['admin', 'owner', 'host', 'mod', 'moderator', 'null', 'undefined', 'everyone']);
const BAD_NAME_PATTERNS = [
  /n+i+g+g+/, /f+a+g+/, /r+e+t+a+r+d+/, /k+i+l+l+y+o+u+/, /k+y+s+/, /h+i+t+l+e+r+/, /n+a+z+i+/,
  /c+u+n+t+/, /b+i+t+c+h+/, /p+u+s+s+y+/, /d+i+c+k+/, /c+o+c+k+/, /s+h+i+t+/, /f+u+c+k+/,
];

function validateName(rawName) {
  const raw = String(rawName || '').replace(/\s+/g, ' ').trim();
  if (!raw) return { ok: false, reason: 'Type one name after queue. Example: queue Blake' };

  // Console players can have spaces in their displayed Ubisoft/console name.
  // Keep the spaces, but normalize multiple spaces down to one.
  const clean = raw;
  if (clean.length < 3) return { ok: false, reason: 'Name must be at least 3 characters.' };
  if (clean.length > 24) return { ok: false, reason: 'Name must be 24 characters or fewer.' };
  if (!/[a-zA-Z]/.test(clean)) return { ok: false, reason: 'Name must include at least one letter.' };
  if (!/^[a-zA-Z0-9_.\- ]+$/.test(clean)) return { ok: false, reason: 'Use letters, numbers, spaces, _ . - only.' };

  const normalized = normalizeForFilter(clean);
  if (RESERVED_NAMES.has(normalized)) return { ok: false, reason: 'That name is reserved. Pick a different name.' };
  if (BLOCKED_EXACT_NAMES.has(normalized)) return { ok: false, reason: 'That name is blocked. Pick a different name.' };
  if (BAD_NAME_PATTERNS.some(re => re.test(normalized))) return { ok: false, reason: 'That name is not allowed. Pick a clean name.' };
  return { ok: true, name: clean, console: /\s/.test(clean) };
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

const POST_WARNING_THROTTLE_MS = 30_000;
const lastPostWarningAt = new Map();

function warnPostFailure(key, message) {
  const now = Date.now();
  const last = lastPostWarningAt.get(key) || 0;
  if (now - last < POST_WARNING_THROTTLE_MS) return;
  lastPostWarningAt.set(key, now);
  warn(message);
}

async function responseFailureDetail(res) {
  let body = '';
  try { body = await res.text(); } catch (_) {}
  body = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return `${res.status} ${res.statusText || ''}${body ? ` - ${body}` : ''}`.trim();
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
  return t.includes('already in queue') || t.includes('in the queue') || t.includes('already playing') || t.includes('currently playing');
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
  reloadUsersFromDisk();
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

      // If this account was reset locally, do not let a stale admin override
      // immediately put the old name back.
      if (users[tiktok] && typeof users[tiktok] === 'object' && users[tiktok].resetAt && !old.name) continue;

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


// Persist a TikTok -> Ubisoft saved-name match to the website/admin store too.
// The bot's local DATA_FILE is not enough for the admin Saved Names panel.
async function saveSavedNameOnServer(tiktokKeys = [], ubisoftName = '') {
  if (!ADMIN_PASSWORD) return false;
  const cleanName = String(ubisoftName || '').trim();
  if (!cleanName) return false;

  const keys = [...new Set(
    (Array.isArray(tiktokKeys) ? tiktokKeys : [tiktokKeys])
      .map(k => normalizeTikTokUsername(displayUserKey(k)))
      .filter(Boolean)
  )];

  let saved = false;
  for (const tiktok of keys) {
    try {
      const r = await fetchWithTimeout(`${BASE_URL}/api/admin/bot-users/update`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          tiktok,
          username: tiktok,
          platform: tiktok.startsWith('twitch_') || tiktok.startsWith('twitch:') ? 'twitch' : 'tiktok',
          twitchUsername: tiktok.startsWith('twitch_') ? tiktok.replace(/^twitch_/i, '') : '',
          ubisoft: cleanName,
          ubisoftName: cleanName,
          name: cleanName
        }),
      }, 6_000);
      if (r.ok) saved = true;
      else if (r.status !== 404) {
        const text = await r.text().catch(() => '');
        warn(`[saved-name] server save failed for @${tiktok} -> ${cleanName}: ${r.status} ${text}`);
      }
    } catch (e) {
      if (!String(e.message || '').includes('aborted')) warn(`[saved-name] server save network issue for @${tiktok}: ${e.message}`);
    }
  }
  return saved;
}

async function deleteSavedNameOnServer(tiktokKeys = []) {
  if (!ADMIN_PASSWORD) return false;
  const keys = [...new Set(
    (Array.isArray(tiktokKeys) ? tiktokKeys : [tiktokKeys])
      .map(k => normalizeTikTokUsername(displayUserKey(k)))
      .filter(Boolean)
  )];

  let changed = false;
  for (const tiktok of keys) {
    const attempts = [
      { url: `${BASE_URL}/api/admin/bot-users/delete`, method: 'POST', body: { tiktok, username: tiktok } },
      { url: `${BASE_URL}/api/admin/bot-users/remove`, method: 'POST', body: { tiktok, username: tiktok } },
      { url: `${BASE_URL}/api/admin/bot-users/update`, method: 'POST', body: { tiktok, username: tiktok, name: '', ubisoft: '', ubisoftName: '' } },
      { url: `${BASE_URL}/api/admin/bot-user-overrides/delete`, method: 'POST', body: { tiktok, username: tiktok } },
      { url: `${BASE_URL}/api/admin/bot-users/${encodeURIComponent(tiktok)}`, method: 'DELETE', body: null },
    ];
    for (const attempt of attempts) {
      try {
        const r = await fetchWithTimeout(attempt.url, {
          method: attempt.method,
          headers: authHeaders(),
          ...(attempt.body ? { body: JSON.stringify(attempt.body) } : {}),
        }, 6_000);
        if (r.status === 404) continue;
        if (r.ok) { changed = true; break; }
      } catch (_) {}
    }
  }
  return changed;
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

    // Bare-name fallback toggle — can be flipped live from admin panel
    if (cfg.bareNameMode !== undefined && cfg.bareNameMode !== null) {
      const next = cfgBool(cfg.bareNameMode, BARE_NAME_MODE);
      if (next !== BARE_NAME_MODE) {
        info(`[sync] bareNameMode updated: ${BARE_NAME_MODE} → ${next}`);
        BARE_NAME_MODE = next;
      }
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
    // The admin can turn either live chat on/off without admin editemoving the saved usernames.
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

    // Twitch channel settings from the admin panel. Twitch shares the same saved-name JSON,
    // but each Twitch account is stored with a twitch_ prefix so it never collides with TikTok.
    const beforeTwitchKey = JSON.stringify({ enabled: Boolean(TWITCH_ENABLED), channels: twitchChannelsKey(TWITCH_CHANNELS) });
    if (cfg.twitchEnabled !== undefined || cfg.twitchChannel !== undefined || cfg.twitchChannels !== undefined) {
      TWITCH_ENABLED = boolFromConfigOrEnv(cfg.twitchEnabled, TWITCH_ENABLED);
      const nextTwitchChannels = Array.isArray(cfg.twitchChannels)
        ? cfg.twitchChannels
        : String(cfg.twitchChannel || '').split(',');
      const parsedTwitchChannels = parseTwitchChannelList(nextTwitchChannels);
      const configTouchedTwitchChannels = cfg.twitchChannels !== undefined || cfg.twitchChannel !== undefined;
      if (parsedTwitchChannels.length || (configTouchedTwitchChannels && !TWITCH_ENV_FORCE_ENABLED)) {
        TWITCH_CHANNELS = parsedTwitchChannels;
      }
    }
    TWITCH_CHANNELS = parseTwitchChannelList(TWITCH_CHANNELS);
    const afterTwitchKey = JSON.stringify({ enabled: Boolean(TWITCH_ENABLED), channels: twitchChannelsKey(TWITCH_CHANNELS) });
    if (afterTwitchKey !== beforeTwitchKey) {
      info(`[sync] Twitch chat ${TWITCH_ENABLED ? 'enabled' : 'disabled'}: ${twitchChannelsDisplay() || 'no channels'}`);
      restartTwitchChat();
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

      const displayKey = displayUserKey(tiktok);
      const isTwitch = String(tiktok).toLowerCase().startsWith('twitch_') || String(tiktok).toLowerCase().startsWith('twitch:');
      const twitchUsername = isTwitch ? displayKey.replace(/^twitch[_:]/i, '') : '';
      const tiktokUsername = isTwitch ? '' : displayKey;

      return {
        tiktok,
        platform: isTwitch ? 'twitch' : 'tiktok',
        twitchUsername,
        tiktokUsername,
        username: isTwitch ? twitchUsername : tiktokUsername,
        account: isTwitch ? twitchUsername : tiktokUsername,
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

// Fire-and-forget: send every raw TikTok message to the server ring buffer.
// Non-critical — never throws, never awaited by the caller.
function mirrorChatMessage({ platform = 'tiktok', stream, tiktokId, twitchUsername, username, nickname, msg, event }) {
  if (!ADMIN_PASSWORD) return;
  const cleanPlatform = String(platform || 'tiktok').toLowerCase() === 'twitch' ? 'twitch' : 'tiktok';
  const account = username || twitchUsername || tiktokId || '';
  fetchWithTimeout(`${BASE_URL}/api/bot/chat`, {
    method : 'POST',
    headers: authHeaders(),
    body   : JSON.stringify({
      platform: cleanPlatform,
      stream,
      username: account,
      tiktokId: cleanPlatform === 'tiktok' ? account : '',
      tiktokUsername: cleanPlatform === 'tiktok' ? account : '',
      twitchUsername: cleanPlatform === 'twitch' ? account : '',
      nickname,
      msg,
      event,
      ts: Date.now()
    }),
  }, 4_000).then(async (res) => {
    if (res.ok) return;
    const detail = await responseFailureDetail(res);
    warnPostFailure('chat-mirror', `Live chat mirror failed at /api/bot/chat: ${detail}`);
    postAdminLog('warn', 'chat-mirror', `Live chat mirror failed at /api/bot/chat: ${detail}`, {
      endpoint: '/api/bot/chat',
      status: res.status,
      platform: cleanPlatform,
      stream,
    }).catch(() => {});
  }).catch((e) => {
    const message = e?.message || String(e || 'unknown error');
    warnPostFailure('chat-mirror', `Live chat mirror could not reach ${BASE_URL}/api/bot/chat: ${message}`);
  });
}

async function postAdminLog(type, category, message, meta = {}) {
  if (!ADMIN_PASSWORD) return;
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/api/bot/log`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ type, category, message, meta }),
    }, 4_000);
    if (!res.ok) {
      const detail = await responseFailureDetail(res);
      warnPostFailure('bot-log', `Live bot log post failed at /api/bot/log: ${detail}`);
    }
  } catch (e) {
    const errMsg = e?.message || String(e || 'unknown error');
    warnPostFailure('bot-log', `Live bot log post could not reach ${BASE_URL}/api/bot/log: ${errMsg}`);
  }
}

async function postBotStatusToServer(extra = {}) {
  if (!ADMIN_PASSWORD) return;
  const savedUsers = getSavedUsersForAdmin();
  const knownRecords = Object.keys(users).length;
  const savedNameCount = savedUsers.length;
  const emptyRecords = Math.max(0, knownRecords - savedNameCount);
  const queuedRecords = savedUsers.filter(r => r?.queued || r?.active || r?.inQueue || r?.playing).length;
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/api/bot/status`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        connected    : extra.connected    ?? botConnected,
        connecting   : extra.connecting   ?? false,
        error        : extra.error        ?? null,
        viewers      : extra.viewers      ?? currentViewers,
        roomId       : extra.roomId       ?? currentRoomId,
        twitchEnabled : TWITCH_ENABLED,
        twitchConnected,
        twitchChannels: TWITCH_CHANNELS,
        lastActivity : new Date().toISOString(),
        processUptime: Math.floor(process.uptime()),
        // knownUsers is kept for old server/admin builds and now means real saved names.
        knownUsers: savedNameCount,
        savedNameCount,
        totalSavedNames: savedNameCount,
        knownRecords,
        totalRecords: knownRecords,
        emptyRecords,
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
    if (!res.ok) {
      const detail = await responseFailureDetail(res);
      warnPostFailure('bot-status', `Bot status post failed at /api/bot/status: ${detail}`);
    }
  } catch (e) {
    const errMsg = e?.message || String(e || 'unknown error');
    warnPostFailure('bot-status', `Bot status post could not reach ${BASE_URL}/api/bot/status: ${errMsg}`);
  }
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

function findKnownNameForInput(name, tiktokId) {
  // If this TikTok account already owns a saved name, tolerate spacing/capital/near-typo versions.
  const ownRecord = getRecord(users, tiktokId);
  if (ownRecord.name && namesAreTooClose(name, ownRecord.name)) return ownRecord.name;

  // Do not map a typo onto somebody else's saved Ubisoft name. That still needs to be blocked.
  const savedConflict = findSavedNameTakenByOther(name, tiktokId);
  if (savedConflict) return '';

  // If the website already has a manually-added/stale slot with this same/near name and nobody owns it,
  // use the website's exact spelling instead of treating the command as ignored or rejected.
  for (const p of [...liveQueue, ...livePlaying]) {
    if (p.name && namesAreTooClose(name, p.name)) return p.name;
  }
  return '';
}

function ownNameIsActive(record) {
  return Boolean(record.name) && (record.queued || isInQueue(record.name) || isPlaying(record.name));
}
function recordFromValue(value) {
  if (!value) return { name: '', queued: false };
  if (typeof value === 'string') return { name: value, queued: false };
  return { name: value.name || '', queued: Boolean(value.queued) };
}

// Returns true if ownerStorageKey and incomingStorageKey are the same person on
// different platforms (one is twitch_X, the other is a TikTok key that already
// has the same Ubisoft name saved).  Used to allow cross-platform name linking
// instead of falsely reporting "name taken".
function isCrossPlatformSamePerson(ownerStorageKey, incomingStorageKey, ubisoftName) {
  const ownerIsTwitch   = String(ownerStorageKey   || '').startsWith('twitch_');
  const incomingIsTwitch = String(incomingStorageKey || '').startsWith('twitch_');

  // Must be on different platforms to qualify.
  if (ownerIsTwitch === incomingIsTwitch) return false;

  // The Ubisoft name must actually match — we already know it does at the call-site,
  // but this makes the helper self-contained.
  const ownerRec   = recordFromValue(users[ownerStorageKey]);
  const incomingRec = recordFromValue(users[incomingStorageKey]);
  if (!ownerRec.name) return false;
  if (canonicalName(ownerRec.name) !== canonicalName(ubisoftName)) return false;

  // If the incoming key has NO saved name yet, it's a new cross-platform registration
  // for the same Ubisoft name — allow it.
  if (!incomingRec.name) return true;

  // If the incoming key already has the SAME Ubisoft name saved, same person — allow.
  if (canonicalName(incomingRec.name) === canonicalName(ownerRec.name)) return true;

  return false;
}

function findSavedNameTakenByOther(name, tiktokId) {
  const key = canonicalName(name);
  const ownKey = normalizeTikTokUsername(displayUserKey(tiktokId));
  if (!key) return null;

  for (const [rawOwner, value] of Object.entries(users)) {
    const ownerKey = normalizeTikTokUsername(displayUserKey(rawOwner));
    if (!ownerKey || ownerKey === ownKey) continue;

    const rec = recordFromValue(value);
    if (!rec.name) continue;

    // Exact same saved Ubisoft name — check before declaring it taken.
    if (canonicalName(rec.name) === key) {
      // If the owner is on a different platform and has no name conflict,
      // this is the same person registering their name cross-platform — not a conflict.
      if (isCrossPlatformSamePerson(rawOwner, tiktokId, name)) continue;
      return rec.name;
    }

    // Also block obvious copycat versions of another saved Ubisoft name,
    // but only if it's not the same person on a different platform.
    if (namesAreTooClose(name, rec.name)) {
      if (isCrossPlatformSamePerson(rawOwner, tiktokId, name)) continue;
      return rec.name;
    }
  }

  return null;
}

function findNameTakenByOther(name, tiktokId) {
  const key = canonicalName(name);
  if (!key) return null;

  const savedConflict = findSavedNameTakenByOther(name, tiktokId);
  if (savedConflict) return savedConflict;

  const ownRecord = getRecord(users, tiktokId);

  for (const p of [...liveQueue, ...livePlaying]) {
    if (!p.name) continue;
    const activeKey = canonicalName(p.name);

    // Skip this person's own saved name - whether exact or near match.
    // Without this, rejoining by command can falsely report "already taken"
    // because namesAreTooClose fires on their own queue slot before ownNameIsActive runs.
    if (ownRecord.name && namesAreTooClose(p.name, ownRecord.name)) continue;

    // If a name is already on the website queue but nobody owns it in
    // tiktok-names.json, allow the person to claim that exact active slot.
    // This fixes stale/manual queue slots showing as false "already taken".
    if (activeKey === key) continue;

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

const TIKTOK_REQUEST_TIMEOUT_MS = Number(process.env.TIKTOK_REQUEST_TIMEOUT_MS || 30_000);
const TIKTOK_WEBSOCKET_TIMEOUT_MS = Number(process.env.TIKTOK_WEBSOCKET_TIMEOUT_MS || 30_000);
const TIKTOK_USER_AGENT = process.env.TIKTOK_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function buildTikTokOptions(username) {
  const sessionId = getSessionIdForUsername(username);
  // Newer tiktok-live-connector versions require tt-target-idc alongside sessionId.
  // Read it from TIKTOK_TARGET_IDC env var (e.g. "useast2a"). If not set,
  // we omit the session so the bot starts without crashing (anonymous mode).
  const targetIdc = String(process.env.TIKTOK_TARGET_IDC || '').trim();
  const useSession = Boolean(sessionId && targetIdc);
  if (sessionId && !targetIdc) {
    warn('TIKTOK_SESSION_ID is set but TIKTOK_TARGET_IDC is not — connecting without session (anonymous mode). Set TIKTOK_TARGET_IDC to enable authenticated mode.');
  }
  return {
    enableExtendedGiftInfo  : false,
    enableWebsocketUpgrade  : true,
    requestPollingIntervalMs: 2_000,
    processInitialData      : true,
    requestOptions: {
      timeout: TIKTOK_REQUEST_TIMEOUT_MS,
      headers: {
        'user-agent': TIKTOK_USER_AGENT,
        'accept-language': 'en-US,en;q=0.9',
      },
    },
    websocketOptions: {
      timeout: TIKTOK_WEBSOCKET_TIMEOUT_MS,
    },
    ...(useSession ? { sessionId, ttTargetIdc: targetIdc } : {}),
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
  if (!hasTikTokConnector()) {
    if (entry) {
      entry.conn = null;
      entry.connected = false;
      entry.connecting = false;
    }
    warnMissingTikTokConnector(`creating connection for @${entry?.username || 'unknown'}`);
    return null;
  }

  // Important: tiktok-live-connector can get stuck after a failed/offline connect.
  // Make a brand-new connection object every time we retry, so one offline stream
  // never blocks the other stream and nobody has to redeploy when going live later.
  try {
    if (entry.conn) entry.conn.disconnect();
  } catch (_) {}

  try {
    entry.conn = new WebcastPushConnection(entry.username, buildTikTokOptions(entry.username));
  } catch (connErr) {
    const connErrMsg = connErr?.message || String(connErr);
    err(`Failed to create TikTok connection for @${entry.username}: ${connErrMsg}`);
    postAdminLog('error', 'tiktok', `Failed to create TikTok connection for @${entry.username}: ${connErrMsg}`).catch(() => {});
    entry.conn = null;
    entry.connecting = false;
    entry.connected = false;
    return null;
  }
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
    retryDelay: 10_000,
    reconnectTimer: null,
    connectTimeout: null,
    connecting: false,
    connected: false,
    currentViewers: 0,
    currentRoomId: null,
    lastConnectAttempt: 0,
    lastAnyEventAt: 0,
    lastChatAt: 0,
  };
  streams.set(username, entry);
  createFreshTikTokConnection(entry);
  return entry;
}

function disconnectStream(username) {
  const entry = streams.get(username);
  if (!entry) return;
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  if (entry.connectTimeout) clearTimeout(entry.connectTimeout);
  entry.reconnectTimer = null;
  entry.connectTimeout = null;
  entry.connecting = false;
  entry.connected = false;
  try { if (entry.conn) entry.conn.disconnect(); } catch (_) {}
  streams.delete(username);
  updateAggregateBotState();
}


function canRebuildTikTokNow(sourceUsername) {
  const key = normalizeTikTokUsername(sourceUsername);
  const until = Number(rebuildingUntil.get(key) || 0);
  const now = Date.now();

  if (until && now < until) {
    const waitMs = Math.ceil((until - now) / 1000);
    postAdminLog('warn', 'tiktok', `@${key}: TikTok is still settling after a chat-cursor error. Waiting ${waitMs}s before rebuilding again instead of spam-reconnecting.`);
    return false;
  }

  rebuildingUntil.set(key, now + REBUILD_COOLDOWN_MS);
  return true;
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
  const safeDelay = Math.min(MAX_RETRY_MS, Math.max(3_000, Number(delayMs || 10_000)));
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
  if (!hasTikTokConnector()) {
    warnMissingTikTokConnector(`connecting @${username}`);
    return;
  }

  entry.connecting = true;
  entry.lastConnectAttempt = Date.now();
  const currentConn = createFreshTikTokConnection(entry);
  if (!currentConn) return;

  // If TikTok never answers while the live is offline/starting, do not stay stuck
  // in "connecting" forever. Reset this stream and keep scanning for the live.
  if (entry.connectTimeout) clearTimeout(entry.connectTimeout);
  entry.connectTimeout = setTimeout(() => {
    // If another reconnect already replaced this connection, this timeout belongs
    // to an old attempt. Do not let it disconnect the newer connection.
    if (entry.conn !== currentConn) return;
    if (!entry.connected) {
      warn(`TikTok connect timed out for @${entry.username}. Keeping it armed and trying again.`);
      postAdminLog('warn', 'tiktok', `TikTok connect timed out for @${entry.username}. Retrying.`);
      entry.connecting = false;
      entry.connected = false;
      entry.conn = null;
      try { if (currentConn) currentConn.disconnect(); } catch (_) {}
      updateAggregateBotState();
      postBotStatusToServer({ connected: botConnected, connecting: false, error: `@${entry.username}: connect timeout` });
      scheduleReconnect(entry.username, 5_000);
    }
  }, CONNECT_TIMEOUT_MS);

  const hasSession = !!getSessionIdForUsername(entry.username);
  info(`Connecting to @${entry.username}… ${hasSession ? '(sessionid set)' : '(no sessionid)'}`);
  postAdminLog('info', 'tiktok', `Connecting to @${entry.username}${hasSession ? ' with sessionid' : ' without sessionid'}`);
  updateAggregateBotState();
  postBotStatusToServer({ connecting: true, connected: botConnected });

  currentConn.connect()
    .then(state => {
      if (entry.conn !== currentConn) return;
      if (entry.connectTimeout) clearTimeout(entry.connectTimeout);
      entry.connectTimeout = null;
      entry.connecting = false;
      entry.retryDelay = 10_000;
      entry.connected = true;
      entry.currentRoomId = state?.roomId ? String(state.roomId) : null;
      entry.lastAnyEventAt = Date.now();
      entry.lastChatAt = 0;
      ok(`Connected to TikTok Live @${entry.username}`);
      postAdminLog('success', 'tiktok', `Connected to TikTok Live @${entry.username}`, { roomId: entry.currentRoomId });
      if (state?.roomId) info(`@${entry.username} Room ID: ${state.roomId}`);
      updateAggregateBotState();
      postBotStatusToServer({ connected: botConnected, connecting: false, roomId: currentRoomId });
    })
    .catch(e => {
      if (entry.conn !== currentConn) return;
      if (entry.connectTimeout) clearTimeout(entry.connectTimeout);
      entry.connectTimeout = null;
      entry.connecting = false;
      entry.connected = false;
      entry.currentRoomId = null;
      const hint = e?.exception?.retryAfter ?? e?.retryAfter;
      // TikTok sometimes returns retryAfter: 120 after a short hiccup.
      // That made the bot go silent for about 2 minutes. Cap every retry.
      const hintedDelay = hint ? Number(hint) * 1_000 : entry.retryDelay;
      const delay = Math.min(MAX_RETRY_MS, Math.max(3_000, Number(hintedDelay || entry.retryDelay || 10_000)));
      entry.retryDelay = Math.min(Math.max(10_000, entry.retryDelay * 2), MAX_RETRY_MS);
      updateAggregateBotState();

      const message = safeTikTokErrorMessage(e);
      err(`TikTok connect failed for @${entry.username}: ${message}`);
      postAdminLog('error', 'tiktok', `TikTok connect failed for @${entry.username}: ${message}`);
      if (!getSessionIdForUsername(entry.username)) warn(`Tip: set a sessionid for @${entry.username}. Use TIKTOK_SESSION_ID for primary, TIKTOK_SESSION_ID_2 for the second stream, or TIKTOK_SESSION_IDS=username=sessionid.`);
      info(`Keeping @${entry.username} armed. Retrying in ${Math.round(delay / 1000)}s so you do NOT have to redeploy when that live starts.`);
      postAdminLog('info', 'tiktok', `Keeping @${entry.username} armed. Retrying in ${Math.round(delay / 1000)}s`);
      postBotStatusToServer({ connected: botConnected, connecting: false, error: `@${entry.username}: ${message}` });
      scheduleReconnect(entry.username, delay);
    });
}

function connectAllTikTok() {
  rebuildTikTokConnections();
  const activeUsers = getStreamUsers();
  if (activeUsers.length && !hasTikTokConnector()) {
    warnMissingTikTokConnector('starting TikTok streams');
    return;
  }
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
  const now = Date.now();

  for (const username of activeUsers) {
    const entry = ensureStream(username);
    if (!entry) continue;
    if (!hasTikTokConnector()) {
      warnMissingTikTokConnector(`watchdog @${username}`);
      continue;
    }

    // If a connection attempt gets stuck, force it loose and retry.
    if (entry.connecting && entry.lastConnectAttempt && now - entry.lastConnectAttempt > CONNECT_TIMEOUT_MS + 10_000) {
      warn(`Watchdog: @${entry.username} has been connecting too long — resetting connection.`);
      entry.connecting = false;
      entry.connected = false;
      if (entry.connectTimeout) clearTimeout(entry.connectTimeout);
      entry.connectTimeout = null;
      const oldConn = entry.conn;
      entry.conn = null;
      try { if (oldConn) oldConn.disconnect(); } catch (_) {}
    }

    if (entry.connected && entry.lastAnyEventAt && now - entry.lastAnyEventAt > STALE_CONNECTED_MS) {
      forceFreshTikTokReconnect(entry.username, `connected but no TikTok room/chat events for ${Math.round((now - entry.lastAnyEventAt) / 1000)}s`, 8_000);
      continue;
    }

    if (!entry.connected && !entry.connecting && !entry.reconnectTimer) {
      info(`Live scanner: @${entry.username} is not connected — checking again now.`);
      connectTikTok(entry.username);
    }
  }
}

setInterval(keepTikTokConnectionsAlive, LIVE_SCAN_MS);

function twitchChannelFromSource(sourceUsername = '') {
  const source = String(sourceUsername || '').trim();
  const match = source.match(/^twitch:\s*#?([^,\s]+)/i);
  return match ? cleanTwitchChannel(match[1]) : '';
}

function sendTwitchChatReply(sourceUsername = '', message = '') {
  const channel = twitchChannelFromSource(sourceUsername);
  const reply = String(message || '').trim().slice(0, 450);
  if (!channel || !reply) return;
  if (!TWITCH_BOT_USERNAME || !TWITCH_OAUTH_TOKEN) return;
  if (!twitchClient || !twitchConnected || typeof twitchClient.say !== 'function') return;

  twitchClient.say(`#${channel}`, reply).catch(e => {
    warn(`Twitch reply failed in #${channel}: ${e?.message || e}`);
  });
}

// TikTok is read-only; Twitch can reply when bot credentials are configured.
function respond(tiktokId, message, sourceUsername = '') {
  log('CHAT ←', C.cyan, `${sourceUsername ? '[' + sourceUsername + '] ' : ''}@${tiktokId}: ${message}`);
  sendTwitchChatReply(sourceUsername, message);
}

function safeTikTokErrorMessage(e) {
  if (!e) return 'unknown TikTok error';
  if (typeof e === 'string') return e;
  if (e.message) return String(e.message);
  if (e.info) return String(e.info);
  if (e.error) return safeTikTokErrorMessage(e.error);
  try {
    const json = JSON.stringify(e);
    return json && json !== '{}' ? json : 'TikTok returned an empty error object';
  } catch (_) {
    return String(e);
  }
}

function shouldHardReconnectTikTok(message) {
  const m = String(message || '').toLowerCase();
  return m.includes('missing cursor')
    || m.includes('cursor')
    || m.includes('fetch response')
    || m.includes('websocket')
    || m.includes('socket')
    || m.includes('econnreset')
    || m.includes('aborted')
    || m.includes('terminated')
    || m.includes('stream ended')
    || m.includes('live has ended');
}

function markTikTokEvent(entry) {
  if (!entry) return;
  entry.lastAnyEventAt = Date.now();
}

function forceFreshTikTokReconnect(username, reason, delayMs = 8_000) {
  username = normalizeTikTokUsername(username);
  const entry = streams.get(username);
  if (!entry || !getStreamUsers().includes(username)) return;

  // Missing Cursor can fire several times in a row from the same broken TikTok session.
  // Rebuild once, then cool down instead of spam-rebuilding every few seconds.
  if (!canRebuildTikTokNow(username)) {
    return;
  }

  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  if (entry.connectTimeout) clearTimeout(entry.connectTimeout);
  entry.reconnectTimer = null;
  entry.connectTimeout = null;
  entry.connecting = false;
  entry.connected = false;
  entry.currentRoomId = null;

  // Disconnect the broken connection and immediately detach it from this stream.
  // Old tiktok-live-connector objects can still emit late error/disconnected events;
  // registerTikTokEvents() ignores those now because entry.conn no longer matches them.
  const oldConn = entry.conn;
  entry.conn = null;
  try { if (oldConn) oldConn.disconnect(); } catch (_) {}
  updateAggregateBotState();

  const seconds = Math.round(Math.max(0, delayMs) / 1000);
  warn(`Watchdog: scheduling fresh TikTok reconnect @${username} — ${reason}. Reconnecting in ${seconds}s.`);
  postAdminLog('warn', 'tiktok', `@${username}: TikTok chat cursor broke (${reason}). Scheduling one safe reconnect in ${seconds}s.`, { username, reason });
  postBotStatusToServer({ connected: botConnected, connecting: false, error: `@${username}: reconnecting — ${reason}` });
  scheduleReconnect(username, delayMs);
}

// ── Chat handler ────────────────────────────────────────────────────────────

// ── Shared per-user deduplication maps (keyed by platform|stream|userId|msg) ──
// Kept module-level so TikTok and Twitch share the same dedup window and a
// Twitch command never races with a TikTok command for the same user.
const globalRecentCommands = new Map();

// ── Core queue command handler — called by BOTH TikTok and Twitch ──────────
// `entry` is the TikTok stream entry (for markTikTokEvent / lastChatAt) or null
// when called from Twitch with no TikTok session active.
async function handleChatCommand(data, eventName = 'chat', overrides = {}, entry = null) {
    const platform = String(overrides.platform || 'tiktok').toLowerCase();
    // For TikTok: ignore late callbacks from stale connection objects.
    if (platform === 'tiktok' && entry && overrides._tiktokConn && entry.conn !== overrides._tiktokConn) return;
    const sourceLabel = String(overrides.sourceUsername || (entry ? entry.username : '') || platform).trim();
    const display  = overrides.displayName || data?.nickname || data?.user?.nickname || data?.uniqueId || data?.user?.uniqueId || 'unknown';
    const rawTikTokId = overrides.rawUserId || safeTikTokIdentity(data, display, sourceLabel);
    const tiktokId = rawTikTokId;
    const userKey = overrides.userKey || (platform === 'twitch' ? platformUserKey('twitch', rawTikTokId) : streamUserKey(sourceLabel, rawTikTokId));
    const msg      = String(data?.comment || data?.text || data?.content || data?.msg || '').trim();
    const lower    = msg.toLowerCase();
    if (platform === 'tiktok' && entry) {
      markTikTokEvent(entry);
      entry.lastChatAt = Date.now();
    }

    // Pick up admin edits/deletes to saved TikTok names without restarting the bot.
    reloadUsersFromDisk();

    // ── Mirror every raw message to the server for live monitoring ────────────
    // This runs BEFORE any command filtering so you can see exactly what TikTok
    // is delivering — whether commands arrive at all, and from whom.
    mirrorChatMessage({
      platform,
      stream: sourceLabel,
      tiktokId: platform === 'tiktok' ? rawTikTokId : '',
      twitchUsername: platform === 'twitch' ? rawTikTokId : '',
      username: rawTikTokId,
      nickname: display,
      msg,
      event: eventName
    });

    const bareJoinName = '';
    const isBareJoin = false;
    const parsedCommand = parseBotCommandMessage(msg);
    const isJoinCmd  = parsedCommand.type === 'join';
    const isTempCmd  = parsedCommand.type === 'temp';
    const isResetCmd = parsedCommand.type === 'reset';
    const isLeaveCmd = parsedCommand.type === 'leave';
    const isCmd = isJoinCmd || isTempCmd || isResetCmd || isLeaveCmd;
    if (!isCmd) return;

    cmd(`[${sourceLabel}] queue command heard from @${display} / key=${userKey}: ${msg}`);
    postAdminLog('info', 'queue', `@${display} typed ${msg}`, { stream: sourceLabel, platform, tiktokId });

    // Prevent duplicate handling if a connector emits both `chat` and `comment`
    // for the same message. Also deduplicates across TikTok and Twitch for the same user.
    const now = Date.now();
    for (const [key, t] of globalRecentCommands) {
      if (now - t > 2500) globalRecentCommands.delete(key);
    }
    const dedupeKey = `${platform}|${sourceLabel}|${rawTikTokId}|${lower}`;
    if (globalRecentCommands.has(dedupeKey)) return;
    globalRecentCommands.set(dedupeKey, now);

    if (BANNED_TIKTOK_USERS.has(tiktokId)) {
      cmd(`[${sourceLabel}] [blocked] @${display} tried command: ${msg}`);
      postAdminLog('warn', 'queue', `Blocked user @${display} tried ${msg}`, { stream: sourceLabel, platform, tiktokId });
      return;
    }

    // Only rate-limit queue/temp JOIN and RESET commands (leave is always allowed).
    const cooldownKey = `${userKey}:join`;
    if ((isJoinCmd || isTempCmd) && isOnCooldown(cooldownKey)) {
      const left = Math.ceil(cooldownRemainingMs(cooldownKey) / 1000);
      cmd(`[${sourceLabel}] [cooldown] @${display} / key=${userKey} — ignored join (${left}s left, per-user cooldown)`);
      postAdminLog('warn', 'queue', `Cooldown ignored @${display}: wait ${left}s`, { stream: sourceLabel, tiktokId, userKey, cooldownKey, remainingSeconds: left });
      return;
    }


    // ── reset — clear saved name and leave queue if active ─────────────────────
    if (isResetCmd) {
      const resetCooldownKey = `${userKey}:reset`;
      if (isOnCooldown(resetCooldownKey)) {
        cmd(`[${sourceLabel}] [cooldown] @${display} — ignored reset (${COOLDOWN_MS / 1000}s cooldown)`);
        return;
      }
      setCooldown(resetCooldownKey);

      reloadUsersFromDisk();

      const aliasKeys = platform === 'twitch'
        ? new Set([normalizeTikTokUsername(userKey)].filter(Boolean))
        : new Set([
            normalizeTikTokUsername(userKey),
            normalizeTikTokUsername(rawTikTokId),
            normalizeTikTokUsername(display),
            normalizeTikTokUsername(data?.uniqueId || ''),
            normalizeTikTokUsername(data?.user?.uniqueId || ''),
            normalizeTikTokUsername(data?.userId || ''),
            normalizeTikTokUsername(data?.user?.id || ''),
            normalizeTikTokUsername(data?.nickname || ''),
            normalizeTikTokUsername(data?.user?.nickname || ''),
          ].filter(Boolean));

      let oldName = '';
      for (const key of aliasKeys) {
        const rec = getRecord(users, key);
        if (rec.name) { oldName = rec.name; break; }
      }

      if (!oldName) {
        respond(tiktokId, 'You have no saved name to reset. Type: queue YourUbisoftName to save one. Spaces are allowed for console players.', sourceLabel);
        cmd(`[${sourceLabel}] [reset] @${display} has no saved name`);
        postAdminLog('warn', 'queue', `Reset ignored @${display}: no saved name`, { stream: sourceLabel, tiktokId, userKey });
        return;
      }

      await refreshLiveQueueFromServer();
      if (isInQueue(oldName) || isPlaying(oldName)) {
        await removeFromQueue(oldName);
        await refreshLiveQueueFromServer();
      }

      const oldCanonical = canonicalName(oldName);
      const resetStamp = new Date().toISOString();

      // Tombstone only the keys belonging to the platform the user typed from.
      // Cross-platform keys (e.g. their TikTok key when they reset from Twitch,
      // or their Twitch key when they reset from TikTok) are left untouched so
      // their name stays linked on the other platform.
      const currentPlatformIsTwitch = platform === 'twitch';
      for (const key of aliasKeys) users[key] = { name: '', queued: false, resetAt: resetStamp };
      for (const [key, value] of Object.entries(users)) {
        // Only wipe keys that belong to the same platform as the reset command.
        const keyIsTwitch = String(key).startsWith('twitch_');
        if (keyIsTwitch !== currentPlatformIsTwitch) continue;
        const rec = getRecord(users, key);
        if (rec.name && oldCanonical && canonicalName(rec.name) === oldCanonical) {
          users[key] = { name: '', queued: false, resetAt: resetStamp };
        }
      }

      saveUsers(users);
      const serverCleared = await deleteSavedNameOnServer([...aliasKeys]);
      await refreshLiveQueueFromServer();

      respond(tiktokId, `Saved name "${oldName}" cleared. Type: queue YourNewUbisoftName before using queue by itself.`, sourceLabel);
      ok(`[${sourceLabel}] [reset] @${display} cleared saved name ${oldName}`);
      postAdminLog('success', 'queue', `@${display} reset saved name ${oldName}`, { stream: sourceLabel, tiktokId, userKey, name: oldName, aliasesCleared: [...aliasKeys], serverCleared });
      postBotStatusToServer().catch(() => {});
      return;
    }

    // ── leave — leave queue ─────────────────────────────────────────────────────
    if (isLeaveCmd) {
      await refreshLiveQueueFromServer();
      const record = getRecord(users, userKey);
      const nameToRemove = record.name;
      if (!nameToRemove || (!isInQueue(nameToRemove) && !isPlaying(nameToRemove))) {
        respond(tiktokId, 'You are not currently in the queue.', sourceLabel);
        cmd(`[${sourceLabel}] [leave] @${display} not in queue`);
        postAdminLog('warn', 'queue', `@${display} used leave but is not in queue`, { stream: sourceLabel, tiktokId });
        return;
      }
      const leaveResult = await removeFromQueue(nameToRemove);
      if (leaveResult === 'removed') {
        users[userKey] = { name: nameToRemove, queued: false };
        saveUsers(users);
        await refreshLiveQueueFromServer();
        respond(tiktokId, `${nameToRemove} has been removed from the queue.`, sourceLabel);
        ok(`[${sourceLabel}] [leave] @${display} left queue: ${nameToRemove}`);
        postAdminLog('success', 'queue', `${nameToRemove} left queue from @${display}`, { stream: sourceLabel, tiktokId, name: nameToRemove });
        postBotStatusToServer().catch(() => {});
      } else if (leaveResult === 'not_found') {
        // Queue already cleared on website — sync local state
        users[userKey] = { name: nameToRemove, queued: false };
        saveUsers(users);
        respond(tiktokId, 'You are not currently in the queue.', sourceLabel);
        cmd(`[${sourceLabel}] [leave] @${display} not found on server queue`);
      } else {
        respond(tiktokId, 'Could not remove you from the queue right now. Try again.', sourceLabel);
        err(`[${sourceLabel}] [leave] removeFromQueue error for ${nameToRemove}: ${leaveResult}`);
      }
      return;
    }

    if (!isJoinCmd && !isTempCmd && !isBareJoin) return;

    const afterCommand = String(parsedCommand.arg || '').trim();
    if (isTempCmd && !afterCommand) {
      respond(tiktokId, 'Use temp <YourUbisoftName> to join once without saving your chat name. Example: temp Blake', sourceLabel);
      cmd(`[${sourceLabel}] [temp] @${display} missing Ubisoft name`);
      postAdminLog('warn', 'queue', `Rejected temp from @${display}: missing Ubisoft name`, { stream: sourceLabel, tiktokId });
      return;
    }

    if (!isTempCmd && !afterCommand) {
      // If they already saved a name, queue by itself should rejoin them.
      const savedRecord = getRecord(users, userKey);
      if (!savedRecord.name) {
        respond(tiktokId, 'Use queue <YourUbisoftName>. Spaces are allowed for console players. Example: queue Blake', sourceLabel);
        cmd(`[${sourceLabel}] [queue] @${display} missing Ubisoft name`);
        postAdminLog('warn', 'queue', `Rejected @${display}: missing Ubisoft name`, { stream: sourceLabel, tiktokId });
        return;
      }
    }

    // Only start the join cooldown after the command is valid enough to process.
    setCooldown(cooldownKey);

    let record         = getRecord(users, userKey);
    const joinNameFromCommand = afterCommand || record.name || '';

    await refreshLiveQueueFromServer();

    // If older bot versions saved somebody under their TikTok display name
    // instead of their stable @uniqueId, move that record to the stable key.
    // Example from logs: display @tate, stable key buckismain.
    if (!record.name && joinNameFromCommand) {
      const aliasKey = normalizeTikTokUsername(display);
      const aliasRecord = aliasKey && aliasKey !== userKey ? getRecord(users, aliasKey) : { name: '', queued: false };
      if (aliasRecord.name && canonicalName(aliasRecord.name) === canonicalName(joinNameFromCommand)) {
        users[userKey] = aliasRecord;
        delete users[aliasKey];
        saveUsers(users);
        record = aliasRecord;
        cmd(`[${sourceLabel}] [sync] moved saved name ${aliasRecord.name} from @${aliasKey} to @${userKey}`);
      }
    }

    if (!isTempCmd && ownNameIsActive(record)) {
      const pos = getPosition(record.name);
      // Determine if the person tried a DIFFERENT name or their same/saved name
      const triedName = isBareJoin ? bareJoinName : joinNameFromCommand;
      const isSameName = !triedName || canonicalName(triedName) === canonicalName(record.name);
      if (isPlaying(record.name)) {
        respond(tiktokId, `${record.name} is currently playing.`, sourceLabel);
      } else if (isSameName) {
        // They re-typed their own name (or queue with no name) - clear "already in queue" message
        respond(tiktokId, `${record.name} is already in queue${pos ? ` at #${pos}` : ''}.`, sourceLabel);
      } else {
        // They tried a DIFFERENT name while already queued - tell them which name they're under
        respond(tiktokId, `You are already in queue as ${record.name}${pos ? ` (#${pos})` : ''}. Ask admin to change it.`, sourceLabel);
      }
      cmd(`[${sourceLabel}] [queue] @${display} already active as ${record.name}`);
      postAdminLog('warn', 'queue', `Rejected @${display}: already active as ${record.name}`, { stream: sourceLabel, tiktokId, name: record.name });
      return;
    }

    if (joinNameFromCommand) {
      const valid = validateName(joinNameFromCommand);
      if (!valid.ok) {
        respond(tiktokId, valid.reason, sourceLabel);
        cmd(`[${sourceLabel}] [queue] @${display} invalid name: "${afterCommand}" (${valid.reason})`);
        postAdminLog('warn', 'queue', `Rejected @${display}: ${valid.reason}`, { stream: sourceLabel, tiktokId, input: afterCommand });
        return;
      }
      let clean = valid.name;
      const knownName = findKnownNameForInput(clean, userKey);
      if (knownName) {
        if (knownName !== clean) cmd(`[${sourceLabel}] [queue] @${display} normalized ${clean} → ${knownName}`);
        clean = knownName;
      }

      // Saved Ubisoft names stay permanent until the admin edits them.
      // If they already have a saved name, queue <different name> will NOT change the file.
      // They must ask admin to change the saved name first, then use queue <new name>.
      if (!isTempCmd && record.name && record.name.toLowerCase() !== clean.toLowerCase()) {
        respond(tiktokId, `Your saved Ubisoft name is ${record.name}. Use queue with that exact name, or ask admin to change it first.`, sourceLabel);
        cmd(`[${sourceLabel}] [queue] @${display} tried to change ${record.name} → ${clean} without admin edit`);
        postAdminLog('warn', 'queue', `Rejected @${display}: tried to change saved name ${record.name} → ${clean}`, { stream: sourceLabel, tiktokId });
        return;
      }

      const takenMsg = nameTakenMessage(clean, userKey);
      if (takenMsg) {
        respond(tiktokId, takenMsg, sourceLabel);
        cmd(`[${sourceLabel}] [queue] @${display} ✗ name "${clean}" blocked by name checker`);
        postAdminLog('warn', 'queue', `Rejected @${display}: ${takenMsg}`, { stream: sourceLabel, tiktokId, name: clean });
        return;
      }

      // ── Cross-platform name linking ────────────────────────────────────────
      // If the same Ubisoft name is already saved under the other platform key
      // (e.g. TikTok has it, now Twitch is registering it — or vice versa),
      // adopt the existing canonical name spelling and continue normally.
      // This lets the same person type queue commands on both platforms.
      if (!isTempCmd && !record.name) {
        for (const [rawOwner, value] of Object.entries(users)) {
          const ownerKey = normalizeTikTokUsername(displayUserKey(rawOwner));
          if (!ownerKey || ownerKey === normalizeTikTokUsername(displayUserKey(userKey))) continue;
          const ownerRec = recordFromValue(value);
          if (!ownerRec.name) continue;
          if (canonicalName(ownerRec.name) === canonicalName(clean)) {
            const ownerIsTwitch   = String(rawOwner).startsWith('twitch_');
            const incomingIsTwitch = String(userKey).startsWith('twitch_');
            if (ownerIsTwitch !== incomingIsTwitch) {
              // Same person on the other platform — adopt their saved name spelling.
              clean = ownerRec.name;
              cmd(`[${sourceLabel}] [queue] @${display} cross-platform link: adopting existing name "${clean}" from ${ownerIsTwitch ? 'Twitch' : 'TikTok'} key ${rawOwner}`);
              postAdminLog('info', 'queue', `@${display} linked cross-platform: adopting "${clean}" from ${rawOwner}`, { stream: sourceLabel, tiktokId, userKey, linkedFrom: rawOwner });
              break;
            }
          }
        }
      }
      const result = await addToQueue(clean);
      if (result === 'added' || result === 'already') {
        await refreshLiveQueueFromServer();
        let serverSaved = false;
        if (!isTempCmd) {
          setRecord(users, userKey, { name: clean, queued: true });
          serverSaved = await saveSavedNameOnServer(overrides.saveKeys || (platform === 'twitch' ? [userKey] : [userKey, rawTikTokId]), clean);
          cmd(`[${sourceLabel}] [queue] @${display} saved name after server accepted it: ${clean}${serverSaved ? ' (admin saved)' : ''}`);
        } else {
          cmd(`[${sourceLabel}] [temp] @${display} added without saving chat account: ${clean}`);
          postBotStatusToServer().catch(() => {});
        }
        const pos = getPosition(clean) || '?';
        respond(tiktokId, result === 'added' ? `${clean} added to queue! Position: #${pos}` : `${clean} is already in queue at #${pos}.`, sourceLabel);
        ok(`[${sourceLabel}] [${isTempCmd ? 'temp' : 'queue'}] @${display} → ${clean} ${result} (#${pos})`);
        postAdminLog('success', 'queue', `${clean} ${result === 'added' ? 'added to queue' : 'already in queue'} from @${display}${isTempCmd ? ' (temp, not saved)' : ''}`, { stream: sourceLabel, tiktokId, userKey, name: clean, position: pos, result, serverSaved, temporary: isTempCmd });
      } else {
        // Important: do NOT save the TikTok → Ubisoft name if the website queue rejected it.
        // This stops random TikTok chat words/bad names from getting stuck on the account.
        respond(tiktokId, `Could not add "${clean}" to the queue. Check the name and try: ${isTempCmd ? 'temp' : 'queue'} YourUbisoftName`, sourceLabel);
        err(`[${sourceLabel}] [queue] @${display} → server rejected ${clean}; not saving it`);
        postAdminLog('error', 'queue', `Server rejected ${clean} from @${display}`, { stream: sourceLabel, tiktokId, name: clean });
      }
      return;
    }

    respond(tiktokId, 'Use queue <YourUbisoftName> to save your name before using queue by itself.', sourceLabel);
    cmd(`[${sourceLabel}] [queue] @${display} — no saved name`);
}

// ── TikTok event registration — wires TikTok-specific events; chat is routed
// to the shared handleChatCommand above so Twitch uses the exact same logic. ──

function registerTikTokEvents(entry) {
  const tiktok = entry.conn;
  const sourceUsername = entry.username;

  // Route TikTok chat/comment events to the shared handler.
  // Pass _tiktokConn so the handler can detect stale connection objects.
  tiktok.on('chat',    data => handleChatCommand(data, 'chat',    { _tiktokConn: tiktok }, entry));
  tiktok.on('comment', data => handleChatCommand(data, 'comment', { _tiktokConn: tiktok }, entry));

  // Mark any TikTok activity so the stale-connection watchdog does not fire
  // during active lives that happen to have a gap in chat/roomUser events.
  // member = someone joined the live, like = heart tap, gift = gift sent, share = shared the live.
  tiktok.on('member', () => { if (entry.conn === tiktok) markTikTokEvent(entry); });
  tiktok.on('like',   () => { if (entry.conn === tiktok) markTikTokEvent(entry); });
  tiktok.on('gift',   () => { if (entry.conn === tiktok) markTikTokEvent(entry); });
  tiktok.on('share',  () => { if (entry.conn === tiktok) markTikTokEvent(entry); });

  tiktok.on('disconnected', () => {
    if (entry.conn !== tiktok) return; // ignore late disconnects from stale TikTok connection objects
    if (entry.connectTimeout) clearTimeout(entry.connectTimeout);
    entry.connectTimeout = null;
    entry.connected = false;
    entry.connecting = false;
    entry.currentRoomId = null;
    entry.conn = null;
    entry.lastAnyEventAt = 0;
    updateAggregateBotState();
    warn(`TikTok disconnected @${sourceUsername} — reconnecting in 3 seconds. No redeploy needed.`);
    postAdminLog('warn', 'tiktok', `TikTok disconnected @${sourceUsername}. Reconnecting in 8 seconds.`);
    entry.retryDelay = 10_000;
    postBotStatusToServer({ connected: botConnected, connecting: false, error: `@${sourceUsername} disconnected` });
    scheduleReconnect(sourceUsername, 8_000);
  });

  tiktok.on('error', e => {
    if (entry.conn !== tiktok) return; // ignore late errors from stale TikTok connection objects
    const message = safeTikTokErrorMessage(e);

    if (shouldHardReconnectTikTok(message)) {
      warn(`TikTok chat stalled @${sourceUsername}: ${message}. Rebuilding connection now.`);
      postAdminLog('warn', 'tiktok', `@${sourceUsername}: TikTok chat stalled (${message}). Rebuilding connection now so messages do not silently stop.`, { stream: sourceUsername, error: message });
      forceFreshTikTokReconnect(sourceUsername, message, 3_000);
      return;
    }

    err(`TikTok stream error @${sourceUsername}: ${message}`);
    postAdminLog('error', 'tiktok', `TikTok stream error @${sourceUsername}: ${message}`, { stream: sourceUsername, error: message });
    postBotStatusToServer({ connected: botConnected, error: `@${sourceUsername}: ${message}` });
  });

  // Viewer count updates only. Do NOT queue anyone from roomUser/join events.
  // The bot only adds a player when that TikTok user types queue/q <UbisoftName> in chat.
  tiktok.on('roomUser', d => {
    if (entry.conn !== tiktok) return; // ignore late viewer updates from stale TikTok connection objects
    markTikTokEvent(entry);
    if (d?.viewerCount != null) {
      entry.currentViewers = Number(d.viewerCount);
      updateAggregateBotState();
      info(`@${sourceUsername} Viewers: ${entry.currentViewers}`);
      postBotStatusToServer({ viewers: currentViewers });
    }
  });
}


// ── Twitch chat support ─────────────────────────────────────────────────────

let twitchClient = null;
let twitchConnected = false;

function stopTwitchChat(reason = 'stopped', opts = {}) {
  if (!twitchClient) return;
  const oldClient = twitchClient;
  twitchClient = null;
  twitchConnected = false;
  try {
    oldClient.removeAllListeners?.();
    oldClient.disconnect();
  } catch (_) {}
  if (!opts.silent) {
    postAdminLog('warn', 'twitch', `Twitch chat ${reason}`);
    postBotStatusToServer({ connected: botConnected || twitchConnected, connecting: false, error: `Twitch ${reason}` }).catch(() => {});
  }
}

let twitchRestartTimer = null;
let twitchStarting = false;

function restartTwitchChat() {
  if (twitchRestartTimer) clearTimeout(twitchRestartTimer);
  stopTwitchChat('restarting');
  twitchRestartTimer = setTimeout(() => {
    twitchRestartTimer = null;
    startTwitchChat();
  }, 750);
}

function startTwitchChat() {
  TWITCH_CHANNELS = parseTwitchChannelList(TWITCH_CHANNELS);
  if (!TWITCH_ENABLED) return;
  if (!TWITCH_CHANNELS.length) {
    warn('Twitch is enabled but TWITCH_CHANNEL or TWITCH_CHANNELS is empty.');
    return;
  }
  if (!tmi) {
    warn('Twitch is enabled but tmi.js is not installed. Run: npm install tmi.js');
    postAdminLog('warn', 'twitch', 'Twitch enabled but tmi.js is not installed. Run npm install tmi.js.');
    return;
  }
  if (twitchClient || twitchStarting) return;
  twitchStarting = true;

  const options = { reconnect: true, secure: true };
  const identity = TWITCH_BOT_USERNAME && TWITCH_OAUTH_TOKEN
    ? { username: TWITCH_BOT_USERNAME, password: TWITCH_OAUTH_TOKEN }
    : undefined;

  twitchClient = new tmi.Client({
    options,
    ...(identity ? { identity } : {}),
    channels: TWITCH_CHANNELS,
  });

  const currentTwitchClient = twitchClient;

  twitchClient.on('connected', (addr, port) => {
    if (twitchClient !== currentTwitchClient) return;
    twitchStarting = false;
    twitchConnected = true;
    ok(`Connected to Twitch chat: ${twitchChannelsDisplay()}`);
    postAdminLog('success', 'twitch', `Connected to Twitch chat: ${twitchChannelsDisplay()}`, { addr, port });
    postBotStatusToServer({ connected: botConnected || twitchConnected, connecting: false });
  });

  twitchClient.on('disconnected', reason => {
    if (twitchClient !== currentTwitchClient) return;
    twitchStarting = false;
    twitchConnected = false;
    warn(`Twitch chat disconnected: ${reason || 'unknown reason'}`);
    postAdminLog('warn', 'twitch', `Twitch chat disconnected: ${reason || 'unknown reason'}`);
    postBotStatusToServer({ connected: botConnected || twitchConnected, connecting: false, error: `Twitch disconnected: ${reason || 'unknown'}` });
  });

  twitchClient.on('message', async (channel, tags, message, self) => {
    if (twitchClient !== currentTwitchClient) return;
    if (self) return;
    const twitchUsername = normalizeTikTokUsername(tags?.username || tags?.['display-name'] || 'unknown');
    if (!twitchUsername || twitchUsername === 'unknown') return;

    const displayName = tags?.['display-name'] || twitchUsername;
    const channelName = String(channel || '').replace(/^#+/, '').toLowerCase();
    const userKey = platformUserKey('twitch', twitchUsername);

    const data = {
      uniqueId: twitchUsername,
      nickname: displayName,
      comment: String(message || ''),
      user: { uniqueId: twitchUsername, nickname: displayName },
    };

    // Call the shared handler directly — no fakeEntry or sharedQueueCommandHandler needed.
    try {
      await handleChatCommand(data, 'twitch-message', {
        platform: 'twitch',
        sourceUsername: `twitch:#${channelName}`,
        rawUserId: twitchUsername,
        displayName,
        userKey,
        saveKeys: [userKey],
      }, null);
    } catch (e) {
      const messageText = e?.message || String(e || 'unknown Twitch command error');
      err(`Twitch command handler failed for @${displayName}: ${messageText}`);
      postAdminLog('error', 'twitch', `Twitch command handler failed for @${displayName}: ${messageText}`, { channel: channelName, twitchUsername });
    }
  });

  info(`Connecting to Twitch chat: ${twitchChannelsDisplay()}`);
  postAdminLog('info', 'twitch', `Connecting to Twitch chat: ${twitchChannelsDisplay()}`);
  currentTwitchClient.connect().catch(e => {
    if (twitchClient !== currentTwitchClient) return;
    twitchStarting = false;
    twitchConnected = false;
    const message = e?.message || String(e || 'unknown Twitch error');
    err(`Twitch connect failed: ${message}`);
    postAdminLog('error', 'twitch', `Twitch connect failed: ${message}`);
  });
}

// Build initial stream objects.
rebuildTikTokConnections();

// ── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown(signal) {
  warn(`\nReceived ${signal} — saving state and exiting…`);
  saveUsers(users);
  for (const entry of streams.values()) { try { entry.conn.disconnect(); } catch (_) {} }
  try { if (twitchClient) twitchClient.disconnect(); } catch (_) {}
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
  const knownRecords  = Object.keys(users).length;
  const savedNames    = getSavedUsersForAdmin().length;
  const queued        = getSavedUsersForAdmin().filter(r => r?.queued || r?.active || r?.inQueue || r?.playing).length;
  info(`Stats — enabled streams: ${getStreamUsers().map(u => '@' + u).join(', ') || 'none'}, saved names: ${savedNames}, known records: ${knownRecords}, queued records: ${queued}, live queue: ${liveQueue.length}, playing: ${livePlaying.length}, viewers: ${currentViewers}, twitch: ${twitchConnected ? 'connected' : 'off/disconnected'}`);
}, 5 * 60_000);

// ── Start ───────────────────────────────────────────────────────────────────

printBanner();

// Fetch server config FIRST so we use the admin-set username, cooldown, etc.
fetchBotConfigFromServer()
  .then(() => {
    ok('[sync] Config loaded from server — starting TikTok connection');
    connectAllTikTok();
    startTwitchChat();
  })
  .catch(() => {
    warn('[sync] Could not fetch server config (server may be down) — using env defaults');
    connectAllTikTok();
    startTwitchChat();
  });
