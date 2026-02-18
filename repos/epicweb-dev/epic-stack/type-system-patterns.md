# 型システムパターン

> リポジトリ: epicweb-dev/epic-stack
> 分析日: 2026-02-18

## 概要

Epic Stack における型システムの活用パターンを分析する。Zod スキーマを「バリデーションと型定義の唯一の情報源 (Single Source of Truth)」として位置づけ、`z.infer` で TypeScript 型を導出する一貫したアプローチが特徴的である。さらに Prisma 生成型の Indexed Access による部分利用、`declare module` / `declare global` によるグローバル型拡張、`satisfies` 演算子による型の整合性検証など、型安全性を最大化しつつ冗長さを排除する実践が体系的に適用されている。

## 背景にある原則

- **スキーマ駆動型定義 (Schema-First Typing)**: ランタイムバリデーションスキーマから型を導出することで、型定義とバリデーションロジックの乖離を構造的に防ぐ。手書きの型定義 + 別途バリデーションという二重管理を排除する設計判断である。`app/utils/toast.server.ts` の `Toast` 型や `app/utils/connections.tsx` の `ProviderName` 型が典型例。

- **型の境界防御 (Type Boundary Defense)**: 外部入力（API レスポンス、フォームデータ、環境変数、Cookie）がシステムに入る「境界」で Zod による parse/safeParse を行い、境界の内側では型安全な値として扱う。`app/utils/env.server.ts` の環境変数バリデーションや `app/utils/providers/github.server.ts` の API レスポンスバリデーションに一貫して適用されている。

- **型の構造的再利用 (Structural Type Reuse)**: Prisma 生成型を `User['username']` のように Indexed Access Type で部分的に参照し、必要なフィールドだけを型として取り出す。モデル全体の型に依存せず、関数シグネチャを軽量に保つ。`app/utils/auth.server.ts` 全体で適用されている。

- **宣言的マージによる型拡張 (Declaration Merging for Type Extension)**: `declare module` / `declare global` を使い、既存ライブラリの型定義をプロジェクト固有の要件に合わせて拡張する。環境変数の型安全性（`ProcessEnv`）、テストマッチャー（Vitest `Assertion`）、フレームワーク型（React Router `AppLoadContext`）に適用されている。

## 実例と分析

### Zod スキーマからの型導出パターン

プロジェクト全体で `z.infer<typeof Schema>` による型導出が一貫して使われている。スキーマ定義と型定義を同一ファイルに配置し、エクスポートすることで他モジュールからの利用を容易にしている。

特筆すべきは `z.infer` と `z.input` の使い分けである。`app/utils/toast.server.ts` では、`Toast` 型（parse 後のデフォルト値適用済み型）と `ToastInput` 型（parse 前の入力型）を明確に区別している。これにより、関数の引数にはデフォルト値なしの `ToastInput` を受け取り、内部処理ではデフォルト値適用済みの `Toast` を使うという型レベルの契約が実現されている。

### Zod + Conform によるフォームバリデーション統合

ほぼ全てのフォームルートで、Zod スキーマが 3 つの役割を同時に担っている:

1. **サーバーサイドバリデーション**: `parseWithZod(formData, { schema })` でフォームデータをパースし、型安全な値を取得
2. **クライアントサイドバリデーション**: `onValidate` コールバック内で同一スキーマを使用
3. **HTML 制約の自動導出**: `getZodConstraint(Schema)` で HTML5 バリデーション属性を自動生成

この設計により、1 つの Zod スキーマ定義から型定義・サーバー検証・クライアント検証・HTML 制約が全て導出される。

### バリデーションスキーマの合成パターン

`app/utils/user-validation.ts` では基本的なフィールドスキーマ（`UsernameSchema`, `PasswordSchema`, `EmailSchema`, `NameSchema`）を個別に定義し、各ルートファイルでそれらを `.object()` や `.and()` で合成している。

```typescript
// app/routes/_auth/onboarding/index.tsx:31-42
const SignupFormSchema = z
  .object({
    username: UsernameSchema,
    name: NameSchema,
    agreeToTermsOfServiceAndPrivacyPolicy: z.boolean({
      required_error: "You must agree to the terms of service and privacy policy",
    }),
    remember: z.boolean().optional(),
    redirectTo: z.string().optional(),
  })
  .and(PasswordAndConfirmPasswordSchema);
```

### 環境変数の型安全化

`app/utils/env.server.ts` は Zod スキーマ + `declare global` + `z.infer` の組み合わせで、`process.env` のアクセスを完全に型安全にしている。アプリケーション起動時に `init()` でバリデーションを実行し、不正な環境変数を早期に検出する。

### 外部 API レスポンスのバリデーション

`app/utils/providers/github.server.ts` では GitHub API のレスポンスに対して個別の Zod スキーマを定義し、`parse()` で型安全に変換している。`safeParse()` はキャッシュ更新のような失敗が許容されるケースで使い分けられている。

### `satisfies` 演算子による型整合性の検証

`satisfies` は型推論を保持しつつ、値が特定の型に適合することを検証する場面で使われている。特に Zod スキーマが外部ライブラリの型と整合することを保証するパターンが特徴的。

### Prisma 型の Indexed Access による部分利用

`app/utils/auth.server.ts` では `User['username']`, `User['email']`, `Connection['providerId']` のように Prisma 生成型をフィールド単位で参照している。Prisma の型をそのまま import して使うのではなく、必要なフィールドだけを取り出す。

### テストカスタムマッチャーの型拡張

`tests/setup/custom-matchers.ts` では `expect.extend()` でカスタムマッチャーを追加し、`declare module 'vitest'` で `Assertion` / `AsymmetricMatchersContaining` インターフェースを拡張している。

### テンプレートリテラル型による Permission 文字列

`app/utils/user.ts` では `PermissionString` 型をテンプレートリテラル型のユニオンとして定義し、権限文字列の形式を型レベルで制約している。

## コード例

```typescript
// app/utils/env.server.ts:1-48
// Zod スキーマ → declare global で process.env を型安全化
const schema = z.object({
  NODE_ENV: z.enum(["production", "development", "test"] as const),
  DATABASE_PATH: z.string(),
  // ...
});

declare global {
  namespace NodeJS {
    interface ProcessEnv extends z.infer<typeof schema> {}
  }
}

export function init() {
  const parsed = schema.safeParse(process.env);
  if (parsed.success === false) {
    console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment variables");
  }
}
```

```typescript
// app/utils/toast.server.ts:8-16
// z.infer と z.input の使い分け
const ToastSchema = z.object({
  description: z.string(),
  id: z.string().default(() => cuid()),
  title: z.string().optional(),
  type: z.enum(["message", "success", "error"]).default("message"),
});

export type Toast = z.infer<typeof ToastSchema>; // parse 後: id と type が必須
export type ToastInput = z.input<typeof ToastSchema>; // parse 前: id と type は省略可
```

```typescript
// app/routes/_auth/webauthn/utils.server.ts:23-52
// satisfies で Zod スキーマと外部ライブラリ型の整合性を検証
export const RegistrationResponseSchema = z.object({
  id: z.string(),
  rawId: z.string(),
  response: z.object({
    clientDataJSON: z.string(),
    attestationObject: z.string(),
    transports: z.array(z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"])).optional(),
  }),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  clientExtensionResults: z.object({ credProps: z.object({ rk: z.boolean() }).optional() }),
  type: z.literal("public-key"),
}) satisfies z.ZodType<RegistrationResponseJSON>;
```

```typescript
// app/utils/auth.server.ts:76-82, 151-163
// Prisma 型の Indexed Access による部分利用
import { type Connection, type Password, type User } from "@prisma/client";

export async function login({ username, password }: {
  username: User["username"];
  password: string;
}) {/* ... */}

export async function signupWithConnection({
  email,
  username,
  name,
  providerId,
  providerName,
  imageUrl,
}: {
  email: User["email"];
  username: User["username"];
  name: User["name"];
  providerId: Connection["providerId"];
  providerName: Connection["providerName"];
  imageUrl?: string;
}) {/* ... */}
```

```typescript
// tests/setup/custom-matchers.ts:160-169
// Vitest カスタムマッチャーの型拡張
interface CustomMatchers<R = unknown> {
  toHaveRedirect(redirectTo: string | null): R;
  toHaveSessionForUser(userId: string): Promise<R>;
  toSendToast(toast: ToastInput): Promise<R>;
}

declare module "vitest" {
  interface Assertion<T = any> extends CustomMatchers<T> {}
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}
```

```typescript
// app/utils/user.ts:28-33
// テンプレートリテラル型で Permission 文字列を型制約
type Action = "create" | "read" | "update" | "delete";
type Entity = "user" | "note";
type Access = "own" | "any" | "own,any" | "any,own";
export type PermissionString =
  | `${Action}:${Entity}`
  | `${Action}:${Entity}:${Access}`;
```

```typescript
// app/routes/users/$username/notes/+shared/note-editor.server.tsx:15-25
// 型ガード関数で Zod 導出型を絞り込み
function imageHasFile(
  image: ImageFieldset,
): image is ImageFieldset & { file: NonNullable<ImageFieldset["file"]>; } {
  return Boolean(image.file?.size && image.file?.size > 0);
}

function imageHasId(
  image: ImageFieldset,
): image is ImageFieldset & { id: string; } {
  return Boolean(image.id);
}
```

```typescript
// app/utils/cache.server.ts:78-90
// satisfies で Cache インターフェース準拠を検証しつつ型推論を保持
export const lruCache = {
  name: "app-memory-cache",
  set: (key, value) => {
    const ttl = totalTtl(value?.metadata);
    lru.set(key, value, {
      ttl: ttl === Infinity ? undefined : ttl,
      start: value?.metadata?.createdTime,
    });
    return value;
  },
  get: (key) => lru.get(key),
  delete: (key) => lru.delete(key),
} satisfies Cache;
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 外部 API のレスポンス型とアプリケーション内部の型のミスマッチ
  - 適用条件: 外部 API からのレスポンスを内部型に変換する必要がある場合
  - コード例: `app/utils/providers/github.server.ts:61-98` - GitHub API レスポンスを Zod でパースし `ProviderUser` 型に変換
  - 注意点: `parse()` は例外を投げるので、失敗が許容される場面では `safeParse()` を使い分ける

- **Type Guard パターン** (分類: 振る舞い)
  - 解決する問題: Zod 導出型のオプショナルフィールドを安全に絞り込む
  - 適用条件: `z.infer` で得られた型のオプショナルフィールドに基づいて処理を分岐する場合
  - コード例: `app/routes/users/$username/notes/+shared/note-editor.server.tsx:15-25`
  - 注意点: `is` 述語の戻り値型を交差型 (`&`) で正確に記述する

## Good Patterns

- **Zod スキーマの合成と再利用**: `user-validation.ts` でフィールドレベルのスキーマを定義し、各ルートで `.object()` / `.and()` で合成する。バリデーションルールの変更が全フォームに自動的に伝播する。
  ```typescript
  // app/utils/user-validation.ts:6-14
  export const UsernameSchema = z
    .string({ required_error: "Username is required" })
    .min(USERNAME_MIN_LENGTH, { message: "Username is too short" })
    .max(USERNAME_MAX_LENGTH, { message: "Username is too long" })
    .regex(/^[a-zA-Z0-9_]+$/, { message: "..." })
    .transform((value) => value.toLowerCase());
  ```

- **`as const` + `z.enum` による列挙型の一元管理**: 配列リテラルを `as const` で定義し、`z.enum()` に渡すことで、ランタイム値の一覧と型定義を一箇所で管理する。`Record<ProviderName, string>` のように派生利用も型安全になる。
  ```typescript
  // app/utils/connections.tsx:10-16
  export const providerNames = [GITHUB_PROVIDER_NAME] as const;
  export const ProviderNameSchema = z.enum(providerNames);
  export type ProviderName = z.infer<typeof ProviderNameSchema>;
  export const providerLabels: Record<ProviderName, string> = {
    [GITHUB_PROVIDER_NAME]: "GitHub",
  } as const;
  ```

- **`satisfies` による Zod スキーマと外部型の整合性保証**: 外部ライブラリの型（`RegistrationResponseJSON` 等）に対して Zod スキーマが正しく対応していることをコンパイル時に検証する。スキーマと型がずれた場合にコンパイルエラーとして検出できる。
  ```typescript
  // app/routes/_auth/webauthn/utils.server.ts:52
  }) satisfies z.ZodType<RegistrationResponseJSON>
  ```

- **`satisfies` による値の型制約（推論保持）**: `as const` で具体的なリテラル型を保持しつつ、`satisfies` で構造的な型制約を検証する。型アサーション (`as`) と異なり、値の型推論を狭めない。
  ```typescript
  // app/utils/cache.server.ts:90
  } satisfies Cache
  ```

## Anti-Patterns / 注意点

- **`any` の残存**: テスト型拡張で `Assertion<T = any>` の `any` が残っているが、これは Vitest の型定義に合わせるために必要な妥協である。一方 `app/utils/user.ts:4` の `isUser(user: any)` は型ガードの引数であり、`unknown` に置き換え可能である。
  ```typescript
  // Bad: any を使ったガード
  function isUser(user: any): user is ... { ... }
  // Better: unknown を使ったガード
  function isUser(user: unknown): user is ... { ... }
  ```

- **型アサーション (`as`) の使用箇所**: `app/utils/user.ts:36` で `permissionString.split(':') as [Action, Entity, Access | undefined]` のように `as` による型アサーションが使われている。split の結果が期待通りの構造であることはランタイムで保証されないため、Zod バリデーションに置き換えるとより安全になる。
  ```typescript
  // Bad: split 結果を as で型アサーション
  const [action, entity, access] = permissionString.split(":") as [Action, Entity, Access | undefined];
  // Better: Zod で構造を検証する、またはテンプレートリテラル型で入力を制約した上で型ガードを使用
  ```

- **`@ts-expect-error` の安易な使用**: `app/routes/admin/cache/sqlite.server.ts:55` で `@ts-expect-error` が使われているが、理由コメント付きであり、型が本質的に不明な場合（キャッシュの汎用値）の妥当な使用である。理由なしの `@ts-expect-error` は避けるべきである。

## 導出ルール

- `[MUST]` ランタイムバリデーションスキーマ（Zod 等）から `z.infer` で型を導出し、手書きの型定義との二重管理を避ける
  - 根拠: Epic Stack の全フォーム・環境変数・API レスポンスで一貫してスキーマ駆動型定義が適用されており、型とバリデーションの不一致が構造的に排除されている（`app/utils/env.server.ts`, `app/utils/toast.server.ts` 等 7 箇所）
- `[MUST]` 外部入力（API レスポンス・フォームデータ・環境変数・Cookie）はシステム境界で必ず Zod `parse()` / `safeParse()` を通し、境界の内側では型安全な値として扱う
  - 根拠: `app/utils/providers/github.server.ts` では GitHub API レスポンスを `GitHubUserResponseSchema.parse(rawUser)` で検証してから使用しており、外部データの型安全性を境界で担保している
- `[SHOULD]` Zod スキーマに `.default()` や `.transform()` がある場合、`z.infer`（出力型）と `z.input`（入力型）を区別して使い分ける
  - 根拠: `app/utils/toast.server.ts` で `Toast`（出力型）と `ToastInput`（入力型）を明確に分け、関数の引数にはデフォルト値なしの入力型を要求している
- `[SHOULD]` ORM 生成型はフィールド単位の Indexed Access（`Model['field']`）で部分参照し、関数シグネチャをモデル全体の型に依存させない
  - 根拠: `app/utils/auth.server.ts` で `User['username']`, `Connection['providerId']` のように Prisma 型をフィールド単位で参照し、関数の引数型を最小限に保っている
- `[SHOULD]` 外部ライブラリの型に合わせて Zod スキーマを書く場合、`satisfies z.ZodType<ExternalType>` でスキーマと型の整合性をコンパイル時に検証する
  - 根拠: `app/routes/_auth/webauthn/utils.server.ts` で `RegistrationResponseJSON` と `AuthenticationResponseJSON` に対してスキーマの整合性を `satisfies` で保証している
- `[SHOULD]` バリデーションスキーマの基本単位をフィールドレベルで定義し、各ユースケースで合成（`.object()`, `.and()`, `.merge()`）する
  - 根拠: `app/utils/user-validation.ts` でフィールドスキーマを定義し、`login.tsx`, `onboarding/index.tsx`, `signup.tsx` 等 6 箇所以上で合成再利用されている
- `[SHOULD]` テストフレームワークのカスタムマッチャーを追加する際は、実装と `declare module` による型拡張を同一ファイルに配置する
  - 根拠: `tests/setup/custom-matchers.ts` で `expect.extend()` と `declare module 'vitest'` が同一ファイルにあり、実装と型の乖離を防いでいる
- `[AVOID]` 型アサーション (`as`) を使ってランタイムで検証されていない構造を型付けすること。代わりに Zod バリデーションや型ガードを使う
  - 根拠: プロジェクト全体で `as` の使用は最小限に抑えられ、外部入力の型付けには一貫して Zod が使われている。`as` が残っている箇所（`user.ts:36` の split 結果）は改善候補として認識できる

## 適用チェックリスト

- [ ] プロジェクトの全ての外部入力（API レスポンス、フォームデータ、環境変数、URL パラメータ）に対して Zod スキーマが定義されているか
- [ ] 型定義が手書きで Zod スキーマと別管理になっている箇所がないか。ある場合は `z.infer` に置き換えられるか
- [ ] `.default()` や `.transform()` を持つスキーマで `z.infer` と `z.input` の区別が必要な箇所を見落としていないか
- [ ] テストのカスタムマッチャーに `declare module` による型拡張が付いているか
- [ ] 環境変数が `declare global` + Zod スキーマで型安全化されているか
- [ ] フォームバリデーションの Zod スキーマがサーバーとクライアントの両方で共有されているか
- [ ] ORM 生成型をモデル全体で import せず、Indexed Access で必要なフィールドだけ参照しているか
- [ ] 外部ライブラリの型に対応する Zod スキーマに `satisfies z.ZodType<T>` が付いているか
