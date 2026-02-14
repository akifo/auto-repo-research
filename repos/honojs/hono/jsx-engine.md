# JSX Engine

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は React に依存せず、独自の JSX エンジンをゼロから実装している。サーバーサイド（文字列レンダリング）とクライアントサイド（DOM レンダリング）の両方を単一コードベースで提供し、React 互換の API サーフェスを維持しつつ、軽量かつエッジランタイムに最適化された設計が注目に値する。`StringBuffer` パターンによる非同期 HTML 生成、`use()` フックの throw Promise パターンによる Suspense 実装、そしてサーバー/クライアントで同一コンポーネントを動かすための Dual Runtime アーキテクチャが特徴的である。

## 設計・実装の詳細

### JSXNode クラス階層と文字列レンダリング

JSX エンジンの核は `JSXNode` クラスとその派生クラスである。3つのノード型がそれぞれ異なるレンダリング戦略を持つ。

- **`JSXNode`** -- HTML 要素タグ（`<div>`, `<span>` など）を表現する。`toStringToBuffer()` で開始タグ・属性・子要素・終了タグを `StringBuffer` に書き込む
- **`JSXFunctionNode`** -- 関数コンポーネントを表現する。`toStringToBuffer()` でコンポーネント関数を呼び出し、その戻り値を再帰的にレンダリングする
- **`JSXFragmentNode`** -- Fragment を表現する。ラッパー要素なしで子要素だけをレンダリングする

```typescript
// src/jsx/base.ts:130-141
export class JSXNode implements HtmlEscaped {
  tag: string | Function
  props: Props
  key?: string
  children: Child[]
  isEscaped: true = true as const
  localContexts?: LocalContexts
  constructor(tag: string | Function, props: Props, children: Child[]) {
    this.tag = tag
    this.props = props
    this.children = children
  }
```

`jsxFn` ファクトリ関数がタグの種類に応じて適切なノード型を選択する。特筆すべきは `intrinsicElementTags` にマッチするタグ（`title`, `script`, `style`, `link`, `meta`, `form`, `input`, `button`）が通常の HTML タグではなく `JSXFunctionNode` として生成される点である。これによりドキュメントメタデータの `<head>` 挿入やフォームアクションなどの特殊挙動を実現している。

```typescript
// src/jsx/base.ts:313-349
export const jsxFn = (
  tag: string | Function,
  props: Props,
  children: (string | number | HtmlEscapedString)[]
): JSXNode => {
  // ...
  if (typeof tag === 'function') {
    return new JSXFunctionNode(tag, props, children)
  } else if (intrinsicElementTags[tag as keyof typeof intrinsicElementTags]) {
    return new JSXFunctionNode(
      intrinsicElementTags[tag as keyof typeof intrinsicElementTags],
      props,
      children
    )
  } else if (tag === 'svg' || tag === 'head') {
    nameSpaceContext ||= createContext('')
    return new JSXNode(tag, props, [
      new JSXFunctionNode(nameSpaceContext, { value: tag }, children),
    ])
  } else {
    return new JSXNode(tag, props, children)
  }
}
```

### StringBuffer パターンによる非同期対応

文字列レンダリングの中核にある `StringBuffer` は、同期文字列と `Promise<string>` を交互に保持する配列構造である。これにより DOM ツリー走査中に非同期値に遭遇しても、文字列結合を中断せずにバッファに蓄積できる。

```typescript
// src/utils/html.ts:29-38
// StringBuffer contains string and Promise<string> alternately
// The length of the array will be odd, the odd numbered element will be a string,
// and the even numbered element will be a Promise<string>.
// When concatenating into a single string, it must be processed from the tail.
export type StringBuffer = (string | Promise<string>)[]
export type StringBufferWithCallbacks = StringBuffer & { callbacks: HtmlEscapedCallback[] }
```

通常の文字列は `buffer[0]` に直接連結（`buffer[0] += str`）し、Promise に遭遇すると `buffer.unshift('', promise)` で新しいスロットを追加する。最終的に `stringBufferToString` がバッファを末尾から順に resolve して1本の文字列に結合する。この設計により、同期部分は文字列連結のみで高速に処理し、非同期部分だけを Promise 化するという最適化が実現されている。

### Dual Runtime アーキテクチャ

Hono JSX は同一のコンポーネントをサーバーとクライアントの両方で動作させるために、2つのランタイムを提供する。

| エントリポイント | 用途 | レンダリング方式 |
|---|---|---|
| `hono/jsx` | サーバーサイド | `JSXNode.toString()` で HTML 文字列生成 |
| `hono/jsx/dom` | クライアントサイド | Virtual DOM ベースの DOM 操作 |

両ランタイムは同じ `JSXNode` 型定義と hooks API を共有するが、内部実装は完全に異なる。サーバーサイドの `jsxDEV`（`src/jsx/jsx-dev-runtime.ts`）は `jsxFn` を呼び出して `JSXNode` インスタンスを生成するが、DOM 側の `jsxDEV`（`src/jsx/dom/jsx-dev-runtime.ts`）はプレーンオブジェクトリテラルを返す。

```typescript
// src/jsx/dom/jsx-dev-runtime.ts:10-21
export const jsxDEV = (tag: string | Function, props: Props, key?: string): JSXNode => {
  if (typeof tag === 'string' && intrinsicElementTags[tag as keyof typeof intrinsicElementTags]) {
    tag = intrinsicElementTags[tag as keyof typeof intrinsicElementTags]
  }
  return {
    tag,
    type: tag,
    props,
    key,
    ref: props.ref,
  } as JSXNode
}
```

このプレーンオブジェクト化により、DOM ランタイムではノード生成のオーバーヘッドを最小化している。

### DOM_RENDERER による Server/Client 分岐

サーバーとクライアントのロジック分岐を実現する仕組みが `DOM_RENDERER` シンボルである。`Suspense` や `ErrorBoundary` などのコンポーネントは、サーバー用の実装を関数本体に持ち、クライアント用の実装を `DOM_RENDERER` プロパティに格納する。

```typescript
// src/jsx/streaming.ts:134
;(Suspense as HasRenderToDom)[DOM_RENDERER] = SuspenseDomRenderer

// src/jsx/components.ts:231
;(ErrorBoundary as HasRenderToDom)[DOM_RENDERER] = ErrorBoundaryDomRenderer
```

DOM レンダリング時、`invokeTag` 関数が `DOM_RENDERER` の有無を確認し、存在すればクライアント版を呼び出す。

```typescript
// src/jsx/dom/render.ts:248
const func = (node.tag as HasRenderToDom)[DOM_RENDERER] || node.tag
```

### Context 実装のシンプルさ

React の Context に相当する機能がわずか 54 行で実装されている。サーバーサイドでは `values` 配列のスタック操作（`push`/`pop`）で Provider のネストを表現し、`useContext` は単に `values.at(-1)` で最新値を取得する。

```typescript
// src/jsx/context.ts:15-50
export const createContext = <T>(defaultValue: T): Context<T> => {
  const values = [defaultValue]
  const context: Context<T> = ((props): HtmlEscapedString | Promise<HtmlEscapedString> => {
    values.push(props.value)
    let string
    try {
      string = props.children
        ? (Array.isArray(props.children)
            ? new JSXFragmentNode('', {}, props.children)
            : props.children
          ).toString()
        : ''
    } catch (e) {
      values.pop()
      throw e
    }
    if (string instanceof Promise) {
      return string
        .finally(() => values.pop())
        .then((resString) => raw(resString, (resString as HtmlEscapedString).callbacks))
    } else {
      values.pop()
      return raw(string)
    }
  }) as Context<T>
  context.values = values
  context.Provider = context
  // ...
}

export const useContext = <T>(context: Context<T>): T => {
  return context.values.at(-1) as T
}
```

Context 自体が関数コンポーネントとして動作し、Provider は Context 関数そのものへのエイリアスである。サーバーサイドの同期レンダリングではツリー走査が深さ優先で行われるため、push/pop のスタック操作だけでスコープが正しく管理される。非同期の場合は `finally` で値をポップすることで、Promise chain 完了後にスタックを復元している。

### Suspense とストリーミング

`Suspense` コンポーネントはサーバーサイドで Out-of-Order Streaming を実現する。子コンポーネントが Promise を返した場合、まず fallback をレンダリングし、Promise が解決された後にインラインスクリプトで DOM を差し替える。

```typescript
// src/jsx/streaming.ts:86-113
return raw(`<template id="H:${index}"></template>${fallbackStr}<!--/$-->`, [
  ...(fallbackStr.callbacks || []),
  ({ phase, buffer, context }) => {
    if (phase === HtmlEscapedCallbackPhase.BeforeStream) {
      return
    }
    return Promise.all(resArray).then(async (htmlArray) => {
      // ...
      let html = buffer
        ? ''
        : `<template data-hono-target="H:${index}">${content}</template><script>
((d,c,n) => {
c=d.currentScript.previousSibling
d=d.getElementById('H:${index}')
if(!d)return
do{n=d.nextSibling;n.remove()}while(n.nodeType!=8||n.nodeValue!='/$')
d.replaceWith(c.content)
})(document)
</script>`
```

`HtmlEscapedCallback` の `phase` パラメータにより、`BeforeStream`（初回バッファリング）と `Stream`（ストリーミング中）で挙動を切り替えている。`renderToReadableStream` は `ReadableStream` を返し、コールバックチェーンを再帰的に解決しながらチャンクを送出する。

### Hooks の実装と buildDataStack

Hooks はサーバーとクライアントで同一の実装を共有する。`buildDataStack` がレンダリング中のノードコンテキストを管理し、各 Hook はノードの `DOM_STASH` に状態を保持する。

```typescript
// src/jsx/hooks/index.ts:182-243
export const useState: UseStateType = <T>(
  initialState?: T | (() => T)
): [T, UpdateStateFunction<T>] => {
  const resolveInitialState = () =>
    typeof initialState === 'function' ? (initialState as () => T)() : (initialState as T)

  const buildData = buildDataStack.at(-1) as [unknown, NodeObject]
  if (!buildData) {
    return [resolveInitialState(), () => {}]
  }
  const [, node] = buildData
  const stateArray = (node[DOM_STASH][1][STASH_SATE] ||= [])
  const hookIndex = node[DOM_STASH][0]++
  return (stateArray[hookIndex] ||= [
    resolveInitialState(),
    (newState: T | ((currentState: T) => T)) => { /* ... */ },
  ])
}
```

`buildDataStack` が空の場合（サーバーサイドの文字列レンダリング中）は初期値とノーオペレーション setter を返す。これにより、サーバーでは hooks が副作用を持たない形でフォールバックする。

### use() フックの throw Promise パターン

`use()` フックは React と同様に Promise を throw して Suspense boundary まで巻き戻す設計を採用している。`WeakMap` でキャッシュされた resolved 値があればそれを返し、なければ `.then` で結果をキャッシュした上で Promise を throw する。

```typescript
// src/jsx/hooks/index.ts:332-346
export const use = <T>(promise: Promise<T>): T => {
  const cachedRes = resolvedPromiseValueMap.get(promise) as [T] | [undefined, unknown] | undefined
  if (cachedRes) {
    if (cachedRes.length === 2) {
      throw cachedRes[1]
    }
    return cachedRes[0] as T
  }
  promise.then(
    (res) => resolvedPromiseValueMap.set(promise, [res]),
    (e) => resolvedPromiseValueMap.set(promise, [undefined, e])
  )
  throw promise
}
```

## コード例

属性の正規化処理。React 互換の `className` -> `class` 変換を Map で管理する:

```typescript
// src/jsx/utils.ts:1-12
const normalizeElementKeyMap: Map<string, string> = new Map([
  ['className', 'class'],
  ['htmlFor', 'for'],
  ['crossOrigin', 'crossorigin'],
  ['httpEquiv', 'http-equiv'],
  ['itemProp', 'itemprop'],
  ['fetchPriority', 'fetchpriority'],
  ['noModule', 'nomodule'],
  ['formAction', 'formaction'],
])
export const normalizeIntrinsicElementKey = (key: string): string =>
  normalizeElementKeyMap.get(key) || key
```

スタイルオブジェクトの camelCase -> kebab-case 変換と単位自動付与:

```typescript
// src/jsx/utils.ts:14-36
export const styleObjectForEach = (
  style: Record<string, string | number>,
  fn: (key: string, value: string | null) => void
): void => {
  for (const [k, v] of Object.entries(style)) {
    const key =
      k[0] === '-' || !/[A-Z]/.test(k)
        ? k
        : k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
    fn(
      key,
      v == null
        ? null
        : typeof v === 'number'
          ? !key.match(
              /^(?:a|border-im|column(?:-c|s)|flex(?:$|-[^b])|grid-(?:ar|[^a])|font-w|li|or|sca|st|ta|wido|z)|ty$/
            )
            ? `${v}px`
            : `${v}`
          : v
    )
  }
}
```

## Good Patterns

- **StringBuffer によるゼロコピー文字列構築**: 文字列を直接 `buffer[0] +=` で結合し、非同期値に遭遇した時だけ `unshift` でスロットを追加する。これにより同期パスでは中間オブジェクトの生成を最小化し、非同期パスでも必要最小限の Promise 化で済む。テンプレートリテラルの連結や `Array.join` よりも効率的なアプローチである。

```typescript
// src/jsx/base.ts:97-117
const childrenToStringToBuffer = (children: Child[], buffer: StringBufferWithCallbacks): void => {
  for (let i = 0, len = children.length; i < len; i++) {
    const child = children[i]
    if (typeof child === 'string') {
      escapeToBuffer(child, buffer)
    } else if (typeof child === 'boolean' || child === null || child === undefined) {
      continue
    } else if (child instanceof JSXNode) {
      child.toStringToBuffer(buffer)
    } else if (
      typeof child === 'number' ||
      (child as unknown as { isEscaped: boolean }).isEscaped
    ) {
      ;(buffer[0] as string) += child
    } else if (child instanceof Promise) {
      buffer.unshift('', child)
    } else {
      childrenToStringToBuffer(child, buffer)
    }
  }
}
```

- **DOM_RENDERER シンボルによる Server/Client ポリモーフィズム**: コンポーネント関数にシンボルプロパティでクライアント用実装を付与する設計。条件分岐やファクトリパターンではなく、シンボルの有無で分岐するため、Tree-shaking でサーバー専用ビルドからクライアントコードを除去しやすい。

```typescript
// src/jsx/streaming.ts:42-43,134
export const Suspense: FC<PropsWithChildren<{ fallback: any }>> = async ({
  children, fallback,
}) => { /* サーバー用: HTML 文字列を生成 */ }
;(Suspense as HasRenderToDom)[DOM_RENDERER] = SuspenseDomRenderer
// -> DOM レンダリング時は SuspenseDomRenderer が呼ばれる
```

- **Context をスタック配列で管理する軽量パターン**: Provider のネストを `values.push()` / `values.pop()` だけで管理する。React の Fiber ベースの複雑な Context 伝搬と比べて極めてシンプルで、サーバーサイドの深さ優先走査と自然に適合する。54 行で Context API 全体が実装されている。

```typescript
// src/jsx/context.ts:52-54
export const useContext = <T>(context: Context<T>): T => {
  return context.values.at(-1) as T
}
```

- **Intrinsic Element のコンポーネント化**: `title`, `link`, `meta`, `script`, `style` などのメタデータタグを関数コンポーネントとして実装することで、body 内に記述しても自動的に `<head>` に挿入されるという React 19 互換の挙動を実現している。サーバーサイドでは `HtmlEscapedCallback` で `</head>` 直前に挿入、DOM 側では `createPortal` で `document.head` にマウントする。

```typescript
// src/jsx/intrinsic-element/components.ts:21-76
const insertIntoHead: (...) => HtmlEscapedCallback =
  (tagName, tag, props, precedence) =>
  ({ buffer, context }): undefined => {
    if (!buffer) { return }
    // ...
    if (buffer[0].indexOf('</head>') !== -1) {
      buffer[0] = buffer[0].replace(/(?=<\/head>)/, insertTags.join(''))
    }
  }
```

## Anti-Patterns / 注意点

- **サーバーサイドでの Hooks の暗黙的ノーオペレーション**: `buildDataStack` が空（サーバーサイド文字列レンダリング中）の場合、`useState` は初期値を返し setter はノーオペレーションになる。これは意図的な設計だが、開発者がサーバーコンポーネント内で `useState` を使っても何のエラーも発生しないため、状態が反映されないバグを見逃す可能性がある。

```typescript
// Bad: サーバーコンポーネントで useState を使ってもエラーにならない
const ServerComponent = () => {
  const [count, setCount] = useState(0) // 常に 0、setCount は何もしない
  return <div>{count}</div>
}

// Better: サーバー/クライアントの境界を意識した設計
// クライアント専用コンポーネントは hono/jsx/dom からインポート
// サーバーコンポーネントでは状態管理を使わない
```

- **グローバル変数による Context と Suspense カウンター**: `globalContexts` 配列、`suspenseCounter`、`errorBoundaryCounter` がモジュールスコープのグローバル変数として管理されている。これはシングルリクエスト環境では問題ないが、同一プロセスで複数リクエストを並行処理する場合にカウンターの衝突やコンテキストの漏洩が発生し得る。

```typescript
// src/jsx/context.ts:13
export const globalContexts: Context<unknown>[] = []

// src/jsx/streaming.ts:34
let suspenseCounter = 0
```

- **any 型の多用**: JSX エンジン内部では型安全性よりも柔軟性を優先し、`any` 型が多用されている。`eslint-disable` コメントで明示的に許可しているが、型安全性の保証はコンポーネント利用者側の `IntrinsicElements` 型定義に委ねられている。独自 JSX エンジンを実装する場合は、内部の型安全性をより高めることを検討すべきである。

## 自分のプロジェクトへの適用

- [ ] StringBuffer パターンを参考に、非同期テンプレートレンダリングの実装を検討する。同期部分は文字列結合、非同期部分だけ Promise 化する戦略は HTML 以外のテキスト生成にも応用できる
- [ ] Symbol プロパティによるランタイム分岐パターンを、サーバー/クライアント共有コンポーネントの設計に採用する。条件分岐よりも Tree-shaking に有利
- [ ] Context のスタック配列パターンを、深さ優先走査が保証される場面（SSR、AST 変換など）で軽量な状態伝搬手段として活用する
- [ ] Intrinsic Element をコンポーネント化するパターンを参考に、特定の HTML 要素に対して透過的に振る舞いを追加する設計を検討する（例: 自動 lazy loading、CSP nonce 挿入など）
- [ ] `HtmlEscapedCallback` の phase ベース設計を参考に、レンダリングパイプラインの各段階で異なる処理を挟むコールバック機構を設計する
