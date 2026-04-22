import express from 'express';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { writeFile, unlink, rename } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { Buffer } from 'buffer';
import { createHmac, timingSafeEqual } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { inflateRawSync } from 'zlib';
import { getDb, getAllItems, getItem, upsertItem, upsertEnrichment, upsertManual, clearManual, getMtimeMap, toFrontend } from './db.js';
import { enrichItems } from './enrich.js';

const execAsync = promisify(exec);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREVIEWS_DIR = join(__dirname, 'previews');
if (!existsSync(PREVIEWS_DIR)) mkdirSync(PREVIEWS_DIR);

// ── Load .env ─────────────────────────────────────────────────
if (existsSync(join(__dirname, '.env'))) {
  const raw = readFileSync(join(__dirname, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// ── Config ────────────────────────────────────────────────────
const WEBDAV_BASE    = process.env.WEBDAV_BASE;
const WEBDAV_USER    = process.env.WEBDAV_USER;
const WEBDAV_PASS    = process.env.WEBDAV_PASS;
const PORT           = parseInt(process.env.PORT || '3001', 10);
const APP_USER       = process.env.APP_USER;
const APP_PASS       = process.env.APP_PASS;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const PM2_APP_NAME   = process.env.PM2_APP_NAME || 'zotero-timeline';
const CONCURRENCY    = 8;

if (!WEBDAV_BASE || !WEBDAV_USER || !WEBDAV_PASS) {
  console.error('\nMissing required env vars. Copy .env.example → .env and fill it in.\n');
  process.exit(1);
}

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
  jpg: 'Image', jpeg: 'Image', png: 'Image', tiff: 'Image',
};

function parseFilename(filename) {
  const lastDot = filename.lastIndexOf('.');
  const ext  = lastDot >= 0 ? filename.slice(lastDot + 1).toLowerCase() : '';
  const base = lastDot >= 0 ? filename.slice(0, lastDot) : filename;
  const type = EXT_TYPE[ext] || 'File';

  const m1 = base.match(/^(.+?)\s+-\s+(\d{4})\s+-\s+(.+)$/);
  if (m1) return { title: m1[3].trim(), authors: m1[1].trim(), year: parseInt(m1[2], 10), type, ext };

  const m2 = base.match(/^([A-Za-zÀ-ÿ].+?)\s+-\s+(.+)$/);
  if (m2) return { title: m2[2].trim(), authors: m2[1].trim(), year: null, type, ext };

  return { title: base, authors: '', year: null, type, ext };
}

function parseZipFilename(buf) {
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

// ── HTML metadata extraction ──────────────────────────────────
function extractFromHTML(html) {
  const result = {};

  // Title from <title> tag
  const titleM = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
  if (titleM) result.htmlTitle = titleM[1].replace(/\s+/g, ' ').trim();

  // Published date — try multiple patterns
  const dateSources = [
    html.match(/<meta[^>]+property="article:published_time"[^>]+content="([^"]+)"/i),
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="article:published_time"/i),
    html.match(/<meta[^>]+name="(?:date|pubdate|publish[_-]?date)"[^>]+content="([^"]+)"/i),
    html.match(/<meta[^>]+content="([^"]+)"[^>]+name="(?:date|pubdate)"/i),
    html.match(/<time[^>]+datetime="([^"]+)"/i),
  ];
  for (const m of dateSources) {
    if (m?.[1]) { result.dateStr = m[1]; break; }
  }

  // JSON-LD structured data
  const jsonLDMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const jm of jsonLDMatches) {
    try {
      const data = JSON.parse(jm[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (!result.dateStr && (item.datePublished || item.dateCreated)) {
          result.dateStr = item.datePublished || item.dateCreated;
        }
        if (!result.description && item.description) {
          result.description = String(item.description).slice(0, 600);
        }
      }
    } catch { /* malformed JSON-LD */ }
  }

  // Site name
  const siteM = html.match(/<meta[^>]+property="og:site_name"[^>]+content="([^"]+)"/i)
             || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:site_name"/i);
  if (siteM) result.siteName = siteM[1];

  // Description
  if (!result.description) {
    const descM = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)
               || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:description"/i)
               || html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)
               || html.match(/<meta[^>]+content="([^"]+)"[^>]+name="description"/i);
    if (descM) result.description = descM[1].slice(0, 600);
  }

  // Author
  const authorM = html.match(/<meta[^>]+name="author"[^>]+content="([^"]+)"/i)
               || html.match(/<meta[^>]+property="article:author"[^>]+content="([^"]+)"/i);
  if (authorM) result.htmlAuthor = authorM[1];

  // og:image for webpage cover
  const imgM = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
            || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
  if (imgM?.[1]?.startsWith('http')) result.coverUrl = imgM[1];

  // Extract year from dateStr
  if (result.dateStr) {
    const ym = result.dateStr.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
    if (ym) result.year = parseInt(ym[1], 10);
  }

  return result;
}

// ── Fetch + extract full HTML from zip ────────────────────────
async function fetchHTMLContent(key) {
  try {
    const res = await fetch(`${WEBDAV_BASE}/${key}.zip`, {
      headers: { 'Authorization': AUTH },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;

    const zipBuf = Buffer.from(await res.arrayBuffer());
    // Find the HTML file inside the zip by scanning local file headers
    let offset = 0;
    while (offset + 30 < zipBuf.length) {
      if (zipBuf.readUInt32LE(offset) !== 0x04034b50) break;
      const fnameLen   = zipBuf.readUInt16LE(offset + 26);
      const extraLen   = zipBuf.readUInt16LE(offset + 28);
      const fname      = zipBuf.slice(offset + 30, offset + 30 + fnameLen).toString('utf8');
      const compMethod = zipBuf.readUInt16LE(offset + 8);
      const compSize   = zipBuf.readUInt32LE(offset + 18);
      const dataStart  = offset + 30 + fnameLen + extraLen;

      if (fname.match(/\.(html?)/i) && compMethod === 0) {
        // Stored (uncompressed) — read directly
        const html = zipBuf.slice(dataStart, dataStart + compSize).toString('utf8', 0, 200000);
        return extractFromHTML(html);
      }
      offset = dataStart + compSize;
    }
  } catch { /* timeout or parse error */ }
  return null;
}

// ── WebDAV ────────────────────────────────────────────────────
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
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseZipFilename(Buffer.from(await res.arrayBuffer()));
}

async function fetchProp(key) {
  const res = await fetch(`${WEBDAV_BASE}/${key}.prop`, {
    headers: { 'Authorization': AUTH },
    signal: AbortSignal.timeout(5000),
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
      try { results[i] = await fn(tasks[i]); }
      catch(e) { results[i] = { error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Incremental scan ──────────────────────────────────────────
async function scanLibrary(onProgress) {
  onProgress({ stage: 'listing', done: 0, total: 0 });
  const allKeys    = await propfind();
  const storedMtimes = getMtimeMap();

  // Fetch mtimes for all keys to find what's new/changed
  onProgress({ stage: 'checking', done: 0, total: allKeys.length });
  let checked = 0;
  const mtimes = await pool(allKeys, CONCURRENCY, async key => {
    const mtime = await fetchProp(key);
    checked++;
    onProgress({ stage: 'checking', done: checked, total: allKeys.length });
    return { key, mtime };
  });

  const toProcess = mtimes.filter(({ key, mtime }) =>
    !(key in storedMtimes) || storedMtimes[key] !== mtime
  );
  const unchanged = allKeys.length - toProcess.length;

  onProgress({ stage: 'scanning', done: 0, total: toProcess.length, unchanged });

  let done = 0;
  await pool(toProcess, CONCURRENCY, async ({ key, mtime }) => {
    const filename = await fetchZipHeader(key);
    const parsed   = filename ? parseFilename(filename) : null;
    const yearFromMtime = mtime ? new Date(mtime).getFullYear() : null;

    const item = {
      key,
      filename:    filename || key,
      title:       parsed?.title   || filename || key,
      authors:     parsed?.authors || '',
      year:        parsed?.year    ?? null,
      yearFallback: yearFromMtime,
      type:        parsed?.type    || 'File',
      ext:         parsed?.ext     || '',
      mtime,
    };

    upsertItem(item);

    // For webpage items with no year, try extracting from HTML content
    if (item.type === 'Webpage' && !item.year) {
      const htmlMeta = await fetchHTMLContent(key).catch(() => null);
      if (htmlMeta) {
        const db = getDb();
        db.prepare(`UPDATE items SET
          enriched_year=?, enriched_source='html', enriched_conf='high',
          enriched_note=?,
          title = CASE WHEN title=? OR title=? THEN ? ELSE title END,
          updated_at=strftime('%s','now')
          WHERE key=?`
        ).run(
          htmlMeta.year ?? null,
          htmlMeta.siteName ? `Via ${htmlMeta.siteName}` : null,
          filename || key, key,
          htmlMeta.htmlTitle || item.title,
          key
        );
        if (htmlMeta.description || htmlMeta.siteName || htmlMeta.coverUrl) {
          db.prepare(`UPDATE items SET description=?, site_name=?, cover_url=COALESCE(cover_url,?) WHERE key=?`)
            .run(htmlMeta.description ?? null, htmlMeta.siteName ?? null, htmlMeta.coverUrl ?? null, key);
        }
      }
    }

    done++;
    onProgress({ stage: 'scanning', done, total: toProcess.length, unchanged });
  });

  // Remove deleted keys from DB
  const allKeysSet = new Set(allKeys);
  const db = getDb();
  db.prepare('SELECT key FROM items').all()
    .filter(r => !allKeysSet.has(r.key))
    .forEach(r => db.prepare('DELETE FROM items WHERE key=?').run(r.key));

  return getAllItems().map(toFrontend);
}

// ── Express app ───────────────────────────────────────────────
const app = express();

// ── GitHub webhook ────────────────────────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (WEBHOOK_SECRET) {
    const sig  = req.headers['x-hub-signature-256'] || '';
    const hmac = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(req.body).digest('hex');
    try {
      if (!timingSafeEqual(Buffer.from(sig), Buffer.from(hmac)))
        return res.status(401).json({ error: 'Bad signature' });
    } catch { return res.status(401).json({ error: 'Bad signature' }); }
  }

  const payload = JSON.parse(req.body);
  if (payload.ref !== 'refs/heads/main')
    return res.json({ ok: true, skipped: 'not main branch' });

  res.json({ ok: true, message: 'Deploying…' });
  console.log('[webhook] Pull triggered');

  exec('git pull && npm install --omit=dev', { cwd: __dirname }, (err, stdout) => {
    if (err) { console.error('[webhook] pull failed'); return; }
    console.log('[webhook] pulled, restarting…');
    exec(`pm2 restart ${PM2_APP_NAME}`);
  });
});

// ── HTTP basic auth ───────────────────────────────────────────
if (APP_USER && APP_PASS) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Basic ')) {
      const [u, p] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      if (u === APP_USER && p === APP_PASS) return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Zotero Timeline"');
    res.status(401).send('Authentication required');
  });
}

app.use(express.static(__dirname));
app.use(express.json());

// ── API: items ────────────────────────────────────────────────
app.get('/api/items', (req, res) => {
  try {
    res.json(getAllItems().map(toFrontend));
  } catch {
    res.status(404).json({ error: 'No data yet — run a scan first.' });
  }
});

// ── API: scan (SSE, incremental) ──────────────────────────────
app.get('/api/scan', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const items = await scanLibrary(p => send('progress', p));
    send('done', items);
    res.end();
  } catch(e) {
    send('error', { message: e.message });
    res.end();
  }
});

// ── API: enrich (SSE) ─────────────────────────────────────────
app.get('/api/enrich', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  const claudeKey = req.query.claude_key || null;

  const rawItems = getAllItems().map(toFrontend);
  if (!rawItems.length) {
    send('error', { message: 'No items in DB — run a scan first.' });
    return res.end();
  }

  try {
    const enrichedMap = await enrichItems(rawItems, {
      claudeKey,
      concurrency: 6,
      onProgress: p => send('progress', p),
    });

    Object.entries(enrichedMap).forEach(([key, r]) => {
      upsertEnrichment(key, { year: r.year, source: r.source, confidence: r.confidence, note: r.note });
    });

    send('done', getAllItems().map(toFrontend));
    res.end();
  } catch(e) {
    send('error', { message: e.message });
    res.end();
  }
});

// ── Local preview generation ──────────────────────────────────

// Extract a single entry from a ZIP buffer (handles stored + deflate)
function extractZipEntry(buf, matchFn) {
  let offset = 0;
  while (offset + 30 < buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const method     = buf.readUInt16LE(offset + 8);
    const compSize   = buf.readUInt32LE(offset + 18);
    const fnameLen   = buf.readUInt16LE(offset + 26);
    const extraLen   = buf.readUInt16LE(offset + 28);
    const fname      = buf.slice(offset + 30, offset + 30 + fnameLen).toString('utf8');
    const dataStart  = offset + 30 + fnameLen + extraLen;
    const compData   = buf.slice(dataStart, dataStart + compSize);
    if (matchFn(fname)) {
      try {
        const data = method === 0 ? compData : inflateRawSync(compData);
        return { fname, data };
      } catch { /* corrupt entry */ }
    }
    offset = dataStart + compSize;
  }
  return null;
}

// Walk all entries in a ZIP buffer
function* zipEntries(buf) {
  let offset = 0;
  while (offset + 30 < buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const method   = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const fnameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const fname    = buf.slice(offset + 30, offset + 30 + fnameLen).toString('utf8');
    const dataStart = offset + 30 + fnameLen + extraLen;
    yield { fname, method, compSize, dataStart };
    offset = dataStart + compSize;
  }
}

async function generatePreview(key, type) {
  const outPath = join(PREVIEWS_DIR, `${key}.jpg`);
  if (existsSync(outPath)) return outPath;

  const res = await fetch(`${WEBDAV_BASE}/${key}.zip`, {
    headers: { 'Authorization': AUTH },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) return null;
  const zipBuf = Buffer.from(await res.arrayBuffer());

  // ── EPUB: extract cover image from inside the epub (which is also a zip)
  if (type === 'Ebook') {
    const epubEntry = extractZipEntry(zipBuf, f => /\.epub$/i.test(f));
    if (!epubEntry) return null;
    const epubBuf = epubEntry.data;

    // Priority: file named cover.*, then any image in cover/ or images/, then first image
    const isImage = f => /\.(jpe?g|png|webp)$/i.test(f);
    const coverEntry =
      extractZipEntry(epubBuf, f => isImage(f) && /\bcover\b/i.test(f)) ||
      extractZipEntry(epubBuf, f => isImage(f) && /\b(cover|images?)\b/i.test(f)) ||
      extractZipEntry(epubBuf, f => isImage(f));
    if (!coverEntry) return null;
    await writeFile(outPath, coverEntry.data);
    return outPath;
  }

  // ── PDF: extract to temp, shell out to pdftoppm or ghostscript
  if (type === 'PDF') {
    const pdfEntry = extractZipEntry(zipBuf, f => /\.pdf$/i.test(f));
    if (!pdfEntry) return null;
    const tmpPdf = join(tmpdir(), `zt_${key}.pdf`);
    const tmpBase = join(tmpdir(), `zt_${key}_p`);
    await writeFile(tmpPdf, pdfEntry.data);
    try {
      // Try pdftoppm (poppler-utils)
      await execAsync(`pdftoppm -r 96 -f 1 -l 1 -jpeg -jpegopt quality=70 "${tmpPdf}" "${tmpBase}"`);
      for (const suffix of ['-1.jpg', '-01.jpg', '-001.jpg']) {
        if (existsSync(tmpBase + suffix)) {
          await rename(tmpBase + suffix, outPath);
          return outPath;
        }
      }
      // Try ghostscript fallback
      await execAsync(`gs -dNOPAUSE -dBATCH -sDEVICE=jpeg -r96 -dJPEGQ=70 -dFirstPage=1 -dLastPage=1 -sOutputFile="${outPath}" "${tmpPdf}"`);
      if (existsSync(outPath)) return outPath;
    } catch { /* tools not installed */ }
    finally { unlink(tmpPdf).catch(() => {}); }
    return null;
  }

  return null;
}

// On-demand preview endpoint — generates + caches on first request
app.get('/api/preview/:key', async (req, res) => {
  const { key } = req.params;
  if (!/^[A-Z0-9]{8}$/.test(key)) return res.status(400).end();
  const item = getItem(key);
  if (!item) return res.status(404).end();
  try {
    const path = await generatePreview(key, item.type);
    if (!path) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path);
  } catch (e) {
    res.status(500).end();
  }
});

// ── API: manual override ──────────────────────────────────────
app.patch('/api/items/:key', (req, res) => {
  const { year, title, authors, note } = req.body;
  const item = getItem(req.params.key);
  if (!item) return res.status(404).json({ error: 'Not found' });
  upsertManual(req.params.key, {
    year:    year    !== undefined ? (year === '' ? null : parseInt(year, 10) || null) : undefined,
    title:   title   !== undefined ? title   : undefined,
    authors: authors !== undefined ? authors : undefined,
    note:    note    !== undefined ? note    : undefined,
  });
  res.json(toFrontend(getItem(req.params.key)));
});

app.delete('/api/items/:key/manual', (req, res) => {
  clearManual(req.params.key);
  res.json(toFrontend(getItem(req.params.key)));
});

// ── API: full row for detail panel ────────────────────────────
app.get('/api/items/:key', (req, res) => {
  const row = getItem(req.params.key);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const db = getDb();
  // Pull description/site_name if they exist
  const ext = db.prepare('SELECT description, site_name, cover_url FROM items WHERE key=?').get(req.params.key);
  res.json({ ...toFrontend(row), description: ext?.description, siteName: ext?.site_name, coverUrl: ext?.cover_url });
});

app.listen(PORT, () => {
  console.log(`\n  Zotero Timeline running at http://localhost:${PORT}\n`);
});
