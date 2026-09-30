// Cloudflare Worker for a drawing tracker (moved from Netlify 2026-09-30).
// Serves the static site from the repo root and keeps the tracker's shared-state
// endpoint at the SAME path the page and the daily automation already use:
//
//   /.netlify/functions/sync             GET  -> { by, savedAt, state } (or {})
//                                        PUT  -> store a new { by, savedAt, state }
//   /.netlify/functions/sync?doc=notes   GET  -> { notes:[...], deleted:[ids], updatedAt }
//                                        POST -> { op:"add", note:{id,ts,tag,text,by} } | { op:"del", id }
//
// Storage is D1 (binding DB) instead of Netlify Blobs. Notes are merged server-side
// with a version check, retried on conflict, exactly like the Blobs etag version.
// The whole site sits behind Cloudflare Access (HCG sign-in); automation calls use an
// Access service token, so no request reaches this code without passing Access.

const SYNC_PATH = "/.netlify/functions/sync";
const STATE_KEY = "shared-state";
const NOTES_KEY = "shared-notes";

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS docs (key TEXT PRIMARY KEY, body TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL)"
  ).run();
  schemaReady = true;
}

async function readDoc(db, key) {
  const row = await db.prepare("SELECT body, version FROM docs WHERE key = ?1").bind(key).first();
  return row ? { data: JSON.parse(row.body), version: row.version } : { data: null, version: 0 };
}

// Write only if nobody else wrote since we read (version check). Returns true on success.
async function writeDoc(db, key, data, expectedVersion) {
  const body = JSON.stringify(data);
  const now = new Date().toISOString();
  if (expectedVersion === 0) {
    const r = await db.prepare(
      "INSERT INTO docs (key, body, version, updated_at) VALUES (?1, ?2, 1, ?3) ON CONFLICT(key) DO NOTHING"
    ).bind(key, body, now).run();
    return r.meta.changes === 1;
  }
  const r = await db.prepare(
    "UPDATE docs SET body = ?2, version = version + 1, updated_at = ?3 WHERE key = ?1 AND version = ?4"
  ).bind(key, body, now, expectedVersion).run();
  return r.meta.changes === 1;
}

async function stateDoc(req, db) {
  if (req.method === "GET") {
    const { data } = await readDoc(db, STATE_KEY);
    return json(data || {});
  }
  if (req.method === "PUT") {
    let payload;
    try { payload = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
    if (!payload || typeof payload !== "object" || !payload.state) return json({ error: "Missing 'state' field" }, 400);
    // Whole-document overwrite, same semantics as before (last writer wins).
    for (let i = 0; i < 5; i++) {
      const { version } = await readDoc(db, STATE_KEY);
      if (await writeDoc(db, STATE_KEY, payload, version)) return json({ ok: true });
    }
    return json({ error: "Busy - please retry" }, 409);
  }
  return json({ error: "Method not allowed" }, 405);
}

function normalizeNotes(d) {
  d = d || {};
  return {
    notes: Array.isArray(d.notes) ? d.notes : [],
    deleted: Array.isArray(d.deleted) ? d.deleted : [],
    updatedAt: d.updatedAt || 0,
  };
}

async function notesDoc(req, db) {
  if (req.method === "GET") return json(normalizeNotes((await readDoc(db, NOTES_KEY)).data));
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let op;
  try { op = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const isAdd = op && op.op === "add" && op.note && op.note.id && typeof op.note.text === "string";
  const isDel = op && op.op === "del" && op.id;
  // One-time migration helper: {op:"import", doc:{notes,deleted}} merges a whole notes document.
  const isImport = op && op.op === "import" && op.doc && Array.isArray(op.doc.notes);
  if (!isAdd && !isDel && !isImport) return json({ error: "Unknown op" }, 400);

  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, version } = await readDoc(db, NOTES_KEY);
    const doc = normalizeNotes(data);
    const addNote = (n) => {
      const id = String(n.id);
      if (!doc.notes.some((x) => x.id === id) && !doc.deleted.includes(id)) {
        doc.notes.push({
          id,
          ts: Number(n.ts) || Date.now(),
          tag: String(n.tag || ""),
          text: String(n.text).slice(0, 4000),
          by: String(n.by || "").slice(0, 80),
        });
      }
    };
    if (isAdd) addNote(op.note);
    else if (isDel) {
      const id = String(op.id);
      doc.notes = doc.notes.filter((x) => x.id !== id);
      if (!doc.deleted.includes(id)) doc.deleted.push(id);
    } else {
      for (const id of op.doc.deleted || []) if (!doc.deleted.includes(String(id))) doc.deleted.push(String(id));
      doc.notes = doc.notes.filter((x) => !doc.deleted.includes(x.id));
      for (const n of op.doc.notes) if (n && n.id && typeof n.text === "string") addNote(n);
    }
    doc.updatedAt = Date.now();
    if (await writeDoc(db, NOTES_KEY, doc, version)) return json({ ok: true, doc });
  }
  return json({ error: "Busy - please retry" }, 409);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === SYNC_PATH) {
      if (req.method === "OPTIONS") return new Response("", { status: 204 });
      if (!env.DB) return json({ error: "Storage not configured (D1 binding DB missing)" }, 500);
      try {
        await ensureSchema(env.DB);
        return url.searchParams.get("doc") === "notes" ? await notesDoc(req, env.DB) : await stateDoc(req, env.DB);
      } catch (err) {
        return json({ error: "Sync failed: " + err.message }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
