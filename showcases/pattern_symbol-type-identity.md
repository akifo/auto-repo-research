# Pattern: Symbol Type Identity

> 出典: [repos/Effect-TS/effect](../repos/Effect-TS/effect/) からの知見
> カテゴリ: pattern

## 概要

`Symbol.for()` で生成したグローバルシンボルをデータ型の識別子（TypeId）として埋め込み、`hasProperty` ベースの型ガードで `instanceof` を代替する型判定パターンである。CJS/ESM 混在環境、バンドラーによるモジュール重複、HMR によるプロトタイプ不一致など、`instanceof` が構造的に壊れる状況を根本から解決する。Effect-TS では 41 モジュール以上でこのパターンを統一適用し、あらゆる実行環境で安定した型判定を実現している。

## 背景・文脈

`instanceof` は JavaScript のプロトタイプチェーンに依存した型判定演算子であり、以下の状況で偽陰性を返す:

1. **CJS/ESM 混在**: 同一パッケージの CJS 版と ESM 版が別々にロードされると、クラスのプロトタイプが異なるオブジェクトになる。`require("effect").Option` と `import { Option } from "effect"` が別のコンストラクタを参照し、`instanceof` が `false` を返す。

2. **バンドラーのモジュール重複**: Webpack や Vite の tree-shaking やコード分割により、同一モジュールが複数のチャンクに重複してバンドルされることがある。それぞれのチャンクが独立したクラスインスタンスを持つため、`instanceof` が壊れる。

3. **HMR（Hot Module Replacement）**: 開発中にモジュールが再読み込みされると、新しいクラス定義が生成される。古いインスタンスは旧クラスのプロトタイプを持つため、新しいクラスに対する `instanceof` は `false` になる。

4. **モノレポのシンボリックリンク**: pnpm や yarn workspaces でパッケージがシンボリックリンクされた場合、node_modules の解決パスによっては同一パッケージが複数インスタンス化される。

これらはいずれも「同一の論理的な型が、複数の物理的なプロトタイプとして存在する」問題に帰結する。`Symbol.for()` はプロセス内のグローバルシンボルレジストリから値を取得するため、モジュールの読み込み経路に関係なく常に同一のシンボルを返す。この性質を利用して、プロトタイプチェーンではなくシンボルプロパティの存在で型を判定するのが本パターンの核心である。

Effect-TS はこのパターンを Option、Either、Effect、HashMap、Chunk、List、Readable、MutableRef など 41 以上のデータ型に一貫して適用し、ライブラリ全体の型判定基盤としている。

## 実装パターン

### Step 1: TypeId を Symbol.for で定義する

グローバルシンボルレジストリに一意のキーを登録し、`unique symbol` として型付けする。

```typescript
// packages/effect/src/Option.ts:46
export const TypeId: unique symbol = Symbol.for("effect/Option");
export type TypeId = typeof TypeId;
```

`Symbol.for("effect/Option")` は、プロセス内のどこから呼び出しても同一のシンボルを返す。`unique symbol` 型を付けることで、TypeScript の構造的型付けの中で名目的な区別を実現する。

命名規約は `"scope/TypeName"` 形式で統一されている:

```typescript
// packages/effect/src/HashMap.ts:14
const TypeId: unique symbol = HM.HashMapTypeId as TypeId;

// packages/effect/src/Chunk.ts
const TypeId: unique symbol = Symbol.for("effect/Chunk") as TypeId;

// packages/effect/src/Readable.ts:23
export const TypeId: unique symbol = Symbol.for("effect/Readable");
```

### Step 2: データ型の interface に TypeId を埋め込む

TypeId をプロパティキーとして interface に定義し、型パラメータの分散情報も併せてエンコードする。

```typescript
// packages/effect/src/Option.ts:58-63
export interface None<out A> extends Pipeable, Inspectable {
  readonly _tag: "None";
  readonly [TypeId]: {
    readonly _A: Covariant<A>;
  };
}

export interface Some<out A> extends Pipeable, Inspectable {
  readonly _tag: "Some";
  readonly [TypeId]: {
    readonly _A: Covariant<A>;
  };
  readonly value: A;
}
```

### Step 3: hasProperty ベースの型ガードを実装する

`instanceof` の代わりに、オブジェクトに TypeId プロパティが存在するかどうかで型判定する。

```typescript
// packages/effect/src/Predicate.ts
export const hasProperty = <N extends PropertyKey>(
  self: unknown,
  property: N,
): self is { [K in N]: unknown; } => isObject(self) && property in (self as object);

// packages/effect/src/internal/option.ts:64
export const isOption = (input: unknown): input is Option.Option<unknown> => hasProperty(input, TypeId);

// packages/effect/src/Readable.ts:36
export const isReadable = (u: unknown): u is Readable<unknown, unknown, unknown> => hasProperty(u, TypeId);
```

`hasProperty` は 2 つの検証を行う:

1. `isObject(self)` -- `null` とプリミティブを除外する
2. `property in self` -- プロパティの存在チェック（プロトタイプチェーンも含む）

### Step 4: 実装オブジェクトに TypeId を付与する

プロトタイプオブジェクトに TypeId プロパティを設定し、そこから生成される全インスタンスが自動的に TypeId を持つようにする。

```typescript
// packages/effect/src/internal/option.ts:14-25
const CommonProto = {
  ...EffectPrototype,
  [TypeId]: { _A: (_: never) => _ }, // TypeId プロパティを付与
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  toString() {
    return format(this.toJSON());
  },
};

const SomeProto = Object.assign(Object.create(CommonProto), {
  _tag: "Some",
  // ...
});

export const some = <A>(value: A): Option.Option<A> => {
  const a = Object.create(SomeProto);
  a.value = value;
  return a;
};
```

### 補強: GlobalValue によるシングルトン保護

HMR 環境ではモジュール再読み込みでグローバル状態が再初期化されるリスクがある。`GlobalValue` パターンと組み合わせることで、シングルトンの破壊を防ぐ。

```typescript
// packages/effect/src/GlobalValue.ts:42-53
export const globalValue = <A>(id: string, compute: () => A): A => {
  if (!globalStore.has(id)) {
    globalStore.set(id, compute());
  }
  return globalStore.get(id)!;
};
```

`globalStore` は `globalThis` 上に配置されるため、HMR でモジュールが再読み込みされても既存の値が保持される。TypeId 自体は `Symbol.for` で保護されるが、TypeId に紐づくメタデータやレジストリは `globalValue` で保護する。

## Good Example

```typescript
// --- ライブラリ側の実装 ---

import { hasProperty } from "./predicate";

// 1. グローバルシンボルで TypeId を定義
const TypeId: unique symbol = Symbol.for("mylib/Option") as unique symbol;
type TypeId = typeof TypeId;

// 2. interface に TypeId を埋め込む
interface None<A> {
  readonly _tag: "None";
  readonly [TypeId]: {
    readonly _A: (_: never) => A; // 共変性のエンコード
  };
}

interface Some<A> {
  readonly _tag: "Some";
  readonly [TypeId]: {
    readonly _A: (_: never) => A;
  };
  readonly value: A;
}

type Option<A> = None<A> | Some<A>;

// 3. hasProperty ベースの型ガード
const isOption = (u: unknown): u is Option<unknown> => hasProperty(u, TypeId);

// 4. プロトタイプに TypeId を付与
const Proto = {
  [TypeId]: { _A: (_: never) => _ },
};

const none = <A>(): Option<A> =>
  Object.create(Proto, {
    _tag: { value: "None", enumerable: true },
  });

const some = <A>(value: A): Option<A> =>
  Object.create(Proto, {
    _tag: { value: "Some", enumerable: true },
    value: { value, enumerable: true },
  });
```

```typescript
// --- 利用側 ---

// CJS でインポートしても ESM でインポートしても
// Symbol.for("mylib/Option") は同一のシンボルを返すため
// isOption の判定が壊れない
import { isOption, none, some } from "mylib";

const opt = some(42);
console.log(isOption(opt)); // true（常に正しく判定される）
```

## Bad Example

### NG: instanceof に依存する

```typescript
// Bad: instanceof はプロトタイプチェーンに依存する
class OptionImpl<A> {
  constructor(readonly value: A | undefined) {}
}

function isOption(value: unknown): value is OptionImpl<unknown> {
  return value instanceof OptionImpl;
}

// CJS と ESM で別々のクラスが読み込まれた場合:
// const OptionCJS = require("mylib").OptionImpl
// import { OptionImpl as OptionESM } from "mylib"
// new OptionCJS(1) instanceof OptionESM → false
```

### NG: ローカル Symbol を使う

```typescript
// Bad: Symbol() はモジュールごとに異なるシンボルを生成する
const TypeId = Symbol("Option");

// バンドラーがモジュールを重複させると:
// chunk-a.js: const TypeId = Symbol("Option")  // シンボル A
// chunk-b.js: const TypeId = Symbol("Option")  // シンボル B（A とは別物）
// chunk-a で生成したオブジェクトを chunk-b で hasProperty(obj, TypeId) → false
```

### NG: 文字列プロパティで代用する

```typescript
// Bad: 文字列プロパティは衝突リスクがある
interface Option<A> {
  readonly __type: "Option"; // 他のライブラリと衝突する可能性
  readonly value: A;
}

function isOption(u: unknown): u is Option<unknown> {
  return typeof u === "object" && u !== null && (u as any).__type === "Option";
}

// 別のライブラリが同じ __type: "Option" を使っていた場合、
// 誤判定が発生する。Symbol.for はスコープ付き命名で衝突を防ぐ。
```

## 適用ガイド

### どのような状況で使うべきか

- **npm パッケージとして配布する TypeScript ライブラリ**: CJS/ESM の両方で消費される可能性があるため、`instanceof` が壊れるリスクが常にある。
- **モノレポ内の共有パッケージ**: シンボリックリンクによるモジュール重複が発生しやすい環境。
- **カスタムデータ型に `is` 型ガードを提供する場合**: `isOption`, `isEffect`, `isChunk` のような型判定関数を公開する場合は、このパターンが唯一の堅牢な選択肢。
- **プラグインシステム**: ホストアプリケーションとプラグインが異なるバージョンの同一ライブラリを持つ可能性がある環境。

### 導入時の注意点

1. **命名規約を統一する**: `Symbol.for("scope/TypeName")` 形式でスコープ付き命名を徹底する。スコープなしの `Symbol.for("Option")` は他のライブラリと衝突するリスクがある。Effect-TS は `"effect/Option"`, `"effect/Chunk"`, `"effect/HashMap"` で統一している。

2. **`hasProperty` を共通ユーティリティとして切り出す**: 各モジュールで `in` 演算子のチェックを直接書くのではなく、null チェックを含んだ `hasProperty` 関数を 1 箇所で定義して再利用する。

3. **TypeId の型は `unique symbol` にする**: `symbol` 型ではなく `unique symbol` 型にすることで、TypeScript の型システム上で異なる TypeId が別の型として扱われる。

4. **GlobalValue との併用を検討する**: TypeId そのものは `Symbol.for` で保護されるが、グローバルなレジストリやキャッシュなど TypeId に紐づく状態がある場合は `globalValue` パターンで HMR 耐性を確保する。

5. **プロトタイプに TypeId を設定する**: 各インスタンスに個別に TypeId を設定するのではなく、プロトタイプオブジェクトに 1 回だけ設定し、`Object.create` で継承させる。メモリ効率が良く、変更の伝播も容易になる。

### カスタマイズポイント

- **TypeId の値に分散情報を含めるか**: Effect-TS は `[TypeId]: { _A: Covariant<A> }` のように TypeId プロパティの値に型パラメータの分散情報をエンコードしている。単純な型判定だけなら `[TypeId]: TypeId` で十分だが、ジェネリクスの型推論を精密に制御したい場合は分散情報の埋め込みが有効。
- **複数の TypeId による多層判定**: 1 つのデータ型に複数の TypeId を持たせ、階層的な型判定を実現することも可能。Effect-TS では `EffectTypeId`, `StreamTypeId`, `SinkTypeId`, `ChannelTypeId` を同一のプロトタイプに付与し、Effect として扱える全データ型を統一的に判定している。
- **バージョン情報の埋め込み**: Effect-TS は `effectVariance` に `_V: version.getCurrentVersion()` を含め、バージョン不一致を検出可能にしている。ライブラリのメジャーバージョン間で互換性を制御したい場合に有用。

## 参考

- [repos/Effect-TS/effect/abstraction-patterns.md](../repos/Effect-TS/effect/abstraction-patterns.md) -- プロトコル設計と Symbol.for による跨境識別
- [repos/Effect-TS/effect/api-design-practices.md](../repos/Effect-TS/effect/api-design-practices.md) -- TypeId Brand パターンと hasProperty 型ガード
- [repos/Effect-TS/effect/type-system-patterns.md](../repos/Effect-TS/effect/type-system-patterns.md) -- unique symbol による名目的型区別と分散エンコーディング
