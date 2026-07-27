#!/usr/bin/env bash
# Run this ON THE VM, as the `clipthat` user, from /opt/clipthat.
# Usage: ./deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Fetching latest code..."
git pull --ff-only

echo "Installing dependencies..."
npm ci --omit=dev

echo "Applying database migrations..."
npm run init-db

echo "Restarting services..."
sudo systemctl restart clipthat-api.service clipthat-bot.service

echo "Deployed $(git rev-parse --short HEAD) at $(date -u +%FT%TZ)"
sudo systemctl --no-pager status clipthat-api.service clipthat-bot.service
