import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { requireSecret } from "./secrets";

const KEY_VERSION = 1;

/** Decode + validate the 32-byte master key from env (base64). Throws on misconfig. */
function masterKey(): Buffer {
  const buf = Buffer.from(requireSecret("INTEGRATION_SECRET_KEY"), "base64");
  if (buf.length !== 32) {
    throw new Error("INTEGRATION_SECRET_KEY must be base64 for exactly 32 bytes");
  }
  return buf;
}

export interface SealedSecret {
  ciphertext: string; // base64
  iv: string; // base64 (12-byte GCM nonce)
  tag: string; // base64 (16-byte GCM auth tag)
  keyVersion: number;
}

/** Encrypt plaintext with AES-256-GCM. Never logs the plaintext. */
export function seal(plaintext: string): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyVersion: KEY_VERSION,
  };
}

/** Decrypt a SealedSecret. Throws if the auth tag fails (tampering / wrong key). */
export function open(sealed: SealedSecret): string {
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const dec = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]);
  return dec.toString("utf8");
}

/** Render a secret for display: last four chars only. */
export function maskSecret(s: string): string {
  return s.length <= 4 ? "••••" : "••• " + s.slice(-4);
}
