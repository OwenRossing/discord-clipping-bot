const crypto = require('crypto');
const { loadConfig } = require('../../bot/utils');

const config = loadConfig();
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  return req.session.csrfToken;
}

function equalToken(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requestOrigin(req) {
  const origin = req.get('Origin');
  if (origin) return origin;
  const referer = req.get('Referer');
  if (!referer) return null;
  try { return new URL(referer).origin; } catch { return null; }
}

function allowedOrigins(req) {
  const values = new Set();
  try { values.add(new URL(config.api.baseUrl).origin); } catch {}
  if (process.env.NODE_ENV !== 'production') {
    try {
      const local = new URL(`http://${req.get('Host') || ''}`);
      if (['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)) values.add(local.origin);
    } catch {}
  }
  return values;
}

function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.get('Sec-Fetch-Site') === 'cross-site') return res.status(403).json({ error: 'Cross-site request blocked.', code: 'CROSS_SITE_REQUEST' });
  const origin = requestOrigin(req);
  if (!origin || !allowedOrigins(req).has(origin)) return res.status(403).json({ error: 'Request origin could not be verified.', code: 'ORIGIN_MISMATCH' });
  if (!equalToken(req.get('X-CSRF-Token'), req.session?.csrfToken)) return res.status(403).json({ error: 'Security token is missing or expired. Refresh the page and try again.', code: 'CSRF_INVALID' });
  next();
}

module.exports = { ensureCsrfToken, csrfProtection };
