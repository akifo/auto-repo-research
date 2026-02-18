# code-generation-techniques

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-18

## 概要

unbuild が採用するコード生成・DTS 生成の技法を分析する。unbuild は rollup、mkdist、untyped という3つのビルダーを統一インターフェースで束ね、それぞれ異なるコード生成戦略を持つ。注目すべきは、(1) 単一の Rollup ビルド結果から ESM/CJS/DTS の3フォーマットを生成する「1-build-multi-write」パターン、(2) MagicString による AST-less なコード変換、(3) jiti を活用したスタブ生成によるゼロビルド開発体験、(4) untyped による「ランタイムオブジェクトからの型・スキーマ逆生成」という4つの技法である。

## 背景にある原則

- **単一の中間表現から複数出力を導出すべき（Single Source of Truth for Outputs）**: Rollup のバンドル結果という1つの中間表現から `.mjs`、`.cjs`、`.d.mts`、`.d.cts`、`.d.ts` を `write()` の呼び分けで生成する。ビルドパイプラインを重複させずに済み、入力の一貫性が保証される。根拠: `src/builders/rollup/build.ts:37-126` の OutputOptions 使い分け。

- **コード変換は最小限の侵襲で行うべき（Minimal Invasive Transformation）**: AST パーサを使わず、正規表現 + MagicString で CJS shim 挿入やシバン処理を行う。フルパースのコストを避けつつ、sourcemap の正確性を `MagicString.generateMap()` で担保する。根拠: `src/builders/rollup/plugins/cjs.ts:52-65` の `CJSToESM` 関数。

- **ビルドレスな開発体験をスタブで実現すべき**: 本番ビルドと同じエントリポイント構造を持つスタブファイル（jiti による動的インポートのラッパー）を生成し、開発中はビルドなしでソースを直接実行可能にする。根拠: `src/builders/rollup/stub.ts:15-188` のスタブ生成全体。

- **ランタイム値から型を逆生成する方が設定スキーマの信頼性が高い**: TypeScript の型定義を手書きするのではなく、実際のデフォルト値オブジェクトから untyped が JSON Schema と TypeScript 型宣言を自動導出する。デフォルト値と型の乖離が原理的に発生しない。根拠: `src/builders/untyped/index.ts:42-77`。

## 実例と分析

### 1. 1-build-multi-write パターン（Rollup DTS 生成）

Rollup ビルダーの DTS 生成は、`rollup-plugin-dts` を差し込んだ状態で一度だけ `rollup()` を実行し、その結果を3回 `write()` することで `.d.cts`、`.d.mts`、`.d.ts` を生成する。

```typescript
// src/builders/rollup/build.ts:80-126
if (ctx.options.declaration) {
    rollupOptions.plugins = [
      ...rollupOptions.plugins,
      dts(ctx.options.rollup.dts),
      removeShebangPlugin(),
      ctx.options.rollup.emitCJS && fixCJSExportTypePlugin(ctx),
    ].filter(
      (plugin): plugin is NonNullable<Exclude<typeof plugin, false>> =>
        !!plugin && (!("name" in plugin) || plugin.name !== "commonjs"),
    );

    await ctx.hooks.callHook("rollup:dts:options", ctx, rollupOptions);
    const typesBuild = await rollup(rollupOptions);
    await ctx.hooks.callHook("rollup:dts:build", ctx, typesBuild);
    // CJS 型定義
    if (ctx.options.rollup.emitCJS) {
      await typesBuild.write({
        dir: resolve(ctx.options.rootDir, ctx.options.outDir),
        entryFileNames: "[name].d.cts",
        chunkFileNames: (chunk) => getChunkFilename(ctx, chunk, "d.cts"),
      });
    }
    // ESM 型定義
    await typesBuild.write({
      dir: resolve(ctx.options.rootDir, ctx.options.outDir),
      entryFileNames: "[name].d.mts",
      chunkFileNames: (chunk) => getChunkFilename(ctx, chunk, "d.mts"),
    });
    // Node10 互換 (.d.ts)
    if (
      ctx.options.declaration === true ||
      ctx.options.declaration === "compatible"
    ) {
      await typesBuild.write({
        dir: resolve(ctx.options.rootDir, ctx.options.outDir),
        entryFileNames: "[name].d.ts",
        chunkFileNames: (chunk) => getChunkFilename(ctx, chunk, "d.ts"),
      });
    }
}
```

重要な点は、DTS ビルド時に `commonjs` プラグインを意図的に除外していること（L93）。`rollup-plugin-dts` と `@rollup/plugin-commonjs` の競合問題（Issue #396）への対処として、プラグイン配列を `filter` で後処理している。

### 2. MagicString による AST-less コード変換

CJS shim の挿入は、ESM バンドルに `__filename`、`__dirname`、`require` が含まれる場合にのみ行われる。検出は正規表現で行い、挿入位置は `mlly.findStaticImports` で最後の import 文の直後を特定する。

```typescript
// src/builders/rollup/plugins/cjs.ts:38-65
const CJSyntaxRe = /__filename|__dirname|require\(|require\.resolve\(/;

const CJSShim = `

// -- Unbuild CommonJS Shims --
import __cjs_url__ from 'url';
import __cjs_path__ from 'path';
import __cjs_mod__ from 'module';
const __filename = __cjs_url__.fileURLToPath(import.meta.url);
const __dirname = __cjs_path__.dirname(__filename);
const require = __cjs_mod__.createRequire(import.meta.url);
`;

function CJSToESM(code: string): { code: string; map: any } | null {
  if (code.includes(CJSShim) || !CJSyntaxRe.test(code)) {
    return null;
  }

  const lastESMImport = findStaticImports(code).pop();
  const indexToAppend = lastESMImport ? lastESMImport.end : 0;
  const s = new MagicString(code);
  s.appendRight(indexToAppend, CJSShim);

  return {
    code: s.toString(),
    map: s.generateMap(),
  };
}
```

`CJSShim` 文字列での冪等性チェック（`code.includes(CJSShim)`）により、同じ shim が二重挿入されることを防いでいる。

### 3. スタブファイル生成（コード文字列の組み立て）

スタブモードでは、実際にバンドルを行わず、jiti を経由してソースファイルを直接 require/import するラッパーコードを生成する。CJS・ESM・DTS の3種類のスタブを1つのループ内で生成する。

```typescript
// src/builders/rollup/stub.ts:99-116 (CJS スタブ)
await writeFile(
  output + ".cjs",
  shebang +
    [
      `const { createJiti } = require(${JSON.stringify(jitiCJSPath)})`,
      ...importedBabelPlugins.map(
        (plugin, i) =>
          `const plugin${i} = require(${JSON.stringify(plugin)})`,
      ),
      "",
      `const jiti = createJiti(__filename, ${serializedJitiOptions})`,
      "",
      `/** @type {import(${JSON.stringify(
        resolvedEntryForTypeImport,
      )})} */`,
      `module.exports = jiti(${JSON.stringify(resolvedEntry)})`,
    ].join("\n"),
);
```

ESM スタブでは `resolveModuleExportNames` で名前付きエクスポートを事前に解析し、それぞれを re-export する。

```typescript
// src/builders/rollup/stub.ts:141-163 (ESM スタブ)
await writeFile(
  output + ".mjs",
  shebang +
    [
      `import { createJiti } from ${JSON.stringify(jitiESMPath)};`,
      // ...
      `const _module = await jiti.import(${JSON.stringify(resolvedEntry)});`,
      hasDefaultExport
        ? "\nexport default _module?.default ?? _module;"
        : "",
      ...namedExports
        .filter((name) => name !== "default")
        .map((name) => `export const ${name} = _module.${name};`),
    ].join("\n"),
);
```

DTS スタブは型の re-export のみで構成される。

```typescript
// src/builders/rollup/stub.ts:166-181 (DTS スタブ)
if (ctx.options.declaration) {
  const dtsContent = [
    `export * from ${JSON.stringify(resolvedEntryForTypeImport)};`,
    hasDefaultExport
      ? `export { default } from ${JSON.stringify(resolvedEntryForTypeImport)};`
      : "",
  ].join("\n");
  await writeFile(output + ".d.cts", dtsContent);
  await writeFile(output + ".d.mts", dtsContent);
  if (
    ctx.options.declaration === "compatible" ||
    ctx.options.declaration === true
  ) {
    await writeFile(output + ".d.ts", dtsContent);
  }
}
```

### 4. untyped によるランタイム値からの型生成

untyped ビルダーは Babel プラグイン経由でソースを読み込み、エクスポートされたオブジェクトから JSON Schema を解決し、そこから TypeScript 型宣言・Markdown ドキュメント・JSON スキーマ・デフォルト値 JSON の4つの成果物を生成する。

```typescript
// src/builders/untyped/index.ts:38-78
const untypedJiti = createJiti(ctx.options.rootDir, options.jiti);

const distDir = entry.outDir!;

let rawSchema =
  ((await untypedJiti.import(resolve(ctx.options.rootDir, entry.input), {
    try: true,
  })) as InputObject) || ({} as InputObject);

// ...

const schema = await resolveSchema(rawSchema, defaults);

const outputs: UntypedOutputs = {
  markdown: {
    fileName: resolve(distDir, `${entry.name}.md`),
    contents: generateMarkdown(schema),
  },
  schema: {
    fileName: `${entry.name}.schema.json`,
    contents: JSON.stringify(schema, null, 2),
  },
  defaults: {
    fileName: `${entry.name}.defaults.json`,
    contents: JSON.stringify(defaults, null, 2),
  },
  declaration: entry.declaration
    ? {
        fileName: `${entry.name}.d.ts`,
        contents: generateTypes(schema, {
          interfaceName: pascalCase(entry.name + "-schema"),
        }),
      }
    : undefined,
};
```

### 5. プラグインの条件付き合成

Rollup プラグイン配列は `option && pluginFn(option)` のパターンで条件付きに構成され、最後に `.filter(Boolean)` でフィルタされる。`false` をオプションに渡すことでプラグインを無効化できる設計。

```typescript
// src/builders/rollup/config.ts:114-166
plugins: [
  ctx.options.rollup.replace &&
    replace({
      ...ctx.options.rollup.replace,
      values: {
        ...ctx.options.replace,
        ...ctx.options.rollup.replace.values,
      },
    }),

  ctx.options.rollup.alias &&
    alias({
      ...ctx.options.rollup.alias,
      entries: _aliases,
    }),

  // ... 他のプラグインも同様

  ctx.options.rollup.cjsBridge && cjsPlugin({}),

  rawPlugin(),
].filter((p): p is NonNullable<Exclude<typeof p, false>> => !!p),
```

### 6. JSON プラグインのラッパーによる出力形式の修正

`@rollup/plugin-json` の出力を `export default` から `module.exports =` に変換するラッパーを作り、CJS 互換性を確保している。

```typescript
// src/builders/rollup/plugins/json.ts:7-26
export function JSONPlugin(options: RollupJsonOptions): Plugin {
  const plugin = rollupJSONPlugin(options);
  return {
    ...plugin,
    name: "unbuild-json",
    transform(code, id): TransformResult {
      const res = (plugin.transform as TransformHook)!.call(this, code, id);
      if (
        res &&
        typeof res !== "string" &&
        "code" in res &&
        res.code &&
        res.code.startsWith(EXPORT_DEFAULT)
      ) {
        res.code = res.code.replace(EXPORT_DEFAULT, "module.exports = ");
      }
      return res;
    },
  } satisfies Plugin;
}
```

## パターンカタログ

- **Decorator / Wrapper パターン** (分類: 構造)
  - 解決する問題: サードパーティプラグインの出力形式がプロジェクト要件に合わない
  - 適用条件: 既存プラグインの振る舞いを小さく修正したいが、フォークするほどではない
  - コード例: `src/builders/rollup/plugins/json.ts:7-26` — `rollupJSONPlugin` をスプレッドでラップし、`transform` のみオーバーライド
  - 注意点: 元プラグインの内部実装（`transform` の戻り値形式）に依存するため、バージョンアップ時に壊れうる

- **Template Method パターン** (分類: 振る舞い)
  - 解決する問題: 複数のビルダー（rollup, mkdist, untyped, copy）が異なるビルド戦略を持つが、前処理・後処理は共通
  - 適用条件: ビルドパイプラインのステップが決まっているが、各ステップの実装がビルダーごとに異なる
  - コード例: `src/build.ts:293-306` — `buildTasks` 配列に各ビルダーを並べ、共通コンテキストで順次実行
  - 注意点: フックシステム（hookable）が Template Method のカスタマイズポイントを担っている

## Good Patterns

- **`option | false` による条件付きプラグイン合成**: 各プラグインオプションの型を `PluginOptions | false` とすることで、`false` を渡すだけでプラグインを完全に無効化できる。ユーザーの設定コードが宣言的になり、`if` 文のネストを避けられる。
  ```typescript
  // src/builders/rollup/types.ts:60-106
  replace: RollupReplaceOptions | false;
  alias: RollupAliasOptions | false;
  resolve: RollupNodeResolveOptions | false;
  // ...
  ```

- **冪等性チェック付きコード変換**: CJS shim の挿入前に `code.includes(CJSShim)` で既存の shim を検出し、二重挿入を防止する。コード変換は必ず冪等性を保証すべきという原則の実装。
  ```typescript
  // src/builders/rollup/plugins/cjs.ts:53
  if (code.includes(CJSShim) || !CJSyntaxRe.test(code)) {
    return null;
  }
  ```

- **`satisfies` による型安全な設定オブジェクト構築**: Rollup の OutputOptions やプラグイン配列の構築で `satisfies` を使い、型推論を維持しつつ型チェックを行う。`as` によるアサーションと異なり、実際の型と一致しない場合にコンパイルエラーになる。
  ```typescript
  // src/builders/rollup/config.ts:45,58,167
  } satisfies OutputOptions),
  // ...
  } satisfies RollupOptions;
  ```

- **declaration の段階的オプション**: `"compatible" | "node16" | boolean` の union 型で DTS 生成モードを制御する。`true` は `"compatible"` と同等、`"node16"` は `.d.ts` を省略する。古い TypeScript バージョンとの互換性を段階的に選択できる。
  ```typescript
  // src/types.ts:70-78
  declaration?: "compatible" | "node16" | boolean;
  ```

## Anti-Patterns / 注意点

- **文字列テンプレートによるコード生成の脆弱性**: スタブ生成で配列の `join("\n")` によるコード文字列組み立てを多用している。エスケープ漏れや意図しない改行の挿入が起こりうる。`JSON.stringify` で値を安全にシリアライズしている点は良いが、テンプレート全体の見通しが悪い。
  ```typescript
  // Bad: 文字列配列の join による複雑なコード生成
  // src/builders/rollup/stub.ts:99-116
  shebang +
    [
      `const { createJiti } = require(${JSON.stringify(jitiCJSPath)})`,
      // ... 多数の行
    ].join("\n"),
  ```
  ```typescript
  // Better: テンプレートリテラルまたはコード生成ライブラリ（ts-morph, recast）の使用
  const code = dedent`
    const { createJiti } = require(${JSON.stringify(jitiCJSPath)});
    const jiti = createJiti(__filename, ${serializedJitiOptions});
    module.exports = jiti(${JSON.stringify(resolvedEntry)});
  `;
  ```

- **Babel プラグインのシリアライズハック**: スタブ生成で Babel プラグインを `"__$BABEL_PLUGINS"` というプレースホルダに置換し、後から `String.replace` で実際のコードに差し替えている。JSON シリアライズできない値（関数参照）を扱うための苦肉の策だが、壊れやすい。
  ```typescript
  // src/builders/rollup/stub.ts:23-65
  ).replace(
    '"__$BABEL_PLUGINS"',
    Array.isArray(babelPlugins)
      ? "[" + babelPlugins.map(/* ... */).join(",") + "]"
      : "[]",
  );
  ```

## 導出ルール

- `[MUST]` コード変換プラグインは冪等性を保証する — 同じ変換が二重に適用されないよう、変換済みかどうかの検出ロジックを含める
  - 根拠: `src/builders/rollup/plugins/cjs.ts:53` で `code.includes(CJSShim)` によるガードを実装し、shim の二重挿入を防止している

- `[MUST]` DTS 生成時は型バンドルプラグインと CJS プラグインの競合を考慮し、DTS パイプラインからは CJS 関連プラグインを除外する
  - 根拠: `src/builders/rollup/build.ts:88-93` で `rollup-plugin-dts` と `@rollup/plugin-commonjs` の競合を回避するため、プラグイン配列から `commonjs` を名前ベースでフィルタしている

- `[SHOULD]` 複数の出力フォーマット（ESM/CJS/DTS）は、単一のビルドパスから `write()` のオプションを変えて生成する — ビルドパイプラインの重複を避け、出力間の一貫性を保証する
  - 根拠: `src/builders/rollup/build.ts:97-126` で Rollup の `typesBuild` を3回 `write()` して `.d.cts` / `.d.mts` / `.d.ts` を生成している

- `[SHOULD]` プラグイン/ミドルウェアの有効化・無効化は `options | false` パターンで設計し、`false` を渡すだけで機能を無効化できるようにする
  - 根拠: `src/builders/rollup/types.ts:60-106` で全プラグインオプションが `PluginOptions | false` 型を採用し、`config.ts:114-166` で `option && plugin(option)` + `.filter(Boolean)` で条件付き合成している

- `[SHOULD]` 正規表現で十分な変換（shim 挿入、シバン除去など）には AST パーサではなく MagicString を使い、sourcemap を保持する
  - 根拠: `src/builders/rollup/plugins/cjs.ts:57-65` で `MagicString.appendRight` + `generateMap()` を使い、フルパースなしで sourcemap 付きの変換を実現している

- `[AVOID]` コード生成で JSON.stringify できない値（関数参照、クラスインスタンス）をプレースホルダ文字列の置換で埋め込む — デバッグが困難で、プレースホルダが実際のコード内に偶然存在した場合に破綻する
  - 根拠: `src/builders/rollup/stub.ts:34,40-64` で `"__$BABEL_PLUGINS"` を文字列置換しており、Babel プラグイン構成が複雑になると壊れるリスクがある

## 適用チェックリスト

- [ ] ライブラリのビルドで ESM/CJS/DTS を同時出力している場合、1回のビルドから複数 `write()` で出力を分けているか（ビルドパイプラインが重複していないか）
- [ ] コード変換プラグインに冪等性チェック（変換済みコードの検出）が含まれているか
- [ ] Rollup プラグインの有効・無効を `false` で制御できる `option | false` パターンを採用しているか
- [ ] DTS 生成パイプラインで CJS 関連プラグイン（commonjs など）が除外されているか
- [ ] MagicString を使ったコード変換で `generateMap()` により sourcemap を正しく生成しているか
- [ ] スタブ/モック生成で文字列の結合によるコード生成を行っている場合、`JSON.stringify` で値のエスケープを確実に行っているか
- [ ] TypeScript の `declaration` オプションに `"compatible"` / `"node16"` のような段階的選択肢を提供し、後方互換性の制御をユーザーに委ねているか
