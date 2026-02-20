# design-philosophy

> リポジトリ: pmndrs/zustand
> 分析日: 2026-02-20

## 概要

zustand の設計哲学を分析する。vanilla.ts わずか100行、react.ts わずか64行、全ソース1,459行という極端なミニマリズムの中に、フレームワーク非依存コア、ゼロボイラープレート API、opt-in 拡張という一貫した設計判断が凝縮されている。「状態管理に本当に必要なものは何か」を問い直し、不要な抽象を徹底的に排除した結果、57,000 スターを獲得した設計思想を掘り下げる。

## 背景にある原則

- **Principle of Least Mechanism（最小メカニズムの原則）**: ライブラリのコアは `Set<Listener>` + `Object.is` + `Object.assign` + クロージャの4要素だけで成立する。Redux が求める action type、reducer、dispatch、Provider、connect といった概念層を全て排除し、JavaScript のネイティブ機構だけで状態管理を実現している。根拠: `src/vanilla.ts:60-97` の `createStoreImpl` は let 変数1つ、Set1つ、関数4つで完結する。

- **Layered Architecture with Optional Binding（任意結合の階層アーキテクチャ）**: コアを特定のフレームワークに依存させず、バインディング層を上に重ねる。vanilla.ts（フレームワーク非依存）→ react.ts（React バインディング）→ middleware/（opt-in 拡張）という3層構造により、React 以外のランタイムでも使えるだけでなく、不要な機能のバンドルコストがゼロになる。根拠: `package.json` の peerDependencies で react, immer, use-sync-external-store が全て optional に指定されている。

- **Convention over Configuration, but Never Enforced（規約は推奨、強制はしない）**: Flux パターンを推奨しつつ、reducer や action type を強制しない。`docs/guides/flux-inspired-practice.md` で "we do recommend a few patterns" と明記しつつ、同時に `docs/guides/practice-with-no-store-actions.md` でアクション外出しパターンも紹介する。ユーザーの判断を信頼し、複数の正解を許容する設計。

- **Type Safety through Structural Tricks, Not Runtime Cost（実行時コストなしの型安全性）**: `create<T>()()` のカリー化や `declare module` による interface 拡張（StoreMutators）など、ランタイムでは何もしないが TypeScript の型推論を最大化する仕組みを採用している。根拠: `docs/guides/advanced-typescript.md` で `create<T>()(...)` の理由が TypeScript #10571 のワークアラウンドであると明記されている。

## 実例と分析

### コア実装の極限的ミニマリズム

zustand のコアである `createStoreImpl`（`src/vanilla.ts:60-97`）は38行で完結する。状態管理に必要な全ての機能 ── 状態保持、更新、購読、初期状態取得 ── がクロージャと `Set` だけで実現されている。

特筆すべきは、状態変更の検知に `Object.is` を使っている点（`src/vanilla.ts:73`）。deep equal ではなく referential equality を採用することで、比較コストを O(1) に抑え、ユーザーが必要に応じて `shallow` や `useShallow` で粒度を調整できる設計になっている。

```ts
// src/vanilla.ts:66-80
const setState: StoreApi<TState>["setState"] = (partial, replace) => {
  const nextState = typeof partial === "function"
    ? (partial as (state: TState) => TState)(state)
    : partial;
  if (!Object.is(nextState, state)) {
    const previousState = state;
    state = (replace ?? (typeof nextState !== "object" || nextState === null))
      ? (nextState as TState)
      : Object.assign({}, state, nextState);
    listeners.forEach((listener) => listener(state, previousState));
  }
};
```

この `setState` には3つの設計判断が凝縮されている:

1. **関数更新とオブジェクト更新の両対応** ── `typeof partial === 'function'` で分岐し、ボイラープレートなしで両方サポート
2. **shallow merge がデフォルト** ── `Object.assign({}, state, nextState)` で1階層のマージを自動実行。Redux のように spread operator を毎回書く必要がない
3. **replace フラグによるオプトアウト** ── マージ動作が不要な場合は `replace: true` で全置換可能

### フレームワーク非依存コアの分離

`src/react.ts` は `src/vanilla.ts` の上に構築されている。React バインディングの全実装は64行で、核心は `useSyncExternalStore` への橋渡しだけ:

```ts
// src/react.ts:27-37
export function useStore<TState, StateSlice>(
  api: ReadonlyStoreApi<TState>,
  selector: (state: TState) => StateSlice = identity as any,
) {
  const slice = React.useSyncExternalStore(
    api.subscribe,
    React.useCallback(() => selector(api.getState()), [api, selector]),
    React.useCallback(() => selector(api.getInitialState()), [api, selector]),
  );
  React.useDebugValue(slice);
  return slice;
}
```

vanilla store の API（`subscribe`, `getState`, `getInitialState`）が `useSyncExternalStore` の要求する引数と完全に一致するよう設計されている。これは偶然ではなく、コアの API 設計がプラットフォームの購読プリミティブに合わせて最適化されていることを示す。

### ミドルウェアの declare module パターン

各ミドルウェアは `declare module '../vanilla'` で `StoreMutators` interface を拡張する:

```ts
// src/middleware/redux.ts:28-32
declare module "../vanilla" {
  interface StoreMutators<S, A> {
    "zustand/redux": WithRedux<S, A>;
  }
}
```

これにより、ミドルウェアが store の型を変更できる（例: `dispatch` メソッドの追加）。実行時のコストはゼロで、TypeScript の declaration merging を活用した型レベルのプラグインシステムになっている。

### カリー化による型推論の強制

`create()` と `createStore()` は引数なし呼び出しでカリー化された関数を返す:

```ts
// src/vanilla.ts:99-100
export const createStore =
  ((createState) => createState ? createStoreImpl(createState) : createStoreImpl) as CreateStore;
```

`create<BearState>()(fn)` のように呼ぶと、状態型 `T` をユーザーが明示的に指定しつつ、ミドルウェアの型パラメータは自動推論される。これは TypeScript の "partial type argument inference" が未サポート（microsoft/TypeScript#10571）であることへのワークアラウンドで、実行時にはただの関数呼び出しの連鎖にすぎない。

### opt-in の段階的複雑化

zustand は機能を段階的に追加できる設計になっている。最小構成は `create(() => ({ count: 0 }))` の1行で、selector、middleware、shallow comparison、persistence、devtools をそれぞれ独立に追加できる:

| 段階             | 必要なもの             | import 元                  |
| ---------------- | ---------------------- | -------------------------- |
| 基本             | `create`               | `zustand`                  |
| vanilla only     | `createStore`          | `zustand/vanilla`          |
| shallow 比較     | `useShallow`           | `zustand/react/shallow`    |
| 永続化           | `persist`              | `zustand/middleware`       |
| DevTools         | `devtools`             | `zustand/middleware`       |
| Immer 統合       | `immer`                | `zustand/middleware/immer` |
| カスタム等価関数 | `createWithEqualityFn` | `zustand/traditional`      |

各段階は前の段階の知識だけで使え、不要な機能は tree-shake される（`sideEffects: false`）。

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: 状態変更を複数のリスナーに通知する
  - 適用条件: 1対多の状態変更通知が必要なとき
  - コード例: `src/vanilla.ts:64,79,88-92` ── `Set<Listener>` + `listeners.forEach` + `subscribe` の返り値が unsubscribe 関数
  - 注意点: zustand では GoF の Subject/Observer をクラスではなくクロージャで実現。`Set` により O(1) の追加・削除を達成

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 等価比較のアルゴリズムを差し替え可能にする
  - 適用条件: デフォルトの `Object.is` では不十分な場合
  - コード例: `src/traditional.ts:31-45` ── `equalityFn` 引数による比較戦略の注入
  - 注意点: デフォルトは最も安価な `Object.is`。`shallow` や custom equality fn は opt-in

- **Decorator パターン** (分類: 構造)
  - 解決する問題: コアの振る舞いを非破壊的に拡張する
  - 適用条件: persist、devtools、immer 等のクロスカッティング関心事を追加するとき
  - コード例: `src/middleware/immer.ts:74-86` ── `store.setState` を immer の `produce` でラップ
  - 注意点: ミドルウェアは `StateCreator` を受け取り `StateCreator` を返す高階関数。関数合成で積み重ねる

## Good Patterns

- **Store-is-a-Hook パターン**: `create()` の戻り値がそのまま React hook になる。store の生成と利用の間にボイラープレート（Provider、connect、mapStateToProps）が不要。コンポーネントは `const count = useStore(s => s.count)` の1行で状態にアクセスでき、selector が自然にレンダリング最適化になる。

```ts
// src/react.ts:53-61
const createImpl = <T>(createState: StateCreator<T, [], []>) => {
  const api = createStore(createState);
  const useBoundStore: any = (selector?: any) => useStore(api, selector);
  Object.assign(useBoundStore, api);
  return useBoundStore;
};
```

`Object.assign(useBoundStore, api)` により、hook 関数自体に `getState`, `setState`, `subscribe` が生えている。関数でありながらオブジェクトでもあるという JavaScript の特性を活かし、React 内外の両方から同じ store にアクセスできる。

- **Unsubscribe-by-Return パターン**: `subscribe` が unsubscribe 関数を返す設計。`useEffect` のクリーンアップ関数と形が一致するため、React との統合が自然になる。

```ts
// src/vanilla.ts:88-92
const subscribe: StoreApi<TState>["subscribe"] = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
```

- **Shallow Merge Default パターン**: `setState` がデフォルトで shallow merge する。Redux の `{ ...state, ...changes }` を毎回書く必要がなく、1階層のオブジェクトなら `set({ count: 1 })` で済む。深いネストが必要な場合のみ spread operator や immer を使う。

## Anti-Patterns / 注意点

- **Selector での新規オブジェクト生成**: selector が毎回新しい参照を返すと、`Object.is` で常に不一致となり無限ループやパフォーマンス劣化を引き起こす。v5 で `useSyncExternalStore` ベースに移行したことで、この問題がより顕在化した。

```ts
// Bad: 毎回新しい配列を生成 → 無限ループの可能性
const [value, setValue] = useStore((state) => [state.value, state.setValue]);

// Better: useShallow でラップし shallow 比較を適用
import { useShallow } from "zustand/react/shallow";
const [value, setValue] = useStore(
  useShallow((state) => [state.value, state.setValue]),
);
```

- **ミドルウェアの順序違反**: `devtools` は `setState` を mutate するため、他のミドルウェアより外側（最後）に配置する必要がある。内側に配置すると、後のミドルウェアが `devtools` の変更を上書きし、DevTools に状態変更が反映されない。

```ts
// Bad: devtools の setState 拡張が immer に上書きされる
create(immer(devtools((set) => ({ ... }))))

// Better: devtools を最も外側に配置
create(devtools(immer((set) => ({ ... }))))
```

- **コア機能を fat にする誘惑**: zustand は意図的にコアを最小に保ち、selector ベースの購読や shallow comparison を別パッケージ/別 import に分離している。「便利だから」とコアに機能を追加すると、バンドルサイズとメンテナンスコストが増大する。`subscribeWithSelector` がコアではなくミドルウェアである点がその証左。

## 導出ルール

- `[MUST]` ライブラリのコアはフレームワーク非依存に保ち、フレームワークバインディングは別レイヤーで提供する
  - 根拠: zustand は vanilla.ts（100行）に全コアロジックを集約し、react.ts（64行）は `useSyncExternalStore` への薄いブリッジに徹している。これにより React 以外の環境でも利用でき、tree-shake も効く（`src/vanilla.ts`, `src/react.ts`）

- `[MUST]` 状態変更の等価比較にはデフォルトで最も安価な手段（`Object.is` 等）を採用し、より高コストな比較は opt-in で提供する
  - 根拠: zustand は `Object.is` をデフォルトとし、`shallow` は `zustand/shallow`、カスタム比較関数は `zustand/traditional` で別途 import させる設計にしている（`src/vanilla.ts:73`, `src/vanilla/shallow.ts:49`）

- `[SHOULD]` 拡張機能は高階関数（ミドルウェア/デコレータ）として実装し、コアの API サーフェスを増やさない
  - 根拠: persist, devtools, immer, subscribeWithSelector は全て `StateCreator -> StateCreator` の高階関数で、コアの `setState/getState/subscribe` API は一切変更されていない（`src/middleware/*.ts`）

- `[SHOULD]` TypeScript の型推論を最大化するために、実行時コストゼロの構造的トリック（カリー化、declaration merging）を活用する
  - 根拠: `create<T>()()` のカリー化は TypeScript #10571 のワークアラウンドであり、`declare module` による `StoreMutators` 拡張はミドルウェアの型を合成するためのゼロコスト抽象（`src/vanilla.ts:99-100`, `src/middleware/redux.ts:28-32`）

- `[SHOULD]` 購読関数は unsubscribe 関数を戻り値として返し、外部の購読管理機構を不要にする
  - 根拠: `subscribe` が `() => void`（unsubscribe）を返す設計は、React の `useEffect` クリーンアップ、`useSyncExternalStore` の subscribe 引数と形が一致し、統合コストを最小化する（`src/vanilla.ts:88-92`）

- `[SHOULD]` `sideEffects: false` を package.json に設定し、バンドラーの tree-shake を保証する
  - 根拠: zustand は `package.json` に `"sideEffects": false` を明記し、使われないミドルウェアやエントリポイントがバンドルに含まれないことを保証している

- `[AVOID]` デフォルトの動作を複雑にして利便性を高める（smart defaults の過剰適用）。代わりに、デフォルトは最も単純・安価な動作にし、高度な機能は明示的な opt-in にする
  - 根拠: `setState` のデフォルトは shallow merge + `Object.is` 比較。deep merge、deep equality、selector 購読はそれぞれ別途 import が必要。この設計が1,459行で57K スターを達成した要因の一つ

## 適用チェックリスト

- [ ] ライブラリのコアロジックがフレームワーク固有の API に依存していないか確認する
- [ ] コアモジュールの行数を計測し、不要な抽象や機能が混入していないか検証する
- [ ] 等価比較のデフォルトが最も安価な手段（referential equality）になっているか確認する
- [ ] 拡張機能がコアの API サーフェスを増やしていないか（高階関数/ミドルウェアとして分離されているか）検証する
- [ ] `sideEffects: false` が package.json に設定され、tree-shake が有効になっているか確認する
- [ ] TypeScript の型推論を活用し、実行時コストなしで型安全性を実現しているか検証する
- [ ] 購読関数が unsubscribe を戻り値として返す設計になっているか確認する
- [ ] ユーザーに段階的な学習・採用パスを提供しているか（最小構成から始められるか）検証する
