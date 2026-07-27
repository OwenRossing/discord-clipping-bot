# Deploying ClipThat on a plain VM (Proxmox, no Docker)

Run this whole page on the VM itself unless a step says otherwise. Nothing here needs Docker — just Node, git, and systemd.

## 1. Provision the VM

Debian 12 or Ubuntu 22.04/24.04, both work fine. Suggested spec for this workload (see the RAM-per-speaker math in chat if you want the reasoning): **2 vCPU / 6GB RAM / however much storage you already planned** — audio clips are small, storage was never the constraint.

## 2. Base packages

```
sudo apt update
sudo apt install -y git curl build-essential python3
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # confirm 20.x
which node   # note the path — usually /usr/bin/node, matches the systemd units below
```

`build-essential`/`python3` are there so `better-sqlite3` can compile from source if no prebuilt binary matches your exact Node build — usually unnecessary on a standard NodeSource install, but cheap insurance (this is exactly what bit us installing locally on Windows).

## 3. Dedicated user + clone the repo

```
sudo useradd --system --create-home --shell /usr/sbin/nologin clipthat
sudo mkdir -p /opt/clipthat
sudo chown clipthat:clipthat /opt/clipthat
sudo -u clipthat git clone https://github.com/OwenRossing/discord-clipping-bot.git /opt/clipthat
sudo git config --system --add safe.directory /opt/clipthat
cd /opt/clipthat
sudo -u clipthat npm ci --omit=dev
```

## 4. Production `.env`

```
sudo -u clipthat cp deploy/.env.production.example .env
sudo -u clipthat nano .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET` (a real random string, not the placeholder), `PLATFORM_OWNER_IDS` (your Discord user ID), and replace every `clips.yourdomain.com` with your actual hostname. Leave `TRUST_PROXY=loopback` and `API_HOST=127.0.0.1` as-is — that's specifically because Cloudflare Tunnel talks to the app over localhost.

Then initialize the database and create the data/backup directories. **All three must exist before the systemd units below will start** — `ProtectSystem=strict` requires every `ReadWritePaths=` target to already exist so it can bind-mount it; a missing directory fails the whole service with `226/NAMESPACE`, not a normal app-level error:

```
sudo -u clipthat npm run init-db
sudo -u clipthat mkdir -p data/clips data/previews backups
```

## 5. systemd services

```
sudo cp deploy/clipthat-*.service deploy/clipthat-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now clipthat-api.service clipthat-bot.service
sudo systemctl enable --now clipthat-cleanup.timer clipthat-backup.timer
sudo systemctl status clipthat-api.service clipthat-bot.service
```

If `which node` in step 2 printed something other than `/usr/bin/node`, edit the `ExecStart=` line in `/etc/systemd/system/clipthat-api.service` and `clipthat-bot.service` to match before `daemon-reload`.

## 6. Cloudflare Tunnel

The domain must already show as an **Active** zone in the Cloudflare dashboard before any of this works — add it under "Add a site" (free plan), then point its nameservers at the two Cloudflare gives you (at your registrar, e.g. Namecheap's "Custom DNS" setting). This just moves DNS management to Cloudflare; the domain stays registered wherever you bought it. Nameserver changes can take a few minutes to a day to propagate — `cloudflared tunnel login` will simply not show the domain as a choice until it's Active.

Install cloudflared. **The apt repo only has builds for specific LTS codenames** — if `lsb_release -cs` reports something newer/rolling (e.g. `resolute`), `apt install` will 404. Skip the repo and grab the `.deb` directly, which always works:

```
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb
cloudflared --version
```

Then, as whichever admin user you normally sudo from (**not** the `clipthat` service user — cloudflared's systemd service runs as root regardless of who sets it up, so there's no benefit to doing this as `clipthat`):

```
cloudflared tunnel login          # opens a browser link — pick your domain, it must show as Active first
cloudflared tunnel create clipthat
```

That prints a **Tunnel ID** and writes credentials to `~/.cloudflared/<id>.json` under your current user's home. Create `~/.cloudflared/config.yml` (see `deploy/cloudflared-config.yml.example` for the shape) with that real tunnel ID, the credentials path it just printed, and your real hostname, then:

```
cloudflared tunnel route dns clipthat clips.yourdomain.com
sudo cloudflared service install
sudo systemctl enable --now cloudflared
systemctl status cloudflared --no-pager
```

Your VM's IP is never exposed — Cloudflare terminates TLS and tunnels the connection in.

## 7. Discord Developer Portal

Register the exact production callback URL — `https://clips.yourdomain.com/api/auth/discord/callback` — under OAuth2 → Redirects. It must match `DISCORD_REDIRECT_URI` in `.env` byte-for-byte.

## 8. Verify everything at once

`deploy/verify.sh` checks Node version, `.env` sanity (production mode, real secrets, HTTPS URLs, matching redirect URI), data directories, all systemd services and timers, the local and public `/api/health` endpoints, and — importantly — that the dev-login endpoint is actually unreachable from the public internet. Run it any time, including right now:

```
./deploy/verify.sh
```

## 9. Smoke test

Visit `https://clips.yourdomain.com`, sign in with Discord, confirm a server you manage shows up. Then in Discord, run `/record start` in a voice channel and `/clipthat` to confirm the bot process is actually working end to end.

## 10. Future updates

From now on, deploying a change is, run as **yourself** (your normal sudo-capable login user — the script switches to `clipthat` internally for the parts that need it):

```
cd /opt/clipthat
./deploy/deploy.sh
```

That pulls as `clipthat` (matching the repo's file ownership, avoiding the "dubious ownership" error you'd get running plain `git pull` as the wrong user), reinstalls dependencies, re-runs migrations, then restarts both services with `sudo systemctl restart`. Expect two sudo prompts (once for the `sudo -u clipthat` steps, once for `systemctl`) unless you set up NOPASSWD rules for both:

```
echo 'discord-bot-host ALL=(clipthat) NOPASSWD: ALL
discord-bot-host ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart clipthat-api.service clipthat-bot.service, /usr/bin/systemctl status clipthat-api.service clipthat-bot.service' | sudo tee /etc/sudoers.d/clipthat-deploy
```

(swap `discord-bot-host` for whichever admin user actually runs deploys)

## Rollback

`sudo -u clipthat git -C /opt/clipthat log --oneline -5` to find the last-good commit, then `sudo -u clipthat git -C /opt/clipthat checkout <sha>` (or `reset --hard <sha>` if you're sure), `sudo -u clipthat npm --prefix /opt/clipthat ci --omit=dev`, `sudo systemctl restart clipthat-api clipthat-bot`.
