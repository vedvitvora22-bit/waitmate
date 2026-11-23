const crypto = require("crypto");

const PROJECT_ID = "waimate-ind01";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

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
  if (!value) return null;
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

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry) return cachedAccessToken;

  const rawCredentials = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!rawCredentials) {
    const err = new Error("Firebase credentials not configured");
    err.status = 503;
    throw err;
  }

  let credentials;
  try {
    credentials = JSON.parse(rawCredentials);
  } catch (parseError) {
    try {
      const fixedCredentials = rawCredentials.replace(/\r?\n/g, "\\n");
      credentials = JSON.parse(fixedCredentials);
    } catch {
      const err = new Error("Firebase credentials not configured");
      err.status = 503;
      throw err;
    }
  }

  if (!credentials.client_email || !credentials.private_key) {
    const err = new Error("Firebase credentials not configured");
    err.status = 503;
    throw err;
  }

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
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsignedToken), credentials.private_key).toString("base64url");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsignedToken}.${signature}`
    })
  });
  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok) throw new Error(tokenData.error_description || tokenData.error || "Firebase authentication failed");

  cachedAccessToken = tokenData.access_token;
  cachedAccessTokenExpiry = Date.now() + Math.max(60, Number(tokenData.expires_in || 3600) - 300) * 1000;
  return cachedAccessToken;
}

async function firestoreRequest(path, options = {}) {
  const accessToken = await getAccessToken();
  const url = `${BASE}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { message: text }; }
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `Firestore request failed (${response.status})`);
    error.status = response.status;
    error.code = data?.error?.status;
    throw error;
  }
  return data;
}

function documentId(document) {
  return String(document.name || "").split("/").pop();
}

async function listCollection(collection) {
  const data = await firestoreRequest(`/${encodeSegment(collection)}?pageSize=100`);
  return (data.documents || []).map(document => ({ id: documentId(document), ...fromFirestoreFields(document.fields) }));
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
  return firestoreRequest(`:commit`, {
    method: "POST",
    body: JSON.stringify({ writes })
  });
}

function setDocument(collection, id, fields) {
  return {
    update: {
      name: `projects/${PROJECT_ID}/databases/(default)/documents/${encodeSegment(collection)}/${encodeSegment(id)}`,
      fields: toFirestoreFields(fields)
    }
  };
}

module.exports = {
  listCollection,
  getDocument,
  commitWrites,
  setDocument,
  toFirestoreFields,
  fromFirestoreFields,
  PROJECT_ID,
  encodeSegment
};
