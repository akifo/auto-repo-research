#!/usr/bin/env node
// 2つの研究ディレクトリを定量比較するスクリプト
// Usage: node scripts/compare-research.mjs <baseline_dir> <new_dir>

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [baselineDir, newDir] = process.argv.slice(2);
if (!baselineDir || !newDir) {
  console.error("Usage: node scripts/compare-research.mjs <baseline_dir> <new_dir>");
  process.exit(1);
}

function analyze(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "overview.md" && f !== "rules.md");
  let totalLines = 0;
  let must = 0;
  let should = 0;
  let avoid = 0;
  let codeRefs = 0;

  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf-8");
    const lines = content.split("\n");
    totalLines += lines.length;
    for (const line of lines) {
      if (/\[MUST\]/.test(line)) must++;
      if (/\[SHOULD\]/.test(line)) should++;
      if (/\[AVOID\]/.test(line)) avoid++;
      if (/\S+\.\w+:\d+/.test(line)) codeRefs++;
    }
  }

  // rules.md も別途カウント
  try {
    const rulesContent = readFileSync(join(dir, "rules.md"), "utf-8");
    for (const line of rulesContent.split("\n")) {
      if (/\[MUST\]/.test(line)) must++;
      if (/\[SHOULD\]/.test(line)) should++;
      if (/\[AVOID\]/.test(line)) avoid++;
    }
  } catch {
    // rules.md が存在しない場合は無視
  }

  return { perspectives: files.length, totalLines, must, should, avoid, codeRefs };
}

const baseline = analyze(baselineDir);
const current = analyze(newDir);

function fmt(val, ref) {
  const diff = val - ref;
  const sign = diff > 0 ? "+" : "";
  return `${val} (${sign}${diff})`;
}

console.log("| Metric              | Baseline | New              |");
console.log("|---------------------|----------|------------------|");
console.log(
  `| Perspectives        | ${String(baseline.perspectives).padEnd(8)} | ${
    fmt(current.perspectives, baseline.perspectives).padEnd(16)
  } |`,
);
console.log(
  `| Total lines         | ${String(baseline.totalLines).padEnd(8)} | ${
    fmt(current.totalLines, baseline.totalLines).padEnd(16)
  } |`,
);
console.log(
  `| Rules [MUST]        | ${String(baseline.must).padEnd(8)} | ${fmt(current.must, baseline.must).padEnd(16)} |`,
);
console.log(
  `| Rules [SHOULD]      | ${String(baseline.should).padEnd(8)} | ${fmt(current.should, baseline.should).padEnd(16)} |`,
);
console.log(
  `| Rules [AVOID]       | ${String(baseline.avoid).padEnd(8)} | ${fmt(current.avoid, baseline.avoid).padEnd(16)} |`,
);
console.log(
  `| Code references     | ${String(baseline.codeRefs).padEnd(8)} | ${
    fmt(current.codeRefs, baseline.codeRefs).padEnd(16)
  } |`,
);
