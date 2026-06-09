import { JSDOM } from 'jsdom';
import { initTableBuilder } from '/home/claude/textgrid/src/index.js';
const dom=new JSDOM('<!DOCTYPE html><body><div id="w" style="position:relative"></div></body>',{pretendToBeVisual:true});
const {window}=dom; global.window=window; global.document=window.document; global.Node=window.Node; global.Set=Set;
window.requestAnimationFrame=(cb)=>{cb();return 1;};
const wrapper=document.getElementById('w');
let copied=[];
// format=textile のチケットを想定
const api=initTableBuilder({wrapper,format:'textile',t:(k,f)=>f,copy:(txt)=>copied.push(txt),showEditor:()=>{}});
function assert(c,m){if(!c){console.error('  ✗',m);process.exitCode=1;}else{console.log('  ✓',m);}}

api.open();
const ta=wrapper.querySelector('textarea.tg-cell-ta[data-r="0"][data-c="0"]');
ta.value='テスト'; ta.dispatchEvent(new window.Event('input'));
const copyBtn=Array.from(wrapper.querySelectorAll('.tg-toolbtn-primary')).find(b=>b.textContent==='表をコピー');
copied=[]; copyBtn.click();
console.log('[Textileチケットでコピー]');
assert(/\|_\. /.test(copied[0]),'Textile形式（_.ヘッダ）でコピーされる');
assert(!/--- /.test(copied[0]),'Markdown区切り行は無い');
console.log('=== 形式自動判別 検証完了 ===');
