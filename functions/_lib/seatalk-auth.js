const encoder = new TextEncoder();

function bytesToLowerHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function timingSafeEqualAscii(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function computeSeaTalkSignature(rawBodyBytes, signingSecret) {
  const bodyBytes =
    rawBodyBytes instanceof Uint8Array
      ? rawBodyBytes
      : new Uint8Array(rawBodyBytes || new ArrayBuffer(0));
  const secretBytes = encoder.encode(String(signingSecret || ""));
  const combined = new Uint8Array(bodyBytes.length + secretBytes.length);
  combined.set(bodyBytes, 0);
  combined.set(secretBytes, bodyBytes.length);

  const digest = await crypto.subtle.digest("SHA-256", combined);
  return bytesToLowerHex(digest);
}

export async function verifySeaTalkSignature(rawBodyBytes, signingSecret, receivedSignature) {
  const secret = String(signingSecret || "");
  const sig = String(receivedSignature || "").trim().toLowerCase();
  if (!secret || !sig) return false;

  const expected = await computeSeaTalkSignature(rawBodyBytes, secret);
  return timingSafeEqualAscii(expected, sig);
}
