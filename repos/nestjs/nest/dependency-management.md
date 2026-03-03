# dependency-management

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS は Lerna によるロックステップバージョニングのモノレポで 9 パッケージを管理し、パッケージ間の依存を peerDependencies + peerDependenciesMeta(optional) の組み合わせで宣言する戦略を採っている。特筆すべきは、オプショナルな外部ライブラリを `loadPackage` ユーティリティで遅延ロードし、コンストラクタ実行時まで依存の解決を遅延させるパターンが全パッケージに渡って一貫して適用されている点である。この設計により、ユーザは使用するトランスポートやバリデーションライブラリだけをインストールすればよく、不要な依存がインストールツリーを肥大化させることを防いでいる。

## 背景にある原則

- **Install-what-you-use 原則**: フレームワークの全機能を使うために全依存をインストールさせるのではなく、ユーザが実際に使う機能の依存だけを要求すべき。根拠: `@nestjs/microservices` は 7 種のトランスポート（Redis, MQTT, NATS, Kafka, gRPC, RabbitMQ, TCP）を単一パッケージで提供するが、全てを peerDependenciesMeta で optional 指定し、使用時に `loadPackage` で動的ロードする（`packages/microservices/package.json`）
- **コンパイル時型安全とランタイム柔軟性の分離**: オプショナル依存の型情報は TypeScript コンパイル時には `any` にフォールバックさせ、ランタイムでのみ実体を解決する。型安全を完全に捨てるのではなく、コメントで正しい型定義を残して将来の復元可能性を保つ（`packages/microservices/server/server-grpc.ts:33-43`）
- **デフォルト実装の遅延バインディング**: プラットフォームアダプタ（Express/Fastify, Socket.io/WS）はデフォルト実装を持つが、その解決をファクトリメソッド実行時まで遅延させることで、ユーザが代替実装を差し込む余地を残す（`packages/core/nest-factory.ts:318-324`）

## 実例と分析

### Lerna ロックステップバージョニングと一括パブリッシュ

全 9 パッケージが `lerna.json` の `"version": "11.1.14"` で単一バージョンを共有する。パブリッシュコマンドでは `--force-publish --exact` フラグにより、変更がないパッケージも含めて全パッケージを同一バージョンで公開する。

```json
// package.json:45
"publish": "npm run prerelease && npm run build:prod && ./node_modules/.bin/lerna publish --force-publish --exact -m \"chore(release): publish %s release\""
```

ベータ・RC・テスト版には `--npm-tag` で dist-tag を分離し、安定版のインストールに影響を与えない。

```json
// package.json:47-50
"publish:beta": "... lerna publish --npm-tag=beta ...",
"publish:next": "... lerna publish --npm-tag=next --skip-git ...",
"publish:rc": "... lerna publish --npm-tag=rc ..."
```

### パッケージ間依存の階層構造

パッケージ間の依存は peerDependencies で宣言し、ビルド時は TypeScript Project References + paths で解決する明確な二層構造になっている。

**ランタイム依存（package.json）**:
- `@nestjs/common` は最下層で peer を持たない（rxjs, reflect-metadata のみ）
- `@nestjs/core` は `@nestjs/common` を peer + devDependencies で参照
- `@nestjs/microservices` は `@nestjs/common` + `@nestjs/core` を peer で参照
- platform パッケージは `@nestjs/common` + `@nestjs/core` を peer で参照

**ビルド時依存（tsconfig.build.json）**:

```json
// packages/core/tsconfig.build.json:6-13
"paths": {
  "@nestjs/common": ["../common"],
  "@nestjs/common/*": ["../common/*"],
  "@nestjs/microservices": ["../microservices"],
  "@nestjs/microservices/*": ["../microservices/*"],
  "@nestjs/websockets": ["../websockets"],
  "@nestjs/websockets/*": ["../websockets/*"]
},
"references": [
  { "path": "../common/tsconfig.build.json" }
]
```

注目すべきは `@nestjs/core` の tsconfig が `@nestjs/microservices` と `@nestjs/websockets` を paths に含めつつ、references には `common` しか入れていない点。これはオプショナルな参照（ランタイムで loadPackage で解決する）をコンパイル時には型解決だけ提供する構成である。

### loadPackage: 統一的な遅延ロードユーティリティ

`loadPackage` は全てのオプショナル依存のロードに使用される 20 行未満の関数で、コードベース全体で 30 箇所以上呼び出される。

```typescript
// packages/common/utils/load-package.util.ts:1-20
const MISSING_REQUIRED_DEPENDENCY = (name: string, reason: string) =>
  `The "${name}" package is missing. Please, make sure to install it to take advantage of ${reason}.`;

const logger = new Logger('PackageLoader');

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

設計判断のポイント:
1. **loaderFn の間接参照**: `require(packageName)` を直接呼ぶのではなく、`() => require('ioredis')` のようなクロージャを渡す。これにより、バンドラーが静的解析でパッケージ名を検出してしまう問題を回避できる
2. **process.exit(1) による早期失敗**: 依存が見つからない場合は例外ではなくプロセス終了で対応する。フレームワーク起動時の必須依存欠落は回復不能という判断
3. **context パラメータ**: エラーメッセージにどの機能が依存を必要としているかを含め、ユーザにとってアクショナブルなエラーにしている

### モジュールスコープ変数パターン

オプショナル依存のロード結果はモジュールスコープの `let` 変数に格納し、クラスのコンストラクタで初期化するパターンが一貫して使われている。

```typescript
// packages/microservices/client/client-redis.ts:19-42
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

初期値を `{}` にすることで、ロード前にプロパティアクセスしても undefined ではなく空オブジェクトに対する操作になり、エラーメッセージが分かりやすくなる。

### コメントによる正しい型定義の保存

オプショナル依存の型を `any` にフォールバックさせる際、コメントアウトされた正しい import 型を必ず残している。

```typescript
// packages/microservices/server/server-grpc.ts:33-43
// To enable type safety for gRPC. This cant be uncommented by default
// because it would require the user to install the @grpc/grpc-js package even if they dont use gRPC
// Otherwise, TypeScript would fail to compile the code.
//
// type GrpcServer = import('@grpc/grpc-js').Server;
// let grpcPackage = {} as typeof import('@grpc/grpc-js');
// let grpcProtoLoaderPackage = {} as typeof import('@grpc/proto-loader');

type GrpcServer = any;
let grpcPackage = {} as any;
let grpcProtoLoaderPackage = {} as any;
```

このパターンは `server-redis.ts`, `server-nats.ts`, `server-mqtt.ts`, `server-rmq.ts`, `client-redis.ts`, `client-mqtt.ts`, `client-nats.ts`, `client-rmq.ts`, `client-grpc.ts` の全トランスポート実装で統一的に適用されている。

### インターフェースによる外部パッケージの抽象化

`class-validator` と `class-transformer` のようなオプショナル依存に対して、NestJS は自前のインターフェースを定義し、パッケージの具体的な型に依存しない。

```typescript
// packages/common/interfaces/external/validator-package.interface.ts:4-9
export interface ValidatorPackage {
  validate(
    object: unknown,
    validatorOptions?: ValidatorOptions,
  ): ValidationError[] | Promise<ValidationError[]>;
}
```

```typescript
// packages/common/interfaces/external/transformer-package.interface.ts:4-14
export interface TransformerPackage {
  plainToInstance<T>(cls: Type<T>, plain: unknown, options?: ClassTransformOptions): T | T[];
  classToPlain(object: unknown, options?: ClassTransformOptions): Record<string, any> | Record<string, any>[];
}
```

これにより `ValidationPipe` はコンストラクタで代替パッケージを注入可能になっている:

```typescript
// packages/common/pipes/validation.pipe.ts:91-110
protected loadValidator(validatorPackage?: ValidatorPackage): ValidatorPackage {
  return (
    validatorPackage ??
    loadPackage('class-validator', 'ValidationPipe', () =>
      require('class-validator'),
    )
  );
}
```

### loadAdapter: プラットフォームアダプタの遅延解決

`loadAdapter` は `loadPackage` と同じ構造だが、エラーメッセージがプラットフォーム選択に特化している。NestFactory がデフォルトの Express アダプタを、SocketModule がデフォルトの Socket.io アダプタを解決する際に使用される。

```typescript
// packages/core/helpers/load-adapter.ts:3-7
const MISSING_REQUIRED_DEPENDENCY = (
  defaultPlatform: string,
  transport: string,
) =>
  `No driver (${transport}) has been selected. In order to take advantage of the default driver, please, ensure to install the "${defaultPlatform}" package ($ npm install ${defaultPlatform}).`;
```

### ESM パッケージの動的ロード

CJS 環境から ESM-only パッケージ（`file-type`）をロードする必要がある場合は、`load-esm` ライブラリを使って動的 import を行う。

```typescript
// packages/common/pipes/file/file-type.validator.ts:127-135
let fileTypeModule: string;
try {
  const resolvedPath = require.resolve('file-type');
  fileTypeModule = pathToFileURL(resolvedPath).href;
} catch {
  fileTypeModule = 'file-type';
}
const { fileTypeFromBuffer } =
  await loadEsm<typeof import('file-type')>(fileTypeModule);
```

### Renovate による依存更新自動化

devDependencies の更新は Renovate Bot で自動マージされ、本番依存の更新は手動レビューを通す設定になっている。

```json
// renovate.json:1-10
{
  "extends": ["config:base", ":dependencyDashboard"],
  "labels": ["dependencies"],
  "packageRules": [
    {
      "matchDepTypes": ["devDependencies"],
      "automerge": true
    }
  ]
}
```

## パターンカタログ

- **Lazy Loading / Virtual Proxy** (分類: 構造)
  - 解決する問題: オプショナル依存をインストールしていないユーザがフレームワーク全体を使えなくなる
  - 適用条件: 外部パッケージが機能の一部にのみ必要で、全ユーザに必須ではない場合
  - コード例: `packages/common/utils/load-package.util.ts:8-20`
  - 注意点: ロード失敗時の挙動（process.exit vs throw）はアプリケーション特性に合わせて選択する

- **Strategy Pattern** (分類: 振る舞い)
  - 解決する問題: 同一インターフェースで複数の実装（Express/Fastify, Socket.io/WS, Redis/NATS/Kafka 等）を切り替える
  - 適用条件: 同一の契約を満たす複数の実装が存在し、ユーザが選択する場合
  - コード例: `packages/common/interfaces/external/validator-package.interface.ts`, `packages/common/interfaces/external/transformer-package.interface.ts`
  - 注意点: インターフェースは必要最小限のメソッドだけを定義し、外部パッケージの全 API を写し取らない

## Good Patterns

- **統一ローダー関数によるオプショナル依存の集約**: 全てのオプショナル依存ロードを `loadPackage` の 1 関数に集約し、エラーメッセージ形式・ロギング・失敗時の挙動を統一している。30 箇所以上の呼び出しが同一のパターンに従うため、新しいトランスポートやプラグインの追加時に迷いがない。

```typescript
// packages/microservices/client/client-kafka.ts:121
kafkaPackage = loadPackage('kafkajs', ClientKafka.name, () =>
  require('kafkajs'),
);

// packages/platform-fastify/adapters/fastify-adapter.ts:560
loadPackage('@fastify/static', 'FastifyAdapter.useStaticAssets()', () =>
  require('@fastify/static'),
)
```

- **コメントアウトされた型情報による意図の文書化**: `type Redis = any` の直上に `// type Redis = import('ioredis').Redis;` を残すことで、(1) なぜ any を使っているかの理由、(2) 将来型安全化する際の正しい型、(3) コード検索で元のパッケージを特定可能にしている。

```typescript
// packages/microservices/client/client-rmq.ts:37-46
// To enable type safety for RMQ. This cant be uncommented by default
// because it would require the user to install the amqplib package even if they dont use RabbitMQ
//
// type Channel = import('amqplib').Channel | import('amqplib').ConfirmChannel;

type Channel = any;
type ChannelWrapper = any;
```

- **loaderFn クロージャによるバンドラー対策**: `require(packageName)` を直接呼ぶ代わりに `() => require('ioredis')` を渡すことで、webpack/esbuild 等のバンドラーが静的解析でオプショナルパッケージを必須依存と誤認することを防いでいる。

## Anti-Patterns / 注意点

- **モジュールスコープ変数の再代入による暗黙の状態共有**: `let grpcPackage = {} as any` がモジュールスコープで宣言され、コンストラクタで再代入される。同一モジュールから複数インスタンスを生成した場合、最後にロードされたパッケージが全インスタンスで共有される。単一トランスポートでは問題にならないが、異なるバージョンのパッケージを同一プロセスで使いたい場合は破綻する。

```typescript
// Bad: モジュールスコープの再代入
let redisPackage = {} as any;
class ClientRedis {
  constructor() {
    redisPackage = loadPackage('ioredis', ...);
  }
  connect() {
    // redisPackage は最後のインスタンスが設定した値
  }
}

// Better: インスタンスに閉じたロード（テスト容易性も向上）
class ClientRedis {
  private readonly redisPackage: any;
  constructor() {
    this.redisPackage = loadPackage('ioredis', ...);
  }
}
```

NestJS では全トランスポートが同一バージョンで使われる前提のため、パフォーマンスとシンプルさを優先してモジュールスコープを採用している。

- **process.exit によるエラーハンドリング**: `loadPackage` は依存が見つからない場合 `process.exit(1)` を呼ぶため、テスト時にパッケージ不在をシミュレートしにくい。ライブラリとして使われるコードでは例外送出のほうが扱いやすい。

## 導出ルール

- `[MUST]` モノレポで密結合したパッケージ群は lockstep バージョニングを採用し、`--force-publish --exact` で全パッケージを同一バージョンでリリースする
  - 根拠: nestjs/nest は 9 パッケージを常に同一バージョンで公開し、peerDependencies の `^11.0.0` レンジで互換性を保証している（`lerna.json`, `package.json:45`）
- `[MUST]` オプショナル依存を遅延ロードする場合、ロード関数を 1 箇所に集約し、エラーメッセージに「どのパッケージを」「なぜインストールすべきか」を含める
  - 根拠: `loadPackage` が 30 箇所以上で一貫したエラー形式を提供し、ユーザが即座にアクションを取れる（`packages/common/utils/load-package.util.ts:3-4`）
- `[SHOULD]` peerDependencies + peerDependenciesMeta(optional: true) の組み合わせで「使わないならインストール不要」を npm の仕組みで表現する
  - 根拠: `@nestjs/microservices` は 7 種のトランスポートライブラリを全て optional peer で宣言し、npm install 時の警告を抑制しつつ依存の意図を明示している（`packages/microservices/package.json`）
- `[SHOULD]` オプショナル依存の型を `any` にフォールバックさせる際、コメントで正しい型定義を残し「なぜ any か」の理由を明記する
  - 根拠: 全トランスポート実装（10 ファイル以上）で `// type Redis = import('ioredis').Redis` の形式が統一的に使用されている（`packages/microservices/server/server-grpc.ts:33-43`）
- `[SHOULD]` 外部パッケージに依存する機能には自前のインターフェースを定義し、代替実装の注入を可能にする
  - 根拠: `ValidatorPackage` / `TransformerPackage` インターフェースにより、`class-validator` 以外のバリデーションライブラリへの差し替えが可能（`packages/common/interfaces/external/`）
- `[SHOULD]` devDependencies の更新は Renovate/Dependabot で自動マージし、本番依存は手動レビューを通す
  - 根拠: `renovate.json` で `matchDepTypes: devDependencies` のみ `automerge: true` に設定（`renovate.json:4-8`）
- `[AVOID]` `require(dynamicString)` を直接使わず、`() => require('package-name')` のクロージャ形式で渡してバンドラーの静的解析による誤検出を防ぐ
  - 根拠: 全ての `loadPackage` 呼び出しが第 3 引数に `loaderFn` を渡す形式を採用している（`packages/microservices/client/client-redis.ts:40-42`）

## 適用チェックリスト

- [ ] モノレポ内のパッケージ間依存が peerDependencies で宣言され、バージョンレンジが適切に設定されているか
- [ ] オプショナルな外部依存に peerDependenciesMeta の `optional: true` が設定されているか
- [ ] オプショナル依存のロード処理が統一されたユーティリティ関数に集約されているか
- [ ] ロード失敗時のエラーメッセージに、パッケージ名とインストールコマンドが含まれているか
- [ ] `any` 型にフォールバックしたオプショナル依存の正しい型がコメントで文書化されているか
- [ ] バンドラー環境でオプショナル依存がバンドルに含まれないことを確認したか（loaderFn 形式の使用）
- [ ] Renovate/Dependabot が設定され、devDependencies の自動マージと本番依存の手動レビューが分離されているか
- [ ] lockstep バージョニングの場合、リリーススクリプトに `--force-publish` が含まれているか
