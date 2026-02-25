# プロジェクト構造

> リポジトリ: cloudflare/agents
> 分析日: 2026-02-25

## 概要

npm workspaces によるモノレポ構成で、公開パッケージ・examples・guides・experimental・site・openai-sdk の6カテゴリを単一ワークスペースで管理する。Turborepo 等のオーケストレーションツールを使わず、npm の標準 workspaces 機能のみで約40のワークスペースを統括している点が特徴的。各カテゴリには明確な責務と安定度の分類があり、AGENTS.md のネスト構造でコンテキスト局所化を実現している。

## 背景にある原則

- **安定度による階層分類**: ワークスペースを「公開パッケージ（packages/）」「学習教材（examples/）」「パターンチュートリアル（guides/）」「実験的（experimental/）」の4階層に分けることで、変更のコストと影響範囲を明示する。changeset が必要なのは packages/ のみであり、examples/guides/experimental は changeset 不要と明言されている（`AGENTS.md:145`）。この分類は「壊れた場合にユーザーに影響するか」という基準で引かれている。

- **依存の上向き一方向性**: examples → packages という依存方向のみ許可し、逆方向は禁止する。ルートの `devDependencies` にフレームワーク共通依存を集約し（react, vite, wrangler, typescript 等）、各 example には feature 固有の依存のみ記載する（`examples/mcp/package.json:11-14`）。これにより依存グラフが単純なツリー構造に保たれ、circular dependency が構造的に発生しない。

- **コンテキストの局所化（AGENTS.md ネスト）**: AI エージェント向けのコンテキスト文書を6階層にネストし、各ディレクトリ固有の規約をそのスコープに閉じ込める。ルート AGENTS.md はリポ全体のオーケストレーションのみ、packages/agents/AGENTS.md はコア SDK の内部構造のみを記述する。これにより AI ツールが必要なコンテキストだけを取得でき、不要な情報でプロンプトが肥大化しない。

- **ビルドオーケストレーション不要の設計**: Turborepo/Nx のようなタスクオーケストレーターを意図的に排除し、`npm run build` で4パッケージを逐次ビルドする。依存間のビルド順序はルート `package.json` の `-w` フラグ指定順で制御する（`package.json:16`）。パッケージ数が5個程度であればオーケストレーションの複雑さが不要であるという判断。

## 実例と分析

### ワークスペースカテゴリと責務境界

6つの workspace glob パターンが `package.json:81-87` で定義されている:

```json
// package.json:81-87
"workspaces": [
  "examples/*",
  "packages/*",
  "guides/*",
  "experimental/*",
  "openai-sdk/*",
  "site/*"
]
```

各カテゴリの責務は以下のように分化している:

| カテゴリ        | 公開     | changeset | 安定性保証 | 目的                     |
| --------------- | -------- | --------- | ---------- | ------------------------ |
| `packages/`     | npm 公開 | 必須      | あり       | SDK コア・統合パッケージ |
| `examples/`     | 非公開   | 不要      | なし       | 単一機能デモ（学習教材） |
| `guides/`       | 非公開   | 不要      | なし       | パターンチュートリアル   |
| `experimental/` | 非公開   | 不要      | なし       | 不安定 API の実験        |
| `openai-sdk/`   | 非公開   | 不要      | なし       | 外部 SDK との統合例      |
| `site/`         | 非公開   | 不要      | なし       | デプロイ用 Web サイト    |

### 依存ホイスティング戦略

共通依存はルート `devDependencies` に集約し、workspace パッケージからは `*` でローカル参照する:

```json
// examples/mcp/package.json:11-14
"dependencies": {
  "@cloudflare/agents-ui": "*",
  "@cloudflare/kumo": "^1.7.0",
  "agents": "*"
}
```

`"agents": "*"` は npm workspaces のローカル解決により `packages/agents` を直接参照する。`@cloudflare/agents-ui` は `private: true` で npm 公開されないが、ワークスペース内では source-level で参照可能（`packages/agents-ui/package.json:4` で `"private": true`、exports は `./src/*.tsx` を直接指す）。

ルート `devDependencies` には react, vite, typescript, wrangler 等のフレームワーク依存が40個以上集約されており（`package.json:33-78`）、各 example の `package.json` は極限まで軽量化されている。

### changeset の選択的適用

`.changeset/config.json` で `"ignore": ["@cloudflare/agents-*"]` を設定し、`@cloudflare/agents-` prefix の内部パッケージ（agents-ui、example アプリ等）を changeset から除外している:

```json
// .changeset/config.json:13
"ignore": ["@cloudflare/agents-*"]
```

これにより、公開パッケージ（`agents`, `hono-agents`, `@cloudflare/ai-chat`, `@cloudflare/codemode`）への変更のみ changeset を要求し、内部/非公開パッケージの変更は自由にコミットできる。

### publish 前のワークスペース参照解決

`resolve-workspace-versions.ts` が publish 直前に全 package.json を走査し、ワークスペース内パッケージ参照を実バージョン（`^x.y.z`）に書き換える:

```typescript
// .github/resolve-workspace-versions.ts:60-74
for (const [dependencyName] of Object.entries(deps)) {
  if (dependencyName in packageJsons) {
    let actualVersion = packageJsons[dependencyName].packageJson.version;
    if (!actualVersion.startsWith("0.0.0-")) {
      actualVersion = `^${actualVersion}`;
    }
    deps[dependencyName] = actualVersion;
    changed = true;
  }
}
```

npm workspaces は `workspace:*` プロトコルを持たないため（pnpm/Yarn の機能）、この手動スクリプトで publish 時のバージョン解決を補完している。

### 構成の一貫性を保証するツールチェーン

3つの検証スクリプトが CI で実行される:

1. **sherif** — モノレポの依存関係の健全性チェック（バージョン不整合検出）
2. **check-exports** — `package.json` の `exports` フィールドが実際の `dist/` ファイルと一致するか検証（`scripts/check-exports.ts`）
3. **typecheck** — リポ内の全 `tsconfig.json` を並列で型チェック（`scripts/typecheck.ts`）

```typescript
// scripts/typecheck.ts:10-13
for await (const file of await fg.glob("**/tsconfig.json")) {
  if (file.includes("node_modules")) continue;
  tsconfigs.push(file);
}
```

### tsconfig の継承パターン

ルート `tsconfig.base.json` が全ワークスペースの基盤として機能し、個別 tsconfig は `"extends": "../../tsconfig.base.json"` で継承する。例外は `site/agents`（Astro 固有の `astro/tsconfigs/strict` を継承）と、テストディレクトリ（`../../../../tsconfig.base.json` のように深いパスで継承）のみ。

### private パッケージ（agents-ui）の役割

`packages/agents-ui` は `"private": true` で npm 非公開だが、全 example から共有 UI コンポーネント（`ConnectionIndicator`, `ModeToggle`, `PoweredByAgents`）を提供する:

```json
// packages/agents-ui/package.json:6-9
"exports": {
  ".": "./src/index.tsx",
  "./hooks": "./src/hooks.tsx",
  "./theme/*": "./src/theme/*"
}
```

source-level export（dist/ ではなく src/ を直接指す）により、ビルドステップなしで他のワークスペースから参照可能。Vite が開発時にトランスパイルするため、公開パッケージのようなビルドパイプラインが不要。

### experimental パスの二重存在

「experimental」は2つの場所に存在する:

1. **トップレベル `experimental/` ディレクトリ**: 独立したアプリとして存在。不安定な Cloudflare API（Facets, Worker Loaders）を使う実験
2. **パッケージ内 `src/experimental/` + subpath export**: `agents/experimental/forever` や `@cloudflare/ai-chat/experimental/forever` として公開パッケージ内に含まれる実験的機能

```json
// packages/agents/package.json:146-149
"./experimental/forever": {
  "types": "./dist/experimental/forever.d.ts",
  "import": "./dist/experimental/forever.js"
}
```

前者は「外部の実験」、後者は「SDK に統合予定だがまだ安定していない機能」という区分。

## パターンカタログ

- **Facade パターン** (構造)
  - 解決する問題: ルート `package.json` の `scripts.build` が4パッケージのビルドを一括制御し、個別ビルドの順序・存在を隠蔽する
  - 適用条件: ワークスペース数が少なく（10未満）、ビルド順序が固定的な場合
  - コード例: `package.json:16` — `"build": "npm run build -w agents -w hono-agents -w @cloudflare/ai-chat -w @cloudflare/codemode"`
  - 注意点: ワークスペース数が増えると `-w` の列挙が管理不能になる。10を超えたらオーケストレーターの検討が必要

- **Template Method パターン** (振る舞い)
  - 解決する問題: 各パッケージの `scripts/build.ts` が同一のビルド構造（tsdown + oxfmt）を踏襲しつつ、entry points のみカスタマイズ
  - 適用条件: 複数パッケージが同一ビルドツールを使い、エントリポイントのみ異なる場合
  - コード例: `packages/agents/scripts/build.ts` と `packages/ai-chat/scripts/build.ts` の構造的一致
  - 注意点: 共通部分が増えたら抽出すべきだが、2-3パッケージならコピーの方がシンプル

## Good Patterns

- **安定度ベースのディレクトリ分類**: packages/ / examples/ / experimental/ という3段階で「壊れた場合の影響度」を構造化する。changeset 要否・CI paths-ignore・AGENTS.md の記述粒度すべてがこの分類に連動しており、開発者は新しいコードをどこに置くべきか直感的に判断できる。

```
// CI で docs/ と design/ を除外
// .github/workflows/pullrequest.yml:5-8
on:
  pull_request:
    paths-ignore:
      - "docs/**"
      - "design/**"
```

- **内部共有パッケージの source-level export**: agents-ui パッケージはビルド不要で `./src/index.tsx` を直接 export する。npm 公開しないパッケージにビルドパイプラインを設けるのは無駄であり、Vite/bundler に開発時トランスパイルを委ねることで管理コストをゼロにしている。

```json
// packages/agents-ui/package.json:6-9
"exports": {
  ".": "./src/index.tsx",
  "./hooks": "./src/hooks.tsx",
  "./theme/*": "./src/theme/*"
}
```

- **AGENTS.md のスコープネスト**: 6つの AGENTS.md がディレクトリ階層に対応し、各スコープの規約を局所化する。ルートは全体構造、packages/agents/ は SDK 内部、examples/ は example 規約、docs/ はドキュメント執筆ガイド、design/ は設計記録、guides/ はガイド規約をそれぞれ担当する。

## Anti-Patterns / 注意点

- **巨大単一ファイル（God Object）**: `packages/agents/src/index.ts` が約4300行で、Agent クラスの全機能（state sync, RPC, scheduling, SQL, routing）が1ファイルに集中している。AGENTS.md で「be surgical with edits, understand the full context before changing」と明記されており、チーム自身もリスクを認識している。

```
// packages/agents/AGENTS.md:142
// `src/index.ts` is very large (~4300 lines) — be surgical with edits,
// understand the full context before changing
```

Better: 関心事ごとにファイルを分割し、Agent クラスは各モジュールの facade としてのみ機能させる。ただしこのリポでは Durable Objects の単一クラス制約があるため、分割にはミックスインやプロトタイプ拡張のような技法が必要になる。

- **ビルド順序の暗黙的制御**: `npm run build -w agents -w hono-agents -w @cloudflare/ai-chat -w @cloudflare/codemode` の列挙順が暗黙的にビルド順序を決定している。`-w` の順序変更で依存解決に失敗する可能性がある。

```json
// package.json:16
"build": "npm run build -w agents -w hono-agents -w @cloudflare/ai-chat -w @cloudflare/codemode"
```

Better: Turborepo/Nx のような依存グラフベースのタスクランナーを導入するか、最低限 `package.json` にコメントで依存順序を明記する。パッケージが5個程度の現状では許容範囲。

## 導出ルール

- `[MUST]` ワークスペースカテゴリごとに安定度と公開範囲を明文化し、changeset・CI・ドキュメントの適用範囲をカテゴリに連動させる
  - 根拠: cloudflare/agents は packages/ のみ changeset 必須、examples/guides は不要と明言し、CI の paths-ignore も docs/design を除外している（`.changeset/config.json:13`, `.github/workflows/pullrequest.yml:5-8`）

- `[MUST]` 公開パッケージの `exports` フィールドと実際のビルド成果物の整合性を CI で自動検証する
  - 根拠: `scripts/check-exports.ts` が全パッケージの exports → dist/ マッピングを検証し、不整合を CI で検出する

- `[SHOULD]` npm 公開しない内部共有パッケージは `private: true` + source-level export（`./src/` を直接指す）とし、ビルドパイプラインを省略する
  - 根拠: `agents-ui` パッケージが `"exports": { ".": "./src/index.tsx" }` で dist/ を持たず、Vite のトランスパイルに委ねている（`packages/agents-ui/package.json:6-9`）

- `[SHOULD]` モノレポ内の tsconfig は共通ベース設定を `extends` で継承し、個別設定のカスタマイズは最小限にする
  - 根拠: 40以上のワークスペースが `tsconfig.base.json` を `extends` し、strict mode・target・module 等の基盤設定を一元管理している

- `[SHOULD]` AI コーディングツール向けのコンテキスト文書（AGENTS.md, CLAUDE.md 等）をディレクトリ階層に合わせてネストし、各スコープの規約を局所化する
  - 根拠: 6つの AGENTS.md がルート・packages/agents・examples・guides・docs・design に配置され、それぞれのスコープに閉じた規約を記述している

- `[AVOID]` 5パッケージ以下のモノレポにタスクオーケストレーター（Turborepo, Nx）を導入する — ルート scripts の `-w` フラグで十分制御可能であり、ツール学習コストが見合わない
  - 根拠: cloudflare/agents は4公開パッケージを `npm run build -w` の列挙で管理し、AGENTS.md で「npm workspaces (not Turborepo)」と明記している

- `[AVOID]` 公開パッケージの `src/index.ts` を4000行超の単一ファイルにする — 編集の衝突リスクとコンテキスト理解コストが非線形に増大する
  - 根拠: `packages/agents/src/index.ts` が約4300行で、AGENTS.md 自体が「be surgical with edits」と警告を出さざるを得ない状況になっている

## 適用チェックリスト

- [ ] ワークスペースカテゴリ（packages/examples/experimental 等）ごとに安定度・公開範囲・changeset 要否を定義しているか
- [ ] 公開パッケージの `exports` フィールドとビルド成果物の整合性を CI で検証するスクリプトがあるか
- [ ] 全 tsconfig が共通ベース設定を `extends` で継承し、基盤設定（target, module, strict）が一元管理されているか
- [ ] npm 非公開の内部共有パッケージにビルドパイプラインを不要に設けていないか（source-level export で代替可能か検討）
- [ ] AI ツール向けのコンテキスト文書がディレクトリ階層に合わせて適切にスコープ分けされているか
- [ ] モノレポのパッケージ数とタスクオーケストレーターの必要性が見合っているか（5個以下なら不要な可能性）
- [ ] publish 前にワークスペース参照（`*` や `workspace:*`）を実バージョンに解決する仕組みがあるか
