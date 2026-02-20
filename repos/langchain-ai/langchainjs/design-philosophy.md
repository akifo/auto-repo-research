# design-philosophy

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

LangChain.js のフレームワーク設計思想と技術選定の根拠を分析する。
このリポジトリは「あらゆる LLM プロバイダーを同一インターフェースで合成可能にする」という目標のもと、
Runnable という単一の統一抽象を軸にコンポーネントの合成・ストリーミング・バッチ処理を実現している。
特に注目すべきは、マルチ環境対応のためにランタイム固有 API を徹底的に抽象化している点、
そして `instanceof` を禁止し Symbol ベースの型判定に置き換えるという異例の設計判断である。

## 背景にある原則

- **統一インターフェース原則**: フレームワーク内のすべてのコンポーネント（LLM、ツール、リトリーバー、ベクトルストア等）が `invoke / stream / batch` の3メソッドを持つ `Runnable` を継承すべき。これにより、任意のコンポーネントを `.pipe()` で連結でき、利用者はコンポーネントの内部実装を知らずに合成できる。根拠: `libs/langchain-core/src/runnables/base.ts:124-148` で Runnable が abstract invoke を定義し、stream/batch にはデフォルト実装を提供している。

- **ランタイム中立原則**: ライブラリコードはランタイム固有 API（`process.env`、Node.js 組み込みモジュール等）に直接依存すべきでない。ESLint ルール `no-process-env: error` でプロダクションコードでの `process.env` 直接参照を禁止し、`getEnvironmentVariable()` ユーティリティに一元化している（`libs/langchain-core/src/utils/env.ts:78-93`）。これは Node.js / Deno / Bun / Cloudflare Workers / ブラウザの 7 環境をサポートするための必然的な選択。

- **パッケージ境界を越えた安全な型判定原則**: 異なる npm パッケージから同じクラスの異なるバージョンがインストールされうるモノレポ環境では、`instanceof` は信頼できない。`Symbol.for()` によるグローバルシンボルをプロトタイプに刻印し、`isInstance` 静的メソッドで判定することで、パッケージ重複時も正しく動作する（`libs/langchain-core/src/utils/namespace.ts:114-163`）。

- **コアの安定・周辺の柔軟原則**: `@langchain/core` はフレームワークの安定した抽象層として最小限の依存のみ持ち、プロバイダー固有のロジックは個別パッケージ（`@langchain/openai` 等）に分離する。外部 SDK は `peerDependencies` として宣言し、利用者が必要なプロバイダーのみインストールする設計（`libs/providers/langchain-openai/package.json:40-42`）。

## 実例と分析

### Runnable による統一合成モデル

Runnable は GoF の Strategy パターンと Composite パターンの融合体として機能する。すべてのコンポーネントが同一インターフェースを実装するため、`pipe()` メソッドで任意のコンポーネントを直列に連結できる。

```typescript
// libs/langchain-core/src/runnables/base.ts:615-623
pipe<NewRunOutput>(
  coerceable: RunnableLike<RunOutput, NewRunOutput>
): Runnable<RunInput, Exclude<NewRunOutput, Error>> {
  return new RunnableSequence({
    first: this,
    last: _coerceToRunnable(coerceable),
  });
}
```

この設計の鍵は `RunnableLike` 型にある。Runnable インスタンスだけでなく、関数やオブジェクトも受け入れ、`_coerceToRunnable` で自動的にラップする。利用者はクラスを作らずに関数を渡すだけでパイプラインに組み込める。

### stream のデフォルト実装と段階的オーバーライド

Runnable の `stream` メソッドはデフォルトで `invoke` を呼んで単一チャンクを返す。サブクラスは `_streamResponseChunks` をオーバーライドすることで真のストリーミングを実現する。

```typescript
// libs/langchain-core/src/runnables/base.ts:297-302
async *_streamIterator(
  input: RunInput,
  options?: Partial<CallOptions>
): AsyncGenerator<RunOutput> {
  yield this.invoke(input, options);
}
```

`BaseChatModel` では `_streamResponseChunks` がオーバーライドされているかをプロトタイプ比較で検出し、ストリーミング非対応モデルでは自動的に invoke にフォールバックする（`libs/langchain-core/src/language_models/chat_models.ts:304-305`）。

### Symbol ベースの instanceof 代替

ESLint ルール `no-instanceof/no-instanceof: error` でコードベース全体から `instanceof` を排除し、`Symbol.for()` を使った `isInstance` 静的メソッドに置き換えている。

```typescript
// libs/langchain-core/src/utils/namespace.ts:114-160
export function createNamespace(path: string): Namespace {
  const symbol: symbol = Symbol.for(path);

  return {
    brand<TBase extends Constructor>(Base: TBase, marker?: string) {
      const brandSymbol: symbol = marker
        ? Symbol.for(`${path}.${marker}`)
        : symbol;

      class _Branded extends (Base as any) {
        readonly [brandSymbol] = true as const;

        static isInstance(obj: unknown): boolean {
          return (
            typeof obj === "object"
            && obj !== null
            && brandSymbol in obj
            && (obj as Record<symbol, unknown>)[brandSymbol] === true
          );
        }
      }
      return _Branded as unknown as BrandedClass<TBase>;
    },
    // ...
  };
}
```

名前空間は階層的に構成されており、エラー型の判定で `LangChainError.isInstance(err)` と `ModelAbortError.isInstance(err)` の両方が使える。`Symbol.for()` はグローバルシンボルレジストリを使うため、異なるパッケージバージョン間でも同一シンボルを共有できる。

### 環境変数アクセスの一元化

```typescript
// libs/langchain-core/src/utils/env.ts:78-93
export function getEnvironmentVariable(name: string): string | undefined {
  try {
    if (typeof process !== "undefined") {
      return process.env?.[name];
    } else if (isDeno()) {
      return Deno?.env.get(name);
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }
}
```

Node.js と Deno で環境変数 API が異なる問題を吸収し、ブラウザなどの環境では `undefined` を返す。try-catch で Deno のパーミッションエラーにも対応している。プロバイダーパッケージはすべてこのユーティリティを使って API キーを取得する（例: `libs/providers/langchain-openai/src/embeddings.ts:2`）。

### レイヤー分離と peerDependencies 戦略

パッケージは 3 層に分離されている:

1. **Core層** (`@langchain/core`): 抽象クラスとインターフェース。依存は最小限（langsmith, zod, uuid 等）
2. **Main層** (`langchain`): エージェント、チェーン等のオーケストレーション
3. **Provider層** (`@langchain/openai` 等): 各プロバイダー SDK のラッパー

Provider 層は `@langchain/core` を `peerDependencies` に宣言し、外部 SDK を `dependencies` に持つ。一方 `@langchain/community` パッケージでは外部 SDK をすべて `peerDependencies` + `peerDependenciesMeta` で optional 指定している（`libs/langchain-community/package.json:207-344`）。これにより利用者は必要なプロバイダーの依存のみインストールすればよい。

### 標準テストスイートによる品質保証

すべてのプロバイダーは `@langchain/standard-tests` の抽象テストクラスを継承してテストを書く。`ChatModelUnitTests` を継承すれば、ツール呼び出し・構造化出力・LangSmith パラメータ等の標準的な振る舞いが自動検証される（`internal/standard-tests/src/unit_tests/chat_models.ts:37-65`）。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 異なる LLM プロバイダーを同一インターフェースで交換可能にする
  - 適用条件: 同一カテゴリの複数実装を切り替える必要がある場合
  - コード例: `BaseChatModel._generate()` を各プロバイダーがオーバーライド（`libs/langchain-core/src/language_models/chat_models.ts:881-885`）
  - 注意点: 抽象メソッドだけでなく Template Method（`generate` が `_generate` を呼ぶ）も併用している

- **Composite / Pipeline パターン** (分類: 構造)
  - 解決する問題: 複数のコンポーネントを直列・並列に合成する
  - 適用条件: 処理を段階的に組み立てたい場合
  - コード例: `RunnableSequence`（`libs/langchain-core/src/runnables/base.ts:1847-1880`）は `first` / `middle` / `last` の Runnable を保持し、順次実行する
  - 注意点: `RunnableMap` で並列実行も可能。合成結果も Runnable なので再帰的に合成できる

- **Branding パターン** (分類: 独自 / 構造的型付けの補完)
  - 解決する問題: `instanceof` が機能しない環境（パッケージ重複、異なるバンドル）での型判定
  - 適用条件: npm パッケージとして配布されるライブラリで、利用者のバージョン不一致が起こりうる場合
  - コード例: `createNamespace` + `ns.brand()`（`libs/langchain-core/src/utils/namespace.ts:114-163`）
  - 注意点: `Symbol.for()` はグローバルに共有されるため、名前空間の衝突に注意が必要

## Good Patterns

- **デフォルト実装 + 段階的オーバーライド**: `Runnable.stream()` は `invoke` で動作するデフォルトを持ち、サブクラスは `_streamResponseChunks` をオーバーライドするだけで真のストリーミングを有効化できる。これにより新しいプロバイダーは最初に `invoke` だけ実装して動作させ、後からストリーミングを追加できる。

```typescript
// libs/langchain-core/src/language_models/chat_models.ts:289-295
// デフォルトでは例外を投げる → オーバーライドすればストリーミング有効
async *_streamResponseChunks(
  _messages: BaseMessage[],
  _options: this["ParsedCallOptions"],
  _runManager?: CallbackManagerForLLMRun
): AsyncGenerator<ChatGenerationChunk> {
  throw new Error("Not implemented.");
}
```

- **ESLint による設計制約の強制**: `instanceof` 禁止、`process.env` 禁止、浮遊 Promise 禁止、明示的 `any` 禁止など、設計判断をリンタールールとして機械的に強制している（`internal/eslint/src/configs/base.ts:59-144`）。これにより設計原則がドキュメントに留まらず、CI で自動検証される。

```typescript
// internal/eslint/src/configs/base.ts:102-103
"no-instanceof/no-instanceof": "error",
"no-process-env": "error",
```

- **scaffolding ツールによるプロバイダー統一**: `create-langchain-integration` CLI でプロバイダーパッケージの雛形を生成し、ディレクトリ構成・package.json・ESLint 設定等を統一する。これにより新規プロバイダーが既存の品質基準を自動的に満たす。

## Anti-Patterns / 注意点

- **peerDependencies の多用による依存地獄**: `@langchain/community` は 100 以上の `peerDependencies` を持ち、すべて optional で宣言している。利用者にとってはどの依存が必要かが分かりにくく、バージョン不整合のデバッグが困難になる。

```json
// Bad: libs/langchain-community/package.json (100+の peerDependencies)
"peerDependencies": {
  "@arcjet/redact": "^v1.1.0",
  "@aws-crypto/sha256-js": "^5.0.0",
  // ... 100+ entries
}
```

```json
// Better: 独立パッケージに分離（現在の推奨方針）
// libs/providers/langchain-openai/package.json
"dependencies": {
  "openai": "^6.18.0"
},
"peerDependencies": {
  "@langchain/core": "workspace:^"
}
```

実際にプロジェクトはこの問題を認識し、`@langchain/community` への新規追加を停止して独立パッケージへの移行を推奨している（`CONTRIBUTING.md:54-56`）。

- **`any` の多用と eslint-disable**: `no-explicit-any: error` ルールがありながら、コアモジュールでは `eslint-disable` コメントで多数の `any` を使用している。特に `Runnable` のジェネリクス境界（`libs/langchain-core/src/runnables/base.ts:72-107`）に集中しており、型安全性のギャップが存在する。

## 導出ルール

- `[MUST]` マルチランタイム対応ライブラリでは、ランタイム固有 API へのアクセスをユーティリティ関数に一元化し、プロダクションコードでの直接参照を ESLint ルールで禁止する
  - 根拠: langchainjs は `getEnvironmentVariable()` に一元化し `no-process-env: error` で強制することで、7 環境での動作を保証している（`internal/eslint/src/configs/base.ts:103`）

- `[MUST]` 設計上の制約（禁止事項・必須事項）は ESLint カスタムルールまたはプラグインで機械的に強制し、コードレビューやドキュメントのみに頼らない
  - 根拠: `no-instanceof` プラグインにより `instanceof` 使用が CI で自動検出される。ドキュメントだけの禁止事項は時間とともに形骸化するが、リンタールールは破ることができない（`internal/eslint/src/configs/base.ts:102`）

- `[SHOULD]` npm パッケージとして配布するライブラリでは、`instanceof` の代わりに `Symbol.for()` ベースの branding + 静的 `isInstance` メソッドを使い、パッケージ重複時の型判定を安全にする
  - 根拠: langchainjs の `createNamespace` は `Symbol.for()` のグローバル性を利用し、異なるバージョンの `@langchain/core` が共存しても正しく型判定できる（`libs/langchain-core/src/utils/namespace.ts:114-163`）

- `[SHOULD]` フレームワークの基底クラスでは stream/batch 等の高水準メソッドにデフォルト実装を提供し、サブクラスは最小限のメソッド（invoke 相当）のオーバーライドだけで動作するようにする
  - 根拠: `Runnable` は `stream` を `invoke` のラッパーとして提供し、新規プロバイダーの実装コストを最小化している（`libs/langchain-core/src/runnables/base.ts:297-302`）

- `[SHOULD]` プラグインエコシステムを持つフレームワークでは、標準テストスイートを提供して品質基準を担保する
  - 根拠: `@langchain/standard-tests` はプロバイダーが継承するだけで invoke/streaming/tool-calling 等の標準テストが自動実行される（`internal/standard-tests/src/unit_tests/chat_models.ts:37-65`）

- `[AVOID]` コミュニティパッケージに外部依存を `peerDependencies` として際限なく追加する設計。依存が増えるとバージョン不整合のデバッグが困難になる
  - 根拠: `@langchain/community` は 100 以上の optional peerDependencies を抱え、新規追加を停止する判断に至った（`CONTRIBUTING.md:54`）

## 適用チェックリスト

- [ ] ライブラリコードで `process.env` や `Deno.env` を直接参照していないか確認し、環境変数アクセス用のユーティリティ関数に一元化する
- [ ] `instanceof` を使用している箇所を洗い出し、パッケージ境界を越える型判定には Symbol ベースの branding パターンへの置き換えを検討する
- [ ] 設計上の禁止事項（使ってはいけない API、パターン等）が ESLint ルールとして機械的に強制されているか確認する
- [ ] 基底クラスのメソッドにデフォルト実装があり、サブクラスが最小限のオーバーライドで動作するか確認する
- [ ] 外部プラグイン・プロバイダーの品質を保証する標準テストスイートが用意されているか確認する
- [ ] コミュニティパッケージの外部依存が際限なく増えていないか確認し、独立パッケージへの分離を検討する
