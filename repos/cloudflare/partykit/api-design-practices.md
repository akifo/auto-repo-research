# API Design Practices

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

cloudflare/partykit は npm workspaces で管理された 9+ パッケージのモノレポで、サーバー (`partyserver`) とクライアント (`partysocket`) を中心に、拡張パッケージ群が統一的な API 設計パターンに従っている。パブリック API のエクスポート構造、デュアルフォーマット（ESM/CJS）対応、命名規約、そしてパッケージ間の拡張性設計に注目に値する実践がある。特に、subpath exports による環境別エントリポイント分離と、mixin/class 継承による拡張パターンの使い分けは、モノレポ全体の API 一貫性を支える重要な設計判断である。

## 背景にある原則

- **環境境界に沿ったエントリポイント分割**: サーバー・クライアント・React フックは実行環境が異なるため、同じパッケージ内でも subpath exports で明確に分離すべき。1つのエントリポイントにすべてを詰め込むとバンドルサイズが膨張し、サーバー専用コードがブラウザにリークする。partysub (`./server`, `./client`, `./react`)、y-partyserver (`.`, `./provider`, `./react`)、partytracks (`./server`, `./client`, `./react`) がこのパターンを一貫して適用している。

- **段階的な API サーフェス公開**: コアパッケージ (`partyserver`) は `export * from "./types"` で型を re-export し、小さなパブリック API サーフェスを維持する。拡張パッケージは peer dependency として `partyserver` の型を参照し、自身は固有の API のみをエクスポートする。これにより、各パッケージが独立してバージョニングできる。根拠: `partyserver/src/index.ts:19` の `export * from "./types"` と、`connection.ts` の内部実装（`ConnectionManager` インターフェース等）がエクスポートされていない点。

- **デュアルフォーマットはクライアントパッケージにのみ適用する**: サーバーサイド専用パッケージは ESM のみで十分だが、ブラウザ/Node.js 両方で使われるクライアントパッケージには CJS 互換が必要。`partysocket` のみが `format: ["esm", "cjs"]` でビルドされ、他のパッケージは `format: "esm"` である（`partysocket/scripts/build.ts:15` vs `partyserver/scripts/build.ts:9`）。コストの高いデュアルフォーマット維持を必要な場所だけに限定する判断。

- **非互換変更は JSDoc `@deprecated` + ランタイム警告で段階的に移行する**: `Lobby.party` プロパティは `@deprecated` で将来の変更を予告しつつ、ランタイムの `console.warn` で利用者に即時通知している（`partyserver/src/index.ts:94,283-293`）。API の破壊を避けながら段階的に新しい API へ誘導する戦略。

## 実例と分析

### subpath exports による環境分離

パッケージの subpath exports 設計は、環境（サーバー/クライアント/React）によって 3 つの主要パターンに分かれる。

**パターン A: ルートエクスポート + subpath** (partysocket)

```jsonc
// packages/partysocket/package.json:10-55
{
  "exports": {
    ".": {
      "types": { "import": "./index.d.ts", "require": "./index.d.cts" },
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
    },
    "./ws": {
      "types": { "import": "./ws.d.ts", "require": "./ws.d.cts" },
      "import": "./dist/ws.js",
      "require": "./dist/ws.cjs",
    },
    "./react": { "types": { "import": "./react.d.ts" }, "import": "./dist/react.js", "require": "./dist/react.cjs" },
    "./use-ws": {/* ... */},
    "./event-target-polyfill": {/* ... */},
  },
}
```

ルート `.` は `PartySocket` クラスをデフォルトエクスポートし、`./ws` は低レベルの `ReconnectingWebSocket` を公開する。React フックは `./react` と `./use-ws` で別パスに分離。

**パターン B: ルートなし、server/client/react 分離** (partysub, partytracks, partysync)

```jsonc
// packages/partysub/package.json:10-26
{
  "exports": {
    "./server": { "types": "./dist/server/index.d.ts", "import": "./dist/server/index.js" },
    "./client": { "types": "./dist/client/index.d.ts", "import": "./dist/client/index.js" },
    "./react": { "types": "./dist/client/react.d.ts", "import": "./dist/client/react.js" },
  },
}
```

ルート `.` を定義しないことで、利用者に「このパッケージはサーバーかクライアントかを明示的に選択せよ」と強制する。

**パターン C: ルートのみ** (partyserver, partyfn, hono-party)

```jsonc
// packages/partyserver/package.json:9-11
{
  "main": "dist/index.js",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
}
```

単一実行環境向けのパッケージは `exports` フィールドすら使わず、`main`/`module`/`types` で十分。

### ビルド時のエクスポート検証

```typescript
// scripts/check-exports.ts:9-28
function extractFilePaths(
  exports: unknown,
  paths: Set<string> = new Set(),
): Set<string> {
  if (typeof exports === "string") {
    paths.add(exports);
  } else if (Array.isArray(exports)) {
    for (const item of exports) {
      extractFilePaths(item, paths);
    }
  } else if (exports && typeof exports === "object") {
    for (const value of Object.values(exports)) {
      extractFilePaths(value, paths);
    }
  }
  return paths;
}
```

`package.json` の `exports` フィールドを再帰的に走査して全ファイルパスを抽出し、`existsSync` で実在を検証する。`npm run build` の最後に `tsx scripts/check-exports.ts` が実行され（`package.json:14`）、壊れたエクスポートがリリースされることを防ぐ。

### 型の階層的 re-export

```typescript
// packages/partyserver/src/index.ts:19
export * from "./types";
```

`types.ts` で定義された `Connection`, `ConnectionContext`, `ConnectionState` 等の型を `index.ts` で re-export する。利用者は `import type { Connection } from "partyserver"` とインポートでき、内部ファイル構造を知る必要がない。一方、`connection.ts` の `ConnectionManager` インターフェースや `AttachmentCache` クラスは意図的にエクスポートされていない。

### API 拡張パターン: Mixin vs Class 継承

**Mixin パターン** (y-partyserver):

```typescript
// packages/y-partyserver/src/server/index.ts:167-170
export function withYjs<TBase extends ServerClass>(
  Base: TBase
): TBase & YjsStatic & (new (...args: any[]) => YjsInstance) {
  class YjsMixin extends Base {
```

`withYjs(Server)` で Server クラスに Yjs 機能を混ぜ込む。ショートカットとして `export const YServer = withYjs(Server)` も提供。

**Class 継承パターン** (partywhen, partysync):

```typescript
// packages/partywhen/src/index.ts:79-81
export class Scheduler<
  Env extends Cloudflare.Env = Cloudflare.Env
> extends Server<Env> {
```

直接 `Server` を継承する素朴な拡張。Mixin の合成柔軟性は不要な場合に使う。

**Factory パターン** (partysub):

```typescript
// packages/partysub/src/server/index.ts:26-36
export function createPubSubServer<Env extends Cloudflare.Env>(options: {
  binding: string;
  nodes?: number;
  // ...
}): {
  PubSubServer: typeof Server<Env>;
  routePubSubRequest: (request: Request, env: Env) => Promise<Response | null>;
};
```

設定に基づいてカスタマイズされたクラスとルーティング関数をペアで返す。利用者は factory の返り値をそのまま使える。

### デュアルフォーマットビルドの条件付き適用

```typescript
// packages/partysocket/scripts/build.ts:5-19
await build({
  entry: ["src/index.ts", "src/react.ts", "src/ws.ts", "src/use-ws.ts", "src/event-target-polyfill.ts"],
  format: ["esm", "cjs"], // クライアント: デュアル
  dts: true,
  // ...
});

// packages/partyserver/scripts/build.ts:4-13
await build({
  entry: ["src/index.ts"],
  format: "esm", // サーバー: ESM のみ
  dts: true,
  // ...
});
```

`partysocket` は `package.json` でも `.d.ts` と `.d.cts` を分けて型の条件分岐を `types.import` / `types.require` で制御している。

### 命名規約の実践

AGENTS.md で明文化された命名規約がコードに一貫して適用されている:

- **クラス: PascalCase** — `Server`, `PartySocket`, `ReconnectingWebSocket`, `Scheduler`, `RPCClient`, `SyncServer`
- **関数: camelCase** — `routePartykitRequest`, `getServerByName`, `createPubSubServer`, `partyserverMiddleware`
- **型/インターフェース: PascalCase** — `Connection`, `ConnectionContext`, `PartySocketOptions`, `PartyServerOptions`, `Lobby`
- **定数: UPPER_SNAKE_CASE** — `DEFAULT`, `NAME_STORAGE_KEY`, `AWARENESS_IDS_KEY`, `CALLBACK_DEFAULTS`
- **プライベートメソッド: _ prefix** — `_connect`, `_debug`, `_handleOpen`, `_getNextDelay`

## パターンカタログ

- **Mixin パターン** (分類: 構造)
  - 解決する問題: 単一継承制約下で複数の機能を合成する
  - 適用条件: 基底クラスが固定でなく、利用者が独自の基底クラスと組み合わせたい場合
  - コード例: `packages/y-partyserver/src/server/index.ts:167-548`
  - 注意点: TypeScript の型推論が複雑になる。`as unknown as TBase & YjsStatic & ...` のようなキャストが必要になる場合がある

- **Factory Method パターン** (分類: 生成)
  - 解決する問題: 設定に基づいて関連オブジェクト群（サーバークラス + ルーティング関数）をまとめて生成する
  - 適用条件: 複数の関連コンポーネントを一貫した設定で生成する必要がある場合
  - コード例: `packages/partysub/src/server/index.ts:26-207`
  - 注意点: Factory が返すオブジェクトの型が複雑になりやすい。返り値の型を明示的に定義すること

- **Adapter パターン** (分類: 構造)
  - 解決する問題: フレームワーク固有の API を既存のパッケージ API に接続する
  - 適用条件: 第三者フレームワーク（Hono 等）と連携する場合
  - コード例: `packages/hono-party/src/index.ts:47-66` — `partyserverMiddleware` が Hono の Context を `routePartykitRequest` に適合させる
  - 注意点: 元の API の型を拡張しつつ、フレームワーク固有のコンテキストを注入するため、ジェネリクスの設計が肝要

## Good Patterns

- **型安全な条件付き exports と型宣言の分離**: `partysocket` は `types.import` と `types.require` で `.d.ts` と `.d.cts` を別々に指定し、ESM/CJS 環境で正しい型が解決される。ビルドスクリプトの `post-build` ステップで `shx mv dist/*.d.cts dist/*.d.ts* .` としてルートに配置する工夫により、subpath exports の `"types"` パスがパッケージルートから直接参照できる。

- **エクスポート検証の CI 統合**: `scripts/check-exports.ts` が `package.json` の `exports` フィールドを再帰的に解析し、参照先ファイルの存在を検証する。`npm run build` の最後に自動実行され、壊れたエクスポートを早期検出する。

- **`configurable: true` による下流拡張ポイント**: `Connection` 型の `state` と `setState` プロパティは `Object.defineProperties` で `configurable: true` として定義されている（`packages/partyserver/src/connection.ts:151,157`）。JSDoc でも「downstream consumers (e.g. the Cloudflare Agents SDK) to namespace or wrap internal state storage」と意図が明文化されている。下流パッケージが内部実装を安全にオーバーライドできる設計。

- **deprecated プロパティの getter 警告**: `Lobby.party` は `get party()` 内で `console.warn` を1回だけ発火する設計（`partyserver/src/index.ts:283-293`）。フラグ `partyDeprecationWarned` で重複警告を防ぐ。

## Anti-Patterns / 注意点

- **内部実装クラスの意図せぬ公開**: `partyserver/src/index.ts` は `export * from "./types"` で型を一括 re-export しているが、`types.ts` に新しい型を追加すると自動的にパブリック API になる。型の公開範囲を明示的に制御したい場合は、名前付き re-export (`export type { Connection, ConnectionContext } from "./types"`) を使うべき。

```typescript
// Bad: 将来追加される型も自動的にパブリックになる
export * from "./types";

// Better: パブリック API を明示的に列挙
export type { Connection, ConnectionContext, ConnectionSetStateFn, ConnectionState } from "./types";
```

- **subpath exports 未使用パッケージの見落とし**: `partyserver` や `partywhen` は `exports` フィールドを定義せず `main`/`types` のみ。`scripts/check-exports.ts` は `exports` フィールドがないパッケージをスキップするため、`main` フィールドが指す `dist/index.js` の実在は検証されない。

```typescript
// scripts/check-exports.ts:43-46
if (!packageJson.exports) {
  // No exports field, nothing to check  ← main/types のチェックが漏れる
  return { packageName, missing };
}
```

## 導出ルール

- `[MUST]` subpath exports を定義する場合、`types` 条件を最初に配置し、ESM (`.d.ts`) と CJS (`.d.cts`) の型宣言を分離する
  - 根拠: partysocket が `"types": { "import": "./index.d.ts", "require": "./index.d.cts" }` の順序で型解決の優先度を正しく設定している（`partysocket/package.json:12-16`）

- `[MUST]` package.json の `exports` フィールドが参照するファイルの実在をビルド後に自動検証するスクリプトを CI に組み込む
  - 根拠: `scripts/check-exports.ts` がすべてのパッケージの exports を再帰的に検証し、ビルドパイプラインの最後に実行される（`package.json:14`）

- `[SHOULD]` 1 つのパッケージがサーバー・クライアント・React の複数環境で使われる場合、subpath exports で `./server`、`./client`、`./react` に分離する
  - 根拠: partysub, partytracks, partysync が一貫してこのパターンを採用し、バンドルサイズの最小化とツリーシェイキングを実現している

- `[SHOULD]` デュアルフォーマット（ESM + CJS）対応はブラウザ/Node.js 両用のクライアントパッケージに限定し、サーバー専用パッケージは ESM のみにする
  - 根拠: partysocket のみ `format: ["esm", "cjs"]`、他 8 パッケージは `format: "esm"` で維持コストを最小化している

- `[SHOULD]` クラスベースの拡張 API を提供する際、単純な用途には class 継承、合成の柔軟性が必要な場合には mixin 関数 (`withXxx`) + 事前合成済みクラスの両方を提供する
  - 根拠: y-partyserver が `withYjs(Base)` mixin と `YServer = withYjs(Server)` の両方を公開し、カスタム基底クラスとの合成と簡単な利用の両方をサポートしている

- `[SHOULD]` API の非互換変更は JSDoc `@deprecated` とランタイム警告を組み合わせ、1回だけ警告を発火する getter で段階的に移行させる
  - 根拠: `Lobby.party` が `@deprecated` + `console.warn` + フラグによる重複抑制の3層で移行を誘導している（`partyserver/src/index.ts:94,283-293`）

- `[AVOID]` `export *` でモジュール全体を re-export すること。意図しない内部型がパブリック API に漏洩する
  - 根拠: `partyserver/src/index.ts:19` の `export * from "./types"` は、types.ts への追加が自動的にパブリック API となるリスクがある

## 適用チェックリスト

- [ ] パッケージの `exports` フィールドで `types` 条件を最初に配置しているか
- [ ] サーバー/クライアント/React が混在するパッケージで subpath exports を使い、環境ごとにエントリポイントを分離しているか
- [ ] `exports` フィールドが参照する全ファイルの実在を検証するスクリプトが CI に存在するか
- [ ] デュアルフォーマット（ESM + CJS）をクライアントパッケージにのみ適用し、サーバーパッケージは ESM のみか
- [ ] `export *` ではなく名前付き re-export で、パブリック API を明示的に制御しているか
- [ ] deprecated API に JSDoc `@deprecated` とランタイム警告の両方を付与しているか
- [ ] クラス拡張 API で、mixin 関数と事前合成済みクラスの両方を提供しているか（合成の柔軟性が必要な場合）
- [ ] 命名規約（PascalCase クラス、camelCase 関数、UPPER_SNAKE_CASE 定数）がパッケージ横断で統一されているか
