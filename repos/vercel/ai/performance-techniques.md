# performance-techniques

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

Vercel AI SDK のパフォーマンス最適化プラクティスを分析する。ストリーム最適化（バックプレッシャー制御、ストリーム合成）、メモリ効率（大規模ペイロードの選択的保持、ダウンロードサイズ制限）、バンドルサイズ管理（CI ゲート、tree-shaking 対応）、Edge Runtime 互換性（デュアルエントリポイント、Web API 準拠）の4領域に注目に値するプラクティスが集中している。LLM レスポンスという「大量テキストを逐次受信する」性質上、従来の REST API とは異なるストリーミングファーストの設計が全体を貫いている。

## 背景にある原則

- **ストリームをプリミティブとして扱う**: LLM の逐次生成レスポンスを扱うため、`Promise<string>` ではなく `ReadableStream` を一級市民として設計すべき。これにより TTFB（Time to First Byte）を最小化し、メモリ消費をストリーム単位に抑えられる。根拠: `streamText` の戻り値は `StreamTextResult` クラスであり、`textStream`/`fullStream` は getter で遅延 tee される設計（`stream-text.ts:2045-2048`）。
- **遅延評価で不要なリソース消費を避ける**: Promise の生成や stream の分岐は「アクセスされた時点」で初めて実行すべき。これにより未使用のリソースへのメモリ割り当てやエラーハンドリングの複雑化を防げる。根拠: `DelayedPromise` はアクセスされるまで内部 Promise を生成しない（`delayed-promise.ts:15-31`）。
- **Web 標準 API で互換性の最大化を図る**: Node.js 固有 API（`Buffer` 等）を避け、`ReadableStream` / `TransformStream` / `TextEncoderStream` 等の Web 標準を使うことで、Node.js・Edge Runtime・ブラウザの全環境で動作可能にすべき。根拠: コアパッケージは `node:http` の `ServerResponse` を使う部分を分離し、Web 標準の `Response` 版と Node.js 版を並行提供している（`create-text-stream-response.ts` vs `pipe-text-stream-to-response.ts`）。
- **バンドルサイズを定量管理する**: ライブラリのサイズは CI で自動検証し、閾値を超えたらビルドを失敗させるべき。体感や手動チェックでは膨張を防げない。根拠: `check-bundle-size.ts` が esbuild で minify + tree-shake 後のサイズを 560KB 上限でチェックしている。

## 実例と分析

### ストリーム合成パターン（StitchableStream）

マルチステップの LLM 呼び出し（ツール呼び出し後の再呼び出し等）では、複数の `ReadableStream` を逐次的に1本のストリームに合成する必要がある。`createStitchableStream` はこの課題を解決する。

```typescript
// packages/ai/src/util/create-stitchable-stream.ts:9-14
export function createStitchableStream<T>(): {
  stream: ReadableStream<T>;
  addStream: (innerStream: ReadableStream<T>) => void;
  close: () => void;
  terminate: () => void;
};
```

内部では `createResolvablePromise` を使い、新しいストリームが追加されるまで `pull` を一時停止する。これにより、消費側は単一の `ReadableStream` として扱えるが、生産側は任意のタイミングで新しいストリームを追加できる。graceful close（`close()`）と即時停止（`terminate()`）の2種類のクローズ方法を提供し、正常終了とエラー時の使い分けを可能にしている。

### バックプレッシャー制御

Node.js の `ServerResponse` へストリームを書き込む際、`write()` が `false` を返した場合に `drain` イベントを待つことで、メモリの過剰消費を防止している。

```typescript
// packages/ai/src/util/write-to-server-response.ts:33-39
const canContinue = response.write(value);
if (!canContinue) {
  await new Promise<void>(resolve => {
    response.once("drain", resolve);
  });
}
```

Web 標準の `ReadableStream` は `pull` ベースのバックプレッシャーを内蔵しているが、Node.js の `ServerResponse` にブリッジする際にはこの明示的な制御が必要になる。

### DelayedPromise による遅延 Promise 生成

`DelayedPromise` は「resolve/reject は先に呼べるが、Promise インスタンスはアクセスされるまで生成しない」パターンを実装している。

```typescript
// packages/provider-utils/src/delayed-promise.ts:6-31
export class DelayedPromise<T> {
  private status:
    | { type: "pending"; }
    | { type: "resolved"; value: T; }
    | { type: "rejected"; error: unknown; } = { type: "pending" };
  private _promise: Promise<T> | undefined;

  get promise(): Promise<T> {
    if (this._promise) {
      return this._promise;
    }
    this._promise = new Promise<T>((resolve, reject) => {
      if (this.status.type === "resolved") {
        resolve(this.status.value);
      } else if (this.status.type === "rejected") {
        reject(this.status.error);
      }
      this._resolve = resolve;
      this._reject = reject;
    });
    return this._promise;
  }
}
```

これは `streamText` の結果オブジェクトで使われており、`usage`・`finishReason`・`steps` 等のプロパティは実際にアクセスされるまで Promise を作らない。未アクセスの Promise が reject されても unhandled rejection が発生しないという重要な副次効果がある。

### メモリ効率: 大規模ペイロードの選択的保持

`experimental_include` オプションにより、リクエスト/レスポンスのボディを step result に含めるかを制御できる。画像やファイルを含むプロンプトでは request body が数 MB に達するため、不要な場合は除外することでメモリを大幅に削減する。

```typescript
// packages/ai/src/generate-text/stream-text.ts:440-447
experimental_include?: {
  /**
   * Whether to retain the request body in step results.
   * The request body can be large when sending images or files.
   * @default true
   */
  requestBody?: boolean;
};
```

`retention-benchmark.test.ts` で 1MB のボディを使った具体的なテストが書かれており、この機能が明示的にメモリ最適化として設計されていることがわかる。

### ダウンロードサイズ制限による OOM 防止

`readResponseWithSizeLimit` は `Content-Length` ヘッダーでの早期拒否と、ストリーミング読み取り中のサイズチェックの2段階で、過大なレスポンスによる OOM クラッシュを防止する。

```typescript
// packages/provider-utils/src/read-response-with-size-limit.ts:6-13
/**
 * `fetch().arrayBuffer()` has ~2x peak memory overhead (undici buffers the
 * body internally, then creates the JS ArrayBuffer), so very large downloads
 * risk exceeding the default V8 heap limit on 64-bit systems and terminating
 * the process with an out-of-memory error.
 *
 * Setting this limit converts an unrecoverable OOM crash into a catchable
 * `DownloadError`.
 */
export const DEFAULT_MAX_DOWNLOAD_SIZE = 2 * 1024 * 1024 * 1024;
```

デフォルト上限 2GiB は `fetch().arrayBuffer()` の 2 倍メモリオーバーヘッドを考慮した値である。

### バンドルサイズ CI ゲート

`check-bundle-size.ts` は esbuild を使って Node.js 向け・ブラウザ向けの2種類のバンドルを生成し、560KB の上限に対してサイズチェックを行う。

```typescript
// packages/ai/scripts/check-bundle-size.ts:6
const LIMIT = 560 * 1024;
```

`platform: 'node'` と `platform: 'browser'` の両方をチェックすることで、環境ごとに異なるバンドルサイズの問題を検出する。metafile を出力して esbuild の分析ツールでの詳細調査も可能にしている。

### Edge/Node デュアルエントリポイント

`@ai-sdk/google-vertex` のように Node.js 固有の依存を持つプロバイダは、`/edge` サブパスで Edge Runtime 互換版を別途エクスポートしている。

```json
// packages/google-vertex/package.json:48-52
"./edge": {
  "types": "./dist/edge/index.d.ts",
  "import": "./dist/edge/index.mjs",
  "require": "./dist/edge/index.js"
}
```

tsup の設定で `src/edge/index.ts` を別エントリとしてビルドし、Node.js 固有の認証ロジック等を除外した軽量版を提供している。

### sideEffects: false の全パッケージ適用

全パッケージの `package.json` に `"sideEffects": false` が設定されている。これにより、webpack 等のバンドラが未使用のエクスポートを安全に tree-shake できる。

### CloudFlare 互換の base64 変換

`uint8-utils.ts` では `globalThis.btoa` / `globalThis.atob` をグローバルから分割代入で取得している。これは CloudFlare Workers で `btoa` をメソッド呼び出しすると `TypeError: Illegal invocation` が発生する問題への対処。

```typescript
// packages/provider-utils/src/uint8-utils.ts:3-4
// btoa and atob need to be invoked as a function call, not as a method call.
// Otherwise CloudFlare will throw a
const { btoa, atob } = globalThis;
```

### SSE (Server-Sent Events) 変換ストリーム

`JsonToSseTransformStream` は JSON オブジェクトを `data: ...\n\n` 形式に変換する最小限の `TransformStream` 実装。終了時には `data: [DONE]\n\n` を送信する。この実装は OpenAI 互換の SSE プロトコルに準拠しており、`flush` コールバックで終了シグナルを送る設計が特徴的。

```typescript
// packages/ai/src/ui-message-stream/json-to-sse-transform-stream.ts:6-17
export class JsonToSseTransformStream extends TransformStream<unknown, string> {
  constructor() {
    super({
      transform(part, controller) {
        controller.enqueue(`data: ${JSON.stringify(part)}\n\n`);
      },
      flush(controller) {
        controller.enqueue("data: [DONE]\n\n");
      },
    });
  }
}
```

### smoothStream によるストリーミング UX 最適化

`smoothStream` は LLM からのチャンクを word/line 単位に再分割し、delay を挟んで出力することで、ユーザーに自然な「タイピング」体験を提供する。

```typescript
// packages/ai/src/generate-text/smooth-stream.ts:29-44
export function smoothStream<TOOLS extends ToolSet>({
  delayInMs = 10,
  chunking = "word",
}: {
  delayInMs?: number | null;
  chunking?: "word" | "line" | RegExp | ChunkDetector | Intl.Segmenter;
});
```

`Intl.Segmenter` への対応により CJK 言語の単語区切りも正しく処理できる。`_internal` パラメータで delay 関数を差し替え可能にし、テストでの高速実行を可能にしている。

## パターンカタログ

- **Iterator パターン** (分類: 振る舞い)
  - 解決する問題: `ReadableStream` は `for await...of` で直接消費できない
  - 適用条件: ストリームを async iterable として扱いたい場合
  - コード例: `packages/ai/src/util/async-iterable-stream.ts:15-94`
  - 注意点: `return()` と `throw()` でストリームの cancel と reader の release を確実に行う必要がある。早期 break 時のリソースリークを防ぐため、cleanup 関数で cancel と releaseLock を分離している

- **Composite パターン** (分類: 構造)
  - 解決する問題: マルチステップ呼び出しで複数のストリームを1つに見せたい
  - 適用条件: 非同期に追加される複数のストリームを単一のストリームとして消費側に提供する場合
  - コード例: `packages/ai/src/util/create-stitchable-stream.ts:9-112`
  - 注意点: resolvable promise による pull 一時停止がバックプレッシャーの起点になるため、inner stream が遅い場合でも consumer 側がブロックされる

## Good Patterns

- **Web 標準 API ファースト**: `TransformStream` / `ReadableStream` / `TextEncoderStream` を使い、Node.js 固有 API を分離モジュールに閉じ込める。`create-text-stream-response.ts` は Web 標準のみ、`pipe-text-stream-to-response.ts` は `node:http` をインポートする。これにより Edge Runtime とブラウザでの動作が保証される。

- **tee() による遅延ストリーム分岐**: `textStream`/`fullStream`/`partialOutputStream` 等の複数のストリームビューを getter で提供し、アクセス時に `tee()` でストリームを分岐する。未アクセスのストリームは分岐コストがゼロ。
  ```typescript
  // packages/ai/src/generate-text/stream-text.ts:2045-2048
  private teeStream() {
    const [stream1, stream2] = this.baseStream.tee();
    this.baseStream = stream2;
    return stream1;
  }
  ```

- **safeEnqueue による閉じ済みストリームへの安全な書き込み**: `createUIMessageStream` では `controller.enqueue()` を try-catch でラップし、ストリームが閉じられた後の書き込みエラーを抑制する。非同期に複数のストリームをマージする際、タイミングの問題で閉じ済みストリームに書き込むケースに対処している。
  ```typescript
  // packages/ai/src/ui-message-stream/create-ui-message-stream.ts:66-72
  function safeEnqueue(data: InferUIMessageChunk<UI_MESSAGE>) {
    try {
      controller.enqueue(data);
    } catch (error) {
      // suppress errors when the stream has been closed
    }
  }
  ```

- **Retry-After ヘッダーの尊重**: 指数バックオフリトライで `retry-after-ms` / `retry-after` ヘッダーを読み取り、サーバー指定の待機時間を優先する。ただし 60 秒を超える不合理な値は無視してフォールバックする。

## Anti-Patterns / 注意点

- **ストリーム消費の暗黙的トリガー**: `steps`・`totalUsage`・`finishReason` 等のプロパティにアクセスすると、内部で `consumeStream()` が暗黙的に呼ばれる。これは便利だが、ストリームの消費タイミングが予測しにくくなり、デバッグが困難になる可能性がある。
  ```typescript
  // Bad: ストリーム消費が暗黙的
  const result = streamText({ ... });
  const usage = await result.usage; // ここで全ストリームが消費される

  // Better: 明示的に消費してから値を参照
  const result = streamText({ ... });
  for await (const chunk of result.textStream) { /* 処理 */ }
  const usage = await result.usage;
  ```

- **fetch().arrayBuffer() の直接使用**: `arrayBuffer()` は内部バッファリングにより元データの約2倍のメモリを消費する。大きなレスポンスにはストリーミング読み取り + サイズ制限が必要。
  ```typescript
  // Bad: OOM リスク
  const buffer = await response.arrayBuffer();

  // Better: サイズ制限付きストリーミング読み取り
  const data = await readResponseWithSizeLimit({ response, url, maxBytes });
  ```

## 導出ルール

- `[MUST]` ストリーミングレスポンスを Node.js の `ServerResponse` に書き込む際は、`write()` の戻り値を確認し、`false` なら `drain` イベントを待ってからバックプレッシャーを制御する
  - 根拠: `write-to-server-response.ts:33-39` で明示的にバックプレッシャー制御を実装しており、これがないとメモリが無制限に消費される
- `[MUST]` ライブラリの全パッケージの `package.json` に `"sideEffects": false` を設定して tree-shaking を有効化する
  - 根拠: vercel/ai は全パッケージに一貫して `"sideEffects": false` を設定しており、バンドラが未使用コードを除去できるようにしている
- `[SHOULD]` 大規模レスポンスのダウンロードにはサイズ上限を設けて、`fetch().arrayBuffer()` の 2 倍メモリオーバーヘッドによる OOM を防止する
  - 根拠: `readResponseWithSizeLimit` が Content-Length による早期拒否とストリーミング中のサイズチェックの2段階で OOM を catchable error に変換している
- `[SHOULD]` 非同期処理の結果を Promise で公開する場合、アクセスされるまで Promise を生成しない「遅延 Promise」パターンを使い、未使用 Promise の unhandled rejection を防ぐ
  - 根拠: `DelayedPromise` が `streamText` の `usage`・`finishReason`・`steps` 等で使われ、アクセスされない場合の Promise 生成コストとエラー伝播を回避している
- `[SHOULD]` バンドルサイズを CI パイプラインで定量チェックし、閾値超過でビルドを失敗させる
  - 根拠: `check-bundle-size.ts` が esbuild で minify + tree-shake 後のサイズを Node/Browser 両方で検証し、560KB 上限を強制している
- `[SHOULD]` Edge Runtime / ブラウザ / Node.js の全環境で動作させるために、コアロジックでは Web 標準 API（`ReadableStream`・`TransformStream`・`TextEncoderStream`）を使い、Node.js 固有 API（`ServerResponse`・`Buffer`）は分離モジュールに閉じ込める
  - 根拠: `create-text-stream-response.ts`（Web 標準）と `pipe-text-stream-to-response.ts`（Node.js 固有）が並行して存在し、同じ機能を異なるランタイムに提供している
- `[AVOID]` 複数の非同期ストリームをマージする際に、ストリームの閉鎖タイミングを制御せずに `controller.enqueue()` を呼ぶこと
  - 根拠: `createUIMessageStream` の `safeEnqueue` が try-catch でラップしており、閉じ済みストリームへの書き込みエラーを明示的に抑制している

## 適用チェックリスト

- [ ] ライブラリの `package.json` に `"sideEffects": false` が設定されているか
- [ ] バンドルサイズの CI チェックが設定されているか（esbuild/rollup + サイズ閾値）
- [ ] ストリーミング API が Web 標準（`ReadableStream`/`TransformStream`）を使っているか
- [ ] Node.js 固有 API を使う部分が分離されたモジュールに閉じ込められているか
- [ ] 大規模ファイルのダウンロード/アップロードにサイズ上限が設定されているか
- [ ] `ServerResponse` へのストリーム書き込みでバックプレッシャー制御（`drain` イベント待機）が実装されているか
- [ ] 未使用の可能性がある Promise に対して遅延生成パターンが適用されているか
- [ ] マルチステップのストリーム処理で、ストリーム合成パターン（stitchable stream）の必要性を検討したか
- [ ] Edge Runtime で動作確認するテスト（`vitest.edge.config.js`）が設定されているか
