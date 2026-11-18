import test from "node:test";
import assert from "node:assert/strict";
import { handleApiRequest } from "../functions/api.js";
import { clearAuthCaches } from "../functions/_lib/google-auth.js";
import { clearSheetsMetadataCache } from "../functions/_lib/sheets-client.js";
import { computeSeaTalkSignature, verifySeaTalkSignature } from "../functions/_lib/seatalk-auth.js";
import { clearSeaTalkTokenCache } from "../functions/_lib/seatalk-client.js";
import { clearSeaTalkEventCache, handleSeaTalkRequest } from "../functions/api/seatalk.js";

const enc = new TextEncoder();

function bufferToPkcs8Pem(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary).match(/.{1,64}/g).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
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
  for (const ch of letters.toUpperCase()) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx - 1;
}

function parseA1Range(rangeStr) {
  const bang = rangeStr.indexOf("!");
  return {
    sheetTitle: unquoteSheetName(bang >= 0 ? rangeStr.slice(0, bang) : rangeStr),
    cellRef: bang >= 0 ? rangeStr.slice(bang + 1) : ""
  };
}

async function setupSeaTalkHarness() {
  clearAuthCaches();
  clearSheetsMetadataCache();
  clearSeaTalkTokenCache();
  clearSeaTalkEventCache();

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
  const saPem = bufferToPkcs8Pem(await crypto.subtle.exportKey("pkcs8", saKeys.privateKey));

  const sheets = new Map([
    [
      "webinventario",
      {
        sheetId: 1,
        rows: [
          ["ref", "cheios", "vazios", "updated"],
          ["W2150XC", 3, 0, ""],
          ["W2151XC", 2, 0, ""],
          ["W2152XC", 2, 0, ""],
          ["W2153XC", 1, 0, ""]
        ]
      }
    ],
    [
      "ArmarioTI",
      {
        sheetId: 2,
        rows: [
          ["ref", "cheios", "atualizadoPor", "atualizadoEm"],
          ["W2150XC", 1, "", ""],
          ["W2151XC", 1, "", ""],
          ["W2152XC", 1, "", ""],
          ["W2153XC", 1, "", ""]
        ]
      }
    ],
    [
      "VaziosSalaTI",
      {
        sheetId: 3,
        rows: [
          ["ref", "qtd", "atualizadoPor", "atualizadoEm"],
          ["W2150XC", 0, "", ""],
          ["W2151XC", 0, "", ""],
          ["W2152XC", 0, "", ""],
          ["W2153XC", 0, "", ""]
        ]
      }
    ],
    [
      "Movimentações",
      {
        sheetId: 4,
        rows: [
          ["id", "data", "modelo", "tipo", "qtd", "turno", "resp", "obs", "validacao", "validadoPor", "validadoEm", "estornado"]
        ]
      }
    ]
  ]);

  const sentGroupMessages = [];
  let tokenCalls = 0;
  const nowMs = Date.UTC(2026, 10, 17, 23, 0, 0);

  async function fetchImpl(url, init = {}) {
    const urlStr = String(url);

    if (urlStr === "https://oauth2.googleapis.com/token") {
      return new Response(
        JSON.stringify({ access_token: "sa-token", expires_in: 3600 }),
        { status: 200 }
      );
    }

    if (urlStr === "https://openapi.seatalk.io/auth/app_access_token") {
      tokenCalls++;
      return new Response(
        JSON.stringify({
          code: 0,
          app_access_token: "st-access-token",
          expire: Math.floor(nowMs / 1000) + 7200
        }),
        { status: 200 }
      );
    }

    if (urlStr === "https://openapi.seatalk.io/messaging/v2/group_chat") {
      const body = JSON.parse(String(init.body || "{}"));
      sentGroupMessages.push(body);
      return new Response(
        JSON.stringify({ code: 0, message_id: `msg_${sentGroupMessages.length}` }),
        { status: 200 }
      );
    }

    if (urlStr.startsWith("https://openapi.seatalk.io/contacts/v2/profile")) {
      const code = new URL(urlStr).searchParams.get("employee_code");
      if (code === "e_op_1") {
        return new Response(
          JSON.stringify({
            code: 0,
            employees: [{ employee_code: "e_op_1", name: "Operador", email: "operador@shopee.com" }]
          }),
          { status: 200 }
        );
      }
      if (code === "e_ti_1") {
        return new Response(
          JSON.stringify({
            code: 0,
            employees: [
              { employee_code: "e_ti_1", name: "Tácio Correia", email: "tacio.correia@shopee.com" }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ code: 0, employees: [] }), { status: 200 });
    }

    if (urlStr.startsWith("https://sheets.googleapis.com/v4/spreadsheets/")) {
      const parsed = new URL(urlStr);
      const path = parsed.pathname;

      if ((init.method || "GET") === "GET" && /\/spreadsheets\/[^/]+$/.test(path)) {
        return new Response(
          JSON.stringify({
            properties: { title: "Planilha Toners" },
            sheets: [...sheets.entries()].map(([title, s]) => ({
              properties: { sheetId: s.sheetId, title }
            }))
          }),
          { status: 200 }
        );
      }

      if (path.endsWith("/values:batchGet")) {
        const ranges = parsed.searchParams.getAll("ranges");
        return new Response(
          JSON.stringify({
            valueRanges: ranges.map(r => {
              const { sheetTitle } = parseA1Range(r);
              return { range: r, values: sheets.get(sheetTitle).rows.map(row => [...row]) };
            })
          }),
          { status: 200 }
        );
      }

      if ((init.method || "GET") === "GET" && path.includes("/values/")) {
        const { sheetTitle } = parseA1Range(decodeURIComponent(path.split("/values/")[1]));
        return new Response(
          JSON.stringify({ values: sheets.get(sheetTitle).rows.map(r => [...r]) }),
          { status: 200 }
        );
      }

      if (path.endsWith(":append")) {
        const { sheetTitle } = parseA1Range(
          decodeURIComponent(path.split("/values/")[1].replace(/:append$/, ""))
        );
        const body = JSON.parse(String(init.body || "{}"));
        for (const row of body.values || []) sheets.get(sheetTitle).rows.push([...row]);
        return new Response(JSON.stringify({ updates: { updatedRows: 1 } }), { status: 200 });
      }

      if (path.endsWith("/values:batchUpdate")) {
        const body = JSON.parse(String(init.body || "{}"));
        for (const upd of body.data || []) {
          const { sheetTitle, cellRef } = parseA1Range(upd.range);
          const sheet = sheets.get(sheetTitle);
          const m = cellRef.split(":")[0].match(/^([A-Z]+)(\d+)$/i);
          const startCol = a1ColToIndex(m[1]);
          const startRow = Number(m[2]) - 1;
          (upd.values || []).forEach((vals, rOff) => {
            while (sheet.rows.length <= startRow + rOff) sheet.rows.push([]);
            vals.forEach((v, cOff) => {
              sheet.rows[startRow + rOff][startCol + cOff] = v;
            });
          });
        }
        return new Response(JSON.stringify({ totalUpdatedCells: 1 }), { status: 200 });
      }
    }

    throw new Error(`Unexpected URL in seatalk test: ${urlStr}`);
  }

  const env = {
    GOOGLE_SHEET_ID: "sheet-123",
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: "bot@test.iam.gserviceaccount.com",
      private_key: saPem
    }),
    ADMIN_EMAILS: "jefferson.msantos@shopee.com,tacio.correia@shopee.com",
    SEATALK_APP_ID: "app_st_1",
    SEATALK_APP_SECRET: "secret_st_1",
    SEATALK_SIGNING_SECRET: "signing_secret_1",
    SEATALK_GROUP_ID: "grp_ti_1",
    APP_URL: "https://guiadeimpressoras.pages.dev"
  };

  async function sendSeaTalkEvent(payload) {
    const body = JSON.stringify(payload);
    const sig = await computeSeaTalkSignature(enc.encode(body), env.SEATALK_SIGNING_SECRET);
    const req = new Request("https://guiadeimpressoras.pages.dev/api/seatalk", {
      method: "POST",
      headers: { "Content-Type": "application/json", Signature: sig },
      body
    });
    const res = await handleSeaTalkRequest(req, env, null, { fetchImpl, nowMs });
    return { status: res.status, json: await res.json() };
  }

  return {
    env,
    sheets,
    sentGroupMessages,
    getTokenCalls: () => tokenCalls,
    fetchImpl,
    nowMs,
    sendSeaTalkEvent
  };
}

test("computeSeaTalkSignature matches SeaTalk official documentation vector", async () => {
  const body =
    '{"event_id":"1098780","event_type":"event_verification","timestamp":1611220944,"app_id":"NDYyMDU1MTY3NzQ1","event":{"seatalk_challenge":"23j98gjbearh023hg"}}';
  const sig = await computeSeaTalkSignature(enc.encode(body), "1234567812345678");
  assert.equal(sig, "48918b59a7a5976781578b78136c816592b2b5834d4348a272253f221e68377c");
  assert.equal(await verifySeaTalkSignature(enc.encode(body), "1234567812345678", sig), true);
  assert.equal(await verifySeaTalkSignature(enc.encode(body), "1234567812345678", "wrong-sig"), false);
});

test("Handles SeaTalk event_verification challenge with and without configured secret", async () => {
  const payload = {
    event_id: "1098780",
    event_type: "event_verification",
    timestamp: 1611220944,
    app_id: "NDYyMDU1MTY3NzQ1",
    event: { seatalk_challenge: "23j98gjbearh023hg" }
  };
  const body = JSON.stringify(payload);
  const sig = await computeSeaTalkSignature(enc.encode(body), "secret-abc");

  const resOk = await handleSeaTalkRequest(
    new Request("https://guiadeimpressoras.pages.dev/api/seatalk", {
      method: "POST",
      headers: { "Content-Type": "application/json", Signature: sig },
      body
    }),
    { SEATALK_SIGNING_SECRET: "secret-abc", SEATALK_APP_ID: "NDYyMDU1MTY3NzQ1" }
  );
  assert.equal(resOk.status, 200);
  assert.deepEqual(await resOk.json(), { seatalk_challenge: "23j98gjbearh023hg" });

  const resBadSig = await handleSeaTalkRequest(
    new Request("https://guiadeimpressoras.pages.dev/api/seatalk", {
      method: "POST",
      headers: { "Content-Type": "application/json", Signature: "invalid" },
      body
    }),
    { SEATALK_SIGNING_SECRET: "secret-abc" }
  );
  assert.equal(resBadSig.status, 401);

  const resNoSecretChallenge = await handleSeaTalkRequest(
    new Request("https://guiadeimpressoras.pages.dev/api/seatalk", {
      method: "POST",
      headers: { "Content-Type": "application/json", Signature: sig },
      body
    }),
    {}
  );
  assert.equal(resNoSecretChallenge.status, 200);
  assert.deepEqual(await resNoSecretChallenge.json(), { seatalk_challenge: "23j98gjbearh023hg" });
});

test("Rejects non-verification events when SEATALK_SIGNING_SECRET is missing or app_id mismatches", async () => {
  const body = JSON.stringify({
    event_id: "evt-2",
    event_type: "interactive_message_click",
    app_id: "NDYyMDU1MTY3NzQ1",
    event: { value: "menu:toners" }
  });

  const resMissingSecret = await handleSeaTalkRequest(
    new Request("https://guiadeimpressoras.pages.dev/api/seatalk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    }),
    {}
  );
  assert.equal(resMissingSecret.status, 503);

  const sig = await computeSeaTalkSignature(enc.encode(body), "secret-abc");
  const resWrongApp = await handleSeaTalkRequest(
    new Request("https://guiadeimpressoras.pages.dev/api/seatalk", {
      method: "POST",
      headers: { "Content-Type": "application/json", Signature: sig },
      body
    }),
    { SEATALK_SIGNING_SECRET: "secret-abc", SEATALK_APP_ID: "OUTRO_APP" }
  );
  assert.equal(resWrongApp.status, 401);
});

test("SeaTalk Bot end-to-end: sends interactive alert card, validates/reverts, adds toners, and blocks non-admins", async () => {
  const harness = await setupSeaTalkHarness();
  const { env, sheets, sentGroupMessages, fetchImpl, nowMs, sendSeaTalkEvent } = harness;

  // 1. Registrar movimentação no site dispara card interativo no SeaTalk com botões
  const regReq = new Request("https://guiadeimpressoras.pages.dev/api", {
    method: "POST",
    body: JSON.stringify({
      action: "registrar",
      modelo: "W2150XC",
      tipo: "saida_cheio",
      qtd: 1,
      resp: "João",
      turno: "T1",
      obs: "Troca impressora"
    })
  });
  const regRes = await handleApiRequest(regReq, env, null, { fetchImpl, nowMs });
  const regJson = await regRes.json();
  assert.equal(regRes.status, 200);
  assert.equal(regJson.notified, true);
  assert.equal(sentGroupMessages.length, 1);

  const alertCard = sentGroupMessages[0];
  assert.equal(alertCard.group_id, "grp_ti_1");
  assert.equal(alertCard.message.tag, "interactive_message");
  const buttons = alertCard.message.interactive_message.elements[2].button_group;
  assert.equal(buttons[0].text, "✅ Permitir");
  assert.equal(buttons[1].text, "❌ Recusar");
  assert.equal(buttons[0].value, `val:${regJson.id}`);
  assert.equal(buttons[1].value, `div:${regJson.id}`);
  assert.equal(buttons[2].value, "menu:toners");

  // 2. Usuário não autorizado (sem email na whitelist, resolvido via employee_code) é bloqueado
  const deniedClick = await sendSeaTalkEvent({
    event_id: "evt_denied_1",
    event_type: "interactive_message_click",
    app_id: env.SEATALK_APP_ID,
    event: {
      message_id: "msg_1",
      group_id: "grp_ti_1",
      employee_code: "e_op_1",
      value: buttons[0].value
    }
  });
  assert.equal(deniedClick.status, 200);
  assert.match(sentGroupMessages[1].message.text.content, /Acesso restrito/);
  assert.equal(sheets.get("Movimentações").rows[1][8], "pendente");

  // 3. Admin clica em "Permitir" pelo SeaTalk
  const valClick = await sendSeaTalkEvent({
    event_id: "evt_val_1",
    event_type: "interactive_message_click",
    app_id: env.SEATALK_APP_ID,
    event: {
      message_id: "msg_1",
      group_id: "grp_ti_1",
      email: "jefferson.msantos@shopee.com",
      value: buttons[0].value
    }
  });
  assert.equal(valClick.status, 200);
  assert.equal(sheets.get("Movimentações").rows[1][8], "validado");
  assert.equal(sheets.get("Movimentações").rows[1][9], "jefferson.msantos@shopee.com");
  assert.equal(sentGroupMessages[2].message.thread_id, "msg_1");
  assert.match(sentGroupMessages[2].message.interactive_message.elements[0].title.text, /PERMITIDA/);

  // 4. Retry duplicado com mesmo event_id é ignorado sem re-enviar mensagem
  const dupClick = await sendSeaTalkEvent({
    event_id: "evt_val_1",
    event_type: "interactive_message_click",
    app_id: env.SEATALK_APP_ID,
    event: {
      message_id: "msg_1",
      group_id: "grp_ti_1",
      email: "jefferson.msantos@shopee.com",
      value: buttons[0].value
    }
  });
  assert.equal(dupClick.json.duplicate, true);
  assert.equal(sentGroupMessages.length, 3);

  // 5. Admin clica em "Divergente" -> estorna estoque e marca estornado="sim"
  const divClick = await sendSeaTalkEvent({
    event_id: "evt_div_1",
    event_type: "interactive_message_click",
    app_id: env.SEATALK_APP_ID,
    event: {
      message_id: "msg_1",
      group_id: "grp_ti_1",
      email: "jefferson.msantos@shopee.com",
      value: buttons[1].value
    }
  });
  assert.equal(divClick.status, 200);
  assert.equal(sheets.get("webinventario").rows[1][1], 3); // voltou para 3
  assert.equal(sheets.get("Movimentações").rows[1][11], "sim");

  // 6. Admin clica em "Gerenciar Toners" -> recebe card com botões de adicionar toner
  await sendSeaTalkEvent({
    event_id: "evt_menu_1",
    event_type: "interactive_message_click",
    app_id: env.SEATALK_APP_ID,
    event: {
      message_id: "msg_1",
      group_id: "grp_ti_1",
      employee_code: "e_ti_1",
      value: "menu:toners"
    }
  });
  const menuCard = sentGroupMessages[4].message.interactive_message;
  assert.equal(menuCard.elements[2].button_group[0].value, "add_imp:W2150XC");

  // 7. Admin clica em "+1 Preto" na impressora -> soma +1 em webenv e registra já validado
  await sendSeaTalkEvent({
    event_id: "evt_add_imp_1",
    event_type: "interactive_message_click",
    app_id: env.SEATALK_APP_ID,
    event: {
      message_id: "msg_5",
      group_id: "grp_ti_1",
      employee_code: "e_ti_1",
      value: "add_imp:W2150XC"
    }
  });
  assert.equal(sheets.get("webinventario").rows[1][1], 4);
  const lastLogRow = sheets.get("Movimentações").rows[2];
  assert.equal(lastLogRow[2], "W2150XC");
  assert.equal(lastLogRow[3], "entrada_cheio");
  assert.equal(lastLogRow[8], "validado");
  assert.equal(lastLogRow[9], "tacio.correia@shopee.com");

  // 8. Admin clica em "+1 Ciano (TI)" -> atualiza ArmarioTI
  await sendSeaTalkEvent({
    event_id: "evt_add_ti_1",
    event_type: "interactive_message_click",
    app_id: env.SEATALK_APP_ID,
    event: {
      message_id: "msg_6",
      group_id: "grp_ti_1",
      email: "jefferson.msantos@shopee.com",
      value: "add_ti:W2151XC"
    }
  });
  assert.equal(sheets.get("ArmarioTI").rows[2][1], 2);
  assert.equal(sheets.get("ArmarioTI").rows[2][2], "jefferson.msantos@shopee.com");

  // 9. Garante que app_access_token do SeaTalk foi obtido apenas 1x e reutilizado do cache
  assert.equal(harness.getTokenCalls(), 1);
});

test("SeaTalk Bot handles bot_added_to_group_chat and group mention", async () => {
  const { env, sentGroupMessages, sendSeaTalkEvent } = await setupSeaTalkHarness();

  await sendSeaTalkEvent({
    event_id: "evt_added_1",
    event_type: "bot_added_to_group_chat",
    app_id: env.SEATALK_APP_ID,
    event: { group: { group_id: "grp_ti_1" } }
  });
  assert.equal(sentGroupMessages.length, 1);
  assert.match(
    sentGroupMessages[0].message.interactive_message.elements[1].description.text,
    /grp_ti_1/
  );

  await sendSeaTalkEvent({
    event_id: "evt_mention_1",
    event_type: "new_mentioned_message_received_from_group_chat",
    app_id: env.SEATALK_APP_ID,
    event: {
      group_id: "grp_ti_1",
      message: {
        message_id: "msg_user_9",
        sender: { employee_code: "e_ti_1" },
        text: { content: "@Bot toners" }
      }
    }
  });
  assert.equal(sentGroupMessages.length, 2);
  assert.equal(sentGroupMessages[1].message.thread_id, "msg_user_9");
  assert.match(
    sentGroupMessages[1].message.interactive_message.elements[0].title.text,
    /Controle Rápido de Toners/
  );
});
