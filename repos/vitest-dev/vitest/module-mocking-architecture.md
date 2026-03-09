# module-mocking-architecture

> リポジトリ: vitest-dev/vitest
> 分析日: 2026-03-05

## 概要

Vitest のモジュールモッキング基盤（`@vitest/mocker` パッケージ）を横断的に分析し、AST 変換によるホイスティング、環境非依存の自動モック生成、ブラウザ/Node 両対応のインターセプト戦略を抽出した。ESM の静的バインディング制約を Vite プラグインチェーンと MagicString による精密なコード書き換えで突破する手法は、テストツールに限らず「実行時にモジュールの振る舞いを差し替える」あらゆるシステムに応用できる。

## 背景にある原則

- **早期フィルタリングで AST 解析コストを回避すべき**: 正規表現による事前チェック (`regexpHoistable`) で `vi.mock` 等の呼び出しが存在しないファイルを即座にスキップし、重い AST パースを避ける。根拠: `hoistMocks.ts:84` で `regexpHoistable.test(code)` を最初に実行し、マッチしなければ即 `return` する設計。
- **コード変換は破壊的書き換えではなく差分パッチであるべき**: MagicString を使い、元コードの位置情報を保持したまま `move` / `overwrite` / `appendLeft` で変換する。ソースマップが自動生成され、デバッグ体験を損なわない。根拠: `hoistMocks.ts` 全体で `s.move()` / `s.update()` を使用し、最後に `s.generateMap({ hires: 'boundary' })` でマップ生成。
- **環境差異はインターフェース境界で吸収すべき**: `ModuleMockerInterceptor` という 3 メソッドのインターフェースを定義し、ブラウザ（MSW / ネイティブ）と Node.js で別実装を差し込む。コア（`MockerRegistry`, `mockObject`）は環境非依存。根拠: `interceptor.ts` で `register` / `delete` / `invalidate` のみ定義。
- **型によるモック分類で条件分岐を構造化すべき**: `automock` / `autospy` / `manual` / `redirect` の 4 種を判別共用体（discriminated union）で表現し、`switch (mock.type)` パターンで安全に分岐する。根拠: `registry.ts:155-160` の `MockedModule` 型と各所の `mock.type` による分岐。

## 実例と分析

### AST 変換によるモック宣言のホイスティング

`vi.mock()` は見た目上テストファイル内の任意の位置に書けるが、実際にはファイル先頭にホイストされる必要がある。`hoistMocks.ts` は以下の手順でこれを実現する:

1. 正規表現で `vi.mock` / `vi.unmock` / `vi.hoisted` の存在をチェック（高速フィルタ）
2. `esmWalker` で AST を走査し、`CallExpression` から対象メソッド呼び出しを検出
3. 検出した呼び出しノードを `hoistedNodes` セットに蓄積
4. ノード同士のネスト関係を検証（相互ネストを禁止）
5. `MagicString.move()` でファイル先頭に物理的に移動
6. `import` 文を `const __vi_import_N__ = await import(...)` に変換し、参照先を書き換え

```typescript
// packages/mocker/src/node/hoistMocks.ts:84-88
const needHoisting = (options.regexpHoistable || regexpHoistable).test(code)
if (!needHoisting) {
  return
}
```

```typescript
// packages/mocker/src/node/hoistMocks.ts:494-503
for (const node of arrayNodes) {
  const end = getNodeTail(code, node)
  if (hoistIndex === end || hoistIndex === node.start) {
    hoistIndex = end
  }
  else {
    s.move(node.start, end, hoistIndex)
  }
}
```

### 自動モック生成の再帰的オブジェクト走査

`automocker.ts` の `mockObject` 関数は、モジュールエクスポートを再帰的に走査し、関数をスパイ/スタブに置換する。循環参照を `RefTracker` で追跡し、無限再帰を防止する。

```typescript
// packages/mocker/src/automocker.ts:183-201
class RefTracker {
  private idMap = new Map<any, number>()
  private mockedValueMap = new Map<number, any>()

  public getId(value: any) {
    return this.idMap.get(value)
  }

  public getMockedValue(id: number) {
    return this.mockedValueMap.get(id)
  }

  public track(originalValue: any, mockedValue: any): number {
    const newId = this.idMap.size
    this.idMap.set(originalValue, newId)
    this.mockedValueMap.set(newId, mockedValue)
    return newId
  }
}
```

`automock` と `autospy` の差異は `createMock` 内で分岐する。`autospy` は元の実装を保持しつつ呼び出しを記録し、`automock` は空の関数に置換する:

```typescript
// packages/mocker/src/automocker.ts:44-49
return createMockInstance({
  name: currentValue.name,
  prototypeMembers,
  originalImplementation: options.type === 'autospy' ? currentValue : undefined,
  keepMembersImplementation: options.type === 'autospy',
})
```

### ブラウザ環境でのモジュールインターセプト戦略

ブラウザでは 2 つのインターセプト戦略が用意されている:

1. **MSW 方式** (`interceptor-msw.ts`): Service Worker でリクエストを傍受し、モックモジュールの URL にリダイレクトまたは動的生成スクリプトを返す
2. **ネイティブ方式** (`interceptor-native.ts`): WebSocket RPC でサーバー側レジストリに登録し、Vite の `load` / `transform` フックでコード変換

どちらも同一の `ModuleMockerInterceptor` インターフェースを実装する:

```typescript
// packages/mocker/src/browser/interceptor.ts:1-7
export interface ModuleMockerInterceptor {
  register: (module: MockedModule) => Promise<void>
  delete: (url: string) => Promise<void>
  invalidate: () => Promise<void>
}
```

### 動的インポートのラッピング

`dynamicImportPlugin.ts` は、テストコード内の `import()` 式を `globalThis["__vitest_mocker__"].wrapDynamicImport(() => import(...))` にラップする。モック登録が完了してからインポートが実行されることを保証する:

```typescript
// packages/mocker/src/node/dynamicImportPlugin.ts:67-76
onDynamicImport(node) {
  const globalThisAccessor = options.globalThisAccessor || '"__vitest_mocker__"'
  const replaceString = `globalThis[${globalThisAccessor}].wrapDynamicImport(() => import(`
  const importSubstring = code.substring(node.start, node.end)
  const hasIgnore = importSubstring.includes('/* @vite-ignore */')
  s.overwrite(
    node.start,
    (node.source as Positioned<Expression>).start,
    replaceString + (hasIgnore ? '/* @vite-ignore */ ' : ''),
  )
  s.overwrite(node.end - 1, node.end, '))')
},
```

### レジストリのデュアルインデックスとシリアライズ設計

`MockerRegistry` は URL とモジュール ID の 2 つのインデックスで同一モックを管理する。これはブラウザ側（URL ベース）とサーバー側（ファイルパスベース）の参照方式の違いを吸収するためである。また各モッククラスは `toJSON` / `fromJSON` を持ち、WebSocket 越しにシリアライズ可能:

```typescript
// packages/mocker/src/registry.ts:1-4
export class MockerRegistry {
  private readonly registryByUrl: Map<string, MockedModule> = new Map()
  private readonly registryById: Map<string, MockedModule> = new Map()
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ブラウザ/Node.js でモジュールインターセプトの仕組みが根本的に異なる
  - 適用条件: 同一インターフェースで異なる実行環境をサポートする必要がある場合
  - コード例: `interceptor.ts:1-7`, `interceptor-msw.ts:34`, `interceptor-native.ts:5`
  - 注意点: インターフェースを最小化する（3 メソッド）ことで実装コストを低く保っている

- **Visitor パターン** (分類: 振る舞い)
  - 解決する問題: AST の各ノード型に対して異なる変換処理を適用する
  - 適用条件: 木構造を走査しながら型ごとに異なるアクションを実行する場合
  - コード例: `esmWalker.ts:64-66` の `Visitors` インターフェース
  - 注意点: DFS で収集し BFS で処理する二段階方式でホイスト宣言の順序を保証

- **Registry パターン** (分類: 構造)
  - 解決する問題: 複数の識別子（URL / ID）で同一オブジェクトを参照する
  - 適用条件: エンティティに複数の自然キーがある場合
  - コード例: `registry.ts:1-4` のデュアル Map
  - 注意点: 削除時に両方のインデックスから除去しないと不整合が生じる

## Good Patterns

- **正規表現による AST 解析ガード**: 重い解析の前に正規表現で対象ファイルを絞り込む。`hoistMocks.ts:84` で `regexpHoistable.test(code)` を行い、`dynamicImportPlugin.ts:23` で `regexDynamicImport.test(source)` を行う。解析不要なファイルの処理コストをゼロに近づける。

```typescript
// packages/mocker/src/node/dynamicImportPlugin.ts:7,21-24
const regexDynamicImport = /import\s*\(/
// ...
transform(source, id) {
  if (!regexDynamicImport.test(source)) {
    return
  }
```

- **RefTracker による循環参照の安全な処理**: 再帰的なオブジェクト走査で循環参照を ID ベースで追跡し、遅延解決（finalizer パターン）で正しくリンクする。

```typescript
// packages/mocker/src/automocker.ts:95-101
const refId = refs.getId(value)
if (refId !== undefined) {
  finalizers.push(() =>
    define(newContainer, property, refs.getMockedValue(refId)),
  )
  continue
}
```

- **Discriminated Union によるモック種別管理**: `type` フィールドで 4 種のモックを区別し、`switch` や条件分岐で網羅的に処理。`satisfies never` による exhaustiveness check も適用されている。

## Anti-Patterns / 注意点

- **環境固有ロジックの共有コードへの混入**: `automock.ts:55-57` で `import.meta.resolve` と `readFileSync` を使うコードが Node.js 専用の `node/` ディレクトリに正しく配置されている。仮にこれが共有モジュールにあった場合、ブラウザ環境で壊れる。

```typescript
// Bad: 共有モジュールに環境固有コードを配置
// shared/automock.ts
import { readFileSync } from 'node:fs'  // ブラウザで壊れる

// Better: 環境固有ディレクトリに分離
// node/automock.ts (Node.js 専用)
import { readFileSync } from 'node:fs'  // OK
```

- **モック登録とインポートの競合状態**: `vi.mock()` はホイストされるが実行は非同期。動的インポートがモック登録完了前に走るとモックが適用されない。`wrapDynamicImport` による待機が必須。

```typescript
// Bad: モック登録前にインポートが実行される
vi.mock('./module')
const mod = await import('./module')  // モックが未登録の可能性

// Better: wrapDynamicImport でキューの完了を待機
const mod = await mocker.wrapDynamicImport(() => import('./module'))
```

## 導出ルール

- `[MUST]` AST ベースのコード変換では元コードの位置情報を保持する差分パッチ（MagicString 等）を使い、ソースマップを生成する
  - 根拠: `hoistMocks.ts` / `automock.ts` / `dynamicImportPlugin.ts` の全変換で `MagicString` + `generateMap({ hires: 'boundary' })` を使用し、デバッグ体験を維持している
- `[MUST]` 再帰的オブジェクト走査では循環参照を検出・追跡する仕組みを設ける
  - 根拠: `automocker.ts:183-201` の `RefTracker` が ID ベースの参照追跡と遅延解決で無限再帰を防止している
- `[SHOULD]` 重い AST 解析の前に正規表現で対象ファイルを事前フィルタリングする
  - 根拠: `hoistMocks.ts:84` と `dynamicImportPlugin.ts:23` で正規表現テストによる早期リターンが実装され、不要な解析を回避している
- `[SHOULD]` 環境差異を吸収するインターフェースはメソッド数を最小限（3-5個）に保つ
  - 根拠: `ModuleMockerInterceptor` は `register` / `delete` / `invalidate` の 3 メソッドのみで、MSW・ネイティブ・Node.js の 3 実装を統一している
- `[SHOULD]` 非同期リソース（モック登録等）に依存する処理は、リソースの準備完了を保証するラッパーを提供する
  - 根拠: `wrapDynamicImport` が `prepare()` の完了を待ってから動的インポートを実行し、登録とインポートの競合状態を防止している
- `[AVOID]` コード変換プラグインで AST 解析を条件なしに全ファイルに適用する
  - 根拠: `hoistMocksPlugin.ts:40-42` で `filter(id)` による除外と正規表現による事前チェックの二段構えで、無関係なファイルの解析を回避している

## 適用チェックリスト

- [ ] コード変換を行うツールで MagicString 等の差分パッチライブラリを使い、ソースマップを生成しているか
- [ ] AST 変換プラグインに正規表現ベースの事前フィルタリングを設けているか
- [ ] 再帰的なオブジェクト/グラフ走査に循環参照の検出・追跡機構があるか
- [ ] 複数環境（ブラウザ/Node/エッジ等）をサポートする場合、環境差異を最小インターフェースで抽象化しているか
- [ ] 環境固有コード（`fs`, `process` 等）が共有モジュールに混入していないか
- [ ] 非同期初期化に依存する処理で、初期化完了の待機メカニズムを提供しているか
- [ ] 判別共用体（discriminated union）で型の種別を管理し、網羅的な分岐処理を行っているか
