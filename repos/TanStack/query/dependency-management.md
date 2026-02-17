# dependency-management

> リポジトリ: TanStack/query
> 分析日: 2026-02-17

## 概要

TanStack Query は 24 パッケージからなる大規模モノレポで、React / Vue / Solid / Svelte / Angular / Preact という 6 つのフレームワークアダプターを単一リポジトリから公開している。フレームワーク非依存の `query-core` を軸に、`workspace:*` と `workspace:^` を使い分ける peerDeps 戦略、pnpm overrides による型パッケージの一元管理、sherif によるバージョン整合性の自動検証、Changesets の `onlyUpdatePeerDependentsWhenOutOfRange` オプションによるカスケード更新の抑制など、モノレポ依存管理の模範的なプラクティスが高密度に実装されている。

## 背景にある原則

- **コアとアダプターの分離による依存グラフの単純化**: フレームワーク固有のコードを `query-core` から完全に排除し、各アダプターが core を `dependencies` で参照する一方向の依存を徹底している。これにより、6 フレームワーク分のピア依存が core に波及せず、core 単体でフレームワーク非依存のテストが完結する。
- **公開時の依存種別を開発時と厳密に区別する**: `workspace:*`（内部 dependencies / devDependencies）と `workspace:^`（peerDependencies）を意図的に使い分けることで、開発時は常にローカル最新を参照しつつ、公開後はセマンティックバージョニングの柔軟性を維持する。
- **バージョン整合性を人手ではなくツールチェーンで保証する**: sherif（依存バージョンの重複・不整合検出）、knip（未使用依存検出）、publint + attw（パッケージ公開品質検証）を CI に組み込み、依存管理のミスを機械的に防止している。
- **型互換性の範囲をテストで証明する**: TypeScript 5.0 から 5.8 まで 9 バージョンでの型チェックを全パッケージで実行し、`peerDependencies` に記載するバージョン範囲の妥当性を実証している。

## 実例と分析

### workspace プロトコルの使い分け: `workspace:*` vs `workspace:^`

TanStack Query では、内部パッケージの参照に 2 種類の workspace プロトコルを一貫して使い分けている。

**`workspace:*` の用途**: dependencies と devDependencies に使用。開発時に常にローカルの最新ソースを参照する。publish 時に pnpm が実際のバージョン番号に置換する。

```jsonc
// packages/react-query/package.json:68
"dependencies": {
  "@tanstack/query-core": "workspace:*"
},
"devDependencies": {
  "@tanstack/query-persist-client-core": "workspace:*",
  "@tanstack/query-test-utils": "workspace:*",
}
```

**`workspace:^` の用途**: peerDependencies 専用。publish 時に `^5.90.21` のようなキャレット範囲に置換され、消費者側でバージョンの柔軟な解決を許容する。

```jsonc
// packages/react-query-devtools/package.json:92-95
"peerDependencies": {
  "@tanstack/react-query": "workspace:^",
  "react": "^18 || ^19"
}
```

この使い分けにより、devtools や persist-client のようなコンパニオンパッケージが、ユーザーのプロジェクトで異なるパッチバージョンの react-query と共存できる。

### 依存グラフの階層設計

パッケージ間の依存は 4 層の明確な階層を形成している。

```
Layer 0: query-core（依存なし）
Layer 1: react-query, vue-query, solid-query, svelte-query, preact-query
         query-persist-client-core, query-devtools
Layer 2: react-query-devtools, vue-query-devtools, solid-query-devtools, svelte-query-devtools
         react-query-persist-client, svelte-query-persist-client, solid-query-persist-client
Layer 3: react-query-next-experimental
```

Layer 1 は core を `dependencies` で参照し、フレームワーク固有ランタイムを `peerDependencies` で宣言する。Layer 2 は Layer 1 のアダプターを `peerDependencies` (`workspace:^`) で参照し、core の devtools UI を `dependencies` (`workspace:*`) で参照する。

### pnpm overrides によるバージョン一元管理

```jsonc
// package.json:87-95
"pnpm": {
  "overrides": {
    "@types/react": "^19.2.7",
    "@types/react-dom": "^19.2.3",
    "@types/node": "^22.15.3",
    "vite": "^6.4.1",
    "esbuild": "^0.27.2"
  }
}
```

型定義パッケージ（`@types/react`, `@types/react-dom`, `@types/node`）とビルドツール（`vite`, `esbuild`）のバージョンを overrides で統一している。これにより、24 パッケージ間で型の不整合が発生しない。

### sherif による依存整合性の自動検証

```jsonc
// package.json:16
"test:sherif": "sherif -i typescript -p \"./integrations/*\" -p \"./examples/*\""
```

sherif は monorepo 内の依存バージョンの不整合を検出するリンター。`-i typescript` で TypeScript をホワイトリストに登録しているのは、ルートに `typescript50` 〜 `typescript57` という npm エイリアスで複数バージョンを意図的にインストールしているため。`-p` で examples と integrations を除外し、ライブラリパッケージ間の整合性に集中している。

### 複数 TypeScript バージョンでの型テスト

```jsonc
// package.json:76-83（ルート devDependencies）
"typescript": "5.8.3",
"typescript50": "npm:typescript@5.0",
"typescript51": "npm:typescript@5.1",
// ...
"typescript57": "npm:typescript@5.7",
```

```jsonc
// packages/query-core/package.json:22-29
"test:types:ts50": "node ../../node_modules/typescript50/lib/tsc.js --build tsconfig.legacy.json",
"test:types:ts51": "node ../../node_modules/typescript51/lib/tsc.js --build tsconfig.legacy.json",
// ...
"test:types:tscurrent": "tsc --build",
```

npm のパッケージエイリアス機能（`"typescript50": "npm:typescript@5.0"`）を使い、同一 node_modules に複数バージョンの TypeScript を共存させ、各パッケージの `test:types` スクリプトで全バージョンに対して型チェックを実行する。これにより `peerDependencies` に記載する TypeScript バージョン範囲の根拠がテストで裏付けられる。

### Changesets のカスケード更新制御

```jsonc
// .changeset/config.json:10-16
"updateInternalDependencies": "patch",
"___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH": {
  "onlyUpdatePeerDependentsWhenOutOfRange": true
}
```

`updateInternalDependencies: "patch"` は内部依存のバージョンを patch 単位で自動追従させる。`onlyUpdatePeerDependentsWhenOutOfRange: true` は peerDependencies を持つ依存先が更新されても、その範囲内であれば依存元のバージョンは bumping しない。これにより、core の patch 更新が全アダプターの無意味なバージョンバンプを引き起こすのを防ぐ。

### devtools の optionalDependencies パターン

```jsonc
// packages/angular-query-experimental/package.json:104-106
"optionalDependencies": {
  "@tanstack/query-devtools": "workspace:*"
}
```

Angular アダプターでは devtools を `optionalDependencies` として宣言し、本番ビルドでは stub に差し替える（`exports` の `"default"` が `stub.mjs` を指す）。React / Vue / Solid / Svelte では devtools を別パッケージに分離し `peerDependencies` で参照する方式を採る。同一リポジトリ内で 2 つの devtools 統合パターンが共存している。

### private パッケージによる共有テストユーティリティ

```jsonc
// packages/query-test-utils/package.json:6
"private": true,
```

`@tanstack/query-test-utils` は `"private": true` と `"version": "0.0.0"` で宣言され、npm に publish されない。ソースを直接 `exports` する（ビルドステップなし）ことで、テスト時のオーバーヘッドを排除している。全パッケージから `devDependencies` で参照され、テストヘルパーの重複を防ぐ。

### パッケージ公開品質の三重検証

```jsonc
// packages/react-query/package.json:33
"test:build": "publint --strict && attw --pack"
```

`publint` は package.json の `exports` / `main` / `module` / `types` の整合性を検証する。`attw`（Are the Types Wrong?）はパッケージの型解決が CJS / ESM の両方で正しく動作するか検証する。これに加えて `size-limit` がバンドルサイズの回帰を監視する。

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: フレームワーク固有の API を統一的なインターフェースで提供する
  - 適用条件: コアロジックが複数のコンシューマーから利用され、それぞれ異なるランタイム統合を必要とする場合
  - コード例: `packages/react-query/src/index.ts:4` の `export * from '@tanstack/query-core'` による core の再エクスポート
  - 注意点: 再エクスポートは tree-shaking に影響しうるため、`sideEffects: false` を必ず宣言する

## Good Patterns

- **workspace プロトコルの意図的使い分け**: `workspace:*` を dependencies/devDependencies に、`workspace:^` を peerDependencies に限定することで、開発時の即時反映と公開後のバージョン柔軟性を両立する。

```jsonc
// packages/react-query-devtools/package.json:82,93
"dependencies": {
  "@tanstack/query-devtools": "workspace:*"   // 公開時: 実バージョン
},
"peerDependencies": {
  "@tanstack/react-query": "workspace:^",     // 公開時: ^5.x.y
}
```

- **npm エイリアスによる複数 TypeScript バージョン共存**: `"typescript50": "npm:typescript@5.0"` のエイリアスパターンで、同一ワークスペースに複数バージョンを共存させ、各パッケージから個別に型チェックを実行する。

```jsonc
// package.json:76-78
"typescript": "5.8.3",
"typescript50": "npm:typescript@5.0",
"typescript51": "npm:typescript@5.1",
```

- **private パッケージによる共有ユーティリティ**: `"private": true` + `"version": "0.0.0"` で publish されないパッケージを作り、ビルドなしでソースを直接 export する。テストユーティリティや内部ツールに最適。

```jsonc
// packages/query-test-utils/package.json:6,11-12
"private": true,
"main": "src/index.ts",
"types": "src/index.ts",
```

## Anti-Patterns / 注意点

- **overrides と peerDependencies の範囲不一致**: pnpm overrides で型パッケージを特定バージョンに固定する場合、その範囲が各パッケージの peerDependencies と矛盾するとランタイムエラーにはならないが開発者体験を損なう。TanStack Query では overrides を `^` 範囲にして柔軟性を維持している。

```jsonc
// Bad: overrides で完全固定
"overrides": { "@types/react": "19.2.7" }

// Better: キャレット範囲で固定
"overrides": { "@types/react": "^19.2.7" }
```

- **sherif の除外設定漏れ**: 意図的に複数バージョンをインストールしている依存（TypeScript のエイリアス等）を sherif に除外登録し忘れると、CI が誤検知で失敗し続ける。

```bash
# Bad: 除外なし
sherif

# Better: 意図的な複数バージョンをホワイトリスト
sherif -i typescript -p "./integrations/*" -p "./examples/*"
```

## 導出ルール

- `[MUST]` モノレポで内部パッケージを peerDependencies として参照する場合は `workspace:^` を使い、dependencies / devDependencies として参照する場合は `workspace:*` を使う
  - 根拠: TanStack Query は全 24 パッケージでこの規約を徹底し、公開後のバージョン柔軟性と開発時の即時反映を両立している（`packages/react-query-devtools/package.json:82,93`）
- `[MUST]` peerDependencies のバージョン範囲は、実際にテストしたバージョンのみをカバーする範囲にする
  - 根拠: TanStack Query は TypeScript 5.0〜5.8 の各バージョンで型チェックを実行し、サポート範囲を実証でテストしている（`packages/query-core/package.json:22-30`）
- `[SHOULD]` モノレポでは依存バージョンの整合性を検証するリンター（sherif 等）を CI に組み込む
  - 根拠: 24 パッケージ間のバージョン不整合を人手で管理するのは不可能であり、sherif を `test:ci` に含めることで PR 時に自動検出している（`package.json:14,16`）
- `[SHOULD]` 型定義パッケージとビルドツールのバージョンはパッケージマネージャの overrides で一元管理する
  - 根拠: `@types/react` 等がパッケージ間で不一致だと型エラーが発生するため、pnpm overrides で `^` 範囲の単一バージョンに統一している（`package.json:88-94`）
- `[SHOULD]` publish されないモノレポ内部パッケージは `"private": true` + `"version": "0.0.0"` にし、ソースを直接 export する
  - 根拠: `@tanstack/query-test-utils` はビルドステップなしでソースを直接参照し、CI のフィードバックループを短縮している（`packages/query-test-utils/package.json:6,11-12`）
- `[SHOULD]` Changesets の `onlyUpdatePeerDependentsWhenOutOfRange` を有効にし、内部依存の patch 更新がエコシステム全体の無意味なバージョンバンプを引き起こすのを防ぐ
  - 根拠: core の patch 更新で react-query / vue-query 等の全アダプターが同時バンプされると、ユーザーの lockfile が不必要に変更される（`.changeset/config.json:14-16`）
- `[AVOID]` モノレポの examples / integrations フォルダを依存整合性検証の対象に含めること
  - 根拠: examples は各フレームワークの異なるバージョンを意図的に使用するため、ライブラリパッケージとは整合性の基準が異なる。sherif は `-p` オプションで除外している（`package.json:16`）

## 適用チェックリスト

- [ ] 内部パッケージ参照で `workspace:*`（deps/devDeps）と `workspace:^`（peerDeps）を一貫して使い分けているか
- [ ] pnpm overrides（または npm overrides / yarn resolutions）で型定義パッケージのバージョンを一元管理しているか
- [ ] 依存バージョンの整合性を検証するツール（sherif 等）を CI パイプラインに組み込んでいるか
- [ ] パッケージの公開品質を publint / attw 等で自動検証しているか（exports / types / CJS-ESM 互換性）
- [ ] peerDependencies に記載したバージョン範囲を、実際のテストで裏付けているか（特に TypeScript バージョン）
- [ ] Changesets の `onlyUpdatePeerDependentsWhenOutOfRange` を有効にし、カスケードバンプを抑制しているか
- [ ] publish しない内部ユーティリティパッケージを `"private": true` にし、ビルドなし直接参照にしているか
- [ ] size-limit 等でバンドルサイズの回帰を PR 単位で監視しているか
