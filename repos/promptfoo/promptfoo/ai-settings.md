# AI Settings

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

promptfoo は 13 個の AGENTS.md ファイル、6 個の docs/agents/ ガイド、Claude Code スキル、CI 統合ワークフロー、そして PostToolUse フックを組み合わせた多層的な AI エージェント設定を構築している。ルートの CLAUDE.md は `@AGENTS.md` による委任パターンを採用し、各サブディレクトリの AGENTS.md がドメイン固有のコンテキストを提供する。合計 2,192 行（AGENTS.md 1,626 行 + docs/agents/ 566 行）の構造化されたエージェント向けドキュメントが、2,327 ファイル規模のコードベースで AI エージェントの品質を制御している。

## 背景にある原則

- **コンテキストの局所性（Locality of Context）**: エージェントがコードベースの特定領域で作業するとき、その領域に必要十分な知識だけをロードする。ルート AGENTS.md が全体構造を示し、「Read the relevant AGENTS.md when working in that directory」と明示的に指示する。これにより、トークンウィンドウを効率的に使い、関係のない情報でエージェントを混乱させない（`AGENTS.md:24`）

- **禁止事項の明示的宣言（Explicit Negation）**: 各 AGENTS.md は「何をすべきか」だけでなく「何をしてはいけないか」を NEVER/CRITICAL/FORBIDDEN として強調する。これは LLM の「頼まれたことをやろうとする」傾向に対する防御であり、破壊的操作（main への直接 push、キャッシュ削除、DB 削除、タイムアウト延長）を防ぐ（`AGENTS.md:143-148`, `test/AGENTS.md:26-29`）

- **段階的開示（Progressive Disclosure）**: ルートは概要テーブルとコマンドリスト、サブディレクトリ AGENTS.md はドメイン固有のパターンとアンチパターン、docs/agents/ は横断的関心事の詳細ガイドという 3 層構造。エージェントが必要に応じて深掘りできる（`AGENTS.md:270-280`）

- **AI をチームメンバーとして扱う（AI as Team Member）**: Contributing guide が AGENTS.md の更新を明示的に求め、CI に Claude Code Review を組み込み、PostToolUse フックで自動リント・フォーマットを強制する。AI エージェントは「外部ツール」ではなく「チームメンバー」として設計に組み込まれている（`site/docs/contributing.md:487-489`, `.claude/settings.json`）

## 実例と分析

### 委任パターン: CLAUDE.md → AGENTS.md

promptfoo では CLAUDE.md を `@AGENTS.md` の一行だけで構成し、実質的なガイダンスをすべて AGENTS.md に集約する。この設計により以下を実現している:

1. **ツール非依存性**: AGENTS.md は Claude Code 以外のエージェント（Codex、Cursor 等）でも読める汎用ファイル名
2. **責務の統一**: CLAUDE.md が複数存在する場合（ルート + 8 サブディレクトリ）、すべてが `@AGENTS.md` の一行であり、メンテナンス対象はAGENTS.md のみ

確認されたファイル:

- `/CLAUDE.md` → `@AGENTS.md`
- `/test/CLAUDE.md` → `@AGENTS.md`
- `/src/app/CLAUDE.md` → `@AGENTS.md`
- `/src/commands/CLAUDE.md` → `@AGENTS.md`
- `/src/providers/CLAUDE.md` → `@AGENTS.md`
- `/src/redteam/CLAUDE.md` → `@AGENTS.md`
- `/src/server/CLAUDE.md` → `@AGENTS.md`
- `/src/ui/CLAUDE.md` → `@AGENTS.md`
- `/site/CLAUDE.md` → `@AGENTS.md`
- `/examples/CLAUDE.md` → `@AGENTS.md`
- `/drizzle/CLAUDE.md` → `@AGENTS.md`

### 階層構造: 3 層のドキュメント体系

**第 1 層: ルート AGENTS.md（283 行）** — 全体マップ

ルートはプロジェクト構造テーブル、ビルドコマンド一覧、Git ワークフロー、コードスタイルガイドライン、デバッグ手順を含む。各サブディレクトリの AGENTS.md へのリンクテーブルと、docs/agents/ へのリンクテーブルを持つ。

**第 2 層: サブディレクトリ AGENTS.md（12 ファイル, 計 1,343 行）** — ドメイン固有

各ファイルは独立して読めるようにドメインの概要・テックスタック・ディレクトリ構造・具体的パターンとアンチパターン・テスト手順を含む。特に大きいのは:

- `test/AGENTS.md`（383 行）: テストフレームワーク、モッキング、Zustand ストアテスト、スモークテスト、フェイクタイマーの詳細パターン
- `src/ui/AGENTS.md`（176 行）: ターミナル UI のオプトイン設計、動的インポート、Vim ナビゲーション
- `src/app/AGENTS.md`（120 行）: React 19 パターン、Radix UI、Tailwind、callApi() の強制

**第 3 層: docs/agents/（6 ファイル, 計 566 行）** — 横断的関心事

ディレクトリに紐づかない横断的トピック（Git ワークフロー、PR 規約、ロギング、依存関係管理、Python、DB セキュリティ）を独立したドキュメントとして管理。特に `pr-conventions.md`（201 行）は「THE REDTEAM RULE」として、redteam 関連の変更には必ず `(redteam)` スコープを使うことを強制する。

### スキルによるタスク特化型ガイダンス

`.claude/skills/redteam-plugin-development/skill.md`（186 行）は、redteam プラグイン開発に特化した知識をスキルとしてパッケージ化している。AGENTS.md がディレクトリ単位の汎用ガイダンスであるのに対し、スキルはタスク単位の特化ガイダンスである。

### PostToolUse フックによる自動品質保証

`.claude/settings.json` で Edit/Write 操作後に自動的に `npm run l && npm run f`（lint + format）を実行する。エージェントが「リントを忘れる」問題を設定レベルで解消している。

### CI 統合: 2 つの Claude Code ワークフロー

**claude.yml** — `@claude` メンション駆動のインタラクティブモード。Issue やPR コメントで `@claude` と呼びかけるとエージェントが応答する。

**claude-code-review.yml** — PR の自動セキュリティレビュー。`pull_request_target` でトリガーされ、incremental/full の 2 モードでレビュースコープを決定する。レビュープロンプトはテンプレート化され（`.github/prompts/claude-code-review.md`）、HTML コメントマーカー `<!-- claude-code-review -->` で既存コメントを更新する冪等性パターンを使用。

### ドキュメント内の参照ファイルパターン

各 AGENTS.md は「このパターンに従え」ではなく「このファイルを参照しろ」と指示する。具体例:

- `test/AGENTS.md`: 「Reference files: `src/app/src/hooks/usePageMeta.test.ts`」
- `src/providers/AGENTS.md`: 「Reference implementations: `openai.ts`, `anthropic/index.ts`, `http.ts`」
- `src/commands/AGENTS.md`: 「See `src/commands/eval.ts` for the standard pattern」

これにより、AGENTS.md 自体が古くなっても参照先のコードが最新のパターンを示し続ける。

## コード例

```markdown
// CLAUDE.md:1
@AGENTS.md
```

```markdown
// AGENTS.md:9-24

## Project Structure

| Directory        | Purpose                       | Local Docs                |
| ---------------- | ----------------------------- | ------------------------- |
| `src/`           | Core library                  | -                         |
| `src/app/`       | Web UI (React 19/Vite/MUI v7) | `src/app/AGENTS.md`       |
| `src/commands/`  | CLI commands                  | `src/commands/AGENTS.md`  |
| `src/providers/` | LLM providers                 | `src/providers/AGENTS.md` |
| `src/redteam/`   | Security testing              | `src/redteam/AGENTS.md`   |
| `src/server/`    | Backend server                | `src/server/AGENTS.md`    |
| `test/`          | Tests (Vitest)                | `test/AGENTS.md`          |
| `site/`          | Docs site (Docusaurus)        | `site/AGENTS.md`          |
| `examples/`      | Example configs               | `examples/AGENTS.md`      |
| `drizzle/`       | DB migrations                 | `drizzle/AGENTS.md`       |

**Read the relevant AGENTS.md when working in that directory.**
```

```markdown
// AGENTS.md:268-280

## Additional Documentation

Read these when relevant to your task:

| Document                               | When to Read             |
| -------------------------------------- | ------------------------ |
| `docs/agents/pr-conventions.md`        | Creating pull requests   |
| `docs/agents/git-workflow.md`          | Git operations           |
| `docs/agents/dependency-management.md` | Updating packages        |
| `docs/agents/logging.md`               | Adding logging to code   |
| `docs/agents/python.md`                | Python providers/scripts |
| `docs/agents/database-security.md`     | Writing database queries |
```

```json
// .claude/settings.json:1-15
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "npm run l && npm run f"
          }
        ]
      }
    ]
  }
}
```

::: v-pre

```yaml
# .github/workflows/claude-code-review.yml:106-114
      - name: Run Claude Code Review
        uses: anthropics/claude-code-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: ${{ env.REVIEW_PROMPT }}
          show_full_output: true
          allowed_bots: use-tusk
          claude_args: '--model opus --max-turns 30 --allowed-tools "Bash(gh issue view:*),..."'
```

:::

```bash
# .github/scripts/determine-review-scope.sh:33-48
if [ "$EVENT_ACTION" = "synchronize" ] &&
  is_valid_sha "$EVENT_BEFORE" &&
  is_valid_sha "$EVENT_AFTER" &&
  ! is_merge_commit "$EVENT_AFTER"; then
  {
    echo "scope=incremental"
    echo "base_sha=$EVENT_BEFORE"
    echo "head_sha=$EVENT_AFTER"
  } >>"$GITHUB_OUTPUT"
else
  # Full review for: opened, ready_for_review, force push, or merge commits
  {
    echo "scope=full"
    echo "base_sha=$PR_BASE_SHA"
    echo "head_sha=$PR_HEAD_SHA"
  } >>"$GITHUB_OUTPUT"
fi
```

## パターンカタログ

- **Delegation Pattern（委任）** (分類: 構造)
  - 解決する問題: CLAUDE.md と AGENTS.md の内容が重複・乖離する
  - 適用条件: 複数の AI ツールが同一コードベースで動作する環境
  - コード例: `CLAUDE.md:1` — `@AGENTS.md`
  - 注意点: `@` 構文は Claude Code 固有。他ツールではシンボリックリンクやドキュメント生成パイプラインが必要

- **Hub-and-Spoke Documentation（ハブ・アンド・スポーク型ドキュメント）** (分類: 構造)
  - 解決する問題: 大規模コードベースで AI エージェントに適切なコンテキストを与える
  - 適用条件: ディレクトリごとに異なるドメイン知識が必要な中〜大規模プロジェクト
  - コード例: `AGENTS.md:9-24` — Project Structure テーブル
  - 注意点: ハブ（ルート）がスポーク（サブディレクトリ）のインデックスとして機能する必要がある

- **Idempotent Comment Update（冪等コメント更新）** (分類: 振る舞い)
  - 解決する問題: CI レビューが毎回新しいコメントを作成し PR が汚れる
  - 適用条件: AI エージェントが CI で定期的にコメントを投稿する場合
  - コード例: `.github/prompts/claude-code-review.md:113-140` — HTML マーカーで既存コメントを検索・更新
  - 注意点: マーカー文字列の一意性を確保すること

- **Reference File Pattern（参照ファイルパターン）** (分類: 振る舞い)
  - 解決する問題: AGENTS.md に書かれたパターンがコードの実態と乖離する
  - 適用条件: コードベースが頻繁に変更されるプロジェクト
  - コード例: `test/AGENTS.md:37-38` — 「Reference files: `src/app/src/hooks/usePageMeta.test.ts`」
  - 注意点: 参照先ファイルが削除・移動された場合にリンク切れが発生する

## Good Patterns

- **「When to Read」テーブルによる条件付きドキュメント読み込み**: ルート AGENTS.md は docs/agents/ の各ドキュメントに「When to Read」列を付けた参照テーブルを提供する。エージェントは現在のタスクに関連するドキュメントだけを選択的に読み込める。これはトークンウィンドウの効率的利用とコンテキストの精度向上を同時に実現する。

```markdown
// AGENTS.md:272-280
| Document | When to Read |
| `docs/agents/pr-conventions.md` | Creating pull requests |
| `docs/agents/git-workflow.md` | Git operations |
| `docs/agents/dependency-management.md` | Updating packages |
```

- **チェックリスト形式の完全性検証**: Provider 追加時の 7 項目チェックリスト（`src/providers/AGENTS.md:88-98`）は、エージェントが「何を忘れやすいか」を網羅的にリスト化している。verify コマンド例も添付されており、エージェントが自己検証できる。

```markdown
// src/providers/AGENTS.md:88-98
**All seven items are required** before a provider is complete:

1. Implement `ApiProvider` interface
2. Add env vars to `src/types/env.ts`
3. Add env vars to `src/envars.ts`
4. Add tests in `test/providers/`
5. Add docs in `site/docs/providers/<provider>.md`
6. Add entry to `site/docs/providers/index.md` table
7. Add example in `examples/<provider>/`
```

- **Do/Don't の対比構造**: `src/commands/AGENTS.md` は末尾に「Do / Don't」セクションを設け、一行で正しい行動と誤った行動を対比する。LLM が行動を選択する際の明確な判断基準になる。

```markdown
// src/commands/AGENTS.md:91-95
**Do:** Use logger, track telemetry, validate with Zod, set exitCode on errors
**Don't:** Use console, throw in action handlers, skip telemetry, use `process.exit()`
```

- **Anti-Pattern にコード例を付与**: `test/AGENTS.md` は Zustand ストアのモッキングや real timer 使用のアンチパターンに具体的なコード例を付けている。「何が悪いか」を抽象的に書くのではなく、エージェントが生成しそうなコードを示して「これを生成するな」と指示する。

```typescript
// test/AGENTS.md:159-174
// BAD: Mocking the store hook loses integration coverage
vi.mock("./useMyStore");
const mockUpdateItems = vi.fn();
(useMyStore as any).mockReturnValue({
  items: [],
  updateItems: mockUpdateItems,
});
```

## Anti-Patterns / 注意点

- **ドキュメントの分散による発見困難性**: 13 の AGENTS.md + 6 の docs/agents/ + 1 のスキル + 1 のレビュープロンプトにガイダンスが分散しており、人間の開発者が全体像を把握するのが難しい。エージェントにとっては「Read the relevant AGENTS.md」の指示があれば問題ないが、新しいコントリビューターにとってはオンボーディング障壁になり得る。

```markdown
// Bad: ドキュメントの場所が多すぎて発見できない
// AGENTS.md に書いてあるルール、docs/agents/ に書いてあるルール、
// .claude/skills/ に書いてあるルール、.github/prompts/ に書いてあるルール...

// Better: ルートの AGENTS.md にドキュメントマップを設置（promptfoo はこれを実施済み）
| Document | When to Read |
| `docs/agents/pr-conventions.md` | Creating pull requests |
```

- **スキルとAGENTS.md の責務境界の曖昧さ**: `src/redteam/plugins/AGENTS.md` は「See `.claude/skills/redteam-plugin-development/skill.md` for full standards」と委任するが、AGENTS.md 自体にもタグ参照表がある。どちらが正式な情報源かが不明確。

```markdown
// Bad: 同じ情報が 2 箇所に存在
// src/redteam/plugins/AGENTS.md にタグ参照表
// .claude/skills/redteam-plugin-development/skill.md にもタグ参照表

// Better: AGENTS.md は概要のみ、詳細はスキルに一本化し、重複を排除
```

- **CI レビュープロンプトの Allowed Tools 制限のハードコード**: `claude-code-review.yml` で `claude_args` に許可ツールをハードコードしている。ツールの追加・変更があるたびに YAML を編集する必要がある。

```yaml
# Bad: ツール制限がワークフロー定義にハードコードされている
claude_args: '--model opus --max-turns 30 --allowed-tools "Bash(gh issue view:*),Bash(gh search:*),..."'

# Better: 許可ツールリストを別ファイルまたは設定として管理
```

## 導出ルール

> このセクションは必須。最低 3 個のルールを記載すること。synthesis-writer が rules.md 生成時に参照する。
> リトマステスト: 「このリポジトリを知らない開発者が読んで、自分のコードに適用できるか？」— Yes でなければ抽象度が不足している。

- `[MUST]` ルート AI 設定ファイル（CLAUDE.md / AGENTS.md 等）にはプロジェクト構造テーブルを設置し、各ディレクトリと対応するローカルドキュメントのリンクを明示する。エージェントが自律的に必要なコンテキストを発見・ロードできるようにする
  - 根拠: promptfoo のルート AGENTS.md はディレクトリ→ローカル AGENTS.md の対応テーブルで「Read the relevant AGENTS.md when working in that directory」と指示し、エージェントのコンテキスト探索を構造化している

- `[MUST]` エージェントに対する禁止事項は NEVER/CRITICAL/FORBIDDEN のキーワードで明示的に宣言し、禁止コマンドの具体例をリスト化する。「〜すべきではない」ではなく「〜するな（NEVER）」と書く
  - 根拠: promptfoo は Git ワークフローで `git push origin main` 等の禁止コマンドを明示列挙し、テストでは「NEVER increase test timeouts」「NEVER use `.only()`」と具体的に禁止している。LLM は曖昧な表現を無視しやすい

- `[MUST]` AI 設定ドキュメントでパターンを示す際は、必ず参照ファイル（Reference file）のパスを添付する。エージェントが AGENTS.md の説明文だけでなく、実際のコードから最新のパターンを学習できるようにする
  - 根拠: promptfoo の AGENTS.md は「Reference files: `path/to/file`」「See `path/to/file` for the standard pattern」の形式で具体的な参照先を提示。AGENTS.md が古くなってもコード自体がの真実の情報源として機能する

- `[SHOULD]` 横断的関心事（Git ワークフロー、PR 規約、ロギング、セキュリティ等）はディレクトリ別の AGENTS.md とは別に独立したドキュメントとして管理し、ルートから「When to Read」条件付きで参照する
  - 根拠: promptfoo は docs/agents/ に 6 つの横断的ドキュメントを配置し、AGENTS.md からタスクベースの条件付き参照テーブルでリンクしている。これにより各 AGENTS.md の肥大化を防ぎ、必要なときだけ読み込むパターンを実現

- `[SHOULD]` PostToolUse フック等の自動化メカニズムを活用し、エージェントの「忘れやすい操作」（lint、format、型チェック等）を設定レベルで強制する。エージェントの指示遵守に依存しない
  - 根拠: promptfoo は `.claude/settings.json` の PostToolUse フックで Edit/Write 後に自動的に `npm run l && npm run f` を実行。エージェントが lint を忘れる問題をドキュメントの指示ではなくシステムレベルで解決

- `[SHOULD]` CI で AI エージェントがコメントを投稿する場合は、HTML マーカーによる冪等な更新パターンを使い、既存コメントを上書きする。コメントの増殖を防ぐ
  - 根拠: promptfoo のコードレビューワークフローは `<!-- claude-code-review -->` マーカーで既存コメントを検索・PATCH 更新し、毎回新規コメントを作成しない

- `[SHOULD]` ドメイン固有の複雑なタスク（プラグイン開発等）には AGENTS.md とは別にスキルファイルとしてパッケージ化し、タスク実行時にオンデマンドでロードする
  - 根拠: promptfoo は redteam プラグイン開発のタグ規約・rubric テンプレート・登録チェックリストを `.claude/skills/redteam-plugin-development/skill.md` として独立管理。AGENTS.md の肥大化を防ぎつつ、必要なときに深い知識を提供

- `[AVOID]` AI 設定ドキュメント内で同じ情報を複数箇所に書くこと。委任先が明確であれば概要だけを書き、詳細は 1 箇所に集約する
  - 根拠: promptfoo の `src/redteam/plugins/AGENTS.md` はスキルファイルへの委任とタグ参照表の両方を持ち、情報が重複している。メンテナンス時に片方だけ更新されるリスクがある

- `[AVOID]` AI 設定ファイルを「汎用的な開発ドキュメント」として書くこと。エージェントが実行可能なコマンド例、具体的な禁止事項、参照ファイルパスなど、アクショナブルな情報に絞る
  - 根拠: promptfoo の AGENTS.md は原則説明を最小限に抑え、コピー&ペースト可能なコマンド例、Do/Don't リスト、チェックリスト、参照ファイルパスで構成されている。LLM は抽象的な原則よりも具体的な指示に正確に従う

## 適用チェックリスト

- [ ] ルートの AI 設定ファイルにプロジェクト構造テーブル（ディレクトリ→ローカルドキュメント対応）を設置しているか
- [ ] 各主要ディレクトリに、そのドメイン固有のパターン・アンチパターン・参照ファイルを記載したローカル AI 設定ファイルを配置しているか
- [ ] 禁止事項を NEVER/CRITICAL キーワードで明示し、禁止コマンドの具体例をリスト化しているか
- [ ] パターン説明に参照ファイルパス（Reference file）を添付し、コードが真実の情報源として機能するようにしているか
- [ ] 横断的関心事（Git、PR、ロギング等）を独立ドキュメントに分離し、条件付き参照テーブルでリンクしているか
- [ ] PostToolUse フック等で lint/format を自動強制し、エージェントの指示忘れに依存しない仕組みを入れているか
- [ ] CI でAI コメントを投稿する場合、マーカーベースの冪等更新パターンを使っているか
- [ ] ドメイン固有の複雑なタスクをスキルファイルとして分離し、AGENTS.md の肥大化を防いでいるか
- [ ] AI 設定ドキュメント内の情報重複を排除し、各情報の正式な情報源を 1 箇所に集約しているか
- [ ] 新規コントリビューター向けに AGENTS.md の更新ルールをcontributing guide に記載しているか
