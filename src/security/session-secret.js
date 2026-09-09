"use strict";

const crypto = require("crypto");

const MIN_SESSION_SECRET_LENGTH = 32;
const GENERATED_SESSION_SECRET_BYTES = 48;

function isUsableSessionSecret(value) {
  const secret = String(value || "");
  return secret.length >= MIN_SESSION_SECRET_LENGTH && !/[\r\n\0]/.test(secret);
}

function generateSessionSecret() {
  // Hex is deliberately used instead of base64/base64url here. It is longer,
  // shell/.env safe on every supported platform, and cannot contain quoting or
  // comment characters that can be misinterpreted by launchers.
  return crypto.randomBytes(GENERATED_SESSION_SECRET_BYTES).toString("hex");
}

module.exports = {
  MIN_SESSION_SECRET_LENGTH,
  GENERATED_SESSION_SECRET_BYTES,
  isUsableSessionSecret,
  generateSessionSecret,
};
