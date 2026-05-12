# LiveQueue

## File layout

- `index.js` - main bot runtime, TikTok/Twitch connections, queue actions, and server sync.
- `bot-command-parser.js` - the allowed live chat command parser. Edit this when changing queue commands.
- `livequeue-utils.js` - shared username/channel/env parsing helpers used by the bot runtime.

Allowed queue commands are `q`, `queue`, `temp`, `leave`, and `reset`. Bang-prefixed commands like `!queue`, shorthand `l`, and `clear/c/r` are intentionally not accepted.
