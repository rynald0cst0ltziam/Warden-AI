/**
 * License system — free, open source, donation-based honor system.
 *
 * Warden is free with no license key, no subscription, no activation, no paywall.
 * All features are available to all users. The license module is kept for backward
 * compatibility but isLicensed() and hasFeature() always return true.
 *
 * The key generation and verification functions remain for anyone who wants to
 * issue their own keys, but they are no longer required for the tool to work.
 */
import {
  generateKeyPairSync,
  sign,
  verify,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "../logging/index.js";

export interface LicensePayload {
  /** Customer ID (Stripe customer id or email). */
  c: string;
  /** Expiry as Unix epoch seconds (0 = never expires). */
  e: number;
}

export interface License {
  payload: LicensePayload;
  signature: Buffer;
  raw: string;
  valid: boolean;
  expired: boolean;
}

const KEY_PREFIX = "warden-";
const LICENSE_FILE = "license.json";

function publicKeyPath(): string {
  return join(homedir(), ".warden", "verify_key.pem");
}

function licensePath(): string {
  return join(homedir(), ".warden", LICENSE_FILE);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function serializeLicense(
  payload: LicensePayload,
  signature: Buffer,
): string {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = b64url(Buffer.from(payloadJson, "utf8"));
  const sigB64 = b64url(signature);
  return `${KEY_PREFIX}${payloadB64}.${sigB64}`;
}

export function parseLicense(
  key: string,
): { payload: LicensePayload; signature: Buffer } | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const rest = key.slice(KEY_PREFIX.length);
  const dotIdx = rest.indexOf(".");
  if (dotIdx === -1) return null;
  try {
    const payloadJson = b64urlDecode(rest.slice(0, dotIdx)).toString("utf8");
    const payload = JSON.parse(payloadJson) as LicensePayload;
    const signature = b64urlDecode(rest.slice(dotIdx + 1));
    return { payload, signature };
  } catch {
    return null;
  }
}

export function signLicense(
  payload: LicensePayload,
  privateKeyPem: string,
): string {
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(
    null,
    Buffer.from(JSON.stringify(payload), "utf8"),
    privateKey,
  );
  return serializeLicense(payload, signature);
}

export function verifyLicense(
  key: string,
  publicKeyPem: string,
): License | null {
  const parsed = parseLicense(key);
  if (!parsed) return null;
  const publicKey = createPublicKey(publicKeyPem);
  const valid = verify(
    null,
    Buffer.from(JSON.stringify(parsed.payload), "utf8"),
    publicKey,
    parsed.signature,
  );
  const now = Math.floor(Date.now() / 1000);
  const expired = parsed.payload.e > 0 && now > parsed.payload.e;
  return {
    payload: parsed.payload,
    signature: parsed.signature,
    raw: key,
    valid,
    expired,
  };
}

export function generateKeyPair(): {
  privateKeyPem: string;
  publicKeyPem: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export function savePublicKey(pem: string): void {
  const dir = join(homedir(), ".warden");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(publicKeyPath(), pem, "utf8");
}

export function loadPublicKey(): string | null {
  const p = publicKeyPath();
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

/** Activate a license: verify, save locally. */
export function activateLicense(key: string): License {
  const pubKey = loadPublicKey();
  if (!pubKey) {
    throw new Error(
      "No verify key found. Run `warden license generate` first (dev) or install the official key.",
    );
  }
  const license = verifyLicense(key, pubKey);
  if (!license) throw new Error("Invalid license key format.");
  if (!license.valid) throw new Error("License signature verification failed.");
  if (license.expired) throw new Error("License has expired.");

  const dir = join(homedir(), ".warden");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    licensePath(),
    JSON.stringify(
      {
        key: license.raw,
        customerId: license.payload.c,
        activatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  logger.info("license activated", { customer: license.payload.c });
  return license;
}

/** Load the current license. Returns null if none. */
export function currentLicense(): License | null {
  const p = licensePath();
  if (!existsSync(p)) return null;
  const pubKey = loadPublicKey();
  if (!pubKey) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as { key: string };
    return verifyLicense(data.key, pubKey);
  } catch {
    return null;
  }
}

/** Is the user licensed (paid)? Always true — Warden is now $12 one-time, honor system. */
export function isLicensed(): boolean {
  return true;
}

/**
 * Check if a feature is available. Always true — no gating, no tiers.
 * All features are available to all users.
 */
export function hasFeature(_feature: string): boolean {
  return true;
}

/** Generate a test license for local dev (1 year validity). */
export function generateTestLicense(
  customerId: string,
  privateKeyPem: string,
): string {
  const expiry = Math.floor(Date.now() / 1000) + 365 * 86400; // 1 year
  return signLicense({ c: customerId, e: expiry }, privateKeyPem);
}
