# Practice: Single-Point Access Control

> 出典: [repos/cloudflare/agents/design-philosophy.md](../repos/cloudflare/agents/design-philosophy.md)
> カテゴリ: practice

## 概要

アクセス制御チェックを個別メソッドに分散させず、データ変更の共通パス（単一ポイント）に集約するプラクティス。開発者がメソッドごとにパーミッションチェックを書く必要をなくし、チェック漏れを構造的に排除する。「安全なデフォルトを共通パスで強制し、個別ハンドラに判断を委ねない」という設計原則。

## 背景・文脈

Cloudflare Agents SDK では、WebSocket 接続に「readonly」属性を付与し、readonly 接続からの状態変更を禁止する機能がある。この readonly 強制をどこに配置するかが設計上の重要な判断点となった。

選択肢は 2 つ:

1. **個別メソッドでチェック** — 各 `@callable()` メソッドの冒頭で readonly を検証する
2. **共通パスでチェック** — すべての状態変更が通過する `setState()` 内部で一括検証する

SDK は後者を採用した。すべての状態変更は必ず `setState()` を経由するため、ここにゲートを置けば、`@callable()` メソッドが何十個あっても readonly チェックが漏れることはない。

この設計判断は Agent SDK 固有のものではなく、ORM のバリデーション、API Gateway の認可、ミドルウェアチェーンなど、「共通パスにゲートを置く」パターンとして広く応用できる。

## 実装パターン

Agents SDK の `setState()` は、呼び出し元の connection コンテキストを `AsyncLocalStorage` から取得し、readonly かどうかを判定する。readonly であれば即座に例外を投げ、内部の `_setStateInternal()` には到達させない。

```typescript
// packages/agents/src/index.ts:1282-1289
setState(state: State): void {
  const store = agentContext.getStore();
  if (store?.connection && this.isConnectionReadonly(store.connection)) {
    throw new Error("Connection is readonly");
  }
  this._setStateInternal(state, "server");
}
```

`setState()` と `_setStateInternal()` の分離は意図的な設計判断で、2 つの異なる関心を異なるレイヤーに配置している:

- **`setState()`** — アクセス制御（誰が変更できるか）
- **`_setStateInternal()`** — データ整合性（SQLite 永続化、全接続への broadcast、`onStateChanged` フック呼び出し）

readonly フラグ自体は、WebSocket の internal state（Cloudflare の attachment 機構）に `_cf_readonly` キーとして保存される。`_cf_` プレフィックスにより、ユーザーが connection state に任意のデータを格納しても名前衝突が起きない。

```typescript
// connection の internal state に readonly フラグを保存
// _cf_ プレフィックスでフレームワーク内部キーを名前空間分離
connection.state._cf_readonly = true;
```

## Good Example

### 共通パスに集約した設計

```typescript
// packages/agents/src/index.ts のパターン
// setState() が唯一のゲートとして機能する

class Agent<Env, State> {
  // 単一のアクセス制御ポイント
  setState(state: State): void {
    const store = agentContext.getStore();
    if (store?.connection && this.isConnectionReadonly(store.connection)) {
      throw new Error("Connection is readonly");
    }
    this._setStateInternal(state, "server");
  }

  // 個別の @callable メソッドにはチェックが不要
  @callable()
  updateName(name: string) {
    // readonly チェックは setState 内部で自動的に行われる
    this.setState({ ...this.state, name });
  }

  @callable()
  incrementCounter() {
    // ここにも readonly チェックは不要
    this.setState({ ...this.state, counter: this.state.counter + 1 });
  }

  @callable()
  resetAll() {
    // 何十個メソッドがあっても漏れない
    this.setState(this.initialState);
  }
}
```

### 一般化: ORM のバリデーションゲート

同じ原則は ORM やリポジトリパターンにも適用できる。

```typescript
// 共通の save() メソッドにバリデーションを集約
class Repository<T extends Entity> {
  async save(entity: T): Promise<T> {
    // すべての保存操作がここを通過する
    const currentUser = authContext.getStore();
    if (!currentUser?.canWrite(entity)) {
      throw new ForbiddenError(`No write permission for ${entity.constructor.name}`);
    }
    await this.validate(entity); // スキーマバリデーション
    return this.dataSource.save(entity); // 永続化
  }

  // 個別メソッドは権限チェック不要
  async updateStatus(id: string, status: Status): Promise<T> {
    const entity = await this.findById(id);
    entity.status = status;
    return this.save(entity); // save() 内で自動チェック
  }
}
```

## Bad Example

### 個別メソッドにチェックを分散した設計

```typescript
// Anti-Pattern: 各メソッドで個別にチェック
class Agent<Env, State> {
  @callable()
  updateName(name: string) {
    // 開発者がチェックを書く必要がある
    if (this.isConnectionReadonly(getCurrentConnection())) {
      throw new Error("Connection is readonly");
    }
    this._setStateInternal({ ...this.state, name }, "server");
  }

  @callable()
  incrementCounter() {
    // チェックを忘れると readonly 接続から変更できてしまう
    if (this.isConnectionReadonly(getCurrentConnection())) {
      throw new Error("Connection is readonly");
    }
    this._setStateInternal({ ...this.state, counter: this.state.counter + 1 }, "server");
  }

  @callable()
  resetAll() {
    // 新しいメソッドを追加するたびにチェックを書く必要がある
    // チーム開発では忘れるリスクが高い
    this._setStateInternal(this.initialState, "server"); // BUG: チェック漏れ
  }
}
```

この方式の問題点:

1. **チェック漏れリスク** — 新規メソッド追加時にチェックを忘れると、セキュリティホールになる
2. **ボイラープレートの増殖** — 同じ 3 行のチェックコードがすべてのメソッドに複製される
3. **レビュー負荷** — コードレビューで「チェックがあるか」を毎回確認する必要がある
4. **テスト負荷** — 各メソッドに対して readonly テストケースを個別に書く必要がある

### 副作用の順序ミス

共通パスにアクセス制御を集約しても、呼び出し側で副作用の順序を間違えるとガードが機能しない。

```typescript
// Bad: 副作用が先に実行される
@callable()
async processOrder(orderId: string) {
  await sendEmail(orderId);     // readonly でも実行される（不可逆）
  await chargePayment(orderId); // readonly でも実行される（不可逆）
  this.setState({ ... });       // ここで初めて throw — 手遅れ
}

// Good: 状態変更を先に行い、副作用は成功後に実行
@callable()
async processOrder(orderId: string) {
  this.setState({ ... });       // readonly なら即座に throw
  await sendEmail(orderId);     // setState 成功時のみ実行
  await chargePayment(orderId); // setState 成功時のみ実行
}
```

## 適用ガイド

### どのような状況で使うべきか

- **状態変更に対する権限チェック** — 複数のメソッド/エンドポイントが同じリソースを変更する場合
- **バリデーション** — 入力値やスキーマの検証を個別ハンドラに任せず、データ層で一括処理したい場合
- **監査ログ** — すべての変更操作を漏れなく記録したい場合
- **レート制限** — API の共通パスでリクエスト数を制御し、エンドポイントごとの実装を不要にしたい場合
- **マルチテナント分離** — テナント境界のチェックを ORM/リポジトリ層に集約したい場合

### 前提条件

- すべての変更操作が通過する「共通パス」（ボトルネックポイント）が存在すること
- Agents SDK では `setState()` がこの役割を果たすが、直接 SQL を実行するパスがあると迂回される
- 共通パスを迂回する方法がないこと、または迂回パスにも同等のチェックがあることを保証する必要がある

### 導入時の注意点

1. **副作用の実行順序に注意** — 共通パスのチェックより前に不可逆な副作用（外部 API 呼び出し、課金処理）を実行しないこと。状態変更を先に行い、成功後に副作用を実行する
2. **内部バイパスの管理** — Agents SDK では `_setStateInternal()` がチェックなしの内部パスとして存在する。フレームワーク内部からの呼び出しに限定し、開発者に公開しないこと
3. **コンテキスト伝搬の仕組み** — 「誰がこの操作を実行しているか」を共通パスに伝える手段が必要。Agents SDK は `AsyncLocalStorage` を使用しているが、Express の `req.user` やフレームワーク固有のコンテキスト機構でも代替可能
4. **名前空間の分離** — 内部フラグ（`_cf_readonly` 等）にはフレームワーク固有のプレフィックスを付け、ユーザーデータとの衝突を回避する

### カスタマイズポイント

- **チェックの粒度**: Agents SDK は readonly を boolean で管理しているが、RBAC（ロールベース）に拡張する場合は `setState()` 内でロールに基づく判定ロジックに差し替える
- **エラーハンドリング**: `throw new Error("Connection is readonly")` をカスタム例外クラスに変更し、クライアント側でエラーの種類を判別可能にする
- **ログ・監査**: 共通パスに監査ログを追加すれば、すべての状態変更を漏れなく記録できる
- **`validateStateChange` との組み合わせ**: Agents SDK では `setState()` のアクセス制御に加え、`_setStateInternal()` 内の `validateStateChange()` フックでビジネスルールの検証も行える。アクセス制御とビジネスバリデーションを異なるレイヤーに配置する設計

## 参考

- [repos/cloudflare/agents/design-philosophy.md](../repos/cloudflare/agents/design-philosophy.md) — 元の分析
