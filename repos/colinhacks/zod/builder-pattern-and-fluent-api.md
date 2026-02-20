# Builder Pattern and Fluent API

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod v4 のスキーマビルダーにおけるメソッドチェーン設計と型安全な API 合成を分析する。Zod は `z.string().min(5).email()` のような fluent API と `z.object({}).pick().extend()` のようなスキーマ合成を提供するが、その裏側では「不変クローン + チェック合成」「トレイトベースの多重初期化」「型レベルの `this` 返却」という3つの独自設計が一貫して使われている。これらのプラクティスは、バリデーションライブラリに限らず、メソッドチェーンを持つあらゆる TypeScript API 設計に応用できる。

## 背景にある原則

- **不変性による安全なチェーン**: 各メソッドチェーンの呼び出しは元のインスタンスを変更せず、新しいインスタンスを `clone()` で生成して返す。これにより、スキーマの参照共有が安全になり、`const base = z.string(); const a = base.min(5); const b = base.max(10);` のように1つのスキーマから分岐できる。根拠: `util.ts:485-489` の `clone` 関数が `new inst._zod.constr(def ?? inst._zod.def)` で常に新インスタンスを生成する。

- **宣言的定義 + 遅延評価**: スキーマの構造は `def` オブジェクト（プレーンデータ）として宣言し、実際の解析ロジックはコンストラクタ内で遅延的に組み立てる。`shape` プロパティは getter で遅延評価され、`cached()` ユーティリティでメモ化される。根拠: `schemas.ts:1866-1878` で `Object.defineProperty` による自己書き換え getter を使い、初回アクセス時のみ shape を展開する。

- **合成可能な制約の分離**: バリデーション制約（check）をスキーマ型から独立したオブジェクトとして設計し、`.check()` メソッドで任意のスキーマに付加できるようにしている。これにより、制約の再利用と合成が可能になる。根拠: `checks.ts` の `$ZodCheck` は `$ZodType` とは独立した `$constructor` であり、`onattach` フックでスキーマにメタデータを注入する。

- **インターフェース分離による API 層の段階化**: core 層（`$ZodType`）は解析ロジックのみを持ち、classic 層（`ZodType`）が fluent メソッド（`.optional()`, `.transform()` 等）を追加し、mini 層はさらに軽量な API を提供する。これにより、ユーザーは用途に応じた API 表面を選択でき、ツリーシェイキングで不要なコードを除去できる。根拠: `classic/schemas.ts:156` の `ZodType` が `core.$ZodType.init()` を呼んだ上で fluent メソッドを追加し、`mini/schemas.ts:43` の `ZodMiniType` は最小限のメソッドのみを持つ。

## 実例と分析

### 不変クローンによるメソッドチェーン

Zod の fluent メソッドは全て `inst.check()` を通じて新しいインスタンスを返す。`check()` メソッドは定義の `checks` 配列に新しいチェックを追加した新しい `def` で `clone()` を呼ぶ。

```typescript
// classic/schemas.ts:171-185
inst.check = (...checks) => {
  return inst.clone(
    util.mergeDefs(def, {
      checks: [
        ...(def.checks ?? []),
        ...checks.map((ch) =>
          typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch
        ),
      ],
    }),
    {
      parent: true,
    },
  );
};
```

この設計により、型固有のメソッド（`.min()`, `.regex()` 等）は全て `inst.check(checks.XXX(...args))` の1行で実装できる。

```typescript
// classic/schemas.ts:301-307
inst.regex = (...args) => inst.check(checks.regex(...args));
inst.includes = (...args) => inst.check(checks.includes(...args));
inst.startsWith = (...args) => inst.check(checks.startsWith(...args));
inst.min = (...args) => inst.check(checks.minLength(...args));
inst.max = (...args) => inst.check(checks.maxLength(...args));
inst.length = (...args) => inst.check(checks.length(...args));
```

### `clone` 関数の簡潔な設計

```typescript
// core/util.ts:485-489
export function clone<T extends schemas.$ZodType>(
  inst: T,
  def?: T["_zod"]["def"],
  params?: { parent: boolean; },
): T {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent) cl._zod.parent = inst;
  return cl as any;
}
```

`_zod.constr` にコンストラクタ参照を保持することで、サブクラスの型を保ったままクローンできる。`parent` チェーンはメタデータの伝播（`describe`, `meta` 等）に使われる。

### mergeDefs によるプロパティ記述子の合成

```typescript
// core/util.ts:308-317
export function mergeDefs(...defs: Record<string, any>[]): any {
  const mergedDescriptors: Record<string, PropertyDescriptor> = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
```

`Object.getOwnPropertyDescriptors` を使うことで、getter を持つ `def` プロパティ（遅延評価される `shape` 等）がコピー時に展開されず、そのまま保持される。通常のスプレッド演算子 `{ ...def }` では getter が即座に評価されてしまうため、これは意図的な設計判断である。

### オブジェクトスキーマ合成: pick / omit / extend / partial

これらのメソッドは全て同一パターンに従う: (1) 既存の `def` をベースに `shape` を getter で遅延定義した新しい `def` を `mergeDefs` で合成し、(2) `clone` で新インスタンスを生成する。

```typescript
// core/util.ts:593-620
export function pick(schema: schemas.$ZodObject, mask: Record<string, unknown>): any {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".pick() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape: Writeable<schemas.$ZodShape> = {};
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key]) continue;
        newShape[key] = currDef.shape[key]!;
      }
      assignProp(this, "shape", newShape); // self-caching
      return newShape;
    },
  });
  return clone(schema, def) as any;
}
```

注目すべきは `assignProp(this, "shape", newShape)` による自己キャッシュ getter パターンである。初回アクセスで getter を通常のプロパティに書き換え、以降のアクセスコストをゼロにする。

### pipe と transform によるチェーン変換

`pipe` はスキーマ A の出力をスキーマ B の入力に渡す合成を行い、`transform` は値変換を行う。fluent API では `.transform(fn)` が内部的に `.pipe(inst, transform(fn))` として実装される。

```typescript
// classic/schemas.ts:225
inst.transform = (tx) => pipe(inst, transform(tx as any)) as never;
```

型レベルでは、`transform` の返り値型が `ZodPipe<this, ZodTransform<Awaited<NewOut>, core.output<this>>>` として正確に推論される。

### トレイトベースの多重初期化

`$constructor` は GoF のテンプレートメソッドパターンの変種で、`init` メソッドによる「トレイトの段階的適用」を実現している。

```typescript
// classic/schemas.ts:289-290
core.$ZodString.init(inst, def); // core 層の解析ロジック
ZodType.init(inst, def); // classic 層の fluent メソッド
```

`_zod.traits` セット（`core.ts:34`）で重複初期化を防止し、同じトレイトが二度適用されないことを保証する。これにより、`ZodNumberFormat` は `ZodNumber.init` -> `ZodType.init` と初期化でき、`ZodNumber` のメソッドを継承しつつ追加のフォーマットチェックを持てる。

### `this` 返却による型安全なサブタイプチェーン

fluent メソッドの返り値型に `this` を使うことで、サブタイプのメソッドチェーンが型安全に保たれる。

```typescript
// classic/schemas.ts:269-275
regex(regex: RegExp, params?: string | core.$ZodCheckRegexParams): this;
includes(value: string, params?: string | core.$ZodCheckIncludesParams): this;
min(minLength: number, params?: string | core.$ZodCheckMinLengthParams): this;
max(maxLength: number, params?: string | core.$ZodCheckMaxLengthParams): this;
```

`this` 返却のため、`ZodEmail` で `.min(5)` を呼んでも返り値は `ZodString` にダウンキャストされず `ZodEmail` のままであり、型の精度が保たれる。

### ラッパーメソッドによる型変換チェーン

`.optional()`, `.nullable()`, `.default()` などのラッパーメソッドは `this` ではなく新しいラッパー型を返す。これにより、型レベルで「optional な string」と「plain string」が区別される。

```typescript
// classic/schemas.ts:102-106
optional(): ZodOptional<this>;
exactOptional(): ZodExactOptional<this>;
nonoptional(params?: string | core.$ZodNonOptionalParams): ZodNonOptional<this>;
nullable(): ZodNullable<this>;
nullish(): ZodOptional<ZodNullable<this>>;
```

`.nullish()` が `optional(nullable(inst))` と合成されるのは、ラッパー型が Generic で元のスキーマ型を保持しているからこそ可能な設計である。

## パターンカタログ

- **Builder パターン** (分類: 生成)
  - 解決する問題: 複雑なオブジェクト構築の段階的な構成
  - 適用条件: ビルダーの各ステップが独立しており、任意の順序で呼べる場合
  - コード例: `classic/schemas.ts:171-185` の `inst.check()` メソッド
  - 注意点: Zod は「不変ビルダー」を採用。GoF の典型的なビルダーは可変だが、Zod は毎回 clone する

- **Decorator パターン** (分類: 構造)
  - 解決する問題: 既存オブジェクトに動的に機能を追加する
  - 適用条件: 基底型を変更せずに振る舞いを追加・合成したい場合
  - コード例: `core/schemas.ts:3343-3370` の `$ZodOptional` が `$ZodType` をラップし、`undefined` を許可する振る舞いを追加
  - 注意点: ラッパーの深いネストはデバッグを困難にする（Zod は `parent` チェーンで軽減）

- **Composite パターン** (分類: 構造)
  - 解決する問題: 個別オブジェクトと合成オブジェクトを統一的に扱う
  - 適用条件: チェック（制約）を個別にも、配列としても同じ API で扱いたい場合
  - コード例: `core/schemas.ts:192-204` で `checks` 配列をイテレートして順次実行
  - 注意点: チェック間の順序依存性がある場合（abort フラグ）、実行順が重要になる

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: アルゴリズムの骨格を定義し、詳細をサブクラスに委譲する
  - 適用条件: 初期化の「骨格」（トレイト適用順序）を固定しつつ、各トレイトの詳細を変えたい場合
  - コード例: `core/core.ts:17-77` の `$constructor` 関数。`init` による段階的初期化がテンプレートメソッドに相当
  - 注意点: 初期化順序に依存関係がある場合、呼び出し順を間違えるとバグになる

## Good Patterns

- **Self-caching getter**: 初回アクセスで値を計算し、自身を通常プロパティに書き換えることで以降のアクセスコストをゼロにする。

```typescript
// core/util.ts:593-620（pick 内の shape getter）
get shape() {
  const newShape = {};
  for (const key in mask) {
    if (!mask[key]) continue;
    newShape[key] = currDef.shape[key]!;
  }
  assignProp(this, "shape", newShape); // getter を通常プロパティに置換
  return newShape;
}
```

- **Check-as-first-class-object**: バリデーション制約をスキーマから分離し、独立したオブジェクトとして扱う。これにより、制約の再利用・合成・選択的適用が容易になる。

```typescript
// z.string().check(z.minLength(5), z.regex(/abc/))
// 同じチェックを別のスキーマにも適用可能
const myCheck = z.minLength(5);
z.string().check(myCheck);
z.array(z.string()).check(myCheck); // 配列の長さにも適用可能
```

- **normalizeParams による入力の正規化**: ユーザーが `string | ParamsObject` のどちらでも渡せるよう、入力を正規化する関数を一箇所にまとめる。

```typescript
// core/util.ts:509-519
export function normalizeParams<T>(_params: T): Normalize<T> {
  const params: any = _params;
  if (!params) return {} as any;
  if (typeof params === "string") return { error: () => params } as any;
  // ...
}
```

- **mergeDefs によるプロパティ記述子レベルの合成**: スプレッド演算子ではなく `Object.getOwnPropertyDescriptors` を使い、getter/setter を保持したままオブジェクトを合成する。

```typescript
// core/util.ts:308-317
export function mergeDefs(...defs: Record<string, any>[]): any {
  const mergedDescriptors: Record<string, PropertyDescriptor> = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
```

## Anti-Patterns / 注意点

- **可変ビルダーでの参照共有バグ**: ビルダーが可変（ミュータブル）だと、共有された参照を通じて意図しない変更が伝播する。

```typescript
// Bad: 可変ビルダー
class SchemaBuilder {
  private checks: Check[] = [];
  min(n: number) { this.checks.push(minCheck(n)); return this; }
}
const base = new SchemaBuilder();
const a = base.min(5); // base.checks が変更される
const b = base.min(10); // a にも min(10) が入ってしまう

// Better: 不変ビルダー（Zod の方式）
min(n: number) {
  return this.clone({ checks: [...this.checks, minCheck(n)] });
}
```

- **スプレッド演算子での getter 消失**: `{ ...obj }` は getter を即座に評価し、遅延評価のメリットを失う。

```typescript
// Bad: getter が展開されてしまう
const newDef = { ...oldDef, shape: computeExpensiveShape() };

// Better: mergeDefs でプロパティ記述子ごとコピーする
const newDef = mergeDefs(oldDef, {
  get shape() {
    return computeExpensiveShape();
  },
});
```

- **refinement 付きオブジェクトの構造変更**: `.pick()`, `.omit()`, `.partial()` はスキーマの構造を変更するが、既存の refinement がどのフィールドに依存しているか判定できない。Zod はこれをランタイムエラーで禁止している。

```typescript
// Bad: refinement があるオブジェクトの pick は例外
const schema = z.object({ a: z.string(), b: z.number() })
  .refine(obj => obj.a.length < obj.b);
schema.pick({ a: true }); // Error: .pick() cannot be used on object schemas containing refinements

// Better: refinement を pick 後に追加する
z.object({ a: z.string(), b: z.number() })
  .pick({ a: true, b: true })
  .refine(obj => obj.a.length < obj.b);
```

## 導出ルール

- `[MUST]` fluent API のメソッドチェーンでは、各メソッドが新しいインスタンスを返す不変ビルダーを採用する — 可変ビルダーは参照共有時に意図しない副作用を引き起こす
  - 根拠: Zod の `check()` メソッドは毎回 `clone()` で新インスタンスを生成し、元のスキーマを不変に保つ（`classic/schemas.ts:171-185`）

- `[MUST]` ビルダーの `clone()` では、サブクラスのコンストラクタ参照を保持して型を維持する — `new this.constructor()` や保存されたコンストラクタ参照を使い、サブタイプ情報を失わない
  - 根拠: Zod は `inst._zod.constr` にコンストラクタを保存し、`clone` 時に同じコンストラクタで new する（`core/util.ts:485-489`）

- `[SHOULD]` fluent メソッドの返り値型に `this` を使い、サブタイプでのチェーン時に型がダウンキャストされないようにする
  - 根拠: `_ZodString` インターフェースの全メソッドが `this` を返し、`ZodEmail extends _ZodString` でもチェーンの型精度が保たれる（`classic/schemas.ts:269-275`）

- `[SHOULD]` 遅延評価が必要なプロパティには自己書き換え getter（self-caching getter）を使い、初回計算後のアクセスコストを除去する
  - 根拠: `pick`/`omit`/`extend` の shape getter が `assignProp(this, "shape", newShape)` で自身を通常プロパティに置換する（`core/util.ts:602-613`）

- `[SHOULD]` バリデーション制約をスキーマ型から独立したオブジェクトとして設計し、`onattach` のようなフックでスキーマにメタデータを注入する
  - 根拠: `$ZodCheck` が独立した `$constructor` であり、`onattach` でスキーマの `bag` にメタデータ（minimum, maximum 等）を書き込む（`core/checks.ts:70-77`）

- `[SHOULD]` ユーザー入力の正規化関数を一箇所にまとめ、`string | OptionsObject` のような union 型パラメータに対応する
  - 根拠: `normalizeParams` が全ファクトリ関数で一貫して使われ、文字列ショートカットとオブジェクト指定を統一的に処理する（`core/util.ts:509-519`）

- `[SHOULD]` getter を含むオブジェクトの合成には `Object.getOwnPropertyDescriptors` を使い、スプレッド演算子による getter の即時評価を避ける
  - 根拠: `mergeDefs` がプロパティ記述子レベルで合成し、遅延評価 getter をコピー先でも保持する（`core/util.ts:308-317`）

- `[AVOID]` 構造変更メソッド（pick/omit/partial）と制約追加メソッド（refine/check）を同じインスタンスに対して順序不定で混在させることを許容する設計 — 構造変更が制約の前提を壊す可能性がある
  - 根拠: Zod は refinement 付きオブジェクトへの `pick`/`omit`/`partial` をランタイムエラーで明示的に禁止している（`core/util.ts:597-599`）

## 適用チェックリスト

- [ ] fluent API の各メソッドが新しいインスタンスを返しているか（既存インスタンスを変更していないか）
- [ ] `clone()` がサブクラスの型を維持しているか（コンストラクタ参照を保存しているか）
- [ ] fluent メソッドの返り値型が `this` になっているか（サブタイプのチェーンが安全か）
- [ ] 制約（validation check）がスキーマ型から独立したオブジェクトになっているか
- [ ] 遅延評価が必要なプロパティに self-caching getter を適用しているか
- [ ] getter を含むオブジェクトの合成でスプレッド演算子を使っていないか
- [ ] 構造変更と制約追加の順序制約をドキュメントまたはランタイムエラーで明示しているか
- [ ] ユーザー入力の正規化（string shortcut 等）を一箇所にまとめているか
