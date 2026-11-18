import test from "node:test";
import assert from "node:assert/strict";
import { handleApiRequest } from "../functions/api.js";
import { clearAuthCaches } from "../functions/_lib/google-auth.js";
import { clearSheetsMetadataCache } from "../functions/_lib/sheets-client.js";

const enc = new TextEncoder();

function toBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bufferToPkcs8Pem(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary).match(/.{1,64}/g).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

async function signJwt(header, payload, privateKey) {
  const h = toBase64Url(enc.encode(JSON.stringify(header)));
  const p = toBase64Url(enc.encode(JSON.stringify(payload)));
  const input = `${h}.${p}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    enc.encode(input)
  );
  return `${input}.${toBase64Url(new Uint8Array(sig))}`;
}

function unquoteSheetName(raw) {
  const trimmed = String(raw || "").trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function a1ColToIndex(letters) {
  let idx = 0;
  for (const ch of letters.toUpperCase()) {
    idx = idx * 26 + (ch.charCodeAt(0) - 64);
  }
  return idx - 1;
}

function parseA1Range(rangeStr) {
  const bang = rangeStr.indexOf("!");
  const sheetTitle = unquoteSheetName(bang >= 0 ? rangeStr.slice(0, bang) : rangeStr);
  const cellRef = bang >= 0 ? rangeStr.slice(bang + 1) : "";
  return { sheetTitle, cellRef };
}

function createFakeGoogleEnv({ initialSheets = {}, saPublicKey, jwkPublic }) {
  const sheets = new Map();
  let nextSheetId = 100;
  for (const [title, rows] of Object.entries(initialSheets)) {
    sheets.set(title, {
      sheetId: nextSheetId++,
      rows: rows.map(r => [...r])
    });
  }

  const capturedNotifications = [];
  const tokenAssertions = [];

  async function fetchImpl(url, init = {}) {
    const urlStr = String(url);

    // 1. Google OAuth2 token endpoint (Service Account)
    if (urlStr === "https://oauth2.googleapis.com/token") {
      const params = new URLSearchParams(String(init.body || ""));
      const assertion = params.get("assertion") || "";
      tokenAssertions.push(assertion);

      const parts = assertion.split(".");
      const sigBytes = Uint8Array.from(
        atob(parts[2].replace(/-/g, "+").replace(/_/g, "/").padEnd(parts[2].length + ((4 - (parts[2].length % 4)) % 4), "=")),
        c => c.charCodeAt(0)
      );
      const ok = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        saPublicKey,
        sigBytes,
        enc.encode(`${parts[0]}.${parts[1]}`)
      );
      if (!ok) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response(
        JSON.stringify({ access_token: "fake-sa-access-token", expires_in: 3600 }),
        { status: 200 }
      );
    }

    // 2. Google JWKS endpoint
    if (urlStr === "https://www.googleapis.com/oauth2/v3/certs") {
      return new Response(JSON.stringify({ keys: [jwkPublic] }), {
        status: 200,
        headers: { "cache-control": "public, max-age=3600" }
      });
    }

    // 3. Notifications (SeaTalk / Webhook)
    if (urlStr.includes("seatalk.io")) {
      capturedNotifications.push({
        url: urlStr,
        body: JSON.parse(String(init.body || "{}"))
      });
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    }

    // 4. Google Sheets API v4
    if (urlStr.startsWith("https://sheets.googleapis.com/v4/spreadsheets/")) {
      const auth = init.headers?.get?.("Authorization") || init.headers?.Authorization;
      if (auth !== "Bearer fake-sa-access-token") {
        return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 });
      }

      const parsed = new URL(urlStr);
      const path = parsed.pathname;

      // Metadata GET
      if ((init.method || "GET") === "GET" && /\/spreadsheets\/[^/]+$/.test(path)) {
        return new Response(
          JSON.stringify({
            properties: { title: "Planilha Toners Shopee" },
            sheets: [...sheets.entries()].map(([title, s]) => ({
              properties: { sheetId: s.sheetId, title }
            }))
          }),
          { status: 200 }
        );
      }

      // values:batchGet
      if (path.endsWith("/values:batchGet")) {
        const ranges = parsed.searchParams.getAll("ranges");
        const valueRanges = [];
        for (const r of ranges) {
          const { sheetTitle } = parseA1Range(r);
          const sheet = sheets.get(sheetTitle);
          if (!sheet) {
            return new Response(
              JSON.stringify({ error: { message: `Unable to parse range: ${r}` } }),
              { status: 400 }
            );
          }
          valueRanges.push({
            range: r,
            majorDimension: "ROWS",
            values: sheet.rows.map(row => [...row])
          });
        }
        return new Response(JSON.stringify({ valueRanges }), { status: 200 });
      }

      // values/{range} GET
      if ((init.method || "GET") === "GET" && path.includes("/values/")) {
        const encodedRange = path.split("/values/")[1];
        const { sheetTitle } = parseA1Range(decodeURIComponent(encodedRange));
        const sheet = sheets.get(sheetTitle);
        if (!sheet) {
          return new Response(
            JSON.stringify({ error: { message: `Unable to parse range: ${sheetTitle}` } }),
            { status: 400 }
          );
        }
        return new Response(
          JSON.stringify({ values: sheet.rows.map(r => [...r]) }),
          { status: 200 }
        );
      }

      // values/{range}:append POST
      if (path.endsWith(":append")) {
        const encodedRange = path.split("/values/")[1].replace(/:append$/, "");
        const { sheetTitle } = parseA1Range(decodeURIComponent(encodedRange));
        const sheet = sheets.get(sheetTitle);
        if (!sheet) {
          return new Response(
            JSON.stringify({ error: { message: `Unable to parse range: ${sheetTitle}` } }),
            { status: 400 }
          );
        }
        const body = JSON.parse(String(init.body || "{}"));
        for (const row of body.values || []) {
          sheet.rows.push([...row]);
        }
        return new Response(JSON.stringify({ updates: { updatedRows: body.values?.length || 0 } }), {
          status: 200
        });
      }

      // values:batchUpdate POST
      if (path.endsWith("/values:batchUpdate")) {
        const body = JSON.parse(String(init.body || "{}"));
        for (const upd of body.data || []) {
          const { sheetTitle, cellRef } = parseA1Range(upd.range);
          const sheet = sheets.get(sheetTitle);
          if (!sheet) {
            return new Response(
              JSON.stringify({ error: { message: `Unable to parse range: ${upd.range}` } }),
              { status: 400 }
            );
          }
          const startPart = cellRef.split(":")[0];
          const m = startPart.match(/^([A-Z]+)(\d+)$/i);
          assert.ok(m, `Invalid A1 range in test fake: ${upd.range}`);
          const startCol = a1ColToIndex(m[1]);
          const startRow = Number(m[2]) - 1;

          (upd.values || []).forEach((vals, rOffset) => {
            const targetRowIdx = startRow + rOffset;
            while (sheet.rows.length <= targetRowIdx) sheet.rows.push([]);
            vals.forEach((v, cOffset) => {
              sheet.rows[targetRowIdx][startCol + cOffset] = v;
            });
          });
        }
        return new Response(JSON.stringify({ totalUpdatedCells: 1 }), { status: 200 });
      }

      // spreadsheets:batchUpdate POST (addSheet / deleteDimension)
      if (path.endsWith(":batchUpdate")) {
        const body = JSON.parse(String(init.body || "{}"));
        const replies = [];
        for (const req of body.requests || []) {
          if (req.addSheet) {
            const title = req.addSheet.properties.title;
            const sheetId = nextSheetId++;
            sheets.set(title, { sheetId, rows: [] });
            replies.push({ addSheet: { properties: { sheetId, title } } });
          } else if (req.deleteDimension) {
            const { sheetId, startIndex, endIndex } = req.deleteDimension.range;
            for (const s of sheets.values()) {
              if (s.sheetId === sheetId) {
                s.rows.splice(startIndex, endIndex - startIndex);
              }
            }
            replies.push({});
          }
        }
        return new Response(JSON.stringify({ replies }), { status: 200 });
      }
    }

    throw new Error(`Unexpected fetch URL in test: ${urlStr}`);
  }

  return { fetchImpl, sheets, capturedNotifications, tokenAssertions };
}

async function setupTestHarness(initialSheets = {}) {
  clearAuthCaches();
  clearSheetsMetadataCache();

  const saKeys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
  const saPkcs8 = await crypto.subtle.exportKey("pkcs8", saKeys.privateKey);
  const saPem = bufferToPkcs8Pem(saPkcs8);

  const authKeys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
  const jwkPublic = await crypto.subtle.exportKey("jwk", authKeys.publicKey);
  jwkPublic.kid = "google-test-kid";
  jwkPublic.use = "sig";
  jwkPublic.alg = "RS256";

  const fake = createFakeGoogleEnv({
    initialSheets,
    saPublicKey: saKeys.publicKey,
    jwkPublic
  });

  const nowMs = Date.UTC(2026, 10, 17, 23, 0, 0);
  const clientId = "test-client-id.apps.googleusercontent.com";

  const env = {
    GOOGLE_SHEET_ID: "sheet-123",
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: "bot@shopee-test.iam.gserviceaccount.com",
      private_key: saPem
    }),
    GOOGLE_CLIENT_ID: clientId,
    ADMIN_EMAILS: "jefferson.msantos@shopee.com,tacio.correia@shopee.com",
    ALERT_WEBHOOK_URL: "https://openapi.seatalk.io/webhook/group/test123",
    APP_URL: "https://guiadeimpressoras.pages.dev"
  };

  async function makeIdToken(overrides = {}) {
    const nowSec = Math.floor(nowMs / 1000);
    return signJwt(
      { alg: "RS256", typ: "JWT", kid: "google-test-kid" },
      {
        iss: "https://accounts.google.com",
        aud: clientId,
        email: "jefferson.msantos@shopee.com",
        email_verified: true,
        name: "Jefferson Santos",
        iat: nowSec,
        exp: nowSec + 3600,
        ...overrides
      },
      authKeys.privateKey
    );
  }

  async function callApi(method, pathOrQuery, body = null, headers = {}) {
    const url = `https://guiadeimpressoras.pages.dev/api${pathOrQuery}`;
    const init = {
      method,
      headers: {
        Origin: "https://guiadeimpressoras.pages.dev",
        ...headers
      }
    };
    if (body !== null) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const req = new Request(url, init);
    const res = await handleApiRequest(req, env, null, {
      fetchImpl: fake.fetchImpl,
      nowMs
    });
    const json = res.status === 204 ? null : await res.json();
    return { status: res.status, headers: res.headers, json };
  }

  return { fake, env, makeIdToken, callApi, nowMs };
}

test("GET health & OPTIONS CORS preflight respond cleanly", async () => {
  const { callApi } = await setupTestHarness();

  const opt = await callApi("OPTIONS", "");
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get("Access-Control-Allow-Origin"), "https://guiadeimpressoras.pages.dev");

  const health = await callApi("GET", "?action=health");
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.service, "guiadeimpressoras-api");
});

test("Auto-creates missing tabs on empty spreadsheet and computes solicitarTI without leaking ArmarioTI", async () => {
  const { callApi, makeIdToken } = await setupTestHarness({});

  const est = await callApi("GET", "?action=getEstoque");
  assert.equal(est.status, 200);
  assert.equal(est.json.length, 4);
  assert.deepEqual(
    est.json.map(r => r.ref),
    ["W2150XC", "W2151XC", "W2152XC", "W2153XC"]
  );
  assert.ok(est.json.every(r => r.cheios === 0 && r.vazios === 0 && r.solicitarTI === false));

  const adminToken = await makeIdToken();
  const setTi = await callApi("POST", "", {
    action: "setArmarioTI",
    token: adminToken,
    itens: { W2150XC: 2, W2151XC: 0, W2152XC: 0, W2153XC: 0 }
  });
  assert.equal(setTi.status, 200);
  assert.equal(setTi.json.ok, true);
  assert.equal(setTi.json.estoque[0].solicitarTI, true);
  assert.equal(setTi.json.estoque[1].solicitarTI, false);

  const publicEst = await callApi("GET", "?action=getEstoque");
  assert.equal(publicEst.json[0].solicitarTI, true);
  assert.equal("armarioTI" in publicEst.json[0], false);
});

test("Full movement lifecycle: registrar, registrarLote, notifications, formula guard, validar, divergente revert, remover", async () => {
  const { callApi, makeIdToken, fake } = await setupTestHarness({
    webinventario: [
      ["ref", "cheios", "vazios", "updated"],
      ["W2150XC", 3, 0, ""],
      ["W2151XC", 2, 1, ""],
      ["W2152XC", 2, 0, ""],
      ["W2153XC", 1, 0, ""]
    ],
    ArmarioTI: [
      ["ref", "cheios", "atualizadoPor", "atualizadoEm"],
      ["W2150XC", 1, "", ""],
      ["W2151XC", 1, "", ""],
      ["W2152XC", 1, "", ""],
      ["W2153XC", 1, "", ""]
    ],
    VaziosSalaTI: [
      ["ref", "qtd", "atualizadoPor", "atualizadoEm"],
      ["W2150XC", 0, "", ""],
      ["W2151XC", 0, "", ""],
      ["W2152XC", 0, "", ""],
      ["W2153XC", 0, "", ""]
    ],
    "Movimentações": [
      ["id", "data", "modelo", "tipo", "qtd", "turno", "resp", "obs", "validacao", "validadoPor", "validadoEm", "estornado"]
    ]
  });

  // 1. Registrar movimentação única com tentativa de formula injection
  const reg = await callApi("POST", "", {
    action: "registrar",
    modelo: "W2150XC",
    tipo: "saida_cheio",
    qtd: 2,
    resp: "Maria",
    obs: "=HYPERLINK(\"http://evil.example\")",
    turno: "T2"
  });
  assert.equal(reg.status, 200);
  assert.equal(reg.json.ok, true);
  assert.equal(reg.json.notified, true);
  assert.equal(reg.json.estoque[0].cheios, 1);

  // Verifica proteção contra formula injection gravada na aba auto-detectada "Movimentações"
  const registrosRows = fake.sheets.get("Movimentações").rows;
  assert.equal(registrosRows[1][7], "'=HYPERLINK(\"http://evil.example\")");

  // Verifica notificação SeaTalk
  assert.equal(fake.capturedNotifications.length, 1);
  assert.ok(fake.capturedNotifications.some(n => n.url.includes("seatalk.io")));

  // Verifica que getLog retorna observação limpa sem o apóstrofo protetor
  const logRes = await callApi("GET", "?action=getLog");
  assert.equal(logRes.status, 200);
  assert.equal(logRes.json.length, 1);
  assert.equal(logRes.json[0].obs, "=HYPERLINK(\"http://evil.example\")");
  assert.equal(logRes.json[0].validacao, "pendente");

  // 2. Registrar em lote (inclusive mesmo modelo acumulado)
  const regLote = await callApi("POST", "", {
    action: "registrarLote",
    resp: "Carlos",
    turno: "T3",
    obs: "Troca noturna",
    movimentos: [
      { modelo: "W2150XC", tipo: "saida_cheio", qtd: 1 },
      { modelo: "W2150XC", tipo: "entrada_vazio", qtd: 1 },
      { modelo: "W2151XC", tipo: "entrada_cheio", qtd: 1 }
    ]
  });
  assert.equal(regLote.status, 200);
  assert.equal(regLote.json.ids.length, 3);
  assert.equal(regLote.json.estoque[0].cheios, 0);
  assert.equal(regLote.json.estoque[0].vazios, 1);
  assert.equal(regLote.json.estoque[0].solicitarTI, true); // 0 < ArmarioTI(1)
  assert.equal(regLote.json.estoque[1].cheios, 3);

  // Tentar adicionar acima do limite de 3 cheios por cor na impressora retorna 400
  const regExcede = await callApi("POST", "", {
    action: "registrar",
    modelo: "W2151XC",
    tipo: "entrada_cheio",
    qtd: 1,
    resp: "Carlos",
    turno: "T3"
  });
  assert.equal(regExcede.status, 400);
  assert.match(regExcede.json.erro, /máximo de 3/);

  const adminToken = await makeIdToken();

  // 3. Validar primeiro item (pendente -> validado): saldo NÃO muda
  const val1 = await callApi("POST", "", {
    action: "validar",
    token: adminToken,
    id: reg.json.id,
    status: "validado"
  });
  assert.equal(val1.status, 200);
  assert.equal(val1.json.estoque[0].cheios, 0);

  // 4. Marcar como divergente (validado -> divergente): estorna +2 cheios de W2150XC e grava estornado="sim"
  const div1 = await callApi("POST", "", {
    action: "validar",
    token: adminToken,
    id: reg.json.id,
    status: "divergente"
  });
  assert.equal(div1.status, 200);
  assert.equal(div1.json.estoque[0].cheios, 2);
  assert.equal(div1.json.estornado, true);
  assert.equal(fake.sheets.get("Movimentações").rows[1][11], "sim");

  // 5. Idempotência: marcar divergente novamente NÃO estorna em duplicidade
  const divAgain = await callApi("POST", "", {
    action: "validar",
    token: adminToken,
    id: reg.json.id,
    status: "divergente"
  });
  assert.equal(divAgain.json.estoque[0].cheios, 2);

  // 6. Remover item já divergente: limpa linha sem estornar novamente
  const remDiv = await callApi("POST", "", {
    action: "remover",
    token: adminToken,
    id: reg.json.id
  });
  assert.equal(remDiv.status, 200);
  assert.equal(remDiv.json.estoque[0].cheios, 2);

  const logAfterRemove = await callApi("GET", "?action=getLog");
  assert.equal(logAfterRemove.json.length, 3);

  // 7. Reverter lote inteiro para divergente via validarLote
  const loteDiv = await callApi("POST", "", {
    action: "validarLote",
    token: adminToken,
    ids: regLote.json.ids,
    status: "divergente"
  });
  assert.equal(loteDiv.status, 200);
  assert.equal(loteDiv.json.updatedCount, 3);
  assert.equal(loteDiv.json.estoque[0].cheios, 3); // voltou para 3!
  assert.equal(loteDiv.json.estoque[0].vazios, 0); // voltou para 0!
  assert.equal(loteDiv.json.estoque[1].cheios, 2); // voltou para 2!

  // 8. Re-validar item divergente via validarLote: re-aplica estoque!
  const loteReval = await callApi("POST", "", {
    action: "validarLote",
    token: adminToken,
    ids: [regLote.json.ids[2]],
    status: "validado"
  });
  assert.equal(loteReval.status, 200);
  assert.equal(loteReval.json.estoque[1].cheios, 3);

  // 9. Zerar estoque
  const zerado = await callApi("POST", "", {
    action: "zerarEstoque",
    token: adminToken
  });
  assert.equal(zerado.status, 200);
  assert.ok(zerado.json.estoque.every(r => r.cheios === 0 && r.vazios === 0));
});

test("Admin auth enforcement: rejects missing, expired, wrong audience, unverified, and non-whitelisted tokens", async () => {
  const { callApi, makeIdToken, nowMs } = await setupTestHarness({});

  const noToken = await callApi("POST", "", { action: "getArmarioTI" });
  assert.equal(noToken.status, 401);
  assert.match(noToken.json.erro, /autenticada/i);

  const expiredToken = await makeIdToken({ exp: Math.floor(nowMs / 1000) - 10 });
  const expiredRes = await callApi("POST", "", {
    action: "getArmarioTI",
    token: expiredToken
  });
  assert.equal(expiredRes.status, 401);
  assert.match(expiredRes.json.erro, /expirada/i);

  const wrongAudToken = await makeIdToken({ aud: "other-app.apps.googleusercontent.com" });
  const wrongAudRes = await callApi("POST", "", {
    action: "getArmarioTI",
    token: wrongAudToken
  });
  assert.equal(wrongAudRes.status, 401);

  const unverifiedToken = await makeIdToken({ email_verified: false });
  const unverifiedRes = await callApi("POST", "", {
    action: "getArmarioTI",
    token: unverifiedToken
  });
  assert.equal(unverifiedRes.status, 401);

  const intrusoToken = await makeIdToken({ email: "intruso@shopee.com" });
  const intrusoRes = await callApi("POST", "", {
    action: "getArmarioTI",
    token: intrusoToken
  });
  assert.equal(intrusoRes.status, 403);
  assert.match(intrusoRes.json.erro, /acesso negado/i);

  const validToken = await makeIdToken();
  const diagRes = await callApi("POST", "", {
    action: "diagnostico",
    token: validToken
  });
  assert.equal(diagRes.status, 200);
  assert.equal(diagRes.json.ok, true);
  assert.equal(diagRes.json.admin, "jefferson.msantos@shopee.com");
});

test("Supports legacy sheet columns (Status/Revisor/RevisadoEm) and rows without ID", async () => {
  const { callApi, makeIdToken, fake } = await setupTestHarness({
    webinventario: [
      ["Ref", "Cheios", "Vazios", "Atualizado"],
      ["W2150XC", 5, 0, "17/11/2026 10:00:00"],
      ["W2151XC", 2, 0, ""],
      ["W2152XC", 2, 0, ""],
      ["W2153XC", 2, 0, ""]
    ],
    ArmarioTI: [
      ["Ref", "Cheios"],
      ["W2150XC", 1],
      ["W2151XC", 1],
      ["W2152XC", 1],
      ["W2153XC", 1]
    ],
    Registros: [
      ["Data", "Modelo", "Tipo", "Qtd", "Turno", "Responsavel", "Observacao", "Status", "Revisor", "RevisadoEm"],
      ["2026-11-17T10:00:00.000Z", "W2150XC", "entrada_cheio", 2, "T1", "Operador Legado", "NF 99", "pendente", "", ""]
    ]
  });

  const log = await callApi("GET", "?action=getLog");
  assert.equal(log.status, 200);
  assert.equal(log.json[0].id, "2026-11-17T10:00:00.000Z_W2150XC_Operador Legado");
  assert.equal(log.json[0].validacao, "pendente");

  // ID fallback igual ao gerado pelo frontend em admin.html
  const fallbackId = "2026-11-17T10:00:00.000Z_W2150XC_Operador Legado";
  const adminToken = await makeIdToken();
  const div = await callApi("POST", "", {
    action: "validar",
    token: adminToken,
    id: fallbackId,
    status: "divergente"
  });
  assert.equal(div.status, 200);
  assert.equal(div.json.estoque[0].cheios, 3); // 5 - 2 estornados

  const estRows = fake.sheets.get("webinventario").rows;
  assert.equal(estRows[1][1], 3);
});

test("Rejects invalid registration payloads cleanly with 400", async () => {
  const { callApi } = await setupTestHarness({});

  const badModel = await callApi("POST", "", {
    action: "registrar",
    modelo: "INVALIDO",
    tipo: "entrada_cheio",
    qtd: 1,
    resp: "Ana",
    turno: "T1"
  });
  assert.equal(badModel.status, 400);

  const badQtd = await callApi("POST", "", {
    action: "registrar",
    modelo: "W2150XC",
    tipo: "entrada_cheio",
    qtd: 25,
    resp: "Ana",
    turno: "T1"
  });
  assert.equal(badQtd.status, 400);

  const missingResp = await callApi("POST", "", {
    action: "registrar",
    modelo: "W2150XC",
    tipo: "entrada_cheio",
    qtd: 1,
    resp: "   ",
    turno: "T1"
  });
  assert.equal(missingResp.status, 400);
});

test("Supports GOOGLE_SERVICE_ACCOUNT_EMAIL + escaped GOOGLE_PRIVATE_KEY, token caching, setVaziosTI, and remover guards", async () => {
  const { fake, env, makeIdToken, nowMs } = await setupTestHarness({
    webinventario: [
      ["ref", "cheios", "vazios", "updated"],
      ["W2150XC", 4, 0, ""],
      ["W2151XC", 2, 0, ""],
      ["W2152XC", 2, 0, ""],
      ["W2153XC", 2, 0, ""]
    ],
    ArmarioTI: [
      ["ref", "cheios", "atualizadoPor", "atualizadoEm"],
      ["W2150XC", 1, "", ""],
      ["W2151XC", 1, "", ""],
      ["W2152XC", 1, "", ""],
      ["W2153XC", 1, "", ""]
    ],
    VaziosSalaTI: [
      ["ref", "qtd", "atualizadoPor", "atualizadoEm"],
      ["W2150XC", 0, "", ""],
      ["W2151XC", 0, "", ""],
      ["W2152XC", 0, "", ""],
      ["W2153XC", 0, "", ""]
    ],
    "Movimentações": [
      ["id", "data", "modelo", "tipo", "qtd", "turno", "resp", "obs", "validacao", "validadoPor", "validadoEm", "estornado"]
    ]
  });

  const parsedSa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const splitEnv = {
    GOOGLE_SHEET_ID: env.GOOGLE_SHEET_ID,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: parsedSa.client_email,
    GOOGLE_PRIVATE_KEY: `"${parsedSa.private_key.replace(/\n/g, "\\n")}"`,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    ADMIN_EMAILS: env.ADMIN_EMAILS
  };

  async function callWithSplitEnv(method, query, body = null) {
    const req = new Request(`https://guiadeimpressoras.pages.dev/api${query}`, {
      method,
      body: body ? JSON.stringify(body) : null
    });
    const res = await handleApiRequest(req, splitEnv, null, {
      fetchImpl: fake.fetchImpl,
      nowMs
    });
    return { status: res.status, json: await res.json() };
  }

  const adminToken = await makeIdToken();

  // Faz várias chamadas e garante que o access_token da Service Account é cacheado (apenas 1 JWT emitido)
  const setVazios = await callWithSplitEnv("POST", "", {
    action: "setVaziosTI",
    token: adminToken,
    itens: { W2150XC: 3, W2151XC: 1, W2152XC: 0, W2153XC: 2 }
  });
  assert.equal(setVazios.status, 200);
  assert.equal(setVazios.json.itens[0].qtd, 3);
  assert.equal(setVazios.json.itens[0].atualizadoPor, "jefferson.msantos@shopee.com");

  const getVazios = await callWithSplitEnv("POST", "", {
    action: "getVaziosTI",
    token: adminToken
  });
  assert.equal(getVazios.status, 200);
  assert.equal(getVazios.json.length, 4);
  assert.equal(getVazios.json[0].ref, "W2150XC");
  assert.equal(getVazios.json[0].qtd, 3);
  assert.equal(getVazios.json[0].atualizadoPor, "jefferson.msantos@shopee.com");
  assert.equal(getVazios.json[1].qtd, 1);
  assert.equal(getVazios.json[2].qtd, 0);
  assert.equal(getVazios.json[3].qtd, 2);

  assert.equal(fake.tokenAssertions.length, 1);

  // Valida rejeição de quantidade negativa em setVaziosTI
  const badVazios = await callWithSplitEnv("POST", "", {
    action: "setVaziosTI",
    token: adminToken,
    itens: { W2150XC: -1 }
  });
  assert.equal(badVazios.status, 400);

  // Remover item ainda pendente deve ser bloqueado com 400
  const reg = await callWithSplitEnv("POST", "", {
    action: "registrar",
    modelo: "W2150XC",
    tipo: "saida_cheio",
    qtd: 2,
    resp: "Pedro",
    turno: "T1"
  });
  assert.equal(reg.status, 200);
  assert.equal(reg.json.estoque[0].cheios, 2);

  const remPendente = await callWithSplitEnv("POST", "", {
    action: "remover",
    token: adminToken,
    id: reg.json.id
  });
  assert.equal(remPendente.status, 400);
  assert.match(remPendente.json.erro, /divergentes/i);

  // Registro legado marcado como divergente sem estornado="sim" deve estornar 1x na remoção
  fake.sheets.get("Movimentações").rows.push([
    "legacy-div-1",
    "2026-11-16T09:00:00.000Z",
    "W2150XC",
    "saida_cheio",
    1,
    "T1",
    "Legado",
    "",
    "divergente",
    "jefferson.msantos@shopee.com",
    "2026-11-16T09:05:00.000Z",
    ""
  ]);

  const remLegacy = await callWithSplitEnv("POST", "", {
    action: "remover",
    token: adminToken,
    id: "legacy-div-1"
  });
  assert.equal(remLegacy.status, 200);
  assert.equal(remLegacy.json.estoque[0].cheios, 3);
});

test("Returns clear 500 error when GOOGLE_SHEET_ID is missing", async () => {
  const req = new Request("https://guiadeimpressoras.pages.dev/api?action=getEstoque");
  const res = await handleApiRequest(req, {}, null);
  assert.equal(res.status, 500);
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.match(json.erro, /GOOGLE_SHEET_ID/);
});

