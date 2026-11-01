"use strict";

const assert = require("assert/strict");
const { trustedDesktopRequest } = require("../src/security/desktop-trust");

const token = "desktop-token-123";
const request = (value) => ({
  get(name) {
    return String(name).toLowerCase() === "x-upm-desktop-token" ? value : undefined;
  },
});

assert.equal(trustedDesktopRequest(request(token), token), true);
assert.equal(trustedDesktopRequest(request("wrong"), token), false);
assert.equal(trustedDesktopRequest(request(""), token), false);
assert.equal(trustedDesktopRequest(request(token), ""), false);
assert.equal(trustedDesktopRequest({}, token), false);
console.log("desktop-trust tests passed");
