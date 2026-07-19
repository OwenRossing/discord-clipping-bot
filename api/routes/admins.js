const express = require('express');
const db = require('../db');
const { requireAuth, isGuildOwner } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function assertOwner(req, res, guildId) {
  if (!req.user.guildIds?.includes(guildId) || !isGuildOwner(req, guildId)) {
    res.status(403).json({ error: 'Only the Discord server owner can manage bot admins.' });
    return false;
  }
  return true;
}

router.get('/:guild', (req, res) => {
  if (!assertOwner(req, res, req.params.guild)) return;
  const admins = db.prepare('SELECT user_id, added_by, created_at FROM server_admins WHERE guild_id=? ORDER BY created_at').all(req.params.guild);
  res.json({ admins });
});

router.post('/:guild', (req, res) => {
  if (!assertOwner(req, res, req.params.guild)) return;
  const userId = String(req.body.user_id || '').trim();
  if (!/^\d{17,20}$/.test(userId)) return res.status(400).json({ error: 'Enter a valid Discord user ID.' });
  if (userId === req.user.userId) return res.status(400).json({ error: 'The server owner already has access.' });
  const now = Date.now();
  db.prepare('INSERT OR IGNORE INTO servers(guild_id, created_at) VALUES(?, ?)').run(req.params.guild, now);
  db.prepare('INSERT OR IGNORE INTO server_admins(guild_id, user_id, added_by, created_at) VALUES(?,?,?,?)').run(req.params.guild, userId, req.user.userId, now);
  res.status(201).json({ ok: true });
});

router.delete('/:guild/:userId', (req, res) => {
  if (!assertOwner(req, res, req.params.guild)) return;
  db.prepare('DELETE FROM server_admins WHERE guild_id=? AND user_id=?').run(req.params.guild, req.params.userId);
  res.status(204).end();
});

module.exports = router;
