const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const db = require('../api/db');
const { runAudioJob } = require('../api/audioJobs');
const { assertQuota, refreshClipStorage, removeClipDirectory, clipsRoot, inside } = require('../api/storage');
const { encode, encodeSilence, renderWaveform } = require('./clipManager');
const { loadConfig } = require('./utils');

const config = loadConfig();
const PCM_BYTES_PER_SECOND = 48000 * 2 * 2;

function json(value, fallback = {}) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function getClip(clipId) { return db.prepare('SELECT * FROM clips WHERE id=?').get(clipId); }
function currentRevision(clip) { return clip?.current_revision_id ? db.prepare('SELECT * FROM clip_revisions WHERE id=? AND clip_id=?').get(clip.current_revision_id, clip.id) : null; }
function participant(clipId, userId) { return db.prepare('SELECT * FROM clip_participants WHERE clip_id=? AND user_id=?').get(clipId, userId); }
function participants(clipId, includedOnly = false) { return db.prepare(`SELECT * FROM clip_participants WHERE clip_id=?${includedOnly ? ' AND included=1' : ''} ORDER BY display_name,user_id`).all(clipId); }
function revisionReady(clip, revision) { return Boolean(revision && !clip.privacy_rendering && Number(revision.participant_version || 0) === Number(clip.participant_version || 0)); }
function safeDelete(file, root) {
  if (!file || !inside(clipsRoot, root) || !inside(root, file)) return;
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function pcmSliceBytes(file, startByte, endByte) {
  return Math.max(0, Math.min(fs.statSync(file).size, endByte) - startByte);
}

async function copyPcmSlice(source, destination, startByte, endByte) {
  const bytes = pcmSliceBytes(source, startByte, endByte);
  if (!bytes) return fs.writeFileSync(destination, Buffer.alloc(0));
  await pipeline(fs.createReadStream(source, { start:startByte, end:startByte + bytes - 1 }), fs.createWriteStream(destination, { flags:'wx' }));
}

async function renderRevision(clip, revision, included, participantVersion) {
  if (!inside(clipsRoot, clip.original_audio_path)) throw new Error('Unsafe clip storage path.');
  const mutes = json(revision.user_mutes, {}), volumes = json(revision.user_volumes, {});
  const active = included.filter(user => !mutes[user.user_id] && fs.existsSync(path.join(clip.original_audio_path, `${user.user_id}.pcm`)));
  const directory = path.join(clip.original_audio_path, 'revisions');
  fs.mkdirSync(directory, { recursive:true });
  const audioPath = path.join(directory, `privacy-${revision.id}-v${participantVersion}-${crypto.randomUUID()}.mp3`);
  const waveformPath = audioPath.replace(/\.mp3$/i, '.waveform.png');
  if (active.length) {
    await encode(active.map(user => path.join(clip.original_audio_path, `${user.user_id}.pcm`)), audioPath, {
      start:Number(revision.start_trim), end:Number(revision.end_trim), volumes:active.map(user => Number(volumes[user.user_id] ?? 1))
    });
  } else {
    await encodeSilence(Number(revision.end_trim) - Number(revision.start_trim), audioPath);
  }
  try { await renderWaveform(audioPath, waveformPath); } catch (error) { console.warn(JSON.stringify({ event:'privacy_waveform_failed', clipId:clip.id, revisionId:revision.id, error:error.message })); }
  return { revision, audioPath, waveformPath:fs.existsSync(waveformPath) ? waveformPath : null };
}

async function rerenderParticipation(clipId, participantVersion) {
  const clip = getClip(clipId);
  if (!clip || Number(clip.participant_version) !== Number(participantVersion)) throw Object.assign(new Error('This clip participation changed again. Retry the action.'), { code:'PARTICIPATION_STALE', status:409 });
  const revisions = db.prepare('SELECT * FROM clip_revisions WHERE clip_id=? ORDER BY revision_number').all(clipId);
  const included = participants(clipId, true);
  const rendered = [];
  try {
    await runAudioJob(clipId, 'privacy', async () => { for (const revision of revisions) rendered.push(await renderRevision(clip, revision, included, participantVersion)); });
    db.transaction(() => {
      const fresh = getClip(clipId);
      if (Number(fresh.participant_version) !== Number(participantVersion)) throw Object.assign(new Error('This clip participation changed again.'), { code:'PARTICIPATION_STALE', status:409 });
      const update = db.prepare('UPDATE clip_revisions SET audio_path=?,waveform_path=?,participant_version=? WHERE id=?');
      for (const item of rendered) update.run(item.audioPath, item.waveformPath, participantVersion, item.revision.id);
      const current = rendered.find(item => Number(item.revision.id) === Number(fresh.current_revision_id));
      db.prepare('UPDATE clips SET edited_audio_path=?,privacy_rendering=0,discord_sync_pending=1 WHERE id=?').run(current?.audioPath || null, clipId);
    })();
    for (const item of rendered) {
      safeDelete(item.revision.audio_path, clip.original_audio_path);
      safeDelete(item.revision.waveform_path, clip.original_audio_path);
    }
    refreshClipStorage(clipId, clip.original_audio_path);
    return getClip(clipId);
  } catch (error) {
    for (const item of rendered) { safeDelete(item.audioPath, clip.original_audio_path); safeDelete(item.waveformPath, clip.original_audio_path); }
    throw error;
  }
}

async function removeParticipant(clipId, userId) {
  const clip = getClip(clipId), source = participant(clipId, userId);
  if (!clip) throw Object.assign(new Error('Clip not found.'), { status:404 });
  if (!source) throw Object.assign(new Error('No saved voice track for you exists in this clip.'), { status:404, code:'NO_SOURCE_TRACK' });
  if (!source.included) {
    if (clip.privacy_rendering) return { clip:await rerenderParticipation(clipId, clip.participant_version), participant:source, changed:false, recovered:true };
    return { clip, participant:source, changed:false };
  }
  const now = Date.now();
  const version = db.transaction(() => {
    db.prepare('UPDATE clip_participants SET included=0,removed_at=?,updated_at=? WHERE clip_id=? AND user_id=?').run(now, now, clipId, userId);
    db.prepare('UPDATE clips SET participant_version=participant_version+1,privacy_rendering=1,discord_sync_pending=1 WHERE id=?').run(clipId);
    const next = getClip(clipId).participant_version;
    db.prepare(`INSERT INTO clip_activity(clip_id,guild_id,actor_id,action,details,created_at) VALUES(?,?,?,?,?,?)`)
      .run(clipId, clip.guild_id, userId, 'participant_remove', JSON.stringify({ participantVersion:next }), now);
    return next;
  })();
  console.info(JSON.stringify({ event:'clip_participant_remove', clipId, guildId:clip.guild_id, userId, participantVersion:version }));
  return { clip:await rerenderParticipation(clipId, version), participant:participant(clipId, userId), changed:true };
}

function personalCutTitle(title, name) {
  return Array.from(`${title} — ${name}'s cut`).slice(0, 80).join('');
}

async function cloneWithParticipant(clipId, userId, displayName) {
  const sourceClip = getClip(clipId), sourceParticipant = participant(clipId, userId);
  if (!sourceClip || sourceClip.deleted_at) throw Object.assign(new Error('That active clip is unavailable.'), { status:404 });
  if (!inside(clipsRoot, sourceClip.original_audio_path)) throw Object.assign(new Error('The source clip failed a storage safety check.'), { status:500, code:'UNSAFE_STORAGE_PATH' });
  if (!sourceParticipant || !fs.existsSync(path.join(sourceClip.original_audio_path, `${userId}.pcm`))) throw Object.assign(new Error('No saved voice track for you exists in this clip.'), { status:404, code:'NO_SOURCE_TRACK' });
  const sourceRevision = currentRevision(sourceClip);
  if (!revisionReady(sourceClip, sourceRevision)) throw Object.assign(new Error('This clip is still applying a privacy change. Try again shortly.'), { status:423, code:'PRIVACY_RENDERING' });
  const sourceMutes = json(sourceRevision.user_mutes, {});
  if (sourceParticipant.included && !sourceMutes[userId]) throw Object.assign(new Error('Your voice is already included in this cut.'), { status:409, code:'ALREADY_INCLUDED' });
  const existing = db.prepare('SELECT * FROM clips WHERE source_clip_id=? AND participant_clone_user_id=? AND deleted_at IS NULL').get(clipId, userId);
  if (existing) return { clip:existing, existing:true };

  const eligible = participants(clipId, true);
  if (!eligible.some(user => user.user_id === userId)) eligible.push(sourceParticipant);
  const available = eligible.filter(user => fs.existsSync(path.join(sourceClip.original_audio_path, `${user.user_id}.pcm`)));
  const start = Number(sourceRevision.start_trim), end = Number(sourceRevision.end_trim), duration = end - start;
  const beginByte = Math.max(0, Math.floor(start * PCM_BYTES_PER_SECOND / 4) * 4);
  const endByte = Math.max(beginByte + 4, Math.floor(end * PCM_BYTES_PER_SECOND / 4) * 4);
  const sourceFiles = new Map(available.map(user => {
    const file = path.join(sourceClip.original_audio_path, `${user.user_id}.pcm`);
    if (!inside(sourceClip.original_audio_path, file)) throw Object.assign(new Error('A source track failed a storage safety check.'), { status:500, code:'UNSAFE_STORAGE_PATH' });
    return [user.user_id, file];
  }));
  assertQuota(sourceClip.guild_id, [...sourceFiles.values()].reduce((sum, file) => sum + pcmSliceBytes(file, beginByte, endByte), 0) + Math.ceil(duration * 32000));

  const timestamp = Date.now(), id = `${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
  const directory = path.resolve(process.cwd(), config.storage.clipsDir, sourceClip.guild_id, id);
  if (!inside(clipsRoot, directory)) throw Object.assign(new Error('The destination failed a storage safety check.'), { status:500, code:'UNSAFE_STORAGE_PATH' });
  const users = available.map(user => ({ id:user.user_id, name:user.display_name }));
  const mutes = Object.fromEntries(users.map(user => [user.id, user.id === userId ? false : Boolean(sourceMutes[user.id])]));
  const sourceVolumes = json(sourceRevision.user_volumes, {});
  const volumes = Object.fromEntries(users.map(user => [user.id, Number(sourceVolumes[user.id] ?? 1)]));
  const title = personalCutTitle(sourceClip.title, displayName || sourceParticipant.display_name);
  try {
    fs.mkdirSync(directory, { recursive:true });
    for (const [participantId, source] of sourceFiles) {
      const destination = path.join(directory, `${participantId}.pcm`);
      if (!inside(directory, destination)) throw new Error('Unsafe destination track path.');
      await copyPcmSlice(source, destination, beginByte, endByte);
    }
    const output = path.join(directory, 'original.mp3');
    const active = users.filter(user => !mutes[user.id]);
    const waveform = path.join(directory, 'original.waveform.png');
    await runAudioJob(clipId, 'participant_clone', async () => {
      await encode(active.map(user => path.join(directory, `${user.id}.pcm`)), output, { volumes:active.map(user => volumes[user.id]) });
      try { await renderWaveform(output, waveform); } catch (error) { console.warn(JSON.stringify({ event:'waveform_failed', clipId:id, error:error.message })); }
    });
    const retention = db.prepare('SELECT retention_days FROM servers WHERE guild_id=?').get(sourceClip.guild_id)?.retention_days || config.bot.defaultRetentionDays || 90;
    const expiresAt = timestamp + retention * 86400000;
    db.transaction(() => {
      db.prepare(`INSERT INTO clips(id,guild_id,timestamp,duration,users_involved,created_by,original_audio_path,edited_audio_path,start_trim,end_trim,user_mutes,user_volumes,created_at,expires_at,favorited,title,source_clip_id,participant_clone_user_id)
        VALUES(?,?,?,?,?,?,?,NULL,0,?,?,?,?,?,0,?,?,?)`).run(id, sourceClip.guild_id, timestamp, duration, JSON.stringify(users), userId, directory, duration, JSON.stringify(mutes), JSON.stringify(volumes), timestamp, expiresAt, title, clipId, userId);
      const revision = db.prepare(`INSERT INTO clip_revisions(clip_id,revision_number,start_trim,end_trim,user_mutes,user_volumes,audio_path,waveform_path,created_by,created_at,participant_version)
        VALUES(?,0,0,?,?,?,?,?,?,?,0)`).run(id, duration, JSON.stringify(mutes), JSON.stringify(volumes), output, fs.existsSync(waveform) ? waveform : null, userId, timestamp);
      db.prepare('UPDATE clips SET current_revision_id=? WHERE id=?').run(Number(revision.lastInsertRowid), id);
      const add = db.prepare('INSERT INTO clip_participants(clip_id,user_id,display_name,included,removed_at,updated_at) VALUES(?,?,?,1,NULL,?)');
      for (const user of users) add.run(id, user.id, user.name, timestamp);
      db.prepare(`INSERT INTO clip_activity(clip_id,guild_id,actor_id,action,details,created_at) VALUES(?,?,?,?,?,?)`).run(id, sourceClip.guild_id, userId, 'participant_clone', JSON.stringify({ sourceClipId:clipId }), timestamp);
    })();
    fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify({ clip_id:id, guild_id:sourceClip.guild_id, title, duration, users_involved:users, created_by:userId, source_clip_id:clipId }, null, 2));
    const storageBytes = refreshClipStorage(id, directory);
    console.info(JSON.stringify({ event:'clip_participant_clone', clipId:id, sourceClipId:clipId, guildId:sourceClip.guild_id, userId }));
    return { clip:getClip(id), audioPath:output, users, storageBytes, existing:false };
  } catch (error) {
    db.prepare('DELETE FROM clips WHERE id=?').run(id);
    try { removeClipDirectory(directory); } catch {}
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const found = db.prepare('SELECT * FROM clips WHERE source_clip_id=? AND participant_clone_user_id=? AND deleted_at IS NULL').get(clipId, userId);
      if (found) return { clip:found, existing:true };
    }
    throw error;
  }
}

function affectedClips(guildId, userId, included = true) {
  return db.prepare(`SELECT c.* FROM clips c JOIN clip_participants p ON p.clip_id=c.id
    WHERE c.guild_id=? AND p.user_id=? AND p.included=? ORDER BY c.created_at DESC`).all(guildId, userId, included ? 1 : 0);
}

module.exports = { affectedClips, cloneWithParticipant, currentRevision, participant, participants, removeParticipant, rerenderParticipation, revisionReady };
