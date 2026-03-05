# provider-abstraction

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

マルチプロバイダー対応の LLM クライアントにおける抽象化レイヤーの設計を分析する。opencode は 20 以上の AI プロバイダー（Anthropic, OpenAI, Google, AWS Bedrock, Azure, GitHub Copilot 等）を単一インターフェースで扱い、外部レジストリ（models.dev）からモデルメタデータを動的に取得する。注目すべきは、プロバイダーごとの差異をコア呼び出しロジックに漏洩させず、3 層の変換レイヤー（SDK ファクトリ / カスタムローダー / メッセージトランスフォーム）で吸収している点である。

## 背景にある原則

- **外部レジストリによるメタデータ分離**: モデルのケイパビリティ・コスト・制限値をコードに埋め込まず、外部 API（models.dev/api.json）から取得し、ビルド時スナップショットとキャッシュのフォールバックチェーンで可用性を担保する。これにより新モデル追加時にコード変更が不要になる（`models.ts:88-99`）。
- **npm パッケージ名を識別子とするプロバイダー解決**: プロバイダーの振る舞い分岐を `model.api.npm` の値で行う。プロバイダー名のような曖昧な文字列ではなく、npm パッケージ名という一意な識別子を使うことで、同一プロバイダーの異なるバックエンド（例: Google Vertex の Anthropic モデル `@ai-sdk/google-vertex/anthropic`）を正確に区別できる。
- **段階的マージによる設定合成**: 外部レジストリ → 環境変数 → 認証ストア → プラグイン → ユーザー設定 の順でプロバイダー情報を `mergeDeep` で重ね合わせ、後からの設定が優先される。部分的なオーバーライドを可能にしつつ、デフォルト値を保持する（`provider.ts:832-1007`）。
- **プロバイダー固有の差異は境界層で吸収する**: コアのストリーミングロジック（`llm.ts`）はプロバイダーを意識せず、呼び出し直前に `ProviderTransform` がメッセージ形式・オプション・スキーマをプロバイダーごとに変換する。これにより呼び出し側のコードは単一パスを維持できる。

## 実例と分析

### 3 段フォールバックによるモデルデータ取得

モデルメタデータの取得に 3 段のフォールバックを設けている。ローカルキャッシュ → ビルド時スナップショット → リモート API の順に試行し、どの段階でも同一スキーマのデータが返る。

```typescript
// provider/models.ts:88-99
export const Data = lazy(async () => {
  const result = await Filesystem.readJson(Flag.OPENCODE_MODELS_PATH ?? filepath).catch(() => {});
  if (result) return result;
  // @ts-ignore
  const snapshot = await import("./models-snapshot")
    .then((m) => m.snapshot as Record<string, unknown>)
    .catch(() => undefined);
  if (snapshot) return snapshot;
  if (Flag.OPENCODE_DISABLE_MODELS_FETCH) return {};
  const json = await fetch(`${url()}/api.json`).then((x) => x.text());
  return JSON.parse(json);
});
```

`lazy` ユーティリティの `reset()` メソッドにより、バックグラウンドでの定期リフレッシュ後にキャッシュを無効化できる（`models.ts:119`）。

### バンドル済みプロバイダーと動的インストールの二重戦略

よく使われるプロバイダーは静的インポートでバンドルし、マイナーなプロバイダーは `BunProc.install` で実行時に npm パッケージをインストールする。SDK インスタンスはハッシュキーでキャッシュし、同一設定での再生成を防ぐ。

```typescript
// provider/provider.ts:87-110
const BUNDLED_PROVIDERS: Record<string, (options: any) => SDK> = {
  "@ai-sdk/amazon-bedrock": createAmazonBedrock,
  "@ai-sdk/anthropic": createAnthropic,
  "@ai-sdk/azure": createAzure,
  // ... 15+ providers
};

// provider/provider.ts:1134-1161
const bundledFn = BUNDLED_PROVIDERS[model.api.npm];
if (bundledFn) {
  const loaded = bundledFn({ name: model.providerID, ...options });
  s.sdk.set(key, loaded);
  return loaded as SDK;
}
// Non-bundled: install at runtime
let installedPath = await BunProc.install(model.api.npm, "latest");
const mod = await import(installedPath);
const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!];
```

### カスタムローダーによるプロバイダー固有の初期化

`CUSTOM_LOADERS` マップで、プロバイダーごとの認証・環境変数解決・モデル取得ロジックをカプセル化している。`autoload` フラグでクレデンシャルの有無に基づく自動有効化を制御し、`getModel` コールバックで API バージョン（Chat vs Responses）の選択を抽象化する。

```typescript
// provider/provider.ts:119-131, 153-169
const CUSTOM_LOADERS: Record<string, CustomLoader> = {
  async anthropic() {
    return {
      autoload: false,
      options: { headers: { "anthropic-beta": "..." } },
    };
  },
  "github-copilot": async () => {
    return {
      autoload: false,
      async getModel(sdk: any, modelID: string) {
        if (sdk.responses === undefined && sdk.chat === undefined) {
          return sdk.languageModel(modelID);
        }
        return shouldUseCopilotResponsesApi(modelID)
          ? sdk.responses(modelID)
          : sdk.chat(modelID);
      },
    };
  },
};
```

### メッセージ変換のプロバイダー分岐

`ProviderTransform.normalizeMessages` では、プロバイダー固有のメッセージ制約を呼び出し直前に吸収する。Anthropic の空メッセージ拒否、Claude の toolCallId 正規化、Mistral の 9 文字制限などが個別に処理される。

```typescript
// provider/transform.ts:52-71
if (model.api.npm === "@ai-sdk/anthropic") {
  msgs = msgs
    .map((msg) => {
      if (typeof msg.content === "string") {
        if (msg.content === "") return undefined;
        return msg;
      }
      // ... empty text/reasoning parts filtering
    })
    .filter((msg): msg is ModelMessage => msg !== undefined);
}
```

### 正規表現パターンによるコンテキストオーバーフロー検出

プロバイダーごとに異なるオーバーフローエラーメッセージを、正規表現リストで統一的に検出する。

```typescript
// provider/error.ts:8-23
const OVERFLOW_PATTERNS = [
  /prompt is too long/i, // Anthropic
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI
  /input token count.*exceeds the maximum/i, // Google
  /maximum prompt length is \d+/i, // xAI
  // ... 7 more patterns
];
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: プロバイダーごとに異なる SDK 初期化・モデル取得ロジック
  - 適用条件: 同一インターフェースで複数バックエンドを切り替える場面
  - コード例: `provider/provider.ts:119-611` の `CUSTOM_LOADERS` マップ
  - 注意点: 各ストラテジーが `{ autoload, getModel?, options? }` の統一形状を返すことで、呼び出し側は分岐を持たない

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 複数ソースからの設定を優先度順に合成
  - 適用条件: 設定の上書き優先度が定義されている場面
  - コード例: `provider/provider.ts:778-1007` のプロバイダー state 初期化（DB → env → auth → plugin → config の順に `mergeDeep`）
  - 注意点: 後段の設定が前段を完全に上書きするのではなく `mergeDeep` で部分マージする点が典型的な Chain of Responsibility と異なる

## Good Patterns

- **npm パッケージ名をディスパッチキーに使う**: `model.api.npm` でプロバイダーの SDK パッケージを特定し、バンドル済み/動的インストールの分岐、`providerOptions` のキーマッピング、メッセージ変換ルールの選択に一貫して使用する。プロバイダー ID は表示名であり、SDK の識別には npm パッケージ名を使うことで、同一プロバイダーの複数バックエンド対応や OpenAI 互換 API の適切なルーティングが可能になる。

```typescript
// provider/transform.ts:24-45
function sdkKey(npm: string): string | undefined {
  switch (npm) {
    case "@ai-sdk/openai":
    case "@ai-sdk/azure":
      return "openai";
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic":
      return "anthropic";
      // ...
  }
}
```

- **ケイパビリティベースのモデル記述**: モデルの能力を boolean フラグ（`reasoning`, `attachment`, `toolcall`）とモダリティマップ（`input.image`, `output.text` 等）で宣言的に記述する。呼び出し側はモデル ID の文字列パターンマッチではなく、ケイパビリティフラグを参照して振る舞いを決定する。

```typescript
// provider/transform.ts:214-249 — unsupportedParts
if (!model.capabilities.input[modality]) return part;
// → サポートしないモダリティはエラーテキストに変換
```

- **resettable lazy でキャッシュと再取得を両立**: `lazy` ユーティリティに `reset()` を付与し、初回は遅延評価でキャッシュしつつ、定期リフレッシュ後にキャッシュ無効化して次回アクセスで再取得する。

## Anti-Patterns / 注意点

- **プロバイダー分岐の string match 散在**: `ProviderTransform` 内で `model.api.id.includes("claude")` や `model.id.toLowerCase().includes("qwen")` のようなモデル ID の部分文字列マッチが多数存在する（`transform.ts:74, 294-307`）。新モデル追加時にマッチ漏れやフォールスポジティブが発生しやすい。

```typescript
// Bad: モデル ID の部分文字列マッチが散在
if (id.includes("qwen")) return 0.55;
if (id.includes("claude")) return undefined;
if (id.includes("gemini")) return 1.0;

// Better: ケイパビリティフラグやプロバイダーメタデータに温度設定を含め、
// モデルデータ側で宣言的に管理する
const temp = model.defaults?.temperature ?? undefined;
```

- **巨大な switch 文によるバリアント定義**: `ProviderTransform.variants` 関数（`transform.ts:332-679`）は 350 行の switch 文で各プロバイダーの reasoning effort バリアントを定義している。プロバイダー追加のたびにこの関数が肥大化する。

```typescript
// Bad: 350 行の switch 文
switch (model.api.npm) {
  case "@ai-sdk/openai": // 30 行
  case "@ai-sdk/anthropic": // 25 行
  case "@ai-sdk/google": // 20 行
    // ...
}

// Better: バリアント定義もモデルメタデータ（models.dev）側に持たせ、
// コードはメタデータの読み取りのみ行う
```

## 導出ルール

- `[MUST]` マルチプロバイダー対応では、プロバイダー固有のメッセージ変換・エラー処理をコアロジックから分離し、境界層（Transform レイヤー）に集約する
  - 根拠: opencode は `ProviderTransform` 名前空間にすべてのプロバイダー固有変換を集約し、`llm.ts` のストリーミングロジックはプロバイダー非依存を維持している（`llm.ts:98-99, 202, 241`）

- `[MUST]` 外部レジストリからメタデータを取得する場合、ローカルキャッシュ → ビルド時スナップショット → リモート API の多段フォールバックを実装し、オフライン環境でも動作を保証する
  - 根拠: `ModelsDev.Data` はファイルキャッシュ → import スナップショット → fetch の 3 段で、ネットワーク不通時もビルド時データで動作する（`models.ts:88-99`）

- `[SHOULD]` プロバイダーの振る舞い分岐には、表示名やモデル ID の部分文字列マッチではなく、パッケージ名やケイパビリティフラグなど一意で宣言的な識別子を使う
  - 根拠: `sdkKey(npm)` は npm パッケージ名で `providerOptions` キーを解決し、`@ai-sdk/google-vertex/anthropic` のような複合プロバイダーも正確に識別する（`transform.ts:24-45`）

- `[SHOULD]` よく使うプロバイダー SDK はバンドルし、マイナーなものは実行時動的インストールする二重戦略で、バイナリサイズと拡張性を両立する
  - 根拠: `BUNDLED_PROVIDERS` に 18 のメジャー SDK を静的インポートし、それ以外は `BunProc.install` でオンデマンドインストールする（`provider.ts:87-110, 1146-1161`）

- `[SHOULD]` 複数ソースの設定をマージする際は、各ソースの優先度を明示し、部分オーバーライド（`mergeDeep`）で合成する。全置換ではなく差分適用にすることで、ユーザーは変更したいフィールドだけを指定できる
  - 根拠: provider state 初期化は DB → env → auth → plugin → config の 5 段で `mergeDeep` し、後段は前段の未指定フィールドを保持する（`provider.ts:818-1007`）

- `[AVOID]` プロバイダー固有のエラーメッセージを個別に `if` 文で判定する設計。代わりに正規表現リストやエラーコードマップで一括管理し、新プロバイダー追加をデータ追加に留める
  - 根拠: `OVERFLOW_PATTERNS` は 13 個の正規表現で全プロバイダーのオーバーフロー検出を統一し、新パターン追加は配列への 1 行追加で完了する（`error.ts:8-23`）

## 適用チェックリスト

- [ ] プロバイダー固有の処理がコアロジックに散在していないか確認し、Transform / Adapter レイヤーに集約する
- [ ] 外部データソースに依存する場合、オフラインフォールバック（キャッシュ / スナップショット）を実装しているか
- [ ] プロバイダーの識別に使う値が一意で安定しているか（表示名や部分文字列マッチに依存していないか）
- [ ] 新プロバイダー追加時の変更箇所が最小限（データ追加のみ）になっているか。コード変更が必要な場所をリストアップする
- [ ] 設定のマージ戦略が明示されているか。優先度の順序と全置換/部分マージの区別がドキュメント化されているか
- [ ] SDK インスタンスのキャッシュ戦略があるか。同一設定での SDK 再生成を防いでいるか
- [ ] エラーメッセージのプロバイダー差異をデータ駆動（パターンリスト / マップ）で吸収しているか
