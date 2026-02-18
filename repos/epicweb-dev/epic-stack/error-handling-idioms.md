# error-handling-idioms

> リポジトリ: epicweb-dev/epic-stack
> 分析日: 2026-02-18

## 概要

Epic Stack におけるエラーハンドリングの使い分けパターンを横断的に分析した。このコードベースでは `invariant` / `invariantResponse`（事前条件チェック）、Zod + Conform（バリデーション）、`GeneralErrorBoundary`（UI 境界）の 3 層が明確に分離されており、各レイヤーの責務が重複しない設計になっている。フルスタック React アプリのエラー処理における実用的なリファレンスとして注目に値する。

## 背景にある原則

- **エラーの発生源に最も近い場所で処理する**: バリデーションエラーはフォーム送信の action 内で Zod スキーマにより検出され、ユーザーにフィールド単位のフィードバックとして返される。DB クエリの「存在しない」は `invariantResponse` で即座に HTTP レスポンスに変換される。未知のエラーだけが Error Boundary まで到達する。これにより各レイヤーのエラー処理が予測可能になる。

- **不変条件違反は即座に失敗させる（Fail Fast）**: `invariant` / `invariantResponse` は「この時点でこの条件は必ず満たされているべき」というプログラマの意図を表明する。条件が満たされない場合は即座に例外を投げることで、不正な状態が伝播してデバッグ困難なバグになるのを防ぐ。

- **ユーザー入力のエラーと開発者のバグを区別する**: Zod バリデーション失敗はユーザーの入力ミスであり、フォームにエラーを返す。`invariantResponse` 失敗は「データが存在すべきなのに存在しない」という論理的な不整合であり、HTTP エラーレスポンスを返す。`invariant`（Response なし）はプログラマが「ここには来ないはず」と考える分岐で使う防御的アサーション。

- **console.error の意図しない呼び出しをテストで検出する**: テストセットアップで `console.error` をスパイし、呼び出されると例外を投げる。これにより「警告が出ているがテストは通る」という隠れた問題を防止する。意図的なエラーログが必要なテストでは明示的に `consoleError.mockImplementation(() => {})` を呼ぶ。

## 実例と分析

### invariant vs invariantResponse の使い分け

`@epic-web/invariant` パッケージは 2 つのエクスポートを提供する:

- **`invariant(condition, message)`** — 条件が falsy なら `Error` を throw する。サーバー内部のロジックで「この値は必ず存在するはず」を表明する用途。
- **`invariantResponse(condition, message, options?)`** — 条件が falsy なら `Response` を throw する。HTTP ステータスコードを指定でき、React Router の Error Boundary で捕捉される。

コードベースでの使い分けは明確なパターンに従っている:

**`invariantResponse` — loader/action での DB クエリ結果チェック**（16 箇所以上）:

```typescript
// app/routes/users/$username/notes/$noteId.tsx:43
invariantResponse(note, "Not found", { status: 404 });

// app/routes/settings/profile/connections.tsx:93-102
invariantResponse(formData.get("intent") === "delete-connection", "Invalid intent");
invariantResponse(
  await userCanDeleteConnections(userId),
  "You cannot delete your last connection unless you have a password.",
);
invariantResponse(typeof connectionId === "string", "Invalid connectionId");
```

**`invariant` — サーバーサイドの内部ロジックでのアサーション**（6 箇所）:

```typescript
// app/routes/_auth/login.server.ts:87-90
invariant(
  submission.status === "success",
  "Submission should be successful by now",
);

// app/utils/request-info.ts:10
invariant(maybeRequestInfo, "No requestInfo found in root loader");
```

`invariant` はテストコードでも型の絞り込みとして使われている:

```typescript
// app/routes/_auth/auth.$provider/callback.test.ts:53
invariant(response instanceof Response, "response should be a Response");
```

### Zod + Conform によるフォームバリデーション

バリデーションスキーマは再利用可能な単位で `user-validation.ts` に集約され、サインアップ・ログイン・プロフィール編集で共有される（`app/utils/user-validation.ts:6-48`）。action でのバリデーションパターンは統一されている:

```typescript
// app/routes/users/$username/notes/$noteId.tsx:59-67
const submission = parseWithZod(formData, { schema: DeleteFormSchema });
if (submission.status !== "success") {
  return data(
    { result: submission.reply() },
    { status: submission.status === "error" ? 400 : 200 },
  );
}
```

DB 問い合わせを伴うバリデーションでは `superRefine` / `transform` 内で非同期処理を行い、`ctx.addIssue` でフィールド単位のエラーを追加する（`app/routes/_auth/login.tsx:49-66`, `app/routes/settings/profile/index.tsx:183-204`）。

### GeneralErrorBoundary のカスタマイズパターン

`GeneralErrorBoundary`（`app/components/error-boundary.tsx:16-52`）は `statusHandlers: Record<number, StatusHandler>` を受け取る汎用コンポーネント。各ルートは `params` を使ってコンテキスト情報を含むカスタムメッセージを定義する:

```typescript
// app/routes/users/$username/notes/$noteId.tsx:226-237
export function ErrorBoundary() {
  return (
    <GeneralErrorBoundary
      statusHandlers={{
        403: () => <p>You are not allowed to do that</p>,
        404: ({ params }) => <p>No note with the id "{params.noteId}" exists</p>,
      }}
    />
  );
}
```

root.tsx では最後の砦として `GeneralErrorBoundary` をそのまま使う（`app/root.tsx:263`）。

### Sentry 連携 — 予期しないエラーのみを報告

`GeneralErrorBoundary` 内で `isRouteErrorResponse` を使って HTTP レスポンスエラーと予期しないエラーを分離し、予期しないエラーのみ Sentry に報告する:

```typescript
// app/components/error-boundary.tsx:37-41
useEffect(() => {
  if (isResponse) return;
  captureException(error);
}, [error, isResponse]);
```

404 や 403 のような意図的なエラーレスポンスは Sentry に送らない。

### 環境変数の起動時バリデーション

Zod スキーマでサーバー環境変数を起動時にバリデーションし、不正な状態でアプリが動き続けるのを防止する:

```typescript
// app/utils/env.server.ts:37-48
export function init() {
  const parsed = schema.safeParse(process.env);
  if (parsed.success === false) {
    console.error(
      "Invalid environment variables:",
      parsed.error.flatten().fieldErrors,
    );
    throw new Error("Invalid environment variables");
  }
}
```

### getErrorMessage — unknown 型の安全な変換

`app/utils/misc.tsx:46-58` で `typeof error === 'string'` / `'message' in error` の段階的チェックにより、どんなエラー型でも安全に文字列を取得する。変換できない場合は `console.error` でログを残し `'Unknown Error'` を返す。

### テストでの console スパイによるエラー検出

`tests/setup/setup-test-env.ts:17-36` で `console.error` / `console.warn` を「呼ばれたら例外を投げる」スパイに差し替える。テスト内でエラーを期待する場合は明示的にオプトインする:

```typescript
// app/utils/misc.error-message.test.ts:16-18
test("undefined falls back to Unknown", () => {
  consoleError.mockImplementation(() => {});
  expect(getErrorMessage(undefined)).toBe("Unknown Error");
});
```

### throw redirect パターン — 認証・認可のフロー制御

認証チェックでは `throw redirect` を使い、関数呼び出し元が戻り値を処理する必要をなくす:

```typescript
// app/utils/auth.server.ts:49-66
export async function requireUserId(request: Request, ...) {
  const userId = await getUserId(request)
  if (!userId) {
    // ...
    throw redirect(loginRedirect)
  }
  return userId
}
```

認可失敗では `throw data(...)` で構造化エラーを返す:

```typescript
// app/utils/permissions.server.ts:31-38
if (!user) {
  throw data(
    {
      error: "Unauthorized",
      requiredPermission: permissionData,
      message: `Unauthorized: required permissions: ${permission}`,
    },
    { status: 403 },
  );
}
```

## パターンカタログ

- **Guard Clause / Early Return** (振る舞い)
  - 解決する問題: ネストが深くなる条件分岐、エラーケースの見落とし
  - 適用条件: loader/action の先頭で事前条件をチェックする場面
  - コード例: `app/routes/users/$username/notes/$noteId.tsx:43`（`invariantResponse` による早期リターン）
  - 注意点: `invariantResponse` は Response を throw するため、React Router の Error Boundary で捕捉される前提が必要

- **Strategy パターンの変形 — statusHandlers** (振る舞い)
  - 解決する問題: HTTP ステータスコードごとに異なる UI を表示したいが、ボイラープレートを避けたい
  - 適用条件: エラー表示をルートごとにカスタマイズしたい場合
  - コード例: `app/components/error-boundary.tsx:16-52`
  - 注意点: ハンドラが登録されていないステータスコードは `defaultStatusHandler` にフォールバックする

## Good Patterns

- **`invariantResponse` + `ErrorBoundary` statusHandlers のペアリング**: loader で `invariantResponse(entity, 'Not found', { status: 404 })` を呼び、同じルートの `ErrorBoundary` で `statusHandlers: { 404: ... }` を定義する。この 1:1 対応により、サーバーサイドのエラー発生からクライアントのエラー表示まで一貫したフローが維持される。

```typescript
// app/routes/users/$username/notes/_layout.tsx:23, 92-102
// loader 側
invariantResponse(owner, "Owner not found", { status: 404 });

// 同じファイルの ErrorBoundary
export function ErrorBoundary() {
  return (
    <GeneralErrorBoundary
      statusHandlers={{
        404: ({ params }) => <p>No user with the username "{params.username}" exists</p>,
      }}
    />
  );
}
```

- **バリデーションスキーマの共有と再利用**: `UsernameSchema`, `PasswordSchema` 等を `user-validation.ts` に集約し、サインアップ・ログイン・プロフィール編集の各フォームで再利用する。バリデーションルールの変更が一箇所で済む。

```typescript
// app/utils/user-validation.ts → 各ルートで import して合成
const LoginFormSchema = z.object({
  username: UsernameSchema,
  password: PasswordSchema,
  // ...
});
```

- **console.error スパイの全テスト強制**: テストセットアップで `console.error` を「呼ばれたら例外を投げる」スパイに差し替える。エラーを期待するテストだけ `consoleError.mockImplementation(() => {})` で明示的に許可する。暗黙のエラーログが見過ごされるのを防ぐ。

## Anti-Patterns / 注意点

- **unknown エラーを文字列に変換せずにそのまま表示する**: `catch (e)` のエラーを `String(e)` や `e.message` で直接表示すると、`[object Object]` やスタックトレースがユーザーに見える。

```typescript
// Bad
catch (error) {
  return <p>{String(error)}</p>
}

// Better — getErrorMessage で安全に変換
catch (error) {
  return <p>{getErrorMessage(error)}</p>
}
```

- **invariant と invariantResponse の混同**: loader/action 内で `invariant`（Error を throw）を使うと、Error Boundary で HTTP ステータスコードのカスタムハンドリングができない。loader/action では `invariantResponse` を使い、HTTP セマンティクスを明示する。

```typescript
// Bad — loader 内で invariant を使う
export async function loader({ params }) {
  const user = await findUser(params.id);
  invariant(user, "User not found"); // Error が throw される → 500 扱い
}

// Better — invariantResponse で 404 を明示
export async function loader({ params }) {
  const user = await findUser(params.id);
  invariantResponse(user, "User not found", { status: 404 });
}
```

- **バリデーションエラーを throw で処理する**: ユーザー入力のバリデーション失敗は例外ではなく通常のフローであり、フォームにエラーを返すべき。`throw` するとフォームの状態が失われ、ユーザーが入力をやり直す必要がある。

```typescript
// Bad
if (!submission.success) {
  throw new Response("Validation failed", { status: 400 });
}

// Better — submission.reply() でフォームにエラーを返す
if (submission.status !== "success") {
  return data(
    { result: submission.reply() },
    { status: submission.status === "error" ? 400 : 200 },
  );
}
```

## 導出ルール

- `[MUST]` フォームバリデーション失敗はフォームにエラーを返し、throw しない — ユーザー入力エラーは通常フローとして処理し、フォーム状態を保持する
  - 根拠: Epic Stack の全 action で `submission.status !== 'success'` のときは `data({ result: submission.reply() })` を返しており、throw は使っていない（`app/routes/users/$username/notes/$noteId.tsx:62-67` 他多数）

- `[MUST]` `unknown` 型のエラーは型ガードで安全にメッセージを取り出す — `error.message` への直接アクセスや `String(error)` は避ける
  - 根拠: `getErrorMessage` が `typeof error === 'string'` / `'message' in error` の段階的チェックを行い、どのケースでもユーザーに安全な文字列を返す（`app/utils/misc.tsx:46-58`）

- `[SHOULD]` HTTP レスポンスを生成する事前条件チェックには `invariantResponse`（Response を throw）を使い、内部ロジックのアサーションには `invariant`（Error を throw）を使い分ける
  - 根拠: loader/action の 16 箇所以上で `invariantResponse` が HTTP ステータスコード付きで使われ、ErrorBoundary の `statusHandlers` と対応している。`invariant` は認証後のセッション状態や Root loader のデータ存在チェックなど、HTTP セマンティクスが不要な場面で使われている

- `[SHOULD]` テストセットアップで `console.error` / `console.warn` をスパイし、意図しない呼び出しを例外として検出する — 期待するエラーログは明示的に `mockImplementation(() => {})` でオプトインする
  - 根拠: `tests/setup/setup-test-env.ts:17-36` でグローバルにスパイが設定され、`misc.error-message.test.ts` や `callback.test.ts` で意図的なオプトインが行われている

- `[SHOULD]` Error Boundary はステータスコード別ハンドラを受け取る汎用コンポーネントとして実装し、各ルートでカスタマイズする
  - 根拠: `GeneralErrorBoundary` が `statusHandlers` を props で受け取り、10 以上のルートがそれぞれ 404 / 403 のカスタムメッセージを定義している

- `[SHOULD]` 環境変数はアプリ起動時に Zod スキーマでバリデーションし、不正な状態での起動を防ぐ
  - 根拠: `app/utils/env.server.ts:37-48` で `safeParse` + `throw new Error` により、必須環境変数の欠落を即座に検出する

- `[AVOID]` 予期された HTTP エラー（404, 403 等）を外部エラー監視サービスに送信する — Sentry 等には予期しないエラーのみを報告する
  - 根拠: `GeneralErrorBoundary` で `isRouteErrorResponse` が true の場合は `captureException` をスキップしている（`app/components/error-boundary.tsx:37-41`）

## 適用チェックリスト

- [ ] エラー処理を「バリデーション（Zod）」「事前条件（invariant）」「UI 境界（Error Boundary）」の 3 層に分離しているか
- [ ] フォームバリデーション失敗を throw ではなくフォームへのエラー返却として処理しているか
- [ ] `unknown` 型のエラーから安全にメッセージを取得するユーティリティ関数があるか
- [ ] loader/action での DB 存在チェックに HTTP ステータスコード付きの事前条件チェック（`invariantResponse` 相当）を使っているか
- [ ] Error Boundary でステータスコード別のカスタムメッセージを各ルートで定義しているか
- [ ] テストセットアップで `console.error` / `console.warn` の意図しない呼び出しを検出しているか
- [ ] 環境変数をアプリ起動時にスキーマバリデーションしているか
- [ ] エラー監視サービス（Sentry 等）に予期された HTTP エラーを送信していないか
