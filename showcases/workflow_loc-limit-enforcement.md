# Workflow: LOC Limit Enforcement

> 出典: [repos/openclaw/openclaw](../repos/openclaw/openclaw/)
> カテゴリ: workflow

## 概要

ファイルあたりの行数上限を CI スクリプトと AI エージェントルールの二層で強制し、巨大ファイル化を構造的に防止するワークフロー。「小さく保て」を精神論で終わらせず、定量的な閾値を機械的に検査することで、特に AI エージェントが生成するコードの際限ない肥大化を阻止する。openclaw/openclaw では 500 LOC をスクリプト閾値、~700 LOC をガイドライン上限とする二段構えで運用している。

## 背景・文脈

openclaw/openclaw は 193K+ Stars、3,328+ ソースファイルを持つ大規模 TypeScript モノレポである。AI エージェント（Claude, Codex, Copilot 等）と人間の開発者が同時並行でコードを変更する「マルチエージェント開発」を前提としている。

このような環境では、ファイルの肥大化が複数の問題を引き起こす:

1. **マージコンフリクトの増加**: 大きなファイルに複数のエージェント/開発者が同時に変更を加えると衝突確率が上がる
2. **AI コンテキストウィンドウの浪費**: AI がファイル全体を読み込むコストが増大する
3. **変更の局所性の喪失**: 1 箇所の変更が関係のない部分に影響しうる範囲が広がる
4. **レビュー負荷の増大**: 巨大ファイルの差分レビューは見落としを招く

openclaw はこれらを防ぐために、LOC 上限を「AGENTS.md での宣言」「CI スクリプトでの自動検査」「超過時の分割パターン」の 3 つの仕組みで多層的に管理している。

## 実装パターン

### 1. AGENTS.md / CLAUDE.md での行数制限宣言

AI エージェントが最初に読み込むコンテキストファイルに、行数ガイドラインを明記する。

```markdown
<!-- AGENTS.md -->

- Aim to keep files under ~700 LOC. If a file grows beyond that,
  split it into focused sub-modules.
```

この記載は AI エージェントに「ファイルを生成・編集する際の行数意識」を植え付ける。~700 LOC はガイドラインであり、厳密な閾値は CI スクリプトが担う。

### 2. CI 検査スクリプト

`scripts/check-ts-max-loc.ts` がファイルごとの行数を検査し、閾値超過を報告する。

```typescript
// scripts/check-ts-max-loc.ts:28-37 — git 管理ファイル + untracked ファイルを対象に列挙
function gitLsFilesAll(): string[] {
  // Include untracked files too so local refactors don't "pass" by accident.
  const stdout = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  // ...
}
```

```typescript
// scripts/check-ts-max-loc.ts:55-76 — LOC 上限の自動検査
const files = gitLsFilesAll()
  .filter((filePath) => existsSync(filePath))
  .filter((filePath) => filePath.endsWith(".ts") || filePath.endsWith(".tsx"));

const results = await Promise.all(
  files.map(async (filePath) => ({ filePath, lines: await countLines(filePath) })),
);

const offenders = results
  .filter((result) => result.lines > maxLines)
  .toSorted((a, b) => b.lines - a.lines);
```

注目すべき設計判断:

- **untracked ファイルも対象**: `git ls-files --others --exclude-standard` で、まだコミットされていないファイルも検査対象に含める。ローカルでリファクタリング中のファイルが「コミット前は通っていたのに」という事態を防ぐ
- **デフォルト閾値は 500 行**: `--max 500` がデフォルトで、AGENTS.md の ~700 LOC ガイドラインより厳しい。スクリプトで早期検出し、ガイドライン上限に達する前に対処を促す

### 3. package.json への組み込み

```jsonc
// package.json
{
  "scripts": {
    "check:loc": "tsx scripts/check-ts-max-loc.ts",
  },
}
```

`pnpm check:loc` で実行でき、CI パイプラインの品質ゲート（`pnpm check` = format:check + tsgo + lint + check:loc）に組み込まれている。

### 4. 超過時の分割パターン（ドット区切りファイル名）

LOC 上限を超えたファイルは、サブディレクトリを作らずにドット区切りファイル名で分割する。

```
# 分割前
src/commands/status.ts  (800行)

# 分割後
src/commands/status.ts              # バレル（3行: re-export のみ）
src/commands/status.command.ts      # コマンド定義
src/commands/status.format.ts       # 表示フォーマット
src/commands/status.types.ts        # 型定義
src/commands/status.scan.ts         # スキャンロジック
```

```
# 型定義の分割例
src/config/types.ts                  # バレル（export * from "./types.*.js"）
src/config/types.agent-defaults.ts   # エージェント設定型
src/config/types.agents.ts           # エージェント型
src/config/types.gateway.ts          # ゲートウェイ型
# ... 30+ ファイル、各100-460行
```

この手法の利点:

- `glob("status.*")` や `grep -l "status\."` で関連ファイルを一括検索できる
- ディレクトリを作る場合の `index.ts` ボイラープレートが不要
- ファイルシステム上で隣接して表示され、グループが視認しやすい

### 5. 二段構えの閾値設計

| レイヤー                    | 閾値     | 役割                                                                              |
| --------------------------- | -------- | --------------------------------------------------------------------------------- |
| CI スクリプト (`check:loc`) | 500 LOC  | 機械的な早期検出。超過時に CI が失敗                                              |
| AGENTS.md ガイドライン      | ~700 LOC | AI エージェント・人間向けの柔軟な上限。500-700 の範囲は「分割を検討すべき」ゾーン |

この二段構えにより、500 行を超えた時点で警告が出るが、正当な理由があれば ~700 行まで許容する余地を残している。

## Good Example

CI スクリプト + AGENTS.md + 分割パターンの三層で LOC を管理する構成。

```markdown
<!-- AGENTS.md / CLAUDE.md -->

## Code Style

- Aim to keep files under ~700 LOC. If a file grows beyond that,
  split it into focused sub-modules using dot-separated filenames
  (e.g., `status.command.ts`, `status.format.ts`).
```

```typescript
// scripts/check-ts-max-loc.ts — CI で実行される LOC チェッカー
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const maxLines = parseInt(process.argv[2] ?? "500", 10);

async function countLines(filePath: string): Promise<number> {
  let count = 0;
  const rl = createInterface({ input: createReadStream(filePath) });
  for await (const _ of rl) count++;
  return count;
}

function gitLsFilesAll(): string[] {
  const stdout = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  );
  return stdout.trim().split("\n").filter(Boolean);
}

const files = gitLsFilesAll()
  .filter((f) => existsSync(f))
  .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

const results = await Promise.all(
  files.map(async (filePath) => ({ filePath, lines: await countLines(filePath) })),
);

const offenders = results
  .filter((r) => r.lines > maxLines)
  .toSorted((a, b) => b.lines - a.lines);

if (offenders.length > 0) {
  console.error(`Files exceeding ${maxLines} LOC:`);
  for (const { filePath, lines } of offenders) {
    console.error(`  ${lines} ${filePath}`);
  }
  process.exit(1);
}
```

```jsonc
// package.json
{
  "scripts": {
    "check:loc": "tsx scripts/check-ts-max-loc.ts",
    "check": "pnpm format:check && pnpm tsgo && pnpm lint && pnpm check:loc",
  },
}
```

```yaml
# .github/workflows/check.yml
jobs:
  quality:
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm check  # format + typecheck + lint + LOC チェック
```

この構成の利点:

- **定量的**: 「小さく保て」が 500 / 700 という具体的な数値になっている
- **自動的**: CI が毎回チェックするため、レビューでの見落としがない
- **段階的**: 500 行で早期警告、700 行でガイドライン超過と、段階的に対処を促す
- **AI 対応**: AGENTS.md に明記することで、AI エージェントがファイル生成時に行数を意識する
- **untracked 対応**: コミット前のファイルも検査対象にし、ローカルでの見逃しを防ぐ

## Bad Example

行数制限を設けない、または精神論だけで管理する実装。

```markdown
<!-- Bad: 曖昧なガイドライン -->

## Code Style

- ファイルは小さく保ちましょう。
- 大きくなりすぎたら分割を検討してください。

<!-- → 「小さい」「大きすぎ」の基準が不明確 -->
<!-- → AI エージェントは具体的な閾値がないと判断できない -->
<!-- → 結果として 1000 行超のファイルが量産される -->
```

```jsonc
// Bad: CI に LOC チェックがない
{
  "scripts": {
    "check": "pnpm format:check && pnpm typecheck && pnpm lint",
    // LOC チェックなし — レビューで気づくまで超過が放置される
  },
}
```

```typescript
// Bad: 超過を検知しても対処パターンがない
// → 1156 行の src/config/io.ts が存在し続ける
// → 開発者は「どう分割すべきか」の指針がなく、放置される

// Bad: git 管理ファイルだけを対象にする
function getFiles(): string[] {
  // untracked ファイルを見ない
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .trim().split("\n");
  // → ローカルで新規作成した 800 行のファイルが検査をすり抜ける
}
```

```markdown
<!-- Bad: AI 向け指示に行数制限がない -->

## AGENTS.md

- Follow the coding style of the project.
- Write clean, maintainable code.

<!-- → AI エージェントは「きれいなコード」を書くが -->
<!-- → 1 ファイルに全ロジックを詰め込む傾向がある -->
<!-- → 具体的な行数制限がなければ、分割のトリガーが存在しない -->
```

## 適用ガイド

### どのような状況で使うべきか

- AI エージェントがコードを生成・編集するプロジェクト（AI は指示がなければファイルを分割しない傾向がある）
- 複数の開発者・エージェントが同じファイルを同時に編集しうるモノレポ
- TypeScript / JavaScript プロジェクトで、ファイル肥大化によるビルド・テストへの影響が懸念される場合
- レビュー負荷の軽減を目指すチーム

### 導入時の注意点

- **既存の超過ファイルへの対応**: 導入時点で閾値を超えるファイルが存在する場合、即座に全て分割するのは非現実的。allowlist（除外リスト）を設けて段階的に対応するか、閾値を現状に合わせて段階的に引き下げるアプローチが有効
- **閾値の決定**: openclaw では 500（スクリプト）/ 700（ガイドライン）だが、プロジェクトの性質に応じて調整する。データ定義が多いプロジェクトでは上限を緩めてもよい
- **言語・ファイルタイプの考慮**: TypeScript 以外（CSS, JSON, 設定ファイル等）にも適用すべきか検討する。openclaw は `.ts` / `.tsx` に限定している
- **分割パターンの提示が必須**: 閾値を設けるだけでは不十分。「超えたらどう分割するか」のパターン（ドット区切りファイル名、型ファイルのドメイン分割等）を明示しないと、開発者が対処方法に迷う

### カスタマイズポイント

- **閾値の調整**: `--max` 引数で閾値を変更可能にし、プロジェクトの成熟度に応じて引き下げる

```jsonc
// 初期導入時は緩めに
{ "check:loc": "tsx scripts/check-ts-max-loc.ts --max 800" }

// 慣れてきたら引き締め
{ "check:loc": "tsx scripts/check-ts-max-loc.ts --max 500" }
```

- **除外パターン**: テストファイルや自動生成ファイルを除外する場合

```typescript
const files = gitLsFilesAll()
  .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
  .filter((f) => !f.endsWith(".test.ts")) // テスト除外
  .filter((f) => !f.endsWith(".e2e.test.ts")) // E2E 除外
  .filter((f) => !f.includes("/generated/")); // 自動生成除外
```

- **ESLint ルールとの併用**: `eslint-plugin-max-lines` を使えば、エディタ上でリアルタイムに警告を出せる

```javascript
// eslint.config.mjs
export default [
  {
    rules: {
      "max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }],
    },
  },
];
```

- **pre-commit hook での検査**: CI より早い段階で検出したい場合

```bash
#!/bin/sh
# git-hooks/pre-commit
staged_ts=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|tsx)$')
for file in $staged_ts; do
  lines=$(wc -l < "$file")
  if [ "$lines" -gt 500 ]; then
    echo "WARNING: $file has $lines lines (limit: 500)"
  fi
done
```

## 参考

- [repos/openclaw/openclaw/code-organization.md](../repos/openclaw/openclaw/code-organization.md) -- ファイル分割規約とドット区切り命名パターンの詳細分析
- [repos/openclaw/openclaw/dev-conventions.md](../repos/openclaw/openclaw/dev-conventions.md) -- LOC 上限検査スクリプトと CI 品質ゲートの設計
- [repos/openclaw/openclaw/ai-settings.md](../repos/openclaw/openclaw/ai-settings.md) -- AI エージェント向けルール設計と AGENTS.md の構成
- [repos/openclaw/openclaw/rules.md](../repos/openclaw/openclaw/rules.md) -- LOC 管理を含む導出ルール集
