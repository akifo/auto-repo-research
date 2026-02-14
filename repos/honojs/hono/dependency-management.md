# dependency-management

> リポジトリ: honojs/hono
> 分析日: 2026-02-14

## 概要

Hono は production dependencies をゼロに保つという徹底したポリシーを持つ Web フレームワークである。JWT、Cookie パーサー、Base64 エンコーディング、MIME タイプ判定など、通常は外部ライブラリに委ねる機能をすべて Web Standard API（特に Web Crypto API）の上に自前実装している。devDependencies は開発・ビルド・テストに必要な最小限のツールに限定し、publint によるパッケージ品質の自動バリデーション、package.json と jsr.json のエクスポート整合性チェック、pkg-pr-new による PR 時プレビュー公開という多層的な品質保証パイプラインを構築している。ゼロ依存ポリシーはマルチランタイム対応（Node.js / Deno / Bun / Cloudflare Workers / Fastly / AWS Lambda）の前提条件でもある。

## 設計思想

- **Web Standard API への全面依拠**: 外部ライブラリを使わず、`crypto.subtle`、`TextEncoder`、`btoa`/`atob`、`fetch` といった Web Standard API のみで機能を実現する。これにより Node.js 固有のモジュール（`crypto`、`buffer` 等）への依存を回避し、あらゆるランタイムで動作可能になる。根拠: JWT 実装（`src/utils/jwt/jws.ts`）が `crypto.subtle.sign`/`verify` のみを使用し、Cookie 署名（`src/utils/cookie.ts`）も `crypto.subtle.importKey` で完結している。

- **ランタイム固有コードのアダプターパターンによる隔離**: `node:*` モジュールの使用はアダプター層（`src/adapter/`）およびランタイム依存ミドルウェア内に限定し、コアからは排除する。根拠: `node:async_hooks` は `context-storage` ミドルウェア内のみ、`node:fs/promises` は `adapter/bun/serve-static.ts` 内のみで使用されている。コアの `serve-static` は `getContent` と `join` をコールバックとして受け取る設計。

- **第三者依存が必要な機能は別リポジトリへ分離**: 外部ライブラリに依存する必要があるミドルウェア（GraphQL、Firebase Auth、Sentry 等）はコアに含めず、`honojs/middleware` モノレポで `@honojs` 名前空間として配布する。根拠: `docs/CONTRIBUTING.md:37-48` に「Third-party middleware is not in the core. It is allowed to depend on other libraries」と明記。

- **デュアルレジストリ公開を前提とした構造**: npm と JSR（Deno）の両方に公開するため、`package.json` と `jsr.json` のエクスポートマップを同期し、ビルド時に自動検証する。根拠: `build/build.ts:30-31` で `validateExports()` を実行。

## 設計・実装の詳細

### ゼロ依存を支える自前実装群

Hono は以下の機能を外部ライブラリなしで実装している:

| 機能 | 一般的な外部ライブラリ | Hono の自前実装 |
|------|----------------------|----------------|
| JWT 署名/検証 | jsonwebtoken, jose | `src/utils/jwt/` (jwa, jws, jwt, types, utf8) |
| Cookie パース/署名 | cookie, cookie-signature | `src/utils/cookie.ts` |
| Base64/Base64URL エンコード | base64-js | `src/utils/encode.ts` |
| MIME タイプ判定 | mime-types | `src/utils/mime.ts` |
| ハッシュ関数 (SHA-256等) | crypto-js | `src/utils/crypto.ts` |
| パス結合 | path (Node.js) | `src/middleware/serve-static/path.ts` |

### ビルドパイプラインとパッケージ品質バリデーション

ビルドは esbuild ベースのカスタムスクリプト（`build/build.ts`）で ESM と CJS の双方を生成し、`tsc` で型定義ファイルを出力する。ビルド後に以下の自動チェックが走る:

1. **publint（postbuild）**: パッケージのエクスポートマップ、型定義の整合性、CJS/ESM デュアルフォーマットの正当性を検証
2. **validateExports**: `package.json` と `jsr.json` のエクスポートキーが相互に対応しているかを検証
3. **removePrivateFields**: `oxc-parser` で `.d.ts` ファイルを AST 解析し、`#private` フィールドを除去（TypeScript の private fields が型定義に漏洩するのを防止）

### devDependencies の分類と役割

```
# ビルドツール
esbuild          — ESM/CJS バンドル生成
typescript       — 型チェック＆型定義出力
oxc-parser       — .d.ts からの #private フィールド除去
glob             — ビルドスクリプト内のファイル列挙

# テストツール
vitest           — テストランナー
@vitest/coverage-v8 — カバレッジ
msw              — HTTP モックサーバー（クライアントテスト用）
jsdom            — DOM テスト環境
undici           — HTTP クライアントテスト

# リント・フォーマット
eslint + @hono/eslint-config
prettier
editorconfig-checker

# パッケージ品質
publint          — パッケージバリデーション
pkg-pr-new       — PR ごとの npm プレビュー公開

# リリース
np               — npm リリース管理

# ランタイムテスト
wrangler         — Cloudflare Workers テスト
bun-types        — Bun 型定義
zod              — バリデーションテスト用
```

### CJS/ESM デュアルパッケージ戦略

`package.json` の `exports` フィールドで条件付きエクスポートを定義し、各サブパスに `types`、`import`（ESM）、`require`（CJS）の3つのエントリを設定している。CJS 側には `dist/cjs/package.json`（`{"type": "commonjs"}`）を配置して Node.js のモジュール解決を正しく機能させる。

### アダプターパターンによるランタイム分離

コアの `serveStatic` ミドルウェア（`src/middleware/serve-static/index.ts`）はファイルシステムアクセスを `getContent` コールバックとして受け取る設計にし、ランタイム固有の実装（Bun の `Bun.file()` や Deno のファイル API）をアダプター層に押し出している。`defaultJoin`（`src/middleware/serve-static/path.ts`）は `node:path` に依存しない独自のパス結合実装で、アダプターがランタイム固有の `join` を注入可能。

### CI マトリクスによるマルチランタイム検証

CI（`.github/workflows/ci.yml`）では Node.js（18, 20, 22）、Bun、Bun on Windows、Deno、Cloudflare Workers (workerd)、Fastly、AWS Lambda、Lambda@Edge の 8+ 環境でテストを実行。さらに `jsr-dry-run` ジョブで JSR 公開の妥当性も検証している。

## コード例

### Web Crypto API による JWT 署名（外部ライブラリ不要）

```typescript
// src/utils/jwt/jws.ts:29-37
export async function signing(
  privateKey: SignatureKey,
  alg: SignatureAlgorithm,
  data: BufferSource
): Promise<ArrayBuffer> {
  const algorithm = getKeyAlgorithm(alg)
  const cryptoKey = await importPrivateKey(privateKey, algorithm)
  return await crypto.subtle.sign(algorithm, cryptoKey, data)
}
```

### package.json / jsr.json エクスポート整合性チェック

```typescript
// build/build.ts:28-31
const [packageJsonExports, jsrJsonExports] = ['./package.json', './jsr.json'].map(readJsonExports)

// Validate exports of package.json and jsr.json
validateExports(packageJsonExports, jsrJsonExports, 'jsr.json')
validateExports(jsrJsonExports, packageJsonExports, 'package.json')
```

### アダプターパターンによるランタイム依存の隔離

```typescript
// src/middleware/serve-static/index.ts:34-47 (コア: ランタイム非依存)
export const serveStatic = <E extends Env = Env>(
  options: ServeStaticOptions<E> & {
    getContent: (path: string, c: Context<E>) => Promise<Data | Response | null>
    join?: (...paths: string[]) => string
    isDir?: (path: string) => boolean | undefined | Promise<boolean | undefined>
  }
): MiddlewareHandler => {
  const root = options.root ?? './'
  const join = options.join ?? defaultJoin
  // ...
}
```

```typescript
// src/adapter/bun/serve-static.ts:8-32 (Bun アダプター: ランタイム固有コードを注入)
export const serveStatic = <E extends Env = Env>(
  options: ServeStaticOptions<E>
): MiddlewareHandler => {
  return async function serveStatic(c, next) {
    const getContent = async (path: string) => {
      const file = Bun.file(path)
      return (await file.exists()) ? file : null
    }
    return baseServeStatic({ ...options, getContent, join, isDir })(c, next)
  }
}
```

### ランタイム非依存なパス結合の自前実装

```typescript
// src/middleware/serve-static/path.ts:5-25
/**
 * `defaultJoin` does not support Windows paths and always uses `/` separators.
 * If you need Windows path support, please use `join` exported from `node:path` etc. instead.
 */
export const defaultJoin = (...paths: string[]): string => {
  let result = paths.filter((p) => p !== '').join('/')
  result = result.replace(/(?<=\/)\/+/g, '')
  const segments = result.split('/')
  const resolved = []
  for (const segment of segments) {
    if (segment === '..' && resolved.length > 0 && resolved.at(-1) !== '..') {
      resolved.pop()
    } else if (segment !== '.') {
      resolved.push(segment)
    }
  }
  return resolved.join('/') || '.'
}
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: ランタイムごとに異なるファイルシステムアクセスをコアから分離する
  - 適用条件: 同一インターフェースに対し、ランタイムごとに異なる実装が必要な場合
  - コード例: `src/middleware/serve-static/index.ts:36-37`（`getContent` と `join` をコールバックとして受け取る）
  - 注意点: コールバック数が増えると、アダプター側の実装負荷が増大する

- **Adapter パターン** (分類: 構造)
  - 解決する問題: ランタイム固有 API（`Bun.file()`, `Deno.readFile()` 等）をコアのインターフェースに適合させる
  - 適用条件: マルチランタイム対応が必要で、ランタイム固有の API を使わざるを得ない場合
  - コード例: `src/adapter/bun/serve-static.ts` が `baseServeStatic` に Bun 固有の実装を注入
  - 注意点: アダプターごとにテストが必要（CI で 8+ ランタイムを検証）

## Good Patterns

- **postbuild フックでの publint 自動実行**: `"postbuild": "publint"` により、ビルドするたびにパッケージ品質が自動検証される。エクスポートマップの不整合、CJS/ESM の互換性問題をローカル開発時に即座に検出できる。

```json
// package.json:29-30
"build": "bun run --shell bun remove-dist && bun ./build/build.ts && bun run copy:package.cjs.json",
"postbuild": "publint",
```

- **デュアルレジストリのエクスポート同期検証**: ビルドスクリプト内で `package.json` と `jsr.json` のエクスポートを相互検証し、片方にだけエクスポートが追加される事故を防止。カスタムスクリプトだがロジックは 37 行と簡潔。

```typescript
// build/validate-exports.ts:1-37
export const validateExports = (
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  fileName: string
) => {
  // ワイルドカードマッチングを含む双方向検証
  Object.keys(source).forEach((sourceEntry) => {
    if (!isEntryInTarget(sourceEntry)) {
      throw new Error(`Missing "${sourceEntry}" in '${fileName}'`)
    }
  })
}
```

- **pkg-pr-new による PR 時プレビュー公開**: PR に `cr-tracked` ラベルを付けると、ビルド成果物が StackBlitz にプレビュー公開される。実際のパッケージを消費者として試せるため、エクスポートマップや型定義の問題をマージ前に発見できる。

```yaml
# .github/workflows/cr.yml:38-39
- name: Publish to StackBlitz
  run: bun pkg-pr-new publish --compact
```

- **Web Standard API による機能自前実装**: JWT を `crypto.subtle` で実装し、Cookie 署名も同じく Web Crypto API で行う。これにより 182 のソースファイルすべてが外部 production 依存なしで動作する。

```typescript
// src/utils/cookie.ts:39-42
const getCryptoKey = async (secret: string | BufferSource): Promise<CryptoKey> => {
  const secretBuf = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret
  return await crypto.subtle.importKey('raw', secretBuf, algorithm, false, ['sign', 'verify'])
}
```

## Anti-Patterns / 注意点

- **自前実装のセキュリティリスク**: JWT や暗号処理の自前実装は、専門家によるレビューが不十分だとセキュリティ脆弱性を生む可能性がある。Hono は Web Crypto API の薄いラッパーに留め、暗号プリミティブ自体は実装しないことでリスクを軽減しているが、それでもアルゴリズム混同攻撃への対策（`verifyWithJwks` での対称鍵アルゴリズム拒否）など、深い知識が必要な実装が含まれる。

```typescript
// Bad: 暗号プリミティブの自前実装
function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  // 自前のHMAC実装 -- 脆弱性のリスク大
}

// Better: Web Crypto API のラッパーに留める（Hono のアプローチ）
const signature = await crypto.subtle.sign(algorithm, cryptoKey, data)
```

- **node: プレフィックス付き import の無制限使用**: `node:async_hooks` や `node:fs/promises` の import がアダプター層だけでなくミドルウェア本体（`context-storage`）にも存在する。コアミドルウェアが Node.js 固有 API に依存すると、そのミドルウェアが一部ランタイムで動作しないリスクがある。

```typescript
// Bad: コアミドルウェアでの直接的なランタイム固有 import
// src/middleware/context-storage/index.ts:6
import { AsyncLocalStorage } from 'node:async_hooks'

// Better: ランタイム検出+フォールバック、またはアダプターパターンで隔離
// (ただし AsyncLocalStorage は現在 Node.js/Bun/Deno すべてでサポートされるため、
//  Hono の判断は実用的に妥当)
```

## 導出ルール

- `[MUST]` ライブラリのコアモジュールは production dependencies ゼロを維持し、外部依存が必要な機能は別パッケージとして分離する
  - 根拠: Hono は 182 ソースファイル・多数のミドルウェアを擁しつつ production dependencies ゼロを達成しており、CONTRIBUTING.md で「Third-party middleware is not in the core」と明文化している

- `[MUST]` マルチレジストリ公開（npm + JSR 等）時は、エクスポートマップの同期をビルドスクリプト内で自動検証する
  - 根拠: `build/build.ts` で `validateExports()` を双方向に実行し、片方だけにエクスポートが追加される事故を構造的に防止している

- `[SHOULD]` ビルドの postbuild フックで publint を実行し、パッケージ品質（エクスポートマップ整合性、CJS/ESM 互換性、型定義パス）を自動検証する
  - 根拠: `"postbuild": "publint"` により、壊れたパッケージの公開を開発時点で防止している

- `[SHOULD]` 暗号処理は Web Crypto API（`crypto.subtle`）のラッパーとして実装し、暗号プリミティブの自前実装は避ける
  - 根拠: Hono の JWT 実装（`src/utils/jwt/jws.ts`）は `crypto.subtle.sign`/`verify`/`importKey` のみを使用し、HMAC や RSA の低レベル演算は一切自前実装していない

- `[SHOULD]` ランタイム固有の API 使用はアダプター層に隔離し、コアはコールバック/DI で受け取る設計にする
  - 根拠: `serveStatic` コアは `getContent`/`join`/`isDir` をコールバックで受け取り、`Bun.file()` 等のランタイム固有コードはアダプター内に封じ込めている

- `[AVOID]` devDependencies にテスト対象のバリデーションライブラリ（zod 等）を含めるだけで、production dependencies に追加してしまうこと
  - 根拠: Hono は zod を devDependencies に配置しテスト内でのみ使用。バリデーション機能自体はフレームワーク内に独自の仕組み（`src/validator/`）を持ち、特定ライブラリへの依存を避けている

## 適用チェックリスト

- [ ] `package.json` の `dependencies` フィールドを確認し、本当に production で必要な依存のみが含まれているか検証する
- [ ] `postbuild` スクリプトに `publint` を追加し、パッケージ品質を自動検証する仕組みを導入する
- [ ] CJS/ESM デュアルパッケージを提供している場合、`exports` フィールドで `types`/`import`/`require` の3条件を正しく設定しているか確認する
- [ ] 複数レジストリ（npm, JSR 等）に公開している場合、エクスポートマップの同期検証スクリプトをビルドに組み込む
- [ ] 暗号処理に外部ライブラリを使用している場合、Web Crypto API で代替可能かどうか検討する
- [ ] ランタイム固有 API の使用箇所を洗い出し、アダプターパターンでコアから分離できるか検討する
- [ ] `pkg-pr-new` や同等ツールを導入し、PR 時にパッケージのプレビュー公開ができるようにする
- [ ] 外部依存が必要な拡張機能を別パッケージ/モノレポとして分離する戦略を検討する
