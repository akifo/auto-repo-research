# browser-testing-abstraction

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-06

## 概要

Vitest のブラウザテスト機構は、Playwright・WebDriverIO・Preview の 3 つのプロバイダを統一 API で抽象化する設計を持つ。`@vitest/browser` がコア抽象層とクライアントサイドの基底 Locator クラスを提供し、`@vitest/browser-playwright` と `@vitest/browser-webdriverio` がそれぞれプロバイダ固有の実装を差し込む。テストコード側は `vitest/browser` の統一 API のみを使い、プロバイダの違いを意識しない。この多層抽象の設計は、ブラウザ自動化ツールに限らず「複数バックエンドを持つ統一インターフェース」全般に応用できるプラクティスの宝庫である。

## 背景にある原則

- **インターフェース分離による交換可能性**: `BrowserProvider` インターフェースは `openPage`・`close`・`getCommandsContext`・`getCDPSession` など最小限のメソッドだけを定義し、プロバイダ固有のライフサイクル管理（ブラウザ起動・コンテキスト管理等）は各実装に委ねている。これにより新プロバイダの追加が既存コードに影響しない（`packages/vitest/src/node/types/browser.ts:39-51`）。

- **宣言的な型拡張による差分表現**: TypeScript の `declare module` を使い、各プロバイダが `BrowserCommandContext` や `UserEventClickOptions` 等のインターフェースを拡張する。コア側は抽象的な型のみを持ち、プロバイダのインストールによって型が「完成する」設計。コードの依存方向を逆転させ、コアがプロバイダを知らずに済む（`packages/browser-playwright/src/playwright.ts:609-616`、`packages/browser-webdriverio/src/webdriverio.ts:318-321`）。

- **コマンドの名前ベース登録による拡張性**: ブラウザ操作コマンドは文字列名で登録・呼び出しされ、プロバイダごとに同名のコマンドを異なる実装で上書きできる。ユーザー定義コマンドも同じ仕組みで追加可能。静的なメソッド呼び出しではなく動的ディスパッチを選択することで、プラグインによる拡張が自然に実現される（`packages/browser/src/node/project.ts:57-86`）。

- **クライアント-サーバー間の関心分離**: ブラウザ内で動作するクライアントコード（Locator・UserEvent）とサーバーサイドのコマンド実装を明確に分離し、WebSocket RPC で接続する。Locator はブラウザ内の DOM 操作とセレクタ解決を担い、実際のブラウザ自動化操作（click, fill 等）はサーバーサイドのプロバイダコマンドに委譲される。

## 実例と分析

### プロバイダファクトリパターン

各プロバイダは `defineBrowserProvider` ヘルパーを通じて統一フォーマットの `BrowserProviderOption` を返す。このヘルパーが `serverFactory` を自動注入するため、プロバイダ実装者は `name`・`supportedBrowser`・`providerFactory` だけ指定すればよい。

```typescript
// packages/browser-playwright/src/playwright.ts:94-103
export function playwright(options: PlaywrightProviderOptions = {}): BrowserProviderOption<PlaywrightProviderOptions> {
  return defineBrowserProvider({
    name: 'playwright',
    supportedBrowser: playwrightBrowsers,
    options,
    providerFactory(project) {
      return new PlaywrightBrowserProvider(project, options)
    },
  })
}
```

```typescript
// packages/browser-webdriverio/src/webdriverio.ts:32-41
export function webdriverio(options: WebdriverProviderOptions = {}): BrowserProviderOption<WebdriverProviderOptions> {
  return defineBrowserProvider({
    name: 'webdriverio',
    supportedBrowser: webdriverBrowsers,
    options,
    providerFactory(project) {
      return new WebdriverBrowserProvider(project, options)
    },
  })
}
```

### コマンドの対称実装

両プロバイダは同名のコマンド（`__vitest_click`、`__vitest_fill` 等）を、プロバイダ固有の API を使って実装する。コマンドのシグネチャは共通の `UserEventCommand` 型で統一されており、差異はプロバイダ内部に閉じ込められる。

Playwright 版の click は `context.iframe.locator(selector).click(options)` で完了するのに対し、WebDriverIO 版は `browser.$(selector).click(options)` を使う。tripleClick では差がさらに顕著で、Playwright が `clickCount: 3` オプションで宣言的に処理する一方、WebDriverIO は低レベルなポインターアクションシーケンスを組み立てる。

### Locator 基底クラスと差し替え

`@vitest/browser/locators` に定義された抽象 `Locator` クラスが共通 API（`click`、`fill`、`getByRole` 等）を提供する。各プロバイダは `PlaywrightLocator`・`WebdriverIOLocator` として具象クラスを実装し、`page.extend()` で `page` オブジェクトのファクトリメソッドを上書きする。

```typescript
// packages/browser-playwright/src/locators.ts:87-91
page.extend({
  getByLabelText(text, options) {
    return new PlaywrightLocator(getByLabelSelector(text, options))
  },
  // ...
})
```

```typescript
// packages/browser-webdriverio/src/locators.ts:173-178
page.extend({
  getByLabelText(text, options) {
    return new WebdriverIOLocator(getByLabelSelector(text, options))
  },
  // ...
})
```

### declare module による型の段階的完成

コアの `BrowserCommandContext` は `testPath`・`provider`・`project`・`sessionId` のみ定義する。Playwright プロバイダが `page`・`frame`・`iframe`・`context` を追加し、WebDriverIO プロバイダが `browser` を追加する。これによりコマンド実装内でプロバイダ固有のオブジェクトに型安全にアクセスできる。

同様に `UserEventClickOptions` 等のオプション型も各プロバイダが拡張する。Playwright は `PWClickOptions`（position, modifiers 等）を、WebDriverIO は `Partial<ClickOptions>` + `SelectorOptions` を合成する。テストコード側からは統一された型として見える。

### バリデーション付きプロバイダ解決

`getBrowserProvider` 関数がプロバイダ解決時に以下を検証する: ブラウザ名の指定有無、`provider` の存在、サポート対象ブラウザの一致、`providerFactory` 関数の存在。エラーメッセージにはプロジェクト名とサポート対象ブラウザ一覧を含め、デバッグを容易にしている。

```typescript
// packages/browser/src/node/utils.ts:67-93
export async function getBrowserProvider(
  options: ResolvedBrowserOptions,
  project: TestProject,
): Promise<BrowserProvider> {
  // ...
  if (supportedBrowsers.length && !supportedBrowsers.includes(browser)) {
    throw new Error(
      `${name}Browser "${browser}" is not supported by the browser provider "${
        options.provider.name
      }". Supported browsers: ${supportedBrowsers.join(', ')}.`,
    )
  }
  // ...
}
```

## コード例

```typescript
// packages/vitest/src/node/types/browser.ts:39-51
// プロバイダインターフェース: 最小限の契約
export interface BrowserProvider {
  name: string
  mocker?: BrowserModuleMocker
  readonly initScripts?: string[]
  supportsParallelism: boolean
  getCommandsContext: (sessionId: string) => Record<string, unknown>
  openPage: (sessionId: string, url: string, options: { parallel: boolean }) => Promise<void>
  getCDPSession?: (sessionId: string) => Promise<CDPSession>
  close: () => Awaitable<void>
}
```

```typescript
// packages/browser/src/node/project.ts:74-86
// 名前ベースのコマンドディスパッチ: プロバイダ → 親 → エラー の順
public triggerCommand = (<K extends keyof BrowserCommand>(
  name: K,
  context: BrowserCommandContext,
  ...args: Parameters<BrowserCommands[K]>
): ReturnType<BrowserCommands[K]> => {
  if (name in this.commands) {
    return this.commands[name](context, ...args)
  }
  if (name in this.parent.commands) {
    return this.parent.commands[name](context, ...args)
  }
  throw new Error(`Provider ${this.provider.name} does not support command "${name}".`)
}) as any
```

```typescript
// packages/browser/src/client/tester/locators/index.ts:73-74,90-91,221-222
// 抽象 Locator: 共通操作を定義し、セレクタ解決を子クラスに委譲
export abstract class Locator {
  public abstract selector: string
  // ...
  public click(options?: UserEventClickOptions): Promise<void> {
    return this.triggerCommand<void>('__vitest_click', this.selector, options)
  }
  // ...
  protected abstract locator(selector: string): Locator
  protected abstract elementLocator(element: Element): Locator
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 複数のブラウザ自動化バックエンドを統一 API で利用する
  - 適用条件: 同じ操作を異なる実装で提供する必要がある場合
  - コード例: `BrowserProvider` インターフェース（`packages/vitest/src/node/types/browser.ts:39-51`）と各プロバイダクラス
  - 注意点: Strategy の粒度が粗すぎると差異の吸収が困難になる。Vitest はプロバイダ（粗粒度）とコマンド（細粒度）の 2 層で解決している

- **Abstract Factory パターン** (分類: 生成)
  - 解決する問題: プロバイダに応じた Locator・コマンドコンテキスト等の関連オブジェクト群の生成
  - 適用条件: 複数の関連オブジェクトを一貫したファミリーとして生成する場合
  - コード例: `defineBrowserProvider` が `providerFactory` + `serverFactory` をバンドル（`packages/browser/src/node/index.ts:111-120`）
  - 注意点: ファクトリが生成する型が増えすぎると管理が煩雑になる。Vitest は `page.extend()` でファクトリの一部を外部化している

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: Locator の共通操作フローを定義しつつ、セレクタ解決を子クラスに委ねる
  - 適用条件: アルゴリズムの骨格は共通だが一部ステップが変わる場合
  - コード例: `Locator` 基底クラスの `click()` が `triggerCommand` を呼び、`locator()` / `elementLocator()` が abstract（`packages/browser/src/client/tester/locators/index.ts:73-222`）
  - 注意点: 基底クラスが肥大化しやすい。Vitest は操作の大部分をコマンド側に委譲して基底クラスを薄く保っている

- **Command パターン** (分類: 振る舞い)
  - 解決する問題: クライアント（ブラウザ）とサーバー間でブラウザ操作を遅延実行・転送する
  - 適用条件: 操作の発行元と実行先が異なるプロセス/環境に存在する場合
  - コード例: `triggerCommand` による名前ベースのコマンド発行と `registerCommand` による登録（`packages/browser/src/node/project.ts:59-86`）
  - 注意点: コマンド名のタイポが実行時エラーになる。Vitest は `__vitest_` プレフィクスと型定義（`BrowserCommands` インターフェース拡張）で緩和している

## Good Patterns

- **ヘルパー関数によるボイラープレート削減**: `defineBrowserProvider` がサーバーファクトリの自動注入と型の正規化を行い、プロバイダ実装者の負担を軽減する。新しいプロバイダを追加する際に必要な知識を最小化している。

```typescript
// packages/browser/src/node/index.ts:111-120
export function defineBrowserProvider<T extends object = object>(options: Omit<
  BrowserProviderOption<T>,
  'serverFactory' | 'options'
> & { options?: T }): BrowserProviderOption {
  return {
    ...options,
    options: options.options || {},
    serverFactory: createBrowserServer,
  }
}
```

- **graceful な closing 制御**: 両プロバイダが `closing` フラグと `_throwIfClosing` メソッドを持ち、非同期操作中のプロバイダ破棄による競合状態を防止する。新規操作開始時にフラグを確認し、必要なら中間リソースのクリーンアップも行う。

```typescript
// packages/browser-playwright/src/playwright.ts:516-526
private async _throwIfClosing(disposable?: { close: () => Promise<void> }) {
  if (this.closing) {
    await disposable?.close()
    this.pages.clear()
    this.contexts.clear()
    this.browser = null
    this.browserPromise = null
    throw new Error(`[vitest] The provider was closed.`)
  }
}
```

- **コマンド解決のフォールバックチェーン**: プロバイダ固有コマンド → 親プロジェクトの共通コマンド → エラー、の 3 段階で解決する。プロバイダが独自コマンドで共通コマンドを上書きすることも、共通コマンドをそのまま使うこともできる柔軟な設計。

```typescript
// packages/browser/src/node/project.ts:74-86
if (name in this.commands) {
  return this.commands[name](context, ...args)
}
if (name in this.parent.commands) {
  return this.parent.commands[name](context, ...args)
}
throw new Error(`Provider ${this.provider.name} does not support command "${name}".`)
```

## Anti-Patterns / 注意点

- **型安全性の穴としての `as any` キャスト**: コマンド登録時の `command as BrowserCommand` キャストやコマンドディスパッチの `as any` は、名前ベースディスパッチの型安全性を損なう。

```typescript
// Bad: 型がすり抜ける
for (const [name, command] of Object.entries(commands)) {
  project.browser!.registerCommand(name as any, command as BrowserCommand)
}
```

```typescript
// Better: コマンド定義を型安全なレジストリに登録する
// declare module で BrowserCommands を拡張し、型推論で検証させる
const typedCommands = {
  __vitest_click: click,
  __vitest_fill: fill,
} satisfies Partial<Record<keyof BrowserCommands, BrowserCommand>>
```

- **プロバイダ間での機能差異の暗黙的な吸収**: WebDriverIO の `getCDPSession` は `on`/`once`/`off` が常にエラーを投げるが、これはインターフェース上は区別できない。プロバイダの能力差がランタイムでしか分からない。

```typescript
// Bad: インターフェースを満たすが実際には動作しない
on: () => { throw new Error(`webdriverio provider doesn't support cdp.on()`) },
once: () => { throw new Error(`webdriverio provider doesn't support cdp.once()`) },
```

```typescript
// Better: Capability オブジェクトでプロバイダの能力を宣言的に公開する
interface BrowserProvider {
  capabilities: {
    cdpEvents: boolean
    parallelism: boolean
    tracing: boolean
  }
}
```

## 導出ルール

- `[MUST]` プロバイダ抽象化のインターフェースは最小限の契約に留め、プロバイダ固有のライフサイクル管理は実装側に委ねる
  - 根拠: `BrowserProvider` は 6 メソッド（うち 2 つは optional）のみで、Playwright のコンテキスト管理・WebDriverIO のセッション管理はそれぞれの実装に閉じている（`packages/vitest/src/node/types/browser.ts:39-51`）

- `[MUST]` 統一インターフェースの背後にあるプロバイダ固有のオプションは、`declare module` による型拡張で表現し、コア側の型定義を汚染しない
  - 根拠: `UserEventClickOptions` は Playwright では `PWClickOptions`、WebDriverIO では `Partial<ClickOptions>` に拡張されるが、コアの `vitest/browser` はどちらも知らない（`packages/browser-playwright/src/playwright.ts:644-659`）

- `[SHOULD]` 操作コマンドは名前ベースの登録・ディスパッチで管理し、プロバイダ固有の実装とフォールバック共通実装のチェーンを構築する
  - 根拠: `ProjectBrowser.triggerCommand` がプロバイダコマンド → 親コマンドの順で解決し、プロバイダは共通コマンドの選択的上書きが可能（`packages/browser/src/node/project.ts:74-86`）

- `[SHOULD]` 複数プロバイダが同じ操作を実装する場合、操作シグネチャを共通型（`UserEventCommand<T>`）で統一し、プロバイダ間の差異をコマンド内部に閉じ込める
  - 根拠: Playwright と WebDriverIO の click/fill/hover 等は同じ `UserEventCommand` 型で定義され、テストコードからは区別不能（`packages/browser-playwright/src/commands/utils.ts:5-7`）

- `[SHOULD]` 抽象基底クラスを使う場合、共通ロジックは基底に集約し、プロバイダ差異は abstract メソッドまたはオーバーライドで表現する。ただし基底クラスは薄く保ち、実質的な操作はコマンド層に委譲する
  - 根拠: `Locator` 基底クラスは `triggerCommand` を通じてサーバーサイドに操作を委譲し、自身は約 40 行の abstract 以外のメソッドのみ持つ（`packages/browser/src/client/tester/locators/index.ts:73-378`）

- `[AVOID]` プロバイダ間の機能差異をランタイム例外で暗黙的に処理する。代わりに Capability 宣言やコンパイル時の型チェックで差異を明示する
  - 根拠: WebDriverIO の `getCDPSession` が `on`/`once`/`off` で常にエラーを投げる設計は、利用者がランタイムまで制限に気づけない（`packages/browser-webdriverio/src/webdriverio.ts:270-289`）

- `[AVOID]` プロバイダ実装で非同期リソースの破棄競合を放置する。`closing` フラグ等で新規操作を早期拒否し、進行中のリソースを適切にクリーンアップする
  - 根拠: 両プロバイダが `_throwIfClosing` で破棄中の操作を防ぎ、Playwright は中間の `disposable` も close する（`packages/browser-playwright/src/playwright.ts:516-526`）

## 適用チェックリスト

- [ ] プロバイダインターフェースが最小限の契約（5-8 メソッド以下）に収まっているか確認する
- [ ] プロバイダ固有の型拡張に `declare module` を使い、コアパッケージがプロバイダの型を直接 import していないか確認する
- [ ] コマンド/操作の登録が名前ベースで行われ、プロバイダによる選択的上書きとフォールバックが機能するか確認する
- [ ] 複数プロバイダ間で共通の操作シグネチャ型が定義され、差異がコマンド実装内部に閉じているか確認する
- [ ] 非同期リソースの破棄時に競合状態を防ぐ仕組み（closing フラグ・早期拒否）が実装されているか確認する
- [ ] プロバイダ間の機能差異がドキュメントまたは型レベルで明示されているか確認する
- [ ] ヘルパー関数（`defineXxxProvider` 等）でプロバイダ定義のボイラープレートを削減しているか確認する
