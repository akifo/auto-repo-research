# auto-repo-research

外部リポジトリを研究し、そこから得たプログラミングの知見を蓄積する場所。
研究プロセスを自動化し、蓄積された知見を Claude Code・Codex・Cursor などの AI ツールがコンテキストとして活用できる仕組みを提供する。

## コンセプト

1. **研究** — 対象リポジトリのコード構造・設計パターン・技術選定を分析する
2. **蓄積** — 得られた知見を構造化して保存する
3. **活用** — AI ツールが必要な時に知見を参照し、開発に活かす

## 使い方

### リポジトリを研究する

```
/research <GitHub URL or org/repo>
```

指定したリポジトリを多角的に分析し、以下の成果物を自動生成する:

- **視点ファイル群** (`<視点>.md`) — 各視点ごとの詳細分析（設計思想・コード例・パターン・導出ルール）
- **overview.md** — リポジトリ全体の俯瞰サマリー
- **meta.yaml** — メタデータと視点インデックス
- **rules.md** — 全視点の導出ルールを統合した AI コンテキスト用ルール集

### 知見を showcase にまとめる

```
/showcase <theme> <name>
```

研究結果からテーマ別に実用的な知見を抽出し、showcase ファイルを生成する。

## アーキテクチャ

```
/research 実行フロー:

Step 1: 入力の正規化 + リポジトリ取得（ghq）
Step 2: リポジトリの初期調査（技術スタック・規模推定・AI設定）
Step 3: 視点の適応的生成（規模に応じて 8-20 個、Wave 1/2 に分類）
Step 4: meta.yaml + overview.md 初期生成
Step 5: Wave-based 並列分析
   Wave 1: コア視点（5-8個）→ 完了確認
   Wave 2: 拡張視点（残り）→ 完了確認
Step 6: Synthesis Agent 起動
   → overview.md 完成、meta.yaml 全更新、rules.md 生成
Step 7: 完了報告 + /showcase 案内
```

### エージェント構成

| エージェント | 役割 |
|------------|------|
| **perspective-writer** | 特定の視点にフォーカスしてリポジトリを分析し、構造化された分析ファイルを生成 |
| **synthesis-writer** | 全視点を横断的に読み取り、overview.md / meta.yaml / rules.md を生成 |

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
└── .claude/
    ├── agents/
    │   ├── perspective-writer.md
    │   └── synthesis-writer.md
    └── skills/
        ├── research/SKILL.md
        └── showcase/SKILL.md
```

## MCP サーバー

蓄積した研究データを他プロジェクトの Claude Code から直接参照できる MCP サーバーを同梱している。

### セットアップ

```bash
cd mcp-server && npm install && npm run build
```

### Claude Code への接続

`~/.claude/settings.json` に以下を追加:

```json
{
  "mcpServers": {
    "repo-research": {
      "command": "node",
      "args": ["/absolute/path/to/auto-repo-research/mcp-server/dist/index.js"]
    }
  }
}
```

### 提供ツール

| ツール | 説明 | 主要パラメータ |
|--------|------|--------------|
| `list_research` | 研究済みリポジトリと showcase の一覧 | なし |
| `get_rules` | 特定リポジトリのルール取得 | `repo` (必須), `category?`, `priority?` |
| `get_showcase` | showcase ドキュメント取得 | `name` (必須) |
| `search_rules` | キーワードで全リポジトリ横断検索 | `query` (必須), `priority?` |
| `suggest_rules` | プロジェクトの技術スタックに合ったルールを自動提案 | `language?`, `framework?`, `keywords?`, `format?` |

### 使用例

他プロジェクトの Claude Code から:

- 「このプロジェクトに合ったルールを提案して」→ `suggest_rules` が技術スタックに合致するルールをスコアリングして返す
- 「ミドルウェア設計のベストプラクティスを教えて」→ `search_rules` でキーワード横断検索
- 「Hono のエラーハンドリングルールを見せて」→ `get_rules` でリポ指定＋カテゴリフィルタ

## 前提ツール

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — スキル実行環境
- [ghq](https://github.com/x-motemen/ghq) — リポジトリのローカル取得
- [gh](https://cli.github.com/) — GitHub メタデータ取得（オプション）
