/* ═══════════════════════════════════════════════════════════════
   Guia de Impressoras — Backend (Google Apps Script)

   Fluxo:
   - Leitura de estoque é pública (usada pelo indicador do topo).
   - Registrar movimentação exige login Google @shopee.com.
     A movimentação entra como "pendente" e NÃO altera o estoque.
   - Admins (aba "Admins") aprovam após validação física → estoque
     é atualizado; ou revogam → nada muda (se já aprovada, o efeito
     no estoque é desfeito).

   Deploy: Implantar → App da Web → Executar como: Eu
           → Quem pode acessar: Qualquer pessoa
   (a autenticação é feita pelo ID token verificado abaixo)
   ═══════════════════════════════════════════════════════════════ */

const SHEET_ID    = "1hxcjBX7q41HRK3-SqdXT7-nS6r5kWVuK3vi3jcF88Ao";
const ABA_ESTOQUE = "webinventario";
const ABA_LOG     = "Movimentações";
const ABA_ADMINS  = "Admins";

// OAuth Client ID (Google Cloud Console → Credenciais). Igual ao do app.js.
const CLIENT_ID      = "COLE_AQUI_SEU_CLIENT_ID.apps.googleusercontent.com";
const DOMINIO        = "shopee.com";
// Admins iniciais (usados enquanto a aba Admins estiver vazia/inexistente)
const ADMINS_INICIAIS = [];

const LOG_HEADER = ["ID", "Data", "Modelo", "Tipo", "Qtd", "Turno", "Responsavel",
                    "Email", "Observacao", "Status", "Revisor", "RevisadoEm"];
const TIPOS = ["entrada_cheio", "saida_cheio", "entrada_vazio", "saida_vazio"];

/* ── Roteamento ── */
function doGet(e) {
  try {
    const action = e.parameter.action;
    if (action === "getEstoque") return resposta(getEstoque());
    if (action === "getLog")     return resposta(getLog());
    return resposta({ erro: "ação inválida" });
  } catch (err) {
    return resposta({ erro: String(err.message || err) });
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const user = autenticar(payload.token);          // lança erro se inválido

    if (payload.action === "whoami")    return resposta(user);
    if (payload.action === "registrar") return resposta(registrar(payload, user));
    if (payload.action === "aprovar")   return resposta(revisar(payload.id, "aprovado", user));
    if (payload.action === "revogar")   return resposta(revisar(payload.id, "revogado", user));
    if (payload.action === "getAdmins") return resposta(listarAdmins(user));
    if (payload.action === "addAdmin")  return resposta(alterarAdmin(payload.email, true, user));
    if (payload.action === "rmAdmin")   return resposta(alterarAdmin(payload.email, false, user));
    return resposta({ erro: "ação inválida" });
  } catch (err) {
    return resposta({ erro: String(err.message || err) });
  }
}

/* ── Autenticação ── */
function autenticar(token) {
  if (!token) throw new Error("não autenticado");

  const cache = CacheService.getScriptCache();
  const key = "tok_" + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  let info = cache.get(key);

  if (info) {
    info = JSON.parse(info);
  } else {
    const r = UrlFetchApp.fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token),
      { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error("sessão inválida ou expirada");
    info = JSON.parse(r.getContentText());
    if (info.aud !== CLIENT_ID)                       throw new Error("token de outro app");
    if (String(info.email_verified) !== "true")       throw new Error("e-mail não verificado");
    if (info.hd !== DOMINIO)                          throw new Error("use sua conta @" + DOMINIO);
    const ttl = Math.min(600, Number(info.exp) - Math.floor(Date.now() / 1000));
    if (ttl <= 0) throw new Error("sessão expirada");
    cache.put(key, JSON.stringify(info), ttl);
  }

  const email = String(info.email).toLowerCase();
  return { email, nome: info.name || email, isAdmin: getAdmins().indexOf(email) >= 0 };
}

function getAdmins() {
  const aba = SpreadsheetApp.openById(SHEET_ID).getSheetByName(ABA_ADMINS);
  const lista = aba
    ? aba.getDataRange().getValues().slice(1).map(r => String(r[0]).toLowerCase().trim()).filter(Boolean)
    : [];
  return lista.length ? lista : ADMINS_INICIAIS.map(e => e.toLowerCase());
}

function exigirAdmin(user) {
  if (!user.isAdmin) throw new Error("apenas administradores");
}

function listarAdmins(user) {
  exigirAdmin(user);
  return getAdmins();
}

function alterarAdmin(email, adicionar, user) {
  exigirAdmin(user);
  email = String(email || "").toLowerCase().trim();
  if (!email.endsWith("@" + DOMINIO)) throw new Error("e-mail inválido");
  if (!adicionar && email === user.email) throw new Error("você não pode remover a si mesmo");

  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let aba = ss.getSheetByName(ABA_ADMINS);
    if (!aba) {
      aba = ss.insertSheet(ABA_ADMINS);
      aba.appendRow(["Email"]);
      getAdmins().forEach(a => aba.appendRow([a]));   // preserva admins iniciais
    }
    const vals = aba.getDataRange().getValues();
    const idx = vals.findIndex((r, i) => i > 0 && String(r[0]).toLowerCase().trim() === email);
    if (adicionar && idx < 0) aba.appendRow([email]);
    if (!adicionar && idx > 0) aba.deleteRow(idx + 1);
    return getAdmins();
  } finally { lock.releaseLock(); }
}

/* ── Estoque ── */
function getEstoque() {
  const aba  = SpreadsheetApp.openById(SHEET_ID).getSheetByName(ABA_ESTOQUE);
  const rows = aba.getDataRange().getValues();
  const header = rows[0].map(h => h.toString().toLowerCase().trim());

  return rows.slice(1).map(row => {
    const obj = {};
    header.forEach((h, i) => obj[h] = row[i]);
    return {
      ref:     obj["ref"]      || obj["modelo"] || "",
      modelo:  obj["modelo"]   || obj["ref"]    || "",
      cheios:  Number(obj["cheios"])  || 0,
      vazios:  Number(obj["vazios"])  || 0,
      updated: obj["atualizado"] ? new Date(obj["atualizado"]).toISOString() : new Date().toISOString()
    };
  }).filter(r => r.ref);
}

// sinal = +1 aplica a movimentação, -1 desfaz
function aplicarNoEstoque(modelo, tipo, qtd, sinal) {
  const abaEst = SpreadsheetApp.openById(SHEET_ID).getSheetByName(ABA_ESTOQUE);
  const rows   = abaEst.getDataRange().getValues();
  const header = rows[0].map(h => h.toString().toLowerCase().trim());
  const colRef    = header.indexOf("ref");
  const colCheios = header.indexOf("cheios");
  const colVazios = header.indexOf("vazios");
  const colUpd    = header.indexOf("atualizado");

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][colRef] !== modelo) continue;
    let cheios = Number(rows[i][colCheios]) || 0;
    let vazios = Number(rows[i][colVazios]) || 0;
    const d = qtd * sinal;

    if (tipo === "entrada_cheio") cheios += d;
    if (tipo === "saida_cheio")   cheios -= d;
    if (tipo === "entrada_vazio") vazios += d;
    if (tipo === "saida_vazio")   vazios -= d;

    abaEst.getRange(i + 1, colCheios + 1).setValue(Math.max(0, cheios));
    abaEst.getRange(i + 1, colVazios + 1).setValue(Math.max(0, vazios));
    if (colUpd >= 0) abaEst.getRange(i + 1, colUpd + 1).setValue(new Date());
    return;
  }
  throw new Error("modelo não encontrado no estoque: " + modelo);
}

/* ── Log ── */
// Garante a aba e as colunas novas (planilhas antigas recebem as colunas no fim)
function abaLogComColunas() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let aba = ss.getSheetByName(ABA_LOG);
  if (!aba) {
    aba = ss.insertSheet(ABA_LOG);
    aba.appendRow(LOG_HEADER);
    return aba;
  }
  const atual = aba.getRange(1, 1, 1, Math.max(1, aba.getLastColumn())).getValues()[0]
    .map(h => h.toString().toLowerCase().trim());
  LOG_HEADER.forEach(h => {
    if (atual.indexOf(h.toLowerCase()) < 0) {
      aba.getRange(1, atual.length + 1).setValue(h);
      atual.push(h.toLowerCase());
    }
  });
  return aba;
}

function lerLog() {
  const aba = abaLogComColunas();
  const rows = aba.getDataRange().getValues();
  const header = rows[0].map(h => h.toString().toLowerCase().trim());
  return { aba, header, rows };
}

function getLog() {
  const { header, rows } = lerLog();
  return rows.slice(1).reverse().map(row => {
    const obj = {};
    header.forEach((h, i) => obj[h] = row[i]);
    return {
      id:         obj["id"]            || "",
      data:       obj["data"]          || "",
      modelo:     obj["modelo"]        || "",
      tipo:       obj["tipo"]          || "",
      qtd:        Number(obj["qtd"])   || 1,
      turno:      obj["turno"]         || "",
      resp:       obj["responsavel"]   || obj["resp"] || "",
      obs:        obj["observacao"]    || obj["obs"]  || "",
      // linhas antigas (sem status) já tinham alterado o estoque
      status:     obj["status"]        || "aprovado",
      revisor:    obj["revisor"]       || "",
      revisadoEm: obj["revisadoem"]    || ""
    };
  }).filter(r => r.modelo);
}

function registrar(payload, user) {
  if (TIPOS.indexOf(payload.tipo) < 0) throw new Error("tipo inválido");
  const qtd = Math.floor(Number(payload.qtd));
  if (!(qtd >= 1 && qtd <= 20)) throw new Error("quantidade inválida");
  if (!getEstoque().some(r => r.ref === payload.modelo)) throw new Error("modelo inválido");

  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const { aba, header } = lerLog();
    const valores = {
      id: Utilities.getUuid(), data: new Date(), modelo: payload.modelo, tipo: payload.tipo,
      qtd: qtd, turno: String(payload.turno || "").slice(0, 5),
      responsavel: user.nome, email: user.email,
      observacao: String(payload.obs || "").slice(0, 200),
      status: "pendente", revisor: "", revisadoem: ""
    };
    aba.appendRow(header.map(h => valores[h] !== undefined ? valores[h] : ""));
    return { ok: true, id: valores.id, status: "pendente" };
  } finally { lock.releaseLock(); }
}

function revisar(id, novoStatus, user) {
  exigirAdmin(user);
  if (!id) throw new Error("id obrigatório");

  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const { aba, header, rows } = lerLog();
    const c = n => header.indexOf(n);
    const i = rows.findIndex((r, k) => k > 0 && r[c("id")] === id);
    if (i < 0) throw new Error("movimentação não encontrada");

    const row = rows[i];
    const atual = row[c("status")] || "pendente";
    if (atual === novoStatus) return { ok: true, status: atual };
    if (atual === "revogado") throw new Error("movimentação já revogada");

    const qtd = Number(row[c("qtd")]) || 1;
    if (novoStatus === "aprovado") aplicarNoEstoque(row[c("modelo")], row[c("tipo")], qtd, +1);
    if (novoStatus === "revogado" && atual === "aprovado")
      aplicarNoEstoque(row[c("modelo")], row[c("tipo")], qtd, -1);

    aba.getRange(i + 1, c("status") + 1).setValue(novoStatus);
    aba.getRange(i + 1, c("revisor") + 1).setValue(user.email);
    aba.getRange(i + 1, c("revisadoem") + 1).setValue(new Date());
    return { ok: true, status: novoStatus };
  } finally { lock.releaseLock(); }
}

/* ── Helper ── */
function resposta(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
