const crypto = require('crypto');
const express = require('express');
const { loadConfig } = require('../../bot/utils');
const db = require('../db');
const { ensureCsrfToken } = require('../middleware/security');
const { developmentCodeAvailable, consumeDevelopmentCode } = require('../devAuth');
const config = loadConfig();
const router = express.Router();
const regenerate = req => new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
const save = req => new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
function isLoopback(req) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress); }
function isDirectLocalRequest(req) {
  if (!isLoopback(req)) return false;
  const forwarded = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip', 'cf-ray'];
  if (forwarded.some(header => req.get(header))) return false;
  try {
    const host = new URL(`http://${req.get('Host') || ''}`);
    const origin = new URL(req.get('Origin') || '');
    return ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)
      && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      && host.host === origin.host;
  } catch { return false; }
}
const attempts = new Map();
const attemptCleanup = setInterval(() => { const cutoff = Date.now() - 15 * 60 * 1000; for (const [key, times] of attempts) { const recent = times.filter(time => time > cutoff); if (recent.length) attempts.set(key, recent); else attempts.delete(key); } }, 15 * 60 * 1000);
attemptCleanup.unref();
function limited(req, res, limit = 12) {
  const now = Date.now(), key = req.ip || req.socket.remoteAddress;
  const recent = (attempts.get(key) || []).filter(time => time > now - 15 * 60 * 1000);
  if (recent.length >= limit) { res.status(429).json({ error: 'Too many login attempts. Try again later.' }); return true; }
  recent.push(now); attempts.set(key, recent); return false;
}
function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value) || /%(?:2f|5c)/i.test(value)) return '/';
  try {
    const base = new URL(config.api.baseUrl);
    const target = new URL(value, base);
    return target.origin === base.origin ? `${target.pathname}${target.search}${target.hash}` : '/';
  } catch { return '/'; }
}
function avatarUrl(user) { return user.avatar ? `https://cdn.discordapp.com/avatars/${user.userId}/${user.avatar}.webp?size=128` : null; }

router.get('/mode', (req, res) => res.json({
  developmentLogin: process.env.NODE_ENV !== 'production' && Boolean(config.development?.enabled) && developmentCodeAvailable(),
  developmentLoginCodeRequired: true,
  csrfToken: ensureCsrfToken(req)
}));
router.get('/login', (req, res) => {
  if (limited(req, res, 20)) return;
  if (!config.discord?.clientId || !config.discord?.clientSecret || !config.discord?.redirectUri) return res.status(503).type('text/plain').send('Discord login is not configured. Set Discord environment variables first.');
  const state = crypto.randomBytes(16).toString('hex'); req.session.oauthState = state; req.session.returnTo = safeReturnTo(req.query.return_to);
  const params = new URLSearchParams({ client_id: config.discord.clientId, redirect_uri: config.discord.redirectUri, response_type: 'code', scope: 'identify guilds', state });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});
router.get('/discord/callback', async (req, res) => {
  const expectedState = req.session.oauthState;
  const returnTo = safeReturnTo(req.session.returnTo);
  delete req.session.oauthState;
  delete req.session.returnTo;
  if (req.query.error) return res.status(400).type('text/plain').send(`Discord authorization was not completed: ${req.query.error_description || req.query.error}`);
  if (!req.query.code || !expectedState || req.query.state !== expectedState) return res.status(400).type('text/plain').send('Invalid or expired OAuth state. Start the login again.');
  try {
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.discord.clientId, client_secret: config.discord.clientSecret, grant_type: 'authorization_code', code: req.query.code, redirect_uri: config.discord.redirectUri }) });
    const token = await tokenResponse.json(); if (!tokenResponse.ok || !token.access_token) throw new Error(token.error_description || token.error || 'Discord token exchange failed');
    const authHeaders = { Authorization: `Bearer ${token.access_token}` };
    const [userResponse, guildResponse] = await Promise.all([fetch('https://discord.com/api/v10/users/@me', { headers: authHeaders }), fetch('https://discord.com/api/v10/users/@me/guilds', { headers: authHeaders })]);
    if (!userResponse.ok || !guildResponse.ok) throw new Error('Discord profile lookup failed');
    const user = await userResponse.json();
    const guilds = await guildResponse.json();
    const ownerGuilds = guilds.filter(g => g.owner).map(g => g.id);
    const roleAdminGuilds = guilds.filter(g => g.owner || (BigInt(g.permissions) & 0x20n) !== 0n).map(g => g.id);
    await regenerate(req);
    req.session.user = { userId: user.id, username: user.global_name || user.username, avatar: user.avatar, guilds: guilds.map(g => ({ id: g.id, name: g.name, icon: g.icon, owner: Boolean(g.owner), permissions: g.permissions })), guildIds: guilds.map(g => g.id), ownerGuilds, roleAdminGuilds };
    const updateServer = db.prepare('UPDATE servers SET name=?, icon_hash=?, owner_id=COALESCE(owner_id, ?), profile_updated_at=? WHERE guild_id=?');
    for (const guild of guilds) updateServer.run(guild.name, guild.icon || null, guild.owner ? user.id : null, Date.now(), guild.id);
    ensureCsrfToken(req);
    await save(req);
    res.redirect(returnTo);
  } catch (error) { res.status(502).type('text/plain').send(`Discord authentication failed: ${error.message}`); }
});

router.post('/dev', async (req, res, next) => {
  if (limited(req, res)) return;
  if (process.env.NODE_ENV === 'production' || !config.development?.enabled || !isDirectLocalRequest(req)) return res.status(404).json({ error: 'Development login is unavailable.', code:'DEV_LOGIN_UNAVAILABLE' });
  if (!process.env.DEV_USER_ID || !process.env.DEV_GUILD_ID) return res.status(503).json({ error:'Development login requires explicit DEV_USER_ID and DEV_GUILD_ID values.', code:'DEV_LOGIN_NOT_CONFIGURED' });
  if (!consumeDevelopmentCode(req.body?.code)) return res.status(401).json({ error:'That temporary code is invalid or expired. Restart the development server for a new code.', code:'DEV_CODE_INVALID' });
  try {
    const guild = { id: String(config.development.guildId), name: config.development.guildName, icon: null, owner: true, permissions: String(0x20) };
    await regenerate(req);
    req.session.user = { userId: String(config.development.userId), username: config.development.username, avatar: null, guilds: [guild], guildIds: [guild.id], ownerGuilds: [guild.id], roleAdminGuilds: [guild.id], development: true };
    db.prepare(`INSERT INTO servers(guild_id, name, owner_id, bot_present, profile_updated_at, created_at, bot_display_name) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(guild_id) DO UPDATE SET name=excluded.name, owner_id=excluded.owner_id, bot_present=1, profile_updated_at=excluded.profile_updated_at,bot_display_name=excluded.bot_display_name`)
      .run(guild.id, guild.name, String(config.development.userId), 1, Date.now(), Date.now(), 'ClipThat');
    const csrfToken = ensureCsrfToken(req);
    await save(req);
    res.json({ ok: true, csrfToken });
  } catch (error) { next(error); }
});
router.post('/logout', (req, res) => req.session.destroy(() => res.status(204).end()));
router.get('/me', (req, res) => {
  if (!req.session.user) return res.json(null);
  if (req.session.user.development && process.env.NODE_ENV !== 'production') {
    const guildIds = (req.session.user.guildIds || []).slice(0, 1);
    const knownServers = guildIds.length ? db.prepare('SELECT guild_id, name, icon_hash FROM servers WHERE guild_id=?').all(guildIds[0]) : [];
    const profiles = new Map(knownServers.map(server => [server.guild_id, server]));
    const knownNames = new Map((req.session.user.guilds || []).map(guild => [guild.id, guild.name]));
    req.session.user.guildIds = guildIds;
    req.session.user.ownerGuilds = guildIds;
    req.session.user.roleAdminGuilds = guildIds;
    req.session.user.guilds = guildIds.map(guildId => { const remembered = knownNames.get(guildId); return { id:guildId, name:profiles.get(guildId)?.name || (remembered === `Discord Server ${guildId}` ? null : remembered) || config.development.guildName || 'Development server', icon:profiles.get(guildId)?.icon_hash || null }; });
  }
  const grants = db.prepare('SELECT guild_id FROM server_admins WHERE user_id=?').all(req.session.user.userId).map(row => row.guild_id);
  const accessGuilds = [...new Set([...(req.session.user.roleAdminGuilds || []), ...grants])];
  res.json({ ...req.session.user, avatarUrl: avatarUrl(req.session.user), accessGuilds, csrfToken: ensureCsrfToken(req) });
});
module.exports = router;
module.exports.safeReturnTo = safeReturnTo;
module.exports.isDirectLocalRequest = isDirectLocalRequest;
