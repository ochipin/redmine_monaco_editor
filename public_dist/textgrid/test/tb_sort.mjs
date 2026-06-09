import { JSDOM } from 'jsdom';
import { initTableBuilder } from '/home/claude/textgrid/src/index.js';
const dom = new JSDOM('<!DOCTYPE html><body><div id="w" style="position:relative"></div></body>', { pretendToBeVisual:true });
const { window } = dom;
global.window=window; global.document=window.document; global.Node=window.Node; global.Set=Set;
window.requestAnimationFrame=(cb)=>{cb();return 1;}; window.confirm=()=>true;
const wrapper=document.getElementById('w');
const api=initTableBuilder({wrapper,format:'markdown',t:(k,f)=>f,insert:()=>{},showEditor:()=>{}});
function assert(c,m){if(!c){console.error('  ✗',m);process.exitCode=1;}else{console.log('  ✓',m);}}

// 元データ: 状態列が 3,1,2 の順
const src='| 項目 | 並び |\n| --- | --- |\n| A | 3 |\n| B | 1 |\n| C | 2 |';
let saved=null;
api.openForText(src,'markdown',(txt)=>{saved=txt;return {ok:true};},'k1',()=>{});

console.log('\n[1] 2列目(並び)で昇順ソート → 表示はB(1),C(2),A(3)になる');
const sortBtn=wrapper.querySelector('.tg-colhead-sort[data-sortc="1"]');
sortBtn.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true}));
// 表示順を確認
const col0=Array.from(wrapper.querySelectorAll('textarea.tg-cell-ta[data-c="0"]')).map(t=>t.value);
assert(JSON.stringify(col0)===JSON.stringify(['B','C','A']),'表示はソート後 B,C,A: '+col0.join(','));

console.log('\n[2] 更新 → 保存は元順 A,B,C のはず');
const upd=Array.from(wrapper.querySelectorAll('.tg-toolbtn-primary')).find(b=>b.textContent==='更新'&&b.style.display!=='none');
upd.click();
console.log('  保存テキスト:\n'+saved.split('\n').map(l=>'    '+l).join('\n'));
// 元順なら A→B→C の順で出る
const dataLines=saved.split('\n').filter(l=>/^\| [ABC] /.test(l));
const order=dataLines.map(l=>l.match(/^\| ([ABC]) /)[1]);
assert(JSON.stringify(order)===JSON.stringify(['A','B','C']),'保存は元順 A,B,C: '+order.join(','));

console.log('\n[3] 再度開く → 元順のまま（ソート後が焼き付いていない）');
let saved2=null;
api.openForText(saved,'markdown',(txt)=>{saved2=txt;return {ok:true};},'k2',()=>{});
const reopenCol0=Array.from(wrapper.querySelectorAll('textarea.tg-cell-ta[data-c="0"]')).map(t=>t.value);
assert(JSON.stringify(reopenCol0)===JSON.stringify(['A','B','C']),'再オープン時 A,B,C: '+reopenCol0.join(','));

console.log('\n=== ソート一時表示 検証完了 ===');
