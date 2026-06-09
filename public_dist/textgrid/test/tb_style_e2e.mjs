import { JSDOM } from 'jsdom';
import { initTableBuilder, parseTextileWithStyles } from '/home/claude/textgrid/src/index.js';
const dom=new JSDOM('<!DOCTYPE html><body><div id="w" style="position:relative"></div></body>',{pretendToBeVisual:true});
const {window}=dom; global.window=window; global.document=window.document; global.Node=window.Node; global.Set=Set;
window.requestAnimationFrame=(cb)=>{cb();return 1;}; window.confirm=()=>true;
const wrapper=document.getElementById('w');
let committed=null;
const api=initTableBuilder({wrapper,format:'textile',t:(k,f)=>f,copy:()=>{},showEditor:()=>{}});
function assert(c,m){if(!c){console.error('  ✗',m);process.exitCode=1;}else{console.log('  ✓',m);}}

const src='|_{background:#fef}. 項目 |_. 状態 |\n|{background:#ffe5e5}. *重要* | _注意_ |\n| 通常 | データ |';

console.log('\n[1] バインドで開く: 装飾も復元される');
api.openForText(src,'textile',(txt)=>{committed=txt;return {ok:true};},'k1',()=>{});
// セル(0,0)が太字、(0,1)が斜体（matrix.cellStylesは1行目=index0）
const ta00=wrapper.querySelector('textarea.tg-cell-ta[data-r="0"][data-c="0"]');
const ta01=wrapper.querySelector('textarea.tg-cell-ta[data-r="0"][data-c="1"]');
assert(ta00.value==='重要','*重要*から重要が抽出: '+ta00.value);
assert(ta01.value==='注意','_注意_から注意が抽出: '+ta01.value);
assert(ta00.style.fontWeight==='bold','太字スタイル反映: '+ta00.style.fontWeight);
assert(ta01.style.fontStyle==='italic','斜体スタイル反映: '+ta01.style.fontStyle);
const td00=ta00.parentElement;
// 背景色はインラインの style.backgroundColor ではなく CSS 変数で指定する。
// （選択ハイライトを潰さないため。）
const bgVar = td00.style.getPropertyValue('--tg-bg');
assert(bgVar.trim() !== '','背景色がCSS変数で反映: '+bgVar);

console.log('\n[2] 何も変えずに更新 → 元と同じTextile（意味的に同等）');
const updateBtn=Array.from(wrapper.querySelectorAll('.tg-toolbtn-primary')).find(b=>b.textContent==='更新'&&b.style.display!=='none');
updateBtn.click();
console.log('--- 書き戻し ---'); console.log(committed);
// パースし直して比較
const reparsed=parseTextileWithStyles(committed);
assert(reparsed.rows[0][0]==='項目' && reparsed.rows[0][1]==='状態','ヘッダ往復');
assert(reparsed.styles[0][0].bg==='#fef','ヘッダ背景色維持');
assert(reparsed.rows[1][0]==='重要' && reparsed.styles[1][0].bold===true,'太字往復');
assert(reparsed.rows[1][1]==='注意' && reparsed.styles[1][1].italic===true,'斜体往復');
assert(reparsed.styles[1][0].bg==='#ffe5e5','背景色往復');

console.log('\n=== Textile装飾の往復(モジュールAPI経由)検証完了 ===');
