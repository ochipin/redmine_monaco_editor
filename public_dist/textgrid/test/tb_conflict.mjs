import { JSDOM } from 'jsdom';
import { initTableBuilder } from '/home/claude/textgrid/src/index.js';
const dom = new JSDOM('<!DOCTYPE html><body><div id="w" style="position:relative"></div></body>', { pretendToBeVisual:true });
const { window } = dom;
global.window = window; global.document = window.document; global.Node = window.Node; global.Set = Set;
window.requestAnimationFrame=(cb)=>{cb();return 1;}; window.confirm=()=>true;
let alerts=[]; window.alert=(m)=>alerts.push(m);
const wrapper = document.getElementById('w');
const api = initTableBuilder({ wrapper, format:'markdown', t:(k,f)=>f, insert:()=>{}, showEditor:()=>{} });
function tabCount(){ return wrapper.querySelectorAll('.tg-tab').length - 2; }
function assert(c,m){ if(!c){console.error('  ✗',m);process.exitCode=1;}else{console.log('  ✓',m);} }
const src='| 項目 |\n| --- |\n| A |';

console.log('\n[1] 競合なし → 更新成功・タブ閉じる');
api.openForText(src,'markdown',(t)=>({ok:true}),'k1',()=>{});
let upd=()=>Array.from(wrapper.querySelectorAll('.tg-toolbtn-primary')).find(b=>b.textContent==='更新'&&b.style.display!=='none');
alerts=[]; upd().click();
assert(tabCount()===0,'更新後タブ0: '+tabCount());
assert(alerts.length===0,'警告は出ない');

console.log('\n[2] 競合あり → 警告・タブ残る・本文は書き換えない');
api.openForText(src,'markdown',(t)=>({ok:false,reason:'conflict'}),'k2',()=>{});
alerts=[]; upd().click();
assert(tabCount()===1,'競合時タブは残る: '+tabCount());
assert(alerts.length===0 && wrapper.querySelector('.tg-banner-error') && /変更されている/.test(wrapper.querySelector('.tg-banner-error').textContent),'競合バナーが出る');

console.log('\n[3] 対象消失(gone) → 警告・タブ残る');
api.openForText(src,'markdown',(t)=>({ok:false,reason:'gone'}),'k3',()=>{});
alerts=[]; 
// k3がアクティブなはず
upd().click();
assert(alerts.length===0 && /見つかりません/.test(wrapper.querySelector('.tg-banner-error').textContent),'消失バナーが出る');

console.log('\n[4] 後方互換: commitがtrueを返しても成功扱い');
api.openForText(src,'markdown',(t)=>true,'k4',()=>{});
alerts=[]; const before=tabCount(); upd().click();
assert(tabCount()===before-1,'true返しでも閉じる');

console.log('\n=== 競合検出 検証完了 ===');
