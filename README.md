# Clip Vault

A private, multi-server Discord voice recorder with per-speaker clips and a personalized Clip Vault web app. The bot records only after a bot admin explicitly uses `/record start`.

## Prerequisites

- Node.js 20+ (the project includes an FFmpeg binary through `ffmpeg-static`)
- A Discord application with a bot token and OAuth2 redirect URL
- The bot needs Guilds, Voice States, Connect, Speak, Send Messages, and Attach Files permissions. It does not use Message Content intent.

## Setup

1. Copy `.env.example` to `.env` and provide your Discord values. `config.json` remains accepted for local compatibility, but environment variables are preferred and must never be committed.
2. Install packages with `npm install`.
3. Initialize storage with `npm run init-db`.
4. In separate processes, run `npm run api` and `npm run bot`.
5. Set a long random `SESSION_SECRET` environment variable. In production, run behind HTTPS (the app enforces a secure session cookie).
6. Browse `http://YOUR_HOST:3000`, authenticate with Discord, and open one of your bot-enabled servers.

### Local development without Discord OAuth

Set `DEV_AUTH_ENABLED=true`, then start the API and open `http://localhost:3000`. The landing page will show **Local dev login**, which creates a local server-owner session so the clip and management UI can be developed without a domain. This endpoint only accepts loopback requests and is disabled when `NODE_ENV=production`.

PowerShell example:

```powershell
$env:DEV_AUTH_ENABLED='true'
npm.cmd run api
```

For real Discord login, register the exact callback URL shown by `discord.redirectUri` in the Discord Developer Portal. For local testing that is normally `http://localhost:3000/api/auth/discord/callback`; the scheme, host, port, and path must match exactly.

Use `/record start` in a voice channel, then `/clipthat` or `/clipthat duration:2m title:Great round`. `/record stop` stops and clears the RAM buffer, and `/record status` reports recorder health. `/privacy` lets every member allow or block capture of their voice. `/clips recent` shows titled moments with open buttons; `/clips open` has server-scoped title autocomplete. The old join/leave, `/clip`, list, and edit forms remain as one-release compatibility aliases.

The signed-in app is a no-reload server library with a desktop server rail, mobile server switcher and bottom navigation, persistent playback, recents, favorites, search, cursor pagination, trash, and an integrated waveform editor. Old `editor.html?clip_id=` and `admin.html?guild=` links redirect into the new shell.

## Management and bot admins

The Discord server owner can open **Manage** in the dashboard to configure the clips channel, consent mode, buffer length, retention period, and a list of delegated bot admins. Add admins using their Discord User ID (Developer Mode → right-click user → **Copy User ID**). Delegated admins do not need a Discord role: they can use `/record start`, `/record stop`, `/settings`, and manage settings in the dashboard. Only the actual Discord server owner can grant or revoke this access.

Any signed-in member of a clip's server can rename an active clip. Clip creators and bot admins can preview unsaved audio changes, save immutable revisions, favorite clips, and move authorized clips to trash. Bot admins can inspect and restore revision history, view server trash, and restore clips.

## Operations

`npm run cleanup` moves expired, non-favorited clips into recoverable trash, deletes expired one-hour previews, and permanently removes trash after 30 days. Schedule it nightly. `npm run backup-db` creates a consistent SQLite backup in `backups/`; production also needs encrypted backups of `data/clips` and a tested restore procedure.

For a small VPS, copy `.env.example` to `.env`, fill production values, then run `docker compose up -d --build`. The included Compose file runs the API and bot separately against one persistent data volume and binds the API only to localhost for a Cloudflare Tunnel or another HTTPS reverse proxy. Check readiness at `/api/health`. Set `API_BASE_URL`, `WEB_BASE_URL`, and `DISCORD_REDIRECT_URI` to the final HTTPS origin before production startup.

On a Docker deployment, run `docker compose exec -T api npm run cleanup` nightly and `docker compose exec -T api npm run backup-db` daily. Database backups are stored in the persistent data volume and the newest 14 are retained by default. A provider-level Droplet backup is still required because an on-disk backup does not protect against losing the whole VPS.

In production, use HTTPS, disable development login, and set a strong `SESSION_SECRET`. Production sessions use a seven-day `__Host-clipvault.sid` cookie; all state-changing API calls require the session-bound CSRF token and same-origin request metadata. Discord OAuth tokens are used only during sign-in and are not stored. Review the draft Privacy and Terms pages and add an operator identity and support contact before inviting the public.

Run `npm test` for migration, permission, endpoint, recorder-timing, and cleanup regressions. Run `npm run check` for the server-side syntax pass and `npm audit --omit=dev` before a release.

## Important limitations

Discord voice recording and consent laws vary by jurisdiction and server rules. Clip Vault posts a visible recording notice and supports both notice-with-opt-out and explicit-opt-in modes, but the operator and server admins remain responsible for choosing a lawful setup. The bot keeps unsaved audio in RAM until a clip is requested; clips are then stored beneath `data/clips` and tracked in SQLite.
