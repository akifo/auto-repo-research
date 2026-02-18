# コード生成

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect-TS/effect は大規模モノレポ（35+ パッケージ）において、barrel file（index.ts）の自動生成、JSDoc 補完のための AST 変換（codemod）、バージョン情報の埋め込み、外部アセットのインライン化、API ドキュメント生成という多層的なコード生成パイプラインを構築している。特筆すべきは、codegen を ESLint ルールとして実行することで「生成コードが最新でなければ lint エラー」という保証を実現している点と、package.json 内の宣言的設定から barrel file を導出する設計である。

## 背景にある原則

- **生成コードの真実の源泉（Single Source of Truth）を分離する**: barrel file の内容は `src/` 内の公開モジュール群と package.json の `exports` フィールドから自動導出される。人間が barrel file を手動管理すると、モジュール追加時の更新漏れや不整合が発生する。ファイルシステムの構造自体が「何をエクスポートするか」の宣言になる設計（`AGENTS.md:36-37`、`build-utils/src/PrepareV3.ts`）。

- **コード生成を既存ツールチェーンに統合する**: barrel file 生成は `build-utils prepare-v3` コマンドとして実装され、各パッケージの `codegen` script として統一的に呼び出される。JSDoc の補完は jscodeshift ベースの codemod として ESLint やビルドパイプラインに組み込まれる。新しいツールを導入するのではなく、既存の開発フロー（lint、build、publish）の中にコード生成を埋め込むことで、実行忘れを構造的に防いでいる（`eslint.config.mjs:65`, `package.json:20`）。

- **公開 API と内部実装の境界をツールレベルで強制する**: `./internal/*` を `package.json` の `exports` で `null` に設定し、さらに `@effect/no-import-from-barrel-package` ESLint ルールでパッケージ内部からの barrel import を禁止する。コード生成時にも `**/internal/**` は自動的に除外される。この多層防御により、公開 API の安定性と内部実装の変更自由度を両立させている。

- **AST ベースの変換で構造的正確性を保証する**: JSDoc コメントの伝播や `@example` のフェンス追加を正規表現ではなく jscodeshift による AST 操作で行う。これにより、複雑なコード構造（`dual()` 関数の型パラメータへのコメント伝播など）でも正確に変換できる（`scripts/codemods/jsdoc.ts`）。

## 実例と分析

### Barrel file 自動生成パイプライン

`build-utils prepare-v3` は以下のフローで `src/index.ts` を生成する:

1. `package.json` の `exports` フィールドからエントリポイント一覧を取得
2. `effect.generateIndex` 設定（include/exclude glob パターン）でフィルタリング
3. 各モジュールの先頭 JSDoc コメント（`/** ... */`）を抽出
4. `export * as ModuleName from "./Module.js"` 形式のエクスポート文を生成
5. `src/.index.ts`（手動管理のプレフィックス）があればその内容を先頭に配置

この設計の重要な点は、`.index.ts` というドットファイルで「自動生成だが一部手動制御が必要な部分」を分離していることである。`packages/effect/src/.index.ts` では `pipe`, `flow`, `identity` など頻出ユーティリティを名前付きエクスポートとして個別に公開しており、これは `export * as Function from "./Function.js"` ではなく直接インポートできるようにする UX 上の配慮である。

### JSDoc コメントの AST ベース補完

`scripts/codemods/jsdoc.ts` は `dual()` 関数パターンに対する JSDoc 伝播を行う。Effect では関数のデータ最後・データ先頭の両スタイルをサポートするために `dual()` でオーバーロードを定義するが、TypeScript の JSDoc はオーバーロードの型パラメータに自動伝播しない。この codemod は:

1. `export const x: { ... } = dual(...)` パターンを検出
2. エクスポート宣言のコメントを `TSCallSignatureDeclaration`（型リテラル内の呼び出しシグネチャ）に複製
3. `dual()` の型パラメータにもコメントを伝播

`scripts/codemods/ts-fence.ts` は `@example` タグのコード例にマークダウンの `` ```ts `` フェンスを自動付与する。これはドキュメント生成ツール（`@effect/docgen`）がフェンス付きの `@example` を期待するためである。

### バージョン情報のテンプレートベース埋め込み

`scripts/version.mjs` は `scripts/version.template.txt` をテンプレートとして使い、`package.json` からバージョン文字列を読み取って `packages/effect/src/internal/version.ts` に埋め込む。テンプレートには `VERSION` というプレースホルダーがあり、単純な文字列置換で生成される。これは `changeset-version` スクリプト（`changeset version && node scripts/version.mjs`）の一部として実行され、バージョンバンプと同時に自動的にソースコードに反映される。

### 外部アセットのインライン化

`scripts/package-swagger.mjs` と `scripts/package-scalar.mjs` は、Swagger UI や Scalar の JavaScript/CSS を CDN からダウンロードし、TypeScript の文字列リテラルとして `packages/platform/src/internal/` 配下に書き出す。生成されるファイルは `/** @internal */` アノテーション付きで、公開 API には露出しない。

### ドキュメント生成パイプライン

`@effect/docgen` は TypeScript ソースファイルから JSDoc を解析し、マークダウンドキュメントを生成する。`@since` タグをバージョン追跡に、`@category` をドキュメントの構造化に、`@example` を実行可能なコード例として使用する。`enforceVersion: true`（デフォルト）により、すべてのエクスポートに `@since` タグが必須となり、API の変更履歴が強制的に記録される。

### Publish パイプラインにおけるコード生成の統合

`changeset-publish` は `pnpm codemod && pnpm build && TEST_DIST= pnpm vitest && changeset publish` という順序で実行される。publish 前に codemod が実行されることで、JSDoc の構造が最新の状態でビルド・テスト・リリースされることが保証される。

## コード例

```typescript
// build-utils/src/PrepareV3.ts:16-58（barrel file 生成の核心部分）
const template = yield * fs.readFileString("src/.index.ts").pipe(
  Effect.map((_) => _.trim() + "\n\n"),
  Effect.orElseSucceed(() => ""),
);

const modules = Object.entries(ctx.entrypoints)
  .filter(([entry, module]) => module.ts && entry !== ".")
  .map(([, module]) => module.original.replace(/^\.\/src\//, ""))
  .filter((current, index, array) => array.indexOf(current) === index);

const matches = micromatch(modules, [
  "*.ts",
  ...ctx.packageJson.effect.generateIndex.include,
], {
  ignore: [
    ...ctx.packageJson.effect.generateIndex.exclude,
    "**/internal/**",
    "**/index.ts",
  ],
});

const content = yield * Effect.forEach(
  matches,
  (file) =>
    Effect.gen(function*() {
      const content = yield* fs.readFileString(`./src/${file}`);
      const topComment = content.match(/\/\*\*\n.+?\*\//s)?.[0] ?? "";
      const moduleName = file
        .slice(file.lastIndexOf("/") + 1)
        .slice(0, -path.extname(file).length);
      const srcFile = file.replace(/\.ts$/, ".js");
      return `${topComment}\nexport * as ${moduleName} from "./${srcFile}"`;
    }),
  { concurrency: "inherit" },
);
```

```typescript
// scripts/codemods/jsdoc.ts:19-43（dual() パターンへの JSDoc 伝播）
root.find(j.ExportNamedDeclaration, {
  declaration: {
    type: "VariableDeclaration",
    declarations: [{
      type: "VariableDeclarator",
      id: {
        type: "Identifier",
        typeAnnotation: {
          type: "TSTypeAnnotation",
          typeAnnotation: {
            type: "TSTypeLiteral",
            members: [{ type: "TSCallSignatureDeclaration" }],
          },
        },
      },
    }],
  },
}).forEach((path) => {
  const comments = path.node.comments ?? [];
  j(path).find(j.TSCallSignatureDeclaration).forEach((path) => {
    if (hasComments(path.node)) return;
    path.node.comments = comments;
  });
});
```

```typescript
// scripts/version.mjs:1-9（バージョン埋め込み）
import * as Fs from "node:fs";
import Package from "../packages/effect/package.json" with { type: "json" };

const tpl = Fs.readFileSync("./scripts/version.template.txt").toString("utf8");

Fs.writeFileSync(
  "packages/effect/src/internal/version.ts",
  tpl.replace("VERSION", Package.version),
);
```

```typescript
// packages/effect/src/.index.ts:1-31（手動管理の barrel プレフィックス）
/**
 * @since 2.0.0
 */

export {
  /**
   * @since 2.0.0
   */
  absurd,
  /**
   * @since 2.0.0
   */
  flow,
  /**
   * @since 2.0.0
   */
  hole,
  /**
   * @since 2.0.0
   */
  identity,
  /**
   * @since 2.0.0
   */
  pipe,
  /**
   * @since 2.0.0
   */
  unsafeCoerce,
} from "./Function.js";
```

```typescript
// scripts/package-swagger.mjs:14-23（外部アセットのインライン化）
const source = `/* eslint-disable */

/** @internal */
export const javascript = ${JSON.stringify(`${jsBundle}\n${jsPreset}`)}

/** @internal */
export const css = ${JSON.stringify(css)}
`;

await Fs.writeFile("packages/platform/src/internal/httpApiSwagger.ts", source);
```

## パターンカタログ

- **Template Method パターン** (分類: 生成)
  - 解決する問題: 複数パッケージで同じ barrel file 生成ロジックを共有しつつ、パッケージ固有のカスタマイズを許容する
  - 適用条件: モノレポ内で構造が類似した複数パッケージを管理する場合
  - コード例: `build-utils/src/PrepareV3.ts` — `.index.ts` によるプレフィックス挿入、`effect.generateIndex` による include/exclude 設定
  - 注意点: カスタマイズポイントが増えすぎると設定の複雑さがツール自体のメンテナンスコストを上回る

- **Builder パターン** (分類: 生成)
  - 解決する問題: 公開用 package.json を段階的に構築する
  - 適用条件: ビルド成果物の構成が動的に決まる（ESM/CJS/DTS の有無など）
  - コード例: `build-utils/src/PackV3.ts:18-106` — `buildPackageJson` が条件分岐しながら package.json を組み立てる
  - 注意点: 暗黙のデフォルト値が多いと、生成結果の予測が困難になる

## Good Patterns

- **宣言的設定からのコード導出**: `package.json` の `exports` フィールドと `effect.generateIndex` 設定から barrel file を自動生成する。設定は JSON として宣言的に記述され、コード生成ロジックは共有ツール（`@effect/build-utils`）に閉じ込められている。これにより、新しいパッケージ追加時に必要な作業は `package.json` の `exports` にエントリを追加するだけで済む。

```json
// packages/cli/package.json:69-75
"effect": {
  "generateIndex": {
    "include": ["**/*"]
  }
}
```

- **手動・自動の境界をドットファイルで分離**: `.index.ts` に手動管理が必要な特殊エクスポートを記述し、自動生成部分と物理的に分離する。ドットファイルは通常のファイル一覧に表示されず、「これは生成インフラの一部」であることが命名から明確である。生成ツールは `.index.ts` の存在を `Effect.orElseSucceed(() => "")` でオプショナルに扱い、存在しないパッケージでもエラーにならない。

- **コード生成と lint の統合による一貫性保証**: `eslint-plugin-codegen` を使い、生成コードが最新でなければ lint エラーとする。これにより CI/CD パイプラインの中で生成コードの鮮度が自動的に検証される。

```javascript
// eslint.config.mjs:65
"codegen/codegen": "error",
```

- **codemod のテスタビリティ**: `ts-fence.test.ts` で jscodeshift の `defineInlineTest` を使い、入力コードと期待出力をインラインで記述したテストを実装。AST 変換のエッジケースを明確に文書化している。

```typescript
// scripts/codemods/ts-fence.test.ts:24-30
expectTransformation(
  "should ignore line comments",
  `// description
const v = 1`,
  `// description
const v = 1`,
);
```

## Anti-Patterns / 注意点

- **生成ファイルの手動編集**: AGENTS.md に明記されている通り、`index.ts` の手動編集は禁止されている。しかし生成ファイルであることがファイル自体からは判別できない（生成コメントヘッダーがない）。

```typescript
// Bad: index.ts を直接編集する
export * as MyNewModule from "./MyNewModule.js"; // 手動追加 → pnpm codegen で上書きされる
```

```typescript
// Better: package.json の exports にエントリを追加し、pnpm codegen を実行する
// package.json
"exports": {
  "./*": "./src/*.ts"
}
// → pnpm codegen で index.ts が自動再生成される
```

- **バージョン埋め込みの単一ファイル依存**: `version.mjs` は `packages/effect/package.json` のみからバージョンを読み取り、`packages/effect/src/internal/version.ts` のみに書き出す。他パッケージのバージョンは対象外であり、パッケージ間のバージョン整合性は changeset に委ねられている。この暗黙の依存関係は、スクリプト名だけでは把握しにくい。

```javascript
// Bad: パッケージ横断のバージョン埋め込みが必要な場合、version.mjs をコピー&修正する
```

```javascript
// Better: バージョン埋め込みの対象をパラメータ化し、全パッケージで共通のロジックを使う
```

## 導出ルール

- `[MUST]` 自動生成ファイルは生成元（設定ファイル・ソースデータ）を編集して再生成する。生成ファイルの直接編集を禁止する仕組み（AGENTS.md での明記、CI での検出）を設ける
  - 根拠: Effect-TS では `index.ts` の手動編集禁止を AGENTS.md で明示し、`pnpm codegen` で再生成するフローを強制している（`AGENTS.md:36-37`）

- `[MUST]` コード生成を既存の開発ワークフロー（lint / build / CI）に統合し、生成コードの鮮度を自動検証する
  - 根拠: `eslint-plugin-codegen` を ESLint ルールとして `"codegen/codegen": "error"` で設定し、生成コードが古ければ lint エラーにしている（`eslint.config.mjs:65`）

- `[SHOULD]` barrel file を自動生成する場合、エントリポイントの定義を `package.json` の `exports` やファイルシステム構造から導出し、手動のモジュールリスト管理を排除する
  - 根拠: `build-utils prepare-v3` は `package.json` の `exports` と `effect.generateIndex` 設定から barrel file を生成し、モジュール追加時の index.ts 更新漏れを構造的に防いでいる

- `[SHOULD]` AST ベースの codemod には入出力ペアのインラインテストを記述し、変換の正確性を保証する
  - 根拠: `ts-fence.test.ts` で jscodeshift の `defineInlineTest` を使い、変換前後のコードをインラインで記述したテストを実装している（`scripts/codemods/ts-fence.test.ts`）

- `[SHOULD]` 生成コード中の手動管理部分がある場合、物理的にファイルを分離する（例: `.index.ts` + 自動生成 `index.ts`）
  - 根拠: `.index.ts` と生成される `index.ts` を分離し、手動エクスポート（`pipe`, `flow` 等）と自動エクスポートが混在しない設計にしている

- `[AVOID]` 公開 API の barrel file で `internal` モジュールをエクスポートする。exports の `null` 設定と lint ルールの両方で防御する
  - 根拠: 全パッケージで `"./internal/*": null` を設定し（`package.json:38`）、さらに `@effect/no-import-from-barrel-package` ルールでパッケージ内からの barrel import を禁止している

- `[AVOID]` コード変換に正規表現を使う。AST パーサー（jscodeshift, ts-morph 等）を使い、構文構造を意識した変換を行う
  - 根拠: JSDoc コメントの伝播やフェンス追加は jscodeshift で AST ノードを操作しており、ネストしたコメントや複雑な型定義でも正確に動作する（`scripts/codemods/jsdoc.ts`）

## 適用チェックリスト

- [ ] モノレポの barrel file（index.ts）は手動管理か自動生成か確認し、手動管理なら自動生成への移行を検討する
- [ ] 生成ファイルが CI/lint で鮮度チェックされているか確認する（eslint-plugin-codegen や差分チェック等）
- [ ] `package.json` の `exports` フィールドが公開 API の真実の源泉になっているか確認する
- [ ] `internal` ディレクトリのモジュールが `exports` で `null` に設定され、外部からのインポートが禁止されているか確認する
- [ ] JSDoc やコメントの一括変換が必要な場合、正規表現ではなく AST ベースのツール（jscodeshift 等）を使用しているか確認する
- [ ] バージョン情報やビルドメタデータのソースコード埋め込みがある場合、ビルド/リリースパイプラインに組み込まれているか確認する
- [ ] 生成ファイルの一部に手動管理が必要な場合、物理的にファイルを分離しているか確認する
