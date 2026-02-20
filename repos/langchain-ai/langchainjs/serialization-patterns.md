# serialization-patterns

> リポジトリ: langchain-ai/langchainjs
> 分析日: 2026-02-20

## 概要

langchainjs は数百のクラス（LLM、プロンプト、メッセージ、ツール等）を統一的にシリアライズ/デシリアライズする仕組みを持つ。`Serializable` 基底クラスが全クラスに共通のシリアライズプロトコルを提供し、シークレットの分離、クロス言語互換性（Python の langchain との ID 互換）、コードミニファイ耐性を実現している。プラグインベースの自動化とエスケープ機構によるインジェクション防御が設計上の注目点である。

## 背景にある原則

- **Opt-in シリアライズ**: デフォルトでは `lc_serializable = false` であり、明示的に `true` にしたクラスのみがシリアライズ対象になる。これにより、内部実装クラスが意図せず永続化されることを防ぐ。シリアライズを許可しないクラスは `toJSONNotImplemented()` で `not_implemented` 型マーカーを返す（`libs/langchain-core/src/load/serializable.ts:178-189`）。

- **シークレットはデータ層で分離する**: API キー等の機密情報はシリアライズ時にセンチネル値（`{lc: 1, type: "secret", id: ["ENV_VAR_NAME"]}`）に置換され、デシリアライズ時に別経路（`secretsMap` または環境変数）から復元される。シリアライズされた JSON にシークレットが平文で含まれることがない。

- **名前空間ベースのクラス解決で安全にデシリアライズする**: デシリアライズ時にクラスを特定するために `lc_namespace` + `lc_name` からなる ID パスを使い、事前登録された `importMap` からのみクラスをインスタンス化する。任意のクラスが実行されるリスクをインポートマップの許可リストで制限している。

- **クロス言語互換を型変換レイヤーで吸収する**: JavaScript の camelCase と Python の snake_case の差異を `keyToJson` / `keyFromJson` で自動変換し、さらに `lc_aliases` で個別のキー名マッピングを宣言できる。これにより同じ JSON を Python/JS 間で共有できる。

## 実例と分析

### シリアライズプロトコルの階層設計

`Serializable` 基底クラスは5つの宣言的ゲッターでサブクラスにシリアライズの振る舞いを定義させる:

1. **`lc_namespace`** (必須): モジュールパスを表す文字列配列。デシリアライズ時のクラス検索に使われる
2. **`lc_secrets`**: シークレットフィールドのパスと環境変数名のマッピング
3. **`lc_aliases`**: JS のプロパティ名とシリアライズ後のキー名のマッピング
4. **`lc_attributes`**: コンストラクタ引数にない追加属性（`undefined` 値で除外にも使える）
5. **`lc_serializable_keys`**: シリアライズ対象のキーを明示的に制限するホワイトリスト

この設計により、サブクラスは命令的コードを書かずに宣言的にシリアライズの挙動をカスタマイズできる。

### プロバイダー間で一貫したシークレット宣言

30以上のプロバイダーが同じパターンで `lc_secrets` を宣言している。

```typescript
// libs/providers/langchain-anthropic/src/chat_models.ts:949-954
get lc_secrets(): { [key: string]: string } | undefined {
  return {
    anthropicApiKey: "ANTHROPIC_API_KEY",
    apiKey: "ANTHROPIC_API_KEY",
  };
}
```

```typescript
// libs/providers/langchain-openai/src/chat_models/base.ts:372-377
get lc_secrets(): { [key: string]: string } | undefined {
  return {
    apiKey: "OPENAI_API_KEY",
    organization: "OPENAI_ORGANIZATION",
  };
}
```

ビルドプラグイン `lc-secrets`（`internal/build/src/plugins/lc-secrets.ts`）が AST 解析で全パッケージの `lc_secrets` を自動スキャンし、`SecretMap` 型定義を自動生成する。この仕組みにより、新しいプロバイダーが追加されてもシークレット宣言の一貫性が静的に保証される。

### lc_attributes によるフィールド除外

`lc_attributes` で `undefined` 値を返すことで、そのフィールドをシリアライズ出力から除外できる:

```typescript
// libs/langchain-core/src/language_models/base.ts:259-264
get lc_attributes(): { [key: string]: undefined } | undefined {
  return {
    callbacks: undefined,  // コールバックはシリアライズ不要
    verbose: undefined,    // ランタイム設定はシリアライズ不要
  };
}
```

`toJSON()` 内部で `Reflect.get` を使ってプロトタイプチェーン全体の `lc_attributes` をマージするため、親クラスが除外したフィールドは子クラスでも除外される（`serializable.ts:199-207`）。

### lc_serializable_keys によるホワイトリスト制御

OpenAI プロバイダーではコンストラクタに渡される全フィールドのうち、シリアライズすべきフィールドだけを明示的にリストしている:

```typescript
// libs/providers/langchain-openai/src/chat_models/base.ts:386-426
get lc_serializable_keys(): string[] {
  return [
    "configuration", "logprobs", "topLogprobs",
    "temperature", "maxTokens", "topP",
    "model", "modelName", "streaming",
    "apiKey", "maxRetries", "verbose",
    // ... 20+ フィールド
  ];
}
```

子クラスは `...super.lc_serializable_keys` でスプレッドして追加フィールドを宣言する:

```typescript
// libs/providers/langchain-openai/src/chat_models/index.ts:605-606
get lc_serializable_keys(): string[] {
  return [...super.lc_serializable_keys, "useResponsesApi"];
}
```

### エスケープ機構によるインジェクション防御

ユーザーデータに `{lc: 1, type: "secret", id: ["ENV_VAR"]}` のような構造が含まれていても、シリアライズ時に `__lc_escaped__` ラッパーで包まれるため、デシリアライズ時に LC オブジェクトとして解釈されない:

```typescript
// libs/langchain-core/src/load/validation.ts:16-20
export function needsEscaping(obj: Record<string, unknown>): boolean {
  return (
    "lc" in obj || (Object.keys(obj).length === 1 && LC_ESCAPED_KEY in obj)
  );
}
```

デシリアライズ時はエスケープされたオブジェクトを検出して先にアンラップし、LC オブジェクトとしての処理をスキップする（`load/index.ts:243-246`）。この「許可リスト方式」により、`Serializable.toJSON()` が生成した正規の LC オブジェクトのみがインスタンス化される。

### ミニファイ耐性のための static lc_name

JavaScript のミニファイでクラス名が破壊されるため、`static lc_name()` でシリアライズ用の安定した名前を宣言する:

```typescript
// libs/providers/langchain-anthropic/src/chat_models.ts:945-947
static lc_name() {
  return "ChatAnthropic";
}
```

`get_lc_unique_name()` は `lc_name` がサブクラスで明示的にオーバーライドされているかをプロトタイプチェーンで判定し、オーバーライドされていれば `lc_name()` を、されていなければ `constructor.name` をフォールバックとして使う（`serializable.ts:61-76`）。

### BaseCallbackHandler: Serializable を継承せずプロトコルを実装

`BaseCallbackHandler` は `Serializable` を直接継承せず、同じインターフェースを手動で実装し、メソッドは `Serializable.prototype` を借用している:

```typescript
// libs/langchain-core/src/callbacks/base.ts:397-403
toJSON(): Serialized {
  return Serializable.prototype.toJSON.call(this);
}

toJSONNotImplemented(): SerializedNotImplemented {
  return Serializable.prototype.toJSONNotImplemented.call(this);
}
```

これは多重継承が使えない TypeScript で、既存の継承チェーン（EventEmitter 系）を壊さずにシリアライズ能力を付与するための pragmatic な解法である。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 数百のサブクラスそれぞれで異なるシリアライズ方針（どのフィールドを含めるか、シークレットは何か）を統一的なインターフェースで扱う
  - 適用条件: 基底クラスがアルゴリズムの骨格を提供し、サブクラスが宣言的ゲッターで詳細を注入する
  - コード例: `serializable.ts:97-270`（基底クラスの `toJSON()` がゲッターを組み合わせる）
  - 注意点: ゲッターが多すぎると認知負荷が高くなる（langchainjs は5つ）

- **Registry パターン** (分類: 生成)
  - 解決する問題: シリアライズされた ID 文字列からクラスを安全に逆引きする
  - 適用条件: 動的にクラスを解決する必要があるが、任意のクラスの実行は許可したくない
  - コード例: `load/index.ts:297-407`（`importMap` + `optionalImportsMap` による許可リスト）
  - 注意点: レジストリが大きくなるとメンテナンスコストが増す。自動生成プラグインで対処

- **Sentinel パターン** (分類: セキュリティ)
  - 解決する問題: シリアライズされた JSON 内のシークレットフィールドを安全にマーキングし、デシリアライズ時に別経路で復元する
  - 適用条件: 永続化データにシークレットを含めたくないが、復元時には必要
  - コード例: `serializable.ts:30-55`（`replaceSecrets`）、`load/index.ts:249-267`（復元）
  - 注意点: センチネル値自体がユーザーデータと衝突しないようエスケープが必要

## Good Patterns

- **宣言的シリアライズプロトコル**: サブクラスはゲッターを定義するだけでシリアライズ挙動を制御でき、`toJSON()` の命令的ロジックに触れる必要がない。新しいプロバイダーの統合テンプレート（`libs/create-langchain-integration/template/src/chat_models.ts:40-61`）では4つのゲッター（`lc_name`, `lc_secrets`, `lc_aliases`, `lc_serializable`）を埋めるだけでシリアライズ対応が完了する。

- **プロトタイプチェーン走査によるゲッターマージ**: `toJSON()` 内で `Object.getPrototypeOf` を再帰的に辿り、全祖先クラスの `lc_secrets`, `lc_aliases`, `lc_attributes` をマージする（`serializable.ts:199-207`）。これにより親クラスで宣言したシークレットは子クラスで再宣言不要になる。

```typescript
// libs/langchain-core/src/load/serializable.ts:199-207
for (
  let current = Object.getPrototypeOf(this);
  current;
  current = Object.getPrototypeOf(current)
) {
  Object.assign(aliases, Reflect.get(current, "lc_aliases", this));
  Object.assign(secrets, Reflect.get(current, "lc_secrets", this));
  Object.assign(kwargs, Reflect.get(current, "lc_attributes", this));
}
```

- **ビルド時 AST スキャンによるシークレット型安全性**: `lc-secrets` Rolldown プラグインがビルド時にソースコード全体の `lc_secrets` ゲッターを AST 解析し、シークレット名のバリデーション（大文字・スペースなし）と型定義の自動生成を行う（`internal/build/src/plugins/lc-secrets.ts:92-148`）。

- **再帰深度制限によるデシリアライズ保護**: `reviver` 関数に `maxDepth` パラメータ（デフォルト 50）を設け、深くネストされた悪意あるペイロードによるスタックオーバーフローを防止する（`load/index.ts:219-225`）。

## Anti-Patterns / 注意点

- **secretsFromEnv=true のデフォルト化**: デシリアライズ時に `secretsFromEnv: true` を安易にデフォルトにすると、シリアライズされた JSON に環境変数名を仕込むことで任意の環境変数を読み取れてしまう。langchainjs は意図的にデフォルトを `false` にしている。

```typescript
// Bad: デフォルトで環境変数からシークレットを読む
const result = await load(userInput, { secretsFromEnv: true });

// Better: 必要なシークレットのみ明示的に渡す
const result = await load(trustedData, {
  secretsMap: { OPENAI_API_KEY: process.env.OPENAI_API_KEY! },
});
```

- **インポートマップのユーザー入力からの構築**: `importMap` や `optionalImportsMap` をユーザー入力から動的に構築すると、攻撃者が任意のクラスをインスタンス化できてしまう。

```typescript
// Bad: ユーザー入力からインポートマップを構築
const result = await load(data, {
  optionalImportsMap: buildMapFromUserConfig(userConfig),
});

// Better: ビルド時に静的に定義されたマップのみ使用
const result = await load(data, {
  optionalImportsMap: STATIC_IMPORT_MAP,
});
```

- **コンストラクタ引数をそのまま全フィールドシリアライズ**: `lc_serializable_keys` を定義しないと、コンストラクタに渡された全引数がシリアライズ対象になる。HTTP クライアントインスタンスやコールバック関数など、シリアライズ不適切なオブジェクトが含まれるリスクがある。OpenAI プロバイダーが明示的ホワイトリストを採用している理由（`chat_models/base.ts:386-426`）。

## 導出ルール

- `[MUST]` シリアライズ対象クラスでは、シークレットフィールドをシリアライズデータから除外し、復元時に別経路（環境変数、シークレットストア等）から注入する仕組みを設ける
  - 根拠: langchainjs の全プロバイダー（30+）が `lc_secrets` でシークレットをセンチネル値に置換し、永続化データにクレデンシャルを含めない設計を徹底している（`serializable.ts:30-55`）

- `[MUST]` デシリアライズ時にインスタンス化可能なクラスを許可リスト（レジストリ/インポートマップ）で制限する
  - 根拠: langchainjs は `importMap` による静的なクラスレジストリのみからインスタンス化を許可し、未登録のクラスパスに対しては `Invalid namespace` エラーを投げる（`load/index.ts:297-407`）

- `[SHOULD]` シリアライズの振る舞いは基底クラスの宣言的プロトコル（ゲッターやメタデータ）で定義し、サブクラスでは `toJSON()` を直接オーバーライドしない
  - 根拠: langchainjs の 100+ のシリアライズ対応クラスは `toJSON()` をオーバーライドせず、5つの宣言的ゲッター（`lc_secrets`, `lc_aliases`, `lc_attributes`, `lc_serializable_keys`, `lc_namespace`）のみで挙動を制御している

- `[SHOULD]` シリアライズ対象フィールドをホワイトリストで明示的に制限し、コンストラクタ引数の全フィールドを暗黙的にシリアライズしない
  - 根拠: OpenAI プロバイダーは `lc_serializable_keys` で 25 フィールドを明示し、HTTP クライアント等のシリアライズ不適切なオブジェクトの混入を防いでいる（`chat_models/base.ts:386-426`）

- `[SHOULD]` クロス言語互換が必要なシリアライズでは、キー名の変換（camelCase/snake_case 等）をシリアライズレイヤーに集約し、ドメインロジックから分離する
  - 根拠: langchainjs は `keyToJson`/`keyFromJson` と `lc_aliases` の2段階で変換を吸収し、ドメインクラスは JS の命名規約のまま実装できる（`map_keys.ts:13-35`）

- `[SHOULD]` ミニファイ環境でクラスのシリアライズ名が破壊される場合、安定した名前を静的メソッドで宣言する
  - 根拠: langchainjs の `static lc_name()` はミニファイで `constructor.name` が変わっても同じ名前を返し、シリアライズ/デシリアライズの整合性を保つ（`serializable.ts:61-76`）

- `[AVOID]` デシリアライズ時にユーザー入力から環境変数を直接読み取る設定をデフォルトで有効にしない
  - 根拠: langchainjs は `secretsFromEnv` をデフォルト `false` にし、悪意あるペイロードによる環境変数リークを防いでいる（`load/index.ts:110`）

- `[AVOID]` ユーザー入力に基づいてデシリアライズのクラスレジストリ（インポートマップ）を拡張しない
  - 根拠: langchainjs のドキュメントと型定義で `importMap` / `optionalImportsMap` をユーザー入力から構築しないよう繰り返し警告している（`load/index.ts:113-134`）

## 適用チェックリスト

- [ ] シリアライズ対象クラスにシークレットフィールド（API キー、トークン等）があるか確認し、シリアライズから除外する仕組みがあるか検証する
- [ ] デシリアライズで復元可能なクラスが許可リストで制限されているか確認する
- [ ] シリアライズの振る舞い定義が宣言的（メタデータ/ゲッター）になっているか、各サブクラスで命令的にシリアライズロジックを書いていないか確認する
- [ ] コンストラクタ引数の全フィールドがシリアライズされていないか確認し、不要なフィールド（HTTP クライアント、コールバック等）が含まれていないか検証する
- [ ] ミニファイ環境でクラス名が破壊される可能性がある場合、安定したシリアライズ名を宣言する仕組みがあるか確認する
- [ ] ユーザーデータがシリアライズ形式のメタデータ（マジックキー等）と衝突する場合のエスケープ機構があるか確認する
- [ ] デシリアライズの再帰深度に上限を設けて、悪意あるネストによる DoS を防いでいるか確認する
