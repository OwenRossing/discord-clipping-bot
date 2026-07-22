function platformOwnerIds() {
  return new Set(String(process.env.PLATFORM_OWNER_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(value => /^\d{17,20}$/.test(value)));
}

function isPlatformOwner(userId) {
  return Boolean(userId && platformOwnerIds().has(String(userId)));
}

function requirePlatformOwner(req, res, next) {
  if (!isPlatformOwner(req.user?.userId)) return res.status(403).json({ error:'Platform owner access required.', code:'PLATFORM_OWNER_REQUIRED' });
  next();
}

module.exports = { platformOwnerIds, isPlatformOwner, requirePlatformOwner };
