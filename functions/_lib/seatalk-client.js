import { ApiError } from "./config.js";

const SEATALK_BASE = "https://openapi.seatalk.io";
const accessTokenCache = new Map();
const tokenInFlight = new Map();

export function clearSeaTalkTokenCache() {
  accessTokenCache.clear();
  tokenInFlight.clear();
}

export function isSeaTalkBotConfigured(seaTalkConfig) {
  return Boolean(seaTalkConfig?.appId && seaTalkConfig?.appSecret);
}

export async function getSeaTalkAccessToken(
  seaTalkConfig,
  { fetchImpl = fetch, nowMs = Date.now(), forceRefresh = false } = {}
) {
  if (!isSeaTalkBotConfigured(seaTalkConfig)) {
    throw new ApiError(500, "Credenciais do bot SeaTalk (SEATALK_APP_ID / SEATALK_APP_SECRET) ausentes.");
  }

  const cacheKey = `${seaTalkConfig.appId}:${seaTalkConfig.appSecret.slice(0, 12)}`;
  if (!forceRefresh) {
    const cached = accessTokenCache.get(cacheKey);
    if (cached && nowMs < cached.expiresAtMs - 120_000) {
      return cached.token;
    }
  }

  if (tokenInFlight.has(cacheKey)) {
    return tokenInFlight.get(cacheKey);
  }

  const promise = (async () => {
    const res = await fetchImpl(`${SEATALK_BASE}/auth/app_access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: seaTalkConfig.appId,
        app_secret: seaTalkConfig.appSecret
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.code !== 0 || !data?.app_access_token) {
      throw new ApiError(
        502,
        `Falha ao obter app_access_token do SeaTalk (HTTP ${res.status}, code ${data?.code ?? "?"}).`
      );
    }

    const expireSec = Number(data.expire);
    const expiresAtMs =
      Number.isFinite(expireSec) && expireSec > 0
        ? expireSec * 1000
        : nowMs + 7200 * 1000;

    accessTokenCache.set(cacheKey, {
      token: data.app_access_token,
      expiresAtMs
    });
    return data.app_access_token;
  })();

  tokenInFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    tokenInFlight.delete(cacheKey);
  }
}

async function seaTalkAuthorizedFetch(path, init, seaTalkConfig, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  let token = await getSeaTalkAccessToken(seaTalkConfig, { fetchImpl, nowMs });

  const call = async bearer => {
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${bearer}`);
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }
    const res = await fetchImpl(`${SEATALK_BASE}${path}`, { ...init, headers });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  let { res, data } = await call(token);

  // Renova token 1x em caso de token expirado/inválido (code 100/101 ou HTTP 401)
  if (res.status === 401 || data?.code === 100 || data?.code === 101) {
    token = await getSeaTalkAccessToken(seaTalkConfig, {
      fetchImpl,
      nowMs,
      forceRefresh: true
    });
    ({ res, data } = await call(token));
  }

  return { res, data };
}

export async function sendGroupMessage(
  { groupId, message, threadId = "" },
  seaTalkConfig,
  deps = {}
) {
  if (!groupId) {
    throw new ApiError(400, "group_id do SeaTalk não informado.");
  }

  const finalMessage = threadId ? { ...message, thread_id: threadId } : message;

  const { res, data } = await seaTalkAuthorizedFetch(
    "/messaging/v2/group_chat",
    {
      method: "POST",
      body: JSON.stringify({
        group_id: groupId,
        message: finalMessage
      })
    },
    seaTalkConfig,
    deps
  );

  if (!res.ok || data?.code !== 0) {
    throw new ApiError(
      502,
      `Erro ao enviar mensagem no SeaTalk (HTTP ${res.status}, code ${data?.code ?? "?"}).`
    );
  }

  return data;
}

export async function getEmployeeProfile(employeeCode, seaTalkConfig, deps = {}) {
  const code = String(employeeCode || "").trim();
  if (!code || !isSeaTalkBotConfigured(seaTalkConfig)) return null;

  try {
    const params = new URLSearchParams({ employee_code: code });
    const { res, data } = await seaTalkAuthorizedFetch(
      `/contacts/v2/profile?${params.toString()}`,
      { method: "GET" },
      seaTalkConfig,
      deps
    );
    if (!res.ok || data?.code !== 0 || !Array.isArray(data?.employees)) {
      return null;
    }
    return data.employees[0] || null;
  } catch {
    return null;
  }
}
