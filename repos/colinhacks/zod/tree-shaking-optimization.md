# Tree-Shaking 最適化

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod v4 は `sideEffects: false` 宣言、`/*@__PURE__*/` / `// @__NO_SIDE_EFFECTS__` アノテーションの体系的な適用、そして classic/mini の2バリアント設計により、バンドラによるデッドコード除去を最大化している。特に mini バリアント（`zod/mini`）はメソッドチェーンを排し、standalone 関数 + `.check()` パターンで API を構成することで、未使用の検証ロジックがバンドルに含まれない構造を実現している。core 層を共有しながらも API レイヤーで tree-shaking 境界を変える設計は、同一ライブラリで DX とバンドルサイズの両立を図る手法として注目に値する。

## 背景にある原則

- **メソッドチェーンは tree-shaking の敵**: メソッドをプロトタイプやインスタンスに定義すると、bundler は「使われていないメソッド」を検出できない。`z.string().min(5)` のようなチェーンでは `.email()` も `.uuid()` も同一インスタンスに付くため、使わなくても除去されない。Zod はこの問題に対して classic（DX 重視・メソッド豊富）と mini（サイズ重視・関数ベース）の 2 バリアントで対応している（`src/v4/classic/schemas.ts` vs `src/v4/mini/schemas.ts`）

- **PURE アノテーションで bundler に副作用の不在を伝達する**: JavaScript の関数呼び出しは副作用を持ちうるため、bundler はデフォルトで除去できない。`/*@__PURE__*/` と `// @__NO_SIDE_EFFECTS__` を体系的に付与することで、bundler に「この呼び出しの戻り値が使われなければ除去してよい」と伝えている（core 全体で 126+ 箇所、mini で 168+ 箇所）

- **副作用の遅延注入で import コストを制御する**: classic は英語ロケールを `config(en())` でモジュール読み込み時に自動設定するが、mini はロケール設定をユーザーに委ねる。自動設定は DX を向上させるが、import するだけで副作用が発生するため、tree-shaking が効きにくくなる（`src/v4/classic/external.ts:10-11` vs `src/v4/mini/external.ts` にロケール自動設定なし）

- **共通 core + 薄い API レイヤーで重複を最小化する**: classic も mini も `src/v4/core/` の同一実装を使い、API レイヤーのみが異なる。core のファクトリ関数（`_string`, `_email` など）は Class パラメータを受け取り、呼び出し側が classic 用クラスか mini 用クラスかを決定する。これにより、ロジックの重複なしにバリアント分離を実現している（`src/v4/core/api.ts`）

## 実例と分析

### classic vs mini: メソッド数と tree-shaking 境界の違い

classic の `ZodType` は `optional()`, `nullable()`, `array()`, `transform()`, `pipe()`, `readonly()` など 20 以上のメソッドをインスタンスに付与する。これらは初期化時に全て定義されるため、`z.string()` を使うだけでも `ZodOptional`, `ZodNullable`, `ZodArray`, `ZodPipe` 等のコンストラクタが参照される。

一方、mini の `ZodMiniType` が持つインスタンスメソッドは `parse`, `safeParse`, `parseAsync`, `safeParseAsync`, `check`, `with`, `clone`, `brand`, `register`, `apply` のみ。wrapper 型は `optional(schema)`, `nullable(schema)` のようなスタンドアロン関数として提供され、使わなければバンドルに含まれない。

### `$constructor` パターン: クラスを使わない tree-shakable な型定義

Zod は ES6 クラス（`class ZodString extends ...`）を使わず、独自の `$constructor` 関数で型コンストラクタを定義する。`$constructor` 自体が `@__NO_SIDE_EFFECTS__` で注釈され、各コンストラクタ定義は `/*@__PURE__*/` で注釈される。これにより、使われないコンストラクタ（例: `ZodMiniKSUID`）はバンドルから完全に除去される。

ES6 クラスの `extends` は静的な副作用とみなされ、bundler が除去できないケースがある。`$constructor` パターンはこの制約を回避する。

### ファクトリ関数の Class パラメータ化

core のファクトリ関数は具象クラスをパラメータとして受け取る。`_string(ZodString, params)` と `_string(ZodMiniString, params)` は同一のファクトリ関数を使いつつ、生成されるインスタンスの型が異なる。これは、classic と mini で core ロジックを共有しながら tree-shaking 境界を分離するための戦略的な設計。

### 副作用の隔離: locale の自動 vs 手動設定

classic の `external.ts` は `import en from "../locales/en.js"; config(en());` をモジュールトップレベルで実行する。これはユーザーがロケール設定なしに即座にエラーメッセージを得られる DX を提供する。

mini の `external.ts` にはこの自動設定がない。ユーザーが `z.config(z.locales.en())` を明示的に呼ぶ必要がある。この設計により、ロケールデータ（各言語の全エラーメッセージ辞書）がバンドルに含まれるかどうかをユーザーが制御できる。

### stub package.json による `sideEffects: false` の伝播

ビルド後に `write-stub-package-jsons.ts` スクリプトが全サブディレクトリに `"sideEffects": false` を含む `package.json` を生成する。これにより、`zod/v4/core`, `zod/mini`, `zod/v4/locales` 等の深いパスからの import でも bundler が副作用の不在を認識できる。

### treeshake テストパッケージによる継続的なバンドルサイズ監視

`packages/treeshake/` ディレクトリに、各バリアント（classic, mini, zod3, valibot）で同一のユースケース（boolean, string, object, full）を実装したテストファイルが用意されている。Rollup の `treeshake: { preset: "smallest" }` 設定で bundle し、`rollup-plugin-bundle-size` と `rollup-plugin-filesize` でサイズを計測する仕組み。

## コード例

```typescript
// src/v4/core/core.ts:17-21
// $constructor 自体を @__NO_SIDE_EFFECTS__ で注釈
export /*@__NO_SIDE_EFFECTS__*/ function $constructor<T extends ZodTrait, D = T["_zod"]["def"]>(
  name: string,
  initializer: (inst: T, def: D) => void,
  params?: { Parent?: typeof Class }
): $constructor<T, D> {
```

```typescript
// src/v4/mini/schemas.ts:43-44,91-92
// コンストラクタ定義は /*@__PURE__*/ で注釈
export const ZodMiniType: core.$constructor<ZodMiniType> = /*@__PURE__*/ core.$constructor(
  "ZodMiniType",
  (inst, def) => { ... }
);

export const ZodMiniString: core.$constructor<ZodMiniString> = /*@__PURE__*/ core.$constructor(
  "ZodMiniString",
  (inst, def) => { ... }
);
```

```typescript
// src/v4/mini/schemas.ts:99-101
// ファクトリ関数は @__NO_SIDE_EFFECTS__ で注釈
// @__NO_SIDE_EFFECTS__
export function string(params?: string | core.$ZodStringParams): ZodMiniString<string> {
  return core._string(ZodMiniString, params) as any;
}
```

```typescript
// src/v4/core/api.ts:62-70
// core のファクトリは Class パラメータで具象型を受け取る
// @__NO_SIDE_EFFECTS__
export function _string<T extends schemas.$ZodString>(
  Class: util.SchemaClass<T>,
  params?: string | $ZodStringParams
): T {
  return new Class({
    type: "string",
    ...util.normalizeParams(params),
  });
}
```

```typescript
// src/v4/classic/external.ts:9-11
// classic は locale を自動設定（副作用あり）
import { config } from "../core/index.js";
import en from "../locales/en.js";
config(en());
```

```typescript
// src/v4/mini/external.ts:1-6
// mini は locale 自動設定なし（副作用なし）
export * as core from "../core/index.js";
export * from "./parse.js";
export * from "./schemas.js";
export * from "./checks.js";
```

```typescript
// scripts/write-stub-package-jsons.ts:6-13
// ビルド後にサブディレクトリへ sideEffects: false を伝播
const STUB_PACKAGE_JSON_CONTENT = `{
  "type": "module",
  "main": "./index.cjs",
  "module": "./index.js",
  "types": "./index.d.cts",
  "sideEffects": false
}
`;
```

```typescript
// src/v4/classic/schemas.ts:216-231
// classic: wrapper メソッドがインスタンスに直接付与される
// → z.string() だけで ZodOptional, ZodNullable 等を参照
inst.optional = () => optional(inst);
inst.nullable = () => nullable(inst);
inst.nullish = () => optional(nullable(inst));
inst.array = () => array(inst);
inst.or = (arg) => union([inst, arg]);
inst.and = (arg) => intersection(inst, arg);
inst.transform = (tx) => pipe(inst, transform(tx as any)) as never;
inst.pipe = (target) => pipe(inst, target);
inst.readonly = () => readonly(inst);
```

```typescript
// src/v4/core/regexes.ts:31-33
// 正規表現の遅延生成結果も /*@__PURE__*/ で注釈
export const uuid4: RegExp = /*@__PURE__*/ uuid(4);
export const uuid6: RegExp = /*@__PURE__*/ uuid(6);
export const uuid7: RegExp = /*@__PURE__*/ uuid(7);
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 同一 core ロジックに対して DX 重視（classic）とサイズ重視（mini）の API 層を切り替えたい
  - 適用条件: ライブラリが異なるユースケース（フルスタック vs エッジランタイム等）で異なるサイズ/機能トレードオフを求められる場合
  - コード例: `src/v4/classic/external.ts` と `src/v4/mini/external.ts` が同一 core を異なる API で公開
  - 注意点: バリアント間の型互換性を維持する必要がある（core 型を共有することで解決）

- **Abstract Factory パターン** (分類: 生成)
  - 解決する問題: 具象クラス（ZodString vs ZodMiniString）の選択をファクトリ関数のパラメータに委ねたい
  - 適用条件: 同一の生成ロジックを複数のバリアントで共有したい場合
  - コード例: `src/v4/core/api.ts:62-70` の `_string(Class, params)` パターン
  - 注意点: TypeScript の型推論と組み合わせる場合、Class パラメータの型制約が複雑になりうる

## Good Patterns

- **`@__NO_SIDE_EFFECTS__` + `/*@__PURE__*/` の使い分け**: `@__NO_SIDE_EFFECTS__` は関数宣言に使い「この関数は副作用がない」と伝達。`/*@__PURE__*/` は関数呼び出し式に使い「この特定の呼び出しは副作用がない」と伝達。Zod は前者をファクトリ関数に、後者をコンストラクタ定義（`$constructor(...)` の呼び出し）や正規表現の生成結果に体系的に適用している。

```typescript
// ファクトリ関数宣言 → @__NO_SIDE_EFFECTS__
// @__NO_SIDE_EFFECTS__
export function string(params?) { return core._string(ZodMiniString, params); }

// コンストラクタ定義式 → /*@__PURE__*/
export const ZodMiniString = /*@__PURE__*/ core.$constructor("ZodMiniString", ...);
```

- **stub package.json による deep import の副作用フリー宣言**: サブディレクトリごとに `"sideEffects": false` を含む package.json を自動生成することで、Webpack 等の bundler がサブパスからの import を安全に tree-shake できるようにしている。ビルドスクリプトに組み込むことで手動管理のミスを防止。

```typescript
// scripts/write-stub-package-jsons.ts
const STUB_PACKAGE_JSON_CONTENT = `{
  "type": "module",
  "sideEffects": false
}`;
```

- **treeshake テストパッケージによる回帰防止**: 各バリアントの典型的なユースケースを Rollup でバンドルし、サイズを計測するテスト環境を用意。CI やリリース前にバンドルサイズの回帰を検出できる。競合ライブラリ（valibot, zod3）との比較も同一条件で実行可能。

```javascript
// packages/treeshake/rollup.config.js
treeshake: {
  preset: "smallest",
  annotations: true,  // @__PURE__ を尊重
},
```

## Anti-Patterns / 注意点

- **メソッドチェーン API でのバンドルサイズ肥大**: classic の `ZodType` 初期化で 20 以上の wrapper メソッドが定義されるため、`z.string()` だけで `ZodOptional`, `ZodNullable`, `ZodArray`, `ZodPipe` 等のコンストラクタが参照チェーンに含まれる。

```typescript
// Bad: classic のインスタンス初期化（サイズ重視の場面で）
inst.optional = () => optional(inst);   // → ZodOptional を参照
inst.nullable = () => nullable(inst);   // → ZodNullable を参照
inst.array = () => array(inst);         // → ZodArray を参照
inst.transform = (tx) => pipe(inst, transform(tx)); // → ZodPipe, ZodTransform を参照
```

```typescript
// Better: mini のスタンドアロン関数（使わなければバンドルされない）
import { string, optional } from "zod/mini";
const schema = optional(string());  // optional を使う場合のみ import
```

- **モジュールトップレベルの副作用**: ロケール設定のようなグローバル状態変更をモジュールトップレベルで行うと、そのモジュールを import するだけで副作用が発生し、bundler が安全に除去できなくなる。

```typescript
// Bad: モジュールトップレベルでの副作用
import en from "../locales/en.js";
config(en());  // import 時に自動実行 → tree-shake 不可

// Better: ユーザーによる明示的な設定
import * as z from "zod/mini";
z.config(z.locales.en());  // ユーザーが必要な時に呼ぶ
```

## 導出ルール

- `[MUST]` ライブラリの package.json に `"sideEffects": false` を設定し、サブパス export がある場合はサブディレクトリにも同設定を伝播する
  - 根拠: Zod は `write-stub-package-jsons.ts` でビルド後に全サブディレクトリへ自動伝播しており、これがないと bundler がサブパスからの import を tree-shake できない

- `[MUST]` 副作用のない関数呼び出し式（IIFE、ファクトリ呼び出し、正規表現生成等）には `/*@__PURE__*/` を、副作用のない関数宣言には `// @__NO_SIDE_EFFECTS__` を付与する
  - 根拠: Zod は core だけで 126+、mini で 168+ のアノテーションを体系的に適用しており、これが tree-shaking の実効性を支えている

- `[SHOULD]` バンドルサイズが重要なライブラリでは、ES6 クラス継承（`extends`）を避け、関数ベースのコンストラクタパターンを使う
  - 根拠: Zod の `$constructor` パターンはクラス継承の副作用判定問題を回避し、使われないコンストラクタの完全除去を可能にしている

- `[SHOULD]` メソッドチェーン API とスタンドアロン関数 API の両方を提供し、共通 core 層で実装を共有する
  - 根拠: Zod は classic（DX 重視）と mini（サイズ重視）で同一 core を共有しつつ、API レイヤーだけを分離することで機能とサイズのトレードオフをユーザーに委ねている

- `[SHOULD]` tree-shaking の回帰を防ぐため、各バリアントの典型ユースケースを Rollup/esbuild でバンドルしサイズを計測するテスト環境を用意する
  - 根拠: `packages/treeshake/` で boolean/string/object/full の各ケースを classic, mini, zod3, valibot で比較測定する仕組みが存在する

- `[AVOID]` モジュールトップレベルでグローバル状態を変更する副作用コード（ロケール設定、ポリフィル注入等）をデフォルトエントリポイントに含める
  - 根拠: classic の `config(en())` はモジュール import 時に自動実行され、bundler がそのモジュール全体を除去できなくなる。mini はこれを排除して tree-shaking 効率を向上させている

- `[AVOID]` 型ごとのインスタンスに使われない可能性のあるメソッドを大量に付与する設計（サイズ重視のバリアントにおいて）
  - 根拠: classic の `ZodType` は `optional()`, `nullable()` 等 20 以上のメソッドを初期化時に付与し、それぞれが他のスキーマコンストラクタを参照するため、単純な `z.string()` でも大量の依存が発生する

## 適用チェックリスト

- [ ] package.json に `"sideEffects": false` が設定されているか確認する
- [ ] サブパス export がある場合、各サブディレクトリにも `"sideEffects": false` が伝播されているか確認する
- [ ] ファクトリ関数やコンストラクタ呼び出しに `/*@__PURE__*/` / `// @__NO_SIDE_EFFECTS__` が付与されているか確認する
- [ ] モジュールトップレベルに不要な副作用（グローバル設定、ポリフィル注入等）がないか確認する
- [ ] メソッドチェーン API がバンドルサイズに与える影響を計測し、必要に応じてスタンドアロン関数ベースの API バリアントを検討する
- [ ] Rollup/esbuild を使った tree-shaking テスト環境を構築し、典型ユースケースのバンドルサイズを継続的に監視する
- [ ] ES6 クラス継承がバンドルサイズに悪影響を与えていないか検証し、必要に応じて関数ベースのコンストラクタに移行する
- [ ] 共通 core + 薄い API レイヤーの構成で、バリアント間のロジック重複を排除できているか確認する
