# Workflow: Lint-Enforced Architecture

> 出典: [repos/promptfoo/promptfoo](../repos/promptfoo/promptfoo/)、[repos/open-circle/valibot](../repos/open-circle/valibot/)
> カテゴリ: workflow

## 概要

Biome の `noRestrictedGlobals` / `noRestrictedImports` や ESLint の `no-restricted-globals` / `consistent-type-definitions` を使い、アーキテクチャ制約をリンタールールで機械的に強制するワークフロー。「fetch は直接使わない」「interface を使え」といった規約を、コードレビューや口頭の合意ではなくツールチェーンでエラーにすることで、規約の形骸化を構造的に防止する。promptfoo/promptfoo では fetch の一元化を、valibot では型定義規約と AI 向けコーディング規約を、それぞれリンターで強制している。

## 背景・文脈

大規模コードベースでは、横断的関心事（HTTP リクエスト、ログ出力、型定義スタイルなど）の規約をドキュメントやコードレビューだけで維持するのは難しい。特に以下の状況で規約が崩壊しやすい:

1. **新規メンバーの参加**: ドキュメントを読まずにコードを書き始める
2. **AI エージェントの利用**: AI が規約を知らずにグローバル `fetch` や `type` を生成する
3. **時間の経過**: 規約の存在自体が忘れられ、レビューでも見逃される
4. **例外の蓄積**: 「今回だけ」の例外が積み重なり、規約が有名無実化する

promptfoo（2,300+ ファイル規模の TypeScript モノレポ）はグローバル `fetch` の使用を Biome ルールで禁止し、プロキシ対応・リトライ・TLS 設定を内包する `fetchWithProxy()` への一元化を強制している。valibot はオブジェクト型の定義に `interface` を使うことを ESLint で強制し、AI エージェント向けのコーディング規約もリンターでバックアップしている。

## 実装パターン

### 1. グローバル API の使用禁止とラッパーへの一元化（promptfoo）

Biome の `noRestrictedGlobals` でグローバル `fetch` を禁止し、`noRestrictedImports` で `node-fetch` / `undici` / `cross-fetch` の直接インポートも禁止する。エラーメッセージに代替手段を明記することで、開発者が即座に正しい方法を知ることができる。

```jsonc
// biome.jsonc:131-152 (promptfoo/promptfoo)
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

### 2. ラッパー関数で横断的関心事を集約（promptfoo）

禁止するだけでなく、代替となるラッパー関数が横断的関心事を一箇所で処理する。`fetchWithProxy()` はプロキシ自動検出、TLS 設定、リトライ、バージョンヘッダー付与、URL 埋め込み認証情報の変換を内包する。

```typescript
// src/util/fetch/index.ts:106-224 (promptfoo/promptfoo)
export async function fetchWithProxy(
  url: RequestInfo,
  options: FetchOptions = {},
  abortSignal?: AbortSignal,
): Promise<Response> {
  // ...
  const finalOptions: FetchOptions & { dispatcher?: any } = {
    ...options,
    headers: {
      ...(options.headers as Record<string, string>),
      'x-promptfoo-version': VERSION,  // バージョンヘッダー自動付与
    },
    signal: combinedSignal,
  };

  // TLS 設定（カスタム CA 証明書、SSL 検証スキップ）
  const tlsOptions: ConnectionOptions = {
    rejectUnauthorized: !getEnvBool('PROMPTFOO_INSECURE_SSL', true),
  };

  // プロキシ自動検出
  const proxyUrl = finalUrlString ? getProxyForUrl(finalUrlString) : '';
  if (proxyUrl) {
    finalOptions.dispatcher = getOrCreateProxyAgent(proxyUrl, tlsOptions);
  }

  // 502/503/504/524 の一時エラー自動リトライ（指数バックオフ）
  const maxTransientRetries = options.disableTransientRetries ? 0 : 3;
  for (let attempt = 0; attempt <= maxTransientRetries; attempt++) {
    const response = await monkeyPatchFetch(finalUrl, finalOptions);
    if (!options.disableTransientRetries && isTransientError(response) && attempt < maxTransientRetries) {
      const backoffMs = Math.pow(2, attempt) * 1000;
      await sleep(backoffMs);
      continue;
    }
    return response;
  }
}
```

### 3. 例外の明示的マーク

唯一の生 `fetch` 使用箇所は `biome-ignore` コメントで明示的に許可し、例外を追跡可能にする。

```typescript
// src/util/fetch/monkeyPatchFetch.ts:65-66 (promptfoo/promptfoo)
    // biome-ignore lint/style/noRestrictedGlobals: we need raw fetch here
    const response = await fetch(url, opts);
```

### 4. 領域ごとの段階的厳格化（promptfoo）

コアコードに最も厳しいルールを適用し、テスト・フロントエンド・examples では段階的に緩和する。

```jsonc
// biome.jsonc:266-283 (promptfoo/promptfoo) — テストファイル向けオーバーライド
{
  "includes": ["test/**/*", "**/*.test.ts", "**/*.test.tsx"],
  "linter": {
    "rules": {
      "style": {
        "noRestrictedGlobals": "off"  // テストでは生 fetch を許可
      },
      "suspicious": {
        "noExplicitAny": "off"
      }
    }
  }
}
```

```jsonc
// biome.jsonc:319-343 (promptfoo/promptfoo) — examples/site 向けオーバーライド
{
  "includes": ["examples/**/*", "site/**/*"],
  "linter": {
    "rules": {
      "recommended": false,
      "style": {
        "noRestrictedGlobals": "off"  // サンプルコードでも緩和
      }
    }
  }
}
```

### 5. AI 向け規約とリンターの二重防御（valibot）

AGENTS.md で「なぜ」を伝え、ESLint ルールで機械的に強制する。片方だけでは不十分 -- AI 指示だけでは違反を検出できず、ESLint だけでは「なぜ」が伝わらない。

```typescript
// library/eslint.config.js:45 (fabian-hiller/valibot)
// consistent-type-definitions: 'error' — interface を強制
// コメント: "for better TS performance"
```

```markdown
<!-- AGENTS.md (fabian-hiller/valibot) -->
## Code Conventions
- Use `interface` instead of `type` for object type definitions
```

## Good Example

```jsonc
// Biome: アーキテクチャ制約をリンタールールで強制
// biome.jsonc
{
  "linter": {
    "rules": {
      "style": {
        "noRestrictedGlobals": {
          "level": "error",
          "options": {
            "deniedGlobals": {
              "fetch": "Use fetchWithProxy() instead of global fetch()."
            }
          }
        }
      }
    }
  },
  "overrides": [
    {
      "includes": ["test/**/*"],
      "linter": {
        "rules": {
          "style": {
            "noRestrictedGlobals": "off"
          }
        }
      }
    }
  ]
}
```

```typescript
// 正しい使い方: ラッパー関数を経由
import { fetchWithProxy } from '../util/fetch';

const response = await fetchWithProxy('https://api.example.com/data');
```

## Bad Example

```typescript
// Bad: グローバル fetch の直接使用
// プロキシ非対応・リトライなし・バージョンヘッダーなし
const response = await fetch('https://api.example.com/data');
```

```typescript
// Bad: node-fetch の直接インポート
// fetchWithProxy の横断的関心事をバイパスする
import fetch from 'node-fetch';
const response = await fetch('https://api.example.com/data');
```

```typescript
// Bad: biome-ignore を理由なく多用する
// 例外が増えると制約の意味がなくなる
// biome-ignore lint/style/noRestrictedGlobals: TODO fix later
const response = await fetch(url);
```

## 適用ガイド

### どのような状況で使うべきか

- **横断的関心事が存在する場合**: HTTP リクエスト、ログ出力、認証、データベースアクセスなど、複数箇所で使われる機能にプロキシ・リトライ・サニタイズなどの共通処理を適用したい場合
- **規約がコードレビューで守られていない場合**: 「fetch は直接使わない」のような規約が口頭やドキュメントに留まり、実際には守られていない場合
- **AI エージェントがコードを生成する環境**: AI はリンターのエラーメッセージから正しい代替手段を学習できるため、規約文書を読むよりも確実

### 導入手順

1. **ラッパー関数を作成する**: まず横断的関心事を集約するラッパー関数を実装する
2. **リンタールールを設定する**: `noRestrictedGlobals` / `noRestrictedImports` で直接使用を禁止する。エラーメッセージに代替手段を明記する
3. **既存コードを移行する**: リンターの出力に従って既存の直接使用をラッパー経由に置き換える
4. **段階的厳格化を設定する**: テストやサンプルコードなど、制約を緩和すべき領域を overrides で設定する
5. **例外を `biome-ignore` / `eslint-disable` でマークする**: 本当に生の API が必要な箇所は理由付きコメントで許可し、例外を追跡可能にする

### カスタマイズポイント

- **禁止対象の拡張**: `fetch` だけでなく `console.log`（ロガー経由を強制）、`process.env`（設定管理モジュール経由を強制）、`fs.readFile`（安全なファイル読み取りラッパーを強制）なども同様に制約できる
- **領域ごとの厳格度調整**: コアコード > テスト > フロントエンド > examples の順に段階的に緩和する設計が実用的。新規コードには厳格なルールを適用しつつ、レガシー領域の移行は漸進的に進める
- **ESLint でも同等の設定が可能**: Biome を使わないプロジェクトでは ESLint の `no-restricted-globals` / `no-restricted-imports` で同様の制約を実現できる

### 注意点

- **ラッパー関数の品質が前提**: リンターで強制する以上、ラッパー関数自体の信頼性が重要。テストとドキュメントを充実させる
- **例外の biome-ignore / eslint-disable は必ず理由を書く**: 理由なしの例外は規約の形骸化に直結する
- **エラーメッセージに代替手段を明記する**: `"Use fetchWithProxy() instead of global fetch()."` のように、開発者が何をすべきか即座にわかるメッセージにする

## 参考

- [repos/promptfoo/promptfoo/dev-conventions.md](../repos/promptfoo/promptfoo/dev-conventions.md) — Biome ルールによる規約強制の分析
- [repos/promptfoo/promptfoo/security-practices.md](../repos/promptfoo/promptfoo/security-practices.md) — fetch 一元化のセキュリティ観点
- [repos/promptfoo/promptfoo/build-and-tooling.md](../repos/promptfoo/promptfoo/build-and-tooling.md) — リンターによるアーキテクチャ制約の強制
- [repos/open-circle/valibot/ai-settings.md](../repos/open-circle/valibot/ai-settings.md) — ESLint ルールと AI 指示の二重防御
- [repos/open-circle/valibot/dev-conventions.md](../repos/open-circle/valibot/dev-conventions.md) — interface 強制と正規表現の三重防御
