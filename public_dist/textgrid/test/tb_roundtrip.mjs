import { JSDOM } from 'jsdom';
import { initTableBuilder, parseMarkdown, parseTsv, toMarkdown } from '/home/claude/textgrid/src/index.js';

const dom = new JSDOM('<!DOCTYPE html><body><div id="w" style="position:relative"></div></body>', { pretendToBeVisual: true });
const { window } = dom;
global.window = window; global.document = window.document; global.Node = window.Node; global.Set = Set;
window.confirm = () => true; // 閉じ確認は常に承認

const wrapper = document.getElementById('w');
let committed = [];
const api = initTableBuilder({
  wrapper, format: 'markdown', t: (k, f) => f,
  insert: () => {}, showEditor: () => {},
});

function q(s) { return wrapper.querySelectorAll(s); }
function assert(c, m) { if (!c) { console.error('  ✗', m); process.exitCode = 1; } else { console.log('  ✓', m); } }

console.log('\n[1] 既存Markdown表をバインドして開く');
const src = '| テスト | テスト名 | ID | 日時 |\n| --- | --- | --- | --- |\n| 1-b | ○○のテスト | 100 | 2026-09-01 |';
let commitOK = null;
api.openForText(src, 'markdown', (newText) => { committed.push(newText); return true; }, 'track-1');
assert(wrapper.querySelector('.tg-panel'), 'パネルが開く');
// グリッドにヘッダとデータが入っているか
const headerLabels = Array.from(q('.tg-colhead-label')).map((e) => e.textContent);
assert(JSON.stringify(headerLabels) === JSON.stringify(['テスト', 'テスト名', 'ID', '日時']), 'ヘッダがパースされる: ' + headerLabels.join(','));
const firstCell = wrapper.querySelector('textarea.tg-cell-ta[data-r="0"][data-c="0"]');
assert(firstCell && firstCell.value === '1-b', '1行目1列目=1-b: ' + (firstCell && firstCell.value));

console.log('\n[2] バインドタブでは「更新」ボタンが出て挿入ボタンは隠れる');
const visibleBtns = Array.from(q('.tg-toolbtn-primary')).filter((b) => b.style.display !== 'none').map((b) => b.textContent);
assert(visibleBtns.includes('更新'), '更新ボタンが表示される');
assert(!visibleBtns.includes('Markdownで挿入'), '挿入ボタンは隠れる');

console.log('\n[3] セルを編集して「更新」→ commit が呼ばれ書き戻しテキストに反映');
firstCell.value = '2-c';
firstCell.dispatchEvent(new window.Event('input'));
const updateBtn = Array.from(q('.tg-toolbtn-primary')).find((b) => b.textContent === '更新');
committed = [];
updateBtn.click();
assert(committed.length === 1, 'commit が1回呼ばれる');
assert(/\| 2-c /.test(committed[0]), '編集値 2-c が書き戻しに含まれる');
assert(/\| テスト \| テスト名 \| ID \| 日時 \|/.test(committed[0]), 'ヘッダが保たれる');
assert(/\|---?\|/.test(committed[0]), 'Markdown区切り行が出る');

console.log('\n[4] 更新後は本文へ戻る（パネル非表示）');
assert(wrapper.querySelector('.tg-panel').style.display === 'none', '更新後パネルが隠れる');

console.log('\n[5] 同じ key で再オープンするとタブを再利用（量産しない）');
api.openForText(src, 'markdown', () => true, 'track-1');
const tabCount1 = q('.tg-tab').length; // 本文 + 表 + (+)
api.openForText(src, 'markdown', () => true, 'track-1');
const tabCount2 = q('.tg-tab').length;
assert(tabCount1 === tabCount2, '同keyでタブが増えない');

console.log('\n[6] Textile表のバインド（_. ヘッダを剥がす）');
const tx = '|_. 名前 |_. 状態 |\n| A | 完了 |\n| B | 対応中 |';
api.openForText(tx, 'textile', (newText) => { committed = [newText]; return true; }, 'track-2');
const txHeaders = Array.from(q('.tg-colhead-label')).map((e) => e.textContent);
assert(JSON.stringify(txHeaders) === JSON.stringify(['名前', '状態']), 'Textileヘッダの_.が剥がれる: ' + txHeaders.join(','));
const txUpdate = Array.from(q('.tg-toolbtn-primary')).find((b) => b.textContent === '更新');
txUpdate.click();
assert(/\|_\. 名前 /.test(committed[0]), '書き戻しがTextile形式（_.付き）');
assert(!/--- /.test(committed[0]), 'Textileに区切り行は無い');

console.log('\n=== 往復テスト完了 ===');
