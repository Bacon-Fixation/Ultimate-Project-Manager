"use strict";

const crypto = require("crypto");

function trustedDesktopRequest(req, token) {
  if (!token) return false;
  const supplied = String(req?.get?.("x-upm-desktop-token") || "");
  if (!supplied) return false;
  const expectedDigest = crypto.createHash("sha256").update(String(token)).digest();
  const suppliedDigest = crypto.createHash("sha256").update(supplied).digest();
  return crypto.timingSafeEqual(expectedDigest, suppliedDigest);
}

module.exports = { trustedDesktopRequest };
