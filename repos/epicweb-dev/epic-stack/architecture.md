# architecture

> リポジトリ: epicweb-dev/epic-stack
> 分析日: 2026-02-18

## 概要

Express v5 + React Router v7 (SSR) + Prisma + SQLite によるフルスタック構成のレイヤー設計を分析する。このスタックは「サーバーファースト」のアーキテクチャを採用し、ファイル命名規約 (`.server.ts` / `.client.ts`) によるビルド時の境界強制、Express ミドルウェアチェーンによるインフラ関心事の分離、ルートファイルへのサーバーロジック共存 (colocation) を特徴とする。レイヤーが3層で完結し、依存方向が一方向に整理されている点が注目に値する。

## 背景にある原則

- **ビルドツールを境界の守護者にする**: `.server.ts` / `.client.ts` のファイル命名規約により、Vite の tree-shaking が自動的にサーバー専用コードのクライアントバンドル混入を防ぐ。実行時のチェックではなくビルド時に境界を強制することで、秘匿情報の漏洩リスクを構造的に排除する。`app/routes.ts:15-16` で `*.server.*` と `*.client.*` がルートファイルから除外されている設計がこの原則を裏付ける。

- **インフラ関心事はアプリケーション層の外で処理する**: HTTPS リダイレクト、レートリミット、CSP ヘッダー、ログ、圧縮などのインフラ横断的関心事を Express ミドルウェアチェーン (`server/index.ts`) に集約し、アプリケーションコード (`server/app.ts`, `app/` 以下) を純粋なビジネスロジックに保つ。これによりルートハンドラの可読性が向上し、セキュリティ設定が一箇所で管理される。

- **データアクセスをルートに近づける (colocation)**: DB クエリを専用のリポジトリ層やサービス層に抽象化せず、ルートの `loader` / `action` に直接書く。中間層の不要な抽象を排除し、各ルートが必要なデータを `select` で最小限に取得する。ただし認証・認可のような横断的ロジックは `utils/*.server.ts` に抽出する。

- **環境変数はバリデーション後にのみ使用する**: `app/utils/env.server.ts` で Zod スキーマによるバリデーションを起動時に実行し、型安全な `process.env` を保証する。さらに `getEnv()` で公開可能な変数のみを明示的にホワイトリストで選別し、クライアントに渡す。

## 実例と分析

### 3 層アーキテクチャと依存方向

このスタックは明確な 3 層構造を持つ:

1. **インフラ層** (`server/index.ts`): HTTP サーバー起動、ミドルウェアチェーン、Vite 開発サーバー統合
2. **アプリケーション層** (`server/app.ts` + `app/`): React Router のリクエストハンドリング、ルートの loader/action、UI コンポーネント
3. **データ層** (`prisma/schema.prisma` + `app/utils/db.server.ts`): Prisma クライアント、SQLite

依存方向は `インフラ → アプリケーション → データ` の一方向に統一されている。`server/index.ts` が `server/app.ts` を import し、ルートファイルが `db.server.ts` を import する。逆方向の依存は存在しない。

### エントリポイントの分離パターン

起動シーケンスは 3 段階に分離されている:

```
index.ts (dotenv + source-map + mocks)
  └→ server/index.ts (Express + ミドルウェア + Vite)
       └→ server/app.ts (React Router ハンドラ)
```

`index.ts` はインフラの初期化 (ソースマップ、モック) のみを担当し、HTTP サーバーの構成は `server/index.ts` に委譲する。`server/app.ts` は React Router のリクエストハンドラのみを定義し、Express のミドルウェア構成を一切知らない。

### ファイル命名規約による境界の強制

`.server.ts` サフィックスを持つファイルはサーバーサイドのみで使用される。この規約はルーティング設定 (`app/routes.ts:15-16`) と Vite プラグイン `vite-env-only` で強制される。

サーバー専用ファイルの分類:
- **データアクセス**: `db.server.ts`, `cache.server.ts`, `storage.server.ts`
- **認証・認可**: `auth.server.ts`, `session.server.ts`, `permissions.server.ts`
- **外部サービス**: `email.server.ts`, `connections.server.ts`
- **ユーティリティ**: `timing.server.ts`, `toast.server.ts`, `honeypot.server.ts`, `env.server.ts`
- **ルート共存**: `login.server.ts`, `verify.server.ts` (ルートファイルの隣に配置)

一方、`.server` サフィックスを持たないファイル (`user.ts`, `misc.tsx`, `connections.tsx`) はサーバー/クライアント両方で使用される。`user.ts` の `userHasPermission` は UI での条件分岐にもサーバーでの認可にも使われる設計。

### ルート共存 (Route Colocation) とサーバーロジックの分離

ルートディレクトリ内にサーバー専用ロジックを共存させるパターンが一貫して使われている:

```
app/routes/_auth/
├── login.tsx           # UI + loader + action (軽量)
├── login.server.ts     # handleNewSession, 2FA 処理
├── verify.tsx          # UI + loader + action (軽量)
└── verify.server.ts    # prepareVerification, validateRequest
```

ルート `.tsx` ファイルの `action` はフォームバリデーションまでを担当し、ビジネスロジックの本体は隣接する `.server.ts` に委譲する。これにより UI ファイルが肥大化せず、サーバーロジックの単体テストも容易になる。

### +shared ディレクトリによる共有ロジック

```
app/routes/users/$username/notes/
├── +shared/
│   ├── note-editor.tsx         # 共有コンポーネント + Zod スキーマ
│   └── note-editor.server.tsx  # 共有 action ハンドラ
├── $noteId_.edit.tsx           # export { action } from './+shared/note-editor.server.tsx'
└── new.tsx                     # 同じ action を再利用
```

`+shared` プレフィックスディレクトリで、複数ルートが共有するコンポーネントとサーバーロジックを配置する。`$noteId_.edit.tsx:8` では `export { action } from './+shared/note-editor.server.tsx'` として action を再エクスポートし、コード重複を排除している。

### 認証・認可の段階的ガードパターン

認証チェックは `getUserId` → `requireUserId` → `requireUserWithPermission` / `requireUserWithRole` の段階的な関数チェーンで構成される:

```typescript
// app/utils/auth.server.ts:29-46
export async function getUserId(request: Request) {
  const authSession = await authSessionStorage.getSession(
    request.headers.get('cookie'),
  )
  const sessionId = authSession.get(sessionKey)
  if (!sessionId) return null
  const session = await prisma.session.findUnique({
    select: { userId: true },
    where: { id: sessionId, expirationDate: { gt: new Date() } },
  })
  if (!session?.userId) {
    throw redirect('/', {
      headers: {
        'set-cookie': await authSessionStorage.destroySession(authSession),
      },
    })
  }
  return session.userId
}
```

`getUserId` は null を返す (未認証を許容)。`requireUserId` は null の場合にリダイレクトを throw する。`requireUserWithPermission` はさらに RBAC チェックを追加する。ルートの要件に応じて適切なレベルを選択する。

### 二重キャッシュ戦略

`app/utils/cache.server.ts` では LRU キャッシュ (インメモリ) と SQLite キャッシュ (永続化) の二層構造を採用。さらに LiteFS による分散環境では、プライマリインスタンスのみが SQLite に書き込み、セカンダリはプライマリへ HTTP リクエストで委譲する。

```typescript
// app/utils/cache.server.ts:158-177
async set(key, entry) {
  const { currentIsPrimary, primaryInstance } = await getInstanceInfo()
  if (currentIsPrimary) {
    setStatement.run(key, value, JSON.stringify(entry.metadata))
  } else {
    void updatePrimaryCacheValue({ key, cacheValue: entry })
  }
},
```

### 環境変数の安全なクライアント公開

```typescript
// app/utils/env.server.ts:59-65
export function getEnv() {
  return {
    MODE: process.env.NODE_ENV,
    SENTRY_DSN: process.env.SENTRY_DSN,
    ALLOW_INDEXING: process.env.ALLOW_INDEXING,
  }
}
```

`getEnv()` がホワイトリスト方式で公開変数を選別し、`root.tsx` の loader でクライアントに渡す。`entry.server.tsx:23` で `global.ENV = getEnv()` としてサーバーサイドでもアクセス可能にする。`entry.client.tsx:5` では `ENV.MODE` を参照して条件付き初期化を行う。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 認証プロバイダ (GitHub, etc.) の追加・変更をアプリケーションコードに影響させない
  - 適用条件: 同一インターフェースで複数の実装が必要な場合
  - コード例: `app/utils/providers/provider.ts:13-23` で `AuthProvider` インターフェースを定義し、`app/utils/providers/github.server.ts:43` で `GitHubProvider` が実装する。`app/utils/connections.server.ts:7-9` でレジストリに登録。
  - 注意点: プロバイダ追加時は `connections.tsx` の `providerNames` 配列と `connections.server.ts` の `providers` 辞書の両方を更新する必要がある

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 認証 → 認可 → ビジネスロジックの段階的処理
  - 適用条件: リクエスト処理で複数のガードを段階的に適用する場合
  - コード例: `auth.server.ts` の `getUserId` → `requireUserId` → `permissions.server.ts` の `requireUserWithPermission`
  - 注意点: 各関数は前段の結果に依存するため、呼び出し順序を変えられない

## Good Patterns

- **select によるデータ取得の最小化**: 全ルートの Prisma クエリで `select` を明示的に指定し、必要なフィールドのみを取得する。`include` の使用は `download-user-data.tsx:16` のような「全データをエクスポートする」例外的ケースでのみ許容し、コメントで理由を明記する。

```typescript
// app/routes/users/$username/notes/$noteId.tsx:25-41
const note = await prisma.note.findUnique({
  where: { id: params.noteId },
  select: {
    id: true,
    title: true,
    content: true,
    ownerId: true,
    updatedAt: true,
    images: {
      select: { id: true, altText: true, objectKey: true },
    },
  },
})
```

- **関心事ベースのミドルウェア順序**: `server/index.ts` でミドルウェアを「セキュリティ (HTTPS, Helmet) → パフォーマンス (compression) → 監視 (morgan) → レートリミット → 静的ファイル → アプリケーション」の順序で配置し、リクエストが到達する前に横断的関心事を処理する。

```typescript
// server/index.ts:32-65 (抜粋)
app.use(/* HTTPS リダイレクト */)
app.use(/* 末尾スラッシュ除去 */)
app.use(compression())
app.disable('x-powered-by')
app.use(/* Helmet CSP */)
app.use(morgan('tiny', { skip: /* ... */ }))
app.use(/* レートリミット */)
```

- **`remember` によるシングルトン管理**: `@epic-web/remember` を使い、開発環境の HMR でモジュールが再評価されてもインスタンスが重複しない仕組み。DB 接続 (`db.server.ts:6`) とキャッシュ (`cache.server.ts:24,73`) で使用。

```typescript
// app/utils/db.server.ts:6
export const prisma = remember('prisma', () => {
  const client = new PrismaClient({ /* ... */ })
  void client.$connect()
  return client
})
```

## Anti-Patterns / 注意点

- **ルートファイル内の直接 Prisma 呼び出しの肥大化**: colocation パターンは軽量なクエリには適するが、複雑なビジネスロジックがルートファイル内で膨らむと可読性が低下する。Epic Stack では `login.server.ts` や `verify.server.ts` への分離で対処しているが、この分離判断の基準が明文化されていない。

```typescript
// Bad: ルートファイル内に複雑なビジネスロジックが直接展開
export async function action({ request }) {
  const userId = await requireUserId(request)
  // 50行の複雑なビジネスロジック...
  await prisma.note.update({ /* 複雑なネスト */ })
}

// Better: 隣接する .server.ts ファイルに委譲
// route.tsx
export { action } from './route.server.ts'
// route.server.ts
export async function action({ request }) { /* ... */ }
```

- **LiteFS キャッシュ同期の fire-and-forget**: `cache.server.ts:166` でセカンダリからプライマリへのキャッシュ更新を `void` で fire-and-forget している。ネットワーク障害時にキャッシュ不整合が発生しうるが、キャッシュの特性上許容している。本番データに同じパターンを適用すると危険。

```typescript
// app/utils/cache.server.ts:166-177
// Bad: ビジネスクリティカルなデータに fire-and-forget
void updateCriticalData({ key, value })

// Better: キャッシュのように再生成可能なデータにのみ使用
void updatePrimaryCacheValue({ key, cacheValue: entry })
  .then((response) => {
    if (!response.ok) console.error(/* エラーログ */)
  })
```

## 導出ルール

- `[MUST]` サーバー専用コード (DB アクセス、秘匿情報、Node.js API) はファイル命名規約 (`.server.ts`) またはビルドツールの仕組みでクライアントバンドルへの混入を構造的に防止する
  - 根拠: `app/routes.ts:15-16` で `*.server.*` をルートから除外し、`vite-env-only` プラグインでサーバー専用マクロを提供している

- `[MUST]` 環境変数はアプリケーション起動時にスキーマバリデーション (Zod 等) を実行し、型安全を保証した上で使用する。クライアントへの公開はホワイトリスト方式で明示的に選別する
  - 根拠: `env.server.ts` の `init()` で全環境変数を Zod でバリデーションし、`getEnv()` で公開変数のみを返す二段構え

- `[SHOULD]` インフラ横断的関心事 (セキュリティヘッダー、レートリミット、ログ、圧縮) はアプリケーションのルートハンドラの外側 (ミドルウェア層やリバースプロキシ) に集約し、ビジネスロジックから分離する
  - 根拠: `server/index.ts` に全てのインフラミドルウェアが集約されており、`server/app.ts` のアプリケーションコードは 23 行で純粋なリクエストハンドリングのみ

- `[SHOULD]` ORM クエリでは `select` を明示的に指定し、必要なフィールドのみを取得する。`include` や暗黙の全カラム取得はデータエクスポートなど例外的ケースに限定し、理由をコメントで残す
  - 根拠: 全ルートファイルが `select` を使用し、唯一の `include` 使用箇所 (`download-user-data.tsx:15`) ではコメントで理由を明示している

- `[SHOULD]` 認証・認可ガードは段階的な関数チェーン (`getOptionalUser` → `requireUser` → `requireUserWithPermission`) で構成し、ルートの要件に応じた最小限のガードレベルを選択する
  - 根拠: `getUserId` (nullable), `requireUserId` (redirect), `requireUserWithPermission` (403) が段階的に構成されている

- `[AVOID]` フルスタックフレームワークの「サーバー/クライアント共用ファイル」に秘匿ロジックを混在させること。共用ファイル (`user.ts`, `misc.tsx`) にはクライアントに公開されても問題ない純粋関数のみを配置する
  - 根拠: `user.ts` の `userHasPermission` は純粋な配列フィルタ関数であり、秘匿情報を含まない。DB アクセスや秘匿情報が必要なロジックは全て `.server.ts` に分離されている

## 適用チェックリスト

- [ ] サーバー専用コードを識別するファイル命名規約またはビルドツール設定が存在するか確認する
- [ ] 環境変数の起動時バリデーション (Zod / ArkType 等) を導入し、型安全を保証する
- [ ] クライアントに公開する環境変数をホワイトリスト方式で明示的に選別する関数を用意する
- [ ] インフラ横断的関心事 (セキュリティ、ログ、レートリミット) がアプリケーションコードと混在していないか確認する
- [ ] ORM クエリで `select` を明示し、過剰なデータ取得を防止する
- [ ] 認証・認可ガードが段階的に構成され、各ルートが適切なレベルを使用しているか確認する
- [ ] HMR 環境でのシングルトン管理 (DB 接続、キャッシュ) が適切に処理されているか確認する
- [ ] ルートファイルが肥大化している場合、隣接する `.server.ts` ファイルへのロジック分離を検討する
