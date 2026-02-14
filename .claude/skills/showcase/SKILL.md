---
name: showcase
description: "研究結果から実用的な知見を抽出し、showcase ファイルを生成する。キーワード: showcase, 知見, パターン"
version: 2026.02.14
user-invocable: true
argument-hint: "[<theme> <name>]（省略時は候補を提案）"
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /showcase skill

研究結果（repos/ 配下）から実用的な知見を抽出し、テーマ別の showcase ファイルを生成する。

## 実行フロー

### Step 0: 引数なし時の候補提案

> 引数がある場合はこのステップをスキップし、Step 1 へ進む。

1. `repos/` 配下の全 `meta.yaml` を Glob で列挙し Read する
2. 各リポの `rules.md` を Read し、高価値なルール・カテゴリを把握する
3. 各リポの `overview.md` の「特に注目すべき知見」セクションを Read する
4. 既存の `showcases/` 配下のファイルを Glob で確認し、すでに作成済みのテーマと重複しないようにする
5. 収集した情報から showcase 候補を **5個** 提案する
   - 各候補に `theme`, `name`, 1行の説明を付与する
   - 複数リポがある場合は横断的なテーマも含める
   - theme の候補: `pattern`, `practice`, `tool`, `workflow`, `claude`（候補外も許容）
6. AskUserQuestion で候補を提示し、ユーザーに選択させる
   - 「Other」で自由入力も可能
7. 選択された候補の theme と name で Step 1 以降を実行する

### Step 1: 引数の解析

1. 引数から `theme` と `name` を抽出する
   - 例: `pattern middleware-chain` → theme=`pattern`, name=`middleware-chain`
   - 引数が不足している場合は Step 0 に戻り候補を提案する
2. 出力先: `showcases/<theme>_<name>.md`
3. theme の候補: `pattern`, `practice`, `tool`, `workflow`, `claude`
   - 候補外の theme も許容する（柔軟に拡張可能）

### Step 2: 関連する研究データの収集

1. `repos/` 配下の全 `meta.yaml` を読み取り、利用可能なリポジトリと視点を把握する
2. テーマと名前に関連する視点ファイルを特定する
   - Grep で関連キーワードを検索
   - 関連度の高い視点ファイルを読み取る
3. 複数リポジトリにまたがる知見を横断的に収集する

### Step 3: showcase ファイルの生成

1. `templates/showcase.md` を Read で読み取る
2. テンプレートに従って showcase ファイルを生成する:
   - **概要**: この知見の価値を 2-3 文で
   - **背景・文脈**: どのリポジトリでこのパターンが見られたか
   - **実装パターン**: 具体的なコード例（出典リポのパスと行番号付き）
   - **Good Example**: 良い実装例
   - **Bad Example**: 避けるべき実装例
   - **適用ガイド**: いつ使うか、注意点、カスタマイズポイント
   - **参考**: 元の分析ファイルへのリンク
3. `showcases/<theme>_<name>.md` に Write で出力する

### Step 4: 完了報告

- 生成したファイルのパス
- 参照した研究データ（リポジトリ・視点）
- 知見のハイライト

## 品質基準

- 複数リポジトリの知見を統合している場合は、それぞれの出典を明記する
- コード例は実際のリポジトリから引用する（架空のコードを書かない）
- Good/Bad Example は対比が明確であること
- 適用ガイドは具体的で実践的であること
- 1 ファイル 100-400 行を目安とする

## エラーハンドリング

- `repos/` が空の場合: まず `/research` でリポジトリを研究するよう案内する
- 関連する研究データが見つからない場合: 利用可能な視点を提示し、テーマの変更を提案する
