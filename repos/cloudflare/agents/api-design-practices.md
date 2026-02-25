# API Design Practices

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

cloudflare/agents は単一 npm パッケージ `agents` から 18 以上のサブパスエントリポイントを公開する SDK である。多数の optional peer dependencies を持ちながら、利用者が必要な機能だけをインポートできる設計になっている。本分析では、多エントリポイント exports の構造管理、optional peer dependencies のガード戦略、実験的 API (`experimental_`/`unstable_`) のライフサイクル管理、そして `@internal`/`@deprecated` による API 境界の明示的な制御プラクティスを横断的に抽出する。

## 背景にある原則

- **Import Path = Dependency Boundary**: サブパスエントリポイントを機能ごとに分離することで、利用者が `react` や `ai` といった重い peer dependency を必要としない機能を使う際にそれらをインストールしなくて済む。「import するパスが依存の境界線になる」という原則がある。
  - 根拠: `agents/react` は React を要求するが `agents` コアは要求しない。`agents/mcp` は `@modelcontextprotocol/sdk` を使うが、これは hard dependency としてコアに含まれている（`packages/agents/package.json` の `dependencies`）。一方 `agents/x402` は `@x402/core`, `@x402/evm` を peer dependency として分離している。

- **Build Entry = Export Entry = Verification Target**: 新しいパブリック API を追加する際、package.json の `exports`、ビルドスクリプトの `entry`、そしてチェックスクリプトの 3 箇所を同時に更新する必要があるが、最後の `check:exports` スクリプトがこの三位一体を機械的に検証する。人間の注意力に頼らず、CI で整合性を担保する原則。
  - 根拠: `scripts/check-exports.ts` が全パッケージの exports フィールドに列挙された全ファイルの存在を検証する（`check-exports.ts:49-63`）。

- **Deprecation as a Migration Bridge**: 非推奨 API を即座に削除するのではなく、旧名のラッパーを維持しつつ runtime warning を 1 回だけ出す。利用者に移行の猶予を与えつつ、ログノイズを最小化する。
  - 根拠: `unstable_callable`, `experimental_createMcpHandler`, `unstable_getSchedulePrompt` など 6 箇所以上で同一パターンが適用されている。

- **Naming Convention as Stability Contract**: `experimental/` ディレクトリパス、`unstable_` プレフィックス、`__DO_NOT_USE_WILL_BREAK__` プレフィックスの 3 段階で API の安定性レベルを名前自体に埋め込む。ドキュメントを読まなくても import パスだけで安定性が判断できる。
  - 根拠: `agents/experimental/forever` はパスとファイル先頭のブロックコメント・`console.warn` の三重警告で不安定性を伝達する（`experimental/forever.ts:1-38`）。

## 実例と分析

### 多エントリポイント exports の三位一体管理

package.json の `exports` フィールドに 18 エントリが定義されており、各エントリは `types`/`import`/`require` の 3 条件を持つ。ビルドスクリプト（`scripts/build.ts`）は tsdown の `entry` 配列でこれらのソースファイルを明示的に列挙している。

```typescript
// packages/agents/scripts/build.ts:6-19
await build({
  clean: true,
  dts: true,
  entry: [
    "src/*.ts",
    "src/*.tsx",
    "src/cli/index.ts",
    "src/mcp/index.ts",
    "src/mcp/client.ts",
    "src/mcp/do-oauth-client-provider.ts",
    "src/mcp/x402.ts",
    "src/observability/index.ts",
    "src/codemode/ai.ts",
    "src/experimental/forever.ts",
  ],
  // ...
});
```

`check:exports` スクリプトはビルド後に走り、package.json の exports に記載された全パスのファイルが `dist/` に存在するかを検証する。

```typescript
// scripts/check-exports.ts:48-63
const filePaths = extractFilePaths(packageJson.exports);
for (const filePath of filePaths) {
  if (!filePath.startsWith(".")) continue;
  const fullPath = resolve(packageDir, filePath);
  if (!existsSync(fullPath)) {
    missing.push(filePath);
  }
}
```

これにより「exports に書いたのにビルドエントリに入れ忘れた」あるいはその逆のミスを CI で検出できる。

### レガシーエントリポイントの薄い転送パターン

`agents/ai-chat-agent` と `agents/ai-react` は新パッケージ `@cloudflare/ai-chat` への移行ブリッジとして機能する。実装は `export *` による再エクスポートと `console.log` による 1 回限りの非推奨通知のみ。

```typescript
// packages/agents/src/ai-chat-agent.ts:1-5
export * from "@cloudflare/ai-chat";

console.log(
  "All the AI Chat related modules are now in @cloudflare/ai-chat. This module is deprecated and will be removed in the next major version.",
);
```

このパターンでは既存コードが `import { AIChatAgent } from "agents/ai-chat-agent"` と書いていても動作し続ける。ただし `console.log` をファイルトップレベルに配置しているため、import するだけで常にメッセージが出る点に注意が必要である（関数ラッパーの遅延警告パターンとは異なる）。

### 非推奨関数の遅延 1 回警告パターン

関数レベルの非推奨では、モジュールスコープのフラグ変数で初回呼び出し時のみ警告を出し、実装は新しい関数に委譲する。

```typescript
// packages/agents/src/schedule.ts:58-73
let didWarnAboutUnstableGetSchedulePrompt = false;

/**
 * @deprecated this has been renamed to getSchedulePrompt
 */
export function unstable_getSchedulePrompt(event: { date: Date; }) {
  if (!didWarnAboutUnstableGetSchedulePrompt) {
    didWarnAboutUnstableGetSchedulePrompt = true;
    console.warn(
      "unstable_getSchedulePrompt is deprecated, use getSchedulePrompt instead.",
    );
  }
  return getSchedulePrompt(event);
}
```

このパターンは `unstable_callable`（`index.ts:176-191`）、`experimental_createMcpHandler`（`mcp/handler.ts:123-143`）、`unstable_getAITools`（`mcp/client.ts:1127-1137`）でも一貫して使われている。クラスの場合はコンストラクタで同様のフラグチェックを行う（`mcp/client-transports.ts:10-42`）。

### experimental/ ディレクトリによる不安定 API の隔離

`agents/experimental/forever` は 3 段階の警告機構を持つ:

1. **Import パスに `experimental` を含める** — `"agents/experimental/forever"`
2. **ファイル先頭のブロックコメント** — `WARNING: EXPERIMENTAL — DO NOT USE IN PRODUCTION` の 11 行にわたる注意書き
3. **モジュール読み込み時の `console.warn`** — import するだけで警告が出力される

```typescript
// packages/agents/src/experimental/forever.ts:36-38
console.warn(
  "[agents/experimental/forever] WARNING: You are using an experimental API that WILL break between releases.",
);
```

### `__DO_NOT_USE_WILL_BREAK__` プレフィックスによる内部 API のエスケープハッチ

`internal_context.ts` で定義される `__DO_NOT_USE_WILL_BREAK__agentContext` は、名前自体が「使うな、壊れる」と宣言する内部 API である。しかし `index.ts` で re-export されているため、テストや高度なユースケースでアクセス可能。

```typescript
// packages/agents/src/internal_context.ts:30-34
/**
 * @internal — This is an internal implementation detail.
 * Importing or relying on this symbol **will** break your code in a future release.
 */
export const __DO_NOT_USE_WILL_BREAK__agentContext = new AsyncLocalStorage<AgentContextStore>();
```

これは `@internal` JSDoc タグだけでは利用者が無視する可能性があるため、シンボル名そのものに警告を埋め込む防衛的命名である。

### `_workflow_` プレフィックスによるパッケージ内部 RPC 境界

Agent クラスは `_workflow_handleCallback`, `_workflow_broadcast`, `_workflow_updateState` という `_workflow_` プレフィックス付きメソッドを公開している。これらは Durable Object RPC 経由で `AgentWorkflow` から呼ばれるが、利用者が直接呼ぶことは想定されていない。

```typescript
// packages/agents/src/index.ts:3737-3772
/**
 * @internal - Called by AgentWorkflow, do not call directly
 */
async _workflow_handleCallback(callback: WorkflowCallback): Promise<void> {
  await this.onWorkflowCallback(callback);
}
```

TypeScript の `private` ではなく `_` プレフィックス + `@internal` JSDoc を使う理由は、Durable Object RPC がランタイムで文字列ベースのメソッドディスパッチを行うため、TypeScript の `private` ではアクセスできなくなるためである。

### optional peer dependencies の分離戦略

`agents` パッケージは 10 個の peer dependencies を宣言し、うち 7 個が `optional: true` に設定されている。React, AI SDK, Zod, x402 関連のライブラリは、対応するサブパスエントリポイント（`agents/react`, `agents/x402` 等）を import した時のみ必要になる。

```json
// packages/agents/package.json:63-84 (抜粋)
"peerDependenciesMeta": {
  "@ai-sdk/openai": { "optional": true },
  "@ai-sdk/react": { "optional": true },
  "@cloudflare/ai-chat": { "optional": true },
  "@x402/core": { "optional": true },
  "@x402/evm": { "optional": true },
  "viem": { "optional": true }
}
```

`react` と `zod` は optional ではないが、これは `agents/react`（useAgent hook）と `agents/schedule`（Zod スキーマ）が SDK のコア機能に近い位置付けであることを示唆する。ただし `ai` と `@ai-sdk/*` は optional であり、AI 関連機能は完全にオプショナルである。

### `_testUtils` エクスポートによるテスト専用 API

`react.tsx` は内部キャッシュ操作を `_testUtils` としてエクスポートしている。アンダースコアプレフィックスが「これはパブリック API ではない」ことを示す。

```typescript
// packages/agents/src/react.tsx:96-104
export const _testUtils = {
  queryCache,
  setCacheEntry,
  getCacheEntry,
  deleteCacheEntry,
  clearCache: () => queryCache.clear(),
  createStubProxy,
  createCacheKey,
};
```

テストファイル（`react-tests/cache-ttl.test.ts`）がこれを import して単体テストを実行する。パブリック API には含めたくないが、テスタビリティのために必要なエスケープハッチである。

## パターンカタログ

- **Facade Pattern** (構造)
  - 解決する問題: 複雑な内部モジュール構造を利用者から隠蔽する
  - 適用条件: サブパスエントリポイントが内部モジュールの re-export ハブとして機能する場合
  - コード例: `mcp/index.ts:504-544` — MCP 関連の型・クラス・関数を集約して `agents/mcp` として公開
  - 注意点: Facade が肥大化すると barrel file のデメリット（tree-shaking 阻害）が発生する

- **Adapter Pattern** (構造)
  - 解決する問題: 非推奨 API を新 API に橋渡しする
  - 適用条件: API のリネームや移動が発生した場合
  - コード例: `ai-chat-agent.ts:1-5` — `export * from "@cloudflare/ai-chat"` で旧パスを新パッケージに転送
  - 注意点: 永続させると依存グラフが不必要に複雑化する

## Good Patterns

- **三位一体の Export 整合性チェック**: package.json exports、ビルドエントリ、CI チェックスクリプトの 3 層で exports の整合性を自動検証する。手動管理では追加忘れが頻発するサブパス exports において、ビルドパイプライン自体が安全ネットになる。
  ```typescript
  // scripts/check-exports.ts — CI で全パッケージの exports を検証
  const filePaths = extractFilePaths(packageJson.exports);
  for (const filePath of filePaths) {
    const fullPath = resolve(packageDir, filePath);
    if (!existsSync(fullPath)) missing.push(filePath);
  }
  ```

- **遅延 1 回警告付き非推奨ラッパー**: モジュールスコープのフラグ + `console.warn` + 新関数への委譲という 3 要素パターン。利用者のログを汚さず、移行を促す。6 箇所以上で一貫して適用されている。
  ```typescript
  // 共通パターン（schedule.ts, handler.ts, client.ts 等）
  let didWarn = false;
  export function unstable_X(...args) {
    if (!didWarn) {
      didWarn = true;
      console.warn("...");
    }
    return X(...args);
  }
  ```

- **Import パスによる安定性レベルの伝達**: `agents/experimental/forever` のように import パス自体に `experimental` を含めることで、コードレビュー時に安定性リスクが一目でわかる。IDE の自動補完でも `experimental` が表示される。

## Anti-Patterns / 注意点

- **トップレベル console.log による即時警告**: `ai-chat-agent.ts` と `ai-react.tsx` では `console.log` がモジュールトップレベルに配置されており、import するだけで毎回メッセージが出力される。関数ラッパーの遅延パターンと異なり、ログ抑制の手段がない。

  Bad:
  ```typescript
  // ai-chat-agent.ts — import するだけで毎回出力される
  export * from "@cloudflare/ai-chat";
  console.log("...deprecated...");
  ```

  Better:
  ```typescript
  // モジュールスコープで 1 回だけ警告
  let warned = false;
  function warnOnce() {
    if (!warned) {
      warned = true;
      console.warn("...deprecated...");
    }
  }
  // 各エクスポートで warnOnce() を呼ぶラッパーを提供
  ```

  ただし `export *` による全再エクスポートのケースではラッパーを挟む場所がないため、トップレベル警告は実用的な妥協とも言える。

- **exports フィールドの手動同期**: package.json の `exports` とビルドスクリプトの `entry` は別ファイルに記述されており、手動での同期が必要。`check:exports` がビルド後に検証するが、ビルドエントリへの追加忘れはチェックスクリプトで検出されず、ビルド成果物が生成されない形で失敗する。

  Better: exports フィールドからビルドエントリを自動生成する（または逆方向に）ことで、Single Source of Truth を実現する。

## 導出ルール

- `[MUST]` パッケージの exports フィールドに記載した全ファイルの存在を CI で自動検証する
  - 根拠: cloudflare/agents は `check:exports` スクリプトで全 exports パスのファイル存在を検証し、ビルド漏れを防止している（`scripts/check-exports.ts`）

- `[MUST]` 非推奨 API は即座に削除せず、新 API への委譲ラッパーを提供し runtime warning を 1 回だけ出す
  - 根拠: `unstable_callable`, `experimental_createMcpHandler` 等 6 箇所以上で `didWarn` フラグ + `console.warn` + 新関数呼び出しの一貫したパターンが適用されている

- `[SHOULD]` optional peer dependency を持つ機能は専用のサブパスエントリポイントに分離し、コアインポートで不要な依存を引き込まない
  - 根拠: `agents/react` (React), `agents/x402` (@x402/*), `agents/experimental/forever` 等、peer dependency が必要な機能ごとにエントリポイントが分かれている

- `[SHOULD]` 不安定な API は import パス（`experimental/`）または関数名プレフィックス（`unstable_`, `experimental_`）に安定性レベルを明示する
  - 根拠: `agents/experimental/forever` はパスに、`unstable_getSchedulePrompt` は名前に安定性シグナルを埋め込み、利用者がコードレビュー時にリスクを判断できるようにしている

- `[SHOULD]` パッケージ内部でのみ使用するメソッドは `_` プレフィックス + `@internal` JSDoc で境界を示し、ランタイムアクセスは維持する
  - 根拠: `_workflow_handleCallback` 等は Durable Object RPC 経由の呼び出しのため TypeScript `private` が使えず、命名規約 + JSDoc で内部 API であることを伝達している（`index.ts:3737-3755`）

- `[AVOID]` 内部専用シンボルを名前の「怖さ」だけで守ること — `__DO_NOT_USE_WILL_BREAK__` プレフィックスは最終手段であり、可能なら別パッケージや Symbol を使って物理的にアクセスを制限すべき
  - 根拠: `__DO_NOT_USE_WILL_BREAK__agentContext` は re-export されており、名前の警告を無視する利用者には効果がない。ただし AsyncLocalStorage のような cross-cutting な内部状態には他に良い手段がない場合の妥協として許容される

## 適用チェックリスト

- [ ] package.json の `exports` に記載した全パスの存在を CI で検証するスクリプトがあるか
- [ ] ビルドエントリポイントと package.json exports が同期しているか（可能なら Single Source of Truth にする）
- [ ] optional peer dependency を持つ機能が独立したサブパスエントリポイントに分離されているか
- [ ] 非推奨 API に遅延 1 回警告 + 新 API への委譲ラッパーが提供されているか
- [ ] 実験的 API に import パスまたは命名プレフィックスで安定性レベルが明示されているか
- [ ] パッケージ内部メソッドに `@internal` JSDoc が付与され、名前に `_` プレフィックスがあるか
- [ ] レガシーエントリポイント（移行ブリッジ）の削除時期がドキュメントに明記されているか
