/**
 * Minimal RFC 6238 TOTP generator. Used for 2FA prompts during automated
 * account logins. Secrets are Base32 strings (the same thing authenticator
 * apps like Authy / Google Auth accept via QR).
 */

import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode a base32 (RFC 4648) string into a Buffer. Case-insensitive, ignores whitespace/padding. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/\s+/g, "").replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = BASE32_ALPHABET.indexOf(ch);
    if (i < 0) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Generate a 6-digit TOTP code for the current time (30s window). */
export function totp(secret: string, nowMs: number = Date.now()): string {
  const key = base32Decode(secret);
  const counter = Math.floor(nowMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  // Big-endian u64 counter.
  buf.writeUInt32BE(0, 0);
  buf.writeUInt32BE(counter, 4);
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const code = binary % 1_000_000;
  return code.toString().padStart(6, "0");
}
