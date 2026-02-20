# AI 設定ファイル（AGENTS.md）

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs は 450 行の包括的な `AGENTS.md` を配置し、AI コーディングエージェント向けのガイドラインを一元化している。CLAUDE.md や .cursorrules は存在せず、AGENTS.md が唯一の AI 設定ファイルとして機能する。注目すべきは、既存の `CONTRIBUTING.md`（289行）や `.github/contributing/INTEGRATIONS.md`（156行）とは明確に役割を分けている点で、人間向けドキュメントとの重複を最小限に抑えながら AI エージェントに必要な情報密度を達成している。13 のトップレベルセクションで構成され、「プロジェクト概要 → リポ構造 → 開発セットアップ → コーディング規約 → コア抽象化 → テスト → インテグレーション作成 → ベストプラクティス → PR チェックリスト → デバッグ → リソース」という一貫した流れを持つ。

## 背景にある原則

- **AI エージェントには「なぜ」より「何をすべきか」が重要**: CONTRIBUTING.md が貢献の動機付けや哲学的な説明を含むのに対し、AGENTS.md は即座にアクション可能な指示に集中している。たとえば `instanceof` 禁止ルールについて CONTRIBUTING.md は言及していないが、AGENTS.md は `No instanceof - Use type guards instead (no-instanceof/no-instanceof: error)` と ESLint ルール名まで明記し、代替手段（`AIMessage.isInstance(message)`）も示している（`AGENTS.md:122-123`）。
- **コード例はコピーペースト可能な粒度で提供する**: AGENTS.md のコード例は全て実行可能な import 文から始まり、省略なしで完結している。`Runnable` の使い方（`AGENTS.md:173-178`）、テストの書き方（`AGENTS.md:224-231`）、いずれもファイルに貼り付けてそのまま動くレベルの完結性がある。これは AI エージェントがコード生成する際に、不完全な例から誤ったコードを補完するリスクを減らす設計。
- **プロジェクト固有の落とし穴を明示する**: ESLint の `no-instanceof` ルール、`process.env` 禁止、`.js` 拡張子必須など、一般的な TypeScript プロジェクトとは異なるルールを冒頭近くに配置している。AI エージェントが生成しがちな `instanceof` チェックや `process.env` 直接参照を事前に防止する意図がある（`internal/eslint/src/configs/base.ts:102-103`）。
- **階層的な情報構造で必要な深さまで掘り下げられるようにする**: トップレベルで全体像を示し、各セクション内で具体的なコード例やパスを提供する。テストの分類（unit/integration/type/standard）を一覧した上で、それぞれのサンプルコードを個別に示す構造（`AGENTS.md:159-283`）。

## 実例と分析

### セクション構成と情報密度の設計

AGENTS.md は 13 のトップレベルセクション（`##` 見出し 13 個）を持ち、49 個のサブセクション（`###` 以下）を含む。450 行のうち約 35% がコードブロックで占められている。

この構成を CONTRIBUTING.md と比較すると対照的な設計が見える:

| 観点               | AGENTS.md         | CONTRIBUTING.md          |
| ------------------ | ----------------- | ------------------------ |
| 行数               | 450               | 289                      |
| コードブロック比率 | 約 35%            | 約 15%                   |
| 対象読者           | AI エージェント   | 人間のコントリビューター |
| トーン             | 指示的・宣言的    | 歓迎的・説明的           |
| ESLint ルール      | 6 個を列挙 + 理由 | 「lint を実行せよ」のみ  |

CONTRIBUTING.md が「Welcome! Thank you for your interest in contributing」で始まるのに対し、AGENTS.md は「This document provides guidance for AI coding agents working with the LangChain.js codebase.」と単刀直入に始まる。感情的な装飾を省き、機械が解釈しやすい構造にしている。

### ESLint ルールの明示化パターン

AGENTS.md は ESLint の重要ルール 6 個を番号付きリストで明記している（`AGENTS.md:122-129`）。実際の ESLint 設定ファイル（`internal/eslint/src/configs/base.ts`）には数十のルールがあるが、AI エージェントが違反しやすいものだけを抽出している:

```typescript
// internal/eslint/src/configs/base.ts:102-103
"no-instanceof/no-instanceof": "error",
"no-process-env": "error",
```

特に `no-instanceof` は langchainjs 固有の要求であり、一般的な TypeScript プロジェクトでは使わないプラグイン。コードベース内で `eslint-disable no-instanceof/no-instanceof` が 9 ファイルで使われている事実は、このルールが厳格に運用されている証拠であると同時に、例外的なケース（主に `libs/langchain/src/agents/` 配下）も存在することを示している。

AGENTS.md はこのルールに対して `isInstance` 静的メソッドという代替手段を具体的に提示している:

```typescript
// AGENTS.md:123 で言及されたパターン
// 実際の実装: libs/langchain-core/src/messages/base.ts:351-358
static isInstance(obj: unknown): obj is BaseMessage {
  return (
    typeof obj === "object" &&
    obj !== null &&
    MESSAGE_SYMBOL in obj &&
    obj[MESSAGE_SYMBOL] === true &&
    isMessage(obj)
  );
}
```

このパターンは `Symbol.for()` ベースのブランディングシステム（`libs/langchain-core/src/utils/namespace.ts`）で実装されており、`instanceof` が機能しないクロス環境問題（npm の重複パッケージ、ESM/CJS 混在）を解決している。

### 環境変数アクセスのラッパーパターン

AGENTS.md は `process.env` の直接参照を禁止し、`getEnvironmentVariable` ユーティリティの使用を指示している（`AGENTS.md:380-384`）。実装を見ると、このラッパーは Deno/ブラウザ/Node.js のマルチランタイム対応を隠蔽している:

```typescript
// libs/langchain-core/src/utils/env.ts:78-93
export function getEnvironmentVariable(name: string): string | undefined {
  try {
    if (typeof process !== "undefined") {
      // eslint-disable-next-line no-process-env
      return process.env?.[name];
    } else if (isDeno()) {
      return Deno?.env.get(name);
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }
}
```

ESLint の `no-process-env` ルール（`internal/eslint/src/configs/base.ts:103`）がこれを強制し、テストファイルではルールを無効化（`:154`）している。AI エージェントがテスト以外のコードで `process.env` を書いてしまう典型的なミスを防ぐ仕組み。

### パッケージ構造テンプレートの提示

AGENTS.md はプロバイダーパッケージのディレクトリ構造を ASCII ツリーで示している（`AGENTS.md:293-312`）。実際の `langchain-anthropic` パッケージの構造と照合すると、`turbo.json` は実際には存在しないものの、その他のファイル（`tsdown.config.ts`, `vitest.config.ts`, `eslint.config.ts`）は一致している。

```
# AGENTS.md が示す構造
libs/providers/langchain-{provider}/
├── package.json
├── tsconfig.json
├── tsdown.config.ts       # 実在する
├── vitest.config.ts       # 実在する
├── eslint.config.ts       # 実在する
├── turbo.json             # 実在しない（微小な不一致）
├── README.md
├── LICENSE
└── src/
```

### コア抽象化の Import パスガイド

AGENTS.md の「Core Abstractions」セクション（`AGENTS.md:167-217`）は、各抽象クラスの正確な import パスを示している。これは AI エージェントにとって極めて重要な情報で、モノレポ内のどのパッケージからどのクラスを import すべきかを明確にしている:

```typescript
// AGENTS.md:173-178 — Runnable の import 例
import { Runnable, RunnableConfig, RunnableLike } from "@langchain/core/runnables";
```

パッケージ間の依存関係（`@langchain/core` が基盤、プロバイダーは `peerDependencies` で依存）と、ビルド順序（`@langchain/core` を先にビルドする必要がある）も明記されており、AI エージェントが正しい依存グラフを理解できるようになっている。

### 標準テストスイートによるインテグレーション品質保証

AGENTS.md はテストファイルの命名規則を 4 種類定義している（`AGENTS.md:159-163`）:

- `*.test.ts` — ユニットテスト
- `*.int.test.ts` — インテグレーションテスト
- `*.test-d.ts` — 型テスト
- `*.standard.test.ts` / `*.standard.int.test.ts` — 標準テストスイート

実際の `langchain-anthropic` プロバイダーでは全 4 種類が存在しており（`libs/providers/langchain-anthropic/src/tests/`）、標準テストは `ChatModelUnitTests` を継承する形で実装されている:

```typescript
// libs/providers/langchain-anthropic/src/tests/chat_models.standard.test.ts:5-14
class ChatAnthropicStandardUnitTests extends ChatModelUnitTests<
  ChatAnthropicCallOptions,
  AIMessageChunk
> {
  constructor() {
    super({
      Cls: ChatAnthropic,
      chatModelHasToolCalling: true,
      chatModelHasStructuredOutput: true,
      constructorArgs: {},
    });
  }
}
```

## パターンカタログ

- **Symbol-based Branding** (分類: 構造パターン / instanceof 代替)
  - 解決する問題: `instanceof` がクロス環境（ESM/CJS 混在、npm の重複パッケージ）で機能しない問題
  - 適用条件: ライブラリが複数のバンドル形式で配布される場合、または npm の重複インストールが起こりうる場合
  - コード例: `libs/langchain-core/src/utils/namespace.ts:114-160`
  - 注意点: `Symbol.for()` はグローバルレジストリなので、名前空間の衝突に注意が必要

- **Template Method** (分類: GoF 振る舞いパターン)
  - 解決する問題: 複数のプロバイダーが共通のテストインターフェースに準拠する必要がある
  - 適用条件: プラグインアーキテクチャで各プラグインの品質を統一的に検証したい場合
  - コード例: `internal/standard-tests/src/unit_tests/chat_models.ts:37-41`, `libs/providers/langchain-anthropic/src/tests/chat_models.standard.test.ts:5-14`
  - 注意点: 標準テストクラスの変更が全プロバイダーに影響するため、後方互換性の維持が重要

## Good Patterns

- **AI 専用ガイドと人間向けガイドの分離**: AGENTS.md は AI エージェント専用、CONTRIBUTING.md は人間の開発者専用として明確に分離している。これにより、AI 向けには冗長な説明や社交的な表現を省き、コード例とルールに集中した高密度な文書を実現している。重複する情報（リポ構造、テスト手順）も AI エージェントが一箇所で完結できるよう再構成されている。

```markdown
<!-- AGENTS.md — 指示的・宣言的 -->

# AGENTS.md - AI Agent Guidelines for LangChain.js

This document provides guidance for AI coding agents working with the LangChain.js codebase.

<!-- CONTRIBUTING.md — 歓迎的・説明的 -->

# Contributing to LangChain

Welcome! Thank you for your interest in contributing.
```

- **禁止ルールに代替手段をセットで提示**: `instanceof` 禁止に対して `isInstance` 静的メソッド、`process.env` 禁止に対して `getEnvironmentVariable` ユーティリティを提示。禁止だけでなく「代わりにこうする」を示すことで、AI エージェントが正しいコードを生成できる。

```markdown
<!-- AGENTS.md:122-123 -->

1. **No `instanceof`** - Use type guards instead
   - For LangChain messages, use the static `isInstance` method,
     e.g. `AIMessage.isInstance(message)`
```

- **パッケージフィルタ構文の明示**: モノレポ特有の `pnpm --filter <package>` 構文を、よく使うパッケージ名と共に列挙している（`AGENTS.md:67-70`）。AI エージェントがコマンドを実行する際に正しいフィルタを使えるようになる。

```bash
# AGENTS.md:67-70
--filter langchain        # the main `langchain` package
--filter @langchain/core  # the core package
--filter @langchain/community # community integrations
```

## Anti-Patterns / 注意点

- **ドキュメントと実態の乖離**: AGENTS.md が示すプロバイダーパッケージ構造に `turbo.json` が含まれているが、実際のプロバイダーパッケージ（`langchain-anthropic` 等）には存在しない。AI 設定ファイルの内容はコードの実態と同期が取れていないとエージェントが存在しないファイルを参照したり、不正確なスキャフォールディングを行うリスクがある。

```markdown
<!-- Bad: AGENTS.md が示す構造に turbo.json が含まれる -->

libs/providers/langchain-{provider}/
├── turbo.json # 実際には存在しない

<!-- Better: 実在するファイルのみ列挙し、定期的にスクリプトで検証する -->
```

- **エラーハンドリングガイドの不正確さ**: AGENTS.md のエラーハンドリングセクション（`AGENTS.md:388-394`）は `throw new Error("...", { cause: { lc_error_code: "..." } })` と記述しているが、実際のコードベースでは `addLangChainErrorFields` ユーティリティや `LangChainError` サブクラスを使う新しいパターンに移行している（`libs/langchain-core/src/errors/index.ts`）。古い情報が残っているとエージェントが非推奨のパターンを生成する。

```typescript
// Bad: AGENTS.md:390-393 が示すパターン
throw new Error("Model authentication failed", {
  cause: { lc_error_code: "MODEL_AUTHENTICATION" },
});

// Better: 実際のコードベースが使う新しいパターン
// libs/langchain-core/src/errors/index.ts:48
export class LangChainError extends ns.brand(Error) { ... }
export class ContextOverflowError extends ns.brand(LangChainError, "context-overflow") { ... }
```

## 導出ルール

- `[MUST]` AI 設定ファイルでルールを禁止する場合、代替手段をコード例付きで必ず併記する
  - 根拠: langchainjs の AGENTS.md は `instanceof` 禁止に `isInstance` メソッド、`process.env` 禁止に `getEnvironmentVariable` を対で提示し、エージェントが禁止ルールに遭遇したときに正しいコードを生成できるようにしている（`AGENTS.md:122-129`）

- `[MUST]` AI 設定ファイルの import パスやファイル構造は実際のコードベースと一致させ、定期的に検証する
  - 根拠: AGENTS.md のプロバイダー構造に `turbo.json` が含まれるが実際には存在しない不一致がある。エラーハンドリングの例も実コードと乖離しており、エージェントが不正確なコードを生成するリスクがある

- `[SHOULD]` AI 設定ファイルは人間向けドキュメント（CONTRIBUTING.md 等）とは別ファイルにし、AI エージェントが必要とする情報密度に最適化する
  - 根拠: langchainjs は AGENTS.md（コード例 35%、指示的トーン）と CONTRIBUTING.md（歓迎的トーン、プロセス説明中心）を分離し、それぞれの読者に最適化している

- `[SHOULD]` モノレポの AI 設定ファイルでは、パッケージフィルタ構文とビルド順序の依存関係を明記する
  - 根拠: langchainjs の AGENTS.md は `pnpm --filter @langchain/core build` を最初に実行する必要があることを明示し（`AGENTS.md:57-58`）、AI エージェントが正しい順序でビルドコマンドを実行できるようにしている

- `[SHOULD]` AI 設定ファイルでは、プロジェクト固有の ESLint カスタムルールを「一般的な TypeScript プロジェクトとの差分」として明示する
  - 根拠: `no-instanceof` や `no-process-env` のようなプロジェクト固有ルールは AI エージェントのデフォルト知識にないため、違反コードが生成されやすい。ESLint ルール名まで記載することで IDE 連携やコード修正の精度が上がる（`AGENTS.md:119-129`）

- `[SHOULD]` AI 設定ファイルのコード例は import 文を含め完結させ、省略記号（`...`）を使わない
  - 根拠: langchainjs の AGENTS.md は全てのコード例が import 文から始まり、そのままファイルにコピーして動作する粒度になっている。不完全な例から AI が誤った補完をするリスクを低減している

- `[AVOID]` AI 設定ファイルに非推奨または移行途中のパターンをサンプルコードとして掲載すること
  - 根拠: AGENTS.md のエラーハンドリング例（`cause: { lc_error_code }` パターン）は `@deprecated` マークされた `addLangChainErrorFields` に対応しており、新しい `LangChainError` サブクラスパターンと乖離している（`libs/langchain-core/src/errors/index.ts:17`）

## 適用チェックリスト

- [ ] AI 設定ファイル（AGENTS.md / CLAUDE.md）がプロジェクトに存在するか
- [ ] 禁止ルールごとに代替手段がコード例付きで記載されているか
- [ ] コード例に import 文が含まれ、コピーペーストで動作する完結性があるか
- [ ] ファイル構造やパスの記載が実際のコードベースと一致しているか（CI で自動検証するのが理想）
- [ ] モノレポの場合、パッケージフィルタ構文とビルド依存順序が明記されているか
- [ ] プロジェクト固有の ESLint ルールや lint 設定の差分が明示されているか
- [ ] 人間向けドキュメント（CONTRIBUTING.md）と AI 設定ファイルの役割分担が明確か
- [ ] AI 設定ファイルのサンプルコードが非推奨パターンを含んでいないか（定期的にレビュー）
- [ ] テストの命名規則と分類が明記されているか
- [ ] コア抽象クラスの import パスが正確に記載されているか
