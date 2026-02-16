# CI/CD

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

valibot の CI/CD パイプラインは、pnpm モノレポ内の複数パッケージ（library, i18n, to-json-schema, zod-to-valibot, website）に対して、パッケージ単位で並列に lint/test/format チェックを実行し、リリース時には NPM と JSR の二系統に同時パブリッシュする構成をとっている。注目すべき点は、(1) 再利用可能な composite action による環境セットアップの一元管理、(2) `workflow_call` を用いた CI ワークフローの publish ワークフローからの再利用、(3) pkg.pr.new による PR 単位のプレビューパブリッシュ、(4) `--provenance` フラグによるサプライチェーンセキュリティの確保である。

## 背景にある原則

- **環境の一元管理**: モノレポ内の全ジョブが同一の composite action（`.github/actions/environment/action.yml`）を通じて Node.js, pnpm, Deno のセットアップと依存インストール・ビルドを行う。環境構築の差異をゼロにすることで「ローカルでは動くが CI では動かない」問題を排除し、ランタイム追加（Deno）も一箇所の変更で全ジョブに波及させられる。
- **CI をゲートとしたパブリッシュ**: publish ワークフローは `uses: ./.github/workflows/ci.yml`（`workflow_call`）で CI 全体を前提条件として実行する。CI が通らなければどのパッケージもパブリッシュされない。これにより「テストが壊れた状態でリリースされる」リスクをワークフローレベルで排除している。
- **パブリッシュの独立性と耐障害性**: 各パッケージの NPM/JSR パブリッシュジョブは互いに独立しており、`continue-on-error: true`（NPM 側）により一つのパッケージのパブリッシュ失敗が他を巻き込まない。バージョンが未変更のパッケージは自然に失敗するが、ワークフロー全体は継続する。
- **最小権限の原則**: 各ジョブに `permissions` を明示的に設定し、`id-token: write` はパブリッシュジョブのみ、`contents: read` は読み取り専用ジョブに限定している。デフォルトの広い権限に頼らない。

## 実例と分析

### Composite Action による環境セットアップの共通化

モノレポの各ジョブは、環境構築を `.github/actions/environment/action.yml` に集約している。この composite action は pnpm, Node.js, Deno の 3 ランタイムをセットアップし、pnpm install の後にライブラリ群のビルドまで行う。

重要なのは、ビルドステップまで composite action に含めている点である。library, to-json-schema, zod-to-valibot のビルド成果物は他パッケージのテストや lint で必要になるため、「環境セットアップ = ビルド済み状態」を保証している。

```yaml
# .github/actions/environment/action.yml:1-43
name: Setup environment
description: Setup environment with Node.js, Deno and pnpm

runs:
  using: composite
  steps:
    - name: Setup pnpm
      uses: pnpm/action-setup@v4
      with:
        version: 9
        run_install: false

    - name: Setup Node.js
      uses: actions/setup-node@v6
      with:
        node-version: 22
        registry-url: 'https://registry.npmjs.org'
        cache: pnpm

    - name: Setup Deno
      uses: denoland/setup-deno@v2
      with:
        deno-version: v2.5.6

    - name: Install dependencies
      shell: bash
      run: pnpm install

    - name: Build library
      shell: bash
      run: pnpm build
      working-directory: library

    - name: Build to-json-schema
      shell: bash
      run: pnpm build
      working-directory: packages/to-json-schema

    - name: Build zod-to-valibot
      shell: bash
      run: pnpm build
      working-directory: codemod/zod-to-valibot
```

`registry-url: 'https://registry.npmjs.org'` を setup-node に設定しておくことで、後続の publish ジョブで `NODE_AUTH_TOKEN` 環境変数を渡すだけでレジストリ認証が機能する。

### workflow_call による CI ワークフローの再利用

CI ワークフローは 3 つのトリガーを持つ。

```yaml
# .github/workflows/ci.yml:3-7
on:
  push:
    branches: [main]
  pull_request:
  workflow_call:
```

`workflow_call` により、publish ワークフローから CI を「サブワークフロー」として呼び出せる。

```yaml
# .github/workflows/publish.yml:9-11
jobs:
  default_ci:
    name: Run default CI of repository
    uses: ./.github/workflows/ci.yml
```

この設計により、CI の定義を二重管理する必要がなく、publish 時に実行される品質チェックが PR 時と完全に同一であることが保証される。

### パッケージ単位の並列ジョブ設計

CI ワークフローでは、パッケージごと・チェック種別ごとに独立したジョブを定義している。

| ジョブ名                  | 対象           | チェック内容              | needs   |
| ------------------------- | -------------- | ------------------------- | ------- |
| `install`                 | 全体           | 環境セットアップ          | -       |
| `library_prettier`        | library        | Prettier                  | install |
| `library_eslint`          | library        | ESLint + tsc + deno check | install |
| `library_vitest`          | library        | Vitest                    | install |
| `library_preview`         | library        | pkg.pr.new プレビュー     | install |
| `to_json_schema_prettier` | to-json-schema | Prettier                  | install |
| `to_json_schema_eslint`   | to-json-schema | ESLint                    | install |
| `to_json_schema_vitest`   | to-json-schema | Vitest                    | install |
| `website_prettier`        | website        | Prettier                  | install |
| `website_eslint`          | website        | ESLint                    | install |
| `zod_to_valibot_vitest`   | zod-to-valibot | Vitest                    | (なし)  |

`install` ジョブは「ゲート」として機能し、依存パッケージのビルドが成功してから後続ジョブを開始する。一方、`zod_to_valibot_vitest` のみ `needs` を持たず独立実行される。これは codemod パッケージが他のパッケージに依存しない性質を反映した設計判断と考えられるが、composite action 内でビルドは行われるため依存関係自体はない。

### pkg.pr.new による PR プレビューパブリッシュ

PR ごとに npm パッケージのプレビュー版を自動パブリッシュする仕組みを CI に組み込んでいる。

```yaml
# .github/workflows/ci.yml:19-30
  library_preview:
    name: Publish library via pkg.pr.new
    needs: install
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
      - name: Setup environment
        uses: ./.github/actions/environment
      - name: Publish library
        run: pnpx pkg-pr-new publish --compact --comment=update --pnpm
        working-directory: library
```

`--compact` でコメントを簡潔にし、`--comment=update` で既存コメントを更新（新規コメントを追加しない）する。PR レビュー時にライブラリの変更を実際にインストールして検証できる。

### デュアルレジストリパブリッシュ（NPM + JSR）

publish ワークフローでは、各パッケージを NPM と JSR の両方に並列でパブリッシュする。

```yaml
# .github/workflows/publish.yml:13-47 (library の例)
  library_npm:
    name: Publish library to NPM
    needs: default_ci
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
      - name: Setup environment
        uses: ./.github/actions/environment
      - name: Build library
        run: pnpm build
        working-directory: library
      - name: Publish library
        run: pnpm publish --provenance --access public --no-git-checks
        working-directory: library
        continue-on-error: true
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

  library_jsr:
    name: Publish library to JSR
    needs: default_ci
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
      - name: Publish library
        run: npx jsr publish
        working-directory: library
```

設計上の注目点:

1. **NPM パブリッシュに `--provenance` を付与**: OIDC トークン（`id-token: write`）を使い、ビルドの出所を暗号的に証明する。`npm audit signatures` で検証可能になる。
2. **NPM 側のみ `continue-on-error: true`**: バージョン未変更時やネットワーク障害時にワークフロー全体が失敗しない。モノレポでは一部パッケージだけバージョンが上がるケースが頻繁に発生するため、この設計は合理的。
3. **JSR パブリッシュにはビルド不要**: JSR は TypeScript ソースを直接パブリッシュするため、`jsr.json` の `exports` でエントリポイントを指定するだけでよい（library_jsr は composite action すら呼ばない）。
4. **i18n は `--allow-dirty` が必要**: JSR パブリッシュ前にビルドスクリプト（`build.jsr`）がファイルを生成するため、ワーキングツリーが dirty になる。`--allow-dirty` でこれを許容している。

### リリーストリガーとフォールバック

```yaml
# .github/workflows/publish.yml:3-6
on:
  release:
    types: [published]
  workflow_dispatch:
```

GitHub Release の作成をトリガーにしつつ、`workflow_dispatch` で手動実行も可能にしている。自動化しながらも人間が介入できる余地を残す堅実な設計。

### lint コマンドの多層構成

library の lint コマンドは 3 つのチェックを直列実行する。

```json
// library/package.json:48
"lint": "eslint \"src/**/*.ts*\" && tsc --noEmit && deno check ./src/index.ts"
```

ESLint（静的解析） + TypeScript コンパイラ（型チェック） + Deno（Deno 互換性チェック）の三段構成。マルチランタイム対応ライブラリならではのプラクティスで、composite action に Deno セットアップを含めている理由でもある。

## Good Patterns

- **Composite Action で環境構築を DRY にする**: 10 個以上のジョブが同一の環境セットアップを使い回す。ランタイム追加やバージョン変更が一箇所の変更で完結する。`action.yml` にビルドまで含めることで「セットアップ後のビルド忘れ」も防止している。

- **workflow_call で CI を publish のゲートにする**: CI ワークフロー自体を `workflow_call` で再利用可能にし、publish ワークフローから呼び出す。CI の定義が一つしかないため「PR では通るが publish 時には別のチェックが走る」ような齟齬が発生しない。

```yaml
# .github/workflows/ci.yml:7
  workflow_call:

# .github/workflows/publish.yml:9-11
  default_ci:
    uses: ./.github/workflows/ci.yml
```

- **continue-on-error でモノレポパブリッシュの部分失敗を許容する**: バージョン未変更のパッケージは `npm publish` が 403 で失敗するが、`continue-on-error: true` によりワークフロー全体は成功扱いになる。モノレポでの「全パッケージ一括リリースワークフロー」を実現する実践的なテクニック。

- **pkg.pr.new で PR にプレビューパッケージを提供する**: `--compact --comment=update` オプションにより、PR コメントが溢れることなく最新のプレビュー URL が常に更新される。レビュアーが実際にインストールして動作確認できる。

- **NPM publish に --provenance を付与する**: OIDC ベースの来歴証明（provenance attestation）を有効にし、パッケージがどの CI ワークフローからビルド・パブリッシュされたかを暗号的に検証可能にしている。

## Anti-Patterns / 注意点

- **ジョブ間でキャッシュを共有しない並列実行**: 各ジョブが独立して checkout + setup を行うため、pnpm install と依存ビルドがジョブ数分繰り返される。`install` ジョブを `needs` で待っているが、GitHub Actions のジョブ間ではファイルシステムは共有されないため、実際にはキャッシュヒットに頼っている。pnpm のキャッシュが効くため大きな問題にはなっていないが、ビルド成果物の共有には `actions/upload-artifact` / `actions/download-artifact` の活用が考えられる。

```yaml
# Bad: 各ジョブで独立にビルドが走る（キャッシュで軽減されるが非効率）
jobs:
  install:
    steps:
      - uses: ./.github/actions/environment  # install + build
  library_eslint:
    needs: install
    steps:
      - uses: ./.github/actions/environment  # 再度 install + build

# Better: ビルド成果物を artifact で共有
jobs:
  install:
    steps:
      - uses: ./.github/actions/environment
      - uses: actions/upload-artifact@v4
        with:
          name: build-output
          path: library/dist
  library_eslint:
    needs: install
    steps:
      - uses: actions/download-artifact@v4
```

- **JSR パブリッシュの `--allow-dirty` の必要性**: i18n パッケージは JSR 向けビルドがワーキングツリーにファイルを生成するため `--allow-dirty` が必要になる。ビルド出力を別ディレクトリに分離するか、`.gitignore` 相当の除外設定を見直すことでクリーンなパブリッシュが可能になる場合がある。

## 導出ルール

- `[MUST]` パブリッシュワークフローでは CI ワークフロー全体の成功を前提条件にする
  - 根拠: valibot は `workflow_call` で CI を publish の前段に組み込み、テスト・lint が通らなければどのパッケージもパブリッシュされない設計を採用している（`.github/workflows/publish.yml:9-11`）。
- `[MUST]` NPM パブリッシュには `--provenance` フラグを付与し、ジョブに `id-token: write` 権限を設定する
  - 根拠: valibot の全 NPM パブリッシュジョブが `--provenance --access public` を使用し、OIDC トークンによるサプライチェーン証明を実装している（`.github/workflows/publish.yml:29,65,106`）。
- `[SHOULD]` モノレポの CI 環境セットアップは composite action に集約し、ランタイムセットアップからビルドまでを一括で行う
  - 根拠: valibot は Node.js, pnpm, Deno のセットアップと 3 パッケージのビルドを 1 つの composite action に集約し、10 以上のジョブで再利用している（`.github/actions/environment/action.yml`）。
- `[SHOULD]` モノレポの一括パブリッシュでは、個別パッケージの publish ステップに `continue-on-error: true` を設定する
  - 根拠: バージョン未変更のパッケージは `npm publish` が失敗するが、`continue-on-error` により他パッケージのパブリッシュに影響しない（`.github/workflows/publish.yml:31,67,108`）。
- `[SHOULD]` CI ワークフローに `workflow_call` トリガーを追加し、他ワークフローから再利用可能にする
  - 根拠: valibot は CI ワークフローを publish ワークフローから `uses:` で呼び出すことで、品質チェックの定義を一元化している（`.github/workflows/ci.yml:7`）。
- `[SHOULD]` PR には pkg.pr.new などのプレビューパブリッシュを導入し、変更のインストール検証を可能にする
  - 根拠: valibot は CI に `pnpx pkg-pr-new publish --compact --comment=update` を組み込み、全 PR でライブラリのプレビュー版を自動配布している（`.github/workflows/ci.yml:29`）。
- `[AVOID]` CI ジョブにデフォルトの広い権限を与える — 各ジョブに必要最小限の `permissions` を明示的に設定する
  - 根拠: valibot は codemod ジョブに `permissions: contents: read` を、パブリッシュジョブに `contents: read` + `id-token: write` を個別に設定している（`.github/workflows/ci.yml:139-140`, `.github/workflows/publish.yml:17-19`）。

## 適用チェックリスト

- [ ] CI のランタイムセットアップ・依存インストール・ビルドを composite action に集約しているか
- [ ] CI ワークフローに `workflow_call` トリガーを追加し、publish ワークフローから再利用しているか
- [ ] パブリッシュワークフローが CI 成功を前提条件（`needs`）にしているか
- [ ] NPM パブリッシュに `--provenance` を付与し、`id-token: write` 権限を設定しているか
- [ ] モノレポの場合、パッケージ単位のパブリッシュに `continue-on-error: true` を設定しているか
- [ ] 各ジョブに最小限の `permissions` を明示的に設定しているか
- [ ] PR でライブラリの変更をインストール検証できる仕組み（pkg.pr.new 等）を導入しているか
- [ ] リリーストリガー（`release: types: [published]`）に加え、`workflow_dispatch` でフォールバック手動実行を可能にしているか
- [ ] マルチランタイム対応の場合、lint に全ランタイムの互換性チェックを含めているか
