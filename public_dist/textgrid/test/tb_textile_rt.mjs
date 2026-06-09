import { toTextile, parseTextileWithStyles } from '/home/claude/textgrid/src/index.js';
function assert(c,m){if(!c){console.error('  ✗',m);process.exitCode=1;}else{console.log('  ✓',m);}}

console.log('\n[1] パース: ヘッダ装飾と本文装飾を読み取る');
const src='|_{background:#fef}. 項目 |_. 状態 |\n|{background:#ffe5e5}. *重要* | _注意_ |\n| 通常 | データ |';
const p=parseTextileWithStyles(src);
console.log('  rows:', JSON.stringify(p.rows));
console.log('  styles:', JSON.stringify(p.styles));
assert(p.rows[0][0]==='項目' && p.rows[0][1]==='状態','ヘッダ値');
assert(p.styles[0][0] && p.styles[0][0].bg==='#fef','ヘッダ背景色');
assert(p.styles[0][1]===null,'_.のみのヘッダはスタイル無し');
assert(p.rows[1][0]==='重要','*重要*から重要が抽出');
assert(p.styles[1][0].bold===true && p.styles[1][0].bg==='#ffe5e5','太字+背景');
assert(p.rows[1][1]==='注意' && p.styles[1][1].italic===true,'_注意_から斜体');
assert(p.rows[2][0]==='通常' && p.styles[2][0]===null,'装飾なしセル');

console.log('\n[2] 往復: パース→出力で同じTextileに戻る');
const cols=p.rows[0];
const data=p.rows.slice(1);
const hs=p.styles[0];
const cs=p.styles.slice(1);
const out=toTextile(cols,data,hs,cs);
console.log('--- 復元 ---'); console.log(out);
// 入力と意味的に等価か（空白の差は許す）。背景色・太字・斜体が出ているか確認
assert(/^\|_\{background:#fef\}\. 項目 \|_\. 状態 \|$/m.test(out),'ヘッダ行が復元');
assert(/\|\{background:#ffe5e5\}\. \*重要\* \| _注意_ \|$/m.test(out),'装飾セル行が復元');
assert(/\| 通常 \| データ \|$/m.test(out),'装飾なし行が復元');
console.log('\n=== Textile往復検証完了 ===');
