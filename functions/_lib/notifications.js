import { TONER_MAP } from "./config.js";
import { buildMovementAlertCard } from "./seatalk-cards.js";
import { isSeaTalkBotConfigured, sendGroupMessage } from "./seatalk-client.js";

const TIPO_LABEL = {
  entrada_cheio: "Entrada (cheio)",
  saida_cheio: "Saída (instalado)",
  entrada_vazio: "Entrada (vazio)",
  saida_vazio: "Saída (descarte)"
};

function formatMovementLine(m) {
  const nome = TONER_MAP[m.modelo]?.nome || m.modelo;
  const tipo = TIPO_LABEL[m.tipo] || m.tipo;
  return `${nome} (${m.modelo}) · ${tipo} · Qtd: ${m.qtd}`;
}

async function sendSeaTalkBotCard(config, details, fetchImpl) {
  const seaTalk = config.seatalk;
  if (!isSeaTalkBotConfigured(seaTalk) || !seaTalk?.groupId) return false;

  try {
    const card = buildMovementAlertCard({
      ...details,
      appUrl: config.notifications.appUrl
    });
    await sendGroupMessage(
      { groupId: seaTalk.groupId, message: card },
      seaTalk,
      { fetchImpl }
    );
    return true;
  } catch (err) {
    console.error("SeaTalk bot card failed:", err);
    return false;
  }
}

async function sendWebhookAlert(config, { movimentos, resp, turno, obs }, fetchImpl, skipSeaTalk) {
  const { alertWebhookUrl, appUrl } = config.notifications;
  if (!alertWebhookUrl) return false;
  if (skipSeaTalk && /seatalk\.io/i.test(alertWebhookUrl)) return false;

  const linhas = movimentos.map(m => `• ${formatMovementLine(m)}`).join("\n");
  const obsLine = obs ? `\nObs: ${obs}` : "";
  const text = `🖨️ Nova movimentação de toner (${turno}) por ${resp}:\n${linhas}${obsLine}\nValidar: ${appUrl}/admin.html`;

  let payload;
  if (/seatalk\.io/i.test(alertWebhookUrl)) {
    payload = {
      tag: "text",
      text: {
        content: text,
        mentioned_email_list: config.adminEmails
      }
    };
  } else if (/discord\.com\/api\/webhooks/i.test(alertWebhookUrl)) {
    payload = { content: text };
  } else {
    payload = { text };
  }

  const res = await fetchImpl(alertWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("Webhook notification failed:", res.status, errText);
    return false;
  }
  return true;
}

export function hasNotificationChannels(config) {
  const hasSeaTalkBot = Boolean(isSeaTalkBotConfigured(config?.seatalk) && config?.seatalk?.groupId);
  return Boolean(hasSeaTalkBot || config?.notifications?.alertWebhookUrl);
}

export async function notifyNewMovements(config, details, { fetchImpl = fetch } = {}) {
  if (!hasNotificationChannels(config)) return false;

  const hasSeaTalkBot = Boolean(isSeaTalkBotConfigured(config?.seatalk) && config?.seatalk?.groupId);
  const results = await Promise.allSettled([
    sendSeaTalkBotCard(config, details, fetchImpl),
    sendWebhookAlert(config, details, fetchImpl, hasSeaTalkBot)
  ]);

  return results.some(r => r.status === "fulfilled" && r.value === true);
}
