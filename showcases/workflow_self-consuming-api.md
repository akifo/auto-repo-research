# Workflow: Self-Consuming API

> 出典: [repos/trpc/trpc](../repos/trpc/trpc/)
> カテゴリ: workflow

## 概要

ライブラリのファーストパーティ adapter/プラグインを公開 API のみで実装し、ESLint `no-restricted-imports` で内部モジュールへの直接アクセスを禁止する「自己消費テスト」ワークフロー。ファーストパーティコードがサードパーティと同じ制約下で開発されることにより、公開 API の十分性が継続的に検証される。lint ルール違反（`eslint-disable` コメント）の蓄積は「公開 API が不足している」シグナルとして機能し、API 拡充の判断材料になる。

## 背景・文脈

ライブラリがファーストパーティの adapter やプラグインを提供する場合、内部コードは公開 API を迂回して内部モジュールに直接アクセスしがちである。この状態では以下の問題が起きる:

1. **サードパーティの再現不可能性**: ファーストパーティ adapter が内部 API に依存している場合、サードパーティが同等の adapter を作成できない。ドキュメントに「adapter を自由に作れます」と書いても、実際には公開 API が不十分で実現不可能になる
2. **公開 API の品質検証の欠如**: ファーストパーティが内部 API を使っている限り、公開 API の使い勝手やカバレッジに関するフィードバックが得られない
3. **破壊的変更の検知漏れ**: 内部 API を変更した際、ファーストパーティ adapter は同時に修正されるが、サードパーティ adapter が壊れることに気づけない

tRPC（7 パッケージ・15+ subpath exports・8+ adapter を持つ TypeScript モノレポ）は、ESLint ルールで adapter コードから内部モジュール (`unstable-core-do-not-import`) への直接 import を禁止し、代わりに公開 API 相当のローカルファサード (`src/@trpc/server/`) 経由の import を強制している。これにより、Express・Fetch・Next.js・AWS Lambda 等の全ファーストパーティ adapter がサードパーティと同じ制約下で開発されている。

## 実装パターン

### 1. 公開 API のローカルファサードを作成する

adapter コードが公開 API と同等のインターフェースで内部にアクセスするための中間層を用意する。tRPC では `packages/server/src/@trpc/server/` ディレクトリがこの役割を果たす。

```typescript
// packages/server/src/@trpc/server/index.ts:1-14 (trpc/trpc)
// 公開 API と同等のエクスポートを提供するローカルファサード
export {
  TRPCError,
  experimental_standaloneMiddleware,
  initTRPC,
  getTRPCErrorFromUnknown,
  transformTRPCResponse,
  // ...型エクスポート
} from '../../unstable-core-do-not-import';
```

```typescript
// packages/server/src/@trpc/server/http.ts:1-6 (trpc/trpc)
// adapter 向けの HTTP ユーティリティも公開 API と同等のパスで提供
export {
  getHTTPStatusCode,
  getHTTPStatusCodeFromError,
  resolveResponse,
} from '../../unstable-core-do-not-import';
```

### 2. ESLint `no-restricted-imports` で境界を強制する

adapter ディレクトリ内から内部モジュールへの直接 import を禁止し、ファサード経由の import を強制する。エラーメッセージに「なぜ」と「代替手段」を明記する。

```javascript
// eslint.config.js:173-191 (trpc/trpc)
{
  files: ['packages/server/src/adapters/**/*'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@trpc/server'],
            // npm パッケージ名での import を禁止（相対パスのファサードを使う）
          },
          {
            group: ['unstable-core-do-not-import'],
            message:
              'Use e.g. `../@trpc/server/http` instead - avoiding importing core helps us ensure third party adapters can be made',
          },
        ],
      },
    ],
  },
},
```

### 3. adapter はファサード経由でのみコアにアクセスする

全 adapter ファイルの冒頭にサードパーティ向けの案内コメントを統一的に記載し、公開 API パスからの import を示す。

```typescript
// packages/server/src/adapters/fetch/fetchRequestHandler.ts:1-9 (trpc/trpc)
/**
 * If you're making an adapter for tRPC and looking at this file for reference,
 * you should import types and functions from `@trpc/server` and `@trpc/server/http`
 */
import type { AnyRouter } from '../../@trpc/server';
import {
  type ResolveHTTPRequestOptionsContextFn,
  resolveResponse,
} from '../../@trpc/server/http';
```

### 4. `eslint-disable` の蓄積を API 不足のシグナルとして監視する

公開 API でカバーできない低レベル操作が必要な場合は `eslint-disable` で明示的に例外化する。この例外の蓄積を定期的にレビューし、頻出するパターンは公開 API への昇格を検討する。

```typescript
// packages/server/src/adapters/standalone.ts:15-16 (trpc/trpc)
import { type AnyRouter } from '../@trpc/server';
// eslint-disable-next-line no-restricted-imports
import { run } from '../unstable-core-do-not-import';
```

```typescript
// packages/server/src/adapters/ws.ts:28-39 (trpc/trpc)
// eslint-disable が 3 箇所蓄積 = run, isAsyncIterable 等が公開 API に不足
// eslint-disable-next-line no-restricted-imports
import { isAsyncIterable, isObject, isTrackedEnvelope, run, type MaybePromise } from '../unstable-core-do-not-import';
// eslint-disable-next-line no-restricted-imports
import type { Result } from '../unstable-core-do-not-import';
// eslint-disable-next-line no-restricted-imports
import { iteratorResource } from '../unstable-core-do-not-import/stream/utils/asyncIterable';
```

## Good Example

公開 API のみで完結する adapter 実装。Fetch adapter は内部モジュールへの `eslint-disable` が一切不要。

```typescript
// packages/server/src/adapters/fetch/fetchRequestHandler.ts:24-80 (trpc/trpc)
// Good: 全 import がファサード経由 -- eslint-disable なし
import type { AnyRouter } from '../../@trpc/server';
import {
  type ResolveHTTPRequestOptionsContextFn,
  resolveResponse,
} from '../../@trpc/server/http';

export async function fetchRequestHandler<TRouter extends AnyRouter>(
  opts: FetchHandlerRequestOptions<TRouter>,
): Promise<Response> {
  const resHeaders = new Headers();
  const createContext: ResolveHTTPRequestOptionsContextFn<TRouter> = async (
    innerOpts,
  ) => {
    return opts.createContext?.({ req: opts.req, resHeaders, ...innerOpts });
  };
  const url = new URL(opts.req.url);
  const path = trimSlashes(url.pathname.slice(trimSlashes(opts.endpoint).length));

  return await resolveResponse({
    ...opts,
    req: opts.req,
    createContext,
    path,
    error: null,
    onError(o) { opts?.onError?.({ ...o, req: opts.req }); },
  });
}
```

ESLint 設定と `eslint-disable` 監視の運用フロー:

```javascript
// eslint.config.js -- 自己消費テストの ESLint 設定
export default [
  // 1. adapter 層の境界強制
  {
    files: ['packages/server/src/adapters/**/*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['unstable-core-do-not-import'],
              message:
                'Use `../@trpc/server/http` instead - this ensures third party adapters can be made',
            },
          ],
        },
      ],
    },
  },
  // 2. パッケージ内自己参照の禁止
  // （各パッケージの package.json#eslintConfig で設定）
];
```

```jsonc
// packages/client/package.json:18-24 (trpc/trpc)
// 各パッケージで自身のパッケージ名からの import を禁止
{
  "eslintConfig": {
    "rules": {
      "no-restricted-imports": ["error", "@trpc/client"]
    }
  }
}
```

## Bad Example

```typescript
// Bad: adapter が内部モジュールを直接 import
// サードパーティは同じことができない
import { resolveResponse } from '../unstable-core-do-not-import/http';
import { getErrorShape } from '../unstable-core-do-not-import/error';
import { callTRPCProcedure } from '../unstable-core-do-not-import/procedure';

// -> サードパーティ adapter 作者が参考にしても再現不可能
// -> 内部リファクタリングで全 adapter が壊れるリスク
// -> 公開 API の不足に気づくフィードバックループが存在しない
```

```typescript
// Bad: eslint-disable が蓄積しても放置する
// packages/server/src/adapters/next-app-dir/nextAppDirCaller.ts:3-12 (trpc/trpc)
// eslint-disable-next-line no-restricted-imports
import { formDataToObject } from '../../unstable-core-do-not-import';
// FIXME: fix lint rule, this is ok
// eslint-disable-next-line no-restricted-imports
import type { ErrorHandlerOptions } from '../../unstable-core-do-not-import/procedure';
// FIXME: fix lint rule, this is ok
// eslint-disable-next-line no-restricted-imports
import type { CallerOverride } from '../../unstable-core-do-not-import/procedureBuilder';

// -> eslint-disable が 4 箇所 + FIXME コメント
// -> formDataToObject, ErrorHandlerOptions 等は公開 API に昇格すべきシグナル
// -> 放置するとルールへの信頼が低下し、形骸化する
```

```javascript
// Bad: 境界強制なしの ESLint 設定
export default [
  {
    rules: {
      // adapter 専用のルールがない
      // -> 内部 import が静かに増殖する
    },
  },
];
```

## 適用ガイド

### どのような状況で使うべきか

- **ライブラリがファーストパーティの adapter/プラグインを同一リポジトリ内で提供している場合**: Express adapter, Next.js adapter 等を公式に提供するライブラリで、サードパーティによる独自 adapter の作成も想定している場合
- **モノレポで複数パッケージが内部 API を共有している場合**: 公開パッケージと内部ユーティリティの境界が曖昧になりがちな構成で、意図しない内部依存の拡大を防ぎたい場合
- **公開 API のカバレッジを客観的に測定したい場合**: `eslint-disable` の数と箇所が「公開 API でカバーできていない機能」の定量的な指標になる

### 導入手順

1. **公開 API のファサードを作成する**: adapter がアクセスする必要のある関数・型を、公開 API と同等のパスで re-export するファサードディレクトリを用意する
2. **ESLint ルールを設定する**: `no-restricted-imports` で adapter ディレクトリから内部モジュールへの直接 import を禁止する。エラーメッセージに代替パスを明記する
3. **既存の adapter を移行する**: 内部 import をファサード経由に置き換える。置き換え不可能なものは `eslint-disable` で明示的に例外化する
4. **`eslint-disable` を定期レビューする**: 同一パターンの例外が 3 箇所以上蓄積した場合、対象の関数・型を公開 API に昇格することを検討する
5. **adapter ファイルの冒頭に案内コメントを記載する**: サードパーティ作者が参照すべき公開 API パスを明記する

### カスタマイズポイント

- **ファサードの粒度**: tRPC は `@trpc/server` (root) と `@trpc/server/http` (HTTP ユーティリティ) の 2 層だが、adapter の種類に応じて `@trpc/server/ws`、`@trpc/server/lambda` 等のドメイン別ファサードを追加できる
- **段階的導入**: 既存コードに一括適用すると大量の `eslint-disable` が発生する。まず新規 adapter に適用し、既存 adapter は段階的に移行するアプローチが実用的
- **`eslint-disable` の自動集計**: `grep -r "eslint-disable.*no-restricted-imports" packages/server/src/adapters/ | wc -l` を CI で実行し、例外数の推移をトラッキングすることで API 拡充の優先度付けに活用できる

### 注意点

- **ファサードの網羅性が前提**: ファサードが公開 API の全機能をカバーしていないと、adapter 作者が `eslint-disable` を多用せざるを得ず、ワークフローの意義が薄れる。初期設計時に全 adapter のユースケースを洗い出すことが重要
- **`eslint-disable` を「悪」と見なさない**: 例外は「公開 API でまだカバーされていない領域」を可視化する有用なシグナルである。ゼロにすることが目標ではなく、蓄積パターンを分析して API 拡充の判断材料にすることが目的
- **ESLint のみでは完全な強制にならない**: `eslint-disable` コメントで回避可能なため、コードレビューとの併用が望ましい。命名規約（`unstable-core-do-not-import` のような警告的な名前）との二重防御が効果的

## 導出ルール

- `[MUST]` ファーストパーティ adapter/プラグインは公開 API のみを使って実装し、内部モジュールへの直接アクセスを ESLint `no-restricted-imports` で禁止する
  - 根拠: tRPC は adapter ディレクトリ内から `unstable-core-do-not-import` への直接 import を禁止し、サードパーティと同じ制約下でファーストパーティ adapter を開発している (`eslint.config.js:173-191`)

- `[MUST]` `no-restricted-imports` のエラーメッセージに「なぜ禁止しているか」と「代替手段」を明記する
  - 根拠: tRPC のメッセージ `'Use e.g. ../@trpc/server/http instead - avoiding importing core helps us ensure third party adapters can be made'` は、禁止理由と代替パスの両方を開発者に伝えている

- `[SHOULD]` `eslint-disable` コメントが同一ルール・同一パターンで 3 箇所以上蓄積した場合、対象の関数・型を公開 API に昇格することを検討する
  - 根拠: tRPC の `ws.ts` では `run`, `isAsyncIterable` 等のユーティリティに対する `eslint-disable` が 3 箇所蓄積しており、これらが公開 API に不足していることを示すシグナルになっている

- `[SHOULD]` adapter ファイルの冒頭にサードパーティ作者向けの import ガイダンスをコメントで記載する
  - 根拠: tRPC の全 adapter ファイルに `"If you're making an adapter... you should import from @trpc/server and @trpc/server/http"` という統一コメントがある (`fetchRequestHandler.ts:1-9`)

- `[AVOID]` 内部モジュールの命名に意図を込めずに公開すること。不安定な内部 API には `unstable-`、`internal-`、`do-not-import` 等の警告的な名前を付け、命名と lint の二重防御で境界を守る
  - 根拠: tRPC は `unstable-core-do-not-import` というディレクトリ名自体が使用を抑止するドキュメントとして機能し、ESLint ルールと併せて二重の防御線を形成している

## 参考

- [repos/trpc/trpc/project-structure.md](../repos/trpc/trpc/project-structure.md) -- モノレポ構成と ESLint 境界強制の全体像
- [repos/trpc/trpc/api-design-practices.md](../repos/trpc/trpc/api-design-practices.md) -- 3 層エクスポート戦略と ESLint によるインポート境界
- [repos/trpc/trpc/adapter-implementation-patterns.md](../repos/trpc/trpc/adapter-implementation-patterns.md) -- adapter のアーキテクチャとファサードパターン
- [repos/trpc/trpc/dev-conventions.md](../repos/trpc/trpc/dev-conventions.md) -- ESLint flat config による開発規約
