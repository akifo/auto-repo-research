# Platform Abstraction

> リポジトリ: modelcontextprotocol/typescript-sdk
> 分析日: 2026-02-24

## 概要

Node.js と Cloudflare Workers (workerd) のデュアルランタイム対応を、package.json の条件付きエクスポート（export conditions）と薄い shim ファイルで実現するパターンを分析する。本リポジトリは JSON Schema バリデーターの実装切り替えと `process` オブジェクトの stub 化という 2 つの具体的な差異を shim 層で吸収しつつ、トランスポート層では Web Standard API をベースにすることでランタイム非依存のコアを維持している。この二層構造（shim によるポリフィル + Web Standard API への収束）がマルチランタイム対応の骨格であり、他プロジェクトにも応用しやすい設計になっている。

## 背景にある原則

- **Shim 層の最小化原則**: shim ファイルはプラットフォーム差異の「接着剤」に徹し、ビジネスロジックを含まないべき。本リポジトリの shim は各 3-23 行と極めて小さく、re-export またはスタブの提供のみを行う。shim にロジックが入ると、ランタイム分岐のテストコストが指数関数的に増加する。(`packages/server/src/shimsNode.ts`, `packages/server/src/shimsWorkerd.ts`)

- **Web Standard API ファースト**: ランタイム固有 API（`IncomingMessage`/`ServerResponse` 等）に依存するコードをアダプター層に押し出し、コアは `Request`/`Response`/`ReadableStream` 等の Web Standard API で実装すべき。こうすることで、Node.js / Cloudflare Workers / Deno / Bun いずれでもコアロジックを共有できる。(`packages/server/src/server/streamableHttp.ts:1-8` のコメントに設計意図が明記されている)

- **条件付きエクスポートによる静的解決**: ランタイム分岐を実行時の `if` 文ではなく、パッケージマネージャー / バンドラーの export conditions で静的に解決すべき。実行時分岐は tree-shaking を阻害し、不要なランタイムの依存関係がバンドルに混入する。(`packages/server/package.json:29-46` の `./_shims` エクスポート定義)

- **機能境界による段階的分離**: すべてのランタイム差異を一つの抽象化層で吸収しようとせず、差異の性質に応じて適切な層で対処すべき。バリデーターの切り替えは shim（静的解決）、HTTP の差異はアダプターパッケージ（`@modelcontextprotocol/node`）、フレームワーク固有の統合はミドルウェアパッケージ（`@modelcontextprotocol/express`, `@modelcontextprotocol/hono`）と、3 つの層が役割を分担している。

## 実例と分析

### Shim による JSON Schema バリデーターの自動切り替え

Node.js 環境では Ajv（コード生成ベースで高速）、Cloudflare Workers では `@cfworker/json-schema`（`eval`/`new Function` 禁止環境対応）という 2 つの JSON Schema バリデーターを shim 経由で切り替える。

core パッケージに共通の `jsonSchemaValidator` インターフェース（Strategy パターン）を定義し、2 つの実装クラスを用意する。shim ファイルは対応する実装を `DefaultJsonSchemaValidator` という統一名で re-export するだけであり、消費側（`server.ts`, `client.ts`）は `@modelcontextprotocol/server/_shims` からインポートするだけでランタイムに適した実装を得る。

この設計の鍵は、バンドラーが `_shims` サブパスを export conditions に従って解決する点にある。`tsdown.config.ts` で `_shims` を `external` に指定することで、ビルド時に shim のインポートをバンドルせず、実行時のランタイム解決に委ねている。

### process オブジェクトのスタブ化

`StdioServerTransport` は `process.stdin`/`process.stdout` に依存するが、Cloudflare Workers には `process` が存在しない。workerd 用 shim はスタブの `process` オブジェクトを提供し、`stdin`/`stdout` へのアクセス時にわかりやすいエラーメッセージを投げる。

重要なのは `import type { Readable, Writable } from 'node:stream'` が型のみのインポートであり、ランタイムに `node:stream` モジュールが不要な点。型レベルの互換性はコンパイル時に解決され、実行時には shim の `process` スタブが使われる。

### Web Standard API をベースにしたトランスポート層

`WebStandardStreamableHTTPServerTransport` は `Request`/`Response`/`ReadableStream` のみで HTTP 通信を実装する。Node.js 固有の `IncomingMessage`/`ServerResponse` への変換は `@modelcontextprotocol/node` パッケージの `NodeStreamableHTTPServerTransport` が `@hono/node-server` の `getRequestListener` を使って行う。これにより、Web Standard 対応ランタイムでは直接 `WebStandardStreamableHTTPServerTransport` を使い、Node.js の従来型 HTTP サーバーでのみラッパーを使うという選択肢が生まれる。

### ミドルウェアパッケージのアダプターパターン

`@modelcontextprotocol/express` と `@modelcontextprotocol/hono` は同じ `validateHostHeader` コア関数（Web Standard ベース、server パッケージに実装）を各フレームワークのミドルウェアシグネチャに合わせて薄くラップしている。バリデーションロジック自体はフレームワーク非依存のコアに集約し、各ミドルウェアは「フレームワーク API への橋渡し」に徹している。

## コード例

```typescript
// packages/server/package.json:29-46
// 条件付きエクスポートによるランタイム別 shim 解決
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

```typescript
// packages/server/src/shimsNode.ts:1-7
// Node.js 向け shim: re-export のみ
export { AjvJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/core';
export { default as process } from 'node:process';
```

```typescript
// packages/server/src/shimsWorkerd.ts:1-23
// Cloudflare Workers 向け shim: バリデーター切替 + process スタブ
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/core';

function notSupported(): never {
    throw new Error('StdioServerTransport is not supported in this environment. Use StreamableHTTPServerTransport instead.');
}

export const process = {
    get stdin(): never {
        return notSupported();
    },
    get stdout(): never {
        return notSupported();
    }
};
```

```typescript
// packages/server/tsdown.config.ts:33-36
// shim インポートをバンドルせず外部化し、ランタイム解決に委ねる
noExternal: ['@modelcontextprotocol/core'],
external: ['@modelcontextprotocol/server/_shims']
```

```typescript
// packages/server/src/server/server.ts:56,112
// 消費側: shim 経由で DefaultJsonSchemaValidator をインポート
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/_shims';
// ...
this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new DefaultJsonSchemaValidator();
```

```typescript
// packages/core/src/validation/types.ts:51-59
// 共通インターフェース: プラットフォーム非依存の契約
export interface jsonSchemaValidator {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T>;
}
```

```typescript
// packages/middleware/node/src/streamableHttp.ts:67-91
// Node.js アダプター: Web Standard トランスポートを IncomingMessage/ServerResponse に変換
export class NodeStreamableHTTPServerTransport implements Transport {
    private _webStandardTransport: WebStandardStreamableHTTPServerTransport;
    private _requestListener: ReturnType<typeof getRequestListener>;

    constructor(options: StreamableHTTPServerTransportOptions = {}) {
        this._webStandardTransport = new WebStandardStreamableHTTPServerTransport(options);
        this._requestListener = getRequestListener(
            async (webRequest: Request) => {
                const context = this._requestContext.get(webRequest);
                return this._webStandardTransport.handleRequest(webRequest, {
                    authInfo: context?.authInfo,
                    parsedBody: context?.parsedBody
                });
            },
            { overrideGlobalObjects: false }
        );
    }
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ランタイムによって異なる JSON Schema バリデーション実装を交換可能にする
  - 適用条件: 同一インターフェースに対して複数の実装が必要で、実行環境によって選択が決まる場合
  - コード例: `packages/core/src/validation/types.ts:51-59` (インターフェース), `packages/core/src/validation/ajvProvider.ts:38-94` (Node.js 戦略), `packages/core/src/validation/cfWorkerProvider.ts:35-79` (Workers 戦略)
  - 注意点: shim が Strategy の選択を export conditions で静的に行う点が、通常の Strategy パターン（実行時にコンテキストが選択）とは異なる。ビルド時/パッケージ解決時に戦略が確定するため、tree-shaking に有利

- **Adapter パターン** (分類: 構造)
  - 解決する問題: Web Standard API で実装されたコアトランスポートを、Node.js HTTP / Express / Hono の各フレームワーク API で利用できるようにする
  - 適用条件: プラットフォーム非依存のコア実装に対して、既存のフレームワーク固有インターフェースとの互換性が必要な場合
  - コード例: `packages/middleware/node/src/streamableHttp.ts:67-204` (Node.js HTTP アダプター)
  - 注意点: アダプターはデリゲーション（委譲）で実装し、元のオブジェクトを包む。継承は避ける（Node.js の `ServerResponse` を Web Standard `Response` に変換するなど、型階層が根本的に異なるため）

## Good Patterns

- **re-export による shim の最小化**: shim ファイルは `export { X as Y } from '...'` の re-export のみで構成し、ロジックを含まない。Node.js 側の shim は 2 行で完結している。これにより、shim ファイル自体のテストが不要になり、実装の正しさはインターフェースの型チェックで保証される。

```typescript
// packages/client/src/shimsNode.ts:6-7
export { AjvJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/core';
```

- **明確なエラーメッセージ付きスタブ**: 非サポート環境で利用不可能な機能にアクセスした場合、ランタイムエラーでクラッシュするのではなく、代替手段を案内する明確なメッセージを提供する。

```typescript
// packages/server/src/shimsWorkerd.ts:12-14
function notSupported(): never {
    throw new Error('StdioServerTransport is not supported in this environment. Use StreamableHTTPServerTransport instead.');
}
```

- **type-only import による Node.js 型の利用**: `import type` を使うことで、Node.js 固有の型（`Readable`, `Writable`）をコンパイル時の型チェックに活用しつつ、ランタイムには Node.js モジュールに依存しない。

```typescript
// packages/server/src/server/stdio.ts:1
import type { Readable, Writable } from 'node:stream';
```

- **optional peer dependency による漸進的採用**: `@cfworker/json-schema` を optional な peer dependency として宣言し、Node.js 専用環境では不要なパッケージのインストールを回避する。shim の条件付きエクスポートにより、存在しないパッケージがインポートされることもない。

```json
// packages/server/package.json:73-76
"peerDependenciesMeta": {
    "@cfworker/json-schema": { "optional": true }
}
```

## Anti-Patterns / 注意点

- **実行時ランタイム検出による分岐**: `typeof globalThis.process !== 'undefined'` のような実行時ランタイム検出で分岐すると、tree-shaking が効かず不要なランタイムのコードがバンドルに含まれる。また、新しいランタイム（Deno, Bun）が登場するたびに条件分岐の追加が必要になる。

```typescript
// Bad: 実行時ランタイム検出
import { AjvJsonSchemaValidator } from './ajvProvider.js';
import { CfWorkerJsonSchemaValidator } from './cfWorkerProvider.js';

const validator = typeof process !== 'undefined'
    ? new AjvJsonSchemaValidator()
    : new CfWorkerJsonSchemaValidator();

// Better: 条件付きエクスポート + shim で静的解決
// package.json の export conditions で解決し、消費側は単一インポートで済む
import { DefaultJsonSchemaValidator } from '@my-package/_shims';
const validator = new DefaultJsonSchemaValidator();
```

- **shim にロジックを埋め込む**: shim ファイルに条件分岐やデータ変換ロジックを含めると、プラットフォームごとにテストが必要になり、shim の「薄いグルー」としての利点が失われる。

```typescript
// Bad: shim 内にロジック
export class DefaultJsonSchemaValidator {
    private ajv?: Ajv;
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
        if (!this.ajv) this.ajv = new Ajv({ strict: false });
        // ... バリデーションロジック
    }
}

// Better: shim は re-export のみ、ロジックは別ファイルに
export { AjvJsonSchemaValidator as DefaultJsonSchemaValidator } from '@my-package/core';
```

- **コアモジュールから Node.js 固有 API を直接インポート**: コアで `node:http` や `node:fs` を直接 import すると、Web Standard ランタイムではモジュール解決に失敗する。Node.js 固有 API は shim またはアダプターパッケージに隔離すべき。

```typescript
// Bad: コアモジュール内で Node.js API を直接使用
import { createServer } from 'node:http';

// Better: コアは Web Standard API のみ使用し、Node.js 固有はアダプターに分離
// core: Request/Response ベースの実装
// adapter: @hono/node-server の getRequestListener で変換
```

## 導出ルール

- `[MUST]` マルチランタイム対応のプラットフォーム差異は package.json の条件付きエクスポート（export conditions）で静的に解決し、実行時のランタイム検出分岐を避ける
  - 根拠: 本リポジトリの `_shims` サブパスエクスポートにより、`workerd`/`browser`/`node`/`default` 条件でバリデーター実装を切り替えており、tree-shaking と型安全性を両立している (`packages/server/package.json:29-46`)

- `[MUST]` shim ファイルは re-export またはスタブの提供のみに徹し、ビジネスロジックやデータ変換を含めない
  - 根拠: 本リポジトリの 4 つの shim ファイルはすべて 2-23 行で、re-export か最小限のスタブのみ。ロジックは core パッケージの実装クラスに集約されている (`packages/server/src/shimsNode.ts`, `packages/server/src/shimsWorkerd.ts`)

- `[SHOULD]` マルチランタイムライブラリのコアは Web Standard API (`Request`/`Response`/`ReadableStream`/`fetch`) で実装し、ランタイム固有 API はアダプター層に隔離する
  - 根拠: `WebStandardStreamableHTTPServerTransport` は Web Standard API のみで実装され、Node.js 固有の `IncomingMessage`/`ServerResponse` 変換は `@modelcontextprotocol/node` パッケージが担当する (`packages/server/src/server/streamableHttp.ts:1-8`)

- `[SHOULD]` 非サポート機能のスタブには、代替手段を案内する明確なエラーメッセージを含める
  - 根拠: workerd 用 shim の `process` スタブは `'StdioServerTransport is not supported in this environment. Use StreamableHTTPServerTransport instead.'` と代替を明示している (`packages/server/src/shimsWorkerd.ts:13`)

- `[SHOULD]` ランタイム差異の各層（shim / アダプター / ミドルウェア）は責務を明確に分離し、差異の性質に応じて適切な層で対処する
  - 根拠: バリデーター切替は shim 層、HTTP 変換はアダプター層（`@modelcontextprotocol/node`）、フレームワーク統合はミドルウェア層（express / hono パッケージ）と 3 層に分離されている

- `[SHOULD]` shim を含むパッケージのビルド設定では、自パッケージの shim インポートを external に指定し、ランタイムの条件付きエクスポート解決に委ねる
  - 根拠: `tsdown.config.ts` で `external: ['@modelcontextprotocol/server/_shims']` とし、バンドラーが shim を内包せずランタイム解決させている (`packages/server/tsdown.config.ts:36`)

- `[AVOID]` コアパッケージから `node:` プレフィックス付きモジュールを実行時インポートする（`import type` による型のみのインポートは許容）
  - 根拠: コアの `shared/` や `validation/` には `node:` インポートが存在せず、Node.js 依存は server パッケージの `stdio.ts` に限定。`stdio.ts` も `process` は shim 経由、`node:stream` は `import type` のみで実行時依存を回避している

## 適用チェックリスト

- [ ] プラットフォーム差異のある依存関係（バリデーター、暗号、ファイルシステム等）を洗い出し、共通インターフェースを定義したか
- [ ] shim ファイルを作成し、各ランタイム向けの実装を re-export のみで橋渡ししているか
- [ ] package.json に条件付きエクスポート（`exports` フィールドの `node`/`workerd`/`browser`/`default` 条件）を定義したか
- [ ] ビルドツール（tsdown / rollup / esbuild 等）の設定で shim インポートを `external` に指定し、バンドルに含めないようにしたか
- [ ] コアモジュールが Web Standard API のみに依存しているか確認し、`node:` プレフィックス付きモジュールの実行時インポートがないか検証したか
- [ ] Node.js 固有 API（`IncomingMessage`/`ServerResponse` 等）を使う必要がある場合、別パッケージ（アダプター）に分離したか
- [ ] 非サポート環境でアクセスされるスタブに、代替手段を案内するエラーメッセージを含めたか
- [ ] ランタイム固有の依存関係を optional peer dependency として宣言し、不要な環境ではインストールを回避できるようにしたか
- [ ] 各ターゲットランタイム（Node.js / Cloudflare Workers 等）でインテグレーションテストを実行し、shim の解決が正しく行われることを検証したか
