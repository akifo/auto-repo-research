# dev-conventions

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

コミット規約・PRワークフロー・コードスタイル・開発規約を横断的に分析した。openclaw/openclaw は193K Stars超の大規模TypeScriptモノレポであり、AI エージェント（Claude, Codex, Copilot 等）と人間の開発者が同時並行でコードを変更する「マルチエージェント開発」を前提とした開発規約を構築している点が特筆に値する。コミットツール `scripts/committer` によるスコープドステージング、3段階PR パイプライン（review > prepare > merge）、LOC 上限の自動検査、AI 生成PRの明示的受け入れポリシーなど、再現性と安全性を両立する仕組みが高密度に実装されている。

## 背景にある原則

- **ステージング汚染の排除**: マルチエージェント環境では複数の変更が同時進行するため、`git add .` のような広範なステージングは他のエージェントの作業を巻き込む危険がある。スコープドコミット（明示的ファイル指定のみ許可）を強制することで、コミットの原子性を保証する。根拠: `scripts/committer` が `.` と `node_modules` を明示的に拒否する（`committer:44-59`）。
- **信頼ゼロの PR レビュー**: 外部PRのコードは信頼しない前提で品質ゲートを設計する。「提出されたコードが低品質なら無視して最適な解決策を実装する」という方針は、AI 生成コードを含む多様な品質のPRを受け入れるために合理的。根拠: PR_WORKFLOW.md の "Treat PRs as reports first, code second"。
- **ファイルサイズの定量管理**: 「小さく保て」を精神論で終わらせず、`check:loc` スクリプトで500行上限を自動検査する。ガイドラインとして ~700 LOC まで許容しつつ、スクリプトは500行を閾値にする二段構えで実用性を確保している。根拠: `scripts/check-ts-max-loc.ts` と AGENTS.md の "Aim to keep files under ~700 LOC"。
- **冪等な品質ゲート**: lint/format の差分が意味的変更でなければ自動解決し、人間に確認を求めない。これにより AI エージェントが lint churn で停止せず、本質的な作業に集中できる。根拠: AGENTS.md の "Lint/format churn" セクション。

## 実例と分析

### スコープドコミットツール

`scripts/committer` はリポジトリ全体のコミット作法を統一するゲートキーパーである。以下の安全策が実装されている:

1. **ワイルドカード禁止**: `.` をファイル引数として渡すとエラー終了する
2. **node_modules 除外**: パス内に `node_modules` を含むファイルを一律拒否
3. **ステージング初期化**: コミット前に `git restore --staged :/` で全ステージングを解除し、指定ファイルだけを再ステージング
4. **ロックファイル自動解決**: `--force` フラグで `index.lock` の自動削除に対応

これにより、AI エージェントが `git add -A` で無関係なファイルをコミットする事故を構造的に防止している。

### 3段階PRパイプライン

PR処理は `review-pr` > `prepare-pr` > `merge-pr` の3ステップに分離され、各ステップ間で人間のメンテナが判断を挟む設計になっている。

- **review-pr**: PRの正当性・セキュリティリスク・テストカバレッジを評価し、構造化された `.local/review.md` と `.local/review.json` を生成
- **prepare-pr**: rebase、コード修正、品質ゲート通過、force-with-lease によるプッシュ
- **merge-pr**: CI チェック確認、squash merge、co-author トレーラー付与、ワークツリークリーンアップ

各ステップは `scripts/pr` という単一スクリプトにサブコマンドとして実装され、`.local/` ディレクトリにアーティファクトを保存して状態を引き継ぐ。

### コミットメッセージ規約

Conventional Commits に準拠しつつ、独自の拡張がある:

- スコープ付き: `fix(gateway): allowlist system.run params`
- スコープなし: `refactor: split minimax-cn provider`
- 外部コントリビューター: `fix: wire minimax-api-key-cn onboarding (#15191) (thanks @liuy)`
- 破壊的変更: `chore!: remove moltbot legacy state/config support`

PR squash merge 時には `Co-authored-by:` トレーラーで原著者とレビューアの両方をクレジットする。

### マルチエージェント安全規約

AGENTS.md には AI エージェント同士の衝突を防ぐための明示的なルールが列挙されている:

- `git stash` の作成・適用・削除を禁止（他エージェントのWIPを破壊する恐れ）
- ブランチ切り替え・ワークツリー操作を禁止（明示的指示がない限り）
- `git pull --rebase` は許可するが、他エージェントの作業を破棄してはならない
- 認識できないファイルがあっても無視して自分の変更に集中する

### Pre-commit フックと品質ゲート

`git-hooks/pre-commit` はステージされたファイルに対して lint fix と format を実行し、自動的に再ステージングする。`pnpm prepare` フックで `git config core.hooksPath git-hooks` を設定し、リポジトリクローン時に自動有効化される。

品質ゲートは `pnpm check` = `format:check` + `tsgo` + `lint` の3段構成。CI と同等のチェックをローカルで再現できる。

## コード例

```bash
# scripts/committer:44-49 — ワイルドカード禁止
for file in "${files[@]}"; do
  if [ "$file" = "." ]; then
    printf 'Error: "." is not allowed; list specific paths instead\n' >&2
    exit 1
  fi
done
```

```bash
# scripts/committer:87-93 — ステージング初期化と再ステージング
git restore --staged :/
git add --force -- "${files[@]}"

if git diff --staged --quiet; then
  printf 'Warning: no staged changes detected for: %s\n' "${files[*]}" >&2
  exit 1
fi
```

```typescript
// src/cli/deps.ts:18-44 — 遅延インポートによる依存注入
export function createDefaultDeps(): CliDeps {
  return {
    sendMessageWhatsApp: async (...args) => {
      const { sendMessageWhatsApp } = await import("../channels/web/index.js");
      return await sendMessageWhatsApp(...args);
    },
    // ... 各チャネルで同パターン
  };
}
```

```typescript
// scripts/check-ts-max-loc.ts:55-76 — LOC上限の自動検査
const files = gitLsFilesAll()
  .filter((filePath) => existsSync(filePath))
  .filter((filePath) => filePath.endsWith(".ts") || filePath.endsWith(".tsx"));

const results = await Promise.all(
  files.map(async (filePath) => ({ filePath, lines: await countLines(filePath) })),
);

const offenders = results
  .filter((result) => result.lines > maxLines)
  .toSorted((a, b) => b.lines - a.lines);
```

```bash
# scripts/pr:620-625 — コミットメッセージに PR 番号とコントリビューター名を強制
echo "$subject" | rg -q "openclaw#$pr_number" || {
  echo "ERROR: commit subject missing openclaw#$pr_number"
  exit 1
}
echo "$subject" | rg -q "thanks @$contrib" || {
  echo "ERROR: commit subject missing thanks @$contrib"
  exit 1
}
```

## パターンカタログ

- **Service Locator / Lazy Loading** (分類: 生成)
  - 解決する問題: CLI 起動時に全チャネルモジュールをロードするとスタートアップが遅くなる
  - 適用条件: 起動パスに不要な重量級依存がある場合
  - コード例: `src/cli/deps.ts:18-44` — `createDefaultDeps` で各チャネルの `send` 関数を動的 import でラップ
  - 注意点: テスト時は `vi.mock` で差し替える必要がある（`src/cli/deps.test.ts:22-50`）

- **Pipeline パターン** (分類: 振る舞い)
  - 解決する問題: PR処理の各段階で異なる検証・変換が必要で、段階間に人間の判断ポイントを挟みたい
  - 適用条件: 自動化と人間の判断を交互に組み合わせるワークフロー
  - コード例: `scripts/pr` — `review-init` > `prepare-init` > `merge-run` の3段パイプライン
  - 注意点: 各段階のアーティファクト（`.local/*.env`, `.local/*.md`）が次段階の前提条件となるため、順序のスキップは不可

## Good Patterns

- **スコープドコミッター**: コミットツールがステージング範囲を強制することで、マルチエージェント環境でも安全にコミットできる。`scripts/committer` は `.` と `node_modules` を拒否し、コミット前に全ステージングを初期化してから指定ファイルだけを追加する。

```bash
# Good: 明示的ファイル指定
scripts/committer "fix(gateway): add auth check" src/gateway/auth.ts src/gateway/auth.test.ts
```

- **Lint churn 自動解決**: フォーマットのみの差分を人間に確認せず自動コミットする規約。AI エージェントがフォーマッタの差分で停止せず、本来のタスクに集中できる。

- **Co-author トレーラーによるクレジット**: squash merge 時に PR 作者とレビューアの両方を `Co-authored-by:` で記録する。Git の標準機能を活用し、コントリビューションの追跡性を確保している。

```
Co-authored-by: contributor <12345+contributor@users.noreply.github.com>
Co-authored-by: reviewer <67890+reviewer@users.noreply.github.com>
```

- **Force-with-lease による安全なプッシュ**: PR ブランチへのプッシュで `--force-with-lease` を使い、他者の変更を上書きしないことを保証する。リトライ機構も組み込まれている（`scripts/pr:724-741`）。

## Anti-Patterns / 注意点

- **無制限ステージング**: `git add .` や `git add -A` は、特にマルチエージェント環境で他のエージェントが生成した中間ファイルやデバッグ出力を巻き込むリスクがある。

```bash
# Bad: 全ファイルをステージング
git add .
git commit -m "fix: something"

# Better: 変更ファイルを明示的に指定
scripts/committer "fix: something" src/target-file.ts
```

- **再エクスポートラッパーの増殖**: ファイルが別ファイルを単に `export { X } from "./Y.js"` するだけのラッパーは冗長性を増す。直接インポートを徹底する規約がある。

```typescript
// Bad: 再エクスポートだけのファイル
// src/utils/index.ts
export { formatTime } from "./format-time.js";
export { parseDate } from "./parse-date.js";

// Better: 元のモジュールから直接インポート
import { formatTime } from "../infra/format-time.js";
```

- **LOC 管理なしの肥大化**: ファイルサイズの上限を設けないと、特に AI が生成するコードでは一つのファイルが際限なく肥大化する。実際にこのリポジトリでも `src/config/io.ts`（1156行）など上限を超過するファイルが存在する。定量的な監視がなければ気づかない。

## 導出ルール

- `[MUST]` コミットツールを導入し、ステージング対象を明示的なファイル指定に制限する。`.` や `*` による一括ステージングは禁止する
  - 根拠: `scripts/committer` が `.` を拒否し `git restore --staged :/` で毎回初期化する設計で、マルチエージェント環境でのステージング汚染を構造的に防いでいる（committer:44-49, 87-88）

- `[MUST]` PR マージ時に Co-authored-by トレーラーで原著者とレビューアの両方をクレジットする（squash merge でコミット履歴が消えるため）
  - 根拠: `scripts/pr` の merge-run がマージコミットの `Co-authored-by:` トレーラーを検証し、欠落していればエラー終了する（pr:1009-1010）

- `[SHOULD]` TypeScript ファイルの行数上限を設定し、CI またはスクリプトで自動検査する。目安は 500 LOC、許容上限は 700 LOC
  - 根拠: `scripts/check-ts-max-loc.ts` が `--max 500` でデフォルト検査し、AGENTS.md では "~700 LOC" をガイドラインとする二段構えで管理している

- `[SHOULD]` Lint/Format の差分がセマンティックな変更を含まない場合、自動解決して追加の確認を求めない。ただしロジック・データ・振る舞いの変更は必ず人間に確認させる
  - 根拠: AGENTS.md の "Lint/format churn" ルールが明示的に「formatting-only なら auto-resolve without asking」と規定している

- `[SHOULD]` AI エージェントからの PR を歓迎しつつ、透明性のためにAI利用の明示・テスト度合いの報告・コード理解の確認をチェックリストで求める
  - 根拠: CONTRIBUTING.md が "AI/Vibe-Coded PRs Welcome!" としつつ、AI 利用の表明・テスト状況・コード理解の確認を4項目のチェックリストで要求している

- `[SHOULD]` PR ブランチへの force push は `--force-with-lease` を使い、期待する HEAD SHA を指定して他者の変更を保護する
  - 根拠: `scripts/pr` の prepare-push が `--force-with-lease=refs/heads/$PR_HEAD:$lease_sha` で SHA を明示し、失敗時はリトライ機構で最新 HEAD を取得し直す（pr:724-741）

- `[AVOID]` マルチエージェント環境で `git stash` の作成・適用・削除を行わない。他のエージェントの WIP を破壊するリスクがある
  - 根拠: AGENTS.md が "do not create/apply/drop git stash entries unless explicitly requested" と明記し、`git pull --rebase --autostash` も禁止している

- `[AVOID]` コミットメッセージに無関係なリファクタリングを混ぜない。一つのコミットは一つの論理的変更に限定する
  - 根拠: AGENTS.md の "Group related changes; avoid bundling unrelated refactors" 規約

## 適用チェックリスト

- [ ] コミットツール（またはラッパースクリプト）を導入し、`git add .` を禁止するガードレールを設ける
- [ ] Conventional Commits 形式のコミットメッセージ規約を定め、CI で検証する
- [ ] TypeScript ファイルの LOC 上限チェックスクリプトを CI に組み込む（推奨500行、上限700行）
- [ ] Pre-commit フックで lint + format を自動実行し、`core.hooksPath` で有効化する
- [ ] PR テンプレートに AI 利用の明示チェックリストを追加する
- [ ] squash merge 時の Co-authored-by トレーラーを生成するスクリプトまたは CI ジョブを設定する
- [ ] Lint/format のみの差分を自動解決する規約を CONTRIBUTING.md に明記する
- [ ] `--force-with-lease` を PR ブランチへの push のデフォルトとし、生の `--force` を禁止する
- [ ] マルチエージェント運用時の安全規約（stash 禁止、ブランチ切り替え禁止、自分の変更のみコミット）を AGENTS.md に記載する
