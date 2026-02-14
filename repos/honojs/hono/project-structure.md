# project-structure

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

ディレクトリ構成・モジュール境界・公開 API の設計戦略を分析する。Hono は単一パッケージ（monorepo ではない）でありながら 60 以上のサブパスエクスポートを持ち、5 種のルーター実装・25 のミドルウェア・9 のランタイムアダプターを内包する。これだけの機能を tree-shakeable かつ dual ESM/CJS 対応で提供しつつ、各モジュールが一貫したディレクトリ規約に従っている点が設計上の注目ポイントである。

## 背景にある原則

- **公開 API をファイルシステム構造に写像する**: `package.json` の `exports` フィールドが `src/` のディレクトリ構造と 1:1 対応している。`hono/cors` は `src/middleware/cors/index.ts` に、`hono/router/reg-exp-router` は `src/router/reg-exp-router/index.ts` にマッピングされる。これにより、ユーザーの import パスを見ればソースの場所が推定でき、新モジュール追加時のエクスポート設定も機械的に行える（`build/validate-exports.ts` で package.json と jsr.json の整合性を自動検証している）。

- **コアを最小に保ち、拡張をサブパスに分離する**: メインエントリ `src/index.ts` は `Hono` クラスと主要な型のみをエクスポートし、ミドルウェア・ヘルパー・アダプターは個別の import パスに分離している。ユーザーが使わないモジュールがバンドルに含まれない設計であり、バンドルサイズの最適化と API の見通しの両方を達成している。

- **インターフェースによる実装の交換可能性**: `Router<T>` インターフェース（`src/router.ts`）が `add` と `match` の 2 メソッドのみを定義し、5 種のルーター実装がすべてこの interface を満たす。同様に `GetConnInfo` 型（`src/helper/conninfo/types.ts`）がアダプターごとに異なる接続情報取得を同一シグネチャで抽象化している。インターフェースを最小にすることで、実装の差し替えが容易になる。

- **プリセットパターンによるデフォルトの層別化**: `src/hono-base.ts` がルーターを持たない「抽象基底」、`src/hono.ts` が SmartRouter をデフォルト注入する「標準構成」、`src/preset/tiny.ts` が PatternRouter のみの「軽量構成」という 3 層で構成される。ユーザーは用途に応じて `hono`/`hono/tiny`/`hono/quick` を選択でき、基底クラスの変更なしにバリエーションを追加できる。

## 実例と分析

### ディレクトリの役割分担と命名規約

ソースコードは `src/` 直下に 5 つの主要カテゴリディレクトリを持つ。

| ディレクトリ  | 役割                                            | 粒度の基準                        |
| ------------- | ----------------------------------------------- | --------------------------------- |
| `adapter/`    | ランタイム固有の統合コード                      | ランタイムごとに 1 ディレクトリ   |
| `middleware/` | リクエスト/レスポンスパイプラインの横断的関心事 | 機能ごとに 1 ディレクトリ         |
| `helper/`     | ユーティリティ的な機能拡張                      | 機能ごとに 1 ディレクトリ         |
| `router/`     | ルーティングアルゴリズムの実装                  | アルゴリズムごとに 1 ディレクトリ |
| `utils/`      | 内部ユーティリティ関数                          | ファイル単位（ディレクトリなし）  |

`middleware/` と `helper/` の違いは、前者がミドルウェアシグネチャ `(c, next) => ...` を返す関数、後者はそれ以外の補助機能（`testClient`、`getRuntimeKey` など）である。この区別により、ユーザーは `app.use()` に渡せるモジュールか否かを import パスから判断できる。

### index.ts によるバレルエクスポートの一貫パターン

各サブモジュールは `index.ts` をエントリポイントとし、内部実装を re-export する。

```typescript
// src/router/reg-exp-router/index.ts:5-7
export { buildInitParams, PreparedRegExpRouter, serializeInitParams } from "./prepared-router";
export { RegExpRouter } from "./router";
```

```typescript
// src/adapter/cloudflare-workers/index.ts:5-8
export { getConnInfo } from "./conninfo";
export { serveStatic } from "./serve-static-module";
export { upgradeWebSocket } from "./websocket";
```

各 `index.ts` は公開 API の「門番」として機能し、内部のファイル構造を隠蔽する。`router.ts`、`matcher.ts`、`trie.ts` といった実装詳細は直接エクスポートされない。

### コアのレイヤー分離: hono-base.ts / hono.ts / preset/

```typescript
// src/hono-base.ts:117-118 (コメントより)
/*
  This class is like an abstract class and does not have a router.
  To use it, inherit the class and implement router in the constructor.
*/
router!: Router<[H, RouterRoute]>
```

```typescript
// src/hono.ts:16-34
export class Hono<...> extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router =
      options.router ??
      new SmartRouter({
        routers: [new RegExpRouter(), new TrieRouter()],
      })
  }
}
```

```typescript
// src/preset/tiny.ts:11-20
export class Hono<...> extends HonoBase<E, S, BasePath> {
  constructor(options: HonoOptions<E> = {}) {
    super(options)
    this.router = new PatternRouter()
  }
}
```

基底クラスはルーターを `!` 付きで宣言するだけで、具体的なルーターの注入はサブクラスに委ねる。TypeScript の `abstract` キーワードではなく non-null assertion を使っている点は、ユーザーが `HonoBase` を直接継承してカスタムプリセットを作れるようにするためと推測される。

### SmartRouter: 実行時のアルゴリズム選択

```typescript
// src/router/smart-router/router.ts:21-50
match(method: string, path: string): Result<T> {
  // ...
  for (; i < len; i++) {
    const router = routers[i]
    try {
      for (let i = 0, len = routes.length; i < len; i++) {
        router.add(...routes[i])
      }
      res = router.match(method, path)
    } catch (e) {
      if (e instanceof UnsupportedPathError) {
        continue
      }
      throw e
    }
    this.match = router.match.bind(router)  // 以降は選ばれたルーターに直接委譲
    this.#routers = [router]
    this.#routes = undefined
    break
  }
```

SmartRouter は初回 `match` 時に複数のルーター候補を順に試し、成功したルーターの `match` メソッドで自身の `match` を上書きする。これは Chain of Responsibility + 自己書き換えによる遅延最適化パターンであり、パスパターンの複雑さに応じて最適なアルゴリズムが自動選択される。

### ミドルウェアのファクトリ関数パターン

全ミドルウェアは「オプションを受け取り MiddlewareHandler を返すファクトリ関数」という統一シグネチャに従う。

```typescript
// src/middleware/cors/index.ts:63
export const cors = (options?: CORSOptions): MiddlewareHandler => {
  // ... 設定のマージ・クロージャ変数の準備 ...
  return async function cors(c, next) {
    // ... 実行時ロジック ...
  };
};
```

```typescript
// src/middleware/logger/index.ts:81
export const logger = (fn: PrintFunc = console.log): MiddlewareHandler => {
  return async function logger(c, next) {
    // ...
  };
};
```

返される関数に名前（`function cors`, `function logger`）を付けているのは、スタックトレースでの識別を容易にするためである。

### Dual ESM/CJS ビルドと package.cjs.json

```typescript
// build/build.ts:75-88
const cjsConfig: BuildOptions = {
  ...commonOptions,
  outbase: "./src",
  outdir: "./dist/cjs",
  format: "cjs",
};

const esmConfig: BuildOptions = {
  ...commonOptions,
  bundle: true,
  outbase: "./src",
  outdir: "./dist",
  format: "esm",
  plugins: [addExtension(".js")],
};
```

CJS 出力を `dist/cjs/` に分離し、そのディレクトリに `{"type": "commonjs"}` の `package.json` を配置する（`package.cjs.json` をコピー）。これにより、Node.js のモジュール解決が ESM/CJS を正しく判別できる。`package.json` の各エクスポートは `types`/`import`/`require` の 3 条件を明示する。

### エクスポート整合性の自動検証

```typescript
// build/validate-exports.ts:1-37
export const validateExports = (
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  fileName: string,
) => {
  // ...
  Object.keys(source).forEach((sourceEntry) => {
    if (!isEntryInTarget(sourceEntry)) {
      throw new Error(`Missing "${sourceEntry}" in '${fileName}'`);
    }
  });
};
```

```typescript
// build/build.ts:31
validateExports(packageJsonExports, jsrJsonExports, "jsr.json");
validateExports(jsrJsonExports, packageJsonExports, "package.json");
```

ビルド時に `package.json` と `jsr.json` のエクスポート定義を双方向に検証する。一方にあって他方にないエクスポートがあればビルドエラーとなる。複数レジストリ対応で起こりがちなエクスポートの不整合を防ぐ仕組みである。

### アダプターの共通インターフェースと個別実装

`GetConnInfo` 型を例に、アダプター間の統一と分離を確認する。

```typescript
// src/helper/conninfo/types.ts:45
export type GetConnInfo = (c: Context) => ConnInfo;
```

```typescript
// src/adapter/cloudflare-workers/conninfo.ts:3-6
export const getConnInfo: GetConnInfo = (c) => ({
  remote: {
    address: c.req.header("cf-connecting-ip"),
  },
});
```

```typescript
// src/adapter/bun/conninfo.ts:10-43
export const getConnInfo: GetConnInfo = (c: Context) => {
  const server = getBunServer<{...}>(c)
  // ... Bun 固有の requestIP() を使用 ...
}
```

共通の型を `helper/conninfo/types.ts` で定義し、各アダプターがランタイム固有の方法で実装する。ユーザーコードは `GetConnInfo` 型に依存すれば、ランタイムの切り替えが import パスの変更だけで完了する。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ルーティングアルゴリズムを実行時に切り替えたい
  - 適用条件: 同一インターフェースを満たす複数の実装が存在し、コンテキストに応じて最適な実装を選びたい場合
  - コード例: `src/router.ts:29-52` の `Router<T>` インターフェース、`src/router/smart-router/router.ts` の SmartRouter
  - 注意点: SmartRouter は初回実行時に自己書き換えで Strategy を固定する変形。通常の Strategy よりオーバーヘッドが小さい

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: フレームワークの骨格を定義しつつ、一部を利用者にカスタマイズさせたい
  - 適用条件: 基底クラスがアルゴリズムの骨格（fetch/dispatch/compose）を定義し、サブクラスが可変部分（ルーター選択）を提供する場合
  - コード例: `src/hono-base.ts` (基底) と `src/hono.ts` / `src/preset/tiny.ts` (サブクラス)
  - 注意点: TypeScript の `abstract` は使わず `!` 演算子で「後から注入」を表現している

- **Facade パターン** (分類: 構造)
  - 解決する問題: 複雑なサブシステムに簡潔なインターフェースを提供したい
  - 適用条件: 内部に多数のファイルを持つモジュールを、単一の `index.ts` 経由で公開する場合
  - コード例: `src/adapter/bun/index.ts` が `serve-static`、`ssg`、`websocket`、`conninfo`、`server` を統合エクスポート
  - 注意点: バレルファイルが大きくなりすぎると tree-shaking の効果が減少するリスクがある

## Good Patterns

- **ファクトリ関数 + 名前付き関数式**: ミドルウェアのファクトリが返す関数に名前を付けることで、デバッグ時のスタックトレースが読みやすくなる。

```typescript
// src/middleware/cors/index.ts:99
return async function cors(c, next) {
  // ...
};
```

```typescript
// src/middleware/basic-auth/index.ts:86
return async function basicAuth(ctx, next) {
  // ...
};
```

無名関数 `async (c, next) => { ... }` ではなく `async function cors(c, next) { ... }` とすることで、エラー発生時に `cors` というスタックフレーム名が表示される。

- **カテゴリディレクトリによるモジュール分類**: `middleware/`（パイプラインに挿入する横断的関心事）と `helper/`（補助的ユーティリティ）を明確に分けることで、新モジュールの配置場所が機械的に決まる。判断基準は「`app.use()` に渡せるか否か」。

- **ビルド時のクロスレジストリ検証**: `package.json` と `jsr.json` のエクスポート定義を双方向に比較するスクリプトをビルドパイプラインに組み込むことで、npm と JSR のエクスポート不整合を CI 段階で検出できる。

```typescript
// build/build.ts:31-32
validateExports(packageJsonExports, jsrJsonExports, "jsr.json");
validateExports(jsrJsonExports, packageJsonExports, "package.json");
```

- **private フィールドのビルド後除去**: TypeScript の `#` private フィールドは `.d.ts` に出力されるとユーザーの型チェックに不要なノイズとなる。ビルド後に AST パーサーで自動除去する。

```typescript
// build/remove-private-fields.ts:5-25
export async function removePrivateFields(files: string[]) {
  // oxc-parser で AST 解析 → PrivateIdentifier を持つ PropertyDefinition を除去
}
```

## Anti-Patterns / 注意点

- **バレルファイルの肥大化**: サブパスエクスポートが 60 以上あるため、`package.json` の `exports` と `typesVersions` がそれぞれ数百行に達している。新モジュール追加時に 3 箇所（`package.json` exports、`typesVersions`、`jsr.json`）を同時更新する必要がある。

```json
// Bad: 手動で 3 ファイルを同期管理
// package.json exports + typesVersions + jsr.json
```

```typescript
// Better: validate-exports.ts による自動検証で不整合を防止
validateExports(packageJsonExports, jsrJsonExports, "jsr.json");
```

この課題に対し、ビルドスクリプト内の `validateExports` が安全網として機能している。理想的にはエクスポート定義を単一の設定から自動生成する方がよいが、現状は検証による整合性保証で対処している。

- **utils/ の二重性**: `src/utils/` にはフラットなファイル（`url.ts`、`cookie.ts` 等）が置かれ、一部は `hono/utils/*` としてユーザーにも公開されている。内部ユーティリティと公開ユーティリティが同一ディレクトリに混在するため、どのファイルが公開 API なのかがファイル名だけでは判断できない。

```
// Bad: 公開/非公開が混在
src/utils/
  url.ts          # 公開 (hono/utils/url)
  cookie.ts       # 公開 (hono/utils/cookie)
  constants.ts    # 非公開（exports に含まれない）
  handler.ts      # 非公開
```

```
// Better: 公開ユーティリティを別ディレクトリに分離するか、
// ファイル命名規約（例: internal- prefix）で区別する
```

## 導出ルール

- `[MUST]` package.json の `exports` フィールドはソースディレクトリ構造と 1:1 対応させ、ユーザーの import パスからソース位置を推定可能にする
  - 根拠: Hono は `hono/cors` -> `src/middleware/cors/index.ts` の対応を全 60+ エクスポートで維持し、ビルドスクリプトで自動検証している（`build/validate-exports.ts`）

- `[MUST]` 複数のパッケージレジストリに公開する場合、ビルド時にエクスポート定義の整合性を双方向に自動検証する
  - 根拠: `build/build.ts:31-32` で `package.json` と `jsr.json` の exports を相互比較し、不整合があればビルドエラーにしている

- `[SHOULD]` 単一パッケージで複数の独立機能を提供する場合、カテゴリディレクトリ（`middleware/`, `adapter/`, `helper/` 等）で分類し、各モジュールの `index.ts` を Facade として内部を隠蔽する
  - 根拠: Hono の `src/adapter/bun/index.ts` は 5 つの内部ファイルを 1 つのバレルにまとめ、`package.json` では `hono/bun` として単一エクスポートを提供している

- `[SHOULD]` ミドルウェアやプラグインのファクトリ関数が返す関数には名前を付け、スタックトレースでの識別を容易にする
  - 根拠: 全ミドルウェアが `return async function cors(c, next)` のように名前付き関数式を使用しており、デバッグ時にどのミドルウェアでエラーが発生したか即座に特定できる

- `[SHOULD]` 同一インターフェースの複数実装がある場合、コアにインターフェースを最小定義（2-3 メソッド）し、選択ロジックをコンポジションで提供する
  - 根拠: `Router<T>` は `add` / `match` の 2 メソッドのみで、SmartRouter が初回実行時に最適な実装を自動選択する（`src/router/smart-router/router.ts:21-50`）

- `[SHOULD]` Dual ESM/CJS ビルドでは CJS 出力ディレクトリに `{"type": "commonjs"}` の package.json を配置し、各エクスポートに `types`/`import`/`require` の 3 条件を明示する
  - 根拠: `dist/cjs/package.json`（`package.cjs.json` からコピー）と `package.json` の conditional exports で Node.js のモジュール解決を正しく制御している

- `[AVOID]` コアモジュールのメインエントリに全機能を re-export すること。コアは最小限のクラスと型のみをエクスポートし、拡張機能はサブパスに分離する
  - 根拠: `src/index.ts` は Hono クラスと主要型のみ（約 15 エクスポート）。25 のミドルウェアや 9 のアダプターは全てサブパスからの import を要求し、不要なコードのバンドルを防いでいる

## 適用チェックリスト

- [ ] `package.json` の `exports` フィールドがソースディレクトリ構造と対応しているか確認する
- [ ] メインエントリ（`index.ts`）がコア機能のみをエクスポートし、拡張機能がサブパスに分離されているか確認する
- [ ] 各サブモジュールが `index.ts` によるバレルエクスポートで内部実装を隠蔽しているか確認する
- [ ] ミドルウェア/プラグインのファクトリ関数が返す関数に名前が付いているか確認する
- [ ] 同一目的で複数の実装が存在する場合、共通インターフェースが最小に定義されているか確認する
- [ ] Dual ESM/CJS ビルドの場合、CJS ディレクトリに `{"type": "commonjs"}` の package.json が配置されているか確認する
- [ ] 複数レジストリ（npm/JSR 等）に公開する場合、エクスポート定義の整合性を自動検証するスクリプトがあるか確認する
- [ ] 公開ユーティリティと内部ユーティリティが同一ディレクトリに混在していないか、または区別する仕組みがあるか確認する
