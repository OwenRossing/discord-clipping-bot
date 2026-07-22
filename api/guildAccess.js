const db = require('./db');
const { loadConfig } = require('../bot/utils');

const config = loadConfig();
const CACHE_TTL_MS = 5 * 60 * 1000;
const memberCache = new Map();
const roleCache = new Map();

function liveVerificationEnabled() {
  return process.env.LIVE_GUILD_AUTH === 'true' || process.env.NODE_ENV === 'production';
}

function sessionAccess(req, guildId) {
  const member = Boolean(req.user?.guildIds?.includes(guildId));
  const isOwner = member && Boolean(req.user?.ownerGuilds?.includes(guildId));
  const delegated = member && Boolean(db.prepare('SELECT 1 FROM server_admins WHERE guild_id=? AND user_id=?').get(guildId, req.user?.userId));
  const canManage = member && (isOwner || req.user?.roleAdminGuilds?.includes(guildId) || delegated);
  return { guildId, member, isOwner, canManage, delegated, verified:false };
}

async function cached(cache, key, loader, now = Date.now()) {
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) return existing.value;
  const value = await loader();
  cache.set(key, { value, expiresAt:now + CACHE_TTL_MS });
  return value;
}

async function discordJson(path, fetchImpl) {
  const response = await fetchImpl(`https://discord.com/api/v10${path}`, {
    headers:{ Authorization:`Bot ${config.discord.token}` },
    signal:AbortSignal.timeout(5000)
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const error = new Error('Discord could not verify current server access. Try again shortly.');
    error.status = 503;
    error.code = 'GUILD_ACCESS_UNAVAILABLE';
    throw error;
  }
  return response.json();
}

async function resolveGuildAccess(req, guildId, options = {}) {
  const snapshot = sessionAccess(req, guildId);
  if (!snapshot.member || req.user?.development || !liveVerificationEnabled()) return snapshot;
  if (!config.discord?.token) {
    const error = new Error('Discord access verification is not configured.');
    error.status = 503;
    error.code = 'GUILD_ACCESS_UNAVAILABLE';
    throw error;
  }
  const fetchImpl = options.fetchImpl || fetch;
  const member = await cached(memberCache, `${guildId}:${req.user.userId}`, () => discordJson(`/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(req.user.userId)}`, fetchImpl));
  if (!member) return { guildId, member:false, isOwner:false, canManage:false, delegated:false, verified:true };
  const server = db.prepare('SELECT owner_id FROM servers WHERE guild_id=? AND bot_present=1').get(guildId);
  const isOwner = server?.owner_id === req.user.userId;
  const delegated = Boolean(db.prepare('SELECT 1 FROM server_admins WHERE guild_id=? AND user_id=?').get(guildId, req.user.userId));
  const roles = await cached(roleCache, guildId, () => discordJson(`/guilds/${encodeURIComponent(guildId)}/roles`, fetchImpl));
  let permissions = 0n;
  for (const role of roles || []) if (role.id === guildId || member.roles?.includes(role.id)) permissions |= BigInt(role.permissions || 0);
  const canManage = isOwner || delegated || (permissions & 0x8n) !== 0n || (permissions & 0x20n) !== 0n;
  return { guildId, member:true, isOwner, canManage, delegated, verified:true };
}

async function attachGuildAccess(req, guildId, options) {
  req.guildAccess = await resolveGuildAccess(req, String(guildId), options);
  if (!req.guildAccesses) req.guildAccesses = new Map();
  req.guildAccesses.set(String(guildId), req.guildAccess);
  return req.guildAccess;
}

function clearGuildAccessCache() {
  memberCache.clear();
  roleCache.clear();
}

module.exports = { CACHE_TTL_MS, liveVerificationEnabled, sessionAccess, resolveGuildAccess, attachGuildAccess, clearGuildAccessCache };
