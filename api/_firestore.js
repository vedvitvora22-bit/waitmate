const crypto = require("crypto");

let PROJECT_ID = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || null;
if (!PROJECT_ID) {
  const _saRaw = process.env.FIREBASE_SERVER_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT ||
                 process.env.FIREBASE_SERVICE_ACCOUNT_KEY || process.env.FIREBASE_CREDENTIALS ||
                 process.env.FIREBASE_CONFIG || process.env.GOOGLE_APPLICATION_CREDENTIALS ||
                 process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (_saRaw) {
    const _parsed = parseServiceAccount(_saRaw);
    if (_parsed.credentials && _parsed.credentials.project_id) PROJECT_ID = _parsed.credentials.project_id;
  }
}
let BASE = PROJECT_ID ? `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents` : null;
let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

const TTL_MS = 15000;
const cache = {
  restaurants: { data: null, expires: 0 },
  queue_entries: { data: null, expires: 0 }
};

let useMemoryFallback = false;

function fetchWithTimeout(url, opts, ms = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const promise = fetch(url, { ...opts, signal: controller.signal });
  return promise.then(
    (res) => { clearTimeout(timer); return res; },
    (err) => { clearTimeout(timer); if (err.name === "AbortError") { const t = new Error(`Firebase request timed out after ${ms}ms`); t.status = 504; t.code = "ETIMEDOUT"; throw t; } throw err; }
  );
}

function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  return { stringValue: String(value) };
}

function fromFirestoreValue(value) {
  if (value === null || value === undefined) return null;
  if (Object.prototype.hasOwnProperty.call(value, "nullValue")) return null;
  if (Object.prototype.hasOwnProperty.call(value, "booleanValue")) return value.booleanValue;
  if (Object.prototype.hasOwnProperty.call(value, "integerValue")) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, "doubleValue")) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, "stringValue")) return value.stringValue;
  if (value.mapValue) return fromFirestoreFields(value.mapValue.fields || {});
  if (value.arrayValue) return (value.arrayValue.values || []).map(fromFirestoreValue);
  return null;
}

function toFirestoreFields(object) {
  const fields = {};
  for (const [key, value] of Object.entries(object || {})) fields[key] = toFirestoreValue(value);
  return fields;
}

function fromFirestoreFields(fields) {
  const object = {};
  for (const [key, value] of Object.entries(fields || {})) object[key] = fromFirestoreValue(value);
  return object;
}

function parseServiceAccount(raw) {
  if (!raw || typeof raw !== "string") {
    return { error: "FIREBASE_SERVICE_ACCOUNT is empty or not a string" };
  }

  let str = raw.trim();

  if ((str.startsWith("'") && str.endsWith("'")) || (str.startsWith("`") && str.endsWith("`"))) {
    str = str.slice(1, -1).trim();
  } else if (str.startsWith('"') && str.endsWith('"') && !str.startsWith('{"')) {
    try {
      str = JSON.parse(str);
    } catch (_) {
      str = str.slice(1, -1).trim();
    }
  }

  if (!str.startsWith("{")) {
    try {
      const decoded = Buffer.from(str, "base64").toString("utf8").trim();
      if (decoded.startsWith("{")) str = decoded;
    } catch (_) {}
  }

  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(str);
  } catch (e1) {
    parseError = e1;
  }

  if (!parsed) {
    try {
      const fixed = str.replace(/\r?\n/g, "\\n");
      parsed = JSON.parse(fixed);
    } catch (e2) {
      try {
        const unescaped = str.replace(/\\\\n/g, "\\n");
        parsed = JSON.parse(unescaped);
      } catch (e3) {
        const emailMatch = str.match(/"client_email"\s*:\s*"([^"]+)"/);
        const keyMatch = str.match(/"private_key"\s*:\s*"([\s\S]*?)(?:"\s*,\s*"|"\s*})/);
        const projectMatch = str.match(/"project_id"\s*:\s*"([^"]+)"/);
        if (emailMatch && keyMatch) {
          parsed = {
            client_email: emailMatch[1],
            private_key: keyMatch[1],
            project_id: projectMatch ? projectMatch[1] : PROJECT_ID
          };
        } else {
          return { error: `Invalid FIREBASE_SERVICE_ACCOUNT JSON: ${parseError?.message || e2?.message || e3?.message || "Invalid JSON"}` };
        }
      }
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return { error: "Service account is not a valid JSON object" };
  }

  if (!parsed.client_email) {
    return { error: "Service account JSON is missing client_email" };
  }

  if (!parsed.private_key) {
    return { error: "Service account JSON is missing private_key" };
  }

  let privateKey = String(parsed.private_key);
  if (privateKey.includes("\\n")) {
    privateKey = privateKey.replace(/\\n/g, "\n");
  }
  privateKey = privateKey.replace(/\r/g, "");

  parsed.private_key = privateKey;
  return { credentials: parsed };
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry) return cachedAccessToken;

  let raw = process.env.FIREBASE_SERVICE_ACCOUNT ||
            process.env.FIREBASE_SERVER_ACCOUNT ||
            process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
            process.env.FIREBASE_CREDENTIALS ||
            process.env.FIREBASE_CONFIG ||
            process.env.GOOGLE_APPLICATION_CREDENTIALS ||
            process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  if (!raw) {
    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (clientEmail && privateKey) {
      raw = JSON.stringify({
        type: "service_account",
        project_id: projectId,
        private_key: privateKey,
        client_email: clientEmail
      });
    }
  }

  if (!raw) {
    const presentKeys = Object.keys(process.env).filter(k =>
      k.includes("FIREBASE") || k.includes("GOOGLE") || k.includes("SERVICE")
    );
    const err = new Error(
      presentKeys.length
        ? `Missing FIREBASE_SERVICE_ACCOUNT env var (detected env keys: ${presentKeys.join(", ")})`
        : "Missing FIREBASE_SERVICE_ACCOUNT env var"
    );
    err.status = 503;
    throw err;
  }

  const { credentials, error: parseError } = parseServiceAccount(raw);
  if (parseError || !credentials) {
    const err = new Error(`Firebase credentials invalid: ${parseError}`);
    err.status = 503;
    throw err;
  }

  PROJECT_ID = credentials.project_id || process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || PROJECT_ID;
  BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  })).toString("base64url");
  const unsignedToken = `${header}.${payload}`;

  let signature;
  try {
    signature = crypto.sign("RSA-SHA256", Buffer.from(unsignedToken), credentials.private_key).toString("base64url");
  } catch (signErr) {
    const err = new Error(`Invalid PEM private_key format: ${signErr.message}`);
    err.status = 503;
    throw err;
  }

  const tokenResponse = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsignedToken}.${signature}`
    })
  }, 10000);
  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok) {
    const msg = tokenData.error_description || tokenData.error || `HTTP ${tokenResponse.status}`;
    const err = new Error(`Google OAuth2 authentication failed: ${msg}`);
    err.status = 503;
    throw err;
  }

  cachedAccessToken = tokenData.access_token;
  cachedAccessTokenExpiry = Date.now() + Math.max(60, Number(tokenData.expires_in || 3600) - 300) * 1000;
  return cachedAccessToken;
}

async function firestoreRequest(path, options = {}) {
  if (useMemoryFallback) {
    const err = new Error("Using memory fallback");
    err.status = 503;
    err.code = "RESOURCE_EXHAUSTED";
    throw err;
  }

  const accessToken = await getAccessToken();
  const url = `${BASE}${path}`;
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  }, 10000);
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { message: text }; }
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `Firestore request failed (${response.status})`);
    if (response.status === 429 || data?.error?.status === "RESOURCE_EXHAUSTED") {
      useMemoryFallback = true;
      error.status = 503;
      error.code = "RESOURCE_EXHAUSTED";
    } else {
      error.status = response.status;
    }
    error.originalStatus = response.status;
    error.code = data?.error?.status;
    throw error;
  }
  return data;
}

function documentId(document) {
  return String(document.name || "").split("/").pop();
}

function invalidateCache(collection) {
  if (cache[collection]) {
    cache[collection].data = null;
    cache[collection].expires = 0;
  }
}

async function listCollection(collection) {
  const now = Date.now();
  const entry = cache[collection];
  if (entry && entry.data !== null && now < entry.expires) {
    return entry.data;
  }

  const data = await firestoreRequest(`/${encodeSegment(collection)}?pageSize=100`);
  const docs = (data.documents || []).map(document => ({ id: documentId(document), ...fromFirestoreFields(document.fields) }));
  cache[collection] = { data: docs, expires: now + TTL_MS };
  return docs;
}

async function getDocument(collection, id) {
  try {
    const document = await firestoreRequest(`/${encodeSegment(collection)}/${encodeSegment(id)}`);
    return { id: documentId(document), ...fromFirestoreFields(document.fields) };
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function commitWrites(writes) {
  try {
    return await firestoreRequest(`:commit`, {
      method: "POST",
      body: JSON.stringify({ writes })
    });
  } catch (error) {
    console.warn("Firestore commitWrites error:", error.message || error);
    throw error;
  }
}

// Delete a single document via the native document DELETE endpoint (the
// `:commit` "delete" verb is not accepted by this Firestore instance, so
// all removals go through individual DELETE calls here).
async function deleteDocument(collection, id) {
  try {
    return await firestoreRequest(`/${encodeSegment(collection)}/${encodeSegment(id)}`, {
      method: "DELETE"
    });
  } catch (error) {
    if (error.status === 404) return null; // already gone
    throw error;
  }
}

function setDocument(collection, id, fields) {
  invalidateCache(collection);
  return {
    update: {
      name: `projects/${PROJECT_ID}/databases/(default)/documents/${encodeSegment(collection)}/${encodeSegment(id)}`,
      fields: toFirestoreFields(fields)
    }
  };
}

function enableMemoryFallback() {
  useMemoryFallback = true;
}

function isMemoryFallbackActive() {
  return useMemoryFallback;
}

function getProjectId() { return PROJECT_ID; }

module.exports = {
  getAccessToken,
  firestoreRequest,
  listCollection,
  getDocument,
  commitWrites,
  setDocument,
  deleteDocument,
  toFirestoreFields,
  fromFirestoreFields,
  PROJECT_ID,
  getProjectId,
  encodeSegment,
  enableMemoryFallback,
  isMemoryFallbackActive
};