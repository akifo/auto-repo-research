# project-structure

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC のモノレポは、pnpm workspace + Turborepo + Lerna(パブリッシュ専用)の三層構成で運営される大規模 TypeScript プロジェクトである。特筆すべきは `unstable-core-do-not-import` という名前の内部モジュールを subpath export として公開し、ESLint ルールで利用を制限する「命名による境界強制」パターンと、adapter コードが内部実装ではなく公開 API 経由でのみコアにアクセスするよう lint で矯正する「自己消費テスト」の仕組みである。これらは 7 パッケージ・15+ subpath export という複雑な構成を、破壊的変更を最小化しつつ維持するための実践的な設計判断として注目に値する。

## 背景にある原則

- **「公開 API は意図的に狭く、内部 API は名前で抑止する」原則**: コアの全実装は `unstable-core-do-not-import/` ディレクトリに集約し、公開 API (`@trpc/server` の root export) はそこから選択的に re-export する。内部を完全に隠蔽するのではなく、名前に警告を込めて subpath export として公開する。これにより、兄弟パッケージ（`@trpc/client` 等）は TypeScript の型推論で必要な内部型にアクセスできる一方、外部ユーザーには「不安定」であることが自明になる。根拠: `packages/server/src/unstable-core-do-not-import.ts` の JSDoc に「DO NOT IMPORT FROM THIS FILE」と明記され、TypeScript の型推論エラー回避と兄弟パッケージ間の接着剤であることが述べられている。

- **「adapter は外部開発者と同じ API を使うべき」原則**: `@trpc/server` 内の adapter コードが `unstable-core-do-not-import` を直接 import することを ESLint で禁止し、代わりに `../@trpc/server` や `../@trpc/server/http` といった公開 API 相当のパスからのインポートを強制する。これにより、adapter のコードがサードパーティ adapter と同じ制約で書かれることを保証する。根拠: `eslint.config.js:173-191` の `packages/server/src/adapters/**/*` 向けルール。

- **「テストは消費者の視点で書く」原則**: 単体テストは各パッケージ内にも存在するが、統合テストは独立した `packages/tests/` パッケージに集約される。テストパッケージは全パッケージを依存関係として参照し、エンドユーザーと同じインポートパスで API を検証する。根拠: `packages/tests/package.json` が `@trpc/client` と `@trpc/server` を依存に持ち、テストファイルが `@trpc/server` パスでインポートしている。

- **「バージョンは一つ、公開は選択的」原則**: Lerna の fixed version モード(`lerna.json` の `"version": "11.10.0"`)で全パッケージを同一バージョンに保ちつつ、`packages/tests` は `"private": true` で npm に公開しない。peerDependency にも固定バージョン（`"@trpc/server": "11.10.0"`）を使い、パッケージ間の互換性を静的に保証する。

## 実例と分析

### 三層の公開境界: root export / subpath export / unstable-core

`@trpc/server` パッケージには三つの公開レベルが存在する。

1. **Root export** (`@trpc/server`): エンドユーザー向け。`initTRPC`, `TRPCError`, 推論ユーティリティ型を公開。`src/index.ts` → `src/@trpc/server/index.ts` → `unstable-core-do-not-import` から選択的 re-export。
2. **Subpath export** (`@trpc/server/http`, `/rpc`, `/observable`, `/shared`): adapter 開発者やプラグイン開発者向け。ドメイン別に分割。
3. **Unstable export** (`@trpc/server/unstable-core-do-not-import`): 兄弟パッケージ専用。TypeScript の型推論が要求する内部型を公開するためのエスケープハッチ。

この三層構造は `package.json` の `exports` フィールドで制御され、各エントリポイントが CJS/ESM 両方の条件付きエクスポートを持つ。

### `@trpc/` ディレクトリによる「仮想パッケージ」パターン

`packages/server/src/@trpc/server/` というディレクトリが存在し、adapter コードはここを相対パスで参照する。このディレクトリは `@trpc/server` パッケージの公開 API と同等のエクスポートを持ち、adapter が外部パッケージと同じインターフェースでコアにアクセスする「自己消費」を実現する。

adapter がコアにアクセスする際のインポートパス:

- 許可: `../../@trpc/server`（公開 API と同等）
- 許可: `../../@trpc/server/http`（subpath export と同等）
- 禁止: `../../unstable-core-do-not-import`（eslint-disable コメント必須）

### ESLint による境界強制

3 種類の ESLint ルールがパッケージ境界を守る:

1. **`@typescript-eslint/no-restricted-imports`** (グローバル): `@trpc/*/src` のインポートを禁止。ビルド成果物経由でなくソースを直接参照するパスを排除する。
2. **`no-restricted-imports`** (adapter 向け): `@trpc/server` と `unstable-core-do-not-import` のインポートを禁止。adapter が公開 API 経由でのみコアにアクセスすることを強制する。
3. **`no-restricted-imports`** (パッケージ内自己参照禁止): 各パッケージの `package.json` の `eslintConfig` で自パッケージからのインポートを禁止（例: `@trpc/client` パッケージ内で `@trpc/client` からの import を禁止）。

### vitest.config.ts による開発時のエイリアス解決

ルートの `vitest.config.ts` が全パッケージの `package.json#exports` を走査し、各 subpath export を `src/` ディレクトリへのエイリアスとして動的に登録する。これにより、テスト実行時にはビルドなしでソースコードを直接参照でき、`packages/tests/vitest.config.ts` は単にルート設定を re-export するだけで済む。

### 集約テストパッケージ

`packages/tests/` は `"private": true` の専用テストパッケージで、`@trpc/client` と `@trpc/server` を dependencies に持つ。サーバー側テスト (`server/`)、adapter テスト (`server/adapters/`)、regression テスト (`server/regression/`) がここに集約され、パッケージ横断の統合テストを一箇所で管理する。

### Turborepo のタスク依存グラフ

`turbo.json` の `build` タスクは `"dependsOn": ["^build", "prebuild"]` で上流パッケージのビルド完了を待つ。`lint` と `typecheck` も `"dependsOn": ["^build"]` でビルド済みの成果物に依存する。テストは `vitest` をルートから直接実行する構成で、Turborepo のタスクグラフには含まれていない。

## コード例

```typescript
// packages/server/src/unstable-core-do-not-import.ts:1-10
/**
 * **DO NOT IMPORT FROM THIS FILE**
 *
 * This file is here to:
 * - make TypeScript happy and prevent _"The inferred type of 'createContext' cannot be named without a reference to [...]"_.
 * - the the glue between the official `@trpc/*`-packages
 *
 * If you seem to need to import anything from here, please open an issue at https://github.com/trpc/trpc/issues
 */
export * from "./unstable-core-do-not-import/clientish/inference";
```

```typescript
// packages/server/src/@trpc/server/index.ts:1-14
export {
  createFlatProxy as createTRPCFlatProxy,
  createRecursiveProxy as createTRPCRecursiveProxy,
  experimental_standaloneMiddleware,
  experimental_standaloneMiddleware as experimental_trpcMiddleware,
  getTRPCErrorFromUnknown,
  initTRPC,
  transformTRPCResponse,
  TRPCError,
  // ...型エクスポートは省略
} from "../../unstable-core-do-not-import";
```

```typescript
// packages/server/src/index.ts:1
export * from "./@trpc/server";
```

```javascript
// eslint.config.js:173-191
{
  files: ['packages/server/src/adapters/**/*'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@trpc/server'],
          },
          {
            group: ['unstable-core-do-not-import'],
            message:
              'Use e.g. `../@trpc/server/http` instead - avoiding importing core helps us ensure third party adapters can be made',
          },
        ],
      },
    ],
  },
},
```

```typescript
// vitest.config.ts:18-36 (エイリアス動的生成)
for (const pkg of dirs.sort()) {
  const pkgJson = join(packagesDir, pkg, "package.json");
  const json = JSON.parse(readFileSync(pkgJson, "utf-8").toString());
  const exports = json.exports;

  for (const key of Object.keys(exports).sort()) {
    if (key.includes(".json")) {
      continue;
    }
    const trimmed = key.slice(1);
    aliases[`@trpc/${pkg}${trimmed}`] = join(
      packagesDir,
      pkg,
      "src",
      key.slice(1),
    ).replace(/\\/g, "/");
  }
}
```

```typescript
// packages/server/src/adapters/express.ts:10-13
import type { AnyRouter } from "../@trpc/server";
// eslint-disable-next-line no-restricted-imports
import { run } from "../unstable-core-do-not-import";
```

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: 複雑な内部モジュール群に対して、安定した狭いインターフェースを提供する
  - 適用条件: 内部実装の変更頻度が高く、外部 API の安定性が重要な場合
  - コード例: `packages/server/src/@trpc/server/index.ts` が `unstable-core-do-not-import` から選択的に re-export
  - 注意点: TypeScript の型推論が内部型を要求する場合、Facade だけでは不十分で unstable export のようなエスケープハッチが必要になる

- **Self-Shunt (自己消費テスト) パターン** (振る舞い)
  - 解決する問題: 内部コードが公開 API の品質を保証する仕組みがない
  - 適用条件: ライブラリのアダプタやプラグインが同一リポジトリ内で開発される場合
  - コード例: `packages/server/src/adapters/` が `../@trpc/server` を参照（ESLint で強制）
  - 注意点: 一部の低レベル操作（例: `run` ユーティリティ）は公開 API に含まれないため、`eslint-disable` による例外が必要になる

## Good Patterns

- **命名による不安定性の明示**: `unstable-core-do-not-import` というディレクトリ名とパッケージ subpath に「使うな」という意図を込めることで、semver で保護されない API であることをインポートパスレベルで伝える。アクセス制御と異なり、型推論のために参照が必要な場合でも「自己責任」であることが自明になる。

```typescript
// packages/server/package.json (exports フィールドの一部)
"./unstable-core-do-not-import": {
  "import": {
    "types": "./dist/unstable-core-do-not-import.d.mts",
    "default": "./dist/unstable-core-do-not-import.mjs"
  }
}
```

- **adapter の自己消費テスト**: ESLint の `no-restricted-imports` で adapter コードが `unstable-core-do-not-import` を直接参照することを禁止し、公開 API 経由のインポートを強制する。これにより、ファーストパーティ adapter がサードパーティと同じ制約で開発され、公開 API の十分性が常に検証される。

```javascript
// eslint.config.js:178-185
patterns: [
  { group: ['@trpc/server'] },
  {
    group: ['unstable-core-do-not-import'],
    message: 'Use e.g. `../@trpc/server/http` instead - avoiding importing core helps us ensure third party adapters can be made',
  },
],
```

- **vitest エイリアスの動的生成**: `package.json#exports` を走査してテスト用エイリアスを自動生成する。subpath export の追加時にテスト設定を手動で更新する必要がなく、エクスポートとテスト解決の不整合を防ぐ。

- **パッケージ内自己参照禁止**: 各パッケージの `package.json#eslintConfig` で自身のパッケージ名からのインポートを `no-restricted-imports` で禁止する。これにより、ビルド成果物への循環参照や、自パッケージを外部依存のように参照する事故を防ぐ。

```json
// packages/client/package.json:18-24
"eslintConfig": {
  "rules": {
    "no-restricted-imports": ["error", "@trpc/client"]
  }
}
```

## Anti-Patterns / 注意点

- **eslint-disable の蓄積**: adapter 内で `// eslint-disable-next-line no-restricted-imports` が複数箇所に出現する（例: `ws.ts` に 3 箇所）。自己消費パターンの例外が増えると、ルール自体の信頼性が低下する。公開 API が不十分な箇所を示すシグナルとして活用し、頻出する例外は API に昇格させるべきである。

```typescript
// Bad: eslint-disable が複数蓄積
// eslint-disable-next-line no-restricted-imports
import { isAsyncIterable, isObject, isTrackedEnvelope, type MaybePromise, run } from "../unstable-core-do-not-import";
// eslint-disable-next-line no-restricted-imports
import type { Result } from "../unstable-core-do-not-import";
// eslint-disable-next-line no-restricted-imports
import { iteratorResource } from "../unstable-core-do-not-import/stream/utils/asyncIterable";
```

```typescript
// Better: 頻出するユーティリティは subpath export に昇格
import { isAsyncIterable, isObject, run } from "../@trpc/server/shared";
import type { MaybePromise, Result } from "../@trpc/server/shared";
```

- **仮想パッケージディレクトリの認知負荷**: `src/@trpc/server/` というディレクトリ名はファイルシステム上で `@` プレフィクスを持ち、npm スコープパッケージのように見えるが実際はローカルの re-export 層である。初見の開発者にとって混乱を招きやすい。ただし、公開 API との 1:1 対応を維持するという目的には適合している。

## 導出ルール

- `[MUST]` モノレポの内部パッケージ間依存では、公開 API (subpath exports) と内部 API の境界を ESLint ルールで機械的に強制する
  - 根拠: tRPC は `no-restricted-imports` で adapter が `unstable-core-do-not-import` を直接参照することを禁止し、サードパーティと同等の API で開発されることを保証している (`eslint.config.js:173-191`)

- `[MUST]` 不安定な内部 API を公開する場合、パス名に不安定性を示す命名（`unstable-`, `internal-`, `do-not-import` 等）を含め、semver の保護対象外であることを明示する
  - 根拠: `unstable-core-do-not-import` は名前自体が警告であり、JSDoc でも「ここからインポートするな」と記載されている (`unstable-core-do-not-import.ts:1-10`)

- `[SHOULD]` モノレポのテストランナー設定では、`package.json#exports` を走査してエイリアスを動的生成し、subpath export の追加時に手動更新を不要にする
  - 根拠: tRPC の `vitest.config.ts` は全パッケージの exports を走査してエイリアスを自動生成し、テスト解決とパッケージ公開の不整合を防いでいる (`vitest.config.ts:18-36`)

- `[SHOULD]` ライブラリのファーストパーティ adapter/プラグインは、公開 API のみを使って実装する（自己消費テスト）ことで、API の十分性を継続的に検証する
  - 根拠: tRPC の adapter コードは `../@trpc/server` (公開 API 相当) 経由でコアにアクセスし、不足があれば公開 API を拡充する設計になっている

- `[SHOULD]` パッケージ内で自身のパッケージ名からのインポートを ESLint で禁止し、循環参照やビルド成果物への意図しない依存を防ぐ
  - 根拠: 各パッケージの `package.json#eslintConfig` に `"no-restricted-imports": ["error", "@trpc/<self>"]` が設定されている

- `[SHOULD]` モノレポ内の統合テストは専用パッケージに集約し、エンドユーザーと同じインポートパスでテストする
  - 根拠: `packages/tests/` が全パッケージを依存に持ち、公開パスからインポートして E2E 的な統合テストを実行している

- `[AVOID]` lint ルールの `eslint-disable` が同一パターンで 3 箇所以上蓄積する場合、例外として放置するのではなく公開 API の拡充を検討する
  - 根拠: `adapters/ws.ts` で `unstable-core-do-not-import` への `eslint-disable` が 3 箇所あり、`run`, `isAsyncIterable` 等の汎用ユーティリティが公開 API に不足していることを示している

## 適用チェックリスト

- [ ] モノレポの各パッケージで `package.json#exports` を定義し、公開 API の境界を明確にしているか
- [ ] 内部 API を他パッケージに公開する場合、パス名に不安定性を示す命名 (`unstable-`, `internal-`) を含めているか
- [ ] ESLint の `no-restricted-imports` でパッケージ間の不正なインポートパスを禁止しているか
- [ ] ファーストパーティの adapter/プラグインが公開 API のみを使って実装されているか（自己消費テスト）
- [ ] テスト用のモジュール解決が `package.json#exports` と自動同期する仕組みがあるか
- [ ] 各パッケージ内で自身のパッケージ名からのインポートが禁止されているか
- [ ] 統合テストがエンドユーザーと同じインポートパスで実行されているか
- [ ] `eslint-disable` の蓄積を定期的にレビューし、公開 API の不足を検出する仕組みがあるか
