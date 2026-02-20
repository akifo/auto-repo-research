# API Design Practices

> リポジトリ: pmndrs/zustand
> 分析日: 2026-02-20

## 概要

zustand の公開 API は、TypeScript の型推論限界を正面から受け止めたうえで、カリー化オーバーロード・selector パターン・equality function の3層で構成されている。47 ファイルの小規模コードベースながら、「型安全とミニマリズムを両立する API 設計」の教科書的実装が凝縮されており、特にジェネリクスの不変性（invariance）問題に対するカリー化ワークアラウンドと、フレームワーク層（React）とコア層（vanilla）の分離設計は、ライブラリ API 設計全般に応用可能なプラクティスである。

## 背景にある原則

- **型推論の壁を API 形状で迂回する**: TypeScript はジェネリクスが不変（invariant）の場合に推論できない。zustand は `create<T>()((set) => ...)` というカリー化で「ユーザーが指定すべき型」と「推論に任せる型」を分離する。これは TypeScript#10571 に対する意図的なワークアラウンドであり、ランタイムコストゼロで型安全を実現している（`src/react.ts:63-64`, `docs/guides/advanced-typescript.md`）。

- **デフォルトの正しさを最大化する**: 変更検知に `Object.is` をデフォルト採用し、`shallow` や `equalityFn` は明示的なオプトインとする。ユーザーが何も指定しなくても正しく動作し、パフォーマンス最適化は段階的に導入できる設計（`src/vanilla.ts:73`, `src/react.ts:30-31`）。

- **フレームワーク非依存コアを先に設計する**: `src/vanilla.ts` がフレームワーク非依存の純粋なストア実装で、`src/react.ts` がそれを React フックとしてラップする。これにより、同じコアを異なるフレームワーク（SolidJS 等）で再利用可能にしている（`src/index.ts:1-2`）。

- **ミドルウェアは store API の型を拡張するものとして設計する**: `StoreMutators` インターフェースの declaration merging により、ミドルウェアが store の型を宣言的に変更できる。型レベルの合成可能性を実現する先進的な TypeScript パターン（`src/vanilla.ts:40`, 各 middleware の `declare module`）。

## 実例と分析

### カリー化オーバーロードによる型推論の制御

zustand の `create` と `createStore` は、2つのシグネチャをオーバーロードで提供する。

1. **直接呼び出し**: `create(initializer)` — 型を推論できる場合（combine middleware 使用時など）
2. **カリー化呼び出し**: `create<T>()(initializer)` — ユーザーが状態型を明示指定する場合

この設計は TypeScript の「部分的な型パラメータ推論」が不可能であるという制約に対する解決策である。`create<T, Mos>` のように全パラメータを手動指定させる代わりに、1回目の呼び出しで `T` のみ指定し、2回目で残りを推論させる。

`Create` 型の定義が明快にこの2パスを示している。

```ts
// src/react.ts:44-51
type Create = {
  <T, Mos extends [StoreMutatorIdentifier, unknown][] = []>(
    initializer: StateCreator<T, [], Mos>,
  ): UseBoundStore<Mutate<StoreApi<T>, Mos>>
  <T>(): <Mos extends [StoreMutatorIdentifier, unknown][] = []>(
    initializer: StateCreator<T, [], Mos>,
  ) => UseBoundStore<Mutate<StoreApi<T>, Mos>>
}
```

実装は三項演算子1行で両パスを処理する。

```ts
// src/react.ts:63-64
export const create = (<T>(createState: StateCreator<T, [], []> | undefined) =>
  createState ? createImpl(createState) : createImpl) as Create
```

`createStore`（vanilla 版）もまったく同じパターンを踏襲している。

```ts
// src/vanilla.ts:99-100
export const createStore = ((createState) =>
  createState ? createStoreImpl(createState) : createStoreImpl) as CreateStore
```

### UseBoundStore: callable + store API の統合型

`create` の戻り値 `UseBoundStore<S>` は、React フック（callable）と store API のインターセクション型である。

```ts
// src/react.ts:39-42
export type UseBoundStore<S extends ReadonlyStoreApi<unknown>> = {
  (): ExtractState<S>
  <U>(selector: (state: ExtractState<S>) => U): U
} & S
```

これにより `useBoundStore()` でフックとして呼び出しつつ、`useBoundStore.getState()` で直接 API アクセスもできる。実装は `Object.assign(useBoundStore, api)` で関数オブジェクトに store API をマージしている（`src/react.ts:58`）。

### selector パターンの段階的強化

zustand は selector の使い方を4段階で提供し、ユーザーが必要に応じてオプトインする設計になっている。

**レベル1: セレクタなし** — 全状態を返す（`useBoundStore()` → `ExtractState<S>`）。最もシンプルだが再レンダリングが最も多い。

**レベル2: 基本セレクタ** — スライスを選択（`useBoundStore(s => s.count)` → `number`）。`Object.is` で比較し、変更がなければ再レンダリングしない。

**レベル3: useShallow ラッパー** — shallow 比較でオブジェクト/配列の無駄な再レンダリングを防止（`useBoundStore(useShallow(s => ({ a: s.a, b: s.b })))`）。

**レベル4: カスタム equality 関数** — `createWithEqualityFn` + 独自比較関数で完全な制御。

この段階的設計は、`useStore` の内部実装に `identity` 関数をデフォルトセレクタとして使うことで実現されている。

```ts
// src/react.ts:16
const identity = <T>(arg: T): T => arg
```

### equality 関数設計の3層

**Object.is（デフォルト）**: `setState` 内部で `!Object.is(nextState, state)` をチェックし、同一参照なら通知しない（`src/vanilla.ts:73`）。NaN の適切な処理も含む。

**shallow**: `src/vanilla/shallow.ts` で実装。プロトタイプチェーン比較、Iterable/Map/Set 対応、plain object の entries 比較と、3段階の分岐でカバー範囲を広げている。

**カスタム equalityFn**: `useStoreWithEqualityFn`（`src/traditional.ts`）で、`useSyncExternalStoreWithSelector` の第5引数として渡す。subscribe 側では `subscribeWithSelector` middleware で `options.equalityFn` として注入。

### ミドルウェアの型拡張メカニズム（StoreMutators パターン）

各ミドルウェアは `declare module '../vanilla'` で `StoreMutators` インターフェースを拡張する。

```ts
// src/middleware/subscribeWithSelector.ts:21-26
declare module '../vanilla' {
  interface StoreMutators<S, A> {
    ['zustand/subscribeWithSelector']: WithSelectorSubscribe<S>
  }
}
```

`Mutate<S, Ms>` 型が再帰的にミドルウェアのタプルを処理し、各ミドルウェアが `StoreMutators` から対応する型変換を取得して store 型を変形する。

```ts
// src/vanilla.ts:20-26
export type Mutate<S, Ms> = number extends Ms['length' & keyof Ms]
  ? S
  : Ms extends []
    ? S
    : Ms extends [[infer Mi, infer Ma], ...infer Mrs]
      ? Mutate<StoreMutators<S, Ma>[Mi & StoreMutatorIdentifier], Mrs>
      : never
```

実装面では、各ミドルウェアが「公開型」と「実装型」を分離するパターンを一貫して使用する。

```ts
// src/middleware/redux.ts:34-37, 50
type ReduxImpl = <T, A extends Action>(
  reducer: (state: T, action: A) => T,
  initialState: T,
) => StateCreator<T & ReduxState<A>, [], []>
// ...
export const redux = reduxImpl as unknown as Redux
```

`as unknown as` のキャストは TypeScript の型システムの限界を補うためのもので、全ミドルウェアで統一的に使われている。

## コード例

setState の shallow merge と replace のスマートデフォルト。

```ts
// src/vanilla.ts:66-81
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
```

useShallow の参照安定化。

```ts
// src/react/shallow.ts:4-12
export function useShallow<S, U>(selector: (state: S) => U): (state: S) => U {
  const prev = React.useRef<U>(undefined)
  return (state) => {
    const next = selector(state)
    return shallow(prev.current, next)
      ? (prev.current as U)
      : (prev.current = next)
  }
}
```

subscribe が unsubscribe 関数を返すパターン。

```ts
// src/vanilla.ts:88-92
const subscribe: StoreApi<TState>['subscribe'] = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
```

## パターンカタログ

- **Curried Factory (生成)**
  - 解決する問題: TypeScript で部分的な型パラメータ指定ができない
  - 適用条件: ジェネリクスが不変（invariant）で推論が失敗する場合
  - コード例: `src/react.ts:44-51`, `src/vanilla.ts:43-51`
  - 注意点: ランタイムコストはゼロだがユーザーに `()()` の記法を要求する

- **Strategy Pattern — equality function (振る舞い)**
  - 解決する問題: 変更検知のアルゴリズムをユースケースごとに差し替えたい
  - 適用条件: デフォルト（`Object.is`）では不十分なケース（オブジェクト/配列の shallow 比較等）
  - コード例: `src/traditional.ts:34`, `src/vanilla/shallow.ts:48`
  - 注意点: デフォルトが最も安全で、カスタムは段階的に導入すべき

- **Decorator Pattern — middleware (構造)**
  - 解決する問題: ストアの振る舞い（永続化、DevTools 連携等）を合成的に追加したい
  - 適用条件: コアのストア API を変更せずに機能拡張する場合
  - コード例: `src/middleware/persist.ts:187`, `src/middleware/devtools.ts:187-189`
  - 注意点: ミドルウェアの適用順序が型に影響する（devtools は最後に）

- **Module Augmentation — StoreMutators (構造)**
  - 解決する問題: ミドルウェアが store の型を宣言的に拡張する必要がある
  - 適用条件: ライブラリのプラグインシステムで型安全を維持したい場合
  - コード例: `src/vanilla.ts:40`, `src/middleware/persist.ts:393-396`
  - 注意点: declaration merging は TypeScript 固有の機能で、他言語への移植が困難

## Good Patterns

- **Smart Default の段階的オーバーライド**: `setState` は `replace` を省略すると「オブジェクトなら shallow merge、プリミティブなら replace」と自動判定する（`src/vanilla.ts:76`）。ユーザーは明示的に `replace: true` を指定して挙動を変更できる。API の「正しいデフォルト」と「エスケープハッチ」のバランスが優れている。

```ts
// src/vanilla.ts:75-78
state =
  (replace ?? (typeof nextState !== 'object' || nextState === null))
    ? (nextState as TState)
    : Object.assign({}, state, nextState)
```

- **ReadonlyStoreApi で消費者向け API を制限**: `useStore` の引数は `ReadonlyStoreApi<T>`（`getState`, `getInitialState`, `subscribe` のみ）に制限されており、消費側から `setState` を呼べない。store 生成側と消費側で異なるインターフェースを提供する設計。

```ts
// src/react.ts:11-14
type ReadonlyStoreApi<T> = Pick<
  StoreApi<T>,
  'getState' | 'getInitialState' | 'subscribe'
>
```

- **unsubscribe 関数を返す subscribe**: `subscribe` が cleanup 関数を返すパターンは React の `useEffect` と相性が良く、`useSyncExternalStore` の第1引数としてもそのまま渡せる。Set ベースのリスナー管理で O(1) の追加/削除を実現。

```ts
// src/vanilla.ts:88-92
const subscribe: StoreApi<TState>['subscribe'] = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
```

## Anti-Patterns / 注意点

- **セレクタなしでの store 全体購読**: `useBoundStore()` はセレクタなしで全状態を返すため、どのプロパティが変更されても再レンダリングが発生する。

```tsx
// Bad: 全プロパティの変更で再レンダリング
const { count, name } = useBoundStore()

// Better: 必要なスライスのみ購読
const count = useBoundStore((s) => s.count)
const name = useBoundStore((s) => s.name)

// Better (複数プロパティ): useShallow でオブジェクト比較
const { count, name } = useBoundStore(useShallow((s) => ({ count: s.count, name: s.name })))
```

- **ミドルウェアの順序を無視した合成**: devtools は `setState` に追加パラメータ（action name）を注入するため、後から適用される immer 等がその型情報を消す可能性がある。ドキュメントで明示的に「devtools は最後に」と指定されている（`docs/guides/advanced-typescript.md:226`）。

```ts
// Bad: devtools の型情報が immer に上書きされる
create(immer(devtools((set) => ({ ... }))))

// Better: devtools を最外層に
create(devtools(immer((set) => ({ ... }))))
```

- **create 内での get() の同期呼び出し**: 初期化関数内で `get()` を同期的に呼ぶと `undefined` が返る。型上は `() => T` だが、初期化完了前は未定義。これは型の「嘘」として公式ドキュメントで acknowledged されている（`docs/guides/advanced-typescript.md:70-81`）。

```ts
// Bad: 初期化時に get() は undefined を返す
const store = create<State>()((_, get) => ({
  foo: get().foo, // TypeError: Cannot read properties of undefined
}))

// Better: get() は非同期コールバック内でのみ使用
const store = create<State>()((set, get) => ({
  foo: 0,
  doSomething: () => set({ foo: get().foo + 1 }),
}))
```

## 導出ルール

- `[MUST]` TypeScript のジェネリクスが不変（invariant）で推論不能な場合、カリー化オーバーロードで「ユーザー指定型」と「推論型」を分離する
  - 根拠: zustand の `create<T>()(initializer)` は TypeScript#10571 の制約を回避するために設計された。ランタイムコストゼロで型安全を達成するベストプラクティスである（`src/react.ts:44-51`）

- `[MUST]` subscribe API は cleanup 関数（unsubscribe）を戻り値として返す
  - 根拠: `subscribe(() => ...) => () => void` のパターンは React の `useEffect` や `useSyncExternalStore` と直接互換し、リソースリークを防ぐ標準的な契約である（`src/vanilla.ts:88-92`）

- `[SHOULD]` ライブラリの状態変更検知はデフォルトで `Object.is` を使い、shallow/custom equality はオプトインで提供する
  - 根拠: zustand は `Object.is` → `shallow` → `equalityFn` の3段階で等価比較を提供し、デフォルトの正しさを最大化しつつ段階的な最適化を可能にしている（`src/vanilla.ts:73`, `src/react/shallow.ts`）

- `[SHOULD]` フレームワーク非依存のコア（vanilla）を先に設計し、フレームワーク固有のバインディング（React hooks 等）は薄いラッパーとして分離する
  - 根拠: zustand は `src/vanilla.ts`（40行の純粋なストア）と `src/react.ts`（30行の React ラッパー）を分離し、同じコアを異なる環境で再利用可能にしている

- `[SHOULD]` ミドルウェア/プラグインの型安全を declaration merging（module augmentation）で実現する
  - 根拠: `StoreMutators` インターフェースの拡張により、各ミドルウェアが store 型を宣言的に変形でき、合成時の型安全を維持している（`src/vanilla.ts:40`, 各 middleware の `declare module`）

- `[SHOULD]` API の戻り値を callable + properties のインターセクション型にすることで、関数としての呼び出しとメソッドアクセスを同時に提供する
  - 根拠: `UseBoundStore` は `() => T` と `StoreApi` の交差型で、`useStore()` と `useStore.getState()` の両方を1つのオブジェクトで実現している（`src/react.ts:39-42`）

- `[AVOID]` ライブラリ利用者に型パラメータの全指定を強制する API 設計
  - 根拠: zustand は `create<T, Mos>` のような全パラメータ指定を避け、カリー化で必要最小限の型指定にとどめている。全指定は型アサーションとして機能し、型安全を損なう可能性がある（`docs/guides/advanced-typescript.md:389-411`）

## 適用チェックリスト

- [ ] ライブラリの factory 関数でジェネリクスが不変になっていないか確認し、推論が失敗する場合はカリー化オーバーロードを検討する
- [ ] subscribe/observe 系の API が cleanup 関数を返しているか確認する（コールバック登録解除の責任を呼び出し元に委譲）
- [ ] 変更検知のデフォルトが `Object.is` であることを確認し、shallow 比較やカスタム比較はオプトインにする
- [ ] コアロジックがフレームワーク非依存で実装されているか確認する（React/Vue 等の固有 API がコアに漏れていないか）
- [ ] プラグイン/ミドルウェアの型拡張に declaration merging を使えるか検討する（拡張ポイントを空インターフェースとして公開）
- [ ] API の戻り値が「関数としても使え、プロパティもアクセスできる」設計が適切かどうか評価する
