# Practice: Tree-Shaking Library

> 出典: [repos/open-circle/valibot](../repos/open-circle/valibot/)
> カテゴリ: practice

## 概要

ファクトリ関数 + `@__NO_SIDE_EFFECTS__` + `sideEffects: false` を組み合わせた、完全 tree-shaking 設計パターン。valibot の 250 以上のファクトリ関数に一貫して適用されており、クラスを使わずプレーンオブジェクトを返すファクトリ関数、モジュールレベル副作用の排除（遅延初期化）、正規表現のモジュール定数化など、バンドルサイズが重要なライブラリ全般に適用可能な手法を体系化する。

## 背景・文脈

valibot はモジュラーなスキーマバリデーションライブラリで、「ユーザーが使わない機能はバンドルに一切含めない」を設計の最優先事項としている。250 以上のスキーマ・バリデーション・トランスフォーメーション関数を提供しつつ、個別の関数単位で tree-shaking できる構造を実現した。

tree-shaking はバンドラ（Rollup, esbuild, webpack 等）が「使われていないコード」を除去する最適化だが、バンドラが安全に除去できる条件は厳しい。関数呼び出しに副作用があるかを静的に判定できないケースが多く、ライブラリ側が能動的にバンドラを補助する必要がある。valibot はこの問題を3層の戦略で解決している:

1. **API 設計層**: クラスではなくファクトリ関数 + プレーンオブジェクト
2. **アノテーション層**: `@__NO_SIDE_EFFECTS__` による関数レベルの純粋性宣言
3. **パッケージ層**: `sideEffects: false` + モジュールレベル副作用の排除

## 実装パターン

### 1. ファクトリ関数 + プレーンオブジェクト

クラスの代わりにプレーンオブジェクトを返すファクトリ関数で API を構成する。各関数が独立しているため、バンドラが個別に tree-shake できる。

```typescript
// library/src/schemas/string/string.ts:69-94
// @__NO_SIDE_EFFECTS__
export function string(
  message?: ErrorMessage<StringIssue>,
): StringSchema<ErrorMessage<StringIssue> | undefined> {
  return {
    kind: "schema",
    type: "string",
    reference: string,
    expects: "string",
    async: false,
    message,
    get "~standard"() {
      return _getStandardProps(this);
    },
    "~run"(dataset, config) {
      if (typeof dataset.value === "string") {
        // @ts-expect-error
        dataset.typed = true;
      } else {
        _addIssue(this, "type", dataset, config);
      }
      // @ts-expect-error
      return dataset as OutputDataset<string, StringIssue>;
    },
  };
}
```

### 2. `@__NO_SIDE_EFFECTS__` の選択的適用

純粋関数（ファクトリ関数・getter）にはアノテーションを付与し、実際に副作用を持つ関数（setter・deleter）には付与しない。この正確な使い分けがバンドラの最適化精度を高める。

```typescript
// library/src/storages/schemaMessage/schemaMessage.ts:1-32
let store: Map<string | undefined, ErrorMessage<BaseIssue<unknown>>>;

// set は副作用あり -> アノテーションなし
export function setSchemaMessage(
  message: ErrorMessage<BaseIssue<unknown>>,
  lang?: string,
): void {
  if (!store) store = new Map();
  store.set(lang, message);
}

// get は純粋 -> アノテーションあり
// @__NO_SIDE_EFFECTS__
export function getSchemaMessage(
  lang?: string,
): ErrorMessage<BaseIssue<unknown>> | undefined {
  return store?.get(lang);
}
```

### 3. 遅延初期化によるモジュールレベル副作用の排除

`sideEffects: false` が安全に機能するには、モジュールのトップレベルに副作用がないことが前提。ストレージの初期化を初回利用時まで遅延させることでこの前提を満たす。

```typescript
// library/src/storages/specificMessage/specificMessage.ts:28-47
// モジュールのトップレベルでは宣言のみ（new Map() しない）
let store: Map<
  Reference,
  Map<string | undefined, ErrorMessage<BaseIssue<unknown>>>
>;

// 実際の初期化は set 関数内で遅延実行
export function setSpecificMessage<const TReference extends Reference>(
  reference: TReference,
  message: ErrorMessage<InferIssue<ReturnType<TReference>>>,
  lang?: string,
): void {
  if (!store) store = new Map(); // 遅延初期化
  if (!store.get(reference)) store.set(reference, new Map());
  store.get(reference)!.set(lang, message);
}
```

### 4. 正規表現のモジュールレベル定数化

バリデーション用正規表現を1ファイルに集約し、モジュールレベル定数として定義する。関数呼び出しごとの再コンパイルを防ぎつつ、未使用の正規表現は tree-shaking で除去される。

```typescript
// library/src/regex.ts:4-5, 31-32
export const BASE64_REGEX: RegExp = /^(?:[\da-z+/]{4})*(?:[\da-z+/]{2}==|[\da-z+/]{3}=)?$/iu;

export const EMAIL_REGEX: RegExp = /^[\w+-]+(?:\.[\w+-]+)*@[\da-z]+(?:[.-][\da-z]+)*\.[a-z]{2,}$/iu;
```

### 5. `sideEffects: false` + `exports` の正確な設定

```json
// library/package.json:25-37
"exports": {
  ".": {
    "import": {
      "types": "./dist/index.d.mts",
      "default": "./dist/index.mjs"
    },
    "require": {
      "types": "./dist/index.d.cts",
      "default": "./dist/index.cjs"
    }
  }
},
"sideEffects": false,
```

## Good Example

**ファクトリ関数で個別に tree-shakeable な API を設計する:**

```typescript
// library/src/actions/email/email.ts:93-112
// @__NO_SIDE_EFFECTS__
export function email(
  message?: ErrorMessage<EmailIssue<string>>,
): EmailAction<string, ErrorMessage<EmailIssue<string>> | undefined> {
  return {
    kind: "validation",
    type: "email",
    reference: email,
    expects: null,
    async: false,
    requirement: EMAIL_REGEX, // モジュールレベル定数を参照
    message,
    "~run"(dataset, config) {
      if (dataset.typed && !this.requirement.test(dataset.value)) {
        _addIssue(this, "email", dataset, config);
      }
      return dataset;
    },
  };
}
```

**ホットパスで spread 演算子を回避する:**

```typescript
// library/src/storages/globalConfig/globalConfig.ts:27-39
// @__NO_SIDE_EFFECTS__
export function getGlobalConfig<const TIssue extends BaseIssue<unknown>>(
  config?: Config<TIssue>,
): Config<TIssue> {
  // Hint: The configuration is deliberately not constructed with the spread
  // operator for performance reasons
  return {
    lang: config?.lang ?? store?.lang,
    message: config?.message,
    abortEarly: config?.abortEarly ?? store?.abortEarly,
    abortPipeEarly: config?.abortPipeEarly ?? store?.abortPipeEarly,
  };
}
```

## Bad Example

**class ベースの API（メソッドが個別に tree-shake されない）:**

```typescript
// Bad: class のメソッドはプロトタイプチェーンに属し、バンドラが安全に除去できない
class Schema {
  string() {
    return { kind: "schema", type: "string" /* ... */ };
  }
  number() {
    return { kind: "schema", type: "number" /* ... */ };
  }
  email() {
    return { kind: "validation", type: "email" /* ... */ };
  }
}
export const v = new Schema();
// -> v.string() だけ使っても number(), email() がバンドルに残る
```

```typescript
// Better: 独立したファクトリ関数（個別に tree-shakeable）
// @__NO_SIDE_EFFECTS__
export function string() {
  return { kind: "schema", type: "string" /* ... */ };
}
// @__NO_SIDE_EFFECTS__
export function number() {
  return { kind: "schema", type: "number" /* ... */ };
}
// -> string() だけ import すれば number() はバンドルから除去される
```

**モジュールトップレベルでのオブジェクト初期化:**

```typescript
// Bad: トップレベルで初期化 -> sideEffects: false との矛盾
const store = new Map(); // モジュールインポート時に副作用が発生

export function getMessage(lang?: string) {
  return store.get(lang);
}
```

```typescript
// Better: 宣言のみ + 遅延初期化
let store: Map<string | undefined, string>;

export function setMessage(lang: string | undefined, msg: string) {
  if (!store) store = new Map(); // 初回利用時に生成
  store.set(lang, msg);
}
```

**`@__NO_SIDE_EFFECTS__` なしのファクトリ関数:**

```typescript
// Bad: アノテーションなし -> getter を含むとバンドラが副作用ありと判定しうる
export function createValidator(regex: RegExp) {
  return {
    get pattern() {
      return regex;
    },
    validate(input: string) {
      return regex.test(input);
    },
  };
}
```

```typescript
// Better: アノテーションで tree-shaking を保証
// @__NO_SIDE_EFFECTS__
export function createValidator(regex: RegExp) {
  return {
    get pattern() {
      return regex;
    },
    validate(input: string) {
      return regex.test(input);
    },
  };
}
```

## 適用ガイド

### どのような状況で使うべきか

- **バンドルサイズが KPI のライブラリ**: ユーティリティライブラリ、バリデーションライブラリ、UI コンポーネントライブラリなど、ユーザーが一部の機能だけを使うケースが多いライブラリ
- **多数の独立した関数を提供するライブラリ**: 50 以上の関数をエクスポートし、ユーザーが全関数を使うことは稀なケース
- **ゼロ依存を目指すライブラリ**: ランタイム依存がないことでバンドルサイズの上限を保証したい場合

### 導入手順

1. **`package.json`** に `"sideEffects": false` を設定
2. **全ファクトリ関数**（プレーンオブジェクトを返す public API）に `// @__NO_SIDE_EFFECTS__` を付与
3. **副作用関数の除外**: `set*`, `delete*`, `write*` など実際に副作用を持つ関数にはアノテーションを付与しない
4. **モジュールレベル副作用の排除**: トップレベルの `new Map()`, `new Set()`, `addEventListener()` 等を遅延初期化に置換
5. **正規表現の集約**: 関数内リテラルをモジュールレベル定数に移動
6. **ESLint ルール追加**: `regexp/require-unicode-regexp`, `regexp/prefer-regexp-exec`, `redos-detector/no-unsafe-regex` の3ルール

### 注意点

- `@__NO_SIDE_EFFECTS__` は TypeScript のオーバーロード宣言がある場合、**実装本体の直前**に配置する（オーバーロード宣言の前ではない）
- `Error` の拡張など class が必要なケースは例外として許容する（valibot でも `ValiError` のみ class を使用）
- `sideEffects: false` はパッケージ全体の宣言であり、個々の関数レベルの判定はできない。`@__NO_SIDE_EFFECTS__` との併用が必須
- ホットパスでの spread 演算子回避は、プロパティ数が固定のオブジェクトに限定して適用する（動的プロパティには不向き）

### カスタマイズポイント

- **正規表現の集約先**: valibot は `regex.ts` 1ファイルに集約しているが、カテゴリ別に分割しても良い。重要なのはモジュールレベル定数であること
- **アノテーションの種類**: `@__NO_SIDE_EFFECTS__` の代わりに `@__PURE__` も使える。`@__PURE__` は個別の呼び出し式に付与し、`@__NO_SIDE_EFFECTS__` は関数宣言に付与する点が異なる
- **ESLint の ReDoS ルール**: `redos-detector/no-unsafe-regex` は誤検知がありうるため `ignoreError: true` オプションの検討を推奨（valibot も同設定）

## 参考

- [repos/open-circle/valibot/performance-techniques.md](../repos/open-circle/valibot/performance-techniques.md) -- パフォーマンス最適化手法の分析
- [repos/open-circle/valibot/design-philosophy.md](../repos/open-circle/valibot/design-philosophy.md) -- ファクトリ関数パターンの設計思想
- [repos/open-circle/valibot/dependency-management.md](../repos/open-circle/valibot/dependency-management.md) -- ゼロ依存戦略と tree-shaking の関係
- [repos/open-circle/valibot/build-and-tooling.md](../repos/open-circle/valibot/build-and-tooling.md) -- ビルド構成とアノテーション戦略
