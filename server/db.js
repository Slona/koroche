import Database from 'better-sqlite3';

// legacyOwnerVkId: владелец ссылок, созданных до появления пользователей (разовая миграция).
export function openDb(file, { legacyOwnerVkId } = {}) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      vk_id      TEXT NOT NULL UNIQUE,
      name       TEXT,
      created_at INTEGER NOT NULL,
      last_login INTEGER,
      disabled   INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS links (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id     INTEGER REFERENCES users(id),
      code         TEXT NOT NULL UNIQUE,
      url          TEXT NOT NULL,
      title        TEXT,
      created_at   INTEGER NOT NULL,
      valid_since  INTEGER,
      valid_until  INTEGER,
      visits       INTEGER NOT NULL DEFAULT 0,
      human_visits INTEGER NOT NULL DEFAULT 0,
      last_visit   INTEGER
    );
    CREATE TABLE IF NOT EXISTS tags (
      link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      tag     TEXT NOT NULL,
      PRIMARY KEY (link_id, tag)
    );
    CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
    CREATE TABLE IF NOT EXISTS visits (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      ts      INTEGER NOT NULL,
      referer TEXT,
      ua      TEXT,
      bot     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS visits_link_ts ON visits(link_id, ts);
  `);

  // Миграция версии без пользователей.
  if (!db.prepare('PRAGMA table_info(links)').all().some((c) => c.name === 'owner_id')) {
    db.exec('ALTER TABLE links ADD COLUMN owner_id INTEGER REFERENCES users(id)');
  }
  db.exec('CREATE INDEX IF NOT EXISTS links_owner ON links(owner_id, created_at)');

  if (legacyOwnerVkId) {
    const orphans = db.prepare('SELECT COUNT(*) AS n FROM links WHERE owner_id IS NULL').get().n;
    if (orphans) {
      db.prepare('INSERT OR IGNORE INTO users (vk_id, created_at) VALUES (?, ?)').run(String(legacyOwnerVkId), Date.now());
      const { id } = db.prepare('SELECT id FROM users WHERE vk_id = ?').get(String(legacyOwnerVkId));
      db.prepare('UPDATE links SET owner_id = ? WHERE owner_id IS NULL').run(id);
      console.log(`migrate: ${orphans} ссылок без владельца переданы пользователю VK ${legacyOwnerVkId}`);
    }
  }
  return db;
}

export function createUsers(db) {
  const q = {
    byVk: db.prepare('SELECT * FROM users WHERE vk_id = ?'),
    insert: db.prepare('INSERT INTO users (vk_id, name, created_at, last_login) VALUES (?, ?, ?, ?)'),
    touch: db.prepare('UPDATE users SET last_login = ?, name = COALESCE(?, name) WHERE id = ?'),
  };
  return {
    byVk: (vkId) => q.byVk.get(String(vkId)),
    // Вход через VK: пользователь создаётся при первом входе.
    login(vkId, name) {
      const now = Date.now();
      const cur = q.byVk.get(String(vkId));
      if (cur) q.touch.run(now, name ?? null, cur.id);
      else q.insert.run(String(vkId), name ?? null, now, now);
      return q.byVk.get(String(vkId));
    },
  };
}
