# Build and Tooling

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod v4 のビルドシステムは、専用ツール zshy を中核に据えた CJS/ESM デュアルパッケージ戦略を採用している。zshy は tsc の Compiler API を利用して拡張子の書き換えを行うバンドラー不要のビルドツールで、Zod のために開発された後に汎用ツールとして独立した。`@zod/source` というカスタム条件を exports に仕込むことで、開発時はビルド不要でソースコードを直接参照し、公開時はデュアルモジュールを提供するという二層構造を実現している。さらに、`@arethetypeswrong/cli` による型解決検証、複数の `moduleResolution` 設定でのコンパイルテスト、stub package.json の自動生成など、パッケージ品質を保証する多層的な仕組みが注目に値する。

## 背景にある原則

- **ビルドの信頼性は tsc に委ねるべき**: バンドラー（esbuild, rollup）は高速だが、TypeScript の型システムを完全に理解しない。zshy は tsc の Compiler API を使って拡張子書き換えを行い、型安全性を犠牲にせずデュアルモジュールビルドを実現している。速度よりも正確性を優先する設計判断。根拠: `packages/zod/package.json:129` で `zshy --project tsconfig.build.json` を使用し、バンドラーを介さない。

- **開発時のビルドステップは DX を阻害する**: モノレポ内でパッケージ間参照するたびにビルドが必要になると開発が停滞する。`@zod/source` カスタム条件により、テスト・ベンチマーク・開発時には `.ts` ソースを直接参照し、ビルド・公開時のみ `.js/.cjs` を使う。根拠: `vitest.config.ts:9`, `package.json:77` の `tsx --conditions @zod/source`。

- **パッケージの正しさは出荷前に自動検証すべき**: CJS/ESM デュアルパッケージは型解決の問題が起きやすい。Zod は `@arethetypeswrong/cli`、複数 tsconfig での型チェック、`.ts/.cts/.mts` の三重解決テスト、バージョン整合性チェックを CI に組み込み、出荷前にエッジケースを検出する。根拠: `packages/resolution/attw.test.ts`, `packages/integration/fixtures/internal-types/`。

- **循環依存はアーキテクチャの劣化を示す指標**: `madge --circular` を CI に組み込み、循環依存の混入を防いでいる。特定のレガシーモジュール（`v4/core`, `v3`）は明示的に除外しつつ、新しいコードへの循環依存流入を防止する。根拠: `package.json:88` の `check:circular` スクリプト。

## 実例と分析

### zshy によるデュアルモジュールビルド

zshy の設計は「package.json と tsconfig.json だけで設定が完結する」ことを目指している。エントリポイントは `package.json#/zshy/exports` で宣言的に定義し、zshy がビルド時に `package.json#/exports` を自動更新する。

```jsonc
// packages/zod/package.json:34-51 — zshy 設定
"zshy": {
  "exports": {
    "./package.json": "./package.json",
    ".": "./src/index.ts",
    "./mini": "./src/mini/index.ts",
    "./locales": "./src/locales/index.ts",
    "./v3": "./src/v3/index.ts",
    "./v4": "./src/v4/index.ts",
    // ... 他のサブパス
  },
  "conditions": {
    "@zod/source": "src"
  }
}
```

このエントリポイント定義から、zshy は以下の構造を自動生成する:

```jsonc
// packages/zod/package.json:53-113 — zshy が自動生成した exports
"exports": {
  ".": {
    "@zod/source": "./src/index.ts",  // カスタム条件: ソース直接参照
    "types": "./index.d.cts",          // 型定義（CTS = CJS 互換）
    "import": "./index.js",            // ESM
    "require": "./index.cjs"           // CJS
  },
  // ... 各サブパスも同じパターン
}
```

### @zod/source カスタム条件による開発・公開の分離

Node.js の [conditional exports](https://nodejs.org/api/packages.html#conditional-exports) に `@zod/source` というカスタム条件を追加し、ツールチェーン全体で一貫して使用している。

**vitest** — テスト実行時にソースを直接参照:
```ts
// vitest.config.ts:8-11
resolve: {
  conditions: ["@zod/source", "default"],
  externalConditions: ["@zod/source", "default"],
},
```

**tsx** — 開発用スクリプト実行:
```jsonc
// package.json:77-80
"dev": "tsx --conditions @zod/source",
"dev:watch": "tsx --conditions @zod/source --watch",
"bench": "tsx --conditions @zod/source packages/bench/index.ts",
```

**tsconfig** — TypeScript の型解決:
```jsonc
// tsconfig.json:5
"customConditions": ["@zod/source"],
```

**VSCode** — デバッグ設定:
```jsonc
// .vscode/launch.json:26
"runtimeArgs": ["--conditions=@zod/source"],
```

**esbuild** — treeshake テスト:
```jsonc
// packages/treeshake/package.json:9
"bundle:esbuild": "esbuild --bundle ./in.ts --conditions=@zod/source ..."
```

この一貫性がプラクティスの核心で、「条件を一箇所定義し、全ツールで同じ条件名を使う」ことで設定の散逸を防いでいる。

### stub package.json による深いサブパスの型解決

zshy のビルド後に `scripts/write-stub-package-jsons.ts` が実行され、`index.d.cts` が存在するサブディレクトリに stub の package.json を自動生成する:

```ts
// scripts/write-stub-package-jsons.ts:6-13
const STUB_PACKAGE_JSON_CONTENT = `{
  "type": "module",
  "main": "./index.cjs",
  "module": "./index.js",
  "types": "./index.d.cts",
  "sideEffects": false
}
`;
```

これは TypeScript の `moduleResolution: node10` やレガシーバンドラーが `package.json#/exports` を理解しない場合のフォールバックとして機能する。`postbuild` フックで自動実行されるため（`packages/zod/package.json:130`）、手動での管理が不要になっている。

### 多層的なパッケージ品質検証

**レイヤー 1: attw（Are The Types Wrong）**
```ts
// packages/resolution/attw.test.ts:31-33
const result = await execa("pnpm", ["attw", "--pack", zodPackagePath, "--format", "ascii"], {
  cwd: __dirname,
  reject: false,
});
```
inline snapshot で出力を固定し、型解決の退行を検出する。

**レイヤー 2: 複数 moduleResolution でのコンパイルテスト**

`packages/integration/fixtures/internal-types/` に3つの tsconfig を用意:
- `tsconfig.bundler.json` — `moduleResolution: "bundler"` (`packages/integration/fixtures/internal-types/tsconfig.bundler.json:6`)
- `tsconfig.nodenext.json` — `moduleResolution: "NodeNext"` (`packages/integration/fixtures/internal-types/tsconfig.nodenext.json:4`)
- `tsconfig.node16-cjs.json` — `module: "Node16"`, CJS コンテキスト (`packages/integration/fixtures/internal-types/tsconfig.node16-cjs.json:4`)

すべて `skipLibCheck: false` で実行し、ビルド後の `.d.ts/.d.cts` に内部エラーがないことを保証する。

**レイヤー 3: 実行時解決テスト**

`packages/resolution/src/` に `.ts`, `.cts`, `.mts` の3つのファイルを用意し、CJS/ESM/MTS のそれぞれの解決パスで実際に import + 実行できることを検証する（`packages/resolution/test-resolution.ts:78-94`）。

**レイヤー 4: バージョン整合性チェック**

`scripts/check-versions.ts` が `package.json`, `jsr.json`, ソースコード内の `versions.ts` の3箇所のバージョンが一致することを検証。`prepublishOnly` フックで実行される（`packages/zod/package.json:133`）。

### Git Hooks による品質ゲート

```bash
# .husky/pre-commit:1-7
if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "ERROR: untracked files present";
  git status;
  exit 1
fi
pnpm check:semver
lint-staged --verbose
```

未追跡ファイルの存在をコミット前にブロックすることで、ビルド成果物のコミット漏れや不要ファイルの混入を防止している。`pre-push` ではテストスイート全体を実行する。

### console.log のテスト内禁止

```ts
// scripts/fail-on-console.ts:5-8
function thrower(method: string) {
  return (...args: any[]) => {
    throw new Error(`Unexpected console.${method} call: ${args.join(" ")}`);
  };
}
```

vitest の `setupFiles` としてグローバルに設定され（`vitest.config.ts:22`）、テスト内での意図しない console 出力を即座にエラーとして検出する。

## パターンカタログ

- **Strategy パターン** (振る舞い)
  - 解決する問題: 同一ソースコードから CJS/ESM という異なる出力形式を生成する
  - 適用条件: 単一のソースから複数のビルドターゲットを生成する必要がある場合
  - コード例: zshy が `module: "commonjs"` と `module: "esnext"` を切り替えて tsc を2回実行
  - 注意点: ビルド時間は2倍になるが、型の正確性は保証される

- **Adapter パターン** (構造)
  - 解決する問題: `exports` を理解しないレガシーツール向けの互換性レイヤー
  - 適用条件: Node10 moduleResolution やレガシーバンドラーをサポートする必要がある場合
  - コード例: `scripts/write-stub-package-jsons.ts` が生成する stub package.json
  - 注意点: レガシーサポートが不要になったら除去すべき技術的負債として認識する

## Good Patterns

- **カスタム条件による開発/公開モードの切り替え**: `@zod/source` 条件を exports の先頭に配置し、開発時はソース直接参照・公開時はビルド済みファイルを提供する。monorepo 内のパッケージ間参照でビルドステップを不要にしつつ、公開パッケージの品質は維持できる。

```jsonc
// packages/zod/package.json:54-59
".": {
  "@zod/source": "./src/index.ts",  // 開発時: ソース直接参照
  "types": "./index.d.cts",
  "import": "./index.js",
  "require": "./index.cjs"
}
```

- **inline snapshot による型解決の回帰テスト**: `@arethetypeswrong/cli` の出力を inline snapshot で固定し、exports の変更が型解決に影響を与えた場合にテストが失敗する仕組み。

```ts
// packages/resolution/attw.test.ts:40-141
expect(outputWithoutFirstLine).toMatchInlineSnapshot(`
  // ... node10, node16(CJS), node16(ESM), bundler の各解決結果
`);
```

- **バージョンの Single Source of Truth**: `versions.ts` でバージョンを管理し、`check-versions.ts` が `package.json`, `jsr.json` との整合性を自動検証する。ヒューマンエラーによるバージョン不整合を出荷前に検出する。

```ts
// packages/zod/src/v4/core/versions.ts:1-5
export const version = {
  major: 4,
  minor: 3,
  patch: 6 as number,
} as const;
```

## Anti-Patterns / 注意点

- **exports マップの手動管理**: CJS/ESM デュアルパッケージで exports を手動管理すると、サブパスの追加・削除時に不整合が発生しやすい。Zod は zshy に自動生成を任せることでこの問題を回避している。

```jsonc
// Bad: 手動で exports を管理
"exports": {
  ".": {
    "types": "./dist/index.d.ts",  // ESM 用 .d.ts を指定（CJS で型エラー）
    "import": "./dist/index.js",
    "require": "./dist/index.cjs"
  }
}
```

```jsonc
// Better: zshy/tshy のようなツールで自動生成
"zshy": {
  "exports": { ".": "./src/index.ts" }
}
// → exports は自動生成される
```

- **テスト時のビルド依存**: テストがビルド済みファイルに依存すると、変更→ビルド→テストのサイクルが遅くなる。`@zod/source` 条件でソースを直接参照することで、ビルドなしでテストを実行できる。

```jsonc
// Bad: テスト時もビルド済みファイルを参照
// vitest.config.ts
resolve: {
  alias: { "zod": "./packages/zod/dist/index.js" }
}
```

```ts
// Better: カスタム条件でソースを直接参照
// vitest.config.ts
resolve: {
  conditions: ["@zod/source", "default"],
}
```

## 導出ルール

- `[MUST]` CJS/ESM デュアルパッケージでは、複数の moduleResolution 設定（bundler, nodenext, node16）でビルド後の型解決をテストする
  - 根拠: Zod は `packages/integration/fixtures/internal-types/` に3つの tsconfig を用意し、`skipLibCheck: false` で型解決の正しさを保証している

- `[MUST]` パッケージのバージョンを複数箇所で管理する場合、出荷前に自動で整合性を検証するスクリプトを用意する
  - 根拠: `scripts/check-versions.ts` が `package.json`, `jsr.json`, `versions.ts` の3箇所の一致を `prepublishOnly` で検証している

- `[SHOULD]` monorepo のパッケージ間参照ではカスタム条件（conditional exports）を使い、開発時はソースを直接参照してビルドステップを省略する
  - 根拠: `@zod/source` 条件が vitest, tsx, tsconfig, VSCode debug の全てで一貫して使われ、開発時のビルド不要化を実現している

- `[SHOULD]` exports マップはビルドツールに自動生成させ、エントリポイント定義を Single Source of Truth として管理する
  - 根拠: zshy が `package.json#/zshy/exports` から `package.json#/exports` と `jsr.json#/exports` を自動生成し、手動管理による不整合を防止している

- `[SHOULD]` パッケージの型解決を `@arethetypeswrong/cli` 等のツールで CI に組み込み、回帰テストとして snapshot で固定する
  - 根拠: `packages/resolution/attw.test.ts` が inline snapshot で全サブパスの型解決結果を固定し、退行を検出する

- `[SHOULD]` CI に循環依存検出（madge 等）を組み込み、既知の除外パターンを明示的にリストする
  - 根拠: `package.json:88` で `madge --circular --exclude '(v4/core|v3|iso\\.ts)'` を実行し、レガシーコードは除外しつつ新規コードの循環依存を防止している

- `[AVOID]` `exports` を理解しないレガシーツールのために stub package.json を手動で作成・管理する — 自動生成スクリプトで postbuild フックに組み込むべき
  - 根拠: `scripts/write-stub-package-jsons.ts` が `index.d.cts` の存在をスキャンして自動生成し、`postbuild` で実行される

## 適用チェックリスト

- [ ] package.json の `exports` フィールドで CJS/ESM の両方のエントリポイントを定義しているか
- [ ] `types` 条件が `import`/`require` より先に記述されているか（条件の順序が正しいか）
- [ ] `@arethetypeswrong/cli` または同等のツールでビルド後の型解決を検証しているか
- [ ] 複数の moduleResolution 設定（bundler, nodenext, node16）でのコンパイルテストを CI に組み込んでいるか
- [ ] monorepo でパッケージ間参照する場合、カスタム条件でソース直接参照を設定しているか
- [ ] カスタム条件を使う場合、vitest/tsx/tsconfig/IDE 設定の全てで同じ条件名を使っているか
- [ ] バージョン番号を複数箇所で管理している場合、整合性チェックスクリプトがあるか
- [ ] `sideEffects: false` を設定して tree-shaking を有効化しているか
- [ ] 循環依存検出を CI に組み込んでいるか
- [ ] pre-commit / pre-push フックでフォーマット・リント・テストを実行しているか
