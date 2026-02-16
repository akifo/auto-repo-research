# ビルドとツーリング

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

valibot のビルドパイプラインは、tsdown による ESM+CJS デュアル出力、`isolatedDeclarations` による高速型生成、`@__NO_SIDE_EFFECTS__` アノテーションによるツリーシェイキング最適化、JSR/Deno 互換の同一ソースコード配信、そして `pkg.pr.new` による PR プレビュー公開を統合している。バンドルサイズを最重要指標とするスキーマライブラリにおいて、ビルド設定がランタイムコード品質に直結する設計判断が随所に見られ、注目に値する。

## 背景にある原則

- **ソースコード = 正規の配信単位**: JSR (`jsr.json`) には `"exports": "./src/index.ts"` とソースファイルそのものを指定し、npm には tsdown でビルドした成果物を配信する。同一の TypeScript ソースが Node.js（ESM/CJS）、Deno、JSR のすべてで動作する。`.ts` 拡張子付きインポートと `allowImportingTsExtensions` がこれを可能にしている（`library/tsconfig.json:3`, `library/jsr.json:4`）。

- **ツリーシェイキング可能性は設計時に確保する**: バンドラ任せにせず、ソースコード側で `@__NO_SIDE_EFFECTS__`（252箇所）と `"sideEffects": false`（`package.json:37`）を宣言し、未使用コードの除去を保証する。ファクトリ関数が副作用なしであることをバンドラに伝えるために、関数宣言の直前にコメントアノテーションを置く一貫したパターンがある。

- **型の独立生成で CI を高速化する**: `isolatedDeclarations` により各ファイルが単独で `.d.ts` を生成可能になり、tsdown の DTS 生成がファイル単位で並列化される。これを支えるために、すべての公開関数がオーバーロードシグネチャで明示的な戻り値型を持つ。

- **ビルド成果物の4バリアント提供**: `tsdown.config.ts` で2つの設定（min/unmin）を配列で定義し、ESM + CJS x minified + unminified の4ファイルを出力する。ライブラリ利用者が CDN 直接参照（min）とバンドラ経由（unmin）の両方で最適なファイルを取得できる。

## 実例と分析

### tsdown による ESM+CJS デュアル出力パイプライン

tsdown 設定は配列で2つのビルド構成を宣言する。1つ目は DTS 生成付きの非圧縮ビルド、2つ目は DTS なしの圧縮ビルドで `outExtensions` を使って `.min.mjs` / `.min.cjs` というファイル名を生成する。

`package.json` の `exports` フィールドは条件付きエクスポートを使い、`import` と `require` で異なるエントリポイントと型定義ファイルを提供する。`types` が `default` より前に置かれることで、TypeScript が正しい型定義を先に解決する。

この設計は monorepo 内の `packages/to-json-schema` でも同一パターンで再利用されている。`codemod/zod-to-valibot` のみ CLI ツールのため ESM 単体出力にとどまる。

### isolatedDeclarations とオーバーロードシグネチャの連携

`isolatedDeclarations` は「各ファイルが他のファイルの型情報なしに `.d.ts` を生成できる」制約を課す。valibot ではすべての公開ファクトリ関数がオーバーロードシグネチャを持ち、各オーバーロードが具体的な戻り値型を明示することでこの制約を満たしている。

例えば `string()` は `StringSchema<undefined>` と `StringSchema<TMessage>` の2つのオーバーロードを宣言し、実装シグネチャの戻り値型も `StringSchema<ErrorMessage<StringIssue> | undefined>` と明示している。`pipe()` は19個のオーバーロードで1〜19個のパイプアイテムに対応し、各オーバーロードが正確な `SchemaWithPipe<readonly [...]>` 型を返す。

### Deno 互換の lint スクリプト

`"lint": "eslint \"src/**/*.ts*\" && tsc --noEmit && deno check ./src/index.ts"` という lint スクリプトは、ESLint、TypeScript コンパイラ、Deno の型チェッカーを直列実行する。`deno check` を lint パイプラインに統合することで、Deno ランタイムでの互換性を CI で常時検証している。

### pkg.pr.new による PR プレビュー公開

CI ワークフローでは PR ごとに `pnpx pkg-pr-new publish --compact --comment=update --pnpm` を実行し、ライブラリの一時パッケージを公開する。これによりマージ前にコンシューマが実際のパッケージをインストールして動作確認できる。

### i18n パッケージの独自ビルド戦略

i18n パッケージは tsdown を使わず、カスタムビルドスクリプトで npm 向け（ESM+CJS の `.mjs`/`.cjs` ファイル）と JSR 向け（`.ts` ファイル）をそれぞれ生成する。1つのスクリプトが24言語分のサブモジュールを動的に生成し、`package.json` の `exports` と `files` も自動更新する。npm 配信用に ESM/CJS を並行生成し、JSR 配信用には `jsr:` プロトコルで依存を指定した TypeScript ソースを生成するアプローチは、レジストリごとの要件差異を1つのコードベースから解決する実例である。

## コード例

```typescript
// library/tsdown.config.ts:1-23
import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/index.ts"],
    clean: true,
    format: ["es", "cjs"],
    minify: false,
    dts: true,
    outDir: "./dist",
  },
  {
    entry: ["./src/index.ts"],
    clean: true,
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

```typescript
// library/src/schemas/string/string.ts:56-72
// isolatedDeclarations 対応: オーバーロードシグネチャで戻り値型を明示
export function string(): StringSchema<undefined>;

export function string<
  const TMessage extends ErrorMessage<StringIssue> | undefined,
>(message: TMessage): StringSchema<TMessage>;

// @__NO_SIDE_EFFECTS__
export function string(
  message?: ErrorMessage<StringIssue>,
): StringSchema<ErrorMessage<StringIssue> | undefined> {
  return {
    kind: "schema",
    type: "string",
    reference: string,
    // ...
  };
}
```

```json
// library/jsr.json:1-9
{
  "name": "@valibot/valibot",
  "version": "1.2.0",
  "exports": "./src/index.ts",
  "publish": {
    "include": ["src/**/*.ts", "README.md"],
    "exclude": ["src/**/*.test.ts", "src/**/*.test-d.ts", "src/vitest/**/*.ts"]
  }
}
```

```typescript
// library/tsconfig.json:1-16
{
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "declaration": true,
    "exactOptionalPropertyTypes": true,
    "isolatedDeclarations": true,
    "lib": ["ESNext", "DOM"],
    "module": "ESNext",
    "moduleResolution": "node",
    "noEmit": true,
    "skipLibCheck": true,
    "strict": true,
    "target": "ES2020"
  },
  "include": ["src"]
}
```

## パターンカタログ

- **Factory Method with Overload Signatures** (分類: 生成)
  - 解決する問題: `isolatedDeclarations` 制約下で、型推論に頼らずオーバーロードごとに正確な戻り値型を提供する
  - 適用条件: オプション引数の有無で戻り値型が変わるファクトリ関数、かつ `isolatedDeclarations` を有効にしたプロジェクト
  - コード例: `library/src/schemas/string/string.ts:56-72`, `library/src/schemas/object/object.ts:60-80`
  - 注意点: オーバーロード数が多い場合（`pipe.ts` の19個など）、コード量が大幅に増加する。型安全性とコード量のトレードオフを認識した上で採用すること

- **Multi-Config Array Pattern** (分類: 構造)
  - 解決する問題: 1つのビルドツール設定ファイルから複数のバリアント（min/unmin、ESM/CJS）を出力する
  - 適用条件: CDN 直接配信とバンドラ経由配信の両方をサポートするライブラリ
  - コード例: `library/tsdown.config.ts:3-23`
  - 注意点: DTS は非圧縮ビルドのみで生成し、圧縮ビルドでは `dts: false` として重複生成を避ける

## Good Patterns

- **`@__NO_SIDE_EFFECTS__` の全ファクトリ関数への一貫適用**: ライブラリ内 252 箇所のファクトリ関数すべてに `// @__NO_SIDE_EFFECTS__` コメントを付与し、`package.json` の `"sideEffects": false` と組み合わせている。これによりバンドラが個々の関数呼び出しレベルでツリーシェイキング可能になる。

```typescript
// library/src/actions/notBytes/notBytes.ts:100-108
// @__NO_SIDE_EFFECTS__
export function notBytes(
  requirement: number,
  message?: ErrorMessage<NotBytesIssue<string, number>>
): NotBytesAction<
  string,
  number,
  ErrorMessage<NotBytesIssue<string, number>> | undefined
> {
```

- **条件付きエクスポートでの `types` 優先配置**: `exports` フィールドで `types` を `default` より前に配置し、TypeScript が正しい型定義ファイルを先に解決できるようにしている。ESM 用（`.d.mts`）と CJS 用（`.d.cts`）で別々の型定義を提供。

```json
// library/package.json:25-36
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
}
```

- **ESLint で `import/extensions: always` を強制**: `.ts` 拡張子付きインポートを ESLint ルールで必須にし、Deno 互換性と `allowImportingTsExtensions` の前提条件を CI レベルで保証している。

```javascript
// library/eslint.config.js:49
'import/extensions': ['error', 'always'], // Require file extensions
```

- **CI 環境セットアップの composite action 化**: Node.js + Deno + pnpm のセットアップ、依存のインストール、全パッケージのビルドを1つの composite action にまとめ、各 CI ジョブが `uses: ./.github/actions/environment` で再利用する。

## Anti-Patterns / 注意点

- **`isolatedDeclarations` なしでオーバーロードを省略する誘惑**: `isolatedDeclarations` を有効にせず、戻り値型の推論に頼ると、DTS 生成がプロジェクト全体の型解決を必要とし、ビルド時間が線形に増加する。

```typescript
// Bad: 戻り値型を省略（isolatedDeclarations 非対応）
export function string(message?: ErrorMessage<StringIssue>) {
  return { kind: "schema", type: "string" /* ... */ };
}

// Better: オーバーロードで戻り値型を明示（isolatedDeclarations 対応）
export function string(): StringSchema<undefined>;
export function string<const TMessage extends ErrorMessage<StringIssue> | undefined>(
  message: TMessage,
): StringSchema<TMessage>;
export function string(
  message?: ErrorMessage<StringIssue>,
): StringSchema<ErrorMessage<StringIssue> | undefined> {
  return { kind: "schema", type: "string" /* ... */ };
}
```

- **`sideEffects: false` だけでは不十分**: `package.json` の `"sideEffects": false` はパッケージ全体の宣言であり、個々の関数が副作用を持つかをバンドラに伝えられない。webpack や Rollup は関数呼び出しを副作用ありと判断する可能性がある。

```typescript
// Bad: パッケージレベルの sideEffects: false のみに依存
export function createValidator(config: Config) {
  // バンドラはこの関数呼び出しが副作用を持つか判断できない
  return {/* ... */};
}

// Better: @__NO_SIDE_EFFECTS__ を関数単位で付与
// @__NO_SIDE_EFFECTS__
export function createValidator(config: Config) {
  return {/* ... */};
}
```

## 導出ルール

- `[MUST]` ライブラリの `package.json` `exports` フィールドでは、各条件（import/require）内で `types` エントリを `default` より前に配置する
  - 根拠: TypeScript は `exports` の条件を上から順に評価するため、`types` が後に来ると型解決に失敗する場合がある（`library/package.json:26-35`）

- `[MUST]` `isolatedDeclarations` を有効にしたプロジェクトでは、すべての公開関数に明示的な戻り値型を宣言する（オーバーロードシグネチャまたは戻り値型アノテーション）
  - 根拠: `isolatedDeclarations` はファイル単体で DTS を生成するため、型推論に依存した関数はビルドエラーになる（`library/tsconfig.json:6`、全公開関数がこのパターンに従っている）

- `[SHOULD]` ツリーシェイキングを重視するライブラリでは、`"sideEffects": false` に加えて各ファクトリ関数に `// @__NO_SIDE_EFFECTS__` コメントを付与する
  - 根拠: パッケージレベルの宣言だけでは、関数呼び出し式の副作用判定をバンドラが正しく行えないケースがある（valibot は 252 箇所のファクトリ関数すべてにこのアノテーションを付与）

- `[SHOULD]` npm と JSR の両方に配信するライブラリでは、ソースコードの `.ts` 拡張子付きインポートを採用し、`allowImportingTsExtensions: true` + `noEmit: true` を設定する
  - 根拠: JSR はソースの `.ts` ファイルをそのまま配信するため、拡張子なしインポートは Deno/JSR で動作しない（`library/tsconfig.json:3`, `library/jsr.json:4`）

- `[SHOULD]` CI で Deno 互換性を検証する場合は、lint スクリプトに `deno check` を組み込む
  - 根拠: Node.js で動作しても Deno で型エラーになるケースがあり、`deno check` を CI に組み込むことで早期検出できる（`library/package.json:48`）

- `[SHOULD]` tsdown/rolldown/esbuild で ESM+CJS デュアル出力する場合は、設定を配列で定義し、DTS 生成は非圧縮ビルドのみで行う
  - 根拠: DTS は圧縮の影響を受けないため、2重生成はビルド時間の無駄になる（`library/tsdown.config.ts` の `dts: true` / `dts: false` の使い分け）

- `[AVOID]` ライブラリの `package.json` で `main` と `types` のみを指定し、`exports` を省略する
  - 根拠: `exports` なしでは CJS/ESM の条件分岐ができず、Dual Package Hazard（同一パッケージの ESM/CJS インスタンスが共存する問題）を引き起こす（valibot は `exports` で明示的に分離している）

## 適用チェックリスト

- [ ] `package.json` の `exports` で `types` が `default` より前に配置されているか
- [ ] `isolatedDeclarations` を有効にしている場合、全公開関数に明示的な戻り値型があるか
- [ ] ツリーシェイキング対象のライブラリで `"sideEffects": false` を宣言しているか
- [ ] ファクトリ関数に `@__NO_SIDE_EFFECTS__` または `@__PURE__` コメントを付与しているか
- [ ] `.ts` 拡張子付きインポートを使用し、Deno/JSR 互換性を確保しているか
- [ ] CI で `deno check` を実行して Deno 互換性を検証しているか
- [ ] tsdown 設定で DTS 生成が非圧縮ビルドでのみ有効になっているか
- [ ] npm 公開時に `--provenance` フラグを使って Supply Chain Security を確保しているか
- [ ] PR プレビュー公開（pkg.pr.new 等）を CI に組み込んで、マージ前の動作確認を可能にしているか
