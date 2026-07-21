const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { loadConfig } = require('../bot/utils');

function columnNames(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

function addColumn(database, table, definition) {
  const name = definition.trim().split(/\s+/)[0];
  if (!columnNames(database, table).has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function createBaseSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      guild_id TEXT PRIMARY KEY,
      clips_channel_id TEXT,
      buffer_size_minutes INTEGER DEFAULT 30,
      retention_days INTEGER DEFAULT 90,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clips (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      duration INTEGER NOT NULL,
      users_involved TEXT NOT NULL,
      created_by TEXT NOT NULL,
      original_audio_path TEXT NOT NULL,
      edited_audio_path TEXT,
      start_trim REAL DEFAULT 0,
      end_trim REAL,
      user_mutes TEXT DEFAULT '{}',
      user_volumes TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      favorited INTEGER DEFAULT 0,
      FOREIGN KEY(guild_id) REFERENCES servers(guild_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS web_sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS server_admins (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(guild_id, user_id),
      FOREIGN KEY(guild_id) REFERENCES servers(guild_id)
    );
    CREATE INDEX IF NOT EXISTS idx_server_admins_user ON server_admins(user_id);
  `);
}

function expandClipSchema(database) {
  addColumn(database, 'clips', 'title TEXT');
  addColumn(database, 'clips', 'current_revision_id INTEGER');
  addColumn(database, 'clips', 'deleted_at INTEGER');
  addColumn(database, 'clips', 'deleted_by TEXT');
  addColumn(database, 'clips', 'purge_at INTEGER');
  addColumn(database, 'clips', 'deletion_reason TEXT');

  database.exec(`
    CREATE TABLE IF NOT EXISTS clip_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clip_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL,
      start_trim REAL NOT NULL,
      end_trim REAL NOT NULL,
      user_mutes TEXT NOT NULL DEFAULT '{}',
      user_volumes TEXT NOT NULL DEFAULT '{}',
      audio_path TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(clip_id, revision_number),
      FOREIGN KEY(clip_id) REFERENCES clips(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS clip_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clip_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clip_previews (
      token TEXT PRIMARY KEY,
      clip_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      audio_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      UNIQUE(clip_id, user_id),
      FOREIGN KEY(clip_id) REFERENCES clips(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_clips_guild_active ON clips(guild_id, deleted_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_clips_purge ON clips(purge_at) WHERE purge_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_revisions_clip ON clip_revisions(clip_id, revision_number DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_clip ON clip_activity(clip_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_previews_expiry ON clip_previews(expires_at);
  `);

  const clips = database.prepare('SELECT * FROM clips').all();
  const insertRevision = database.prepare(`
    INSERT INTO clip_revisions
      (clip_id, revision_number, start_trim, end_trim, user_mutes, user_volumes, audio_path, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findRevision = database.prepare('SELECT id FROM clip_revisions WHERE clip_id=? AND revision_number=?');
  const updateClip = database.prepare('UPDATE clips SET title=?, current_revision_id=? WHERE id=?');

  for (const clip of clips) {
    let original = findRevision.get(clip.id, 0);
    if (!original) {
      const result = insertRevision.run(
        clip.id, 0, 0, Number(clip.duration), '{}', '{}',
        path.join(clip.original_audio_path, 'original.mp3'), clip.created_by, clip.created_at
      );
      original = { id: Number(result.lastInsertRowid) };
    }

    let currentRevisionId = original.id;
    if (clip.edited_audio_path) {
      let edited = findRevision.get(clip.id, 1);
      if (!edited) {
        const result = insertRevision.run(
          clip.id, 1, Number(clip.start_trim || 0), Number(clip.end_trim ?? clip.duration),
          clip.user_mutes || '{}', clip.user_volumes || '{}', clip.edited_audio_path,
          clip.created_by, clip.created_at
        );
        edited = { id: Number(result.lastInsertRowid) };
      }
      currentRevisionId = edited.id;
    }
    updateClip.run(clip.title || `Clip ${clip.id}`, clip.current_revision_id || currentRevisionId, clip.id);
  }
}

function personalizeServerSchema(database) {
  addColumn(database, 'servers', 'name TEXT');
  addColumn(database, 'servers', 'icon_hash TEXT');
  addColumn(database, 'servers', 'owner_id TEXT');
  addColumn(database, 'servers', 'bot_present INTEGER NOT NULL DEFAULT 1');
  addColumn(database, 'servers', 'profile_updated_at INTEGER');
  addColumn(database, 'clip_revisions', 'waveform_path TEXT');
  database.exec(`
    CREATE TABLE IF NOT EXISTS server_runtime (
      guild_id TEXT PRIMARY KEY,
      connected INTEGER NOT NULL DEFAULT 0,
      voice_channel_id TEXT,
      voice_channel_name TEXT,
      recorder_started_at INTEGER,
      speaker_count INTEGER NOT NULL DEFAULT 0,
      last_packet_at INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(guild_id) REFERENCES servers(guild_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_servers_bot_present ON servers(bot_present, name);
  `);
}

function directoryBytes(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes:true }).reduce((total, entry) => {
      const candidate = path.join(directory, entry.name);
      return total + (entry.isDirectory() ? directoryBytes(candidate) : fs.statSync(candidate).size);
    }, 0);
  } catch { return 0; }
}

function publicBetaSchema(database) {
  addColumn(database, 'servers', "consent_mode TEXT NOT NULL DEFAULT 'notice'");
  addColumn(database, 'servers', 'storage_quota_bytes INTEGER NOT NULL DEFAULT 1073741824');
  addColumn(database, 'servers', 'onboarding_completed_at INTEGER');
  addColumn(database, 'clips', 'storage_bytes INTEGER NOT NULL DEFAULT 0');
  database.exec(`
    CREATE TABLE IF NOT EXISTS recording_preferences (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      recording_allowed INTEGER NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(guild_id, user_id),
      FOREIGN KEY(guild_id) REFERENCES servers(guild_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_recording_preferences_user ON recording_preferences(user_id, guild_id);
  `);
  const update = database.prepare('UPDATE clips SET storage_bytes=? WHERE id=? AND storage_bytes=0');
  for (const clip of database.prepare('SELECT id, original_audio_path, storage_bytes FROM clips').all()) {
    if (!clip.storage_bytes) update.run(directoryBytes(clip.original_audio_path), clip.id);
  }
}

const migrations = [createBaseSchema, expandClipSchema, personalizeServerSchema, publicBetaSchema];

function initializeDatabase(database) {
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map(row => row.version));
  migrations.forEach((migration, index) => {
    const version = index + 1;
    if (applied.has(version)) return;
    database.transaction(() => {
      migration(database);
      database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(version, Date.now());
    })();
  });
  database.pragma('journal_mode = WAL');
  return database;
}

const config = loadConfig();
const dbPath = path.resolve(process.cwd(), process.env.DATABASE_PATH || config.storage.databasePath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = initializeDatabase(new Database(dbPath));

if (require.main === module) console.log(`Database initialized at ${dbPath}; schema version ${migrations.length}`);

module.exports = db;
module.exports.initializeDatabase = initializeDatabase;
module.exports.schemaVersion = migrations.length;
