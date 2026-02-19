# Workflow: Codegen Diff CI

> 出典: [repos/Effect-TS/effect](../repos/Effect-TS/effect/)
> カテゴリ: workflow

## 概要

コード生成スクリプトを CI で実行し、`git diff --exit-code` で差分がないことを検証するワークフローパターン。自動生成ファイルがリポジトリにコミットされている場合、手動編集や生成コマンドの実行漏れを機械的に検出し、生成コードと真実の源泉（設定ファイル・ソースデータ）の一貫性を保証する。

## 背景・文脈

Effect-TS/effect は 35 以上のパッケージを持つ大規模 TypeScript モノレポであり、各パッケージの barrel file（`src/index.ts`）を `package.json` の `exports` フィールドとファイルシステム構造から自動生成している。barrel file は公開 API のエントリポイントとして機能するため、モジュール追加時の更新漏れやエクスポートの不整合はユーザーに直接影響する。

手動での barrel file 管理は「新しいモジュールを作ったが `index.ts` に追加し忘れた」「別の PR で `index.ts` を直接編集したが、次回の codegen 実行で上書きされた」といった問題を招く。Effect-TS はこれを解決するために、codegen コマンドの結果に差分がないことを CI で検証する **Codegen Guard パターン** を採用している。

この仕組みは barrel file に限らず、バージョン情報の埋め込み（`scripts/version.mjs`）、JSDoc の AST ベース補完（`scripts/codemods/jsdoc.ts`）、外部アセットのインライン化（`scripts/package-swagger.mjs`）など、リポジトリ内の複数のコード生成パイプラインに適用されている。

## 実装パターン

### 1. コード生成コマンドの定義

各パッケージの `codegen` スクリプトとして `build-utils prepare-v3` を呼び出し、統一的なインターフェースで codegen を実行できるようにする。

```jsonc
// packages/effect/package.json:20
"codegen": "build-utils prepare-v3"
```

ルートの `package.json` では、全パッケージの codegen を一括実行するスクリプトを定義する。

```jsonc
// package.json
"codegen": "pnpm --recursive codegen"
```

### 2. 生成ロジックの核心部分

`build-utils prepare-v3` は `package.json` の `exports` フィールドとカスタム設定から barrel file を導出する。

```typescript
// build-utils/src/PrepareV3.ts:16-58
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

### 3. パッケージごとの宣言的設定

各パッケージは `package.json` 内の `effect.generateIndex` フィールドで、どのモジュールを barrel に含めるかを宣言的に制御する。

```jsonc
// packages/cli/package.json:69-75
"effect": {
  "generateIndex": {
    "include": ["**/*"]
  }
}
```

`**/internal/**` は自動的に除外されるため、内部モジュールが公開 API に漏れることはない。

### 4. CI での差分チェック

CI ワークフローで codegen を実行した後、`git diff --exit-code` でワーキングツリーに差分がないことを検証する。

```yaml
# .github/workflows/check.yml:36-39
- run: pnpm codegen
- name: Check for codegen changes
  run: git diff --exit-code
```

`git diff --exit-code` は差分があれば exit code 1 を返すため、以下のケースで CI が失敗する:

- モジュールを追加したが `pnpm codegen` を実行せずにコミットした
- 自動生成ファイル（`index.ts`）を手動で編集した
- 生成ロジックが更新されたが、既存パッケージで再生成されていない

### 5. ESLint ルールとの二重保証

差分チェックに加え、`eslint-plugin-codegen` を ESLint ルールとして設定することで、ローカル開発時にも生成コードの鮮度を検証する。

```javascript
// eslint.config.mjs:65
"codegen/codegen": "error",
```

CI の `git diff` チェックとローカルの ESLint チェックの二重構造により、問題の検出タイミングを早めている。

### 6. リリースパイプラインへの組み込み

publish 前にも codegen（codemod 含む）を実行することで、リリース時の一貫性を保証する。

```jsonc
// package.json（changeset-publish スクリプトの実行順序）
// pnpm codemod && pnpm build && TEST_DIST= pnpm vitest && changeset publish
```

### 7. AGENTS.md での明文化

AI エージェント向けの開発ガイドでも、barrel file が自動生成であることと再生成コマンドを明示している。

```markdown
<!-- AGENTS.md:36-37 -->

- Do not modify `index.ts` barrel files by hand. Run `pnpm codegen` to regenerate them.
```

## Good Example

codegen コマンドを定義し、CI で差分チェックを行い、ESLint でもローカル検証する多層構造。

```yaml
# .github/workflows/check.yml
jobs:
  lint:
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup

      # 1. codegen を実行
      - run: pnpm codegen

      # 2. 差分があれば CI 失敗
      - name: Check for codegen changes
        run: git diff --exit-code

      # 3. ESLint でも生成コードの鮮度を検証
      - run: pnpm lint
```

```jsonc
// package.json — 統一されたコマンド体系
{
  "scripts": {
    "codegen": "pnpm --recursive codegen",
    "lint": "eslint .",
    "changeset-publish": "pnpm codemod && pnpm build && pnpm vitest && changeset publish",
  },
}
```

この構造の利点:

- **冪等性**: codegen は何度実行しても同じ結果を返すため、差分チェックが信頼できる
- **宣言的**: 生成対象は `package.json` の設定で制御され、生成ロジックに触れる必要がない
- **多層防御**: CI の `git diff`、ESLint ルール、AGENTS.md の明文化で三重にガードしている
- **リリース安全性**: publish パイプラインにも codegen が組み込まれ、リリース時の不整合を防ぐ

## Bad Example

自動生成ファイルを手動管理し、CI での検証を行わない実装。

```typescript
// Bad: barrel file を手動で管理する
// packages/mylib/src/index.ts
export * as Array from "./Array.js";
export * as Effect from "./Effect.js";
export * as Option from "./Option.js";
// → 新しいモジュール Stream.ts を追加したが、index.ts への追加を忘れる
// → PR レビューでも見落とされ、ユーザーが import できない状態でリリースされる
```

```yaml
# Bad: codegen を CI に組み込まない
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm build
      - run: pnpm test
      # codegen の実行も差分チェックもない
      # → 開発者が pnpm codegen を忘れても CI は通る
```

```typescript
// Bad: 自動生成ファイルを直接編集する
// packages/effect/src/index.ts
export * as MyNewModule from "./MyNewModule.js"; // 手動追加
// → 次回の pnpm codegen で上書きされて消える
// → 生成ファイルであることがファイル自体から判別できない
```

```yaml
# Bad: codegen を実行するが差分チェックしない
jobs:
  lint:
    steps:
      - run: pnpm codegen  # 実行するだけ
      - run: pnpm lint     # codegen の結果を使うが、差分は検証しない
      # → codegen が新しいファイルを生成しても CI は通る
      # → コミットされていない生成コードが存在する状態を検出できない
```

## 適用ガイド

### どのような状況で使うべきか

- barrel file（index.ts）を自動生成しているプロジェクト
- Protocol Buffers、OpenAPI、GraphQL スキーマからのコード生成を行うプロジェクト
- バージョン情報や設定値をソースコードに埋め込んでいるプロジェクト
- 複数の開発者が並行してモジュールを追加・削除するモノレポ
- AI エージェントがコード変更を行う環境（生成ファイルの誤編集防止）

### 導入時の注意点

- **codegen の冪等性が前提**: `git diff --exit-code` が正しく機能するには、codegen コマンドが同じ入力に対して常に同じ出力を返す必要がある。タイムスタンプやランダム値を生成物に含めないこと
- **生成ファイルの識別**: Effect-TS では生成ファイルにヘッダーコメントを付けていないが、一般的には `// Code generated by xxx. DO NOT EDIT.` のようなマーカーを付けることで、人間が生成ファイルであることを識別しやすくなる
- **CI の実行順序**: codegen は lint やビルドの前に実行する必要がある。生成コードが古い状態でビルドすると、型エラーやテスト失敗の原因になる
- **`.gitignore` との使い分け**: 生成コードをコミットせず `.gitignore` に入れる方法もあるが、その場合は差分チェックではなくビルド時の生成に切り替える。Effect-TS のように生成コードをコミットするアプローチは、PR レビューで公開 API の変更を確認できる利点がある

### カスタマイズポイント

- **差分チェックの粒度**: `git diff --exit-code` の代わりに `git diff --exit-code -- "*.generated.ts"` のように対象を限定することで、無関係な差分による誤検知を防げる
- **エラーメッセージの改善**: 差分チェック失敗時に `pnpm codegen を実行してからコミットしてください` のようなメッセージを表示すると、開発者の対応が早くなる
- **pre-commit hook との併用**: `husky` + `lint-staged` で codegen をコミット前に実行し、差分があればコミットを阻止する方法もある。ただし CI での検証は必ず残すこと（hook はスキップ可能なため）

```yaml
# カスタマイズ例: エラーメッセージ付きの差分チェック
- run: pnpm codegen
- name: Check for codegen changes
  run: |
    if ! git diff --exit-code; then
      echo "::error::Generated files are out of date. Run 'pnpm codegen' and commit the changes."
      exit 1
    fi
```

## 参考

- [repos/Effect-TS/effect/code-generation.md](../repos/Effect-TS/effect/code-generation.md) -- コード生成パイプラインの詳細分析
- [repos/Effect-TS/effect/dev-conventions.md](../repos/Effect-TS/effect/dev-conventions.md) -- CI ワークフローと開発規約の全体設計
- [repos/Effect-TS/effect/rules.md](../repos/Effect-TS/effect/rules.md) -- codegen 差分チェックを含む導出ルール集
