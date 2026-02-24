# design-philosophy

> リポジトリ: trpc/trpc
> 分析日: 2026-02-24

## 概要

tRPC のタグライン "Move Fast and Break Nothing" がコードベース全体にどう体現されているかを分析する。この哲学は単なるマーケティングメッセージではなく、型システムによるコンパイル時保証、段階的移行を前提した API 進化戦略、ランタイム防御メカニズムの三層で具体的に実装されている。特に注目に値するのは、「高速に開発できる」と「壊さない」という一見矛盾する要求を、型推論・プロキシ・抽象バリデータ・リンクアーキテクチャという設計判断の組み合わせで解決している点である。

## 背景にある原則

- **型をランタイムの代わりにする**: サーバーの Router 型がクライアントまで伝播し、エンドポイント名の typo やスキーマの不一致がコンパイル時に検出される。コード生成や中間スキーマファイルを不要にすることで「Move Fast」を実現し、型推論による保証で「Break Nothing」を担保している。根拠: `createRecursiveProxy` がパス文字列を型レベルで追跡し、存在しないプロシージャへのアクセスが型エラーになる (`packages/server/src/unstable-core-do-not-import/createProxy.ts`)。

- **壊す前に警告する（段階的移行戦略）**: API の進化において、`@deprecated` アノテーション → `experimental_` プレフィックス → `unstable-core-do-not-import` の命名規約 → 安定版昇格という明確なライフサイクルを持つ。ユーザーは既存コードを壊さずに新機能を試用でき、非推奨 API は次のメジャーバージョンまで維持される。根拠: `LegacyObservableSubscriptionProcedure` が `@deprecated` として維持され、Observable → AsyncIterable 移行が強制ではなく段階的に行われている (`packages/server/src/unstable-core-do-not-import/procedure.ts:63-70`)。

- **コアの無依存性が適応速度を決める**: サーバーコアはフレームワークに依存しない。Express、Fastify、Fetch API、AWS Lambda など各環境へはアダプタで接続する。この分離により、新しいランタイム（Bun、Deno、Cloudflare Workers）が登場してもコアを変更せず対応でき、「Move Fast」が実現される。根拠: `resolveResponse` が Web 標準の `Request`/`Response` を受け取り、フレームワーク固有の変換はアダプタが担当する (`packages/server/src/adapters/fetch/fetchRequestHandler.ts`)。

- **ランタイムで検出不能なエラーを型で表現する**: 型レベルの `TypeError<TMessage>` ブランド型により、不正な API 使用（入力パーサーの不一致、コンテキスト型の不整合など）がコンパイル時に人間が読めるエラーメッセージとして表示される。根拠: `TypeError<'Cannot chain an optional parser to a required parser'>` が ProcedureBuilder の `.input()` チェーンで不正な組み合わせを防止する (`packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:209`)。

## 実例と分析

### 型レベル安全ガード

tRPC は「ランタイムエラーではなくコンパイルエラーで問題を発見する」という方針を、複数のメカニズムで徹底している。

**TypeError ブランド型**: `types.ts` で定義された `TypeError<TMessage>` は、`string & { _: typeof _errorSymbol }` という構造を持つ。これにより、TypeScript の条件型から返される「エラー型」が、IDE 上で人間が読めるメッセージとして表示される。ProcedureBuilder では少なくとも 10 箇所で使用され、「Context mismatch」「Meta mismatch」「All input parsers did not resolve to an object」「Not implemented」などのメッセージが出力される。

**ValidateShape**: `initTRPC.create()` のオプション引数に `ValidateShape<TActualShape, TExpectedShape>` を適用し、余分なプロパティが渡された場合にコンパイルエラーにする。TypeScript の標準的な excess property check が効かない場面での防御策。

**UnsetMarker ブランド型**: `'unsetMarker' & { __brand: 'unsetMarker' }` という型で、ProcedureBuilder のジェネリクスの初期状態を「未設定」として区別する。これにより `.input()` 未呼び出しの場合と `void` 入力の場合を型レベルで区別できる。同じパターンが `middlewareMarker`、`lazyMarker`、`TrackedId` にも適用されている。

### 段階的移行のための API 安定性スペクトラム

tRPC は API の安定性を4段階で管理している。

1. **安定版（public）**: `@trpc/server` のメインエクスポート。`initTRPC`、`TRPCError` など。
2. **非推奨（deprecated）**: `@deprecated` JSDoc + 移行先の明記。例: `sse()` → `tracked()`、`experimental_lazy` → `lazy`。
3. **実験的（experimental）**: `experimental_` プレフィックス。例: `experimental_caller`、`experimental_nextAppDirCaller`。
4. **内部（unstable）**: `unstable-core-do-not-import` サブパス。公式パッケージ間の接着剤として公開されているが、ユーザーへの直接使用は非推奨。ファイル冒頭に `DO NOT IMPORT FROM THIS FILE` と明記。

この4段階のスペクトラムが重要なのは、エコシステム（サードパーティアダプタ、プラグイン）が内部 API にアクセスできる手段を確保しつつ、安定性の期待値を名前で伝達している点にある。

### マルチバリデータ抽象によるロックイン回避

`parser.ts` は zod、valibot、yup、superstruct、myzod、arktype、Standard Schema v1 のいずれも受け入れるダックタイピング戦略を採用している。`getParseFn` は各バリデータの特徴的なメソッド（`parseAsync`、`parse`、`validateSync`、`create`、`assert`、`~standard`）をランタイムで判定して適切な呼び出しに変換する。

型レベルでは `ParserZodEsque`、`ParserValibotEsque` 等の `-Esque` サフィックスで「このインターフェースに準拠するもの」を表現し、特定のパッケージへの依存を生まない。これが「Move Fast」に寄与する理由は、ユーザーがバリデーションライブラリを自由に選択・変更でき、tRPC 側の制約で開発が遅れることがないためである。

### Proxy パターンによる透明な型安全 RPC

`createRecursiveProxy` はクライアントが `client.user.list.query()` のように呼び出す際、各プロパティアクセスを `path` 配列に蓄積し、最終的な関数呼び出し時にまとめて RPC リクエストに変換する。ユーザーにとっては通常のメソッド呼び出しと同じ体験であり、HTTP 層が完全に隠蔽される。

特筆すべきは `then` キーの特別扱い（`undefined` を返す）である。これは Proxy が `Promise.resolve(proxy)` のように Promise として扱われた場合に無限ループを防ぐための防御策であり、「Break Nothing」を JavaScript のランタイム特性に対しても適用している例である。

### Unpromise による長寿命 Promise のメモリリーク防止

`vendor/unpromise/unpromise.ts` は、`Promise.race()` や `Promise.any()` で長寿命 Promise に `.then()` / `.catch()` を繰り返し呼ぶことで発生するメモリリークを解決するベンダードライブラリである。サブスクリプションの `unsubscribe()` パターンにより、Promise からの参照チェーンを切断してガベージコレクションを可能にする。SSE や WebSocket による長寿命コネクションを扱う tRPC にとって、ランタイムの健全性を保証する「Break Nothing」の具体的な実装である。

### 回帰テストの Issue 番号管理

`packages/tests/server/regression/` ディレクトリには 27 個の回帰テストが、すべて `issue-{番号}-{説明}.test.ts` の命名規則で管理されている。テストが失敗した場合に GitHub Issue へのトレーサビリティが即座に確保される。これは「Break Nothing」を組織的プロセスとして維持するための仕組みである。

## コード例

```typescript
// packages/server/src/unstable-core-do-not-import/types.ts:170-174
const _errorSymbol = Symbol();
export type ErrorSymbol = typeof _errorSymbol;
export type TypeError<TMessage extends string> = TMessage & {
  _: typeof _errorSymbol;
};
```

```typescript
// packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:201-212
input<$Parser extends Parser>(
  schema: TInputOut extends UnsetMarker
    ? $Parser
    : inferParser<$Parser>['out'] extends Record<string, unknown> | undefined
      ? TInputOut extends Record<string, unknown> | undefined
        ? undefined extends inferParser<$Parser>['out']
          ? undefined extends TInputOut
            ? $Parser
            : TypeError<'Cannot chain an optional parser to a required parser'>
          : $Parser
        : TypeError<'All input parsers did not resolve to an object'>
      : TypeError<'All input parsers did not resolve to an object'>,
```

```typescript
// packages/server/src/unstable-core-do-not-import/createProxy.ts:27-33
memo[cacheKey] ??= new Proxy(noop, {
  get(_obj, key) {
    if (typeof key !== 'string' || key === 'then') {
      // special case for if the proxy is accidentally treated
      // like a PromiseLike (like in `Promise.resolve(proxy)`)
      return undefined;
    }
    return createInnerProxy(callback, [...path, key], memo);
  },
```

```typescript
// packages/server/src/unstable-core-do-not-import/parser.ts:84-140
export function getParseFn<TType>(procedureParser: Parser): ParseFn<TType> {
  const parser = procedureParser as any;
  const isStandardSchema = "~standard" in parser;
  if (typeof parser === "function" && typeof parser.assert === "function") {
    return parser.assert.bind(parser);
  }
  if (typeof parser === "function" && !isStandardSchema) {
    return parser;
  }
  if (typeof parser.parseAsync === "function") {
    return parser.parseAsync.bind(parser);
  }
  // ... 他のバリデータ形式へのフォールバック
  throw new Error("Could not find a validator fn");
}
```

```typescript
// packages/server/src/unstable-core-do-not-import/utils.ts:10-25
export function mergeWithoutOverrides<TType extends Record<string, unknown>>(
  obj1: TType,
  ...objs: Partial<TType>[]
): TType {
  const newObj: TType = Object.assign(emptyObject(), obj1);
  for (const overrides of objs) {
    for (const key in overrides) {
      if (key in newObj && newObj[key] !== overrides[key]) {
        throw new Error(`Duplicate key ${key}`);
      }
      newObj[key as keyof TType] = overrides[key] as TType[keyof TType];
    }
  }
  return newObj;
}
```

## パターンカタログ

- **Builder パターン** (分類: 生成)
  - 解決する問題: 複雑な型情報（コンテキスト、入力、出力、ミドルウェア）を段階的に蓄積しながら型安全を維持する
  - 適用条件: メソッドチェーンの各ステップで異なるジェネリクスパラメータを追加・変更する必要がある場合
  - コード例: `packages/server/src/unstable-core-do-not-import/procedureBuilder.ts:187-465`
  - 注意点: ProcedureBuilder は 8 個のジェネリクスパラメータを持ち、各メソッドが一部だけを変更して新しいインスタンスを返す。イミュータブルな Builder であり、GoF の典型的な Builder とは異なりディレクタは不要

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: クライアント側のリクエスト処理を、ロギング・バッチング・リトライ・実際の HTTP リクエストなど、責務の異なるリンクで構成する
  - 適用条件: リクエストパイプラインを拡張可能にし、各リンクが独立して追加・削除できる必要がある場合
  - コード例: `packages/client/src/links/types.ts:95-111`（`OperationLink` 型）
  - 注意点: Apollo Links と類似した設計。各リンクは `next` 関数で次のリンクに処理を委譲する

- **Adapter パターン** (分類: 構造)
  - 解決する問題: フレームワーク固有のリクエスト/レスポンス形式と、tRPC コアの Web 標準形式の間の変換
  - 適用条件: コアロジックをフレームワーク非依存に保ちつつ、複数のフレームワークをサポートする場合
  - コード例: `packages/server/src/adapters/fetch/fetchRequestHandler.ts:24-80`
  - 注意点: tRPC のアダプタは Web 標準の `Request`/`Response` を基準とし、各フレームワークのアダプタはこれらへの変換のみを担当する

## Good Patterns

- **ブランド型による状態区別**: `UnsetMarker`、`middlewareMarker`、`lazyMarker`、`TrackedId` はすべて `string & { __brand: 'xxx' }` パターンで実装されている。これにより、通常の文字列とは型レベルで区別され、誤った値の混入がコンパイル時に検出される。

```typescript
// packages/server/src/unstable-core-do-not-import/utils.ts:1-4
export type UnsetMarker = "unsetMarker" & {
  __brand: "unsetMarker";
};
```

- **`-Esque` サフィックスによるダックタイピング抽象**: バリデーションライブラリの型を `ParserZodEsque`、`ParserValibotEsque` のように命名することで、「このインターフェースに似たもの」という意図を明確に伝達している。特定ライブラリへの依存を生まず、インターフェースの構造的部分型付けを活用する。

```typescript
// packages/server/src/unstable-core-do-not-import/parser.ts:5-8
export type ParserZodEsque<TInput, TParsedInput> = {
  _input: TInput;
  _output: TParsedInput;
};
```

- **`emptyObject()` による Object.create(null)**: プロトタイプチェーンを持たないオブジェクトを生成し、`__proto__` や `hasOwnProperty` などの予期しないプロパティの混入を防止する。Router の procedures レコードやマージ結果で一貫して使用されている。

```typescript
// packages/server/src/unstable-core-do-not-import/utils.ts:44-46
export function emptyObject<TObj extends Record<string, unknown>>(): TObj {
  return Object.create(null);
}
```

- **回帰テストの Issue 番号命名規則**: `issue-{番号}-{簡潔な説明}.test.ts` という命名規則により、テストの存在理由とバグレポートへのトレーサビリティが自明になる。

## Anti-Patterns / 注意点

- **型パラメータの爆発**: ProcedureBuilder は 8 個のジェネリクスパラメータ（`TContext`, `TMeta`, `TContextOverrides`, `TInputIn`, `TInputOut`, `TOutputIn`, `TOutputOut`, `TCaller`）を持つ。これは型安全性を徹底した結果だが、内部実装の理解コストが非常に高い。

```typescript
// Bad: 8個のジェネリクスパラメータを一つのインターフェースに持つ
export interface ProcedureBuilder<
  TContext, TMeta, TContextOverrides,
  TInputIn, TInputOut, TOutputIn, TOutputOut, TCaller extends boolean
> { ... }

// Better: 関連するパラメータをグループ化する（tRPC は将来の v12 で改善予定と推測）
interface ProcedureTypes { ctx: ...; meta: ...; input: { in: ...; out: ... }; ... }
export interface ProcedureBuilder<TTypes extends ProcedureTypes> { ... }
```

- **`unstable-core-do-not-import` の事実上の公開 API 化**: 内部用途と明示されていても、`@trpc/client` が `@trpc/server/unstable-core-do-not-import` から直接インポートしている。サードパーティも同様にインポートする可能性が高く、「内部 API」と「事実上の公開 API」の乖離が生じる。名前による抑止は効果が限定的。

```typescript
// Bad: 内部パスから直接インポート（サードパーティが模倣するリスク）
import { createRecursiveProxy } from "@trpc/server/unstable-core-do-not-import";

// Better: エコシステム向けの安定した拡張ポイントを別途提供する
import { createRecursiveProxy } from "@trpc/server/extensibility";
```

## 導出ルール

- `[MUST]` 型レベルのエラーメッセージには人間が読める文字列を使い、ブランド型で通常の文字列と区別する — API のミスユース箇所を IDE 上で即座に特定できるようにするため
  - 根拠: tRPC の `TypeError<'Context mismatch'>` パターンにより、型エラーが「どの制約に違反したか」を具体的に伝達している (`procedureBuilder.ts:309-310`)

- `[MUST]` 公開 API の削除にはメジャーバージョンを要求し、それまでは `@deprecated` + 移行先を JSDoc に明記する — ユーザーのコードを壊さず段階的に移行させるため
  - 根拠: tRPC は `sse()` → `tracked()`、`experimental_lazy` → `lazy` のように、非推奨 API を維持しつつ新 API を提供し、v12 での削除を JSDoc に予告している (`@trpc/server/index.ts:64-73`)

- `[SHOULD]` 外部ライブラリへの依存を「-Esque」型によるダックタイピングで抽象化し、ランタイムではフィーチャーディテクションで判別する — 特定の依存にロックインされず、ユーザーの選択肢を維持するため
  - 根拠: `parser.ts` が zod/valibot/yup 等 8 種以上のバリデータを、共通の `Parser` 型で受け入れている

- `[SHOULD]` 回帰テストのファイル名にバグトラッカーの Issue 番号を含める — テストの存在理由が自明になり、修正が別のバグを再発させないことを保証するため
  - 根拠: `packages/tests/server/regression/` に 27 ファイルすべてが `issue-{番号}-{説明}.test.ts` 形式で管理されている

- `[SHOULD]` 実験的 API には `experimental_` プレフィックスを付与し、安定化後にプレフィックスを除去した別名を追加する — ユーザーが安定性を判断でき、名前変更の移行も段階的に行えるため
  - 根拠: `experimental_lazy` が安定化後に `lazy` としてエクスポートされ、旧名はエイリアスとして維持されている (`@trpc/server/index.ts:69-73`)

- `[SHOULD]` フレームワーク非依存のコアと、フレームワーク固有のアダプタを明確に分離し、コアは Web 標準 API（Request/Response）を境界とする — 新しいランタイムやフレームワークへの対応がアダプタ追加だけで完結するため
  - 根拠: `resolveResponse` が Web 標準の `Request` を受け取り、Express/Fastify/Lambda 等のアダプタが変換を担当する (`packages/server/src/adapters/`)

- `[AVOID]` 内部 API を「使わないでください」という命名だけで保護すること — エコシステムが事実上の公開 API として依存する可能性が高く、名前による抑止は効果が限定的であるため
  - 根拠: `unstable-core-do-not-import` は `@trpc/client` 自身が依存しており、サードパーティの模倣を防げていない

## 適用チェックリスト

- [ ] 公開 API の型にブランド型を使い、不正な使用をコンパイル時に検出できるようにしているか
- [ ] API の非推奨化ポリシーが定義されており、`@deprecated` + 移行先が JSDoc に明記されているか
- [ ] 実験的 API に `experimental_` や `unstable_` プレフィックスが付与されているか
- [ ] コアモジュールが特定のフレームワークに依存しておらず、アダプタで接続する構造になっているか
- [ ] 外部ライブラリへの依存をインターフェース（ダックタイピング）で抽象化し、ロックインを回避しているか
- [ ] 回帰テストがバグトラッカーの Issue 番号と紐づけられているか
- [ ] 型レベルのエラーメッセージが、IDE 上で人間が読める文字列として表示されるか
- [ ] `Object.create(null)` を使って prototype pollution を防止しているか（動的キーのレコードで）
