#!/usr/bin/env node
"use strict";
const { hashPassword } = require("./auth-service");
const password = process.argv.slice(2).join(" ");
if (!password) {
  console.error('Usage: npm run auth:hash -- "a strong password"');
  process.exit(1);
}
hashPassword(password)
  .then((hash) => console.log(hash))
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
