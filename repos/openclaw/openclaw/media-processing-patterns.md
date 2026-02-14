# media-processing-patterns

> リポジトリ: openclaw/openclaw
> 分析日: 2026-02-14

## 概要

画像・音声・動画・PDF・TTS（テキスト読み上げ）を含むメディア処理パイプラインの設計パターンを分析する。このリポジトリでは、多様なメディア形式を統一的に扱うために「検出→解決→処理→出力」のパイプラインを構築し、各ステージで Strategy パターンとフォールバックチェーンを組み合わせている。193k star 規模のプロジェクトが、ネイティブ依存・外部 API・CLI ツールという3種の処理バックエンドを透過的に切り替える仕組みは、メディア処理に限らず「外部リソースへの依存を抽象化する設計」として参考になる。

## 背景にある原則

- **MIME 検出の多段フォールバック**: ファイルの正確な種別判定はパイプラインの入口として最も重要であり、単一のソースに依存してはならない。バイナリスニッフィング > 拡張子マッピング > HTTP ヘッダの優先順序を定義し、汎用 MIME（`application/octet-stream`）が具体的な拡張子マッピングを上書きしないようガードしている（`src/media/mime.ts:126-128`）。
- **処理バックエンドの環境適応**: ネイティブライブラリ（sharp）がインストールできない環境でも機能を維持するため、OS 標準ツール（macOS sips）へのフォールバックを備える。環境検出は実行時に一度だけ行い、結果を関数レベルで分岐させる（`src/media/image-ops.ts:18-21`）。
- **一時ファイルのライフサイクル管理**: メディア処理では中間ファイルが必然的に発生するが、リソースリークは深刻な問題になる。一時ディレクトリの自動クリーンアップ（TTL ベース＋使用後削除）と `try/finally` パターンで確実にリソースを解放する設計を徹底している。
- **セキュリティバイデフォルト**: メディア取得の全経路に SSRF ガード、サイズ制限、パストラバーサル防御を組み込んでいる。セキュリティチェックは呼び出し側ではなくインフラ層に集約し、チェック漏れを構造的に防止している。

## 実例と分析

### 1. 多段 MIME 検出パイプライン

メディア種別の判定は、`file-type` ライブラリによるマジックバイト検出、拡張子からの逆引きマップ、HTTP Content-Type ヘッダの3段階で行う。特筆すべきは「汎用コンテナ型（ZIP など）が拡張子ベースの具体的な判定（XLSX など）を上書きしない」というガードロジックである。

```typescript
// src/media/mime.ts:126-133
if (sniffed && (!isGenericMime(sniffed) || !extMime)) {
  return sniffed;
}
if (extMime) {
  return extMime;
}
if (headerMime && !isGenericMime(headerMime)) {
  return headerMime;
}
```

### 2. 画像処理の環境適応型バックエンド切替

`image-ops.ts` は sharp（Node ネイティブアドオン）と macOS sips（システムコマンド）を透過的に切り替える。`prefersSips()` が環境変数・ランタイム（Bun）・OS を判定し、以降の全画像操作を分岐させる。EXIF オリエンテーションの正規化も両バックエンドで統一的に対応している。

```typescript
// src/media/image-ops.ts:18-21
function prefersSips(): boolean {
  return (
    process.env.OPENCLAW_IMAGE_BACKEND === "sips"
    || (process.env.OPENCLAW_IMAGE_BACKEND !== "sharp" && isBun() && process.platform === "darwin")
  );
}
```

sharp のロードは `await import("sharp")` による遅延ロードで、不要な環境ではネイティブモジュールの読み込みを回避する（`src/media/image-ops.ts:24-28`）。

### 3. メディア理解の Provider Registry パターン

`media-understanding` モジュールは、Groq・OpenAI・Google・Anthropic・Deepgram 等の外部 API プロバイダと、whisper-cli・sherpa-onnx・gemini CLI 等のローカルツールを統一インターフェース `MediaUnderstandingProvider` で抽象化する。

```typescript
// src/media-understanding/types.ts:109-115
export type MediaUnderstandingProvider = {
  id: string;
  capabilities?: MediaUnderstandingCapability[];
  transcribeAudio?: (req: AudioTranscriptionRequest) => Promise<AudioTranscriptionResult>;
  describeVideo?: (req: VideoDescriptionRequest) => Promise<VideoDescriptionResult>;
  describeImage?: (req: ImageDescriptionRequest) => Promise<ImageDescriptionResult>;
};
```

プロバイダの自動解決は「API キーが存在するか」「CLI バイナリが PATH 上にあるか」を実行時にプローブし、利用可能な最初のバックエンドを選択する（`src/media-understanding/runner.ts:431-457`）。

### 4. TTS のプロバイダチェーンとチャネル適応

TTS は OpenAI・ElevenLabs・Edge TTS の3プロバイダをチェーンし、プライマリプロバイダが失敗した場合に次のプロバイダにフォールバックする。さらにチャネル（Telegram/デフォルト/テレフォニー）ごとに出力フォーマットを適応的に切り替える。

```typescript
// src/tts/tts.ts:66-85
const TELEGRAM_OUTPUT = {
  openai: "opus" as const,
  elevenlabs: "opus_48000_64",
  extension: ".opus",
  voiceCompatible: true,
};

const DEFAULT_OUTPUT = {
  openai: "mp3" as const,
  elevenlabs: "mp3_44100_128",
  extension: ".mp3",
  voiceCompatible: false,
};
```

### 5. 一時ファイルの確実なクリーンアップ

画像処理の `withTempDir` ヘルパーは、処理関数を受け取り、成功・失敗にかかわらず一時ディレクトリを削除する。TTS では `scheduleCleanup` が `setTimeout` + `unref()` で非同期にクリーンアップを遅延実行し、プロセス終了を阻害しない。

```typescript
// src/media/image-ops.ts:127-134
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-img-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
```

### 6. MediaAttachmentCache による重複フェッチ防止

複数の capability（image / audio / video）が同じ添付ファイルを処理する際、`MediaAttachmentCache` がバッファとメタデータをキャッシュし、ネットワークフェッチやディスク I/O の重複を防ぐ（`src/media-understanding/attachments.ts:210-425`）。

### 7. ストリーミングダウンロードとサイズ制限の早期中断

`store.ts` の `downloadToFile` は、HTTP レスポンスをストリーミングしながらサイズを監視し、上限超過時に即座にリクエストを破棄する。全データを受信してから判定するのではなく、受信中に打ち切ることでリソースを節約する。

```typescript
// src/media/store.ts:153-161
res.on("data", (chunk) => {
  total += chunk.length;
  if (sniffLen < 16384) {
    sniffChunks.push(chunk);
    sniffLen += chunk.length;
  }
  if (total > MAX_BYTES) {
    req.destroy(new Error("Media exceeds 5MB limit"));
  }
});
```

## パターンカタログ

- **Strategy パターン** (分類: 振る舞い)
  - 解決する問題: 画像処理バックエンド（sharp / sips）、TTS プロバイダ（OpenAI / ElevenLabs / Edge）の切替
  - 適用条件: 同一インターフェースで複数の実装を環境や設定に応じて切り替える場面
  - コード例: `src/media/image-ops.ts:18-21`（`prefersSips` による分岐）、`src/tts/tts.ts:548-685`（プロバイダチェーン）
  - 注意点: フォールバックチェーンが長くなると、全プロバイダの失敗時にレイテンシが累積する

- **Registry パターン** (分類: 生成)
  - 解決する問題: メディア理解プロバイダの動的登録と ID ベースのルックアップ
  - 適用条件: プラグイン的にプロバイダを追加・上書きする拡張性が必要な場面
  - コード例: `src/media-understanding/providers/index.ts:29-51`
  - 注意点: overrides 時に `capabilities` が意図せず上書きされないよう、マージロジックに注意が必要

- **Chain of Responsibility パターン** (分類: 振る舞い)
  - 解決する問題: メディア理解のモデルエントリをリストで受け、最初に成功したものを採用する
  - 適用条件: 複数の処理候補が優先順位付きで存在し、最初の成功を返したい場面
  - コード例: `src/media-understanding/runner.ts:544-629`（`runAttachmentEntries`）

## Good Patterns

- **遅延ロードでオプショナル依存を管理**: `sharp`・`pdfjs-dist`・`@napi-rs/canvas` は `await import()` で遅延ロードし、Promise をキャッシュして再ロードを防ぐ。該当機能を使わないユーザーにはインストールを要求しない（`src/media/input-files.ts:12-34`）。

```typescript
// src/media/input-files.ts:12-20
let canvasModulePromise: Promise<CanvasModule> | null = null;
async function loadCanvasModule(): Promise<CanvasModule> {
  if (!canvasModulePromise) {
    canvasModulePromise = import("@napi-rs/canvas").catch((err) => {
      canvasModulePromise = null; // 失敗時はキャッシュをクリアして再試行可能に
      throw new Error(`Optional dependency @napi-rs/canvas is required...`);
    });
  }
  return canvasModulePromise;
}
```

- **カスタムエラークラスで制御フローを分離**: `MediaFetchError`（`code: "max_bytes" | "http_error" | "fetch_failed"`）と `MediaUnderstandingSkipError`（`reason: "maxBytes" | "timeout" | "unsupported" | "empty"`）を定義し、スキップ可能なエラーとクリティカルなエラーを構造的に区別する（`src/media/fetch.ts:14-22`、`src/media-understanding/errors.ts:1-15`）。

```typescript
// src/media-understanding/errors.ts:3-11
export class MediaUnderstandingSkipError extends Error {
  readonly reason: MediaUnderstandingSkipReason;
  constructor(reason: MediaUnderstandingSkipReason, message: string) {
    super(message);
    this.reason = reason;
    this.name = "MediaUnderstandingSkipError";
  }
}
```

- **PNG エンコーダのゼロ依存実装**: QR コードやプローブ画像の生成に、ネイティブライブラリなしで PNG を生成するミニマルエンコーダを自前実装している。CRC32 テーブルの事前計算＋ `deflateSync` で、外部依存を一切持たない（`src/media/png-encode.ts`）。

## Anti-Patterns / 注意点

- **サイズ検証の二重実装リスク**: `store.ts` の `downloadToFile` がストリーミング中に `MAX_BYTES` を検証し、`saveMediaSource` も別途 `stat.size > MAX_BYTES` を検証する。定数が共通であるため現時点で問題はないが、異なる上限を設定する場合にバグの温床になりうる。

```typescript
// Bad: 複数箇所でハードコードされた定数による検証
// src/media/store.ts:159
if (total > MAX_BYTES) { req.destroy(...); }
// src/media/store.ts:219
if (stat.size > MAX_BYTES) { throw new Error(...); }

// Better: 検証関数を一箇所に集約
function assertWithinSizeLimit(size: number, limit: number, context: string): void {
  if (size > limit) {
    throw new MediaSizeError(context, size, limit);
  }
}
```

- **同期ファイル I/O の混在**: TTS モジュール（`src/tts/tts.ts`）では `writeFileSync`・`readFileSync`・`existsSync` 等の同期 API を使用している。プリファレンスファイルの読み書きという用途では許容されるが、イベントループをブロックするため、高スループット環境では非同期 API に統一すべきである。

## 導出ルール

- `[MUST]` メディアダウンロードではストリーミング中にサイズ上限を検証し、超過時に即座にリクエストを破棄する（全データ受信後の検証ではリソースを浪費する）
  - 根拠: `src/media/store.ts:153-161` でチャンク受信中に `total > MAX_BYTES` で `req.destroy()` を呼び、帯域とメモリの浪費を防いでいる
- `[MUST]` 一時ファイルを使う処理は `try/finally` またはスコープ付きヘルパーで確実にクリーンアップする（`finally` 内のエラーは `.catch(() => {})` で握り潰してよい）
  - 根拠: `src/media/image-ops.ts:127-134` の `withTempDir` パターンが全画像操作で一貫して使用されている
- `[SHOULD]` ネイティブ依存のオプショナルモジュールは `await import()` で遅延ロードし、Promise をキャッシュして、失敗時にはキャッシュをクリアして再試行可能にする
  - 根拠: `src/media/input-files.ts:12-20` で `@napi-rs/canvas` を遅延ロードし、PDF 処理を使わないユーザーにインストールを要求しない設計を実現
- `[SHOULD]` MIME 検出はバイナリスニッフィング→拡張子→HTTP ヘッダの優先順で多段フォールバックし、汎用 MIME（`application/octet-stream`）が具体的な判定を上書きしないようガードする
  - 根拠: `src/media/mime.ts:115-145` で ZIP として検出された XLSX が正しく処理されるよう `isGenericMime` ガードを導入
- `[SHOULD]` 外部プロバイダ呼び出しはフォールバックチェーンで構成し、スキップ可能なエラー（サイズ超過・タイムアウト）とクリティカルなエラーをカスタムエラークラスで構造的に区別する
  - 根拠: `MediaUnderstandingSkipError` により `runner.ts:599-613` でスキップ判定を `instanceof` で安全に行い、次のプロバイダに処理を委譲
- `[AVOID]` メディアフェッチの URL を検証せずに処理する（SSRF・パストラバーサル防御はインフラ層に集約し、個別の呼び出し側に検証責任を分散させない）
  - 根拠: `src/media/fetch.ts:87-94` で `fetchWithSsrFGuard` をインフラ層として一元化し、全メディアフェッチ経路で SSRF 対策を漏れなく適用

## 適用チェックリスト

- [ ] メディアダウンロード処理でストリーミング中のサイズ検証と早期中断を実装しているか
- [ ] 一時ファイルを生成する処理に `try/finally` またはスコープ付きヘルパーを適用しているか
- [ ] ネイティブ依存のオプショナルモジュールを遅延ロードし、不要な環境でのインストール要求を避けているか
- [ ] MIME 検出で複数ソース（バイナリ / 拡張子 / ヘッダ）のフォールバックを実装し、汎用型による上書きをガードしているか
- [ ] 外部 API / CLI ツールの呼び出しにフォールバックチェーンを構成しているか
- [ ] スキップ可能なエラーとクリティカルなエラーをカスタムエラークラスで区別しているか
- [ ] メディア取得の全経路に SSRF ガード・サイズ制限・入力バリデーションを適用しているか
- [ ] 画像処理バックエンド等、環境依存の処理に実行時検出によるフォールバックを備えているか
