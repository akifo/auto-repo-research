# performance-techniques

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

valibot はバンドルサイズの最小化と実行時パフォーマンスの両面を徹底的に最適化したスキーマバリデーションライブラリである。全エクスポート関数に `@__NO_SIDE_EFFECTS__` アノテーションを付与し、`sideEffects: false` と組み合わせた tree-shaking 戦略は、ライブラリ設計のベストプラクティスとして注目に値する。さらに、ホットパスでのオブジェクト構築最適化（spread 演算子の回避）、RegExp パフォーマンスへの配慮（exec 優先の ESLint ルール）、遅延初期化によるモジュールレベル副作用の排除など、複数の層でパフォーマンス戦略が重なっている。

## 背景にある原則

- **「使わないものは含めない」原則**: ライブラリの全体サイズではなく、ユーザーが実際にインポートした関数だけがバンドルに含まれるべきである。valibot は 250 以上の関数すべてを個別に tree-shakeable にすることで、この原則を徹底している。根拠: `sideEffects: false`（`library/package.json:37`）と全関数への `@__NO_SIDE_EFFECTS__` アノテーション（258 ファイルに適用）
- **バンドラに証明可能な純粋性を提供する原則**: ツールが自動判定できない場合、開発者が明示的に副作用の不在を宣言すべきである。バンドラは関数呼び出しの副作用を静的に判定できないため、アノテーションで補助する必要がある。根拠: ファクトリ関数パターン（`string()` のように呼び出し時にオブジェクトを返す）はバンドラにとって副作用の有無が不明瞭
- **ホットパスでの微小最適化が累積効果を生む原則**: バリデーションは大量のデータに対して繰り返し実行されるため、1回あたり数マイクロ秒の差が全体として大きな影響を持つ。根拠: `_addIssue` と `getGlobalConfig` での spread 演算子回避コメント（`library/src/utils/_addIssue/_addIssue.ts:83-84`, `library/src/storages/globalConfig/globalConfig.ts:31-32`）
- **静的解析で防御可能なパフォーマンスリスクは自動化する原則**: ReDoS や非効率な正規表現パターンなど、コードレビューで見落としやすい問題は ESLint ルールで強制すべきである。根拠: `redos-detector/no-unsafe-regex`, `regexp/prefer-regexp-exec`, `regexp/require-unicode-regexp` の3つのルールを同時適用（`library/eslint.config.js:86-98`）

## 実例と分析

### @**NO_SIDE_EFFECTS** アノテーション戦略

valibot のコアとなるパフォーマンス戦略は、すべてのエクスポート関数に `// @__NO_SIDE_EFFECTS__` コメントアノテーションを付与することである。このアノテーションは Rollup / esbuild / tsdown 等のバンドラに「この関数呼び出しの戻り値が使われなければ、呼び出し自体を除去してよい」と伝える。

重要なのは、アノテーションの配置位置が厳密に制御されている点である。TypeScript のオーバーロード宣言がある場合、アノテーションは実装本体の直前に置かれる。

```typescript
// library/src/schemas/string/string.ts:56-94
// オーバーロード宣言（ここには付けない）
export function string(): StringSchema<undefined>;
export function string<
  const TMessage extends ErrorMessage<StringIssue> | undefined,
>(message: TMessage): StringSchema<TMessage>;

// 実装本体の直前に配置
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
    // ...
  };
}
```

さらに、`set*` / `delete*` のような実際に副作用を持つ関数（ストレージへの書き込み）にはアノテーションが付与されていない。一方で `get*` 関数には付与されている。この使い分けが正確な tree-shaking を保証する。

```typescript
// library/src/storages/schemaMessage/schemaMessage.ts:1-32
let store: Map<string | undefined, ErrorMessage<BaseIssue<unknown>>>;

// set は副作用あり → アノテーションなし
export function setSchemaMessage(
  message: ErrorMessage<BaseIssue<unknown>>,
  lang?: string,
): void {
  if (!store) store = new Map();
  store.set(lang, message);
}

// get は純粋 → アノテーションあり
// @__NO_SIDE_EFFECTS__
export function getSchemaMessage(
  lang?: string,
): ErrorMessage<BaseIssue<unknown>> | undefined {
  return store?.get(lang);
}
```

### sideEffects: false とモジュールレベル副作用の排除

`package.json` の `"sideEffects": false` 宣言はパッケージ全体レベルで tree-shaking を有効化する。これが安全に機能するためには、モジュールのトップレベルに副作用（グローバル変数の変更、DOM 操作、即座に実行される関数等）が存在しないことが前提となる。

valibot ではストレージの初期化を遅延させることでこの前提を満たしている。

```typescript
// library/src/storages/specificMessage/specificMessage.ts:28-31
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

### ホットパスでの spread 演算子の回避

`_addIssue` ユーティリティと `getGlobalConfig` では、オブジェクト構築に spread 演算子 (`{...obj}`) を使わず、プロパティを個別に列挙している。コードコメントで「for performance reasons」と明示されている。

```typescript
// library/src/storages/globalConfig/globalConfig.ts:27-38
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

spread 演算子はプロパティの列挙とコピーを行うため、V8 エンジンの hidden class 最適化を妨げる可能性がある。プロパティを明示的に列挙することで、V8 は一貫した hidden class を割り当てやすくなる。

### RegExp パフォーマンスの ESLint 強制

ESLint の設定で3つの正規表現パフォーマンス関連ルールが同時に有効化されている。

```javascript
// library/eslint.config.js:86-98
'regexp/require-unicode-regexp': 'error',
  // /u flag is faster and enables regexp strict mode
'regexp/prefer-regexp-exec': 'error',
  // Enforce that RegExp#exec is used instead of String#match
  // if no global flag is provided, as exec is faster
'redos-detector/no-unsafe-regex': ['error', { ignoreError: true }],
  // Prevent DoS regexps
```

`/u` フラグは正規表現の strict モードを有効化し、無効なエスケープシーケンスをエラーにするだけでなく、エンジンの内部最適化パスを使えるようにする。`regexp/prefer-regexp-exec` は `String#match` の代わりに `RegExp#exec` を使うよう強制する（グローバルフラグなしの場合、exec のほうが高速）。`redos-detector/no-unsafe-regex` は ReDoS 攻撃に対する防御として、指数的バックトラッキングを起こす正規表現を検出する。

### 正規表現のモジュールレベル定義

バリデーションに使う正規表現は `regex.ts` にモジュールレベルの定数として集約されている。これにより、関数呼び出しごとの正規表現再コンパイルを防ぎ、tree-shaking も可能にしている。

```typescript
// library/src/regex.ts:4-5
export const BASE64_REGEX: RegExp = /^(?:[\da-z+/]{4})*(?:[\da-z+/]{2}==|[\da-z+/]{3}=)?$/iu;

// library/src/regex.ts:31-32
export const EMAIL_REGEX: RegExp = /^[\w+-]+(?:\.[\w+-]+)*@[\da-z]+(?:[.-][\da-z]+)*\.[a-z]{2,}$/iu;
```

各アクション（`email`, `uuid` 等）はこの定数をインポートするだけで、使われない正規表現は tree-shaking で除去される。

### ファクトリ関数パターンによる tree-shakeable API 設計

valibot の API は class ベースではなくファクトリ関数パターンを採用している。`string()`, `object()`, `email()` 等の関数がプレーンオブジェクトを返す設計により、各関数が独立して tree-shakeable になる。class ベースの設計では prototype チェーンや継承がバンドラの静的解析を困難にする。

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
    requirement: EMAIL_REGEX,
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

唯一の例外は `ValiError` クラスで、`Error` の拡張が必要なため class を使用している。ここにもコンストラクタに `@__NO_SIDE_EFFECTS__` が付与されている（`library/src/utils/ValiError/ValiError.ts:26`）。

### ビルド構成: minified と non-minified の並列出力

tsdown の設定で、同一エントリから minified と non-minified の両方を出力している。

```typescript
// library/tsdown.config.ts:1-23
export default defineConfig([
  {
    entry: ["./src/index.ts"],
    format: ["es", "cjs"],
    minify: false,
    dts: true,
    outDir: "./dist",
  },
  {
    entry: ["./src/index.ts"],
    format: ["es", "cjs"],
    minify: true,
    dts: false,
    outDir: "./dist",
    outExtensions: ({ format }) => ({
      js: format === "cjs" ? ".min.cjs" : ".min.mjs",
    }),
  },
]);
```

non-minified 版はデバッグ可読性を提供し、minified 版（`.min.mjs`, `.min.cjs`）はバンドルサイズのベンチマーク用として利用される。`dts` は non-minified 側のみで生成し、ビルド時間を節約している。

### isolatedDeclarations によるビルドパフォーマンス

`tsconfig.json` で `isolatedDeclarations: true` が有効化されている（`library/tsconfig.json:6`）。これは各ファイルの型宣言を他ファイルの型情報なしに生成可能にするフラグで、`tsdown` のような並列ビルドツールが `.d.ts` 生成を高速化できる。

## パターンカタログ

- **Factory Method** (分類: 生成パターン)
  - 解決する問題: class ベースの API は prototype チェーンにより tree-shaking が困難
  - 適用条件: ライブラリの公開 API で、ユーザーが必要な機能だけをインポートしたい場合
  - コード例: `library/src/schemas/string/string.ts:70-94` (`string()` がプレーンオブジェクトを返す)
  - 注意点: class の extends/instanceof が必要なケース（例: `ValiError`）には適用できない

## Good Patterns

- **副作用アノテーションの選択的適用**: 純粋関数（`get*`, ファクトリ関数）にのみ `@__NO_SIDE_EFFECTS__` を付与し、実際に副作用を持つ関数（`set*`, `delete*`）には付与しない。この正確な使い分けがバンドラの最適化精度を高める。

```typescript
// library/src/storages/globalConfig/globalConfig.ts:16-18
// 副作用あり → アノテーションなし
export function setGlobalConfig(config: GlobalConfig): void {
  store = { ...store, ...config };
}

// library/src/storages/globalConfig/globalConfig.ts:27-38
// 純粋関数 → アノテーションあり
// @__NO_SIDE_EFFECTS__
export function getGlobalConfig<const TIssue extends BaseIssue<unknown>>(
  config?: Config<TIssue>,
): Config<TIssue> {/* ... */}
```

- **遅延初期化によるモジュールレベル副作用の排除**: ストレージの `Map` をモジュールロード時に生成せず、初回書き込み時に生成する。これにより `sideEffects: false` の前提を維持し、未使用モジュールの完全な tree-shaking を可能にする。

```typescript
// library/src/storages/schemaMessage/schemaMessage.ts:4
let store: Map<string | undefined, ErrorMessage<BaseIssue<unknown>>>;
// ↑ 宣言のみ（undefined）

// library/src/storages/schemaMessage/schemaMessage.ts:15-17
export function setSchemaMessage(/* ... */): void {
  if (!store) store = new Map(); // 初回呼び出し時に生成
  store.set(lang, message);
}
```

- **ルックアップテーブルによる計算回避**: Luhn アルゴリズムの実装で、倍数計算を配列ルックアップで置き換えている。

```typescript
// library/src/utils/_isLuhnAlgo/_isLuhnAlgo.ts:27-29
while (length) {
  const value = +number[--length];
  bit ^= 1;
  sum += bit ? [0, 2, 4, 6, 8, 1, 3, 5, 7, 9][value] : value;
}
```

## Anti-Patterns / 注意点

- **spread 演算子のホットパス使用**: ホットパス（バリデーション実行中に繰り返し呼ばれるコード）で `{...obj}` を使うと、V8 の hidden class 最適化を妨げ、プロパティ列挙のオーバーヘッドが累積する。

```typescript
// Bad: ホットパスでの spread
function getGlobalConfig(config) {
  return { ...store, ...config };
}

// Better: プロパティの明示的な列挙
function getGlobalConfig(config) {
  return {
    lang: config?.lang ?? store?.lang,
    message: config?.message,
    abortEarly: config?.abortEarly ?? store?.abortEarly,
    abortPipeEarly: config?.abortPipeEarly ?? store?.abortPipeEarly,
  };
}
```

- **モジュールトップレベルでのオブジェクト初期化**: `sideEffects: false` 宣言下でトップレベルに `new Map()` や `new Set()` を置くと、バンドラが「副作用なし」と判断してコードを除去した際に実行時エラーになるか、逆に tree-shaking が無効化される。

```typescript
// Bad: トップレベルで初期化
const store = new Map(); // モジュールインポート時に副作用

// Better: 宣言のみ＋遅延初期化
let store: Map<string, string>;
export function set(key: string, value: string) {
  if (!store) store = new Map();
  store.set(key, value);
}
```

- **class ベースの tree-shakeable API**: class の prototype メソッドはバンドラが「使用されていない」と判定しにくく、class 全体がバンドルに含まれやすい。

```typescript
// Bad: class API（メソッドが個別に tree-shake されない）
class Schema {
  string() {/* ... */}
  number() {/* ... */}
  email() {/* ... */}
}

// Better: 独立したファクトリ関数（個別に tree-shakeable）
export function string() {
  return { kind: "schema" /* ... */ };
}
export function number() {
  return { kind: "schema" /* ... */ };
}
export function email() {
  return { kind: "validation" /* ... */ };
}
```

## 導出ルール

- `[MUST]` tree-shakeable ライブラリでは `package.json` に `"sideEffects": false` を設定し、すべてのファクトリ関数・純粋関数に `// @__NO_SIDE_EFFECTS__` アノテーションを付与する
  - 根拠: valibot は 258 ファイルにアノテーションを適用し、`sideEffects: false` と組み合わせて個別関数レベルの tree-shaking を実現している（`library/package.json:37`）
- `[MUST]` 副作用を持つ関数（ストレージ書き込み、DOM 操作等）には `@__NO_SIDE_EFFECTS__` を付与しない ── 純粋関数と副作用関数を正確に区別する
  - 根拠: valibot の `set*`/`delete*` 関数にはアノテーションがなく、`get*` 関数にのみ付与されている（`library/src/storages/` 全ファイル）
- `[SHOULD]` `sideEffects: false` を宣言するパッケージでは、モジュールのトップレベルに副作用のあるコード（`new Map()`, `addEventListener` 等）を置かず、遅延初期化パターンを使う
  - 根拠: valibot のストレージモジュールは全て `let store` の宣言のみをトップレベルに置き、初回利用時に初期化している（`library/src/storages/specificMessage/specificMessage.ts:28-31`）
- `[SHOULD]` バリデーションやシリアライゼーションなど繰り返し実行されるホットパスでは、spread 演算子 (`{...obj}`) の代わりにプロパティの明示的列挙でオブジェクトを構築する
  - 根拠: `_addIssue` と `getGlobalConfig` が「deliberately not constructed with the spread operator for performance reasons」とコメントしている（`library/src/utils/_addIssue/_addIssue.ts:83-84`）
- `[SHOULD]` 正規表現の安全性・パフォーマンスを ESLint ルールで自動検証する ── `regexp/require-unicode-regexp`（/u フラグ強制）、`regexp/prefer-regexp-exec`（exec 優先）、`redos-detector/no-unsafe-regex`（ReDoS 防止）の3つを組み合わせる
  - 根拠: valibot の ESLint 設定でこの3ルールが error レベルで有効化されている（`library/eslint.config.js:86-98`）
- `[SHOULD]` ライブラリの公開 API は class ベースではなくファクトリ関数（プレーンオブジェクトを返す関数）で設計し、個別の関数単位で tree-shaking できるようにする
  - 根拠: valibot の全スキーマ・アクション・メソッドがファクトリ関数パターンで実装されている（唯一の例外は Error 拡張が必要な `ValiError` クラス）
- `[AVOID]` 繰り返し使用される正規表現を関数内でリテラルとして定義すること ── モジュールレベルの定数として定義し、再コンパイルを防止する
  - 根拠: valibot は 30 以上の正規表現を `library/src/regex.ts` にモジュールレベル定数として集約し、各アクションからインポートしている

## 適用チェックリスト

- [ ] `package.json` に `"sideEffects": false` を設定しているか
- [ ] すべてのエクスポートファクトリ関数・純粋関数に `// @__NO_SIDE_EFFECTS__` アノテーションを付与しているか
- [ ] 副作用を持つ関数（`set*`, `delete*`, `write*` 等）にはアノテーションを付与していないことを確認したか
- [ ] モジュールのトップレベルに副作用のあるコード（`new Map()`, `console.log()`, イベントリスナー登録等）がないか
- [ ] ストレージやキャッシュの初期化は遅延パターン（初回利用時に `if (!store) store = new Map()`）を使っているか
- [ ] ホットパスで spread 演算子 (`{...obj}`) を使っていないか ── プロパティの明示的列挙に置き換えられるか検討したか
- [ ] 正規表現が関数内リテラルではなくモジュールレベル定数として定義されているか
- [ ] ESLint に `regexp/require-unicode-regexp`, `regexp/prefer-regexp-exec`, `redos-detector/no-unsafe-regex` を導入しているか
- [ ] ライブラリの公開 API が class ベースではなくファクトリ関数パターンで設計されているか（tree-shaking 可能か）
- [ ] ビルド設定で `isolatedDeclarations` を有効化し、並列ビルドの恩恵を受けられるようにしているか
