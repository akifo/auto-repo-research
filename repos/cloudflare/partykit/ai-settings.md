# AI 設定戦略

> リポジトリ: cloudflare/partykit
> 分析日: 2026-02-25

## 概要

cloudflare/partykit は単一の `AGENTS.md`（196行）でモノレポ全体の AI コーディングエージェント向けガイドラインを提供している。Repository Structure、Build Commands、Code Style、Testing、Git & Versioning、Package Publishing、Performance Notes、Common Patterns という8セクション構成で、「AI が初見のモノレポで即座にコードを書ける」ために必要な情報を過不足なく網羅している。特に注目すべきは、コードスタイルのセクションがツール固有の設定ファイル（`.oxfmtrc.json`, `.oxlintrc.json`）の内容を冗長に複製するのではなく、AI が判断に迷う箇所のみを人間の言葉で補足している点である。

## 背景にある原則

- **単一ファイル・フラット構造の原則**: AI エージェントはコンテキストウィンドウに制約があり、複数ファイルを辿るほどコンテキストが希薄化する。partykit はルートに1ファイルだけ置き、AI が1回の読み込みで全体像を把握できる設計にしている。これは cloudflare/agents の6階層 AGENTS.md とは対照的なアプローチだが、パッケージ数が限定的なモノレポ（約10パッケージ）では、単一ファイルのほうがコンテキストの密度が高くなる。リポジトリの規模に応じてファイル分割戦略を変えるべきである。

- **コマンド中心主義（Command-First Documentation）**: AGENTS.md は設計思想や概念の説明を極力避け、「何を実行すれば何が起きるか」をコマンド例で示している。`npm run build`, `npm run check`, `npx vitest src/tests/reconnecting.test.ts` などの具体的なコマンドが先頭近くに配置されている（`AGENTS.md:20-54`）。AI にとって最も即座に行動へ移せる情報はコマンドであり、概念説明は実行後に必要になった時点で参照すれば十分、という判断に基づく。

- **設定ファイルの「意図」を補完する**: `.oxfmtrc.json` や `.oxlintrc.json` は機械可読だが「なぜその設定か」は読み取れない。AGENTS.md は `no-explicit-any: off` の設定を記載した上で、`^_` プレフィックスによる unused vars の除外パターン（`AGENTS.md:74`）のように、設定値の背景にある意図を言語化している。AI が linter 違反を修正する際、ルールを無効化すべきか、コードを修正すべきかの判断材料になる。

- **Common Patterns セクションによるイディオム伝達**: AGENTS.md 末尾の「Common Patterns」（`AGENTS.md:189-196`）は、リポジトリ横断で繰り返し使われるイディオムを5項目にまとめている。これにより AI は新しいコードを書く際に「このリポジトリではどのパターンが好まれるか」を知ることができる。パターンの羅列は少ないが、各パターンがコードベース全体で一貫して使われていることが検証可能である。

## 実例と分析

### セクション構成の情報密度

AGENTS.md の196行は以下のように配分されている。

| セクション                   | 行数 | 割合 | 内容                                                                                    |
| ---------------------------- | ---- | ---- | --------------------------------------------------------------------------------------- |
| Repository Structure         | 8行  | 4%   | パッケージ一覧と1行説明                                                                 |
| Build & Development Commands | 25行 | 13%  | ルート・パッケージレベルのコマンド例                                                    |
| Running tests                | 13行 | 7%   | テスト実行のバリエーション                                                              |
| Code Style Guidelines        | 70行 | 36%  | Formatting, Linting, TypeScript, Import, Naming, Error Handling, Comments, Organization |
| Testing Guidelines           | 6行  | 3%   | Vitest 設定の要点                                                                       |
| Git & Versioning             | 5行  | 3%   | Changesets の言及                                                                       |
| Package Publishing           | 5行  | 3%   | デュアルフォーマットとビルドツール                                                      |
| Performance Notes            | 5行  | 3%   | 最適化ガイドライン                                                                      |
| Common Patterns              | 6行  | 3%   | リポジトリ固有のイディオム                                                              |

コードスタイルが36%を占めており、AI がコードを「書く」際に最も判断を要する領域に集中投資していることが分かる。対照的に Git & Versioning や Package Publishing は最小限で、AI が直接関わる頻度の低い領域は圧縮されている。

### 設定ファイルとの対応関係の検証

AGENTS.md の記述が実際の設定ファイルと整合しているか検証した。

**Formatting（`.oxfmtrc.json`）**:
AGENTS.md は「Double quotes, No trailing commas, Print width 80」と記載（`AGENTS.md:62-63`）。実際の設定は `trailingComma: "none"`, `printWidth: 80` であり一致する。ただし quote style は `.oxfmtrc.json` にはなく、oxfmt のデフォルト動作に依存している。AGENTS.md がデフォルト値を明示しているのは、AI がデフォルトを知らない前提での補足として適切。

**Linting（`.oxlintrc.json`）**:
AGENTS.md は key rules として `no-explicit-any: off`, `no-non-null-assertion: off`, `no-redeclare: off` を挙げている（`AGENTS.md:71-74`）。実際の `.oxlintrc.json` にはさらに `no-unused-expressions: off`, `no-this-alias: off`, `jsx-a11y/no-autofocus: off` もあるが、AGENTS.md はこれらを省略している。AI が最も遭遇しやすいルール（any 型、non-null assertion）のみを選択的に記載する判断。

**TypeScript（`tsconfig.base.json`）**:
AGENTS.md は6項目の TypeScript 設定を列挙（`AGENTS.md:80-87`）。`tsconfig.base.json` と照合すると全て一致。特に `verbatimModuleSyntax: true`（`tsconfig.base.json:80`）と `isolatedModules: true`（`tsconfig.base.json:79`）は import/export の書き方に直接影響するため、AI への明示が重要。

### Common Patterns とコードベースの照合

AGENTS.md に記載された5つの Common Patterns を実際のコードで検証した。

**1. EventTarget for event handling**:
`packages/partysocket/src/ws.ts:149` で `ReconnectingWebSocket` が `EventTarget` を継承。サーバー側の `packages/partyserver/src/index.ts:591` でも `connection.addEventListener` パターンを使用。ブラウザ/Node 両対応のために EventTarget を選択しており、AGENTS.md の記述と完全に一致。

**2. Clone events when re-dispatching**:
`packages/partysocket/src/ws.ts:65-107` で `cloneEventBrowser` と `cloneEventNode` の2つのイベントクローン関数を定義。Node/ReactNative 環境では `new MessageEvent(e.type, e)` で再構築し、ブラウザでは `new (e as any).constructor(e.type, e)` を使用。この区別は実行環境固有の制約に対応するものであり、AGENTS.md の1行では伝わらない複雑さがある。

**3. Exponential backoff for reconnection**:
`packages/partysocket/src/ws.ts:370-387` の `_getNextDelay` メソッドと、`packages/partytracks/src/client/rxjs-helpers.ts:21-51` の `retryWithBackoff` 関数で独立に実装。前者は手動計算（`minReconnectionDelay * growFactor ** (retryCount - 1)`）、後者は RxJS の `retry` オペレータを使用。同じパターンが複数パッケージで異なる実装で現れている。

**4. Both callback and event listener APIs**:
`packages/partysocket/src/ws.ts:566-608` で `this.onopen?.(event)` を呼んだ後に `this.dispatchEvent(cloneEvent(event))` を実行。callback API（`onopen`, `onmessage` 等）と EventTarget API（`addEventListener`）を両方サポートし、WebSocket 標準 API との互換性を維持している。

**5. Support both string and function-based configuration**:
`packages/partysocket/src/ws.ts:424-442` の `_getNextUrl` と `_getNextProtocols` で、引数が `string | () => string | () => Promise<string>` のいずれかを受け付ける。`packages/partysocket/src/index.ts:22` の `query` オプションでも同様。

### ローカルパスのハードコードという特徴

AGENTS.md のルートコマンドセクションに `/Users/sunilpai/code/partyserver` というローカルパスがハードコードされている（`AGENTS.md:22`）。これは個人の開発環境のパスが残ったものであり、AI にとっては無害だが、チーム開発時のベストプラクティスとしては相対パスまたはプレースホルダを使うべき。

## コード例

### イベントクローンと dual API パターン

```typescript
// packages/partysocket/src/ws.ts:549-569
private _handleOpen = (event: Event) => {
    this._debug("open event");
    const { minUptime = DEFAULT.minUptime } = this._options;

    clearTimeout(this._connectTimeout);
    this._uptimeTimeout = setTimeout(() => this._acceptOpen(), minUptime);

    assert(this._ws, "WebSocket is not defined");

    this._ws.binaryType = this._binaryType;

    // send enqueued messages (messages sent before websocket open event)
    this._messageQueue.forEach((message) => {
      this._ws?.send(message);
    });
    this._messageQueue = [];

    if (this.onopen) {
      this.onopen(event);      // callback API
    }
    this.dispatchEvent(cloneEvent(event));  // EventTarget API
  };
```

### oxlint-disable と @ts-expect-error の使い分け

```typescript
// packages/partyserver/src/index.ts:667-670
// oxlint-disable-next-line no-unused-vars — インターフェース定義のためのパラメータ
getConnectionTags(
    connection: Connection,
    context: ConnectionContext
): string[] | Promise<string[]> {

// packages/partysocket/src/ws.ts:78-80
// @ts-expect-error we need to fix event/listener types — 型の不一致を明示的に抑制
(e.code || 1999) as number,
// @ts-expect-error we need to fix event/listener types
(e.reason || "unknown reason") as string,
```

### 指数バックオフの再利用可能な実装

```typescript
// packages/partytracks/src/client/rxjs-helpers.ts:21-51
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
          const delay = Math.min(
            initialDelay * backoffFactor ** (count - 1),
            maxDelay,
          );
          return timer(delay);
        },
      }),
    );
}
```

## パターンカタログ

- **Observer パターン** (分類: 振る舞い)
  - 解決する問題: WebSocket イベントを複数のリスナーに通知する
  - 適用条件: EventTarget と callback API の両方をサポートする必要がある場合
  - コード例: `packages/partysocket/src/ws.ts:149` — `ReconnectingWebSocket extends EventTarget`
  - 注意点: イベントの再ディスパッチ時はクローンが必須（同じイベントオブジェクトを再利用すると `already dispatched` エラー）

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 実行環境（Node / Browser / ReactNative）に応じてイベントクローン戦略を切り替える
  - 適用条件: クロスプラットフォームで同一 API を提供する場合
  - コード例: `packages/partysocket/src/ws.ts:96-107` — `const cloneEvent = isNode || isReactNative ? cloneEventNode : cloneEventBrowser`
  - 注意点: 環境判定は `typeof process` や `navigator.product` に依存しており、新しいランタイム追加時に更新が必要

## Good Patterns

- **設定ファイルの要約と意図の補足**: AGENTS.md は `.oxlintrc.json` の全ルールを転記するのではなく、AI が最も遭遇するルール（`no-explicit-any: off` 等）のみを選択的に記載し、なぜオフにしているかの文脈を添えている。これにより AI は「linter を黙らせるべきか、コードを直すべきか」を判断できる。

```markdown
<!-- AGENTS.md:68-76 の構造 -->

### Linting

- **Linter**: Oxlint (configured in `.oxlintrc.json`)
- Key rules:
  - `no-explicit-any`: off
  - `no-unused-vars`: error (with `^_` ignore patterns for args/vars/caught)
```

- **コマンド例をコピペ可能な形式で提供**: ルートレベルとパッケージレベルの両方のコマンドをコードブロックで提示し、テスト実行には4つのバリエーション（全テスト、単一ファイル、ウォッチモード、パターンマッチ）を示している。

```bash
# AGENTS.md:43-54 のテスト実行例
cd packages/partysocket && npm run check:test  # 全テスト
npx vitest src/tests/reconnecting.test.ts       # 単一ファイル
npx vitest --watch                              # ウォッチモード
npx vitest reconnecting                         # パターンマッチ
```

- **Common Patterns セクションの実用性**: 5項目のパターンリストは簡潔だが、各パターンがコードベースの複数箇所で一貫して使われていることが検証できる。新しいコードを書く AI にとって「このリポジトリでは EventTarget を使う」「callback と addEventListener の両方を提供する」という指針は即座に適用可能。

## Anti-Patterns / 注意点

- **ローカルパスのハードコード**: AGENTS.md にメンテナの個人ローカルパスが含まれている。AI は無視するが、チームメンバーには混乱を招く。

```markdown
<!-- Bad: AGENTS.md:22 -->

### Root-level commands (from `/Users/sunilpai/code/partyserver`)

<!-- Better -->

### Root-level commands (from repository root)
```

- **@ts-expect-error の理由が曖昧**: コードベースの一部では理由説明が不十分な `@ts-expect-error` が散見される。AGENTS.md は「Use `@ts-expect-error` with explanations when necessary」と推奨しているが、実際のコードとの乖離がある。

```typescript
// Bad: packages/partywhen/src/index.ts:377
// @ts-expect-error yeah whatever

// Better: packages/partysocket/src/ws.ts:78
// @ts-expect-error we need to fix event/listener types
```

- **テストガイドラインの薄さ**: Testing Guidelines は6行で、Vitest の基本的な設定のみ記載。実際のテストコードでは `describe.skipIf(!!process.env.GITHUB_ACTIONS)` のような CI 固有の分岐（`packages/partysocket/src/tests/error-handling.test.ts:10`）や、`@vitest-environment` ディレクティブの使い分けが重要だが、AGENTS.md ではディレクティブの存在を1行で言及するにとどまる。

## 導出ルール

- `[MUST]` AGENTS.md / CLAUDE.md にはコピペ可能なコマンド例をビルド・テスト・リントの3カテゴリで最低限含める
  - 根拠: partykit の AGENTS.md はコマンドセクションを冒頭近く（22-54行目）に配置しており、AI が最初に必要とする「何を実行すればよいか」に即応できる構造になっている

- `[MUST]` リンター/フォーマッターの suppress コメントには理由を1文添付する（`// oxlint-disable-next-line rule-name -- 理由`）
  - 根拠: partykit では `oxlint-disable-next-line react-hooks/exhaustive-deps -- observable is stable`（`packages/partytracks/src/react/rxjsHooks.ts:29`）のように理由付き抑制が守られている一方、`@ts-expect-error yeah whatever`（`packages/partywhen/src/index.ts:377`）のような低品質な抑制も混在しており、ルールの明文化が必要

- `[SHOULD]` AI 向けドキュメントの Code Style セクションでは、設定ファイルの全転記ではなく「AI が判断に迷うルール」のみを選択的に記載し、なぜその設定かの意図を添える
  - 根拠: partykit の AGENTS.md は `.oxlintrc.json` の12ルールのうち5つだけを記載し、`^_` パターンの意図を添えることで、AI が unused-vars 警告に対して「アンダースコアプレフィックスで回避する」という正しいアクションを取れる

- `[SHOULD]` AI 向けドキュメントにはリポジトリ横断の「Common Patterns」セクションを設け、好まれるイディオムを5個以内で列挙する
  - 根拠: partykit の Common Patterns（`AGENTS.md:189-196`）は EventTarget、イベントクローン、指数バックオフ、dual API、string/function 設定という5パターンを示し、新コードの書き方の指針を提供している

- `[SHOULD]` モノレポの AI 向けドキュメントはリポジトリのパッケージ数に応じてファイル分割戦略を決定する — 10パッケージ以下なら単一ファイル、それ以上ならディレクトリごとの分割を検討する
  - 根拠: partykit（約10パッケージ）は196行の単一ファイルで十分な情報密度を達成している一方、cloudflare/agents（より大規模）は6階層に分割して局所性を確保している

- `[AVOID]` AI 向けドキュメントに個人のローカルパスやマシン固有の情報をハードコードする
  - 根拠: partykit の AGENTS.md には `/Users/sunilpai/code/partyserver`（`AGENTS.md:22`）が残っており、他の開発者や AI にとって無関係な情報がノイズになる

- `[AVOID]` テストガイドラインを「使用フレームワーク名と基本方針」だけで済ませる — テスト環境ディレクティブの使い分け基準や CI 固有の注意点も含めるべき
  - 根拠: partykit のテストコードでは `@vitest-environment jsdom` と `@vitest-environment node` がファイルごとに使い分けられており（12ファイルで確認）、AGENTS.md の1行だけの記述では AI が適切なディレクティブを選択できない

## 適用チェックリスト

- [ ] プロジェクトの AI 向けドキュメント（AGENTS.md / CLAUDE.md）にビルド・テスト・リントのコマンド例をコードブロックで記載しているか
- [ ] コマンド例はコピペしてそのまま実行できる形式か（相対パス、プレースホルダを使用し、ローカルパスを含まない）
- [ ] リンター/フォーマッター設定のうち「AI が判断に迷うルール」を選択的に記載し、意図を添えているか
- [ ] 設定ファイルの全内容を転記するのではなく、デフォルトと異なる設定・AI が遭遇しやすい設定のみを記載しているか
- [ ] リポジトリ横断で繰り返し使われるパターン/イディオムを「Common Patterns」として5個以内で明示しているか
- [ ] テストガイドラインにテスト環境の使い分け基準（jsdom vs node 等）を含めているか
- [ ] モノレポの場合、パッケージ数に応じた適切なファイル分割戦略を選択しているか
- [ ] `@ts-expect-error` や lint disable コメントに理由が添付されているか、コードベース全体で一貫しているか
