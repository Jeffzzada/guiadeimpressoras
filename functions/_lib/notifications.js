import { TONER_MAP } from "./config.js";

const TIPO_LABEL = {
  entrada_cheio: "Entrada (cheio)",
  saida_cheio: "Saída (instalado)",
  entrada_vazio: "Entrada (vazio)",
  saida_vazio: "Saída (descarte)"
};

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMovementLine(m) {
  const nome = TONER_MAP[m.modelo]?.nome || m.modelo;
  const tipo = TIPO_LABEL[m.tipo] || m.tipo;
  return `${nome} (${m.modelo}) · ${tipo} · Qtd: ${m.qtd}`;
}

async function sendResendEmail(config, { movimentos, resp, turno, obs, data }, fetchImpl) {
  const { resendApiKey, resendFromEmail, appUrl } = config.notifications;
  if (!resendApiKey || !config.adminEmails.length) return false;

  const itensHtml = movimentos
    .map(m => `<li>${escapeHtml(formatMovementLine(m))}</li>`)
    .join("");
  const obsHtml = obs ? `<p><strong>Observação:</strong> ${escapeHtml(obs)}</p>` : "";
  const adminLink = `${appUrl}/admin.html`;

  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: resendFromEmail,
      to: config.adminEmails,
      subject: `[HP Color · Estoque] Nova movimentação por ${resp} (${turno})`,
      html: `
        <div style="font-family:Inter,Arial,sans-serif;color:#111;line-height:1.5">
          <h2 style="margin:0 0 12px;color:#EE4D2D;">Nova movimentação de toner</h2>
          <p><strong>Responsável:</strong> ${escapeHtml(resp)}<br>
             <strong>Turno:</strong> ${escapeHtml(turno)}<br>
             <strong>Data (UTC):</strong> ${escapeHtml(data)}</p>
          <ul>${itensHtml}</ul>
          ${obsHtml}
          <p style="margin-top:16px;">
            <a href="${escapeHtml(adminLink)}" style="display:inline-block;padding:10px 16px;background:#EE4D2D;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">
              Abrir painel de validação
            </a>
          </p>
        </div>
      `
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("Resend notification failed:", res.status, errText);
    return false;
  }
  return true;
}

async function sendWebhookAlert(config, { movimentos, resp, turno, obs }, fetchImpl) {
  const { alertWebhookUrl, appUrl } = config.notifications;
  if (!alertWebhookUrl) return false;

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
  return Boolean(
    (config.notifications.resendApiKey && config.adminEmails.length) ||
      config.notifications.alertWebhookUrl
  );
}

export async function notifyNewMovements(config, details, { fetchImpl = fetch } = {}) {
  if (!hasNotificationChannels(config)) return false;

  const results = await Promise.allSettled([
    sendResendEmail(config, details, fetchImpl),
    sendWebhookAlert(config, details, fetchImpl)
  ]);

  return results.some(r => r.status === "fulfilled" && r.value === true);
}
