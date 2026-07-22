const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteSessionStore = require('./sessionStore');
const { loadConfig, log } = require('../bot/utils');
const db = require('./db');
const { csrfProtection } = require('./middleware/security');
const config = loadConfig(), app = express();
if (process.env.NODE_ENV === 'production') {
  const missing = ['clientId','clientSecret','redirectUri'].filter(key => !config.discord[key] || /^(YOUR_|replace)/i.test(String(config.discord[key])));
  if (missing.length) throw new Error(`Missing production Discord configuration: ${missing.join(', ')}.`);
  if (!String(config.api.baseUrl || '').startsWith('https://')) throw new Error('API_BASE_URL must use HTTPS in production.');
  if (config.development.enabled) throw new Error('Development login cannot be enabled in production.');
}
app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production' && String(process.env.SESSION_SECRET || '').length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters in production.');
const trustProxy = String(process.env.TRUST_PROXY || 'false').toLowerCase();
if (trustProxy === 'loopback') app.set('trust proxy', 'loopback');
else if (trustProxy !== 'false') throw new Error('TRUST_PROXY must be either false or loopback.');
const sessionStore = new SQLiteSessionStore(db);
sessionStore.cleanup();
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  const originalJson = res.json.bind(res);
  res.json = body => originalJson(body && typeof body === 'object' && body.error && !body.requestId ? { ...body, requestId:req.id } : body);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://cdn.discordapp.com; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '128kb', strict: true }));
app.use(session({ store: sessionStore, name: process.env.NODE_ENV === 'production' ? '__Host-clipthat.sid' : 'clipthat.sid', secret: process.env.SESSION_SECRET || 'development-only-secret', resave: false, saveUninitialized: false, cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax', path: '/', maxAge: 7 * 86400000 } }));
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error:'State-changing API requests must use application/json.', code:'JSON_REQUIRED' });
  next();
});
app.use('/api', csrfProtection);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/clips', require('./routes/clips'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/admins', require('./routes/admins'));
app.use('/api/discord', require('./routes/discord'));
app.use('/api/servers', require('./routes/servers'));
app.use('/api/platform', require('./routes/platform'));
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok:true });
  } catch (error) { res.status(503).json({ ok:false }); }
});
app.get('/editor.html', (req, res) => res.redirect(302, req.query.clip_id ? `/clips/${encodeURIComponent(req.query.clip_id)}` : '/'));
app.get('/admin.html', (req, res) => res.redirect(302, req.query.guild ? `/servers/${encodeURIComponent(req.query.guild)}/manage` : '/'));
app.use(express.static(path.resolve(process.cwd(), 'web')));
app.get(['/servers/:guildId/:view', '/clips/:clipId', '/platform'], (req, res) => res.sendFile(path.resolve(process.cwd(), 'web', 'index.html')));
app.use((error, req, res, next) => {
  log(error.stack || error.message);
  const status = Number(error.status) || (error.type === 'entity.too.large' ? 413 : 500);
  res.status(status).json({ error: status >= 500 ? 'Internal server error.' : error.message, code: error.code });
});
function startServer(runtimeConfig = config) {
  const cleanupTimer = setInterval(() => sessionStore.cleanup(), 60 * 60 * 1000);
  cleanupTimer.unref();
  const server = app.listen(runtimeConfig.api.port, runtimeConfig.api.host || '127.0.0.1', () => log(`Dashboard and API listening at ${runtimeConfig.api.baseUrl}`));
  const shutdown = signal => { log(`${signal} received; closing the API.`); server.close(error => { if (error) { log(error.message); process.exitCode = 1; } }); };
  process.once('SIGINT', () => shutdown('SIGINT')); process.once('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}
if (require.main === module) startServer();
module.exports = app;
module.exports.startServer = startServer;
