const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const bundledFfmpeg = require('ffmpeg-static');
const db = require('../api/db');
const { assertQuota, refreshClipStorage, removeClipDirectory, clipsRoot, inside } = require('../api/storage');
const { loadConfig } = require('./utils');
const config = loadConfig();
const PROCESS_OPTIONS = { timeout:5 * 60 * 1000, maxBuffer:256 * 1024, windowsHide:true };

function encode(inputs, output, options = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  for (const input of inputs) args.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', input);
  const active = inputs.map((_, i) => `[${i}:a]volume=${options.volumes?.[i] ?? 1}[v${i}]`).join(';');
  const mix = inputs.map((_, i) => `[v${i}]`).join('');
  const trim = options.start !== undefined ? `,atrim=start=${options.start}:end=${options.end},asetpts=PTS-STARTPTS` : '';
  args.push('-filter_complex', `${active};${mix}amix=inputs=${inputs.length}:normalize=0${trim}[a]`, '-map', '[a]', '-c:a', 'libmp3lame', '-q:a', '2', output);
  return new Promise((resolve, reject) => execFile(process.env.FFMPEG_PATH || bundledFfmpeg || 'ffmpeg', args, PROCESS_OPTIONS, error => error ? reject(error) : resolve()));
}
function renderWaveform(audioPath, output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', audioPath, '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1200x180:colors=white', '-frames:v', '1', output];
  return new Promise((resolve, reject) => execFile(process.env.FFMPEG_PATH || bundledFfmpeg || 'ffmpeg', args, { ...PROCESS_OPTIONS, timeout:60_000 }, error => error ? reject(error) : resolve()));
}
function encodeSilence(duration, output) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(Math.max(0.1, Number(duration) || 0.1)), '-c:a', 'libmp3lame', '-q:a', '2', output];
  return new Promise((resolve, reject) => execFile(process.env.FFMPEG_PATH || bundledFfmpeg || 'ffmpeg', args, PROCESS_OPTIONS, error => error ? reject(error) : resolve()));
}
async function createClip({ guildId, createdBy, duration, audio, members = [], title }) {
  if (!audio.size) throw new Error('No audio has been captured in the requested window.');
  const timestamp = Date.now(), id = `${timestamp}`;
  db.prepare('INSERT OR IGNORE INTO servers(guild_id, created_at) VALUES(?, ?)').run(guildId, timestamp);
  const estimatedBytes = [...audio.values()].reduce((total, pcm) => total + pcm.length, 0) + Math.ceil(duration * 32000);
  assertQuota(guildId, estimatedBytes);
  const dir = path.resolve(process.cwd(), config.storage.clipsDir, guildId, id);
  if (!inside(clipsRoot, dir)) throw new Error('Unsafe clip storage path.');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const users = [];
    for (const [userId, pcm] of audio) {
      const track = path.join(dir, `${userId}.pcm`);
      if (!inside(dir, track)) throw new Error('Unsafe speaker storage path.');
      fs.writeFileSync(track, pcm); users.push({ id: userId, name: members.find(m => m.id === userId)?.displayName || userId });
    }
    const cleanTitle = typeof title === 'string' && title.trim() ? Array.from(title.trim()).slice(0, 80).join('') : `Clip ${id}`;
    const metadata = { clip_id: id, title: cleanTitle, guild_id: guildId, timestamp, duration, users_involved: users, created_by: createdBy, original_audio_path: dir, start_trim: 0, end_trim: duration, user_mutes: {}, user_volumes: {} };
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
    const output = path.join(dir, 'original.mp3');
    await encode(users.map(u => path.join(dir, `${u.id}.pcm`)), output);
    const waveform = path.join(dir, 'original.waveform.png');
    try { await renderWaveform(output, waveform); } catch (error) { console.warn(JSON.stringify({ event:'waveform_failed', clipId:id, error:error.message })); }
    const server = db.prepare('SELECT retention_days FROM servers WHERE guild_id=?').get(guildId);
    const expiresAt = timestamp + ((server?.retention_days || config.bot.defaultRetentionDays) * 86400000);
    db.transaction(() => {
      db.prepare(`INSERT INTO clips
        (id, guild_id, timestamp, duration, users_involved, created_by, original_audio_path,
         edited_audio_path, start_trim, end_trim, user_mutes, user_volumes, created_at,
         expires_at, favorited, title)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, '{}', '{}', ?, ?, 0, ?)`)
        .run(id, guildId, timestamp, duration, JSON.stringify(users), createdBy, dir, duration, timestamp, expiresAt, metadata.title);
      const revision = db.prepare(`INSERT INTO clip_revisions
        (clip_id, revision_number, start_trim, end_trim, user_mutes, user_volumes, audio_path, waveform_path, created_by, created_at, participant_version)
        VALUES (?, 0, 0, ?, '{}', '{}', ?, ?, ?, ?, 0)`)
        .run(id, duration, output, fs.existsSync(waveform) ? waveform : null, createdBy, timestamp);
      db.prepare('UPDATE clips SET current_revision_id=? WHERE id=?').run(Number(revision.lastInsertRowid), id);
      const addParticipant = db.prepare(`INSERT INTO clip_participants(clip_id,user_id,display_name,included,removed_at,updated_at)
        VALUES(?,?,?,1,NULL,?)`);
      for (const speaker of users) addParticipant.run(id, speaker.id, speaker.name, timestamp);
    })();
    const storageBytes = refreshClipStorage(id, dir);
    return { ...metadata, audioPath: output, storageBytes };
  } catch (error) {
    db.prepare('DELETE FROM clips WHERE id=?').run(id);
    try { removeClipDirectory(dir); } catch {}
    throw error;
  }
}
module.exports = { createClip, encode, encodeSilence, renderWaveform };
