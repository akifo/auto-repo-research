# error-handling-idioms

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn/ui の CLI パッケージ（`packages/shadcn`）における、エラークラス階層設計・エラー伝播戦略・ユーザー向けエラーメッセージの構成を分析した。このコードベースでは、HTTP ステータスコードや設定不備といった障害モードごとに専用のエラーサブクラスを持ちながら、すべてを単一の `handleError` 関数に集約するパターンを徹底している。CLI ツールとしてのユーザー体験を左右する `suggestion` フィールドの設計は、エラーメッセージの品質を体系的に担保する仕組みとして注目に値する。

## 背景にある原則

- **Error as a Structured Data Object**: エラーを単なるメッセージ文字列ではなく、`code`・`statusCode`・`context`・`suggestion`・`timestamp` を持つ構造化データとして扱う。`toJSON()` メソッドを実装し、シリアライズ可能にしている。これにより、CLI 出力・MCP レスポンス・ログ収集といった異なる消費先に対して一貫した情報を提供できる。（`packages/shadcn/src/registry/errors.ts:32-76`）

- **Fail Fast with Recovery Guidance**: エラー発生時には即座に `process.exit(1)` で終了するが、必ず「次にユーザーが何をすべきか」を `suggestion` フィールドで提示する。「壊れた」と伝えるだけでなく「直し方」まで伝える方針。（`packages/shadcn/src/utils/handle-error.ts:30-33`）

- **Layered Validation — Preflight Then Execute**: コマンド実行前に preflight チェックでファイルシステムや設定の整合性を検証し、実行フェーズでは network/parse エラーのみを扱う。各レイヤーに適切なエラー種別を割り当てることで、ユーザーに「何が足りないか」を段階的に伝える。（`packages/shadcn/src/preflights/` 全体）

- **Single Choke Point for Error Presentation**: すべてのコマンドの `catch` 節が同一の `handleError` 関数を呼び出す。エラーの種類に応じた表示分岐は 1 箇所にのみ存在し、表示ロジックの散在を防いでいる。（`packages/shadcn/src/utils/handle-error.ts`）

## 実例と分析

### 1. RegistryError 階層の設計

基底クラス `RegistryError` が `Error` を継承し、16 のエラーサブクラスがそこから派生する。各サブクラスはコンストラクタ引数を受け取り、`message`・`code`・`suggestion` を自己完結的に構成する。

```
RegistryError (base)
├── RegistryNotFoundError        (404)
├── RegistryGoneError            (410)
├── RegistryUnauthorizedError    (401)
├── RegistryForbiddenError       (403)
├── RegistryFetchError           (generic HTTP)
├── RegistryNotConfiguredError   (config missing)
├── RegistryLocalFileError       (filesystem)
├── RegistryParseError           (JSON/Zod parse)
├── RegistriesIndexParseError    (index parse)
├── RegistryMissingEnvironmentVariablesError
├── RegistryInvalidNamespaceError
├── ConfigMissingError
├── ConfigParseError
└── InvalidConfigIconLibraryError
```

特筆すべきは、各サブクラスがドメイン固有の引数（URL、ファイルパス、レジストリ名など）を `public readonly` プロパティとして保持し、かつ `context` にも格納している点。これにより、エラーの catch 時に `instanceof` でパターンマッチングしつつ、構造化ログにも対応できる。

### 2. HTTP ステータスコードからエラークラスへのマッピング

`fetcher.ts` で HTTP レスポンスを受け取った直後に、ステータスコードごとに専用エラーを投げる。RFC 7807 準拠のエラーボディがあればそれも解析して `cause` として伝播する。

```typescript
// packages/shadcn/src/registry/fetcher.ts:89-110
if (response.status === 401) {
  throw new RegistryUnauthorizedError(url, messageFromServer);
}
if (response.status === 404) {
  throw new RegistryNotFoundError(url, messageFromServer);
}
if (response.status === 410) {
  throw new RegistryGoneError(url, messageFromServer);
}
if (response.status === 403) {
  throw new RegistryForbiddenError(url, messageFromServer);
}
throw new RegistryFetchError(url, response.status, messageFromServer);
```

最後の `RegistryFetchError` がキャッチオールとして機能し、未知のステータスコードでもエラーが握り潰されることがない。

### 3. Preflight バリデーションの Error Map パターン

preflight 関数群は `Record<string, boolean>` 形式のエラーマップを返す。例外を投げずにオブジェクトで返すことで、呼び出し側が複数の障害を同時にハンドリングできる。

```typescript
// packages/shadcn/src/preflights/preflight-add.ts:10-24
export async function preFlightAdd(options: z.infer<typeof addOptionsSchema>) {
  const errors: Record<string, boolean> = {};

  if (!fs.existsSync(options.cwd) || !fs.existsSync(path.resolve(options.cwd, "package.json"))) {
    errors[ERRORS.MISSING_DIR_OR_EMPTY_PROJECT] = true;
    return { errors, config: null };
  }

  if (!fs.existsSync(path.resolve(options.cwd, "components.json"))) {
    errors[ERRORS.MISSING_CONFIG] = true;
    return { errors, config: null };
  }
  // ...
}
```

エラー定数は `utils/errors.ts` で文字列リテラルとして一元管理される。

### 4. handleError — 型で分岐する単一ハンドラ

`handleError` は `unknown` 型のエラーを受け取り、`typeof`・`instanceof` による段階的な型絞り込みで表示を分岐させる。

```typescript
// packages/shadcn/src/utils/handle-error.ts:6-55
export function handleError(error: unknown) {
  logger.break();
  logger.error(`Something went wrong. Please check the error below for more details.`);
  logger.error(`If the problem persists, please open an issue on GitHub.`);
  logger.error("");

  if (typeof error === "string") { /* string 出力 → exit */ }
  if (error instanceof RegistryError) { /* message + cause + suggestion → exit */ }
  if (error instanceof z.ZodError) { /* fieldErrors 展開 → exit */ }
  if (error instanceof Error) { /* message → exit */ }

  logger.break();
  process.exit(1);
}
```

このチェーンの順序は重要で、`RegistryError`（`Error` のサブクラス）を先に判定し、汎用 `Error` をフォールバックに据えている。

### 5. MCP サーバーにおけるエラー → レスポンス変換

MCP サーバーでは `process.exit` が使えないため、同じ `RegistryError` 階層を `isError: true` の MCP レスポンスに変換する独自のエラーハンドリングを実装している。

```typescript
// packages/shadcn/src/mcp/index.ts:413-462
} catch (error) {
  if (error instanceof z.ZodError) {
    return { content: [{ type: "text", text: `Invalid input parameters: ...` }], isError: true }
  }
  if (error instanceof RegistryError) {
    let errorMessage = error.message
    if (error.suggestion) { errorMessage += `\n\n💡 ${error.suggestion}` }
    if (error.context) { errorMessage += `\n\nContext: ${JSON.stringify(error.context, null, 2)}` }
    return { content: [{ type: "text", text: `Error (${error.code}): ${errorMessage}` }], isError: true }
  }
  // generic fallback
}
```

エラークラス階層を共有しつつ、出力先に応じてプレゼンテーション層だけを差し替えている。

### 6. Zod バリデーションエラーの人間可読化

`RegistryParseError` と `RegistriesIndexParseError` は、Zod の `ZodError` を受け取ってパス付きの読みやすいメッセージに変換する。

```typescript
// packages/shadcn/src/registry/errors.ts:219-223
if (parseError instanceof z.ZodError) {
  message = `Failed to parse registry item: ${item}\n${
    parseError.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n")
  }`;
}
```

### 7. 障害に強い依存解決 — Swallow & Continue

`resolver.ts` の `resolveDependenciesRecursively` では、通常コンポーネントの fetch 失敗を握り潰して処理を継続する。一方、設定不備（`RegistryNotConfiguredError`）は即座に throw する。

```typescript
// packages/shadcn/src/registry/resolver.ts:444-468
try {
  const [item] = await fetchRegistryItems([dep], config, options);
  // ... resolve nested deps
} catch (error) {
  // If we can't fetch the registry item, that's okay - we'll still
  // include the name.
}
```

```typescript
// packages/shadcn/src/registry/namespaces.ts:46-58
} catch (error) {
  if (error instanceof RegistryNotConfiguredError) {
    // Still track the namespace, but continue
    continue
  }
  // For other errors, skip but continue
  continue
}
```

## コード例

```typescript
// packages/shadcn/src/registry/errors.ts:32-76
// 基底エラークラス — suggestion フィールドによるガイダンス付き
export class RegistryError extends Error {
  public readonly code: RegistryErrorCode;
  public readonly statusCode?: number;
  public readonly context?: Record<string, unknown>;
  public readonly suggestion?: string;
  public readonly timestamp: Date;
  public readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      code?: RegistryErrorCode;
      statusCode?: number;
      cause?: unknown;
      context?: Record<string, unknown>;
      suggestion?: string;
    } = {},
  ) {
    super(message);
    this.name = "RegistryError";
    this.code = options.code || RegistryErrorCode.UNKNOWN_ERROR;
    this.statusCode = options.statusCode;
    this.cause = options.cause;
    this.context = options.context;
    this.suggestion = options.suggestion;
    this.timestamp = new Date();

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      context: this.context,
      suggestion: this.suggestion,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }
}
```

```typescript
// packages/shadcn/src/registry/errors.ts:78-92
// ドメイン固有サブクラスの例 — コンストラクタで suggestion を自己完結的に構成
export class RegistryNotFoundError extends RegistryError {
  constructor(public readonly url: string, cause?: unknown) {
    const message = `The item at ${url} was not found. It may not exist at the registry.`;
    super(message, {
      code: RegistryErrorCode.NOT_FOUND,
      statusCode: 404,
      cause,
      context: { url },
      suggestion: "Check if the item name is correct and the registry URL is accessible.",
    });
    this.name = "RegistryNotFoundError";
  }
}
```

```typescript
// packages/shadcn/src/commands/add.ts:254-259
// コマンドレベルの try/catch/finally — handleError への集約
} catch (error) {
  logger.break()
  handleError(error)
} finally {
  clearRegistryContext()
}
```

```typescript
// packages/shadcn/src/registry/fetcher.ts:61-110
// HTTP レスポンスからの型付きエラー生成
if (!response.ok) {
  // RFC 7807 対応のサーバーメッセージ抽出
  let messageFromServer = undefined;
  if (response.headers.get("content-type")?.includes("application/json")) {
    const json = await response.json();
    const parsed = z.object({
      detail: z.string().optional(), // RFC 7807
      title: z.string().optional(),
      message: z.string().optional(), // 標準エラー
      error: z.string().optional(),
    }).safeParse(json);
    if (parsed.success) {
      messageFromServer = parsed.data.detail || parsed.data.message;
    }
  }
  if (response.status === 401) throw new RegistryUnauthorizedError(url, messageFromServer);
  if (response.status === 404) throw new RegistryNotFoundError(url, messageFromServer);
  if (response.status === 410) throw new RegistryGoneError(url, messageFromServer);
  if (response.status === 403) throw new RegistryForbiddenError(url, messageFromServer);
  throw new RegistryFetchError(url, response.status, messageFromServer);
}
```

```typescript
// packages/shadcn/src/preflights/preflight-init.ts:11-27
// Preflight — エラーマップで複数の検証結果を返す
export async function preFlightInit(options: z.infer<typeof initOptionsSchema>) {
  const errors: Record<string, boolean> = {};

  if (!fs.existsSync(options.cwd) || !fs.existsSync(path.resolve(options.cwd, "package.json"))) {
    errors[ERRORS.MISSING_DIR_OR_EMPTY_PROJECT] = true;
    return { errors, projectInfo: null };
  }
  // ... further checks populate errors map
}
```

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: 異なる型のエラーに対する表示処理を柔軟に切り替えたい
  - 適用条件: `unknown` 型のエラーを受け取り、型に応じて処理を分岐させる場面
  - コード例: `packages/shadcn/src/utils/handle-error.ts:6-55`（`string` → `RegistryError` → `ZodError` → `Error` の順に判定）
  - 注意点: `instanceof` チェーンの順序がサブクラスの継承関係を反映している必要がある

- **Template Method** (分類: 振る舞い)
  - 解決する問題: 各エラーサブクラスで `message`・`code`・`suggestion` の生成ロジックを統一したい
  - 適用条件: 基底クラスが共通プロパティを持ち、サブクラスがコンストラクタでドメイン固有のメッセージを注入する
  - コード例: `packages/shadcn/src/registry/errors.ts:32-362` — `RegistryError` 基底クラスとすべてのサブクラス
  - 注意点: `this.name` の上書きを忘れると `instanceof` 判定は動くが、ログ出力でクラス名が不正確になる

- **Error Map (Result Object)** (分類: 振る舞い)
  - 解決する問題: 複数の検証エラーを同時に返して呼び出し側に判断を委ねたい
  - 適用条件: 事前検証（preflight）など、例外ではなくエラーの種類に基づいてフロー分岐する場面
  - コード例: `packages/shadcn/src/preflights/preflight-add.ts:10-61`
  - 注意点: エラーマップは「致命的でない警告」と「致命的エラー」の区別が曖昧になりやすい。shadcn/ui では致命的エラーで即 return し、下流の検証を実行しない

## Good Patterns

- **Suggestion フィールドによるセルフサービスエラー**: すべてのカスタムエラークラスが `suggestion` プロパティを持ち、ユーザーが次に何をすべきかを具体的に伝える。例えば `ConfigMissingError` は `"Run 'npx shadcn@latest init' to create a components.json file"` と提示する。
  ```typescript
  // packages/shadcn/src/registry/errors.ts:271-283
  export class ConfigMissingError extends RegistryError {
    constructor(public readonly cwd: string) {
      super(`No components.json found in ${cwd} or parent directories.`, {
        code: RegistryErrorCode.NOT_CONFIGURED,
        context: { cwd },
        suggestion:
          "Run 'npx shadcn@latest init' to create a components.json file, or check that you're in the correct directory.",
      });
    }
  }
  ```

- **Error Code の定数化**: `RegistryErrorCode` を `as const` オブジェクトで定義し、プログラム的なエラーハンドリングを可能にする。テストコードで `instanceof` と組み合わせて正確なアサーションを書ける。
  ```typescript
  // packages/shadcn/src/registry/errors.ts:4-27
  export const RegistryErrorCode = {
    NETWORK_ERROR: "NETWORK_ERROR",
    NOT_FOUND: "NOT_FOUND",
    GONE: "GONE",
    // ...
  } as const;
  ```

- **RFC 7807 のサーバーメッセージ解析**: fetch 時にサーバーが返す `detail` / `message` フィールドを Zod で安全にパースし、`cause` に渡す。サーバー側のエラー情報をユーザーに中継できる。
  ```typescript
  // packages/shadcn/src/registry/fetcher.ts:66-87
  const parsed = z.object({
    detail: z.string().optional(),
    title: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  }).safeParse(json);
  ```

- **`toJSON()` による構造化エラーシリアライズ**: MCP レスポンスやデバッグログなど、エラーをシリアライズする場面で `toJSON()` が一貫した形式を保証する。
  ```typescript
  // packages/shadcn/src/registry/errors.ts:64-75
  toJSON() {
    return {
      name: this.name, message: this.message, code: this.code,
      statusCode: this.statusCode, context: this.context,
      suggestion: this.suggestion, timestamp: this.timestamp, stack: this.stack,
    }
  }
  ```

- **finally 節でのリソースクリーンアップ**: `add`・`search`・`view` コマンドが `finally` 節で `clearRegistryContext()` を呼び、認証ヘッダーなどのステートフルなコンテキストを確実にクリアする。
  ```typescript
  // packages/shadcn/src/commands/add.ts:257-259
  } finally {
    clearRegistryContext()
  }
  ```

## Anti-Patterns / 注意点

- **Preflight でのインライン `process.exit(1)`**: preflight 関数内部で直接 `logger.error()` + `process.exit(1)` を呼ぶ箇所がある。これにより、preflight の結果を呼び出し側で柔軟にハンドリングできなくなる。`RegistryError` 階層を使えるはずの場面でアドホックな処理をしている。
  ```typescript
  // Bad: packages/shadcn/src/preflights/preflight-init.ts:39-49
  if (fs.existsSync(path.resolve(options.cwd, "components.json")) && !options.force) {
    projectSpinner?.fail();
    logger.break();
    logger.error(`A components.json file already exists...`);
    logger.break();
    process.exit(1);
  }

  // Better: エラーマップに追加して呼び出し側に判断を委ねる
  if (fs.existsSync(path.resolve(options.cwd, "components.json")) && !options.force) {
    errors[ERRORS.EXISTING_CONFIG] = true;
    return { errors, projectInfo: null };
  }
  ```

- **catch 節でのエラー握り潰し**: `resolver.ts:464` で fetch 失敗を空の catch で握り潰している。「意図的な握り潰し」であってもコメントだけでは不十分で、ログ出力やフォールバック値の明示がないと障害調査が困難になる。
  ```typescript
  // Bad: packages/shadcn/src/registry/resolver.ts:444-468
  try {
    const [item] = await fetchRegistryItems([dep], config, options)
    // ...
  } catch (error) {
    // If we can't fetch the registry item, that's okay
  }

  // Better: デバッグレベルのログを出力する
  } catch (error) {
    logger.debug?.(`Skipping dependency "${dep}": ${error instanceof Error ? error.message : String(error)}`)
  }
  ```

- **二重エラーハンドリング経路**: `getShadcnRegistryIndex` のように、関数内で `handleError` を呼びつつ呼び出し側の `catch` でも `handleError` を呼ぶコードがある。エラー表示の重複リスクがある。
  ```typescript
  // Bad: packages/shadcn/src/registry/api.ts:162-171
  export async function getShadcnRegistryIndex() {
    try {
      const [result] = await fetchRegistry(["index.json"]);
      return registryIndexSchema.parse(result);
    } catch (error) {
      logger.error("\n");
      handleError(error); // ここで process.exit するが、呼び出し側にも catch がある
    }
  }

  // Better: エラーを throw して呼び出し側に委ねる
  export async function getShadcnRegistryIndex() {
    const [result] = await fetchRegistry(["index.json"]);
    return registryIndexSchema.parse(result);
  }
  ```

## 導出ルール

- `[MUST]` カスタムエラークラスには `suggestion` フィールド（ユーザーが次に取るべきアクション）を必須とする
  - 根拠: shadcn/ui の全 16 エラーサブクラスが suggestion を持ち、`handleError` と MCP レスポンスの両方でユーザーに表示される。suggestion がないエラーは「壊れた」としか伝えられない
- `[MUST]` エラーの表示ロジックは単一のハンドラ関数に集約し、コマンド側の catch 節は `handleError(error)` の 1 行のみにする
  - 根拠: `add`・`init`・`build`・`diff`・`search`・`view`・`mcp` の全コマンドが同一パターンの `catch (error) { handleError(error) }` を使い、エラー表示ロジックの重複を排除している
- `[MUST]` HTTP ステータスコードに対応するエラークラスを個別に定義し、catch-all の汎用 HTTP エラーを最後に配置する
  - 根拠: `fetcher.ts` で 401→404→410→403→汎用の順に `throw` し、ステータスごとの `suggestion` を差別化。catch-all がないと未知のステータスコードでエラーが握り潰される
- `[SHOULD]` エラーコードを `as const` オブジェクトで定数化し、`instanceof` と併用して型安全なエラー分岐を実現する
  - 根拠: `RegistryErrorCode` の定数化により、テスト時に `error.code === RegistryErrorCode.NOT_FOUND` のような厳密なアサーションが可能。文字列リテラルの散在を防ぐ
- `[SHOULD]` 事前検証（preflight）はエラーマップを返し、実行フェーズは例外を throw するという二層構造でエラーを扱う
  - 根拠: preflight が `Record<string, boolean>` 形式で複数の検証結果を返すことで、`add` コマンドは `MISSING_CONFIG` なら init を提案し、`MISSING_DIR_OR_EMPTY_PROJECT` ならプロジェクト作成に分岐できる
- `[SHOULD]` エラークラスに `toJSON()` を実装し、ログ・API レスポンス・デバッグ出力でシリアライズ可能にする
  - 根拠: `RegistryError.toJSON()` が MCP サーバーの `context` 出力、CLI の `handleError` 表示、テストのスナップショットに統一された形式を提供している
- `[AVOID]` ライブラリ関数の内部で `process.exit` を呼ぶこと。CLI のエントリポイント（コマンドハンドラ）でのみ終了すべき
  - 根拠: `getShadcnRegistryIndex` 内の `handleError` → `process.exit` は、MCP サーバーから再利用する際にプロセスが予期せず終了するリスクを生む。実際に MCP 側では独自の catch 処理を実装している
- `[AVOID]` 空の catch 節でエラーを握り潰すこと。少なくともコメントに加えてデバッグログを出力する
  - 根拠: `resolver.ts:464` の空 catch は、レジストリサーバーの障害時にサイレントに依存を欠落させる。ユーザーが問題に気づくのが遅れる

## 適用チェックリスト

- [ ] カスタムエラークラスの基底に `code`・`context`・`suggestion` フィールドがあるか
- [ ] すべてのサブクラスが `suggestion` をコンストラクタで設定しているか
- [ ] エラー表示ロジックが単一のハンドラ関数に集約されているか
- [ ] HTTP クライアントがステータスコードごとの型付きエラーを throw しているか
- [ ] catch-all の汎用エラーが最後に配置されているか（サブクラスの判定が先）
- [ ] `instanceof` チェーンの順序が継承関係を正しく反映しているか（サブクラス → 基底クラス）
- [ ] preflight/validation 層がエラーマップを返し、実行層が例外を throw する構造になっているか
- [ ] `process.exit` がコマンドのエントリポイントにのみ存在し、ライブラリ関数内にないか
- [ ] 空の catch 節がなく、意図的な握り潰しにはデバッグログが付いているか
- [ ] エラークラスが `toJSON()` を実装し、シリアライズに対応しているか
