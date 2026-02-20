# dependency-management

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

pnpm workspaces で 53 パッケージを管理する大規模モノレポの依存関係戦略を分析した。コアインターフェース (`@ai-sdk/provider`) を頂点に、ユーティリティ層 (`@ai-sdk/provider-utils`)、40 超のプロバイダーパッケージ、フレームワークバインディング (React/Vue/Svelte/Angular) が階層的に配置されている。特筆すべきは `workspace:*` による内部依存の統一管理、Zod 3/4 デュアルサポートの peerDependencies 戦略、`@standard-schema/spec` による検証ライブラリの抽象化、そして examples が pinned バージョンで消費者の立場をシミュレートする設計である。

## 背景にある原則

- **依存方向の一方向性**: すべてのプロバイダーパッケージは `@ai-sdk/provider` と `@ai-sdk/provider-utils` にのみ依存し、`ai` (コアパッケージ) には依存しない。UI バインディング (react/vue/svelte/angular) は `ai` に依存するが、プロバイダーには依存しない。この一方向の依存関係により、任意のプロバイダーを追加・削除してもコア層に影響しない。根拠: 全プロバイダーの `package.json` の dependencies が `@ai-sdk/provider` + `@ai-sdk/provider-utils` のみ (`packages/openai/package.json:54-55`)
- **消費者視点のバージョン固定**: examples は `workspace:*` ではなく具体的なバージョン番号 (例: `"ai": "6.0.94"`) で内部パッケージを参照する。これにより、実際のユーザーがインストールする状態を CI でテストでき、workspace protocol の暗黙的な解決に頼らない。根拠: `examples/next/package.json:13` で `"ai": "6.0.94"` と pinned
- **peerDependencies で選択肢を保持する**: ユーザーが選択すべきライブラリ (zod, react, svelte, vue, @angular/core) は peerDependencies に配置し、バンドルに含めない。これにより、ユーザー側のバージョン選択を尊重し、重複インストールを防止する。根拠: ほぼ全パッケージで `"zod": "^3.25.76 || ^4.1.8"` が peerDependencies に配置 (`packages/openai/package.json:65-67`)

## 実例と分析

### 階層化されたパッケージ依存グラフ

リポジトリの依存グラフは明確な 4 層構造を持つ。

1. **インターフェース層**: `@ai-sdk/provider` -- 外部依存は `json-schema` のみ
2. **ユーティリティ層**: `@ai-sdk/provider-utils` -- `@ai-sdk/provider` + `@standard-schema/spec` + `eventsource-parser`
3. **実装層**: 各プロバイダー (`@ai-sdk/openai`, `@ai-sdk/anthropic` 等) -- `@ai-sdk/provider` + `@ai-sdk/provider-utils` のみ
4. **統合層**: `ai` (コア) / `@ai-sdk/react` / `@ai-sdk/vue` / `@ai-sdk/svelte` -- `ai` + `@ai-sdk/provider-utils`

`@ai-sdk/openai-compatible` は中間抽象層として存在し、`@ai-sdk/xai`, `@ai-sdk/togetherai`, `@ai-sdk/fireworks` 等の OpenAI 互換プロバイダーがこれに依存する。

### workspace:* による内部依存の一元管理

すべての内部依存は `workspace:*` で宣言されている。`*` はパブリッシュ時に Changesets が実バージョンに置き換えるため、開発中は常に最新のローカルコードが使われ、公開時には正確なバージョン制約が適用される。

```json
// packages/openai/package.json:54-55
"dependencies": {
  "@ai-sdk/provider": "workspace:*",
  "@ai-sdk/provider-utils": "workspace:*"
}
```

devDependencies でも同様のパターンが統一されている:

```json
// packages/openai/package.json:58-64
"devDependencies": {
  "@ai-sdk/test-server": "workspace:*",
  "@vercel/ai-tsconfig": "workspace:*",
  // ...
}
```

### Zod 3/4 デュアルサポートの peerDependencies 戦略

Zod は peerDependencies で `"^3.25.76 || ^4.1.8"` とメジャーバージョンをまたいだ範囲指定をしている。devDependencies には Zod 3 系 (`3.25.76`) を pinned で配置し、開発・テスト時はこのバージョンを使用する。

```json
// packages/provider-utils/package.json:59-63
"devDependencies": {
  "zod": "3.25.76"
},
"peerDependencies": {
  "zod": "^3.25.76 || ^4.1.8"
}
```

実装側では `zod/v3` と `zod/v4` のサブパスインポートを使い分け、ランタイムで `_zod` プロパティの存在を検査して Zod 4 かどうかを判別する:

```typescript
// packages/provider-utils/src/schema.ts:3-4
import * as z3 from "zod/v3";
import * as z4 from "zod/v4";

// packages/provider-utils/src/schema.ts:241-246
export function isZod4Schema(
  zodSchema: z4.core.$ZodType<any, any> | z3.Schema<any, z3.ZodTypeDef, any>,
): zodSchema is z4.core.$ZodType<any, any> {
  // https://zod.dev/library-authors?id=how-to-support-zod-3-and-zod-4-simultaneously
  return "_zod" in zodSchema;
}
```

### @standard-schema/spec による検証ライブラリの抽象化

`@ai-sdk/provider-utils` は Zod だけでなく、Standard Schema 仕様に準拠した任意のバリデーターを受け入れる。`FlexibleSchema` 型がこの柔軟性を提供する:

```typescript
// packages/provider-utils/src/schema.ts:72-76
export type FlexibleSchema<SCHEMA = any> =
  | Schema<SCHEMA>
  | LazySchema<SCHEMA>
  | ZodSchema<SCHEMA>
  | StandardSchema<SCHEMA>;
```

`asSchema` 関数は `~standard` プロパティの存在と `vendor` フィールドを調べて分岐する:

```typescript
// packages/provider-utils/src/schema.ts:132-144
export function asSchema<OBJECT>(
  schema: FlexibleSchema<OBJECT> | undefined,
): Schema<OBJECT> {
  return schema == null
    ? jsonSchema({ properties: {}, additionalProperties: false })
    : isSchema(schema)
    ? schema
    : "~standard" in schema
    ? schema["~standard"].vendor === "zod"
      ? zodSchema(schema as ZodSchema<OBJECT>)
      : standardSchema(schema as StandardSchema<OBJECT>)
    : schema();
}
```

### 共有 tsconfig の tools パッケージ化

`tools/tsconfig` は `@vercel/ai-tsconfig` として workspace 内で配布され、`base.json`, `ts-library.json`, `react-library.json` の 3 つのプリセットを提供する。全パッケージが `extends` でこれを参照する:

```json
// packages/openai/tsconfig.json:1-2
{
  "extends": "./node_modules/@vercel/ai-tsconfig/ts-library.json",
```

`version: "0.0.0"`, `private: true` でパブリッシュされない内部ツールとして管理されている (`tools/tsconfig/package.json`)。

### tsconfig references と update-ts-references の自動同期

ルートの `tsconfig.json` は `references` で全パッケージを列挙し、各パッケージも依存先パッケージへの `references` を持つ。`update-ts-references` スクリプトがこれを自動生成する:

```json
// tsconfig.json (ルート):1-2
{
  "references": [
    { "path": "packages/ai" },
    { "path": "packages/mcp" }
    // ... 49 パッケージ分
  ]
}
```

```json
// packages/openai/tsconfig.json:15-22
"references": [
  { "path": "../provider" },
  { "path": "../provider-utils" }
]
```

### Turbo による依存認識ビルド

`turbo.json` の `build` タスクは `"dependsOn": ["^build"]` を指定し、依存パッケージが先にビルドされることを保証する。各パッケージの `turbo.json` は `extends: ["//"]` でルート設定を継承し、outputs のみをオーバーライドする:

```json
// turbo.json:5-6
"build": {
  "dependsOn": ["^build"],
```

### Changesets による独立バージョニング

`changeset/config.json` で `"updateInternalDependencies": "patch"` を設定し、内部依存のあるパッケージが変更された際に依存元のバージョンも patch バンプされる。`"linked": []`, `"fixed": []` は空で、各パッケージが独立してバージョニングされる。

```json
// .changeset/config.json:1-10
{
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "updateInternalDependencies": "patch"
}
```

### examples の pinned バージョン参照

examples は `workspace:*` を使わず、具体的なバージョン番号で内部パッケージを参照する:

```json
// examples/next/package.json:12-14
"dependencies": {
  "@ai-sdk/react": "3.0.96",
  "ai": "6.0.94",
```

これは `ci:version` スクリプト中の `cleanup-examples-changesets.mjs` と `pnpm install --no-frozen-lockfile` で自動更新される (`package.json:22-23`)。

### pnpm.onlyBuiltDependencies による install 高速化

ネイティブモジュールのビルドを `esbuild` のみに限定し、他のネイティブ依存がビルドされることを防いでいる:

```json
// package.json:84-88
"pnpm": {
  "onlyBuiltDependencies": [
    "esbuild"
  ]
}
```

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: 40 以上のプロバイダーの共通インターフェースを統一する
  - 適用条件: プラグインアーキテクチャで多数の実装が同一インターフェースを共有する場合
  - コード例: `@ai-sdk/provider` がインターフェース層、各プロバイダーが実装層
  - 注意点: インターフェースの変更は全プロバイダーに波及する

- **Adapter パターン** (構造)
  - 解決する問題: 既存 SDK (OpenAI, Anthropic 等) の API を共通インターフェースに適合させる
  - 適用条件: 外部ライブラリを共通インターフェースで使いたい場合
  - コード例: `@ai-sdk/openai-compatible` が OpenAI 互換 API のアダプター基盤を提供し、`@ai-sdk/xai`, `@ai-sdk/fireworks` 等が継承 (`packages/xai/package.json:47`)
  - 注意点: 中間抽象層が増えると依存チェーンが深くなる

## Good Patterns

- **peerDependencies + devDependencies の組み合わせ**: ユーザー選択ライブラリ (zod) を peerDependencies に置きつつ、devDependencies に pinned バージョンを配置してテスト時の再現性を確保する。全プロバイダーパッケージでこのパターンが統一されている。

```json
// packages/openai/package.json:63-67
"devDependencies": {
  "zod": "3.25.76"
},
"peerDependencies": {
  "zod": "^3.25.76 || ^4.1.8"
}
```

- **開発ツールの workspace パッケージ化**: tsconfig プリセット (`@vercel/ai-tsconfig`)、ESLint 設定 (`eslint-config-vercel-ai`)、テストサーバー (`@ai-sdk/test-server`) を独立パッケージとして管理。`version: "0.0.0"`, `private: true` でパブリッシュされないことを明示する。

```json
// tools/tsconfig/package.json:1-9
{
  "name": "@vercel/ai-tsconfig",
  "version": "0.0.0",
  "private": true,
  "license": "MIT"
}
```

- **peerDependenciesMeta で optional 宣言**: 必須ではない機能拡張の依存を `optional: true` で宣言し、インストール時の警告を抑制する。

```json
// packages/langchain/package.json:56-60
"peerDependenciesMeta": {
  "@langchain/langgraph": {
    "optional": true
  }
}
```

- **FlexibleSchema による多ライブラリ対応**: 特定のバリデーションライブラリに依存せず、Zod 3/4、Standard Schema 準拠ライブラリ、カスタムスキーマを統一的に受け入れる型設計。

```typescript
// packages/provider-utils/src/schema.ts:72-76
export type FlexibleSchema<SCHEMA = any> =
  | Schema<SCHEMA>
  | LazySchema<SCHEMA>
  | ZodSchema<SCHEMA>
  | StandardSchema<SCHEMA>;
```

## Anti-Patterns / 注意点

- **devDependencies のバージョン不統一**: ほぼ全パッケージで `typescript: 5.8.3` に統一されているが、一部パッケージ (`packages/revai`, `packages/gladia`) は `5.6.3` のまま残っている。依存のバージョン不統一はビルドやテストの再現性を損なう。

```json
// Bad: packages/revai/package.json:55
"typescript": "5.6.3"

// Better: 全パッケージで統一
"typescript": "5.8.3"
```

- **内部パッケージの export 粒度が不明確**: 一部のパッケージは `./internal` エクスポートを持つ (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `ai`) が、多くは持たない。`internal` は `@ai-sdk/google-vertex` が `@ai-sdk/google/internal` を使うために存在するが、安定性の保証レベルが明文化されていない。

```json
// packages/openai/package.json:46-51
"./internal": {
  "types": "./dist/internal/index.d.ts",
  "import": "./dist/internal/index.mjs",
  // ...
}
```

## 導出ルール

- `[MUST]` モノレポ内のパッケージ間依存は `workspace:*` で統一し、パブリッシュ時にツール (Changesets 等) が実バージョンに置き換える運用とする
  - 根拠: vercel/ai の全 53 パッケージが `workspace:*` で内部依存を宣言し、Changesets の `updateInternalDependencies: "patch"` で公開時のバージョン整合性を自動管理している (`packages/openai/package.json:54-55`)

- `[MUST]` ユーザーが選択すべきライブラリ (UI フレームワーク、バリデーター等) は peerDependencies に配置し、devDependencies に pinned バージョンを併記してテスト再現性を確保する
  - 根拠: 全プロバイダーパッケージで zod を `peerDependencies` に `^3.25.76 || ^4.1.8`、`devDependencies` に `3.25.76` と固定し、ユーザー側のバージョン選択を尊重しつつ開発時の決定性を保証している (`packages/openai/package.json:63-67`)

- `[SHOULD]` モノレポ内の共有設定 (tsconfig, eslint config 等) は独立した workspace パッケージとして管理し、`private: true` で外部公開を防ぐ
  - 根拠: `@vercel/ai-tsconfig` (`tools/tsconfig`) と `eslint-config-vercel-ai` (`tools/eslint-config`) がそれぞれ `private: true` のパッケージとして全パッケージから参照されている

- `[SHOULD]` examples/サンプルアプリは `workspace:*` ではなく具体的なバージョン番号で内部パッケージを参照し、消費者の視点で互換性を検証する
  - 根拠: `examples/next/package.json` で `"ai": "6.0.94"` と pinned されており、workspace protocol の暗黙的な解決に頼らずユーザーの実体験をシミュレートしている

- `[SHOULD]` メジャーバージョンをまたぐライブラリのサポートは、ランタイム検出 (feature detection) とサブパスインポートの併用で実現する
  - 根拠: `isZod4Schema` 関数が `_zod in zodSchema` で Zod 4 を検出し、`zod/v3` と `zod/v4` のサブパスで実装を切り替えている (`packages/provider-utils/src/schema.ts:241-246`)

- `[SHOULD]` pnpm の `onlyBuiltDependencies` でネイティブビルドの対象を明示的に限定し、install 時間を短縮する
  - 根拠: ルート `package.json:84-88` で `esbuild` のみに限定し、不要なネイティブモジュールのコンパイルを防いでいる

- `[AVOID]` モノレポ内の devDependencies (TypeScript, @types/node 等) でパッケージ間のバージョン不統一を放置する -- ビルドやテストの再現性が損なわれ、暗黙のバージョン差異によるバグの温床になる
  - 根拠: `packages/revai` と `packages/gladia` のみ `typescript: 5.6.3` で、他の全パッケージは `5.8.3` に統一されている不整合が存在する

## 適用チェックリスト

- [ ] パッケージ間の依存方向が一方向になっているか確認する (循環依存がないか)
- [ ] 内部パッケージ間の依存が `workspace:*` で統一されているか確認する
- [ ] ユーザー選択ライブラリ (React, Vue, バリデーター等) が peerDependencies に配置されているか確認する
- [ ] peerDependencies に対応する pinned バージョンが devDependencies に存在するか確認する
- [ ] 共有設定 (tsconfig, eslint) が独立パッケージとして管理されているか確認する
- [ ] examples/サンプルが実際の消費者と同じ方法でパッケージを参照しているか確認する
- [ ] devDependencies のバージョン (TypeScript, @types/node 等) が全パッケージで統一されているか確認する
- [ ] Changesets の `updateInternalDependencies` が適切に設定されているか確認する
- [ ] `pnpm.onlyBuiltDependencies` でネイティブビルド対象が制限されているか確認する
- [ ] tsconfig references がパッケージの依存グラフと一致しているか確認する
