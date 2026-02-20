# internationalization-patterns

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod v4 のロケールシステムは、バリデーションエラーメッセージの多言語化を「エラーマップ関数」と「グローバル設定」の組み合わせで実現している。v3 から v4 への移行で、ロケール機構はモジュールレベルの副作用から明示的な設定呼び出しへ再設計され、tree-shaking との両立が図られた。50 以上の言語をサポートしながら、各ロケールファイルは独立したモジュールとしてサブパスエクスポートされ、未使用ロケールがバンドルに含まれない構造になっている。この設計は、ライブラリレベルの i18n アーキテクチャとして汎用性が高い。

## 背景にある原則

- **ロケールは副作用ではなく明示的な設定として注入すべき**: v3 では `defaultErrorMap` がモジュールインポート時に暗黙的に読み込まれていた（`packages/zod/src/v3/errors.ts:2-4`）。v4 では `z.config(en())` という明示的な呼び出しに変更された（`packages/zod/src/v4/classic/external.ts:10-11`）。これにより、どのロケールがアクティブかがコード上で追跡可能になり、Zod Mini ではロケールを一切読み込まない zero-cost パスが実現されている。

- **エラーメッセージのカスタマイズは階層的に解決すべき**: スキーマレベル > パースレベル > グローバルカスタム > ロケール という 4 段階の優先度チェーンがあり、`undefined` を返すことで上位から下位へフォールバックする（`packages/zod/src/v4/core/util.ts:847-852`）。これにより、特定のフィールドだけ独自メッセージにしつつ、残りはロケールに委譲する柔軟な制御が可能になる。

- **ロケールファイルはファクトリ関数として遅延評価すべき**: 各ロケールは `export default function(): { localeError: $ZodErrorMap }` 形式のファクトリ関数であり、呼び出されるまで辞書オブジェクトを生成しない。これにより、動的インポートとの親和性が高まり、`await import(\`zod/v4/locales/${locale}.js\`)` によるランタイムロケール切り替えが自然に実現できる。

- **型安全な issue 構造がロケール実装の正確性を保証すべき**: エラーマップは `$ZodErrorMap` 型（`$ZodRawIssue` の判別共用体を引数に取る関数）として定義されており、`issue.code` で分岐することで各 issue タイプ固有のプロパティ（`minimum`, `maximum`, `expected`, `format` 等）に型安全にアクセスできる。

## 実例と分析

### ロケールファイルの構造パターン

全 50 以上のロケールファイルは統一された構造を持つ。内部に 3 つの辞書（`Sizable`, `FormatDictionary`, `TypeDictionary`）を定義し、`issue.code` に対する `switch` 文でメッセージを組み立てる。

```typescript
// packages/zod/src/v4/locales/en.ts:5-119
const error: () => errors.$ZodErrorMap = () => {
  const Sizable: Record<string, { unit: string; verb: string }> = {
    string: { unit: "characters", verb: "to have" },
    file: { unit: "bytes", verb: "to have" },
    array: { unit: "items", verb: "to have" },
    set: { unit: "items", verb: "to have" },
  };
  // ...辞書定義...
  return (issue) => {
    switch (issue.code) {
      case "invalid_type": { /* ... */ }
      case "too_big": { /* ... */ }
      // ...
    }
  };
};

export default function (): { localeError: errors.$ZodErrorMap } {
  return { localeError: error() };
}
```

注目すべきは、エクスポートが `{ localeError: errors.$ZodErrorMap }` オブジェクトを返すファクトリ関数である点。これは `z.config()` にそのまま spread できる設計であり、将来的にロケールがエラーマップ以外の設定（例: フォーマッタ、プラグイン）を含む場合の拡張性を確保している。

### 言語固有の文法処理

ロケール実装は、対象言語の文法的特性に応じて構造が大きく変化する。

**ロシア語: 複数形処理**（`packages/zod/src/v4/locales/ru.ts:5-23`）

```typescript
function getRussianPlural(count: number, one: string, few: string, many: string): string {
  const absCount = Math.abs(count);
  const lastDigit = absCount % 10;
  const lastTwoDigits = absCount % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) return many;
  if (lastDigit === 1) return one;
  if (lastDigit >= 2 && lastDigit <= 4) return few;
  return many;
}
```

ロシア語の `Sizable` 辞書は `{ one, few, many }` の 3 形態を持ち、英語の単純な `{ unit: string }` とは構造が異なる。

**ヘブライ語: 文法性（ジェンダー）処理**（`packages/zod/src/v4/locales/he.ts:7-53`）

```typescript
const TypeNames: Record<string, { label: string; gender: "m" | "f" }> = {
  string: { label: "מחרוזת", gender: "f" },
  number: { label: "מספר", gender: "m" },
  // ...
};
const verbFor = (t?: string | null): string => {
  const e = typeEntry(t);
  const gender = e?.gender ?? "m";
  return gender === "f" ? "צריכה להיות" : "צריך להיות";
};
```

ヘブライ語ロケールでは型名に文法性を付与し、動詞の活用を切り替えている。これは英語ロケールの単純な辞書構造では対応できない言語固有の要件である。

### エラーメッセージ解決の優先度チェーン

メッセージ解決は `packages/zod/src/v4/core/util.ts:846-854` の `finalizeIssue` 関数で行われる。

```typescript
// packages/zod/src/v4/core/util.ts:847-852
const message =
  unwrapMessage(iss.inst?._zod.def?.error?.(iss as never)) ??    // 1. スキーマレベル
  unwrapMessage(ctx?.error?.(iss as never)) ??                    // 2. パースレベル
  unwrapMessage(config.customError?.(iss)) ??                     // 3. グローバルカスタム
  unwrapMessage(config.localeError?.(iss)) ??                     // 4. ロケール
  "Invalid input";                                                 // 5. ハードコードフォールバック
```

各エラーマップは `string | { message: string } | undefined | null` を返せる。`undefined` を返すと次の階層にフォールバックする。この null 合体チェーンにより、優先度制御が宣言的に表現されている。

### v3 から v4 への設計変遷

v3 のアプローチ（`packages/zod/src/v3/errors.ts:1-13`）:

```typescript
import defaultErrorMap from "./locales/en.js";
let overrideErrorMap = defaultErrorMap;
export function setErrorMap(map: ZodErrorMap) { overrideErrorMap = map; }
export function getErrorMap() { return overrideErrorMap; }
```

v3 では英語ロケールがモジュールスコープで即座に読み込まれ、`let` 変数で上書きする設計。問題点: (1) 英語ロケールが常にバンドルに含まれる、(2) `setErrorMap` は前のマップを完全に置き換えるため、ロケールとカスタムマップの共存が難しい。

v4 では `z.config({ localeError, customError })` で明確に分離され、ロケールとカスタムマップが独立した優先度で共存できるようになった。

### Zod Mini: ゼロコスト i18n

Zod Mini（`packages/zod/src/v4/mini/external.ts`）は `config(en())` を呼ばない。ロケールが未設定の場合、`"Invalid input"` というハードコードされたフォールバックが使われる（`util.ts:852`）。バンドルサイズを極限まで削減したいユースケースでは、ロケールを一切読み込まないパスを選択できる。

### サブパスエクスポートによる個別ロケール読み込み

```json
// packages/zod/package.json（抜粋）
{
  "./v4/locales": { "import": "./v4/locales/index.js" },
  "./v4/locales/*": { "import": "./v4/locales/*" }
}
```

`zod/v4/locales/*` のワイルドカードサブパスにより、`import fr from "zod/v4/locales/fr.js"` のような単一ロケールの直接インポートが可能。バレルファイル（`index.ts`）経由でインポートすると全ロケールがバンドルされるリスクがあるが、個別パスを使えばそれを回避できる。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: エラーメッセージの生成ロジックをロケールごとに差し替える
  - 適用条件: 同一インターフェース（`$ZodErrorMap`）で振る舞いを切り替えたい場合
  - コード例: `packages/zod/src/v4/core/errors.ts:210-213` の `$ZodErrorMap` インターフェースが Strategy の共通契約。各ロケールファイルがConcreteStrategy
  - 注意点: Strategy のインターフェースが issue 型の判別共用体に依存しているため、新しい issue コードを追加すると全ロケールの更新が必要

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: 複数のエラーカスタマイズ手段を優先度順に適用する
  - 適用条件: メッセージ解決を段階的にフォールバックさせたい場合
  - コード例: `packages/zod/src/v4/core/util.ts:847-852` の `??` チェーン
  - 注意点: null 合体演算子による暗黙的なチェーンであり、GoF の典型的な実装（リンクドリスト）ではないが、概念的には同じ

## Good Patterns

- **ファクトリ関数によるロケール遅延生成**: ロケールを `export default function()` で包むことで、インポートしただけでは辞書オブジェクトが生成されない。動的インポートと組み合わせると、ランタイムのロケール切り替えが自然に書ける。

```typescript
// packages/zod/src/v4/locales/en.ts:115-119
export default function (): { localeError: errors.$ZodErrorMap } {
  return {
    localeError: error(),
  };
}
// 使用側
const { default: fr } = await import("zod/v4/locales/fr.js");
z.config(fr());
```

- **`undefined` 返却によるフォールバック制御**: エラーマップが `undefined` を返すと次の優先度層にフォールスルーする設計。これにより「特定のエラーコードだけカスタマイズし、残りはロケールに委譲する」という部分的カスタマイズが実現できる。

```typescript
// packages/docs/content/error-customization.mdx:184-196
z.int64({
  error: (issue) => {
    if (issue.code === "too_big") {
      return { message: `Value must be <${issue.maximum}` };
    }
    return undefined; // ロケールにフォールバック
  },
});
```

- **言語固有の辞書構造の柔軟性**: 共通インターフェース（`$ZodErrorMap` 関数シグネチャ）を維持しつつ、内部辞書構造は言語ごとに自由に設計できる。英語は `{ unit: string }`、ロシア語は `{ one, few, many }`、ヘブライ語は `{ label, gender }` と、言語の文法的要件に応じて異なる。

```typescript
// 英語 (packages/zod/src/v4/locales/en.ts:6-11)
const Sizable: Record<string, { unit: string; verb: string }> = {
  string: { unit: "characters", verb: "to have" },
};

// ロシア語 (packages/zod/src/v4/locales/ru.ts:34-67)
const Sizable: Record<string, RussianSizable> = {
  string: { unit: { one: "символ", few: "символа", many: "символов" }, verb: "иметь" },
};
```

## Anti-Patterns / 注意点

- **バレルファイル経由の全ロケールインポート**: `import { fr } from "zod/locales"` は内部的に `index.ts` を経由し、バンドラーによっては全 50 以上のロケールがバンドルに含まれる。公式ドキュメントでも "In some bundlers, this may not be tree-shakable" と警告されている。

```typescript
// Bad: 全ロケールがバンドルされるリスク
import { fr } from "zod/locales";

// Better: 個別サブパスで必要なロケールのみインポート
import fr from "zod/v4/locales/fr.js";
```

- **ロケール設定のグローバル汚染**: `z.config()` はグローバル状態を変更するため、テストやサーバーサイドレンダリングで並行処理がある場合にロケールが意図せず共有される。

```typescript
// Bad: テスト間でロケール状態がリーク
test("Spanish errors", () => {
  z.config(es()); // グローバル状態を変更
  // ...テスト後にリセットを忘れると他テストに影響
});

// Better: テストごとにロケールをリセット
test("Spanish errors", () => {
  z.config(es());
  try { /* ... */ }
  finally { z.config(en()); }
});
```

- **新しい issue コード追加時の全ロケール更新漏れ**: 各ロケールの `switch` 文に `default` ケースがあるためランタイムエラーにはならないが、新規追加された issue コードに対するメッセージが `"Invalid input"` のような汎用メッセージにフォールバックし、ユーザー体験が劣化する。型レベルの網羅性チェック（exhaustive check）がロケールファイルには適用されていない。

## 導出ルール

- `[MUST]` i18n 対応のエラーメッセージシステムでは、メッセージ解決に優先度チェーンを設け、各層が「処理しない」を返せるようにする
  - 根拠: Zod の 4 層チェーン（スキーマ > パース > グローバル > ロケール）は `undefined` 返却でフォールバックし、部分的カスタマイズとデフォルトロケールを共存させている（`packages/zod/src/v4/core/util.ts:847-852`）

- `[MUST]` ロケールファイルはファクトリ関数として遅延評価可能にし、インポート時に副作用を発生させない
  - 根拠: Zod v4 の各ロケールは `export default function()` 形式で、`z.config(locale())` と明示的に呼ぶまで辞書が生成されない。これにより tree-shaking と動的ロケール切り替えが両立している（`packages/zod/src/v4/locales/en.ts:115-119`）

- `[SHOULD]` ロケールファイルは個別サブパスエクスポートを提供し、バレルファイルに依存しないインポートパスを用意する
  - 根拠: Zod は `"./v4/locales/*"` ワイルドカードサブパスで単一ロケールの直接インポートを可能にし、全ロケールのバンドル化を回避している（`packages/zod/package.json`）

- `[SHOULD]` i18n の共通インターフェースは関数シグネチャで定義し、内部辞書構造はロケールごとに自由に設計できるようにする
  - 根拠: ロシア語の 3 形態複数形、ヘブライ語の文法性など、言語固有の要件は共通の辞書スキーマでは表現できない。Zod は `$ZodErrorMap` 関数型のみを契約とし、内部実装を言語ごとに委ねている（`ru.ts`, `he.ts` 等の比較）

- `[SHOULD]` ロケール未設定時のフォールバックメッセージをハードコードで用意し、ロケール非依存でも最低限動作するようにする
  - 根拠: Zod Mini はロケールを読み込まず、全エラーが `"Invalid input"` にフォールバックする。バンドルサイズ最適化や、i18n が不要なユースケースでゼロコスト動作を保証している（`packages/zod/src/v4/core/util.ts:852`）

- `[AVOID]` ロケール設定をモジュールスコープの可変変数で管理する（グローバルミュータブル状態）
  - 根拠: v3 の `let overrideErrorMap = defaultErrorMap` は状態管理が不透明で、ロケールとカスタムマップの共存が困難だった。v4 では `globalConfig` オブジェクトに `localeError` と `customError` を分離し、明示的な `config()` 呼び出しで設定する設計に改善された（`packages/zod/src/v3/errors.ts` vs `packages/zod/src/v4/core/config.ts`）

## 適用チェックリスト

- [ ] エラーメッセージのカスタマイズが複数レイヤー（スキーマ、リクエスト、グローバル、ロケール）で独立して行えるか
- [ ] ロケールファイルがファクトリ関数または遅延ロード可能な形式になっているか
- [ ] 未使用ロケールがバンドルに含まれないよう、個別サブパスエクスポートまたは動的インポートを提供しているか
- [ ] ロケールの共通インターフェースが関数型（Strategy パターン）で定義され、内部辞書構造が言語ごとに自由に設計できるか
- [ ] ロケール未設定時のフォールバックメッセージが存在し、i18n なしでも動作するか
- [ ] 新しいエラータイプ追加時に全ロケールの更新が必要であることが開発プロセスで検知できるか（CI、型チェック等）
- [ ] グローバルロケール設定がテスト間やリクエスト間で意図せず共有されない仕組みがあるか
