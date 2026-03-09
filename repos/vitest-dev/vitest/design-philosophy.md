# design-philosophy

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-05

## 概要

Vitest の設計思想を、Vite-powered テストの根拠、ESM-first 方針、no-mock テストポリシー、オプション抑制の哲学という4軸から分析する。テストフレームワーク自身がどのような設計原則でテストを書き、依存を管理し、設定の複雑性と戦っているかは、あらゆるツール開発・ライブラリ設計に応用できる知見を含む。特に「テストフレームワーク自体のテストでモックを禁止する」というポリシーは、E2E 的テスト戦略の極端かつ成功例として注目に値する。

## 背景にある原則

- **既存インフラの再利用で差別化する**: Vitest は独自のモジュール変換パイプラインを構築せず、Vite の `DevEnvironment` / `ModuleRunner` / プラグインシステムをそのままテスト実行基盤として使う。これにより、プロダクションコードと同じ変換（JSX, TypeScript, CSS Modules 等）がテスト時にも適用され、設定の二重管理が不要になる。根拠: `packages/vitest/src/node/environments/serverRunner.ts` で `ModuleRunner` from `vite/module-runner` を直接継承し、テストファイルの読み込みに Vite のモジュール変換を利用している。

- **スマートデフォルトでオプションの増殖を防ぐ**: 新しいオプションを追加する前に「より賢いデフォルトで解決できないか」「プラグインで対応できないか」を問う。設定項目の爆発はユーザー体験の劣化に直結するという原則。根拠: CONTRIBUTING.md に "Think before adding yet another option" として明文化され、`packages/vitest/src/defaults.ts` では `watch: !isCI && process.stdin.isTTY` のように環境を自動判定するスマートデフォルトを多用している。

- **テストはモックではなく実際の振る舞いを検証する**: テストフレームワーク自身のテストでモック・スパイを一切禁止する。テスト対象を実際に起動し、その出力・結果をスナップショットで検証する。これにより内部実装の変更に対する脆弱性（Fragile Test）を排除する。根拠: AGENTS.md に "No mocking policy -- You must never mock anything in tests" と明記。

- **依存は機能に対するサイズ比で判断する**: 機能の大小ではなく、トランジティブ依存を含めた「サイズ対価値」で依存追加を判断する。要件を満たさない場合はフォークして軽量化する。根拠: CONTRIBUTING.md "Avoid deps that has large transitive dependencies that results in bloated size compared to the functionality it provides"。依存の実例として `tinybench`, `tinyexec`, `tinyglobby`, `tinyrainbow` 等の tiny-* ライブラリ群を採用。

## 実例と分析

### Vite パイプラインの再利用

Vitest のテスト実行は Vite の DevServer をそのまま起動し、テストファイルを Vite のモジュールグラフを通じて解決・変換する。`ServerModuleRunner` は Vite の `ModuleRunner` を直接継承し、`fetchModule` で Vite の変換パイプラインを経由する。

```typescript
// packages/vitest/src/node/environments/serverRunner.ts:9-16
export class ServerModuleRunner extends ModuleRunner {
  constructor(
    private environment: DevEnvironment,
    fetcher: VitestFetchFunction,
    private config: ResolvedConfig,
  ) {
    super(
      {
        hmr: false,
        transport: {
          async invoke(event) {
            // Vite の fetchModule を経由してモジュールを取得
```

この設計により、Vite プラグイン（JSX 変換、TypeScript コンパイル、パスエイリアス解決等）がテスト時にも自動的に適用される。ユーザーは `vite.config.ts` の設定をテスト用に複製する必要がない。

### パフォーマンス駆動のエントリポイント分割

Rollup の設定でワーカー種別ごとにエントリを分離し、不要なコードの読み込みを回避している。

```javascript
// packages/vitest/rollup.config.js:36-41
// for performance reasons we bundle them separately so we don't import everything at once
// 'worker': 'src/runtime/worker.ts',
'workers/forks': 'src/runtime/workers/forks.ts',
'workers/threads': 'src/runtime/workers/threads.ts',
'workers/vmThreads': 'src/runtime/workers/vmThreads.ts',
'workers/vmForks': 'src/runtime/workers/vmForks.ts',
```

全パッケージで `"sideEffects": false` を宣言し（`@vitest/runner` のみ `true`）、全パッケージが `"type": "module"` で ESM-first を徹底している。

### No-mock テストポリシーの実践

Vitest 自身のテストは `runInlineTests` / `runVitest` ユーティリティを使い、テスト対象の Vitest を実際に起動して、その stdout/stderr/テスト結果ツリーを検証する。

```typescript
// test/cli/test/detect-async-leaks.test.ts:4-18
test('does not report leaks when disabled', async () => {
  const { stdout, stderr } = await runInlineTests({
    'packages/example/test/example.test.ts': `
      test('leaks', () => {
        setTimeout(() => {}, 100_000)
        setInterval(() => {}, 100_000)
        new Promise((resolve) => {})
      })
    `,
  }, {
    detectAsyncLeaks: false,
  })

  expect.soft(stdout).not.toContain('Leak')
  expect.soft(stderr).toBe('')
})
```

`runInlineTests` は一時ディレクトリにファイルシステムを構築し、実際に `startVitest` を呼び出す。テスト後は `onTestFinished` フックで自動クリーンアップされる。これは「モックでなく実物を動かす」ポリシーの基盤インフラである。

### toMatchInlineSnapshot 推奨と toContain 禁止

AGENTS.md で `toContain` を禁止し `toMatchInlineSnapshot` を推奨する理由は、`toContain` が「余分な出力」「繰り返し出力」「微妙なフォーマット差異」を見逃すためである。インラインスナップショットはコードレビュー時に期待値の変化が可視化され、リグレッション検出精度が上がる。

```typescript
// test/cli/test/detect-async-leaks.test.ts:48-72
  expect(stderr).toMatchInlineSnapshot(`
    "
    ⎯⎯⎯⎯⎯⎯⎯ Async Leaks 2 ⎯⎯⎯⎯⎯⎯⎯⎯

    Timeout leaking in packages/example/test/example.test.ts
      3|
      4|       test('leak in test file', () => {
      5|         setTimeout(() => {}, 100_000)
       |         ^
    ...
    "
  `)
```

### サブパスエクスポートによるバンドルサイズ最適化

`@vitest/utils` はメインエントリからのインポートを避け、`@vitest/utils/helpers`, `@vitest/utils/error`, `@vitest/utils/timers` 等のサブパスインポートを強制する。AGENTS.md にも "Use utilities from `@vitest/utils/*` when available. Never import from `@vitest/utils` main entry point directly." と明記されている。

```typescript
// packages/vitest/src/node/core.ts:21-22
import { deepClone, deepMerge, nanoid, toArray } from '@vitest/utils/helpers'
import { serializeValue } from '@vitest/utils/serialize'
```

これにより、各パッケージが必要な関数だけを読み込み、不要なモジュールの初期化コストを回避する。

### 環境検知によるスマートデフォルト

```typescript
// packages/vitest/src/defaults.ts:94-96
allowOnly: !isCI,
watch: !isCI && process.stdin.isTTY,
open: !isCI,
```

CI 環境では watch モードを無効化し、`.only` を禁止する。ローカル開発では TTY を検出して watch モードをデフォルト有効にする。ユーザーが明示的に設定しなくても、実行環境に応じて適切な振る舞いになる。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: テスト実行環境（forks, threads, vmThreads, browser）の差異を吸収する
  - 適用条件: 同一インターフェースで異なる実行戦略を切り替える必要がある場合
  - コード例: `packages/vitest/src/node/pool.ts:38-45` の `builtinPools` 定義と、ワーカー別エントリ分割
  - 注意点: 各 Strategy を独立バンドルにすることで、使わない Strategy のコードをロードしない

- **Facade パターン** (分類: 構造)
  - 解決する問題: Vite の複雑な内部 API をテスト実行に適した簡潔なインターフェースに変換する
  - 適用条件: 既存システムの上にドメイン固有のインターフェースを構築する場合
  - コード例: `packages/vitest/src/node/environments/serverRunner.ts` が `ModuleRunner` を継承し、テスト固有のモジュール解決ロジックを追加
  - 注意点: 下位レイヤーの変更に追従するコストが発生する（Vite のメジャーバージョン互換性管理）

## Good Patterns

- **Integration Test as Primary Test**: テストフレームワークの検証に、フレームワーク自身を実際に起動して結果を検証するパターン。`runInlineTests` が一時ファイルシステム構築 → Vitest 起動 → 結果検証 → クリーンアップを一連で行う。モックによる偽陽性を完全排除し、リファクタリング耐性が極めて高い。

```typescript
// test/test-utils/index.ts:501-527
export async function runInlineTests(
  structure: TestFsStructure,
  config?: RunVitestConfig,
  options?: VitestRunnerCLIOptions,
  task?: TestContext['task'],
) {
  const root = resolve(process.cwd(), `vitest-test-${crypto.randomUUID()}`)
  const fs = useFS(root, structure, undefined, task)
  const vitest = await runVitest({ root, ...config }, [], options)
  return { fs, root, ...vitest, /* ... */ }
}
```

- **Automatic Cleanup via Test Lifecycle**: `onTestFinished` を活用した自動クリーンアップパターン。テストごとにリソース（一時ファイル、プロセス）を確実に解放し、テスト間の状態汚染を防ぐ。

```typescript
// test/test-utils/index.ts:357-361
export function createFile(file: string, content: string) {
  fs.mkdirSync(dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf-8')
  onTestFinished(() => {
    if (fs.existsSync(file)) { fs.unlinkSync(file) }
  })
}
```

- **Subpath Exports for Tree Shaking**: パッケージのメインエントリではなくサブパスからインポートすることで、不要なコードの読み込みを防ぐ。`@vitest/utils/helpers`, `@vitest/utils/error` 等が独立エントリポイントとして公開される。

## Anti-Patterns / 注意点

- **toContain による出力検証**: 部分一致アサーションは余分な出力、重複出力、フォーマット変更を検出できない。テスト結果の信頼性が低下する。

```typescript
// Bad: 余分な出力やフォーマット変更を見逃す
expect(stderr).toContain('Error: something failed')

// Better: 出力全体をスナップショットで検証
expect(stderr).toMatchInlineSnapshot(`
  "Error: something failed
   ❯ test.ts:5:3"
`)
```

- **テストフレームワーク内部のモック化**: テスト対象の内部モジュールをモックすると、リファクタリングのたびにテストが壊れる。実物を動かすことで、内部構造の変更に対してテストが安定する。

```typescript
// Bad: 内部モジュールをモックしてユニットテスト
vi.mock('./runner', () => ({ run: vi.fn() }))
test('calls runner', () => { /* ... */ })

// Better: 実際に起動して結果を検証
const { testTree } = await runInlineTests({ 'test.ts': '...' })
expect(testTree()).toMatchInlineSnapshot(`...`)
```

- **メインエントリからの一括インポート**: ユーティリティパッケージのメインエントリからインポートすると、使わない関数まで初期化される。パフォーマンスクリティカルなパスでは致命的。

```typescript
// Bad: メインエントリから全関数をロード
import { slash } from '@vitest/utils'

// Better: サブパスから必要な関数だけをロード
import { slash } from '@vitest/utils/helpers'
```

## 導出ルール

- `[MUST]` テストでは部分一致（toContain）より完全一致（toMatchInlineSnapshot）を優先し、期待値の変化をコードレビューで可視化する
  - 根拠: Vitest は toContain を禁止し toMatchInlineSnapshot を標準とすることで、出力変更の見逃しを防いでいる（AGENTS.md, vitest-test-writer.md）

- `[MUST]` ユーティリティパッケージはサブパスエクスポートで機能を分離し、メインエントリからの一括インポートを禁止する
  - 根拠: `@vitest/utils` は `/helpers`, `/error`, `/timers` 等12個のサブパスに分離され、AGENTS.md で "Never import from main entry point directly" と明記

- `[SHOULD]` 既存ツールのインフラ（変換パイプライン、プラグインシステム等）を再利用し、独自実装を最小化する
  - 根拠: Vitest は Vite の `ModuleRunner` / `DevEnvironment` をそのまま利用し、モジュール解決・変換の独自実装を回避している

- `[SHOULD]` 新しい設定オプションを追加する前に「スマートデフォルト」「プラグイン化」「既存オプションでの回避策」を検討する
  - 根拠: CONTRIBUTING.md "Think before adding yet another option" — 4つの判断基準（対処の価値、スマートデフォルト、既存回避策、プラグイン化）が明文化

- `[SHOULD]` テストはモックではなく実際のシステムを起動して振る舞いを検証し、リファクタリング耐性を高める
  - 根拠: Vitest の全統合テストは `runInlineTests` で実際に Vitest を起動し、モック使用率ゼロで結果を検証

- `[SHOULD]` 依存追加はトランジティブ依存を含むサイズ対価値で判断し、要件を満たさない場合はフォークを検討する
  - 根拠: CONTRIBUTING.md "Avoid deps that has large transitive dependencies" + tiny-* ライブラリ群の一貫した採用

- `[SHOULD]` パフォーマンスクリティカルな実行パスでは、バンドルエントリを機能単位で分割し、不要コードの初期ロードを回避する
  - 根拠: `rollup.config.js` で "for performance reasons we bundle them separately" としてワーカー種別ごとにエントリを分離

- `[AVOID]` テストでの内部実装のモック化 — 内部構造への結合度が高まり、リファクタリングのたびにテストが壊れる
  - 根拠: AGENTS.md "No mocking policy -- You must never mock anything in tests" により、Vitest 自身のテストスイート全体でモック使用を排除

## 適用チェックリスト

- [ ] プロジェクトのテストで `toContain` による出力検証を `toMatchInlineSnapshot` に置き換えられる箇所がないか確認する
- [ ] ユーティリティパッケージのエクスポートがサブパスに分離されているか、メインエントリが肥大化していないか確認する
- [ ] テストスイートでモックを使っている箇所が「本当にモックが必要か」を再評価し、統合テストに置き換えられないか検討する
- [ ] 既存のビルドツールやフレームワークのインフラ（変換パイプライン、プラグイン等）を再利用できる箇所がないか確認する
- [ ] 新しい設定オプションの追加時に「スマートデフォルトで解決できないか」「プラグインで対応できないか」を先に検討するプロセスがあるか確認する
- [ ] 依存追加時にトランジティブ依存のサイズを確認するステップがあるか確認する
- [ ] パフォーマンスクリティカルなパスで不要なモジュールが初期ロードされていないか確認する
