# API 設計プラクティス

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

drizzle-orm は単一パッケージ内で 20 以上のデータベースドライバ・5 つの SQL 方言をサポートしながら、公開 API 表面を統制された状態に保っている。444 の TypeScript ソースファイルが存在するが、ビルドスクリプトによる自動 exports map 生成、3 層のサブパスエクスポート構造、Symbol ベースの内部 API 隠蔽により、ユーザが触れる API は最小限に制御されている。特にマルチエントリポイント設計と CJS/ESM デュアル出力の自動化手法は、大規模ライブラリの API 管理における実用的なリファレンスとなる。

## 背景にある原則

- **Flat-file exports map の自動生成で API 表面を機械的に管理すべき**: 手動で package.json の exports を管理すると、ファイル追加・削除時の不整合が不可避になる。drizzle-orm は `scripts/build.ts` で `src/**/*.ts` を glob し、exports map を自動生成することでこの問題を排除している（`scripts/build.ts:8-44`）。
- **公開/内部の境界は言語機構（Symbol・declare）で強制すべき**: JSDoc の `@internal` だけでは実行時のアクセスを防げない。drizzle-orm は `Symbol.for('drizzle:...')` でプロパティキーを隠蔽し、`declare readonly _:` で型情報のみの存在を示すことで、IDE のオートコンプリートとバンドルサイズの両方を制御している（`entity.ts:1-2`, `table.ts:20-40`）。
- **ドライバ層と方言層を分離し、サブパスエクスポートで独立させるべき**: 方言固有の型や関数（`pg-core/`, `mysql-core/`）とドライバ固有のコード（`node-postgres/`, `postgres-js/`）を別サブパスにすることで、ユーザは自分が使うドライバだけを import でき、不要な peer dependency を読み込まない。
- **ファクトリ関数のオーバーロードで段階的な使いやすさを提供すべき**: 各ドライバの `drizzle()` 関数は文字列・クライアントインスタンス・設定オブジェクトの 3 形式を受け付ける。初心者は `drizzle("postgres://...")` で始め、上級者は細かい設定を渡せる（`node-postgres/driver.ts:91-140`）。

## 実例と分析

### 自動生成される exports map

ビルドスクリプト `scripts/build.ts` は `src/**/*.ts` を glob し、各ファイルに対して ESM/CJS/型定義の 4 パスを持つ exports エントリを生成する。

```typescript
// scripts/build.ts:10-44
const entries = await glob('src/**/*.ts');

pkg.exports = entries.reduce<Record<string, { import: {...}; require: {...}; default: string; types: string }>>(
  (acc, rawEntry) => {
    const entry = rawEntry.match(/src\/(.*)\.ts/)![1]!;
    const exportsEntry = entry === 'index' ? '.' : './' + entry.replace(/\/index$/, '');
    acc[exportsEntry] = {
      import: { types: `./${entry}.d.ts`, default: `./${entry}.js` },
      require: { types: `./${entry}.d.cts`, default: `./${entry}.cjs` },
      types: `./${entry}.d.ts`,
      default: `./${entry}.js`,
    };
    return acc;
  },
  {},
);
```

この設計により、新規ドライバやモジュールの追加は `src/` 配下にファイルを置くだけで自動的に exports に含まれる。削除も同様。

### 3 層のサブパスエクスポート構造

drizzle-orm のサブパスは以下の 3 層に分かれる。

1. **コアレイヤー** (`drizzle-orm`): `src/index.ts` が re-export する共通型・ユーティリティ（`Table`, `Column`, `SQL`, `relations` 等）
2. **方言レイヤー** (`drizzle-orm/pg-core`, `drizzle-orm/mysql-core`, `drizzle-orm/sqlite-core`): SQL 方言ごとのスキーマ定義・クエリビルダー・型
3. **ドライバレイヤー** (`drizzle-orm/node-postgres`, `drizzle-orm/postgres-js`, `drizzle-orm/neon-http` 等): 具体的なクライアントライブラリとの接続コード

ユーザの典型的な import パターン:

```typescript
// コアレイヤーから共通ユーティリティ
import { eq, sql } from "drizzle-orm";
// 方言レイヤーからスキーマ定義
import { integer, pgTable, text } from "drizzle-orm/pg-core";
// ドライバレイヤーからファクトリ関数
import { drizzle } from "drizzle-orm/node-postgres";
```

### Symbol ベースの内部 API 隠蔽

drizzle-orm は `Symbol.for('drizzle:...')` を 27 箇所以上で使用し、クラスの内部プロパティを隠蔽している。

```typescript
// src/table.ts:20-40
/** @internal */
export const Schema = Symbol.for("drizzle:Schema");
/** @internal */
export const Columns = Symbol.for("drizzle:Columns");
/** @internal */
export const OriginalName = Symbol.for("drizzle:OriginalName");
/** @internal */
export const BaseName = Symbol.for("drizzle:BaseName");
/** @internal */
export const IsAlias = Symbol.for("drizzle:IsAlias");
```

これらの Symbol は `Table.Symbol` 名前空間にまとめられ、内部コードからは `table[Table.Symbol.Columns]` のようにアクセスする。ユーザの IDE には通常のプロパティとして表示されないため、内部 API の誤使用を防止する。

`Symbol.for` を使う理由は、異なるバージョンの drizzle-orm が共存する場合でも同一 Symbol を参照できるようにするためである（`entity.ts` の `is()` 関数がこれに依存）。

### `declare readonly _:` による型情報のみのプロパティ

```typescript
// src/table.ts:52-60
declare readonly _: {
  readonly brand: 'Table';
  readonly config: T;
  readonly name: T['name'];
  readonly schema: T['schema'];
  readonly columns: T['columns'];
  readonly inferSelect: InferSelectModel<Table<T>>;
  readonly inferInsert: InferInsertModel<Table<T>>;
};
```

`declare` により実行時には存在せず、型レベルでのみ利用可能。これは TypeScript のブランド型・phantom type として機能し、ジェネリクスの型推論に使われる。公開 API（`$inferSelect`, `$inferInsert`）とは別に存在し、内部的な型計算に使われる。

### `$` プレフィックスによる拡張 API の名前空間化

```typescript
// src/pg-core/db.ts:125,150
$with: WithBuilder = (alias: string, selection?: ColumnsSelection) => { ... };
$count(source: PgTable | PgViewBase | SQL | SQLWrapper, filters?: SQL<unknown>) { ... }
```

`$with`, `$count`, `$inferSelect`, `$inferInsert`, `$client`, `$primary`, `$replicas` など、`$` プレフィックスは「SQL の標準語彙ではないが drizzle-orm が提供する拡張機能」を示す命名規約として一貫している。

### 統一ファクトリ関数パターン

全ドライバで `drizzle()` 関数が 3 つのオーバーロードシグネチャを持つ。

```typescript
// src/node-postgres/driver.ts:91-113
export function drizzle<TSchema, TClient>(
  ...params:
    | [TClient | string]                              // 最小: 接続文字列のみ
    | [TClient | string, DrizzleConfig<TSchema>]      // クライアント + 設定
    | [DrizzleConfig<TSchema> & ({ client: TClient } | { connection: string | PoolConfig })]  // 統合設定
): NodePgDatabase<TSchema> & { $client: ... }
```

`isConfig()` ヘルパー（`utils.ts:286-338`）で第一引数がクライアントインスタンスか設定オブジェクトかを判定する。各ドライバの `drizzle()` は内部で `construct()` を呼び出し、Dialect → Driver → Session → Database の組み立てチェーンを実行する。

### HKT（Higher-Kinded Types）によるドライバ固有の結果型

```typescript
// src/pg-core/session.ts:284-292
export interface PgQueryResultHKT {
  readonly $brand: "PgQueryResultHKT";
  readonly row: unknown;
  readonly type: unknown;
}
export type PgQueryResultKind<TKind extends PgQueryResultHKT, TRow> = (TKind & { readonly row: TRow; })["type"];

// src/node-postgres/session.ts:304
export interface NodePgQueryResultHKT extends PgQueryResultHKT {
  readonly type: QueryResult<Assume<this["row"], QueryResultRow>>;
}
```

TypeScript には HKT がないため、intersection + indexed access 型でエミュレートしている。これにより方言層はドライバ固有の結果型を知らずにジェネリックなクエリビルダーを提供できる。

## コード例

```typescript
// scripts/build.ts:1-46 — exports map の自動生成
// tsup でソースを CJS/ESM にビルドし、tsc で型定義を生成した後、
// glob したファイルパスから exports map を構築して dist/package.json に書き出す。
```

```typescript
// src/entity.ts:1-42 — Symbol ベースの型識別
export const entityKind = Symbol.for("drizzle:entityKind");
export function is<T extends DrizzleEntityClass<any>>(value: any, type: T): value is InstanceType<T> {
  if (!value || typeof value !== "object") return false;
  if (value instanceof type) return true;
  // ...prototype chain traversal using entityKind Symbol
}
```

```typescript
// src/utils.ts:174-176 — 型レベルエラーメッセージ
export interface DrizzleTypeError<T extends string> {
  $drizzleTypeError: T;
}
```

## パターンカタログ

- **Abstract Factory** (分類: 生成)
  - 解決する問題: 同一インターフェースで異なるデータベースドライバを生成する
  - 適用条件: 複数の具象実装が同じ抽象プロトコルに従う場合
  - コード例: `src/node-postgres/driver.ts:49-89` の `construct()` + `drizzle()` ペア
  - 注意点: 各ドライバで `construct()` が重複するが、ドライバ固有の初期化ロジック（例: postgres-js のパーサーオーバーライド）があるため完全な共通化は困難

- **Higher-Kinded Type Emulation** (分類: 構造)
  - 解決する問題: TypeScript でジェネリクスの型引数にジェネリック型を渡せない制約の回避
  - 適用条件: 方言/ドライバ層でクエリ結果型を抽象化したい場合
  - コード例: `src/pg-core/session.ts:284-292`, `src/node-postgres/session.ts:304`
  - 注意点: intersection + indexed access の組み合わせは可読性が低い。コメントによる意図説明が必須

- **Phantom Type / Brand Type** (分類: 構造)
  - 解決する問題: 構造的に同一だが意味的に異なる型を区別する
  - 適用条件: 型安全性を実行時コストなしで強制したい場合
  - コード例: `src/table.ts:52-60` の `declare readonly _:`, `src/subquery.ts:18-25` の `brand: 'Subquery'`
  - 注意点: `declare` プロパティは実行時に存在しないため、ランタイムで型チェックが必要な場合は `entityKind` Symbol を併用する

## Good Patterns

- **Build-time exports map generation**: ソースファイルの glob から package.json の exports を自動生成する。手動管理による不整合（ファイル追加忘れ、パス typo）を構造的に排除する。

```typescript
// scripts/build.ts:8-44
const entries = await glob("src/**/*.ts");
pkg.exports = entries.reduce((acc, rawEntry) => {
  const entry = rawEntry.match(/src\/(.*)\.ts/)![1]!;
  const exportsEntry = entry === "index" ? "." : "./" + entry.replace(/\/index$/, "");
  // ... CJS/ESM/types の4パスを生成
  return acc;
}, {});
```

- **AST-based import rewriting**: CJS 出力で `.ts` → `.cjs` への import パス変換を文字列置換ではなく AST（recast）で行う。正規表現では壊れるエッジケース（文字列リテラル内のパス等）を安全に処理する。

```typescript
// scripts/fix-imports.ts:29-53
const code = parse(await fs.readFile(file, "utf8"), { parser });
visit(code, {
  visitImportDeclaration(path) {
    path.value.source.value = fixImportPath(path.value.source.value, file, ".cjs");
    this.traverse(path);
  },
  // ... visitExportAllDeclaration, visitCallExpression (require) 等
});
```

- **Type-level error messages**: `DrizzleTypeError<T>` インターフェースにより、型エラー時にユーザに具体的なメッセージを提示する。

```typescript
// src/utils.ts:174-176
export interface DrizzleTypeError<T extends string> {
  $drizzleTypeError: T;
}
// 使用例: src/pg-core/db.ts:50-52
query: TFullSchema extends Record<string, never>
  ? DrizzleTypeError<'Seems like the schema generic is missing - did you forget to add it to your DB type?'>
  : { [K in keyof TSchema]: RelationalQueryBuilder<...> };
```

- **Progressive disclosure via factory overloads**: 1 引数（接続文字列のみ）から始めて段階的に設定を追加できるファクトリ関数。

```typescript
// 最小限（初心者向け）
const db = drizzle("postgres://localhost:5432/mydb");
// クライアント + 設定（中級者向け）
const db = drizzle(pool, { schema, logger: true });
// 統合設定オブジェクト（上級者向け）
const db = drizzle({ client: pool, schema, casing: "snake_case" });
```

## Anti-Patterns / 注意点

- **全ファイルをサブパスエクスポートにする over-exposure**: drizzle-orm は `src/**/*.ts` の全ファイルを exports map に含めるため、内部ユーティリティ（`tracing-utils.ts`, `selection-proxy.ts` 等）もサブパスとして公開される。ユーザがこれらを import して内部 API に依存するリスクがある。

```typescript
// Bad: 全ファイル公開
const entries = await glob('src/**/*.ts');
// このアプローチでは src/tracing-utils.ts も drizzle-orm/tracing-utils で公開される

// Better: 公開対象を明示的に管理する
const publicEntries = ['index.ts', 'pg-core/index.ts', 'node-postgres/index.ts', ...];
// または除外パターンで内部モジュールを排除
const entries = await glob('src/**/*.ts', { ignore: ['src/**/internal/**'] });
```

- **`isConfig()` の脆弱なダックタイピング**: `drizzle()` のオーバーロード解決で、第一引数がクライアントか設定かを `constructor.name === 'Object'` とプロパティ存在チェックで判定している。カスタムクラスやプロキシオブジェクトで誤判定する可能性がある。

```typescript
// Bad: src/utils.ts:286-290
export function isConfig(data: any): boolean {
  if (typeof data !== 'object' || data === null) return false;
  if (data.constructor.name !== 'Object') return false;
  // ...

// Better: 明示的なディスクリミネータプロパティを使う
interface DrizzleConfig { __drizzleConfig: true; ... }
```

## 導出ルール

- `[MUST]` マルチエントリポイントの package.json exports map はビルドスクリプトで自動生成する。手動管理はファイル追加時の不整合を招く
  - 根拠: `scripts/build.ts` が `src/**/*.ts` から exports map を自動構築し、CJS/ESM/型定義の 4 パスを一括生成している
- `[MUST]` CJS/ESM デュアルパッケージでは import パスの拡張子変換に AST ベースのリライトを使う。正規表現による文字列置換は壊れやすい
  - 根拠: `scripts/fix-imports.ts` が recast で CJS ファイルの import/require/export パスを `.cjs` に変換している
- `[SHOULD]` ライブラリの内部プロパティは `Symbol.for('namespace:key')` で定義し、通常のプロパティ列挙やオートコンプリートから隠蔽する。`Symbol.for` を使うことでパッケージの複数バージョン共存時にも同一性を保証できる
  - 根拠: `entity.ts`, `table.ts` 等で 27 以上の `Symbol.for('drizzle:...')` が内部プロパティキーとして使われている
- `[SHOULD]` TypeScript ライブラリで型エラー時のユーザ体験を改善するには、条件型の分岐で `never` の代わりにエラーメッセージを含むブランド型を返す
  - 根拠: `DrizzleTypeError<T>` インターフェースが `pg-core/db.ts`, `sqlite-core/query-builders/delete.ts` 等で使われ、IDE 上に具体的なエラーメッセージを表示する
- `[SHOULD]` ファクトリ関数は段階的開示（progressive disclosure）のために複数のオーバーロードを提供する。最小シグネチャ（接続文字列のみ）から最大シグネチャ（全設定オブジェクト）まで
  - 根拠: 全ドライバの `drizzle()` 関数が 3 形式のオーバーロードで、初心者から上級者までの段階的な利用を可能にしている
- `[SHOULD]` `$` プレフィックスでフレームワーク拡張 API をドメイン語彙と区別する。ユーザ定義の名前空間との衝突を避けつつ、IDE 上での視認性を確保する
  - 根拠: `$with`, `$count`, `$inferSelect`, `$client`, `$primary` 等が一貫して `$` で始まる
- `[AVOID]` 全ソースファイルを無条件に exports map に含める設計。内部ユーティリティが公開 API 扱いになり、semver 管理が困難になる
  - 根拠: `src/**/*.ts` の glob で `tracing-utils.ts`, `selection-proxy.ts` 等の内部モジュールもサブパスとして公開されている

## 適用チェックリスト

- [ ] package.json の exports map をビルドスクリプトで自動生成しているか（または生成を検討したか）
- [ ] CJS/ESM デュアル出力時に import パスの拡張子変換を正しく処理しているか
- [ ] 内部 API と公開 API の境界が明確に定義されているか（Symbol, `@internal`, 命名規約のいずれか）
- [ ] exports map に含まれるサブパスが意図的に選定されているか（内部モジュールの除外）
- [ ] ファクトリ関数やコンストラクタが段階的開示を提供しているか（最小限の引数で動作し、必要に応じて設定を追加可能）
- [ ] 型レベルでのエラーメッセージが `never` の代わりに具体的なメッセージを含んでいるか
- [ ] `$` や `_` 等のプレフィックス規約がプロジェクト全体で一貫しているか
