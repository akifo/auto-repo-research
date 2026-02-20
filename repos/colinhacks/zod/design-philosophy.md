# design-philosophy

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod v4 の設計思想を分析する。Zod は「TypeScript-first schema validation with static type inference」を標榜し、スキーマ定義と型推論の統合を核に据えている。注目すべきは、ゼロ依存・2kb コアバンドル・`sideEffects: false` を実現するために、TypeScript の型安全性を高度に維持しながらも、ランタイム実装では性能のためにプラグマティックなルール逸脱を許容している点である。型システムとランタイムパフォーマンスという本来トレードオフになりがちな二軸を、設計レイヤーの分離によって同時に追求する戦略がコードベース全体を貫いている。

## 背景にある原則

- **型を値で駆動する（Types Follow Values）**: スキーマオブジェクトが唯一の真実の源（Single Source of Truth）であり、TypeScript の型はスキーマから推論される。ユーザーが型を手書きする必要をなくすことで、型定義とバリデーションの乖離を構造的に防止する。`z.infer<typeof schema>` パターンが全 API の基盤となっている（`core.ts:120` の `export type { output as infer }`）。
- **パフォーマンスが正しさの次に優先される**: AGENTS.md に「Performance is critical - parameter reassignment is allowed for optimization」と明記し、biome.jsonc では `noParameterAssign: "off"` をパフォーマンス理由で解除している（`biome.jsonc:33`）。JIT コンパイルによるオブジェクトパース高速化（`schemas.ts:1938-2058`）、`assignProp` による self-caching getter、`defineLazy` による遅延初期化など、ホットパス最適化が随所に施されている。
- **ツリーシェイカビリティを設計制約として扱う**: `sideEffects: false` を宣言し、全ファクトリ関数に `@__NO_SIDE_EFFECTS__`、全 `$constructor` に `@__PURE__` アノテーションを付与する。バンドルサイズは「機能」ではなく「設計制約」として扱われ、使わないスキーマ型は最終バンドルから除去される（227 箇所の `@__NO_SIDE_EFFECTS__`、284 箇所の `@__PURE__` がコードベースに存在）。
- **API 層の分離でユーザー選択を可能にする**: core（型チェック）・classic（フルAPI）・mini（軽量API）の三層構造により、ユーザーがバンドルサイズと API の豊富さのトレードオフを選択できる。mini は classic と同じ core を共有しつつ、メソッドチェーンなどの便利 API を省略することで、さらに小さなバンドルを提供する。

## 実例と分析

### trait ベースのコンポジション: `$constructor` パターン

Zod v4 は従来のクラス継承を使わず、独自の `$constructor` 関数による trait ベースのコンポジションを採用している。各スキーマ型は `X.init(inst, def)` を呼び出すことで trait を「ミックスイン」し、`_zod.traits` Set でどの trait が適用済みかを追跡する。

```ts
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
    if (inst._zod.traits.has(name)) return; // 二重初期化防止
    inst._zod.traits.add(name);
    initializer(inst, def);
  }
  // ...
}
```

この設計の効果は classic と mini の実装差に明確に現れている。

```ts
// packages/zod/src/v4/classic/schemas.ts:289 — classic の ZodString
export const _ZodString = core.$constructor("_ZodString", (inst, def) => {
  core.$ZodString.init(inst, def);  // core の型チェック trait
  ZodType.init(inst, def);          // classic のメソッド群 trait
  // ... regex, includes, trim 等の便利メソッドを追加
});
```

```ts
// packages/zod/src/v4/mini/schemas.ts:91-97 — mini の ZodMiniString
export const ZodMiniString = core.$constructor("ZodMiniString", (inst, def) => {
  core.$ZodString.init(inst, def);  // 同じ core trait
  ZodMiniType.init(inst, def);      // mini のメソッド群 trait（便利メソッドなし）
});
```

同一の `core.$ZodString` trait をベースに、classic は豊富なメソッドチェーン API を、mini は最小限の API を提供する。trait の合成順序で振る舞いが決定される。

### パフォーマンスのためのプラグマティズム

AGENTS.md と biome.jsonc のコメントが設計判断の「なぜ」を明示している。

```jsonc
// biome.jsonc:24,33
"noExplicitAny": "off", // `any` is amazing
"noParameterAssign": "off", // required for performant coercion in _parse
```

この思想はパース実装に直結する。payload オブジェクトの `value` を直接再代入することで、新しいオブジェクト生成を避けている。

```ts
// packages/zod/src/v4/core/schemas.ts:352-372 — $ZodString のパース
inst._zod.parse = (payload, _) => {
  if (def.coerce)
    try {
      payload.value = String(payload.value); // パラメータ再代入
    } catch (_) {}
  if (typeof payload.value === "string") return payload;
  // ...エラー処理
};
```

さらに、オブジェクトスキーマでは JIT コンパイル（`new Function()` ベース）による高速パスが生成される。

```ts
// packages/zod/src/v4/core/schemas.ts:1938-2058 — $ZodObjectJIT
export const $ZodObjectJIT = core.$constructor("$ZodObjectJIT", (inst, def) => {
  $ZodObject.init(inst, def);
  const generateFastpass = (shape: any) => {
    const doc = new Doc(["shape", "payload", "ctx"]);
    // ... キーごとに静的コード生成
    const fn = doc.compile(); // new Function() でコンパイル
    return (payload: any, ctx: any) => fn(shape, payload, ctx);
  };
  // eval 不可環境では通常パスにフォールバック
  const fastEnabled = jit && allowsEval.value;
});
```

`jitless` 設定と `allowsEval` チェックにより、Cloudflare Workers のような `eval` 禁止環境でも動作するフォールバックを確保している（`util.ts:371-384`）。

### 不変 API と可変内部状態の分離

ユーザー向け API はイミュータブルで、`.check()` や `.optional()` は常に新しいインスタンスを返す。

```ts
// packages/zod/src/v4/classic/schemas.ts:171-185
inst.check = (...checks) => {
  return inst.clone(         // 新しいインスタンスを返す
    util.mergeDefs(def, {
      checks: [...(def.checks ?? []), ...checks.map(/* ... */)],
    }),
    { parent: true }         // parent チェーンで metadata 継承
  );
};
```

一方、内部では self-caching getter パターンで計算済みの値をキャッシュする。getter が初回アクセス時に計算を行い、その後は `assignProp` で自身を通常プロパティに書き換える。

```ts
// packages/zod/src/v4/core/util.ts:602-617 — pick の self-caching getter
const def = mergeDefs(schema._zod.def, {
  get shape() {
    const newShape: Writeable<schemas.$ZodShape> = {};
    for (const key in mask) {
      if (!mask[key]) continue;
      newShape[key] = currDef.shape[key]!;
    }
    assignProp(this, "shape", newShape); // self-caching: getter を値に置換
    return newShape;
  },
});
```

### 循環依存の解決: `defineLazy`

`defineLazy` ユーティリティは、循環参照が発生した場合に `EVALUATING` センチネルで検出し、`undefined` を返して無限ループを回避する。

```ts
// packages/zod/src/v4/core/util.ts:266-289
export function defineLazy<T, K extends keyof T>(object: T, key: K, getter: () => T[K]): void {
  let value: T[K] | typeof EVALUATING | undefined = undefined;
  Object.defineProperty(object, key, {
    get() {
      if (value === EVALUATING) return undefined as T[K]; // 循環参照検出
      if (value === undefined) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    // ...
  });
}
```

### 標準プロトコルへの準拠

Zod v4 は Standard Schema v1 に準拠し、他のバリデーションライブラリとの相互運用を可能にする。`~standard` プロパティは `defineLazy` で遅延初期化され、使わない場合のコストはゼロ。

```ts
// packages/zod/src/v4/core/schemas.ts:302-314
util.defineLazy(inst, "~standard", () => ({
  validate: (value: unknown) => {
    try {
      const r = safeParse(inst, value);
      return r.success ? { value: r.data } : { issues: r.error?.issues };
    } catch (_) {
      return safeParseAsync(inst, value).then(/* ... */);
    }
  },
  vendor: "zod",
  version: 1 as const,
}));
```

### デュアルパッケージハザードへの対処

globalRegistry を `globalThis` に配置することで、CJS と ESM が混在する環境でもシングルトンが保証される。

```ts
// packages/zod/src/v4/core/registries.ts:94-105
(globalThis as GlobalThisWithRegistry).__zod_globalRegistry ??= registry<GlobalMeta>();
export const globalRegistry = (globalThis as GlobalThisWithRegistry).__zod_globalRegistry!;
```

## パターンカタログ

- **Trait/Mixin パターン** (分類: 構造)
  - 解決する問題: 深いクラス継承ツリーなしで、柔軟にスキーマの振る舞いを合成する
  - 適用条件: 複数の直交する振る舞い軸（型チェック、API メソッド、JSON Schema 変換）を持つ型階層
  - コード例: `core/core.ts:17-77` の `$constructor`
  - 注意点: `instanceof` の代わりに `_zod.traits.has(name)` で判定する（`Symbol.hasInstance` をオーバーライド）

- **Self-caching Getter** (分類: 振る舞い / Lazy Initialization の変形)
  - 解決する問題: 計算コストの高いプロパティを初回アクセス時のみ評価し、以降はO(1)アクセスにする
  - 適用条件: getter で定義されたプロパティの値が不変で、繰り返しアクセスされるケース
  - コード例: `core/util.ts:602-617` の `pick` での `assignProp(this, "shape", newShape)`
  - 注意点: `Object.defineProperty` で `configurable: true` が必要。`Object.freeze` されたオブジェクトでは使えない

## Good Patterns

- **ファクトリ関数の `@__NO_SIDE_EFFECTS__` アノテーション**: 全てのスキーマファクトリ関数に `// @__NO_SIDE_EFFECTS__` を付与し、バンドラーにツリーシェイキング可能であることを伝える。`sideEffects: false` だけでは不十分な場合（ファクトリ関数内の副作用っぽいコード）でもバンドラーが安全に除去できるようになる。

```ts
// packages/zod/src/v4/core/api.ts:62-71
// @__NO_SIDE_EFFECTS__
export function _string<T extends schemas.$ZodString>(
  Class: util.SchemaClass<T>,
  params?: string | $ZodStringParams
): T {
  return new Class({ type: "string", ...util.normalizeParams(params) });
}
```

- **パラメータ正規化で複数の入力形式を統一**: `normalizeParams` 関数が string / object / undefined を統一的に処理し、ユーザーが `z.string("カスタムエラー")` と `z.string({ error: "カスタムエラー" })` のどちらでも書けるようにしている。

```ts
// packages/zod/src/v4/core/util.ts:509-521
export function normalizeParams<T>(_params: T): Normalize<T> {
  const params: any = _params;
  if (!params) return {} as any;
  if (typeof params === "string") return { error: () => params } as any;
  if (params?.message !== undefined) {
    if (params?.error !== undefined) throw new Error("Cannot specify both...");
    params.error = params.message;
    delete params.message;
  }
  if (typeof params.error === "string") return { ...params, error: () => params.error } as any;
  return params;
}
```

- **`@deprecated` による段階的 API 移行**: v3 互換レイヤー（`compat.ts`）を別ファイルに分離し、全ての非推奨 API に `@deprecated` JSDoc を付与して移行先を明示している。`ZodTypeAny` -> `ZodType`、`z.string().email()` -> `z.email()` のように、1:1 の移行パスを提供している。

## Anti-Patterns / 注意点

- **`any` の無制限許容はライブラリ固有の選択**: Zod は biome で `noExplicitAny: "off"` とし「`any` is amazing」とコメントしている。これはスキーマの型推論で `any` が型レベルの「ワイルドカード」として機能する必要があるためのライブラリ特有の判断である。

```ts
// Bad: アプリケーションコードで同じルールを採用する
// biome.jsonc: "noExplicitAny": "off"

// Better: ライブラリの型推論インフラのみ any を許可し、アプリケーション側は unknown を使う
// biome.jsonc:
// "noExplicitAny": "error"  (アプリケーションでは有効)
// ライブラリ境界の型定義ファイルのみ override で off にする
```

- **JIT コンパイル（`new Function()`）のセキュリティリスク**: `$ZodObjectJIT` は `new Function()` で動的コード生成を行う。CSP（Content Security Policy）が厳しい環境や、ユーザー入力がスキーマ定義に混入する可能性がある場合は `jitless: true` を設定する必要がある。Zod は `allowsEval` チェックと `jitless` 設定でこれに対処しているが、ライブラリ利用者は環境を考慮する必要がある。

```ts
// Bad: CSP が有効な環境で JIT を考慮しない
z.object({ name: z.string() }).parse(data);

// Better: 環境に応じて jitless を設定する
z.config({ jitless: true }); // Cloudflare Workers, CSP strict 環境等
```

## 導出ルール

- `[MUST]` ライブラリ API は不変に設計し、メソッド呼び出しが常に新しいインスタンスを返すようにする — 内部最適化はミュータブルで行ってよいが、公開 API 契約は不変であること
  - 根拠: Zod の全メソッド（`.check()`, `.optional()`, `.pick()` 等）は `clone()` で新インスタンスを返し、元のスキーマは不変に保たれる（`classic/schemas.ts:171-185`）
- `[MUST]` ゼロ依存を維持するライブラリでは、ツリーシェイカビリティのために `sideEffects: false` と `@__NO_SIDE_EFFECTS__` / `@__PURE__` アノテーションを全ファクトリ関数に付与する
  - 根拠: Zod は 227 個の `@__NO_SIDE_EFFECTS__` と 284 個の `@__PURE__` アノテーションでバンドラーに副作用なしを伝え、2kb コアバンドルを実現している
- `[SHOULD]` 複数の入力形式を受け付ける API は、内部で正規化レイヤーを設けて統一的に処理する（string / object / undefined のオーバーロード等）
  - 根拠: `normalizeParams` が string, object, undefined を統一処理し、ユーザーが短い形式と詳細形式の両方で API を呼べるようにしている（`util.ts:509-521`）
- `[SHOULD]` 計算コストの高いプロパティは self-caching getter（初回アクセスで getter を値に置換）で遅延初期化する
  - 根拠: `pick()`, `omit()`, `extend()` 等の shape 計算で `assignProp(this, "shape", ...)` による self-caching が一貫して使われている（`util.ts` に 7 箇所）
- `[SHOULD]` CJS/ESM デュアルパッケージでシングルトン状態が必要な場合は `globalThis` に配置して二重初期化を防ぐ
  - 根拠: `globalRegistry` を `globalThis.__zod_globalRegistry` に配置し、require と import の混在環境でも状態が一貫するようにしている（`registries.ts:94-105`）
- `[SHOULD]` 循環依存が避けられないモジュール構造では、遅延プロパティ定義（`defineLazy` パターン）でセンチネル値による循環検出を行う
  - 根拠: `defineLazy` が `EVALUATING` センチネルで循環参照を検出し、42 箇所で使用されている（`util.ts:266-289`）
- `[AVOID]` パフォーマンスのためにリントルールを off にする判断をライブラリ固有の文脈からアプリケーションに一般化すること — `any` 許容やパラメータ再代入はホットパス最適化のライブラリ限定判断であり、アプリケーションコードでは型安全性を優先すべき
  - 根拠: Zod の `noExplicitAny: "off"` は型推論インフラのための例外であり、AGENTS.md でも「Don't skip tests due to type issues - fix the types instead」と型の正しさを重視している

## 適用チェックリスト

- [ ] ライブラリの公開 API が不変か確認する（メソッドが元のインスタンスを変更せず新しいインスタンスを返すか）
- [ ] `sideEffects: false` を package.json に宣言し、ファクトリ関数に `@__NO_SIDE_EFFECTS__` / `@__PURE__` を付与しているか
- [ ] 複数の入力形式を受け付ける API に正規化レイヤーがあるか（string / object / undefined の統一処理）
- [ ] 計算コストの高いプロパティが遅延初期化されているか（self-caching getter または `defineLazy` パターン）
- [ ] CJS/ESM デュアルパッケージでシングルトン状態を `globalThis` に配置しているか
- [ ] 循環依存がある場合、遅延初期化でセンチネル値による循環検出を行っているか
- [ ] リントルール変更（`any` 許容、パラメータ再代入等）がライブラリ固有の正当な理由に基づいているか、アプリケーションに漏れていないか
