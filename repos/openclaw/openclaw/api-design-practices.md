# API デザインプラクティス

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

OpenClaw のゲートウェイ API は、WebSocket ベースの JSON-RPC 風プロトコル、OpenAI 互換 HTTP API、Agent Client Protocol (ACP) の 3 層構造で設計されている。全 API の入出力スキーマを TypeBox / Zod で一元定義し、そこから JSON Schema・Swift モデル・AJV バリデータを自動生成するスキーマ駆動アーキテクチャが最大の特徴である。ツール入力スキーマでは「LLM が解釈できるスキーマ構造」という制約を明示的に設けており、AI エージェント時代の API 設計として汎用性の高いプラクティスが多数見られる。

## 背景にある原則

- **Single Source of Truth スキーマ**: API の型・バリデーション・ドキュメント・クロスプラットフォームモデルを単一のスキーマ定義から導出すべき。なぜなら、手動同期はクライアント数の増加に伴い破綻し、不整合が検出困難なバグを生むため（`src/gateway/protocol/schema/` が TypeBox で一元定義 → `scripts/protocol-gen.ts` で JSON Schema、`scripts/protocol-gen-swift.ts` で Swift モデルを生成）
- **AI 互換性を前提としたスキーマ制約**: ツール入力スキーマは人間だけでなく LLM が解釈するため、LLM が苦手とする構造（Union / anyOf / oneOf）を排除すべき。なぜなら、複合型は LLM のスキーマ理解精度を下げ、不正な入力を生成する確率を高めるため（`AGENTS.md:166` の Tool schema guardrails）
- **フレームレベルの型判別**: WebSocket のようなストリーム通信では、あらゆるメッセージを統一フレーム構造で包み、discriminator フィールドで型安全に判別すべき。なぜなら、フレーム種別の判定ロジックが散在するとプロトコル拡張時にクライアント実装漏れが生じるため（`GatewayFrameSchema` の `type` discriminator）
- **バリデーションの境界配置**: API ハンドラの最初でスキーマバリデーションを実行し、通過後は信頼できる型として扱うべき。なぜなら、バリデーションが遅延すると不正データが深層に侵入し、エラーの発生箇所と原因が乖離するため（全 server-methods ハンドラの冒頭バリデーションパターン）

## 実例と分析

### 1. TypeBox によるスキーマ一元定義と多言語コード生成パイプライン

プロトコルスキーマの定義は `src/gateway/protocol/schema/` 以下に TypeBox で記述される。TypeBox は JSON Schema 互換のオブジェクトを生成するため、ランタイムバリデーション（AJV）とコード生成の両方で直接利用できる。

スキーマからの生成チェーン:

1. **TypeBox 定義** → `Static<typeof Schema>` で TypeScript 型を導出（`schema/types.ts`）
2. **TypeBox 定義** → AJV バリデータをコンパイル（`protocol/index.ts`）
3. **TypeBox 定義** → `scripts/protocol-gen.ts` で JSON Schema ファイルを生成
4. **JSON Schema** → `scripts/protocol-gen-swift.ts` で Swift Codable struct を生成

このパイプラインにより、90 以上のスキーマ定義（`ProtocolSchemas` レジストリ）が TypeScript 型・バリデータ・JSON Schema・Swift モデルの 4 形態に一貫して展開される。

### 2. WebSocket フレームプロトコル設計

Gateway WebSocket は req/res/event の 3 種フレームを `type` フィールドで判別する discriminated union として設計されている。

```typescript
// src/gateway/protocol/schema/frames.ts:126-164
export const RequestFrameSchema = Type.Object(
  {
    type: Type.Literal("req"),
    id: NonEmptyString,
    method: NonEmptyString,
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ResponseFrameSchema = Type.Object(
  {
    type: Type.Literal("res"),
    id: NonEmptyString,
    ok: Type.Boolean(),
    payload: Type.Optional(Type.Unknown()),
    error: Type.Optional(ErrorShapeSchema),
  },
  { additionalProperties: false },
);

export const EventFrameSchema = Type.Object(
  {
    type: Type.Literal("event"),
    event: NonEmptyString,
    payload: Type.Optional(Type.Unknown()),
    seq: Type.Optional(Type.Integer({ minimum: 0 })),
    stateVersion: Type.Optional(StateVersionSchema),
  },
  { additionalProperties: false },
);

export const GatewayFrameSchema = Type.Union(
  [RequestFrameSchema, ResponseFrameSchema, EventFrameSchema],
  { discriminator: "type" },
);
```

`discriminator` オプションにより、コード生成ツール（quicktype 等）が全プロパティ optional の blob ではなく、正確な型を生成できる。

### 3. メソッドディスパッチとスコープベース認可

Gateway は JSON-RPC 風の `method` フィールドでハンドラをディスパッチする。各ハンドラは Record 型で静的にマッピングされ、認可はメソッド名ベースのスコープマッチングで行われる。

```typescript
// src/gateway/server-methods.ts:171-197
export const coreGatewayHandlers: GatewayRequestHandlers = {
  ...connectHandlers,
  ...logsHandlers,
  ...channelsHandlers,
  ...chatHandlers,
  ...configHandlers,
  ...wizardHandlers,
  // ... 20+ ハンドラグループをスプレッド
};

export async function handleGatewayRequest(opts) {
  const authError = authorizeGatewayMethod(req.method, client);
  if (authError) {
    respond(false, undefined, authError);
    return;
  }
  const handler = opts.extraHandlers?.[req.method] ?? coreGatewayHandlers[req.method];
  if (!handler) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unknown method: ${req.method}`));
    return;
  }
  await handler({ req, params, client, respond, context });
}
```

認可ロジックは `READ_METHODS` / `WRITE_METHODS` / `ADMIN_METHOD_PREFIXES` 等の静的 Set で管理され、メソッド追加時に認可漏れが起きにくい構造になっている。

### 4. ハンドラ冒頭バリデーション + 構造化エラー応答パターン

全ハンドラが同一のバリデーション → エラー応答パターンを踏襲している。

```typescript
// src/gateway/server-methods/config.ts:132-147
"config.get": async ({ params, respond }) => {
  if (!validateConfigGetParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid config.get params: ${formatValidationErrors(validateConfigGetParams.errors)}`,
      ),
    );
    return;
  }
  // バリデーション通過後は型安全な操作のみ
  const snapshot = await readConfigFileSnapshot();
  respond(true, redactConfigSnapshot(snapshot, schema.uiHints), undefined);
},
```

`ErrorShape` は `code` + `message` + `retryable` + `retryAfterMs` の構造化エラーで、クライアント側でプログラマティックなエラーハンドリングを可能にしている。

### 5. ツール入力スキーマの AI 互換性ガードレール

LLM がツールの入力スキーマを解釈して引数を生成する場面において、`Type.Union` を避け `stringEnum` ヘルパーを使用する規約が確立されている。

```typescript
// src/agents/schema/typebox.ts:13-24
// NOTE: Avoid Type.Union([Type.Literal(...)]) which compiles to anyOf.
// Some providers reject anyOf in tool schemas; a flat string enum is safer.
export function stringEnum<T extends readonly string[]>(
  values: T,
  options: StringEnumOptions<T> = {},
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}
```

`Type.Union([Type.Literal("a"), Type.Literal("b")])` は `anyOf` に展開されるが、`stringEnum` は `{ type: "string", enum: ["a", "b"] }` にフラット化される。これにより LLM プロバイダのスキーマバリデータ拒否を回避しつつ、LLM の理解精度を向上させている。

### 6. 複数 API サーフェスの共存（プロトコル変換レイヤー）

Gateway は 3 つの API サーフェスを同時に提供する:

- **WebSocket (JSON-RPC 風)**: ネイティブプロトコル（`server-methods.ts`）
- **OpenAI Chat Completions 互換 HTTP**: `/v1/chat/completions`（`openai-http.ts`）
- **OpenResponses 互換 HTTP**: `/v1/responses`（`openresponses-http.ts`, Zod スキーマ）
- **ACP (Agent Client Protocol)**: IDE 統合用（`src/acp/translator.ts`）

ACP Translator は ACP SDK のインターフェースを実装しつつ、内部では Gateway WebSocket メソッド（`chat.send`, `sessions.list` 等）を呼び出す。このプロトコル変換レイヤーにより、内部表現を変えずに外部プロトコルを追加できる。

```typescript
// src/acp/translator.ts:226-274
async prompt(params: PromptRequest): Promise<PromptResponse> {
  // ACP の prompt を Gateway の chat.send に変換
  this.gateway.request("chat.send", {
    sessionKey: session.sessionKey,
    message,
    attachments,
    idempotencyKey: runId,
  }, { expectFinal: true });
}
```

## パターンカタログ

- **Adapter パターン** (構造パターン)
  - 解決する問題: 外部プロトコル（OpenAI API, ACP）と内部プロトコルのインピーダンスミスマッチ
  - 適用条件: 複数の外部クライアントプロトコルを単一の内部 API にマッピングする必要がある場合
  - コード例: `src/acp/translator.ts:53` (AcpGatewayAgent), `src/gateway/openai-http.ts`
  - 注意点: 変換レイヤーが厚くなると内部 API の変更が波及しやすい。内部 API の安定性を優先すること

- **Registry パターン** (構造パターン)
  - 解決する問題: メソッドハンドラの動的登録と拡張
  - 適用条件: プラグインやモジュール単位でハンドラを追加可能にしたい場合
  - コード例: `src/gateway/server-methods.ts:171` (coreGatewayHandlers), `src/gateway/protocol/schema/protocol-schemas.ts:142` (ProtocolSchemas)
  - 注意点: Registry に登録されたキーの一意性を静的に保証できないため、重複チェックが必要

## Good Patterns

- **`additionalProperties: false` の全スキーマ適用**: 全 TypeBox スキーマに `{ additionalProperties: false }` を付与することで、クライアントのタイポや未定義フィールドの混入を即座に検出する。バリデータが余分なフィールドを明示的にエラー報告する (`src/gateway/protocol/index.ts:382-389`)

```typescript
// src/gateway/protocol/schema/frames.ts:20-68
export const ConnectParamsSchema = Type.Object(
  {
    minProtocol: Type.Integer({ minimum: 1 }),
    maxProtocol: Type.Integer({ minimum: 1 }),
    client: Type.Object({/* ... */}, { additionalProperties: false }),
    // ...
  },
  { additionalProperties: false }, // 全階層に適用
);
```

- **エラーコードの列挙型定数化**: エラーコードを `const` オブジェクトで列挙し、`errorShape` ファクトリ関数で構造化エラーを生成する。コード中でマジックストリングが散在しない

```typescript
// src/gateway/protocol/schema/error-codes.ts:3-23
export const ErrorCodes = {
  NOT_LINKED: "NOT_LINKED",
  NOT_PAIRED: "NOT_PAIRED",
  AGENT_TIMEOUT: "AGENT_TIMEOUT",
  INVALID_REQUEST: "INVALID_REQUEST",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

export function errorShape(code: ErrorCode, message: string, opts?) {
  return { code, message, ...opts };
}
```

- **冪等性キーによる重複排除**: `send` や `agent` 等の副作用を持つメソッドに `idempotencyKey` を必須化し、WeakMap + dedupe Map で同一リクエストのインフライト共有とキャッシュ応答を実現している (`src/gateway/server-methods/send.ts:70-86`)

## Anti-Patterns / 注意点

- **ハンドラ内での `as` による型キャスト乱用**: バリデーション通過後でも `params as { raw?: unknown }` のようなキャストが頻出する。これはバリデーション済みの params に正確な型が付与されていないことに起因する

```typescript
// Bad: バリデーション通過後なのに手動キャスト
const rawValue = (params as { raw?: unknown; }).raw;

// Better: バリデータの型パラメータを活用し、通過後はキャスト不要にする
if (!validateConfigSetParams(params)) return;
// params は ConfigSetParams 型として推論される
const { raw } = params;
```

- **プロトコルスキーマでの `Type.Union` 使用とツールスキーマでの禁止の不一致**: プロトコルスキーマ（`SessionsPatchParamsSchema` 等）では `Type.Union([NonEmptyString, Type.Null()])` を多用しているが、ツールスキーマでは `Type.Union` を禁止している。適用範囲の違いは理解できるが、コードベース内の一貫性を損なう可能性がある

## 導出ルール

- `[MUST]` API スキーマは単一の型定義ライブラリ（TypeBox / Zod 等）で一元管理し、バリデーション・型推論・コード生成を同一ソースから導出する
  - 根拠: OpenClaw は TypeBox 定義から TS 型（`Static<>`）、AJV バリデータ、JSON Schema、Swift モデルの 4 形態を自動生成しており、90 以上のスキーマの一貫性を保っている（`src/gateway/protocol/schema/`, `scripts/protocol-gen*.ts`）
- `[MUST]` API ハンドラはロジック実行前の最初の処理としてスキーマバリデーションを実行し、失敗時はエラーコード付きの構造化エラーを返す
  - 根拠: 全 30 以上の server-methods ハンドラが冒頭バリデーション → `errorShape(ErrorCodes.INVALID_REQUEST, ...)` パターンを一貫して実装し、不正データの深層侵入を防いでいる（`src/gateway/server-methods/config.ts:132-147`）
- `[MUST]` 副作用を持つ API エンドポイントには冪等性キーを必須パラメータとして設計し、重複実行を防ぐ
  - 根拠: `SendParamsSchema`, `AgentParamsSchema`, `NodeInvokeParamsSchema` 等すべての副作用メソッドに `idempotencyKey: NonEmptyString` が必須で、dedupe Map によるインフライト共有とキャッシュ応答が実装されている（`src/gateway/server-methods/send.ts:70-86`）
- `[SHOULD]` WebSocket 等のストリーム通信プロトコルでは、全メッセージを discriminator フィールドで判別可能なフレーム構造に統一する
  - 根拠: `GatewayFrameSchema` は `type` discriminator で req/res/event を判別し、コード生成が正確な型を出力できる構造を維持している（`src/gateway/protocol/schema/frames.ts:161-164`）
- `[SHOULD]` LLM が解釈するツール入力スキーマでは `anyOf` / `oneOf` / `allOf` を避け、フラットな `{ type: "string", enum: [...] }` 形式を使う
  - 根拠: `stringEnum` ヘルパーが `Type.Unsafe` で JSON Schema レベルのフラット enum を生成し、LLM プロバイダのスキーマバリデータ拒否と LLM の解釈精度低下を回避している（`src/agents/schema/typebox.ts:13-24`）
- `[SHOULD]` 複数の外部 API プロトコルをサポートする場合、内部プロトコルを安定させてプロトコル変換レイヤー（Adapter）を介して接続する
  - 根拠: Gateway WebSocket を内部プロトコルとし、OpenAI 互換 HTTP・OpenResponses・ACP をそれぞれ Adapter で接続することで、外部プロトコル追加時に内部ロジックの変更が不要な構造を実現している（`src/acp/translator.ts`, `src/gateway/openai-http.ts`）
- `[AVOID]` スキーマバリデーション通過後に `as` による手動型キャストを行うこと。バリデータの型パラメータを正しく設定し、通過後は推論された型を使う
  - 根拠: `config.ts` 等の複数ハンドラで `(params as { raw?: unknown }).raw` のようなキャストが散見され、バリデーション済みの型安全性が形骸化している

## 適用チェックリスト

- [ ] API スキーマが単一ソース（TypeBox / Zod 等）で定義され、型・バリデーション・ドキュメントが自動導出されているか
- [ ] スキーマ定義に `additionalProperties: false` 相当の制約が付与され、未知フィールドを拒否しているか
- [ ] 全 API ハンドラの冒頭でスキーマバリデーションが実行され、構造化エラー（code + message）が返されているか
- [ ] 副作用を持つエンドポイントに冪等性キーが設計されているか
- [ ] エラーコードが列挙型定数として一元管理され、マジックストリングが排除されているか
- [ ] WebSocket / ストリーム API がフレーム構造を持ち、discriminator で型判別が可能か
- [ ] LLM 向けツールスキーマで Union / anyOf を使用していないか（フラット enum に変換できるか）
- [ ] 外部プロトコル対応が Adapter パターンで分離され、内部 API の変更が外部に波及しない構造か
- [ ] スキーマからのコード生成パイプライン（JSON Schema → 他言語モデル等）が CI に組み込まれているか
