const db = require('../api/db');

function consentMode(guildId) {
  return db.prepare('SELECT consent_mode FROM servers WHERE guild_id=?').get(guildId)?.consent_mode || 'notice';
}

function recordingPreference(guildId, userId) {
  const row = db.prepare('SELECT recording_allowed FROM recording_preferences WHERE guild_id=? AND user_id=?').get(guildId, userId);
  return row ? Boolean(row.recording_allowed) : null;
}

function isRecordingAllowed(guildId, userId) {
  const preference = recordingPreference(guildId, userId);
  if (preference !== null) return preference;
  return consentMode(guildId) !== 'explicit';
}

function setRecordingPreference(guildId, userId, allowed, updatedBy = userId) {
  const now = Date.now();
  db.prepare(`INSERT INTO recording_preferences(guild_id,user_id,recording_allowed,updated_by,updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET
    recording_allowed=excluded.recording_allowed,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
    .run(guildId, userId, allowed ? 1 : 0, updatedBy, now);
  return { guildId, userId, allowed:Boolean(allowed), updatedAt:now };
}

module.exports = { consentMode, recordingPreference, isRecordingAllowed, setRecordingPreference };
