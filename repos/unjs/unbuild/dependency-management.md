# dependency-management

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-16

## 概要

unbuild における依存関係管理を分析した。このリポジトリは JavaScript ライブラリのビルドツールとして、「何をバンドルに含め、何を external として除外するか」を自動判定する仕組みを備えている。24 個の dependencies のうち 12 個が unjs エコシステムのパッケージであり、単一の設計思想に基づく小さなユーティリティを組み合わせる「マイクロライブラリ合成」パターンが徹底されている。さらに、`package.json` を唯一の真実源として扱い、externals の自動推論・依存関係の妥当性検証をビルドパイプラインに組み込むことで、宣言的かつ安全な依存管理を実現している点が注目に値する。

## 背景にある原則

- **package.json を Single Source of Truth として扱う**: dependencies / peerDependencies / optionalDependencies から externals を自動推論し、ビルド設定と package.json の乖離を構造的に防ぐ。手動で externals を列挙する方式ではメンテナンスコストが線形に増加するため、宣言的に「package.json に書いてあるものは external」というルールを機械的に適用する（`src/build.ts:241-247`, `src/utils.ts:166-196`）。

- **暗黙のバンドルを警告し、明示的な依存宣言を強制する**: `external()` 関数内で、明示的に external でもソースでもない依存をバンドルする際に `warn()` を発行する。「暗黙の依存は技術的負債」という原則に基づき、依存関係の意図を常に明示させる設計（`src/builders/rollup/config.ts:103-104`）。

- **エコシステムの一貫性を小さなモジュールの合成で達成する**: Node.js 標準の `path` の代わりに `pathe`、`glob` の代わりに `tinyglobby`、型推論に `pkg-types` など、それぞれが単一責務の unjs パッケージで統一することで、クロスプラットフォーム対応・API の一貫性・バンドルサイズ最適化を同時に実現する。

- **Node.js ビルトインモジュールを両形式で external 化する**: `Module.builtinModules` からプレフィックス付き（`node:fs`）・なし（`fs`）の両方を自動生成し、ESM/CJS どちらの記法で参照されても確実に external として扱う（`src/build.ts:127-130`）。

## 実例と分析

### externals の自動推論メカニズム

unbuild の最も重要な依存管理機構は `inferPkgExternals` 関数にある。この関数は package.json の複数のフィールドを読み取り、external として扱うべきモジュールのリストを自動生成する。

```typescript
// src/utils.ts:166-196
export function inferPkgExternals(pkg: PackageJson): (string | RegExp)[] {
  const externals: (string | RegExp)[] = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
    ...Object.keys(pkg.devDependencies || {}).filter((dep) =>
      dep.startsWith("@types/"),
    ),
    ...Object.keys(pkg.optionalDependencies || {}),
  ];

  if (pkg.name) {
    externals.push(pkg.name);
    if (pkg.exports) {
      for (const subpath of Object.keys(pkg.exports)) {
        if (subpath.startsWith("./")) {
          externals.push(pathToRegex(`${pkg.name}/${subpath.slice(2)}`));
        }
      }
    }
  }

  if (pkg.imports) {
    for (const importName of Object.keys(pkg.imports)) {
      if (importName.startsWith("#")) {
        externals.push(pathToRegex(importName));
      }
    }
  }

  return [...new Set(externals)];
}
```

注目すべき設計判断:

1. **devDependencies は `@types/` のみ external 化する** -- devDependencies の中でビルド成果物に影響するのは型定義パッケージだけであるため、それ以外（テストフレームワーク等）は除外する。
2. **自パッケージ名とその subpath exports を external 化する** -- 自己参照インポート（`import { foo } from "my-pkg/utils"`）がバンドルされないようにする。
3. **`#` で始まる imports フィールドを RegExp で external 化する** -- Node.js の [subpath imports](https://nodejs.org/api/packages.html#subpath-imports) に対応し、ワイルドカードパターンは正規表現に変換する。

### Rollup の external 判定ロジック（多層フィルタリング）

`getRollupOptions` の `external()` 関数は、モジュール ID を複数の基準で段階的に判定する。

```typescript
// src/builders/rollup/config.ts:61-106
external(originalId): boolean {
  const resolvedId = resolveAlias(originalId, _aliases);
  const pkgName =
    parseNodeModulePath(resolvedId)?.name ||
    parseNodeModulePath(originalId)?.name ||
    getpkg(originalId);

  // 1. 明示的な external ルールに一致するか
  if (
    arrayIncludes(ctx.options.externals, pkgName) ||
    arrayIncludes(ctx.options.externals, originalId) ||
    arrayIncludes(ctx.options.externals, resolvedId)
  ) {
    return true;
  }

  // 2. ソースコードなら常にバンドル
  for (const id of [originalId, resolvedId]) {
    if (
      id[0] === "." || isAbsolute(id) ||
      /src[/\\]/.test(id) || id.startsWith(ctx.pkg.name!)
    ) {
      return false;
    }
  }

  // 3. inlineDependencies で明示的にインラインを指定
  if (ctx.options.rollup.inlineDependencies === true || ...) {
    return false;
  }

  // 4. どれにも該当しない → 暗黙的にバンドルするが警告を出す
  warn(ctx, `Implicitly bundling "${originalId}"`);
  return false;
},
```

この多層判定の設計ポイントは:
- **パッケージ名・オリジナル ID・解決後 ID の 3 つで照合する** -- エイリアス経由のインポートでも正しく判定できる
- **「ソースは常にバンドル」を先に判定する** -- 相対パス・絶対パス・`src/` 内・自パッケージ名は無条件でバンドル対象
- **暗黙バンドルを許容しつつ警告する** -- ビルドは壊さないが、開発者に気づきを与えるフォールバック設計

### 依存関係の妥当性検証

ビルド完了後に `validateDependencies` が呼ばれ、実際に使用された import を追跡して依存関係の問題を検出する。

```typescript
// src/validate.ts:8-47
export function validateDependencies(ctx: BuildContext): void {
  const usedDependencies = new Set<string>();
  const unusedDependencies = new Set<string>(
    Object.keys(ctx.pkg.dependencies || {}),
  );
  const implicitDependencies = new Set<string>();
  for (const id of ctx.usedImports) {
    unusedDependencies.delete(id);
    usedDependencies.add(id);
  }
  // ...
  if (unusedDependencies.size > 0) {
    warn(ctx, "Potential unused dependencies found: " + ...);
  }
  if (implicitDependencies.size > 0 && !ctx.options.rollup.inlineDependencies) {
    warn(ctx, "Potential implicit dependencies found: " + ...);
  }
}
```

`usedImports` は Rollup のビルド結果（`entry.imports`）から収集され（`src/builders/rollup/build.ts:46-47`）、チャンクファイル名は除外される（`build.ts:64-65`）。これにより「package.json に書いてあるが使っていない依存」と「使っているが package.json に書いていない依存」の両方を検出する。

### unjs エコシステム活用パターン

unbuild の dependencies 24 個中 12 個が unjs パッケージであり、以下の使い分けが体系的に行われている:

| 用途 | Node.js 標準 / 一般的な選択肢 | unjs パッケージ |
|------|------|------|
| パス操作 | `node:path` | `pathe` (クロスプラットフォーム対応) |
| Glob | `glob`, `fast-glob` | `tinyglobby` (軽量) |
| package.json 型 | 自前定義 | `pkg-types` |
| 設定マージ | `lodash.merge` | `defu` (undefined のみ補完) |
| コンソール出力 | `console` | `consola` (レベル制御・カラー) |
| フック機構 | EventEmitter | `hookable` (型安全なフック) |
| JIT 実行 | `ts-node`, `tsx` | `jiti` (transform 不要で TS 実行) |
| CLI フレームワーク | `commander`, `yargs` | `citty` (軽量 CLI) |
| ESM 解析 | 自前実装 | `mlly` (parseNodeModulePath 等) |
| 文字列変換 | 自前実装 | `scule` (pascalCase 等) |
| 型スキーマ生成 | なし | `untyped` (ランタイム型からスキーマ) |
| ファイル変換 | なし | `mkdist` (ファイルごとの変換) |

この統一の利点は **API スタイルの一貫性**（すべて ESM-first、TypeScript-first）と **依存ツリーの重複排除**（unjs パッケージ同士が内部で同じ依存を共有する）にある。

### Node.js ビルトインの dual-format external 化

```typescript
// src/build.ts:127-130
externals: [
  ...Module.builtinModules,
  ...Module.builtinModules.map((m) => "node:" + m),
],
```

ESM では `import fs from "node:fs"` が推奨されるが、CJS コードでは `require("fs")` も依然として使われる。両方の形式を externals に含めることで、どちらの記法でインポートされても確実にバンドルから除外される。

### パッケージ名解決のユーティリティ

```typescript
// src/utils.ts:44-47
export function getpkg(id = ""): string {
  const s = id.split("/");
  return s[0][0] === "@" ? `${s[0]}/${s[1]}` : s[0];
}
```

スコープ付きパッケージ（`@org/pkg/path`）とスコープなしパッケージ（`pkg/path`）の両方に対応し、import パスからパッケージ名を正しく抽出する。`mlly` の `parseNodeModulePath` との併用でエイリアス解決後の ID にも対応する（`config.ts:66-69`）。

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 依存の external/inline 判定ロジックを段階的に適用する必要がある
  - 適用条件: 判定基準が複数あり、優先順位がある場合
  - コード例: `src/builders/rollup/config.ts:61-106` の `external()` 関数。明示的 external → ソースコード判定 → inlineDependencies → フォールバック（暗黙バンドル + 警告）の順で評価
  - 注意点: 各ステップの順序が意味を持つため、順序を変えると挙動が変わる

- **Specification パターン** (分類: 振る舞い)
  - 解決する問題: 文字列と正規表現の混在するマッチング条件を統一的に扱う
  - 適用条件: フィルタ条件にリテラル値とパターンが混在する場合
  - コード例: `src/utils.ts:151-160` の `arrayIncludes` 関数。`(string | RegExp)[]` を受け取り、統一的にマッチングする
  - 注意点: RegExp のグローバルフラグ（`g`）を使う場合は `lastIndex` のリセットが必要になる

## Good Patterns

- **package.json 駆動の externals 自動推論**: externals リストを手動管理せず、package.json の `dependencies`, `peerDependencies`, `optionalDependencies` から自動生成する。依存を追加・削除するたびにビルド設定を変更する必要がなく、両者の不整合を構造的に排除する。

```typescript
// src/build.ts:241-247
options.dependencies = Object.keys(pkg.dependencies || {});
options.peerDependencies = Object.keys(pkg.peerDependencies || {});
options.devDependencies = Object.keys(pkg.devDependencies || {});

options.externals.push(...inferPkgExternals(pkg));
options.externals = [...new Set(options.externals)];
```

- **ビルド後の依存関係バリデーション**: ビルド成果物の実際の import を追跡し、unused dependencies と implicit dependencies の両方を検出する。CI で `failOnWarn: true`（デフォルト）にすることで、依存関係の不整合をリリース前に検出できる。

```typescript
// src/validate.ts:8-47
// Rollup のビルド結果から usedImports を収集し、
// package.json の dependencies と突き合わせる
```

- **string | RegExp のユニオン型による柔軟なマッチング**: externals の指定に文字列（完全一致）と正規表現（パターンマッチ）の両方を受け付ける。単純なケースは文字列、ワイルドカードが必要なケースは RegExp と使い分けられる。

```typescript
// src/types.ts:116
externals: (string | RegExp)[];

// src/utils.ts:198-204
function pathToRegex(path: string): string | RegExp {
  return path.includes("*")
    ? new RegExp(
        `^${path.replace(/\./g, String.raw`\.`).replace(/\*/g, ".*")}$`,
      )
    : path;
}
```

- **暗黙バンドルの警告フォールバック**: external にも inline にも該当しない依存を「ビルドは通すが警告する」というフォールバック戦略で処理する。ビルドの堅牢性を維持しつつ、開発者に依存の明示を促す。

```typescript
// src/builders/rollup/config.ts:103-106
warn(ctx, `Implicitly bundling "${originalId}"`);
return false;
```

## Anti-Patterns / 注意点

- **externals の手動管理**: ビルド設定に externals を手動でハードコードすると、package.json との不整合が発生しやすい。依存の追加・削除のたびに二重メンテナンスが必要になる。

```typescript
// Bad: externals を手動管理
export default {
  rollup: {
    external: ["react", "react-dom", "lodash"], // package.json と二重管理
  },
};

// Better: package.json から自動推論させ、追加分のみ指定
export default defineBuildConfig({
  externals: [/^@internal\//], // 自動推論 + 追加ルールのみ
});
```

- **devDependencies を無差別に external 化する**: devDependencies にはテストフレームワークやリンターなどビルド成果物と無関係なものが多い。全て external にすると、ビルド成果物が存在しない依存を参照する可能性がある。unbuild は `@types/` スコープのみを external 化する。

```typescript
// Bad: devDependencies を全て external 化
externals: [
  ...Object.keys(pkg.devDependencies || {}),
];

// Better: 型定義パッケージのみ external 化
...Object.keys(pkg.devDependencies || {}).filter((dep) =>
  dep.startsWith("@types/"),
),
```

- **依存検証なしのビルドパイプライン**: ビルドが成功しても、unused dependencies（不要な依存による肥大化）や implicit dependencies（package.json に未宣言の依存）が残っていると、消費者側で問題が発生する。ビルド後の検証ステップは必須。

## 導出ルール

- `[MUST]` ライブラリビルドでは package.json の dependencies / peerDependencies を externals の真実源とし、自動推論する仕組みを構築する
  - 根拠: `inferPkgExternals` が dependencies, peerDependencies, optionalDependencies, self-reference, subpath imports を一括で external 化している（`src/utils.ts:166-196`）。手動管理では不整合が不可避。

- `[MUST]` Node.js ビルトインモジュールは `node:` プレフィックス付き・なしの両形式を externals に含める
  - 根拠: ESM は `node:fs`、CJS は `fs` でインポートされるため、両方をカバーしないとビルトインがバンドルに含まれる（`src/build.ts:127-130`）。

- `[SHOULD]` ビルド後に「実際に使用された import」と「package.json の宣言」を突き合わせて、unused / implicit dependencies を検出する
  - 根拠: `validateDependencies` がビルド成果物の `usedImports` を追跡し、package.json との差分を警告する（`src/validate.ts:8-47`）。CI で `failOnWarn: true` にすることでリリース前に検出可能。

- `[SHOULD]` 依存パッケージは同一エコシステムの小さなモジュールを優先的に採用し、API スタイルと内部依存ツリーの一貫性を確保する
  - 根拠: unbuild は 24 個の dependencies のうち 12 個を unjs エコシステムで統一し、ESM-first / TypeScript-first の一貫した開発体験と依存ツリーの重複排除を実現している。

- `[SHOULD]` externals のマッチングには文字列と正規表現のユニオン型 `(string | RegExp)[]` を採用し、`arrayIncludes` のような統一的なマッチング関数で判定する
  - 根拠: subpath exports のワイルドカード（`./drivers/*.js`）やスコープ付きパッケージの柔軟なマッチングが必要であり、文字列だけでは表現力が不足する（`src/utils.ts:151-160, 198-204`）。

- `[AVOID]` devDependencies を無差別に external 化する -- `@types/` スコープのみに限定すべき
  - 根拠: devDependencies にはテストフレームワーク等ビルド成果物と無関係な依存が含まれ、全てを external 化すると実行時に存在しない依存への参照が残る（`src/utils.ts:170-172`）。

- `[AVOID]` 依存の external/inline 判定で「暗黙のバンドル」を無警告で許容する
  - 根拠: unbuild は暗黙バンドル時に必ず `warn()` を発行し、`failOnWarn` で CI を止められる設計にしている（`src/builders/rollup/config.ts:103-106`）。暗黙の依存は消費者に予期しない動作をもたらす。

## 適用チェックリスト

- [ ] ビルド設定の externals が package.json から自動推論される仕組みになっているか（手動の externals リストが package.json と二重管理になっていないか）
- [ ] Node.js ビルトインモジュールが `node:` プレフィックス付き・なしの両方で external 化されているか
- [ ] ビルド後に unused dependencies と implicit dependencies を検出するバリデーションステップがあるか
- [ ] devDependencies の external 化が `@types/` スコープに限定されているか（テストフレームワーク等が混入していないか）
- [ ] externals の指定に正規表現を使えるようになっているか（subpath exports のワイルドカード対応）
- [ ] 自パッケージ名（self-reference）と subpath exports が externals に含まれているか
- [ ] 依存パッケージの選定基準が明確か（エコシステムの一貫性、ESM/CJS 対応、バンドルサイズ等）
- [ ] 暗黙のバンドルが発生した場合に警告またはエラーが出る仕組みがあるか
