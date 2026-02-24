# testing-practices

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC は TypeScript ファーストの RPC ライブラリであり、クライアント-サーバー間のエンドツーエンド型安全性を提供する。テスト設計においては、パッケージ横断の統合テストを専用パッケージ `packages/tests/` に集約し、回帰テストを issue 番号で命名するという独自のプラクティスを採用している。リソース管理には `await using` + `AsyncDisposable` パターンを全面採用し、テストの信頼性とクリーンアップの確実性を両立させている。型推論の正しさをランタイムテストと同等に重視し、`expectTypeOf` による型レベルテストが回帰テストの過半数を占める点が特筆に値する。

## 背景にある原則

- **統合テストはパッケージ境界ではなくユーザー視点で組織化すべき**: クライアント・サーバー・アダプタが協調する統合テストをパッケージごとに配置すると、依存関係の循環やテストの重複が生じる。`packages/tests/` に集約することで「ユーザーが実際に使う組み合わせ」を正確に再現できる（`packages/tests/README.md:1-3`）。
- **回帰テストには再現元のトラッキング情報を埋め込むべき**: issue 番号をファイル名に含めることで、テストの存在理由が自明になり、「なぜこのテストがあるのか」を調べるコストがゼロになる。テスト名から issue を逆引きでき、削除判断も容易になる。
- **テストリソースの後始末は構造的に保証すべき**: `try/finally` による手動クリーンアップは忘れやすく、テスト失敗時にリソースリークを引き起こす。`AsyncDisposable` パターンを使えば、制御フローに関係なくクリーンアップが保証される。
- **型レベルのバグは型レベルのテストで防ぐべき**: tRPC のような型推論ヘビーなライブラリでは、ランタイムの挙動が正しくても型推論が壊れればユーザー体験は破綻する。`expectTypeOf` による型テストを回帰テストに含めることで、型推論の退行を防止している。

## 実例と分析

### 1. テスト集約パッケージ `packages/tests/`

tRPC はモノレポ内に `@trpc/tests` という専用パッケージを持つ。このパッケージは `@trpc/server` と `@trpc/client` の両方に依存し、実際のユーザーが行うようなクライアント-サーバー統合テストを実行する。76 個のテストファイルが集約されており、`server/`, `server/adapters/`, `server/regression/`, `showcase/` の 4 階層で組織化されている。

各パッケージ（`react-query`, `next`, `tanstack-react-query`）は独自の `test/` ディレクトリも持つが、これらはそのパッケージ固有の UI 統合テストに限定される。コアのクライアント-サーバー統合テストは `packages/tests/` に一元管理されている。

```
packages/tests/
├── server/             # コア統合テスト (40+ ファイル)
│   ├── adapters/       # アダプタ別テスト (standalone, fastify, fetch, express, next)
│   └── regression/     # 回帰テスト (25+ ファイル)
└── showcase/           # 使用例をテストとして保護 (tinyrpc, dataloader)
```

### 2. issue 番号命名による回帰テスト

`packages/tests/server/regression/` ディレクトリには 25 以上の回帰テストが `issue-{番号}-{説明}.test.ts` の命名規則で配置されている。

```
issue-2506-headers-throwing.test.ts
issue-2540-undefined-mutation.test.ts
issue-3085-bad-responses.test.ts
issue-4217-throw-non-errors.test.ts
issue-5034-input-with-index-signature.test.ts
issue-6461-stream-error.test.ts
```

同じパターンは `packages/react-query/test/regression/` にも適用されており、UI 層の回帰テストも同様に管理されている。ファイル先頭のコメントで issue URL を記載するケースもある。

```typescript
// packages/tests/server/regression/issue-2540-undefined-mutation.test.ts:1
// https://github.com/trpc/trpc/issues/2540
```

### 3. `await using` + `AsyncDisposable` によるリソース管理

テストサーバーの起動・停止は `makeAsyncResource` ヘルパーで `AsyncDisposable` を実装し、`await using` で自動クリーンアップされる。

```typescript
// packages/server/src/__tests__/trpcServerResource.ts:147
return makeAsyncResource(ctx, ctx.close);
```

```typescript
// packages/server/src/unstable-core-do-not-import/stream/utils/disposable.ts:38-54
export function makeAsyncResource<T>(
  thing: T,
  dispose: () => Promise<void>,
): T & AsyncDisposable {
  const it = thing as T & Partial<AsyncDisposable>;
  const existing = it[Symbol.asyncDispose];
  it[Symbol.asyncDispose] = async () => {
    await dispose();
    await existing?.();
  };
  return it as T & AsyncDisposable;
}
```

テスト側では `await using` 一行でサーバー起動とクリーンアップが完結する。

```typescript
// packages/tests/server/smoke.test.ts:34
await using ctx = testServerAndClientResource(router);
```

ESLint で `Symbol.dispose` / `Symbol.asyncDispose` の直接使用を禁止し、`makeResource()` / `makeAsyncResource()` の使用を強制している。

```typescript
// eslint.config.js:106-119
'no-restricted-syntax': [
  'error',
  {
    selector: 'MemberExpression[object.name="Symbol"][property.name="asyncDispose"]',
    message: 'Usage of Symbol.asyncDispose is not allowed - use `makeAsyncResource()`',
  },
],
```

### 4. テストリソースファクトリの階層設計

テストヘルパーは 3 層のファクトリ構造で設計されている。

1. **`trpcServerResource`** (`packages/server/src/__tests__/trpcServerResource.ts`): HTTP + WebSocket サーバーを起動し、スパイ付きのサーバーコンテキストを返す
2. **`testServerAndClientResource`** (`packages/client/src/__tests__/testClientResource.ts`): サーバーリソースにクライアント設定（リンク選択、`splitLink` 構成）を追加
3. **`testReactResource`** / **`getServerAndReactClient`**: React のプロバイダ・QueryClient を追加

各層が前の層を包み、テストに必要な粒度でリソースを取得できる。

### 5. 型レベル回帰テスト

回帰テストの多くはランタイムの動作ではなく TypeScript の型推論の正しさを検証している。`expectTypeOf` を使い、テストランナー上で型チェックを実行する。

```typescript
// packages/tests/server/regression/issue-5034-input-with-index-signature.test.ts:50-55
test('input type with a known key and an index signature', async () => {
  type Input = AppRouterInputs['inputWithIndexSignature'];
  expectTypeOf<Input>().toEqualTypeOf<{
    [x: string]: unknown;
    name: string;
  }>();
});
```

### 6. ESLint による Testing Library `waitFor` の禁止

フェイクタイマーとの非互換を防ぐため、Testing Library の `waitFor` をインポートレベルで禁止し、`vi.waitFor` の使用を強制している。

```typescript
// eslint.config.js:97-102
{
  group: ['@testing-library/dom', '@testing-library/react'],
  importNames: ['waitFor'],
  message: 'Use `vi.waitFor` instead as the Testing Library one does not work with fake timers',
},
```

### 7. Showcase テスト: ドキュメンテーションの保護

`packages/tests/showcase/` にはブログ記事やドキュメントの使用例をそのままテストとして実装している。`tinyrpc.test.ts` はブログ記事「tinyrpc client」の実装例がそのまま動作することを保証する。

```typescript
// packages/tests/showcase/tinyrpc.test.ts:1-3
/**
 * @see https://trpc.io/blog/tinyrpc-client
 */
```

### 8. メモリリークテスト

`websockets.memory.test.ts` と `httpSubscriptionLink.memory.test.ts` は `WeakRef` + `global.gc!()` でメモリリークを検証する。vitest の `poolOptions.forks.execArgv: ['--expose-gc']` でガベージコレクション API を有効化している。

```typescript
// packages/tests/server/websockets.memory.test.ts:56-59
await sleep(0);
global.gc!();
expect(refs[0]!.deref()).toBeUndefined();
expect(refs[1]!.deref()).toBeUndefined();
```

### 9. konn によるテストコンテキスト合成（レガシー）

`konn` フレームワークは `beforeEach` / `afterEach` のチェーンでテストコンテキストを構築するビルダーパターンを提供する。現在は `await using` パターンに移行が進んでおり、新しいテストでは `konn` を使わない方針が `.cursor/rules/test-patterns.mdc` に明記されている。

```typescript
// packages/tests/server/regression/issue-2540-undefined-mutation.test.ts:27-46
const ctx = konn()
  .beforeEach(() => {
    const opts = routerToServerAndClientNew(appRouter, {
      client({ httpUrl }) {
        return { links: [httpLink({ url: httpUrl })] };
      },
    });
    return opts;
  })
  .afterEach(async (ctx) => {
    await ctx?.close?.();
  })
  .done();
```

## パターンカタログ

- **Disposable パターン** (分類: リソース管理)
  - 解決する問題: テストサーバーの起動・停止の確実なクリーンアップ
  - 適用条件: テスト内で外部リソース（サーバー、DB 接続、ファイルハンドル）を使用する場合
  - コード例: `packages/server/src/unstable-core-do-not-import/stream/utils/disposable.ts:38-54`
  - 注意点: `Symbol.asyncDispose` のポリフィルが必要（`disposable.ts:1-7`）

- **Factory Method パターン** (分類: 生成)
  - 解決する問題: テストごとに異なる構成のサーバー・クライアントペアを生成する
  - 適用条件: テストヘルパーが多様なオプション組み合わせをサポートする必要がある場合
  - コード例: `packages/client/src/__tests__/testClientResource.ts:59-181`
  - 注意点: オプションの型が複雑化しやすいため、ジェネリクスで型安全性を維持する

## Good Patterns

- **issue 番号ファイル名**: 回帰テストに `issue-{番号}-{説明}.test.ts` の命名規則を適用することで、テストの存在理由が自明になる。コードレビューや将来の削除判断で issue を即座に参照できる。

```
// Good: issue番号 + 簡潔な説明
issue-4217-throw-non-errors.test.ts
issue-3359-http-status-413-payload-too-large.test.ts

// Good: ファイル先頭にissue URLを記載
// https://github.com/trpc/trpc/issues/2540
```

- **`await using` による宣言的リソース管理**: テストリソースのクリーンアップをスコープ終了に紐付けることで、`try/finally` の書き忘れや非同期エラー時のリソースリークを構造的に防止する。

```typescript
// Good: await using で自動クリーンアップ
test('basic', async () => {
  await using ctx = testServerAndClientResource(router);
  expect(await ctx.client.hello.query()).toBe('world');
  // スコープ終了時に自動的にサーバーが停止
});
```

- **`waitError` ヘルパーによる型安全なエラーテスト**: エラーを `catch` で受けると `unknown` 型になるが、`waitError` は型引数でエラー型を指定でき、型安全にエラーのプロパティを検証できる。

```typescript
// packages/server/src/__tests__/waitError.ts:3-12
export async function waitError<TError extends Error = Error>(
  fnOrPromise: Promise<unknown> | (() => unknown),
  errorConstructor?: Constructor<TError>,
): Promise<TError> {
```

- **テスト用ファクトリの階層化**: サーバーリソース → クライアントリソース → React リソースの 3 層で共通セットアップを再利用し、テストごとに必要な構成だけをオーバーライドする。

## Anti-Patterns / 注意点

- **手動 `close()` によるリソース管理**: `routerToServerAndClientNew` は手動で `close()` を呼ぶ必要があり、テスト失敗時にリソースリークが発生する。tRPC では deprecated とマークされ、`testServerAndClientResource` + `await using` への移行が進められている。

```typescript
// Bad: 手動クリーンアップ — テスト失敗時にclose()が呼ばれない可能性
const ctx = routerToServerAndClientNew(router);
// ... テスト ...
await ctx.close();

// Better: await using で自動クリーンアップ
await using ctx = testServerAndClientResource(router);
// ... テスト ...
// スコープ終了時に自動クリーンアップ
```

- **Testing Library の `waitFor` とフェイクタイマーの非互換**: Testing Library の `waitFor` は内部で `setTimeout` を使うため、`vi.useFakeTimers()` 環境下で無限ループに陥る。テストフレームワーク提供の `vi.waitFor` を使えばこの問題を回避できる。

```typescript
// Bad: Testing Library の waitFor — フェイクタイマーと非互換
import { waitFor } from '@testing-library/react';
await waitFor(() => expect(element).toBeVisible());

// Better: vi.waitFor — フェイクタイマーと互換
await vi.waitFor(() => {
  expect(onStartedMock).toHaveBeenCalled();
});
```

## 導出ルール

- `[MUST]` 回帰テストのファイル名にはバグトラッカーの issue 番号を含め、テストの存在理由を自明にする
  - 根拠: tRPC は `issue-{番号}-{説明}.test.ts` の命名を 25 以上の回帰テストで一貫して適用し、テストの追跡可能性を維持している（`packages/tests/server/regression/`）
- `[MUST]` テスト内で起動するサーバー・接続などの外部リソースは構造的にクリーンアップを保証する仕組み（`AsyncDisposable`、`afterEach`、`addTeardown` 等）を使う
  - 根拠: tRPC は `makeAsyncResource` + `await using` でリソースリークを構造的に防止し、手動 `close()` パターンを deprecated にしている（`packages/server/src/__tests__/trpcServerResource.ts:147`）
- `[SHOULD]` パッケージ横断の統合テストは専用のテストパッケージ／ディレクトリに集約し、個別パッケージのテストと分離する
  - 根拠: `packages/tests/` に 76 個の統合テストを集約し、パッケージ間の循環依存を回避しつつユーザー視点のテストシナリオを実現している
- `[SHOULD]` 型推論を重視するライブラリでは `expectTypeOf` 等を使った型レベルの回帰テストを書き、型推論の退行を CI で検出する
  - 根拠: 回帰テストの約半数が `expectTypeOf` による型チェックであり、ランタイムテストだけでは検出できない型推論バグを防止している
- `[SHOULD]` テスト用のエラー検証には型安全なヘルパー（`waitError` 等）を用意し、`catch` ブロックの `unknown` 型を回避する
  - 根拠: `waitError` はジェネリクスでエラー型を絞り込み、エラーのプロパティ検証を型安全に行えるようにしている（`packages/server/src/__tests__/waitError.ts`）
- `[SHOULD]` ドキュメントやブログ記事のコード例はテストとして実装し、ドキュメントの陳腐化を防止する
  - 根拠: `packages/tests/showcase/tinyrpc.test.ts` はブログ記事のコード例をそのままテストとして保護している
- `[AVOID]` テストフレームワーク提供の wait ユーティリティの代わりにサードパーティの wait 関数を使うこと（フェイクタイマーとの非互換が生じうる）
  - 根拠: ESLint ルールで `@testing-library/react` の `waitFor` のインポートを禁止し、`vi.waitFor` の使用を強制している（`eslint.config.js:97-102`）

## 適用チェックリスト

- [ ] 回帰テストのファイル命名規則を定め、issue 番号やチケット番号をファイル名に含めるルールをチームで合意する
- [ ] テスト内で起動するサーバーや接続のクリーンアップが構造的に保証されているか確認する（`afterEach`、`Disposable`、`addTeardown` 等）
- [ ] モノレポの場合、パッケージ横断の統合テストを専用ディレクトリに集約する設計を検討する
- [ ] テストフレームワークの `waitFor` とサードパーティの `waitFor` が混在していないか確認し、フェイクタイマーとの互換性を検証する
- [ ] 型推論を多用するライブラリの場合、`expectTypeOf` や `@ts-expect-error` による型レベルテストを回帰テストに含める
- [ ] テスト用のエラー検証ヘルパーが型安全かどうか確認する（`catch` の `unknown` 型を適切に絞り込めているか）
- [ ] ドキュメントのコード例がテストで保護されているか確認し、保護されていない例を showcase テストとして追加する
- [ ] メモリリークが懸念される非同期処理（ストリーミング、WebSocket）について `WeakRef` + `gc()` によるメモリテストの導入を検討する
