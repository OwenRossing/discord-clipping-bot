const db = require('../db');
function requireAuth(req, res, next) {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Authentication required. Configure Discord OAuth, then sign in.' });
  if (user.development && process.env.NODE_ENV !== 'production') {
    const guildIds = (user.guildIds || []).slice(0, 1);
    const knownServers = guildIds.length ? db.prepare('SELECT guild_id, name, icon_hash FROM servers WHERE guild_id=?').all(guildIds[0]) : [];
    const profiles = new Map(knownServers.map(server => [server.guild_id, server]));
    const knownNames = new Map((user.guilds || []).map(guild => [guild.id, guild.name]));
    user.guildIds = guildIds;
    user.ownerGuilds = guildIds;
    user.roleAdminGuilds = guildIds;
    user.guilds = guildIds.map(guildId => { const remembered = knownNames.get(guildId); return { id:guildId, name:profiles.get(guildId)?.name || (remembered === `Discord Server ${guildId}` ? null : remembered) || 'Development server', icon:profiles.get(guildId)?.icon_hash || null }; });
  }
  req.user = user; next();
}
function currentAccess(req, guildId) { return req.guildAccesses?.get(guildId) || (req.guildAccess?.guildId === guildId ? req.guildAccess : null); }
function isPlatformAdmin(req, guildId) { const live = currentAccess(req, guildId); return live ? live.member && live.canManage : req.user.roleAdminGuilds?.includes(guildId) || Boolean(db.prepare('SELECT 1 FROM server_admins WHERE guild_id=? AND user_id=?').get(guildId, req.user.userId)); }
function isGuildOwner(req, guildId) { const live = currentAccess(req, guildId); return live ? live.member && live.isOwner : req.user.ownerGuilds?.includes(guildId); }
function mayEdit(req, clip) { return req.user.userId === clip.created_by || isPlatformAdmin(req, clip.guild_id); }
function hasGuildAccess(req, guildId) { const live = currentAccess(req, guildId); return live ? Boolean(live.member) : Boolean(req.user.guildIds?.includes(guildId)); }
function clipCapabilities(req, clip) {
  const member = hasGuildAccess(req, clip.guild_id);
  const admin = member && isPlatformAdmin(req, clip.guild_id);
  const creator = member && req.user.userId === clip.created_by;
  const active = !clip.deleted_at;
  return {
    canPlay: member && (active || admin),
    canRename: member && active,
    canEditAudio: active && (creator || admin),
    canDelete: active && (creator || admin),
    canFavorite: active && (creator || admin),
    canViewRevisions: admin,
    canRollback: active && admin,
    canRestore: !active && admin
  };
}
function sessionFromToken(token) { return db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>?').get(token, Date.now()); }
module.exports = { requireAuth, mayEdit, isPlatformAdmin, isGuildOwner, hasGuildAccess, clipCapabilities, sessionFromToken };
