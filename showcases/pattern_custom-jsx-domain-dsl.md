# Pattern: Custom JSX Domain DSL

> 出典: [repos/vercel/chat/jsx-runtime-patterns.md](../repos/vercel/chat/jsx-runtime-patterns.md)
> カテゴリ: pattern

## 概要

React に依存しないカスタム JSX ランタイムを構築し、`IntrinsicElements = {}` で HTML 要素をコンパイル時に禁止することで、ドメイン固有コンポーネントのみを許可する型安全な DSL を実現するパターン。JSX の「宣言的ツリー構築」という構文上の利点だけを活用し、React の仮想 DOM・状態管理・レンダリングエンジンを一切持たない最小実装で、複数のプラットフォーム向けフォーマットへの変換を可能にする。

## 背景・文脈

vercel/chat はクロスプラットフォーム（Slack / Teams / Google Chat / Discord / GitHub / Linear）のチャットメッセージングライブラリであり、同一の UI 定義を 6 つの異なるフォーマットに変換する必要がある。ここで `<div>` や `<span>` のような HTML 要素を使ってしまうと、Slack Block Kit や Adaptive Cards に変換できず意味をなさない。そこでカスタム JSX ランタイムにより、`Card`、`Text`、`Button` といったドメイン固有コンポーネントのみを型レベルで強制し、不正な要素の使用をランタイムではなくコンパイル時に検出する設計を採用している。

## 実装パターン

### 1. JSX 名前空間で HTML 要素を禁止する

`IntrinsicElements` を空オブジェクト型に設定すると、TypeScript は `<div>` や `<span>` に対して「プロパティが存在しない」コンパイルエラーを出す。これがパターン全体の核心である。

```ts
// packages/chat/src/jsx-runtime.ts:671-680
// biome-ignore lint/style/noNamespace: JSX namespace required by TypeScript JSX transform
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

### 2. JSX ファクトリ関数（遅延評価）

`jsx` / `jsxs` はビルダー関数を即座に呼ばず、`$$typeof` + `type` + `props` + `children` の「レシピオブジェクト」を返す。ツリーの構築と解決を分離し、中間検査やフォーマット判定を可能にする。

```ts
// packages/chat/src/jsx-runtime.ts:549-561
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

### 3. Symbol.for によるクロスモジュール要素識別

モジュールバンドラがパッケージを複数回インクルードしても、グローバルシンボルレジストリにより同一のシンボルで要素を識別できる。

```ts
// packages/chat/src/jsx-runtime.ts:68
const JSX_ELEMENT = Symbol.for("chat.jsx.element");
```

### 4. 関数参照の同一性比較による minification 耐性

コンポーネントの識別に `type === Text` のような関数参照比較を使う。`type.name === "Text"` と異なり、プロダクションビルドで minifier が関数名を短縮しても壊れない。

```ts
// packages/chat/src/jsx-runtime.ts:372-383
// Use identity comparison to determine which builder function this is
// This is necessary because function names get minified in production builds
if (type === Text) {
  const textProps = isTextProps(props) ? props : { style: undefined };
  const content = processedChildren.length > 0
    ? processedChildren.map(String).join("")
    : String(textProps.children ?? "");
  return Text(content, { style: textProps.style });
}
```

### 5. package.json でランタイムをエクスポートする

TypeScript コンパイラが `jsxImportSource` に基づいて自動で `jsx-runtime` を import する。`jsx-dev-runtime` も同一ファイルにマッピングし、開発・本番を統一する。

```json
// packages/chat/package.json:14-22
"./jsx-runtime": {
  "types": "./dist/jsx-runtime.d.ts",
  "import": "./dist/jsx-runtime.js"
},
"./jsx-dev-runtime": {
  "types": "./dist/jsx-runtime.d.ts",
  "import": "./dist/jsx-runtime.js"
}
```

### 6. 中間表現（IR）とアダプター変換

ビルダー関数が生成する `CardElement` がプラットフォーム中立の IR であり、各アダプターが `switch (child.type)` で exhaustive にプラットフォーム固有フォーマットへ変換する。

```ts
// packages/chat/src/cards.ts:161-171 — 中間表現の型
export interface CardElement {
  children: CardChild[];
  imageUrl?: string;
  subtitle?: string;
  title?: string;
  type: "card";
}
```

```ts
// packages/adapter-slack/src/cards.ts:135-152 — アダプター変換
function convertChildToBlocks(child: CardChild): SlackBlock[] {
  switch (child.type) {
    case "text":
      return [convertTextToBlock(child)];
    case "image":
      return [convertImageToBlock(child)];
    case "divider":
      return [convertDividerToBlock(child)];
    case "actions":
      return [convertActionsToBlock(child)];
    case "section":
      return convertSectionToBlocks(child);
    case "fields":
      return [convertFieldsToBlock(child)];
    default:
      return [];
  }
}
```

## Good Example

ドメイン固有コンポーネントのみで構成される DSL。`<Card>` や `<Text>` は HTML 要素ではなくビルダー関数への参照であり、同じソースから関数 API でも JSX API でも利用できる。

```tsx
// JSX API: tsconfig に "jsxImportSource": "chat" を設定
import { Actions, Button, Card, Text } from "chat";

const orderCard = (
  <Card title="Order #1234">
    <Text>Your order is ready!</Text>
    <Actions>
      <Button id="pickup" style="primary">Schedule Pickup</Button>
      <Button id="cancel" style="danger">Cancel</Button>
    </Actions>
  </Card>
);

// 関数 API: 同一のビルダー関数を直接呼び出す（JSX 設定不要）
const orderCardFn = Card({
  title: "Order #1234",
  children: [
    Text("Your order is ready!"),
    Actions([
      Button({ id: "pickup", label: "Schedule Pickup", style: "primary" }),
      Button({ id: "cancel", label: "Cancel", style: "danger" }),
    ]),
  ],
});
```

## Bad Example

HTML 要素を混在させた場合。`IntrinsicElements = {}` が設定されているため、これはコンパイルエラーになる。

```tsx
// BAD: HTML 要素はコンパイルエラーになる
// Error: Property 'div' does not exist on type 'IntrinsicElements'.
const broken = (
  <Card title="Order">
    <div className="wrapper">
      {/* コンパイルエラー */}
      <span>Some text</span> {/* コンパイルエラー */}
    </div>
    <Text>Valid content</Text>
  </Card>
);
```

仮に `IntrinsicElements` を空にしなかった場合、HTML 要素がコンパイルを通過してしまい、ランタイムでの `fromReactElement` 時に初めてエラーになる。

```ts
// packages/chat/src/cards.ts:496-500
// ランタイムエラーは遅い — コンパイル時に防ぐべき
if (typeof type === "string") {
  throw new Error(
    `HTML element <${type}> is not supported in card elements. `
      + "Use Card, Text, Section, Actions, Button, Fields, Field, Image, or Divider components instead.",
  );
}
```

## 適用ガイド

### どのような状況で使うべきか

- 同一の宣言的な定義を複数の異なるフォーマット（JSON、Markdown、独自プロトコル等）に変換する必要がある場合
- HTML/DOM が関与しないドメイン（チャット UI、メール、PDF、設定ファイル等）で宣言的 DSL が欲しい場合
- JSX の馴染みのある構文を活かしつつ、React の依存を持ち込みたくない場合

### 導入時の注意点

- `tsconfig.json` に `"jsx": "react-jsx"` と `"jsxImportSource": "<package-name>"` の設定が必要
- `package.json` の `exports` で `./jsx-runtime` と `./jsx-dev-runtime` の両方を公開する必要がある
- JSX ランタイムの最小エクスポートは `jsx`、`jsxs`、`Fragment` の 3 つ
- 型ガードでプロパティの「不在」に依存すると、コンポーネント追加時に判別条件が衝突するリスクがある（vercel/chat の `isTextProps` が該当）。discriminated union の `kind` フィールドを検討すること

### カスタマイズポイント

- **IR のノード型**: `CardChild` のユニオンにノード型を追加すれば DSL を拡張できる。ただしアダプター側の `switch` も全て更新する必要がある
- **Dual API**: ビルダー関数をそのまま JSX コンポーネントとして再利用することで、関数 API と JSX API の両方を実装コストゼロで提供できる
- **React 互換レイヤー**: `fromReactElement()` のように既存の React JSX で生成された要素を受け入れる変換層を追加すれば、段階的な移行が可能

## 参考

- [repos/vercel/chat/jsx-runtime-patterns.md](../repos/vercel/chat/jsx-runtime-patterns.md) -- 元の分析
