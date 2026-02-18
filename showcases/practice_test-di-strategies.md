# Practice: test-di-strategies

> 出典: [honojs/hono](../repos/honojs/hono/testing-practices.md), [mastra-ai/mastra](../repos/mastra-ai/mastra/testing-practices.md), [Effect-TS/effect](../repos/Effect-TS/effect/testing-practices.md), [vitejs/vite](../repos/vitejs/vite/testing-practices.md), [ryoppippi/ccusage](../repos/ryoppippi/ccusage/testing-practices.md), [openclaw/openclaw](../repos/openclaw/openclaw/testing-practices.md), [open-circle/valibot](../repos/open-circle/valibot/testing-practices.md), [TanStack/query](../repos/TanStack/query/abstraction-patterns.md)
> カテゴリ: practice

## 概要

テスト時の依存性注入（DI）戦略を 8 リポジトリから横断的に分析し、「DI なし（境界モック）→ 環境変数スタブ → 引数注入/ファクトリ → コンテキスト注入 → Layer 差し替え」の 5 段階スペクトラムとして体系化する。プロダクションコードに DI 機構を持ち込まずにテスタビリティを確保する軽量アプローチから、型レベルで依存充足を保証する重量アプローチまで、プロジェクトの性質に応じた選択指針を提供する。

## 背景・文脈

テストにおける DI の目的は「テスト対象の振る舞いを、外部依存から分離して検証する」ことだが、そのための機構をどこまでプロダクションコードに入れるかはトレードオフがある。8 リポジトリを調査すると、DI の「重さ」と「型安全性」のスペクトラム上で明確な段階分けが見えてくる。

| 段階 | アプローチ                                 | 代表リポ                   | 型安全性         |
| ---- | ------------------------------------------ | -------------------------- | ---------------- |
| 1    | 境界モック（Web API スタブ）               | hono                       | -                |
| 2    | 環境変数スタブ                             | ccusage, vite              | -                |
| 3    | 引数注入 / ファクトリ                      | mastra, TanStack, openclaw | 静的型付き       |
| 4    | コンテキスト注入（`using` / `Disposable`） | ccusage                    | 言語レベル       |
| 5    | Layer 差し替え                             | Effect-TS                  | コンパイル時保証 |

## 実装パターン

### 1. 境界モック — DI なし（honojs/hono）

プロダクションコードにテスト用分岐を一切持たず、Web API の境界だけをモックする。`app.request()` で HTTP サーバーを起動せずにリクエスト/レスポンスを検証し、ランタイム固有の API は `vi.stubGlobal` でスタブする。

```typescript
// runtime-tests/fastly/index.test.ts:7-9
beforeAll(() => {
  vi.stubGlobal("fastly", true);
  vi.stubGlobal("navigator", undefined);
});
```

`testClient` は `app.request` を内部的に使い、RPC スタイルの型安全なテスト呼び出しを提供する。フェッチ関数を差し替えるだけで、アプリケーションコードは変更不要:

```typescript
// src/testing/index.ts の概要
// testClient は fetch 関数を app.request に差し替えるだけ
const client = testClient(app);
const res = await client.users[":id"].$get({ param: { id: "123" } });
```

5 つのルーター実装（RegExpRouter, TrieRouter, SmartRouter, LinearRouter, PatternRouter）に対して同一のテストスイートを共有し、宣言的スキップでルーター固有の差異を吸収する。

### 2. テストスイートファクトリ + 引数注入（mastra-ai/mastra）

`createTestSuite` ファクトリがストレージアダプターを引数として受け取り、23 種のバックエンドに対して同一のテストスイートを適用する。Capability フラグで未対応機能のテストを宣言的にスキップする。

```typescript
// packages/core/src/storage/test-utils/storage-test-suite.ts の概要
export function createTestSuite(
  store: MastraStorage,
  capabilities: { threads?: boolean; scores?: boolean; } = {},
) {
  describe("Storage Contract Tests", () => {
    it("should store and retrieve thread", async () => {
      // 引数で注入された store を使う
      await store.saveThread(thread);
      const result = await store.getThread(thread.id);
      expect(result).toEqual(thread);
    });

    // Capability フラグで宣言的にスキップ
    it.skipIf(!capabilities.scores)("should store scores", async () => {
      // ...
    });
  });
}

// 利用側: 1 行で統一契約テストを適用
createTestSuite(new PostgresStore(config), { threads: true, scores: true });
createTestSuite(new LibSQLStore(config), { threads: true });
```

### 3. Layer 差し替え（Effect-TS/effect）

`@effect/vitest` の `it.effect` / `it.scoped` / `it.live` でテスト環境を明示的に選択し、`layer()` でサービス実装をテスト用に差し替える。同一テストスイートを SQLite / PostgreSQL で再利用するパターンが `@effect/sql` で使われている。

```typescript
// packages/vitest/test/index.test.ts:107-123
layer(Foo.Live)((it) => {
  it.effect("adds context", () =>
    Effect.gen(function*() {
      const foo = yield* Foo;
      expect(foo).toEqual("foo");
    }));

  it.layer(Bar.Live)("nested", (it) => {
    it.effect("adds context", () =>
      Effect.gen(function*() {
        const foo = yield* Foo;
        const bar = yield* Bar;
        expect(foo).toEqual("foo");
        expect(bar).toEqual("bar");
      }));
  });
});
```

`it.effect` は自動的に `TestClock` / `TestRandom` を提供し、`it.live` は実環境で実行する。テストが成功した理由が「TestClock のおかげか、実時間でも再現可能か」を曖昧にしない設計:

```typescript
// packages/effect/test/Effect/memoization.test.ts:10-15
it.effect("non-memoized returns new instances", () =>
  it.flakyTest(Effect.gen(function*() {
    const random = Random.nextInt;
    const [first, second] = yield* pipe(random, Effect.zip(random));
    notStrictEqual(first, second);
  })));
```

## Good Example

### hono: プロダクションコードにテスト分岐ゼロ

`app.request()` が HTTP レイヤーをバイパスし、`vi.stubGlobal` がランタイム境界をモックする。テストのためにアプリケーションコードに DI 機構を追加する必要がなく、プロダクションコードの純粋性が保たれる。

### mastra: Capability フラグ付きファクトリ

`createTestSuite` に Capability オブジェクトを渡すだけで、未対応機能のテストが自動スキップされる。新しいストレージバックエンドを追加する際、テストは 1 行の呼び出しで完了する。

### Effect: `it.effect` vs `it.live` の明示的環境選択

テスト環境の選択が API レベルで強制され、「TestClock が時間を制御している」ことが型とメソッド名から明白になる。暗黙的なグローバル設定への依存がない。

### ccusage: `await using` + `createFixture` の自動クリーンアップ

```typescript
// apps/ccusage/src/_utils.ts:34-46
it("returns modification time", async () => {
  await using fixture = await createFixture({
    "test.txt": "content",
  });
  const mtime = await getFileModifiedTime(fixture.getPath("test.txt"));
  expect(mtime).toBeGreaterThan(0);
});
// fixture はスコープを抜けると自動的にクリーンアップ
```

`afterEach` での手動クリーンアップが不要で、リソースリークが構造的に防止される。

## Bad Example

### テストのためにアプリ層に DI 機構を持ち込む

```typescript
// Bad: テストのためにプロダクションコードに DI 機構を追加
function handleRequest(req, deps = defaultDeps) {
  if (deps.mockMode) { /* テスト用分岐 */ }
}

// Better: Web API 境界でモックする（hono のアプローチ）
beforeAll(() => {
  vi.stubGlobal("fastly", true);
});
```

### 暗黙的グローバルモック依存

```typescript
// Bad: vi.useFakeTimers() でグローバルにタイマーを偽装
// テスト間の依存が発生し、順序依存のフレーキーテストの温床になる
vi.useFakeTimers();

// Better: Effect の TestClock で明示的に時間を制御
it.effect("timeout after 5s", () =>
  Effect.gen(function*() {
    const fiber = yield* Effect.sleep("5 seconds").pipe(Effect.fork);
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(fiber);
  }));
```

### `vi.useFakeTimers` と TestClock の混在

```typescript
// Bad: 同一リポジトリで 2 つの時間制御機構が混在
// ファイル A: vi.useFakeTimers() + vi.advanceTimersByTime(1000)
// ファイル B: TestClock.adjust("1 second")
// → どちらの機構が有効か判断できない

// Better: リポジトリ全体で 1 つの時間制御機構に統一
```

## 適用ガイド

### どの段階を選ぶか

- **段階 1（境界モック）**: 依存が少なく、Web API 境界のモックで十分なプロジェクト。HTTP フレームワーク、ユーティリティライブラリ向き
- **段階 2（環境変数スタブ）**: 設定値の切り替えだけで振る舞いが変わるプロジェクト。CLI ツール、設定ドリブンなアプリ向き
- **段階 3（引数注入/ファクトリ）**: 複数のバックエンド実装に対して統一テストを適用したいプロジェクト。ストレージ抽象を持つフレームワーク向き
- **段階 4（コンテキスト注入）**: ファイルシステムやネットワークリソースのライフサイクル管理が重要なプロジェクト。TC39 `using` をサポートする環境向き
- **段階 5（Layer 差し替え）**: 依存関係の充足をコンパイル時に保証したいプロジェクト。Effect エコシステムを採用している場合のみ

### 注意点

- 段階が上がるほど型安全性は高まるが、学習コストと導入障壁も上がる
- 段階 1-2 は「プロダクションコードを変更しない」利点があるが、テストの表現力に限界がある
- 段階 3 の `createTestSuite` パターンは、テスト対象のインターフェースが安定している場合に最も効果的
- 段階 5 の Layer は Effect エコシステム全体の導入が前提。部分的な導入は困難

### カスタマイズポイント

- `createTestSuite` の Capability フラグは、テスト対象の機能を宣言的に制御するパターンとして他のコンテキストにも応用可能
- `vi.stubGlobal` + `testClient` の組み合わせは、サーバーレス環境のテストに特に有効
- `layer()` のネスト構造は、テスト間で共有するサービスと個別のサービスを階層的に管理する際に活用できる

## 参考

- [repos/honojs/hono/testing-practices.md](../repos/honojs/hono/testing-practices.md) — Web API 境界テスト、testClient
- [repos/mastra-ai/mastra/testing-practices.md](../repos/mastra-ai/mastra/testing-practices.md) — createTestSuite、Capability フラグ
- [repos/Effect-TS/effect/testing-practices.md](../repos/Effect-TS/effect/testing-practices.md) — @effect/vitest、Layer、TestClock
- [repos/vitejs/vite/testing-practices.md](../repos/vitejs/vite/testing-practices.md) — デュアルモード、playground 隔離
- [repos/ryoppippi/ccusage/testing-practices.md](../repos/ryoppippi/ccusage/testing-practices.md) — in-source testing、await using
- [repos/openclaw/openclaw/abstraction-patterns.md](../repos/openclaw/openclaw/abstraction-patterns.md) — 遅延プロキシ DI のテスト
- [repos/TanStack/query/abstraction-patterns.md](../repos/TanStack/query/abstraction-patterns.md) — Observer 引数注入
