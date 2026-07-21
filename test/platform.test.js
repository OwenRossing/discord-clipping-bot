const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-vault-test-'));
process.env.DATABASE_PATH = path.join(testRoot, 'runtime.db');
process.env.CLIPS_DIR = path.join(testRoot, 'clips');
process.env.DEV_AUTH_ENABLED = 'true';
process.env.DEV_GUILD_ID = 'guild';
const db = require('../api/db');
const { initializeDatabase, schemaVersion } = db;
const { clipCapabilities } = require('../api/middleware/auth');
const clipsRouter = require('../api/routes/clips');

async function developmentSession(base) {
  const mode = await fetch(`${base}/api/auth/mode`);
  const modeBody = await mode.json();
  const initialCookie = mode.headers.get('set-cookie').split(';')[0];
  const login = await fetch(`${base}/api/auth/dev`, { method:'POST', headers:{ Cookie:initialCookie, Origin:base, 'Content-Type':'application/json', 'X-CSRF-Token':modeBody.csrfToken }, body:'{}' });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  return { cookie:login.headers.get('set-cookie').split(';')[0], csrfToken:loginBody.csrfToken };
}

test.after(() => { db.close(); fs.rmSync(testRoot, { recursive: true, force: true }); });

test('empty database migrates to the latest schema', () => {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const name of ['clips', 'clip_revisions', 'clip_activity', 'clip_previews', 'server_runtime', 'recording_preferences', 'schema_migrations']) assert.ok(tables.has(name));
  assert.equal(db.prepare('SELECT MAX(version) version FROM schema_migrations').get().version, schemaVersion);
  const columns = new Set(db.prepare('PRAGMA table_info(clips)').all().map(row => row.name));
  for (const name of ['title', 'current_revision_id', 'deleted_at', 'deleted_by', 'purge_at', 'deletion_reason', 'storage_bytes']) assert.ok(columns.has(name));
  const serverColumns = new Set(db.prepare('PRAGMA table_info(servers)').all().map(row => row.name));
  for (const name of ['name', 'icon_hash', 'owner_id', 'bot_present', 'profile_updated_at', 'consent_mode', 'storage_quota_bytes', 'onboarding_completed_at']) assert.ok(serverColumns.has(name));
  assert.ok(db.prepare('PRAGMA table_info(clip_revisions)').all().some(row => row.name === 'waveform_path'));
});

test('legacy clips backfill original and edited revisions', () => {
  const legacy = new Database(path.join(testRoot, 'legacy.db'));
  legacy.exec(`CREATE TABLE servers (guild_id TEXT PRIMARY KEY, clips_channel_id TEXT, buffer_size_minutes INTEGER DEFAULT 30, retention_days INTEGER DEFAULT 90, created_at INTEGER NOT NULL);
    CREATE TABLE clips (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, timestamp INTEGER NOT NULL, duration INTEGER NOT NULL, users_involved TEXT NOT NULL, created_by TEXT NOT NULL, original_audio_path TEXT NOT NULL, edited_audio_path TEXT, start_trim REAL DEFAULT 0, end_trim REAL, user_mutes TEXT DEFAULT '{}', user_volumes TEXT DEFAULT '{}', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, favorited INTEGER DEFAULT 0);
    INSERT INTO servers(guild_id, created_at) VALUES('guild', 1);`);
  const insert = legacy.prepare('INSERT INTO clips(id,guild_id,timestamp,duration,users_involved,created_by,original_audio_path,edited_audio_path,start_trim,end_trim,user_mutes,user_volumes,created_at,expires_at,favorited) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  insert.run('original', 'guild', 10, 8, '[]', 'owner', path.join(testRoot, 'original'), null, 0, 8, '{}', '{}', 10, 100, 0);
  insert.run('edited', 'guild', 11, 8, '[]', 'owner', path.join(testRoot, 'edited'), path.join(testRoot, 'edited', 'edited.mp3'), 1, 6, '{}', '{}', 11, 100, 0);
  initializeDatabase(legacy);
  assert.equal(legacy.prepare("SELECT COUNT(*) count FROM clip_revisions WHERE clip_id='original'").get().count, 1);
  assert.equal(legacy.prepare("SELECT COUNT(*) count FROM clip_revisions WHERE clip_id='edited'").get().count, 2);
  const edited = legacy.prepare("SELECT * FROM clips WHERE id='edited'").get();
  assert.equal(edited.title, 'Clip edited');
  assert.equal(legacy.prepare('SELECT revision_number FROM clip_revisions WHERE id=?').get(edited.current_revision_id).revision_number, 1);
  legacy.close();
});

test('capabilities match member, creator, delegated-admin, and trash rules', () => {
  db.prepare('INSERT INTO servers(guild_id, created_at) VALUES(?, ?)').run('guild', Date.now());
  db.prepare('INSERT INTO server_admins(guild_id,user_id,added_by,created_at) VALUES(?,?,?,?)').run('guild', 'admin', 'owner', Date.now());
  const clip = { id:'clip', guild_id:'guild', created_by:'creator', deleted_at:null };
  const request = userId => ({ user:{ userId, guildIds:['guild'], roleAdminGuilds:[], ownerGuilds:[] } });
  assert.deepEqual(clipCapabilities(request('member'), clip), { canPlay:true, canRename:true, canEditAudio:false, canDelete:false, canFavorite:false, canViewRevisions:false, canRollback:false, canRestore:false });
  assert.equal(clipCapabilities(request('creator'), clip).canEditAudio, true);
  assert.equal(clipCapabilities(request('creator'), clip).canDelete, true);
  assert.equal(clipCapabilities(request('admin'), clip).canRollback, true);
  const deleted = { ...clip, deleted_at:Date.now() };
  assert.equal(clipCapabilities(request('member'), deleted).canPlay, false);
  assert.equal(clipCapabilities(request('creator'), deleted).canRestore, false);
  assert.equal(clipCapabilities(request('admin'), deleted).canRestore, true);
});

test('rename validation trims Unicode titles and enforces code-point length', () => {
  assert.equal(clipsRouter.validateTitle('  🎙️ Great moment  '), '🎙️ Great moment');
  assert.throws(() => clipsRouter.validateTitle('   '), /between 1 and 80/);
  assert.throws(() => clipsRouter.validateTitle('🙂'.repeat(81)), /between 1 and 80/);
});

test('edit validation rejects bad trims, volumes, and a fully muted mix', () => {
  const clip = { duration:10, users_involved:JSON.stringify([{ id:'one', name:'One' }, { id:'two', name:'Two' }]) };
  const valid = clipsRouter.validateEdit(clip, { start_trim:1, end_trim:9, user_mutes:{ two:true }, user_volumes:{ one:1.5, two:1 } });
  assert.equal(valid.activeUsers.length, 1);
  assert.throws(() => clipsRouter.validateEdit(clip, { start_trim:9, end_trim:2 }), /Trim/);
  assert.throws(() => clipsRouter.validateEdit(clip, { user_volumes:{ one:3 } }), /between 0.5 and 2/);
  assert.throws(() => clipsRouter.validateEdit(clip, { user_mutes:{ one:true, two:true } }), /remain unmuted/);
});

test('authenticated rename, trash, and admin restore endpoints record activity', async () => {
  const now = Date.now(), clipDir = path.join(testRoot, 'clips', 'guild', 'api-clip');
  fs.mkdirSync(clipDir, { recursive:true });
  db.prepare(`INSERT INTO clips(id,guild_id,timestamp,duration,users_involved,created_by,original_audio_path,start_trim,end_trim,user_mutes,user_volumes,created_at,expires_at,favorited,title)
    VALUES(?,?,?,?,?,?,?,0,?,'{}','{}',?,?,0,?)`).run('api-clip', 'guild', now, 5, '[]', 'creator', clipDir, 5, now, now + 86400000, 'API clip');
  const revision = db.prepare(`INSERT INTO clip_revisions(clip_id,revision_number,start_trim,end_trim,user_mutes,user_volumes,audio_path,created_by,created_at)
    VALUES(?,0,0,?,'{}','{}',?,?,?)`).run('api-clip', 5, path.join(clipDir, 'original.mp3'), 'creator', now);
  db.prepare('UPDATE clips SET current_revision_id=? WHERE id=?').run(Number(revision.lastInsertRowid), 'api-clip');
  const app = require('../api/server');
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const { cookie, csrfToken } = await developmentSession(base);
    const request = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers:{ Cookie:cookie, Origin:base, ...(!['GET','HEAD'].includes(options.method || 'GET') ? { 'X-CSRF-Token':csrfToken } : {}), ...(options.body ? { 'Content-Type':'application/json' } : {}), ...(options.headers || {}) } });
    const rename = await request('/api/clips/api-clip', { method:'PATCH', body:JSON.stringify({ title:'  🎧 Endpoint title  ' }) });
    assert.equal(rename.status, 200); assert.equal((await rename.json()).title, '🎧 Endpoint title');
    const trashed = await request('/api/clips/api-clip', { method:'DELETE', body:JSON.stringify({ reason:'test' }) });
    assert.equal(trashed.status, 202); assert.ok((await trashed.json()).deleted_at);
    const restored = await request('/api/clips/api-clip/restore', { method:'POST' });
    assert.equal(restored.status, 200); assert.equal((await restored.json()).deleted_at, null);
    assert.deepEqual(db.prepare("SELECT action FROM clip_activity WHERE clip_id='api-clip' ORDER BY id").all().map(row => row.action), ['rename', 'trash', 'restore']);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('CSRF, Fetch Metadata, origin checks, cookies, and server profiles are enforced', async () => {
  const app = require('../api/server');
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const mode = await fetch(`${base}/api/auth/mode`), modeBody = await mode.json();
    const initialCookie = mode.headers.get('set-cookie');
    assert.match(initialCookie, /clipvault\.sid=/); assert.match(initialCookie, /HttpOnly/i); assert.match(initialCookie, /SameSite=Lax/i); assert.match(initialCookie, /Path=\//i); assert.doesNotMatch(initialCookie, /;\s*Secure/i);
    const missing = await fetch(`${base}/api/auth/dev`, { method:'POST', headers:{ Cookie:initialCookie.split(';')[0], Origin:base, 'Content-Type':'application/json' }, body:'{}' });
    assert.equal(missing.status, 403);
    const crossSite = await fetch(`${base}/api/auth/dev`, { method:'POST', headers:{ Cookie:initialCookie.split(';')[0], Origin:base, 'Sec-Fetch-Site':'cross-site', 'X-CSRF-Token':modeBody.csrfToken, 'Content-Type':'application/json' }, body:'{}' });
    assert.equal(crossSite.status, 403);
    const { cookie, csrfToken } = await developmentSession(base);
    const hostile = await fetch(`${base}/api/clips/api-clip`, { method:'PATCH', headers:{ Cookie:cookie, Origin:'https://attacker.example', 'X-CSRF-Token':csrfToken, 'Content-Type':'application/json' }, body:JSON.stringify({ title:'Unsafe' }) });
    assert.equal(hostile.status, 403);
    const servers = await fetch(`${base}/api/servers`, { headers:{ Cookie:cookie } });
    assert.equal(servers.status, 200);
    const serverBody = await servers.json();
    assert.ok(serverBody.installed.some(item => item.id === 'guild' && item.name === 'Local Development Server'));
    const overview = await fetch(`${base}/api/servers/guild/overview`, { headers:{ Cookie:cookie } });
    assert.equal(overview.status, 200);
    const overviewBody = await overview.json();
    assert.equal(overviewBody.server.id, 'guild'); assert.equal(typeof overviewBody.runtime.online, 'boolean'); assert.equal(typeof overviewBody.setup.complete, 'boolean');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Discord command registration exposes primary commands and one-release aliases', () => {
  const commands = require('../bot/commands');
  const byName = new Map(commands.map(command => [command.name, command]));
  for (const name of ['record', 'clipthat', 'clip', 'clips', 'settings', 'privacy']) assert.ok(byName.has(name));
  assert.deepEqual(byName.get('record').options.map(option => option.name), ['start', 'stop', 'status', 'join', 'leave']);
  assert.deepEqual(byName.get('clips').options.map(option => option.name), ['recent', 'list', 'open', 'edit']);
  const open = byName.get('clips').options.find(option => option.name === 'open');
  assert.equal(open.options[0].autocomplete, true);
});

test('recorder extraction places contiguous PCM on the sample clock without dropout gaps', () => {
  const Recorder = require('../bot/recorder');
  const recorder = new Recorder(1);
  const realNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const first = Buffer.alloc(3840, 1), second = Buffer.alloc(3840, 2);
    recorder.add('speaker', first, 999_000);
    recorder.add('speaker', second, 999_020);
    const track = recorder.extract(1).get('speaker');
    assert.deepEqual(track.subarray(0, 3840), first);
    assert.deepEqual(track.subarray(3840, 7680), second);
  } finally { Date.now = realNow; }
});

test('recording preferences support notice opt-out and explicit opt-in', () => {
  const { consentMode, isRecordingAllowed, setRecordingPreference } = require('../bot/consent');
  db.prepare("UPDATE servers SET consent_mode='notice' WHERE guild_id='guild'").run();
  assert.equal(consentMode('guild'), 'notice'); assert.equal(isRecordingAllowed('guild', 'listener'), true);
  setRecordingPreference('guild', 'listener', false);
  assert.equal(isRecordingAllowed('guild', 'listener'), false);
  db.prepare("DELETE FROM recording_preferences WHERE guild_id='guild' AND user_id='listener'").run();
  db.prepare("UPDATE servers SET consent_mode='explicit' WHERE guild_id='guild'").run();
  assert.equal(isRecordingAllowed('guild', 'listener'), false);
  setRecordingPreference('guild', 'listener', true);
  assert.equal(isRecordingAllowed('guild', 'listener'), true);
  db.prepare("UPDATE servers SET consent_mode='notice' WHERE guild_id='guild'").run();
});

test('storage quota rejects new clips before audio files are written', async () => {
  const { createClip } = require('../bot/clipManager');
  db.prepare("UPDATE servers SET storage_quota_bytes=1 WHERE guild_id='guild'").run();
  await assert.rejects(createClip({ guildId:'guild', createdBy:'creator', duration:1, audio:new Map([['speaker', Buffer.alloc(100)]]), members:[{ id:'speaker', displayName:'Speaker' }] }), error => error.code === 'STORAGE_QUOTA');
  db.prepare("UPDATE servers SET storage_quota_bytes=1073741824 WHERE guild_id='guild'").run();
});

test('cleanup trashes expired clips, protects favorites, and purges only due trash', () => {
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO clips(id,guild_id,timestamp,duration,users_involved,created_by,original_audio_path,start_trim,end_trim,user_mutes,user_volumes,created_at,expires_at,favorited,title,deleted_at,purge_at,deletion_reason)
    VALUES(?,?,?,?,?,?,?,0,?,'{}','{}',?,?,?,?,?,?,?)`);
  for (const fixture of [
    { id:'retention', favorite:0, deleted:null, purge:null, expires:now-1 },
    { id:'protected', favorite:1, deleted:null, purge:null, expires:now-1 },
    { id:'purge', favorite:0, deleted:now-1000, purge:now-1, expires:now-2000 }
  ]) {
    const directory = path.join(testRoot, 'clips', 'guild', fixture.id);
    fs.mkdirSync(directory, { recursive:true });
    insert.run(fixture.id, 'guild', now, 1, '[]', 'creator', directory, 1, now, fixture.expires, fixture.favorite, fixture.id, fixture.deleted, fixture.purge, fixture.deleted ? 'test' : null);
  }
  const { cleanup } = require('../scripts/cleanupExpired');
  const result = cleanup(now);
  assert.equal(result.retentionTrashed, 1);
  assert.ok(db.prepare("SELECT deleted_at FROM clips WHERE id='retention'").get().deleted_at);
  assert.equal(db.prepare("SELECT deleted_at FROM clips WHERE id='protected'").get().deleted_at, null);
  assert.equal(db.prepare("SELECT 1 FROM clips WHERE id='purge'").get(), undefined);
  assert.equal(fs.existsSync(path.join(testRoot, 'clips', 'guild', 'purge')), false);
});

test('preview is non-persistent and revision saves are immutable with stale-save protection', async () => {
  const { createClip } = require('../bot/clipManager');
  const pcm = Buffer.alloc(48_000 * 2 * 2);
  for (let frame = 0; frame < 48_000; frame += 1) {
    const sample = Math.round(Math.sin(frame / 12) * 12_000);
    pcm.writeInt16LE(sample, frame * 4);
    pcm.writeInt16LE(sample, frame * 4 + 2);
  }
  const created = await createClip({ guildId:'guild', createdBy:'creator', duration:1, audio:new Map([['speaker', pcm]]), members:[{ id:'speaker', displayName:'Speaker' }] });
  const original = db.prepare('SELECT * FROM clips WHERE id=?').get(created.clip_id);
  const app = require('../api/server');
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const { cookie, csrfToken } = await developmentSession(base);
    const post = (suffix, body) => fetch(`${base}/api/clips/${created.clip_id}${suffix}`, { method:'POST', headers:{ Cookie:cookie, Origin:base, 'X-CSRF-Token':csrfToken, 'Content-Type':'application/json' }, body:JSON.stringify(body) });
    const state = { start_trim:0.2, end_trim:0.8, user_mutes:{}, user_volumes:{ speaker:1.4 } };
    const preview = await post('/previews', state);
    assert.equal(preview.status, 201);
    const previewBody = await preview.json();
    assert.match(previewBody.preview_url, /\/previews\/.+\/audio$/);
    assert.equal(db.prepare('SELECT current_revision_id FROM clips WHERE id=?').get(created.clip_id).current_revision_id, original.current_revision_id);
    const save = await post('/revisions', { ...state, base_revision_id:original.current_revision_id });
    assert.equal(save.status, 201);
    const saved = await save.json();
    assert.equal(saved.revision.revision_number, 1);
    const persisted = db.prepare('SELECT * FROM clip_revisions WHERE id=?').get(saved.revision.id);
    assert.ok(fs.existsSync(persisted.audio_path));
    assert.notEqual(persisted.audio_path, path.join(created.original_audio_path, 'original.mp3'));
    const stale = await post('/revisions', { ...state, base_revision_id:original.current_revision_id });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).current_revision.id, saved.revision.id);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('manage settings complete onboarding and the owner can export then erase server data', async () => {
  const app = require('../api/server');
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const { cookie, csrfToken } = await developmentSession(base);
    const headers = { Cookie:cookie, Origin:base, 'X-CSRF-Token':csrfToken, 'Content-Type':'application/json' };
    const settings = await fetch(`${base}/api/settings/guild`, { method:'POST', headers, body:JSON.stringify({ clips_channel_id:'channel', buffer_size_minutes:20, retention_days:45, consent_mode:'explicit', complete_onboarding:true }) });
    assert.equal(settings.status, 200); const settingsBody = await settings.json();
    assert.equal(settingsBody.consent_mode, 'explicit'); assert.ok(settingsBody.onboarding_completed_at);
    const exported = await fetch(`${base}/api/servers/guild/export`, { headers:{ Cookie:cookie } });
    assert.equal(exported.status, 200); assert.match(exported.headers.get('content-disposition'), /attachment/);
    const payload = await exported.json(); assert.equal(payload.server.guild_id, 'guild'); assert.ok(Array.isArray(payload.clips));
    const erased = await fetch(`${base}/api/servers/guild/data`, { method:'DELETE', headers, body:JSON.stringify({ confirmation:'guild' }) });
    assert.equal(erased.status, 202); assert.equal(db.prepare("SELECT COUNT(*) count FROM clips WHERE guild_id='guild'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM server_admins WHERE guild_id='guild'").get().count, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
