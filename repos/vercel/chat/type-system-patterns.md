# type-system-patterns

> リポジトリ: vercel/chat
> 分析日: 2026-02-25

## 概要

vercel/chat は cross-platform チャット SDK であり、Slack・Teams・Discord・Google Chat など異なるプラットフォームを単一の型安全なインターフェースで抽象化している。この視点では、ジェネリクスによるアダプター型推論、カスタム JSX ランタイムの型設計、タグ付きユニオン型、そしてモジュール拡張による型の拡張性を分析する。プラットフォーム抽象化における型安全性の保証手法として注目に値する。

## 背景にある原則

- **ジェネリクスの段階的具体化で型安全な抽象化レイヤーを構築すべき**: SDK のコアはジェネリクスで抽象化し（`Adapter<TThreadId, TRawMessage>`）、各アダプター実装で具体型を注入する。利用者側では型引数を意識せずに使える。抽象と具体の境界をジェネリクスのデフォルト型引数で制御し、利用側の認知負荷を下げている（`types.ts:90`, `types.ts:33-58`）
- **ランタイム値からの型絞り込みにはタグ付きユニオンと型ガード関数を対にすべき**: カード要素（`CardChild`）やメッセージ形式（`PostableMessage`）を `type` フィールドのタグで弁別し、型ガード関数で安全に絞り込む。switch 文での網羅チェックが自然に機能する（`cards.ts:142-148`, `jsx-runtime.ts:282-360`）
- **宣言マージで第三者による型拡張を可能にすべき**: `CustomEmojiMap` のような空の interface を公開し、利用者が `declare module` で型を拡張できるようにする。ランタイムの `createEmoji()` と型定義の一貫性を保つ設計（`types.ts:1298-1299`, `emoji.ts:417-557`）
- **シリアライズ境界では専用の型を定義し、ランタイム型との変換を明示的に行うべき**: `Message` と `SerializedMessage`、`ThreadImpl` と `SerializedThread` のように、シリアライズ対象ごとに専用の interface を持ち、`toJSON()`/`fromJSON()` で変換を明示する（`message.ts:43-72`, `thread.ts:34-41`）

## 実例と分析

### ジェネリクスの段階的具体化

SDK の型システムの中核は、3 層のジェネリクス階層にある。

1. **コアインターフェース層**: `Adapter<TThreadId, TRawMessage>` が抽象的なプラットフォーム型を定義
2. **アダプター実装層**: 各アダプターが具体型を注入（例: `SlackAdapter implements Adapter<SlackThreadId, unknown>`）
3. **利用者層**: `ChatConfig<TAdapters>` がアダプター名をキーとするマップ型を受け取り、`Webhooks<TAdapters>` マップ型を自動生成

```typescript
// packages/chat/src/types.ts:33-58
export interface ChatConfig<
  TAdapters extends Record<string, Adapter> = Record<string, Adapter>,
> {
  adapters: TAdapters;
  // ...
}
```

```typescript
// packages/chat/src/chat.ts:108-110
type Webhooks<TAdapters extends Record<string, Adapter>> = {
  [K in keyof TAdapters]: WebhookHandler;
};
```

`Chat` クラスは 2 つの型パラメータを持ち、アダプターマップとスレッド状態の両方を型安全に管理する:

```typescript
// packages/chat/src/chat.ts:140-143
export class Chat<
  TAdapters extends Record<string, Adapter> = Record<string, Adapter>,
  TState = Record<string, unknown>,
> implements ChatInstance
```

これにより `chat.webhooks.slack(request)` のようなアダプター名ベースのアクセスが型安全になる。利用者は `typeof adapters` を渡すだけで推論が機能する。

### カスタム JSX ランタイムの型設計

React に依存せず、独自の JSX ランタイムを実装している。TypeScript の `jsxImportSource` プラグマと `JSX` 名前空間を使い、コンパイル時の型チェックを実現する。

```typescript
// packages/chat/src/jsx-runtime.ts:672-680
export namespace JSX {
  export interface Element extends JSXElement {}
  export type IntrinsicElements = {};
  export interface ElementChildrenAttribute {
    children: {};
  }
}
```

`IntrinsicElements` が空オブジェクトであることで、HTML 要素（`<div>` など）の使用をコンパイル時に禁止する。許可されるのは `CardComponentFunction` 型に列挙されたコンポーネント関数のみ。

JSX 要素の型は `CardJSXElement<P extends CardJSXProps>` として Props のジェネリクスを保持する:

```typescript
// packages/chat/src/jsx-runtime.ts:201-206
export interface CardJSXElement<P extends CardJSXProps = CardJSXProps> {
  $$typeof: typeof JSX_ELEMENT;
  children: unknown[];
  props: P;
  type: CardComponentFunction;
}
```

React の `$$typeof` シンボルパターンを踏襲しつつ、`Symbol.for("chat.jsx.element")` で独自のシンボルを使い、React 要素との明確な区別を可能にしている。

### タグ付きユニオン型による型弁別

カード要素の型階層は `type` フィールドをタグとするユニオンで構成される:

```typescript
// packages/chat/src/cards.ts:142-148
export type CardChild =
  | TextElement
  | ImageElement
  | DividerElement
  | ActionsElement
  | SectionElement
  | FieldsElement;
```

各要素は `type: "text"` や `type: "button"` のようなリテラル型を持ち、switch 文で網羅チェックが可能。この設計は `modals.ts` の `ModalChild` 型でも一貫している。

`PostableMessage` 型はタグフィールドの代わりにプロパティの有無で弁別する設計（構造的ユニオン）を採用:

```typescript
// packages/chat/src/types.ts:984-1003
export type AdapterPostableMessage =
  | string
  | PostableRaw // { raw: string }
  | PostableMarkdown // { markdown: string }
  | PostableAst // { ast: Root }
  | PostableCard // { card: CardElement }
  | CardElement; // { type: "card" }
```

`thread.ts` の `extractMessageContent()` 関数では `"raw" in message`、`"markdown" in message` のようなプロパティチェックで型を絞り込む。

### 型ガード関数の体系的な配備

JSX ランタイムでは Props ユニオンを弁別するための型ガード関数を体系的に配備している:

```typescript
// packages/chat/src/jsx-runtime.ts:282-284
function isTextProps(props: CardJSXProps): props is TextProps {
  return !("id" in props || "url" in props || "label" in props);
}

// packages/chat/src/jsx-runtime.ts:289-291
function isButtonProps(props: CardJSXProps): props is ButtonProps {
  return "id" in props && typeof props.id === "string" && !("url" in props);
}
```

また、`resolveJSXElement()` ではミニファイ対策として関数名の文字列比較ではなく **関数の同一性比較** (`type === Text`) を使う:

```typescript
// packages/chat/src/jsx-runtime.ts:373-374
// Use identity comparison to determine which builder function this is
// This is necessary because function names get minified in production builds
if (type === Text) {
```

### モジュール拡張による型の拡張性

絵文字システムは `declare module` によるモジュール拡張パターンを採用:

```typescript
// packages/chat/src/types.ts:1298-1299
export interface CustomEmojiMap {}

// packages/chat/src/types.ts:1304
export type Emoji = WellKnownEmoji | keyof CustomEmojiMap;
```

利用者が `CustomEmojiMap` を拡張すると `Emoji` 型が自動的に拡張される。`createEmoji()` のジェネリクスがランタイムと型の一貫性を保証する:

```typescript
// packages/chat/src/emoji.ts:417-422
export function createEmoji<
  T extends Record<
    string,
    { slack: string | string[]; gchat: string | string[] }
  >,
>(customEmoji?: T): BaseEmojiHelper & { [K in keyof T]: EmojiValue } {
```

### エラー型の階層設計

エラー型は `ChatError` を基底クラスとし、`code` プロパティで分類する:

```typescript
// packages/chat/src/errors.ts:5-15
export class ChatError extends Error {
  readonly code: string;
  override readonly cause?: unknown;
  constructor(message: string, code: string, cause?: unknown) { ... }
}

export class RateLimitError extends ChatError {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number, cause?: unknown) {
    super(message, "RATE_LIMITED", cause);
  }
}
```

`readonly` で不変性を保証し、`override` キーワードで基底クラスとの整合性を明示する。

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 複数プラットフォームのインターフェースの統一
  - 適用条件: 同一概念（メッセージ送信、スレッド管理等）が異なる API で提供される場合
  - コード例: `types.ts:90` (`Adapter<TThreadId, TRawMessage>`) → `adapter-slack/src/index.ts:289` (`SlackAdapter implements Adapter<SlackThreadId, unknown>`)
  - 注意点: ジェネリクスのデフォルト型引数をコア側に設定し、利用者が型引数を意識せずに済むようにする

- **Builder パターン** (分類: 生成)
  - 解決する問題: カード要素の構築を DSL 的な関数呼び出しと JSX の両方で実現
  - 適用条件: UI 要素の構築に構造的な型安全性が必要な場合
  - コード例: `cards.ts:206-214` (`Card()` ビルダー関数)、`jsx-runtime.ts:549-561` (`jsx()` ファクトリ関数)
  - 注意点: JSX と関数 API のデュアルインターフェースでは、内部の正規化レイヤー（`resolveJSXElement`）が不可欠

- **Flyweight パターン** (分類: 構造)
  - 解決する問題: 絵文字オブジェクトの同一性比較（`===`）を可能にする
  - 適用条件: 値の種類が有限で、同一性比較が必要な場合
  - コード例: `emoji.ts:32-43` (`getEmoji()` がレジストリからシングルトンを返す)
  - 注意点: `Object.freeze()` で不変性を保証し、レジストリの `Map` でメモ化する

## Good Patterns

- **デフォルト型引数による段階的型推論**: `ChatConfig<TAdapters extends Record<string, Adapter> = Record<string, Adapter>>` のように、ジェネリクスにデフォルト型を設定することで、利用者が型引数を省略しても安全に使える。SDK のコア定義では抽象的に、利用時には `typeof adapters` で具体型が自動推論される。

```typescript
// packages/chat/src/chat.ts:140-143
export class Chat<
  TAdapters extends Record<string, Adapter> = Record<string, Adapter>,
  TState = Record<string, unknown>,
> implements ChatInstance
```

- **Mapped 型によるアダプター名からの型安全な API 生成**: `Webhooks<TAdapters>` はアダプターのキー名をそのまま API のプロパティ名に変換する。`chat.webhooks.slack(req)` のように、存在しないアダプター名ではコンパイルエラーになる。

```typescript
// packages/chat/src/chat.ts:108-110
type Webhooks<TAdapters extends Record<string, Adapter>> = {
  [K in keyof TAdapters]: WebhookHandler;
};
```

- **シンボルベースのブランディングで外部ライブラリの型と区別**: `$$typeof: typeof JSX_ELEMENT` で独自 JSX 要素を React 要素と区別する。`Symbol.for()` を使うことでモジュール境界を越えた一意性を保証する。

```typescript
// packages/chat/src/jsx-runtime.ts:68
const JSX_ELEMENT = Symbol.for("chat.jsx.element");

// packages/chat/src/jsx-runtime.ts:214-219
function isJSXElement(value: unknown): value is JSXElement {
  return (
    typeof value === "object"
    && value !== null
    && (value as JSXElement).$$typeof === JSX_ELEMENT
  );
}
```

- **シリアライズ専用型による境界の明示化**: `Message` クラスと `SerializedMessage` interface を分離し、Date → ISO 文字列、Buffer → 省略のような変換ルールを型で表現する。

```typescript
// packages/chat/src/message.ts:43-72
export interface SerializedMessage {
  _type: "chat:Message";
  // Date → string
  metadata: {
    dateSent: string; // ISO string
    edited: boolean;
    editedAt?: string;
  };
  // Buffer/function は省略
  raw: unknown;
  // ...
}
```

## Anti-Patterns / 注意点

- **構造的ユニオンのプロパティチェックによる型絞り込みは保守性が低い**: `PostableMessage` のメンバーを `"raw" in message` や `"markdown" in message` で弁別しているが、プロパティ名の衝突やメンバー追加時のリスクがある。タグフィールド（`type` プロパティ）を持たないユニオンでは網羅チェックが困難。

```typescript
// Bad: プロパティの有無による弁別（衝突リスクあり）
if ("raw" in message) { ... }
else if ("markdown" in message) { ... }
else if ("ast" in message) { ... }
```

```typescript
// Better: タグ付きユニオンで明示的に弁別
type PostableMessage =
  | { type: "raw"; raw: string; }
  | { type: "markdown"; markdown: string; }
  | { type: "ast"; ast: Root; };
```

ただし、vercel/chat では利用者の DX（`{ markdown: "..." }` と書けるシンプルさ）を優先してこの設計を選択している。SDK のような外部 API 境界ではトレードオフとして合理的な場合がある。

- **型ガード関数の排他条件が暗黙的**: JSX ランタイムの型ガード群（`isTextProps`, `isButtonProps` 等）は否定条件（`!("id" in props)`）で他の型を排除しており、新しい Props 型の追加時に既存ガードの更新漏れが発生しやすい。

```typescript
// Bad: 否定条件で排他 — 新しい Props 追加時に壊れる
function isTextProps(props: CardJSXProps): props is TextProps {
  return !("id" in props || "url" in props || "label" in props);
}
```

```typescript
// Better: resolveJSXElement() のように関数同一性で分岐する
// （実際にこのリポジトリではそちらが本来の分岐ロジック）
if (type === Text) { ... }
if (type === Button) { ... }
```

## 導出ルール

- `[MUST]` マルチプラットフォーム抽象化では、コアインターフェースにジェネリクスのデフォルト型引数を設定し、利用者側の型引数指定を不要にする
  - 根拠: `Adapter<TThreadId = unknown, TRawMessage = unknown>` により、コア層は抽象的に、アダプター層は具体的に、利用者層は推論任せで動作する（`types.ts:90`）

- `[MUST]` シリアライズ境界では、ランタイムオブジェクトとは別にシリアライズ専用の型を定義し、非シリアライズ可能なフィールド（Date, Buffer, Function 等）の変換ルールを型で表現する
  - 根拠: `Message` と `SerializedMessage` が Date→ISO 文字列、Buffer→省略を型レベルで強制し、ランタイムエラーを防いでいる（`message.ts:43-72`）

- `[SHOULD]` 独自 JSX ランタイムでは `IntrinsicElements` を空オブジェクトにして HTML 要素を禁止し、許可する要素をコンポーネント関数の型で制限する
  - 根拠: `JSX.IntrinsicElements = {}` により `<div>` 等の使用がコンパイルエラーになり、ドメイン固有の UI 要素のみが許可される（`jsx-runtime.ts:675`）

- `[SHOULD]` 型の拡張ポイントには空の interface を公開し、`declare module` によるモジュール拡張で利用者が型を追加できるようにする
  - 根拠: `CustomEmojiMap` interface が空で公開され、利用者の拡張が `Emoji` 型全体に自動反映される（`types.ts:1298-1304`）

- `[SHOULD]` Mapped 型を使い、設定オブジェクトのキーから型安全な API 表面を自動生成する
  - 根拠: `Webhooks<TAdapters> = { [K in keyof TAdapters]: WebhookHandler }` により、アダプター名と webhook ハンドラーの一貫性がコンパイル時に保証される（`chat.ts:108-110`）

- `[SHOULD]` タグ付きユニオンの各メンバーにリテラル型の `type` フィールドを持たせ、switch 文による網羅チェックを活用する
  - 根拠: `CardChild` のメンバーはすべて `type: "text" | "image" | ...` を持ち、switch 文の default ケースで未処理のメンバーを検出できる（`cards.ts:142-148`）

- `[AVOID]` JSX ランタイムの要素解決でコンポーネント関数名の文字列比較を使うこと — ミニファイで壊れる。関数オブジェクトの同一性比較（`type === Text`）を使う
  - 根拠: `resolveJSXElement()` のコメントに「function names get minified in production builds」と明記（`jsx-runtime.ts:373-374`）

## 適用チェックリスト

- [ ] SDK のコアインターフェースにジェネリクスのデフォルト型引数を設定し、利用者が型引数を省略できるか確認する
- [ ] プラットフォーム固有の型（スレッド ID、メッセージペイロード等）がジェネリクスで注入される設計になっているか確認する
- [ ] シリアライズ対象のクラスに対応する `Serialized*` 型を定義し、`toJSON()`/`fromJSON()` の変換を型チェックしているか確認する
- [ ] ユニオン型のメンバーに `type` リテラルフィールドが一貫して付いているか、構造的弁別に頼っていないか確認する
- [ ] 型ガード関数がユニオン型のメンバーと 1:1 対応しており、新しいメンバー追加時に漏れが検出されるか確認する
- [ ] 利用者向けの型拡張ポイント（空 interface + `declare module`）が必要な箇所に用意されているか確認する
- [ ] Mapped 型で設定オブジェクトのキーから API 表面を自動生成し、不整合をコンパイル時に検出しているか確認する
