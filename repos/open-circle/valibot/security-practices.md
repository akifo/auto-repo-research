# security-practices

> リポジトリ: open-circle/valibot
> 分析日: 2026-02-16

## 概要

valibot はバリデーションライブラリという性質上、セキュリティがライブラリ設計の根幹に組み込まれている。ユーザーが提供する任意の入力データを安全に検証・変換するため、ReDoS 防御、プロトタイプ汚染ガード、リソース枯渇対策が体系的に実装されている。注目に値するのは、これらのセキュリティ対策がコードレビューの人的チェックではなく、ESLint プラグインによる自動検出と、ランタイムのガード関数という二重防御で実現されている点である。

## 背景にある原則

- **正規表現は攻撃ベクトルである**: バリデーションライブラリでは正規表現がホットパスに位置するため、ReDoS に対して構造的に脆弱になる。人間のレビューではなく静的解析ツール（`eslint-plugin-redos-detector`, `eslint-plugin-regexp`）で機械的に防御すべきである。根拠: `library/eslint.config.js` で `redos-detector/no-unsafe-regex: error` と `regexp/no-super-linear-move: error` を併用している。

- **信頼境界は入口で厳格に、内部は前提を置いて軽量に**: スキーマの `~run` メソッドは入力を `unknown` として受け取り、型チェック後に `dataset.typed = true` を設定する。以降のバリデーションアクションは `dataset.typed` を前提条件として動作するため、型チェックの二重実行を避けながら安全性を維持する。根拠: 全スキーマの `~run` で `typeof` チェック後に `typed` フラグを設定するパターン。

- **プロトタイプチェーンは暗黙の攻撃面である**: JavaScript のオブジェクト操作（`for...in`, `in` 演算子）はプロトタイプチェーンを走査するため、`__proto__`・`prototype`・`constructor` キーが混入するとプロトタイプ汚染が発生する。動的キーを扱う箇所には必ず明示的なガード関数を挟むべきである。根拠: `_isValidObjectKey` が `record`, `looseObject`, `objectWithRest` の全てで使用されている。

- **DoS 耐性は機能設計に組み込む**: セキュリティ対策を後付けするのではなく、機能の振る舞い自体に組み込む。`strictObject` が未知キーの検出を最初の1件で打ち切るのは、「全件報告」という機能要求よりもリソース枯渇防止を優先した設計判断である。根拠: `strictObject.ts:219-223` のコメント。

## 実例と分析

### 1. 三層の正規表現安全性検証

valibot は正規表現の安全性を3つの ESLint プラグインで多層的に検証している。

`eslint-plugin-redos-detector` は ReDoS 脆弱性を静的解析で検出する。`eslint-plugin-regexp` は `no-super-linear-move`（超線形移動によるDoS）と `require-unicode-regexp`（Unicode モードの強制）を提供する。`eslint-plugin-security` は推奨設定を適用しつつ、`detect-unsafe-regex` は偽陽性が多いため無効化し、より精度の高い `redos-detector` に委譲している。

```typescript
// library/eslint.config.js:86-98
// RegExp
'regexp/no-super-linear-move': 'error', // Prevent DoS regexps
'regexp/no-control-character': 'error', // Avoid unneeded regexps characters
'regexp/no-octal': 'error', // Avoid unneeded regexps characters
'regexp/no-standalone-backslash': 'error', // Avoid unneeded regexps characters
'regexp/prefer-escape-replacement-dollar-char': 'error', // Avoid unneeded regexps characters
'regexp/prefer-quantifier': 'error', // Avoid unneeded regexps characters
'regexp/hexadecimal-escape': ['error', 'always'], // Avoid unneeded regexps characters
'regexp/sort-alternatives': 'error', // Avoid unneeded regexps characters
'regexp/require-unicode-regexp': 'error', // /u flag is faster and enables regexp strict mode
'regexp/prefer-regexp-exec': 'error', // Enforce that RegExp#exec is used instead of String#match if no global flag is provided, as exec is faster

// Redos detector
'redos-detector/no-unsafe-regex': ['error', { ignoreError: true }], // Prevent DoS regexps
```

偽陽性の抑制は `-- false positive` コメント付きの明示的な disable で行われている。

```typescript
// library/src/regex.ts:20-21
// eslint-disable-next-line redos-detector/no-unsafe-regex -- false positive
export const DECIMAL_REGEX: RegExp = /^[+-]?(?:\d*\.)?\d+$/u;
```

ライブラリ全体でこの disable は4箇所のみであり、各箇所に理由が記載されている。

### 2. 正規表現パターンの一元管理

全てのビルトイン正規表現パターンは `library/src/regex.ts` に集約されている。各 action（`email`, `uuid`, `ipv4` 等）はこのファイルからインポートして使う。

```typescript
// library/src/regex.ts:31-32
export const EMAIL_REGEX: RegExp = /^[\w+-]+(?:\.[\w+-]+)*@[\da-z]+(?:[.-][\da-z]+)*\.[a-z]{2,}$/iu;
```

```typescript
// library/src/actions/email/email.ts:1
import { EMAIL_REGEX } from "../../regex.ts";
```

一元管理の利点: (1) ReDoS 検査対象を一箇所に集中できる、(2) 同じパターンの重複定義を防げる、(3) パターン更新時の影響範囲が明確になる。

### 3. プロトタイプ汚染ガード

`_isValidObjectKey` は3つの攻撃ベクトルを同時に遮断する。

```typescript
// library/src/utils/_isValidObjectKey/_isValidObjectKey.ts:13-19
export function _isValidObjectKey(object: object, key: string): boolean {
  return (
    Object.hasOwn(object, key)
    && key !== "__proto__"
    && key !== "prototype"
    && key !== "constructor"
  );
}
```

この関数は動的キーを扱う全てのオブジェクト系スキーマ（`record`, `looseObject`, `objectWithRest`）で使用されている。テストでは `JSON.parse('{"__proto__": 123, "foo": 456}')` のような攻撃ペイロードが正しくフィルタされることを検証している。

```typescript
// library/src/schemas/record/record.test.ts:69-75
test("for record with __proto__ key", () => {
  const input = JSON.parse('{"__proto__": 123, "foo": 456}');
  expect(schema["~run"]({ value: input }, {})).toStrictEqual({
    typed: true,
    value: { foo: 456 },
  });
});
```

### 4. strictObject のリソース枯渇防止

`strictObject` は未知のキーを検出してエラーにするが、意図的に最初の1件で検査ループを打ち切る。

```typescript
// library/src/schemas/strictObject/strictObject.ts:200-226
for (const key in input) {
  if (!(key in this.entries)) {
    _addIssue(this, "key", dataset, config, {
      input: key,
      expected: "never",
      path: [
        {
          type: "object",
          origin: "key",
          input: input as Record<string, unknown>,
          key,
          value: input[key],
        },
      ],
    });

    // Hint: We intentionally break the loop after the first unknown
    // entries. Otherwise, attackers could send large objects to
    // exhaust device resources. If you want an issue for every
    // unknown key, use the `objectWithRest` schema with `never` for
    // the `rest` argument.
    break;
  }
}
```

全件報告が必要なユースケースには `objectWithRest(entries, never())` という代替パスを用意し、デフォルトの安全性を犠牲にしない設計としている。

### 5. object スキーマによる暗黙のキーストリッピング

`object` スキーマ（`strictObject` でも `looseObject` でもないデフォルト）は、定義されたキーのみを出力オブジェクトにコピーする。未知のキーは無視される（エラーにもならない）。これは mass assignment 攻撃に対する防御層として機能する。

```typescript
// library/src/schemas/object/object.ts:98-107
'~run'(dataset, config) {
  const input = dataset.value;
  if (input && typeof input === 'object') {
    dataset.typed = true;
    dataset.value = {};  // 空オブジェクトから再構築

    for (const key in this.entries) {  // スキーマ定義のキーのみ走査
      // ...
    }
```

入力オブジェクトを直接渡すのではなく、空オブジェクトに必要なキーだけをコピーする再構築パターンにより、未定義プロパティの漏洩を構造的に防いでいる。

### 6. セキュリティツール選定のトレードオフ判断

`eslint-plugin-security` の `detect-unsafe-regex` を無効化し、`redos-detector` に置き換えている。

```typescript
// library/eslint.config.js:119-120
'security/detect-object-injection': 'off', // Too many false positives
'security/detect-unsafe-regex': 'off', // Too many false positives, see https://github.com/eslint-community/eslint-plugin-security/issues/28 - we use the redos-detector plugin instead
```

偽陽性が多いツールを「念のため」有効にするのではなく、より精度の高い代替ツールに置き換えることで、開発者がルールを無視する習慣（アラート疲れ）を防いでいる。

## パターンカタログ

- **Whitelist Pattern** (分類: セキュリティ/入力検証)
  - 解決する問題: 未知の入力プロパティによる攻撃（mass assignment, prototype pollution）
  - 適用条件: 外部入力をオブジェクトとして受け取る場面
  - コード例: `library/src/schemas/object/object.ts:107` - スキーマ定義のキーのみを走査して再構築
  - 注意点: `looseObject` を使うと未知キーが通過するため、セキュリティ要件に応じて使い分ける

- **Guard Function Pattern** (分類: セキュリティ/防御)
  - 解決する問題: 危険な操作の散在と検証漏れ
  - 適用条件: 同じセキュリティチェックが複数箇所で必要な場面
  - コード例: `library/src/utils/_isValidObjectKey/_isValidObjectKey.ts:13` - プロトタイプ汚染チェックを1関数に集約
  - 注意点: ガード関数を迂回するコードパスが生まれないよう、使用箇所を網羅的にテストする

## Good Patterns

- **正規表現の安全性を ESLint で自動検証する**: 人間のレビューに頼らず、`eslint-plugin-redos-detector` と `eslint-plugin-regexp` で ReDoS 脆弱性を CI で自動検出する。偽陽性の disable には必ず理由を記載する。

```typescript
// library/eslint.config.js:98
'redos-detector/no-unsafe-regex': ['error', { ignoreError: true }],
```

- **正規表現パターンを単一ファイルに集約する**: `regex.ts` に全パターンを集約し、各 action はインポートして使う。セキュリティ監査の範囲を明確にし、パターンの重複を防止する。

```typescript
// library/src/regex.ts:4-5
export const BASE64_REGEX: RegExp = /^(?:[\da-z+/]{4})*(?:[\da-z+/]{2}==|[\da-z+/]{3}=)?$/iu;
```

- **エラー報告にリソース上限を設ける**: `strictObject` の未知キー検出は最初の1件でループを打ち切る。攻撃者が大量のキーを送信してもリソース消費が一定に保たれる。

```typescript
// library/src/schemas/strictObject/strictObject.ts:219-223
// Hint: We intentionally break the loop after the first unknown
// entries. Otherwise, attackers could send large objects to
// exhaust device resources.
break;
```

- **オブジェクト再構築による安全な出力**: 入力オブジェクトをそのまま返すのではなく、空オブジェクトに定義済みキーだけをコピーする。未定義プロパティの漏洩を構造的に防止する。

```typescript
// library/src/schemas/object/object.ts:104-107
dataset.typed = true;
dataset.value = {};
for (const key in this.entries) {
```

## Anti-Patterns / 注意点

- **偽陽性の多いセキュリティルールをそのまま有効にする**: `eslint-plugin-security` の `detect-unsafe-regex` は偽陽性が多く、開発者がアラートを無視する「アラート疲れ」を引き起こす。精度の低いルールは無効化し、より精度の高い代替ツールに置き換えるべき。

```typescript
// Bad: 偽陽性の多いルールを有効のままにする
pluginSecurity.configs.recommended,
// eslint-disable-next-line security/detect-unsafe-regex  // 毎回 disable が必要

// Better: 精度の低いルールを無効化し、専用ツールに委譲する
'security/detect-unsafe-regex': 'off', // redos-detector を代替として使用
'redos-detector/no-unsafe-regex': ['error', { ignoreError: true }],
```

- **動的キーのオブジェクト操作でプロトタイプチェーンを考慮しない**: `for...in` や `key in obj` はプロトタイプチェーンを走査するため、`JSON.parse` 等で生成されたオブジェクトの `__proto__` キーがすり抜ける。

```typescript
// Bad: hasOwn チェックなしで動的キーを使う
for (const key in input) {
  output[key] = input[key]; // __proto__ が混入する可能性
}

// Better: ガード関数で安全なキーのみを通す
for (const key in input) {
  if (_isValidObjectKey(input, key)) {
    output[key] = input[key];
  }
}
```

- **バリデーションエラーの全件収集をデフォルトにする**: 未知キーや不正入力のエラーを全件収集すると、攻撃者が大量のデータを送信してリソースを枯渇させられる。デフォルトは早期打ち切り、全件収集はオプトインにすべき。

## 導出ルール

> このセクションは必須。最低 3 個のルールを記載すること。synthesis-writer が rules.md 生成時に参照する。
> リトマステスト: 「このリポジトリを知らない開発者が読んで、自分のコードに適用できるか？」-- Yes でなければ抽象度が不足している。

- `[MUST]` ユーザー入力を含む正規表現には ReDoS 検出ツール（`eslint-plugin-redos-detector` 等）を CI で適用する
  - 根拠: valibot は `redos-detector/no-unsafe-regex: error` を設定し、全正規表現を自動検査している（`library/eslint.config.js:98`）
- `[MUST]` 動的キーでオブジェクトを操作する際は `__proto__`・`prototype`・`constructor` を明示的にブロックする
  - 根拠: `_isValidObjectKey` が `record`, `looseObject`, `objectWithRest` の全箇所で使用され、テストで `JSON.parse('{"__proto__": ...}')` の遮断を検証している（`library/src/utils/_isValidObjectKey/_isValidObjectKey.ts:13-19`）
- `[SHOULD]` プロジェクト内の正規表現パターンは単一ファイルに集約し、セキュリティ監査の範囲を明確にする
  - 根拠: `library/src/regex.ts` に全パターンを集約し、各 action はインポートで参照している
- `[SHOULD]` セキュリティ系 ESLint プラグインで偽陽性が多いルールは無効化し、より精度の高い代替ツールに置き換える（アラート疲れの防止）
  - 根拠: `security/detect-unsafe-regex: off` とし `redos-detector` に委譲している（`library/eslint.config.js:120`）
- `[SHOULD]` バリデーションのエラー報告にはリソース上限を設け、デフォルトで早期打ち切りを行う
  - 根拠: `strictObject` は未知キー検出を最初の1件で `break` し、コメントで理由を明記している（`library/src/schemas/strictObject/strictObject.ts:219-223`）
- `[SHOULD]` 外部入力のオブジェクトはそのまま返さず、ホワイトリスト方式で必要なキーのみを新しいオブジェクトにコピーして再構築する
  - 根拠: `object` スキーマは `dataset.value = {}` で空オブジェクトを作り、定義済みキーだけをコピーする（`library/src/schemas/object/object.ts:104-107`）
- `[AVOID]` 偽陽性の多いセキュリティルールを「念のため」有効にしたまま運用すること -- 開発者がルールを無視する習慣が定着する
  - 根拠: valibot は `security/detect-object-injection: off` を明示的に設定し、コメントで理由を記載している（`library/eslint.config.js:119`）

## 適用チェックリスト

- [ ] プロジェクトに `eslint-plugin-redos-detector`（または同等の ReDoS 検出ツール）を導入し、`no-unsafe-regex: error` を設定しているか
- [ ] `eslint-plugin-regexp` の `no-super-linear-move` と `require-unicode-regexp` を有効にしているか
- [ ] 正規表現パターンが専用ファイルに集約されているか（散在していないか）
- [ ] 動的キーでオブジェクトを操作する全箇所で `__proto__`・`prototype`・`constructor` をブロックしているか
- [ ] オブジェクトバリデーション後の出力は入力オブジェクトの参照ではなく、再構築されたオブジェクトか
- [ ] エラー報告のループにリソース上限（件数制限や早期打ち切り）が設けられているか
- [ ] セキュリティ系 ESLint ルールの偽陽性を `eslint-disable` で個別に潰していないか（代替ツールへの置き換えを検討したか）
- [ ] セキュリティポリシー（`SECURITY.md`）に脆弱性報告の連絡先が記載されているか
