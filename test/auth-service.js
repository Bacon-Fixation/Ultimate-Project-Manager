"use strict";

const assert = require("assert");
const {
  AuthService,
  hashPassword,
  verifyPassword,
  parseCookies,
} = require("../src/security/auth-service");

(async () => {
  const password = "correct horse battery staple";
  const hash = await hashPassword(password);
  assert.match(hash, /^scrypt\$/);
  assert.strictEqual(await verifyPassword(password, hash), true);
  assert.strictEqual(await verifyPassword("wrong password", hash), false);

  const auth = new AuthService({
    enabled: true,
    username: "admin",
    passwordHash: hash,
    sessionSecret: "0123456789abcdef0123456789abcdef0123456789abcdef",
    sessionHours: 12,
    maxAttempts: 3,
    lockoutMinutes: 1,
  });

  const account = await auth.authenticate("admin", password, "127.0.0.1");
  assert.strictEqual(account.username, "admin");
  const token = auth.createSession(account.username);
  assert.ok(token.includes("."));
  assert.strictEqual(auth.verifySession(token).username, "admin");
  assert.strictEqual(auth.verifySession(`${token}tampered`), null);

  const changedPasswordHash = await hashPassword("replacement password for invalidation");
  const afterPasswordChange = new AuthService({
    enabled: true,
    username: "admin",
    passwordHash: changedPasswordHash,
    sessionSecret: "0123456789abcdef0123456789abcdef0123456789abcdef",
    sessionHours: 12,
  });
  assert.strictEqual(
    afterPasswordChange.verifySession(token),
    null,
    "Changing the authentication password must invalidate existing sessions even when the session secret is externally pinned.",
  );

  const afterUsernameChange = new AuthService({
    enabled: true,
    username: "renamed-admin",
    passwordHash: hash,
    sessionSecret: "0123456789abcdef0123456789abcdef0123456789abcdef",
    sessionHours: 12,
  });
  assert.strictEqual(afterUsernameChange.verifySession(token), null);
  assert.strictEqual(
    parseCookies(`x=1; upm_session=${encodeURIComponent(token)}`).upm_session,
    token,
  );
  assert.match(auth.cookieHeader(token), /HttpOnly/);
  assert.match(auth.cookieHeader(token), /SameSite=Strict/);

  const httpPolicy = auth.getCookiePolicy({ requestSecure: false });
  assert.equal(httpPolicy.compatible, true);
  assert.equal(httpPolicy.effectiveSecure, false);

  const secureAuth = new AuthService({
    enabled: true,
    username: "admin",
    passwordHash: hash,
    sessionSecret: "fedcba9876543210fedcba9876543210fedcba9876543210",
    sessionHours: 12,
    cookieSecure: true,
  });
  const insecureLanPolicy = secureAuth.getCookiePolicy({
    requestSecure: false,
  });
  assert.equal(insecureLanPolicy.compatible, false);
  assert.match(insecureLanPolicy.message, /require HTTPS/i);
  assert.match(secureAuth.cookieHeader(token, { secure: false }), /; Secure/);
  assert.equal(secureAuth.getCookiePolicy({ requestSecure: true }).compatible, true);

  let last;
  for (let i = 0; i < 3; i += 1) {
    try {
      await auth.authenticate("admin", "bad-password", "10.0.0.2");
    } catch (error) {
      last = error;
    }
  }
  assert.strictEqual(last.statusCode, 429);
  assert.ok(last.retryAfterSeconds >= 1);

  console.log("Auth service tests passed.");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
