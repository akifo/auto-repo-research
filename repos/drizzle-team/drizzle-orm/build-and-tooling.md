# ビルド・ツーリング

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

drizzle-orm は tsup/Turborepo/dprint を軸にしたビルド・フォーマットパイプラインを構築している。特筆すべきは、444 ファイルからなる drizzle-orm パッケージの CJS/ESM デュアルパブリッシュを、カスタムビルドスクリプト（`scripts/build.ts`）と AST ベースのインポートパス書き換え（`scripts/fix-imports.ts`）で実現している点である。tsup の出力を信頼せず、`tsc` による型生成と `recast` による後処理を組み合わせることで、`@arethetypeswrong/cli`（attw）検証を CI で通過する高品質なパッケージ成果物を生産している。

## 背景にある原則

- **ビルド出力のアトミック性**: `dist.new` に全成果物を書き出し、最後に `dist.new` -> `dist` へリネームすることで、ビルド途中の壊れた `dist` を参照するリスクを排除している（`drizzle-orm/scripts/build.ts:49,75-76`）。さらに `workspace:./drizzle-orm/dist` プロトコルで他パッケージが `dist` を直接参照するため、この原子性は依存パッケージの整合性にも直結する。

- **ソースコードが exports map の唯一の真実**: 444 ファイルの exports map を手動で管理するのは非現実的。`src/**/*.ts` を glob してエントリポイントを自動生成し、`package.json` の `exports` フィールドにビルド時に書き込む。これにより、ソースファイルの追加だけで新しいサブパス（`drizzle-orm/pg-core` 等）が自動的にエクスポートされる（`drizzle-orm/scripts/build.ts:8-44`）。

- **タスクグラフによるビルド順序の宣言的管理**: `turbo.json` でパッケージ間の依存を `dependsOn` として宣言し、ビルド順序を Turborepo に委ねる。`drizzle-orm#build` がハブとなり、他の全パッケージがこれに依存する星形のグラフを形成している（`turbo.json:32-33, 51-52, 73-74` 等）。

- **フォーマッタとリンタの責務分離**: dprint をフォーマッタ、ESLint をリンタとして明確に分離している。dprint は WASM プラグインで高速にコードスタイルを強制し、ESLint は `no-instanceof`、`require-entity-kind`、`import/extensions` などの意味的ルールに集中する（`.eslintrc.yaml`、`dprint.json`）。

## 実例と分析

### カスタムビルドスクリプトによるデュアルパブリッシュ

drizzle-orm の `scripts/build.ts` は以下の 5 段階で動作する:

1. **`dist.new` を削除**して前回のビルド残骸をクリーンアップ
2. **tsup と tsc を並列実行**: tsup が CJS/ESM の JS ファイルを生成し、tsc が `.d.ts` 型定義ファイルを生成する。型定義は `.d.ts` と `.d.cts` の 2 形式にコピーされる
3. **`version.ts` を個別ビルド**: `package.json` から JSON import するこのファイルだけ `--no-config` で個別にビルドする
4. **AST ベースのインポートパス修正**: `fix-imports.ts` が recast で全ファイルの AST を走査し、CJS ファイルは `.cjs` 拡張子、ESM ファイルは `.js` 拡張子にインポートパスを書き換える。同時にパスエイリアス `~/` を相対パスに解決する
5. **アトミックスワップ**: `package.json`（exports map 自動生成済み）と `README.md` をコピーし、`dist` を削除して `dist.new` を `dist` にリネーム

### Turborepo のタスクグラフ設計

`turbo.json` のタスク依存は星形トポロジーを形成している:

```
drizzle-orm#build (ハブ)
  ├── drizzle-kit#build
  ├── drizzle-zod#build
  ├── drizzle-typebox#build
  ├── drizzle-valibot#build
  ├── drizzle-arktype#build
  ├── drizzle-seed#build
  ├── eslint-plugin-drizzle#build
  └── integration-tests#build (+ drizzle-seed#build にも依存)
```

`//#lint`（ルートタスク）は `^test:types` と `drizzle-orm#build` に依存しており、型チェックとビルドが完了してからリントが走る。`test` と `pack` は `build` と `test:types` の両方に依存し、リリースフローの後段に位置する。

各タスクの `inputs` は精密に指定されており、`src/**/*.ts`、`tsconfig.json`、`tsup.config.ts`、`scripts/build.ts` など関連ファイルのみがキャッシュキーに含まれる。`dist/**` と `dist-dts/**` が `outputs` として宣言されているため、変更がなければキャッシュヒットでスキップされる。

### dprint によるフォーマット戦略

dprint は TypeScript、JSON、Markdown の 3 つの WASM プラグインを使用する。設定はミニマルで、タブ使用とシングルクォートが主な指定である。`excludes` で `dist`、`dist-dts`、`dist.new` などのビルド成果物を除外し、フォーマッタがビルド出力に触れることを防いでいる。

ルートの `package.json` で `lint: dprint check --list-different`、`lint:fix: dprint fmt` と定義され、Turborepo の `//#lint` タスクとして実行される。

### カスタム ESLint プラグインによるドメインルール

`eslint-plugin-drizzle-internal` は `require-entity-kind` ルールを 1 つだけ提供する。全クラスに `static readonly [entityKind]: string` プロパティを強制し、自動修正機能付きで違反時にプロパティを挿入する。これは `instanceof` の代わりに `is()` 関数でエンティティ判定するアーキテクチャを支える。`no-instanceof/no-instanceof` ルールが `instanceof` の使用を禁止し、例外箇所は `eslint-disable` コメントで明示的に許可する。

### `@arethetypeswrong/cli` による型正当性検証

CI の `attw` ジョブが全 8 パッケージに対して `bunx attw package.tgz` を実行し、CJS/ESM の型定義が正しく解決されることを検証する。`release` ジョブは `test` と `attw` の両方に依存しており、型の不整合があるパッケージはリリースされない。drizzle-kit はビルドスクリプト内でも `attw --pack dist` を直接実行している。

## コード例

```typescript
// drizzle-orm/scripts/build.ts:8-44
// exports map 自動生成 — src 配下の全 .ts ファイルから導出
const entries = await glob("src/**/*.ts");

pkg.exports = entries.reduce<
  Record<string, {
    import: { types?: string; default: string; };
    require: { types: string; default: string; };
    default: string;
    types: string;
  }>
>(
  (acc, rawEntry) => {
    const entry = rawEntry.match(/src\/(.*)\.ts/)![1]!;
    const exportsEntry = entry === "index" ? "." : "./" + entry.replace(/\/index$/, "");
    const importEntry = `./${entry}.js`;
    const requireEntry = `./${entry}.cjs`;
    acc[exportsEntry] = {
      import: {
        types: `./${entry}.d.ts`,
        default: importEntry,
      },
      require: {
        types: `./${entry}.d.cts`,
        default: requireEntry,
      },
      types: `./${entry}.d.ts`,
      default: importEntry,
    };
    return acc;
  },
  {},
);
```

```typescript
// drizzle-orm/scripts/fix-imports.ts:27-66
// CJS ファイルのインポートパスを AST レベルで .cjs に書き換え
const cjsFiles = await glob("dist.new/**/*.{cjs,d.cts}");

await Promise.all(cjsFiles.map(async (file) => {
  const code = parse(await fs.readFile(file, "utf8"), { parser });

  visit(code, {
    visitImportDeclaration(path) {
      path.value.source.value = fixImportPath(path.value.source.value, file, ".cjs");
      this.traverse(path);
    },
    visitExportAllDeclaration(path) {
      path.value.source.value = fixImportPath(path.value.source.value, file, ".cjs");
      this.traverse(path);
    },
    visitCallExpression(path) {
      if (path.value.callee.type === "Identifier" && path.value.callee.name === "require") {
        path.value.arguments[0].value = fixImportPath(path.value.arguments[0].value, file, ".cjs");
      }
      this.traverse(path);
    },
    // ...
  });

  await fs.writeFile(file, print(code).code);
}));
```

```typescript
// drizzle-orm/tsup.config.ts:1-19
// tsup 設定 — バンドルなし・分割なしでファイル単位トランスパイル
import { globSync } from "glob";
import { defineConfig } from "tsup";

const entries = globSync("src/**/*.ts");

export default defineConfig({
  entry: entries,
  outDir: "dist.new",
  format: ["cjs", "esm"],
  bundle: false,
  splitting: false,
  sourcemap: true,
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".js",
    };
  },
  tsconfig: "tsconfig.build.json",
});
```

```typescript
// drizzle-orm/scripts/build.ts:49-76
// 並列ビルド + アトミックスワップ
await fs.remove("dist.new");

await Promise.all([
  (async () => {
    await $`tsup`.stdio("pipe", "pipe", "pipe");
  })(),
  (async () => {
    await $`tsc -p tsconfig.dts.json`.stdio("pipe", "pipe", "pipe");
    await cpy("dist-dts/**/*.d.ts", "dist.new", {
      rename: (basename) => basename.replace(/\.d\.ts$/, ".d.cts"),
    });
    await cpy("dist-dts/**/*.d.ts", "dist.new", {
      rename: (basename) => basename.replace(/\.d\.ts$/, ".d.ts"),
    });
  })(),
]);

// ...
await fs.remove("dist");
await fs.rename("dist.new", "dist");
```

```yaml
# .eslintrc.yaml:24-40 (抜粋)
# import 拡張子強制 + 循環参照検出
rules:
  import/no-cycle: error
  import/no-self-import: error
  import/extensions:
    - error
    - always
    - ignorePackages: true
  'no-instanceof/no-instanceof': 'error'
  'drizzle-internal/require-entity-kind': 'error'
```

## パターンカタログ

- **Staging Directory Pattern** (分類: ビルド)
  - 解決する問題: ビルド途中に不完全な成果物を他プロセスが参照するリスク
  - 適用条件: ビルド出力が他パッケージから直接参照されるモノレポ環境
  - コード例: `drizzle-orm/scripts/build.ts:49,75-76`（`dist.new` -> `dist` アトミックスワップ）
  - 注意点: `workspace:./drizzle-orm/dist` のような直接パス参照がある場合に特に重要

- **Source-Derived Exports Map** (分類: 生成)
  - 解決する問題: 数百のサブパスエクスポートを手動管理する非現実性
  - 適用条件: ソースディレクトリ構造がそのまま公開 API 構造に対応するライブラリ
  - コード例: `drizzle-orm/scripts/build.ts:8-44`
  - 注意点: ソース構造の変更が即座に公開 API に影響するため、意図しないエクスポートに注意が必要

- **AST-Based Import Rewriting** (分類: 変換)
  - 解決する問題: CJS/ESM デュアルパブリッシュ時の拡張子不一致
  - 適用条件: `bundle: false` でファイル単位トランスパイルし、CJS と ESM で異なる拡張子が必要な場合
  - コード例: `drizzle-orm/scripts/fix-imports.ts:27-66`
  - 注意点: 正規表現による文字列置換では動的 import や re-export のパスを見逃すため、AST 走査が必要

## Good Patterns

- **tsup と tsc の並列実行による型生成分離**: tsup は JS トランスパイルに専念させ（`dts: false` 相当）、型定義は `tsc -p tsconfig.dts.json` で別途生成する。tsup の DTS 生成は大規模プロジェクトで不安定になりうるため、tsc に委ねることで信頼性を確保している。両者を `Promise.all` で並列実行し、ビルド時間も最小化している。

```typescript
// drizzle-orm/scripts/build.ts:51-63
await Promise.all([
  (async () => {
    await $`tsup`.stdio("pipe", "pipe", "pipe");
  })(),
  (async () => {
    await $`tsc -p tsconfig.dts.json`.stdio("pipe", "pipe", "pipe");
    await cpy("dist-dts/**/*.d.ts", "dist.new", {/* .d.cts コピー */});
    await cpy("dist-dts/**/*.d.ts", "dist.new", {/* .d.ts コピー */});
  })(),
]);
```

- **`workspace:./pkg/dist` による dist 直接参照**: pnpm の `workspace:` プロトコルで `dist` ディレクトリを直接指すことで、モノレポ内のパッケージ間依存を「ビルド済み成果物」に対して解決する。これにより、消費側のパッケージは常にビルド後の CJS/ESM バンドルを参照し、ソースコードへの依存を排除する。

```json
// package.json:25
"drizzle-orm": "workspace:./drizzle-orm/dist"
```

- **Turborepo の精密な inputs/outputs 指定**: 各ビルドタスクの `inputs` に `src/**/*.ts`、`tsconfig.json`、`tsup.config.ts`、`scripts/build.ts` を明示し、`outputs` に `dist/**` を指定する。無関係なファイル変更でキャッシュが無効化されることを防ぎ、CI ビルドの実行時間を最適化する。

```json
// turbo.json:33-49
"drizzle-orm#build": {
  "inputs": [
    "src/**/*.ts", "package.json", "README.md", "../README.md",
    "tsconfig.json", "tsconfig.*.json", "tsup.config.ts",
    "scripts/build.ts", "scripts/fix-imports.ts", "../tsconfig.json"
  ],
  "outputs": ["dist/**", "dist-dts/**"]
}
```

- **CI での `@arethetypeswrong/cli` ゲート**: リリースパイプラインで `attw` ジョブを必須ゲートとして配置し、CJS/ESM の型解決に不整合がある場合にリリースをブロックする。これは「ビルドが通る」と「型が正しく解決される」は別問題であるという認識に基づく。

## Anti-Patterns / 注意点

- **tsup の DTS 生成への過信**: tsup には `dts: true` オプションがあるが、drizzle-orm はこれを使わず tsc で型を生成している。大量のファイルやパスエイリアスがある場合、tsup の DTS 生成は不完全になりうる。ただし drizzle-kit では `tsup.build({ dts: true })` を使用しており、パッケージの規模に応じた使い分けが見られる。

```typescript
// Bad: 大規模パッケージで tsup に DTS 生成を任せる
export default defineConfig({
  dts: true, // 数百ファイルでは不安定になりうる
});

// Better: tsc で型生成を分離し並列実行
await Promise.all([
  $`tsup`, // JS のみ
  $`tsc -p tsconfig.dts.json`, // 型定義のみ
]);
```

- **正規表現ベースのインポートパス書き換え**: 文字列置換でインポートパスの拡張子を変更するアプローチは、動的 import、`export * from`、`require()` 呼び出し内のパスを見逃すリスクがある。drizzle-orm が recast による AST 走査を採用しているのはこの問題への対処である。

```typescript
// Bad: 正規表現による文字列置換
content = content.replace(/from '\.\/(.+)\.js'/g, "from './$1.cjs'");

// Better: AST 走査で全ノード型を網羅
visit(code, {
  visitImportDeclaration(path) {/* ... */},
  visitExportAllDeclaration(path) {/* ... */},
  visitCallExpression(path) {/* require() も捕捉 */},
  visitAwaitExpression(path) {/* 動的 import も捕捉 */},
});
```

- **exports map の手動管理**: エントリポイントが数十を超えるパッケージで exports map を手動で維持すると、追加漏れや不整合が頻発する。

```json
// Bad: 手動で数百エントリを管理
"exports": {
  ".": { /* ... */ },
  "./pg-core": { /* ... */ },
  "./mysql-core": { /* ... */ }
  // 新しいサブパスを追加し忘れる
}

// Better: ソースから自動生成
const entries = await glob('src/**/*.ts');
pkg.exports = entries.reduce((acc, entry) => { /* ... */ }, {});
```

## 導出ルール

- `[MUST]` CJS/ESM デュアルパブリッシュ時は、CI に `@arethetypeswrong/cli`（attw）検証を組み込み、型解決の正当性をリリースゲートにする
  - 根拠: drizzle-orm は全 8 パッケージに対して attw を CI 必須ゲートとし、`release` ジョブが `attw` の成功に依存する設計にしている（`.github/workflows/release-latest.yaml:222-312`）
- `[MUST]` モノレポでビルド成果物を他パッケージが参照する場合、ステージングディレクトリ（`dist.new`）でビルドし、完了後にアトミックにリネームする
  - 根拠: `workspace:./drizzle-orm/dist` で直接参照されるため、ビルド途中の壊れた `dist` は依存パッケージのビルド失敗を引き起こす（`drizzle-orm/scripts/build.ts:49,75-76`）
- `[MUST]` Turborepo のタスク定義では `inputs` と `outputs` を精密に指定し、キャッシュの有効性を最大化する
  - 根拠: ビルドスクリプト自体（`scripts/build.ts`、`scripts/fix-imports.ts`）を `inputs` に含めないとスクリプト変更時にキャッシュが無効化されない（`turbo.json:33-49`）
- `[SHOULD]` エントリポイントが多数あるパッケージの exports map は、ソースディレクトリから自動生成する
  - 根拠: drizzle-orm は 444 のソースファイルから exports map をビルド時に自動生成し、手動管理のコストとエラーを排除している（`drizzle-orm/scripts/build.ts:8-44`）
- `[SHOULD]` 大規模パッケージでは tsup の DTS 生成を使わず、tsc で型定義を別途生成して並列実行する
  - 根拠: drizzle-orm は tsup と tsc を `Promise.all` で並列実行し、tsup は JS トランスパイル、tsc は型生成に責務を分離している（`drizzle-orm/scripts/build.ts:51-63`）
- `[SHOULD]` フォーマッタ（dprint/Prettier）とリンタ（ESLint）は責務を分離し、フォーマッタはコードスタイル、リンタは意味的ルールに集中させる
  - 根拠: dprint がスタイル強制、ESLint が `import/no-cycle`、`no-instanceof`、`require-entity-kind` などのセマンティックルールに専念する分離設計（`dprint.json`、`.eslintrc.yaml`）
- `[SHOULD]` CJS/ESM デュアルパブリッシュでインポートパスの拡張子を変換する場合は、正規表現ではなく AST 走査を使う
  - 根拠: `fix-imports.ts` は recast で `import`、`export`、`require()`、動的 `import()` の全ノード型を網羅し、正規表現では見逃しうるパターンを確実に変換する（`drizzle-orm/scripts/fix-imports.ts:29-66`）
- `[AVOID]` モノレポの lint タスクをビルド完了前に実行すること
  - 根拠: `//#lint` は `drizzle-orm#build` と `^test:types` に `dependsOn` を設定し、ビルド・型チェック完了後にのみ実行される。ビルド前にリントすると、生成された型情報が不足し `import/extensions` 等のルールが誤検出する（`turbo.json:4-16`）

## 適用チェックリスト

- [ ] CJS/ESM デュアルパブリッシュしているパッケージで `attw` 検証を CI に組み込んでいるか
- [ ] ビルド成果物を他パッケージが直接参照する場合、ステージングディレクトリ経由のアトミックスワップを使っているか
- [ ] Turborepo の `inputs` にビルドスクリプト自体（`build.ts` 等）を含めているか
- [ ] exports map のエントリ数が 10 を超える場合、自動生成を検討したか
- [ ] tsup で DTS 生成に問題がある場合、tsc への分離を検討したか
- [ ] dprint/Prettier とESLint の責務が重複していないか（フォーマットルールを ESLint から除去しているか）
- [ ] インポートパスの拡張子変換に正規表現を使っている場合、動的 import や re-export の見逃しがないか
- [ ] Turborepo のタスクグラフで lint が build に依存しているか
