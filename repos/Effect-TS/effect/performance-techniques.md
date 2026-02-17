# performance-techniques

> リポジトリ: Effect-TS/effect
> 分析日: 2026-02-18

## 概要

Effect-TS はランタイムパフォーマンスを極めて意識して設計されている。Fiber スケジューリングによる協調的マルチタスク、HAMT（Hash Array Mapped Trie）によるイミュータブルコレクション、Chunk のロープ構造による O(1) concat、ハッシュキャッシング、トランジェントミューテーションなど、関数型プログラミングの理論と V8 エンジン最適化の実践知を融合させた内部最適化パターンが随所に見られる。これらの技法は Effect 固有のものではなく、高スループットが求められる TypeScript/JavaScript プロジェクト全般に適用可能である。

## 背景にある原則

- **ホットパスのアロケーション最小化**: Fiber ランタイムの run loop や Scheduler など、毎秒数千〜数万回実行されるコードでは、オブジェクト生成・配列コピーを徹底的に避ける。EffectPrimitive クラスは固定の3スロット（`effect_instruction_i0/i1/i2`）で全命令を表現し、命令ごとに異なるクラスを作らないことで V8 の hidden class を単一に保つ（`src/internal/core.ts:127-161`）。
- **計算の遅延と必要時の具現化**: Chunk は `IConcat` / `ISlice` タグで論理的な結合・分割を表現し、実際の配列コピーは `toReadonlyArray` が呼ばれた時点まで遅延する。このパターンにより、中間的なコレクション操作のコストを O(1) に抑える（`src/Chunk.ts:63-95, 295-316`）。
- **イミュータブルのデフォルト＋局所的ミューテーション**: HashMap は通常イミュータブルだが、`beginMutation` / `endMutation` で一時的にミュータブルにすることで、バッチ操作時のコピーコストをゼロにする。操作完了後に再びイミュータブルに戻すことで安全性を保つ（`src/internal/hashMap.ts:352-374`）。
- **協調的スケジューリングによるスタックセーフティ**: Fiber は一定回数のオペレーション実行後に yield し、microtask / macrotask に切り替える。これにより同期的な深い再帰でもスタックオーバーフローを防ぎつつ、他の Fiber に実行権を渡す（`src/Scheduler.ts:84-108, src/internal/fiberRuntime.ts:1356-1427`）。

## 実例と分析

### Fiber スケジューリングと yield 戦略

MixedScheduler は microtask（`Promise.resolve().then()`）と macrotask（`setTimeout`）をハイブリッドに使い分ける。`maxNextTickBeforeTimer`（デフォルト 2048）回の microtask 実行後に setTimeout へ切り替えることで、microtask starvation を防止する。各 Fiber は `currentMaxOpsBeforeYield`（デフォルト 2048）回のオペレーション実行後に yield 判定を受ける。

`shouldYield` の判定は Fiber の `currentOpCount` と FiberRef の値比較のみで、アロケーションゼロで完結する。

### Chunk のロープ構造による構造的共有

Chunk の `appendAll` は AVL 木に似たバランシングを行い、深さの差が 1 以内なら `IConcat` ノードを生成、それ以上なら回転操作でバランスを取る。これにより、連続した append 操作が O(log n) の深さに抑えられ、最終的な `toReadonlyArray` 呼び出し時に一度だけ線形コストを払う。

`take` / `drop` は実際のコピーを行わず `ISlice` ノードを生成するだけで、O(1) で完了する。

### HashMap の HAMT + トランジェントミューテーション

HashMap は HAMT（Hash Array Mapped Trie）で実装され、ビットマップ付きインデックスノードにより空間効率を最大化している。ハッシュの 5 ビットずつを各レベルのインデックスとして使い、popcount でビットマップから配列インデックスを算出する。

`beginMutation` は `_editable` フラグと `_edit` カウンターを持ち、ミュータブルモード中は `canEditNode` チェックにより同一ノードを in-place で更新する。新しい edit 番号により、異なるミュータブルセッションの混在を防止する。

### ハッシュキャッシング

`Hash.cached` は `Object.defineProperty` で `[Hash.symbol]` メソッドを上書きし、計算済みハッシュ値を直接返す関数に置換する。HashMap, HashSet, Chunk, List, Duration, RedBlackTree など、コードベース全体で 20 箇所以上使用されている。これにより、同一オブジェクトへの複数回のハッシュ計算をゼロコストにする。

### EffectPrimitive の Monomorphic Shape

全ての Effect 命令が同一の `EffectPrimitive` クラスを共有し、`effect_instruction_i0/i1/i2` という固定の3プロパティで引数を保持する。命令の種類は `_op` 文字列タグで区別する。これにより V8 の hidden class が1種類に統一され、インラインキャッシュのヒット率が最大化される。

### SingleShotGen による Generator 最適化

Effect の generator 構文（`Effect.gen`）は `SingleShotGen` クラスを使用し、1回の `next()` 呼び出しで即座に `done: true` を返す最小限の Generator を生成する。汎用的な Generator プロトコルの overhead を排除している。

### GlobalValue によるシングルトン保証

`globalValue` は `globalThis` 上の Map をバージョン付きストアとして使用し、モジュールの重複ロード（CJS/ESM 混在、HMR）でも同一インスタンスを保証する。Scheduler, FiberRef のデフォルト値、Logger など、ランタイムの基盤オブジェクトすべてがこのパターンで管理される。

### Prototype パターンによるオブジェクト生成

Chunk, HashMap, HashSet, Context, RedBlackTree など、すべてのデータ構造は `Object.create(Proto)` でプロトタイプチェーンを共有し、個別プロパティのみを設定する。クラスの `new` よりも軽量で、プロトタイプメソッドの共有が保証される。

## コード例

```typescript
// src/Scheduler.ts:84-108
// microtask → macrotask フォールバック
private starveInternal(depth: number) {
  const tasks = this.tasks.buckets
  this.tasks.buckets = []
  for (const [_, toRun] of tasks) {
    for (let i = 0; i < toRun.length; i++) {
      toRun[i]()
    }
  }
  if (this.tasks.buckets.length === 0) {
    this.running = false
  } else {
    this.starve(depth)
  }
}

private starve(depth = 0) {
  if (depth >= this.maxNextTickBeforeTimer) {
    setTimeout(() => this.starveInternal(0), 0)
  } else {
    Promise.resolve(void 0).then(() => this.starveInternal(depth + 1))
  }
}
```

```typescript
// src/Chunk.ts:631-654
// ロープ構造の appendAll（AVL 回転付き）
} = dual(2, <A, B>(self: Chunk<A>, that: Chunk<B>): Chunk<A | B> => {
  if (self.backing._tag === "IEmpty") { return that }
  if (that.backing._tag === "IEmpty") { return self }
  const diff = that.depth - self.depth
  if (Math.abs(diff) <= 1) {
    return makeChunk<A | B>({ _tag: "IConcat", left: self, right: that })
  } else if (diff < -1) {
    if (self.left.depth >= self.right.depth) {
      const nr = appendAll(self.right, that)
      return makeChunk({ _tag: "IConcat", left: self.left, right: nr })
    } else {
      const nrr = appendAll(self.right.right, that)
      if (nrr.depth === self.depth - 3) {
        const nr = makeChunk({ _tag: "IConcat", left: self.right.left, right: nrr })
        return makeChunk({ _tag: "IConcat", left: self.left, right: nr })
      } else {
        const nl = makeChunk({ _tag: "IConcat", left: self.left, right: self.right.left })
        return makeChunk({ _tag: "IConcat", left: nl, right: nrr })
      }
    }
  }
  // ...symmetric case
})
```

```typescript
// src/internal/hashMap.ts:352-374
// トランジェントミューテーション
export const beginMutation = <K, V>(self: HM.HashMap<K, V>): HM.HashMap<K, V> =>
  makeImpl(
    true,
    (self as HashMapImpl<K, V>)._edit + 1,
    (self as HashMapImpl<K, V>)._root,
    (self as HashMapImpl<K, V>)._size
  )

export const endMutation = <K, V>(self: HM.HashMap<K, V>): HM.HashMap<K, V> => {
  ;(self as HashMapImpl<K, V>)._editable = false
  return self
}

export const mutate = Dual.dual<...>(2, (self, f) => {
  const transient = beginMutation(self)
  f(transient)
  return endMutation(transient)
})
```

```typescript
// src/internal/core.ts:127-161
// Monomorphic EffectPrimitive — 全命令が同一 shape
class EffectPrimitive {
  public effect_instruction_i0 = undefined
  public effect_instruction_i1 = undefined
  public effect_instruction_i2 = undefined
  public trace = undefined;
  [EffectTypeId] = effectVariance
  constructor(readonly _op: Primitive["_op"]) {}
  // ...
}
```

```typescript
// src/Hash.ts:169-195
// ハッシュキャッシング — Object.defineProperty でメソッドを上書き
export const cached: { ... } = function() {
  // ...
  const self = arguments[0] as object
  const hash = arguments[1] as number
  Object.defineProperty(self, symbol, {
    value() { return hash },
    enumerable: false
  })
  return hash
}
```

## パターンカタログ

- **Flyweight** (分類: 構造)
  - 解決する問題: 大量の小オブジェクト生成によるメモリ・GC 圧力
  - 適用条件: 同じ構造を持つオブジェクトが大量に生成される場面
  - コード例: `src/internal/core.ts:127-161`（EffectPrimitive の固定 shape）、`src/Chunk.ts:125-163`（ChunkProto の共有）
  - 注意点: プロパティの名前と数を固定する必要があり、柔軟性とのトレードオフがある

- **Rope / Finger Tree** (分類: 構造)
  - 解決する問題: イミュータブルシーケンスの連結・分割コスト
  - 適用条件: append/prepend が頻繁で、最終的にまとめて読む使い方
  - コード例: `src/Chunk.ts:63-95, 631-654`（IConcat によるロープ構造）
  - 注意点: ランダムアクセスは O(depth) に劣化する

- **HAMT (Hash Array Mapped Trie)** (分類: 構造)
  - 解決する問題: イミュータブル Map の更新・検索パフォーマンス
  - 適用条件: 頻繁な挿入・検索が必要なイミュータブル辞書
  - コード例: `src/internal/hashMap/node.ts:1-250`、`src/internal/hashMap/bitwise.ts:1-33`
  - 注意点: 実装の複雑性が高く、ネイティブ Map が使える場面では不要

- **Transient Mutation** (分類: 振る舞い)
  - 解決する問題: バッチ操作時のイミュータブルコレクションのコピーコスト
  - 適用条件: 複数の更新操作を連続して行い、最後にイミュータブルに戻す場面
  - コード例: `src/internal/hashMap.ts:352-374`
  - 注意点: ミュータブル状態が外部に漏洩しないよう API 境界で確実に `endMutation` すること

## Good Patterns

- **Monomorphic Object Shape**: EffectPrimitive の `effect_instruction_i0/i1/i2` のように、異なる命令でも同一のプロパティ構造を持つクラスを使う。V8 の hidden class が統一され、プロパティアクセスのインラインキャッシュが常にヒットする。

```typescript
// src/internal/core.ts:127-133
class EffectPrimitive {
  public effect_instruction_i0 = undefined
  public effect_instruction_i1 = undefined
  public effect_instruction_i2 = undefined
  public trace = undefined
  constructor(readonly _op: Primitive["_op"]) {}
}
```

- **Dispatch Table で分岐を解消**: run loop での命令ディスパッチは、switch/if ではなくオブジェクトのプロパティアクセスを使い、`this[op._op](op)` で呼び出す。FiberRuntime クラスに各 op コードと同名のメソッドを定義し、文字列キーで直接ディスパッチする。

```typescript
// src/internal/fiberRuntime.ts:1392-1393
// @ts-expect-error
return this[(cur as core.Primitive)._op](cur as core.Primitive)
```

- **ESLint ルールによるパフォーマンス規約の強制**: `Array.push(...spread)` を禁止する ESLint ルールにより、大量要素のスプレッドによるスタックオーバーフローとパフォーマンス劣化をコードベース全体で防止する。

```javascript
// eslint.config.mjs:72-78
"no-restricted-syntax": [
  "error",
  {
    selector: "CallExpression[callee.property.name='push'] > SpreadElement.arguments",
    message: "Do not use spread arguments in Array.push"
  }
]
```

- **ハッシュキャッシング**: 一度計算したハッシュ値を `Object.defineProperty` でメモ化し、同一オブジェクトの再計算を防ぐ。HashMap のキーとして使われるオブジェクトは何度もハッシュされるため、この最適化は極めて効果的。

## Anti-Patterns / 注意点

- **`Array.push(...largeArray)` の使用**: 大きな配列をスプレッドで push すると、引数の数がコールスタックの制限を超えてスタックオーバーフローが発生する。Effect-TS はこれを ESLint ルールでプロジェクト全体で禁止している。

```typescript
// Bad: スタックオーバーフローの危険
result.push(...items) // items が大きいとクラッシュ

// Better: for ループで個別に push
for (let i = 0; i < items.length; i++) {
  result.push(items[i])
}
```

- **Polymorphic Object Shape の乱造**: 同種のオブジェクトがオペレーションごとに異なるプロパティセットを持つと、V8 の hidden class が分裂し、プロパティアクセスがメガモーフィック（遅い）になる。

```typescript
// Bad: 命令ごとに異なるプロパティ構造
const sync = { _op: "Sync", fn: () => {} }
const async = { _op: "Async", register: () => {}, blockingOn: id }

// Better: 固定プロパティに統一
class Primitive {
  effect_instruction_i0 = undefined
  effect_instruction_i1 = undefined
  constructor(readonly _op: string) {}
}
```

- **イミュータブルコレクションへの逐次的な個別更新**: 各更新でコピーが発生するため、N 回の更新で O(N * size) のコストになる。transient mutation パターンで囲めば O(N) に最適化できる。

```typescript
// Bad: 毎回新しい HashMap を生成
let map = HashMap.empty()
for (const [k, v] of entries) {
  map = HashMap.set(map, k, v) // 毎回 trie ノードをコピー
}

// Better: トランジェントミューテーションで囲む
const map = HashMap.mutate(HashMap.empty(), (draft) => {
  for (const [k, v] of entries) {
    HashMap.set(draft, k, v) // in-place 更新
  }
})
```

## 導出ルール

- `[MUST]` ホットパス（ループ内・毎フレーム実行）では `array.push(...spread)` を避け、for ループで個別に push する
  - 根拠: Effect-TS は ESLint ルールでプロジェクト全体から排除している。大きな配列でスタックオーバーフローが発生し、小さな配列でもスプレッドは通常の push より遅い（`eslint.config.mjs:72-78`）
- `[MUST]` イミュータブルコレクションにバッチ更新する際は transient/mutable セッションで囲み、完了後にイミュータブルに戻す
  - 根拠: Effect-TS の HashMap は `beginMutation/endMutation` で in-place 更新を可能にし、`fromIterable` 等のファクトリメソッドすべてがこのパターンを使用する（`src/internal/hashMap.ts:193-199`）
- `[SHOULD]` 頻繁にハッシュ比較されるオブジェクトには、初回計算時にハッシュ値をキャッシュする仕組みを設ける
  - 根拠: Effect-TS は `Hash.cached` で 20 以上のデータ構造にハッシュメモ化を適用し、HashMap/HashSet の lookup コストを実質ゼロにしている（`src/Hash.ts:169-195`）
- `[SHOULD]` ランタイムの中核で大量生成されるオブジェクトは、プロパティの名前と数を固定して Monomorphic Shape を維持する
  - 根拠: EffectPrimitive は `effect_instruction_i0/i1/i2` の3スロット固定で全命令を表現し、V8 の hidden class 分裂を防止している（`src/internal/core.ts:127-161`）
- `[SHOULD]` コレクションの concat/slice 操作は実際のコピーを遅延し、ロープ構造などの論理的な表現で O(1) にする
  - 根拠: Chunk の `IConcat` / `ISlice` タグは物理的な配列コピーを `toReadonlyArray` 呼び出しまで遅延し、中間操作のコストを排除している（`src/Chunk.ts:63-95, 631-654`）
- `[SHOULD]` モジュール重複ロード環境（CJS/ESM 混在、HMR）でシングルトンを保証するには、`globalThis` 上のバージョン付きストアを使う
  - 根拠: `globalValue` パターンは `Symbol.for` でグローバルキーを共有し、ランタイムの基盤オブジェクトの重複生成を防止している（`src/GlobalValue.ts:42-53`）
- `[AVOID]` 同種オブジェクトにオペレーションごとの異なるプロパティセットを持たせること（Polymorphic Shape）
  - 根拠: V8 の hidden class が分裂すると、プロパティアクセスがメガモーフィック deoptimization を引き起こし、10〜100x の性能劣化が発生しうる

## 適用チェックリスト

- [ ] ホットパスで `Array.push(...spread)` を使用していないか確認する
- [ ] イミュータブルコレクションのバッチ更新が transient mutation パターンで囲まれているか確認する
- [ ] 頻繁にハッシュ比較されるオブジェクト（Map キー等）にハッシュキャッシングを導入する
- [ ] ランタイムの中核で大量生成されるオブジェクトの shape が monomorphic か確認する
- [ ] コレクション操作チェーン（map → filter → concat）で不要な中間コピーが発生していないか確認する
- [ ] シングルトンオブジェクトが CJS/ESM 混在や HMR で重複生成されていないか確認する
- [ ] 協調的スケジューリングが必要な長時間実行ループに yield ポイントを設けているか確認する
- [ ] ESLint カスタムルールでパフォーマンスアンチパターンをプロジェクト全体で禁止しているか確認する
