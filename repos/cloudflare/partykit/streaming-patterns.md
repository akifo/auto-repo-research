# streaming-patterns

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

partytracks パッケージにおける RxJS ベースの WebRTC ストリーム管理パターンと、BulkRequestDispatcher / FIFOScheduler によるバッチ処理パターンを分析する。Promise ベースの API では「接続断→再接続→トラック再プッシュ」のような連鎖的リカバリーが呼び出し側に漏洩するが、Observable チェーンとしてモデル化することでリカバリーロジックをライブラリ内に閉じ込めている。この設計はリアルタイム通信に限らず、不安定なリソースを扱うあらゆるストリーミングアプリケーションに応用できる。

## 背景にある原則

- **「漏洩する抽象」の排除**: Promise ベースの API は正常系では簡潔だが、WebRTC の接続断・デバイス切替・ネットワーク変更といった異常系では呼び出し側にリカバリーロジックが漏洩する。Observable チェーンとして状態遷移をモデル化すれば、上流の変化が自動的に下流に伝播し、アプリケーションコードは異常系を意識しなくて済む（README の "Why Observables?" セクションで明示的に言及）
- **サブスクリプション=ライフサイクル**: `subscriber.add()` でリソースのクリーンアップをサブスクリプションに結びつけることで、購読解除が即リソース解放になる。これにより「解放し忘れ」を構造的に防げる（`blackCanvasTrack$.ts:23`, `screenshare$.ts:10`, `PartyTracks.ts:786` 等で一貫して使用）
- **イベントループの境界を利用したバッチ化**: 同一ティック内の複数リクエストを `setTimeout(0)` でマクロタスク境界まで遅延させ、一括送信する。明示的なタイマーやフレームワーク依存なしに自然なバッチ化を実現できる（`Peer.utils.ts:63` のコメントで macrotask/microtask の関係を図示）

## 実例と分析

### Observable チェーンによる自動リカバリー

`PartyTracks` クラスの核心は `session$` Observable にある。`makePeerConnectionSessionCombo` 関数は PeerConnection を生成し、接続障害時に `subscriber.error()` を発行する。これが `retryWithBackoff()` を通じて新しいセッション＋PeerConnection を自動生成する。`push()` と `pull()` はいずれも `session$` を `combineLatest` で合成しているため、セッション再生成時にトラックが自動的に再プッシュ/再プルされる。

```typescript
// PartyTracks.ts:745-839
// session$ の構築: forkJoin で sessionId と iceServers を並列取得
// → switchMap で PeerConnection を生成
// → 接続障害で subscriber.error() → retryWithBackoff() で再接続
return forkJoin({
  sessionId: fromFetch(`${options.prefix}/sessions/new?${options.params}`, {
    method: "POST",
    fetcher: options.fetch,
    selector: (res) => res.json().then(({ sessionId }) => sessionId)
  }),
  iceServers: options.iceServers
    ? of(options.iceServers)
    : fromFetch(`${options.prefix}/generate-ice-servers`, { ... })
}).pipe(
  switchMap(({ sessionId, iceServers }) =>
    new Observable((subscriber) => {
      const peerConnection = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
      const reconnect = (message: string) => {
        subscriber.error(new Error(message)); // エラーで再接続トリガー
      };
      subscriber.add(() => peerConnection.close()); // 購読解除で自動クローズ
      // connectionState と iceConnectionState の監視...
      subscriber.next({ peerConnection, sessionId });
    })
  ),
  retryWithBackoff({ backoffFactor: 1.1 }),
  shareReplay({ refCount: true, bufferSize: 1 })
);
```

### switchMap による「最新値優先」の接続管理

`push()` メソッドでは `combineLatest([stableId$, this.session$])` と `switchMap` を組み合わせ、セッション変更時に旧トラックのプッシュを自動キャンセルし、新セッションへ再プッシュする。`switchMap` は「前の内部 Observable を自動的に unsubscribe する」ため、古い接続のクリーンアップが暗黙的に行われる。

```typescript
// PartyTracks.ts:345-355
const pushedTrackData$ = transceiver$.pipe(
  switchMap(
    ({ session: { peerConnection, sessionId }, transceiver, stableId }) =>
      this.#pushTrackInBulk(peerConnection, transceiver, sessionId, stableId),
  ),
);
```

### concat による順序保証付きフォールバック

`resilientTrack$` はデバイスリストを `concat` で順番に試行する。あるデバイスが不健全な場合 `subscriber.complete()` で完了し、`concat` が次のデバイスに移行する。全デバイスが失敗した場合は `throwError(() => new DevicesExhaustedError())` でエラーを発行する。

```typescript
// resilientTrack$.ts:109-125
switchMap((deviceList) =>
  concat(
    ...deviceList.map(
      (device) =>
        new Observable<MediaStreamTrack>((subscriber) => {
          acquireTrack(subscriber, device, constraints, onDeviceFailure, ...);
        })
    ),
    throwError(() => new DevicesExhaustedError())
  )
)
```

### BulkRequestDispatcher: イベントループ境界を利用したバッチ化

`BulkRequestDispatcher` は同一ティック内の複数リクエストを蓄積し、`setTimeout(0)` で次のマクロタスクで一括処理する。同じ Promise を共有するため、バッチ内の全呼び出し元が同一レスポンスを受け取る。バッチサイズ上限に達した場合は新しいバッチが自動的に開始される。

```typescript
// Peer.utils.ts:36-80
doBulkRequest(
  params: RequestEntryParams,
  bulkRequestFunc: (bulkCopy: RequestEntryParams[]) => Promise<BulkResponse>
): Promise<BulkResponse> {
  if (this.#currentBatch.length >= this.#batchSizeLimit) {
    this.#currentBatch = [];
    this.#currentBulkResponse = null;
  }
  this.#currentBatch.push(params);
  if (this.#currentBulkResponse != null) {
    return this.#currentBulkResponse; // 同じバッチなら同じ Promise を返す
  }
  const batch = this.#currentBatch;
  this.#currentBulkResponse = new Promise((resolve, reject) => {
    setTimeout(() => { // マクロタスク境界で発火
      this.#currentBulkResponse = null;
      const batchCopy = batch.splice(0, batch.length);
      bulkRequestFunc(batchCopy).then(resolve).catch(reject);
    }, 0);
  });
  return this.#currentBulkResponse;
}
```

### FIFOScheduler: Promise チェーンによる逐次実行

WebRTC の SDP ネゴシエーション（createOffer → setLocalDescription → API 呼び出し → setRemoteDescription）は排他的に実行する必要がある。`FIFOScheduler` は Promise チェーンを使い、ロックやセマフォなしで逐次実行を保証する。

```typescript
// Peer.utils.ts:5-22
export class FIFOScheduler {
  #schedulerChain: Promise<void>;
  constructor() {
    this.#schedulerChain = Promise.resolve();
  }
  schedule<T>(task: Task<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.#schedulerChain = this.#schedulerChain.then(async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error as unknown);
        }
      });
    });
  }
}
```

### share vs shareReplay の使い分け

大半の Observable は `shareReplay({ refCount: true, bufferSize: 1 })` を使うが、`resilientTrack$` と `screenshare$` では `share({ resetOnComplete: true, resetOnError: true, connector: () => new ReplaySubject(1) })` を使う。コメントで明示されている理由は、`shareReplay` は complete/error 後にリセットされないため、再購読時に古い完了状態を受け取ってしまうからである。

```typescript
// resilientTrack$.ts:127-134
// We basically want shareReplay({refCount: true, bufferSize:1})
// but that doesn't allow for resetting on complete/error, so we
// do this instead
share({
  resetOnComplete: true,
  resetOnError: true,
  connector: () => new ReplaySubject(1),
});
```

### defer によるブラウザ API の遅延評価

`devices$` は `defer(() => ...)` で囲まれており、サーバーサイドバンドルに混入しても `navigator` 参照でクラッシュしない。これは RxJS の Observable が「購読時に初めて実行される」性質と組み合わせたパターンである。

```typescript
// resilientTrack$.ts:32-33
// Using defer here so that this doesn't blow up if it ends
// up in a server js bundle since navigator is browser api
export const devices$ = defer(() =>
  merge(
    from(navigator.mediaDevices.enumerateDevices()),
    fromEvent(navigator.mediaDevices, "devicechange").pipe(...)
  )
);
```

### fromFetch のカスタム実装: fetcher 注入

RxJS 標準の `fromFetch` を拡張し、`fetcher` パラメータでカスタム fetch 関数を注入可能にしている。これにより、リクエスト履歴の記録やカスタムヘッダーの付与を透過的に行える。

```typescript
// fromFetch.ts:23-30
export function fromFetch<T>(
  input: string | Request,
  initWithSelector: RequestInit & {
    selector?: (response: Response) => ObservableInput<T>;
    fetcher?: typeof fetch;  // カスタム fetch 関数の注入ポイント
  } = {}
): Observable<Response | T> {
```

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: 状態変化の伝播を疎結合に行う
  - 適用条件: 1 対多の依存関係があり、状態変化を自動的に通知したい場合
  - コード例: `PartyTracks.ts` 全体が Observable チェーンで構成されている
  - 注意点: RxJS の Observable は GoF の Observer パターンを関数合成可能な形に拡張したもの

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 複数のハンドラを順番に試行し、最初に成功したものを採用する
  - 適用条件: フォールバック付きのリソース取得が必要な場合
  - コード例: `resilientTrack$.ts:109-125` の `concat(...deviceList.map(...))` はデバイスを優先順位順に試行する
  - 注意点: RxJS の `concat` でモデル化すると、各ハンドラの成功/失敗が `next`/`complete`/`error` で自然に表現できる

- **Batch Processor パターン** (分類: 振る舞い/パフォーマンス)
  - 解決する問題: 同一ティック内の複数リクエストを一括処理し、API 呼び出し回数を削減する
  - 適用条件: 短期間に同種のリクエストが集中する場合
  - コード例: `Peer.utils.ts:24-81` の `BulkRequestDispatcher`
  - 注意点: `setTimeout(0)` はマクロタスク境界に依存するため、呼び出し側がすべて同期的に呼ぶ前提

## Good Patterns

- **subscriber.add() による宣言的リソース管理**: リソースの取得と解放を同じスコープ内で記述する。Observable の購読解除時にクリーンアップが自動実行されるため、解放漏れを防げる。

```typescript
// blackCanvasTrack$.ts:4-29
export const blackCanvasTrack$ = new Observable<MediaStreamTrack>(
  (subscriber) => {
    const canvas = document.createElement("canvas");
    // ... canvas 描画セットアップ ...
    const i = setInterval(() => {/* ... */}, 1000);
    const track = canvas.captureStream().getVideoTracks()[0];
    subscriber.add(() => {
      track.stop(); // リソース解放
      clearInterval(i); // タイマー解放
    });
    subscriber.next(track);
  },
).pipe(shareReplay({ refCount: true, bufferSize: 1 }));
```

- **combineLatest + switchMap で「常に最新の組み合わせ」を維持**: セッション変更・トラック変更・エンコーディング変更のいずれかが起きたとき、自動的に最新の組み合わせで再処理する。手動の同期コードが不要になる。

```typescript
// PartyTracks.ts:362-393
return combineLatest([
  pushedTrackData$,
  transceiver$,
  track$,
  subsequentSendEncodings$,
]).pipe(
  tap(([_trackData, { transceiver }, track, sendEncodings]) => {
    if (transceiver.sender.transport !== null) {
      transceiver.sender.replaceTrack(track);
    }
    // ...
  }),
  map(([trackData]) => {/* ... */}),
  shareReplay({ refCount: true, bufferSize: 1 }),
);
```

- **retryWithBackoff: 設定可能な指数バックオフオペレータ**: リトライロジックを汎用オペレータとして分離し、任意の Observable に `pipe()` で適用できる。`resetOnSuccess: true` により、成功後はリトライカウントがリセットされる。

```typescript
// rxjs-helpers.ts:21-51
export function retryWithBackoff<T>(config: BackoffConfig = {}) {
  const { maxRetries, initialDelay, maxDelay, backoffFactor, resetOnSuccess } = {
    ...configDefaults,
    ...config,
  };
  return (source: Observable<T>): Observable<T> =>
    source.pipe(
      retry({
        count: maxRetries,
        resetOnSuccess,
        delay: (_err, count) => {
          const delay = Math.min(initialDelay * backoffFactor ** (count - 1), maxDelay);
          return timer(delay);
        },
      }),
    );
}
```

- **Promise チェーンによる軽量な逐次スケジューラ**: `FIFOScheduler` は Mutex やセマフォなしに、Promise チェーンの性質だけで排他的逐次実行を実現する。エラーが発生しても後続タスクは正常に実行される。

```typescript
// Peer.utils.ts:11-21
schedule<T>(task: Task<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    this.#schedulerChain = this.#schedulerChain.then(async () => {
      try {
        resolve(await task());
      } catch (error) {
        reject(error as unknown);
      }
    });
  });
}
```

## Anti-Patterns / 注意点

- **shareReplay を complete/error 可能なソースに使う**: `shareReplay({ refCount: true, bufferSize: 1 })` は complete/error 後に新しいサブスクライバーに対してリセットされない。再購読時に古い完了/エラー状態を受け取ってしまう。

```typescript
// Bad: complete/error 後に再購読しても古い状態が返る
const track$ = getTrackSomehow().pipe(
  shareReplay({ refCount: true, bufferSize: 1 }),
);

// Better: complete/error 時にリセットされる share を使う
const track$ = getTrackSomehow().pipe(
  share({
    resetOnComplete: true,
    resetOnError: true,
    connector: () => new ReplaySubject(1),
  }),
);
```

- **Promise ベースの API でリアクティブな状態遷移を扱う**: `push()` が `Promise<TrackMetadata>` を返す設計だと、接続断→再接続時にメタデータが変わることを呼び出し側が処理する必要がある。Observable を返せば、再接続後のメタデータも自動的に通知される。

```typescript
// Bad: Promise は一度解決したら変わらない
async function pushTrack(track: MediaStreamTrack): Promise<TrackMetadata> {
  // 接続断→再接続→メタデータ変更 を表現できない
}

// Better: Observable なら再接続時の新メタデータも自動通知
function push(sourceTrack$: Observable<MediaStreamTrack>): Observable<TrackMetadata> {
  // session$ の変化に追従して自動的に再プッシュ
}
```

- **バッチ処理で同期的な呼び出しを仮定しすぎる**: `BulkRequestDispatcher` は同一ティック内の呼び出しのみバッチ化する。非同期処理を挟んだ呼び出しはバッチに含まれない点を理解して使う必要がある。

## 導出ルール

- `[MUST]` Observable のサブスクリプション内でリソースを取得したら、`subscriber.add()` / teardown 関数で同じスコープ内にクリーンアップを登録する
  - 根拠: partytracks の全 Observable（`blackCanvasTrack$`, `screenshare$`, `fromFetch`, `PartyTracks.session$` 等 8 箇所以上）が一貫してこのパターンを使い、リソースリークを構造的に防止している
- `[MUST]` 排他的に実行すべき非同期処理（SDP ネゴシエーション等）には Promise チェーン型スケジューラを使い、複数の同時実行を防ぐ
  - 根拠: `FIFOScheduler` が `createOffer` → `setLocalDescription` → API 呼び出し → `setRemoteDescription` の一連の処理を直列化し、WebRTC のシグナリング状態の競合を防止している（`PartyTracks.ts:224-259`）
- `[SHOULD]` 不安定なリソース（ネットワーク接続、ハードウェアデバイス等）の管理には、Promise ではなく Observable を使い、状態遷移の自動伝播でリカバリーロジックを利用側から隠蔽する
  - 根拠: `session$` が接続断時に `error` → `retryWithBackoff` で再接続し、`push()`/`pull()` の `combineLatest` + `switchMap` で自動的にトラックが再プッシュ/再プルされる設計
- `[SHOULD]` 同一ティック内に集中する同種リクエストは、`setTimeout(0)` によるマクロタスク境界バッチングで一括処理する
  - 根拠: `BulkRequestDispatcher` が最大 32 件のトラック操作を 1 回の API 呼び出しに集約し、SDP ネゴシエーション回数を劇的に削減している（`PartyTracks.ts:153-171`）
- `[SHOULD]` 完了やエラーの後に再購読が発生しうる Observable には `shareReplay` ではなく `share({ resetOnComplete: true, resetOnError: true, connector: () => new ReplaySubject(1) })` を使う
  - 根拠: `resilientTrack$.ts:127-134` と `screenshare$.ts:27-35` でコメント付きでこの判断が明示されている
- `[AVOID]` ブラウザ専用 API（`navigator`, `document` 等）を Observable のモジュールスコープで直接参照する — `defer()` で遅延評価にし、サーバーサイドバンドルでのクラッシュを防ぐ
  - 根拠: `resilientTrack$.ts:32-33` で `defer` を使い、コメントで「server js bundle で爆発しないように」と明示している

## 適用チェックリスト

- [ ] 不安定なリソース（WebSocket、WebRTC、デバイスアクセス等）の管理に Observable を使い、リカバリーロジックを利用側から隠蔽しているか
- [ ] `new Observable()` 内でリソースを取得する際、`subscriber.add()` でクリーンアップを登録しているか
- [ ] 指数バックオフ付きリトライが汎用オペレータとして分離されており、任意の Observable に適用可能か
- [ ] 排他的に実行すべき非同期処理に対して逐次スケジューラ（Promise チェーン等）が用意されているか
- [ ] 短期間に集中する同種リクエストに対してバッチ化の仕組みがあるか
- [ ] `shareReplay` を使っている箇所で、ソースが complete/error する可能性がないか確認したか
- [ ] ブラウザ専用 API を使う Observable が `defer()` で遅延評価されており、SSR/サーバーサイドで安全か
- [ ] React との統合で、Observable の参照安定性が保たれているか（`useRef` + `BehaviorSubject` 等）
