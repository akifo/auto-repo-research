# 拡張性メカニズム (Extensibility Mechanisms)

> リポジトリ: colinhacks/zod
> 分析日: 2026-02-19

## 概要

Zod v4 のスキーマバリデーションライブラリにおける拡張ポイント設計を分析した。refine / superRefine / transform / pipe / codec / check / stringFormat / registry といった多層の拡張メカニズムが、段階的な抽象度で提供されている。注目すべきは、v4 で「チェック」と「スキーマ型」の直交分離が徹底され、チェックがファーストクラスオブジェクトとして独立し再利用可能になった点、および双方向パース（codec）という新しい拡張軸が追加された点である。

## 背景にある原則

- **段階的開示 (Progressive Disclosure)**: 拡張 API を `refine`（最も簡単）→ `superRefine`（フルコントロール）→ `check`（再利用可能オブジェクト）→ `$constructor`（新しいスキーマ型）の段階で提供し、ユーザーの習熟度に応じて適切な抽象レベルを選択できるようにしている。v4 の `check()` メソッドは関数・チェックオブジェクト両方を受け付ける（`packages/zod/src/v4/classic/schemas.ts:171-184`）。

- **バリデーションとトランスフォームの直交分離**: チェック（`$ZodCheck`）とスキーマ型（`$ZodType`）が独立したコンストラクタ階層を持ち、チェックは `onattach` でスキーマにメタデータを注入し、`check` 関数で実際の検証を実行する。この分離により、同一のチェック（例: `z.minLength(3)`）を string / array / set に横断適用できる（`packages/zod/src/v4/core/checks.ts:28-39`）。

- **イミュータブルなチェーン (Immutable Fluent Chain)**: `check()` / `refine()` / `transform()` 等のメソッドは常に `clone()` で新しいインスタンスを返し、元のスキーマを変更しない。`clone` は `_zod.constr` を使って同じコンストラクタで再構築し、`parent` リンクでメタデータ継承を実現している（`packages/zod/src/v4/core/util.ts:485-489`）。

- **abort/continue による制御フロー**: 各チェックの `abort` フラグと issue の `continue` フラグにより、バリデーションパイプラインの早期終了をきめ細かく制御できる。デフォルトでは後続チェックを続行し、明示的に `abort: true` または `continue: false` で停止する設計は「エラーを網羅的に報告する」ことを優先している（`packages/zod/src/v4/core/schemas.ts:218-246`）。

## 実例と分析

### チェックのファーストクラスオブジェクト化

v4 の最も重要な設計変更は、チェック（バリデーションルール）をスキーマから独立したオブジェクトとして扱えるようになったことである。`$ZodCheck` は `$constructor` で生成され、`_zod.check` 関数と `_zod.onattach` コールバック配列を持つ。

`onattach` はチェックがスキーマに結合される時に呼ばれ、スキーマの `bag`（メタデータ辞書）にプロパティを設定する。これにより JSON Schema 生成やイントロスペクションがチェック情報にアクセスできる。

例えば `$ZodCheckLessThan` は `onattach` で `bag.maximum` を設定し、`check` 関数で実際の値比較を行う。この分離により、バリデーションロジックとメタデータ公開が独立して動作する。

### 条件付き実行 (when ガード)

チェックの `when` プロパティにより、前段のバリデーション結果に基づいてチェックの実行を条件分岐できる。`when` は `ParsePayload` を受け取り boolean を返す関数で、`false` を返すとそのチェックはスキップされる。

実際のユースケースとして、パスワード確認フィールドの cross-field バリデーションで「password フィールドにエラーがある場合は confirmPassword の一致チェックをスキップする」というパターンが実装されている。

### Codec による双方向パイプライン

v4 で新設された `$ZodCodec` は `$ZodPipe` を拡張し、`transform`（forward）と `reverseTransform`（backward）の双方向変換を持つ。`ctx.direction` で forward/backward を判定し、エンコード時にはスキーマの検証順序が逆転する。

この設計により、入力フォーマット（例: ISO 日付文字列）と内部表現（例: Date オブジェクト）の間の型安全な変換と、その逆変換を単一のスキーマ定義で表現できる。

### stringFormat によるドメイン固有バリデーション

`z.stringFormat(name, fnOrRegex, params)` は、カスタム文字列フォーマットバリデータを定義する拡張ポイントである。関数または正規表現を受け取り、`$ZodCustomStringFormat` として内部的にスキーマ型を生成する。生成されたフォーマットは組み込みフォーマット（email, uuid 等）と同等のステータスを持ち、JSON Schema にも反映される。

### Registry によるメタデータ拡張

`$ZodRegistry` は WeakMap ベースのメタデータストアで、スキーマインスタンスに任意のメタデータを関連付ける。`globalRegistry` は `globalThis` に配置されることで CJS/ESM デュアルパッケージ問題を回避している。`register()` メソッドや `describe()` / `meta()` メソッドから利用され、スキーマ定義とメタデータを疎結合に保つ。

## コード例

```typescript
// packages/zod/src/v4/core/checks.ts:32-39
// チェックのコンストラクタ: onattach 配列による拡張ポイント
export const $ZodCheck: core.$constructor<$ZodCheck<any>> = /*@__PURE__*/ core.$constructor(
  "$ZodCheck",
  (inst, def) => {
    inst._zod ??= {} as any;
    inst._zod.def = def;
    inst._zod.onattach ??= [];
  }
);
```

```typescript
// packages/zod/src/v4/classic/schemas.ts:171-184
// check() メソッド: 関数とチェックオブジェクトの両方を受け付ける
inst.check = (...checks) => {
  return inst.clone(
    util.mergeDefs(def, {
      checks: [
        ...(def.checks ?? []),
        ...checks.map((ch) =>
          typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch
        ),
      ],
    }),
    { parent: true }
  );
};
```

```typescript
// packages/zod/src/v4/core/api.ts:1637-1657
// superRefine: addIssue による手動イシュー追加の拡張ポイント
export function _superRefine<T>(fn: (arg: T, payload: $RefinementCtx<T>) => void | Promise<void>): checks.$ZodCheck<T> {
  const ch = _check<T>((payload) => {
    (payload as $RefinementCtx).addIssue = (issue) => {
      if (typeof issue === "string") {
        payload.issues.push(util.issue(issue, payload.value, ch._zod.def));
      } else {
        const _issue: any = issue;
        if (_issue.fatal) _issue.continue = false;
        _issue.code ??= "custom";
        _issue.input ??= payload.value;
        _issue.inst ??= ch;
        _issue.continue ??= !ch._zod.def.abort;
        payload.issues.push(util.issue(_issue));
      }
    };
    return fn(payload.value, payload as $RefinementCtx<T>);
  });
  return ch;
}
```

```typescript
// packages/zod/src/v4/core/schemas.ts:3928-3951
// Codec: 双方向パースの実装
export const $ZodCodec: core.$constructor<$ZodCodec> = /*@__PURE__*/ core.$constructor("$ZodCodec", (inst, def) => {
  $ZodType.init(inst, def);
  // ...
  inst._zod.parse = (payload, ctx) => {
    const direction = ctx.direction || "forward";
    if (direction === "forward") {
      const left = def.in._zod.run(payload, ctx);
      if (left instanceof Promise) {
        return left.then((left) => handleCodecAResult(left, def, ctx));
      }
      return handleCodecAResult(left, def, ctx);
    } else {
      const right = def.out._zod.run(payload, ctx);
      // ... reverse direction
    }
  };
});
```

```typescript
// packages/zod/src/v4/core/util.ts:485-489
// clone: イミュータブルチェーンの基盤
export function clone<T extends schemas.$ZodType>(inst: T, def?: T["_zod"]["def"], params?: { parent: boolean }): T {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent) cl._zod.parent = inst;
  return cl as any;
}
```

## パターンカタログ

- **Chain of Responsibility** (分類: 振る舞い)
  - 解決する問題: 複数のバリデーションルールを順序付きで適用し、各ルールが独立して成否を判断する
  - 適用条件: バリデーションパイプラインで各ステップが独立した検証ロジックを持つ場合
  - コード例: `packages/zod/src/v4/core/schemas.ts:213-255` — `runChecks` 関数がチェック配列を順次実行し、`abort`/`continue` フラグで連鎖を制御
  - 注意点: `when` ガードにより条件付きスキップが可能だが、チェック間の暗黙の依存関係が生まれやすい

- **Builder Pattern** (分類: 生成)
  - 解決する問題: 複雑なバリデーションスキーマを段階的に構築する
  - 適用条件: fluent API でスキーマを宣言的に組み立てる場合
  - コード例: `packages/zod/src/v4/classic/schemas.ts:156-258` — `ZodType` が `check()`, `refine()`, `transform()` 等の fluent メソッドを提供
  - 注意点: 各メソッドは `clone()` で新インスタンスを返すため、参照の等値比較に注意

- **Strategy Pattern** (分類: 振る舞い)
  - 解決する問題: チェックロジックを交換可能なオブジェクトとして外部化する
  - 適用条件: 同じチェックロジックを複数のスキーマで再利用する場合
  - コード例: `packages/zod/src/v4/core/checks.ts` — 各チェック型（`$ZodCheckLessThan`, `$ZodCheckRegex` 等）が独立した戦略として機能
  - 注意点: チェックオブジェクトはステートレスに保つこと。状態を持つとチェックの再利用時に予期しない挙動が生じる

## Good Patterns

- **段階的抽象度の拡張 API**: `refine(fn)` → `superRefine(fn, ctx)` → `check(checkObj)` → `$constructor(name, init)` の 4 段階で拡張ポイントを提供。シンプルなケースでは `refine` の 1 行で済み、複雑なケースでは `$constructor` で完全なカスタムスキーマ型を作れる。

```typescript
// 最も簡単: refine (boolean を返すだけ)
z.string().refine((val) => val.length > 3, "Too short");

// フルコントロール: superRefine (複数 issue を手動追加)
z.array(z.string()).superRefine((val, ctx) => {
  if (val.length > 3) ctx.addIssue({ code: "too_big", origin: "array", maximum: 3, inclusive: true, input: val });
  if (val.length !== new Set(val).size) ctx.addIssue({ code: "custom", input: val, message: "No duplicates" });
});

// 再利用可能: check オブジェクト
const positiveCheck = z.gt(0);
z.number().check(positiveCheck);  // 同じチェックを複数箇所で再利用
z.bigint().check(positiveCheck);
```

- **onattach によるメタデータ注入**: チェックがスキーマに結合される時にメタデータを設定する `onattach` コールバックパターン。バリデーションロジックとメタデータ（JSON Schema 生成等に使用）を同一オブジェクトに共存させつつ、実行タイミングを分離している。

```typescript
// packages/zod/src/v4/core/checks.ts:70-77
inst._zod.onattach.push((inst) => {
  const bag = inst._zod.bag;
  const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
  if (def.value < curr) {
    if (def.inclusive) bag.maximum = def.value;
    else bag.exclusiveMaximum = def.value;
  }
});
```

- **clone + parent リンクによるイミュータブルチェーン**: `check()` 等の fluent メソッドは `clone()` で新インスタンスを生成し、`parent` プロパティで元のスキーマへの参照を保持する。Registry のメタデータ継承が `parent` チェーンを遡って取得される（ただし `id` は継承しない）。

```typescript
// packages/zod/src/v4/core/registries.ts:64-71
get<S extends Schema>(schema: S): $replace<Meta, S> | undefined {
  const p = schema._zod.parent as Schema;
  if (p) {
    const pm: any = { ...(this.get(p) ?? {}) };
    delete pm.id; // do not inherit id
    const f = { ...pm, ...this._map.get(schema) } as any;
    return Object.keys(f).length ? f : undefined;
  }
  return this._map.get(schema) as any;
}
```

## Anti-Patterns / 注意点

- **transform 内での暗黙のエラーハンドリング不足**: `transform()` 内で `ctx.addIssue()` を呼んだ後も return 値が使用されるため、`z.NEVER` を返さないとパイプラインの後段に不正な値が流れる可能性がある。

```typescript
// Bad: addIssue 後に値を返してしまう
z.string().transform((val, ctx) => {
  if (val === "") {
    ctx.addIssue({ code: "custom", message: "Empty string" });
  }
  return val.length; // エラー時も後段に流れる可能性
});

// Better: z.NEVER で型安全にエラー伝播を停止
z.string().transform((val, ctx) => {
  if (val === "") {
    ctx.addIssue({ code: "custom", message: "Empty string" });
    return z.NEVER;
  }
  return val.length;
});
```

- **unidirectional transform と codec の混同**: `transform()` は一方向のみの変換で、`encode()` 呼び出し時に `ZodEncodeError` をスローする。双方向変換が必要な場合は `codec()` を使う必要がある。

```typescript
// Bad: transform は encode に対応しない
const schema = z.string().transform((val) => val.length);
z.encode(schema, 1234); // => ZodEncodeError

// Better: 双方向変換が必要なら codec を使う
const codec = z.codec(z.string(), z.number(), {
  decode: (str) => Number.parseFloat(str),
  encode: (num) => num.toString(),
});
```

- **when ガードの暗黙的な依存関係**: `when` による条件付きチェック実行は便利だが、チェック間の実行順序への暗黙の依存を作る。payload の issues 配列を検査する `when` は、前段のチェックが特定の path でエラーを出すことを前提としており、脆い結合を生む。

```typescript
// Bad: 前段チェックの内部実装に依存する when
.refine((data) => data.password === data.confirmPassword, {
  when(payload) {
    // password/confirmPassword フィールドのエラーがないことを前提とする
    return payload.issues.every((iss) => iss.path?.[0] !== "password");
  },
})
```

## 導出ルール

- `[MUST]` バリデーションライブラリの拡張 API は段階的抽象度で設計する（簡易 API → フルコントロール API → カスタム型定義）。ユーザーの 80% のケースが最も簡易な API で解決でき、20% の高度なケースでのみ低レベル API を使う構造にする
  - 根拠: Zod は `refine`（1 行）→ `superRefine`（ctx 付き）→ `check`（再利用可能オブジェクト）→ `$constructor`（新型定義）の 4 段階を提供し、テストコードの大半が refine/superRefine で完結している（`packages/zod/src/v4/classic/tests/refine.test.ts`）

- `[MUST]` fluent API でチェーンメソッドを提供する場合、各メソッドは元のインスタンスを変更せず新しいインスタンスを返すイミュータブル設計にする
  - 根拠: `clone()` が全ての fluent メソッドで使用され、テストでも `obj1 === obj2` が `false` であることを検証している（`packages/zod/src/v4/classic/tests/refine.test.ts:13`）

- `[SHOULD]` バリデーションルールを独立したファーストクラスオブジェクトとして設計し、スキーマ型とバリデーションロジックを直交させる。これにより同一ルールを異なるスキーマ型に横断適用できる
  - 根拠: `$ZodCheck` がスキーマ型から独立して定義され、`z.minLength(3)` を string / array 両方に適用可能。`when` ガードで型依存の実行条件を後付けできる（`packages/zod/src/v4/core/checks.ts:460, 510, 614`）

- `[SHOULD]` 変換パイプラインでエラーが発生した場合、後段の処理を確実に停止させる仕組み（sentinel value やエラーフラグ）を提供する
  - 根拠: Zod は `z.NEVER` sentinel と `continue`/`abort` フラグの 2 つの仕組みで変換パイプラインのエラー伝播を制御している（`packages/zod/src/v4/core/core.ts:13-15`, `packages/zod/src/v4/classic/tests/transform.test.ts:62-83`）

- `[SHOULD]` 拡張ポイントにメタデータ注入フック（`onattach` 相当）を設ける。バリデーションロジックとスキーマ表現（JSON Schema 等）生成の両方をサポートするため、ロジック実行時ではなくスキーマ構築時にメタデータを収集する
  - 根拠: `$ZodCheck` の `onattach` が `bag` にメタデータを設定し、JSON Schema 生成時にプロセッサがそれを参照する設計（`packages/zod/src/v4/core/checks.ts:70-77, 274-280`）

- `[AVOID]` 拡張 API で「前段の処理結果の内部構造」に依存する条件分岐を推奨する設計にしない。条件付き実行は入力値の状態に基づくべきで、前段の issues 配列の内容に依存すると脆い結合を生む
  - 根拠: `when` ガードが `payload.issues` を検査するパターンはテストで見られるが、前段チェックの path 構造への暗黙の依存を生む（`packages/zod/src/v4/classic/tests/refine.test.ts:480-484`）

## 適用チェックリスト

- [ ] バリデーションライブラリを設計する際、拡張 API が段階的抽象度（簡易→中級→上級）を持っているか確認する
- [ ] fluent API の各メソッドがイミュータブルに新インスタンスを返しているか確認する（ミュータブルなチェーンは並行利用で予期しない挙動を生む）
- [ ] バリデーションルールがスキーマ型から独立したオブジェクトとして再利用可能か確認する
- [ ] 変換パイプラインでエラー発生時に後段処理を停止する仕組み（sentinel value, abort flag 等）があるか確認する
- [ ] 双方向変換（シリアライズ/デシリアライズ）が必要な場合、一方向 transform ではなく codec パターンを採用しているか確認する
- [ ] 拡張ポイントにメタデータ注入フックがあり、バリデーションロジックとスキーマ表現生成が分離されているか確認する
- [ ] 条件付きバリデーションが入力値の状態に基づいており、前段チェックの内部実装（issues 配列の構造等）に依存していないか確認する
