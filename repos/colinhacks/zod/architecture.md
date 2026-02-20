# architecture

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod v4 は、v3 のクラス継承ベースのモノリシック設計を、トレイトベースの構成的アーキテクチャに置き換えた。`core` レイヤーが全スキーマの解析・型推論・エラー処理を担い、`classic`（フルAPI）と `mini`（軽量API）がその上にファサードを構築する三層構成を採用している。この設計により、単一パッケージ内で API サーフェスの異なる複数のビルドターゲットを提供しつつ、コアロジックの重複をゼロにしている。バンドルサイズ最適化（`sideEffects: false`、`@__PURE__`/`@__NO_SIDE_EFFECTS__` アノテーション）とランタイムパフォーマンス（JIT コード生成、遅延初期化）が設計の主要な駆動力である。

## 背景にある原則

- **コア分離の原則**: バリデーションロジック・型定義・エラー体系は一箇所に集約し、API サーフェスの差異はファサード層で吸収する。Zod では `v4/core/` が全スキーマの解析ロジックを持ち、`v4/classic/` と `v4/mini/` はメソッドバインディングとエラークラスの差異だけを担う。これにより、バリデーション動作の不整合が構造的に発生しない（`packages/zod/src/v4/mini/parse.ts` は core の関数をそのまま re-export している）。

- **トレイト合成による継承代替**: クラス継承チェーンの代わりに、`$constructor` + `init()` のトレイトパターンで型の振る舞いを合成する。各コンストラクタは `inst._zod.traits` に名前を記録し、`Symbol.hasInstance` をオーバーライドしてトレイト名ベースの `instanceof` チェックを可能にする（`src/v4/core/core.ts:69-73`）。これにより、多重継承が不可能な JavaScript で、スキーマが複数のトレイトを同時に実装できる。

- **Tree-shaking ファーストの設計**: `sideEffects: false` を宣言し、全コンストラクタに `@__PURE__` アノテーションを付与する。遅延初期化（`defineLazy`）で未使用プロパティの計算を回避し、バンドラが不要コードを確実に除去できるようにする。`mini` エントリポイントが存在する理由自体が、tree-shaking で除去しきれないメソッドチェーン API を構造的に排除するためである。

- **遅延評価による循環依存回避**: `util.defineLazy()` を使い、相互参照するスキーマのプロパティを getter で遅延解決する。循環参照を検出するセンチネル値（`EVALUATING` シンボル）で無限再帰を防止する（`src/v4/core/util.ts:264-289`）。`$ZodLazy` スキーマ型が `defineLazy` で内部型を遅延解決するのはこの原則の典型例（`src/v4/core/schemas.ts:4412-4416`）。

## 実例と分析

### 三層アーキテクチャ: core / classic / mini

Zod v4 のパッケージ内構成は明確な三層になっている。

1. **`v4/core/`** — 全スキーマの定義型・解析ロジック・チェック・エラー型・ユーティリティ。外部 API を持たない内部レイヤー。
2. **`v4/classic/`** — `core` の上にメソッドチェーン API（`.optional()`, `.transform()`, `.refine()` 等）をバインドするファサード。v3 互換の `ZodError`（`Error` を継承）を提供。
3. **`v4/mini/`** — `core` の上に最小限の API をバインドするファサード。メソッドチェーンの大半を省略し、代わりにファクトリ関数（`z.optional(schema)` 等）でスキーマを構築する。

この分離の効果は以下の依存方向に現れる:

- `mini/parse.ts` は `core` の parse 関数をそのまま re-export（15行）
- `classic/parse.ts` は独自の `ZodRealError`（Error 継承版）をバインドして re-export（83行）
- `mini/schemas.ts` の各スキーマは `core.$ZodXxx.init()` + `ZodMiniType.init()` の2段初期化
- `classic/schemas.ts` の各スキーマは `core.$ZodXxx.init()` + `ZodType.init()` の2段初期化に加え、メソッドバインディング

### トレイトベース $constructor パターン

v3 では `abstract class ZodType` を継承する深い継承チェーンだった（`src/v3/types.ts:158`）。v4 では `$constructor` 関数が以下を行う:

1. 新しいコンストラクタ関数 `_` を生成
2. `init(inst, def)` 静的メソッドを定義（既にトレイトが適用済みなら早期リターン）
3. `Symbol.hasInstance` をオーバーライドし、`inst._zod.traits.has(name)` でチェック
4. プロトタイプのメソッドをインスタンスにバインド

この仕組みにより、例えば `ZodMiniString` は以下のように複数トレイトを合成する:

```
$ZodString.init(inst, def);   // core のバリデーションロジック
ZodMiniType.init(inst, def);  // mini の API バインディング
```

`$ZodString` の `init` 内部では `$ZodType.init()` が呼ばれるため、最終的に `inst._zod.traits` には `$ZodType`, `$ZodString`, `ZodMiniType`, `ZodMiniString` の全てが登録される。

### JIT コード生成によるオブジェクトバリデーション高速化

`$ZodObjectJIT`（`src/v4/core/schemas.ts:1938-2058`）は `Doc` クラス（`src/v4/core/doc.ts`）を使ってオブジェクト検証コードを動的に生成する。`new Function()` でコンパイルしたコードはスキーマの shape に特化しているため、ループやプロパティルックアップのオーバーヘッドを排除する。

`jitless` 設定で無効化でき、Cloudflare Workers 等の `eval` 禁止環境では自動検出してフォールバックする（`src/v4/core/util.ts:371-384`）。

### グローバルレジストリの Dual Package Hazard 対策

`globalRegistry` は `globalThis` に格納することで、CJS と ESM の両方から同一インスタンスを参照する（`src/v4/core/registries.ts:94-105`）。スキーマのメタデータ（description 等）はこのレジストリに WeakMap で保持される。

### エントリポイントのリダイレクト構成

デフォルトエントリ `zod`（`src/index.ts`）は `v4/classic/external.js` を re-export する。`zod/mini` と `zod/v4-mini` はどちらも `v4/mini/external.js` を指す。`zod/v3` は完全に独立した v3 実装を指す。この構成により、既存ユーザーは import パスを変えずに v4 を使え、段階的な移行が可能になる。

## コード例

```typescript
// src/v4/core/core.ts:17-76
// トレイトベースの $constructor パターン — 多重トレイト合成と Symbol.hasInstance によるトレイト判定
export /*@__NO_SIDE_EFFECTS__*/ function $constructor<T extends ZodTrait, D = T["_zod"]["def"]>(
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
    if (inst._zod.traits.has(name)) return; // トレイト重複防止
    inst._zod.traits.add(name);
    initializer(inst, def);
    // プロトタイプメソッドのインスタンスバインディング
    const proto = _.prototype;
    const keys = Object.keys(proto);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      if (!(k in inst)) (inst as any)[k] = proto[k].bind(inst);
    }
  }
  // ... Symbol.hasInstance でトレイト名ベースの instanceof チェック
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst: any) => inst?._zod?.traits?.has(name),
  });
  return _ as any;
}
```

```typescript
// src/v4/core/util.ts:266-289
// 遅延評価 + 循環依存検出による defineLazy
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
      Object.defineProperty(object, key, { value: v });
    },
    configurable: true,
  });
}
```

```typescript
// src/v4/core/schemas.ts:1947-2019
// JIT コード生成 — Doc クラスで Function コンストラクタを使い、shape 固有の検証コードを動的生成
const generateFastpass = (shape: any) => {
  const doc = new Doc(["shape", "payload", "ctx"]);
  doc.write(`const input = payload.value;`);
  doc.write(`const newResult = {};`);
  for (const key of normalized.keys) {
    const k = util.esc(key);
    doc.write(`const ${id} = shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx);`);
    // ... キーごとの結果処理コードを生成
  }
  doc.write(`payload.value = newResult;`);
  doc.write(`return payload;`);
  const fn = doc.compile(); // new Function() で最終コンパイル
  return (payload: any, ctx: any) => fn(shape, payload, ctx);
};
```

```typescript
// src/v4/core/registries.ts:94-105
// Dual Package Hazard 対策 — globalThis にレジストリを格納
interface GlobalThisWithRegistry {
  __zod_globalRegistry?: $ZodRegistry<GlobalMeta>;
}
(globalThis as GlobalThisWithRegistry).__zod_globalRegistry ??= registry<GlobalMeta>();
export const globalRegistry: $ZodRegistry<GlobalMeta> =
  (globalThis as GlobalThisWithRegistry).__zod_globalRegistry!;
```

## パターンカタログ

- **Trait / Mixin パターン** (分類: 構造)
  - 解決する問題: JavaScript の単一継承制約下で、スキーマ型に複数の振る舞い（バリデーション、APIメソッド、チェック）を合成する
  - 適用条件: 型の振る舞いを直交する関心事に分解でき、組み合わせの自由度が必要な場合
  - コード例: `src/v4/core/core.ts:17-76`（`$constructor` + `init()`）
  - 注意点: トレイト名の衝突が起きると `init` が早期リターンして初期化が不完全になる。名前の一意性を保証する規約が必要

- **Facade パターン** (分類: 構造)
  - 解決する問題: 複雑な内部 API を隠蔽し、ユーザー向けの簡潔なインターフェースを提供する
  - 適用条件: 同一コアに対して複数の API サーフェスを提供したい場合
  - コード例: `src/v4/classic/schemas.ts:156-259`（ZodType が core.$ZodType をラップ）、`src/v4/mini/schemas.ts:43-79`（ZodMiniType が同じ core をラップ）
  - 注意点: ファサード層の数が増えると、新機能追加時に全レイヤーへの反映が必要

- **JIT Compilation パターン** (分類: 振る舞い / 最適化)
  - 解決する問題: 汎用ループベースのバリデーションのオーバーヘッドをスキーマ固有のコード生成で除去する
  - 適用条件: バリデーション対象のスキーマ構造が実行時に確定し、同一スキーマで繰り返しバリデーションが行われる場合
  - コード例: `src/v4/core/schemas.ts:1938-2058`（$ZodObjectJIT）、`src/v4/core/doc.ts`（Doc クラス）
  - 注意点: `eval` / `new Function()` が禁止される環境（CSP、Cloudflare Workers）では使用不可。必ずフォールバックパスを用意する

## Good Patterns

- **Self-caching getter で計算プロパティを一度だけ評価する**: `Object.defineProperty` で getter を定義し、初回アクセス時に結果を value プロパティとして再定義する。以降のアクセスはプレーンな値読み取りになり、getter のオーバーヘッドがゼロになる。

```typescript
// src/v4/core/util.ts:593-619 — pick/omit/extend 内の shape 計算
get shape() {
  const _shape = { ...schema._zod.def.shape, ...shape };
  assignProp(this, "shape", _shape); // self-caching: getter → value に置換
  return _shape;
}
```

- **`@__PURE__` / `@__NO_SIDE_EFFECTS__` アノテーションによる tree-shaking 保証**: 全てのコンストラクタ生成を `/*@__PURE__*/` でマークし、バンドラに副作用がないことを伝える。未使用のスキーマ型がバンドルに含まれないことを構造的に保証する。

```typescript
// src/v4/core/schemas.ts:352
export const $ZodString: core.$constructor<$ZodString> = /*@__PURE__*/ core.$constructor("$ZodString", ...);
```

- **`globalThis` による CJS/ESM 共有シングルトン**: Dual Package Hazard（CJS と ESM で別インスタンスが生成される問題）を `globalThis` への格納で回避する。`??=` で初回のみ初期化し、後続のロードでは既存インスタンスを再利用する。

```typescript
// src/v4/core/registries.ts:104-105
(globalThis as GlobalThisWithRegistry).__zod_globalRegistry ??= registry<GlobalMeta>();
export const globalRegistry = (globalThis as GlobalThisWithRegistry).__zod_globalRegistry!;
```

## Anti-Patterns / 注意点

- **深いクラス継承チェーンによるバンドル肥大化**: v3 では `abstract class ZodType` を基底に全スキーマが継承していたため、1つのスキーマ型を使うだけで基底クラスの全メソッドがバンドルに含まれた。tree-shaking ではクラスメソッドを個別に除去できない。

```typescript
// Bad: v3 のクラス継承ベース（src/v3/types.ts:158）
export abstract class ZodType<Output = any, Def extends ZodTypeDef = ZodTypeDef, Input = Output> {
  // 全てのメソッドがプロトタイプに残る — 使わなくても除去できない
  abstract _parse(input: ParseInput): ParseReturnType<Output>;
  parse(data: unknown, params?: Partial<ParseParams>): Output { ... }
  safeParse(data: unknown, params?: Partial<ParseParams>): SafeParseReturnType<Input, Output> { ... }
  // ... 数十のメソッド
}
```

```typescript
// Better: v4 のトレイト合成（src/v4/core/core.ts:17-76）
// init() でメソッドをインスタンスに動的バインド → 使用するトレイトのメソッドだけがバンドルに含まれる
export function $constructor(name, initializer, params?) {
  function init(inst, def) {
    if (inst._zod.traits.has(name)) return;
    inst._zod.traits.add(name);
    initializer(inst, def);
  }
  // ...
}
```

- **循環依存を放置してランタイムエラーにする**: モジュール間の循環 import は `undefined` 参照を引き起こす。Zod は `defineLazy` で循環参照を getter で遅延解決し、`EVALUATING` センチネルで無限再帰を検出する。循環依存チェッカー（madge）を CI に組み込んでいる。

```typescript
// Bad: 直接参照で循環依存に陥る
import { OtherSchema } from "./other.js"; // 循環時に undefined
const result = OtherSchema._zod.pattern;   // runtime error

// Better: defineLazy で遅延評価
util.defineLazy(inst._zod, "pattern", () => def.innerType._zod.pattern);
```

## 導出ルール

- `[MUST]` ライブラリの公開 API と内部ロジックを構造的に分離し、内部レイヤーは API サーフェスに依存しない方向で設計する
  - 根拠: Zod の `v4/core` は `classic`/`mini` に一切依存せず、API 差異がバリデーション動作に影響しない構造を実現している（`src/v4/mini/parse.ts` は core をそのまま re-export）

- `[MUST]` `sideEffects: false` を宣言するライブラリでは、モジュールスコープの副作用を排除し、全コンストラクタ/ファクトリに `@__PURE__` または `@__NO_SIDE_EFFECTS__` アノテーションを付与する
  - 根拠: Zod v4 は全 244 箇所のコンストラクタ定義に `@__PURE__` を付与し、未使用スキーマ型の tree-shaking を保証している（`src/v4/core/` 全体で確認）

- `[SHOULD]` 相互参照するモジュールのプロパティは `defineLazy` パターン（getter 定義 + センチネル値による循環検出）で遅延解決し、CI に循環依存チェッカーを組み込む
  - 根拠: Zod は `defineLazy` を schemas.ts だけで 30 箇所以上使用し、`madge --circular` を CI で実行して循環依存を検出している

- `[SHOULD]` 同一コアに複数の API サーフェスを提供する場合、コアレイヤーのコンストラクタに `init()` 静的メソッドを持たせ、ファサード層がそれを呼び出す合成パターンを採用する
  - 根拠: `core.$ZodString.init()` + `ZodType.init()` / `ZodMiniType.init()` の組み合わせで、classic と mini が同一バリデーションロジックを共有しつつ異なる API を提供している

- `[SHOULD]` ホットパスのオブジェクト検証には JIT コード生成を検討し、`eval` 禁止環境ではインタプリタフォールバックを必ず用意する
  - 根拠: `$ZodObjectJIT` は `new Function()` でスキーマ固有の検証コードを生成し、`util.allowsEval` と `jitless` 設定で Cloudflare Workers 等に対応している（`src/v4/core/schemas.ts:2025-2055`）

- `[SHOULD]` CJS/ESM の Dual Package Hazard が発生するシングルトン（レジストリ、設定等）は `globalThis` に格納して `??=` で初期化する
  - 根拠: `globalRegistry` が `globalThis.__zod_globalRegistry` に格納され、CJS/ESM 混在環境でも単一インスタンスが保証されている（`src/v4/core/registries.ts:104-105`）

- `[AVOID]` ライブラリの基底型にクラス継承を使い、全メソッドをプロトタイプに持たせる設計。tree-shaking で個別メソッドを除去できず、バンドルサイズが肥大化する
  - 根拠: Zod v3 の `abstract class ZodType`（5138行の types.ts）から v4 のトレイト合成への移行は、バンドルサイズ削減が主要な動機だった

## 適用チェックリスト

- [ ] ライブラリの内部ロジックレイヤーと公開 API レイヤーが明確に分離されているか（内部→公開の一方向依存になっているか）
- [ ] `sideEffects: false` を宣言している場合、全てのエクスポートに `@__PURE__` / `@__NO_SIDE_EFFECTS__` アノテーションが付与されているか
- [ ] 循環依存の可能性がある箇所で遅延評価（`defineLazy` や Proxy）を使用しているか
- [ ] CI に循環依存チェッカー（madge 等）が組み込まれているか
- [ ] CJS/ESM 両方で公開するシングルトンが `globalThis` を使って Dual Package Hazard を回避しているか
- [ ] `eval` / `new Function()` を使う最適化にフォールバックパスが用意されているか
- [ ] 複数の API サーフェス（full / lite 等）が同一コアロジックを共有し、バリデーション動作の不整合がない構造になっているか
