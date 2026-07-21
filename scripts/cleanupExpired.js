const fs = require('fs');
const path = require('path');
const db = require('../api/db');
const { loadConfig } = require('../bot/utils');

const config = loadConfig();
const clipsRoot = path.resolve(process.cwd(), config.storage.clipsDir);
const previewRoot = path.resolve(process.cwd(), path.dirname(config.storage.clipsDir), 'previews');
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function cleanup(now = Date.now()) {
  const expired = db.prepare(`SELECT * FROM clips
    WHERE deleted_at IS NULL AND favorited=0 AND expires_at<=?`).all(now);
  const trashExpired = db.prepare(`UPDATE clips SET deleted_at=?, deleted_by=NULL, purge_at=?, deletion_reason='retention'
    WHERE id=? AND deleted_at IS NULL`);
  const activity = db.prepare(`INSERT INTO clip_activity(clip_id, guild_id, actor_id, action, details, created_at)
    VALUES(?, ?, NULL, ?, ?, ?)`);
  db.transaction(() => {
    for (const clip of expired) {
      trashExpired.run(now, now + TRASH_TTL_MS, clip.id);
      activity.run(clip.id, clip.guild_id, 'trash', JSON.stringify({ reason: 'retention', purgeAt: now + TRASH_TTL_MS }), now);
    }
  })();

  const previews = db.prepare('SELECT * FROM clip_previews WHERE expires_at<=?').all(now);
  for (const preview of previews) {
    let removed = true;
    if (inside(previewRoot, preview.audio_path)) {
      try { fs.unlinkSync(preview.audio_path); } catch (error) { if (error.code !== 'ENOENT') { removed = false; console.error(JSON.stringify({ event: 'preview_cleanup_failed', token: preview.token, error: error.message })); } }
    }
    if (removed) db.prepare('DELETE FROM clip_previews WHERE token=?').run(preview.token);
  }

  const purged = [];
  const due = db.prepare('SELECT * FROM clips WHERE purge_at IS NOT NULL AND purge_at<=?').all(now);
  for (const clip of due) {
    if (!inside(clipsRoot, clip.original_audio_path)) {
      console.error(JSON.stringify({ event: 'clip_cleanup_blocked', clipId: clip.id, reason: 'unsafe_path' }));
      continue;
    }
    try {
      const clipPreviews = db.prepare('SELECT * FROM clip_previews WHERE clip_id=?').all(clip.id);
      for (const preview of clipPreviews) {
        if (inside(previewRoot, preview.audio_path)) {
          try { fs.unlinkSync(preview.audio_path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      fs.rmSync(clip.original_audio_path, { recursive: true, force: true });
      db.transaction(() => {
        activity.run(clip.id, clip.guild_id, 'permanent_cleanup', JSON.stringify({ reason: clip.deletion_reason }), now);
        db.prepare('DELETE FROM clip_previews WHERE clip_id=?').run(clip.id);
        db.prepare('DELETE FROM clip_revisions WHERE clip_id=?').run(clip.id);
        db.prepare('DELETE FROM clips WHERE id=?').run(clip.id);
      })();
      purged.push(clip.id);
    } catch (error) {
      console.error(JSON.stringify({ event: 'clip_cleanup_failed', clipId: clip.id, error: error.message }));
    }
  }
  const summary = { event: 'cleanup_complete', retentionTrashed: expired.length, previewsRemoved: previews.length, clipsPurged: purged.length };
  console.info(JSON.stringify(summary));
  return summary;
}

if (require.main === module) cleanup();
module.exports = { cleanup, inside };
