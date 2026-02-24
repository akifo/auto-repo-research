# API Design Practices

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC の公開 API 設計、`unstable-core-do-not-import` によるエクスポート戦略、サブパス exports による API 境界制御を分析する。tRPC は単一パッケージ内に「ユーザー向け安定 API」「エコシステム向け内部 API」「パッケージ間共有 API」の 3 層を持ち、`package.json` の `exports` フィールドと ESLint ルールの組み合わせで境界を強制している。この設計は TypeScript ライブラリにおける API サーフェス管理の先進的な事例であり、破壊的変更の最小化と拡張性の両立を実現している。

## 背景にある原則

- **API サーフェスは意図的に狭く保つべき。内部実装が必要なエコシステムには「非推奨名」の専用パスで公開する**: tRPC は全内部実装を `unstable-core-do-not-import` サブパスで公開しつつ、名前自体が「使うな」と警告する。安定 API（`@trpc/server`）は `initTRPC` と少数のヘルパー型のみを再エクスポートし、ユーザーが触れる表面積を最小化している（`packages/server/src/@trpc/server/index.ts`）。
- **破壊的変更のリスクは命名規約で可視化すべき**: `experimental_` プレフィクスを不安定な API に付与し、`@deprecated` JSDoc タグを廃止予定 API に付与する。これにより IDE が自動的に警告を出し、コンパイル時に変更リスクが可視化される（`experimental_caller`, `experimental_standaloneMiddleware`, `sse` の `@deprecated` など）。
- **Fluent API の初期化は単一エントリポイントに集約すべき。設定の爆発を防ぐために Builder パターンを使う**: `initTRPC.context<T>().meta<M>().create(opts)` という Fluent Builder で型パラメータを段階的に注入し、最終的に `TRPCRootObject` を1回だけ生成する。関数オーバーロードでは表現困難な「型パラメータの段階的構築」を Builder パターンで解決している（`packages/server/src/unstable-core-do-not-import/initTRPC.ts:117-222`）。
- **バリデータライブラリへの依存は Duck Typing で回避すべき**: `Parser` 型は Zod・Valibot・ArkType・Yup・Superstruct 等をすべてダックタイピングで統一し、特定のバリデーションライブラリへの依存を完全に排除している（`packages/server/src/unstable-core-do-not-import/parser.ts`）。

## 実例と分析

### 3 層エクスポート戦略

tRPC の `@trpc/server` パッケージは `package.json` の `exports` フィールドで 15 以上のサブパスを定義し、API を 3 つの層に分離している。

**第 1 層: 安定公開 API**（`@trpc/server`）はユーザーが日常的に使う API のみを公開する。`packages/server/src/@trpc/server/index.ts` がこの層のゲートキーパーで、内部の型を `AnyTRPCRouter`, `TRPCProcedureBuilder` のように `TRPC` プレフィクスを付けてリネームエクスポートしている。

```typescript
// packages/server/src/@trpc/server/index.ts:14-29
export {
  type AnyProcedure as AnyTRPCProcedure,
  type AnyRouter as AnyTRPCRouter,
  type inferProcedureInput,
  type inferProcedureOutput,
  type ProcedureType as TRPCProcedureType,
  type RouterDef as TRPCRouterDef,
  // ...
} from "../../unstable-core-do-not-import";
```

**第 2 層: エコシステム向け内部 API**（`@trpc/server/unstable-core-do-not-import`）は tRPC エコシステムのパッケージ（`@trpc/client`, `@trpc/tanstack-react-query` 等）が内部的に使う API を公開する。名前に「DO NOT IMPORT」を含めることで、外部ユーザーの利用を抑止している。

```typescript
// packages/server/src/unstable-core-do-not-import.ts:1-10
/**
 * **DO NOT IMPORT FROM THIS FILE**
 *
 * This file is here to:
 * - make TypeScript happy and prevent _"The inferred type of 'createContext' cannot be named without a reference to [...]"_.
 * - the the glue between the official `@trpc/*`-packages
 *
 * If you seem to need to import anything from here, please open an issue at https://github.com/trpc/trpc/issues
 */
```

**第 3 層: アダプタ用 API**（`@trpc/server/http`, `@trpc/server/rpc` 等）はサードパーティアダプタ作成者向けの中間層で、HTTP レスポンス解決やエラーコード等のプロトコル関連 API を公開する。

### ESLint によるインポート境界の強制

`eslint.config.js:173-191` でアダプタディレクトリ内からの `unstable-core-do-not-import` へのインポートを禁止し、代わりに `@trpc/server` や `@trpc/server/http` 経由のインポートを強制している。

```javascript
// eslint.config.js:173-191
{
  files: ['packages/server/src/adapters/**/*'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@trpc/server'],
          },
          {
            group: ['unstable-core-do-not-import'],
            message:
              'Use e.g. `../@trpc/server/http` instead - avoiding importing core helps us ensure third party adapters can be made',
          },
        ],
      },
    ],
  },
},
```

この ESLint ルールにより、アダプタ実装は第 3 層の API のみを使うことが強制され、サードパーティが同等のアダプタを作れることが保証される。アダプタファイルのコメントにも明示されている。

```typescript
// packages/server/src/adapters/fetch/fetchRequestHandler.ts:1-9
/**
 * If you're making an adapter for tRPC and looking at this file for reference,
 * you should import types and functions from `@trpc/server` and `@trpc/server/http`
 */
```

### Fluent Builder による型安全な初期化

`initTRPC` は `TRPCBuilder` クラスのシングルトンインスタンスで、`.context<T>()` と `.meta<M>()` をチェーンして型パラメータを注入し、`.create(opts)` で最終的な `TRPCRootObject` を生成する。

```typescript
// packages/server/src/unstable-core-do-not-import/initTRPC.ts:117-222
class TRPCBuilder<TContext extends object, TMeta extends object> {
  context<TNewContext extends object | ContextCallback>() {
    return new TRPCBuilder<
      TNewContext extends ContextCallback ? Unwrap<TNewContext> : TNewContext,
      TMeta
    >();
  }

  meta<TNewMeta extends object>() {
    return new TRPCBuilder<TContext, TNewMeta>();
  }

  create<TOptions extends RuntimeConfigOptions<TContext, TMeta>>(
    opts?: ValidateShape<TOptions, RuntimeConfigOptions<TContext, TMeta>>,
  ): TRPCRootObject<TContext, TMeta, TOptions> {
    // ...
  }
}

export const initTRPC = new TRPCBuilder();
```

`ValidateShape` 型は `create()` に渡されたオプションが `RuntimeConfigOptions` のスキーマに厳密に一致することを保証し、余分なプロパティをコンパイル時に検出する。

```typescript
// packages/server/src/unstable-core-do-not-import/types.ts:117-122
export type ValidateShape<TActualShape, TExpectedShape> = TActualShape extends TExpectedShape
  ? Exclude<keyof TActualShape, keyof TExpectedShape> extends never ? TActualShape
  : TExpectedShape
  : never;
```

### Duck Typing によるバリデータ非依存設計

`parser.ts` は 9 種類以上のバリデーションライブラリのインターフェースを Union 型で定義し、ランタイムで `typeof parser.parse === 'function'` 等の Feature Detection でディスパッチする。

```typescript
// packages/server/src/unstable-core-do-not-import/parser.ts:84-140
export function getParseFn<TType>(procedureParser: Parser): ParseFn<TType> {
  const parser = procedureParser as any;
  const isStandardSchema = "~standard" in parser;

  if (typeof parser === "function" && typeof parser.assert === "function") {
    return parser.assert.bind(parser); // ArkType
  }
  if (typeof parser === "function" && !isStandardSchema) {
    return parser; // Valibot / custom
  }
  if (typeof parser.parseAsync === "function") {
    return parser.parseAsync.bind(parser); // Zod
  }
  // ... 他のライブラリ対応
  if (isStandardSchema) {
    return async (value) => {/* Standard Schema v1 */};
  }
  throw new Error("Could not find a validator fn");
}
```

### 非推奨 API の段階的移行パターン

tRPC は 3 つの API ライフサイクルステージを命名規約で表現している。

1. **実験的**: `experimental_` プレフィクス（例: `experimental_caller`, `experimental_nextAppDirCaller`）
2. **安定版への昇格**: プレフィクスを外し、旧名を `@deprecated` でエイリアス化（例: `lazy` と `experimental_lazy`）
3. **廃止**: `@deprecated` タグと移行先の案内を JSDoc に記載（例: `sse` → `tracked`）

```typescript
// packages/server/src/@trpc/server/index.ts:69-73
lazy,
/**
 * @deprecated use {@link lazy} instead
 */
lazy as experimental_lazy,
```

## パターンカタログ

- **Builder パターン** (分類: 生成)
  - 解決する問題: TypeScript の型パラメータを段階的に構築する必要がある初期化
  - 適用条件: 関数の型パラメータが多く、すべてを一度に指定することがユーザーにとって困難な場合
  - コード例: `packages/server/src/unstable-core-do-not-import/initTRPC.ts:117-222`
  - 注意点: 各メソッドが新しいインスタンスを返す必要がある（ミュータブルな状態を持たない）

- **Proxy パターン** (分類: 構造)
  - 解決する問題: ルーターのネスト構造をドットアクセスの API として提供する
  - 適用条件: 実行時にはフラットなプロシージャマップだが、型レベルではネスト構造を表現したい場合
  - コード例: `packages/server/src/unstable-core-do-not-import/createProxy.ts:19-57`
  - 注意点: `then` をトラップから除外して Promise との衝突を防ぐ必要がある

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: ミドルウェアの連鎖的な実行
  - 適用条件: リクエスト処理にバリデーション・認証・変換等の複数ステップが必要な場合
  - コード例: `packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:634-672`（`callRecursive`）
  - 注意点: `next()` の呼び忘れを検出するマーカー型（`middlewareMarker`）を使用している

## Good Patterns

- **名前に意図を埋め込むエクスポートパス**: `unstable-core-do-not-import` というサブパス名は、それ自体が使用を抑止するドキュメントになっている。`@trpc/client` の `unstable-internals` も同様。コード上のコメントやドキュメントは読まれないことがあるが、インポートパスは必ず開発者の目に触れる。

```typescript
// ユーザーが誤って使おうとすると、インポート文自体が警告になる
import { something } from "@trpc/server/unstable-core-do-not-import";
```

- **ValidateShape による余分なプロパティの検出**: TypeScript の構造的型付けではオプションオブジェクトに余分なプロパティを渡してもエラーにならない場合がある。`ValidateShape` 型はこの問題を解決し、タイポや廃止されたオプションの指定をコンパイル時に検出する。

```typescript
// packages/server/src/unstable-core-do-not-import/types.ts:117-122
export type ValidateShape<TActualShape, TExpectedShape> = TActualShape extends TExpectedShape
  ? Exclude<keyof TActualShape, keyof TExpectedShape> extends never ? TActualShape
  : TExpectedShape
  : never;
```

- **リネームエクスポートによるプレフィクス付き公開型**: 内部で `AnyRouter` として使う型を公開 API では `AnyTRPCRouter` としてリネームエクスポートする。これにより内部のコードは短い名前で簡潔に書きつつ、外部ユーザーのコードでは名前衝突を避けられる。

```typescript
// packages/server/src/@trpc/server/index.ts:25-26
type AnyProcedure as AnyTRPCProcedure,
type AnyRouter as AnyTRPCRouter,
```

- **予約語の明示的禁止**: ルーター定義で `then`, `call`, `apply` を予約語として禁止し、Proxy ベースの API が JavaScript ランタイムと衝突しないことを保証している。

```typescript
// packages/server/src/unstable-core-do-not-import/router.ts:210-221
const reservedWords = [
  "then", // Promise.resolve(proxy) との衝突防止
  "call", // fn.call() との衝突防止
  "apply", // fn.apply() との衝突防止
];
```

## Anti-Patterns / 注意点

- **エクスポート境界を ESLint のみに依存する**: tRPC はアダプタ層での `unstable-core-do-not-import` からのインポートを ESLint ルールで禁止しているが、これはビルド時の強制であり、ESLint を無効化すれば回避できる。TypeScript の `paths` マッピングや `package.json` の `exports` だけでは完全な強制は難しいが、可能な限りランタイムレベルでもチェックすることが望ましい。

```typescript
// Bad: ESLint コメントで境界を回避
// eslint-disable-next-line no-restricted-imports
import { run } from "../unstable-core-do-not-import";

// Better: @trpc/server 経由のインポートで代替可能な API を提供する
import { run } from "../@trpc/server/utils";
```

- **型パラメータの `any` での妥協**: `AnyProcedureBuilder` のように全型パラメータを `any` にしたワイルドカード型は便利だが、型安全性の穴になる。tRPC のコード内にも `FIXME typecast shouldn't be needed` というコメントがあり、改善の余地を認識している。

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:702-703
// FIXME typecast shouldn't be needed - fixittt
return procedure as unknown as AnyProcedure;
```

## 導出ルール

- `[MUST]` パブリック API とインターナル API のエクスポートパスを分離し、package.json の exports フィールドで境界を定義する
  - 根拠: tRPC は `@trpc/server`（安定）と `@trpc/server/unstable-core-do-not-import`（内部）を分離し、15 以上のサブパスで API サーフェスを制御している
- `[MUST]` 非推奨 API には `@deprecated` JSDoc タグと移行先を明記し、ランタイム互換性を維持したまま段階的に廃止する
  - 根拠: tRPC は `sse` → `tracked`, `experimental_lazy` → `lazy` 等の移行を、エイリアスエクスポートと `@deprecated` タグで実現している
- `[SHOULD]` 実験的 API には `experimental_` プレフィクスを付与し、安定化時にプレフィクスを外して旧名を deprecated エイリアスとして残す
  - 根拠: `experimental_standaloneMiddleware` → `.concat()` への移行パスが示すように、プレフィクスによる API ライフサイクル管理が機能している
- `[SHOULD]` バリデーション等の外部ライブラリ依存はダックタイピングで抽象化し、特定ライブラリへのハードコード依存を排除する
  - 根拠: `parser.ts` は 9 種類のバリデータをインターフェース型の Union とランタイム Feature Detection で統一し、ゼロ依存を実現している
- `[SHOULD]` TypeScript の型パラメータが 3 つ以上必要な初期化 API では Builder パターンで段階的に型を構築する
  - 根拠: `initTRPC.context<T>().meta<M>().create(opts)` は Context と Meta の型パラメータを個別に注入でき、ユーザーが一度にすべて指定する必要がない
- `[SHOULD]` Proxy ベースの API では `then` をトラップから除外し、JavaScript ランタイムの Promise 解決メカニズムとの衝突を防ぐ
  - 根拠: `createInnerProxy` と `createFlatProxy` の両方で `key === 'then'` のガードが実装されており、`Promise.resolve(proxy)` の誤動作を防止している
- `[SHOULD]` ESLint の `no-restricted-imports` でパッケージ間のインポート境界を強制し、アダプタ層が内部 API に依存しないことを保証する
  - 根拠: tRPC はアダプタディレクトリで `unstable-core-do-not-import` からのインポートを禁止し、サードパーティアダプタの作成可能性を保証している
- `[AVOID]` 設定オブジェクトに TypeScript のデフォルトの構造的型付けをそのまま使う。`ValidateShape` のような余分プロパティ検出型で厳密にする
  - 根拠: `initTRPC.create()` は `ValidateShape` で余分なオプションキーをコンパイルエラーにし、タイポや廃止オプションの混入を防止している

## 適用チェックリスト

- [ ] `package.json` の `exports` フィールドでパブリック API とインターナル API のサブパスを分離しているか
- [ ] 内部 API を外部に公開する必要がある場合、パス名に「unstable」「internal」等の警告を含めているか
- [ ] ESLint の `no-restricted-imports` でパッケージ間のインポート境界を設定しているか
- [ ] 実験的 API に `experimental_` プレフィクスを付与しているか
- [ ] 非推奨 API に `@deprecated` タグと移行先情報を付けているか
- [ ] 設定オブジェクトで余分なプロパティを検出する仕組み（`ValidateShape` 等）を導入しているか
- [ ] Proxy ベースの API で `then`, `call`, `apply` 等の予約語との衝突を回避しているか
- [ ] 外部バリデーションライブラリへの依存をダックタイピングまたは Standard Schema で抽象化しているか
- [ ] 型パラメータが多い初期化 API で Builder パターンによる段階的な型構築を検討したか
