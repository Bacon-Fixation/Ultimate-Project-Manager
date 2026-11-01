"use strict";

const assert = require("assert");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  encryptFile,
  decryptFile,
  isEncryptedFile,
  readHeader,
} = require("../src/security/backup-crypto");

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "upm-crypto-"));
  try {
    const source = path.join(dir, "source.tar.gz");
    const encrypted = path.join(dir, "source.tar.gz.upmenc");
    const restored = path.join(dir, "restored.tar.gz");
    const secret = "unit-test-secret-with-more-than-sixteen-characters";
    const payload = Buffer.concat([
      Buffer.from("UPM encrypted backup test\n"),
      Buffer.alloc(128 * 1024, 0x5a),
    ]);
    await fsp.writeFile(source, payload);

    const info = await encryptFile(source, encrypted, secret);
    assert.strictEqual(info.encrypted, true);
    assert.strictEqual(info.cipher, "aes-256-gcm");
    assert.strictEqual(await isEncryptedFile(encrypted), true);
    assert.strictEqual((await readHeader(encrypted)).encrypted, true);

    await decryptFile(encrypted, restored, secret);
    assert.deepStrictEqual(await fsp.readFile(restored), payload);

    await assert.rejects(
      decryptFile(
        encrypted,
        path.join(dir, "wrong.tar.gz"),
        "different-secret-with-enough-characters",
      ),
      /decryption failed/i,
    );

    const tampered = Buffer.from(await fsp.readFile(encrypted));
    tampered[Math.floor(tampered.length / 2)] ^= 0x01;
    const tamperedFile = path.join(dir, "tampered.upmenc");
    await fsp.writeFile(tamperedFile, tampered);
    await assert.rejects(
      decryptFile(tamperedFile, path.join(dir, "tampered.tar.gz"), secret),
      /decryption failed/i,
    );

    console.log("Backup crypto tests passed.");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
