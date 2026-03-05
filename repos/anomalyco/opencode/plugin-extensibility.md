# plugin-extensibility

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

OpenCode は AI コーディングエージェントとしてプラグイン・カスタムツール・MCP サーバー・カスタムエージェント/コマンドという4層の拡張メカニズムを備えている。注目すべきは、すべての拡張ポイントが「フック付きパイプライン」パターンで統一されており、プラグインは input/output ペアを受け取って output を変異させるだけという極めてシンプルな API で LLM パイプラインの全段に介入できる点である。npm パッケージ・ローカルファイル・ビルトインの3つのロード経路を持ちながら、すべてが同一の `Hooks` インターフェースに収束する設計は、プラットフォーム拡張の模範的なアーキテクチャといえる。

## 背景にある原則

- **拡張の階層分離**: ユーザーのスキルレベルに応じた拡張ポイントを用意すべき。OpenCode はファイル配置だけで動くカスタムツール（低い参入障壁）、フックで LLM パイプラインに介入するプラグイン（中程度）、MCP プロトコルによる外部サービス統合（高度）と段階を分けている。これにより「ちょっとしたスクリプトを追加したい」から「認証フロー全体をカスタマイズしたい」まで、同一システム内で対応できる。
  - 根拠: カスタムツールは `.opencode/tools/` にファイルを置くだけ (`packages/opencode/src/tool/registry.ts:40-52`)、プラグインは `Hooks` インターフェースを返す関数 (`packages/plugin/src/index.ts:148-234`)

- **Output Mutation パターンによるフック合成**: フックは `(input, output) => Promise<void>` の形式で、output オブジェクトを直接変異させる。戻り値ではなく変異を使うことで、複数のプラグインが同じフックポイントで順次 output を修正でき、チェーンの組み立てが不要になる。
  - 根拠: `Plugin.trigger` は全フックを順次実行し、同じ output オブジェクトを渡し続ける (`packages/opencode/src/plugin/index.ts:106-121`)

- **設定の合成と優先度の明示**: 拡張設定はリモート → グローバル → プロジェクト → `.opencode/` → インライン → マネージド(企業)の順で合成され、後勝ちルールが明確に定義されている。プラグインの重複排除も名前ベースで行われ、ローカルが npm を上書きする。
  - 根拠: `Config.state` のコメント (`packages/opencode/src/config/config.ts:78-85`) と `deduplicatePlugins` (`packages/opencode/src/config/config.ts:497-515`)

- **プロトコル境界での抽象化**: MCP サーバーは標準プロトコルを介して接続され、内部ツールと同じ `Tool` インターフェースに変換される。プロトコル境界で抽象化することで、ローカル(stdio)/リモート(HTTP/SSE) の差異を吸収し、認証・タイムアウト・再接続を透過的に扱える。
  - 根拠: `convertMcpTool` が MCP の `Tool` 定義を AI SDK の `Tool` 型に変換 (`packages/opencode/src/mcp/index.ts:120-148`)

## 実例と分析

### 1. プラグインのライフサイクル管理

プラグインのロードは3経路に分かれるが、すべて最終的に同じ `Hooks[]` 配列に収束する。

1. **内部プラグイン** (`INTERNAL_PLUGINS`): `CodexAuthPlugin`, `CopilotAuthPlugin`, `GitlabAuthPlugin` が直接インポートされる
2. **npm プラグイン**: `BunProc.install` でパッケージを動的インストール後、`import()` で読み込む
3. **ローカルプラグイン**: `.opencode/plugins/` のファイルを `pathToFileURL` で動的インポート

重複防止策として、同一関数が default export と named export の両方で公開されているケースを `Set` で検出する:

```typescript
// packages/opencode/src/plugin/index.ts:82-86
const seen = new Set<PluginInstance>();
for (const [_name, fn] of Object.entries<PluginInstance>(mod)) {
  if (seen.has(fn)) continue;
  seen.add(fn);
  hooks.push(await fn(input));
}
```

### 2. フックポイントの設計 - パイプライン全段への介入

`Hooks` インターフェースは LLM パイプラインの全段にフックポイントを提供する:

| フックポイント                       | 介入段               | 用途                                     |
| ------------------------------------ | -------------------- | ---------------------------------------- |
| `chat.message`                       | メッセージ受信時     | ロギング、前処理                         |
| `chat.params`                        | LLM パラメータ送信前 | temperature/topP の動的調整              |
| `chat.headers`                       | HTTP ヘッダー        | 認証トークン挿入、プロバイダ固有ヘッダー |
| `tool.execute.before/after`          | ツール実行前後       | 引数の書き換え、結果の後処理             |
| `tool.definition`                    | ツール定義取得時     | description/parameters の動的変更        |
| `permission.ask`                     | 権限確認時           | 自動承認/拒否の制御                      |
| `shell.env`                          | シェル実行時         | 環境変数の注入                           |
| `experimental.chat.system.transform` | システムプロンプト   | プロンプトの動的変更                     |
| `experimental.session.compacting`    | コンパクション       | コンパクションプロンプトのカスタマイズ   |

```typescript
// packages/plugin/src/index.ts:148-234 (Hooks インターフェース, 抜粋)
export interface Hooks {
  "chat.params"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage; },
    output: { temperature: number; topP: number; topK: number; options: Record<string, any>; },
  ) => Promise<void>;
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string; },
    output: { args: any; },
  ) => Promise<void>;
}
```

### 3. カスタムツールの統合パス

カスタムツールは `@opencode-ai/plugin` の `tool()` ヘルパーで定義し、Zod スキーマでバリデーションされる。`ToolRegistry` がファイルシステムスキャンとプラグインの両方からツールを収集し、ビルトインツールと同じ配列にマージする:

```typescript
// packages/opencode/src/tool/registry.ts:40-61
const matches = await Config.directories().then((dirs) =>
  dirs.flatMap((dir) => Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }))
);
// ...
const plugins = await Plugin.list();
for (const plugin of plugins) {
  for (const [id, def] of Object.entries(plugin.tool ?? {})) {
    custom.push(fromPlugin(id, def));
  }
}
```

`fromPlugin` アダプタが `ToolDefinition` を内部の `Tool.Info` に変換し、ビルトインツールと同一のインターフェースで扱えるようにする。

### 4. MCP サーバー統合: トランスポートフォールバック

リモート MCP サーバーへの接続は StreamableHTTP → SSE の順でフォールバックし、認証状態も管理する:

```typescript
// packages/opencode/src/mcp/index.ts:365-442
const transports: Array<{ name: string; transport: TransportWithAuth }> = [
  { name: "StreamableHTTP", transport: new StreamableHTTPClientTransport(...) },
  { name: "SSE", transport: new SSEClientTransport(...) },
]
for (const { name, transport } of transports) {
  try {
    // ...
    await withTimeout(client.connect(transport), connectTimeout)
    break
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      // OAuth フローへの遷移
      pendingOAuthTransports.set(key, transport)
      status = { status: "needs_auth" }
      break
    }
  }
}
```

### 5. 自動依存関係管理

`.opencode/` ディレクトリに `package.json` がなくても、プラグインSDK の依存関係が自動的にインストールされる。バージョンは実行中の OpenCode バージョンに合わせて管理される:

```typescript
// packages/opencode/src/config/config.ts:248-278
export async function installDependencies(dir: string) {
  const targetVersion = Installation.isLocal() ? "*" : Installation.VERSION
  json.dependencies = {
    ...json.dependencies,
    "@opencode-ai/plugin": targetVersion,
  }
  await Filesystem.writeJson(pkg, json)
  // .gitignore も自動生成
  if (!hasGitIgnore)
    await Filesystem.write(gitignore, ["node_modules", "package.json", "bun.lock", ".gitignore"].join("\n"))
  await BunProc.run(["install", ...], { cwd: dir })
}
```

### 6. エージェント/コマンドの宣言的拡張

エージェントとコマンドは Markdown + YAML frontmatter で宣言的に定義される。ファイルシステムの規約（ディレクトリ名 = 種類、ファイル名 = 名前）だけで登録が完了し、コードは不要:

```typescript
// packages/opencode/src/config/config.ts:376-413
async function loadAgent(dir: string) {
  for (const item of await Glob.scan("{agent,agents}/**/*.md", { cwd: dir, ... })) {
    const md = await ConfigMarkdown.parse(item)
    const agentName = trim(file)
    const config = { name: agentName, ...md.data, prompt: md.content.trim() }
    const parsed = Agent.safeParse(config)
  }
}
```

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: 複数のプラグインが同一フックポイントに登録され、順次処理する必要がある
  - 適用条件: フックの実行順序が重要でない（または登録順でよい）場合
  - コード例: `packages/opencode/src/plugin/index.ts:112-119` - `trigger` が全フックを順次実行
  - 注意点: 各フックが output を変異させるため、実行順序に依存する副作用が生じうる

- **Adapter** (分類: 構造)
  - 解決する問題: プラグイン定義 (`ToolDefinition`) と内部ツール定義 (`Tool.Info`) のインターフェース差異
  - 適用条件: 外部APIの型を内部型に合わせる必要がある場合
  - コード例: `packages/opencode/src/tool/registry.ts:64-86` - `fromPlugin` アダプタ関数
  - 注意点: アダプタ層でのコンテキスト情報の欠落に注意（`as unknown as` キャストが存在）

- **Strategy** (分類: 振る舞い)
  - 解決する問題: MCP サーバーへの接続方式（stdio/HTTP/SSE）を実行時に選択
  - 適用条件: 同一目的に対して複数の実装手段があり、設定で切り替える場合
  - コード例: `packages/opencode/src/mcp/index.ts:341-487` - `local`/`remote` 分岐とフォールバック

## Good Patterns

- **Output Mutation Hook**: フック関数が `(input, output) => void` の形式で output を直接変異させるパターン。戻り値を合成する複雑さを回避しつつ、複数プラグインの順次適用を実現する。
  ```typescript
  // packages/opencode/src/plugin/index.ts:106-121
  export async function trigger<Name>(name: Name, input: Input, output: Output): Promise<Output> {
    for (const hook of await state().then((x) => x.hooks)) {
      const fn = hook[name];
      if (!fn) continue;
      await fn(input, output);
    }
    return output;
  }
  ```

- **Convention-over-Configuration ツール登録**: ファイル名がそのままツール名になり、ディレクトリが種類（tool/agent/command/plugin）を決定する。設定ファイルへの明示的な登録が不要。
  ```typescript
  // packages/opencode/src/tool/registry.ts:47-51
  const namespace = path.basename(match, path.extname(match));
  const mod = await import(pathToFileURL(match).href);
  for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
    custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def));
  }
  ```

- **Transport Fallback with Error Classification**: MCP 接続時にトランスポートを順番に試行し、エラーの種類（認証エラー vs 接続エラー）に応じて異なる復帰戦略を取る。
  ```typescript
  // packages/opencode/src/mcp/index.ts:396-429
  if (error instanceof UnauthorizedError) {
    // 認証が必要 → OAuth フローへ遷移
    pendingOAuthTransports.set(key, transport);
    status = { status: "needs_auth" };
    break; // フォールバックしない
  }
  // 他のエラー → 次のトランスポートを試行
  ```

- **Discriminated Union による状態モデリング**: MCP の接続状態を `discriminatedUnion` で厳密にモデリングし、各状態に応じた情報を型安全に保持する。
  ```typescript
  // packages/opencode/src/mcp/index.ts:66-108
  export const Status = z.discriminatedUnion("status", [
    z.object({ status: z.literal("connected") }),
    z.object({ status: z.literal("disabled") }),
    z.object({ status: z.literal("failed"), error: z.string() }),
    z.object({ status: z.literal("needs_auth") }),
    z.object({ status: z.literal("needs_client_registration"), error: z.string() }),
  ]);
  ```

## Anti-Patterns / 注意点

- **型安全性の妥協 (ts-expect-error の蓄積)**: プラグインフック呼び出しの型推論が複雑すぎるため `@ts-expect-error` で抑制している。「try-counter: 2」というコメントは、複数の開発者が修正を試みて諦めたことを示す。

  Bad:
  ```typescript
  // packages/opencode/src/plugin/index.ts:115-118
  // @ts-expect-error if you feel adventurous, please fix the typing
  // try-counter: 2
  await fn(input, output);
  ```

  Better: フックの型パラメータを名前ベースのレジストリでマッピングし、`trigger` のジェネリクスを簡潔にする。あるいはフック名ごとに個別の trigger 関数を codegen する。

- **Output Mutation の暗黙的依存**: 複数プラグインが同じ output フィールドを変異させる場合、実行順序に暗黙的に依存する。ドキュメントではロード順が定義されているが、プラグイン間の競合を検出する仕組みがない。

  Bad: 2つのプラグインが `output.headers["Authorization"]` を異なる値に設定 → 後勝ち
  Better: 競合検出メカニズム、またはフック優先度の明示的宣言を導入する

## 導出ルール

- `[MUST]` プラグインシステムの全フックポイントを単一インターフェースで定義し、型レベルで利用可能なフック名を制約する
  - 根拠: OpenCode の `Hooks` インターフェースは全フックポイントを1箇所に集約し、`trigger` 関数のジェネリクスでフック名の型安全性を保証している (`packages/plugin/src/index.ts:148-234`)

- `[SHOULD]` 拡張の参入障壁を段階的に設計する — ファイル配置だけで動く簡易拡張と、API を介した高度な拡張を分離する
  - 根拠: カスタムツールは `.opencode/tools/` にファイルを置くだけ、プラグインは `Hooks` を返す関数、MCP は外部プロセスと、3段階の参入障壁が設計されている

- `[SHOULD]` 外部拡張からの入力は内部インターフェースにアダプタで変換し、ビルトイン機能と同じコードパスで処理する
  - 根拠: `fromPlugin` アダプタが `ToolDefinition` を `Tool.Info` に変換し、ビルトインツールと同一配列にマージしている (`packages/opencode/src/tool/registry.ts:64-86`)

- `[SHOULD]` 拡張の依存関係はホストアプリが自動管理し、ユーザーに手動インストールを求めない
  - 根拠: `installDependencies` が `package.json` 生成・`bun install` 実行・`.gitignore` 生成を自動で行い、ユーザーはツールファイルを置くだけでよい (`packages/opencode/src/config/config.ts:248-278`)

- `[SHOULD]` フックの入力(read-only context)と出力(mutable result)を明示的に分離し、フック関数が何を変更できるかを型で制約する
  - 根拠: `Hooks` の各フックは `(input: ReadonlyContext, output: MutableResult) => Promise<void>` の形式で、変更可能な範囲を output に限定している

- `[AVOID]` プラグインの動的インポート時に、同一モジュールの複数エクスポートを重複初期化すること
  - 根拠: `default` と named export が同一関数を指すケースを `Set` で検出して回避している (`packages/opencode/src/plugin/index.ts:82-86`)

- `[AVOID]` 外部プロトコル(MCP等)の接続エラーを一律にリトライすること — エラーの種類に応じて異なる復帰戦略を取るべき
  - 根拠: `UnauthorizedError` は OAuth フローへ遷移し次のトランスポートを試行しない、一般エラーはフォールバックする、と分類している (`packages/opencode/src/mcp/index.ts:396-429`)

## 適用チェックリスト

- [ ] プラグインシステムのフックポイントが単一インターフェースで定義され、型安全にフック名が制約されているか
- [ ] 拡張の参入障壁が段階的に設計されているか（ファイル配置だけで動く簡易拡張が存在するか）
- [ ] 外部拡張とビルトイン機能が同一のインターフェースで処理されているか（アダプタ層の有無）
- [ ] 設定の優先度（グローバル → プロジェクト → ローカル → 環境変数）が明示的に文書化されているか
- [ ] プラグインの依存関係が自動管理されており、ユーザーの手動操作が最小限か
- [ ] フック関数の input/output が型レベルで分離されており、変更可能な範囲が明確か
- [ ] 外部プロトコル接続のエラー分類とフォールバック戦略が設計されているか
- [ ] プラグインの重複検出・排除メカニズムが存在するか
