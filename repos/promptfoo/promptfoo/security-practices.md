# security-practices

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

promptfoo は LLM のセキュリティテスト（Red Teaming）を行うツールであり、セキュリティをテストする側でありながら自身のコードベースにも多層的なセキュリティプラクティスを適用している。特に注目に値するのは、(1) Lint ルールで fetch 直接使用を禁止しプロキシ経由に一本化する強制パターン、(2) ログ出力時の再帰的秘匿情報サニタイズ、(3) 依存関係更新に時間遅延を設けるサプライチェーン防御、(4) Zod スキーマによる API 入力の境界バリデーション、(5) ReDoS 防御を意識した正規表現設計である。「セキュリティテストツール自体のセキュリティ」という自己言及的な課題に対し、実用的かつ体系的に取り組んでいる。

## 背景にある原則

- **Single Point of Control（制御の一元化）**: ネットワーク通信・ログ出力・データベースアクセスといったセキュリティ上重要な操作を単一の関数/レイヤに集約することで、ポリシーの一貫性を保証する。fetch の直接使用を禁止し `fetchWithProxy` に一元化するのが典型例（`biome.jsonc:131-152`）。これにより、TLS 設定・プロキシ・リトライ・ログ記録が全リクエストに自動適用される。
- **Defense in Depth（多層防御）**: 秘匿情報の漏洩防止をフィールド名マッチ・値パターンマッチ・URL パラメータサニタイズの 3 層で行う（`src/util/sanitizer.ts`）。単一の防御層が破られても他層で捕捉できる設計。
- **Shift Left Security（セキュリティの前倒し）**: Renovate の `minimumReleaseAge` 設定で依存関係の自動更新に時間遅延を設け、悪意あるパッケージの unpublish/supply-chain 攻撃を吸収する（`renovate.json:250-266`、`CONTRIBUTING.md:8`）。問題発生後の対処ではなく、問題が到達する前に時間的バッファを設ける。
- **Trust Boundary の明示化**: `SECURITY.md` で「信頼される入力」と「信頼されない入力」を明確に分類し、脆弱性のスコープを定義している。曖昧なセキュリティモデルではなく、境界を文書化することで開発者とセキュリティ研究者の認識を一致させる。

## 実例と分析

### fetch 一元化と Lint による強制

promptfoo はグローバル `fetch`、`node-fetch`、`undici.fetch`、`cross-fetch` の直接使用を Biome の Lint ルールで禁止している。全ての HTTP リクエストは `fetchWithProxy()` を経由する必要がある。

```typescript
// biome.jsonc:131-152
"noRestrictedGlobals": {
  "level": "error",
  "options": {
    "deniedGlobals": {
      "fetch": "Use fetchWithProxy() instead of global fetch()."
    }
  }
},
"noRestrictedImports": {
  "level": "error",
  "options": {
    "paths": {
      "node-fetch": "Use fetchWithProxy() (do not import node-fetch directly).",
      "undici": {
        "importNames": ["fetch", "default"],
        "message": "Use fetchWithProxy() instead of undici.fetch."
      },
      "cross-fetch": "Use fetchWithProxy() instead."
    }
  }
}
```

`fetchWithProxy()` は単なるラッパーではなく、TLS 設定、カスタム CA 証明書、プロキシ設定、トランジェントエラーのリトライ、URL 内認証情報の Authorization ヘッダへの移動を一箇所で処理する（`src/util/fetch/index.ts:106-224`）。テストファイルでは `noRestrictedGlobals: "off"` としてルールを緩和している点も実用的な判断である（`biome.jsonc:266-283`）。

### 再帰的ログサニタイズ

ログ出力時、全てのコンテキストオブジェクトが自動的にサニタイズされる。このサニタイズは 3 段階で行われる。

```typescript
// src/util/sanitizer.ts:17-76
// 第1層: フィールド名による検出（76種の秘匿フィールド名を正規化して照合）
export const SECRET_FIELD_NAMES = new Set([
  'password', 'passwd', 'pwd', 'secret', 'apikey',
  'token', 'accesstoken', 'authorization', 'bearer',
  'xapikey', 'xcsrftoken', 'privatekey', ...
]);

// src/util/sanitizer.ts:96-148
// 第2層: 値パターンによる検出（OpenAI/Anthropic/AWS/Google の鍵パターン）
export function looksLikeSecret(value: string): boolean {
  if (/^sk-[a-zA-Z0-9-_]{20,}/.test(value)) return true;  // OpenAI
  if (/^sk-ant-[a-zA-Z0-9-_]{20,}/.test(value)) return true;  // Anthropic
  if (/^AKIA[A-Z0-9]{16}/.test(value)) return true;  // AWS
  if (/^AIza[a-zA-Z0-9_-]{35}/.test(value)) return true;  // Google
  // ...
}

// src/util/sanitizer.ts:315-379
// 第3層: URL パラメータのサニタイズ
export function sanitizeUrl(url: string): string {
  // クエリパラメータ名が api_key, token 等にマッチする場合 [REDACTED]
  const sensitiveParams = /(api[_-]?key|token|password|secret|...)/i;
  for (const key of Array.from(sanitizedUrl.searchParams.keys())) {
    if (sensitiveParams.test(key)) {
      sanitizedUrl.searchParams.set(key, '[REDACTED]');
    }
  }
}
```

ロガー自体がサニタイズ機能を内蔵しており、開発者が個別にサニタイズを呼び出す必要がない（`src/logger.ts:344-358`）。

### Zod スキーマによる API 入力バリデーション

サーバーサイドの API エンドポイントでは、Zod スキーマによる入力バリデーションが体系化されている。スキーマは `src/types/api/` に集約され、ルートハンドラで `safeParse` / `parse` を使い分ける。

```typescript
// src/server/routes/eval.ts:39-44
evalRouter.post('/job', (req: Request, res: Response): void => {
  const result = EvalSchemas.CreateJob.Request.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: z.prettifyError(result.error) });
    return;
  }
  // バリデーション済みデータを使用
```

パターンとして、リクエストバリデーションには `safeParse()`（エラーをキャッチして 400 を返す）、レスポンスバリデーションには `parse()`（不正な出力は例外として捕捉）を使い分けている（`src/server/AGENTS.md:57-67`）。

### サプライチェーン防御の時間遅延戦略

Renovate の設定で、パッケージの種類ごとに異なる `minimumReleaseAge` を設定している。

```jsonc
// renovate.json:250-266
// ランタイム依存: 5日遅延
{ "matchDatasources": ["npm"], "matchDepTypes": ["dependencies"], "minimumReleaseAge": "5 days" },
// 開発依存: 2日遅延
{ "matchDatasources": ["npm"], "matchDepTypes": ["devDependencies"], "minimumReleaseAge": "2 days" },
// LLM プロバイダ SDK: 遅延なし（頻繁な更新が必要）
{ "matchPackagePatterns": ["^@anthropic-ai/", "^@openai/", ...], "minimumReleaseAge": "0 days" }
```

ランタイム依存は 5 日、開発依存は 2 日の遅延を設けることで、npm unpublish ウィンドウ（72 時間）や悪意あるバージョンの検出猶予期間を確保している。一方、LLM プロバイダ SDK は API 変更への追従が重要なため遅延なしとしている。リスクレベルに応じた段階的遅延は、セキュリティと開発速度のバランスを取る実用的な判断である。

### ReDoS 防御の意識的な設計

正規表現を使う箇所で ReDoS（Regular Expression Denial of Service）を明示的に意識した設計が随所に見られる。

```typescript
// src/util/sanitizer.ts:334
// Use simple string check instead of regex to avoid ReDoS vulnerability
if (url.includes('{{') && url.includes('}}')) { return url; }

// src/util/render.ts:41-44
// Prevent ReDoS: Skip regex matching on extremely long strings
const MAX_STRING_LENGTH = 50000;
if (obj.length > MAX_STRING_LENGTH) { /* skip */ }

// src/assertions/html.ts:7-19
// Opening tags with optional attributes - fixed to prevent ReDoS
openingTag: /<[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?>/,
// HTML comments - using non-greedy quantifier to prevent ReDoS
htmlComment: /<!--[^-]*(?:-[^-]+)*-->/,

// src/util/text.ts:16-19
// 動的入力から正規表現を組み立てる際のエスケープユーティリティ
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

### トレーシングデータの属性サニタイズ

OpenTelemetry トレースデータにも秘匿情報のサニタイズが適用される。デフォルトで `sanitizeAttributes: true` が有効になっている。

```typescript
// src/tracing/store.ts:39-82
const SENSITIVE_ATTRIBUTE_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "api_key",
  "apikey",
  "secret",
  "password",
  "passphrase",
];

function sanitizeAttributes(attributes: Record<string, any>): Record<string, any> {
  for (const [key, value] of Object.entries(attributes)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_ATTRIBUTE_KEYS.some((sensitiveKey) => lowerKey.includes(sensitiveKey))) {
      sanitized[key] = "<redacted>";
      continue;
    }
    sanitized[key] = sanitizeValue(value); // 長い文字列は400文字に切り詰め
  }
}
```

## パターンカタログ

- **Proxy パターン** (分類: 構造)
  - 解決する問題: ネットワーク通信のポリシー（TLS、プロキシ、リトライ、ログ）を各呼び出し箇所で個別に実装する重複と不整合
  - 適用条件: セキュリティポリシーの一貫性が求められる外部通信が複数箇所に存在する場合
  - コード例: `src/util/fetch/index.ts:106-224`
  - 注意点: Lint ルールで直接使用を禁止しないと、新規コードで迂回される

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 秘匿情報の検出ロジックが単一のルールに依存すると、漏れが発生する
  - 適用条件: 秘匿情報の形態が多様（フィールド名、値パターン、URL パラメータ）で単一ルールでは捕捉しきれない場合
  - コード例: `src/util/sanitizer.ts` の 3 層サニタイズ
  - 注意点: 各層の検出ルールが重複しすぎるとパフォーマンスに影響する

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: Red Team プラグインごとに共通の生成・評価フローを持ちつつ、テストケースとルーブリックだけを差し替えたい
  - 適用条件: プラグインの種類が多く（100+）、共通フローの変更が全プラグインに波及する必要がある場合
  - コード例: `src/redteam/plugins/base.ts:33-89`（`RedteamPluginBase` / `RedteamGraderBase`）
  - 注意点: 基底クラスの変更が全プラグインに影響するため、インターフェースの安定性が重要

## Good Patterns

- **Lint ルールによるセキュリティポリシーの強制**: コードレビューの人的判断に依存せず、Biome の `noRestrictedGlobals` / `noRestrictedImports` で fetch 直接使用をコンパイル時に検出する。ルールにはエラーメッセージで代替手段（`fetchWithProxy()`）を明示しており、開発者が即座に正しい方法を知ることができる（`biome.jsonc:131-152`）。

- **値ベースの秘匿情報検出**: フィールド名だけでなく、値そのものが秘匿情報のパターン（`sk-`、`AKIA`、`Bearer` 等）にマッチするかを検査する。これにより、`data` や `content` のような汎用的なフィールド名に格納された API キーも検出できる（`src/util/sanitizer.ts:96-148`）。

- **リスクレベル別の依存関係更新遅延**: ランタイム依存（5日）> 開発依存（2日）> LLM SDK（0日）の段階的遅延で、サプライチェーンリスクと開発速度のトレードオフを最適化している（`renovate.json:250-266`）。

- **Trust Boundary の文書化**: `SECURITY.md` で信頼境界を明示し、In-scope / Out-of-scope を具体例付きで定義している。「カスタムアサーションが `process.env` を読むのは仕様通り」のような判断基準が明確で、誤報を減らす（`SECURITY.md:19-93`）。

## Anti-Patterns / 注意点

- **CORS ワイルドカード許可**: サーバーで `app.use(cors())` および Socket.IO に `cors: { origin: '*' }` を設定しており、全オリジンからのアクセスを許可している。ローカル開発ツールとして設計されているため意図的だが、このパターンを本番サービスに持ち込むと CSRF 等の脆弱性となる（`src/server/server.ts:121, 318-320`）。

```typescript
// Bad: 全オリジン許可
app.use(cors());
const io = new SocketIOServer(httpServer, { cors: { origin: "*" } });

// Better: 明示的なオリジン制限（本番環境向け）
app.use(cors({ origin: ["http://localhost:3000"] }));
const io = new SocketIOServer(httpServer, {
  cors: { origin: ["http://localhost:3000"] },
});
```

- **バリデーション後の生データ参照**: eval ジョブ作成時、Zod でバリデーションした後にバリデーション前の `req.body.providers` を直接使用している。プロバイダ設定の柔軟性を保つためのトレードオフだが、バリデーションの意義が部分的に損なわれる（`src/server/routes/eval.ts:50-55`）。

```typescript
// Bad: バリデーション済みデータではなく req.body を使う
const { evaluateOptions, providers: _validatedProviders, ...restData } = result.data;
const testSuite = { ...restData, providers: req.body.providers };

// Better: passthrough() でスキーマを柔軟にし、バリデーション済みデータを使う
const testSuite = result.data; // passthrough() で未知フィールドも保持
```

## 導出ルール

- `[MUST]` 外部 HTTP 通信は単一のラッパー関数に集約し、Lint ルールで直接使用を禁止する
  - 根拠: promptfoo は `fetchWithProxy` に一元化し、Biome の `noRestrictedGlobals` / `noRestrictedImports` で 5 種の fetch 手段を全てブロックしている（`biome.jsonc:131-152`）
- `[MUST]` ログ出力にはフィールド名と値パターンの両方で秘匿情報を自動サニタイズする仕組みを組み込む
  - 根拠: promptfoo は 76 種のフィールド名 + 7 種の値パターン（`sk-*`, `AKIA*` 等）+ URL パラメータの 3 層で検出しており、開発者が個別にサニタイズを呼ぶ必要がない（`src/util/sanitizer.ts`, `src/logger.ts:344-358`）
- `[SHOULD]` 依存関係の自動更新にはリスクレベルに応じた時間遅延（minimumReleaseAge）を設定する
  - 根拠: promptfoo はランタイム依存 5 日、開発依存 2 日の遅延で npm unpublish ウィンドウを吸収し、LLM SDK のみ即時更新としている（`renovate.json:250-266`, `CONTRIBUTING.md:8`）
- `[SHOULD]` API エンドポイントでは Zod スキーマを `src/types/api/` 等に集約し、リクエストに `safeParse`・レスポンスに `parse` を使い分ける
  - 根拠: promptfoo は 5 つの API スキーマモジュールで全エンドポイントのバリデーションを管理し、不正入力は 400 応答・不正出力は例外として検出する（`src/types/api/*.ts`, `src/server/routes/eval.ts:40-44`）
- `[SHOULD]` 正規表現を使う箇所では ReDoS 耐性を意識し、長い文字列にはスキップ/切り詰め処理を入れる
  - 根拠: promptfoo は URL テンプレート検出に文字列検索を使い（`src/util/sanitizer.ts:334`）、テンプレート展開には 50,000 文字制限を設け（`src/util/render.ts:41-43`）、HTML パターンでは非貪欲量指定子を使う（`src/assertions/html.ts:7-19`）
- `[SHOULD]` セキュリティモデルと信頼境界を `SECURITY.md` に文書化し、In-scope / Out-of-scope を具体例で定義する
  - 根拠: promptfoo は「カスタムコードの実行は仕様」「Web API はCLI と同じ信頼レベル」等を明記し、誤報と有効な脆弱性報告の判断基準を提供している（`SECURITY.md:19-93`）
- `[AVOID]` バリデーション済みデータを無視して生のリクエストボディを使用すること
  - 根拠: promptfoo の eval ジョブ作成で `req.body.providers` を直接使う箇所があり、バリデーションの意義が部分的に損なわれている（`src/server/routes/eval.ts:50-55`）

## 適用チェックリスト

- [ ] HTTP 通信を行う全箇所を洗い出し、単一のラッパー関数に集約しているか
- [ ] Lint ルール（ESLint `no-restricted-globals` / Biome `noRestrictedGlobals` 等）で fetch 直接使用を禁止しているか
- [ ] ログ出力にサニタイズ機構が組み込まれ、開発者が個別に呼ぶ必要がないか
- [ ] サニタイズがフィールド名だけでなく、値パターン（API キー形式等）も検出するか
- [ ] 依存関係管理ツール（Renovate / Dependabot）に `minimumReleaseAge` 相当の遅延を設定しているか
- [ ] ランタイム依存と開発依存で異なる遅延ポリシーを適用しているか
- [ ] API エンドポイントに Zod 等のスキーマバリデーションを導入し、バリデーション済みデータのみを使用しているか
- [ ] 正規表現を使う箇所で、入力長の制限や非貪欲量指定子で ReDoS リスクを軽減しているか
- [ ] `SECURITY.md` で信頼境界と脆弱性のスコープを文書化しているか
- [ ] トレーシング/テレメトリデータに秘匿情報のサニタイズを適用しているか
