import { ApiError } from "./config.js";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const accessTokenCache = new Map();
const tokenInFlight = new Map();
const jwksCache = new Map();

export function clearAuthCaches() {
  accessTokenCache.clear();
  tokenInFlight.clear();
  jwksCache.clear();
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeJson(obj) {
  return base64UrlEncodeBytes(textEncoder.encode(JSON.stringify(obj)));
}

function base64UrlDecodeToBytes(str) {
  const base64 = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJwtPart(part) {
  return JSON.parse(textDecoder.decode(base64UrlDecodeToBytes(part)));
}

function pemToArrayBuffer(pem) {
  let cleaned = String(pem || "").trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1);
  }
  cleaned = cleaned
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");

  if (!cleaned) {
    throw new ApiError(500, "Chave privada da Service Account está vazia.");
  }

  try {
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  } catch {
    throw new ApiError(
      500,
      "Chave privada da Service Account inválida. Verifique GOOGLE_PRIVATE_KEY ou GOOGLE_SERVICE_ACCOUNT_JSON."
    );
  }
}

async function createServiceAccountJwt({
  serviceAccountEmail,
  privateKey,
  scope = SHEETS_SCOPE,
  nowMs = Date.now()
}) {
  const nowSec = Math.floor(nowMs / 1000);
  const headerB64 = base64UrlEncodeJson({ alg: "RS256", typ: "JWT" });
  const claimsB64 = base64UrlEncodeJson({
    iss: serviceAccountEmail,
    scope,
    aud: OAUTH_TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600
  });
  const signingInput = `${headerB64}.${claimsB64}`;

  let cryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      pemToArrayBuffer(privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(
      500,
      "Não foi possível carregar a chave privada da Service Account (formato PKCS#8 esperado)."
    );
  }

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    textEncoder.encode(signingInput)
  );
  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

export async function getGoogleAccessToken(config, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const cacheKey = `${config.serviceAccountEmail}:${config.privateKey.slice(0, 24)}:${config.privateKey.length}`;
  const cached = accessTokenCache.get(cacheKey);
  if (cached && nowMs < cached.expiresAtMs - 120_000) {
    return cached.token;
  }

  if (tokenInFlight.has(cacheKey)) {
    return tokenInFlight.get(cacheKey);
  }

  const promise = (async () => {
    const assertion = await createServiceAccountJwt({
      serviceAccountEmail: config.serviceAccountEmail,
      privateKey: config.privateKey,
      nowMs
    });

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    });

    const res = await fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.access_token) {
      const desc = data?.error_description || data?.error || `HTTP ${res.status}`;
      throw new ApiError(
        502,
        `Falha ao autenticar Service Account no Google (${desc}).`
      );
    }

    const ttlSec = Math.max(60, Number(data.expires_in) || 3600);
    accessTokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAtMs: nowMs + ttlSec * 1000
    });
    return data.access_token;
  })();

  tokenInFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    tokenInFlight.delete(cacheKey);
  }
}

function parseMaxAgeMs(cacheControlHeader) {
  const match = String(cacheControlHeader || "").match(/max-age=(\d+)/i);
  const seconds = match ? Number(match[1]) : 3600;
  return Math.max(60, Math.min(86400, seconds)) * 1000;
}

async function fetchGoogleJwks(jwksUrl, fetchImpl, nowMs, forceRefresh = false) {
  const cached = jwksCache.get(jwksUrl);
  if (!forceRefresh && cached && nowMs < cached.expiresAtMs) {
    return cached.keys;
  }

  // Evita martelar o endpoint caso o kid seja desconhecido em sequência
  if (forceRefresh && cached && nowMs - cached.fetchedAtMs < 60_000) {
    return cached.keys;
  }

  const res = await fetchImpl(jwksUrl);
  const data = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(data?.keys)) {
    throw new ApiError(502, "Não foi possível obter as chaves públicas do Google para validar o login.");
  }

  const maxAgeMs = parseMaxAgeMs(res.headers?.get?.("cache-control"));
  jwksCache.set(jwksUrl, {
    keys: data.keys,
    fetchedAtMs: nowMs,
    expiresAtMs: nowMs + maxAgeMs
  });
  return data.keys;
}

export async function verifyAdminToken(
  token,
  config,
  { fetchImpl = fetch, nowMs = Date.now(), jwksUrl = GOOGLE_JWKS_URL } = {}
) {
  if (!token || typeof token !== "string") {
    throw new ApiError(401, "Sessão não autenticada. Faça login novamente.");
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new ApiError(401, "Token de autenticação inválido.");
  }

  let header;
  let payload;
  try {
    header = decodeJwtPart(parts[0]);
    payload = decodeJwtPart(parts[1]);
  } catch {
    throw new ApiError(401, "Token de autenticação malformado.");
  }

  if (header?.alg !== "RS256" || !header?.kid) {
    throw new ApiError(401, "Algoritmo de token inválido.");
  }

  if (!GOOGLE_ISSUERS.has(String(payload?.iss || ""))) {
    throw new ApiError(401, "Token emitido por origem inválida.");
  }

  if (payload?.aud !== config.googleClientId) {
    throw new ApiError(401, "Token emitido para outro aplicativo.");
  }

  if (payload?.email_verified !== true && payload?.email_verified !== "true") {
    throw new ApiError(401, "E-mail da conta Google não verificado.");
  }

  const expSec = Number(payload?.exp);
  if (!Number.isFinite(expSec) || nowMs >= expSec * 1000) {
    throw new ApiError(401, "Sessão expirada. Faça login novamente.");
  }

  if (payload?.nbf !== undefined) {
    const nbfSec = Number(payload.nbf);
    if (!Number.isFinite(nbfSec) || nowMs < (nbfSec - 60) * 1000) {
      throw new ApiError(401, "Token ainda não é válido.");
    }
  }

  const email = String(payload?.email || "").trim().toLowerCase();
  if (!email || !config.adminEmails.includes(email)) {
    throw new ApiError(403, `Acesso negado: o e-mail "${email || "desconhecido"}" não está autorizado.`);
  }

  let keys = await fetchGoogleJwks(jwksUrl, fetchImpl, nowMs, false);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) {
    keys = await fetchGoogleJwks(jwksUrl, fetchImpl, nowMs, true);
    jwk = keys.find(k => k.kid === header.kid);
  }
  if (!jwk) {
    throw new ApiError(401, "Chave pública de assinatura do token não encontrada.");
  }

  let verifyKey;
  try {
    verifyKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
  } catch {
    throw new ApiError(401, "Chave pública de validação inválida.");
  }

  const isValidSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    verifyKey,
    base64UrlDecodeToBytes(parts[2]),
    textEncoder.encode(`${parts[0]}.${parts[1]}`)
  );

  if (!isValidSignature) {
    throw new ApiError(401, "Assinatura do token inválida.");
  }

  return {
    email,
    name: String(payload?.name || email).trim()
  };
}
