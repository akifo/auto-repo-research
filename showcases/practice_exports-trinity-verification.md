# Practice: Exports Trinity Verification

> 出典: [repos/cloudflare/agents/api-design-practices](../repos/cloudflare/agents/api-design-practices.md), [repos/cloudflare/agents/build-and-tooling](../repos/cloudflare/agents/build-and-tooling.md)
> カテゴリ: practice

## 概要

package.json の `exports` フィールド、ビルドスクリプトのエントリポイント配列、CI の `check:exports` スクリプトの 3 箇所で公開 API の整合性を自動検証する「三位一体検証」パターン。ライブラリのサブパスエントリポイントが増えるにつれ、1 箇所だけ更新して他を忘れる不整合事故が頻発するが、このパターンはビルドパイプライン自体を安全ネットにして CI で検出する。

## 背景・文脈

cloudflare/agents は単一 npm パッケージ `agents` から 18 以上のサブパスエントリポイントを公開する SDK である。各エントリは `types`/`import`/`require` の条件付きエクスポートを持ち、対応するソースファイル、ビルドエントリ、package.json の exports 宣言が三者一致している必要がある。

エントリポイント追加の典型的な作業フロー:

1. `src/` にソースファイルを追加
2. `scripts/build.ts` の `entry` 配列にファイルを追加
3. `package.json` の `exports` に公開パスを追加

この 3 ステップのうち 1 つでも欠けると、利用者が `import ... from "agents/mcp"` と書いたときに解決先が存在しない破壊的な問題が発生する。人間の注意力に頼らず、機械的に不整合を検出する仕組みが必要になる。

## 実装パターン

三位一体検証は以下の 3 層で構成される。

### 第 1 層: package.json exports（公開インターフェースの宣言）

package.json の `exports` フィールドに全サブパスと条件付きエクスポートを宣言する。これが「利用者から見える公開 API」の正式な定義になる。

```json
// packages/agents/package.json:87-177 (抜粋)
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./mcp": {
      "types": "./dist/mcp/index.d.ts",
      "import": "./dist/mcp/index.js"
    },
    "./mcp/client": {
      "types": "./dist/mcp/client.d.ts",
      "import": "./dist/mcp/client.js"
    },
    "./observability": {
      "types": "./dist/observability/index.d.ts",
      "import": "./dist/observability/index.js"
    }
  }
}
```

### 第 2 層: ビルドスクリプトのエントリポイント（ビルド成果物の生成源）

ビルドスクリプトが tsdown の `entry` 配列で exports に対応するソースファイルを列挙する。ここに含まれないファイルは `dist/` に生成されない。

```typescript
// packages/agents/scripts/build.ts:4-25
async function main() {
  await build({
    clean: true,
    dts: true,
    entry: [
      "src/*.ts",
      "src/*.tsx",
      "src/cli/index.ts",
      "src/mcp/index.ts",
      "src/mcp/client.ts",
      "src/mcp/do-oauth-client-provider.ts",
      "src/mcp/x402.ts",
      "src/observability/index.ts",
      "src/codemode/ai.ts",
      "src/experimental/forever.ts",
    ],
    skipNodeModulesBundle: true,
    external: ["cloudflare:workers", "cloudflare:email"],
    format: "esm",
    sourcemap: true,
    fixedExtension: false,
  });

  execSync("oxfmt --write ./dist/*.d.ts");
  process.exit(0);
}
```

### 第 3 層: check:exports スクリプト（整合性の自動検証）

ビルド後に走る検証スクリプトが、package.json の `exports` に記載された全パスのファイルが `dist/` に実在するかを確認する。

```typescript
// scripts/check-exports.ts:9-28
function extractFilePaths(
  exports: unknown,
  paths: Set<string> = new Set(),
): Set<string> {
  if (typeof exports === "string") {
    paths.add(exports);
  } else if (Array.isArray(exports)) {
    for (const item of exports) {
      extractFilePaths(item, paths);
    }
  } else if (exports && typeof exports === "object") {
    for (const value of Object.values(exports)) {
      extractFilePaths(value, paths);
    }
  }
  return paths;
}
```

```typescript
// scripts/check-exports.ts:48-63
const filePaths = extractFilePaths(packageJson.exports);
for (const filePath of filePaths) {
  if (!filePath.startsWith(".")) continue;
  const fullPath = resolve(packageDir, filePath);
  if (!existsSync(fullPath)) {
    missing.push(filePath);
  }
}
```

再帰的に exports オブジェクトを走査し、条件付きエクスポート（`types`, `import`, `require`）のネストを全て解決する。`"."` で始まるパスのみをチェック対象にし、パッケージ名参照はスキップする。

### CI での統合

```yaml
# .github/workflows/pullrequest.yml
jobs:
  check:
    steps:
      - run: npm ci
      - run: npm run build       # 第2層: ビルド成果物を生成
      - run: npm run check       # 第3層: check:exports を含む統合チェック
```

`npm run check` の中で `check:exports` が実行される。ビルド後に実行するため、`dist/` のファイル有無を正確に判定できる。

## Good Example

```typescript
// scripts/check-exports.ts — 汎用的に再利用可能な実装
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// exports オブジェクトから全ファイルパスを再帰的に抽出
function extractFilePaths(
  exports: unknown,
  paths: Set<string> = new Set(),
): Set<string> {
  if (typeof exports === "string") {
    paths.add(exports);
  } else if (Array.isArray(exports)) {
    for (const item of exports) {
      extractFilePaths(item, paths);
    }
  } else if (exports && typeof exports === "object") {
    for (const value of Object.values(exports)) {
      extractFilePaths(value, paths);
    }
  }
  return paths;
}

// package.json の exports に宣言された全パスの存在を検証
function checkPackageExports(packageDir: string): string[] {
  const packageJsonPath = resolve(packageDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  const missing: string[] = [];

  const filePaths = extractFilePaths(packageJson.exports);
  for (const filePath of filePaths) {
    if (!filePath.startsWith(".")) continue;
    const fullPath = resolve(packageDir, filePath);
    if (!existsSync(fullPath)) {
      missing.push(filePath);
    }
  }

  return missing;
}
```

ポイント:

- `extractFilePaths` が再帰的に走査するため、`types`/`import`/`require`/`default` のどんなネスト構造でも対応できる
- `"."` で始まるパスのみをチェック対象にし、外部パッケージ参照を除外する
- モノレポでは複数パッケージに対してループで実行可能

## Bad Example

```typescript
// Bad: exports とビルドエントリを手動で同期し、検証スクリプトがない

// package.json
{
  "exports": {
    ".": { "import": "./dist/index.js" },
    "./mcp": { "import": "./dist/mcp/index.js" },
    "./new-feature": { "import": "./dist/new-feature.js" }  // 追加した
  }
}

// build.ts — ./new-feature のエントリ追加を忘れた
await build({
  entry: [
    "src/index.ts",
    "src/mcp/index.ts",
    // "src/new-feature.ts"  <-- 追加忘れ！
  ],
});

// 結果: ビルドは成功するが dist/new-feature.js が生成されない
// 利用者が import "pkg/new-feature" すると実行時エラーになる
// CI にチェックスクリプトがないため、PR がそのままマージされる
```

この不整合は以下の理由で発見が遅れやすい:

- ビルド自体はエラーなく成功する（存在するファイルだけをビルドするため）
- TypeScript の型チェックも通過する（ソースコードには問題がないため）
- パッケージ作者のローカル環境では `dist/` に古いファイルが残っていて動作する場合がある

## 適用ガイド

### どのような状況で使うべきか

- npm パッケージで 3 つ以上のサブパスエントリポイントを公開している場合
- モノレポで複数パッケージの exports を管理している場合
- エントリポイントの追加・削除が頻繁に発生するライブラリ開発

### 導入時の注意点

- **ビルド後に実行する**: check:exports はビルド成果物の存在を確認するため、必ず `build` の後に実行する。CI パイプラインでの実行順序に注意する
- **条件付きエクスポートの全条件をカバーする**: `types`, `import`, `require`, `default` の全条件を再帰的に走査する実装にする。特定の条件だけチェックすると漏れが生じる
- **内部パッケージの除外**: モノレポで公開しないパッケージがある場合、`SKIP_PACKAGES` のような除外リストを用意する

### カスタマイズポイント

- **Single Source of Truth への発展**: exports フィールドからビルドエントリを自動生成する（またはその逆）ことで、2 箇所の手動同期を不要にできる。cloudflare/agents では 3 層が独立しているが、理想的には exports を唯一の定義元にしてビルドエントリを導出する
- **逆方向の検証**: 「`dist/` にあるが exports に宣言されていないファイル」を検出する逆方向チェックを追加すると、意図せず公開されるファイルも発見できる
- **型定義の内容検証**: ファイルの存在だけでなく、`.d.ts` が空でないか、期待するエクスポートを含むかまで検証するとさらに堅牢になる

### 最小構成での導入手順

1. `scripts/check-exports.ts`（または `.js`）を作成し、上記の Good Example を配置する
2. `package.json` の `scripts` に追加:
   ```json
   {
     "scripts": {
       "check:exports": "tsx scripts/check-exports.ts",
       "check": "npm run build && npm run check:exports"
     }
   }
   ```
3. CI のビルドジョブで `npm run build && npm run check:exports` を実行する

## 参考

- [repos/cloudflare/agents/api-design-practices.md](../repos/cloudflare/agents/api-design-practices.md) — 多エントリポイント exports の三位一体管理、exports 整合性チェックの分析
- [repos/cloudflare/agents/build-and-tooling.md](../repos/cloudflare/agents/build-and-tooling.md) — ビルドスクリプト構造、CI パイプラインでの check:exports 実行フロー
