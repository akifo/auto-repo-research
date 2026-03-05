# dependency-management

> リポジトリ: drizzle-team/drizzle-orm
> 分析日: 2026-03-04

## 概要

drizzle-orm は pnpm workspace + Turborepo で管理されるモノレポで、8 つの公開パッケージと 1 つの内部テストパッケージを持つ。コアパッケージ（drizzle-orm）が 25 以上のデータベースドライバを全て optional な peerDependencies として宣言し、ユーザーが使うドライバだけをインストールする設計になっている。この「全 optional peer deps」戦略と、`workspace:./pkg/dist` による dist ディレクトリ直接参照、`Symbol.for` によるデュアルパッケージ同一性保証が特に注目に値する。

## 背景にある原則

- **ユーザー選択の最大化（Install What You Use）**: ライブラリがサポートする全ドライバ・全バリデーションライブラリをインストールさせるのではなく、peer deps + optional 宣言で「ユーザーが選んだものだけ」をインストールさせる。これによりインストールサイズを抑え、依存の衝突リスクを最小化する。根拠: `drizzle-orm/package.json` で 25 以上の peerDependencies が全て `peerDependenciesMeta` で `optional: true` と宣言されている。

- **ビルド成果物が公開物と同一である保証（Dist-as-Package）**: 開発中にワークスペース内パッケージを参照する際、パッケージルートではなくビルド済み `dist/` ディレクトリを直接指す（`workspace:./drizzle-orm/dist`）。これにより開発中のテスト・型チェックが npm publish 後のユーザー体験と同一になる。根拠: `package.json:25` の `"drizzle-orm": "workspace:./drizzle-orm/dist"` および `drizzle-zod/package.json:74` の `"drizzle-orm": "link:../drizzle-orm/dist"`。

- **パッケージ境界を越える型安全性の維持**: `instanceof` を禁止し、代わりに `Symbol.for` ベースの `entityKind` で型判定を行うことで、パッケージの重複インストールやバンドラーによる分割時にも正しく動作させる。根拠: `.eslintrc.yaml:77` の `no-instanceof/no-instanceof: error` ルールと `drizzle-orm/src/entity.ts` の `is()` 関数。

- **独立バージョニングによるリリース柔軟性**: 各パッケージが独立したバージョンを持ち、変更があったパッケージだけを個別にリリースする。Changesets のようなバージョニングツールは使わず、`changelogs/<package>/<version>.md` で手動管理する。根拠: `drizzle-orm@0.45.1` と `drizzle-kit@0.31.9` のバージョン差、および `changelogs/` のパッケージ別ディレクトリ構成。

## 実例と分析

### ワークスペース構成と依存グラフ

`pnpm-workspace.yaml` で 9 パッケージを定義している。Turborepo の `turbo.json` でビルド順序を明示的に制御し、全パッケージのビルドが `drizzle-orm#build` に依存する星型の依存グラフを形成する。

```yaml
# pnpm-workspace.yaml
packages:
  - drizzle-orm
  - drizzle-kit
  - drizzle-zod
  - drizzle-typebox
  - drizzle-valibot
  - drizzle-arktype
  - drizzle-seed
  - integration-tests
  - eslint-plugin-drizzle
```

`turbo.json` ではパッケージごとにビルドタスクを定義し、依存関係を宣言している:

```jsonc
// turbo.json:73-93（一部抜粋）
"drizzle-zod#build": {
  "dependsOn": ["drizzle-orm#build"],
  // ...
},
"drizzle-kit#build": {
  "dependsOn": ["drizzle-orm#build"],
  // ...
}
```

テストとパックはビルド完了後に実行される:

```jsonc
// turbo.json:228-252
"pack": {
  "dependsOn": ["build", "test:types"],
  // ...
},
"test": {
  "dependsOn": ["build", "test:types"],
  // ...
}
```

### workspace: と link: の使い分け

モノレポ内のパッケージ間参照に 2 種類のプロトコルが使われている:

1. **`workspace:` + dist パス**: ルート、drizzle-kit、drizzle-seed、integration-tests で使用。pnpm の workspace プロトコルで dist ディレクトリを直接指す。

```jsonc
// package.json:25（ルート）
"drizzle-orm": "workspace:./drizzle-orm/dist"

// drizzle-kit/package.json:86
"drizzle-orm": "workspace:./drizzle-orm/dist"

// drizzle-seed/package.json:89-90
"drizzle-kit": "workspace:./drizzle-kit/dist",
"drizzle-orm": "workspace:./drizzle-orm/dist"
```

2. **`link:` + 相対 dist パス**: drizzle-zod, drizzle-typebox, drizzle-valibot, drizzle-arktype で使用。

```jsonc
// drizzle-zod/package.json:74
"drizzle-orm": "link:../drizzle-orm/dist"
```

`workspace:` は pnpm のバージョン解決・publish 時の変換の恩恵を受け、`link:` はシンプルなシンボリックリンクとして機能する。バリデーション統合パッケージ群では drizzle-orm を `peerDependencies` としても宣言しており、`link:` は開発時の型解決のためだけに devDependencies で使う設計になっている。

### 全 optional peer deps パターン

drizzle-orm の `peerDependencies` には 25 以上のドライバ・ユーティリティが列挙され、全てが `peerDependenciesMeta` で `optional: true` と宣言されている。ソースコード上、各ドライバは `src/<driver-name>/` 配下に分離されており、ユーザーが `import { drizzle } from 'drizzle-orm/node-postgres'` のようにサブパスインポートで選択的に読み込む。

```jsonc
// drizzle-orm/package.json:47-76（一部）
"peerDependencies": {
  "@aws-sdk/client-rds-data": ">=3",
  "@electric-sql/pglite": ">=0.2.0",
  "@libsql/client": ">=0.10.0",
  "better-sqlite3": ">=7",
  "mysql2": ">=2",
  "pg": ">=8",
  "postgres": ">=3",
  // ... 他 18 パッケージ
},
"peerDependenciesMeta": {
  "mysql2": { "optional": true },
  "pg": { "optional": true },
  // ... 全て optional
}
```

ビルドスクリプト（`drizzle-orm/scripts/build.ts:8-44`）が `src/**/*.ts` から自動的に exports map を生成するため、ドライバの追加時に exports を手動で更新する必要がない:

```typescript
// drizzle-orm/scripts/build.ts:8-44
const entries = await glob("src/**/*.ts");
pkg.exports = entries.reduce((acc, rawEntry) => {
  const entry = rawEntry.match(/src\/(.*)\.ts/)![1]!;
  const exportsEntry = entry === "index" ? "." : "./" + entry.replace(/\/index$/, "");
  acc[exportsEntry] = {
    import: { types: `./${entry}.d.ts`, default: `./${entry}.js` },
    require: { types: `./${entry}.d.cts`, default: `./${entry}.cjs` },
    types: `./${entry}.d.ts`,
    default: `./${entry}.js`,
  };
  return acc;
}, {});
```

### Symbol.for によるデュアルパッケージ同一性保証

`instanceof` はパッケージの重複インストール（node_modules に同じパッケージの異なるコピーが存在する場合）で壊れる。drizzle-orm はこの問題を 3 つの仕組みで解決している:

1. **ESLint で `instanceof` を禁止**: `.eslintrc.yaml:77` で `no-instanceof/no-instanceof: error`
2. **`Symbol.for` ベースの型判定**: `drizzle-orm/src/entity.ts` の `is()` 関数
3. **ESLint で `entityKind` を強制**: カスタム ESLint プラグインがクラスに `static readonly [entityKind]` を要求

```typescript
// drizzle-orm/src/entity.ts:1-42
export const entityKind = Symbol.for("drizzle:entityKind");

export function is<T extends DrizzleEntityClass<any>>(value: any, type: T): value is InstanceType<T> {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (value instanceof type) { // eslint-disable-line no-instanceof/no-instanceof
    return true;
  }
  // Symbol.for は同じキーなら同じ Symbol を返すため、
  // パッケージが重複しても正しく判定できる
  let cls = Object.getPrototypeOf(value).constructor;
  while (cls) {
    if (entityKind in cls && cls[entityKind] === type[entityKind]) {
      return true;
    }
    cls = Object.getPrototypeOf(cls);
  }
  return false;
}
```

### バリデーション統合パッケージの依存戦略

drizzle-zod, drizzle-typebox, drizzle-valibot, drizzle-arktype は統一されたパターンで依存を宣言している:

- `drizzle-orm` と対応するバリデーションライブラリを `peerDependencies` で宣言
- `devDependencies` に `link:../drizzle-orm/dist` で開発時の参照を設定
- 最小バージョンのみ指定（`"drizzle-orm": ">=0.36.0"`）

```jsonc
// drizzle-zod/package.json:66-69
"peerDependencies": {
  "drizzle-orm": ">=0.36.0",
  "zod": "^3.25.0 || ^4.0.0"
}
```

zod の `^3.25.0 || ^4.0.0` のように、メジャーバージョンの移行期には OR 指定でユーザーの移行猶予を確保している。

### リリースワークフロー

リリースは `router.yaml` がブランチに応じて latest / feature の 2 つのワークフローに振り分ける:

1. **Feature branch release**: バージョンに git SHA を付与（`0.45.1-abc1234`）、ブランチ名を npm dist-tag に設定
2. **Latest release**: `changelogs/<package>/<version>.md` の存在を必須とし、npm の latest タグで公開

```yaml
# .github/workflows/release-latest.yaml:398-427（一部）
latest="$(npm view --json ${{ matrix.package }} dist-tags.latest | jq -r)"
version="$(jq -r .version package.json)"
changelogPath=$(node -e "console.log(require('path').resolve('..', 'changelogs', '${{ matrix.package }}', '$version.md'))")
if [[ ! -f "$changelogPath" ]]; then
  echo "::error::Changelog for version $version not found: $changelogPath"
  exit 1
fi
```

各パッケージのリリースは独立しており、テスト・ATTW チェック（`@arethetypeswrong/cli`）を通過したパッケージのみ公開される。feature branch の unpublish は `on: delete` イベントで自動実行される。

### drizzle-kit のバンドル戦略

drizzle-kit はほぼ全ての依存を esbuild でバンドルし、`drizzle-orm` とデータベースドライバだけを external に保つ。これにより最終ユーザーのインストールサイズを最小化しつつ、ドライバの柔軟な選択を維持している:

```typescript
// drizzle-kit/build.ts:7-21
const driversPackages = [
  "pg",
  "postgres",
  "@vercel/postgres",
  "@neondatabase/serverless",
  "@electric-sql/pglite",
  "mysql2",
  "@planetscale/database",
  "@libsql/client",
  "better-sqlite3",
  "bun:sqlite",
];

esbuild.buildSync({
  // ...
  external: ["esbuild", "drizzle-orm", ...driversPackages],
});
```

## パターンカタログ

- **Adapter パターン** (分類: 構造)
  - 解決する問題: 複数のデータベースドライバに対して統一的なインターフェースを提供する
  - 適用条件: コアライブラリが複数の外部ライブラリとの統合をサポートする場合
  - コード例: `drizzle-orm/src/node-postgres/driver.ts:1`、`drizzle-orm/src/neon-http/driver.ts:1`
  - 注意点: 各アダプタが対応する外部ライブラリを peer dep として参照するため、アダプタ追加 = peer dep 追加になる

## Good Patterns

- **exports map の自動生成**: `drizzle-orm/scripts/build.ts:8-44` で `src/**/*.ts` をスキャンし、exports map を動的に構築する。ドライバ追加時に `package.json` の手動更新が不要になり、exports の漏れを防ぐ。

- **dist ディレクトリの直接参照**: `workspace:./drizzle-orm/dist` によりビルド成果物を直接テスト・型チェックに使用する。publish 後にしか発見できない問題（exports 不整合、CJS/ESM の混在エラー等）を開発中に検出できる。

- **ATTW による公開前チェック**: CI で全パッケージに対して `@arethetypeswrong/cli` を実行し、TypeScript の `moduleResolution` 設定ごとの型解決の正しさを公開前に検証する（`.github/workflows/release-latest.yaml:222-304`）。

- **Symbol.for + ESLint 強制**: `entityKind` を ESLint ルールで全クラスに強制することで、`instanceof` の代替パターンをヒューマンエラーなく適用できる。auto-fix 付きなので導入コストも低い（`eslint/eslint-plugin-drizzle-internal/index.js:65-75`）。

## Anti-Patterns / 注意点

- **onlyBuiltDependencies の肥大化**: `pnpm-workspace.yaml` の `onlyBuiltDependencies` に 16 パッケージが列挙されている。pnpm 10 以降、ネイティブモジュールのビルドを明示的に許可する必要があるが、統合テストで多くのドライバを使うためリストが長大になっている。

```yaml
# Bad: 管理が煩雑になる
onlyBuiltDependencies:
  - '@contrast/fn-inspect'
  - '@newrelic/native-metrics'
  - '@prisma/client'
  # ... 13 パッケージ続く

# Better: CI とローカルで設定を分離するか、
# pnpm の config で管理する
```

- **workspace: と link: の混在**: 同じモノレポ内で `workspace:` と `link:` の 2 種類のプロトコルが混在しており、意図が不明確。一貫して `workspace:` を使う方が pnpm のバージョン解決や publish 時の変換が統一される。

```jsonc
// Bad: プロトコルが混在
"drizzle-orm": "workspace:./drizzle-orm/dist"  // drizzle-kit
"drizzle-orm": "link:../drizzle-orm/dist"       // drizzle-zod

// Better: workspace: に統一
"drizzle-orm": "workspace:../drizzle-orm/dist"  // drizzle-zod
```

## 導出ルール

- `[MUST]` モノレポで公開パッケージを開発する場合、CI にパッケージ型チェックツール（attw 等）を組み込み、全 moduleResolution 設定での型解決を公開前に検証する
  - 根拠: drizzle-orm はリリースワークフローで全パッケージに `@arethetypeswrong/cli` を実行し、CJS/ESM の型解決問題を公開前に検出している（`.github/workflows/release-latest.yaml:222-304`）

- `[MUST]` ライブラリが複数の外部パッケージとの統合をサポートする場合、全てを optional な peerDependencies として宣言し、サブパスエクスポートでアダプタを分離する
  - 根拠: drizzle-orm は 25 以上のドライバを全て optional peer deps にし、`src/<driver>/` + 自動生成 exports map でユーザーが必要なドライバだけをインストールする設計にしている

- `[SHOULD]` モノレポ内のパッケージ間参照では dist ディレクトリを直接指し、ビルド成果物で開発・テストする
  - 根拠: `workspace:./drizzle-orm/dist` により、開発中に npm publish 後と同じファイル構造でテスト・型チェックが行われ、exports 不整合の早期発見につながる

- `[SHOULD]` npm パッケージとして公開するライブラリで `instanceof` の代わりに `Symbol.for` ベースの型判定を使い、パッケージ重複時の同一性問題を回避する
  - 根拠: `drizzle-orm/src/entity.ts` の `is()` 関数が `Symbol.for('drizzle:entityKind')` で型判定を行い、ESLint ルールで全クラスへの適用を強制している

- `[SHOULD]` モノレポの各パッケージは独立したバージョンを持ち、変更があったパッケージだけを個別にリリースする
  - 根拠: drizzle-orm（v0.45.1）と drizzle-kit（v0.31.9）は独立したバージョンで管理され、CI がバージョン差分を検出して変更のあるパッケージだけを公開する

- `[SHOULD]` exports map のエントリが多いパッケージでは、ソースファイルのグロブから exports を自動生成するビルドスクリプトを用意する
  - 根拠: `drizzle-orm/scripts/build.ts` が `src/**/*.ts` から exports を自動生成し、ドライバ追加時の手動更新漏れを防いでいる

- `[AVOID]` peer deps のメジャーバージョン移行時に旧バージョンのサポートを即座に切り捨てる。OR 指定（`^3.25.0 || ^4.0.0`）でユーザーに移行猶予を与える
  - 根拠: drizzle-zod が `"zod": "^3.25.0 || ^4.0.0"` で Zod v3/v4 の両方をサポートし、ユーザーの段階的移行を許容している

## 適用チェックリスト

- [ ] 公開パッケージの CI に `@arethetypeswrong/cli`（または同等ツール）を組み込んでいるか
- [ ] 外部統合が複数ある場合、全て optional peer deps + サブパスエクスポートで分離しているか
- [ ] モノレポ内のパッケージ間参照が dist ディレクトリを指しているか（publish 後と同一条件でテストしているか）
- [ ] `instanceof` を使う箇所がないか。ある場合、`Symbol.for` ベースの代替を検討したか
- [ ] exports map が手動管理の場合、ソースとの不整合がないか。自動生成を検討したか
- [ ] peer deps のバージョン範囲がユーザーに過度な制約を課していないか（メジャーバージョン移行期の OR 指定等）
- [ ] Turborepo 等でパッケージ間のビルド順序を明示的に定義しているか
- [ ] feature branch で npm dist-tag を使ったプレリリースを提供しているか
