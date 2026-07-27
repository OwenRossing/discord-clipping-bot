#!/usr/bin/env bash
# Run this ON THE VM as your normal sudo-capable admin user (NOT the clipthat
# service account, which has no shell and no sudo rights on purpose).
# Usage: ./deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"

echo "Fetching latest code..."
sudo -u clipthat git -C "$REPO_DIR" pull --ff-only

echo "Installing dependencies..."
sudo -u clipthat npm --prefix "$REPO_DIR" ci --omit=dev

echo "Applying database migrations..."
sudo -u clipthat npm --prefix "$REPO_DIR" run init-db

echo "Restarting services..."
sudo systemctl restart clipthat-api.service clipthat-bot.service

echo "Deployed $(git -C "$REPO_DIR" rev-parse --short HEAD) at $(date -u +%FT%TZ)"
sudo systemctl --no-pager status clipthat-api.service clipthat-bot.service
