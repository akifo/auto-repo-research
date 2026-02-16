# extensibility-mechanisms

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

valibot は「スキーマ・アクション・メソッドがすべて `'~run'` メソッドを持つプレーンオブジェクト」という統一プロトコルに基づき、ユーザーが `custom()` / `check()` / `transform()` / `rawCheck()` / `rawTransform()` などの拡張ポイントを通じて任意のバリデーション・変換ロジックを注入できる設計を採用している。クラス継承やプラグインレジストリを一切使わず、関数が「プロトコル準拠のオブジェクトリテラル」を返すだけで拡張が完結する点が注目に値する。この設計はツリーシェイキングとの親和性が極めて高く、バンドルサイズの最小化と拡張性を両立させている。

## 背景にある原則

- **プロトコルによる多態性（Protocol-based Polymorphism）**: クラス継承ではなく、共通のプロパティ構造（`kind`, `type`, `reference`, `'~run'`）を持つオブジェクトリテラルで多態性を実現すべき。これにより任意の関数がプロトコル準拠オブジェクトを返すだけで拡張ポイントになる。根拠: `BaseSchema`, `BaseValidation`, `BaseTransformation`, `BaseMetadata` の全てが `interface` で定義され、実装はオブジェクトリテラルを返すファクトリ関数（`library/src/schemas/string/string.ts:70-94`, `library/src/actions/check/check.ts:62-81`）。

- **段階的な抽象度の拡張ポイント提供（Escalating Escape Hatches）**: 単純なユースケースには制約の強いAPIを、複雑なユースケースには低レベルAPIを提供すべき。これにより大多数のユーザーは安全な高レベルAPIで完結し、必要な場合のみ低レベルに降りられる。根拠: `check()` → `rawCheck()` → `rawTransform()` と段階的に抽象度が下がる設計（`library/src/actions/check/check.ts`, `library/src/actions/rawCheck/rawCheck.ts`, `library/src/actions/rawTransform/rawTransform.ts`）。

- **合成による拡張（Composition over Configuration）**: プラグインシステムやコンフィグオブジェクトではなく、`pipe()` による関数合成で機能を組み合わせるべき。各要素が独立して完結し、合成順序で振る舞いが決まる。根拠: `pipe()` の実装が `for...of` で各アイテムの `'~run'` を順次実行する（`library/src/methods/pipe/pipe.ts:2694-2732`）。

- **型レベルと値レベルの拡張の分離**: 型レベルの拡張（`brand` / `flavor` による名目型付け）と値レベルの拡張（`transform` / `check` による実行時処理）を明確に分離すべき。根拠: `brand()` / `flavor()` は `'~run'` でデータセットをそのまま返し、型シグネチャのみを変更する（`library/src/actions/brand/brand.ts:56-58`, `library/src/actions/flavor/flavor.ts:66-68`）。

## 実例と分析

### 統一プロトコル: kind ディスクリミネータによる分類

valibot のすべてのパイプアイテムは `kind` プロパティで分類される。この4種のディスクリミネータが拡張のカテゴリを定義する。

```typescript
// library/src/types/pipe.ts:32-34
export type PipeItem<TInput, TOutput, TIssue extends BaseIssue<unknown>> =
  | BaseSchema<TInput, TOutput, TIssue>
  | PipeAction<TInput, TOutput, TIssue>;
```

`PipeAction` はさらに3種に分岐する:

```typescript
// library/src/types/pipe.ts:13-16
export type PipeAction<TInput, TOutput, TIssue extends BaseIssue<unknown>> =
  | BaseValidation<TInput, TOutput, TIssue>
  | BaseTransformation<TInput, TOutput, TIssue>
  | BaseMetadata<TInput>;
```

`pipe()` 実装内で `kind` に基づく分岐制御が行われる:

```typescript
// library/src/methods/pipe/pipe.ts:2703-2714
if (item.kind !== "metadata") {
  if (
    dataset.issues
    && (item.kind === "schema" || item.kind === "transformation")
  ) {
    dataset.typed = false;
    break;
  }
  // ...
}
```

`metadata` はスキップ、`schema` / `transformation` はエラー時に中断、`validation` はエラー時も（`abortEarly` でない限り）継続する。このディスクリミネータベースの制御により、新しいアクションを追加しても `pipe()` の実装変更が不要になる。

### 段階的な拡張ポイント

**Level 1: `check()` -- 型安全な制約追加**

最も制約が強く安全。入力値のみ受け取り、`boolean` を返す。

```typescript
// library/src/actions/check/check.ts:62-81
export function check(
  requirement: (input: unknown) => boolean,
  message?: ErrorMessage<CheckIssue<unknown>>,
): CheckAction<unknown, ErrorMessage<CheckIssue<unknown>> | undefined> {
  return {
    kind: "validation",
    type: "check",
    reference: check,
    async: false,
    expects: null,
    requirement,
    message,
    "~run"(dataset, config) {
      if (dataset.typed && !this.requirement(dataset.value)) {
        _addIssue(this, "input", dataset, config);
      }
      return dataset;
    },
  };
}
```

**Level 2: `rawCheck()` -- dataset と config へのアクセス**

`addIssue` 関数を通じてカスタムパス・ラベル・メッセージを設定できる。

```typescript
// library/src/actions/rawCheck/rawCheck.ts:32-51
export function rawCheck<TInput>(
  action: (context: RawCheckContext<TInput>) => void,
): RawCheckAction<TInput> {
  return {
    kind: "validation",
    type: "raw_check",
    reference: rawCheck,
    async: false,
    expects: null,
    "~run"(dataset, config) {
      action({
        dataset,
        config,
        addIssue: (info) => _addIssue(this, info?.label ?? "input", dataset, config, info),
      });
      return dataset;
    },
  };
}
```

**Level 3: `rawTransform()` -- 値の変換 + エラー報告**

変換と検証を同時に行う最も低レベルな拡張ポイント。戻り値が新しいデータセット値になる。

```typescript
// library/src/actions/rawTransform/rawTransform.ts:32-67
export function rawTransform<TInput, TOutput>(
  action: (context: RawTransformContext<TInput>) => TOutput,
): RawTransformAction<TInput, TOutput> {
  return {
    kind: "transformation",
    type: "raw_transform",
    reference: rawTransform,
    async: false,
    "~run"(dataset, config) {
      const output = action({
        dataset,
        config,
        addIssue: (info) => _addIssue(this, info?.label ?? "input", dataset, config, info),
        NEVER: null as never,
      });
      if (dataset.issues) {
        dataset.typed = false;
      } else {
        dataset.value = output;
      }
      return dataset;
    },
  };
}
```

### custom() スキーマ: ユーザー定義型の注入

`custom()` は「組み込みスキーマと同じプロトコルに準拠するオブジェクト」を返すファクトリ関数で、ユーザーが任意の型ガードをスキーマとして使える。

```typescript
// library/src/schemas/custom/custom.ts:68-94
export function custom<TInput>(
  check: Check,
  message?: ErrorMessage<CustomIssue>,
): CustomSchema<TInput, ErrorMessage<CustomIssue> | undefined> {
  return {
    kind: "schema",
    type: "custom",
    reference: custom,
    expects: "unknown",
    async: false,
    check,
    message,
    get "~standard"() {
      return _getStandardProps(this);
    },
    "~run"(dataset, config) {
      if (this.check(dataset.value)) {
        dataset.typed = true;
      } else {
        _addIssue(this, "type", dataset, config);
      }
      return dataset as OutputDataset<TInput, CustomIssue>;
    },
  };
}
```

### メッセージシステムの多層カスタマイズ

エラーメッセージは4層の優先度で解決される。この設計により、ユーザーはスコープに応じたカスタマイズが可能。

```typescript
// library/src/utils/_addIssue/_addIssue.ts:106-112
const message = other?.message
  ?? context.message
  ?? getSpecificMessage(context.reference, issue.lang)
  ?? (isSchema ? getSchemaMessage(issue.lang) : null)
  ?? config.message
  ?? getGlobalMessage(issue.lang);
```

1. アクション個別メッセージ（`context.message`）
2. `setSpecificMessage()` による参照ベースのメッセージ
3. `setSchemaMessage()` / `config.message` によるスコープメッセージ
4. `setGlobalMessage()` によるグローバルフォールバック

`reference` プロパティ（関数への参照そのもの）をキーとして `Map` で管理するため、文字列ベースの名前衝突が発生しない。

```typescript
// library/src/storages/specificMessage/specificMessage.ts:40-48
export function setSpecificMessage<const TReference extends Reference>(
  reference: TReference,
  message: ErrorMessage<InferIssue<ReturnType<TReference>>>,
  lang?: string,
): void {
  if (!store) store = new Map();
  if (!store.get(reference)) store.set(reference, new Map());
  store.get(reference)!.set(lang, message);
}
```

### brand / flavor: 型レベルのみの拡張

`brand()` と `flavor()` は実行時には何もせず、TypeScript の型システムだけで名目的型付け（nominal typing）を実現する。`brand` は完全な名目型（`[BrandSymbol]` は必須プロパティ）、`flavor` は構造的互換性を残す名目型（`[FlavorSymbol]?` はオプショナル）。

```typescript
// library/src/actions/brand/brand.ts:16-18
export interface Brand<TName extends BrandName> {
  [BrandSymbol]: { [TValue in TName]: TValue; };
}

// library/src/actions/flavor/flavor.ts:22-24
export interface Flavor<TName extends FlavorName> {
  [FlavorSymbol]?: { [TValue in TName]: TValue; };
}
```

### lazy() によるスキーマの遅延評価

再帰的なデータ構造を扱うために、`lazy()` はスキーマの生成を入力値に基づいて遅延させる。`getter` に入力値が渡されるため、値に応じて異なるスキーマを返す条件分岐も可能。

```typescript
// library/src/schemas/lazy/lazy.ts:48-63
export function lazy<
  const TWrapped extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(getter: (input: unknown) => TWrapped): LazySchema<TWrapped> {
  return {
    kind: "schema",
    type: "lazy",
    reference: lazy,
    expects: "unknown",
    async: false,
    getter,
    get "~standard"() {
      return _getStandardProps(this);
    },
    "~run"(dataset, config) {
      return this.getter(dataset.value)["~run"](dataset, config);
    },
  };
}
```

### forward() / config(): メソッドによる振る舞いの合成

`forward()` はアクションの `'~run'` をラップしてイシューのパスを書き換え、`config()` はスキーマの `'~run'` をラップして設定を上書きする。どちらも元のオブジェクトをスプレッドし `'~run'` だけを差し替えるデコレータパターン。

```typescript
// library/src/methods/config/config.ts:19-33
export function config<...>(schema: TSchema, config: Config<...>): TSchema {
  return {
    ...schema,
    get '~standard'() { return _getStandardProps(this); },
    '~run'(dataset, config_) {
      return schema['~run'](dataset, { ...config_, ...config });
    },
  };
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: バリデーション/変換のアルゴリズムを実行時に差し替える
  - 適用条件: `check()`, `transform()`, `custom()` など、ユーザー関数を受け取るすべてのファクトリ
  - コード例: `library/src/actions/check/check.ts:62-81` の `requirement` パラメータ
  - 注意点: Strategy がオブジェクトリテラルのプロパティとして埋め込まれるため、従来の Strategy パターンよりも軽量

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 複数のバリデーション/変換を順序通りに適用し、条件に応じて中断する
  - 適用条件: `pipe()` によるパイプライン実行
  - コード例: `library/src/methods/pipe/pipe.ts:2701-2730`
  - 注意点: `kind` に基づく中断条件（`schema`/`transformation` はエラー時に中断、`validation` は継続可能）がチェーンの振る舞いを制御する

- **Decorator パターン** (分類: 構造)
  - 解決する問題: 既存のスキーマ/アクションに追加の振る舞い（パス転送、設定上書き）を付与する
  - 適用条件: `forward()`, `config()` メソッド
  - コード例: `library/src/methods/forward/forward.ts:24-87`, `library/src/methods/config/config.ts:19-33`
  - 注意点: スプレッド + `'~run'` 差し替えで実現するため、クラスベースのデコレータより軽量だが、ラップの深さに注意

## Good Patterns

- **ファクトリ関数 + `@__NO_SIDE_EFFECTS__` による Tree-Shakeable な拡張**: すべてのスキーマ・アクション・メソッドが `// @__NO_SIDE_EFFECTS__` アノテーション付きのファクトリ関数として実装されており、使用しないものはバンドルから完全に除外される。クラスベースでは達成困難なレベルのツリーシェイキングが実現されている。

```typescript
// library/src/actions/transform/transform.ts:29-46
// @__NO_SIDE_EFFECTS__
export function transform<TInput, TOutput>(
  operation: (input: TInput) => TOutput,
): TransformAction<TInput, TOutput> {
  return {
    kind: "transformation",
    type: "transform",
    reference: transform,
    async: false,
    operation,
    "~run"(dataset) {
      dataset.value = this.operation(dataset.value);
      return dataset as SuccessDataset<TOutput>;
    },
  };
}
```

- **`reference` プロパティによる型安全な識別**: 各アクション/スキーマが自身のファクトリ関数への参照を `reference` プロパティとして保持する。これにより文字列ベースの識別子なしに型安全なディスパッチ（メッセージストア、JSON Schema 変換）が可能になる。

```typescript
// library/src/actions/email/email.ts:97-112
return {
  kind: "validation",
  type: "email",
  reference: email, // ← 関数自身への参照
  // ...
};

// library/src/storages/specificMessage/specificMessage.ts:40-48
// reference を Map のキーとして使用
export function setSpecificMessage<const TReference extends Reference>(
  reference: TReference,
  message: ErrorMessage<InferIssue<ReturnType<TReference>>>,
  lang?: string,
): void {/* ... */}
```

- **`'~'` プレフィックスによる内部API境界の明示**: `'~run'`, `'~standard'`, `'~types'` のようにチルダプレフィックスを用いて内部メソッドを表現する。TypeScript の private/protected ではなく命名規約でアクセス制御し、型レベルでは依然としてアクセス可能にすることで、フレームワーク内部の型推論を壊さずにユーザーへ「触らないで」のシグナルを送る。

```typescript
// library/src/types/schema.ts:53-56
readonly '~run': (
  dataset: UnknownDataset,
  config: Config<BaseIssue<unknown>>
) => OutputDataset<TOutput, TIssue>;
```

## Anti-Patterns / 注意点

- **raw 系APIの安易な使用**: `rawCheck()` / `rawTransform()` は dataset や config に直接アクセスできるが、内部構造への依存が増す。まず `check()` / `transform()` で実現可能かを検討すべき。

```typescript
// Bad: rawCheck で単純な検証を行う
rawCheck(({ dataset, addIssue }) => {
  if (dataset.typed && dataset.value < 0) {
    addIssue({ message: "Must be positive" });
  }
});

// Better: check で十分
check((input) => input >= 0, "Must be positive");
```

- **pipe 内での複数スキーマ混在**: `pipe()` 内にスキーマを複数配置すると、エラー時の中断制御が複雑になる。to-json-schema パッケージでは `typeMode` を `input` / `output` に設定しないと変換エラーになる。パイプの先頭は1つのスキーマとし、後続はアクションのみにするのが安全。

```typescript
// Bad: pipe 内に複数スキーマ
pipe(string(), number()); // 意図が不明確

// Better: transform で明示的に変換
pipe(string(), transform(Number));
```

## 導出ルール

- `[MUST]` 拡張可能なライブラリを設計する際、各拡張ポイントのオブジェクトに `kind` ディスクリミネータプロパティを持たせ、実行エンジンがカテゴリごとに振る舞いを制御できるようにする
  - 根拠: valibot の `pipe()` は `kind` の値（`schema` / `validation` / `transformation` / `metadata`）に基づいてエラー時の中断・継続・スキップを制御しており、新しいアクション追加時にパイプライン実装の変更が不要（`library/src/methods/pipe/pipe.ts:2703-2714`）

- `[MUST]` ユーザー向け拡張ポイントを複数の抽象度レベルで提供し、単純なケースほど制約の強いAPIを使わせる
  - 根拠: valibot は `check()` → `rawCheck()` → `rawTransform()` の3段階で抽象度を下げており、大多数のユースケースは `check()` で完結し、dataset への直接アクセスが必要な場合のみ `raw` 系に降りる設計（`library/src/actions/check/`, `library/src/actions/rawCheck/`, `library/src/actions/rawTransform/`）

- `[SHOULD]` プラグインや拡張を「プロトコル準拠のプレーンオブジェクトを返すファクトリ関数」として設計し、クラス継承を避ける（ツリーシェイキングとテスト容易性のため）
  - 根拠: valibot の全スキーマ・アクションが `// @__NO_SIDE_EFFECTS__` 付きファクトリ関数で実装され、使用しないコードが完全にバンドルから除外される（`library/src/schemas/string/string.ts:70`, `library/src/actions/email/email.ts:93`）

- `[SHOULD]` 拡張オブジェクトの識別にはファクトリ関数への参照（`reference` プロパティ）を使い、文字列ベースの名前空間やレジストリを避ける
  - 根拠: valibot の `setSpecificMessage()` は `reference` をキーとする `Map` でメッセージを管理し、文字列キーの衝突リスクを排除しつつ型推論を維持（`library/src/storages/specificMessage/specificMessage.ts:40-48`）

- `[SHOULD]` 型レベルのみの拡張（名目型付け等）は実行時コストゼロの変換として実装し、値の変換と明確に分離する
  - 根拠: `brand()` / `flavor()` は `'~run'` 内でデータセットを一切変更せず、TypeScript の型情報のみを変更する（`library/src/actions/brand/brand.ts:56-58`）

- `[AVOID]` 内部APIとパブリックAPIの境界をアクセス修飾子（private/protected）だけで管理すること。プレーンオブジェクトベースの設計では命名規約（プレフィックス等）で境界を示し、型レベルではアクセス可能に保つ
  - 根拠: valibot は `'~run'`, `'~standard'`, `'~types'` のチルダプレフィックスで内部メソッドを示しつつ、型推論には完全にアクセス可能にしている（`library/src/types/schema.ts:53-68`）

## 適用チェックリスト

- [ ] 拡張可能なオブジェクトに `kind` などのディスクリミネータプロパティを定義しているか
- [ ] ユーザー向け拡張APIが「簡単だが制約あり」から「柔軟だが責任あり」の段階的なレベルで提供されているか
- [ ] 拡張ポイントがクラスではなくファクトリ関数（プレーンオブジェクトを返す）で設計されているか
- [ ] ファクトリ関数に `@__NO_SIDE_EFFECTS__` や `/*#__PURE__*/` アノテーションを付与してツリーシェイキングを有効にしているか
- [ ] 拡張オブジェクトの識別に文字列キーではなく関数参照を使用しているか
- [ ] 型レベルのみの操作（ブランド型等）と値レベルの操作（変換等）が分離されているか
- [ ] パイプライン/チェーン実行において、ディスクリミネータに基づくエラー伝播制御が設計されているか
- [ ] 内部APIの境界が命名規約で明示されており、型推論を阻害していないか
