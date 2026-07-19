const fs = require('fs');
const db = require('../api/db');
const expired = db.prepare('SELECT id, original_audio_path FROM clips WHERE expires_at < ? AND favorited = 0').all(Date.now());
const remove = db.prepare('DELETE FROM clips WHERE id=?');
for (const clip of expired) { fs.rmSync(clip.original_audio_path, { recursive: true, force: true }); remove.run(clip.id); }
console.log(`Removed ${expired.length} expired clips.`);
