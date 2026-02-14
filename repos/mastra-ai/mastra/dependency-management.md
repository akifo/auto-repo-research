# dependency-management

> リポジトリ: mastra-ai/mastra
> 分析日: 2026-02-14

## 概要

mastra は 100 以上のワークスペースパッケージを持つ大規模 TypeScript モノレポで、pnpm v10 + Turborepo + Changesets による依存管理を採用している。注目に値するのは、pnpm catalog による横断的なバージョン統一、`npm:` エイリアスによるマルチバージョン共存戦略、カスタム Changeset CLI による peer dependency 自動更新、そして Renovate の精密なグルーピング戦略である。100+ パッケージ規模のモノレポで破綻しない依存管理の実践例として、汎用的な教訓が多い。

## 背景にある原則

- **ツールチェーンのバージョンは1箇所で管理すべき。なぜなら N 個のパッケージに同じバージョンが散在すると更新漏れが発生し、テスト結果の再現性が損なわれるから**: pnpm catalog で `vitest`, `typescript`, `@vitest/coverage-v8` 等を一元定義し、各パッケージは `"catalog:"` で参照する（`pnpm-workspace.yaml:24-29`）。112 ファイルで 375 箇所の `catalog:` 参照が存在する。

- **公開パッケージと内部パッケージの境界を命名規約で明示すべき。なぜなら Changesets の ignore/fixed 設定やパブリッシュ判定がパッケージ名に依存するから**: `@mastra/*` は公開パッケージ、`@internal/*` は非公開パッケージ。ディレクトリ名も `packages/_config`, `packages/_vendored` のようにアンダースコアプレフィックスで区別する。Changesets の ignore 設定はこの規約に依存している（`.changeset/config.json:14-20`）。

- **破壊的変更のバージョニングは自動化しつつもガードレールを設けるべき。なぜなら major バージョンバンプは下流への影響が甚大で、人間の判断が必要だから**: major changeset が PR に含まれる場合、CI が `!allow-major` コメントによる org メンバーの承認を要求する（`.github/workflows/major-version-check.yml`）。

- **マルチバージョン依存は npm エイリアスで共存させるべき。なぜなら同一パッケージの複数メジャーバージョンを同時にサポートする必要があるライブラリにとって、エイリアスは node_modules の衝突を回避する唯一の標準的手段だから**: `"@ai-sdk/openai-v5": "npm:@ai-sdk/openai@2.0.89"` のようにバージョン付きエイリアスで同一パッケージの v4/v5/v6 を共存させている（`packages/core/package.json:214-218`）。

## 実例と分析

### pnpm catalog によるバージョン一元管理

pnpm-workspace.yaml の `catalog:` セクションで開発ツールチェーンのバージョンを定義し、各パッケージの package.json では `"catalog:"` で参照する。

```yaml
# pnpm-workspace.yaml:24-29
catalog:
  '@microsoft/api-extractor': '^7.56.0'
  '@vitest/coverage-v8': 4.0.12
  '@vitest/ui': 4.0.12
  vitest: 4.0.16
  typescript: ^5.9.3
  zod: ^4.3.6
```

```json
// stores/pg/package.json:49-54
"@vitest/coverage-v8": "catalog:",
"@vitest/ui": "catalog:",
"eslint": "^9.37.0",
"tsup": "^8.5.1",
"typescript": "catalog:",
"vitest": "catalog:"
```

catalog に含めるのは「全パッケージで同一バージョンでなければテスト結果の一貫性が保証できないもの」に限定している。`eslint` や `tsup` のようなビルドツールは catalog に含めず、各パッケージで個別管理している。これは catalog の対象を「バージョン不一致がランタイムバグを引き起こすもの」に絞る意図的な判断である。

### workspace プロトコルによる内部依存の明示

内部パッケージ間の依存はすべて `"workspace:*"` で宣言する。一方、公開パッケージの peer dependency にはセマンティックレンジを使う。

```json
// stores/pg/package.json:43-46 (devDependencies - 開発時)
"@internal/lint": "workspace:*",
"@internal/storage-test-utils": "workspace:*",
"@internal/types-builder": "workspace:*",
"@mastra/core": "workspace:*",
```

```json
// stores/pg/package.json:56-58 (peerDependencies - 公開時)
"peerDependencies": {
  "@mastra/core": ">=1.4.0-0 <2.0.0-0"
}
```

devDependencies では `workspace:*` でローカルの最新コードをリンクし、peerDependencies では `>=X.Y.Z-0 <NEXT_MAJOR-0` 形式のレンジを使うことで、プレリリース版を含む互換範囲を明示する。`-0` サフィックスはセマンティックバージョニングのプレリリース識別子で、`>=1.4.0-0` は `1.4.0-alpha.0` も含む。

### Changesets の fixed グループと ignore パターン

```json
// .changeset/config.json:8
"fixed": [
  ["@mastra/core", "@mastra/server", "@mastra/deployer", "@mastra/deployer-cloud"],
  ["mastra", "create-mastra", "@internal/playground"]
],
```

`fixed` はグループ内のパッケージを常に同一バージョンでリリースする設定である。コアパッケージ群（core, server, deployer）を1つのバージョンで揃えることで、ユーザーはバージョン互換性を気にせず一括アップデートできる。

```json
// .changeset/config.json:14-20
"ignore": [
  "*",
  "@internal/*",
  "!mastra",
  "!create-mastra",
  "!@mastra/*",
  "!@internal/playground"
]
```

ignore は「デフォルトで全パッケージを無視し、公開対象のみホワイトリストで解除する」パターンを使っている。`*` で全体を ignore した後、`!@mastra/*` で公開パッケージのみ除外する。100+ パッケージの中から公開対象を列挙するより、この deny-by-default アプローチの方がメンテナンスコストが低い。

`"bumpVersionsWithWorkspaceProtocolOnly": true` により、`workspace:` プロトコルで依存しているパッケージのみバージョンバンプの影響を受ける。これは internal パッケージへの不要なバージョンバンプの波及を防ぐ。

### カスタム Changeset CLI による peer dependency 自動更新

標準の `changeset` コマンドの代わりに `packages/_changeset-cli` のカスタム CLI を使用する。このツールは changeset 作成時に、core パッケージのバージョンバンプに応じて全公開パッケージの peerDependencies を自動更新する。

```typescript
// packages/_changeset-cli/src/versions/updatePeerDependencies.ts:112-131
function collectDirectUpdates(versionBumps: VersionBumps, context: UpdateContext): Map<string, PackageJson> {
  const directUpdatedPackages = new Map<string, PackageJson>();

  for (const name of Object.keys(versionBumps)) {
    if (name === corePackage) continue;

    const pkgInfo = context.packagesByName.get(name);
    if (!pkgInfo) continue;

    if (pkgInfo.packageJson?.peerDependencies?.[corePackage]) {
      const cloned = JSON.parse(JSON.stringify(pkgInfo.packageJson));
      cloned.peerDependencies[corePackage] = `>=${context.nextCoreVersion}-0 <${context.nextMajorVersion}-0`;
      if (cloned.peerDependencies[corePackage] !== pkgInfo.packageJson.peerDependencies?.[corePackage]) {
        directUpdatedPackages.set(name, cloned);
      }
    }
  }

  return directUpdatedPackages;
}
```

直接バンプされたパッケージ（direct updates）と、core のバージョンバンプに連動して peerDependencies のみ更新されるパッケージ（indirect updates）を分離し、それぞれ別の changeset を生成する。これにより、CHANGELOG に「peer dependency 更新」が明確に記録される。

### Changesets パッチによるプレリリースサポート

```diff
// patches/@changesets__get-dependents-graph.patch
-    return new Range__default["default"](potentialRange);
+    return new Range__default["default"](potentialRange, {includePrerelease: true});
```

`@changesets/get-dependents-graph` にパッチを当て、semver レンジ解析にプレリリースを含めるようにしている。これにより `>=1.4.0-0 <2.0.0-0` のようなレンジを Changesets が正しく処理できる。公式ライブラリのエッジケースを patchedDependencies で対応する実践例。

### npm エイリアスによるマルチバージョン共存

AI SDK の v4/v5/v6 を同時にサポートするため、npm エイリアスで同一パッケージの異なるバージョンを並存させる。

```json
// packages/core/package.json:214-218
"@ai-sdk/provider-utils-v5": "npm:@ai-sdk/provider-utils@3.0.20",
"@ai-sdk/provider-utils-v6": "npm:@ai-sdk/provider-utils@4.0.0",
"@ai-sdk/provider-v5": "npm:@ai-sdk/provider@2.0.0",
"@ai-sdk/provider-v6": "npm:@ai-sdk/provider@3.0.0",
```

vendored パッケージ（`packages/_vendored/ai_v4`, `ai_v5`, `ai_v6`）は各バージョンの型定義を抽出・再エクスポートする内部パッケージで、`@internal/*` スコープで private にしている。同様に Zod の v3/v4 共存も実現している。

```json
// packages/schema-compat/package.json:96-97
"zod": "^3.25.76",
"zod-v4": "npm:zod@^4.0.0"
```

E2E テストでは `zod-v3` と `zod-v4` の専用ワークスペースを分離し、pnpm overrides でバージョンを固定している。

```json
// package.json:109-110 (root)
"client-js-e2e-tests-zod-v3>zod": "^3.24.0",
"client-js-e2e-tests-zod-v4>zod": "^4.3.5",
```

### Renovate の精密なグルーピング戦略

```json
// renovate.json:24-31
{
  "matchDatasources": ["npm"],
  "minimumReleaseAge": "3 days"
},
{
  "matchPackageNames": ["@types/node"],
  "matchUpdateTypes": ["major"],
  "enabled": false
},
```

全 npm パッケージに3日間の冷却期間（minimumReleaseAge）を設ける。初日のバグ修正リリースを待つ戦略である。`@types/node` の major 更新は無効化し、minor/patch のみ automerge する。

関連パッケージをグループ化し、PR の数を制御する。

```json
// renovate.json:82-91
{
  "groupName": "Mastra",
  "matchSourceUrls": ["https://github.com/mastra-ai/mastra"],
  "matchUpdateTypes": ["major", "minor", "patch"],
  "minimumReleaseAge": "0",
  "automerge": true
},
{
  "groupName": "E2E tests",
  "commitMessageTopic": "e2e-tests",
  "matchFileNames": ["e2e-tests/**/package.json"],
  "automerge": true
},
```

自パッケージ（mastra 自身）の更新は冷却期間なし + automerge。E2E テスト依存も automerge。低リスクの更新を自動化し、高リスクの更新（Schema の zod 等）は手動レビューを要求する。

Renovate PR に対しては changeset を自動生成するワークフロー（`sync_renovate-changesets.yml`）があり、Renovate がロックファイルを更新すると同時に changeset も生成される。

### パッケージマネージャの強制

```json
// package.json:81
"preinstall": "npx only-allow pnpm",
```

```json
// package.json:97
"engines": {
  "pnpm": ">=10.18.0"
},
```

```json
// package.json:118
"packageManager": "pnpm@10.27.0"
```

3重のガード（preinstall フック、engines、packageManager フィールド）でパッケージマネージャを pnpm に固定している。`only-allow` は npm/yarn での install を即座に失敗させる。

### Verdaccio による公開前の互換性検証

`e2e-tests/workspace-compat` ではローカル npm レジストリ（Verdaccio）を立ち上げ、パッケージを実際にパブリッシュしてからインストールテストを行う。workspace プロトコルが正しく解決されるか、peerDependencies の範囲が適切かを公開前に検証する仕組みである。

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: 外部ライブラリの複数バージョンに対する統一的なインターフェース提供
  - 適用条件: 主要な依存ライブラリのメジャーバージョン移行期間中
  - コード例: `packages/_vendored/ai_v4`, `ai_v5`, `ai_v6` が各バージョンの AI SDK を `@internal/ai-sdk-v{N}` として統一的に公開
  - 注意点: vendored パッケージが増えると保守コストが増大する。メジャーバージョン移行完了後は速やかに古いバージョンを削除する必要がある

## Good Patterns

- **Deny-by-default の Changesets ignore**: `"*"` で全パッケージを ignore し、公開対象のみ `!` で除外する。パッケージ追加時にデフォルトで changeset 対象外になるため、内部パッケージが誤って公開されるリスクを排除できる。

```json
// .changeset/config.json:14-20
"ignore": ["*", "@internal/*", "!mastra", "!create-mastra", "!@mastra/*", "!@internal/playground"]
```

- **catalog の対象を「ランタイム互換性に影響するもの」に限定**: vitest, typescript, zod など、バージョン不一致が挙動の差異を生むパッケージのみ catalog に入れ、eslint や tsup のようなビルドツールは各パッケージで個別管理する。catalog の肥大化を防ぎ、意図的なバージョン差異も許容する。

```yaml
# pnpm-workspace.yaml:24-29 (catalog に含めるもの)
catalog:
  vitest: 4.0.16
  typescript: ^5.9.3
  zod: ^4.3.6
```

```json
// 各パッケージで個別管理（catalog に含めないもの）
"eslint": "^9.37.0",
"tsup": "^8.5.1",
```

- **peerDependencies のレンジにプレリリース識別子を含める**: `>=1.4.0-0 <2.0.0-0` 形式で alpha/beta リリースとの互換性を保証する。`-0` はセマンティックバージョニングで最小のプレリリース識別子であるため、プレリリース版を含むすべてのバージョンにマッチする。

```json
// stores/pg/package.json:57
"@mastra/core": ">=1.4.0-0 <2.0.0-0"
```

## Anti-Patterns / 注意点

- **catalog の過剰適用**: catalog にビルドツール（tsup, rollup 等）まで含めると、特定パッケージだけ新しいバージョンを試す実験が困難になる。catalog は「全パッケージで統一すべきもの」に限定し、パッケージ固有のツールは個別管理する。

```json
// Bad: すべてを catalog に入れる
"tsup": "catalog:",
"rollup": "catalog:",
"eslint": "catalog:",
```

```json
// Better: ランタイム互換性に影響するもののみ catalog
"vitest": "catalog:",
"typescript": "catalog:",
"tsup": "^8.5.1",
"eslint": "^9.37.0",
```

- **resolutions / overrides の放置**: セキュリティ修正や互換性のために追加した resolutions を定期的に見直さないと、不要なオーバーライドが蓄積し、依存グラフの透明性が失われる。mastra では `cookie`, `ssri`, `jws` 等のセキュリティ関連 resolutions がルート package.json に存在するが、追加理由のコメントはない。

```json
// Bad: なぜ必要なのかコメントなしで放置
"resolutions": {
  "cookie": ">=1.1.1",
  "ssri": ">=6.0.2"
}
```

- **pnpm.overrides のスコープなし指定**: `"better-auth": "^1.4.18"` のようなスコープなし overrides はモノレポ全体に影響する。特定パッケージの問題を解決するために全体を上書きすると、他パッケージで予期しない挙動を引き起こす可能性がある。

```json
// Bad: スコープなしで全体に影響
"pnpm": { "overrides": { "some-dep": "^2.0.0" } }
```

```json
// Better: 影響範囲を限定
"pnpm": { "overrides": { "affected-package>some-dep": "^2.0.0" } }
```

## 導出ルール

- `[MUST]` モノレポのテストランナー・型チェッカー・スキーマライブラリは pnpm catalog 等の一元管理機構でバージョンを統一する
  - 根拠: mastra では vitest, typescript, zod を catalog で統一し、112 ファイル 375 箇所の `catalog:` 参照でバージョン不一致を構造的に排除している

- `[MUST]` Changesets の ignore 設定は deny-by-default（`"*"` で全体を ignore し、公開対象のみ `!` で除外）にする
  - 根拠: `.changeset/config.json` で `["*", "@internal/*", "!@mastra/*"]` パターンを使い、新規パッケージ追加時のデフォルトを「非公開」にしている

- `[SHOULD]` 同一パッケージの複数メジャーバージョンを同時にサポートする場合、npm エイリアス（`"pkg-v5": "npm:pkg@5.x"`）で node_modules 内に共存させる
  - 根拠: `packages/core/package.json` で AI SDK の v4/v5/v6 を `npm:` エイリアスで並存させ、各バージョンの型定義を vendored パッケージで再エクスポートしている

- `[SHOULD]` peerDependencies のバージョンレンジにはプレリリース識別子（`-0`）を含め、`>=X.Y.Z-0 <NEXT_MAJOR-0` 形式で指定する
  - 根拠: 100+ パッケージが `"@mastra/core": ">=1.4.0-0 <2.0.0-0"` 形式を採用し、alpha/beta リリースとの互換性を保証している

- `[SHOULD]` Renovate の依存更新には冷却期間（`minimumReleaseAge`）を設け、低リスク更新のみ automerge する
  - 根拠: `renovate.json` で全 npm パッケージに3日間の冷却期間を設定し、typescript/eslint/vitest は automerge、zod (Schema) は手動レビューを要求している

- `[SHOULD]` 内部パッケージと公開パッケージをスコープ名（`@internal/*` vs `@mastra/*`）とディレクトリプレフィックス（`_` prefix）で視覚的に区別する
  - 根拠: `packages/_config`（`@internal/lint`）、`packages/_vendored`（`@internal/ai-sdk-v4`）等が private: true で、Changesets の ignore と連動している

- `[SHOULD]` コアパッケージのバージョンバンプに連動する peerDependencies 更新は自動化する（カスタム CLI, CI スクリプト等）
  - 根拠: mastra は `packages/_changeset-cli` で core のバンプ時に全依存パッケージの peerDependencies 範囲を自動更新し、changeset も自動生成している

- `[AVOID]` resolutions / overrides をコメントや理由なしで追加し放置すること
  - 根拠: ルート package.json に `cookie`, `ssri`, `jws` 等の override が存在し、追加理由がコード上に記載されていないため、不要になった際の判断が困難になる

## 適用チェックリスト

- [ ] テストランナー・型チェッカー等のバージョンを pnpm catalog（または類似の一元管理機構）で統一しているか
- [ ] catalog の対象がランタイム互換性に影響するものに限定されており、ビルドツールが混入していないか
- [ ] 内部パッケージと公開パッケージをスコープ名・ディレクトリ名で明確に区別しているか
- [ ] Changesets の ignore 設定が deny-by-default になっているか（新規パッケージ追加時に誤公開されないか）
- [ ] peerDependencies のレンジがプレリリース版を含む形式（`-0` サフィックス）になっているか
- [ ] 複数メジャーバージョンのサポートが必要な依存に npm エイリアスを使っているか
- [ ] Renovate（または Dependabot）の更新ルールにリスクレベル別のグルーピングと automerge 設定があるか
- [ ] resolutions / overrides に追加理由と削除条件がコメントされているか
- [ ] パッケージマネージャが `only-allow` + `engines` + `packageManager` の3重ガードで固定されているか
- [ ] コアパッケージのバージョンバンプ時に、依存パッケージの peerDependencies が自動更新される仕組みがあるか
- [ ] e2e テストで peerDependencies の互換性範囲が実際に動作することを検証しているか
