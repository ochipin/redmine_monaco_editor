/* textgrid - スプレッドシート風のテーブルビルダー
 *
 * Markdown / Textile に互換性のあるテーブル編集UIを提供するライブラリ。
 * MIT License.
 *
 * このエントリポイントは src/textgrid.js の全ての公開APIを再エクスポートする。
 *
 * 主な公開API:
 *
 *   initTableBuilder(ctx) → { open, openForText, showBody, destroy }
 *     表ビルダーのパネル/タブUIを初期化する高レベルAPI。
 *     ctx = {
 *       wrapper:   HTMLElement,       // 表ビルダーを差し込むコンテナ
 *       format:    'markdown' | 'textile',  // 既定のフォーマット
 *       t:         (key, fallback) => string,  // i18nコールバック
 *       copy:      (text) => void,    // 「表をコピー」時に呼ばれる
 *       showEditor:() => void,        // 表ビルダーを閉じて本文に戻る時に呼ばれる
 *     }
 *     返り値:
 *       open():                                新規の空表を開く
 *       openForText(text, format, commit, key, onClose):
 *                                              既存のテキスト表に bind して開く
 *       showBody():                            現在のタブを閉じて本文へ戻る
 *       destroy():                             全ての DOM・状態をクリア
 *
 *   toMarkdown(columns, data, headerStyles?, cellStyles?) → string
 *   toTextile (columns, data, headerStyles?, cellStyles?, cellMerges?) → string
 *     二次元データから Markdown / Textile テーブル文字列を生成する。
 *
 *   parseMarkdown(text) → rows[][] | null
 *   parseMarkdownWithStyles(text) → { rows, styles } | null
 *   parseTextile(text) → rows[][] | null
 *   parseTextileWithStyles(text) → { rows, styles, isHeader, merges } | null
 *   parseTsv(text) → rows[][] | null
 *     文字列からデータ・装飾・結合情報を読み取る。
 *
 * 使用例 (ESM):
 *
 *   import { initTableBuilder } from './textgrid/src/index.js';
 *   const api = initTableBuilder({
 *     wrapper: document.getElementById('editor'),
 *     format: 'textile',
 *     t: (key, fallback) => fallback,
 *     copy: (text) => navigator.clipboard.writeText(text),
 *     showEditor: () => { /* エディタへ戻る *\/ },
 *   });
 *   api.open();  // 新規表を表示
 *
 * CSSはあわせて styles/textgrid.css を読み込むこと。
 *   <link rel="stylesheet" href="./textgrid/styles/textgrid.css">
 */

export {
  initTableBuilder,
  toMarkdown,
  toTextile,
  parseMarkdown,
  parseMarkdownWithStyles,
  parseTextile,
  parseTextileWithStyles,
  parseTsv,
} from './textgrid.js';
