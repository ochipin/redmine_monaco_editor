import { JSDOM } from 'jsdom';
import { initTableBuilder } from '/home/claude/textgrid/src/index.js';
const dom=new JSDOM('<!DOCTYPE html><body><div id="w" style="position:relative"></div></body>',{pretendToBeVisual:true});
const {window}=dom; global.window=window; global.document=window.document; global.Node=window.Node; global.Set=Set;
window.requestAnimationFrame=(cb)=>{cb();return 1;}; window.confirm=()=>true;
const wrapper=document.getElementById('w');
const api=initTableBuilder({wrapper,format:'textile',t:(k,f)=>f,copy:()=>{},showEditor:()=>{}});
function assert(c,m){if(!c){console.error('  ✗',m);process.exitCode=1;}else{console.log('  ✓',m);}}

console.log('\n[1] 自動フォーカス: (0,0)にフォーカス');
api.open();
const focused = document.activeElement;
assert(focused.tagName==='TEXTAREA' && focused.dataset.r==='0' && focused.dataset.c==='0','(0,0)に自動フォーカス');

console.log('\n[2] Undo/Redoボタン初期は両方disabled');
const btns=Array.from(wrapper.querySelectorAll('button'));
const undoBtn=btns.find(b=>b.title==='元に戻す');
const redoBtn=btns.find(b=>b.title==='やり直す');
assert(undoBtn && undoBtn.disabled,'undoボタン: 初期はdisabled');
assert(redoBtn && redoBtn.disabled,'redoボタン: 初期はdisabled');

console.log('\n[3] 行追加 → undoボタンが有効化');
const addBtn=btns.find(b=>b.textContent && b.textContent.includes('行追加'));
const rowsBefore=wrapper.querySelectorAll('.tg-table tr').length;
addBtn.click();
const rowsAfter=wrapper.querySelectorAll('.tg-table tr').length;
assert(rowsAfter===rowsBefore+1,'行が追加された');
assert(!undoBtn.disabled,'追加後はundo有効');
assert(redoBtn.disabled,'追加後はredoまだdisabled');

console.log('\n[4] undoクリック → 1行戻る、redo有効化');
undoBtn.click();
const rowsUndo=wrapper.querySelectorAll('.tg-table tr').length;
assert(rowsUndo===rowsBefore,'undoで元の行数に戻る');
assert(undoBtn.disabled,'undo後はundoがdisabled');
assert(!redoBtn.disabled,'undo後はredoが有効');

console.log('\n[5] redoクリック → 行が復活');
redoBtn.click();
const rowsRedo=wrapper.querySelectorAll('.tg-table tr').length;
assert(rowsRedo===rowsBefore+1,'redoで再度1行追加');
assert(!undoBtn.disabled,'redo後はundo有効');
assert(redoBtn.disabled,'redo後はredoがdisabled');

console.log('\n=== Undo/Redoボタン検証完了 ===');
