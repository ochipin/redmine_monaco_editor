import { toMarkdown, parseMarkdownWithStyles, toTextile, parseTextileWithStyles } from '/home/claude/textgrid/src/index.js';
function assert(c,m){if(!c){console.error('  ✗',m);process.exitCode=1;}else{console.log('  ✓',m);}}

console.log('\n[1] Markdown: 列単位の揃え出力');
const cols=['左','中','右'];
const data=[['a','b','c']];
const hs=[{align:'left'},{align:'center'},{align:'right'}];
const cs=[[{align:'left'},{align:'center'},{align:'right'}]];
const md=toMarkdown(cols,data,hs,cs);
console.log(md);
assert(/\|:---\|/.test(md),'左揃え :--- 区切り');
assert(/\|:---:\|/.test(md),'中央 :---: 区切り');
assert(/\|---:\|/.test(md),'右 ---: 区切り');

console.log('\n[2] Markdown: パースで列の揃えがすべてのセルに反映');
const p=parseMarkdownWithStyles(md);
assert(p.styles[0][0].align==='left','ヘッダ列0=left');
assert(p.styles[0][1].align==='center','ヘッダ列1=center');
assert(p.styles[0][2].align==='right','ヘッダ列2=right');
assert(p.styles[1][1].align==='center','データ列1=center');

console.log('\n[3] Textile: セル単位の揃え出力');
const tx=toTextile(['見出し'],[['A'],['B']],[{align:'center'}],[[{align:'left'}],[{align:'right',bg:'#fee'}]]);
console.log(tx);
assert(/\|_=\. /.test(tx),'ヘッダ中央 _=.');
assert(/\|<\. A /.test(tx),'左 <.');
assert(/\|>\{background:#fee\}\. B /.test(tx),'右+背景');

console.log('\n[4] Textile: パースでセル単位の揃えが復元');
const tp=parseTextileWithStyles(tx);
assert(tp.styles[0][0].align==='center','ヘッダ中央復元');
assert(tp.styles[1][0].align==='left','左復元');
assert(tp.styles[2][0].align==='right' && tp.styles[2][0].bg==='#fee','右+背景の復元');

console.log('\n=== 揃え検証完了 ===');
