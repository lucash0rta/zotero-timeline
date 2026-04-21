import express from 'express';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Buffer } from 'buffer';
import { enrichItems } from './enrich.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env if present (no external dependency needed in Node 20+) ─────────
if (existsSync(join(__dirname, '.env'))) {
  const raw = readFileSync(join(__dirname, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// ── Config ────────────────────────────────────────────────────
const WEBDAV_BASE = process.env.WEBDAV_BASE;
const WEBDAV_USER = process.env.WEBDAV_USER;
const WEBDAV_PASS = process.env.WEBDAV_PASS;
const PORT        = parseInt(process.env.PORT || '3001', 10);
const CONCURRENCY = 8;

if (!WEBDAV_BASE || !WEBDAV_USER || !WEBDAV_PASS) {
  console.error('\nMissing required environment variables. Copy .env.example to .env and fill it in.\n');
  process.exit(1);
}

const CACHE_FILE   = join(__dirname, 'items-cache.json');
const ENRICH_FILE  = join(__dirname, 'items-enriched.json');

// ── Auth header ───────────────────────────────────────────────
const AUTH = 'Basic ' + Buffer.from(`${WEBDAV_USER}:${WEBDAV_PASS}`).toString('base64');

// ── Filename parsing ──────────────────────────────────────────
const EXT_TYPE = {
  pdf: 'PDF', epub: 'Ebook', mobi: 'Ebook', azw: 'Ebook', azw3: 'Ebook',
  html: 'Webpage', htm: 'Webpage',
  mp3: 'Audio', m4a: 'Audio', ogg: 'Audio', flac: 'Audio', wav: 'Audio',
  mp4: 'Video', mkv: 'Video', mov: 'Video', avi: 'Video',
  doc: 'Document', docx: 'Document', odt: 'Document',
  ppt: 'Presentation', pptx: 'Presentation', odp: 'Presentation',
  txt: 'Text', md: 'Text',
  jpg: 'Image', jpeg: 'Image', png: 'Image', gif: 'Image', tiff: 'Image',
};

function parseFilename(filename) {
  const lastDot = filename.lastIndexOf('.');
  const ext     = lastDot >= 0 ? filename.slice(lastDot + 1).toLowerCase() : '';
  const base    = lastDot >= 0 ? filename.slice(0, lastDot) : filename;
  const type    = EXT_TYPE[ext] || 'File';

  // Pattern 1: "Author(s) - YYYY - Title"
  const m1 = base.match(/^(.+?)\s+-\s+(\d{4})\s+-\s+(.+)$/);
  if (m1) {
    return { title: m1[3].trim(), authors: m1[1].trim(), year: parseInt(m1[2], 10), type, ext };
  }

  // Pattern 2: "Author(s) - Title" (no year)
  const m2 = base.match(/^([A-Za-zÀ-ÿ].+?)\s+-\s+(.+)$/);
  if (m2) {
    return { title: m2[2].trim(), authors: m2[1].trim(), year: null, type, ext };
  }

  // Fallback: just use the whole base as title
  return { title: base, authors: '', year: null, type, ext };
}

function parseZipFilename(buf) {
  // ZIP local file header: sig(4) + misc(22) + fname_len(2) + extra_len(2) + fname
  if (buf.length < 30) return null;
  if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) return null;
  const fnameLen = buf.readUInt16LE(26);
  if (buf.length < 30 + fnameLen) return null;
  return buf.slice(30, 30 + fnameLen).toString('utf8');
}

function parsePropMtime(xml) {
  const m = xml.match(/<mtime>(\d+)<\/mtime>/);
  return m ? parseInt(m[1], 10) : null;
}

// ── WebDAV helpers ────────────────────────────────────────────
async function propfind() {
  const res = await fetch(WEBDAV_BASE + '/', {
    method: 'PROPFIND',
    headers: { 'Authorization': AUTH, 'Depth': '1' },
  });
  if (!res.ok) throw new Error(`PROPFIND failed: ${res.status}`);
  const xml = await res.text();
  const keys = [...xml.matchAll(/([A-Z0-9]{8})\.zip/g)].map(m => m[1]);
  return [...new Set(keys)];
}

async function fetchZipHeader(key) {
  const res = await fetch(`${WEBDAV_BASE}/${key}.zip`, {
    headers: { 'Authorization': AUTH, 'Range': 'bytes=0-511' },
  });
  // accept 206 (partial) or 200 (server ignored range)
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return parseZipFilename(buf);
}

async function fetchProp(key) {
  const res = await fetch(`${WEBDAV_BASE}/${key}.prop`, {
    headers: { 'Authorization': AUTH },
  });
  if (!res.ok) return null;
  return parsePropMtime(await res.text());
}

// ── Concurrency pool ──────────────────────────────────────────
async function pool(tasks, concurrency, fn) {
  const results = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try { results[i] = await fn(tasks[i], i); }
      catch(e) { results[i] = { error: e.message }; }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Main scan ─────────────────────────────────────────────────
async function scanLibrary(onProgress) {
  onProgress({ stage: 'listing', done: 0, total: 0 });
  const keys = await propfind();
  onProgress({ stage: 'scanning', done: 0, total: keys.length });

  let done = 0;
  const items = await pool(keys, CONCURRENCY, async (key) => {
    const [filename, mtime] = await Promise.all([fetchZipHeader(key), fetchProp(key)]);
    done++;
    onProgress({ stage: 'scanning', done, total: keys.length });

    const parsed = filename ? parseFilename(filename) : null;
    const yearFromMtime = mtime ? new Date(mtime).getFullYear() : null;

    return {
      key,
      filename:  filename || key,
      title:     parsed?.title  || filename || key,
      authors:   parsed?.authors || '',
      year:      parsed?.year   || null,
      yearFallback: yearFromMtime,
      type:      parsed?.type   || 'File',
      ext:       parsed?.ext    || '',
      mtime,
    };
  });

  return items.filter(i => !i.error);
}

// ── Express app ───────────────────────────────────────────────
const app = express();
app.use(express.static(__dirname));

// SSE progress + final data
app.get('/api/scan', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const items = await scanLibrary(progress => send('progress', progress));
    writeFileSync(CACHE_FILE, JSON.stringify(items));
    send('done', items);
    res.end();
  } catch(e) {
    send('error', { message: e.message });
    res.end();
  }
});

// Serve cached data or trigger scan
app.get('/api/items', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (existsSync(CACHE_FILE)) {
    res.json(JSON.parse(readFileSync(CACHE_FILE, 'utf8')));
  } else {
    res.status(404).json({ error: 'No cache yet. Use /api/scan first.' });
  }
});

app.delete('/api/cache', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (existsSync(CACHE_FILE))  unlinkSync(CACHE_FILE);
  if (existsSync(ENRICH_FILE)) unlinkSync(ENRICH_FILE);
  res.json({ ok: true });
});

// Serve enrichment data if it exists
app.get('/api/enriched', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (existsSync(ENRICH_FILE)) {
    res.json(JSON.parse(readFileSync(ENRICH_FILE, 'utf8')));
  } else {
    res.json({});
  }
});

// Run enrichment pipeline via SSE
app.get('/api/enrich', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const claudeKey = req.query.claude_key || null;

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  if (!existsSync(CACHE_FILE)) {
    send('error', { message: 'No item cache. Run a library scan first.' });
    return res.end();
  }

  const items = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));

  try {
    send('progress', { stage: 'apis', done: 0, total: items.filter(i => i.type !== 'Webpage').length });

    const enriched = await enrichItems(items, {
      claudeKey,
      concurrency: 6,
      onProgress: p => send('progress', p),
    });

    writeFileSync(ENRICH_FILE, JSON.stringify(enriched));
    send('done', enriched);
    res.end();
  } catch(e) {
    send('error', { message: e.message });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n  Zotero Timeline server running at http://localhost:${PORT}\n`);
  console.log(`  Open http://localhost:${PORT} in your browser.\n`);
});
