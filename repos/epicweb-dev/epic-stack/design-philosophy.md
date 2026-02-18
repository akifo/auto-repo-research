# 設計哲学

> リポジトリ: epicweb-dev/epic-stack
> 分析日: 2026-02-18

## 概要

Epic Stack の技術選定と設計判断の背後にある哲学を分析する。このリポジトリは単なるスターターテンプレートではなく、47件のArchitecture Decision Records（ADR）と6つのGuiding Principlesを持つ「意思決定の結晶」である。特筆すべきは、技術選定の各判断が「サービス最小化」「適応性の最適化」「唯一の方法」という一貫した原則に基づいて行われている点で、スターターテンプレートの設計方法論として汎用的に応用できる。

## 背景にある原則

- **サービス最小化による複雑性制御**: 外部サービスへの依存を最小限に抑え、可能な限りアプリケーション内で完結させる。SQLite を DB に採用し（`docs/decisions/003-sqlite.md`）、Node.js 組み込みの SQLite モジュールに移行し（`docs/decisions/042-node-sqlite.md`）、画像最適化もアプリ内で行う（`docs/decisions/041-image-optimization.md`）。依存を減らすことで障害点が減り、運用コストが下がり、開発者の認知負荷が下がる。

- **段階的サービス導入（Deferred Setup）**: 外部サービスが必要な場合でも、セットアップを「実際に必要になるまで」延期する。Sentry DSN や Resend API キーは optional にし、未設定時はコンソール出力やモックで代替する（`app/utils/email.server.ts:43-53`、`docs/decisions/015-monitoring.md`）。探索フェーズの摩擦を除去し、フリーティアで実験できるようにする。

- **意見を持つが適応可能にする（Opinionated but Adaptable）**: 「唯一の方法」を提供して選択疲れ（analysis paralysis）を排除しつつ、各選択をスワップ可能に保つ。ADR で判断根拠を文書化することで、チームが自信を持って別の選択に切り替えられるようにしている（`docs/guiding-principles.md`）。

- **Web 標準への収束**: TypeScript の `package.json` imports フィールド対応を待ってからパスエイリアスを統合し（`docs/decisions/046-remove-path-aliases.md`）、`SameSite: Lax` のブラウザサポートを根拠に CSRF トークンを除去する（`docs/decisions/035-remove-csrf.md`）。独自の回避策よりも、標準仕様の成熟を待つ姿勢。

## 実例と分析

### ADR による技術選定の追跡可能性

Epic Stack は `docs/decisions/` に 47 件の ADR（Architecture Decision Records）を蓄積している。各 ADR は `Context / Decision / Consequences` の 3 セクション構造で統一されており、「なぜ採用したか」だけでなく「何を諦めたか（Consequences）」まで記録している。

特に注目すべきは、決定の撤回や変更も追跡されている点。パスエイリアスは 3 回変更されている: 026（導入）→ 031（`package.json` imports に移行）→ 046（TypeScript のネイティブサポートで tsconfig.json を除去）。CSRF トークンも 032（導入）→ 035（ブラウザの `SameSite: Lax` サポートを根拠に除去）という経緯がある。これにより「なぜ今こうなっているか」が常に追跡可能になっている。

### 「自前実装 vs 外部依存」の判断基準

Epic Stack は外部依存の採用に明確な基準を持っている。CONTRIBUTING.md には「コードを外部ライブラリにするのは歓迎するが、採用は保証しない。メンテナンスの委譲と適応性のバランスは繊細」と記されている（`CONTRIBUTING.md:82-93`）。

具体的な判断例:

- **自前**: セッション管理は remix-auth-form を使っていたが、独自実装に切り替えた（`docs/decisions/029-remix-auth.md`）。「何の価値も加えていない」が理由。
- **外部依存**: Radix UI + shadcn/ui はコード所有権を保ちつつヘッドレスコンポーネントの恩恵を受ける構成（`docs/decisions/019-components.md`）。shadcn/ui はライブラリではなくコードレジストリなので、更新は手動だが自由にカスタマイズできる。
- **Node.js 組み込みへの移行**: `better-sqlite3` から `node:sqlite` への移行は「依存を1つ減らす」「ネイティブモジュールのコンパイル不要」が動機（`docs/decisions/042-node-sqlite.md`）。

### モック駆動のオフライン開発

Guiding Principles に「Offline Development」が明記されており、すべての外部 API は MSW でモックされている。`tests/mocks/` には Resend（メール）、GitHub OAuth、Tigris（オブジェクトストレージ）、PwnedPasswords API のモックハンドラが用意されている。`index.ts` のエントリポイントで `MOCKS=true` 環境変数による条件付きインポートが行われる:

```ts
// index.ts:19-21
if (process.env.MOCKS === "true") {
  await import("./tests/mocks/index.ts");
}
```

GitHub OAuth のモックは `MOCK_` プレフィックス付きの環境変数で切り替わる仕組みになっており（`.env.example:14`）、実 API と モックの切り替えが環境変数だけで完結する。

### 多層レート制限の設計

レート制限は3段階に分離されている。Express のミドルウェアレベルで、エンドポイントの性質に応じて異なる制限を適用する設計になっている:

```ts
// server/index.ts:110-149
const strongestRateLimit = rateLimit({
  ...rateLimitDefault,
  windowMs: 60 * 1000,
  limit: 10 * maxMultiple,
});

const strongRateLimit = rateLimit({
  ...rateLimitDefault,
  windowMs: 60 * 1000,
  limit: 100 * maxMultiple,
});

const generalRateLimit = rateLimit(rateLimitDefault);
app.use((req, res, next) => {
  const strongPaths = [
    "/login",
    "/signup",
    "/verify",
    "/admin",
    "/onboarding",
    "/reset-password",
    "/settings/profile",
    "/resources/login",
    "/resources/verify",
  ];
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (strongPaths.some((p) => req.path.includes(p))) {
      return strongestRateLimit(req, res, next);
    }
    return strongRateLimit(req, res, next);
  }
  // ...
  return generalRateLimit(req, res, next);
});
```

テスト・開発環境では `maxMultiple` を 10,000 倍にして実質的に無効化する（`server/index.ts:92-93`）。ADR では「最初はインメモリ、必要に応じて Redis に進化」という段階的アプローチを明記している。

## コード例

```ts
// app/utils/env.server.ts:3-29 — Zod による環境変数バリデーション + 段階的サービス導入
const schema = z.object({
  NODE_ENV: z.enum(["production", "development", "test"] as const),
  DATABASE_PATH: z.string(),
  DATABASE_URL: z.string(),
  SESSION_SECRET: z.string(),
  // If you plan on using Sentry, remove the .optional()
  SENTRY_DSN: z.string().optional(),
  // If you plan to use Resend, remove the .optional()
  RESEND_API_KEY: z.string().optional(),
  // If you plan to use GitHub auth, remove the .optional()
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
});
```

```ts
// app/utils/email.server.ts:43-53 — 外部サービス未設定時のグレースフルフォールバック
if (!process.env.RESEND_API_KEY && !process.env.MOCKS) {
  console.error(`RESEND_API_KEY not set and we're not in mocks mode.`);
  console.error(`To send emails, set the RESEND_API_KEY environment variable.`);
  console.error(`Would have sent the following email:`, JSON.stringify(email));
  return {
    status: "success",
    data: { id: "mocked" },
  } as const;
}
```

```ts
// app/utils/db.server.ts:6-37 — remember パターンによる開発時のモジュール再読み込み対策
export const prisma = remember("prisma", () => {
  const logThreshold = 20;
  const client = new PrismaClient({
    log: [
      { level: "query", emit: "event" },
      { level: "error", emit: "stdout" },
      { level: "warn", emit: "stdout" },
    ],
  });
  client.$on("query", async (e) => {
    if (e.duration < logThreshold) return;
    // ... color-coded slow query logging
  });
  void client.$connect();
  return client;
});
```

```ts
// app/utils/user.ts:28-46 — 型安全な RBAC パーミッション文字列
type Action = "create" | "read" | "update" | "delete";
type Entity = "user" | "note";
type Access = "own" | "any" | "own,any" | "any,own";
export type PermissionString =
  | `${Action}:${Entity}`
  | `${Action}:${Entity}:${Access}`;
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 認証プロバイダの追加・切り替えを、既存コードの変更なしに実現する
  - 適用条件: 同じインターフェースを持つ複数の実装を動的に切り替える必要がある場合
  - コード例: `app/utils/providers/provider.ts:12-23`（`AuthProvider` インターフェース）、`app/utils/connections.server.ts:7-9`（プロバイダレジストリ）
  - 注意点: プロバイダの追加は `connections.server.ts` のレジストリに1行追加するだけ。Strategy パターンの古典的な適用例

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: ADR のフォーマットを統一し、記載漏れを防ぐ
  - 適用条件: ドキュメントや設定ファイルの構造を統一したい場合
  - コード例: `docs/decisions/000-template.md`（Context / Decision / Consequences の3セクション）
  - 注意点: コードではなくドキュメントへの適用だが、構造の統一という効果は同じ

## Good Patterns

- **段階的サービス導入（Deferred Service Setup）**: 外部サービスの API キーを Zod スキーマで `optional()` にし、未設定時はコンソール出力やモックで動作を継続させる。これにより、プロジェクト開始直後から本番デプロイまでの摩擦を最小化している。

```ts
// app/utils/env.server.ts:13-14
SENTRY_DSN: z.string().optional(),
RESEND_API_KEY: z.string().optional(),

// app/utils/email.server.ts:43-53 — 未設定時のフォールバック
if (!process.env.RESEND_API_KEY && !process.env.MOCKS) {
	console.error(`Would have sent the following email:`, JSON.stringify(email))
	return { status: 'success', data: { id: 'mocked' } } as const
}
```

- **ADR による設計判断の文書化**: 技術選定の理由と結果（トレードオフ）を標準フォーマットで蓄積する。「なぜ今こうなっているか」が常に追跡可能で、新しいメンバーが設計意図を理解でき、将来の判断変更も同じプロセスで行える。

```markdown
<!-- docs/decisions/000-template.md -->

# Title

Date: YYYY-MM-DD
Status: proposed | rejected | accepted | deprecated | superseded by [0005]

## Context

## Decision

## Consequences
```

- **型安全な権限文字列**: テンプレートリテラル型で RBAC パーミッションを表現し、`action:entity:access` の形式を型レベルで強制する。文字列ベースの柔軟性と型安全性を両立。

```ts
// app/utils/user.ts:31-33
export type PermissionString =
  | `${Action}:${Entity}`
  | `${Action}:${Entity}:${Access}`;
```

## Anti-Patterns / 注意点

- **スターターテンプレートの過剰機能化**: Epic Stack は "Include Only Most Common Use Cases" を原則としているが、認証だけでパスワード + TOTP + パスキー + GitHub OAuth の4手段をサポートしている。スターターは機能の網羅性より「削除のしやすさ」が重要。

```
Bad: スターターに考えうるすべての認証手段を組み込む
Better: 最小限（パスワード認証 + OAuth 1つ）をスターターに含め、
        追加手段はドキュメントに実装ガイドとして提供する
```

- **ADR なき技術選定**: Guiding Principles に反する判断でも ADR が存在する場合と存在しない場合がある。例えば Tailwind CSS の採用には ADR が存在しない（`docs/decisions/019-components.md` で「no decision document has been written about this choice yet」と明記）。技術選定は必ず ADR を書いてから行うべき。

```
Bad: 「みんな使っているから」で技術を採用し、根拠を文書化しない
Better: 些細に見える技術選定でも Context/Decision/Consequences を
        1段落ずつ書いて記録する
```

## 導出ルール

- `[MUST]` プロジェクトの技術選定時に判断根拠を構造化して記録する（Context / Decision / Consequences の3セクション以上）
  - 根拠: Epic Stack は 47 件の ADR を持ち、判断の撤回・変更も追跡可能にしている（`docs/decisions/` ディレクトリ）。根拠のない技術選定は将来の変更判断を困難にする

- `[MUST]` 外部サービスへの依存は「未設定でもアプリが起動・動作する」ようにフォールバックを実装する
  - 根拠: Epic Stack は Sentry・Resend・GitHub OAuth すべてを optional にし、未設定時はコンソール出力やモックで代替する（`app/utils/email.server.ts:43-53`）。開発開始時の摩擦を最小化するため

- `[SHOULD]` 外部 API はモックレイヤーで抽象化し、環境変数のみでモック/実 API を切り替え可能にする
  - 根拠: Epic Stack は MSW を使い、`MOCKS=true` や `MOCK_` プレフィックス付き環境変数でオフライン開発を実現している（`index.ts:19-21`、`tests/mocks/`）

- `[SHOULD]` スターターテンプレートでは「削除しやすさ」を設計基準にする — 各機能は独立したモジュールとし、不要な機能の削除が他の機能に影響しないようにする
  - 根拠: Guiding Principles の "Include Only Most Common Use Cases" に基づく。Epic Stack は認証プロバイダを Strategy パターンで分離し、個別の削除を容易にしている（`app/utils/providers/`）

- `[SHOULD]` セキュリティ対策のレート制限は、エンドポイントの性質に応じて複数段階に分ける（一般 / 強 / 最強）
  - 根拠: Epic Stack は login/signup 等の攻撃対象になりやすいエンドポイントに通常の10分の1のレート制限を適用している（`server/index.ts:110-149`）

- `[AVOID]` 独自の回避策で標準仕様の不足を補い続ける — 標準仕様が成熟したら速やかに移行する
  - 根拠: Epic Stack は tsconfig.json の paths を TypeScript のネイティブ `imports` サポート後に除去し（`docs/decisions/046-remove-path-aliases.md`）、CSRF トークンを `SameSite: Lax` 普及後に除去した（`docs/decisions/035-remove-csrf.md`）

## 適用チェックリスト

- [ ] プロジェクトに ADR（Architecture Decision Records）のテンプレートとディレクトリを用意しているか
- [ ] 外部サービスの API キーが未設定でもアプリが起動・基本動作するフォールバックを実装しているか
- [ ] 外部 API のモックレイヤーがあり、オフラインで開発・テストが完結するか
- [ ] レート制限が一律ではなく、エンドポイントの性質（認証系 / 一般）に応じて段階的に設定されているか
- [ ] スターターやテンプレートの各機能が独立しており、不要な機能を削除しても他が壊れないか
- [ ] 独自の回避策を導入する際に、対応する標準仕様の状況と移行条件を記録しているか
- [ ] 技術選定の根拠が「チームの合意」ではなく「文書化された判断」として残っているか
