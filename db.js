import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'library.db');

let _db = null;

export function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      key               TEXT PRIMARY KEY,
      filename          TEXT,
      title             TEXT,
      authors           TEXT,
      year              INTEGER,
      year_fallback     INTEGER,
      type              TEXT,
      ext               TEXT,
      mtime             INTEGER,

      -- API enrichment
      enriched_year     INTEGER,
      enriched_source   TEXT,
      enriched_conf     TEXT,
      enriched_note     TEXT,

      -- Rich content (from HTML parsing)
      description       TEXT,
      site_name         TEXT,

      -- Manual overrides (always win)
      manual_year       INTEGER,
      manual_title      TEXT,
      manual_authors    TEXT,
      manual_note       TEXT,

      updated_at        INTEGER DEFAULT (strftime('%s','now'))
    );

    -- Migrate existing DBs that predate description/site_name columns
    CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY);
    INSERT OR IGNORE INTO _migrations VALUES ('add_description');

    -- Graph: user-defined connection types
    CREATE TABLE IF NOT EXISTS connection_types (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL,
      directed   INTEGER DEFAULT 0,
      created_at INTEGER
    );

    -- Graph: connections between items
    CREATE TABLE IF NOT EXISTS connections (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL,
      target_key TEXT NOT NULL,
      type_id    INTEGER NOT NULL REFERENCES connection_types(id) ON DELETE CASCADE,
      note       TEXT,
      created_at INTEGER
    );

    -- Graph: named groups
    CREATE TABLE IF NOT EXISTS groups (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      color       TEXT NOT NULL,
      description TEXT,
      created_at  INTEGER
    );

    -- Graph: group membership
    CREATE TABLE IF NOT EXISTS group_items (
      group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      PRIMARY KEY (group_id, item_key)
    );

    -- Graph: saved node positions
    CREATE TABLE IF NOT EXISTS graph_positions (
      item_key   TEXT PRIMARY KEY,
      x          REAL NOT NULL,
      y          REAL NOT NULL,
      updated_at INTEGER
    );

    -- Zotero collections (synced from Zotero API)
    CREATE TABLE IF NOT EXISTS zotero_collections (
      key        TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      parent_key TEXT,
      color      TEXT NOT NULL
    );

    -- Zotero collection membership
    CREATE TABLE IF NOT EXISTS zotero_item_collections (
      item_key       TEXT NOT NULL,
      collection_key TEXT NOT NULL,
      PRIMARY KEY (item_key, collection_key)
    );
  `);

  // Run migrations for existing databases
  try { _db.exec(`ALTER TABLE items ADD COLUMN description TEXT`); } catch {}
  try { _db.exec(`ALTER TABLE items ADD COLUMN site_name TEXT`); } catch {}
  try { _db.exec(`ALTER TABLE items ADD COLUMN cover_url TEXT`); } catch {}

  // Seed default connection types (only if empty)
  const typeCount = _db.prepare('SELECT COUNT(*) as n FROM connection_types').get();
  if (typeCount.n === 0) {
    const now = Math.floor(Date.now() / 1000);
    const ins = _db.prepare('INSERT INTO connection_types (name, color, directed, created_at) VALUES (?,?,?,?)');
    ins.run('Reference',     '#3b82f6', 1, now);
    ins.run('Ideological',   '#22c55e', 0, now);
    ins.run('Methodological','#f97316', 0, now);
    ins.run('Historical',    '#a855f7', 1, now);
    ins.run('Contradicts',   '#ef4444', 0, now);
  }

  // Seed default groups (only if empty)
  const groupCount = _db.prepare('SELECT COUNT(*) as n FROM groups').get();
  if (groupCount.n === 0) {
    const now = Math.floor(Date.now() / 1000);
    const ins = _db.prepare('INSERT INTO groups (name, color, created_at) VALUES (?,?,?)');
    ins.run('Technical',   '#6366f1', now);
    ins.run('Ideological', '#22c55e', now);
    ins.run('Historical',  '#f59e0b', now);
  }

  return _db;
}

// ── Helpers ───────────────────────────────────────────────────

export function getAllItems() {
  return getDb().prepare('SELECT * FROM items ORDER BY COALESCE(manual_year, enriched_year, year, year_fallback) ASC').all();
}

export function getItem(key) {
  return getDb().prepare('SELECT * FROM items WHERE key = ?').get(key);
}

export function upsertItem(item) {
  const db = getDb();
  const existing = getItem(item.key);
  if (existing) {
    // Only update scan fields — never touch manual overrides
    db.prepare(`
      UPDATE items SET
        filename=?, title=?, authors=?, year=?, year_fallback=?,
        type=?, ext=?, mtime=?, updated_at=strftime('%s','now')
      WHERE key=?
    `).run(item.filename, item.title, item.authors, item.year ?? null,
           item.yearFallback ?? null, item.type, item.ext, item.mtime ?? null,
           item.key);
  } else {
    db.prepare(`
      INSERT INTO items (key, filename, title, authors, year, year_fallback, type, ext, mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(item.key, item.filename, item.title, item.authors,
           item.year ?? null, item.yearFallback ?? null,
           item.type, item.ext, item.mtime ?? null);
  }
}

export function upsertEnrichment(key, { year, source, confidence, note }) {
  getDb().prepare(`
    UPDATE items SET enriched_year=?, enriched_source=?, enriched_conf=?, enriched_note=?,
      updated_at=strftime('%s','now')
    WHERE key=?
  `).run(year ?? null, source ?? null, confidence ?? null, note ?? null, key);
}

export function upsertManual(key, { year, title, authors, note }) {
  const db = getDb();
  // Only set fields that were actually provided
  const fields = [];
  const vals   = [];
  if (year    !== undefined) { fields.push('manual_year=?');    vals.push(year ?? null); }
  if (title   !== undefined) { fields.push('manual_title=?');   vals.push(title || null); }
  if (authors !== undefined) { fields.push('manual_authors=?'); vals.push(authors || null); }
  if (note    !== undefined) { fields.push('manual_note=?');    vals.push(note || null); }
  if (!fields.length) return;
  vals.push(key);
  db.prepare(`UPDATE items SET ${fields.join(', ')}, updated_at=strftime('%s','now') WHERE key=?`).run(...vals);
}

export function clearManual(key) {
  getDb().prepare(`
    UPDATE items SET manual_year=NULL, manual_title=NULL, manual_authors=NULL, manual_note=NULL,
      updated_at=strftime('%s','now')
    WHERE key=?
  `).run(key);
}

export function getMtimeMap() {
  const rows = getDb().prepare('SELECT key, mtime FROM items').all();
  const map = {};
  rows.forEach(r => { map[r.key] = r.mtime; });
  return map;
}

// ── Graph helpers ─────────────────────────────────────────────

export function getGraphState() {
  const db = getDb();
  const connectionTypes = db.prepare('SELECT * FROM connection_types ORDER BY id').all();
  const connections     = db.prepare('SELECT * FROM connections ORDER BY created_at DESC').all();
  const groups          = db.prepare('SELECT * FROM groups ORDER BY id').all();
  const giRows          = db.prepare('SELECT group_id, item_key FROM group_items').all();
  const posRows         = db.prepare('SELECT item_key, x, y FROM graph_positions').all();

  const groupItems = {};
  giRows.forEach(r => { (groupItems[r.group_id] = groupItems[r.group_id] || []).push(r.item_key); });

  const positions = {};
  posRows.forEach(r => { positions[r.item_key] = { x: r.x, y: r.y }; });

  return { connectionTypes, connections, groups, groupItems, positions };
}

export function savePositions(positions) {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare('INSERT OR REPLACE INTO graph_positions (item_key, x, y, updated_at) VALUES (?,?,?,?)');
  db.transaction(ps => ps.forEach(p => stmt.run(p.key, p.x, p.y, now)))(positions);
  return positions.length;
}

export function createConnection(sourceKey, targetKey, typeId, note) {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);
  const r   = db.prepare('INSERT INTO connections (source_key, target_key, type_id, note, created_at) VALUES (?,?,?,?,?)').run(sourceKey, targetKey, typeId, note || null, now);
  return db.prepare('SELECT * FROM connections WHERE id=?').get(r.lastInsertRowid);
}

export function updateConnection(id, { typeId, note }) {
  const db = getDb();
  const fields = [], vals = [];
  if (typeId !== undefined) { fields.push('type_id=?'); vals.push(typeId); }
  if (note   !== undefined) { fields.push('note=?');    vals.push(note || null); }
  if (fields.length) { vals.push(id); db.prepare(`UPDATE connections SET ${fields.join(',')} WHERE id=?`).run(...vals); }
  return db.prepare('SELECT * FROM connections WHERE id=?').get(id);
}

export function deleteConnection(id) {
  getDb().prepare('DELETE FROM connections WHERE id=?').run(id);
}

export function createConnectionType(name, color, directed) {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);
  const r   = db.prepare('INSERT INTO connection_types (name, color, directed, created_at) VALUES (?,?,?,?)').run(name, color, directed ? 1 : 0, now);
  return db.prepare('SELECT * FROM connection_types WHERE id=?').get(r.lastInsertRowid);
}

export function updateConnectionType(id, { name, color, directed }) {
  const db = getDb();
  const fields = [], vals = [];
  if (name     !== undefined) { fields.push('name=?');     vals.push(name); }
  if (color    !== undefined) { fields.push('color=?');    vals.push(color); }
  if (directed !== undefined) { fields.push('directed=?'); vals.push(directed ? 1 : 0); }
  if (fields.length) { vals.push(id); db.prepare(`UPDATE connection_types SET ${fields.join(',')} WHERE id=?`).run(...vals); }
  return db.prepare('SELECT * FROM connection_types WHERE id=?').get(id);
}

export function deleteConnectionType(id) {
  const db = getDb();
  const { n } = db.prepare('SELECT COUNT(*) as n FROM connections WHERE type_id=?').get(id);
  if (n > 0) return { error: 'Type is in use', count: n };
  db.prepare('DELETE FROM connection_types WHERE id=?').run(id);
  return { deleted: true };
}

export function createGroup(name, color, description) {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);
  const r   = db.prepare('INSERT INTO groups (name, color, description, created_at) VALUES (?,?,?,?)').run(name, color, description || null, now);
  return db.prepare('SELECT * FROM groups WHERE id=?').get(r.lastInsertRowid);
}

export function updateGroup(id, { name, color, description }) {
  const db = getDb();
  const fields = [], vals = [];
  if (name        !== undefined) { fields.push('name=?');        vals.push(name); }
  if (color       !== undefined) { fields.push('color=?');       vals.push(color); }
  if (description !== undefined) { fields.push('description=?'); vals.push(description || null); }
  if (fields.length) { vals.push(id); db.prepare(`UPDATE groups SET ${fields.join(',')} WHERE id=?`).run(...vals); }
  return db.prepare('SELECT * FROM groups WHERE id=?').get(id);
}

export function deleteGroup(id) {
  const db = getDb();
  db.prepare('DELETE FROM group_items WHERE group_id=?').run(id);
  db.prepare('DELETE FROM groups WHERE id=?').run(id);
}

export function addItemToGroup(groupId, itemKey) {
  getDb().prepare('INSERT OR IGNORE INTO group_items (group_id, item_key) VALUES (?,?)').run(groupId, itemKey);
}

export function removeItemFromGroup(groupId, itemKey) {
  getDb().prepare('DELETE FROM group_items WHERE group_id=? AND item_key=?').run(groupId, itemKey);
}

// ── Zotero collections helpers ────────────────────────────────

export function getZoteroCollections() {
  return getDb().prepare('SELECT * FROM zotero_collections ORDER BY name').all();
}

export function getZoteroItemCollections() {
  const rows = getDb().prepare('SELECT item_key, collection_key FROM zotero_item_collections').all();
  const map = {};
  rows.forEach(r => { (map[r.collection_key] = map[r.collection_key] || []).push(r.item_key); });
  return map;
}

export function replaceZoteroCollections(collections, itemCollections) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM zotero_item_collections').run();
    db.prepare('DELETE FROM zotero_collections').run();
    const insC  = db.prepare('INSERT OR REPLACE INTO zotero_collections (key, name, parent_key, color) VALUES (?,?,?,?)');
    collections.forEach(c => insC.run(c.key, c.name, c.parent_key || null, c.color));
    const insIC = db.prepare('INSERT OR REPLACE INTO zotero_item_collections (item_key, collection_key) VALUES (?,?)');
    itemCollections.forEach(ic => insIC.run(ic.item_key, ic.collection_key));
  })();
}

// ── Serialise a DB row into the shape the frontend expects ────
export function toFrontend(row) {
  return {
    key:        row.key,
    filename:   row.filename,
    title:      row.manual_title  || row.title,
    authors:    row.manual_authors || row.authors,
    year:       row.manual_year   ?? row.enriched_year ?? row.year ?? null,
    yearRaw:    row.year,
    yearFallback: row.year_fallback,
    type:       row.type,
    ext:        row.ext,
    mtime:      row.mtime,
    source:     row.manual_year != null ? 'manual'
              : row.enriched_year != null ? row.enriched_source
              : row.year != null ? 'filename'
              : row.year_fallback != null ? 'fallback'
              : null,
    confidence: row.manual_year != null ? 'high' : row.enriched_conf,
    note:       row.manual_note || row.enriched_note,
    hasManual:  row.manual_year != null || row.manual_title != null || row.manual_authors != null,
    coverUrl:   row.cover_url ?? null,
  };
}
