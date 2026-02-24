# dev-conventions

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC モノレポにおける開発規約を分析した。ESLint flat config による型パラメータ命名規約、`Symbol.dispose` 禁止と独自リソース管理パターン、アダプタ層のインポート制約、Conventional Commits の自動検証など、多層的な規約が設計されている。特に注目に値するのは、型パラメータに `T` と `$` の二重プレフィックス規約を設けてスコープを視覚的に区別している点と、ランタイム API の不安定性に対してラッパー関数で抽象化レイヤーを設ける戦略である。

## 背景にある原則

- **不安定な API は抽象化レイヤーで隔離すべき**: `Symbol.dispose` / `Symbol.asyncDispose` を直接使用せず `makeResource()` / `makeAsyncResource()` でラップしている。TC39 Explicit Resource Management はまだランタイム間で実装状況が異なるため、polyfill と使用箇所を1ファイルに集約し、将来の仕様変更時の影響範囲を最小化している（`disposable.ts:1-54`）
- **内部モジュール境界は命名とリンターで二重に防御すべき**: `unstable-core-do-not-import` というディレクトリ名で意図を伝え、さらに ESLint `no-restricted-imports` でアダプタ層からの直接インポートを禁止している。命名だけでは守れない境界をツールで強制する設計である（`eslint.config.js:175-191`）
- **型パラメータのスコープは命名規約で視覚的に区別すべき**: `T` プレフィックスは構造体（interface/type）レベルの型パラメータ、`$` プレフィックスはメソッドローカルの型パラメータに使い分けることで、ジェネリクスが10個を超える複雑な型定義でもスコープを一目で判別できる
- **テストとプロダクションコードで異なるルール厳格度を設定すべき**: テストファイルでは `no-non-null-assertion` や `naming-convention` を緩和し、プロダクションコードでは厳格に保つ。規約の目的（安全性 vs 表現力）に応じて適用範囲を調整している（`eslint.config.js:150-165`）

## 実例と分析

### 型パラメータの T/$ 二重プレフィックス規約

ESLint ルール `@typescript-eslint/naming-convention` で型パラメータを `^(T|$)([A-Z]([a-zA-Z]+))?[0-9]*$` に強制している。この正規表現は `T` または `$` で始まる PascalCase を許可する。

tRPC では `ProcedureBuilder` インターフェースが8つの型パラメータを持ち、各メソッドがさらにローカルな型パラメータを導入する。この規模になると、どの型パラメータがどのスコープに属するかの可読性が重要になる。

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:187-201
// T プレフィックス: インターフェースレベルの型パラメータ（呼び出しを跨いで保持）
export interface ProcedureBuilder<
  TContext,
  TMeta,
  TContextOverrides,
  TInputIn,
  TInputOut,
  TOutputIn,
  TOutputOut,
  TCaller extends boolean,
> {
  // $ プレフィックス: メソッドローカルの型パラメータ（この呼び出しでのみ有効）
  input<$Parser extends Parser>(
    schema: TInputOut extends UnsetMarker
      ? $Parser
      : inferParser<$Parser>['out'] extends Record<string, unknown> | undefined
```

`$Parser` は `input()` メソッド呼び出し時に推論される一時的な型であり、`TInputOut` はビルダーチェーン全体で蓄積される型である。この区別により、20行を超える条件型の中でもスコープの混同を防いでいる。

### Symbol.dispose 禁止と makeResource パターン

ESLint の `no-restricted-syntax` で AST セレクタを使い、`Symbol.dispose` と `Symbol.asyncDispose` への直接アクセスを禁止している。

```javascript
// eslint.config.js:106-120
'no-restricted-syntax': [
  'error',
  {
    selector:
      'MemberExpression[object.name="Symbol"][property.name="asyncDispose"]',
    message:
      'Usage of Symbol.asyncDispose is not allowed - use `makeAsyncResource()`',
  },
  {
    selector:
      'MemberExpression[object.name="Symbol"][property.name="dispose"]',
    message:
      'Usage of Symbol.dispose is not allowed - use `makeResource()`',
  },
],
```

唯一の例外が `disposable.ts` 自体であり、ここで polyfill と `makeResource` / `makeAsyncResource` を提供する。

```typescript
// packages/server/src/unstable-core-do-not-import/stream/utils/disposable.ts:1-7
// @ts-expect-error - polyfilling symbol
// eslint-disable-next-line no-restricted-syntax
Symbol.dispose ??= Symbol();

// @ts-expect-error - polyfilling symbol
// eslint-disable-next-line no-restricted-syntax
Symbol.asyncDispose ??= Symbol();
```

このパターンはテスト用リソースにも一貫して適用されている。

```typescript
// packages/server/src/__tests__/fakeTimersResource.ts:1-16
export function fakeTimersResource() {
  vi.useFakeTimers();
  return makeResource(
    {
      advanceTimersByTimeAsync: vi.advanceTimersByTimeAsync,
      runAllTimersAsync: vi.runAllTimersAsync,
      runAllTimers: vi.runAllTimers,
    },
    () => {
      vi.useRealTimers();
    },
  );
}
```

テストでは `await using ctx = testServerAndClientResource(router)` のように `using` 宣言と組み合わせ、テスト終了時に自動的にサーバーやタイマーをクリーンアップする。

### アダプタ層のインポート制約

アダプタ（Express, Next.js, WebSocket 等）は `@trpc/server` からも `unstable-core-do-not-import` からも直接インポートできないよう制約されている。

```javascript
// eslint.config.js:175-191
{
  files: ['packages/server/src/adapters/**/*'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          { group: ['@trpc/server'] },
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

代わりに `src/@trpc/server/` というローカルファサードディレクトリを経由する。

```typescript
// packages/server/src/adapters/standalone.ts:15-16
import { type AnyRouter } from "../@trpc/server";
// eslint-disable-next-line no-restricted-imports
import { run } from "../unstable-core-do-not-import";
```

このファサードは `unstable-core-do-not-import` から re-export する薄いレイヤーであり、サードパーティアダプタ作者が `@trpc/server` の公開 API のみで実装できることを保証する設計意図がある。ただし、一部のアダプタ（`ws.ts`, `nextAppDirCaller.ts`）では `eslint-disable-next-line` で例外的に `unstable-core-do-not-import` を直接参照しており、ファサードの網羅性が完全ではない現状も確認できる。

### Conventional Commits の CI 自動検証

PR タイトルを `semantic-pr.yml` で自動検証する。スコープの許可リストを `packages/` 配下の `package.json` から動的に生成し、追加スコープ（`www`, `ci`, `docs` 等）と合成する。

```yaml
# .github/workflows/semantic-pr.yml:34-35
ADDITIONAL_SCOPES: www,example,ci,docs,deps,monorepo
TYPES: feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert
```

パッケージが追加・削除されても手動でスコープリストを更新する必要がない点が、モノレポとの親和性を高めている。

### テストにおける waitFor の使い分け

Testing Library の `waitFor` を ESLint で禁止し、Vitest の `vi.waitFor` を使うよう強制している。

```javascript
// eslint.config.js:97-104
{
  group: ['@testing-library/dom', '@testing-library/react'],
  importNames: ['waitFor'],
  message:
    'Use `vi.waitFor` instead as the Testing Library one does not work with fake timers',
},
```

tRPC はストリーミングやサブスクリプションのテストでフェイクタイマーを多用するため、Testing Library の `waitFor` がフェイクタイマーと衝突する問題が実際に発生したと推測される。この規約により、テストの不安定性を構造的に防いでいる。

## Good Patterns

- **AST セレクタによる API 使用禁止**: `no-restricted-syntax` で `MemberExpression[object.name="Symbol"][property.name="dispose"]` のように AST パターンを指定し、特定 API へのアクセスをピンポイントで禁止する。文字列マッチングより正確で、変数経由の間接アクセス以外は確実に検出できる。

```javascript
// eslint.config.js:108-112
{
  selector:
    'MemberExpression[object.name="Symbol"][property.name="asyncDispose"]',
  message:
    'Usage of Symbol.asyncDispose is not allowed - use `makeAsyncResource()`',
},
```

- **リソースファクトリ + using 宣言の組み合わせ**: テスト用のサーバー、タイマー、接続などすべてを `makeResource` / `makeAsyncResource` でラップし、`await using` で自動クリーンアップする。テストのリソースリークを構造的に防止できる。

```typescript
// packages/tests/showcase/dataloader.test.ts:42
await using ctx = testServerAndClientResource(appRouter, { ... });
// テスト終了時に自動的にサーバーとWebSocket接続がクリーンアップされる
```

- **ファイルスコープ別のルール緩和**: ESLint flat config の `files` パターンで、テスト・サンプル・パッケージそれぞれに適切な厳格度を設定する。

```javascript
// eslint.config.js:150-165
{
  files: ['**/test/**/*', 'packages/tests/**/*', '**/*.test.tsx', '**/*.test.ts'],
  rules: {
    '@typescript-eslint/no-floating-promises': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/naming-convention': 'off',
  },
},
```

## Anti-Patterns / 注意点

- **eslint-disable の蓄積によるファサード形骸化**: アダプタ層で `unstable-core-do-not-import` への直接インポートが `eslint-disable-next-line` で多数許可されている。ファサード `@trpc/server` が必要な export を網羅していないと、例外が常態化し規約の意図が薄れる。

```typescript
// Bad: eslint-disable が複数箇所に散在
// packages/server/src/adapters/next-app-dir/nextAppDirCaller.ts:3-12
// eslint-disable-next-line no-restricted-imports
import { formDataToObject } from "../../unstable-core-do-not-import";
// FIXME: fix lint rule, this is ok
// eslint-disable-next-line no-restricted-imports
import type { ErrorHandlerOptions } from "../../unstable-core-do-not-import/procedure";
```

```typescript
// Better: ファサードに不足分を追加して eslint-disable を排除
// @trpc/server/index.ts に export を追加
export { formDataToObject } from "../../unstable-core-do-not-import";
export type { ErrorHandlerOptions } from "../../unstable-core-do-not-import/procedure";
```

- **max-params: 3 の形骸化リスク**: 関数パラメータを最大3に制限しているが、options オブジェクト内のプロパティ数に制限がないため、実質的にオブジェクトの中に多数のパラメータが隠れる。規約の意図（認知負荷の低減）を実現するには、options オブジェクトのプロパティ数にも目安を設けるべきである。

```typescript
// Bad: パラメータは1つだが、プロパティが多すぎる
function createHandler(opts: {
  router: AnyRouter;
  basePath: string;
  createContext: Function;
  onError: Function;
  transformer: any;
  batching: any; /* ... */
}) {}

// Better: 関連するプロパティをサブオブジェクトに構造化
function createHandler(opts: {
  router: AnyRouter;
  basePath: string;
  context: ContextConfig;
  errorHandling: ErrorConfig;
}) {}
```

## 導出ルール

- `[MUST]` 不安定な言語機能やランタイム API を使用する場合、ラッパー関数に隔離して直接使用を ESLint で禁止する
  - 根拠: tRPC は `Symbol.dispose` を `makeResource()` でラップし、`no-restricted-syntax` の AST セレクタで直接使用を禁止している。polyfill と使用箇所を1ファイルに集約することで、仕様変更時の影響範囲を最小化している（`disposable.ts`, `eslint.config.js:106-120`）
- `[MUST]` テストコードとプロダクションコードで ESLint ルールの厳格度を明示的に分離する
  - 根拠: tRPC は flat config の `files` パターンでテストファイルの `no-non-null-assertion` や `naming-convention` を緩和し、プロダクションコードでは厳格に保っている。テストの記述効率と本番の安全性を両立する設計（`eslint.config.js:150-165`）
- `[SHOULD]` ジェネリクスが多い型定義では、構造体レベルとメソッドローカルの型パラメータをプレフィックスで視覚的に区別する
  - 根拠: tRPC は `T` プレフィックスを構造体スコープ、`$` プレフィックスをメソッドローカルスコープに使い分け、10個超の型パラメータが混在する `ProcedureBuilder` の可読性を確保している（`procedureBuilder.ts:187-260`）
- `[SHOULD]` モノレポの Conventional Commits スコープ検証は、パッケージ一覧から動的に生成する
  - 根拠: tRPC の `semantic-pr.yml` は `packages/` 配下の `package.json` から `jq` でパッケージ名を抽出し許可スコープを構成する。パッケージの追加・削除に対してメンテナンスフリーである（`.github/workflows/semantic-pr.yml:38-43`）
- `[SHOULD]` テストのリソース（サーバー、DB 接続、タイマー等）は Disposable パターンでラップし、`using` / `await using` 宣言で自動クリーンアップする
  - 根拠: tRPC は `trpcServerResource`, `fetchServerResource`, `fakeTimersResource` をすべて `makeAsyncResource` / `makeResource` でラップし、テスト終了時に `using` 宣言で自動解放する。リソースリークによる不安定テストを構造的に防止している
- `[AVOID]` eslint-disable コメントが特定パターンで3箇所以上蓄積した場合、ルール自体の見直しやファサードの拡充を怠ること
  - 根拠: tRPC のアダプタ層では `no-restricted-imports` の `eslint-disable-next-line` が10箇所以上存在し、`FIXME` コメント付きで形骸化が進んでいる。例外の常態化はルールへの信頼を毀損する（`nextAppDirCaller.ts:3-12`, `ws.ts:28-39`）

## 適用チェックリスト

- [ ] プロジェクトで使用している不安定な API（Stage 3 以下のプロポーザル、実験的ランタイム機能）を洗い出し、ラッパー関数で隔離しているか確認する
- [ ] ESLint 設定でテストファイルとプロダクションコードのルール厳格度を分離しているか確認する
- [ ] ジェネリクスが5個以上ある型定義で、型パラメータのスコープが命名規約で区別できるか確認する
- [ ] `eslint-disable` コメントの蓄積状況を監査し、3箇所以上同じルールを無効化している場合はルール自体の見直しを検討する
- [ ] テスト用リソース（サーバー起動、DB 接続、タイマー操作）が `try-finally` で手動クリーンアップされている場合、Disposable パターンへの移行を検討する
- [ ] モノレポで Conventional Commits を使用している場合、スコープ検証がパッケージ一覧と同期しているか確認する
- [ ] ライブラリの内部モジュール境界が、命名だけでなくリンターで強制されているか確認する
