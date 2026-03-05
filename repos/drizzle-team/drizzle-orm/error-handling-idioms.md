# error-handling-idioms

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

drizzle-orm のエラーハンドリングは、ランタイムエラーと型レベルエラーの二層構造を特徴とする。ランタイムでは最小限のカスタムエラークラス（3 種類）で SQL エラーのラッピングとトランザクション制御を行い、型レベルでは `DrizzleTypeError<T>` というブランド型インターフェースを使ってコンパイル時に人間可読なエラーメッセージを生成する。さらに ESLint プラグインで `.delete()` / `.update()` の `where` 忘れという「実行時に壊滅的な結果をもたらすが型では防げない」クラスのミスを静的に検出する。この三層防御（型 → リント → ランタイム）の設計は、データベースライブラリに限らず広く応用できる。

## 背景にある原則

- **エラー階層は薄くフラットに保つべき**: drizzle-orm のランタイムエラーは `DrizzleError`（汎用）、`DrizzleQueryError`（SQL 実行失敗）、`TransactionRollbackError`（意図的ロールバック）の 3 クラスのみ。深い継承ツリーを持たない。ORM はデータベースドライバの多様なエラーをラップする立場にあるが、ドライバ固有のエラー型を抽象化しようとはせず、`cause` チェーンで元エラーを保持する。エラークラスが少ないほどキャッチ側の分岐が単純になり、ライブラリ利用者の認知負荷が下がる。

- **コンパイル時に防げるエラーはランタイムに持ち越さない**: `DrizzleTypeError<T>` は実際にはインスタンス化されない「幽霊型」で、型推論の結果として IDE 上にエラーメッセージ文字列を表示する仕組みである。これにより `.returning()` 未呼び出し時の `.all()` 使用や、スキーマジェネリック未指定時の `.query` アクセスなど、API の誤用をコンパイル時に検出する。ランタイムチェックのコストとユーザー体験の遅延を回避する設計判断。

- **型で防げないが致命的なミスはリンターで防ぐ**: `db.delete(users)` に `.where()` を付け忘れると全行削除になる。これは型的には合法（WHERE 句はオプショナル）だが壊滅的な結果を招く。ESLint プラグインで `.delete()` / `.update()` 後に `.where()` が呼ばれているかを AST レベルで検査することで、型システムの限界を補完している。

- **トランザクションのロールバックを例外として表現する**: `tx.rollback()` の戻り値型は `never` で、内部で `TransactionRollbackError` を throw する。これにより、トランザクションコールバック内でのロールバックが制御フローとして自然に書ける。呼び出し側のセッション実装は catch ブロックで一律 rollback SQL を発行し、エラーを再 throw する。

## 実例と分析

### 1. ランタイムエラー体系: 3 クラスの役割分担

drizzle-orm のエラークラスは `drizzle-orm/src/errors.ts` に集約されている。

```typescript
// drizzle-orm/src/errors.ts:3-11
export class DrizzleError extends Error {
  static readonly [entityKind]: string = "DrizzleError";

  constructor({ message, cause }: { message?: string; cause?: unknown; }) {
    super(message);
    this.name = "DrizzleError";
    this.cause = cause;
  }
}
```

`DrizzleError` は名前付きパラメータ `{ message, cause }` を受け取る。`cause` の型が `unknown` であることで、ドライバ固有のエラー型に依存しない。

```typescript
// drizzle-orm/src/errors.ts:13-25
export class DrizzleQueryError extends Error {
  constructor(
    public query: string,
    public params: any[],
    public override cause?: Error,
  ) {
    super(`Failed query: ${query}\nparams: ${params}`);
    Error.captureStackTrace(this, DrizzleQueryError);
    if (cause) (this as any).cause = cause;
  }
}
```

`DrizzleQueryError` はクエリ文字列とパラメータを構造化データとして保持する。`Error.captureStackTrace` でスタックトレースからラッパー自身のフレームを除去し、デバッグ時に本質的な呼び出し元が見えるようにしている。

```typescript
// drizzle-orm/src/errors.ts:27-33
export class TransactionRollbackError extends DrizzleError {
  static override readonly [entityKind]: string = "TransactionRollbackError";

  constructor() {
    super({ message: "Rollback" });
  }
}
```

`TransactionRollbackError` は引数を一切受け取らない。これは「意図的なロールバック」を表すシグナル型であり、エラーの詳細は不要という設計。

### 2. SQL エラーラッピングの一貫パターン

全データベースドライバの `PreparedQuery` 基底クラスに共通する `queryWithCache` メソッドが、すべてのクエリ実行パスで一律に `DrizzleQueryError` にラップする。

```typescript
// drizzle-orm/src/pg-core/session.ts:70-74
protected async queryWithCache<T>(
	queryString: string,
	params: any[],
	query: () => Promise<T>,
): Promise<T> {
	// ... cache logic ...
	try {
		return await query();
	} catch (e) {
		throw new DrizzleQueryError(queryString, params, e as Error);
	}
}
```

この `try/catch` + 再 throw パターンがメソッド内に 6 回以上繰り返されている（キャッシュの各分岐ごと）。重複はあるが、すべてのパスで確実にラッピングされることを保証している。

### 3. トランザクションの begin/catch/rollback パターン

トランザクション実装は全ドライバで統一された構造を持つ。

```typescript
// drizzle-orm/src/node-postgres/session.ts:248-268
override async transaction<T>(
	transaction: (tx: NodePgTransaction<TFullSchema, TSchema>) => Promise<T>,
	config?: PgTransactionConfig | undefined,
): Promise<T> {
	const session = isPool
		? new NodePgSession(await (<pg.Pool> this.client).connect(), ...)
		: this;
	const tx = new NodePgTransaction<TFullSchema, TSchema>(this.dialect, session, this.schema);
	await tx.execute(sql`begin${config ? sql` ${tx.getTransactionConfigSQL(config)}` : undefined}`);
	try {
		const result = await transaction(tx);
		await tx.execute(sql`commit`);
		return result;
	} catch (error) {
		await tx.execute(sql`rollback`);
		throw error;
	} finally {
		if (isPool) (session.client as PoolClient).release();
	}
}
```

ネストされたトランザクション（savepoint）も同一パターンで実装される。

```typescript
// drizzle-orm/src/node-postgres/session.ts:284-301
override async transaction<T>(transaction: (tx: NodePgTransaction<TFullSchema, TSchema>) => Promise<T>): Promise<T> {
	const savepointName = `sp${this.nestedIndex + 1}`;
	const tx = new NodePgTransaction<TFullSchema, TSchema>(
		this.dialect, this.session, this.schema, this.nestedIndex + 1,
	);
	await tx.execute(sql.raw(`savepoint ${savepointName}`));
	try {
		const result = await transaction(tx);
		await tx.execute(sql.raw(`release savepoint ${savepointName}`));
		return result;
	} catch (err) {
		await tx.execute(sql.raw(`rollback to savepoint ${savepointName}`));
		throw err;
	}
}
```

`TransactionRollbackError` は特別扱いされない。catch ブロックは全エラーを同じように rollback してから再 throw する。ユーザーが `tx.rollback()` を呼ぶと `TransactionRollbackError` が throw され、トランザクションが rollback され、呼び出し側に伝播する。この設計により、ロールバック処理のコードパスが一本化される。

### 4. 型レベルエラーメッセージ: DrizzleTypeError

```typescript
// drizzle-orm/src/utils.ts:174-176
export interface DrizzleTypeError<T extends string> {
  $drizzleTypeError: T;
}
```

これは実行時には一切存在しないブランド型インターフェースである。型パラメータ `T` にエラーメッセージ文字列リテラルを渡すことで、IDE がホバー時やコンパイルエラー時にメッセージを表示する。

主な使用場面:

- **`.returning()` なしでの `.all()` / `.get()` / `.values()` 呼び出し** (`sqlite-core/query-builders/insert.ts:180-185`)
- **スキーマジェネリック未指定時の `.query` アクセス** (`pg-core/db.ts:51`)
- **エイリアス未設定の SQL フィールド参照** (`query-builders/select.types.ts:123`)
- **空の `returning` を持つサブクエリの JOIN** (`pg-core/query-builders/update.ts:155-157`)
- **単一キーオブジェクト制約の違反** (`utils.ts:159`)
- **不明なキーを持つリファインメント** (`drizzle-zod/src/schema.types.internal.ts:75`)

型テストファイルで動作を検証している:

```typescript
// drizzle-orm/type-tests/sqlite/insert.ts:27-28
const insertAll = db.insert(users).values(newUser).all();
Expect<Equal<DrizzleTypeError<".all() cannot be used without .returning()">, typeof insertAll>>;
```

### 5. entityKind による instanceof 代替

drizzle-orm は `instanceof` の代わりに Symbol ベースの `entityKind` を使った `is()` 関数でエンティティ判定を行う。

```typescript
// drizzle-orm/src/entity.ts:12-42
export function is<T extends DrizzleEntityClass<any>>(value: any, type: T): value is InstanceType<T> {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (value instanceof type) {
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(type, entityKind)) {
    throw new Error(
      `Class "${type.name ?? "<unknown>"}" doesn't look like a Drizzle entity. ...`,
    );
  }
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

`Symbol.for('drizzle:entityKind')` はグローバルシンボルレジストリを使うため、複数バージョンの drizzle-orm が共存するモノレポ環境でも正しく動作する。`instanceof` がプロトタイプチェーンの断絶で失敗するケース（バンドラによる重複インストール等）を回避する。

### 6. ESLint プラグインによる静的安全ネット

```typescript
// eslint-plugin-drizzle/src/enforce-delete-with-where.ts:34-51
create(context, options) {
	return {
		MemberExpression: (node) => {
			if (node.property.type === 'Identifier') {
				if (node.property.name === 'delete' && lastNodeName !== 'where' && isDrizzleObj(node, options)) {
					context.report({
						node,
						messageId: 'enforceDeleteWithWhere',
						data: {
							drizzleObjName: resolveMemberExpressionPath(node),
						},
					});
				}
				lastNodeName = node.property.name;
			}
		},
	};
},
```

`.delete()` が呼ばれた時点で直前のチェーンメソッドが `.where` でなければ警告する。エラーメッセージに実際の drizzle オブジェクト名を含め、修正方法を具体的に提示する。

## パターンカタログ

- **Error Wrapping / Cause Chain** (分類: エラーハンドリング)
  - 解決する問題: ドライバ固有のエラーを ORM のエラーとしてラップしつつ、元のエラー情報を保持する
  - 適用条件: 外部ライブラリのエラーをキャッチして再 throw するレイヤーすべて
  - コード例: `drizzle-orm/src/pg-core/session.ts:73` (`throw new DrizzleQueryError(queryString, params, e as Error)`)
  - 注意点: `Error.captureStackTrace` は V8 固有 API。Node.js / Bun 以外の環境では存在しない場合がある

- **Branded Type as Error Message** (分類: 型レベルプログラミング)
  - 解決する問題: API の誤用をコンパイル時に検出し、人間可読なエラーメッセージを IDE に表示する
  - 適用条件: 条件付き型で「許可されない操作」を表現したい場合
  - コード例: `drizzle-orm/src/utils.ts:174-176` (`interface DrizzleTypeError<T extends string>`)
  - 注意点: 実行時には何の効果もない。ランタイムバリデーションと併用する必要がある場面では別途チェックが必要

- **Exception as Control Flow (Rollback Signal)** (分類: 振る舞い)
  - 解決する問題: コールバック内からトランザクションの中断を通知する
  - 適用条件: コールバックベースのトランザクション API で、明示的なロールバック手段が必要な場合
  - コード例: `drizzle-orm/src/errors.ts:27-33` / `drizzle-orm/src/pg-core/session.ts:256-258`
  - 注意点: 例外を制御フローに使うのはアンチパターンとされることが多いが、コールバック型 API では値の返却でロールバックを表現しにくく、`never` 戻り値型との組み合わせで型安全に表現できる

## Good Patterns

- **構造化された SQL エラーコンテキスト**: `DrizzleQueryError` はクエリ文字列とパラメータをプロパティとして公開する。catch 側でエラーオブジェクトから失敗クエリを直接参照でき、ログやデバッグが容易になる。

```typescript
// drizzle-orm/src/errors.ts:13-25
export class DrizzleQueryError extends Error {
  constructor(
    public query: string,
    public params: any[],
    public override cause?: Error,
  ) {
    super(`Failed query: ${query}\nparams: ${params}`);
    Error.captureStackTrace(this, DrizzleQueryError);
    if (cause) (this as any).cause = cause;
  }
}
```

- **`never` 戻り値による到達不能コードの型安全保証**: `rollback(): never` により、rollback 呼び出し後のコードが到達不能であることをコンパイラが認識し、不要な return 文や後続処理の記述を防ぐ。

```typescript
// drizzle-orm/src/pg-core/session.ts:256-258
rollback(): never {
	throw new TransactionRollbackError();
}
```

- **型レベルエラーの自然言語メッセージ**: `DrizzleTypeError` のメッセージは具体的な修正方法を含む (`'.all() cannot be used without .returning()'`, `'You cannot reference this field without assigning it an alias first - use .as(<alias>)'`)。開発者がエラーを見た瞬間に何をすべきかわかる。

## Anti-Patterns / 注意点

- **型レベルエラーのランタイム不整合**: `DrizzleTypeError` は型のみで機能するため、`any` や型アサーションで型チェックを回避するとランタイムで予期しない動作が起こりうる。drizzle-orm では `selection-proxy.ts:95` のように一部のケースでランタイム throw も併用している。

Bad:

```typescript
// 型エラーを as any で回避すると、ランタイムで undefined が返る
const result = db.insert(users).values(newUser).all() as any;
// result は undefined — 型レベルでは DrizzleTypeError が出ていたはず
```

Better:

```typescript
// 型レベルエラーに対応するランタイムチェックも設ける
const result = db.insert(users).values(newUser).returning().all();
// .returning() を呼ぶことで型エラーが解消され、期待通りの結果が得られる
```

- **queryWithCache 内の catch ブロック重複**: `pg-core/session.ts` の `queryWithCache` メソッドでは、6 つ以上の分岐それぞれで同一の `try/catch` + `throw new DrizzleQueryError(...)` が繰り返されている。ロジックの変更時に漏れが生じるリスクがある。

Bad:

```typescript
// 同一のラッピングが各分岐で繰り返される
if (conditionA) {
  try {
    return await query();
  } catch (e) {
    throw new DrizzleQueryError(queryString, params, e as Error);
  }
}
if (conditionB) {
  try {
    return await query();
  } catch (e) {
    throw new DrizzleQueryError(queryString, params, e as Error);
  }
}
```

Better:

```typescript
// ラッピングを一箇所に集約する
const executeWithWrapping = async () => {
  try {
    return await query();
  } catch (e) {
    throw new DrizzleQueryError(queryString, params, e as Error);
  }
};
if (conditionA) return executeWithWrapping();
if (conditionB) return executeWithWrapping();
```

## 導出ルール

- `[MUST]` ライブラリ境界でキャッチしたエラーは `cause` チェーンで元エラーを保持してから再 throw する — 元エラーを握りつぶすとデバッグが著しく困難になる
  - 根拠: `DrizzleQueryError` は `cause` プロパティで元のドライバエラーを保持し、`Error.captureStackTrace` でスタックからラッパーフレームを除去する (`errors.ts:13-24`)

- `[MUST]` カスタムエラークラスにはデバッグに必要な構造化コンテキスト（入力値、クエリ文字列等）をプロパティとして保持する — `message` 文字列のパースに頼らせない
  - 根拠: `DrizzleQueryError` は `query` と `params` をパブリックプロパティとして公開し、catch 側でプログラム的にアクセスできる (`errors.ts:15-16`)

- `[SHOULD]` API の誤用パターンが型システムで表現可能なら、ランタイムチェックではなく条件付き型でコンパイル時エラーにする — ブランド型インターフェースに人間可読なメッセージ文字列を持たせることで IDE 上でエラー原因と修正方法を即座に伝えられる
  - 根拠: `DrizzleTypeError<T extends string>` インターフェースが 20 箇所以上で使用され、`.returning()` 未呼び出し、スキーマ未指定、エイリアス未設定等を型レベルで検出する (`utils.ts:174-176`)

- `[SHOULD]` 型で防げないが致命的な結果をもたらす操作には ESLint ルール等のリンターで安全ネットを設ける — `.delete()` の `.where()` 忘れのように「型的には合法だが実行すると壊滅的」なパターンに有効
  - 根拠: `eslint-plugin-drizzle` の `enforce-delete-with-where` / `enforce-update-with-where` ルールが全行削除・全行更新を防止する (`eslint-plugin-drizzle/src/enforce-delete-with-where.ts`)

- `[SHOULD]` コールバック型 API で中断シグナルが必要な場合、専用の例外クラスを `never` 戻り値型で throw するパターンを使う — 中断後のコードが到達不能であることを型で保証でき、catch 側は通常のエラーと同じフローで処理できる
  - 根拠: `rollback(): never` が `TransactionRollbackError` を throw し、トランザクション catch ブロックの一本化を実現している (`pg-core/session.ts:256-258`)

- `[SHOULD]` 複数パッケージバージョンが共存する環境では `instanceof` の代わりに Symbol ベースのエンティティ判定を使う — バンドラの重複インストールでプロトタイプチェーンが断絶する場合でも正しく動作する
  - 根拠: `is()` 関数が `Symbol.for('drizzle:entityKind')` でグローバルシンボルレジストリを使い、`instanceof` の失敗を回避する (`entity.ts:12-42`)

- `[AVOID]` エラークラスの階層を深くしすぎる — ランタイムエラーの分類は 3-5 種類程度に抑え、エラーの詳細は `cause` チェーンとプロパティで表現する
  - 根拠: drizzle-orm は全データベース方言（PostgreSQL, MySQL, SQLite, SingleStore, Gel）を 3 クラスのみで統一的に扱い、ドライバ固有のエラーは `cause` に委譲する (`errors.ts`)

## 適用チェックリスト

- [ ] プロジェクトのカスタムエラークラスは `cause` プロパティで元エラーを保持しているか
- [ ] エラーメッセージに加えて、デバッグに必要な構造化データ（入力値、クエリ等）をプロパティとして公開しているか
- [ ] API の誤用パターンのうち、条件付き型でコンパイル時に検出可能なものはないか検討したか
- [ ] 型で防げないが壊滅的な結果をもたらす操作（全行削除等）に対して、ESLint カスタムルール等の静的解析ガードを設けているか
- [ ] `Error.captureStackTrace` でラッパーフレームを除去し、デバッグ時に本質的な呼び出し元が見えるようにしているか
- [ ] `instanceof` を多用している箇所で、複数バージョン共存時の断絶リスクを評価したか
- [ ] トランザクションのロールバック手段は型安全に提供されているか（`never` 戻り値型等）
