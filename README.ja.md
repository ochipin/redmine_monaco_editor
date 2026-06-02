# Redmine Monaco Editor

[English](README.md) | **日本語**

**入れるだけで、Redmineの「ちょっと書きにくい」エディタが VS Code 並みの書き心地に変わるプラグインです。**

このプラグインは、Redmine標準のテキストエリアを [Monaco Editor](https://microsoft.github.io/monaco-editor/)（VS Codeを動かしているエディタエンジン）にまるごと置き換えます。シンタックスハイライト、ライブプレビュー、アウトライン表示などがそのまま使えるようになり、長い手順書や設計メモもぐっと書きやすくなります。

![](docs/image.png)

外部のCDNやAPIには一切つなぎません。Monaco本体をプラグインに同梱しているので、**インターネットに接続できない閉じた環境（オンプレ・社内ネットワーク）でもそのまま動きます。**

## できること

**VS Codeのシンタックスハイライト**
Markdownはもちろん、コードブロックの中身も言語ごとに色分けされます。bash・SQL・Python・Go・Rust・YAMLなど主要な言語に対応しているので、手順書にコマンドやコードを貼っても読みやすいままです。

**4つの表示モードを切り替え**
「編集だけ」「エディタとプレビューを左右に分割」「上下に分割」「プレビューだけ」をワンクリックで切り替えられます。書きながら仕上がりを確認したいときは分割モードが便利です。プレビューはRedmine純正と同じ見た目（章番号やテーマのスタイル）でレンダリングされます。

**自由にリサイズ**
エディタの高さも、分割したペインの境界も、ドラッグで好きなサイズに調整できます。

**スクロール同期**
分割モードでエディタをスクロールすると、プレビュー側も対応する位置に追従します。長い文書でも「今どこを書いているか」を見失いません。

**アウトラインパネル**
見出しの一覧をサイドパネルに表示できます。階層がインデントで表現され、クリックでその見出しへジャンプ。長いwikiページの全体像をつかんだり、目的の章へ素早く移動したりできます。

**チケット番号のツールチップ**
`#1010` や `#89-3` のようなチケット参照にカーソルを合わせると、そのチケットの情報がツールチップでふわっと表示されます。いちいちリンクを開かなくても内容を確認できます。

**@メンションの入力補完**
`@` を入力するとメンバー候補が出てきます。あいまい検索に対応していて、表示名で選んでも内部のログインIDに自動変換されるので、メンションを正確に・素早く入力できます。候補や確定済みメンションにはツールチップも表示されます。

**書式ツールバー**
太字・斜体・下線・取消線・インラインコード・見出し（H1〜H4）・箇条書き・番号付きリスト・引用・コードブロックをボタンから挿入できます。選択したテキストを囲む形でも、カーソル位置に挿入する形でも動きます。`Ctrl+B`（太字）・`Ctrl+I`（斜体）のショートカットにも対応しています。

**表のグリッド挿入**
表ボタンを押すとマス目が出てきて、マウスで「3×4」のように行数×列数を選ぶだけで表のひな形が挿入されます。ExcelやWord感覚で表を作り始められます。

**画像の挿入**
そのチケット／wikiに添付した画像を、サムネイル付きの一覧から選んで挿入できます。アップロードしたばかりで保存前の画像も候補に出ます。同名ファイルがあるときは新しい方が優先され、ホバーすると日付が確認できます。

**ファイルリンクの挿入**
添付ファイルへのリンク（`attachment:ファイル名`）を一覧から選んで挿入できます。Excel・Word・PDF・PowerPoint・画像・コード・設定ファイルなど、種類ごとにアイコンが付くので一目で見分けられます。ホバーするとファイル名・説明・日付が表示されます。

**Markdown と Textile の両対応**
Redmineの設定がMarkdownでもTextileでも動きます。ツールバーのボタンは設定に応じて正しい記法を自動で出し分けるので、どちらの環境でも同じ操作感で使えます。

**ユーザーごとにオン/オフ**
「使い慣れた標準エディタのままがいい」という人のために、各ユーザーが自分の「個人設定」画面で Monaco Editor を使うかどうかを選べます。オフにしたユーザーには Monaco が読み込まれず、Redmine標準のエディタがそのまま表示されます。

**テーマの選択**
各ユーザーが「個人設定」画面でエディタのテーマを選べます。GitHub Light・Quiet Light（どちらも明るいテーマ）と、GitHub Dark（ナイトモード）から選択できます。ユーザーごとの設定なので、それぞれが好みの見た目で使えます。

**フォントサイズの変更**
各ユーザーが「個人設定」画面でエディタのフォントサイズも選べます。他の設定と同じく、ユーザーごとに保存されます。

**全画面表示**
エディタのツールバー右上に全画面ボタンがあります。押すとエディタ部分だけが画面いっぱいに広がり、長い文書の執筆に集中できます。もう一度ボタンを押すか、ESCキーで通常表示に戻ります。

## 動作確認環境

- Redmine 6.1（Propshaft環境）
- テキストフォーマット: Markdown / Textile のどちらも対応（「管理 > 設定 > 全般」で選択）
- 表示言語: 日本語・英語に対応（Redmineのユーザー言語設定に自動で追従）
- 同梱している Monaco Editor: v0.52.0（プラグインに同梱・完全オフラインで動作）

## ディレクトリ構成

```
redmine_monaco_editor/
├── init.rb                          # プラグイン登録 + ViewHook（i18n辞書の埋め込み）
├── config/
│   └── locales/
│       ├── en.yml                   # UI文字列（英語）
│       └── ja.yml                   # UI文字列（日本語）
├── assets/
│   ├── javascripts/monaco_editor.js # メインスクリプト
│   └── stylesheets/monaco_editor.css
├── public_dist/
│   └── vs/                          # Monaco本体（→ public/monaco_assets/vs/ へ配置する）
├── LICENSE
└── README.md
```

## インストール

### ステップ1: プラグインを配置

`redmine_monaco_editor` ディレクトリを Redmine の `plugins/` 配下に置きます。

```
<REDMINE_ROOT>/plugins/redmine_monaco_editor/
```

### ステップ2: Monaco本体（vs/）を public 直下へ配置 ★重要★

ここがこのプラグインの肝です。**`public_dist/vs/` を Redmine の `public/monaco_assets/vs/` にコピー**してください。

```bash
mkdir -p <REDMINE_ROOT>/public/monaco_assets
cp -r <REDMINE_ROOT>/plugins/redmine_monaco_editor/public_dist/vs \
      <REDMINE_ROOT>/public/monaco_assets/vs
```

配置後、次のファイルが存在すればOKです。

```
<REDMINE_ROOT>/public/monaco_assets/vs/loader.js
```

### ステップ3: Redmineを再起動

Webサーバ（Puma / Passenger 等）を再起動します。

### 動作確認

ブラウザでチケットやwikiの編集画面を開き、エディタがMonacoに変わっていれば成功です。`<host>/monaco_assets/vs/loader.js` に直接アクセスして200が返ることでも確認できます。

## なぜ public/ に置くのか（技術的背景）

「ステップ2がちょっと面倒だな」と思われるかもしれませんが、これにはRedmine 6側の事情があります。

Redmine 6 のアセットパイプライン（Propshaft）は、アセットをハッシュ付きURL（`/assets/....-<hash>.js`）でのみ配信します。一方 Monaco Editor は、`vs/loader.js` を起点に `vs/editor/...` などのサブファイルを **素のパス（ハッシュ無し）で大量に動的ロード** する設計です。このためPropshaft管理下に置くと素パスが404になり、動きません。

そこで `vs/` だけは `public/` 直下に置きます。public配下のファイルはRailsが（Propshaftを介さず）素のパスのまま静的配信するため、Monacoのローダーが正しく動作します。

- `monaco_editor.js` / `monaco_editor.css` … 通常のプラグインアセット（`javascript_include_tag` / `stylesheet_link_tag` 経由でRedmineが配信）
- `vs/` … `public/monaco_assets/vs/` に配置して素パス配信（`/monaco_assets/vs/...`）

JS側は `/monaco_assets/vs` を参照する固定設定になっています（`monaco_editor.js` 内 `getMonacoBase()`）。配置先を変更したい場合はこの関数の戻り値も合わせて変更してください。

## 更新のたびにコピーを自動化したいとき

ステップ2のコピーは、プラグインを更新するたびに行う必要があります。環境に応じて起動処理へ組み込むと、手動コピーが不要になります。

### Docker（公式redmineイメージ等）

コンテナ起動時に `public/` がリセットされる構成では、entrypointスクリプトにコピー処理を追加します。

```bash
# entrypoint内、サーバ起動(exec)の前に実行する例
src="plugins/redmine_monaco_editor/public_dist/vs"
dest="public/monaco_assets/vs"
if [ -d "$src" ]; then
    rm -rf "$dest"
    mkdir -p "$(dirname "$dest")"
    cp -r "$src" "$dest"
fi
```

`if [ -d "$src" ]` で囲っているため、このプラグインを外しても起動に影響しません（コピー元が無ければ何もしません）。

### 非Docker（Passenger / Puma 直置き等）

`public/monaco_assets/vs/` は一度コピーすれば永続するため、ステップ2を一度実行するだけで大丈夫です。プラグインを更新した際は、再度ステップ2を実行して `vs/` を入れ替えてください。

シンボリックリンクでも動きます（Webサーバがsymlink先を配信できる構成の場合）。

```bash
ln -s <REDMINE_ROOT>/plugins/redmine_monaco_editor/public_dist/vs \
      <REDMINE_ROOT>/public/monaco_assets/vs
```

## アンインストール

1. `plugins/redmine_monaco_editor/` を削除
2. `public/monaco_assets/` を削除
3. Redmine再起動

元の標準エディタに戻ります。

## ライセンス

このプラグインは MIT ライセンスで公開しています。詳細は [LICENSE](LICENSE) を参照してください。

なお `public_dist/vs/` に同梱している Monaco Editor は Microsoft による別ライセンス（MIT License）の成果物です。Monaco Editor の著作権・ライセンスは Microsoft に帰属します。
