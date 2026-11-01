"use strict";

const assert = require("assert");
const {
  normalizeRemoteUrl,
  normalizeRemoteConnection,
  sanitizeRemoteConnections,
  remoteSessionPartition,
  sameRemoteOrigin,
  isPlainHttpRemote,
} = require("../desktop/remote-connections");

(() => {
  assert.strictEqual(normalizeRemoteUrl("http://192.168.1.50:4310/"), "http://192.168.1.50:4310");
  assert.strictEqual(
    normalizeRemoteUrl("https://upm-workshop.local:4310"),
    "https://upm-workshop.local:4310",
  );
  assert.throws(() => normalizeRemoteUrl("file:///tmp/upm"), /HTTP or HTTPS/);
  assert.throws(
    () => normalizeRemoteUrl("http://admin:secret@192.168.1.50:4310"),
    /usernames or passwords/,
  );
  assert.throws(
    () => normalizeRemoteUrl("http://192.168.1.50:4310/dashboard"),
    /hosted at the root/,
  );
  assert.throws(() => normalizeRemoteUrl("http://192.168.1.50:4310/?token=x"), /query string/);
  assert.throws(() => normalizeRemoteUrl("http://upm\n.local:4310"), /control characters/);

  const connection = normalizeRemoteConnection(
    {
      id: "workshop",
      name: "Workshop PC",
      url: "http://192.168.1.50:4310/",
      rememberSession: true,
    },
    { idFactory: () => "unused" },
  );
  assert.deepStrictEqual(connection, {
    id: "workshop",
    name: "Workshop PC",
    url: "http://192.168.1.50:4310",
    rememberSession: true,
  });
  assert.strictEqual(isPlainHttpRemote(connection), true);
  assert.match(remoteSessionPartition(connection), /^persist:upm-remote-[a-f0-9]{24}$/);
  assert.match(
    remoteSessionPartition({ ...connection, rememberSession: false }),
    /^upm-remote-[a-f0-9]{24}$/,
  );
  assert.strictEqual(sameRemoteOrigin(connection, "http://192.168.1.50:4310/api/status"), true);
  assert.strictEqual(sameRemoteOrigin(connection, "https://192.168.1.50:4310/api/status"), false);
  assert.strictEqual(sameRemoteOrigin(connection, "http://192.168.1.51:4310/"), false);

  const sanitized = sanitizeRemoteConnections([
    connection,
    { ...connection, id: "duplicate-url" },
    { id: "secure", name: "Secure UPM", url: "https://upm.local:4310", rememberSession: false },
    { id: "broken", name: "Broken", url: "javascript:alert(1)" },
  ]);
  assert.strictEqual(sanitized.length, 2);
  assert.strictEqual(sanitized[0].id, "workshop");
  assert.strictEqual(sanitized[1].id, "secure");

  const generated = normalizeRemoteConnection(
    { name: "Generated", url: "https://host.local:4310" },
    { idFactory: () => "generated-id" },
  );
  assert.strictEqual(generated.id, "generated-id");
  assert.throws(
    () => normalizeRemoteConnection({ name: "Bad\nName", url: "https://host.local:4310" }),
    /control characters/,
  );

  console.log("remote-connections tests passed");
})();
