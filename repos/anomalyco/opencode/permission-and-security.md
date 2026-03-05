# Permission and Security

> リポジトリ: anomalyco/opencode
> 分析日: 2026-03-05

## 概要

AI コーディングアシスタントにおけるツール実行の権限制御、認証情報の安全な管理、コマンド実行の承認フローを分析した。opencode はローカル実行される AI エージェントであり、サンドボックスを持たない設計を明言しつつ、UX としての権限システムを多層的に構築している。「セキュリティ境界」と「UX ガードレール」を明確に区別する姿勢が注目に値する。

## 背景にある原則

- **権限は UX であり、サンドボックスではない**: SECURITY.md で「permission system exists as a UX feature to help users stay aware of what actions the agent is taking - it is not designed to provide security isolation」と明言している。真の隔離が必要なら Docker/VM を使えという立場。セキュリティ的な過信を防ぐため、脅威モデルで「sandbox escapes」を明示的に out of scope にしている（`SECURITY.md:25-30`）。
- **最小権限をデフォルトとし、段階的に緩和する**: 権限の既定値は `"ask"`（ユーザーに問い合わせ）。エージェントごとに必要最小限の権限を設定し、`plan` エージェントは編集ツールを deny、`explore` エージェントは read 系のみ allow という構成（`agent/agent.ts:91-147`）。
- **認証情報は OS レベルのファイルパーミッションで保護する**: auth.json や MCP 認証情報を `0o600`（所有者のみ read/write）で書き込む。アプリレベルの暗号化ではなく OS のアクセス制御に委ねる設計（`auth/index.ts:63`, `mcp/auth.ts:66`）。
- **構造的にコマンドを解析してから承認を求める**: bash ツールは tree-sitter で AST レベルの解析を行い、コマンド単位で権限チェックする。文字列マッチングではなく構文解析で安全性を高めている（`tool/bash.ts:84-141`）。

## 実例と分析

### 三層の権限ルールセット

権限システムは 3 つのレイヤーで構成される。

1. **ビルトインデフォルト**: `agent.ts` で定義される基本ルール。すべてのファイル編集は ask、`.env` ファイルは特別に ask を設定
2. **ユーザー設定** (`config.permission`): `opencode.jsonc` でユーザーが上書き可能。`PermissionNext.fromConfig()` で正規化
3. **エージェント固有設定**: エージェントごとのオーバーライド。`PermissionNext.merge()` で全レイヤーを結合

ルールの評価は `findLast` で行われ、後から追加されたルールが優先される（`next.ts:239`）。これにより「デフォルト deny → 特定パターンのみ allow」という直感的なオーバーライドが可能になる。

### パターンベースの柔軟な権限マッチング

各ツールは `ctx.ask()` を通じて権限リクエストを発行する。リクエストには `permission`（権限種別）と `patterns`（対象パターン）の 2 軸がある。

```typescript
// tool/bash.ts:159-164
await ctx.ask({
  permission: "bash",
  patterns: Array.from(patterns),
  always: Array.from(always),
  metadata: {},
});
```

`Wildcard.match()` がグロブパターンで照合する。`always` フィールドは「always allow を選んだ際に記憶するパターン」を指定し、ユーザーが `once` / `always` / `reject` の三択で応答する。

### bash ツールの構文解析による権限粒度制御

bash ツールは tree-sitter で AST を解析し、各コマンドノードを抽出する（`bash.ts:93-141`）。さらに `BashArity` で「人間が理解するコマンド単位」に正規化する。たとえば `npm run dev` は arity 3 として `npm run dev *` というパターンで記憶される。

```typescript
// permission/arity.ts:2-10
export function prefix(tokens: string[]) {
  for (let len = tokens.length; len > 0; len--) {
    const prefix = tokens.slice(0, len).join(" ");
    const arity = ARITY[prefix];
    if (arity !== undefined) return tokens.slice(0, arity);
  }
  if (tokens.length === 0) return [];
  return tokens.slice(0, 1);
}
```

さらに `cd`, `rm`, `cp` 等のファイル操作コマンドについては引数のパスを `realpath` で解決し、プロジェクト外ディレクトリへのアクセスを検出して `external_directory` 権限を別途要求する（`bash.ts:116-135`）。

### 三種のエラークラスによる拒否理由の分離

権限拒否を 3 つの異なるエラークラスで表現し、後続の処理を分岐させている（`next.ts:260-280`）。

- `RejectedError`: ユーザーがメッセージなしで拒否 → 実行停止
- `CorrectedError`: ユーザーがフィードバック付きで拒否 → メッセージを含めてエージェントに返却し、修正を促す
- `DeniedError`: 設定ルールによる自動拒否 → 該当ルールを JSON で含めてエージェントに返却

### doom loop 検出

同一ツールが同一引数で 3 回連続呼び出されると `doom_loop` 権限チェックが発生する（`processor.ts:154-176`）。ユーザーに「続行するか」を確認し、無限ループを防止する。

### ファイル変更時刻の検証

`FileTime.assert()` は「最後に read した時刻」と「ファイルの mtime」を比較し、read 後に外部変更があった場合はエラーを投げる（`file/time.ts:56-70`）。Windows の NTFS タイムスタンプの揺らぎに対応して 50ms の tolerance を設けている。これにより、エージェントが古いデータに基づいてファイルを上書きする事故を防止する。

### サーバーモードの認証

サーバーモードは opt-in であり、`OPENCODE_SERVER_PASSWORD` 環境変数が設定されていれば HTTP Basic Auth を適用する（`server.ts:82-89`）。未設定時は警告を表示しつつ認証なしで動作する。CORS は localhost と `*.opencode.ai` のみ許可し、CSP ヘッダーも設定している（`server.ts:110-133, 572-574`）。

## パターンカタログ

- **Chain of Responsibility** (振る舞い)
  - 解決する問題: 複数レイヤーの権限ルールを優先度付きで評価する
  - 適用条件: ビルトインデフォルト → ユーザー設定 → エージェント設定の順で結合し、`findLast` で最後にマッチしたルールを適用
  - コード例: `permission/next.ts:236-243`
  - 注意点: `findLast` のため、ルールの追加順序がそのまま優先度になる。デバッグ時は `merge` 後の全ルールセットをログに出力する設計

- **Promise-based Gate** (振る舞い)
  - 解決する問題: ツール実行を非同期にブロックし、ユーザーの応答を待つ
  - 適用条件: 権限が `ask` と評価された場合、Promise を作成して pending に登録し、ユーザーの reply で resolve/reject する
  - コード例: `permission/next.ts:145-157`
  - 注意点: reject 時は同一セッションの全 pending を連鎖的に reject する設計（`next.ts:182-194`）

## Good Patterns

- **権限種別と対象パターンの分離**: `permission: "bash"` と `patterns: ["npm run dev"]` を分離することで、権限ルールの再利用性が高まる。「bash は全部 allow だが edit は ask」のような設定が自然に書ける。

```typescript
// config で bash を allow、edit は ask（デフォルト）にする例
// permission/next.ts:46-62 の fromConfig で変換
{ "bash": "allow", "edit": { "src/*": "allow", "*.env": "deny" } }
```

- **"always" パターンの抽象化**: ユーザーが "always allow" を選んだとき、具体的な引数ではなく `BashArity.prefix` で抽象化されたパターン（例: `npm run *`）を記憶する。これにより `npm run dev` を許可したら `npm run build` も自動的に許可される。

```typescript
// tool/bash.ts:140-141
always.add(BashArity.prefix(command).join(" ") + " *");
```

- **認証情報のファイルパーミッション保護**: `0o600` で書き込むことで、マルチユーザー環境でも他のユーザーから認証情報を読まれない。

```typescript
// auth/index.ts:63
await Filesystem.writeJson(filepath, { ...data, [normalized]: info }, 0o600);
```

## Anti-Patterns / 注意点

- **承認状態のインメモリ管理**: 現在の実装では「always allow」したルールはメモリにのみ保持され、再起動で消える（`next.ts:227-229` の TODO コメント参照）。永続化すると便利だが、管理 UI なしに永続化するとユーザーが意図しない許可が残り続けるリスクがある。

```typescript
// Bad: 永続化なしに "always" を記憶（再起動で消える）
// next.ts:227-229
// TODO: we don't save the permission ruleset to disk yet until there's
// UI to manage it
```

```typescript
// Better: 永続化する場合は、有効期限または管理 UI を必ずセットで実装する
await db.insert(PermissionTable).values({
  projectID: Instance.project.id,
  data: s.approved,
  expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24h TTL
});
```

- **サーバー認証の環境変数依存**: `OPENCODE_SERVER_PASSWORD` 未設定時は認証なしで動作する。ネットワーク公開時にうっかり未設定のまま起動する可能性がある。

```typescript
// Bad: パスワード未設定なら認証スキップ
const password = Flag.OPENCODE_SERVER_PASSWORD;
if (!password) return next();
```

```typescript
// Better: ネットワーク公開時はパスワード必須にする
if (!password && opts.hostname !== "127.0.0.1" && opts.hostname !== "localhost") {
  throw new Error("OPENCODE_SERVER_PASSWORD is required for non-loopback server");
}
```

## 導出ルール

- `[MUST]` ツール実行の権限チェックは、実行直前に同期的に行う（事前キャッシュした結果を信頼しない）
  - 根拠: opencode では各ツールの `execute` 内で `ctx.ask()` を呼び、Promise が resolve されるまで実行をブロックする設計。事前チェックと実行の間にルールが変わりうるため
- `[MUST]` 認証情報ファイルは OS レベルのファイルパーミッション（`0o600`）で保護する
  - 根拠: `auth/index.ts:63` と `mcp/auth.ts:66` で一貫して `0o600` を使用。アプリレベル暗号化より確実で、キー管理の複雑さを回避できる
- `[SHOULD]` AI エージェントの権限は「最小権限デフォルト + エージェント種別ごとのオーバーライド」で構成する
  - 根拠: plan エージェントは edit deny、explore エージェントは read 系のみ allow という設計で、エージェントの役割に応じた最小権限を実現している（`agent/agent.ts:91-147`）
- `[SHOULD]` bash/shell 実行では文字列マッチングではなく AST レベルの構文解析でコマンドを識別する
  - 根拠: tree-sitter で bash の AST を解析し、コマンドノード単位で権限チェックする設計（`tool/bash.ts:84-141`）。パイプやリダイレクトを含む複合コマンドでも正しく分離できる
- `[SHOULD]` 権限拒否は単一のエラーではなく、拒否理由別のエラークラスで表現し、後続処理を分岐させる
  - 根拠: `RejectedError`（停止）、`CorrectedError`（フィードバック付き再試行）、`DeniedError`（ルール表示）の 3 クラスで異なる UX を提供（`next.ts:260-280`）
- `[AVOID]` 権限システムをセキュリティ境界として宣伝すること（UX ガードレールであることを明示すべき）
  - 根拠: SECURITY.md で「permission system is not a sandbox」と明言し、脅威モデルの out of scope を明確にしている。過信による脆弱性報告の洪水を防いでいる

## 適用チェックリスト

- [ ] ツール/アクション実行前に権限チェックを挟んでいるか（実行関数の冒頭で）
- [ ] 権限のデフォルト値は「拒否」または「確認」になっているか（allow がデフォルトになっていないか）
- [ ] 認証情報ファイルを `0o600` で書き込んでいるか
- [ ] エージェント/ロールごとに最小限の権限セットを定義しているか
- [ ] shell コマンド実行時にコマンドを構文解析しているか（正規表現マッチングだけに頼っていないか）
- [ ] 権限拒否時のエラーメッセージがエージェントにとって actionable か（何が拒否されたか、どうすればよいか）
- [ ] サーバーモードの認証がネットワーク公開時に必須になっているか
- [ ] 脅威モデルと out of scope を明文化しているか（SECURITY.md 等）
