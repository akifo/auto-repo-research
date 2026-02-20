# dependency-management

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs は 60 超のパッケージを持つ大規模 pnpm workspace monorepo であり、依存管理の設計が際立って洗練されている。コアパッケージ `@langchain/core` を頂点とするピラミッド構造で、`workspace:^` と `workspace:*` の使い分け、pnpm overrides によるシングルトン強制、changesets の `fixed` グループと `onlyUpdatePeerDependentsWhenOutOfRange` による破壊的変更の抑制、Docker ベースの dependency range テストによる互換性検証など、大規模 monorepo における依存管理の実践的パターンが体系的に適用されている。

## 背景にある原則

- **コアのシングルトン性保証**: プラグイン型アーキテクチャでは、コアライブラリのインスタンスが複数存在すると `instanceof` チェックの失敗やグローバル状態の分裂を引き起こす。langchainjs はルートの `pnpm.overrides` で `"@langchain/core": "workspace:^"` を強制し、workspace 内のあらゆるパッケージが同一の `@langchain/core` インスタンスを参照することを保証している（`package.json:57`）。

- **公開 API 境界と内部依存の分離**: `workspace:^` は publish 時に `^x.y.z` に変換され semver 互換範囲になるのに対し、`workspace:*` は `x.y.z` の exact version に変換される。langchainjs は公開パッケージ間のバージョン互換を `workspace:^` で、内部ツール（`@langchain/tsconfig`, `@langchain/eslint`, `@langchain/build`）を `workspace:*` で参照し、公開 API 境界と内部ツールチェーンの境界を明確に区別している。

- **依存の重さに応じた optional 化**: 100 以上のサードパーティ統合を持つ `@langchain/community` は、全統合ライブラリを `peerDependencies` + `peerDependenciesMeta.optional: true` として宣言し、ユーザーが必要な統合だけをインストールする設計にしている。これによりインストールサイズの爆発を防ぎつつ、型安全性を維持している。

- **セキュリティ修正の強制伝播**: pnpm overrides で `protobufjs`, `form-data`, `tar`, `node-forge` のバージョン下限を引き上げ、transitive dependency のセキュリティ脆弱性を monorepo 全体で一括修正している（`package.json:58-61`）。

## 実例と分析

### workspace:^ と workspace:* の使い分け

`@langchain/core` は monorepo 内の全パッケージから `workspace:^` で参照される。これは publish 後に `^1.1.26` のような semver 範囲に変換され、ユーザーが異なるバージョンの `@langchain/core` をインストールしても互換範囲内であれば動作する。

一方、内部ツール（`@langchain/tsconfig`, `@langchain/eslint`, `@langchain/build`, `@langchain/standard-tests`）は `workspace:*` で参照される。これらは `private: true` で npm に公開されないため、exact version でロックしても外部ユーザーに影響しない。

さらに注目すべきは Google 系パッケージの連鎖構造である。`@langchain/google-vertexai` は `@langchain/google-gauth` を `workspace:*` で dependencies に持ち、`@langchain/google-gauth` は `@langchain/google-common` を同様に `workspace:*` で参照する。これらは changesets の `fixed` グループで同一バージョンに固定されるため、`workspace:*` でも整合性が保たれる。

### pnpm overrides によるコアの一元化

ルート `package.json` に設定された `"@langchain/core": "workspace:^"` の override は、workspace 内の全パッケージが依存する `@langchain/core` を、ローカルの workspace パッケージに強制的に解決する。これにより、transitive dependency 経由で npm registry の古いバージョンが混入することを防いでいる。

### changesets による固定グループとリリース制御

`.changeset/config.json` で以下の設計判断がなされている:

1. **fixed グループ**: Google 系 6 パッケージ（`google-common`, `google-gauth`, `google-webauth`, `google-vertexai`, `google-vertexai-web`, `google-genai`）は常に同一バージョンでリリースされる。密結合なパッケージ群のバージョン不整合を根本的に防ぐ戦略。

2. **onlyUpdatePeerDependentsWhenOutOfRange**: `@langchain/core` の patch リリースで全 provider パッケージの peerDependencies が自動更新されないよう制御。これがないと core の patch ごとに全パッケージの不要なリリースが発生する。

3. **updateInternalDependencies: "patch"**: 内部依存の更新は patch バージョンとして扱い、不要な major/minor バンプを抑制。

4. **ignore: ["examples"]**: examples パッケージは changeset の対象外。

### peerDependencies による依存の委譲

provider パッケージ（`@langchain/openai`, `@langchain/anthropic` 等）は `@langchain/core` を peerDependencies に宣言し、devDependencies にも `workspace:^` で記載する。この「peer + dev」パターンにより、開発時は workspace のローカルコアを使いつつ、公開後はユーザー側のコアバージョンに委譲する。

`@langchain/community` は極端な例で、100 以上のサードパーティ SDK を全て optional な peerDependencies として宣言している。

### Docker ベースの依存範囲テスト

`dependency_range_tests/` では Docker コンテナ内でパッケージを isolated に配置し、`test-with-latest-deps.sh` と `test-with-lowest-deps.sh` の 2 パターンでテストを実行する。これにより、semver 範囲の上限（最新バージョン）と下限（最低バージョン）の両方で互換性を検証している。

`environment_tests/` では ESM, CJS, esbuild, Vite, Vercel, Bun, Cloudflare Workers など 9 環境で exports の正常動作を検証している。workspace パッケージが各 bundler/runtime で正しく解決されることを保証する仕組み。

### zod のバージョン範囲戦略

`"zod": "^3.25.76 || ^4"` という OR 範囲で zod v3 と v4 の両方をサポートしている。メジャーバージョンの移行期にユーザーのアップグレードを阻害しない配慮。一部のパッケージ（`@langchain/groq` では `"^4.0.14"`）は v4 のみに移行済みであり、段階的な移行が進行中。

## コード例

```jsonc
// package.json:55-62 — ルートの pnpm overrides
"pnpm": {
  "overrides": {
    "@langchain/core": "workspace:^",
    "protobufjs": "^7.2.5",
    "form-data": "^4.0.4",
    "tar": ">=7.5.4",
    "node-forge": ">=1.3.2"
  }
}
```

```jsonc
// libs/providers/langchain-openai/package.json:36-46 — peer + dev パターン
"dependencies": {
  "js-tiktoken": "^1.0.12",
  "openai": "^6.18.0",
  "zod": "^3.25.76 || ^4"
},
"peerDependencies": {
  "@langchain/core": "workspace:^"  // publish 時に ^1.x.x に変換
},
"devDependencies": {
  "@langchain/core": "workspace:^",  // 開発時はローカル参照
  "@langchain/eslint": "workspace:*",  // 内部ツールは exact
  "@langchain/standard-tests": "workspace:*",
  "@langchain/tsconfig": "workspace:*",
  // ...
}
```

```jsonc
// .changeset/config.json:10-27 — 固定グループとリリース制御
"fixed": [
  [
    "@langchain/google-common",
    "@langchain/google-gauth",
    "@langchain/google-webauth",
    "@langchain/google-vertexai",
    "@langchain/google-vertexai-web",
    "@langchain/google-genai"
  ]
],
"updateInternalDependencies": "patch",
"ignore": ["examples"],
"___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH": {
  "onlyUpdatePeerDependentsWhenOutOfRange": true
}
```

```jsonc
// libs/providers/langchain-google-vertexai/package.json:31-33 — fixed グループ内の workspace:*
"dependencies": {
  "@langchain/google-gauth": "workspace:*"  // fixed グループなので exact でも安全
}
```

```bash
# dependency_range_tests/scripts/langchain/test-with-lowest-deps.sh:1-30
#!/usr/bin/env bash
set -euxo pipefail
corepack enable
export CI=true
export LC_DEPENDENCY_RANGE_TESTS=true
shopt -s extglob
cp -r ../langchain/!(node_modules|dist|dist-cjs|dist-esm|build|.next|.turbo) ./
bash /scripts/create-mock-tsconfigs.sh . /app
# ...
node /updater_script/update_resolutions_lowest.js  # 最低バージョンに固定してテスト
pnpm install
pnpm run test
```

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: 100 以上のサードパーティ統合を 1 パッケージで提供する際のインストールサイズ爆発
  - 適用条件: 多数の optional な外部依存を持つ統合パッケージ
  - コード例: `libs/langchain-community/package.json:207-323`（peerDependencies）と `libs/langchain-community/package.json:324-398`（peerDependenciesMeta）
  - 注意点: peerDependencies の数が膨大になると npm/pnpm の警告が大量に出る。`peerDependenciesMeta.optional: true` で抑制できるが、ユーザーが必要な依存を見つけにくくなる副作用がある

## Good Patterns

- __workspace:^ と workspace:_ の意図的な使い分け_*: 公開パッケージ間は `workspace:^`（semver 互換範囲）、内部ツールは `workspace:*`（exact）と分けることで、publish 後のバージョン解決と開発時の一貫性を両立する。langchainjs は全 provider で一貫してこのパターンを適用している。

```jsonc
// libs/providers/langchain-anthropic/package.json:39-45
"peerDependencies": {
  "@langchain/core": "workspace:^"  // -> ^1.1.26 (互換範囲)
},
"devDependencies": {
  "@langchain/core": "workspace:^",
  "@langchain/eslint": "workspace:*",  // private: true なので exact
  "@langchain/tsconfig": "workspace:*"  // private: true なので exact
}
```

- **pnpm overrides によるシングルトン強制**: コアパッケージを overrides で workspace 参照に固定し、transitive dependency 経由の重複インスタンスを防止する。ランタイムの `instanceof` チェックや singleton 状態の一貫性に直結する重要なパターン。

```jsonc
// package.json:56-57
"pnpm": {
  "overrides": {
    "@langchain/core": "workspace:^"
  }
}
```

- **changesets の fixed グループによるバージョン同期**: 密結合パッケージ群を fixed グループに入れ、常に同一バージョンでリリースする。Google 系 6 パッケージが全て v2.1.19 で揃っている。

```jsonc
// .changeset/config.json:10-19
"fixed": [
  ["@langchain/google-common", "@langchain/google-gauth", "@langchain/google-webauth",
   "@langchain/google-vertexai", "@langchain/google-vertexai-web", "@langchain/google-genai"]
]
```

- **メジャーバージョン移行期の OR 範囲**: `"^3.25.76 || ^4"` で旧メジャーと新メジャーの両方をサポートし、エコシステム全体の段階的移行を可能にする。

## Anti-Patterns / 注意点

- **peerDependencies の "workspace:^" が publish 後に変換される罠**: `peerDependencies` に `"workspace:^"` と書くと publish 時に `"^1.1.26"` のような具体バージョン範囲に変換される。この変換を知らずに手動で semver 範囲を書くと、workspace 内での開発時に npm registry のバージョンが解決される可能性がある。

```jsonc
// Bad: peerDependencies に手動で範囲を書く（workspace 内で不整合が起きうる）
"peerDependencies": {
  "@langchain/core": ">=1.0.0 <2.0.0"
}

// Better: workspace protocol を使い、publish 時の自動変換に任せる
"peerDependencies": {
  "@langchain/core": "workspace:^"
}
```

- **fixed グループなしの密結合パッケージ**: `@langchain/google-vertexai` が `@langchain/google-gauth` を `workspace:*` で参照する構造は、changesets の fixed グループがなければバージョン不整合を引き起こす。密結合パッケージを独立リリースすると、ユーザー側で「A@2.0.0 は B@1.9.0 と互換性がない」といった問題が発生する。

```jsonc
// Bad: 密結合パッケージを fixed グループなしで workspace:* 参照
"dependencies": { "@my/common": "workspace:*" }
// publish 後に @my/common@1.2.3 (exact) になるが、common が先にリリースされると不整合

// Better: changesets の fixed グループで同時リリースを保証
// .changeset/config.json
"fixed": [["@my/common", "@my/wrapper-a", "@my/wrapper-b"]]
```

## 導出ルール

- `[MUST]` monorepo でコアパッケージが singleton であることを要求する場合、ルートの package manager overrides（pnpm overrides / yarn resolutions）でコアを workspace 参照に固定する
  - 根拠: langchainjs は `"@langchain/core": "workspace:^"` を overrides に設定し、transitive dependency 経由での重複インスタンスを防止している（`package.json:57`）

- `[MUST]` 公開パッケージ間の依存には `workspace:^` を、非公開内部ツールには `workspace:*` を使い分ける
  - 根拠: langchainjs の全 provider は `@langchain/core` を `workspace:^` で参照し publish 後も semver 互換を保つ一方、`@langchain/tsconfig` 等の `private: true` パッケージは `workspace:*` で exact 参照している

- `[MUST]` 密結合パッケージ群（内部で exact バージョン参照し合うもの）を独立パッケージとしてリリースする場合、changesets の fixed グループ等で同一バージョンでの同時リリースを保証する
  - 根拠: Google 系 6 パッケージは fixed グループで常に同一バージョン（v2.1.19）を維持し、`workspace:*` 参照の整合性を保っている（`.changeset/config.json:10-19`）

- `[SHOULD]` セキュリティ脆弱性が報告された transitive dependency は、ルートの overrides でバージョン下限を引き上げて monorepo 全体に強制適用する
  - 根拠: langchainjs は protobufjs, form-data, tar, node-forge の最低バージョンを overrides で強制し、個別パッケージの対応漏れを防いでいる（`package.json:58-61`）

- `[SHOULD]` semver 範囲の上限と下限の両方で自動テストを実施し、依存バージョン範囲の互換性を検証する
  - 根拠: `dependency_range_tests/` で latest と lowest の両パターンを Docker コンテナ内でテストし、宣言した範囲の実際の互換性を保証している

- `[SHOULD]` メジャーバージョンの移行期には `"^old || ^new"` の OR 範囲で旧新両バージョンをサポートし、エコシステムの段階的移行を妨げない
  - 根拠: zod v3 から v4 への移行で `"^3.25.76 || ^4"` を採用し、ユーザーがどちらのバージョンでも利用可能にしている

- `[SHOULD]` 多数の optional 統合を持つパッケージでは、統合ライブラリを peerDependencies + `peerDependenciesMeta.optional: true` として宣言し、ユーザーのインストールサイズを最小化する
  - 根拠: `@langchain/community` は 100 以上のサードパーティ SDK を optional peerDependencies とし、必要な統合だけをインストールさせる設計にしている

- `[AVOID]` changesets で `onlyUpdatePeerDependentsWhenOutOfRange` を設定せずに core パッケージを頻繁にリリースすること — core の patch ごとに全 consumer パッケージの不要なリリースが連鎖する
  - 根拠: langchainjs はこのオプションを有効化し、core の patch リリースで 30 以上の provider パッケージが不要にバンプされることを防いでいる（`.changeset/config.json:25-27`）

## 適用チェックリスト

- [ ] monorepo のコアパッケージが singleton であることを要求する場合、ルートの overrides/resolutions で workspace 参照を強制しているか
- [ ] `workspace:^` と `workspace:*` を公開/非公開パッケージで意図的に使い分けているか
- [ ] 密結合パッケージ群に changesets の fixed グループ（または同等の仕組み）を設定しているか
- [ ] セキュリティ脆弱性のある transitive dependency を overrides で monorepo 全体に適用しているか
- [ ] 依存バージョン範囲の上限・下限の両方で自動テストを実施しているか
- [ ] メジャーバージョン移行期の依存に OR 範囲を使い、エコシステムの段階的移行を許容しているか
- [ ] 多数の optional 統合がある場合、peerDependencies + optional meta を活用してインストールサイズを制御しているか
- [ ] changesets の `onlyUpdatePeerDependentsWhenOutOfRange` を設定し、core の patch リリースによる不要な連鎖リリースを防いでいるか
