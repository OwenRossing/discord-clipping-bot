const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const db = require('../api/db');
const { loadConfig } = require('./utils');
const config = loadConfig();

function encode(inputs, output, options = {}) {
  const args = [];
  for (const input of inputs) args.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', input);
  const active = inputs.map((_, i) => `[${i}:a]volume=${options.volumes?.[i] ?? 1}[v${i}]`).join('');
  const mix = inputs.map((_, i) => `[v${i}]`).join('');
  const trim = options.start !== undefined ? `,atrim=start=${options.start}:end=${options.end},asetpts=PTS-STARTPTS` : '';
  args.push('-filter_complex', `${active}${mix}amix=inputs=${inputs.length}:normalize=0${trim}[a]`, '-map', '[a]', '-c:a', 'libmp3lame', '-q:a', '4', output);
  return new Promise((resolve, reject) => execFile('ffmpeg', args, error => error ? reject(error) : resolve()));
}
async function createClip({ guildId, createdBy, duration, audio, members = [] }) {
  if (!audio.size) throw new Error('No audio has been captured in the requested window.');
  const timestamp = Date.now(), id = `${timestamp}`;
  const dir = path.resolve(process.cwd(), config.storage.clipsDir, guildId, id);
  fs.mkdirSync(dir, { recursive: true });
  const users = [];
  for (const [userId, pcm] of audio) { fs.writeFileSync(path.join(dir, `${userId}.pcm`), pcm); users.push({ id: userId, name: members.find(m => m.id === userId)?.displayName || userId }); }
  const metadata = { clip_id: id, guild_id: guildId, timestamp, duration, users_involved: users, created_by: createdBy, original_audio_path: dir, start_trim: 0, end_trim: duration, user_mutes: {}, user_volumes: {} };
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  const output = path.join(dir, 'original.mp3');
  await encode(users.map(u => path.join(dir, `${u.id}.pcm`)), output);
  db.prepare('INSERT OR IGNORE INTO servers(guild_id, created_at) VALUES(?, ?)').run(guildId, timestamp);
  const server = db.prepare('SELECT retention_days FROM servers WHERE guild_id=?').get(guildId);
  const expiresAt = timestamp + ((server?.retention_days || config.bot.defaultRetentionDays) * 86400000);
  db.prepare(`INSERT INTO clips VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, '{}', '{}', ?, ?, 0)`).run(id, guildId, timestamp, duration, JSON.stringify(users), createdBy, dir, duration, timestamp, expiresAt);
  return { ...metadata, audioPath: output };
}
module.exports = { createClip, encode };
