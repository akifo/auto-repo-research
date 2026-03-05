# プロジェクト構造

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

pnpm ワークスペースと Turborepo を組み合わせたモノレポで、ORM コアパッケージ（drizzle-orm）を中心に CLI・バリデーション統合・シード・ESLint プラグインの 9 パッケージを管理する。注目すべきは、drizzle-orm が単一パッケージ内にコア層・4 つの方言コア・20 以上のドライバアダプターを格納する「ファットコアパッケージ」戦略を採用している点で、パッケージ分割の粒度と exports map の設計に独自のプラクティスが見られる。

## 背景にある原則

- **ファットコアに方言とドライバを内包し、サブパスエクスポートで境界を作る**: 方言（pg-core, mysql-core, sqlite-core, singlestore-core）とドライバアダプター（node-postgres, better-sqlite3, d1 等 20+）を個別 npm パッケージに分割せず、単一パッケージの内部ディレクトリとして保持する。ユーザーは `drizzle-orm/node-postgres` のようなサブパスインポートで使い分ける。パッケージ数の爆発を防ぎつつ、ツリーシェイキング可能な構造を維持するため。(`drizzle-orm/package.json` の exports、`drizzle-orm/scripts/build.ts:10-44` で全 `src/**/*.ts` からエクスポートを自動生成)

- **依存の方向を厳格に一方向にし、コアを無依存に保つ**: コア（table.ts, column.ts, sql/）は外部依存を持たず、方言コアはコアのみに依存し、ドライバアダプターは方言コアとサードパーティドライバに依存する。この三層構造で依存の逆流を防止する。(`drizzle-orm/src/node-postgres/driver.ts` が `~/pg-core/db.ts` を参照するが、pg-core は node-postgres を参照しない)

- **ビルド成果物への直接リンクでパッケージ間依存を実現する**: `workspace:./drizzle-orm/dist` や `link:../drizzle-orm/dist` のように dist ディレクトリを直接参照する。通常の `workspace:*` がソースを参照するのに対し、ビルド済み成果物を参照することで、パッケージ消費者と同じ条件（exports map 解決、CJS/ESM 互換）での開発・テストを保証する。(`package.json` 各所、`drizzle-kit/package.json:86`, `drizzle-zod/package.json:74`)

- **Turborepo の依存グラフで全パッケージをコアのビルドに同期させる**: 全パッケージの build タスクが `drizzle-orm#build` に `dependsOn` で接続され、コアのビルドなしに下流パッケージのビルドが走らない。(`turbo.json` で `drizzle-kit#build`, `drizzle-zod#build` 等が全て `drizzle-orm#build` を先行タスクとして指定)

## 実例と分析

### 三層アーキテクチャ: コア / 方言コア / ドライバアダプター

drizzle-orm パッケージ内部は明確な三層に分かれる:

1. **コア層**（`src/` 直下: table.ts, column.ts, column-builder.ts, sql/, relations.ts, entity.ts 等）: SQL 方言に依存しない抽象概念を定義。`Table`, `Column`, `SQL` などの基底クラスがここにある。
2. **方言コア層**（`src/pg-core/`, `src/mysql-core/`, `src/sqlite-core/`, `src/singlestore-core/`）: 方言固有のテーブル・カラム・クエリビルダー・ダイアレクトを定義。コア層の Table/Column を継承して方言固有の機能を追加。
3. **ドライバアダプター層**（`src/node-postgres/`, `src/better-sqlite3/`, `src/d1/` 等 20+ ディレクトリ）: 各ドライバが方言コアの `Dialect` と `Session` を使い、具象接続を提供する。

各ドライバアダプターは統一された構造を持つ: `driver.ts`（接続構築と `drizzle()` ファクトリ関数）、`session.ts`（PreparedQuery と Session の具象実装）、`migrator.ts`（マイグレーション実行）、`index.ts`（公開 API の re-export）。

### ファットパッケージの exports 自動生成

`drizzle-orm/scripts/build.ts` は `src/**/*.ts` を glob で列挙し、package.json の `exports` フィールドを動的に構築する。各エントリに対して ESM（`.js` / `.d.ts`）と CJS（`.cjs` / `.d.cts`）の両方のパスを生成する。この自動化により、20 以上のドライバサブパスを手動管理する負担を排除している。

```typescript
// drizzle-orm/scripts/build.ts:10-44
const entries = await glob('src/**/*.ts');

pkg.exports = entries.reduce<Record<string, {...}>>(
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

### CJS/ESM のインポートパス修正

ビルド後に `scripts/fix-imports.ts` が recast で AST を走査し、CJS ファイルの `.js` → `.cjs`、ESM ファイルのパスエイリアス `~/` → 相対パスの変換を行う。これにより、ソースコードではパスエイリアスで簡潔に書きつつ、出力は正確なモジュール解決が保証される。

```typescript
// drizzle-orm/scripts/fix-imports.ts:8-15
function resolvePathAlias(importPath: string, file: string) {
  if (importPath.startsWith("~/")) {
    const relativePath = path.relative(
      path.dirname(file),
      path.resolve("dist.new", importPath.slice(2)),
    );
    importPath = relativePath.startsWith(".") ? relativePath : "./" + relativePath;
  }
  return importPath;
}
```

### workspace:dist パターンによるパッケージ間参照

通常のモノレポでは `workspace:*` でパッケージのソースを参照するが、drizzle-orm では `workspace:./drizzle-orm/dist` のように dist ディレクトリを直指定する。スキーマ統合パッケージ（drizzle-zod 等）は `link:../drizzle-orm/dist` を使う。

```json
// package.json（ルート）
"drizzle-orm": "workspace:./drizzle-orm/dist"

// drizzle-kit/package.json
"drizzle-orm": "workspace:./drizzle-orm/dist"

// drizzle-zod/package.json
"drizzle-orm": "link:../drizzle-orm/dist"
```

これにより開発時にもパッケージ消費者と同一の exports map 解決パスが再現され、「開発環境では動くがパブリッシュ後に壊れる」問題を防止する。

### バリデーション統合パッケージの同構造パターン

drizzle-zod, drizzle-typebox, drizzle-valibot, drizzle-arktype の 4 パッケージは完全に同一のファイル構造を持つ:

```
src/
├── column.ts
├── column.types.ts
├── constants.ts
├── index.ts
├── schema.ts
├── schema.types.internal.ts
├── schema.types.ts
└── utils.ts
```

package.json のスクリプト構成（build, test, test:types, pack, publish）と exports map も同一パターン。異なるのは peerDependencies（zod, @sinclair/typebox, valibot, arktype）のみ。バリデーションライブラリごとにパッケージを分離することで、ユーザーは必要なバリデーションライブラリだけを依存に追加できる。

### 統合テストの共通化パターン

`integration-tests/tests/pg/` では `pg-common.ts` に DB 方言の共通テスト関数群を定義し、各ドライバのテストファイル（`node-postgres.test.ts`, `pglite.test.ts` 等）がそれをインポートして実行する。Docker でデータベースを起動し、ドライバ固有のセットアップのみをテストファイルに記述する。

```typescript
// integration-tests/tests/pg/node-postgres.test.ts:11
import { createDockerDB, tests, usersMigratorTable, usersTable } from "./pg-common";
```

### entityKind による instanceof 代替とカスタム ESLint ルール

`entity.ts` で定義された `entityKind` Symbol を使い、`is()` 関数が `instanceof` の代わりにプロトタイプチェーンを辿る型判定を行う。`eslint/eslint-plugin-drizzle-internal` が `require-entity-kind` ルールで全クラスに `static readonly [entityKind]` の宣言を強制する。

```typescript
// drizzle-orm/src/entity.ts:1
export const entityKind = Symbol.for("drizzle:entityKind");

// drizzle-orm/src/entity.ts:12-42
export function is<T extends DrizzleEntityClass<any>>(value: any, type: T): value is InstanceType<T> {
  // ...
  let cls = Object.getPrototypeOf(value).constructor;
  if (cls) {
    while (cls) {
      if (entityKind in cls && cls[entityKind] === type[entityKind]) {
        return true;
      }
      cls = Object.getPrototypeOf(cls);
    }
  }
  return false;
}
```

ESLint ルールがクラス宣言を検査し、`entityKind` プロパティがなければエラーを報告する:

```javascript
// eslint/eslint-plugin-drizzle-internal/index.js:7
'require-entity-kind': ESLintUtils.RuleCreator(...)({
  // ...
  messages: {
    missingEntityKind:
      "Class '{{name}}' doesn't have a static readonly [entityKind] property...",
  },
})
```

## パターンカタログ

- **Abstract Factory** (生成)
  - 解決する問題: 同一インターフェースで異なるデータベース接続を構築する
  - 適用条件: 複数のドライバが同じ方言コアの Dialect/Session を共有する場合
  - コード例: 各ドライバの `drizzle()` ファクトリ関数 (`node-postgres/driver.ts:91`, `neon-http/driver.ts:171`, `better-sqlite3/driver.ts:68`)
  - 注意点: 各ファクトリ関数は内部で `construct()` ヘルパーを呼ぶ二段構成で、オーバーロード解決を construct に委譲している

- **Template Method** (振る舞い)
  - 解決する問題: 方言間で共通のクエリ構築フローを維持しつつ、SQL 生成の詳細を方言ごとに変える
  - 適用条件: 複数の SQL 方言を単一フレームワークでサポートする場合
  - コード例: `PgDialect` / `MySqlDialect` / `SQLiteSyncDialect` / `SingleStoreDialect` が各自の dialect.ts で SQL 構築メソッドを実装 (`pg-core/dialect.ts`, `mysql-core/dialect.ts`, `sqlite-core/dialect.ts`)
  - 注意点: 方言コア間でのコード共有はなく、各 dialect.ts は独立して実装されている（1445/1169/926/834 行）

- **Adapter** (構造)
  - 解決する問題: サードパーティドライバの API 差異を方言コアの Session インターフェースに合わせる
  - 適用条件: 同一 SQL 方言に対して複数のドライバライブラリが存在する場合
  - コード例: `NodePgSession extends PgSession` (`node-postgres/session.ts`), `NeonHttpSession extends PgSession` (`neon-http/session.ts`)
  - 注意点: 各ドライバの session.ts は PgPreparedQuery / PgSession を継承し、execute/all/values の具象実装のみを提供する

## Good Patterns

- **サブパスエクスポートで仮想的なパッケージ境界を作る**: 20 以上のドライバを個別 npm パッケージに分割せず、`drizzle-orm/node-postgres`, `drizzle-orm/pg-core` のようなサブパスで公開する。npm パッケージの管理負荷（バージョニング、リリース、依存解決）を単一パッケージに集約しつつ、消費者にはモジュールレベルの粒度を提供する。
  ```typescript
  // ユーザーコード
  import { drizzle } from "drizzle-orm/node-postgres";
  import { pgTable, serial, text } from "drizzle-orm/pg-core";
  ```

- **ビルド成果物リンクで「消費者と同じ条件」のモノレポ開発**: `workspace:./drizzle-orm/dist` や `link:../drizzle-orm/dist` でビルド成果物を参照することで、exports map の解決パスが開発時とパブリッシュ後で一致する。
  ```json
  // drizzle-kit/package.json
  { "drizzle-orm": "workspace:./drizzle-orm/dist" }
  ```

- **テンプレート化されたバリデーション統合パッケージ**: 同一のファイル構成（column.ts, schema.ts, utils.ts 等 8 ファイル）を 4 つのバリデーション統合パッケージで再利用。新しいバリデーションライブラリの統合を追加する際、既存パッケージをコピーして対応箇所を書き換えるだけで済む。

- **カスタム ESLint ルールで設計規約を機械的に強制する**: `require-entity-kind` ルールにより、全クラスが `entityKind` プロパティを持つことをビルド時に保証。人間の注意力に頼らず、規約違反をコンパイル前に検出する。

## Anti-Patterns / 注意点

- **方言コア間のコード重複**: pg-core (11,402行), mysql-core (8,612行), sqlite-core (7,296行), singlestore-core (8,042行) は各自が独立した dialect.ts, session.ts, query-builders/ を持ち、共通基底クラスからの差分実装ではなく、大部分がコピーベースで実装されている。方言間で共通のロジック（リレーショナルクエリ構築、エイリアス処理等）が各 dialect.ts に重複している。

  Bad: 各方言の dialect.ts が独立して `buildRelationalQuery` 等の複雑なメソッドを個別実装
  ```
  pg-core/dialect.ts     : 1445 行
  mysql-core/dialect.ts  : 1169 行
  sqlite-core/dialect.ts :  926 行
  singlestore-core/dialect.ts: 834 行
  ```

  Better: 共通ロジックを基底 Dialect クラスに抽出し、方言固有の差分のみをオーバーライドする（ただし SQL 方言の差異が大きい場合、過度な抽象化は可読性を損なう場合もあるため、トレードオフの判断が必要）

- **ファットパッケージによるインストールサイズの肥大化**: 全ドライバ・全方言が単一パッケージに含まれるため、PostgreSQL しか使わないユーザーも MySQL/SQLite 関連のコードを含むパッケージをインストールすることになる。バンドルサイズにはツリーシェイキングで対応できるが、npm install 時のサイズには影響する。

## 導出ルール

- `[MUST]` モノレポでパッケージ間の依存方向を単一方向に保ち、コアパッケージが下流パッケージを参照しない構造にする
  - 根拠: drizzle-orm のコア層（table.ts, column.ts, sql/）は方言コアやドライバを一切 import しない。pg-core は node-postgres を参照しない。この厳格な方向性により、コアの変更が局所的な影響に留まる (`drizzle-orm/src/` 全体の import 方向)

- `[MUST]` Turborepo 等のタスクランナーで、コアパッケージのビルドを全下流パッケージの先行タスクとして設定する
  - 根拠: `turbo.json` で全パッケージの build が `drizzle-orm#build` に依存し、コアのビルドなしに下流パッケージがビルドされない保証を作っている (`turbo.json:4-253`)

- `[SHOULD]` サブパスエクスポートによりパッケージ分割を代替する（同一パッケージ内で論理的な境界を提供する）
  - 根拠: 20 以上のドライバアダプターを個別パッケージにせず、`drizzle-orm/<driver>` 形式のサブパスで公開。バージョン同期の負荷を排除しつつ、消費者には明確な API 境界を提供する (`drizzle-orm/scripts/build.ts` の exports 自動生成)

- `[SHOULD]` モノレポ内のパッケージ間参照はビルド成果物（dist ディレクトリ）を対象にし、ソースコード直参照を避ける
  - 根拠: `workspace:./drizzle-orm/dist` パターンにより、開発時もパブリッシュ後と同じ exports map 解決を再現し、「開発時だけ動く」問題を防止する (`drizzle-kit/package.json:86`, `drizzle-zod/package.json:74`)

- `[SHOULD]` 設計規約をカスタム ESLint ルールで機械的に強制する（ドキュメントやコードレビューに頼らない）
  - 根拠: `eslint-plugin-drizzle-internal` の `require-entity-kind` ルールが全クラスの `entityKind` 宣言を強制し、`is()` 関数の正常動作を保証する (`eslint/eslint-plugin-drizzle-internal/index.js:7`)

- `[SHOULD]` 統合テストの共通ロジックを共有モジュールに抽出し、ドライバ固有のセットアップのみを各テストファイルに残す
  - 根拠: `pg-common.ts` が PostgreSQL 方言の全テストケースを定義し、node-postgres/pglite/neon 等の各テストファイルは DB 接続のセットアップだけを行う (`integration-tests/tests/pg/pg-common.ts`, `integration-tests/tests/pg/node-postgres.test.ts:11`)

- `[AVOID]` モノレポ内の同種パッケージ群（バリデーション統合等）で構造を個別に設計する — テンプレート化して統一する
  - 根拠: drizzle-zod/typebox/valibot/arktype が完全に同一のファイル構成（8 ファイル）を持ち、新規追加時のコストを最小化している

## 適用チェックリスト

- [ ] 単一パッケージ内に多数のサブモジュールがある場合、サブパスエクスポート（package.json `exports` フィールド）で論理的な境界を作っているか
- [ ] exports map の生成を自動化しているか（手動管理はエントリ追加時のミスを招く）
- [ ] パッケージ間の依存方向が一方向になっているか（循環依存やコアから下流への参照がないか）
- [ ] Turborepo 等のタスクランナーで、依存パッケージのビルド順序を正しく設定しているか
- [ ] モノレポ内パッケージの相互参照で、ソースではなくビルド成果物を参照しているか（exports map 解決の整合性）
- [ ] CJS/ESM デュアルパブリッシュのインポートパス（拡張子）が正しいか — ビルド後の自動修正を導入しているか
- [ ] 同種のパッケージ群が統一されたファイル構成・スクリプト構成を持っているか
- [ ] 設計上の規約（型タグ、命名規則等）が ESLint カスタムルールやビルド時チェックで機械的に検証されているか
- [ ] 統合テストの共通ロジックが共有モジュールに抽出され、ドライバ固有の部分だけが各テストファイルに残っているか
