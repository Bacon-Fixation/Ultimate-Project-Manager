"use strict";

const crypto = require("crypto");
const { isUsableSessionSecret, MIN_SESSION_SECRET_LENGTH } = require("./session-secret");

const HASH_PREFIX = "scrypt";
const HASH_BYTES = 32;
const SCRYPT_OPTIONS = Object.freeze({
  cost: 16384,
  blockSize: 8,
  parallelization: 1,
  maxmem: 64 * 1024 * 1024,
});

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function fromB64url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password || ""), salt, HASH_BYTES, SCRYPT_OPTIONS, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

async function hashPassword(password) {
  const value = String(password || "");
  if (value.length < 10) throw new Error("Authentication password must be at least 10 characters.");
  const salt = crypto.randomBytes(16);
  const digest = await scrypt(value, salt);
  return `${HASH_PREFIX}$${b64url(salt)}$${b64url(digest)}`;
}

async function verifyPassword(password, encoded) {
  const [prefix, saltValue, digestValue, ...extra] = String(encoded || "").split("$");
  if (prefix !== HASH_PREFIX || !saltValue || !digestValue || extra.length) return false;
  let salt;
  let expected;
  try {
    salt = fromB64url(saltValue);
    expected = fromB64url(digestValue);
  } catch {
    return false;
  }
  if (expected.length !== HASH_BYTES || salt.length < 8) return false;
  const actual = await scrypt(String(password || ""), salt);
  return crypto.timingSafeEqual(actual, expected);
}

function parseCookies(header = "") {
  const result = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function signPayload(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function timingSafeTextEqual(a, b) {
  const left = crypto
    .createHash("sha256")
    .update(String(a || ""))
    .digest();
  const right = crypto
    .createHash("sha256")
    .update(String(b || ""))
    .digest();
  return crypto.timingSafeEqual(left, right);
}

class AuthService {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.username = String(options.username || "admin");
    this.passwordHash = String(options.passwordHash || "");
    this.sessionSecret = String(options.sessionSecret || "");
    this.sessionHours = Math.max(1, Math.min(168, Number(options.sessionHours) || 12));
    this.cookieName = String(options.cookieName || "upm_session");
    this.cookieSecure = options.cookieSecure === true;
    this.maxAttempts = Math.max(3, Math.min(100, Number(options.maxAttempts) || 5));
    this.lockoutMinutes = Math.max(1, Math.min(1440, Number(options.lockoutMinutes) || 15));
    this.failures = new Map();

    if (this.enabled) {
      if (!this.passwordHash.startsWith(`${HASH_PREFIX}$`))
        throw new Error(
          'UPM_AUTH_ENABLED=true requires a valid UPM_AUTH_PASSWORD_HASH. Generate one with npm run auth:hash -- "your password".',
        );
      if (!isUsableSessionSecret(this.sessionSecret))
        throw new Error(
          `UPM_AUTH_ENABLED=true requires a valid UPM_SESSION_SECRET with at least ${MIN_SESSION_SECRET_LENGTH} characters. The desktop launcher can repair an invalid .env session secret automatically; external environment overrides must be corrected or removed.`,
        );
    }
  }

  getCookiePolicy(options = {}) {
    const requestSecure = options.requestSecure === true;
    const configuredSecure = this.cookieSecure === true;
    const effectiveSecure = configuredSecure || requestSecure;
    const compatible = !configuredSecure || requestSecure;
    return {
      configuredSecure,
      requestSecure,
      effectiveSecure,
      compatible,
      message: compatible
        ? null
        : "Secure authentication cookies require HTTPS. This request is using HTTP; use HTTPS or set UPM_AUTH_COOKIE_SECURE=false for trusted LAN HTTP access. If HTTPS is terminated by a trusted reverse proxy, enable UPM_TRUST_PROXY and forward the original protocol.",
    };
  }

  getStatus(session = null, options = {}) {
    return {
      enabled: this.enabled,
      authenticated: !this.enabled || Boolean(session),
      username: session?.username || null,
      configuredUsername: this.enabled ? this.username : null,
      sessionHours: this.sessionHours,
      cookie: this.getCookiePolicy(options),
    };
  }

  _failureKey(address) {
    return String(address || "unknown");
  }

  _checkLock(address) {
    const key = this._failureKey(address);
    const current = this.failures.get(key);
    if (!current) return null;
    if (current.lockedUntil && current.lockedUntil > Date.now()) return current;
    if (current.resetAt <= Date.now()) {
      this.failures.delete(key);
      return null;
    }
    return current;
  }

  _recordFailure(address) {
    const key = this._failureKey(address);
    if (this.failures.size > 5000) {
      const now = Date.now();
      for (const [failureKey, value] of this.failures) {
        if ((value.lockedUntil || value.resetAt || 0) <= now) this.failures.delete(failureKey);
      }
      while (this.failures.size > 5000) this.failures.delete(this.failures.keys().next().value);
    }
    const now = Date.now();
    const existing = this._checkLock(address) || {
      count: 0,
      resetAt: now + this.lockoutMinutes * 60_000,
      lockedUntil: 0,
    };
    existing.count += 1;
    if (existing.count >= this.maxAttempts)
      existing.lockedUntil = now + this.lockoutMinutes * 60_000;
    this.failures.set(key, existing);
    return existing;
  }

  clearFailures(address) {
    this.failures.delete(this._failureKey(address));
  }

  async authenticate(username, password, address) {
    if (!this.enabled) return { username: this.username };
    const lock = this._checkLock(address);
    if (lock?.lockedUntil > Date.now()) {
      const retryAfterSeconds = Math.max(1, Math.ceil((lock.lockedUntil - Date.now()) / 1000));
      const error = new Error("Too many failed login attempts. Try again later.");
      error.statusCode = 429;
      error.retryAfterSeconds = retryAfterSeconds;
      throw error;
    }

    const userOk = timingSafeTextEqual(String(username || ""), this.username);
    const passwordOk = await verifyPassword(password, this.passwordHash);
    if (!userOk || !passwordOk) {
      const failure = this._recordFailure(address);
      const error = new Error("Invalid username or password.");
      error.statusCode = failure.lockedUntil > Date.now() ? 429 : 401;
      if (error.statusCode === 429)
        error.retryAfterSeconds = Math.ceil((failure.lockedUntil - Date.now()) / 1000);
      throw error;
    }

    this.clearFailures(address);
    return { username: this.username };
  }

  createSession(username) {
    if (!this.enabled) return "";
    const now = Date.now();
    const payload = b64url(
      Buffer.from(
        JSON.stringify({
          sub: String(username || this.username),
          iat: now,
          exp: now + this.sessionHours * 60 * 60 * 1000,
          nonce: crypto.randomBytes(12).toString("hex"),
        }),
      ),
    );
    return `${payload}.${signPayload(payload, this.sessionSecret)}`;
  }

  verifySession(token) {
    if (!this.enabled) return { username: this.username };
    const [payload, signature, ...extra] = String(token || "").split(".");
    if (!payload || !signature || extra.length) return null;
    const expected = signPayload(payload, this.sessionSecret);
    if (!timingSafeTextEqual(signature, expected)) return null;
    try {
      const data = JSON.parse(fromB64url(payload).toString("utf8"));
      if (!data?.sub || !Number.isFinite(data.exp) || data.exp <= Date.now()) return null;
      if (!timingSafeTextEqual(data.sub, this.username)) return null;
      return {
        username: data.sub,
        expiresAt: new Date(data.exp).toISOString(),
      };
    } catch {
      return null;
    }
  }

  sessionFromRequest(req) {
    if (!this.enabled) return { username: this.username };
    const cookies = parseCookies(req.headers?.cookie || "");
    return this.verifySession(cookies[this.cookieName]);
  }

  cookieHeader(token, options = {}) {
    const parts = [
      `${this.cookieName}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Priority=High",
    ];
    const policy = this.getCookiePolicy({
      requestSecure: options.secure === true,
    });
    if (policy.effectiveSecure) parts.push("Secure");
    if (options.clear) parts.push("Max-Age=0");
    else parts.push(`Max-Age=${Math.floor(this.sessionHours * 60 * 60)}`);
    return parts.join("; ");
  }
}

module.exports = {
  AuthService,
  hashPassword,
  verifyPassword,
  parseCookies,
};
