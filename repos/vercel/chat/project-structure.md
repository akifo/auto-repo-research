# Project Structure

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

vercel/chat は pnpm + Turborepo で構成されたモノレポで、マルチプラットフォームチャット SDK を提供する。14 パッケージが 4 カテゴリ（core / adapter / state / infra）に分かれており、依存関係が厳格に一方向（adapter -> core、state -> core）に制御されている。この構造は「プラットフォーム固有のロジックをコアから完全に隔離する」設計哲学を体現しており、アダプターパターンをモノレポ境界で物理的に強制している点が注目に値する。

## 背景にある原則

- **インターフェースによる物理的境界の強制**: コアパッケージ `chat` が `Adapter` と `StateAdapter` の 2 つのインターフェースを定義し、すべてのプラットフォーム固有パッケージはこのインターフェースを実装する。npm パッケージ境界がモジュールの契約を物理的に強制するため、誤った依存関係はビルド時に即座に失敗する（`packages/chat/src/types.ts:90` の `Adapter` インターフェース、`packages/chat/src/types.ts:454` の `StateAdapter` インターフェース）
- **関心の方向性を階層で表現**: `packages/` 直下のフラット配置ではなく、命名規則 `adapter-*` / `state-*` でカテゴリを表現している。各パッケージの依存は `chat` (core) -> `adapter-shared` -> 個別アダプター の一方向であり、`turbo.json` の `dependsOn: ["^build"]` でビルド順序もこの方向性に従う（`turbo.json:18`）
- **抽象化レイヤーの段階的共通化**: すべてのアダプターに共通するユーティリティは最初から共通化せず、`adapter-shared` として別パッケージに抽出している。各アダプターが `adapter-shared` を任意に依存するオプトイン方式で、不要な共通化による結合を避けている（`packages/adapter-shared/package.json`）
- **テスト境界と公開境界の分離**: 統合テストは `packages/integration-tests` として独立パッケージにし、`private: true` かつ Changesets の `ignore` 対象とすることで、テストコードがリリースフローに影響しない（`.changeset/config.json:10`）

## 実例と分析

### パッケージカテゴリと依存グラフ

14 パッケージは明確な 4 層に分かれている。

| 層                 | パッケージ                                                                                               | 役割                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Core               | `chat`                                                                                                   | Chat クラス、型定義、Markdown AST ユーティリティ                           |
| Adapter (shared)   | `adapter-shared`                                                                                         | アダプター間で共有するユーティリティ（エラー型、バッファ変換、カード変換） |
| Adapter (platform) | `adapter-slack`, `adapter-teams`, `adapter-gchat`, `adapter-discord`, `adapter-github`, `adapter-linear` | 各プラットフォーム固有の実装                                               |
| State              | `state-memory`, `state-redis`, `state-ioredis`                                                           | 永続化層の実装                                                             |

依存方向は厳密に「上位層 -> 下位層」で、逆方向の依存は存在しない。例えば `adapter-slack` は `chat` と `adapter-shared` に依存するが、`chat` はどのアダプターにも依存しない。

### 各アダプターの内部構造の一貫性

すべてのアダプターパッケージが同一のファイル構成パターンに従っている。

| ファイル      | 責務                                                                   |
| ------------- | ---------------------------------------------------------------------- |
| `index.ts`    | アダプタークラス本体 + ファクトリ関数                                  |
| `markdown.ts` | `BaseFormatConverter` を継承したプラットフォーム固有のフォーマット変換 |
| `cards.ts`    | カード UI のプラットフォーム固有変換                                   |
| `types.ts`    | プラットフォーム固有の型定義（一部アダプターのみ）                     |
| `*.test.ts`   | 各ファイルに対応するユニットテスト                                     |

この規則性により、新しいアダプターを追加する際に「何を実装すればよいか」が既存パッケージを見れば即座に把握できる。

### tsup / tsconfig の統一パターン

全パッケージが以下の共通設定を持つ。

- `tsconfig.json`: `"extends": "../../tsconfig.base.json"` でルートの共通設定を継承
- `tsup.config.ts`: `format: ["esm"]`, `dts: true`, `sourcemap: true` が標準
- プラットフォーム SDK を `external` で除外し、バンドルサイズを制御

### Changesets の `fixed` バージョニング

`.changeset/config.json` で `"fixed": [["chat", "@chat-adapter/*"]]` が設定されており、コアとすべてのアダプターが同一バージョンでリリースされる。これはセマンティックバージョニングの `compatible` 関係を明示的に管理する戦略で、ユーザーがバージョン互換性を気にせずに済む。

### ワークスペース横断テスト戦略

テストは 3 層構造で実施される。

1. **ユニットテスト**: 各パッケージ内の `*.test.ts`（vitest workspace 経由）
2. **統合テスト**: `packages/integration-tests` が複数アダプターをまたいだシナリオをテスト
3. **ルートレベル**: `vitest.workspace.ts` で全パッケージのテストを統合実行

`turbo.json` で `test` タスクが `dependsOn: ["build"]` と設定されており、ビルド成果物に対してテストが実行される（ルートの `package.json` でも `"test": "turbo test --filter='!example-nextjs-chat'"` でサンプルアプリを除外）。

## コード例

コアの `Adapter` インターフェースが型パラメータでプラットフォーム固有の型を受け取る設計。

```typescript
// packages/chat/src/types.ts:90
export interface Adapter<TThreadId = unknown, TRawMessage = unknown> {
  readonly name: string;
  readonly userName: string;
  initialize(chat: ChatInstance): Promise<void>;
  handleWebhook(request: Request, options?: WebhookOptions): Promise<Response>;
  postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<TRawMessage>>;
  parseMessage(raw: TRawMessage): Message<TRawMessage>;
  encodeThreadId(platformData: TThreadId): string;
  decodeThreadId(threadId: string): TThreadId;
  // ... 他のメソッド
}
```

各アダプターが `implements Adapter<PlatformThreadId, unknown>` で具体型を束縛する。

```typescript
// packages/adapter-slack/src/index.ts:289
export class SlackAdapter implements Adapter<SlackThreadId, unknown> { ... }

// packages/adapter-discord/src/index.ts:77
export class DiscordAdapter implements Adapter<DiscordThreadId, unknown> { ... }

// packages/adapter-github/src/index.ts:96
export class GitHubAdapter
  implements Adapter<GitHubThreadId, GitHubRawMessage> { ... }
```

`StateAdapter` の 2 つの実装がパッケージ分離で環境差を吸収。

```typescript
// packages/state-memory/src/index.ts:20
export class MemoryStateAdapter implements StateAdapter {
  // 開発/テスト用。production で使うと警告を出す
  async connect(): Promise<void> {
    if (process.env.NODE_ENV === "production") {
      console.warn("[chat] MemoryStateAdapter is not recommended for production.");
    }
  }
}

// packages/state-redis/src/index.ts:20
export class RedisStateAdapter implements StateAdapter {
  // 本番用。Lua スクリプトによるアトミックなロック操作
  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const acquired = await this.client.set(lockKey, token, { NX: true, PX: ttlMs });
    // ...
  }
}
```

`adapter-shared` がアダプター間のエラー型を統一。

```typescript
// packages/adapter-shared/src/errors.ts:13
export class AdapterError extends Error {
  readonly adapter: string;
  readonly code?: string;
  constructor(message: string, adapter: string, code?: string) { ... }
}

export class AdapterRateLimitError extends AdapterError { ... }
export class AuthenticationError extends AdapterError { ... }
export class ValidationError extends AdapterError { ... }
export class NetworkError extends AdapterError { ... }
```

ファクトリ関数パターン -- クラスと並行して `create*` 関数をエクスポート。

```typescript
// packages/adapter-slack/src/index.ts:2966
export function createSlackAdapter(config?: { ... }): SlackAdapter { ... }

// packages/state-memory/src/index.ts:182
export function createMemoryState(): MemoryStateAdapter { ... }

// packages/state-redis/src/index.ts:207
export function createRedisState(options?: Partial<RedisStateAdapterOptions>): RedisStateAdapter { ... }
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 複数チャットプラットフォーム（Slack, Teams, Discord, GitHub, Linear, Google Chat）の API 差異を統一インターフェースで吸収する
  - 適用条件: 同一の抽象操作（メッセージ送信、リアクション追加等）を異なるバックエンドで実装する必要がある場合
  - コード例: `packages/chat/src/types.ts:90`（`Adapter` インターフェース）、各 `adapter-*/src/index.ts`
  - 注意点: アダプターの粒度をパッケージ境界に合わせることで、インターフェース違反がビルドエラーとして検出される

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 状態管理の永続化戦略（インメモリ / Redis / ioredis）を実行時に切り替える
  - 適用条件: 開発環境ではインメモリ、本番では Redis のように、同一インターフェースで実装を差し替えたい場合
  - コード例: `packages/chat/src/types.ts:454`（`StateAdapter` インターフェース）、`packages/state-memory/src/index.ts:20`、`packages/state-redis/src/index.ts:20`
  - 注意点: `MemoryStateAdapter` が本番環境で使われた場合に警告を出すガードを含む

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: Markdown のフォーマット変換処理の骨格を共通化し、プラットフォーム固有の変換のみオーバーライドさせる
  - 適用条件: 変換の全体フローは共通だが、個別ステップがプラットフォームで異なる場合
  - コード例: `packages/chat/src/markdown.ts`（`BaseFormatConverter` クラス）、各 `adapter-*/src/markdown.ts`（`SlackFormatConverter`, `DiscordFormatConverter` 等）

- **Factory Method パターン** (分類: 生成)
  - 解決する問題: アダプターやステートのインスタンス生成を簡素化し、設定の組み立てを隠蔽する
  - 適用条件: クラスコンストラクタの引数が複雑、または環境変数からのフォールバック解決が必要な場合
  - コード例: `packages/adapter-slack/src/index.ts:2966`（`createSlackAdapter`）、`packages/state-redis/src/index.ts:207`（`createRedisState`）

## Good Patterns

- **命名規則でパッケージカテゴリを表現**: `adapter-*`, `state-*` の接頭辞で依存方向とカテゴリを即座に把握できる。`pnpm-workspace.yaml` のグロブ `"packages/*"` だけで全パッケージを捕捉でき、設定の追加変更が不要。

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
  - "examples/*"
```

- **ファクトリ関数 + クラスのデュアルエクスポート**: ユーザーはシンプルなファクトリ関数で始められ、カスタマイズが必要になればクラスを直接使える。環境変数のフォールバック解決はファクトリ側に集約。

```typescript
// packages/state-redis/src/index.ts:207-222
export function createRedisState(
  options?: Partial<RedisStateAdapterOptions>,
): RedisStateAdapter {
  const url = options?.url ?? process.env.REDIS_URL;
  if (!url) {
    throw new Error("Redis url is required. Set REDIS_URL or provide it in options.");
  }
  // ...
  return new RedisStateAdapter(resolved);
}
```

- **shared パッケージのオプトイン方式**: `adapter-shared` はすべてのアダプターの必須依存ではなく、必要なアダプターだけが依存する。Slack と Discord は `adapter-shared` を使うが、`state-*` パッケージは使わない。これにより共通化の強制を避けている。

- **統合テストの独立パッケージ化**: `packages/integration-tests` を `private: true` かつ Changesets `ignore` 対象にすることで、テスト追加がバージョンバンプを引き起こさない。Replay fixtures（JSON ファイル）でプラットフォーム API のレスポンスを記録・再生し、外部サービスなしで統合テストを実行可能にしている。

```json
// .changeset/config.json:10
"ignore": ["example-nextjs-chat", "@chat-adapter/integration-tests"]
```

## Anti-Patterns / 注意点

- **アダプターの index.ts 肥大化**: `adapter-slack/src/index.ts` は 3012 行、`adapter-gchat/src/index.ts` は 2491 行に達しており、単一ファイルにアダプターロジック全体が集中している。`markdown.ts` と `cards.ts` は分離されているが、webhook ハンドリング、メッセージ変換、ストリーミングなどの関心が `index.ts` に混在している。

```
// Bad: 1ファイルに3000行超のロジック
packages/adapter-slack/src/index.ts  → 3012行
packages/adapter-gchat/src/index.ts  → 2491行

// Better: 関心ごとにファイルを分割
packages/adapter-slack/src/
  index.ts          → 公開 API + ファクトリ
  webhook.ts        → webhook 検証・パース
  message.ts        → メッセージ変換
  streaming.ts      → ストリーミング処理
  markdown.ts       → フォーマット変換（既存）
  cards.ts          → カード変換（既存）
```

- **バージョン fixed 戦略の粒度**: `"fixed": [["chat", "@chat-adapter/*"]]` ですべてのパッケージが同一バージョンでリリースされる。1 つのアダプターの修正でも全パッケージのバージョンが上がるため、変更していないパッケージのユーザーにも不要なアップデートが発生する。SDK のユーザー層が小さいうちは管理コストの削減に有効だが、成長後は `linked` 戦略への移行を検討すべき。

## 導出ルール

- `[MUST]` モノレポのパッケージ間依存は一方向に制限し、Turborepo の `dependsOn: ["^build"]` でビルド順序を依存方向に一致させる
  - 根拠: vercel/chat は core -> shared -> adapter の一方向依存を `turbo.json` と `package.json` の `workspace:*` で物理的に強制しており、循環依存がビルド時に検出される構造になっている
- `[MUST]` パッケージ内のテストファイルはソースと同一ディレクトリにコロケーションし、公開パッケージの `files` フィールドで `dist` のみを含める
  - 根拠: 全アダプターが `src/index.ts` と `src/index.test.ts` を並置し、`"files": ["dist"]` でテストを npm パッケージから除外している
- `[SHOULD]` プラットフォームアダプターを個別パッケージとして分離し、命名接頭辞（`adapter-*`, `state-*`）でカテゴリを表現する
  - 根拠: ユーザーが必要なアダプターのみインストールでき、不要なプラットフォーム SDK の依存を回避できる。vercel/chat では Slack のみ使うユーザーが Discord SDK をインストールする必要がない
- `[SHOULD]` アダプター間で共通化するユーティリティは専用の shared パッケージに抽出し、各アダプターからのオプトイン依存にする
  - 根拠: `adapter-shared` が提供するエラー型、バッファ変換、カード変換は任意依存であり、state パッケージなど不要なパッケージには影響しない
- `[SHOULD]` クラスとファクトリ関数の両方をエクスポートし、ファクトリ関数に環境変数フォールバックや合理的なデフォルト値を集約する
  - 根拠: `createRedisState()` は `REDIS_URL` 環境変数のフォールバック解決とデフォルトロガーの設定を担い、クラスコンストラクタより簡潔な API を提供している
- `[SHOULD]` 統合テストを独立した private パッケージに分離し、リリースフロー（Changesets 等）の ignore 対象にする
  - 根拠: `@chat-adapter/integration-tests` は `private: true` かつ Changesets ignore 対象で、テストの追加・変更がバージョンバンプを引き起こさない
- `[AVOID]` 単一のアダプターファイルが 1000 行を超える肥大化
  - 根拠: `adapter-slack/src/index.ts`（3012 行）は webhook 処理、メッセージ変換、ストリーミング等の複数関心が混在しており、変更時の影響範囲の特定が困難

## 適用チェックリスト

- [ ] モノレポの依存方向が一方向であることを確認する（core <- adapter の逆方向依存がないか）
- [ ] 各パッケージの命名規則がカテゴリ（adapter-, state- 等）を反映しているか
- [ ] `pnpm-workspace.yaml` のグロブパターンが全パッケージを正しく捕捉しているか
- [ ] `turbo.json` の `dependsOn` がパッケージ間の依存方向と一致しているか
- [ ] プラットフォーム固有の SDK が `tsup.config.ts` の `external` で除外されているか
- [ ] テスト専用パッケージが `private: true` かつリリースフローから除外されているか
- [ ] 共通ユーティリティが shared パッケージとしてオプトイン依存になっているか
- [ ] 各アダプターの内部ファイル構成（index, markdown, cards, types）が一貫しているか
- [ ] ファクトリ関数が環境変数フォールバックとデフォルト値を適切に提供しているか
- [ ] Changesets の `fixed` / `linked` 戦略がプロジェクトの規模に合っているか
