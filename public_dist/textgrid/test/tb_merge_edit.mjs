import { JSDOM } from 'jsdom';
import { initTableBuilder, parseTextileWithStyles } from '/home/claude/textgrid/src/index.js';
const dom=new JSDOM('<!DOCTYPE html><body><div id="w" style="position:relative"></div></body>',{pretendToBeVisual:true});
const {window}=dom; global.window=window; global.document=window.document; global.Node=window.Node; global.Set=Set;
window.requestAnimationFrame=(cb)=>{cb();return 1;}; window.confirm=()=>true; window.alert=()=>{};
const wrapper=document.getElementById('w');
let committed=null;
const api=initTableBuilder({wrapper,format:'textile',t:(k,f)=>f,copy:()=>{},showEditor:()=>{}});
function assert(c,m){if(!c){console.error('  ✗',m);process.exitCode=1;}else{console.log('  ✓',m);}}

console.log('\n[1] 結合内側に行を挿入 → 結合が自動拡張');
// 縦結合 2x1 の表を開く: 項目列を行0-1で縦結合
const src1='|_. A |_. B |\n|/2. x | y |\n|  | z |\n| a | b |';
api.openForText(src1,'textile',(txt)=>{committed=txt;return {ok:true};},'k1',()=>{});

console.log('\n[2] 結合あり時、ソート・移動ハンドルが無効化されているか');
const sortBtns=wrapper.querySelectorAll('.tg-colhead-sort');
const handleBtns=wrapper.querySelectorAll('.tg-colhead-handle');
const rowHandles=wrapper.querySelectorAll('.tg-rowhead-handle');
let disabledSort=0; sortBtns.forEach(b=>{if(b.classList.contains('tg-disabled')) disabledSort++;});
let disabledColH=0; handleBtns.forEach(b=>{if(b.classList.contains('tg-disabled')) disabledColH++;});
let disabledRowH=0; rowHandles.forEach(b=>{if(b.classList.contains('tg-disabled')) disabledRowH++;});
console.log('  ソートボタン無効化:', disabledSort, '/', sortBtns.length);
console.log('  列移動ハンドル無効化:', disabledColH, '/', handleBtns.length);
console.log('  行移動ハンドル無効化:', disabledRowH, '/', rowHandles.length);
assert(disabledSort===sortBtns.length && sortBtns.length>0,'結合あり時、全ソートボタンが無効化');
assert(disabledColH===handleBtns.length && handleBtns.length>0,'結合あり時、全列移動ハンドルが無効化');
assert(disabledRowH===rowHandles.length && rowHandles.length>0,'結合あり時、全行移動ハンドルが無効化');

console.log('\n[3] 結合のない表ではソート等は無効化されない');
const src2='|_. A |_. B |\n| x | y |\n| a | b |';
api.openForText(src2,'textile',()=>({ok:true}),'k2',()=>{});
const sortBtns2=wrapper.querySelectorAll('.tg-colhead-sort');
let dis2=0; sortBtns2.forEach(b=>{if(b.classList.contains('tg-disabled')) dis2++;});
assert(dis2===0,'結合なし時はソートボタンが無効化されない: '+dis2);

console.log('\n=== 段階7-9検証完了 ===');
