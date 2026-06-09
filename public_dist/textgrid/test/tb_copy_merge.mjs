import { JSDOM } from 'jsdom';
import { initTableBuilder, parseTextileWithStyles } from '/home/claude/textgrid/src/index.js';
const dom=new JSDOM('<!DOCTYPE html><body><div id="w" style="position:relative"></div></body>',{pretendToBeVisual:true});
const {window}=dom; global.window=window; global.document=window.document; global.Node=window.Node; global.Set=Set;
window.requestAnimationFrame=(cb)=>{cb();return 1;}; window.confirm=()=>true;
class CB { constructor(){this.data={};} setData(t,v){this.data[t]=v;} getData(t){return this.data[t]||'';} }
const wrapper=document.getElementById('w');
const api=initTableBuilder({wrapper,format:'textile',t:(k,f)=>f,copy:()=>{},showEditor:()=>{}});
function assert(c,m){if(!c){console.error('  ✗',m);process.exitCode=1;}else{console.log('  ✓',m);}}

// 結合と装飾を含むTextileを開く
const src='|_. A |_. B |_. C |\n|\\2/2{background:#fee}. *結合* |  |\n|  |  | x |\n|  |  |  |';
api.openForText(src,'textile',()=>({ok:true}),'k1',()=>{});

console.log('\n[1] コーナーセル相当: グリッドにcopyイベントを起こす');
// グリッドDOMにアクセス
const grid=wrapper.querySelector('.tg-grid-host > div') || wrapper.querySelector('.tg-table').parentElement;
// テーブル全体を選択した状態にしたいが、APIが見えないので、textareaフォーカスを使う
// コーナーは「左上のth.tg-corner」、それをクリックすると全選択になるはず。
const corner=wrapper.querySelector('th.tg-corner');
if (corner) {
  corner.click(); // 全選択
}
// その後 copy イベントを発火
const cb=new CB();
const ev=new window.Event('copy',{bubbles:true,cancelable:true});
ev.clipboardData=cb;
// Eventにpreventdefaultを上書きするのが面倒なので、Gridのcontainerに直接dispatch
const gridDiv=wrapper.querySelector('.tg-table').parentElement;
gridDiv.dispatchEvent(ev);
console.log('  クリップボードに入ったtext/plain:');
console.log(cb.data['text/plain']);
const text=cb.data['text/plain']||'';
assert(/\\2\/2/.test(text),'クリップボードに結合構文 \\2/2 が含まれる');
assert(/background:#fee/.test(text),'背景色が含まれる');
assert(/\*結合\*/.test(text),'太字が含まれる');

console.log('\n[2] ペースト: 同じTextileを別Gridに貼る → 結合と装飾が復元');
// 新規API.open()で空の表を開く
api.open();
// (0,0)にフォーカス
const ta00=wrapper.querySelector('textarea.tg-cell-ta[data-r="0"][data-c="0"]');
ta00.focus();
// paste イベント
const cb2=new CB();
cb2.setData('text',text);
const pev=new window.Event('paste',{bubbles:true,cancelable:true});
pev.clipboardData=cb2;
// 最後に作られたgridのDOMに対して
const grids=wrapper.querySelectorAll('.tg-table');
const targetGridDiv=grids[grids.length-1].parentElement;
targetGridDiv.dispatchEvent(pev);
// 貼り付け後、DOMにcolspan/rowspanが反映されてるか
const mergedTd=Array.from(grids[grids.length-1].querySelectorAll('td')).find(td=>td.colSpan>1||td.rowSpan>1);
if (mergedTd) {
  console.log('  結合DOM: colSpan='+mergedTd.colSpan+', rowSpan='+mergedTd.rowSpan);
  assert(mergedTd.colSpan===2 && mergedTd.rowSpan===2,'貼り付け先で結合(2x2)が復元');
} else {
  console.log('  結合DOMが見つからない');
  assert(false,'結合DOMがある');
}

console.log('\n=== コピペで結合・装飾保持 検証完了 ===');
