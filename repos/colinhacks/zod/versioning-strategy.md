# Versioning Strategy

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod の v3 から v4 へのメジャーバージョン移行は、内部を完全に書き直しつつ、同一パッケージ内で旧バージョンの API を丸ごとサブパスエクスポートとして維持するという戦略を採用している。v3 のソースコードは v4 のコードとは完全に独立した実装として `src/v3/` に保持され、`zod/v3` でアクセスできる。さらにバージョン間の整合性を自動検証するスクリプト、エコシステム互換性のためのインテグレーションテスト、型解決の正当性を検証する `attw` テストなど、多層的な品質保証ゲートが注目に値する。

## 背景にある原則

- **同一パッケージ内バージョン共存**: メジャーバージョン移行でも npm パッケージ名を変えず、サブパスエクスポート (`zod/v3`, `zod/v4`) で新旧 API を共存させるべき。これにより、ユーザーは依存関係を増やさずに段階的移行が可能になる。根拠: `packages/zod/package.json` の exports マップに `./v3`, `./v4`, `./v4/core`, `./v4/mini` が並列定義されている。

- **互換レイヤーは薄く、非推奨アノテーション付き**: 新バージョンでは旧 API を `@deprecated` JSDoc 付きでエクスポートし、IDE の警告を通じて段階的に新 API への移行を促すべき。根拠: `src/v4/classic/compat.ts` で `TypeOf`, `ZodSchema`, `setErrorMap` 等が `@deprecated` 付きで再エクスポートされている。

- **バージョン番号は単一の真実源から導出する**: パッケージバージョンは複数の場所に分散しがちだが、自動チェックで不整合を防止すべき。根拠: `scripts/check-versions.ts` が `package.json`, `jsr.json`, `src/v4/core/versions.ts` の 3 箇所の整合性を検証し、pre-commit/pre-push フックで実行される。

- **エコシステムの実地検証をテストに含める**: メジャーバージョン移行では、自分のライブラリ単体のテストだけでなく、主要な下流ライブラリとの組み合わせテストを CI に組み込むべき。根拠: `packages/integration/` で drizzle-zod, AI SDK との型互換性を検証しており、CI の `test.yml` で毎回実行される。

## 実例と分析

### サブパスエクスポートによるバージョン共存

Zod はメジャーバージョンを跨いで同一 npm パッケージ内に複数のエントリポイントを並存させている。デフォルトの `zod` は v4 API を返すが、`zod/v3` で完全な v3 API にアクセスできる。

エントリポイントの構造:
- `zod` (デフォルト) → `src/index.ts` → `v4/classic/external.ts`
- `zod/v3` → `src/v3/index.ts` (独立した v3 実装)
- `zod/v4` → `src/v4/index.ts` → `v4/classic/index.ts`
- `zod/mini` → `src/mini/index.ts` → `v4/mini/external.ts`
- `zod/v4/core` → 低レベル API

v3 のソースコード (5,138 行の `types.ts` を含む) は v4 のコードに一切依存せず、完全な独立実装として維持されている。これにより、v3 に対するバグフィックスを v4 の変更に影響されずに行える。

### @deprecated アノテーションによる段階的移行ガイド

v4 のメインエントリ (`v4/classic/`) には `compat.ts` というファイルがあり、v3 で使われていた API 名を `@deprecated` 付きで再エクスポートしている。加えて、`schemas.ts` 内では v3 で提供されていたメソッド (`.email()`, `.passthrough()`, `.merge()` 等) が `@deprecated` 付きで残されている。

これにより、ユーザーは `zod` を v4 にアップデートしても既存コードがそのまま動作し、IDE が非推奨メソッドに取り消し線を表示することで段階的な移行が可能になる。

### 三重バージョン整合性チェック

バージョン番号は以下の 3 箇所に存在する:
1. `packages/zod/package.json` の `version` フィールド
2. `packages/zod/jsr.json` の `version` フィールド
3. `packages/zod/src/v4/core/versions.ts` の `version` オブジェクト

`scripts/check-versions.ts` がこれら 3 箇所の整合性を検証し、pre-commit と pre-push の両方で実行される。さらに `scripts/check-semver.ts` が `x.y.z` 形式の妥当性を検証する。リリースワークフロー (`release.yml`) でも `prepublishOnly` スクリプト経由で同じチェックが走る。

### エコシステム互換性テストの多層構造

Zod のテスト戦略は以下の 4 層で構成されている:

1. **ユニットテスト**: v3 と v4 それぞれのテストスイート (v3 テストは `import * as z from "zod/v3"` でインポート)
2. **型解決テスト**: `@zod/resolution` パッケージで CJS/ESM/TSC の各モジュール解決を検証
3. **ATTW テスト**: `@arethetypeswrong/cli` で全エクスポートパスの型正当性をスナップショットテスト
4. **インテグレーションテスト**: `@zod/integration` パッケージで drizzle-zod, AI SDK との型互換性を `skipLibCheck: false` で検証

CI (`test.yml`) は TypeScript 5.5 と latest の 2 バージョンでテストを実行し、さらに resolution テストと integration テストを必ず実行する。

### ベンチマークによる v3/v4 性能比較

`packages/bench/` では v3 (npm alias `zod3`) と v4 を同一ベンチマークで比較できる仕組みがある。`packages/tsc/` では型チェック性能を v3, v4, 他ライブラリ (arktype, valibot) と比較している。これにより、メジャーバージョン移行で性能が後退していないことを定量的に検証できる。

### カナリアリリース戦略

`release.yml` は、package.json のバージョンが npm に既にパブリッシュ済みの場合、自動的にカナリアリリースとして `X.Y+1.0-canary.YYYYMMDDTHHMMSS` 形式のバージョンを生成し、`canary` タグでパブリッシュする。これにより、main ブランチへのマージが即座にカナリアとして配信される。

## コード例

```typescript
// packages/zod/package.json:52-113 (サブパスエクスポート定義)
"exports": {
    "./package.json": "./package.json",
    ".": {
      "@zod/source": "./src/index.ts",
      "types": "./index.d.cts",
      "import": "./index.js",
      "require": "./index.cjs"
    },
    "./v3": {
      "@zod/source": "./src/v3/index.ts",
      "types": "./v3/index.d.cts",
      "import": "./v3/index.js",
      "require": "./v3/index.cjs"
    },
    "./v4": {
      "@zod/source": "./src/v4/index.ts",
      "types": "./v4/index.d.cts",
      "import": "./v4/index.js",
      "require": "./v4/index.cjs"
    }
}
```

```typescript
// packages/zod/src/v4/classic/compat.ts:1-70 (v3 互換レイヤー)
// Zod 3 compat layer

import * as core from "../core/index.js";
import type { ZodType } from "./schemas.js";

export type {
  /** @deprecated Use `z.output<T>` instead. */
  output as TypeOf,
  /** @deprecated Use `z.output<T>` instead. */
  output as Infer,
  /** @deprecated Use `z.core.$$ZodFirstPartyTypes` instead */
  $ZodTypes as ZodFirstPartySchemaTypes,
} from "../core/index.js";

/** @deprecated Use the raw string literal codes instead, e.g. "invalid_type". */
export const ZodIssueCode = {
  invalid_type: "invalid_type",
  // ...
} as const;

/** @deprecated Use `z.config(params)` instead. */
export function setErrorMap(map: core.$ZodErrorMap): void {
  core.config({ customError: map });
}
```

```typescript
// scripts/check-versions.ts:1-63 (三重バージョン整合性チェック)
import { version } from "../packages/zod/src/v4/core/versions.js";

const versionsVersion = `${version.major}.${version.minor}.${version.patch}`;

const isPackageJsonValid =
  tag === "latest" ? packageJsonVersion === versionsVersion : packageJsonVersion.startsWith(versionsVersion);
const isJsrJsonValid =
  tag === "latest" ? jsrJsonVersion === versionsVersion : jsrJsonVersion.startsWith(versionsVersion);
if (!isPackageJsonValid || !isJsrJsonValid) {
  console.error(`Version mismatch:`);
  process.exit(1);
}
```

```typescript
// packages/zod/src/v4/core/versions.ts:1-5 (バージョンの単一真実源)
export const version = {
  major: 4,
  minor: 3,
  patch: 6 as number,
} as const;
```

```typescript
// packages/zod/src/v3/tests/base.test.ts:4 (v3 テストのインポート)
import * as z from "zod/v3";
```

```yaml
# .husky/pre-commit:1-7 (バージョン整合性の自動チェック)
if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "ERROR: untracked files present";
  git status;
  exit 1
fi
pnpm check:semver
lint-staged --verbose
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 旧 API の利用者が新 API に移行するまでの互換性維持
  - 適用条件: メジャーバージョンで API が変更されるが、旧 API 利用者がエコシステムに多数いる場合
  - コード例: `packages/zod/src/v4/classic/compat.ts:1-70`
  - 注意点: 互換レイヤーは薄く保ち、`@deprecated` で非推奨を明示すること。互換レイヤーが肥大化すると新旧の境界が曖昧になる

- **Gateway パターン** (分類: 構造)
  - 解決する問題: 一つのパッケージから複数のバージョン/バリアントにアクセスする統一的なインターフェース
  - 適用条件: パッケージを分割せずに複数のAPIバリアントを提供する場合
  - コード例: `packages/zod/package.json:52-113` (exports マップ)
  - 注意点: tree-shaking が効くことを `@zod/treeshaking` パッケージで検証している

## Good Patterns

- **独立した v3 実装の維持**: v3 のコードは v4 に一切依存しない完全な独立実装として `src/v3/` に保持されている。これにより v3 のバグフィックスが v4 の変更に影響されず、v3 を使い続けるユーザーが安心して `zod/v3` を利用できる。

```typescript
// packages/zod/src/v3/index.ts:1-4
import * as z from "./external.js";
export * from "./external.js";
export { z };
export default z;
// v4 からの import は一切なし
```

- **npm alias による旧バージョンの比較テスト**: `devDependencies` で `"zod3": "npm:zod@~3.24.0"` と npm alias を定義し、ベンチマーク・型チェック・tree-shaking テストで v3 と v4 を横並びで比較できるようにしている。

```json
// package.json:50
"zod3": "npm:zod@~3.24.0",
```

```typescript
// packages/bench/object.ts:3-4
import * as z4 from "zod/v4";
import * as z3 from "zod3";
```

- **ATTW スナップショットテストによる型解決の検証**: `@arethetypeswrong/cli` の出力をスナップショットとして保存し、全エクスポートパス (`zod`, `zod/v3`, `zod/v4`, `zod/mini` 等) の CJS/ESM 型解決が正しいことを回帰テストしている。

```typescript
// packages/resolution/attw.test.ts:10-11
describe("Are The Types Wrong (attw) tests", () => {
  it("should run attw --pack node_modules/zod and check output", async () => {
    // スナップショットで全エクスポートの型解決を検証
```

## Anti-Patterns / 注意点

- **バージョン番号の散在を放置する**: バージョン番号が `package.json`, `jsr.json`, ソースコード内定数に分散している場合、手動で同期しようとすると不整合が発生する。Zod は `check-versions.ts` で自動チェックすることでこれを防いでいるが、もしこのチェックがなければリリース事故につながる。

```typescript
// Bad: バージョン番号を手動同期に頼る
// package.json の version を変更 → jsr.json を忘れる → 不整合リリース

// Better: 自動チェックスクリプトを git hook に組み込む
// .husky/pre-commit
pnpm check:semver

// scripts/check-versions.ts
if (!isPackageJsonValid || !isJsrJsonValid) {
  console.error(`Version mismatch:`);
  process.exit(1);
}
```

- **エコシステムテストなしのメジャーバージョンリリース**: ライブラリ単体のテストだけではエコシステムとの互換性を保証できない。Zod は drizzle-zod, AI SDK との実際の組み合わせテストをCI に含め、「Type instantiation is excessively deep」のような下流の型エラーも検出する。

```typescript
// Bad: 自分のライブラリのテストのみで出荷
// → drizzle-zod で "Type instantiation is excessively deep" が発生

// Better: 下流の主要ライブラリとの組み合わせテストを CI に追加
// packages/integration/fixtures/drizzle-zod/index.ts:1-4
// This file tests that drizzle-zod works with Zod v4 without
// "Type instantiation is excessively deep and possibly infinite" errors.
import { createInsertSchema } from "drizzle-zod";
export const schema = createInsertSchema(table);
```

## 導出ルール

- `[MUST]` メジャーバージョン移行時、旧 API をサブパスエクスポート (`pkg/v{N}`) で同一パッケージ内に維持し、段階的移行パスを提供する
  - 根拠: Zod は `zod/v3` サブパスで 5,000 行超の完全な v3 実装を維持し、ユーザーが `import` パスを変えるだけで移行前の API にアクセスできるようにしている

- `[MUST]` バージョン番号が複数箇所に存在する場合、整合性を検証する自動チェックスクリプトを git hook (pre-commit/pre-push) と CI の両方で実行する
  - 根拠: Zod は `package.json`, `jsr.json`, `versions.ts` の 3 箇所を `check-versions.ts` で検証し、pre-commit, pre-push, prepublishOnly の 3 フェーズでチェックしている

- `[SHOULD]` メジャーバージョンで非推奨にする API は `@deprecated` JSDoc アノテーション + 移行先の具体的指示を付けた上で新バージョンの互換レイヤーに残す
  - 根拠: Zod の `compat.ts` では全ての非推奨エクスポートに `/** @deprecated Use z.xxx instead. */` を付与し、IDE が移行先を表示できるようにしている

- `[SHOULD]` メジャーバージョンリリースでは、主要な下流ライブラリとの型互換性をインテグレーションテストとして CI に組み込む
  - 根拠: `packages/integration/` で drizzle-zod, AI SDK との型互換性を `skipLibCheck: false` で検証し、型の深すぎる再帰エラー等を早期発見している

- `[SHOULD]` npm alias (`"pkg-old": "npm:pkg@old-version"`) を活用し、新旧バージョンのベンチマーク比較・tree-shaking 比較をテストスイートに含める
  - 根拠: Zod は `"zod3": "npm:zod@~3.24.0"` で v3 を参照し、ベンチマーク (`packages/bench/`) と型チェック性能 (`packages/tsc/`) で v3 と v4 を横並び比較している

- `[SHOULD]` パッケージの全エクスポートパスについて、CJS/ESM/TypeScript の各モジュール解決が正しいことを自動テスト (attw 等) で検証する
  - 根拠: `packages/resolution/attw.test.ts` が全サブパスの型解決をスナップショットテストし、`test-resolution.ts` が CJS/ESM の実行時解決を検証している

- `[AVOID]` メジャーバージョンで互換レイヤーを設けずに旧 API を一括削除する
  - 根拠: Zod は v4 の `compat.ts` で旧 API 名 (`TypeOf`, `ZodSchema`, `ZodIssueCode` 等) を非推奨付きで維持し、`ZodFirstPartyTypeKind` のような空の enum スタブまで残して `zod-to-json-schema` 等の下流の互換性を確保している

## 適用チェックリスト

- [ ] メジャーバージョン移行計画において、旧 API のサブパスエクスポートを設計したか
- [ ] バージョン番号が存在する全箇所を列挙し、整合性チェックスクリプトを作成したか
- [ ] git hook (pre-commit/pre-push) と CI でバージョン整合性チェックが実行されるか
- [ ] 非推奨 API に `@deprecated` アノテーションと移行先の具体的な指示を付けたか
- [ ] 主要な下流ライブラリ・フレームワークとの互換性テストを CI に組み込んだか
- [ ] 新旧バージョンの性能比較ベンチマークを実行し、性能後退がないことを確認したか
- [ ] 全エクスポートパスの CJS/ESM/TypeScript 型解決が正しいことをテストしたか
- [ ] カナリアリリースの仕組みがあり、本番リリース前にユーザーが検証できるか
- [ ] `package.json` の exports で `@zod/source` のようなカスタム conditions を使い、開発時とビルド時の解決を適切に切り替えているか
