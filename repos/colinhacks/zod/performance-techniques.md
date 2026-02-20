# パフォーマンス最適化手法

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod v4 はスキーマバリデーションライブラリとして「毎リクエスト・毎入力ごとに実行される」ホットパスの性能を追求している。リンターの `noParameterAssign: off` を意図的に設定し、パラメータ再代入による in-place 変換を許容するなど、一般的なコーディング規約と意識的にトレードオフしている。遅延評価（`defineLazy`）によるスキーマ初期化コスト削減、JIT コンパイル（`new Function`）によるオブジェクトパース高速化、`/*@__PURE__*/` / `@__NO_SIDE_EFFECTS__` アノテーションによる tree-shaking 最適化、そしてベンチマーク駆動の微細な最適化判断が特徴的である。

## 背景にある原則

- **ホットパスのアロケーション最小化**: バリデーション実行パス（`_zod.parse` / `_zod.run`）では新しいオブジェクト生成を極力避け、既存の `payload` オブジェクトを直接変更する。新しい結果オブジェクトを返す設計（イミュータブル）は分かりやすいが、毎回のアロケーションが GC 圧力になる。Zod は `payload.value = ...` でミュータブルに書き換えることでこれを回避している（`schemas.ts` 全体で 40 箇所以上の `payload.value =` 代入）。
- **初期化コストと実行時コストの分離**: スキーマ定義時（cold path）にコストをかけ、バリデーション実行時（hot path）の計算を減らす。`cached()` や `defineLazy()` でスキーマメタデータを遅延初期化し、JIT コンパイルで実行時のループや条件分岐を静的コードに変換する。
- **バンドルサイズは実行時性能の一部**: tree-shaking を徹底し、使わないスキーマがバンドルに含まれないようにする。`sideEffects: false` 宣言と `/*@__PURE__*/` アノテーションの組み合わせで、バンドラが安全にコードを除去できるようにしている。mini バリアントという API サーフェスの異なる軽量版も提供している。
- **ベンチマーク駆動の意思決定**: `packages/bench/` に多数のマイクロベンチマークを持ち、`lazy-box.ts`（遅延評価実装の比較）、`property-access.ts`（Proxy vs getter vs 直接アクセス）、`instanceof.ts`（型判定手法の比較）、`key-iteration.ts`（`for...in` vs `Reflect.ownKeys`）など、個別の実装判断をベンチマークで裏付けている。

## 実例と分析

### パラメータ再代入による in-place 変換

Zod は `biome.jsonc` で `noParameterAssign: off` を明示的に設定し、コメントで "required for performant coercion in _parse" と理由を記している。これにより、各スキーマの `parse` 関数で `payload.value` を直接書き換える設計が可能になる。

```typescript
// packages/zod/src/v4/core/schemas.ts:355-361
inst._zod.parse = (payload, _) => {
  if (def.coerce)
    try {
      payload.value = String(payload.value);
    } catch (_) {}

  if (typeof payload.value === "string") return payload;
  // ...
};
```

数値、真偽値、BigInt、Date でも同じパターンが一貫して適用されている（`schemas.ts:1100`, `1183`, `1236`, `1561`）。配列パースでは `payload.value = Array(input.length)` で事前に固定長配列を確保し、オブジェクトパースでは `payload.value = {}` で空オブジェクトに書き換える。新しい `payload` オブジェクトを返すのではなく、同じオブジェクトを使い回す。

### defineLazy: getter を値に置換する遅延評価

`util.defineLazy()` は `Object.defineProperty` で getter を定義し、初回アクセス時に getter を実際の値で上書きする。これにより 2 回目以降のアクセスは通常のプロパティ読み取りと同等速度になる。

```typescript
// packages/zod/src/v4/core/util.ts:266-289
export function defineLazy<T, K extends keyof T>(object: T, key: K, getter: () => T[K]): void {
  let value: T[K] | typeof EVALUATING | undefined = undefined;
  Object.defineProperty(object, key, {
    get() {
      if (value === EVALUATING) {
        return undefined as T[K];
      }
      if (value === undefined) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object, key, {
        value: v,
      });
    },
    configurable: true,
  });
}
```

`EVALUATING` センチネルシンボルにより循環参照を検出・回避する。コードベース全体で 40 箇所以上使用されており、特に `$ZodObject` の `propValues`、`$ZodUnion` の `values` / `pattern` / `optin` / `optout`、`$ZodLazy` の `innerType` など、スキーマ間の依存解決で多用される。

同様の自己キャッシュパターンとして `cached()` と自己キャッシュ getter がある。

```typescript
// packages/zod/src/v4/core/util.ts:223-235
export function cached<T>(getter: () => T): { value: T } {
  const set = false;
  return {
    get value() {
      if (!set) {
        const value = getter();
        Object.defineProperty(this, "value", { value });
        return value;
      }
      throw new Error("cached value already set");
    },
  };
}
```

`packages/bench/lazy-box.ts` でこのパターンを 3 つの実装（内部プロパティ、スコープ変数、getter 上書き）でベンチマーク比較し、getter 上書き方式を採用している。

### JIT コンパイルによるオブジェクトパース高速化

`$ZodObjectJIT` は `new Function()` でスキーマの shape に特化したパース関数を動的生成する。

```typescript
// packages/zod/src/v4/core/schemas.ts:1946-2019
const generateFastpass = (shape: any) => {
  const doc = new Doc(["shape", "payload", "ctx"]);
  const normalized = _normalized.value;

  doc.write(`const input = payload.value;`);
  const ids: any = Object.create(null);
  let counter = 0;
  for (const key of normalized.keys) {
    ids[key] = `key_${counter++}`;
  }

  doc.write(`const newResult = {};`);
  for (const key of normalized.keys) {
    const id = ids[key];
    const k = util.esc(key);
    doc.write(`const ${id} = shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx);`);
    // ... 各キーの結果処理をインライン展開
  }

  doc.write(`payload.value = newResult;`);
  doc.write(`return payload;`);
  const fn = doc.compile();
  return (payload: any, ctx: any) => fn(shape, payload, ctx);
};
```

`Object.create(null)` でプロトタイプチェーンなしの ID マップを作成し、`Doc` クラス（`doc.ts`）でコードを文字列として組み立て、`new Function()` でコンパイルする。eval が使えない環境（Cloudflare Workers 等）ではフォールバックする設計。

```typescript
// packages/zod/src/v4/core/schemas.ts:2046-2056
if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
  if (!fastpass) fastpass = generateFastpass(def.shape);
  payload = fastpass(payload, ctx);
  if (!catchall) return payload;
  return handleCatchall([], input, payload, ctx, value, inst);
}
return superParse(payload, ctx);
```

### checks なし時の run = parse 直接代入

スキーマにチェック（refinement）が付与されていない場合、`run` メソッドを `parse` メソッドへの直接参照にする。

```typescript
// packages/zod/src/v4/core/schemas.ts:205-211
if (checks.length === 0) {
  inst._zod.deferred ??= [];
  inst._zod.deferred?.push(() => {
    inst._zod.run = inst._zod.parse;
  });
}
```

チェックがある場合のみ `runChecks` のラッパーを設定する。多くのスキーマ（特に基本型の `z.string()`, `z.number()` 等）はチェックなしで使われるため、この最適化は広く効く。

### 判別共用体の O(1) ルックアップ

`$ZodDiscriminatedUnion` は判別キーの値を `Map` に事前マッピングし、パース時に O(1) でマッチするスキーマを特定する。

```typescript
// packages/zod/src/v4/core/schemas.ts:2315-2330
const disc = util.cached(() => {
  const opts = def.options as $ZodTypeDiscriminable[];
  const map: Map<util.Primitive, $ZodType> = new Map();
  for (const o of opts) {
    const values = o._zod.propValues?.[def.discriminator];
    for (const v of values) {
      map.set(v, o);
    }
  }
  return map;
});
```

パース時はマップの get 一発:

```typescript
// packages/zod/src/v4/core/schemas.ts:2345-2347
const opt = disc.value.get(input?.[def.discriminator] as any);
if (opt) {
  return opt._zod.run(payload, ctx) as any;
}
```

通常の `$ZodUnion` が全選択肢を試行するのに対し、判別共用体は入力値から直接スキーマを引く。

### Tree-shaking 最適化

すべてのスキーマコンストラクタに `/*@__PURE__*/` アノテーションが付与され、`$constructor` 関数自体にも `@__NO_SIDE_EFFECTS__` が付与されている。

```typescript
// packages/zod/src/v4/core/core.ts:17
export /*@__NO_SIDE_EFFECTS__*/ function $constructor<T extends ZodTrait, D = T["_zod"]["def"]>(...)

// packages/zod/src/v4/core/schemas.ts:352
export const $ZodString: core.$constructor<$ZodString> = /*@__PURE__*/ core.$constructor("$ZodString", ...);
```

`package.json` で `"sideEffects": false` を宣言し、API 関数にも `// @__NO_SIDE_EFFECTS__` を付与（`api.ts` で 20 箇所以上）。これにより `import { string } from "zod"` で `z.number()` のコードはバンドルに含まれない。`packages/treeshake/` で実際のバンドルサイズを検証している。

### 自己キャッシュ getter（pick / omit / extend）

`pick`、`omit`、`extend`、`merge`、`partial`、`required` の各操作は `get shape()` で遅延計算し、初回アクセス後に `assignProp(this, "shape", ...)` で値プロパティに置換する。

```typescript
// packages/zod/src/v4/core/util.ts:602-617
const def = mergeDefs(schema._zod.def, {
  get shape() {
    const newShape: Writeable<schemas.$ZodShape> = {};
    for (const key in mask) {
      if (!mask[key]) continue;
      newShape[key] = currDef.shape[key]!;
    }
    assignProp(this, "shape", newShape); // self-caching
    return newShape;
  },
  checks: [],
});
```

これにより `.pick({a: true}).pick({a: true})` のようなチェーン操作で、中間の shape 計算を最後の実際のアクセスまで遅延できる。

## パターンカタログ

- **Lazy Initialization / Virtual Proxy** (分類: 生成)
  - 解決する問題: スキーマ定義時のメタデータ計算コスト、循環参照の回避
  - 適用条件: 初期化時にすべての情報が利用可能でない場合、またはコスト削減が必要な場合
  - コード例: `util.ts:266`（`defineLazy`）、`util.ts:223`（`cached`）、`util.ts:613`（自己キャッシュ getter）
  - 注意点: `EVALUATING` センチネルによる循環検出は `undefined` を返す — 呼び出し側が `undefined` を正当な値として期待する場面では使えない

- **JIT Compilation / Specialization** (分類: 振る舞い)
  - 解決する問題: 汎用的なループベースのオブジェクトパースのオーバーヘッド
  - 適用条件: スキーマの shape が静的に決定され、同期パースの場合
  - コード例: `schemas.ts:1938-2058`（`$ZodObjectJIT`）、`doc.ts:1-44`（コードビルダー）
  - 注意点: eval 禁止環境（CSP, Cloudflare Workers）ではフォールバックが必要。`allowsEval` で事前検出している

## Good Patterns

- **Payload ミューテーションパターン**: バリデーション結果を `{ value, issues }` の単一オブジェクトで表現し、各段階で同じオブジェクトを変更して返す。アロケーションを最小化しつつ、成功/失敗の両方の情報を一つの構造で運べる。
  ```typescript
  // schemas.ts:355-361
  inst._zod.parse = (payload, _) => {
    if (def.coerce) payload.value = String(payload.value);
    if (typeof payload.value === "string") return payload;
    payload.issues.push({ expected: "string", code: "invalid_type", input: payload.value, inst });
    return payload;
  };
  ```

- **条件分岐の早期排除**: checks が 0 個の場合は `run = parse` の直接代入、`$ZodUnion` で選択肢が 1 つの場合は直接委譲（`schemas.ts:2147-2153`）、`$ZodOptional` で内部型が既に optional の場合はショートカットなど、ありふれたケースのオーバーヘッドを先に排除する。
  ```typescript
  // schemas.ts:2147-2153
  const single = def.options.length === 1;
  const first = def.options[0]._zod.run;
  inst._zod.parse = (payload, ctx) => {
    if (single) return first(payload, ctx);
    // ... 通常の union パース
  };
  ```

- **Set / Map による定数時間ルックアップ**: キーの存在チェックに `Set`（`normalizeDef` の `keySet`）、判別共用体に `Map` を使い、配列の `indexOf` や `includes` を排除する。
  ```typescript
  // schemas.ts:1810-1813
  return {
    keys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys),
  };
  ```

## Anti-Patterns / 注意点

- **無差別な immutable 操作**: ホットパスで `{ ...payload, value: newValue }` のようなスプレッドを繰り返すと、毎回オブジェクトが生成される。Zod が意図的に避けている設計。
  ```typescript
  // Bad: 毎回新しいオブジェクトを生成
  return { ...payload, value: String(payload.value) };

  // Better: 既存オブジェクトを変更
  payload.value = String(payload.value);
  return payload;
  ```
  ただし、この判断はホットパスに限定すべきである。非ホットパス（設定処理、エラー構築等）ではイミュータビリティの方が安全。

- **遅延評価のない重いメタデータ計算**: スキーマ定義時に全メタデータを即座に計算すると、使わないスキーマのコストも支払うことになる。
  ```typescript
  // Bad: 定義時に即座に計算
  inst._zod.propValues = computeExpensivePropValues(def);

  // Better: アクセス時に遅延計算
  util.defineLazy(inst._zod, "propValues", () => computeExpensivePropValues(def));
  ```

- **tree-shaking を阻害するトップレベル副作用**: `/*@__PURE__*/` や `@__NO_SIDE_EFFECTS__` なしでトップレベルの関数呼び出しを行うと、バンドラはそのコードを除去できない。
  ```typescript
  // Bad: バンドラはこれを除去できない
  export const MySchema = createSchema("MySchema", (inst, def) => { ... });

  // Better: PURE アノテーション付き
  export const MySchema = /*@__PURE__*/ createSchema("MySchema", (inst, def) => { ... });
  ```

## 導出ルール

- `[MUST]` ホットパス（毎リクエスト実行されるパース・バリデーション等）でリンタールールを緩和する場合は、理由をコメントまたは設定ファイルに明記する
  - 根拠: Zod は `biome.jsonc` で `noParameterAssign: "off"` に "required for performant coercion in _parse" とコメントしており、意図的なトレードオフであることを明示している
- `[MUST]` ライブラリのエクスポートに `/*@__PURE__*/` または `@__NO_SIDE_EFFECTS__` アノテーションを付与し、`package.json` で `"sideEffects": false` を宣言する
  - 根拠: Zod は全スキーマコンストラクタ（50+ 箇所）と全 API 関数（20+ 箇所）にこれらを付与し、`packages/treeshake/` で実際のバンドルサイズを検証している
- `[SHOULD]` 初期化コストが高いメタデータは遅延評価にし、初回アクセスで値に置換する自己キャッシュパターンを使う
  - 根拠: `defineLazy()` が 40+ 箇所、`cached()` が 4 箇所、自己キャッシュ getter（`assignProp(this, ...)` コメント "self-caching"）が 7 箇所で使われ、スキーマ初期化ベンチマーク（`bench/init.ts`）で効果を検証している
- `[SHOULD]` 判別可能なユニオン型は判別キーによる定数時間ルックアップを実装し、全選択肢の試行を避ける
  - 根拠: `$ZodDiscriminatedUnion` は `Map` で O(1) ルックアップを実現し、`bench/discriminated-union.ts` で通常の union との性能差を測定している
- `[SHOULD]` ホットパスのバリデーション結果は単一オブジェクトの in-place 変更で伝搬し、中間オブジェクトのアロケーションを避ける
  - 根拠: Zod の `payload` パターンでは `{ value, issues }` を各段階で使い回し、40+ 箇所の `payload.value = ...` 代入でアロケーションを回避している
- `[SHOULD]` パフォーマンス判断にはマイクロベンチマークを作成し、実装の選択根拠を残す
  - 根拠: `packages/bench/` に 30+ のベンチマークファイルがあり、遅延評価の実装方式（`lazy-box.ts`）、プロパティアクセス方式（`property-access.ts`）、型判定方式（`instanceof.ts`）など個別の判断を検証している
- `[AVOID]` eval/`new Function` による JIT 最適化を、フォールバック機構なしで導入する
  - 根拠: Zod は `util.allowsEval`（`util.ts:371`）で事前に eval 可否を検出し、`jitless` オプションと `ctx.jitless` による明示的なオプトアウトを提供している

## 適用チェックリスト

- [ ] プロジェクトのホットパス（リクエストごと・入力ごとに実行されるコード）を特定し、そこで不要なオブジェクトアロケーションが発生していないか確認する
- [ ] ライブラリを公開している場合、`"sideEffects": false` と `/*@__PURE__*/` アノテーションが付与されているか確認する
- [ ] 初期化時に重い計算をしている箇所がないか確認し、遅延評価への置き換えを検討する
- [ ] リンタールールを緩和している箇所に理由コメントがあるか確認する
- [ ] 判別共用体のようなパターンで、全選択肢の逐次試行をしている箇所がないか確認する
- [ ] パフォーマンスに影響する実装判断に対して、ベンチマークが存在するか確認する
- [ ] eval/dynamic code を使っている場合、CSP 制限環境でのフォールバックが実装されているか確認する
