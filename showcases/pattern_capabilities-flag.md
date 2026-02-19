# Pattern: Capabilities Flag

> 出典: [repos/openclaw/openclaw](../repos/openclaw/openclaw/), [repos/mastra-ai/mastra](../repos/mastra-ai/mastra/)
> カテゴリ: pattern

## 概要

boolean フラグや列挙値でオブジェクトが対応する機能を宣言するインターフェース設計パターン。継承やサブクラスで機能差を表現する代わりに、`capabilities` プロパティで機能の有無を明示し、呼び出し側がフラグを確認してから対応メソッドを呼ぶ。プラグイン・プロバイダー・アダプターなど「同一インターフェースの多バリアント」を扱う場面で、Fat Interface を避けつつ拡張性を確保できる。

## 背景・文脈

多数のバリアントを単一インターフェースで統合するシステムでは、全バリアントが全メソッドをサポートするとは限らない。たとえば openclaw は 30 以上のメッセージングチャネルと複数のメディアプロバイダーを統合し、mastra は 23 のストレージアダプター、18 のベクトル DB、13 の音声プロバイダーを統一インターフェースで扱っている。

こうした状況で全メソッドを必須にすると、新バリアント追加のたびに不要なスタブ実装を強制する「Fat Interface」問題が生じる。Capabilities Flag パターンは、メソッドをオプショナルにしつつ、フラグで「何ができるか」を宣言的に表明することで、呼び出し側がランタイムで安全に分岐できる仕組みを提供する。

## 実装パターン

### パターン 1: 列挙配列による能力宣言（openclaw）

`MediaUnderstandingProvider` は `capabilities` 配列でサポートする機能を宣言し、対応するメソッドをオプショナルにしている。

```typescript
// openclaw — src/media-understanding/types.ts:109-115
export type MediaUnderstandingProvider = {
  id: string;
  capabilities?: MediaUnderstandingCapability[]; // ["audio"], ["audio", "image"] 等
  transcribeAudio?: (req: AudioTranscriptionRequest) => Promise<AudioTranscriptionResult>;
  describeVideo?: (req: VideoDescriptionRequest) => Promise<VideoDescriptionResult>;
  describeImage?: (req: ImageDescriptionRequest) => Promise<ImageDescriptionResult>;
};
```

プロバイダーは必要な機能だけ実装し、capabilities で明示する。

```typescript
// openclaw — src/media-understanding/providers/groq/index.ts:6-14
export const groqProvider: MediaUnderstandingProvider = {
  id: "groq",
  capabilities: ["audio"], // 音声のみサポート
  transcribeAudio: (req) =>
    transcribeOpenAiCompatibleAudio({
      ...req,
      baseUrl: req.baseUrl ?? DEFAULT_GROQ_AUDIO_BASE_URL,
    }),
  // describeVideo, describeImage は未実装 → undefined
};
```

### パターン 2: boolean フラグによる機能宣言（mastra）

`MemoryStorage` は `supportsObservationalMemory` という boolean フラグで、オプショナル機能のサポート状況を宣言する。

```typescript
// mastra — packages/core/src/storage/domains/memory/base.ts:37-38
readonly supportsObservationalMemory?: boolean = false;
```

非サポート時のメソッドはデフォルトで throw し、呼び出し元がフラグで事前チェックできる。

```typescript
// mastra — packages/core/src/storage/domains/memory/base.ts:72-77
async listMessagesByResourceId(
  _args: StorageListMessagesByResourceIdInput,
): Promise<StorageListMessagesOutput> {
  throw new Error(
    `Resource-scoped message listing is not implemented by this storage adapter ` +
    `(${this.constructor.name}). Use an adapter that supports Observational Memory ` +
    `(pg, libsql, mongodb) or disable observational memory.`,
  );
}
```

### パターン 3: アダプタスロットによる多面的能力宣言（openclaw）

`ChannelPlugin` は 20 以上のオプショナルなアダプタスロットを持ち、各チャネルは必要なスロットだけ実装する。`capabilities` フィールドで対応能力の概要を宣言し、コア側はアダプタの存在チェックだけで全チャネルを統一的に扱う。

```typescript
// openclaw — src/channels/plugins/types.plugin.ts:48-84
export type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities; // 能力の宣言
  config: ChannelConfigAdapter<ResolvedAccount>; // 必須はこれだけ
  setup?: ChannelSetupAdapter; // 以下すべてオプショナル
  pairing?: ChannelPairingAdapter;
  security?: ChannelSecurityAdapter<ResolvedAccount>;
  groups?: ChannelGroupAdapter;
  outbound?: ChannelOutboundAdapter;
  status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  // ... 他のアダプタ
};
```

### パターン 4: メソッドオーバーライドによる対応演算子の宣言（mastra）

ベクトル DB のフィルタ翻訳では、各ベンダーが `getSupportedOperators()` をオーバーライドして対応演算子を宣言する。基底クラスのバリデーションがこの宣言に基づいて入力を検証する。

```typescript
// mastra — stores/pinecone/src/vector/filter.ts:35-51
export class PineconeFilterTranslator extends BaseFilterTranslator<PineconeVectorFilter> {
  protected override getSupportedOperators(): OperatorSupport {
    return {
      ...BaseFilterTranslator.DEFAULT_OPERATORS,
      logical: ["$and", "$or"], // $not/$nor は非対応
      array: ["$in", "$all", "$nin"],
      element: ["$exists"],
      regex: [], // regex は非対応
    };
  }
}
```

## Good Example

能力フラグとオプショナルメソッドの組み合わせにより、新プロバイダー追加時に既存実装への変更がゼロで済む。

```typescript
// Good: 能力を宣言し、メソッドをオプショナルにする
type ImageProcessor = {
  id: string;
  capabilities: {
    canResize: boolean;
    canConvert: boolean;
    canApplyFilters: boolean;
  };
  resize?: (input: ResizeInput) => Promise<ResizeOutput>;
  convert?: (input: ConvertInput) => Promise<ConvertOutput>;
  applyFilter?: (input: FilterInput) => Promise<FilterOutput>;
};

// 呼び出し側: 能力フラグで事前チェック
function processImage(processor: ImageProcessor, task: ImageTask) {
  if (task.type === "resize") {
    if (!processor.capabilities.canResize) {
      throw new Error(`${processor.id} does not support resize`);
    }
    return processor.resize!(task.input);
  }
  // ...
}

// 新しいプロバイダーは必要な機能だけ実装
const sharpProcessor: ImageProcessor = {
  id: "sharp",
  capabilities: { canResize: true, canConvert: true, canApplyFilters: false },
  resize: (input) => sharpResize(input),
  convert: (input) => sharpConvert(input),
  // applyFilter は未実装 — capabilities で canApplyFilters: false と宣言済み
};
```

## Bad Example

全メソッドを必須にすると、サポートしない機能にスタブ実装を強制される。

```typescript
// Bad: Fat Interface — 全メソッドが必須
interface ImageProcessor {
  id: string;
  resize(input: ResizeInput): Promise<ResizeOutput>;
  convert(input: ConvertInput): Promise<ConvertOutput>;
  applyFilter(input: FilterInput): Promise<FilterOutput>;
}

// サポートしない機能にもスタブ実装が必要
const basicProcessor: ImageProcessor = {
  id: "basic",
  resize: (input) => basicResize(input),
  convert: () => {
    throw new Error("Not supported");
  }, // スタブ
  applyFilter: () => {
    throw new Error("Not supported");
  }, // スタブ
};

// 呼び出し側にとって「何がサポートされているか」が不透明
// メソッドが存在するのに throw される — 実行時に初めて判明する
```

```typescript
// Bad: instanceof によるサブクラス判別
class BaseProcessor {/* ... */}
class ResizableProcessor extends BaseProcessor {
  resize() {/* ... */}
}
class ConvertibleProcessor extends BaseProcessor {
  convert() {/* ... */}
}

// 機能の組み合わせが継承の組み合わせ爆発を引き起こす
// ResizableAndConvertibleProcessor? ResizableAndFilterableProcessor?
function processImage(processor: BaseProcessor) {
  if (processor instanceof ResizableProcessor) {
    processor.resize(input);
  }
  // 新しい機能追加のたびにクラス階層が複雑化する
}
```

## 適用ガイド

### どのような状況で使うべきか

- **3 つ以上の同種バリアント**（プロバイダー、アダプター、プラグイン等）が存在し、各バリアントがサポートする機能にばらつきがある場合
- 新しいバリアントの追加頻度が高く、既存コードへの変更を最小化したい場合
- 外部から提供されるプラグインが、フレームワークの全機能を実装する必要がない場合

### 能力宣言の形式を選ぶ基準

| 形式                   | 適用場面                       | 例                                          |
| ---------------------- | ------------------------------ | ------------------------------------------- |
| `boolean` フラグ       | ON/OFF の二値で十分な機能      | `supportsObservationalMemory: boolean`      |
| 列挙配列               | サポートする能力が可変個       | `capabilities: ["audio", "image"]`          |
| 構造体フラグ           | 能力同士に関連がある場合       | `{ canStream: boolean, canBatch: boolean }` |
| メソッドオーバーライド | 能力の詳細が構造的に複雑な場合 | `getSupportedOperators(): OperatorSupport`  |

### 導入時の注意点

- **フラグとメソッドの整合性を保つ**: `canResize: true` なのに `resize` メソッドが `undefined` という状態を防ぐ。ファクトリ関数やバリデーション関数でフラグとメソッドの整合性を検証すると安全
- **エラーメッセージに代替手段を示す**: 非サポート機能の呼び出し時には、どのプロバイダーがその機能をサポートしているか、または機能を無効化する方法をエラーメッセージに含める（mastra の `MemoryStorage` が実践している）
- **三段階のメソッド分類を検討する**: mastra の手法に倣い、(1) abstract（必須）、(2) デフォルト warn ログ（任意）、(3) デフォルト throw（段階的対応）の三段階でメソッドを分類すると、新規アダプターの実装コストを最小化できる

### capabilities を型の narrowing と組み合わせる

TypeScript の型の絞り込み（narrowing）と Capabilities Flag を組み合わせることで、フラグチェック後にメソッドの存在を型レベルで保証できる。

```typescript
// 判別共用体で capabilities と利用可能メソッドを連動させる
type StreamCapableProvider = {
  capabilities: { canStream: true; };
  stream: (input: StreamInput) => AsyncIterable<Chunk>;
};

type BatchOnlyProvider = {
  capabilities: { canStream: false; };
  stream?: never; // 明示的に禁止
};

type Provider = (StreamCapableProvider | BatchOnlyProvider) & {
  id: string;
  generate: (input: GenerateInput) => Promise<GenerateOutput>;
};

function useProvider(provider: Provider) {
  if (provider.capabilities.canStream) {
    // 型が StreamCapableProvider に絞り込まれ、
    // provider.stream は非 optional として安全にアクセス可能
    return provider.stream(input);
  }
}
```

## 参考

- [repos/openclaw/openclaw/abstraction-patterns.md](../repos/openclaw/openclaw/abstraction-patterns.md) — Capability-based Interface、アダプタパターンの分析
- [repos/openclaw/openclaw/type-system-patterns.md](../repos/openclaw/openclaw/type-system-patterns.md) — 型システムにおける能力ベース設計
- [repos/mastra-ai/mastra/abstraction-patterns.md](../repos/mastra-ai/mastra/abstraction-patterns.md) — 三段階メソッド分類、Capability Flag パターン
- [repos/mastra-ai/mastra/type-system-patterns.md](../repos/mastra-ai/mastra/type-system-patterns.md) — 判別共用体と条件型による API 分岐
