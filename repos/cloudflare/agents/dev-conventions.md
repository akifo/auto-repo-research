# dev-conventions

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

cloudflare/agents は Cloudflare Workers 上で動作する AI エージェント SDK のモノレポであり、TypeScript の厳密な型安全性、Rust 製ツールチェーン（oxlint / oxfmt / sherif）による高速な品質ゲート、そして `wrangler.jsonc` による宣言的インフラ構成を開発規約の柱として据えている。注目に値するのは、規約の文書化が `AGENTS.md` というディレクトリ単位の階層型ドキュメントで徹底されている点と、Lint/Format/Typecheck のすべてが単一の `npm run check` コマンドに集約されている点である。

## 背景にある原則

- **ランタイム制約から逆算して規約を設計する**: Workers ランタイムは Node.js ネイティブモジュールや FFI を使えない。この制約を規約レベルで明文化し（`AGENTS.md` の "Never" セクション）、依存追加時の判断コストを下げている。ランタイム制約がある環境では「何を使えるか」より「何を使えないか」をドキュメント化する方が規約違反を防げる。

- **型の境界を erasure に任せず明示する**: `verbatimModuleSyntax: true` により、`import type` を書かなければコンパイルエラーになる。型と値の境界をコード上で視覚的に区別させることで、バンドル時に不要なモジュールが含まれる事故を構造的に防いでいる。

- **静的解析は速度が正義**: ESLint ではなく oxlint、Prettier ではなく oxfmt を採用している。Rust 製ツールにより数十倍の速度を得て、pre-commit フック（husky + lint-staged）でのフォーマット自動修正をストレスなく実現している。開発者がフォーマッタを手動で実行する必要がないほど高速であることが、規約遵守率を高める。

- **モノレポの一貫性は専用ツールで強制する**: sherif によるモノレポバリデーション、`check-exports.ts` によるパッケージエクスポート整合性チェック、全 `tsconfig.json` を横断する並列 typecheck スクリプトなど、一貫性の検証を自動化している。人間のレビューだけでは見落としやすいモノレポ固有の不整合を機械的に検出する設計。

## 実例と分析

### verbatimModuleSyntax による型インポートの強制

`tsconfig.base.json` で `verbatimModuleSyntax: true` が設定されており、全プロジェクトがこの基底設定を `extends` で継承する。型のみのインポートに `import type` を書かなければコンパイルエラーになるため、コードレビューで指摘する必要がない。

```typescript
// packages/agents/src/index.ts:1-10
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import type {
  // ... type-only imports
} from "@modelcontextprotocol/sdk/types.js";
```

```typescript
// packages/agents/src/react.tsx:1-5
import type { PartySocket } from "partysocket";
import type { Agent, MCPServersState, RPCRequest, RPCResponse } from "./";
import type { StreamOptions } from "./client";
```

値のインポートと型のインポートが明確に分離されており、コードを読むだけでバンドルに含まれる依存が判断できる。

### wrangler.jsonc による宣言的構成

`.toml` ではなく `.jsonc` を採用することで、JSON Schema による IDE バリデーションとコメント記述を両立している。全 wrangler 設定ファイルで以下のパターンが統一されている。

```jsonc
// examples/mcp/wrangler.jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "mcp-agent-demo",
  "compatibility_date": "2026-01-28",
  "compatibility_flags": ["nodejs_compat"],
  "main": "src/server.ts",
  // ...
}
```

`$schema` フィールドにより、IDE が自動的に設定キーの補完とバリデーションを提供する。`compatibility_date` と `compatibility_flags` はリポジトリ全体で統一値を使用する規約となっている（`AGENTS.md` で明文化）。

なお、`guides/human-in-the-loop/wrangler.toml` と `guides/anthropic-patterns/wrangler.json` は `.jsonc` 規約に移行前の残存であり、`guides/AGENTS.md` の "Known issues" で追跡されている。

### sherif によるモノレポバリデーション

`npm run check` の最初のステップとして `sherif` が実行される。

```json
// package.json:23
"check": "sherif && npm run check:exports && oxfmt --check . && oxlint examples/ packages/ guides/ openai-sdk/ site/ && npm run typecheck"
```

sherif はモノレポのワークスペース間で依存バージョンの不整合、不正な `package.json` フィールド、ワークスペース参照の問題を検出する。CI の最初のステップに配置することで、他のチェックが無駄に走る前に構造的問題を弾く。

### oxlint による `any` 禁止と未使用変数制御

```json
// .oxlintrc.json
{
  "rules": {
    "no-explicit-any": "error",
    "no-unused-vars": [
      "error",
      {
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_"
      }
    ]
  },
  "ignorePatterns": ["**/env.d.ts"]
}
```

`any` は完全にエラーとし、未使用変数は `_` プレフィックスで意図的に無視する。`env.d.ts` は `wrangler types` による自動生成ファイルのため、lint 対象から除外されている。

実際のコードでの `_` プレフィックスの使用例:

```typescript
// packages/agents/src/index.ts:166
constructor(query: string, cause: unknown) {
```

```typescript
// packages/agents/src/index.ts:1407
const { [CF_READONLY_KEY]: _, ...rest } = raw;
```

```typescript
// packages/agents/src/index.ts:1436-1437
_connection: Connection,
_ctx: ConnectionContext
```

### 自動フォーマットの lint-staged 統合

```json
// package.json:92-96
"lint-staged": {
  "*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vue,astro,svelte,css}": [
    "oxfmt --write"
  ]
}
```

husky の pre-commit フック（`.husky/pre-commit`）が `npx lint-staged` を呼び出し、ステージされたファイルに対してのみ oxfmt を実行する。フォーマットの議論をゼロにし、コミット時に自動修正する。

### check-exports による公開 API 整合性の検証

`scripts/check-exports.ts` は `packages/*/package.json` の `exports` フィールドに記載されたすべてのファイルパスが実際に `dist/` に存在するかを検証する。ビルドとエクスポート宣言の乖離を CI で自動検出する。

```typescript
// scripts/check-exports.ts:49-53
const filePaths = extractFilePaths(packageJson.exports);
for (const filePath of filePaths) {
  if (!filePath.startsWith(".")) continue;
  const fullPath = resolve(packageDir, filePath);
  if (!existsSync(fullPath)) missing.push(filePath);
}
```

### 並列 typecheck スクリプト

`scripts/typecheck.ts` は全 `tsconfig.json` を自動探索し、CPU コア数に応じた並列度で `tsc -p` を実行する。モノレポ内の 40 以上のプロジェクトを効率的にチェックする。

```typescript
// scripts/typecheck.ts:15-18
const concurrency = Math.max(os.cpus().length, 2);
console.log(
  `Typechecking ${tsconfigs.length} projects (${concurrency} concurrent)...`,
);
```

### 階層型 AGENTS.md ドキュメント

規約を単一の巨大ドキュメントに書くのではなく、ディレクトリごとに `AGENTS.md` を配置する階層構造を採用している。

| ファイル                     | スコープ                                                |
| ---------------------------- | ------------------------------------------------------- |
| `/AGENTS.md`                 | リポジトリ全体のセットアップ、コマンド、コード標準      |
| `/packages/agents/AGENTS.md` | コア SDK のエクスポート、ビルド、テスト、アーキテクチャ |
| `/examples/AGENTS.md`        | Example の必須構造、Kumo UI、wrangler 規約              |
| `/guides/AGENTS.md`          | Guide と Example の違い、README の期待値                |
| `/docs/AGENTS.md`            | Diataxis フレームワーク、ドキュメント執筆スタイル       |
| `/design/AGENTS.md`          | 設計記録と RFC のフォーマット                           |

ルートの `AGENTS.md` がネスト先への参照テーブルを持ち、ナビゲーションを容易にしている。

### 生成ファイルの明示的管理

`env.d.ts` は `wrangler types` コマンドで自動生成されるファイルであり、手動編集禁止の規約がある。

```
// examples/playground/env.d.ts:2
// Generated by Wrangler by running `wrangler types env.d.ts --include-runtime false`
```

oxlint の `ignorePatterns` で `**/env.d.ts` を除外し、生成ファイルに lint ルールを適用しない。再生成は各プロジェクトの `npm run types` スクリプトで行う:

```json
"types": "wrangler types env.d.ts --include-runtime false"
```

## Good Patterns

- **単一コマンドの品質ゲート**: `npm run check` が `sherif && check:exports && oxfmt --check && oxlint && typecheck` を順序実行する。CI と開発者のローカル環境で同じコマンドを使い、「CI では通ったのにローカルでは通らない」問題を排除する。失敗が早い順（sherif > format > lint > typecheck）に並べ、フィードバックを高速化している。

- **tsconfig の基底設定パターン**: `tsconfig.base.json` にすべての共通設定を集約し、各プロジェクトは `"extends": "../../tsconfig.base.json"` のみで継承する。プロジェクト固有の上書きは最小限（`target` や `exclude` のみ）に留める。

```json
// examples/playground/tsconfig.json
{
  "compilerOptions": { "target": "ES2021" },
  "extends": "../../tsconfig.base.json"
}
```

- **Secret 管理の二重基準明文化**: ルートの `AGENTS.md` では `wrangler secret put` または `.dev.vars` を推奨しつつ、`examples/AGENTS.md` では `.env` / `.env.example` を推奨する。本番デプロイ向けとローカル開発向けで異なる秘密管理手段を文書で区別している。

## Anti-Patterns / 注意点

- **wrangler 設定形式の不統一（移行期の技術的負債）**: `.jsonc` 規約を定めているにもかかわらず、`guides/human-in-the-loop/wrangler.toml` と `guides/anthropic-patterns/wrangler.json` が残存している。規約を定めるだけでなく、既存コードの移行を追跡（`guides/AGENTS.md` の "Known issues"）している点は良いが、移行未完了は混乱の元になる。

```
# Bad: 旧形式が混在
guides/human-in-the-loop/wrangler.toml   # TOML 形式
guides/anthropic-patterns/wrangler.json   # JSON（コメント不可）

# Better: 全プロジェクトで .jsonc + $schema を統一
guides/human-in-the-loop/wrangler.jsonc
guides/anthropic-patterns/wrangler.jsonc
```

- **依存更新スクリプトのハードコード除外リスト**: `scripts/check-updates.ts` で特定パッケージを `--reject` で除外している。除外理由がコード内にコメントされておらず、なぜ vitest や `@modelcontextprotocol/sdk` が固定なのか新規参加者には不明。

```typescript
// Bad: 除外理由が不明
execSync(`npx npm-check-updates ${update} \
  --reject vitest \
  --reject @modelcontextprotocol/sdk \
  --workspaces`);

// Better: 除外理由をコメントで記載
execSync(`npx npm-check-updates ${update} \
  --reject vitest \           // vitest 4.x は vitest-pool-workers 未対応
  --reject @modelcontextprotocol/sdk \  // 1.26.0 固定（破壊的変更あり）
  --workspaces`);
```

## 導出ルール

- `[MUST]` モノレポでは `verbatimModuleSyntax: true` を基底 tsconfig に設定し、型インポートと値インポートの区別を強制する
  - 根拠: cloudflare/agents では全 40+ プロジェクトが `tsconfig.base.json` 経由でこの設定を継承し、バンドル時の不要モジュール混入を防止している（`tsconfig.base.json:85`）

- `[MUST]` CI の品質チェックは単一のエントリポイントコマンドに集約し、失敗コストの低い順に実行する
  - 根拠: `npm run check` が sherif（構造）→ format（構文）→ lint（意味）→ typecheck（型）の順で実行し、最も高速なチェックで早期失敗する（`package.json:23`）

- `[MUST]` 自動生成ファイルは lint/format の対象から除外し、再生成コマンドを `package.json` の scripts に定義する
  - 根拠: `env.d.ts` が oxlint の `ignorePatterns` で除外され、各プロジェクトの `"types"` スクリプトで再生成可能になっている（`.oxlintrc.json:21`）

- `[SHOULD]` モノレポの規約ドキュメントはディレクトリ単位の階層構造で管理し、ルートにインデックスを置く
  - 根拠: 6 つの `AGENTS.md` がスコープ別に配置され、ルートのテーブルが全体のナビゲーションを提供している（`AGENTS.md:42-50`）

- `[SHOULD]` 未使用の関数引数にはアンダースコアプレフィックスを付け、lint ルールで明示的に許可する
  - 根拠: `argsIgnorePattern: "^_"` と `varsIgnorePattern: "^_"` により、インターフェース実装で不要な引数を持つ場合も lint エラーにならない（`.oxlintrc.json:14-15`）

- `[SHOULD]` インフラ設定ファイルには JSON Schema の `$schema` フィールドを設定し、IDE のバリデーションと補完を有効化する
  - 根拠: 全 `wrangler.jsonc` に `"$schema": "../../node_modules/wrangler/config-schema.json"` が設定され、設定ミスが編集時に検出される

- `[SHOULD]` pre-commit フックではフォーマットの自動修正のみを行い、lint やテストはフックに含めない
  - 根拠: lint-staged は oxfmt のみを実行し（`package.json:93-96`）、重い処理は CI に委譲することで開発者のコミット体験を損なわない

- `[AVOID]` モノレポで依存バージョンを除外リストで固定する際に、除外理由をコード内に記載しないこと
  - 根拠: `scripts/check-updates.ts` の `--reject` リストには理由コメントがなく、固定理由の判断にはパッケージのリリースノートを別途確認する必要がある

- `[AVOID]` 設定ファイル形式の規約を定めた後に、既存ファイルの移行を追跡せず放置すること
  - 根拠: `wrangler.jsonc` 規約があるにもかかわらず `.toml` と `.json` が残存しており、`guides/AGENTS.md` の "Known issues" で追跡はしているものの未解決

## 適用チェックリスト

- [ ] `tsconfig.base.json`（または共通 tsconfig）に `verbatimModuleSyntax: true` を追加し、全プロジェクトが `extends` で継承しているか確認する
- [ ] CI の品質チェックを単一コマンド（例: `npm run check`）に集約し、コスト順に並べる（format → lint → typecheck）
- [ ] `any` を lint エラーにし、未使用変数は `_` プレフィックスで許可するルールを設定する
- [ ] 自動生成ファイル（`env.d.ts` 等）を lint/format の `ignorePatterns` に追加する
- [ ] モノレポの場合、sherif 等のワークスペース整合性チェックツールを CI に組み込む
- [ ] 設定ファイルに `$schema` フィールドを追加し、IDE バリデーションを有効化する
- [ ] pre-commit フックは format のみとし、lint/test は CI に委譲する
- [ ] 規約ドキュメントをディレクトリ単位で配置し、ルートにインデックス（参照テーブル）を作成する
- [ ] 依存固定の `--reject` リストに除外理由をコメントで記載する
