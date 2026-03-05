# design-philosophy

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn/ui は「ライブラリではなくコード配布」という設計思想を徹底的に実装したプロジェクトである。従来の UI ライブラリが npm パッケージとして依存関係に追加されるのに対し、shadcn/ui はコンポーネントのソースコードをユーザーのプロジェクトに直接コピーする。この「コードの所有権をユーザーに渡す」というアプローチは、CLI ツール・レジストリシステム・AST ベースの変換パイプライン・コンポーネント設計パターンの全てに一貫して影響を与えており、ソフトウェア配布のパラダイムシフトとして分析に値する。

## 背景にある原則

- **所有権の譲渡**: ライブラリとして依存関係に閉じ込めるのではなく、コードの所有権をユーザーに渡すべき。なぜなら、UI コンポーネントはビジネスロジックに密結合しやすく、カスタマイズの自由度が制約されると開発者体験が著しく悪化するため。README の "Use this to build your own component library" という記述がこの原則を端的に示している。

- **適応的配布**: コードを配布する際、受け取り側の環境に合わせてコードを変換すべき。shadcn/ui は AST ベースの変換パイプライン（`packages/shadcn/src/utils/transformers/index.ts`）で、import パス・RSC ディレクティブ・アイコンライブラリ・CSS 変数・RTL サポートなどを受け取り手の設定に応じて自動変換する。これにより、配布元は単一の正規形を保ちつつ、多様な環境に対応できる。

- **スキーマ駆動の契約**: 配布物の構造を Zod スキーマで厳密に定義し、レジストリアイテムの型安全性を保証すべき。`registryItemSchema`（`packages/shadcn/src/registry/schema.ts`）が全ての配布物の契約として機能し、CLI・MCP サーバー・サードパーティレジストリの全てがこの契約に従う。

- **最小の抽象化レイヤー**: コンポーネントは薄いラッパーであるべきで、独自の抽象化層を最小限にすべき。shadcn/ui のコンポーネントは Radix UI プリミティブの上に `cn()` で Tailwind クラスを適用するだけの薄い層であり、ユーザーが内部を理解・変更しやすい設計になっている。

## 実例と分析

### AST ベースのコード変換パイプライン

コード配布の核心は「レジストリに格納された正規形のコードを、ユーザーの環境に合わせて変換する」仕組みにある。`transform` 関数（`packages/shadcn/src/utils/transformers/index.ts:42-71`）は、ts-morph を使った AST 操作で以下の変換を順次適用する:

```typescript
// packages/shadcn/src/utils/transformers/index.ts:42-52
export async function transform(
  opts: TransformOpts,
  transformers: Transformer[] = [
    transformImport,
    transformRsc,
    transformCssVars,
    transformTwPrefixes,
    transformRtl,
    transformIcons,
    transformCleanup,
  ],
);
```

各 transformer は `Transformer` 型（`SourceFile` を受け取り `SourceFile` を返す関数）に統一されており、パイプラインへの追加・削除が容易である。例えば `transformRsc`（`packages/shadcn/src/utils/transformers/transform-rsc.ts:6-18`）は、ユーザーが RSC を使わない場合に `"use client"` ディレクティブを除去する:

```typescript
// packages/shadcn/src/utils/transformers/transform-rsc.ts:6-18
export const transformRsc: Transformer = async ({ sourceFile, config }) => {
  if (config.rsc) {
    return sourceFile;
  }
  const first = sourceFile.getFirstChildByKind(SyntaxKind.ExpressionStatement);
  if (first && directiveRegex.test(first.getText())) {
    first.remove();
  }
  return sourceFile;
};
```

また `transformImport`（`packages/shadcn/src/utils/transformers/transform-import.ts`）はレジストリ内部の `@/registry/new-york-v4/ui/button` のような import パスを、ユーザーの `components.json` で設定されたエイリアス（`@/components/ui/button` 等）に書き換える。これはテキスト置換ではなく AST の `ImportDeclaration` を操作するため、コード構造を壊さない。

### レジストリシステムと名前空間

レジストリは JSON ベースのコンポーネントカタログであり、名前空間（`@shadcn`, `@v0`, `@acme` 等）で分離される。`BUILTIN_REGISTRIES`（`packages/shadcn/src/registry/constants.ts:33-35`）はデフォルトのレジストリを定義する:

```typescript
// packages/shadcn/src/registry/constants.ts:33-35
export const BUILTIN_REGISTRIES: z.infer<typeof registryConfigSchema> = {
  "@shadcn": `${REGISTRY_URL}/styles/{style}/{name}.json`,
};
```

ユーザーは `components.json` にサードパーティレジストリを追加でき、CLI は透過的にそれらを解決する。レジストリ名は `@` プレフィックスが必須（`packages/shadcn/src/registry/schema.ts:22-24` のバリデーション）であり、npm のスコープパッケージと類似した命名規約を採用している。

### 依存関係の再帰的解決とトポロジカルソート

`resolveRegistryTree`（`packages/shadcn/src/registry/resolver.ts:124-364`）は、コンポーネント間の `registryDependencies` を再帰的に解決し、カーンのアルゴリズムによるトポロジカルソート（`topologicalSortRegistryItems`, 同ファイル 622-743行）で依存順序を決定する。これにより、`alert-dialog` が `button` に依存する場合（`apps/v4/registry/new-york-v4/ui/_registry.ts:28-29`）、button が先にインストールされることが保証される。

### コンポーネント設計の一貫したパターン

全 57 コンポーネントに以下の設計規約が徹底されている:

1. **`React.ComponentProps<>` によるインライン Props 型定義**: 独立した Props interface を定義せず、関数引数で直接型を記述する。全コンポーネントファイル（54ファイル、計290箇所）でこのパターンが使われ、`React.forwardRef` は0件。

2. **`data-slot` 属性**: 全コンポーネントが `data-slot="component-name"` を付与する（79箇所以上）。これは CSS セレクタでの安定したターゲティングを可能にし、クラス名に依存しないスタイル上書きの仕組みを提供する。

3. **`cn()` ユーティリティによるクラス結合**: `clsx` + `tailwind-merge` を組み合わせた `cn()` 関数（`apps/v4/registry/new-york-v4/lib/utils.ts`）を全コンポーネントで使用し、デフォルトスタイルとユーザー指定の `className` を安全にマージする。

4. **named export のみ**: `export default` は `_registry.ts` の1件を除いて使用されない。これにより import 時の命名の一貫性が保たれる。

### diff コマンドによる更新追跡

コードが所有権ごとユーザーに渡されるため、上流の更新との差分管理が課題になる。`diff` コマンド（`packages/shadcn/src/commands/diff.ts`）は、ユーザーのローカルファイルとレジストリの最新版を比較し、変更箇所を可視化する。これは「所有権の譲渡」と「上流追従」の両立を実現する設計判断である。

### MCP サーバーによる AI ツール統合

MCP サーバー（`packages/shadcn/src/mcp/index.ts`）は、レジストリの検索・閲覧・追加コマンド生成を AI ツールに公開する。コード配布の思想は AI エージェントにも適用され、エージェントがレジストリからコンポーネントを検索し、`shadcn add` コマンドでユーザーのプロジェクトに追加する一連のワークフローが実現されている。

## パターンカタログ

- **Pipeline パターン** (分類: 振る舞い)
  - 解決する問題: コード変換の各ステップを独立に管理・組み合わせたい
  - 適用条件: 入力データに対して複数の独立した変換を順次適用する場面
  - コード例: `packages/shadcn/src/utils/transformers/index.ts:42-71`
  - 注意点: 各 transformer の実行順序が結果に影響する場合がある（例: import 変換は cleanup の前に行う必要がある）

- **Registry パターン** (分類: 構造)
  - 解決する問題: 分散したコンポーネントの発見・解決・取得を統一的に行いたい
  - 適用条件: 複数のソースからアイテムを取得し、依存関係を解決する必要がある場面
  - コード例: `packages/shadcn/src/registry/resolver.ts:124-364`
  - 注意点: 循環依存の検出と処理が必要（同ファイル 722-739行で警告付きフォールバック）

- **Error Hierarchy パターン** (分類: 振る舞い)
  - 解決する問題: ネットワーク・認証・パース等の異なるエラーを型安全に分類し、ユーザーに適切なガイダンスを提供したい
  - 適用条件: 外部サービスとの通信でエラーの種類ごとに異なる対処が必要な場面
  - コード例: `packages/shadcn/src/registry/errors.ts:32-76`（基底クラス）、78-363（具象クラス群）
  - 注意点: エラーコード定数と例外クラスを対にすることで、プログラム的なエラーハンドリングとユーザー向けメッセージを両立できる

## Good Patterns

- **スキーマ駆動の配布物バリデーション**: `registryItemSchema` を Zod の discriminatedUnion で定義し、`type` フィールドによって `registry:base` は `config` を持ち、`registry:font` は `font` を持つ、といった型レベルの分岐を実現している。これにより、任意の JSON が正しいレジストリアイテムかどうかを単一の `parse()` 呼び出しで検証できる。

```typescript
// packages/shadcn/src/registry/schema.ts:169-181
export const registryItemSchema = z.discriminatedUnion("type", [
  registryItemCommonSchema.extend({
    type: z.literal("registry:base"),
    config: rawConfigSchema.deepPartial().optional(),
  }),
  registryItemCommonSchema.extend({
    type: z.literal("registry:font"),
    font: registryItemFontSchema,
  }),
  registryItemCommonSchema.extend({
    type: registryItemTypeSchema.exclude(["registry:base", "registry:font"]),
  }),
]);
```

- **薄いコンポーネントラッパー**: コンポーネントは独自の state 管理や複雑なロジックを持たず、Radix UI プリミティブに Tailwind クラスを適用するだけの薄い層に留める。これにより、ユーザーがコードを所有した後の可読性と変更容易性が最大化される。

```typescript
// apps/v4/registry/new-york-v4/ui/input.tsx:5-19
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent ...",
        className,
      )}
      {...props}
    />
  );
}
```

- **エラーに `suggestion` フィールドを持たせる**: 全ての `RegistryError` サブクラスがユーザー向けの修正提案を含む。CLI やMCP サーバーはこのフィールドを使って具体的な次のアクションを提示できる。

```typescript
// packages/shadcn/src/registry/errors.ts:78-92
export class RegistryNotFoundError extends RegistryError {
  constructor(public readonly url: string, cause?: unknown) {
    super(message, {
      code: RegistryErrorCode.NOT_FOUND,
      statusCode: 404,
      cause,
      context: { url },
      suggestion: "Check if the item name is correct and the registry URL is accessible.",
    });
  }
}
```

## Anti-Patterns / 注意点

- **コード配布による更新コストの増大**: コードの所有権をユーザーに渡すと、上流の更新を受け取るために `diff` + 手動マージが必要になる。npm パッケージなら `npm update` で済む作業が、ファイル単位の差分レビューになる。

```
Bad: ユーザーがコンポーネントを大幅にカスタマイズした後、上流の security fix を取り込もうとして
     diff が膨大になり、マージを断念する

Better: カスタマイズ部分を明確に分離する設計にする（例: ラッパーコンポーネントでカスタマイズし、
       shadcn/ui のコアファイルは直接編集しない）。data-slot 属性による CSS 上書きも
       この分離を支援する仕組みの一つ。
```

- **正規形と変換先の乖離**: レジストリに格納される正規形のコードと、ユーザーのプロジェクトに変換後出力されるコードが異なるため、デバッグ時にレジストリ側のコードを直接参照しても問題を再現できない場合がある。

```
Bad: レジストリの import パス "@/registry/new-york-v4/ui/button" を
     そのままユーザーのプロジェクトで検索しても見つからない

Better: 変換前後のマッピングをログに残す、または diff コマンドで
       変換後のコードとローカルファイルを比較する仕組みを活用する
```

## 導出ルール

- `[MUST]` コード配布型の成果物では、配布物の構造をスキーマ（Zod 等）で厳密に定義し、受け取り側でバリデーションしてから処理する
  - 根拠: shadcn/ui は `registryItemSchema` で全ての配布物を検証しており、不正なJSON がパイプラインに流入することを防いでいる（`packages/shadcn/src/registry/schema.ts:169-181`）

- `[MUST]` AST ベースのコード変換を行う場合、各変換ステップを統一インターフェース（`(input) => output`）の関数に分離し、パイプラインとして組み合わせる
  - 根拠: `Transformer` 型と `transform` 関数がこのパターンを実装しており、変換の追加・削除・順序変更が容易（`packages/shadcn/src/utils/transformers/index.ts:27-31, 42-52`）

- `[SHOULD]` 配布するコンポーネントは「薄いラッパー」に留め、独自の抽象化層を最小限にする。受け取り手がコードを理解・変更しやすくするため
  - 根拠: shadcn/ui の全コンポーネントは Radix UI プリミティブ + `cn()` による薄い層であり、`forwardRef` も独自 Props interface も使わず、`React.ComponentProps<>` でネイティブ Props を透過させている

- `[SHOULD]` エラークラスにユーザー向けの修正提案（suggestion）を含め、CLI や API のエラーレスポンスで具体的な次のアクションを提示する
  - 根拠: `RegistryError` の全サブクラスが `suggestion` フィールドを持ち、MCP サーバーがこれをそのまま AI エージェントに返している（`packages/shadcn/src/registry/errors.ts`, `packages/shadcn/src/mcp/index.ts:431-449`）

- `[SHOULD]` コード配布プラットフォームでは、`diff` コマンドのような上流変更の追跡手段を提供し、所有権譲渡と更新追従を両立させる
  - 根拠: `diff` コマンドがレジストリの最新版とローカルファイルを比較し、変更を可視化する仕組みが実装されている（`packages/shadcn/src/commands/diff.ts:147-201`）

- `[AVOID]` コード配布型プロジェクトで、受け取り側の環境差異をテキスト置換（正規表現ベース）で吸収しようとすること。構造的な変換（AST 操作）を使わないと、エッジケースでコードが壊れる
  - 根拠: shadcn/ui は全ての import パス書き換えとコード変換を ts-morph の AST 操作で行っており、`ImportDeclaration` や `JsxSelfClosingElement` などの構文ノードを直接操作する（`packages/shadcn/src/utils/transformers/transform-import.ts`, `transform-icons.ts`）

## 適用チェックリスト

- [ ] 配布物（テンプレート・ボイラープレート・コンポーネント等）の構造をスキーマで定義し、入出力のバリデーションを実装しているか
- [ ] コード変換が必要な場合、テキスト置換ではなく AST 操作を採用しているか
- [ ] 配布するコンポーネントの抽象化層は最小限か（ユーザーがソースを読んで理解できるか）
- [ ] 上流の変更を追跡・マージする手段（diff ツール等）を提供しているか
- [ ] エラーメッセージに具体的な修正提案を含めているか
- [ ] 配布物のバリエーション（JSX/TSX、RSC 有無、アイコンライブラリ等）を変換パイプラインで吸収しているか
- [ ] サードパーティによる拡張（レジストリの追加等）を名前空間で安全に分離しているか
