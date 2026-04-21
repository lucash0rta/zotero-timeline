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
  `);

  // Run migrations for existing databases
  try { _db.exec(`ALTER TABLE items ADD COLUMN description TEXT`); } catch {}
  try { _db.exec(`ALTER TABLE items ADD COLUMN site_name TEXT`); } catch {}

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

// Serialise a DB row into the shape the frontend expects
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
  };
}
