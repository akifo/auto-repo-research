# Practice: Explicit Resource Management

> 出典: [repos/ryoppippi/ccusage](../repos/ryoppippi/ccusage/)
> カテゴリ: practice

## 概要

TC39 Explicit Resource Management (`using` / `await using` + `Symbol.dispose` / `Symbol.asyncDispose`) を活用し、リソースのライフサイクルをスコープに束縛するプラクティス。try-finally による手動クリーンアップを排除し、キャッシュの解放、一時ファイルの削除、接続の切断といったリソース管理を構造的に保証する。ccusage では本番コードの Disposable クラスからテストフィクスチャの自動破棄まで、120箇所以上で一貫して適用されている。

## 背景・文脈

ccusage は Claude Code / Codex / Amp 等の使用量を分析する CLI ツール群で、pnpm workspace による monorepo 構成を取る。外部 API からの価格データ取得にはメモリキャッシュが伴い、テストではファイルシステム上に一時ディレクトリを大量に生成する。これらのリソースは使用後に確実に解放する必要があるが、try-finally や `afterEach` による手動管理はクリーンアップ漏れのリスクが高い。TC39 Explicit Resource Management を全面採用することで、リソースの確保と解放をスコープに紐づけ、漏れを構造的に防止している。

## 実装パターン

### パターン 1: Disposable クラス -- `Symbol.dispose` による同期リソース解放

クラスに `Disposable` インターフェースを実装し、`[Symbol.dispose]()` でクリーンアップロジックを定義する。呼び出し側は `using` 宣言でインスタンスを生成するだけで、スコープ終了時に自動的に解放される。

```typescript
// packages/internal/src/pricing.ts:89,105-107
export class LiteLLMPricingFetcher implements Disposable {
  private cachedPricing: Map<string, LiteLLMModelPricing> | null = null;

  [Symbol.dispose](): void {
    this.clearCache();
  }

  private clearCache(): void {
    this.cachedPricing = null;
  }
}
```

呼び出し側:

```typescript
// apps/ccusage/src/data-loader.ts:775
using fetcher = mode === "display" ? null : new PricingFetcher(options?.offline);
// スコープ終了時に fetcher[Symbol.dispose]() が自動呼出し → キャッシュクリア
```

`null` を代入しても `using` は安全に動作する（`null` / `undefined` は dispose されない）。条件付きリソース生成との相性が良い。

### パターン 2: 委譲 + Disposable -- 内部リソースの転送

アプリ固有のクラスが `Disposable` を実装しつつ、内部で共有パッケージの `LiteLLMPricingFetcher` に委譲する。dispose 時に内部リソースも連鎖的に解放される。

```typescript
// apps/amp/src/pricing.ts:21-30
export class AmpPricingSource implements PricingSource, Disposable {
  private readonly fetcher: LiteLLMPricingFetcher;

  constructor(options: AmpPricingSourceOptions = {}) {
    this.fetcher = new LiteLLMPricingFetcher({
      offline: options.offline ?? false,
      offlineLoader: async () => PREFETCHED_AMP_PRICING,
      logger,
      providerPrefixes: AMP_PROVIDER_PREFIXES,
    });
  }

  [Symbol.dispose](): void {
    this.fetcher[Symbol.dispose]();
  }
}
```

```typescript
// apps/amp/src/commands/daily.ts:59
using pricingSource = new AmpPricingSource({ offline: false });
```

### パターン 3: AsyncDisposable -- `await using` による非同期リソース解放

非同期のクリーンアップが必要な場合は `AsyncDisposable` と `Symbol.asyncDispose` を使う。`fs-fixture` の `createFixture()` がこのパターンを採用しており、一時ディレクトリの削除を `await using` で自動化している。

```typescript
// apps/ccusage/src/_utils.ts:34-46
describe("getFileModifiedTime", () => {
  it("returns specific modification time when set", async () => {
    await using fixture = await createFixture({
      "test.txt": "content",
    });

    const specificTime = new Date("2024-01-01T12:00:00.000Z");
    await utimes(`${fixture.path}/test.txt`, specificTime, specificTime);

    const mtime = await getFileModifiedTime(fixture.getPath("test.txt"));
    expect(mtime).toBe(specificTime.getTime());
  });
  // fixture はスコープを抜けると自動的にクリーンアップされる
});
```

### パターン 4: 宣言的フィクスチャ + 自動破棄

`createFixture()` にオブジェクトリテラルでディレクトリ構造を渡し、`await using` でライフサイクルを管理する。テストの Arrange と Cleanup を1文で表現する。

```typescript
// apps/ccusage/src/data-loader.ts:1536-1572
it("loads usage data for a specific session", async () => {
  await using fixture = await createFixture({
    ".claude": {
      projects: {
        "test-project": {
          "session-123.jsonl": `${
            JSON.stringify({
              timestamp: "2024-01-01T00:00:00Z",
              sessionId: "session-123",
              message: {
                usage: { input_tokens: 100, output_tokens: 50 },
                model: "claude-sonnet-4-20250514",
              },
              costUSD: 0.5,
            })
          }`,
        },
      },
    },
  });

  vi.stubEnv("CLAUDE_CONFIG_DIR", fixture.getPath(".claude"));
  const result = await loadSessionUsageById("session-123", { mode: "display" });
  expect(result).not.toBeNull();
  expect(result?.totalCost).toBe(1.5);
});
```

## Good Example

### using でキャッシュの自動解放を保証する

```typescript
// Good: using 宣言でスコープに束縛 -- 例外が発生してもキャッシュは確実にクリアされる
async function loadDailyUsageData(options: LoadOptions): Promise<DailyUsage[]> {
  using fetcher = mode === "display" ? null : new PricingFetcher(options?.offline);
  // ... fetcher を使ったデータ処理 ...
  return dailyData;
  // スコープ終了: fetcher[Symbol.dispose]() が自動呼出し
}
```

```typescript
// Good: テストでも using で自動クリーンアップ -- afterEach が不要
it("calculates pricing correctly", () => {
  using source = new CodexPricingSource({
    offline: true,
    offlineLoader: async () => ({ "gpt-4": { input_cost: 0.03 } }),
  });
  const result = await source.getPricing("gpt-4");
  expect(result.inputCostPerMToken).toBe(0.03);
  // source[Symbol.dispose]() が自動呼出し
});
```

```typescript
// Good: 120 以上のテストで await using fixture を統一的に使用 -- 手動 cleanup は一切なし
it("should connect via stdio transport and list tools", async () => {
  await using fixture = await createFixture({
    "projects/test-project/session1/usage.jsonl": JSON.stringify({/* ... */}),
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const server = createMcpServer({ claudePath: fixture.path });
  // ...
});
```

## Bad Example

### try-finally による手動クリーンアップ

```typescript
// Bad: try-finally でクリーンアップ -- 書き忘れ、早期 return での漏れリスクがある
async function loadDailyUsageData(options: LoadOptions): Promise<DailyUsage[]> {
  const fetcher = new PricingFetcher(options?.offline);
  try {
    // ... fetcher を使ったデータ処理 ...
    return dailyData;
  } finally {
    fetcher.clearCache(); // 書き忘れると永続的にメモリリーク
  }
}

// Good: using 宣言に置き換える
async function loadDailyUsageData(options: LoadOptions): Promise<DailyUsage[]> {
  using fetcher = new PricingFetcher(options?.offline);
  // ... fetcher を使ったデータ処理 ...
  return dailyData;
  // 自動解放 -- 書き忘れの余地がない
}
```

### afterEach による手動テストクリーンアップ

```typescript
// Bad: afterEach でクリーンアップ -- テスト追加時に漏れるリスク
describe("data-loader", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "test-"));
    await writeFile(path.join(tempDir, "test.jsonl"), "...");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true }); // 忘れると一時ファイルが蓄積
  });

  it("loads data", async () => {
    const result = await loadData(tempDir);
    expect(result).toBeDefined();
  });
});

// Good: await using + createFixture で Arrange と Cleanup を一体化
describe("data-loader", () => {
  it("loads data", async () => {
    await using fixture = await createFixture({
      "test.jsonl": "...",
    });
    const result = await loadData(fixture.path);
    expect(result).toBeDefined();
    // 自動クリーンアップ -- afterEach 不要
  });
});
```

### Disposable を実装しないリソースクラス

```typescript
// Bad: Disposable 未実装 -- 呼び出し側が cleanup を呼ぶ責務を負う
class CacheManager {
  private cache = new Map();
  clearCache(): void {
    this.cache.clear();
  }
}
const manager = new CacheManager();
// ... 使用後に manager.clearCache() を呼ぶ必要がある（忘れやすい）

// Good: Disposable を実装し using で管理させる
class CacheManager implements Disposable {
  private cache = new Map();
  [Symbol.dispose](): void {
    this.cache.clear();
  }
}
using manager = new CacheManager();
// スコープ終了時に自動クリア
```

## 適用ガイド

### どのような状況で使うべきか

- **メモリキャッシュ**: 外部 API から取得したデータのキャッシュを関数スコープで確実に解放したい場合
- **一時ファイル / ディレクトリ**: テストや処理中に生成する一時リソースをスコープ終了時に自動削除したい場合
- **DB 接続 / HTTP クライアント**: コネクションプール等の有限リソースをスコープで管理したい場合
- **ロック / セマフォ**: 排他制御のロックを確実に解放したい場合

### using と await using の使い分け

| 宣言                  | dispose メソッド                   | 用途                              |
| --------------------- | ---------------------------------- | --------------------------------- |
| `using x = ...`       | `[Symbol.dispose]()` (同期)        | キャッシュクリア、メモリ解放      |
| `await using x = ...` | `[Symbol.asyncDispose]()` (非同期) | ファイル削除、DB 切断、HTTP close |

### 導入時の注意点

- **TypeScript 5.2 以上**が必要。`tsconfig.json` の `lib` に `"esnext.disposable"` を含めるか、`"lib": ["ESNext"]` を指定する
- **null / undefined は安全**: `using x = null` は dispose されない。条件付きリソース生成（`using fetcher = condition ? new Fetcher() : null`）が安全に書ける
- **エラー時も確実に実行される**: `using` / `await using` のスコープ内で例外が発生しても、dispose は確実に呼ばれる（try-finally と同等の保証）
- **テストフレームワークとの相性**: vitest / Jest ともに `await using` をサポートする。`afterEach` を完全に置き換え可能

### カスタマイズポイント

- `Disposable` / `AsyncDisposable` は TypeScript の組み込みインターフェース。サードパーティライブラリ不要で実装できる
- `DisposableStack` / `AsyncDisposableStack` を使えば、複数リソースの一括管理も可能
- `fs-fixture` のような `AsyncDisposable` を返すファクトリを自作すれば、プロジェクト固有のリソース管理パターンを `await using` に統合できる

## 参考

- [repos/ryoppippi/ccusage/abstraction-patterns.md](../repos/ryoppippi/ccusage/abstraction-patterns.md) -- Disposable + 委譲パターンの分析
- [repos/ryoppippi/ccusage/testing-practices.md](../repos/ryoppippi/ccusage/testing-practices.md) -- await using + createFixture による自動クリーンアップ
- [repos/ryoppippi/ccusage/data-processing-patterns.md](../repos/ryoppippi/ccusage/data-processing-patterns.md) -- using 宣言による PricingFetcher のライフサイクル管理
- [repos/ryoppippi/ccusage/design-philosophy.md](../repos/ryoppippi/ccusage/design-philosophy.md) -- Disposable パターンの設計思想
