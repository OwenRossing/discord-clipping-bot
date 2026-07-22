const express = require('express');
const db = require('../db');
const { requireAuth, isPlatformAdmin } = require('../middleware/auth');
const { guildUsage } = require('../storage');
const { attachGuildAccess } = require('../guildAccess');

const router = express.Router();
router.use(requireAuth);
router.param('guild', (req, res, next, guildId) => { attachGuildAccess(req, guildId).then(() => next(), next); });

function allowed(req, guildId) { return isPlatformAdmin(req, guildId); }
function response(row) {
  return {
    guild_id:row.guild_id,
    clips_channel_id:row.clips_channel_id,
    buffer_size_minutes:Number(row.buffer_size_minutes || 30),
    retention_days:Number(row.retention_days || 90),
    consent_mode:row.consent_mode || 'notice',
    storage_quota_bytes:Number(row.storage_quota_bytes || 1073741824),
    storage_used_bytes:guildUsage(row.guild_id),
    onboarding_completed_at:row.onboarding_completed_at
  };
}

router.get('/:guild', (req, res) => {
  if (!allowed(req, req.params.guild)) return res.status(403).json({ error:'Admin access required.' });
  const row = db.prepare('SELECT * FROM servers WHERE guild_id=?').get(req.params.guild);
  if (!row) return res.status(404).json({ error:'Server not found.' });
  res.json(response(row));
});

router.post('/:guild', (req, res) => {
  if (!allowed(req, req.params.guild)) return res.status(403).json({ error:'Admin access required.' });
  const body = req.body || {};
  const consentMode = ['notice', 'explicit'].includes(body.consent_mode) ? body.consent_mode : 'notice';
  const bufferMinutes = Math.min(30, Math.max(15, Number(body.buffer_size_minutes) || 30));
  const retentionDays = Math.min(3650, Math.max(1, Number(body.retention_days) || 90));
  const now = Date.now();
  db.prepare(`INSERT INTO servers(guild_id,clips_channel_id,buffer_size_minutes,retention_days,consent_mode,onboarding_completed_at,created_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET
    clips_channel_id=excluded.clips_channel_id,buffer_size_minutes=excluded.buffer_size_minutes,
    retention_days=excluded.retention_days,consent_mode=excluded.consent_mode,
    onboarding_completed_at=CASE WHEN ? THEN COALESCE(servers.onboarding_completed_at,excluded.onboarding_completed_at) ELSE servers.onboarding_completed_at END`)
    .run(req.params.guild, body.clips_channel_id || null, bufferMinutes, retentionDays, consentMode, body.complete_onboarding ? now : null, now, body.complete_onboarding ? 1 : 0);
  res.json(response(db.prepare('SELECT * FROM servers WHERE guild_id=?').get(req.params.guild)));
});

module.exports = router;
