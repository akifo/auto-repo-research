# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

外部リポジトリを研究し、汎用的なコーディングプラクティスを構造化して蓄積するツール。蓄積されたプラクティスを Claude Code・Codex・Cursor などの AI ツールがコンテキストとして活用できる仕組みを提供する。

研究の目的は「そのリポジトリの機能を理解する」ことではなく、「そのコードベースで使われているプラクティスを抽出し、他のプロジェクトに応用する」こと。

研究フロー: **研究**（コーディングプラクティス・設計パターン・技法を横断的に分析） → **蓄積**（プラクティスを構造化して保存） → **活用**（AI ツールが参照）

## ディレクトリ構成

```
auto-repo-research/
├── templates/          # テンプレートファイル
│   ├── perspective.md  # 視点分析テンプレート
│   ├── overview.md     # リポ概要テンプレート
│   ├── rules.md        # 導出ルール集テンプレート
│   └── showcase.md     # showcase テンプレート
├── repos/              # リポジトリ研究データ
│   └── <org>/<repo>/
│       ├── meta.yaml   # メタデータ + 視点インデックス
│       ├── overview.md # リポ全体の概要サマリー
│       ├── rules.md    # 導出ルール集（AI コンテキスト用）
│       └── <視点>.md   # 視点ごとの分析ファイル
├── showcases/          # テーマ別の知見ドキュメント
│   └── <theme>_<name>.md
├── mcp-server/         # MCP サーバー（研究データを外部公開）
│   ├── src/
│   │   ├── index.ts    # エントリポイント
│   │   ├── types.ts    # 型定義
│   │   ├── data/       # データローダー・インデックス
│   │   └── tools/      # ツール実装（5つ）
│   ├── package.json
│   └── tsconfig.json
└── .claude/
    ├── agents/
    │   ├── perspective-writer.md
    │   └── synthesis-writer.md
    └── skills/
        ├── research/SKILL.md
        └── showcase/SKILL.md
```

## コマンド

- `/research <GitHub URL or org/repo>` — リポジトリを多角的に研究し、視点ごとの分析ファイルを自動生成する
- `/showcase <theme> <name>` — 研究結果から実用的な知見を抽出し、showcase ファイルを生成する
- `npm run docs:dev` — VitePress ローカルプレビュー
- `npm run docs:build` — サイトビルド
- `npm run fmt` — dprint でフォーマット
- `npm run fmt:check` — フォーマットチェック
- `npm run mcp:build` — MCP サーバーのビルド
- `npm run mcp:start` — MCP サーバーの起動（stdio トランスポート）

## テンプレート

新しい分析ファイルを作成する際は `templates/` 配下のテンプレートを参照すること:

- `templates/perspective.md` — 視点分析のフォーマット
- `templates/overview.md` — リポジトリ概要のフォーマット
- `templates/rules.md` — 導出ルール集のフォーマット
- `templates/showcase.md` — showcase のフォーマット

## 規約

- ファイル名はケバブケース（例: `error-handling.md`, `api-design.md`）
- コード引用には必ずファイルパスと行番号を記載する
- Good Patterns / Anti-Patterns にはコード例を必須とする
- repos/ 内のフォルダ名は GitHub の org/repo をそのまま使用する
- showcases/ は `<theme>_<name>.md` のフラットファイル形式
  - theme 候補: `pattern_`, `practice_`, `tool_`, `workflow_`, `claude_`
- `research-candidates.md` の Status カラムは `/research` 完了時に `済` へ更新する

## NEVER FORGET

- `repos/` 配下は蓄積データであり、削除禁止（`/research` 再実行時にユーザーが「最初からやり直す」を選択した場合のみ例外）
- `meta.yaml` は視点追加時に必ず更新すること
- perspective-writer agent はリポジトリのコードを変更しない（Read-only 分析）
