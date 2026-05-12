'use strict';

const VALID_COMMANDS = new Set(['q', 'queue', 'temp', 'leave', 'reset']);

function normalizeCommandText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBotCommandMessage(message) {
  const text = normalizeCommandText(message);
  if (!text || /^[!/]/.test(text)) return { type: '', arg: '', normalizedCommand: '' };

  const match = text.match(/^([a-zA-Z]+)(?:\b|(?=[:=,-]))\s*[:=,-]?\s*([\s\S]*)$/);
  if (!match) return { type: '', arg: '', normalizedCommand: '' };

  const command = match[1].toLowerCase();
  if (!VALID_COMMANDS.has(command)) return { type: '', arg: '', normalizedCommand: '' };

  let arg = normalizeCommandText(match[2] || '')
    .replace(/^(?:name|ubi|ubisoft)\s*[:=,-]?\s+/i, '')
    .replace(/^@+/, '')
    .trim();

  if (command === 'leave' || command === 'reset') arg = '';

  if (command === 'q' || command === 'queue') {
    return { type: 'join', arg, normalizedCommand: 'queue' };
  }
  if (command === 'temp') {
    return { type: 'temp', arg, normalizedCommand: 'temp' };
  }
  if (command === 'leave') {
    return { type: 'leave', arg: '', normalizedCommand: 'leave' };
  }
  return { type: 'reset', arg: '', normalizedCommand: 'reset' };
}

module.exports = {
  parseBotCommandMessage,
};
