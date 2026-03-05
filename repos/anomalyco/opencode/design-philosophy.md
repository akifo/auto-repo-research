# design-philosophy

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

opencode は大規模 TypeScript プロジェクト（1273 ソースファイル）でありながら、AGENTS.md に明文化された厳格なコーディングスタイルを貫徹している。特筆すべきは、この規約が「AI エージェント（コード生成 AI）が書くコードの品質」を制御する目的で設計されている点にある。単語数の少ない命名、分割代入の禁止、`else` の排除、`try`/`catch` の回避といった一見極端なルールが、コードベース全体の一貫性とスキャナビリティ（流し読みのしやすさ）を高水準に維持している。

## 背景にある原則

- **認知負荷最小化の原則**: 変数名は短く、制御フローは早期リターンで平坦にし、分割代入を避けてドットアクセスでコンテキストを保持する。読み手が「この値はどこから来たのか」を追跡する認知コストを減らす設計である。根拠: AGENTS.md の Naming / Destructuring / Control Flow セクション全体がこの原則に基づく。

- **AI 生成コードの矯正原則**: AGENTS.md の `Naming Enforcement` セクションには「THIS RULE IS MANDATORY FOR AGENT WRITTEN CODE」と明記されており、AI が冗長な名前やボイラープレートを生成する傾向を明示的に抑制している。人間の開発者ではなく AI エージェントの出力品質を制御するための規約ドキュメントという位置づけである。

- **エラー処理の宣言的表現原則**: `try`/`catch` ブロックを避け、`.catch()` チェーンで非同期エラーを処理する。これにより、エラーハンドリングが制御フローの分岐ではなくデータ変換の一部として表現され、コードのネスト深度が浅くなる。根拠: AGENTS.md「Avoid `try`/`catch` where possible」と `src/session/instruction.ts:34` 等の `.catch(() => [])` パターン。

- **型推論依存の原則**: 明示的な型注釈やインターフェース定義を避け、TypeScript の型推論に依存する。Zod スキーマから `z.infer` で型を導出し、`export type Info = z.infer<typeof Info>` のように同名の型と値を namespace 内で共存させる。根拠: AGENTS.md「Rely on type inference when possible」と `src/agent/agent.ts:49` の `export type Info = z.infer<typeof Info>` パターン。

## 実例と分析

### namespace によるモジュール編成

opencode はクラスではなく TypeScript の `namespace` をモジュール境界として使用している。`Session`, `Config`, `Provider`, `Bus`, `Agent`, `Storage` など、ほぼ全ての主要モジュールが `export namespace` で定義されている。namespace 内にプライベートな `const`/`function` を持ち、`export` されたものだけが外部に公開される。

この設計の利点は、クラスのインスタンス化なしにモジュールレベルの状態管理ができること、そして IDE の補完で `Session.` と打てば全ての公開 API が表示される点にある。GoF のファサードパターンに近いが、クラスではなく namespace で実現している。

### 短い変数名の徹底

AGENTS.md は「Prefer single word names for variables and functions」を強制し、良い短縮名の例として `pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`, `timeout` を挙げている。コードベースでもこれが徹底されている。

```ts
// src/util/log.ts:8
export namespace Log {
  const log = Log.create({ service: "storage" })
```

```ts
// src/session/index.ts:34
const log = Log.create({ service: "session" });
```

```ts
// src/tool/bash.ts:24
export const log = Log.create({ service: "bash-tool" });
```

ログインスタンスは一貫して `log` という一単語で、サービス名のみでコンテキストを区別する。`sessionLogger` や `bashToolLogger` のような冗長名は存在しない。

### 分割代入の回避とドットアクセス

AGENTS.md は分割代入を明確に禁止し、`obj.a` / `obj.b` のようなドットアクセスを推奨している。これにより、値がどのオブジェクトに属しているかが常に読み取れる。

```ts
// src/session/index.ts:67-68
directory: row.directory,
parentID: row.parent_id ?? undefined,
```

`row` からのフィールド取得は常にドットアクセスで行われ、`const { directory, parent_id } = row` のような分割代入は使われていない。

### .catch() チェーンによるエラー処理

`try`/`catch` の代わりに `.catch()` でエラーをインラインで処理するパターンがコードベース全体で広く使われている。

```ts
// src/session/instruction.ts:34
return Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => []);
```

```ts
// src/session/prompt.ts:205
const stats = await fs.stat(filepath).catch(() => undefined);
```

```ts
// src/session/summary.ts:120
const diffs = await Storage.read<Snapshot.FileDiff[]>(["session_diff", input.sessionID]).catch(() => []);
```

失敗時のフォールバック値を `.catch()` の引数として即座に定義する。`try`/`catch` で囲むと最低 5 行必要なコードが 1 行に収まり、「この操作は失敗してもよい」という意図が宣言的に表現される。

### iife ユーティリティによる即時実行式の明示化

```ts
// src/util/iife.ts:1-3
export function iife<T>(fn: () => T) {
  return fn();
}
```

JavaScript の `(async () => { ... })()` パターンを名前付き関数でラップし、可読性を上げている。`src/project/instance.ts:26` では `iife(async () => { ... })` として非同期の即時実行式を明示的に表現している。

### NamedError による構造化エラー

```ts
// packages/util/src/error.ts:7-46
static create<Name extends string, Data extends z.core.$ZodType>(name: Name, data: Data) {
  const schema = z.object({
    name: z.literal(name),
    data,
  })
```

エラークラスを Zod スキーマと組み合わせて生成するファクトリパターン。各エラーは `NamedError.create("NotFoundError", z.object({ message: z.string() }))` のように定義され、型安全なエラーデータを持つ。`isInstance` メソッドで `instanceof` に依存しないチェックも可能。

### Drizzle スキーマの snake_case 規約

```ts
// src/project/project.sql.ts:4-15
export const ProjectTable = sqliteTable("project", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  icon_url: text(),
  icon_color: text(),
  time_initialized: integer(),
});
```

Drizzle ORM のフィールド名を snake_case にすることで、カラム名の文字列引数を省略できる。`projectID: text("project_id")` と書く代わりに `project_id: text()` と書くことで、カラム名の重複定義を排除している。

## パターンカタログ

- **Facade パターン** (分類: 構造)
  - 解決する問題: モジュールの内部実装を隠蔽し、単一のエントリポイントを提供する
  - 適用条件: 複数の関数・型・定数をまとめて 1 つの名前空間で公開したい場合
  - コード例: `src/session/index.ts:33` の `export namespace Session`、`src/config/config.ts:39` の `export namespace Config`
  - 注意点: namespace は TypeScript 固有の機能であり、他言語では通常のモジュールやオブジェクトリテラルで代替する

- **Factory Method パターン** (分類: 生成)
  - 解決する問題: エラークラスの定義を宣言的に行い、Zod スキーマとの統合を自動化する
  - 適用条件: エラー型を多数定義するプロジェクトでボイラープレートを削減したい場合
  - コード例: `packages/util/src/error.ts:7` の `NamedError.create()`
  - 注意点: ファクトリで生成されたクラスは動的なので、`instanceof` チェーンが深くなる場合は注意が必要

## Good Patterns

- **`.catch()` でフォールバック値を宣言する**: 失敗が許容される非同期操作に対して、`try`/`catch` ブロックの代わりに `.catch(() => defaultValue)` を使う。コードのネスト深度が減り、「この操作は失敗してもよい」という意図が 1 行で伝わる。

```ts
// src/session/instruction.ts:34
return Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => []);

// src/session/prompt.ts:205
const stats = await fs.stat(filepath).catch(() => undefined);
```

- **Zod スキーマと同名の型エクスポート**: namespace 内で `export const Info = z.object({...})` と `export type Info = z.infer<typeof Info>` を並べることで、バリデーションと型定義を単一の情報源から導出する。

```ts
// src/agent/agent.ts:24-49
export const Info = z.object({
  name: z.string(),
  // ...
}).meta({ ref: "Agent" });
export type Info = z.infer<typeof Info>;
```

- **`iife()` による即時実行式の名前付け**: 自己呼び出し関数を `iife()` ユーティリティでラップし、意図を明示する。`(async () => { ... })()` より読みやすく、コードレビューで「これは何をしているのか」が即座にわかる。

```ts
// src/project/instance.ts:26
existing = iife(async () => {
  const { project, sandbox } = await Project.fromDirectory(input.directory);
  // ...
});
```

## Anti-Patterns / 注意点

- **冗長な変数名の導入**: AI エージェントは `existingClient`, `connectTimeout`, `workerPath` のような複合語を生成しがちだが、opencode の規約では単語数を最小化する。一度しか使わない値は変数に束縛せずインライン化する。

```ts
// Bad
const journalPath = path.join(dir, "journal.json");
const journal = await Bun.file(journalPath).json();

// Better
const journal = await Bun.file(path.join(dir, "journal.json")).json();
```

- **分割代入でコンテキストを失う**: 分割代入は一見便利だが、変数がどのオブジェクトに属していたかの情報が消える。特に複数のオブジェクトから同時に分割代入すると、`name` が `session.name` なのか `project.name` なのか判別できなくなる。

```ts
// Bad
const { a, b } = obj;

// Better
obj.a;
obj.b;
```

- **`try`/`catch` でフォールバック処理を書く**: 失敗時にデフォルト値を返すだけの場合、`try`/`catch` は不必要なネストと行数を増やす。

```ts
// Bad
let result;
try {
  result = await fs.stat(filepath);
} catch {
  result = undefined;
}

// Better
const result = await fs.stat(filepath).catch(() => undefined);
```

## 導出ルール

- `[MUST]` AGENTS.md 等のスタイルガイドに「AI エージェントが従うべきルール」を明示的に記述する。AI が生成するコードの品質は、プロンプトに含まれる規約の明確さに比例する
  - 根拠: opencode の AGENTS.md は「THIS RULE IS MANDATORY FOR AGENT WRITTEN CODE」と明記し、AI の冗長な命名傾向を直接抑制している

- `[SHOULD]` 失敗が許容される非同期操作は `try`/`catch` ではなく `.catch(() => defaultValue)` で処理し、フォールバック値を宣言的に表現する
  - 根拠: opencode では 77 箇所以上で `.catch()` パターンが使われ、`try`/`catch` は 43 箇所にとどまる。特に `instruction.ts` や `prompt.ts` では一貫して `.catch()` が選択されている

- `[SHOULD]` 変数名は単語数を最小化し、一度しか使わない中間変数はインライン化する。短い名前が不明確な場合のみ複合語を許可する
  - 根拠: AGENTS.md が `pid`, `cfg`, `err`, `opts` 等の短縮名リストを提示し、`inputPID`, `existingClient` を明示的に禁止している

- `[SHOULD]` Zod スキーマと同名の型を `z.infer<typeof Schema>` で導出し、バリデーションと型定義の単一情報源を維持する
  - 根拠: `src/agent/agent.ts`, `src/command/index.ts` 等で `export const Info` と `export type Info` を並置するパターンが一貫して使われている

- `[AVOID]` 分割代入を多用してオブジェクトの出自情報を消すこと。ドットアクセスを使えば、値がどのオブジェクトに属しているかが常に読み取れる
  - 根拠: AGENTS.md「Avoid unnecessary destructuring. Use dot notation to preserve context.」と、`src/session/index.ts` の `row.directory`, `row.parent_id` 等の一貫したドットアクセス

- `[AVOID]` `else` 文を使うこと。早期リターンとガード節で条件分岐を平坦化し、ネスト深度を最大 1 段に保つ
  - 根拠: AGENTS.md「Avoid `else` statements. Prefer early returns.」と、コードベース全体で `else` が 83 箇所にとどまる点（1273 ファイル規模に対して極めて少ない）

## 適用チェックリスト

- [ ] プロジェクトの AGENTS.md（または CLAUDE.md）に、AI エージェントが従うべき命名規約・制御フロー規約を明文化したか
- [ ] 失敗が許容される非同期操作で `.catch(() => defaultValue)` パターンを使えるか確認したか（既存の `try`/`catch` を置換できるか）
- [ ] 中間変数が一度しか使われていないなら、インライン化して変数の総数を減らせるか確認したか
- [ ] 分割代入を使っている箇所で、ドットアクセスに戻したほうがコンテキストが明確になるか検討したか
- [ ] `else` 文を早期リターンに書き換えてネスト深度を削減できるか確認したか
- [ ] Zod スキーマを定義している場合、同名の型を `z.infer` で導出して重複を排除しているか
- [ ] エラー型を多数定義する場合、ファクトリパターン（`NamedError.create` のような仕組み）でボイラープレートを削減できるか検討したか
