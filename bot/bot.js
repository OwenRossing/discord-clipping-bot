const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Events,
  GatewayIntentBits, REST, Routes
} = require('discord.js');
const {
  AudioPlayerStatus, createAudioPlayer, createAudioResource, entersState,
  joinVoiceChannel, VoiceConnectionStatus
} = require('@discordjs/voice');
const db = require('../api/db');
const Recorder = require('./recorder');
const commands = require('./commands');
const { isBotAdmin } = require('./access');
const { consentMode, isRecordingAllowed, recordingPreference, setRecordingPreference } = require('./consent');
const { createClip } = require('./clipManager');
const { affectedClips, cloneWithParticipant, currentRevision, participant, participants, removeParticipant, revisionReady } = require('./participation');
const { ephemeral, runInteraction } = require('./interactionResponses');
const { reconcileGuilds, markGuildRemoved, setRuntime, syncGuild } = require('./runtimeStore');
const { loadConfig, log, parseDuration, formatDuration } = require('./utils');
const { clipsRoot, inside } = require('../api/storage');

const config = loadConfig();
const client = new Client({ intents:[GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const active = new Map();

function botName(guild) {
  return guild?.members?.me?.nickname || 'ClipThat';
}

function dashboardUrl(pathname = '/') {
  return new URL(pathname, config.api.baseUrl).toString();
}

function getServerSettings(guildId) {
  db.prepare('INSERT OR IGNORE INTO servers(guild_id, created_at) VALUES(?, ?)').run(guildId, Date.now());
  return db.prepare('SELECT * FROM servers WHERE guild_id=?').get(guildId);
}

function ensureRecordingAvailable(settings) {
  if (settings.suspended_at) throw new Error(`Recording is paused for this server${settings.suspension_reason ? `: ${settings.suspension_reason}` : '.'}`);
}

function clipButtons(clipId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`play:${clipId}`).setLabel('Play in voice').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setURL(dashboardUrl(`/clips/${clipId}`)).setLabel('Open dashboard').setStyle(ButtonStyle.Link),
    new ButtonBuilder().setCustomId(`clip-remove:${clipId}`).setLabel('Remove my voice').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`clip-clone:${clipId}`).setLabel('Add me (new cut)').setStyle(ButtonStyle.Secondary)
  );
}

function clipEmbed(clip) {
  const speakers = participants(clip.id, true);
  return new EmbedBuilder()
    .setTitle(`Voice clip: ${clip.title}`)
    .setDescription(`**${formatDuration((clip.end_trim || clip.duration) - (clip.start_trim || 0))}** - created by <@${clip.created_by}>\n${speakers.length ? speakers.map(speaker => speaker.display_name).join(', ') : 'No voices currently included'}`)
    .setColor(0x7c8cff)
    .setTimestamp(clip.created_at || Date.now());
}

function playableRevision(clip) {
  const revision = currentRevision(clip);
  if (!revision || !inside(clipsRoot, clip.original_audio_path) || !inside(clip.original_audio_path, revision.audio_path)) throw new Error('The clip audio failed a storage safety check.');
  return revision;
}

async function postClipMessage(destination, clipInfo) {
  const clip = db.prepare('SELECT * FROM clips WHERE id=?').get(clipInfo.clip_id || clipInfo.id);
  const revision = playableRevision(clip);
  const message = await destination.send({ embeds:[clipEmbed(clip)], files:[{ attachment:revision.audio_path, name:`clip-${clip.id}.mp3` }], components:[clipButtons(clip.id)] });
  db.prepare('UPDATE clips SET discord_channel_id=?,discord_message_id=?,discord_sync_pending=0 WHERE id=?').run(message.channelId, message.id, clip.id);
  return message;
}

async function syncClipMessage(clipId) {
  const clip = db.prepare('SELECT * FROM clips WHERE id=?').get(clipId);
  if (!clip?.discord_channel_id || !clip.discord_message_id) return;
  const channel = await client.channels.fetch(clip.discord_channel_id).catch(() => null);
  const message = await channel?.messages?.fetch(clip.discord_message_id).catch(() => null);
  if (!message) {
    db.prepare('UPDATE clips SET discord_channel_id=NULL,discord_message_id=NULL,discord_sync_pending=0 WHERE id=?').run(clip.id);
    return;
  }
  const revision = playableRevision(clip);
  if (!revisionReady(clip, revision)) {
    await message.edit({ attachments:[] });
    return;
  }
  await message.edit({ embeds:[clipEmbed(clip)], components:[clipButtons(clip.id)], attachments:[], files:[{ attachment:revision.audio_path, name:`clip-${clip.id}.mp3` }] });
  db.prepare('UPDATE clips SET discord_sync_pending=0 WHERE id=?').run(clip.id);
}

async function recordClip({ guild, guildId, user, channel, duration, title }) {
  const settings = getServerSettings(guildId);
  ensureRecordingAvailable(settings);
  if (duration > Number(settings.max_clip_seconds || 1800)) throw new Error(`This server limits clips to ${formatDuration(settings.max_clip_seconds || 1800)}.`);
  const state = active.get(guildId);
  if (!state) throw new Error('Recording is not active. Ask a bot admin to use `/record start`.');
  const clip = await createClip({ guildId, createdBy:user.id, duration, title, audio:state.recorder.extract(duration), members:[...guild.members.cache.values()] });
  const destination = guild.channels.cache.get(settings.clips_channel_id)
    || guild.channels.cache.find(candidate => candidate.name === config.bot.defaultClipsChannel)
    || channel;
  await postClipMessage(destination, clip);
  return clip;
}

async function startRecording(interaction, legacy = false) {
  if (!isBotAdmin(interaction.guild, interaction.member)) throw new Error('Bot admin access is required. The server owner can delegate access from the web dashboard.');
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) throw new Error('Join a voice channel first, then run `/record start`.');
  await interaction.deferReply(ephemeral());
  const previous = active.get(interaction.guildId);
  previous?.recorder.stop(); previous?.connection.destroy();
  const settings = getServerSettings(interaction.guildId);
  ensureRecordingAvailable(settings);
  const connection = joinVoiceChannel({ channelId:voiceChannel.id, guildId:interaction.guildId, adapterCreator:interaction.guild.voiceAdapterCreator, selfDeaf:false, selfMute:true, daveEncryption:true });
  connection.on('error', error => log(`Voice connection error in ${interaction.guildId}: ${error.message}`));
  let recorder, voiceReady = false;
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    voiceReady = true;
    recorder = new Recorder(Math.min(settings.buffer_size_minutes || config.bot.defaultBufferMinutes, settings.max_buffer_minutes || 30), { shouldRecord:userId => isRecordingAllowed(interaction.guildId, userId) });
    recorder.start(connection);
    const state = { connection, recorder, voiceChannelId:voiceChannel.id, voiceChannelName:voiceChannel.name, startedAt:Date.now() };
    active.set(interaction.guildId, state); setRuntime(interaction.guildId, state);
    const mode = consentMode(interaction.guildId);
    const name = botName(interaction.guild);
    const privacyRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('privacy:allow').setLabel('Allow my voice').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('privacy:block').setLabel('Exclude my voice').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setURL(dashboardUrl('/privacy.html')).setLabel('Privacy details').setStyle(ButtonStyle.Link)
    );
    await interaction.channel.send({ content:mode === 'explicit'
      ? `🔴 **${name} is recording a rolling voice buffer in ${voiceChannel}.** Only people who explicitly allow recording are included. Unsaved audio stays in memory and is discarded automatically.`
      : `🔴 **${name} is recording a rolling voice buffer in ${voiceChannel}.** Use the button below at any time to exclude your voice and clear it from the active buffer. Unsaved audio stays in memory and is discarded automatically.`, components:[privacyRow] });
  } catch (error) {
    recorder?.stop(); connection.destroy(); active.delete(interaction.guildId); setRuntime(interaction.guildId, null);
    if (voiceReady) throw new Error(`${botName(interaction.guild)} could not post its privacy notice here. Give the bot permission to view the channel, send messages, and embed links, then try again.`);
    throw new Error(`Could not connect to **${voiceChannel.name}**. Check the bot's Connect, Speak, and voice-encryption permissions, then try again.`);
  }
  return interaction.editReply({ content:`Recording started in **${voiceChannel.name}**.${legacy ? '\n`/record join` is now `/record start`; the old name will remain for one release.' : ''}` });
}

function updatePrivacy(interaction, allowed) {
  setRecordingPreference(interaction.guildId, interaction.user.id, allowed);
  if (!allowed) active.get(interaction.guildId)?.recorder.exclude(interaction.user.id);
  return interaction.reply(ephemeral({ content:allowed
    ? 'Your voice may be included in future clips from this server. You can change this at any time with `/privacy block`.'
    : 'Your voice is excluded from future clips, and any audio currently held for you in the rolling memory buffer was cleared. Existing saved clips are unchanged; use `/privacy remove-past` when you want to update those too.' }));
}

function privacyStatus(interaction) {
  const preference = recordingPreference(interaction.guildId, interaction.user.id);
  const mode = consentMode(interaction.guildId);
  const allowed = isRecordingAllowed(interaction.guildId, interaction.user.id);
  return interaction.reply(ephemeral({ content:`Your voice is currently **${allowed ? 'allowed' : 'excluded'}** in this server.${preference === null ? ` This is the server's ${mode === 'explicit' ? 'explicit opt-in' : 'notice with opt-out'} default.` : ' You set this preference explicitly.'}` }));
}

async function stopRecording(interaction, legacy = false) {
  if (!isBotAdmin(interaction.guild, interaction.member)) throw new Error('Bot admin access is required.');
  const state = active.get(interaction.guildId);
  state?.recorder.stop(); state?.connection.destroy(); active.delete(interaction.guildId); setRuntime(interaction.guildId, null);
  return interaction.reply(ephemeral({ content:`Recording stopped and the temporary buffer was cleared.${legacy ? '\nUse `/record stop` next time.' : ''}` }));
}

async function recordingStatus(interaction) {
  const state = active.get(interaction.guildId);
  if (!state) return interaction.reply(ephemeral({ content:`Recording is offline. ${isBotAdmin(interaction.guild, interaction.member) ? 'Use `/record start` from a voice channel.' : 'Ask a bot admin to start it.'}` }));
  const status = state.recorder.status();
  return interaction.reply(ephemeral({ content:`**Recording ${state.voiceChannelName}**\n${status.users} speaker${status.users === 1 ? '' : 's'} · ${status.totalPackets.toLocaleString()} packets · ${(status.totalBytes / 1048576).toFixed(1)} MiB buffered\nLast audio: ${status.lastPacketAt ? `<t:${Math.floor(status.lastPacketAt / 1000)}:R>` : 'waiting for someone to speak'}` }));
}

async function recentClips(interaction, legacy = false) {
  const rows = db.prepare('SELECT id,title,duration,created_at FROM clips WHERE guild_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 5').all(interaction.guildId);
  if (!rows.length) return interaction.reply(ephemeral({ content:'No clips yet. Use `/clipthat` after recording starts.' }));
  const embed = new EmbedBuilder().setTitle('Recent moments').setColor(0x7c8cff)
    .setDescription(rows.map((clip, index) => `**${index + 1}. ${clip.title}** · ${formatDuration(clip.duration)} · <t:${Math.floor(clip.created_at / 1000)}:R>`).join('\n'));
  const row = new ActionRowBuilder().addComponents(rows.map((clip, index) => new ButtonBuilder().setURL(dashboardUrl(`/clips/${clip.id}`)).setLabel(`Open ${index + 1}`).setStyle(ButtonStyle.Link)));
  return interaction.reply(ephemeral({ content:legacy ? '`/clips list` is now `/clips recent`; the old name will remain for one release.' : undefined, embeds:[embed], components:[row] }));
}

async function openClip(interaction, legacy = false) {
  const id = legacy ? interaction.options.getString('id') : interaction.options.getString('clip');
  const clip = db.prepare('SELECT id,title FROM clips WHERE id=? AND guild_id=? AND deleted_at IS NULL').get(id, interaction.guildId);
  if (!clip) throw new Error('That active clip was not found in this server.');
  return interaction.reply(ephemeral({ content:`[Open **${clip.title}** in ${botName(interaction.guild)}](${dashboardUrl(`/clips/${clip.id}`)})${legacy ? '\n`/clips edit` is now `/clips open`.' : ''}` }));
}

async function showSettings(interaction) {
  if (!isBotAdmin(interaction.guild, interaction.member)) throw new Error('Bot admin access is required.');
  const settings = getServerSettings(interaction.guildId);
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setURL(dashboardUrl(`/servers/${interaction.guildId}/manage`)).setLabel('Open server settings').setStyle(ButtonStyle.Link));
  return interaction.reply(ephemeral({ content:`**Recording settings**\nPlan: ${settings.plan === 'premium' ? 'Premium' : 'Free'}${settings.suspended_at ? ' · recording paused' : ''}\nBuffer: ${settings.buffer_size_minutes} minutes\nRetention: ${settings.retention_days} days\nMaximum clip: ${formatDuration(settings.max_clip_seconds || 1800)}\nVoice privacy: ${settings.consent_mode === 'explicit' ? 'explicit opt-in' : 'visible notice with opt-out'}\nClips channel: ${settings.clips_channel_id ? `<#${settings.clips_channel_id}>` : `#${config.bot.defaultClipsChannel}`}`, components:[row] }));
}

async function playInVoice(interaction) {
  const state = active.get(interaction.guildId);
  if (!state) return interaction.reply(ephemeral({ content:'The bot is not connected to voice.' }));
  const clipId = interaction.customId.split(':')[1];
  const clip = db.prepare('SELECT * FROM clips WHERE id=? AND guild_id=? AND deleted_at IS NULL').get(clipId, interaction.guildId);
  if (!clip) return interaction.reply(ephemeral({ content:'This clip is no longer available.' }));
  const revision = playableRevision(clip);
  if (!revisionReady(clip, revision)) return interaction.reply(ephemeral({ content:'This clip is applying a voice privacy change. Try again shortly.' }));
  await interaction.deferReply(ephemeral());
  const player = createAudioPlayer();
  const subscription = state.connection.subscribe(player);
  let playerCleaned = false;
  const cleanupPlayer = () => { if (playerCleaned) return; playerCleaned = true; subscription?.unsubscribe(); state.connection.rejoin({ selfMute:true }); };
  player.on('error', error => { log(`Voice playback failed for ${clip.id}: ${error.message}`); cleanupPlayer(); });
  state.connection.rejoin({ selfMute:false });
  player.play(createAudioResource(revision.audio_path));
  player.once(AudioPlayerStatus.Idle, cleanupPlayer);
  return interaction.editReply({ content:'Playing the clip in voice.' });
}

async function removeVoice(interaction) {
  const clipId = interaction.customId.split(':')[1];
  const clip = db.prepare('SELECT * FROM clips WHERE id=? AND guild_id=? AND deleted_at IS NULL').get(clipId, interaction.guildId);
  if (!clip) return interaction.reply(ephemeral({ content:'This clip is no longer available.' }));
  const self = participant(clip.id, interaction.user.id);
  if (!self) return interaction.reply(ephemeral({ content:'No saved voice track for you exists in this clip.' }));
  if (!self.included) return interaction.reply(ephemeral({ content:'Your voice is already removed from this clip.' }));
  await interaction.deferReply(ephemeral());
  await interaction.message?.edit({ attachments:[] }).catch(() => {});
  const result = await removeParticipant(clip.id, interaction.user.id);
  await syncClipMessage(clip.id).catch(error => log(`Discord clip sync failed for ${clip.id}: ${error.message}`));
  return interaction.editReply(result.changed
    ? 'Your voice was removed from every playable revision of this clip. The posted audio was replaced. Copies someone already downloaded cannot be recalled. You can make a separate personal cut later without changing this one.'
    : 'Your voice is already removed from this clip.');
}

async function cloneVoice(interaction) {
  const clipId = interaction.customId.split(':')[1];
  const source = db.prepare('SELECT * FROM clips WHERE id=? AND guild_id=? AND deleted_at IS NULL').get(clipId, interaction.guildId);
  if (!source) return interaction.reply(ephemeral({ content:'This clip is no longer available.' }));
  await interaction.deferReply(ephemeral());
  const result = await cloneWithParticipant(clipId, interaction.user.id, interaction.member?.displayName || interaction.user.username);
  if (!result.clip.discord_message_id) await postClipMessage(interaction.channel, { clip_id:result.clip.id });
  return interaction.editReply(`${result.existing ? 'Your existing' : 'Created a'} personal cut: [open **${result.clip.title}**](${dashboardUrl(`/clips/${result.clip.id}`)}). The original clip was not changed.`);
}

async function requestPastRemoval(interaction) {
  const count = affectedClips(interaction.guildId, interaction.user.id, true).length;
  if (!count) return interaction.reply(ephemeral({ content:'Your voice is not included in any active clips in this server.' }));
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`privacy-remove-past:${interaction.user.id}`).setLabel(`Remove me from ${count} clip${count === 1 ? '' : 's'}`).setStyle(ButtonStyle.Danger));
  return interaction.reply(ephemeral({ content:`This removes your voice from **${count} existing clip${count === 1 ? '' : 's'}** and replaces their posted audio. It does not change your future recording preference. Personal cuts can be created later without altering those originals.`, components:[row] }));
}

async function confirmPastRemoval(interaction) {
  const ownerId = interaction.customId.split(':')[1];
  if (ownerId !== interaction.user.id) return interaction.reply(ephemeral({ content:'Only the person who requested this removal can confirm it.' }));
  await interaction.deferUpdate();
  const clips = affectedClips(interaction.guildId, interaction.user.id, true).slice(0, 20);
  let removed = 0;
  for (const clip of clips) {
    if (clip.discord_channel_id && clip.discord_message_id) {
      const channel = await client.channels.fetch(clip.discord_channel_id).catch(() => null);
      const message = await channel?.messages?.fetch(clip.discord_message_id).catch(() => null);
      await message?.edit({ attachments:[] }).catch(() => {});
    }
    await removeParticipant(clip.id, interaction.user.id);
    await syncClipMessage(clip.id).catch(error => log(`Discord clip sync failed for ${clip.id}: ${error.message}`));
    removed += 1;
  }
  const remaining = affectedClips(interaction.guildId, interaction.user.id, true).length;
  return interaction.editReply({ content:`Removed your voice from ${removed} clip${removed === 1 ? '' : 's'}.${remaining ? ` ${remaining} remain; run \`/privacy remove-past\` again to continue.` : ''} Copies already downloaded cannot be recalled.`, components:[] });
}

async function onReady(ready) {
  reconcileGuilds(ready.guilds.cache.values());
  for (const guild of ready.guilds.cache.values()) {
    try { await guild.members.fetchMe(); } catch (error) { log(`Could not refresh the bot nickname for ${guild.id}: ${error.message}`); }
    syncGuild(guild, true);
  }
  log(`Logged in as ${ready.user.tag}`);
  await new REST({ version:'10' }).setToken(config.discord.token).put(Routes.applicationCommands(config.discord.clientId), { body:commands });
}
client.once(Events.ClientReady, ready => { void onReady(ready).catch(error => log(error.stack || error.message)); });
function safeGuildUpdate(operation, guild) {
  try { operation(guild); } catch (error) { log(`Guild state update failed for ${guild?.id || 'unknown'}: ${error.stack || error.message}`); }
}
client.on(Events.GuildCreate, guild => safeGuildUpdate(candidate => syncGuild(candidate, true), guild));
client.on(Events.GuildUpdate, (_, guild) => safeGuildUpdate(candidate => syncGuild(candidate, true), guild));
client.on(Events.GuildDelete, guild => safeGuildUpdate(markGuildRemoved, guild));
client.on(Events.GuildMemberUpdate, (_, member) => { if (member.id === client.user?.id) safeGuildUpdate(candidate => syncGuild(candidate, true), member.guild); });
client.on(Events.Error, error => log(`Discord client error: ${error.stack || error.message}`));

async function handleInteraction(interaction) {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName !== 'clips' || interaction.options.getSubcommand() !== 'open') return interaction.respond([]);
      const query = String(interaction.options.getFocused() || '').slice(0, 80);
      const rows = db.prepare(`SELECT id,title,duration FROM clips WHERE guild_id=? AND deleted_at IS NULL AND (title LIKE ? OR id LIKE ?) ORDER BY created_at DESC LIMIT 25`).all(interaction.guildId, `%${query}%`, `%${query}%`);
      return interaction.respond(rows.map(clip => ({ name:`${clip.title} · ${formatDuration(clip.duration)}`.slice(0, 100), value:clip.id })));
    }
    if (interaction.isButton() && interaction.customId.startsWith('play:')) return playInVoice(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('clip-remove:')) return removeVoice(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('clip-clone:')) return cloneVoice(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('privacy-remove-past:')) return confirmPastRemoval(interaction);
    if (interaction.isButton() && interaction.customId === 'privacy:allow') return updatePrivacy(interaction, true);
    if (interaction.isButton() && interaction.customId === 'privacy:block') return updatePrivacy(interaction, false);
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'record') {
      const command = interaction.options.getSubcommand();
      if (command === 'start' || command === 'join') return startRecording(interaction, command === 'join');
      if (command === 'stop' || command === 'leave') return stopRecording(interaction, command === 'leave');
      return recordingStatus(interaction);
    }
    if (interaction.commandName === 'clipthat' || interaction.commandName === 'clip') {
      const duration = parseDuration(interaction.options.getString('duration'));
      if (!duration) throw new Error('Use a duration such as `30s` or `2m`.');
      await interaction.deferReply(ephemeral());
      const clip = await recordClip({ guild:interaction.guild, guildId:interaction.guildId, user:interaction.user, channel:interaction.channel, duration, title:interaction.options.getString('title') });
      return interaction.editReply(`Created **${clip.title}**. [Open it in ${botName(interaction.guild)}](${dashboardUrl(`/clips/${clip.clip_id}`)})${interaction.commandName === 'clip' ? '\n`/clip` is now `/clipthat`; the old name will remain for one release.' : ''}`);
    }
    if (interaction.commandName === 'clips') {
      const command = interaction.options.getSubcommand();
      if (command === 'recent' || command === 'list') return recentClips(interaction, command === 'list');
      return openClip(interaction, command === 'edit');
    }
    if (interaction.commandName === 'settings') return showSettings(interaction);
    if (interaction.commandName === 'privacy') {
      const command = interaction.options.getSubcommand();
      if (command === 'allow') return updatePrivacy(interaction, true);
      if (command === 'block') return updatePrivacy(interaction, false);
      if (command === 'remove-past') return requestPastRemoval(interaction);
      return privacyStatus(interaction);
    }
}
client.on(Events.InteractionCreate, interaction => { void runInteraction(interaction, handleInteraction, log); });

const heartbeat = setInterval(() => {
  try { for (const [guildId, state] of active) {
    const server = getServerSettings(guildId);
    if (server.suspended_at) { state.recorder.stop(); state.connection.destroy(); active.delete(guildId); setRuntime(guildId, null); continue; }
    setRuntime(guildId, state);
  } }
  catch (error) { log(`Recorder heartbeat failed: ${error.stack || error.message}`); }
}, 10_000);
heartbeat.unref();
const discordSync = setInterval(() => {
  try {
    const pending = db.prepare('SELECT id FROM clips WHERE discord_sync_pending=1 AND discord_message_id IS NOT NULL LIMIT 5').all();
    for (const clip of pending) void syncClipMessage(clip.id).catch(error => log(`Discord clip sync failed for ${clip.id}: ${error.message}`));
  } catch (error) { log(`Discord sync queue failed: ${error.stack || error.message}`); }
}, 5_000);
discordSync.unref();
function shutdown() { for (const [guildId, state] of active) { state.recorder.stop(); state.connection.destroy(); setRuntime(guildId, null); } client.destroy(); }
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);

if (!config.discord.token || !config.discord.clientId || /^(YOUR_|replace)/i.test(String(config.discord.token)) || !/^\d{17,20}$/.test(String(config.discord.clientId))) throw new Error('Set valid Discord credentials in environment variables or config.json.');
void client.login(config.discord.token).catch(error => { log(`Discord login failed: ${error.stack || error.message}`); process.exitCode = 1; });
