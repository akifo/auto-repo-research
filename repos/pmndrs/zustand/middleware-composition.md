# middleware-composition

> リポジトリ: pmndrs/zustand
> 分析日: 2026-02-20

## 概要

zustand のミドルウェアシステムは、`StateCreator` を受け取り `StateCreator` を返す高階関数の合成パターンで構成されている。各ミドルウェアは `(config, options?) => (set, get, api) => result` という統一シグネチャを持ち、`api.setState` や `api.subscribe` をラップすることで振る舞いを注入する。TypeScript の declaration merging と再帰的な `Mutate` 型により、任意の順序・数のミドルウェアを積み重ねても型安全性が保たれる設計は、高階関数ベースの拡張システムの参考実装として非常に価値が高い。

## 背景にある原則

- **API 面のラップによる非侵入的拡張**: ミドルウェアはストアの内部状態を直接変更せず、`api.setState` / `api.subscribe` 等の公開インターフェースをラップすることで振る舞いを追加する。これにより、各ミドルウェアは互いの内部実装に依存せず、合成順序を変えても正しく動作する。（根拠: `src/middleware/persist.ts:229-234`、`src/middleware/devtools.ts:216-245`、`src/middleware/immer.ts:77-83` すべてが `api.setState` を再代入するパターンを採用）

- **実装型と公開型の分離による段階的型安全**: 各ミドルウェアは内部実装を簡素な `XxxImpl` 型（ジェネリクスなし）で記述し、公開 API は複雑な `Xxx` 型（`Mps`/`Mcs` ジェネリクスを含む）で宣言する。両者は `as unknown as` でブリッジされる。これにより、実装コードでは型の複雑さを回避しつつ、利用者側では完全な型推論を提供する。（根拠: 全ミドルウェアが `export const xxx = xxxImpl as unknown as Xxx` パターンを採用）

- **インターフェース拡張による型レベルのプラグインシステム**: TypeScript の `declare module` + `interface StoreMutators<S, A>` を用いて、各ミドルウェアが自身の型変換ルールを宣言する。中央のコードを一切変更せずに型の拡張点を追加できるため、サードパーティミドルウェアも同等の型安全性を享受できる。（根拠: `src/vanilla.ts:40` の空インターフェース宣言と、各ミドルウェアの `declare module '../vanilla'` ブロック）

- **グレースフルデグラデーション**: 外部依存（DevTools 拡張、ストレージ API）が利用できない場合、ミドルウェアは自身をバイパスして元の `config` をそのまま実行する。ミドルウェアの追加がランタイムエラーの原因にならないよう設計されている。（根拠: `devtools.ts:208-209` の `if (!extensionConnector) return fn(set, get, api)`、`persist.ts:208-218` の `if (!storage) return config(...)`)

## 実例と分析

### api オブジェクトの段階的変形

zustand のミドルウェアは、ストアの `api` オブジェクトが持つメソッドを段階的にラップ・拡張する。各ミドルウェアは `(set, get, api)` を受け取った時点で `api.setState` を自身のラッパーに差し替え、その後で内側の `config` を呼び出す。外側のミドルウェアが先に `api.setState` をラップし、内側が後にラップするため、結果として内側から外側の順にラッパーが実行される（関数合成のスタック構造）。

persist ミドルウェアは `api.setState` をラップしてストレージへの永続化を注入する。devtools は `api.setState` をラップして Redux DevTools へのアクション送信を注入する。immer は `api.setState` をラップして Immer の `produce` を updater に適用する。subscribeWithSelector は `api.subscribe` をラップしてセレクタベースの購読を可能にする。

この「api のメソッドを差し替える」手法は、Proxy パターンの明示的実装であり、各ミドルウェアが同じインターフェースの同じメソッドを順次ラップできる。

### ミドルウェアの型パイプライン

`StateCreator<T, Mis, Mos, U>` の 4 つの型パラメータが合成の鍵となる。`Mis`（input mutators）は「内側で適用済みのミドルウェアが api に加えた変更」を表し、`Mos`（output mutators）は「自分自身が api に加える変更」を表す。

例えば `devtools(persist(immer(fn)))` の場合:

- `immer` は `Mos = [['zustand/immer', never]]` を宣言
- `persist` は `Mis` に `['zustand/immer', never]` を含む config を受け取り、`Mos = [['zustand/persist', U]]` を追加
- `devtools` は `Mis` に persist + immer の両方を含む config を受け取り、`Mos = [['zustand/devtools', never]]` を追加

最終的に `Mutate<StoreApi<T>, [devtools, persist, immer]>` がストアの型となり、`.persist.hasHydrated()` や `.setState(state, replace, actionName)` 等の拡張メソッドが型レベルで利用可能になる。

### 再帰的型変換 Mutate

`Mutate<S, Ms>` 型は mutator リストを再帰的に適用する型レベルの fold 演算として機能する。

```
Mutate<S, [[Mi, Ma], ...Mrs]>
  = Mutate<StoreMutators<S, Ma>[Mi], Mrs>
```

この再帰により、ミドルウェアの適用順序がそのまま型の変換順序にマッピングされる。空の `interface StoreMutators<S, A> {}` を declaration merging で拡張する設計のため、新しいミドルウェアの追加がコアの型定義に一切影響しない。

### 保存-復元パターンによるラッピング

ミドルウェアは `api.setState` をラップする際、元の関数を局所変数に保存してから差し替える。これは save-and-restore パターンであり、ラップ前後の関数チェーンが明確に保持される。

## コード例

```typescript
// src/vanilla.ts:20-26 — 再帰的 Mutate 型（型レベル fold）
export type Mutate<S, Ms> = number extends Ms["length" & keyof Ms] ? S
  : Ms extends [] ? S
  : Ms extends [[infer Mi, infer Ma], ...infer Mrs] ? Mutate<StoreMutators<S, Ma>[Mi & StoreMutatorIdentifier], Mrs>
  : never;
```

```typescript
// src/vanilla.ts:28-37 — StateCreator: ミドルウェアの入出力型を表現する中核型
export type StateCreator<
  T,
  Mis extends [StoreMutatorIdentifier, unknown][] = [],
  Mos extends [StoreMutatorIdentifier, unknown][] = [],
  U = T,
> =
  & ((
    setState: Get<Mutate<StoreApi<T>, Mis>, "setState", never>,
    getState: Get<Mutate<StoreApi<T>, Mis>, "getState", never>,
    store: Mutate<StoreApi<T>, Mis>,
  ) => U)
  & { $$storeMutators?: Mos; };
```

```typescript
// src/middleware/persist.ts:229-234 — api.setState のラップによる永続化注入
const savedSetState = api.setState;

api.setState = (state, replace) => {
  savedSetState(state, replace as any);
  return setItem();
};
```

```typescript
// src/middleware/immer.ts:74-86 — Immer ミドルウェアの実装（api.setState をラップ）
const immerImpl: ImmerImpl = (initializer) => (set, get, store) => {
  type T = ReturnType<typeof initializer>;

  store.setState = (updater, replace, ...args) => {
    const nextState = (
      typeof updater === "function" ? produce(updater as any) : updater
    ) as ((s: T) => T) | T | Partial<T>;

    return set(nextState, replace as any, ...args);
  };

  return initializer(store.setState, get, store);
};
```

```typescript
// src/middleware/devtools.ts:187-209 — グレースフルデグラデーション
const devtoolsImpl: DevtoolsImpl =
  (fn, devtoolsOptions = {}) =>
  (set, get, api) => {
    const { enabled, anonymousActionType, store, ...options } = devtoolsOptions

    let extensionConnector
    try {
      extensionConnector =
        (enabled ?? import.meta.env?.MODE !== 'production') &&
        window.__REDUX_DEVTOOLS_EXTENSION__
    } catch {
      // ignored
    }

    if (!extensionConnector) {
      return fn(set, get, api)
    }
    // ...
```

```typescript
// src/middleware/subscribeWithSelector.ts:46-71 — api.subscribe のラップ
const subscribeWithSelectorImpl: SubscribeWithSelectorImpl = (fn) => (set, get, api) => {
  type S = ReturnType<typeof fn>;
  type Listener = (state: S, previousState: S) => void;
  const origSubscribe = api.subscribe as (listener: Listener) => () => void;
  api.subscribe = ((selector: any, optListener: any, options: any) => {
    let listener: Listener = selector;
    if (optListener) {
      const equalityFn = options?.equalityFn || Object.is;
      let currentSlice = selector(api.getState());
      listener = (state) => {
        const nextSlice = selector(state);
        if (!equalityFn(currentSlice, nextSlice)) {
          const previousSlice = currentSlice;
          optListener(currentSlice = nextSlice, previousSlice);
        }
      };
      if (options?.fireImmediately) {
        optListener(currentSlice, currentSlice);
      }
    }
    return origSubscribe(listener);
  }) as any;
  const initialState = fn(set, get, api);
  return initialState;
};
```

```typescript
// src/middleware/persist.ts:382-407 — 実装型と公開型の分離パターン
type Persist = <
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
  U = T,
>(
  initializer: StateCreator<T, [...Mps, ["zustand/persist", unknown]], Mcs>,
  options: PersistOptions<T, U>,
) => StateCreator<T, Mps, [["zustand/persist", U], ...Mcs]>;

type PersistImpl = <T>(
  storeInitializer: StateCreator<T, [], []>,
  options: PersistOptions<T, T>,
) => StateCreator<T, [], []>;

export const persist = persistImpl as unknown as Persist;
```

## パターンカタログ

- **Decorator パターン** (分類: 構造)
  - 解決する問題: 既存のオブジェクトに対して、サブクラス化せずに動的に振る舞いを追加したい
  - 適用条件: 拡張可能なインターフェース（`StoreApi`）を持つオブジェクトが存在し、複数の独立した機能を組み合わせたい場合
  - コード例: `src/middleware/persist.ts:229-234`（`api.setState` を保存→差し替え）、`src/middleware/subscribeWithSelector.ts:50-68`（`api.subscribe` を保存→差し替え）
  - 注意点: クラスベースではなく関数ベースの Decorator。`api` オブジェクトのメソッドを直接差し替える mutable な手法であり、各ミドルウェアの適用順序がラップの深さ（呼び出し順序）に影響する

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 複数のハンドラを順番に適用し、各ハンドラが処理を追加したりスキップしたりしたい
  - 適用条件: 処理の連鎖を柔軟に構成したい場合。zustand では `devtools(persist(immer(fn)))` のネストがチェーンに相当する
  - コード例: `tests/middlewareTypes.test.tsx:614-652`（4 重ミドルウェアの合成テスト）
  - 注意点: zustand のチェーンは「リクエストを転送する」のではなく「内側の関数をラップする」形式。各段がスキップ（`if (!extensionConnector) return fn(set, get, api)`）も可能

## Good Patterns

- **統一ミドルウェアシグネチャ**: すべてのミドルウェアが `(config, options?) => (set, get, api) => result` という同一のシグネチャに従う。これにより、ミドルウェア同士の組み合わせが自由であり、利用者は合成順序だけを気にすればよい。

```typescript
// src/middleware/immer.ts:74 — 最もシンプルなミドルウェア
const immerImpl: ImmerImpl = (initializer) => (set, get, store) => {
  store.setState = (updater, replace, ...args) => {
    const nextState = (
      typeof updater === "function" ? produce(updater as any) : updater
    ) as ((s: T) => T) | T | Partial<T>;
    return set(nextState, replace as any, ...args);
  };
  return initializer(store.setState, get, store);
};
```

- **Declaration Merging による型拡張ポイント**: 空の `interface StoreMutators<S, A> {}` を宣言し、各ミドルウェアが `declare module` で自身の変換ルールを追加する。コア側のコード変更なしにサードパーティ拡張が型安全に動作する。

```typescript
// src/vanilla.ts:40 — 空インターフェース（拡張ポイント）
export interface StoreMutators<S, A> {}

// src/middleware/persist.ts:392-396 — 拡張
declare module "../vanilla" {
  interface StoreMutators<S, A> {
    "zustand/persist": WithPersist<S, A>;
  }
}
```

- **競合状態の防止（hydration version counter）**: persist ミドルウェアは `hydrationVersion` カウンタを使い、複数の `rehydrate()` 呼び出しが同時に走った場合に古い結果を破棄する。非同期処理で共有状態を更新する際のレースコンディション防止パターンとして優れている。

```typescript
// src/middleware/persist.ts:201-203, 297-299
let hydrationVersion = 0;
// ...
const currentVersion = ++hydrationVersion;
// ...
if (currentVersion !== hydrationVersion) {
  return; // 古い hydration を破棄
}
```

## Anti-Patterns / 注意点

- **api メソッドの直接差し替えによる順序依存**: `api.setState = newFn` による mutable なラップは、ミドルウェアの適用順序によって最終的な振る舞いが変わる。外側のミドルウェアほど「最後にラップされる」ため実行順が逆転する。

```typescript
// Bad: 順序を誤ると persist が devtools のラッパーを上書きする
create(persist(devtools(fn), opts));
// devtools の setState ラップが persist に上書きされ、DevTools に送信されない

// Better: 外側に置くべきミドルウェアを正しく外側にする
create(devtools(persist(fn), opts));
// devtools が最外でラップするため、persist 経由の setState も DevTools に送信される
```

- **`as unknown as` による型安全性の隙間**: 実装型と公開型のブリッジに `as unknown as` を使うため、実装側で型の不整合があってもコンパイルエラーにならない。これはミドルウェアの型が複雑すぎるための実用的妥協だが、内部実装を変更した際に型の不整合が静かに発生するリスクがある。

```typescript
// Bad: 実装を変更しても型エラーが出ない
const persistImpl: PersistImpl = (config, baseOptions) => (set, get, api) => {
  // 実装が公開型と合わなくても通る
};
export const persist = persistImpl as unknown as Persist;

// Better: テストで型レベルの整合性を検証する（zustand は middlewareTypes.test.tsx でこれを実施）
```

## 導出ルール

- `[MUST]` ミドルウェア / プラグインシステムを設計する際は、すべてのミドルウェアが同一のシグネチャ（入力型と出力型の変換関数）に従うよう統一する
  - 根拠: zustand の全 7 ミドルウェアが `(config, options?) => (set, get, api) => result` を遵守しており、これにより任意の組み合わせ・順序での合成が可能になっている

- `[MUST]` 外部依存（ブラウザ API、DevTools、ストレージ等）に依存するミドルウェアは、依存が利用不可の場合に元の処理をそのまま返すフォールバックパスを必ず用意する
  - 根拠: devtools は `if (!extensionConnector) return fn(set, get, api)`、persist は `if (!storage) return config(...)` で、環境に関わらずアプリケーションが動作する（`src/middleware/devtools.ts:208-209`、`src/middleware/persist.ts:208-218`）

- `[SHOULD]` 型が複雑になるミドルウェアでは、内部実装用の簡素な型（`XxxImpl`）と公開 API 用の厳密な型（`Xxx`）を分離し、テストで型レベルの整合性を検証する
  - 根拠: zustand は全ミドルウェアで `XxxImpl` / `Xxx` の二重型定義 + `as unknown as` ブリッジを採用し、`tests/middlewareTypes.test.tsx` で 1〜4 重の合成パターンを型テストしている

- `[SHOULD]` オブジェクトの API メソッドをラップする際は、元のメソッドを局所変数に保存してからラップ関数内で呼び出す（save-and-restore パターン）
  - 根拠: `src/middleware/persist.ts:229` の `const savedSetState = api.setState` → `api.setState = (state, replace) => { savedSetState(state, replace); ... }` パターンが全ミドルウェアで一貫している

- `[SHOULD]` 型レベルのプラグイン拡張には、空の `interface` を declaration merging で拡張する方式を使い、コアの型定義を変更せずにサードパーティが型を追加できるようにする
  - 根拠: `src/vanilla.ts:40` の `interface StoreMutators<S, A> {}` が拡張ポイントとして機能し、各ミドルウェアが `declare module` でエントリを追加している

- `[SHOULD]` 非同期処理で共有状態を更新する場合は、バージョンカウンタを用いて古いレスポンスを破棄する（stale closure / レースコンディション防止）
  - 根拠: persist ミドルウェアの `hydrationVersion` カウンタ（`src/middleware/persist.ts:201-203, 297-299`）により、複数の `rehydrate()` 呼び出しの競合を安全に処理している

- `[AVOID]` ミドルウェアの内部で他のミドルウェアの存在を前提としたコードを書くこと。各ミドルウェアは公開 API 面のみに依存し、単独でも動作すべき
  - 根拠: zustand の各ミドルウェアは互いに import せず（`redux.ts` が `devtools.ts` の `NamedSet` 型を import するのは型のみの例外）、単独利用・組み合わせ利用の両方をテストしている（`tests/middlewareTypes.test.tsx` の single / double / triple / quadruple テストスイート）

## 適用チェックリスト

- [ ] ミドルウェア / プラグインの統一シグネチャを定義しているか（入力と出力の型が一致し、合成可能か）
- [ ] 各ミドルウェアが外部依存の不在時にフォールバック（パススルー）するパスを持つか
- [ ] 型が複雑なミドルウェアで、実装型と公開型を分離しているか
- [ ] 型分離を使う場合、型テストで合成パターンの型整合性を検証しているか
- [ ] api メソッドのラップ時に save-and-restore パターンを使い、元のメソッド参照を保持しているか
- [ ] 型拡張ポイント（空 interface + declaration merging）を提供し、サードパーティ拡張が可能か
- [ ] 非同期のミドルウェアがレースコンディション対策（バージョンカウンタ等）を持つか
- [ ] ミドルウェア間の暗黙的な依存がなく、単独でも正しく動作するか
