# Practice: Test Guardrails

> 出典: repos/epicweb-dev/epic-stack
> カテゴリ: practice

## 概要

テストが「通っているが実は壊れている」状態を構造的に防ぐ 2 つのガードレールを組み合わせるプラクティス。(1) console.error/warn をデフォルトで throw に変換し、サイレント失敗を根絶する。(2) ドメイン固有のカスタムマッチャーで多段階の検証ロジックを 1 行のアサーションに凝縮し、検証漏れを防ぐ。どちらも「テストの書き手が意識しなくても品質が担保される」仕組みであり、setupFiles に配置するだけでプロジェクト全体に適用できる。

## 背景・文脈

Epic Stack (epicweb-dev/epic-stack) は Kent C. Dodds が主導する Remix/React Router フルスタックテンプレートで、Vitest による統合テストを中心に据えたテスト戦略を採用している。OAuth コールバック、セッション管理、Toast 通知など、HTTP レスポンスの Cookie パースや DB 照合を伴う複雑な検証が頻出するため、低レベルの検証コードがテストファイルに散在しやすい。また、React のレンダリング警告やサーバーサイドのエラーログがテスト中に出力されても、テスト自体は通過してしまう問題があった。これらを setupFiles レベルで一括解決するのがこのプラクティスの狙いである。

## 実装パターン

### 1. console.error/warn のデフォルト throw 化

setupFiles で `beforeEach` を使い、毎テスト開始時に console.error と console.warn を spyOn して throw するように差し替える。元の出力も `originalConsoleError(...args)` で保持するため、エラー内容はターミナルに表示される。

```ts
// tests/setup/setup-test-env.ts:14-37
export let consoleError: MockInstance<(typeof console)["error"]>;
export let consoleWarn: MockInstance<(typeof console)["warn"]>;

beforeEach(() => {
  const originalConsoleError = console.error;
  consoleError = vi.spyOn(console, "error");
  consoleError.mockImplementation(
    (...args: Parameters<typeof console.error>) => {
      originalConsoleError(...args);
      throw new Error(
        "Console error was called. Call consoleError.mockImplementation(() => {}) if this is expected.",
      );
    },
  );

  const originalConsoleWarn = console.warn;
  consoleWarn = vi.spyOn(console, "warn");
  consoleWarn.mockImplementation((...args: Parameters<typeof console.warn>) => {
    originalConsoleWarn(...args);
    throw new Error(
      "Console warn was called. Call consoleWarn.mockImplementation(() => {}) if this is expected.",
    );
  });
});
```

ポイント:

- `export let consoleError` でテストファイルから import 可能にし、オプトアウトと呼び出し検証の両方を可能にする
- throw するエラーメッセージに「解除方法」を埋め込む（自己文書化）。初めて遭遇した開発者が対処法を即座に把握できる
- Vitest の `restoreMocks: true` 設定と組み合わせることで、各テスト終了後に自動で元の console に復元される

### 2. ドメイン固有カスタムマッチャー + TypeScript 型拡張

`expect.extend()` でプロジェクト固有のマッチャーを追加し、`declare module 'vitest'` で型を拡張する。

```ts
// tests/setup/custom-matchers.ts:15-78 (実装の要約)
expect.extend({
  toHaveRedirect(response: unknown, redirectTo?: string) {
    // Response の location ヘッダとステータスコード (3xx) を検証
    // URL のクエリパラメータ順序を正規化して比較
  },
  async toHaveSessionForUser(response: Response, userId: string) {
    // Set-Cookie → セッション復号 → DB の Session テーブル照合
  },
  async toSendToast(response: Response, toast: ToastInput) {
    // Set-Cookie → Toast セッション復号 → 内容の深い比較
  },
});
```

```ts
// tests/setup/custom-matchers.ts:160-169
interface CustomMatchers<R = unknown> {
  toHaveRedirect(redirectTo: string | null): R;
  toHaveSessionForUser(userId: string): Promise<R>;
  toSendToast(toast: ToastInput): Promise<R>;
}

declare module "vitest" {
  interface Assertion<T = any> extends CustomMatchers<T> {}
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}
```

ポイント:

- `Assertion` と `AsymmetricMatchersContaining` の両方を拡張することで、`expect(res).toHaveRedirect(...)` と `expect.objectContaining(...)` 内の両方で型補完が効く
- 実装と型拡張を同一ファイルに配置し、乖離を防止する
- `this.utils.printExpected()` / `this.utils.printReceived()` / `this.utils.diff()` を使い、失敗時のメッセージを Vitest 標準のフォーマットに揃える

## Good Example

### console.error の意図的オプトアウト + 呼び出し検証

`getErrorMessage(undefined)` は内部で `console.error` を呼ぶことが「期待される振る舞い」である。オプトアウトした上で、呼び出し内容まで検証している。

```ts
// app/utils/misc.error-message.test.ts:16-24
test("undefined falls back to Unknown", () => {
  consoleError.mockImplementation(() => {});
  expect(getErrorMessage(undefined)).toBe("Unknown Error");
  expect(consoleError).toHaveBeenCalledWith(
    "Unable to get error message for error",
    undefined,
  );
  expect(consoleError).toHaveBeenCalledTimes(1);
});
```

```ts
// app/utils/auth.server.test.ts:59-60
test("checkIsCommonPassword returns false when response has invalid format", async () => {
  consoleWarn.mockImplementation(() => {});
  // ... テスト実行 ...
  expect(consoleWarn).toHaveBeenCalledWith(
    "Unknown error during password check",
    expect.any(TypeError),
  );
});
```

このパターンの価値:

- オプトアウトがコード上に明示されるため、コードレビューで「なぜ console.error を許容しているのか」が可視化される
- `mockImplementation(() => {})` だけでなく `toHaveBeenCalledWith` で内容も検証しており、「想定通りのエラーか」まで担保している
- オプトアウトしていないテストで console.error が呼ばれると即座に失敗するため、見逃しがない

### カスタムマッチャーによる宣言的アサーション

OAuth コールバックのテストで、リダイレクト先・Toast 通知・DB 状態を一気に検証している例。

```ts
// app/routes/_auth/auth.$provider/callback.test.ts:75-89 (要約)
test("when a user is logged in, it creates the connection", async () => {
  const githubUser = await insertGitHubUser();
  const session = await setupUser();
  const request = await setupRequest({
    sessionId: session.id,
    code: githubUser.code,
  });
  const response = await loader({ request, ...LOADER_ARGS_BASE });

  expect(response).toHaveRedirect("/settings/profile/connections");
  await expect(response).toSendToast(
    expect.objectContaining({
      title: "Connected",
      type: "success",
      description: expect.stringContaining(githubUser.profile.login),
    }),
  );
});
```

`toHaveRedirect` と `toSendToast` の内部では、ステータスコード検証、Cookie パース、セッション復号、URL 正規化比較といった複雑な処理が走っているが、テストコードはドメイン語彙のみで構成されている。

## Bad Example

### カスタムマッチャーを使わない場合の検証コード

同じ検証をカスタムマッチャーなしで書くと、インフラ的な詳細がテストに漏れ出す。

```ts
// Bad: 検証ロジックがテストに散在する
test("when a user is logged in, it creates the connection", async () => {
  // ... セットアップ ...
  const response = await loader({ request, ...LOADER_ARGS_BASE });

  // リダイレクト検証: ステータスコードと location ヘッダを個別に確認
  expect(response.status).toBeGreaterThanOrEqual(300);
  expect(response.status).toBeLessThan(400);
  const location = response.headers.get("location");
  expect(location).toBe("/settings/profile/connections");

  // Toast 検証: Cookie パース → セッション復号 → 値の取り出し
  const setCookies = response.headers.getSetCookie();
  const toastCookie = setCookies.find(
    (c) => setCookieParser.parseString(c).name === "en_toast",
  );
  expect(toastCookie).toBeDefined();
  const toastSession = await toastSessionStorage.getSession(
    convertSetCookieToCookie(toastCookie!),
  );
  const toast = toastSession.get("toast");
  expect(toast).toMatchObject({
    title: "Connected",
    type: "success",
  });
});
```

問題点:

- テストの意図（「リダイレクトすること」「Toast が送られること」）がインフラ的なコードに埋もれる
- Cookie パースやセッション復号のロジックが複数のテストファイルにコピーされる
- 検証の一部を書き忘れやすい（ステータスコードのチェック漏れなど）

### console.error を放置する場合

```ts
// Bad: console.error ガードなし — テストは通るが警告を見逃す
test("handles invalid input", () => {
  // この関数は内部で console.error を呼ぶが、テストは通過してしまう
  const result = processInput(undefined);
  expect(result).toBeNull();
  // console.error の出力は誰にも気づかれない
});
```

```ts
// Good: ガードがあるため、意図的なオプトアウトが必要
test("handles invalid input", () => {
  consoleError.mockImplementation(() => {});
  const result = processInput(undefined);
  expect(result).toBeNull();
  expect(consoleError).toHaveBeenCalledWith(
    "Invalid input received",
    undefined,
  );
});
```

## 適用ガイド

### どのような状況で使うべきか

- **console.error throw 化**: あらゆるプロジェクトに適用可能。特に React プロジェクトでは、コンポーネントの prop 型エラーやレンダリング警告が console.error に出力されるため効果が大きい。サーバーサイドでも、ライブラリの非推奨 API 使用警告をキャッチできる
- **カスタムマッチャー**: HTTP レスポンス（リダイレクト、Cookie、ヘッダ）を検証するテストが 3 箇所以上あるプロジェクトで導入効果がある。検証ロジックが 1 箇所に集約されるため、仕様変更時の修正範囲も限定される

### 導入時の注意点

- **console.error throw 化は setupFiles で一括適用する**: 個別のテストファイルに書くと適用漏れが生じる。Vitest の `setupFiles` や Jest の `setupFilesAfterFramework` で全テストに自動適用する
- **Vitest の `restoreMocks: true` を有効にする**: `vi.spyOn` のモックが各テスト後に自動復元されるため、テスト間の干渉を防げる。この設定がないと、あるテストの `mockImplementation(() => {})` が後続テストに影響する
- **既存プロジェクトへの段階的導入**: console.error throw 化を導入すると、既存テストが大量に失敗する可能性がある。まず `consoleError.mockImplementation(() => {})` で既存の失敗を一括許容し、徐々にオプトアウトを減らしていく方法が現実的

### カスタマイズポイント

- **throw ではなく `test.fail()` にする**: throw だとスタックトレースが setup ファイルを指してしまう場合がある。テストフレームワークの failure API を使う方が適切な場合もある
- **console.log も対象にするか**: Epic Stack では error と warn のみ。log まで throw にするとデバッグ時に不便なため、プロジェクトの方針に応じて判断する
- **カスタムマッチャーの粒度**: `toHaveRedirect` のような汎用的なものから始め、`toHaveSessionForUser` のようなドメイン固有のものは必要になった時点で追加する

## 参考

- [repos/epicweb-dev/epic-stack/test-infrastructure.md](../repos/epicweb-dev/epic-stack/test-infrastructure.md) -- テスト基盤の設計分析
- [repos/epicweb-dev/epic-stack/testing-strategy.md](../repos/epicweb-dev/epic-stack/testing-strategy.md) -- テスト戦略全体の分析
- [repos/epicweb-dev/epic-stack/type-system-patterns.md](../repos/epicweb-dev/epic-stack/type-system-patterns.md) -- カスタムマッチャーの型拡張に関する分析
