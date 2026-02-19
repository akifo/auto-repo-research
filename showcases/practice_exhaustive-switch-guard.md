# Practice: Exhaustive Switch Guard

> 出典: [repos/vitejs/vite](../repos/vitejs/vite/), [repos/ryoppippi/ccusage](../repos/ryoppippi/ccusage/)
> カテゴリ: practice

## 概要

`satisfies never` または `unreachable(value: never): never` ヘルパーを switch/if 文の末尾に配置し、discriminated union の全ケース網羅をコンパイル時に保証するプラクティス。新しい variant が追加された際、対応する分岐がなければ型エラーとしてコンパイラが検出するため、ランタイムで初めて気づくバグを未然に防げる。

## 背景・文脈

TypeScript の discriminated union（判別共用体）を switch/if 文で分岐処理する場面は多い。問題は、後から union に新しいメンバーを追加したときに、分岐の追加漏れがコンパイラに検出されないことにある。`default` ケースでフォールスルーしたり、if-else チェーンの末尾で暗黙に `undefined` を返したりすると、未処理の variant がランタイムまで潜伏する。

Vite は大規模ビルドツールとして、ログレベル・CSS プリプロセッサ言語・設定オプションなど多数の列挙的な型を扱う。これらの分岐漏れはビルド結果の不整合やサイレントなバグに直結するため、`satisfies never` による網羅性チェックをコードベース全体で一貫して採用している。

ccusage は `CostMode` などのユニオン型に対して `unreachable(value: never): never` ヘルパー関数を使い、型チェックとランタイムエラーの両方で分岐漏れを防いでいる。

2つのリポジトリはアプローチが異なるが、目的は同一: **union 型の分岐漏れをコンパイル時に検出し、variant 追加を安全にする**。

## 実装パターン

### パターン A: `satisfies never`（Vite 方式）

`default` ケースで変数に `satisfies never` を付与する。すべての分岐が網羅されていれば、`default` に到達する時点で変数の型は `never` に絞り込まれるため、`satisfies never` は型エラーにならない。分岐が不足していると、変数に残った型が `never` ではないため型エラーになる。

```typescript
// packages/vite/src/node/plugins/css.ts:3278-3279
default:
  throw new Error(`Unknown lang: ${lang satisfies never}`)
```

```typescript
// packages/vite/src/node/build.ts:1119-1121
default:
  logLeveling satisfies never
  // fallback to info if a unknown log level is passed
```

Vite では `build.ts`, `config.ts`, `css.ts`, `oxc.ts` など 4 箇所以上でこのパターンが使われている。

### パターン B: `unreachable(value: never): never` ヘルパー（ccusage 方式）

`never` 型の引数を受け取り、ランタイムエラーを throw するヘルパー関数を定義する。コンパイル時の型チェックに加えて、万が一ランタイムで到達した場合にもエラーメッセージで原因値を報告する。

```typescript
// apps/ccusage/src/_utils.ts:5-7
export function unreachable(value: never): never {
  throw new Error(`Unreachable code reached with value: ${value as any}`);
}
```

```typescript
// apps/ccusage/src/data-loader.ts:634-666
if (mode === 'display') { return data.costUSD ?? 0; }
if (mode === 'calculate') { ... }
if (mode === 'auto') { ... }
unreachable(mode);  // CostMode の分岐が漏れていればコンパイルエラー
```

if-else チェーンでも switch 文でも、最後に `unreachable(variable)` を置けば網羅性が保証される。

## Good Example

### 新しい variant 追加時にコンパイラが漏れを検出する

```typescript
// 初期状態: 2つの variant を持つ union
type LogLevel = "info" | "warn";

function getLogPrefix(level: LogLevel): string {
  switch (level) {
    case "info":
      return "[INFO]";
    case "warn":
      return "[WARN]";
    default:
      level satisfies never; // OK: すべての variant を網羅している
      return "[UNKNOWN]";
  }
}
```

```typescript
// 'error' を追加した場合
type LogLevel = "info" | "warn" | "error";
//                                 ^^^^^  新しい variant

function getLogPrefix(level: LogLevel): string {
  switch (level) {
    case "info":
      return "[INFO]";
    case "warn":
      return "[WARN]";
    default:
      level satisfies never;
      // ~~~~ 型エラー: Type 'string' does not satisfy the expected type 'never'.
      //      'error' の分岐が未処理であることをコンパイラが検出
      return "[UNKNOWN]";
  }
}
```

### unreachable ヘルパーで型チェック + ランタイム防御を両立する

```typescript
// unreachable ヘルパーを使う場合
function getLogPrefix(level: LogLevel): string {
  switch (level) {
    case "info":
      return "[INFO]";
    case "warn":
      return "[WARN]";
    case "error":
      return "[ERROR]";
    default:
      unreachable(level);
      // コンパイル時: level は never に絞り込まれているので型エラーなし
      // ランタイム: 万が一到達したら "Unreachable code reached with value: ..." を throw
  }
}
```

### Vite の実例: CSS プリプロセッサ言語の分岐

```typescript
// packages/vite/src/node/plugins/css.ts:3270-3279 (簡略化)
switch (lang) {
  case "less":
    return compileLess(/* ... */);
  case "sass":
  case "scss":
    return compileSass(/* ... */);
  case "styl":
  case "stylus":
    return compileStylus(/* ... */);
  default:
    throw new Error(`Unknown lang: ${lang satisfies never}`);
    // 新しい CSS プリプロセッサのサポートを追加したとき、
    // ここの型エラーで分岐の追加漏れに気づける
}
```

### ccusage の実例: CostMode の if チェーン

```typescript
// apps/ccusage/src/data-loader.ts:634-666 (簡略化)
function calculateCostForEntry(mode: CostMode, data: UsageData): number {
  if (mode === "display") {
    return data.costUSD ?? 0;
  }
  if (mode === "calculate") {
    return computeFromTokens(data);
  }
  if (mode === "auto") {
    return data.costUSD ?? computeFromTokens(data);
  }
  unreachable(mode);
  // CostMode に新しいモードが追加されたらコンパイルエラー
}
```

## Bad Example

### default で何もしない / 暗黙のフォールスルー

```typescript
// Bad: default ケースでサイレントに処理を続行
type Action = "create" | "update" | "delete";

function handleAction(action: Action): void {
  switch (action) {
    case "create":
      createItem();
      break;
    case "update":
      updateItem();
      break;
    default:
      // 'delete' の処理が漏れているが、コンパイラは検出しない
      // サイレントに何もしない
      break;
  }
}
```

```typescript
// Good: satisfies never で網羅性を保証
function handleAction(action: Action): void {
  switch (action) {
    case "create":
      createItem();
      break;
    case "update":
      updateItem();
      break;
    default:
      action satisfies never;
      // ~~~~ 型エラー: Type '"delete"' does not satisfy 'never'
      break;
  }
}
```

### if-else チェーンで末尾チェックなし

```typescript
// Bad: else 節がないため、新しい variant で undefined が返る
type Format = "json" | "csv";

function serialize(data: unknown, format: Format): string {
  if (format === "json") {
    return JSON.stringify(data);
  }
  if (format === "csv") {
    return toCsv(data);
  }
  // 'xml' が追加されても、ここに暗黙的に到達して undefined を返す
  // TypeScript の noImplicitReturns が有効でも、
  // 型を Format | string にすると検出できない
}
```

```typescript
// Good: unreachable で明示的に網羅性を保証
function serialize(data: unknown, format: Format): string {
  if (format === "json") {
    return JSON.stringify(data);
  }
  if (format === "csv") {
    return toCsv(data);
  }
  unreachable(format);
}
```

## 適用ガイド

### どのような状況で使うべきか

- **discriminated union を switch/if で分岐処理するすべての箇所**: 型が2つ以上の variant を持ち、今後追加される可能性がある場合に有効。Vite のように4箇所以上に一貫して適用することで、コードベース全体の安全性が向上する。
- **列挙的な設定値・モード・ステータスの分岐**: `LogLevel`, `CostMode`, `CssLang` のような、ドメイン固有の列挙型を扱う場面。
- **if-else チェーンの末尾**: switch 文だけでなく、if-else チェーンの最後に `unreachable(variable)` を配置することで同じ効果が得られる。ccusage はこのパターンを実践している。

### `satisfies never` と `unreachable` ヘルパーの使い分け

| 観点             | `satisfies never`                                  | `unreachable(value: never)`                         |
| ---------------- | -------------------------------------------------- | --------------------------------------------------- |
| 型チェック       | コンパイル時のみ                                   | コンパイル時 + ランタイム                           |
| ランタイム挙動   | 何もしない（後続コードが実行される）               | Error を throw する                                 |
| エラーメッセージ | なし                                               | 到達した値を報告できる                              |
| コード量         | ヘルパー不要、1行で完結                            | ヘルパー関数の定義が必要                            |
| 適した場面       | フォールバック処理がある場合（Vite の `build.ts`） | 到達すべきでない箇所（ccusage の `data-loader.ts`） |

Vite の `build.ts:1119-1121` のように、`satisfies never` の後にフォールバック処理を続ける使い方と、`css.ts:3278-3279` のように `throw new Error(... satisfies never)` でランタイムエラーも兼ねる使い方の両方がある。プロジェクトの方針に応じて選択する。

### 導入時の注意点

- **`strictNullChecks: true` が前提**: `strictNullChecks` が無効だと型の絞り込みが正しく機能せず、`never` まで絞り込まれない場合がある。
- **`string` リテラル型ではなく union 型を使う**: `type Action = string` では網羅性チェックが効かない。`type Action = 'create' | 'update' | 'delete'` のようにリテラル型の union にする必要がある。
- **ESLint の `switch-exhaustiveness-check` との併用**: `@typescript-eslint/switch-exhaustiveness-check` ルールを有効にすると、`satisfies never` を書き忘れた switch 文自体を lint で検出できる。ただし if-else チェーンには対応していないため、`unreachable` ヘルパーとの併用が望ましい。
- **`noUnusedLocals` との干渉**: `satisfies never` 単体の文（`level satisfies never;`）は式文として有効だが、一部のリンターが「未使用の式」として警告する場合がある。`throw new Error(... satisfies never)` の形式にすると回避できる。

### unreachable ヘルパーの最小テンプレート

```typescript
/**
 * Exhaustiveness check helper.
 * Causes a compile error if a switch/if chain is not exhaustive.
 * Throws at runtime if somehow reached.
 */
export function unreachable(value: never): never {
  throw new Error(`Unreachable code reached with value: ${value as any}`);
}
```

## 参考

- [repos/vitejs/vite/type-system-patterns.md](../repos/vitejs/vite/type-system-patterns.md) -- `satisfies never` による網羅性チェックの分析
- [repos/vitejs/vite/error-handling-idioms.md](../repos/vitejs/vite/error-handling-idioms.md) -- エラーハンドリング全般の分析
- [repos/ryoppippi/ccusage/type-system-patterns.md](../repos/ryoppippi/ccusage/type-system-patterns.md) -- `unreachable` 関数と exhaustiveness check の分析
- [repos/ryoppippi/ccusage/error-handling-idioms.md](../repos/ryoppippi/ccusage/error-handling-idioms.md) -- Result 型との組み合わせにおけるエラーハンドリング
