"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const { pipeline } = require("stream/promises");

const MAGIC = Buffer.from("UPMENC1\0", "ascii");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
const KEY_BYTES = 32;
const SCRYPT_OPTIONS = Object.freeze({
  cost: 16384,
  blockSize: 8,
  parallelization: 1,
  maxmem: 64 * 1024 * 1024,
});

function requirePassphrase(passphrase) {
  const value = String(passphrase || "");
  if (value.length < 16)
    throw new Error(
      "Backup encryption requires UPM_BACKUP_ENCRYPTION_KEY with at least 16 characters.",
    );
  return value;
}

function deriveKey(passphrase, salt) {
  const secret = requirePassphrase(passphrase);
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, KEY_BYTES, SCRYPT_OPTIONS, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

async function readHeader(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size < HEADER_BYTES + TAG_BYTES) return { encrypted: false, size: stat.size };
    const header = Buffer.alloc(HEADER_BYTES);
    await handle.read(header, 0, HEADER_BYTES, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC))
      return { encrypted: false, size: stat.size };
    return {
      encrypted: true,
      size: stat.size,
      header,
      salt: header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES),
      iv: header.subarray(MAGIC.length + SALT_BYTES),
      ciphertextBytes: stat.size - HEADER_BYTES - TAG_BYTES,
    };
  } finally {
    await handle.close();
  }
}

async function isEncryptedFile(filePath) {
  return (await readHeader(filePath)).encrypted;
}

async function encryptFile(inputPath, outputPath, passphrase) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const key = await deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(header);

  await fsp.mkdir(require("path").dirname(outputPath), { recursive: true });
  const handle = await fsp.open(outputPath, "w", 0o600);
  try {
    await handle.write(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }

  await pipeline(
    fs.createReadStream(inputPath),
    cipher,
    fs.createWriteStream(outputPath, { flags: "a", mode: 0o600 }),
  );
  await fsp.appendFile(outputPath, cipher.getAuthTag());
  const stat = await fsp.stat(outputPath);
  return {
    encrypted: true,
    format: "UPMENC1",
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    size: stat.size,
  };
}

async function decryptFile(inputPath, outputPath, passphrase) {
  const info = await readHeader(inputPath);
  if (!info.encrypted)
    throw new Error("Backup is not an Ultimate Project Manager encrypted archive.");
  const key = await deriveKey(passphrase, info.salt);
  const tag = Buffer.alloc(TAG_BYTES);
  const handle = await fsp.open(inputPath, "r");
  try {
    await handle.read(tag, 0, TAG_BYTES, info.size - TAG_BYTES);
  } finally {
    await handle.close();
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, info.iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(info.header);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      fs.createReadStream(inputPath, {
        start: HEADER_BYTES,
        end: info.size - TAG_BYTES - 1,
      }),
      decipher,
      fs.createWriteStream(outputPath, { flags: "w", mode: 0o600 }),
    );
  } catch (error) {
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    const wrapped = new Error(
      "Backup decryption failed. Check UPM_BACKUP_ENCRYPTION_KEY or archive integrity.",
    );
    wrapped.code = "UPM_DECRYPT_FAILED";
    wrapped.cause = error;
    throw wrapped;
  }
  return {
    decrypted: true,
    format: "UPMENC1",
    cipher: "aes-256-gcm",
    kdf: "scrypt",
  };
}

module.exports = {
  MAGIC,
  HEADER_BYTES,
  TAG_BYTES,
  deriveKey,
  encryptFile,
  decryptFile,
  isEncryptedFile,
  readHeader,
};
