# error-handling-idioms

> リポジトリ: vercel/ai
> 分析日: 2026-02-20

## 概要

Vercel AI SDK は `Symbol.for()` によるマーカーパターンを使い、`instanceof` に依存しないエラー型判定を実現している。モノレポ内 53 パッケージ・35 以上のエラークラスすべてが同一の構造を踏襲しており、パッケージバージョン不一致やバンドラーの重複インスタンス問題を根本的に回避している。さらに `isRetryable` フラグによるリトライ制御、`safeParseJSON` による安全な JSON パース、`TypeValidationError.wrap()` による冪等なラップなど、エラーハンドリングの各層に一貫した設計原則が適用されている点が注目に値する。

## 背景にある原則

- **instanceof は信頼できない、構造的マーカーで型を証明すべき**: npm のバージョン重複・バンドラーのチャンク分割・モノレポのシンボリックリンクにより、同一クラスが複数インスタンスとして存在しうる。`Symbol.for()` はグローバルシンボルレジストリを参照するため、異なるパッケージバージョン間でも同一のシンボルキーを共有できる。根拠: `ai-sdk-error.ts:6` の `Symbol.for(marker)` と `hasMarker` メソッド。
- **エラーは値である、フローの一部として設計すべき**: `safeParseJSON` は例外を投げず `{ success, value } | { success, error }` の判別共用体を返す。エラーを例外フローから通常のデータフローに引き戻すことで、catch ブロックに分散しがちなエラー処理ロジックを呼び出し元に集約できる。根拠: `parse-json.ts:59-65` の `ParseResult<T>` 型。
- **エラーのコンテキスト情報は型安全に保持すべき**: 各エラークラスはドメイン固有のプロパティ（`url`, `statusCode`, `toolName`, `text` 等）を `readonly` で公開する。`catch(e)` で `unknown` を受け取っても、`isInstance` 後の型ガード内でこれらのプロパティに型安全にアクセスできる。根拠: `APICallError` の `url`, `statusCode`, `isRetryable` 等のフィールド群。
- **セキュリティは型システムの外で守るべき**: `JSON.parse` を直接使わず `secureJsonParse` でプロトタイプ汚染を防止している。型安全は実行時攻撃を防がないため、パース層で防御する。根拠: `secure-json-parse.ts` の `__proto__` / `constructor.prototype` チェック。

## 実例と分析

### Symbol マーカーによる型判定パターン

全エラークラスが以下の 4 要素を持つテンプレートに従う:

1. `const marker = 'vercel.ai.error.AI_XxxError'` — ドット区切りの名前空間付き文字列
2. `const symbol = Symbol.for(marker)` — グローバルシンボル生成
3. `private readonly [symbol] = true` — インスタンスにマーカーを埋め込み
4. `static isInstance(error: unknown): error is XxxError` — 型ガード付き判定メソッド

基底クラス `AISDKError` が `hasMarker` を `protected static` で提供し、全サブクラスが再利用する:

```typescript
// packages/provider/src/errors/ai-sdk-error.ts:52-61
protected static hasMarker(error: unknown, marker: string): boolean {
  const markerSymbol = Symbol.for(marker);
  return (
    error != null &&
    typeof error === 'object' &&
    markerSymbol in error &&
    typeof error[markerSymbol] === 'boolean' &&
    error[markerSymbol] === true
  );
}
```

`in` 演算子でプロパティ存在を確認した上で型と値をチェックする 3 段階ガードにより、偽陽性を排除している。

### マーカー名前空間の階層設計

マーカー文字列は名前空間を反映した階層構造をとる:

- 基底: `vercel.ai.error`（`AISDKError` 自身）
- サブクラス: `vercel.ai.error.AI_APICallError`, `vercel.ai.error.AI_JSONParseError` 等
- Gateway 系: `vercel.ai.gateway.error`（`GatewayError` の別階層）

各サブクラスは自身のマーカーと親のマーカーの両方を持つ。`AISDKError.isInstance()` は `vercel.ai.error` マーカーで基底クラスとしての判定を行い、`APICallError.isInstance()` は `vercel.ai.error.AI_APICallError` で具体クラスの判定を行う。

```typescript
// packages/provider/src/errors/api-call-error.ts:3-5
const name = "AI_APICallError";
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);
```

### safe/unsafe の二重 API パターン

JSON パースとバリデーションの両方で、例外を投げる版（`parseJSON`, `validateTypes`）と Result 型を返す版（`safeParseJSON`, `safeValidateTypes`）が対で提供されている:

```typescript
// packages/provider-utils/src/parse-json.ts:32-57
export async function parseJSON<T>({ text, schema }: { ... }): Promise<T> {
  try {
    const value = secureJsonParse(text);
    if (schema == null) return value;
    return validateTypes<T>({ value, schema });
  } catch (error) {
    if (JSONParseError.isInstance(error) || TypeValidationError.isInstance(error)) {
      throw error; // 既知エラーは再スロー
    }
    throw new JSONParseError({ text, cause: error }); // 未知エラーをラップ
  }
}
```

`parseJSON` の catch ブロックでは `isInstance` で既知のエラーをそのまま再スローし、未知のエラーのみ `JSONParseError` でラップする。これにより、エラーの二重ラップを防ぎつつ、すべてのエラーが型付きエラーとして伝播する。

### 冪等ラップパターン（TypeValidationError.wrap）

`TypeValidationError.wrap()` は、cause が既に同一の値・コンテキストを持つ `TypeValidationError` であれば、新しいインスタンスを作らずそのまま返す:

```typescript
// packages/provider/src/errors/type-validation-error.ts:87-107
static wrap({ value, cause, context }: { ... }): TypeValidationError {
  if (
    TypeValidationError.isInstance(cause) &&
    cause.value === value &&
    cause.context?.field === context?.field &&
    cause.context?.entityName === context?.entityName &&
    cause.context?.entityId === context?.entityId
  ) {
    return cause;
  }
  return new TypeValidationError({ value, cause, context });
}
```

これにより `safeValidateTypes` が複数箇所から呼ばれても、同じバリデーションエラーがネストしない。

### isRetryable フラグによるリトライ制御

`APICallError` はコンストラクタで HTTP ステータスコードからリトライ可否を自動判定する:

```typescript
// packages/provider/src/errors/api-call-error.ts:28-32
isRetryable = statusCode != null &&
  (statusCode === 408 || // request timeout
    statusCode === 409 || // conflict
    statusCode === 429 || // too many requests
    statusCode >= 500), // server error
```

リトライロジック側では `isInstance` と `isRetryable` の組み合わせで判定する:

```typescript
// packages/ai/src/util/retry-with-exponential-backoff.ts:118-122
if (
  error instanceof Error &&
  APICallError.isInstance(error) &&
  error.isRetryable === true &&
  tryNumber <= maxRetries
)
```

ここで `instanceof Error` と `isInstance` を併用している点に注目。`isInstance` はマーカーによる型チェック、`instanceof Error` はプロトタイプチェーンの確認であり、両方を満たすことでより堅牢な判定を行っている。

### catch ブロックでの再スロー/ラップの使い分け

`download.ts` はエラーの再スロー/ラップの典型例を示す:

```typescript
// packages/ai/src/util/download/download.ts:60-66
} catch (error) {
  if (DownloadError.isInstance(error)) {
    throw error; // 既知エラーはそのまま再スロー
  }
  throw new DownloadError({ url: urlText, cause: error }); // 未知エラーをラップ
}
```

このパターンは `parseJSON`、`download`、`parseAndValidateObjectResultWithRepair` 等、コードベース全体で一貫して使われている。

### エラーの cause チェーン分析

`parseAndValidateObjectResultWithRepair` では `error.cause` の型を `isInstance` で判定し、修復可能かどうかを決定する:

```typescript
// packages/ai/src/generate-object/parse-and-validate-object-result.ts:90-94
if (
  repairText != null &&
  NoObjectGeneratedError.isInstance(error) &&
  (JSONParseError.isInstance(error.cause) ||
    TypeValidationError.isInstance(error.cause))
)
```

`cause` プロパティを通じてエラーの原因チェーンを辿りつつ、各レベルで `isInstance` により型安全な判定を行っている。

## パターンカタログ

- **Marker Interface パターン** (分類: 構造)
  - 解決する問題: `instanceof` がパッケージバージョン不一致で壊れる
  - 適用条件: モノレポ / npm パッケージとして配布されるライブラリ
  - コード例: `packages/provider/src/errors/ai-sdk-error.ts:5-13`
  - 注意点: `Symbol.for()` はグローバル名前空間を汚染するため、十分にユニークなマーカー文字列が必要

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 全エラークラスで `isInstance` のロジックが重複する
  - 適用条件: 共通の判定ロジックを持つエラー階層
  - コード例: `AISDKError.hasMarker()` を全サブクラスの `isInstance` が呼び出す
  - 注意点: `protected static` メソッドのため、外部からは直接アクセスできない

- **Result 型パターン** (分類: 振る舞い)
  - 解決する問題: 例外ベースのエラー処理で制御フローが読みにくくなる
  - 適用条件: パース・バリデーション等、失敗が「想定内」の操作
  - コード例: `packages/provider-utils/src/parse-json.ts:59-65` の `ParseResult<T>`
  - 注意点: safe 版と unsafe 版を対で提供し、呼び出し元に選択させる

## Good Patterns

- **名前空間付きマーカー文字列**: `vercel.ai.error.AI_APICallError` のように逆ドメイン記法で衝突を回避する。マーカーは `const marker` としてモジュールスコープで定義し、クラス定義の外から変更できないようにしている。

```typescript
// packages/provider/src/errors/api-call-error.ts:3-5
const name = "AI_APICallError";
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);
```

- **コンストラクタの構造化引数**: 全エラークラスが名前付きオブジェクト引数を取り、必須/オプション/デフォルト値が型レベルで明示される。位置引数と異なり、フィールドの追加が後方互換を壊さない。

```typescript
// packages/provider/src/errors/api-call-error.ts:20-43
constructor({
  message,
  url,
  requestBodyValues,
  statusCode,
  responseHeaders,
  responseBody,
  cause,
  isRetryable = statusCode != null &&
    (statusCode === 408 || statusCode === 429 || statusCode >= 500),
  data,
}: { ... })
```

- **readonly プロパティによるエラーコンテキストの公開**: `readonly url`, `readonly statusCode` 等のドメイン固有プロパティを公開し、catch した側がプログラム的にエラーの性質を判断できる。

```typescript
// packages/ai/src/util/retry-with-exponential-backoff.ts:118-122
if (
  error instanceof Error &&
  APICallError.isInstance(error) &&
  error.isRetryable === true &&
  tryNumber <= maxRetries
)
```

- **v3 → v4 マイグレーション対応**: `isXxxError()` 関数から `XxxError.isInstance()` 静的メソッドへの移行を codemod で自動化。エラー判定 API の変更が大規模リポジトリでも安全に適用できる。

```typescript
// packages/codemod/src/codemods/v4/remove-isxxxerror.ts:3-24
const ERROR_METHOD_MAPPINGS: Record<string, string> = {
  isAPICallError: "APICallError.isInstance",
  isJSONParseError: "JSONParseError.isInstance",
  // ... 20+ mappings
};
```

## Anti-Patterns / 注意点

- **catch(e) での安易な instanceof 判定**: モノレポや npm パッケージでは `instanceof` が壊れる可能性がある。特に、バンドラーが同一パッケージの異なるバージョンを含む場合に判定が失敗する。

```typescript
// Bad: instanceof はパッケージバージョン不一致で壊れる
try { ... } catch (error) {
  if (error instanceof APICallError) { /* 到達しない可能性がある */ }
}

// Better: Symbol マーカーによる判定
try { ... } catch (error) {
  if (APICallError.isInstance(error)) { /* バージョン不一致でも動作する */ }
}
```

- **エラーの二重ラップ**: catch ブロックで無条件にエラーをラップすると、同一エラーが多重にネストしてデバッグが困難になる。

```typescript
// Bad: 既知エラーも含めて無条件ラップ
try { ... } catch (error) {
  throw new JSONParseError({ text, cause: error });
}

// Better: 既知エラーは再スローし、未知エラーのみラップ
try { ... } catch (error) {
  if (JSONParseError.isInstance(error)) throw error;
  throw new JSONParseError({ text, cause: error });
}
```

- **生の JSON.parse 使用**: `JSON.parse` はプロトタイプ汚染攻撃に対して脆弱。ユーザー入力や外部 API レスポンスをパースする場合は、`__proto__` / `constructor.prototype` を検査するラッパーを使うべき。

```typescript
// Bad: プロトタイプ汚染のリスク
const data = JSON.parse(userInput);

// Better: セキュアパーサーでフィルタリング
const data = secureJsonParse(userInput);
```

## 導出ルール

- `[MUST]` npm パッケージとして配布するエラークラスでは、`instanceof` の代わりに `Symbol.for()` ベースのマーカーパターンと `static isInstance()` 型ガードを使う
  - 根拠: AI SDK は 35 以上のエラークラスすべてでこのパターンを採用し、パッケージバージョン不一致問題を構造的に解決している（`ai-sdk-error.ts:5-61`）
- `[MUST]` catch ブロックでエラーをラップする際は、既知のエラー型を `isInstance` で判定し再スローしてから、未知のエラーのみをラップする
  - 根拠: `parseJSON`, `download` 等でこのパターンが一貫して使われ、エラーの二重ラップを防止している（`parse-json.ts:48-56`, `download.ts:60-66`）
- `[SHOULD]` 失敗が想定内の操作（パース・バリデーション等）には、例外を投げる版と Result 型を返す safe 版を対で提供する
  - 根拠: `parseJSON` / `safeParseJSON`、`validateTypes` / `safeValidateTypes` が対で存在し、呼び出し元がエラーハンドリング戦略を選択できる（`parse-json.ts:16-113`）
- `[SHOULD]` エラークラスのコンストラクタは名前付きオブジェクト引数を取り、ドメイン固有のコンテキスト情報を `readonly` プロパティで公開する
  - 根拠: `APICallError` の `url`, `statusCode`, `isRetryable` 等により、catch 側がプログラム的にエラーの性質を判断してリトライ等の制御を行える（`api-call-error.ts:7-59`）
- `[SHOULD]` 外部入力の JSON パースには `__proto__` / `constructor.prototype` を検査するセキュアパーサーを使う
  - 根拠: AI SDK は fastify/secure-json-parse を移植して全 JSON パース処理に適用し、プロトタイプ汚染を防止している（`secure-json-parse.ts:24-92`）
- `[SHOULD]` エラーを冪等にラップする `wrap()` 静的メソッドを提供し、同一コンテキストのエラーが多重ネストしないようにする
  - 根拠: `TypeValidationError.wrap()` は cause が同一の値・コンテキストを持つ場合に既存インスタンスをそのまま返す（`type-validation-error.ts:87-107`）
- `[AVOID]` `JSON.parse` をライブラリコード内で直接呼び出す — セキュアパーサーまたは `safeParseJSON` を経由すべき
  - 根拠: AI SDK の `packages/provider/src` 内で `JSON.parse` の直接呼び出しはコメント内の 1 箇所のみであり、実行コードでは一切使われていない

## 適用チェックリスト

- [ ] ライブラリのエラークラスが `instanceof` に依存していないか確認する — 依存している場合は `Symbol.for()` マーカーパターンへの移行を検討する
- [ ] 全エラークラスが共通の基底クラスを持ち、`isInstance` 型ガードが統一的に提供されているか確認する
- [ ] catch ブロックでのエラーラップが「既知エラー再スロー → 未知エラーのみラップ」のパターンに従っているか確認する
- [ ] 失敗が想定内の操作に対して safe 版（Result 型返却）が提供されているか確認する
- [ ] エラークラスのコンストラクタが名前付きオブジェクト引数を取り、コンテキスト情報が `readonly` で公開されているか確認する
- [ ] JSON パース処理がプロトタイプ汚染対策を施したセキュアパーサーを経由しているか確認する
- [ ] マーカー文字列が逆ドメイン記法等で十分にユニークな名前空間を持っているか確認する
- [ ] エラー判定 API の変更を codemod 等で自動マイグレーション可能にする設計になっているか確認する
