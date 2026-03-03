# transport-layer-abstraction

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS のマイクロサービスモジュール (`packages/microservices/`) は、7 つのトランスポートプロトコル（TCP, Redis, NATS, MQTT, Kafka, gRPC, RabbitMQ）を単一の抽象レイヤーで統合している。注目すべきは、ハンドラ側のコードがトランスポートに依存しない形で書ける設計と、シリアライゼーション・デシリアライゼーションが差し替え可能な Strategy として分離されている点である。各プロトコルの「癖」（Kafka のパーティション、gRPC のストリーミング、MQTT/RMQ のワイルドカード）を吸収しつつ、共通のメッセージングモデルを維持するバランスが実践的な教材となる。

## 背景にある原則

- **統一メッセージ契約で交換可能性を確保する**: `ReadPacket` / `WritePacket` という最小限のメッセージ契約を定義し、すべてのトランスポートがこの型を通じてデータをやり取りする。これにより、ハンドラ側のコードはトランスポートを意識せずに書ける。根拠: `interfaces/packet.interface.ts` の `ReadPacket<T>` / `WritePacket<T>` が 6 行で全トランスポート共通のデータ型を定義している。

- **プロトコル固有の知識は境界に押し出す**: トランスポート固有の処理（接続管理、メッセージの subscribe/publish、ワイルドカードマッチング等）は各 Server/Client サブクラスに封じ込め、抽象基底クラスにはトランスポート非依存のロジックのみを置く。これにより、新しいトランスポートの追加が既存コードに影響しない。

- **外部依存はオプショナルな遅延ロードにする**: 各トランスポートが依存する npm パッケージ（ioredis, nats, kafkajs, mqtt, amqplib 等）はコンパイル時に必須としない。`loadPackage()` で実行時に遅延読み込みし、型安全性はコメントアウトされた型定義で開発者に示唆する。これにより、使わないトランスポートの依存を強制しない。

- **メッセージ形式の変換責務をシリアライザに委譲する**: 各トランスポートは独自のシリアライザ/デシリアライザを持ち、ユーザーがカスタム実装で差し替えられる。`Serializer<TInput, TOutput>` / `Deserializer<TInput, TOutput>` の汎用インターフェースにより、JSON 以外のフォーマット（Protocol Buffers、MessagePack 等）への拡張が容易になる。

## 実例と分析

### 1. 二層の抽象基底クラス: Server と ClientProxy

サーバー側の `Server` 抽象クラスはすべてのトランスポートサーバーの基底となり、以下の責務を持つ:

- メッセージハンドラの登録・検索 (`messageHandlers: Map<string, MessageHandler>`)
- Observable ストリームからのレスポンス送信 (`send()`)
- イベントハンドリング (`handleEvent()`)
- シリアライザ/デシリアライザの初期化

クライアント側の `ClientProxy` 抽象クラスも同様に、`send()` / `emit()` の公開 API を定義し、各トランスポートは `publish()` と `dispatchEvent()` を実装するだけでよい。

```typescript
// server/server.ts:47-50
export abstract class Server<
  EventsMap extends Record<string, Function> = Record<string, Function>,
  Status extends string = string,
> {
```

```typescript
// client/client-proxy.ts:38-41
export abstract class ClientProxy<
  EventsMap extends Record<never, Function> = Record<never, Function>,
  Status extends string = string,
> {
```

両基底クラスに共通する `initializeSerializer` / `initializeDeserializer` メソッドは、オプションからカスタム実装を取り出し、なければデフォルトを使う同一パターンを踏襲している。

### 2. トランスポート固有のコンテキストホスト

ハンドラがトランスポート固有の情報にアクセスする必要がある場合、`BaseRpcContext<T>` の型パラメータで各プロトコルの情報を型安全に提供する:

```typescript
// ctx-host/base-rpc.context.ts:4
export class BaseRpcContext<T = unknown[]> {
  constructor(protected readonly args: T) {}
}
```

```typescript
// ctx-host/kafka.context.ts:4-11
type KafkaContextArgs = [
  message: KafkaMessage,
  partition: number,
  topic: string,
  consumer: Consumer,
  heartbeat: () => Promise<void>,
  producer: Producer,
];
```

```typescript
// ctx-host/nats.context.ts:3
type NatsContextArgs = [string, any];
```

各コンテキストは専用のゲッターメソッド（`getPartition()`, `getSubject()`, `getChannel()` 等）を提供し、タプルのインデックスアクセスを隠蔽する。

### 3. オプショナル依存の遅延ロードパターン

すべてのトランスポート実装で、外部パッケージはモジュールスコープの変数に遅延読み込みされる:

```typescript
// server/server-redis.ts:17-23
// To enable type safety for Redis. This cant be uncommented by default
// because it would require the user to install the ioredis package even if they dont use Redis
// Otherwise, TypeScript would fail to compile the code.
//
// type Redis = import('ioredis').Redis;
type Redis = any;

let redisPackage = {} as any;
```

```typescript
// server/server-redis.ts:44-46 (constructor内)
redisPackage = this.loadPackage('ioredis', ServerRedis.name, () =>
  require('ioredis'),
);
```

この `type X = any` + コメントアウトされた本来の型宣言というパターンは、ServerNats, ServerMqtt, ServerKafka, ServerGrpc, ServerRMQ のすべてで一貫して使われている。

### 4. Factory パターンによるトランスポート選択

`ServerFactory` と `ClientProxyFactory` が Transport enum に基づいてインスタンスを生成する:

```typescript
// server/server-factory.ts:21-43
public static create(microserviceOptions: MicroserviceOptions) {
  const { transport, options } = microserviceOptions as Exclude<
    MicroserviceOptions, CustomStrategy
  >;
  switch (transport) {
    case Transport.REDIS:
      return new ServerRedis(options as Required<RedisOptions>['options']);
    case Transport.NATS:
      return new ServerNats(options as Required<NatsOptions>['options']);
    // ... 他のトランスポート
    default:
      return new ServerTCP(options as Required<TcpOptions>['options']);
  }
}
```

さらに `CustomStrategy` インターフェースにより、組み込みトランスポート以外のカスタム実装も受け入れられる拡張ポイントが設けられている (`interfaces/custom-transport-strategy.interface.ts`)。

### 5. トランスポート固有シリアライザの分離

デフォルトシリアライザはトランスポートごとに最適な実装を持つ:

| トランスポート | デフォルトシリアライザ | 入出力型 |
|---|---|---|
| TCP, Redis | `IdentitySerializer` | そのまま返す |
| NATS | `NatsRecordSerializer` | JSON Codec でエンコード |
| MQTT | `MqttRecordSerializer` | JSON.stringify |
| Kafka | `KafkaRequestSerializer` | Buffer / key-value 構造化 |
| RMQ | `RmqRecordSerializer` | RmqRecord でオプション分離 |

各トランスポートが `initializeSerializer()` をオーバーライドしてデフォルトを切り替える:

```typescript
// server/server-nats.ts:281-282
protected initializeSerializer(options: NatsOptions['options']) {
  this.serializer = options?.serializer ?? new NatsRecordSerializer();
}
```

### 6. RecordBuilder パターンによるトランスポート固有メタデータの付与

NATS, MQTT, RMQ には `XxxRecord` / `XxxRecordBuilder` が用意されており、メッセージにトランスポート固有のメタデータ（ヘッダー、QoS、TTL 等）を型安全に付与できる:

```typescript
// record-builders/nats.record-builder.ts:14-32
export class NatsRecordBuilder<TData> {
  private headers?: any;
  constructor(private data?: TData) {}

  public setHeaders<THeaders = any>(headers: THeaders): this {
    this.headers = headers;
    return this;
  }
  public setData(data: TData): this {
    this.data = data;
    return this;
  }
  public build(): NatsRecord {
    return new NatsRecord(this.data, this.headers);
  }
}
```

### 7. メッセージパターンとイベントパターンの二重性

`@MessagePattern()` は request-response モデル、`@EventPattern()` は fire-and-forget モデルを表す。両者はデコレータメタデータの `PatternHandler.MESSAGE` / `PatternHandler.EVENT` で区別され、サーバー側では `packet.id` の有無で振り分けられる:

```typescript
// server/server-tcp.ts:100-101
if (isUndefined((packet as IncomingRequest).id)) {
  return this.handleEvent(pattern, packet, tcpContext);
}
```

この判定ロジックは全トランスポートで同一のパターンとして反復されている。

## パターンカタログ

- **Template Method** (分類: 振る舞い)
  - 解決する問題: トランスポートごとに異なる接続・切断・メッセージ処理フローを、共通のスケルトンで統一する
  - 適用条件: 共通の処理フローを持ちながら、個々のステップがトランスポートによって異なる場合
  - コード例: `server/server.ts` の `send()`, `handleEvent()` が共通フロー。各サブクラスの `listen()`, `close()`, `handleMessage()` がカスタマイズポイント
  - 注意点: abstract メソッドが多すぎるとサブクラスの実装負担が増える。NestJS は `listen()`, `close()`, `on()`, `unwrap()` の 4 メソッドに絞っている

- **Strategy** (分類: 振る舞い)
  - 解決する問題: シリアライゼーション方式をトランスポートやユーザー要件に応じて切り替える
  - 適用条件: 同一のインターフェースで複数のアルゴリズムを差し替え可能にしたい場合
  - コード例: `interfaces/serializer.interface.ts` の `Serializer<TInput, TOutput>`, 各トランスポートの `initializeSerializer()` でデフォルト戦略を注入
  - 注意点: IdentitySerializer のような「何もしない」実装を Null Object として用意すると、分岐を減らせる

- **Factory Method** (分類: 生成)
  - 解決する問題: Transport enum からの具象クラス生成を一箇所に集約する
  - 適用条件: 生成すべきクラスが分岐的に決まる場合
  - コード例: `server/server-factory.ts:21-43`, `client/client-proxy-factory.ts:41-75`

- **Builder** (分類: 生成)
  - 解決する問題: トランスポート固有のメッセージオプションを段階的に構築する
  - 適用条件: 構築に多数のオプショナルパラメータがある場合
  - コード例: `record-builders/nats.record-builder.ts`, `record-builders/mqtt.record-builder.ts`

## Good Patterns

- **Null Object シリアライザ**: `IdentitySerializer` は `serialize(value) { return value; }` のみの実装で、シリアライゼーション不要なケースでも Strategy パターンのインターフェースを崩さない。条件分岐を排除し、常に `this.serializer.serialize()` を呼べるようにしている。

```typescript
// serializers/identity.serializer.ts:3-7
export class IdentitySerializer implements Serializer {
  serialize(value: any) {
    return value;
  }
}
```

- **統一パケット型による Event/Message の判別**: `ReadPacket` に `id` が存在するか否かで request-response と event-based を判別する設計。新しいフィールドの追加ではなく、既存フィールドの有無で分岐するため、パケット構造が肥大化しない。

```typescript
// server/server-tcp.ts:100-101 (全トランスポートで同一パターン)
if (isUndefined((packet as IncomingRequest).id)) {
  return this.handleEvent(pattern, packet, tcpContext);
}
```

- **型パラメータ付きコンテキストホスト**: `BaseRpcContext<T>` にタプル型を渡すことで、各トランスポートのコンテキスト情報を型安全に保持しつつ、共通インターフェースも維持する。

```typescript
// ctx-host/kafka.context.ts:16
export class KafkaContext extends BaseRpcContext<KafkaContextArgs> {
```

- **pending event listeners パターン**: サーバー/クライアントがまだ初期化されていない段階でイベントリスナーを登録しようとした場合、配列にバッファリングし、初期化完了時にまとめて登録する。レースコンディションを防ぐ実践的なパターン。

```typescript
// server/server-tcp.ts:161-170
public on<...>(event: EventKey, callback: EventCallback) {
  if (this.server) {
    this.server.on(event, callback as any);
  } else {
    this.pendingEventListeners.push({ event, callback });
  }
}
```

## Anti-Patterns / 注意点

- **型安全性の放棄による `any` 汚染**: オプショナル依存の遅延ロードのために `type Redis = any` のような宣言が多用されている。これにより、トランスポート実装内部の型チェックが事実上無効化される。

```typescript
// Bad: server/server-redis.ts:23
type Redis = any;
let redisPackage = {} as any;

// Better: conditional type import + branded type で最低限の型安全性を確保
type Redis = { connect(): Promise<void>; quit(): Promise<void>; on(event: string, fn: Function): void; publish(channel: string, message: string, cb?: Function): void; subscribe(channel: string, cb?: Function): void; [key: string]: unknown };
```

- **initializeSerializer の Union 型キャスト**: 基底クラスの `initializeSerializer()` で全トランスポートの Options 型を Union でキャストしている。トランスポートが増えるたびにこの Union を更新する必要がある。

```typescript
// Bad: server/server.ts:297-307
protected initializeSerializer(options: ClientOptions['options']) {
  this.serializer =
    (options &&
      (options as
        | RedisOptions['options']
        | NatsOptions['options']
        | MqttOptions['options']
        | TcpOptions['options']
        | RmqOptions['options']
        | KafkaOptions['options'])!.serializer) ||
    new IdentitySerializer();
}

// Better: 各サブクラスで override する（実際に NATS, MQTT, Kafka, RMQ はそうしている）
// 基底クラスは options?.serializer のみ参照するか、abstract にする
```

- **gRPC のパターン外れ**: ServerGrpc は他のトランスポートと異なり `status`, `on()`, `unwrap()` で例外を投げる。共通インターフェースに従えないトランスポートがある場合、インターフェース分離原則（ISP）を検討すべき。

## 導出ルール

- `[MUST]` マルチトランスポートを抽象化する場合、すべてのトランスポートが共通に扱える最小限のメッセージ契約（パターン + データ + オプショナル ID）を定義する
  - 根拠: NestJS の `ReadPacket` / `WritePacket` は 5-6 行の最小型定義で 7 つのトランスポートを統一している (`interfaces/packet.interface.ts:1-22`)

- `[MUST]` シリアライゼーション/デシリアライゼーションは Strategy パターンで差し替え可能にし、デフォルト実装（Null Object 含む）を必ず提供する
  - 根拠: `Serializer<TInput, TOutput>` インターフェース + `IdentitySerializer` により、ユーザーは JSON, Protocol Buffers, MessagePack 等を自由に選択できる (`interfaces/serializer.interface.ts`, `serializers/identity.serializer.ts`)

- `[SHOULD]` 使わないトランスポートの外部依存をコンパイル時に強制しない。遅延ロード + 実行時エラーで対応する
  - 根拠: 全 6 つの非 TCP トランスポートが `loadPackage()` で依存を遅延ロードし、未インストール時にはわかりやすいエラーメッセージを出す

- `[SHOULD]` トランスポート固有のメタデータアクセスは、共通基底クラスのサブクラスとして型安全なゲッターメソッドで提供する（タプルインデックスの直接アクセスを避ける）
  - 根拠: `BaseRpcContext<T>` + `KafkaContext`, `NatsContext` 等の型パラメータ付きサブクラスにより、`getPartition()`, `getSubject()` 等のドメイン用語でアクセスできる

- `[SHOULD]` request-response と event-driven の 2 つの通信モデルは、ハンドラ登録時にメタデータで区別し、ランタイムでは既存フィールドの有無で判別する
  - 根拠: `@MessagePattern` / `@EventPattern` デコレータ + `packet.id` の有無による分岐が全 7 トランスポートで一貫して使われている

- `[AVOID]` 共通抽象にすべてのトランスポートのメソッドを詰め込まない。特定のトランスポートでしか機能しないメソッド（gRPC のストリーミング等）は、そのトランスポート固有のクラスに留める
  - 根拠: `ServerGrpc` の `on()` / `unwrap()` / `status` は例外を投げるだけの実装となっており、インターフェース分離が不十分な結果、ランタイムエラーのリスクがある

- `[AVOID]` 基底クラスの初期化メソッドで全サブクラスの型を Union キャストしない。各サブクラスが自分の型でオーバーライドする方がメンテナンス性が高い
  - 根拠: `Server.initializeSerializer()` は 6 つの Options 型を Union キャストしているが、NATS, MQTT, Kafka, RMQ は実際に override して独自デフォルトを設定しており、基底の Union は冗長

## 適用チェックリスト

- [ ] 複数のトランスポートを扱う場合、すべてのトランスポートで共通に扱えるメッセージ型（ReadPacket / WritePacket 相当）を定義しているか
- [ ] シリアライゼーション/デシリアライゼーションを Strategy パターンで差し替え可能にしているか
- [ ] 使わないトランスポートの依存を強制していないか（オプショナル依存 + 遅延ロード）
- [ ] トランスポート固有のコンテキスト情報に型安全にアクセスできるか（ジェネリック Context クラス）
- [ ] request-response と event-driven の 2 つの通信モデルを統一的に扱えるか
- [ ] 新しいトランスポートを追加する際、既存のハンドラコードの変更が不要か
- [ ] Factory パターンで具象クラスの生成を一箇所に集約しているか
- [ ] 初期化前のイベントリスナー登録をバッファリングでハンドリングしているか
