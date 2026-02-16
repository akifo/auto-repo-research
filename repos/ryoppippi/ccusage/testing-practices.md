# Testing Practices

> リポジトリ: ryoppippi/ccusage
> 分析日: 2026-02-16

## 概要

ccusage は全ファイルで in-source testing パターンを採用し、テストコードとプロダクションコードを同一ファイル内に共存させている。`if (import.meta.vitest != null)` ガードブロックにより、ビルド時にはテストコードが tree-shaking で除去される。さらに `fs-fixture` の `createFixture()` と `await using` 構文（Explicit Resource Management）を組み合わせ、ファイルシステムに依存するテストの自動クリーンアップを実現している。モノレポ全体で 8 つの vitest 設定が存在し、すべてが同一の `includeSource` + `globals: true` パターンに従う。

## 背景にある原則

- **コロケーション原則**: テストと実装の物理的距離をゼロにすることで、コード変更時にテスト更新を忘れるリスクを最小化する。ccusage では全 35 以上のソースファイルで `if (import.meta.vitest != null)` ブロックが実装内に直接埋め込まれており、テスト専用ディレクトリ（`__tests__/` 等）が存在しない（`apps/ccusage/test/` にはテスト用 JSON フィクスチャのみ格納）。この徹底度が注目に値する。

- **ゼロリーク原則**: テストコードがプロダクションバンドルに混入しないことを、ビルドツールチェーンの 2 層で保証する。Vitest 側は `includeSource` でテストを検出し、tsdown 側は `define: { 'import.meta.vitest': 'undefined' }` でガードブロックを dead code 化して tree-shaking で除去する。テスト依存（`fs-fixture` 等）も `devDependencies` のみに配置する。

- **自動クリーンアップ原則**: テストで生成した一時ファイルの後始末を手動 `afterEach` ではなく、言語機能（`await using` + `Symbol.asyncDispose`）に委ねることで、クリーンアップ漏れによるテスト汚染を構造的に防止する。ccusage では 120 以上の `await using fixture = await createFixture(...)` 呼び出しが存在し、全箇所で `using` による自動破棄を使用している。

- **テストデータの宣言的記述原則**: `createFixture()` にオブジェクトリテラルでディレクトリ構造を渡すことで、テストが必要とするファイルシステム状態を宣言的に表現する。手続き的なディレクトリ作成・ファイル書き込みの連鎖を避け、テストの「Arrange」セクションの可読性を高める。

## 実例と分析

### in-source testing の適用パターン

コードベース全体を横断すると、in-source testing は以下の 3 層すべてで一貫して適用されている。

1. **純粋関数のユニットテスト** -- `_token-utils.ts`, `_date-utils.ts`, `calculate-cost.ts` など。入出力のみを検証し、外部依存なし。
2. **ファイルシステム依存のテスト** -- `data-loader.ts`, `debug.ts`, `_config-loader-tokens.ts` など。`createFixture()` で JSONL ファイルやディレクトリ構造を模擬。
3. **統合テスト** -- `mcp.ts` では MCP サーバーを `InMemoryTransport` で接続し、`createFixture()` でデータディレクトリを模擬した上で、ツール呼び出しの end-to-end テストを実施。

注目すべきは、テスト規模が大きいファイルでも in-source のまま維持していることだ。`data-loader.ts` は 120 以上の `createFixture` 呼び出しを含むテストブロックを持ち、ファイル全体で 4700 行超に達する。

### globals: true の効果

すべての vitest.config.ts で `globals: true` を設定し、`describe`, `it`, `expect`, `vi` をインポートなしで利用している。ただし `_project-names.ts` では例外的に `const { describe, it, expect } = import.meta.vitest` という destructuring パターンが見られる。これはリポジトリ内で一貫性が完全ではない箇所だが、globals が有効なため両方のスタイルが動作する。

### createFixture によるディレクトリ構造の模擬

`createFixture()` はネストしたオブジェクトリテラルでディレクトリ構造を表現し、文字列値がファイル内容になる。ccusage のテストでは Claude データディレクトリ（`projects/` 配下の JSONL ファイル群）をこのパターンで再現する。

### 動的インポート禁止の理由

CLAUDE.md で `await import()` の使用を厳禁している。これは tsdown による tree-shaking と `define: { 'import.meta.vitest': 'undefined' }` の組み合わせに起因する。動的インポートは静的解析を阻害し、テストコードやテスト専用依存がバンドルに残るリスクを生む。

## コード例

in-source testing の基本構造:

```typescript
// apps/ccusage/src/_token-utils.ts:56
if (import.meta.vitest != null) {
	describe('getTotalTokens', () => {
		it('should sum all token types correctly (raw format)', () => {
			const tokens: TokenCounts = {
				inputTokens: 1000,
				outputTokens: 500,
				cacheCreationInputTokens: 2000,
				cacheReadInputTokens: 300,
			};
			expect(getTotalTokens(tokens)).toBe(3800);
		});
	});
}
```

`await using` + `createFixture` によるファイルシステムテスト:

```typescript
// apps/ccusage/src/_utils.ts:34-46
describe('getFileModifiedTime', () => {
	it('returns specific modification time when set', async () => {
		await using fixture = await createFixture({
			'test.txt': 'content',
		});

		const specificTime = new Date('2024-01-01T12:00:00.000Z');
		await utimes(`${fixture.path}/test.txt`, specificTime, specificTime);

		const mtime = await getFileModifiedTime(fixture.getPath('test.txt'));
		expect(mtime).toBe(specificTime.getTime());
	});
});
```

Claude データディレクトリのシミュレーション:

```typescript
// apps/ccusage/src/data-loader.ts:1536-1572
it('loads usage data for a specific session', async () => {
	await using fixture = await createFixture({
		'.claude': {
			projects: {
				'test-project': {
					'session-123.jsonl': `${JSON.stringify({
						timestamp: '2024-01-01T00:00:00Z',
						sessionId: 'session-123',
						message: {
							usage: { input_tokens: 100, output_tokens: 50 },
							model: 'claude-sonnet-4-20250514',
						},
						costUSD: 0.5,
					})}`,
				},
			},
		},
	});

	vi.stubEnv('CLAUDE_CONFIG_DIR', fixture.getPath('.claude'));
	const result = await loadSessionUsageById('session-123', { mode: 'display' });
	expect(result).not.toBeNull();
	expect(result?.totalCost).toBe(1.5);
});
```

ビルド時のテストコード除去:

```typescript
// apps/ccusage/tsdown.config.ts:33-34
define: {
	'import.meta.vitest': 'undefined',
},
```

```typescript
// apps/ccusage/vitest.config.ts:4-9
export default defineConfig({
	test: {
		watch: false,
		includeSource: ['src/**/*.{js,ts}'],
		globals: true,
	},
});
```

MCP サーバーの統合テスト（in-source + createFixture）:

```typescript
// apps/mcp/src/mcp.ts:237-268
it('should connect via stdio transport and list tools', async () => {
	await using fixture = await createFixture({
		'projects/test-project/session1/usage.jsonl': JSON.stringify({
			timestamp: '2024-01-01T12:00:00Z',
			costUSD: 0.001,
			message: {
				model: 'claude-sonnet-4-20250514',
				usage: { input_tokens: 50, output_tokens: 10 },
			},
		}),
	});

	const client = new Client({ name: 'test-client', version: '1.0.0' });
	const server = createMcpServer({ claudePath: fixture.path });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

	const result = await client.listTools();
	expect(result.tools).toHaveLength(6);
});
```

テスト内ヘルパー関数の定義:

```typescript
// apps/ccusage/src/_session-blocks.ts:343-363
if (import.meta.vitest != null) {
	const SESSION_DURATION_MS = 5 * 60 * 60 * 1000;

	function createMockEntry(
		timestamp: Date,
		inputTokens = 1000,
		outputTokens = 500,
		model = 'claude-sonnet-4-20250514',
		costUSD = 0.01,
	): LoadedUsageEntry {
		return {
			timestamp,
			usage: { inputTokens, outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
			costUSD,
			model,
		};
	}
	// ... テストで createMockEntry を活用
}
```

## パターンカタログ

- **In-Source Testing Pattern** (分類: テスト構造)
  - 解決する問題: テストとプロダクションコードの乖離、テスト更新忘れ
  - 適用条件: バンドラーが dead code elimination をサポートしていること。ビルド時にテストコードを確実に除去できるツールチェーンが必要
  - コード例: `apps/ccusage/src/_token-utils.ts:56`, `apps/ccusage/src/calculate-cost.ts:84`
  - 注意点: ファイルサイズが膨張しやすい（data-loader.ts は 4700 行超）。チームの合意とツールサポートが前提

- **Declarative Fixture Pattern** (分類: テストデータ管理)
  - 解決する問題: ファイルシステムテストのセットアップ・ティアダウンの煩雑さ
  - 適用条件: `fs-fixture` のようなオブジェクトリテラル → ファイルシステム変換ライブラリが利用可能であること
  - コード例: `apps/ccusage/src/data-loader.ts:1536`, `apps/mcp/src/mcp.ts:237`
  - 注意点: 大きなディレクトリ構造を表現するとオブジェクトリテラル自体が冗長になる

- **RAII Cleanup Pattern** (分類: リソース管理)
  - 解決する問題: テスト後の一時ファイル・リソースのクリーンアップ漏れ
  - 適用条件: TC39 Explicit Resource Management（`using` / `await using`）をサポートするランタイム
  - コード例: `apps/ccusage/src/_utils.ts:36`, `apps/ccusage/src/debug.ts:297`
  - 注意点: `using` 構文のトランスパイルサポートが必要（TypeScript 5.2+ 推奨）

## Good Patterns

- **テストガードブロックの統一記法**: `if (import.meta.vitest != null)` をリポジトリ全体で一貫して使用。35 以上のファイルで同一の記法が適用されており、機械的な検索・置換が容易。

```typescript
// 全ファイルで統一された記法
if (import.meta.vitest != null) {
	describe('...', () => { /* ... */ });
}
```

- **ビルドとテストの二重保証**: vitest.config.ts の `includeSource` でテスト検出を行い、tsdown.config.ts の `define: { 'import.meta.vitest': 'undefined' }` でバンドル時に除去。2 段階の保証により、テストコードのプロダクション混入を防止。

```typescript
// vitest 側: テストを検出
test: { includeSource: ['src/**/*.{js,ts}'], globals: true }
// tsdown 側: プロダクションビルドでテストを除去
define: { 'import.meta.vitest': 'undefined' }
```

- **宣言的フィクスチャ + 自動クリーンアップ**: `await using fixture = await createFixture({ ... })` の組み合わせで、テストデータのセットアップと破棄を 1 文で表現。`afterEach` での手動クリーンアップが不要。

```typescript
// apps/ccusage/src/debug.ts:297-310
await using fixture = await createFixture({
	'test.jsonl': JSON.stringify({
		timestamp: '2024-01-01T12:00:00Z',
		costUSD: 0.00015,
		message: {
			model: 'claude-sonnet-4-20250514',
			usage: { input_tokens: 50, output_tokens: 0 },
		},
	}),
});
// fixture はスコープを抜けると自動的にクリーンアップされる
```

- **テストブロック内のヘルパー関数**: `_session-blocks.ts` の `createMockEntry()` のように、テストガードブロック内にファクトリ関数を定義することで、テスト専用ヘルパーがプロダクションコードに漏れることを防ぎつつ、テストの冗長性を低減。

## Anti-Patterns / 注意点

- **ファイル肥大化のリスク**: `data-loader.ts` は実装 + テストで 4700 行超に達しており、可読性・保守性の観点で問題がある。in-source testing の利点（コロケーション）が、ファイルサイズの制約と衝突する。

```typescript
// Bad: 1 ファイルに実装 1400 行 + テスト 3300 行
// apps/ccusage/src/data-loader.ts (4700+ 行)
```

```typescript
// Better: テスト量が多い場合はファイル分割を検討
// data-loader.ts        -- 実装のみ
// data-loader.vitest.ts -- テストのみ（vitest の includeSource を調整）
// ただし ccusage では意図的にこの方針を採用している点に注意
```

- **globals スタイルの不統一**: 大部分のファイルは `globals: true` により `describe`, `it`, `expect` をインポートなしで使用しているが、`_project-names.ts` では `const { describe, it, expect } = import.meta.vitest` と destructuring している。同一リポジトリ内でスタイルが混在すると、新規コントリビューターが迷う。

```typescript
// Bad: 2 つのスタイルが混在
// ファイル A: describe('...', () => { ... }) -- globals 経由
// ファイル B: const { describe, it, expect } = import.meta.vitest; -- 明示的取得
```

```typescript
// Better: リポジトリ全体で 1 つのスタイルに統一
// globals: true を設定済みなら、全ファイルで直接使用に統一
```

## 導出ルール

- `[MUST]` in-source testing を採用する場合、ビルドツールの `define` オプションで `import.meta.vitest` を `undefined` に置き換え、テストコードがプロダクションバンドルに含まれないことを保証する
  - 根拠: ccusage では tsdown.config.ts の `define: { 'import.meta.vitest': 'undefined' }` と vitest.config.ts の `includeSource` の 2 層で保証している（`apps/ccusage/tsdown.config.ts:33`, `apps/ccusage/vitest.config.ts:7`）

- `[MUST]` ファイルシステムに依存するテストでは、一時ディレクトリ・ファイルのクリーンアップを `await using`（Explicit Resource Management）または同等のライフサイクル管理機構に委ねる -- 手動の `afterEach` クリーンアップは漏れのリスクがある
  - 根拠: ccusage の 120 以上の `await using fixture = await createFixture(...)` 呼び出しすべてで `using` による自動破棄が使われており、`afterEach` での `fixture.cleanup()` は一切存在しない

- `[SHOULD]` テストのファイルシステムセットアップは宣言的記法（オブジェクトリテラル → ディレクトリ構造）で記述し、`mkdir` / `writeFile` の手続き的チェーンを避ける
  - 根拠: `createFixture({ projects: { 'test-project': { 'session.jsonl': '...' } } })` のような宣言的記法が ccusage 全体で使用されており、テストの Arrange セクションの意図が明確に読み取れる（`apps/ccusage/src/data-loader.ts:1536`）

- `[SHOULD]` テストブロック内でのみ使用するヘルパー関数・定数は、テストガードブロックの内側に定義してプロダクションコードへの漏洩を防ぐ
  - 根拠: `_session-blocks.ts:343-363` の `createMockEntry()` 関数や `SESSION_DURATION_MS` 定数は `if (import.meta.vitest != null)` ブロック内に閉じ込められている

- `[SHOULD]` vitest の `globals: true` を有効化した場合、`import.meta.vitest` からの destructuring を避けて直接呼び出しに統一する -- スタイル混在は可読性を損なう
  - 根拠: ccusage では 35 ファイル中 34 ファイルが globals による直接使用だが、`_project-names.ts:157` のみ destructuring スタイルが混在している

- `[AVOID]` in-source testing で動的インポート（`await import()`）を使用すること -- バンドラーの静的解析を阻害し、テスト専用依存がプロダクションバンドルに残るリスクがある
  - 根拠: CLAUDE.md で明示的に「DO NOT use `await import()` dynamic imports anywhere in the codebase」と禁止されており、tree-shaking の信頼性確保が理由として記載されている

## 適用チェックリスト

- [ ] vitest.config に `includeSource` と `globals: true` を設定し、in-source testing を有効化する
- [ ] ビルドツール（tsdown, Vite, esbuild 等）で `define: { 'import.meta.vitest': 'undefined' }` を設定し、プロダクションビルドからテストコードを除去する
- [ ] テストガードブロックの記法を `if (import.meta.vitest != null) { ... }` に統一する
- [ ] `fs-fixture` または同等のライブラリを導入し、ファイルシステムテストを宣言的に記述する
- [ ] 一時ファイルを使うテストで `await using` による自動クリーンアップを採用する
- [ ] テスト専用のヘルパー関数・定数がガードブロック外に漏れていないことを確認する
- [ ] 動的インポート（`await import()`）がテストブロック内外で使用されていないことを確認する
- [ ] 1 ファイルの行数が過大（800 行超）になっていないか定期的に確認し、必要に応じてテストの分離を検討する
