# abstraction-patterns

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod v4 のコアは「トレイトベースの擬似継承」「定義-初期化分離による合成」「レイヤー分離（core / classic / mini）」という3つの抽象化戦略を軸に設計されている。クラス継承を使わず `$constructor` 関数でトレイトを合成する独自パターンにより、TypeScript の型推論とバンドルサイズ最適化（tree-shaking）を両立させている点が特に注目に値する。この設計は「スキーマバリデーション」というドメインに限定されない、汎用的な抽象化技法を多数含んでいる。

## 背景にある原則

- **クラス継承を避け、トレイト合成で振る舞いを組み立てるべき。なぜなら深い継承階層は tree-shaking を阻害し、バンドルサイズを肥大させるから。** Zod v4 は `class` を一切使わず、`$constructor` 関数が返すファクトリでインスタンスを生成する。各 `$constructor` は `init` メソッドを持ち、他のトレイトの `init` を呼ぶことで合成する。`instanceof` は `Symbol.hasInstance` でトレイト名の `Set` をチェックする形に差し替えられている（`core.ts:69-74`）。

- **内部状態（`_zod`）を単一の名前空間に集約し、パブリック API との境界を明確にすべき。なぜなら内部構造の変更がユーザーコードに波及しなくなるから。** すべてのスキーマは `_zod` プロパティに `def`, `parse`, `run`, `traits`, `bag` 等を格納する。ユーザーが触るのは `parse()`, `safeParse()` 等のメソッドのみで、内部の `_zod.run` → `_zod.parse` の二段階パイプラインは完全に隠蔽されている（`schemas.ts:91-161`）。

- **API レイヤーを段階的に抽象化すべき。なぜならユースケースごとに必要な機能セットが異なり、不要な機能のコストを払わせるべきではないから。** Zod は `@zod/core`（パース/バリデーションエンジン）→ `classic`（フル機能 API）/ `mini`（軽量 API）という階層構造を持つ。`core` の `$ZodString` はパースロジックのみ提供し、`classic` の `ZodString` が `.min()`, `.email()` 等のメソッドチェーン API を追加する。`mini` は最小限のメソッドのみを追加する（`mini/schemas.ts:43-79`）。

- **遅延評価で循環依存とパフォーマンスの両方を解決すべき。なぜなら再帰スキーマは参照時に未定義になりうるし、使わないプロパティの計算は無駄だから。** `defineLazy` は `Object.defineProperty` の getter を使い、初回アクセス時のみ値を計算してキャッシュする。循環参照検出のためにセンチネル値 `EVALUATING` を使う（`util.ts:264-289`）。

## 実例と分析

### トレイトベース `$constructor` パターン

Zod のすべてのスキーマ型は `$constructor` 関数で生成される。この関数はクラスのように見えるが実際は関数オブジェクトで、`init` 静的メソッドを持つ。

```typescript
// packages/zod/src/v4/core/core.ts:17-77
export function $constructor<T extends ZodTrait, D = T["_zod"]["def"]>(
  name: string,
  initializer: (inst: T, def: D) => void,
  params?: { Parent?: typeof Class }
): $constructor<T, D> {
  function init(inst: T, def: D) {
    if (!inst._zod) {
      Object.defineProperty(inst, "_zod", {
        value: { def, constr: _, traits: new Set() },
        enumerable: false,
      });
    }
    if (inst._zod.traits.has(name)) return; // 多重初期化防止
    inst._zod.traits.add(name);
    initializer(inst, def);
  }
  // ...Symbol.hasInstance でトレイト名ベースの instanceof を実現
}
```

このパターンにより、スキーマの「型」は以下のように合成される:

```typescript
// packages/zod/src/v4/core/schemas.ts:389-396
// $ZodStringFormat は $ZodCheckStringFormat と $ZodString の両方を合成
export const $ZodStringFormat = core.$constructor("$ZodStringFormat", (inst, def) => {
  checks.$ZodCheckStringFormat.init(inst, def); // チェック機能を注入
  $ZodString.init(inst, def);                    // 文字列パース機能を注入
});
```

classic レイヤーではさらにメソッドを追加する:

```typescript
// packages/zod/src/v4/classic/schemas.ts:289-318
export const _ZodString = core.$constructor("_ZodString", (inst, def) => {
  core.$ZodString.init(inst, def); // core のパースロジック
  ZodType.init(inst, def);         // classic の共通メソッド群
  // ユーザー向け便利メソッドの追加
  inst.regex = (...args) => inst.check(checks.regex(...args));
  inst.min = (...args) => inst.check(checks.minLength(...args));
  // ...
});
```

### run / parse 二段階パイプライン

スキーマの実行には `_zod.run` と `_zod.parse` の2つの関数がある。`run` はチェック（バリデーション制約）を含む完全な実行、`parse` は型チェックのみ。チェックがない場合は `run = parse` として最適化される。

```typescript
// packages/zod/src/v4/core/schemas.ts:205-211
// チェックがない場合の最適化パス
if (checks.length === 0) {
  inst._zod.deferred ??= [];
  inst._zod.deferred?.push(() => {
    inst._zod.run = inst._zod.parse; // 同一関数を共有
  });
}
```

チェックがある場合、forward（decode）と backward（encode）で実行順序が異なる。forward では parse → checks、backward では canary パス（チェックなしの試行実行） → checks → parse と進む（`schemas.ts:273-299`）。

### onattach コールバックによるメタデータ集約

チェック（バリデーション制約）はスキーマにアタッチされる際に `onattach` コールバックでメタデータをスキーマの `bag` に書き込む。これにより、JSON Schema 生成時にスキーマの制約情報を一元的に参照できる。

```typescript
// packages/zod/src/v4/core/checks.ts:70-77
// $ZodCheckLessThan の onattach: スキーマの bag に maximum を記録
inst._zod.onattach.push((inst) => {
  const bag = inst._zod.bag;
  const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
  if (def.value < curr) {
    if (def.inclusive) bag.maximum = def.value;
    else bag.exclusiveMaximum = def.value;
  }
});
```

### JIT コンパイルによる高速パース

`$ZodObjectJIT` は `new Function()` でオブジェクトスキーマのパース関数を動的に生成する。形状ごとに専用のコードを生成することで、ループや条件分岐のオーバーヘッドを排除する。

```typescript
// packages/zod/src/v4/core/schemas.ts:1947-2019
const generateFastpass = (shape: any) => {
  const doc = new Doc(["shape", "payload", "ctx"]);
  // 各キーに対して直接的なパースコードを生成
  for (const key of normalized.keys) {
    doc.write(`const ${id} = ${parseStr(key)};`);
    // ...issues の結合とプロパティコピーのコード
  }
  doc.write(`payload.value = newResult;`);
  doc.write(`return payload;`);
  const fn = doc.compile(); // new Function() でコンパイル
  return (payload, ctx) => fn(shape, payload, ctx);
};
```

`globalConfig.jitless` や `util.allowsEval` で Cloudflare Workers 等の `eval` 禁止環境を検出し、フォールバックする設計になっている（`schemas.ts:2025-2028`）。

### defineLazy による遅延評価とキャッシュ

`defineLazy` は循環依存の安全な解決と初回アクセス時のみの計算を同時に実現する。

```typescript
// packages/zod/src/v4/core/util.ts:264-289
const EVALUATING = Symbol("evaluating");
export function defineLazy<T, K extends keyof T>(object: T, key: K, getter: () => T[K]): void {
  let value: T[K] | typeof EVALUATING | undefined = undefined;
  Object.defineProperty(object, key, {
    get() {
      if (value === EVALUATING) return undefined as T[K]; // 循環検出
      if (value === undefined) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object, key, { value: v }); // 上書き可能
    },
    configurable: true,
  });
}
```

`schemas.ts` 内では39箇所で使用されており、`propValues`, `values`, `pattern`, `optin`, `optout`, `innerType` 等のプロパティが遅延評価される。

### ファクトリ関数のクラスパラメータ化

core の API ファクトリ関数は第一引数にクラス（`$constructor`）を受け取る設計になっている。これにより、classic と mini で異なるクラスを注入できる。

```typescript
// packages/zod/src/v4/core/api.ts:63-71
export function _string<T extends schemas.$ZodString>(
  Class: util.SchemaClass<T>,
  params?: string | $ZodStringParams
): T {
  return new Class({ type: "string", ...util.normalizeParams(params) });
}
```

```typescript
// packages/zod/src/v4/mini/schemas.ts:100-102
export function string(params?): ZodMiniString<string> {
  return core._string(ZodMiniString, params) as any; // mini 用クラスを注入
}
```

## パターンカタログ

- **Trait Mixin パターン** (分類: 構造)
  - 解決する問題: 深いクラス継承階層の回避と、tree-shaking 対応
  - 適用条件: 複数の直交する振る舞いを合成する必要があり、バンドルサイズを最適化したい場合
  - コード例: `core/core.ts:17-77`（`$constructor` 関数）、`core/schemas.ts:389-396`（`$ZodStringFormat` の合成）
  - 注意点: `Symbol.hasInstance` オーバーライドは `instanceof` の動作を根本的に変えるため、デバッグ時に混乱を招きうる

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: パース戦略（sync/async、forward/backward）の動的切り替え
  - 適用条件: 同じインターフェースで異なるアルゴリズムを選択する必要がある場合
  - コード例: `core/schemas.ts:273-299`（`inst._zod.run` の forward/backward 分岐）、`core/parse.ts:16-28`（sync/async 切り替え）
  - 注意点: 戦略の数が増えすぎると条件分岐が複雑化する

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 共通のパースフロー（run → parse → checks）を固定しつつ、各ステップをカスタマイズ可能にする
  - 適用条件: アルゴリズムの骨格は同じだが、個別ステップの実装が異なる場合
  - コード例: `core/schemas.ts:185-315`（`$ZodType` の `run` / `parse` 分離）

- **Observer パターン（変形）** (分類: 振る舞い)
  - 解決する問題: チェックがスキーマにアタッチされた時点でメタデータを更新する
  - 適用条件: コンポーネント追加時に副作用としてメタデータを集約したい場合
  - コード例: `core/checks.ts:70-77`（`onattach` コールバック）

## Good Patterns

- **Def-Init 分離による不変コピー**: スキーマの `.check()` や `.clone()` は新しい `def` オブジェクトを作って新しいインスタンスを構築する。元のスキーマは変更されない。`util.mergeDefs` は `Object.getOwnPropertyDescriptors` でゲッターも含めてコピーする。

```typescript
// packages/zod/src/v4/core/util.ts:308-317
export function mergeDefs(...defs: Record<string, any>[]): any {
  const mergedDescriptors: Record<string, PropertyDescriptor> = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
```

- **自己キャッシュ getter**: `pick` / `omit` / `extend` 等の shape 操作で、初回アクセス時に計算し `assignProp` で値プロパティに置き換える。

```typescript
// packages/zod/src/v4/core/util.ts:593-620 (pick の例)
const def = mergeDefs(schema._zod.def, {
  get shape() {
    const newShape = {};
    for (const key in mask) { /* ... */ }
    assignProp(this, "shape", newShape); // getter を値で上書き
    return newShape;
  },
});
```

- **`@__PURE__` / `@__NO_SIDE_EFFECTS__` アノテーションの徹底**: core だけで244箇所のアノテーションがあり、すべての `$constructor` 呼び出しと多くのファクトリ関数に付与されている。これにより tree-shaker が未使用コードを確実に除去できる。

## Anti-Patterns / 注意点

- **巨大な単一ファイル**: `core/schemas.ts` は4500行超のモノリスファイルになっている。すべてのスキーマ型が一つのファイルに定義されているため、理解とナビゲーションが困難。

```
// Bad: 1ファイルに全スキーマ型を集約
// schemas.ts: ~4500 lines
export const $ZodString = ...
export const $ZodNumber = ...
export const $ZodObject = ...
// ... 40+ schema types

// Better: ドメインごとにファイル分割
// schemas/primitives.ts: string, number, boolean, ...
// schemas/collections.ts: array, object, record, map, set, ...
// schemas/wrappers.ts: optional, nullable, default, ...
```

ただし、Zod ではファイル分割すると循環 import が発生しやすく、意図的にモノリスにしている可能性がある（推測）。

- **`as any` 型アサーションの多用**: トレイト合成パターンでは TypeScript の型システムが構造的な整合性を完全には追えないため、`as any` が頻出する。新しい型操作を追加する際に型安全性が低下するリスクがある。

```typescript
// packages/zod/src/v4/core/core.ts:76
return _ as any; // $constructor の戻り値

// Better: 可能な限り型パラメータの制約で安全性を確保し、
// as any が必要な箇所を最小限に局所化する
```

## 導出ルール

- `[MUST]` 内部状態は単一の名前空間プロパティ（例: `_internal`, `_zod`）に集約し、`enumerable: false` で隠蔽する
  - 根拠: Zod は全スキーマで `_zod` プロパティに内部状態を集約し、`Object.defineProperty` で non-enumerable にしている（`core.ts:24-31`）。これにより `JSON.stringify` やスプレッド演算子で内部状態が漏れない。

- `[MUST]` tree-shaking 対象のライブラリでは、すべてのファクトリ関数と定数初期化に `@__PURE__` / `@__NO_SIDE_EFFECTS__` アノテーションを付与する
  - 根拠: Zod core は244箇所にアノテーションを付与しており、`sideEffects: false` と合わせて未使用スキーマ型のコード除去を保証している。

- `[SHOULD]` 遅延評価が必要なプロパティは `Object.defineProperty` の getter + 初回アクセス時キャッシュで実装する
  - 根拠: `defineLazy` は Zod core で39箇所使用されており、循環依存の安全な解決（`EVALUATING` センチネル）と不要な計算の回避を同時に実現している（`util.ts:264-289`）。

- `[SHOULD]` 共通ロジックのファクトリ関数は「クラスを引数に取る」設計にし、異なる API レイヤーが同じロジックを共有できるようにする
  - 根拠: `_string(Class, params)` のようにクラスをパラメータ化することで、classic と mini が core の生成ロジックを共有しつつ、独自のメソッドを持つ異なるクラスを返せる（`api.ts:63-71`）。

- `[SHOULD]` JIT コンパイルを使う場合は `eval` / `new Function()` 禁止環境の検出とフォールバックパスを必ず用意する
  - 根拠: `$ZodObjectJIT` は `util.allowsEval` で Cloudflare Workers 等を検出し、`globalConfig.jitless` でユーザーによる無効化もサポートする（`schemas.ts:2025-2028`）。

- `[AVOID]` クラス継承（`extends`）で振る舞いの合成を行うこと。代わりにトレイト初期化パターン（`init` メソッドの連鎖呼び出し）を使う
  - 根拠: Zod v4 はクラス継承を完全に排除し、`$constructor` の `init` 連鎖で振る舞いを合成する。これにより各トレイトが独立して tree-shake 可能になり、バンドルサイズが最適化される（`core.ts:17-77`）。

## 適用チェックリスト

- [ ] ライブラリの内部状態が単一の non-enumerable プロパティに集約されているか確認する
- [ ] tree-shaking が必要なエクスポートに `@__PURE__` / `@__NO_SIDE_EFFECTS__` アノテーションが付いているか確認する
- [ ] 循環参照がありうるプロパティに遅延評価（`defineLazy` 相当）を適用しているか確認する
- [ ] ファクトリ関数がクラスをパラメータとして受け取り、異なる API レイヤーでロジックを共有できる設計になっているか確認する
- [ ] `eval` / `new Function()` を使う最適化パスに、禁止環境のフォールバックが用意されているか確認する
- [ ] クラス継承の階層が3段以上になっていないか。深い場合はトレイト合成パターンへの移行を検討する
- [ ] 公開 API のメソッドが不変操作（新インスタンスを返す）になっているか確認する
