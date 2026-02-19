# Claude: Agent Command Guardrails

> 出典: [repos/openclaw/openclaw](../repos/openclaw/openclaw/), [repos/ryoppippi/ccusage](../repos/ryoppippi/ccusage/)
> カテゴリ: claude

## 概要

AGENTS.md での具体的禁止コマンド列挙、scratchpad サンドボックスによる安全な実験環境、`.claude/settings.json` のホワイトリスト型権限制御、skills の `allowed-tools` によるツール制限を組み合わせ、AI エージェントが破壊的操作を実行するリスクを構造的に排除するプラクティス。「安全に操作してください」のような曖昧な指示ではなく、具体的なコマンド名・操作名で禁止行動を定義することが要点であり、AI エージェントの自律性を保ちつつ暴走を防止するガードレール設計を提供する。

## 背景・文脈

AI エージェント（Claude Code, Codex 等）がコードベースを自律的に操作する環境では、`git push --force`、`rm -rf`、`git add .` といった破壊的・広範な操作が意図せず実行されるリスクがある。特にマルチエージェント環境では、あるエージェントの操作が別のエージェントの作業を破壊する可能性がある。

openclaw/openclaw は 193K+ Stars の大規模 TypeScript プロジェクトで、複数の AI エージェントが同時にコードベースを操作するマルチエージェント開発を前提とした安全規約を構築している。AGENTS.md に 6 項目のマルチエージェント安全性ルールを定義し、`scripts/committer` でステージング範囲を強制制限し、3 段階 PR ワークフローで各段階の権限を明示的に分離している。

ryoppippi/ccusage は monorepo 全体に 10 個の CLAUDE.md を配置し、`CRITICAL`/`NEVER`/`ALWAYS` マーカーで AI の繰り返しミスをガードレール化している。skills の `allowed-tools` でツール使用範囲を制限し、`important-instruction-reminders` セクションで AI の行動制約を末尾に配置する recency bias 活用パターンを採用している。

## 実装パターン

### 1. 禁止コマンドの具体的列挙（AGENTS.md）

AI エージェントに対する禁止行動を、具体的なコマンド名で列挙する。曖昧な表現は AI に効果が薄い。

```markdown
<!-- openclaw/openclaw AGENTS.md:152-157 -->

- **Multi-agent safety:** do **not** create/apply/drop `git stash` entries unless explicitly requested
- **Multi-agent safety:** when the user says "push", you may `git pull --rebase` to integrate latest changes (never discard other agents' work). When the user says "commit", scope to your changes only.
- **Multi-agent safety:** do **not** create/remove/modify `git worktree` checkouts unless explicitly requested.
- **Multi-agent safety:** do **not** switch branches / check out a different branch unless explicitly requested.
- **Multi-agent safety:** running multiple agents is OK as long as each agent has its own session.
- **Multi-agent safety:** when you see unrecognized files, keep going; focus on your changes and commit only those.
```

各ルールのポイント:

- `git stash` は `git pull --rebase --autostash` による暗黙的な stash 操作も含めて禁止
- ブランチ切り替え・worktree 操作は「明示的にリクエストされない限り」禁止
- 認識できないファイルがあっても無視して自分の変更に集中する

### 2. スコープドコミットツールによるステージング制限

`git add .` や `git add -A` を禁止し、変更ファイルの個別指定を強制するラッパースクリプトを提供する。

```bash
# openclaw/openclaw scripts/committer:44-49
# "." は禁止 — リポジトリ全体のステージングを防止
for file in "${files[@]}"; do
  if [ "$file" = "." ]; then
    printf 'Error: "." is not allowed; list specific paths instead\n' >&2
    exit 1
  fi
done
```

```bash
# openclaw/openclaw scripts/committer:53-59
# node_modules のステージングも一律拒否
for file in "${files[@]}"; do
  case "$file" in
    *node_modules* | */node_modules | */node_modules/* | node_modules)
      printf 'Error: node_modules paths are not allowed: %s\n' "$file" >&2
      exit 1
      ;;
  esac
done
```

さらに、コミット前に `git restore --staged :/` で全ステージングをリセットしてから指定ファイルのみ追加する:

```bash
# openclaw/openclaw scripts/committer:87-93
git restore --staged :/
git add --force -- "${files[@]}"

if git diff --staged --quiet; then
  printf 'Warning: no staged changes detected for: %s\n' "${files[*]}" >&2
  exit 1
fi
```

### 3. 3 段階 PR ワークフローによる権限分離

PR ライフサイクルを 3 つのスキルに分離し、各段階で許可/禁止する操作を明示する。

```markdown
<!-- openclaw/openclaw .agents/skills/ の権限マトリクス -->

| スキル     | 権限                      | 禁止行動                                    |
| ---------- | ------------------------- | ------------------------------------------- |
| review-pr  | Read-only                 | push, merge, code change, GitHub write      |
| prepare-pr | Local write + 承認後 push | push to main, `git add .`, `git clean -fdx` |
| merge-pr   | 承認後 squash merge のみ  | `git push`, PR close, worktree削除(merge前) |
```

各スキルの冒頭でアーティファクトの存在を検証し、前段階の完了を強制する:

```bash
# openclaw/openclaw .agents/skills/merge-pr/SKILL.md:72-87
if [ -f .local/review.md ]; then
  echo "Found .local/review.md"
else
  echo "Missing .local/review.md. Stop and run /reviewpr, then /preparepr."
  exit 1
fi
```

### 4. Skills の allowed-tools によるツール制限

skills のフロントマターで使用可能なツールを明示的にホワイトリスト化する。

```yaml
# ryoppippi/ccusage .claude/skills/byethrow/SKILL.md:1-5
---
name: byethrow
description: Reference the byethrow documentation to understand and use the Result type library for error handling in JavaScript/TypeScript.
allowed-tools: Read, Grep, Glob
---
```

この skill は `Read`, `Grep`, `Glob` のみ許可されており、`Bash`（コマンド実行）や `Write`（ファイル書き込み）は使用できない。ドキュメント参照専用のスキルとして、AI が不用意にコードを変更するリスクを排除している。

### 5. CRITICAL/NEVER/ALWAYS マーカーによるガードレール強化

AI が過去に繰り返したミスを強い語調のマーカーで禁止する。CLAUDE.md の末尾に配置することで recency bias を活用する。

```markdown
<!-- ryoppippi/ccusage CLAUDE.md:304-310 -->

# important-instruction-reminders

Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
Dependencies should always be added as devDependencies unless explicitly requested otherwise.
```

```markdown
<!-- ryoppippi/ccusage CLAUDE.md:296-302 -->

# Tips for Claude Code

- Context7 MCP server available for library documentation lookup
- use-gunshi-cli skill available for gunshi CLI framework documentation
- byethrow skill available for @praha/byethrow Result type documentation
- do not use console.log. use logger.ts instead
- **CRITICAL VITEST REMINDER**: Vitest globals are enabled - use `describe`, `it`, `expect` directly WITHOUT imports. NEVER use `await import()` dynamic imports anywhere, especially in test blocks.
```

## Good Example

**禁止行動を具体的なコマンドで列挙する:**

```markdown
<!-- AGENTS.md -->

## AI エージェントの行動制約

### 禁止される git 操作

- `git add .` / `git add -A` — 変更ファイルは個別に指定すること
- `git push --force` — `--force-with-lease` のみ許可
- `git stash` / `git stash pop` — マルチエージェント環境で他者の作業を破壊するリスク
- `git checkout <branch>` — 明示的に指示された場合のみ
- `git clean -fdx` — 追跡外ファイルの一括削除は禁止
- `git reset --hard` — コミット済み作業の喪失リスク

### 禁止されるファイル操作

- `rm -rf` でのディレクトリ一括削除
- `.env` / credentials を含むファイルの作成・コミット
- `node_modules/` 内のファイルの変更
```

**settings.json でホワイトリスト型の権限制御:**

```json
// .claude/settings.json — docs ディレクトリ専用の権限設定
{
  "permissions": {
    "allow": [
      "Read(./**)",
      "Edit(./**)",
      "Write(./**)",
      "Bash(npx prettier:*)",
      "Bash(pnpm run docusaurus build:*)",
      "Bash(rm ./src/content/**)"
    ]
  }
}
```

この設定では `Read`/`Edit`/`Write` は許可するが、`Bash` は特定コマンドのみに限定している。`git push` や `rm -rf` は許可リストに含まれないため実行できない。

**prepare-pr スキルでの具体的禁止:**

```markdown
<!-- openclaw/openclaw .agents/skills/prepare-pr/SKILL.md:24 -->

- Do not run `git add -A` or `git add .`. Stage only specific files changed.
```

## Bad Example

**曖昧な安全指示:**

```markdown
<!-- Bad: AI エージェントにとって解釈の幅が広すぎる -->

## 安全性について

- git 操作は慎重に行ってください
- ファイルの削除には注意してください
- 他の作業を壊さないようにしてください
```

```markdown
<!-- Good: 具体的なコマンドで禁止行動を明示 -->

## 禁止される操作

- `git stash` の作成・適用・削除を行わないこと
- `git add .` ではなく変更ファイルを個別に指定すること
- ブランチの切り替えは明示的に指示された場合のみ行うこと
```

AI エージェントは「慎重に」「注意して」といった形容詞を定量的に解釈できない。具体的なコマンド名と「する/しない」の二値で指示することが効果的である。

**全権限を最初から付与する:**

```markdown
<!-- Bad: 全操作を無制限に許可 -->
---
name: code-review
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

PR のコードをレビューしてください。
```

```markdown
<!-- Good: レビューに必要な最小限のツールのみ許可 -->
---
name: code-review
allowed-tools: Read, Grep, Glob
---

PR のコードをレビューしてください。
レビュー結果は標準出力に報告し、コードの変更は行わないでください。
```

レビュースキルに `Write` や `Bash` を許可すると、AI が「善意で」コードを修正してしまうリスクがある。タスクの性質に応じて最小限のツールのみ許可する。

**ガードレールなしの単一ステップワークフロー:**

```markdown
<!-- Bad: 全ステップを一気に実行 -->

# PR マージ

1. PR を確認する
2. CI が通っていれば squash merge する
3. ブランチを削除する
```

```markdown
<!-- Good: 前段階の完了を強制 -->

# PR マージ

前提条件:

- `.local/review.md` が存在すること（/reviewpr を先に実行）
- `.local/prep.md` が存在すること（/preparepr を先に実行）

手順:

1. `.local/review.md` の存在を確認する。なければ停止し、先に /reviewpr を実行するよう指示する
2. CI チェックの状態を確認する
3. メンテナの承認を確認する
4. squash merge を実行する
```

## 適用ガイド

### どのような状況で使うべきか

- AI エージェントにコードベースの変更を許可するプロジェクト全般
- 複数の AI エージェントが同一リポジトリで並行作業するマルチエージェント環境
- AI に PR レビュー・作成・マージなどの git ワークフローを委任する場合
- チームに AI ツール初心者がおり、エージェントの暴走リスクを最小化したい場合

### 導入時の注意点

- **最初は禁止リストから始める**: `settings.json` のホワイトリストは厳密だが設定コストが高い。まず AGENTS.md に禁止コマンドを列挙し、問題が発生した操作を順次追加する運用が現実的
- **AGENTS.md の肥大化に注意する**: openclaw の AGENTS.md は 185 行に達している。禁止事項・コーディング規約・プロジェクト構造を 1 ファイルに詰め込みすぎると、重要なルールが埋もれる。モジュール固有のルールはサブディレクトリの AGENTS.md に分離する

```markdown
<!-- Better: スコープドファイルに分割 -->

# AGENTS.md (root)

## Quick Reference

- Build: `pnpm build`
- Test: `pnpm test`

## Detailed Guides

- [Multi-agent Safety](.agents/multi-agent-safety.md)
- [PR Workflow](.agents/skills/PR_WORKFLOW.md)
```

- **scratchpad ディレクトリの導入を検討する**: Effect-TS/effect は `scratchpad/` ディレクトリを workspace メンバーとして含めつつ `.gitignore` と changeset の ignore で隔離し、AI が安全にコードを試行錯誤できるサンドボックスを提供している
- **マルチエージェント対応はシンボリックリンクで**: `AGENTS.md -> CLAUDE.md` のシンボリックリンクにより、Claude Code と Codex の両方に同一のガードレールを単一ソースから供給する

```
# AGENTS.md をカノニカルとし、CLAUDE.md はリンク
ln -s AGENTS.md CLAUDE.md
```

### カスタマイズポイント

- **禁止リストの粒度**: プロジェクトのリスクプロファイルに応じて調整する。OSS プロジェクトでは `git push --force` の禁止は必須だが、個人プロジェクトでは緩和してもよい
- **ツール制限の範囲**: ドキュメント参照 skill は `Read, Grep, Glob` のみ、コード修正 skill は `Read, Write, Edit, Bash` を許可、のようにタスクの性質で使い分ける
- **ガードレールマーカーの配置**: `CRITICAL`/`NEVER` マーカーは CLAUDE.md の末尾に配置すると recency bias で効果が高まるが、重要度が特に高いものはファイル冒頭にも繰り返す
- **アーティファクトベースのゲート制御**: ワークフローの前段階完了を `.local/review.md` のようなファイルの存在チェックで強制する。ファイル名やディレクトリはプロジェクトの慣習に合わせる

## 参考

- [repos/openclaw/openclaw/ai-settings.md](../repos/openclaw/openclaw/ai-settings.md) -- AGENTS.md のガードレール設計とマルチエージェント安全性ルールの分析
- [repos/openclaw/openclaw/security-practices.md](../repos/openclaw/openclaw/security-practices.md) -- サンドボックス・コマンド実行安全性の分析
- [repos/openclaw/openclaw/dev-conventions.md](../repos/openclaw/openclaw/dev-conventions.md) -- スコープドコミットツールと PR ワークフローの分析
- [repos/ryoppippi/ccusage/ai-settings.md](../repos/ryoppippi/ccusage/ai-settings.md) -- 階層的コンテキスト設計と skills ツール制限の分析
- [repos/ryoppippi/ccusage/dev-conventions.md](../repos/ryoppippi/ccusage/dev-conventions.md) -- 開発規約とガードレール強化パターンの分析
