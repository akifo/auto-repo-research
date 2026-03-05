# CLI フレームワークパターン

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn CLI は Commander ベースの大規模 CLI ツールで、11 のサブコマンドと 5 つの preflight モジュールを持つ。注目すべきは、コマンド実行前の環境検証を「preflight チェーン」として分離し、エラー状態をコード定数で構造化するアーキテクチャである。さらに、Zod スキーマでオプションをバリデーションするパターン、Shadow Config による段階的な設定解決、RegistryContext のライフサイクル管理など、CLI 設計における再利用可能なプラクティスが体系的に適用されている。

## 背景にある原則

- **コマンド定義と実行ロジックの同居**: 各サブコマンドは独立したファイルに `new Command()` のビルダーチェーンと `.action()` ハンドラを一体で定義し、エントリポイント (`index.ts`) では `.addCommand()` で集約するだけにしている。これにより各コマンドのオプション定義・バリデーション・実行ロジックが一箇所に凝集し、変更の影響範囲が閉じる（`packages/shadcn/src/commands/add.ts`, `packages/shadcn/src/commands/init.ts` 等）。

- **事前検証の分離（Preflight パターン）**: コマンドのビジネスロジック実行前に環境の妥当性を検証する関数を `preflights/` ディレクトリに分離している。preflight はエラーの有無をオブジェクトで返し、呼び出し側がエラー種別に応じて分岐する。これにより、検証ロジックの再利用性とテスタビリティが向上し、コマンド本体が「正常系のフロー」に集中できる。

- **型安全なオプション境界**: Commander のパース結果を `z.object()` スキーマで即座にバリデーションし、以降の処理は Zod の推論型で扱う。CLI の「外部入力」と「内部ロジック」の境界をスキーマで明確に切ることで、オプションの追加・変更時にコンパイル時チェックが働く。

- **グレースフルデグラデーション**: 設定ファイルが不完全・存在しない場合でも Shadow Config（デフォルト値でマージした仮設定）を用いてコマンドを実行可能にする。「設定が壊れているから何もできない」ではなく「できるところまでやって足りない部分はユーザーに案内する」設計思想がある（`view.ts:37-56`, `search.ts:57-86`）。

## 実例と分析

### コマンドのビルダーパターンとエントリポイント集約

エントリポイントは各コマンドを import して `addCommand()` で登録するだけの薄いファイルになっている。

```typescript
// packages/shadcn/src/index.ts:22-48
async function main() {
  const program = new Command()
    .name("shadcn")
    .description("add items from registries to your project")
    .version(
      packageJson.version || "1.0.0",
      "-v, --version",
      "display the version number",
    );

  program
    .addCommand(init)
    .addCommand(create)
    .addCommand(add)
    .addCommand(diff)
    .addCommand(view)
    .addCommand(search)
    .addCommand(migrate)
    .addCommand(info)
    .addCommand(build)
    .addCommand(mcp)
    .addCommand(registry);
  // Legacy registry commands.
  program.addCommand(registryBuild).addCommand(registryMcp);

  program.parse();
}
```

各コマンドファイルは `new Command()` をエクスポートし、オプション定義から実行ロジックまで一貫して保持する。レガシーコマンド (`registryBuild`, `registryMcp`) もフラットに addCommand で追加し、`registry` サブコマンドグループとの共存を実現している。

### Zod スキーマによるオプションバリデーション

全コマンドで一貫して、Commander のパース結果を Zod スキーマに通してからロジックに渡す。

```typescript
// packages/shadcn/src/commands/add.ts:24-34
export const addOptionsSchema = z.object({
  components: z.array(z.string()).optional(),
  yes: z.boolean(),
  overwrite: z.boolean(),
  cwd: z.string(),
  all: z.boolean(),
  path: z.string().optional(),
  silent: z.boolean(),
  srcDir: z.boolean().optional(),
  cssVariables: z.boolean(),
});
```

```typescript
// packages/shadcn/src/commands/add.ts:61-67
.action(async (components, opts) => {
    try {
      const options = addOptionsSchema.parse({
        components,
        cwd: path.resolve(opts.cwd),
        ...opts,
      })
```

`migrate` コマンドでは `.refine()` でカスタムバリデーションも行っている。

```typescript
// packages/shadcn/src/commands/migrate.ts:31-41
migration: z
    .string()
    .refine(
      (value) =>
        value && migrations.some((migration) => migration.name === value),
      {
        message:
          "You must specify a valid migration. Run `shadcn migrate --list` to see available migrations.",
      }
    )
    .optional(),
```

### Preflight チェーンの設計

5 つの preflight 関数がそれぞれ独立して存在し、共通のエラー定数でコマンドと疎結合に連携する。

```typescript
// packages/shadcn/src/utils/errors.ts:1-14
export const MISSING_DIR_OR_EMPTY_PROJECT = "1";
export const EXISTING_CONFIG = "2";
export const MISSING_CONFIG = "3";
export const FAILED_CONFIG_READ = "4";
export const TAILWIND_NOT_CONFIGURED = "5";
export const IMPORT_ALIAS_MISSING = "6";
export const UNSUPPORTED_FRAMEWORK = "7";
export const BUILD_MISSING_REGISTRY_FILE = "13";
```

preflight は `{ errors: Record<string, boolean>, config: Config | null }` 形式の結果オブジェクトを返す。呼び出し側はエラーコードを key でチェックして分岐する。

```typescript
// packages/shadcn/src/commands/add.ts:153-187
let { errors, config } = await preFlightAdd(options)

// No components.json file. Prompt the user to run init.
if (errors[ERRORS.MISSING_CONFIG]) {
  const { proceed } = await prompts({
    type: "confirm",
    name: "proceed",
    message: `You need to create a ${highlighter.info(
      "components.json"
    )} file to add components. Proceed?`,
  })
  // ... init を自動実行してリカバリ
  config = await runInit({ ... })
}
```

`preflight-init` はさらに段階的なスピナー表示を行い、各検証ステップの進行状況をユーザーに伝える。

```typescript
// packages/shadcn/src/preflights/preflight-init.ts:29-53
const projectSpinner = spinner(`Preflight checks.`, {
  silent: options.silent,
}).start();
// ... 検証 ...
projectSpinner?.succeed();

const frameworkSpinner = spinner(`Verifying framework.`, {
  silent: options.silent,
}).start();
// ... 検証 ...
frameworkSpinner?.succeed(`Verifying framework. Found ${
  highlighter.info(
    projectInfo.framework.label,
  )
}.`);
```

### Shadow Config による段階的設定解決

`view` や `search` コマンドでは、`components.json` が不完全でも動作するために Shadow Config パターンを使う。

```typescript
// packages/shadcn/src/commands/view.ts:37-56
// Start with a shadow config to support partial components.json.
let shadowConfig = configWithDefaults({});

// Check if there's a components.json file (partial or complete).
const componentsJsonPath = path.resolve(options.cwd, "components.json");
if (fsExtra.existsSync(componentsJsonPath)) {
  const existingConfig = await fsExtra.readJson(componentsJsonPath);
  const partialConfig = rawConfigSchema.partial().parse(existingConfig);
  shadowConfig = configWithDefaults(partialConfig);
}

// Try to get the full config, but fall back to shadow config if it fails.
let config = shadowConfig;
try {
  const fullConfig = await getConfig(options.cwd);
  if (fullConfig) {
    config = configWithDefaults(fullConfig);
  }
} catch {
  // Use shadow config if getConfig fails (partial components.json).
}
```

### コンテキストクリーンアップのライフサイクル管理

レジストリ操作を行うコマンドは `finally` ブロックで `clearRegistryContext()` を呼び、グローバル状態をリセットする。

```typescript
// packages/shadcn/src/commands/add.ts:254-259
} catch (error) {
      logger.break()
      handleError(error)
    } finally {
      clearRegistryContext()
    }
```

この `try/catch/finally` パターンは `add`, `init`, `create`, `view`, `search` の 5 コマンドで一貫して適用されている。

### 型安全なエラーハンドリングの階層

`handleError` 関数は `instanceof` チェーンで型別に分岐し、エラー種別に応じた表示を行う。

```typescript
// packages/shadcn/src/utils/handle-error.ts:6-55
export function handleError(error: unknown) {
  if (typeof error === "string") { ... }
  if (error instanceof RegistryError) {
    // RegistryError には cause, suggestion を持つ
    if (error.suggestion) {
      logger.error("\nSuggestion:")
      logger.error(error.suggestion)
    }
  }
  if (error instanceof z.ZodError) {
    // フィールドごとにエラーを展開
    for (const [key, value] of Object.entries(error.flatten().fieldErrors)) {
      logger.error(`- ${highlighter.info(key)}: ${value}`)
    }
  }
  if (error instanceof Error) { ... }
}
```

### ファイルバックアップによるトランザクション的安全性

`init` コマンドは `process.on("exit")` で exit コードに応じたバックアップ復元・削除を行い、設定ファイル操作のトランザクション性を擬似的に実現している。

```typescript
// packages/shadcn/src/commands/init.ts:51-61
process.on("exit", (code) => {
  const filePath = path.resolve(process.cwd(), "components.json");

  // Delete backup if successful.
  if (code === 0) {
    return deleteFileBackup(filePath);
  }

  // Restore backup if error.
  return restoreFileBackup(filePath);
});
```

## コード例

```typescript
// packages/shadcn/src/preflights/preflight-add.ts:10-24
// preflight は errors レコードと config を返す統一インターフェース
export async function preFlightAdd(options: z.infer<typeof addOptionsSchema>) {
  const errors: Record<string, boolean> = {}

  if (
    !fs.existsSync(options.cwd) ||
    !fs.existsSync(path.resolve(options.cwd, "package.json"))
  ) {
    errors[ERRORS.MISSING_DIR_OR_EMPTY_PROJECT] = true
    return {
      errors,
      config: null,
    }
  }
```

```typescript
// packages/shadcn/src/registry/errors.ts:32-62
// ドメイン固有エラーにコード・コンテキスト・修正提案を含める
export class RegistryError extends Error {
  public readonly code: RegistryErrorCode;
  public readonly statusCode?: number;
  public readonly context?: Record<string, unknown>;
  public readonly suggestion?: string;
  public readonly timestamp: Date;

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
    // ...
  }
}
```

```typescript
// packages/shadcn/src/utils/highlighter.ts:1-8
// CLI 出力のカラーリングを薄いラッパーで抽象化
import { cyan, green, red, yellow } from "kleur/colors";

export const highlighter = {
  error: red,
  warn: yellow,
  info: cyan,
  success: green,
};
```

## パターンカタログ

- **Command パターン** (分類: 振る舞い)
  - 解決する問題: 複数のサブコマンドを独立して定義・追加・テストする必要がある
  - 適用条件: サブコマンドが 3 つ以上あり、それぞれのオプションとロジックが独立している
  - コード例: `packages/shadcn/src/commands/add.ts:36` (各コマンドが `new Command()` で自己完結)、`packages/shadcn/src/index.ts:33-45` (`.addCommand()` で集約)
  - 注意点: Commander の `.addCommand()` はフラットなコマンド追加とネストされたサブコマンドグループ（`registry` のケース）を両立できるが、名前衝突に注意

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 全コマンドで共通の「オプション検証 → preflight → 実行 → クリーンアップ」フローを維持する
  - 適用条件: コマンドが共通の前処理・後処理パターンを持つ
  - コード例: `packages/shadcn/src/commands/add.ts:61-259` (`try { parse → preflight → 実行 } catch { handleError } finally { clearContext }`)
  - 注意点: shadcn CLI では基底クラスではなくコンベンションで統一しているため、新規コマンド追加時にパターンの逸脱が起きうる

- **Null Object パターンの変形** (分類: 振る舞い)
  - 解決する問題: 設定ファイルが不完全・不在でも CLI を機能させる
  - 適用条件: 実行に設定が必要だが、設定がない状態でもユーザーを案内したい
  - コード例: `packages/shadcn/src/commands/view.ts:37` (`configWithDefaults({})` で空設定にデフォルト値を充填)
  - 注意点: Shadow Config はあくまで暫定設定であり、実際の操作（ファイル書き込み等）には完全な設定が必要

## Good Patterns

- **Options Schema Export パターン**: オプションスキーマを `export` して、preflight や他のコマンドから型を参照可能にする。`addOptionsSchema` は `preflight-add.ts` で `z.infer<typeof addOptionsSchema>` として利用され、オプション構造の一元管理が実現される。

```typescript
// packages/shadcn/src/commands/add.ts:24
export const addOptionsSchema = z.object({ ... })
// packages/shadcn/src/preflights/preflight-add.ts:10
export async function preFlightAdd(options: z.infer<typeof addOptionsSchema>) {
```

- **エラーに修正提案を含める**: `RegistryError` サブクラスが `suggestion` フィールドを持ち、ユーザーが次に何をすべきか具体的に示す。CLI のエラーメッセージは「何が起きたか」だけでなく「どう直すか」まで含めると UX が大幅に向上する。

```typescript
// packages/shadcn/src/registry/errors.ts:78-91
export class RegistryNotFoundError extends RegistryError {
  constructor(public readonly url: string, cause?: unknown) {
    super(message, {
      code: RegistryErrorCode.NOT_FOUND,
      suggestion: "Check if the item name is correct and the registry URL is accessible.",
    });
  }
}
```

- **Silent モードの一貫した伝搬**: ほぼ全コマンドが `--silent` / `-s` オプションを持ち、`spinner()` や `logger` 呼び出しに `silent` フラグを伝搬させる。プログラマティック利用（MCP 経由等）でノイズを抑制できる。

```typescript
// packages/shadcn/src/utils/spinner.ts:3-13
export function spinner(text: Options["text"], options?: { silent?: boolean; }) {
  return ora({ text, isSilent: options?.silent });
}
```

## Anti-Patterns / 注意点

- **preflight 結果の型が緩い**: preflight 関数は `Record<string, boolean>` でエラーを返すため、存在しないエラーキーを参照してもコンパイルエラーにならない。

```typescript
// Bad: キーの typo が検出されない
if (errors[ERRORS.MISSING_CONFG]) { // typo: CONFG vs CONFIG
  // 到達しない
}
```

```typescript
// Better: discriminated union で型安全に
type PreflightResult =
  | { ok: true; config: Config; }
  | { ok: false; error: "MISSING_CONFIG" | "MISSING_DIR"; };
```

- **グローバル状態のクリーンアップが手動**: `clearRegistryContext()` を `finally` で手動呼び出しする必要があり、呼び忘れリスクがある。5 つのコマンドファイルで同じ `finally { clearRegistryContext() }` が重複している。

```typescript
// Bad: finally ブロックの重複（5 コマンドで同一コード）
} finally {
  clearRegistryContext()
}
```

```typescript
// Better: コマンド実行をラップするヘルパー
function withRegistryContext(fn: () => Promise<void>) {
  return async () => {
    try {
      await fn();
    } catch (error) {
      handleError(error);
    } finally {
      clearRegistryContext();
    }
  };
}
```

- **Shadow Config ロジックの重複**: `view.ts` と `search.ts` でほぼ同一の Shadow Config 構築コードが繰り返されている。`search.ts:22` のコメント `// TODO: We're duplicating logic for shadowConfig here.` が問題を自認している。

## 導出ルール

- `[MUST]` CLI のコマンドオプションは Zod スキーマでバリデーションし、action ハンドラの先頭で `parse()` してから後続処理に渡す
  - 根拠: shadcn CLI の全 10 コマンドがこのパターンを採用し、CLI 入力と内部ロジックの型安全な境界を実現している (`add.ts:63`, `build.ts:34`, `init.ts:155` 等)
- `[MUST]` CLI のエラーメッセージには「何が起きたか」に加えて「次に何をすべきか」の修正提案を含める
  - 根拠: `RegistryError` の全サブクラスが `suggestion` フィールドを持ち、`handleError` でユーザーに提示している (`registry/errors.ts:32-62`, `handle-error.ts:20-35`)
- `[SHOULD]` コマンドの事前検証ロジックは preflight 関数として分離し、エラー種別をコード定数で返す
  - 根拠: 5 つの preflight モジュールが `preflights/` に分離され、エラー定数 (`utils/errors.ts`) を介してコマンド側と疎結合に連携している
- `[SHOULD]` グローバル状態を操作するコマンドは `try/catch/finally` でクリーンアップを保証し、可能であればラッパー関数で共通化する
  - 根拠: 5 つのコマンドで `finally { clearRegistryContext() }` が重複しており、クリーンアップ漏れリスクがある (`add.ts:258`, `init.ts:267`, `create.ts:244`, `view.ts:76`, `search.ts:117`)
- `[SHOULD]` 設定ファイルが不完全でも CLI が動作するよう、デフォルト値でマージした Shadow Config を用意する
  - 根拠: `view` と `search` コマンドが `configWithDefaults({})` でフォールバックし、`components.json` がなくてもレジストリの閲覧が可能になっている (`view.ts:37-56`)
- `[SHOULD]` CLI 出力のカラーリングは意味論的なラッパー (`error`, `warn`, `info`, `success`) で抽象化し、カラーライブラリへの直接依存を局所化する
  - 根拠: `highlighter.ts` が kleur を薄くラップし、全コマンド・ユーティリティが `highlighter.info()` 等で統一的に色付けしている
- `[AVOID]` preflight の戻り値に `Record<string, boolean>` のような緩い型を使うこと。存在しないエラーキーのチェックがコンパイル時に検出されない
  - 根拠: `errors.ts` のエラー定数は文字列リテラル (`"1"`, `"2"`, ...) であり、preflight の `errors` オブジェクトの型はキーを制約していない

## 適用チェックリスト

- [ ] CLI のエントリポイントはコマンド登録のみ行い、各コマンドは独立ファイルに定義しているか
- [ ] Commander (または類似フレームワーク) のパース結果を Zod スキーマで即座にバリデーションしているか
- [ ] コマンド実行前の環境検証（ファイル存在、設定妥当性等）を preflight 関数として分離しているか
- [ ] エラーメッセージに修正提案 (suggestion) を含めているか
- [ ] グローバル状態のクリーンアップが `finally` ブロックで保証されているか
- [ ] 設定ファイルが不完全な場合のフォールバック戦略（Shadow Config 等）を用意しているか
- [ ] `--silent` フラグを全コマンドで一貫してサポートし、プログラマティック利用に対応しているか
- [ ] カラー出力を意味論的ラッパーで抽象化し、ライブラリ差し替えが容易か
