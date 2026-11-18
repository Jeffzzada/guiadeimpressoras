/**
 * Configurações centralizadas da API Cloudflare Pages Functions.
 *
 * Variáveis de ambiente suportadas no Cloudflare Pages (Settings -> Environment variables):
 * - GOOGLE_SHEET_ID (obrigatória): ID da planilha do Google Sheets.
 * - GOOGLE_SERVICE_ACCOUNT_JSON (recomendada): conteúdo completo do JSON da Service Account
 *   OU use o par GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY.
 * - GOOGLE_CLIENT_ID (opcional): sobrescreve o Client ID OAuth padrão.
 * - ADMIN_EMAILS (opcional): lista separada por vírgula dos e-mails autorizados no painel admin.
 * - SHEET_TAB_ESTOQUE (opcional): nome da aba do Armário da Impressora (padrão: "webinventario").
 * - SHEET_TAB_LOG (opcional): nome da aba de histórico (padrão: detecta "Movimentações", "Registros", "log", etc.).
 * - SHEET_TAB_ARMARIO_TI (opcional): nome da aba do Armário de TI (padrão: "ArmarioTI").
 * - SHEET_TAB_VAZIOS_TI (opcional): nome da aba de vazios na sala de TI (padrão: "VaziosSalaTI").
 * - ALERT_WEBHOOK_URL (opcional): webhook (SeaTalk, Slack, Google Chat ou Discord).
 * - SEATALK_APP_ID / SEATALK_APP_SECRET / SEATALK_SIGNING_SECRET / SEATALK_GROUP_ID (opcionais):
 *   bot interativo no SeaTalk com cards, botões de validação e controle rápido.
 * - APP_URL (opcional): URL pública do portal para links nas notificações.
 */

export const TONERS = [
  { ref: "W2150XC", nome: "Preto" },
  { ref: "W2151XC", nome: "Ciano" },
  { ref: "W2152XC", nome: "Amarelo" },
  { ref: "W2153XC", nome: "Magenta" }
];

export const TONER_REFS = TONERS.map(t => t.ref);
export const TONER_MAP = Object.fromEntries(TONERS.map(t => [t.ref, t]));

export const VALID_MOVEMENT_TYPES = new Set([
  "entrada_cheio",
  "saida_cheio",
  "entrada_vazio",
  "saida_vazio"
]);

export const VALID_TURNOS = new Set(["T1", "T2", "T3"]);

export const VALID_VALIDATION_STATUSES = new Set([
  "pendente",
  "validado",
  "divergente"
]);

export const DEFAULT_GOOGLE_CLIENT_ID =
  "1028346342471-oq4rafb2rr864rl3dck10pc3te3ilvsb.apps.googleusercontent.com";

export const DEFAULT_ADMIN_EMAILS = [
  "jefferson.msantos@shopee.com",
  "tacio.correia@shopee.com"
];

export class ApiError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

function parseServiceAccountCredentials(env) {
  const jsonRaw = String(env?.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  if (jsonRaw) {
    let parsed;
    try {
      parsed = JSON.parse(jsonRaw);
    } catch {
      throw new ApiError(
        500,
        "Configuração inválida: GOOGLE_SERVICE_ACCOUNT_JSON não é um JSON válido."
      );
    }
    const email = String(parsed?.client_email || "").trim();
    const privateKey = String(parsed?.private_key || "").trim();
    if (!email || !privateKey) {
      throw new ApiError(
        500,
        "Configuração inválida: GOOGLE_SERVICE_ACCOUNT_JSON precisa conter client_email e private_key."
      );
    }
    return { serviceAccountEmail: email, privateKey };
  }

  const serviceAccountEmail = String(env?.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim();
  const privateKey = String(env?.GOOGLE_PRIVATE_KEY || "").trim();
  if (!serviceAccountEmail || !privateKey) {
    throw new ApiError(
      500,
      "Credenciais da Service Account ausentes. Configure GOOGLE_SERVICE_ACCOUNT_JSON (ou GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY) no Cloudflare Pages."
    );
  }
  return { serviceAccountEmail, privateKey };
}

function parseAdminEmails(raw) {
  const text = String(raw || "").trim();
  if (!text) return [...DEFAULT_ADMIN_EMAILS];
  const emails = text
    .split(/[,\n;]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return emails.length ? emails : [...DEFAULT_ADMIN_EMAILS];
}

export function getRuntimeConfig(env) {
  const sheetId = String(env?.GOOGLE_SHEET_ID || "").trim();
  if (!sheetId) {
    throw new ApiError(
      500,
      "Planilha não configurada. Defina a variável GOOGLE_SHEET_ID no Cloudflare Pages."
    );
  }

  const { serviceAccountEmail, privateKey } = parseServiceAccountCredentials(env);

  return {
    sheetId,
    serviceAccountEmail,
    privateKey,
    googleClientId: String(env?.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID).trim(),
    adminEmails: parseAdminEmails(env?.ADMIN_EMAILS),
    tabs: {
      estoque: String(env?.SHEET_TAB_ESTOQUE || "webinventario").trim(),
      log: String(env?.SHEET_TAB_LOG || "").trim(),
      armarioTI: String(env?.SHEET_TAB_ARMARIO_TI || "ArmarioTI").trim(),
      vaziosTI: String(env?.SHEET_TAB_VAZIOS_TI || "VaziosSalaTI").trim()
    },
    notifications: {
      alertWebhookUrl: String(env?.ALERT_WEBHOOK_URL || "").trim(),
      appUrl: String(env?.APP_URL || "https://guiadeimpressoras.pages.dev").trim().replace(/\/+$/, "")
    },
    seatalk: getSeaTalkConfig(env)
  };
}

export function getSeaTalkConfig(env) {
  return {
    appId: String(env?.SEATALK_APP_ID || "").trim(),
    appSecret: String(env?.SEATALK_APP_SECRET || "").trim(),
    signingSecret: String(env?.SEATALK_SIGNING_SECRET || "").trim(),
    groupId: String(env?.SEATALK_GROUP_ID || "").trim(),
    appUrl: String(env?.APP_URL || "https://guiadeimpressoras.pages.dev").trim().replace(/\/+$/, "")
  };
}
