# Security Practices

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

OpenClaw は CLI・ゲートウェイ・モバイルアプリを横断する AI エージェントプラットフォームであり、外部コンテンツ（メール・Webhook・Web 取得）を LLM に渡す、ユーザー提供のプラグイン/スキルを実行する、Docker サンドボックスでコードを動かす、といったセキュリティ境界の多いアーキテクチャを持つ。本分析では、サンドボックス、認証、入力バリデーション、秘匿情報管理、プロンプトインジェクション防御、セキュリティ監査の各層にわたるプラクティスを横断的に抽出する。注目に値するのは、セキュリティを「事後対応」ではなく「設計時の制約」として組み込んでいる点であり、特に多層防御（defense in depth）の実装密度が高い。

## 背景にある原則

- **Default-Deny の徹底**: ツール公開、コマンド実行、グループアクセスなど、あらゆるセキュリティ境界で「明示的に許可されたもの以外はすべて拒否」を基本方針とすべき。なぜなら、AI エージェントが自律的にツールを呼び出す文脈では、意図しない操作を実行する攻撃面が従来のアプリケーションより広いため。根拠: `DEFAULT_GATEWAY_HTTP_TOOL_DENY`（`src/security/dangerous-tools.ts:9-18`）でセッション操作・ゲートウェイ制御など高リスクツールをデフォルト拒否し、`gateway.tools.allow` で明示的に解除する設計。

- **信頼境界の明示的マーキング**: 外部から入ってくるデータには必ず「これは信頼できない」というマーカーを付与し、処理パイプライン全体でその信頼レベルを維持すべき。なぜなら、LLM は自然言語の文脈でデータと命令の区別がつきにくく、暗黙の信頼昇格がプロンプトインジェクションの根本原因となるため。根拠: `wrapExternalContent()`（`src/security/external-content.ts:196-221`）が境界マーカーとセキュリティ警告で外部コンテンツを包む設計。

- **秘匿情報の漏洩面積最小化**: 秘匿情報は取得・保存・表示・転送のすべてのステージで漏洩経路を最小化すべき。なぜなら、設定値のラウンドトリップ（読み取り→編集→書き戻し）やログ出力など、開発者が意識しない経路から漏洩するリスクが高いため。根拠: Zod スキーマの `.register(sensitive)` による宣言的な秘匿マーキング（`src/config/zod-schema.core.ts:60`）、`REDACTED_SENTINEL` を使った可逆的な秘匿化と `restoreRedactedValues()` による復元（`src/config/redact-snapshot.ts:42,329`）、ログレベルでの正規表現ベースの自動秘匿（`src/logging/redact.ts`）。

- **攻撃面の構造的可視化**: セキュリティ状態は暗黙知としてコードに埋もれるのではなく、プログラマブルに検査・報告できるべき。なぜなら、設定変更やアップデートによるセキュリティ劣化は、自動検知なしでは気づけないため。根拠: `openclaw security audit --deep` コマンドによるファイルシステムパーミッション・ゲートウェイ設定・チャネルポリシーの包括的な監査機能（`src/security/audit.ts`）。

## 実例と分析

### 1. プロンプトインジェクション防御の多層設計

外部コンテンツの LLM 注入に対して 3 層の防御を敷いている。

**第 1 層: 境界マーカーによるコンテンツ隔離**。`<<<EXTERNAL_UNTRUSTED_CONTENT>>>` で外部コンテンツを物理的に区切り、LLM に対して「この範囲は命令ではなくデータである」と明示する。

**第 2 層: マーカー自体の偽装防止**。攻撃者がコンテンツ内に境界マーカーを埋め込んで「信頼済みコンテンツの終了」を偽装する攻撃に対し、`replaceMarkers()` がマーカー文字列を `[[MARKER_SANITIZED]]` に置換する。さらに、Unicode ホモグリフ（全角文字、CJK 角括弧、数学記号の角括弧など）による回避も `foldMarkerText()` で正規化する。

```typescript
// src/security/external-content.ts:88-103
const ANGLE_BRACKET_MAP: Record<number, string> = {
  0xff1c: "<", // fullwidth <
  0xff1e: ">", // fullwidth >
  0x2329: "<", // left-pointing angle bracket
  0x232a: ">", // right-pointing angle bracket
  0x3008: "<", // CJK left angle bracket
  0x3009: ">", // CJK right angle bracket
  // ... 他にも複数のホモグリフを正規化
};
```

**第 3 層: 疑わしいパターンの検出**。`detectSuspiciousPatterns()` が「ignore all previous instructions」「you are now a different assistant」等の典型的なプロンプトインジェクションパターンを検出する。ただし、これはブロックではなくログ用であり、正当なコンテンツを誤拒否しない設計になっている。

### 2. サンドボックスによるファイルシステム隔離

`sandbox-paths.ts` でパストラバーサル攻撃に対する 2 段階の防御を実装している。

```typescript
// src/agents/sandbox-paths.ts:33-47
export function resolveSandboxPath(params: { filePath: string; cwd: string; root: string; }): {
  resolved: string;
  relative: string;
} {
  const resolved = resolveToCwd(params.filePath, params.cwd);
  const rootResolved = path.resolve(params.root);
  const relative = path.relative(rootResolved, resolved);
  // ...
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes sandbox root (${shortPath(rootResolved)}): ${params.filePath}`);
  }
  return { resolved, relative };
}
```

第 1 段階は `path.relative` による論理的な境界チェック（`..` で始まるパスを拒否）。第 2 段階は `assertNoSymlink()` による物理的なシンボリックリンク追跡の阻止。各パスセグメントを `lstat` で検査し、途中にシンボリックリンクが含まれていれば拒否する。また、Unicode スペースの正規化（`normalizeUnicodeSpaces`）により、ユーザー入力パスに含まれる非標準空白文字による回避も防ぐ。

Docker サンドボックス自体は最小権限の原則に従い、非 root ユーザーで実行する:

```dockerfile
# Dockerfile.sandbox:16-17
RUN useradd --create-home --shell /bin/bash sandbox
USER sandbox
```

### 3. 秘匿情報の宣言的管理と可逆的秘匿化

設定スキーマの定義時点で秘匿フィールドを Zod レジストリにマーキングする。

```typescript
// src/config/zod-schema.sensitive.ts:1-5
import { z } from "zod";
export const sensitive = z.registry<undefined, z.ZodType>();
```

```typescript
// src/config/zod-schema.core.ts:60 (使用例)
apiKey: z.string().optional().register(sensitive),
```

この宣言的アプローチにより、秘匿フィールドの追加時にスキーマ定義を変更するだけで、Web UI への露出防止・ログ秘匿・設定スナップショットの秘匿化がすべて連動する。

Web UI ラウンドトリップでは `REDACTED_SENTINEL` を挿入し、書き戻し時に `restoreRedactedValues()` が元の値を復元する。不正な設定ファイルの場合は秘匿化の安全性が保証できないため、設定値をすべて空にして返す（漏洩よりデータ喪失を選択）という判断がなされている。

```typescript
// src/config/redact-snapshot.ts:281-296
if (!snapshot.valid) {
  return {
    ...snapshot,
    config: {},
    raw: null,
    parsed: null,
    resolved: {},
  };
}
```

### 4. タイミング攻撃対策の一貫した適用

認証トークンの比較には `crypto.timingSafeEqual` を一貫して使用している。

```typescript
// src/security/secret-equal.ts:1-16
import { timingSafeEqual } from "node:crypto";
export function safeEqualSecret(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}
```

ゲートウェイ認証（`src/gateway/auth.ts:373`）、LINE Webhook 署名検証（`src/line/signature.ts:12-17`）など、秘密比較が必要なすべての箇所でこの関数または `crypto.timingSafeEqual` を直接使用している。

### 5. コマンド実行の安全性検証

ユーザー設定から渡される実行可能ファイル名に対して、シェルメタ文字・制御文字・引用符を排除する検証を行っている。

```typescript
// src/infra/exec-safety.ts:1-44
const SHELL_METACHARS = /[;&|`$<>]/;
const CONTROL_CHARS = /[\r\n]/;
const QUOTE_CHARS = /["']/;
const BARE_NAME_PATTERN = /^[A-Za-z0-9._+-]+$/;

export function isSafeExecutableValue(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.includes("\0")) return false;
  if (CONTROL_CHARS.test(trimmed)) return false;
  if (SHELL_METACHARS.test(trimmed)) return false;
  if (QUOTE_CHARS.test(trimmed)) return false;
  if (isLikelyPath(trimmed)) return true;
  if (trimmed.startsWith("-")) return false;
  return BARE_NAME_PATTERN.test(trimmed);
}
```

この検証は Zod スキーマの `superRefine` / `refine` と組み合わせて使われ（`src/config/zod-schema.core.ts:358-377`）、設定の解析段階でインジェクションを阻止する。

### 6. CI/CD パイプラインでの多層セキュリティスキャン

pre-commit フックで以下のセキュリティスキャンを実行している:

- `detect-secrets`: 秘匿情報の混入検知（`.secrets.baseline` によるベースライン管理）
- `zizmor`: GitHub Actions ワークフローのセキュリティ監査
- `shellcheck`: シェルスクリプトの安全性チェック
- `actionlint`: GitHub Actions の構文・セキュリティチェック

さらに、インストール済みプラグイン/スキルに対するランタイムコードスキャナー（`src/security/skill-scanner.ts`）が、`child_process` の使用・`eval` の呼び出し・暗号マイニングパターン・環境変数の外部送信・難読化コードを検出する。

## パターンカタログ

- **Strategy パターン** (振る舞い)
  - 解決する問題: 認証方式（token / password / tailscale / trusted-proxy）を実行時に切り替える
  - 適用条件: 複数の認証戦略を統一的なインターフェースで扱う必要がある場合
  - コード例: `src/gateway/auth.ts:297-400`（`authorizeGatewayConnect` が `auth.mode` に基づいて分岐）
  - 注意点: 各戦略の失敗理由を文字列で返す設計により、Rate Limiter との連携が可能

- **Decorator パターン** (構造)
  - 解決する問題: 外部コンテンツに信頼境界メタデータを付与しつつ、元のコンテンツを保持する
  - 適用条件: データの信頼レベルを後続処理に伝搬させる必要がある場合
  - コード例: `src/security/external-content.ts:196-221`（`wrapExternalContent` がコンテンツをマーカーとメタデータで装飾）
  - 注意点: マーカー自体の偽装防止が必須（ホモグリフ対策を含む）

## Good Patterns

- **宣言的な秘匿フィールド登録**: スキーマ定義時に `.register(sensitive)` を呼ぶだけで、表示・ログ・転送すべてのレイヤーで秘匿化が自動適用される。秘匿対象の追加が 1 箇所の変更で完結し、漏れが生じにくい。

```typescript
// src/config/zod-schema.core.ts:60
apiKey: z.string().optional().register(sensitive),
```

- **ツールリスクの集中管理**: 危険なツール名を `dangerous-tools.ts` に一元定義し、Gateway HTTP 制限・セキュリティ監査・ACP プロンプトで同じリストを参照する。定義のドリフトを構造的に防止している。

```typescript
// src/security/dangerous-tools.ts:1-2
// Shared tool-risk constants.
// Keep these centralized so gateway HTTP restrictions, security audits, and ACP prompts don't drift.
```

- **可逆的秘匿化による安全なラウンドトリップ**: 設定値を Web UI 経由で編集する際、秘匿フィールドは `REDACTED_SENTINEL` に置換されるが、書き戻し時に元の値を復元する仕組みにより、ユーザーが意図せず秘匿情報を消失することを防ぐ。

## Anti-Patterns / 注意点

- **認証なしのローカルバインド**: ゲートウェイがループバックにバインドされていても、リバースプロキシ経由で外部公開される可能性がある。ループバック = 安全、という前提に依存すると SSRF 等で認証バイパスされるリスクがある。

```typescript
// Bad: ループバックだから認証不要と判断
if (bind === "loopback") { /* 認証スキップ */ }

// Better: ループバックでも認証を要求し、ローカル直接接続のみ例外とする
const localDirect = isLocalDirectRequest(req, trustedProxies);
// 認証フローを経た上で、ローカル直接接続には追加の緩和を適用
```

セキュリティ監査（`src/security/audit.ts:314-324`）がこの設定を `critical` として報告する設計でカバーしている。

- **文字列ベースのエラー理由コード**: 認証失敗の理由を `reason: "token_mismatch"` のような文字列で返す設計は、タイポによる見落としリスクがある。列挙型やブランド型を使うとコンパイル時に検出できる。

```typescript
// 現状: 文字列リテラル
return { ok: false, reason: "token_mismatch" };

// Better: 列挙型で型安全にする
type AuthFailureReason = "token_mismatch" | "token_missing" | "rate_limited";
return { ok: false, reason: "token_mismatch" satisfies AuthFailureReason };
```

## 導出ルール

- `[MUST]` 秘密値の比較には必ずタイミング安全な関数（`crypto.timingSafeEqual` 等）を使い、素の `===` を使わない
  - 根拠: `src/security/secret-equal.ts` および `src/line/signature.ts` がすべての秘密比較でこれを徹底しており、タイミングサイドチャネルを構造的に排除している

- `[MUST]` 外部から受け取ったコンテンツを LLM に渡す際は、信頼境界マーカーとセキュリティ警告で包み、命令とデータを明示的に分離する
  - 根拠: `src/security/external-content.ts` が email・webhook・web fetch 等すべての外部ソースに対して `wrapExternalContent()` を適用し、プロンプトインジェクションの攻撃面を縮小している

- `[MUST]` サンドボックスのパス解決では、論理的な `..` チェックだけでなくシンボリックリンクの追跡も検証する
  - 根拠: `src/agents/sandbox-paths.ts:89-110` の `assertNoSymlink()` が各パスセグメントを `lstat` で検査し、シンボリックリンク経由のサンドボックス脱出を防止している

- `[SHOULD]` 秘匿フィールドはバリデーションスキーマの定義時点で宣言的にマークし、表示・ログ・転送のすべてのレイヤーで自動的に秘匿化されるようにする
  - 根拠: Zod の `.register(sensitive)` パターン（`src/config/zod-schema.core.ts:60`）により、秘匿対象の追加がスキーマ変更 1 箇所で完結し、漏れを構造的に防止している

- `[SHOULD]` セキュリティ上重要な定数（危険なツール名、デフォルト拒否リスト等）は 1 箇所に集約し、監査・ポリシー・UI から同じ定義を参照する
  - 根拠: `src/security/dangerous-tools.ts` が Gateway HTTP 制限・セキュリティ監査・ACP プロンプトで共有され、コメント（1 行目）でドリフト防止の意図を明示している

- `[SHOULD]` ユーザー設定から渡される実行可能ファイル名には、シェルメタ文字・制御文字・NUL バイトの排除を設定解析段階で行う
  - 根拠: `src/infra/exec-safety.ts` の `isSafeExecutableValue()` が Zod の `refine` と組み合わされ、設定ロード時にコマンドインジェクションを阻止している

- `[SHOULD]` セキュリティ設定の正しさを検証する `security audit` コマンドを提供し、ファイルパーミッション・ネットワーク露出・認証設定を自動チェックする
  - 根拠: `src/security/audit.ts` が 30 以上のチェック項目を severity 付きで報告し、`--fix` オプション（`src/security/fix.ts`）で自動修正まで提供している

- `[AVOID]` 信頼境界マーカーの文字列一致だけに依存する防御。Unicode ホモグリフや全角文字による回避を考慮しないと、マーカーの偽装が可能になる
  - 根拠: `src/security/external-content.ts:88-125` が 10 種以上の角括弧ホモグリフを ASCII に正規化してからマーカー検出を行い、回避攻撃を防止している

## 適用チェックリスト

- [ ] 秘密値（API キー、トークン、パスワード）の比較にタイミング安全な関数を使っているか確認する
- [ ] 外部ソース（ユーザー入力、API レスポンス、Webhook）からのデータを LLM に渡す箇所で、信頼境界の明示的なマーキングを行っているか確認する
- [ ] ファイルパスを扱うサンドボックス機能で、`..` チェックとシンボリックリンク検証の両方を実装しているか確認する
- [ ] 秘匿フィールドがスキーマ定義で宣言的にマークされ、ログ・UI・API レスポンスで自動秘匿されるか確認する
- [ ] 危険な操作（コマンド実行、セッション生成、データ削除）のリストが 1 箇所に集約され、ポリシーエンジンと監査ツールで共有されているか確認する
- [ ] ユーザー設定からの実行可能ファイル名にシェルメタ文字インジェクション防止のバリデーションがあるか確認する
- [ ] CI パイプラインに秘匿情報の混入検知（detect-secrets 等）を組み込んでいるか確認する
- [ ] セキュリティ設定の正しさを検証する自動監査ツール（またはテスト）が存在するか確認する
- [ ] レート制限が認証エンドポイントに適用されているか確認する
- [ ] Docker コンテナが非 root ユーザーで実行され、最小限のケーパビリティで動作しているか確認する
