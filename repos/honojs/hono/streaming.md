# Streaming

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono のストリーミング実装を SSE / ReadableStream 抽象化 / TransformStream 活用 / JSX Streaming SSR の観点から分析する。
Hono は Web Standard API（ReadableStream, TransformStream, WritableStream）のみを基盤とし、Node.js 固有の Stream API に一切依存しない設計を貫いている。この選択により、Cloudflare Workers・Deno・Bun・AWS Lambda など異なるランタイムで同一のストリーミングコードが動作する。
さらに、低レベルの Stream API を `StreamingApi` クラスで抽象化し、ユーザーに `write()`/`close()` という直感的なインターフェースを提供している点が特徴的である。

## 設計思想

- **Web Standards First**: `ReadableStream` / `TransformStream` / `WritableStream` のみを使用し、ランタイム固有の Stream API（Node.js streams, Bun.Serve 固有 API 等）を内部実装に持ち込まない。これにより「Write once, run anywhere」を実現している（`src/utils/stream.ts` 全体、`src/helper/streaming/stream.ts` 全体）。

- **Writer-Oriented Abstraction（書き込み側中心の抽象化）**: ユーザーは `ReadableStream` の pull/start コールバックではなく、`StreamingApi` の `write()` / `writeln()` / `close()` という命令的 API を通じてストリームに書き込む。Web Standard の ReadableStream は「データを引っ張る（pull）」モデルだが、サーバーサイドのストリーミング応答では「データを押し出す（push）」モデルの方が自然であるため、TransformStream を仲介として push 型 API を構築している（`src/utils/stream.ts:21-44`）。

- **Graceful Degradation for Runtime Differences**: ランタイム間の挙動差異（例: Bun 旧バージョンの `cancel()` 未呼び出し問題）をヘルパー内部で吸収し、ユーザーコードに影響を与えない。ランタイム差異の検出結果はメモ化して毎回のチェックコストを回避する（`src/helper/streaming/utils.ts:1-11`）。

- **Fail-Silent Write, Explicit Error Callback**: `write()` / `close()` は内部で例外を握りつぶし、エラーハンドリングが必要な場合は `stream()` / `streamSSE()` の第3引数 `onError` コールバックで一元管理する。これにより、クライアント切断時にアプリケーションコードが予期せず中断するのを防いでいる（`src/utils/stream.ts:46-56`, `src/helper/streaming/stream.ts:28-41`）。

## 設計・実装の詳細

### TransformStream を仲介した Push 型ストリーミング

Hono のストリーミングの核心は `TransformStream` の活用にある。`stream()` / `streamSSE()` は内部で `new TransformStream()` を生成し、その `writable` 側を `StreamingApi` に渡して書き込みインターフェースとし、`readable` 側を `Response` のボディとして返す。

```
ユーザーコード → StreamingApi.write() → WritableStream → [TransformStream] → ReadableStream → Response.body → クライアント
```

この設計の重要なポイントは、`StreamingApi` のコンストラクタで `_readable` から reader を取得し、それを新しい `ReadableStream`（`responseReadable`）で包んでいることである。これにより、クライアントが `responseReadable` を `cancel()` したときに `StreamingApi.abort()` が呼ばれる仕組みを実現している。

### SSE (Server-Sent Events) の実装

`SSEStreamingApi` は `StreamingApi` を継承し、`writeSSE()` メソッドを追加する。SSE プロトコルのフォーマット（`event:`, `data:`, `id:`, `retry:` フィールド + `\n\n` 区切り）を内部で組み立てる。

特筆すべきは、`data` フィールドが `string | Promise<string>` を受け付け、さらに JSX 要素も渡せる点である。これは `resolveCallback()` を通じて HTML エスケープ済み文字列に変換する仕組みによる。また、複数行の `data` は SSE 仕様に従い `data:` プレフィックスを行ごとに付与し、`\r\n` / `\r` / `\n` のすべての改行コードを正しく処理する。

### JSX Streaming SSR (Suspense + renderToReadableStream)

`renderToReadableStream()` は JSX ツリーを `ReadableStream<Uint8Array>` に変換する。`Suspense` コンポーネントと組み合わせることで、React の Streaming SSR と類似した段階的レンダリングを実現する。

動作フロー:
1. 同期的にレンダリングできる部分（fallback を含む）を最初のチャンクとして送信
2. 非同期コンテンツが解決されたら、`<template>` + `<script>` タグで置換用 HTML を後続チャンクとして送信
3. クライアント側のインライン JavaScript が `<template>` の内容でプレースホルダーを差し替える

この仕組みはコールバックチェーン（`HtmlEscapedCallbackPhase.BeforeStream` → `HtmlEscapedCallbackPhase.Stream`）によって制御され、ネストした `Suspense` も再帰的に処理される。

### Context 参照の WeakMap 保持

`stream()` と `streamSSE()` の両方で `contextStash: WeakMap<ReadableStream, Context>` が使用される。これは Bun 環境において、`Response` を返した時点で `Context` オブジェクトが GC される問題への対策である。`WeakMap` を使うことでメモリリークを防ぎつつ、ストリーミング完了まで `Context` を保持する。

### ランタイム差異の吸収（Bun 旧バージョン対策）

Bun v1.1.27 未満では `ReadableStream` の `cancel()` が `Bun.serve()` の Response に対して呼ばれないバグがあった。Hono はこれを検出し、代替として `req.raw.signal` の `abort` イベントリスナーでストリームの中断を処理する。バージョン判定結果は `isOldBunVersion` 関数内でクロージャにキャッシュされ、2回目以降の呼び出しコストをゼロにしている。

## コード例

### StreamingApi: TransformStream を仲介した Push 型抽象化

```typescript
// src/utils/stream.ts:6-44
export class StreamingApi {
  private writer: WritableStreamDefaultWriter<Uint8Array>
  private encoder: TextEncoder
  private writable: WritableStream
  private abortSubscribers: (() => void | Promise<void>)[] = []
  responseReadable: ReadableStream

  constructor(writable: WritableStream, _readable: ReadableStream) {
    this.writable = writable
    this.writer = writable.getWriter()
    this.encoder = new TextEncoder()

    const reader = _readable.getReader()

    // クライアント切断時に reader をキャンセルし、
    // writeSSE が無限にブロックされるのを防ぐ
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

### SSE メッセージフォーマットの組み立て

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

### stream() ヘルパーのライフサイクル管理

```typescript
// src/helper/streaming/stream.ts:7-45
export const stream = (
  c: Context,
  cb: (stream: StreamingApi) => Promise<void>,
  onError?: (e: Error, stream: StreamingApi) => Promise<void>
): Response => {
  const { readable, writable } = new TransformStream()
  const stream = new StreamingApi(writable, readable)

  // Bun 旧バージョンの cancel() 未呼び出し問題への対策
  if (isOldBunVersion()) {
    c.req.raw.signal.addEventListener('abort', () => {
      if (!stream.closed) {
        stream.abort()
      }
    })
  }

  // Bun で Context が GC されるのを防ぐ
  contextStash.set(stream.responseReadable, c)
  ;(async () => {
    try {
      await cb(stream)
    } catch (e) {
      if (e === undefined) {
        // StreamingApi による読み取りキャンセル時は何もしない
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

### ランタイム判定のメモ化パターン

```typescript
// src/helper/streaming/utils.ts:1-11
export let isOldBunVersion = (): boolean => {
  const version: string = typeof Bun !== 'undefined' ? Bun.version : undefined
  if (version === undefined) {
    return false
  }
  const result = version.startsWith('1.1') || version.startsWith('1.0') || version.startsWith('0.')
  // 2回目以降のチェックを回避するため関数自体を結果で上書き
  isOldBunVersion = () => result
  return result
}
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: Web Standard の ReadableStream (pull 型) をサーバーサイドで直感的に使えるようにする
  - 適用条件: push 型の書き込みインターフェースが必要なストリーミング応答
  - コード例: `src/utils/stream.ts:6-96` — `StreamingApi` が `TransformStream` を仲介し、`write()` / `close()` という命令的 API を提供
  - 注意点: 内部で `TransformStream` を1つ追加するため、バッファリングが1段増える

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: ストリーミング応答のライフサイクル（open → write → error handling → close）を統一する
  - 適用条件: 異なる種類のストリーミング（raw / text / SSE）で共通のライフサイクル管理が必要
  - コード例: `src/helper/streaming/stream.ts:7-45` の `stream()` が骨格を定義し、`text.ts:6-15` の `streamText()` と `sse.ts:66-94` の `streamSSE()` がヘッダー設定等を特殊化
  - 注意点: SSE は `run()` を別関数に切り出しており、厳密な Template Method ではなく変形適用

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: クライアント切断をストリーミングロジック内で検知する
  - 適用条件: ストリーム中断時にリソース解放やログ出力が必要
  - コード例: `src/utils/stream.ts:82-95` — `onAbort()` でリスナーを登録し、`abort()` で全リスナーを一斉通知
  - 注意点: `abort()` は冪等（2回目以降は何もしない）に実装されている

## Good Patterns

- **Fail-Silent Write**: `StreamingApi.write()` と `close()` は内部例外を `catch` で握りつぶし、クライアント切断時にアプリケーションコードが中断しないようにしている。エラーが必要な場合は `onError` コールバックという明示的な経路が用意されている。

```typescript
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

- **Self-Replacing Function（自己書き換え関数）によるメモ化**: `isOldBunVersion()` は初回呼び出し時に判定結果を計算した後、関数自体を結果を返すだけの関数に置き換える。条件分岐のコストをゼロにしつつ、グローバル変数を避けたエレガントな手法。

```typescript
// src/helper/streaming/utils.ts:1-11
export let isOldBunVersion = (): boolean => {
  // ... 判定ロジック ...
  isOldBunVersion = () => result  // 関数自体を結果で上書き
  return result
}
```

- **WeakMap による GC セーフな参照保持**: `contextStash` は `WeakMap<ReadableStream, Context>` で実装されており、ストリーミング完了後に `ReadableStream` が GC されれば `Context` も自動で解放される。明示的な cleanup コードが不要。

```typescript
// src/helper/streaming/stream.ts:5
const contextStash: WeakMap<ReadableStream, Context> = new WeakMap<ReadableStream, Context>()
// ...
contextStash.set(stream.responseReadable, c)
```

- **SSE の data フィールド改行処理**: SSE 仕様ではデータ内の改行は `data:` プレフィックスを繰り返す必要がある。`/\r\n|\r|\n/` で3種類の改行コードすべてを正しく分割し、仕様準拠のメッセージを生成している。

```typescript
// src/helper/streaming/sse.ts:20-25
const dataLines = (data as string)
  .split(/\r\n|\r|\n/)
  .map((line) => {
    return `data: ${line}`
  })
  .join('\n')
```

## Anti-Patterns / 注意点

- **ストリーミング応答への ETag / 圧縮ミドルウェア適用**: ETag ミドルウェアはレスポンスボディ全体のハッシュを計算するため、ストリーミング応答のバッファリングを引き起こす。Hono の圧縮正規表現は `text/event-stream` を明示的に除外している（`src/utils/compress.ts:10`）が、ETag はユーザーが適用範囲を制御する必要がある。

```typescript
// Bad: SSE エンドポイントに ETag を適用
app.use('/*', etag())
app.get('/events', (c) => {
  return streamSSE(c, async (stream) => { /* ... */ })
})

// Better: SSE エンドポイントを ETag の適用範囲から除外
app.use('/api/*', etag())
app.get('/events', (c) => {
  return streamSSE(c, async (stream) => { /* ... */ })
})
```

- **onError コールバックなしでの例外無視**: `stream()` / `streamSSE()` に `onError` を渡さない場合、エラーは `console.error` に出力されるだけで、クライアントにはエラーが通知されない。特に SSE では `onError` で `event: error` を送信する設計になっているため、省略するとクライアント側のエラーハンドリングが機能しない。

```typescript
// Bad: onError を省略
streamSSE(c, async (stream) => {
  const data = await fetchExternalAPI() // 例外が発生しても握りつぶされる
  await stream.writeSSE({ data })
})

// Better: onError でクライアントにエラーを通知
streamSSE(c, async (stream) => {
  const data = await fetchExternalAPI()
  await stream.writeSSE({ data })
}, async (err, stream) => {
  await stream.writeSSE({ event: 'error', data: err.message })
})
```

## 導出ルール

- `[MUST]` ストリーミング応答は Web Standard API（ReadableStream / TransformStream）のみで実装し、ランタイム固有の Stream API に依存しない
  - 根拠: Hono は全ストリーミング実装を Web Standards で統一し、Cloudflare Workers・Deno・Bun・Node.js で同一コードを動作させている（`src/utils/stream.ts` 全体）

- `[MUST]` SSE レスポンスには `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Transfer-Encoding: chunked` の4ヘッダーを設定する
  - 根拠: `streamSSE()` が毎回これら4ヘッダーを明示的に設定しており、テストでも検証されている（`src/helper/streaming/sse.ts:86-89`）

- `[MUST]` SSE の data フィールド内の改行は `\r\n` / `\r` / `\n` のすべてを `data:` プレフィックス付き複数行に変換する
  - 根拠: SSE 仕様（EventSource）では改行はメッセージ区切りと解釈されるため、data 内の改行は `data:` を繰り返す必要がある（`src/helper/streaming/sse.ts:20-25`）

- `[SHOULD]` Push 型ストリーミングが必要な場合、TransformStream を仲介して WritableStream 側に書き込む設計にする
  - 根拠: ReadableStream の `pull()` コールバック内で非同期データを待つよりも、TransformStream の writable 側に `write()` する方がサーバーサイドのユースケースに自然に合致する（`src/utils/stream.ts:21-44`）

- `[SHOULD]` ストリーミング API の `write()` / `close()` は例外を内部で吸収し、エラーハンドリングは専用のコールバック経路で提供する
  - 根拠: クライアント切断は正常系の一部であり、`write()` が例外を投げるとアプリケーションコードに不要な try-catch が必要になる（`src/utils/stream.ts:46-56`）

- `[SHOULD]` ランタイム差異の検出結果はメモ化（Self-Replacing Function 等）してホットパスのコストをゼロにする
  - 根拠: `isOldBunVersion()` は初回呼び出し後に関数自体を結果で上書きし、以降のオーバーヘッドを排除している（`src/helper/streaming/utils.ts:9`）

- `[SHOULD]` GC されるべきオブジェクトへの一時的な参照保持には `WeakMap` を使い、ストリーム完了後の自動解放を保証する
  - 根拠: `contextStash` が `WeakMap<ReadableStream, Context>` で実装され、ストリーミング完了後のメモリリークを防止している（`src/helper/streaming/stream.ts:5`）

- `[AVOID]` ストリーミング応答に ETag・圧縮などボディ全体を必要とするミドルウェアを適用する
  - 根拠: Hono の圧縮正規表現は `text/event-stream` を明示的に除外しており、ストリーミングとバッファリング系ミドルウェアの非互換性が設計レベルで認識されている（`src/utils/compress.ts:10`）

## 適用チェックリスト

- [ ] ストリーミング応答の実装に Web Standard API（ReadableStream / TransformStream）を使用しているか
- [ ] SSE エンドポイントに必要な4ヘッダー（Content-Type, Cache-Control, Connection, Transfer-Encoding）を設定しているか
- [ ] SSE の data フィールド内の改行コード（CR, LF, CRLF）を正しく処理しているか
- [ ] ストリームの `write()` / `close()` がクライアント切断時に例外を投げないようになっているか
- [ ] クライアント切断を検知して未完了の処理（DB 接続、外部 API 呼び出し等）をキャンセルする仕組みがあるか（`onAbort` 相当）
- [ ] ストリーミングヘルパーの `onError` コールバックを実装し、エラーをクライアントに通知しているか
- [ ] ストリーミング応答が ETag・圧縮ミドルウェアの適用範囲から除外されているか
- [ ] ランタイム差異（Bun / Deno / Node.js の挙動の違い）を吸収する仕組みが内部に閉じ込められているか
- [ ] 一時的なオブジェクト参照の保持に `WeakMap` を使い、ストリーム完了後のメモリリークを防いでいるか
