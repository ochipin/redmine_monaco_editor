import { JSDOM } from 'jsdom';
import { initTableBuilder } from '/home/claude/textgrid/src/index.js';
const dom=new JSDOM('<!DOCTYPE html><body><div id="w" style="position:relative"></div></body>',{pretendToBeVisual:true});
const {window}=dom; global.window=window; global.document=window.document; global.Node=window.Node; global.Set=Set;
window.requestAnimationFrame=(cb)=>{cb();return 1;}; window.confirm=()=>true;
let alerts=[]; window.alert=(m)=>alerts.push(m);
const wrapper=document.getElementById('w');
let editorShown=0;
const api=initTableBuilder({wrapper,format:'markdown',t:(k,f)=>f,copy:()=>{},showEditor:()=>{editorShown++;}});
function assert(c,m){if(!c){console.error('  ✗',m);process.exitCode=1;}else{console.log('  ✓',m);}}

const src='| 項目 |\n| --- |\n| A |';

console.log('\n[1] 競合 → バナー表示・alertは呼ばれない・タブは残る');
api.openForText(src,'markdown',(t)=>({ok:false,reason:'conflict'}),'k1',()=>{});
let upd=()=>Array.from(wrapper.querySelectorAll('.tg-toolbtn-primary')).find(b=>b.textContent==='更新'&&b.style.display!=='none');
alerts=[]; upd().click();
const banner=wrapper.querySelector('.tg-banner-error');
assert(alerts.length===0,'alertは出ない: '+alerts.length);
assert(banner && banner.style.display !== 'none','バナー表示');
assert(/変更されている/.test(banner.textContent),'競合メッセージが入っている');
const tabCount=()=>wrapper.querySelectorAll('.tg-tab').length-2;
assert(tabCount()===1,'タブは残る');

console.log('\n[2] gone → バナー表示・gone文言');
api.openForText(src,'markdown',(t)=>({ok:false,reason:'gone'}),'k2',()=>{});
alerts=[]; upd().click();
const banner2=wrapper.querySelector('.tg-banner-error');
assert(/見つかりません/.test(banner2.textContent),'goneメッセージ: '+banner2.textContent.slice(0,30));

console.log('\n[3] タブ切替でバナーが消える');
// 別のバインドタブをk3で作って切り替え
api.openForText(src,'markdown',(t)=>({ok:true}),'k3',()=>{});
const banner3=wrapper.querySelector('.tg-banner-error');
assert(banner3.style.display==='none','タブ切替でバナーが消える');

console.log('\n[4] 更新成功 → タブ複数あっても本文へ戻る');
// 現在 k1(競合), k2(gone), k3(成功) の3タブ。k3をアクティブにして更新
const tabsBefore=tabCount();
editorShown=0;
upd().click();
assert(editorShown>=1,'showEditorが呼ばれた（本文へ戻った）: '+editorShown);
const panel=wrapper.querySelector('.tg-panel');
assert(panel.style.display==='none','パネルが隠れる（本文表示）');
assert(tabCount()===tabsBefore-1,'更新したタブだけ閉じる（他は残る）: '+tabCount());

console.log('\n=== バナー＆本文復帰 検証完了 ===');
