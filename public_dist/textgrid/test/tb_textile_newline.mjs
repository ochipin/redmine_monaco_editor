import { toTextile, parseTextileWithStyles } from '/home/claude/textgrid/src/index.js';
function assert(c,m){if(!c){console.error('  ✗',m);process.exitCode=1;}else{console.log('  ✓',m);}}

console.log('\n[1] 出力: セル内改行は空白に潰さず改行のまま出る');
const out=toTextile(['項目','状態','担当'],[['s','s','s'],['おちあい\nすぐる','s','s']],[{bg:'#e7e0ff',bold:true},{bg:'#e7e0ff',bold:true},{bg:'#e7e0ff',bold:true}],[[{bg:'#f5e8da',bold:true},null,null],[{bg:'#f5e8da',bold:true},null,null]]);
console.log(out);
assert(/\*おちあい\nすぐる\*/.test(out),'セル内改行が保持される（おちあい\\nすぐる）');
assert(!/\*おちあい すぐる\*/.test(out),'空白には畳まれない');

console.log('\n[2] パース: 改行を含む表行を正しく1セルとして読む');
const src='|_{background:#e7e0ff}. *項目* |_{background:#e7e0ff}. *状態* |_{background:#e7e0ff}. *担当* |\n|{background:#f5e8da}. *s* | s | s |\n|{background:#f5e8da}. *おちあい\nすぐる* | s | s |\n|{background:#f5e8da}. *s* | s | s |';
const p=parseTextileWithStyles(src);
assert(p && p.rows && p.rows.length===4,'4行（ヘッダ+3データ）として解釈: '+(p ? p.rows.length : 'null'));
assert(p.rows[2][0]==='おちあい\nすぐる','セル内改行が値として残る: '+JSON.stringify(p.rows[2][0]));
assert(p.styles[2][0].bg==='#f5e8da' && p.styles[2][0].bold===true,'装飾も保持');

console.log('\n[3] 往復: 出力 → パース → 出力 で同じになる');
const re=toTextile(p.rows[0],p.rows.slice(1),p.styles[0],p.styles.slice(1));
const re2=parseTextileWithStyles(re);
assert(re2.rows[2][0]==='おちあい\nすぐる','再往復で改行保持');

console.log('\n=== Textileセル内改行 検証完了 ===');
