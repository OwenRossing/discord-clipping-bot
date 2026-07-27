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
sudo -u clipthat git clone https://github.com/<you>/discord-clipping-bot.git /opt/clipthat
cd /opt/clipthat
sudo -u clipthat npm ci --omit=dev
```

## 4. Production `.env`

```
sudo -u clipthat cp deploy/.env.production.example .env
sudo -u clipthat nano .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET` (a real random string, not the placeholder), `PLATFORM_OWNER_IDS` (your Discord user ID), and replace every `clips.yourdomain.com` with your actual hostname. Leave `TRUST_PROXY=loopback` and `API_HOST=127.0.0.1` as-is — that's specifically because Cloudflare Tunnel talks to the app over localhost.

Then initialize the database:

```
sudo -u clipthat npm run init-db
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

On Namecheap: point the domain's nameservers at the two Cloudflare nameservers shown when you add the domain as a zone in the Cloudflare dashboard (free plan is fine). This just moves DNS management to Cloudflare — the domain stays registered at Namecheap.

On the VM:

```
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared

cloudflared tunnel login          # opens a browser link, authorize against your Cloudflare account
cloudflared tunnel create clipthat
```

That prints a tunnel ID and writes credentials to `~/.cloudflared/<id>.json`. Copy `deploy/cloudflared-config.yml.example` to `~/.cloudflared/config.yml`, fill in the tunnel ID and your real hostname, then:

```
cloudflared tunnel route dns clipthat clips.yourdomain.com
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Your VM's IP is never exposed — Cloudflare terminates TLS and tunnels the connection in.

## 7. Discord Developer Portal

Register the exact production callback URL — `https://clips.yourdomain.com/api/auth/discord/callback` — under OAuth2 → Redirects. It must match `DISCORD_REDIRECT_URI` in `.env` byte-for-byte.

## 8. Smoke test

Visit `https://clips.yourdomain.com`, sign in with Discord, confirm a server you manage shows up. Then in Discord, run `/record start` in a voice channel and `/clipthat` to confirm the bot process is actually working end to end.

## 9. Future updates

From now on, deploying a change is:

```
sudo -u clipthat /opt/clipthat/deploy/deploy.sh
```

That does `git pull`, reinstalls dependencies, re-runs migrations, and restarts both services. It calls `sudo systemctl restart`, so either run it as a user with sudo, or add a narrow NOPASSWD rule for just that so it's a single command with no prompt:

```
echo 'clipthat ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart clipthat-api.service clipthat-bot.service, /usr/bin/systemctl status clipthat-api.service clipthat-bot.service' | sudo tee /etc/sudoers.d/clipthat-deploy
```

## Rollback

`git log --oneline -5` to find the last-good commit, then `git checkout <sha>` (or `git reset --hard <sha>` if you're sure), `npm ci --omit=dev`, `sudo systemctl restart clipthat-api clipthat-bot`.
