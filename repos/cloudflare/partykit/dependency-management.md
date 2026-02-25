# dependency-management

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

cloudflare/partykit は npm workspaces を使ったモノレポで、15 のパッケージと 13 の fixture を管理している。注目すべきは、内部パッケージ間の依存を peerDependencies で宣言する戦略、sherif によるモノレポ一貫性の自動検証、changesets による慎重なバージョニング（`onlyUpdatePeerDependentsWhenOutOfRange` の活用）、そして `pkg-pr-new` による PR 時プレリリースの 4 層構造である。コアパッケージ `partyserver` が唯一の runtime dependency として `nanoid` のみを持つ極端なミニマリズムも特徴的である。

## 背景にある原則

- **コアの依存ゼロ志向**: ランタイム環境（Cloudflare Workers）の制約とバンドルサイズの最小化のために、コアパッケージの dependencies は最小限にする。`partyserver` は `nanoid` のみ、`partysocket` は `event-target-polyfill` のみ。依存が少ないほど破壊的変更のリスクが減り、消費者のバンドルが軽くなる（`partyserver/package.json:41-42`）
- **内部結合は peerDependencies で表現する**: 拡張パッケージ（y-partyserver, partysub, hono-party 等）はコアを直接バンドルせず、消費者に委ねる。これにより、モノレポ内でバージョン競合が起きず、消費者のプロジェクトでも重複インストールを防ぐ（`y-partyserver/package.json:59-63`）
- **ビルド順序の明示的制御**: npm workspaces の暗黙的な依存解決に頼らず、ルートの build スクリプトで `-w` フラグを使って順序を明示する。これにより、依存グラフが変わっても予期しないビルド失敗が起きない（`package.json:14`）
- **一貫性は自動検証で保証する**: sherif による依存バージョンの一貫性チェックと、カスタム `check-exports.ts` スクリプトによる exports フィールドの整合性検証を CI で必須にする。手動の目視確認に頼らない（`package.json:19`, `scripts/check-exports.ts`）

## 実例と分析

### peerDependencies による内部パッケージ結合

partykit のパッケージ群は、コアとの関係を 3 つのパターンに分類できる。

**パターン 1: peerDependencies + devDependencies の二重宣言（拡張パッケージ）**

y-partyserver, partysub, hono-party, partysync が該当する。peerDependencies でレンジを広くとり（`>=0.2.0 <1.0.0`）、devDependencies で開発・テスト用の具体バージョン（`^0.3.1`）を指定する。

```jsonc
// packages/y-partyserver/package.json:55-63
"devDependencies": {
  "partyserver": "^0.3.1"    // 開発・テスト用
},
"peerDependencies": {
  "partyserver": ">=0.2.0 <1.0.0"  // 消費者向けレンジ
}
```

**パターン 2: dependencies としての直接依存（密結合パッケージ）**

partywhen がこのパターンで、`partyserver` を dependencies に含める。`class Scheduler extends Server` と直接継承しており、バージョン互換性を消費者に委ねられない密結合であるため、この判断は合理的である。

```jsonc
// packages/partywhen/package.json:31-33
"dependencies": {
  "cron-parser": "^5.5.0",
  "partyserver": "^0.3.1"
}
```

**パターン 3: 完全独立パッケージ**

partysocket がこのパターンで、サーバーサイドパッケージへの依存を一切持たない。クライアント SDK として独立して使えることを保証している。react は optional peerDependency として宣言される。

```jsonc
// packages/partysocket/package.json:90-97
"peerDependencies": {
  "react": ">=17"
},
"peerDependenciesMeta": {
  "react": { "optional": true }
}
```

### overrides によるモノレポ全体のバージョン統一

ルートの `overrides` で `@types/node`, `esbuild`, `react`, `react-dom`, `prosemirror-model` の 5 つを固定している。これは npm workspaces で複数パッケージが異なるバージョンを要求した際の重複・非互換を防ぐ。

```jsonc
// package.json:48-54
"overrides": {
  "@types/node": "25.3.0",
  "esbuild": "0.25.0",
  "prosemirror-model": "1.22.2",
  "react": "19.2.3",
  "react-dom": "19.2.3"
}
```

特に `@types/node` をピン留めしているのは、型定義のバージョン違いによる TypeScript コンパイルエラーを防ぐためと推測される。

### ビルドスクリプトの順序制御

ルートの build スクリプトは、`-w` フラグで明示的にビルド順序を制御している。

```jsonc
// package.json:14
"build": "npm run build -w partyserver -w partysocket -w y-partyserver -w partysub -w partyfn -w partysync -w partywhen -w partytracks -w hono-party && tsx scripts/check-exports.ts"
```

`partyserver` と `partysocket` を先頭に配置し、それらに依存する拡張パッケージが後に続く。ビルド後に `check-exports.ts` が全パッケージの exports フィールドを検証し、参照先ファイルの存在を保証する。

### Changesets の設定戦略

```jsonc
// .changeset/config.json:8-16
"fixed": [],
"linked": [],
"access": "public",
"updateInternalDependencies": "patch",
"ignore": ["@partyserver/fixture-*"],
"___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH": {
  "onlyUpdatePeerDependentsWhenOutOfRange": true
}
```

重要なポイント:

- `fixed` / `linked` は空配列: 各パッケージが独立したバージョンを持つ
- `ignore` で fixture パッケージを除外: テスト用パッケージは publish しない
- `onlyUpdatePeerDependentsWhenOutOfRange`: peerDependencies の範囲内であれば、依存先のパッチリリースで依存元を再リリースしない。これにより無駄なバージョンバンプの連鎖を防ぐ
- `updateInternalDependencies: "patch"`: 内部依存のバージョンはパッチレベルで追従する

### changeset-version.sh による package-lock.json 同期

```bash
# .github/changeset-version.sh:6-12
npx changeset version
npm install
```

`changeset version` が package.json のバージョンを更新した後、`npm install` で package-lock.json を同期する。changesets の既知の問題（lock ファイルが更新されない）へのワークアラウンド。

### pkg-pr-new による PR プレリリース

```yaml
# .github/workflows/pkg-pr-new.yml:19-20
- run: npm run build
- run: npx pkg-pr-new publish './packages/partyserver' './packages/partysocket' ...
```

すべての PR で公開パッケージのプレリリースが自動生成される。消費者は PR 段階で変更をテストできる。

### fixture パッケージの命名規約

```jsonc
// fixtures/chat/package.json:2
"name": "@partyserver/fixture-chat",
"private": true
```

fixture は `@partyserver/fixture-*` のスコープ付きパッケージ名 + `private: true` で宣言。changesets の `ignore` パターンと一致させることで、publish 対象から確実に除外する。

### trustedDependencies の明示

```jsonc
// package.json:56-59
"trustedDependencies": [
  "core-js",
  "esbuild",
  "workerd"
]
```

postinstall スクリプトを持つ依存を明示的にホワイトリスト化し、不要なスクリプト実行を防ぐ。

## パターンカタログ

- **Facade Pattern** (構造)
  - 解決する問題: コアパッケージの内部実装を拡張パッケージが直接参照すると結合度が高くなる
  - 適用条件: モノレポ内でコアパッケージと拡張パッケージが分離されている場合
  - コード例: `packages/y-partyserver/src/server/index.ts:5` — `Server` クラスを import して `withYjs` mixin を構築
  - 注意点: partywhen のように `extends Server` で密結合する場合は peerDependencies ではなく直接 dependencies にする判断が必要

## Good Patterns

- **peerDependencies レンジの二層設計**: peerDependencies で広いレンジ（`>=0.2.0 <1.0.0`）、devDependencies で具体バージョン（`^0.3.1`）を宣言する。開発時は最新版でテストしつつ、消費者には広い互換性を保証する。

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

- **ビルド後 exports 検証**: ビルドパイプラインの最終ステップで、全パッケージの `exports` フィールドが参照するファイルの存在を検証する。壊れたパッケージのリリースを自動的に防ぐ。

```typescript
// scripts/check-exports.ts:50-63
const filePaths = extractFilePaths(packageJson.exports);
for (const filePath of filePaths) {
  if (!filePath.startsWith(".")) continue;
  const fullPath = resolve(packageDir, filePath);
  if (!existsSync(fullPath)) {
    missing.push(filePath);
  }
}
```

- **optional peerDependencies でフレームワーク対応**: React バインディングを持つパッケージ（partysocket）で、react を optional peerDependency として宣言し、React なしでも使えることを保証する。

```jsonc
// packages/partysocket/package.json:92-97
"peerDependencies": { "react": ">=17" },
"peerDependenciesMeta": { "react": { "optional": true } }
```

## Anti-Patterns / 注意点

- **暗黙的ビルド順序依存**: npm workspaces は依存グラフに基づくビルド順序の自動解決を保証しない。`npm run build --workspaces` だけに頼ると、パッケージ A が パッケージ B のビルド成果物を参照する場合にビルド失敗する。

```jsonc
// Bad: 順序が不定
"build": "npm run build --workspaces"

// Better: 明示的に順序指定
"build": "npm run build -w partyserver -w partysocket -w y-partyserver ..."
```

- **changeset version 後の lock ファイル不整合**: `changeset version` は package.json を更新するが、package-lock.json は更新しない。CI でこのまま commit すると lock ファイルとの不整合が発生する。

```bash
# Bad: lock ファイルが古いまま
npx changeset version

# Better: 明示的に同期（partykit の実装）
npx changeset version
npm install
```

## 導出ルール

- `[MUST]` モノレポの拡張パッケージがコアパッケージを使う場合、peerDependencies で広いレンジ、devDependencies で具体バージョンを二重宣言する
  - 根拠: partykit の 4 パッケージ（y-partyserver, partysub, hono-party, partysync）すべてがこのパターンを採用し、消費者のバージョン重複を防いでいる
- `[MUST]` モノレポのビルドスクリプトで、パッケージ間の依存順序を明示的に指定する（`-w` フラグ等）
  - 根拠: partykit は `npm run build -w partyserver -w partysocket ...` で順序を固定し、暗黙的な依存解決の非決定性を排除している（`package.json:14`）
- `[MUST]` changesets の `version` コマンド実行後に `npm install`（または相当する lock ファイル同期コマンド）を実行する
  - 根拠: partykit は `.github/changeset-version.sh` で明示的にワークアラウンドしている。changesets の既知の問題（#421）
- `[SHOULD]` モノレポのルート package.json で `overrides`（npm）/ `resolutions`（yarn）を使い、型定義パッケージやビルドツールのバージョンを全パッケージで統一する
  - 根拠: partykit は `@types/node`, `esbuild`, `react`, `react-dom` 等を overrides で固定し、バージョン不整合による型エラーやビルド差異を防いでいる（`package.json:48-54`）
- `[SHOULD]` ビルドパイプラインの最終ステップで、パッケージの `exports` フィールドが参照する全ファイルの存在を検証する
  - 根拠: partykit の `check-exports.ts` がビルド後に全パッケージをスキャンし、壊れた exports でのリリースを自動防止している（`scripts/check-exports.ts`）
- `[SHOULD]` テスト・サンプル用の内部パッケージは `private: true` + スコープ付き命名（例: `@org/fixture-*`）にし、changesets の `ignore` で publish 対象から除外する
  - 根拠: partykit は `@partyserver/fixture-*` 命名 + `ignore: ["@partyserver/fixture-*"]` で完全に分離している（`.changeset/config.json:13`）
- `[SHOULD]` コアパッケージのランタイム依存を最小化し、可能な限りゼロ依存を目指す
  - 根拠: partyserver は nanoid のみ、partysocket は event-target-polyfill のみを依存とし、消費者のバンドルサイズと依存リスクを最小化している
- `[AVOID]` 拡張パッケージがコアを `extends` で継承する場合に peerDependencies にする — 密結合では dependencies に含めるべき
  - 根拠: partywhen は `class Scheduler extends Server` のため partyserver を dependencies に含める判断をしている。peerDependencies にすると、消費者がバージョンミスマッチで実行時エラーに遭遇するリスクがある（`packages/partywhen/package.json:31-33`）

## 適用チェックリスト

- [ ] モノレポのルートに `overrides`（npm）/ `resolutions`（yarn/pnpm）を設定し、型定義・ビルドツール・フレームワークのバージョンを統一しているか
- [ ] 拡張パッケージのコアへの依存が peerDependencies（広レンジ）+ devDependencies（具体バージョン）の二重宣言になっているか
- [ ] 密結合（継承等）の場合は dependencies に含める判断をしているか
- [ ] ビルドスクリプトでパッケージの依存順序を明示的に指定しているか
- [ ] changesets（またはリリースツール）実行後に lock ファイルの同期を行っているか
- [ ] テスト・fixture パッケージが publish 対象から除外されているか（`private: true` + `ignore` 設定）
- [ ] ビルド後に exports フィールドの整合性を検証するスクリプトがあるか
- [ ] `trustedDependencies` で postinstall スクリプトを持つ依存を明示的にホワイトリスト化しているか
- [ ] sherif 等のモノレポ一貫性チェックツールを CI で実行しているか
