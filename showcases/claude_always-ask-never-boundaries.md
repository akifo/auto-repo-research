# Claude: Always / Ask first / Never 行動境界パターン

> 出典: [repos/cloudflare/agents/ai-settings.md](../repos/cloudflare/agents/ai-settings.md)
> カテゴリ: claude

## 概要

AI コーディングツールの行動を Always（常に実行）/ Ask first（確認してから実行）/ Never（絶対禁止）の3段階で分類し、行動境界を明示的に定義するパターン。従来の「Do / Don't」2値分類では扱えなかった「影響範囲が広く、状況次第で判断が変わる操作」を Ask first レイヤーで吸収する。cloudflare/agents の AGENTS.md で実践されており、6階層の AGENTS.md によるスコープ分離と組み合わせることで、大規模モノレポでの AI 行動制御を実現している。

## 背景・文脈

AI エージェントの行動制約は、多くのプロジェクトで「やること」と「やらないこと」の2値で記述されている。しかし現実のソフトウェア開発には、一律に許可も禁止もできないグレーゾーンが存在する。

- 依存関係の追加: 小さなユーティリティの追加は問題ないが、バンドルサイズに影響する大きな依存は確認が必要
- CI ワークフローの変更: typo 修正は問題ないが、ジョブ追加やトリガー変更は意図せぬビルド破壊につながる
- compatibility date の変更: Cloudflare Workers 固有だが、API の破壊的変更を引き起こす可能性がある

これらを Never に分類すると AI の有用性が大幅に下がり、Always に分類すると危険な変更が無確認で実行される。cloudflare/agents はこの問題を Ask first という中間レイヤーで解決した。

cloudflare/agents は Cloudflare Workers 向けの AI エージェント SDK で、packages/ 配下のコア SDK、examples/、docs/、design/ など複数のサブディレクトリを持つモノレポ構成をとる。ルート AGENTS.md を含む6階層の AGENTS.md が存在し、各階層が独自のスコープで行動境界を定義している。

## 実装パターン

### 1. 3段階分類の基本構造

ルート AGENTS.md の Boundaries セクションが3段階分類の中心である。

```markdown
<!-- cloudflare/agents AGENTS.md:156-179 -->

Always:

- Run `npm run check` before considering work done
- Use `import type` for type-only imports
- Keep examples simple and self-contained
- Use Cloudflare Workers APIs over third-party equivalents

Ask first:

- Adding new dependencies to `packages/`
- Changing compatibility dates across the repo
- Modifying CI workflows

Never:

- Hardcode secrets or API keys
- Add native/FFI dependencies
- Use `any`
- Use CommonJS or Service Worker format
- Modify `node_modules/` or `dist/`
- Force push to main
```

各レイヤーの設計意図:

- **Always**: 品質の最低ラインを保証する。AI が「やったつもり」になりやすい操作（check の実行、import type の使用）を明示的に義務化する
- **Ask first**: 影響範囲が広く、コンテキスト依存の判断が必要な操作。AI に「これは自分で判断すべきでない」と認識させる
- **Never**: 取り消しが困難または不可能な操作。条件付きの例外を許容しない絶対的な禁止

### 2. Ask first レイヤーの設計原則

Ask first に配置する操作の選定基準を、cloudflare/agents の実例から抽出する。

```
Ask first に含めるべき操作の特徴:
1. 操作自体は正当だが、影響範囲がディレクトリをまたぐ
   例: Adding new dependencies to `packages/`
2. プロジェクト固有の慣習があり、AI が独自判断すると不整合が生じる
   例: Changing compatibility dates across the repo
3. 変更が CI/CD パイプラインに波及し、全コントリビュータに影響する
   例: Modifying CI workflows
```

共通するのは「操作の正当性が文脈に依存する」という性質である。依存関係の追加は日常的な開発行為だが、コア SDK パッケージへの追加はバンドルサイズ、互換性、ライセンスの観点で慎重な判断が求められる。AI にこの文脈判断を委ねるのではなく、「判断が必要な場面であること」を AI に認識させるのが Ask first の役割である。

### 3. 階層ごとのスコープ分離

cloudflare/agents では、ルートの行動境界に加えて、サブディレクトリの AGENTS.md がパッケージ固有の境界を追加している。

```markdown
<!-- cloudflare/agents packages/agents/AGENTS.md:139-144 -->

Boundaries (パッケージ固有):

- 新しい export を追加する際は index.ts, package.json の exports, README の3点を必ず更新する
- 800行を超えるファイルは編集前に分割を検討する
- @cloudflare/workers-types と hono は基盤依存であり、バージョン変更は Ask first
```

ルートの Boundaries は「リポジトリ全体に適用される行動規範」、パッケージの Boundaries は「そのパッケージで作業する際の追加規約」という関係になる。AI はルートの境界を遵守した上で、作業対象ディレクトリの境界も参照する。

ルート AGENTS.md にはサブファイルのナビゲーションテーブルがあり、AI がどのファイルに追加の境界定義があるかを把握できる。

```markdown
<!-- cloudflare/agents AGENTS.md:40-50 -->

## Nested AGENTS.md files

Some directories have their own AGENTS.md with deeper guidance:

| File                        | Scope                                                                     |
| --------------------------- | ------------------------------------------------------------------------- |
| `packages/agents/AGENTS.md` | Core SDK internals — exports, source layout, build, testing, architecture |
| `examples/AGENTS.md`        | Example conventions — required structure, consistency rules, known issues |
| `guides/AGENTS.md`          | Guide conventions — how guides differ from examples, README expectations  |
| `docs/AGENTS.md`            | Writing user-facing docs — Diataxis framework, upstream sync, style       |
| `design/AGENTS.md`          | Design records and RFCs — format, workflow, relationship to docs          |
```

### 4. Always の品質保証効果

Always に配置する項目は、AI が「やり忘れる」頻度が高い操作を選ぶ。cloudflare/agents の `Run npm run check before considering work done` は、AI が変更を完了したと報告する直前に品質チェックを強制する。

この指示の効果は2つある:

1. **完了条件の明確化**: AI は「コードを書いた」時点ではなく「check が通った」時点を完了とみなす
2. **フィードバックループの内在化**: lint エラーや型エラーを AI 自身が検出・修正するサイクルが生まれる

`Use import type for type-only imports` も同様で、TypeScript の isolatedModules 設定下で頻出するエラーを予防する。AI は import 文を書く際にこの Always ルールを参照し、型のみの import を自動的に `import type` に変換する。

## Good Example

**3段階分類を自プロジェクトに適用する:**

```markdown
<!-- CLAUDE.md -->

## Boundaries

**Always:**

- Run `pnpm check` before reporting work as done
- Write tests for new public functions
- Use `import type` for type-only imports
- Add JSDoc to exported functions

**Ask first:**

- Adding new dependencies (devDependencies is OK without asking)
- Creating new top-level directories
- Modifying tsconfig.json or ESLint config
- Changing database schema
- Updating GitHub Actions workflows

**Never:**

- Use `any` type (use `unknown` + type guards)
- Commit `.env` files or secrets
- Force push to main or develop branches
- Delete migration files
- Modify `node_modules/` or build output directories
- Skip tests with `.skip` without a comment explaining why
```

**Ask first にコンテキストを付加する（判断を助ける追加情報）:**

```markdown
**Ask first:**

- Adding new dependencies to `packages/core`
  _バンドルサイズへの影響を確認する。tree-shakeable でないライブラリは特に注意_
- Changing the database schema
  _マイグレーションファイルの作成が必要。既存データへの影響を説明すること_
- Modifying CI workflows
  _全ブランチのビルドに影響する。変更理由と影響範囲を説明すること_
```

**パッケージ固有の境界をサブディレクトリで追加する:**

```markdown
<!-- packages/core/CLAUDE.md -->

## Boundaries (このパッケージ固有)

**Always:**

- 新しい export は index.ts と package.json の exports に追加する
- breaking change は CHANGELOG.md に記録する

**Ask first:**

- 既存の public API のシグネチャ変更
- peer dependency のバージョン範囲変更

**Never:**

- Node.js 固有 API の使用（ブラウザ互換性を維持）
- default export の使用（named export のみ）
```

## Bad Example

**2値分類でグレーゾーンを扱おうとする:**

```markdown
<!-- Bad: 依存追加を一律禁止すると AI の有用性が激減 -->

## Rules

**Do:**

- Run tests before committing
- Use TypeScript strict mode

**Don't:**

- Add new dependencies
- Change CI configuration
- Modify configuration files
```

```markdown
<!-- Bad: 依存追加を一律許可すると不要な依存が増殖 -->

## Rules

**Do:**

- Run tests before committing
- Add dependencies as needed
- Update CI when necessary
```

2値分類では「依存追加は状況による」という現実を表現できない。Don't に入れると AI がユーティリティライブラリすら追加できず生産性が下がる。Do に入れると AI が巨大なフレームワークを気軽に追加するリスクがある。

**Ask first に項目を詰め込みすぎる:**

```markdown
<!-- Bad: ほぼ全操作が Ask first -->

**Always:**

- Use TypeScript

**Ask first:**

- Adding new files
- Modifying existing functions
- Writing tests
- Adding imports
- Changing variable names
- Updating comments

**Never:**

- Delete the repository
```

Ask first に日常的な操作を含めると、AI が全操作で停止して確認を求めるようになり、自律性が失われる。Ask first は「影響範囲が広く、文脈依存の判断が必要な操作」に限定する。目安として Ask first は3-7項目に収める。

## 適用ガイド

### どのような状況で使うべきか

- AI エージェントに一定の自律性を与えつつ、影響範囲の広い操作にはヒューマンチェックを挟みたいプロジェクト
- 「禁止リストだけでは AI の有用性が下がるが、全面許可は危険」というバランスに悩んでいるチーム
- モノレポでパッケージごとに異なる行動制約が必要なプロジェクト
- AI エージェントの利用を段階的に拡大していく過程にあるチーム（最初は Ask first を多めにし、信頼が蓄積されたら Always に昇格させる）

### 導入時の注意点

- **3段階の配分バランス**: Always は5-10項目、Ask first は3-7項目、Never は5-15項目が目安。Ask first が10項目を超えると AI の自律性が損なわれる
- **Ask first の運用コスト**: Ask first の項目ごとに AI は停止して確認を求める。頻繁に発生する操作を Ask first に入れると開発者の確認負荷が増大する。「週に1回程度発生する操作」が Ask first の適切な粒度
- **Never の絶対性を維持する**: Never に「原則として禁止」のような例外付きの項目を含めない。例外がある操作は Ask first に分類する
- **段階的な再分類**: 運用開始後に Ask first で常に許可される操作が出てきたら Always に昇格させ、常に拒否される操作は Never に降格させる。3段階分類は静的なルールではなく、プロジェクトの成熟度とともに進化させる

### カスタマイズポイント

- **レイヤー名のカスタマイズ**: Always / Ask first / Never は cloudflare/agents の命名だが、プロジェクトの文化に合わせて「Required / Review needed / Forbidden」「Must / Check / Must not」などに変更してもよい。重要なのは3段階の構造であり、名前ではない
- **階層ごとの境界設計**: ルートには全体共通の境界、サブディレクトリにはパッケージ固有の境界を配置する。サブディレクトリの境界はルートの境界を上書きするのではなく、追加する関係にする
- **他のパターンとの組み合わせ**: PostToolUse フック（自動 lint/format）で Always の一部を自動化し、`settings.json` の権限制御で Never の一部をシステムレベルで強制できる。3段階分類はドキュメントレベルの行動制約であり、システムレベルの制約と相補的に機能する

## 参考

- [repos/cloudflare/agents/ai-settings.md](../repos/cloudflare/agents/ai-settings.md) -- 6階層 AGENTS.md と3段階行動境界の分析
- [showcases/claude_hierarchical-agents-md.md](claude_hierarchical-agents-md.md) -- 階層的 AGENTS.md の構造設計（本 showcase は行動境界の内容設計にフォーカス）
- [showcases/claude_agent-command-guardrails.md](claude_agent-command-guardrails.md) -- 禁止コマンド列挙とシステムレベルのガードレール設計
