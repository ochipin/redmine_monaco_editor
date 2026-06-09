import { JSDOM } from 'jsdom';
import { initTableBuilder } from '/home/claude/textgrid/src/index.js';
const dom=new JSDOM('<!DOCTYPE html><body><div id="w" style="position:relative"></div></body>',{pretendToBeVisual:true});
const {window}=dom; global.window=window; global.document=window.document; global.Node=window.Node; global.Set=Set;
window.requestAnimationFrame=(cb)=>{cb();return 1;};
let confirms=[]; window.confirm=(m)=>{confirms.push(m);return true;};
let alerts=[]; window.alert=(m)=>alerts.push(m);
const wrapper=document.getElementById('w');
let committed=null;
const api=initTableBuilder({wrapper,format:'textile',t:(k,f)=>f,copy:()=>{},showEditor:()=>{}});
function assert(c,m){if(!c){console.error('  ✗',m);process.exitCode=1;}else{console.log('  ✓',m);}}

const src='|_. A |_. B |_. C |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |';
api.openForText(src,'textile',(txt)=>{committed=txt;return {ok:true};},'k1',()=>{});

// グリッドにアクセスできないが、DOM操作で右クリックメニューを開いて結合を試す代わりに、
// 既存表に結合構文がある状態から開いて、それが正しく描画されるか確認する。
console.log('\n[1] 既存表（結合あり）を開く → tdが期待数で生成される');
const src2='|_. A |_. B |_. C |\n|\\2. xx | y |\n| 1 | 2 | 3 |';
api.openForText(src2,'textile',(txt)=>{committed=txt;return {ok:true};},'k2',()=>{});
// 1行目はヘッダ3、2行目はtd2（結合のため）、3行目はtd3
// tbodyタグなしで tr が並ぶ。1行目はヘッダ行（th）。
const allTrs = wrapper.querySelectorAll('.tg-table tr');
console.log('  全tr数:', allTrs.length);
// 最初のtrはヘッダ。データ行は1番目以降
const dataRows = Array.from(allTrs).slice(1);
console.log('  data行数:', dataRows.length);
// 1行目（index 0：結合行）のtd数（rowheadを除く）
const tdsRow0 = dataRows[0].querySelectorAll('td:not(.tg-rowhead)');
console.log('  結合行のtd数:', tdsRow0.length);
assert(tdsRow0.length===2,'結合行は2つの<td>（結合主+残り1）');
// 結合主のcolspanが2
const mainTd = tdsRow0[0];
assert(mainTd.colSpan===2,'結合主td.colspan=2: '+mainTd.colSpan);

console.log('\n[2] 更新ボタンで書き戻す → Textile構文が保持される');
confirms=[];
const updBtn = Array.from(wrapper.querySelectorAll('.tg-toolbtn-primary')).find(b => b.textContent==='更新' && b.style.display!=='none');
updBtn.click();
console.log('  書き戻し内容:'); console.log(committed);
assert(/\\2\. xx /.test(committed),'\\2. 構文が再出力される');

console.log('\n=== 結合の描画と往復 検証完了 ===');
