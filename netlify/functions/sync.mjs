// Shared-state endpoint for the Nova102 tracker's built-in "Share / sync" feature.
// GET  -> returns the last pushed { by, savedAt, state } (or {} if nobody has pushed yet)
// PUT  -> stores a new { by, savedAt, state } payload, overwriting whatever was there
//
// Backed by Netlify Blobs, which needs no separate account or API key when this
// function runs on Netlify itself — getStore() picks up the site's own credentials
// automatically. Data lives in the "nova102-tracker" store under a single key, so
// everyone who has this site's URL (and therefore this function's URL) can read and
// write it. There is no authentication — anyone with the link can overwrite the
// shared state. That matches the tracker itself (no login anywhere), but is worth
// knowing before treating this as anything more than an internal, trusted hand-off.
//
// This is written as a modern ("v2") Netlify Function — a plain Request in, Response
// out, no connectLambda() — on purpose: that's the only function shape Netlify hands
// an "uncachedEdgeURL" to, and Netlify Blobs needs that value to offer "strong"
// (read-your-own-write) consistency. The older exports.handler=... shape never
// receives it, so asking for strong consistency there fails at request time with
// "the environment has not been configured with a 'uncachedEdgeURL' property" —
// which is what the first version of this function hit in testing.

import { getStore } from "@netlify/blobs";

const STORE_NAME = "nova102-tracker";
const KEY = "shared-state";
// Shared notes live in their own document so every viewer can add/remove notes without
// overwriting anyone else's edits (David, 2026-09-22). Opened with ?doc=notes:
//   GET  -> { notes:[...], deleted:[ids], updatedAt }
//   POST -> { op:"add", note:{id,ts,tag,text,by} } or { op:"del", id }  (merged server-side)
const NOTES_KEY = "shared-notes";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: CORS_HEADERS });
  }

  let store;
  try {
    // "strong" consistency trades a little speed for a guarantee that a GET right
    // after a PUT (exactly the push-then-pull pattern this endpoint exists for)
    // sees that write immediately, instead of Blobs' default eventually-consistent
    // edge caching, which could hand a puller a stale value for a few seconds.
    store = getStore({ name: STORE_NAME, consistency: "strong" });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Blob store unavailable: " + err.message }), {
      status: 500,
      headers: CORS_HEADERS,
    });
  }

  if (new URL(req.url).searchParams.get("doc") === "notes") {
    return notesDoc(req, store);
  }

  if (req.method === "GET") {
    try {
      const data = await store.get(KEY, { type: "json" });
      return new Response(JSON.stringify(data || {}), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Read failed: " + err.message }), {
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  }

  if (req.method === "PUT") {
    let payload;
    try {
      payload = await req.json();
    } catch (err) {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }
    if (!payload || typeof payload !== "object" || !payload.state) {
      return new Response(JSON.stringify({ error: "Missing 'state' field" }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }
    try {
      await store.setJSON(KEY, payload);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Write failed: " + err.message }), {
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: CORS_HEADERS,
  });
};

export const config = {
  path: "/.netlify/functions/sync",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function readNotes(store) {
  const got = await store.getWithMetadata(NOTES_KEY, { type: "json" });
  const doc = (got && got.data) || {};
  return {
    etag: got ? got.etag : null,
    doc: {
      notes: Array.isArray(doc.notes) ? doc.notes : [],
      deleted: Array.isArray(doc.deleted) ? doc.deleted : [],
      updatedAt: doc.updatedAt || 0,
    },
  };
}

async function notesDoc(req, store) {
  try {
    if (req.method === "GET") return json((await readNotes(store)).doc);
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let op;
    try { op = await req.json(); } catch (err) { return json({ error: "Invalid JSON body" }, 400); }
    const isAdd = op && op.op === "add" && op.note && op.note.id && typeof op.note.text === "string";
    const isDel = op && op.op === "del" && op.id;
    if (!isAdd && !isDel) return json({ error: "Unknown op" }, 400);
    // read-modify-write, retried if someone else wrote in between (conditional write on the etag)
    for (let attempt = 0; attempt < 5; attempt++) {
      const { etag, doc } = await readNotes(store);
      if (isAdd) {
        const n = op.note, id = String(n.id);
        if (!doc.notes.some((x) => x.id === id) && !doc.deleted.includes(id)) {
          doc.notes.push({
            id,
            ts: Number(n.ts) || Date.now(),
            tag: String(n.tag || ""),
            text: String(n.text).slice(0, 4000),
            by: String(n.by || "").slice(0, 80),
          });
        }
      } else {
        const id = String(op.id);
        doc.notes = doc.notes.filter((x) => x.id !== id);
        if (!doc.deleted.includes(id)) doc.deleted.push(id);
      }
      doc.updatedAt = Date.now();
      const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
      const res = await store.setJSON(NOTES_KEY, doc, opts);
      if (!res || res.modified !== false) return json({ ok: true, doc });
    }
    return json({ error: "Busy - please retry" }, 409);
  } catch (err) {
    return json({ error: "Notes failed: " + err.message }, 500);
  }
}
