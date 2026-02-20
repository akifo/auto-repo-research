# type-system-patterns

> リポジトリ: pmndrs/zustand
> 分析日: 2026-02-20

## 概要

zustand の型システムは、ミドルウェアの合成を型安全に表現するための高度な TypeScript パターンの集合体である。空インターフェースへの declaration merging による型レジストリ、再帰的条件型によるミドルウェアチェーンの型変換、メソッド抽出パターンによるオーバーロード統合など、TypeScript の型システムの限界を押し広げる設計が随所に見られる。これらのパターンは「プラグインシステムの型安全性」という汎用的な課題に対する実践的な解法であり、zustand 固有の知識なしに他のプラグインアーキテクチャへ応用できる。

## 背景にある原則

- **型変換の分散登録**: プラグインシステムにおいて、コアモジュールがすべてのプラグインの型を事前に知ることは不可能である。TypeScript の declaration merging を利用し、各プラグインが自身の型変換をコアのレジストリに事後的に登録する方式を採れば、コアとプラグインの型定義を疎結合に保てる（`src/vanilla.ts:40` の空 `StoreMutators` インターフェースと各ミドルウェアの `declare module`）

- **実装型と公開型の分離**: ジェネリクスが複雑になると、実装コード内で型推論が破綻する場面が出る。実装は簡素な型（`XxxImpl`）で書き、`as unknown as PublicType` で公開型にキャストする二重構造を採ることで、型推論の限界を実装の品質低下に直結させない（全ミドルウェアで一貫して使用: `src/middleware/persist.ts:407`, `src/middleware/immer.ts:88` 等）

- **型レベル計算の段階的適用**: 複数のミドルウェアが重なった場合の型を一括で計算しようとすると型が爆発する。再帰型 `Mutate` でミドルウェアリストを先頭から1つずつ適用する方式にすれば、各ステップの型変換を個別に定義・テストできる（`src/vanilla.ts:20-26`）

- **TypeScript コンパイラの癖への対処を型ユーティリティに閉じ込める**: オーバーロードの推論失敗、関数型引数の共変/反変問題など、コンパイラ固有の制約への対処を専用の型ユーティリティ（`SetStateInternal` のメソッド抽出、`Get` 型、`Cast` 型）に局所化し、ビジネスロジック側のコードを汚染しない

## 実例と分析

### 1. StoreMutators レジストリ: 空インターフェース + declaration merging

コアモジュールが空のインターフェースを定義し、各ミドルウェアが `declare module` で型変換を登録する。

```typescript
// src/vanilla.ts:39-41
// eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-object-type
export interface StoreMutators<S, A> {}
export type StoreMutatorIdentifier = keyof StoreMutators<unknown, unknown>;
```

各ミドルウェアが自身の型変換を登録する:

```typescript
// src/middleware/persist.ts:392-396
declare module "../vanilla" {
  interface StoreMutators<S, A> {
    "zustand/persist": WithPersist<S, A>;
  }
}

// src/middleware/immer.ts:14-19
declare module "../vanilla" {
  interface StoreMutators<S, A> {
    ["zustand/immer"]: WithImmer<S>;
  }
}

// src/middleware/devtools.ts:15-19
declare module "../vanilla" {
  interface StoreMutators<S, A> {
    "zustand/devtools": WithDevtools<S>;
  }
}
```

`StoreMutatorIdentifier` は `keyof StoreMutators<unknown, unknown>` として定義されるため、新しいミドルウェアが登録されると自動的にユニオンが拡張される。サードパーティミドルウェアも同一の仕組みで型を登録でき、テストコードでもそのパターンが実証されている:

```typescript
// tests/middlewareTypes.test.tsx:34-38
declare module "zustand/vanilla" {
  interface StoreMutators<S, A> {
    "org/example": Write<S, StoreModifyAllButSetState<S, A>>;
  }
}
```

### 2. Mutate 再帰型: ミドルウェアリストの順次適用

`Mutate<S, Ms>` はミドルウェアタプルを再帰的に処理し、`StoreMutators` レジストリから変換を取り出して順に適用する。

```typescript
// src/vanilla.ts:20-26
export type Mutate<S, Ms> = number extends Ms["length" & keyof Ms] ? S
  : Ms extends [] ? S
  : Ms extends [[infer Mi, infer Ma], ...infer Mrs] ? Mutate<StoreMutators<S, Ma>[Mi & StoreMutatorIdentifier], Mrs>
  : never;
```

最初のガード `number extends Ms['length' & keyof Ms]` は、`Ms` が具体的なタプルではなく `unknown[]` のような非固定長配列の場合に再帰を打ち切る安全弁である。これにより、ジェネリックパラメータが未解決の段階でも型エラーにならない。

実際の利用では、`create` の戻り値型として `Mutate<StoreApi<T>, Mos>` が使われ、ミドルウェアチェーン全体の型が自動計算される:

```typescript
// src/vanilla.ts:43-46
type CreateStore = {
  <T, Mos extends [StoreMutatorIdentifier, unknown][] = []>(
    initializer: StateCreator<T, [], Mos>,
  ): Mutate<StoreApi<T>, Mos>;
  // ...
};
```

### 3. StateCreator の4つのジェネリクス引数

```typescript
// src/vanilla.ts:28-37
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

- `T`: ストア全体の状態型
- `Mis` (Mutators Input): このクリエーターが受け取る `setState`/`getState` に適用済みのミドルウェア型リスト
- `Mos` (Mutators Output): このクリエーターが出力側に追加するミドルウェア型リスト
- `U`: 実際に返す値の型（スライスパターンで `T` の一部だけを返す場合に使用）

`$$storeMutators` はファントムプロパティで、実行時には存在しない。型推論のためだけに `Mos` 情報を保持するマーカーである。

### 4. メソッド抽出パターン: オーバーロード関数型の統合

```typescript
// src/vanilla.ts:1-7
type SetStateInternal<T> = {
  _(
    partial: T | Partial<T> | { _(state: T): T | Partial<T>; }["_"],
    replace?: false,
  ): void;
  _(state: T | { _(state: T): T; }["_"], replace: true): void;
}["_"];
```

TypeScript ではインターフェースのメソッドとして複数のオーバーロードを定義し、`['_']` でメソッドを抽出することで、オーバーロードされた関数型を得る。直接 `type Fn = ((a: X) => R1) & ((a: Y) => R2)` と書く方式と比べ、TypeScript コンパイラがオーバーロードの推論に関して一貫した挙動を示す利点がある。

関数型引数の中でもこのパターンが使われている: `{ _(state: T): T | Partial<T> }['_']` は、関数型を直接書く `(state: T) => T | Partial<T>` の代替で、`exactOptionalPropertyTypes` 有効下でのパラメータ推論を安定させる。

### 5. Write 型ユーティリティ: 交差型のプロパティ上書き

```typescript
// src/middleware/persist.ts:398 (全ミドルウェアで同一定義)
type Write<T, U> = Omit<T, keyof U> & U;
```

各ミドルウェアが独立してこの型を定義しており、モジュール間の依存を最小化している。`Write` は TypeScript の交差型 `T & U` で発生する「同名プロパティの型が intersection になる」問題を回避する。ミドルウェアが `setState` のシグネチャを変更する場合、`T & U` では新旧両方のシグネチャが要求されるが、`Omit<T, keyof U> & U` なら新しいシグネチャで完全に上書きされる。

### 6. 条件型によるオーバーロード推論の捕捉

ミドルウェアが既存の `setState` を拡張する際、条件型でオーバーロードの各引数を推論する:

```typescript
// src/middleware/devtools.ts:68-82
type StoreDevtools<S> = S extends {
  setState: {
    (...args: infer Sa1): infer Sr1;
    (...args: infer Sa2): infer Sr2;
  };
} ? {
    setState(...args: [...args: TakeTwo<Sa1>, action?: Action]): Sr1;
    setState(...args: [...args: TakeTwo<Sa2>, action?: Action]): Sr2;
  }
  : never;
```

これにより、前段のミドルウェアが `setState` に付加したパラメータ（例: persist の戻り値型）を失わずに、devtools 固有の `action` パラメータを追加できる。

### 7. 実装型と公開型の二重構造

すべてのミドルウェアで一貫したパターン:

```typescript
// src/middleware/immer.ts:70-72 (実装型: ジェネリクスが簡素)
type ImmerImpl = <T>(
  storeInitializer: StateCreator<T, [], []>,
) => StateCreator<T, [], []>;

// src/middleware/immer.ts:88 (公開型へキャスト)
export const immer = immerImpl as unknown as Immer;
```

`ImmerImpl` では `Mis`/`Mos` を `[]` に固定し、実装コード内で型推論が確実に成功するようにする。ユーザーに公開する `Immer` 型ではフルジェネリクスの `Mps`/`Mcs` を使い、ミドルウェア合成時の型伝播を正確に表現する。

### 8. typesVersions による TS バージョンゲート

```json
// package.json:9-26
"typesVersions": {
  ">=4.5": { "*": ["*"] },
  "*": { "*": ["ts_version_4.5_and_above_is_required.d.ts"] }
}
```

TS 4.5 未満では空の `.d.ts` にリダイレクトすることで、型エラーではなく明確なエラーメッセージを返す。CI では TS 4.5 から 5.9 まで 15 バージョンでの型チェックが回っている (`.github/workflows/test-old-typescript.yml`)。

## パターンカタログ

- **Registry Pattern** (構造)
  - 解決する問題: コアモジュールが全プラグインの型を事前に把握できない
  - 適用条件: プラグイン/ミドルウェアシステムで、各プラグインが型を変形する必要がある
  - コード例: `src/vanilla.ts:39-41` + 各ミドルウェアの `declare module`
  - 注意点: 空インターフェースを定義するため eslint の `no-empty-object-type` 抑制が必要

- **Phantom Type / Brand** (型レベル)
  - 解決する問題: 実行時には不要だが型推論に必要な情報の伝播
  - 適用条件: 型パラメータを推論のヒントとして保持したい場合
  - コード例: `src/vanilla.ts:37` の `$$storeMutators?: Mos`
  - 注意点: `?` (optional) にしないと実行時に値が必要になる

- **Type-Level Fold** (型レベル再帰)
  - 解決する問題: 可変長のタプルに対して型変換を順次適用する
  - 適用条件: ミドルウェアチェーンやパイプライン型の合成
  - コード例: `src/vanilla.ts:20-26` の `Mutate` 型
  - 注意点: 再帰深度制限に注意。非タプル型入力時の安全弁が必要

## Good Patterns

- **型レジストリによるプラグイン型の分散登録**: 空インターフェース + declaration merging で、コアを変更せずにプラグインが型変換を登録できる。サードパーティも同じメカニズムを利用でき、型の拡張性が保証される。

```typescript
// src/vanilla.ts:39-41 — コア側
export interface StoreMutators<S, A> {}

// src/middleware/persist.ts:392-396 — プラグイン側
declare module "../vanilla" {
  interface StoreMutators<S, A> {
    "zustand/persist": WithPersist<S, A>;
  }
}
```

- **再帰型の安全弁**: `Mutate` 型の先頭にある `number extends Ms['length' & keyof Ms]` は、型パラメータが未解決（非タプル）のときに再帰を停止する。これにより、ジェネリックコンテキストでの型エラーを防ぐ。

```typescript
// src/vanilla.ts:20-21
export type Mutate<S, Ms> = number extends Ms['length' & keyof Ms]
  ? S  // 非タプルなら変換せず返す
  // ...
```

- **モジュール内完結型ユーティリティ**: `Write<T, U>` が 6 つのミドルウェアファイルすべてで独立して定義されている。共通モジュールにまとめる方法もあるが、各ミドルウェアが自己完結することでモジュール間の依存グラフが単純になり、tree-shaking の効果も最大化される。

```typescript
// src/middleware/persist.ts:398
type Write<T, U> = Omit<T, keyof U> & U;
// src/middleware/immer.ts:21 (同一定義)
type Write<T, U> = Omit<T, keyof U> & U;
```

- **メソッド抽出によるオーバーロード型の安定した定義**: インターフェースメソッドとして複数シグネチャを書き、`['_']` で抽出する。

```typescript
// src/vanilla.ts:1-7
type SetStateInternal<T> = {
  _(partial: T | Partial<T> | { _(state: T): T | Partial<T>; }["_"], replace?: false): void;
  _(state: T | { _(state: T): T; }["_"], replace: true): void;
}["_"];
```

## Anti-Patterns / 注意点

- **交差型による型の上書き**: `T & U` を使ってオブジェクト型のプロパティを上書きしようとすると、同名プロパティが intersection になり意図しない型制約が発生する。

```typescript
// Bad: 交差型では setState が両方のシグネチャを要求する
type Bad = StoreApi<T> & { setState: NewSetState; };
// setState: OriginalSetState & NewSetState (呼び出し不能になりうる)

// Better: Omit で既存プロパティを除去してから上書き
type Write<T, U> = Omit<T, keyof U> & U;
type Good = Write<StoreApi<T>, { setState: NewSetState; }>;
```

- **実装コードにフルジェネリクスを持ち込む**: ミドルウェアの `Mps`/`Mcs` のような複雑なジェネリクスを実装コードに直接使うと、TypeScript の型推論が破綻して `any` に落ちたり、エラーメッセージが巨大になる。

```typescript
// Bad: 実装に複雑なジェネリクスを直接使用
const immerImpl = <
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
>(
  initializer: StateCreator<T, [...Mps, ["zustand/immer", never]], Mcs>,
): StateCreator<T, Mps, [["zustand/immer", never], ...Mcs]> => {
  // 型推論が破綻する
};

// Better: 実装型は簡素にし、公開型にキャスト
type ImmerImpl = <T>(
  storeInitializer: StateCreator<T, [], []>,
) => StateCreator<T, [], []>;
const immerImpl: ImmerImpl = (initializer) => (set, get, store) => {/* ... */};
export const immer = immerImpl as unknown as Immer;
```

- **再帰型に安全弁を設けない**: タプル型を期待する再帰型に非タプル型（`unknown[]` など）が入ると無限再帰や `never` に陥る。

```typescript
// Bad: 安全弁なし
type Apply<S, Ms> = Ms extends [[infer Mi, infer Ma], ...infer Mrs] ? Apply<Transform<S, Mi, Ma>, Mrs>
  : S;
// Ms が unknown[] のとき never になる

// Better: 非タプル検出ガードを先頭に置く
type Apply<S, Ms> = number extends Ms["length" & keyof Ms] ? S // 非タプルなら再帰しない
  : Ms extends [] ? S
  : Ms extends [[infer Mi, infer Ma], ...infer Mrs] ? Apply<Transform<S, Mi, Ma>, Mrs>
  : never;
```

## 導出ルール

- `[MUST]` プラグインシステムの型レジストリには空インターフェース + declaration merging を使い、各プラグインが `declare module` で型変換を登録する
  - 根拠: zustand の `StoreMutators` がこのパターンで 6 つのミドルウェア + サードパーティ拡張を型安全に実現しており、コアモジュールの変更なしにプラグインを追加できる (`src/vanilla.ts:39-41`)

- `[MUST]` タプル型を再帰処理する条件型には、非タプル入力（`number extends T['length']`）を検出して再帰を停止する安全弁を設ける
  - 根拠: `Mutate` 型がこのガードを持つことで、ジェネリックパラメータ未解決時にも型エラーにならず、実用的なエラーメッセージを維持している (`src/vanilla.ts:20-21`)

- `[SHOULD]` 複雑なジェネリクスを持つ関数は、実装用の簡素な型 (`XxxImpl`) と公開用のフルジェネリクス型を分離し、`as unknown as PublicType` でキャストする
  - 根拠: zustand の全ミドルウェア（persist, immer, devtools, redux, subscribeWithSelector）がこの二重構造を採用し、実装コード内での型推論の安定性と公開 API の型安全性を両立している

- `[SHOULD]` オブジェクト型のプロパティを上書きする場合は `type Write<T, U> = Omit<T, keyof U> & U` を使い、交差型 `T & U` を避ける
  - 根拠: ミドルウェアが `setState` のシグネチャを変更する際、交差型では新旧シグネチャが競合するが、`Write` なら完全な上書きが保証される（6 つのミドルウェアすべてで使用）

- `[SHOULD]` オーバーロード関数型はインターフェースのメソッドとして定義し、インデックスアクセス `['methodName']` で抽出する
  - 根拠: `SetStateInternal` が `{ _(...): void; _(...): void }['_']` パターンを使用し、`exactOptionalPropertyTypes` 下でも安定した推論を実現している (`src/vanilla.ts:1-7`)

- `[SHOULD]` ライブラリの最低 TypeScript バージョン要件は `typesVersions` でゲートし、非対応バージョンには意味のあるエラーメッセージを返す
  - 根拠: zustand は TS 4.5 未満で `ts_version_4.5_and_above_is_required.d.ts` にリダイレクトし、CI で 15 バージョンのマトリクステストを回している (`package.json:9-26`)

- `[SHOULD]` 型推論にのみ必要で実行時に不要な情報は、ファントムプロパティ（optional プロパティ + 未使用の型パラメータ）として保持する
  - 根拠: `StateCreator` の `$$storeMutators?: Mos` が出力ミドルウェア型リストを型レベルでのみ伝播するために使われている (`src/vanilla.ts:37`)

- `[AVOID]` 型ユーティリティを共通モジュールに集約してプラグイン間の依存を作ること。各プラグインが同一の小さな型ユーティリティを独立して定義する方が、モジュールの自己完結性と tree-shaking 効率が向上する
  - 根拠: `Write` 型が 6 ファイルで独立定義されており、ミドルウェア間に import 依存がない構造を維持している

## 適用チェックリスト

- [ ] プラグイン/ミドルウェアシステムの型定義で、コアモジュールに空インターフェースを配置し declaration merging の受け口を作っているか
- [ ] 各プラグインが `declare module` でコアの型レジストリに型変換を登録しているか
- [ ] タプル型を再帰処理する条件型に、非タプル入力への安全弁（`number extends T['length']` ガード）があるか
- [ ] 複雑なジェネリクスを持つ関数で、実装型と公開型が分離されているか
- [ ] オブジェクト型のプロパティ上書きに交差型 `T & U` ではなく `Omit<T, keyof U> & U` を使っているか
- [ ] オーバーロード関数型がメソッド抽出パターンで定義されているか
- [ ] ライブラリの TypeScript バージョン要件が `typesVersions` でゲートされ、非対応バージョンに明確なエラーメッセージを返しているか
- [ ] 型推論専用の情報がファントムプロパティとして適切にマーク（optional）されているか
- [ ] CI で複数の TypeScript バージョンに対する型チェックマトリクスが設定されているか
