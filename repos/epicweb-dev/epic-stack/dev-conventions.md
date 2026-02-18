# 開発規約とツールチェーン

> リポジトリ: epicweb-dev/epic-stack
> 分析日: 2026-02-18

## 概要

Epic Stack の開発規約は「共有設定パッケージによる一元管理」と「Node.js 標準仕様への準拠」を軸に設計されている。ESLint・Prettier・TypeScript の設定を `@epic-web/config` という単一パッケージに集約し、プロジェクト側のカスタマイズを最小限に抑えている。import エイリアスは TypeScript の `paths` ではなく `package.json` の `imports` フィールド（Node.js 標準仕様）を採用し、ツール間の設定同期問題を根本的に排除した。ファイル命名規約（`.server.ts`）はフレームワーク（React Router）によるバンドル境界の enforcement と組み合わされ、実行時エラーではなくビルド時に問題を検出する仕組みになっている。

## 背景にある原則

- **設定の DRY 原則**: 同じ設定を複数の設定ファイルに重複記述しない。`@epic-web/config` に ESLint・Prettier・TypeScript の設定を集約し、プロジェクト側は `extends` / `import` で参照するだけにする。これにより設定間の矛盾が発生しない（根拠: `eslint.config.js:1`, `tsconfig.json:3`, `package.json:162`）

- **標準仕様ファースト**: ツール固有の機能より、Node.js / ECMAScript 等の標準仕様を優先する。import エイリアスを TypeScript `paths` から `package.json` の `imports` フィールドに移行した判断がこれを象徴する（根拠: `docs/decisions/046-remove-path-aliases.md`, `docs/decisions/031-imports.md`）

- **バリデーションの並列実行**: CI パイプラインとローカル validate スクリプトの両方で lint・typecheck・test・e2e を並列実行し、フィードバックループを最短化する（根拠: `package.json:29` の `run-p` コマンド, `.github/workflows/deploy.yml` の並列ジョブ構成）

- **ファイル命名による境界の宣言**: サーバー専用コードは `.server.ts` サフィックスで明示し、フレームワークのバンドラーがクライアントバンドルへの混入を防止する。コードレビューや lint ルールではなく、ビルドツールが enforcement を担う（根拠: `app/utils/` 配下の 17 個の `.server.ts` ファイル）

## 実例と分析

### 共有設定パッケージ `@epic-web/config` による三位一体管理

`@epic-web/config` は ESLint・Prettier・TypeScript の設定を単一の npm パッケージとして提供する。プロジェクト側の設定ファイルは極めて薄い:

- **ESLint** (`eslint.config.js`): 共有設定をスプレッドし、テストファイルでの `react-hooks/rules-of-hooks: off` と `.react-router/` の ignore のみ追加
- **Prettier** (`package.json`): `"prettier": "@epic-web/config/prettier"` の1行
- **TypeScript** (`tsconfig.json`): `"extends": ["@epic-web/config/typescript"]` で継承し、プロジェクト固有の `types` と `rootDirs` のみ追加
- **型リセット** (`types/reset.d.ts`): `@total-typescript/ts-reset` を `@epic-web/config/reset.d.ts` 経由で適用

`@epic-web/config` は内部で以下のプラグインを統合している:
- `typescript-eslint`: TypeScript 固有のルール
- `eslint-plugin-import-x`: import の順序・解決
- `eslint-plugin-react` / `eslint-plugin-react-hooks`: React ルール
- `eslint-plugin-testing-library` / `eslint-plugin-jest-dom`: テストルール
- `eslint-plugin-playwright`: E2E テストルール
- `@vitest/eslint-plugin`: Vitest 固有のルール

### Node.js Subpath Imports による import エイリアス

`package.json` の `imports` フィールドで2つのエイリアスを定義:

```json
// package.json:8-11
"imports": {
  "#app/*": "./app/*",
  "#tests/*": "./tests/*"
}
```

この設計は3回の意思決定を経て到達している:
1. **026**: TypeScript `paths` によるエイリアス → ツール間の設定同期が煩雑
2. **031**: `package.json` `imports` + TypeScript `paths` の併用 → TypeScript が `imports` 未サポートだったため
3. **046**: TypeScript `paths` を廃止し `imports` のみに → TypeScript が `imports` をネイティブサポート

`#` プレフィックスは Node.js 仕様の要件であり、通常の npm パッケージと明確に区別できる。すべてのインポートでファイル拡張子（`.ts` / `.tsx`）が明示される:

```typescript
// app/routes/_auth/login.tsx:9-21
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { CheckboxField, ErrorList, Field } from '#app/components/forms.tsx'
import { login, requireAnonymous } from '#app/utils/auth.server.ts'
import { PasswordSchema, UsernameSchema } from '#app/utils/user-validation.ts'
```

import の使い分けルール:
- **`#app/*`**: アプリケーションコード間の参照（305 箇所、74 ファイル）
- **`#tests/*`**: テストユーティリティの参照（29 箇所、17 ファイル）
- **相対パス**: 同一ディレクトリまたは近接ディレクトリ内（`.server.ts` と対応する `.tsx` の参照等）
- **`@/icon-name`**: shadcn/ui 互換のための特殊エイリアス（`tsconfig.json` の `paths` で定義、1箇所のみ）

### ファイル命名規約とバンドル境界

`.server.ts` サフィックスは React Router（旧 Remix）のバンドラーが認識する規約で、クライアントバンドルからの自動除外を保証する:

```
app/utils/
├── auth.server.ts          # サーバー専用（セッション・認証）
├── cache.server.ts         # サーバー専用（キャッシュ）
├── db.server.ts            # サーバー専用（Prisma クライアント）
├── email.server.ts         # サーバー専用（メール送信）
├── env.server.ts           # サーバー専用（環境変数バリデーション）
├── misc.tsx                # 共有（クライアント・サーバー両方）
├── user-validation.ts      # 共有（Zod スキーマ）
└── user.ts                 # 共有（ユーティリティ）
```

26 個の `.server.ts` ファイルが存在し、`.client.ts` は 0 個。これはサーバーファーストアーキテクチャを反映している。共有コードはサフィックスなし（`.ts` / `.tsx`）で、デフォルトで両環境から参照可能。

### validate スクリプトの並列実行設計

```json
// package.json:29
"validate": "run-p \"test -- --run\" lint typecheck test:e2e:run"
```

`npm-run-all` の `run-p` で4つのタスクを並列実行:
1. `test -- --run`: Vitest のワンショット実行
2. `lint`: ESLint
3. `typecheck`: `react-router typegen && tsc`（型生成後に型チェック）
4. `test:e2e:run`: Playwright E2E テスト（`pretest:e2e:run` で事前にビルド）

CI ではこれがさらに分割され、4 つの独立ジョブ（lint, typecheck, vitest, playwright）として並列実行される。デプロイジョブはすべてのジョブ完了を `needs` で待機する。

### import 順序の一貫性

コードベース全体で以下の import 順序が一貫している:

1. 外部パッケージ（`@conform-to/react`, `react`, `zod` 等）
2. `#app/*` エイリアス（コンポーネント → ユーティリティの順）
3. 相対パス（`./+types/`, `./login.server.ts` 等）

この順序は `@epic-web/config` 内の `eslint-plugin-import-x` によって自動 enforcement される。

## コード例

```typescript
// eslint.config.js:1-14
import { default as defaultConfig } from '@epic-web/config/eslint'

/** @type {import("eslint").Linter.Config} */
export default [
	...defaultConfig,
	// add custom config objects here:
	{
		files: ['**/tests/**/*.ts'],
		rules: { 'react-hooks/rules-of-hooks': 'off' },
	},
	{
		ignores: ['.react-router/*'],
	},
]
```

```typescript
// app/utils/env.server.ts:1-48
import { z } from 'zod'

const schema = z.object({
	NODE_ENV: z.enum(['production', 'development', 'test'] as const),
	DATABASE_PATH: z.string(),
	DATABASE_URL: z.string(),
	SESSION_SECRET: z.string(),
	// ...
})

declare global {
	namespace NodeJS {
		interface ProcessEnv extends z.infer<typeof schema> {}
	}
}

export function init() {
	const parsed = schema.safeParse(process.env)
	if (parsed.success === false) {
		console.error(
			'❌ Invalid environment variables:',
			parsed.error.flatten().fieldErrors,
		)
		throw new Error('Invalid environment variables')
	}
}
```

```typescript
// tests/setup/setup-test-env.ts:1-37
import 'dotenv/config'
import './db-setup.ts'
import '#app/utils/env.server.ts'
// we need these to be imported first 👆

import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi, type MockInstance } from 'vitest'
import { server } from '#tests/mocks/index.ts'
import './custom-matchers.ts'

afterEach(() => server.resetHandlers())
afterEach(() => cleanup())

export let consoleError: MockInstance<(typeof console)['error']>

beforeEach(() => {
	const originalConsoleError = console.error
	consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(
		(...args: Parameters<typeof console.error>) => {
			originalConsoleError(...args)
			throw new Error(
				'Console error was called. Call consoleError.mockImplementation(() => {}) if this is expected.',
			)
		},
	)
	// ...
})
```

## Good Patterns

- **共有設定パッケージによる設定の一元管理**: ESLint・Prettier・TypeScript の設定を `@epic-web/config` に集約し、プロジェクト側の設定ファイルを 5 行以下に抑えている。設定の更新は npm パッケージのバージョンアップのみで完了する。

```javascript
// eslint.config.js — プロジェクト固有のオーバーライドのみ
import { default as defaultConfig } from '@epic-web/config/eslint'
export default [
	...defaultConfig,
	{ files: ['**/tests/**/*.ts'], rules: { 'react-hooks/rules-of-hooks': 'off' } },
]
```

- **Zod による環境変数のバリデーションと型安全性**: `app/utils/env.server.ts` で環境変数を Zod スキーマでバリデーションし、`z.infer` で `ProcessEnv` の型を拡張する。起動時にバリデーションを実行し、不正な環境変数を即座に検出する。

```typescript
// app/utils/env.server.ts:31-34
declare global {
	namespace NodeJS {
		interface ProcessEnv extends z.infer<typeof schema> {}
	}
}
```

- **console.error のテスト時 throw 化**: `setup-test-env.ts` で `console.error` と `console.warn` を throw するように mock し、意図しない警告やエラーをテスト失敗として捕捉する。意図的な呼び出しは `consoleError.mockImplementation(() => {})` で明示的に許可する。

```typescript
// tests/setup/setup-test-env.ts:18-27
consoleError = vi.spyOn(console, 'error')
consoleError.mockImplementation(
	(...args: Parameters<typeof console.error>) => {
		originalConsoleError(...args)
		throw new Error(
			'Console error was called. Call consoleError.mockImplementation(() => {}) if this is expected.',
		)
	},
)
```

- **ADR（Architecture Decision Records）による意思決定の記録**: `docs/decisions/` に 47 個の ADR を蓄積し、「なぜその選択をしたか」を追跡可能にしている。import エイリアスだけでも 3 つの ADR（026 → 031 → 046）が残されており、意思決定の変遷が明確。

## Anti-Patterns / 注意点

- **共有設定パッケージへの過度な依存**: `@epic-web/config` のようなブラックボックス化された設定パッケージは、内部のルールを把握しにくくなる。プロジェクト固有のルール追加時に共有設定と競合する場合、デバッグが困難になる。

```javascript
// Bad: 共有設定の内容を確認せずルールを追加
export default [
	...defaultConfig,
	{ rules: { 'import/order': ['error', { /* custom config */ }] } }, // 共有設定と競合する可能性
]

// Better: 共有設定の内容を確認し、上書きする理由をコメントで明示
export default [
	...defaultConfig,
	{
		// @epic-web/config の import/order は alphabetical だが、
		// このプロジェクトではモジュール種別でグループ化したい
		rules: { 'import-x/order': ['error', { groups: [/* ... */] }] },
	},
]
```

- **ファイル命名規約の暗黙知**: `.server.ts` がクライアントバンドルから除外されることはフレームワーク（React Router）の知識を前提とする。新規参加者がサフィックスなしでサーバー専用コードを書くと、秘匿情報がクライアントに漏洩するリスクがある。

```typescript
// Bad: サフィックスなしでサーバー専用コードを記述
// app/utils/secrets.ts — クライアントバンドルに含まれる可能性
export const API_KEY = process.env.SECRET_API_KEY

// Better: .server.ts サフィックスで明示
// app/utils/secrets.server.ts — フレームワークが除外を保証
export const API_KEY = process.env.SECRET_API_KEY
```

## 導出ルール

- `[MUST]` コード品質ツール（ESLint・Prettier・TypeScript）の設定は共有設定パッケージまたはプリセットを使い、プロジェクト側は差分のみカスタマイズする
  - 根拠: Epic Stack は `@epic-web/config` で3ツールの設定を集約し、プロジェクト側の設定ファイルを最小限に抑えている（`eslint.config.js` は 14 行、`tsconfig.json` は 15 行）

- `[MUST]` import エイリアスは `tsconfig.json` の `paths` ではなく、`package.json` の `imports` フィールド（Node.js Subpath Imports）を使用する
  - 根拠: `paths` は TypeScript 固有の機能で、Vitest・ESLint 等の各ツールに個別のパス解決設定が必要。`imports` は Node.js 標準仕様のためツール横断で自動解決される（`docs/decisions/046-remove-path-aliases.md`）

- `[MUST]` CI パイプラインでは lint・型チェック・単体テスト・E2E テストを独立したジョブとして並列実行し、デプロイはすべての完了を待機する
  - 根拠: Epic Stack の `deploy.yml` は lint, typecheck, vitest, playwright を並列ジョブで実行し、deploy ジョブが `needs: [lint, typecheck, vitest, playwright, container]` で全完了を待機する

- `[SHOULD]` サーバー専用コードはファイル名サフィックス（`.server.ts`）で宣言し、バンドラーによるクライアント除外を活用する
  - 根拠: Epic Stack は 26 個の `.server.ts` ファイルでサーバー専用コードを分離し、React Router のバンドラーがクライアントへの混入を防止する

- `[SHOULD]` import パスにはファイル拡張子（`.ts` / `.tsx`）を明示する
  - 根拠: Epic Stack の全 import（305 箇所以上）で拡張子が明示されており、ESM 環境での解決の明確性とエディタの補完精度が向上する

- `[SHOULD]` 環境変数は Zod スキーマでバリデーションし、`z.infer` で型安全性を確保する。アプリケーション起動時にバリデーションを実行する
  - 根拠: `app/utils/env.server.ts` で起動時バリデーションと `ProcessEnv` 型拡張を実装し、不正な環境変数を実行時ではなく起動時に検出する

- `[SHOULD]` テスト環境で `console.error` / `console.warn` を throw に変換し、意図しない警告を見逃さない
  - 根拠: `tests/setup/setup-test-env.ts` で実装。意図的な呼び出しは `consoleError.mockImplementation(() => {})` で明示的にオプトインする設計

- `[SHOULD]` 設計上の意思決定は ADR（Architecture Decision Records）として記録し、「なぜその選択をしたか」を追跡可能にする
  - 根拠: Epic Stack は `docs/decisions/` に 47 個の ADR を蓄積し、import 戦略の3回の変遷（026 → 031 → 046）も含め、意思決定の根拠を保持している

- `[AVOID]` ツール固有のパス解決設定（TypeScript `paths`, Vitest `resolve.alias`, Jest `moduleNameMapper`）を複数の設定ファイルに重複定義すること
  - 根拠: Epic Stack は `tsconfig.json` の `paths` を廃止し `package.json` `imports` に一元化することで、設定の同期問題を根本的に排除した（`docs/decisions/046-remove-path-aliases.md`）

## 適用チェックリスト

- [ ] ESLint・Prettier・TypeScript の設定が共有プリセット（`@epic-web/config`, `eslint-config-*` 等）をベースにしており、プロジェクト固有のオーバーライドが最小限か
- [ ] import エイリアスが `package.json` の `imports` フィールドで定義されているか（`tsconfig.json` の `paths` と重複していないか）
- [ ] サーバー専用コードがファイル名規約（`.server.ts` 等）またはディレクトリ規約で明確に分離されているか
- [ ] validate / CI スクリプトで lint・型チェック・テスト・E2E が並列実行されているか
- [ ] 環境変数が Zod 等のスキーマバリデーションで型安全に管理されているか
- [ ] テスト環境で `console.error` / `console.warn` の意図しない呼び出しが検出される仕組みがあるか
- [ ] 重要な設計判断（ツール選定・規約変更等）が ADR やドキュメントとして記録されているか
- [ ] import パスにファイル拡張子が明示されているか（ESM プロジェクトの場合）
