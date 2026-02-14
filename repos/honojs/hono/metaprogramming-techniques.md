# metaprogramming-techniques

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

JSX 変換・ビルド時コード生成・型レベルメタプログラミングの技法を横断的に分析した。Hono は TypeScript の型システムを「もうひとつのプログラミング言語」として活用し、ルーティング定義からクライアント SDK まで型レベルで自動生成する。さらにカスタム JSX ランタイム、tagged template literal による DSL 構築、Symbol を利用したプロトコル設計、AST 変換によるビルド後処理など、複数のメタプログラミング手法を組み合わせている。これらの手法は「ランタイムコストをゼロにしつつ開発体験を最大化する」という一貫した設計思想に支えられている。

## 背景にある原則

- **型はドキュメントであり契約である**: ランタイムのバリデーションではなく型レベルで API の入出力を強制することで、コンパイル時にバグを検出する。`HandlerInterface` のオーバーロード群（`src/types.ts:128-1072`）はハンドラチェーン最大 10 個まで各ミドルウェアの Env/Input を累積的に推論し、型安全を保証する。
- **コンパイラを味方につける**: TSC の JSX 変換機構・テンプレートリテラル型・条件付き型を「コード生成器」として利用し、ユーザーが書くコードを最小限にする。`tsconfig.json` で `jsxFactory: "jsx"` を指定するだけでカスタム JSX ランタイムに接続される。
- **Symbol はプライベートプロトコルを作る**: ES Symbol をオブジェクトの内部スロットとして使い、ライブラリ内部のプロトコルを外部 API から隠蔽する。`DOM_RENDERER`, `DOM_MEMO`, `PERMALINK` 等（`src/jsx/constants.ts:1-6`）がその実例。
- **ビルドパイプラインで型定義を後処理する**: TypeScript コンパイラが生成する `.d.ts` を AST 解析で変換し、ライブラリ消費者に不要な内部情報（`#private` フィールド）を除去する（`build/remove-private-fields.ts`）。コンパイラの出力を「最終成果物」と見なさず、パイプラインの一工程として扱う。

## 実例と分析

### 型レベルパス合成とスキーマ蓄積

ルート定義時に文字列リテラル型を再帰的に分解・合成し、パスパラメータを型として抽出する。

```typescript
// src/types.ts:2321-2335
export type MergePath<A extends string, B extends string> = B extends ''
  ? MergePath<A, '/'>
  : A extends ''
    ? B
    : A extends '/'
      ? B
      : A extends `${infer P}/`
        ? B extends `/${infer Q}`
          ? `${P}/${Q}`
          : `${P}/${B}`
        : B extends `/${infer Q}`
          ...
```

`app.get('/users/:id', handler)` と書くだけで、`:id` が `{ param: { id: string } }` として型に現れる。この手法は `ExtractParams`（`src/types.ts:2264`）で template literal type のパターンマッチングによって実現される。

### オーバーロードによるミドルウェアチェーンの型累積

`HandlerInterface`（`src/types.ts:128-1072`）は handler 1 個から 10 個まで、path あり/なしの組み合わせで約 20 のオーバーロードを定義する。各オーバーロードで `IntersectNonAnyTypes` を使い Env 型を累積的に交差し、チェーン内のどの位置でも前段ミドルウェアが設定した変数にアクセスできる。

```typescript
// src/types.ts:2474-2476
export type IntersectNonAnyTypes<T extends any[]> = T extends [infer Head, ...infer Rest]
  ? ProcessHead<Head> & IntersectNonAnyTypes<Rest>
  : {};
```

TypeScript は可変長ジェネリクスの型推論に限界があるため、有限個のオーバーロード展開で対処する。この「N 個までの明示的オーバーロード + フォールバック」パターンは型安全と実用性のトレードオフとして汎用的に適用できる。

### Proxy ベースの型安全 RPC クライアント生成

`hc<T>()` 関数（`src/client/client.ts:130-217`）は `Proxy` を再帰的に生成し、プロパティアクセスを URL パスに変換する。型レベルでは `PathToChain`（`src/client/types.ts:275-290`）がパス文字列をネストされたオブジェクト型に変換し、`Client<T, Prefix>`（`src/client/types.ts:292-299`）がサーバー定義の `Schema` 型からクライアント SDK 型を導出する。

```typescript
// src/client/client.ts:15-31
const createProxy = (callback: Callback, path: string[]) => {
  const proxy: unknown = new Proxy(() => {}, {
    get(_obj, key) {
      if (typeof key !== "string" || key === "then") {
        return undefined;
      }
      return createProxy(callback, [...path, key]);
    },
    apply(_1, _2, args) {
      return callback({ path, args });
    },
  });
  return proxy;
};
```

ランタイムは単なる Proxy なので、サーバー側のルート定義が変われば型エラーが自動的に発生する。コード生成ツール不要で end-to-end の型安全を実現する手法。

### カスタム JSX ランタイム

`tsconfig.json` の `"jsx": "react"`, `"jsxFactory": "jsx"`, `"jsxFragmentFactory": "Fragment"` 設定（`tsconfig.json:17-19`）により、TSC が `<div>` を `jsx('div', ...)` に変換する。この変換先である `jsx` 関数（`src/jsx/base.ts:294-310`）が `JSXNode` を生成し、`toString()` 時に HTML 文字列を組み立てる。

```typescript
// src/jsx/base.ts:130-141
export class JSXNode implements HtmlEscaped {
  tag: string | Function
  props: Props
  key?: string
  children: Child[]
  isEscaped: true = true as const
  constructor(tag: string | Function, props: Props, children: Child[]) {
    this.tag = tag
    this.props = props
    this.children = children
  }
```

DOM 用ランタイム（`src/jsx/dom/jsx-dev-runtime.ts:10-21`）は同じ JSX 構文に対して軽量なプレーンオブジェクトを返す別実装を提供し、パッケージの `exports` フィールドでエントリポイントを切り替える。1 つの JSX 構文に対して複数のバックエンドを提供する設計。

### Tagged Template Literal による DSL

`html` ヘルパー（`src/helper/html/index.ts:11-57`）と `css` ヘルパー（`src/helper/css/common.ts:155-176`）は tagged template literal を利用して、型安全なテンプレート DSL を構築する。`html` は自動エスケープ付きの HTML 生成、`css` はスコープ付きクラス名の自動生成とスタイル文字列の最適化を行う。

```typescript
// src/helper/html/index.ts:11-14
export const html = (
  strings: TemplateStringsArray,
  ...values: unknown[]
): HtmlEscapedString | Promise<HtmlEscapedString> => {
```

### Symbol によるプライベートプロトコル

`src/jsx/constants.ts` で定義される 6 つの Symbol（`DOM_RENDERER`, `DOM_ERROR_HANDLER`, `DOM_STASH`, `DOM_INTERNAL_TAG`, `DOM_MEMO`, `PERMALINK`）は、JSX コンポーネントに内部メタデータを付与するプロトコルとして機能する。`src/helper/css/common.ts` でも `SELECTOR`, `CLASS_NAME`, `STYLE_STRING` 等の Symbol がオブジェクトの「型タグ」として使われる。

```typescript
// src/helper/css/common.ts:13-19
export interface CssClassName {
  [SELECTOR]: string;
  [CLASS_NAME]: string;
  [STYLE_STRING]: string;
  [SELECTORS]: CssClassName[];
  [EXTERNAL_CLASS_NAMES]: string[];
}
```

Symbol キーは `Object.keys()` に現れず、`JSON.stringify()` でもシリアライズされないため、内部プロトコルを外部 API から完全に隠蔽できる。

### AST 変換によるビルド後処理

`build/remove-private-fields.ts` は `oxc-parser` で `.d.ts` ファイルを AST 解析し、`#private` フィールド宣言をスペースで置換する。TypeScript の `#private` フィールドは `.d.ts` に `#private;` として露出するが、これはライブラリ消費者にとってノイズとなるため除去する。

```typescript
// build/remove-private-fields.ts:27-37
export function removePrivateFieldFromSourceCode(ast: ParseResult, sourceCode: string) {
  const removals: PropertyDefinition[] = []
  new Visitor({
    ClassDeclaration: (node) => {
      node.body.body.forEach((elem) => {
        if (elem.type === 'PropertyDefinition' && elem.key.type === 'PrivateIdentifier') {
          removals.push(elem)
        }
      })
    },
  }).visit(ast.program)
```

### 空インターフェースによるモジュール拡張ポイント

`ContextVariableMap`（`src/context.ts:52`）と `ContextRenderer`（`src/context.ts:57`）は空インターフェースとして定義され、ユーザーが `declare module 'hono'` で型を拡張できる設計になっている。`NotFoundResponse`（`src/types.ts:106`）も同様。

```typescript
// src/context.ts:52,57
export interface ContextVariableMap {}
export interface ContextRenderer {}
```

これにより `c.get('key')` の戻り値型がプロジェクト固有の型になり、ランタイム変更なしで型安全が向上する。

## パターンカタログ

- **Proxy パターン** (分類: 構造)
  - 解決する問題: サーバーのルート定義から型安全なクライアント SDK を自動導出する
  - 適用条件: API スキーマが型レベルで表現されており、プロパティアクセスを URL パスに対応付けられる場合
  - コード例: `src/client/client.ts:15-31`
  - 注意点: `then` プロパティへのアクセスを無視しないと Promise チェーンが壊れる（実装では明示的にガードしている）

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 同一の JSX 構文に対して SSR/DOM の異なるレンダリング戦略を提供する
  - 適用条件: 入力フォーマットが同一で出力先が複数ある場合
  - コード例: `src/jsx/base.ts` (SSR) vs `src/jsx/dom/jsx-dev-runtime.ts` (DOM)
  - 注意点: エントリポイントの切り替えは `package.json` の `exports` フィールドで行う

## Good Patterns

- **intersection type による branded string**: `HtmlEscapedString` は `string & { isEscaped: true }` として定義され（`src/utils/html.ts:21`）、エスケープ済み文字列と未エスケープ文字列を型レベルで区別する。`new String(value)` で作成した String オブジェクトに `isEscaped` プロパティを動的に付与することで、プリミティブの振る舞いを保ちつつメタデータを付加する。

```typescript
// src/utils/html.ts:17-21,40-46
export type HtmlEscaped = { isEscaped: true; callbacks?: HtmlEscapedCallback[]; };
export type HtmlEscapedString = string & HtmlEscaped;

export const raw = (value: unknown, callbacks?: HtmlEscapedCallback[]): HtmlEscapedString => {
  const escapedString = new String(value) as HtmlEscapedString;
  escapedString.isEscaped = true;
  escapedString.callbacks = callbacks;
  return escapedString;
};
```

- **createMiddleware の identity wrapper**: `createMiddleware`（`src/helper/factory/index.ts:368-375`）は受け取った関数をそのまま返す。ランタイムでは何もしないが、型パラメータを通じて Env/Input/Response 型を明示的にバインドし、IDE の補完と型チェックを有効にする。型推論のためだけに存在する関数というパターン。

```typescript
// src/helper/factory/index.ts:368-375
export const createMiddleware = <E extends Env = any, P extends string = string, I extends Input = {}>(
  middleware: MiddlewareHandler<E, P, I, ...>
): MiddlewareHandler<E, P, I, ...> => middleware
```

- **Symbol キーによる構造的型付け**: CSS ヘルパーで `CssClassName` インターフェースが Symbol キーのみで構成される（`src/helper/css/common.ts:13-19`）。外部からは通常のプロパティアクセスで中身を見られず、`typeof obj[SELECTOR]` のようにシンボル経由でのみアクセスする。これにより内部構造を完全にカプセル化しつつ、TypeScript の構造的型付けの恩恵を受けられる。

## Anti-Patterns / 注意点

- **オーバーロード爆発**: `HandlerInterface` は handler 数 x path 有無で約 20 のオーバーロードを持ち、`types.ts` は 2400 行超に膨らんでいる。TypeScript が可変長タプルの型推論を改善すれば不要になる可能性がある。新規プロジェクトでは可変長ジェネリクス（variadic tuple types）の活用を先に検討すべき。

```typescript
// Bad: N個ごとにオーバーロードを手書き
interface Handler {
  <E1>(h1: H<E1>): Result<E1>;
  <E1, E2>(h1: H<E1>, h2: H<E2>): Result<E1 & E2>;
  <E1, E2, E3>(h1: H<E1>, h2: H<E2>, h3: H<E3>): Result<E1 & E2 & E3>;
  // ... x10
}

// Better（可能な場合）: 可変長タプル型で統一
type InferEnvs<T extends H[]> = T extends [infer Head extends H<infer E>, ...infer Rest extends H[]]
  ? E & InferEnvs<Rest>
  : {};
```

- **ランタイムの型ブランディングに `as` を多用**: `new String(value) as HtmlEscapedString` のようにプリミティブラッパーに型アサーションを使うケースがある。ブランド型のランタイム表現としてはやむを得ないが、乱用するとコンパイラの安全保証が弱まる。ブランディング関数（`raw` のような）を 1 箇所に集約し、それ以外の箇所では `as` なしで型が通るようにすべき。

## 導出ルール

- `[MUST]` 型推論のためだけの identity wrapper 関数は、型パラメータのバインドを一箇所に集約するために用意する（散在する型アサーションを防ぐ）
  - 根拠: `createMiddleware` は関数をそのまま返すがジェネリクスで Env/Input 型を固定し、利用側で `as` が不要になる（`src/helper/factory/index.ts:368-375`）

- `[MUST]` ブランド型（branded type）のランタイム付与は専用のファクトリ関数に集約し、他の箇所では型アサーションなしで利用できるようにする
  - 根拠: `raw()` 関数が `HtmlEscapedString` を作る唯一のエントリポイントであり、`isEscaped` の付与が 1 箇所に閉じている（`src/utils/html.ts:40-46`）

- `[SHOULD]` ライブラリ内部のプロトコルには ES Symbol をオブジェクトキーとして使い、外部 API からの不可視性を確保する
  - 根拠: `DOM_RENDERER`, `SELECTOR` 等の Symbol キーにより、`Object.keys()` や `JSON.stringify()` に内部スロットが露出しない（`src/jsx/constants.ts:1-6`, `src/helper/css/common.ts:6-11`）

- `[SHOULD]` ユーザーによる型拡張が必要な箇所では空インターフェースを公開し、`declare module` によるモジュール拡張で型をカスタマイズ可能にする
  - 根拠: `ContextVariableMap`, `ContextRenderer`, `NotFoundResponse` が空インターフェースとして定義され、利用者が `declare module 'hono'` で型を注入できる（`src/context.ts:52,57`, `src/types.ts:106`）

- `[SHOULD]` カスタム JSX ランタイムを提供する場合、`package.json` の `exports` でエントリポイントを切り替え、同一 JSX 構文から複数のバックエンドに分岐させる
  - 根拠: SSR 用 `jsx-runtime.ts` と DOM 用 `dom/jsx-dev-runtime.ts` がそれぞれ異なる実装を持ちながら、ユーザーのコードは JSX 構文のまま変更不要（`src/jsx/base.ts`, `src/jsx/dom/jsx-dev-runtime.ts`）

- `[SHOULD]` ビルド生成物（`.d.ts` 等）は AST 変換で後処理し、ライブラリ消費者に不要な内部情報を除去する
  - 根拠: `removePrivateFields` が `oxc-parser` で `#private` フィールドを除去し、型定義のノイズを低減している（`build/remove-private-fields.ts:5-25`）

- `[AVOID]` 型安全のためだけにオーバーロードを N 個手書きすることを最初の選択肢にしない。まず variadic tuple types や条件付き型の再帰で表現可能か検討する
  - 根拠: `HandlerInterface` の約 20 オーバーロード（`src/types.ts:128-1072`）は保守コストが高く、TypeScript の型推論改善により将来不要になる可能性がある

## 適用チェックリスト

- [ ] API のルーティング定義で文字列リテラル型を活用し、パスパラメータを型レベルで抽出しているか
- [ ] ミドルウェアチェーンの型累積に `IntersectNonAnyTypes` 相当の仕組みを導入し、各段のコンテキスト拡張が型推論されるか
- [ ] ライブラリ内部の隠蔽すべきメタデータに Symbol キーを使い、`Object.keys()` や JSON シリアライズに露出しないことを確認しているか
- [ ] ブランド型（escaped string 等）の生成を専用ファクトリ関数に集約し、それ以外の箇所での `as` アサーションを排除しているか
- [ ] ユーザーが型をカスタマイズすべき拡張ポイントに空インターフェースを用意し、`declare module` による型注入を文書化しているか
- [ ] tagged template literal を使った DSL で自動エスケープやスコープ管理を提供し、生の文字列連結を排除しているか
- [ ] ビルドパイプラインで `.d.ts` の後処理を行い、`#private` フィールドなど消費者に不要な情報を除去しているか
- [ ] カスタム JSX を提供する場合、SSR/DOM など複数バックエンドへの切り替えが `package.json` の `exports` で透過的に行われるか
