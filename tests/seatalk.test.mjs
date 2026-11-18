import test from "node:test";
import assert from "node:assert/strict";
import { computeSeaTalkSignature, verifySeaTalkSignature } from "../functions/_lib/seatalk-auth.js";
import { handleSeaTalkRequest } from "../functions/api/seatalk.js";

const enc = new TextEncoder();

test("computeSeaTalkSignature matches SeaTalk official documentation vector", async () => {
  const body =
    '{"event_id":"1098780","event_type":"event_verification","timestamp":1611220944,"app_id":"NDYyMDU1MTY3NzQ1","event":{"seatalk_challenge":"23j98gjbearh023hg"}}';
  const sig = await computeSeaTalkSignature(enc.encode(body), "1234567812345678");
  assert.equal(sig, "48918b59a7a5976781578b78136c816592b2b5834d4348a272253f221e68377c");

  assert.equal(
    await verifySeaTalkSignature(enc.encode(body), "1234567812345678", sig),
    true
  );
  assert.equal(
    await verifySeaTalkSignature(enc.encode(body), "1234567812345678", "wrong-sig"),
    false
  );
});

test("Handles SeaTalk event_verification challenge with and without configured secret", async () => {
  const payload = {
    event_id: "1098780",
    event_type: "event_verification",
    timestamp: 1611220944,
    app_id: "NDYyMDU1MTY3NzQ1",
    event: {
      seatalk_challenge: "23j98gjbearh023hg"
    }
  };
  const body = JSON.stringify(payload);
  const sig = await computeSeaTalkSignature(enc.encode(body), "secret-abc");

  // Com SEATALK_SIGNING_SECRET configurado e assinatura válida
  const resOk = await handleSeaTalkRequest(
    new Request("https://guiadeimpressoras.pages.dev/api/seatalk", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Signature: sig
      },
      body
    }),
    { SEATALK_SIGNING_SECRET: "secret-abc", SEATALK_APP_ID: "NDYyMDU1MTY3NzQ1" }
  );
  assert.equal(resOk.status, 200);
  assert.deepEqual(await resOk.json(), { seatalk_challenge: "23j98gjbearh023hg" });

  // Com SEATALK_SIGNING_SECRET configurado e assinatura inválida -> 401
  const resBadSig = await handleSeaTalkRequest(
    new Request("https://guiadeimpressoras.pages.dev/api/seatalk", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Signature: "invalid"
      },
      body
    }),
    { SEATALK_SIGNING_SECRET: "secret-abc" }
  );
  assert.equal(resBadSig.status, 401);

  // Sem SEATALK_SIGNING_SECRET ainda: permite apenas event_verification
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
    event: { value: "validar_1" }
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

  const resValid = await handleSeaTalkRequest(
    new Request("https://guiadeimpressoras.pages.dev/api/seatalk", {
      method: "POST",
      headers: { "Content-Type": "application/json", Signature: sig },
      body
    }),
    { SEATALK_SIGNING_SECRET: "secret-abc", SEATALK_APP_ID: "NDYyMDU1MTY3NzQ1" }
  );
  assert.equal(resValid.status, 200);
});
