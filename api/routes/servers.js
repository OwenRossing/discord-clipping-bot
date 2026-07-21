const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { requireAuth, hasGuildAccess, isPlatformAdmin, isGuildOwner } = require('../middleware/auth');
const clipsRouter = require('./clips');
const { guildUsage, serverQuota, removeClipDirectory, removePreviewFile } = require('../storage');

const router = express.Router();
router.use(requireAuth);

function iconUrl(guild) {
  const hash = guild.icon_hash || guild.icon;
  return hash ? `https://cdn.discordapp.com/icons/${guild.guild_id || guild.id}/${hash}.webp?size=128` : null;
}

function accentFor(id) {
  const bytes = crypto.createHash('sha256').update(String(id)).digest();
  const hue = Math.round((bytes[0] / 255) * 360);
  return `hsl(${hue} 72% 62%)`;
}

function sessionGuild(req, id) { return (req.user.guilds || []).find(guild => guild.id === id); }
function usefulName(name, id) { return name && name !== `Discord Server ${id}` ? name : null; }
function parseJson(value, fallback = []) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }

function serverProfile(req, row) {
  const oauth = sessionGuild(req, row.guild_id);
  return {
    id: row.guild_id,
    name: usefulName(oauth?.name, row.guild_id) || usefulName(row.name, row.guild_id) || 'Discord server',
    iconUrl: iconUrl({ ...row, icon: oauth?.icon }),
    accent: accentFor(row.guild_id),
    botInstalled: Boolean(row.bot_present),
    capabilities: {
      canManage: isPlatformAdmin(req, row.guild_id),
      isOwner: isGuildOwner(req, row.guild_id),
      canInstall: Boolean(req.user.roleAdminGuilds?.includes(row.guild_id))
    }
  };
}

router.get('/', (req, res) => {
  const installedRows = db.prepare('SELECT * FROM servers WHERE bot_present=1 ORDER BY COALESCE(name, guild_id)').all()
    .filter(row => hasGuildAccess(req, row.guild_id));
  const installedIds = new Set(installedRows.map(row => row.guild_id));
  const installed = installedRows.map(row => serverProfile(req, row));
  const installable = (req.user.guilds || [])
    .filter(guild => req.user.roleAdminGuilds?.includes(guild.id) && !installedIds.has(guild.id))
    .map(guild => ({ id:guild.id, name:guild.name, iconUrl:iconUrl(guild), accent:accentFor(guild.id), botInstalled:false, capabilities:{ canManage:false, isOwner:Boolean(guild.owner), canInstall:true } }));
  res.json({ installed, installable });
});

router.get('/:guildId/overview', (req, res) => {
  const guildId = req.params.guildId;
  if (!hasGuildAccess(req, guildId)) return res.status(403).json({ error: 'Server access denied.' });
  const row = db.prepare('SELECT * FROM servers WHERE guild_id=? AND bot_present=1').get(guildId);
  if (!row) return res.status(404).json({ error: 'Clip Vault is not installed in this server.' });
  const profile = serverProfile(req, row);
  const now = Date.now();
  const rawRuntime = db.prepare('SELECT * FROM server_runtime WHERE guild_id=?').get(guildId);
  const online = Boolean(rawRuntime && rawRuntime.updated_at >= now - 30_000);
  const runtime = {
    online,
    connected: online && Boolean(rawRuntime.connected),
    voiceChannelId: online ? rawRuntime.voice_channel_id : null,
    voiceChannelName: online ? rawRuntime.voice_channel_name : null,
    recorderStartedAt: online ? rawRuntime.recorder_started_at : null,
    speakerCount: online ? rawRuntime.speaker_count : 0,
    lastPacketAt: online ? rawRuntime.last_packet_at : null
  };
  const counts = db.prepare(`SELECT SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) total,
    SUM(CASE WHEN favorited=1 AND deleted_at IS NULL THEN 1 ELSE 0 END) favorites,
    SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) trash
    FROM clips WHERE guild_id=?`).get(guildId);
  const recent = db.prepare('SELECT * FROM clips WHERE guild_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 6').all(guildId).map(clip => clipsRouter.serializeClip(req, clip));
  const favorites = db.prepare('SELECT * FROM clips WHERE guild_id=? AND deleted_at IS NULL AND favorited=1 ORDER BY created_at DESC LIMIT 6').all(guildId).map(clip => clipsRouter.serializeClip(req, clip));
  const setup = {
    botInstalled: true,
    botOnline: online,
    clipsChannelConfigured: Boolean(row.clips_channel_id),
    consentConfigured: Boolean(row.onboarding_completed_at),
    hasClips: Number(counts.total || 0) > 0
  };
  setup.complete = setup.botOnline && setup.clipsChannelConfigured && setup.consentConfigured;
  res.json({ server:profile, runtime, setup, storage:{ usedBytes:guildUsage(guildId), quotaBytes:serverQuota(guildId) }, counts:{ total:Number(counts.total || 0), favorites:Number(counts.favorites || 0), trash:Number(counts.trash || 0) }, recent, favorites });
});

router.get('/:guildId/export', (req, res) => {
  const guildId = req.params.guildId;
  if (!hasGuildAccess(req, guildId) || !isPlatformAdmin(req, guildId)) return res.status(403).json({ error:'Bot admin access required.' });
  const server = db.prepare('SELECT guild_id,name,clips_channel_id,buffer_size_minutes,retention_days,consent_mode,storage_quota_bytes,created_at FROM servers WHERE guild_id=?').get(guildId);
  if (!server) return res.status(404).json({ error:'Server not found.' });
  const clips = db.prepare('SELECT id,title,duration,users_involved,created_by,created_at,expires_at,favorited,deleted_at,deletion_reason,storage_bytes FROM clips WHERE guild_id=? ORDER BY created_at').all(guildId)
    .map(clip => ({ ...clip, users_involved:parseJson(clip.users_involved), revisions:db.prepare('SELECT id,revision_number,start_trim,end_trim,created_by,created_at FROM clip_revisions WHERE clip_id=? ORDER BY revision_number').all(clip.id) }));
  const payload = { exportedAt:new Date().toISOString(), server, clips, recordingPreferences:db.prepare('SELECT user_id,recording_allowed,updated_at FROM recording_preferences WHERE guild_id=?').all(guildId), activity:db.prepare('SELECT clip_id,actor_id,action,details,created_at FROM clip_activity WHERE guild_id=? ORDER BY created_at').all(guildId) };
  res.set('Content-Disposition', `attachment; filename="clip-vault-${guildId}-export.json"`);
  res.type('application/json').send(JSON.stringify(payload, null, 2));
});

router.delete('/:guildId/data', (req, res) => {
  const guildId = req.params.guildId;
  if (!hasGuildAccess(req, guildId) || !isGuildOwner(req, guildId)) return res.status(403).json({ error:'Only the Discord server owner can erase server data.' });
  if (String(req.body?.confirmation || '') !== guildId) return res.status(400).json({ error:'Type the server ID exactly to confirm permanent deletion.' });
  const clips = db.prepare('SELECT id,original_audio_path FROM clips WHERE guild_id=?').all(guildId);
  const previews = db.prepare('SELECT audio_path FROM clip_previews WHERE clip_id IN (SELECT id FROM clips WHERE guild_id=?)').all(guildId);
  for (const preview of previews) removePreviewFile(preview.audio_path);
  for (const clip of clips) removeClipDirectory(clip.original_audio_path);
  db.transaction(() => {
    db.prepare('DELETE FROM clip_previews WHERE clip_id IN (SELECT id FROM clips WHERE guild_id=?)').run(guildId);
    db.prepare('DELETE FROM clip_revisions WHERE clip_id IN (SELECT id FROM clips WHERE guild_id=?)').run(guildId);
    db.prepare('DELETE FROM clips WHERE guild_id=?').run(guildId);
    db.prepare('DELETE FROM clip_activity WHERE guild_id=?').run(guildId);
    db.prepare('DELETE FROM recording_preferences WHERE guild_id=?').run(guildId);
    db.prepare('DELETE FROM server_admins WHERE guild_id=?').run(guildId);
    db.prepare(`UPDATE servers SET clips_channel_id=NULL,buffer_size_minutes=30,retention_days=90,consent_mode='notice',onboarding_completed_at=NULL WHERE guild_id=?`).run(guildId);
  })();
  console.warn(JSON.stringify({ event:'server_data_erased', guildId, actorId:req.user.userId, clips:clips.length }));
  res.status(202).json({ ok:true, clipsDeleted:clips.length });
});

module.exports = router;
module.exports.accentFor = accentFor;
