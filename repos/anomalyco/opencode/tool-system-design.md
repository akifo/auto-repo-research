# tool-system-design

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

AI コーディングエージェントにおけるツールシステムの設計を分析する。opencode は 20 以上の組み込みツールと、プラグイン・カスタムファイルによる拡張機構を持つ。注目すべきは、ツール定義・レジストリ・権限制御・出力トランケーションの各関心事が明確に分離され、単一の `Tool.define()` ファクトリと `ToolRegistry` 名前空間だけで全体が統合されている点にある。フィーチャーフラグ・モデル種別・エージェント権限に基づくツールの動的フィルタリングも、レジストリ層に集約されている。

## 背景にある原則

- **定義と実行の分離（Lazy Init パターン）**: ツールは `id` と `init` 関数のペアとして定義され、実行時まで description やパラメータが確定しない。これにより、ランタイム情報（作業ディレクトリ、利用可能なエージェント一覧など）をツール説明文に動的に埋め込める。起動コストの遅延にもなる。
  - 根拠: `tool.ts:48-88` の `Tool.define` と、`bash.ts:60` の `DESCRIPTION.replaceAll("${directory}", Instance.directory)` による動的テンプレート展開

- **Cross-Cutting Concern の透過的注入**: バリデーション・出力トランケーション・権限チェックをツール実装の外側で処理する。個々のツール実装はビジネスロジックだけに集中できる。
  - 根拠: `tool.ts:57-82` で `Tool.define` がバリデーションとトランケーションをラップ。各ツールの `execute` 内で `ctx.ask()` を呼ぶことで権限チェックをパターン化

- **プロトコルの統一による拡張性**: 組み込みツール・プラグインツール・カスタムファイルツールすべてが同一の `Tool.Info` インターフェースに準拠する。レジストリは出自を区別しない。
  - 根拠: `registry.ts:64-86` の `fromPlugin` が `ToolDefinition` を `Tool.Info` に変換し、組み込みツールと同列に扱う

- **フェイルセーフなツール呼び出し**: 不正な引数で呼ばれた場合に `InvalidTool` がフォールバックとして機能し、LLM にリカバリ指示を返す。クラッシュではなく構造化エラーで応答する。
  - 根拠: `invalid.ts:4-17` の InvalidTool 定義と、`tool.ts:64-67` のバリデーションエラーメッセージ

## 実例と分析

### ツール定義の二つの形態

`Tool.define` は同期的なオブジェクトリテラルと非同期の init 関数の両方を受け付ける。単純なツールはオブジェクトで、動的な情報が必要なツールは関数で定義する。

```typescript
// packages/opencode/src/tool/tool.ts:48-51
export function define<Parameters extends z.ZodType, Result extends Metadata>(
  id: string,
  init: Info<Parameters, Result>["init"] | Awaited<ReturnType<Info<Parameters, Result>["init"]>>,
): Info<Parameters, Result>;
```

静的定義の例（grep ツール）:

```typescript
// packages/opencode/src/tool/grep.ts:15
export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z.object({ ... }),
  async execute(params, ctx) { ... },
})
```

動的定義の例（task ツール、利用可能エージェント一覧を description に注入）:

```typescript
// packages/opencode/src/tool/task.ts:27-41
export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents
  const description = DESCRIPTION.replace("{agents}", accessibleAgents.map(...).join("\n"))
  return { description, parameters, async execute(...) { ... } }
})
```

### レジストリによるツールの動的フィルタリング

`ToolRegistry.tools()` はモデル種別とエージェント情報を受け取り、利用可能なツール集合を動的に決定する。フィーチャーフラグ、モデル互換性、設定によるフィルタリングがこの一箇所に集約されている。

```typescript
// packages/opencode/src/tool/registry.ts:131-172
export async function tools(model: { providerID: string; modelID: string }, agent?: Agent.Info) {
  const tools = await all()
  const result = await Promise.all(
    tools.filter((t) => {
      if (t.id === "codesearch" || t.id === "websearch") {
        return model.providerID === "opencode" || Flag.OPENCODE_ENABLE_EXA
      }
      const usePatch = model.modelID.includes("gpt-") && ...
      if (t.id === "apply_patch") return usePatch
      if (t.id === "edit" || t.id === "write") return !usePatch
      return true
    }).map(async (t) => { ... })
  )
}
```

### 三層の拡張メカニズム

1. **カスタムファイルツール**: `.opencode/tool/*.{js,ts}` に配置するだけで自動ロードされる（`registry.ts:40-52`）
2. **プラグインツール**: `@opencode-ai/plugin` の `tool()` ヘルパーで定義し、npm パッケージとしてインストール（`plugin/src/tool.ts:29-38`）
3. **プラグインフック**: `tool.definition` フックで既存ツールの description や parameters を実行時に書き換え可能（`registry.ts:162`）

### 出力トランケーションの設計

ツール出力が大きくなりすぎるとコンテキストウィンドウを圧迫するため、`Truncate` 名前空間で行数・バイト数の上限を設けている。トランケーション時はフルテキストをファイルに保存し、agent がファイルを読み返せるよう誘導メッセージを返す。

```typescript
// packages/opencode/src/tool/truncation.ts:97-99
const hint = hasTaskTool(agent)
  ? `...Full output saved to: ${filepath}\nUse the Task tool to have explore agent process this file...`
  : `...Full output saved to: ${filepath}\nUse Grep to search the full content or Read with offset/limit...`;
```

ツールが独自にトランケーションを処理する場合は `metadata.truncated` を設定することで、`Tool.define` のラッパーがスキップする（`tool.ts:71-72`）。

### 権限システムとの統合

各ツールは `ctx.ask()` で権限チェックを要求する。パターンベースのマッチングにより、ファイルパス・コマンド・URL 単位で `allow/deny/ask` を制御できる。

```typescript
// packages/opencode/src/tool/webfetch.ts:27-36
await ctx.ask({
  permission: "webfetch",
  patterns: [params.url],
  always: ["*"],
  metadata: { url: params.url, format: params.format },
});
```

エージェントごとに権限ルールセットが設定され、サブエージェントにはタスクツール内で追加の制約が付与される（`task.ts:75-99`）。

## パターンカタログ

- **Registry パターン** (分類: 構造)
  - 解決する問題: 組み込み・プラグイン・カスタムのツール群を統一的に管理し、実行時条件に応じて提供するツール集合を決定する
  - 適用条件: ツール数が多く、利用可能性が実行時に変わるシステム
  - コード例: `registry.ts:34-173`
  - 注意点: レジストリが肥大化するため、フィルタリングロジックの分離を意識する

- **Factory Method パターン** (分類: 生成)
  - 解決する問題: ツール定義の構造を統一し、共通の前処理・後処理を透過的に注入する
  - 適用条件: 多数のオブジェクトが共通のライフサイクル（バリデーション、ラッピング）を持つ場合
  - コード例: `tool.ts:48-88` の `Tool.define`
  - 注意点: ファクトリの責務が増えすぎないよう、cross-cutting concern はミドルウェア的に分離する

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: テキスト検索の曖昧一致を複数のアルゴリズムで段階的に試行する
  - 適用条件: 同一インターフェースの異なるアルゴリズムをフォールバック順に適用する場合
  - コード例: `edit.ts:624-634` の Replacer チェーン（SimpleReplacer → LineTrimmedReplacer → BlockAnchorReplacer → ...）

## Good Patterns

- **説明文の外部ファイル分離**: ツールの description を `.txt` ファイルに分離し、TypeScript の `import DESCRIPTION from "./bash.txt"` で読み込む。LLM 向けプロンプトとコードロジックが混在せず、非エンジニアでも description の改善に参加しやすい。

```typescript
// packages/opencode/src/tool/bash.ts:5
import DESCRIPTION from "./bash.txt";
// ...
description: DESCRIPTION.replaceAll("${directory}", Instance.directory);
```

- **Zod スキーマによるパラメータ定義とバリデーション一体化**: パラメータの型定義・バリデーション・LLM への schema 提供が一つの Zod スキーマで完結する。`describe()` メソッドで各フィールドの説明も付与でき、LLM のツール呼び出し精度向上に寄与する。

```typescript
// packages/opencode/src/tool/bash.ts:63-77
parameters: z.object({
  command: z.string().describe("The command to execute"),
  timeout: z.number().describe("Optional timeout in milliseconds").optional(),
  workdir: z.string().describe(`The working directory...`).optional(),
  description: z.string().describe("Clear, concise description of what this command does..."),
});
```

- **InvalidTool によるグレースフルデグラデーション**: LLM が存在しないツールや不正引数でツールを呼んだ場合に、例外ではなく構造化されたエラーメッセージを返すことで、LLM が自律的にリカバリできる。

```typescript
// packages/opencode/src/tool/invalid.ts:4-17
export const InvalidTool = Tool.define("invalid", {
  description: "Do not use",
  parameters: z.object({ tool: z.string(), error: z.string() }),
  async execute(params) {
    return {
      title: "Invalid Tool",
      output: `The arguments provided to the tool are invalid: ${params.error}`,
      metadata: {},
    };
  },
});
```

- **バッチツールによるメタ実行**: `BatchTool` は他のツールをまとめて並列実行するメタツールで、自身や再帰呼び出しは `DISALLOWED` セットで禁止している。ツール実行結果を集約し、成功/失敗のサマリーを返す。

```typescript
// packages/opencode/src/tool/batch.ts:5-6
const DISALLOWED = new Set(["batch"]);
const FILTERED_FROM_SUGGESTIONS = new Set(["invalid", "patch", ...DISALLOWED]);
```

## Anti-Patterns / 注意点

- **フィルタリングロジックのレジストリ集中**: モデル種別判定（`gpt-` を含むか等）がレジストリに直接ハードコードされている。ツール数やモデル数が増えると条件分岐が複雑化する。

```typescript
// Bad: registry.ts:148-151
const usePatch = model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4");
if (t.id === "apply_patch") return usePatch;
if (t.id === "edit" || t.id === "write") return !usePatch;
```

```typescript
// Better: ツール側に互換性情報を持たせる
export const ApplyPatchTool = Tool.define("apply_patch", {
  compatibility: { models: ["gpt-3.5*"], exclusive: ["edit", "write"] },
  // ...
});
```

- **トランケーション二重処理の暗黙的スキップ**: `metadata.truncated !== undefined` でトランケーション済みかを判定しているが、この規約はコメントでしか説明されていない。型レベルで強制されないため、新しいツール実装者が意図せずトランケーションをスキップまたは二重適用するリスクがある。

```typescript
// Bad: tool.ts:71
if (result.metadata.truncated !== undefined) {
  return result; // skip truncation for tools that handle it themselves
}
```

```typescript
// Better: 明示的な型で表現する
type ToolResult =
  | { output: string; metadata: M; skipTruncation?: never; }
  | { output: string; metadata: M & { truncated: boolean; }; skipTruncation: true; };
```

## 導出ルール

- `[MUST]` ツールの定義インターフェースを統一し、組み込み・プラグイン・ユーザ定義のすべてが同一の型に準拠するようにする
  - 根拠: opencode では `Tool.Info` インターフェースに統一することで、レジストリが出自を区別せずツールを管理できている（`registry.ts:64-86`）

- `[MUST]` ツール実行の前処理・後処理（バリデーション、出力制限、ログ等）はファクトリまたはミドルウェアで一元化し、個々のツール実装に委ねない
  - 根拠: `Tool.define` が Zod バリデーションとトランケーションを自動ラップし、全ツールに一貫した振る舞いを保証している（`tool.ts:54-87`）

- `[SHOULD]` ツールの説明文（LLM 向けプロンプト）はコードから分離し、テンプレート変数で実行時情報を埋め込む
  - 根拠: `.txt` ファイルに description を分離し `${directory}` 等のプレースホルダで動的情報を注入するパターンが全 20+ ツールで一貫して使われている（`bash.ts:60-61`）

- `[SHOULD]` LLM がツールを不正に呼び出した場合のフォールバックツールを用意し、クラッシュではなく構造化エラーメッセージで LLM にリカバリを促す
  - 根拠: `InvalidTool` が不正ツール呼び出しを捕捉し、LLM が再試行可能なエラーメッセージを返す（`invalid.ts:4-17`）

- `[SHOULD]` ツールの利用可否判定（権限・フィーチャーフラグ・モデル互換性）はレジストリ層に集約し、ツール実装側からは関心を分離する
  - 根拠: `ToolRegistry.tools()` がフィーチャーフラグ・モデル種別・権限による動的フィルタリングを一箇所で処理している（`registry.ts:131-172`）

- `[AVOID]` ツール出力をそのままコンテキストウィンドウに流すこと。大きな出力は要約またはファイル保存＋参照誘導で処理する
  - 根拠: `Truncate.output` が行数・バイト数制限を超えた出力をファイルに保存し、ツール使用を促すヒントメッセージを返す（`truncation.ts:51-106`）

## 適用チェックリスト

- [ ] ツール定義に統一インターフェース（id + init/定義オブジェクト）を導入しているか
- [ ] バリデーション・出力制限等の cross-cutting concern をツール定義ファクトリまたはミドルウェアで一元処理しているか
- [ ] ツールの description を外部ファイルに分離し、コードとプロンプトの関心を分けているか
- [ ] Zod 等のスキーマライブラリでパラメータ定義・バリデーション・LLM schema 生成を一体化しているか
- [ ] 不正なツール呼び出しに対するフォールバック機構（InvalidTool 相当）を用意しているか
- [ ] ツールの利用可否判定をレジストリ層に集約し、条件分岐の散在を防いでいるか
- [ ] プラグイン・カスタムツールの拡張ポイントを用意し、コアコードを変更せずにツールを追加できるか
- [ ] 大量出力のトランケーション戦略（ファイル保存 + 参照誘導）を実装しているか
