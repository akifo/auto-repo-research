# Claude: SKILL.md とドキュメントの npm 同梱パターン

> 出典: [repos/vercel/chat/ai-settings.md](../repos/vercel/chat/ai-settings.md)、vercel/ai、openclaw/openclaw
> カテゴリ: claude

## 概要

SKILL.md ファイルとドキュメントを npm パッケージに同梱し、AI エージェント（Claude Code、Codex 等）が `node_modules/` から直接参照できるようにする設計パターン。ドキュメントサイトの URL をエージェントに渡すだけではリアルタイムにフェッチできない場合があるが、パッケージに同梱すればオフラインでもローカルファイルとして即座にアクセスできる。vercel/chat、vercel/ai、openclaw/openclaw の3つのリポジトリで共通して採用されている。

## 背景・文脈

AI エージェントがライブラリの使い方を学ぶには、型定義（`.d.ts`）だけでは不十分な場合が多い。概念の説明、クイックスタート、エラー対処法といったドキュメントが必要になる。しかし Web サイトからのフェッチは遅延やアクセス制限の問題がある。

この3つのリポジトリは、モノレポ内のドキュメントソースをビルド時に npm パッケージへコピーし、`package.json` の `files` フィールドで配布対象に含めるという共通のアプローチを取っている。さらに SKILL.md で「まず `node_modules/` のドキュメントを読め」とエージェントに明示的に指示することで、古い学習データではなく最新のドキュメントを参照させる仕組みを確立している。

## 実装パターン

### パターン 1: ビルドスクリプトでドキュメントをコピー（vercel/chat）

```json
// vercel/chat — packages/chat/package.json:23-28,33
"files": [
  "dist",
  "docs"
],
"scripts": {
  "build": "pnpm clean && tsup && cp -r ../../apps/docs/content/docs ./docs",
  "clean": "rm -rf dist docs"
}
```

ビルドコマンド内で `cp -r` によりモノレポのドキュメントディレクトリをパッケージ内にコピーする。`clean` スクリプトでビルド生成物として扱い、`.gitignore` で除外する。

### パターン 2: prepack/postpack フックでドキュメントをコピー（vercel/ai）

```json
// vercel/ai — packages/ai/package.json:11-14,24-25,29-31
"files": [
  "dist/**/*",
  "docs/**/*",
  "src",
  ...
],
"directories": {
  "doc": "./docs"
},
"scripts": {
  "clean": "del-cli dist docs *.tsbuildinfo",
  "prepack": "cp -r ../../content/docs ./docs",
  "postpack": "del-cli docs"
}
```

`prepack` フックで `npm pack` / `npm publish` 時に自動的にドキュメントをコピーし、`postpack` でクリーンアップする。ビルドとパッケージングの関心を分離できる。

プロバイダパッケージでも同じパターンが適用されている。

```json
// vercel/ai — packages/openai/package.json:23-24
"prepack": "mkdir -p docs && cp ../../content/providers/01-ai-sdk-providers/03-openai.mdx ./docs/",
"postpack": "del-cli docs"
```

### パターン 3: skills/ ディレクトリごとパッケージに同梱（openclaw/openclaw）

```json
// openclaw/openclaw — package.json:11-22
"files": [
  "CHANGELOG.md",
  "LICENSE",
  "openclaw.mjs",
  ...
  "dist/",
  "docs/",
  "extensions/",
  "skills/"
]
```

openclaw は `skills/` ディレクトリ全体を `files` フィールドに含め、npm パッケージ経由で SKILL.md とその参照リソース（`references/`、`scripts/`、`assets/`）を一括配布する。50以上のスキルがこの仕組みで配布されている。

### SKILL.md からのドキュメント参照指示

```markdown
<!-- vercel/ai — skills/use-ai-sdk/SKILL.md:6-10 -->

## Prerequisites

Before searching docs, check if `node_modules/ai/docs/` exists. If not, install **only** the `ai`
package using the project's package manager (e.g., `pnpm add ai`).
```

```markdown
<!-- vercel/chat — skills/chat/SKILL.md:17-24 -->

## Critical: Read the bundled docs

The `chat` package ships with full documentation in `node_modules/chat/docs/` and TypeScript
source types. **Always read these before writing code:**

node_modules/chat/docs/ # Full documentation (MDX files)
node_modules/chat/dist/ # Built types (.d.ts files)
```

## Good Example

SKILL.md でエージェントの内部知識を明示的に否定し、同梱ドキュメントを唯一の情報源として指定する。

```markdown
<!-- vercel/ai — skills/use-ai-sdk/SKILL.md:12-22 -->

## Critical: Do Not Trust Internal Knowledge

Everything you know about the AI SDK is outdated or wrong. Your training data contains
obsolete APIs, deprecated patterns, and incorrect usage.

**When working with the AI SDK:**

1. Ensure `ai` package is installed (see Prerequisites)
2. Search `node_modules/ai/docs/` and `node_modules/ai/src/` for current APIs
3. If not found locally, search ai-sdk.dev documentation (instructions below)
4. Never rely on memory - always verify against source code or docs
```

このパターンが有効な理由:

- AI エージェントの学習データは常に古い。同梱ドキュメントは `npm install` 時点の最新版
- `node_modules/` パスを明示することで、エージェントがドキュメントサイトをフェッチする遅延を回避
- 「内部知識を信用するな」という否定形の指示で、エージェントのハルシネーションを抑制

## Bad Example

```markdown
<!-- Bad: ドキュメント URL だけを渡す -->

## Documentation

Read the docs at https://example.com/docs before writing code.
```

この方法の問題点:

- AI エージェントが URL をフェッチできない環境がある（サンドボックス、ネットワーク制限等）
- フェッチできてもレスポンスが遅い、またはコンテンツが大きすぎてコンテキストに収まらない
- バージョンとドキュメントの対応が保証されない（URL は常に最新版を指す）

```markdown
<!-- Bad: ドキュメントを同梱するがエージェントに伝えない -->
<!-- package.json に "docs" を含めているが、SKILL.md や CLAUDE.md でパスを明示しない -->
```

同梱しただけではエージェントは `node_modules/` 内のドキュメントの存在に気づかない。SKILL.md で明示的にパスを指示する必要がある。

## 適用ガイド

### どのような状況で使うべきか

- npm パッケージとして配布するライブラリ/SDK を開発しており、AI エージェントでの利用を想定する場合
- ドキュメントサイトとパッケージのドキュメントソースがモノレポ内で同居している場合
- ライブラリの API が頻繁に変わり、AI の学習データが追いつかない場合

### 導入手順

1. **`package.json` の `files` に `docs` を追加**
   ```json
   "files": ["dist", "docs"]
   ```
2. **ビルドまたは prepack でドキュメントをコピーするスクリプトを追加**
   - ビルド時コピー: `"build": "tsup && cp -r ../docs ./docs"` (vercel/chat 方式)
   - prepack フック: `"prepack": "cp -r ../docs ./docs"` (vercel/ai 方式)
3. **`.gitignore` にコピー先を追加** (ビルド生成物のため)
4. **SKILL.md で `node_modules/<pkg>/docs/` パスを明示的に記載**
5. **「内部知識を信用するな」の指示を SKILL.md に含める** (任意だが推奨)

### カスタマイズポイント

- **ドキュメント形式**: MDX、Markdown、HTML のいずれでも可。AI エージェントは Markdown 系が最も読みやすい
- **コピータイミング**: `build` 内でコピーすると開発中も参照可能。`prepack` でコピーするとビルドとパッケージングを分離できる
- **スキルの Progressive Disclosure**: openclaw の設計に倣い、SKILL.md 本体は軽量に保ち、詳細は `references/` に分離すると、コンテキストウィンドウを節約できる（`skills/skill-creator/SKILL.md:113-119`）

### 3リポジトリの比較

| 観点                   | vercel/chat                       | vercel/ai                         | openclaw/openclaw        |
| ---------------------- | --------------------------------- | --------------------------------- | ------------------------ |
| コピー方式             | build スクリプト内                | prepack/postpack フック           | ソースをそのまま同梱     |
| 同梱対象               | `docs/`                           | `docs/**/*`, `src`                | `docs/`, `skills/`       |
| ドキュメントソース     | `apps/docs/content/docs/`         | `content/docs/`                   | `docs/` (直接)           |
| SKILL.md の役割        | SDK 利用者向けガイド              | SDK 利用者向けガイド              | 機能別スキルガイド       |
| ドキュメント参照の明示 | "Critical: Read the bundled docs" | "Do Not Trust Internal Knowledge" | description で用途を記述 |

## 参考

- [repos/vercel/chat/ai-settings.md](../repos/vercel/chat/ai-settings.md) -- 元の分析（CLAUDE.md / SKILL.md / .cursor/plans の設計）
- `vercel/chat` `packages/chat/package.json` -- docs 同梱の build スクリプト
- `vercel/ai` `packages/ai/package.json` -- prepack/postpack による docs 同梱
- `vercel/ai` `skills/use-ai-sdk/SKILL.md` -- "Do Not Trust Internal Knowledge" パターン
- `openclaw/openclaw` `package.json` -- skills/ と docs/ の一括同梱
- `openclaw/openclaw` `skills/skill-creator/SKILL.md` -- Progressive Disclosure 設計原則
