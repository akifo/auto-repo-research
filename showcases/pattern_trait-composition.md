# Pattern: Trait Composition

> 出典: [repos/colinhacks/zod](../repos/colinhacks/zod/) — architecture, abstraction-patterns, tree-shaking-optimization
> カテゴリ: pattern

## 概要

クラス継承を完全に排除し、`$constructor` + `init()` チェーンで振る舞いを合成するトレイトパターン。`Symbol.hasInstance` をオーバーライドしてトレイト名ベースの `instanceof` を実現しつつ、各トレイトが独立して tree-shake 可能になる。JavaScript の単一継承制約とバンドルサイズ最適化を同時に解決する設計パターンである。

## 背景・文脈

Zod v3 は `abstract class ZodType` を基底とする深いクラス継承チェーンを採用していた。しかしこの設計には2つの根本的な問題があった:

1. **tree-shaking 不可**: ES6 クラスの `extends` は bundler に副作用とみなされ、未使用のスキーマ型でも基底クラスの全メソッドがバンドルに含まれる
2. **単一継承の制約**: `ZodString` がバリデーションロジックと API メソッドの両方を継承で受け取る必要があり、関心の分離が困難

Zod v4 ではこれらを解決するため、クラスを完全に廃止し `$constructor` 関数によるトレイト合成パターンに移行した。結果として、core/classic/mini の三層ファサードが同一バリデーションロジックを共有しつつ、異なるバンドルサイズの API を提供できるようになった。

## 実装パターン

### 核心: `$constructor` 関数

```typescript
// packages/zod/src/v4/core/core.ts:17-76
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
    if (inst._zod.traits.has(name)) return; // 多重初期化防止
    inst._zod.traits.add(name);
    initializer(inst, def);
    // プロトタイプメソッドをインスタンスにバインド
    const proto = _.prototype;
    const keys = Object.keys(proto);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      if (!(k in inst)) (inst as any)[k] = proto[k].bind(inst);
    }
  }
  // Symbol.hasInstance でトレイト名ベースの instanceof
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst: any) => inst?._zod?.traits?.has(name),
  });
  return _ as any;
}
```

### トレイトの合成

```typescript
// packages/zod/src/v4/core/schemas.ts:389-396
// $ZodStringFormat は $ZodCheckStringFormat と $ZodString の両方を合成
export const $ZodStringFormat = /*@__PURE__*/ core.$constructor(
  "$ZodStringFormat",
  (inst, def) => {
    checks.$ZodCheckStringFormat.init(inst, def); // チェック機能を注入
    $ZodString.init(inst, def);                    // 文字列パース機能を注入
  }
);
```

### ファサード層での段階的合成

```typescript
// packages/zod/src/v4/classic/schemas.ts:289-318
// classic レイヤーはメソッドチェーン API を追加
export const _ZodString = core.$constructor("_ZodString", (inst, def) => {
  core.$ZodString.init(inst, def); // core のパースロジック
  ZodType.init(inst, def);         // classic の共通メソッド群（.optional(), .transform() 等）
  inst.regex = (...args) => inst.check(checks.regex(...args));
  inst.min = (...args) => inst.check(checks.minLength(...args));
  // ...
});

// packages/zod/src/v4/mini/schemas.ts:82-98
// mini レイヤーは最小限のメソッドのみ
export const ZodMiniString = core.$constructor("ZodMiniString", (inst, def) => {
  core.$ZodString.init(inst, def); // 同一の core パースロジック
  ZodMiniType.init(inst, def);     // parse, safeParse, check, clone のみ
});
```

## Good Example

```typescript
// トレイト合成パターン: 複数の直交する振る舞いを合成
const MyValidator = $constructor("MyValidator", (inst, def) => {
  BaseParser.init(inst, def);       // パースロジック
  Serializable.init(inst, def);     // シリアライズ機能
  Cacheable.init(inst, def);        // キャッシュ機能
});

// 各トレイトは独立して tree-shake 可能
// Cacheable を使わないビルドでは完全に除去される

// instanceof はトレイト名ベースで動作
const v = new MyValidator(def);
v instanceof BaseParser;     // true（_zod.traits に "BaseParser" があるため）
v instanceof Serializable;   // true
v instanceof Cacheable;      // true
```

## Bad Example

```typescript
// Bad: 深いクラス継承チェーン
abstract class BaseType {
  abstract _parse(input: unknown): Result;
  parse(data: unknown): Output { /* ... */ }
  safeParse(data: unknown): SafeResult { /* ... */ }
  optional(): OptionalType { /* ... */ }
  nullable(): NullableType { /* ... */ }
  transform<T>(fn: (v: Output) => T): TransformType { /* ... */ }
  // ... 20+ メソッド — 使わなくても全てバンドルに含まれる
}

class StringType extends BaseType {
  _parse(input: unknown) { /* ... */ }
  min(n: number) { /* ... */ }
  // StringType を使うだけで BaseType の全メソッドが含まれる
}

// 問題1: tree-shaking 不可（extends は副作用とみなされる）
// 問題2: 単一継承のため、異なる API レイヤー（full/lite）を提供できない
// 問題3: 基底クラスの変更が全サブクラスに波及する
```

## 適用ガイド

### いつ使うべきか

- **ライブラリ開発で tree-shaking が重要な場合**: バンドルサイズが KPI のライブラリで、未使用機能の除去を保証したい
- **複数の API サーフェスを提供する場合**: full/lite/mini のような複数バリアントを同一コアから生成したい
- **多重継承が必要な場合**: バリデーション + シリアライズ + メタデータのように直交する機能を合成したい

### いつ使わないべきか

- **アプリケーションコード**: tree-shaking の恩恵が限定的で、クラス継承の方がシンプル
- **型の階層が浅い場合**: 2-3 段の継承なら従来のクラスで十分
- **TypeScript の型安全性を最優先する場合**: トレイト合成は `as any` が多く必要になり、型安全性が低下する

### 導入時の注意点

- **トレイト名の一意性**: `init()` は `traits.has(name)` で重複を検出するため、名前衝突で初期化が不完全になりうる
- **デバッグの困難さ**: `Symbol.hasInstance` のオーバーライドにより、通常の `instanceof` の挙動が変わる
- **`@__PURE__` アノテーション必須**: `$constructor` 自体と各コンストラクタ定義の両方にアノテーションが必要
- **内部状態の集約**: `_zod` のような単一の non-enumerable プロパティに内部状態を集約し、パブリック API との境界を明確にする

### カスタマイズポイント

1. **`Symbol.hasInstance` の判定ロジック**: Zod は `traits` Set のチェックだが、プロトコル準拠の判定（特定メソッドの存在チェック）にも応用可能
2. **`deferred` パターン**: 初期化完了後に遅延実行するコールバックリスト。チェックの有無に応じた最適化パス選択（`run = parse` 直接代入）等に利用
3. **ファクトリ関数の Class パラメータ化**: `_string(Class, params)` のようにクラスをパラメータ化することで、同一ロジックから異なるバリアントを生成

## 参考

- [repos/colinhacks/zod/architecture.md](../repos/colinhacks/zod/architecture.md) — 三層アーキテクチャと $constructor パターンの詳細分析
- [repos/colinhacks/zod/abstraction-patterns.md](../repos/colinhacks/zod/abstraction-patterns.md) — トレイト合成、run/parse 二段パイプライン、JIT コンパイル
- [repos/colinhacks/zod/tree-shaking-optimization.md](../repos/colinhacks/zod/tree-shaking-optimization.md) — classic/mini バリアント設計と PURE アノテーション戦略
