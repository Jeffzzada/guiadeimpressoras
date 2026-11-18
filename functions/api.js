import { ApiError, getRuntimeConfig } from "./_lib/config.js";
import { getGoogleAccessToken, verifyAdminToken } from "./_lib/google-auth.js";
import { createInventoryService } from "./_lib/inventory-service.js";
import { hasNotificationChannels, notifyNewMovements } from "./_lib/notifications.js";
import { createSheetsClient } from "./_lib/sheets-client.js";

function resolveCorsOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return "";
  try {
    const reqOrigin = new URL(request.url).origin;
    if (origin === reqOrigin) return origin;
    const parsed = new URL(origin);
    if (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname.endsWith(".pages.dev")
    ) {
      return origin;
    }
  } catch {
    return "";
  }
  return "";
}

function buildResponseHeaders(request) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };
  const corsOrigin = resolveCorsOrigin(request);
  if (corsOrigin) {
    headers["Access-Control-Allow-Origin"] = corsOrigin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    headers["Vary"] = "Origin";
  }
  return headers;
}

function jsonResponse(request, status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: buildResponseHeaders(request)
  });
}

function extractAuthToken(request, payload) {
  const bodyToken = typeof payload?.token === "string" ? payload.token.trim() : "";
  if (bodyToken) return bodyToken;
  const authHeader = request.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function parseJsonBody(request) {
  const raw = await request.text();
  if (!raw || !raw.trim()) {
    throw new ApiError(400, "Corpo da requisição vazio.");
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw new ApiError(400, "Corpo da requisição JSON inválido.");
  }
}

export async function handleApiRequest(request, env, ctx = null, deps = {}) {
  const method = String(request.method || "GET").toUpperCase();
  const fetchImpl = deps.fetchImpl || fetch;
  const nowMs = typeof deps.nowMs === "number" ? deps.nowMs : Date.now();
  const jwksUrl = deps.jwksUrl;

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: buildResponseHeaders(request)
    });
  }

  try {
    const url = new URL(request.url);

    if (method === "GET") {
      const action = String(url.searchParams.get("action") || "").trim();
      if (action === "health") {
        return jsonResponse(request, 200, {
          ok: true,
          service: "guiadeimpressoras-api",
          timestamp: new Date(nowMs).toISOString()
        });
      }

      const config = getRuntimeConfig(env);
      const sheetsClient = createSheetsClient({
        sheetId: config.sheetId,
        getAccessToken: () => getGoogleAccessToken(config, { fetchImpl, nowMs }),
        fetchImpl
      });
      const service = createInventoryService(sheetsClient, config);

      if (action === "getEstoque") {
        return jsonResponse(request, 200, await service.getEstoque());
      }
      if (action === "getLog") {
        return jsonResponse(request, 200, await service.getLog());
      }
      throw new ApiError(400, "Ação inválida.");
    }

    if (method === "POST") {
      const payload = await parseJsonBody(request);
      const action = String(payload?.action || url.searchParams.get("action") || "").trim();
      const config = getRuntimeConfig(env);

      const sheetsClient = createSheetsClient({
        sheetId: config.sheetId,
        getAccessToken: () => getGoogleAccessToken(config, { fetchImpl, nowMs }),
        fetchImpl
      });
      const service = createInventoryService(sheetsClient, config);

      if (action === "registrar" || action === "registrarLote") {
        const result =
          action === "registrar"
            ? await service.registrar(payload)
            : await service.registrarLote(payload);

        const notified = hasNotificationChannels(config);
        if (notified) {
          const notifyPromise = notifyNewMovements(config, result.notificationData, {
            fetchImpl
          });
          if (typeof ctx?.waitUntil === "function") {
            ctx.waitUntil(notifyPromise);
          } else {
            await notifyPromise;
          }
        }

        const { notificationData: _ignored, ...publicResult } = result;
        return jsonResponse(request, 200, { ...publicResult, notified });
      }

      const token = extractAuthToken(request, payload);
      const adminUser = await verifyAdminToken(token, config, {
        fetchImpl,
        nowMs,
        ...(jwksUrl ? { jwksUrl } : {})
      });

      if (action === "validar") {
        return jsonResponse(request, 200, await service.validar(payload, adminUser));
      }
      if (action === "validarLote") {
        return jsonResponse(request, 200, await service.validarLote(payload, adminUser));
      }
      if (action === "remover") {
        return jsonResponse(request, 200, await service.remover(payload));
      }
      if (action === "zerarEstoque") {
        return jsonResponse(request, 200, await service.zerarEstoque(adminUser));
      }
      if (action === "getArmarioTI") {
        return jsonResponse(request, 200, await service.getArmarioTI());
      }
      if (action === "setArmarioTI") {
        return jsonResponse(request, 200, await service.setArmarioTI(payload, adminUser));
      }
      if (action === "getVaziosTI") {
        return jsonResponse(request, 200, await service.getVaziosTI());
      }
      if (action === "setVaziosTI") {
        return jsonResponse(request, 200, await service.setVaziosTI(payload, adminUser));
      }
      if (action === "diagnostico") {
        const diag = await service.diagnostico();
        return jsonResponse(request, 200, {
          ...diag,
          admin: adminUser.email,
          notifications: {
            email: Boolean(config.notifications.resendApiKey),
            webhook: Boolean(config.notifications.alertWebhookUrl)
          }
        });
      }

      throw new ApiError(400, "Ação inválida.");
    }

    throw new ApiError(405, "Método HTTP não permitido.");
  } catch (err) {
    if (err instanceof ApiError) {
      return jsonResponse(request, err.status, { ok: false, erro: err.message });
    }
    console.error("Unhandled API error:", err);
    return jsonResponse(request, 500, {
      ok: false,
      erro: "Erro interno ao processar a solicitação."
    });
  }
}

export async function onRequest(context) {
  return handleApiRequest(context.request, context.env, context);
}
