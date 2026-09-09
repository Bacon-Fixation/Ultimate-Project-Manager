#!/usr/bin/env node
"use strict";

const crypto = require("crypto");

console.log(crypto.randomBytes(32).toString("base64url"));
