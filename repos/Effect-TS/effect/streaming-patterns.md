# streaming-patterns

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect の Stream/Sink/Channel 三層アーキテクチャにおける合成パターン、バックプレッシャー機構、リソース管理の仕組みを分析した。Effect のストリーミングは「Channel を基盤として Stream と Sink を構築する」という階層的抽象により、pull-based のバックプレッシャーと Scope ベースのリソース安全性を両立させている。この設計は ZIO Stream からの移植であるが、TypeScript 上で型安全な双方向チャネル合成を実現している点が注目に値する。

## 背景にある原則

- **Channel 統一原則**: Stream も Sink もその内部表現は Channel であり、Stream は `Channel<Chunk<A>, ...>` を、Sink は `Channel<Chunk<L>, Chunk<In>, ...>` をラップしたものに過ぎない。これにより、Stream→Sink の接続は Channel の `pipeTo` に帰着し、合成の一貫性が保たれる。根拠: `StreamImpl.channel` (`packages/effect/src/internal/stream.ts:80`) と `SinkImpl.channel` (`packages/effect/src/internal/sink.ts:51`) がともに Channel フィールドを持つ。

- **Pull-based バックプレッシャー原則**: Stream は pull-based であり、下流が要求したときのみ上流が値を生成する。これにより、明示的なバッファ管理なしにバックプレッシャーが実現される。push-based が必要な場合は `SingleProducerAsyncInput` や `Handoff` を介して pull に変換する。根拠: Stream の doc コメント (`packages/effect/src/Stream.ts:57-61`) に「inherent laziness and backpressure, relieving users of the need to manage buffers between operators」と記載。

- **Chunk によるバッチ償却原則**: Stream は単一値ではなく `Chunk<A>` を内部転送単位とすることで、Effect 評価のオーバーヘッドを償却する。デフォルトチャンクサイズ 4096 (`packages/effect/src/internal/stream.ts:94`) が採用されている。個々の要素ではなくバッチで処理することで、ファイバースケジューリングコストを分散する。

- **Scope 連動リソース管理原則**: ストリームのライフサイクルに紐づくリソース（ファイルハンドル、ソケット等）は Scope を通じて管理され、ストリーム終了時（正常・エラー・中断問わず）に確実に解放される。`Stream.scoped` や `Channel.acquireReleaseOut` がこのパターンを体現する。根拠: `channel.run` が `Effect.scopedWith` を使用 (`packages/effect/src/internal/channel.ts:2051`)。

## 実例と分析

### 三層アーキテクチャ: Channel → Stream / Sink

Stream と Sink は Channel の特殊化であり、相互変換が可能:

```typescript
// packages/effect/src/internal/stream.ts:2997-3012
export const fromChannel = <A, E, R>(
  channel: Channel.Channel<Chunk.Chunk<A>, unknown, E, unknown, unknown, unknown, R>,
): Stream.Stream<A, E, R> => new StreamImpl(channel);

export const toChannel = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Channel.Channel<Chunk.Chunk<A>, unknown, E, unknown, unknown, unknown, R> => {
  if ("channel" in stream) {
    return (stream as StreamImpl<A, E, R>).channel;
  } else if (Effect.isEffect(stream)) {
    return toChannel(fromEffect(stream)) as any;
  } else {
    throw new TypeError(`Expected a Stream.`);
  }
};
```

Stream の `run` は Channel の `pipeToOrFail` + `runDrain` に帰着する:

```typescript
// packages/effect/src/internal/stream.ts:5609-5616
export const run = (self, sink) =>
  toChannel(self).pipe(
    channel.pipeToOrFail(sink_.toChannel(sink)),
    channel.runDrain,
  );
```

### Handoff: push→pull 変換のための同期プリミティブ

`Handoff` は producer-consumer 間で1要素ずつ同期的にデータを受け渡す機構。`Deferred` と `Ref` のみで構築されており、Deferred ベースの待機により自然なバックプレッシャーを実現する:

```typescript
// packages/effect/src/internal/stream/handoff.ts:108-136
export const offer = dual(2, (self, value) => {
  return Effect.flatMap(Deferred.make(), (deferred) =>
    Effect.flatten(
      Ref.modify(self.ref, (state) =>
        handoffStateMatch(
          // Empty: consumer に通知し、producer は deferred で待機
          (notifyConsumer) => [
            Effect.zipRight(
              Deferred.succeed(notifyConsumer, void 0),
              Deferred.await(deferred), // producer はここでブロック
            ),
            handoffStateFull(value, deferred),
          ],
          // Full: 前のデータがまだ取られていないので、取られるまで待機して再試行
          (_, notifyProducer) => [
            Effect.flatMap(
              Deferred.await(notifyProducer),
              () => offer(self, value),
            ),
            state,
          ],
        )),
    ));
});
```

この Handoff は `aggregateWithin` で Sink とストリームを接続する際のブリッジとして使われ、Sink のスケジュール駆動フラッシュと upstream の非同期 push を協調させる。

### SingleProducerAsyncInput: Channel 間の非同期ブリッジ

Channel の `Bridge` オペレーションで使われる `SingleProducerAsyncInput` は、4状態 (Empty/Emit/Error/Done) の状態マシンを `Ref.modify` で管理し、producer の `awaitRead` と consumer の `takeWith` をロックフリーで協調させる:

```typescript
// packages/effect/src/internal/channel/singleProducerAsyncInput.ts:92-105
class SingleProducerAsyncInputImpl<Err, Elem, Done> {
  constructor(readonly ref: Ref.Ref<State<Err, Elem, Done>>) {}

  awaitRead(): Effect.Effect<unknown> {
    return Effect.flatten(
      Ref.modify(this.ref, (state) =>
        state._tag === OP_STATE_EMPTY
          ? [Deferred.await(state.notifyProducer), state]
          : [Effect.void, state]),
    );
  }
  // ...
}
```

### 並行性制御: flatMap の concurrency オプション

`flatMap` は concurrency パラメータにより sequential / concurrent / switch の3モードを切り替える。sequential は `channel.concatMap`、concurrent は `channel.mergeMap` に委譲される:

```typescript
// packages/effect/src/internal/stream.ts:2753-2790
if (options?.switch) {
  return matchConcurrency(
    options?.concurrency,
    () => flatMapParSwitchBuffer(self, 1, bufferSize, f),
    (n) => flatMapParSwitchBuffer(self, n, bufferSize, f)
  )
}
return matchConcurrency(
  options?.concurrency,
  () => new StreamImpl(channel.concatMap(toChannel(self), ...)),
  (_) => new StreamImpl(pipe(
    toChannel(self),
    channel.concatMap(channel.writeChunk),
    channel.mergeMap((out) => toChannel(f(out)), options)
  ))
)
```

### HaltStrategy: マージ時の終了制御

2つのストリームをマージする際、どちらが終了したときに全体を終了するかを `HaltStrategy` で宣言的に制御する:

```typescript
// packages/effect/src/internal/stream/haltStrategy.ts:6-23
export const Left: HaltStrategy.HaltStrategy = { _tag: OP_LEFT }; // 左が終了したら終了
export const Right: HaltStrategy.HaltStrategy = { _tag: OP_RIGHT }; // 右が終了したら終了
export const Both: HaltStrategy.HaltStrategy = { _tag: OP_BOTH }; // 両方終了したら終了
export const Either: HaltStrategy.HaltStrategy = { _tag: OP_EITHER }; // いずれか終了したら終了
```

### MergeDecision / MergeStrategy: マージの挙動を代数的に表現

Channel レベルの `mergeWith` は `MergeDecision` を用いて「一方が完了したときの残りの処理方針」を代数的に記述する:

```typescript
// packages/effect/src/internal/channel/mergeDecision.ts:55-77
export const Done = <Z, E, R>(effect: Effect.Effect<Z, E, R>): MergeDecision => { ... }
export const Await = <R, E0, Z0, E, Z>(
  f: (exit: Exit.Exit<Z0, E0>) => Effect.Effect<Z, E, R>
): MergeDecision => { ... }
```

`MergeStrategy` は `BackPressure` と `BufferSliding` の2択で、バッファ飽和時の振る舞いを選択する:

```typescript
// packages/effect/src/internal/channel/mergeStrategy.ts:20-31
export const BackPressure = (_: void): MergeStrategy => { ... }
export const BufferSliding = (_: void): MergeStrategy => { ... }
```

### バッファ戦略の選択肢

`Stream.async` や `Stream.buffer` はバッファ戦略として `suspend` (backpressure)、`dropping`、`sliding` を Queue の種類で切り替える:

```typescript
// packages/effect/src/internal/stream.ts:459-478
const queueFromBufferOptions = (bufferSize) => {
  if (bufferSize === "unbounded") {
    return Queue.unbounded();
  } else if (typeof bufferSize === "number" || bufferSize === undefined) {
    return Queue.bounded(bufferSize ?? 16);
  }
  switch (bufferSize.strategy) {
    case "dropping":
      return Queue.dropping(bufferSize.bufferSize ?? 16);
    case "sliding":
      return Queue.sliding(bufferSize.bufferSize ?? 16);
    default:
      return Queue.bounded(bufferSize.bufferSize ?? 16);
  }
};
```

## パターンカタログ

- **Interpreter パターン** (分類: 振る舞い)
  - 解決する問題: Channel の多様なオペレーション（Emit, Read, PipeTo, Fold, BracketOut 等）を統一的に実行する
  - 適用条件: DSL としてデータ構造でプログラムを表現し、インタプリタで実行する場合
  - コード例: `packages/effect/src/internal/channel/channelExecutor.ts:92-150` の `run()` メソッド。タグベースの switch 文で各 opcode を処理するトランポリンループ
  - 注意点: インタプリタループは `while (result === undefined)` で同期的に実行し、非同期が必要な場合のみ `FromEffect` 状態で Effect に戻る

- **Bridge パターン** (分類: 構造)
  - 解決する問題: 非同期 producer と pull-based consumer を接続する
  - 適用条件: push-based ソースを pull-based パイプラインに統合する場合
  - コード例: `packages/effect/src/internal/channel/singleProducerAsyncInput.ts`、`packages/effect/src/internal/stream/handoff.ts`
  - 注意点: `Handoff` は1要素同期、`SingleProducerAsyncInput` は複数 consumer 対応と使い分けられている

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: マージ終了条件やバッファ飽和時の挙動を差し替え可能にする
  - 適用条件: 同一の合成操作で異なるポリシーを選択させたい場合
  - コード例: `HaltStrategy` (`packages/effect/src/internal/stream/haltStrategy.ts`), `MergeStrategy` (`packages/effect/src/internal/channel/mergeStrategy.ts`)

## Good Patterns

- **Channel 統一抽象によるゼロコスト合成**: Stream と Sink がともに Channel のラッパーであるため、`stream.run(sink)` は内部的には `channel.pipeToOrFail(sinkChannel)` の1行で実現される。新しい Stream オペレータを追加する際も Channel の合成として自然に表現できる。これにより合成のオーバーヘッドがデータ構造の連結に限定される。

  ```typescript
  // packages/effect/src/internal/stream.ts:5613-5615
  toChannel(self).pipe(
    channel.pipeToOrFail(sink_.toChannel(sink)),
    channel.runDrain,
  );
  ```

- **Deferred ベースの同期によるロックフリーバックプレッシャー**: `Handoff` と `SingleProducerAsyncInput` は Mutex やセマフォではなく、`Ref.modify` + `Deferred` で状態遷移と待機を実現する。これにより OS レベルのロック不要でファイバー間のバックプレッシャーが成立する。

  ```typescript
  // packages/effect/src/internal/stream/handoff.ts:98-106
  export const make = <A>(): Effect.Effect<Handoff<A>> =>
    pipe(
      Deferred.make<void>(),
      Effect.flatMap((deferred) => Ref.make(handoffStateEmpty<A>(deferred))),
      Effect.map((ref): Handoff<A> => ({ [HandoffTypeId]: handoffVariance, ref })),
    );
  ```

- **Take 型によるストリーム信号の統一**: `Take<A, E>` は `Exit<Chunk<A>, Option<E>>` のラッパーであり、データ (`Chunk<A>`)、エラー (`Some<E>`)、終了 (`None`) の3信号を1つの型で表現する。Queue を介した非同期ストリームでは、この Take を Queue に投入することで、信号の種類に関わらず同一チャネルで伝送できる。

  ```typescript
  // packages/effect/src/internal/take.ts:26-33
  export class TakeImpl<out A, out E = never> implements Take.Take<A, E> {
    readonly [TakeTypeId] = takeVariance;
    constructor(readonly exit: Exit.Exit<Chunk.Chunk<A>, Option.Option<E>>) {}
  }
  ```

- **宣言的な並行性制御**: `flatMap` の `concurrency` オプションにより、sequential / bounded / unbounded の切り替えが1つのパラメータで完結する。内部では `matchConcurrency` ヘルパーが `concatMap` と `mergeMap` を切り替える。利用者は並行度の数値を変えるだけで挙動を調整できる。

## Anti-Patterns / 注意点

- **バッファサイズ未指定による暗黙のデフォルト**: Effect では `bufferSize` を省略するとデフォルト 16 が適用される。これは大量データのストリームでは小さすぎてスループットが低下し、メモリ制約のあるストリームでは大きすぎる可能性がある。

  ```typescript
  // Bad: デフォルト任せ
  Stream.async(register);

  // Better: 明示的にバッファサイズと戦略を指定
  Stream.async(register, { bufferSize: 256, strategy: "dropping" });
  ```

- **unbounded concurrency の安易な使用**: `concurrency: "unbounded"` は内部で `Number.MAX_SAFE_INTEGER` に変換される (`packages/effect/src/internal/stream.ts:2803`)。入力ストリームの要素数に上限がない場合、ファイバーが際限なく生成される。bounded concurrency + backpressure が安全なデフォルト。

  ```typescript
  // Bad: 入力サイズ不明で unbounded
  Stream.flatMap(urls, fetchUrl, { concurrency: "unbounded" });

  // Better: 上限を設定
  Stream.flatMap(urls, fetchUrl, { concurrency: 10 });
  ```

- **Scope 管理なしのリソースストリーム化**: ファイルやネットワーク接続をストリームのソースにする際、`Stream.scoped` を使わずに直接 `Stream.fromEffect` でリソースを取得すると、ストリーム処理中のエラーや中断時にリソースがリークする。

  ```typescript
  // Bad: acquireRelease なしで直接開く
  const stream = Stream.fromEffect(openFile(path)).pipe(
    Stream.flatMap(readLines),
  );

  // Better: scoped でライフサイクルを管理
  const stream = Stream.scoped(
    Effect.acquireRelease(openFile(path), closeFile),
  ).pipe(Stream.flatMap(readLines));
  ```

## 導出ルール

- `[MUST]` ストリーミング基盤を設計する際は、内部転送単位を単一要素ではなくバッチ（配列やチャンク）にして、評価オーバーヘッドを償却する
  - 根拠: Effect は `Chunk<A>` を転送単位とし、デフォルトチャンクサイズ 4096 で個々の要素評価コストを分散している (`packages/effect/src/internal/stream.ts:94`)

- `[MUST]` ストリームに紐づくリソース（ファイルハンドル、コネクション等）は Scope や acquire-release パターンで管理し、正常終了・エラー・中断のすべてのケースで解放を保証する
  - 根拠: `channel.run` が `Effect.scopedWith` でスコープを作成し、Channel の finalizer を確実に実行する設計になっている (`packages/effect/src/internal/channel.ts:2050-2052`)

- `[SHOULD]` ストリーム合成の基盤となる低レベル抽象を1つ定義し、高レベル API（ソースとシンク）はその抽象のラッパーとして実装する。合成はすべて低レベル抽象の操作に帰着させる
  - 根拠: Effect では Stream も Sink も Channel のラッパーであり、`run` は `channel.pipeToOrFail` に帰着する。新しいオペレータの追加が Channel 合成として統一的に行える (`packages/effect/src/internal/stream.ts:5613-5616`)

- `[SHOULD]` push-based ソースを pull-based パイプラインに統合する際は、Deferred/Promise ベースの同期プリミティブで producer を待機させ、consumer の pull を起点とするバックプレッシャーを実現する
  - 根拠: `Handoff` が `Deferred.await` で producer をブロックし、consumer の `take` で解放する設計 (`packages/effect/src/internal/stream/handoff.ts:112-136`)

- `[SHOULD]` 並行ストリーム処理では concurrency を明示的な数値で上限指定し、unbounded は入力サイズが既知の場合に限定する
  - 根拠: `matchConcurrency` が `"unbounded"` を `Number.MAX_SAFE_INTEGER` に変換するため、入力サイズ不明だとファイバー生成が制御不能になる (`packages/effect/src/internal/stream.ts:2803`)

- `[SHOULD]` マージ・並行合成時の終了条件やバッファ飽和時の挙動は、Strategy オブジェクトとして明示的に選択可能にし、デフォルトの挙動を文書化する
  - 根拠: `HaltStrategy` (Left/Right/Both/Either) と `MergeStrategy` (BackPressure/BufferSliding) により、同一のマージ操作で異なるポリシーを宣言的に切り替えられる

- `[AVOID]` ストリーム処理で単一要素ごとに Effect/Promise を評価するパイプラインを組む。バッチ処理に変換して1回の評価で複数要素を処理すべき
  - 根拠: Effect の Stream が `Chunk<A>` を転送単位とし、`mapChunks` 等のバッチオペレータを提供しているのは、要素単位の Effect 評価コストが支配的になることを防ぐため

## 適用チェックリスト

- [ ] ストリーミング処理の内部転送単位がバッチ化されているか確認する（単一要素転送はボトルネック候補）
- [ ] ストリームに紐づく外部リソース（ファイル、DB接続、WebSocket等）に acquire-release パターンが適用されているか確認する
- [ ] push-based ソース（EventEmitter、WebSocket、コールバック API）を取り込む箇所でバックプレッシャーが機能しているか確認する
- [ ] `concurrency: "unbounded"` を使用している箇所で、入力サイズの上限が保証されているか確認する
- [ ] 複数ストリームのマージで、終了条件（片方終了 or 両方終了）が意図通りに設定されているか確認する
- [ ] バッファ飽和時の挙動（backpressure / dropping / sliding）がユースケースに合っているか確認する
- [ ] ストリームのソース・変換・消費の各レイヤーが単一の抽象（Channel 相当）で統一されているか、あるいは統一すべきか検討する
