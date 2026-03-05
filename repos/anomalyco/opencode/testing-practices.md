# testing-practices

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

opencode はモノレポ構成の大規模 TypeScript プロジェクトで、Bun test（ユニットテスト）と Playwright（E2E テスト）を組み合わせたテスト戦略を採用している。AGENTS.md に「Avoid mocks as much as possible」と明文化されており、実装をそのまま動かすことを優先する方針が貫かれている。モック回避を実現するために、一時ディレクトリ + `Instance.provide()` による依存コンテキスト注入パターンが中核的な役割を果たしている点が特筆に値する。

## 背景にある原則

- **実装と同じコードパスを通すべき（Fidelity over Speed）**: モックはテスト対象のコードパスを迂回するため、実装とテストの乖離が生まれる。opencode は一時ディレクトリ・環境変数・preload による隔離で「本物の実装」をテスト内で動かし、テストの忠実度を最大化している。根拠: `AGENTS.md:122-124` の "Avoid mocks as much as possible" / "Test actual implementation, do not duplicate logic into tests"。
- **テスト実行スコープをパッケージに閉じるべき（Isolation by Package Boundary）**: monorepo でルートから全テストを一括実行すると、preload の衝突・環境変数の競合・依存グラフの不整合が起きる。opencode はルートの `bunfig.toml` に `root = "./do-not-run-tests-from-root"` を設定し、パッケージ単位の実行を強制している。根拠: `bunfig.toml:5`。
- **テストフィクスチャにリソースライフサイクル管理を組み込むべき（Fixture-managed Lifecycle）**: 一時ディレクトリやデータベースなどのリソースは、テストの setup/teardown ではなくフィクスチャ自体が `Symbol.asyncDispose` でライフサイクルを管理することで、クリーンアップ漏れを構造的に防げる。根拠: `packages/opencode/test/fixture/fixture.ts:37`。
- **E2E テストは実際の SDK クライアントを通じて検証すべき（SDK-driven E2E）**: UI テストでも API の直接操作には実際の SDK クライアントを使い、テスト用の HTTP モックサーバーを立てない。これにより、SDK の互換性も同時に検証できる。根拠: `packages/app/e2e/utils.ts:13-15` の `createSdk()`。

## 実例と分析

### 1. モック回避: Instance.provide + tmpdir パターン

opencode のコアパッケージ（`packages/opencode`）では、ほぼ全てのテストが以下のパターンを踏む:

1. `tmpdir()` で一時ディレクトリを作成（オプションで git init や config 書き込み）
2. `Instance.provide({ directory, fn })` でプロジェクトコンテキストを注入
3. `fn` 内で実際のモジュール API を呼び出してテスト

```typescript
// packages/opencode/test/agent/agent.test.ts:14-29
test("returns default native agents when no config", async () => {
  await using tmp = await tmpdir();
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await Agent.list();
      const names = agents.map((a) => a.name);
      expect(names).toContain("build");
      expect(names).toContain("plan");
    },
  });
});
```

`tmpdir` は `await using` 構文（TC39 Explicit Resource Management）で使われ、スコープ終了時に自動クリーンアップされる。`Symbol.asyncDispose` の実装が `fixture.ts:37` にある。

### 2. ルートからのテスト実行防止

```toml
# bunfig.toml:4-5
[test]
root = "./do-not-run-tests-from-root"
```

存在しないディレクトリを `root` に指定することで、リポジトリルートで `bun test` を実行しても 0 件で終わる。各パッケージの `bunfig.toml` では個別の preload を設定しており、パッケージ境界での実行を前提としている。

### 3. preload によるテスト環境の隔離

```typescript
// packages/opencode/test/preload.ts:9-31
const dir = path.join(os.tmpdir(), "opencode-test-data-" + process.pid);
await fs.mkdir(dir, { recursive: true });

process.env["XDG_DATA_HOME"] = path.join(dir, "share");
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache");
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config");
process.env["XDG_STATE_HOME"] = path.join(dir, "state");
```

XDG ディレクトリをプロセス単位の一時パスに差し替え、ホストマシンの設定やキャッシュがテストに影響しないようにしている。さらに全プロバイダーの API キー環境変数を `delete` し、テスト結果が CI/ローカルの環境差異に左右されないことを保証している（`preload.ts:53-71`）。

### 4. モックが許容される境界

明示的にモック回避を掲げつつも、外部プロセス起動（`open` コマンド）や外部 SDK のトランスポート層では `mock.module` を使っている。16 ファイル中、モックを使用しているテストの大半は以下の 2 カテゴリに限定される:

- **外部プロセス/ブラウザ起動**: `packages/opencode/test/mcp/oauth-browser.test.ts` — `open` コマンドのモック
- **UI コンポーネントの依存分離**: `packages/app/src/components/prompt-input/submit.test.ts` — SolidJS のルーター・SDK・コンテキストプロバイダーのモック

コアロジックのテスト（agent, config, file, permission, provider 等）ではモックがほぼゼロであり、「外部 I/O の境界でのみモックを許容する」という原則が徹底されている。

### 5. E2E テストの構造

E2E テストは `packages/app/e2e/` に Playwright で実装されている。

**Fixture による再利用可能なセットアップ**:

```typescript
// packages/app/e2e/fixtures.ts:26-71
export const test = base.extend<TestFixtures, WorkerFixtures>({
  directory: [
    async ({}, use) => {
      const directory = await getWorktree();
      await use(directory);
    },
    { scope: "worker" },
  ],
  sdk: async ({ directory }, use) => {
    await use(createSdk(directory));
  },
  withProject: async ({ page }, use) => {
    await use(async (callback, options) => {
      const directory = await createTestProject();
      // ... setup ...
      try {
        return await callback({ directory, slug, gotoSession });
      } finally {
        await cleanupTestProject(directory);
      }
    });
  },
});
```

Worker スコープのフィクスチャ（`directory`）はワーカー間で共有され、テストスコープのフィクスチャ（`sdk`, `gotoSession`）はテストごとに新規作成される。`withProject` は try/finally で一時プロジェクトの確実なクリーンアップを保証する。

**セレクタの一元管理**:

```typescript
// packages/app/e2e/selectors.ts:1-4
export const promptSelector = '[data-component="prompt-input"]';
export const terminalSelector = '[data-component="terminal"]';
```

CSS クラスではなく `data-component` / `data-action` 属性でセレクタを定義し、スタイル変更に対する耐性を確保している。

### 6. Turborepo によるテスト依存グラフ

```json
// turbo.json:11-18
"opencode#test": {
  "dependsOn": ["^build"],
  "outputs": []
},
"@opencode-ai/app#test": {
  "dependsOn": ["^build"],
  "outputs": []
}
```

テストタスクは依存パッケージのビルド完了を前提とする。これにより、パッケージ間の依存が暗黙的にならず、ビルド成果物が最新であることが保証される。

### 7. 純粋ロジックのテスト分離

UI フレームワーク依存がないロジック（キャッシュ、パーサー、ユーティリティ）は、モックなし・preload なしで直接テストされている:

```typescript
// packages/app/src/utils/scoped-cache.test.ts:4-25
describe("createScopedCache", () => {
  test("evicts least-recently-used entry when max is reached", () => {
    const cache = createScopedCache((key) => ({ key }), {
      maxEntries: 2,
      dispose: (value) => disposed.push(value.key),
    });
    const a = cache.get("a");
    const b = cache.get("b");
    cache.get("a");
    const c = cache.get("c");
    expect(cache.peek("b")).toBeUndefined();
  });
});
```

この分離は「ロジックを UI フレームワークから切り離して設計する」というアーキテクチャ上の判断と連動している。

## パターンカタログ

- **Disposable Fixture パターン** (分類: 生成/ライフサイクル管理)
  - 解決する問題: テストリソース（一時ディレクトリ、DB 接続）のクリーンアップ漏れ
  - 適用条件: TC39 Explicit Resource Management (`await using`) をサポートするランタイム
  - コード例: `packages/opencode/test/fixture/fixture.ts:37`
  - 注意点: `Symbol.asyncDispose` はまだ Stage 3 であり、トランスパイラのサポート状況を要確認

- **Context Provider パターン** (分類: 振る舞い/依存注入)
  - 解決する問題: グローバル状態に依存するモジュールをモックなしでテストする
  - 適用条件: AsyncLocalStorage 等のコンテキスト伝播機構があるランタイム
  - コード例: `packages/opencode/test/agent/agent.test.ts:15-29` — `Instance.provide()`
  - 注意点: コンテキストの入れ子や並行実行時の分離に注意が必要

## Good Patterns

- **tmpdir + Instance.provide によるモックレステスト**: 一時ディレクトリに設定ファイルを書き出し、`Instance.provide` でプロジェクトコンテキストを注入することで、外部モックなしに実装の全コードパスを通す。テストの信頼性と実装との一致度が極めて高い。

```typescript
// packages/opencode/test/config/config.test.ts:39-57
test("loads JSON config file", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: "https://opencode.ai/config.json",
        model: "test/model",
        username: "testuser",
      });
    },
  });
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get();
      expect(config.model).toBe("test/model");
    },
  });
});
```

- **E2E の SDK フィクスチャ**: Playwright の `test.extend` で実際の SDK クライアントをフィクスチャ化し、テストデータの作成・検証・クリーンアップを API 経由で行う。UI 操作では不安定になりがちなデータセットアップを SDK 呼び出しで安定化させている。

```typescript
// packages/app/e2e/actions.ts:320-333
export async function withSession<T>(
  sdk: ReturnType<typeof createSdk>,
  title: string,
  callback: (session: { id: string; title: string; }) => Promise<T>,
): Promise<T> {
  const session = await sdk.session.create({ title }).then((r) => r.data);
  try {
    return await callback(session);
  } finally {
    await sdk.session.delete({ sessionID: session.id }).catch(() => undefined);
  }
}
```

- **data-component セレクタ戦略**: E2E テストで CSS クラスや ID ではなく `data-component` / `data-action` 属性をセレクタに使用。スタイルリファクタリングがテストを壊さない。

## Anti-Patterns / 注意点

- **過度なモジュールモック**: `packages/app/src/components/prompt-input/submit.test.ts` では 12 個の `mock.module` が必要になっている。これはテスト対象のモジュールが多くの依存を直接インポートしているためで、ロジックの抽出・分離が不十分なサインである。

```typescript
// Bad: 12 個のモジュールモックが必要
mock.module("@solidjs/router", () => ({ ... }))
mock.module("@opencode-ai/sdk/v2/client", () => ({ ... }))
mock.module("@opencode-ai/ui/toast", () => ({ ... }))
// ... さらに 9 個 ...
```

```typescript
// Better: ロジックを純粋関数に抽出してモックなしでテスト
// submit-logic.ts にロジックを分離し、UI 統合は E2E でカバー
export function buildSubmitPayload(input: SubmitInput): SubmitPayload {
  // 純粋なデータ変換のみ
}
```

## 導出ルール

- `[MUST]` monorepo でテストランナーのルート設定をリポジトリルートでは無効化し、パッケージ単位での実行を強制する
  - 根拠: opencode は `bunfig.toml` の `root = "./do-not-run-tests-from-root"` で意図しないルート実行を防止している（`bunfig.toml:5`）
- `[MUST]` テスト用の一時リソース（ディレクトリ、DB）には確定的なクリーンアップ機構を組み込む（`Symbol.asyncDispose`、try/finally、afterEach のいずれか）
  - 根拠: `fixture.ts` の `Symbol.asyncDispose` と `preload.ts` の `afterAll` でリソースリークを構造的に防いでいる
- `[SHOULD]` モックの代わりに一時ディレクトリ + コンテキスト注入で実装のコードパスをそのまま通すテストを書く
  - 根拠: 100 以上のテストファイル中、モック使用は 16 ファイルに限定されており、大半が `tmpdir()` + `Instance.provide()` で実装そのものをテストしている
- `[SHOULD]` E2E テストでは CSS クラスや ID ではなく `data-*` 属性（`data-component`, `data-action`, `data-slot`）をセレクタに使う
  - 根拠: `packages/app/e2e/selectors.ts` の全セレクタが `data-component` / `data-action` ベースで定義されている
- `[SHOULD]` テスト preload でホスト環境の環境変数を明示的にクリアし、CI/ローカル間の差異を排除する
  - 根拠: `preload.ts:53-71` で 12 以上のプロバイダーキーを `delete` している
- `[AVOID]` テスト対象モジュールに 5 個以上のモジュールモックが必要な場合、テスト手法ではなくモジュール設計を見直す
  - 根拠: `submit.test.ts` の 12 モック依存は設計上の密結合を示唆しており、純粋ロジックの抽出で改善できる
- `[AVOID]` E2E テストのデータセットアップを UI 操作で行う — API/SDK 経由でセットアップし、UI 操作は検証対象のインタラクションのみに絞る
  - 根拠: `actions.ts` の `withSession`, `seedSessionQuestion`, `seedSessionPermission` は全て SDK 経由でデータを準備している

## 適用チェックリスト

- [ ] monorepo のルートに `bun test` / `jest` / `vitest` の無効化設定があるか確認する
- [ ] テストフィクスチャに `Symbol.asyncDispose` または try/finally によるクリーンアップが組み込まれているか
- [ ] コア機能のテストでモックを使っている箇所を洗い出し、tmpdir + コンテキスト注入で置き換えられないか検討する
- [ ] テスト preload / setup でホスト環境由来の環境変数をクリアしているか
- [ ] E2E テストのセレクタが CSS クラスではなく `data-*` 属性を使っているか
- [ ] E2E テストのデータセットアップが SDK/API 経由で行われているか
- [ ] モジュールモックが 5 個以上必要なテストファイルがないか（あれば設計見直しのシグナル）
- [ ] Turborepo 等のタスクランナーでテストタスクが依存パッケージのビルド完了を前提としているか
