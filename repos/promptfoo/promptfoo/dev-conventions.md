# dev-conventions

> リポジトリ: promptfoo/promptfoo
> 分析日: 2026-02-21

## 概要

promptfoo は 2,300+ ファイル規模の TypeScript モノレポであり、CLI・Web UI・ドキュメントサイトの 3 ワークスペースを抱える。この規模で一貫性を保つために、Conventional Commits によるコミット/PR タイトル規約、Biome + Prettier の二段構えフォーマッター、`fetchWithProxy` による fetch 一元化、Husky による pre-commit フック、そしてドメイン横断スコープルール（THE REDTEAM RULE）など、多層的な規約体系を構築している。これらの規約は `AGENTS.md` と `docs/agents/` に AI エージェント向けドキュメントとして体系化されており、人間とAI双方が同じルールで開発できる仕組みが注目に値する。

## 背景にある原則

- **単一チャネル原則**: ネットワークリクエスト（`fetchWithProxy`）、コミットメッセージ（Conventional Commits）、フォーマット（Biome + Prettier）など、すべての横断的関心事を単一のエントリポイントに集約する。これにより、プロキシ対応・ログ取得・TLS 設定などの横断的機能を一箇所で制御できる（`src/util/fetch/index.ts`、`biome.jsonc`）
- **リンターによる規約強制**: コードレビューや口頭の合意ではなく、Biome のルールで規約を機械的に強制する。`noRestrictedGlobals` で `fetch` を禁止し `fetchWithProxy` を強制、`noRestrictedImports` で `node-fetch`/`undici`/`cross-fetch` の直接利用を禁止、`noEnum` で TypeScript enum を禁止する。違反はビルドエラーになるため、規約の形骸化を防ぐ（`biome.jsonc:131-152`）
- **段階的厳格性**: コアコード（`src/`）に最も厳しいルールを適用し、テスト・フロントエンド・サンプルコードは段階的に緩和する。`noExplicitAny` はコアで error だがテスト/フロントエンド/examples では off、`noFloatingPromises` はコアで error だがテスト/フロントエンド/examples では off、`noRestrictedGlobals` はフロントエンド・テスト・examples では off にするなど、文脈に応じた調整を行う（`biome.jsonc:222-345`）
- **変更差分スコープの最小化**: `npm run l` と `npm run f` は `origin/main` との差分ファイルのみを対象とする。pre-commit フックも staged ファイルのみを処理する。大規模コードベースで全ファイル検査を避けることで、開発者体験を損なわずにリンティングを維持する（`package.json:54,60`、`.husky/pre-commit`）

## 実例と分析

### Conventional Commits とスコープ体系

PR タイトルが squash-merge 時のコミットメッセージとなり、そのままリリースノートに反映される仕組みを採用している。`feat` と `fix` のみがリリースノートに表示され、`chore`/`docs`/`test`/`refactor`/`ci`/`perf` はユーザー非公開となる。

スコープは 5 階層の優先順位で決定される:

1. **Feature Domains（最優先）**: `redteam`, `providers`, `assertions`, `eval`, `api`, `db`
2. **Product Areas**: `webui`, `cli`, `server`
3. **Technical/Infrastructure**: `deps`, `ci`, `tests`, `build`, `examples`
4. **Specialized**: `auth`, `cache`, `config`, `python`, `mcp`, `code-scan`
5. **No Scope**: 汎用的な変更

特に「THE REDTEAM RULE」は、redteam 関連の変更は **どのレイヤーに属していても** `(redteam)` スコープを使うことを義務づけている。これはドメイン横断機能の追跡を容易にするためのプラクティスである。

### Biome と Prettier の責務分割

フォーマッターを 2 つ使い分けるのではなく、ファイル種別で明確に分離している:

- **Biome**: JS / JSX / TS / TSX / JSON / JSONC / MJS / CJS（リント + フォーマット）
- **Prettier**: CSS / SCSS / HTML / MD / MDC / MDX / YAML / YML（フォーマットのみ）

`.prettierignore` でJS/TS/JSONファイルを除外し、Biome との競合を防いでいる。`npm run format` は両方を順次実行し、`npm run f` は差分ファイルのみにフィルターして両方を実行する。

### fetchWithProxy による fetch 一元化

グローバル `fetch` の使用を Biome ルールで禁止し、`fetchWithProxy` への統一を強制している。`fetchWithProxy` は以下の横断的関心事を内包する:

- プロキシ自動検出（`proxy-from-env`）とエージェントキャッシュ
- TLS 設定（カスタム CA 証明書、SSL 検証スキップ）
- コネクションプール管理（`undici.Agent`）
- バージョンヘッダー自動付与（`x-promptfoo-version`）
- URL 埋め込み認証情報の Authorization ヘッダー変換
- 502/503/504/524 の一時エラー自動リトライ（指数バックオフ）

唯一の例外は `monkeyPatchFetch.ts` 内で `// biome-ignore lint/style/noRestrictedGlobals: we need raw fetch here` により生の `fetch` を使用する箇所のみである。

### Pre-commit フックの設計

Husky v9 で `npm install` 時に自動インストールされる。フックの特徴:

- staged ファイルのみを対象とし、ファイル種別で Biome / Prettier を振り分ける
- 自動修正後にファイルを `git add` で再ステージする
- `DISABLE_PRECOMMIT_LINT=1` で無効化可能（`.env` または環境変数）
- `.env` から該当変数のみを読み取り、他のシークレットを expose しない安全設計

### noEnum による enum 禁止と代替パターン

`biome.jsonc` で `"noEnum": "error"` を設定し、TypeScript の `enum` を全面禁止している。代替として `as const` オブジェクトまたはリテラルユニオン型を使用する。

### Promise 安全性ルール

`noFloatingPromises: "error"` と `noMisusedPromises: "error"` をコアコードに適用し、await 忘れを防止している。意図的に fire-and-forget する場合は `void` プレフィックスを使用する。テスト・フロントエンド・examples では off にし、テストコードの記述負荷を下げている。

## コード例

```typescript
// src/util/fetch/index.ts:106-141
// fetchWithProxy: プロキシ・TLS・リトライを一元管理する fetch ラッパー
export async function fetchWithProxy(
  url: RequestInfo,
  options: FetchOptions = {},
  abortSignal?: AbortSignal,
): Promise<Response> {
  // ... URL パース、AbortSignal 合成 ...
  const finalOptions: FetchOptions & { dispatcher?: any } = {
    ...options,
    headers: {
      ...(options.headers as Record<string, string>),
      'x-promptfoo-version': VERSION,  // バージョンヘッダー自動付与
    },
    signal: combinedSignal,
  };
  // ...
}
```

```typescript
// src/util/fetch/monkeyPatchFetch.ts:64-66
// 唯一の例外: 生の fetch を使う箇所は biome-ignore で明示的に許可
    // biome-ignore lint/style/noRestrictedGlobals: we need raw fetch here
    const response = await fetch(url, opts);
```

```jsonc
// biome.jsonc:131-152
// Biome ルールによる fetch・node-fetch・undici の直接使用禁止
"noRestrictedGlobals": {
  "level": "error",
  "options": {
    "deniedGlobals": {
      "fetch": "Use fetchWithProxy() instead of global fetch()."
    }
  }
},
"noRestrictedImports": {
  "level": "error",
  "options": {
    "paths": {
      "node-fetch": "Use fetchWithProxy() (do not import node-fetch directly).",
      "undici": {
        "importNames": ["fetch", "default"],
        "message": "Use fetchWithProxy() instead of undici.fetch."
      },
      "cross-fetch": "Use fetchWithProxy() instead."
    },
    "patterns": [{ "group": ["whatwg-fetch", "isomorphic-fetch"] }]
  }
}
```

```bash
# .husky/pre-commit:24-45
# Staged ファイルのみを種別でフィルターし、Biome / Prettier を振り分け
STAGED_JS_TS_FILES=$(git diff --cached --name-only --diff-filter=ACMRTUXB | grep -E '\.(js|ts|tsx)$' || true)
STAGED_PRETTIER_FILES=$(git diff --cached --name-only --diff-filter=ACMRTUXB | grep -E '\.(css|scss|html|md|mdc|mdx|yaml|yml)$' || true)

if [ -n "$STAGED_JS_TS_FILES" ]; then
  echo "$STAGED_JS_TS_FILES" | xargs npx @biomejs/biome check --write
  # 自動修正後に再ステージ
  echo "$STAGED_JS_TS_FILES" | xargs git add
fi
```

```bash
# package.json:54,60
# npm run f / npm run l: origin/main との差分ファイルのみを対象
"f": "git diff --name-only --diff-filter=ACMRTUXB origin/main | grep -E '\\.(js|jsx|mjs|cjs|ts|tsx|json)$' | xargs npx @biomejs/biome check --write && git diff --name-only --diff-filter=ACMRTUXB origin/main | grep -E '\\.(css|scss|html|md|mdc|mdx|yaml|yml)$' | xargs prettier --write",
"l": "git diff --name-only --diff-filter=ACMRTUXB origin/main | grep -E '\\.(js|ts|tsx)$' | xargs npx @biomejs/biome lint --write",
```

## パターンカタログ

- **Proxy パターン** (分類: 構造)
  - 解決する問題: ネットワークリクエストの横断的関心事（プロキシ・TLS・リトライ・ログ）を各呼び出し元に分散させずに一元管理する
  - 適用条件: 外部 API を呼び出す箇所が多数あり、プロキシ対応やリトライを統一したい場合
  - コード例: `src/util/fetch/index.ts:106-224`
  - 注意点: 唯一の生 `fetch` 使用箇所を `biome-ignore` で明示的にマークし、例外を追跡可能にする

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: リンタールールの厳格度をコンテキスト（コア/テスト/フロントエンド/examples）ごとに切り替える
  - 適用条件: モノレポで領域ごとに異なるコード品質基準を適用したい場合
  - コード例: `biome.jsonc:222-345`（overrides セクション）
  - 注意点: 緩和ルールを増やしすぎると段階的厳格性の意図が失われる

## Good Patterns

- **リンターによる規約の機械的強制**: `noRestrictedGlobals` と `noRestrictedImports` で `fetch` / `node-fetch` / `undici` の直接使用を禁止し、ルール違反をコンパイル時にブロックする。人間のレビューに頼らず、規約違反を物理的に不可能にする設計。

```jsonc
// biome.jsonc:131-136
"noRestrictedGlobals": {
  "level": "error",
  "options": {
    "deniedGlobals": {
      "fetch": "Use fetchWithProxy() instead of global fetch()."
    }
  }
}
```

- **差分スコープのリント/フォーマット**: `npm run l` と `npm run f` は `git diff --name-only --diff-filter=ACMRTUXB origin/main` で変更ファイルのみを対象とする。大規模コードベースで全ファイル検査を避け、開発者体験を維持しつつ品質を担保する。

```bash
# package.json:60
"l": "git diff --name-only --diff-filter=ACMRTUXB origin/main | grep -E '\\.(js|ts|tsx)$' | xargs npx @biomejs/biome lint --write"
```

- **ドメイン横断スコープルール（THE REDTEAM RULE）**: ドメインが複数のプロダクト領域（CLI、Web UI、サーバー、ドキュメント）にまたがる場合、プロダクト領域ではなくドメインをスコープに使うことで、関連変更の追跡と検索を容易にする。

```plaintext
# docs/agents/pr-conventions.md:107-109
# 正: fix(redteam): fix Basic strategy checkbox in setup UI
# 誤: fix(webui): fix Basic strategy checkbox in red team setup
```

- **Pre-commit フックの自動修正 + 再ステージ**: Biome/Prettier で自動修正したファイルを `git add` で再ステージすることで、開発者がフォーマット修正を手動でステージし直す手間を省く。

```bash
# .husky/pre-commit:43-44
echo "$STAGED_JS_TS_FILES" | xargs git add
```

## Anti-Patterns / 注意点

- **`fetch` の直接使用**: プロキシ非対応・リトライなし・バージョンヘッダーなしの HTTP リクエストが発生し、企業ネットワークやエアギャップ環境で動作しなくなる。

```typescript
// Bad: グローバル fetch の直接使用
const response = await fetch('https://api.example.com/data');

// Better: fetchWithProxy 経由
import { fetchWithProxy } from '../util/fetch';
const response = await fetchWithProxy('https://api.example.com/data');
```

- **TypeScript enum の使用**: ツリーシェイキングを阻害し、JavaScript にトランスパイルした際に不要なコードが残る。

```typescript
// Bad: enum の使用（Biome が error で報告）
enum Status {
  Active = 'active',
  Inactive = 'inactive',
}

// Better: as const オブジェクト + 型導出
const Status = {
  Active: 'active',
  Inactive: 'inactive',
} as const;
type Status = (typeof Status)[keyof typeof Status];
```

- **ログへの機密情報の文字列埋め込み**: `JSON.stringify` でオブジェクトを展開すると、API キーやトークンがログに漏洩する。

```typescript
// Bad: 文字列補間で機密情報が漏洩
logger.debug(`Config: ${JSON.stringify(config)}`);

// Better: オブジェクトコンテキストを渡すと自動サニタイズ
logger.debug('[Provider] Config loaded', { config });
```

- **PRスコープのプロダクト領域優先**: ドメイン横断機能を `webui` や `cli` のスコープでコミットすると、ドメイン全体の変更履歴が分散して追跡困難になる。

```plaintext
# Bad
feat(webui): add redteam config dialog

# Better
feat(redteam): add config dialog in setup UI
```

## 導出ルール

- `[MUST]` 横断的関心事（HTTP リクエスト、ログ出力、認証など）は専用のラッパー関数に集約し、リンタールール（`noRestrictedGlobals` / `noRestrictedImports`）で直接使用を禁止する
  - 根拠: promptfoo は `fetchWithProxy` への一元化を Biome ルールで強制し、40+ ファイル 103 箇所の fetch 呼び出しすべてをプロキシ・リトライ・TLS 対応にしている（`biome.jsonc:131-152`）
- `[MUST]` コミットメッセージは Conventional Commits 形式（`type(scope): description`）に従い、タイプ選択はリリースノートへの影響を考慮して行う（`feat`/`fix` のみユーザー公開）
  - 根拠: PR タイトルが squash-merge でコミットメッセージとなり、そのままリリースノート生成に使われるため、不適切なタイプ選択がユーザー向け情報品質に直結する（`docs/agents/pr-conventions.md`）
- `[MUST]` リント/フォーマットは変更差分ファイルのみを対象とするコマンドを用意し、コミット前に実行する
  - 根拠: promptfoo は `npm run l` / `npm run f` で `origin/main` との差分のみを処理し、pre-commit フックでも staged ファイルのみを対象にすることで、2,300+ ファイルの全検査を回避している（`package.json:54,60`、`.husky/pre-commit`）
- `[SHOULD]` リンタールールの厳格度はコード領域ごとに段階的に設定する（コア > テスト > フロントエンド > examples）
  - 根拠: promptfoo は Biome の overrides で `noExplicitAny` や `noFloatingPromises` をテスト/フロントエンド/examples で緩和し、品質と開発者体験のバランスを取っている（`biome.jsonc:266-345`）
- `[SHOULD]` ドメイン横断機能のコミットスコープはプロダクト領域（UI/CLI/server）ではなくドメイン名を使い、関連変更の追跡性を確保する
  - 根拠: THE REDTEAM RULE により、redteam 関連の変更はどのレイヤーに属していても `(redteam)` スコープを使うことで、ドメイン全体の変更履歴を一貫して追跡できる（`docs/agents/pr-conventions.md:107-127`）
- `[SHOULD]` フォーマッターは言語/ファイル種別で責務を分離し、互いの管轄ファイルを `.prettierignore` 等で除外して競合を防ぐ
  - 根拠: Biome（JS/TS/JSON）と Prettier（CSS/MD/YAML）の役割を明確に分離し、`.prettierignore` で JS/TS/JSON を除外して二重フォーマットを防止している（`.prettierignore:19-25`）
- `[SHOULD]` Pre-commit フックは自動修正後にファイルを再ステージし、開発者の手動操作を最小化する
  - 根拠: `.husky/pre-commit` で Biome/Prettier 修正後に `git add` を実行し、修正されたファイルが確実にコミットに含まれるようにしている（`.husky/pre-commit:43-44,59-60`）
- `[AVOID]` TypeScript の `enum` を使用する。`as const` オブジェクト + リテラルユニオン型で代替する
  - 根拠: `"noEnum": "error"` でプロジェクト全体で禁止しており、ツリーシェイキング阻害とランタイムオーバーヘッドを防いでいる（`biome.jsonc:119`）
- `[AVOID]` ログ出力で `JSON.stringify` による文字列埋め込みを行う。構造化オブジェクトをロガーに渡して自動サニタイズさせる
  - 根拠: promptfoo のロガーは第2引数のオブジェクトを自動サニタイズし、API キー・トークン・パスワードを `[REDACTED]` に置換する（`docs/agents/logging.md`）

## 適用チェックリスト

- [ ] プロジェクトの横断的関心事（fetch、ログ、認証）を専用ラッパーに集約し、リンタールールで直接使用を禁止しているか
- [ ] Conventional Commits のタイプとスコープの選択基準をドキュメント化し、リリースノートへの影響を明記しているか
- [ ] `npm run lint` / `npm run format` とは別に、差分ファイルのみを対象とする短縮コマンド（`npm run l` / `npm run f` 相当）を用意しているか
- [ ] Pre-commit フックが自動修正後のファイルを再ステージしているか
- [ ] リンタールールの厳格度がコード領域（コア/テスト/フロントエンド/examples）ごとに段階的に設定されているか
- [ ] フォーマッターの責務分割が明確で、管轄外ファイルの除外設定があるか
- [ ] ドメイン横断機能のコミットスコープルールが定義されているか
- [ ] TypeScript enum を禁止し、代替パターン（`as const` + 型導出）をチームに周知しているか
- [ ] ロガーが構造化オブジェクトを受け取り、機密フィールドを自動サニタイズする仕組みがあるか
- [ ] AI エージェント向けの規約ドキュメント（AGENTS.md 相当）が各ディレクトリに配置されているか
