import { verifySeaTalkSignature } from "../_lib/seatalk-auth.js";

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export async function handleSeaTalkRequest(request, env, ctx = null) {
  const method = String(request.method || "GET").toUpperCase();

  if (method === "GET") {
    return jsonResponse(200, {
      ok: true,
      endpoint: "seatalk-callback",
      signingSecretConfigured: Boolean(String(env?.SEATALK_SIGNING_SECRET || "").trim())
    });
  }

  if (method !== "POST") {
    return jsonResponse(405, { ok: false, erro: "Método HTTP não permitido." });
  }

  const rawBuffer = await request.arrayBuffer();
  const rawBytes = new Uint8Array(rawBuffer);
  const rawText = new TextDecoder().decode(rawBytes);

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return jsonResponse(400, { ok: false, erro: "JSON inválido." });
  }

  const eventType = String(payload?.event_type || "").trim();
  const signingSecret = String(env?.SEATALK_SIGNING_SECRET || "").trim();
  const expectedAppId = String(env?.SEATALK_APP_ID || "").trim();
  const signatureHeader = request.headers.get("signature");

  if (expectedAppId && payload?.app_id && String(payload.app_id) !== expectedAppId) {
    return jsonResponse(401, { ok: false, erro: "app_id inválido." });
  }

  // O challenge de event_verification não altera nenhum dado:
  // - Se SEATALK_SIGNING_SECRET já estiver configurado, valida a assinatura normalmente.
  // - Se ainda não estiver configurado (ex.: durante o cadastro inicial da URL no portal),
  //   permite responder apenas ao event_verification; demais eventos continuam bloqueados.
  if (signingSecret) {
    const valid = await verifySeaTalkSignature(rawBytes, signingSecret, signatureHeader);
    if (!valid) {
      return jsonResponse(401, { ok: false, erro: "Assinatura inválida." });
    }
  } else if (eventType !== "event_verification") {
    return jsonResponse(503, {
      ok: false,
      erro: "SEATALK_SIGNING_SECRET não configurado no Cloudflare Pages."
    });
  }

  if (eventType === "event_verification") {
    const challenge = payload?.event?.seatalk_challenge;
    if (!challenge || typeof challenge !== "string") {
      return jsonResponse(400, { ok: false, erro: "seatalk_challenge ausente." });
    }
    return jsonResponse(200, { seatalk_challenge: challenge });
  }

  if (eventType === "bot_added_to_group_chat") {
    const groupId = payload?.event?.group?.group_id || payload?.event?.group_id || "";
    console.log("SeaTalk bot added to group:", groupId);
  } else {
    console.log("SeaTalk event received:", eventType);
  }

  return jsonResponse(200, { ok: true });
}

export async function onRequest(context) {
  return handleSeaTalkRequest(context.request, context.env, context);
}
