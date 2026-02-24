---
name: research
description: "外部リポジトリを多角的に研究し、視点ごとの分析ファイルを自動生成する。AI設定・開発規約の調査も含む。キーワード: research, 研究, リポジトリ分析"
version: 2026.02.14
user-invocable: true
argument-hint: "<GitHub URL or org/repo>"
allowed-tools: Bash, Read, Write, Glob, Grep, Task
---

# /research skill

外部リポジトリを多角的に研究し、構造化された分析ファイル群を自動生成する。
最終成果物として overview.md（俯瞰サマリー）、meta.yaml（インデックス）、rules.md（導出ルール集）を生成する。

## 実行フロー

### Step 1: 入力の正規化とリポジトリ取得

1. 引数を解析し `org` と `repo` を抽出する
   - `https://github.com/org/repo` → `org`, `repo`
   - `https://github.com/org/repo.git` → `org`, `repo`
   - `org/repo` → `org`, `repo`
2. `ghq list | grep <org>/<repo>` でローカルに存在するか確認
3. 存在しなければ `ghq get --shallow https://github.com/<org>/<repo>` で取得
4. 既にローカルに存在する場合は `git -C <repo_path> pull --ff-only` でリモート最新を取得する（失敗しても続行）
5. `ghq root` と合わせてローカルパスを特定: `$(ghq root)/github.com/<org>/<repo>`
6. 出力先 `repos/<org>/<repo>/` の存在を確認（既存研究がある場合は Resume 判定 → 後述）

### Step 2: リポジトリの初期調査

以下の情報を収集する（後のステップで使用）:

**基本メタデータ**（gh CLI で取得）:

```bash
gh api repos/<org>/<repo> --jq '{stargazers_count, language, license: .license.spdx_id, description}'
```

**ディレクトリ構成**:

- ルートの `ls` と主要ディレクトリの構造を確認

**リポジトリ規模の推定**:

```bash
# ソースファイル数と概算行数を取得（Step 3 の視点数決定に使用）
find <repo_path> -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.rs" -o -name "*.go" -o -name "*.java" \) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/vendor/*" -not -path "*/dist/*" | wc -l
```

- 規模分類: 小規模(~50ファイル) / 中規模(50-200) / 大規模(200+)

**技術スタック特定**:

- package.json, Cargo.toml, go.mod, pyproject.toml 等のプロジェクト定義ファイルを読む
- ビルドツール、テストフレームワーク、リンター設定を確認

**AI 設定ファイルの調査**:

- `CLAUDE.md`, `AGENTS.md`, `ARCHITECTURE.md`
- `.claude/` ディレクトリ（settings.json, commands/, agents/ 等）
- `.clinerules`, `.cursor/`, `.cursorrules`
- `.github/copilot-instructions.md`

**開発規約の調査**:

- `CONTRIBUTING.md`
- eslint / prettier / biome 設定ファイル
- `tsconfig.json`
- テストフレームワーク設定（jest.config, vitest.config 等）
- Git hooks（`.husky/`, `.lefthook.yml` 等）
- CI ワークフロー（`.github/workflows/`）

### Step 3: 視点の適応的生成

Step 2 の情報を基に、3フェーズで分析視点リストを生成する。

**規模に応じた視点数**:

- 小規模（~50ファイル）: 8-12 個
- 中規模（50-200ファイル）: 12-16 個
- 大規模（200+ファイル）: 16-20 個

**各視点には以下を付与する**:

- `name`: 視点名（ケバブケース）
- `wave`: `1`（コア）または `2`（拡張）
- `intent`: 1行の分析意図（perspective-writer に渡す。例: "ミドルウェアの合成パターンと実行順序制御の仕組みを明らかにする"）

---

#### Phase A: カタログからの選定

以下のカタログは参考リストであり、チェックリストではない。リポジトリに該当する視点のみを選ぶ。

**構造・設計**:

- `project-structure` — ディレクトリ構成・モジュール分割・パッケージ境界
- `architecture` — 全体アーキテクチャ・レイヤー構成・依存方向
- `design-philosophy` — 設計思想・哲学・技術選定の根拠
- `code-organization` — コード配置規約・命名規則・ファイル分割戦略

**型・抽象化**:

- `type-system-patterns` — 型レベルプログラミング・ジェネリクス活用・型安全性の保証手法
- `abstraction-patterns` — 抽象化レイヤーの設計・インターフェース境界・DI パターン
- `metaprogramming-techniques` — コード生成・マクロ・リフレクション・デコレータ活用

**API・合成**:

- `api-design-practices` — 公開 API 設計・シグネチャ設計・互換性維持
- `composition-patterns` — 関数合成・パイプライン・ビルダーパターン・チェイニング
- `middleware-composition` — ミドルウェアの合成・実行順序制御・コンテキスト伝播
- `hook-and-lifecycle-patterns` — フック設計・ライフサイクル管理・プラグインポイント
- `extensibility-mechanisms` — プラグインアーキテクチャ・拡張ポイント・アダプター

**信頼性**:

- `error-handling-idioms` — エラー型設計・伝播戦略・リカバリーパターン
- `testing-practices` — テスト戦略・フィクスチャ設計・モック手法・カバレッジ方針
- `security-practices` — 認証認可・入力検証・シークレット管理・脆弱性対策
- `logging-and-observability` — 構造化ログ・トレーシング・メトリクス・デバッグ支援

**性能・並行処理**:

- `performance-techniques` — ホットパス最適化・メモリ効率・レイジー評価・プーリング
- `concurrency-patterns` — 非同期制御・並列処理・ロック戦略・バックプレッシャー
- `streaming-patterns` — ストリーム処理・チャンク分割・イテレータプロトコル
- `tree-shaking-optimization` — バンドルサイズ最適化・副作用管理・コード分割

**データ・状態**:

- `state-management-patterns` — 状態モデル・イミュータビリティ・リアクティブ更新
- `schema-validation-patterns` — スキーマ定義・ランタイム検証・型導出
- `serialization-patterns` — シリアライズ/デシリアライズ・フォーマット変換・ワイヤープロトコル
- `persistence-patterns` — データ永続化・キャッシュ戦略・ストレージ抽象化
- `database-patterns` — クエリビルダー・マイグレーション・コネクション管理
- `configuration-patterns` — 設定ロード・環境変数・デフォルト値・バリデーション

**運用・協働**:

- `build-and-tooling` — ビルドパイプライン・ツールチェーン・開発体験
- `ci-cd` — CI/CD 設計・自動化ワークフロー・リリースプロセス
- `dependency-management` — 依存関係管理・バージョニング・モノレポ戦略
- `dev-conventions` — コーディング規約・レビュー文化・ドキュメンテーション慣行
- `migration-patterns` — スキーマ移行・API バージョン移行・破壊的変更の管理
- `versioning-strategy` — セマンティックバージョニング・チェンジログ・リリース方針
- `internationalization-patterns` — i18n/l10n・メッセージカタログ・ロケール管理

**条件付き**（該当する場合のみ）:

- `ai-settings` — AI 設定ファイルが存在する場合のみ
- `platform-abstraction` — 複数ランタイム/OS 対応がある場合のみ
- `adapter-implementation-patterns` — アダプター/ドライバー層が存在する場合のみ
- `cli-framework-patterns` — CLI ツールの場合のみ
- `domain-modeling` — 明確なドメインモデル層がある場合のみ

---

#### Phase B: 自律的な視点発見

カタログにない視点をリポジトリから自律的に発見する。

**B-1: シグナル検出テーブル**

Step 2 で収集したディレクトリ名・ファイルパターン・設定ファイルから、以下の要領で視点候補を検出する:

| シグナル例                            | 示唆される視点                                          |
| ------------------------------------- | ------------------------------------------------------- |
| `middleware/`, `plugins/`             | `middleware-composition`, `hook-and-lifecycle-patterns` |
| `__tests__/`, `fixtures/`, `*.test.*` | `testing-practices`（カタログ内）                       |
| `adapters/`, `drivers/`, `providers/` | `adapter-implementation-patterns`                       |
| `migrations/`, `schemas/`             | `migration-patterns`, `database-patterns`               |
| `i18n/`, `locales/`                   | `internationalization-patterns`                         |
| `streams/`, `iterators/`              | `streaming-patterns`                                    |
| `cache/`, `store/`                    | `persistence-patterns`, `state-management-patterns`     |
| `codegen/`, `generated/`              | `metaprogramming-techniques`                            |
| `wasm/`, `native/`                    | `platform-abstraction`                                  |
| 独自の大規模ディレクトリ              | 新規視点の候補（B-2 へ）                                |

シグナルが見つかってもカタログで既にカバー済みなら追加不要。

**B-2: ユニークネススキャン**

リポジトリを特徴づける独自パターンを 3-5 個列挙し、カタログ（Phase A）でカバーされていないものを新規視点として命名する。

- 「このリポジトリならではの技法は何か？」を問う
- 機能名ではなくプラクティス名で命名する（悪い例: `router-design` → 良い例: `pattern-matching-routing`）

---

#### Phase C: 組み立てと Wave 割り当て

Phase A + Phase B の候補を統合し、最終的な視点リストを組み立てる。

**Wave 1（コア視点）**: 5-8 個。リポジトリ理解の基盤:

- `project-structure`, `architecture`, `design-philosophy` は原則 Wave 1
- 残り 2-5 個はリポジトリの中核プラクティスから選定

**Wave 2（拡張視点）**: 残り。プラクティス指向の横断的分析。

**重複チェック**: スコープが大きく重なる視点は統合する（例: `composition-patterns` と `middleware-composition` が両方該当する場合、リポの実態に応じてどちらかに統合）。

**視点選定の基準**:

- 各視点はコードベースを横断的に分析する（特定の機能・モジュールに閉じない）
- 表面的な視点は避け、技術的に深い視点を選ぶ
- 「なぜ標準的な方法ではなくこの方法を選んだのか」が問えるテーマを優先する
- 他のプロジェクトに応用可能な汎用性のある固有パターンを優先する
- 視点名のリトマステスト: 「この視点名はリポジトリの機能名か、それともプラクティス名か？」→ 機能名なら再考する

### Step 4: meta.yaml と overview.md の初期生成

1. `repos/<org>/<repo>/` ディレクトリを作成
2. `meta.yaml` を以下の形式で生成:

```yaml
url: https://github.com/<org>/<repo>
stars: <number>
language: <lang>
license: <license>
description: "<description>"
analyzed_at: "<YYYY-MM-DD>"
local_path: <ghq root>/github.com/<org>/<repo>
scale: <small|medium|large>

perspectives:
  - name: <perspective-name>
    file: <perspective-name>.md
    wave: <1|2>
    intent: "<1行の分析意図>"
    summary: ""  # Synthesis Agent が更新
```

3. `overview.md` を `templates/overview.md` を基に初期版で生成（視点テーブルは仮）

### Step 5: Wave-based 並列分析（perspective-writer agent）

各視点について Task ツールで perspective-writer agent を **バックグラウンド起動** する。

#### 禁止事項（コンテキスト溢れ防止）

- **TaskOutput は絶対に使わない** — agent の結果をメインコンテキストに取り込むとコンテキスト上限に到達する
- **output_file を Read しない** — 同上の理由
- **agent の実行結果を確認する手段は Glob によるファイル存在確認のみ**

#### Wave 1: コア視点の分析

1. Wave 1 の全視点を `run_in_background: true` で一括起動する
2. `sleep 120`（2分待機）
3. `Glob` で `repos/<org>/<repo>/*.md` を確認し、Wave 1 のファイル存在を確認
4. **全ファイル揃っていれば** Wave 2 へ
5. **不足がある場合**: `sleep 60`（1分追加待機）→ 再度 Glob で確認
6. **それでも不足**: 未生成の視点のみリトライ（1回限り）→ `sleep 120` → 最終確認

#### Wave 2: 拡張視点の分析

1. Wave 2 の視点を **8個ずつバッチ** で `run_in_background: true` 起動
2. バッチ間に `sleep 5` を挟む（rate limit 対策）
3. 全バッチ起動後、`sleep 120`（2分待機）
4. Wave 1 と同様の完了確認・リトライ手順

#### 起動ルール

- 各 Task のプロンプトには以下を含める:
  - 視点名（perspective）
  - intent（分析意図）
  - org/repo
  - ローカルリポジトリのパス
  - 出力先ファイルパス（`repos/<org>/<repo>/<perspective>.md`）
  - テンプレートファイルのパス（`templates/perspective.md`）
  - Step 2 で収集した初期調査情報（技術スタック、ディレクトリ構成等）
- agent の subagent_type は `general-purpose` を使用する
- 各 agent のプロンプトの冒頭で `.claude/agents/perspective-writer.md` の内容を参照するよう指示する
- 「導出ルール」セクションと「適用チェックリスト」セクションが **必須** であることを明記する

**Task プロンプト例**:

```
あなたは perspective-writer agent です。
.claude/agents/perspective-writer.md の指示に従ってください。

## 入力情報
- perspective: architecture
- intent: レイヤー構成と依存関係の方向性を明らかにし、モジュール間の結合度を評価する
- org: honojs
- repo: hono
- repo_path: /Users/.../github.com/honojs/hono
- output_path: /Users/.../repos/honojs/hono/architecture.md
- template_path: /Users/.../templates/perspective.md

## リポジトリの初期調査情報
[Step 2 の結果をここに貼り付け]

## 分析の注意事項
- コードベース全体を横断して分析すること（特定のモジュールや機能に閉じない）
- 機能の実装解説ではなく、プラクティスの収集・体系化を行うこと
- 導出ルールは「このリポを知らない開発者が自分のコードに適用できる」汎用性を持たせること

templates/perspective.md を Read で読み、そのフォーマットに従って分析ファイルを output_path に Write で出力してください。
「導出ルール」セクション（[MUST]/[SHOULD]/[AVOID] 形式、最低3個）と「適用チェックリスト」セクションは必須です。
```

### Step 6: Synthesis Agent 起動

全視点の分析完了後、synthesis-writer agent を起動して最終成果物を生成する。

#### 禁止事項（コンテキスト溢れ防止）

- **main context では視点ファイルを一切読まない**
- Synthesis Agent に全てを委任し、結果は Glob によるファイル存在確認のみで検証する

#### 手順

1. Task ツールで synthesis-writer agent を `run_in_background: true` で起動する
   - subagent_type: `general-purpose`
   - プロンプトで `.claude/agents/synthesis-writer.md` の指示に従うよう指定
   - 入力: org, repo, research_dir, templates_dir, meta（基本メタデータ）
2. `sleep 120`（2分待機）
3. Glob で `repos/<org>/<repo>/rules.md` の存在を確認（rules.md が最後に生成されるため、これが存在すれば完了）
4. **存在しない場合**: `sleep 60` → 再度確認
5. **それでも存在しない場合**: リトライ（1回限り）

**Task プロンプト例**:

```
あなたは synthesis-writer agent です。
.claude/agents/synthesis-writer.md の指示に従ってください。

## 入力情報
- org: honojs
- repo: hono
- research_dir: /Users/.../repos/honojs/hono
- templates_dir: /Users/.../templates
- meta:
  - stars: 22000
  - language: TypeScript
  - license: MIT
  - description: "Web framework built on Web Standards"

全視点ファイルを読み取り、以下の3つの成果物を生成・更新してください:
1. meta.yaml — 全 perspectives[].summary を埋める
2. overview.md — サマリー、視点テーブル、注目知見を完成させる
3. rules.md — 全視点の導出ルールをカテゴリ別に統合して生成する
```

### Step 7: 完了報告と showcase 候補提案

1. Glob で最終的なファイル一覧を取得する
2. **showcase ギャップ分析**を実施する:
   - 生成された `rules.md` のカテゴリ一覧を抽出する
   - 既存の `showcases/` ファイルを Glob で列挙し、カバー済みのカテゴリを特定する
   - 既存 showcase でカバーされていないカテゴリ・ルールを「showcase 候補」として報告する
   - 他の研究済みリポ（`repos/` 配下）の `rules.md` を Grep で横断検索し、**複数リポで出現するパターン**をハイライトする（横断的な showcase の素材になる）
   - テーマバランス（tool_, workflow_, claude_ が不足傾向）を考慮し、適切なテーマを提案する
3. 完了報告を出力:
   - 分析視点の総数（Wave 1 / Wave 2 の内訳）
   - 未完了の視点があればその一覧
   - rules.md の生成状況
   - 出力ファイルの場所
   - showcase 候補リスト（3-5 件。各候補に `theme`, `name`, 1行の説明、出典リポを付与）
   - `/showcase` コマンドの案内（「研究結果から実用的な知見を抽出するには `/showcase <theme> <name>` を実行してください」）

## Resume サポート

Step 1 で既存研究が検出された場合、ユーザーに選択肢を提示する:

1. **最初からやり直す** — 既存の `repos/<org>/<repo>/` を削除し、Step 2 から全て再実行する
2. **続きから再開する** — 未完了部分のみ実行する（下記の判定ロジック）
3. **キャンセル** — 何もしない

**「続きから再開」の判定ロジック**:

1. `repos/<org>/<repo>/` 内の既存ファイルを Glob で列挙
2. `meta.yaml` を Read して視点リストを取得
3. 各視点の `.md` ファイルの存在を確認
4. **未完了の視点がある場合**: その視点のみ Step 5 で実行（wave 情報があればそれに従う）
5. **全視点完了済みで rules.md が未生成の場合**: Step 6（Synthesis Agent）のみ実行
6. **全て完了済みの場合**: ユーザーに報告する

## エラーハンドリング

- `ghq` が見つからない場合: エラーメッセージを出して中断
- `gh` が見つからない場合: メタデータ取得をスキップし、ローカル情報のみで続行
- リポジトリが存在しない場合: エラーメッセージを出して中断
- perspective-writer agent が失敗した場合: 他の視点は続行し、失敗を完了報告に記載
- synthesis-writer agent が失敗した場合: 完了報告に記載し、手動での `/research` 再実行で Resume サポートが適用されることを案内
