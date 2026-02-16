# Pattern: Self-filtering Strategy

> 出典: [repos/unjs/unbuild/abstraction-patterns.md](../repos/unjs/unbuild/abstraction-patterns.md), [repos/unjs/unbuild/architecture.md](../repos/unjs/unbuild/architecture.md)
> カテゴリ: pattern

## 概要

Self-filtering Strategy は、オーケストレーターが全ハンドラを無条件に呼び出し、各ハンドラが自分の処理対象かどうかを自ら判定して選別する設計パターンである。ディスパッチャ側に switch/if 分岐が一切不要になり、新しいハンドラの追加がタスク配列への 1 行追加で完結する。プラグインアーキテクチャやパイプラインの拡張性を劇的に向上させる実用的なパターンである。

## 背景・文脈

このパターンは [unjs/unbuild](https://github.com/unjs/unbuild) で観察された。unbuild は 4 つのビルダー（rollup, mkdist, untyped, copy）を持つライブラリビルドツールで、各ビルダーが同一の `BuildContext` を受け取りながら、それぞれ異なるビルド戦略を実行する。

従来の設計では、オーケストレーターがエントリの `builder` フィールドを見て switch/if で適切なビルダーに振り分けるのが一般的だ。しかし unbuild はこのアプローチを取らず、全ビルダーを常に呼び出し、各ビルダーが冒頭で「自分の担当エントリがあるか」をフィルタリングする設計を採用している。該当エントリがなければ何もせず即座に返るため、全ビルダーを常に呼び出してもオーバーヘッドは無視できる。

この設計が成立する前提は 3 つある:

1. **Discriminated Union**: エントリ自体が `builder` フィールドで自分の処理先を宣言している
2. **統一シグネチャ**: 全ハンドラが `(ctx: BuildContext) => Promise<void>` という同一の関数シグネチャを持つ
3. **共有コンテキスト**: 結果は戻り値ではなく、共有コンテキストへの副作用（`ctx.buildEntries.push`）で伝播する

## 実装パターン

### オーケストレーター: 全ハンドラを無条件に実行

```typescript
// unjs/unbuild — src/build.ts:293-306
const buildTasks = [
  typesBuild, // untyped
  mkdistBuild, // mkdist
  rollupBuild, // rollup
  copyBuild, // copy
] as const;

if (options.parallel) {
  await Promise.all(buildTasks.map((task) => task(ctx)));
} else {
  for (const task of buildTasks) {
    await task(ctx);
  }
}
```

オーケストレーターにはビルダーの種類を判定するロジックが一切ない。タスク配列を順に（または並列に）実行するだけである。

### 各ハンドラ: 自己フィルタリングで処理対象を選別

4 つのビルダー全てが同一のパターンで冒頭にフィルタリングを行う。

```typescript
// unjs/unbuild — src/builders/copy/index.ts:10-13
export async function copyBuild(ctx: BuildContext): Promise<void> {
  const entries = ctx.options.entries.filter(
    (e) => e.builder === "copy",
  ) as CopyBuildEntry[];
  // entries が空なら以降のループは実行されない
  // ...
}
```

```typescript
// unjs/unbuild — src/builders/mkdist/index.ts:7-10
export async function mkdistBuild(ctx: BuildContext): Promise<void> {
  const entries = ctx.options.entries.filter(
    (e) => e.builder === "mkdist",
  ) as MkdistBuildEntry[];
  // ...
}
```

```typescript
// unjs/unbuild — src/builders/untyped/index.ts:19-22
export async function typesBuild(ctx: BuildContext): Promise<void> {
  const entries = ctx.options.entries.filter(
    (entry) => entry.builder === "untyped",
  ) as UntypedBuildEntry[];
  // ...
}
```

```typescript
// unjs/unbuild — src/builders/rollup/config.ts:21-24
// rollup は getRollupOptions 内でフィルタリング
input: Object.fromEntries(
  ctx.options.entries
    .filter((entry) => entry.builder === "rollup")
    .map((entry) => [entry.name, resolve(ctx.options.rootDir, entry.input)]),
),
```

### Discriminated Union によるエントリの型定義

```typescript
// unjs/unbuild — src/types.ts:14-20
export interface BaseBuildEntry {
  builder?: "untyped" | "rollup" | "mkdist" | "copy";
  input: string;
  name?: string;
  outDir?: string;
  declaration?: "compatible" | "node16" | boolean;
}

// src/types.ts:36-41
export type BuildEntry =
  | BaseBuildEntry
  | RollupBuildEntry
  | UntypedBuildEntry
  | MkdistBuildEntry
  | CopyBuildEntry;
```

各専用エントリ型が `builder` フィールドをリテラル型で固定することで、データ自身が処理先を宣言する構造になっている。

## Good Example

### Self-filtering Strategy の実装

```typescript
// Good: ディスパッチャに分岐ロジックがない
// --- orchestrator.ts ---
const handlers = [
  handleMarkdown,
  handleTypeScript,
  handleCSS,
  handleImage,
] as const;

async function processFiles(ctx: ProcessContext): Promise<void> {
  for (const handler of handlers) {
    await handler(ctx);
  }
}

// --- handlers/markdown.ts ---
async function handleMarkdown(ctx: ProcessContext): Promise<void> {
  const files = ctx.files.filter((f) => f.type === "markdown");
  if (files.length === 0) return; // 該当なしなら即リターン
  for (const file of files) {
    // マークダウン固有の処理
  }
}

// --- handlers/typescript.ts ---
async function handleTypeScript(ctx: ProcessContext): Promise<void> {
  const files = ctx.files.filter((f) => f.type === "typescript");
  if (files.length === 0) return;
  for (const file of files) {
    // TypeScript 固有の処理
  }
}

// 新しいハンドラの追加: 配列に 1 行追加するだけ
// handleYAML を追加 → handlers 配列に handleYAML を追加
```

この設計では新しいファイルタイプのハンドラを追加する際、以下だけで済む:

1. 新しいハンドラ関数を定義する
2. `handlers` 配列に追加する

オーケストレーターのコードは一切変更不要。

## Bad Example

### switch/if によるディスパッチ（避けるべき実装）

```typescript
// Bad: ディスパッチャに全ハンドラの分岐ロジックが集中する
async function processFiles(ctx: ProcessContext): Promise<void> {
  for (const file of ctx.files) {
    switch (file.type) {
      case "markdown":
        await handleMarkdown(ctx, file);
        break;
      case "typescript":
        await handleTypeScript(ctx, file);
        break;
      case "css":
        await handleCSS(ctx, file);
        break;
      case "image":
        await handleImage(ctx, file);
        break;
      // 新しいタイプを追加するたびにここに case を追加する必要がある
      // → Open-Closed 原則に違反
      default:
        throw new Error(`Unknown file type: ${file.type}`);
    }
  }
}
```

この設計の問題点:

- **変更箇所が 2 か所**: 新しいハンドラ関数の定義 + ディスパッチャの switch 文の修正が必要
- **ディスパッチャの肥大化**: ハンドラの数に比例して switch 文が膨らむ
- **ハンドラの知識がディスパッチャに漏れる**: どのハンドラがどのタイプを処理するかをディスパッチャが知っている必要がある
- **テストの脆さ**: ディスパッチャのテストがハンドラの追加で壊れる

### 型安全性の妥協に関する注意

unbuild の実装では `filter()` 後に `as CopyBuildEntry[]` のような型アサーションを使っている。これは動作するが、型安全性を損なう:

```typescript
// Bad: as キャストで型安全性を損なう
const entries = ctx.options.entries.filter(
  (e) => e.builder === "copy",
) as CopyBuildEntry[];

// Better: 型ガード関数で型安全にフィルタリング
function isCopyEntry(e: BuildEntry): e is CopyBuildEntry {
  return e.builder === "copy";
}
const entries = ctx.options.entries.filter(isCopyEntry);
```

型ガード関数を使えば TypeScript コンパイラが型の整合性を検証するため、`builder` フィールドの値とエントリ型の不一致を検出できる。

## 適用ガイド

### いつ使うべきか

- **複数の処理戦略が存在し、データ自身が処理先を示せる場合**: ファイルタイプ、イベント種別、プラグイン種別など、データに「自分はどのハンドラが処理すべきか」を示すフィールドがある場合に適用できる
- **ハンドラの追加が頻繁に発生する場合**: プラグインシステムやパイプラインのように、拡張ポイントとして新しいハンドラの追加が想定されるアーキテクチャ
- **ハンドラ間に依存関係がない場合**: 各ハンドラが独立して動作し、他のハンドラの結果に依存しない設計

### いつ使うべきでないか

- **ハンドラの数が 2 個以下**: 過剰な抽象化になる。単純な if/else で十分
- **処理対象の判定が複雑**: フィルタリング条件が単純なフィールド比較ではなく、複数条件の組み合わせや外部状態に依存する場合は、判定ロジックをハンドラに埋め込むと各ハンドラが複雑になる
- **パフォーマンスが最重要**: 全ハンドラを呼び出すオーバーヘッドが許容できない場合（ただし、unbuild のようにフィルタリングが O(n) の配列走査であれば、ほとんどのケースで無視できる）

### 導入時の注意点

1. **統一シグネチャの設計**: 全ハンドラが同じ関数シグネチャ `(ctx: Context) => Promise<void>` を持つことが前提。戻り値で結果を返す設計にするとオーケストレーターが型の違いを吸収する必要が生じ、パターンの利点が薄れる
2. **共有コンテキストの設計**: 結果を蓄積する場所（配列や Set）をコンテキストに含める。ハンドラは副作用でコンテキストに書き込む
3. **並列実行の安全性**: `Promise.all` で並列実行する場合、共有コンテキストへの書き込みが競合しないか確認する。JavaScript の配列 `push` は単一スレッドでは安全だが、非同期処理の合間に状態が変わりうる点に注意
4. **暗黙的プロトコルの文書化**: ハンドラが従うべきルール（フックの呼び出し順序、コンテキストへの書き込み規約など）が暗黙的になりやすい。ハンドラの数が 5 個を超える場合は、明示的なインターフェース定義を検討する

### カスタマイズポイント

- **フィルタリング条件**: `builder` フィールドの完全一致だけでなく、正規表現や述語関数でのマッチングに拡張できる
- **実行順序**: 配列の順序で実行順を制御できる。優先度フィールドを持たせてソートすることも可能
- **逐次/並列の切り替え**: unbuild のように `parallel` オプションで切り替える設計にすると、デバッグ時は逐次、本番は並列という運用ができる
- **早期終了**: あるハンドラが処理を完了したら後続をスキップする仕組みを追加すれば、Chain of Responsibility パターンとのハイブリッドになる

## 参考

- [repos/unjs/unbuild/abstraction-patterns.md](../repos/unjs/unbuild/abstraction-patterns.md) -- Self-filtering パターンと Discriminated Union の詳細分析
- [repos/unjs/unbuild/architecture.md](../repos/unjs/unbuild/architecture.md) -- ビルダー統合パターンとコンテキストオブジェクト設計
