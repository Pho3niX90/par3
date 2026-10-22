// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no X25519, HKDF, or AES-GCM.
import * as NodeCrypto from "node:crypto";

const RECIPIENT_CONTEXT = "par3-vault-recipient-v1";
const WRAP_INFO = "par3-vault-wrap-v1";
const ENTRY_AAD_PREFIX = "par3-vault-entry-v1:";
const VAULT_ID_CONTEXT = "par3-vault-id-v1";

export interface X25519KeyPair {
  /** Base64url raw keys, as in a JWK. */
  readonly privateKey: string;
  readonly publicKey: string;
}

export interface SealedValue {
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export interface WrappedVaultKey extends SealedValue {
  readonly ephemeralPublicKey: string;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromB64 = (value: string) => Buffer.from(value, "base64");

export function generateX25519KeyPair(): X25519KeyPair {
  const pair = NodeCrypto.generateKeyPairSync("x25519");
  const jwk = pair.privateKey.export({ format: "jwk" });
  if (typeof jwk.d !== "string" || typeof jwk.x !== "string") {
    throw new Error("X25519 key export did not include raw key material.");
  }
  return { privateKey: jwk.d, publicKey: jwk.x };
}

const publicKeyObject = (publicKey: string) =>
  NodeCrypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: publicKey }, format: "jwk" });

const privateKeyObject = (pair: X25519KeyPair) =>
  NodeCrypto.createPrivateKey({
    key: { kty: "OKP", crv: "X25519", x: pair.publicKey, d: pair.privateKey },
    format: "jwk",
  });

/** Short, human-comparable digest; enough to notice a swapped key, not a security boundary. */
function fingerprint(bytes: Uint8Array | string): string {
  const hex = NodeCrypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return hex.match(/.{4}/g)!.join("-");
}

export const recipientFingerprint = (publicKey: string) =>
  fingerprint(Buffer.from(publicKey, "base64url"));

export const vaultKeyFingerprint = (vaultKey: Uint8Array) =>
  fingerprint(Buffer.concat([Buffer.from(VAULT_ID_CONTEXT), vaultKey]));

const recipientMessage = (environmentId: string, publicKey: string) =>
  Buffer.from(`${RECIPIENT_CONTEXT}\n${environmentId}\n${publicKey}`);

export function signRecipient(
  environmentId: string,
  publicKey: string,
  signingPrivateKeyPem: string,
): string {
  return b64(
    NodeCrypto.sign(null, recipientMessage(environmentId, publicKey), signingPrivateKeyPem),
  );
}

export function verifyRecipient(input: {
  readonly environmentId: string;
  readonly publicKey: string;
  readonly signingPublicKey: string;
  readonly signature: string;
}): boolean {
  try {
    return NodeCrypto.verify(
      null,
      recipientMessage(input.environmentId, input.publicKey),
      input.signingPublicKey,
      fromB64(input.signature),
    );
  } catch {
    return false;
  }
}

function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): SealedValue {
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: b64(iv), ciphertext: b64(ciphertext), tag: b64(cipher.getAuthTag()) };
}

/** Throws when the key, AAD, or any byte of the sealed value is wrong. */
function open(key: Uint8Array, sealed: SealedValue, aad: Uint8Array): Buffer {
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, fromB64(sealed.iv));
  decipher.setAAD(aad);
  decipher.setAuthTag(fromB64(sealed.tag));
  return Buffer.concat([decipher.update(fromB64(sealed.ciphertext)), decipher.final()]);
}

export const generateVaultKey = (): Uint8Array => NodeCrypto.randomBytes(32);

const entryAad = (name: string) => Buffer.from(`${ENTRY_AAD_PREFIX}${name}`);

/** The name is bound into the ciphertext, so a value cannot be replayed under another name. */
export const encryptEntry = (vaultKey: Uint8Array, name: string, value: string): SealedValue =>
  seal(vaultKey, Buffer.from(value, "utf8"), entryAad(name));

export const decryptEntry = (vaultKey: Uint8Array, name: string, sealed: SealedValue): string =>
  open(vaultKey, sealed, entryAad(name)).toString("utf8");

function wrapKey(shared: Buffer, ephemeralPublicKey: string, recipientPublicKey: string) {
  const salt = Buffer.from(`${ephemeralPublicKey}.${recipientPublicKey}`);
  return Buffer.from(NodeCrypto.hkdfSync("sha256", shared, salt, WRAP_INFO, 32));
}

/** Sealed box: only the holder of the recipient's private key can open it. */
export function wrapVaultKey(vaultKey: Uint8Array, recipientPublicKey: string): WrappedVaultKey {
  const ephemeral = generateX25519KeyPair();
  const shared = NodeCrypto.diffieHellman({
    privateKey: privateKeyObject(ephemeral),
    publicKey: publicKeyObject(recipientPublicKey),
  });
  const key = wrapKey(shared, ephemeral.publicKey, recipientPublicKey);
  return {
    ephemeralPublicKey: ephemeral.publicKey,
    ...seal(key, vaultKey, Buffer.from(WRAP_INFO)),
  };
}

export function unwrapVaultKey(wrapped: WrappedVaultKey, recipient: X25519KeyPair): Uint8Array {
  const shared = NodeCrypto.diffieHellman({
    privateKey: privateKeyObject(recipient),
    publicKey: publicKeyObject(wrapped.ephemeralPublicKey),
  });
  const key = wrapKey(shared, wrapped.ephemeralPublicKey, recipient.publicKey);
  return Uint8Array.from(open(key, wrapped, Buffer.from(WRAP_INFO)));
}

export const sha256Hex = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

/** JSON with sorted keys, so equal values hash the same on every machine. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).toSorted(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  );
}
