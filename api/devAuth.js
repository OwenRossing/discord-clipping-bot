const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;
let challengeHash = null;
let challengeExpiresAt = 0;

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function equalDigest(left, right) {
  return left?.length === right?.length && crypto.timingSafeEqual(left, right);
}

function issueDevelopmentCode(value = crypto.randomBytes(12).toString('base64url'), now = Date.now()) {
  if (process.env.NODE_ENV === 'production') throw new Error('Development login cannot be enabled in production.');
  challengeHash = digest(value);
  challengeExpiresAt = now + TTL_MS;
  return { code:value, expiresAt:challengeExpiresAt };
}

function developmentCodeAvailable(now = Date.now()) {
  return Boolean(challengeHash && challengeExpiresAt > now);
}

function consumeDevelopmentCode(value, now = Date.now()) {
  if (!developmentCodeAvailable(now) || !value) return false;
  const valid = equalDigest(digest(value), challengeHash);
  if (valid) {
    challengeHash = null;
    challengeExpiresAt = 0;
  }
  return valid;
}

function clearDevelopmentCode() {
  challengeHash = null;
  challengeExpiresAt = 0;
}

module.exports = { TTL_MS, issueDevelopmentCode, developmentCodeAvailable, consumeDevelopmentCode, clearDevelopmentCode };
