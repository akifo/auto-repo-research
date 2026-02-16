# 設計思想

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

valibot は「モジュラリティ」「ゼロ依存」「型安全」の三原則を極限まで追求したスキーマバリデーションライブラリである。すべてのスキーマ・アクション・メソッドが個別の関数として実装され、`sideEffects: false` + `@__NO_SIDE_EFFECTS__` アノテーションにより未使用コードが完全に除去される設計になっている。TypeScript の `interface` を `type` より優先し、`strict` + `exactOptionalPropertyTypes` + `isolatedDeclarations` を有効化するなど、型チェッカーのパフォーマンスとコードの安全性を両立させる技術選定が注目に値する。

## 背景にある原則

- **関数 = モジュールの最小単位**: ライブラリの公開 API をすべて独立した関数にすることで、バンドラの tree-shaking が関数単位で機能する。クラスやメソッドチェーンではなく「関数がプレーンオブジェクトを返す」パターンを一貫して採用している理由は、使われていない関数をバンドルから完全に除去するためである（`library/src/schemas/string/string.ts:69-94`, `library/src/actions/email/email.ts:93-112`）。

- **プロトコル準拠による疎結合**: すべての構成要素が `kind` / `type` / `reference` / `async` / `'~run'` を持つ共通プロトコルに準拠している。このプロトコルにより、スキーマ・バリデーション・トランスフォーメーション・メタデータが同一のパイプラインで組み合わせ可能になる（`library/src/types/schema.ts`, `library/src/types/validation.ts`, `library/src/types/transformation.ts`）。

- **型情報の明示的な分離**: ランタイムには存在しないが型推論に必要な情報を `'~types'` プロパティ（optional かつ undefined 許容）に隔離している。チルダプレフィックス `~` はプライベート慣習であり、ユーザーが誤ってアクセスすることを抑止しつつ、TypeScript の `InferInput` / `InferOutput` / `InferIssue` ユーティリティ型から参照できる設計である（`library/src/types/infer.ts:14-51`）。

- **パフォーマンスのためにスプレッド演算子を意図的に回避する**: `_addIssue` や `getGlobalConfig` のコード内コメントで「The issue is deliberately not constructed with the spread operator for performance reasons」と明記されている（`library/src/utils/_addIssue/_addIssue.ts:83-84`, `library/src/storages/globalConfig/globalConfig.ts:31-32`）。オブジェクトの構築においてスプレッドよりも手動プロパティ代入を選択し、ホットパスの GC 負荷を低減している。

## 実例と分析

### ファクトリ関数 + プレーンオブジェクト パターン

valibot のすべての公開 API は「ファクトリ関数がプレーンオブジェクトを返す」形式で統一されている。クラスを使わない理由は tree-shaking の確実性にある。クラスのメソッドはプロトタイプチェーンに属するため、バンドラが安全に除去できないケースがある。

```typescript
// library/src/schemas/string/string.ts:69-94
// @__NO_SIDE_EFFECTS__
export function string(
  message?: ErrorMessage<StringIssue>,
): StringSchema<ErrorMessage<StringIssue> | undefined> {
  return {
    kind: "schema",
    type: "string",
    reference: string,
    expects: "string",
    async: false,
    message,
    get "~standard"() {
      return _getStandardProps(this);
    },
    "~run"(dataset, config) {
      if (typeof dataset.value === "string") {
        // @ts-expect-error
        dataset.typed = true;
      } else {
        _addIssue(this, "type", dataset, config);
      }
      // @ts-expect-error
      return dataset as OutputDataset<string, StringIssue>;
    },
  };
}
```

`reference: string` は関数自身への参照を保持しており、イントロスペクション（シリアライズ・比較・デバッグ）を可能にしている。

### @**NO_SIDE_EFFECTS** による tree-shaking 保証

ライブラリ全体で 200 以上のファクトリ関数に `// @__NO_SIDE_EFFECTS__` コメントが付与されている。package.json の `"sideEffects": false` と組み合わせることで、バンドラ（Rollup, esbuild, webpack）が未使用の関数を確実に除去できる。

```typescript
// library/src/actions/minLength/minLength.ts:101-102
// @__NO_SIDE_EFFECTS__
export function minLength(
  requirement: number,
  message?: ErrorMessage<MinLengthIssue<LengthInput, number>>
): MinLengthAction<...> {
```

### 判別プロパティによるオブジェクト分類

`kind` と `type` の2段階の判別プロパティにより、ランタイムでの型絞り込みとTypeScript の型ナローイングを両立している。

```typescript
// library/src/utils/isOfKind/isOfKind.ts:10-15
// @__NO_SIDE_EFFECTS__
export function isOfKind<
  const TKind extends TObject["kind"],
  const TObject extends { kind: string; },
>(kind: TKind, object: TObject): object is Extract<TObject, { kind: TKind; }> {
  return object.kind === kind;
}
```

`kind` は大分類（`'schema'` / `'validation'` / `'transformation'` / `'metadata'`）、`type` は小分類（`'string'` / `'email'` / `'min_length'` 等）という階層構造。`isOfKind` と `isOfType` の2つのジェネリック型ガードで、パイプライン処理内での分岐が型安全に行える。

### Dataset パターンによるミュータブル処理

パイプライン内部では `dataset` オブジェクトをミュータブルに書き換えてパフォーマンスを稼いでいる。外部 API（`parse`, `safeParse`）は不変だが、内部の `'~run'` メソッド間では同一オブジェクトを使い回す。

```typescript
// library/src/methods/pipe/pipe.ts:2694-2732
// @__NO_SIDE_EFFECTS__
export function pipe<...>(
  ...pipe: [TSchema, ...TItems]
): SchemaWithPipe<readonly [TSchema, ...TItems]> {
  return {
    ...pipe[0],
    pipe,
    '~run'(dataset, config) {
      for (const item of pipe) {
        if (item.kind !== 'metadata') {
          if (dataset.issues && (item.kind === 'schema' || item.kind === 'transformation')) {
            dataset.typed = false;
            break;
          }
          if (!dataset.issues || (!config.abortEarly && !config.abortPipeEarly)) {
            // @ts-expect-error
            dataset = item['~run'](dataset, config);
          }
        }
      }
      // @ts-expect-error
      return dataset as OutputDataset<unknown, BaseIssue<unknown>>;
    },
  };
}
```

### TypeScript 設定による型安全の最大化

```json
// library/tsconfig.json
{
  "compilerOptions": {
    "exactOptionalPropertyTypes": true,
    "isolatedDeclarations": true,
    "strict": true,
    "allowImportingTsExtensions": true
  }
}
```

- `exactOptionalPropertyTypes`: `undefined` を明示的に代入することと、プロパティが存在しないことを区別する。valibot の `exactOptional` スキーマはこの TS 機能に対応するために存在する。
- `isolatedDeclarations`: 各ファイルが他のファイルの型推論なしに宣言ファイルを生成できることを保証する。これにより並列ビルドが可能になる。
- `allowImportingTsExtensions`: `.ts` 拡張子での import を許可し、Deno 互換性を確保する。

### 内部ユーティリティのアンダースコアプレフィックス

```typescript
// library/src/utils/index.ts:1-10
export * from "./_addIssue/index.ts";
export * from "./_getByteCount/index.ts";
export * from "./_getGraphemeCount/index.ts";
export * from "./_getLastMetadata/index.ts";
export * from "./_getStandardProps/index.ts";
// ...
export * from "./entriesFromList/index.ts";
export * from "./isOfKind/index.ts";
```

アンダースコアプレフィックス `_` で内部専用ユーティリティを視覚的に区別している。`export *` で re-export されるため JavaScript の private ではないが、「`@internal` JSDoc + アンダースコアプレフィックス」の二重慣習により、ユーザーが誤用する可能性を下げている。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: スキーマごとにバリデーションロジックが異なるが、統一的なインターフェースで実行したい
  - 適用条件: 共通プロトコル（`'~run'` メソッド）を持つ複数のオブジェクトをパイプラインで逐次実行する
  - コード例: `library/src/methods/pipe/pipe.ts:2701-2729`（for ループで各 item の `'~run'` を順に呼ぶ）
  - 注意点: GoF の Strategy はクラスベースだが、valibot ではプレーンオブジェクト + ファクトリ関数で実現している

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: バリデーション → トランスフォーメーション → さらなるバリデーションという処理チェーンを柔軟に構成したい
  - 適用条件: `pipe()` 関数で任意のアイテムを連結し、`abortEarly` / `abortPipeEarly` で中断条件を制御する
  - コード例: `library/src/methods/pipe/pipe.ts:2706-2723`
  - 注意点: 標準的な Chain of Responsibility は次のハンドラへの参照を持つが、valibot では配列イテレーションで実装している

## Good Patterns

- **オーバーロードシグネチャによる段階的な型推論**: `pipe()` 関数は引数1個から19個まで個別のオーバーロードシグネチャを持ち、各段階で前のアイテムの出力型が次のアイテムの入力型として推論される。variadic generics ではなく手動オーバーロードを選択した理由は、TypeScript の型推論がオーバーロードの方がより正確に動作するためである（`library/src/methods/pipe/pipe.ts:80-2682`）。

- **`~` プレフィックスによる内部プロパティの名前空間分離**: `'~run'`, `'~standard'`, `'~types'` のように、チルダプレフィックスで内部プロパティをユーザー空間と分離している。Symbol を使わない理由は、JSON シリアライゼーションとデバッグの容易さを維持するためと推測される。

- **Dataset の3状態設計（Success / Partial / Failure）**: バリデーション結果を `typed: true + issues なし`（Success）、`typed: true + issues あり`（Partial）、`typed: false`（Failure）の3状態で表現する。Partial 状態の存在により、型は正しいが制約違反があるケースを失型と区別でき、パイプラインの続行判断が正確になる（`library/src/types/dataset.ts:1-81`）。

## Anti-Patterns / 注意点

- **@ts-expect-error の多用**: 内部実装では `@ts-expect-error` が頻繁に使われている（`library/src/schemas/object/object.ts` だけで8箇所）。これは外部 API の型安全性を維持しつつ、内部のパフォーマンス最適化（ミュータブル操作、型の再割り当て）を可能にするためのトレードオフである。

```typescript
// Bad: 内部実装のパフォーマンス最適化のために @ts-expect-error を乱用する
// @ts-expect-error
dataset.typed = true;
// @ts-expect-error
dataset.value = {};

// Better: 内部専用の widened 型を定義して @ts-expect-error を減らす
interface MutableDataset {
  typed: boolean;
  value: unknown;
  issues?: BaseIssue<unknown>[];
}
```

ただし valibot ではこのトレードオフを意図的に選択しており、ホットパスでの型キャスト関数呼び出しを避けるために `@ts-expect-error` を使っている。公開 API の型安全性は完全に保たれている点が重要である。

- **オーバーロード爆発**: `pipe()` 関数は19個のオーバーロードを手動で定義しており、ファイルが2700行を超えている。これは TypeScript の variadic generics の制約を回避するための妥協だが、メンテナンスコストは高い。同様のパターンを自プロジェクトに適用する場合は、現実的な上限（5-7個程度）で十分か検討すべきである。

## 導出ルール

- `[MUST]` tree-shaking を保証するライブラリでは、`sideEffects: false` と `// @__NO_SIDE_EFFECTS__` アノテーションを併用する
  - 根拠: valibot は全ファクトリ関数（200以上）に `@__NO_SIDE_EFFECTS__` を付与し、package.json で `"sideEffects": false` を宣言している。どちらか一方だけではバンドラによって挙動が異なる（`library/package.json:37`, 全 schema/action/method ファイル）

- `[MUST]` ライブラリの公開型定義にはオブジェクト形状に `interface` を使い、ユニオン型やマップ型には `type` を使い分ける
  - 根拠: AGENTS.md で「`interface` over `type` for object shapes」と明記。interface は TypeScript コンパイラの内部キャッシュが効きやすく、大規模な型定義での型チェックパフォーマンスが向上する（`library/src/types/schema.ts` の `BaseSchema` は interface、`OutputDataset` はユニオンなので type）

- `[SHOULD]` tree-shakeable なライブラリでは、クラスではなくファクトリ関数 + プレーンオブジェクトで API を構成する
  - 根拠: クラスのメソッドはプロトタイプチェーンに属し、バンドラが安全に除去できないケースがある。valibot は全構成要素をファクトリ関数で生成し、メソッドチェーンを排除している（`library/src/schemas/string/string.ts:69-94`）

- `[SHOULD]` プレーンオブジェクトの共通プロトコルには判別プロパティ（discriminant）を2階層以上持たせ、型ガード関数を提供する
  - 根拠: valibot は `kind`（大分類: schema/validation/transformation/metadata）と `type`（小分類: string/email 等）の2段階判別プロパティで、`isOfKind` / `isOfType` 型ガードを提供している（`library/src/utils/isOfKind/isOfKind.ts`, `library/src/utils/isOfType/isOfType.ts`）

- `[SHOULD]` ホットパスではスプレッド演算子よりも手動プロパティ代入を選択する
  - 根拠: `_addIssue` と `getGlobalConfig` で「deliberately not constructed with the spread operator for performance reasons」とコメントされている（`library/src/utils/_addIssue/_addIssue.ts:83-84`）

- `[SHOULD]` ランタイムに不要な型情報は optional プロパティに隔離し、`InferX<T>` 型で間接参照する
  - 根拠: valibot の `'~types'` プロパティはランタイムでは undefined だが、`InferInput` / `InferOutput` / `InferIssue` が `NonNullable<T['~types']>` でアクセスする設計により、バンドルサイズに影響を与えずに型推論を実現している（`library/src/types/infer.ts:14-51`）

- `[AVOID]` バンドルサイズが重要なライブラリでランタイム依存を追加する
  - 根拠: valibot は devDependencies のみで runtime dependencies がゼロ。正規表現すら自前で定義し（`library/src/regex.ts`）、外部パッケージへの依存を完全に排除している（`library/package.json`）

## 適用チェックリスト

- [ ] package.json に `"sideEffects": false` が設定されているか
- [ ] ファクトリ関数に `// @__NO_SIDE_EFFECTS__` アノテーションが付与されているか
- [ ] オブジェクト形状の型定義に `interface` を使用し、ユニオン/マップ型に `type` を使い分けているか
- [ ] tsconfig.json で `strict: true` + `exactOptionalPropertyTypes: true` が有効か
- [ ] 公開 API の構成要素が共通プロトコル（判別プロパティ + `run` メソッド等）に準拠しているか
- [ ] ホットパス（バリデーションループ等）でスプレッド演算子を避けているか
- [ ] ランタイム依存パッケージが本当に必要か再検討したか（自前実装で代替可能か）
- [ ] 型推論専用の情報がランタイムのバンドルサイズに影響していないか
- [ ] 内部ユーティリティが命名規約（アンダースコアプレフィックス等）で公開 API と区別されているか
