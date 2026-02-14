# JSX Engine

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は React 互換の独自 JSX ランタイムをフルスクラッチで実装している。SSR 用の文字列レンダラーと DOM 用のクライアントレンダラーという2つの完全に異なるレンダリングバックエンドを、同一の JSX API 表面から `Symbol` ベースのディスパッチで切り替える設計が特徴的である。外部依存ゼロで React 19 互換の hooks・Suspense・Context・ErrorBoundary を実現しており、Web フレームワークに組み込むための JSX エンジン設計の好例として注目に値する。

## 設計思想

- **SSR ファーストの文字列ベースレンダリング**: JSX ノードの `toString()` が直接 HTML 文字列を生成する。仮想 DOM のツリー走査や差分計算を介さず、`StringBuffer` パターンで文字列を効率的に連結する。サーバーサイドでは DOM API が不要であり、文字列連結のほうが圧倒的に高速であるという判断が根拠。(`src/jsx/base.ts:153-170`)
- **Symbol ベースの環境適応**: `DOM_RENDERER` Symbol をコンポーネント関数に付与し、同一コンポーネントがサーバーとクライアントで異なるレンダリングロジックを実行する。環境ごとに別パッケージを作るのではなく、1つのコンポーネント定義に複数のレンダラーをアタッチすることで、API の一貫性とバンドルサイズの最適化を両立している。(`src/jsx/constants.ts:1`, `src/jsx/dom/render.ts:248`)
- **コールバックチェーンによる遅延処理**: `HtmlEscapedString` 型に `callbacks` 配列を持たせ、ストリーミングや `<head>` へのメタタグ挿入などの副作用を文字列レンダリング後に遅延実行する。これにより、レンダリングパイプラインを直線的に保ちつつ、複雑な非同期処理を合成可能にしている。(`src/utils/html.ts:17-21`)
- **React API 互換を明示的な目標とする**: `reactAPICompatVersion = '19.0.0-hono-jsx'` と宣言し、`StrictMode = Fragment`、`createElement = jsx` といったエイリアスで互換レイヤーを構成する。既存の React エコシステムのライブラリが動作する可能性を最大化する設計判断。(`src/jsx/base.ts:442`, `src/jsx/index.ts:42`)

## 設計・実装の詳細

### JSXNode のクラス階層とレンダリング分岐

JSX ノードは3つのクラスで表現される。`JSXNode`（HTML 要素）、`JSXFunctionNode`（関数コンポーネント）、`JSXFragmentNode`（Fragment）である。ファクトリ関数 `jsxFn` が `tag` の型に応じて適切なクラスを選択する。

```typescript
// src/jsx/base.ts:313-349
export const jsxFn = (
  tag: string | Function,
  props: Props,
  children: (string | number | HtmlEscapedString)[]
): JSXNode => {
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

注目すべきは `title`、`script`、`style`、`link`、`meta`、`form` 等の特別な HTML タグが `intrinsicElementTags` として関数コンポーネント化されている点である。これにより `<head>` 内メタタグの重複排除やソートといった高度な振る舞いを、通常の JSX レンダリングパイプライン内で実現している。

### StringBuffer パターンによる高効率な文字列連結

`StringBuffer` は文字列と `Promise<string>` を交互に格納する配列で、末尾から結合する設計になっている。同期的に処理できる部分は `buffer[0]` に直接追記し、非同期値が出現したときだけ `buffer.unshift('', promise)` で挿入する。

```typescript
// src/utils/html.ts:23-37
// StringBuffer contains string and Promise<string> alternately
// The length of the array will be odd, the odd numbered element will be a string,
// and the even numbered element will be a Promise<string>.
// When concatenating into a single string, it must be processed from the tail.
// @example
// [
//   'framework.',
//   Promise.resolve('ultra fast'),
//   'a ',
//   Promise.resolve('is '),
//   'Hono',
// ]
```

この設計により、完全に同期的なコンポーネントツリーでは Promise を一切生成せずに文字列を返せる。`buffer.length === 1` のチェックで同期パスを判定している（`src/jsx/base.ts:165-169`）。

### Suspense のストリーミング SSR 実装

`Suspense` コンポーネントは、子コンポーネントの Promise が解決される前にフォールバック HTML を送出し、解決後にインラインスクリプトで DOM を差し替える。

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

`<template>` + コメントノードをマーカーとして使い、ストリーミング完了後にインラインスクリプトが DOM を書き換える。React の `renderToReadableStream` と同等のパターンだが、外部ランタイムスクリプト不要で各チャンクが自己完結的に DOM を更新する点が異なる。

### DOM レンダラーの仮想 DOM 実装

クライアントサイドの DOM レンダラー（`src/jsx/dom/render.ts`）は、`NodeObject` という独自の仮想 DOM ノードで差分更新を行う。`NodeObject` はプロパティ名を1-2文字に短縮してメモリ効率を最適化している。

```typescript
// src/jsx/dom/render.ts:41-65
export type NodeObject = {
  pP: Props | undefined        // previous props
  nN: Node | undefined          // next node
  vC: Node[]                    // virtual dom children
  pC?: Node[]                   // previous virtual dom children
  vR: Node[]                    // virtual dom children to remove
  n?: string                    // namespace
  f?: boolean                   // force build
  s?: boolean                   // skip build and apply
  c: Container | undefined      // container
  e: SupportedElement | Text | undefined  // rendered element
  // ...
}
```

`build` 関数がツリーを再帰的に構築し、key ベースの差分比較で既存ノードを再利用する。`memo` されたコンポーネントは `DOM_MEMO` Symbol で比較関数を参照し、props が同一ならビルドをスキップする（`src/jsx/dom/render.ts:539-545`）。

### Context のスタックベース実装

Context は `values` 配列をスタックとして使い、Provider のレンダリング開始時に `push`、終了時に `pop` する。`useContext` は単に `values.at(-1)` を返すだけである。

```typescript
// src/jsx/context.ts:15-54
export const createContext = <T>(defaultValue: T): Context<T> => {
  const values = [defaultValue]
  const context: Context<T> = ((props) => {
    values.push(props.value)
    let string
    try {
      string = props.children ? /* render children */ : ''
    } catch (e) {
      values.pop()
      throw e
    }
    if (string instanceof Promise) {
      return string.finally(() => values.pop()).then(...)
    } else {
      values.pop()
      return raw(string)
    }
  }) as Context<T>
  // ...
}

export const useContext = <T>(context: Context<T>): T => {
  return context.values.at(-1) as T
}
```

SSR では同期的なスタック操作で十分だが、非同期コンポーネント（`JSXFunctionNode` が `Promise` を返す場合）では `localContexts` にコンテキストのスナップショットを保存し、Promise 解決時に復元する（`src/jsx/base.ts:259-273`）。

### DOM レンダラーの `createRoot` と hooks の統合

`createRoot` は内部的に `useState` を使って状態管理を行う巧みな設計になっている。ルートコンポーネントを `useState` でラップし、`render()` の再呼び出し時は `setJsxNode` で状態を更新するだけで再レンダリングが走る。

```typescript
// src/jsx/dom/client.ts:47-53
renderNode(
  buildNode({
    tag: () => {
      const [_jsxNode, _setJsxNode] = useState(jsxNode)
      setJsxNode = _setJsxNode
      return _jsxNode
    },
    props: {},
  } as any) as NodeObject,
  element
)
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 同一の JSX ツリーに対して、文字列レンダリング（SSR）と DOM 操作（クライアント）という異なるアルゴリズムを適用する必要がある
  - 適用条件: コンポーネントが複数のレンダリング環境で動作する必要があるとき
  - コード例: `src/jsx/constants.ts:1`（`DOM_RENDERER` Symbol）、`src/jsx/dom/render.ts:248`（`invokeTag` でのディスパッチ）
  - 注意点: Symbol をキーに使うことでプロパティの衝突を完全に回避しているが、デバッグ時にはプロパティが見えにくい

- **Composite パターン** (分類: 構造)
  - 解決する問題: JSX ツリーの再帰的な構造（要素ノード・関数ノード・テキストの混在）を統一的に扱う
  - 適用条件: ツリー構造を持つ UI 記述言語のレンダラー実装
  - コード例: `src/jsx/base.ts:130-141`（`JSXNode` クラス）、`src/jsx/base.ts:97-118`（`childrenToStringToBuffer` の再帰処理）
  - 注意点: `JSXNode`、`JSXFunctionNode`、`JSXFragmentNode` の3つのクラスが `toStringToBuffer` を各々オーバーライドする

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 文字列レンダリングの全体構造（開始タグ → 属性 → 子要素 → 閉じタグ）を固定しつつ、ノードの種類ごとに処理を変える
  - 適用条件: HTML レンダリングのように定型的な処理フローの一部をカスタマイズしたいとき
  - コード例: `src/jsx/base.ts:172-241`（`JSXNode.toStringToBuffer`）、`src/jsx/base.ts:245-286`（`JSXFunctionNode.toStringToBuffer` のオーバーライド）

## Good Patterns

- **isEscaped フラグによる二重エスケープ防止**: `HtmlEscapedString` 型に `isEscaped: true` フラグを持たせ、既にエスケープ済みの文字列を再エスケープしない。JSXNode 自体も `isEscaped: true` を持ち、`toString()` の結果が安全な文字列であることを型レベルで保証している。
  ```typescript
  // src/jsx/base.ts:130-135
  export class JSXNode implements HtmlEscaped {
    tag: string | Function
    props: Props
    key?: string
    children: Child[]
    isEscaped: true = true as const
  ```

- **同期パスの最適化**: `StringBuffer` の長さが1（非同期値なし）の場合、Promise を生成せずに即座に文字列を返す。大半の SSR コンポーネントは同期的なので、この最適化によりメモリアロケーションとマイクロタスクのオーバーヘッドを回避できる。
  ```typescript
  // src/jsx/base.ts:165-169
  return buffer.length === 1
    ? 'callbacks' in buffer
      ? resolveCallbackSync(raw(buffer[0], buffer.callbacks)).toString()
      : buffer[0]
    : stringBufferToString(buffer, buffer.callbacks)
  ```

- **intrinsic element の関数コンポーネント化**: `<title>`, `<link>`, `<meta>` 等を関数コンポーネントとして実装し、`<head>` への重複排除やソートを透過的に行う。ユーザーは通常の JSX を書くだけで React 19 と同等のドキュメントメタデータ管理が実現される。
  ```typescript
  // src/jsx/intrinsic-element/components.ts:107-121
  export const title: FC<PropsWithChildren> = ({ children, ...props }) => {
    const nameSpaceContext = getNameSpaceContext()
    if (nameSpaceContext) {
      const context = useContext(nameSpaceContext)
      if (context === 'svg' || context === 'head') {
        return new JSXNode('title', props, toArray(children ?? []) as Child[])
      }
    }
    return documentMetadataTag('title', children, props, false)
  }
  ```

## Anti-Patterns / 注意点

- **フォールバックとしての `any` 型の多用**: DOM レンダラー周辺で `as any` が頻出する。型安全性を犠牲にしてランタイムの柔軟性を確保しているが、`NodeObject` と `JSXNode` の境界が曖昧になりやすい。
  ```typescript
  // Bad: src/jsx/dom/render.ts:763
  renderNode(buildNode({ tag: '', props: { children: jsxNode } } as any) as NodeObject, container)

  // Better: 明示的な変換関数を用意して型の境界を明確にする
  const createRootNode = (jsxNode: Child): NodeObject => ({
    tag: '',
    props: { children: jsxNode },
    // ... required NodeObject fields with defaults
  })
  ```

- **グローバルミュータブル状態への依存**: `suspenseCounter`、`errorBoundaryCounter`、`idCounter`、`nameSpaceContext` など、モジュールレベルの可変状態が複数存在する。単一リクエストを処理するサーバーでは問題にならないが、ワーカー環境での並行リクエスト処理時にカウンタが共有される可能性がある。
  ```typescript
  // Bad: src/jsx/streaming.ts:34
  let suspenseCounter = 0

  // Better: レンダリングコンテキストにカウンタを紐づける
  // context.suspenseCounter = (context.suspenseCounter ?? 0) + 1
  ```

## 導出ルール

- `[MUST]` SSR 用 JSX エンジンでは、文字列結合の同期パスと非同期パスを明確に分離し、同期パスでは Promise を一切生成しないこと
  - 根拠: Hono の `StringBuffer` 設計では `buffer.length === 1` チェックで同期パスを分岐し、大半のコンポーネントで不要なメモリアロケーションを回避している（`src/jsx/base.ts:165-169`）
- `[MUST]` HTML 文字列を生成する JSX エンジンでは、エスケープ済みフラグ（`isEscaped`）を型レベルで管理し、二重エスケープを防止すること
  - 根拠: Hono は `HtmlEscaped` インターフェースで `isEscaped: true` を強制し、`raw()` ヘルパーで明示的にフラグを設定する設計でセキュリティと正確性を両立している（`src/utils/html.ts:17-21`, `src/jsx/base.ts:135`）
- `[SHOULD]` 複数のレンダリングバックエンド（SSR / DOM / ストリーミング）を持つ JSX エンジンでは、Symbol ベースのディスパッチでコンポーネントに環境別ロジックをアタッチすること
  - 根拠: Hono は `DOM_RENDERER` Symbol でコンポーネント関数にクライアント用レンダラーを付与し、`invokeTag` 内で `(node.tag as HasRenderToDom)[DOM_RENDERER] || node.tag` と切り替える（`src/jsx/dom/render.ts:248`）
- `[SHOULD]` ストリーミング SSR の Suspense 実装では、各チャンクにインラインスクリプトを含めて自己完結的な DOM 更新を実現し、外部ランタイムスクリプトへの依存を排除すること
  - 根拠: Hono の `Suspense` は `<template>` + コメントノードをマーカーとし、解決後のチャンクに DOM 書き換えスクリプトを埋め込む設計で、追加の JS バンドルなしにストリーミングを実現している（`src/jsx/streaming.ts:103-113`）
- `[SHOULD]` Context の実装は値スタック（配列の push/pop）で管理し、useContext は常にスタックの末尾を参照するだけにすること
  - 根拠: Hono の `createContext` は `values` 配列に Provider の値を push し、レンダリング完了後に pop する。`useContext` は `values.at(-1)` を返すだけの O(1) 操作である（`src/jsx/context.ts:52-54`）
- `[AVOID]` JSX エンジンの仮想 DOM ノード型に通常の文字列キーを使うこと。短縮プロパティ名は内部ノード型でのみ使い、公開 API 型では意味のある名前を保つこと
  - 根拠: Hono の `NodeObject` は `pP`、`nN`、`vC` 等の短縮名でメモリ効率を最適化しているが、コードの可読性は低下しておりコメントでの補足が必須になっている（`src/jsx/dom/render.ts:41-65`）

## 適用チェックリスト

- [ ] JSX エンジンの `toString()` に同期パスの短絡評価があるか確認する（Promise 不使用時に即座に文字列を返すか）
- [ ] HTML エスケープの仕組みに「エスケープ済み」フラグがあるか確認する（二重エスケープの防止）
- [ ] SSR とクライアントで異なるレンダリングロジックが必要な場合、Symbol ベースのディスパッチパターンを検討する
- [ ] ストリーミング SSR の Suspense フォールバック実装で、外部ランタイムスクリプトへの依存が発生していないか確認する
- [ ] Context 実装がレンダリングの再帰構造と整合するスタックベースになっているか確認する
- [ ] `<title>`、`<meta>`、`<link>` 等のドキュメントメタデータタグに特別な処理（重複排除、`<head>` への自動挿入）が必要か検討する
- [ ] 仮想 DOM ノードのプロパティ名短縮による最適化と可読性のトレードオフを評価する
