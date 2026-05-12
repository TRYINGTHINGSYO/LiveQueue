'use strict';

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

function cleanTwitchChannel(value) {
  return String(value || '')
    .trim()
    .replace(/^[@#]+/, '')
    .toLowerCase();
}

function parseTwitchChannelList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(raw.map(cleanTwitchChannel).filter(Boolean))];
}

module.exports = {
  cfgBool,
  cleanTwitchChannel,
  envBool,
  normalizeTikTokUsername,
  parseTikTokUserList,
  parseTwitchChannelList,
  uniqueTikTokUsers,
};
