/**
 * Date enrichment pipeline.
 * Stage 1: CrossRef  (PDFs / journal articles)
 * Stage 2: OpenLibrary (books / ebooks)
 * Stage 3: Claude API  (fallback for anything unmatched or suspicious)
 */

// ── String helpers ────────────────────────────────────────────
function normalise(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordSet(s) {
  return new Set(normalise(s).split(' ').filter(w => w.length > 2));
}

function jaccardSim(a, b) {
  const wa = wordSet(a), wb = wordSet(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  const inter = [...wa].filter(w => wb.has(w)).length;
  return inter / (wa.size + wb.size - inter);
}

// ── CrossRef ──────────────────────────────────────────────────
async function queryCrossRef(title, authors) {
  const q = encodeURIComponent(title.slice(0, 120));
  const a = encodeURIComponent((authors || '').split(/[,;]/)[0].trim().slice(0, 60));
  const url = `https://api.crossref.org/works?query.title=${q}${a ? '&query.author=' + a : ''}&rows=3&select=title,author,published,score`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ZoteroTimeline/1.0 (mailto:user@localhost)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data?.message?.items || [];

    for (const item of items) {
      const apiTitle  = (item.title || [''])[0];
      const sim       = jaccardSim(title, apiTitle);
      const score     = item.score || 0;
      const yearParts = item.published?.['date-parts']?.[0];
      const year      = yearParts?.[0];

      if (sim >= 0.35 && score >= 20 && year) {
        return { year, source: 'crossref', confidence: sim >= 0.6 ? 'high' : 'medium', matchedTitle: apiTitle };
      }
    }
  } catch (_) { /* timeout or network */ }
  return null;
}

// ── OpenLibrary ───────────────────────────────────────────────
async function queryOpenLibrary(title, authors) {
  const q = encodeURIComponent(title.slice(0, 120));
  const a = encodeURIComponent((authors || '').split(/[,;]/)[0].trim().slice(0, 60));
  const url = `https://openlibrary.org/search.json?title=${q}${a ? '&author=' + a : ''}&limit=3&fields=title,author_name,first_publish_year`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const docs  = data?.docs || [];

    for (const doc of docs) {
      const apiTitle = doc.title || '';
      const sim      = jaccardSim(title, apiTitle);
      const year     = doc.first_publish_year;

      if (sim >= 0.35 && year) {
        return { year, source: 'openlibrary', confidence: sim >= 0.6 ? 'high' : 'medium', matchedTitle: apiTitle };
      }
    }
  } catch (_) { /* timeout or network */ }
  return null;
}

// ── Claude API fallback ───────────────────────────────────────
export async function enrichWithClaude(items, apiKey) {
  if (!apiKey || items.length === 0) return [];

  // Batch up to 20 items per request
  const batches = [];
  for (let i = 0; i < items.length; i += 20) batches.push(items.slice(i, i + 20));

  const results = [];
  for (const batch of batches) {
    const list = batch.map((item, i) =>
      `${i + 1}. Title: "${item.title}", Author(s): "${item.authors || 'unknown'}", Detected year: ${item.year || 'unknown'}`
    ).join('\n');

    const prompt = `You are a research librarian. For each work below, provide the ORIGINAL publication year (not reprint, translation, or edition dates).

${list}

Respond with ONLY a JSON array, one object per work, in the same order:
[{"index":1,"original_year":YYYY,"confidence":"high|medium|low","note":"brief reason if year changed"}]

Rules:
- original_year: integer year, or null if genuinely unknown
- confidence: "high" if you're certain, "medium" if educated guess, "low" if very uncertain
- Only include a "note" if the year differs from the detected year or is unknown`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Claude API ${res.status}: ${err.slice(0, 120)}`);
      }

      const data = await res.json();
      const text = data.content?.[0]?.text || '';

      // Extract JSON array from response
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('No JSON array in Claude response');
      const parsed = JSON.parse(match[0]);

      parsed.forEach(r => {
        const item = batch[r.index - 1];
        if (item && r.original_year) {
          results.push({
            key: item.key,
            year: r.original_year,
            source: 'claude',
            confidence: r.confidence || 'medium',
            note: r.note || null,
          });
        }
      });
    } catch(e) {
      console.error('Claude batch failed:', e.message);
    }
  }
  return results;
}

// ── Main enrichment function ──────────────────────────────────
export async function enrichItems(items, { claudeKey, onProgress, concurrency = 6 } = {}) {
  const results = {};   // key → enrichment result

  // Only enrich non-webpage items (webpage access dates are correct)
  const toEnrich = items.filter(i => i.type !== 'Webpage');

  let done = 0;
  onProgress?.({ done: 0, total: toEnrich.length, stage: 'apis' });

  // Run CrossRef + OpenLibrary in parallel pool
  async function enrichOne(item) {
    let result = null;

    if (item.type === 'PDF') {
      // PDFs: try CrossRef first, then OpenLibrary
      result = await queryCrossRef(item.title, item.authors);
      if (!result) result = await queryOpenLibrary(item.title, item.authors);
    } else {
      // Ebooks/documents: try OpenLibrary first, then CrossRef
      result = await queryOpenLibrary(item.title, item.authors);
      if (!result) result = await queryCrossRef(item.title, item.authors);
    }

    done++;
    onProgress?.({ done, total: toEnrich.length, stage: 'apis' });
    return { key: item.key, result };
  }

  // Concurrency pool
  const apiResults = await pool(toEnrich, concurrency, enrichOne);
  apiResults.forEach(({ key, result }) => {
    if (result) results[key] = result;
  });

  // Stage 2: Claude for unmatched or suspicious items
  if (claudeKey) {
    const needClaude = toEnrich.filter(item => {
      const r = results[item.key];
      // Send to Claude if: no API match, OR confidence is only "medium" and year looks like a reprint
      if (!r) return true;
      if (r.confidence === 'medium') return true;
      return false;
    });

    if (needClaude.length > 0) {
      onProgress?.({ done: 0, total: needClaude.length, stage: 'claude' });
      const claudeResults = await enrichWithClaude(needClaude, claudeKey);
      claudeResults.forEach(r => {
        // Only use Claude result if APIs didn't give a high-confidence match
        const existing = results[r.key];
        if (!existing || existing.confidence !== 'high') {
          results[r.key] = r;
        }
      });
      onProgress?.({ done: needClaude.length, total: needClaude.length, stage: 'claude' });
    }
  }

  return results;
}

// ── Concurrency pool ──────────────────────────────────────────
async function pool(tasks, concurrency, fn) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try { results[i] = await fn(tasks[i], i); }
      catch(e) { results[i] = { key: tasks[i]?.key, result: null }; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
