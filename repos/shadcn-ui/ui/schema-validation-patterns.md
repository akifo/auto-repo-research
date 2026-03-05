# Schema Validation Patterns

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn/ui の CLI パッケージ (`packages/shadcn`) は、レジストリアイテムの型安全な取得・検証・変換パイプラインを Zod で構築している。特に注目すべきは `z.discriminatedUnion` による多態的なスキーマ設計で、12 種類以上のアイテムタイプを単一のスキーマで安全に扱いつつ、タイプごとに異なるフィールド要件を強制している。共通フィールドの抽出と `.extend()` による差分合成、`z.infer` + TypeScript の `Extract` ユーティリティ型によるバリアント型の導出、`z.lazy` による再帰スキーマなど、大規模なスキーマ設計で再利用可能なパターンが体系的に適用されている。

## 背景にある原則

- **Single Source of Truth (スキーマ駆動型設計)**: Zod スキーマを唯一の型定義源とし、`z.infer<typeof schema>` で TypeScript 型を導出する。手動の型定義とスキーマの二重管理を排除し、ランタイムバリデーションとコンパイル時型チェックの一貫性を保証する。コードベース全体で 60 箇所以上が `z.infer` で型注釈されている (`packages/shadcn/src/registry/schema.ts:183`, `packages/shadcn/src/utils/get-config.ts:29` 他)。

- **境界でのバリデーション、内部での信頼**: 外部データ (HTTP レスポンス、ローカルファイル、CLI 引数、設定ファイル) はすべてシステム境界で `.parse()` / `.safeParse()` を通し、内部ロジックではバリデーション済みの型を信頼して処理する。`registryItemSchema.parse(result)` が `fetcher.ts`, `resolver.ts`, `api.ts` の各エントリポイントで呼ばれ、通過後のデータはバリデーションなしで伝播する (`packages/shadcn/src/registry/fetcher.ts:141`, `packages/shadcn/src/registry/api.ts:55`)。

- **合成による再利用 (Composition over Duplication)**: 共通スキーマ (`registryItemCommonSchema`) を定義し、`.extend()` でバリアント固有フィールドを付加する。共通部分の変更が全バリアントに自動伝播する。同様に `rawConfigSchema` を `.extend()` して `configSchema` を作り、段階的に構造を拡張する (`packages/shadcn/src/registry/schema.ts:56-67`)。

- **Progressive Strictness (段階的な厳密性)**: 外部入力には `.strict()` で余分なフィールドを拒否し (`rawConfigSchema`)、内部的な中間表現には `.passthrough()` で未知フィールドを許容する (`registryItemWithSourceSchema`)。データフローの段階に応じて厳密性レベルを使い分けている (`packages/shadcn/src/registry/schema.ts:54`, `packages/shadcn/src/registry/resolver.ts:120`)。

## 実例と分析

### discriminatedUnion によるバリアント管理

`registryItemSchema` は `"type"` フィールドを判別子とする discriminatedUnion で、3 つのブランチを持つ。12 種類のタイプ文字列を `registryItemTypeSchema` (z.enum) で定義し、バリアントごとに必要なフィールドを `.extend()` で追加している。

**設計のポイント**: `registry:base` は `config` フィールドを持ち、`registry:font` は `font` フィールドを持ち、それ以外のタイプはどちらも持たない。`registryItemTypeSchema.exclude()` を使って、既に専用バリアントがある値を残りのブランチから除外し、判別子の重複を防いでいる。

```typescript
// packages/shadcn/src/registry/schema.ts:169-181
export const registryItemSchema = z.discriminatedUnion("type", [
  registryItemCommonSchema.extend({
    type: z.literal("registry:base"),
    config: rawConfigSchema.deepPartial().optional(),
  }),
  registryItemCommonSchema.extend({
    type: z.literal("registry:font"),
    font: registryItemFontSchema,
  }),
  registryItemCommonSchema.extend({
    type: registryItemTypeSchema.exclude(["registry:base", "registry:font"]),
  }),
]);
```

同じパターンが `registryItemFileSchema` にも適用されており、`registry:file` と `registry:page` は `target` を必須、それ以外は任意としている。

```typescript
// packages/shadcn/src/registry/schema.ts:92-106
export const registryItemFileSchema = z.discriminatedUnion("type", [
  z.object({
    path: z.string(),
    content: z.string().optional(),
    type: z.enum(["registry:file", "registry:page"]),
    target: z.string(),
  }),
  z.object({
    path: z.string(),
    content: z.string().optional(),
    type: registryItemTypeSchema.exclude(["registry:file", "registry:page"]),
    target: z.string().optional(),
  }),
]);
```

### Extract による discriminatedUnion からのバリアント型導出

`z.infer` で得られるユニオン型から特定のバリアントを取り出すために、TypeScript の `Extract` ユーティリティ型を使用している。これにより、Zod の discriminatedUnion とTypeScript の型システムが連携し、バリアント固有のフィールドに型安全にアクセスできる。

```typescript
// packages/shadcn/src/registry/schema.ts:183-189
export type RegistryItem = z.infer<typeof registryItemSchema>;
export type RegistryBaseItem = Extract<RegistryItem, { type: "registry:base"; }>;
export type RegistryFontItem = Extract<RegistryItem, { type: "registry:font"; }>;
```

`RegistryFontItem` を使うと `font` プロパティが確実に存在する型として利用でき、`resolver.ts` でフォントアイテムのフィルタリング後に安全にアクセスできる。

```typescript
// packages/shadcn/src/registry/resolver.ts:338-344
const fonts: RegistryFontItem[] = payload
  .filter((item) => item.type === "registry:font" && item.font)
  .map((item) => ({
    ...item,
    type: "registry:font" as const,
    font: item.font!,
  }));
```

### rawConfigSchema と configSchema の段階的拡張

ユーザーが書く設定ファイル (components.json) のスキーマ `rawConfigSchema` と、ランタイムで使う完全な設定 `configSchema` を分離している。`rawConfigSchema` は `.strict()` で余分なフィールドを拒否し、`configSchema` は `rawConfigSchema.extend()` で `resolvedPaths` を追加する。

```typescript
// packages/shadcn/src/registry/schema.ts:28-67
export const rawConfigSchema = z
  .object({
    $schema: z.string().optional(),
    style: z.string(),
    // ... ユーザーが書くフィールド
  })
  .strict();

export const configSchema = rawConfigSchema.extend({
  resolvedPaths: z.object({
    cwd: z.string(),
    tailwindConfig: z.string(),
    // ... ランタイムで解決されるパス
  }),
});
```

この段階的拡張は `rawConfigSchema.deepPartial()` の再利用にもつながっている。`registry:base` アイテムがベース設定をオーバーライドする際、全フィールドを省略可能にする必要があり、`.deepPartial()` がこれを実現する。

```typescript
// packages/shadcn/src/registry/schema.ts:172
config: rawConfigSchema.deepPartial().optional(),

// packages/shadcn/src/commands/init.ts:109
registryBaseConfig: rawConfigSchema.deepPartial().optional(),
```

### z.lazy による再帰スキーマ

CSS プロパティの値は再帰的にネスト可能であり、`z.lazy` で遅延評価することで自己参照スキーマを実現している。明示的な型注釈 `z.ZodType<any>` が必要な点に注目。

```typescript
// packages/shadcn/src/registry/schema.ts:125-131
const cssValueSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.string(),
    z.array(z.union([z.string(), z.record(z.string(), z.string())])),
    z.record(z.string(), cssValueSchema),
  ])
);
```

### .pick() + .extend() によるビュースキーマの構築

解決済みアイテムツリーのスキーマは、共通スキーマから必要なフィールドだけを `.pick()` し、追加フィールドを `.extend()` で合成している。元のスキーマを壊さずに用途特化のスキーマを作るパターンで、GraphQL のフィールド選択に近い考え方。

```typescript
// packages/shadcn/src/registry/schema.ts:224-244
export const registryResolvedItemsTreeSchema = registryItemCommonSchema
  .pick({
    dependencies: true,
    devDependencies: true,
    files: true,
    tailwind: true,
    cssVars: true,
    css: true,
    envVars: true,
    docs: true,
  })
  .extend({
    fonts: z
      .array(
        registryItemCommonSchema.extend({
          type: z.literal("registry:font"),
          font: registryItemFontSchema,
        }),
      )
      .optional(),
  });
```

### z.union による柔軟な入力形式の受け入れ

`registryConfigItemSchema` は文字列形式とオブジェクト形式の両方を受け入れる。簡単なケースは文字列 1 行、認証が必要なケースはオブジェクト形式という段階的な複雑さを提供する。`.refine()` でビジネスルール (`{name}` プレースホルダの必須性) を両形式に適用している。

```typescript
// packages/shadcn/src/registry/schema.ts:6-19
export const registryConfigItemSchema = z.union([
  z.string().refine((s) => s.includes("{name}"), {
    message: "Registry URL must include {name} placeholder",
  }),
  z.object({
    url: z.string().refine((s) => s.includes("{name}"), {
      message: "Registry URL must include {name} placeholder",
    }),
    params: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);
```

### .passthrough() による内部拡張スキーマ

`resolver.ts` では取得済みアイテムにソース追跡用の `_source` フィールドを追加する必要がある。`.passthrough()` を使うことで、元のスキーマが知らないフィールドを通過させつつ、追加フィールドの型安全性を確保している。

```typescript
// packages/shadcn/src/registry/resolver.ts:112-120
const registryItemWithSourceSchema = registryItemCommonSchema
  .extend({
    type: registryItemTypeSchema,
    _source: z.string().optional(),
    font: registryItemFontSchema.optional(),
    config: z.any().optional(),
  })
  .passthrough();
```

### safeParse と parse の使い分け

境界で失敗を許容する箇所 (ユーザー入力のバリデーション、ビルド時の個別アイテム検証) には `.safeParse()` を使い、失敗が致命的な内部処理には `.parse()` を使う。

```typescript
// packages/shadcn/src/commands/build.ts:43 - safeParse: ユーザーのレジストリファイル検証
const result = registrySchema.safeParse(JSON.parse(content));
if (!result.success) {
  logger.error(`Invalid registry file found at ${highlighter.info(resolvePaths.registryFile)}.`);
  process.exit(1);
}

// packages/shadcn/src/registry/api.ts:55 - parse: 内部的な信頼済みデータ
return registrySchema.parse(result);
```

### 構造化エラークラスとスキーマの連携

`RegistryParseError` は `z.ZodError` を検出して、パスとメッセージを人間に読みやすい形式にフォーマットする。スキーマバリデーションのエラー詳細をユーザーに伝えるための重要なブリッジ。

```typescript
// packages/shadcn/src/registry/errors.ts:213-236
export class RegistryParseError extends RegistryError {
  constructor(public readonly item: string, parseError: unknown) {
    let message = `Failed to parse registry item: ${item}`;
    if (parseError instanceof z.ZodError) {
      message = `Failed to parse registry item: ${item}\n${
        parseError.errors
          .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
          .join("\n")
      }`;
    }
    super(message, {
      code: RegistryErrorCode.PARSE_ERROR,
      cause: parseError,
      context: { item },
      suggestion: "The registry item may be corrupted or have an invalid format...",
    });
  }
}
```

## コード例

```typescript
// packages/shadcn/src/registry/schema.ts:73-90
// z.enum で全タイプを列挙し、discriminatedUnion の判別子型として再利用
export const registryItemTypeSchema = z.enum([
  "registry:lib",
  "registry:block",
  "registry:component",
  "registry:ui",
  "registry:hook",
  "registry:page",
  "registry:file",
  "registry:theme",
  "registry:style",
  "registry:item",
  "registry:base",
  "registry:font",
  "registry:example",
  "registry:internal",
]);
```

```typescript
// packages/shadcn/src/registry/schema.ts:21-26
// z.record のキーに .refine() でバリデーションを追加
export const registryConfigSchema = z.record(
  z.string().refine((key) => key.startsWith("@"), {
    message: "Registry names must start with @ (e.g., @v0, @acme)",
  }),
  registryConfigItemSchema,
);
```

```typescript
// packages/shadcn/src/registry/config.ts:20-37
// configSchema.parse() で deepmerge 結果を再バリデーション
export function configWithDefaults(config?: DeepPartial<Config>) {
  const baseConfig = createConfig({
    style: FALLBACK_STYLE,
    registries: BUILTIN_REGISTRIES,
  });
  if (!config) {
    return baseConfig;
  }
  return configSchema.parse(
    deepmerge(baseConfig, {
      ...config,
      style: resolveStyleFromConfig(config),
      registries: { ...BUILTIN_REGISTRIES, ...config.registries },
    }),
  );
}
```

```typescript
// packages/shadcn/src/registry/fetcher.ts:68-77
// エラーレスポンスの構造を inline スキーマでパース（RFC 7807 対応）
const parsed = z
  .object({
    detail: z.string().optional(),
    title: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  })
  .safeParse(json);
```

## パターンカタログ

- **Discriminated Union Pattern** (分類: 構造)
  - 解決する問題: 多態的なデータ構造で、バリアントごとに異なる必須フィールドを型安全に表現する
  - 適用条件: 共通の判別フィールド (discriminator) があり、その値によって構造が分岐するデータ
  - コード例: `packages/shadcn/src/registry/schema.ts:169-181`
  - 注意点: Zod の discriminatedUnion は判別子フィールドの値が重複すると型エラーになる。`.exclude()` で既出の値を除外する必要がある

- **Schema Composition (合成スキーマ)** (分類: 構造)
  - 解決する問題: 共通フィールドの重複定義と、変更時の同期漏れ
  - 適用条件: 複数のスキーマが共通フィールドセットを持つ場合
  - コード例: `packages/shadcn/src/registry/schema.ts:148-181` (`registryItemCommonSchema` + `.extend()`)
  - 注意点: `.extend()` は元のスキーマを変更しない (不変操作)。新しいスキーマオブジェクトが返る

- **Progressive Schema Extension** (分類: 構造)
  - 解決する問題: 外部入力スキーマと内部表現スキーマの段階的な拡張
  - 適用条件: 同じデータが処理段階に応じて異なるフィールドセットを持つ場合
  - コード例: `packages/shadcn/src/registry/schema.ts:28-67` (`rawConfigSchema` -> `configSchema`)
  - 注意点: `.strict()` を基底スキーマに適用すると、`.extend()` 後のスキーマにも厳密性が継承される

- **Boundary Validation Pattern** (分類: 振る舞い)
  - 解決する問題: 信頼できないデータが内部ロジックに侵入するリスク
  - 適用条件: HTTP レスポンス、ファイル読み込み、ユーザー入力など外部境界
  - コード例: `packages/shadcn/src/registry/fetcher.ts:141`, `packages/shadcn/src/registry/resolver.ts:82`
  - 注意点: `.parse()` はバリデーション失敗時に例外を投げる。ユーザー向けの分岐が必要な場合は `.safeParse()` を使う

## Good Patterns

- **共通スキーマの `.extend()` による DRY なバリアント定義**: `registryItemCommonSchema` に 15 以上の共通フィールドを定義し、3 つのバリアントが `.extend()` で固有フィールドだけを追加する。共通フィールドの変更は全バリアントに自動伝播する。

```typescript
// Good: 共通スキーマを一度定義し、extend でバリアント固有フィールドを追加
const commonSchema = z.object({ name: z.string(), description: z.string().optional() });

const variantA = commonSchema.extend({ type: z.literal("a"), config: configSchema });
const variantB = commonSchema.extend({ type: z.literal("b"), font: fontSchema });
const variantC = commonSchema.extend({ type: z.enum(["c", "d", "e"]) });

const itemSchema = z.discriminatedUnion("type", [variantA, variantB, variantC]);
```

- **`z.infer` + `Extract` による型導出**: discriminatedUnion からバリアント固有の型を手動で書かず、`Extract` で自動導出する。スキーマ変更時に型定義の更新漏れがない。

```typescript
type Item = z.infer<typeof itemSchema>;
type BaseItem = Extract<Item, { type: "registry:base"; }>; // config フィールドが存在する型
type FontItem = Extract<Item, { type: "registry:font"; }>; // font フィールドが存在する型
```

- **`.refine()` によるビジネスルールのスキーマ内記述**: URL に `{name}` プレースホルダが含まれることを `.refine()` で強制し、バリデーションロジックをスキーマに集約する。バリデーション漏れのリスクを構造的に排除。

```typescript
z.string().refine((s) => s.includes("{name}"), {
  message: "Registry URL must include {name} placeholder",
});
```

- **`.strict()` と `.passthrough()` の段階的使い分け**: ユーザー入力は `.strict()` で余分なフィールドを拒否し、内部中間データは `.passthrough()` で柔軟に拡張可能にする。

```typescript
// ユーザー入力: 余分なフィールドを拒否
const rawConfigSchema = z.object({/* ... */}).strict();

// 内部表現: _source などのメタデータフィールドを許容
const internalSchema = baseSchema.extend({ _source: z.string().optional() }).passthrough();
```

- **Zod スキーマと JSON Schema の並行管理**: `registryItemSchema` (Zod) と `registry-item.json` (JSON Schema) を併用し、Zod はランタイム+型チェック用、JSON Schema は外部ツール (IDE、エディタ) の補完用として使い分けている。スキーマファイルの冒頭コメントで同期の注意喚起がある (`schema.ts:4`)。

## Anti-Patterns / 注意点

- **`z.ZodType<any>` による型安全性の欠落**: 再帰スキーマ `cssValueSchema` は `z.ZodType<any>` と注釈されているため、推論される型が `any` になる。これは Zod が再帰型を推論できない制約に起因する。

```typescript
// Bad: any 型が伝播する
const cssValueSchema: z.ZodType<any> = z.lazy(() => z.union([z.string(), z.record(z.string(), cssValueSchema)]));
// このスキーマから z.infer すると any になる

// Better: 再帰型を明示的に定義して ZodType に渡す
type CssValue = string | string[] | { [key: string]: CssValue; };
const cssValueSchema: z.ZodType<CssValue> = z.lazy(() =>
  z.union([z.string(), z.array(z.string()), z.record(z.string(), cssValueSchema)])
);
```

- **Zod スキーマと JSON Schema の手動同期**: `schema.ts` の冒頭に「JSON Schema も更新せよ」というコメントがあるが、自動同期の仕組みがない。`zod-to-json-schema` などのツールで自動生成するか、テストで同期を検証する方が安全。

```typescript
// packages/shadcn/src/registry/schema.ts:3-4
// Note: if you edit the schema here, you must also edit the schema in the
// apps/v4/public/schema/registry-item.json file.
```

- **discriminatedUnion のキャッチオールブランチの型の広さ**: `.exclude()` で残りのタイプ値をまとめるブランチは、多くのリテラル型のユニオンとなり、型ナローイングが複雑になる場合がある。特定のタイプ値に対するロジック分岐では型アサーションに頼りがちになる。

## 導出ルール

- `[MUST]` discriminatedUnion のバリアントで共通フィールドがある場合、共通スキーマを定義して `.extend()` で差分だけを追加する
  - 根拠: shadcn/ui は 15 以上の共通フィールドを `registryItemCommonSchema` に集約し、3 バリアントが `.extend()` で固有フィールドだけを追加している。フィールド追加・変更が 1 箇所で完結する (`schema.ts:148-181`)

- `[MUST]` 外部入力データ (HTTP レスポンス、ファイル読み込み、CLI 引数) はシステム境界で `.parse()` / `.safeParse()` を通し、内部ロジックではバリデーション済みの型を信頼する
  - 根拠: `fetcher.ts`, `resolver.ts`, `api.ts` の全エントリポイントで `registryItemSchema.parse()` が適用され、通過後のデータは再バリデーションされない。二重バリデーションのコストを避けつつ型安全性を確保する設計

- `[MUST]` Zod スキーマから型を導出する場合は `z.infer<typeof schema>` を使い、手動の型定義を作らない
  - 根拠: コードベース全体で 60 箇所以上が `z.infer` で型注釈されており、スキーマ変更時の型定義の同期漏れを構造的に防止している

- `[SHOULD]` discriminatedUnion から特定バリアントの型を取り出す場合、`Extract<UnionType, { discriminator: "value" }>` を使う
  - 根拠: `RegistryBaseItem` と `RegistryFontItem` がこのパターンで定義されており、バリアント固有フィールドへの型安全なアクセスを実現している (`schema.ts:186-189`)

- `[SHOULD]` ユーザー向けの設定スキーマには `.strict()` を適用し、タイポや非推奨フィールドの混入を拒否する
  - 根拠: `rawConfigSchema` に `.strict()` が適用されており、`components.json` の余分なフィールドを早期に検出する (`schema.ts:54`)

- `[SHOULD]` 同一データが処理段階で構造変化する場合、基底スキーマを `.extend()` で段階的に拡張し、段階ごとに別の型を持たせる
  - 根拠: `rawConfigSchema` (ユーザー入力) -> `configSchema` (ランタイム拡張) の 2 段階設計で、`resolvedPaths` の有無を型レベルで区別している (`schema.ts:28-67`)

- `[SHOULD]` `z.lazy()` で再帰スキーマを定義する場合、`z.ZodType<具体型>` で明示的に型注釈し、`any` の伝播を防ぐ
  - 根拠: `cssValueSchema` は `z.ZodType<any>` と注釈されており、推論型が `any` になっている。再帰型を明示すれば型安全性を維持できる (`schema.ts:125`)

- `[AVOID]` discriminatedUnion の判別子に同じ値を複数ブランチで使用する（`.exclude()` で既出の値を除外すること）
  - 根拠: `registryItemTypeSchema.exclude(["registry:base", "registry:font"])` で、専用バリアントがあるタイプ値をキャッチオールブランチから除外し、判別の曖昧さを排除している (`schema.ts:179`)

- `[AVOID]` `.parse()` と `.safeParse()` を状況に関わらず一律に使い分ける
  - 根拠: shadcn/ui ではユーザー入力検証 (ビルド時) には `.safeParse()` でエラーメッセージを表示し、内部処理の整合性保証には `.parse()` で例外を投げる設計。状況に応じた使い分けが重要 (`build.ts:43` vs `api.ts:55`)

## 適用チェックリスト

- [ ] プロジェクトの Zod スキーマで、共通フィールドが複数のスキーマに重複定義されていないか確認する。重複があれば共通スキーマを抽出して `.extend()` で合成する
- [ ] discriminatedUnion を使う場合、判別子フィールドの値が全ブランチで排他的であることを確認する。残りをまとめるブランチでは `.exclude()` を使う
- [ ] 外部データを受け取る全エントリポイントで `.parse()` / `.safeParse()` が呼ばれていることを確認する
- [ ] 型定義が `z.infer<typeof schema>` で導出されていない箇所がないか確認する。手動の型定義とスキーマの二重管理があれば `z.infer` に統一する
- [ ] ユーザーが直接編集する設定ファイルのスキーマに `.strict()` が適用されているか確認する
- [ ] `z.lazy()` を使った再帰スキーマで `z.ZodType<any>` になっている箇所があれば、具体的な再帰型を定義して置き換える
- [ ] スキーマバリデーションエラーが適切なメッセージでユーザーに伝わるか確認する。`z.ZodError` のパス・メッセージを人間が読める形式にフォーマットしているか
