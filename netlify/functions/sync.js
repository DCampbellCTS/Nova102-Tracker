// Shared-state endpoint for the Nova102 tracker's built-in "Share / sync" feature.
// GET  -> returns the last pushed { by, savedAt, state } (or {} if nobody has pushed yet)
// PUT  -> stores a new { by, savedAt, state } payload, overwriting whatever was there
//
// Backed by Netlify Blobs, which needs no separate account or API key when this
// function runs on Netlify itself - getStore() picks up the site''s own credentials
// automatically. Data lives in the "nova102-tracker" store under a single key, so
// everyone who has this site''s URL (and therefore this function''s URL) can read and
// write it. There is no authentication - anyone with the link can overwrite the
// shared state. That matches the tracker itself (no login anywhere), but is worth
// knowing before treating this as anything more than an internal, trusted hand-off.

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "nova102-tracker";
const KEY = "shared-state";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  let store;
  try {
    store = getStore(STORE_NAME);
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Blob store unavailable: " + err.message }),
    };
  }

  if (event.httpMethod === "GET") {
    try {
      const data = await store.get(KEY, { type: "json" });
      return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify(data || {}),
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Read failed: " + err.message }),
      };
    }
  }

  if (event.httpMethod === "PUT") {
    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch (err) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Invalid JSON body" }) };
    }
    if (!payload || typeof payload !== "object" || !payload.state) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Missing ''state'' field" }) };
    }
    try {
      await store.setJSON(KEY, payload);
      return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true }),
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Write failed: " + err.message }),
      };
    }
  }

  return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };
};