# Discord VC Recorder Bot

A Discord voice-channel recorder with per-speaker PCM clips, Discord clip posts, and a responsive browser editor. The bot records only after an administrator explicitly uses `/record join`.

## Prerequisites

- Node.js 20+ and FFmpeg on the host (`sudo apt install ffmpeg` on Debian/Ubuntu)
- A Discord application with a bot token and OAuth2 redirect URL
- The bot needs Guilds, Voice States, Message Content (only for `!clipthat`), and Connect/Speak permissions.

## Setup

1. Copy `config.example.json` to `config.json` and provide your Discord values. Set the OAuth redirect URL to `http://YOUR_HOST:3000/api/auth/discord/callback`.
2. Install packages with `npm install`.
3. Initialize storage with `npm run init-db`.
4. In separate processes, run `npm run api` and `npm run bot`.
5. Set a long random `SESSION_SECRET` environment variable. In production, run behind HTTPS (the app enforces a secure session cookie).
6. Browse `http://YOUR_HOST:3000`, authenticate with Discord, and select a server from the picker.

### Local development without Discord OAuth

Set `DEV_AUTH_ENABLED=true`, then start the API and open `http://localhost:3000`. The landing page will show **Local dev login**, which creates a local server-owner session so the clip and management UI can be developed without a domain. This endpoint only accepts loopback requests and is disabled when `NODE_ENV=production`.

PowerShell example:

```powershell
$env:DEV_AUTH_ENABLED='true'
npm.cmd run api
```

For real Discord login, register the exact callback URL shown by `discord.redirectUri` in the Discord Developer Portal. For local testing that is normally `http://localhost:3000/api/auth/discord/callback`; the scheme, host, port, and path must match exactly.

Use `/record join` in a voice channel, then `/clipthat`, `/clipthat duration:2m`, or `!clipthat 2m`. `/record leave` stops and clears the RAM buffer. `/clips list` shows recent ids, and `/clips edit id:...` returns the editor link.

## Management and bot admins

The Discord server owner can open **Manage** in the dashboard to configure the clips channel, buffer length, retention period, and a list of delegated bot admins. Add admins using their Discord User ID (Developer Mode → right-click user → **Copy User ID**). Delegated admins do not need a Discord role: they can use `/record join`, `/record leave`, `/settings`, and manage settings in the dashboard. Only the actual Discord server owner can grant or revoke this access.

## Operations

`npm run cleanup` deletes non-favorited clips whose `expires_at` has passed. Schedule it nightly with cron or a systemd timer. Copy `systemd-service.txt` to `/etc/systemd/system/discord-vc-recorder.service`, adjust `User` and `WorkingDirectory`, then run `systemctl daemon-reload && systemctl enable --now discord-vc-recorder`.

The dashboard/API process should be supervised separately (for example, another systemd service or PM2). In production, use HTTPS and set a strong `SESSION_SECRET` before starting the service.

## Important limitations

Discord voice recording and consent laws vary by jurisdiction and server rules. Tell channel participants when recording is active and obtain required consent. The bot keeps audio in RAM until a clip is requested; clips are then stored beneath `data/clips` and tracked in SQLite.
