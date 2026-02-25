# AI 設定戦略

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

cloudflare/agents は AGENTS.md ファイルを6階層に配置し、AI コーディングアシスタントに対してディレクトリごとのコンテキストを段階的に提供している。さらに design/ ディレクトリに RFC 体系を持ち、ユーザー向けドキュメント（docs/）と設計意図の記録（design/）を Diataxis フレームワークに基づいて明確に分離している。この設計は「AI が現在のディレクトリの文脈を正しく理解し、適切な粒度の指示に従う」ことを実現しており、大規模モノレポにおける AI 設定の先進的な事例として注目に値する。

## 背景にある原則

- **局所性の原則（Locality of Context）**: AI アシスタントはファイルを編集する際、ルートの指示だけでなく「今自分がいるディレクトリ固有のルール」を知る必要がある。cloudflare/agents はルート AGENTS.md からサブディレクトリの AGENTS.md へのリンクテーブルを設け、AI が段階的にコンテキストを深掘りできる構造にしている（`AGENTS.md:40-50`）。こうすることで、examples/ を編集する AI は examples/AGENTS.md の UI 規約に従い、packages/agents/ を編集する AI は export ルールやビルド手順に従う。

- **関心の分離をドキュメントレベルで徹底する**: docs/ は「how to use（使い方）」、design/ は「why it works this way（設計意図）」という Diataxis の4象限モデルを物理ディレクトリで実現している（`docs/AGENTS.md:15`, `design/AGENTS.md:3`）。AI がコードの使い方を説明する場面と、設計判断の根拠を参照する場面で、参照先が明確に異なる。

- **行動制約の明示（Always / Ask first / Never の3段階境界）**: ルート AGENTS.md は行動を3段階に分類し、AI が判断に迷うグレーゾーンを最小化している（`AGENTS.md:156-179`）。「Ask first」という中間レベルがあることで、依存関係追加や CI 変更など影響範囲の広い操作に対して AI が自律的に突き進むのを防いでいる。

- **スナップショットと生きたドキュメントの併存**: design/ の RFC は「決定のスナップショット（書いたら変更しない）」、design doc は「現状を反映する生きたドキュメント」という二重構造を持つ（`design/AGENTS.md:7-17`）。却下された RFC も削除しない方針により、同じ議論の蒸し返しを防ぐ。AI が設計判断の文脈を遡る際、RFC が「なぜ他の案を選ばなかったか」を教える。

## 実例と分析

### 6階層 AGENTS.md のスコープ設計

各 AGENTS.md は明確に異なるスコープを持ち、重複を避けている。

| 階層     | ファイル                    | スコープ                                                       | 対象読者                |
| -------- | --------------------------- | -------------------------------------------------------------- | ----------------------- |
| ルート   | `AGENTS.md`                 | リポジトリ全体の概要、セットアップ、コマンド、コード標準、境界 | 全コントリビュータ / AI |
| コアSDK  | `packages/agents/AGENTS.md` | export 一覧、ソースレイアウト、ビルド、テスト、アーキテクチャ  | SDK 開発者 / AI         |
| examples | `examples/AGENTS.md`        | 必須ファイル構成、UI 規約、通信パターン、既知の問題            | example 作成者 / AI     |
| guides   | `guides/AGENTS.md`          | examples との違い、README 要件、現在のガイド一覧               | ガイド執筆者 / AI       |
| docs     | `docs/AGENTS.md`            | Diataxis 分類、上流同期、文体ルール                            | ドキュメント執筆者 / AI |
| design   | `design/AGENTS.md`          | RFC フォーマット、ワークフロー、docs との関係                  | 設計者 / AI             |

ルート AGENTS.md には「Nested AGENTS.md files」セクションがあり、テーブルで全サブファイルの場所とスコープを一覧化している。AI は最初にルートを読み、作業対象ディレクトリの AGENTS.md に遷移するという段階的ナビゲーションが可能になる。

### Diataxis フレームワークの物理ディレクトリへのマッピング

Diataxis は4種類のドキュメント（Tutorial, How-to, Reference, Explanation）を区別するフレームワークである。cloudflare/agents はこれを以下のように物理構成に落とし込んでいる。

| Diataxis 象限 | 物理ディレクトリ | 具体例                                                |
| ------------- | ---------------- | ----------------------------------------------------- |
| Tutorial      | `docs/`          | `getting-started.md`, `adding-to-existing-project.md` |
| How-to        | `docs/`          | `email.md`, `webhooks.md`, `human-in-the-loop.md`     |
| Reference     | `docs/`          | `agent-class.md`, `callable-methods.md`, `state.md`   |
| Explanation   | `design/`        | `readonly-connections.md`, `retries.md`, `visuals.md` |

特筆すべきは、Explanation を docs/ ではなく design/ という独立ディレクトリに分離した点である。docs/AGENTS.md は明確に述べている：

> The fourth Diataxis type -- **explanation** ("understand why") -- lives in `/design`, not here.

これにより、AI が docs/ で作業する際には「使い方」の記述に集中し、設計理由を書きたくなったら design/ に移動するというルーティングが自然に生まれる。

### docs と design の双方向参照

docs/ と design/ は互いをクロスリファレンスしており、一方通行にならない設計になっている。

- `docs/AGENTS.md:40`: 新規ドキュメント追加時に「design/ にコンパニオンエントリが必要か検討する」と指示
- `design/AGENTS.md:78-80`: design/ と docs/ の関係を明示し、「ユーザーに影響する設計判断は docs/ に要約を書き、design/ にフル根拠へのリンクを張る」と指示

実際に readonly-connections は両方に存在する。docs/ 版はユーザー向けの API 使用法（70行程度の簡潔な説明）、design/ 版は設計判断の全記録（200行超の代替案比較、実装詳細、トレードオフ）。

### RFC ワークフローと「却下 RFC を削除しない」原則

design/AGENTS.md は RFC のワークフローを3ステップで定義している。

```
1. Propose:  write rfc-<name>.md (status: proposed)
2. Decide:   update status to accepted or rejected
3. Implement: update the relevant design doc to reflect the new reality
```

`design/AGENTS.md:17-18`

ステップ3が重要で、RFC の決定後に design doc（生きたドキュメント）を更新するフローが組み込まれている。RFC はスナップショットとして凍結され、design doc が常に最新の実装を反映する。

design doc は複数の RFC へのリンクを持つ歴史セクションを含む想定になっている。

```markdown
## History

- [rfc-state-sync.md](./rfc-state-sync.md) -- original bidirectional sync design
- [rfc-state-v2-batching.md](./rfc-state-v2-batching.md) -- added batched updates
```

`design/AGENTS.md:33-37`

### 行動境界の3段階分類

ルート AGENTS.md の「Boundaries」セクションは Always / Ask first / Never の3段階に行動を分類している。

```
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

`AGENTS.md:156-179`

packages/agents/AGENTS.md も独自の Boundaries セクションを持ち、パッケージ固有のルール（export 追加時の3点セット、大規模ファイルの編集注意、基盤依存の保護）を追加している（`packages/agents/AGENTS.md:139-144`）。

## コード例

ルートの AGENTS.md がサブディレクトリへのナビゲーションテーブルを提供する構造：

```markdown
<!-- AGENTS.md:40-50 -->

## Nested AGENTS.md files

Some directories have their own AGENTS.md with deeper guidance:

| File                        | Scope                                                                     |
| --------------------------- | ------------------------------------------------------------------------- |
| `packages/agents/AGENTS.md` | Core SDK internals — exports, source layout, build, testing, architecture |
| `examples/AGENTS.md`        | Example conventions — required structure, consistency rules, known issues |
| `guides/AGENTS.md`          | Guide conventions — how guides differ from examples, README expectations  |
| `docs/AGENTS.md`            | Writing user-facing docs — Diátaxis framework, upstream sync, style       |
| `design/AGENTS.md`          | Design records and RFCs — format, workflow, relationship to docs          |
```

design/ の RFC と design doc の二重構造を定義するセクション：

```markdown
<!-- design/AGENTS.md:7-17 -->

### Design docs

Living documents that describe how a concept or subsystem works **right now**. Named by topic:
`state.md`, `mcp.md`, `visuals.md`. These are the primary entry point — a contributor looking
for "how does state work" should open one file and get the full picture.

Design docs get updated as the implementation evolves. They always reflect the current reality.

### RFCs

Point-in-time decision records for significant changes. Named with an `rfc-` prefix:
`rfc-state-v2-sync-protocol.md`. These capture why a specific change was made and what
alternatives were considered. They do not get updated after the decision — they are snapshots.

RFCs are never deleted, even after rejection.
```

docs/AGENTS.md の Diataxis 分類テーブルとタイプ選定ガイド：

```markdown
<!-- docs/AGENTS.md:7-22 -->

| Type          | Purpose                  | Reader's need | Examples in this folder                 |
| ------------- | ------------------------ | ------------- | --------------------------------------- |
| **Tutorial**  | "Follow along and learn" | Learning      | `getting-started.md`                    |
| **How-to**    | "Solve a specific task"  | A goal        | `email.md`, `webhooks.md`               |
| **Reference** | "Look up the API"        | Information   | `agent-class.md`, `callable-methods.md` |

### Picking the right type

- **New API or feature?** Start with **reference** plus a concise example.
- **Multi-step workflow?** Write a **how-to** guide.
- **Onboarding flow?** Write a **tutorial**.
- **Don't hybridise** — if you're writing a 20-step walkthrough inside a reference doc,
  it should be a separate how-to.
```

## パターンカタログ

- **Hierarchical Context Pattern** (分類: 構造)
  - 解決する問題: モノレポで AI が「どのルールに従うべきか」を判断できない
  - 適用条件: ディレクトリごとに異なる規約が存在するモノレポ / マルチパッケージプロジェクト
  - コード例: `AGENTS.md:40-50`（ルートのナビゲーションテーブル）、各サブディレクトリの AGENTS.md
  - 注意点: 階層が深すぎるとメンテナンスコストが増大する。cloudflare/agents は2階層（ルート + 1サブディレクトリ）に留めている

- **ADR (Architecture Decision Records) の変形** (分類: 振る舞い)
  - 解決する問題: 設計判断の根拠が失われ、同じ議論が繰り返される
  - 適用条件: 設計判断が頻繁に行われるプロジェクト
  - コード例: `design/AGENTS.md:7-17`（design doc + RFC の二重構造）
  - 注意点: 標準的な ADR は1種類のドキュメントだが、cloudflare/agents は「生きたドキュメント + 凍結スナップショット」の2種類に分化させている。生きたドキュメントが読者の主な入り口になり、RFC は footnote として機能する

## Good Patterns

- **ルートにサブディレクトリ AGENTS.md のインデックステーブルを設置する**: ルート AGENTS.md に「Nested AGENTS.md files」テーブルを配置し、各サブファイルのパスとスコープを1行で要約している。AI は最初にルートを読むだけで、作業対象ディレクトリに固有のコンテキストファイルの存在と概要を把握できる。

```markdown
<!-- AGENTS.md:44-50 -->

| File                        | Scope                                                                     |
| --------------------------- | ------------------------------------------------------------------------- |
| `packages/agents/AGENTS.md` | Core SDK internals — exports, source layout, build, testing, architecture |
| `examples/AGENTS.md`        | Example conventions — required structure, consistency rules, known issues |
```

- **Explanation 象限を独立ディレクトリに分離する**: docs/ 内に Tutorial / How-to / Reference を収め、Explanation（設計の「なぜ」）を design/ に物理的に分離している。これにより AI はドキュメント種別を物理パスから判断でき、「使い方の説明に設計議論を混ぜる」ハイブリッド化を防げる。

```markdown
<!-- docs/AGENTS.md:15 -->

The fourth Diátaxis type — **explanation** ("understand why") — lives in `/design`, not here.
```

- **Always / Ask first / Never の3段階で行動境界を定義する**: 「常にやること」「確認してからやること」「絶対にやらないこと」を明示的にリスト化し、AI の判断余地を適切にコントロールしている。特に「Ask first」は、AI に完全な自律性を与えず、かつ完全に禁止もしないグレーゾーンを扱う優れた手法。

```markdown
<!-- AGENTS.md:158-170 -->

**Always:**

- Run `npm run check` before considering work done

**Ask first:**

- Adding new dependencies to `packages/`

**Never:**

- Hardcode secrets or API keys
```

- **各 AGENTS.md に「Known issues」セクションを含める**: examples/AGENTS.md と guides/AGENTS.md は末尾に既知の問題をリスト化しており、AI がこれらのファイルを編集する際に「この不整合は意図的か否か」を判断できる。

## Anti-Patterns / 注意点

- **AI 設定ファイルに情報を詰め込みすぎる**: examples/AGENTS.md は225行に達しており、UI 規約、ファイル構成、通信パターン、HTML テンプレート、CSS インポートなど多岐にわたる。AI のコンテキストウィンドウを圧迫し、重要な指示が埋もれるリスクがある。

```markdown
<!-- Bad: 1つの AGENTS.md に UI テンプレート、CSS 構成、通信パターンを全て含む -->
<!-- examples/AGENTS.md は 225 行 -->

<!-- Better: 規約を categories に分割し、AGENTS.md はインデックスに留める -->

examples/
AGENTS.md # 概要 + サブファイルへのリンク（50行以下）
.agents/
ui-conventions.md
file-structure.md
communication.md
```

- **design doc と docs のコンテンツ同期が手動**: docs/ と design/ に同じトピック（readonly-connections, retries）のファイルが存在するが、同期は完全に手動。AI は「design/ を更新したが docs/ は更新しなかった」という不整合を生みやすい。docs/AGENTS.md に「upstream sync」の注意はあるが、自動検出の仕組みはない。

## 導出ルール

- `[MUST]` AI 設定ファイル（AGENTS.md / CLAUDE.md）をディレクトリ固有のスコープで配置する場合、ルートファイルにサブファイルの一覧テーブル（パスとスコープの1行要約）を設ける
  - 根拠: cloudflare/agents のルート AGENTS.md はナビゲーションテーブルでサブファイルへの遷移パスを明示しており、AI が最初に読むファイルだけで全体の構造を把握できる（`AGENTS.md:40-50`）

- `[MUST]` AI 設定ファイルの行動制約は「Always（必須）」「Never（禁止）」に加え、「Ask first（確認必要）」の中間レベルを設ける
  - 根拠: 影響範囲の広い操作（依存関係追加、CI 変更など）を完全に禁止すると AI の有用性が下がり、許可すると危険。cloudflare/agents の3段階分類は「判断に迷う領域」を明示的に扱う（`AGENTS.md:156-179`）

- `[SHOULD]` 設計判断の記録は「生きたドキュメント（現状を反映）」と「スナップショット（決定時の記録）」の2種類に分離し、生きたドキュメントを読者の主な入り口にする
  - 根拠: design/ の design doc は常に最新の実装を反映し、RFC は変更せず保存される。読者はまず design doc で現状を理解し、必要に応じて RFC で「なぜこの設計に至ったか」を遡れる（`design/AGENTS.md:7-17`）

- `[SHOULD]` ドキュメントの種類（Tutorial / How-to / Reference / Explanation）を物理ディレクトリまたはファイル命名規則で明示し、AI が配置先を判断できるようにする
  - 根拠: cloudflare/agents は Diataxis の Explanation 象限を design/ に物理分離し、AI が「設計の理由を書くなら design/、使い方を書くなら docs/」と即座に判断できる（`docs/AGENTS.md:15`）

- `[SHOULD]` AI 設定ファイルの末尾に「Known issues」セクションを設け、既知の不整合や TODO を明示する
  - 根拠: AI はコードの不整合を検出すると修正を試みる傾向があるが、意図的な不整合もある。examples/AGENTS.md と guides/AGENTS.md は既知の問題をリスト化し、AI が不要な修正を行うのを防いでいる（`examples/AGENTS.md:220-226`, `guides/AGENTS.md:59-62`）

- `[AVOID]` 1つの AI 設定ファイルに200行を超える指示を詰め込む
  - 根拠: examples/AGENTS.md は225行に達し、UI テンプレートからCSS 構成まで多岐にわたる。コンテキストウィンドウの圧迫と重要指示の埋没リスクがある。cloudflare/agents のルート AGENTS.md は179行でバランスを保っているが、examples/ は分割の余地がある

## 適用チェックリスト

- [ ] プロジェクトルートの AI 設定ファイル（CLAUDE.md / AGENTS.md）に、サブディレクトリ固有の設定ファイルへのナビゲーションテーブルを追加しているか
- [ ] 行動制約を「Always / Ask first / Never」の3段階で分類しているか（2段階だけでは中間領域が曖昧になる）
- [ ] 設計判断の記録場所が明確か（ユーザー向けドキュメントと設計意図のドキュメントが混在していないか）
- [ ] Diataxis の4象限（Tutorial / How-to / Reference / Explanation）がディレクトリ構成やファイル命名で識別可能か
- [ ] 設計意図の記録に「生きたドキュメント」と「スナップショット（RFC/ADR）」の二重構造を採用しているか
- [ ] AI 設定ファイルに「Known issues」セクションがあり、意図的な不整合や TODO が明示されているか
- [ ] 各 AI 設定ファイルが200行以内に収まっているか（超過している場合は分割を検討）
