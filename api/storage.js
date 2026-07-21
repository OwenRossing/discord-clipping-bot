const fs = require('fs');
const path = require('path');
const db = require('./db');
const { loadConfig } = require('../bot/utils');

const config = loadConfig();
const clipsRoot = path.resolve(process.cwd(), config.storage.clipsDir);
const previewRoot = path.resolve(process.cwd(), path.dirname(config.storage.clipsDir), 'previews');

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function directoryBytes(directory) {
  if (!directory || !inside(clipsRoot, directory)) return 0;
  try {
    return fs.readdirSync(directory, { withFileTypes:true }).reduce((total, entry) => {
      const candidate = path.join(directory, entry.name);
      return total + (entry.isDirectory() ? directoryBytes(candidate) : fs.statSync(candidate).size);
    }, 0);
  } catch { return 0; }
}

function guildUsage(guildId) {
  return Number(db.prepare('SELECT COALESCE(SUM(storage_bytes),0) bytes FROM clips WHERE guild_id=?').get(guildId).bytes || 0);
}

function serverQuota(guildId) {
  const row = db.prepare('SELECT storage_quota_bytes FROM servers WHERE guild_id=?').get(guildId);
  return Number(row?.storage_quota_bytes || config.storage.defaultQuotaBytes || 1073741824);
}

function assertQuota(guildId, additionalBytes = 0) {
  const usage = guildUsage(guildId), quota = serverQuota(guildId);
  if (usage + Math.max(0, Number(additionalBytes) || 0) > quota) {
    const error = new Error('This server has reached its Clip Vault storage limit. Delete clips or shorten retention before creating more.');
    error.code = 'STORAGE_QUOTA'; error.status = 507;
    throw error;
  }
  return { usage, quota };
}

function refreshClipStorage(clipId, directory) {
  const bytes = directoryBytes(directory);
  db.prepare('UPDATE clips SET storage_bytes=? WHERE id=?').run(bytes, clipId);
  return bytes;
}

function removeClipDirectory(directory) {
  if (!directory || !inside(clipsRoot, directory) || path.resolve(directory) === clipsRoot) throw new Error('Unsafe clip storage path.');
  fs.rmSync(path.resolve(directory), { recursive:true, force:true });
}

function removePreviewFile(file) {
  if (!file || !inside(previewRoot, file)) throw new Error('Unsafe preview storage path.');
  try { fs.unlinkSync(path.resolve(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

module.exports = { clipsRoot, previewRoot, inside, directoryBytes, guildUsage, serverQuota, assertQuota, refreshClipStorage, removeClipDirectory, removePreviewFile };
