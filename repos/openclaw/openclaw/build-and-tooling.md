# Build and Tooling

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

193K Stars 規模のマルチチャネル AI ゲートウェイが、Rust ベースの次世代 JS ツールチェーン（tsdown / oxlint / oxfmt / rolldown）と native TypeScript チェッカー（tsgo）を全面採用し、従来の esbuild + ESLint + Prettier スタックを完全に置き換えている。ビルドパイプラインは「スマート再ビルド」「並列テストオーケストレーション」「コンテンツハッシュによるスキップ」といった手法でフィードバックループの高速化を徹底しており、大規模 TypeScript モノレポのツールチェーン選定と自動化設計の実践例として注目に値する。

## 背景にある原則

- **ネイティブ速度で開発者体験を守る**: ESLint/Prettier/tsc の代わりに oxlint/oxfmt/tsgo（すべて Rust/Go 実装）を採用し、型チェック・リント・フォーマットの全フェーズで桁違いの速度を実現する。大規模コードベースで「check が遅いから省略する」という悪循環を根本から断つ設計判断（`package.json` の `check` スクリプト: `pnpm format:check && pnpm tsgo && pnpm lint`）。

- **ビルドは必要なときだけ、最小限に**: `run-node.mjs` の `shouldBuild()` 関数が git HEAD・ソース mtime・ビルドスタンプを比較し、不要な再ビルドを回避する。A2UI バンドルは SHA-256 コンテンツハッシュで差分なしをスキップする（`bundle-a2ui.sh:79-86`）。開発中の無駄なビルド待ちを排除する設計。

- **ツール責務の明確な分離**: tsdown はバンドル専任、tsc（tsconfig.plugin-sdk.dts.json）は `.d.ts` 生成専任、tsgo は型チェック専任と、各ツールが得意な1つの仕事だけを担う。「1つのツールに全部やらせる」のではなく「最適なツールを組み合わせる」方針。

- **テスト実行の適応的最適化**: `test-parallel.mjs` が OS・CI 環境・Node バージョンを検出し、vmForks/forks プール、ワーカー数、シャーディングを動的に切り替える。環境ごとのチューニングをスクリプトに閉じ込め、開発者は `pnpm test` だけ叩けばよい設計。

## 実例と分析

### tsdown による多エントリポイントバンドル

tsdown（rolldown ベースのバンドラ）は `defineConfig` に配列を渡すことで、1つの設定ファイルから複数のバンドルを生成する。各エントリは独立した出力先を持ち、`fixedExtension: false` で出力ファイルの拡張子をバンドラに委ねている。

```ts
// tsdown.config.ts:7-45
export default defineConfig([
  {
    entry: "src/index.ts",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/plugin-sdk/index.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: ["src/hooks/bundled/*/handler.ts", "src/hooks/llm-slug-generator.ts"],
    env,
    fixedExtension: false,
    platform: "node",
  },
]);
```

glob パターン（`src/hooks/bundled/*/handler.ts`）でエントリを指定し、プラグイン的に拡張される hooks を自動的にバンドル対象に含める手法が特徴的。新しい hook ディレクトリを追加するだけでビルドに含まれる。

### ビルドステップの連鎖設計

`package.json` の `build` スクリプトは、7つのステップを `&&` で直列に実行する。

```json
// package.json:38
"build": "pnpm canvas:a2ui:bundle && tsdown && pnpm build:plugin-sdk:dts && node --import tsx scripts/write-plugin-sdk-entry-dts.ts && node --import tsx scripts/canvas-a2ui-copy.ts && node --import tsx scripts/copy-hook-metadata.ts && node --import tsx scripts/write-build-info.ts && node --import tsx scripts/write-cli-compat.ts"
```

各ステップの責務:
1. **A2UI バンドル** - Lit コンポーネントを rolldown でバンドル（コンテンツハッシュでスキップ判定）
2. **tsdown** - メイン TypeScript バンドル
3. **tsc** - Plugin SDK の `.d.ts` 生成（tsdown ではなく tsc を使用）
4. **write-plugin-sdk-entry-dts** - `.d.ts` のリエクスポートシム生成
5. **canvas-a2ui-copy** - A2UI バンドルを dist にコピー
6. **copy-hook-metadata** - HOOK.md メタデータを dist にコピー
7. **write-build-info** - バージョン・コミットハッシュ・ビルド日時をJSONに記録
8. **write-cli-compat** - レガシー CLI 互換シムを生成

### スマート再ビルド（run-node.mjs）

開発時の `pnpm dev` は `run-node.mjs` を経由し、ビルドが必要かどうかを複数の条件で判定する。

```js
// scripts/run-node.mjs:136-176
const shouldBuild = () => {
  if (env.OPENCLAW_FORCE_BUILD === "1") {
    return true;
  }
  const stamp = readBuildStamp();
  if (stamp.mtime == null) {
    return true;
  }
  if (statMtime(distEntry) == null) {
    return true;
  }
  for (const filePath of configFiles) {
    const mtime = statMtime(filePath);
    if (mtime != null && mtime > stamp.mtime) {
      return true;
    }
  }
  const currentHead = resolveGitHead();
  if (currentHead && stamp.head && currentHead !== stamp.head) {
    return hasSourceMtimeChanged(stamp.mtime);
  }
  if (currentHead) {
    const dirty = hasDirtySourceTree();
    if (dirty === true) {
      return true;
    }
    if (dirty === false) {
      return false;
    }
  }
  if (hasSourceMtimeChanged(stamp.mtime)) {
    return true;
  }
  return false;
};
```

判定ロジック: ビルドスタンプ有無 -> dist エントリ存在 -> 設定ファイル mtime -> git HEAD 変更 -> ソースツリー dirty 状態 -> ソース mtime。この多段階チェックにより、branch 切り替え後や git pull 後の不要ビルドを回避しつつ、必要なときは確実にリビルドする。

### コンテンツハッシュによるバンドルスキップ

A2UI バンドルは SHA-256 ハッシュで入力ファイル群の変更を検出する。

```bash
# scripts/bundle-a2ui.sh:79-86
current_hash="$(compute_hash)"
if [[ -f "$HASH_FILE" ]]; then
  previous_hash="$(cat "$HASH_FILE")"
  if [[ "$previous_hash" == "$current_hash" && -f "$OUTPUT_FILE" ]]; then
    echo "A2UI bundle up to date; skipping."
    exit 0
  fi
fi
```

`compute_hash` 関数はファイルパス（相対パス正規化済み）とファイル内容を連結して SHA-256 を算出する。mtime ではなくコンテンツベースのため、`git checkout` でタイムスタンプが変わっても内容が同じならスキップされる。

### 適応型テスト並列化

`test-parallel.mjs` はテストスイートを unit/extensions/gateway に分割し、環境に応じて実行戦略を変える。

```js
// scripts/test-parallel.mjs:38-44
const supportsVmForks = Number.isFinite(nodeMajor) ? nodeMajor !== 24 : true;
const useVmForks =
  process.env.OPENCLAW_TEST_VM_FORKS === "1" ||
  (process.env.OPENCLAW_TEST_VM_FORKS !== "0" && !isWindows && supportsVmForks);
```

```js
// scripts/test-parallel.mjs:130-150
const maxWorkersForRun = (name) => {
  if (resolvedOverride) {
    return resolvedOverride;
  }
  if (isCI && !isMacOS) {
    return null;  // Vitest defaults
  }
  if (isCI && isMacOS) {
    return 1;  // macOS CI: OOM 回避
  }
  if (name === "unit-isolated") {
    return 1;  // 隔離が必要なテスト
  }
  if (name === "extensions") {
    return defaultExtensionsWorkers;
  }
  return defaultUnitWorkers;
};
```

特定のテストファイルを `unitIsolatedFiles` として明示的にリストアップし、`forks` プールで隔離実行する。残りは高速な `vmForks` で実行する二段構成。

### oxlint の型情報付きリント

oxlint を `--type-aware` モードで使用し、TypeScript の型情報を活用したリントを実現する。

```json
// .oxlintrc.json:1-21
{
  "plugins": ["unicorn", "typescript", "oxc"],
  "categories": {
    "correctness": "error",
    "perf": "error",
    "suspicious": "error"
  },
  "rules": {
    "typescript/no-explicit-any": "error",
    "curly": "error"
  }
}
```

カテゴリベースのルール設定で correctness/perf/suspicious を一括で error にしつつ、個別ルールの on/off で微調整する。`no-explicit-any: error` は TypeScript の `strict` と併せて型安全性を強制する。

### プロセス警告のフィルタリング

`src/infra/warning-filter.ts` は `process.emitWarning` をラップし、既知の無害な警告（`DEP0040` punycode、`DEP0060` util._extend、SQLite 実験的警告）を抑制する。

```ts
// src/infra/warning-filter.ts:65-83
export function installProcessWarningFilter(): void {
  const globalState = globalThis as typeof globalThis & {
    [warningFilterKey]?: ProcessWarningInstallState;
  };
  if (globalState[warningFilterKey]?.installed) {
    return;
  }
  const originalEmitWarning = process.emitWarning.bind(process);
  const wrappedEmitWarning: typeof process.emitWarning = ((...args: unknown[]) => {
    if (shouldIgnoreWarning(normalizeWarningArgs(args))) {
      return;
    }
    return Reflect.apply(originalEmitWarning, process, args);
  }) as typeof process.emitWarning;
  process.emitWarning = wrappedEmitWarning;
  globalState[warningFilterKey] = { installed: true };
}
```

Symbol ベースのグローバルフラグで二重インストールを防止する。エントリポイント `openclaw.mjs` から最初期に呼び出される。

### ファイル行数の自動監視

`check:loc` スクリプト（`scripts/check-ts-max-loc.ts`）が git 管理下の全 `.ts`/`.tsx` ファイルの行数を計測し、上限（デフォルト 500 行）超過を検出する。

```ts
// scripts/check-ts-max-loc.ts:55-68
const files = gitLsFilesAll()
  .filter((filePath) => existsSync(filePath))
  .filter((filePath) => filePath.endsWith(".ts") || filePath.endsWith(".tsx"));

const results = await Promise.all(
  files.map(async (filePath) => ({ filePath, lines: await countLines(filePath) })),
);

const offenders = results
  .filter((result) => result.lines > maxLines)
  .toSorted((a, b) => b.lines - a.lines);
```

AGENTS.md には「~500 LOC when feasible」「~700 LOC guideline」と記載されており、ツールが強制し、ドキュメントがガイドラインを示す二層構造。

## パターンカタログ

- **Builder パターン** (分類: 生成)
  - 解決する問題: ビルドパイプラインの各ステップが個別のスクリプトとして独立し、`&&` チェーンで組み立てられる
  - 適用条件: ビルドステップが 3 つ以上あり、個別に実行・テストしたい場合
  - コード例: `package.json:38` の `build` スクリプト
  - 注意点: ステップ間の依存関係が暗黙的になるため、順序の根拠をコメントで残す

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: テスト実行戦略を環境（OS、CI、Node バージョン）に応じて動的に切り替える
  - 適用条件: 同じタスクを異なる環境で異なるパラメータで実行する必要がある場合
  - コード例: `scripts/test-parallel.mjs:38-44`（vmForks/forks 切り替え）、`scripts/test-parallel.mjs:130-150`（ワーカー数決定）
  - 注意点: 環境変数によるオーバーライド（`OPENCLAW_TEST_VM_FORKS`）を必ず用意し、自動判定が失敗した場合の脱出口を確保する

## Good Patterns

- **コンテンツハッシュによるビルドスキップ**: mtime ではなくファイル内容の SHA-256 ハッシュで変更を検出する（`bundle-a2ui.sh:34-76`）。git 操作でタイムスタンプが変わっても内容が同じならビルドをスキップでき、CI と開発者マシンで一貫した挙動になる。

- **エントリポイントの .js/.mjs 両対応**: `openclaw.mjs` がバンドラ出力の拡張子に依存せず、`dist/entry.js` と `dist/entry.mjs` の両方を試行する（`openclaw.mjs:50-56`）。バンドラのバージョンアップで出力拡張子が変わっても壊れない防御的設計。

```js
// openclaw.mjs:50-56
if (await tryImport("./dist/entry.js")) {
  // OK
} else if (await tryImport("./dist/entry.mjs")) {
  // OK
} else {
  throw new Error("openclaw: missing dist/entry.(m)js (build output).");
}
```

- **リリースチェックの自動化**: `release-check.ts` が `npm pack --dry-run` の出力を解析し、必須ファイルの存在と禁止ファイルの不在を検証する（`scripts/release-check.ts:10-16`）。さらにプラグインのバージョン一致も検証し、リリース前の手動チェック漏れを防ぐ。

- **pre-commit で lint + format の自動修正**: git hooks の pre-commit が staged ファイルに対して `oxlint --fix` と `oxfmt` を実行し、修正結果を自動で `git add` する（`git-hooks/pre-commit:1-9`）。開発者がフォーマットを気にせずコミットでき、CI で弾かれる無駄がなくなる。

## Anti-Patterns / 注意点

- **ビルドスクリプトの長大な && チェーン**: `build` スクリプトが 1 行に 8 ステップを `&&` で連結しており、可読性が低い。途中のステップが失敗した場合のデバッグも困難。

```json
// Bad: 1行に全ステップを詰め込む
"build": "pnpm canvas:a2ui:bundle && tsdown && pnpm build:plugin-sdk:dts && node --import tsx scripts/write-plugin-sdk-entry-dts.ts && ..."
```

```json
// Better: 各ステップを個別スクリプトに分け、統合スクリプトから呼ぶ
"build:bundle": "tsdown",
"build:dts": "tsc -p tsconfig.plugin-sdk.dts.json",
"build:postprocess": "node --import tsx scripts/build-postprocess.ts",
"build": "pnpm build:bundle && pnpm build:dts && pnpm build:postprocess"
```

ただし、このプロジェクトでは各ポストプロセスが軽量（数十行の単一スクリプト）であり、分割しすぎるとオーバーヘッドが増える面もある。トレードオフの判断。

- **テスト隔離ファイルのハードコードリスト**: `test-parallel.mjs` の `unitIsolatedFiles` が 20 ファイル以上を手動リストしている。ファイル追加・削除・リネーム時にリストの更新を忘れるリスクがある。

```js
// Bad: ファイルパスをハードコード
const unitIsolatedFiles = [
  "src/plugins/loader.test.ts",
  "src/plugins/tools.optional.test.ts",
  // ...20+ entries
];
```

```js
// Better: テストファイル内にマーカーコメントを埋め込み、自動検出する
// テストファイル冒頭: // @vitest-isolated
const unitIsolatedFiles = findTestsWithMarker("@vitest-isolated");
```

## 導出ルール

- `[MUST]` ビルドパイプラインの各ステップは単一責務のスクリプトとして独立させ、個別に実行・テストできるようにする
  - 根拠: openclaw は tsdown（バンドル）、tsc（.d.ts 生成）、各ポストプロセスを独立スクリプトに分離し、`build:plugin-sdk:dts` のように個別実行可能にしている（`package.json:39`）

- `[MUST]` リント・フォーマット・型チェックは CI と同じコマンドを pre-commit / ローカルで実行できるようにする
  - 根拠: `.pre-commit-config.yaml` の local hooks が `oxlint --type-aware` / `oxfmt --check` を CI と同一コマンドで実行し、CI との乖離を防止している

- `[SHOULD]` 開発サーバー起動時にビルドキャッシュの有効性を多段階で検証し、不要な再ビルドをスキップする
  - 根拠: `run-node.mjs` の `shouldBuild()` がビルドスタンプ・git HEAD・mtime・dirty 状態を組み合わせて判定し、branch 切り替えや `git pull` 後の不要ビルドを回避（`scripts/run-node.mjs:136-176`）

- `[SHOULD]` バンドラの出力拡張子に依存せず、エントリポイントで `.js` と `.mjs` の両方をフォールバック試行する
  - 根拠: `openclaw.mjs:50-56` がバンドラのバージョンアップで拡張子が変わっても動作を保証し、ツール更新時の破壊を防止している

- `[SHOULD]` テスト実行戦略を OS・CI 環境・ランタイムバージョンに応じて自動的に最適化し、環境変数によるオーバーライドも用意する
  - 根拠: `test-parallel.mjs` が Node 24 の vmForks 非互換を自動検出しつつ `OPENCLAW_TEST_VM_FORKS=0|1` で手動制御も可能にしている（`scripts/test-parallel.mjs:38-44`）

- `[SHOULD]` リリース前チェックは `npm pack --dry-run` で実際のパッケージ内容を検証し、必須ファイルの欠落と不要ファイルの混入を自動検出する
  - 根拠: `release-check.ts` が `dist/index.js`, `dist/plugin-sdk/index.d.ts`, `dist/build-info.json` 等の存在を検証し、`dist/OpenClaw.app/` 等の禁止パスの混入を検出する（`scripts/release-check.ts:10-17`）

- `[SHOULD]` ファイル行数の上限を CI またはスクリプトで監視し、大きすぎるファイルの肥大化を早期に検出する
  - 根拠: `check-ts-max-loc.ts` が全 `.ts`/`.tsx` ファイルを走査し、500 行超過を警告する。AGENTS.md の「~500 LOC」ガイドラインをツールで補強している

- `[AVOID]` リント・フォーマットに JavaScript/Node.js 実装のツール（ESLint, Prettier）を大規模コードベースで使い続ける。Rust/Go 実装の代替（oxlint, oxfmt, Biome）への移行を検討する
  - 根拠: openclaw は ESLint + Prettier から oxlint + oxfmt に完全移行し、`pnpm check`（format + typecheck + lint）を高速に回せるようにしている

- `[AVOID]` 1 つの型チェッカー/バンドラに `.d.ts` 生成・バンドル・型チェックの全責務を持たせる
  - 根拠: openclaw は tsdown（バンドル）、tsc（.d.ts 生成）、tsgo（型チェック）を使い分け、各ツールの得意分野に集中させている。tsdown に `.d.ts` 生成を任せず、tsc の専用 tsconfig（`tsconfig.plugin-sdk.dts.json`）で精密に制御している

## 適用チェックリスト

- [ ] リント・フォーマット・型チェックの各ツールの実行時間を計測し、ボトルネックがあれば Rust/Go 実装の代替を検討する
- [ ] ビルドスクリプトの各ステップが個別に実行・テスト可能か確認する
- [ ] 開発サーバー起動時に不要な再ビルドが走っていないか確認し、キャッシュ/スタンプ機構を導入する
- [ ] pre-commit hooks が CI と同じリント・フォーマットコマンドを使用しているか確認する
- [ ] テスト実行が環境（ローカル / CI / OS）に応じて適切にワーカー数・プール戦略を調整しているか確認する
- [ ] `npm pack --dry-run` 相当のリリース前チェックを自動化しているか確認する
- [ ] ファイル行数の上限監視を CI またはスクリプトで導入しているか確認する
- [ ] バンドラの出力拡張子の変更にエントリポイントが耐えられるか確認する
- [ ] コンテンツハッシュベースのビルドスキップが適用可能な重いビルドステップがないか確認する
