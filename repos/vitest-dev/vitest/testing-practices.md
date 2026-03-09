# testing-practices

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-06

## 概要

テストフレームワーク自身のテスト戦略を分析した。Vitest は自分自身（vitest）を使って vitest をテストするセルフホスティングアーキテクチャを採用し、モックを一切使わない No-mock ポリシーを徹底している。テストフレームワークが自らの API でテストを書くことで、ドッグフーディングとリグレッション検出を同時に実現している点が注目に値する。`runInlineTests` というユーティリティにより、テストコード内にテスト対象のファイルシステム構造を宣言的に記述し、実際に vitest プロセスを起動して結果を検証する統合テスト戦略が特徴的である。

## 背景にある原則

- **セルフホスティングによるドッグフーディング**: テストフレームワーク自身を使ってテストすることで、ユーザーが遭遇する問題を開発者が最初に体験する。vitest のテストスイートは vitest で実行され、自身のバグがテストの実行自体を壊すため、品質のフィードバックループが極めて短い。根拠: `test/cli/vitest.config.ts` で vitest の設定ファイルを使い、`test/test-utils/index.ts:23` で `import { afterEach, onTestFinished, TestRunner } from 'vitest'` と自身の API をインポートしている。

- **No-mock ポリシーによる信頼性確保**: モックを使うと実際の動作との乖離が生じる。特にテストフレームワーク自体のテストでは、内部実装をモックすると「モックが正しいか」のテストになってしまう。実際のプロセスを起動し、実際の stdout/stderr を捕捉することで、ユーザーと同じ体験を検証する。根拠: `AGENTS.md:45` に "No mocking policy - You must never mock anything in tests" と明記。

- **宣言的テスト構造による再現性**: ファイルシステムの状態をテストコード内にインラインで宣言し、テスト終了時に自動クリーンアップすることで、テスト間の状態汚染を防ぐ。根拠: `test/test-utils/index.ts:501-527` の `runInlineTests` が一時ディレクトリを作成し、`onTestFinished` で自動削除する。

- **スナップショット優先のアサーション**: `toContain` による部分一致ではなく `toMatchInlineSnapshot` を使うことで、エラーメッセージの全体構造を記録し、意図しない変更を検出する。根拠: `AGENTS.md:38` に "Prefer using `toMatchInlineSnapshot` to include the test error and its stack" と明記。

## 実例と分析

### セルフホスティングアーキテクチャ

Vitest のテストは 3 層構造になっている:

1. **ホストレイヤー**: テスト自体を実行する vitest プロセス（`test/cli/vitest.config.ts` で設定）
2. **ユーティリティレイヤー**: `runVitest` / `runInlineTests` がホストプロセス内で別の vitest インスタンスを起動
3. **テスト対象レイヤー**: ユーティリティが起動した vitest が実行するフィクスチャテスト

ホストレイヤーは `isolate: false`, `fileParallelism: false`, `maxWorkers: 1`（ユーティリティ側で設定）で実行される。これは入れ子の vitest プロセスがリソースを競合しないための設計判断である。

```ts
// test/cli/vitest.config.ts:8-10
testTimeout: 60_000,
isolate: false,
fileParallelism: false,
```

### runInlineTests: 宣言的ファイルシステムテスト

`runInlineTests` は以下の設計上の工夫を持つ:

1. **関数をテストコードに変換**: JavaScript の関数リテラルを文字列化してテストファイルとして書き出す。型チェックが効くインラインテスト定義を実現している
2. **自動設定ファイル生成**: `vitest.config.js` が構造体に含まれていない場合、空の設定ファイルを自動生成する（`useFS` の `ensureConfig` パラメータ）
3. **一時ディレクトリの自動管理**: `crypto.randomUUID()` でユニークなディレクトリを作成し、`onTestFinished` で自動削除

```ts
// test/test-utils/index.ts:501-507
export async function runInlineTests(
  structure: TestFsStructure,
  config?: RunVitestConfig,
  options?: VitestRunnerCLIOptions,
  task?: TestContext['task'],
) {
  const root = resolve(process.cwd(), `vitest-test-${crypto.randomUUID()}`)
```

テストコードでの使用例 (`test/cli/test/print-error.test.ts:4-28`):

```ts
test('prints a custom error stack', async () => {
  const { stderr } = await runInlineTests({
    'basic.test.ts': `
    test('failed test', () => {
      throw {
        message: 'from failed test',
        stack: ['stack 1', 'stack 2'],
      }
    })
    `,
  }, { globals: true })

  expect(stderr).toContain(`
 FAIL  basic.test.ts > failed test
Unknown Error: from failed test
    `.trim())
})
```

### onTestFinished によるリソース自動クリーンアップ

`test/test-utils/index.ts` ではリソースクリーンアップに一貫して `onTestFinished` を使用している。これにより:

- テスト失敗時でもクリーンアップが保証される
- 各テストが明示的に `afterEach` を書く必要がない
- リソースの作成と破棄が同じコンテキストにまとまる

```ts
// test/test-utils/index.ts:354-361
export function createFile(file: string, content: string) {
  fs.mkdirSync(dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf-8')
  onTestFinished(() => {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file)
    }
  })
}
```

`runVitest` でも `process.exit` のモンキーパッチを復元するために同様のパターンが使われている (`test/test-utils/index.ts:219-230`)。

### stdout/stderr キャプチャと結果ツリー

`runVitest` は vitest の stdout/stderr を `Writable` ストリームでキャプチャし、`Cli` クラスで管理する。テスト結果は `testTree()`, `errorTree()`, `buildTree()` といったヘルパーで構造化されたオブジェクトに変換される。これにより `toMatchInlineSnapshot` との組み合わせで、テスト結果の全体像を宣言的に検証できる。

```ts
// test/cli/test/test-tags.test.ts:19-48
expect(getTestTree(buildTree)).toMatchInlineSnapshot(`
  {
    "basic.test.ts": {
      "suite 1": {
        "suite 2": {
          "test 3": ["suite", "alone", "suite_2"],
          ...
        },
      },
    },
  }
`)
```

### Fixture ベースの統合テスト

`test/cli/fixtures/` に実際のプロジェクト構成をそのまま配置し、`runVitest({ root: './fixtures/...' })` で実行する方式も併用されている。`runInlineTests` は単一テスト内で完結するシナリオに、fixture ディレクトリは複雑な設定や複数ファイルが関与するシナリオに使い分けられている。

## Good Patterns

- **宣言的ファイルシステム構造体パターン**: テストに必要なファイル群をオブジェクトリテラルで宣言し、テストユーティリティが一時ディレクトリを作成・クリーンアップする。テスト本体とテストデータが同じファイルに存在するため可読性が高く、テスト間の干渉がない。`runInlineTests` の `TestFsStructure` 型定義 (`test/test-utils/index.ts:384-391`) で文字列・設定オブジェクト・関数を受け入れる柔軟な設計。

- **リソースライフサイクルの自動管理**: `onTestFinished` をユーティリティ内部で呼ぶことで、呼び出し側がクリーンアップを意識する必要がない。`createFile`, `editFile`, `useFS`, `runVitest` のすべてがこのパターンに従う。ファイルの作成・変更を行う関数が自分自身のクリーンアップ責任を持つ「セルフクリーニング関数」パターン。

- **結果ツリーによるスナップショット検証**: テスト結果を木構造のプレーンオブジェクトに変換してからスナップショットで検証する。状態（passed/failed/skipped）、エラーメッセージ、メタデータなど、検証したい情報に応じて `testTree()`, `errorTree()`, `buildTree(callback)` を使い分ける。

- **プロセス分離なしの統合テスト**: `startVitest` を同一プロセス内で呼び出し、`process.exit` を無効化して制御を維持する (`test/test-utils/index.ts:80-81`)。子プロセスの起動コストを避けつつ、実際の vitest コアパスを通す高速な統合テストを実現。

## Anti-Patterns / 注意点

- **toContain による部分一致検証**: エラーメッセージの一部だけを `toContain` で検証すると、メッセージの他の部分が壊れても気づけない。AGENTS.md で明確に非推奨とされている。

```ts
// Bad: エラーの一部しか検証していない
expect(stderr).toContain('Error: something failed')

// Better: エラー全体をスナップショットで記録
expect(stderr).toMatchInlineSnapshot(`
  "
  ⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
   FAIL  basic.test.ts
  Error: something failed
   ❯ basic.test.ts:2:9
  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
  "
`)
```

- **テストユーティリティ内でのモック使用**: テストフレームワーク自体のテストでモックを使うと、モック実装の正しさを別途保証する必要がある。実際のプロセスを動かすことで、モック不整合のリスクを排除する。`test/cli/test/workers-option.test.ts` に `vi.mock` が存在するが、これはユーティリティ関数の単体テストであり、vitest のコア動作のテストではない。

## 導出ルール

- `[MUST]` テストフレームワークやCLIツールの統合テストでは、実際のプロセス/APIを実行して stdout/stderr を検証する -- モックで代替しない
  - 根拠: Vitest は `startVitest` を実行し stdout/stderr をキャプチャするユーティリティを全テストスイートで一貫して使用しており、AGENTS.md で No-mock ポリシーを明文化している

- `[MUST]` テストが作成・変更したリソース（ファイル、プロセス、グローバル状態）は、テスト終了時のフックで自動クリーンアップする
  - 根拠: `createFile`, `editFile`, `useFS`, `runVitest` のすべてが `onTestFinished` でクリーンアップを登録しており、テスト間の状態汚染を構造的に防止している (`test/test-utils/index.ts:354-377`)

- `[SHOULD]` エラーメッセージやCLI出力の検証にはインラインスナップショットを使い、出力全体を記録する
  - 根拠: AGENTS.md が `toMatchInlineSnapshot` を推奨し `toContain` を非推奨としている。出力全体を記録することで、意図しないメッセージ変更を検出できる

- `[SHOULD]` テストに必要なファイル構造は、テスト本体にインラインで宣言的に定義する
  - 根拠: `runInlineTests` の `TestFsStructure` パターンにより、テストの意図と前提条件が一箇所にまとまり、外部フィクスチャディレクトリへの暗黙の依存がなくなる

- `[SHOULD]` セルフホスティング可能なツール（テストフレームワーク、リンター、フォーマッター等）は自分自身を使ってテストする
  - 根拠: Vitest が vitest でテストを実行することで、ユーザー体験と同じパスを検証し、ドッグフーディングのフィードバックループを形成している

- `[AVOID]` 統合テストのホストプロセスとテスト対象プロセスで同一リソースを共有する構成を避ける -- ワーカー数・並列度を制限して競合を防ぐ
  - 根拠: `runVitest` はデフォルトで `maxWorkers: 1` に制限し (`test/test-utils/index.ts:167`)、ホスト側も `fileParallelism: false` に設定してリソース競合を回避している

## 適用チェックリスト

- [ ] プロジェクトのテストで、外部プロセスやサブシステムの出力をモックせずに実際に実行して検証しているか
- [ ] テストが作成する一時ファイル・ディレクトリに、テスト終了時の自動クリーンアップが設定されているか
- [ ] エラーメッセージやCLI出力のアサーションに `toContain` ではなくスナップショットを使っているか
- [ ] テスト用のファイル構造が宣言的に定義され、テスト本体から参照できるか
- [ ] 自プロジェクトがツール（フレームワーク、CLI等）の場合、そのツール自身でテストを実行しているか
- [ ] 統合テストでリソース競合を防ぐため、並列度やワーカー数を適切に制限しているか
- [ ] テストユーティリティがリソースの作成と破棄を内部で完結させ、呼び出し側にクリーンアップ責任を漏洩させていないか
