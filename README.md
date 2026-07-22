# ClipThat

A private, multi-server Discord voice recorder with per-speaker clips and a personalized web app. Each server sees its own nickname for the bot; the fallback name is ClipThat. The bot records only after a bot admin explicitly uses `/record start`.

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

Set the real Discord user and server IDs for the local owner, then use `npm run dev`. The terminal prints a single-use code that expires after ten minutes. Open `http://localhost:3000`, paste the code into the local sign-in form, and keep the terminal private. The code grants access only to the configured server; forwarded or tunneled requests are rejected, and development login cannot start in production.

PowerShell example:

```powershell
$env:DEV_USER_ID='YOUR_DISCORD_USER_ID'
$env:DEV_GUILD_ID='YOUR_DISCORD_SERVER_ID'
npm.cmd run dev
```

To enable the owner-only platform console, set `PLATFORM_OWNER_IDS` to your Discord user ID (or a comma-separated list of trusted owner IDs) before signing in. Platform owners get a **Platform controls** link in the account menu where they can manually grant Premium, set storage/clip/retention/buffer limits, pause recording for a server with a private moderation reason, and review audited changes. There is intentionally no default super admin and no payment integration.

For real Discord login, register the exact callback URL shown by `discord.redirectUri` in the Discord Developer Portal. For local testing that is normally `http://localhost:3000/api/auth/discord/callback`; the scheme, host, port, and path must match exactly.

Use `/record start` in a voice channel, then `/clipthat` or `/clipthat duration:2m title:Great round`. `/record stop` stops and clears the RAM buffer, and `/record status` reports recorder health. `/privacy allow` and `/privacy block` control future capture; `/privacy remove-past` confirms and removes the member from already-saved clips. Every posted clip also has **Remove my voice** and **Add me (new cut)** buttons. Adding yourself creates a personal copy without changing the original. `/clips recent` shows titled moments with open buttons; `/clips open` has server-scoped title autocomplete. The old join/leave, `/clip`, list, and edit forms remain as one-release compatibility aliases.

The signed-in app is a no-reload server library with a desktop server rail, mobile server switcher and bottom navigation, persistent playback, recents, favorites, search, cursor pagination, trash, and an integrated waveform editor. Old `editor.html?clip_id=` and `admin.html?guild=` links redirect into the new shell.

## Management and bot admins

The Discord server owner can open **Manage** in the dashboard to configure the clips channel, consent mode, buffer length, retention period, and a list of delegated bot admins. Add admins using their Discord User ID (Developer Mode → right-click user → **Copy User ID**). Delegated admins do not need a Discord role: they can use `/record start`, `/record stop`, `/settings`, and manage settings in the dashboard. Only the actual Discord server owner can grant or revoke this access.

Any signed-in member of a clip's server can rename an active clip. Clip creators and bot admins can preview unsaved audio changes, save immutable revisions, favorite clips, and move authorized clips to trash. Bot admins can inspect and restore revision history, view server trash, and restore clips.

## Operations

`npm run cleanup` moves expired, non-favorited clips into recoverable trash, deletes expired one-hour previews, and permanently removes trash after 30 days. Schedule it nightly. `npm run backup-db` creates a consistent SQLite backup in `backups/`; production also needs encrypted backups of `data/clips` and a tested restore procedure.

For a small VPS, copy `.env.example` to `.env`, fill production values, and run the API and bot as separate supervised processes against the same persistent `data` directory. The included Dockerfile can build either process by overriding its command. Bind the API privately behind a Cloudflare Tunnel or another HTTPS reverse proxy and check readiness at `/api/health`. Set `API_BASE_URL`, `WEB_BASE_URL`, and `DISCORD_REDIRECT_URI` to the final HTTPS origin before production startup.

Run `npm run cleanup` nightly and `npm run backup-db` daily inside the API environment. Database backups are stored in the configured backup directory and the newest 14 are retained by default. A provider-level VPS backup is still required because an on-disk backup does not protect against losing the whole host.

In production, use HTTPS, leave development login disabled, set a strong `SESSION_SECRET`, and configure `TRUST_PROXY` explicitly (`false` by default or `loopback` only when the final trusted proxy connects locally and overwrites forwarded headers). Production sessions use a seven-day `__Host-clipthat.sid` cookie; all state-changing API calls require JSON, the session-bound CSRF token, and same-origin request metadata. Installed-server membership and Manage Server access are rechecked against Discord with a five-minute cache. Discord OAuth tokens are used only during sign-in and are not stored. Review the draft Privacy and Terms pages and add an operator identity and support contact before inviting the public.

Run `npm test` for migration, permission, endpoint, recorder-timing, and cleanup regressions. `npm run security-check` performs syntax checks, the isolated security regression suite, and a production dependency audit.

## Important limitations

Discord voice recording and consent laws vary by jurisdiction and server rules. ClipThat posts a visible recording notice and supports both notice-with-opt-out and explicit-opt-in modes, but the operator and server admins remain responsible for choosing a lawful setup. The bot keeps unsaved audio in RAM until a clip is requested; clips are then stored beneath `data/clips` and tracked in SQLite.
