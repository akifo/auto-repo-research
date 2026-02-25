# dev-conventions

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

vercel/chat は Ultracite（Biome ベースの zero-config preset）、Knip（未使用コード検出）、Turborepo（ビルドオーケストレーション）、Changesets（リリース管理）を組み合わせた開発パイプラインを構築している。特筆すべきは、Ultracite の厳格なデフォルトに対して**意図的な例外を最小限に宣言する**アプローチと、`pnpm validate` による**単一コマンドでの全品質ゲート実行**の設計である。CLAUDE.md に Ultracite Code Standards を直接埋め込み、AI エージェントにもコーディング規約を enforce する手法も注目に値する。

## 背景にある原則

- **Zero-config をベースラインとし、例外を明示的に宣言する**: Ultracite が提供する厳格なデフォルト（core + react + next の3プリセット）をそのまま採用し、プロジェクト固有の理由がある場合のみ `biome.jsonc` で個別ルールを off にしている。6 ルールの無効化にはそれぞれ正当な理由がある（例: `noBarrelFile: off` は `index.ts` によるパッケージ公開 API 制御のため）。根拠: `biome.jsonc:3-6`（extends）と `biome.jsonc:9-24`（例外）
- **品質ゲートを単一コマンドに集約する**: `pnpm validate` が `knip -> check -> typecheck -> test -> build` を逐次実行し、全ゲートを通過しなければ「タスク完了」と宣言できない。CONTRIBUTING.md と CLAUDE.md の両方に "Always run `pnpm validate` before declaring a task done" と明記されている。根拠: `package.json:22`
- **AI エージェントにも規約を enforce する**: CLAUDE.md に Ultracite Code Standards 全文を埋め込み、Claude Code が生成するコードにも同じ規約を適用する。人間用の CONTRIBUTING.md と AI 用の CLAUDE.md が同じルールソースを参照している。根拠: `CLAUDE.md:216-338`
- **モノレポ全体で一貫した設定を共有する**: `tsconfig.base.json`、ルートの `biome.jsonc`、ルートの `knip.json` がすべてのパッケージに適用される。個別パッケージは extends でベースを継承し、差分のみを宣言する。根拠: `tsconfig.base.json`、`packages/chat/tsconfig.json:2`

## 実例と分析

### Ultracite + Biome による lint/format 統合

Ultracite は Biome をエンジンとした zero-config preset である。ESLint + Prettier の代替として、単一ツールで lint とフォーマットの両方を提供する。

vercel/chat では3つのプリセットを extends している:

```jsonc
// biome.jsonc:3-6
"extends": [
  "ultracite/biome/core",
  "ultracite/biome/react",
  "ultracite/biome/next"
]
```

ルートの `package.json` でラッパーコマンドを定義:

```json
// package.json:24-25
"check": "ultracite check",
"fix": "ultracite fix"
```

`ultracite check` / `ultracite fix` は内部で `biome check` / `biome check --fix` を実行する。

### 意図的なルール例外

6 つのルールを明示的に off にしている。これらは「ルールを知った上で、プロジェクトの事情で無効化した」ことを示す:

```jsonc
// biome.jsonc:9-24
"linter": {
  "rules": {
    "suspicious": {
      "noEmptyBlockStatements": "off",  // catch ブロックの意図的な空処理
      "useAwait": "off",               // async 関数で await なしの interface 準拠
      "noSkippedTests": "off"          // WIP テストの一時的なスキップ許容
    },
    "complexity": {
      "noExcessiveCognitiveComplexity": "off"  // アダプター実装の複雑な変換ロジック
    },
    "performance": {
      "noBarrelFile": "off"            // index.ts によるパッケージ公開 API 制御
    },
    "style": {
      "useNumericSeparators": "off"    // 混在する定数フォーマット (30_000 vs 5 * 60 * 1000)
    }
  }
}
```

### docs ディレクトリの除外戦略

Biome と Knip の両方で `apps/docs` を除外している。ドキュメントサイトは品質ゲートの対象外とし、メインのコードベースにのみルールを適用する:

```jsonc
// biome.jsonc:26-28
"files": {
  "includes": ["**/*", "!apps/docs"]
}
```

```json
// knip.json:3
"ignore": ["apps/docs/**/*"]
```

### Knip による未使用コード検出

Knip は未使用の依存関係・エクスポート・ファイルを検出する。CI パイプラインでも実行される:

```json
// knip.json
{
  "ignoreDependencies": ["@biomejs/biome"],
  "ignore": ["apps/docs/**/*"],
  "rules": {
    "duplicates": "off"
  }
}
```

`@biomejs/biome` は Ultracite が内部で使用するため、Knip の未使用検出から除外している。`duplicates: off` はモノレポで同一パッケージが複数のワークスペースに依存する構成を許容するため。

### validate パイプラインの設計

`pnpm validate` は5段階のゲートを逐次実行する:

```json
// package.json:22
"validate": "pnpm knip && pnpm check && turbo typecheck && turbo test && pnpm build:validate"
```

実行順序と設計意図:

1. **`pnpm knip`** -- 未使用コード検出（最も軽量、最速で失敗）
2. **`pnpm check`** -- Biome による lint/format チェック
3. **`turbo typecheck`** -- TypeScript 型チェック（Turborepo 経由で並列）
4. **`turbo test`** -- テスト実行（ビルド依存のため Turborepo が依存解決）
5. **`pnpm build:validate`** -- モック環境変数でのフルビルド

`build:validate` はシークレットを必要とするパッケージのためにモック値を注入する:

```json
// package.json:16
"build:validate": "SLACK_BOT_TOKEN=xoxb-mock SLACK_SIGNING_SECRET=mock ... turbo build"
```

### CI パイプラインの分離設計

CI は3つの独立ジョブに分離され、並列実行される:

```yaml
# .github/workflows/ci.yml
jobs:
  lint:        # pnpm check + pnpm knip
  typecheck:   # pnpm typecheck
  build-and-test:  # pnpm build + pnpm test
```

`lint` と `typecheck` はビルド不要のため高速に完了する。`build-and-test` は `turbo.json` で `test` が `build` に依存する設定を利用:

```json
// turbo.json:17-19
"test": {
  "dependsOn": ["build"],
  "outputs": []
}
```

### リリースフローの自動化

Changesets の `fixed` 設定でコアパッケージとアダプターのバージョンを同期させている:

```json
// .changeset/config.json:5
"fixed": [["chat", "@chat-adapter/*"]]
```

リリースワークフローは CI 成功後にのみトリガーされる:

```yaml
# .github/workflows/release.yml:3-5
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
```

### TypeScript 設定の一貫性

`tsconfig.base.json` でモノレポ全体の TypeScript 設定を統一:

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true
  }
}
```

`verbatimModuleSyntax: true` により、型のみのインポートには `import type` の使用が強制される。コードベース全体で 62 ファイル、81 箇所に `import type` が使用されている。

### EditorConfig と Biome の整合

`.editorconfig` のコメントに "Matches Biome formatter settings" と明記し、エディタレベルのフォーマットと Biome のフォーマットが一致するよう設計:

```ini
# .editorconfig:1-2
# EditorConfig - https://editorconfig.org
# Matches Biome formatter settings
```

## コード例

```jsonc
// biome.jsonc:1-29
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "extends": [
    "ultracite/biome/core",
    "ultracite/biome/react",
    "ultracite/biome/next",
  ],
  "linter": {
    "rules": {
      "suspicious": {
        "noEmptyBlockStatements": "off",
        "useAwait": "off",
        "noSkippedTests": "off",
      },
      "complexity": {
        "noExcessiveCognitiveComplexity": "off",
      },
      "performance": {
        "noBarrelFile": "off",
      },
      "style": {
        "useNumericSeparators": "off",
      },
    },
  },
  "files": {
    "includes": ["**/*", "!apps/docs"],
  },
}
```

```json
// package.json:14-26 (scripts)
{
  "build": "turbo build",
  "build:validate": "SLACK_BOT_TOKEN=xoxb-mock ... turbo build",
  "dev": "turbo dev",
  "test": "turbo test --filter='!example-nextjs-chat'",
  "typecheck": "turbo typecheck",
  "knip": "knip",
  "validate": "pnpm knip && pnpm check && turbo typecheck && turbo test && pnpm build:validate",
  "check": "ultracite check",
  "fix": "ultracite fix"
}
```

```typescript
// packages/chat/src/chat.ts:47-52
const DEFAULT_LOCK_TTL_MS = 30_000; // 30 seconds
const SLACK_USER_ID_REGEX = /^U[A-Z0-9]+$/i;
const DISCORD_SNOWFLAKE_REGEX = /^\d{17,19}$/;
/** TTL for message deduplication entries */
const DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MODAL_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
```

```typescript
// packages/chat/src/errors.ts:1-42 (構造化エラークラス階層)
export class ChatError extends Error {
  readonly code: string;
  override readonly cause?: unknown;
  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.name = "ChatError";
    this.code = code;
    this.cause = cause;
  }
}

export class RateLimitError extends ChatError {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number, cause?: unknown) {
    super(message, "RATE_LIMITED", cause);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}
```

## パターンカタログ

- **Layered Defaults パターン** (分類: 構成)
  - 解決する問題: プロジェクト固有の設定を一から書くコストと、チーム間での設定の不一致
  - 適用条件: 外部プリセット（Ultracite, eslint-config-*, etc.）が利用可能な場合
  - コード例: `biome.jsonc:3-6`（extends）+ `biome.jsonc:9-24`（例外の宣言的オーバーライド）
  - 注意点: 例外を増やしすぎるとプリセットの意味がなくなる。例外には必ず理由を記録する

- **Single Gate Command パターン** (分類: プロセス)
  - 解決する問題: 複数の品質チェックを個別に実行し忘れる問題
  - 適用条件: lint, typecheck, test, build の複数ゲートがあるプロジェクト
  - コード例: `package.json:22`（`pnpm validate`）
  - 注意点: 実行順序はフィードバック速度を考慮する（軽量なチェックを先に）

- **Mirror Documentation パターン** (分類: プロセス)
  - 解決する問題: AI エージェントが人間と異なるコーディング規約でコードを生成する問題
  - 適用条件: Claude Code / Codex / Cursor 等の AI エージェントをワークフローに組み込んでいる場合
  - コード例: `CLAUDE.md:216-338`（Ultracite Code Standards セクション）
  - 注意点: 人間用ドキュメントと AI 用ドキュメントの同期コストが発生する

## Good Patterns

- **`import type` の強制による型と値の分離**: `verbatimModuleSyntax: true` を `tsconfig.base.json` に設定することで、型のみのインポートには `import type` の使用が TypeScript コンパイラレベルで強制される。これにより、バンドルサイズの最適化と import の意図の明示が同時に達成される。

```typescript
// packages/chat/src/chat.ts:11-44
import type {
  ActionEvent,
  ActionHandler,
  Adapter,
  // ... 30+ の型インポート
} from "./types";
import { ChatError, ConsoleLogger, LockError } from "./types"; // 値のインポートは別文
```

- **テスト用モックアダプターの共有**: `packages/chat/src/mock-adapter.ts` にテスト用のモックファクトリを集約し、全パッケージから再利用可能にしている。インターフェースに準拠したモックを一箇所で管理することで、API 変更時の更新箇所を最小化。

```typescript
// packages/chat/src/mock-adapter.ts:30-95
export function createMockAdapter(name = "slack"): Adapter {
  return {
    name,
    userName: `${name}-bot`,
    initialize: vi.fn().mockResolvedValue(undefined),
    handleWebhook: vi.fn().mockResolvedValue(new Response("ok")),
    // ... 全メソッドにデフォルトモック
  };
}
```

- **`@ts-expect-error` の適切な使用**: テストファイルでのみ `@ts-expect-error` を使用し、必ず理由コメントを付与している。`@ts-ignore` はコードベース内に1件も存在しない。

```typescript
// packages/adapter-shared/src/adapter-utils.test.ts:91
// @ts-expect-error testing invalid input
extractCard(42);
```

- **CI ジョブの並列分離**: lint, typecheck, build-and-test を独立ジョブとして分離し、失敗時のフィードバックを高速化。concurrency 設定で同一ブランチの重複実行をキャンセル。

```yaml
# .github/workflows/ci.yml:9-11
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

## Anti-Patterns / 注意点

- **ESLint コメントが残存している**: Biome に移行済みだが、`logger.ts` に `// eslint-disable-next-line no-console` が4箇所残っている。Biome は ESLint コメントを解釈しないため、これらは機能しないデッドコメントである。

```typescript
// packages/chat/src/logger.ts:38 (Bad - 機能しないコメント)
// eslint-disable-next-line no-console
console.debug(`[${this.prefix}] ${message}`, ...args);
```

```typescript
// Better - Biome の suppress コメント、または Logger 実装なので console は正当と文書化
// biome-ignore lint/suspicious/noConsole: Logger implementation
console.debug(`[${this.prefix}] ${message}`, ...args);
```

- **数値定数のフォーマット不統一**: `useNumericSeparators: off` にしたことで、コードベース内に `30_000`（セパレータあり）と `5 * 60 * 1000`（算術式）が混在している。どちらのスタイルも正当だが、一貫性がないと可読性が下がる。

```typescript
// packages/chat/src/chat.ts:47,51 (Bad - 同一ファイル内でスタイル混在)
const DEFAULT_LOCK_TTL_MS = 30_000; // 30 seconds
const DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 minutes
```

```typescript
// Better - いずれかに統一
const DEFAULT_LOCK_TTL_MS = 30 * 1000; // 30 seconds
const DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// または
const DEFAULT_LOCK_TTL_MS = 30_000; // 30 seconds
const DEDUPE_TTL_MS = 300_000; // 5 minutes
```

- **pre-commit hook 未設定**: `pnpm validate` が唯一の品質ゲートだが、pre-commit hook（husky, lefthook 等）が設定されていない。開発者が validate を実行し忘れると、CI でのみ失敗が検出される。CI でカバーされるため致命的ではないが、フィードバックループが長くなる。

## 導出ルール

- `[MUST]` lint/format ツールの設定は外部プリセットを extends し、例外は理由付きで最小限に宣言する
  - 根拠: vercel/chat は Ultracite の3プリセットを継承し、6ルールのみを off にしている。例外を宣言的に管理することで、ベースラインの厳格さを維持しつつプロジェクト固有の事情に対応できる
- `[MUST]` 全品質ゲート（lint, typecheck, test, build）を単一コマンドで実行できるようにする
  - 根拠: `pnpm validate` が knip, check, typecheck, test, build を逐次実行し、タスク完了の判定基準を一元化している。CONTRIBUTING.md と CLAUDE.md の両方に記載することで人間と AI の両方に enforce される
- `[MUST]` `verbatimModuleSyntax: true` を有効にし、型のみのインポートに `import type` を強制する
  - 根拠: コードベース全体で 62 ファイル 81 箇所に `import type` が使用され、型と値のインポートが明確に分離されている。バンドル最適化と意図の明示の両方に貢献する
- `[SHOULD]` AI エージェント用の CLAUDE.md にコーディング規約全文を埋め込み、人間と同じルールを適用する
  - 根拠: vercel/chat は CLAUDE.md に Ultracite Code Standards を全文掲載し、Type Safety, Modern JS, React, Error Handling 等のカテゴリ別ガイドラインを AI に提供している
- `[SHOULD]` CI パイプラインは lint/typecheck と build/test を独立ジョブに分離し、並列実行する
  - 根拠: vercel/chat の CI は lint, typecheck, build-and-test の3ジョブに分離されており、ビルド不要なチェックが高速にフィードバックを返す。concurrency 設定で重複実行もキャンセルされる
- `[SHOULD]` Knip を CI に組み込み、未使用の依存関係・エクスポート・ファイルを検出する
  - 根拠: `pnpm validate` の最初のステップとして Knip が実行され、不要なコードの蓄積を防いでいる。`ignoreDependencies` で間接依存を明示的に除外することで偽陽性を制御している
- `[SHOULD]` Changesets の `fixed` 設定でコアパッケージとアダプターのバージョンを同期する
  - 根拠: `"fixed": [["chat", "@chat-adapter/*"]]` により、いずれかのパッケージに変更があればすべてが同じバージョンに引き上げられ、互換性の問題を回避している
- `[AVOID]` lint ツール移行後に旧ツールの suppress コメント（`// eslint-disable-*` 等）を残す
  - 根拠: `logger.ts` に ESLint の disable コメントが残存しているが、Biome はこれを解釈しないためデッドコメントになっている。ツール移行時はコメントも移行する
- `[AVOID]` pre-commit hook なしで `pnpm validate` のみに依存する品質ゲート
  - 根拠: vercel/chat は pre-commit hook を設定しておらず、CI のみでゲートしている。小規模チームでは問題ないが、チーム拡大時にはローカルフィードバックの遅延が問題になりうる

## 適用チェックリスト

- [ ] Biome / ESLint の設定にプリセットを extends し、例外ルールには理由コメントを付与しているか
- [ ] `npm run validate` / `pnpm validate` 等の単一コマンドで全品質ゲートを実行できるか
- [ ] validate コマンドの実行順序は軽量なチェック（lint, knip）から重いチェック（build）の順になっているか
- [ ] `tsconfig.json` に `verbatimModuleSyntax: true` が設定され、`import type` が強制されているか
- [ ] CLAUDE.md にコーディング規約が記載され、AI エージェントにも規約が適用されるか
- [ ] CI ジョブがビルド依存の有無で分離され、並列実行されているか
- [ ] Knip / depcheck 等の未使用コード検出ツールが CI に組み込まれているか
- [ ] lint ツール移行後に旧ツールの suppress コメントが残存していないか
- [ ] Changesets / semantic-release 等でモノレポのバージョン同期戦略が定義されているか
- [ ] `.editorconfig` がフォーマッターの設定と整合しているか
