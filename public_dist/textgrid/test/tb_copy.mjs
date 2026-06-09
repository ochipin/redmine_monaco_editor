import { JSDOM } from 'jsdom';
import { initTableBuilder } from '/home/claude/textgrid/src/index.js';
const dom = new JSDOM('<!DOCTYPE html><body><div id="w" style="position:relative"></div></body>', { pretendToBeVisual:true });
const { window } = dom;
global.window=window; global.document=window.document; global.Node=window.Node; global.Set=Set;
window.requestAnimationFrame=(cb)=>{cb();return 1;};
const wrapper=document.getElementById('w');
let copied=[];
const api=initTableBuilder({wrapper,format:'markdown',t:(k,f)=>f,copy:(txt)=>copied.push(txt),showEditor:()=>{}});
function assert(c,m){if(!c){console.error('  ✗',m);process.exitCode=1;}else{console.log('  ✓',m);}}

console.log('\n[1] 新規タブ: コピーボタンが出て、更新ボタンは隠れる');
api.open();
const visible = Array.from(wrapper.querySelectorAll('.tg-toolbtn-primary')).filter(b=>b.style.display!=='none').map(b=>b.textContent);
assert(visible.includes('表をコピー'),'「表をコピー」が表示: '+visible.join(','));
assert(!visible.includes('更新'),'「更新」は隠れている');
assert(!visible.includes('Markdownで挿入') && !visible.includes('Textileで挿入'),'旧挿入ボタンは無い');

console.log('\n[2] セル入力 → コピーボタンでMarkdown形式がcopyに渡る');
const ta=wrapper.querySelector('textarea.tg-cell-ta[data-r="0"][data-c="0"]');
ta.value='SSH設定'; ta.dispatchEvent(new window.Event('input'));
const copyBtn=Array.from(wrapper.querySelectorAll('.tg-toolbtn-primary')).find(b=>b.textContent==='表をコピー');
copied=[]; copyBtn.click();
assert(copied.length===1,'copyコールバックが1回呼ばれる');
assert(/\| SSH設定 /.test(copied[0]),'入力値がコピー内容に含まれる');
assert(/\|---?\|/.test(copied[0]),'Markdown形式（区切り行あり）');

console.log('\n=== コピーボタン 検証完了 ===');
