# project-structure

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod v4 は単一 npm パッケージ `zod` の内部を、共有カーネル（`core`）と複数のサーフェス（`classic`, `mini`）、バージョン互換レイヤー（`v3`）に分離した構造を持つ。物理的なモノレポは 8 パッケージだが、公開されるのは `zod` パッケージのみで、残りは検証用ワークスペース（resolution, integration, treeshake, tsc, bench）として機能する。`package.json` の `exports` フィールドで 10 のサブパスを定義し、カスタム条件 `@zod/source` で開発時にビルドをバイパスする設計は、大規模 TypeScript ライブラリのパッケージ配信戦略として注目に値する。

## 背景にある原則

- **共有カーネル分離**: バリデーションロジック・型定義・エラー体系といった不変の基盤を `v4/core` に集約し、ユーザー向け API のバリエーション（classic, mini）は core を継承する薄いレイヤーとして実装する。これにより、異なる API サーフェスが同一の型システムと実行エンジンを共有でき、動作の一貫性とコードの重複排除を両立する。根拠: `classic/schemas.ts` と `mini/schemas.ts` はどちらも `core.$constructor` を使い、`core.$ZodType.init` を呼ぶ構造になっている。

- **検証専用ワークスペースによる品質保証**: 公開パッケージは 1 つだが、`resolution`（モジュール解決テスト）、`integration`（サードパーティ連携テスト）、`treeshake`（バンドルサイズ計測）、`tsc`（型チェックパフォーマンス）を独立ワークスペースに分離する。テストの関心事ごとにパッケージを分けることで、消費者視点の品質検証を `workspace:*` を介して「外部パッケージとして使う」形で実行できる。根拠: `packages/resolution/attw.test.ts` が `@arethetypeswrong/cli` で全サブパスの型解決を検証し、CI の `test.yml` が `--filter @zod/resolution test:all` で独立実行する。

- **バンドラ親和性の徹底**: `sideEffects: false` 宣言と全コンストラクタへの `/*@__PURE__*/` アノテーション（511 箇所）を組み合わせ、ツリーシェイキングの効果を最大化する。唯一の副作用は `classic/external.ts` でのロケール初期化 `config(en())` であり、これは意図的にエントリポイントに配置される。根拠: `packages/treeshake/` パッケージが個別スキーマ単位でバンドルサイズを計測し、最小構成の確認を行っている。

- **カスタム条件によるビルドバイパス**: `@zod/source` カスタム条件を `tsconfig.json` の `customConditions` と `vitest.config.ts` の `resolve.conditions` に設定することで、開発中はソース TypeScript を直接参照し、ビルド工程を省略する。パブリッシュ時は通常の `import`/`require` 条件でビルド成果物を参照する。根拠: `package.json` の `exports` で各サブパスの最初の条件が `"@zod/source": "./src/..."` になっている。

## 実例と分析

### パッケージ内レイヤー分離（core / classic / mini）

Zod v4 は npm パッケージを分割せず、1 つの `zod` パッケージ内にレイヤー構造を実現している。

```
src/
  v4/
    core/     ... 共有カーネル（$ZodType, parse, errors, schemas, checks 等）
    classic/  ... フルAPI（ZodType, ZodString 等 + v3互換メソッド）
    mini/     ... 軽量API（ZodMiniType, ZodMiniString 等）
    locales/  ... 51言語のエラーメッセージ
  v3/         ... v3互換レイヤー
```

core レイヤーの型名・定数名には `$` プレフィックスが付与される（`$ZodType`, `$ZodString`, `$constructor`）。classic レイヤーはプレフィックスなし（`ZodType`, `ZodString`）、mini レイヤーは `ZodMini` プレフィックス（`ZodMiniType`, `ZodMiniString`）を使う。これにより、内部 API と公開 API の境界が名前レベルで明示される。

### サブパスエクスポートの設計

`package.json` の `exports` で 10 のサブパスを定義し、3 つのフォーマット（ESM, CJS, 型定義）と `@zod/source` 条件を組み合わせる。

| サブパス | 用途 |
|---------|------|
| `.` | デフォルト（v4 classic + 英語ロケール） |
| `./mini` | 軽量バリアント（ロケール自動設定なし） |
| `./v3` | v3 互換レイヤー |
| `./v4` | v4 classic の明示的インポート |
| `./v4-mini` | v4 mini の明示的インポート |
| `./v4/core` | 内部カーネル（上級者・ライブラリ作者向け） |
| `./v4/locales` | 全ロケールバンドル |
| `./v4/locales/*` | 個別ロケール（ワイルドカード） |

### ビルドツールチェーン: zshy による統一

`zshy` はソースの `exports` 定義（`zshy.exports`）から ESM/CJS/型定義のビルド成果物を自動生成するカスタムビルドツールである。ビルド後には `write-stub-package-jsons.ts` スクリプトがサブディレクトリごとに stub `package.json` を配置し、node10 形式のモジュール解決（`main`/`types` フィールド参照）も動作させる。

### 検証ワークスペースの役割分担

| パッケージ | 検証対象 |
|-----------|---------|
| `@zod/resolution` | CJS/ESM/MJS のモジュール解決 + attw による全サブパス型チェック |
| `@zod/integration` | drizzle-zod, AI SDK 等サードパーティとの型互換 + `skipLibCheck: false` での型健全性 |
| `@zod/treeshaking` | rollup によるスキーマ単位のバンドルサイズ計測 |
| `@zod/tsc-perftest` | TypeScript コンパイラのパフォーマンス計測・回帰テスト |
| `@zod/benchmarks` | ランタイムパフォーマンスベンチマーク |

### バージョン整合性の自動チェック

3 箇所に分散するバージョン情報（`package.json`, `jsr.json`, `src/v4/core/versions.ts`）を `check-versions.ts` スクリプトで一元検証する。さらに `check-semver.ts` が pre-commit フックで semver 形式を検証し、不正なバージョン文字列をコミット段階で防止する。

## コード例

```typescript
// packages/zod/src/v4/classic/external.ts:9-11
// classic エントリポイントでの唯一の副作用: 英語ロケール自動設定
import { config } from "../core/index.js";
import en from "../locales/en.js";
config(en());
```

```typescript
// packages/zod/package.json:53-58
// カスタム条件 @zod/source を最優先に配置するエクスポート定義
".": {
  "@zod/source": "./src/index.ts",
  "types": "./index.d.cts",
  "import": "./index.js",
  "require": "./index.cjs"
}
```

```typescript
// packages/zod/src/v4/core/core.ts:17
// $constructor: ツリーシェイキング可能なコンストラクタファクトリ
export /*@__NO_SIDE_EFFECTS__*/ function $constructor<T extends ZodTrait, D = T["_zod"]["def"]>(
  name: string,
  initializer: (inst: T, def: D) => void,
  params?: { Parent?: typeof Class }
): $constructor<T, D> {
```

```typescript
// packages/zod/src/v4/classic/schemas.ts:156-157
// classic レイヤーが core.$constructor を使い、core.$ZodType.init を呼ぶ
export const ZodType: core.$constructor<ZodType> = /*@__PURE__*/ core.$constructor("ZodType", (inst, def) => {
  core.$ZodType.init(inst, def);
```

```typescript
// scripts/write-stub-package-jsons.ts:6-13
// サブディレクトリ用の stub package.json（node10 互換）
const STUB_PACKAGE_JSON_CONTENT = `{
  "type": "module",
  "main": "./index.cjs",
  "module": "./index.js",
  "types": "./index.d.cts",
  "sideEffects": false
}
`;
```

```typescript
// pnpm-workspace.yaml:1-5
// ワークスペース設定: ホイスティング無効 + ワークスペースリンク有効
packages:
  - packages/*
hoistWorkspacePackages: false
saveWorkspaceProtocol: false
linkWorkspacePackages: true
```

## パターンカタログ

- **Kernel-Shell パターン** (分類: 構造)
  - 解決する問題: 同一ロジックの複数 API サーフェスが必要な場合のコード重複
  - 適用条件: フル機能版と軽量版など、同じ基盤に対して複数のインターフェースを提供するライブラリ
  - コード例: `src/v4/core/` (kernel) + `src/v4/classic/` + `src/v4/mini/` (shells)
  - 注意点: カーネルの API が安定していないと、全シェルに破壊的変更が波及する

- **Consumer-as-Package テストパターン** (分類: 振る舞い)
  - 解決する問題: ライブラリ作者が見落としがちな、消費者視点でのモジュール解決・型互換の問題
  - 適用条件: npm パッケージとして配布するライブラリ
  - コード例: `packages/resolution/attw.test.ts`, `packages/integration/fixtures/`
  - 注意点: `workspace:*` によるリンクでは実際の npm install と振る舞いが異なる場合がある。attw のような外部ツールでの補完が重要

## Good Patterns

- **カスタム条件による開発/本番切り替え**: `@zod/source` 条件を `exports` の最優先に配置し、開発時は `tsx --conditions @zod/source` や vitest の `resolve.conditions` でソースを直接参照する。ビルド不要の開発体験と、正確なビルド成果物の配布を両立している。

```typescript
// vitest.config.ts:8-11
resolve: {
  conditions: ["@zod/source", "default"],
  externalConditions: ["@zod/source", "default"],
},
```

- **`$` プレフィックスによる内部 API の可視化**: core レイヤーの全エクスポートに `$` プレフィックスを付与し（`$ZodType`, `$constructor`, `$ZodErrorMap`）、公開レイヤーではプレフィックスなし（`ZodType`, `ZodString`）で再エクスポートする。import 文やエディタの補完で内部 API と公開 API を即座に区別できる。

```typescript
// core: $ZodType (内部), classic: ZodType (公開), mini: ZodMiniType (公開)
export const $ZodType: core.$constructor<$ZodType> = ...  // core/schemas.ts:185
export const ZodType: core.$constructor<ZodType> = ...    // classic/schemas.ts:156
export const ZodMiniType: core.$constructor<ZodMiniType> = ... // mini/schemas.ts:43
```

- **検証パッケージの専門化**: モジュール解決、型互換、ツリーシェイキング、コンパイル性能をそれぞれ独立パッケージとし、`workspace:*` で本体を参照する。CI でフィルタ実行（`--filter @zod/resolution`）できるため、関心事ごとの独立実行と並列化が可能。

```yaml
# .github/workflows/test.yml:31-32
- run: pnpm run --filter @zod/resolution test:all
- run: pnpm run --filter @zod/integration test:all
```

## Anti-Patterns / 注意点

- **ロケール副作用の暗黙的適用**: `zod`（デフォルトインポート）は `classic/external.ts` で `config(en())` を実行し英語ロケールを自動設定するが、`zod/mini` はこれを行わない。同じパッケージ内のサブパスで副作用の有無が異なることは、消費者にとって予測しにくい。

```typescript
// Bad: サブパスによって暗黙の副作用が異なる
import { z } from "zod";       // 英語ロケールが自動設定される
import { z } from "zod/mini";  // ロケールが未設定（エラーメッセージがフォールバック）

// Better: 明示的にロケールを設定する（mini ではこちらが必須）
import { z } from "zod/mini";
import en from "zod/v4/locales/en";
z.config(en());
```

- **サブパス粒度の複雑化**: `./v4`, `./v4-mini`, `./v4/mini` のように、意味的に近いがパスが異なるサブパスが存在する。`./mini` と `./v4/mini` は同じモジュール（`v4/mini/external.ts`）を参照するが、`./v4-mini` も同様。このような冗長なエイリアスは移行期に必要だが、長期的には混乱の原因になりうる。

```typescript
// これらは全て同じモジュールを指す
import { z } from "zod/mini";
import { z } from "zod/v4-mini";
import { z } from "zod/v4/mini";
```

## 導出ルール

- `[MUST]` npm パッケージのサブパスエクスポートを定義する場合、ESM (`import`), CJS (`require`), 型定義 (`types`) の 3 条件を全サブパスで一貫して提供する
  - 根拠: Zod は全 10 サブパスで 3 フォーマットを揃え、`resolution` パッケージの attw テストで `node10`, `node16 (CJS)`, `node16 (ESM)`, `bundler` の全解決戦略を検証している（`packages/resolution/attw.test.ts`）

- `[MUST]` ツリーシェイキングを前提とするライブラリでは、`sideEffects: false` 宣言と `/*@__PURE__*/` or `/*@__NO_SIDE_EFFECTS__*/` アノテーションを併用する
  - 根拠: Zod は `package.json` に `sideEffects: false` を設定し、全 511 箇所のコンストラクタ呼び出しに pure アノテーションを付与。`packages/treeshake/` で個別スキーマのバンドルサイズを計測して効果を検証している

- `[SHOULD]` ライブラリの検証テストは、消費者パッケージとして独立ワークスペースに分離し、`workspace:*` で本体を参照する形で実行する
  - 根拠: `@zod/resolution`（モジュール解決）、`@zod/integration`（型互換）が独立パッケージとして CI で `--filter` 実行され、作者視点では見落としがちな消費者視点の問題を検出している

- `[SHOULD]` 複数のモジュール解決戦略（`bundler`, `nodenext`, `node16` CJS）をテストマトリクスに含め、`skipLibCheck: false` で型の健全性を検証する
  - 根拠: `packages/integration/fixtures/internal-types/` に `tsconfig.bundler.json`, `tsconfig.nodenext.json`, `tsconfig.node16-cjs.json` の 3 設定が存在し、CI で全パターンを実行する

- `[SHOULD]` 開発時のビルドバイパスにはカスタム条件（`customConditions`）を活用し、`exports` の条件マップで開発用ソース参照と本番用ビルド成果物参照を切り替える
  - 根拠: `@zod/source` 条件が `tsconfig.json` の `customConditions`、`vitest.config.ts` の `resolve.conditions`、`tsx --conditions` の全てで一貫して使用され、ビルドなしの開発体験を実現している

- `[SHOULD]` 複数箇所に分散するバージョン情報は、CI またはフックで整合性を自動検証する
  - 根拠: `scripts/check-versions.ts` が `package.json`, `jsr.json`, `src/v4/core/versions.ts` の 3 箇所のバージョンを比較し、`prepublishOnly` で実行される

- `[AVOID]` 公開パッケージの同一機能に対して、意味的に重複するサブパスエイリアスを作成すること（移行期の一時的なエイリアスは除く）
  - 根拠: `zod/mini`, `zod/v4-mini`, `zod/v4/mini` が同一モジュールを指し、ドキュメント上の混乱を招きうる構造になっている

## 適用チェックリスト

- [ ] `package.json` の `exports` フィールドで、全サブパスに `import`, `require`, `types` の 3 条件を定義しているか
- [ ] `sideEffects: false` を宣言し、エントリポイント以外のモジュールレベル副作用を排除しているか
- [ ] コンストラクタ・ファクトリ関数に `/*@__PURE__*/` または `/*@__NO_SIDE_EFFECTS__*/` アノテーションを付与しているか
- [ ] 消費者視点の検証テスト（モジュール解決、型互換、バンドルサイズ）を独立ワークスペースとして実装しているか
- [ ] `bundler`, `nodenext`, `node16` の複数モジュール解決戦略でテストしているか
- [ ] attw (`@arethetypeswrong/cli`) で全サブパスの型解決を検証しているか
- [ ] 開発時のビルドバイパス手段（カスタム条件等）を用意し、DX を損なわずに正確なビルド成果物を維持しているか
- [ ] バージョン情報の分散（package.json, ランタイム定数, レジストリ設定等）を自動検証しているか
