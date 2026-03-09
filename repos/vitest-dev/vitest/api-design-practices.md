# api-design-practices

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-05

## 概要

expect/spy/snapshot という 3 つの独立パッケージが Jest 互換の公開 API を形成しつつ、Chai プラグインシステムをバックエンドとして活用している設計を分析する。互換レイヤの構築手法、拡張ポイント（`expect.extend`・`addSerializer`・`SnapshotEnvironment`）の設計、エイリアスによる段階的廃止戦略は、既存エコシステムとの互換性を維持しつつ独自拡張を加える汎用的なプラクティスとして注目に値する。

## 背景にある原則

- **互換 API は薄いアダプタレイヤで実装すべき（自前で再発明しない）**: expect パッケージは Chai のプラグインシステム (`ChaiPlugin`) を通じて Jest API を実装しており、アサーションエンジン自体は再実装していない。Chai の `utils.addMethod` / `utils.addProperty` / `utils.overwriteMethod` という拡張機構の上に Jest 互換 API を構築することで、Chai エコシステムとの互換を維持しながら Jest ユーザーの期待にも応えている (`packages/expect/src/jest-expect.ts:38`)
- **パッケージ境界で責務を分離し、個別利用を可能にすべき**: `@vitest/expect`・`@vitest/spy`・`@vitest/snapshot` はそれぞれ独立した npm パッケージとして公開され、vitest 本体なしでも利用可能。spy パッケージは tinyspy に依存せず自前実装に切り替え済みで、外部依存を最小化している (`packages/spy/src/index.ts`)
- **拡張ポイントはプロトコル（インターフェース）として定義し、実装を差し替え可能にすべき**: `SnapshotEnvironment` インターフェースは `resolvePath` / `readSnapshotFile` / `saveSnapshotFile` 等の操作を抽象化し、Node.js 以外の環境（ブラウザ等）でもスナップショット機能を利用可能にしている (`packages/snapshot/src/types/environment.ts:3-12`)
- **非推奨 API はエイリアスとして維持し、型レベルで `@deprecated` を付与して段階的に移行を促すべき**: `toBeCalled` → `toHaveBeenCalled` 等の Jest レガシー名はランタイムでは同一実装を共有しつつ、型定義で `@deprecated` を明示している (`packages/expect/src/types.ts:463`)

## 実例と分析

### Chai プラグインによる Jest API の構築

`JestChaiExpect` は `ChaiPlugin` 型の関数として実装される。内部のヘルパー `def()` が `utils.addMethod` を呼び出し、Chai の `Assertion.prototype` と Jest のグローバルマッチャーオブジェクトの両方にメソッドを登録する。この二重登録により、Chai スタイル (`expect(x).to.equal(y)`) と Jest スタイル (`expect(x).toEqual(y)`) の両方が動作する。

```typescript
// packages/expect/src/jest-expect.ts:42-62
function def(
  name: keyof Assertion | (keyof Assertion)[],
  fn: (this: Chai.AssertionStatic & Assertion, ...args: any[]) => any,
) {
  const addMethod = (n: keyof Assertion) => {
    const softWrapper = wrapAssertion(utils, n, fn)
    utils.addMethod(chai.Assertion.prototype, n, softWrapper)
    utils.addMethod(
      (globalThis as any)[JEST_MATCHERS_OBJECT].matchers,
      n,
      softWrapper,
    )
  }
  if (Array.isArray(name)) {
    name.forEach(n => addMethod(n))
  } else {
    addMethod(name)
  }
}
```

配列を受け付ける設計により、`['toHaveBeenCalledTimes', 'toBeCalledTimes']` のようにエイリアスを簡潔に定義できる (`packages/expect/src/jest-expect.ts:543`)。

### expect.extend によるカスタムマッチャー拡張

`JestExtend` プラグインは `expect.extend(matchers)` を Chai の `use()` に委譲する。各カスタムマッチャーは以下の 3 箇所に同時登録される:

1. `chai.Assertion.prototype` (インスタンスメソッド)
2. `expect[matcherName]` (非対称マッチャー: `expect.toSatisfy(fn)`)
3. `expect.not[matcherName]` (否定非対称マッチャー)

カスタムマッチャーが自動的に非対称マッチャーとしても使えるようになる点が特筆される。`JestExtendPlugin` 内で `CustomMatcher extends AsymmetricMatcher` クラスを動的に生成し、`asymmetricMatch` メソッドを通じて既存マッチャーを再利用する (`packages/expect/src/jest-extend.ts:127-153`)。

### Mock API のフルエントチェーン設計

`@vitest/spy` の `MockInstance` は全ての設定メソッドが `this` を返すフルエントインターフェースを持つ:

```typescript
// packages/spy/src/index.ts:81-89
mock.mockImplementation = function mockImplementation(implementation) {
  config.mockImplementation = implementation
  return mock
}
mock.mockImplementationOnce = function mockImplementationOnce(implementation) {
  config.onceMockImplementations.push(implementation)
  return mock
}
```

`mockClear` → `mockReset` → `mockRestore` の 3 段階リセットは、Jest と同一のセマンティクスを維持しつつ、各段階で `this` を返すことで `mock.mockClear().mockImplementation(fn)` のようなチェーンを可能にしている (`packages/spy/src/index.ts:197-219`)。

### 状態管理: WeakMap によるグローバル状態の隔離

expect の状態は `WeakMap<ExpectStatic, MatcherState>` で管理される。キーを `expect` インスタンスそのものにすることで、テストごとに `createExpect()` で新しいインスタンスを生成してもグローバル状態と衝突しない:

```typescript
// packages/expect/src/state.ts:9-10
if (!Object.hasOwn(globalThis, MATCHERS_OBJECT)) {
  const globalState = new WeakMap<ExpectStatic, MatcherState>()
```

`Symbol.for()` を使ったグローバルキー (`packages/expect/src/constants.ts:1-6`) により、複数バージョンの vitest が同一プロセスで共存する場合でもシンボル名の一致で同じ状態を参照できる。

### Snapshot の環境抽象化

`SnapshotEnvironment` インターフェースは 7 つのメソッドを定義し、ファイル I/O を完全に抽象化する:

```typescript
// packages/snapshot/src/types/environment.ts:3-12
export interface SnapshotEnvironment {
  getVersion: () => string
  getHeader: () => string
  resolvePath: (filepath: string) => Promise<string>
  resolveRawPath: (testPath: string, rawPath: string) => Promise<string>
  saveSnapshotFile: (filepath: string, snapshot: string) => Promise<void>
  readSnapshotFile: (filepath: string) => Promise<string | null>
  removeSnapshotFile: (filepath: string) => Promise<void>
  processStackTrace?: (stack: ParsedStack) => ParsedStack
}
```

`processStackTrace` のみオプショナルで、残りは必須。Node.js 実装 (`NodeSnapshotEnvironment`) がデフォルトだが、ブラウザテスト時は別実装に差し替えられる。

### Proxy による非同期アサーションの透過的処理

`.resolves` / `.rejects` / `.poll()` は `Proxy` を使って既存のマッチャーチェーンをラップし、同期マッチャーを非同期コンテキストで透過的に使えるようにする:

```typescript
// packages/expect/src/jest-expect.ts:1091-1136
const proxy: any = new Proxy(this, {
  get: (target, key, receiver) => {
    const result = Reflect.get(target, key, receiver)
    if (typeof result !== 'function') {
      return result instanceof chai.Assertion ? proxy : result
    }
    return (...args: any[]) => {
      // ...Promise でラップして非同期実行
    }
  },
})
```

`expect.poll()` は同様の Proxy パターンで、タイムアウトまでリトライするポーリングアサーションを実現している (`packages/vitest/src/integrations/chai/poll.ts:66-164`)。

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: Chai のプラグイン API と Jest の `expect` API という 2 つの異なるインターフェースの橋渡し
  - 適用条件: 既存ライブラリの機能を別の API 体系で公開したい場合
  - コード例: `packages/expect/src/jest-expect.ts:38` (`JestChaiExpect` プラグイン全体)
  - 注意点: アダプタが厚くなるとバグの温床になる。薄い委譲を維持すること

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: スナップショットのファイル I/O を実行環境ごとに切り替える
  - 適用条件: 同一ロジックが複数の実行環境で動作する必要がある場合
  - コード例: `packages/snapshot/src/types/environment.ts:3` (`SnapshotEnvironment` インターフェース)
  - 注意点: インターフェースのメソッド数を最小限に抑え、必須/オプションを明確にする

- **Proxy パターン** (分類: 構造)
  - 解決する問題: 同期的なマッチャーチェーンを非同期コンテキスト（Promise 解決後やポーリング）で透過的に利用する
  - 適用条件: 既存の同期 API を非同期に拡張したい場合
  - コード例: `packages/expect/src/jest-expect.ts:1091` (`.resolves` の Proxy 実装)
  - 注意点: Proxy の `get` トラップ内で `instanceof` チェックが必要（Chai.Assertion インスタンスの再帰的ラップ防止）

## Good Patterns

- **エイリアス付きメソッド登録で互換性と明確な推奨を両立**: `def(['toHaveBeenCalledTimes', 'toBeCalledTimes'], fn)` のように配列でエイリアスを登録し、型定義側で旧名に `@deprecated` を付与する。ランタイムコストゼロで移行期間を確保できる (`packages/expect/src/jest-expect.ts:543`, `packages/expect/src/types.ts:441-443`)

- **カスタムマッチャーの自動的な非対称マッチャー化**: `expect.extend()` で登録されたマッチャーは自動的に `expect.matcherName()` / `expect.not.matcherName()` としても使えるようになる。ユーザーが追加コードを書く必要がなく、API の一貫性が保たれる (`packages/expect/src/jest-extend.ts:127-184`)

- **段階的リセット API（clear/reset/restore）**: `mockClear` (呼び出し記録のみクリア) → `mockReset` (実装もリセット) → `mockRestore` (元のオブジェクトを復元) という 3 段階を提供し、テストの粒度に応じた制御を可能にする (`packages/spy/src/index.ts:197-219`)

- **Chai スタイルと Jest スタイルの両方をサポートする委譲パターン**: `ChaiStyleAssertions` プラグインは `defProperty('called', 'toHaveBeenCalled')` のように Chai スタイル名を Jest 実装に委譲するだけの薄いレイヤ。実装の重複を避けつつ、両スタイルのユーザーを取り込む (`packages/expect/src/chai-style-assertions.ts:3-80`)

## Anti-Patterns / 注意点

- **グローバル状態への Symbol.for キーによる暗黙的依存**: `Symbol.for('$$jest-matchers-object')` 等のグローバルシンボルで状態を共有する設計は、初期化順序に依存する脆弱性を持つ。`state.ts` の `if (!Object.hasOwn(globalThis, MATCHERS_OBJECT))` ガードは必須だが、複数の vitest バージョンが混在する場合に予期せぬ衝突が起こりうる。

```typescript
// Bad: ガードなしのグローバル登録
;(globalThis as any)[Symbol.for('my-state')] = new Map()

// Better: hasOwn ガード + WeakMap で GC 可能に
if (!Object.hasOwn(globalThis, MY_SYMBOL)) {
  Object.defineProperty(globalThis, MY_SYMBOL, {
    get: () => new WeakMap(),
  })
}
```

- **Proxy の過剰利用による型安全性の喪失**: `.resolves` / `.rejects` / `.poll()` の Proxy 実装は `any` 型に頼っており、IDE の型推論が効きにくい。`PromisifyAssertion<T>` 型で型レベルではカバーしているが、ランタイムと型定義の乖離リスクがある。

```typescript
// Bad: Proxy 内部で any に頼る
const proxy: any = new Proxy(this, { get: ... })

// Better: Proxy の返却型を明示的に制約する
const proxy = new Proxy(this, { get: ... }) as PromisifyAssertion<T>
```

## 導出ルール

- `[MUST]` 互換 API を提供する場合、既存ライブラリのプラグイン/拡張機構を活用し、コアロジックの再実装を避ける
  - 根拠: vitest は Chai のプラグインシステムで Jest API を構築しており、アサーションエンジン自体は再実装していない (`packages/expect/src/jest-expect.ts:38`)

- `[MUST]` 公開 API の拡張ポイントはインターフェース（プロトコル）で定義し、デフォルト実装と分離する
  - 根拠: `SnapshotEnvironment` インターフェースにより Node.js 実装をデフォルト提供しつつ、ブラウザ環境への差し替えを可能にしている (`packages/snapshot/src/types/environment.ts`)

- `[SHOULD]` 非推奨 API はランタイムでエイリアスとして維持し、型定義の `@deprecated` で移行を促す（即座に削除しない）
  - 根拠: `toBeCalled` / `toBeCalledWith` 等は実装を共有しつつ型で `@deprecated` を付与し、移行期間を確保している (`packages/expect/src/types.ts:463`)

- `[SHOULD]` テストフレームワークの API では、設定メソッドの戻り値を `this` にしてフルエントチェーンを可能にする
  - 根拠: `MockInstance` の全設定メソッドが `this` を返し、`mock.mockReturnValue(1).mockName('test')` のようなチェーンを実現 (`packages/spy/src/index.ts:81-84`)

- `[SHOULD]` `expect.extend()` で登録されたカスタムマッチャーは、非対称マッチャー（`expect.matcherName()`）としても自動的に使えるようにする
  - 根拠: `JestExtendPlugin` がカスタムマッチャーごとに `AsymmetricMatcher` サブクラスを動的生成し、`expect` と `expect.not` の両方に登録する (`packages/expect/src/jest-extend.ts:127-184`)

- `[AVOID]` グローバルシンボルを初期化ガードなしで使う（複数バージョン共存時のレースコンディション）
  - 根拠: `state.ts` は `Object.hasOwn` ガードで二重初期化を防止しているが、ガードを省略すると予期せぬ状態上書きが発生する (`packages/expect/src/state.ts:9`)

- `[AVOID]` Proxy ベースの API 拡張で `any` 型に頼る（型安全性とランタイム動作の乖離を生む）
  - 根拠: `.resolves` の Proxy 実装は `any` キャストを使用しており、型定義 (`PromisifyAssertion<T>`) との整合性はコンパイル時チェックの範囲外 (`packages/expect/src/jest-expect.ts:1091`)

## 適用チェックリスト

- [ ] 互換 API を提供する際、コアロジックを再実装するのではなく、既存ライブラリのプラグイン機構を活用しているか
- [ ] 公開 API の拡張ポイントがインターフェースとして定義され、デフォルト実装と分離されているか
- [ ] 非推奨 API にランタイム互換性を維持したうえで `@deprecated` アノテーションが付与されているか
- [ ] 設定系メソッドが `this` を返すフルエントインターフェースになっているか
- [ ] グローバル状態を使う場合、二重初期化防止ガードが入っているか
- [ ] カスタム拡張が登録されたとき、関連する全てのコンテキスト（インスタンスメソッド・非対称マッチャー・否定形）に自動で伝播するか
- [ ] Proxy ベースの API 拡張に対応する型定義が用意されているか
