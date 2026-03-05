# composition-patterns

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

関数合成、パイプライン、ビルダーパターン、ミドルウェア的構成について分析した。opencode は TypeScript の namespace パターンと関数型ユーティリティ（remeda の `pipe`、`mergeDeep`）を軸に、宣言的な合成スタイルを一貫して採用している。Hono ミドルウェアチェーン、Plugin フックパイプライン、Tool レジストリ合成、Permission ルールセットマージの 4 層に渡って合成パターンが適用されており、大規模コードベースの拡張性を保つ設計として注目に値する。

## 背景にある原則

- **レイヤードミドルウェアで関心を分離すべき。なぜなら認証・ログ・CORS・コンテキスト注入が独立して変更可能になる**: Hono の `.use()` チェーンで認証→ログ→CORS→ワークスペースコンテキスト注入を段階的に積み重ね、各ミドルウェアは前段の結果に依存しない（`src/server/server.ts:82-222`）
- **設定の合成は `mergeDeep` + `pipe` で宣言的に行うべき。なぜなら命令的な条件分岐の爆発を防げる**: LLM ストリーム呼び出しのオプション構築で `pipe(base, mergeDeep(model.options), mergeDeep(agent.options), mergeDeep(variant))` と 4 段のマージを 1 式で表現している（`src/session/llm.ts:104-109`）
- **フック（Plugin.trigger）によるパイプラインで拡張点を提供すべき。なぜなら本体コードを変更せずにプラグインが振る舞いを注入できる**: `Plugin.trigger` は入力/出力オブジェクトを順次フックに渡し、各プラグインが出力を変異させるパイプライン型の合成を実現している（`src/plugin/index.ts:106-121`）
- **ルールセットは追記的マージ（append-only merge）で構成すべき。なぜなら優先順位の逆転を防ぎつつ、複数ソースからの設定を安全に合成できる**: Permission の `merge()` は `rulesets.flat()` で単純連結し、評価時に `findLast` で最後のマッチを採用する last-wins 方式（`src/permission/next.ts:64-66, 239-242`）

## 実例と分析

### 1. Hono ミドルウェアチェーン構成

サーバーは Hono のメソッドチェーンで構築される。ミドルウェアは `.use()` で追加され、実行順序がコード上の宣言順と一致する。

認証ミドルウェア → ログミドルウェア → CORS → ワークスペースコンテキスト注入 → ルーティングミドルウェアの順で積まれている。

```typescript
// src/server/server.ts:60-255
const app = new Hono();
export const App: () => Hono = lazy(
  () =>
    app
      .onError((err, c) => {/* エラーハンドリング */})
      .use((c, next) => {
        // 認証: OPTIONS はスキップ
        if (c.req.method === "OPTIONS") return next();
        const password = Flag.OPENCODE_SERVER_PASSWORD;
        if (!password) return next();
        return basicAuth({ username, password })(c, next);
      })
      .use(async (c, next) => {
        // ロギング
        log.info("request", { method: c.req.method, path: c.req.path });
        await next();
      })
      .use(cors({ origin(input) {/* 動的オリジン検証 */} }))
      .route("/global", GlobalRoutes())
      // ... 認証不要ルート ...
      .use(async (c, next) => {
        // ワークスペースコンテキスト注入
        return WorkspaceContext.provide({
          workspaceID,
          async fn() {
            return Instance.provide({
              directory,
              init: InstanceBootstrap,
              async fn() {
                return next();
              },
            });
          },
        });
      })
      .use(WorkspaceRouterMiddleware)
      .route("/session", SessionRoutes()),
  // ... コンテキスト依存ルート ...
);
```

注目すべき点として、ルートのマウント位置がミドルウェアの適用範囲を決定している。`/global` ルートはワークスペースコンテキスト注入の前にマウントされるため、コンテキスト不要で動作する。一方 `/session` はコンテキスト注入後にマウントされ、`Instance.directory` 等にアクセスできる。

### 2. Plugin フックパイプライン

`Plugin.trigger` は名前付きフックに対して全プラグインを順次呼び出す。出力オブジェクトが可変参照として渡され、各フックがそれを変異させる。

```typescript
// src/plugin/index.ts:106-121
export async function trigger<
  Name extends Exclude<keyof Required<Hooks>, "auth" | "event" | "tool">,
  Input = Parameters<Required<Hooks>[Name]>[0],
  Output = Parameters<Required<Hooks>[Name]>[1],
>(name: Name, input: Input, output: Output): Promise<Output> {
  if (!name) return output;
  for (const hook of await state().then((x) => x.hooks)) {
    const fn = hook[name];
    if (!fn) continue;
    await fn(input, output);
  }
  return output;
}
```

呼び出し側は `output` を事前に構築し、`trigger` に渡す。プラグインは `output` のプロパティを直接変更する。

```typescript
// src/session/llm.ts:83-93
await Plugin.trigger(
  "experimental.chat.system.transform",
  { sessionID: input.sessionID, model: input.model },
  { system },
);
```

```typescript
// src/session/llm.ts:114-131
const params = await Plugin.trigger(
  "chat.params",
  { sessionID, agent, model, provider, message },
  { temperature, topP, topK, options },
);
```

### 3. Tool レジストリ合成

ツールレジストリは静的ツール配列とプラグインツールを `flatMap` + スプレッドで合成する。フィーチャーフラグによる条件付き合成もスプレッド構文で表現されている。

```typescript
// src/tool/registry.ts:103-125
return [
  InvalidTool,
  ...(question ? [QuestionTool] : []),
  BashTool,
  ReadTool,
  // ...
  ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
  ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
  ...custom, // プラグイン由来のカスタムツール
];
```

`Tool.define` は高階関数で、ツール定義にバリデーション + トランケーション処理を自動注入するデコレータ的合成を実現している。

```typescript
// src/tool/tool.ts:48-88
export function define<Parameters extends z.ZodType, Result extends Metadata>(
  id: string,
  init: Info<Parameters, Result>["init"] | Awaited<ReturnType<Info<Parameters, Result>["init"]>>,
): Info<Parameters, Result> {
  return {
    id,
    init: async (initCtx) => {
      const toolInfo = init instanceof Function ? await init(initCtx) : init;
      const execute = toolInfo.execute;
      toolInfo.execute = async (args, ctx) => {
        try {
          toolInfo.parameters.parse(args);
        } catch (error) { /* バリデーションエラー処理 */ }
        const result = await execute(args, ctx);
        if (result.metadata.truncated !== undefined) return result;
        const truncated = await Truncate.output(result.output, {}, initCtx?.agent);
        return {
          ...result,
          output: truncated.content,
          metadata: { ...result.metadata, truncated: truncated.truncated },
        };
      };
      return toolInfo;
    },
  };
}
```

### 4. mergeDeep パイプラインによるオプション合成

LLM 呼び出しのオプション構築で、remeda の `pipe` + `mergeDeep` を連鎖させて多段の設定マージを宣言的に表現している。

```typescript
// src/session/llm.ts:104-109
const options: Record<string, any> = pipe(
  base,
  mergeDeep(input.model.options),
  mergeDeep(input.agent.options),
  mergeDeep(variant),
);
```

同様のパターンは Agent の Permission 構築でも見られる。

```typescript
// src/agent/agent.ts:81-88
permission: PermissionNext.merge(
  defaults,
  PermissionNext.fromConfig({ question: "allow", plan_enter: "allow" }),
  user,
),
```

### 5. AsyncLocalStorage コンテキスト合成

`Context.create` + `Instance.provide` で AsyncLocalStorage ベースのリクエストスコープコンテキストを実現している。ネストした `provide` 呼び出しがコンテキストスタックを形成する。

```typescript
// src/util/context.ts:10-24
export function create<T>(name: string) {
  const storage = new AsyncLocalStorage<T>();
  return {
    use() {
      const result = storage.getStore();
      if (!result) throw new NotFound(name);
      return result;
    },
    provide<R>(value: T, fn: () => R) {
      return storage.run(value, fn);
    },
  };
}
```

```typescript
// src/server/server.ts:209-221 (ネストされたコンテキスト注入)
return WorkspaceContext.provide({
  workspaceID,
  async fn() {
    return Instance.provide({
      directory,
      init: InstanceBootstrap,
      async fn() {
        return next();
      },
    });
  },
});
```

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: リクエスト処理の各段階を独立したハンドラに分離する
  - 適用条件: 順序付きの処理パイプラインが必要な場合
  - コード例: `src/server/server.ts:60-255`（Hono ミドルウェアチェーン）
  - 注意点: ミドルウェアの順序がセマンティクスを決定するため、宣言順序の管理が重要

- **Decorator** (分類: 構造)
  - 解決する問題: 既存の関数にバリデーション・トランケーション等の横断的関心事を注入する
  - 適用条件: 全ツールに共通の前処理・後処理を適用する場合
  - コード例: `src/tool/tool.ts:48-88`（`Tool.define` でのラップ）
  - 注意点: ラップの階層が深くなるとデバッグが難しくなるため、層数を最小限に抑える

- **Registry** (分類: 生成/構造)
  - 解決する問題: 実行時にコンポーネントを動的に登録・検索する
  - 適用条件: プラグインやフィーチャーフラグで利用可能なコンポーネントが変わる場合
  - コード例: `src/tool/registry.ts:34-62`（ToolRegistry）、`src/bus/bus-event.ts:10-19`（BusEvent.define）

## Good Patterns

- **条件付き合成のスプレッド表現**: `...(condition ? [item] : [])` でフィーチャーフラグによるツール追加をインラインで表現。if 文のネストを避け、配列の構造が一目で把握できる（`src/tool/registry.ts:105-124`）

- **fn ラッパーによる自動バリデーション付き関数定義**: `fn(schema, callback)` で Zod スキーマによる入力バリデーションを関数定義と一体化。スキーマを `.schema` プロパティとして公開し、ルート定義でバリデータとして再利用できる（`src/util/fn.ts:3-11`、`src/server/routes/session.ts:114: Session.get.schema`）

- **lazy 初期化による遅延合成**: `lazy(() => new Hono().use(...).route(...))` でルート定義を遅延評価。サーバー起動時ではなく初回アクセス時に合成される（`src/server/routes/session.ts:22`、`src/server/server.ts:60`）

- **Plugin.trigger のミュータブル出力パターン**: 入力（読み取り専用コンテキスト）と出力（変異可能な結果オブジェクト）を分離することで、各プラグインが独立して出力を加工できる。戻り値合成のような複雑なマージロジックが不要になる（`src/plugin/index.ts:106-121`）

## Anti-Patterns / 注意点

- **ミドルウェア順序の暗黙的依存**:
  - なぜ問題か: ミドルウェアの宣言順序がセマンティクスを決定するが、その依存関係がコード上で明示されない。`/global` ルートがワークスペースミドルウェアの前にマウントされていることは意図的だが、コメントなしでは判断できない。
  - Bad: ルートを追加する際に、どのミドルウェアの前後に配置すべきかがわからない
  - Better: コメントでミドルウェア境界を明示するか、ルーターをプレ認証グループ/ポスト認証グループに分割する。実際のコードでは `server.ts:197` のコンテキスト注入前後で暗黙的にグループ化されている

- **ミュータブル出力による副作用の連鎖**:
  - なぜ問題か: `Plugin.trigger` の出力オブジェクトを各フックが変異させるため、フック間の実行順序によって結果が変わりうる。特に同じプロパティを複数のフックが書き換える場合にデバッグが困難
  - Bad: `output.system.push(...)` を複数プラグインが呼ぶと順序依存が生じる
  - Better: 各フックの変更をログに記録するか、イミュータブルな reduce パターンを採用する。ただし本リポジトリではパフォーマンスとシンプルさのトレードオフでミュータブル方式を選択している

## 導出ルール

- `[MUST]` ミドルウェアチェーンでは、コンテキスト非依存のルート（ヘルスチェック、認証エンドポイント等）をコンテキスト注入ミドルウェアの前にマウントする
  - 根拠: opencode は `/global` と認証ルートをワークスペースコンテキスト注入（`server.ts:197`）の前に配置し、不要な初期化を回避している
- `[SHOULD]` 多段の設定マージには `pipe` + `mergeDeep` の宣言的パイプラインを使い、命令的な `if/else` による条件分岐を避ける
  - 根拠: LLM オプション構築（`llm.ts:104-109`）で base→model→agent→variant の 4 段マージを 1 式で表現し、各層の優先順位がコード構造から自明になっている
- `[SHOULD]` 配列の条件付き合成には `...(condition ? [item] : [])` スプレッドパターンを使い、後から `push` する命令的スタイルを避ける
  - 根拠: ToolRegistry（`registry.ts:103-125`）でフィーチャーフラグによるツール追加を宣言的に表現し、配列の最終構造が定義箇所で一覧できる
- `[SHOULD]` プラグイン拡張点では入力（コンテキスト）と出力（変更対象）を明確に分離し、各フックは出力のみを変更する契約にする
  - 根拠: `Plugin.trigger(name, input, output)` は入力を読み取り専用コンテキスト、出力を変異可能オブジェクトとして渡すことで、フック間の依存を最小化している（`plugin/index.ts:106-121`）
- `[SHOULD]` 横断的関心事（バリデーション、トランケーション等）は高階関数でツール定義をラップして注入し、各ツール実装に重複コードを持たせない
  - 根拠: `Tool.define` が全ツールに Zod バリデーション + 出力トランケーションを自動注入し、個別ツールはビジネスロジックのみに集中できている（`tool/tool.ts:48-88`）
- `[AVOID]` ルールセットの合成で明示的な優先順位解決ロジックを書くこと。代わりに追記的マージ + last-wins 評価を採用する
  - 根拠: PermissionNext は `merge = flat()` + `findLast` で優先順位を自然に表現し、複雑な優先度マッピングを不要にしている（`permission/next.ts:64-66, 239`）

## 適用チェックリスト

- [ ] HTTP サーバーのミドルウェアチェーンで、コンテキスト非依存ルートがコンテキスト注入の前にマウントされているか確認する
- [ ] 多段の設定マージを `pipe` + `mergeDeep`（または同等のユーティリティ）で宣言的に表現しているか確認する
- [ ] フィーチャーフラグによる条件付き合成に `...(cond ? [x] : [])` パターンを採用しているか確認する
- [ ] プラグインや拡張点で入力（読み取り専用）と出力（変更対象）が明確に分離されているか確認する
- [ ] ツールや関数の定義で横断的関心事（バリデーション、ログ、エラーハンドリング）が高階関数でラップされているか確認する
- [ ] ルールや設定の合成で、追記的マージ + last-wins 評価パターンが適用できないか検討する
