#!/usr/bin/env bash
# Sanity-checks a ClipThat production deployment end to end.
# Run this ON THE VM, from the repo root or from deploy/: ./deploy/verify.sh
set -uo pipefail
cd "$(dirname "$0")/.."

PASS="\033[32m\xE2\x9C\x93\033[0m"
FAIL="\033[31m\xE2\x9C\x97\033[0m"
WARN="\033[33m!\033[0m"
fails=0
warns=0

ok()   { echo -e " $PASS $1"; }
bad()  { echo -e " $FAIL $1"; fails=$((fails+1)); }
meh()  { echo -e " $WARN $1"; warns=$((warns+1)); }

ENV_FILE=".env"
get_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }

echo "== Node & repo =="
if command -v node >/dev/null 2>&1; then
  NODE_VERSION=$(node -v)
  MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
  if [ "$MAJOR" -ge 20 ] 2>/dev/null; then ok "Node $NODE_VERSION"; else bad "Node $NODE_VERSION (need 20+)"; fi
else
  bad "node not found on PATH"
fi
if [ -d .git ]; then ok "git repo present ($(git rev-parse --short HEAD 2>/dev/null))"; else bad "not a git checkout"; fi

echo
echo "== .env =="
if [ ! -f "$ENV_FILE" ]; then
  bad ".env not found at $(pwd)/.env"
else
  ok ".env exists"
  [ "$(get_env NODE_ENV)" = "production" ] && ok "NODE_ENV=production" || bad "NODE_ENV is not 'production'"

  SECRET=$(get_env SESSION_SECRET)
  if [ -z "$SECRET" ] || [ "$SECRET" = "replace-with-at-least-32-random-bytes" ]; then bad "SESSION_SECRET is empty or still the placeholder"
  elif [ ${#SECRET} -lt 32 ]; then meh "SESSION_SECRET is shorter than 32 characters"
  else ok "SESSION_SECRET looks real"; fi

  for key in DISCORD_TOKEN DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET; do
    [ -n "$(get_env "$key")" ] && ok "$key is set" || bad "$key is empty"
  done

  WEB_BASE=$(get_env WEB_BASE_URL)
  API_BASE=$(get_env API_BASE_URL)
  REDIRECT=$(get_env DISCORD_REDIRECT_URI)
  case "$WEB_BASE" in https://*) ok "WEB_BASE_URL is https ($WEB_BASE)";; *) bad "WEB_BASE_URL is not https:// ($WEB_BASE)";; esac
  case "$API_BASE" in https://*) ok "API_BASE_URL is https ($API_BASE)";; *) bad "API_BASE_URL is not https:// ($API_BASE)";; esac
  case "$REDIRECT" in "$WEB_BASE"*) ok "DISCORD_REDIRECT_URI matches WEB_BASE_URL";; *) meh "DISCORD_REDIRECT_URI ($REDIRECT) doesn't start with WEB_BASE_URL ($WEB_BASE) — confirm it matches the Discord Developer Portal exactly";; esac

  [ "$(get_env TRUST_PROXY)" = "loopback" ] && ok "TRUST_PROXY=loopback" || meh "TRUST_PROXY is '$(get_env TRUST_PROXY)', expected 'loopback' behind Cloudflare Tunnel"
  [ -n "$(get_env PLATFORM_OWNER_IDS)" ] && ok "PLATFORM_OWNER_IDS is set" || meh "PLATFORM_OWNER_IDS is empty — Platform controls will be hidden for everyone"
fi

echo
echo "== Data directories =="
[ -d data/clips ] && ok "data/clips exists" || bad "data/clips missing"
[ -w data ] && ok "data/ is writable by $(whoami)" || meh "data/ may not be writable by $(whoami) — check as the clipthat user"
[ -f data/bot.db ] && ok "database file exists" || meh "data/bot.db not found yet — run npm run init-db"

echo
echo "== systemd services =="
for svc in clipthat-api clipthat-bot cloudflared; do
  systemctl is-active --quiet "$svc" 2>/dev/null && ok "$svc is running" || bad "$svc is NOT running (check: systemctl status $svc)"
  systemctl is-enabled --quiet "$svc" 2>/dev/null && ok "$svc is enabled at boot" || meh "$svc is not enabled at boot"
done
for timer in clipthat-cleanup.timer clipthat-backup.timer; do
  systemctl is-active --quiet "$timer" 2>/dev/null && ok "$timer is active" || bad "$timer is NOT active"
done

echo
echo "== Local API health =="
if command -v curl >/dev/null 2>&1; then
  LOCAL=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/health --max-time 5)
  [ "$LOCAL" = "200" ] && ok "http://127.0.0.1:3000/api/health -> 200" || bad "local health check returned $LOCAL (expected 200)"
else
  meh "curl not installed, skipping health checks"
fi

echo
echo "== Public HTTPS + tunnel =="
if [ -n "${API_BASE:-}" ] && command -v curl >/dev/null 2>&1; then
  PUBLIC=$(curl -s -o /dev/null -w "%{http_code}" "$API_BASE/api/health" --max-time 8)
  [ "$PUBLIC" = "200" ] && ok "$API_BASE/api/health -> 200 (tunnel + DNS + TLS all working)" || bad "$API_BASE/api/health returned $PUBLIC — check cloudflared status and DNS"
fi

echo
echo "== Dev login must be dead in production =="
if [ -n "${API_BASE:-}" ] && command -v curl >/dev/null 2>&1; then
  DEVCODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_BASE/api/auth/dev" -H "Content-Type: application/json" -d '{"code":"probe"}' --max-time 8)
  # 403 happens when the CSRF/origin middleware (api/middleware/security.js) blocks the
  # cross-origin probe before it reaches the route's own NODE_ENV production check, which
  # would otherwise return 404. Either status means the endpoint is unreachable in production.
  case "$DEVCODE" in
    404) ok "dev login endpoint correctly disabled (404)" ;;
    403) ok "dev login endpoint blocked by CSRF/origin check (403)" ;;
    *) bad "dev login endpoint returned $DEVCODE — expected 404 or 403 in production, this is a real security gap" ;;
  esac
fi

echo
echo "======================================"
if [ "$fails" -eq 0 ] && [ "$warns" -eq 0 ]; then echo "All checks passed."
elif [ "$fails" -eq 0 ]; then echo "$warns warning(s), no failures."
else echo "$fails failure(s), $warns warning(s) — fix the ✗ items above."; fi
[ "$fails" -eq 0 ]
