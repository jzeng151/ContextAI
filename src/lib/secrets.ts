import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";

export const secretKeyFromEnv = (value = process.env.INTEGRATION_SECRET_KEY) => {
  const key = value ? Buffer.from(value, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw new Error("INTEGRATION_SECRET_KEY must be a base64-encoded 32-byte key");
  return key;
};

export const encryptSecret = (value: string, key: Buffer) => {
  if (!value) throw new Error("secret is required");
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
};

export const decryptSecret = (value: string, key: Buffer) => {
  const [version, iv, tag, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("encrypted secret is invalid");
  const decipher = createDecipheriv(algorithm, key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
};
