const express = require('express');
const { requireAuth, isPlatformAdmin } = require('../middleware/auth');
const { loadConfig } = require('../../bot/utils');
const db = require('../db');
const { attachGuildAccess } = require('../guildAccess');

const router = express.Router();
const config = loadConfig();
router.use(requireAuth);
router.param('guild', (req, res, next, guildId) => { attachGuildAccess(req, guildId).then(() => next(), next); });

router.get('/:guild/channels', async (req, res, next) => {
  if (!isPlatformAdmin(req, req.params.guild)) return res.status(403).json({ error: 'Bot admin access required.' });
  if (!config.discord?.token) return res.status(503).json({ error: 'The Discord bot token is not configured.' });
  try {
    const response = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(req.params.guild)}/channels`, { headers: { Authorization: `Bot ${config.discord.token}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return res.status(response.status === 404 ? 404 : 502).json({ error: 'Discord channels could not be loaded. Make sure the bot is installed in this server.' });
    const channels = (await response.json()).filter(channel => channel.type === 0 || channel.type === 5).sort((a, b) => a.position - b.position).map(channel => ({ id: channel.id, name: channel.name }));
    res.json({ channels });
  } catch (error) { if (error.name === 'TimeoutError') return res.status(504).json({ error: 'Discord channel lookup timed out. You can still save the other settings.' }); next(error); }
});

router.get('/:guild/install-url', (req, res) => {
  const guildId = req.params.guild;
  const guild = req.user.guilds?.find(item => item.id === guildId);
  if (!guild || !req.user.roleAdminGuilds?.includes(guildId)) return res.status(403).json({ error: 'Manage Server permission is required to install the bot.' });
  if (db.prepare('SELECT 1 FROM servers WHERE guild_id=? AND bot_present=1').get(guildId)) return res.status(409).json({ error: 'The bot is already installed in this server.' });
  if (!config.discord?.clientId) return res.status(503).json({ error: 'Discord application ID is not configured.' });
  const permissions = 1024n | 2048n | 16384n | 32768n | 1048576n | 2097152n | 33554432n;
  const params = new URLSearchParams({ client_id:config.discord.clientId, scope:'bot applications.commands', permissions:String(permissions), guild_id:guildId, disable_guild_select:'true' });
  res.json({ url:`https://discord.com/oauth2/authorize?${params}` });
});

module.exports = router;
