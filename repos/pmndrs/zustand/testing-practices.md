# testing-practices

> リポジトリ: pmndrs/zustand
> 分析日: 2026-02-20

## 概要

React 状態管理ライブラリ zustand のテスト戦略を分析する。zustand は React hook と vanilla JavaScript の両方をサポートし、多数のミドルウェア（persist, devtools, immer 等）を持つため、テスト設計に複数の興味深いプラクティスが現れる。特に注目すべきは、(1) React Testing Library による「ストアの振る舞い」テストパターン、(2) `@ts-expect-error` と `expectTypeOf` を活用した型レベルテスト、(3) TypeScript 15 バージョン x React 9 バージョンの CI マトリクス戦略、(4) 外部依存（Redux DevTools 拡張、Storage API）のモック設計である。

## 背景にある原則

- **ストアはコンポーネント経由でテストすべき**: zustand のテストはストア API を直接呼ぶだけでなく、React コンポーネントをレンダリングし、`screen.getByText` で表示結果を検証する。これにより「ストアの状態変更がUIに反映される」というエンドユーザー視点の振る舞いが保証される。根拠: `tests/basic.test.tsx` のほぼ全テストがコンポーネントレンダリング + DOM アサーションのパターン。

- **型の正しさはランタイムテストと同じ重要度で検証すべき**: `tests/middlewareTypes.test.tsx` は `expectTypeOf` による型アサーションに特化し、ミドルウェアの組み合わせ（単一・二重・三重・四重）ごとに型推論の正しさを検証している。型テストを CI の `test:types`（`tsc --noEmit`）とは別に Vitest 内で実行することで、型推論の回帰を検出できる。

- **非同期ストレージは fake timer + sleep でシミュレートすべき**: `tests/persistAsync.test.tsx` は `vi.useFakeTimers()` と `vi.advanceTimersByTimeAsync()` でストレージの非同期遅延を制御する。実際の setTimeout に依存せず、テストを高速かつ決定的にするための原則。根拠: `tests/test-utils.ts:35` の `sleep` ヘルパーと `persistAsync.test.tsx` 全体。

- **マルチバージョン互換性は CI マトリクスで網羅すべき**: TypeScript 4.5-5.9（15 バージョン）と React 18.0-19.x（9 バージョン）を `fail-fast: false` のマトリクスで並列検証する。ライブラリの公開型やランタイム動作が広範なバージョンで壊れないことを自動保証する。

## 実例と分析

### ストアの振る舞いテスト: テスト内ストア生成パターン

zustand のテストでは、各テストケースの中でストアを `create()` で生成する。グローバルなストアを共有しない。これによりテスト間の状態汚染を完全に排除している。

```typescript
// tests/basic.test.tsx:50-68
it('uses the store with no args', () => {
  const useBoundStore = create<CounterState>((set) => ({
    count: 0,
    inc: () => set((state) => ({ count: state.count + 1 })),
  }))

  function Counter() {
    const { count, inc } = useBoundStore()
    useEffect(inc, [inc])
    return <div>count: {count}</div>
  }

  render(
    <>
      <Counter />
    </>,
  )

  expect(screen.getByText('count: 1')).toBeInTheDocument()
})
```

例外として SSR テスト（`tests/ssr.test.tsx`）ではファイルスコープでストアを定義している。これは SSR のライフサイクル（`renderToString` → `hydrateRoot`）を複数テストで再利用する必要があるため。

### レンダリング回数の検証: 変数カウンターパターン

再レンダリングの最適化をテストするため、コンポーネント内にレンダリングカウンターを変数として配置する。

```typescript
// tests/basic.test.tsx:131-164
it('only re-renders if selected state has changed', () => {
  const useBoundStore = create<CounterState>((set) => ({
    count: 0,
    inc: () => set((state) => ({ count: state.count + 1 })),
  }))
  let counterRenderCount = 0
  let controlRenderCount = 0

  function Counter() {
    const count = useBoundStore((state) => state.count)
    counterRenderCount++
    return <div>count: {count}</div>
  }

  function Control() {
    const inc = useBoundStore((state) => state.inc)
    controlRenderCount++
    return <button onClick={inc}>button</button>
  }

  render(/* ... */)
  fireEvent.click(screen.getByText('button'))

  expect(counterRenderCount).toBe(2)
  expect(controlRenderCount).toBe(1)
})
```

`Counter` は `count` を購読しているため再レンダリングされるが、`Control` は `inc` 関数（参照安定）のみを購読しているため再レンダリングされない。この手法は React のレンダリング最適化の正しさを検証するのに有効。

### 外部 API のモック: DevTools 拡張のフルモック

`tests/devtools.test.tsx` は Redux DevTools 拡張の `window.__REDUX_DEVTOOLS_EXTENSION__` をファイルスコープでモックし、接続・購読・送信を全てスパイで置き換える。

```typescript
// tests/devtools.test.tsx:29-119
const namedConnections = new Map<string | undefined, Connection>()

const extensionConnector = {
  connect: vi.fn((options: any) => {
    const key = getKeyFromOptions(options)
    const subscribers: Connection['subscribers'] = []
    const api: Connection['api'] = {
      subscribe: vi.fn((f: (m: unknown) => void) => {
        subscribers.push(f)
        return () => {}
      }),
      unsubscribe: vi.fn(() => { connectionMap.delete(key) }),
      send: vi.fn(),
      init: vi.fn(),
      error: vi.fn(),
    }
    connectionMap.set(key, { subscribers, api })
    return api
  }),
}
;(window as any).__REDUX_DEVTOOLS_EXTENSION__ = extensionConnector
```

ヘルパー関数 `getNamedConnectionApis` / `getNamedConnectionSubscribers` で型安全にモックオブジェクトを取得する設計。`beforeEach` で `vi.resetModules()` と接続 Map のクリアを行い、テスト間の分離を保証する。

### 非同期永続化テスト: ストレージファクトリパターン

`tests/persistAsync.test.tsx` はストレージ操作をファクトリ関数でカプセル化し、操作ごとにスパイを仕込む。

```typescript
// tests/persistAsync.test.tsx:10-40
const createPersistantStore = (initialValue: string | null) => {
  let state = initialValue

  const getItem = async (): Promise<string | null> => {
    getItemSpy()
    await sleep(10)
    return state
  }
  const setItem = async (name: string, newState: string) => {
    setItemSpy(name, newState)
    await sleep(10)
    state = newState
  }

  const getItemSpy = vi.fn()
  const setItemSpy = vi.fn()
  const removeItemSpy = vi.fn()

  return { storage: { getItem, setItem, removeItem }, getItemSpy, setItemSpy, removeItemSpy }
}
```

非同期操作を `sleep(10)` で遅延させ、`vi.advanceTimersByTimeAsync(10)` でテスト側から時間を進める。これにより「ハイドレーション中のユーザー操作」「複数回の concurrent rehydrate」のような競合状態をテストできる。

### 型テスト: expectTypeOf + @ts-expect-error 二刀流

型テストに2つの手法を使い分けている。

1. **`expectTypeOf` による型推論の検証**（`tests/middlewareTypes.test.tsx`）: ミドルウェアの組み合わせで型が正しく推論されるか確認する。

```typescript
// tests/middlewareTypes.test.tsx:42-56
it('no middleware', () => {
  const useBoundStore = create<CounterState>((set, get) => ({
    count: 0,
    inc: () => set({ count: get().count + 1 }, false),
  }))
  const TestComponent = () => {
    expectTypeOf(useBoundStore((s) => s.count) * 2).toEqualTypeOf<number>()
    expectTypeOf(useBoundStore((s) => s.inc)()).toEqualTypeOf<void>()
    return <></>
  }
  expect(TestComponent).toBeDefined()
})
```

2. **`@ts-expect-error` による不正な型の拒否テスト**（`tests/types.test.tsx`）: 型システムが不正な操作を正しくエラーにするか確認する。

```typescript
// tests/types.test.tsx:114-116
// @ts-expect-error we shouldn't be able to set count to undefined
a: () => set(() => ({ count: undefined })),
// @ts-expect-error we shouldn't be able to set count to undefined
b: () => set({ count: undefined }),
```

### CI マトリクス: 3段階のバージョン互換テスト

CI は 3 つのワークフローに分離されている。

1. **test.yml**: メイン CI（format + types + lint + spec + build）。単一ジョブで全チェックを順次実行。
2. **test-old-typescript.yml**: TypeScript 4.5-5.9 の 15 バージョンマトリクス。`tsconfig.json` の設定を `sed` でバージョンごとにパッチし、`test:types` のみ実行。古い TS ではモジュール解決やパス設定を変更する必要がある。
3. **test-multiple-versions.yml**: React 18.0-19.x の 9 バージョンマトリクス。`pnpm add -D react@{version}` で上書きし、`test:spec` を実行。
4. **test-multiple-builds.yml**: CJS/ESM ビルド形式のマトリクス。`vitest.config.mts` のエイリアスを `sed` でパッチし、ビルド成果物に対してテストを実行。`[DEV-ONLY]`/`[PRD-ONLY]` タグで環境依存テストを切り替える。

全マトリクスで `fail-fast: false` を採用し、1 つの失敗が他のバージョンの結果を隠さないようにしている。

### Vanilla テストの React 依存排除

`tests/vanilla/basic.test.ts` は冒頭で `vi.mock('react', () => ({}))` を実行し、React モジュールをスタブ化する。zustand の vanilla 版は React に依存しないが、モジュール解決で React が存在する環境でもバンドルに含まれないことを保証する。

```typescript
// tests/vanilla/basic.test.ts:6
vi.mock('react', () => ({}))
```

### console.error の退避パターン

複数のテストファイルで、エラーを意図的に発生させるテストの前に `console.error` を保存し、テスト後に復元する。

```typescript
// tests/basic.test.tsx:16-20
const consoleError = console.error
afterEach(() => {
  console.error = consoleError
})
```

テスト内で `console.error = vi.fn()` に差し替え、エラーメッセージの内容を検証する（`tests/devtools.test.tsx:311`）。`afterEach` での復元を忘れないのが重要。

## パターンカタログ

- **Factory Method** (分類: 生成)
  - 解決する問題: テスト間で独立したストアインスタンスとモックストレージを生成する
  - 適用条件: テストごとに異なる初期状態や設定が必要な場合
  - コード例: `tests/persistAsync.test.tsx:10` の `createPersistantStore`、`tests/persistSync.test.tsx:8` の `createPersistentStore`
  - 注意点: ファクトリ内でスパイも一緒に返すことで、テスト側での setup コードを削減できる

- **Test Double - Mock Object** (分類: テストパターン)
  - 解決する問題: ブラウザ API（Redux DevTools 拡張、Storage）への依存を切り離す
  - 適用条件: テスト対象がブラウザ固有のグローバルオブジェクトに依存する場合
  - コード例: `tests/devtools.test.tsx:86-119` の `extensionConnector`
  - 注意点: `beforeEach` で状態リセットを確実に行う。接続 Map のクリアを忘れるとテスト間で干渉する

## Good Patterns

- **テスト内ストア生成による完全分離**: 各テスト内でストアを `create()` で生成し、グローバル状態を共有しない。状態汚染のリスクがゼロになり、テストの並列実行が安全。

```typescript
// tests/basic.test.tsx:22-43
it('creates a store hook and api object', () => {
  const result = create((...args) => {
    params = args
    return { value: null }
  })
  expect({ params, result }).toMatchInlineSnapshot(`...`)
})
```

- **fake timer + sleep による非同期タイミング制御**: `vi.useFakeTimers()` + 固定遅延 `sleep(10)` + `vi.advanceTimersByTimeAsync(10)` の三点セットで、非同期処理のタイミングをテストが完全に制御する。

```typescript
// tests/persistAsync.test.tsx:46-52 + 98
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })
// テスト内:
await act(() => vi.advanceTimersByTimeAsync(10))
```

- **`[DEV-ONLY]`/`[PRD-ONLY]` タグによる環境別テスト**: テスト名にタグを付け、CI の `sed` で `it` / `it.skip` を切り替える。テストフレームワークの機能に依存せず、ビルド環境ごとのテスト選択を実現する。

```yaml
# .github/workflows/test-multiple-builds.yml:29
sed -i~ "s/it[.a-zA-Z]*('\[DEV-ONLY\]/it('/" tests/*.tsx
```

- **ストレージファクトリ + スパイ同梱返却**: モックストレージとそのスパイを一つのファクトリ関数で返す。テスト側で個別にスパイを設定する必要がなく、ボイラープレートが減る。

## Anti-Patterns / 注意点

- **レンダリングカウントのインライン変数**: `let renderCount = 0` をコンポーネント外に置き、コンポーネント内で `++renderCount` するパターンは簡潔だが、StrictMode の二重レンダリングを考慮する必要がある。zustand は `createWithEqualityFn` のテストで意図的に使っているが、StrictMode 下ではカウントが倍になる可能性がある。

```typescript
// Bad: StrictMode を考慮しないカウント
let renderCount = 0
function Component() {
  renderCount++  // StrictMode で2回呼ばれる
  return <div>renderCount: {renderCount}</div>
}
```

```typescript
// Better: ref で StrictMode に対応するか、DOM 表示値で検証
function Component() {
  const countRef = useRef(0)
  countRef.current++
  return <div>renderCount: {countRef.current}</div>
}
// または DOM アサーションのみで検証:
expect(screen.getByText('count: 1')).toBeInTheDocument()
```

- **console メソッドの手動退避/復元**: `console.error` を変数に保存して `afterEach` で復元するパターンは動作するが、復元忘れのリスクがある。`vi.spyOn(console, 'error')` を使う方がより安全（自動復元される）。zustand は一部のテスト（`tests/ssr.test.tsx:92`）で `vi.spyOn` を使っている一方、他のテスト（`tests/basic.test.tsx:16`）では手動退避を使っており、スタイルが混在している。

## 導出ルール

- `[MUST]` 状態管理ライブラリのテストでは、各テストケース内でストアを新規生成してテスト間の状態汚染を防ぐ
  - 根拠: zustand の全テストファイルでストアをテスト内またはファクトリ関数で生成しており、グローバルストア共有によるフレーキーテストを排除している（`tests/basic.test.tsx`, `tests/persistAsync.test.tsx` 等）

- `[MUST]` 非同期ストレージのテストでは fake timer を使い、テスト側からタイミングを制御する（実時間の `setTimeout` に依存しない）
  - 根拠: `tests/persistAsync.test.tsx` は `vi.useFakeTimers()` + `sleep(10)` + `vi.advanceTimersByTimeAsync(10)` で非同期処理の各段階を制御し、concurrent rehydrate のような競合状態も決定的にテストしている

- `[SHOULD]` ライブラリの公開型テストは `expectTypeOf` と `@ts-expect-error` を組み合わせて、「正しい型が推論される」と「不正な型が拒否される」の両面を検証する
  - 根拠: `tests/middlewareTypes.test.tsx` が `expectTypeOf` で型推論の正当性を検証し、`tests/types.test.tsx` が `@ts-expect-error` で型エラーの発生を検証しており、二つのアプローチで型安全性を多角的に保証している

- `[SHOULD]` ブラウザ API（DevTools 拡張、Storage 等）のモックは、状態を保持する Map/オブジェクトとアクセサ関数をセットで構築し、`beforeEach` で状態をリセットする
  - 根拠: `tests/devtools.test.tsx` が `namedConnections` Map + `getNamedConnectionApis` ヘルパーで型安全なモック操作を実現し、`beforeEach` で `vi.resetModules()` + Map クリアを行っている

- `[SHOULD]` CI でのマルチバージョン互換テストは `fail-fast: false` を設定し、1 つの失敗が他のバージョンの結果を隠さないようにする
  - 根拠: zustand の 3 つのマトリクス CI（TypeScript 15 版、React 9 版、CJS/ESM 2 形式）全てで `fail-fast: false` を採用している

- `[AVOID]` `console.error` の手動退避・復元パターン。代わりに `vi.spyOn(console, 'error')` を使い、テストフレームワークの自動復元機構に頼る
  - 根拠: zustand は `tests/ssr.test.tsx:92` で `vi.spyOn` を使い、`tests/basic.test.tsx:16` では手動退避を使っており、スタイルが混在している。`vi.spyOn` の方が復元忘れのリスクがない

## 適用チェックリスト

- [ ] 状態管理ストアのテストで、各テスト内にストアを生成しているか（グローバルストアを共有していないか）
- [ ] 非同期テストで fake timer を使い、テスト側からタイミングを制御しているか
- [ ] ライブラリの公開型に対する型テストがあるか（`expectTypeOf` / `@ts-expect-error`）
- [ ] ESLint に `vitest/consistent-test-it` を設定し、テスト関数名（`it` / `test`）を統一しているか
- [ ] `@testing-library/react` のセットアップで `globals: true` を設定し、auto cleanup を有効にしているか
- [ ] ブラウザ API のモックが `beforeEach` で確実にリセットされているか
- [ ] CI のマルチバージョンマトリクスで `fail-fast: false` を設定しているか
- [ ] `console.error` のモックに `vi.spyOn` を使い、自動復元に頼っているか
- [ ] テストユーティリティ（sleep, replacer/reviver 等）を共通ファイルに抽出しているか
