# practice: peer-deps-dual-declaration

> 出典: [repos/cloudflare/partykit/dependency-management.md](../repos/cloudflare/partykit/dependency-management.md), [repos/TanStack/query/dependency-management.md](../repos/TanStack/query/dependency-management.md)
> カテゴリ: practice

## 概要

モノレポの拡張パッケージがコアパッケージを利用する場合、`peerDependencies` に広いバージョンレンジを、`devDependencies` に具体バージョンを二重宣言する依存管理戦略。開発時は最新のコアでテストしつつ、消費者にはバージョン選択の自由を与え、バンドルの重複インストールを防ぐ。cloudflare/partykit（npm workspaces）と TanStack/query（pnpm workspaces）の両方で一貫して採用されており、パッケージマネージャを問わず適用できる汎用パターンである。

## 背景・文脈

モノレポでコアパッケージと拡張パッケージを分離する設計では、拡張パッケージがコアをどの依存種別で参照するかが重要な設計判断になる。

- `dependencies` に入れると、消費者のプロジェクトでコアが二重インストールされるリスクがある
- `peerDependencies` だけにすると、モノレポ内の開発時に型解決やテスト実行で問題が起きる
- `devDependencies` だけにすると、消費者にコアのインストールを要求するシグナルがない

この三つの課題を同時に解決するのが「peerDependencies + devDependencies の二重宣言」パターンである。

cloudflare/partykit では 4 つの拡張パッケージ（y-partyserver, partysub, hono-party, partysync）すべてがこのパターンを採用している。TanStack/query では 24 パッケージ中、devtools やフレームワークアダプターが同様の構造を持つ。両プロジェクトとも sherif による一貫性検証と Changesets の `onlyUpdatePeerDependentsWhenOutOfRange` を組み合わせ、バージョン管理の自動化まで含めた完成度の高い運用を実現している。

## 実装パターン

### パターン 1: npm workspaces（cloudflare/partykit）

npm workspaces では、バージョン番号を直接記述する。peerDependencies に広いレンジ、devDependencies に具体バージョンを指定する。

```jsonc
// packages/y-partyserver/package.json:55-63
"devDependencies": {
  "partyserver": "^0.3.1"          // 開発・テスト用の具体バージョン
},
"peerDependencies": {
  "partyserver": ">=0.2.0 <1.0.0"  // 消費者向けの広いレンジ
}
```

```jsonc
// packages/partysub/package.json:42-51
"peerDependencies": {
  "partyserver": ">=0.2.0 <1.0.0",
  "partysocket": "^1.1.14"
},
"devDependencies": {
  "partyserver": "^0.3.1",
  "partysocket": "^1.1.16"
}
```

### パターン 2: pnpm workspaces（TanStack/query）

pnpm では `workspace:` プロトコルを使い、`workspace:*`（dependencies/devDependencies 用）と `workspace:^`（peerDependencies 用）を意図的に使い分ける。publish 時に pnpm が実際のバージョン番号に自動置換する。

```jsonc
// packages/react-query-devtools/package.json:82,93
"dependencies": {
  "@tanstack/query-devtools": "workspace:*"   // publish 時: "5.x.y"（実バージョン）
},
"peerDependencies": {
  "@tanstack/react-query": "workspace:^"      // publish 時: "^5.x.y"（キャレット範囲）
}
```

```jsonc
// packages/react-query/package.json:68
"dependencies": {
  "@tanstack/query-core": "workspace:*"
},
"devDependencies": {
  "@tanstack/query-persist-client-core": "workspace:*",
  "@tanstack/query-test-utils": "workspace:*"
}
```

### 補足: sherif による一貫性検証

両プロジェクトとも、モノレポ内の依存バージョン不整合を sherif で自動検出している。

```jsonc
// TanStack/query の package.json:16
"test:sherif": "sherif -i typescript -p \"./integrations/*\" -p \"./examples/*\""
```

```jsonc
// cloudflare/partykit の package.json:19
// sherif をルートの scripts で実行し、CI で一貫性をチェック
```

### 補足: Changesets によるカスケードバンプの抑制

peerDependencies の範囲内であれば、コアの patch 更新で拡張パッケージの無意味なバージョンバンプが起きないようにする。

```jsonc
// cloudflare/partykit の .changeset/config.json:10-16
// TanStack/query の .changeset/config.json:10-16（同一設定）
"updateInternalDependencies": "patch",
"___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH": {
  "onlyUpdatePeerDependentsWhenOutOfRange": true
}
```

## Good Example

### npm workspaces の場合

```jsonc
// packages/my-extension/package.json
{
  "name": "@myorg/extension",
  "peerDependencies": {
    "@myorg/core": ">=1.0.0 <2.0.0", // 消費者に広い互換性を保証
  },
  "devDependencies": {
    "@myorg/core": "^1.5.0", // 開発時は最新でテスト
  },
}
```

**実例 — cloudflare/partykit:**

```jsonc
// packages/y-partyserver/package.json:55-63
{
  "devDependencies": {
    "partyserver": "^0.3.1",
  },
  "peerDependencies": {
    "partyserver": ">=0.2.0 <1.0.0",
  },
}
```

### pnpm workspaces の場合

```jsonc
// packages/my-devtools/package.json
{
  "name": "@myorg/devtools",
  "dependencies": {
    "@myorg/devtools-ui": "workspace:*", // 密結合: 実バージョンで publish
  },
  "peerDependencies": {
    "@myorg/react-adapter": "workspace:^", // 疎結合: キャレット範囲で publish
  },
}
```

**実例 — TanStack/query:**

```jsonc
// packages/react-query-devtools/package.json:82,93
{
  "dependencies": {
    "@tanstack/query-devtools": "workspace:*",
  },
  "peerDependencies": {
    "@tanstack/react-query": "workspace:^",
    "react": "^18 || ^19",
  },
}
```

## Bad Example

### 拡張パッケージがコアを dependencies に入れる

```jsonc
// Bad: コアが消費者のプロジェクトで二重インストールされる
{
  "name": "@myorg/extension",
  "dependencies": {
    "@myorg/core": "^1.5.0",
  },
}
```

消費者が `@myorg/core@1.3.0` を使っている場合、extension が `@myorg/core@1.5.0` を別途バンドルし、バージョン不一致による実行時エラーやバンドルサイズ肥大化を引き起こす。

### peerDependencies のレンジが狭すぎる

```jsonc
// Bad: コアの patch 更新のたびに拡張も更新が必要
{
  "name": "@myorg/extension",
  "peerDependencies": {
    "@myorg/core": "^1.5.0", // 1.5.0 未満を排除してしまう
  },
  "devDependencies": {
    "@myorg/core": "^1.5.0",
  },
}
```

peerDependencies のレンジが devDependencies と同じでは、二重宣言のメリットが活きない。peerDependencies は広く、devDependencies は具体的に、という非対称性が重要。

### 密結合なのに peerDependencies にする

```jsonc
// Bad: class extends で直接継承しているのに peer にする
{
  "name": "@myorg/scheduler",
  "peerDependencies": {
    "@myorg/core": ">=1.0.0 <2.0.0"
  }
}

// src/index.ts
import { Server } from "@myorg/core";
export class Scheduler extends Server { ... }
```

cloudflare/partykit の `partywhen` はこの判断を正しく行っている。`class Scheduler extends Server` で直接継承する密結合パッケージでは、バージョンミスマッチが実行時エラーを引き起こすため、`dependencies` に含めるべきである。

```jsonc
// Better: 密結合は dependencies で宣言（partywhen/package.json:31-33）
{
  "name": "@myorg/scheduler",
  "dependencies": {
    "@myorg/core": "^1.5.0",
  },
}
```

## 適用ガイド

### どのような状況で使うべきか

- モノレポ内でコアパッケージと拡張パッケージ（プラグイン、アダプター、devtools 等）を分離している場合
- 拡張パッケージがコアの API を「利用」するが、コアの内部実装に深く依存しない場合（mixin、ラッパー、コンポジション等）
- パッケージを npm/pnpm registry に公開し、外部の消費者が利用する場合

### 使うべきでない場合

- 拡張パッケージがコアクラスを `extends` で直接継承する密結合の場合 -> `dependencies` を使う
- publish しない内部専用パッケージ（テストユーティリティ等）-> `devDependencies` のみで十分
- モノレポ外の単一パッケージプロジェクト -> peerDependencies の二重宣言は不要

### 導入時の注意点

1. **sherif 等の一貫性検証ツールを CI に組み込む**: パッケージ数が増えると、手動でのバージョン管理は破綻する。sherif は npm/pnpm 両対応で、意図的な例外は `-i` フラグでホワイトリスト化できる
2. **Changesets の `onlyUpdatePeerDependentsWhenOutOfRange` を有効にする**: これがないと、コアの patch リリースのたびに全拡張パッケージがバージョンバンプされ、消費者の lockfile が不必要に変更される
3. **overrides/resolutions で型定義パッケージを統一する**: `@types/react` 等がパッケージ間で不一致だと、型エラーが CI で頻発する

### npm と pnpm の違い

| 項目             | npm workspaces     | pnpm workspaces         |
| ---------------- | ------------------ | ----------------------- |
| peerDeps の記法  | `">=1.0.0 <2.0.0"` | `"workspace:^"`         |
| devDeps の記法   | `"^1.5.0"`         | `"workspace:*"`         |
| publish 時の変換 | 手動管理           | `workspace:` が自動置換 |
| バージョン統一   | `overrides`        | `pnpm.overrides`        |

pnpm の `workspace:` プロトコルは publish 時の自動変換があるため、バージョン番号の二重管理が不要になる利点がある。

## 参考

- [repos/cloudflare/partykit/dependency-management.md](../repos/cloudflare/partykit/dependency-management.md) -- peerDependencies の三分類パターンと sherif 設定
- [repos/cloudflare/partykit/project-structure.md](../repos/cloudflare/partykit/project-structure.md) -- パッケージ間の依存階層設計
- [repos/TanStack/query/dependency-management.md](../repos/TanStack/query/dependency-management.md) -- workspace プロトコルの使い分けと sherif 運用
