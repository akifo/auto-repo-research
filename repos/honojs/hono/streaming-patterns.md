# streaming-patterns

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

SSE・ReadableStream・段階的 JSX レンダリングにおけるストリーミング実装パターンを横断的に分析した。このリポジトリでは Web Standards API（ReadableStream / WritableStream / TransformStream）を一貫した基盤とし、その上に 3 層のストリーミング抽象（バイナリストリーム、テキストストリーム、SSE）と JSX Suspense による段階的 HTML レンダリングを構築している。注目に値するのは、ランタイム差異の吸収・クライアント切断の安全な検知・エラーのサイレント処理という 3 つの横断的関心事を、小さな API 面積で統一的に解決している点である。

## 背景にある原則

- **Web Standards を唯一の通貨とする**: ReadableStream / WritableStream / TransformStream を内部のデータ受け渡しの唯一のインターフェースとして採用すべき。なぜなら、ランタイム（Node.js / Deno / Bun / Cloudflare Workers）ごとに独自のストリーム API を使い分けると、アダプター層が肥大化しテストの組み合わせが爆発するため。`StreamingApi` クラスが `TransformStream` を基盤とし、AWS Lambda アダプターでは `ReadableStreamDefaultReader` から Node.js の `WritableStream` へ変換する一点でのみブリッジしている設計に表れている（`src/adapter/aws-lambda/handler.ts:126-136`）。

- **ストリーム操作のエラーは黙殺し、制御権をユーザーに委ねる**: ストリームの write/close で発生する例外はフレームワーク側で握り潰すべき。なぜなら、クライアント切断やランタイムの内部エラーでストリームが閉じた後の書き込みエラーは回復不可能であり、呼び出し側にまで伝搬させるとアプリケーションの正常なシャットダウンを妨げるため。`StreamingApi.write()` と `StreamingApi.close()` の `catch` 節のコメント「Do nothing. If you want to handle errors, create a stream by yourself.」に明示されている（`src/utils/stream.ts:52-54`, `69-72`）。

- **切断検知を Observer パターンで分離する**: クライアント切断の検知と後処理は、ストリーム本体のライフサイクルから分離し、サブスクライバー方式で外部から登録できるべき。なぜなら、リソースのクリーンアップ（DB 接続の解放、タイマーの解除等）はアプリケーション固有の処理であり、フレームワーク側で一律に行えないため。`onAbort()` メソッドと `abortSubscribers` 配列による設計に表れている（`src/utils/stream.ts:82-95`）。

- **段階的レンダリングではプレースホルダーの置換をインラインスクリプトで自己完結させる**: サーバーからストリーム送信される HTML チャンクは、外部スクリプトに依存せず自力で DOM を更新すべき。なぜなら、ストリーミング HTML ではチャンクの到着順序が保証されず、外部バンドルのロード完了を待てないため。Suspense の置換スクリプトが `<template>` + インライン `<script>` の自己完結型になっている設計に表れている（`src/jsx/streaming.ts:103-113`）。

## 実例と分析

### TransformStream を境界面とするストリーム生成パターン

`stream()`, `streamSSE()`, `streamText()` の 3 つのヘルパーはすべて同一の構造を持つ。`new TransformStream()` でペアを生成し、writable 側を `StreamingApi` に渡してユーザーコールバックに公開し、readable 側を `Response` のボディとして返す。この「TransformStream を分水嶺とする」パターンにより、書き込み側と読み取り側の関心を分離している。

```typescript
// src/helper/streaming/stream.ts:12-14
const { readable, writable } = new TransformStream()
const stream = new StreamingApi(writable, readable)
// ...
return c.newResponse(stream.responseReadable)
```

SSE でもテキストストリームでも同じ構造が繰り返される。差分はヘッダー設定のみである。

```typescript
// src/helper/streaming/sse.ts:71-93
const { readable, writable } = new TransformStream()
const stream = new SSEStreamingApi(writable, readable)
// SSE 固有のヘッダー
c.header('Transfer-Encoding', 'chunked')
c.header('Content-Type', 'text/event-stream')
c.header('Cache-Control', 'no-cache')
c.header('Connection', 'keep-alive')
```

### WeakMap によるコンテキスト生存保証

Bun ランタイムではレスポンスを返した時点で `Context` オブジェクトが GC される問題がある。ストリーミングではレスポンス返却後もコールバック内で `Context` を使う必要があるため、`WeakMap<ReadableStream, Context>` でストリームの生存期間中だけコンテキストを保持している。

```typescript
// src/helper/streaming/stream.ts:5,25
const contextStash: WeakMap<ReadableStream, Context> = new WeakMap()
// ...
contextStash.set(stream.responseReadable, c)
```

この WeakMap パターンにより、ストリーム完了後は自然に GC される。強参照で保持するとメモリリークの原因になる。

### ランタイム差異の吸収 -- 自己書き換え関数パターン

Bun の古いバージョンでは `ReadableStream.cancel()` が呼ばれない問題があるため、`AbortSignal` にフォールバックしている。ランタイム判定関数 `isOldBunVersion()` は初回呼び出し後に自身を結果を返すだけの関数に置き換える。

```typescript
// src/helper/streaming/utils.ts:1-11
export let isOldBunVersion = (): boolean => {
  const version: string = typeof Bun !== 'undefined' ? Bun.version : undefined
  if (version === undefined) {
    return false
  }
  const result = version.startsWith('1.1') || version.startsWith('1.0') || version.startsWith('0.')
  // Avoid running this check on every call
  isOldBunVersion = () => result
  return result
}
```

この「関数自体を再代入するメモ化」は、ホットパスでの条件分岐コストを初回以降ゼロにする技法であり、ストリーム write のような高頻度呼び出しパスで効果的である。

### SSE メッセージの改行正規化

SSE プロトコルではデータ内の改行ごとに `data:` プレフィックスを付ける必要がある。`writeSSE()` は `\r\n`, `\r`, `\n` のすべてのパターンを単一の正規表現で分割し、プロトコル準拠のフォーマットに正規化している。

```typescript
// src/helper/streaming/sse.ts:20-25
const dataLines = (data as string)
  .split(/\r\n|\r|\n/)
  .map((line) => {
    return `data: ${line}`
  })
  .join('\n')
```

### JSX Suspense による段階的レンダリング

`renderToReadableStream` は ReadableStream の `start` コントローラー内で HTML をフェーズ分けして送信する。初回チャンクでフォールバック HTML を送り、非同期コンテンツの解決後に置換用 `<template>` + インラインスクリプトを追加チャンクとして送る。

```typescript
// src/jsx/streaming.ts:86-113
// フォールバック送信
return raw(`<template id="H:${index}"></template>${fallbackStr}<!--/$-->`, [
  // 非同期解決後の置換チャンク
  ({ phase, buffer, context }) => {
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

このインラインスクリプトは外部ライブラリに依存せず、到着した時点で即座に DOM を置換する。CSP 対応として `StreamingContext` から `nonce` を注入できる設計にもなっている（`src/jsx/streaming.ts:30-32,104`）。

### 圧縮ミドルウェアの SSE 除外

`text/event-stream` は圧縮すると段階的送信が不可能になる。compress ミドルウェアの Content-Type 判定正規表現が `text/event-stream` を意図的に除外しており、SSE との共存を保証している。

```typescript
// src/utils/compress.ts:10
export const COMPRESSIBLE_CONTENT_TYPE_REGEX =
  /^\s*(?:text\/(?!event-stream(?:[;\s]|$))[^;\s]+|...)/i
```

否定先読み `(?!event-stream)` を使った除外は、ホワイトリスト方式より保守的で、新しい text/* タイプが追加されても SSE が誤って圧縮される事故を防ぐ。

### 同時実行制御プール

`createPool` は SetベースのセマフォでPromise の同時実行数を制限する。Infinity 指定時はパススルーに退化する最適化も含まれる。

```typescript
// src/utils/concurrent.ts:22-24
if (concurrency === Infinity) {
  return { run: async (fn) => fn() }
}
```

## パターンカタログ

- **Facade パターン** (分類: 構造)
  - 解決する問題: ReadableStream / WritableStream / TransformStream の低レベル API を直接扱う複雑さの隠蔽
  - 適用条件: ストリーム操作に write / close / abort / pipe の統一インターフェースを提供したい場合
  - コード例: `src/utils/stream.ts:6-96` の `StreamingApi` クラス
  - 注意点: Facade 内部でエラーを握り潰しているため、デバッグ時には生の ReadableStream を使う必要がある

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: クライアント切断時のクリーンアップ処理をストリーム本体から分離
  - 適用条件: ストリーム終了時に複数の独立した後処理を実行したい場合
  - コード例: `src/utils/stream.ts:10,82-95` の `abortSubscribers` + `onAbort()`
  - 注意点: abort は 1 回限り（`if (!this.aborted)` で二重実行を防止）。購読解除機能はない

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: stream / streamText / streamSSE の共通フロー（ストリーム生成 -> コールバック実行 -> クローズ）と固有部分（ヘッダー設定、メッセージ形式）の分離
  - 適用条件: ストリーミングプロトコルの変種（SSE, NDJSON 等）を追加する場合
  - コード例: `stream.ts` を base、`text.ts` と `sse.ts` がヘッダー設定とメッセージ整形をオーバーライド

## Good Patterns

- **try/finally によるストリーム確実クローズ**: ストリームヘルパーの全パスで `finally { stream.close() }` を保証しており、コールバック内で例外が発生してもストリームがリークしない。

```typescript
// src/helper/streaming/stream.ts:27-42
;(async () => {
  try {
    await cb(stream)
  } catch (e) {
    if (e === undefined) {
      // pipeTo() が reason なしで reject した場合 -- 何もしない
    } else if (e instanceof Error && onError) {
      await onError(e, stream)
    } else {
      console.error(e)
    }
  } finally {
    stream.close()
  }
})()
```

- **SSE エラーイベントの自動送信**: SSE ヘルパーではエラー発生時に `event: error` として SSE メッセージを送信してからストリームを閉じる。クライアント側がエラーを検知できる。

```typescript
// src/helper/streaming/sse.ts:48-56
} catch (e) {
  if (e instanceof Error && onError) {
    await onError(e, stream)
    await stream.writeSSE({
      event: 'error',
      data: e.message,
    })
  }
}
```

- **pipe 時の preventClose**: `StreamingApi.pipe()` では `preventClose: true` を指定してソースストリーム終了時にターゲットを閉じない。これにより、複数のソースを順次パイプできる。

```typescript
// src/utils/stream.ts:76-79
async pipe(body: ReadableStream) {
  this.writer.releaseLock()
  await body.pipeTo(this.writable, { preventClose: true })
  this.writer = this.writable.getWriter()
}
```

## Anti-Patterns / 注意点

- **ストリーム内での同期的ブロッキング**: ストリームのコールバック内で `await` なしの CPU バウンド処理を行うと、他のチャンクの送信がブロックされる。

```typescript
// Bad: CPU バウンド処理がストリームを詰まらせる
stream(c, async (stream) => {
  const result = heavyComputation() // 同期的な重い処理
  await stream.write(result)
})

// Better: 分割して await を挟み、イベントループに制御を返す
stream(c, async (stream) => {
  for (const chunk of splitWork(data)) {
    const result = processChunk(chunk)
    await stream.write(result)
  }
})
```

- **SSE を圧縮ミドルウェアと併用する際の注意**: 圧縮ミドルウェアは `text/event-stream` を除外する設計だが、カスタム Content-Type を設定すると意図せず圧縮が適用される可能性がある。SSE では必ず標準の `text/event-stream` を使う。

```typescript
// Bad: カスタム Content-Type により圧縮が適用されうる
c.header('Content-Type', 'text/x-sse')
// Good: 標準の SSE Content-Type を使う（streamSSE が自動設定）
streamSSE(c, async (stream) => { /* ... */ })
```

- **ストリームの二重クローズへの無防備**: `StreamingApi` は `close()` の二重呼び出しを try/catch で吸収するが、`closed` フラグは最初の `close()` でのみ `true` になる。外部から `closed` を参照する場合、タイミングによって不整合が起きうる。abort と close の状態管理は明確に分けるべき。

## 導出ルール

- `[MUST]` ストリーミングレスポンスの生成には TransformStream でペアを作り、writable 側を書き込み用、readable 側をレスポンスボディ用に分離する
  - 根拠: `stream()`, `streamSSE()`, `streamText()` の全てが `new TransformStream()` でペアを生成し、この構造を一貫して採用している（`src/helper/streaming/stream.ts:12`, `sse.ts:71`）

- `[MUST]` ストリームのコールバック実行は try/finally で囲み、finally で必ず close() を呼ぶ
  - 根拠: 全ストリームヘルパーが `try { await cb(stream) } ... finally { stream.close() }` パターンを採用し、例外時のストリームリークを防止している（`src/helper/streaming/stream.ts:27-42`, `sse.ts:45-62`）

- `[SHOULD]` ストリームの write/close でのエラーはフレームワーク層で握り潰し、エラーハンドリングの責務をユーザーに委譲する
  - 根拠: `StreamingApi.write()` と `close()` が空の catch 節でエラーを吸収し、「If you want to handle errors, create a stream by yourself」とコメントしている（`src/utils/stream.ts:52-54`）

- `[SHOULD]` SSE レスポンスでは `Transfer-Encoding: chunked`, `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive` の 4 ヘッダーをセットで設定する
  - 根拠: `streamSSE()` がこの 4 ヘッダーを常にセットし、compress ミドルウェアが `text/event-stream` を圧縮対象から除外している（`src/helper/streaming/sse.ts:86-89`, `src/utils/compress.ts:10`）

- `[SHOULD]` ランタイム固有のポリフィルが必要な場合、検出関数は初回呼び出しで自身を結果のみを返す関数に置き換え、ホットパスでの分岐コストを排除する
  - 根拠: `isOldBunVersion()` が `let` で宣言され、初回判定後に `isOldBunVersion = () => result` で自己書き換えしている（`src/helper/streaming/utils.ts:1-11`）

- `[SHOULD]` ストリームと共に外部リソース（Context 等）を保持する場合は WeakMap を使い、ストリーム GC 時に自然に解放されるようにする
  - 根拠: Bun で Context が早期 GC される問題を `WeakMap<ReadableStream, Context>` で解決しており、ストリーム終了後のメモリリークを防止している（`src/helper/streaming/stream.ts:5,25`）

- `[AVOID]` SSE ストリームに標準以外の Content-Type を設定してはならない（圧縮ミドルウェアによりバッファリングが発生し段階的送信が壊れる）
  - 根拠: compress ミドルウェアの正規表現が `text/event-stream` のみを否定先読みで除外しており、他の Content-Type では圧縮が適用される（`src/utils/compress.ts:10`）

## 適用チェックリスト

- [ ] ストリーミングレスポンスに TransformStream ベースの生成パターンを採用しているか
- [ ] ストリームのコールバック実行が try/finally で囲まれ、finally で close() が呼ばれているか
- [ ] クライアント切断の検知と後処理が Observer パターン（onAbort 等）で分離されているか
- [ ] SSE レスポンスに 4 つの必須ヘッダー（Transfer-Encoding, Content-Type, Cache-Control, Connection）が設定されているか
- [ ] SSE の data フィールド内改行が `\r\n`, `\r`, `\n` すべてに対応して正規化されているか
- [ ] ストリームに関連する外部リソースの参照が WeakMap で管理されているか（メモリリーク防止）
- [ ] 段階的 HTML レンダリングで送信するインラインスクリプトに CSP nonce が注入可能か
- [ ] 圧縮ミドルウェアが SSE ストリームを除外する設定になっているか
- [ ] ランタイム固有の互換性対応がホットパスの性能に影響しないよう最適化されているか
