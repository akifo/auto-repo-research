# dependency-management

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

pnpm 10 monorepo（3,328 ソースファイル、36 以上の extension workspace）における依存関係の制約管理を分析した。overrides によるトランジティブ依存のバージョン強制、`onlyBuiltDependencies` と `.npmrc` allow-build-scripts によるネイティブビルドの二重ゲート、`minimumReleaseAge` によるサプライチェーン攻撃の時間的防御、peer dependencies + 動的 import による optional 依存の分離、そして `workspace:*` を devDependencies に限定するプラグイン配布戦略が体系的に適用されている。特に AGENTS.md でパッチ適用を「明示的承認制」とし、AI エージェントによる自動更新を制御している点が注目に値する。

## 背景にある原則

- **サプライチェーン防御は多層であるべき**: 単一の防御策（ロックファイル固定のみ等）ではなく、overrides（トランジティブ依存の強制固定）+ minimumReleaseAge（新パッケージの待機期間）+ onlyBuiltDependencies（ビルドスクリプト実行の明示許可）の三層で依存関係の安全性を担保している。根拠: `package.json:197-216`, `.npmrc:1`, CHANGELOG の "pin npm overrides to keep tar@7.5.4 for install toolchains"
- **プラグイン配布では workspace プロトコルが毒になる**: `workspace:*` は monorepo 開発では便利だが、npm publish / npm install 時に解決できず壊れる。ホストパッケージへの参照は `devDependencies`（開発時のみ）または `peerDependencies`（実行時互換性宣言）に限定し、`dependencies` には入れない。根拠: AGENTS.md L12 "Avoid `workspace:*` in `dependencies` (npm install breaks)", CHANGELOG "Feishu plugin packaging: remove `workspace:*` `openclaw` dependency"
- **依存の変更は人間の判断を経由させる**: パッチ適用・overrides 変更・vendored changes を AI エージェントが自律的に行うことを禁止し、明示的承認を必須とすることで、意図しないバージョン変更やサプライチェーンリスクの混入を防いでいる。根拠: AGENTS.md L134-136
- **optional 依存は動的 import + 遅延ロードで分離する**: ネイティブバイナリを含む重い依存（canvas, llama-cpp）を peerDependencies として宣言し、実行時に動的 import して存在しなければフォールバックする設計で、インストール障壁を下げている。根拠: `src/media/input-files.ts:11-22`, `src/memory/embeddings.ts:95-96`

## 実例と分析

### pnpm overrides によるトランジティブ依存の強制固定

overrides に登録されている 6 パッケージはいずれも直接の依存ではなく（tar を除く）、他の依存が引き込むトランジティブ依存である。特に `fast-xml-parser`, `qs`, `tough-cookie`, `form-data` はセキュリティ脆弱性で頻繁に問題になるパッケージ群であり、overrides で安全なバージョンに強制している。`tar` は直接依存としても exact バージョン（`7.5.7`）で宣言した上で overrides でも同バージョンに固定しており、「直接依存 + overrides の二重ロック」パターンが見られる。

```jsonc
// package.json:197-205
"pnpm": {
    "minimumReleaseAge": 2880,
    "overrides": {
      "fast-xml-parser": "5.3.4",
      "form-data": "2.5.4",
      "qs": "6.14.1",
      "@sinclair/typebox": "0.34.48",
      "tar": "7.5.7",
      "tough-cookie": "4.1.3"
    },
```

`@sinclair/typebox` は他とは性質が異なり、セキュリティ修正ではなくバージョン統一の目的で overrides に含まれている。root `package.json` と 4 つの extension で exact バージョン `0.34.48` を明示し、overrides でも同バージョンに固定することで、依存ツリー全体でシングルトンを保証している。

### onlyBuiltDependencies と .npmrc の二重ゲート

pnpm 10 では `onlyBuiltDependencies` で install 時にビルドスクリプト実行を許可するパッケージを明示する。このリポジトリでは `pnpm-workspace.yaml` と `package.json` の両方に同一リストを宣言し、さらに `.npmrc` の `allow-build-scripts` でも同等のリストを維持している。

```yaml
# pnpm-workspace.yaml:7-17
onlyBuiltDependencies:
  - "@lydell/node-pty"
  - "@matrix-org/matrix-sdk-crypto-nodejs"
  - "@napi-rs/canvas"
  - "@whiskeysockets/baileys"
  - authenticate-pam
  - esbuild
  - node-llama-cpp
  - protobufjs
  - sharp
```

```ini
# .npmrc:1
allow-build-scripts=@whiskeysockets/baileys,sharp,esbuild,protobufjs,fs-ext,node-pty,@lydell/node-pty,@matrix-org/matrix-sdk-crypto-nodejs
```

### minimumReleaseAge による時間的防御

```jsonc
// package.json:197
"minimumReleaseAge": 2880,
```

2880 分 = 48 時間。npm に新しくパブリッシュされたバージョンが 48 時間経過するまで pnpm install 時に選択されない。これはサプライチェーン攻撃（パッケージ乗っ取り直後の悪意あるバージョンの即時配布）に対する時間的バッファとして機能する。

### workspace:* の配置規則とプラグイン配布

全 extension の `openclaw` 参照は `devDependencies` に `workspace:*` で宣言されている。一部の extension（googlechat, memory-core）はさらに `peerDependencies` で `"openclaw": ">=2026.1.26"` を宣言し、最低互換バージョンを明示している。

```jsonc
// extensions/googlechat/package.json:10-15
"devDependencies": {
    "openclaw": "workspace:*"
},
"peerDependencies": {
    "openclaw": ">=2026.1.26"
},
```

`dependencies` には `workspace:*` を含めない。プラグインのインストールは `npm install --omit=dev --ignore-scripts`（`src/plugins/install.ts:282`）で行われるため、devDependencies は解決されず、peerDependencies はホスト側で満たされる。

### peer dependencies + 動的 import による optional 依存パターン

`@napi-rs/canvas` と `node-llama-cpp` は root の `peerDependencies` に宣言されている。コード上ではいずれも動的 `import()` で遅延ロードし、失敗時にはエラーメッセージで代替手段を案内するか、フォールバックパスに進む。

```typescript
// src/media/input-files.ts:11-22
// Lazy-load optional PDF/image deps so non-PDF paths don't require native installs.
async function loadCanvasModule(): Promise<CanvasModule> {
  if (!canvasModulePromise) {
    canvasModulePromise = import("@napi-rs/canvas").catch((err) => {
      canvasModulePromise = null;
      throw new Error(
        `Optional dependency @napi-rs/canvas is required for PDF image extraction: ${String(err)}`,
      );
    });
  }
  return canvasModulePromise;
}
```

```typescript
// src/memory/embeddings.ts:95-96
// Lazy-load node-llama-cpp to keep startup light unless local is enabled.
const { getLlama, resolveModelFile, LlamaLogLevel } = await importNodeLlamaCpp();
```

### プラグインバージョン同期スクリプト

`scripts/sync-plugin-versions.ts` が root `package.json` のバージョンを全 extension の `package.json` に同期する。リリース前チェック（`scripts/release-check.ts:33-76`）でバージョン不一致を検出し、`pnpm plugins:sync` による修正を促す。

```typescript
// scripts/sync-plugin-versions.ts:64-71
if (pkg.version === targetVersion) {
  skipped.push(pkg.name);
  continue;
}
pkg.version = targetVersion;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
updated.push(pkg.name);
```

### 「絶対に更新しない」依存の宣言

AGENTS.md で `@buape/carbon` を更新禁止としている。Carbon は Discord SDK であり、`0.14.0` で exact バージョンに固定されている。38 以上の TypeScript ファイルが依存しており、更新コストが高い。この「凍結依存」パターンは、API の安定性が見込めない pre-1.0 ライブラリで、広範囲に使われている場合に採用される。

```jsonc
// package.json:114
"@buape/carbon": "0.14.0",
```

## パターンカタログ

- **Adapter Pattern** (構造)
  - 解決する問題: ネイティブ依存の有無でアプリケーション全体の起動が妨げられる
  - 適用条件: optional なネイティブ依存がある場合
  - コード例: `src/media/input-files.ts:11-22`, `src/memory/node-llama.ts:1-3`
  - 注意点: 動的 import の Promise をモジュールレベルでキャッシュし、再試行可能にする（`canvasModulePromise = null` でリセット）

## Good Patterns

- **直接依存 + overrides の二重ロック**: `tar` のように直接依存で exact バージョンを宣言しつつ、overrides でもトランジティブ経路のバージョンを同一に固定する。ロックファイル再生成時のバージョンドリフトを二重に防止する。
  ```jsonc
  // package.json:158 (直接依存)
  "tar": "7.5.7",
  // package.json:203 (overrides)
  "tar": "7.5.7",
  ```

- __workspace:_ は devDependencies のみ_*: extension のホストパッケージ参照を `devDependencies` に限定し、公開配布時の npm install 互換性を維持する。runtime の互換性宣言が必要な場合は `peerDependencies` で別途範囲指定する。
  ```jsonc
  // extensions/googlechat/package.json
  "devDependencies": { "openclaw": "workspace:*" },
  "peerDependencies": { "openclaw": ">=2026.1.26" }
  ```

- **optional 依存の遅延ロード + 明示的エラーメッセージ**: 動的 `import()` で optional 依存をロードし、失敗時に具体的なインストール手順を含むエラーメッセージを返す。起動パスに影響を与えずに機能を拡張できる。
  ```typescript
  // src/memory/embeddings.ts:239-251
  ? "Reason: optional dependency node-llama-cpp is missing (or failed to install)."
  : `Reason: ${formatErrorMessage(err)}`,
  "Possible fixes:",
  "1) Install node-llama-cpp manually: npm i -g node-llama-cpp",
  "2) Reinstall OpenClaw (this should install node-llama-cpp): npm i -g openclaw@latest",
  "3) If you use pnpm: pnpm approve-builds (select node-llama-cpp), then pnpm rebuild ..."
  ```

- **AI エージェントへの依存変更ガードレール**: AGENTS.md で依存関係変更に関する制約を明文化し、AI が自律的にパッチ適用や overrides 変更を行わないようにする。
  ```markdown
  <!-- AGENTS.md:134-136 -->

  - Never update the Carbon dependency.
  - Any dependency with `pnpm.patchedDependencies` must use an exact version (no `^`/`~`).
  - Patching dependencies requires explicit approval; do not do this by default.
  ```

## Anti-Patterns / 注意点

- **overrides のメンテナンス負債**: overrides で固定したバージョンは自動更新ツール（Dependabot, Renovate）で検出されにくく、元のセキュリティ修正理由が忘れ去られると、古い安全なバージョンに固定したまま新たな脆弱性を抱える「セキュリティ修正の化石化」が起きる。
  ```jsonc
  // Bad: 理由のコメントがないまま overrides が放置される
  "overrides": { "qs": "6.14.1" }
  // Better: overrides の理由と対象 CVE / issue をコメントまたは別ドキュメントで管理する
  // qs: CVE-2022-24999 prototype pollution fix
  ```

- **allow-build-scripts と onlyBuiltDependencies の不整合**: `.npmrc` と `pnpm-workspace.yaml` のリストに差異がある（`.npmrc` には `fs-ext`, `node-pty` があるが `pnpm-workspace.yaml` にはない等）。二箇所管理は不整合の温床となる。
  ```ini
  # .npmrc (fs-ext, node-pty が含まれる)
  allow-build-scripts=...,fs-ext,node-pty,...
  ```
  ```yaml
  # pnpm-workspace.yaml (fs-ext, node-pty が含まれない)
  onlyBuiltDependencies:
    - "@lydell/node-pty"  # node-pty ではない
  ```

## 導出ルール

- `[MUST]` overrides で固定するトランジティブ依存には、固定理由（CVE 番号、互換性問題等）を package.json のコメントまたは専用ドキュメントに記録する
  - 根拠: openclaw ではリリースノートに "pin npm overrides to keep tar@7.5.4" と記録しているが、package.json 自体には理由がなく、6 つの overrides の固定根拠を追跡するにはリリースノートの考古学が必要になる

- `[MUST]` monorepo のプラグイン/extension パッケージでは、ホストパッケージへの `workspace:*` 参照を `devDependencies` に限定し、`dependencies` には含めない（npm install 時に解決できず壊れるため）
  - 根拠: openclaw では CHANGELOG に "Feishu plugin packaging: remove `workspace:*` `openclaw` dependency from `extensions/feishu`" として実際に壊れた事例が記録されている（`CHANGELOG.md:189`）

- `[SHOULD]` ネイティブバイナリを含む optional 依存は `peerDependencies` として宣言し、コード上では動的 `import()` + 遅延ロードで参照する。失敗時には具体的なインストール手順を含むエラーメッセージを返す
  - 根拠: `src/media/input-files.ts:11-22` で `@napi-rs/canvas` を、`src/memory/embeddings.ts:95-96` で `node-llama-cpp` を遅延ロードし、これらが存在しなくてもアプリケーションの起動を妨げない設計としている

- `[SHOULD]` pnpm の `minimumReleaseAge` を設定し、新パッケージバージョンの即時採用を避ける（48 時間以上を推奨）
  - 根拠: `package.json:197` で 2880 分（48 時間）に設定されており、パッケージ乗っ取り攻撃の発覚猶予期間を確保している

- `[SHOULD]` ビルドスクリプト実行を許可するパッケージは `onlyBuiltDependencies`（pnpm-workspace.yaml）で明示的にホワイトリスト管理する
  - 根拠: `pnpm-workspace.yaml:7-17` で 9 パッケージのみビルドスクリプト実行を許可し、任意パッケージのポストインストールスクリプト実行によるサプライチェーン攻撃を防止している

- `[SHOULD]` monorepo 内で複数パッケージが同一ライブラリを使う場合、overrides でバージョンを統一してシングルトンを保証する（特にスキーマ定義ライブラリ、バリデーション系など実行時にインスタンス比較が行われる依存）
  - 根拠: `@sinclair/typebox` を root と 4 extension で exact バージョン `0.34.48` に統一し、さらに overrides でトランジティブ経路も同バージョンに固定している

- `[AVOID]` AI エージェント（Copilot, Claude Code 等）に依存関係のパッチ適用・overrides 変更を自律的に行わせること。AGENTS.md / CLAUDE.md で明示的に制約し、人間の承認を必須とする
  - 根拠: AGENTS.md L136 "Patching dependencies (pnpm patches, overrides, or vendored changes) requires explicit approval" として明文化されている

## 適用チェックリスト

- [ ] `pnpm.overrides` に登録されている各パッケージの固定理由（CVE、互換性問題）を文書化しているか
- [ ] `pnpm.minimumReleaseAge` を設定し、新バージョンの即時採用に時間的バッファを持たせているか
- [ ] `onlyBuiltDependencies` / `.npmrc` allow-build-scripts でビルドスクリプト実行を明示ホワイトリスト化しているか
- [ ] monorepo のプラグイン/extension で `workspace:*` が `dependencies` に含まれていないか（`devDependencies` のみか）
- [ ] ネイティブ optional 依存を `peerDependencies` + 動的 import で分離し、未インストール時のエラーメッセージに修正手順を含めているか
- [ ] 複数パッケージが使う共通依存のバージョンを overrides で統一し、シングルトン保証しているか
- [ ] 凍結依存（更新禁止の依存）がある場合、AGENTS.md / CLAUDE.md で明示的に宣言しているか
- [ ] プラグインのバージョン同期スクリプトとリリース前チェックが自動化されているか
