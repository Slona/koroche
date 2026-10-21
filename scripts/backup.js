// Резервная копия базы: консистентный снимок SQLite (работает при запущенном сервисе), gzip, ротация.
//   DB_PATH=... BACKUP_DIR=... KEEP=14 node scripts/backup.js
import Database from 'better-sqlite3';
import { createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { join } from 'node:path';

const dbPath = process.env.DB_PATH ?? './data/koroche.sqlite';
const dir = process.env.BACKUP_DIR ?? './data/backups';
const keep = Number(process.env.KEEP ?? 14);

mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16); // 2026-10-22-03-30
const raw = join(dir, `koroche-${stamp}.sqlite`);

const db = new Database(dbPath, { readonly: true });
await db.backup(raw);
db.close();

await pipeline(createReadStream(raw), createGzip({ level: 9 }), createWriteStream(`${raw}.gz`));
rmSync(raw);

const old = readdirSync(dir).filter((f) => /^koroche-.*\.sqlite\.gz$/.test(f)).sort().slice(0, -keep);
for (const f of old) rmSync(join(dir, f));

console.log(`backup: ${raw}.gz (${(statSync(`${raw}.gz`).size / 1024).toFixed(0)} KB), removed old: ${old.length}`);
