'use strict';

const { normalizeTikTokUsername, parseTwitchChannelList } = require('./livequeue-utils');

/** Worker-visible connection lifecycle states. */
const STREAMER_STATES = Object.freeze([
  'online',
  'offline',
  'reconnecting',
  'invalid_user',
  'disabled',
  'banned',
  'rate_limited',
]);

function tiktokKey(username) {
  return `tiktok:${normalizeTikTokUsername(username)}`;
}

function twitchKey(channel) {
  const ch = String(channel || '').toLowerCase().replace(/^#+/, '').trim();
  return ch ? `twitch:${ch}` : '';
}

function normalizeFeatures(features) {
  const f = features && typeof features === 'object' ? features : {};
  return {
    websiteQueue: f.websiteQueue !== false,
    overlayAccess: !!f.overlayAccess,
    tiktokQueue: f.tiktokQueue === true,
    twitchQueue: f.twitchQueue === true,
    youtubeQueue: !!f.youtubeQueue,
  };
}

/**
 * Platform-driven registry of streamer chat/queue targets.
 * Replaces hardcoded "main + extra" creator assumptions.
 */
function createStreamerRegistry() {
  const targets = new Map();
  const tiktokUsernameToSlug = new Map();
  const twitchChannelToSlug = new Map();
  const serverProvidedSessions = new Map();

  function upsertTarget(key, partial) {
    const k = String(key || '').trim();
    if (!k) return null;
    const prev = targets.get(k) || {};
    const next = {
      key: k,
      platform: partial.platform || prev.platform || 'tiktok',
      slug: partial.slug || prev.slug || '',
      streamerId: partial.streamerId || prev.streamerId || '',
      username: partial.username || prev.username || '',
      channel: partial.channel || prev.channel || '',
      features: partial.features ? normalizeFeatures(partial.features) : (prev.features || normalizeFeatures({})),
      isLive: partial.isLive ?? prev.isLive ?? false,
      botDisabled: partial.botDisabled ?? prev.botDisabled ?? false,
      status: partial.status || prev.status || 'offline',
      updatedAt: Date.now(),
    };
    targets.set(k, next);
    return next;
  }

  function removeTarget(key) {
    targets.delete(String(key || '').trim());
  }

  return {
    STREAMER_STATES,
    tiktokKey,
    twitchKey,

    clear() {
      targets.clear();
      tiktokUsernameToSlug.clear();
      twitchChannelToSlug.clear();
      serverProvidedSessions.clear();
    },

    /**
     * Apply streamer rows from GET /api/bot/streamers.
     * @param {Array<object>} streamers
     * @param {{ legacyTikTok?: string[], legacyTwitch?: string[] }} opts
     */
    applyApiStreamers(streamers, opts = {}) {
      this.clear();
      const list = Array.isArray(streamers) ? streamers : [];

      for (const s of list) {
        const slug = String(s.slug || '').trim();
        if (!slug) continue;

        const features = normalizeFeatures(s.features);
        const botDisabled = Boolean(s.botDisabled || s.disabled);
        const isLive = Boolean(s.isLive);
        const streamerId = String(s.id || s.streamerId || '').trim();

        if (s.tiktokUsername) {
          const u = normalizeTikTokUsername(s.tiktokUsername);
          if (!u) continue;
          const allowTikTok = features.tiktokQueue || Boolean(s.tiktokSessionId);
          if (!allowTikTok || botDisabled) continue;

          tiktokUsernameToSlug.set(u, slug);
          if (s.tiktokSessionId) serverProvidedSessions.set(u, String(s.tiktokSessionId).trim());

          upsertTarget(tiktokKey(u), {
            platform: 'tiktok',
            slug,
            streamerId,
            username: u,
            features,
            isLive,
            botDisabled,
            status: 'offline',
          });
        }

        if (s.twitchChannel) {
          const ch = String(s.twitchChannel).toLowerCase().replace(/^#+/, '');
          if (!ch) continue;
          const allowTwitch = features.twitchQueue || Boolean(s.twitchChannel) || opts.allowTwitchWithoutFeatureFlag;
          if (!allowTwitch) continue;
          if (botDisabled) continue;

          twitchChannelToSlug.set(ch, slug);
          upsertTarget(twitchKey(ch), {
            platform: 'twitch',
            slug,
            streamerId,
            channel: ch,
            features,
            isLive,
            botDisabled,
            status: 'offline',
          });
        }

        const relays = Array.isArray(s.relayConnections) ? s.relayConnections : [];
        for (const rel of relays) {
          if (!rel || typeof rel !== 'object') continue;
          if (rel.tiktokEnabled !== false && rel.tiktokUsername) {
            const u = normalizeTikTokUsername(rel.tiktokUsername);
            if (u) {
              tiktokUsernameToSlug.set(u, slug);
              if (rel.tiktokSessionId) serverProvidedSessions.set(u, String(rel.tiktokSessionId).trim());
              upsertTarget(tiktokKey(u), {
                platform: 'tiktok',
                slug,
                streamerId,
                username: u,
                features,
                isLive,
                botDisabled,
                status: 'offline',
              });
            }
          }
          if (rel.twitchEnabled !== false && rel.twitchChannel) {
            const ch = String(rel.twitchChannel).toLowerCase().replace(/^#+/, '');
            if (ch) {
              twitchChannelToSlug.set(ch, slug);
              upsertTarget(twitchKey(ch), {
                platform: 'twitch',
                slug,
                streamerId,
                channel: ch,
                features,
                isLive,
                botDisabled,
                status: 'offline',
              });
            }
          }
        }
      }

      for (const u of opts.legacyTikTok || []) {
        const user = normalizeTikTokUsername(u);
        if (!user || tiktokUsernameToSlug.has(user)) continue;
        tiktokUsernameToSlug.set(user, '');
        upsertTarget(tiktokKey(user), {
          platform: 'tiktok',
          slug: '',
          username: user,
          features: normalizeFeatures({ tiktokQueue: true }),
          status: 'offline',
        });
      }

      for (const ch of parseTwitchChannelList(opts.legacyTwitch || [])) {
        if (!ch || twitchChannelToSlug.has(ch)) continue;
        twitchChannelToSlug.set(ch, '');
        upsertTarget(twitchKey(ch), {
          platform: 'twitch',
          slug: '',
          channel: ch,
          features: normalizeFeatures({ twitchQueue: true }),
          status: 'offline',
        });
      }

      return {
        tiktokCount: tiktokUsernameToSlug.size,
        twitchCount: twitchChannelToSlug.size,
        targetCount: targets.size,
      };
    },

    getTikTokUsernames() {
      return [...tiktokUsernameToSlug.keys()];
    },

    getTwitchChannels() {
      return [...twitchChannelToSlug.keys()];
    },

    getSlugForTikTok(username) {
      return tiktokUsernameToSlug.get(normalizeTikTokUsername(username)) || null;
    },

    getSlugForTwitch(channel) {
      const ch = String(channel || '').toLowerCase().replace(/^#+/, '');
      return twitchChannelToSlug.get(ch) || null;
    },

    getSessionForTikTok(username) {
      return serverProvidedSessions.get(normalizeTikTokUsername(username)) || null;
    },

    getTarget(key) {
      return targets.get(String(key || '').trim()) || null;
    },

    setTargetStatus(key, status, extra = {}) {
      const t = targets.get(String(key || '').trim());
      if (!t) return;
      if (status && STREAMER_STATES.includes(status)) t.status = status;
      if (extra.error !== undefined) t.lastError = extra.error;
      if (extra.connected !== undefined) t.connected = !!extra.connected;
      if (extra.connecting !== undefined) t.connecting = !!extra.connecting;
      t.updatedAt = Date.now();
    },

    listTargets() {
      return [...targets.values()];
    },

    listTikTokTargets() {
      return this.listTargets().filter(t => t.platform === 'tiktok');
    },

    /** Maps for existing index.js helpers */
    maps: {
      get tiktokUsernameToSlug() { return tiktokUsernameToSlug; },
      get twitchChannelToSlug() { return twitchChannelToSlug; },
      get serverProvidedSessions() { return serverProvidedSessions; },
    },
  };
}

module.exports = {
  STREAMER_STATES,
  createStreamerRegistry,
  tiktokKey,
  twitchKey,
  normalizeFeatures,
};
