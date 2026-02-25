# project-structure

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

npm workspaces によるモノレポ構造を分析し、パッケージ境界の引き方・依存関係の方向性・公開 API の設計を明らかにする。partykit は 15 パッケージを持つが、実装があるのは 9 パッケージで、残り 6 はプレースホルダー（名前予約）である。コアの `partyserver` を頂点に据え、peerDependencies による疎結合な依存グラフと、`server/client/react` エントリポイント分離による環境別バンドルが一貫して適用されている点が注目に値する。

## 背景にある原則

- **コアを薄く保ち、機能拡張は別パッケージで行う**: `partyserver` のソースは 3 ファイル（index.ts, types.ts, connection.ts）のみで、WebSocket ライフサイクルの基底クラスとルーティング関数だけを提供する。Yjs 統合、pub/sub、RPC、スケジューリングといった機能はすべて別パッケージに分離されている。これにより、利用者は必要な機能だけを依存に追加できる。根拠: `partyserver` の dependencies は `nanoid` 1 つだけ（`packages/partyserver/package.json:42`）。

- **peerDependencies でパッケージ間の結合方向を制御する**: 拡張パッケージ（y-partyserver, partysub, hono-party 等）は `partyserver` を peerDependencies に置き、バージョン範囲 `>=0.2.0 <1.0.0` で結合する。これにより、利用者のプロジェクトで partyserver のバージョンが統一され、バンドルの重複を防ぐ。根拠: 6 パッケージが peerDependencies を宣言しており、すべてが partyserver または外部フレームワーク（hono, yjs, react）を peer に指定している。

- **環境境界で exports エントリポイントを分割する**: サーバー側コード（Cloudflare Workers）とクライアント側コード（ブラウザ）を同一パッケージ内で共存させつつ、`exports` フィールドの subpath（`./server`, `./client`, `./react`）で分離する。これによりバンドラがツリーシェイキング可能な境界を認識できる。根拠: partysub, partysync, partytracks の 3 パッケージが `./server` / `./client` / `./react` の 3 エントリポイントを持つ。

- **プレースホルダーパッケージで名前空間を確保する**: partyagent, partybase, partyflow, partyhard, partysession, partysmart の 6 パッケージは実装がなく、npm に名前を確保する目的で存在する。`exports` フィールドも未定義で、ビルドスクリプトも持たない。根拠: `packages/partyagent/package.json` には `exports` も `scripts.build` もない。

## 実例と分析

### 依存グラフの階層構造

パッケージ間の依存は厳密な一方向の階層を形成している。

```
Layer 0 (コア):     partyserver ── partysocket
Layer 1 (機能拡張): y-partyserver, partysub, partywhen, hono-party, partyfn
Layer 2 (統合):     partysync (partyserver + partysocket + partyfn に依存)
Layer 3 (独立):     partytracks (外部依存のみ: rxjs, jose, cookie)
```

Layer 0 の 2 パッケージは互いに依存しない。`partyserver` はサーバー側、`partysocket` はクライアント側という明確な環境分離がある。Layer 1 のパッケージは Layer 0 を peerDependencies で参照する。Layer 2 の `partysync` は 3 つの内部パッケージに依存する最も結合度が高いパッケージだが、それでも peerDependencies 経由の疎結合を維持している。

### ビルド順序の明示的な制御

ルートの `package.json` でビルド順序が明示されている。

```json
// package.json:14
"build": "npm run build -w partyserver -w partysocket -w y-partyserver -w partysub -w partyfn -w partysync -w partywhen -w partytracks -w hono-party && tsx scripts/check-exports.ts"
```

`partyserver` と `partysocket` が先頭にあるのは、他のパッケージがこれらの型定義に依存するためである。ビルド後に `check-exports.ts` が全パッケージの `exports` フィールドに記載されたファイルの実在を検証する。

### subpath exports による環境分離パターン

`partysub` の exports 定義は典型例である。

```json
// packages/partysub/package.json:11-26
"exports": {
  "./server": {
    "types": "./dist/server/index.d.ts",
    "require": "./dist/server/index.js",
    "import": "./dist/server/index.js"
  },
  "./client": {
    "types": "./dist/client/index.d.ts",
    "require": "./dist/client/index.js",
    "import": "./dist/client/index.js"
  },
  "./react": {
    "types": "./dist/client/react.d.ts",
    "require": "./dist/client/react.js",
    "import": "./dist/client/react.js"
  }
}
```

この構造はソースのディレクトリレイアウト（`src/server/`, `src/client/`）と 1:1 で対応している。利用者は `import { PubSubServer } from "partysub/server"` と `import { ... } from "partysub/client"` でそれぞれの環境用コードだけをインポートできる。

### Dual format (ESM + CJS) の選択的適用

`partysocket` のみが ESM と CJS の両方を出力する。

```typescript
// packages/partysocket/scripts/build.ts:6-7
format: ["esm", "cjs"],
```

他のすべてのパッケージは ESM のみ（`format: "esm"`）である。これは `partysocket` がブラウザ・Node.js 両方で使われるクライアントライブラリであり、CJS 環境（Webpack 4 や Jest のデフォルト設定など）との互換性が必要なためと推測される。サーバー側の `partyserver` は Cloudflare Workers 専用であり ESM のみで十分である。

### Mixin パターンによるコア拡張

`y-partyserver` は `withYjs` 関数で Server クラスを拡張する mixin パターンを採用している。

```typescript
// packages/y-partyserver/src/server/index.ts:167-170
export function withYjs<TBase extends ServerClass>(
  Base: TBase
): TBase & YjsStatic & (new (...args: any[]) => YjsInstance) {
  class YjsMixin extends Base {
```

これにより `partyserver` の Server クラスを直接変更せずに Yjs 機能を追加できる。サブクラス化ではなく mixin にすることで、利用者が独自の Server サブクラスにも Yjs 機能を合成できる。

### fixtures ワークスペースによるドッグフーディング

`fixtures/*` は npm workspaces に含まれており、パッケージのローカル開発版を直接参照する。

```json
// fixtures/chat/package.json:11-12
"partyserver": "^0.3.1",
"partysocket": "^1.1.16",
```

Changesets の設定で fixtures は無視される（`"ignore": ["@partyserver/fixture-*"]`、`.changeset/config.json`）ため、パッケージバージョニングには影響しない。

### ビルド後の exports 検証スクリプト

```typescript
// scripts/check-exports.ts:49-64
const filePaths = extractFilePaths(packageJson.exports);
for (const filePath of filePaths) {
  if (!filePath.startsWith(".")) continue;
  const fullPath = resolve(packageDir, filePath);
  if (!existsSync(fullPath)) {
    missing.push(filePath);
  }
}
```

このスクリプトは `package.json` の `exports` フィールドに記載されたすべてのファイルパスを再帰的に抽出し、実際にファイルが存在するかを検証する。ビルド忘れや exports の typo を CI で検出できる。

## パターンカタログ

- **Mixin パターン** (分類: 構造)
  - 解決する問題: コアクラスを変更せずに横断的な機能を合成する
  - 適用条件: 基底クラスが安定しており、機能拡張が複数の直交する軸で発生する場合
  - コード例: `packages/y-partyserver/src/server/index.ts:167-548`
  - 注意点: TypeScript の型推論が複雑になる（`TBase & YjsStatic & (new (...args: any[]) => YjsInstance)` のような戻り値型が必要）

- **Factory パターン** (分類: 生成)
  - 解決する問題: 設定に基づいてサーバークラスとルーティング関数をペアで生成する
  - 適用条件: クラスとヘルパー関数がセットで提供される場合
  - コード例: `packages/partysub/src/server/index.ts:26-207`（`createPubSubServer` がクラスと関数のペアを返す）
  - 注意点: 返り値の型が `{ PubSubServer: typeof Server, routePubSubRequest: ... }` のように複合的になる

## Good Patterns

- **peerDependencies + devDependencies の対称配置**: 拡張パッケージで `partyserver` を peerDependencies（利用者のバージョンに委ねる）と devDependencies（開発時の型解決用）の両方に記載する。これにより、モノレポ内の開発中は devDependencies で解決され、利用者の環境では peerDependencies の制約が働く。

```json
// packages/y-partyserver/package.json:56-63
"devDependencies": {
  "partyserver": "^0.3.1"
},
"peerDependencies": {
  "partyserver": ">=0.2.0 <1.0.0"
}
```

- **src ディレクトリと exports の 1:1 対応**: ソースコードのディレクトリ構造（`src/server/`, `src/client/`, `src/react/`）がビルド出力（`dist/server/`, `dist/client/`）とパッケージ exports（`./server`, `./client`, `./react`）に直接マッピングされる。開発者がソース構造を見れば公開 API の境界を即座に把握できる。

```
src/server/index.ts  ->  dist/server/index.js  ->  "exports": { "./server": ... }
src/client/index.ts  ->  dist/client/index.js  ->  "exports": { "./client": ... }
```

- **ビルド後の exports 整合性チェック**: ビルドコマンドの末尾で `check-exports.ts` を実行し、`exports` に記載されたファイルがすべて実在することを自動検証する。型定義ファイルの生成漏れやパスの typo を早期に発見できる。

```json
// package.json:14
"build": "... && tsx scripts/check-exports.ts"
```

## Anti-Patterns / 注意点

- **名前予約パッケージの放置によるワークスペース汚染**: 6 個のプレースホルダーパッケージが workspaces に含まれており、`npm install` 時にシンボリックリンクが作成される。ビルドやテストの対象にはなっていないが、ワークスペースの一覧が肥大化し、新規開発者が混乱する可能性がある。

```
Bad: packages/ に実装のないパッケージが 6 個混在
Better: 名前予約用の npm publish は別リポまたは別ディレクトリ（reserved/）で管理し、
        workspaces には含めない
```

- **ビルド順序のハードコード**: ルートの build スクリプトで `-w` フラグによる順序が手動で記述されている。パッケージ追加時に更新を忘れるとビルドが壊れる。

```json
Bad:
"build": "npm run build -w partyserver -w partysocket -w y-partyserver ..."

Better:
// turborepo / nx 等の依存グラフベースのビルドオーケストレーションを使う
"build": "turbo run build"
```

## 導出ルール

- `[MUST]` モノレポのパッケージ間依存は peerDependencies で宣言し、devDependencies に同じパッケージを開発用として追加する
  - 根拠: partykit の全拡張パッケージがこのパターンを採用しており、利用者環境でのバージョン重複を防止している（`packages/y-partyserver/package.json:56-63`）

- `[MUST]` `package.json` の `exports` フィールドに記載したファイルパスの実在をビルド後に自動検証するスクリプトを用意する
  - 根拠: partykit は `scripts/check-exports.ts` でビルド後に全パッケージの exports を検証しており、型定義ファイルの生成漏れを CI で検出している

- `[SHOULD]` サーバー / クライアント / フレームワークバインディング（React 等）を同一パッケージ内で提供する場合、subpath exports（`./server`, `./client`, `./react`）で分離し、ソースディレクトリ構造と 1:1 で対応させる
  - 根拠: partysub, partysync, partytracks の 3 パッケージがこのパターンを一貫して適用しており、バンドラのツリーシェイキングと開発者の認知負荷削減を両立している

- `[SHOULD]` ESM/CJS デュアルフォーマット出力はクライアントライブラリにのみ適用し、サーバー専用パッケージは ESM 単独とする
  - 根拠: partykit では 9 パッケージ中 `partysocket` のみが CJS を出力し、サーバー側の partyserver 等はすべて ESM のみ（`packages/partysocket/scripts/build.ts:13` vs `packages/partyserver/scripts/build.ts:8`）

- `[SHOULD]` コアパッケージは最小限の依存のみを持ち、機能拡張は mixin やアダプターとして別パッケージに分離する
  - 根拠: `partyserver` の dependencies は `nanoid` のみで、Yjs 統合は `y-partyserver` の `withYjs` mixin、Hono 統合は `hono-party` のミドルウェアとして分離されている

- `[AVOID]` モノレポのビルド順序をシェルスクリプトや npm scripts のハードコードで管理する
  - 根拠: partykit の root `build` スクリプトは `-w` フラグで 9 パッケージを手動列挙しており、パッケージの追加・依存変更時にメンテナンスコストが発生する

## 適用チェックリスト

- [ ] モノレポ内のパッケージ間依存が peerDependencies + devDependencies の対称配置になっているか確認する
- [ ] `package.json` の `exports` フィールドに記載したすべてのファイルが実際にビルド出力に存在するかを検証するスクリプトを CI に組み込む
- [ ] サーバーとクライアントのコードが同一パッケージにある場合、subpath exports で分離されているか確認する
- [ ] ソースディレクトリ構造（`src/server/`, `src/client/`）と `exports` のサブパスが 1:1 対応しているか確認する
- [ ] CJS 出力が本当に必要なパッケージを特定し、不要なパッケージは ESM のみにする
- [ ] コアパッケージの dependencies を棚卸しし、機能拡張は別パッケージへの分離を検討する
- [ ] ビルドオーケストレーションがパッケージの依存グラフに基づいて自動的に順序を決定しているか確認する
