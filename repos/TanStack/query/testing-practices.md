# testing-practices

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query は React, Solid, Vue, Svelte, Angular, Preact の6つのフレームワークに対応するマルチフレームワークライブラリであり、フレームワーク非依存のコア（`query-core`）と各フレームワーク固有のアダプターに分かれている。テスト戦略は「コア層はフレームワーク無しで純粋にテストし、アダプター層は各フレームワークの testing-library で UI 統合テストを行う」という明確な二層構造になっている。さらに、型テスト（`.test-d.ts`）を Vitest の `typecheck: { enabled: true }` で実行し、ランタイムテストと型レベルテストを同一テストランナーで統合している点が注目に値する。全21パッケージが Vitest + jsdom 環境で統一され、共有テストユーティリティパッケージ（`@tanstack/query-test-utils`）が横断的に利用されている。

## 背景にある原則

- **コアとアダプターの分離によるテスト効率最大化**: フレームワーク非依存のビジネスロジック（キャッシュ管理、クエリ状態遷移、ガベージコレクション等）を `query-core` に集約し、DOM 環境やフレームワーク固有の依存なしにテストできるようにしている。これにより、最もクリティカルなロジックのテストが最も速く・安定して実行でき、フレームワーク側の不安定さに影響されない。根拠: `query-core` のテストは `QueryClient`, `QueryObserver`, `QueryCache` を直接インスタンス化してテストしており、React の `render` も `act` も使わない (`packages/query-core/src/__tests__/queryClient.test.tsx:21-32`)。

- **テストインフラの共有パッケージ化による一貫性担保**: `queryKey()` による自動ユニークキー生成、`sleep()` による非同期制御、`mockVisibilityState()` による環境モックなど、全パッケージが共通する小さなユーティリティを `@tanstack/query-test-utils` パッケージとして切り出している。これにより、テストの書き方がパッケージ間で統一され、新しいフレームワークアダプターを追加する際のテストの書き出しが容易になる。根拠: `packages/query-test-utils/src/index.ts:1-3`。

- **型安全性を実行時テストと同等に扱う**: `.test-d.ts` / `.test-d.tsx` ファイルで `expectTypeOf` を使った型レベルアサーションを記述し、Vitest の `typecheck: { enabled: true }` で通常のテストランと統合実行している。さらに `test:types` スクリプトで TypeScript 5.0 から 5.8 まで9バージョンを連続チェックし、型の後方互換性を保証している。根拠: `packages/react-query/package.json:22-30` の `test:types:ts50` 〜 `test:types:tscurrent`。

- **フレームワーク固有の非同期更新を test-setup で吸収する**: React の `act()` ラッパー、Solid の `cleanup()`、Angular の `TestBed` 初期化など、フレームワーク固有のテストセットアップを各パッケージの `test-setup.ts` に集約している。特に React では `notifyManager.setNotifyFunction(act)` でライブラリ内部の通知を `act` でラップすることで、テスト側が個別に `act` を呼ぶ必要を減らしている。根拠: `packages/react-query/test-setup.ts:14-16`。

## 実例と分析

### テスト二層構造: コア層 vs アダプター層

コア層（`query-core`）のテストはフレームワーク非依存で、`QueryClient` と `QueryObserver` を直接操作する:

```typescript
// packages/query-core/src/__tests__/queryClient.test.tsx:21-32
beforeEach(() => {
  vi.useFakeTimers();
  queryClient = new QueryClient();
  queryCache = queryClient.getQueryCache();
  queryClient.mount();
});

afterEach(() => {
  queryClient.clear();
  queryClient.unmount();
  vi.useRealTimers();
});
```

一方、React アダプター層のテストは `renderWithClient` ヘルパーを使ってコンポーネントをレンダリングする:

```tsx
// packages/react-query/src/__tests__/utils.tsx:9-23
export function renderWithClient(
  client: QueryClient,
  ui: React.ReactElement,
): ReturnType<typeof render> {
  const { rerender, ...result } = render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
  return {
    ...result,
    rerender: (rerenderUi: React.ReactElement) =>
      rerender(
        <QueryClientProvider client={client}>{rerenderUi}</QueryClientProvider>,
      ),
  } as any;
}
```

同じ `renderWithClient` パターンが Preact アダプターにも存在する (`packages/preact-query/src/__tests__/utils.tsx:11-25`)。Solid は `@solidjs/testing-library` の `render` を直接使い、Svelte は `withEffectRoot` ヘルパーで effect のライフサイクルを管理する (`packages/svelte-query/tests/utils.svelte.ts:24-33`)。

### 自動ユニークキー生成による テスト分離

`queryKey()` はグローバルカウンターをインクリメントして毎回ユニークなキーを返す:

```typescript
// packages/query-test-utils/src/queryKey.ts:1-6
let queryKeyCount = 0;

export const queryKey = (): Array<string> => {
  queryKeyCount++;
  return [`query_${queryKeyCount}`];
};
```

全テストファイルで `const key = queryKey()` として使われ、テスト間のキャッシュ衝突を防いでいる。テスト同士が独立した状態を持つための最小限の仕組みである。

### 型テストの設計

`.test-d.ts` ファイルでは `expectTypeOf` を使って discriminated union の型絞り込みが正しく機能するかを検証している:

```typescript
// packages/query-core/src/__tests__/queryObserver.test-d.tsx:18-36
it('should be inferred as a correct result type', () => {
  const observer = new QueryObserver(queryClient, {
    queryKey: queryKey(),
    queryFn: () => Promise.resolve({ value: 'data' }),
  })

  const result = observer.getCurrentResult()

  if (result.isPending) {
    expectTypeOf(result.data).toEqualTypeOf<undefined>()
    expectTypeOf(result.error).toEqualTypeOf<null>()
    expectTypeOf(result.isError).toEqualTypeOf<false>()
    expectTypeOf(result.isPending).toEqualTypeOf<true>()
  }
```

`@ts-expect-error` を使った「コンパイルエラーになること」の検証も積極的に行われている:

```typescript
// packages/react-query/src/__tests__/queryOptions.test-d.tsx:23-28
it("should not allow excess properties", () => {
  assertType(
    queryOptions({
      queryKey: ["key"],
      queryFn: () => Promise.resolve(5),
      // @ts-expect-error this is a good error, because stallTime does not exist!
      stallTime: 1000,
    }),
  );
});
```

### マルチ TypeScript バージョンテスト

`test:types` スクリプトは `npm-run-all --serial` で TS 5.0〜最新まで順次コンパイルチェックを実行する:

```json
// packages/react-query/package.json:22-30
"test:types:ts50": "node ../../node_modules/typescript50/lib/tsc.js --build tsconfig.legacy.json",
"test:types:ts51": "node ../../node_modules/typescript51/lib/tsc.js --build tsconfig.legacy.json",
...
"test:types:tscurrent": "tsc --build",
```

`typescript50`, `typescript51` 等は `package.json` の devDependencies で `"typescript50": "npm:typescript@5.0"` のようにエイリアスされている（`package.json:76-83`）。これにより、ユーザーがどの TypeScript バージョンを使っていても型が壊れないことを保証している。

### notifyManager を使った React テスト統合

React のテストで最も注意すべき点は、ライブラリ内部の状態更新が React の `act()` 境界外で発生することである。TanStack Query は `notifyManager.setNotifyFunction` でこの問題をグローバルに解決している:

```typescript
// packages/react-query/test-setup.ts:13-16
// Wrap notifications with act to make sure React knows about React Query updates
notifyManager.setNotifyFunction((fn) => {
  act(fn);
});
```

この設定により、テスト内で `vi.advanceTimersByTimeAsync` を呼ぶだけでクエリの状態遷移が React の更新サイクルに正しく伝播する。

### フレームワーク固有の test-setup パターン比較

各フレームワークの test-setup は必要最小限のグローバル設定のみを含む:

- **React**: `@testing-library/jest-dom/vitest` + `cleanup()` + `notifyManager.setNotifyFunction(act)` (3行)
- **Solid**: `@testing-library/jest-dom/vitest` + `cleanup()` (2行)
- **Svelte**: `@testing-library/jest-dom/vitest` のみ (1行)
- **Vue**: `@testing-library/jest-dom/vitest` + `onConsoleLog` フィルタ (vite.config 内)
- **Angular**: `TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting())` (独自の DI 環境初期化)

### CI 固有のリトライ戦略

React と Preact のテストのみ `retry: process.env.CI ? 3 : 0` が設定されている:

```typescript
// packages/react-query/vite.config.ts:33
retry: process.env.CI ? 3 : 0,
```

これはフレームワーク統合テスト特有のタイミング依存の不安定さに対する実践的な対処で、コア層のテストには設定されていない。

### 統合テスト（Build Integration Tests）

`integrations/` ディレクトリには React (Vite, Webpack 4/5, Next.js 14/15/16), Solid (Vite), Svelte (Vite), Vue (Vite), Angular (CLI 20) のプロジェクトが存在するが、これらはランタイムテストではなく「ビルドが通ること」を検証するスモークテストである (`integrations/react-vite/package.json` の scripts は `"build": "vite build"` のみ)。

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 同一のコアロジックを複数の UI フレームワークで利用する際のテスト戦略
  - 適用条件: フレームワーク非依存のコアと、フレームワーク固有のバインディングが分離されたライブラリ
  - コード例: `packages/query-core/src/__tests__/` (コア), `packages/react-query/src/__tests__/` (アダプター)
  - 注意点: コア層のテストカバレッジが十分であれば、アダプター層は薄い統合テストで済む

- **Factory Method パターン** (分類: 生成)
  - 解決する問題: テストごとにユニークな識別子を生成して分離を保証する
  - 適用条件: 共有状態（キャッシュ等）をテスト間で分離する必要がある場合
  - コード例: `packages/query-test-utils/src/queryKey.ts:1-6`
  - 注意点: グローバルカウンターは並列テスト実行でも衝突しない（値の一意性のみが重要で、順序は問わない）

## Good Patterns

- **共有テストユーティリティの専用パッケージ化**: `@tanstack/query-test-utils` としてモノレポ内の private パッケージに切り出すことで、全パッケージが同一のヘルパーを import できる。ユーティリティ自体もテストされている (`packages/query-test-utils/src/__test__/queryKey.test.ts`)。

```typescript
// packages/query-test-utils/src/index.ts:1-3
export { mockVisibilityState } from "./mockVisibilityState";
export { queryKey } from "./queryKey";
export { sleep } from "./sleep";
```

- **フレームワーク統合をグローバル setup で吸収**: テスト本体に `act()` ラッパーを書く代わりに、`notifyManager.setNotifyFunction` でグローバルにフックする。テスト本体はフレームワーク固有の儀式から解放され、ビジネスロジックの検証に集中できる。

```typescript
// packages/react-query/test-setup.ts:14-16
notifyManager.setNotifyFunction((fn) => {
  act(fn);
});
```

- **型テストと実行時テストの同一ランナー統合**: `.test-d.ts` ファイルを Vitest の `typecheck: { enabled: true }` で実行することで、`vitest` コマンド一発で型テストとランタイムテストの両方が走る。CI パイプラインが簡潔になる。

```typescript
// packages/query-core/vite.config.ts:28
typecheck: { enabled: true },
```

- **restoreMocks: true のグローバル設定**: 全パッケージの vite.config.ts で `restoreMocks: true` を設定し、各テストの afterEach で明示的にモック復元する必要をなくしている。

## Anti-Patterns / 注意点

- **CI リトライで不安定テストを隠す危険性**: `retry: process.env.CI ? 3 : 0` は実用的だが、根本原因（タイミング依存）を解決せずに成功率を上げているだけである。リトライが必要なテストは本質的に非決定的であり、リトライ回数を増やしても信頼性は改善しない。

```typescript
// Bad: CI でのみリトライして通す
retry: process.env.CI ? 3 : 0,
  // Better: fake timer で時間を制御し、テストを決定的にする
  vi.useFakeTimers();
await vi.advanceTimersByTimeAsync(100);
```

ただし TanStack Query では fake timer を基本戦略としつつ、フレームワーク内部のマイクロタスクスケジューリングに起因する避けがたい不安定さに対してのみリトライを適用している。コア層のテストにはリトライが設定されていないことが、この使い分けの意図を示している。

- **テスト内でのインライン queryFn 定義の肥大化**: テストファイルが非常に大きくなりがち（useQuery.test.tsx は数千行に達する）。テストケースごとに異なる queryFn をインラインで定義するパターンは理解しやすいが、ファイルサイズの肥大化を招く。

```typescript
// 大量のテストケースそれぞれにインラインの queryFn が定義される
it("should ...", async () => {
  const key = queryKey();
  function Page() {
    const { data } = useQuery({
      queryKey: key,
      queryFn: () => sleep(10).then(() => "specific-test-data"),
    });
    // ...
  }
});
```

## 導出ルール

- `[MUST]` マルチフレームワークライブラリでは、フレームワーク非依存のコアロジックとフレームワーク固有のバインディングを別パッケージに分離し、コアのテストは UI フレームワーク無しで実行できるようにする
  - 根拠: TanStack Query は `query-core` を純粋な TypeScript テストで検証し、6つのフレームワークアダプターは薄い統合テストのみを持つ構造により、テスト速度と安定性を両立している

- `[MUST]` 共有キャッシュやグローバル状態を使うライブラリのテストでは、テストごとにユニークな識別子を自動生成するヘルパーを用意し、テスト間の状態衝突を防ぐ
  - 根拠: `queryKey()` のグローバルカウンター方式により、TanStack Query の数千のテストケースがキャッシュキーの衝突なく並列実行できている (`packages/query-test-utils/src/queryKey.ts:1-6`)

- `[SHOULD]` 型推論が API の中核をなすライブラリでは、`.test-d.ts` ファイルで `expectTypeOf` を使った型テストを記述し、ランタイムテストと同じランナー（Vitest `typecheck: { enabled: true }`）で実行する
  - 根拠: TanStack Query は全パッケージで型テストを Vitest に統合し、さらに TS 5.0〜最新の9バージョンで後方互換性を検証している

- `[SHOULD]` フレームワークの状態更新をラップする必要がある場合、テスト本体ではなくグローバルな test-setup で一括設定する
  - 根拠: `notifyManager.setNotifyFunction(act)` を test-setup.ts に1回書くだけで、全テストから `act()` の明示的な呼び出しが不要になっている (`packages/react-query/test-setup.ts:14-16`)

- `[SHOULD]` モノレポでテストユーティリティを共有する場合、private パッケージとして切り出し、ユーティリティ自体にもテストを書く
  - 根拠: `@tanstack/query-test-utils` は3つのヘルパーのみの小さなパッケージだが、`queryKey.test.ts` と `sleep.test.ts` で正しさが保証されている

- `[AVOID]` CI リトライ (`retry: N`) をテストの不安定さの主な対策とすること。fake timer やモックで制御可能な場合はそちらを優先し、リトライは最終手段とする
  - 根拠: TanStack Query ではコア層のテストにリトライは設定されず、フレームワーク統合テスト（React, Preact）のみに限定されている。CI リトライは根本解決ではなく緩和策である

## 適用チェックリスト

- [ ] フレームワーク非依存のコアロジックが UI フレームワークのテスト依存なしにテストできる構造になっているか
- [ ] テスト間の状態分離のためのユニーク ID 生成ヘルパーが用意されているか
- [ ] 型テスト（`.test-d.ts`）がランタイムテストと同じ CI パイプラインで実行されているか
- [ ] フレームワーク固有のテストセットアップ（`act`, `cleanup` 等）が test-setup.ts に集約されているか
- [ ] テストユーティリティがモノレポ内で共有パッケージとして管理されているか
- [ ] `restoreMocks: true` 等のグローバル設定で、テストごとの手動モック復元を不要にしているか
- [ ] CI 環境でのリトライ設定が、コア層ではなくフレームワーク統合テストのみに限定されているか
- [ ] 複数の TypeScript バージョンでの型互換性テストが CI に組み込まれているか
