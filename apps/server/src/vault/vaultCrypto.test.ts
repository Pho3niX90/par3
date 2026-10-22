// @effect-diagnostics-next-line nodeBuiltinImport:off -- the fixture needs an Ed25519 signing key.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import {
  canonicalJson,
  decryptEntry,
  encryptEntry,
  generateVaultKey,
  generateX25519KeyPair,
  recipientFingerprint,
  signRecipient,
  unwrapVaultKey,
  verifyRecipient,
  wrapVaultKey,
} from "./vaultCrypto.ts";

const signingKeys = () =>
  NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });

describe("vault entries", () => {
  it("round-trips a value under its own name only", () => {
    const key = generateVaultKey();
    const sealed = encryptEntry(key, "API_TOKEN", "s3cret");
    expect(decryptEntry(key, "API_TOKEN", sealed)).toBe("s3cret");
    expect(() => decryptEntry(key, "OTHER_NAME", sealed)).toThrow();
  });

  it("refuses a value sealed with another vault's key or altered in transit", () => {
    const sealed = encryptEntry(generateVaultKey(), "API_TOKEN", "s3cret");
    expect(() => decryptEntry(generateVaultKey(), "API_TOKEN", sealed)).toThrow();
    const key = generateVaultKey();
    const original = encryptEntry(key, "API_TOKEN", "s3cret");
    const tampered = { ...original, ciphertext: Buffer.from("xxxxxx").toString("base64") };
    expect(() => decryptEntry(key, "API_TOKEN", tampered)).toThrow();
  });
});

describe("vault key sharing", () => {
  it("opens a wrapped key only with the recipient's private key", () => {
    const vaultKey = generateVaultKey();
    const recipient = generateX25519KeyPair();
    const wrapped = wrapVaultKey(vaultKey, recipient.publicKey);
    expect(Buffer.from(unwrapVaultKey(wrapped, recipient))).toEqual(Buffer.from(vaultKey));
    expect(() => unwrapVaultKey(wrapped, generateX25519KeyPair())).toThrow();
  });

  it("verifies a recipient key signed by its environment and rejects a swapped one", () => {
    const signing = signingKeys();
    const recipient = generateX25519KeyPair();
    const signature = signRecipient("env-b", recipient.publicKey, signing.privateKey);
    const presented = {
      environmentId: "env-b",
      publicKey: recipient.publicKey,
      signingPublicKey: signing.publicKey,
      signature,
    };
    expect(verifyRecipient(presented)).toBe(true);
    expect(verifyRecipient({ ...presented, publicKey: generateX25519KeyPair().publicKey })).toBe(
      false,
    );
    expect(verifyRecipient({ ...presented, environmentId: "env-c" })).toBe(false);
    expect(recipientFingerprint(recipient.publicKey)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  });
});

describe("canonicalJson", () => {
  it("orders keys so equal values hash the same everywhere", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });
});
