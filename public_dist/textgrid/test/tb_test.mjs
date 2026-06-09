import { JSDOM } from 'jsdom';
import { initTableBuilder, toMarkdown, toTextile } from '/home/claude/textgrid/src/index.js';

const dom = new JSDOM('<!DOCTYPE html><body><div id="wrapper" style="position:relative"></div></body>', {
  pretendToBeVisual: true,
});
const { window } = dom;
// グローバルへ流し込み（モジュールは document/window を参照する）
global.window = window;
global.document = window.document;
global.Node = window.Node;
global.Set = Set;
// textarea.scrollHeight は jsdom で 0 になるので measure が 22 を返す前提でOK

const wrapper = document.getElementById('wrapper');
let copied = [];
let editorShown = 0;

const api = initTableBuilder({
  wrapper,
  format: 'markdown',
  t: (k, f) => f,
  copy: (text) => copied.push(text),
  showEditor: () => { editorShown++; },
});

function q(sel) { return wrapper.querySelectorAll(sel); }
function tabLabels() {
  return Array.from(q('.tg-tab')).map((el) => el.textContent.replace('×', '').trim());
}
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; }
  else { console.log('  ✓', msg); }
}

console.log('\n[1] 初回 open: パネル生成 + 表1タブ');
api.open();
assert(wrapper.querySelector('.tg-panel'), 'パネルが生成される');
assert(wrapper.querySelector('.tg-panel').style.display === 'flex', 'パネルは表示状態');
assert(tabLabels().includes('本文'), '本文タブがある');
assert(tabLabels().includes('表1'), '表1タブがある');
assert(q('.tg-grid').length === 1, 'グリッドが1つ描画される');

console.log('\n[2] 本文タブへ戻る: パネルは隠す（破棄しない）');
api.showBody();
assert(wrapper.querySelector('.tg-panel'), 'パネルは破棄されない');
assert(wrapper.querySelector('.tg-panel').style.display === 'none', 'パネルは非表示');
assert(editorShown === 1, 'showEditor が呼ばれた');

console.log('\n[3] 再度 open: 最後の表タブ（表1）が復元される');
api.open();
assert(wrapper.querySelector('.tg-panel').style.display === 'flex', 'パネル再表示');
const active1 = wrapper.querySelector('.tg-tab.active');
assert(active1 && active1.textContent.includes('表1'), 'アクティブが表1に復元');

console.log('\n[4] + で新規タブ追加（表2）');
const plus = wrapper.querySelector('.tg-tab-add');
plus.click();
assert(tabLabels().includes('表2'), '表2タブが追加される');
const active2 = wrapper.querySelector('.tg-tab.active');
assert(active2 && active2.textContent.includes('表2'), '表2がアクティブ');

console.log('\n[5] タブの × で表2を閉じる → 表1が残る');
const tab2Close = Array.from(q('.tg-tab')).find((el) => el.textContent.includes('表2')).querySelector('.tg-tab-close');
tab2Close.click();
assert(!tabLabels().includes('表2'), '表2が閉じた');
assert(tabLabels().includes('表1'), '表1は残っている');

console.log('\n[6] 最後の表タブ(表1)を閉じる → 本文へ自動で戻る');
editorShown = 0;
const tab1Close = Array.from(q('.tg-tab')).find((el) => el.textContent.includes('表1')).querySelector('.tg-tab-close');
tab1Close.click();
assert(wrapper.querySelector('.tg-panel').style.display === 'none', '全タブ閉鎖でパネルが隠れる');
assert(editorShown === 1, '本文へ戻った（showEditor）');

console.log('\n[7] 全タブ閉鎖後の open: 新規タブを開く');
api.open();
assert(q('.tg-tab-add').length === 1, 'パネル健在');
const active3 = wrapper.querySelector('.tg-tab.active');
assert(active3 && /表\d/.test(active3.textContent), '新しい表タブが開く');

console.log('\n[8] セル編集 → 表をコピー');
const ta = wrapper.querySelector('textarea.tg-cell-ta[data-r="0"][data-c="0"]');
ta.value = 'SSH設定';
ta.dispatchEvent(new window.Event('input'));
const copyBtn = Array.from(q('.tg-toolbtn-primary')).find((b) => b.textContent === '表をコピー');
copied = [];
copyBtn.click();
assert(copied.length === 1, 'copy コールバックが1回呼ばれる');
assert(/\| SSH設定 /.test(copied[0]), '編集値がコピー内容に反映される');
assert(/\|---?\|/.test(copied[0]), '区切り行がある（Markdown）');

console.log('\n[10] destroy で後始末');
api.destroy();
assert(!wrapper.querySelector('.tg-panel'), 'パネルが削除される');

console.log('\n=== テスト完了 ===');
