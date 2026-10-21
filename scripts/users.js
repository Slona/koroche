// Управление пользователями из консоли (DB_PATH — путь к базе, как у сервиса).
//   node scripts/users.js list
//   node scripts/users.js disable <vk-id>      — отключить: ссылки перестают работать, вход закрыт
//   node scripts/users.js enable <vk-id>
//   node scripts/users.js transfer <vk-id откуда> <vk-id куда> [код ...]   — передать все (или перечисленные) ссылки
// Изменения подхватываются работающим сервисом в течение минуты.
import { openDb } from '../server/db.js';

const [cmd, a, b, ...codes] = process.argv.slice(2);
const db = openDb(process.env.DB_PATH ?? new URL('../data/koroche.sqlite', import.meta.url).pathname);
const user = (vk) => db.prepare('SELECT * FROM users WHERE vk_id = ?').get(String(vk));
const need = (vk) => user(vk) ?? (console.error(`Пользователь VK ${vk} не найден`), process.exit(1));

if (cmd === 'list') {
  const rows = db.prepare(`SELECT u.vk_id, u.name, u.disabled, u.last_login, COUNT(l.id) AS links
                           FROM users u LEFT JOIN links l ON l.owner_id = u.id GROUP BY u.id ORDER BY u.id`).all();
  for (const r of rows) {
    const last = r.last_login ? new Date(r.last_login).toISOString().slice(0, 16).replace('T', ' ') : '—';
    console.log(`${r.vk_id}\t${r.name ?? '(без имени)'}\tссылок: ${r.links}\tвход: ${last}${r.disabled ? '\tОТКЛЮЧЁН' : ''}`);
  }
} else if (cmd === 'disable' || cmd === 'enable') {
  const u = need(a);
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(cmd === 'disable' ? 1 : 0, u.id);
  console.log(`${cmd === 'disable' ? 'Отключён' : 'Включён'}: VK ${a}`);
} else if (cmd === 'transfer' && a && b) {
  const from = need(a);
  db.prepare('INSERT OR IGNORE INTO users (vk_id, created_at) VALUES (?, ?)').run(String(b), Date.now());
  const to = user(b);
  const res = codes.length
    ? db.prepare(`UPDATE links SET owner_id = ? WHERE owner_id = ? AND code IN (${codes.map(() => '?').join(',')})`).run(to.id, from.id, ...codes)
    : db.prepare('UPDATE links SET owner_id = ? WHERE owner_id = ?').run(to.id, from.id);
  console.log(`Передано ссылок: ${res.changes} (VK ${a} → VK ${b})`);
} else {
  console.error('Команды: list | disable <vk> | enable <vk> | transfer <от-vk> <кому-vk> [код ...]');
  process.exit(1);
}
