'use strict';

/**
 * Per-target exponential reconnect backoff for offline / failed connections.
 * Offline streamers stay "armed" but are not hammered every few seconds.
 */

function createReconnectPolicy(options = {}) {
  const minDelayMs = Math.max(5_000, Number(options.minDelayMs || 30_000));
  const maxDelayMs = Math.max(minDelayMs, Number(options.maxDelayMs || 300_000));
  const multiplier = Number(options.multiplier || 2) || 2;
  const jitterRatio = Math.min(0.3, Math.max(0, Number(options.jitterRatio ?? 0.1)));
  const targets = new Map();

  function jitter(delayMs) {
    if (!jitterRatio) return delayMs;
    const spread = Math.floor(delayMs * jitterRatio);
    return delayMs + Math.floor(Math.random() * (spread * 2 + 1)) - spread;
  }

  function getState(key) {
    const k = String(key || '').trim();
    if (!k) return null;
    if (!targets.has(k)) {
      targets.set(k, {
        attempt: 0,
        delayMs: minDelayMs,
        nextRetryAt: 0,
        lastFailureAt: 0,
        lastFailureMessage: '',
      });
    }
    return targets.get(k);
  }

  return {
    minDelayMs,
    maxDelayMs,

    reset(key) {
      const k = String(key || '').trim();
      if (!k) return;
      targets.delete(k);
    },

    markSuccess(key) {
      this.reset(key);
    },

    canAttempt(key) {
      const state = getState(key);
      if (!state) return true;
      return Date.now() >= Number(state.nextRetryAt || 0);
    },

    msUntilRetry(key) {
      const state = getState(key);
      if (!state) return 0;
      return Math.max(0, Number(state.nextRetryAt || 0) - Date.now());
    },

    /**
     * @param {string} key
     * @param {{ hintedMs?: number, rateLimited?: boolean, invalid?: boolean }} meta
     */
    scheduleFailure(key, meta = {}) {
      const state = getState(key);
      if (!state) return minDelayMs;

      const hinted = Number(meta.hintedMs || 0);
      let delayMs = minDelayMs;

      if (meta.invalid) {
        delayMs = maxDelayMs;
      } else if (meta.rateLimited) {
        delayMs = Math.min(maxDelayMs, Math.max(minDelayMs * 4, hinted || minDelayMs * 4));
      } else if (hinted > 0) {
        delayMs = Math.min(maxDelayMs, Math.max(minDelayMs, hinted));
      } else {
        state.attempt += 1;
        const grown = Math.max(minDelayMs, Number(state.delayMs || minDelayMs) * multiplier);
        delayMs = Math.min(maxDelayMs, grown);
      }

      delayMs = jitter(delayMs);
      state.attempt += 1;
      state.delayMs = delayMs;
      state.lastFailureAt = Date.now();
      state.lastFailureMessage = String(meta.message || '').slice(0, 240);
      state.nextRetryAt = Date.now() + delayMs;
      return delayMs;
    },

    snapshot(key) {
      const state = getState(key);
      if (!state) return null;
      return {
        attempt: state.attempt,
        delayMs: state.delayMs,
        nextRetryAt: state.nextRetryAt,
        msUntilRetry: this.msUntilRetry(key),
        lastFailureMessage: state.lastFailureMessage || '',
      };
    },
  };
}

module.exports = { createReconnectPolicy };
