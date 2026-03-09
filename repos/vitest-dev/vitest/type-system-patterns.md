# type-system-patterns

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-06

## 概要

vitest の型システムは、テストフレームワークとしてのユーザー拡張性を最大化するために設計されている。空の interface を拡張ポイントとして公開し、declaration merging でユーザーやプラグインが型を追加できる仕組みが体系的に構築されている。さらに、ジェネリクスと条件型を駆使してアサーションチェーンの型安全性を実現し、`ThisType<T>` や mapped type による高度な型変換パターンが多数見られる。この分析では、カスタムマッチャーの型拡張、ジェネリクスによる型安全アサーション、declaration merging の活用パターンを横断的に抽出する。

## 背景にある原則

- **空 interface による拡張ポイントの明示**: 拡張可能な型は空の interface として定義し、ユーザーが declaration merging で自由にプロパティを追加できるようにする。具体例として `Matchers<T>`, `TaskMeta`, `TestContext`, `ProvidedContext`, `TestArtifactRegistry` が全て空 interface で宣言されている。型パラメータ名のコメントまで残して拡張時の互換性を保証している (`packages/expect/src/types.ts:104-107`)。

- **条件型による型レベルの分岐制御**: ランタイムの分岐をコンパイル時に型で表現し、不正な使い方をコンパイルエラーで検出する。`Mock<T>` 型は `T extends Constructable` で new 呼び出し可能かどうかを分岐し、`Fixture<T, K>` は関数値と静的値を条件型で区別する。これにより、ランタイムエラーではなくコンパイル時エラーで不整合を検出できる。

- **module augmentation による段階的な型合成**: パッケージ間の型依存を `declare module` で解決し、コアパッケージを薄く保ちながら、上位パッケージが必要な型を注入する。`@vitest/expect` の `Assertion` に snapshot メソッドを追加するのは `vitest` パッケージ側で行われる (`packages/vitest/src/types/global.ts:24-94`)。

- **`string & Record<never, never>` によるオートコンプリート保持パターン**: ユニオン型でリテラル候補を提示しつつ任意の文字列も許容するために `string & Record<never, never>` を使用する。`string` 単体だとリテラル候補が消えるが、この交差型でエディタの補完を維持できる (`packages/vitest/src/node/types/config.ts:38-41`)。

## 実例と分析

### 空 interface + declaration merging による拡張ポイント設計

vitest のコードベースには、ユーザーやプラグインが型を拡張できるよう設計された空 interface が複数存在する。

**`Matchers<T>`** (`packages/expect/src/types.ts:107`) はカスタムマッチャーの型拡張ポイント。ユーザーが `expect.extend()` でマッチャーを追加した際に、対応する型を宣言できる。`Assertion<T>` interface が `Matchers<T>` を extends しているため、merging した型が自動的にアサーションチェーンに反映される。

**`TaskMeta`** (`packages/runner/src/types/tasks.ts:148`) はテストメタデータの拡張ポイント。vitest 本体が `declare module '@vitest/runner'` で `typecheck` や `benchmark` プロパティを追加する (`packages/vitest/src/types/global.ts:108-111`)。

**`TestArtifactRegistry`** (`packages/runner/src/types/tasks.ts:1438`) はプラグインがカスタムアーティファクト型を登録するための空 interface。登録した型は `TestArtifact` ユニオン型に自動的に含まれる (`packages/runner/src/types/tasks.ts:1447-1451`)。

**`ProvidedContext`** (`packages/vitest/src/types/general.ts:28`) は `inject()` 関数の型安全性を支える空 interface。ユーザーが declaration merging でキーと値の型を定義すると、`inject<T extends keyof ProvidedContext & string>(key: T): ProvidedContext[T]` の型推論が効く (`packages/vitest/src/integrations/inject.ts:8-12`)。

### module augmentation によるパッケージ間の型注入

vitest はモノレポ構成で複数パッケージに分かれており、コアパッケージの型を上位パッケージが拡張する。

`packages/vitest/src/types/global.ts` では `declare module '@vitest/expect'` と `declare module '@vitest/runner'` で2つのパッケージの型を同時に拡張している。`ExpectStatic` に `soft`, `poll`, `assertions` メソッドを追加し、`Assertion<T>` に snapshot 関連メソッドを追加する。

ブラウザパッケージ (`packages/browser/matchers.d.ts`) は `declare module 'vitest'` で `JestAssertion` に `TestingLibraryMatchers` を注入し、`ExpectStatic` に `element()` メソッドを追加する。

プロバイダパッケージ (`packages/browser-playwright/src/playwright.ts:609-658`) は `declare module 'vitest/node'` と `declare module 'vitest/browser'` で Playwright 固有の型 (`Page`, `BrowserContext` 等) をコマンドコンテキストやイベントオプションに注入する。

### 条件型とジェネリクスによる型安全アサーション

**`VitestAssertion<A, T>`** (`packages/expect/src/types.ts:624-630`) は Chai の `Assertion` をラップし、チェーンメソッドの戻り値型を `Assertion<T>` に変換する mapped type。関数型はそのまま保持し (オーバーロード対応)、`Chai.Assertion` を返すプロパティだけを `Assertion<T>` に書き換える。

**`Promisify<O>`** (`packages/expect/src/types.ts:632-636`) はアサーションオブジェクトの全メソッドの戻り値を `Promise<R>` に変換する再帰的 mapped type。`resolves` / `rejects` で使用され、`PromisifyAssertion<T>` として公開される。

**`DeeplyAllowMatchers<T>`** (`packages/expect/src/types.ts:211-215`) は再帰的条件型で、任意のネスト深度のオブジェクト/配列に対して `AsymmetricMatcher` の使用を許可する。`objectContaining` や `arrayContaining` の引数型として使われ、ユーザーが `expect.any(String)` 等をネストした位置で使えるようにする。

### Mock 型の条件型分岐

**`Mock<T>`** (`packages/spy/src/types.ts:387-406`) は `T extends Constructable` で分岐し、コンストラクタの場合は `new` 呼び出しと通常呼び出しの両方をサポートする型を生成する。さらに `{ [P in keyof T]: T[P] }` でオリジナルのプロパティも保持する。

**`MockParameters<T>`** と **`MockReturnType<T>`** (`packages/spy/src/types.ts:44-52`) は `T extends Constructable ? ConstructorParameters<T> : Parameters<T>` の条件型パターンで、コンストラクタと通常関数の両方に対応する。

### method-signature-style の意図的な使い分け

`packages/spy/src/types.ts:197-208` のコメントは、TypeScript の method signature (`foo(x: T): U`) と property signature (`foo: (x: T) => U`) で共変性/反変性の挙動が異なることを明示している。Jest との互換性のために method signature を意図的に選択し、`eslint-disable ts/method-signature-style` で lint ルールを無効化している。

### Builder パターンの型安全な fixture 拡張

`test.extend()` の型定義 (`packages/runner/src/types/tasks.ts:669-738`) は 10 個のオーバーロードで構成され、builder パターンで fixture を追加するたびに `TestAPI<ExtraContext>` の型パラメータが成長する。`AddBuilderWorker<C, K, T>` 等の型ユーティリティ (`packages/runner/src/types/tasks.ts:920-942`) は、スコープ情報を `$__worker`, `$__file`, `$__test` という phantom property で型レベルに保持し、fixture 間のスコープ依存を型で制約する。

## コード例

```typescript
// packages/expect/src/types.ts:104-114
// 空 interface + eslint コメントで拡張ポイントを明示
// Allow unused `T` to preserve its name for extensions.
// Type parameter names must be identical when extending those types.
// eslint-disable-next-line
export interface Matchers<T = any> {}

export type MatchersObject<T extends MatcherState = MatcherState> = Record<
  string,
  RawMatcherFn<T>
> & ThisType<T> & {
  [K in keyof Matchers<T>]?: RawMatcherFn<T, Parameters<Matchers<T>[K]>>
}
```

```typescript
// packages/vitest/src/types/global.ts:24-48
// module augmentation でコアパッケージの型を拡張
declare module '@vitest/expect' {
  interface MatcherState {
    environment: string
    snapshotState: SnapshotState
  }

  interface ExpectStatic {
    assert: Chai.AssertStatic
    unreachable: (message?: string) => never
    soft: <T>(actual: T, message?: string) => Assertion<T>
    poll: <T>(
      actual: () => T,
      options?: ExpectPollOptions,
    ) => PromisifyAssertion<Awaited<T>>
    addEqualityTesters: (testers: Array<Tester>) => void
    assertions: (expected: number) => void
    hasAssertions: () => void
    addSnapshotSerializer: (plugin: PrettyFormatPlugin) => void
  }
}
```

```typescript
// packages/expect/src/types.ts:624-638
// 再帰的 mapped type でアサーションチェーンを型変換
type VitestAssertion<A, T> = {
  [K in keyof A]: A[K] extends Chai.Assertion
    ? Assertion<T>
    : A[K] extends (...args: any[]) => any
      ? A[K] // not converting function since they may contain overload
      : VitestAssertion<A[K], T>;
} & ((type: string, message?: string) => Assertion)

type Promisify<O> = {
  [K in keyof O]: O[K] extends (...args: infer A) => infer R
    ? Promisify<O[K]> & ((...args: A) => Promise<R>)
    : O[K];
}
```

```typescript
// packages/runner/src/types/tasks.ts:1438-1451
// 空 interface + keyof による自動ユニオン拡張
export interface TestArtifactRegistry {}

export type TestArtifact
  = | FailureScreenshotArtifact
    | TestAnnotationArtifact
    | VisualRegressionArtifact
    | TestArtifactRegistry[keyof TestArtifactRegistry]
```

```typescript
// packages/vitest/src/node/types/config.ts:38-41
// string & Record<never, never> でオートコンプリートを維持
export type VitestEnvironment
  = | BuiltinEnvironment
    | (string & Record<never, never>)
```

```typescript
// packages/spy/src/types.ts:387-406
// 条件型でコンストラクタと通常関数を分岐
export type Mock<T extends Procedure | Constructable = Procedure> = MockInstance<T> & (
  T extends Constructable
    ? (
        T extends Procedure
          ? {
              new (...args: ConstructorParameters<T>): InstanceType<T>
              (...args: Parameters<T>): ReturnType<T>
            }
          : {
              new (...args: ConstructorParameters<T>): InstanceType<T>
            }
      )
    : {
        new (...args: MockParameters<T>): MockReturnType<T>
        (...args: MockParameters<T>): MockReturnType<T>
      }
) & { [P in keyof T]: T[P] }
```

## パターンカタログ

- **Extension Interface パターン** (分類: 構造)
  - 解決する問題: ライブラリのコア型をユーザーが安全に拡張する方法の提供
  - 適用条件: プラグインやカスタム拡張をサポートするライブラリの型設計
  - コード例: `packages/expect/src/types.ts:107`, `packages/runner/src/types/tasks.ts:148`, `packages/vitest/src/types/general.ts:28`
  - 注意点: 型パラメータ名を保持しないと拡張時にエラーになる (eslint-disable コメントで明示)

- **Phantom Type パターン** (分類: 構造)
  - 解決する問題: 型レベルでメタデータを伝播させ、コンパイル時の制約を実現する
  - 適用条件: ランタイム値には影響しないが型レベルでのスコープ制約が必要な場面
  - コード例: `packages/runner/src/types/tasks.ts:920-942` (`$__worker`, `$__file`, `$__test`)
  - 注意点: phantom property は `readonly` かつ optional にして実行時の影響を排除する

- **Recursive Mapped Type パターン** (分類: 構造)
  - 解決する問題: 深くネストしたオブジェクト型全体に変換を適用する
  - 適用条件: 型変換が再帰的に全プロパティに波及する必要がある場合
  - コード例: `packages/expect/src/types.ts:211-215` (`DeeplyAllowMatchers`), `packages/expect/src/types.ts:632-636` (`Promisify`)
  - 注意点: 再帰が深すぎると TypeScript の型インスタンス化制限に到達する可能性がある

## Good Patterns

- **`MatchersObject` における `ThisType<T>` の活用**: カスタムマッチャー定義時に `this` の型を `MatcherState` に固定し、マッチャー関数内で `this.isNot`, `this.utils` 等にアクセスできるようにする。`Record<string, RawMatcherFn<T>> & ThisType<T>` という交差型で、任意のキーのマッチャーを受け入れつつ `this` コンテキストを型安全にする (`packages/expect/src/types.ts:109-114`)。

```typescript
// packages/expect/src/types.ts:109-114
export type MatchersObject<T extends MatcherState = MatcherState> = Record<
  string,
  RawMatcherFn<T>
> & ThisType<T> & {
  [K in keyof Matchers<T>]?: RawMatcherFn<T, Parameters<Matchers<T>[K]>>
}
```

- **`TestArtifactRegistry[keyof TestArtifactRegistry]` による自動ユニオン拡張**: 空 interface の keyof を indexed access type でユニオンに変換することで、ユーザーが interface に型を追加するだけでユニオンが自動拡張される。ビルトイン型とカスタム型を同じユニオンで扱える (`packages/runner/src/types/tasks.ts:1447-1451`)。

```typescript
// packages/runner/src/types/tasks.ts:1447-1451
export type TestArtifact
  = | FailureScreenshotArtifact
    | TestAnnotationArtifact
    | VisualRegressionArtifact
    | TestArtifactRegistry[keyof TestArtifactRegistry]
```

- **`satisfies` による型安全な静的配列定義**: ビルトイン fixture 名のリストを `satisfies (keyof TestContext)[]` で型チェックし、文字列配列としてのランタイム値と型の一貫性を保証する (`packages/runner/src/fixture.ts:33`)。

```typescript
// packages/runner/src/fixture.ts:33
private static _builtinFixtures: string[] = [
  'task', 'signal', 'onTestFailed', 'onTestFinished', 'skip', 'annotate',
] satisfies (keyof TestContext)[]
```

## Anti-Patterns / 注意点

- **method signature と property signature の混同**: TypeScript では `{ foo(x: T): U }` (method) と `{ foo: (x: T) => U }` (property) で共変性の扱いが異なる。method signature はパラメータに対して bivariant (双変) で、property signature は contravariant (反変)。意図しない assignability を許容してしまう可能性がある。vitest は Jest 互換のため意図的に method signature を使い、その理由をコメントで明示している。

```typescript
// Bad: 意図せず method signature を選択
interface Handler {
  handle(input: string): void  // bivariant: Handler<string> に Handler<string | number> を代入可能
}

// Better: 型安全性を重視するなら property signature
interface Handler {
  handle: (input: string) => void  // contravariant: 厳密な引数型チェック
}
// ただし Jest 互換等の理由がある場合は method signature + コメントで意図を明示
```

- **declaration merging 時の型パラメータ名不一致**: 空 interface を拡張する際、元の interface の型パラメータ名と一致させないとエラーになる。vitest は `// Allow unused T to preserve its name for extensions` というコメントで、未使用の型パラメータを残す理由を明示している (`packages/expect/src/types.ts:104-106`)。

```typescript
// Bad: 型パラメータ名を変えて拡張しようとする
export interface Matchers<T = any> {}
// 別ファイルで:
interface Matchers<V> {  // Error: パラメータ名が T でないため merging 失敗
  toBePositive(): void
}

// Better: 元の型パラメータ名を維持
interface Matchers<T> {
  toBePositive(): void
}
```

## 導出ルール

- `[MUST]` ライブラリの拡張ポイントとなる型は空 interface として宣言し、ユーザーが declaration merging で型を追加できるようにする
  - 根拠: vitest は `Matchers`, `TaskMeta`, `TestContext`, `ProvidedContext`, `TestArtifactRegistry` を全て空 interface で宣言し、プラグインやユーザーコードからの型拡張を可能にしている
- `[MUST]` 空 interface の型パラメータが拡張時に必要な場合、未使用でも削除せずコメントで理由を明記する
  - 根拠: `Matchers<T>` の `T` は本体では未使用だが、拡張時にパラメータ名の一致が必要なため eslint-disable + コメントで保持している (`packages/expect/src/types.ts:104-107`)
- `[SHOULD]` `ThisType<T>` を使ってコールバック定義オブジェクトの `this` コンテキストを型安全にする
  - 根拠: `MatchersObject` は `ThisType<MatcherState>` でマッチャー関数内の `this` アクセスを型安全にしている (`packages/expect/src/types.ts:112`)
- `[SHOULD]` リテラルユニオンで候補を提示しつつ任意の文字列も許容する場合は `LiteralUnion | (string & Record<never, never>)` パターンを使う
  - 根拠: `VitestEnvironment` 型がビルトイン環境名の補完を維持しつつカスタム環境名を許容するために使用 (`packages/vitest/src/node/types/config.ts:38-41`)
- `[SHOULD]` 空 interface + `Registry[keyof Registry]` パターンでプラグインが型を自動登録できるユニオンを構築する
  - 根拠: `TestArtifactRegistry` に型を追加するだけで `TestArtifact` ユニオンが自動拡張される設計 (`packages/runner/src/types/tasks.ts:1438-1451`)
- `[SHOULD]` method signature と property signature の選択理由をコメントで明示する（TypeScript の variance の違いにより型の互換性が変わるため）
  - 根拠: `MockInstance` が意図的に method signature を使い、eslint-disable + 詳細コメントで理由を記録している (`packages/spy/src/types.ts:197-208`)
- `[AVOID]` module augmentation で拡張する型を class で定義する（class は declaration merging でプロパティ追加ができないため）
  - 根拠: vitest の拡張ポイントは全て interface であり、class を使うと `declare module` での型追加が不可能になる

## 適用チェックリスト

- [ ] ライブラリの公開 API で拡張が必要な型を空 interface として定義しているか
- [ ] 空 interface の型パラメータ名が拡張側と一致するようコメントで保護しているか
- [ ] `declare module` によるパッケージ間の型注入が、循環依存を避ける方向で設計されているか
- [ ] コールバック定義オブジェクト (`extend()`, `register()` 等) に `ThisType<T>` を適用してコンテキスト型を提供しているか
- [ ] リテラルユニオン + 任意文字列の型で `string & Record<never, never>` パターンを使いオートコンプリートを維持しているか
- [ ] method signature vs property signature の選択を意識し、variance の違いを理解した上で使い分けているか
- [ ] プラグインシステムの型設計で Registry パターン (空 interface + `keyof` indexed access) を検討したか
