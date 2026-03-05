# migration-patterns

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn/ui CLI が提供する3つのマイグレーションスクリプト（icons / radix / rtl）と、それを支える共通変換基盤の設計を分析する。ユーザーが所有するコードを自動書き換えする CLI ツールの設計パターンとして、AST ベース変換とテキスト正規表現変換の使い分け、安全なマイグレーション戦略（確認プロンプト・段階実行・手動レビュー通知）、マッピングテーブル駆動の変換設計が注目に値する。

## 背景にある原則

- **変換精度に応じた手法の選択**: AST 操作（ts-morph）と正規表現を混在して使い分けている。import 文の構造的操作には AST を、Tailwind クラス名のようなドメイン固有の文字列書き換えには正規表現+マッピングテーブルを採用している。正規表現のみでは import 文のスコープやエイリアスの扱いが破綻するが、CSS クラス名のような線形トークン列には AST パースのコストが過剰になるため（`migrate-radix.ts:274`, `transform-rtl.ts:141-247`）

- **非破壊的マイグレーション**: 旧依存関係を自動削除せず、新しい依存関係を追加した上でユーザーに確認を委ねる設計を採っている。`migrateRadix` は `@radix-ui/react-*` パッケージを package.json から削除せず、移行完了後に「削除可能なパッケージ」を一覧表示するのみ。破壊的な変更をツールが自動実行するリスクを避ける判断（`migrate-radix.ts:252-257`）

- **マッピングテーブル駆動の変換**: 変換ロジックをコードとデータに明確に分離している。RTL 変換は4種類のマッピングテーブル（直接置換・translate-x 追加・reverse 追加・swap 追加）を定義し、`applyRtlMapping` 関数が一律に処理する。アイコン移行もレジストリから取得したマッピングデータに基づいて変換する。変換規則の追加・修正がデータの変更のみで完結する（`transform-rtl.ts:11-92`）

- **段階的安全弁の設計**: preflight チェック → 確認プロンプト → 変換実行 → 手動レビュー通知の段階を踏む。RTL マイグレーションでは `FILES_NEEDING_MANUAL_REVIEW` で自動変換だけでは不十分なファイルを事前に定義し、完了後にユーザーへ警告する（`migrate-rtl.ts:12-16, 149-158`）

## 実例と分析

### 3つのマイグレーションスクリプトの構造比較

3つのマイグレーション（icons, radix, rtl）は共通のアーキテクチャに従いつつ、変換対象の特性に応じて異なるアプローチを採用している。

| マイグレーション | 変換対象                    | 手法                              | データソース                           |
| ---------------- | --------------------------- | --------------------------------- | -------------------------------------- |
| icons            | import 文 + JSX タグ名      | ts-morph AST                      | レジストリ API + LEGACY_ICON_LIBRARIES |
| radix            | import 文 + Slot 使用箇所   | 正規表現 + 文字列操作             | 正規表現パターン + ハードコードルール  |
| rtl              | className 文字列 + JSX 属性 | ts-morph AST + マッピングテーブル | RTL_MAPPINGS 定数配列                  |

`icons` と `rtl` は ts-morph を使った AST 操作を採用しているのに対し、`radix` は正規表現ベースのアプローチを採用している。この違いは import 文のパースにおいて興味深い対比を生む。`radix` は複雑な正規表現 1 つで全パターンを捕捉しようとし、結果として 450 行超のファイルになっている。

### ファイル探索パターンの重複と共通化

`migrateRadix` と `migrateRtl` は、ファイル探索ロジック（パス指定 / glob / デフォルト UI パス）がほぼ同一のコードで重複している。

```
// migrate-radix.ts:109-158 と migrate-rtl.ts:28-77 がほぼ同一
if (options.path) {
  basePath = config.resolvedPaths.cwd
  const isGlob = options.path.includes("*")
  if (isGlob) {
    files = await fg(options.path, { cwd: basePath, onlyFiles: true, ignore: ["**/node_modules/**"] })
  } else {
    // ... stat → directory or file
  }
} else {
  basePath = config.resolvedPaths.ui
  files = await fg("**/*.{js,ts,jsx,tsx}", { cwd: basePath, onlyFiles: true })
}
```

この重複は、マイグレーションスクリプトが独立して開発されたことを示唆する。共通のファイル探索ユーティリティに抽出すべきポイントだが、現状は各マイグレーションが自己完結的であることで、個別のデバッグやテストが容易になっている。

### Transformer パイプラインとの関係

`utils/transformers/index.ts` は `add` コマンドで使われるパイプライン型変換基盤を提供し、`transformImport`, `transformRsc`, `transformCssVars`, `transformTwPrefixes`, `transformRtl`, `transformIcons`, `transformCleanup` を順次適用する。マイグレーションスクリプトはこのパイプラインを使わず、独自にファイル読み書きと変換を実行している。

```
// utils/transformers/index.ts:42-52
export async function transform(
  opts: TransformOpts,
  transformers: Transformer[] = [
    transformImport, transformRsc, transformCssVars,
    transformTwPrefixes, transformRtl, transformIcons,
    transformCleanup,
  ]
)
```

これは「新しいコンポーネントの追加時」の変換と「既存コードのマイグレーション時」の変換では要件が異なるため。追加時はレジストリのテンプレートをプロジェクトの設定に合わせるが、マイグレーション時はユーザーの既存コードを変換する。

### RTL マッピングテーブルの順序設計

RTL マッピングテーブルは、部分一致の誤変換を防ぐために明示的な順序制約を持つ。

```
// transform-rtl.ts:8-10 のコメント
// Order matters to avoid partial matches:
// - Negative prefixes before positive (e.g., -ml- before ml-).
// - Specific corners before general ones e.g. rounded-tl- before rounded-l-.
// - With-value variants before without-value (e.g., border-l- before border-l).
```

この順序依存は `startsWith` マッチングの副作用であり、物理クラスから論理クラスへの変換で `-ml-` と `ml-` のような接頭辞の包含関係を正しく処理するための実務的な設計判断。

## コード例

```typescript
// packages/shadcn/src/migrations/migrate-radix.ts:274-276
// 正規表現で複数の import パターン（namespace, named, type-only）を一括捕捉
const radixImportPattern =
  /import\s+(?:(type)\s+)?(?:\*\s+as\s+(\w+)|{([^}]+)})\s+from\s+(["'])@radix-ui\/react-([^"']+)\4(;?)/g;
```

```typescript
// packages/shadcn/src/utils/transformers/transform-rtl.ts:11-50
// 物理方向 → 論理方向のマッピングテーブル（順序が意味を持つ）
const RTL_MAPPINGS: [string, string][] = [
  ["-ml-", "-ms-"],
  ["-mr-", "-me-"],
  ["ml-", "ms-"],
  ["mr-", "me-"],
  // ... 38 エントリ
  ["origin-left", "origin-start"],
  ["origin-right", "origin-end"],
];
```

```typescript
// packages/shadcn/src/migrations/migrate-radix.ts:342-351
// 重複 import の排除: name + alias + type の3属性で一意性を判定
const uniqueImports = imports.filter(
  (importName, index, self) =>
    index
      === self.findIndex(
        (i) =>
          i.name === importName.name
          && i.alias === importName.alias
          && i.isType === importName.isType,
      ),
);
```

```typescript
// packages/shadcn/src/migrations/migrate-radix.ts:304-309
// 最初の import からクォートスタイルとセミコロンスタイルを検出して統一
if (linesToRemove.length === 1) {
  quoteStyle = quote;
  hasSemicolon = semicolon === ";";
}
```

```typescript
// packages/shadcn/src/migrations/migrate-rtl.ts:100-116
// 設定ファイル（components.json）の更新を変換とは別フェーズで実行
const configSpinner = spinner("Updating components.json...").start();
try {
  const configPath = path.resolve(config.resolvedPaths.cwd, "components.json");
  const existingConfig = JSON.parse(await fs.readFile(configPath, "utf-8"));
  existingConfig.rtl = true;
  await fs.writeFile(configPath, JSON.stringify(existingConfig, null, 2) + "\n");
  configSpinner.succeed("Updated components.json.");
} catch {
  configSpinner.fail("Failed to update components.json.");
  throw new Error("Could not update components.json. Please manually set `rtl: true`.");
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: マイグレーションの種類によって異なる変換ロジックを切り替える
  - 適用条件: CLI が複数種類のマイグレーションをサポートし、各マイグレーションが独立した変換ロジックを持つ
  - コード例: `commands/migrate.ts:98-108` — `options.migration` の値に応じて `migrateIcons`/`migrateRadix`/`migrateRtl` を呼び分ける
  - 注意点: 現状は if 文の分岐だが、マイグレーション数が増えるなら Strategy インターフェースへの抽象化が望ましい

- **Pipeline パターン** (分類: 振る舞い)
  - 解決する問題: 複数の変換を直列に適用し、各ステージが独立にテスト可能
  - 適用条件: ソースコードに対して複数の独立した変換を順次適用する
  - コード例: `utils/transformers/index.ts:42-52` — Transformer 型の配列を順次実行
  - 注意点: マイグレーションスクリプトはこのパイプラインを使わず独自に実装している（既存コード変換と新規追加変換の要件差異のため）

- **Table-Driven Transform パターン** (分類: データ駆動)
  - 解決する問題: 変換規則の追加・修正をデータ変更のみで完結させる
  - 適用条件: 変換規則が多数あり、ロジックは共通で入出力のペアだけが異なる
  - コード例: `transform-rtl.ts:11-68` — 4種類のマッピングテーブルと統一的な `applyRtlMapping` 関数
  - 注意点: マッピングテーブルの順序が暗黙の優先度を持つ場合、ドキュメントやコメントでの明示が必須

## Good Patterns

- **コードスタイル保存型変換**: `migrateRadixFile` は元コードのクォートスタイル（シングル/ダブル）とセミコロンの有無を最初の import から検出し、生成する import 文に反映する。変換ツールが既存のコーディング規約を壊さない配慮。

```typescript
// packages/shadcn/src/migrations/migrate-radix.ts:304-309
if (linesToRemove.length === 1) {
  quoteStyle = quote;
  hasSemicolon = semicolon === ";";
}
// ...
const unifiedImport = `import { ${importList} } from ${quoteStyle}radix-ui${quoteStyle}${hasSemicolon ? ";" : ""}`;
```

- **差分検出による不要書き込み回避**: RTL マイグレーションは変換前後の内容を比較し、実際に変更があったファイルのみを書き込む。不要な git diff やタイムスタンプ変更を防ぐ。

```typescript
// packages/shadcn/src/migrations/migrate-rtl.ts:131-135
const transformed = await transformDirection(content, true);
if (transformed !== content) {
  await fs.writeFile(filePath, transformed);
  transformedCount++;
}
```

- **純粋関数としての変換コア**: 各マイグレーションは「ファイル単位の変換関数」を純粋関数として export している（`migrateIconsFile`, `migrateRadixFile`, `transformDirection`）。ファイル I/O・ユーザーインタラクション・変換ロジックが分離されており、変換コアだけを単体テスト可能。

```typescript
// packages/shadcn/src/migrations/migrate-radix.ts:269-271
export async function migrateRadixFile(
  content: string,
): Promise<{ content: string; replacedPackages: string[]; }>;
```

- **除外リストによる安全ガード**: Radix マイグレーションは `@radix-ui/react-icons` パッケージを明示的に除外している。パッケージ名のプレフィックスが一致するが意味的に異なるものを誤変換しない配慮。

```typescript
// packages/shadcn/src/migrations/migrate-radix.ts:299-301
if (packageName === "icons" || packageName.startsWith("icons/")) {
  continue;
}
```

## Anti-Patterns / 注意点

- **正規表現による構造的コードの変換**: `migrateRadixFile` は import 文の解析に 1 つの巨大な正規表現を使用している。コメント付き複数行 import、インライン型注釈、エイリアスなど多様なパターンを 1 つの正規表現で扱うため、`processNamedImports` でコメント除去やホワイトスペース正規化の後処理が必要になっている。

```typescript
// Bad: 1つの正規表現で全パターンを捕捉しようとする
const radixImportPattern =
  /import\s+(?:(type)\s+)?(?:\*\s+as\s+(\w+)|{([^}]+)})\s+from\s+(["'])@radix-ui\/react-([^"']+)\4(;?)/g;
// + processNamedImports でコメント除去、ホワイトスペース正規化

// Better: ts-morph の AST 操作を使う（migrate-icons.ts のアプローチ）
for (const importDeclaration of sourceFile.getImportDeclarations()) {
  if (importDeclaration.getModuleSpecifier()?.getText() !== `"${source}"`) continue;
  // 構造的に安全にパース可能
}
```

- **Slot 変換のプレースホルダ方式**: Radix マイグレーションの Slot 参照変換では、`__SLOT_PLACEHOLDER__` という文字列プレースホルダを使って二重置換を防いでいる。この方式はプレースホルダ文字列がコード中に存在しないという仮定に依存しており、堅牢性に欠ける。

```typescript
// Bad: マジック文字列をプレースホルダとして使用
transformedLine = transformedLine.replace(
  /\b(asChild\s*\?\s*)Slot(\s*:)/g,
  "$1__SLOT_PLACEHOLDER__$2",
);
// ...最後に一括置換
transformedLine = transformedLine.replace(/__SLOT_PLACEHOLDER__/g, "SlotPrimitive.Slot");

// Better: AST を使って識別子の参照を追跡し、スコープを考慮した置換を行う
```

- **マッピングテーブルの順序依存**: RTL 変換のマッピングテーブルは `startsWith` マッチングを使い、配列の先頭から順に照合される。テーブルの順序を誤ると誤変換が発生するが、この制約はコメントでのみ文書化されている。

```typescript
// 順序を間違えると ml- が -ml- より先にマッチして誤変換
// 順序制約がコメントのみで表現されている
const RTL_MAPPINGS: [string, string][] = [
  ["-ml-", "-ms-"], // 負のプレフィックスが先
  ["ml-", "ms-"], // 正のプレフィックスが後
];

// Better: 最長一致マッチングを使うか、末尾の - の有無で完全一致を判定する
```

## 導出ルール

- `[MUST]` マイグレーションスクリプトでは変換コアを純粋関数として分離し、ファイル I/O やユーザーインタラクションから独立させる
  - 根拠: shadcn/ui は `migrateRadixFile(content)` のようにファイル内容を受け取り変換結果を返す純粋関数を export し、テストではモック不要で直接検証している（`migrate-radix.test.ts:84-119`）

- `[MUST]` 自動マイグレーションツールは変換前に preflight チェック（前提条件の検証）と確認プロンプトを挟み、ユーザーの明示的な同意なしにファイルを変更しない
  - 根拠: 全3マイグレーションが `preFlightMigrate` による事前検証と `prompts` による確認を実行してから変換を開始する（`commands/migrate.ts:81-96`, `migrate-rtl.ts:80-98`）

- `[MUST]` コード自動書き換えツールは変換後のコードスタイル（クォート種別・セミコロン・インデント）を元コードに合わせて保存する
  - 根拠: `migrateRadixFile` は最初の import からクォートスタイルとセミコロンの有無を検出し、生成コードに反映している（`migrate-radix.ts:304-365`）

- `[SHOULD]` import 文やスコープを持つ構文の変換には正規表現ではなく AST パーサーを使う
  - 根拠: `migrate-icons.ts` は ts-morph でスコープを考慮した安全な変換を実現しているのに対し、`migrate-radix.ts` は正規表現ベースで複雑なエッジケース処理（コメント除去、プレースホルダ方式）が必要になっている

- `[SHOULD]` 変換規則が多数ある場合はマッピングテーブル（データ）とマッピング適用関数（ロジック）を分離し、テーブルの追加だけで新しい変換を追加可能にする
  - 根拠: RTL 変換は40近いクラス名マッピングをテーブルで管理し、`applyRtlMapping` が一律に適用する設計で、物理→論理クラスの追加がデータ変更のみで完結する（`transform-rtl.ts:11-68, 141-247`）

- `[SHOULD]` マイグレーションツールが依存パッケージを操作する場合、旧パッケージは自動削除せず、削除候補をユーザーに提示するに留める
  - 根拠: `migrateRadix` は `radix-ui` を追加するが `@radix-ui/react-*` は削除せず、「削除可能なパッケージ」を一覧表示して確認を促す（`migrate-radix.ts:252-257`）

- `[SHOULD]` 自動変換だけでは不十分なファイルやパターンが既知の場合、変換後に手動レビューが必要な対象を明示的に通知する
  - 根拠: RTL マイグレーションは `FILES_NEEDING_MANUAL_REVIEW` で手動調整が必要なファイルを事前定義し、完了後にドキュメント URL 付きで警告する（`migrate-rtl.ts:12-16, 149-158`）

- `[AVOID]` 変換の中間状態をマジック文字列プレースホルダで管理する方式。コード中にプレースホルダと同名の文字列が存在すると誤動作する
  - 根拠: `migrateRadixFile` の Slot 変換は `__SLOT_PLACEHOLDER__` を使って二重置換を回避しているが、これはプレースホルダがコード中に存在しないという脆い仮定に依存する（`migrate-radix.ts:396-439`）

- `[AVOID]` マッピングテーブルの順序に暗黙的な優先度を持たせる設計。順序を誤ると部分一致による誤変換が発生する
  - 根拠: RTL マッピングは `-ml-` を `ml-` より先に配置する必要があり、この制約はコメントのみで表現されている。最長一致マッチングや完全一致判定に変更すれば順序非依存にできる（`transform-rtl.ts:8-10`）

## 適用チェックリスト

- [ ] マイグレーションの変換コアが純粋関数として分離されており、ファイル I/O やユーザー入力と独立しているか
- [ ] 変換前に前提条件の検証（設定ファイルの存在、対象ディレクトリの有無）を実行しているか
- [ ] 自動変換の前にユーザーへ影響範囲を提示し、明示的な確認を取っているか
- [ ] 変換後のコードスタイル（クォート種別・セミコロン・インデント）が元コードを尊重しているか
- [ ] import 文やスコープ付き構文の変換に AST パーサーを使用しているか（正規表現で十分な場合を除く）
- [ ] 変換規則がデータ（テーブル）とロジック（適用関数）に分離されているか
- [ ] 自動変換が不完全なパターンについて、変換後にユーザーへ手動レビューの必要性を通知しているか
- [ ] 変換対象と非対象（除外リスト）が明確に定義されており、プレフィックスの部分一致による誤変換を防いでいるか
- [ ] 変換のテストが入出力のスナップショットだけでなく、エッジケース（空ファイル、非対象ファイル、複数行 import）をカバーしているか
