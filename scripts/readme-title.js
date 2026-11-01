"use strict";

/** Accept a stable project title or an exact, explicitly versioned title. */
function readmeTitleIssue(readme, version) {
  const heading = String(readme)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .find((line) => /^#\s+/.test(line));
  const match = heading?.trim().match(/^#\s+Ultimate Project Manager(?:\s+v([^\s]+))?$/);
  if (!match) return 'README must have a top-level "Ultimate Project Manager" title.';
  if (match[1] && match[1] !== String(version))
    return `README title version (${match[1]}) does not match package.json (${version}). Update the title or use "# Ultimate Project Manager".`;
  return null;
}

module.exports = { readmeTitleIssue };
