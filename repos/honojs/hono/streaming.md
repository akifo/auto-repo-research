# Streaming

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のストリーミングは Web Standards（ReadableStream / WritableStream / TransformStream）を基盤とした 3 層アーキテクチャで構成される。低レベルの `StreamingApi` クラス、3 種のヘルパー関数（`stream` / `streamText` / `streamSSE`）、そして JSX ストリーミングレンダリング（`Suspense` + `renderToReadableStream`）という階層設計が特徴的。ランタイム差異（特に Bun）を吸収する工夫や、SSE プロトコルの正確な実装、Out-of-Order Streaming による JSX の段階的レンダリングなど、実用的なパターンが豊富に含まれている。

## 設計・実装の詳細

### 3 層ストリーミングアーキテクチャ

Hono のストリーミングは以下の 3 層で構成される。

**Layer 1: StreamingApi（コアクラス）**
`src/utils/stream.ts` に定義される基底クラス。`TransformStream` を使い、`WritableStream` 側に書き込み、`ReadableStream` 側をレスポンスボディとして返す。`write` / `writeln` / `close` / `pipe` / `sleep` / `abort` / `onAbort` といったプリミティブを提供する。

**Layer 2: ヘルパー関数（stream / streamText / streamSSE）**
`src/helper/streaming/` 配下に定義。`StreamingApi` をラップし、Context から Response 生成までのライフサイクルを管理する。各ヘルパーは適切な HTTP ヘッダーを自動設定する。

**Layer 3: JSX ストリーミング（Suspense + renderToReadableStream）**
`src/jsx/streaming.ts` に定義。React-like な `Suspense` コンポーネントで非同期コンテンツを段階的にストリーミングする Out-of-Order Streaming を実現する。

### TransformStream を介した読み書き分離パターン

`StreamingApi` は `TransformStream` の writable 側と readable 側を分離して保持する。readable 側はさらに新しい `ReadableStream` でラップし、`cancel` イベントでクライアント切断を検知する。

```typescript
// src/utils/stream.ts:21-44
constructor(writable: WritableStream, _readable: ReadableStream) {
  this.writable = writable
  this.writer = writable.getWriter()
  this.encoder = new TextEncoder()

  const reader = _readable.getReader()

  // クライアント切断時に reader をキャンセル
  this.abortSubscribers.push(async () => {
    await reader.cancel()
  })

  this.responseReadable = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read()
      done ? controller.close() : controller.enqueue(value)
    },
    cancel: () => {
      this.abort()
    },
  })
}
```

この設計により、外部から `responseReadable` の cancel が呼ばれると `abort()` が発火し、登録済みの全 `abortSubscribers` が呼び出される。

### ヘルパー関数のライフサイクル管理

`stream()` ヘルパーは即座に Response を返しつつ、非同期でコールバックを実行する「Fire-and-Forget」パターンを使う。

```typescript
// src/helper/streaming/stream.ts:7-45
export const stream = (
  c: Context,
  cb: (stream: StreamingApi) => Promise<void>,
  onError?: (e: Error, stream: StreamingApi) => Promise<void>
): Response => {
  const { readable, writable } = new TransformStream()
  const stream = new StreamingApi(writable, readable)

  // Bun 互換性対応
  if (isOldBunVersion()) {
    c.req.raw.signal.addEventListener('abort', () => {
      if (!stream.closed) {
        stream.abort()
      }
    })
  }

  // Bun では Response 返却後に Context が破棄されるため WeakMap で保持
  contextStash.set(stream.responseReadable, c)
  ;(async () => {
    try {
      await cb(stream)
    } catch (e) {
      if (e === undefined) {
        // ReadableStream のキャンセルで pipeTo が undefined で reject する場合
      } else if (e instanceof Error && onError) {
        await onError(e, stream)
      } else {
        console.error(e)
      }
    } finally {
      stream.close()
    }
  })()

  return c.newResponse(stream.responseReadable)
}
```

ポイントは 3 つある:
1. **即時 Response 返却**: IIFE で非同期処理を起動し、`stream.responseReadable` を即座に Response として返す
2. **finally での確実なクローズ**: コールバックの成否に関わらず `stream.close()` が呼ばれる
3. **undefined 例外の無視**: `stream.abort()` 経由で `pipeTo` が undefined で reject するケースを正しくハンドリングする

### SSE プロトコルの正確な実装

`SSEStreamingApi` は `StreamingApi` を継承し、SSE フォーマットの `writeSSE` メソッドを追加する。

```typescript
// src/helper/streaming/sse.ts:18-38
async writeSSE(message: SSEMessage) {
  const data = await resolveCallback(message.data, HtmlEscapedCallbackPhase.Stringify, false, {})
  const dataLines = (data as string)
    .split(/\r\n|\r|\n/)
    .map((line) => {
      return `data: ${line}`
    })
    .join('\n')

  const sseData =
    [
      message.event && `event: ${message.event}`,
      dataLines,
      message.id && `id: ${message.id}`,
      message.retry && `retry: ${message.retry}`,
    ]
      .filter(Boolean)
      .join('\n') + '\n\n'

  await this.write(sseData)
}
```

注目すべき点:
- **改行コードの正規化**: `\r\n` / `\r` / `\n` すべてを正しく `data:` プレフィックス付き複数行に変換
- **SSE フィールド順序**: event → data → id → retry の順で出力
- **JSX サポート**: `resolveCallback` を通すことで、`data` フィールドに JSX 要素や `Promise<string>` を直接渡せる
- **エラー時のイベント送信**: `onError` ハンドラ実行後に `event: error` を SSE で送信する

`streamSSE` は SSE に必要な 4 つのヘッダーを自動設定する:

```typescript
// src/helper/streaming/sse.ts:86-89
c.header('Transfer-Encoding', 'chunked')
c.header('Content-Type', 'text/event-stream')
c.header('Cache-Control', 'no-cache')
c.header('Connection', 'keep-alive')
```

### JSX Out-of-Order Streaming

`Suspense` コンポーネントと `renderToReadableStream` の組み合わせで、React-like な Out-of-Order Streaming を実現する。

1. **初回チャンク**: fallback HTML + `<template id="H:N">` プレースホルダーを送信
2. **解決後チャンク**: 実コンテンツを `<template data-hono-target="H:N">` に格納し、インラインスクリプトでプレースホルダーを置換

```typescript
// src/jsx/streaming.ts:86-113
// fallback + placeholder を返却
return raw(`<template id="H:${index}"></template>${fallbackStr}<!--/$-->`, [
  ...(fallbackStr.callbacks || []),
  ({ phase, buffer, context }) => {
    if (phase === HtmlEscapedCallbackPhase.BeforeStream) {
      return
    }
    return Promise.all(resArray).then(async (htmlArray) => {
      // ... 解決後の HTML を生成
      let html = buffer
        ? ''
        : `<template data-hono-target="H:${index}">${content}</template><script${
            nonce ? ` nonce="${nonce}"` : ''
          }>
((d,c,n) => {
c=d.currentScript.previousSibling
d=d.getElementById('H:${index}')
if(!d)return
do{n=d.nextSibling;n.remove()}while(n.nodeType!=8||n.nodeValue!='/$')
d.replaceWith(c.content)
})(document)
</script>`
      // ...
    })
  },
])
```

インラインスクリプトは最小限（約 150 バイト）で、DOM 操作のみを行う:
1. `<template>` からコンテンツを取得
2. 対応する placeholder を ID で検索
3. placeholder からコメントノード `<!--/$-->` までを削除
4. `<template>` のコンテンツで置換

### ランタイム互換性レイヤー

Bun v1.1.27 未満では `ReadableStream` の `cancel()` が正しく呼ばれない問題があり、`AbortSignal` で代替する。

```typescript
// src/helper/streaming/utils.ts:1-11
export let isOldBunVersion = (): boolean => {
  const version: string = typeof Bun !== 'undefined' ? Bun.version : undefined
  if (version === undefined) {
    return false
  }
  const result = version.startsWith('1.1') || version.startsWith('1.0') || version.startsWith('0.')
  // 毎回チェックを避けるため関数自体を結果で上書き
  isOldBunVersion = () => result
  return result
}
```

自己書き換えパターン（memoization by self-replacement）により、初回呼び出し後はバージョンチェックのコストがゼロになる。

### 圧縮ミドルウェアとの連携

`src/utils/compress.ts` の `COMPRESSIBLE_CONTENT_TYPE_REGEX` は `text/event-stream` を明示的に除外している。SSE ストリームは圧縮するとバッファリングが発生し、リアルタイム性が損なわれるため、これは正しい設計判断。

### Context の WeakMap 保持

Bun では `Response` を返した時点で `Context` オブジェクトが GC される可能性がある。`contextStash` (WeakMap) で `ReadableStream` をキーに `Context` を保持することで、ストリーミング完了まで Context が生存することを保証する。

```typescript
// src/helper/streaming/stream.ts:5
const contextStash: WeakMap<ReadableStream, Context> = new WeakMap<ReadableStream, Context>()

// src/helper/streaming/stream.ts:25
contextStash.set(stream.responseReadable, c)
```

`WeakMap` を使うことで、ストリーミング完了後は `ReadableStream` と共に自然に GC される。

## コード例

### 基本的な stream ヘルパーの使用

```typescript
// src/helper/streaming/stream.test.ts:12-17
const res = stream(c, async (stream) => {
  for (let i = 0; i < 3; i++) {
    await stream.write(new Uint8Array([i]))
    await stream.sleep(1)
  }
})
```

### SSE ストリーミングの使用

```typescript
// src/helper/streaming/sse.test.tsx:15-25
const res = streamSSE(c, async (stream) => {
  let id = 0
  const maxIterations = 5

  while (id < maxIterations) {
    const message = `Message\nIt is ${id}`
    await stream.writeSSE({ data: message, event: 'time-update', id: String(id++) })
    await stream.sleep(10)
  }
})
```

### Suspense + renderToReadableStream

```typescript
// src/jsx/streaming.test.tsx:22-36
const Content = () => {
  const content = new Promise<HtmlEscapedString>((resolve) =>
    setTimeout(() => resolve(<h1>Hello</h1>), 10)
  )
  return content
}

const stream = renderToReadableStream(
  <Suspense fallback={<p>Loading...</p>}>
    <Content />
  </Suspense>
)
```

### クライアント切断のハンドリング

```typescript
// src/helper/streaming/stream.test.ts:28-47
const res = stream(c, async (stream) => {
  stream.onAbort(() => {
    aborted = true
  })
  for (let i = 0; i < 3; i++) {
    await stream.write(new Uint8Array([i]))
    await stream.sleep(1)
  }
})
// reader.cancel() でクライアント切断をシミュレート
```

### JSX Renderer ミドルウェアでのストリーミング有効化

```typescript
// src/middleware/jsx-renderer/index.ts:60-73
if (options?.stream) {
  if (options.stream === true) {
    c.header('Transfer-Encoding', 'chunked')
    c.header('Content-Type', 'text/html; charset=UTF-8')
    c.header('Content-Encoding', 'Identity')
  } else {
    for (const [key, value] of Object.entries(options.stream)) {
      c.header(key, value)
    }
  }
  return c.body(renderToReadableStream(body))
}
```

## Good Patterns

- **階層化された抽象**: 低レベル `StreamingApi` → ヘルパー関数 → JSX ストリーミングの 3 層構造。各層が明確な責務を持ち、上位層は下位層を組み合わせて機能を構築する。`streamText` が `stream` を呼び、`stream` が `StreamingApi` を使う、という委譲チェーンが簡潔。

```typescript
// src/helper/streaming/text.ts:6-15
export const streamText = (
  c: Context,
  cb: (stream: StreamingApi) => Promise<void>,
  onError?: (e: Error, stream: StreamingApi) => Promise<void>
): Response => {
  c.header('Content-Type', TEXT_PLAIN)
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Transfer-Encoding', 'chunked')
  return stream(c, cb, onError)
}
```

- **自己書き換えによる遅延メモ化**: `isOldBunVersion` は初回呼び出し時にバージョンチェックを行い、関数自体を結果を返すだけの関数に置き換える。条件分岐のコストを初回のみに限定する巧妙なパターン。

```typescript
// src/helper/streaming/utils.ts:1-11
export let isOldBunVersion = (): boolean => {
  const version: string = typeof Bun !== 'undefined' ? Bun.version : undefined
  if (version === undefined) {
    return false
  }
  const result = version.startsWith('1.1') || version.startsWith('1.0') || version.startsWith('0.')
  isOldBunVersion = () => result
  return result
}
```

- **WeakMap によるライフサイクル管理**: `ReadableStream` をキーにした WeakMap で Context を保持し、ストリーミング完了後に自然に GC される。明示的な cleanup コードが不要で、メモリリークのリスクがない。

```typescript
// src/helper/streaming/stream.ts:5
const contextStash: WeakMap<ReadableStream, Context> = new WeakMap<ReadableStream, Context>()
```

- **最小インラインスクリプトによる DOM 置換**: Suspense の Out-of-Order Streaming で使われるインラインスクリプトは約 150 バイトに収まり、外部ライブラリへの依存がない。`document.getElementById` と DOM 走査のみで置換を完結させる。

## Anti-Patterns / 注意点

- **write エラーの暗黙的な無視**: `StreamingApi.write()` は例外を catch して何もしない。書き込み失敗を検知したい場合、利用者は自前で `ReadableStream` を構築する必要がある。

```typescript
// Bad: エラーが silent に握りつぶされる
// src/utils/stream.ts:46-56
async write(input: Uint8Array | string): Promise<StreamingApi> {
  try {
    if (typeof input === 'string') {
      input = this.encoder.encode(input)
    }
    await this.writer.write(input)
  } catch {
    // Do nothing. If you want to handle errors, create a stream by yourself.
  }
  return this
}
```

```typescript
// Better: エラーハンドリングが必要な場合は自前のストリームを使う
const { readable, writable } = new TransformStream()
const writer = writable.getWriter()
try {
  await writer.write(encoder.encode(data))
} catch (e) {
  // 明示的にエラーを処理する
  logger.error('Stream write failed', e)
}
```

- **SSE の Content-Type 圧縮除外を見落とす可能性**: `text/event-stream` を圧縮から除外する処理は `compress.ts` の正規表現に埋め込まれている。カスタム圧縮ミドルウェアを作る際にこの除外を忘れると、SSE がバッファリングされてリアルタイム性が失われる。

```typescript
// Bad: カスタム圧縮で text/event-stream を除外し忘れる
app.use('*', async (c, next) => {
  await next()
  // 全レスポンスを圧縮 → SSE が壊れる
  c.res = new Response(c.res.body?.pipeThrough(new CompressionStream('gzip')))
})
```

```typescript
// Better: SSE のContent-Type を確認して除外する
app.use('*', async (c, next) => {
  await next()
  const contentType = c.res.headers.get('Content-Type')
  if (contentType?.includes('text/event-stream')) return
  // 圧縮処理
})
```

- **Suspense の suspenseCounter がグローバル**: `suspenseCounter` はモジュールレベルのグローバル変数であり、リクエスト間で共有される。サーバーレス環境では問題にならないが、長寿命プロセスではカウンタが増加し続ける。ただし ID の一意性が目的であるため、実用上は問題にならない。

## 自分のプロジェクトへの適用

- [ ] `stream` / `streamText` / `streamSSE` の 3 種のヘルパーを参考に、用途別のストリーミングヘルパーを設計する（汎用 → テキスト → SSE の階層化パターン）
- [ ] `TransformStream` + `ReadableStream` ラッパーによる読み書き分離パターンを、自前のストリーミング実装に適用する
- [ ] SSE 実装時は改行コード正規化（`\r\n` / `\r` / `\n`）を忘れずに処理する
- [ ] Out-of-Order Streaming が必要な場合、Hono の `Suspense` のプレースホルダー + インラインスクリプト置換パターンを参考にする
- [ ] ストリーミングレスポンスの Context 保持に WeakMap を使い、明示的 cleanup を不要にするパターンを取り入れる
- [ ] クライアント切断検知には `ReadableStream.cancel` と `AbortSignal` の両方を対応させ、ランタイム差異を吸収する
