const db = require('../api/db');

function syncGuild(guild, botPresent = true) {
  const now = Date.now();
  const botDisplayName = guild.members?.me?.nickname || 'ClipThat';
  db.prepare(`INSERT INTO servers(guild_id,name,icon_hash,owner_id,bot_present,profile_updated_at,created_at,bot_display_name)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET
    name=excluded.name, icon_hash=excluded.icon_hash, owner_id=excluded.owner_id,
    bot_present=excluded.bot_present, profile_updated_at=excluded.profile_updated_at,
    bot_display_name=excluded.bot_display_name`)
    .run(guild.id, guild.name, guild.icon || null, guild.ownerId || null, botPresent ? 1 : 0, now, now, botDisplayName);
}

function reconcileGuilds(guilds) {
  db.transaction(() => {
    db.prepare('UPDATE servers SET bot_present=0').run();
    for (const guild of guilds) syncGuild(guild, true);
  })();
}

function markGuildRemoved(guild) {
  syncGuild(guild, false);
  setRuntime(guild.id, null);
}

function setRuntime(guildId, state) {
  const now = Date.now();
  if (!state) {
    db.prepare(`INSERT INTO server_runtime(guild_id,connected,speaker_count,updated_at) VALUES(?,0,0,?)
      ON CONFLICT(guild_id) DO UPDATE SET connected=0,voice_channel_id=NULL,voice_channel_name=NULL,recorder_started_at=NULL,speaker_count=0,last_packet_at=NULL,updated_at=excluded.updated_at`)
      .run(guildId, now);
    return;
  }
  const status = state.recorder.status();
  db.prepare(`INSERT INTO server_runtime(guild_id,connected,voice_channel_id,voice_channel_name,recorder_started_at,speaker_count,last_packet_at,updated_at)
    VALUES(?,1,?,?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET
    connected=1,voice_channel_id=excluded.voice_channel_id,voice_channel_name=excluded.voice_channel_name,
    recorder_started_at=excluded.recorder_started_at,speaker_count=excluded.speaker_count,
    last_packet_at=excluded.last_packet_at,updated_at=excluded.updated_at`)
    .run(guildId, state.voiceChannelId, state.voiceChannelName, state.startedAt, status.users, status.lastPacketAt, now);
}

module.exports = { syncGuild, reconcileGuilds, markGuildRemoved, setRuntime };
