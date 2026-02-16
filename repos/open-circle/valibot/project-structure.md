# project-structure

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

Valibot のプロジェクト構成を分析し、Monorepo 構成・モジュール分割・ファイル配置規約のパターンを明らかにする。2,296 ソースファイル規模の TypeScript ライブラリでありながら、1 機能 = 1 フォルダという極めて厳格な「フラクタル構造」を全モジュール（46 schemas + 116 actions + 27 methods + 17 utils + 4 storages）に例外なく適用している点が注目に値する。この構成によりバンドルサイズの最適化（tree-shaking）、テストの局所性、コントリビュータの認知負荷低減を同時に達成している。

## 背景にある原則

- **Tree-shaking first の構造設計**: ライブラリのモジュール分割はバンドラの dead code elimination が正しく動作することを最優先に設計すべき。根拠: 全ファクトリ関数に `// @__NO_SIDE_EFFECTS__` アノテーションを付与し（`library/src/schemas/string/string.ts:69`）、`package.json` に `"sideEffects": false` を宣言（`library/package.json:37`）。1 機能 1 フォルダの分割もエントリポイントからの import パスを明確にし、未使用コードの除去を確実にするためのもの。

- **構造の一貫性は規模の複雑さを無効化する**: 200 以上のモジュールがあっても、すべてが同一の 4 ファイル構成（`name.ts`, `name.test.ts`, `name.test-d.ts`, `index.ts`）であれば、新しいモジュールを追加する際のコストはほぼゼロになる。根拠: schemas/actions/methods/utils/storages すべてがこのパターンに従い、例外がない。

- **テストはプロダクションコードと同じ粒度で配置する**: テストファイルを別ディレクトリに集約するのではなく、対象コードの隣に置くことで、変更時の見落としを防ぎ、コードレビューでの検証を容易にする。型テスト（`.test-d.ts`）も同じ場所に配置し、ランタイムテストと型レベルテストを分離しつつ同居させている。

- **内部 API のアンダースコア命名規約で可視性を表現する**: TypeScript には `internal` 修飾子がないため、命名規約（`_` プレフィックス）で内部ユーティリティを区別する。根拠: `utils/` 配下の `_addIssue`, `_stringify`, `_getStandardProps` 等はすべてアンダースコアプレフィックスで、公開 API である `ValiError`, `isOfKind` 等と区別されている（`library/src/utils/index.ts`）。

## 実例と分析

### Monorepo レイアウト: 役割による明確な分離

pnpm workspace で 4 カテゴリのパッケージを管理している（`pnpm-workspace.yaml`）。

| ディレクトリ               | 役割                   | npm パッケージ名          |
| -------------------------- | ---------------------- | ------------------------- |
| `library/`                 | コアライブラリ         | `valibot`                 |
| `packages/to-json-schema/` | JSON Schema 変換       | `@valibot/to-json-schema` |
| `packages/i18n/`           | 翻訳メッセージ         | `@valibot/i18n`           |
| `website/`                 | ドキュメントサイト     | - (非公開)                |
| `codemod/`                 | マイグレーションツール | 各サブパッケージ          |
| `skills/`                  | AI エージェントスキル  | - (非公開)                |

コアライブラリ（`library/`）は `packages/` ではなくルート直下に置かれており、monorepo の中心であることを構造的に表現している。補助パッケージは `packages/` に集約し、`@valibot/` スコープで公開する。`codemod/` と `skills/` はユーザー配布しないツール群として独立。

### フラクタルモジュール構造: 4 ファイルの黄金パターン

コアライブラリの `src/` は意味的なカテゴリ（schemas, actions, methods, utils, storages, types）で第 1 階層を分け、第 2 階層で各機能を 1 フォルダに分割する。

```
library/src/
├── schemas/        # 46 モジュール (string, object, array, ...)
│   ├── string/
│   │   ├── string.ts          # 実装 + Issue/Schema 型定義
│   │   ├── string.test.ts     # ランタイムテスト
│   │   ├── string.test-d.ts   # 型テスト
│   │   └── index.ts           # 再エクスポート
│   └── index.ts               # 全 schemas の再エクスポート
├── actions/        # 116 モジュール (email, minLength, trim, ...)
├── methods/        # 27 モジュール (parse, pipe, partial, ...)
├── utils/          # 17 モジュール (_addIssue, ValiError, ...)
├── storages/       # 4 モジュール (globalConfig, globalMessage, ...)
├── types/          # 型定義ファイル群 (index.ts でフラット再エクスポート)
├── vitest/         # テストヘルパー群
├── regex.ts        # 共有正規表現定数
└── index.ts        # ライブラリ全体のエントリポイント
```

### Async バリアント: 同一フォルダ内での同期/非同期の共存

非同期バリアントを持つモジュール（object, pipe, parse, forward 等）では、`nameAsync.ts` を同じフォルダに配置する。

```
library/src/methods/parse/
├── parse.ts              # 同期版
├── parse.test.ts
├── parse.test-d.ts
├── parseAsync.ts         # 非同期版
├── parseAsync.test.ts
├── parseAsync.test-d.ts
└── index.ts              # 両方を再エクスポート
```

```
library/src/schemas/object/
├── object.ts             # 同期版
├── objectAsync.ts        # 非同期版
├── types.ts              # 共有型定義 (ObjectIssue)
└── index.ts
```

共有する型定義がある場合は `types.ts` をフォルダ内に配置する。actions カテゴリでは `actions/types.ts`（`library/src/actions/types.ts`）にカテゴリ全体の共有型を集約している。

### 3 段バレルエクスポートの階層

エクスポートの再集約は 3 段階で行われる。

```
// 1段目: モジュールの index.ts (library/src/schemas/string/index.ts)
export * from './string.ts';

// 2段目: カテゴリの index.ts (library/src/schemas/index.ts)
export * from './string/index.ts';
export * from './object/index.ts';
// ... 46 モジュール

// 3段目: ライブラリの index.ts (library/src/index.ts)
export * from './schemas/index.ts';
export * from './actions/index.ts';
export * from './methods/index.ts';
// types は名前付きエクスポートで選択的に公開
export type { BaseSchema, InferInput, InferOutput, ... } from './types/index.ts';
```

注目すべきは `types/` の扱いで、`export *` ではなく名前付き `export type` で公開 API を明示的に選択している（`library/src/index.ts:6-58`）。内部型の漏洩を防ぐ設計判断である。

### テストヘルパーの構造化

テストヘルパーは `library/src/vitest/` に集約される。Schema と Action の 2 種類 x 成功/失敗 x 同期/非同期 = 8 ヘルパー関数という体系的な構成になっている。

```
library/src/vitest/
├── expectSchemaIssue.ts        # Schema 失敗テスト
├── expectSchemaIssueAsync.ts
├── expectNoSchemaIssue.ts      # Schema 成功テスト
├── expectNoSchemaIssueAsync.ts
├── expectActionIssue.ts        # Action 失敗テスト
├── expectActionIssueAsync.ts
├── expectNoActionIssue.ts      # Action 成功テスト
├── expectNoActionIssueAsync.ts
└── index.ts
```

## コード例

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

```typescript
// library/src/index.ts:1-59 (抜粋)
// カテゴリごとの全量エクスポート
export * from "./actions/index.ts";
export * from "./methods/index.ts";
export * from "./schemas/index.ts";
export * from "./storages/index.ts";
// types のみ選択的エクスポート
export type {
  BaseSchema,
  BaseSchemaAsync,
  Config,
  InferInput,
  InferIssue,
  InferOutput,
  // ... (52 型)
} from "./types/index.ts";
export * from "./utils/index.ts";
```

```typescript
// library/src/utils/index.ts:1-17 (抜粋)
// _ プレフィックス = internal、プレフィックスなし = public
export * from "./_addIssue/index.ts";
export * from "./_stringify/index.ts";
export * from "./isOfKind/index.ts";
export * from "./ValiError/index.ts";
```

## パターンカタログ

- **Barrel Export パターン** (分類: 構造)
  - 解決する問題: 多数のモジュールをユーザーに単一エントリポイントで提供しつつ、内部構造の変更を隠蔽する
  - 適用条件: 100 以上のモジュールを持つライブラリで、`import { x } from 'lib'` の DX を維持したい場合
  - コード例: `library/src/schemas/index.ts`, `library/src/index.ts`
  - 注意点: 3 段以上のバレルはバンドラによっては tree-shaking を阻害する。`sideEffects: false` との組み合わせが必須

- **Feature Folder パターン** (分類: 構造)
  - 解決する問題: 機能ごとに関連ファイル（実装・テスト・型）を局所化し、追加・削除の影響範囲を最小化する
  - 適用条件: 同一パターンのモジュールを大量に追加する可能性があるプロジェクト
  - コード例: `library/src/schemas/string/` (4 ファイル構成)
  - 注意点: フォルダ内のファイル数が増えすぎないよう、1 機能 = 4-8 ファイル程度に抑える

## Good Patterns

- **型テストの独立ファイル化**: `.test-d.ts` ファイルとしてランタイムテストから型テストを分離している。`vitest --typecheck` で実行され、型推論の正確性を CI で検証できる。テストの関心を「ランタイムの振る舞い」と「型の振る舞い」に分離することで、各ファイルの責務が明確になる。

```typescript
// library/src/schemas/string/string.test-d.ts:7-10
test("with undefined message", () => {
  type Schema = StringSchema<undefined>;
  expectTypeOf(string()).toEqualTypeOf<Schema>();
  expectTypeOf(string(undefined)).toEqualTypeOf<Schema>();
});
```

- **テストヘルパーの体系的な命名**: `expect{No?}{Schema|Action}Issue{Async?}` という規則的な命名で 8 ヘルパーを体系化し、200 以上のモジュールのテストコードの冗長性を排除している。

```typescript
// library/src/schemas/string/string.test.ts:3,50
import { expectNoSchemaIssue, expectSchemaIssue } from "../../vitest/index.ts";
// ...
expectNoSchemaIssue(schema, ["", " ", "\n"]);
```

- **`types/` の選択的エクスポート**: `export *` でなく `export type { ... }` で公開型を明示的に選択し、内部型（`FirstTupleItem` 等）がパブリック API に漏洩するのを防いでいる。

```typescript
// library/src/index.ts:6-58
export type {
  BaseSchema,
  BaseSchemaAsync,
  Config,
  InferInput,
  InferOutput,
  // ... 明示的に列挙された 52 型
} from "./types/index.ts";
```

- **`// @__NO_SIDE_EFFECTS__` の一貫した付与**: すべてのファクトリ関数（schema/action/method の実装関数）に `// @__NO_SIDE_EFFECTS__` を付与し、バンドラが未使用コードを安全に除去できることを保証している。

## Anti-Patterns / 注意点

- **バレルエクスポートの過剰ネスト**: 3 段以上のバレルが連鎖すると、一部のバンドラ（特に古い webpack）で tree-shaking が不完全になる可能性がある。Valibot では `sideEffects: false` とバンドラ（tsdown）の最適化に依存しているが、自プロジェクトで同様の構成を取る場合はバンドルサイズの検証が必要。

```typescript
// Bad: バレルのみに依存し sideEffects 宣言を忘れる
// package.json に "sideEffects": false がない状態で 3 段バレル

// Better: sideEffects: false を宣言し、バンドル後のサイズを CI で検証
{
  "sideEffects": false
}
```

- **単一モジュールに同期/非同期を混在させる**: 同じフォルダ内に `name.ts` と `nameAsync.ts` を配置するパターンは、フォルダ内のファイル数が増加する（object フォルダは 8 ファイル）。テストファイルも倍になるため、非同期バリアントが多い場合はフォルダ分割も検討すべき。ただし Valibot の場合はファイル名が規則的なので認知負荷は低く抑えられている。

## 導出ルール

- `[MUST]` 大量の同種モジュールを持つライブラリでは、1 機能 = 1 フォルダの構成を採用し、実装・テスト・型定義を同一フォルダに配置する
  - 根拠: Valibot は 200 以上のモジュール全てで `name.ts` / `name.test.ts` / `name.test-d.ts` / `index.ts` の 4 ファイル構成を例外なく維持しており、この一貫性がコントリビュータの参入障壁を最小化している

- `[MUST]` tree-shaking を重視するライブラリでは `package.json` に `"sideEffects": false` を宣言し、ファクトリ関数に `// @__NO_SIDE_EFFECTS__` アノテーションを付与する
  - 根拠: Valibot は全ファクトリ関数にこのアノテーションを一貫して付与し（`library/src/schemas/string/string.ts:69` 等）、バンドルサイズの最適化を構造的に保証している

- `[SHOULD]` 内部ユーティリティには命名規約（`_` プレフィックス等）で可視性を表現し、パブリック API との境界を明確にする
  - 根拠: `utils/` の `_addIssue`, `_stringify` 等の internal 関数と `ValiError`, `isOfKind` 等の public 関数がプレフィックスで区別されている（`library/src/utils/index.ts`）

- `[SHOULD]` 型定義のエクスポートは `export *` ではなく名前付き `export type` で公開する型を明示的に選択する
  - 根拠: `library/src/index.ts:6-58` で 52 型を明示的に列挙し、内部型の漏洩を防いでいる。`export *` を使うカテゴリ（schemas, actions, methods）はすべて実行時 API であり、型のみのモジュールには適用していない

- `[SHOULD]` TypeScript ライブラリでは型テスト（`.test-d.ts`）をランタイムテストとは別ファイルで管理し、CI で型チェックを実行する
  - 根拠: 全モジュールに `.test-d.ts` が存在し `vitest --typecheck` で実行される。型推論のリグレッションを防ぎ、`InferInput` / `InferOutput` の正確性を保証している

- `[AVOID]` テストファイルを `__tests__/` や `tests/` ディレクトリに集約する構成（大量の同種モジュールを持つプロジェクトの場合）
  - 根拠: Valibot は 200 以上のモジュールのテストを各モジュールフォルダに配置しており、テストと実装の 1:1 対応が常に保たれている。テストディレクトリに集約すると、200 ファイルが並ぶフラットなディレクトリになり探索性が著しく低下する

## 適用チェックリスト

- [ ] ライブラリを公開する場合、`package.json` に `"sideEffects": false` を設定しているか
- [ ] ファクトリ関数（副作用のない関数）に `// @__NO_SIDE_EFFECTS__` アノテーションを付与しているか
- [ ] 同種のモジュールが 10 以上ある場合、1 機能 = 1 フォルダの構成を採用しているか
- [ ] 各モジュールフォルダに `index.ts`（バレルファイル）を配置し、内部構造を隠蔽しているか
- [ ] 型定義の公開範囲を `export type { ... }` で明示的に制御しているか
- [ ] テストファイルがプロダクションコードと同じフォルダに配置されているか
- [ ] 型テスト（`.test-d.ts`）を作成し、CI で型推論のリグレッションを検出できるか
- [ ] 内部ユーティリティに命名規約（`_` プレフィックス等）を適用し、公開 API と区別しているか
- [ ] Monorepo の場合、コアパッケージと補助パッケージのディレクトリ階層で重要度を表現しているか
- [ ] 非同期バリアントがある場合、`nameAsync.ts` として同一フォルダに配置し index.ts で両方をエクスポートしているか
