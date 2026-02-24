# dev-conventions

> リポジトリ: modelcontextprotocol/typescript-sdk
> 分析日: 2026-02-24

## 概要

MCP TypeScript SDK のコーディング規約、JSDoc スニペット同期、CI/CD ワークフロー、changesets によるリリース管理、そしてデュアルブランチ運用を分析した。モノレポにおける「共有設定の一元管理」「ドキュメントとコードの同期保証」「メジャーバージョン並行運用」の 3 つの課題に対して、ツールチェーンと CI パイプラインで体系的に解決している点が注目に値する。

## 背景にある原則

- **Single Source of Truth for Config（設定の単一起点）**: ESLint 設定は `common/eslint-config/` に共有パッケージとして切り出され、各パッケージの `eslint.config.mjs` は `...baseConfig` でスプレッドするだけ。TypeScript 設定も `common/tsconfig/tsconfig.json` に集約し `extends` で継承。Vitest 設定も同様。pnpm の `catalogs` 機能で依存バージョンすら一元管理している。設定の重複を排除し、変更時の漏れを構造的に防ぐ意図がある。

- **Executable Documentation（実行可能なドキュメント）**: JSDoc の `@example` コードは `.examples.ts` ファイルに実体を持ち、TypeScript コンパイラで型チェックされる。`pnpm sync:snippets` で JSDoc とマークダウンに同期し、CI の `lint:all` に `--check` モードが組み込まれている。「ドキュメントのコード例が実際にコンパイルを通る」ことを CI で保証する仕組み。

- **Release as Code（リリースプロセスのコード化）**: changesets でバージョニングとチェンジログを宣言的に管理し、`release.yml` が自動で Release PR を生成する。手動の `npm version` は v1.x パッチ限定。リリースプロセスの判断（どのパッケージをいくつ上げるか）を PR レビューに載せることで、透明性と安全性を確保している。

- **Guard Rails over Guidelines（ガイドラインよりガードレール）**: コーディング規約の多くを ESLint ルールとして強制している（`consistent-type-imports`, `prefer-node-protocol`, `unicorn/filename-case`, `no-console` for library code）。ドキュメントに書くだけでなく、CI で違反を検出する設計。

## 実例と分析

### 共有 ESLint 設定とパッケージ横断の統一

`common/eslint-config/eslint.config.mjs` が全パッケージの lint ルールを定義し、各パッケージは最小限のオーバーライドで利用する。

注目すべきルール設計:

- `unicorn/filename-case: camelCase` でファイル名を統一（例外なし）
- `consistent-type-imports: error` で `import type` を強制し、ランタイムへの不要な依存を排除
- `import/consistent-type-specifier-style: prefer-top-level` で型インポートスタイルを統一
- `simple-import-sort/imports: warn` でインポート順序を自動整列
- `n/prefer-node-protocol: error` で `node:` プレフィックスを強制
- `no-console: error`（packages/client, packages/server の本番コード限定）だが `.examples.ts` と test ファイルは例外
- `@typescript-eslint/no-unused-vars` で `_` プレフィックスの引数を許可

ファイル種別ごとのルール緩和が意図的に設計されている:

- `.examples.ts`: `no-unused-vars` OFF（リージョンごとに独立した関数のため）
- `.test.ts`: `consistent-function-scoping` OFF（テスト内ヘルパー関数のため）
- `spec.types.ts`: 完全に ignore（自動生成ファイル）

### JSDoc スニペット同期の仕組み

`.examples.ts` ファイルは「型チェック付きコード例の置き場」として機能する。JSDoc 内のコードフェンスに `source=` 属性を付け、`pnpm sync:snippets` がリージョンの内容をそこに同期する。

同期先は 2 種類:

1. **JSDoc コメント（TypeScript ソースファイル）**: ``* ```ts source="./mcp.examples.ts#McpServer_basicUsage"`` の形式
2. **マークダウンファイル（docs/）**: 通常のコードフェンスに `source=` を付加

リージョン名の命名規則は `ClassName_methodName_variant` パターン。例:

- `McpServer_basicUsage`
- `McpServer_registerTool_basic`
- `McpServer_connect_stdio`

CI では `pnpm sync:snippets --check` が `lint:all` の一部として実行され、同期漏れを検出する。

### Changesets によるリリース管理

`.changeset/config.json` で以下を設定:

- `baseBranch: "main"` で v2 を主系統とする
- `access: "public"` で npm パブリック公開
- `commit: false` で changeset 追加時に自動コミットしない
- `ignore` で examples パッケージをリリース対象から除外
- `updateInternalDependencies: "patch"` でワークスペース内部依存を自動更新

changeset ファイルの書き方は変更の「Why」を記述する形式:

```
---
'@modelcontextprotocol/node': patch
---

Prevent Hono from overriding global Response object by passing `overrideGlobalObjects: false` to `getRequestListener()`.
```

### CI/CD パイプライン設計

8 つのワークフローが役割分担されている:

| ワークフロー             | トリガー           | 役割                                                            |
| ------------------------ | ------------------ | --------------------------------------------------------------- |
| `main.yml`               | push/PR/release    | ビルド + テスト（Node 20/22/24 マトリクス）+ publish + gh-pages |
| `conformance.yml`        | push/PR            | プロトコル適合テスト（client/server 分離、continue-on-error）   |
| `release.yml`            | push to main       | changesets/action で Release PR 作成または npm publish          |
| `publish.yml`            | push/PR            | `pkg-pr-new` で PR ごとのプレビューパッケージ公開               |
| `release-v1x.yml`        | v1.* タグ push     | v1.x 系の npm publish（`release-X.Y` タグ）                     |
| `update-spec-types.yml`  | 毎日 4:00 UTC      | 上流の Protocol 仕様型定義を自動 PR                             |
| `claude.yml`             | @claude メンション | Claude Code による issue/PR 対応                                |
| `claude-code-review.yml` | PR open/sync       | Claude Code による自動コードレビュー                            |

特筆すべき設計:

- `concurrency` で同一ブランチの重複ワークフローをキャンセル
- Node.js バージョンマトリクスでの互換性保証（20/22/24）
- v1.x リリースでは `release-X.Y` npm タグを使用し `latest` を上書きしない
- `pkg-pr-new` で PR ごとにパッケージをプレビュー公開（CI 完了を待たずに試用可能）
- 適合テストは `continue-on-error: true` で非ブロッキング

### pnpm Workspace の catalogs によるバージョン一元管理

`pnpm-workspace.yaml` で `catalogs` を定義し、各パッケージの依存バージョンを `catalog:devTools` や `catalog:runtimeShared` で参照する。

```yaml
catalogs:
    devTools:
        typescript: ^5.9.3
        vitest: ^4.0.15
        eslint: ^9.39.2
    runtimeShared:
        zod: ^4.0
        ajv: ^8.17.1
```

これにより「全パッケージで TypeScript のバージョンが異なる」事故を防ぎ、バージョンアップ時の変更箇所を 1 ファイルに集約する。

`minimumReleaseAge: 10080`（7 日）は、公開直後のバグが発見されていないバージョンを自動採用しない安全策。特定パッケージは `minimumReleaseAgeExclude` で例外指定できる。

### デュアルブランチ運用（v1.x / main）

- `main`: v2 開発（モノレポ構成、pnpm）
- `v1.x`: v1 安定版（単一パッケージ、npm）
- v1.x パッチは `npm version patch` + タグ push で `release-v1x.yml` が自動発火
- 古いマイナーバージョン（v1.23.x）のパッチは `release/1.23` ブランチを作成して手動ワークフロー

## コード例

```typescript
// common/eslint-config/eslint.config.mjs:46-79
rules: {
    'unicorn/prevent-abbreviations': 'off',
    'unicorn/no-null': 'off',
    'unicorn/prefer-add-event-listener': 'off',
    'unicorn/no-useless-undefined': ['error', { checkArguments: false }],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'n/prefer-node-protocol': 'error',
    '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
    'simple-import-sort/imports': 'warn',
    'simple-import-sort/exports': 'warn',
    'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
    'unicorn/filename-case': [
        'error',
        {
            case: 'camelCase'
        }
    ]
}
```

````typescript
// packages/server/src/server/mcp.ts:53-64
/**
 * High-level MCP server that provides a simpler API for working with resources, tools, and prompts.
 *
 * @example
 * ```ts source="./mcp.examples.ts#McpServer_basicUsage"
 * const server = new McpServer({
 *     name: 'my-server',
 *     version: '1.0.0'
 * });
 * ```
 */
````

```typescript
// packages/server/src/server/mcp.examples.ts:19-27
function McpServer_basicUsage() {
  // #region McpServer_basicUsage
  const server = new McpServer({
    name: "my-server",
    version: "1.0.0",
  });
  // #endregion McpServer_basicUsage
  return server;
}
```

```typescript
// packages/client/eslint.config.mjs:1-12
// @ts-check

import baseConfig from "@modelcontextprotocol/eslint-config";

export default [
  ...baseConfig,
  {
    settings: {
      "import/internal-regex": "^@modelcontextprotocol/core",
    },
  },
];
```

```yaml
# .changeset/config.json:1-17
{
    "$schema": "https://unpkg.com/@changesets/config@3.1.2/schema.json",
    "changelog": ["@changesets/changelog-github", { "repo": "modelcontextprotocol/typescript-sdk" }],
    "commit": false,
    "fixed": [],
    "linked": [],
    "access": "public",
    "baseBranch": "main",
    "updateInternalDependencies": "patch",
    "ignore": [
        "@modelcontextprotocol/examples-client",
        "@modelcontextprotocol/examples-client-quickstart",
        "@modelcontextprotocol/examples-server",
        "@modelcontextprotocol/examples-server-quickstart",
        "@modelcontextprotocol/examples-shared"
    ]
}
```

## Good Patterns

- **Region-based JSDoc Snippet Sync**: `.examples.ts` ファイルに `//#region` でコード例を定義し、JSDoc の `source=` 属性で参照して自動同期する。コード例が型チェックを通ることが保証され、かつ CI で同期状態を検証できる。ドキュメント内のコード例が古くなる問題を構造的に解消している。

````typescript
// scripts/sync-snippets.ts:106-108
const JSDOC_LABELED_FENCE_PATTERN = /^(\s*\*\s*)```(\w+)(?:\s+(\S+))?\s+source="([^"#]+)(?:#([^"]+))?"/;
const JSDOC_CLOSING_FENCE_PATTERN = /^(\s*\*\s*)```\s*$/;
````

- **Catalog-based Version Pinning**: pnpm workspace の `catalogs` 機能で依存バージョンをカテゴリ別に一元管理。`devTools`, `runtimeShared`, `runtimeClientOnly`, `runtimeServerOnly` の 4 カテゴリに分類し、各パッケージは `catalog:devTools` で参照するだけ。バージョン更新が 1 ファイルで完結する。

```yaml
# pnpm-workspace.yaml:8-12
catalogs:
    devTools:
        typescript: ^5.9.3
        vitest: ^4.0.15
        eslint: ^9.39.2
```

- **File-type-aware ESLint Rule Relaxation**: `.examples.ts`, `.test.ts`, `spec.types.ts` それぞれに対して、目的に応じたルール緩和を行っている。一律に全ルールを適用するのではなく、ファイルの役割に合わせた例外設計。

```javascript
// common/eslint-config/eslint.config.mjs:88-100
{
    // Example files contain intentionally unused functions (one per region)
    files: ['**/*.examples.ts'],
    rules: {
        '@typescript-eslint/no-unused-vars': 'off',
        'no-console': 'off'
    }
},
{
    // Ignore generated protocol types everywhere
    ignores: ['**/spec.types.ts']
},
```

- **PR Preview Packages**: `pkg-pr-new` で PR ごとにプレビューパッケージを npm に公開。下流プロジェクトが PR の変更を CI 完了前に試用でき、フィードバックループが短縮される。

```yaml
# .github/workflows/publish.yml:41-43
- name: Publish preview packages
  run:
      pnpm dlx pkg-pr-new publish --packageManager=npm --pnpm './packages/server' './packages/client'
      './packages/middleware/express' './packages/middleware/hono' './packages/middleware/node'
```

## Anti-Patterns / 注意点

- **Prettier と ESLint の設定不整合リスク**: `eslint-config-prettier` を配列末尾に置いて Prettier と衝突するルールを無効化しているが、Prettier の `tabWidth: 4` と CLAUDE.md に記載の「2-space indentation」が矛盾している。CLAUDE.md の記述が不正確（実際は 4-space）。AI ツール向けの規約ドキュメントは自動生成するか、フォーマッタ設定と照合すべき。

```json
// .prettierrc.json（実際の設定: 4-space）
{
  "tabWidth": 4,
  "useTabs": false
}
```

```
// CLAUDE.md（記載: 2-space — 不正確）
- **Formatting**: 2-space indentation, semicolons required, single quotes preferred
```

- **適合テストの非ブロッキング実行**: `conformance.yml` で `continue-on-error: true` が設定されているため、プロトコル適合テストの失敗が PR マージを妨げない。成熟段階では非ブロッキングが適切だが、適合テストの形骸化リスクがある。失敗を検知する別のメカニズム（通知、ダッシュボード等）が必要。

```yaml
# .github/workflows/conformance.yml:20-21
    client-conformance:
        runs-on: ubuntu-latest
        continue-on-error: true
```

## 導出ルール

- `[MUST]` モノレポの共有設定（lint, tsconfig, test）はワークスペースパッケージとして切り出し、各パッケージは extends/spread で利用する
  - 根拠: `common/eslint-config/` を全 13 パッケージが共有し、パッケージごとの設定は 10 行未満に収まっている
- `[MUST]` ドキュメント内のコード例は実際にコンパイル可能なソースファイルから自動同期し、CI で同期状態を検証する
  - 根拠: `sync:snippets --check` が `lint:all` に含まれ、`.examples.ts` ファイルは TypeScript コンパイラの型チェック対象
- `[MUST]` changesets のリリース対象から examples/internal パッケージを `ignore` で除外する
  - 根拠: `.changeset/config.json` の `ignore` に 5 つの examples パッケージが列挙され、不要なバージョンバンプを防止
- `[SHOULD]` pnpm workspace の `catalogs` 機能で依存バージョンをカテゴリ別（devTools, runtime 等）に一元管理する
  - 根拠: `pnpm-workspace.yaml` で 4 カテゴリの catalogs を定義し、各パッケージは `catalog:` プロトコルで参照
- `[SHOULD]` ESLint ルールはファイル種別（ソース / テスト / 例示 / 自動生成）ごとに適用範囲を分け、purpose に合わせた例外を設計する
  - 根拠: `.examples.ts` では `no-unused-vars` OFF、`.test.ts` では `consistent-function-scoping` OFF など、ファイルの目的に沿った緩和
- `[SHOULD]` PR ごとにプレビューパッケージを公開し、下流プロジェクトからの早期フィードバックを可能にする
  - 根拠: `publish.yml` で `pkg-pr-new` を使い、全 PR でプレビューパッケージを自動公開
- `[SHOULD]` メジャーバージョン並行運用時は、旧バージョンの npm タグに `release-X.Y` を使い `latest` を上書きしない
  - 根拠: `release-v1x.yml` で `--tag release-${MAJOR_MINOR}` を付与し、v2 の `latest` タグと干渉しない設計
- `[SHOULD]` 上流仕様の型定義は nightly cron ジョブで自動更新 PR を生成し、手動同期の漏れを防ぐ
  - 根拠: `update-spec-types.yml` が毎日 4:00 UTC に実行され、差分がある場合のみ PR を作成
- `[AVOID]` AI ツール向けの規約ドキュメント（CLAUDE.md 等）にフォーマッタ設定と矛盾する情報を手書きで記述する
  - 根拠: CLAUDE.md に「2-space indentation」と記載されているが、`.prettierrc.json` の `tabWidth` は 4

## 適用チェックリスト

- [ ] モノレポの ESLint / TSConfig / Vitest 設定を共有パッケージに切り出し、各パッケージは extends で継承しているか
- [ ] JSDoc の `@example` コード例は型チェック可能なソースファイルから同期されているか（手書きコード例が腐敗していないか）
- [ ] CI パイプラインにドキュメント-コード同期の検証ステップが含まれているか
- [ ] changesets の `ignore` で examples / internal パッケージがリリース対象から除外されているか
- [ ] 依存バージョンが一元管理されているか（pnpm catalogs、Renovate の grouping 等）
- [ ] ESLint ルールがファイル種別ごとに適切に緩和されているか（テスト、例示、自動生成ファイル）
- [ ] メジャーバージョン並行運用時の npm タグ戦略が定義されているか
- [ ] PR プレビューパッケージの仕組みが導入されているか
- [ ] 上流仕様や依存の自動更新ワークフローが設定されているか
- [ ] AI ツール向けの規約ドキュメントとフォーマッタ / リンター設定が矛盾していないか
