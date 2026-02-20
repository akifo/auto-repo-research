# dependency-management

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod は TypeScript ファーストのスキーマバリデーションライブラリで、**ゼロ外部ランタイム依存**を貫きながら、再帰的スキーマ定義が本質的に生み出す循環参照問題を `defineLazy` / `cached` / セルフキャッシュ getter という 3 層の遅延評価パターンで解決している。さらに CI で `madge --circular` による静的循環依存チェックを自動化し、`import type` の徹底によりモジュール境界を型レベルとランタイムレベルで明確に分離している。ゼロ依存・循環回避・tree-shaking 対応の 3 つの制約を同時に満たす設計は、ライブラリ開発における依存管理の模範例となる。

## 背景にある原則

- **遅延評価で循環を断ち切る**: モジュール間の循環依存は「初期化順序」が問題になる。プロパティアクセスを `Object.defineProperty` で遅延化すれば、定義時の初期化順序に依存せず実行時に解決できる。Zod は `defineLazy`（循環検出付き遅延プロパティ）、`cached`（一度だけ評価されるアクセサ）、セルフキャッシュ getter（初回アクセスで自分を上書き）の 3 パターンを使い分けている。
  - 根拠: `packages/zod/src/v4/core/util.ts:266-289`（defineLazy）、`util.ts:223-235`（cached）、`util.ts:613`（assignProp セルフキャッシュ）

- **`import type` で依存グラフを削減する**: TypeScript の `import type` はコンパイル後に消えるため、ランタイムの循環依存を生まない。Zod の `v4/core` モジュール群では、型のみが必要な場合は一貫して `import type` を使い、ランタイム import を最小限に抑えている。
  - 根拠: `core/util.ts:1-4` では schemas, errors, checks, core をすべて `import type` で参照。`core/errors.ts:1-4`、`core/config.ts:1` も同様。

- **静的解析で循環を防御する**: コードレビューだけでは循環依存の混入を防ぎきれない。CI に `madge --circular` を組み込み、PR マージ前に自動検出する。既知の内部循環（`v4/core` 内部）は `--exclude` で明示的に除外し、それ以外のモジュール間循環はゼロを強制する。
  - 根拠: `package.json:88` の `check:circular` スクリプト、`.github/workflows/test.yml:50-60`

- **外部依存ゼロをアーキテクチャレベルで強制する**: Zod の `packages/zod/package.json` には `dependencies` フィールドが存在しない。正規表現、日付パース、UUID 生成など通常は外部ライブラリに頼る機能もすべて内製している。これにより supply chain attack リスクの排除、bundle size の完全制御、破壊的変更への免疫が得られる。
  - 根拠: `packages/zod/package.json` に `dependencies` なし。`core/regexes.ts` で正規表現を自前実装。

## 実例と分析

### 1. `defineLazy` — 循環検出付き遅延プロパティ

Zod のコアである `defineLazy` は、`Object.defineProperty` の getter/setter を使い、プロパティを遅延初期化する。特筆すべきは `EVALUATING` センチネルによる循環参照検出機構である。

```typescript
// packages/zod/src/v4/core/util.ts:264-289
const EVALUATING = Symbol("evaluating");

export function defineLazy<T, K extends keyof T>(object: T, key: K, getter: () => T[K]): void {
  let value: T[K] | typeof EVALUATING | undefined = undefined;
  Object.defineProperty(object, key, {
    get() {
      if (value === EVALUATING) {
        // Circular reference detected, return undefined to break the cycle
        return undefined as T[K];
      }
      if (value === undefined) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object, key, {
        value: v,
      });
    },
    configurable: true,
  });
}
```

getter 評価中に同じプロパティが再度アクセスされた場合、`EVALUATING` 状態を検出して `undefined` を返すことで無限再帰を防ぐ。このパターンは `$ZodLazy`（再帰スキーマ）で特に重要で、`innerType`, `pattern`, `propValues`, `optin`, `optout` の 5 プロパティすべてに適用されている（`schemas.ts:4412-4416`）。

### 2. `cached` — 一度だけ評価されるアクセサ

```typescript
// packages/zod/src/v4/core/util.ts:223-235
export function cached<T>(getter: () => T): { value: T; } {
  const set = false;
  return {
    get value() {
      if (!set) {
        const value = getter();
        Object.defineProperty(this, "value", { value });
        return value;
      }
      throw new Error("cached value already set");
    },
  };
}
```

`cached` は `defineLazy` と異なり、オブジェクトのプロパティではなく独立した値コンテナを返す。初回アクセス時に getter を評価し、`Object.defineProperty` で getter を実値に上書きする。`allowsEval`（`util.ts:371`）や `$ZodObject` の正規化処理（`schemas.ts:1880`）など、高コストな一回限りの計算に使われる。

### 3. セルフキャッシュ getter（`assignProp(this, ...)` パターン）

```typescript
// packages/zod/src/v4/core/util.ts:602-615 (pick 関数内)
const def = mergeDefs(schema._zod.def, {
  get shape() {
    const newShape: Writeable<schemas.$ZodShape> = {};
    for (const key in mask) {
      if (!(key in currDef.shape)) {
        throw new Error(`Unrecognized key: "${key}"`);
      }
      if (!mask[key]) continue;
      newShape[key] = currDef.shape[key]!;
    }

    assignProp(this, "shape", newShape); // self-caching
    return newShape;
  },
  checks: [],
});
```

`pick`, `omit`, `extend`, `merge`, `partial`, `required` の 6 つのオブジェクト操作すべてで、`shape` プロパティに「初回アクセスで計算し、自分自身を実値で上書きする」getter が使われている。`mergeDefs`（`util.ts:308-317`）は `Object.getOwnPropertyDescriptors` を使うため、getter がそのまま保持される点がポイントである。

### 4. `import type` による依存グラフの制御

`v4/core` ディレクトリの import パターンを分析すると、明確なルールが見える。

| ファイル        | `import type`                                             | ランタイム `import`                               |
| --------------- | --------------------------------------------------------- | ------------------------------------------------- |
| `util.ts`       | checks, core, errors, schemas                             | なし                                              |
| `errors.ts`     | checks, schemas, standard-schema                          | core, util                                        |
| `config.ts`     | errors                                                    | なし                                              |
| `core.ts`       | errors, schemas                                           | util (Class のみ)                                 |
| `checks.ts`     | errors, schemas                                           | core, regexes, util                               |
| `schemas.ts`    | api, errors, json-schema, standard-schema, to-json-schema | checks, core, doc, parse, regexes, util, versions |
| `registries.ts` | core, schemas                                             | なし                                              |

`util.ts` はランタイム import がゼロであり、他のすべてのモジュールから安全に import できるリーフモジュールとして設計されている。`schemas.ts` は最も多くのランタイム import を持つが、`errors`, `api`, `json-schema` などは `import type` に限定されている。

### 5. ローカル `z` オブジェクトによる循環回避

```typescript
// packages/zod/src/v4/classic/from-json-schema.ts:1-13
import type * as JSONSchema from "../core/json-schema.js";
import { type $ZodRegistry, globalRegistry } from "../core/registries.js";
import * as _checks from "./checks.js";
import * as _iso from "./iso.js";
import * as _schemas from "./schemas.js";
import type { ZodNumber, ZodString, ZodType } from "./schemas.js";

// Local z object to avoid circular dependency with ../index.js
const z = {
  ..._schemas,
  ..._checks,
  iso: _iso,
};
```

`from-json-schema.ts` は通常なら `import z from "../index.js"` とするところ、index.ts への循環依存を避けるために、必要なモジュールを個別 import してローカルに `z` オブジェクトを組み立てている。barrel export（index.ts）を経由しない直接 import は、循環回避の基本的な手法である。

### 6. `madge --circular` による CI 防御と例外管理

```json
// package.json:88
"check:circular": "madge --circular --extensions ts --exclude '(v4/core|v3|iso\\.ts)' packages/zod/src"
```

`v4/core` 内部はスキーマ定義の性質上、相互参照が不可避であるため `--exclude` で除外している。ただし除外された領域は `defineLazy` と `import type` で循環の影響を制御済みである。`v3` と `iso.ts` も同様に除外対象で、レガシーコードと特殊モジュールに対する明示的な例外管理となっている。

### 7. pnpm workspace の隔離設定

```yaml
# pnpm-workspace.yaml
packages:
  - packages/*
hoistWorkspacePackages: false
saveWorkspaceProtocol: false
linkWorkspacePackages: true
```

`hoistWorkspacePackages: false` により各パッケージが独自の `node_modules` を持ち、暗黙の依存（phantom dependency）を防止している。`saveWorkspaceProtocol: false` は `workspace:*` プロトコルの自動付与を抑制し、publish 時の互換性を保つ。

### 8. tree-shaking 対応の `/*@__PURE__*/` アノテーション

```typescript
// packages/zod/src/v4/core/schemas.ts:185
export const $ZodType: core.$constructor<$ZodType> = /*@__PURE__*/ core.$constructor("$ZodType", ...);

// packages/zod/src/v4/core/core.ts:17
export /*@__NO_SIDE_EFFECTS__*/ function $constructor<T extends ZodTrait, D = T["_zod"]["def"]>(...)
```

`$constructor` ファクトリ関数に `@__NO_SIDE_EFFECTS__` を付け、各スキーマ定義に `@__PURE__` を付けることで、バンドラーが未使用スキーマを安全に削除できる。`package.json` の `"sideEffects": false` と合わせて、tree-shaking の 3 層防御（パッケージレベル・関数レベル・呼び出しレベル）を実現している。

## パターンカタログ

- **Lazy Initialization（遅延初期化）** (分類: 生成)
  - 解決する問題: モジュール間の循環依存による初期化時のエラー / undefined 参照
  - 適用条件: 相互参照するモジュール間でプロパティを共有する必要がある場合
  - コード例: `packages/zod/src/v4/core/util.ts:266-289` (`defineLazy`)
  - 注意点: 循環検出時に `undefined` を返すため、呼び出し側で `undefined` が来る前提のハンドリングが必要

- **Self-Caching Accessor（自己書き換えアクセサ）** (分類: 振る舞い)
  - 解決する問題: 高コストな計算結果のキャッシュ。Map/WeakMap による外部キャッシュ管理の複雑さ回避
  - 適用条件: 計算結果が不変で、初回アクセス後に再計算が不要な場合
  - コード例: `packages/zod/src/v4/core/util.ts:223-235` (`cached`)、`util.ts:613` (`assignProp` セルフキャッシュ)
  - 注意点: `Object.defineProperty` による上書きは `configurable: true` が前提。frozen オブジェクトには適用不可

## Good Patterns

- **センチネル値による循環検出**: `defineLazy` は `EVALUATING` Symbol をセンチネルとして使い、再帰的な getter 呼び出しを安全に短絡する。boolean フラグと異なり Symbol は名前空間を汚染せず、`undefined` との区別も確実にできる。
  ```typescript
  // packages/zod/src/v4/core/util.ts:264-278
  const EVALUATING = Symbol("evaluating");
  // getter 内:
  if (value === EVALUATING) {
    return undefined as T[K]; // 循環を検出して安全に中断
  }
  if (value === undefined) {
    value = EVALUATING;
    value = getter();
  }
  ```

- **`import type` と ランタイム import の分離**: `v4/core/util.ts` は 4 つの import がすべて `import type` であり、他モジュールへのランタイム依存がゼロ。これにより、どのモジュールからでも安全に import できるリーフノードとなり、依存グラフの DAG 性を保っている。
  ```typescript
  // packages/zod/src/v4/core/util.ts:1-4
  import type * as checks from "./checks.js";
  import type { $ZodConfig } from "./core.js";
  import type * as errors from "./errors.js";
  import type * as schemas from "./schemas.js";
  ```

- **barrel export を迂回するローカル組み立て**: `from-json-schema.ts` は index.ts（barrel）への循環依存を避けるため、必要なモジュールを個別 import してローカルに `z` オブジェクトを構築している。barrel export は利便性を提供する反面、循環の温床になりやすいため、内部モジュールからは直接 import する。
  ```typescript
  // packages/zod/src/v4/classic/from-json-schema.ts:8-13
  // Local z object to avoid circular dependency with ../index.js
  const z = {
    ..._schemas,
    ..._checks,
    iso: _iso,
  };
  ```

- **`@__PURE__` / `@__NO_SIDE_EFFECTS__` による tree-shaking 補助**: スキーマ定義のファクトリ呼び出しに `@__PURE__` を付け、バンドラーに「この呼び出しは副作用がない」と伝える。Zod では 40 以上のスキーマ定義すべてにこのアノテーションを付与している。
  ```typescript
  // packages/zod/src/v4/core/core.ts:17
  export /*@__NO_SIDE_EFFECTS__*/ function $constructor<T extends ZodTrait, D = T["_zod"]["def"]>(...)
  // packages/zod/src/v4/core/schemas.ts:185
  export const $ZodType: core.$constructor<$ZodType> = /*@__PURE__*/ core.$constructor("$ZodType", ...);
  ```

## Anti-Patterns / 注意点

- **barrel export 経由の内部 import**: 内部モジュールが自パッケージの barrel export（index.ts）を import すると循環が発生しやすい。Zod ではこれを `from-json-schema.ts` のコメントで明示的に警告している。

  Bad:
  ```typescript
  // 内部モジュールから barrel export を import — 循環依存の原因
  import z from "../index.js";
  ```

  Better:
  ```typescript
  // 必要なモジュールのみ直接 import
  import * as _checks from "./checks.js";
  import * as _schemas from "./schemas.js";
  const z = { ..._schemas, ..._checks };
  ```

- **循環依存の暗黙的許容**: `madge --exclude` で循環を除外する場合、除外範囲が広がると検出能力が低下する。Zod では除外対象を `v4/core`（設計上不可避）、`v3`（レガシー）、`iso.ts`（特殊）の 3 つに限定し、新規モジュールは原則として除外しない方針を取っている。

  Bad:
  ```bash
  # 除外範囲を広げすぎて検出能力が失われる
  madge --circular --exclude '(core|classic|mini)' packages/zod/src
  ```

  Better:
  ```bash
  # 除外は最小限に絞り、理由をコメントで明記する
  madge --circular --exclude '(v4/core|v3|iso\.ts)' packages/zod/src
  ```

## 導出ルール

- `[MUST]` 循環依存が不可避なモジュール間では、遅延初期化（Object.defineProperty getter）を使ってプロパティアクセスを初期化時点から切り離す
  - 根拠: Zod の `defineLazy` は `EVALUATING` センチネルで循環検出を行い、40 箇所以上のスキーマ初期化で使用されている（`schemas.ts` 全体）

- `[MUST]` CI に静的循環依存チェックツール（madge 等）を組み込み、既知の例外は `--exclude` で最小限に管理する
  - 根拠: `.github/workflows/test.yml:50-60` で `check-circular` ジョブが PR ごとに実行され、除外対象は 3 パターンに限定されている

- `[SHOULD]` 型のみが必要な import は `import type` を使い、ランタイム依存グラフから除外する
  - 根拠: `v4/core/util.ts:1-4` は 4 つの import すべてが `import type` であり、ランタイム依存ゼロのリーフモジュールとして機能している

- `[SHOULD]` 高コストだが不変な計算結果は、セルフキャッシュ getter（初回アクセスで自身を実値に上書き）で遅延評価する
  - 根拠: `pick`/`omit`/`extend`/`merge`/`partial`/`required` の 6 関数すべてで `assignProp(this, "shape", ...)` パターンが使用されている（`util.ts:613-793`）

- `[SHOULD]` tree-shaking 対応ライブラリでは、ファクトリ関数に `@__NO_SIDE_EFFECTS__`、呼び出し側に `@__PURE__` を付与し、`package.json` に `"sideEffects": false` を設定する
  - 根拠: `core.ts:17` のファクトリ定義と `schemas.ts` の 40 以上のスキーマ定義すべてにアノテーションが付与されている

- `[SHOULD]` 内部モジュールは barrel export（index.ts）を経由せず、必要なモジュールを直接 import する
  - 根拠: `from-json-schema.ts:8` のコメント「Local z object to avoid circular dependency with ../index.js」

- `[AVOID]` ライブラリの内部モジュールから自パッケージの barrel export を import する — 循環依存の最も一般的な原因となる
  - 根拠: `from-json-schema.ts` で明示的にこのパターンを回避し、個別 import で代替している

- `[AVOID]` 循環依存チェックの除外範囲を安易に拡大する — 新規モジュールの追加時に循環が検出されなくなる
  - 根拠: Zod の `check:circular` は除外を `v4/core`（設計上不可避）、`v3`（レガシー）、`iso.ts`（特殊）の 3 つのみに限定している

## 適用チェックリスト

- [ ] プロジェクトの循環依存を `madge --circular --extensions ts src/` で検出し、現状を把握する
- [ ] 検出された循環依存のうち、設計上不可避なものは `defineLazy` パターンで遅延初期化に置き換える
- [ ] 型のみが必要な import を `import type` に置き換え、ランタイム依存を削減する
- [ ] CI に `madge --circular` チェックを追加し、新規循環依存の混入を自動検出する
- [ ] barrel export（index.ts）を内部モジュールから import している箇所を特定し、直接 import に置き換える
- [ ] ライブラリを公開している場合、`package.json` に `"sideEffects": false` を設定し、ファクトリ関数に `@__PURE__` / `@__NO_SIDE_EFFECTS__` を付与する
- [ ] `pnpm-workspace.yaml` で `hoistWorkspacePackages: false` を設定し、phantom dependency を防止する
