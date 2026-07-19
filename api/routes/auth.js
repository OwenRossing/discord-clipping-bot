const crypto = require('crypto');
const express = require('express');
const { loadConfig } = require('../../bot/utils');
const db = require('../db');
const config = loadConfig();
const router = express.Router();
const regenerate = req => new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
const save = req => new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
function isLoopback(req) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress); }

router.get('/mode', (req, res) => res.json({ developmentLogin: process.env.NODE_ENV !== 'production' && Boolean(config.development?.enabled) }));
router.get('/login', (req, res) => {
  if (!config.discord?.clientId || !config.discord?.clientSecret || !config.discord?.redirectUri) return res.status(503).send('Discord login is not configured. Set clientId, clientSecret, and redirectUri in config.json.');
  const state = crypto.randomBytes(16).toString('hex'); req.session.oauthState = state;
  const params = new URLSearchParams({ client_id: config.discord.clientId, redirect_uri: config.discord.redirectUri, response_type: 'code', scope: 'identify guilds', state });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});
router.get('/discord/callback', async (req, res) => {
  const expectedState = req.session.oauthState;
  delete req.session.oauthState;
  if (req.query.error) return res.status(400).send(`Discord authorization was not completed: ${req.query.error_description || req.query.error}`);
  if (!req.query.code || !expectedState || req.query.state !== expectedState) return res.status(400).send('Invalid or expired OAuth state. Start the login again.');
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
    req.session.user = { userId: user.id, username: user.global_name || user.username, avatar: user.avatar, guilds: guilds.map(g => ({ id: g.id, name: g.name, icon: g.icon })), guildIds: guilds.map(g => g.id), ownerGuilds, roleAdminGuilds };
    await save(req);
    res.redirect('/');
  } catch (error) { res.status(502).send(`Discord authentication failed: ${error.message}`); }
});

router.post('/dev', async (req, res, next) => {
  if (process.env.NODE_ENV === 'production' || !config.development?.enabled || !isLoopback(req)) return res.status(404).json({ error: 'Development login is unavailable.' });
  try {
    const guild = { id: String(config.development.guildId), name: config.development.guildName, icon: null };
    await regenerate(req);
    req.session.user = { userId: String(config.development.userId), username: config.development.username, avatar: null, guilds: [guild], guildIds: [guild.id], ownerGuilds: [guild.id], roleAdminGuilds: [guild.id], development: true };
    db.prepare('INSERT OR IGNORE INTO servers(guild_id, created_at) VALUES(?, ?)').run(guild.id, Date.now());
    await save(req);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
router.post('/logout', (req, res) => req.session.destroy(() => res.status(204).end()));
router.get('/me', (req, res) => {
  if (!req.session.user) return res.json(null);
  const grants = db.prepare('SELECT guild_id FROM server_admins WHERE user_id=?').all(req.session.user.userId).map(row => row.guild_id);
  const accessGuilds = [...new Set([...(req.session.user.roleAdminGuilds || []), ...grants])];
  res.json({ ...req.session.user, accessGuilds });
});
module.exports = router;
