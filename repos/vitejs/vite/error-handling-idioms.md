# error-handling-idioms

> リポジトリ: vitejs/vite
> 分析日: 2026-02-17

## 概要

Vite のエラーハンドリングを横断分析し、エラーメッセージ設計・エラー境界・ユーザーフレンドリーなエラー表示の手法を抽出した。Vite はビルドツールという性質上、開発者体験（DX）に直結するエラー処理が極めて重要であり、「エラーが発生した箇所のコードフレームを生成して表示する」「エラーをブラウザオーバーレイとしてリアルタイムに表示する」「期待されるエラーとそうでないエラーを分離する」といった洗練されたパターンが随所に見られる。単なる例外処理にとどまらず、エラーの構造化・正規化・伝播経路の設計という観点で汎用的に応用できるプラクティスが多い。

## 背景にある原則

- **エラーは正規化してから伝播させるべき。異なるソースからのエラーは共通の構造に変換することで、下流の処理を統一できる**: Vite では PostCSS, esbuild, LightningCSS, Less, Sass など多様なツールが投げるエラーをすべて RollupError 互換の `{ message, loc, frame, plugin }` 構造に正規化してから再 throw している（`packages/vite/src/node/plugins/css.ts:2929-2940`, `packages/vite/src/node/plugins/esbuild.ts:256-274`）。
- **期待されるエラーと予期しないエラーは分離すべき。期待されるエラーをログに出さないことで、ノイズを減らし真の問題を見つけやすくする**: 依存関係の再最適化時に古いリクエストが失敗するのは正常フローであり、`ERR_OUTDATED_OPTIMIZED_DEP` や `ERR_CLOSED_SERVER` はログ出力せずに 504 を返すだけにしている（`packages/vite/src/node/server/middlewares/transform.ts:281-309`）。
- **エラーメッセージにはアクション可能な情報を含めるべき。問題の発生箇所だけでなく、解決方法のヒントを提示する**: `throwFileNotFoundInOptimizedDep` は「`optimizeDeps.exclude` に追加してみてください」と具体的な解決策を提示する（`packages/vite/src/node/plugins/optimizedDeps.ts:123-133`）。
- **エラー表示は多段フォールバックで設計すべき。メインのエラー表示手段が失敗しても、最低限の情報は必ずユーザーに届ける**: エラーオーバーレイの読み込み自体が失敗した場合に、素の HTML でエラー内容を表示するフォールバックがある（`packages/vite/src/node/server/middlewares/error.ts:89-98`）。

## 実例と分析

### エラーコードによるフロー制御

Vite は Node.js の慣習に倣い、`Error` オブジェクトに `.code` プロパティを付与して catch 側でエラーの種別を判定する。カスタムエラークラスを定義せず、プレーンな Error に code を設定する軽量なアプローチを採用している。

```typescript
// packages/vite/src/node/server/pluginContainer.ts:128-135
export const ERR_CLOSED_SERVER = "ERR_CLOSED_SERVER";

export function throwClosedServerError(): never {
  const err: any = new Error(
    "The server is being restarted or closed. Request is outdated",
  );
  err.code = ERR_CLOSED_SERVER;
  // This error will be caught by the transform middleware that will
  // send a 504 status code request timeout
  throw err;
}
```

catch 側では `.code` を比較してエラー種別ごとに異なる処理を行う。特にミドルウェアでは、エラーの種類に応じて HTTP ステータスコードやレスポンスを分岐する:

```typescript
// packages/vite/src/node/server/middlewares/transform.ts:269-338
} catch (e) {
  if (e?.code === ERR_OPTIMIZE_DEPS_PROCESSING_ERROR) {
    if (!res.writableEnded) {
      res.statusCode = 504
      res.statusMessage = 'Optimize Deps Processing Error'
      res.end()
    }
    server.config.logger.error(e.message)
    return
  }
  if (e?.code === ERR_OUTDATED_OPTIMIZED_DEP) {
    if (!res.writableEnded) {
      res.statusCode = 504
      res.statusMessage = 'Outdated Optimize Dep'
      res.end()
    }
    // ログ不要: 正常フローの一部
    return
  }
  // ...
  if (e?.code === ERR_LOAD_URL) {
    return next() // 他のミドルウェアに委譲
  }
  return next(e) // 未知のエラーは次のエラーハンドラへ
}
```

### エラーの構造化と正規化（prepareError パターン）

`prepareError` 関数はサーバー側の Error オブジェクトをクライアントに安全に送信できる構造に変換する。大きなオブジェクトを参照している可能性のあるエラー（PostCSS エラーなど）から必要最小限のプロパティだけを抽出する:

```typescript
// packages/vite/src/node/server/middlewares/error.ts:11-23
export function prepareError(err: Error | RollupError): ErrorPayload["err"] {
  // only copy the information we need and avoid serializing unnecessary
  // properties, since some errors may attach full objects (e.g. PostCSS)
  return {
    message: strip(err.message),
    stack: strip(cleanStack(err.stack || "")),
    id: (err as RollupError).id,
    frame: strip((err as RollupError).frame || ""),
    plugin: (err as RollupError).plugin,
    pluginCode: (err as RollupError).pluginCode?.toString(),
    loc: (err as RollupError).loc,
  };
}
```

### コードフレーム生成

`generateCodeFrame` はソースコードの該当位置を視覚的に示す機能で、コードベース全体から 15 箇所以上で使用されている。行番号付きのコードスニペットと `^` マーカーでエラー箇所を指す:

```typescript
// packages/vite/src/node/utils.ts:488-566
export function generateCodeFrame(
  source: string,
  start: number | Pos = 0,
  end?: number | Pos,
): string {
  // ...
  res.push(
    `${line}${" ".repeat(lineNumberWidth - String(line).length)}|  ${displayLine}`,
  );
  if (j === i) {
    const underline = "^".repeat(Math.min(underlineLength, MAX_DISPLAY_LEN));
    res.push(`${" ".repeat(lineNumberWidth)}|  ` + " ".repeat(underlinePad) + underline);
  }
  // ...
}
```

これを各プラグインが catch ブロック内で活用し、エラーに `.frame` を付与する:

```typescript
// packages/vite/src/node/plugins/css.ts:2271
e.frame = generateCodeFrame(css, e.loc);

// packages/vite/src/node/server/pluginContainer.ts:953
err.frame = err.frame || generateCodeFrame(this._activeCode, pos);
```

### ブラウザ側エラーオーバーレイ（Web Components）

エラーオーバーレイは `ErrorOverlay` というカスタム要素で実装されている。Shadow DOM を使うことで、ホストページのスタイルからの影響を完全に遮断している:

```typescript
// packages/vite/src/client/overlay.ts:216-298
export class ErrorOverlay extends HTMLElement {
  root: ShadowRoot;
  closeOnEsc: (e: KeyboardEvent) => void;

  constructor(err: ErrorPayload["err"], links = true) {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.appendChild(createTemplate());
    // plugin 名、メッセージ、ファイルパス、コードフレーム、スタックを構造化表示
    if (err.plugin) {
      this.text(".plugin", `[plugin:${err.plugin}] `);
    }
    this.text(".message-body", message.trim());
    // ファイルパスをクリック可能なリンクに変換し、エディタで開く機能を提供
    // ...
  }
  close(): void {
    this.parentNode?.removeChild(this);
    document.removeEventListener("keydown", this.closeOnEsc);
  }
}
```

### 多段フォールバックのエラー表示

エラーミドルウェアは、エラーオーバーレイの読み込み自体が失敗する可能性を考慮し、素の HTML によるフォールバック表示を備えている:

```typescript
// packages/vite/src/node/server/middlewares/error.ts:86-98
try {
  const { ErrorOverlay } = await import(); /* client path */
  document.body.appendChild(new ErrorOverlay(error));
} catch {
  const h = (tag, text) => {
    const el = document.createElement(tag);
    el.textContent = text;
    return el;
  };
  document.body.appendChild(h("h1", "Internal Server Error"));
  document.body.appendChild(h("h2", error.message));
  document.body.appendChild(h("pre", error.stack));
  document.body.appendChild(h("p", "(Error overlay failed to load)"));
}
```

### SSR スタックトレースの修正

ソースマップを使って変換後のコードのスタックトレースを元のソースコードの位置に復元する。一度修正したエラーを再度修正しないよう `WeakSet` で追跡している:

```typescript
// packages/vite/src/node/ssr/ssrStacktrace.ts:92-113
const rewroteStacktraces = new WeakSet();

export function ssrFixStacktrace(
  e: Error,
  moduleGraph: EnvironmentModuleGraph,
): void {
  if (!e.stack) return;
  if (rewroteStacktraces.has(e)) return;
  const { result: stacktrace, alreadyRewritten } = ssrRewriteStacktrace(
    e.stack,
    moduleGraph,
  );
  rebindErrorStacktrace(e, stacktrace);
  if (alreadyRewritten) {
    e.message += " (The stacktrace appears to be already rewritten...)";
  }
  rewroteStacktraces.add(e);
}
```

### ログ重複防止（warnOnce / hasErrorLogged）

ロガーは `warnOnce` メソッドと `hasErrorLogged` メソッドを提供し、同一メッセージやエラーの重複出力を防ぐ:

```typescript
// packages/vite/src/node/logger.ts:76,134,145-149,160-162
const loggedErrors = new WeakSet<Error | RollupError>()
const warnedMessages = new Set<string>()

warnOnce(msg, opts) {
  if (warnedMessages.has(msg)) return
  logger.hasWarned = true
  output('warn', msg, opts)
  warnedMessages.add(msg)
},
hasErrorLogged(error) {
  return loggedErrors.has(error)
},
```

### エラーメッセージへのコンテキスト付与

各ツール（PostCSS, esbuild, LightningCSS, Less）からのエラーにはツール名のプレフィックスを付与し、どのプロセッサーで問題が発生したか即座にわかるようにしている:

```typescript
// packages/vite/src/node/plugins/css.ts:1757
e.message = `[postcss] ${e.message}`;

// packages/vite/src/node/plugins/css.ts:2224
e.message = "[esbuild css minify] " + e.message;

// packages/vite/src/node/plugins/css.ts:2260
e.message = `[lightningcss] ${e.message}`;
```

## パターンカタログ

- **Chain of Responsibility** (振る舞い)
  - 解決する問題: HTTP エラーレスポンスの分岐をスケーラブルに行う
  - 適用条件: エラーコードごとに異なる処理が必要な場合
  - コード例: `packages/vite/src/node/server/middlewares/transform.ts:269-338`
  - 注意点: エラーコードの列挙漏れがあると `next(e)` にフォールスルーするため、最後に必ずデフォルトハンドラを用意する

- **Mediator** (振る舞い)
  - 解決する問題: サーバー/クライアント間のエラー伝達を仲介する
  - 適用条件: サーバーサイドのエラーをリアルタイムにクライアントに伝えたい場合
  - コード例: `packages/vite/src/node/server/middlewares/error.ts:45-59` の `logError` 関数（ロガー出力 + HMR チャネルへの送信を同時に行う）
  - 注意点: クライアント送信時にシリアライズ可能な形式への変換（`prepareError`）が必須

## Good Patterns

- **エラーコード定数パターン**: カスタムエラークラスを定義せず、プレーンな Error に文字列定数の `.code` を付与する。TypeScript の型安全性は `any` キャストで妥協するが、シンプルさと Node.js 標準との一貫性を優先している。定数は export されるため catch 側で型安全に比較できる。

```typescript
// packages/vite/src/node/server/transformRequest.ts:39-41
export const ERR_LOAD_URL = "ERR_LOAD_URL";
export const ERR_LOAD_PUBLIC_URL = "ERR_LOAD_PUBLIC_URL";
export const ERR_DENIED_ID = "ERR_DENIED_ID";
```

- **アクション可能なエラーメッセージ**: エラーメッセージに問題の説明だけでなく、解決策のヒントを含める。

```typescript
// packages/vite/src/node/plugins/optimizedDeps.ts:123-133
const err: any = new Error(
  `The file does not exist at "${id}" which is in the optimize deps directory. `
    + `The dependency might be incompatible with the dep optimizer. `
    + `Try adding it to \`optimizeDeps.exclude\`.`,
);
```

- **構造化エラーの正規化**: 異なるソースからのエラーを共通構造に変換してから伝播させる。CSS プリプロセッサの catch ブロックでは、ツール固有のエラーフォーマットを `{ message, loc, frame }` に正規化する。

```typescript
// packages/vite/src/node/plugins/css.ts:2929-2940
const normalizedError: RollupError = new Error(
  `[less] ${error.message || error.type}`,
) as RollupError;
normalizedError.loc = {
  file: error.filename || options.filename,
  line: error.line,
  column: error.column,
};
```

## Anti-Patterns / 注意点

- **`any` キャストによる型安全性の喪失**: `.code` プロパティを追加するために `const err: any = new Error(...)` としている箇所が多い。これは Node.js 標準との一貫性のためだが、型チェックが効かなくなるリスクがある。

```typescript
// Bad: any キャストが必要になる
const err: any = new Error("message");
err.code = ERR_SOME_ERROR;

// Better: 型付きのヘルパー関数で生成する
interface CodedError extends Error {
  code: string;
}
function createCodedError(message: string, code: string): CodedError {
  const err = new Error(message) as CodedError;
  err.code = code;
  return err;
}
```

- **catch ブロック内でのエラーオブジェクト直接変異**: 複数の catch ブロックで `e.message = ...` のようにエラーオブジェクトを直接変異させている。元のエラー情報が上書きされるため、デバッグ時に原因を追いにくくなる可能性がある。

```typescript
// Bad: 元のメッセージが失われる
e.message = `[postcss] ${e.message}`;

// Better: 新しいエラーで元をラップする（ただしスタック情報の保持に注意）
const wrapped = new Error(`[postcss] ${e.message}`);
wrapped.cause = e;
throw wrapped;
```

ただし Vite の場合、`e.frame` や `e.loc` を付与して `prepareError` 経由でクライアントに送る設計のため、同一オブジェクトの変異が意図的な選択である点に留意する。

## 導出ルール

- `[MUST]` エラーメッセージには「何が起きたか」だけでなく「どうすればよいか」のヒントを含める
  - 根拠: `throwFileNotFoundInOptimizedDep` は問題の説明に加え `Try adding it to optimizeDeps.exclude` と解決策を提示しており、ユーザーが自力で問題を解決できる設計になっている（`packages/vite/src/node/plugins/optimizedDeps.ts:123-133`）
- `[MUST]` ユーザー向けのエラー表示では、表示機構自体の失敗に備えたフォールバックを用意する
  - 根拠: エラーオーバーレイのロード失敗時に素の HTML でエラー情報を表示するフォールバックが実装されている（`packages/vite/src/node/server/middlewares/error.ts:89-98`）
- `[SHOULD]` 複数の外部ツールからのエラーは共通の構造（`{ message, loc, frame }` 等）に正規化してから伝播させる
  - 根拠: PostCSS, esbuild, LightningCSS, Less の各エラーを RollupError 互換構造に変換し、`buildErrorMessage` や `prepareError` で統一的に処理している
- `[SHOULD]` エラーメッセージにはソースツールのプレフィックスを付与する（例: `[postcss]`, `[lightningcss]`）
  - 根拠: パイプライン上のどのステージでエラーが発生したかを即座に特定できるようにするため、CSS プラグイン内で一貫してプレフィックスを付与している（`packages/vite/src/node/plugins/css.ts:1757,2224,2260`）
- `[SHOULD]` 正常フローの一部として期待されるエラー（再最適化時の古いリクエストなど）はログ出力を抑制する
  - 根拠: `ERR_OUTDATED_OPTIMIZED_DEP` 発生時にログを出さず 504 を返すだけにすることで、開発者に不要なノイズを与えない設計としている（`packages/vite/src/node/server/middlewares/transform.ts:281-294`）
- `[SHOULD]` パース系エラーにはコードフレーム（行番号付きのコード抜粋と `^` マーカー）を付与する
  - 根拠: `generateCodeFrame` がコードベース全体で 15 箇所以上使われており、構文エラーの位置を視覚的に示すことで問題の特定速度を大幅に向上させている
- `[AVOID]` シリアライズ時にエラーオブジェクトをそのまま JSON 化する。巨大な参照を持つエラーがメモリリークやパフォーマンス問題を引き起こす
  - 根拠: `prepareError` は「only copy the information we need and avoid serializing unnecessary properties, since some errors may attach full objects (e.g. PostCSS)」と明記し、必要最小限のプロパティだけを抽出している（`packages/vite/src/node/server/middlewares/error.ts:12-13`）

## 適用チェックリスト

- [ ] エラーメッセージに解決策のヒント（"Try ...", "Did you mean ..." 等）を含めているか
- [ ] 異なる外部ツールからのエラーを共通構造に正規化するレイヤーがあるか
- [ ] パース/コンパイルエラーにコードフレーム（行番号 + `^` マーカー）を付与しているか
- [ ] エラーをネットワーク越しに送信する際、必要最小限のプロパティだけを抽出しているか
- [ ] 正常フローの一部として予期されるエラーを識別し、ログ出力を抑制しているか
- [ ] ユーザー向けエラー表示のフォールバック（表示機構自体の失敗への備え）があるか
- [ ] 同一エラーの重複ログ出力を防ぐ仕組み（`warnOnce` / `WeakSet` 等）があるか
- [ ] エラーメッセージにソースツール/ステージのプレフィックスを付与して発生箇所を明示しているか
