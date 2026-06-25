/**
 * End-to-end encryption for direct chats.
 *
 * Each user has an ECDH (P-256) identity key pair. The public key is shared via
 * the server; the private key lives in the browser (IndexedDB) and is backed up
 * to the server ONLY in password-wrapped form (PBKDF2 -> AES-GCM), so the server
 * can never read it. A per-conversation AES-GCM key is derived from ECDH between
 * the two users' keys, and message text is encrypted/decrypted locally.
 */

import { api } from "./api";

const EC_PARAMS: EcKeyImportParams = { name: "ECDH", namedCurve: "P-256" };
const PBKDF2_ITERATIONS = 250_000;
const DB_NAME = "nexus-e2ee";
const STORE = "keys";

// ---------- base64 helpers ----------
function bufToB64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBuf(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ---------- IndexedDB (per-device private key storage) ----------
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(userId: string): Promise<JsonWebKey | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(userId);
    tx.onsuccess = () => resolve((tx.result as JsonWebKey) ?? null);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbPut(userId: string, jwk: JsonWebKey): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(jwk, userId);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(userId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).delete(userId);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- key import/export ----------
function importPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, EC_PARAMS, true, ["deriveKey", "deriveBits"]);
}

export function importPublicKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", b64ToBuf(b64), EC_PARAMS, false, []);
}

// ---------- password wrapping (server backup) ----------
async function deriveWrapKey(password: string, salt: ArrayBuffer): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function wrapPrivateKey(jwk: JsonWebKey, password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveWrapKey(password, salt.buffer);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(jwk)));
  return {
    encryptedPrivateKey: bufToB64(ciphertext),
    keySalt: bufToB64(salt.buffer),
    keyIv: bufToB64(iv.buffer)
  };
}

async function unwrapPrivateKey(
  blob: { encryptedPrivateKey: string; keySalt: string; keyIv: string },
  password: string
): Promise<JsonWebKey> {
  const key = await deriveWrapKey(password, b64ToBuf(blob.keySalt));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(b64ToBuf(blob.keyIv)) }, key, b64ToBuf(blob.encryptedPrivateKey));
  return JSON.parse(new TextDecoder().decode(plain)) as JsonWebKey;
}

export class WrongPasswordError extends Error {
  constructor() {
    super("Incorrect password for encryption keys");
  }
}

/**
 * Ensures this device has the user's private key. Restores it from the
 * password-wrapped server backup, or generates a brand-new identity on first
 * use. Returns the imported private CryptoKey.
 */
export async function setupKeys(token: string, userId: string, password: string): Promise<CryptoKey> {
  const local = await idbGet(userId);
  if (local) return importPrivate(local);

  const { keys } = await api.getKeys(token);
  if (keys?.publicKey && keys.encryptedPrivateKey && keys.keySalt && keys.keyIv) {
    let jwk: JsonWebKey;
    try {
      jwk = await unwrapPrivateKey(keys, password);
    } catch {
      throw new WrongPasswordError();
    }
    await idbPut(userId, jwk);
    return importPrivate(jwk);
  }

  // First time: create the identity and back it up (wrapped) to the server.
  const pair = await crypto.subtle.generateKey(EC_PARAMS, true, ["deriveKey", "deriveBits"]);
  const publicKey = bufToB64(await crypto.subtle.exportKey("spki", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const wrapped = await wrapPrivateKey(jwk, password);
  try {
    await api.saveKeys(token, { publicKey, ...wrapped });
  } catch {
    // Another device created keys first — restore those instead.
    const fresh = await api.getKeys(token);
    if (fresh.keys?.publicKey) {
      const restored = await unwrapPrivateKey(fresh.keys, password).catch(() => {
        throw new WrongPasswordError();
      });
      await idbPut(userId, restored);
      return importPrivate(restored);
    }
    throw new Error("Unable to save encryption keys");
  }
  await idbPut(userId, jwk);
  return pair.privateKey;
}

export async function loadLocalPrivateKey(userId: string): Promise<CryptoKey | null> {
  const local = await idbGet(userId);
  return local ? importPrivate(local) : null;
}

/**
 * Forgets this device's stored private key. Used after a password reset, which
 * clears the server-side identity — the next setupKeys() then generates a fresh
 * identity instead of silently reusing a key the server no longer recognises.
 */
export async function clearLocalPrivateKey(userId: string): Promise<void> {
  await idbDelete(userId).catch(() => {});
}

/**
 * Re-wraps this device's stored private key under a new password, returning the
 * new server backup envelope. Used by "change password" so existing encrypted
 * messages stay decryptable. Returns null when this device holds no key.
 */
export async function rewrapLocalPrivateKey(
  userId: string,
  newPassword: string
): Promise<{ encryptedPrivateKey: string; keySalt: string; keyIv: string } | null> {
  const jwk = await idbGet(userId);
  if (!jwk) return null;
  return wrapPrivateKey(jwk, newPassword);
}

// ---------- per-conversation symmetric key ----------
export async function deriveConversationKey(privateKey: CryptoKey, peerPublicKeyB64: string): Promise<CryptoKey> {
  const peerPublic = await importPublicKey(peerPublicKeyB64);
  return crypto.subtle.deriveKey({ name: "ECDH", public: peerPublic }, privateKey, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt"
  ]);
}

export async function encryptText(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return `${bufToB64(iv.buffer)}.${bufToB64(ciphertext)}`;
}

export async function decryptText(key: CryptoKey, envelope: string): Promise<string> {
  const [ivB64, ctB64] = envelope.split(".");
  if (!ivB64 || !ctB64) throw new Error("Malformed ciphertext");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(b64ToBuf(ivB64)) }, key, b64ToBuf(ctB64));
  return new TextDecoder().decode(plain);
}
