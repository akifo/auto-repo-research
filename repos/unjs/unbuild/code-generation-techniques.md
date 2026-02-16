# code-generation-techniques

> リポジトリ: unjs/unbuild
> 分析日: 2026-02-16

## 概要

unbuild におけるコード生成技法を分析する。このリポジトリはビルドツール自体であり、スタブファイル生成、CJS/ESM デュアル出力、型宣言（`.d.ts` / `.d.mts` / `.d.cts`）生成、CJS 互換シム注入など、多様なコード生成パターンを単一のコードベースに凝縮している。特に「生成コードの正しさ」を担保するための設計判断（テンプレートリテラルによるコード組み立て、magic-string による位置情報保持変換、rollup プラグインパイプラインによる段階的変換）は、コード生成を行うあらゆるツールに応用できる。

## 背景にある原則

- **生成コードは最小限の責務に留める**: スタブファイルは jiti への委譲のみを行い、ビジネスロジックを一切含まない。生成コードが増えるほどデバッグ困難になるため、「生成コードはグルーコードに徹し、実ロジックは別の実行系に委譲する」という原則が一貫している（`src/builders/rollup/stub.ts` 全体）
- **出力フォーマットごとに独立したコード生成パスを持つ**: CJS と ESM のスタブ、`.d.ts` / `.d.mts` / `.d.cts` の型宣言はそれぞれ独立した生成ブロックで処理される。条件分岐で差分を吸収するのではなく、フォーマットごとに生成ロジックを分離することで、各出力の正しさを個別に検証しやすくしている（`src/builders/rollup/stub.ts:91-181`, `src/builders/rollup/build.ts:99-126`）
- **AST 変換よりテキスト変換を優先する**: magic-string による文字列操作（`src/builders/rollup/plugins/cjs.ts:52-66`）やテンプレートリテラルによるコード組み立て（`src/builders/rollup/stub.ts:99-163`）を採用し、AST パーサー/ジェネレーターの複雑さを回避している。ソースマップの生成が必要な場合のみ magic-string を使い、不要な場合は単純な文字列連結で済ませる判断がある
- **検出と生成を分離する**: `auto.ts` の `inferEntries` はパッケージ情報から何を生成すべきかを「検出」し、実際の「生成」は各ビルダーに委譲する。これにより検出ロジックを単体テスト可能にしている（`test/auto.test.ts`）

## 実例と分析

### スタブ生成: テンプレートリテラルによるコード組み立て

スタブ生成（`rollupStub`）は、開発時にビルドなしでモジュールを利用可能にするための仕組みである。生成されるコードは jiti を経由してソースファイルを直接実行するラッパーになる。

CJS スタブと ESM スタブの生成を比較すると、同じ入力から異なるモジュールシステムの出力を得るために、配列の `.join("\n")` パターンでコードを組み立てている。

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

```typescript
// src/builders/rollup/stub.ts:141-163 (ESM スタブ)
await writeFile(
  output + ".mjs",
  shebang +
    [
      `import { createJiti } from ${JSON.stringify(jitiESMPath)};`,
      ...importedBabelPlugins.map(
        (plugin, i) => `import plugin${i} from ${JSON.stringify(plugin)}`,
      ),
      "",
      `const jiti = createJiti(import.meta.url, ${serializedJitiOptions})`,
      "",
      `/** @type {import(${JSON.stringify(resolvedEntryForTypeImport)})} */`,
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

注目すべき点:
1. **`JSON.stringify` でパスを安全にエスケープ** -- ファイルパスに特殊文字が含まれる場合でも壊れない
2. **named exports の静的解析** -- `resolveModuleExportNames` でソースの export を事前解析し、ESM スタブに named export を個別に生成する
3. **JSDoc `@type` 注釈を生成** -- スタブ経由でも型情報を IDE が認識できるようにしている

### CJS 互換シムの条件付き注入

CJS 構文（`__filename`, `__dirname`, `require()`）を ESM 出力で使えるようにするシム注入は、正規表現による検出と magic-string による挿入を組み合わせている。

```typescript
// src/builders/rollup/plugins/cjs.ts:38-66
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

設計判断:
- **冪等性の保証**: `code.includes(CJSShim)` で二重注入を防止
- **必要な場合のみ注入**: `CJSyntaxRe.test(code)` で CJS 構文が存在しないコードにはシムを注入しない
- **挿入位置の正確性**: 最後の ESM import 文の直後に挿入することで、import 文の順序を壊さない
- **ソースマップの保持**: magic-string を使うことで変換後もソースマップが正確

### 型宣言の三重出力パターン

型宣言は `declaration` オプションの値に応じて最大3種類のファイルを生成する。

```typescript
// src/builders/rollup/build.ts:99-126
// d.cts (CJS 向け型宣言)
if (ctx.options.rollup.emitCJS) {
  await typesBuild.write({
    dir: resolve(ctx.options.rootDir, ctx.options.outDir),
    entryFileNames: "[name].d.cts",
    chunkFileNames: (chunk) => getChunkFilename(ctx, chunk, "d.cts"),
  });
}
// d.mts (ESM 向け型宣言)
await typesBuild.write({
  dir: resolve(ctx.options.rootDir, ctx.options.outDir),
  entryFileNames: "[name].d.mts",
  chunkFileNames: (chunk) => getChunkFilename(ctx, chunk, "d.mts"),
});
// d.ts (node10 互換 -- TypeScript < 4.7)
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
```

同一の rollup ビルド結果（`typesBuild`）に対して異なる出力設定で `.write()` を複数回呼ぶことで、1回のバンドル処理から複数の型宣言フォーマットを効率的に生成している。

### CJS default export の型修正

CJS では `export default` が `module.exports.default` になるため、型宣言側でも修正が必要になる。これを `fix-dts-default-cjs-exports` に委譲している。

```typescript
// src/builders/rollup/plugins/cjs.ts:19-36
export function fixCJSExportTypePlugin(ctx: BuildContext): Plugin {
  const regexp =
    ctx.options.declaration === "node16"
      ? /\.d\.cts$/ // d.cts only
      : /\.d\.c?ts$/; // d.ts and d.cts
  return FixDtsDefaultCjsExportsPlugin({
    warn: (msg) => ctx.warnings.add(msg),
    matcher: (info) => {
      return (
        info.type === "chunk" &&
        info.exports?.length > 0 &&
        info.exports.includes("default") &&
        regexp.test(info.fileName) &&
        info.isEntry
      );
    },
  });
}
```

`declaration` モードに応じて対象ファイルのパターンを変える点が重要である。`node16` モードでは `.d.cts` のみ、`compatible` モードでは `.d.ts` と `.d.cts` の両方を修正対象にする。

### JSON 変換のオーバーライドパターン

`@rollup/plugin-json` の出力を CJS 互換に変換するために、プラグインをラップして `transform` の結果を後処理している。

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

既存プラグインをスプレッド構文で展開し、特定のフックだけをオーバーライドする Decorator パターンの適用例である。

### エントリポイントの自動推論

`auto.ts` の `inferEntries` は `package.json` の `exports`, `main`, `module`, `bin`, `types` フィールドからビルドエントリを自動推論する。

```typescript
// src/auto.ts:99-108
const isESMPkg = pkg.type === "module";
for (const output of outputs.filter((o) => !o.type)) {
  const isJS = output.file.endsWith(".js");
  if ((isESMPkg && isJS) || output.file.endsWith(".mjs")) {
    output.type = "esm";
  } else if ((!isESMPkg && isJS) || output.file.endsWith(".cjs")) {
    output.type = "cjs";
  }
}
```

ファイル拡張子と `type` フィールドの組み合わせからモジュール形式を推論するこのロジックは、Node.js のモジュール解決規則を忠実に反映している。

## パターンカタログ

- **Decorator パターン** (構造)
  - 解決する問題: 既存の rollup プラグインの出力を変換したいが、プラグインの内部実装には手を入れたくない
  - 適用条件: サードパーティプラグインの特定フックの出力を後処理する必要がある場合
  - コード例: `src/builders/rollup/plugins/json.ts:7-26`
  - 注意点: スプレッド構文でラップするため、元プラグインが内部状態に依存する場合は `this` コンテキストの扱いに注意

- **Strategy パターン** (振る舞い)
  - 解決する問題: 複数のビルダー（rollup, mkdist, untyped, copy）を統一的なインターフェースで扱いたい
  - 適用条件: 入力に応じて異なる生成アルゴリズムを選択する場合
  - コード例: `src/build.ts:293-306` -- `buildTasks` 配列に4つのビルダーを並べ、順次またはパラレルに実行
  - 注意点: 各ビルダーは `(ctx: BuildContext) => Promise<void>` という統一シグネチャを持つ

- **Template Method パターン** (振る舞い)
  - 解決する問題: ビルドプロセスの骨格は共通だが、各フェーズでカスタマイズしたい
  - 適用条件: hookable によるフックポイントが必要な場合
  - コード例: `src/build.ts:206-311` -- `build:prepare` → `build:before` → 各ビルダー → `build:done` の固定フロー
  - 注意点: フックは async 対応で、`rollup:options`, `rollup:dts:options` など粒度の細かいフックも提供される

## Good Patterns

- **`JSON.stringify` によるコード内リテラルの安全なエスケープ**: コード生成時にファイルパスや設定値をコード文字列に埋め込む際、`JSON.stringify` を使うことで特殊文字のエスケープ漏れを防止している。テンプレートリテラルや文字列連結で直接埋め込むとパス区切り文字やクォートでコードが壊れるリスクがある

```typescript
// src/builders/rollup/stub.ts:103
`const { createJiti } = require(${JSON.stringify(jitiCJSPath)})`
// JSON.stringify がバックスラッシュ、クォート等を自動エスケープ
```

- **冪等な変換関数**: `CJSToESM` は既にシムが含まれているコードや CJS 構文を含まないコードに対して `null` を返すことで、何度実行しても結果が変わらないことを保証している

```typescript
// src/builders/rollup/plugins/cjs.ts:53-55
if (code.includes(CJSShim) || !CJSyntaxRe.test(code)) {
  return null;
}
```

- **rollup の `.write()` 再利用による効率的な多重出力**: 一度のバンドル処理結果に対して異なる `OutputOptions` で複数回 `.write()` を呼ぶことで、CJS/ESM/型宣言の各フォーマットを効率的に生成している

```typescript
// src/builders/rollup/build.ts:100-125
// 同一の typesBuild に対して 3 回 write
await typesBuild.write({ entryFileNames: "[name].d.cts" });
await typesBuild.write({ entryFileNames: "[name].d.mts" });
await typesBuild.write({ entryFileNames: "[name].d.ts" });
```

- **named exports の事前解析によるスタブの正確性担保**: ESM スタブ生成前に `resolveModuleExportNames` でソースの named exports を解析し、スタブに正確な re-export を生成している。これにより tree-shaking が効く正確なスタブが得られる

```typescript
// src/builders/rollup/stub.ts:121-129
const namedExports: string[] = await resolveModuleExportNames(
  resolvedEntry,
  { extensions: DEFAULT_EXTENSIONS },
).catch((error) => {
  warn(ctx, `Cannot analyze ${resolvedEntry} for exports:` + error);
  return [];
});
```

## Anti-Patterns / 注意点

- **JSON.stringify + replace によるシリアライズハック**: babel プラグインの配列を JSON シリアライズした後、プレースホルダー文字列を正規表現で置換して実行可能なコードに変換している。これはシリアライズ不可能な値（関数、クラスインスタンス）を含むオブジェクトをコード生成に使う際の現実的な回避策だが、プレースホルダーの衝突リスクがある

```typescript
// Bad: プレースホルダー文字列がデータに含まれると壊れる
const serialized = JSON.stringify(options).replace(
  '"__$BABEL_PLUGINS"',
  dynamicCode,
);

// Better: テンプレートエンジンや AST ビルダーを使い、
// コード生成とデータシリアライズを分離する
const code = codeTemplate({
  options: serializableOptions,
  plugins: pluginExpressions,
});
```

- **フォーマットごとの生成ブロック重複**: CJS スタブと ESM スタブは構造が類似しているが、共通化されていない。小規模なコードベースでは許容されるが、出力フォーマットが増えた場合に保守コストが増大する。ただし、各フォーマットのセマンティクスが微妙に異なる（`require` vs `import`、`module.exports` vs `export default`、`__filename` vs `import.meta.url`）ため、過度な共通化は逆にバグを生みやすいというトレードオフがある

## 導出ルール

- `[MUST]` コード生成時にユーザー入力やファイルパスを文字列リテラルに埋め込む場合は `JSON.stringify` を使う
  - 根拠: unbuild はスタブ生成の全パス埋め込みで `JSON.stringify` を使用し、特殊文字のエスケープ漏れを防止している（`src/builders/rollup/stub.ts:103,111,114` 等）

- `[MUST]` コード変換関数は冪等にする（既に変換済みのコードに対しては no-op を返す）
  - 根拠: `CJSToESM` は `code.includes(CJSShim)` で二重注入を防止しており、rollup パイプラインで複数回呼ばれても安全（`src/builders/rollup/plugins/cjs.ts:53-55`）

- `[SHOULD]` ソースマップが必要なコード変換には magic-string を使い、不要な場合は単純な文字列操作で済ませる
  - 根拠: unbuild は CJS シム注入（ソースマップ必要）には MagicString を使い、スタブ生成（ソースマップ不要）には `.join("\n")` を使い分けている

- `[SHOULD]` 複数の出力フォーマットを生成する場合、バンドル処理は1回で済ませ、出力フェーズのみフォーマットごとに分岐する
  - 根拠: 型宣言生成で `typesBuild` を1回作成し `.write()` を3回呼ぶことで、重複するバンドル処理を回避している（`src/builders/rollup/build.ts:97-126`）

- `[SHOULD]` コード生成の「何を生成すべきかの検出」と「実際の生成処理」を分離し、検出ロジックを単体テスト可能にする
  - 根拠: `inferEntries` は package.json からエントリを検出するだけで生成は行わず、13個のテストケースで検証されている（`src/auto.ts`, `test/auto.test.ts`）

- `[AVOID]` CJS/ESM デュアル出力の生成ロジックを条件分岐で1つの関数にまとめる
  - 根拠: unbuild は CJS スタブと ESM スタブを別ブロックで生成しており、各フォーマット固有のセマンティクス（`require` vs `import`、`__filename` vs `import.meta.url`）を明確に分離している（`src/builders/rollup/stub.ts:91-163`）

- `[AVOID]` サードパーティのプラグインやトランスフォーマーをフォークして修正する（代わりに Decorator パターンでラップする）
  - 根拠: `JSONPlugin` は `@rollup/plugin-json` をスプレッドでラップし、`transform` のみをオーバーライドしている。フォークよりも変更点が明確で、上流の更新に追従しやすい（`src/builders/rollup/plugins/json.ts:7-26`）

## 適用チェックリスト

- [ ] コード生成でファイルパスや設定値を文字列に埋め込む箇所で `JSON.stringify` を使っているか
- [ ] コード変換関数が冪等性を保証しているか（二重実行で壊れないか）
- [ ] ソースマップの要否に応じて変換手法（magic-string vs 文字列連結）を適切に使い分けているか
- [ ] 複数の出力フォーマット（CJS/ESM/型宣言）がある場合、バンドル処理を共有し出力フェーズのみ分岐しているか
- [ ] 「何を生成すべきか」の検出ロジックが、生成処理から分離されて単体テスト可能か
- [ ] サードパーティプラグインの修正がフォークではなくラッパー（Decorator）で実現されているか
- [ ] CJS と ESM で異なるセマンティクス（`require`/`import`、`__filename`/`import.meta.url`）が正しく反映されているか
