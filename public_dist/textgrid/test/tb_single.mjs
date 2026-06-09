import { JSDOM } from 'jsdom';
import { initTableBuilder } from '/home/claude/textgrid/src/index.js';
const dom = new JSDOM('<!DOCTYPE html><body><div id="w" style="position:relative"></div></body>', { pretendToBeVisual:true });
const { window } = dom;
global.window = window; global.document = window.document; global.Node = window.Node; global.Set = Set;
window.requestAnimationFrame = (cb)=>{cb();return 1;}; window.confirm = ()=>true;
const wrapper = document.getElementById('w');
let closed = [];
const api = initTableBuilder({ wrapper, format:'markdown', t:(k,f)=>f, insert:()=>{}, showEditor:()=>{} });
function tabCount(){ return wrapper.querySelectorAll('.tg-tab').length - 2; } // 本文と+を除く表タブ数
function assert(c,m){ if(!c){console.error('  ✗',m);process.exitCode=1;}else{console.log('  ✓',m);} }

const tA = '| 項目 |\n| --- |\n| A |';
const tB = '| 名前 |\n| --- |\n| B |';

console.log('\n[1] 表A を keyA で開く → タブ1枚');
api.openForText(tA, 'markdown', ()=>true, 'keyA', ()=>closed.push('A'));
assert(tabCount()===1, '表タブ1枚: '+tabCount());

console.log('\n[2] 同じ表A（同じkey）を再度開く → タブは増えない');
api.openForText(tA, 'markdown', ()=>true, 'keyA', ()=>closed.push('A'));
assert(tabCount()===1, 'まだ1枚: '+tabCount());

console.log('\n[3] 別の表B（別key）を開く → タブ2枚（別物は別タブ）');
api.openForText(tB, 'markdown', ()=>true, 'keyB', ()=>closed.push('B'));
assert(tabCount()===2, '2枚: '+tabCount());

console.log('\n[4] 表B を再度開く → 増えない');
api.openForText(tB, 'markdown', ()=>true, 'keyB', ()=>closed.push('B'));
assert(tabCount()===2, 'まだ2枚: '+tabCount());

console.log('\n[5] 更新ボタンでアクティブ(表B)を書き戻し → そのタブが閉じる');
let committedB=false;
api.openForText(tB, 'markdown', (txt)=>{committedB=true;return true;}, 'keyB', ()=>closed.push('B'));
const updateBtn = Array.from(wrapper.querySelectorAll('.tg-toolbtn-primary')).find(b=>b.textContent==='更新' && b.style.display!=='none');
updateBtn.click();
assert(committedB, '更新でcommitが呼ばれた');
assert(tabCount()===1, '更新後タブが1枚に減った: '+tabCount());

console.log('\n[6] 更新後にまた表Bを開ける（古いkeyが残骸化していない）');
api.openForText(tB, 'markdown', ()=>true, 'keyB2', ()=>closed.push('B'));
assert(tabCount()===2, '再オープンできる: '+tabCount());

console.log('\n=== 単一表・更新後クローズ 検証完了 ===');
