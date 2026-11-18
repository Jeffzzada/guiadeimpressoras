import { ApiError, TONER_MAP, getRuntimeConfig, getSeaTalkConfig } from "../_lib/config.js";
import { getGoogleAccessToken } from "../_lib/google-auth.js";
import { createInventoryService } from "../_lib/inventory-service.js";
import { verifySeaTalkSignature } from "../_lib/seatalk-auth.js";
import {
  buildActionResultCard,
  buildArmarioTIMenuCard,
  buildPendingItemCard,
  buildTonerMenuCard,
  formatEstoqueResumo
} from "../_lib/seatalk-cards.js";
import {
  getEmployeeProfile,
  isSeaTalkBotConfigured,
  sendGroupMessage
} from "../_lib/seatalk-client.js";
import { createSheetsClient } from "../_lib/sheets-client.js";

const processedEventIds = new Map();

export function clearSeaTalkEventCache() {
  processedEventIds.clear();
}

function isDuplicateEvent(eventId, nowMs) {
  if (!eventId) return false;
  for (const [id, ts] of processedEventIds.entries()) {
    if (nowMs - ts > 10 * 60 * 1000) processedEventIds.delete(id);
  }
  if (processedEventIds.has(eventId)) return true;
  processedEventIds.set(eventId, nowMs);
  return false;
}

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

function getCurrentTurno(nowMs) {
  const saoPauloHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Sao_Paulo",
      hour: "numeric",
      hour12: false
    }).format(new Date(nowMs))
  );
  if (saoPauloHour >= 6 && saoPauloHour < 14) return "T1";
  if (saoPauloHour >= 14 && saoPauloHour < 22) return "T2";
  return "T3";
}

function buildServiceFromConfig(config, fetchImpl, nowMs) {
  const sheetsClient = createSheetsClient({
    sheetId: config.sheetId,
    getAccessToken: () => getGoogleAccessToken(config, { fetchImpl, nowMs }),
    fetchImpl
  });
  return createInventoryService(sheetsClient, config);
}

async function resolveActor(event, config, deps) {
  let email = String(
    event?.email || event?.sender?.email || event?.message?.sender?.email || ""
  )
    .trim()
    .toLowerCase();
  const employeeCode = String(
    event?.employee_code ||
      event?.sender?.employee_code ||
      event?.message?.sender?.employee_code ||
      ""
  ).trim();
  let name = String(
    event?.name || event?.sender?.name || event?.message?.sender?.name || ""
  ).trim();

  if ((!email || !name) && employeeCode && isSeaTalkBotConfigured(config.seatalk)) {
    const profile = await getEmployeeProfile(employeeCode, config.seatalk, deps);
    if (profile) {
      if (!email && profile.email) email = String(profile.email).trim().toLowerCase();
      if (!name && profile.name) name = String(profile.name).trim();
    }
  }

  return {
    email,
    name: name || (email ? email.split("@")[0] : employeeCode || "Admin TI"),
    employeeCode
  };
}

async function replyGroupText(groupId, threadId, content, seaTalkConfig, deps) {
  if (!groupId || !isSeaTalkBotConfigured(seaTalkConfig)) return;
  await sendGroupMessage(
    {
      groupId,
      threadId,
      message: {
        tag: "text",
        text: { format: 1, content }
      }
    },
    seaTalkConfig,
    deps
  );
}

async function replyGroupCard(groupId, threadId, card, seaTalkConfig, deps) {
  if (!groupId || !isSeaTalkBotConfigured(seaTalkConfig)) return;
  await sendGroupMessage({ groupId, threadId, message: card }, seaTalkConfig, deps);
}

function getConfiguredGroupIds(seaTalkConfig) {
  if (Array.isArray(seaTalkConfig?.groupIds) && seaTalkConfig.groupIds.length) {
    return seaTalkConfig.groupIds;
  }
  return seaTalkConfig?.groupId ? [seaTalkConfig.groupId] : [];
}

function isAllowedSeaTalkGroup(seaTalkConfig, incomingGroupId) {
  const allowed = getConfiguredGroupIds(seaTalkConfig);
  const incoming = String(incomingGroupId || "").trim();
  if (!allowed.length || !incoming) return true;
  return allowed.includes(incoming);
}

async function avisarGroupIdSeAusente(groupId, threadId, seaTalkConfig, deps) {
  if (getConfiguredGroupIds(seaTalkConfig).length || !groupId) return;
  await replyGroupText(
    groupId,
    threadId,
    `ℹ️ Para migrar os avisos da Conta do Sistema para este Bot (com botões **Permitir / Recusar**), configure no Cloudflare Pages:\n**SEATALK_GROUP_ID:** \`${groupId}\``,
    seaTalkConfig,
    deps
  );
}

async function handleInteractiveClick(payload, env, deps) {
  const event = payload?.event || {};
  const config = getRuntimeConfig(env);
  const seaTalk = config.seatalk;
  const groupId = String(event.group_id || seaTalk.groupId || "").trim();
  const threadId = String(event.thread_id || event.message_id || "").trim();
  const value = String(event.value || "").trim();

  if (!isSeaTalkBotConfigured(seaTalk) || !groupId) return;

  if (!isAllowedSeaTalkGroup(seaTalk, event.group_id)) {
    console.warn("SeaTalk click ignored from non-configured group:", event.group_id);
    return;
  }

  const actor = await resolveActor(event, config, deps);
  if (!actor.email || !config.adminEmails.includes(actor.email)) {
    await replyGroupText(
      groupId,
      threadId,
      `⛔ Acesso restrito: apenas administradores de TI autorizados (${actor.email || "usuário não identificado"}) podem validar ou alterar o estoque pelo SeaTalk.`,
      seaTalk,
      deps
    );
    return;
  }

  const service = buildServiceFromConfig(config, deps.fetchImpl, deps.nowMs);
  const adminUser = { email: actor.email, name: actor.name };
  const appUrl = config.notifications.appUrl;

  try {
    if (value === "menu:toners") {
    const [estoque, armarioTI, logs] = await Promise.all([
      service.getEstoque(),
      service.getArmarioTI(),
      service.getLog()
    ]);
    const pendentesCount = logs.filter(l => l.validacao === "pendente").length;
    await replyGroupCard(
      groupId,
      threadId,
      buildTonerMenuCard({ estoque, armarioTI, pendentesCount, appUrl }),
      seaTalk,
      deps
    );
    await avisarGroupIdSeAusente(groupId, threadId, seaTalk, deps);
    return;
  }

  if (value === "menu:ti" || value === "menu:ti_sub") {
    const [armarioTI, estoque] = await Promise.all([
      service.getArmarioTI(),
      service.getEstoque()
    ]);
    await replyGroupCard(
      groupId,
      threadId,
      buildArmarioTIMenuCard({
        armarioTI,
        estoque,
        mode: value === "menu:ti_sub" ? "sub" : "add"
      }),
      seaTalk,
      deps
    );
    return;
  }

  if (value === "menu:pendentes") {
    const logs = await service.getLog();
    const pendentes = logs.filter(l => l.validacao === "pendente");
    if (!pendentes.length) {
      const estoque = await service.getEstoque();
      await replyGroupCard(
        groupId,
        threadId,
        buildActionResultCard({
          title: "✅ Nenhuma movimentação pendente",
          summary: "Todas as movimentações registradas já foram conferidas.",
          estoque,
          appUrl
        }),
        seaTalk,
        deps
      );
      return;
    }

    for (const entry of pendentes.slice(0, 3)) {
      await replyGroupCard(
        groupId,
        threadId,
        buildPendingItemCard({ entry, appUrl }),
        seaTalk,
        deps
      );
    }
    if (pendentes.length > 3) {
      await replyGroupText(
        groupId,
        threadId,
        `ℹ️ Exibindo as 3 pendências mais recentes de **${pendentes.length}**. Veja todas em ${appUrl}/admin.html`,
        seaTalk,
        deps
      );
    }
    return;
  }

  if (value.startsWith("val:") || value.startsWith("div:")) {
    const isDivergente = value.startsWith("div:");
    const status = isDivergente ? "divergente" : "validado";
    const ids = value
      .slice(4)
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const res = await service.validarLote({ ids, status }, adminUser);
    const title = isDivergente
      ? "❌ Movimentação RECUSADA"
      : "✅ Movimentação PERMITIDA";
    const summary = isDivergente
      ? `**Por:** ${actor.email}\n**Ação:** ${res.atualizados} registro(s) recusado(s) e estornado(s) no estoque.`
      : `**Por:** ${actor.email}\n**Ação:** ${res.atualizados} registro(s) permitido(s).`;

    await replyGroupCard(
      groupId,
      threadId,
      buildActionResultCard({ title, summary, estoque: res.estoque, appUrl }),
      seaTalk,
      deps
    );
    return;
  }

  if (value.startsWith("valS:") || value.startsWith("divS:")) {
    const isDivergente = value.startsWith("divS:");
    const status = isDivergente ? "divergente" : "validado";
    const [targetData, targetResp = ""] = value.slice(5).split("|");
    const logs = await service.getLog();
    const matchedIds = logs
      .filter(l => l.data === targetData && (!targetResp || l.resp.startsWith(targetResp)))
      .map(l => l.id);

    if (!matchedIds.length) {
      await replyGroupText(
        groupId,
        threadId,
        "⚠️ Movimentações não encontradas na planilha. Confira pelo painel admin.",
        seaTalk,
        deps
      );
      return;
    }

    const res = await service.validarLote({ ids: matchedIds, status }, adminUser);
    await replyGroupCard(
      groupId,
      threadId,
      buildActionResultCard({
        title: isDivergente ? "❌ Lote RECUSADO" : "✅ Lote PERMITIDO",
        summary: isDivergente
          ? `**Por:** ${actor.email}\n**Registros recusados e estornados:** ${res.atualizados}`
          : `**Por:** ${actor.email}\n**Registros permitidos:** ${res.atualizados}`,
        estoque: res.estoque,
        appUrl
      }),
      seaTalk,
      deps
    );
    return;
  }

  if (value.startsWith("add_imp:")) {
    const ref = value.slice(8).trim().toUpperCase();
    const toner = TONER_MAP[ref];
    if (!toner) return;

    const reg = await service.registrar({
      modelo: ref,
      tipo: "entrada_cheio",
      qtd: 1,
      resp: actor.name,
      turno: getCurrentTurno(deps.nowMs),
      obs: "Adicionado via SeaTalk Bot",
      data: new Date(deps.nowMs).toISOString()
    });
    const valRes = await service.validar(
      { id: reg.id, status: "validado" },
      adminUser
    );

    await replyGroupCard(
      groupId,
      threadId,
      buildActionResultCard({
        title: `✅ +1 ${toner.nome} (${ref}) adicionado na Impressora`,
        summary: `**Registrado e validado por:** ${actor.email}`,
        estoque: valRes.estoque,
        appUrl
      }),
      seaTalk,
      deps
    );
    return;
  }

  if (value.startsWith("add_ti:") || value.startsWith("sub_ti:")) {
    const isSub = value.startsWith("sub_ti:");
    const ref = value.slice(7).trim().toUpperCase();
    const toner = TONER_MAP[ref];
    if (!toner) return;

    const currentList = await service.getArmarioTI();
    const currentRow = currentList.find(r => r.ref === ref) || { cheios: 0 };
    const nextVal = Math.max(0, (Number(currentRow.cheios) || 0) + (isSub ? -1 : 1));
    const res = await service.setArmarioTI({ ref, cheios: nextVal }, adminUser);

    await replyGroupCard(
      groupId,
      threadId,
      buildActionResultCard({
        title: isSub
          ? `➖1 ${toner.nome} (${ref}) retirado do Armário de TI`
          : `➕1 ${toner.nome} (${ref}) adicionado ao Armário de TI`,
        summary: `**Atualizado por:** ${actor.email} (saldo na sala de TI: **${nextVal}**)`,
        estoque: res.estoque,
        armarioTI: res.itens,
        appUrl
      }),
      seaTalk,
      deps
    );
    return;
  }

    await replyGroupText(
      groupId,
      threadId,
      "ℹ️ Ação não reconhecida. Clique em **Gerenciar Toners** para abrir o menu.",
      seaTalk,
      deps
    );
  } catch (err) {
    console.error("SeaTalk interactive action failed:", err);
    const msg = err instanceof ApiError ? err.message : "Erro ao processar ação no servidor.";
    await replyGroupText(groupId, threadId, `⚠️ ${msg}`, seaTalk, deps).catch(() => {});
  }
}

async function handleBotAdded(payload, env, deps) {
  const seaTalk = getSeaTalkConfig(env);
  const groupId = String(
    payload?.event?.group?.group_id || payload?.event?.group_id || ""
  ).trim();
  console.log("SeaTalk bot added to group:", groupId);
  if (!groupId || !isSeaTalkBotConfigured(seaTalk)) return;

  await replyGroupCard(
    groupId,
    "",
    {
      tag: "interactive_message",
      interactive_message: {
        elements: [
          {
            element_type: "title",
            title: { text: "🖨️ Bot Shopee TI · Toners HP Color" }
          },
          {
            element_type: "description",
            description: {
              format: 1,
              text: `Bot conectado a este grupo!\n**SEATALK_GROUP_ID:** \`${groupId}\`\n\nClique abaixo para gerenciar e validar toners por aqui.`
            }
          },
          {
            element_type: "button",
            button: {
              button_type: "callback",
              text: "📦 Abrir Controle de Toners",
              value: "menu:toners"
            }
          }
        ]
      }
    },
    seaTalk,
    deps
  );
}

async function handleMentionOrMessage(payload, env, deps) {
  const config = getRuntimeConfig(env);
  const seaTalk = config.seatalk;
  const event = payload?.event || {};
  const groupId = String(
    event.group_id || event.group?.group_id || seaTalk.groupId || ""
  ).trim();
  const threadId = String(
    event.message?.thread_id || event.message?.message_id || event.thread_id || event.message_id || ""
  ).trim();

  if (!groupId || !isSeaTalkBotConfigured(seaTalk)) return;
  if (!isAllowedSeaTalkGroup(seaTalk, event.group_id)) {
    return;
  }

  const service = buildServiceFromConfig(config, deps.fetchImpl, deps.nowMs);
  const actor = await resolveActor(event, config, deps);
  const isAdmin = Boolean(actor.email && config.adminEmails.includes(actor.email));

  if (!isAdmin) {
    const estoque = await service.getEstoque();
    await replyGroupText(
      groupId,
      threadId,
      `📦 **Estoque atual — Armário da Impressora:**\n${formatEstoqueResumo(estoque)}\n\nPara registrar uso, acesse: ${config.notifications.appUrl}/estoque.html`,
      seaTalk,
      deps
    );
    return;
  }

  const [estoque, armarioTI, logs] = await Promise.all([
    service.getEstoque(),
    service.getArmarioTI(),
    service.getLog()
  ]);
  const pendentesCount = logs.filter(l => l.validacao === "pendente").length;

  await replyGroupCard(
    groupId,
    threadId,
    buildTonerMenuCard({
      estoque,
      armarioTI,
      pendentesCount,
      appUrl: config.notifications.appUrl
    }),
    seaTalk,
    deps
  );

  await avisarGroupIdSeAusente(groupId, threadId, seaTalk, deps);
}

export async function handleSeaTalkRequest(request, env, ctx = null, deps = {}) {
  const method = String(request.method || "GET").toUpperCase();
  const fetchImpl = deps.fetchImpl || fetch;
  const nowMs = typeof deps.nowMs === "number" ? deps.nowMs : Date.now();
  const seaTalk = getSeaTalkConfig(env);

  if (method === "GET") {
    const configuredGroups = getConfiguredGroupIds(seaTalk);
    return jsonResponse(200, {
      ok: true,
      endpoint: "seatalk-callback",
      signingSecretConfigured: Boolean(seaTalk.signingSecret),
      botConfigured: isSeaTalkBotConfigured(seaTalk),
      groupConfigured: configuredGroups.length > 0,
      groupCount: configuredGroups.length
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
  const signatureHeader = request.headers.get("signature");

  if (seaTalk.appId && payload?.app_id && String(payload.app_id) !== seaTalk.appId) {
    return jsonResponse(401, { ok: false, erro: "app_id inválido." });
  }

  if (seaTalk.signingSecret) {
    const valid = await verifySeaTalkSignature(rawBytes, seaTalk.signingSecret, signatureHeader);
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

  const eventId = String(payload?.event_id || "").trim();
  if (isDuplicateEvent(eventId, nowMs)) {
    return jsonResponse(200, { ok: true, duplicate: true });
  }

  const runtimeDeps = { fetchImpl, nowMs };
  let taskPromise = null;

  if (eventType === "interactive_message_click") {
    taskPromise = handleInteractiveClick(payload, env, runtimeDeps);
  } else if (eventType === "bot_added_to_group_chat") {
    taskPromise = handleBotAdded(payload, env, runtimeDeps);
  } else if (eventType === "new_mentioned_message_received_from_group_chat") {
    taskPromise = handleMentionOrMessage(payload, env, runtimeDeps);
  } else {
    console.log("SeaTalk event ignored:", eventType);
  }

  if (taskPromise) {
    const safeTask = taskPromise.catch(err => {
      console.error(`SeaTalk event "${eventType}" failed:`, err);
      if (err instanceof ApiError && !ctx?.waitUntil) throw err;
    });

    if (typeof ctx?.waitUntil === "function") {
      ctx.waitUntil(safeTask);
    } else {
      await safeTask;
    }
  }

  return jsonResponse(200, { ok: true });
}

export async function onRequest(context) {
  return handleSeaTalkRequest(context.request, context.env, context);
}
