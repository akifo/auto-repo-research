# Pattern: Mixin-Preset Dual API

> 出典: [repos/cloudflare/partykit/composition-patterns.md](../repos/cloudflare/partykit/composition-patterns.md), [repos/cloudflare/partykit/abstraction-patterns.md](../repos/cloudflare/partykit/abstraction-patterns.md), [repos/cloudflare/agents/architecture.md](../repos/cloudflare/agents/architecture.md)
> カテゴリ: pattern

## 概要

`withFeature(Base)` mixin 関数で上級者に柔軟なクラス合成を提供しつつ、`export const FeatureServer = withFeature(DefaultServer)` でゼロ設定のプリセットクラスも公開する「二層 API」設計パターン。上級者には任意のベースクラスとの合成の自由度を、入門者には `extends FeatureServer` だけで使えるシンプルさを同時に提供する。

このパターンの価値は「API のターゲットユーザーを二分しない」点にある。mixin 関数だけを公開すると入門者に `withFeature(Server)` というステップを強いる。逆にプリセットクラスだけを公開すると、カスタム基底クラスとの合成ができず上級者の柔軟性を奪う。両方を公開することで、すべての利用者に最適なエントリポイントを提供できる。

## 背景・文脈

cloudflare/partykit は Durable Objects ベースのリアルタイムサーバーフレームワークであり、`Server` 基底クラスに対して mixin で機能を追加する拡張モデルを採用している。`y-partyserver` パッケージは Yjs（CRDT）の協調編集機能を `withYjs` mixin として提供し、同時に `YServer` プリセットもエクスポートする。

cloudflare/agents は partykit の `Server` を継承した `Agent` クラスが中核にあり、`withFibers(Agent)` mixin で永続的ファイバー機能を追加する。ここでは mixin 関数のみが公開され、プリセットは提供されていない。両者を比較することで、二層 API の有無がもたらす開発者体験の差が明確になる。

### なぜ二層 API が必要になるか

フレームワークが基底クラス (`Server`) と拡張 mixin (`withYjs`) を提供する場合、利用者は 3 つのレベルに分かれる。

1. **入門者**: デフォルトの `Server` に機能を追加したいだけ。mixin の概念を知らなくても使いたい
2. **中級者**: プリセットクラスを継承し、`static options` やフックをカスタマイズしたい
3. **上級者**: カスタム `Server` サブクラスに mixin を適用し、複数の拡張を合成したい

プリセットクラスはレベル 1-2 をカバーし、mixin 関数はレベル 3 をカバーする。

## 実装パターン

### 核心: mixin 関数 + プリセット export

cloudflare/partykit の `y-partyserver` がこのパターンの代表的な実装である。

```typescript
// packages/y-partyserver/src/server/index.ts:167-169
// 上級者向け: 任意の Server サブクラスに Yjs を適用できる mixin 関数
export function withYjs<TBase extends ServerClass>(
  Base: TBase,
): TBase & YjsStatic & (new(...args: any[]) => YjsInstance) {
  class YjsMixin extends Base {
    // onStart, onConnect, onMessage, onClose をオーバーライド
    // document, handleMessage 等の新しいメンバーを追加
  }
  return YjsMixin as unknown as TBase & YjsStatic & (new(...args: any[]) => YjsInstance);
}
```

```typescript
// packages/y-partyserver/src/server/index.ts:550
// 入門者向け: withYjs(Server) を適用済みのプリセット
export const YServer = withYjs(Server);
```

この設計の構造は極めてシンプルである。mixin 関数とプリセットのコード上の関係は「プリセット = mixin(デフォルト基底クラス)」の 1 行で表現される。

### プリセットの利用パターン

プリセットは通常のクラスと同様に `extends` で継承し、設定をカスタマイズできる。

```typescript
// packages/y-partyserver/src/tests/worker.ts:33-38
// 入門者/中級者: YServer をそのまま継承して設定を追加
export class YPersistent extends YServer {
  static options = {
    hibernate: true,
  };
  static callbackOptions: CallbackOptions = {
    debounceWait: 50,
    debounceMaxWait: 100,
  };
}
```

### mixin 関数の利用パターン

上級者はカスタム基底クラスに mixin を適用して、複数の拡張を組み合わせる。

```typescript
// 上級者: カスタム Server サブクラスに Yjs を適用
class MyCustomServer extends Server {
  onRequest(req: Request) {
    // カスタムの HTTP ハンドリング
    return new Response("Custom endpoint");
  }
}

// withYjs はどんな Server サブクラスにも適用可能
const MyYjsServer = withYjs(MyCustomServer);
```

### 対比: プリセットなしの mixin（cloudflare/agents）

cloudflare/agents の `withFibers` は mixin 関数のみを提供し、プリセットを公開していない。

```typescript
// packages/agents/src/experimental/forever.ts:118-124
// mixin 関数のみ公開
export function withFibers<TBase extends AgentLike>(
  Base: TBase,
  options?: { debugFibers?: boolean; },
) {
  class FiberAgent extends Base {
    // keepAlive, spawnFiber, stashFiber, cancelFiber ...
  }
  return FiberAgent;
}
```

```typescript
// 利用側: 毎回 withFibers(Agent) を書く必要がある
class MyAgent extends withFibers(Agent)<Env, State> {
  async doWork(payload: unknown, fiberCtx: FiberContext) {
    // ...
  }
}
```

この場合、入門者も必ず `withFibers(Agent)` という mixin 構文を理解する必要がある。experimental 段階ではこの判断は妥当だが、安定 API では二層公開を検討すべきである。

## Good Example

### mixin 関数 + プリセット export の二層公開

```typescript
// Good: mixin 関数とプリセットを両方エクスポートする
// --- ライブラリ側 ---

// 1. mixin 関数（上級者向け）
export function withYjs<TBase extends ServerClass>(Base: TBase) {
  class YjsMixin extends Base {
    // Yjs 固有の機能を追加
  }
  return YjsMixin as unknown as TBase & YjsStatic & (new(...args: any[]) => YjsInstance);
}

// 2. プリセット（入門者向け）: たった 1 行
export const YServer = withYjs(Server);

// --- 利用側（入門者） ---
// mixin の概念を知らなくても使える
class MyServer extends YServer {
  static options = { hibernate: true };
}

// --- 利用側（上級者） ---
// カスタム基底クラスに適用できる
class MyCustomYjsServer extends withYjs(MyCustomServer) {
  // MyCustomServer の機能 + Yjs の機能
}
```

この設計がもたらす利点:

- 入門者は `YServer` を `Server` と同様に扱える（学習コスト最小）
- 上級者は `withYjs()` で任意のクラスに Yjs を合成できる（柔軟性最大）
- プリセットと mixin 関数の整合性はコードで担保される（`YServer = withYjs(Server)` という定義自体がテスト）

## Bad Example

### mixin 関数のみ公開する設計

```typescript
// Bad: プリセットを公開しない
export function withYjs<TBase extends ServerClass>(Base: TBase) {
  class YjsMixin extends Base {/* ... */}
  return YjsMixin as unknown as TBase & YjsStatic & (new(...args: any[]) => YjsInstance);
}

// 利用側: 入門者も毎回 withYjs(Server) と書く必要がある
class MyServer extends withYjs(Server) {
  // withYjs が何をしているか理解しないと不安
}
```

問題点:

- 入門者に mixin パターンの理解を強いる
- `withYjs(Server)` が毎回評価されるため、コードベース内で同じ mixin 適用が散在する
- ドキュメントの最初のステップが `extends withYjs(Server)` になり、学習曲線が急になる

### プリセットのみ公開する設計

```typescript
// Bad: プリセットだけを公開し、mixin 関数を内部に閉じ込める
function withYjs<TBase extends ServerClass>(Base: TBase) {/* ... */}

// プリセットのみエクスポート
export class YServer extends withYjs(Server) {/* ... */}

// 利用側: カスタム基底クラスに Yjs を追加できない
class MyCustomServer extends Server {
  onRequest(req: Request) {
    return new Response("Custom");
  }
}
// YServer を継承すると MyCustomServer の機能が失われる
class MyYjsServer extends YServer {
  // MyCustomServer の onRequest が使えない
}
```

問題点:

- カスタム基底クラスとの合成が不可能
- 利用者が「YServer のソースをコピーして自作」する事態を招く
- フレームワークの拡張性が根本的に制限される

## 適用ガイド

### どのような状況で使うべきか

- **フレームワーク/ライブラリの API 設計**: 基底クラスに対する拡張機能を提供する場合に最適。特に mixin が「安定した機能」として公開される段階で導入する
- **デフォルト構成が明確な場合**: 「ほとんどの利用者はデフォルトの基底クラスに mixin を適用する」という前提がある場合、プリセットが大きな価値を持つ
- **エコシステムに複数の基底クラスが存在する場合**: 例えば partykit の `Server` に加えてユーザーが作った `AuthenticatedServer` 等があり、両方に mixin を適用したいケース

### 導入時の注意点

1. **プリセットは mixin の呼び出し 1 行で定義する**: `export const YServer = withYjs(Server)` のように、プリセットが mixin の直接適用であることを明示する。クラス定義として書き直すと mixin との乖離が生じるリスクがある
2. **プリセットの命名規約**: `with` プレフィックスの mixin に対して、プリセットは機能名 + 基底クラス名で命名する（`withYjs` -> `YServer`）。mixin 名とプリセット名の対応が直感的に分かるようにする
3. **TypeScript の型キャストに注意**: mixin の戻り値型には `as unknown as` キャストが必要になることが多い（TypeScript の構造的な制約）。プリセット経由で使う場合はこの複雑さが隠蔽されるため、入門者に優しい
4. **experimental 段階では mixin のみで可**: cloudflare/agents の `withFibers` のように、API が安定するまではプリセットを提供せず mixin のみで公開するのも妥当な判断。プリセットは「この API は安定している」というシグナルにもなる

### カスタマイズポイント

- **複数のプリセットバリエーション**: `export const YServer = withYjs(Server)` に加えて `export const HibernatingYServer = withYjs(HibernatingServer)` のように、よく使われる組み合わせをプリセットとして複数提供することもできる
- **プリセットに追加設定を含める**: プリセットクラスにデフォルトの `static options` を設定し、mixin 単体よりも「すぐ使える」状態にする
- **README での段階的導入ガイド**: Quick Start ではプリセット、Advanced ではmixin を紹介するドキュメント構成にすることで、利用者のスキルレベルに応じた案内ができる

## 参考

- [repos/cloudflare/partykit/composition-patterns.md](../repos/cloudflare/partykit/composition-patterns.md) -- Mixin + プリセットの二層 API、三値フック、Factory パターン
- [repos/cloudflare/partykit/abstraction-patterns.md](../repos/cloudflare/partykit/abstraction-patterns.md) -- withYjs Mixin の型設計と抽象化手法の使い分け
- [repos/cloudflare/partykit/architecture.md](../repos/cloudflare/partykit/architecture.md) -- Server 基底クラスからの拡張アーキテクチャ
- [repos/cloudflare/agents/architecture.md](../repos/cloudflare/agents/architecture.md) -- withFibers mixin と Agent 継承の設計判断
