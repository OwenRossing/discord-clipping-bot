const express = require('express');
const db = require('../db');
const { requireAuth, isPlatformAdmin } = require('../middleware/auth');
const router = express.Router(); router.use(requireAuth);
function allowed(req, guild) { return isPlatformAdmin(req, guild); }
router.get('/:guild', (req, res) => { if (!allowed(req, req.params.guild)) return res.status(403).json({ error: 'Admin access required.' }); const row = db.prepare('SELECT * FROM servers WHERE guild_id=?').get(req.params.guild); res.json(row || { guild_id: req.params.guild, buffer_size_minutes: 30, retention_days: 90 }); });
router.post('/:guild', (req, res) => { if (!allowed(req, req.params.guild)) return res.status(403).json({ error: 'Admin access required.' }); const now = Date.now(), body = req.body; db.prepare('INSERT INTO servers(guild_id, clips_channel_id, buffer_size_minutes, retention_days, created_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET clips_channel_id=excluded.clips_channel_id, buffer_size_minutes=excluded.buffer_size_minutes, retention_days=excluded.retention_days').run(req.params.guild, body.clips_channel_id || null, Math.min(30, Math.max(15, Number(body.buffer_size_minutes) || 30)), Math.max(1, Number(body.retention_days) || 90), now); res.json({ ok: true }); });
module.exports = router;
