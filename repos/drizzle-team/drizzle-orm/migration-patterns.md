# migration-patterns

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

drizzle-kit のマイグレーションパイプラインを分析した。TypeScript スキーマ定義から SQL マイグレーションファイルを生成するまでの全フローは、**Serialize → Snapshot JSON → Squash → Diff → JSON Statements → SQL** という明確なステージに分離されている。各ステージが独立した中間表現（IR）を持つことで、4 つのデータベース方言（PostgreSQL / MySQL / SQLite / SingleStore）を同一パイプラインで処理できる設計になっている。この多段 IR パイプラインと、スナップショットのバージョン管理戦略が特に注目に値する。

## 背景にある原則

- **中間表現の段階的変換で方言差を吸収する**: TypeScript スキーマをいきなり SQL に変換せず、JSON スナップショット → squashed 表現 → JSON ステートメント → SQL 文字列と段階的に変換することで、方言固有の分岐を最終段（SQL 生成）に集約している。共通ロジック（差分検出、ステートメント構築）は方言に依存しない形で再利用される（`snapshotsDiffer.ts`, `jsonStatements.ts`）。

- **スナップショットを信頼の源泉とする**: マイグレーションの差分計算は、DB の現在の状態ではなく、JSON スナップショットファイル（`meta/XXXX_snapshot.json`）を基準に行う。これにより、手動の DB 変更や環境差異に左右されず、再現可能な差分を生成できる。`preparePrevSnapshot` 関数がスナップショットチェーンの先頭を解決し、`dryPg` 等の空スキーマをフォールバックとする設計が根拠である（`migrationPreparator.ts:198-208`）。

- **Squash による比較可能性の担保**: 構造化された JSON スキーマをそのまま比較するのではなく、インデックス・FK・PK 等の複合オブジェクトを文字列にシリアライズ（squash）してから `json-diff` にかける。これにより、ネストの深い構造の差分検出が名前ベースの単純な文字列比較に帰着する（`PgSquasher.squashIdx`, `squashFK` 等）。

- **Zod スキーマによるバージョン境界の強制**: スナップショットの各バージョン（v1〜v7）を Zod リテラル型で定義し、`backwardCompatiblePgSchema = union([v5, v6, v7])` のように明示的なバージョンゲートを設ける。パースに成功したバージョンに応じて `updateUpToV7` 等のマイグレーション関数を適用することで、古いスナップショットを安全にアップグレードできる（`pgSchema.ts:545-549`）。

## 実例と分析

### パイプライン全体のフロー

`drizzle-kit generate` コマンドの実行パスを追跡すると、以下の 6 ステージが浮かび上がる。

**Stage 1: Import & Serialize** — TypeScript スキーマファイルを動的インポートし、ORM のテーブル/カラム/インデックス定義オブジェクトを走査して JSON スナップショットを生成する。`serializer/index.ts` の `serializePg` が起点で、`pgImports.ts` で `prepareFromPgImports` によりファイルを読み込み、`pgSerializer.ts` の `generatePgSnapshot` で JSON 化する。

**Stage 2: Snapshot Management** — `migrationPreparator.ts` が前回スナップショット（`meta/` ディレクトリの最新 JSON）と今回のシリアライズ結果を `{ prev, cur }` のペアにする。初回は `dryPg`（空スキーマ）がフォールバックとなる。各スナップショットには `id` / `prevId` の UUID チェーンが付与される。

**Stage 3: Squash** — `squashPgScheme` がスナップショットの構造化オブジェクトを文字列にフラット化する。例えばインデックスは `"name;col1--true--true--last--;false;false;btree;undefined;undefined"` のようなセミコロン区切り文字列になる。

**Stage 4: Diff** — `snapshotsDiffer.ts` の `applyPgSnapshotsDiff` が、squash 済みの prev/cur を `json-diff` ライブラリで比較する。テーブル・カラム・列挙型・シーケンス・ビュー等の追加/削除/変更を検出し、リネーム解決のためにリゾルバー関数（`schemasResolver`, `tablesResolver`, `columnsResolver` 等）を呼び出す。

**Stage 5: JSON Statements** — 差分結果から `JsonStatement` 配列を構築する。`jsonStatements.ts` に定義された `prepareCreateTableJson`, `prepareRenameColumnJson` 等の関数群が、方言非依存の中間ステートメントを生成する。

**Stage 6: SQL Generation** — `sqlgenerator.ts` の `fromJson` 関数が、`JsonStatement` 配列を受け取り、登録済みの `Convertor` インスタンスから対応する変換器を選択して SQL 文字列を生成する。

### Squash/Unsquash の双方向変換

`PgSquasher` は squash（構造体 → 文字列）と unsquash（文字列 → 構造体）の双方向変換を提供する。squash は差分比較用、unsquash は SQL 生成時に構造体に復元するために使われる。

さらに、`push` モード（ライブ DB への直接適用）では `squashIdxPush` / `unsquashIdxPush` のように別の squash 関数が使い分けられる。push モードでは `concurrently` フラグ等の一部フィールドを除外し、比較の粒度を調整している。

### DB → TypeScript コード生成（Introspect）

パイプラインは逆方向にも動作する。`pgPushIntrospect` → `fromDatabase`（`pgSerializer.ts:968`）が SQL クエリでスキーマ情報を取得し、`PgSchemaInternal` 型の JSON を生成する。その後 `introspect-pg.ts` の `schemaToTypeScript` が JSON から TypeScript コード（`pgTable`, `pgEnum` 等の呼び出し）を文字列として組み立てる。

この逆方向も同じ JSON スナップショット形式を経由するため、introspect 結果と generate 結果の比較が可能になっている。

### スナップショットバージョンの自動アップグレード

`utils.ts` の `validateWithReport` がスナップショットのバージョンを検査し、古いバージョンが検出された場合は `drizzle-kit up` コマンドを促す。`pgUp.ts` の `updateUpToV6` / `updateUpToV7` がバージョン間の構造変換を実行する（テーブルキーの `name` → `schema.name` 化、カラムインデックスの文字列配列 → オブジェクト配列化など）。

## コード例

```typescript
// drizzle-kit/src/serializer/index.ts:28-43
export const serializePg = async (
	path: string | string[],
	casing: CasingType | undefined,
	schemaFilter?: string[],
): Promise<PgSchemaInternal> => {
	const filenames = prepareFilenames(path);
	const { prepareFromPgImports } = await import('./pgImports');
	const { generatePgSnapshot } = await import('./pgSerializer');
	const { tables, enums, schemas, sequences, views, matViews, roles, policies } = await prepareFromPgImports(
		filenames,
	);
	return generatePgSnapshot(tables, enums, schemas, sequences, roles, policies, views, matViews, casing, schemaFilter);
};
```

```typescript
// drizzle-kit/src/serializer/pgSchema.ts:551-560
// Squash: 構造化インデックスをセミコロン区切り文字列に変換
export const PgSquasher = {
	squashIdx: (idx: Index) => {
		index.parse(idx);
		return `${idx.name};${
			idx.columns
				.map(
					(c) => `${c.expression}--${c.isExpression}--${c.asc}--${c.nulls}--${c.opclass ? c.opclass : ''}`,
				)
				.join(',,')
		};${idx.isUnique};${idx.concurrently};${idx.method};${idx.where};${JSON.stringify(idx.with)}`;
	},
```

```typescript
// drizzle-kit/src/sqlgenerator.ts:151-161
// Strategy パターン: 各 Convertor が can/convert で型+方言のマッチングを行う
abstract class Convertor {
	abstract can(
		statement: JsonStatement,
		dialect: Dialect,
	): boolean;
	abstract convert(
		statement: JsonStatement,
		json2?: SQLiteSchemaSquashed,
		action?: 'push',
	): string | string[];
}
```

```typescript
// drizzle-kit/src/sqlgenerator.ts:4122-4144
// Chain of Responsibility: 登録済み Convertor から最初にマッチしたものを使用
export function fromJson(
	statements: JsonStatement[],
	dialect: Dialect,
	action?: 'push',
	json2?: SQLiteSchemaSquashed,
) {
	const result = statements
		.flatMap((statement) => {
			const filtered = convertors.filter((it) => {
				return it.can(statement, dialect);
			});
			const convertor = filtered.length === 1 ? filtered[0] : undefined;
			if (!convertor) {
				return '';
			}
			return convertor.convert(statement, json2, action);
		})
		.filter((it) => it !== '');
	return result;
}
```

```typescript
// drizzle-kit/src/migrationPreparator.ts:198-208
// スナップショットチェーンの解決: 空なら初期状態にフォールバック
const preparePrevSnapshot = (snapshots: string[], defaultPrev: any) => {
	let prevSnapshot: any;
	if (snapshots.length === 0) {
		prevSnapshot = defaultPrev;
	} else {
		const lastSnapshot = snapshots[snapshots.length - 1];
		prevSnapshot = JSON.parse(fs.readFileSync(lastSnapshot).toString());
	}
	return prevSnapshot;
};
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 同一の JSON ステートメントに対して、方言ごとに異なる SQL 文を生成する必要がある
  - 適用条件: 変換ルールが方言 x ステートメント型の組合せで決まり、新しい方言やステートメント型の追加が頻繁にある場合
  - コード例: `sqlgenerator.ts:151-161`（`Convertor` 抽象クラス）、`sqlgenerator.ts:385-387`（`PgCreateTableConvertor.can`）
  - 注意点: `convertors` 配列への登録順に全件走査するため、登録数が増えると線形コストが増加する。`filtered.length === 1` の厳密一致チェックで曖昧なマッチを防止している

- **Pipeline / Pipes and Filters パターン** (分類: アーキテクチャ)
  - 解決する問題: TypeScript AST → SQL 文字列という複雑な変換を、テスト可能な小さなステージに分解する
  - 適用条件: 入力から出力までの変換が多段階に及び、各段階の中間表現が異なる場合
  - コード例: `serializePg` → `preparePgMigrationSnapshot` → `squashPgScheme` → `applyPgSnapshotsDiff` → `fromJson`
  - 注意点: ステージ間のデータフォーマットが暗黙的に結合しているため、中間表現の型定義（Zod スキーマ）が重要な契約となる

- **Snapshot / Memento パターン** (分類: 振る舞い)
  - 解決する問題: スキーマの時系列的な変化を追跡し、任意の時点間の差分を計算する
  - 適用条件: 状態の完全なスナップショットをファイルに永続化でき、差分計算の基準として使う場合
  - コード例: `migrationPreparator.ts:198-208`、`cli/commands/migrate.ts:1411-1414`（`meta/${prefix}_snapshot.json` への書き出し）
  - 注意点: スナップショットファイルのサイズはスキーマ規模に比例して増加する。UUID チェーン（`id`/`prevId`）で順序を追跡している

## Good Patterns

- **Zod スキーマによる中間表現のバリデーション**: スナップショット JSON を読み込む際、必ず `pgSchema.parse(prev)` のように Zod でバリデーションを通す。これにより、手動編集や古いバージョンのスナップショットが混入してもパイプライン途中で不正データが伝播することを防いでいる。

```typescript
// drizzle-kit/src/cli/commands/migrate.ts:321-322
const validatedPrev = pgSchema.parse(prev);
const validatedCur = pgSchema.parse(cur);
```

- **空スキーマのフォールバックによる初回マイグレーション統一**: 初回実行時にスナップショットが存在しない場合、`dryPg`（空の合法スキーマ）をフォールバックとして使うことで、初回と 2 回目以降のコードパスを統一している。初回だけの特殊分岐が不要になる。

```typescript
// drizzle-kit/src/serializer/pgSchema.ts:870-886
export const dryPg = pgSchema.parse({
	version: snapshotVersion,
	dialect: 'postgresql',
	id: originUUID,
	prevId: '',
	tables: {},
	enums: {},
	schemas: {},
	// ...
});
```

- **リゾルバーパターンによるリネーム解決の分離**: 差分検出ロジック（`applyPgSnapshotsDiff`）は「テーブル A が消えてテーブル B が増えた」という事実だけを認識し、「これはリネームか？」の判断はリゾルバー関数（`tablesResolver`, `columnsResolver`）に委譲する。CLI モードではユーザーにプロンプトを出し、API モードでは自動解決するという切り替えが可能になっている。

```typescript
// drizzle-kit/src/snapshotsDiffer.ts:559-588
export const applyPgSnapshotsDiff = async (
	json1: PgSchemaSquashed,
	json2: PgSchemaSquashed,
	schemasResolver: (...) => Promise<...>,
	tablesResolver: (...) => Promise<...>,
	columnsResolver: (...) => Promise<...>,
	// ...
)
```

## Anti-Patterns / 注意点

- **巨大ファイルへの機能集中**: `snapshotsDiffer.ts`（4331 行）、`sqlgenerator.ts`（4170 行）、`jsonStatements.ts`（3554 行）が単一ファイルに全方言のロジックを含んでいる。新しい方言やステートメント型の追加時に変更範囲が大きくなり、コンフリクトリスクが高い。

```
// Bad: 4000行超のファイルに全方言の変換ロジックが混在
sqlgenerator.ts (4170 lines)
  - PgCreateTableConvertor
  - MySqlCreateTableConvertor
  - SQLiteCreateTableConvertor
  - SingleStoreCreateTableConvertor
  - ... (100+ convertors)
```

```
// Better: 方言ごとにファイル分割し、共通の Convertor レジストリに登録
sqlgenerator/
  - convertor.ts        (abstract Convertor + fromJson + registry)
  - pg-convertors.ts    (PG固有)
  - mysql-convertors.ts (MySQL固有)
  - sqlite-convertors.ts
```

- **Squash 文字列のフォーマット脆弱性**: `PgSquasher.squashIdx` はセミコロン・ダブルハイフン・カンマで区切られた文字列を生成するが、値にこれらの区切り文字が含まれた場合のエスケープが行われていない。`where` 句や JSON `with` オプションに `;` が含まれると壊れる可能性がある。

```typescript
// Bad: 区切り文字のエスケープなし
return `${idx.name};${columns};${idx.isUnique};${idx.concurrently};${idx.method};${idx.where};${JSON.stringify(idx.with)}`;
```

```typescript
// Better: 構造化データの比較に JSON.stringify + deep-equal を使うか、
// 区切り文字を含まないエンコーディング（Base64等）を適用する
return JSON.stringify({ name: idx.name, columns: idx.columns, isUnique: idx.isUnique, ... });
```

## 導出ルール

- `[MUST]` マイグレーション生成パイプラインでは、元のスキーマ定義と SQL 出力の間に方言非依存の中間表現（IR）を設ける
  - 根拠: drizzle-kit は JSON スナップショット → squashed 表現 → JSON ステートメントの 3 層 IR により、差分検出ロジックを 4 方言で共有している（`snapshotsDiffer.ts` の `applyPgSnapshotsDiff` / `applySqliteSnapshotsDiff` が同じ diff 関数群を使用）

- `[MUST]` スキーマ状態の永続化形式にはバージョン番号を含め、Zod 等のバリデーションスキーマで各バージョンの構造を厳密に定義する
  - 根拠: `pgSchemaV1` 〜 `pgSchemaV7` の Zod リテラル型定義と `backwardCompatiblePgSchema = union([v5, v6, v7])` により、古いスナップショットの検出とアップグレードパスが型安全に実現されている（`pgSchema.ts:365-549`）

- `[SHOULD]` 差分計算は永続化されたスナップショット同士の比較に基づくべきで、ライブ DB 状態への依存を避ける
  - 根拠: `preparePgMigrationSnapshot` は `meta/` ディレクトリのスナップショット JSON を基準に差分を計算し、`dryPg` を初期状態のフォールバックとすることで、DB 接続なしに再現可能な差分を生成している（`migrationPreparator.ts:171-208`）

- `[SHOULD]` コード生成における方言固有の分岐は Strategy パターンで分離し、共通のディスパッチ関数で解決する
  - 根拠: `Convertor` 抽象クラスの `can(statement, dialect)` / `convert(statement)` メソッドにより、100 以上の変換ルールが `fromJson` 関数一箇所で統一的にディスパッチされている（`sqlgenerator.ts:4122-4144`）

- `[SHOULD]` 初回実行と 2 回目以降のコードパスを統一するために、空の初期状態をデフォルト値として定義する
  - 根拠: `dryPg` が空テーブル・空列挙型の合法スキーマとして定義され、スナップショットが 0 件の場合のフォールバックとなることで、初回マイグレーション生成に特殊分岐が不要になっている（`pgSchema.ts:870-886`）

- `[AVOID]` 複合オブジェクトをカスタム区切り文字で文字列化して比較する方式（区切り文字衝突のリスクがある）
  - 根拠: `PgSquasher.squashIdx` がセミコロン区切りで文字列化しているが、`where` 句等にセミコロンが含まれるケースでの堅牢性が保証されていない。JSON.stringify による正規化や deep-equal 比較の方が安全である

## 適用チェックリスト

- [ ] スキーマ変更を管理するシステムで、中間表現（IR）が定義されているか？ 方言固有ロジックが IR 以降のステージに集約されているか？
- [ ] スナップショット（状態のスナップショット）にバージョン番号が含まれ、バリデーションスキーマが定義されているか？
- [ ] 古いバージョンのスナップショットを最新バージョンにアップグレードする明示的なパスが実装されているか？
- [ ] 差分計算がファイルベースのスナップショット比較に基づいており、外部サービスの状態に依存していないか？
- [ ] 方言やターゲット固有のコード生成ロジックが Strategy パターン等で分離され、共通のディスパッチ機構を通じて呼び出されているか？
- [ ] 初回実行時の特殊分岐が存在せず、空の初期状態がデフォルトとして定義されているか？
- [ ] リネーム検出等のヒューリスティック判断がパイプラインのコアロジックから分離され、差し替え可能なリゾルバーとして設計されているか？
