# testing-practices

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod v4 のテスト戦略は、ランタイムバリデーションと TypeScript 型推論の両方を単一テストファイル内で同時に検証する点に特徴がある。Vitest v4 の `typecheck.enabled: true` + `checker: "tsc"` によって、`expectTypeOf` や `satisfies` による型アサーションが実際の tsc コンパイラを通じて検証される。スキーマライブラリという性質上、「型が正しいこと」はランタイムの正しさと同等に重要であり、この統合テストアプローチは型安全な API を提供するライブラリ全般に適用可能なプラクティスである。

## 背景にある原則

- **型テストはランタイムテストと同一ファイルに書くべき**: 型とランタイムの振る舞いを別ファイルに分離すると、片方だけ修正してもう片方が壊れる事態を見逃す。Zod ではほぼ全テストファイルで `expectTypeOf` とランタイムアサーションが共存しており、型とランタイムの一貫性を構造的に強制している（`packages/zod/src/v4/classic/tests/generics.test.ts` 等）
- **console 出力はテストの信頼性を毀損する**: `scripts/fail-on-console.ts` が setupFiles として全テストに適用され、`console.log/warn/error/info/debug` を呼ぶと即座にテストが失敗する。デバッグ用 console の残留を防ぎ、テスト出力のノイズをゼロにする原則
- **インラインスナップショットは構造化出力の回帰検知に最適化されている**: エラーメッセージやスキーマ変換結果など、構造化された出力の検証に `toMatchInlineSnapshot` を集中的に使用する。外部スナップショットファイルではなくインラインにすることで、コードレビュー時に期待値と実装の対応が一目でわかる
- **テストは成功・失敗の両面を常にカバーすべき**: AGENTS.md に "Test both success and failure cases with edge cases" と明記。実際に全テストファイルで `parse`（成功）と `expect(() => ...).toThrow()`（失敗）が対になっている

## 実例と分析

### Vitest 型チェック統合

ルート `vitest.config.ts` で `typecheck.enabled: true` と `checker: "tsc"` を設定し、全テストファイルを型チェック対象にしている。テスト専用 tsconfig (`tsconfig.test.json`) で `noUncheckedIndexedAccess: false` と `noUnusedLocals: false` を緩和することで、テストコードの記述性を維持しつつ型チェックを強制する。

```ts
// vitest.config.ts:18-29
test: {
  projects: ["packages/*"],
  watch: false,
  isolate: true,
  setupFiles: [resolve(__dirname, "scripts/fail-on-console.ts")],
  typecheck: {
    include: ["**/*.test.ts"],
    enabled: true,
    ignoreSourceErrors: false,
    checker: "tsc",
    tsconfig: "./tsconfig.json",
  },
  silent: true,
},
```

`ignoreSourceErrors: false` は重要な選択で、ソースコード自体の型エラーもテスト失敗として検出する。これにより「テストは通るがソースに型エラーがある」状態を防ぐ。

### 3 層の型テスト手法

Zod では型の正しさを検証するために 3 つの手法を使い分けている。

**1. `expectTypeOf` による型の等価性検証**

```ts
// packages/zod/src/v4/classic/tests/generics.test.ts:11-13
test("generics", () => {
  const a = nest(z.object({ a: z.string() }));
  type a = z.infer<typeof a>;
  expectTypeOf<a>().toEqualTypeOf<{ nested: { a: string } }>();
```

推論された型が期待する型と厳密に一致することを検証する。`z.infer<typeof schema>` で型を取り出し、手書きの型と比較する。

**2. `satisfies` による型の互換性検証**

```ts
// packages/zod/src/v4/classic/tests/assignability.test.ts:7-8
test("assignability", () => {
  z.string() satisfies z.core.$ZodString;
  z.string() satisfies z.ZodString;
```

全スキーマ型が core 層と classic 層の両方のインターフェースを満たすことを網羅的に検証する。assignability.test.ts は純粋な型テストファイルで、ランタイムアサーションなしで TypeScript コンパイラによる型チェックのみが目的。

**3. `@ts-expect-error` による型エラーの意図的検証**

```ts
// packages/zod/src/v4/classic/tests/object.test.ts:459-460
// @ts-expect-error
schema.safeExtend({ name: z.number() });
```

「この操作は型エラーになるべき」という否定的制約を検証する。`@ts-expect-error` の下の行がコンパイルエラーにならなかった場合、tsc typecheck がその `@ts-expect-error` 自体を不要なディレクティブとして報告し、テストが失敗する。

### インラインスナップショット戦略

エラー構造体の検証に `toMatchInlineSnapshot` を集中的に使用する。外部スナップショットファイル（`.snap`）は使わない方針。

```ts
// packages/zod/src/v4/classic/tests/error.test.ts:50-59
expect(result.error).toMatchInlineSnapshot(`
  [ZodError: [
    {
      "expected": "string",
      "code": "invalid_type",
      "path": [],
      "message": "bad type!"
    }
  ]]
`);
```

同一パターンが `validations.test.ts`, `continuability.test.ts`, `transform.test.ts` など多数のファイルで統一されている。この手法により、エラーメッセージの変更は必ず diff としてレビューされる。

### console 出力の禁止メカニズム

```ts
// scripts/fail-on-console.ts:5-8
function thrower(method: string) {
  return (...args: any[]) => {
    throw new Error(`Unexpected console.${method} call: ${args.join(" ")}`);
  };
}
```

`beforeAll` で全 console メソッドを throw 関数に置き換え、`afterAll` で復元する。setupFiles として全テストに自動適用されるため、新規テストでも console 禁止が強制される。AGENTS.md にも "No log statements (`console.log`, `debugger`) in tests or production code" と明記。

### テスト分離と並行性

`vitest.config.ts` で `isolate: true` を設定し、各テストファイルが独立した環境で実行される。`watch: false` はデフォルトで CI モードを示す。パッケージ単位で `projects: ["packages/*"]` を指定し、ワークスペース内の全パッケージのテストを一括管理する。

### 多層テスト構成

テストは 4 つの層で構成される。

1. **ユニットテスト** (`packages/zod/src/v4/classic/tests/`, `v4/mini/tests/`): 各スキーマ型ごとの振る舞い・型検証
2. **解像度テスト** (`packages/resolution/`): CJS/ESM/bundler の全モジュール解決パスを `@arethetypeswrong/cli` で検証
3. **統合テスト** (`packages/integration/`): AI SDK, Drizzle ORM 等の実エコシステムとの型互換性を `tsc --project` で検証
4. **TypeScript コンパイラベンチマーク** (`packages/tsc/`): 型推論のパフォーマンスを `extendedDiagnostics` で測定

```json
// .github/workflows/test.yml:29-32
- run: pnpm build
- run: pnpm test
- run: pnpm run --filter @zod/resolution test:all
- run: pnpm run --filter @zod/integration test:all
```

CI では build 後に全テストを実行し、さらに resolution と integration テストを個別実行する。

### TypeScript バージョンマトリクス

```yaml
# .github/workflows/test.yml:19
typescript: ["5.5", "latest"]
```

最低サポートバージョン（5.5）と最新版の両方でテストを実行し、TypeScript の破壊的変更を早期検知する。

### Git フックによるテスト強制

```bash
# .husky/pre-push:4-7
pnpm check:semver
pnpm test
```

pre-push で全テスト実行を強制。pre-commit では lint-staged による段階的チェックにとどめ、push 前に完全なテストスイートを実行するという段階的ゲート戦略。

## パターンカタログ

- **Dual Assertion Pattern** (振る舞い)
  - 解決する問題: 型推論の正しさとランタイムの振る舞いが乖離するリスク
  - 適用条件: TypeScript の型推論結果がユーザー向け API の一部となるライブラリ
  - コード例: `packages/zod/src/v4/classic/tests/brand.test.ts:4-51`
  - 注意点: `expectTypeOf` はランタイムに影響しないため、ランタイムアサーションを省略しないこと

## Good Patterns

- **成功と失敗を対にするテスト構造**: 全テストファイルで `schema.parse(validInput)` と `expect(() => schema.parse(invalidInput)).toThrow()` が対になっている。どちらか片方だけでは、バリデーションが常に true/false を返すバグを検出できない

```ts
// packages/zod/src/v4/mini/tests/string.test.ts:6-10
test("z.string", async () => {
  const a = z.string();
  expect(z.parse(a, "hello")).toEqual("hello");
  expect(() => z.parse(a, 123)).toThrow();
  expect(() => z.parse(a, false)).toThrow();
```

- **`toMatchObject(FAIL)` による簡潔な失敗検証**: mini テストで `const FAIL = { success: false }` を定義し、`safeParse` 結果の失敗を簡潔に検証する

```ts
// packages/zod/src/v4/mini/tests/string.test.ts:4,61
const FAIL = { success: false };
// ...
expect(z.safeParse(b, "550e8400-e29b-61d4-a716-446655440000")).toMatchObject(FAIL);
```

- **型の「同型」テストによるリファクタリング安全性**: 手書きの interface と `z.infer<typeof schema>` を `expectTypeOf<...>().toEqualTypeOf<...>()` で比較し、スキーマ変更が型推論に影響しないことを保証する

```ts
// packages/zod/src/v4/classic/tests/recursive-types.test.ts:31-37
type Category = z.infer<typeof Category>;
interface _Category {
  name: string;
  subcategories?: _Category[] | undefined | null;
}
expectTypeOf<Category>().toEqualTypeOf<_Category>();
```

## Anti-Patterns / 注意点

- **型問題をテストスキップで回避する**: AGENTS.md が明示的に "Don't skip tests due to type issues - fix the types instead" と禁止。`@ts-ignore` ではなく `@ts-expect-error` を使い、型エラーをスキップではなく意図的に文書化する

```ts
// Bad: 型エラーを無視してテストをスキップ
// @ts-ignore
test.skip("broken type inference", () => { ... });

// Better: 型自体を修正するか、@ts-expect-error で意図を明示
// @ts-expect-error -- safeExtend は型の再代入を禁止している
schema.safeExtend({ name: z.number() });
```

- **外部スナップショットファイルによるエラー構造検証**: Zod はインラインスナップショットのみを使用し、`.snap` ファイルは存在しない。外部スナップショットはコードレビュー時に期待値の確認が困難で、無意識な更新（`--update`）で回帰を見逃すリスクがある

```ts
// Bad: 外部スナップショット（レビュー時に別ファイルを開く必要がある）
expect(result.error).toMatchSnapshot();

// Better: インラインスナップショット（期待値がテストコードに直接記載される）
expect(result.error).toMatchInlineSnapshot(`
  [ZodError: [{ "code": "invalid_type", ... }]]
`);
```

## 導出ルール

- `[MUST]` 型推論がユーザー API に含まれるライブラリでは、ランタイムテストと型テストを同一ファイルで実行する
  - 根拠: Zod 全テストファイルで `expect` と `expectTypeOf` が共存し、型とランタイムの乖離を構造的に防止している（`vitest.config.ts:26` で `typecheck.enabled: true`）
- `[MUST]` テストにおいて成功ケースと失敗ケースを必ず対で記述する
  - 根拠: AGENTS.md に "Test both success and failure cases with edge cases" と明記され、全テストファイルで `.parse(valid)` と `expect(() => .parse(invalid)).toThrow()` が対になっている
- `[SHOULD]` エラーオブジェクトやシリアライズ結果の検証にはインラインスナップショットを使い、外部 `.snap` ファイルを避ける
  - 根拠: Zod は全テストで `toMatchInlineSnapshot` を使用し外部スナップショットファイルが存在しない。レビュー時の視認性と意図しない更新の防止を優先している
- `[SHOULD]` テストコードからの console 出力を setupFiles で自動禁止する
  - 根拠: `scripts/fail-on-console.ts` が setupFiles として全テストに適用され、残留デバッグログを構造的に排除している
- `[SHOULD]` TypeScript ライブラリでは最低サポートバージョンと最新版の両方で CI テストを実行する
  - 根拠: CI マトリクスで `typescript: ["5.5", "latest"]` を指定し、コンパイラの破壊的変更を早期検知している（`.github/workflows/test.yml:19`）
- `[SHOULD]` テスト用 tsconfig でテスト記述に不要な制約（`noUnusedLocals` 等）を緩和し、本番用 tsconfig の厳格さを維持する
  - 根拠: `tsconfig.test.json` で `noUnusedLocals: false` を設定し、型テスト用の変数宣言を許容しつつ本番コードの厳格性を保っている
- `[AVOID]` 型エラーを `@ts-ignore` やテストスキップで回避する（型を修正するか `@ts-expect-error` で意図を文書化する）
  - 根拠: AGENTS.md に "Don't skip tests due to type issues - fix the types instead" と明記

## 適用チェックリスト

- [ ] `vitest.config.ts` で `typecheck.enabled: true` と `checker: "tsc"` を設定し、テストファイルの型チェックを CI で強制する
- [ ] テスト専用の `tsconfig.test.json` を用意し、`noUnusedLocals: false` 等テスト記述に必要な緩和を適用する
- [ ] `setupFiles` で console メソッドを throw に置き換えるスクリプトを全テストに適用する
- [ ] 型推論を検証すべき箇所で `expectTypeOf<T>().toEqualTypeOf<U>()` をランタイムアサーションと同一テスト内に記述する
- [ ] エラーオブジェクトの回帰検知に `toMatchInlineSnapshot` を使い、外部スナップショットファイルを作成しない
- [ ] 全バリデーションテストで有効入力（成功）と無効入力（失敗）の両方を含める
- [ ] TypeScript ライブラリの場合、CI で最低サポートバージョンと latest の両方でテストを実行する
- [ ] pre-push フックでテストスイート全体を実行し、壊れたコードの push を防止する
