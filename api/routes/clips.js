const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db');
const { requireAuth, isPlatformAdmin, hasGuildAccess, clipCapabilities } = require('../middleware/auth');
const { encode, renderWaveform } = require('../../bot/clipManager');
const { loadConfig } = require('../../bot/utils');
const { runAudioJob, checkPreviewRate } = require('../audioJobs');
const { assertQuota, refreshClipStorage } = require('../storage');
const { cloneWithParticipant, participant, participants, removeParticipant, revisionReady } = require('../../bot/participation');

const router = express.Router();
const config = loadConfig();
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const previewRoot = path.resolve(process.cwd(), path.dirname(config.storage.clipsDir), 'previews');

router.use(requireAuth);

function json(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeUnlink(file, root) {
  if (file && inside(root, file)) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function getClip(id) {
  return db.prepare('SELECT * FROM clips WHERE id=?').get(id);
}

function currentRevision(clip) {
  return clip.current_revision_id
    ? db.prepare('SELECT * FROM clip_revisions WHERE id=? AND clip_id=?').get(clip.current_revision_id, clip.id)
    : null;
}

function includedUsers(clipId) {
  return participants(clipId, true).map(row => ({ id:row.user_id, name:row.display_name }));
}

function publicMix(clipId, value) {
  const allowed = new Set(includedUsers(clipId).map(user => user.id));
  return Object.fromEntries(Object.entries(json(value, {})).filter(([userId]) => allowed.has(userId)));
}

function serializeClip(req, clip) {
  const revision = currentRevision(clip);
  const speakers = includedUsers(clip.id);
  const self = participant(clip.id, req.user.userId);
  const revisionMutes = json(revision?.user_mutes, {});
  const active = !clip.deleted_at;
  return {
    id: clip.id,
    guild_id: clip.guild_id,
    title: clip.title,
    timestamp: clip.timestamp,
    duration: clip.duration,
    users_involved: speakers,
    created_by: clip.created_by,
    start_trim: clip.start_trim,
    end_trim: clip.end_trim,
    user_mutes: publicMix(clip.id, clip.user_mutes),
    user_volumes: publicMix(clip.id, clip.user_volumes),
    created_at: clip.created_at,
    expires_at: clip.expires_at,
    favorited: Boolean(clip.favorited),
    current_revision_id: clip.current_revision_id,
    deleted_at: clip.deleted_at,
    deleted_by: clip.deleted_by,
    purge_at: clip.purge_at,
    deletion_reason: clip.deletion_reason,
    storage_bytes: Number(clip.storage_bytes || 0),
    privacy_rendering: Boolean(clip.privacy_rendering),
    source_clip_id: clip.source_clip_id || null,
    my_participation: {
      source_present: Boolean(self),
      included: Boolean(self?.included),
      audible: Boolean(self?.included && !revisionMutes[req.user.userId]),
      can_remove: Boolean(active && self?.included),
      can_clone: Boolean(active && self && (!self.included || revisionMutes[req.user.userId]))
    },
    current_revision: revision ? serializeRevision(clip, revision) : null,
    audio_url: revision ? `/api/clips/${clip.id}/audio?revision=${revision.id}` : `/api/clips/${clip.id}/audio`,
    capabilities: clipCapabilities(req, clip)
  };
}

function serializeRevision(clip, revision) {
  return {
    id: revision.id,
    clip_id: revision.clip_id,
    revision_number: revision.revision_number,
    start_trim: revision.start_trim,
    end_trim: revision.end_trim,
    user_mutes: publicMix(clip.id, revision.user_mutes),
    user_volumes: publicMix(clip.id, revision.user_volumes),
    created_by: revision.created_by,
    created_at: revision.created_at,
    audio_url: `/api/clips/${clip.id}/revisions/${revision.id}/audio`,
    waveform_url: `/api/clips/${clip.id}/revisions/${revision.id}/waveform`
  };
}

function logActivity(clip, actorId, action, details = {}) {
  db.prepare(`INSERT INTO clip_activity(clip_id, guild_id, actor_id, action, details, created_at)
    VALUES(?, ?, ?, ?, ?, ?)`).run(clip.id, clip.guild_id, actorId || null, action, JSON.stringify(details), Date.now());
  console.info(JSON.stringify({ event: `clip_${action}`, clipId: clip.id, guildId: clip.guild_id, actorId: actorId || null }));
}

function memberClip(req, res, options = {}) {
  const clip = getClip(req.params.id);
  if (!clip) {
    res.status(404).json({ error: 'Clip not found.' });
    return null;
  }
  if (!hasGuildAccess(req, clip.guild_id)) {
    res.status(403).json({ error: 'Server access denied.' });
    return null;
  }
  if (clip.deleted_at && (!options.allowDeleted || !isPlatformAdmin(req, clip.guild_id))) {
    res.status(404).json({ error: 'Clip not found.' });
    return null;
  }
  return clip;
}

function requireCapability(req, res, clip, capability, error) {
  if (!clipCapabilities(req, clip)[capability]) {
    console.warn(JSON.stringify({ event: 'authorization_denied', clipId: clip.id, guildId: clip.guild_id, userId: req.user.userId, capability }));
    res.status(403).json({ error });
    return false;
  }
  return true;
}

function validateTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || Array.from(title).length > 80) {
    const error = new Error('Title must be between 1 and 80 characters.');
    error.status = 400;
    throw error;
  }
  return title;
}

function validateEdit(clip, body) {
  const start = Number(body.start_trim ?? 0);
  const end = Number(body.end_trim ?? clip.duration);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > clip.duration || end <= start) {
    const error = new Error(`Trim must be between 0 and ${clip.duration} seconds, with the end after the start.`);
    error.status = 400;
    throw error;
  }
  const savedParticipants = clip.id ? participants(clip.id) : [];
  const knownUsers = savedParticipants.length
    ? savedParticipants.filter(user => user.included).map(user => ({ id:user.user_id, name:user.display_name }))
    : json(clip.users_involved, []);
  const userMutes = body.user_mutes && typeof body.user_mutes === 'object' ? body.user_mutes : {};
  const requestedVolumes = body.user_volumes && typeof body.user_volumes === 'object' ? body.user_volumes : {};
  const userVolumes = {};
  const activeUsers = [];
  for (const user of knownUsers) {
    const volume = Number(requestedVolumes[user.id] ?? 1);
    if (!Number.isFinite(volume) || volume < 0.5 || volume > 2) {
      const error = new Error(`Volume for ${user.name || user.id} must be between 0.5 and 2.`);
      error.status = 400;
      throw error;
    }
    userVolumes[user.id] = volume;
    if (!userMutes[user.id]) activeUsers.push(user);
  }
  if (!activeUsers.length) {
    const error = new Error('At least one speaker must remain unmuted.');
    error.status = 400;
    throw error;
  }
  return { start, end, userMutes: Object.fromEntries(knownUsers.map(user => [user.id, Boolean(userMutes[user.id])])), userVolumes, activeUsers };
}

function render(clip, state, output) {
  if (!inside(clip.original_audio_path, output) && !inside(previewRoot, output)) throw new Error('Unsafe audio output path.');
  const inputs = state.activeUsers.map(user => path.resolve(clip.original_audio_path, `${user.id}.pcm`));
  if (inputs.some(input => !inside(clip.original_audio_path, input))) throw new Error('Unsafe source audio path.');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  return encode(inputs, output, { start: state.start, end: state.end, volumes: state.activeUsers.map(user => state.userVolumes[user.id]) });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

router.get('/', (req, res) => {
  const guildId = String(req.query.guild || '');
  if (!guildId || !hasGuildAccess(req, guildId)) return res.status(403).json({ error: 'Server access denied.' });
  const trash = req.query.trash === '1';
  if (trash && !isPlatformAdmin(req, guildId)) return res.status(403).json({ error: 'Only bot admins can view trash.' });
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const clauses = ['guild_id=?', trash ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
  const params = [guildId];
  if (req.query.q) {
    const query = `%${String(req.query.q).slice(0, 80)}%`;
    clauses.push('(title LIKE ? OR EXISTS (SELECT 1 FROM clip_participants cp WHERE cp.clip_id=clips.id AND cp.included=1 AND cp.display_name LIKE ?))');
    params.push(query, query);
  }
  if (req.query.title) { clauses.push('title LIKE ?'); params.push(`%${String(req.query.title).slice(0, 80)}%`); }
  if (req.query.creator) { clauses.push('created_by=?'); params.push(String(req.query.creator)); }
  if (req.query.speaker) { clauses.push('EXISTS (SELECT 1 FROM clip_participants cp WHERE cp.clip_id=clips.id AND cp.included=1 AND cp.display_name LIKE ?)'); params.push(`%${String(req.query.speaker).slice(0, 80)}%`); }
  if (req.query.favorite === '1') clauses.push('favorited=1');
  if (Number(req.query.after)) { clauses.push('created_at>=?'); params.push(Number(req.query.after)); }
  if (Number(req.query.before)) { clauses.push('created_at<=?'); params.push(Number(req.query.before)); }
  const countClauses = [...clauses], countParams = [...params];
  if (req.query.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(String(req.query.cursor), 'base64url').toString('utf8'));
      if (!Number.isFinite(cursor.createdAt) || !cursor.id) throw new Error('bad cursor');
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(cursor.createdAt, cursor.createdAt, String(cursor.id));
    } catch { return res.status(400).json({ error: 'Invalid pagination cursor.' }); }
  }
  const useOffset = !req.query.cursor && req.query.offset != null;
  const rows = useOffset
    ? db.prepare(`SELECT * FROM clips WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset)
    : db.prepare(`SELECT * FROM clips WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, limit);
  const count = db.prepare(`SELECT COUNT(*) count FROM clips WHERE ${countClauses.join(' AND ')}`).get(...countParams).count;
  const last = rows[rows.length - 1];
  const nextCursor = rows.length === limit && last ? Buffer.from(JSON.stringify({ createdAt:last.created_at, id:last.id })).toString('base64url') : null;
  res.json({ clips: rows.map(clip => serializeClip(req, clip)), count, limit, offset:useOffset ? offset : undefined, next_cursor:nextCursor, trash });
});

router.get('/:id/metadata', (req, res) => {
  const clip = memberClip(req, res, { allowDeleted: true });
  if (clip) res.json(serializeClip(req, clip));
});

router.patch('/:id', (req, res) => {
  const clip = memberClip(req, res);
  if (!clip || !requireCapability(req, res, clip, 'canRename', 'Any active server member can rename this clip.')) return;
  let title;
  try { title = validateTitle(req.body.title); } catch (error) { return res.status(error.status).json({ error: error.message }); }
  const oldTitle = clip.title;
  db.transaction(() => {
    db.prepare('UPDATE clips SET title=? WHERE id=?').run(title, clip.id);
    logActivity(clip, req.user.userId, 'rename', { oldTitle, newTitle: title });
  })();
  res.json(serializeClip(req, getClip(clip.id)));
});

router.get('/:id/audio', (req, res, next) => {
  const clip = memberClip(req, res, { allowDeleted: true });
  if (!clip || !requireCapability(req, res, clip, 'canPlay', 'This clip is unavailable.')) return;
  const revision = currentRevision(clip);
  if (!revisionReady(clip, revision)) return res.status(423).json({ error:'This clip is applying a voice privacy change. Try again shortly.', code:'PRIVACY_RENDERING' });
  const file = revision?.audio_path || clip.edited_audio_path || path.join(clip.original_audio_path, 'original.mp3');
  if (!inside(clip.original_audio_path, file)) return res.status(500).json({ error: 'Audio path failed a safety check.' });
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(path.resolve(file), error => { if (error && !res.headersSent) next(error); });
});

router.get('/:id/preview', (req, res) => res.redirect(307, `/api/clips/${req.params.id}/audio`));

router.post('/:id/previews', asyncRoute(async (req, res) => {
  const clip = memberClip(req, res);
  if (!clip || !requireCapability(req, res, clip, 'canEditAudio', 'Only the clip creator or a bot admin can preview audio edits.')) return;
  checkPreviewRate(req.user.userId);
  const state = validateEdit(clip, req.body);
  const token = crypto.randomUUID();
  const output = path.join(previewRoot, `${token}.mp3`);
  await runAudioJob(clip.id, 'preview', () => render(clip, state, output));
  const now = Date.now();
  const old = db.prepare('SELECT * FROM clip_previews WHERE clip_id=? AND user_id=?').get(clip.id, req.user.userId);
  db.transaction(() => {
    if (old) db.prepare('DELETE FROM clip_previews WHERE token=?').run(old.token);
    db.prepare(`INSERT INTO clip_previews(token, clip_id, user_id, audio_path, created_at, expires_at)
      VALUES(?, ?, ?, ?, ?, ?)`).run(token, clip.id, req.user.userId, output, now, now + PREVIEW_TTL_MS);
  })();
  if (old) safeUnlink(old.audio_path, previewRoot);
  res.status(201).json({ preview_url: `/api/clips/${clip.id}/previews/${token}/audio`, expires_at: now + PREVIEW_TTL_MS });
}));

router.get('/:id/previews/:token/audio', (req, res, next) => {
  const clip = memberClip(req, res);
  if (!clip) return;
  const preview = db.prepare('SELECT * FROM clip_previews WHERE token=? AND clip_id=?').get(req.params.token, clip.id);
  if (!preview || preview.expires_at <= Date.now() || (preview.user_id !== req.user.userId && !isPlatformAdmin(req, clip.guild_id))) return res.status(404).end();
  if (!inside(previewRoot, preview.audio_path)) return res.status(500).json({ error: 'Preview path failed a safety check.' });
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(path.resolve(preview.audio_path), error => { if (error && !res.headersSent) next(error); });
});

async function createRevision(req, res, compatibility = false) {
  const clip = memberClip(req, res);
  if (!clip || !requireCapability(req, res, clip, 'canEditAudio', 'Only the clip creator or a bot admin can save audio edits.')) return;
  const baseRevisionId = compatibility && req.body.base_revision_id == null ? clip.current_revision_id : Number(req.body.base_revision_id);
  if (Number(clip.current_revision_id) !== baseRevisionId) {
    return res.status(409).json({
      error: 'This clip changed after you opened it. Reload the current revision before saving.',
      current_revision: serializeRevision(clip, currentRevision(clip))
    });
  }
  const state = validateEdit(clip, req.body);
  state.participantVersion = Number(clip.participant_version || 0);
  assertQuota(clip.guild_id, Math.ceil((state.end - state.start) * 32000));
  const nextNumber = db.prepare('SELECT COALESCE(MAX(revision_number), -1) + 1 number FROM clip_revisions WHERE clip_id=?').get(clip.id).number;
  const output = path.join(clip.original_audio_path, 'revisions', `revision-${nextNumber}-${crypto.randomUUID()}.mp3`);
  const waveform = output.replace(/\.mp3$/i, '.waveform.png');
  try {
    await runAudioJob(clip.id, 'revision', async () => {
      await render(clip, state, output);
      try { await renderWaveform(output, waveform); } catch (error) { console.warn(JSON.stringify({ event:'waveform_failed', clipId:clip.id, error:error.message })); }
    });
    const revisionId = db.transaction(() => {
      const fresh = getClip(clip.id);
      if (Number(fresh.current_revision_id) !== baseRevisionId || Number(fresh.participant_version || 0) !== state.participantVersion || fresh.privacy_rendering) {
        const conflict = new Error('This clip changed while the revision was rendering. Reload before saving again.');
        conflict.status = 409;
        conflict.code = 'STALE_REVISION';
        throw conflict;
      }
      const result = db.prepare(`INSERT INTO clip_revisions
        (clip_id, revision_number, start_trim, end_trim, user_mutes, user_volumes, audio_path, waveform_path, created_by, created_at, participant_version)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          clip.id, nextNumber, state.start, state.end, JSON.stringify(state.userMutes), JSON.stringify(state.userVolumes), output, fs.existsSync(waveform) ? waveform : null, req.user.userId, Date.now(), state.participantVersion
        );
      const id = Number(result.lastInsertRowid);
      db.prepare(`UPDATE clips SET current_revision_id=?, edited_audio_path=?, start_trim=?, end_trim=?, user_mutes=?, user_volumes=? WHERE id=?`)
        .run(id, output, state.start, state.end, JSON.stringify(state.userMutes), JSON.stringify(state.userVolumes), clip.id);
      logActivity(clip, req.user.userId, 'save', { revisionId: id, revisionNumber: nextNumber, baseRevisionId });
      return id;
    })();
    const revision = db.prepare('SELECT * FROM clip_revisions WHERE id=?').get(revisionId);
    refreshClipStorage(clip.id, clip.original_audio_path);
    res.status(201).json({ revision: serializeRevision(clip, revision), clip: serializeClip(req, getClip(clip.id)) });
  } catch (error) {
    safeUnlink(output, clip.original_audio_path);
    safeUnlink(waveform, clip.original_audio_path);
    if (error.code === 'STALE_REVISION') {
      const fresh = getClip(clip.id);
      return res.status(409).json({ error: error.message, current_revision: serializeRevision(fresh, currentRevision(fresh)) });
    }
    throw error;
  }
}

router.post('/:id/revisions', asyncRoute((req, res) => createRevision(req, res)));
router.post('/:id/edit', asyncRoute((req, res) => createRevision(req, res, true)));

router.get('/:id/revisions', (req, res) => {
  const clip = memberClip(req, res, { allowDeleted: true });
  if (!clip || !requireCapability(req, res, clip, 'canViewRevisions', 'Only bot admins can view revision history.')) return;
  const revisions = db.prepare('SELECT * FROM clip_revisions WHERE clip_id=? ORDER BY revision_number DESC').all(clip.id);
  res.json({ current_revision_id: clip.current_revision_id, revisions: revisions.map(revision => serializeRevision(clip, revision)) });
});

router.get('/:id/revisions/:revisionId/audio', (req, res, next) => {
  const clip = memberClip(req, res, { allowDeleted: true });
  if (!clip || !requireCapability(req, res, clip, 'canViewRevisions', 'Only bot admins can play revision history.')) return;
  const revision = db.prepare('SELECT * FROM clip_revisions WHERE id=? AND clip_id=?').get(Number(req.params.revisionId), clip.id);
  if (!revision || !inside(clip.original_audio_path, revision.audio_path)) return res.status(404).end();
  if (!revisionReady(clip, revision)) return res.status(423).json({ error:'This revision is unavailable while voice privacy is updating.', code:'PRIVACY_RENDERING' });
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(path.resolve(revision.audio_path), error => { if (error && !res.headersSent) next(error); });
});

router.get('/:id/revisions/:revisionId/waveform', asyncRoute(async (req, res, next) => {
  const clip = memberClip(req, res, { allowDeleted: true });
  if (!clip) return;
  const revision = db.prepare('SELECT * FROM clip_revisions WHERE id=? AND clip_id=?').get(Number(req.params.revisionId), clip.id);
  if (!revision) return res.status(404).end();
  if (!revisionReady(clip, revision)) return res.status(423).json({ error:'This waveform is unavailable while voice privacy is updating.', code:'PRIVACY_RENDERING' });
  const capabilities = clipCapabilities(req, clip);
  if (Number(clip.current_revision_id) !== Number(revision.id) && !capabilities.canViewRevisions) return res.status(403).json({ error: 'Revision history is limited to bot admins.' });
  if (!capabilities.canPlay) return res.status(403).json({ error: 'This waveform is unavailable.' });
  let waveformPath = revision.waveform_path;
  if (!waveformPath || !fs.existsSync(waveformPath)) {
    waveformPath = path.join(clip.original_audio_path, 'revisions', `waveform-${revision.id}.png`);
    if (!inside(clip.original_audio_path, waveformPath) || !inside(clip.original_audio_path, revision.audio_path)) return res.status(500).json({ error: 'Waveform path failed a safety check.' });
    await runAudioJob(clip.id, 'waveform', () => renderWaveform(revision.audio_path, waveformPath));
    db.prepare('UPDATE clip_revisions SET waveform_path=? WHERE id=?').run(waveformPath, revision.id);
  }
  if (!inside(clip.original_audio_path, waveformPath)) return res.status(500).json({ error: 'Waveform path failed a safety check.' });
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(path.resolve(waveformPath), error => { if (error && !res.headersSent) next(error); });
}));

router.post('/:id/revisions/:revisionId/restore', (req, res) => {
  const clip = memberClip(req, res);
  if (!clip || !requireCapability(req, res, clip, 'canRollback', 'Only bot admins can restore revisions.')) return;
  const revision = db.prepare('SELECT * FROM clip_revisions WHERE id=? AND clip_id=?').get(Number(req.params.revisionId), clip.id);
  if (!revision) return res.status(404).json({ error: 'Revision not found.' });
  if (!revisionReady(clip, revision)) return res.status(409).json({ error:'That revision predates the latest voice privacy change and cannot be restored yet.', code:'PRIVACY_REVISION_STALE' });
  db.transaction(() => {
    db.prepare(`UPDATE clips SET current_revision_id=?, edited_audio_path=?, start_trim=?, end_trim=?, user_mutes=?, user_volumes=? WHERE id=?`)
      .run(revision.id, revision.audio_path, revision.start_trim, revision.end_trim, revision.user_mutes, revision.user_volumes, clip.id);
    logActivity(clip, req.user.userId, 'rollback', { fromRevisionId: clip.current_revision_id, toRevisionId: revision.id });
  })();
  res.json(serializeClip(req, getClip(clip.id)));
});

router.post('/:id/participants/me/remove', asyncRoute(async (req, res) => {
  const clip = memberClip(req, res);
  if (!clip) return;
  const source = participant(clip.id, req.user.userId);
  if (!source) return res.status(404).json({ error:'No saved voice track for you exists in this clip.' });
  await removeParticipant(clip.id, req.user.userId);
  res.json(serializeClip(req, getClip(clip.id)));
}));

router.post('/:id/participants/me/clone', asyncRoute(async (req, res) => {
  const clip = memberClip(req, res);
  if (!clip) return;
  const result = await cloneWithParticipant(clip.id, req.user.userId, req.user.username || req.user.userId);
  res.status(result.existing ? 200 : 201).json({ existing:result.existing, clip:serializeClip(req, result.clip) });
}));

router.post('/:id/favorite', (req, res) => {
  const clip = memberClip(req, res);
  if (!clip || !requireCapability(req, res, clip, 'canFavorite', 'Only the creator or a bot admin can favorite this clip.')) return;
  const favorited = Boolean(req.body.favorited);
  db.transaction(() => {
    db.prepare('UPDATE clips SET favorited=? WHERE id=?').run(favorited ? 1 : 0, clip.id);
    logActivity(clip, req.user.userId, 'favorite', { favorited });
  })();
  res.json(serializeClip(req, getClip(clip.id)));
});

router.delete('/:id', (req, res) => {
  const clip = memberClip(req, res);
  if (!clip || !requireCapability(req, res, clip, 'canDelete', 'Only the creator or a bot admin can move this clip to trash.')) return;
  const now = Date.now();
  db.transaction(() => {
    db.prepare('UPDATE clips SET deleted_at=?, deleted_by=?, purge_at=?, deletion_reason=? WHERE id=?')
      .run(now, req.user.userId, now + TRASH_TTL_MS, String(req.body?.reason || 'user').slice(0, 200), clip.id);
    logActivity(clip, req.user.userId, 'trash', { purgeAt: now + TRASH_TTL_MS });
  })();
  res.status(202).json(serializeClip(req, getClip(clip.id)));
});

router.post('/:id/restore', (req, res) => {
  const clip = memberClip(req, res, { allowDeleted: true });
  if (!clip || !requireCapability(req, res, clip, 'canRestore', 'Only bot admins can restore trashed clips.')) return;
  const server = db.prepare('SELECT retention_days FROM servers WHERE guild_id=?').get(clip.guild_id);
  const retentionDays = server?.retention_days || config.bot.defaultRetentionDays || 90;
  const expiresAt = clip.expires_at <= Date.now() ? Date.now() + retentionDays * 86400000 : clip.expires_at;
  db.transaction(() => {
    db.prepare('UPDATE clips SET deleted_at=NULL, deleted_by=NULL, purge_at=NULL, deletion_reason=NULL, expires_at=? WHERE id=?').run(expiresAt, clip.id);
    logActivity(clip, req.user.userId, 'restore', { expiresAt });
  })();
  res.json(serializeClip(req, getClip(clip.id)));
});

module.exports = router;
module.exports.validateEdit = validateEdit;
module.exports.validateTitle = validateTitle;
module.exports.serializeClip = serializeClip;
