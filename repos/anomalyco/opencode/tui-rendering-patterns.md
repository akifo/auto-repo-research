# TUI レンダリングパターン

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

SolidJS のリアクティブプリミティブを opentui フレームワーク上で活用し、60fps のターミナル UI を構築するパターンを分析する。Web フロントエンド開発で培われた宣言的 UI・コンポーネント合成・状態管理のプラクティスがターミナル環境にどう適用されているかが注目に値する。SolidJS の fine-grained reactivity がターミナルレンダリングという制約の多い環境で、イベントバッチング・差分更新・レイヤード UI（ダイアログ・トースト）を効率的に実現している点が特に興味深い。

## 背景にある原則

- **コンテキスト階層による関心の分離**: TUI の状態を 15 以上の Provider に分割し、それぞれが独立した関心事を担う。SDK 通信・同期・テーマ・キーバインド・ルーティングなど、各 Provider は単一責任を持ち、ネストの順序が依存関係を表現する。これにより任意のコンポーネントから必要な状態にだけアクセスでき、不要な再レンダリングを防ぐ。根拠: `app.tsx:139-180` で 15 層の Provider がネストされ、依存順に並んでいる。

- **イベントバッチングによるレンダリング最適化**: ターミナルは Web ブラウザと異なりフレーム描画コストが高い。サーバーからのイベントストリームを 16ms 間隔でバッチ処理し、SolidJS の `batch()` で一括適用することで、1 フレーム内の複数ストア更新を 1 回のレンダリングに圧縮する。根拠: `context/sdk.tsx:42-62` のイベントキューイング実装。

- **宣言的 UI で命令的ターミナル制御を隠蔽する**: JSX で `<box>`, `<text>`, `<scrollbox>`, `<textarea>` などのプリミティブを組み合わせ、ANSI エスケープシーケンスやカーソル制御を完全に抽象化する。コンポーネント開発者はフレックスボックスレイアウトの感覚で TUI を構築でき、ターミナル固有の複雑さから解放される。根拠: `app.tsx:738-761`, `routes/home.tsx:94-143`。

- **状態の永続化と揮発の明確な分離**: KV ストア（`context/kv.tsx`）でユーザー設定を JSON ファイルに永続化し、`createStore` でセッション内のみの揮発的状態を管理する。どの状態がアプリ再起動後も維持されるか、どの状態がセッション内で消えるかが設計レベルで明確になっている。根拠: `context/kv.tsx` vs `context/route.tsx`。

## 実例と分析

### コンテキストファクトリパターン

`createSimpleContext` ヘルパーは、SolidJS の Context API のボイラープレートを排除し、一貫したパターンで Provider と Hook を生成する。`ready` プロパティによる条件付きレンダリングが組み込まれており、非同期初期化を透過的に扱える。

```typescript
// context/helper.tsx:3-25
export function createSimpleContext<T, Props extends Record<string, any>>(input: {
  name: string;
  init: ((input: Props) => T) | (() => T);
}) {
  const ctx = createContext<T>();
  return {
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props);
      return (
        // @ts-expect-error
        <Show when={init.ready === undefined || init.ready === true}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      );
    },
    use() {
      const value = useContext(ctx);
      if (!value) throw new Error(`${input.name} context must be used within a context provider`);
      return value;
    },
  };
}
```

このファクトリは Route, Keybind, Sync, Local, Theme, KV, Exit, SDK など全てのコンテキストで利用されている。`ready` ゲートにより、非同期データ（テーマファイル読み込み、ファイル I/O）が完了するまで子ツリーのレンダリングを遅延させる。

### イベントバッチングとフレームレート制御

サーバーイベント（メッセージ更新、セッション変更など）は高頻度で到着するが、毎回レンダリングするとフレーム落ちが発生する。SDK コンテキストではイベントをキューに溜め、16ms（約 60fps）間隔で `batch()` によりまとめてストアに反映する。

```typescript
// context/sdk.tsx:36-62
let queue: Event[] = [];
let timer: Timer | undefined;
let last = 0;

const flush = () => {
  if (queue.length === 0) return;
  const events = queue;
  queue = [];
  timer = undefined;
  last = Date.now();
  batch(() => {
    for (const event of events) {
      emitter.emit(event.type, event);
    }
  });
};

const handleEvent = (event: Event) => {
  queue.push(event);
  const elapsed = Date.now() - last;
  if (timer) return;
  if (elapsed < 16) {
    timer = setTimeout(flush, 16);
    return;
  }
  flush();
};
```

16ms 未満の間隔で到着するイベントはバッチされ、16ms 以上経過していればすぐに処理される。この適応的バッチング戦略は、低レイテンシとフレームレート安定の両立を実現する。

### 二段階ブートストラップによる初期表示の高速化

`context/sync.tsx` では、データ同期を「ブロッキングフェーズ」と「ノンブロッキングフェーズ」に分割している。UI 表示に必須のデータ（providers, agents, config）は先に取得して `partial` 状態で描画を開始し、残りのデータ（sessions, MCP, LSP 等）はバックグラウンドで取得して `complete` にする。

```typescript
// context/sync.tsx:349-427 (概要)
// blocking - UI表示に必須
const blockingRequests = [providersPromise, providerListPromise, agentsPromise, configPromise]
await Promise.all(blockingRequests)
// ...
setStore("status", "partial")  // ここでUIレンダリング開始

// non-blocking - バックグラウンドで追加データを取得
Promise.all([sessionListPromise, commandListPromise, lspPromise, mcpPromise, ...])
  .then(() => setStore("status", "complete"))
```

### ダイアログスタック管理

`ui/dialog.tsx` はダイアログをスタックとして管理し、`replace` で現在のスタックを置換、`clear` で全て閉じる。ESC/Ctrl+C でスタックの最上位を pop する。フォーカス管理も組み込まれており、ダイアログを開く前のフォーカス位置を記憶し、閉じたときに復元する。

```typescript
// ui/dialog.tsx:113-128
replace(input: any, onClose?: () => void) {
  if (store.stack.length === 0) {
    focus = renderer.currentFocusedRenderable
    focus?.blur()
  }
  for (const item of store.stack) {
    if (item.onClose) item.onClose()
  }
  setStore("stack", [{ element: input, onClose }])
},
```

ダイアログは `position="absolute"` でフルスクリーンオーバーレイとして描画され、半透明背景（`RGBA.fromInts(0, 0, 0, 150)`）でモーダル感を演出する。

### テーマシステムのレイヤード設計

テーマは JSON ファイルによる静的定義（30+ のビルトインテーマ）、`defs` による色の参照解決（変数のような仕組み）、dark/light のバリアント対応、カスタムテーマのファイルシステムからの動的読み込み、ターミナルパレットからのシステムテーマ自動生成を組み合わせた多層構造になっている。

```typescript
// context/theme.tsx:177-198
function resolveTheme(theme: ThemeJson, mode: "dark" | "light") {
  const defs = theme.defs ?? {};
  function resolveColor(c: ColorValue): RGBA {
    if (c instanceof RGBA) return c;
    if (typeof c === "string") {
      if (c.startsWith("#")) return RGBA.fromHex(c);
      if (defs[c] != null) return resolveColor(defs[c]);
      if (theme.theme[c as keyof ThemeColors] !== undefined) {
        return resolveColor(theme.theme[c as keyof ThemeColors]!);
      }
    }
    return resolveColor(c[mode]);
  }
  // ...
}
```

## パターンカタログ

- **Provider パターン** (分類: 構造)
  - 解決する問題: 深くネストされたコンポーネントへの状態の伝播
  - 適用条件: アプリ全体で共有する状態が複数の独立した関心事に分かれる場合
  - コード例: `app.tsx:139-180`, `context/helper.tsx:3-25`
  - 注意点: Provider の深いネストはデバッグを困難にする。`createSimpleContext` のようなファクトリで一貫性を担保する

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: サーバーイベントの UI への伝播
  - 適用条件: 外部のイベントストリームを UI の状態変更に変換する場合
  - コード例: `context/sdk.tsx:50-62`, `context/sync.tsx:107-343`
  - 注意点: 高頻度イベントはバッチ処理で制御する

- **Command パターン** (分類: 振る舞い)
  - 解決する問題: キーバインド・スラッシュコマンド・メニューからの操作を統一的に扱う
  - 適用条件: 同じアクションを複数の入力経路からトリガーできる場合
  - コード例: `app.tsx:361-660` の `command.register()`
  - 注意点: コマンドの `hidden` フラグでキーバインド専用コマンドを UI 一覧から除外できる

## Good Patterns

- **適応的イベントバッチング**: イベント到着間隔を監視し、16ms 以内なら次のフレームまでバッチ、それ以上経過していれば即時処理する。低レイテンシとフレームレート安定を両立する。コード: `context/sdk.tsx:50-62`

- **`ready` ゲート付きコンテキストファクトリ**: `createSimpleContext` が `ready` プロパティを監視し、非同期初期化完了まで子ツリーを遅延する。コンポーネント側は初期化状態を意識せずにコンテキストを使える。コード: `context/helper.tsx:14`

- **KV ストアによる UI 設定の永続化**: テーマ、サイドバー表示、アニメーション有効/無効などのユーザー設定を `kv.json` に永続化し、`createStore` の反応性と組み合わせる。`signal()` メソッドで SolidJS の signal API と互換のインターフェースを提供する。コード: `context/kv.tsx:31-41`

- **アニメーションの graceful degradation**: スピナーやアニメーションを KV 設定で無効化可能にし、`<Show when={kv.get("animations_enabled", true)} fallback={...}>` で静的表示にフォールバックする。コード: `component/spinner.tsx:15`

## Anti-Patterns / 注意点

- **Provider の過剰ネスト**: `app.tsx` では 15 層以上の Provider がネストされている。各 Provider が独立した関心事を持つのは良いが、新しい Provider を追加するたびにネストが深くなり、レンダリングツリーの理解が困難になる。

  Bad:
  ```tsx
  // 15層以上のネスト
  <A>
    <B>
      <C>
        <D>
          <E>
            <F>
              <G>
                <H>
                  <I>
                    <J>
                      <K>
                        <L>
                          <M>
                            <N>
                              <O>
                                <App />
                              </O>
                            </N>
                          </M>
                        </L>
                      </K>
                    </J>
                  </I>
                </H>
              </G>
            </F>
          </E>
        </D>
      </C>
    </B>
  </A>;
  ```

  Better:
  ```tsx
  // Provider を合成する関数で平坦化
  const providers = [A, B, C, D, E, F];
  function ComposeProviders({ children }) {
    return providers.reduceRight((acc, P) => <P>{acc}</P>, children);
  }
  ```

- **setTimeout ワークアラウンドの散在**: `component/prompt/index.tsx` には `// setTimeout is a workaround and needs to be addressed properly` というコメントが複数箇所にある（L103, L975, L989）。レイアウト更新のタイミング問題を setTimeout で回避しているが、タイミングに依存する不安定さを持つ。

  Bad:
  ```typescript
  setTimeout(() => {
    if (!input || input.isDestroyed) return;
    input.getLayoutNode().markDirty();
    renderer.requestRender();
  }, 0);
  ```

  Better: フレームワーク側に `requestLayoutUpdate()` のような同期的なレイアウト再計算 API を用意し、setTimeout に頼らない。

## 導出ルール

- `[MUST]` 高頻度イベントストリームを UI に反映する際は、フレームレート（16ms = 60fps）を基準にしたバッチ処理を実装する
  - 根拠: `context/sdk.tsx:50-62` で 16ms 間隔のバッチングにより、大量のサーバーイベントを安定したフレームレートで描画している

- `[SHOULD]` 複数の Provider/Context を使うアプリでは、コンテキスト生成のファクトリ関数を用意し、初期化・エラーハンドリング・`ready` ゲートのパターンを統一する
  - 根拠: `context/helper.tsx` の `createSimpleContext` が 10 以上のコンテキストで一貫したパターンを保証している

- `[SHOULD]` 非同期初期化を伴う UI では、データ取得をブロッキング（UI 表示に必須）とノンブロッキング（追加情報）に分割し、段階的にレンダリングを開始する
  - 根拠: `context/sync.tsx:349-427` で `loading` -> `partial` -> `complete` の 3 段階で初期表示を高速化している

- `[SHOULD]` ユーザーが制御可能な UI 設定（テーマ・アニメーション・レイアウト）には常にフォールバック表示を用意し、設定無効時もアプリが機能する graceful degradation を実現する
  - 根拠: `component/spinner.tsx:15` でアニメーション無効時に静的テキスト「...」にフォールバックしている

- `[AVOID]` レイアウト更新のタイミング問題を `setTimeout(fn, 0)` で回避すること。フレームワークが提供するレイアウトライフサイクル API を使うか、なければ明示的な再レンダリングリクエスト API を使う
  - 根拠: `component/prompt/index.tsx:103,975,989` に TODO コメント付きの setTimeout ワークアラウンドが散在し、潜在的な不安定さを生んでいる

- `[SHOULD]` モーダルダイアログはスタック構造で管理し、開く前のフォーカス位置を保存して閉じたときに復元する
  - 根拠: `ui/dialog.tsx:84-100,113-128` でフォーカスの保存・復元が実装され、キーボードナビゲーションの一貫性を維持している

## 適用チェックリスト

- [ ] 高頻度データ更新を UI に反映する箇所で、フレームレートに基づくイベントバッチングを実装しているか
- [ ] Context/Provider パターンを使っている場合、ファクトリ関数でボイラープレートと初期化パターンを統一しているか
- [ ] 非同期データの初期読み込みで、必須データと追加データを分離した段階的レンダリングを行っているか
- [ ] ユーザー設定（テーマ・アニメーション等）の無効化時に、適切なフォールバック表示を用意しているか
- [ ] モーダル UI のフォーカス管理（開く前の保存・閉じた後の復元）を実装しているか
- [ ] テーマシステムで dark/light モード対応と、デフォルトテーマへのフォールバックを提供しているか
- [ ] setTimeout ワークアラウンドを使っている箇所がないか。ある場合はフレームワーク API への置き換えを検討したか
