/**
 * VitePress コンテンツ内の ${{ }} が v-pre で保護されていない箇所を検出する。
 *
 * 対象: repos/, showcases/ 配下の .md ファイル
 * 保護パターン:
 *   - ::: v-pre ～ ::: ブロック内
 *   - <code v-pre>...</code> インライン内
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TARGET_DIRS = ["repos", "showcases"];
const DOLLAR_BRACE = /\$\{\{/;

async function collectMarkdownFiles(dir) {
  const files = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(full)));
    } else if (entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

function isProtectedInline(line) {
  // <code v-pre>...</code> で ${{ が囲まれているかチェック
  // 全ての ${{ が <code v-pre>...</code> 内に収まっているか確認
  const stripped = line.replace(/<code v-pre>.*?<\/code>/g, "");
  return !DOLLAR_BRACE.test(stripped);
}

function checkFile(filePath, content) {
  const lines = content.split("\n");
  const errors = [];

  // ::: v-pre ブロックのネスト追跡用スタック
  const stack = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // コンテナディレクティブの開始: :::+ <directive>
    const openMatch = line.match(/^(:{3,})\s+(\S+)/);
    if (openMatch) {
      stack.push({
        colonCount: openMatch[1].length,
        isVpre: openMatch[2].trim() === "v-pre",
      });
      continue;
    }

    // コンテナディレクティブの終了: :::+ (空)
    const closeMatch = line.match(/^(:{3,})\s*$/);
    if (closeMatch && stack.length > 0) {
      const closeColons = closeMatch[1].length;
      if (stack[stack.length - 1].colonCount <= closeColons) {
        stack.pop();
      }
      continue;
    }

    // ${{ を含む行のチェック
    if (!DOLLAR_BRACE.test(line)) continue;

    const insideVpre = stack.some((entry) => entry.isVpre);
    if (insideVpre) continue;

    if (isProtectedInline(line)) continue;

    const rel = relative(ROOT, filePath);
    errors.push(`  ${rel}:${i + 1}: ${line.trimStart()}`);
  }

  return errors;
}

async function main() {
  const allErrors = [];

  for (const dir of TARGET_DIRS) {
    const absDir = join(ROOT, dir);
    let files;
    try {
      files = await collectMarkdownFiles(absDir);
    } catch {
      continue; // ディレクトリが存在しない場合はスキップ
    }

    for (const file of files) {
      const content = await readFile(file, "utf-8");
      allErrors.push(...checkFile(file, content));
    }
  }

  if (allErrors.length > 0) {
    console.error(
      `\x1b[31mError: ${allErrors.length} unprotected \${{ }} found.\x1b[0m`,
    );
    console.error("Wrap with ::: v-pre block or <code v-pre>...</code>:\n");
    for (const err of allErrors) {
      console.error(err);
    }
    process.exit(1);
  }

  console.log("No unprotected ${{ }} found.");
}

main();
