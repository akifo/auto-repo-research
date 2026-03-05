# Practice: Optional Peer + Lazy Load

> 出典: [repos/nestjs/nest](../repos/nestjs/nest/)（主要）, [pmndrs/zustand](https://github.com/pmndrs/zustand), [openclaw/openclaw](https://github.com/openclaw/openclaw), [repos/cloudflare/agents](../repos/cloudflare/agents/)
> カテゴリ: practice

## 概要

`peerDependencies` + `peerDependenciesMeta(optional: true)` でオプショナル依存を宣言し、統一された遅延ローダーで実行時にのみ解決するパターン。ユーザは実際に使う機能の依存だけをインストールすればよく（"install what you use"）、不要な依存がインストールツリーを肥大化させることを防ぐ。4 つのリポジトリが異なる粒度でこのパターンを実践しており、パッケージ宣言・遅延ロード・エラーメッセージ・バンドラー対策の各層で共通する設計判断を抽出する。

## 背景・文脈

多機能なパッケージは多数の外部ライブラリに依存しがちだが、全ユーザが全機能を使うわけではない。たとえば NestJS のマイクロサービスパッケージは Redis・Kafka・gRPC・MQTT など 7 種のトランスポートをサポートするが、個々のプロジェクトが使うのは通常 1-2 種だけである。全てを `dependencies` に入れると、不要なネイティブバイナリやランタイムまでインストールされてしまう。

この問題に対する各リポジトリのアプローチ:

- **nestjs/nest**: 30 箇所以上で使われる `loadPackage` ユーティリティにより、全トランスポートとバリデーションライブラリを統一的に遅延ロード
- **pmndrs/zustand**: React 自体を optional peer にし、`zustand/vanilla` エントリで React 非依存の利用を可能に
- **openclaw/openclaw**: ネイティブバイナリ（`@napi-rs/canvas`, `node-llama-cpp`）を peer + 動的 `import()` で遅延ロードし、非対応プラットフォームでも主機能は動作
- **cloudflare/agents**: サブパスエクスポート（`agents/react`, `agents/x402`）で optional peer を機能単位に分離

## 実装パターン

### 1. package.json での宣言（npm レイヤー）

optional peer の宣言は `peerDependencies` と `peerDependenciesMeta` の組み合わせで行う。これにより `npm install` 時に警告が出ず、依存の意図（「使うなら入れてね」）が明確になる。

```json
// nestjs/nest: packages/microservices/package.json:28-71
"peerDependencies": {
  "@grpc/grpc-js": "*",
  "@nestjs/common": "^11.0.0",
  "@nestjs/core": "^11.0.0",
  "ioredis": "*",
  "kafkajs": "*",
  "mqtt": "*",
  "nats": "*"
},
"peerDependenciesMeta": {
  "@grpc/grpc-js": { "optional": true },
  "kafkajs": { "optional": true },
  "mqtt": { "optional": true },
  "nats": { "optional": true },
  "ioredis": { "optional": true }
}
```

zustand は React 自体を optional peer にする大胆な設計で、バニラ JS 環境でも利用可能にしている:

```json
// pmndrs/zustand: package.json:160-179
"peerDependencies": {
  "@types/react": ">=18.0.0",
  "immer": ">=9.0.6",
  "react": ">=18.0.0",
  "use-sync-external-store": ">=1.2.0"
},
"peerDependenciesMeta": {
  "@types/react": { "optional": true },
  "immer": { "optional": true },
  "react": { "optional": true },
  "use-sync-external-store": { "optional": true }
}
```

### 2. 統一遅延ローダー（ランタイムレイヤー）

NestJS の `loadPackage` は 20 行未満の関数だが、コードベース全体のオプショナル依存ロードを統一する要である:

```typescript
// nestjs/nest: packages/common/utils/load-package.util.ts:1-20
const MISSING_REQUIRED_DEPENDENCY = (name: string, reason: string) =>
  `The "${name}" package is missing. Please, make sure to install it to take advantage of ${reason}.`;

const logger = new Logger("PackageLoader");

export function loadPackage(
  packageName: string,
  context: string,
  loaderFn?: Function,
) {
  try {
    return loaderFn ? loaderFn() : require(packageName);
  } catch (e) {
    logger.error(MISSING_REQUIRED_DEPENDENCY(packageName, context));
    Logger.flush();
    process.exit(1);
  }
}
```

設計上の 3 つのポイント:

1. **`loaderFn` の間接参照**: `require(packageName)` を直接呼ぶのではなく `() => require('ioredis')` のようなクロージャを渡す。バンドラーが静的解析でパッケージ名を検出してしまう問題を回避する
2. **`context` パラメータ**: エラーメッセージに「どの機能が依存を必要としているか」を含め、ユーザにとってアクショナブルなエラーにする
3. **早期失敗**: フレームワーク起動時の必須依存欠落は回復不能と判断し、`process.exit(1)` で即座にフィードバック

### 3. モジュールスコープ変数 + コンストラクタ初期化

ロード結果の格納は NestJS 全体で統一されたパターンに従う:

```typescript
// nestjs/nest: packages/microservices/client/client-redis.ts:12-42
// To enable type safety for Redis. This cant be uncommented by default
// because it would require the user to install the ioredis package even if they dont use Redis
//
// type Redis = import('ioredis').Redis;
type Redis = any;

let redisPackage = {} as any;

export class ClientRedis extends ClientProxy<RedisEvents, RedisStatus> {
  constructor(protected readonly options: Required<RedisOptions>['options']) {
    super();
    redisPackage = loadPackage('ioredis', ClientRedis.name, () =>
      require('ioredis'),
    );
    // ...
  }
```

### 4. ESM 環境での非同期遅延ロード（openclaw）

ESM 環境ではネイティブバイナリの遅延ロードに動的 `import()` を使い、Promise キャッシュで重複ロードを防ぐ:

```typescript
// openclaw/openclaw: src/media/input-files.ts:7-24
type CanvasModule = typeof import("@napi-rs/canvas");

let canvasModulePromise: Promise<CanvasModule> | null = null;

// Lazy-load optional PDF/image deps so non-PDF paths don't require native installs.
async function loadCanvasModule(): Promise<CanvasModule> {
  if (!canvasModulePromise) {
    canvasModulePromise = import("@napi-rs/canvas").catch((err) => {
      canvasModulePromise = null;
      throw new Error(
        `Optional dependency @napi-rs/canvas is required for PDF image extraction: ${String(err)}`,
      );
    });
  }
  return canvasModulePromise;
}
```

openclaw はさらに、動的 import のモック容易性のため 1 行のラッパー関数を用意している:

```typescript
// openclaw/openclaw: src/memory/node-llama.ts:1-3
export async function importNodeLlamaCpp() {
  return import("node-llama-cpp");
}
```

### 5. サブパスエクスポートによる機能分離（cloudflare/agents）

cloudflare/agents は optional peer を機能単位のサブパスに対応させている。`agents/react` をインポートするユーザだけが React を、`agents/x402` をインポートするユーザだけが `@x402/core` を必要とする:

```json
// cloudflare/agents: packages/agents/package.json:63-84,87-177 (抜粋)
"peerDependenciesMeta": {
  "@ai-sdk/react": { "optional": true },
  "@x402/core": { "optional": true },
  "@x402/evm": { "optional": true },
  "viem": { "optional": true }
},
"exports": {
  ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./react": { "types": "./dist/react.d.ts", "import": "./dist/react.js" },
  "./x402": { "types": "./dist/mcp/x402.d.ts", "import": "./dist/mcp/x402.js" }
}
```

## Good Example

### 統一ローダーによる一貫性（nestjs/nest）

全てのオプショナル依存を同一のローダー関数に通すことで、エラーメッセージの形式・ロギング・失敗時の挙動が統一される:

```typescript
// nestjs/nest: packages/microservices/client/client-redis.ts:40-42
redisPackage = loadPackage('ioredis', ClientRedis.name, () =>
  require('ioredis'),
);

// nestjs/nest: packages/common/pipes/validation.pipe.ts:91-100
protected loadValidator(
  validatorPackage?: ValidatorPackage,
): ValidatorPackage {
  return (
    validatorPackage ??
    loadPackage('class-validator', 'ValidationPipe', () =>
      require('class-validator'),
    )
  );
}
```

`ValidationPipe` はさらにインターフェースを介して代替パッケージの注入も可能にしている:

```typescript
// nestjs/nest: packages/common/interfaces/external/validator-package.interface.ts:4-9
export interface ValidatorPackage {
  validate(
    object: unknown,
    validatorOptions?: ValidatorOptions,
  ): ValidationError[] | Promise<ValidationError[]>;
}
```

### 段階的なエラーメッセージ（openclaw/openclaw）

ネイティブバイナリの欠落は原因が多岐にわたる（未インストール、ビルド失敗、プラットフォーム非対応）。openclaw はエラー種別を判定し、段階的な解決手順を提示する:

```typescript
// openclaw/openclaw: src/memory/embeddings.ts:234-257
function formatLocalSetupError(err: unknown): string {
  const detail = formatErrorMessage(err);
  const missing = isNodeLlamaCppMissing(err);
  return [
    "Local embeddings unavailable.",
    missing
      ? "Reason: optional dependency node-llama-cpp is missing (or failed to install)."
      : detail
      ? `Reason: ${detail}`
      : undefined,
    "To enable local embeddings:",
    "1) Use Node 22 LTS (recommended for installs/updates)",
    missing
      ? "2) Reinstall OpenClaw (this should install node-llama-cpp): npm i -g openclaw@latest"
      : null,
    "3) If you use pnpm: pnpm approve-builds (select node-llama-cpp), then pnpm rebuild node-llama-cpp",
    ...REMOTE_EMBEDDING_PROVIDER_IDS.map(
      (provider) => `Or set agents.defaults.memorySearch.provider = "${provider}" (remote).`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}
```

### コア機能を optional peer に依存させない設計（zustand）

zustand のコアストア（`vanilla.ts`）は React を一切 import せず、純粋な状態管理ロジックのみで構成される。React バインディング（`react.ts`）は別エントリポイントとして分離されている:

```typescript
// pmndrs/zustand: src/vanilla.ts:60-100 (React に依存しないコア)
const createStoreImpl: CreateStoreImpl = (createState) => {
  type TState = ReturnType<typeof createState>;
  type Listener = (state: TState, prevState: TState) => void;
  let state: TState;
  const listeners: Set<Listener> = new Set();

  const setState: StoreApi<TState>["setState"] = (partial, replace) => {
    const nextState = typeof partial === "function"
      ? (partial as (state: TState) => TState)(state)
      : partial;
    if (!Object.is(nextState, state)) {
      const previousState = state;
      state = (replace ?? (typeof nextState !== "object" || nextState === null))
        ? (nextState as TState)
        : Object.assign({}, state, nextState);
      listeners.forEach((listener) => listener(state, previousState));
    }
  };
  // ...
};

// pmndrs/zustand: src/index.ts:1-2 (React ありの場合はこちらから使う)
export * from "./react.ts";
export * from "./vanilla.ts";
```

## Bad Example

### ローダーを統一せず場所ごとに try/catch を書く

```typescript
// Bad: ロード処理が散在し、エラーメッセージの形式がバラバラ
class ClientRedis {
  constructor() {
    try {
      this.redis = require("ioredis");
    } catch {
      throw new Error("ioredis not found"); // 情報不足: 何のために必要かが不明
    }
  }
}

class ClientKafka {
  constructor() {
    try {
      this.kafka = require("kafkajs");
    } catch {
      console.log("kafkajs is needed"); // ログレベルも形式も不統一
      process.exit(1);
    }
  }
}
```

```typescript
// Good: 統一ローダーでエラー形式・ロギング・失敗挙動を集約（NestJS 方式）
// loadPackage('ioredis', ClientRedis.name, () => require('ioredis'))
// loadPackage('kafkajs', ClientKafka.name, () => require('kafkajs'))
// -> 全て同一形式:
//    The "ioredis" package is missing. Please, make sure to install it
//    to take advantage of ClientRedis.
```

### バンドラーが静的解析で optional 依存を巻き込む

```typescript
// Bad: バンドラーが 'ioredis' を必須依存として検出してしまう
function loadPackage(packageName: string) {
  try {
    return require(packageName); // webpack/esbuild は動的 require を解析できない場合がある
  } catch (e) { /* ... */ }
}

// Good: クロージャで渡すことで静的解析を回避（NestJS 方式）
loadPackage("ioredis", ClientRedis.name, () => require("ioredis"));
//                                        ^^^^^^^^^^^^^^^^^^^^^^
//                     バンドラーはこのクロージャを optional として扱える
```

### 型定義で any を使い、理由も正しい型も残さない

```typescript
// Bad: なぜ any なのか、本来の型は何か、全く分からない
let redis: any;
let grpc: any;
```

```typescript
// Good: コメントで正しい型と理由を文書化（NestJS 方式）
// nestjs/nest: packages/microservices/server/server-grpc.ts:33-43
// To enable type safety for gRPC. This cant be uncommented by default
// because it would require the user to install the @grpc/grpc-js package
// even if they dont use gRPC
//
// type GrpcServer = import('@grpc/grpc-js').Server;
// let grpcPackage = {} as typeof import('@grpc/grpc-js');

type GrpcServer = any;
let grpcPackage = {} as any;
```

## 適用ガイド

### どのような状況で使うべきか

- パッケージが複数のバックエンド/アダプタ/プラットフォームをサポートし、ユーザが一部だけを選択する場合（NestJS のトランスポート、zustand の React バインディング）
- ネイティブバイナリを含む依存があり、プラットフォームによってはインストールできない場合（openclaw の `@napi-rs/canvas`, `node-llama-cpp`）
- 単一パッケージで提供するが、機能ごとに必要な依存が異なる場合（cloudflare/agents の react/x402）

### 導入時の注意点

- **`process.exit` vs 例外**: NestJS はフレームワークとして `process.exit` を採用しているが、ライブラリとして使われるコードでは例外の方がテストしやすく、呼び出し側で回復の余地がある。openclaw のように例外 + 段階的エラーメッセージの方が汎用性が高い
- **モジュールスコープ変数のトレードオフ**: NestJS の `let redisPackage = {} as any` パターンはシンプルだが、同一モジュールから複数インスタンスを生成すると最後のロード結果が全インスタンスで共有される。テスト容易性を重視するならインスタンスプロパティに格納する
- **型の ambient 宣言**: openclaw は `declare module` で optional 依存の最小限の型定義を維持している（`src/types/node-llama-cpp.d.ts`）。NestJS のコメント方式と比べてコンパイラが型を認識するため、`import type` が使える利点がある

### カスタマイズポイント

- **エラーメッセージのテンプレート**: NestJS の `MISSING_REQUIRED_DEPENDENCY` のような標準テンプレートをプロジェクトに合わせてカスタマイズする。最低限「パッケージ名」「何のために必要か」「インストールコマンド」を含める
- **ロード失敗時の挙動**: `process.exit`（NestJS）、例外送出（openclaw）、フォールバック（openclaw の embedding provider）の 3 段階から選択する
- **ESM vs CJS**: CJS 環境なら `() => require('pkg')` のクロージャ形式（NestJS）、ESM 環境なら動的 `import()` + Promise キャッシュ形式（openclaw）を使い分ける

## 参考

- [repos/nestjs/nest/dependency-management.md](../repos/nestjs/nest/dependency-management.md) -- 元の分析
- [pmndrs/zustand package.json](https://github.com/pmndrs/zustand/blob/main/package.json) -- optional peerDependencies の宣言
- [openclaw/openclaw src/media/input-files.ts](https://github.com/openclaw/openclaw/blob/main/src/media/input-files.ts) -- ESM 遅延ロードパターン
- [cloudflare/agents packages/agents/package.json](https://github.com/cloudflare/agents/blob/main/packages/agents/package.json) -- サブパスエクスポートとの組み合わせ
