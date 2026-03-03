# testing-practices

> リポジトリ: nestjs/nest
> 分析日: 2026-03-03

## 概要

NestJS のテスト戦略を分析する。DI コンテナに密結合したフレームワークでありながら、`TestingModule` による DI の差し替え機構を中心に、単体テストと統合テストを明確に分離した二層構造を実現している。単体テストでは Mocha + Chai + Sinon でクラス単位の振る舞いを検証し、統合テストでは `Test.createTestingModule()` + Supertest でモジュールグラフ全体をブートストラップして HTTP レベルの検証を行う。この二層構造と DI モック戦略は、DI フレームワーク上のテスト設計に広く応用可能である。

## 背景にある原則

- **DI コンテナをテストの境界線として使う**: テスト対象の粒度を DI の単位で制御する。単体テストではクラスを直接インスタンス化し、統合テストでは `TestingModule` 経由でモジュールグラフを組み立てる。これにより、テストの粒度がフレームワークのモジュール境界と一致し、何をモックし何を実物にするかの判断が容易になる。（`packages/testing/test.ts:11-16`, `integration/hello-world/e2e/express-instance.spec.ts:14-16`）

- **テスト用ロガーでノイズを排除する**: テスト実行中のログ出力はデフォルトで抑制し、エラーのみ表示する。`TestingLogger` は `log`/`warn`/`debug`/`verbose` を no-op にし、`error` だけ実装を残す。テスト出力にフレームワークのブートストラップログが混ざると失敗原因の特定が困難になるため、この設計は「テスト出力はテスト結果だけを含むべき」という原則に基づく。（`packages/testing/services/testing-logger.service.ts:6-18`）

- **Noop 実装でインフラ依存を断ち切る**: HTTP アダプタなどインフラに密結合した依存を Noop（何もしない）実装で置換し、単体テストをネットワーク非依存にする。`NoopHttpAdapter` は `AbstractHttpAdapter` の全メソッドを空実装で返し、テストがHTTPサーバーの起動を必要としない。（`packages/core/test/utils/noop-adapter.spec.ts:5-42`）

- **テストコードに本番同等のモジュール構成を再現する**: 統合テストでは `AppModule` をそのままインポートし、本番と同等のモジュールグラフでテストする。テスト専用のモジュール構成を作らないことで、テストの信頼性と本番コードとの乖離を防ぐ。（`integration/hello-world/e2e/hello-world.spec.ts:11-13`）

## 実例と分析

### 単体テストの構造パターン

パッケージの `test/` ディレクトリに配置された 220 以上の spec ファイルは、一貫した構造を持つ。Mocha + Chai + Sinon の組み合わせで、フレームワークの依存注入を使わずにクラスを直接テストする。

```typescript
// packages/core/test/injector/injector.spec.ts:1-16
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Injectable } from '../../../common/decorators/core/injectable.decorator';
import { Injector } from '../../injector/injector';

describe('Injector', () => {
  let injector: Injector;

  beforeEach(() => {
    injector = new Injector();
  });
```

テスト対象クラスを `new` で直接生成し、依存は Sinon のスタブまたは Noop 実装で置き換える。DI コンテナを経由しないことで、テストのブートストラップが速くなり、失敗時の原因箇所が限定される。

### TestingModule による統合テスト

統合テストは `integration/` ディレクトリに配置され、各サブディレクトリが `src/`（テスト用アプリケーション）と `e2e/`（テストファイル）を持つ。119 ファイルで 193 箇所の `createTestingModule` 呼び出しがある。

```typescript
// integration/hello-world/e2e/express-instance.spec.ts:13-21
beforeEach(async () => {
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = module.createNestApplication(new ExpressAdapter(express()));
  server = app.getHttpServer();
  await app.init();
});
```

このパターンは一貫して「モジュール組み立て → アプリケーション生成 → 初期化 → テスト → クリーンアップ」のフローに従う。

### useMocker による自動モック

`TestingInjector` は DI 解決に失敗した場合に `MockFactory` を呼び出すフォールバック機構を持つ。テスト対象のクラスだけを `providers` に登録し、その依存はモッカーが自動生成する。

```typescript
// integration/auto-mock/test/bar.service.spec.ts:15-23
beforeEach(async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [BarService],
  })
    .useMocker(() => ({ foo: stub }))
    .compile();
  service = moduleRef.get(BarService);
  fooService = moduleRef.get(FooService);
});
```

`TestingInjector.resolveComponentWrapper` は `super.resolveComponentWrapper` を try-catch で囲み、解決失敗時に `mocker(name)` を呼び出す（`packages/testing/testing-injector.ts:26-49`）。これは「依存解決の例外をモック生成のトリガーにする」パターンで、既存の DI 機構を変更せずにテスト機能を追加している。

### overrideProvider / overrideModule による差し替え

Builder パターンで DI コンテナの特定のプロバイダやモジュールを差し替える。

```typescript
// integration/scopes/e2e/inject-inquirer.spec.ts:13-21
const module = await Test.createTestingModule({
  imports: [HelloModule],
})
  .overrideProvider(Logger)
  .useValue(logger)
  .compile();
```

`overrideModule` はモジュール全体の置換をサポートし、循環依存やレイジーロードされたモジュールでも動作する（`integration/testing-module-override/e2e/modules-override.spec.ts:98-140`）。

### Sinon のスタブ/スパイ管理パターン

コードベースでは 2 つのスタブ管理パターンが共存する：

1. **`sinon.restore()` パターン**: `afterEach(() => sinon.restore())` でグローバルにリストア
2. **`sandbox` パターン**: `sinon.createSandbox()` でスコープを限定

```typescript
// packages/microservices/test/server/server.spec.ts:21-27
const sandbox = sinon.createSandbox();

afterEach(() => {
  sandbox.restore();
});
```

sandbox パターンはテスト間の副作用分離をより厳密に行うが、コードベースの多くは `sinon.restore()` の簡易パターンを使用している。

### Express / Fastify デュアルアダプタテスト

同じビジネスロジックに対して Express と Fastify の両アダプタでテストを実行する。Fastify では `app.inject()` を使いHTTPサーバーの起動なしでテストを行う。

```typescript
// integration/hello-world/e2e/fastify-adapter.spec.ts:17-30
app = module.createNestApplication<NestFastifyApplication>(
  new FastifyAdapter(),
);
await app.init();

it(`/GET`, () => {
  return app
    .inject({ method: 'GET', url: '/hello' })
    .then(({ payload }) => expect(payload).to.be.eql('Hello world!'));
});
```

### データ駆動テスト

テストケースの配列を `forEach` でイテレートし、同一の検証ロジックを複数のパラメータに適用する。

```typescript
// integration/hello-world/e2e/hello-world.spec.ts:20-77
[
  { host: 'example.com', path: '/hello', greeting: 'Hello world!' },
  { host: 'acme.example.com', path: '/host', greeting: 'Host Greeting! tenant=acme' },
  // ...
].forEach(({ host, path, greeting }) => {
  describe(`host=${host}`, () => {
    it(`should return "${greeting}"`, () => {
      return request(server).get(path).set('Host', host).expect(200).expect(greeting);
    });
  });
});
```

### テスト内でのインラインモジュール定義

統合テストのファイル内でテスト専用のコントローラ・モジュール・ガード等をインラインで定義する。本番コードとテストコードの距離を近く保ち、テストの意図を明確にする。

```typescript
// integration/hello-world/e2e/guards.spec.ts:11-31
@Injectable()
export class AuthGuard {
  canActivate() {
    throw new UnauthorizedException();
  }
}

function createTestModule(guard) {
  return Test.createTestingModule({
    imports: [AppModule],
    providers: [{ provide: APP_GUARD, useValue: guard }],
  }).compile();
}
```

### Docker Compose による外部サービスの統合テスト

マイクロサービステスト（Redis, NATS, MQTT, Kafka, RabbitMQ 等）は Docker Compose で外部サービスを起動してテストする。`test:docker:up` / `test:docker:down` スクリプトでライフサイクルを管理する（`integration/docker-compose.yml`）。

## パターンカタログ

- **Builder パターン** (分類: 生成)
  - 解決する問題: テスト用 DI コンテナの組み立てにおいて、モジュール/プロバイダ/ガード等の差し替えを宣言的に表現する
  - 適用条件: DI コンテナのテスト構成が複数のオーバーライドを含む場合
  - コード例: `packages/testing/testing-module.builder.ts:37-203`
  - 注意点: `compile()` を呼ぶまでオーバーライドは適用されない（遅延評価）

- **Null Object パターン** (分類: 振る舞い)
  - 解決する問題: テスト時にインフラ依存（HTTP アダプタ、ロガー）のコストを排除する
  - 適用条件: テスト対象がインフラ層に依存しているが、インフラの振る舞い自体はテストしない場合
  - コード例: `packages/core/test/utils/noop-adapter.spec.ts:5-42`, `packages/testing/services/testing-logger.service.ts:6-18`
  - 注意点: Noop 実装は抽象クラスの全メソッドを実装する必要があり、インターフェースが変更されたときの追従コストがある

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: `TestingInjector` は `Injector` を継承し、依存解決の失敗時にモック生成にフォールバックする
  - 適用条件: 既存のフレームワーク機構のテスト向け拡張が必要な場合
  - コード例: `packages/testing/testing-injector.ts:14-114`
  - 注意点: 継承によるオーバーライドは親クラスの内部実装への依存を生むため、親クラスの変更に弱い

## Good Patterns

- **テスト用ヘルパー関数によるボイラープレート削減**: 統合テストで `createTestModule()` や `createApp()` といったヘルパー関数を定義し、テストモジュール構築のボイラープレートを共通化する。テストケースの記述が簡潔になり、セットアップの差異（例：グローバルプレフィックスの有無）をパラメータで表現できる。

```typescript
// integration/hello-world/e2e/middleware.spec.ts:106-121
async function createApp(
  beforeInit?: (app: INestApplication) => void,
): Promise<INestApplication> {
  const app = (
    await Test.createTestingModule({ imports: [TestModule] }).compile()
  ).createNestApplication();
  if (beforeInit) { beforeInit(app); }
  await app.init();
  return app;
}
```

- **afterEach での確実なクリーンアップ**: 統合テストでは `afterEach` で必ず `app.close()` を呼び、HTTP サーバーやマイクロサービスのリソースを解放する。beforeEach でアプリケーションを起動し afterEach でクリーンアップするペアリングが全テストで一貫している。

```typescript
// integration/hello-world/e2e/express-instance.spec.ts:53-55
afterEach(async () => {
  await app.close();
});
```

- **静的カウンターによるインスタンス生成回数の検証**: スコープ付きプロバイダのテストで、静的プロパティにインスタンス生成回数を記録し、DI の振る舞い（リクエストスコープなら毎リクエスト生成される）を検証する。

```typescript
// integration/scopes/e2e/request-scope.spec.ts:52-54
it(`should create controller for each request`, () => {
  expect(HelloController.COUNTER).to.be.eql(3);
});
```

- **`sinon.match` によるアサーションの柔軟化**: 部分一致やワイルドカードを活用し、テストの脆さを減らす。値全体を厳密に比較するのではなく、注目するフィールドだけを検証する。

```typescript
// integration/scopes/e2e/inject-inquirer.spec.ts:42-48
expect(
  logger.log.calledWith({
    message: 'Hello request!',
    requestId: sinon.match.string,  // 任意の文字列にマッチ
    feature: 'request',
  }),
).to.be.true;
```

## Anti-Patterns / 注意点

- **スタブのリストア漏れ**: Sinon のスタブをグローバルスコープで作成し、`afterEach` でのリストアを忘れると、テスト間で副作用が残りフレイキーテストの原因になる。コードベースの一部のテストファイルでは `afterEach(() => sinon.restore())` が欠けており、テストの実行順序に依存するリスクがある。

```typescript
// Bad: afterEach でリストアしない
beforeEach(() => {
  sinon.stub(adapter, 'reply').callsFake(/* ... */);
});
// テスト終了後もスタブが残る

// Better: 必ずリストアする
afterEach(() => {
  sinon.restore();
});
```

- **テストファイル内での本番コード定義の混在**: テストファイル内でインラインクラスを定義するパターンは便利だが、テストの意図とテスト用フィクスチャの定義が混ざり、長いテストファイルでは可読性が下がる。NestJS のテストでは `@Injectable()`, `@Controller()`, `@Module()` デコレータ付きのクラスがテストファイルに散在しており、テスト用のヘルパーかテスト対象か区別しにくい場合がある。

```typescript
// Bad: 50行にわたるフィクスチャ定義のあとにテストが始まる
@Injectable() class ServiceA { /* ... */ }
@Injectable() class ServiceB { /* ... */ }
@Module({ /* 20行 */ }) class TestModule { /* ... */ }
@Controller() class TestController { /* ... */ }

describe('Integration', () => { /* やっとテストが始まる */ });

// Better: テスト用フィクスチャを別ファイルに切り出す、または describe ブロック内で定義する
```

## 導出ルール

- `[MUST]` 統合テストでアプリケーションを起動した場合、`afterEach` / `afterAll` で必ず `close()` を呼び、HTTP サーバー・イベントリスナー等のリソースを解放する
  - 根拠: NestJS の全統合テスト（119ファイル）で `afterEach(() => app.close())` が一貫して実装されており、リソースリーク防止とテスト分離を保証している（`integration/hello-world/e2e/express-instance.spec.ts:53-55`）

- `[MUST]` テストで使用したスタブ・スパイ・モックは `afterEach` で必ずリストアし、テスト間の副作用を防ぐ
  - 根拠: `sinon.restore()` または `sandbox.restore()` が適切に呼ばれていないテストはフレイキーテストの原因になる。NestJS では `sinon.createSandbox()` パターンと `sinon.restore()` パターンの両方が使われるが、いずれもリストアは必須（`packages/core/test/repl/repl-context.spec.ts:27`）

- `[SHOULD]` 単体テストでは DI コンテナを使わず対象クラスを直接インスタンス化し、統合テストでは DI コンテナ経由でモジュールグラフを組み立てる二層構造を採用する
  - 根拠: NestJS のテストは `packages/**/test/` で DI なしの直接テスト、`integration/**/e2e/` で `TestingModule` 経由のテストに明確に分離されており、テスト速度と信頼性のバランスを取っている

- `[SHOULD]` DI フレームワークのテストでは、Noop（空実装）パターンでインフラ依存を置換し、テスト対象のビジネスロジックだけを検証する
  - 根拠: `NoopHttpAdapter` は `AbstractHttpAdapter` の全メソッドを空実装で返し、HTTP サーバーなしで Router/Guard/Interceptor 等のテストを可能にしている（`packages/core/test/utils/noop-adapter.spec.ts:5-42`）

- `[SHOULD]` テストモジュールのボイラープレートが繰り返される場合、ヘルパー関数を抽出して `beforeEach` 内のセットアップを簡潔に保つ
  - 根拠: `createTestModule(guard)` のようなヘルパーがテストの意図を明確にし、同じセットアップの変種（異なるガード、異なるインターセプター）をパラメータ化している（`integration/hello-world/e2e/interceptors.spec.ts:59-69`）

- `[SHOULD]` テスト用ロガーはデフォルトでログ出力を抑制し、エラーのみ出力する設計にする
  - 根拠: `TestingLogger` は `log`/`warn`/`debug`/`verbose` を no-op にし `error` だけ通すことで、テスト出力をテスト結果だけに限定している（`packages/testing/services/testing-logger.service.ts:6-18`）

- `[AVOID]` テストフレームワークの DI 機構（`useMocker` 等）に過度に依存し、全依存を自動モックにする。テスト対象の直接の依存のみをモックし、モジュール全体の自動モックは避ける
  - 根拠: `useMocker` は依存解決失敗時のフォールバックとして設計されており、全プロバイダを自動モックにすると、テストが何を検証しているか不明確になる。NestJS の `auto-mock` テストでも対象サービスは明示的に `providers` に登録している（`integration/auto-mock/test/bar.service.spec.ts:16-18`）

## 適用チェックリスト

- [ ] 単体テスト（DI なし、クラス直接テスト）と統合テスト（DI コンテナ経由）を明確に分離したディレクトリ構成になっているか
- [ ] 統合テストで起動したサーバー/アプリケーションは `afterEach` / `afterAll` で必ず `close()` しているか
- [ ] Sinon 等のモックライブラリを使用する場合、`afterEach` でスタブ/スパイをリストアしているか
- [ ] テスト用ロガーがデフォルトで出力を抑制し、テスト結果の可読性を維持しているか
- [ ] 統合テストでは本番と同等のモジュール構成（`AppModule` のインポート等）を再現しているか
- [ ] テストモジュールのセットアップが繰り返されている場合、ヘルパー関数に抽出されているか
- [ ] インフラ依存（HTTP、DB、メッセージブローカー等）のテストに、Noop 実装やインメモリ代替が用意されているか
- [ ] データ駆動テスト（パラメータ化テスト）を活用し、同一ロジックの複数ケースを DRY に検証しているか
