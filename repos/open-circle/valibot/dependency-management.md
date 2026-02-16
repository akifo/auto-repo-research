# dependency-management

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

valibot はゼロランタイム依存を徹底したスキーマバリデーションライブラリである。コアライブラリ（`library/`）は `dependencies` フィールドを一切持たず、TypeScript すら optional な peerDependency として扱う。pnpm ワークスペースで 5 つのパッケージを管理しつつ、各パッケージの依存境界を明確に分離している。バンドルサイズ最小化のために `@__NO_SIDE_EFFECTS__` アノテーション・遅延初期化・`import type` の徹底的な活用が行われており、ゼロ依存ライブラリ設計の模範的な実装として注目に値する。

## 背景にある原則

- **ゼロ依存はバンドルサイズの上限を保証する**: ランタイム依存がゼロであれば、ユーザーのバンドルに含まれるコードは自分が書いたコードのみとなる。依存ライブラリのバージョン衝突・セキュリティ脆弱性・非推奨化のリスクも排除できる。valibot のコア `library/package.json` には `dependencies` フィールド自体が存在しない。

- **peerDependencies はインターフェース契約である**: valibot は TypeScript を `peerDependencies` + `optional: true` で宣言している。これは「TypeScript を使えばより良い体験を提供するが、なくても動作する」という契約を表現する手段であり、ユーザーのバージョン選択権を尊重する設計である（`library/package.json:72-78`）。

- **ワークスペース内パッケージは公開時の依存関係を模倣すべき**: `to-json-schema` は `valibot` をバージョン指定の `peerDependencies` で参照し（`"valibot": "^1.2.0"`）、開発時は `devDependencies` に同じバージョンを記載する。一方 `i18n` や `zod-to-valibot` は `devDependencies` に `workspace:*` を使う。この使い分けは、公開パッケージの依存解決をローカルで正確に再現するための設計判断である。

- **tree-shaking は依存ゼロだけでは実現しない**: `sideEffects: false`、`@__NO_SIDE_EFFECTS__` アノテーション、`import type` の徹底、モジュール粒度の細分化など、バンドラが安全にコードを除去できる条件を能動的に整備する必要がある。

## 実例と分析

### ゼロランタイム依存の徹底

コアライブラリの全ソースファイル（テストを除く約 538 ファイル）において、外部パッケージからのランタイム import は一切存在しない。正規表現のバリデーション（`regex.ts`）、Luhn アルゴリズム（`_isLuhnAlgo`）、バイト数カウント（`_getByteCount`）など、一般的にはライブラリに委譲しがちな処理もすべて自前で実装している。

```typescript
// library/src/regex.ts:4-5
export const BASE64_REGEX: RegExp = /^(?:[\da-z+/]{4})*(?:[\da-z+/]{2}==|[\da-z+/]{3}=)?$/iu;
```

テストファイルのみが `vitest` をインポートしており、ランタイムコードと開発時コードの境界が明確に維持されている。

### @**NO_SIDE_EFFECTS** アノテーションの全面適用

252 ファイルが `@__NO_SIDE_EFFECTS__` アノテーションを使用している。すべてのスキーマファクトリ関数、バリデーションアクション、メソッドにこのアノテーションが付与されている。これにより、バンドラ（tsdown/rollup）は未使用のファクトリ関数をバンドルから安全に除去できる。

```typescript
// library/src/schemas/string/string.ts:69-72
// @__NO_SIDE_EFFECTS__
export function string(
  message?: ErrorMessage<StringIssue>
): StringSchema<ErrorMessage<StringIssue> | undefined> {
```

```typescript
// library/src/actions/email/email.ts:93-96
// @__NO_SIDE_EFFECTS__
export function email(
  message?: ErrorMessage<EmailIssue<string>>
): EmailAction<string, ErrorMessage<EmailIssue<string>> | undefined> {
```

注目すべきは、getter を持つオブジェクトを返す関数（`string()` の `get '~standard'()`）にもこのアノテーションが付与されている点である。getter の存在はバンドラが副作用と誤判定しやすいが、アノテーションで明示的にオーバーライドしている。

### グローバルストアの遅延初期化パターン

ストレージモジュール（`globalMessage`, `schemaMessage`, `specificMessage`, `globalConfig`）は、モジュールスコープで `let store` を宣言し、最初の `set` 呼び出し時に初期化する。これにより、ストレージを使わないユーザーのバンドルから `Map` の初期化コードが除去される。

```typescript
// library/src/storages/globalMessage/globalMessage.ts:4-6
let store: Map<string | undefined, ErrorMessage<BaseIssue<unknown>>>;

export function setGlobalMessage(
  message: ErrorMessage<BaseIssue<unknown>>,
  lang?: string,
): void {
  if (!store) store = new Map();
  store.set(lang, message);
}
```

getter 関数には `@__NO_SIDE_EFFECTS__` を付与し、setter 関数には付与しない。setter は副作用（グローバル状態の変更）を持つため、正確なアノテーション運用である。

### pnpm ワークスペースの依存戦略

`pnpm-workspace.yaml` は 4 つのパッケージグループを定義する:

```yaml
# pnpm-workspace.yaml
packages:
  - 'codemod/*'
  - 'library'
  - 'packages/*'
  - 'website'
```

パッケージ間の依存参照は 3 つのパターンに分かれる:

| パッケージ                | devDependencies            | peerDependencies      | 戦略                                     |
| ------------------------- | -------------------------- | --------------------- | ---------------------------------------- |
| `@valibot/to-json-schema` | `"valibot": "^1.2.0"`      | `"valibot": "^1.2.0"` | バージョン固定で公開時を再現             |
| `@valibot/i18n`           | `"valibot": "workspace:*"` | `"valibot": "^1.0.0"` | 開発時は常に最新、公開時はセマンティック |
| `@valibot/zod-to-valibot` | `"valibot": "workspace:*"` | なし                  | 開発専用（ランタイム不要）               |

`to-json-schema` は `tsconfig.json` の `paths` で開発時のソース解決を行う:

```json
// packages/to-json-schema/tsconfig.json:14-17
"paths": {
  "valibot": ["../../library/src/index.ts"],
  "valibot/*": ["../../library/src/*"]
}
```

### import type の使い分け

`to-json-schema` パッケージは `import type * as v from 'valibot'` と `import * as v from 'valibot'` を明確に使い分けている。型定義のみを参照するファイル（型ファイル、純粋な変換ロジック）は `import type` を使い、実行時に valibot の値（関数参照）が必要なファイル（`convertSchema.ts` でのランタイム型チェック）は `import *` を使う。

```typescript
// packages/to-json-schema/src/converters/convertAction/convertAction.ts:1
import type * as v from "valibot"; // 型のみ

// packages/to-json-schema/src/converters/convertSchema/convertSchema.ts:1
import * as v from "valibot"; // ランタイム値も使用
```

### sideEffects フラグの意図的な使い分け

`sideEffects: false` はコアライブラリと `to-json-schema` に設定されているが、`i18n` パッケージは `sideEffects: true` を宣言している。これは i18n がインポートされるだけでグローバルメッセージストアを変更する副作用を持つためである。i18n のビルドスクリプト（`build-npm.ts`）は各言語ごとに `setSchemaMessage()` / `setSpecificMessage()` を呼び出すサブモジュールを生成し、ユーザーが `import "@valibot/i18n/ja"` するだけで日本語メッセージが登録される仕組みになっている。

### ルート package.json の最小化

ルートの `package.json` は `private: true` で、`devDependencies` にはフォーマッター（prettier）と TypeScript のみを持つ。ESLint、vitest、tsdown などのツールは各パッケージのローカル `devDependencies` に配置されている。これはワークスペースルートの依存を最小限に保ち、各パッケージが自身の開発ツールチェーンを独立管理する設計である。

### isolatedDeclarations による型生成の独立性

コアライブラリと `to-json-schema` の両方で `isolatedDeclarations: true` が有効化されている。これにより型宣言ファイル（`.d.ts`）の生成が各ファイル単独で完結し、型チェックのパフォーマンス向上と並列ビルドの可能性が開かれる。ゼロ依存戦略と組み合わせることで、外部型定義への依存なしに宣言ファイルを生成できる。

## パターンカタログ

- **Lazy Initialization** (分類: 生成)
  - 解決する問題: 未使用機能のモジュールスコープ初期化コストがバンドルに残る
  - 適用条件: tree-shaking 対象のライブラリで、オプショナルなグローバル状態を持つ場合
  - コード例: `library/src/storages/globalMessage/globalMessage.ts:4-6`
  - 注意点: `let` 宣言はモジュールスコープに残るが、`Map` コンストラクタ呼び出しは除去される

- **Factory Function** (分類: 生成)
  - 解決する問題: スキーマ定義時にクラスインスタンスを生成するとバンドルサイズが増大する
  - 適用条件: tree-shaking を重視するライブラリで、多数の生成関数を提供する場合
  - コード例: `library/src/schemas/string/string.ts:69-94`, `library/src/actions/email/email.ts:93-112`
  - 注意点: `@__NO_SIDE_EFFECTS__` アノテーションを付与しないとバンドラが除去しない場合がある

## Good Patterns

- **devDependencies と peerDependencies の二重宣言**: `to-json-schema` は `valibot` を `devDependencies`（開発時に利用）と `peerDependencies`（公開時の契約）の両方に同一バージョンで宣言している。これにより、開発環境では確実にインストールされ、公開時にはユーザーの valibot バージョンが使われる。

```json
// packages/to-json-schema/package.json:67-74
"devDependencies": {
  "valibot": "^1.2.0",
  ...
},
"peerDependencies": {
  "valibot": "^1.2.0"
}
```

- **内部ヘルパーのアンダースコアプレフィックス**: `_addIssue`, `_getByteCount`, `_stringify` など、公開 API だが内部使用を意図するユーティリティにアンダースコアプレフィックスを付与している。export はされるが、ユーザーに対して「内部実装であり安定性を保証しない」というシグナルを送る。

```typescript
// library/src/utils/index.ts:1-10
export * from "./_addIssue/index.ts";
export * from "./_getByteCount/index.ts";
export * from "./_getGraphemeCount/index.ts";
export * from "./_getLastMetadata/index.ts";
export * from "./_getStandardProps/index.ts";
```

- **Dual ESM+CJS ビルドの標準化**: tsdown 設定で ESM（`.mjs`）と CJS（`.cjs`）の両方を出力し、minified 版も別拡張子で提供する。`exports` フィールドで `import`/`require` 条件を明示し、あらゆる消費環境に対応する。

```typescript
// library/tsdown.config.ts:3-23
export default defineConfig([
  {
    entry: ["./src/index.ts"],
    format: ["es", "cjs"],
    minify: false,
    dts: true,
  },
  {
    entry: ["./src/index.ts"],
    format: ["es", "cjs"],
    minify: true,
    outExtensions: ({ format }) => ({
      js: format === "cjs" ? ".min.cjs" : ".min.mjs",
    }),
  },
]);
```

## Anti-Patterns / 注意点

- __workspace:_ の無差別使用_*: `workspace:*` は便利だが、公開パッケージの `peerDependencies` と乖離するリスクがある。valibot は `to-json-schema` で `"valibot": "^1.2.0"` を dev/peer 両方に明記し、`i18n` では `workspace:*`（dev）と `"^1.0.0"`（peer）を使い分けている。

```json
// Bad: peerDependencies のバージョンと devDependencies の workspace:* が乖離
"devDependencies": { "core-lib": "workspace:*" },
"peerDependencies": { "core-lib": "^2.0.0" }
// core-lib が v3 に上がっても dev では常に最新が使われ、v2 互換性の破損に気づけない

// Better: バージョン範囲を明示して公開時の挙動を開発時に再現
"devDependencies": { "core-lib": "^2.0.0" },
"peerDependencies": { "core-lib": "^2.0.0" }
```

- **@**NO_SIDE_EFFECTS** の付与漏れ**: ファクトリ関数にこのアノテーションを付与し忘れると、バンドラは未使用でもその関数呼び出しを除去しない。特にオブジェクトリテラルに getter を含む場合、バンドラは副作用ありと判定する可能性が高い。

```typescript
// Bad: アノテーションなし — バンドラが副作用ありと判定する可能性
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

// Better: アノテーション付与で tree-shaking を保証
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

## 導出ルール

- `[MUST]` ライブラリのコアパッケージはランタイム `dependencies` をゼロに保ち、必要な機能は自前実装するか peerDependencies で委譲する
  - 根拠: valibot のコアライブラリは 538 以上のソースファイルで外部ランタイム import がゼロであり、正規表現やアルゴリズムもすべて自前実装している（`library/src/regex.ts`, `library/src/utils/_isLuhnAlgo/`）

- `[MUST]` tree-shaking 対象のファクトリ関数には `// @__NO_SIDE_EFFECTS__` アノテーションを付与する（特にオブジェクトリテラルに getter を含む場合）
  - 根拠: valibot は 252 ファイルでこのアノテーションを使用し、getter 付きオブジェクトを返す `string()` 等にも漏れなく適用している（`library/src/schemas/string/string.ts:69`）

- `[SHOULD]` ワークスペース内の公開パッケージでは、コアライブラリを `peerDependencies` と `devDependencies` の両方に同一バージョン範囲で宣言し、開発時と公開時の依存解決を一致させる
  - 根拠: `to-json-schema` は `"valibot": "^1.2.0"` を dev/peer 両方に記載し、公開後のバージョン不整合を防いでいる（`packages/to-json-schema/package.json:67-74`）

- `[SHOULD]` オプショナルなグローバル状態はモジュールスコープで変数宣言のみ行い、初回使用時に遅延初期化する（Lazy Initialization）
  - 根拠: valibot のストレージモジュールは `let store` のみ宣言し、`set` 時に `if (!store) store = new Map()` で初期化することで、未使用時のバンドルサイズを削減している（`library/src/storages/globalMessage/globalMessage.ts:4-6`）

- `[SHOULD]` `sideEffects` フラグはパッケージの実際の挙動に合わせて正確に設定する — 純粋なライブラリは `false`、インポート時にグローバル状態を変更するパッケージは `true`
  - 根拠: valibot コアと `to-json-schema` は `sideEffects: false`、`i18n`（インポート時にメッセージストアを変更する）は `sideEffects: true` と正確に使い分けている

- `[AVOID]` ワークスペースルートの `devDependencies` にパッケージ固有のツール（テストフレームワーク、リンター、バンドラ）を配置すること — 各パッケージのローカル `devDependencies` で管理する
  - 根拠: valibot のルート `package.json` には prettier と typescript のみがあり、vitest・eslint・tsdown は各パッケージが個別に管理している。これによりパッケージ間のツールバージョン独立性が保たれる

## 適用チェックリスト

- [ ] コアライブラリの `package.json` に `dependencies` フィールドがないことを確認する
- [ ] すべてのファクトリ関数（オブジェクトを生成して返す public API）に `@__NO_SIDE_EFFECTS__` アノテーションが付与されているか確認する
- [ ] `package.json` の `sideEffects` フラグがパッケージの実際の挙動と一致しているか確認する
- [ ] ワークスペース内の公開パッケージで、`peerDependencies` に宣言したパッケージが `devDependencies` にも適切なバージョン範囲で記載されているか確認する
- [ ] `import type` を使えるインポート（型のみの参照）に `import type` が適用されているか確認する
- [ ] モジュールスコープでの即時初期化（`const store = new Map()`）が、遅延初期化（`let store; if (!store) store = new Map()`）に置き換え可能でないか検討する
- [ ] `tsconfig.json` の `isolatedDeclarations: true` を有効化し、型生成がファイル単独で完結することを確認する
- [ ] ワークスペースルートの `devDependencies` にパッケージ固有のツールが混入していないか確認する
