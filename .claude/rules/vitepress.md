# VitePress ルール

- GitHub Pages サブパス配信（org.github.io/repo/）では `base` 設定に加え、テンプレート内のプログラム的リンクにも `withBase()` を適用する — themeConfig の nav/sidebar には自動適用されるが、カスタム Vue テンプレートの `:href` には適用されない
- Markdown 内の `{{ }}` は Vue テンプレート構文として解釈される（バッククォート内でも）— `<code v-pre>` でエスケープする
- Markdown 内のディレクトリリンクには末尾 `/` を付ける — 末尾スラッシュがないと VitePress が解決できず dead link エラーになる
