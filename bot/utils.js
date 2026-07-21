const fs = require('fs');
const path = require('path');

function loadConfig() {
  require('dotenv').config();
  const file = path.resolve(process.cwd(), 'config.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
    discord: {},
    api: {},
    bot: { defaultClipsChannel: 'clips', defaultBufferMinutes: 30, defaultRetentionDays: 90 },
    storage: { clipsDir: './data/clips', databasePath: './data/bot.db' },
    development: {}
  };
  config.discord = { ...(config.discord || {}) };
  config.api = { host: '127.0.0.1', port: 3000, baseUrl: 'http://localhost:3000', ...(config.api || {}) };
  config.web = { baseUrl:config.api.baseUrl, ...(config.web || {}) };
  config.bot = { defaultClipsChannel:'clips', defaultBufferMinutes:30, defaultRetentionDays:90, ...(config.bot || {}) };
  config.development = { enabled: false, userId: '100000000000000001', username: 'Local Owner', guildId: '100000000000000002', guildName: 'Local Development Server', ...(config.development || {}) };
  if (process.env.DISCORD_TOKEN) config.discord.token = process.env.DISCORD_TOKEN;
  if (process.env.DISCORD_CLIENT_ID) config.discord.clientId = process.env.DISCORD_CLIENT_ID;
  if (process.env.DISCORD_CLIENT_SECRET) config.discord.clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (process.env.DISCORD_REDIRECT_URI) config.discord.redirectUri = process.env.DISCORD_REDIRECT_URI;
  if (process.env.API_HOST) config.api.host = process.env.API_HOST;
  if (process.env.API_PORT) config.api.port = Number(process.env.API_PORT);
  if (process.env.API_BASE_URL) config.api.baseUrl = process.env.API_BASE_URL;
  if (process.env.WEB_BASE_URL) config.web.baseUrl = process.env.WEB_BASE_URL;
  if (process.env.DEV_AUTH_ENABLED) config.development.enabled = process.env.DEV_AUTH_ENABLED === 'true';
  if (process.env.DEV_USER_ID) config.development.userId = process.env.DEV_USER_ID;
  if (process.env.DEV_USERNAME) config.development.username = process.env.DEV_USERNAME;
  if (process.env.DEV_GUILD_ID) config.development.guildId = process.env.DEV_GUILD_ID;
  if (process.env.DEV_GUILD_NAME) config.development.guildName = process.env.DEV_GUILD_NAME;
  config.storage = { clipsDir: './data/clips', databasePath: './data/bot.db', defaultQuotaBytes:1073741824, ...(config.storage || {}) };
  if (process.env.CLIPS_DIR) config.storage.clipsDir = process.env.CLIPS_DIR;
  if (process.env.DATABASE_PATH) config.storage.databasePath = process.env.DATABASE_PATH;
  if (process.env.DEFAULT_STORAGE_QUOTA_BYTES) config.storage.defaultQuotaBytes = Number(process.env.DEFAULT_STORAGE_QUOTA_BYTES);
  return config;
}
function log(message) { console.log(`[${new Date().toISOString()}] ${message}`); }
function formatDuration(seconds) { const s = Math.max(0, Math.round(seconds)); return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; }
function parseDuration(input, fallback = 30) {
  if (!input) return fallback;
  const match = String(input).trim().match(/^(\d+)(s|m)?$/i);
  if (!match) return null;
  const value = Number(match[1]) * (match[2]?.toLowerCase() === 'm' ? 60 : 1);
  return value > 0 && value <= 30 * 60 ? value : null;
}
module.exports = { loadConfig, log, formatDuration, parseDuration };
