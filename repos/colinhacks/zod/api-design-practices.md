# API Design Practices

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod のパブリック API は、バリデーションライブラリとして TypeScript エコシステム全体に浸透した設計上の意思決定の集積である。`z.string()`, `z.object()` 等のファクトリ関数パターン、`parse()`/`safeParse()` のデュアル API、`string | ParamsObject` のパラメータオーバーロード、classic/mini の 2 バリアント分離、そして v3 互換レイヤーの維持といった設計判断は、いずれも「API の使いやすさ」「型安全性」「ツリーシェイキング」「後方互換性」の間のトレードオフから導出されている。40,000 超のスターを持つライブラリが実践する API 設計プラクティスとして、汎用的な示唆に富む。

## 背景にある原則

- **最も一般的なユースケースを最短パスにする**: すべてのファクトリ関数は `params?: string | ParamsObject` のオーバーロードを採用し、エラーメッセージだけを指定したい場合は文字列リテラル一つで済む設計にしている。`normalizeParams` ユーティリティで内部的にオブジェクト形式に統一する (`packages/zod/src/v4/core/util.ts:509`)。これにより 80% のケースでオブジェクトリテラルの記述が不要になる。

- **失敗を値として表現する安全 API と、例外で表現する便利 API を常にペアで提供する**: `parse()` が例外を投げ、`safeParse()` が `{ success, data, error }` の判別共用体を返すデュアル API は、同じ操作に対して「楽観的パス」と「防御的パス」の両方を同一コストで提供する設計原則である (`packages/zod/src/v4/classic/schemas.ts:57-67`)。

- **コアロジックを共有し、API 表面だけを差し替える**: core レイヤーにバリデーションロジックと `_string`, `_number` 等のファクトリ関数を実装し、classic/mini の各バリアントはそれぞれの Class を注入するだけで API 表面を構築する。これにより一つのロジック変更が両バリアントに自動伝播する (`packages/zod/src/v4/core/api.ts:63-71` と `packages/zod/src/v4/classic/schemas.ts:430-432`)。

- **非推奨を明示しつつ動作を維持して移行コストを最小化する**: `@deprecated` JSDoc + 移行先メソッドの明示により、IDE が自動的にストライクスルーと移行先を表示する。compat レイヤー (`packages/zod/src/v4/classic/compat.ts`) で旧 API の型エイリアスを維持しつつ、実装は新 API に委譲している。

## 実例と分析

### ファクトリ関数パターンとパラメータ正規化

Zod のすべてのスキーマ生成関数は `z.string()`, `z.number()`, `z.object()` のように名前空間 `z` 上のフリー関数として公開される。パラメータは一貫して `params?: string | $ZodXxxParams` のユニオン型を受け取る。

```typescript
// packages/zod/src/v4/classic/schemas.ts:428-432
export function string(params?: string | core.$ZodStringParams): ZodString;
export function string<T extends string>(params?: string | core.$ZodStringParams): core.$ZodType<T, T>;
export function string(params?: string | core.$ZodStringParams): ZodString {
  return core._string(ZodString, params) as any;
}
```

内部で `normalizeParams` が呼ばれ、文字列は `{ error: () => params }` に変換される:

```typescript
// packages/zod/src/v4/core/util.ts:509-519
export function normalizeParams<T>(_params: T): Normalize<T> {
  const params: any = _params;
  if (!params) return {} as any;
  if (typeof params === "string") return { error: () => params } as any;
  if (params?.message !== undefined) {
    if (params?.error !== undefined) throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string") return { ...params, error: () => params.error } as any;
```

この設計により、ユーザーは `z.string("名前は必須です")` のように簡潔に書ける。

### コアロジックと API 表面の分離 (Class 注入パターン)

core レイヤーの `_string` は `Class` パラメータを受け取り、具象 Class の知識なしにインスタンスを生成する:

```typescript
// packages/zod/src/v4/core/api.ts:63-71
export function _string<T extends schemas.$ZodString>(
  Class: util.SchemaClass<T>,
  params?: string | $ZodStringParams,
): T {
  return new Class({
    type: "string",
    ...util.normalizeParams(params),
  });
}
```

classic バリアントは `ZodString`、mini バリアントは `ZodMiniString` を注入する:

```typescript
// packages/zod/src/v4/classic/schemas.ts:430-432
export function string(params?: string | core.$ZodStringParams): ZodString {
  return core._string(ZodString, params) as any;
}

// packages/zod/src/v4/mini/schemas.ts:100-102
export function string(params?: string | core.$ZodStringParams): ZodMiniString<string> {
  return core._string(ZodMiniString, params) as any;
}
```

### `$constructor` によるトレイトベースの型構築

Zod は class ベースの継承ではなく、`$constructor` 関数で trait 的な初期化チェーンを構築する:

```typescript
// packages/zod/src/v4/core/core.ts:17-77
export function $constructor<T extends ZodTrait, D = T["_zod"]["def"]>(
  name: string,
  initializer: (inst: T, def: D) => void,
  params?: { Parent?: typeof Class }
): $constructor<T, D> {
  function init(inst: T, def: D) {
    if (!inst._zod) {
      Object.defineProperty(inst, "_zod", { value: { def, constr: _, traits: new Set() }, enumerable: false });
    }
    if (inst._zod.traits.has(name)) return;
    inst._zod.traits.add(name);
    initializer(inst, def);
    // ...
  }
```

`ZodString` の初期化では `core.$ZodString.init` → `_ZodString.init` → `ZodType.init` と trait チェーンが走り、各レイヤーがメソッドを付与する (`packages/zod/src/v4/classic/schemas.ts:289-318`, `393-426`)。`instanceof` は traits Set で判定される (`core.ts:69-73`)。

### parse / safeParse のデュアル API 設計

すべての実行メソッドに `safe` プレフィクス版が存在する。同期・非同期、エンコード・デコードの全組み合わせに対応:

```typescript
// packages/zod/src/v4/classic/schemas.ts:57-89
parse(data: unknown, params?: core.ParseContext): core.output<this>;
safeParse(data: unknown, params?: core.ParseContext): parse.ZodSafeParseResult<core.output<this>>;
parseAsync(data: unknown, params?: core.ParseContext): Promise<core.output<this>>;
safeParseAsync(data: unknown, params?: core.ParseContext): Promise<parse.ZodSafeParseResult<core.output<this>>>;
// encode/decode にも同パターン
encode(data: core.output<this>, params?: core.ParseContext): core.input<this>;
safeEncode(data: core.output<this>, params?: core.ParseContext): parse.ZodSafeParseResult<core.input<this>>;
```

結果型は判別共用体で、`success` フィールドで分岐可能:

```typescript
// packages/zod/src/v4/classic/parse.ts:4-6
export type ZodSafeParseResult<T> = ZodSafeParseSuccess<T> | ZodSafeParseError<T>;
export type ZodSafeParseSuccess<T> = { success: true; data: T; error?: never; };
export type ZodSafeParseError<T> = { success: false; data?: never; error: ZodError<T>; };
```

`error?: never` / `data?: never` により、`success` チェック後に補完候補が正しく絞り込まれる。

### メソッドチェーンによるイミュータブル操作

`check()`, `optional()`, `array()` 等のメソッドは常に新しいインスタンスを返す:

```typescript
// packages/zod/src/v4/classic/schemas.ts:171-185
inst.check = (...checks) => {
  return inst.clone(
    util.mergeDefs(def, {
      checks: [...(def.checks ?? []), ...checks.map((ch) => ...)],
    }),
    { parent: true }
  );
};
```

`clone` は `parent` 参照を保持し、メタデータの継承を実現する (`packages/zod/src/v4/core/util.ts:485-489`)。

### 非推奨 API の移行パターン

v4 で string format を独立型に昇格させた際、旧 `.email()` メソッドは `@deprecated` + 移行先を JSDoc で明示しつつ動作を維持:

```typescript
// packages/zod/src/v4/classic/schemas.ts:323-324
/** @deprecated Use `z.email()` instead. */
email(params?: string | core.$ZodCheckEmailParams): this;
```

型エイリアスによる旧名維持:

```typescript
// packages/zod/src/v4/classic/compat.ts:58-63
export type {
  /** @deprecated Use `z.ZodType` */
  ZodType as Schema,
  /** @deprecated Use `z.ZodType` */
  ZodType as ZodSchema,
  /** @deprecated Use z.ZodType (without generics) instead. */
  ZodType as ZodTypeAny,
};
```

### 名前空間による関連 API のグルーピング

`coerce`, `iso`, `locales` を名前空間エクスポートでグルーピングし、名前衝突を防ぎつつ発見性を確保:

```typescript
// packages/zod/src/v4/classic/external.ts:41-51
export * as locales from "../locales/index.js";
export * as coerce from "./coerce.js";
export * as iso from "./iso.js";
```

これにより `z.coerce.string()`, `z.iso.datetime()` のように使える。

## コード例

```typescript
// packages/zod/src/v4/classic/schemas.ts:1677-1691
// TypeScript の予約語 enum を関数名として使うための _enum + export { _enum as enum } パターン
function _enum<const T extends readonly string[]>(
  values: T,
  params?: string | core.$ZodEnumParams,
): ZodEnum<util.ToEnum<T[number]>>;
function _enum<const T extends util.EnumLike>(entries: T, params?: string | core.$ZodEnumParams): ZodEnum<T>;
function _enum(values: any, params?: string | core.$ZodEnumParams) {
  const entries: any = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...util.normalizeParams(params),
  }) as any;
}
export { _enum as enum };
```

```typescript
// packages/zod/src/v4/classic/schemas.ts:1461-1485
// tuple のオーバーロード: rest パラメータの有無で呼び出しシグネチャを分離
export function tuple<T extends readonly [core.SomeType, ...core.SomeType[]]>(
  items: T,
  params?: string | core.$ZodTupleParams,
): ZodTuple<T, null>;
export function tuple<T extends readonly [core.SomeType, ...core.SomeType[]], Rest extends core.SomeType>(
  items: T,
  rest: Rest,
  params?: string | core.$ZodTupleParams,
): ZodTuple<T, Rest>;
export function tuple(items: [], params?: string | core.$ZodTupleParams): ZodTuple<[], null>;
export function tuple(
  items: core.SomeType[],
  _paramsOrRest?: string | core.$ZodTupleParams | core.SomeType,
  _params?: string | core.$ZodTupleParams,
) {
  const hasRest = _paramsOrRest instanceof core.$ZodType;
  const params = hasRest ? _params : _paramsOrRest;
  const rest = hasRest ? _paramsOrRest : null;
  return new ZodTuple({ type: "tuple", items: items as any, rest, ...util.normalizeParams(params) });
}
```

```typescript
// packages/zod/src/v4/core/core.ts:69-73
// instanceof をトレイトの Set で判定 — クラス継承に依存しない
Object.defineProperty(_, Symbol.hasInstance, {
  value: (inst: any) => {
    if (params?.Parent && inst instanceof params.Parent) return true;
    return inst?._zod?.traits?.has(name);
  },
});
```

## パターンカタログ

- **Abstract Factory / Class 注入** (分類: 生成)
  - 解決する問題: 同じバリデーションロジックから、API 表面の異なる複数バリアント (classic/mini) を生成する
  - 適用条件: 内部ロジックは共通だが、公開インターフェースのサイズや機能セットを変えたい場合
  - コード例: `packages/zod/src/v4/core/api.ts:63-71` — `_string(Class, params)` が Class を外部から受け取る
  - 注意点: `/*@__PURE__*/` や `@__NO_SIDE_EFFECTS__` アノテーションをファクトリに付与しないとツリーシェイキングが効かない

- **Fluent Builder / メソッドチェーン** (分類: 生成)
  - 解決する問題: スキーマ定義を宣言的・段階的に構築する
  - 適用条件: 設定のバリエーションが多く、組み合わせの爆発を避けたい場合
  - コード例: `packages/zod/src/v4/classic/schemas.ts:156-259` — `ZodType` の初期化でチェーン用メソッドを付与
  - 注意点: 各メソッドが新インスタンスを返すイミュータブル設計でなければ、参照共有によるバグが発生する

- **Discriminated Union (結果型)** (分類: 振る舞い)
  - 解決する問題: 成功/失敗を例外ではなく値として型安全に表現する
  - 適用条件: 呼び出し元が成功・失敗の両方をハンドリングする必要がある場面
  - コード例: `packages/zod/src/v4/classic/parse.ts:4-6` — `ZodSafeParseResult<T>`
  - 注意点: `error?: never` / `data?: never` を付与しないと、TypeScript の narrowing が不完全になる

## Good Patterns

- **`string | ParamsObject` のパラメータオーバーロード**: 最も一般的なユースケース (エラーメッセージのみ) を文字列リテラル一つで完結させ、詳細設定が必要な場合のみオブジェクトを使わせる。`normalizeParams` で内部統一することで実装側の分岐を最小化。

```typescript
// 利用者視点
z.string("名前は必須です")             // 簡潔
z.string({ minLength: 1, error: "..." }) // 詳細

// 実装側: packages/zod/src/v4/core/util.ts:509-513
export function normalizeParams<T>(_params: T): Normalize<T> {
  if (!params) return {} as any;
  if (typeof params === "string") return { error: () => params } as any;
```

- **`never` フィールドによる判別共用体の完全分離**: `ZodSafeParseSuccess` に `error?: never`、`ZodSafeParseError` に `data?: never` を設定することで、TypeScript の制御フロー分析が確実に動作する。

```typescript
// packages/zod/src/v4/classic/parse.ts:5-6
export type ZodSafeParseSuccess<T> = { success: true; data: T; error?: never; };
export type ZodSafeParseError<T> = { success: false; data?: never; error: ZodError<T>; };
```

- **エイリアスメソッドによる API の発見性向上**: `min` は `gte` のエイリアス、`max` は `lte` のエイリアス、`spa` は `safeParseAsync` のエイリアス。ドメインに馴染みのある名前と技術的に正確な名前の両方を提供する。

```typescript
// packages/zod/src/v4/classic/schemas.ts:849-853
inst.gte = (value, params) => inst.check(checks.gte(value, params));
inst.min = (value, params) => inst.check(checks.gte(value, params));
inst.lte = (value, params) => inst.check(checks.lte(value, params));
inst.max = (value, params) => inst.check(checks.lte(value, params));
```

- **`object()` / `strictObject()` / `looseObject()` のバリエーション分離**: 共通の基盤 (`ZodObject`) を使いつつ、未認識キーの扱い (strip/strict/loose) を関数名で明示。設定オブジェクトにフラグを埋めるより発見しやすく、意図が明確。

```typescript
// packages/zod/src/v4/classic/schemas.ts:1286-1324
export function object<T>(shape?: T, params?): ZodObject<T, core.$strip> {/* strip */}
export function strictObject<T>(shape: T, params?): ZodObject<T, core.$strict> {/* catchall: never() */}
export function looseObject<T>(shape: T, params?): ZodObject<T, core.$loose> {/* catchall: unknown() */}
```

## Anti-Patterns / 注意点

- **オーバーロードの実装シグネチャでの `any` の多用**: Zod のオーバーロード実装では型安全性を犠牲にして `any` を多用している。ライブラリ内部では許容されるが、アプリケーションコードで同様のパターンを使うと型チェックの恩恵を失う。

```typescript
// Bad: オーバーロード実装で any に頼る
function tuple(items: core.SomeType[], _paramsOrRest?: string | core.$ZodTupleParams | core.SomeType, _params?: any) {
  // ...
  return new ZodTuple({ ... }) as any;  // 型アサーション
}

// Better: ジェネリクスと条件型で型を保持する（ただしオーバーロードが複雑な場合はトレードオフ）
// 公開シグネチャで型安全性を確保し、実装シグネチャの any は最小限に留める
```

- **名前空間と直接エクスポートの重複**: `z.iso.datetime()` と旧 `z.string().datetime()` の両方が存在する過渡期の設計。API のマイグレーション期間中は避けられないが、長期的には一方に集約すべき。

```typescript
// Bad: 同じ機能に 2 つのパスが存在
z.string().datetime(); // deprecated
z.iso.datetime(); // 推奨

// Better: 非推奨期間を設定し、将来のメジャーバージョンで旧 API を削除する計画を明示
```

## 導出ルール

- `[MUST]` 失敗しうる操作には「例外を投げるバージョン」と「結果型を返すバージョン」の両方を提供し、結果型には判別フィールド (`success`) と相互排他的な `never` フィールドを設定する
  - 根拠: Zod の `parse`/`safeParse` のデュアル API は `ZodSafeParseSuccess.error?: never` により TypeScript の narrowing を完全にする設計で、40,000+ スターのユーザーベースで検証済み (`packages/zod/src/v4/classic/parse.ts:4-6`)

- `[MUST]` パブリック API のパラメータが「エラーメッセージ」や「説明文」のような単一文字列で済む頻度が高い場合、`params?: string | ParamsObject` のユニオン型を採用し、内部で正規化する
  - 根拠: Zod のすべてのファクトリ関数がこのパターンを採用し、`normalizeParams` で統一することで、利用者の 80% のケースを `z.string("必須")` の 1 引数で完結させている (`packages/zod/src/v4/core/util.ts:509-519`)

- `[SHOULD]` 同一ロジックから API 表面の異なる複数バリアントを生成する場合、ロジックを共有レイヤーに実装し、具象 Class を外部から注入するファクトリパターンを使う
  - 根拠: Zod は core レイヤーの `_string(Class, params)` パターンで classic/mini 両バリアントのコード重複を排除し、バグ修正が全バリアントに自動伝播する (`packages/zod/src/v4/core/api.ts:63-71`)

- `[SHOULD]` メソッドチェーンを提供する API では、各メソッドが新インスタンスを返すイミュータブル設計にし、`clone` 時に `parent` 参照を保持してメタデータの継承を可能にする
  - 根拠: Zod の `check()` メソッドは `inst.clone(newDef, { parent: true })` で毎回新インスタンスを生成し、参照共有によるバグを防止している (`packages/zod/src/v4/classic/schemas.ts:171-185`)

- `[SHOULD]` 非推奨 API は `@deprecated` JSDoc に移行先を明記し、型エイリアス + 実装委譲で動作を維持する。compat レイヤーを独立ファイルに分離して保守性を確保する
  - 根拠: Zod の `compat.ts` は旧型名 (`ZodTypeAny`, `ZodSchema`) を現行型への型エイリアスとして維持し、IDE のストライクスルー表示で段階的移行を促進している (`packages/zod/src/v4/classic/compat.ts:57-64`)

- `[SHOULD]` 関連する API をサブ名前空間にグルーピングし (`z.coerce.*`, `z.iso.*`)、トップレベルの名前空間汚染を防ぐ。頻用 API はトップレベルにも重複エクスポートして発見性を確保する
  - 根拠: `z.iso.datetime()` は名前空間で整理しつつ、`ZodISODateTime` はトップレベルでもエクスポートされている (`packages/zod/src/v4/classic/external.ts:39-41`)

- `[AVOID]` メソッドチェーン API で元のインスタンスを変更 (mutate) する設計にすること。スキーマの共有・再利用時に予期しない副作用が発生する
  - 根拠: Zod は `check()`, `optional()` 等のメソッドすべてで `clone` を使い新インスタンスを返す設計を一貫させている (`packages/zod/src/v4/classic/schemas.ts:171-232`)

## 適用チェックリスト

- [ ] ライブラリのファクトリ関数で、最も頻繁なユースケースが文字列 1 つで済む場合、`string | ParamsObject` のパラメータパターンを導入し、`normalizeParams` 的な正規化関数を用意しているか
- [ ] 失敗しうる操作に対して、例外版と結果型版の両方を提供しているか。結果型は判別共用体 + `never` フィールドで narrowing が完全か
- [ ] メソッドチェーンを提供する API で、各メソッドがイミュータブルに新インスタンスを返しているか。元のインスタンスを変更していないか
- [ ] 複数バリアント (軽量版・フル版等) が必要な場合、共通ロジックを分離して Class 注入パターンを使っているか
- [ ] 非推奨 API に `@deprecated` + 移行先を明記し、compat レイヤーで動作を維持しているか
- [ ] 関連 API を名前空間でグルーピングし、トップレベルの名前衝突を防いでいるか
- [ ] TypeScript の予約語と衝突する関数名 (`enum` 等) に対して `_enum` + `export { _enum as enum }` パターンを使っているか
