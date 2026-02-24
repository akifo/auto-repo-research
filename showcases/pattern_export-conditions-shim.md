# Pattern: Export Conditions Shim

> 出典: [repos/modelcontextprotocol/typescript-sdk](../repos/modelcontextprotocol/typescript-sdk/)
> カテゴリ: pattern

## 概要

`package.json` の条件付きエクスポート（export conditions）と最小限の shim ファイルを組み合わせ、マルチランタイム対応を静的に解決するパターン。実行時のランタイム検出分岐（`typeof process !== 'undefined'`）を排除し、バンドラー/パッケージマネージャーの条件解決に委ねることで、tree-shaking の阻害を防ぎつつプラットフォーム差異を吸収する。shim ファイルは re-export またはスタブの提供のみに徹し、ロジックを一切含まないことが設計の核心。

## 背景・文脈

Node.js / Cloudflare Workers / ブラウザなど複数のランタイムで動作するライブラリを開発する場合、ランタイムごとに異なる依存（JSON Schema バリデーター、暗号ライブラリ、ファイルシステム API 等）を切り替える必要がある。従来のアプローチは実行時のランタイム検出分岐だが、これには以下の問題がある:

1. **tree-shaking の阻害**: 実行時分岐は静的解析できないため、使わないランタイムのコードもバンドルに含まれる
2. **新ランタイムへの対応コスト**: Deno, Bun など新しいランタイムが登場するたびに条件分岐の追加が必要
3. **テスト爆発**: ランタイム分岐のパスごとにテストが必要になり、組み合わせが指数的に増加する

MCP TypeScript SDK は、Node.js では Ajv（コード生成ベースで高速）、Cloudflare Workers では `@cfworker/json-schema`（`eval`/`new Function` 禁止環境対応）という 2 つの JSON Schema バリデーターを、export conditions + shim で切り替えている。消費側のコードは単一のインポートパスで、ランタイムに応じた実装を自動的に取得する。

## 実装パターン

### 1. 共通インターフェースの定義

プラットフォーム差異を吸収するための共通インターフェースを定義する。各ランタイム向けの実装はこのインターフェースに準拠する（Strategy パターン）。

```typescript
// packages/core/src/validation/types.ts:51-59
export interface jsonSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T>;
}
```

### 2. ランタイム別 shim ファイルの作成

shim ファイルは re-export のみに徹する。Node.js 側は 2 行で完結。

```typescript
// packages/server/src/shimsNode.ts:1-7
// Node.js 向け shim: re-export のみ
export { AjvJsonSchemaValidator as DefaultJsonSchemaValidator } from "@modelcontextprotocol/core";
export { default as process } from "node:process";
```

```typescript
// packages/server/src/shimsWorkerd.ts:1-23
// Cloudflare Workers 向け shim: バリデーター切替 + process スタブ
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from "@modelcontextprotocol/core";

function notSupported(): never {
  throw new Error(
    "StdioServerTransport is not supported in this environment. "
      + "Use StreamableHTTPServerTransport instead.",
  );
}

export const process = {
  get stdin(): never {
    return notSupported();
  },
  get stdout(): never {
    return notSupported();
  },
};
```

### 3. package.json の条件付きエクスポート定義

`_shims` サブパスを export conditions で定義し、ランタイムに応じた shim を静的に解決する。`default` フォールバックを必ず設定する。

```jsonc
// packages/server/package.json:29-46
"./_shims": {
    "workerd": {
        "types": "./dist/shimsWorkerd.d.mts",
        "import": "./dist/shimsWorkerd.mjs"
    },
    "browser": {
        "types": "./dist/shimsWorkerd.d.mts",
        "import": "./dist/shimsWorkerd.mjs"
    },
    "node": {
        "types": "./dist/shimsNode.d.mts",
        "import": "./dist/shimsNode.mjs"
    },
    "default": {
        "types": "./dist/shimsNode.d.mts",
        "import": "./dist/shimsNode.mjs"
    }
}
```

### 4. ビルド設定で shim を external 化

shim インポートをバンドルに含めず、ランタイムの条件付きエクスポート解決に委ねる。

```typescript
// packages/server/tsdown.config.ts:33-36
noExternal: ['@modelcontextprotocol/core'],
external: ['@modelcontextprotocol/server/_shims']
```

### 5. 消費側のコード

消費側は `_shims` からインポートするだけ。ランタイム分岐のコードは一切書かない。

```typescript
// packages/server/src/server/server.ts:56,112
import { DefaultJsonSchemaValidator } from "@modelcontextprotocol/server/_shims";

// ランタイムに応じた実装が自動的に解決される
this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new DefaultJsonSchemaValidator();
```

## Good Example

**re-export のみの最小 shim + 明確なエラーメッセージ付きスタブ:**

```typescript
// shims/node.ts — re-export のみ、ロジックなし
export { AjvJsonSchemaValidator as DefaultValidator } from "@my-package/core";
export { webcrypto as crypto } from "node:crypto";
export { default as process } from "node:process";
```

```typescript
// shims/workerd.ts — 非対応機能には代替手段を案内するスタブ
export { CfWorkerJsonSchemaValidator as DefaultValidator } from "@my-package/core";
export { crypto } from "@my-package/core"; // Web Crypto API ベース

function notSupported(feature: string, alternative: string): never {
  throw new Error(
    `${feature} is not supported in this environment. Use ${alternative} instead.`,
  );
}

export const process = {
  get stdin(): never {
    return notSupported("stdin", "HTTP transport");
  },
  get stdout(): never {
    return notSupported("stdout", "HTTP transport");
  },
};
```

```jsonc
// package.json — export conditions で静的解決
{
  "exports": {
    ".": { "types": "./dist/index.d.mts", "import": "./dist/index.mjs" },
    "./_shims": {
      "workerd": { "types": "./dist/shims/workerd.d.mts", "import": "./dist/shims/workerd.mjs" },
      "browser": { "types": "./dist/shims/workerd.d.mts", "import": "./dist/shims/workerd.mjs" },
      "node": { "types": "./dist/shims/node.d.mts", "import": "./dist/shims/node.mjs" },
      "default": { "types": "./dist/shims/node.d.mts", "import": "./dist/shims/node.mjs" },
    },
  },
}
```

**type-only import で Node.js 型を安全に利用:**

```typescript
// Node.js の型をコンパイル時のみ使用し、ランタイム依存を回避
import { process } from "@my-package/_shims"; // shim 経由で取得
import type { Readable, Writable } from "node:stream";

export class StdioTransport {
  constructor(
    private stdin: Readable = process.stdin,
    private stdout: Writable = process.stdout,
  ) {}
}
```

**optional peer dependency で不要なパッケージのインストールを回避:**

```jsonc
// package.json
{
  "peerDependencies": {
    "@cfworker/json-schema": "^2.0.0",
  },
  "peerDependenciesMeta": {
    "@cfworker/json-schema": { "optional": true },
  },
}
// Node.js 環境では @cfworker/json-schema のインストール不要
// shim の条件付きエクスポートにより、存在しないパッケージがインポートされることもない
```

## Bad Example

**実行時ランタイム検出による分岐:**

```typescript
// Bad: 実行時ランタイム検出 — tree-shaking 不可、新ランタイム対応が手動
import { AjvJsonSchemaValidator } from "./ajvProvider.js";
import { CfWorkerJsonSchemaValidator } from "./cfWorkerProvider.js";

const validator = typeof process !== "undefined"
  ? new AjvJsonSchemaValidator()
  : new CfWorkerJsonSchemaValidator();
// 両方の実装がバンドルに含まれる
// Deno や Bun では process が存在するため意図しない分岐になりうる
```

```typescript
// Better: 条件付きエクスポート + shim で静的解決
import { DefaultJsonSchemaValidator } from "@my-package/_shims";
const validator = new DefaultJsonSchemaValidator();
// バンドラーが export conditions に従い、対象ランタイムの実装のみをバンドル
```

**shim にロジックを埋め込む:**

```typescript
// Bad: shim 内にバリデーションロジック — テストが必要になり shim の利点が失われる
export class DefaultJsonSchemaValidator {
  private ajv?: Ajv;
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    if (!this.ajv) this.ajv = new Ajv({ strict: false });
    const validate = this.ajv.compile(schema);
    return { validate: (data) => ({ value: data as T }) };
  }
}
```

```typescript
// Better: shim は re-export のみ、ロジックは別ファイルに
export { AjvJsonSchemaValidator as DefaultJsonSchemaValidator } from "@my-package/core";
```

**コアモジュールから Node.js 固有 API を直接インポート:**

```typescript
// Bad: コアモジュール内で Node.js API を直接使用 — Web Standard ランタイムで動作しない
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

export function startServer(port: number) {
  const server = createServer(/* ... */);
  server.listen(port);
}
```

```typescript
// Better: コアは Web Standard API のみ使用し、Node.js 固有はアダプターに分離
// core/server.ts — Web Standard API のみ
export class WebStandardServer {
  async handleRequest(request: Request): Promise<Response> {/* ... */}
}

// adapters/node.ts — Node.js 固有の変換
import { getRequestListener } from "@hono/node-server";
import { WebStandardServer } from "../core/server.js";

export function createNodeHandler(server: WebStandardServer) {
  return getRequestListener(async (req) => server.handleRequest(req));
}
```

## 適用ガイド

### どのような状況で使うべきか

- **Node.js + Edge Runtime (Cloudflare Workers, Vercel Edge) のデュアルランタイム対応**: JSON Schema バリデーター、暗号ライブラリ、ファイルシステムなど、ランタイムごとに異なる実装が必要な場合
- **npm パッケージで tree-shaking を最大化したい場合**: 実行時分岐を排除し、バンドラーが不要なコードを除去できるようにする
- **新しいランタイムへの対応を低コストで行いたい場合**: shim ファイルを追加し、export conditions にエントリを追加するだけで対応完了

### 導入時の注意点

- **`default` フォールバックを必ず設定する**: export conditions はバンドラー/ランタイムによってサポート状況が異なる。`default` を最後に配置し、未知の環境でも動作を保証する
- **shim インポートパスを `external` に指定する**: ビルド時に shim がバンドルに含まれると、条件付きエクスポートの解決が無効化される。tsdown / rollup / esbuild の設定で明示的に `external` にする
- **shim にロジックを入れない**: shim ファイルにロジックが入ると、プラットフォームごとのテストが必要になり、「薄いグルー」としての利点が失われる。ロジックは必ず共通のコアパッケージに集約する
- **`workerd` 条件は Cloudflare Workers 専用**: `workerd` は Cloudflare Workers のバンドラー（wrangler）が認識する条件。他の Edge Runtime では `browser` や `edge-light` を使う場合がある

### カスタマイズポイント

- **shim で切り替える対象の選択**: バリデーター、暗号、ロガー、ストレージなど、ランタイムごとに実装が異なる依存を洗い出し、共通インターフェースを定義してから shim を作成する
- **条件の種類**: `node` / `workerd` / `browser` / `edge-light` / `deno` など、対象ランタイムに合わせて条件を設定する。バンドラー固有の条件（`import` / `require` / `module`）との組み合わせも可能
- **層の分離レベル**: 差異が小さい場合は shim のみで十分。HTTP やフレームワーク API の差異が大きい場合は、アダプターパッケージやミドルウェアパッケージとして分離する（MCP SDK は shim / アダプター / ミドルウェアの 3 層に分離している）

## 参考

- [repos/modelcontextprotocol/typescript-sdk/platform-abstraction.md](../repos/modelcontextprotocol/typescript-sdk/platform-abstraction.md) -- export conditions + shim パターンの詳細分析
- [repos/modelcontextprotocol/typescript-sdk/project-structure.md](../repos/modelcontextprotocol/typescript-sdk/project-structure.md) -- モノレポ構成と exports conditions によるランタイム分岐
