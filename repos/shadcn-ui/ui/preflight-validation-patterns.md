# Preflight Validation Patterns

> リポジトリ: shadcn-ui/ui
> 分析日: 2026-03-04

## 概要

shadcn/ui の CLI（`shadcn`）は、`init`・`add`・`build`・`migrate` の各コマンド実行前に専用の preflight 関数を呼び出し、環境の前提条件を検証する設計を採用している。各 preflight は「エラーマップ + 成果物」という統一された戻り値構造を持ち、呼び出し元のコマンドがエラーの種類に応じて回復処理・ユーザー案内・中断のいずれかを選択できるようになっている。単純なガード節ではなく「検証を分離して結果を構造化する」というパターンが CLI ツール設計の好例として注目に値する。

## 背景にある原則

- **検証と実行の分離（Separation of Validation and Execution）**: 各コマンドは `preFlightXxx` を最初に呼び、戻り値を検査してから本体ロジックに入る。検証ロジックがコマンド本体に混在しないため、検証条件の追加・変更がコマンドロジックに影響しない。`preflight-init.ts` では 5 段階の検証（ディレクトリ存在 → 既存設定 → フレームワーク検出 → Tailwind 設定 → import alias）を順次実行しつつ、コマンド本体（`init.ts:271-409`）は検証結果の消費に専念している。

- **エラーは例外ではなくデータとして扱う（Errors as Data）**: preflight 関数は例外を投げず、`Record<string, boolean>` 型のエラーマップを返す。これにより呼び出し元が複数のエラーを一括で検査し、エラーの種類に応じた分岐（回復・案内・中断）を制御できる。`preflight-add.ts` が `MISSING_CONFIG` エラーを返し、`add.ts:157` がそれを受けて `runInit` で自動回復する流れがこの原則の典型例。

- **段階的検証（Staged Validation）**: 致命的な前提条件（ディレクトリ不在）から詳細な設定検証（Tailwind バージョン、alias 設定）へと段階的に検証を進める。前段の検証が失敗した時点で早期リターンし、後段の無意味な検証を回避する。`preflight-init.ts` でディレクトリ不在なら即 `{ errors, projectInfo: null }` を返し、フレームワーク検出以降の処理に進まない。

- **安全境界の防御的検証（Defensive Boundary Validation）**: レジストリから取得したファイルパスに対し、パストラバーサル攻撃を防ぐ `isSafeTarget` 関数を適用する。外部入力が書き込み先パスに影響する箇所では、検証を省略しない。`is-safe-target.ts` は null バイト注入、URL エンコード攻撃、Windows パス混在など 15 種類以上の攻撃パターンを防御する。

## 実例と分析

### preflight の戻り値構造

全 5 つの preflight 関数は同じ構造パターンに従う。エラーマップと、検証成功時のみ有効な成果物（config, projectInfo, resolvePaths）を返す。

| preflight 関数           | 成果物                    | 主な検証項目                                            |
| ------------------------ | ------------------------- | ------------------------------------------------------- |
| `preFlightInit`          | `projectInfo`             | ディレクトリ、既存設定、フレームワーク、Tailwind、alias |
| `preFlightAdd`           | `config`                  | ディレクトリ、components.json、設定パース               |
| `preFlightBuild`         | `resolvePaths`            | registry ファイル存在                                   |
| `preFlightMigrate`       | `config`                  | ディレクトリ、components.json、設定パース               |
| `preFlightRegistryBuild` | `config` + `resolvePaths` | registry ファイル、components.json、設定パース          |

エラーがある場合、成果物は `null` になる。呼び出し元はエラーマップのキーを検査して処理を分岐する。

### エラー定数による型安全なエラー識別

`errors.ts` で文字列定数としてエラーコードを定義し、preflight とコマンドの間で共有する。

```typescript
// packages/shadcn/src/utils/errors.ts:1-14
export const MISSING_DIR_OR_EMPTY_PROJECT = "1";
export const EXISTING_CONFIG = "2";
export const MISSING_CONFIG = "3";
export const FAILED_CONFIG_READ = "4";
export const TAILWIND_NOT_CONFIGURED = "5";
export const IMPORT_ALIAS_MISSING = "6";
export const UNSUPPORTED_FRAMEWORK = "7";
// ...
export const BUILD_MISSING_REGISTRY_FILE = "13";
```

preflight 側は `errors[ERRORS.MISSING_CONFIG] = true` でフラグを立て、コマンド側は `errors[ERRORS.MISSING_CONFIG]` で検査する。`import * as ERRORS` による名前空間インポートにより、タイポを防止している。

### エラーに対する3種類の応答パターン

コマンド側がpreflight のエラーに対して取る応答は3種類に分類できる。

**1. 自動回復（Auto-recovery）**: `add.ts:157-187` では `MISSING_CONFIG` エラーを受けてユーザーに確認後 `runInit` を自動実行し、不足していた `components.json` を生成する。`MISSING_DIR_OR_EMPTY_PROJECT` エラーでは `createProject` でプロジェクト自体を新規作成する。

**2. ガイド付き中断（Guided Abort）**: `preflight-init.ts:58-74` では `UNSUPPORTED_FRAMEWORK` を検出した場合、フレームワーク固有のインストールガイド URL を表示してから `process.exit(1)` する。

**3. 即時中断（Immediate Abort）**: `preflight-add.ts:42-60` では `components.json` のパースに失敗した場合、回復不可能と判断して即座に `process.exit(1)` する。

### preflight のスキップ機構

`init.ts:273-278` では `skipPreflight` オプションにより preflight をバイパスできる。これは `add` コマンドが内部的に `runInit` を呼ぶ場合（すでに `add` 側の preflight で基本検証済み）に使われ、二重検証を回避する。

```typescript
// packages/shadcn/src/commands/init.ts:271-295
export async function runInit(
  options: z.infer<typeof initOptionsSchema> & {
    skipPreflight?: boolean
  }
) {
  let projectInfo
  if (!options.skipPreflight) {
    const preflight = await preFlightInit(options)
    // ...
  } else {
    projectInfo = await getProjectInfo(options.cwd)
  }
```

### Zod によるコマンド入力の事前検証

各コマンドは Commander.js のアクション内で最初に Zod スキーマでオプションをパースする。これにより、preflight に渡す前に型レベルの検証が完了する。

```typescript
// packages/shadcn/src/commands/add.ts:62-67
const options = addOptionsSchema.parse({
  components,
  cwd: path.resolve(opts.cwd),
  ...opts,
});
```

`migrateOptionsSchema` では `.refine()` を使って有効なマイグレーション名のみを受け付ける（`migrate.ts:32-36`）。Zod のバリデーションエラーは `handleError` 内で `z.ZodError` として検出され、フィールドごとのエラーメッセージとして表示される（`handle-error.ts:38-45`）。

### パストラバーサル防御の多層検証

`isSafeTarget` はレジストリからダウンロードしたコンポーネントのファイル書き込み先を検証する。防御は以下の層で構成される。

1. null バイト検出
2. URL エンコードの再帰的デコード（二重エンコード対策）
3. パス正規化（Windows バックスラッシュ統一）
4. `..` パストラバーサルの検出（`[...]` フレームワークルーティングパターンを除外）
5. 制御文字の検出
6. Windows ドライブレター対応
7. 絶対パスのプロジェクトルート境界チェック
8. 相対パスの解決後の境界チェック

## コード例

preflight-init の段階的検証チェーン:

```typescript
// packages/shadcn/src/preflights/preflight-init.ts:11-119
export async function preFlightInit(
  options: z.infer<typeof initOptionsSchema>,
) {
  const errors: Record<string, boolean> = {};

  // Stage 1: ディレクトリ存在チェック（致命的 → 早期リターン）
  if (
    !fs.existsSync(options.cwd)
    || !fs.existsSync(path.resolve(options.cwd, "package.json"))
  ) {
    errors[ERRORS.MISSING_DIR_OR_EMPTY_PROJECT] = true;
    return { errors, projectInfo: null };
  }

  // Stage 2: 既存設定の衝突チェック（--force で回避可能）
  if (
    fs.existsSync(path.resolve(options.cwd, "components.json"))
    && !options.force
  ) {
    // process.exit(1)
  }

  // Stage 3: フレームワーク検出（検出不能 → ガイド付き中断）
  const projectInfo = await getProjectInfo(options.cwd);
  if (!projectInfo || projectInfo?.framework.name === "manual") {
    errors[ERRORS.UNSUPPORTED_FRAMEWORK] = true;
    // process.exit(1)
  }

  // Stage 4: Tailwind CSS 設定検証
  if (projectInfo.tailwindVersion === "v3" && !projectInfo?.tailwindConfigFile) {
    errors[ERRORS.TAILWIND_NOT_CONFIGURED] = true;
  }

  // Stage 5: import alias 検証
  if (!projectInfo?.aliasPrefix) {
    errors[ERRORS.IMPORT_ALIAS_MISSING] = true;
  }

  // 複数エラーをまとめて報告
  if (Object.keys(errors).length > 0) {
    // 各エラーに対応するガイダンスを表示
    logger.break();
    process.exit(1);
  }

  return { errors, projectInfo };
}
```

add コマンドにおけるエラー駆動の回復フロー:

```typescript
// packages/shadcn/src/commands/add.ts:153-228
let { errors, config } = await preFlightAdd(options)

// エラー種別に応じた回復戦略の選択
if (errors[ERRORS.MISSING_CONFIG]) {
  const { proceed } = await prompts({
    type: "confirm",
    name: "proceed",
    message: `You need to create a components.json file. Proceed?`,
  })
  if (!proceed) { process.exit(1) }
  config = await runInit({ cwd: options.cwd, yes: true, force: true, ... })
}

if (errors[ERRORS.MISSING_DIR_OR_EMPTY_PROJECT]) {
  const { projectPath } = await createProject({ cwd: options.cwd, ... })
  if (!projectPath) { process.exit(1) }
  options.cwd = projectPath
  config = await runInit({ cwd: options.cwd, skipPreflight: true, ... })
}
```

パストラバーサル防御の呼び出しフロー:

```typescript
// packages/shadcn/src/utils/add-components.ts:390-405
function validateFilesTarget(
  files: z.infer<typeof registryItemFileSchema>[],
  cwd: string,
) {
  for (const file of files) {
    if (!file?.target) continue;
    if (!isSafeTarget(file.target, cwd)) {
      throw new Error(
        `We found an unsafe file path "${file.target} in the registry item. Installation aborted.`,
      );
    }
  }
}
```

## パターンカタログ

- **Gateway パターン** (分類: 振る舞い)
  - 解決する問題: コマンド実行の前提条件が満たされていない状態で本体ロジックが走ることを防ぐ
  - 適用条件: 複数の前提条件を段階的に検証し、失敗時の応答を呼び出し元に委ねたい場合
  - コード例: `packages/shadcn/src/preflights/preflight-init.ts:11-162`
  - 注意点: preflight が `process.exit` を直接呼ぶケースと、エラーマップを返して呼び出し元に委ねるケースが混在している。理想的にはすべてエラーマップに統一し、`process.exit` は呼び出し元で行うべき

- **Error Map パターン** (分類: 振る舞い)
  - 解決する問題: 複数のエラー条件を一括で収集し、呼び出し元がエラー種別ごとに異なる対応を取れるようにする
  - 適用条件: 検証結果に対して「中断」「回復」「ガイド付き中断」など複数の応答パターンが存在する場合
  - コード例: `packages/shadcn/src/commands/add.ts:153-228`
  - 注意点: `Record<string, boolean>` は型安全性が弱い。判別共用体やカスタムエラー型の方が堅牢だが、シンプルさとのトレードオフ

## Good Patterns

- **検証結果を構造化して返す**: preflight 関数が `{ errors, config }` や `{ errors, projectInfo }` のように、エラーマップと成果物をペアで返す。呼び出し元はエラーの有無と種類で分岐でき、成果物は次の処理にそのまま渡せる。

```typescript
// packages/shadcn/src/preflights/preflight-add.ts:10-24
export async function preFlightAdd(options: z.infer<typeof addOptionsSchema>) {
  const errors: Record<string, boolean> = {};
  if (!fs.existsSync(options.cwd) || !fs.existsSync(path.resolve(options.cwd, "package.json"))) {
    errors[ERRORS.MISSING_DIR_OR_EMPTY_PROJECT] = true;
    return { errors, config: null };
  }
  // ...
  return { errors, config: config! };
}
```

- **エラー応答の段階的エスカレーション**: `add` コマンドでは preflight エラーに対して「自動回復を試みる → 失敗したら中断」という段階的な応答を実装している。ユーザーが `shadcn add button` と実行するだけで、未初期化のプロジェクトでも init が自動実行される。

```typescript
// packages/shadcn/src/commands/add.ts:153-187
let { errors, config } = await preFlightAdd(options)
if (errors[ERRORS.MISSING_CONFIG]) {
  // 回復: init を自動実行
  config = await runInit({ cwd: options.cwd, yes: true, force: true, ... })
}
if (errors[ERRORS.MISSING_DIR_OR_EMPTY_PROJECT]) {
  // 回復: プロジェクトを新規作成してから init
  const { projectPath } = await createProject({ ... })
  config = await runInit({ cwd: projectPath, skipPreflight: true, ... })
}
```

- **スピナーによる検証進捗の可視化**: `preflight-init.ts:29-119` では各検証ステップにスピナーを付与し、成功/失敗をリアルタイムに表示する。ユーザーはどの検証が失敗したかを視覚的に把握できる。

```typescript
// packages/shadcn/src/preflights/preflight-init.ts:54-79
const frameworkSpinner = spinner(`Verifying framework.`, { silent: options.silent }).start();
const projectInfo = await getProjectInfo(options.cwd);
if (!projectInfo || projectInfo?.framework.name === "manual") {
  frameworkSpinner?.fail();
  // ...
}
frameworkSpinner?.succeed(`Verifying framework. Found ${highlighter.info(projectInfo.framework.label)}.`);
```

- **フレームワーク固有のガイダンス URL**: エラー時にフレームワークごとの公式ドキュメント URL を表示する。`frameworks.ts` でフレームワークとリンクの対応を一元管理し、preflight のエラーメッセージから参照する。

```typescript
// packages/shadcn/src/preflights/preflight-init.ts:62-69
if (projectInfo?.framework.links.installation) {
  logger.error(
    `Visit ${highlighter.info(projectInfo?.framework.links.installation)} to manually configure your project.`,
  );
}
```

## Anti-Patterns / 注意点

- **preflight 内での process.exit**: `preflight-init.ts:49` や `preflight-add.ts:59` では、preflight 関数自体が `process.exit(1)` を呼んでいる。これはエラーマップによるデータ駆動の制御フローと矛盾し、呼び出し元が回復処理を選択する余地を奪う。

```typescript
// Bad: preflight 内で直接 exit
// packages/shadcn/src/preflights/preflight-init.ts:47-49
if (fs.existsSync(path.resolve(options.cwd, "components.json")) && !options.force) {
  projectSpinner?.fail();
  // ... エラーメッセージ
  process.exit(1); // 呼び出し元に制御が戻らない
}

// Better: エラーマップに記録して呼び出し元に委ねる
if (fs.existsSync(path.resolve(options.cwd, "components.json")) && !options.force) {
  errors[ERRORS.EXISTING_CONFIG] = true;
  return { errors, projectInfo: null };
}
```

- **型安全でないエラーマップ**: `Record<string, boolean>` はどのキーでも受け入れるため、タイポや未定義エラーコードの参照を型チェックで検出できない。

```typescript
// Bad: 任意の文字列キーを許容
const errors: Record<string, boolean> = {};
errors[ERRORS.MISSING_CONFIG] = true;
errors["typo_error"] = true; // 型エラーにならない

// Better: 判別共用体でエラー型を制限
type PreflightError =
  | { code: "MISSING_CONFIG"; }
  | { code: "MISSING_DIR"; path: string; }
  | { code: "UNSUPPORTED_FRAMEWORK"; framework: string; };
```

- **preflight-add と preflight-migrate の重複**: この 2 つの preflight はほぼ同一のロジック（ディレクトリ存在 → components.json 存在 → config パース）を持つ。共通の基底 preflight を抽出すれば重複を排除できる。

```typescript
// Bad: ほぼ同じコードが 2 ファイルに存在
// packages/shadcn/src/preflights/preflight-add.ts:10-61
// packages/shadcn/src/preflights/preflight-migrate.ts:11-64

// Better: 共通ロジックを抽出
async function preFlightWithConfig(cwd: string) {
  const errors: Record<string, boolean> = {};
  if (!fs.existsSync(cwd) || !fs.existsSync(path.resolve(cwd, "package.json"))) {
    errors[ERRORS.MISSING_DIR_OR_EMPTY_PROJECT] = true;
    return { errors, config: null };
  }
  if (!fs.existsSync(path.resolve(cwd, "components.json"))) {
    errors[ERRORS.MISSING_CONFIG] = true;
    return { errors, config: null };
  }
  const config = await getConfig(cwd);
  return { errors, config };
}
```

## 導出ルール

- `[MUST]` CLI コマンドの前提条件検証は専用の preflight 関数に分離し、コマンド本体のロジックと混在させない
  - 根拠: shadcn/ui では 5 つのコマンドすべてが `preFlightXxx` を最初に呼び、検証ロジックとビジネスロジックを明確に分離している（`preflight-init.ts`, `preflight-add.ts` 等）

- `[MUST]` preflight 関数はエラーを例外ではなくデータ（エラーマップまたは Result 型）として返し、呼び出し元がエラー種別に応じた応答（回復・案内・中断）を選択できるようにする
  - 根拠: `add.ts:153-228` では `MISSING_CONFIG` エラーに対して自動回復（init 実行）、`MISSING_DIR_OR_EMPTY_PROJECT` に対してプロジェクト新規作成と、エラー種別ごとに異なる回復戦略を実装している

- `[MUST]` 外部入力に由来するファイルパスは書き込み前にパストラバーサル検証を行い、プロジェクトルート外への書き込みを防止する
  - 根拠: `is-safe-target.ts` が null バイト注入・URL エンコード攻撃・Windows パス混在など 15 種以上の攻撃ベクトルを検証し、`add-components.ts:93,174` で書き込み前に呼び出されている

- `[SHOULD]` 段階的検証では致命的な前提条件（ディレクトリ不在等）を先に検証し、失敗時は早期リターンして後続の無意味な検証を回避する
  - 根拠: 全 preflight 関数が「ディレクトリ存在 → 設定ファイル存在 → 設定パース」の順で検証し、前段の失敗で即 `return { errors, config: null }` している

- `[SHOULD]` エラーメッセージにはユーザーが次に取るべきアクション（コマンド名、ドキュメント URL）を含める
  - 根拠: `preflight-init.ts:62-69` ではフレームワーク固有のインストールガイド URL を表示し、`preflight-add.ts:49-56` では `init` コマンドの実行を案内している

- `[SHOULD]` コマンド間で内部的に呼び出す場合は preflight のスキップ機構を設け、二重検証を回避する
  - 根拠: `add.ts:213` が `runInit` を呼ぶ際に `skipPreflight: true` を渡し、`add` 側で既に検証済みの項目の再検証を防いでいる

- `[AVOID]` preflight 関数内で `process.exit` を直接呼ぶことで、呼び出し元の回復機会を奪うこと
  - 根拠: `preflight-init.ts:49` は設定衝突時に `process.exit(1)` するが、`preflight-add.ts` はエラーマップを返して `add.ts` が回復処理を行えるようにしている。後者の方が柔軟性が高い

- `[AVOID]` 同一の検証ロジックを複数の preflight 関数にコピーすること
  - 根拠: `preflight-add.ts` と `preflight-migrate.ts` はディレクトリ・設定ファイルの存在チェックがほぼ同一であり、共通化の余地がある

## 適用チェックリスト

- [ ] CLI コマンドごとに専用の preflight 関数を作成し、コマンド本体の最初に呼び出しているか
- [ ] preflight の戻り値が「エラー情報 + 検証成功時の成果物」の構造になっているか
- [ ] エラーコードを定数として一元管理し、preflight とコマンド間で共有しているか
- [ ] 各エラーに対する応答パターン（自動回復・ガイド付き中断・即時中断）を明確に設計しているか
- [ ] 致命的な前提条件は検証チェーンの先頭に配置し、早期リターンしているか
- [ ] 外部入力に由来するファイルパスの書き込み前にパストラバーサル検証を行っているか
- [ ] エラーメッセージに次のアクション（コマンド名、URL）を含めているか
- [ ] コマンド間の内部呼び出しで preflight スキップ機構を設け、二重検証を回避しているか
- [ ] preflight 関数が `process.exit` を直接呼ばず、制御を呼び出し元に返しているか
