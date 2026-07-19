const session = require('express-session');

class SQLiteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.getStatement = db.prepare('SELECT data FROM web_sessions WHERE sid=? AND expires_at>?');
    this.setStatement = db.prepare('INSERT INTO web_sessions(sid, data, expires_at) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data, expires_at=excluded.expires_at');
    this.destroyStatement = db.prepare('DELETE FROM web_sessions WHERE sid=?');
    this.cleanupStatement = db.prepare('DELETE FROM web_sessions WHERE expires_at<=?');
  }

  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid, Date.now());
      callback(null, row ? JSON.parse(row.data) : null);
    } catch (error) { callback(error); }
  }

  set(sid, value, callback = () => {}) {
    try {
      const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 7 * 86400000;
      this.setStatement.run(sid, JSON.stringify(value), expiresAt);
      callback(null);
    } catch (error) { callback(error); }
  }

  destroy(sid, callback = () => {}) {
    try { this.destroyStatement.run(sid); callback(null); } catch (error) { callback(error); }
  }

  touch(sid, value, callback = () => {}) { this.set(sid, value, callback); }
  cleanup() { this.cleanupStatement.run(Date.now()); }
}

module.exports = SQLiteSessionStore;
