# Error Handling Idioms

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

バリデーションライブラリにおけるエラーの構造化・伝搬・フラット化パターンを分析する。valibot は issue（バリデーション問題）を木構造で蓄積し、path 情報で位置を特定し、最終的にフラットな形式へ変換する一貫した設計を持つ。特に注目に値するのは、throw と result object の二重 API、issue の kind 分類による制御フロー分岐、そしてエラーメッセージの4段階フォールバック機構である。

## 背景にある原則

- **エラー収集の継続性**: バリデーションでは「最初のエラーで止める」のではなく「全てのエラーを収集する」のがデフォルトであるべき。なぜなら、ユーザーは一度のフォーム送信で全ての問題を把握したいからである。`abortEarly` はオプトインで提供される（`library/src/types/config.ts:19`）
- **エラー表現の分離**: 内部表現（issue 木構造）と消費者向け表現（フラットなエラーマップ）は分離すべき。内部は伝搬・蓄積に最適化し、外部は表示に最適化することで、両方の要件を満たせる（`flatten()` が担う）
- **制御フローとしての型情報**: エラーが発生しても「型的に正しい」場合（validation issue）と「型的に不正」な場合（schema issue）を区別することで、パイプラインの後続処理を安全に継続/中断できる。dataset の `typed` フラグがこの判断を担う（`library/src/types/dataset.ts:42-73`）
- **メッセージのレイヤード解決**: エラーメッセージは具体→抽象の順に解決すべき。呼び出し時指定 > スキーマ定義時指定 > 特定バリデーション用グローバル > スキーマ種別用グローバル > 全体グローバルの5段階で解決される（`library/src/utils/_addIssue/_addIssue.ts:106-112`）

## 実例と分析

### 1. throw vs result object の二重 API パターン

`parse()` と `safeParse()` は同じ内部処理 (`schema['~run']`) を共有しつつ、エラー報告方法だけが異なる。

```typescript
// library/src/methods/parse/parse.ts:26-32
export function parse<
  const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(schema: TSchema, input: unknown, config?: Config<InferIssue<TSchema>>): InferOutput<TSchema> {
  const dataset = schema["~run"]({ value: input }, getGlobalConfig(config));
  if (dataset.issues) {
    throw new ValiError(dataset.issues);
  }
  return dataset.value;
}

// library/src/methods/safeParse/safeParse.ts:20-34
export function safeParse<
  const TSchema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(schema: TSchema, input: unknown, config?: Config<InferIssue<TSchema>>): SafeParseResult<TSchema> {
  const dataset = schema["~run"]({ value: input }, getGlobalConfig(config));
  return {
    typed: dataset.typed,
    success: !dataset.issues,
    output: dataset.value,
    issues: dataset.issues,
  } as SafeParseResult<TSchema>;
}
```

内部は常に result object（dataset）で動作し、throw は最外層でのみ行われる。これにより内部ロジックは例外安全で、消費者の好みに応じた API を提供できる。

### 2. SafeParseResult の三態判別共用体

`SafeParseResult` は `typed` と `success` の組み合わせで3つの状態を型安全に表現する。

```typescript
// library/src/methods/safeParse/types.ts:12-46
export type SafeParseResult<TSchema extends ...> =
  | { typed: true;  success: true;  output: InferOutput<TSchema>; issues: undefined }
  | { typed: true;  success: false; output: InferOutput<TSchema>; issues: [InferIssue<TSchema>, ...] }
  | { typed: false; success: false; output: unknown;              issues: [InferIssue<TSchema>, ...] };
```

`typed: true, success: false` は「型的には正しいが検証に失敗した」状態（例: 文字列だが長さが足りない）を表し、partial な値でも利用可能であることを示す。

### 3. issue の kind 分類と制御フロー

issue は `kind` プロパティで3種類に分類される: `schema`（型不一致）、`validation`（検証失敗）、`transformation`（変換失敗）。パイプライン実行時にこの分類が制御フローを決定する。

```typescript
// library/src/methods/pipe/pipe.ts:2701-2723
'~run'(dataset, config) {
  for (const item of pipe) {
    if (item.kind !== 'metadata') {
      // schema/transformation の issue がある場合、後続を中断
      if (dataset.issues && (item.kind === 'schema' || item.kind === 'transformation')) {
        dataset.typed = false;
        break;
      }
      // validation の issue は後続に影響しない（abortEarly でない限り）
      if (!dataset.issues || (!config.abortEarly && !config.abortPipeEarly)) {
        dataset = item['~run'](dataset, config);
      }
    }
  }
  return dataset;
},
```

schema issue が発生すると `typed = false` になりパイプが中断するが、validation issue だけなら後続の validation が継続される。

### 4. path 伝搬と unshift パターン

ネストしたスキーマでは、子スキーマの issue に親の path 情報を先頭に挿入する。

```typescript
// library/src/schemas/object/object.ts:142-151
for (const issue of valueDataset.issues) {
  if (issue.path) {
    issue.path.unshift(pathItem);
  } else {
    // @ts-expect-error
    issue.path = [pathItem];
  }
  // @ts-expect-error
  dataset.issues?.push(issue);
}
```

path は配列の先頭に `unshift` で追加される。これにより、深くネストした構造でも `["user", "address", "city"]` のようなフルパスが自然に構築される。

### 5. forward() による issue パスの再マッピング

`forward()` はオブジェクト全体に対する cross-field バリデーションの issue を、特定のフィールドに紐付け直す。

```typescript
// library/src/methods/forward/forward.ts:32-87
export function forward<...>(action, path): BaseValidation<...> {
  return {
    ...action,
    '~run'(dataset, config) {
      const prevIssues = dataset.issues && [...dataset.issues];
      dataset = action['~run'](dataset, config);
      if (dataset.issues) {
        for (const issue of dataset.issues) {
          if (!prevIssues?.includes(issue)) {
            let pathInput: unknown = dataset.value;
            for (const key of path) {
              const pathValue: unknown = pathInput[key];
              const pathItem = { type: 'unknown', origin: 'value', input: pathInput, key, value: pathValue };
              if (issue.path) {
                issue.path.push(pathItem);
              } else {
                issue.path = [pathItem];
              }
              if (!pathValue) break;
              pathInput = pathValue;
            }
          }
        }
      }
      return dataset;
    },
  };
}
```

既存 issue のスナップショットを取り、新たに追加された issue だけに path を付与する。これにより `flatten()` 後に特定フィールドのエラーとして表示できる。

### 6. flatten() による3層分類

`flatten()` は issue の path 構造に基づき、エラーメッセージを `root`・`nested`・`other` の3カテゴリに分類する。

```typescript
// library/src/methods/flatten/flatten.ts:83-132
export function flatten(issues: [BaseIssue<unknown>, ...]): FlatErrors<undefined> {
  const flatErrors: FlatErrors<undefined> = {};
  for (const issue of issues) {
    if (issue.path) {
      const dotPath = getDotPath(issue);
      if (dotPath) {
        // nested: dot-path 変換可能なもの（object, array のキー）
        flatErrors.nested ??= {};
        flatErrors.nested[dotPath]
          ? flatErrors.nested[dotPath].push(issue.message)
          : (flatErrors.nested[dotPath] = [issue.message]);
      } else {
        // other: Set, Map など dot-path に変換できないもの
        flatErrors.other
          ? flatErrors.other.push(issue.message)
          : (flatErrors.other = [issue.message]);
      }
    } else {
      // root: path なし（ルートレベルの issue）
      flatErrors.root
        ? flatErrors.root.push(issue.message)
        : (flatErrors.root = [issue.message]);
    }
  }
  return flatErrors;
}
```

### 7. エラーメッセージの階層的解決

`_addIssue` はメッセージを5段階のフォールバックで解決する。

```typescript
// library/src/utils/_addIssue/_addIssue.ts:106-112
const message = other?.message // 1. 呼び出し時の個別指定
  ?? context.message // 2. スキーマ/アクション定義時の指定
  ?? getSpecificMessage(context.reference, issue.lang) // 3. 関数リファレンス別のグローバル設定
  ?? (isSchema ? getSchemaMessage(issue.lang) : null) // 4. schema 種別用グローバル設定
  ?? config.message // 5. config 経由のメッセージ
  ?? getGlobalMessage(issue.lang); // 6. 全体グローバル設定
```

この階層構造により、i18n 対応（`lang` パラメータ）、バリデーション種別ごとのカスタマイズ、個別オーバーライドを同時に実現している。

## パターンカタログ

- **Result Object パターン** (分類: 振る舞い)
  - 解決する問題: 例外 throw による制御フローの中断を避け、エラーを値として扱う
  - 適用条件: バリデーションのようにエラーが「予期される結果」である場合
  - コード例: `library/src/methods/safeParse/safeParse.ts:20-34`
  - 注意点: `success` を discriminant にした判別共用体にすることで型安全にアクセスできる

- **Composite パターン** (分類: 構造)
  - 解決する問題: ネストしたデータ構造のバリデーション結果を統一的に扱う
  - 適用条件: 再帰的なデータ構造（object in object, array of objects 等）
  - コード例: `library/src/schemas/object/object.ts:98-218`, `library/src/schemas/union/union.ts:108-188`
  - 注意点: issue の path を `unshift` で構築し、子から親へ伝搬させる

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: エラーメッセージの解決を複数レイヤーで段階的に行う
  - 適用条件: メッセージのカスタマイズ粒度が複数レベル必要な場合（i18n、種別別、個別指定）
  - コード例: `library/src/utils/_addIssue/_addIssue.ts:106-112`
  - 注意点: null/undefined の区別が重要。`??` 演算子で null と undefined のみをフォールスルーさせる

## Good Patterns

- **非空配列型による issues の型安全性**: issue 配列を `[T, ...T[]]` （非空タプル型）で定義することで、issues が存在する場合は必ず1件以上あることを型レベルで保証している。`issues[0].message` を安全にアクセスでき、ValiError のコンストラクタ（`library/src/utils/ValiError/ValiError.ts:27`）でも first issue のメッセージを Error.message に設定できる。

```typescript
// library/src/utils/ValiError/ValiError.ts:19
public readonly issues: [InferIssue<TSchema>, ...InferIssue<TSchema>[]];

// library/src/types/dataset.ts:54
issues: [TIssue, ...TIssue[]];
```

- **issue 蓄積の遅延初期化**: dataset.issues を最初から空配列で初期化するのではなく、最初の issue 追加時に配列を作成する。これにより正常系（エラーなし）のメモリ割り当てを回避している。

```typescript
// library/src/utils/_addIssue/_addIssue.ts:130-135
if (dataset.issues) {
  dataset.issues.push(issue);
} else {
  dataset.issues = [issue];
}
```

- **issue の kind 分類による段階的中断**: `schema` / `validation` / `transformation` の3種類で issue を分類し、パイプラインの中断判定を種類ごとに制御する。型不一致（schema）では即座に中断するが、検証失敗（validation）では後続を継続して全エラーを収集する（`library/src/methods/pipe/pipe.ts:2708-2714`）。

- **内部 result + 外部 throw/result の分離**: 内部処理は常に dataset（result object）で動作し、throw はエントリポイント（`parse()`）でのみ行う。これにより、内部ロジックは try-catch 不要で合成可能になり、消費者の好みに応じた API を薄いラッパーで提供できる。

## Anti-Patterns / 注意点

- **issue 配列の空初期化**: issues を `[]` で初期化すると、エラーがない場合でも空配列の存在チェックが必要になる。valibot は `undefined | [T, ...T[]]` とすることで「issues があれば必ず1件以上」を保証し、`if (dataset.issues)` だけで判定できるようにしている。

```typescript
// Bad: 空配列で初期化
interface Dataset {
  issues: Issue[];  // [] なのかエラーありなのか判別しにくい
}
if (dataset.issues.length > 0) { ... }

// Better: undefined | 非空配列
interface Dataset {
  issues?: [Issue, ...Issue[]] | undefined;
}
if (dataset.issues) { ... }  // 存在すれば必ず1件以上
```

- **例外を内部制御フローに使う**: バリデーションでは複数エラーの収集が一般的な要件であり、最初のエラーで throw すると残りのエラーが失われる。内部処理では例外ではなく result object でエラーを蓄積すべき。

```typescript
// Bad: 内部で throw して最初のエラーしか報告できない
function validateField(value: unknown): string {
  if (typeof value !== "string") throw new Error("not a string");
  if (value.length < 3) throw new Error("too short");
  return value;
}

// Better: result object でエラーを蓄積
function validateField(value: unknown): { value: unknown; issues: Issue[]; } {
  const issues: Issue[] = [];
  if (typeof value !== "string") issues.push({ message: "not a string" });
  else if (value.length < 3) issues.push({ message: "too short" });
  return { value, issues };
}
```

- **フラット化なしでネスト issue をそのまま表示**: issue の木構造は内部伝搬には適しているが、UI 表示にはそのまま使えない。フォームのフィールドごとにエラーを表示するには、dot-path への変換（フラット化）レイヤーが必要である。

## 導出ルール

- `[MUST]` バリデーション結果を返す関数は、throw と result object の両方の API を提供する場合、内部処理は常に result object で行い、throw は最外層のラッパーでのみ行う
  - 根拠: valibot の `parse()` と `safeParse()` は同一の `schema['~run']()` を呼び、throw は `parse()` の1行でのみ行われる（`library/src/methods/parse/parse.ts:29`）

- `[MUST]` エラー配列を持つ型では `undefined | [T, ...T[]]`（非空タプル or undefined）を使い、空配列状態を排除する
  - 根拠: valibot の全 dataset 型で `issues?: [TIssue, ...TIssue[]] | undefined` が使われ、存在チェックだけで非空を保証している（`library/src/types/dataset.ts:54`）

- `[SHOULD]` ネストしたデータ構造のバリデーションでは、issue に path 情報（型・キー・値を含む path item の配列）を持たせ、子から親へ `unshift` で伝搬させる
  - 根拠: object スキーマで子の issue.path に親の pathItem を `unshift` し、フルパスを自動構築している（`library/src/schemas/object/object.ts:143-147`）

- `[SHOULD]` バリデーション issue を `kind` で分類し（型不一致 / 検証失敗 / 変換失敗）、パイプライン継続の判断に利用する
  - 根拠: pipe の `~run` は `kind === 'schema' || kind === 'transformation'` で中断し、`kind === 'validation'` は後続を継続して全エラーを収集する（`library/src/methods/pipe/pipe.ts:2708-2714`）

- `[SHOULD]` エラーメッセージは具体→抽象の優先度でフォールバック解決する（個別指定 > 種別別グローバル > 全体グローバル）
  - 根拠: `_addIssue` が6段階の `??` チェーンでメッセージを解決し、i18n 対応と個別カスタマイズを両立している（`library/src/utils/_addIssue/_addIssue.ts:106-112`）

- `[SHOULD]` 内部のエラーデータ構造（木構造）と消費者向けのエラー表現（フラットマップ）を分離し、変換関数（`flatten()` 相当）を提供する
  - 根拠: `flatten()` が issue の path から dot-path を導出し、`root` / `nested` / `other` の3層に分類して UI 表示に適した形式に変換している（`library/src/methods/flatten/flatten.ts:83-132`）

- `[AVOID]` エラー配列を空配列 `[]` で初期化すること。undefined を使い、存在チェック (`if (issues)`) だけで「エラーあり」を判定できるようにする
  - 根拠: valibot は dataset.issues を `undefined` で初期化し、最初の issue 追加時にのみ配列を作成する遅延初期化を行っている（`library/src/utils/_addIssue/_addIssue.ts:130-135`）

## 適用チェックリスト

- [ ] バリデーション関数が throw と result object の両方の API を提供しているか。内部処理は result object で統一されているか
- [ ] エラー配列の型が `undefined | [T, ...T[]]` になっているか。空配列状態が型レベルで排除されているか
- [ ] ネストしたバリデーションで、子の issue に親の path 情報が付与されているか
- [ ] issue に `kind` 分類があり、種類に応じてパイプラインの継続/中断が制御されているか
- [ ] エラーメッセージにフォールバック機構があるか（個別指定 > 種別別 > グローバル）
- [ ] 内部の issue 構造と消費者向けのフラットなエラー表現が分離されているか
- [ ] cross-field バリデーションの issue を特定フィールドに再マッピングする仕組み（forward 相当）があるか
- [ ] エラー収集がデフォルトで「全件収集」になっており、早期中断はオプトインか
