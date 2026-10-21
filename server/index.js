import Fastify from 'fastify';
import QRCode from 'qrcode';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, createUsers } from './db.js';
import { createLinks, HttpError, isBot } from './links.js';
import { createAuth } from './auth.js';
import { fetchTitle } from './title.js';

const root = dirname(fileURLToPath(import.meta.url));
const env = process.env;

const cfg = {
  port: Number(env.PORT ?? 3010),
  listen: env.LISTEN ?? '127.0.0.1',
  shortHost: (env.SHORT_HOST ?? '4cm.su').toLowerCase(),
  panelHost: (env.PANEL_HOST ?? 'web.4cm.su').toLowerCase(),
  scheme: env.SCHEME ?? 'https',
  dbPath: env.DB_PATH ?? join(root, '..', 'data', 'koroche.sqlite'),
  secret: env.SESSION_SECRET,
  vkClientId: env.VK_CLIENT_ID,
  legacyOwnerVkId: env.LEGACY_OWNER_VK_ID,
  maxLinksPerUser: Number(env.MAX_LINKS_PER_USER ?? 1000),
  devLogin: env.DEV_LOGIN === '1',
  devVkId: env.DEV_VK_ID ?? '1',
  tzOffsetMs: Number(env.TZ_OFFSET_HOURS ?? 3) * 3600000,
};
if (!cfg.secret || cfg.secret.length < 32) throw new Error('SESSION_SECRET (>=32 символов) обязателен');

const shortOrigin = env.SHORT_ORIGIN ?? `${cfg.scheme}://${cfg.shortHost}`;
const panelOrigin = env.PANEL_ORIGIN ?? `${cfg.scheme}://${cfg.panelHost}`;

// ---------- статика: читаем в память при старте ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};
function loadDir(dir) {
  const files = new Map();
  for (const name of readdirSync(dir)) {
    const body = readFileSync(join(dir, name));
    files.set(name === 'index.html' ? '/' : `/${name}`, {
      body, type: TYPES[extname(name)] ?? 'application/octet-stream', etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`,
    });
  }
  return files;
}
const siteFiles = loadDir(join(root, 'public', 'site'));
const panelFiles = loadDir(join(root, 'public', 'panel'));
siteFiles.set('/robots.txt', { body: Buffer.from('User-agent: *\nDisallow: /\n'), type: TYPES['.txt'], etag: '"robots"' });
const notFoundPage = siteFiles.get('/404.html');

const sendFile = (req, reply, f, status = 200) => {
  if (status === 200 && req.headers['if-none-match'] === f.etag) return reply.code(304).send();
  return reply.code(status).header('etag', f.etag).header('cache-control', 'no-cache').type(f.type).send(f.body);
};

// ---------- сервисы ----------
const db = openDb(cfg.dbPath, { legacyOwnerVkId: cfg.legacyOwnerVkId });
const users = createUsers(db);
const links = createLinks(db, { maxPerUser: cfg.maxLinksPerUser, blockedHosts: [cfg.shortHost, cfg.panelHost] });
const auth = createAuth({
  secret: cfg.secret, vk: { clientId: cfg.vkClientId }, panelOrigin,
  secureCookies: cfg.scheme === 'https',
});

const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 64 * 1024 });

const hostOf = (req) => (req.headers.host ?? '').split(':')[0].toLowerCase();

// ---------- запись переходов (пачками) ----------
let queue = [];
const flush = () => {
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  try { links.recordVisits(batch); } catch (e) { app.log.error(e, 'visit flush failed'); }
};
const flushTimer = setInterval(flush, 2000);
flushTimer.unref();

// Подхватываем изменения, сделанные из консоли (отключение пользователей, передача ссылок).
setInterval(links.reload, 60000).unref();

const trimRef = (r) => (r ? r.slice(0, 500) : null);

// ---------- короткий домен ----------
const notFound = (req, reply) => sendFile(req, reply, notFoundPage, 404);

function redirect(req, reply) {
  const link = links.resolve(req.params.code);
  const now = Date.now();
  if (!link || (link.valid_since && now < link.valid_since) || (link.valid_until && now > link.valid_until)) {
    return notFound(req, reply);
  }
  if (req.method !== 'HEAD') {
    const ua = req.headers['user-agent'] ?? '';
    queue.push({ link_id: link.id, ts: now, referer: trimRef(req.headers.referer), ua: ua.slice(0, 300), bot: isBot(ua) ? 1 : 0 });
    if (queue.length >= 500) flush();
  }
  let target = link.url;
  const qi = req.url.indexOf('?');
  if (qi >= 0) {
    // Как в Shlink: query-параметры короткой ссылки пробрасываются на длинную.
    const t = new URL(link.url);
    for (const [k, v] of new URLSearchParams(req.url.slice(qi + 1))) t.searchParams.append(k, v);
    target = t.href;
  }
  return reply.code(302).header('location', target).header('cache-control', 'private, max-age=0').header('x-robots-tag', 'noindex').send();
}

// ---------- API панели ----------
// Возвращает пользователя из сессии; чужие и отключённые аккаунты не проходят.
const requireUser = (req) => {
  const sess = auth.sessionFrom(req);
  const user = sess && users.byVk(sess.sub);
  if (!user || user.disabled) throw new HttpError(401, 'Требуется вход');
  if (req.method !== 'GET' && req.headers.origin !== panelOrigin) throw new HttpError(403, 'Неверный Origin');
  return user;
};

// Не больше 30 новых ссылок в час на пользователя (защита от злоупотреблений).
const createLog = new Map();
const rateLimitCreate = (userId) => {
  const now = Date.now();
  const recent = (createLog.get(userId) ?? []).filter((t) => now - t < 3600000);
  if (recent.length >= 30) throw new HttpError(429, 'Слишком много новых ссылок, попробуйте позже');
  recent.push(now);
  createLog.set(userId, recent);
};

const decorate = (l) => ({ ...l, short_url: `${shortOrigin}/${l.code}` });

const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Некорректный id');
  return id;
};

app.setErrorHandler((err, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
  if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
  app.log.error(err);
  return reply.code(500).send({ error: 'Внутренняя ошибка' });
});

const panelOnly = (handler) => (req, reply) => (hostOf(req) === cfg.panelHost ? handler(req, reply) : notFound(req, reply));

app.get('/api/me', panelOnly((req) => {
  const sess = auth.sessionFrom(req);
  const user = sess && users.byVk(sess.sub);
  const ok = !!user && !user.disabled;
  return { authenticated: ok, vk_id: ok ? user.vk_id : null, name: ok ? user.name : null, short_origin: shortOrigin };
}));

app.get('/api/links', panelOnly((req) => {
  const u = requireUser(req);
  return links.list(u.id, { search: req.query.q, tag: req.query.tag }).map(decorate);
}));

app.get('/api/tags', panelOnly((req) => {
  const u = requireUser(req);
  return links.tags(u.id);
}));

app.post('/api/links', panelOnly(async (req, reply) => {
  const u = requireUser(req);
  rateLimitCreate(u.id);
  const body = req.body ?? {};
  if (!body.title && typeof body.url === 'string') body.title = await fetchTitle(body.url);
  return reply.code(201).send(decorate(links.create(u.id, body)));
}));

app.put('/api/links/:id', panelOnly((req) => {
  const u = requireUser(req);
  return decorate(links.update(idParam(req), u.id, req.body ?? {}));
}));

app.delete('/api/links/:id', panelOnly((req, reply) => {
  const u = requireUser(req);
  links.remove(idParam(req), u.id);
  return reply.code(204).send();
}));

app.get('/api/links/:id/stats', panelOnly((req) => {
  const u = requireUser(req);
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const s = links.stats(idParam(req), u.id, days, cfg.tzOffsetMs);
  return { ...s, link: decorate(s.link) };
}));

app.get('/api/links/:id/qr', panelOnly(async (req, reply) => {
  const u = requireUser(req);
  const link = links.get(idParam(req), u.id);
  if (!link) throw new HttpError(404, 'Ссылка не найдена');
  const text = `${shortOrigin}/${link.code}`;
  if (req.query.format === 'png') {
    const png = await QRCode.toBuffer(text, { type: 'png', width: 1024, margin: 2, errorCorrectionLevel: 'M' });
    return reply.header('content-disposition', `attachment; filename="${link.code}.png"`).type('image/png').send(png);
  }
  const svg = await QRCode.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  return reply.header('content-disposition', `inline; filename="${link.code}.svg"`).type('image/svg+xml').send(svg);
}));

// ---------- вход ----------
app.get('/auth/login', panelOnly((req, reply) => {
  if (!cfg.vkClientId) return reply.code(503).type('text/plain; charset=utf-8').send('VK ID не настроен');
  const { url, flowCookie } = auth.beginVk();
  return reply.header('set-cookie', flowCookie).redirect(url);
}));

app.get('/auth/callback', panelOnly(async (req, reply) => {
  const { code, state, device_id } = req.query;
  try {
    const { vkId, name } = await auth.finishVk(req, { code, state, device_id });
    const user = users.login(vkId, name);
    if (user.disabled) return reply.code(403).type('text/plain; charset=utf-8').send('Аккаунт отключён');
    return reply.header('set-cookie', [auth.startSession(vkId), auth.clearFlow()]).redirect('/');
  } catch (e) {
    app.log.warn(e.message);
    return reply.code(400).type('text/plain; charset=utf-8').send(`Ошибка входа: ${e.message}`);
  }
}));

app.post('/auth/logout', panelOnly((req, reply) => {
  if (req.headers.origin !== panelOrigin) throw new HttpError(403, 'Неверный Origin');
  return reply.header('set-cookie', auth.endSession()).code(204).send();
}));

if (cfg.devLogin) {
  // Только для локальной разработки (DEV_LOGIN=1).
  app.get('/auth/dev', panelOnly((req, reply) => { users.login(cfg.devVkId, 'Dev'); return reply.header('set-cookie', auth.startSession(cfg.devVkId)).redirect('/'); }));
}

// ---------- статика и редиректы ----------
const fileRoutes = new Set([...siteFiles.keys(), ...panelFiles.keys()]);
for (const path of fileRoutes) {
  app.get(path, (req, reply) => {
    const h = hostOf(req);
    const f = h === cfg.panelHost ? panelFiles.get(path) : h === cfg.shortHost ? siteFiles.get(path) : null;
    return f ? sendFile(req, reply, f) : notFound(req, reply);
  });
}

app.get('/:code', (req, reply) => (hostOf(req) === cfg.shortHost ? redirect(req, reply) : notFound(req, reply)));
app.setNotFoundHandler(notFound);

// ---------- запуск и остановка ----------
await app.listen({ port: cfg.port, host: cfg.listen });
console.log(`koroche: ${shortOrigin} + ${panelOrigin} on ${cfg.listen}:${cfg.port}`);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    clearInterval(flushTimer);
    await app.close();
    flush();
    db.close();
    process.exit(0);
  });
}
