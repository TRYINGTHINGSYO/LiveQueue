# LiveQueue Worker

Scalable realtime chat/queue worker for the SiegeQueue multi-streamer platform.

## Architecture

- **SiegeQueue** — accounts, per-streamer queues, dashboard, `/api/bot/*` config APIs
- **LiveQueue** — connection manager: polls platform streamers, arms TikTok/Twitch chat listeners, routes commands to the correct streamer queue (`/api/s/:slug/admin/...`)

The worker does **not** assume a single main creator. Streamer targets come from `GET /api/bot/streamers` (verified streamers with TikTok/Twitch configured).

## File layout

| File | Role |
|------|------|
| `index.js` | Worker runtime, chat handlers, SiegeQueue API client |
| `streamer-registry.js` | Platform-driven target registry (slug routing, sessions) |
| `reconnect-policy.js` | Per-target exponential backoff (offline is not fatal) |
| `bot-command-parser.js` | Allowed commands: `q`, `queue`, `temp`, `leave`, `reset` |
| `livequeue-utils.js` | Username/channel/env parsing |

## Streamer connection states

`online` · `offline` · `reconnecting` · `invalid_user` · `disabled` · `banned` · `rate_limited`

Offline streamers stay **armed** with exponential backoff (default 30s–300s). Logs are throttled so many offline targets do not spam the console.

## Environment

| Variable | Purpose |
|----------|---------|
| `ADMIN_PASSWORD` | Required — auth for SiegeQueue bot APIs |
| `QUEUE_API_URL` | SiegeQueue base URL (default `https://siegequeue.com`) |
| `MIN_RETRY_MS` | Minimum reconnect delay (default `30000`) |
| `MAX_RETRY_MS` | Maximum reconnect delay (default `300000`) |
| `LIVE_SCAN_MS` | Connection watchdog interval (default `15000`) |
| `LEGACY_BOT_MODE` | Set `true` only for old single-creator env vars (`TIKTOK_USERNAME`, etc.) |

## Legacy mode

`LEGACY_BOT_MODE=true` re-enables env-based `TIKTOK_USERNAME` / `EXTRA_TIKTOK_USERNAMES` alongside platform streamers. **Leave off in production** so all connections are database-driven.
