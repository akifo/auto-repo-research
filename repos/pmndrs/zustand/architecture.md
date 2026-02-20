# Architecture

> リポジトリ: pmndrs/zustand
> 分析日: 2026-02-20

## 概要

zustand のアーキテクチャを「vanilla/react の分離」「ミドルウェア合成」「useSyncExternalStore 統合」の 3 軸で分析した。わずか 16 ソースファイル・約 1,200 行で、フレームワーク非依存のコアストアに React バインディングとミドルウェアチェーンを型安全に積層するレイヤー設計が実現されている。特筆すべきは、`declare module` による開放型レジストリと再帰型 `Mutate<S, Ms>` を用いたミドルウェア型合成であり、プラグイン拡張を完全に型推論で追跡できる点が他のライブラリにない独自性を持つ。

## 背景にある原則

- **フレームワーク非依存コアの分離**: 状態管理のコアロジック（`Set<Listener>` + クロージャ）は React に一切依存しない。`src/vanilla.ts` は `react` を import せず、React バインディングは別ファイル `src/react.ts` が担う。これにより、vanilla コアは Node.js, Vue, Svelte 等あらゆるランタイムで利用可能になる。根拠: `src/vanilla.ts` に React import が存在しない、`peerDependencies` で `react` が `optional: true` (`package.json:168-170`)。

- **ミドルウェアはストア API の monkey-patch である**: 各ミドルウェアは `StateCreator` を受け取り `StateCreator` を返す高階関数であり、実行時には `api.setState` / `api.subscribe` を自身の関数で上書き（monkey-patch）することで振る舞いを拡張する。新しいラッパーオブジェクトを生成せず、同一の `api` オブジェクトを破壊的に修正するため、関数合成がゼロアロケーションで行われる。根拠: `src/middleware/devtools.ts:216` で `api.setState = ...`、`src/middleware/persist.ts:231` で `api.setState = ...`、`src/middleware/immer.ts:77` で `store.setState = ...`。

- **型は declare module で開放し、再帰で積層する**: ミドルウェアが `StoreApi` に追加するプロパティ（`dispatch`, `persist`, `devtools` 等）は `declare module '../vanilla'` で `StoreMutators` インターフェースを拡張することで表現される。型レベルでの積層は再帰型 `Mutate<S, Ms>` が担い、ミドルウェアの適用順序と型変換を正確に追跡する。根拠: `src/vanilla.ts:20-26` の `Mutate` 型定義、`src/middleware/redux.ts:28-31` の `declare module`。

- **React 統合は薄い橋渡しに徹する**: `src/react.ts` は `useSyncExternalStore` を呼ぶだけの 37 行のファイルであり、独自の状態管理ロジックを一切持たない。React の Concurrent Mode やサーバーサイドレンダリングへの対応は React 自身の API (`useSyncExternalStore` の第 3 引数 `getServerSnapshot`) に委譲している。根拠: `src/react.ts:30-34`。

## 実例と分析

### レイヤー分離とエントリーポイント戦略

zustand のソースは明確な 3 層構造を持つ:

1. **Vanilla 層** (`src/vanilla.ts`): `createStore` — `StoreApi<T>` を返す。React 不要。
2. **React 層** (`src/react.ts`): `create` — 内部で `createStore` を呼び、`useSyncExternalStore` でフックに変換。`UseBoundStore<S>` を返す。
3. **Middleware 層** (`src/middleware/*.ts`): `StateCreator -> StateCreator` の変換子。層に依存しない。

`src/index.ts` は `vanilla.ts` と `react.ts` の両方を re-export する。ビルド時には `rollup.config.mjs` で各エントリーポイントを個別バンドルに分割し、`package.json` の `exports` フィールドで `"zustand"`, `"zustand/vanilla"`, `"zustand/middleware"`, `"zustand/shallow"` 等を独立したサブパスとして公開している。これにより、React を使わないプロジェクトは `zustand/vanilla` だけを import でき、React 依存が tree-shake される。

### ミドルウェア合成の実行時メカニズム

ミドルウェアの実行時合成は「内側から外側へ」関数が呼ばれ、各ミドルウェアが `api` オブジェクトのメソッドを順に上書きする:

```
create<T>()(devtools(persist(immer(initializer))))
```

実行順序:
1. `createStoreImpl` が `api = { setState, getState, getInitialState, subscribe }` を生成
2. `immer` の `StateCreator` が実行され、`store.setState` を immer の `produce` でラップ
3. `persist` の `StateCreator` が実行され、`api.setState` をストレージ書き込み付きでラップ
4. `devtools` の `StateCreator` が実行され、`api.setState` を Redux DevTools 送信付きでラップ

各ミドルウェアは `set` (ローカル引数) と `api.setState` の両方が渡されるが、monkey-patch は `api.setState` に対して行われる。`set` は `createStoreImpl` が生成したオリジナルの `setState` を指し、ミドルウェアが内部的に「生の set」にアクセスする手段として機能する。

### useSyncExternalStore による React 統合

`src/react.ts` での React 統合は 3 つの引数を `useSyncExternalStore` に渡す最小構成:

- `subscribe`: `api.subscribe` をそのまま渡す
- `getSnapshot`: `useCallback(() => selector(api.getState()), [api, selector])` でメモ化
- `getServerSnapshot`: `useCallback(() => selector(api.getInitialState()), [api, selector])` で SSR 対応

`getServerSnapshot` に `getInitialState` を渡すことで、サーバーサイドでは常に初期状態が返され、ハイドレーション不整合を防ぐ。テスト (`tests/ssr.test.tsx`) でハイドレーション中の `setState` がエラーを起こさないことが検証されている。

### カリー化オーバーロードによる型推論の改善

`create` と `createStore` は「引数ありで即実行」「引数なしでカリー化」の 2 つのオーバーロードを持つ:

```typescript
// 型推論が効く（ミドルウェア使用時）
const useStore = create<MyState>()(devtools(persist(...)))

// 型推論が効く（ミドルウェアなし）
const useStore = create<MyState>((set) => ({ ... }))
```

`create<T>()` のように空引数で呼ぶと型パラメータ `T` が明示され、返された関数にミドルウェアを渡すことで `Mos`（出力 mutator リスト）が自動推論される。これは TypeScript が「部分的な型パラメータ推論」をサポートしないことへの回避策であり、`T` を手動指定しつつ `Mos` を推論させる。

## コード例

```typescript
// src/vanilla.ts:60-97 — コアストア実装（クロージャベース、Reactに依存しない）
const createStoreImpl: CreateStoreImpl = (createState) => {
  type TState = ReturnType<typeof createState>
  type Listener = (state: TState, prevState: TState) => void
  let state: TState
  const listeners: Set<Listener> = new Set()

  const setState: StoreApi<TState>['setState'] = (partial, replace) => {
    const nextState =
      typeof partial === 'function'
        ? (partial as (state: TState) => TState)(state)
        : partial
    if (!Object.is(nextState, state)) {
      const previousState = state
      state =
        (replace ?? (typeof nextState !== 'object' || nextState === null))
          ? (nextState as TState)
          : Object.assign({}, state, nextState)
      listeners.forEach((listener) => listener(state, previousState))
    }
  }

  const getState: StoreApi<TState>['getState'] = () => state
  const getInitialState: StoreApi<TState>['getInitialState'] = () => initialState
  const subscribe: StoreApi<TState>['subscribe'] = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const api = { setState, getState, getInitialState, subscribe }
  const initialState = (state = createState(setState, getState, api))
  return api as any
}
```

```typescript
// src/react.ts:27-37 — useSyncExternalStore による最小 React バインディング
export function useStore<TState, StateSlice>(
  api: ReadonlyStoreApi<TState>,
  selector: (state: TState) => StateSlice = identity as any,
) {
  const slice = React.useSyncExternalStore(
    api.subscribe,
    React.useCallback(() => selector(api.getState()), [api, selector]),
    React.useCallback(() => selector(api.getInitialState()), [api, selector]),
  )
  React.useDebugValue(slice)
  return slice
}
```

```typescript
// src/vanilla.ts:20-26 — 再帰型によるミドルウェア型積層
export type Mutate<S, Ms> = number extends Ms['length' & keyof Ms]
  ? S
  : Ms extends []
    ? S
    : Ms extends [[infer Mi, infer Ma], ...infer Mrs]
      ? Mutate<StoreMutators<S, Ma>[Mi & StoreMutatorIdentifier], Mrs>
      : never
```

```typescript
// src/middleware/immer.ts:74-86 — monkey-patch パターンによるミドルウェア実装
const immerImpl: ImmerImpl = (initializer) => (set, get, store) => {
  type T = ReturnType<typeof initializer>

  store.setState = (updater, replace, ...args) => {
    const nextState = (
      typeof updater === 'function' ? produce(updater as any) : updater
    ) as ((s: T) => T) | T | Partial<T>

    return set(nextState, replace as any, ...args)
  }

  return initializer(store.setState, get, store)
}
```

```typescript
// src/middleware/redux.ts:28-31 — declare module による型レジストリ拡張
declare module '../vanilla' {
  interface StoreMutators<S, A> {
    'zustand/redux': WithRedux<S, A>
  }
}
```

## パターンカタログ

- **Decorator パターン** (分類: 構造)
  - 解決する問題: ストア API に追加の振る舞い（永続化、DevTools 連携、Immer 統合等）を動的に付加したい
  - 適用条件: コアインターフェース (`StoreApi`) が安定しており、拡張が直交的に組み合わせ可能な場合
  - コード例: `src/middleware/persist.ts:229-234` で `api.setState` をストレージ書き込み付きで上書き
  - 注意点: 古典的な Decorator はラッパーオブジェクトを生成するが、zustand は同一オブジェクトの monkey-patch で実現している。これにより参照の一貫性が保たれ、`useSyncExternalStore` に渡す `api.subscribe` が常に同一参照になる

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: 状態変更をリスナーに通知する
  - 適用条件: 1 対多の通知が必要で、リスナーの登録・解除が動的に行われる場合
  - コード例: `src/vanilla.ts:64,79,88-92` — `Set<Listener>` による subscribe/unsubscribe
  - 注意点: `Set` を使うことで O(1) の追加・削除と重複排除を同時に実現している

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 状態の同値比較ロジックを差し替えたい（`Object.is` / `shallow` / カスタム）
  - 適用条件: 比較ロジックが利用側によって異なる場合
  - コード例: `src/traditional.ts:36` — `useSyncExternalStoreWithSelector` に `equalityFn` を注入
  - 注意点: デフォルトの `useStore`（`src/react.ts`）は `Object.is`（React のデフォルト）を使い、`useStoreWithEqualityFn` で Strategy を挿入可能にする 2 段構成

## Good Patterns

- **最小インターフェースで統合ポイントを定義する**: `StoreApi<T>` は `setState`, `getState`, `getInitialState`, `subscribe` の 4 メソッドのみ。`useSyncExternalStore` が要求する `subscribe` と `getSnapshot` に直接マッピングできるため、React 統合が 7 行で完結する。

```typescript
// src/react.ts:12-14 — React 側が要求する最小インターフェース
type ReadonlyStoreApi<T> = Pick<
  StoreApi<T>,
  'getState' | 'getInitialState' | 'subscribe'
>
```

- **`Set<Listener>` による軽量 pub/sub**: `Map` や配列ではなく `Set` を使うことで、リスナーの追加 O(1)・削除 O(1)・重複防止を組み込み関数だけで実現。unsubscribe は `Set.delete` を返すだけのワンライナー。

```typescript
// src/vanilla.ts:88-92
const subscribe: StoreApi<TState>['subscribe'] = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
```

- **`Object.is` によるスキップ付き setState**: 状態が変わらなければリスナーを呼ばない。`NaN === NaN` 問題も `Object.is` で正しく処理される（テスト: `tests/vanilla/basic.test.ts:99-107`）。

```typescript
// src/vanilla.ts:73
if (!Object.is(nextState, state)) {
```

- **declare module による開放型レジストリ**: 各ミドルウェアが `StoreMutators` インターフェースを `declare module` で拡張することで、新しいミドルウェアを追加しても既存コードの変更が不要。サードパーティが独自ミドルウェアを型安全に追加できる。

```typescript
// src/middleware/redux.ts:28-31
declare module '../vanilla' {
  interface StoreMutators<S, A> {
    'zustand/redux': WithRedux<S, A>
  }
}
```

## Anti-Patterns / 注意点

- **ミドルウェア内で `set` と `api.setState` を混同する**: ミドルウェアは `(set, get, api) => ...` の 3 引数を受け取るが、`set` は上位ミドルウェアが差し替え済みの関数であり、`api.setState` は直前の monkey-patch 結果を指す。間違って `api.setState` を直接呼ぶと、自分自身の patch をバイパスしたり無限ループを起こしたりする。

```typescript
// Bad: ミドルウェア内で api.setState を直接呼び、自身の patch をバイパス
const badMiddleware = (fn) => (set, get, api) => {
  api.setState = (state) => {
    api.setState(state) // 無限再帰
  }
  return fn(set, get, api)
}

// Better: 保存した元の関数を呼ぶ
const goodMiddleware = (fn) => (set, get, api) => {
  const originalSetState = api.setState
  api.setState = (state, replace) => {
    // 追加処理
    originalSetState(state, replace)
  }
  return fn(api.setState, get, api)
}
```

- **useSyncExternalStore に渡す selector をインラインで書き毎 render 新規生成する**: `useStore` の `useCallback` は `selector` 参照が変わると再生成される。毎 render でインライン関数を渡すと `useSyncExternalStoreWithSelector` なしでは不要な再計算が走る。zustand v5 のデフォルト `useStore` は `useCallback` で `getSnapshot` をメモ化しているが、selector 自体が毎 render 新規だとメモ化が無効になる。

```typescript
// Bad: 毎 render で新しい selector 参照
function Component() {
  const count = useStore(store, (s) => s.count) // 毎回新しい関数
  return <div>{count}</div>
}

// Better: selector をコンポーネント外またはメモ化して定義
const selectCount = (s: State) => s.count
function Component() {
  const count = useStore(store, selectCount)
  return <div>{count}</div>
}
```

- **ミドルウェアの積層順序を誤る**: 型レベルでは `Mutate<S, Ms>` が左から右へ適用されるが、実行時は内側（最後に書いたミドルウェア）から外側へ実行される。`devtools(persist(immer(...)))` では `immer` が最初に `api.setState` を上書きし、次に `persist`、最後に `devtools` が上書きする。`devtools` を最内側に書くと、`persist` や `immer` の変更が DevTools に記録されない。

```typescript
// Bad: devtools が最内側 — persist の状態変更が DevTools に送信されない
create()(persist(devtools(immer(initializer)), { name: 'store' }))

// Better: devtools を最外側に配置
create()(devtools(persist(immer(initializer), { name: 'store' })))
```

## 導出ルール

- `[MUST]` フレームワーク非依存のコアロジックを純粋な vanilla モジュールに分離し、フレームワークバインディングは薄いアダプタ層として別モジュールにする
  - 根拠: zustand は `src/vanilla.ts`（101 行）にコアを、`src/react.ts`（37 行）にアダプタを置くことで、React なし環境でも利用可能にし、バインディング層のコード量を最小化している

- `[MUST]` 外部ストアを React に統合する場合、`useSyncExternalStore` を使い、`getServerSnapshot` 引数で SSR 時の初期値を明示的に返す
  - 根拠: zustand は `api.getInitialState()` を `getServerSnapshot` に渡すことでハイドレーション不整合を防いでおり、`tests/ssr.test.tsx` でハイドレーション中の `setState` がエラーを起こさないことを検証している

- `[SHOULD]` プラグイン/ミドルウェアシステムを設計する際、`declare module` + 空インターフェースによる開放型レジストリと再帰型で型合成を追跡する
  - 根拠: zustand の `StoreMutators<S, A>` は空インターフェースとして宣言され、各ミドルウェアが `declare module` で拡張する。`Mutate<S, Ms>` 再帰型がミドルウェアリストを左から順に型変換し、4 つのミドルウェアを積んでも型が正しく推論される (`tests/middlewareTypes.test.tsx:614-652`)

- `[SHOULD]` 高階関数による拡張で既存オブジェクトを monkey-patch する場合、patch 前の元関数を保存してから上書きし、元関数を内部で呼び出す
  - 根拠: `src/middleware/persist.ts:229-233` は `const savedSetState = api.setState` で保存後に上書きし、`src/middleware/devtools.ts:258-263` は `isRecording` フラグで元関数呼び出しを制御している

- `[SHOULD]` TypeScript で部分的な型パラメータ推論が必要な場合、「引数なしで型パラメータを固定、返された関数で残りを推論」のカリー化オーバーロードを使う
  - 根拠: `src/vanilla.ts:43-51` の `CreateStore` 型と `src/react.ts:44-51` の `Create` 型が、`create<T>()` で `T` を固定しつつ `Mos` を推論させるパターンを実現している

- `[SHOULD]` pub/sub の listener コレクションには `Set` を使い、unsubscribe は `Set.delete` を返す
  - 根拠: `src/vanilla.ts:64,88-92` — `Set` は O(1) の追加・削除・重複防止を提供し、unsubscribe 関数がワンライナーで表現できる

- `[AVOID]` ライブラリ公開時に単一エントリーポイントからフレームワーク依存・非依存コードを混在 export すること（サブパス exports で分離する）
  - 根拠: zustand は `package.json` の `exports` で `"."`, `"./*"` のサブパスを定義し、`zustand/vanilla` は React を含まないバンドルとして独立している。`rollup.config.mjs` で 9 つの個別ビルドを生成してツリーシェイク可能にしている

## 適用チェックリスト

- [ ] 状態管理ライブラリを設計する場合、コアストアをフレームワーク非依存モジュールに分離しているか
- [ ] React バインディングは `useSyncExternalStore` を使い、`getServerSnapshot` で SSR 初期値を返しているか
- [ ] ミドルウェア/プラグインシステムで API を拡張する場合、`declare module` + 空インターフェースの開放型レジストリを検討したか
- [ ] ミドルウェアの monkey-patch は元関数を保存してから上書きし、内部で元関数を呼び出しているか
- [ ] TypeScript の部分的型推論が必要な場面でカリー化オーバーロードを検討したか
- [ ] pub/sub パターンで `Set<Listener>` を使い、unsubscribe を `delete` のクロージャで返しているか
- [ ] `package.json` の `exports` フィールドでサブパスを定義し、フレームワーク依存コードを分離しているか
- [ ] 状態比較に `Object.is` を使い、`NaN` や `-0` のエッジケースを正しく処理しているか
