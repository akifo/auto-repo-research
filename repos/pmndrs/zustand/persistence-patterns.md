# persistence-patterns

> リポジトリ: pmndrs/zustand
> 分析日: 2026-02-20

## 概要

zustand の persist ミドルウェアは、状態の永続化という本質的に非同期な問題を、同期・非同期ストレージの透過的な統一、バージョンベースのマイグレーション、レース条件の防止、SSR 対応のための hydration 制御という 4 つの課題を約 400 行で解決している。特筆すべきは、同期/非同期の分岐を呼び出し側に意識させない `toThenable` パターン、並行 rehydrate のレース条件を単純なカウンタで防止する手法、そして `api.setState` をラップして永続化副作用を透過的に注入する Decorator パターンの適用である。これらは persist ミドルウェアに固有の話ではなく、あらゆる「副作用を持つ状態管理」に適用できる汎用的なプラクティスを体現している。

## 背景にある原則

- **同期/非同期の差異は呼び出し元に漏洩させるべきでない**: ストレージの同期/非同期はインフラ層の詳細であり、ビジネスロジック（hydration フロー）がこの差異を意識すると条件分岐が爆発する。zustand は `toThenable` で統一し、hydration ロジックを単一のチェーンで記述している（`src/middleware/persist.ts:157-185`）。
- **並行操作の制御には最小限のプリミティブを使うべき**: 複雑なロック機構や状態マシンではなく、単一のインクリメンタルカウンタ（`hydrationVersion`）で「最新の呼び出しのみ有効」を実現している。これは Last-Write-Wins セマンティクスの最もシンプルな実装である（`src/middleware/persist.ts:203,262,298,312,335`）。
- **副作用の注入は既存 API のラップで行い、利用者のメンタルモデルを壊さない**: `api.setState` を保存してからラップし、永続化副作用を透過的に追加している。利用者は `setState` を呼ぶだけで自動的に永続化される。同じパターンは devtools ミドルウェアでも使われている（`src/middleware/devtools.ts:216`）。
- **ストレージの抽象化は 2 層に分離すべき**: `StateStorage`（文字列ベース）と `PersistStorage`（構造化オブジェクトベース）の 2 層があり、`createJSONStorage` がその間をアダプトする。これにより、localStorage のような低レベル API でも、IndexedDB のような高レベル API でも同じ persist ロジックを使える（`src/middleware/persist.ts:31-61`）。

## 実例と分析

### toThenable: 同期/非同期統一パターン

persist ミドルウェアの最も独創的な設計は `toThenable` 関数にある。これは `Promise.resolve()` でラップする素朴なアプローチとは異なり、同期ストレージ使用時にマイクロタスクキューへの遅延を避ける。

```typescript
// src/middleware/persist.ts:148-185
type Thenable<Value> = {
  then<V>(
    onFulfilled: (value: Value) => V | Promise<V> | Thenable<V>,
  ): Thenable<V>
  catch<V>(
    onRejected: (reason: Error) => V | Promise<V> | Thenable<V>,
  ): Thenable<V>
}

const toThenable =
  <Result, Input>(
    fn: (input: Input) => Result | Promise<Result> | Thenable<Result>,
  ) =>
  (input: Input): Thenable<Result> => {
    try {
      const result = fn(input)
      if (result instanceof Promise) {
        return result as Thenable<Result>
      }
      return {
        then(onFulfilled) {
          return toThenable(onFulfilled)(result as Result)
        },
        catch(_onRejected) {
          return this as Thenable<any>
        },
      }
    } catch (e: any) {
      return {
        then(_onFulfilled) {
          return this as Thenable<any>
        },
        catch(onRejected) {
          return toThenable(onRejected)(e)
        },
      }
    }
  }
```

重要なポイント:
- 同期値は `Promise.resolve()` にラップせず、即座に `then` チェーンを同期実行する
- `instanceof Promise` で分岐し、本物の Promise はそのまま返す
- `try-catch` で同期例外もキャッチし、`catch` チェーン経由でエラーハンドリングを統一する
- これにより同期ストレージ使用時は store 生成と同一ティックで hydration が完了し、初期レンダリングで正しい値が得られる

テストがこの振る舞いを明確に示している:

```typescript
// tests/persistSync.test.tsx:41-75
it('can rehydrate state', () => {
  // 同期ストレージの場合、create() 直後に hydration 完了
  const useBoundStore = create(
    persist(
      () => ({ count: 0, name: 'empty' }),
      {
        name: 'test-storage',
        storage: createJSONStorage(() => storage),
        onRehydrateStorage: () => onRehydrateStorageSpy,
      },
    ),
  )
  // await 不要 — 同期的に hydration 済み
  expect(useBoundStore.getState()).toEqual({
    count: 42,
    name: 'test-storage',
  })
})
```

対照的に非同期テストでは時間の経過が必要:

```typescript
// tests/persistAsync.test.tsx:54-106
it('can rehydrate state', async () => {
  // 非同期ストレージでは初期状態がまず表示される
  expect(screen.getByText('count: 0, name: empty')).toBeInTheDocument()
  // 時間経過後に hydration 完了
  await act(() => vi.advanceTimersByTimeAsync(10))
  expect(
    screen.getByText('count: 42, name: test-storage'),
  ).toBeInTheDocument()
})
```

### hydrationVersion: カウンタによるレース条件防止

並行 `rehydrate()` 呼び出し時のレース条件を、単一のインクリメンタルカウンタで防止している。

```typescript
// src/middleware/persist.ts:200-203
let hasHydrated = false
// Counter to track hydration versions and prevent race conditions
// when multiple rehydrate() calls happen concurrently
let hydrationVersion = 0
```

hydrate 関数の冒頭でカウンタをインクリメントし、各 `then` チェーン内で現在の値と比較する:

```typescript
// src/middleware/persist.ts:261-262
const currentVersion = ++hydrationVersion
hasHydrated = false
```

```typescript
// src/middleware/persist.ts:296-299
.then((migrationResult) => {
  // Abort if a newer hydration has started
  if (currentVersion !== hydrationVersion) {
    return
  }
```

テストがこの動作を検証している:

```typescript
// tests/persistAsync.test.tsx:880-924
it('should handle multiple concurrent rehydrate calls (only last one wins)', async () => {
  // 3 回連続で rehydrate を呼び出す
  const promise1 = useBoundStore.persist.rehydrate()
  const promise2 = useBoundStore.persist.rehydrate()
  const promise3 = useBoundStore.persist.rehydrate()

  await act(() => vi.advanceTimersByTimeAsync(30))
  await Promise.all([promise1, promise2, promise3])

  // 最後の rehydrate のみが状態に反映される
  expect(useBoundStore.getState().count).toBe(30)
  // onFinishHydration も 1 回のみ呼ばれる
  expect(onFinishHydrationSpy).toHaveBeenCalledTimes(1)
})
```

### setState ラップ: 副作用の透過的注入

persist ミドルウェアは `api.setState` を保存してラップし、永続化を透過的に行う。同じパターンが devtools、immer、subscribeWithSelector でも使われている。

```typescript
// src/middleware/persist.ts:229-234
const savedSetState = api.setState

api.setState = (state, replace) => {
  savedSetState(state, replace as any)
  return setItem()
}
```

devtools ミドルウェアの同等コード:

```typescript
// src/middleware/devtools.ts:216-245
api.setState = ((state, replace, nameOrAction: Action) => {
  const r = set(state, replace as any)
  if (!isRecording) return r
  // ... DevTools への送信ロジック
  return r
}) as NamedSet<S>
```

subscribeWithSelector ミドルウェアは `api.subscribe` を同様にラップしている:

```typescript
// src/middleware/subscribeWithSelector.ts:50-68
const origSubscribe = api.subscribe as (listener: Listener) => () => void
api.subscribe = ((selector: any, optListener: any, options: any) => {
  // ... セレクタベースのフィルタリングロジック
  return origSubscribe(listener)
}) as any
```

### createJSONStorage: 2 層ストレージ抽象化

ストレージ抽象化を `StateStorage`（文字列レベル）と `PersistStorage`（構造化データレベル）の 2 層に分けている。

```typescript
// src/middleware/persist.ts:7-11
export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>
  setItem: (name: string, value: string) => R
  removeItem: (name: string) => R
}

// src/middleware/persist.ts:18-24
export interface PersistStorage<S, R = unknown> {
  getItem: (
    name: string,
  ) => StorageValue<S> | null | Promise<StorageValue<S> | null>
  setItem: (name: string, value: StorageValue<S>) => R
  removeItem: (name: string) => R
}
```

`createJSONStorage` がアダプターとして機能し、SSR 環境でのストレージ未定義も安全に処理する:

```typescript
// src/middleware/persist.ts:34-41
export function createJSONStorage<S, R = unknown>(
  getStorage: () => StateStorage<R>,
  options?: JsonStorageOptions,
): PersistStorage<S, unknown> | undefined {
  let storage: StateStorage<R> | undefined
  try {
    storage = getStorage()
  } catch {
    // prevent error if the storage is not defined (e.g. when server side rendering a page)
    return
  }
```

`getItem` 内では `instanceof Promise` チェックで同期/非同期を透過的に処理している:

```typescript
// src/middleware/persist.ts:43-55
getItem: (name) => {
  const parse = (str: string | null) => {
    if (str === null) {
      return null
    }
    return JSON.parse(str, options?.reviver) as StorageValue<S>
  }
  const str = storage.getItem(name) ?? null
  if (str instanceof Promise) {
    return str.then(parse)
  }
  return parse(str)
},
```

### skipHydration と手動 rehydrate: SSR 対応

SSR アプリケーションでは、サーバー側でクライアントストレージにアクセスできないため、hydration タイミングの制御が必要になる。

```typescript
// src/middleware/persist.ts:375-377
if (!options.skipHydration) {
  hydrate()
}
```

ストレージ未定義時のグレースフルデグラデーション:

```typescript
// src/middleware/persist.ts:208-219
if (!storage) {
  return config(
    (...args) => {
      console.warn(
        `[zustand persist middleware] Unable to update item '${options.name}', the given storage is currently unavailable.`,
      )
      set(...(args as Parameters<typeof set>))
    },
    get,
    api,
  )
}
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 低レベルストレージ API（文字列ベース）と高レベルの永続化ロジック（構造化データベース）のインターフェース不一致
  - 適用条件: 外部システムの API が内部の期待するインターフェースと異なる場合
  - コード例: `src/middleware/persist.ts:31-61` — `createJSONStorage` が `StateStorage` を `PersistStorage` に変換
  - 注意点: `getStorage` をファクトリ関数にすることで、SSR 時の `window is not defined` エラーを遅延評価で回避している

- **Decorator パターン** (分類: 構造)
  - 解決する問題: 既存の `setState` API を変更せずに副作用（永続化、DevTools 連携等）を追加する
  - 適用条件: 既存 API の利用者のコードを変更せずに振る舞いを拡張する場合
  - コード例: `src/middleware/persist.ts:229-234`, `src/middleware/devtools.ts:216-245`, `src/middleware/immer.ts:77-83`
  - 注意点: 複数ミドルウェアが同一メソッドをラップする場合、適用順序がセマンティクスに影響する

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: hydration のライフサイクル（開始・完了）を外部から監視・反応する
  - 適用条件: 非同期プロセスの進行状況を複数のコンシューマに通知する場合
  - コード例: `src/middleware/persist.ts:204-205,359-373` — `hydrationListeners`/`finishHydrationListeners` の `Set` と unsubscribe 関数の返却

## Good Patterns

- **Thenable による同期/非同期統一**: `Promise.resolve()` でラップする代わりに、同期値は即座にチェーンを実行するカスタム Thenable を使う。同期ストレージ使用時にマイクロタスク遅延を避け、store 生成と同一ティックで hydration を完了させる。

```typescript
// src/middleware/persist.ts:157-185
const toThenable =
  <Result, Input>(
    fn: (input: Input) => Result | Promise<Result> | Thenable<Result>,
  ) =>
  (input: Input): Thenable<Result> => {
    try {
      const result = fn(input)
      if (result instanceof Promise) {
        return result as Thenable<Result>
      }
      return {
        then(onFulfilled) {
          return toThenable(onFulfilled)(result as Result)
        },
        catch(_onRejected) {
          return this as Thenable<any>
        },
      }
    } catch (e: any) {
      // エラー時は catch チェーンのみ実行可能なオブジェクトを返す
      return {
        then(_onFulfilled) { return this as Thenable<any> },
        catch(onRejected) { return toThenable(onRejected)(e) },
      }
    }
  }
```

- **インクリメンタルカウンタによる Last-Write-Wins**: 並行呼び出しの制御に `AbortController` や複雑なキャンセルトークンではなく、単一の数値カウンタを使用。各 `then` チェーンの冒頭でバージョン比較し、古いリクエストを無視する。

```typescript
// src/middleware/persist.ts:261-262, 296-299
const currentVersion = ++hydrationVersion
// ...
.then((migrationResult) => {
  if (currentVersion !== hydrationVersion) {
    return  // 古い hydration は無視
  }
  // ...
})
```

- **ファクトリ関数によるストレージ遅延評価**: `createJSONStorage(() => window.localStorage)` のようにストレージをファクトリ関数で渡すことで、SSR 環境での `window is not defined` エラーを安全に処理する。

```typescript
// src/middleware/persist.ts:34-41
export function createJSONStorage<S, R = unknown>(
  getStorage: () => StateStorage<R>,
): PersistStorage<S, unknown> | undefined {
  let storage: StateStorage<R> | undefined
  try {
    storage = getStorage()
  } catch {
    return  // SSR 時は undefined を返し、グレースフルに機能しない
  }
```

## Anti-Patterns / 注意点

- **デフォルト shallow merge による nested object の欠落**: persist ミドルウェアのデフォルト `merge` は shallow merge であるため、ネストされたオブジェクトのフィールドが欠落する。

Bad:
```typescript
// ストレージに { foo: { bar: 0 } } が保存されている状態で
persist(
  () => ({ foo: { bar: 0, baz: 1 } }),
  { name: 'my-store' }
  // merge 未指定 — shallow merge により foo.baz が消失
)
```

Better:
```typescript
// docs/middlewares/persist.md の推奨パターン
import createDeepMerge from '@fastify/deepmerge'
const deepMerge = createDeepMerge({ all: true })

persist(
  () => ({ foo: { bar: 0, baz: 1 } }),
  {
    name: 'my-store',
    merge: (persisted, current) => deepMerge(current, persisted) as never,
  }
)
```

- **version 変更時に migrate 関数を忘れる**: `version` を上げたが `migrate` を提供しないと、保存済みデータが無視され `console.error` のみ出力される。テストでこの振る舞いが確認されている（`tests/persistSync.test.tsx:173-198`）。

Bad:
```typescript
persist(
  () => ({ count: 0 }),
  {
    name: 'my-store',
    version: 2,  // version を上げたが migrate がない
  }
)
// 結果: 保存済みデータは無視され、初期値 { count: 0 } に戻る
```

Better:
```typescript
persist(
  () => ({ count: 0 }),
  {
    name: 'my-store',
    version: 2,
    migrate: (persisted, version) => {
      if (version === 1) {
        // v1 -> v2 のマイグレーション
        return { count: (persisted as any).value ?? 0 }
      }
      return persisted as { count: number }
    },
  }
)
```

## 導出ルール

- `[MUST]` 同期/非同期両方をサポートする永続化層では、同期パスでマイクロタスク遅延を発生させないラッパーを使う（`Promise.resolve()` で統一しない）
  - 根拠: zustand の `toThenable` は同期ストレージ使用時に同一ティックで hydration を完了させ、初期レンダリングで正しい値を返す（`src/middleware/persist.ts:157-185`、`tests/persistSync.test.tsx:41-75`）

- `[MUST]` 永続化対象の状態スキーマを変更する場合は、バージョン番号のインクリメントとマイグレーション関数をセットで提供する
  - 根拠: zustand はマイグレーション関数なしにバージョンが不一致だと保存データを無視し、ユーザーデータが事実上消失する（`src/middleware/persist.ts:287-291`、`tests/persistSync.test.tsx:173-198`）

- `[SHOULD]` 並行して発生しうる非同期操作の制御には、インクリメンタルカウンタによる Last-Write-Wins を検討する — `AbortController` やロック機構より実装コストが低く、多くのケースで十分
  - 根拠: zustand の `hydrationVersion` は 1 変数で並行 rehydrate のレース条件を防止している（`src/middleware/persist.ts:203`、`tests/persistAsync.test.tsx:880-924`）

- `[SHOULD]` ミドルウェアが API メソッドをラップする際は、元のメソッドを変数に保存してから上書きし、チェーン可能にする
  - 根拠: `savedSetState = api.setState` のパターンが persist/devtools/immer/subscribeWithSelector の 4 つのミドルウェアで一貫して使われている（`src/middleware/persist.ts:229`、`src/middleware/devtools.ts:216`）

- `[SHOULD]` SSR 環境で参照不可能なブラウザ API（localStorage 等）はファクトリ関数で遅延評価し、例外時は機能を無効化して graceful に動作させる
  - 根拠: `createJSONStorage(() => window.localStorage)` のファクトリパターンと `try-catch` による `undefined` 返却（`src/middleware/persist.ts:34-41`）

- `[SHOULD]` ネストされたオブジェクトを永続化する場合はカスタム merge 関数で deep merge を使う — デフォルトの shallow merge はネストされたフィールドを消失させる
  - 根拠: zustand ドキュメントが明示的に `@fastify/deepmerge` の使用例を示している（`docs/middlewares/persist.md:696-848`）

- `[AVOID]` 永続化対象に関数やシリアライズ不可能な値を含める — `partialize` で明示的にフィルタするか、`replacer`/`reviver` でカスタムシリアライズする
  - 根拠: テストで `unstorableMethod` を `partialize` や `merge` で除外するパターンが繰り返し使われている（`tests/persistSync.test.tsx:280-293,295-333`）

## 適用チェックリスト

- [ ] 永続化対象のストレージが同期・非同期のどちらかを確認し、両方に対応する場合は `Promise.resolve()` 統一ではなく同期パスを保持する設計になっているか
- [ ] 永続化する状態にバージョン番号を付与し、スキーマ変更時のマイグレーション関数を用意しているか
- [ ] 並行して rehydrate/reload が発生しうる場合のレース条件対策があるか（カウンタ、AbortController 等）
- [ ] ネストされたオブジェクトの永続化で shallow merge による意図しないフィールド消失が起きないか確認したか
- [ ] SSR 環境でストレージ API 不在時のフォールバック（graceful degradation）が実装されているか
- [ ] 永続化対象から関数・クラスインスタンス等のシリアライズ不可能な値を除外しているか（`partialize` 等）
- [ ] hydration 完了前の UI 表示が考慮されているか（ローディング表示、`hasHydrated` チェック等）
