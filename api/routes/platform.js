const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePlatformOwner } = require('../platformAccess');
const { guildUsage } = require('../storage');

const router = express.Router();
router.use(requireAuth, requirePlatformOwner);

const PLAN_DEFAULTS = Object.freeze({
  free:Object.freeze({ storageQuotaBytes:15 * 1024 ** 3, maxClipSeconds:120, maxRetentionDays:90, maxBufferMinutes:15 }),
  premium:Object.freeze({ storageQuotaBytes:1024 ** 4, maxClipSeconds:1800, maxRetentionDays:3650, maxBufferMinutes:30 })
});

function publicPlanDefaults() {
  return Object.fromEntries(Object.entries(PLAN_DEFAULTS).map(([plan, values]) => [plan, {
    storage_quota_bytes:values.storageQuotaBytes,
    max_clip_seconds:values.maxClipSeconds,
    max_retention_days:values.maxRetentionDays,
    max_buffer_minutes:values.maxBufferMinutes
  }]));
}

function integer(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    const error = new Error(`${label} must be between ${minimum.toLocaleString()} and ${maximum.toLocaleString()}.`);
    error.status = 400; error.code = 'INVALID_PLATFORM_LIMIT'; throw error;
  }
  return parsed;
}

function serializeServer(row) {
  return {
    guild_id:row.guild_id,
    name:row.name || row.guild_id,
    bot_display_name:row.bot_display_name || 'ClipThat',
    bot_present:Boolean(row.bot_present),
    plan:row.plan || 'free',
    storage_quota_bytes:Number(row.storage_quota_bytes),
    storage_used_bytes:guildUsage(row.guild_id),
    max_clip_seconds:Number(row.max_clip_seconds || 1800),
    max_retention_days:Number(row.max_retention_days || 3650),
    max_buffer_minutes:Number(row.max_buffer_minutes || 30),
    suspended:Boolean(row.suspended_at),
    suspended_at:row.suspended_at,
    suspension_reason:row.suspension_reason || '',
    clip_count:Number(row.clip_count || 0)
  };
}

router.get('/servers', (req, res) => {
  const search = String(req.query.search || '').trim().slice(0, 80);
  const pattern = `%${search}%`;
  const rows = db.prepare(`SELECT servers.*, COUNT(clips.id) clip_count FROM servers
    LEFT JOIN clips ON clips.guild_id=servers.guild_id
    WHERE (?='' OR servers.guild_id LIKE ? OR COALESCE(servers.name,'') LIKE ?)
    GROUP BY servers.guild_id ORDER BY COALESCE(servers.name,servers.guild_id) LIMIT 200`).all(search, pattern, pattern);
  res.json({ servers:rows.map(serializeServer), plan_defaults:publicPlanDefaults() });
});

router.patch('/servers/:guildId', (req, res, next) => {
  try {
    const server = db.prepare('SELECT * FROM servers WHERE guild_id=?').get(req.params.guildId);
    if (!server) return res.status(404).json({ error:'Server not found.' });
    const body = req.body || {};
    const plan = ['free', 'premium'].includes(body.plan) ? body.plan : null;
    if (!plan) return res.status(400).json({ error:'Plan must be free or premium.', code:'INVALID_PLAN' });
    const defaults = PLAN_DEFAULTS[plan];
    const planChanged = plan !== (server.plan || 'free');
    const nextValues = {
      plan,
      storageQuotaBytes:planChanged ? defaults.storageQuotaBytes : integer(body.storage_quota_bytes, 1_048_576, 10_995_116_277_760, 'Storage quota'),
      maxClipSeconds:planChanged ? defaults.maxClipSeconds : integer(body.max_clip_seconds, 5, 1800, 'Maximum clip duration'),
      maxRetentionDays:planChanged ? defaults.maxRetentionDays : integer(body.max_retention_days, 1, 3650, 'Maximum retention'),
      maxBufferMinutes:planChanged ? defaults.maxBufferMinutes : integer(body.max_buffer_minutes, 5, 30, 'Maximum buffer length'),
      suspended:Boolean(body.suspended),
      suspensionReason:String(body.suspension_reason || '').trim().slice(0, 500)
    };
    if (nextValues.suspended && !nextValues.suspensionReason) return res.status(400).json({ error:'A moderation reason is required when suspending recording.', code:'SUSPENSION_REASON_REQUIRED' });
    const now = Date.now();
    const wasSuspended = Boolean(server.suspended_at);
    const action = nextValues.suspended !== wasSuspended ? (nextValues.suspended ? 'server_suspended' : 'server_reactivated') : 'server_limits_updated';
    db.transaction(() => {
      db.prepare(`UPDATE servers SET plan=?,storage_quota_bytes=?,max_clip_seconds=?,max_retention_days=?,max_buffer_minutes=?,
        retention_days=MIN(retention_days,?),buffer_size_minutes=MIN(buffer_size_minutes,?),
        suspended_at=?,suspended_by=?,suspension_reason=? WHERE guild_id=?`)
        .run(nextValues.plan, nextValues.storageQuotaBytes, nextValues.maxClipSeconds, nextValues.maxRetentionDays,
          nextValues.maxBufferMinutes, nextValues.maxRetentionDays, nextValues.maxBufferMinutes, nextValues.suspended ? (server.suspended_at || now) : null,
          nextValues.suspended ? req.user.userId : null, nextValues.suspended ? nextValues.suspensionReason : null, req.params.guildId);
      db.prepare('INSERT INTO platform_activity(guild_id,actor_id,action,details,created_at) VALUES(?,?,?,?,?)')
        .run(req.params.guildId, req.user.userId, action, JSON.stringify({
          before:{ plan:server.plan, storage_quota_bytes:server.storage_quota_bytes, max_clip_seconds:server.max_clip_seconds, max_retention_days:server.max_retention_days, max_buffer_minutes:server.max_buffer_minutes, suspended:Boolean(server.suspended_at) },
          after:nextValues
        }), now);
    })();
    const updated = db.prepare(`SELECT servers.*, (SELECT COUNT(*) FROM clips WHERE clips.guild_id=servers.guild_id) clip_count FROM servers WHERE guild_id=?`).get(req.params.guildId);
    res.json({ server:serializeServer(updated) });
  } catch (error) { next(error); }
});

router.get('/activity', (req, res) => {
  const rows = db.prepare(`SELECT platform_activity.*,servers.name FROM platform_activity
    LEFT JOIN servers ON servers.guild_id=platform_activity.guild_id ORDER BY platform_activity.created_at DESC LIMIT 100`).all();
  res.json({ activity:rows.map(row => ({ ...row, details:JSON.parse(row.details || '{}') })) });
});

module.exports = router;
module.exports.PLAN_DEFAULTS = PLAN_DEFAULTS;
