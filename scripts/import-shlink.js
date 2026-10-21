// Перенос ссылок и переходов из базы Shlink (SQLite) в базу «Короче».
// Использование: node scripts/import-shlink.js <shlink.sqlite> <koroche.sqlite> <vk-id владельца ссылок>
// Запускать можно повторно: существующие коды пропускаются. IP-адреса не переносятся.
import Database from 'better-sqlite3';
import { openDb } from '../server/db.js';

const [src, dst, ownerVk] = process.argv.slice(2);
if (!src || !dst || !ownerVk) {
  console.error('node scripts/import-shlink.js <shlink.sqlite> <koroche.sqlite> <vk-id владельца>');
  process.exit(1);
}

const utc = (s) => (s ? Date.parse(`${s.replace(' ', 'T')}Z`) : null);

const from = new Database(src, { readonly: true });
const to = openDb(dst);
to.prepare('INSERT OR IGNORE INTO users (vk_id, created_at) VALUES (?, ?)').run(ownerVk, Date.now());
const ownerId = to.prepare('SELECT id FROM users WHERE vk_id = ?').get(ownerVk).id;

// Номер последнего перенесённого визита Shlink хранится в meta: повторный запуск докачивает только новые переходы.
to.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
const getMeta = to.prepare('SELECT v FROM meta WHERE k = ?');
const setMeta = to.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
let lastId = Number(getMeta.get('shlink_last_visit_id')?.v ?? 0);
if (!lastId) {
  // База, импортированная до появления meta: считаем перенесённым всё, что не новее последнего нашего визита.
  const maxTs = to.prepare('SELECT MAX(ts) AS t FROM visits').get().t;
  if (maxTs) lastId = from.prepare("SELECT COALESCE(MAX(id), 0) AS i FROM visits WHERE datetime(date) <= datetime(?, 'unixepoch')").get(Math.floor(maxTs / 1000)).i;
}
const newMax = from.prepare('SELECT COALESCE(MAX(id), 0) AS i FROM visits').get().i;

const urls = from.prepare('SELECT * FROM short_urls ORDER BY id').all();
const tagsOf = from.prepare('SELECT t.name FROM tags t JOIN short_urls_in_tags s ON s.tag_id = t.id WHERE s.short_url_id = ?');
const visitsOf = from.prepare("SELECT referer, date, user_agent, potential_bot FROM visits WHERE short_url_id = ? AND type = 'valid_short_url' AND id > ? ORDER BY id");

const byCode = to.prepare('SELECT id FROM links WHERE code = ?');
const insLink = to.prepare('INSERT INTO links (owner_id, code, url, title, created_at, valid_since, valid_until) VALUES (?,?,?,?,?,?,?)');
const bump = to.prepare('UPDATE links SET visits = visits + ?, human_visits = human_visits + ?, last_visit = MAX(COALESCE(last_visit, 0), ?) WHERE id = ?');
const insTag = to.prepare('INSERT OR IGNORE INTO tags (link_id, tag) VALUES (?, ?)');
const insVisit = to.prepare('INSERT INTO visits (link_id, ts, referer, ua, bot) VALUES (?,?,?,?,?)');

let links = 0, visits = 0, skipped = 0;
to.transaction(() => {
  for (const u of urls) {
    if (u.domain_id !== null && u.domain_id !== 1) { console.warn(`пропуск ${u.short_code}: другой домен`); skipped++; continue; }
    let id = byCode.get(u.short_code)?.id;
    if (!id) {
      id = insLink.run(ownerId, u.short_code, u.original_url, u.title, utc(u.date_created), utc(u.valid_since), utc(u.valid_until)).lastInsertRowid;
      for (const t of tagsOf.all(u.id)) insTag.run(id, t.name.toLowerCase());
      links++;
    }
    const vs = visitsOf.all(u.id, lastId);
    for (const v of vs) insVisit.run(id, utc(v.date), v.referer || null, (v.user_agent ?? '').slice(0, 300), v.potential_bot ? 1 : 0);
    if (vs.length) bump.run(vs.length, vs.filter((v) => !v.potential_bot).length, Math.max(...vs.map((v) => utc(v.date))), id);
    visits += vs.length;
  }
  setMeta.run('shlink_last_visit_id', String(newMax));
})();

console.log(`Новых ссылок: ${links}, новых переходов: ${visits}, пропущено: ${skipped}`);
