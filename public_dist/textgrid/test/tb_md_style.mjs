import { toMarkdown, parseMarkdownWithStyles, toTextile, parseTextileWithStyles } from '/home/claude/textgrid/src/index.js';
function assert(c,m){if(!c){console.error('  ✗',m);process.exitCode=1;}else{console.log('  ✓',m);}}

console.log('\n[1] Markdown出力: 太字・斜体・組合せ');
const cols=['A','B','C'];
const data=[['x','y','z']];
const cstyles=[[{bold:true},{italic:true},{bold:true,italic:true}]];
const md=toMarkdown(cols,data,null,cstyles);
console.log(md);
assert(/\| \*\*x\*\* \|/.test(md),'太字 **x**');
assert(/\| \*y\* \|/.test(md),'斜体 *y*');
assert(/\| \*\*\*z\*\*\* \|/.test(md),'太斜体 ***z***');

console.log('\n[2] Markdownパース: 装飾を読み戻す');
const src='| **x** | *y* | ***z*** |\n| --- | --- | --- |\n| a | b | c |';
const p=parseMarkdownWithStyles(src);
console.log('  styles[0]:', JSON.stringify(p.styles[0]));
assert(p.rows[0][0]==='x' && p.styles[0][0].bold===true && !p.styles[0][0].italic,'**x**→x+bold');
assert(p.rows[0][1]==='y' && p.styles[0][1].italic===true && !p.styles[0][1].bold,'*y*→y+italic');
assert(p.rows[0][2]==='z' && p.styles[0][2].bold===true && p.styles[0][2].italic===true,'***z***→z+bold+italic');
assert(p.rows[1][0]==='a' && p.styles[1][0]===null,'装飾なしセル');

console.log('\n[3] Textile下線: 出力と読み戻し');
const txt=toTextile(['見出し'],[['注意']],[{underline:true}],[[{underline:true,bold:true}]]);
console.log(txt);
assert(/\|_\. \+見出し\+ \|/.test(txt),'ヘッダ下線 +見出し+');
assert(/\| \*\+注意\+\* \|/.test(txt),'本文 太字+下線 *+注意+*');
const tp=parseTextileWithStyles(txt);
assert(tp.styles[0][0].underline===true,'下線ヘッダ往復');
assert(tp.styles[1][0].underline===true && tp.styles[1][0].bold===true,'下線+太字 往復');

console.log('\n=== Markdown装飾とTextile下線 検証完了 ===');
