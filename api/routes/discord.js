const express = require('express');
const { requireAuth, isPlatformAdmin } = require('../middleware/auth');
const { loadConfig } = require('../../bot/utils');

const router = express.Router();
const config = loadConfig();
router.use(requireAuth);

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

module.exports = router;
