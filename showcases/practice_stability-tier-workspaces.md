# Practice: Stability Tier Workspaces

> 出典: repos/cloudflare/agents からの知見
> カテゴリ: practice

## 概要

モノレポ内のワークスペースを安定度に基づき階層分類し、changeset 要否・CI チェック範囲・依存方向をティアごとに制御するパターン。「壊れた場合にユーザーに影響するか」という基準でワークスペースをランク付けし、公開パッケージには厳格なリリース管理を、実験的コードには自由な変更を許容する。内部共有パッケージは source-level export でビルドパイプラインを不要にし、全体の管理コストを最小化する。

## 背景・文脈

cloudflare/agents は npm workspaces によるモノレポで、SDK コアパッケージ（agents, hono-agents 等）と約 30 以上の example/guide/experimental ワークスペースを単一リポジトリで管理している。Turborepo や Nx のようなタスクオーケストレーターを意図的に排除し、npm 標準の workspaces 機能のみで統括している点が特徴的である。

パッケージ数が増えると「全てに同一の品質基準を適用する」ことが現実的でなくなる。example アプリの小さな変更にも changeset を要求すれば開発速度が落ち、逆に公開パッケージの changeset を免除すればリリース品質が低下する。この問題を解決するために、ワークスペースを安定度で4階層に分類し、各ティアに異なるガバナンスルールを適用する設計が採用されている。

## 実装パターン

### 1. ワークスペースカテゴリの定義

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

6 つの workspace glob パターンが定義されているが、安定度の観点では以下の 4 階層に分類される。

| ティア | ディレクトリ    | 公開   | changeset | 安定性保証 | 目的                     |
| ------ | --------------- | ------ | --------- | ---------- | ------------------------ |
| Tier 1 | `packages/`     | npm    | 必須      | あり       | SDK コア・統合パッケージ |
| Tier 2 | `examples/`     | 非公開 | 不要      | なし       | 単一機能デモ（学習教材） |
| Tier 3 | `guides/`       | 非公開 | 不要      | なし       | パターンチュートリアル   |
| Tier 4 | `experimental/` | 非公開 | 不要      | なし       | 不安定 API の実験        |

### 2. changeset の選択的適用

```json
// .changeset/config.json:13
"ignore": ["@cloudflare/agents-*"]
```

`@cloudflare/agents-` prefix を持つ内部パッケージ（agents-ui、example アプリ等）を changeset から除外する。公開パッケージ（`agents`, `hono-agents`, `@cloudflare/ai-chat`, `@cloudflare/codemode`）への変更のみ changeset を要求し、内部/非公開パッケージの変更は自由にコミットできる。

### 3. 依存の上向き一方向性

```json
// examples/mcp/package.json:11-14
"dependencies": {
  "@cloudflare/agents-ui": "*",
  "@cloudflare/kumo": "^1.7.0",
  "agents": "*"
}
```

examples -> packages という依存方向のみ許可し、逆方向は禁止する。`"agents": "*"` は npm workspaces のローカル解決により `packages/agents` を直接参照する。共通依存（react, vite, wrangler, typescript 等 40 個以上）はルート `devDependencies` に集約し、各 example には feature 固有の依存のみ記載する。

### 4. private パッケージの source-level export

```json
// packages/agents-ui/package.json:4-9
"private": true,
"exports": {
  ".": "./src/index.tsx",
  "./hooks": "./src/hooks.tsx",
  "./theme/*": "./src/theme/*"
}
```

`private: true` で npm 非公開の内部共有パッケージは、`dist/` ではなく `./src/` を直接 export する。Vite が開発時にトランスパイルするため、ビルドステップが不要になり管理コストがゼロになる。全 example から共有 UI コンポーネント（ConnectionIndicator, ModeToggle 等）を提供する役割を担う。

### 5. CI の paths-ignore による検証範囲制御

```yaml
# .github/workflows/pullrequest.yml:5-8
on:
  pull_request:
    paths-ignore:
      - "docs/**"
      - "design/**"
```

ドキュメントや設計記録の変更では CI を実行しない。ティアの分類が CI ワークフローにも反映されている。

### 6. ビルド順序の明示的制御

```json
// package.json:16
"build": "npm run build -w agents -w hono-agents -w @cloudflare/ai-chat -w @cloudflare/codemode"
```

Tier 1 の公開パッケージのみがビルド対象であり、`-w` フラグの列挙順でビルド順序を制御する。Tier 2-4 のワークスペースにはビルドスクリプトが存在しない（Vite の dev server がトランスパイルを担当）。

### 7. publish 前のワークスペース参照解決

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

npm workspaces は `workspace:*` プロトコルを持たないため（pnpm/Yarn の機能）、publish 直前にワークスペース参照（`*`）を実バージョン（`^x.y.z`）に書き換えるスクリプトを実行する。

### 8. experimental の二重配置

「experimental」が 2 つのスコープで使い分けられている。

```
experimental/          # Tier 4: 独立アプリ（不安定 Cloudflare API の実験）
packages/agents/src/experimental/  # Tier 1 内の実験的 subpath
```

```json
// packages/agents/package.json:146-149
"./experimental/forever": {
  "types": "./dist/experimental/forever.d.ts",
  "import": "./dist/experimental/forever.js"
}
```

前者は「外部の実験」（changeset 不要）、後者は「SDK に統合予定だがまだ安定していない機能」（changeset 必須だが subpath で隔離）という区分。

## Good Example

安定度ティアに連動した設定ファイル群の一貫構成。

```jsonc
// package.json — ワークスペース定義
{
  "workspaces": [
    "packages/*",      // Tier 1: 公開パッケージ
    "examples/*",      // Tier 2: デモアプリ
    "guides/*",        // Tier 3: チュートリアル
    "experimental/*"   // Tier 4: 実験
  ]
}

// .changeset/config.json — Tier 1 のみ changeset を要求
{
  "ignore": ["@myorg/internal-*", "@myorg/example-*"]
}

// packages/shared-ui/package.json — 内部共有は source-level export
{
  "private": true,
  "exports": {
    ".": "./src/index.tsx",
    "./hooks": "./src/hooks.tsx"
  }
}

// examples/demo/package.json — 最小限の依存宣言
{
  "private": true,
  "dependencies": {
    "my-sdk": "*",
    "@myorg/shared-ui": "*"
  }
}
```

ティアの分類がディレクトリ構造・changeset 設定・パッケージ公開範囲・CI paths-ignore に一貫して反映されており、新しいコードをどこに置くべきか直感的に判断できる。

## Bad Example

```jsonc
// Bad: 全ワークスペースに同一の品質基準を適用
{
  "workspaces": ["packages/*"]
  // 公開 SDK も example も experimental も全て packages/ に配置
}

// .changeset/config.json
{
  // ignore 設定なし — example の変更にも changeset を要求してしまう
}
```

```jsonc
// Bad: 内部共有パッケージにもフルビルドパイプラインを設ける
// packages/shared-ui/package.json
{
  "private": true,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
    },
  },
  "scripts": {
    "build": "tsup src/index.tsx --format esm --dts",
    // npm 公開しないのにビルド成果物を管理する無駄なコスト
    // ビルド順序の依存グラフも複雑になる
  },
}
```

```jsonc
// Bad: 依存方向を制御しない
// packages/sdk-core/package.json
{
  "dependencies": {
    "@myorg/example-app": "*",
    // Tier 1 が Tier 2 に依存 — 安定度の逆転
    // example の破壊的変更が公開 SDK に波及する
  },
}
```

## 適用ガイド

### どのような状況で使うべきか

- npm 公開パッケージと非公開のアプリケーション/example が同一モノレポに共存する場合
- changeset や CI の適用範囲を「全か無か」ではなく段階的に制御したい場合
- 実験的なコードを正式パッケージと明確に分離したい場合
- 内部共有 UI コンポーネントのビルドコストを排除したい場合

### 導入時の注意点

- **ティアの境界を文書化する**: どのディレクトリがどのティアに属するかを AGENTS.md や CONTRIBUTING.md に明記する。cloudflare/agents では AGENTS.md の145行目に「examples/guides/experimental は changeset 不要」と明言されている
- **changeset の ignore パターン**: glob パターン（`@myorg/internal-*`）で一括除外するのが管理しやすい。個別パッケージ名の列挙は追加漏れのリスクがある
- **source-level export の前提条件**: Vite, esbuild, webpack 5 など、TypeScript/JSX をトランスパイルできるバンドラーが消費側で使われていることが前提。Node.js から直接 require する場合は使えない
- **依存方向の検証**: sherif などのツールで定期的に依存方向を検証するか、ESLint の import ルールで上位ティアから下位ティアへの import を禁止する
- **experimental の昇格パス**: Tier 4 のコードが安定したら Tier 1 に昇格する手順を決めておく。cloudflare/agents では `experimental/` の独立アプリと `packages/*/src/experimental/` の subpath export という二段階の昇格パスを設けている

### カスタマイズポイント

- **pnpm/Yarn 環境**: `workspace:*` プロトコルがネイティブサポートされるため、publish 前のバージョン解決スクリプトが不要になる。pnpm の場合は `pnpm-workspace.yaml` でカテゴリを定義する
- **Turborepo 併用**: パッケージ数が 10 を超えたら、ビルド順序の `-w` 列挙を Turborepo の `dependsOn` に置き換えることを検討する。ティア分類と Turborepo の `filter` は組み合わせ可能
- **CI の分岐条件**: paths-ignore だけでなく、`dorny/paths-filter` アクションを使えばティアごとに異なるジョブを実行できる（Tier 1 変更時のみ publish ジョブを起動する等）
- **ティア数の調整**: 4 階層が多すぎる場合は `packages/`（公開）と `apps/`（非公開）の 2 階層から始めても十分効果がある。プロジェクトの成長に応じてティアを細分化する

## 参考

- [repos/cloudflare/agents/project-structure.md](../repos/cloudflare/agents/project-structure.md) -- ワークスペース構成と安定度分類の詳細分析
