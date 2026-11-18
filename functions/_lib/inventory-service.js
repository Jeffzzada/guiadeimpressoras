import {
  ApiError,
  TONERS,
  TONER_MAP,
  TONER_REFS,
  VALID_MOVEMENT_TYPES,
  VALID_TURNOS
} from "./config.js";
import { buildA1Range, colToA1 } from "./sheets-client.js";

const INVENTORY_HEADERS = ["ref", "cor", "cheios", "vazios", "updated"];
const ARMARIO_TI_HEADERS = ["ref", "cheios", "atualizadoPor", "atualizadoEm"];
const VAZIOS_TI_HEADERS = ["ref", "qtd", "atualizadoPor", "atualizadoEm"];
const LOG_HEADERS = [
  "id",
  "data",
  "modelo",
  "tipo",
  "qtd",
  "turno",
  "resp",
  "obs",
  "validacao",
  "validadoPor",
  "validadoEm",
  "estornado"
];

const LOG_TAB_CANDIDATES = [
  "Movimentações",
  "Movimentacoes",
  "movimentacoes",
  "Registros",
  "log",
  "Log",
  "Histórico",
  "Historico",
  "historico"
];

const LOG_SCHEMA = {
  id: { header: "id", aliases: ["id"] },
  data: { header: "data", aliases: ["data", "timestamp", "datahora"] },
  modelo: { header: "modelo", aliases: ["modelo", "toner", "ref"] },
  tipo: { header: "tipo", aliases: ["tipo", "movimentacao", "acao"] },
  qtd: { header: "qtd", aliases: ["qtd", "quantidade"] },
  turno: { header: "turno", aliases: ["turno"] },
  resp: { header: "resp", aliases: ["resp", "responsavel"] },
  obs: { header: "obs", aliases: ["obs", "observacao"] },
  validacao: { header: "validacao", aliases: ["validacao", "status"] },
  validadoPor: { header: "validadoPor", aliases: ["validadopor", "revisor"] },
  validadoEm: { header: "validadoEm", aliases: ["validadoem", "revisadoem"] },
  estornado: { header: "estornado", aliases: ["estornado"] }
};

const ESTOQUE_SCHEMA = {
  ref: { header: "ref", aliases: ["ref", "modelo", "codigo"] },
  cor: { header: "cor", aliases: ["cor", "nome"] },
  cheios: { header: "cheios", aliases: ["cheios", "qtd", "quantidade"] },
  vazios: { header: "vazios", aliases: ["vazios"] },
  updated: { header: "updated", aliases: ["updated", "atualizado", "atualizadoem"] }
};

const ARMARIO_TI_SCHEMA = {
  ref: { header: "ref", aliases: ["ref", "modelo", "codigo"] },
  cheios: { header: "cheios", aliases: ["cheios", "qtd", "quantidade"] },
  atualizadoPor: { header: "atualizadoPor", aliases: ["atualizadopor"] },
  atualizadoEm: { header: "atualizadoEm", aliases: ["atualizadoem", "updated", "atualizado"] }
};

const VAZIOS_TI_SCHEMA = {
  ref: { header: "ref", aliases: ["ref", "modelo", "codigo"] },
  qtd: { header: "qtd", aliases: ["qtd", "vazios", "quantidade"] },
  atualizadoPor: { header: "atualizadoPor", aliases: ["atualizadopor"] },
  atualizadoEm: { header: "atualizadoEm", aliases: ["atualizadoem", "updated", "atualizado"] }
};

function normalizeHeader(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, "");
}

function mapColumns(headerRow, schema) {
  const normalizedHeaders = (headerRow || []).map(normalizeHeader);
  const cols = {};
  const missing = [];

  for (const [key, def] of Object.entries(schema)) {
    const idx = normalizedHeaders.findIndex(h => def.aliases.includes(h));
    cols[key] = idx;
    if (idx < 0) missing.push(key);
  }
  return { cols, missing, headerCount: normalizedHeaders.length };
}

function sanitizeTextForSheet(value, maxLen) {
  const cleaned = String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, maxLen);

  if (!cleaned) return "";
  return /^[=+\-@\t\r]/.test(cleaned) ? `'${cleaned}` : cleaned;
}

function readTextFromSheet(value) {
  const str = String(value ?? "");
  return /^'[=+\-@\t\r]/.test(str) ? str.slice(1) : str;
}

function toNonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function normalizeDateFromSheet(value) {
  if (value === null || value === undefined || value === "") return "";
  const str = String(value).trim();
  if (!str) return "";

  const slashMatch = str.match(
    /^(\d{2})\/(\d{2})\/(\d{4})(?:[,\s]+(\d{2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (slashMatch) {
    let [, first, second, yyyy, hh = "00", min = "00", ss = "00"] = slashMatch;
    if (Number(second) > 12 && Number(first) <= 12) {
      [first, second] = [second, first];
    }
    return `${yyyy}-${second}-${first}T${hh}:${min}:${ss}-03:00`;
  }

  return str;
}

function normalizeClientTimestamp(raw) {
  if (raw) {
    const parsed = Date.parse(String(raw));
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

function normalizeValidationStatus(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "validado" || s === "aprovado") return "validado";
  if (s === "divergente" || s === "revogado") return "divergente";
  return "pendente";
}

function applyMovementDelta(stock, tipo, qtd, sign) {
  const delta = qtd * sign;
  if (tipo === "entrada_cheio") stock.cheios = Math.max(0, stock.cheios + delta);
  else if (tipo === "saida_cheio") stock.cheios = Math.max(0, stock.cheios - delta);
  else if (tipo === "entrada_vazio") stock.vazios = Math.max(0, stock.vazios + delta);
  else if (tipo === "saida_vazio") stock.vazios = Math.max(0, stock.vazios - delta);
}

function validateMovementItem(item) {
  const modelo = String(item?.modelo || "").trim().toUpperCase();
  const tipo = String(item?.tipo || "").trim();
  const rawQtd = item?.qtd;
  const qtd = typeof rawQtd === "string" && !/^\d+$/.test(rawQtd.trim()) ? NaN : Number(rawQtd);

  if (!TONER_MAP[modelo]) {
    throw new ApiError(400, `Modelo de toner inválido: "${item?.modelo || ""}".`);
  }
  if (!VALID_MOVEMENT_TYPES.has(tipo)) {
    throw new ApiError(400, `Tipo de movimentação inválido: "${tipo}".`);
  }
  if (!Number.isInteger(qtd) || qtd < 1 || qtd > 20) {
    throw new ApiError(400, "A quantidade deve ser um número inteiro entre 1 e 20.");
  }

  return { modelo, tipo, qtd };
}

function validateMovementMeta(payload) {
  const resp = sanitizeTextForSheet(payload?.resp, 100);
  if (!resp) {
    throw new ApiError(400, "Informe o nome do responsável pela movimentação.");
  }

  const turno = String(payload?.turno || "T1").trim().toUpperCase();
  if (!VALID_TURNOS.has(turno)) {
    throw new ApiError(400, `Turno inválido: "${payload?.turno}". Use T1, T2 ou T3.`);
  }

  const obs = sanitizeTextForSheet(payload?.obs, 250);
  const data = normalizeClientTimestamp(payload?.data);

  return { resp, turno, obs, data };
}

export function createInventoryService(sheetsClient, config) {
  const fixedTabs = {
    estoque: config.tabs.estoque,
    armarioTI: config.tabs.armarioTI,
    vaziosTI: config.tabs.vaziosTI
  };
  let resolvedLogTabTitle = config.tabs.log || "";

  async function resolveLogTabTitle() {
    if (resolvedLogTabTitle) return resolvedLogTabTitle;

    const meta = await sheetsClient.getMetadata(false);
    const titles = [...meta.sheetIdsByTitle.keys()];

    for (const candidate of LOG_TAB_CANDIDATES) {
      if (meta.sheetIdsByTitle.has(candidate)) {
        resolvedLogTabTitle = candidate;
        return resolvedLogTabTitle;
      }
    }

    const reserved = new Set([fixedTabs.estoque, fixedTabs.armarioTI, fixedTabs.vaziosTI]);
    const extraTitles = titles.filter(t => !reserved.has(t));
    if (extraTitles.length) {
      const samples = await sheetsClient.batchGetValues(
        extraTitles.map(t => buildA1Range(t, "A1:Z15"))
      );

      for (let i = 0; i < extraTitles.length; i++) {
        const rows = samples[i] || [];
        const hasMovementValue = rows.some(r =>
          (r || []).some(cell => VALID_MOVEMENT_TYPES.has(String(cell || "").trim()))
        );
        if (hasMovementValue) {
          resolvedLogTabTitle = extraTitles[i];
          return resolvedLogTabTitle;
        }
      }

      for (let i = 0; i < extraTitles.length; i++) {
        const rows = samples[i] || [];
        const headerNorm = (rows[0] || []).map(normalizeHeader);
        if (headerNorm.includes("modelo") && headerNorm.includes("tipo")) {
          resolvedLogTabTitle = extraTitles[i];
          return resolvedLogTabTitle;
        }
      }
    }

    resolvedLogTabTitle = LOG_TAB_CANDIDATES[0];
    return resolvedLogTabTitle;
  }

  async function resolveTabTitles(tabKeys) {
    const map = {};
    for (const key of tabKeys) {
      map[key] = key === "log" ? await resolveLogTabTitle() : fixedTabs[key];
    }
    return map;
  }

  function buildInitialRows(tabKey) {
    if (tabKey === "estoque") {
      return [INVENTORY_HEADERS, ...TONERS.map(t => [t.ref, t.nome, 0, 0, ""])];
    }
    if (tabKey === "armarioTI") {
      return [ARMARIO_TI_HEADERS, ...TONERS.map(t => [t.ref, 0, "", ""])];
    }
    if (tabKey === "vaziosTI") {
      return [VAZIOS_TI_HEADERS, ...TONERS.map(t => [t.ref, 0, "", ""])];
    }
    if (tabKey === "log") {
      return [LOG_HEADERS];
    }
    return [];
  }

  async function ensureTabs(tabKeys, titlesByKey) {
    const meta = await sheetsClient.getMetadata(true);
    const created = [];

    for (const key of tabKeys) {
      const title = titlesByKey[key];
      if (!meta.sheetIdsByTitle.has(title)) {
        await sheetsClient.addSheet(title);
        const seedRows = buildInitialRows(key);
        if (seedRows.length) {
          await sheetsClient.appendRows(title, seedRows);
        }
        created.push(title);
      }
    }
    return created;
  }

  async function batchGetWithAutoInit(tabKeys) {
    const titlesByKey = await resolveTabTitles(tabKeys);
    const ranges = tabKeys.map(k => buildA1Range(titlesByKey[k]));
    try {
      const values = await sheetsClient.batchGetValues(ranges);
      return { values, titlesByKey };
    } catch (err) {
      if (err?.code === "MISSING_RANGE") {
        await ensureTabs(tabKeys, titlesByKey);
        const values = await sheetsClient.batchGetValues(ranges);
        return { values, titlesByKey };
      }
      throw err;
    }
  }

  async function ensureTonerTableRows(tabKey, tabTitle, rows, schema, defaultHeaders, buildDefaultRow) {
    let workingRows = Array.isArray(rows) ? rows : [];

    if (!workingRows.length) {
      const seed = buildInitialRows(tabKey);
      await sheetsClient.appendRows(tabTitle, seed);
      workingRows = seed;
    }

    let { cols } = mapColumns(workingRows[0], schema);
    const headerRow = [...workingRows[0]];
    const missingCols = Object.entries(schema).filter(([k]) => cols[k] < 0);

    if (missingCols.length) {
      for (const [k, def] of missingCols) {
        if (k === "cor") continue;
        cols[k] = headerRow.length;
        headerRow.push(def.header);
      }
      if (headerRow.length > workingRows[0].length) {
        await sheetsClient.batchUpdateValues([
          {
            range: buildA1Range(tabTitle, `A1:${colToA1(headerRow.length - 1)}1`),
            values: [headerRow]
          }
        ]);
        workingRows[0] = headerRow;
      }
    }

    const rowMap = new Map();
    for (let i = 1; i < workingRows.length; i++) {
      const row = workingRows[i] || [];
      const ref = String(row[cols.ref] || "").trim().toUpperCase();
      if (TONER_MAP[ref] && !rowMap.has(ref)) {
        rowMap.set(ref, { sheetRowIndex: i, row });
      }
    }

    const missingRefs = TONERS.filter(t => !rowMap.has(t.ref));
    if (missingRefs.length) {
      const rowsToAppend = missingRefs.map(t => buildDefaultRow(t, cols, headerRow.length));
      await sheetsClient.appendRows(tabTitle, rowsToAppend);
      const refreshed = await sheetsClient.getValues(buildA1Range(tabTitle));
      workingRows = refreshed;
      ({ cols } = mapColumns(workingRows[0] || defaultHeaders, schema));
      rowMap.clear();
      for (let i = 1; i < workingRows.length; i++) {
        const row = workingRows[i] || [];
        const ref = String(row[cols.ref] || "").trim().toUpperCase();
        if (TONER_MAP[ref] && !rowMap.has(ref)) {
          rowMap.set(ref, { sheetRowIndex: i, row });
        }
      }
    }

    return { cols, rowMap };
  }

  async function ensureLogTable(logTabTitle, rawRows) {
    let rows = Array.isArray(rawRows) ? rawRows : [];

    if (!rows.length) {
      await sheetsClient.appendRows(logTabTitle, [LOG_HEADERS]);
      rows = [LOG_HEADERS];
    }

    const headerRow = [...rows[0]];
    const { cols, missing } = mapColumns(headerRow, LOG_SCHEMA);

    if (missing.length) {
      for (const field of missing) {
        cols[field] = headerRow.length;
        headerRow.push(LOG_SCHEMA[field].header);
      }
      await sheetsClient.batchUpdateValues([
        {
          range: buildA1Range(logTabTitle, `A1:${colToA1(headerRow.length - 1)}1`),
          values: [headerRow]
        }
      ]);
      rows[0] = headerRow;
    }

    return { rows, cols, headerLength: headerRow.length };
  }

  function parseEstoqueState(estoqueRows, armarioTIRows) {
    const estCols = mapColumns(estoqueRows[0] || INVENTORY_HEADERS, ESTOQUE_SCHEMA).cols;
    const tiCols = mapColumns(armarioTIRows[0] || ARMARIO_TI_HEADERS, ARMARIO_TI_SCHEMA).cols;

    const tiByRef = Object.fromEntries(TONER_REFS.map(r => [r, 0]));
    for (let i = 1; i < armarioTIRows.length; i++) {
      const row = armarioTIRows[i] || [];
      const ref = String(row[tiCols.ref] || "").trim().toUpperCase();
      if (ref in tiByRef) {
        tiByRef[ref] = toNonNegativeInt(row[tiCols.cheios], 0);
      }
    }

    const estByRef = Object.fromEntries(
      TONER_REFS.map(r => [r, { ref: r, cheios: 0, vazios: 0, updated: "", sheetRowIndex: -1 }])
    );

    for (let i = 1; i < estoqueRows.length; i++) {
      const row = estoqueRows[i] || [];
      const ref = String(row[estCols.ref] || "").trim().toUpperCase();
      if (ref in estByRef) {
        estByRef[ref] = {
          ref,
          cheios: toNonNegativeInt(row[estCols.cheios], 0),
          vazios: toNonNegativeInt(row[estCols.vazios], 0),
          updated: estCols.updated >= 0 ? normalizeDateFromSheet(row[estCols.updated]) : "",
          sheetRowIndex: i
        };
      }
    }

    const publicList = TONER_REFS.map(ref => {
      const item = estByRef[ref];
      return {
        ref: item.ref,
        cheios: item.cheios,
        vazios: item.vazios,
        solicitarTI: item.cheios < (tiByRef[ref] || 0),
        updated: item.updated
      };
    });

    return { estCols, estByRef, tiByRef, publicList };
  }

  function buildPublicEstoqueList(estByRef, tiByRef) {
    return TONER_REFS.map(ref => {
      const item = estByRef[ref];
      return {
        ref,
        cheios: item.cheios,
        vazios: item.vazios,
        solicitarTI: item.cheios < (tiByRef[ref] || 0),
        updated: item.updated
      };
    });
  }

  function parseLogEntries(rows, cols) {
    const entries = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const modelo = String(row[cols.modelo] || "").trim().toUpperCase();
      if (!modelo) continue;

      const rawData = row[cols.data] ?? "";
      const estornadoVal =
        cols.estornado >= 0 ? String(row[cols.estornado] || "").trim().toLowerCase() : "";

      entries.push({
        sheetRowIndex: i,
        id: cols.id >= 0 ? String(row[cols.id] || "").trim() : "",
        rawData: String(rawData),
        data: normalizeDateFromSheet(rawData),
        modelo,
        tipo: String(row[cols.tipo] || "").trim(),
        qtd: Math.max(1, toNonNegativeInt(row[cols.qtd], 1)),
        turno: String(row[cols.turno] || "").trim(),
        resp: readTextFromSheet(row[cols.resp]),
        obs: cols.obs >= 0 ? readTextFromSheet(row[cols.obs]) : "",
        validacao: normalizeValidationStatus(cols.validacao >= 0 ? row[cols.validacao] : ""),
        validadoPor: cols.validadoPor >= 0 ? String(row[cols.validadoPor] || "").trim() : "",
        validadoEm:
          cols.validadoEm >= 0 ? normalizeDateFromSheet(row[cols.validadoEm]) : "",
        estornadoSim: estornadoVal === "sim"
      });
    }

    const reversed = entries.reverse();
    reversed.forEach((entry, idx) => {
      entry.reversedIdx = idx;
    });
    return reversed;
  }

  function findLogEntryById(entries, targetId) {
    const id = String(targetId || "").trim();
    if (!id) return null;

    const exact = entries.find(e => e.id && e.id === id);
    if (exact) return exact;

    return (
      entries.find(e => {
        const legacyData = `${e.data || e.reversedIdx}_${e.modelo}_${e.resp}`;
        const legacyRaw = `${e.rawData || e.reversedIdx}_${e.modelo}_${e.resp}`;
        const legacyDataNoIdx = `${e.data}_${e.modelo}_${e.resp}`;
        return legacyData === id || legacyRaw === id || legacyDataNoIdx === id;
      }) || null
    );
  }

  function buildEstoqueRowUpdates(estByRef, estCols, touchedRefs, updatedAtIso) {
    const updates = [];
    for (const ref of touchedRefs) {
      const item = estByRef[ref];
      if (!item || item.sheetRowIndex < 1) continue;
      const rowNum = item.sheetRowIndex + 1;
      if (estCols.cheios >= 0) {
        updates.push({
          range: buildA1Range(fixedTabs.estoque, `${colToA1(estCols.cheios)}${rowNum}`),
          values: [[item.cheios]]
        });
      }
      if (estCols.vazios >= 0) {
        updates.push({
          range: buildA1Range(fixedTabs.estoque, `${colToA1(estCols.vazios)}${rowNum}`),
          values: [[item.vazios]]
        });
      }
      if (estCols.updated >= 0) {
        item.updated = updatedAtIso;
        updates.push({
          range: buildA1Range(fixedTabs.estoque, `${colToA1(estCols.updated)}${rowNum}`),
          values: [[updatedAtIso]]
        });
      }
    }
    return updates;
  }

  async function getEstoque() {
    const { values } = await batchGetWithAutoInit(["estoque", "armarioTI"]);
    const [estoqueRows, armarioTIRows] = values;
    const { publicList } = parseEstoqueState(estoqueRows, armarioTIRows);
    return publicList;
  }

  async function getLog() {
    const { values } = await batchGetWithAutoInit(["log"]);
    const [logRows] = values;
    if (!logRows.length) return [];

    const { cols } = mapColumns(logRows[0], LOG_SCHEMA);
    if (cols.modelo < 0) return [];

    return parseLogEntries(logRows, cols).map(e => ({
      id: e.id || `${e.data}_${e.modelo}_${e.resp}`,
      data: e.data,
      modelo: e.modelo,
      tipo: e.tipo,
      qtd: e.qtd,
      turno: e.turno,
      resp: e.resp,
      obs: e.obs,
      validacao: e.validacao,
      validadoPor: e.validadoPor,
      validadoEm: e.validadoEm
    }));
  }

  async function registrarMovimentos(payload, rawMovimentos) {
    const { resp, turno, obs, data } = validateMovementMeta(payload);
    if (!Array.isArray(rawMovimentos) || !rawMovimentos.length) {
      throw new ApiError(400, "Informe ao menos uma movimentação.");
    }
    if (rawMovimentos.length > 20) {
      throw new ApiError(400, "Limite máximo de 20 movimentações por lote.");
    }

    const movimentos = rawMovimentos.map(validateMovementItem);

    const { values, titlesByKey } = await batchGetWithAutoInit([
      "estoque",
      "armarioTI",
      "log"
    ]);
    const [rawEstoqueRows, rawArmarioTIRows, rawLogRows] = values;

    const { cols: estCols, rowMap: estRowMap } = await ensureTonerTableRows(
      "estoque",
      titlesByKey.estoque,
      rawEstoqueRows,
      ESTOQUE_SCHEMA,
      INVENTORY_HEADERS,
      (t, c, len) => {
        const row = new Array(len).fill("");
        row[c.ref] = t.ref;
        if (c.cor >= 0) row[c.cor] = t.nome;
        row[c.cheios] = 0;
        row[c.vazios] = 0;
        return row;
      }
    );

    const { cols: logCols, headerLength } = await ensureLogTable(titlesByKey.log, rawLogRows);

    const estByRef = {};
    for (const ref of TONER_REFS) {
      const entry = estRowMap.get(ref);
      const row = entry.row || [];
      estByRef[ref] = {
        ref,
        cheios: toNonNegativeInt(row[estCols.cheios], 0),
        vazios: toNonNegativeInt(row[estCols.vazios], 0),
        updated: estCols.updated >= 0 ? normalizeDateFromSheet(row[estCols.updated]) : "",
        sheetRowIndex: entry.sheetRowIndex
      };
    }

    const tiCols = mapColumns(rawArmarioTIRows[0] || ARMARIO_TI_HEADERS, ARMARIO_TI_SCHEMA).cols;
    const tiByRef = Object.fromEntries(TONER_REFS.map(r => [r, 0]));
    for (let i = 1; i < rawArmarioTIRows.length; i++) {
      const row = rawArmarioTIRows[i] || [];
      const ref = String(row[tiCols.ref] || "").trim().toUpperCase();
      if (ref in tiByRef) tiByRef[ref] = toNonNegativeInt(row[tiCols.cheios], 0);
    }

    const touchedRefs = new Set();
    const ids = [];
    const rowsToAppend = [];

    for (const mov of movimentos) {
      const stock = estByRef[mov.modelo];
      applyMovementDelta(stock, mov.tipo, mov.qtd, +1);
      touchedRefs.add(mov.modelo);

      const id = crypto.randomUUID();
      ids.push(id);

      const row = new Array(headerLength).fill("");
      row[logCols.id] = id;
      row[logCols.data] = data;
      row[logCols.modelo] = mov.modelo;
      row[logCols.tipo] = mov.tipo;
      row[logCols.qtd] = mov.qtd;
      row[logCols.turno] = turno;
      row[logCols.resp] = resp;
      row[logCols.obs] = obs;
      row[logCols.validacao] = "pendente";
      row[logCols.validadoPor] = "";
      row[logCols.validadoEm] = "";
      row[logCols.estornado] = "";
      rowsToAppend.push(row);
    }

    await sheetsClient.appendRows(titlesByKey.log, rowsToAppend);

    const stockUpdates = buildEstoqueRowUpdates(estByRef, estCols, touchedRefs, data);
    if (stockUpdates.length) {
      await sheetsClient.batchUpdateValues(stockUpdates);
    }

    return {
      ok: true,
      id: ids[0],
      ids,
      validacao: "pendente",
      estoque: buildPublicEstoqueList(estByRef, tiByRef),
      notificationData: {
        movimentos,
        resp: readTextFromSheet(resp),
        turno,
        obs: readTextFromSheet(obs),
        data
      }
    };
  }

  async function registrar(payload) {
    return registrarMovimentos(payload, [
      {
        modelo: payload?.modelo,
        tipo: payload?.tipo,
        qtd: payload?.qtd
      }
    ]);
  }

  async function registrarLote(payload) {
    return registrarMovimentos(payload, payload?.movimentos);
  }

  async function validarMovimentos(targetIds, status, adminUser, { requireSingleFound = false } = {}) {
    if (status !== "validado" && status !== "divergente") {
      throw new ApiError(400, `Status de validação inválido: "${status}".`);
    }
    if (!Array.isArray(targetIds) || !targetIds.length) {
      throw new ApiError(400, "Informe ao menos um ID de movimentação.");
    }

    const { values, titlesByKey } = await batchGetWithAutoInit([
      "log",
      "estoque",
      "armarioTI"
    ]);
    const [rawLogRows, rawEstoqueRows, rawArmarioTIRows] = values;

    const { rows: logRows, cols: logCols } = await ensureLogTable(titlesByKey.log, rawLogRows);
    const { cols: estCols, rowMap: estRowMap } = await ensureTonerTableRows(
      "estoque",
      titlesByKey.estoque,
      rawEstoqueRows,
      ESTOQUE_SCHEMA,
      INVENTORY_HEADERS,
      (t, c, len) => {
        const row = new Array(len).fill("");
        row[c.ref] = t.ref;
        if (c.cor >= 0) row[c.cor] = t.nome;
        row[c.cheios] = 0;
        row[c.vazios] = 0;
        return row;
      }
    );

    const estByRef = {};
    for (const ref of TONER_REFS) {
      const entry = estRowMap.get(ref);
      const row = entry.row || [];
      estByRef[ref] = {
        ref,
        cheios: toNonNegativeInt(row[estCols.cheios], 0),
        vazios: toNonNegativeInt(row[estCols.vazios], 0),
        updated: estCols.updated >= 0 ? normalizeDateFromSheet(row[estCols.updated]) : "",
        sheetRowIndex: entry.sheetRowIndex
      };
    }

    const tiCols = mapColumns(rawArmarioTIRows[0] || ARMARIO_TI_HEADERS, ARMARIO_TI_SCHEMA).cols;
    const tiByRef = Object.fromEntries(TONER_REFS.map(r => [r, 0]));
    for (let i = 1; i < rawArmarioTIRows.length; i++) {
      const row = rawArmarioTIRows[i] || [];
      const ref = String(row[tiCols.ref] || "").trim().toUpperCase();
      if (ref in tiByRef) tiByRef[ref] = toNonNegativeInt(row[tiCols.cheios], 0);
    }

    const entries = parseLogEntries(logRows, logCols);
    const uniqueIds = [...new Set(targetIds.map(id => String(id || "").trim()).filter(Boolean))];
    const nowIso = new Date().toISOString();
    const touchedRefs = new Set();
    const logCellUpdates = [];
    const seenSheetRows = new Set();
    let updatedCount = 0;

    for (const targetId of uniqueIds) {
      const entry = findLogEntryById(entries, targetId);
      if (!entry) {
        if (requireSingleFound) {
          throw new ApiError(404, "Movimentação não encontrada na planilha.");
        }
        continue;
      }
      if (seenSheetRows.has(entry.sheetRowIndex)) continue;
      seenSheetRows.add(entry.sheetRowIndex);

      const rowNum = entry.sheetRowIndex + 1;
      const jaEstornado = entry.estornadoSim;
      let nextEstornado = jaEstornado ? "sim" : "";
      let changed = false;

      if (status === "divergente" && !jaEstornado) {
        if (estByRef[entry.modelo]) {
          applyMovementDelta(estByRef[entry.modelo], entry.tipo, entry.qtd, -1);
          touchedRefs.add(entry.modelo);
        }
        nextEstornado = "sim";
        changed = true;
      } else if (status === "validado" && jaEstornado) {
        if (estByRef[entry.modelo]) {
          applyMovementDelta(estByRef[entry.modelo], entry.tipo, entry.qtd, +1);
          touchedRefs.add(entry.modelo);
        }
        nextEstornado = "";
        changed = true;
      }

      if (entry.validacao !== status) {
        changed = true;
      }

      if (!changed) continue;

      if (!entry.id && logCols.id >= 0) {
        logCellUpdates.push({
          range: buildA1Range(titlesByKey.log, `${colToA1(logCols.id)}${rowNum}`),
          values: [[crypto.randomUUID()]]
        });
      }
      logCellUpdates.push(
        {
          range: buildA1Range(titlesByKey.log, `${colToA1(logCols.validacao)}${rowNum}`),
          values: [[status]]
        },
        {
          range: buildA1Range(titlesByKey.log, `${colToA1(logCols.validadoPor)}${rowNum}`),
          values: [[adminUser.email]]
        },
        {
          range: buildA1Range(titlesByKey.log, `${colToA1(logCols.validadoEm)}${rowNum}`),
          values: [[nowIso]]
        },
        {
          range: buildA1Range(titlesByKey.log, `${colToA1(logCols.estornado)}${rowNum}`),
          values: [[nextEstornado]]
        }
      );
      updatedCount++;
    }

    const stockUpdates = buildEstoqueRowUpdates(estByRef, estCols, touchedRefs, nowIso);
    const allUpdates = [...stockUpdates, ...logCellUpdates];
    if (allUpdates.length) {
      await sheetsClient.batchUpdateValues(allUpdates);
    }

    return {
      ok: true,
      status,
      validacao: status,
      estornado: status === "divergente",
      atualizados: updatedCount,
      updatedCount,
      estoque: buildPublicEstoqueList(estByRef, tiByRef)
    };
  }

  async function validar(payload, adminUser) {
    const res = await validarMovimentos([payload?.id], payload?.status, adminUser, {
      requireSingleFound: true
    });
    return { ...res, id: String(payload?.id || "").trim() };
  }

  async function validarLote(payload, adminUser) {
    return validarMovimentos(payload?.ids, payload?.status, adminUser, {
      requireSingleFound: false
    });
  }

  async function remover(payload) {
    const id = String(payload?.id || "").trim();
    if (!id) {
      throw new ApiError(400, "ID da movimentação obrigatório.");
    }

    const { values, titlesByKey } = await batchGetWithAutoInit([
      "log",
      "estoque",
      "armarioTI"
    ]);
    const [rawLogRows, rawEstoqueRows, rawArmarioTIRows] = values;

    const { rows: logRows, cols: logCols } = await ensureLogTable(titlesByKey.log, rawLogRows);
    const entries = parseLogEntries(logRows, logCols);
    const entry = findLogEntryById(entries, id);
    if (!entry) {
      throw new ApiError(404, "Movimentação não encontrada na planilha.");
    }

    if (entry.validacao !== "divergente") {
      throw new ApiError(400, "Apenas movimentações divergentes podem ser removidas.");
    }

    const { cols: estCols, rowMap: estRowMap } = await ensureTonerTableRows(
      "estoque",
      titlesByKey.estoque,
      rawEstoqueRows,
      ESTOQUE_SCHEMA,
      INVENTORY_HEADERS,
      (t, c, len) => {
        const row = new Array(len).fill("");
        row[c.ref] = t.ref;
        if (c.cor >= 0) row[c.cor] = t.nome;
        row[c.cheios] = 0;
        row[c.vazios] = 0;
        return row;
      }
    );

    const estByRef = {};
    for (const ref of TONER_REFS) {
      const rowEntry = estRowMap.get(ref);
      const row = rowEntry.row || [];
      estByRef[ref] = {
        ref,
        cheios: toNonNegativeInt(row[estCols.cheios], 0),
        vazios: toNonNegativeInt(row[estCols.vazios], 0),
        updated: estCols.updated >= 0 ? normalizeDateFromSheet(row[estCols.updated]) : "",
        sheetRowIndex: rowEntry.sheetRowIndex
      };
    }

    const tiCols = mapColumns(rawArmarioTIRows[0] || ARMARIO_TI_HEADERS, ARMARIO_TI_SCHEMA).cols;
    const tiByRef = Object.fromEntries(TONER_REFS.map(r => [r, 0]));
    for (let i = 1; i < rawArmarioTIRows.length; i++) {
      const row = rawArmarioTIRows[i] || [];
      const ref = String(row[tiCols.ref] || "").trim().toUpperCase();
      if (ref in tiByRef) tiByRef[ref] = toNonNegativeInt(row[tiCols.cheios], 0);
    }

    // Só estorna na remoção se o registro ainda não tiver estornado="sim"
    if (!entry.estornadoSim && estByRef[entry.modelo]) {
      applyMovementDelta(estByRef[entry.modelo], entry.tipo, entry.qtd, -1);
      const nowIso = new Date().toISOString();
      const stockUpdates = buildEstoqueRowUpdates(
        estByRef,
        estCols,
        new Set([entry.modelo]),
        nowIso
      );
      if (stockUpdates.length) {
        await sheetsClient.batchUpdateValues(stockUpdates);
      }
    }

    await sheetsClient.deleteRow(titlesByKey.log, entry.sheetRowIndex);

    return {
      ok: true,
      removed: true,
      id,
      estoque: buildPublicEstoqueList(estByRef, tiByRef)
    };
  }

  async function zerarEstoque(adminUser) {
    const { values, titlesByKey } = await batchGetWithAutoInit([
      "estoque",
      "armarioTI"
    ]);
    const [rawEstoqueRows, rawArmarioTIRows] = values;

    const { cols: estCols, rowMap: estRowMap } = await ensureTonerTableRows(
      "estoque",
      titlesByKey.estoque,
      rawEstoqueRows,
      ESTOQUE_SCHEMA,
      INVENTORY_HEADERS,
      (t, c, len) => {
        const row = new Array(len).fill("");
        row[c.ref] = t.ref;
        if (c.cor >= 0) row[c.cor] = t.nome;
        row[c.cheios] = 0;
        row[c.vazios] = 0;
        return row;
      }
    );

    const nowIso = new Date().toISOString();
    const estByRef = {};
    for (const ref of TONER_REFS) {
      estByRef[ref] = {
        ref,
        cheios: 0,
        vazios: 0,
        updated: nowIso,
        sheetRowIndex: estRowMap.get(ref).sheetRowIndex
      };
    }

    const tiCols = mapColumns(rawArmarioTIRows[0] || ARMARIO_TI_HEADERS, ARMARIO_TI_SCHEMA).cols;
    const tiByRef = Object.fromEntries(TONER_REFS.map(r => [r, 0]));
    for (let i = 1; i < rawArmarioTIRows.length; i++) {
      const row = rawArmarioTIRows[i] || [];
      const ref = String(row[tiCols.ref] || "").trim().toUpperCase();
      if (ref in tiByRef) tiByRef[ref] = toNonNegativeInt(row[tiCols.cheios], 0);
    }

    const updates = buildEstoqueRowUpdates(estByRef, estCols, new Set(TONER_REFS), nowIso);
    if (updates.length) {
      await sheetsClient.batchUpdateValues(updates);
    }

    return {
      ok: true,
      zeradoPor: adminUser.email,
      estoque: buildPublicEstoqueList(estByRef, tiByRef)
    };
  }

  async function getContagemTI(tabKey, schema, defaultHeaders, valueKey) {
    const { values } = await batchGetWithAutoInit([tabKey]);
    const [rows] = values;
    const cols = mapColumns(rows[0] || defaultHeaders, schema).cols;
    const byRef = Object.fromEntries(
      TONER_REFS.map(r => [r, { ref: r, [valueKey]: 0, atualizadoPor: "", atualizadoEm: "" }])
    );

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const ref = String(row[cols.ref] || "").trim().toUpperCase();
      if (ref in byRef) {
        byRef[ref] = {
          ref,
          [valueKey]: toNonNegativeInt(row[cols[valueKey]], 0),
          atualizadoPor: cols.atualizadoPor >= 0 ? String(row[cols.atualizadoPor] || "") : "",
          atualizadoEm:
            cols.atualizadoEm >= 0 ? normalizeDateFromSheet(row[cols.atualizadoEm]) : ""
        };
      }
    }

    return TONER_REFS.map(ref => byRef[ref]);
  }

  function extractContagemMap(payload, valueKey) {
    if (payload?.itens && typeof payload.itens === "object" && !Array.isArray(payload.itens)) {
      return payload.itens;
    }
    if (payload?.ref) {
      const ref = String(payload.ref).trim().toUpperCase();
      const val = payload[valueKey] !== undefined ? payload[valueKey] : payload.qtd;
      return { [ref]: val };
    }
    throw new ApiError(400, "Formato inválido para itens.");
  }

  async function setContagemTI(tabKey, schema, defaultHeaders, valueKey, payload, adminUser) {
    const itensPayload = extractContagemMap(payload, valueKey);
    const tabKeys = tabKey === "armarioTI" ? ["armarioTI", "estoque"] : [tabKey];
    const { values, titlesByKey } = await batchGetWithAutoInit(tabKeys);
    const rawTIRows = values[0];

    const { cols, rowMap } = await ensureTonerTableRows(
      tabKey,
      titlesByKey[tabKey],
      rawTIRows,
      schema,
      defaultHeaders,
      (t, c, len) => {
        const row = new Array(len).fill("");
        row[c.ref] = t.ref;
        row[c[valueKey]] = 0;
        return row;
      }
    );

    const nowIso = new Date().toISOString();
    const updates = [];
    const tiByRef = {};

    for (const ref of TONER_REFS) {
      const entry = rowMap.get(ref);
      const currentVal = toNonNegativeInt(entry.row?.[cols[valueKey]], 0);

      let nextVal = currentVal;
      if (Object.prototype.hasOwnProperty.call(itensPayload, ref)) {
        const parsed = Number(itensPayload[ref]);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 999) {
          throw new ApiError(400, `Quantidade inválida para ${ref}.`);
        }
        nextVal = parsed;
      }

      tiByRef[ref] = nextVal;
      const rowNum = entry.sheetRowIndex + 1;
      updates.push({
        range: buildA1Range(titlesByKey[tabKey], `${colToA1(cols[valueKey])}${rowNum}`),
        values: [[nextVal]]
      });
      if (cols.atualizadoPor >= 0) {
        updates.push({
          range: buildA1Range(titlesByKey[tabKey], `${colToA1(cols.atualizadoPor)}${rowNum}`),
          values: [[adminUser.email]]
        });
      }
      if (cols.atualizadoEm >= 0) {
        updates.push({
          range: buildA1Range(titlesByKey[tabKey], `${colToA1(cols.atualizadoEm)}${rowNum}`),
          values: [[nowIso]]
        });
      }
    }

    if (updates.length) {
      await sheetsClient.batchUpdateValues(updates);
    }

    const itens = TONER_REFS.map(ref => ({
      ref,
      [valueKey]: tiByRef[ref],
      atualizadoPor: adminUser.email,
      atualizadoEm: nowIso
    }));

    if (tabKey === "armarioTI") {
      const rawEstoqueRows = values[1] || [];
      const estState = parseEstoqueState(rawEstoqueRows, []);
      return {
        ok: true,
        itens,
        estoque: buildPublicEstoqueList(estState.estByRef, tiByRef)
      };
    }

    return { ok: true, itens };
  }

  async function getArmarioTI() {
    return getContagemTI("armarioTI", ARMARIO_TI_SCHEMA, ARMARIO_TI_HEADERS, "cheios");
  }

  async function setArmarioTI(payload, adminUser) {
    return setContagemTI(
      "armarioTI",
      ARMARIO_TI_SCHEMA,
      ARMARIO_TI_HEADERS,
      "cheios",
      payload,
      adminUser
    );
  }

  async function getVaziosTI() {
    return getContagemTI("vaziosTI", VAZIOS_TI_SCHEMA, VAZIOS_TI_HEADERS, "qtd");
  }

  async function setVaziosTI(payload, adminUser) {
    return setContagemTI(
      "vaziosTI",
      VAZIOS_TI_SCHEMA,
      VAZIOS_TI_HEADERS,
      "qtd",
      payload,
      adminUser
    );
  }

  async function diagnostico() {
    const meta = await sheetsClient.getMetadata(true);
    const logTab = await resolveLogTabTitle();
    return {
      ok: true,
      spreadsheetTitle: meta.title,
      configuredTabs: { ...fixedTabs, log: logTab },
      existingTabs: [...meta.sheetIdsByTitle.keys()]
    };
  }

  return {
    getEstoque,
    getLog,
    registrar,
    registrarLote,
    validar,
    validarLote,
    remover,
    zerarEstoque,
    getArmarioTI,
    setArmarioTI,
    getVaziosTI,
    setVaziosTI,
    diagnostico
  };
}
