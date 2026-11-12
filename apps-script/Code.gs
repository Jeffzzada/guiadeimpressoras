/* ═══════════════════════════════════════════════════════════════
   Guia de Impressoras — Backend (Google Apps Script)

   Fluxo:
   - Leitura de estoque é pública (usada pelo indicador do topo).
   - Camada 1: login Google @shopee.com (ID token verificado).
   - Camada 2: cada pessoa precisa ser aprovada por um admin (aba
     "Usuarios"); o 1º login cria a solicitação automaticamente.
   - Registrar movimentação exige as duas camadas.
     A movimentação entra como "pendente" e NÃO altera o estoque.
   - Admins aprovam após validação física → estoque
     é atualizado; ou revogam → nada muda (se já aprovada, o efeito
     no estoque é desfeito).

   Deploy: Implantar → App da Web → Executar como: Eu
           → Quem pode acessar: Qualquer pessoa
   (a autenticação é feita pelo ID token verificado abaixo)
   ═══════════════════════════════════════════════════════════════ */

/* Configuração fica nas Propriedades do script (fora do repositório público):
   Apps Script → Configurações do projeto → Propriedades do script
     SHEET_ID         ID da planilha
     CLIENT_ID        OAuth Client ID (o mesmo do app.js)
     ADMINS_INICIAIS  e-mails separados por vírgula (só usados ao criar a aba Usuarios) */
const PROPS = PropertiesService.getScriptProperties();
const prop = nome => (PROPS.getProperty(nome) || "").trim();
function checarConfig() {
  ["SHEET_ID", "CLIENT_ID"].forEach(n => {
    if (!prop(n)) throw new Error("configuração ausente no Apps Script: " + n);
  });
}
const SHEET_ID        = prop("SHEET_ID");
const CLIENT_ID       = prop("CLIENT_ID");
const ADMINS_INICIAIS = (PROPS.getProperty("ADMINS_INICIAIS") || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const ABA_ESTOQUE  = "webinventario";
const ABA_LOG      = "Movimentações";
const ABA_USUARIOS = "Usuarios";
const DOMINIO      = "shopee.com";

const LOG_HEADER = ["ID", "Data", "Modelo", "Tipo", "Qtd", "Turno", "Responsavel",
                    "Email", "Observacao", "Status", "Revisor", "RevisadoEm"];
const TIPOS = ["entrada_cheio", "saida_cheio", "entrada_vazio", "saida_vazio"];

/* ── Roteamento ── */
function doGet(e) {
  try {
    checarConfig();
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
    checarConfig();
    const payload = JSON.parse(e.postData.contents);
    const user = autenticar(payload.token);          // camada 1: Google OAuth (lança erro se inválido)
    const a = payload.action;

    if (a === "whoami")       return resposta(user);
    // camada 2: permissão individual concedida por um admin
    if (a === "registrar")    return resposta(registrar(payload, exigirAprovado(user)));
    if (a === "aprovar")      return resposta(revisar(payload.id, "aprovado", exigirAdmin(user)));
    if (a === "revogar")      return resposta(revisar(payload.id, "revogado", exigirAdmin(user)));
    if (a === "getUsuarios")  return resposta(listarUsuarios(exigirAdmin(user)));
    if (a === "setUsuario")   return resposta(alterarUsuario(payload, exigirAdmin(user)));
    return resposta({ erro: "ação inválida" });
  } catch (err) {
    return resposta({ erro: String(err.message || err) });
  }
}

/* ── Camada 1: Google OAuth (ID token) ── */
function verificarToken(token) {
  if (!token) throw new Error("não autenticado");

  const cache = CacheService.getScriptCache();
  const key = "tok_" + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const r = UrlFetchApp.fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token),
    { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error("sessão inválida ou expirada");
  const info = JSON.parse(r.getContentText());
  if (info.aud !== CLIENT_ID)                 throw new Error("token de outro app");
  if (String(info.email_verified) !== "true") throw new Error("e-mail não verificado");
  if (info.hd !== DOMINIO)                    throw new Error("use sua conta @" + DOMINIO);
  const ttl = Math.min(600, Number(info.exp) - Math.floor(Date.now() / 1000));
  if (ttl <= 0) throw new Error("sessão expirada");
  cache.put(key, JSON.stringify(info), ttl);
  return info;
}

/* ── Camada 2: permissão por pessoa (aba Usuarios) ──
   Status: pendente → aprovado | bloqueado     Papel: usuario | admin
   O primeiro login cria automaticamente uma solicitação "pendente". */
const USR_HEADER = ["Email", "Nome", "Papel", "Status", "SolicitadoEm", "Revisor", "RevisadoEm"];

function abaUsuarios() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let aba = ss.getSheetByName(ABA_USUARIOS);
  if (!aba) {
    aba = ss.insertSheet(ABA_USUARIOS);
    aba.appendRow(USR_HEADER);
    ADMINS_INICIAIS.forEach(e =>
      aba.appendRow([e.toLowerCase(), "", "admin", "aprovado", new Date(), "sistema", new Date()]));
  }
  return aba;
}

function lerUsuarios() {
  const aba = abaUsuarios();
  const rows = aba.getDataRange().getValues();
  return {
    aba,
    lista: rows.slice(1).map((r, i) => ({
      linha: i + 2,
      email: String(r[0]).toLowerCase().trim(), nome: r[1], papel: r[2] || "usuario",
      status: r[3] || "pendente", solicitadoEm: r[4], revisor: r[5], revisadoEm: r[6]
    })).filter(u => u.email)
  };
}

function autenticar(token) {
  const info  = verificarToken(token);
  const email = String(info.email).toLowerCase();
  const nome  = info.name || email;

  let u = lerUsuarios().lista.find(x => x.email === email);
  if (!u) {
    const lock = LockService.getScriptLock(); lock.waitLock(10000);
    try {
      const { aba, lista } = lerUsuarios();             // relê dentro do lock
      u = lista.find(x => x.email === email);
      if (!u) {
        aba.appendRow([email, nome, "usuario", "pendente", new Date(), "", ""]);
        u = { email, nome, papel: "usuario", status: "pendente" };
      }
    } finally { lock.releaseLock(); }
  }

  const aprovado = u.status === "aprovado";
  return {
    email, nome,
    status:  u.status,                                   // pendente | aprovado | bloqueado
    isAdmin: aprovado && u.papel === "admin",
    podeRegistrar: aprovado
  };
}

function exigirAprovado(user) {
  if (user.status === "bloqueado") throw new Error("seu acesso foi bloqueado por um admin");
  if (!user.podeRegistrar)         throw new Error("seu acesso ainda não foi aprovado por um admin");
  return user;
}

function exigirAdmin(user) {
  if (!user.isAdmin) throw new Error("apenas administradores");
  return user;
}

function listarUsuarios(user) {
  return lerUsuarios().lista.map(u => ({
    email: u.email, nome: u.nome, papel: u.papel, status: u.status,
    solicitadoEm: u.solicitadoEm, revisor: u.revisor, revisadoEm: u.revisadoEm
  }));
}

// payload: { email, status?: "aprovado"|"bloqueado"|"pendente", papel?: "usuario"|"admin" }
function alterarUsuario(payload, user) {
  const email = String(payload.email || "").toLowerCase().trim();
  if (!email.endsWith("@" + DOMINIO)) throw new Error("e-mail inválido");
  if (email === user.email) throw new Error("você não pode alterar o próprio acesso");
  const status = payload.status, papel = payload.papel;
  if (status && ["aprovado", "bloqueado", "pendente"].indexOf(status) < 0) throw new Error("status inválido");
  if (papel  && ["usuario", "admin"].indexOf(papel) < 0)                 throw new Error("papel inválido");

  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const { aba, lista } = lerUsuarios();
    let u = lista.find(x => x.email === email);
    if (!u) {                                            // admin pode pré-cadastrar alguém
      aba.appendRow([email, "", papel || "usuario", status || "aprovado", new Date(), user.email, new Date()]);
    } else {
      if (papel)  aba.getRange(u.linha, 3).setValue(papel);
      if (status) aba.getRange(u.linha, 4).setValue(status);
      aba.getRange(u.linha, 6, 1, 2).setValues([[user.email, new Date()]]);
    }
    return listarUsuarios(user);
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
