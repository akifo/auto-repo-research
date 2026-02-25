# pattern: exclusive-block-safe-rethrow

> 出典: [repos/cloudflare/partykit](../repos/cloudflare/partykit/)
> カテゴリ: pattern

## 概要

排他制御ブロック（mutex, `blockConcurrencyWhile`, ロックスコープ等）内でエラーが発生した場合、ブロック内でキャッチして状態をリセットし、ブロック外で再スローするパターン。排他ブロック内で例外が直接スローされると、ロック解放やゲート開放の後処理が正しく行われず、後続の全処理が永久にブロックされるデッドロックを引き起こす。このパターンは「エラー変数への退避 -> 状態リセット -> ブロック正常完了 -> ブロック外再スロー」という4ステップでデッドロックを防止しつつ、エラー情報を呼び出し元に伝播させる。

## 背景・文脈

Cloudflare Durable Objects では `blockConcurrencyWhile` API が排他制御を提供する。このAPIのコールバック内で例外がスローされると、Durable Object の input gate がデッドロック状態に陥り、後続の全リクエスト（HTTP, WebSocket, Alarm）が永久にブロックされる。

PartyKit（cloudflare/partykit）の `partyserver` パッケージでは、Server クラスの初期化処理 `#ensureInitialized` がこの排他ブロックを使用している。`onStart` フックはユーザー定義コードを実行するため、任意のエラーがスローされる可能性がある。単純に `blockConcurrencyWhile` 内でエラーをスローすると、一度の初期化失敗で Durable Object 全体が使用不能になる。

このパターンは Durable Objects に限定されない。mutex ロック、データベーストランザクション、ファイルロック、分散ロックなど、あらゆる排他制御ブロックで同様の問題が発生しうる。排他ブロックの実装がコールバック内の例外を適切にハンドリングしない場合や、例外発生時にロック解放のタイミングが不定になる場合に、このパターンが有効である。

## 実装パターン

パターンの構成要素は4つ:

1. **エラー変数の宣言**: 排他ブロックの外側で `let error: unknown` を宣言する
2. **ブロック内 try-catch**: 排他ブロック内で本来の処理を try-catch で包む
3. **状態リセット + エラー退避**: catch 内で状態を初期値にリセットし、エラーを変数に退避する
4. **ブロック外再スロー**: 排他ブロック完了後にエラー変数をチェックし、存在すれば再スローする

```typescript
// packages/partyserver/src/index.ts:547-563
async #ensureInitialized(): Promise<void> {
  if (this.#status === "started") return;
  await this.#hydrateNameFromStorage();
  let error: unknown;
  await this.ctx.blockConcurrencyWhile(async () => {
    this.#status = "starting";
    try {
      await this.onStart(this.#_props);
      this.#status = "started";
    } catch (e) {
      this.#status = "zero";
      error = e;
    }
  });
  // Re-throw outside blockConcurrencyWhile so the DO's input gate
  // isn't permanently broken, allowing subsequent requests to retry.
  if (error) throw error;
}
```

状態遷移は `"zero" -> "starting" -> "started"` の三段階で管理される。成功すれば `"started"` に遷移して以降の呼び出しは早期リターンし、失敗すれば `"zero"` にリセットされて次のリクエストで再試行が可能になる。

この `#ensureInitialized` は Server クラスの全エントリポイント（`fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`, `alarm`）から呼び出され、どの経路からアクセスされても初期化が保証される。

## Good Example

排他ブロック内でエラーをキャッチし、状態をリセットしてからブロック外で再スローする。後続リクエストはリトライ可能。

```typescript
// packages/partyserver/src/index.ts:550-563
let error: unknown;
await this.ctx.blockConcurrencyWhile(async () => {
  this.#status = "starting";
  try {
    await this.onStart(this.#_props);
    this.#status = "started";
  } catch (e) {
    this.#status = "zero";
    error = e;
  }
});
if (error) throw error;
```

テストでは `FailingOnStartServer` がこのリトライ動作を明示的に検証している。1回目の `onStart` は意図的に失敗し、2回目で成功する:

```typescript
// packages/partyserver/src/tests/worker.ts:350-368
export class FailingOnStartServer extends Server {
  counter = 0;
  failCount = 0;

  async onStart() {
    this.counter++;
    if (this.counter === 1) {
      this.failCount++;
      throw new Error("onStart failed on first attempt");
    }
  }

  onRequest(): Response {
    return Response.json({
      counter: this.counter,
      failCount: this.failCount,
    });
  }
}
```

## Bad Example

排他ブロック内で直接エラーをスローする。input gate がデッドロックし、後続の全リクエストが永久にブロックされる。

```typescript
// Bad: blockConcurrencyWhile 内で直接スロー
await this.ctx.blockConcurrencyWhile(async () => {
  this.#status = "starting";
  await this.onStart(this.#_props); // ここでスローすると input gate が壊れる
  this.#status = "started";
});
// -> onStart が失敗した場合:
//    1. input gate がデッドロック状態になる
//    2. #status が "starting" のまま固定される
//    3. 後続の全リクエストが永久にブロックされる
//    4. Durable Object を再起動するまで復旧不可能
```

状態リセットなしの再スローも不十分:

```typescript
// Bad: エラーは外で再スローしているが、状態リセットがない
let error: unknown;
await this.ctx.blockConcurrencyWhile(async () => {
  this.#status = "starting";
  try {
    await this.onStart(this.#_props);
    this.#status = "started";
  } catch (e) {
    // #status が "starting" のまま -- リトライ時に再初期化されない
    error = e;
  }
});
if (error) throw error;
// -> input gate のデッドロックは防げるが、
//    #status === "starting" のため次のリクエストでの挙動が不定
```

## 適用ガイド

### どのような状況で使うべきか

- **プラットフォーム提供の排他制御 API を使用する場合**: `blockConcurrencyWhile`、`navigator.locks.request`、分散ロック API など、コールバック内の例外ハンドリングがプラットフォーム依存で不透明な場合
- **排他ブロック内でユーザー定義コードを実行する場合**: フレームワークの初期化フック、プラグインのコールバック、ユーザー提供の関数など、任意のエラーがスローされうる処理を排他ブロック内で実行する場合
- **失敗後のリトライが必要な場合**: 初期化処理、接続確立、リソース獲得など、一時的な失敗から回復可能であり、次の試行で成功する可能性がある処理
- **mutex ロックのスコープ管理**: 手動でロック取得・解放を行う mutex で、try-catch-finally のエラーパスでロック解放が漏れる可能性がある場合

### 導入時の注意点

- **状態リセットは必須**: エラー退避だけでなく、排他ブロック内で変更した状態を初期値にリセットすることが重要。リセットがないと次の試行で不整合な状態から開始される
- **エラー型は `unknown`**: TypeScript では catch されたエラーの型は `unknown` であるため、退避変数も `unknown` 型で宣言する。`Error` 型に限定しない
- **排他ブロック内の副作用に注意**: データベース書き込みや外部 API 呼び出しなど、ロールバックが必要な副作用がブロック内にある場合は、状態リセットだけでなく副作用の取り消しも必要
- **全エントリポイントからの初期化保証**: partyserver のように排他ブロックを初期化に使う場合、全てのエントリポイント（HTTP, WebSocket, Alarm 等）から初期化メソッドを呼び出し、どの経路からアクセスされても一貫した状態を保証する

### カスタマイズポイント

- **状態マシンの粒度**: partyserver は3状態（`zero` / `starting` / `started`）だが、より複雑な初期化では中間状態を追加できる。ただし状態が増えるほどリセット先の選択が難しくなる
- **リトライ制限**: partyserver は無制限のリトライを許容しているが、失敗回数のカウンタを追加して上限を設けることもできる
- **エラーロギング**: catch ブロック内でエラーをログに記録してからリセット・退避することで、デバッグ情報を失わずに済む
- **部分的リセット**: 初期化が複数ステップで構成される場合、失敗したステップに応じて部分的にリセットし、成功済みのステップを再実行しない最適化が可能

### mutex / ロックライブラリへの応用

このパターンは `blockConcurrencyWhile` に限らず、任意のロック機構に適用できる:

```typescript
// async-mutex ライブラリでの応用例
import { Mutex } from "async-mutex";

const mutex = new Mutex();
let initState: "idle" | "running" | "done" = "idle";

async function ensureInit(): Promise<void> {
  if (initState === "done") return;
  let error: unknown;
  await mutex.runExclusive(async () => {
    if (initState === "done") return; // 二重チェック
    initState = "running";
    try {
      await performInit();
      initState = "done";
    } catch (e) {
      initState = "idle";
      error = e;
    }
  });
  if (error) throw error;
}
```

## 参考

- [repos/cloudflare/partykit/concurrency-patterns.md](../repos/cloudflare/partykit/concurrency-patterns.md) -- `blockConcurrencyWhile` による初期化排他制御、Hibernation サイクル、バッチ化パターンの分析
- [repos/cloudflare/partykit/error-handling-idioms.md](../repos/cloudflare/partykit/error-handling-idioms.md) -- input gate デッドロック回避、WebSocket エラー伝播、fire-and-forget エラー封じ込めの分析
- [repos/cloudflare/partykit/hook-and-lifecycle-patterns.md](../repos/cloudflare/partykit/hook-and-lifecycle-patterns.md) -- 三状態マシンによる初期化保証、Template Method パターン、Mixin パターンの分析
