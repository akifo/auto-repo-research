# JSX Runtime Patterns

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

React に依存しないカスタム JSX ランタイムを構築し、宣言的な UI コンポーネント定義をクロスプラットフォーム（Slack/Teams/Google Chat/Discord/GitHub/Linear）の固有フォーマットに変換するパターンを分析する。JSX の「宣言的ツリー構築」という側面だけを利用し、React のレンダリングエンジン・仮想 DOM・状態管理を一切持たない最小実装が注目に値する。TypeScript の型システムで HTML 要素を完全に禁止し、ドメイン固有コンポーネントのみを許可する設計は、DSL としての JSX 活用の好例である。

## 背景にある原則

- **宣言的構文とランタイムの分離**: JSX は構文糖でありレンダリングエンジンではない。TypeScript の `jsxImportSource` 設定で任意のファクトリ関数に差し替えられるため、React なしでも JSX の宣言性を活用できる。vercel/chat はこの特性を活用し、`jsx`/`jsxs` ファクトリ関数でプラットフォーム中立の中間表現ツリーを構築する（`packages/chat/src/jsx-runtime.ts:549-586`）。

- **中間表現による関心の分離**: UI の「何を表示するか」と「どう表示するか」を分離するために、プラットフォーム中立の中間表現（IR）を導入すべき。直接 JSON を書くのではなく、IR を経由することで、6 つの異なるプラットフォームへの変換を同一のソースから行える（`packages/chat/src/cards.ts` の CardElement 型がこの IR）。

- **型による制約の表現**: ランタイムバリデーションよりコンパイル時の型制約を優先すべき。`IntrinsicElements = {}` により HTML 要素の使用をコンパイルエラーで防止し、「使えない」ことを実行前に保証する（`packages/chat/src/jsx-runtime.ts:675`）。

- **Dual API パターン**: 同一機能に対して関数呼び出し API と JSX API の両方を提供し、ユーザーの好みやプロジェクト制約に合わせた選択を可能にすべき。vercel/chat は `Card({...})` 関数 API と `<Card>` JSX API を同一のビルダー関数群で実現している（`packages/chat/src/cards.ts:1-45`）。

## 実例と分析

### カスタム JSX ランタイムの最小構成

JSX ランタイムの実装に必要な最小構成は以下の 3 要素:

1. **`jsx` / `jsxs` ファクトリ関数** - 単一子要素/複数子要素の分岐
2. **`Fragment` サポート** - 子要素のフラット化
3. **`JSX` 名前空間** - `Element`、`IntrinsicElements`、`ElementChildrenAttribute` の型定義

TypeScript コンパイラは `jsxImportSource` の設定に基づいて `jsx-runtime` モジュールから自動 import する。package.json の `exports` フィールドで `./jsx-runtime` と `./jsx-dev-runtime` を同一ファイルにマッピングすることで、開発・本番両モードを統一する。

### 遅延評価と明示的な解決の分離

`jsx()` / `jsxs()` は即座にビルダー関数を実行せず、`$$typeof` + `type` + `props` + `children` の「レシピ」オブジェクトを返す。実際のビルダー関数呼び出しは `toCardElement()` / `toModalElement()` で行われる。この遅延評価により、ツリー構築と解決を分離し、JSX ツリーの中間検査や変換が可能になる。

### 関数参照によるコンポーネント識別

コンポーネントの識別に関数名の文字列比較ではなく、関数参照の同一性比較（`type === Text`）を使う。これはプロダクションビルドでの minification で関数名が消えても正しく動作するための設計判断である。React の `fromReactElement` でも `componentMap` で関数参照→名前のマッピングを行い、同一の原則を適用している。

### プラットフォームアダプターの変換戦略

6 つのアダプターは中間表現の `CardElement` を受け取り、それぞれ異なる戦略でプラットフォーム固有フォーマットに変換する:

| プラットフォーム | 変換先フォーマット | 特徴的な制約対応                                              |
| ---------------- | ------------------ | ------------------------------------------------------------- |
| Slack            | Block Kit JSON     | `mrkdwn` 形式、muted → context ブロック                       |
| Teams            | Adaptive Cards     | actions がカードレベルに昇格、divider → Container + separator |
| Google Chat      | Card v2            | widgets を sections で包む必須要件、空カードのフォールバック  |
| Discord          | Embed + Components | action row あたりボタン 5 個制限、divider → テキスト罫線      |
| GitHub           | Markdown           | インタラクティブボタン → 太字テキスト化                       |
| Linear           | Markdown           | GitHub とほぼ同一の戦略                                       |

各アダプターは `switch (child.type)` による exhaustive パターンマッチングで全要素タイプを処理する。

### React 互換レイヤー

`fromReactElement()` は React の JSX ランタイムで生成された要素ツリーをカスタム IR に変換する。React 要素の識別は `$$typeof` の `Symbol.for("react.element")` および `Symbol.for("react.transitional.element")` で行い、React のバージョン差異を吸収する。HTML 要素（`<div>` 等）が渡された場合は即座にエラーを投げ、利用者に正しいコンポーネントの使用を促す。

## コード例

```ts
// packages/chat/src/jsx-runtime.ts:549-561
// JSX ファクトリ: ビルダー関数を即座に呼ばず、レシピオブジェクトを返す
export function jsx<P extends CardJSXProps>(
  type: CardComponentFunction,
  props: P & { children?: unknown; },
  _key?: string,
): CardJSXElement<P> {
  const { children, ...restProps } = props;
  return {
    $$typeof: JSX_ELEMENT,
    type,
    props: restProps as P,
    children: children != null ? [children] : [],
  };
}
```

```ts
// packages/chat/src/jsx-runtime.ts:672-680
// IntrinsicElements = {} で HTML 要素を完全禁止
export namespace JSX {
  export interface Element extends JSXElement {}
  // biome-ignore lint/complexity/noBannedTypes: Required for JSX namespace
  export type IntrinsicElements = {};
  export interface ElementChildrenAttribute {
    // biome-ignore lint/complexity/noBannedTypes: Required for JSX children attribute
    children: {};
  }
}
```

```ts
// packages/chat/src/jsx-runtime.ts:374-382
// 関数参照の同一性比較で minification 耐性を確保
if (type === Text) {
  const textProps = isTextProps(props) ? props : { style: undefined };
  const content = processedChildren.length > 0
    ? processedChildren.map(String).join("")
    : String(textProps.children ?? "");
  return Text(content, { style: textProps.style });
}
```

```ts
// packages/chat/src/cards.ts:447-458
// componentMap: 関数参照→名前マッピングで React 要素を変換
const componentMap = new Map<unknown, string>([
  [Card, "Card"],
  [Text, "Text"],
  [Image, "Image"],
  [Divider, "Divider"],
  [Section, "Section"],
  [Actions, "Actions"],
  [Button, "Button"],
  [LinkButton, "LinkButton"],
  [Field, "Field"],
  [Fields, "Fields"],
]);
```

```ts
// packages/adapter-slack/src/cards.ts:86-130
// アダプター: CardElement → Slack Block Kit への変換
export function cardToBlockKit(card: CardElement): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  if (card.title) {
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: convertEmoji(card.title), emoji: true },
    });
  }
  // ...
  for (const child of card.children) {
    const childBlocks = convertChildToBlocks(child);
    blocks.push(...childBlocks);
  }
  return blocks;
}
```

```ts
// packages/chat/src/thread.ts:334-339
// 消費側: isJSX + toCardElement で自動変換
if (isJSX(message)) {
  const card = toCardElement(message);
  if (!card) {
    throw new Error("Invalid JSX element: must be a Card element");
  }
  postable = card;
}
```

```ts
// packages/chat/package.json:13-22
// jsx-runtime と jsx-dev-runtime を同一ファイルにマッピング
"exports": {
  "./jsx-runtime": {
    "types": "./dist/jsx-runtime.d.ts",
    "import": "./dist/jsx-runtime.js"
  },
  "./jsx-dev-runtime": {
    "types": "./dist/jsx-runtime.d.ts",
    "import": "./dist/jsx-runtime.js"
  }
}
```

## パターンカタログ

- **Abstract Syntax Tree (構造)**
  - 解決する問題: 複数のプラットフォームに対して同一の UI 定義を変換する必要がある
  - 適用条件: 出力先が 2 つ以上あり、各出力の構造が大きく異なる場合
  - コード例: `packages/chat/src/cards.ts:161-171` の `CardElement` 型
  - 注意点: IR のノード種別が増えるとアダプター側の実装コストが線形に増加する

- **Builder (生成)**
  - 解決する問題: プラットフォーム中立な IR を型安全に構築したい
  - 適用条件: IR の構築にバリデーションや正規化が必要な場合
  - コード例: `packages/chat/src/cards.ts:206-214` の `Card()` ビルダー関数
  - 注意点: JSX API とビルダー API の二重化により、ビルダー関数の引数設計が両方に影響する

- **Adapter (構造)**
  - 解決する問題: 同一の中間表現を異なるプラットフォーム固有のフォーマットに変換したい
  - 適用条件: 変換先の構造がプラットフォームごとに根本的に異なる場合
  - コード例: `packages/adapter-slack/src/cards.ts:86`、`packages/adapter-teams/src/cards.ts:60`
  - 注意点: 各アダプターは独立しているが、shared utilities（`adapter-shared/src/card-utils.ts`）で共通ロジックを抽出して重複を制御する

- **Visitor (振る舞い)**
  - 解決する問題: IR ツリーの各ノードを型に応じて処理したい
  - 適用条件: ツリー構造を走査して型分岐する処理が複数箇所にある場合
  - コード例: 全アダプターの `switch (child.type)` パターン（例: `packages/adapter-discord/src/cards.ts:97-121`）
  - 注意点: ノード型の追加時に全アダプターの switch を更新する必要がある（TypeScript の exhaustive check で漏れを検出）

## Good Patterns

- **IntrinsicElements = {} による HTML 禁止**: JSX 名前空間の `IntrinsicElements` を空オブジェクト型にすることで、`<div>` や `<span>` などの HTML 要素を TypeScript のコンパイル時エラーで完全に禁止する。ランタイムチェックのコストなしに不正な要素の混入を防ぐ。

```ts
// packages/chat/src/jsx-runtime.ts:672-680
export namespace JSX {
  export interface Element extends JSXElement {}
  export type IntrinsicElements = {};
}
```

- **Symbol.for によるクロスモジュール要素識別**: `Symbol.for("chat.jsx.element")` でグローバルシンボルレジストリを使い、モジュールバンドラの重複や異なるバージョンの混在があっても要素を正しく識別する。React も同じテクニックを使っている。

```ts
// packages/chat/src/jsx-runtime.ts:68
const JSX_ELEMENT = Symbol.for("chat.jsx.element");
```

- **関数参照の同一性による minification 耐性**: `resolveJSXElement` で `type === Card` のように関数参照を直接比較する。`type.name === "Card"` と違い、minifier が関数名を短縮しても壊れない。

```ts
// packages/chat/src/jsx-runtime.ts:374
if (type === Text) { ... }
if (type === Section) { ... }
if (type === Button) { ... }
```

- **Dual API（関数 + JSX）の同一ビルダー関数共有**: ビルダー関数（`Card()`、`Text()` 等）をそのまま JSX のコンポーネント関数として再利用する。JSX ランタイムの `resolveJSXElement` がビルダー関数を呼び出すことで、ロジックの重複をゼロにしている。

```ts
// 関数 API: 直接呼び出し
Card({ title: "Order", children: [Text("Ready!")] })

// JSX API: ランタイムがビルダーを呼ぶ
<Card title="Order"><Text>Ready!</Text></Card>
```

- **共有ユーティリティによるアダプター間の重複排除**: `adapter-shared` パッケージで `cardToFallbackText`、`mapButtonStyle`、`createEmojiConverter` を共有し、6 つのアダプターでのコピペを防止する。

```ts
// packages/adapter-shared/src/card-utils.ts:97-125
export function cardToFallbackText(
  card: CardElement,
  options: FallbackTextOptions = {},
): string {
  const { boldFormat = "*", lineBreak = "\n", platform } = options;
  // ...
}
```

## Anti-Patterns / 注意点

- **型ガードの判別条件の脆弱性**: 複数の型ガード関数がプロパティの存在/不在で判別するため、プロパティの組み合わせが増えると衝突リスクがある。例えば `isTextProps` は `"id"`, `"url"`, `"label"` がないことで判定するが、将来プロパティが追加されると誤判定する可能性がある。

```ts
// Bad: プロパティの不在で判別 — 脆弱
function isTextProps(props: CardJSXProps): props is TextProps {
  return !("id" in props || "url" in props || "label" in props);
}

// Better: discriminant を明示的に持つ
interface TextProps {
  kind: "text";
  content: string;
  style?: TextStyle;
}
function isTextProps(props: CardJSXProps): props is TextProps {
  return (props as TextProps).kind === "text";
}
```

- **型ガードと switch-case の選択ミス**: `resolveJSXElement` では関数参照の `if (type === X)` チェーンを使っているため問題ないが、仮にこれを文字列ベースの判別にすると TypeScript の exhaustive check が効かなくなる。パターン数が多い場合（14 コンポーネント）は判別の仕組みを統一すべき。

```ts
// Bad: string ベースの if-else チェーン（exhaustive check 不可能）
if (name === "Card") { ... }
else if (name === "Text") { ... }
// 新しいコンポーネント追加時に見落とし

// Better: discriminated union + switch で exhaustive check
switch (type) {
  case "card": return ...;
  case "text": return ...;
  default: const _: never = type; // コンパイルエラーで追加漏れ検出
}
```

## 導出ルール

- `[MUST]` カスタム JSX ランタイムでドメイン固有コンポーネントのみ許可する場合、`IntrinsicElements = {}` を設定して HTML 要素をコンパイル時に禁止する
  - 根拠: vercel/chat は空の IntrinsicElements でランタイムエラーではなくコンパイルエラーとして不正な要素使用を防止する（`jsx-runtime.ts:675`）

- `[MUST]` 同一の UI 定義を複数の出力先に変換する場合、プラットフォーム中立の中間表現（IR）を定義し、アダプターパターンで各プラットフォーム固有フォーマットへの変換を実装する
  - 根拠: vercel/chat は 6 つのプラットフォームに対して `CardElement` IR → 各アダプターの変換関数という一貫した構造を持ち、新プラットフォーム追加が既存コードに影響しない

- `[MUST]` カスタム JSX ランタイムの `jsx`/`jsxs` ファクトリ関数からビルダー関数を即座に呼ばず、レシピオブジェクトとして遅延させ、明示的な解決関数（`toXxxElement`）で変換する
  - 根拠: 遅延評価により中間検査・フォーマット判定・React 互換層との統合が可能になる（`jsx-runtime.ts:549-561`、`thread.ts:334-339`）

- `[SHOULD]` JSX ランタイムでコンポーネントを識別する際、関数名の文字列比較ではなく関数参照の同一性比較（`type === Component`）を使う
  - 根拠: プロダクションビルドの minification で関数名が消えるため、文字列比較は本番環境で壊れる（`jsx-runtime.ts:374-532`）

- `[SHOULD]` JSX 要素の識別に `Symbol.for()` によるグローバルシンボルを使い、モジュールの重複インスタンスやバージョン差異に対して堅牢にする
  - 根拠: `Symbol.for("chat.jsx.element")` はグローバルレジストリで共有されるため、バンドラが同一モジュールを複数回インクルードしても同一のシンボルが得られる（`jsx-runtime.ts:68`）

- `[SHOULD]` 同一機能に対して関数呼び出し API と JSX API の両方を提供する場合、JSX ランタイムからビルダー関数を直接呼び出すことで実装を共有する
  - 根拠: vercel/chat のビルダー関数（`Card()`, `Text()` 等）は関数 API としても JSX コンポーネントとしても同一の関数が使われ、ロジックの二重化がない

- `[SHOULD]` 中間表現の各ノード型にリテラル型の `type` フィールドを持たせ、アダプターの変換処理で `switch (node.type)` による exhaustive パターンマッチングを可能にする
  - 根拠: 全 6 アダプターが `switch (child.type)` パターンで全ノード型を処理し、新しいノード型の追加時にコンパイラが未処理分岐を検出できる

- `[AVOID]` 型ガードでプロパティの「不在」に依存した判別を行うこと。プロパティの組み合わせが増えると判別条件が衝突する
  - 根拠: `jsx-runtime.ts` の `isTextProps` は `"id"`, `"url"`, `"label"` の不在で判別しており、新プロパティの追加で誤判定リスクがある（`jsx-runtime.ts:282-284`）

## 適用チェックリスト

- [ ] 同一の UI/データ構造を 2 つ以上の異なるフォーマットに変換する必要があるか確認する
- [ ] 中間表現（IR）の型を `type` リテラルフィールド付きの discriminated union で定義する
- [ ] 各出力先に対応するアダプター関数を実装し、`switch (node.type)` で exhaustive パターンマッチングを使う
- [ ] カスタム JSX ランタイムが必要な場合、`jsx`/`jsxs`/`Fragment` の 3 つのエクスポートを実装する
- [ ] `IntrinsicElements = {}` で HTML 要素を禁止し、ドメイン固有コンポーネントのみ許可する
- [ ] package.json の `exports` で `./jsx-runtime` と `./jsx-dev-runtime` を同一ファイルにマッピングする
- [ ] tsconfig.json で `"jsx": "react-jsx"` と `"jsxImportSource": "<package-name>"` を設定する
- [ ] JSX ファクトリでは遅延評価（レシピオブジェクト返却）を採用し、明示的な `toXxxElement()` で解決する
- [ ] `Symbol.for()` で要素のブランディングを行い、クロスモジュールで同一性を保証する
- [ ] アダプター間で共通するロジック（フォールバックテキスト生成、スタイルマッピング等）を shared パッケージに抽出する
- [ ] 関数 API と JSX API の両方を提供する場合、ビルダー関数の共有によりロジック二重化を防ぐ
