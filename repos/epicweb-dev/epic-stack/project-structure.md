# project-structure

> リポジトリ: epicweb-dev/epic-stack
> 分析日: 2026-02-18

## 概要

Epic Stack のディレクトリ構成とモジュール分割の戦略を分析した。このリポジトリはフルスタック React Router v7 アプリケーションのリファレンス実装であり、「ファイルの置き場所が自明」になるよう設計されている点が注目に値する。ルーティング・サーバーロジック・UI コンポーネント・テストインフラの4層を明確に分離しつつ、`.server.ts` サフィックスとコロケーションを徹底することで、大規模化しても認知負荷が増えにくい構成を実現している。

## 背景にある原則

- **境界明示の原則**: サーバー専用コードは `.server.ts` サフィックスで物理的にクライアントバンドルから排除する。命名規約によるバンドル境界の制御は、ビルドツールの暗黙の挙動に依存するより安全であり、コードレビューでも即座にサーバー/クライアントの区別が可能になる（`app/routes.ts:15` の `ignoredRouteFiles` 設定で `.server.*` がルートから除外されている）。

- **コロケーション優先の原則**: 関連するファイルは物理的に近くに配置する。テストファイルは対象モジュールと同階層に置き（`app/routes/users/$username/index.test.tsx`）、ルート固有のサーバーロジックはルートディレクトリ内の `.server.ts` に置く。これにより「ファイルを探す」という認知コストを最小化する。

- **曖昧さ排除の原則**: ルートプレフィックス (`_auth`, `_marketing`, `_seo`) による意味的グルーピングにより、URL パスに影響を与えずにルートを論理的に整理する。開発者がファイルを見た瞬間にその役割を理解できる命名体系を確立する。

- **ルート外追放の原則**: アプリケーションの本質に関係しないファイル（Docker設定、SVGアイコン原本、ツール設定）は `other/` ディレクトリに集約し、ルートディレクトリの汚染を防ぐ（`other/README.md` に設計意図が明記されている）。

## 実例と分析

### 三層エントリポイントによる起動シーケンス分離

アプリケーションの起動は3つの明確なレイヤーに分離されている:

1. **`index.ts`** (プロセスエントリ): 環境変数ロード、ソースマップ設定、モック注入の条件分岐
2. **`server/index.ts`** (HTTP サーバー): Express ミドルウェアスタック、レート制限、静的ファイル配信
3. **`server/app.ts`** (React Router ハンドラ): createRequestHandler による SSR

この分離により、Express レイヤーの設定変更が React Router のコードに影響しない。`index.ts:19-21` では `MOCKS=true` のときだけモックサーバーを動的インポートしており、本番コードとテストインフラの依存が物理的に分断されている。

### ルートの意味的グルーピング

`app/routes/` は `_` プレフィックスによるパスレスレイアウトで論理的にグループ化されている:

```
app/routes/
├── _auth/           # 認証フロー（login, signup, verify, onboarding）
├── _marketing/      # 静的ページ（index, about, privacy, tos）
├── _seo/            # SEO 用 API（robots.txt, sitemap.xml）
├── admin/           # 管理画面
├── resources/       # UI を持たない API エンドポイント
├── settings/        # ユーザー設定
├── users/           # ユーザープロフィール・ノート
├── me.tsx           # 自分のプロフィールへのリダイレクト
└── $.tsx            # 404 キャッチオール
```

`_auth`, `_marketing`, `_seo` は URL パスには現れないが、ファイルシステム上での整理に寄与する。`resources/` は UI コンポーネントを返さない API ルートを集約する場所として機能している。

### `+shared` と `+logos` による非ルートファイルのコロケーション

`+` プレフィックスのディレクトリはルートファイルとして扱われない特別な規約である:

```typescript
// app/routes/users/$username/notes/$noteId_.edit.tsx:5-8
import { NoteEditor } from "./+shared/note-editor.tsx";
export { action } from "./+shared/note-editor.server.tsx";
```

`+shared/note-editor.tsx` はルート間で共有されるコンポーネントとスキーマを、`+shared/note-editor.server.tsx` はサーバー側の action を保持する。`$noteId_.edit.tsx` と `new.tsx` の両方がこれを参照する。これにより、共有ロジックがルートに近い場所に維持される。

同様に `_marketing/+logos/` にはロゴの SVG とそのメタデータが配置されている。

### `.server.ts` サフィックスによるバンドル境界制御

`app/utils/` 内のファイルは意図的にサフィックスで分類されている:

| サフィックス   | 例                               | 意味                                               |
| -------------- | -------------------------------- | -------------------------------------------------- |
| `.server.ts`   | `auth.server.ts`, `db.server.ts` | サーバー専用。クライアントバンドルに含まれない     |
| `.client.tsx`  | `monitoring.client.tsx`          | クライアント専用。SSR 時に実行されない             |
| `.ts` / `.tsx` | `misc.tsx`, `user.ts`            | ユニバーサル。サーバー・クライアント両方で使用可能 |

`app/routes.ts:15` で `**/*.server.*` がルートファイルの除外対象に設定されており、同一ディレクトリ内でサーバーロジックをルートの横に配置できる:

```typescript
// app/routes.ts:4-18
export default autoRoutes({
  ignoredRouteFiles: [
    ".*",
    "**/*.css",
    "**/*.test.{js,jsx,ts,tsx}",
    "**/__*.*",
    "**/*.server.*",
    "**/*.client.*",
  ],
}) satisfies RouteConfig;
```

### Node.js subpath imports によるエイリアス

`package.json:8-11` で定義された `#app/*` と `#tests/*` エイリアスにより、相対パスの複雑さを回避している:

```json
{
  "imports": {
    "#app/*": "./app/*",
    "#tests/*": "./tests/*"
  }
}
```

これは TypeScript の `paths` ではなく Node.js のネイティブ機能を使っているため、ビルドツールに依存しない。コードベース全体で一貫して使用されている:

```typescript
// app/routes/_auth/login.server.ts:5-9
import { getUserId, sessionKey } from "#app/utils/auth.server.ts";
import { prisma } from "#app/utils/db.server.ts";
import { combineResponseInits } from "#app/utils/misc.tsx";
import { authSessionStorage } from "#app/utils/session.server.ts";
import { redirectWithToast } from "#app/utils/toast.server.ts";
```

### テストインフラの三層構造

テストは3つの種類に分離され、それぞれ独立したインフラを持つ:

1. **単体テスト (Vitest)**: `app/**/*.test.{ts,tsx}` にコロケート。`tests/setup/` で環境を構成
2. **E2E テスト (Playwright)**: `tests/e2e/` に集約。`tests/playwright-utils.ts` でフィクスチャを提供
3. **モックサーバー (MSW)**: `tests/mocks/` に外部 API のモックを集約。開発時にも利用される

特にテストデータベースの管理が巧妙で、`tests/setup/global-setup.ts` でベースDBを生成し、`tests/setup/db-setup.ts` で各テストプールにコピーすることで並列テスト実行を可能にしている:

```typescript
// tests/setup/db-setup.ts:6-9
const poolId = process.env.VITEST_POOL_ID || "0";
const databaseFile = `./tests/prisma/data.${poolId}.db`;
const databasePath = path.join(process.cwd(), databaseFile);
process.env.DATABASE_URL = `file:${databasePath}`;
```

### `other/` ディレクトリによるルート汚染の回避

`other/` にはアプリケーションコードではないが必要なファイルが格納されている: Dockerfile、LiteFS 設定、SVG アイコン原本、sly 設定。`other/README.md` に設計意図が明記されている:

> The "other" directory is where we put stuff that doesn't really have a place, but we don't want in the root of the project. In fact, we want to move as much stuff here from the root as possible.

### コンポーネントの二層構成

`app/components/` は明確な二層に分かれている:

- **`ui/`**: Radix UI をラップした汎用プリミティブ（button, checkbox, input 等）。shadcn/ui 由来
- **ルート直下**: アプリケーション固有のコンポーネント（error-boundary, forms, search-bar 等）

`ui/` は外部ライブラリのアダプタ層として機能し、アプリケーションコンポーネントは `ui/` を通じてのみ Radix UI を参照する。

## パターンカタログ

- **Adapter パターン** (構造)
  - 解決する問題: 外部UIライブラリの API をアプリケーション全体で統一する
  - 適用条件: Radix UI 等のヘッドレスUIライブラリを使う場合
  - コード例: `app/components/ui/button.tsx`, `app/components/ui/checkbox.tsx`
  - 注意点: shadcn/ui のコード生成に依存する場合、アダプタ層のカスタマイズが上書きされるリスクがある

- **Strategy パターン** (振る舞い)
  - 解決する問題: 複数の認証プロバイダを統一的に扱う
  - 適用条件: OAuth 等、同一インタフェースの複数実装が必要な場合
  - コード例: `app/utils/providers/provider.ts:13-23` で `AuthProvider` インタフェースを定義し、`app/utils/providers/github.server.ts:43` で `GitHubProvider` が実装
  - 注意点: プロバイダ追加時は `connections.tsx` の `providerNames` 配列と `connections.server.ts` のレジストリ両方を更新する必要がある

## Good Patterns

- **サーバー/クライアント分離の命名規約**: `.server.ts` / `.client.tsx` のサフィックスでバンドル境界を物理的に制御するパターン。ビルド設定ではなく命名規約でサーバーコードのクライアント漏洩を防ぐ。`env.server.ts` が `getEnv()` で公開する環境変数を明示的にフィルタし、サーバー専用の環境変数がクライアントに渡らないことを保証している:

```typescript
// app/utils/env.server.ts:59-65
export function getEnv() {
  return {
    MODE: process.env.NODE_ENV,
    SENTRY_DSN: process.env.SENTRY_DSN,
    ALLOW_INDEXING: process.env.ALLOW_INDEXING,
  };
}
```

- **Zod による環境変数バリデーション**: アプリケーション起動時に `env.server.ts` で全環境変数を Zod スキーマで検証し、不正な状態での起動を防止する。さらに `declare global` で `ProcessEnv` を拡張し、TypeScript の型安全性を確保する:

```typescript
// app/utils/env.server.ts:3-29
const schema = z.object({
  NODE_ENV: z.enum(["production", "development", "test"] as const),
  DATABASE_URL: z.string(),
  SESSION_SECRET: z.string(),
  // ...
});

declare global {
  namespace NodeJS {
    interface ProcessEnv extends z.infer<typeof schema> {}
  }
}
```

- **Resource Route パターン**: `app/routes/resources/` に UI を返さない API エンドポイントを集約するパターン。`healthcheck.tsx`, `theme-switch.tsx`, `images.tsx` 等が含まれ、フロントエンドルートと API ルートの混在を防ぐ。`theme-switch.tsx` はコンポーネント (`ThemeSwitch`) とサーバーアクション (`action`) を同一ファイルに含み、UI と API の対応を明確にしている。

- **テストデータベースのプール分離**: `VITEST_POOL_ID` を使ってテストワーカーごとに異なるデータベースファイルを割り当て、並列テスト実行時のデータ競合を防止する:

```typescript
// tests/setup/db-setup.ts:6-9
const poolId = process.env.VITEST_POOL_ID || "0";
const databaseFile = `./tests/prisma/data.${poolId}.db`;
```

## Anti-Patterns / 注意点

- **ルートディレクトリ肥大化**: 設定ファイルがルートに溢れると、アプリケーションの本質が見えにくくなる。Epic Stack は `other/` ディレクトリで緩和しているが、`tsconfig.json`, `vite.config.ts`, `playwright.config.ts` 等はツールの制約でルートに残らざるを得ない。

Bad: 全設定ファイルをルートに放置

```
/
├── Dockerfile
├── docker-compose.yml
├── litefs.yml
├── sly.json
├── svg-icons/
├── tsconfig.json
├── vite.config.ts
└── ...
```

Better: ツール制約のないファイルを `other/` に移動

```
/
├── other/
│   ├── Dockerfile
│   ├── litefs.yml
│   └── svg-icons/
├── tsconfig.json      # ルート必須
├── vite.config.ts     # ルート必須
└── ...
```

- **共有ロジックの過剰な `utils/` 集約**: `app/utils/` に29ファイルが集約されており、ファイル数が増えると見通しが悪くなる。Epic Stack ではサーバー/クライアントのサフィックスとサブディレクトリ (`providers/`) で緩和しているが、ドメインが増える場合は機能ベースの分割を検討すべき。

## 導出ルール

- `[MUST]` サーバー専用コードは `.server.ts` サフィックス等の命名規約でクライアントバンドルから物理的に排除し、バンドラーの設定と合わせて二重のガードを設ける
  - 根拠: `app/routes.ts` で `**/*.server.*` をルートから除外し、`env.server.ts` では `getEnv()` で公開する環境変数を明示的にフィルタリングしている

- `[MUST]` 環境変数はアプリケーション起動時にスキーマバリデーション（Zod 等）で検証し、不正な状態での起動を即座に失敗させる
  - 根拠: `app/utils/env.server.ts:37-48` で Zod スキーマによる検証を起動時に実行し、不足・型不正の環境変数があればプロセスを停止している

- `[SHOULD]` テストファイルはテスト対象モジュールと同一ディレクトリにコロケートし、ファイル検索の認知コストを下げる
  - 根拠: `app/routes/users/$username/index.test.tsx` や `app/utils/auth.server.test.ts` が対象ファイルの隣に配置されている

- `[SHOULD]` フルスタックアプリのルーティングは URL に影響しないプレフィックス（`_auth`, `_marketing` 等）で意味的にグルーピングし、ファイルの探索コストを下げる
  - 根拠: `app/routes/_auth/` に認証関連ルート全てを集約し、`app/routes/_marketing/` にマーケティングページを集約している

- `[SHOULD]` 複数ルートで共有するコンポーネントやサーバーロジックは、最も近い共通の親ディレクトリ内に `+shared` 等の非ルートディレクトリとして配置する
  - 根拠: `app/routes/users/$username/notes/+shared/` に note-editor コンポーネントとアクションを配置し、`$noteId_.edit.tsx` と `new.tsx` が共有している

- `[SHOULD]` import パスのエイリアスはビルドツール固有の設定（tsconfig paths 等）ではなく、ランタイムがネイティブにサポートする仕組み（Node.js subpath imports 等）を優先する
  - 根拠: `package.json` の `imports` フィールドで `#app/*`, `#tests/*` を定義し、TypeScript・Vitest・Playwright のいずれからも解決可能にしている

- `[SHOULD]` 並列テスト実行時はテストワーカーごとにデータベースインスタンスを分離し、テスト間のデータ競合を防止する
  - 根拠: `tests/setup/db-setup.ts` で `VITEST_POOL_ID` を使い、ワーカーごとに独立した SQLite ファイルを割り当てている

- `[AVOID]` アプリケーションの本質に関係しないファイル（Dockerfile、アイコン原本、ツール設定等）をプロジェクトルートに配置し、ルートディレクトリの見通しを悪くすること
  - 根拠: `other/` ディレクトリに Dockerfile, litefs.yml, svg-icons 等を集約し、ルートのノイズを削減している

## 適用チェックリスト

- [ ] サーバー専用モジュールに `.server.ts` サフィックスを付与し、ビルド設定でクライアントバンドルから除外しているか
- [ ] 環境変数のスキーマバリデーションを起動時に実行し、不正な値で起動しない仕組みがあるか
- [ ] クライアントに公開する環境変数を明示的にフィルタリングする関数（`getEnv()` 相当）があるか
- [ ] テストファイルはテスト対象と同一ディレクトリにコロケートされているか
- [ ] ルーティングファイルは意味的なプレフィックスでグルーピングされているか
- [ ] UI を返さない API エンドポイントは `resources/` 等の専用ディレクトリに分離されているか
- [ ] 複数ルート間で共有するロジックは、最も近い共通の親ディレクトリ内に配置されているか
- [ ] import エイリアスはランタイムネイティブの仕組み（Node.js subpath imports 等）で定義されているか
- [ ] ルートディレクトリにアプリケーション本質と無関係なファイルが散乱していないか
- [ ] 並列テスト実行時のデータ分離戦略（DB プール分離等）が用意されているか
