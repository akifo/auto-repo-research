# metaprogramming-techniques

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

drizzle-orm のコード生成パイプライン（DB introspect から TypeScript スキーマファイル出力まで）を分析する。このリポジトリは、5 種類のデータベース（PostgreSQL、MySQL、SQLite、SingleStore、GEL）に対して統一的なメタプログラミングパイプラインを構築しており、Zod によるスキーマバリデーション付き中間表現を軸にした「DB メタデータ → 中間表現 → TypeScript コード」の 3 層アーキテクチャが注目に値する。また、ビルドスクリプトでは AST 操作ライブラリ recast を用いたインポートパス修正が行われており、文字列置換に頼らないコード変換の実例がある。

## 背景にある原則

- **中間表現の正規化による変換の分離**: DB ごとに異なるメタデータ取得方法を持ちながらも、それを共通の正規化された中間表現（`PgSchemaInternal` 等）に変換することで、コード生成ロジックを DB 固有の詳細から分離している。これにより DB 追加時のコード生成側への影響がゼロになる。直接 DB → TypeScript 変換を行えば短期的にはシンプルだが、DB 方言が増えるたびにコード生成も分岐が必要になる。

- **スキーマを型とバリデーションの単一情報源にする**: Zod スキーマで中間表現を定義し、`TypeOf<typeof schema>` で型を導出している。スキーマ定義と型定義を二重管理せず、Zod がランタイムバリデーション（マイグレーションファイルの読み込み時）と型チェック（開発時）の両方を担う。

- **バージョン付き中間表現でスキーマ進化に対応する**: `pgSchemaV1` から `pgSchemaV7` まで、中間表現のバージョンを明示的に管理している。`backwardCompatiblePgSchema = union([pgSchemaV5, pgSchemaV6, pgSchema])` のように union 型で複数バージョンを受け入れ可能にし、古いマイグレーションファイルも読み込める。中間表現を変更しても既存データとの互換性を保てる。

- **文字列連結によるコード生成を意図的に採用する**: テンプレートエンジンや AST ビルダーではなく、文字列連結でコード生成している。出力が単一ファイルの TypeScript コードであり、構造が比較的固定的であるため、文字列連結の方が見通しがよく保守しやすいという判断と推測される。

## 実例と分析

### パイプライン全体像: 3 フェーズの分離

introspect コマンドは以下の 3 フェーズを経る。

1. **メタデータ取得** (`fromDatabase`): DB に SQL クエリを発行し、テーブル・カラム・インデックス・外部キー等のメタデータを取得する
2. **中間表現への正規化** (`fromDatabase` 内): 取得したメタデータを Zod スキーマで定義された中間表現に変換する
3. **コード生成** (`schemaToTypeScript`): 中間表現から TypeScript ソースコードを文字列として生成する

オーケストレーションは `cli/commands/introspect.ts` で行われ、各 DB に対して同一のパターンが適用される。

```typescript
// drizzle-kit/src/cli/commands/introspect.ts:97-116
const res = await renderWithTask(
  progress,
  fromPostgresDatabase(
    db,
    filter,
    schemasFilter,
    entities,
    (stage, count, status) => {
      progress.update(stage, count, status);
    },
  ),
);

const schema = { id: originUUID, prevId: "", ...res } as PgSchema;
const ts = postgresSchemaToTypeScript(schema, casing);
const relationsTs = relationsToTypeScript(schema, casing);

const schemaFile = join(out, "schema.ts");
writeFileSync(schemaFile, ts.file);
```

### Zod スキーマによる中間表現の型安全な定義

DB メタデータの中間表現は Zod スキーマとして定義され、型はそこから導出される。

```typescript
// drizzle-kit/src/serializer/pgSchema.ts:175-192
const column = object({
  name: string(),
  type: string(),
  typeSchema: string().optional(),
  primaryKey: boolean(),
  notNull: boolean(),
  default: any().optional(),
  isUnique: any().optional(),
  uniqueName: string().optional(),
  nullsNotDistinct: boolean().optional(),
  generated: object({
    type: literal("stored"),
    as: string(),
  }).optional(),
  identity: sequenceSchema
    .merge(object({ type: enumType(["always", "byDefault"]) }))
    .optional(),
}).strict();
```

```typescript
// drizzle-kit/src/serializer/pgSchema.ts:511-514
export type Column = TypeOf<typeof column>;
export type Table = TypeOf<typeof table>;
export type PgSchema = TypeOf<typeof pgSchema>;
export type PgSchemaInternal = TypeOf<typeof pgSchemaInternal>;
```

`.strict()` を全スキーマに適用することで、想定外のフィールドがあればバリデーション時にエラーとなり、中間表現の正確性を保証している。

### バージョン付きスキーマ進化

pgSchema は V1 から V7 まで進化しており、各バージョンが明示的に定義されている。

```typescript
// drizzle-kit/src/serializer/pgSchema.ts:504-509
export const pgSchemaV3 = pgSchemaInternalV3.merge(schemaHash);
export const pgSchemaV4 = pgSchemaInternalV4.merge(schemaHash);
export const pgSchemaV5 = pgSchemaInternalV5.merge(schemaHash);
export const pgSchemaV6 = pgSchemaInternalV6.merge(schemaHash);
export const pgSchemaV7 = pgSchemaInternalV7.merge(schemaHash);
export const pgSchema = pgSchemaInternal.merge(schemaHash);
```

```typescript
// drizzle-kit/src/serializer/pgSchema.ts:545-548
export const backwardCompatiblePgSchema = union([
  pgSchemaV5,
  pgSchemaV6,
  pgSchema,
]);
```

各バージョンの違いを追跡すると、V3 で `dialect: 'pg'`、V6 で `dialect: 'postgresql'` に変更、V5 で `_meta` と `internal` 追加、V7 で `sequences` 追加と `index` のカラム構造変更が行われている。Zod の `union` を使うことでバリデーション時に自動的に正しいバージョンとしてパースされる。

### DB メタデータ取得: 生 SQL によるカタログクエリ

`fromDatabase` 関数は `pg_catalog`、`information_schema` 等のシステムカタログに対して生 SQL を発行し、テーブル構造を再現する。

```typescript
// drizzle-kit/src/serializer/pgSerializer.ts:993-1010
const allTables = await db.query<{
  table_schema: string;
  table_name: string;
  type: string;
  rls_enabled: boolean;
}>(
  `SELECT
    n.nspname AS table_schema,
    c.relname AS table_name,
    CASE
        WHEN c.relkind = 'r' THEN 'table'
        WHEN c.relkind = 'v' THEN 'view'
        WHEN c.relkind = 'm' THEN 'materialized_view'
    END AS type,
    c.relrowsecurity AS rls_enabled
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'v', 'm')
    ${where === "" ? "" : ` AND ${where}`};`,
);
```

この手法は ORM の `information_schema` 抽象化に頼らず、DB 固有のシステムテーブルに直接アクセスすることで最大限の情報を取得する設計方針を示している。

### 文字列連結によるコード生成と型マッピング

`schemaToTypeScript` は中間表現を受け取り、文字列連結で TypeScript コードを生成する。カラム型のマッピングは `column` 関数内の if-else チェーンで行われる。

```typescript
// drizzle-kit/src/introspect-pg.ts:858-870
if (lowered.startsWith("bigserial")) {
  return `${withCasing(name, casing)}: bigserial(${dbColumnName({ name, casing, withMode: true })}{ mode: "bigint" })`;
}

if (lowered.startsWith("integer")) {
  let out = `${withCasing(name, casing)}: integer(${dbColumnName({ name, casing })})`;
  return out;
}
```

import 文の生成では、使用されるカラム型を `Set` で追跡し、必要なもののみ `import` に含める。

```typescript
// drizzle-kit/src/introspect-pg.ts:604-611
const uniquePgImports = ["pgTable", ...new Set(imports.pg)];

const importsTs = `import { ${uniquePgImports.join(", ")} } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"\n\n`;
```

### `importsPatch`: DB 型名と API 関数名の不一致を吸収

DB 型名と drizzle-orm の API 関数名が異なるケースを `importsPatch` マップで吸収している。

```typescript
// drizzle-kit/src/introspect-pg.ts:151-157
const importsPatch = {
  "double precision": "doublePrecision",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamp",
  "time without time zone": "time",
  "time with time zone": "time",
} as Record<string, string>;
```

### AST ベースのインポートパス修正

ビルドスクリプト `fix-imports.ts` では recast ライブラリでコンパイル済みファイルの AST を走査し、インポートパスの拡張子を `.js` / `.cjs` に統一する。

```typescript
// drizzle-orm/scripts/fix-imports.ts:29-65
const cjsFiles = await glob("dist.new/**/*.{cjs,d.cts}");

await Promise.all(cjsFiles.map(async (file) => {
  const code = parse(await fs.readFile(file, "utf8"), { parser });

  visit(code, {
    visitImportDeclaration(path) {
      path.value.source.value = fixImportPath(path.value.source.value, file, ".cjs");
      this.traverse(path);
    },
    visitExportAllDeclaration(path) {
      path.value.source.value = fixImportPath(path.value.source.value, file, ".cjs");
      this.traverse(path);
    },
    visitCallExpression(path) {
      if (path.value.callee.type === "Identifier" && path.value.callee.name === "require") {
        path.value.arguments[0].value = fixImportPath(path.value.arguments[0].value, file, ".cjs");
      }
      this.traverse(path);
    },
  });

  await fs.writeFile(file, print(code).code);
}));
```

パスエイリアス `~/` の解決もここで行われ、ビルド成果物の一貫性を保証している。

### exports map の自動生成

`build.ts` ではファイルシステムの glob 結果から `package.json` の `exports` フィールドを自動生成する。

```typescript
// drizzle-orm/scripts/build.ts:10-44
const entries = await glob('src/**/*.ts');

pkg.exports = entries.reduce<Record<string, { ... }>>(
    (acc, rawEntry) => {
        const entry = rawEntry.match(/src\/(.*)\.ts/)![1]!;
        const exportsEntry = entry === 'index' ? '.' : './' + entry.replace(/\/index$/, '');
        const importEntry = `./${entry}.js`;
        const requireEntry = `./${entry}.cjs`;
        acc[exportsEntry] = {
            import: { types: `./${entry}.d.ts`, default: importEntry },
            require: { types: `./${entry}.d.cts`, default: requireEntry },
            types: `./${entry}.d.ts`,
            default: importEntry,
        };
        return acc;
    },
    {},
);
```

ソースファイルの追加・削除に対して exports map が自動追従するため、手動管理による漏れを防止する。

### `assertUnreachable` による網羅性チェック

`Casing` 型（`'preserve' | 'camel'`）の分岐で `assertUnreachable` を使い、将来の型追加時にコンパイルエラーで漏れを検出する。

```typescript
// drizzle-kit/src/global.ts:4-6
export function assertUnreachable(x: never | undefined): never {
  throw new Error("Didn't expect to get here");
}
```

```typescript
// drizzle-kit/src/introspect-pg.ts:168-177
const withCasing = (value: string, casing: Casing) => {
  if (casing === "preserve") {
    return escapeColumnKey(value);
  }
  if (casing === "camel") {
    return escapeColumnKey(value.camelCase());
  }
  assertUnreachable(casing);
};
```

## パターンカタログ

- **Interpreter パターン** (分類: 振る舞い)
  - 解決する問題: DB メタデータという「言語」を TypeScript コードに変換する
  - 適用条件: 入力データの構造が明確に定義されており、出力がテキストである場合
  - コード例: `drizzle-kit/src/introspect-pg.ts:309` の `schemaToTypeScript` 関数が中間表現を解釈して TypeScript コードを出力する
  - 注意点: 入力の構造が複雑になるほど if-else チェーンが肥大化する（実際に `column` 関数は約 250 行）

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 複数 DB の異なるメタデータ形式を統一的な中間表現に変換する
  - 適用条件: 異なるソースから同一構造のデータを取得する必要がある場合
  - コード例: `drizzle-kit/src/serializer/pgSerializer.ts:968` の `fromDatabase`、`drizzle-kit/src/serializer/mysqlSerializer.ts:564` の `fromDatabase` がそれぞれ DB 固有のクエリ結果を共通形式に変換する
  - 注意点: DB ごとの `fromDatabase` 関数は独立した実装であり、interface による形式的な統一はされていない（暗黙的なプロトコル）

## Good Patterns

- **Zod `.strict()` による中間表現の堅牢性**: 全てのスキーマオブジェクトに `.strict()` を適用し、想定外のフィールドを即座に検出する。中間表現が複数のモジュール間で受け渡される場合、暗黙的なフィールドの追加・脱落を防止する。

```typescript
// drizzle-kit/src/serializer/pgSchema.ts:330-341
const table = object({
  name: string(),
  schema: string(),
  columns: record(string(), column),
  indexes: record(string(), index),
  foreignKeys: record(string(), fk),
  compositePrimaryKeys: record(string(), compositePK),
  uniqueConstraints: record(string(), uniqueConstraint).default({}),
  policies: record(string(), policy).default({}),
  checkConstraints: record(string(), checkConstraint).default({}),
  isRLSEnabled: boolean().default(false),
}).strict();
```

- **使用型のみ import する自動収集**: コード生成時にカラム定義を走査して使用する型名を `Set` に蓄積し、import 文に含める型を最小限にする。生成コードの無駄な依存を排除し、ツリーシェイキングにも有利。

```typescript
// drizzle-kit/src/introspect-pg.ts:329-376
const imports = Object.values(schema.tables).reduce(
  (res, it) => {
    const columnImports = Object.values(it.columns)
      .map((col) => {
        let patched: string = (importsPatch[col.type] || col.type).replace("[]", "");
        // ... normalization ...
        return patched;
      })
      .filter((type) => pgImportsList.has(type));
    res.pg.push(...columnImports);
    return res;
  },
  { pg: [] as string[] },
);
```

- **プログレスコールバックによる段階的フィードバック**: `fromDatabase` がコールバック関数を受け取り、メタデータ取得の進捗を段階的に通知する。長時間処理での UX を改善する軽量なパターン。

```typescript
// drizzle-kit/src/serializer/pgSerializer.ts:979-983
progressCallback?: (
    stage: IntrospectStage,
    count: number,
    status: IntrospectStatus,
) => void,
```

## Anti-Patterns / 注意点

- **DB 別 introspect ファイル間の大量コード重複**: `introspect-pg.ts` (1370 行)、`introspect-mysql.ts` (1031 行)、`introspect-sqlite.ts` (534 行) で `escapeColumnKey`、`withCasing`、`dbColumnName`、`objToStatement2` 等のユーティリティ関数がほぼ同一のコードで繰り返されている。

```typescript
// Bad: 同一ロジックが 5 ファイルにコピーされている
// drizzle-kit/src/introspect-pg.ts:161-166
const escapeColumnKey = (value: string) => {
  if (/^(?![a-zA-Z_$][a-zA-Z0-9_$]*$).+$/.test(value)) {
    return `"${value}"`;
  }
  return value;
};

// drizzle-kit/src/introspect-mysql.ts:104-109 (同一コード)
// drizzle-kit/src/introspect-sqlite.ts:44-49 (同一コード)
// drizzle-kit/src/introspect-gel.ts:63-67 (同一コード)
```

```typescript
// Better: 共通ユーティリティに抽出する
// shared/codegen-utils.ts
export const escapeColumnKey = (value: string) => {
  if (/^(?![a-zA-Z_$][a-zA-Z0-9_$]*$).+$/.test(value)) {
    return `"${value}"`;
  }
  return value;
};
```

- **型マッピングの if-else チェーンの肥大化**: `column` 関数や `mapDefault` 関数で DB 型ごとに if-else チェーンが続き、`introspect-pg.ts` の `column` 関数だけで約 250 行に達する。新しい型の追加時にチェーンの末尾に追加する形になり、見落としやすい。

```typescript
// Bad: 250 行の if-else チェーン (drizzle-kit/src/introspect-pg.ts:838-1101)
const column = (...) => {
    if (lowered.startsWith('serial')) { ... }
    if (lowered.startsWith('smallserial')) { ... }
    if (lowered.startsWith('bigserial')) { ... }
    if (lowered.startsWith('integer')) { ... }
    // ... 20+ more branches
};
```

```typescript
// Better: レジストリパターンで型マッピングを宣言的にする
const pgTypeMappers: Record<string, (name: string, casing: Casing) => string> = {
  serial: (name, casing) => `${withCasing(name, casing)}: serial(${dbColumnName({ name, casing })})`,
  integer: (name, casing) => `${withCasing(name, casing)}: integer(${dbColumnName({ name, casing })})`,
  // ...
};
```

## 導出ルール

- `[MUST]` コード生成パイプラインでは、入力データ（メタデータ）の取得、中間表現への正規化、出力コードの生成を明確に分離する
  - 根拠: drizzle-kit は 5 種類の DB に対して `fromDatabase`（取得+正規化）と `schemaToTypeScript`（生成）を分離しており、DB 追加時にコード生成ロジックの修正がゼロで済む設計になっている

- `[MUST]` コード生成の中間表現にはランタイムバリデーションを付与し、`.strict()` 等で想定外のフィールドを拒否する
  - 根拠: drizzle-kit は全ての中間表現 Zod スキーマに `.strict()` を適用し、マイグレーションファイルの読み込み時やバージョン判定時に破損データを即座に検出している（`pgSchema.ts:330-341`）

- `[SHOULD]` バリデーションスキーマから型を導出し（`z.infer` / `TypeOf`）、スキーマと型の二重管理を避ける
  - 根拠: drizzle-kit は `export type Column = TypeOf<typeof column>` で全型を Zod スキーマから導出しており、スキーマ変更時に型が自動追従する（`pgSchema.ts:511-536`）

- `[SHOULD]` 中間表現にバージョン番号を持たせ、`union` で複数バージョンを受け入れ可能にする
  - 根拠: drizzle-kit は `version: literal('7')` でバージョンを固定し、`backwardCompatiblePgSchema = union([pgSchemaV5, pgSchemaV6, pgSchema])` で後方互換性を維持している（`pgSchema.ts:545-548`）

- `[SHOULD]` ビルド成果物のインポートパス修正には AST 操作を使い、正規表現による文字列置換を避ける
  - 根拠: drizzle-orm の `fix-imports.ts` は recast の visitor パターンで `ImportDeclaration`、`ExportAllDeclaration`、`CallExpression`（require）を網羅的に修正しており、文字列置換では捕捉できない動的 import にも対応している

- `[SHOULD]` `package.json` の `exports` map はファイルシステムの glob から自動生成し、手動管理しない
  - 根拠: drizzle-orm の `build.ts` は `glob('src/**/*.ts')` から exports を自動生成しており、ファイル追加時に exports の更新漏れが起きない（`build.ts:8-44`）

- `[AVOID]` 網羅的な型マッピングを if-else チェーンで実装する際、数十分岐を超える規模に肥大化させる
  - 根拠: drizzle-kit の `column` 関数（`introspect-pg.ts:838-1101`）は約 250 行の if-else チェーンとなっており、新しい型の追加位置が不明確で見落としのリスクがある。レジストリパターンやマップベースのディスパッチの方が保守性が高い

## 適用チェックリスト

- [ ] コード生成パイプラインが「取得 → 正規化 → 生成」の 3 フェーズに分離されているか確認する
- [ ] 中間表現に Zod 等のバリデーションスキーマが定義されており、型がそこから導出されているか確認する
- [ ] 中間表現のバリデーションに `.strict()` が適用されているか確認する
- [ ] 中間表現にバージョン番号があり、後方互換性の仕組み（union / migration）が存在するか確認する
- [ ] ビルドスクリプトでインポートパスを修正している場合、文字列置換ではなく AST 操作を使っているか確認する
- [ ] `package.json` の exports map がファイルシステムから自動生成されているか確認する
- [ ] 型マッピングの if-else チェーンが肥大化していないか確認し、20 分岐を超えたらレジストリパターンへの移行を検討する
