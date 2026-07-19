const db = require('../db');
function requireAuth(req, res, next) {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Authentication required. Configure Discord OAuth, then sign in.' });
  req.user = user; next();
}
function isPlatformAdmin(req, guildId) { return req.user.roleAdminGuilds?.includes(guildId) || Boolean(db.prepare('SELECT 1 FROM server_admins WHERE guild_id=? AND user_id=?').get(guildId, req.user.userId)); }
function isGuildOwner(req, guildId) { return req.user.ownerGuilds?.includes(guildId); }
function mayEdit(req, clip) { return req.user.userId === clip.created_by || isPlatformAdmin(req, clip.guild_id); }
function sessionFromToken(token) { return db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>?').get(token, Date.now()); }
module.exports = { requireAuth, mayEdit, isPlatformAdmin, isGuildOwner, sessionFromToken };
