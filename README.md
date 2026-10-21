# Long Story Short (Короче)

**English** · [Русский](README.ru.md)

> 4cm that's all you need · *4 см: больше не нужно*

A small, fast, self-hosted URL shortener that powers [4cm.su](https://4cm.su). MIT licensed.

## Features
- Two domains served by one process: the short domain (`4cm.su`) only redirects, the panel (`web.4cm.su`) manages links.
- Unknown or expired code → a 404 page with a real 404 status (no redirect).
- **VK ID** login with open registration. Every user has their own links and cannot see anyone else's.
- Custom codes, tags, validity period (from / until), editing, QR codes (SVG/PNG).
- Statistics: counters, daily chart, referrers; bots and link previews are counted separately. IP addresses are not stored.
- Page titles are fetched automatically (with protection against requests to internal networks).
- Light on resources: Node 22, Fastify, SQLite; links are kept in memory, clicks are written in batches. No frontend build step.
- Abuse protection: per-user link quota, hourly creation limit, ability to disable a user.

## Installation
Requires Node.js 22+ and a reverse proxy (nginx) with HTTPS for both domains.

```bash
git clone https://github.com/Slona/koroche /opt/koroche && cd /opt/koroche
npm ci --omit=dev
cp .env.example /etc/koroche.env      # fill in, chmod 600
cp deploy/koroche.service /etc/systemd/system/   # adjust user/paths
systemctl enable --now koroche
```
An nginx example is in `deploy/nginx.conf.example`.

### VK ID
1. Create a "Web" application at [id.vk.com/business](https://id.vk.com/business).
2. Set the base domain to the panel domain and the trusted Redirect URL to `https://<panel domain>/auth/callback`.
3. Put the application ID into `VK_CLIENT_ID`. No client secret is needed (Authorization Code + PKCE).

### Configuration (environment variables)
| Variable | Purpose | Default |
|---|---|---|
| `SESSION_SECRET` | session signing key, ≥32 chars (required) | — |
| `SHORT_HOST`, `PANEL_HOST` | short-link and panel domains | `4cm.su`, `web.4cm.su` |
| `SCHEME` | `https` or `http` | `https` |
| `VK_CLIENT_ID` | VK ID application ID | — |
| `DB_PATH` | SQLite file | `./data/koroche.sqlite` |
| `PORT`, `LISTEN` | port and bind address | `3010`, `127.0.0.1` |
| `MAX_LINKS_PER_USER` | per-user link quota | `1000` |
| `TZ_OFFSET_HOURS` | timezone offset for charts | `3` |
| `LEGACY_OWNER_VK_ID` | owner of links created before users existed (one-off migration) | — |

The pages in `server/public/site` (landing, 404) are written for 4cm.su — replace the texts and the `404.jpg` image with your own.

## User management
```bash
DB_PATH=/var/lib/koroche/koroche.sqlite node scripts/users.js list
node scripts/users.js disable <vk-id>     # links stop working, login is blocked
node scripts/users.js enable <vk-id>
node scripts/users.js transfer <from-vk-id> <to-vk-id> [code ...]   # move links
```
The service picks up changes within a minute.

## Migrating from Shlink
```bash
node scripts/import-shlink.js <shlink.sqlite> <koroche.sqlite> <owner vk-id>
```
Codes, creation dates and visits are preserved (the bot flag comes from Shlink). Re-running imports only new visits.

## Development
```bash
npm install
cp .env.example .env     # DEV_LOGIN=1, SCHEME=http, SHORT_HOST=short.localhost, PANEL_HOST=panel.localhost, SHORT_ORIGIN/PANEL_ORIGIN with port
npm run dev              # login without VK: http://panel.localhost:3010/auth/dev
```

## License
[MIT](LICENSE)
