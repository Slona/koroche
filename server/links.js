import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const TAG_RE = /^[^\s,]{1,32}$/u;
const BOT_RE = /bot|crawl|spider|slurp|preview|fetch|monitor|scan|check|resolver|chatterino|frankerfacez|ffz|discord|telegram|vkshare|facebookexternalhit|whatsapp|slack|curl|wget|python|go-http|java\/|okhttp|headless|axios|node-fetch/i;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const isBot = (ua) => !ua || BOT_RE.test(ua);

// Все операции над ссылками привязаны к владельцу (ownerId): чужие ссылки недоступны.
export function createLinks(db, { maxPerUser = 1000, blockedHosts = [] } = {}) {
  const q = {
    forCache: db.prepare('SELECT l.*, COALESCE(u.disabled, 0) AS owner_disabled FROM links l LEFT JOIN users u ON u.id = l.owner_id'),
    mine: db.prepare('SELECT * FROM links WHERE owner_id = ? ORDER BY created_at DESC, id DESC'),
    byIdOwner: db.prepare('SELECT * FROM links WHERE id = ? AND owner_id = ?'),
    byCode: db.prepare('SELECT id FROM links WHERE code = ?'),
    countMine: db.prepare('SELECT COUNT(*) AS n FROM links WHERE owner_id = ?'),
    insert: db.prepare('INSERT INTO links (owner_id, code, url, title, created_at, valid_since, valid_until) VALUES (@owner_id, @code, @url, @title, @created_at, @valid_since, @valid_until)'),
    update: db.prepare('UPDATE links SET code=@code, url=@url, title=@title, valid_since=@valid_since, valid_until=@valid_until WHERE id=@id'),
    del: db.prepare('DELETE FROM links WHERE id = ? AND owner_id = ?'),
    tagsMine: db.prepare('SELECT t.link_id, t.tag FROM tags t JOIN links l ON l.id = t.link_id WHERE l.owner_id = ? ORDER BY t.tag'),
    tagIns: db.prepare('INSERT OR IGNORE INTO tags (link_id, tag) VALUES (?, ?)'),
    tagDel: db.prepare('DELETE FROM tags WHERE link_id = ?'),
    tagList: db.prepare('SELECT t.tag, COUNT(*) AS n FROM tags t JOIN links l ON l.id = t.link_id WHERE l.owner_id = ? GROUP BY t.tag ORDER BY t.tag'),
    visitIns: db.prepare('INSERT INTO visits (link_id, ts, referer, ua, bot) VALUES (?, ?, ?, ?, ?)'),
    visitBump: db.prepare('UPDATE links SET visits = visits + 1, human_visits = human_visits + ?, last_visit = ? WHERE id = ?'),
    exists: db.prepare('SELECT 1 FROM links WHERE id = ?'),
    daily: db.prepare(`SELECT date((ts + @off) / 1000, 'unixepoch') AS day, SUM(1 - bot) AS human, SUM(bot) AS bots
                       FROM visits WHERE link_id = @id AND ts >= @since GROUP BY day ORDER BY day`),
    refs: db.prepare(`SELECT COALESCE(referer, '') AS ref, COUNT(*) AS n FROM visits
                      WHERE link_id = ? AND bot = 0 GROUP BY ref ORDER BY n DESC LIMIT 10`),
  };

  // Горячий путь: код -> запись в памяти, без обращения к БД.
  let cache = new Map();
  const reload = () => {
    cache = new Map(q.forCache.all().map((r) => [r.code, r]));
  };
  reload();

  const withTags = (ownerId, rows) => {
    const byLink = new Map();
    for (const t of q.tagsMine.all(ownerId)) {
      if (!byLink.has(t.link_id)) byLink.set(t.link_id, []);
      byLink.get(t.link_id).push(t.tag);
    }
    return rows.map((r) => ({ ...r, tags: byLink.get(r.id) ?? [] }));
  };

  function clean(input, { partial = false } = {}) {
    const out = {};
    if (!partial || input.url !== undefined) {
      let u;
      try {
        u = new URL(String(input.url ?? '').trim());
      } catch {
        throw new HttpError(400, 'Некорректный URL');
      }
      if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'Разрешены только http и https');
      if (blockedHosts.includes(u.hostname.toLowerCase())) throw new HttpError(400, 'Нельзя сокращать адреса этого сервиса');
      if (u.href.length > 4096) throw new HttpError(400, 'URL слишком длинный');
      out.url = u.href;
    }
    if (input.code !== undefined && input.code !== null && input.code !== '') {
      if (!CODE_RE.test(input.code)) throw new HttpError(400, 'Код: латиница, цифры, _ и -, до 32 символов');
      out.code = input.code;
    }
    if (input.title !== undefined) out.title = String(input.title ?? '').trim().slice(0, 300) || null;
    for (const k of ['valid_since', 'valid_until']) {
      if (input[k] === undefined) continue;
      const v = input[k] === null || input[k] === '' ? null : Number(input[k]);
      if (v !== null && !Number.isFinite(v)) throw new HttpError(400, `Некорректная дата: ${k}`);
      out[k] = v;
    }
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags)) throw new HttpError(400, 'tags должен быть массивом');
      out.tags = [...new Set(input.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
      if (out.tags.length > 20 || out.tags.some((t) => !TAG_RE.test(t))) {
        throw new HttpError(400, 'Теги: без пробелов и запятых, до 32 символов');
      }
    }
    return out;
  }

  const checkRange = (since, until) => {
    if (since && until && since >= until) throw new HttpError(400, 'Срок окончания раньше начала');
  };

  const freeCode = () => {
    for (let len = 5; len < 12; len++) {
      for (let i = 0; i < 10; i++) {
        let c = '';
        for (let j = 0; j < len; j++) c += ALPHABET[randomInt(ALPHABET.length)];
        if (!q.byCode.get(c)) return c;
      }
    }
    throw new HttpError(500, 'Не удалось подобрать код');
  };

  const setTags = (id, tags) => {
    q.tagDel.run(id);
    for (const t of tags) q.tagIns.run(id, t);
  };

  const api = {
    resolve(code) {
      const l = cache.get(code);
      return l && !l.owner_disabled ? l : undefined;
    },

    list(ownerId, { search, tag } = {}) {
      let rows = withTags(ownerId, q.mine.all(ownerId));
      if (tag) rows = rows.filter((r) => r.tags.includes(tag));
      if (search) {
        const s = search.toLowerCase();
        rows = rows.filter((r) => [r.code, r.url, r.title ?? '', ...r.tags].some((x) => x.toLowerCase().includes(s)));
      }
      return rows;
    },

    get(id, ownerId) {
      const r = q.byIdOwner.get(id, ownerId);
      return r ? withTags(ownerId, [r])[0] : null;
    },

    create(ownerId, input) {
      const d = clean(input);
      checkRange(d.valid_since, d.valid_until);
      const id = db.transaction(() => {
        if (q.countMine.get(ownerId).n >= maxPerUser) throw new HttpError(429, `Достигнут лимит ссылок (${maxPerUser})`);
        const code = d.code ?? freeCode();
        if (q.byCode.get(code)) throw new HttpError(409, 'Такой код уже занят');
        const { lastInsertRowid } = q.insert.run({
          owner_id: ownerId,
          code,
          url: d.url,
          title: d.title ?? null,
          created_at: Date.now(),
          valid_since: d.valid_since ?? null,
          valid_until: d.valid_until ?? null,
        });
        setTags(lastInsertRowid, d.tags ?? []);
        return lastInsertRowid;
      })();
      reload();
      return api.get(id, ownerId);
    },

    update(id, ownerId, input) {
      const cur = q.byIdOwner.get(id, ownerId);
      if (!cur) throw new HttpError(404, 'Ссылка не найдена');
      const d = clean(input, { partial: true });
      const next = { ...cur, ...d };
      checkRange(next.valid_since, next.valid_until);
      db.transaction(() => {
        if (next.code !== cur.code && q.byCode.get(next.code)) throw new HttpError(409, 'Такой код уже занят');
        q.update.run({
          id,
          code: next.code,
          url: next.url,
          title: next.title,
          valid_since: next.valid_since,
          valid_until: next.valid_until,
        });
        if (d.tags) setTags(id, d.tags);
      })();
      reload();
      return api.get(id, ownerId);
    },

    remove(id, ownerId) {
      if (!q.del.run(id, ownerId).changes) throw new HttpError(404, 'Ссылка не найдена');
      reload();
    },

    tags: (ownerId) => q.tagList.all(ownerId),

    // Статистику отдаём только владельцу ссылки.
    stats(id, ownerId, days, offsetMs) {
      const link = api.get(id, ownerId);
      if (!link) throw new HttpError(404, 'Ссылка не найдена');
      const since = Date.now() - days * 86400000;
      return { link, daily: q.daily.all({ id, since, off: offsetMs }), referers: q.refs.all(id) };
    },

    reload,

    // Пакетная запись переходов одной транзакцией.
    recordVisits: db.transaction((batch) => {
      for (const v of batch) {
        if (!q.exists.get(v.link_id)) continue; // ссылку успели удалить
        q.visitIns.run(v.link_id, v.ts, v.referer, v.ua, v.bot);
        q.visitBump.run(v.bot ? 0 : 1, v.ts, v.link_id);
      }
    }),
  };
  return api;
}
