"use strict";

function splitLines(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
}

function buildLineDiff(beforeText, afterText, options = {}) {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  const maxInputLines = Math.max(10, Math.min(5000, Number(options.maxInputLines) || 2000));
  const maxCells = Math.max(10_000, Math.min(5_000_000, Number(options.maxCells) || 1_500_000));
  const maxOutputLines = Math.max(20, Math.min(10_000, Number(options.maxOutputLines) || 4000));

  if (
    before.length > maxInputLines ||
    after.length > maxInputLines ||
    (before.length + 1) * (after.length + 1) > maxCells
  ) {
    return {
      detailed: false,
      reason: "diff-too-large",
      beforeLines: before.length,
      afterLines: after.length,
      lines: [],
    };
  }

  const width = after.length + 1;
  const table = new Uint16Array((before.length + 1) * width);
  const at = (i, j) => i * width + j;

  for (let i = 1; i <= before.length; i += 1) {
    for (let j = 1; j <= after.length; j += 1) {
      table[at(i, j)] =
        before[i - 1] === after[j - 1]
          ? table[at(i - 1, j - 1)] + 1
          : Math.max(table[at(i - 1, j)], table[at(i, j - 1)]);
    }
  }

  const reversed = [];
  let i = before.length;
  let j = after.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && before[i - 1] === after[j - 1]) {
      reversed.push({
        type: "context",
        text: before[i - 1],
        beforeLine: i,
        afterLine: j,
      });
      i -= 1;
      j -= 1;
      continue;
    }

    if (j > 0 && (i === 0 || table[at(i, j - 1)] >= table[at(i - 1, j)])) {
      reversed.push({
        type: "added",
        text: after[j - 1],
        beforeLine: null,
        afterLine: j,
      });
      j -= 1;
      continue;
    }

    reversed.push({
      type: "deleted",
      text: before[i - 1],
      beforeLine: i,
      afterLine: null,
    });
    i -= 1;
  }

  const lines = reversed.reverse();
  const counts = lines.reduce(
    (acc, item) => {
      if (item.type === "added") acc.added += 1;
      if (item.type === "deleted") acc.deleted += 1;
      return acc;
    },
    { added: 0, deleted: 0 },
  );

  const truncated = lines.length > maxOutputLines;
  return {
    detailed: true,
    beforeLines: before.length,
    afterLines: after.length,
    counts,
    truncated,
    lines: truncated ? lines.slice(0, maxOutputLines) : lines,
  };
}

module.exports = {
  splitLines,
  buildLineDiff,
};
