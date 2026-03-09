# ai-settings

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-06

## 概要

Vitest リポジトリにおける AI エージェント向け開発ガイド（CLAUDE.md, AGENTS.md, copilot-instructions.md, .claude/agents/）の構成と設計意図を分析する。テストフレームワーク自体が「テストの書き方」を AI に厳密に指示するという構造的な面白さがあり、ドメイン固有のポリシー（No mocking, inline snapshot 推奨）を AI ガイドに反映する手法が注目に値する。4ファイル・3層構成で合計263行という規模感も、保守可能な AI ガイドの設計事例として参考になる。

## 背景にある原則

- **薄い Hub + 厚い Spoke 原則**: `CLAUDE.md`(11行) と `.github/copilot-instructions.md`(11行) は `AGENTS.md` へのリンクのみを記載し、実質的なガイドは `AGENTS.md`(150行) に一元化している。ツール固有の設定ファイルを Hub として使い、共通ガイドを Spoke に集約することで、複数 AI ツール対応時の情報の重複と乖離を防止している。新しい AI ツール対応は Hub ファイルの追加だけで済む設計。根拠: `CLAUDE.md:9-10` と `.github/copilot-instructions.md:9-10` が同一構造で AGENTS.md を参照

- **制約駆動の品質保証**: AI エージェントに「良いコードを書け」と指示するのではなく、「やってはいけないこと」を明確に禁止することで品質を担保する。「No mocking policy」「AVOID toContain」「Do not add comments」「Never import from main entry」の4つの禁止事項が、AI が陥りやすい安易な実装パターンを事前に遮断する。推奨より禁止のほうが AI エージェントの行動を確実に制御できる。根拠: `AGENTS.md:38,45,87-88`

- **プログラマブルなテスト環境の提供**: `runInlineTests` / `runVitest` というテストユーティリティを用意し、複雑なファイルシステム操作を伴うテストを宣言的に書けるようにしている。一時ファイルの手動管理やクリーンアップ漏れのリスクを構造的に排除する設計。根拠: `test/test-utils/index.ts:501-527` の `runInlineTests` 実装

- **段階的コンテキスト提供**: `AGENTS.md` は「Setup → Testing → Structure → Code Style → Workflows → Dependencies → Troubleshooting」の順で構成されている。AI エージェントが最初に必要とするセットアップ情報から始め、徐々に深い知識へと誘導する構成は、トークン制限のある AI が必要な情報を早期に取得できるよう設計されている。根拠: `AGENTS.md` の見出し構成

## 実例と分析

### 3層構成: エントリポイント → 共通ガイド → 専門エージェント

Vitest の AI 設定は3層構造を採用している:

1. **エントリポイント層** (CLAUDE.md, copilot-instructions.md): 各11行。プロジェクト概要1文 + AGENTS.md へのリンクのみ
2. **共通ガイド層** (AGENTS.md): 150行。セットアップ、テスト実行、コーディング規約、プロジェクト構造を網羅
3. **専門エージェント層** (.claude/agents/vitest-test-writer.md): 92行。テスト作成に特化した詳細なパターンガイド

第3層の専門エージェントは Claude Code 固有の機能（Task agent）を活用し、メインエージェントからテスト作成を委譲する。YAML フロントマターに `model: opus` を指定し、description には3つの具体的なシナリオ（新関数追加時、CLI フラグ実装時、マルチモードテスト時）を例示することで、メインエージェントが適切なタイミングで委譲できるよう設計されている。

### テストポリシーの AI ガイドへの反映

AGENTS.md と vitest-test-writer には4つの強い制約がある:

**No mocking policy**: テストでモックを一切使わない方針。`test/cli` ディレクトリでは `vi.mock`/`vi.spyOn`/`vi.fn` の使用がフィクスチャファイル（テスト対象のコード）に限定されており、テストロジック自体にはモックを使わない。`runInlineTests` が代替手段を提供し、実プロセスを起動して統合テストを行う。

**toMatchInlineSnapshot 推奨 / toContain 禁止**: vitest-test-writer は禁止の理由を3点挙げて説明している — 「追加の予期しない出力」「重複出力」「微妙なフォーマット差異」の見逃し。さらに `testTree()` / `errorTree()` ヘルパーとの組み合わせで、テスト結果の構造を木形式でスナップショット検証するパターンを推奨している。

**runInlineTests 必須**: 複数ファイル構成のテストでは `runInlineTests` を必須とし、インラインでファイル構造を定義する。`onTestFinished` による自動クリーンアップも内蔵されている。vitest-test-writer ではさらに、動的コンテンツ（タイムスタンプ、絶対パス等）の正規化手順も明記している。

**スナップショット失敗時の対応**: AGENTS.md では「スナップショットが失敗した場合、toContain に戻すのではなくスナップショットを更新せよ」と明記しており、AI が楽な方向に逃げるのを防いでいる。

### サブパスインポート規約

`AGENTS.md:87` で `@vitest/utils/*` からのサブパスインポートを強制し、メインエントリポイントからの直接インポートを禁止している。実際に `packages/` 配下では `@vitest/utils/helpers`, `@vitest/utils/diff`, `@vitest/utils/error`, `@vitest/utils/timers` 等のサブパスが一貫して使われている。`@vitest/utils` の package.json は `./diff`, `./error`, `./helpers`, `./constants`, `./timers`, `./offset`, `./resolver` のサブパスエクスポートを定義しており、パフォーマンスクリティカルなフレームワークとしてバンドルサイズを意識した設計になっている。

## コード例

エントリポイント層の全文（Hub-Spoke パターンの Hub 側）:

```markdown
// CLAUDE.md:1-10
# CLAUDE.md
This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
## Codebase Overview
Vitest is a next-generation testing framework powered by Vite. This is a monorepo using pnpm workspaces.
## Essential references
- Agent-specific guide: See [AGENTS.md](AGENTS.md)
```

禁止事項の記述スタイル（AGENTS.md からの引用）:

```markdown
// AGENTS.md:38
When writing tests, AVOID using `toContain` for validation. Prefer using
`toMatchInlineSnapshot` to include the test error and its stack. If snapshot
is failing, update the snapshot instead of reverting it to `toContain`.

// AGENTS.md:45
- **No mocking policy** - You must never mock anything in tests

// AGENTS.md:87-88
- Use utilities from `@vitest/utils/*` when available. Never import from
  `@vitest/utils` main entry point directly.
- Do not add comments explaining what the line does unless prompted to.
```

`testTree()` + `toMatchInlineSnapshot` の実践例（結果の構造的検証）:

```typescript
// test/cli/test/test-tags.test.ts:51-79
test('filters tests based on --tags-filter=!ignore', async () => {
  const { stderr, testTree } = await runVitest({
    root: './fixtures/test-tags',
    config: false,
    tags: [{ name: 'alone' }, { name: 'suite' }],
    tagsFilter: ['!suite_2'],
  })
  expect(stderr).toBe('')
  expect(testTree()).toMatchInlineSnapshot(`
    {
      "basic.test.ts": {
        "suite 1": {
          "suite 2": {
            "test 3": "skipped",
            "test 4": "skipped",
          },
          "test 1": "passed",
          "test 2": "passed",
        },
      },
    }
  `)
})
```

専門エージェントの委譲トリガー定義（YAML フロントマター内の description から抜粋）:

```yaml
# .claude/agents/vitest-test-writer.md:1-6
---
name: vitest-test-writer
description: "Use this agent when the user needs to write comprehensive tests
  for Vitest features..."
model: opus
---
```

## パターンカタログ

- **Facade パターン** (分類: 構造)
  - 解決する問題: 複数の AI ツールに対して統一的なガイドを提供する
  - 適用条件: 2つ以上の AI ツールが同一リポジトリで使われる場合
  - コード例: `CLAUDE.md` → `AGENTS.md` ← `.github/copilot-instructions.md`
  - 注意点: Hub ファイルにツール固有の指示を追加する誘惑に注意。共通部分は必ず Spoke に集約する

- **Delegation パターン** (分類: 振る舞い)
  - 解決する問題: メインエージェントがドメイン固有の作業（テスト作成）の詳細を把握する必要がある
  - 適用条件: 特定ドメインに特化した作業を Task agent に委譲したい場合
  - コード例: `.claude/agents/vitest-test-writer.md` — description に3つの具体的な委譲シナリオを例示
  - 注意点: 専門エージェントは親エージェントの全コンテキストを持たないため、自己完結した指示が必要

## Good Patterns

- **禁止事項のホワイトリスト化**: 「やってはいけないこと」を具体的に列挙する。AI エージェントは曖昧な推奨より明確な禁止に従いやすい。Vitest では少なくとも4つの明示的禁止（モック禁止、toContain 禁止、メインエントリインポート禁止、不要コメント禁止）がある

```markdown
// AGENTS.md:45 — 断定的な禁止表現
- **No mocking policy** - You must never mock anything in tests

// 対比: 曖昧な推奨（vitest は使っていない）
- Try to avoid mocking when possible.
```

- **専用ユーティリティの名前・パス・選択基準の明示**: AI がテストを書く際に使うべきユーティリティを、インポートパスと判断基準付きで列挙する

```markdown
// AGENTS.md:43-44
- **`runInlineTests`** from `test/test-utils/index.ts` - You must use this
  for complex file system setups (>1 file)
- **`runVitest`** from `test/test-utils/index.ts` - You can use this to run
  Vitest programmatically
```

- **専門エージェントへの例示付き description**: vitest-test-writer の YAML フロントマターに3つの具体的シナリオを記載し、メインエージェントが適切なタイミングで委譲できるようにしている。各例に `<commentary>` を添えて判断基準を明示するメタ的な設計

- **コマンドの完全列挙**: テスト実行コマンドを用途別に全パターン列挙（全テスト、特定スイート、コアテスト、ブラウザテスト）し、AI の推測・捏造リスクを排除する

## Anti-Patterns / 注意点

- **ガイドの分散管理**: AI ツールごとに独立したガイドを書き、内容が乖離する

```markdown
<!-- Bad: ツールごとに独立したルール -->
# CLAUDE.md
テストには toMatchInlineSnapshot を使ってください。モックは禁止です。
# .github/copilot-instructions.md
テストには toBe を使ってください。必要に応じてモックしてください。
```

```markdown
<!-- Better: 共通ガイドに一元化 -->
# CLAUDE.md
- Agent-specific guide: See [AGENTS.md](AGENTS.md)
# .github/copilot-instructions.md
- Agent-specific guide: See [AGENTS.md](../AGENTS.md)
# AGENTS.md (単一の情報源)
テストには toMatchInlineSnapshot を使ってください。モックは禁止です。
```

- **曖昧な推奨表現**: 「できるだけ避ける」「可能な限り」等の表現は AI に判断余地を残し、品質が不安定になる

```markdown
<!-- Bad -->
Try to avoid mocking when possible.
<!-- Better -->
**No mocking policy** - You must never mock anything in tests
```

- **スナップショット失敗時の toContain 退避**: AI はスナップショットが失敗すると `toContain` に書き換えて「テストを通す」ことを優先しがち。AGENTS.md はこの退避を明示的に禁止している

```markdown
<!-- Bad: スナップショット失敗 → toContain に退避 -->
expect(stderr).toContain('Error: something went wrong')

<!-- Better: スナップショットを更新 -->
expect(stderr).toMatchInlineSnapshot(`"Error: something went wrong..."`)
```

## 導出ルール

- `[MUST]` AI エージェント向けガイドでは禁止事項を「must never」「AVOID」等の断定的表現で記述する — 曖昧な推奨（「try to」「when possible」）は AI に判断余地を残し品質が不安定になる
  - 根拠: AGENTS.md の「You must never mock anything」「AVOID using toContain」が AI の逸脱を防いでいる

- `[MUST]` 複数の AI ツールを併用する場合、共通ガイドを単一ファイルに集約し、ツール固有ファイルからはリンクのみとする（Hub-Spoke 構造）
  - 根拠: CLAUDE.md(11行) と copilot-instructions.md(11行) が同一の AGENTS.md(150行) を参照し、情報の一元管理を実現している

- `[MUST]` AI ガイドにはプロジェクト固有のユーティリティ名・インポートパス・使い分け基準を明示する — AI が推測・捏造するリスクを排除する
  - 根拠: AGENTS.md が `runInlineTests` と `runVitest` を具体パス付きで列挙し、選択基準（「複数ファイル構成 → runInlineTests」）を添えている

- `[SHOULD]` AI エージェント向けガイドは「セットアップ → テスト → 構造 → 規約」の優先度順に配置し、最初に必要な情報をトークン制限内で取得できるようにする
  - 根拠: AGENTS.md がこの順序を採用しており、AI がまずビルド・テスト手順を把握してから詳細な規約に進める

- `[SHOULD]` 専門エージェント（.claude/agents/）の description には具体的な使用シナリオを複数例示し、委譲判断をメインエージェントに委ねる
  - 根拠: vitest-test-writer.md のフロントマターに3つの具体例（新関数、CLI フラグ、マルチモード）が記載されている

- `[SHOULD]` テスト出力の検証には部分一致ではなくインラインスナップショットを使い、動的コンテンツは正規化ヘルパーで安定化する
  - 根拠: `test/test-utils/index.ts` の `replaceRoot` 等のヘルパーでパスを正規化し、`testTree()` / `errorTree()` で結果を構造化してからスナップショット検証している

- `[AVOID]` AI ガイドに実装の網羅的解説を書く — AI が参照するのはコード変更時の判断基準であり、アーキテクチャ文書ではない
  - 根拠: AGENTS.md はパッケージ一覧を簡潔に列挙するが内部設計には踏み込まない。判断に必要な情報（テスト配置先ルール、ビルド手順）のみ記載

- `[AVOID]` サブパスエクスポートを持つパッケージのメインエントリポイントからインポートする — バンドルサイズの肥大化とツリーシェイキングの阻害を招く
  - 根拠: AGENTS.md:87 の規約と、packages/ 配下での `@vitest/utils/helpers`, `@vitest/utils/diff` 等の一貫したサブパスインポート使用

## 適用チェックリスト

- [ ] CLAUDE.md / copilot-instructions.md が薄いエントリポイント（概要 + 参照リンクのみ）になっているか
- [ ] 複数 AI ツール対応時に共通ガイド（AGENTS.md）を一元化しているか
- [ ] AI ガイドの禁止事項が「must never」「AVOID」等の断定的表現で書かれているか
- [ ] プロジェクト固有のテストユーティリティ・ヘルパー関数の名前とインポートパスを明示しているか
- [ ] 頻出コマンドが用途別に全パターン列挙されているか
- [ ] 専門的な作業を .claude/agents/ で委譲可能にしているか（description に具体的シナリオを例示）
- [ ] AI が生成しがちな低品質パターン（過剰コメント、安易なモック、部分一致アサーション）への対策が明記されているか
- [ ] ガイドの情報が優先度順に配置されているか（セットアップ → テスト → 構造 → 規約）
