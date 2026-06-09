# textgrid

[English](./README.md) | 日本語

Markdown と Textile に互換性のあるスプレッドシート風のテーブル編集UIライブラリ。
ブラウザで直接動作する ES Module として配布される（ビルド不要）。

## 特徴

- **Markdown / Textile の双方向変換**: テーブル文字列をパースし、Excelライクなグリッドで編集し、再びテーブル文字列に書き戻す
- **セル装飾**: 太字・斜体・下線（Textile）、背景色（Textile）、左右中央揃え
- **セル結合**: rowSpan / colSpan を持つ結合セル（Textileのみ書き戻し可能）
- **Excelライクな操作**: 範囲選択、行/列の追加・削除・移動、コピー＆ペースト、Undo/Redo（装飾・行列操作・結合）
- **タブ管理**: 複数の表を同時に開いて、タブで切り替え可能
- **依存なし**: 外部ライブラリへの依存ゼロ。標準のブラウザAPIだけで動作

## インストール

NPMパッケージはまだ未公開のため、リポジトリのコピーで利用する。

```sh
git clone https://github.com/<owner>/textgrid.git
cp -r textgrid /path/to/your/project/lib/
```

## 使い方

### 動作確認 (demo)

> **重要**: ES Module は `file://` プロトコルでは動きません（CORS制約）。
> 必ず HTTP サーバー経由で配信する必要があります。

```sh
cd textgrid
python3 -m http.server 8000
# ブラウザで http://localhost:8000/demo/ を開く
```

`npm run demo` でも同じ。

### HTML

```html
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="./textgrid/styles/textgrid.css">
</head>
<body>
  <div id="wrapper" style="position: relative; width: 800px; height: 600px;"></div>
  <script type="module">
    import { initTableBuilder } from './textgrid/src/index.js';

    const api = initTableBuilder({
      wrapper: document.getElementById('wrapper'),
      format: 'textile',  // または 'markdown'
      t: (key, fallback) => fallback,
      copy: (text) => navigator.clipboard.writeText(text),
      showEditor: () => { /* ライブラリを閉じる際の処理 */ },
    });

    // 新規の空表を開く
    api.open();
  </script>
</body>
</html>
```

### ctx パラメータ

`initTableBuilder(ctx)` の `ctx` オブジェクトには以下のフィールドを渡す:

| キー | 型 | 必須 | 説明 |
|-----|----|----|----|
| `wrapper` | `HTMLElement` | はい | 表ビルダーを差し込むコンテナ。`position: relative` 推奨 |
| `format` | `'markdown' \| 'textile'` | はい | 表のフォーマット |
| `t` | `(key, fallback) => string` | はい | i18n コールバック。fallback をそのまま返せばOK |
| `copy` | `(text: string) => void` | はい | 「表をコピー」ボタンが押されたときに呼ばれる |
| `showEditor` | `() => void` | はい | 表ビルダーを閉じて元のエディタに戻る時に呼ばれる |

### API

`initTableBuilder` の返り値はオブジェクト:

- **`open()`**: 新規の空表を新しいタブで開く
- **`openForText(text, format, commit, key, onClose)`**: 既存のテキスト表を編集対象として開く
  - `text`: テーブルの文字列（Markdown or Textile）
  - `format`: テキストのフォーマット
  - `commit(newText)`: 「更新」ボタンが押された時に呼ばれる。新しい表テキストを受け取って、外部の状態に反映するコールバック。`{ ok: true }` を返せば成功扱い、エラー文字列を返せば失敗扱い
  - `key`: タブを一意に識別するキー（同じkeyで既に開いていれば、そのタブにフォーカスする）
  - `onClose`: タブが閉じられた時に呼ばれる
- **`showBody()`**: 現在のタブを閉じて本文（呼び元のエディタ）に戻る
- **`destroy()`**: 全てのタブ・DOM・状態をクリア

### 低レベル API（パーサ・シリアライザ）

UI を使わずに、パース／シリアライズだけ利用することも可能:

```js
import {
  toMarkdown, toTextile,
  parseMarkdown, parseMarkdownWithStyles,
  parseTextile, parseTextileWithStyles,
  parseTsv,
} from './textgrid/src/index.js';

// テキスト → 二次元配列
const rows = parseMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
// → [['A', 'B'], ['1', '2']]

// 装飾・結合情報も合わせて
const parsed = parseTextileWithStyles(textileText);
// → { rows, styles, isHeader, merges }

// 二次元配列 → テキスト
const md = toMarkdown(['A', 'B'], [['1', '2']]);
const tx = toTextile(headers, data, headerStyles, cellStyles, cellMerges);
```

### CSS について

- ライブラリのスタイルは全て `.tg-` プレフィックスで定義されている
- 配色は明色系（背景白）を前提
- ダーク背景の環境に組み込む場合は、CSSの色指定を上書きする

## ライセンス

MIT - 詳細は LICENSE ファイル参照
