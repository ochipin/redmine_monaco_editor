/*!
 * redmine_monaco_editor — Table Builder (表ビルダー)
 * ============================================================
 * Monaco エディタの編集画面に「Excel ライクな表編集 UI」を重ねるモジュール。
 *
 * 設計方針:
 *   - 外部グリッドライブラリに依存しない自作エンジン。全セルを <textarea> で
 *     描画する方式により、IME（日本語入力）が最初の1文字から欠けず、表示と
 *     編集が同一要素なので寸法ズレが起きない。マウスで別セルへ移っても値が
 *     確定する（blur 確定）。
 *   - 本体 JS（monaco_editor.js）からは ESM の動的 import で読み込む。本体側の
 *     コードを汚さず、表まわりの保守をこのファイルに閉じる。
 *   - パネルは破棄せず表示/非表示を切り替える。これにより、本文タブへ戻って
 *     再度表ビルダーボタンを押したとき、編集途中の表が保持されたまま開く。
 *
 * 公開 API（initTableBuilder の戻り値）:
 *   open()         … 表ビルダーボタン押下時の入口（後述のロジックで分岐）
 *   showBody()     … 本文（エディタ）へ戻る（パネルを隠す）
 *   destroy()      … パネルと状態を破棄する
 *
 * タブ仕様:
 *   - タブバーは「本文 | 表1 | 表2 … | +」。
 *   - 「本文」タブ: 常駐・閉じられない。押すとエディタへ戻る（パネルを隠す）。
 *   - 表タブ: 各々が独立した表データ（matrix）を持つ。× で1つ閉じる。
 *   - 表タブを全部閉じたら、自動で本文（エディタ）へ戻る。
 *   - 「+」で新規表タブを追加。
 *
 * 表ビルダーボタン押下時（open）の分岐:
 *   - パネル未生成              → 生成して最初の表タブ（表1）を開く
 *   - パネルあり・表タブが残存   → 最後に開いていた表タブへ戻る
 *   - パネルあり・表タブが空     → 新規表タブを1つ開く
 *
 * 出力:
 *   - 「Markdown で挿入」「Textile で挿入」の両対応。挿入はホスト（本体）から
 *     渡される insert コールバック経由で Monaco エディタへ流し込む。
 */

/* ============================================================
 * 1. 表データモデル（matrix）操作ヘルパー
 *    matrix = {
 *      name,
 *      columns:      [列名...],
 *      data:         [[セル値...], ...],
 *      cellStyles:   [[セルスタイル...], ...] | null,
 *      headerStyles: [列ヘッダスタイル...]    | null,
 *      cellMerges:   [[セル結合情報...], ...] | null,
 *    }
 *    スタイル = { bg?:'#hex', bold?:bool, italic?:bool, underline?:bool,
 *               align?:'left'|'center'|'right' } | null
 *    結合情報 (cellMerges[r][c]):
 *      null                     : 通常セル
 *      { rowSpan, colSpan }     : 結合領域の主セル（左上）。1×1 は持たない。
 *      { mergedBy: { r, c } }   : 主セルへの参照。描画スキップ用。
 *    結合は Textile モードでのみ使う（Markdownでは出力時に無視される）。
 * ============================================================ */

// 空の matrix を生成（既定 3 列 × 3 行）。
function createMatrix(name) {
  return {
    name: name,
    columns: ['項目', '状態', '担当'],
    data: [['', '', ''], ['', '', ''], ['', '', '']],
    cellStyles: null,
    headerStyles: null,
    cellMerges: null,
  };
}

// セル結合情報の取得。
function getCellMerge(sheet, r, c) {
  return (sheet.cellMerges && sheet.cellMerges[r] && sheet.cellMerges[r][c]) || null;
}
// セル結合情報の設定。必要なら配列を遅延生成し、サイズも data に合わせる。
function setCellMerge(sheet, r, c, merge) {
  if (!sheet.cellMerges) {
    sheet.cellMerges = sheet.data.map((row) => row.map(() => null));
  }
  while (sheet.cellMerges.length < sheet.data.length) {
    sheet.cellMerges.push(sheet.columns.map(() => null));
  }
  for (let i = 0; i < sheet.cellMerges.length; i++) {
    while (sheet.cellMerges[i].length < sheet.columns.length) { sheet.cellMerges[i].push(null); }
  }
  sheet.cellMerges[r][c] = merge || null;
}
// 結合の主セル（左上）に到達する。引数のセルが飲み込まれ側なら主セルへ、
// 通常セルや主セルならそのまま。戻りは {r, c}。
function getMergeAnchor(sheet, r, c) {
  const m = getCellMerge(sheet, r, c);
  if (m && m.mergedBy) { return { r: m.mergedBy.r, c: m.mergedBy.c }; }
  return { r, c };
}
// その表に結合が1つでもあるか。
function hasAnyMerge(sheet) {
  if (!sheet.cellMerges) { return false; }
  for (let r = 0; r < sheet.cellMerges.length; r++) {
    const row = sheet.cellMerges[r];
    if (!row) { continue; }
    for (let c = 0; c < row.length; c++) {
      if (row[c]) { return true; }
    }
  }
  return false;
}
// 矩形領域 [r1..r2, c1..c2] を結合する（主セルは r1,c1）。
//   - 結合対象内に既存の結合がある場合は先に解除しておく前提（呼び出し側で対応）
//   - 飲み込まれる側のデータは空文字に、結合情報は mergedBy に変える
//   - データ消失の可能性は呼び出し側で警告して合意を取ること
function applyMerge(sheet, r1, c1, r2, c2) {
  const rowSpan = r2 - r1 + 1;
  const colSpan = c2 - c1 + 1;
  if (rowSpan < 1 || colSpan < 1) { return; }
  if (rowSpan === 1 && colSpan === 1) { return; } // 1×1 は結合と呼ばない
  setCellMerge(sheet, r1, c1, { rowSpan, colSpan });
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      if (r === r1 && c === c1) { continue; }
      sheet.data[r][c] = '';
      setCellMerge(sheet, r, c, { mergedBy: { r: r1, c: c1 } });
    }
  }
}
// 結合を解除する。主セルでも飲み込まれ側でも、対応する矩形領域の結合を外す。
function unapplyMerge(sheet, r, c) {
  const anchor = getMergeAnchor(sheet, r, c);
  const main = getCellMerge(sheet, anchor.r, anchor.c);
  if (!main || !main.rowSpan) { return; } // 通常セル
  const r2 = anchor.r + main.rowSpan - 1;
  const c2 = anchor.c + main.colSpan - 1;
  for (let rr = anchor.r; rr <= r2; rr++) {
    for (let cc = anchor.c; cc <= c2; cc++) {
      setCellMerge(sheet, rr, cc, null);
    }
  }
}

// セルスタイル取得（無ければ null）。
function getCellStyle(sheet, r, c) {
  return (sheet.cellStyles && sheet.cellStyles[r] && sheet.cellStyles[r][c]) || null;
}
// ヘッダスタイル取得（無ければ null）。
function getHeaderStyle(sheet, c) {
  return (sheet.headerStyles && sheet.headerStyles[c]) || null;
}
// セルスタイルを更新（必要なら配列を遅延生成）。style が空オブジェクト相当なら null にする。
function setCellStyle(sheet, r, c, style) {
  if (!sheet.cellStyles) {
    sheet.cellStyles = sheet.data.map((row) => row.map(() => null));
  }
  // 行の長さが足りない場合は揃える（行追加直後など）
  while (sheet.cellStyles.length < sheet.data.length) {
    sheet.cellStyles.push(sheet.columns.map(() => null));
  }
  for (let i = 0; i < sheet.cellStyles.length; i++) {
    while (sheet.cellStyles[i].length < sheet.columns.length) { sheet.cellStyles[i].push(null); }
  }
  sheet.cellStyles[r][c] = normalizeStyle(style);
}
function setHeaderStyle(sheet, c, style) {
  if (!sheet.headerStyles) { sheet.headerStyles = sheet.columns.map(() => null); }
  while (sheet.headerStyles.length < sheet.columns.length) { sheet.headerStyles.push(null); }
  sheet.headerStyles[c] = normalizeStyle(style);
}
// スタイルから空プロパティを除く。全部空なら null を返す。
function normalizeStyle(s) {
  if (!s) { return null; }
  const out = {};
  if (s.bg) { out.bg = s.bg; }
  if (s.bold) { out.bold = true; }
  if (s.italic) { out.italic = true; }
  if (s.underline) { out.underline = true; }
  if (s.align === 'left' || s.align === 'center' || s.align === 'right') { out.align = s.align; }
  return Object.keys(out).length ? out : null;
}

/* ============================================================
 * 2. Markdown / Textile への変換
 * ============================================================ */

// Markdown テーブル出力。
//   - セル内改行は <br> に変換（生改行はテーブルを壊すため）。
//   - パイプ "|" は "\|" にエスケープ。
//   - 装飾は太字・斜体のみ対応（Markdown 標準にない下線・背景色は無視）:
//       太字: | **テキスト** |
//       斜体: | *テキスト* |
//       組合せ: | ***テキスト*** |
//   - 揃え（align）は区切り行で列単位で表現:
//       左 : |:--- |    中央: |:---:|    右: |---:|
//     セル単位の指定は Markdown 標準にないため、列内で揃えがバラついている
//     場合は列の多数決（最頻値）で1つに丸める。
//   - headerStyles / cellStyles は省略可。
function toMarkdown(columns, data, headerStyles, cellStyles) {
  const escText = (s) => (s == null ? '' : String(s))
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
  const wrap = (text, st) => {
    if (!text || !st) { return text; }
    if (st.bold && st.italic) { return '***' + text + '***'; }
    if (st.bold)              { return '**'  + text + '**'; }
    if (st.italic)            { return '*'   + text + '*'; }
    return text;
  };
  // 列ごとの代表 align を決める。
  //   - ヘッダの align も含めて多数決を取る
  //   - 全部 null（揃え指定なし）なら null（区切りは ---）
  const columnAlign = (c) => {
    const votes = { left: 0, center: 0, right: 0 };
    const hst = headerStyles && headerStyles[c];
    if (hst && hst.align) { votes[hst.align]++; }
    if (cellStyles) {
      for (let r = 0; r < cellStyles.length; r++) {
        const st = cellStyles[r] && cellStyles[r][c];
        if (st && st.align) { votes[st.align]++; }
      }
    }
    const total = votes.left + votes.center + votes.right;
    if (total === 0) { return null; }
    if (votes.center >= votes.left && votes.center >= votes.right) { return 'center'; }
    if (votes.right >= votes.left) { return 'right'; }
    return 'left';
  };
  const sepCell = (align) => {
    if (align === 'left')   { return ':---'; }
    if (align === 'center') { return ':---:'; }
    if (align === 'right')  { return '---:'; }
    return '---';
  };

  // ヘッダ行
  let md = '|';
  columns.forEach((c, i) => {
    const st = headerStyles && headerStyles[i];
    md += ' ' + wrap(escText(c), st) + ' |';
  });
  md += '\n';
  // 区切り行（列の代表 align を反映）
  md += '|';
  columns.forEach((_, i) => { md += sepCell(columnAlign(i)) + '|'; });
  md += '\n';
  // データ行
  data.forEach((row, r) => {
    md += '|';
    row.forEach((v, c) => {
      const st = cellStyles && cellStyles[r] && cellStyles[r][c];
      md += ' ' + wrap(escText(v), st) + ' |';
    });
    md += '\n';
  });
  return md;
}

// Textile テーブル出力。
//   - ヘッダ行は各セルを "|_. ラベル" で見出し化（区切り行は無い）。
//   - セル内改行はそのまま改行として出力する。Redmine の Textile プロセッサは
//     表のセル内に生の改行があってもセル区切りと混同せず、<br> 相当に
//     レンダリングする（表ビルダー側で本文に書き戻したテキストを Redmine が
//     表示する流れでは問題なし）。
//   - 装飾は Textile 構文で出力する:
//       背景色 : |{background:#fee}. テキスト |   /  ヘッダなら |_{background:#fee}. ヘッダ |
//       太字   : | *テキスト* |
//       斜体   : | _テキスト_ |
//       下線   : | +テキスト+ |
//     headerStyles / cellStyles は省略可。
// Textile テーブル出力。
//   - ヘッダ行は各セルを "|_. ラベル" で見出し化（区切り行は無い）。
//   - セル内改行はそのまま改行として出力（Redmine では <br> 相当にレンダリングされる）
//   - 装飾は Textile 構文で出力する:
//       背景色 : |{background:#fee}. テキスト |   /  ヘッダなら |_{background:#fee}. ヘッダ |
//       太字   : | *テキスト* |
//       斜体   : | _テキスト_ |
//       下線   : | +テキスト+ |
//   - セル結合は Textile の span 記法で出力する:
//       横結合 : |\N. テキスト |   (N列分)
//       縦結合 : |/N. テキスト |   (N行分)
//       矩形   : |\N/M. テキスト | (N列×M行)
//     飲み込まれた側のセル（mergedBy）は出力しない。
//   - headerStyles / cellStyles / cellMerges は省略可。
function toTextile(columns, data, headerStyles, cellStyles, cellMerges) {
  const escText = (s) => (s == null ? '' : String(s))
    .replace(/\|/g, '&#124;'); // セル区切りと衝突する "|" を実体参照に逃がす（改行はそのまま）
  const wrapAccents = (text, st) => {
    if (!text || !st) { return text; }
    let v = text;
    if (st.underline) { v = '+' + v + '+'; }
    if (st.italic)    { v = '_' + v + '_'; }
    if (st.bold)      { v = '*' + v + '*'; }
    return v;
  };
  // span 記号 "\N/M" を返す（結合がなければ空文字）。
  const spanSym = (merge) => {
    if (!merge || !merge.rowSpan) { return ''; }
    let s = '';
    if (merge.colSpan && merge.colSpan > 1) { s += '\\' + merge.colSpan; }
    if (merge.rowSpan && merge.rowSpan > 1) { s += '/' + merge.rowSpan; }
    return s;
  };
  // セル先頭の属性ブロック「[ヘッダ修飾][span][align][属性].」を作る。
  // 結合がある場合は span 記号も含める。
  const propBlock = (st, isHeader, merge) => {
    const span = spanSym(merge);
    const alignSym =
      st && st.align === 'left'   ? '<' :
      st && st.align === 'center' ? '=' :
      st && st.align === 'right'  ? '>' : '';
    const props = [];
    if (st && st.bg) { props.push('background:' + st.bg); }
    const headerSym = isHeader ? '_' : '';
    if (!headerSym && !alignSym && !props.length && !span) { return ''; }
    const attr = props.length ? '{' + props.join(';') + '}' : '';
    return headerSym + span + alignSym + attr + '. ';
  };

  // ヘッダ行（ヘッダ行は結合対象外と想定）
  let out = '|';
  columns.forEach((c, i) => {
    const st = headerStyles && headerStyles[i];
    out += propBlock(st, true, null) + wrapAccents(escText(c), st) + ' |';
  });
  out += '\n';

  // データ行
  data.forEach((row, r) => {
    out += '|';
    row.forEach((v, c) => {
      const merge = cellMerges && cellMerges[r] && cellMerges[r][c];
      // 飲み込まれた側のセルは出力しない
      if (merge && merge.mergedBy) { return; }
      const st = cellStyles && cellStyles[r] && cellStyles[r][c];
      const pb = propBlock(st, false, merge);
      out += (pb ? pb : ' ') + wrapAccents(escText(v), st) + ' |';
    });
    out += '\n';
  });
  return out;
}

/* ============================================================
 * 3. クリップボード入力のパース（ペースト時）
 * ============================================================ */

// Markdown テーブル → 二次元配列（区切り行 |---| は捨てる）。
function parseMarkdown(text) {
  const r = parseMarkdownWithStyles(text);
  return r ? r.rows : null;
}

// Markdown テーブル → { rows, styles }。
//   - 太字 **xxx** または ***xxx*** / 斜体 *xxx* または ***xxx*** を剥がす
//   - Markdown には背景色・下線の標準構文がないため、対応するスタイルは無い
function parseMarkdownWithStyles(text) {
  const lines = text.split(/\r?\n/).filter((l) => /\|/.test(l));
  if (!lines.length) { return null; }
  const rows = [];
  const styles = [];
  let columnAligns = null; // 区切り行から拾った列ごとの align（'left'/'center'/'right'/null）
  lines.forEach((line) => {
    const compact = line.replace(/\s/g, '');
    if (/^\|?(:?-{2,}:?\|?)+$/.test(compact)) {
      // 区切り行から列ごとの align を抽出する。
      // 各セル: ":---:" → center, ":---" → left, "---:" → right, "---" → null
      let sep = line.trim();
      if (sep.startsWith('|')) { sep = sep.slice(1); }
      if (sep.endsWith('|')) { sep = sep.slice(0, -1); }
      columnAligns = sep.split('|').map((cell) => {
        const c = cell.trim();
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        if (left && right) { return 'center'; }
        if (right) { return 'right'; }
        if (left) { return 'left'; }
        return null;
      });
      return;
    }
    let s = line.trim();
    if (s.startsWith('|')) { s = s.slice(1); }
    if (s.endsWith('|')) { s = s.slice(0, -1); }
    const rawCells = s.split('|').map((x) => x.trim()
      .replace(/\\\|/g, '|')
      .replace(/<br\s*\/?>/gi, '\n'));
    const valueRow = [];
    const styleRow = [];
    rawCells.forEach((cell) => {
      const r = parseCellMarkdown(cell);
      valueRow.push(r.value);
      styleRow.push(r.style);
    });
    rows.push(valueRow);
    styles.push(styleRow);
  });

  // 区切り行から拾った列 align を、全行の対応セルに付与する。
  // ヘッダ（rows[0]）も含めて、その列に align を持たせる。
  if (columnAligns) {
    rows.forEach((row, ri) => {
      const styleRow = styles[ri];
      row.forEach((_, ci) => {
        const a = columnAligns[ci];
        if (!a) { return; }
        const cur = styleRow[ci] || {};
        styleRow[ci] = normalizeStyle(Object.assign({}, cur, { align: a }));
      });
    });
  }
  return rows.length ? { rows, styles } : null;
}

// Markdown 1セルの装飾解析。
//   ***xxx*** → bold+italic
//   **xxx**   → bold
//   *xxx*     → italic
function parseCellMarkdown(raw) {
  let s = raw;
  const style = {};
  // ***xxx*** を最優先で剥がす（**...** や *...* と曖昧にならないように）
  // セル内改行（Markdownでは <br> から復元された "\n"）も内側に含み得るので [\s\S]+ にする。
  if (/^\*\*\*([\s\S]+)\*\*\*$/.test(s)) { style.bold = true; style.italic = true; s = s.slice(3, -3); }
  else if (/^\*\*([\s\S]+)\*\*$/.test(s)) { style.bold = true; s = s.slice(2, -2); }
  else if (/^\*([\s\S]+)\*$/.test(s))     { style.italic = true; s = s.slice(1, -1); }
  return { value: s, style: normalizeStyle(style) };
}

// TSV（Excel / スプレッドシート）→ 二次元配列。
function parseTsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
  if (!lines.length) { return null; }
  return lines.map((l) => l.split('\t'));
}

// Textile テーブル → 二次元配列。
//   - 各行は |a|b|c| 形式。ヘッダセルの "_." 修飾は取り除く。
//   - セル区切りに逃がした実体参照 &#124; は "|" に戻す。
function parseTextile(text) {
  const r = parseTextileWithStyles(text);
  return r ? r.rows : null;
}

// Textile テーブル → { rows, styles, isHeader }。
//   rows     : 二次元配列（文字列のみ。装飾記号は剥がす）
//   styles   : 同形の二次元配列（各要素は {bg?, bold?, italic?} | null）
//   isHeader : 行が「ヘッダ行」か（その行のすべてのセルが _. または _{...}. か）
// セル冒頭の "_."   → ヘッダセル
//        "_{...}." → ヘッダセル＋スタイル
//        "{...}."  → スタイル
// 本文の *xxx* は太字、_xxx_ は斜体として剥がして styles に反映する。
function parseTextileWithStyles(text) {
  // Textile の表行は基本「| ... |」で1行に収まるが、セル内に改行があると
  // 次の行へまたがる。例:
  //   |{background:#fee}. *おちあい
  //   すぐる* | s | s |
  // ここでは「| で始まり | で終わる」を完全な表行とみなし、終端 | が無ければ
  // 次の行と連結して再判定する（連結後の改行はそのまま残してセル内改行に
  // なるようにする）。
  const rawLines = text.split(/\r?\n/);
  const logicalLines = [];
  let buf = null;
  for (let i = 0; i < rawLines.length; i++) {
    const ln = rawLines[i];
    const trimmed = ln.trim();
    if (buf != null) {
      // 継続中: 改行＋次行をそのまま連結
      buf += '\n' + ln;
      if (trimmed.endsWith('|')) {
        logicalLines.push(buf);
        buf = null;
      }
      continue;
    }
    // 新規行
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length >= 2) {
      // 完結した表行
      logicalLines.push(ln);
    } else if (trimmed.startsWith('|')) {
      // 不完全な表行 → 次行と連結
      buf = ln;
    } else {
      // 表行ではない
    }
  }
  // バッファが残っていれば不完全だが捨てる（表として成立しない）
  if (!logicalLines.length) { return null; }

  const lines = logicalLines.filter((l) => /\|/.test(l));
  if (!lines.length) { return null; }
  // セルを「列位置」に正しくマッピングする。span（結合）がある場合は次のセルが
  // 右にずれる。また、上の行で縦結合がある列は今行ではスキップして空セルとして
  // 飲み込まれ扱いにする。最終的に rows/styles/merges を「正規化された二次元
  // 配列」として返す。
  // 各行を一旦パース結果の列に展開する作業用配列を作る。
  const parsedRows = [];   // 各要素は { cells: [{value, style, isHeader, span}], isHeader }
  lines.forEach((line) => {
    const compact = line.replace(/\s/g, '');
    if (/^\|?(:?-{2,}:?\|?)+$/.test(compact)) { return; }
    let s = line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (s.startsWith('|')) { s = s.slice(1); }
    if (s.endsWith('|')) { s = s.slice(0, -1); }
    const cells = s.split('|').map(parseCellTextile);
    const isH = cells.length > 0 && cells.every((c) => c.isHeader);
    parsedRows.push({ cells, isHeader: isH });
  });

  if (!parsedRows.length) { return null; }

  // 列数を先に確定する（最初の行のセル数を基準に、span を考慮して列数を推定）。
  // ヘッダ行が結合を持たない前提なら、ヘッダ行のセル数がそのまま列数。
  // それ以外でも、各行の span を含めた最大列数を取って決める。
  let colCount = 0;
  parsedRows.forEach((pr) => {
    let cc = 0;
    pr.cells.forEach((c) => { cc += (c.span && c.span.colSpan) ? c.span.colSpan : 1; });
    if (cc > colCount) { colCount = cc; }
  });

  const rows = [];
  const styles = [];
  const merges = [];
  const isHeader = [];

  // 「縦結合がここから何行残っているか」を列ごとに保持
  const rowSpanRemain = new Array(colCount).fill(0);
  // 飲み込まれ側の mergedBy 情報を作るため、対応する主セルの (r, c) を覚える
  const rowSpanAnchor = new Array(colCount).fill(null);

  parsedRows.forEach((pr, ri) => {
    const valueRow = new Array(colCount).fill('');
    const styleRow = new Array(colCount).fill(null);
    const mergeRow = new Array(colCount).fill(null);
    let cellIdx = 0;
    let c = 0;
    while (c < colCount) {
      // 上行から縦結合で飲み込まれている列は、現在行ではセルを置かず mergedBy のみ。
      if (rowSpanRemain[c] > 0) {
        mergeRow[c] = { mergedBy: rowSpanAnchor[c] };
        valueRow[c] = '';
        styleRow[c] = null;
        rowSpanRemain[c]--;
        c++;
        continue;
      }
      const cell = pr.cells[cellIdx];
      if (!cell) { break; }
      cellIdx++;
      const colSpan = cell.span && cell.span.colSpan ? cell.span.colSpan : 1;
      const rowSpan = cell.span && cell.span.rowSpan ? cell.span.rowSpan : 1;
      // 主セル
      valueRow[c] = cell.value;
      styleRow[c] = cell.style;
      if (colSpan > 1 || rowSpan > 1) {
        mergeRow[c] = { rowSpan, colSpan };
        // 横方向: c+1 .. c+colSpan-1 を mergedBy で埋める（valueは空）
        for (let cc = 1; cc < colSpan; cc++) {
          if (c + cc < colCount) {
            mergeRow[c + cc] = { mergedBy: { r: ri, c: c } };
            valueRow[c + cc] = '';
            styleRow[c + cc] = null;
          }
        }
        // 縦方向: 後続の rowSpan-1 行で c..c+colSpan-1 列を飲み込ませる
        if (rowSpan > 1) {
          for (let cc = 0; cc < colSpan; cc++) {
            if (c + cc < colCount) {
              rowSpanRemain[c + cc] = rowSpan - 1;
              rowSpanAnchor[c + cc] = { r: ri, c: c };
            }
          }
        }
      }
      c += colSpan;
    }
    rows.push(valueRow);
    styles.push(styleRow);
    merges.push(mergeRow);
    isHeader.push(pr.isHeader);
  });
  return rows.length ? { rows, styles, isHeader, merges } : null;
}

// 1つの Textile セル文字列をパースする。
//   入力例: "_{background:#fee}. *重要* "
//   出力  : { value:'重要', style:{bg:'#fee',bold:true}, isHeader:true, span:{colSpan,rowSpan}|null }
function parseCellTextile(raw) {
  let s = raw;
  // 先頭の半角空白・タブだけ削る（改行は維持してセル内改行を保つ）
  s = s.replace(/^[ \t]+/, '');
  let isHeader = false;
  // ヘッダ修飾 "_"（次が "."、"{"、span 記号 "\\"/"/"、align "<"/"="/">" の場合のみ剥がす）。
  const headerMatch = /^_([.{<=>\\/])/.exec(s);
  if (headerMatch) {
    isHeader = true;
    s = s.slice(1);
  }
  const style = {};
  // span 記号（横結合 "\N"、縦結合 "/N"、矩形 "\N/M"）。
  // どちらか一方だけ、または両方を順に拾う（順序はヘッダ修飾の直後）。
  let colSpan = 1, rowSpan = 1;
  const colSpanMatch = /^\\(\d+)/.exec(s);
  if (colSpanMatch) { colSpan = parseInt(colSpanMatch[1], 10); s = s.slice(colSpanMatch[0].length); }
  const rowSpanMatch = /^\/(\d+)/.exec(s);
  if (rowSpanMatch) { rowSpan = parseInt(rowSpanMatch[1], 10); s = s.slice(rowSpanMatch[0].length); }
  const span = (colSpan > 1 || rowSpan > 1) ? { colSpan, rowSpan } : null;
  // align 記号（<: 左 / =: 中央 / >: 右）
  const alignMatch = /^([<=>])/.exec(s);
  if (alignMatch) {
    const m = alignMatch[1];
    if (m === '<') { style.align = 'left'; }
    if (m === '=') { style.align = 'center'; }
    if (m === '>') { style.align = 'right'; }
    s = s.slice(1);
  }
  // 属性ブロック "{...}."
  const propMatch = /^\{([^}]*)\}\./.exec(s);
  if (propMatch) {
    parseTextileProps(propMatch[1], style);
    s = s.slice(propMatch[0].length);
  } else if ((isHeader || alignMatch || span) && s.startsWith('.')) {
    // "_.", "<.", "=.", ">.", "\2.", "/2." のように装飾なしのケース
    s = s.slice(1);
  }
  // 前後の空白・タブだけ取り除く（改行はセル内改行として保持する）
  s = s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  // *...* (太字) と _..._ (斜体) と +...+ (下線) を剥がす。
  for (let i = 0; i < 3; i++) {
    if (/^\*([\s\S]+)\*$/.test(s)) { style.bold = true; s = s.slice(1, -1); continue; }
    if (/^_([\s\S]+)_$/.test(s))   { style.italic = true; s = s.slice(1, -1); continue; }
    if (/^\+([\s\S]+)\+$/.test(s)) { style.underline = true; s = s.slice(1, -1); continue; }
    break;
  }
  s = s.replace(/&#124;/g, '|');
  return { value: s, style: normalizeStyle(style), isHeader, span };
}

// "background:#fee; color:#c00" のようなプロパティ文字列を style オブジェクトへ。
// 現状は background のみ採用。
function parseTextileProps(propStr, style) {
  propStr.split(';').forEach((kv) => {
    const m = /^\s*([a-zA-Z\-]+)\s*:\s*(.+?)\s*$/.exec(kv);
    if (!m) { return; }
    const key = m[1].toLowerCase();
    const val = m[2];
    if (key === 'background' || key === 'background-color') { style.bg = val; }
  });
}

/* ============================================================
 * 5. 1つの表（タブ）を描画・編集する Grid クラス
 *    各表タブが独立した Grid インスタンスを持つ。
 * ============================================================ */
class TableGrid {
  // host    : この表を描画する DOM コンテナ
  // matrix  : 表データモデル（参照を保持し、編集は直接書き換える）
  constructor(host, matrix) {
    this.host = host;
    this.sheet = matrix;
    this.sel = { r: 0, c: 0, r2: 0, c2: 0 }; // r,c=アクティブ / r2,c2=範囲の他端
    this.selMode = 'cell';   // 'cell' | 'row' | 'col'
    this.dragging = false;
    this.dragMaybe = null;   // セルドラッグ起点候補 { r, c, started }
    this.lastHeadClick = null;
    this.sortState = null;   // { c, dir:'asc'|'desc' }
    this.originalOrder = null;
    this.colMove = null;
    this.rowMove = null;
    this.colWidths = {};
    this.colResize = null;
    this._pasting = false;
    this.onChange = null; // 編集が起きたときに呼ばれるフック（バインドタブのdirty検知用）

    // Undo / Redo 用の履歴スタック（スナップショット方式）
    // 装飾・揃え・行列追加削除・結合解除・ペーストの直前に pushHistory() で
    // 現在の matrix のディープコピーを undoStack に積む。
    // undo() で undoStack から取り出して redoStack に積みつつ、取り出した
    // スナップショットを sheet に適用する。
    // セル値の文字入力編集（textareaタイプ）は対象外。textarea自身の
    // ブラウザ既定 undo に任せる。
    this.undoStack = [];
    this.redoStack = [];
    this.UNDO_LIMIT = 50;

    this.gridDiv = document.createElement('div');
    this.gridDiv.className = 'tg-grid';
    this.gridDiv.tabIndex = 0;
    this.host.appendChild(this.gridDiv);

    this._bindGlobalHandlers();
    this.render();
  }

  // ---- 履歴: matrix のディープコピーを返す ----
  _snapshot() {
    return {
      columns: this.sheet.columns.slice(),
      data: this.sheet.data.map((row) => row.slice()),
      cellStyles: this.sheet.cellStyles
        ? this.sheet.cellStyles.map((row) => row.map((s) => (s ? Object.assign({}, s) : null)))
        : null,
      headerStyles: this.sheet.headerStyles
        ? this.sheet.headerStyles.map((s) => (s ? Object.assign({}, s) : null))
        : null,
      cellMerges: this.sheet.cellMerges
        ? this.sheet.cellMerges.map((row) => row.map((m) => (m ? (m.mergedBy ? { mergedBy: { r: m.mergedBy.r, c: m.mergedBy.c } } : { rowSpan: m.rowSpan, colSpan: m.colSpan }) : null)))
        : null,
    };
  }

  // ---- 履歴: 現状のスナップショットを undoStack に積む ----
  // 操作の「直前」に呼ぶこと。redoStack はクリアされる（新しい分岐が発生したため）。
  pushHistory() {
    this.undoStack.push(this._snapshot());
    if (this.undoStack.length > this.UNDO_LIMIT) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  // ---- 履歴: undo / redo ----
  // 戻り値: true = 実行した / false = スタックが空
  undo() {
    if (!this.undoStack.length) { return false; }
    const snap = this.undoStack.pop();
    this.redoStack.push(this._snapshot());
    this._applySnapshot(snap);
    return true;
  }
  redo() {
    if (!this.redoStack.length) { return false; }
    const snap = this.redoStack.pop();
    this.undoStack.push(this._snapshot());
    this._applySnapshot(snap);
    return true;
  }

  // スナップショットを sheet に書き戻す。
  _applySnapshot(snap) {
    this.sheet.columns = snap.columns.slice();
    this.sheet.data = snap.data.map((row) => row.slice());
    this.sheet.cellStyles = snap.cellStyles
      ? snap.cellStyles.map((row) => row.map((s) => (s ? Object.assign({}, s) : null)))
      : null;
    this.sheet.headerStyles = snap.headerStyles
      ? snap.headerStyles.map((s) => (s ? Object.assign({}, s) : null))
      : null;
    this.sheet.cellMerges = snap.cellMerges
      ? snap.cellMerges.map((row) => row.map((m) => (m ? (m.mergedBy ? { mergedBy: { r: m.mergedBy.r, c: m.mergedBy.c } } : { rowSpan: m.rowSpan, colSpan: m.colSpan }) : null)))
      : null;
    // 選択が範囲外になっていれば(0,0)に戻す
    const rmax = this.sheet.data.length - 1, cmax = this.sheet.columns.length - 1;
    if (this.sel.r > rmax || this.sel.c > cmax || this.sel.r < 0 || this.sel.c < 0) {
      this.sel = { r: 0, c: 0, r2: 0, c2: 0 };
      this.selMode = 'cell';
    }
    this.sortState = null;
    this.originalOrder = null;
    this.render();
    this._fireChange();
  }

  // ---- 範囲計算ヘルパー ----
  selBounds() {
    return {
      r1: Math.min(this.sel.r, this.sel.r2), rr: Math.max(this.sel.r, this.sel.r2),
      c1: Math.min(this.sel.c, this.sel.c2), cc: Math.max(this.sel.c, this.sel.c2),
    };
  }
  isRange() { return this.sel.r !== this.sel.r2 || this.sel.c !== this.sel.c2; }

  // ============================================================
  // 描画
  // ============================================================
  render() {
    const sheet = this.sheet;
    if (this.sel.r2 === undefined || this.sel.c2 === undefined) {
      this.sel.r2 = this.sel.r; this.sel.c2 = this.sel.c;
    }
    const t = document.createElement('table');
    t.className = 'tg-table';

    // ヘッダ行（コーナー + 列ヘッダ）
    const thead = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'tg-corner';
    thead.appendChild(corner);
    sheet.columns.forEach((name, c) => {
      const th = document.createElement('th');
      th.dataset.c = c; th.className = 'tg-colhead';
      const inner = document.createElement('div');
      inner.className = 'tg-colhead-inner';
      const handle = document.createElement('span');
      handle.className = 'tg-colhead-handle'; handle.dataset.handlec = c;
      // 結合があるとソート・行/列移動はデータ整合性を壊す（並べ替えで
      // 結合の主セルと飲み込まれ側の位置関係が崩れる）。結合あり時は
      // 操作UIを無効化（クリック不可・グレーアウト）する。
      const mergedTable = hasAnyMerge(this.sheet);
      handle.textContent = '⠿'; handle.title = mergedTable ? '列移動は結合がある間は使えません' : '列を移動';
      if (mergedTable) { handle.classList.add('tg-disabled'); }
      inner.appendChild(handle);
      const label = document.createElement('span');
      label.className = 'tg-colhead-label'; label.textContent = name;
      inner.appendChild(label);
      const sortBtn = document.createElement('span');
      sortBtn.className = 'tg-colhead-sort'; sortBtn.dataset.sortc = c;
      sortBtn.textContent = (this.sortState && this.sortState.c === c)
        ? (this.sortState.dir === 'asc' ? '▲' : '▼') : '⇅';
      // ソートは表示上の一時的な並べ替え（保存時は元の行順で書き戻す）。
      sortBtn.title = mergedTable
        ? '並べ替えは結合がある間は使えません'
        : '並べ替え（表示のみ・保存は元の順序）';
      if (mergedTable) { sortBtn.classList.add('tg-disabled'); }
      if (this.sortState && this.sortState.c === c) { sortBtn.classList.add('active'); }
      inner.appendChild(sortBtn);
      th.appendChild(inner);
      // ヘッダのスタイル反映（背景色・太字・斜体）。Textileモード時のみ意味を持つ。
      const hst = getHeaderStyle(this.sheet, c);
      if (hst) {
        // 背景色はCSS変数で指定する。インラインで backgroundColor を直接
        // 設定すると選択ハイライトのCSSクラスより優先されてしまい、選択が
        // 見えなくなる。CSS変数経由なら通常時は装飾色、選択時はクラス側の
        // background-color が効く（詳細度で勝つ）。
        if (hst.bg)     { th.style.setProperty('--tg-bg', hst.bg); }
        if (hst.bold)   { label.style.fontWeight = 'bold'; }
        if (hst.italic) { label.style.fontStyle = 'italic'; }
        if (hst.underline) { label.style.textDecoration = 'underline'; }
        if (hst.align) { label.style.textAlign = hst.align; th.style.textAlign = hst.align; }
      }
      if (this.colWidths[c]) { th.style.width = this.colWidths[c] + 'px'; }
      const resize = document.createElement('span');
      resize.className = 'tg-colhead-resize'; resize.dataset.resizec = c;
      th.appendChild(resize);
      if (this.selMode === 'col') {
        const lo = Math.min(this.sel.c, this.sel.c2), hi = Math.max(this.sel.c, this.sel.c2);
        if (c >= lo && c <= hi) { th.classList.add('tg-hsel'); }
      }
      if (this.colMove && this.colMove.from === c) { th.classList.add('tg-colmove-src'); }
      thead.appendChild(th);
    });
    t.appendChild(thead);

    // データ行（行番号セル + データセル）
    sheet.data.forEach((row, r) => {
      const tr = document.createElement('tr');
      const rh = document.createElement('td');
      rh.className = 'tg-rowhead'; rh.dataset.r = r;
      const rinner = document.createElement('div');
      rinner.className = 'tg-rowhead-inner';
      const rhandle = document.createElement('span');
      rhandle.className = 'tg-rowhead-handle'; rhandle.dataset.handler = r;
      rhandle.textContent = '⠿';
      // 結合がある間は行移動でデータ整合性が壊れるので無効化。
      const mergedForRow = hasAnyMerge(this.sheet);
      rhandle.title = mergedForRow ? '行移動は結合がある間は使えません' : '行を移動';
      if (mergedForRow) { rhandle.classList.add('tg-disabled'); }
      rinner.appendChild(rhandle);
      const rnum = document.createElement('span');
      rnum.className = 'tg-rowhead-num'; rnum.textContent = (r + 1);
      rinner.appendChild(rnum);
      rh.appendChild(rinner);
      if (this.selMode === 'row') {
        const lo = Math.min(this.sel.r, this.sel.r2), hi = Math.max(this.sel.r, this.sel.r2);
        if (r >= lo && r <= hi) { rh.classList.add('tg-hsel'); }
      }
      if (this.rowMove && this.rowMove.from === r) { rh.classList.add('tg-rowmove-src'); }
      tr.appendChild(rh);

      row.forEach((val, c) => {
        // 結合: 飲み込まれた側のセルはDOMを作らずスキップ。主セルだけが描画される。
        const merge = getCellMerge(this.sheet, r, c);
        if (merge && merge.mergedBy) { return; }
        const td = document.createElement('td');
        td.dataset.r = r; td.dataset.c = c;
        // 主セルなら rowspan/colspan を設定
        if (merge && merge.rowSpan) {
          if (merge.colSpan > 1) { td.colSpan = merge.colSpan; }
          if (merge.rowSpan > 1) { td.rowSpan = merge.rowSpan; }
          // 結合範囲が複数列にまたがる場合、table-layout:auto のままだと
          // 結合行のレイアウトが他行と独立して計算され、結合セルの幅が
          // 1列分しか取れなくなる（編集時に textarea のフォーカス枠が
          // 結合幅の一部しか覆わずズレて見える原因）。結合される列の幅を
          // 合算して min-width に明示し、結合セルが正しい幅を保つようにする。
          if (merge.colSpan > 1) {
            let totalW = 0;
            for (let cc = 0; cc < merge.colSpan; cc++) {
              const w = this.colWidths[c + cc];
              totalW += (w ? w : 120); // 既定幅は 120px（CSSの min-width と揃える）
            }
            td.style.minWidth = totalW + 'px';
          }
        }
        const ta = document.createElement('textarea');
        ta.className = 'tg-cell-ta'; ta.rows = 1; ta.value = val;
        ta.dataset.r = r; ta.dataset.c = c;
        td.appendChild(ta);
        // セルのスタイル（Textile モード時のみ意味を持つが、描画は常時反映）
        const st = getCellStyle(this.sheet, r, c);
        if (st) {
          // 背景色はCSS変数で指定（選択ハイライトを潰さないため）。
          if (st.bg)     { td.style.setProperty('--tg-bg', st.bg); }
          if (st.bold)   { ta.style.fontWeight = 'bold'; }
          if (st.italic) { ta.style.fontStyle = 'italic'; }
          if (st.underline) { ta.style.textDecoration = 'underline'; }
          if (st.align) { ta.style.textAlign = st.align; }
        }
        if (this.selMode === 'row') {
          const lo = Math.min(this.sel.r, this.sel.r2), hi = Math.max(this.sel.r, this.sel.r2);
          if (r >= lo && r <= hi) { td.classList.add('tg-rowselected'); }
        }
        if (this.selMode === 'col') {
          const lo = Math.min(this.sel.c, this.sel.c2), hi = Math.max(this.sel.c, this.sel.c2);
          if (c >= lo && c <= hi) { td.classList.add('tg-rowselected'); }
        }
        if (this.selMode === 'cell' && this.isRange()) {
          const b = this.selBounds();
          if (r >= b.r1 && r <= b.rr && c >= b.c1 && c <= b.cc) { td.classList.add('tg-rowselected'); }
        }
        if (this.selMode === 'cell' && !this.isRange() && r === this.sel.r && c === this.sel.c) {
          td.classList.add('tg-selected');
        }
        if (this.colMove && this.colMove.from === c) { td.classList.add('tg-colmove-src'); }
        if (this.rowMove && this.rowMove.from === r) { td.classList.add('tg-rowmove-src'); }
        tr.appendChild(td);
      });
      t.appendChild(tr);
    });

    this.gridDiv.innerHTML = '';
    this.gridDiv.appendChild(t);

    // 各 textarea にイベントを配線
    const self = this;
    this.gridDiv.querySelectorAll('textarea.tg-cell-ta').forEach((ta) => {
      ta.addEventListener('input', (e) => self.onCellInput(e));
      ta.addEventListener('keydown', (e) => self.onCellKeydown(e));
      ta.addEventListener('focus', (e) => self.onCellFocus(e));
    });
    this.equalizeRows();

    // 単一セル選択ならフォーカスを当てる
    if (this.selMode === 'cell' && !this.isRange()) {
      const active = this.gridDiv.querySelector(
        'textarea.tg-cell-ta[data-r="' + this.sel.r + '"][data-c="' + this.sel.c + '"]');
      if (active && document.activeElement !== active) {
        active.focus();
        const len = active.value.length;
        active.selectionStart = active.selectionEnd = len;
      }
    }
  }

  // ============================================================
  // セル入力・フォーカス・キー操作
  // ============================================================
  // 編集（データ書き換え）が起きたことを通知する。バインドタブの dirty 検知用。
  _fireChange() { if (typeof this.onChange === 'function') { this.onChange(); } }

  onCellInput(e) {
    const ta = e.target;
    const r = parseInt(ta.dataset.r, 10), c = parseInt(ta.dataset.c, 10);
    this.sheet.data[r][c] = ta.value;
    this.equalizeRows();
    this._fireChange();
  }

  onCellFocus(e) {
    const ta = e.target;
    // 右クリック直後のフォーカス（contextmenu イベントを開くために発生）の
    // 場合は、範囲選択を維持して何もしない。これがないと、範囲内のセルを
    // 右クリックした瞬間に範囲が単一セルへ潰れ、メニューから装飾を適用しても
    // そのセル1つにしか効かなくなる。
    if (this._suppressFocusReselect) { return; }
    // 直前が「単一セルでない選択」（行/列選択 または セル範囲選択）だったか。
    // これに該当する場合はフォーカスで選択解除し、単一セル編集へ移る。
    const wasMulti = (this.selMode !== 'cell') || this.isRange();
    this.sel = { r: parseInt(ta.dataset.r, 10), c: parseInt(ta.dataset.c, 10) };
    this.sel.r2 = this.sel.r; this.sel.c2 = this.sel.c; this.selMode = 'cell';
    if (wasMulti) { this.render(); return; }
    // 通常のセル間移動: 再描画せず class だけ付け替え（フォーカス維持）
    this.gridDiv.querySelectorAll('td.tg-selected, td.tg-rowselected')
      .forEach((td) => td.classList.remove('tg-selected', 'tg-rowselected'));
    const td = ta.closest('td'); if (td) { td.classList.add('tg-selected'); }
  }

  onCellKeydown(e) {
    if (e.isComposing || e.keyCode === 229) { return; } // IME変換中は無視
    const ta = e.target;
    switch (e.key) {
      case 'Enter':
        if (e.shiftKey || e.altKey) { setTimeout(() => this.equalizeRows(), 0); return; }
        e.preventDefault(); this.move(1, 0); break;
      case 'Tab':
        e.preventDefault(); this.move(0, e.shiftKey ? -1 : 1); break;
      case 'ArrowUp':
        if (ta.selectionStart === 0) { e.preventDefault(); this.move(-1, 0); } break;
      case 'ArrowDown':
        if (ta.selectionStart === ta.value.length) { e.preventDefault(); this.move(1, 0); } break;
      case 'Escape':
        e.preventDefault(); ta.blur(); break;
      default: break;
    }
  }

  measure(ta) {
    ta.style.height = 'auto';
    return Math.max(ta.scrollHeight, 22);
  }

  // 各行の高さを「その行で一番高いセル」に揃える（短いセルが浮かないように）。
  // 縦結合 (rowspan > 1) の主セルは「結合される複数行の合計高さ」を取る必要が
  // あるため、通常の行ごとの揃えを行った後、結合主のテキストエリアにだけ
  // 合計高さを設定する追加パスを走らせる。
  equalizeRows() {
    const rows = this.gridDiv.querySelectorAll('table.tg-table tr');
    // 1. 各行の textarea を「自然な高さ」に戻して測定 → 最大値で揃える。
    //    ただし、rowspan>1 の主セルは合算高さに後で書き直すため、ここでは
    //    一旦行内の他セルと同じ最大値を当てておく（次のパスで上書きする）。
    const rowMaxHeights = []; // 各 <tr> の通常セル最大高さを記録
    rows.forEach((tr, trIdx) => {
      const tas = tr.querySelectorAll('textarea.tg-cell-ta');
      if (!tas.length) { rowMaxHeights.push(22); return; }
      let max = 22;
      tas.forEach((ta) => {
        const td = ta.parentElement;
        // rowspan>1 の主セルは合計高さ計算で扱うので、ここでは自然高さだけ測る
        if (td && td.rowSpan && td.rowSpan > 1) {
          this.measure(ta); // height を 'auto' に戻すだけ（記録はしない）
          return;
        }
        const h = this.measure(ta);
        if (h > max) { max = h; }
      });
      tas.forEach((ta) => {
        const td = ta.parentElement;
        if (td && td.rowSpan && td.rowSpan > 1) { return; } // 後で個別設定
        ta.style.height = max + 'px';
      });
      rowMaxHeights.push(max);
    });

    // 2. 縦結合の主セルに「結合される行の合計高さ」を設定。
    //    rowMaxHeights は <tr> 単位なので、ヘッダ行も含む。
    //    textarea が属する <tr> から数えて rowSpan 行分の合計を取る。
    const trList = Array.from(rows);
    trList.forEach((tr, trIdx) => {
      tr.querySelectorAll('textarea.tg-cell-ta').forEach((ta) => {
        const td = ta.parentElement;
        if (!td || !td.rowSpan || td.rowSpan <= 1) { return; }
        let total = 0;
        for (let i = 0; i < td.rowSpan; i++) {
          if (trIdx + i < rowMaxHeights.length) { total += rowMaxHeights[trIdx + i]; }
        }
        // 行間の border 分を足す（border-collapse: collapse なので 1px×(rowSpan-1)）
        total += (td.rowSpan - 1);
        // ただし、結合主自身の textarea の自然高さがもっと大きい場合はそちらに合わせる
        const natural = this.measure(ta);
        ta.style.height = Math.max(total, natural) + 'px';
      });
    });
  }

  // カーソル移動（dr,dc 方向）。最終行で下方向なら空行を追加。
  move(dr, dc) {
    let nr = this.sel.r + dr, nc = this.sel.c + dc;
    if (dr > 0 && nr >= this.sheet.data.length) {
      this.sheet.data.push(this.sheet.columns.map(() => ''));
      if (this.sheet.cellStyles) { this.sheet.cellStyles.push(this.sheet.columns.map(() => null)); }
      if (this.sheet.cellMerges) { this.sheet.cellMerges.push(this.sheet.columns.map(() => null)); }
      nr = this.sheet.data.length - 1;
    }
    if (nr < 0) { nr = 0; }
    if (nr >= this.sheet.data.length) { nr = this.sheet.data.length - 1; }
    if (nc < 0) { nc = 0; }
    if (nc >= this.sheet.columns.length) { nc = this.sheet.columns.length - 1; }
    this.sel = { r: nr, c: nc, r2: nr, c2: nc };
    this.render();
  }

  // ============================================================
  // マウス操作（選択・ドラッグ・リサイズ・移動）
  // ============================================================
  _bindGlobalHandlers() {
    const self = this;
    const grid = this.gridDiv;

    grid.addEventListener('mousedown', (e) => self._onMouseDown(e));
    grid.addEventListener('mousemove', (e) => self._onGridMouseMove(e));
    grid.addEventListener('dblclick', (e) => self._onDblClick(e));
    grid.addEventListener('keydown', (e) => self._onGridKeydown(e));
    grid.addEventListener('copy', (e) => self._onCopy(e));
    grid.addEventListener('paste', (e) => self._onPaste(e));
    grid.addEventListener('contextmenu', (e) => self._onContextMenu(e));

    // document レベルのドラッグ追跡。インスタンス破棄時に解除できるよう保持。
    this._docMouseMove = (e) => self._onDocMouseMove(e);
    this._docMouseUp = () => self._onDocMouseUp();
    document.addEventListener('mousemove', this._docMouseMove);
    document.addEventListener('mouseup', this._docMouseUp);
  }

  // インスタンス破棄（タブを閉じたとき）。document リスナを解除しメモリリークを防ぐ。
  dispose() {
    document.removeEventListener('mousemove', this._docMouseMove);
    document.removeEventListener('mouseup', this._docMouseUp);
    if (this.gridDiv && this.gridDiv.parentNode) {
      this.gridDiv.parentNode.removeChild(this.gridDiv);
    }
  }

  _onMouseDown(e) {
    if (e.button === 2) {
      // 右クリック: contextmenu 側で処理する。
      // ただし、これに伴って textarea にフォーカスが移ると onCellFocus が走って
      // 範囲選択を単一セルに潰してしまう。右クリック直後のフォーカスでは
      // 選択を解除しないようフラグを立てる（contextmenu ハンドラで消す）。
      this._suppressFocusReselect = true;
      return;
    }
    const grid = this.gridDiv;

    // 列リサイズハンドル
    const rz = e.target.closest('.tg-colhead-resize');
    if (rz) {
      e.preventDefault();
      const c = parseInt(rz.dataset.resizec, 10);
      const th = grid.querySelector('th.tg-colhead[data-c="' + c + '"]');
      this.colResize = { c, startX: e.clientX, startW: th ? th.offsetWidth : 120 };
      document.body.style.cursor = 'col-resize';
      return;
    }
    // 行移動ハンドル
    const rhandle = e.target.closest('.tg-rowhead-handle');
    if (rhandle) {
      e.preventDefault();
      // 結合あり時は行移動を無効
      if (hasAnyMerge(this.sheet)) { return; }
      const from = parseInt(rhandle.dataset.handler, 10);
      this.rowMove = { from, to: from };
      this.dragging = 'rowmove';
      document.body.style.cursor = 'grabbing';
      return;
    }
    // 列移動ハンドル
    const handle = e.target.closest('.tg-colhead-handle');
    if (handle) {
      e.preventDefault();
      // 結合あり時は列移動を無効
      if (hasAnyMerge(this.sheet)) { return; }
      const from = parseInt(handle.dataset.handlec, 10);
      this.colMove = { from, to: from };
      this.dragging = 'colmove';
      document.body.style.cursor = 'grabbing';
      return;
    }
    // ソートボタン
    const sb = e.target.closest('.tg-colhead-sort');
    if (sb) {
      e.preventDefault();
      // 結合あり時はソートを無効（行順を変えると結合が壊れるため）
      if (hasAnyMerge(this.sheet)) { return; }
      const c = parseInt(sb.dataset.sortc, 10);
      if (!this.sortState || this.sortState.c !== c) { this.sortState = { c, dir: 'asc' }; }
      else if (this.sortState.dir === 'asc') { this.sortState = { c, dir: 'desc' }; }
      else { this.sortState = null; }
      this.applySort();
      return;
    }
    // 左上コーナー → 全選択
    const corner = e.target.closest('th.tg-corner');
    if (corner) {
      e.preventDefault();
      this.selMode = 'cell';
      this.sel = { r: 0, c: 0, r2: this.sheet.data.length - 1, c2: this.sheet.columns.length - 1 };
      this.render(); grid.focus();
      return;
    }
    // 行番号 → 行選択
    const rh = e.target.closest('td.tg-rowhead');
    if (rh) {
      e.preventDefault();
      const r = parseInt(rh.dataset.r, 10);
      if (e.shiftKey && this.selMode === 'row') { this.sel.r2 = r; }
      else { this.selMode = 'row'; this.sel = { r, c: 0, r2: r, c2: 0 }; this.dragging = 'row'; }
      this.render(); grid.focus();
      return;
    }
    // 列ヘッダ → 列選択（手動ダブルクリック検知付き）
    const ch = e.target.closest('th.tg-colhead');
    if (ch) {
      e.preventDefault();
      const c = parseInt(ch.dataset.c, 10);
      const now = Date.now();
      if (this.lastHeadClick && this.lastHeadClick.c === c && (now - this.lastHeadClick.t) < 400) {
        this.lastHeadClick = null;
        this.startHeaderEdit(c);
        return;
      }
      this.lastHeadClick = { c, t: now };
      if (e.shiftKey && this.selMode === 'col') { this.sel.c2 = c; }
      else { this.selMode = 'col'; this.sel = { r: 0, c, r2: 0, c2: c }; this.dragging = 'col'; }
      this.render(); grid.focus();
      return;
    }
    // データセル
    const td = e.target.closest('td');
    if (!td || td.classList.contains('tg-rowhead')) { return; }
    const r = parseInt(td.dataset.r, 10), c = parseInt(td.dataset.c, 10);
    if (e.shiftKey) {
      e.preventDefault();
      this.selMode = 'cell';
      this.sel = { r: this.sel.r, c: this.sel.c, r2: r, c2: c };
      this.render();
      grid.focus();
      return;
    }
    // 通常クリック: textarea にフォーカスさせて編集可能に（preventDefault しない）。
    // ドラッグ開始の起点だけ記録し、mousemove で実際に動いたら範囲選択へ。
    this.dragMaybe = { r, c, started: false };
  }

  _onGridMouseMove(e) {
    if (!this.dragging && !this.dragMaybe) { return; }
    const grid = this.gridDiv;

    if (this.dragging === 'rowmove') {
      const rh = e.target.closest('td.tg-rowhead');
      if (!rh) { return; }
      const r = parseInt(rh.dataset.r, 10);
      const rect = rh.getBoundingClientRect();
      const below = (e.clientY - rect.top) > rect.height / 2;
      const to = below ? r + 1 : r;
      if (this.rowMove.to !== to) { this.rowMove.to = to; this.renderRowMoveIndicator(); }
      return;
    }
    if (this.dragging === 'colmove') {
      const ch = e.target.closest('th.tg-colhead');
      if (!ch) { return; }
      const c = parseInt(ch.dataset.c, 10);
      const rect = ch.getBoundingClientRect();
      const after = (e.clientX - rect.left) > rect.width / 2;
      const to = after ? c + 1 : c;
      if (this.colMove.to !== to) { this.colMove.to = to; this.renderColMoveIndicator(); }
      return;
    }
    if (this.dragging === 'row') {
      const rh = e.target.closest('td.tg-rowhead');
      if (!rh) { return; }
      const r = parseInt(rh.dataset.r, 10);
      if (r !== this.sel.r2) { this.sel.r2 = r; this.render(); }
      return;
    }
    if (this.dragging === 'col') {
      const ch = e.target.closest('th.tg-colhead');
      if (!ch) { return; }
      const c = parseInt(ch.dataset.c, 10);
      if (c !== this.sel.c2) { this.sel.c2 = c; this.render(); }
      return;
    }
    // セル範囲ドラッグ
    if (!this.dragMaybe) { return; }
    const td = e.target.closest('td');
    if (!td || td.classList.contains('tg-rowhead')) { return; }
    const r = parseInt(td.dataset.r, 10), c = parseInt(td.dataset.c, 10);
    if (!this.dragMaybe.started) {
      if (r === this.dragMaybe.r && c === this.dragMaybe.c) { return; }
      this.dragMaybe.started = true;
      this.selMode = 'cell';
      this.sel = { r: this.dragMaybe.r, c: this.dragMaybe.c, r2: r, c2: c };
      this.render();
      return;
    }
    if (r === this.sel.r2 && c === this.sel.c2) { return; }
    this.sel.r2 = r; this.sel.c2 = c;
    this.render();
  }

  // 列リサイズは document レベルで追跡（grid 外へドラッグしても効くように）。
  _onDocMouseMove(e) {
    if (!this.colResize) { return; }
    const dx = e.clientX - this.colResize.startX;
    const w = Math.max(40, this.colResize.startW + dx);
    this.colWidths[this.colResize.c] = w;
    const th = this.gridDiv.querySelector('th.tg-colhead[data-c="' + this.colResize.c + '"]');
    if (th) { th.style.width = w + 'px'; }
  }

  _onDocMouseUp() {
    if (this.colResize) { this.colResize = null; document.body.style.cursor = ''; this.render(); return; }
    if (this.dragging === 'rowmove' && this.rowMove) {
      const from = this.rowMove.from, to = this.rowMove.to;
      this.rowMove = null; this.dragging = false; document.body.style.cursor = '';
      this.commitRowMove(from, to);
      return;
    }
    if (this.dragging === 'colmove' && this.colMove) {
      const from = this.colMove.from, to = this.colMove.to;
      this.colMove = null; this.dragging = false; document.body.style.cursor = '';
      this.commitColMove(from, to);
      return;
    }
    if (this.dragging) {
      const wasRange = this.isRange() || this.selMode !== 'cell';
      this.dragging = false;
      if (wasRange) { this.gridDiv.focus(); }
    }
    // セルドラッグ範囲が確定したら、textarea からフォーカスを外し
    // グリッドにフォーカスを移す（Delete/Backspace を拾えるように）。
    if (this.dragMaybe && this.dragMaybe.started) {
      if (document.activeElement && document.activeElement.blur) { document.activeElement.blur(); }
      this.gridDiv.focus();
    }
    this.dragMaybe = null;
  }

  // ============================================================
  // 列・行の移動（ドラッグ&ドロップ確定）
  // ============================================================
  commitColMove(from, to) {
    if (to === from || to === from + 1) { this.render(); return; }
    const moveItem = (arr) => {
      const item = arr[from];
      arr.splice(from, 1);
      const insertAt = to > from ? to - 1 : to;
      arr.splice(insertAt, 0, item);
    };
    this.pushHistory();
    moveItem(this.sheet.columns);
    this.sheet.data.forEach((row) => moveItem(row));
    if (this.sheet.headerStyles) { moveItem(this.sheet.headerStyles); }
    if (this.sheet.cellStyles) { this.sheet.cellStyles.forEach((row) => moveItem(row)); }
    if (this.sheet.cellMerges) { this.sheet.cellMerges.forEach((row) => moveItem(row)); }
    this.sortState = null; this.originalOrder = null;
    this.selMode = 'cell';
    const newIdx = to > from ? to - 1 : to;
    this.sel = { r: 0, c: newIdx, r2: 0, c2: newIdx };
    this.render();
    this.flashColumn(newIdx);
    this._fireChange();
  }

  commitRowMove(from, to) {
    if (to === from || to === from + 1) { this.render(); return; }
    this.pushHistory();
    const item = this.sheet.data[from];
    const styleItem = this.sheet.cellStyles ? this.sheet.cellStyles[from] : null;
    const mergeItem = this.sheet.cellMerges ? this.sheet.cellMerges[from] : null;
    this.sheet.data.splice(from, 1);
    if (this.sheet.cellStyles) { this.sheet.cellStyles.splice(from, 1); }
    if (this.sheet.cellMerges) { this.sheet.cellMerges.splice(from, 1); }
    const insertAt = to > from ? to - 1 : to;
    this.sheet.data.splice(insertAt, 0, item);
    if (this.sheet.cellStyles) { this.sheet.cellStyles.splice(insertAt, 0, styleItem); }
    if (this.sheet.cellMerges) { this.sheet.cellMerges.splice(insertAt, 0, mergeItem); }
    this.sortState = null; this.originalOrder = null;
    this.selMode = 'cell';
    this.sel = { r: insertAt, c: 0, r2: insertAt, c2: 0 };
    this.render();
    this.flashRow(insertAt);
    this._fireChange();
  }

  flashColumn(c) {
    const els = this.gridDiv.querySelectorAll('[data-c="' + c + '"]');
    els.forEach((el) => el.classList.add('tg-move-done'));
    setTimeout(() => {
      this.gridDiv.querySelectorAll('.tg-move-done').forEach((el) => el.classList.remove('tg-move-done'));
    }, 600);
  }

  flashRow(r) {
    const rowTds = this.gridDiv.querySelectorAll('td[data-r="' + r + '"]');
    rowTds.forEach((el) => el.classList.add('tg-move-done'));
    const rh = this.gridDiv.querySelectorAll('td.tg-rowhead')[r];
    if (rh) { rh.classList.add('tg-move-done'); }
    setTimeout(() => {
      this.gridDiv.querySelectorAll('.tg-move-done').forEach((el) => el.classList.remove('tg-move-done'));
    }, 600);
  }

  renderRowMoveIndicator() {
    this.render();
    if (!this.rowMove) { return; }
    const rhs = this.gridDiv.querySelectorAll('td.tg-rowhead');
    rhs.forEach((rh) => { rh.style.boxShadow = ''; });
    const to = this.rowMove.to;
    if (to < rhs.length) { rhs[to].style.boxShadow = 'inset 0 4px 0 #2e8b57'; }
    else if (rhs.length) { rhs[rhs.length - 1].style.boxShadow = 'inset 0 -4px 0 #2e8b57'; }
  }

  renderColMoveIndicator() {
    this.render();
    if (!this.colMove) { return; }
    const ths = this.gridDiv.querySelectorAll('th.tg-colhead');
    ths.forEach((th) => { th.style.boxShadow = ''; });
    const to = this.colMove.to;
    if (to < ths.length) { ths[to].style.boxShadow = 'inset 4px 0 0 #2e8b57'; }
    else if (ths.length) { ths[ths.length - 1].style.boxShadow = 'inset -4px 0 0 #2e8b57'; }
  }

  // ============================================================
  // ヘッダ名編集（列ヘッダをダブルクリック）
  // ============================================================
  _onDblClick(e) {
    const ch = e.target.closest('th.tg-colhead');
    if (!ch) { return; }
    e.preventDefault();
    this.startHeaderEdit(parseInt(ch.dataset.c, 10));
  }

  startHeaderEdit(c) {
    const th = this.gridDiv.querySelector('th.tg-colhead[data-c="' + c + '"]');
    if (!th || th.querySelector('input')) { return; }
    const cur = this.sheet.columns[c];
    const input = document.createElement('input');
    input.className = 'tg-cell-input'; input.type = 'text'; input.value = cur;
    th.textContent = ''; th.appendChild(input);
    input.focus(); input.select();

    const cleanup = () => {
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('blur', commit);
    };
    const commit = () => {
      if (!th.contains(input)) { return; }
      this.sheet.columns[c] = input.value;
      cleanup(); this.render();
      this._fireChange();
    };
    const cancel = () => { cleanup(); this.render(); };
    const onKey = (e2) => {
      if (e2.isComposing || e2.keyCode === 229) { return; }
      if (e2.key === 'Enter') { e2.preventDefault(); commit(); }
      else if (e2.key === 'Escape') { e2.preventDefault(); cancel(); }
      else if (e2.key === 'Tab') { e2.preventDefault(); commit(); }
      e2.stopPropagation();
    };
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', commit);
  }

  // ============================================================
  // 行・列の削除 / セルクリア / Delete
  // ============================================================
  deleteRowRange(lo, hi) {
    const n = hi - lo + 1;
    if (this.sheet.data.length - n < 1) { return; } // 最後の1行は残す
    this.pushHistory();
    // 削除範囲 [lo..hi] の一部だけが結合に含まれる場合、その結合は
    // 削除後にデータ構造が壊れる。先に自動で解除しておく。
    // （結合全体が削除範囲内なら解除しなくても消えるが、わかりやすさのため
    //   削除範囲に「触れる結合」はすべて解除して整合性を担保する。）
    this._unmergeRowsAffectedBy(lo, hi);
    this.sheet.data.splice(lo, n);
    if (this.sheet.cellStyles) { this.sheet.cellStyles.splice(lo, n); }
    if (this.sheet.cellMerges) { this.sheet.cellMerges.splice(lo, n); }
    // 残った結合の mergedBy 参照が、行削除でズレるため補正する。
    this._shiftMergesAfterRowDelete(lo, n);
    this.selMode = 'cell';
    const nr = Math.min(lo, this.sheet.data.length - 1);
    this.sel = { r: nr, c: 0, r2: nr, c2: 0 };
    this.render();
    this._fireChange();
  }

  deleteColRange(lo, hi) {
    const n = hi - lo + 1;
    if (this.sheet.columns.length - n < 1) { return; } // 最後の1列は残す
    this.pushHistory();
    // 削除範囲 [lo..hi] に「触れる結合」をすべて先に解除する。
    this._unmergeColsAffectedBy(lo, hi);
    this.sheet.columns.splice(lo, n);
    this.sheet.data.forEach((row) => row.splice(lo, n));
    if (this.sheet.headerStyles) { this.sheet.headerStyles.splice(lo, n); }
    if (this.sheet.cellStyles) { this.sheet.cellStyles.forEach((row) => row.splice(lo, n)); }
    if (this.sheet.cellMerges) { this.sheet.cellMerges.forEach((row) => row.splice(lo, n)); }
    // 残った結合の mergedBy 参照を、列削除分シフトする。
    this._shiftMergesAfterColDelete(lo, n);
    this.selMode = 'cell';
    const nc = Math.min(lo, this.sheet.columns.length - 1);
    this.sel = { r: 0, c: nc, r2: 0, c2: nc };
    this.render();
    this._fireChange();
  }

  // 削除前ヘルパ: 行 [lo..hi] と関わる結合を整える。
  //   ケース1（結合全体が削除範囲に含まれる）→ そのまま削除すれば消える。何もしない。
  //   ケース2（削除範囲が結合の内側に収まる: anchor.r <= lo かつ hi <= r2）
  //     → 結合範囲を縮める（rowSpan -= 削除幅）。残り rowSpan が 1 以下なら結合解除。
  //     Excel/Google Sheets と同じ挙動: 結合の中の行を削っても結合は残る。
  //   ケース3（削除範囲が結合の境界をまたぐ）→ 結合を解除（データ構造が壊れるため）。
  _unmergeRowsAffectedBy(lo, hi) {
    if (!this.sheet.cellMerges) { return; }
    // 主セルの (r1,c) を列挙する
    const anchors = []; // {r, c, rowSpan, colSpan}
    for (let r = 0; r < this.sheet.cellMerges.length; r++) {
      const row = this.sheet.cellMerges[r] || [];
      for (let c = 0; c < row.length; c++) {
        const m = row[c];
        if (m && m.rowSpan) { anchors.push({ r, c, rowSpan: m.rowSpan, colSpan: m.colSpan }); }
      }
    }
    anchors.forEach((a) => {
      const r1 = a.r, r2 = a.r + a.rowSpan - 1;
      // ケース1: 結合全体が削除範囲に含まれる → 削除と同時に自動で消える、何もしない
      if (lo <= r1 && r2 <= hi) { return; }
      // 削除範囲と結合範囲の重なりを計算
      const overlapLo = Math.max(lo, r1);
      const overlapHi = Math.min(hi, r2);
      if (overlapLo > overlapHi) { return; } // 重なりなし → 影響なし
      // ケース2: 削除範囲が結合の内側に完全に収まる（境界をまたがない）
      //   → 結合範囲を縮める
      //   ただし、主セル（左上）自身が削除範囲に含まれる場合は、結合の起点が
      //   消えるため破綻する。その場合は素直に解除する。
      if (r1 <= lo && hi <= r2) {
        if (lo <= r1 && r1 <= hi) {
          // 主セルが削除範囲内 → 解除
          unapplyMerge(this.sheet, a.r, a.c);
          return;
        }
        const shrink = hi - lo + 1;
        const newSpan = a.rowSpan - shrink;
        const m = this.sheet.cellMerges[a.r][a.c];
        if (newSpan <= 1) {
          // 縦方向の結合がなくなる
          if (a.colSpan > 1) {
            // 横結合だけ残す: 主セルの rowSpan を 1 に、削除されずに残る
            // 「飲み込まれ側で縦方向の」セルだけ null にする
            // （横方向の飲み込まれ側はそのまま残す）
            m.rowSpan = 1;
            for (let rr = a.r + 1; rr <= r2; rr++) {
              // 削除範囲内の行は後で splice で消えるので触らない
              if (rr >= lo && rr <= hi) { continue; }
              // それ以外の行で、この結合の縦飲み込まれ側だったセルを null に
              for (let cc = a.c; cc <= a.c + a.colSpan - 1; cc++) {
                const cm = (this.sheet.cellMerges[rr] || [])[cc];
                if (cm && cm.mergedBy &&
                    cm.mergedBy.r === a.r && cm.mergedBy.c === a.c) {
                  this.sheet.cellMerges[rr][cc] = null;
                }
              }
            }
          } else {
            // colSpan=1 で rowSpan も 1 → 完全解除
            unapplyMerge(this.sheet, a.r, a.c);
          }
        } else {
          // rowSpan を縮めるだけ。残る飲み込まれ側はそのままで、削除分は
          // splice で物理的に消えるので追加処理は不要。
          m.rowSpan = newSpan;
        }
        return;
      }
      // ケース3: 境界をまたぐ → 解除
      unapplyMerge(this.sheet, a.r, a.c);
    });
  }

  // 削除前ヘルパ: 列 [lo..hi] と関わる結合を整える。
  // 行と同様、内側部分削除なら結合を縮める、境界またぎなら解除する。
  _unmergeColsAffectedBy(lo, hi) {
    if (!this.sheet.cellMerges) { return; }
    const anchors = []; // 主セル一覧
    for (let r = 0; r < this.sheet.cellMerges.length; r++) {
      const row = this.sheet.cellMerges[r] || [];
      for (let c = 0; c < row.length; c++) {
        const m = row[c];
        if (m && m.colSpan) { anchors.push({ r, c, rowSpan: m.rowSpan, colSpan: m.colSpan }); }
      }
    }
    anchors.forEach((a) => {
      const c1 = a.c, c2 = a.c + a.colSpan - 1;
      // ケース1: 結合全体が削除範囲に含まれる
      if (lo <= c1 && c2 <= hi) { return; }
      const overlapLo = Math.max(lo, c1);
      const overlapHi = Math.min(hi, c2);
      if (overlapLo > overlapHi) { return; }
      // ケース2: 削除範囲が結合の内側に完全に収まる
      if (c1 <= lo && hi <= c2) {
        if (lo <= c1 && c1 <= hi) {
          // 主セルが削除範囲内 → 解除
          unapplyMerge(this.sheet, a.r, a.c);
          return;
        }
        const shrink = hi - lo + 1;
        const newSpan = a.colSpan - shrink;
        const m = this.sheet.cellMerges[a.r][a.c];
        if (newSpan <= 1) {
          if (a.rowSpan > 1) {
            // 縦結合だけ残す: 主セルの colSpan を 1 に
            m.colSpan = 1;
            for (let cc = a.c + 1; cc <= c2; cc++) {
              if (cc >= lo && cc <= hi) { continue; } // 削除範囲は触らない
              for (let rr = a.r; rr <= a.r + a.rowSpan - 1; rr++) {
                const cm = (this.sheet.cellMerges[rr] || [])[cc];
                if (cm && cm.mergedBy &&
                    cm.mergedBy.r === a.r && cm.mergedBy.c === a.c) {
                  this.sheet.cellMerges[rr][cc] = null;
                }
              }
            }
          } else {
            unapplyMerge(this.sheet, a.r, a.c);
          }
        } else {
          m.colSpan = newSpan;
        }
        return;
      }
      // ケース3: 境界またぎ → 解除
      unapplyMerge(this.sheet, a.r, a.c);
    });
  }

  // 行削除後ヘルパ: 削除後の mergedBy 参照を、削除分シフトする。
  // 主セルが削除位置より下にあった場合、mergedBy.r も -n する。
  _shiftMergesAfterRowDelete(lo, n) {
    if (!this.sheet.cellMerges) { return; }
    for (let r = 0; r < this.sheet.cellMerges.length; r++) {
      const row = this.sheet.cellMerges[r] || [];
      for (let c = 0; c < row.length; c++) {
        const m = row[c];
        if (m && m.mergedBy && m.mergedBy.r >= lo) {
          m.mergedBy = { r: m.mergedBy.r - n, c: m.mergedBy.c };
        }
      }
    }
  }

  // 列削除後ヘルパ: mergedBy.c をシフトする。
  _shiftMergesAfterColDelete(lo, n) {
    if (!this.sheet.cellMerges) { return; }
    for (let r = 0; r < this.sheet.cellMerges.length; r++) {
      const row = this.sheet.cellMerges[r] || [];
      for (let c = 0; c < row.length; c++) {
        const m = row[c];
        if (m && m.mergedBy && m.mergedBy.c >= lo) {
          m.mergedBy = { r: m.mergedBy.r, c: m.mergedBy.c - n };
        }
      }
    }
  }

  // 行挿入の前処理: 位置 `at` への挿入が結合領域の内側（境界ではなく真ん中）
  // にあたる場合、結合の rowSpan を +1 して結合を自動拡張する。
  // 行挿入はこの呼び出しの後で sheet.data に splice(at, 0, ...) する想定。
  // この関数は cellMerges のシフトと、結合主の rowSpan 拡張を行う。
  _expandMergesOnRowInsert(at) {
    if (!this.sheet.cellMerges) { return; }
    // 1. 結合主の rowSpan 拡張: 主セル r1 < at <= r1+rowSpan-1 のとき +1
    for (let r = 0; r < this.sheet.cellMerges.length; r++) {
      const row = this.sheet.cellMerges[r] || [];
      for (let c = 0; c < row.length; c++) {
        const m = row[c];
        if (!m || !m.rowSpan) { continue; }
        const r1 = r;
        const r2 = r1 + m.rowSpan - 1;
        if (r1 < at && at <= r2) {
          m.rowSpan += 1;
          // 飲み込まれ側の追加は呼び出し後に行う（cellMerges 配列のサイズが
          // splice の後でないと不正なので、ここでは数値だけ更新）。
        }
      }
    }
    // 2. mergedBy 参照のシフト: 主セルの r >= at にあるなら +1
    for (let r = 0; r < this.sheet.cellMerges.length; r++) {
      const row = this.sheet.cellMerges[r] || [];
      for (let c = 0; c < row.length; c++) {
        const m = row[c];
        if (m && m.mergedBy && m.mergedBy.r >= at) {
          m.mergedBy = { r: m.mergedBy.r + 1, c: m.mergedBy.c };
        }
      }
    }
  }

  // 行挿入の後処理: 挿入された新行のセルを、結合領域の中に入っていれば
  // mergedBy に置き換える。
  _fillMergesAfterRowInsert(at) {
    if (!this.sheet.cellMerges) { return; }
    const newRow = this.sheet.cellMerges[at] || [];
    for (let c = 0; c < this.sheet.columns.length; c++) {
      // 自分の列の上方向に主セルを探す
      for (let rr = at - 1; rr >= 0; rr--) {
        const m = (this.sheet.cellMerges[rr] || [])[c];
        if (!m) { continue; }
        const anchor = m.mergedBy ? m.mergedBy : { r: rr, c };
        const main = (this.sheet.cellMerges[anchor.r] || [])[anchor.c];
        if (!main || !main.rowSpan) { break; }
        const r2 = anchor.r + main.rowSpan - 1;
        if (r2 >= at) {
          // 結合領域が新行を覆っている → 新行のこのセルは mergedBy
          newRow[c] = { mergedBy: { r: anchor.r, c: anchor.c } };
          // 値も空にしておく
          if (this.sheet.data[at]) { this.sheet.data[at][c] = ''; }
        }
        break;
      }
    }
  }

  // 列挿入の前処理: 結合主の colSpan 拡張と、mergedBy.c のシフト。
  _expandMergesOnColInsert(at) {
    if (!this.sheet.cellMerges) { return; }
    for (let r = 0; r < this.sheet.cellMerges.length; r++) {
      const row = this.sheet.cellMerges[r] || [];
      for (let c = 0; c < row.length; c++) {
        const m = row[c];
        if (!m || !m.colSpan) { continue; }
        const c1 = c;
        const c2 = c1 + m.colSpan - 1;
        if (c1 < at && at <= c2) {
          m.colSpan += 1;
        }
      }
    }
    for (let r = 0; r < this.sheet.cellMerges.length; r++) {
      const row = this.sheet.cellMerges[r] || [];
      for (let c = 0; c < row.length; c++) {
        const m = row[c];
        if (m && m.mergedBy && m.mergedBy.c >= at) {
          m.mergedBy = { r: m.mergedBy.r, c: m.mergedBy.c + 1 };
        }
      }
    }
  }

  // 列挿入の後処理: 新しい列のセルが結合範囲内に入っていれば mergedBy に。
  _fillMergesAfterColInsert(at) {
    if (!this.sheet.cellMerges) { return; }
    for (let r = 0; r < this.sheet.data.length; r++) {
      const row = this.sheet.cellMerges[r] || [];
      // 左方向に主セルを探す
      for (let cc = at - 1; cc >= 0; cc--) {
        const m = row[cc];
        if (!m) { continue; }
        const anchor = m.mergedBy ? m.mergedBy : { r, c: cc };
        const main = (this.sheet.cellMerges[anchor.r] || [])[anchor.c];
        if (!main || !main.colSpan) { break; }
        const c2 = anchor.c + main.colSpan - 1;
        if (c2 >= at) {
          row[at] = { mergedBy: { r: anchor.r, c: anchor.c } };
          if (this.sheet.data[r]) { this.sheet.data[r][at] = ''; }
        }
        break;
      }
    }
  }

  // ============================================================
  // 行/列挿入の高レベル API
  // ============================================================
  // 行を `at` の位置に1行挿入する。pushHistory・結合の自動拡張・補助配列の
  // 同期をまとめて行う。右クリック挿入メニューやデータセル挿入メニューから
  // 共通で呼び出される。
  insertRowAt(at) {
    this.pushHistory();
    this._expandMergesOnRowInsert(at);
    this.sheet.data.splice(at, 0, this.sheet.columns.map(() => ''));
    if (this.sheet.cellStyles) { this.sheet.cellStyles.splice(at, 0, this.sheet.columns.map(() => null)); }
    if (this.sheet.cellMerges) { this.sheet.cellMerges.splice(at, 0, this.sheet.columns.map(() => null)); }
    this._fillMergesAfterRowInsert(at);
  }

  // 列を `at` の位置に1列挿入する。pushHistory・結合の自動拡張・補助配列の
  // 同期をまとめて行う。
  insertColAt(at) {
    this.pushHistory();
    this._expandMergesOnColInsert(at);
    this.sheet.columns.splice(at, 0, '列' + (this.sheet.columns.length + 1));
    this.sheet.data.forEach((row) => row.splice(at, 0, ''));
    if (this.sheet.headerStyles) { this.sheet.headerStyles.splice(at, 0, null); }
    if (this.sheet.cellStyles) { this.sheet.cellStyles.forEach((row) => row.splice(at, 0, null)); }
    if (this.sheet.cellMerges) { this.sheet.cellMerges.forEach((row) => row.splice(at, 0, null)); }
    this._fillMergesAfterColInsert(at);
  }

  clearSelectedCells() {
    if (this.selMode === 'row') {
      const lo = Math.min(this.sel.r, this.sel.r2), hi = Math.max(this.sel.r, this.sel.r2);
      for (let r = lo; r <= hi; r++) {
        for (let c = 0; c < this.sheet.columns.length; c++) { this.sheet.data[r][c] = ''; }
      }
    } else if (this.selMode === 'col') {
      const lo = Math.min(this.sel.c, this.sel.c2), hi = Math.max(this.sel.c, this.sel.c2);
      for (let r = 0; r < this.sheet.data.length; r++) {
        for (let c = lo; c <= hi; c++) { this.sheet.data[r][c] = ''; }
      }
    } else {
      const b = this.selBounds();
      for (let r = b.r1; r <= b.rr; r++) {
        for (let c = b.c1; c <= b.cc; c++) { this.sheet.data[r][c] = ''; }
      }
    }
    this.render();
    if (this.selMode !== 'cell' || this.isRange()) { this.gridDiv.focus(); }
    this._fireChange();
  }

  // ============================================================
  // 装飾の適用（Textileモード時の右クリックメニューから呼ばれる）
  // ============================================================
  //   target: 'cells' | 'headers'
  //   bounds: { r1, rr } または { c1, cc }（target に応じて）
  //   patch : { bg?: string|null, bold?: bool, italic?: bool, toggle?: 'bold'|'italic' }
  //     bg: 文字列なら背景色を設定、null なら背景色をクリア、未指定なら背景は触らない
  //     bold/italic: そのまま設定（true/false）
  //     toggle: 'bold' or 'italic' を指定すると、現状の有無を反転する（範囲は全体反転）
  applyStyle(target, bounds, patch) {
    this.pushHistory();
    const update = (curStyle) => {
      const cur = curStyle ? Object.assign({}, curStyle) : {};
      if (Object.prototype.hasOwnProperty.call(patch, 'bg')) {
        if (patch.bg === null) { delete cur.bg; } else { cur.bg = patch.bg; }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'bold'))      { if (patch.bold)      { cur.bold = true; }      else { delete cur.bold; } }
      if (Object.prototype.hasOwnProperty.call(patch, 'italic'))    { if (patch.italic)    { cur.italic = true; }    else { delete cur.italic; } }
      if (Object.prototype.hasOwnProperty.call(patch, 'underline')) { if (patch.underline) { cur.underline = true; } else { delete cur.underline; } }
      if (Object.prototype.hasOwnProperty.call(patch, 'align')) {
        // null や空文字、'left'/'center'/'right' 以外は align を消す（クリア）。
        if (patch.align === 'left' || patch.align === 'center' || patch.align === 'right') {
          cur.align = patch.align;
        } else {
          delete cur.align;
        }
      }
      return normalizeStyle(cur);
    };

    if (target === 'headers') {
      const { c1, cc } = bounds;
      for (let c = c1; c <= cc; c++) {
        setHeaderStyle(this.sheet, c, update(getHeaderStyle(this.sheet, c)));
      }
      // Markdownモードでヘッダの align を変えたときは、Markdownが「列単位の
      // 揃え」しか表現できないことに合わせ、列の全データセルにも同じ alignを
      // 反映する。装飾の他のプロパティ（背景色など）はヘッダ独自に保つので
      // 触らない。
      if (!this.textileMode && Object.prototype.hasOwnProperty.call(patch, 'align')) {
        for (let c = c1; c <= cc; c++) {
          for (let r = 0; r < this.sheet.data.length; r++) {
            const cur = getCellStyle(this.sheet, r, c);
            const next = Object.assign({}, cur || {});
            if (patch.align === 'left' || patch.align === 'center' || patch.align === 'right') {
              next.align = patch.align;
            } else {
              delete next.align;
            }
            setCellStyle(this.sheet, r, c, normalizeStyle(next));
          }
        }
      }
    } else {
      const { r1, rr, c1, cc } = bounds;
      for (let r = r1; r <= rr; r++) {
        for (let c = c1; c <= cc; c++) {
          setCellStyle(this.sheet, r, c, update(getCellStyle(this.sheet, r, c)));
        }
      }
      // Markdownモードでセルの align を変えたときも、列単位の揃えに合わせる
      // ため、同じ列の他のセルとヘッダにも同じ alignを反映する。
      // （Markdownでは列内に違う揃えを残せないため。）
      if (!this.textileMode && Object.prototype.hasOwnProperty.call(patch, 'align')) {
        for (let c = c1; c <= cc; c++) {
          for (let r = 0; r < this.sheet.data.length; r++) {
            if (r >= r1 && r <= rr) { continue; } // 既に更新済み
            const cur = getCellStyle(this.sheet, r, c);
            const next = Object.assign({}, cur || {});
            if (patch.align === 'left' || patch.align === 'center' || patch.align === 'right') {
              next.align = patch.align;
            } else {
              delete next.align;
            }
            setCellStyle(this.sheet, r, c, normalizeStyle(next));
          }
          // ヘッダにも反映
          const hcur = getHeaderStyle(this.sheet, c);
          const hnext = Object.assign({}, hcur || {});
          if (patch.align === 'left' || patch.align === 'center' || patch.align === 'right') {
            hnext.align = patch.align;
          } else {
            delete hnext.align;
          }
          setHeaderStyle(this.sheet, c, normalizeStyle(hnext));
        }
      }
    }
    this.render();
    this._fireChange();
  }

  // 範囲内のセル/ヘッダで、太字/斜体が「すべて有効」かを判定（トグル基準）。
  // 全部 ON → false（次は OFF にする）、それ以外 → true（次は ON にする）。
  shouldEnableAccent(target, bounds, accent) {
    const isOn = (st) => !!(st && st[accent]);
    if (target === 'headers') {
      const { c1, cc } = bounds;
      for (let c = c1; c <= cc; c++) {
        if (!isOn(getHeaderStyle(this.sheet, c))) { return true; }
      }
      return false;
    }
    const { r1, rr, c1, cc } = bounds;
    for (let r = r1; r <= rr; r++) {
      for (let c = c1; c <= cc; c++) {
        if (!isOn(getCellStyle(this.sheet, r, c))) { return true; }
      }
    }
    return false;
  }

  // ============================================================
  // セル結合 / 解除
  // ============================================================
  // bounds = { r1, rr, c1, cc } の矩形領域を結合する。
  //   - 範囲内に既存の結合があれば、その結合の矩形が範囲外にはみ出していない
  //     ことを確認し、いったん解除する（範囲内に収まっていれば解除→再結合可）
  //   - 左上以外のセルにデータがあれば、ユーザーに確認ダイアログを出す
  //     （confirm()。キャンセルなら何もしない）
  //   - 結合後は左上の値だけが残り、他は空文字＋mergedBy になる
  //
  // 返り値: true = 結合した / false = 中止 or 不正
  mergeCells(bounds) {
    const { r1, rr, c1, cc } = bounds;
    if (r1 === rr && c1 === cc) { return false; } // 1×1 は結合不可
    if (r1 > rr || c1 > cc) { return false; }
    // 履歴は確認ダイアログの後（実際に操作する直前）に積みたいが、
    // 範囲のはみ出しチェックは履歴前に済ませる。ここまで来たら、
    // データ消失確認とその後の処理は同じ「結合操作1回」として扱う。
    // 範囲内に既存結合がある場合、その矩形が範囲外にはみ出していないか確認
    for (let r = r1; r <= rr; r++) {
      for (let c = c1; c <= cc; c++) {
        const m = getCellMerge(this.sheet, r, c);
        if (!m) { continue; }
        const anchor = m.mergedBy ? m.mergedBy : { r, c };
        const main = getCellMerge(this.sheet, anchor.r, anchor.c);
        if (!main || !main.rowSpan) { continue; }
        const ar2 = anchor.r + main.rowSpan - 1;
        const ac2 = anchor.c + main.colSpan - 1;
        if (anchor.r < r1 || anchor.c < c1 || ar2 > rr || ac2 > cc) {
          // 範囲外にはみ出す既存結合がある → 結合できない
          window.alert('選択範囲内に、範囲をはみ出す既存の結合があります。先に結合を解除してから再度試してください。');
          return false;
        }
      }
    }
    // 結合される側にデータがあれば確認
    const losingData = [];
    for (let r = r1; r <= rr; r++) {
      for (let c = c1; c <= cc; c++) {
        if (r === r1 && c === c1) { continue; }
        // 既存結合の主セル位置にあるデータも対象
        const m = getCellMerge(this.sheet, r, c);
        if (m && m.mergedBy) { continue; } // 飲み込まれ側は元から空
        if ((this.sheet.data[r][c] || '').length > 0) {
          losingData.push({ r, c, value: this.sheet.data[r][c] });
        }
      }
    }
    if (losingData.length) {
      const ok = window.confirm(
        '結合すると、左上のセル以外（' + losingData.length + ' 個のセル）の内容が失われます。\n続けますか？'
      );
      if (!ok) { return false; }
    }
    this.pushHistory();
    // 既存結合は先に解除
    for (let r = r1; r <= rr; r++) {
      for (let c = c1; c <= cc; c++) {
        const m = getCellMerge(this.sheet, r, c);
        if (m) { unapplyMerge(this.sheet, r, c); }
      }
    }
    // 新規結合を適用
    applyMerge(this.sheet, r1, c1, rr, cc);
    this.render();
    this._fireChange();
    return true;
  }

  // 指定セル（範囲選択でも単一セルでもOK）の結合を解除する。
  // 範囲内に複数の結合があれば、それぞれ解除する。
  unmergeCells(bounds) {
    const { r1, rr, c1, cc } = bounds;
    let any = false;
    let snapshotTaken = false;
    const seen = new Set();
    for (let r = r1; r <= rr; r++) {
      for (let c = c1; c <= cc; c++) {
        const anchor = getMergeAnchor(this.sheet, r, c);
        const key = anchor.r + ':' + anchor.c;
        if (seen.has(key)) { continue; }
        const main = getCellMerge(this.sheet, anchor.r, anchor.c);
        if (main && main.rowSpan) {
          if (!snapshotTaken) { this.pushHistory(); snapshotTaken = true; }
          unapplyMerge(this.sheet, anchor.r, anchor.c);
          seen.add(key);
          any = true;
        }
      }
    }
    if (any) {
      this.render();
      this._fireChange();
    }
    return any;
  }

  // 範囲内に結合の主セルが含まれているか（解除UIの表示判定用）。
  hasMergeInRange(bounds) {
    const { r1, rr, c1, cc } = bounds;
    for (let r = r1; r <= rr; r++) {
      for (let c = c1; c <= cc; c++) {
        const m = getCellMerge(this.sheet, r, c);
        if (m && (m.rowSpan || m.mergedBy)) { return true; }
      }
    }
    return false;
  }

  _onGridKeydown(e) {
    // Undo/Redo はキーボードショートカット（Ctrl+Z など）ではなく
    // ツールバーのボタンで提供する。理由は Vivaldi のように Ctrl+Z を
    // ブラウザ独自のジェスチャ（戻る）に取られるブラウザがあり、
    // Webページ側で確実に preventDefault できないため。
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // 実際にフォーカスされている textarea を見る（先頭セルを拾わない）。
      // 単一セル編集中はブラウザ既定のテキスト編集（1文字削除）に任せる。
      const ae = document.activeElement;
      const editingCell = ae && ae.classList && ae.classList.contains('tg-cell-ta');
      if (editingCell && this.selMode === 'cell' && !this.isRange()) { return; }
      e.preventDefault();
      this.clearSelectedCells();
    }
  }

  // ============================================================
  // コピー & ペースト（4方向）
  // ============================================================
  // 選択範囲のデータをコピー用の形に取り出す。
  // 戻り値は { headers, rows, headerStyles, cellStyles, cellMerges }。
  // 装飾や結合が無ければ null を返す（後方互換のため）。
  // 結合主が範囲外で飲み込まれ側だけ選択範囲内に入る場合は、その mergedBy
  // を捨てて単なるセルとして扱う（範囲内に主セルが含まれない結合は再構築
  // 不可能なため）。
  getSelectedGrid() {
    const pickStyles = (r1, r2, c1, c2) => {
      if (!this.sheet.cellStyles) { return null; }
      const out = [];
      for (let r = r1; r <= r2; r++) {
        const row = this.sheet.cellStyles[r] || [];
        out.push(row.slice(c1, c2 + 1));
      }
      return out;
    };
    const pickMerges = (r1, r2, c1, c2) => {
      if (!this.sheet.cellMerges) { return null; }
      const out = [];
      for (let r = r1; r <= r2; r++) {
        const row = this.sheet.cellMerges[r] || [];
        const newRow = [];
        for (let c = c1; c <= c2; c++) {
          const m = row[c];
          if (!m) { newRow.push(null); continue; }
          if (m.mergedBy) {
            // 主セルが範囲外なら結合情報を捨てる
            if (m.mergedBy.r < r1 || m.mergedBy.r > r2 ||
                m.mergedBy.c < c1 || m.mergedBy.c > c2) {
              newRow.push(null);
            } else {
              // 範囲内なら相対座標に書き換え
              newRow.push({ mergedBy: { r: m.mergedBy.r - r1, c: m.mergedBy.c - c1 } });
            }
          } else if (m.rowSpan) {
            // 主セル: 結合範囲が選択範囲を超えていたら抑制（クリップ）
            const maxRowSpan = r2 - r + 1;
            const maxColSpan = c2 - c + 1;
            const rs = Math.min(m.rowSpan, maxRowSpan);
            const cs = Math.min(m.colSpan, maxColSpan);
            if (rs > 1 || cs > 1) {
              newRow.push({ rowSpan: rs, colSpan: cs });
            } else {
              newRow.push(null);
            }
          } else {
            newRow.push(null);
          }
        }
        out.push(newRow);
      }
      return out;
    };

    if (this.selMode === 'row') {
      const lo = Math.min(this.sel.r, this.sel.r2), hi = Math.max(this.sel.r, this.sel.r2);
      const c1 = 0, c2 = this.sheet.columns.length - 1;
      const rows = []; for (let r = lo; r <= hi; r++) { rows.push(this.sheet.data[r].slice()); }
      return {
        headers: this.sheet.columns.slice(),
        rows,
        headerStyles: this.sheet.headerStyles ? this.sheet.headerStyles.slice() : null,
        cellStyles: pickStyles(lo, hi, c1, c2),
        cellMerges: pickMerges(lo, hi, c1, c2),
      };
    }
    if (this.selMode === 'col') {
      const lo = Math.min(this.sel.c, this.sel.c2), hi = Math.max(this.sel.c, this.sel.c2);
      const r1 = 0, r2 = this.sheet.data.length - 1;
      return {
        headers: this.sheet.columns.slice(lo, hi + 1),
        rows: this.sheet.data.map((r) => r.slice(lo, hi + 1)),
        headerStyles: this.sheet.headerStyles ? this.sheet.headerStyles.slice(lo, hi + 1) : null,
        cellStyles: pickStyles(r1, r2, lo, hi),
        cellMerges: pickMerges(r1, r2, lo, hi),
      };
    }
    if (this.isRange()) {
      const b = this.selBounds();
      return {
        headers: this.sheet.columns.slice(b.c1, b.cc + 1),
        rows: (() => {
          const rows = [];
          for (let r = b.r1; r <= b.rr; r++) { rows.push(this.sheet.data[r].slice(b.c1, b.cc + 1)); }
          return rows;
        })(),
        headerStyles: this.sheet.headerStyles ? this.sheet.headerStyles.slice(b.c1, b.cc + 1) : null,
        cellStyles: pickStyles(b.r1, b.rr, b.c1, b.cc),
        cellMerges: pickMerges(b.r1, b.rr, b.c1, b.cc),
      };
    }
    // 何も選択されていない場合は全部
    const r1 = 0, r2 = this.sheet.data.length - 1;
    const c1 = 0, c2 = this.sheet.columns.length - 1;
    return {
      headers: this.sheet.columns.slice(),
      rows: this.sheet.data.map((r) => r.slice()),
      headerStyles: this.sheet.headerStyles ? this.sheet.headerStyles.slice() : null,
      cellStyles: pickStyles(r1, r2, c1, c2),
      cellMerges: pickMerges(r1, r2, c1, c2),
    };
  }

  _toHtmlTable(headers, rows) {
    const esc = (s) => (s == null ? '' : String(s))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const h = headers ? '<tr>' + headers.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr>' : '';
    const b = rows.map((r) => '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('');
    return '<table>' + h + b + '</table>';
  }

  _onCopy(e) {
    const inp = this.gridDiv.querySelector('textarea.tg-cell-ta');
    // 編集中 textarea に通常のテキスト選択がある場合はブラウザ既定に任せる。
    if (inp && inp.selectionStart !== inp.selectionEnd) { return; }
    const sel = this.getSelectedGrid();
    // テキスト形式: 開いているチケットのフォーマットに合わせる。
    //   Textile: 装飾・結合・揃えをすべて含む Textile 構文
    //   Markdown: 装飾・揃えを含む Markdown 構文（結合は無視）
    // どちらも貼り付け先が同じフォーマットならそのまま意味を保てる。
    const text = this.textileMode
      ? toTextile(sel.headers, sel.rows, sel.headerStyles, sel.cellStyles, sel.cellMerges)
      : toMarkdown(sel.headers, sel.rows, sel.headerStyles, sel.cellStyles);
    e.clipboardData.setData('text/plain', text);
    // HTML 形式は、リッチテキスト先（メールなど）への貼り付け用。
    // 結合や装飾は完全には反映しないが、最低限のテーブル構造は保つ。
    e.clipboardData.setData('text/html', this._toHtmlTable(sel.headers, sel.rows));
    e.preventDefault();
  }

  _onPaste(e) {
    if (this._pasting) { return; }
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text) { return; }
    // パース順:
    //   1) Textile（装飾・結合・揃え対応）として読めるか試す。テーブル行に
    //      Textile固有の構文（_. ヘッダ、\N. / /N. 結合、{background:...} 等）
    //      が含まれていればこちらが優先される。
    //   2) Markdown（装飾・揃え対応、結合なし）として読めるか試す
    //   3) どちらでもなければ TSV
    // 取り込んだ装飾・結合は、貼り付け先のセル装飾・結合配列に書き戻す。
    let format = null;
    let parsedRows = null;
    let parsedStyles = null;
    let parsedHeaderStyles = null;
    let parsedMerges = null;
    const looksLikeTable = /\|/.test(text) && /\n/.test(text);
    if (looksLikeTable) {
      const tx = parseTextileWithStyles(text);
      // Textile と判定する条件: ヘッダ行があるか、または装飾・結合が含まれる
      if (tx && tx.rows && tx.rows.length) {
        const hasHeader = tx.isHeader && tx.isHeader[0];
        const hasStyleOrMerge =
          (tx.styles && tx.styles.some((row) => row.some((s) => s))) ||
          (tx.merges && tx.merges.some((row) => row.some((m) => m)));
        if (hasHeader || hasStyleOrMerge) {
          format = 'textile';
          parsedRows = tx.rows;
          parsedStyles = tx.styles;
          parsedMerges = tx.merges;
        }
      }
      if (!format) {
        const md = parseMarkdownWithStyles(text);
        if (md && md.rows && md.rows.length) {
          format = 'markdown';
          parsedRows = md.rows;
          parsedStyles = md.styles;
        }
      }
    }
    if (!format) {
      const grid = parseTsv(text);
      if (!grid || !grid.length) { return; }
      format = 'tsv';
      parsedRows = grid;
    }
    e.preventDefault();
    this.pushHistory();
    this._pasting = true;
    try {
      // ヘッダ行を分離（Textile/Markdownは1行目をヘッダ扱い）
      let headerRow = null;
      let headerStyleRow = null;
      let dataStartIdx = 0;
      if (format === 'textile' || format === 'markdown') {
        if (parsedRows.length >= 1) {
          headerRow = parsedRows[0];
          headerStyleRow = parsedStyles ? parsedStyles[0] : null;
          dataStartIdx = 1;
        }
      }
      const dataRows = parsedRows.slice(dataStartIdx);
      const dataStyleRows = parsedStyles ? parsedStyles.slice(dataStartIdx) : null;
      const dataMergeRows = parsedMerges ? parsedMerges.slice(dataStartIdx) : null;

      const sx = this.sel.c, sy = this.sel.r;
      const bodyRows = dataRows.length;
      const bodyCols = Math.max(
        headerRow ? headerRow.length : 0,
        ...(dataRows.length ? dataRows.map((r) => r.length) : [0])
      );
      const needRows = sy + bodyRows;
      const needCols = sx + bodyCols;

      while (this.sheet.data.length < needRows) {
        this.sheet.data.push(this.sheet.columns.map(() => ''));
        if (this.sheet.cellStyles) { this.sheet.cellStyles.push(this.sheet.columns.map(() => null)); }
        if (this.sheet.cellMerges) { this.sheet.cellMerges.push(this.sheet.columns.map(() => null)); }
      }
      while (this.sheet.columns.length < needCols) {
        this.sheet.columns.push('列' + (this.sheet.columns.length + 1));
        if (this.sheet.headerStyles) { this.sheet.headerStyles.push(null); }
        if (this.sheet.cellStyles) { this.sheet.cellStyles.forEach((r) => r.push(null)); }
        if (this.sheet.cellMerges) { this.sheet.cellMerges.forEach((r) => r.push(null)); }
      }
      this.sheet.data.forEach((r) => { while (r.length < this.sheet.columns.length) { r.push(''); } });
      if (this.sheet.cellStyles) {
        this.sheet.cellStyles.forEach((r) => { while (r.length < this.sheet.columns.length) { r.push(null); } });
      }
      if (this.sheet.cellMerges) {
        this.sheet.cellMerges.forEach((r) => { while (r.length < this.sheet.columns.length) { r.push(null); } });
      }

      // ヘッダの値・装飾
      if (headerRow) {
        for (let c = 0; c < headerRow.length; c++) { this.sheet.columns[sx + c] = headerRow[c]; }
        if (headerStyleRow && headerStyleRow.some((s) => s)) {
          if (!this.sheet.headerStyles) {
            this.sheet.headerStyles = this.sheet.columns.map(() => null);
          }
          for (let c = 0; c < headerStyleRow.length; c++) {
            this.sheet.headerStyles[sx + c] = headerStyleRow[c] || null;
          }
        }
      }
      // データの値・装飾
      for (let r = 0; r < dataRows.length; r++) {
        for (let c = 0; c < dataRows[r].length; c++) {
          this.sheet.data[sy + r][sx + c] = dataRows[r][c];
        }
      }
      if (dataStyleRows && dataStyleRows.some((row) => row && row.some((s) => s))) {
        if (!this.sheet.cellStyles) {
          this.sheet.cellStyles = this.sheet.data.map((row) => row.map(() => null));
        }
        for (let r = 0; r < dataStyleRows.length; r++) {
          const styleRow = dataStyleRows[r] || [];
          for (let c = 0; c < styleRow.length; c++) {
            this.sheet.cellStyles[sy + r][sx + c] = styleRow[c] || null;
          }
        }
      }
      // 結合（Textile のみ）。貼り付け範囲（sy+r, sx+c）に座標オフセットして反映。
      if (dataMergeRows && dataMergeRows.some((row) => row && row.some((m) => m))) {
        if (!this.sheet.cellMerges) {
          this.sheet.cellMerges = this.sheet.data.map((row) => row.map(() => null));
        }
        for (let r = 0; r < dataMergeRows.length; r++) {
          const mergeRow = dataMergeRows[r] || [];
          for (let c = 0; c < mergeRow.length; c++) {
            const m = mergeRow[c];
            if (!m) { this.sheet.cellMerges[sy + r][sx + c] = null; continue; }
            if (m.mergedBy) {
              this.sheet.cellMerges[sy + r][sx + c] = {
                mergedBy: { r: m.mergedBy.r + sy, c: m.mergedBy.c + sx },
              };
            } else if (m.rowSpan) {
              this.sheet.cellMerges[sy + r][sx + c] = { rowSpan: m.rowSpan, colSpan: m.colSpan };
            }
          }
        }
      }

      this.selMode = 'cell'; this.sel = { r: sy, c: sx, r2: sy, c2: sx };
      this.render();
      this._fireChange();
    } finally {
      this._pasting = false;
    }
  }

  // ============================================================
  // ソート
  // ============================================================
  // 「元の行順」のデータ（二次元配列）を返す。
  // ソートはあくまで一時的な表示であり、保存（書き戻し）には元順を使う。
  //   - ソートしていない（originalOrder が無い）→ 現在の data をそのまま返す。
  //   - ソート表示中 → originalOrder の並びを基準に、ソート中に追加された行は
  //     末尾に付けて、元の順序を復元したデータを返す。
  // いずれも行配列は slice() で複製して返すので、呼び出し側の編集は元データに
  // 影響しない。
  getDataInOriginalOrder() {
    if (!this.originalOrder) {
      return this.sheet.data.map((r) => r.slice());
    }
    const set = new Set(this.originalOrder);
    const added = this.sheet.data.filter((r) => !set.has(r));
    const kept = this.originalOrder.filter((r) => this.sheet.data.indexOf(r) !== -1);
    return kept.concat(added).map((r) => r.slice());
  }

  // セルスタイルを「元の行順」で返す（getDataInOriginalOrder と対応）。
  // cellStyles が無い場合は null を返す。
  getStylesInOriginalOrder() {
    if (!this.sheet.cellStyles) { return null; }
    // 現在のデータ配列から、スタイル配列のインデックスを引いて並べ直す。
    const rowToStyleIdx = new Map();
    // sheet.data[r] の参照と this.sheet.cellStyles[r] の位置を結びつける（操作で
    // 並びがずれている可能性があるため）。data と cellStyles は常に同じ index で
    // 揃えて操作している前提（行追加・削除・移動・ペーストいずれも同期更新）。
    this.sheet.data.forEach((row, i) => { rowToStyleIdx.set(row, i); });

    const orderedRows = this.originalOrder
      ? (() => {
          const set = new Set(this.originalOrder);
          const added = this.sheet.data.filter((r) => !set.has(r));
          const kept = this.originalOrder.filter((r) => this.sheet.data.indexOf(r) !== -1);
          return kept.concat(added);
        })()
      : this.sheet.data;

    return orderedRows.map((row) => {
      const idx = rowToStyleIdx.get(row);
      if (idx == null) { return this.sheet.columns.map(() => null); }
      return (this.sheet.cellStyles[idx] || []).slice();
    });
  }

  applySort() {
    if (!this.sortState) {
      if (this.originalOrder) {
        const set = new Set(this.originalOrder);
        const added = this.sheet.data.filter((r) => !set.has(r));
        const kept = this.originalOrder.filter((r) => this.sheet.data.indexOf(r) !== -1);
        this.sheet.data = kept.concat(added);
        this.originalOrder = null;
      }
      this.render(); return;
    }
    if (!this.originalOrder) { this.originalOrder = this.sheet.data.slice(); }
    const c = this.sortState.c, dir = this.sortState.dir === 'desc' ? -1 : 1;
    const val = (x) => (x == null ? '' : String(x));
    const isNum = (x) => x !== '' && !isNaN(Number(x));
    this.sheet.data.sort((ra, rb) => {
      const a = val(ra[c]), b = val(rb[c]);
      if (a === '' && b !== '') { return 1; }
      if (a !== '' && b === '') { return -1; }
      if (isNum(a) && isNum(b)) { return (Number(a) - Number(b)) * dir; }
      return a.localeCompare(b, 'ja') * dir;
    });
    this.selMode = 'cell'; this.sel = { r: 0, c, r2: 0, c2: c };
    this.render();
    this._fireChange();
  }

  // ============================================================
  // 右クリックメニュー（行・列の挿入/削除）
  // ============================================================
  _onContextMenu(e) {
    // mousedown 時に立てた「右クリック直後はフォーカスで範囲を解除しない」
    // フラグを、ここで解除する。contextmenu まで来た時点で、右クリックに
    // 起因するフォーカスイベントは発火済み（または無関係）になっている。
    this._suppressFocusReselect = false;
    const rh = e.target.closest('td.tg-rowhead');
    const ch = e.target.closest('th.tg-colhead');
    const td = e.target.closest('td:not(.tg-rowhead)');
    e.preventDefault();
    const sheet = this.sheet;

    if (rh) {
      const r = parseInt(rh.dataset.r, 10);
      const lo = Math.min(this.sel.r, this.sel.r2), hi = Math.max(this.sel.r, this.sel.r2);
      const multi = (this.selMode === 'row') && (hi > lo) && (r >= lo && r <= hi);
      if (multi) {
        showCtx(e.clientX, e.clientY, [
          { label: (hi - lo + 1) + '行を削除', danger: true, action: () => this.deleteRowRange(lo, hi) },
        ]);
      } else {
        this.selMode = 'row'; this.sel = { r, c: 0, r2: r, c2: 0 }; this.render();
        showCtx(e.clientX, e.clientY, [
          { label: '上に行を挿入', action: () => {
            this.insertRowAt(r);
            this.selMode = 'cell'; this.sel = { r, c: 0 }; this.render(); } },
          { label: '下に行を挿入', action: () => {
            this.insertRowAt(r + 1);
            this.selMode = 'cell'; this.sel = { r: r + 1, c: 0 }; this.render(); } },
          { sep: true },
          { label: '行を削除', danger: true, action: () => this.deleteRowRange(r, r) },
        ]);
      }
      return;
    }
    if (ch) {
      const c = parseInt(ch.dataset.c, 10);
      const lo = Math.min(this.sel.c, this.sel.c2), hi = Math.max(this.sel.c, this.sel.c2);
      const multi = (this.selMode === 'col') && (hi > lo) && (c >= lo && c <= hi);
      if (multi) {
        const items = [
          { label: (hi - lo + 1) + '列を削除', danger: true, action: () => this.deleteColRange(lo, hi) },
        ];
        // 装飾項目を追加（Markdownなら太字/斜体のみ、Textileなら色/太字/斜体/下線）
        this._appendStyleItems(items, e.clientX, e.clientY, 'headers', { c1: lo, cc: hi });
        showCtx(e.clientX, e.clientY, items);
      } else {
        this.selMode = 'col'; this.sel = { r: 0, c, r2: 0, c2: c }; this.render();
        const items = [
          { label: '左に列を挿入', action: () => {
            this.insertColAt(c);
            this.selMode = 'cell'; this.sel = { r: 0, c }; this.render(); } },
          { label: '右に列を挿入', action: () => {
            this.insertColAt(c + 1);
            this.selMode = 'cell'; this.sel = { r: 0, c: c + 1 }; this.render(); } },
          { sep: true },
          { label: '列を削除', danger: true, action: () => this.deleteColRange(c, c) },
        ];
        // Textile モード: この列のヘッダに装飾を適用
        // 装飾項目を追加（Markdownなら太字/斜体のみ、Textileなら色/太字/斜体/下線）
        this._appendStyleItems(items, e.clientX, e.clientY, 'headers', { c1: c, cc: c });
        showCtx(e.clientX, e.clientY, items);
      }
      return;
    }
    if (td) {
      const r = parseInt(td.dataset.r, 10), c = parseInt(td.dataset.c, 10);
      const inRange = this.selMode === 'cell' && this.isRange() && (() => {
        const b = this.selBounds(); return r >= b.r1 && r <= b.rr && c >= b.c1 && c <= b.cc;
      })();
      if (inRange) {
        const b = this.selBounds();
        const items = [];
        if (b.rr > b.r1) { items.push({ label: (b.rr - b.r1 + 1) + '行を削除', danger: true, action: () => this.deleteRowRange(b.r1, b.rr) }); }
        if (b.cc > b.c1) { items.push({ label: (b.cc - b.c1 + 1) + '列を削除', danger: true, action: () => this.deleteColRange(b.c1, b.cc) }); }
        // 装飾項目を追加（Markdownなら太字/斜体のみ、Textileなら色/太字/斜体/下線）
        this._appendStyleItems(items, e.clientX, e.clientY, 'cells', b);
        // セル結合（Textileのみ。Markdownには標準構文がない）
        if (this.textileMode) {
          // 範囲が複数セルなら「セルを結合」、範囲内に既存の結合があれば「結合を解除」
          const isMultiCell = (b.rr > b.r1) || (b.cc > b.c1);
          const hasMerge = this.hasMergeInRange(b);
          if (isMultiCell || hasMerge) {
            items.push({ sep: true });
            if (isMultiCell) {
              items.push({ label: 'セルを結合', action: () => this.mergeCells(b) });
            }
            if (hasMerge) {
              items.push({ label: '結合を解除', action: () => this.unmergeCells(b) });
            }
          }
        }
        if (items.length) { showCtx(e.clientX, e.clientY, items); return; }
      }
      this.selMode = 'cell'; this.sel = { r, c }; this.render();
      const items = [
        { label: '上に行を挿入', action: () => {
          this.insertRowAt(r);
          this.sel = { r, c }; this.render(); } },
        { label: '下に行を挿入', action: () => {
          this.insertRowAt(r + 1);
          this.sel = { r: r + 1, c }; this.render(); } },
        { label: '左に列を挿入', action: () => {
          this.insertColAt(c);
          this.sel = { r, c }; this.render(); } },
        { label: '右に列を挿入', action: () => {
          this.insertColAt(c + 1);
          this.sel = { r, c: c + 1 }; this.render(); } },
        { sep: true },
        { label: '行を削除', danger: true, action: () => this.deleteRowRange(r, r) },
        { label: '列を削除', danger: true, action: () => this.deleteColRange(c, c) },
      ];
      // 装飾項目を追加（Markdownなら太字/斜体のみ、Textileなら色/太字/斜体/下線）
      const cellBounds = { r1: r, rr: r, c1: c, cc: c };
      this._appendStyleItems(items, e.clientX, e.clientY, 'cells', cellBounds);
      // Textile: このセルが結合の主または飲み込まれ側なら「結合を解除」を出す
      if (this.textileMode) {
        const m = getCellMerge(this.sheet, r, c);
        if (m && (m.rowSpan || m.mergedBy)) {
          items.push({ sep: true });
          items.push({ label: '結合を解除', action: () => this.unmergeCells(cellBounds) });
        }
      }
      showCtx(e.clientX, e.clientY, items);
    }
  }

  // 右クリックメニューに装飾項目を追加するヘルパ。
  // target は 'cells' か 'headers'。bounds は applyStyle と同じ形式。
  //
  // どの装飾を出すかはチケットのフォーマットで決める:
  //   Textile : 色 / 太字 / 斜体 / 下線
  //   Markdown: 太字 / 斜体       （色・下線は Markdown 標準で表現できないため）
  _appendStyleItems(items, x, y, target, bounds) {
    const self = this;
    items.push({ sep: true });

    // 色は Textile のみ
    if (this.textileMode) {
      items.push({
        label: '色を設定…',
        action: () => {
          showColorPicker(x, y, (color) => {
            self.applyStyle(target, bounds, { bg: color });
          });
        },
      });
    }

    // 太字 / 斜体は両モード対応
    const turnOnBold = this.shouldEnableAccent(target, bounds, 'bold');
    items.push({
      label: turnOnBold ? '太字にする' : '太字を解除',
      action: () => self.applyStyle(target, bounds, { bold: turnOnBold }),
    });
    const turnOnItalic = this.shouldEnableAccent(target, bounds, 'italic');
    items.push({
      label: turnOnItalic ? '斜体にする' : '斜体を解除',
      action: () => self.applyStyle(target, bounds, { italic: turnOnItalic }),
    });

    // 下線は Textile のみ
    if (this.textileMode) {
      const turnOnU = this.shouldEnableAccent(target, bounds, 'underline');
      items.push({
        label: turnOnU ? '下線にする' : '下線を解除',
        action: () => self.applyStyle(target, bounds, { underline: turnOnU }),
      });
    }

    // 揃え（左 / 中央 / 右 / クリア）。両モード対応。
    //   - Textile: セル単位で出力可能
    //   - Markdown: 列単位の指定しかできないため、出力時に列内の多数決で
    //     列の代表 align が決まる（toMarkdown の columnAlign 参照）。UI上は
    //     セル右クリックでも揃えを設定できるが、保存時に列の他のセルと
    //     合わせて決着する点に注意。
    items.push({ sep: true });
    items.push({
      label: '左揃え',
      action: () => self.applyStyle(target, bounds, { align: 'left' }),
    });
    items.push({
      label: '中央揃え',
      action: () => self.applyStyle(target, bounds, { align: 'center' }),
    });
    items.push({
      label: '右揃え',
      action: () => self.applyStyle(target, bounds, { align: 'right' }),
    });
    items.push({
      label: '揃えをクリア',
      action: () => self.applyStyle(target, bounds, { align: null }),
    });
  }
}

/* ============================================================
 * 6. 右クリックメニュー（モジュール内で1つを使い回す）
 * ============================================================ */
let _ctxEl = null;
function ensureCtx() {
  if (_ctxEl) { return _ctxEl; }
  _ctxEl = document.createElement('div');
  _ctxEl.className = 'tg-ctxmenu';
  document.body.appendChild(_ctxEl);
  document.addEventListener('mousedown', (e) => { if (!_ctxEl.contains(e.target)) { hideCtx(); } }, true);
  window.addEventListener('blur', hideCtx);
  window.addEventListener('scroll', hideCtx, true);
  return _ctxEl;
}
function hideCtx() { if (_ctxEl) { _ctxEl.style.display = 'none'; } }
function showCtx(x, y, items) {
  const ctx = ensureCtx();
  ctx.classList.remove('tg-colorpicker');
  ctx.innerHTML = '';
  items.forEach((it) => {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; ctx.appendChild(s); return; }
    const d = document.createElement('div');
    d.className = 'item' + (it.danger ? ' danger' : '');
    d.textContent = it.label;
    d.onclick = () => { hideCtx(); it.action(); };
    ctx.appendChild(d);
  });
  ctx.style.left = x + 'px'; ctx.style.top = y + 'px'; ctx.style.display = 'block';
}

// 固定パレット（淡い色味中心。Textile表でも視認しやすく、Redmineの白背景で
// 文字が読めること優先）。
const TB_PALETTE = [
  '#ffe5e5', // 淡い赤
  '#ffedcc', // 淡いオレンジ
  '#fef3c7', // 淡い黄
  '#e6f4ea', // 淡い緑
  '#d6eaff', // 淡い青
  '#e7e0ff', // 淡い紫
  '#f5e8da', // 淡い茶
  '#eeeeee', // 淡いグレー
];

// 色パレットを表示する。固定パレット + カスタム色 + 色をクリア。
//   x, y      : 表示位置（マウス座標）
//   onPick    : 色が選ばれたときに呼ばれる (colorHex | null) => void
//                null は「色をクリア」を意味する
function showColorPicker(x, y, onPick) {
  const ctx = ensureCtx();
  ctx.innerHTML = '';
  ctx.classList.add('tg-colorpicker');

  const palette = document.createElement('div');
  palette.className = 'tg-palette';
  TB_PALETTE.forEach((color) => {
    const sw = document.createElement('span');
    sw.className = 'tg-swatch';
    sw.style.backgroundColor = color;
    sw.title = color;
    sw.onclick = () => { hideCtx(); onPick(color); };
    palette.appendChild(sw);
  });
  ctx.appendChild(palette);

  // カスタム色（HTML標準のカラーピッカー）
  const customWrap = document.createElement('div');
  customWrap.className = 'tg-palette-custom';
  const customLabel = document.createElement('label');
  customLabel.textContent = 'カスタム色:';
  customLabel.className = 'tg-palette-label';
  customWrap.appendChild(customLabel);
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'tg-palette-input';
  custom.value = '#ffe5e5';
  custom.onchange = () => { hideCtx(); onPick(custom.value); };
  customWrap.appendChild(custom);
  ctx.appendChild(customWrap);

  // 色をクリア
  const clear = document.createElement('div');
  clear.className = 'item';
  clear.textContent = '色をクリア';
  clear.onclick = () => { hideCtx(); onPick(null); };
  ctx.appendChild(clear);

  ctx.style.left = x + 'px'; ctx.style.top = y + 'px'; ctx.style.display = 'block';
}



/* ============================================================
 * 7. 表ビルダー本体（パネル + タブ管理）
 *    本体 JS から initTableBuilder(ctx) で初期化する。
 *
 *    ctx = {
 *      wrapper  : エディタの wrapper 要素（この中にパネルを重ねる）
 *      format   : 'markdown' | 'textile'（既定の挿入フォーマット）
 *      t        : i18n 関数 (key, fallback) => string
 *      insert   : (text) => void   生成した表テキストをエディタへ挿入
 *      showEditor : () => void     本文（エディタ）表示へ戻すホスト側処理
 *    }
 * ============================================================ */
export function initTableBuilder(ctx) {
  const t = ctx.t || ((k, f) => f);

  let panel = null;          // オーバーレイパネル DOM（生成後は破棄せず表示/非表示）
  let tabBar = null;         // タブバー DOM
  let gridHost = null;       // グリッド描画領域 DOM
  let btnUpdate = null;      // 「更新」ボタン（バインド時のみ表示）
  let btnCopy = null;        // 「表をコピー」ボタン（新規タブで表示）
  let btnUndo = null;        // 「元に戻す」ボタン（履歴が無いと無効化）
  let btnRedo = null;        // 「やり直す」ボタン（履歴が無いと無効化）
  let errorBanner = null;    // インラインエラーバナー（更新失敗時に表示）
  const tabs = [];           // [{ id, matrix, grid, bound }]
                             //   bound: 既存表編集タブのバインド情報 or null
                             //     { format:'markdown'|'textile', commit:(text)=>bool, dirty:bool }
  let activeId = null;       // 'body' なら本文、数値文字列なら表タブ
  let lastActiveTableId = null; // 最後に開いていた表タブ（本文からの復帰先）
  let seq = 0;               // 表タブ採番

  // ---- パネル DOM の生成（初回のみ） ----
  function buildPanel() {
    const p = document.createElement('div');
    p.className = 'tg-panel';

    // タブバー
    tabBar = document.createElement('div');
    tabBar.className = 'tg-tabbar';
    p.appendChild(tabBar);

    // ツールボタン列（行/列追加・削除・挿入）
    const tools = document.createElement('div');
    tools.className = 'tg-tools';

    const mkTool = (label, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tg-toolbtn';
      b.textContent = label; b.title = title || label;
      b.addEventListener('click', onClick);
      return b;
    };

    tools.appendChild(mkTool(t('tb_add_row', '行追加'), t('tb_add_row', '行追加'), () => {
      const g = activeGrid(); if (!g) { return; }
      g.pushHistory();
      g.sheet.data.push(g.sheet.columns.map(() => ''));
      if (g.sheet.cellStyles) { g.sheet.cellStyles.push(g.sheet.columns.map(() => null)); }
      if (g.sheet.cellMerges) { g.sheet.cellMerges.push(g.sheet.columns.map(() => null)); }
      g.render(); markDirty(); syncUndoButtons();
    }));
    tools.appendChild(mkTool(t('tb_add_col', '列追加'), t('tb_add_col', '列追加'), () => {
      const g = activeGrid(); if (!g) { return; }
      g.pushHistory();
      g.sheet.columns.push('列' + (g.sheet.columns.length + 1));
      g.sheet.data.forEach((row) => row.push(''));
      if (g.sheet.headerStyles) { g.sheet.headerStyles.push(null); }
      if (g.sheet.cellStyles) { g.sheet.cellStyles.forEach((row) => row.push(null)); }
      if (g.sheet.cellMerges) { g.sheet.cellMerges.forEach((row) => row.push(null)); }
      g.render(); markDirty(); syncUndoButtons();
    }));
    // 行削除・列削除はツールバーには置かず、行番号/列ヘッダ/セルの右クリック
    // メニューから行う（誤操作防止と、対象を明示できるUIにするため）。

    // Undo / Redo ボタン。
    // ブラウザによっては Ctrl+Z などのキーがブラウザ独自ジェスチャ（戻る等）に
    // 取られて表ビルダーまで届かないため、確実な手段としてボタンを置く。
    // 対象操作: 装飾・揃え・行列追加削除・結合解除・ペースト・行列移動。
    // セル値の編集（textareaタイプ）は対象外（textarea自身のundoに任せる）。
    btnUndo = mkTool('↶', t('tb_undo', '元に戻す'), () => {
      const g = activeGrid(); if (!g) { return; }
      g.undo();
      syncUndoButtons();
      markDirty();
    });
    btnUndo.classList.add('tg-toolbtn-icon');
    tools.appendChild(btnUndo);
    btnRedo = mkTool('↷', t('tb_redo', 'やり直す'), () => {
      const g = activeGrid(); if (!g) { return; }
      g.redo();
      syncUndoButtons();
      markDirty();
    });
    btnRedo.classList.add('tg-toolbtn-icon');
    tools.appendChild(btnRedo);

    // 右寄せスペーサー
    const spacer = document.createElement('span');
    spacer.className = 'tg-tools-spacer';
    tools.appendChild(spacer);

    // 「更新」ボタン: 既存表にバインドされたタブでのみ表示する。
    // 押すと、開いた元の表ブロックへ現在の内容を書き戻す（フォーマットは
    // 元に合わせる）。通常の新規タブでは非表示。
    btnUpdate = mkTool(t('tb_update', '更新'), t('tb_update_tip', '元の表へ書き戻す'), () => commitActive());
    btnUpdate.classList.add('tg-toolbtn-primary');
    btnUpdate.style.display = 'none';
    tools.appendChild(btnUpdate);

    // 挿入ボタン（Markdown / Textile）。既定フォーマットを目立たせる。
    // 「表をコピー」ボタン。チケットの形式（Markdown/Textile）で自動的に
    // クリップボードへコピーする。挿入ではなくコピーにすることで、出力先が
    // 分かりづらい問題を避け、ユーザーが本文の好きな位置に貼れるようにする。
    btnCopy = mkTool(t('tb_copy_table', '表をコピー'), t('tb_copy_table_tip', 'この表をクリップボードにコピー'), () => copyActive());
    btnCopy.classList.add('tg-toolbtn-primary');
    tools.appendChild(btnCopy);

    p.appendChild(tools);

    // インラインのエラーバナー領域。
    // 更新失敗時（競合・対象消失）にメッセージを表示する。alert ダイアログ
    // よりも視認性がよく、案内文を構造的に出せる。通常は非表示。
    errorBanner = document.createElement('div');
    errorBanner.className = 'tg-banner tg-banner-error';
    errorBanner.style.display = 'none';
    p.appendChild(errorBanner);

    // グリッド描画領域（スクロール可）
    gridHost = document.createElement('div');
    gridHost.className = 'tg-gridhost';
    p.appendChild(gridHost);

    return p;
  }

  // ---- タブバーの再描画 ----
  function renderTabBar() {
    tabBar.innerHTML = '';

    // 「本文」タブ（常駐・閉じられない）
    const bodyTab = document.createElement('div');
    bodyTab.className = 'tg-tab' + (activeId === 'body' ? ' active' : '');
    const bodyLabel = document.createElement('span');
    bodyLabel.className = 'tg-tab-label';
    bodyLabel.textContent = t('tb_tab_body', '本文');
    bodyTab.appendChild(bodyLabel);
    bodyTab.addEventListener('click', () => showBody());
    tabBar.appendChild(bodyTab);

    // 表タブ（× で閉じられる）
    tabs.forEach((tb) => {
      const tab = document.createElement('div');
      tab.className = 'tg-tab' + (String(activeId) === String(tb.id) ? ' active' : '');
      const label = document.createElement('span');
      label.className = 'tg-tab-label';
      label.textContent = tb.matrix.name;
      tab.appendChild(label);
      const close = document.createElement('span');
      close.className = 'tg-tab-close';
      close.textContent = '×'; close.title = t('tb_close_tab', 'タブを閉じる');
      close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tb.id); });
      tab.appendChild(close);
      tab.addEventListener('click', () => switchTo(tb.id));
      tabBar.appendChild(tab);
    });

    // 「+」新規表タブ
    const plus = document.createElement('div');
    plus.className = 'tg-tab tg-tab-add';
    plus.textContent = '+';
    plus.title = t('tb_new_tab', '新しい表');
    plus.addEventListener('click', () => addTableTab());
    tabBar.appendChild(plus);
  }

  // ---- アクティブな表タブの Grid を返す ----
  function activeGrid() {
    const tb = tabs.find((x) => String(x.id) === String(activeId));
    return tb ? tb.grid : null;
  }

  // ---- Undo/Redo ボタンの活性状態を、現在のスタックに合わせて更新 ----
  // 各操作の後で呼ぶこと。スタックが空ならボタンを disabled に。
  function syncUndoButtons() {
    const g = activeGrid();
    const canUndo = !!(g && g.undoStack && g.undoStack.length);
    const canRedo = !!(g && g.redoStack && g.redoStack.length);
    if (btnUndo) { btnUndo.disabled = !canUndo; }
    if (btnRedo) { btnRedo.disabled = !canRedo; }
  }

  // ---- インラインエラーバナーの表示・消去 ----
  // 更新失敗時の案内を表の上に赤字で出す。alert より視認性がよく、
  // 案内文を改行付きで構造的に伝えられる。
  function showError(message) {
    if (!errorBanner) { return; }
    // 改行を保ったまま安全に表示する。
    errorBanner.textContent = message;
    errorBanner.style.display = '';
  }
  function clearError() {
    if (!errorBanner) { return; }
    errorBanner.style.display = 'none';
    errorBanner.textContent = '';
  }

  // ---- アクティブタブがバインド済みなら dirty を立てる ----
  function markDirty() {
    const tb = tabs.find((x) => String(x.id) === String(activeId));
    if (tb && tb.bound) { tb.bound.dirty = true; }
  }

  // ---- 新規表タブを追加して開く ----
  function addTableTab() {
    seq += 1;
    const id = String(seq);
    const matrix = createMatrix(t('tb_table_name', '表') + seq);
    tabs.push({ id, matrix, grid: null });
    switchTo(id);
  }

  // ---- 指定タブ（'body' or 表ID）へ切替 ----
  function switchTo(which) {
    if (which === 'body') { showBody(); return; }
    // タブを切り替えるときは前回のエラー表示を消す（表ごとに状況が変わる）。
    clearError();
    activeId = which;
    lastActiveTableId = which;
    // 先にパネルを可視化する。display:none のままグリッドを描画すると
    // scrollHeight が 0 になり、複数行セルの高さが測れず潰れてしまう。
    if (panel) { panel.style.display = 'flex'; }
    // グリッドを描画（初回はインスタンス生成、以降は再アタッチ）
    syncGrid();
    updateToolButtons();
    renderTabBar();
  }

  // ---- アクティブタブのバインド状態に応じてツールボタンを出し分ける ----
  //   バインド済み（既存表編集）: 「更新」を表示し、挿入ボタンを隠す。
  //   新規タブ                  : 「更新」を隠し、挿入ボタンを表示。
  function updateToolButtons() {
    const tb = tabs.find((x) => String(x.id) === String(activeId));
    const bound = tb && tb.bound;
    if (btnUpdate) { btnUpdate.style.display = bound ? '' : 'none'; }
    if (btnCopy) { btnCopy.style.display = bound ? 'none' : ''; }
  }

  // ---- gridHost にアクティブ表のグリッドを表示 ----
  function syncGrid() {
    if (!gridHost) { return; }
    gridHost.innerHTML = '';
    const tb = tabs.find((x) => String(x.id) === String(activeId));
    if (!tb) { return; }
    let firstShow = false; // この呼び出しで初めてDOMに乗ったかどうか
    if (!tb.grid) {
      tb.grid = new TableGrid(gridHost, tb.matrix);
      // Textile モードかどうかを Grid に教える（右クリックメニューの装飾項目の
      // 表示出し分けに使う）。
      tb.grid.textileMode = (ctx.format === 'textile');
      // バインドタブなら編集で dirty を立てる + ボタン状態を更新
      if (tb.bound) {
        const b = tb.bound;
        tb.grid.onChange = () => { b.dirty = true; syncUndoButtons(); };
      } else {
        tb.grid.onChange = () => { syncUndoButtons(); };
      }
      firstShow = true;
    } else {
      // 既存インスタンスの DOM を再アタッチ（状態保持）
      gridHost.appendChild(tb.grid.gridDiv);
      tb.grid.render();
      // 再アタッチ直後は DOM レイアウトが未確定で scrollHeight が正しく
      // 取れず、複数行セルの高さが1行に潰れることがある。レイアウト確定後
      // （次フレーム）に高さを測り直す。
      nextFrame(() => tb.grid.equalizeRows());
    }
    // 表ビルダーに切り替わった直後、左上(0,0)のセルへ自動フォーカスする。
    // 本文側のMonacoエディタにフォーカスが残っていると、ユーザーがそのまま
    // タイプしたときに本文が変わってしまう誤操作の元になるため。
    // 描画が確定してからフォーカスを当てたいので、次フレームで実行する。
    nextFrame(() => {
      if (!tb.grid || !tb.grid.gridDiv) { return; }
      const ta = tb.grid.gridDiv.querySelector(
        'textarea.tg-cell-ta[data-r="0"][data-c="0"]'
      );
      if (ta) { ta.focus(); }
    });
    // タブ切り替え or 初期表示直後にも Undo/Redo ボタンの状態を更新
    syncUndoButtons();
  }

  // 次フレームでコールバックを実行する小ヘルパ。
  // requestAnimationFrame が無い環境では setTimeout(0) にフォールバック。
  function nextFrame(cb) {
    if (window.requestAnimationFrame) { window.requestAnimationFrame(cb); }
    else { setTimeout(cb, 0); }
  }

  // ---- タブを閉じる。最後の表タブを閉じたら本文へ戻る ----
  function closeTab(id) {
    const idx = tabs.findIndex((x) => String(x.id) === String(id));
    if (idx === -1) { return; }
    const tb = tabs[idx];

    // バインドタブを未確定（編集あり）で閉じる場合は、書き戻すか破棄かを尋ねる。
    if (tb.bound && tb.bound.dirty && !tb.bound.committed) {
      const ok = window.confirm(t('tb_confirm_apply', '編集内容を元の表へ反映しますか？\n「キャンセル」を選ぶと変更は破棄されます。'));
      if (ok) {
        const data = tb.grid.getDataInOriginalOrder();
        const styles = tb.grid.getStylesInOriginalOrder();
        const text = (tb.bound.format === 'textile')
          ? toTextile(tb.grid.sheet.columns, data, tb.grid.sheet.headerStyles, styles, tb.grid.sheet.cellMerges)
          : toMarkdown(tb.grid.sheet.columns, data);
        const res = tb.bound.commit(text);
        const okCommit = (res === true) || (res && res.ok);
        if (!okCommit) {
          // 競合・対象消失で書き戻せなかった。閉じれば変更は失われるため、
          // 一旦中断してユーザーに退避の機会を与える（タブは閉じない）。
          const reason = res && res.reason;
          if (reason === 'conflict') {
            window.alert(t('tb_conflict_close',
              '本文側でこの表が変更されているため、反映できませんでした。\n\n'
              + 'このタブを閉じると編集内容は失われます。必要な場合は表を'
              + 'コピーして退避してから閉じてください。'));
          }
          return; // 閉じずに残す
        }
        tb.bound.committed = true;
      }
    }

    // バインドの追跡 decoration を後始末する（更新ボタン経由で既に commit
    // 済みの場合、commit 内で追跡は破棄されているので onClose は冪等に動く）。
    if (tb.bound && tb.bound.onClose && !tb.bound.committed) {
      tb.bound.onClose();
    }

    if (tb.grid) { tb.grid.dispose(); }
    tabs.splice(idx, 1);
    if (lastActiveTableId === id) { lastActiveTableId = null; }
    if (!tabs.length) { showBody(); return; }
    // 閉じたのがアクティブタブなら隣へ移る
    if (String(activeId) === String(id)) {
      const next = tabs[Math.min(idx, tabs.length - 1)];
      switchTo(next.id);
    } else {
      renderTabBar();
    }
  }

  // ---- 本文（エディタ）へ戻る。パネルは隠すだけ（中身は保持） ----
  function showBody() {
    activeId = 'body';
    if (panel) { panel.style.display = 'none'; }
    if (tabBar) { renderTabBar(); }
    hideCtx();
    if (ctx.showEditor) { ctx.showEditor(); }
  }

  // ---- アクティブ表を、チケットの形式でクリップボードへコピー ----
  // フォーマットは ctx.format（detectFormat の結果＝チケットが Markdown か
  // Textile か）に従う。ソートは一時表示なので元の行順で出力する。
  function copyActive() {
    const g = activeGrid();
    if (!g) { return; }
    const data = g.getDataInOriginalOrder();
    const styles = g.getStylesInOriginalOrder();
    const text = (ctx.format === 'textile')
      ? toTextile(g.sheet.columns, data, g.sheet.headerStyles, styles, g.sheet.cellMerges)
      : toMarkdown(g.sheet.columns, data);
    if (ctx.copy) { ctx.copy(text); }
  }

  // ---- バインド済みタブの内容を元の表へ書き戻す（「更新」ボタン） ----
  // フォーマットは元の表に合わせる。commit が false を返したら（対象範囲が
  // 失われている等）失敗とみなし、タブを閉じずに残す。
  function commitActive() {
    const tb = tabs.find((x) => String(x.id) === String(activeId));
    if (!tb || !tb.bound) { return false; }
    const g = tb.grid;
    if (!g) { return false; }
    // ソートは一時表示。書き戻しは元の行順で行う。
    const data = g.getDataInOriginalOrder();
    const styles = g.getStylesInOriginalOrder();
    const text = (tb.bound.format === 'textile')
      ? toTextile(g.sheet.columns, data, g.sheet.headerStyles, styles, g.sheet.cellMerges)
      : toMarkdown(g.sheet.columns, data);
    // 直前のエラー表示はいったん消してから commit を試みる。
    clearError();
    const res = tb.bound.commit(text);
    // commit の戻り値は { ok, reason } オブジェクト（後方互換で true も許容）。
    const ok = (res === true) || (res && res.ok);
    if (ok) {
      // 書き戻し成功。このタブを閉じてから、他のタブの有無に関わらず本文
      // （エディタ）へ戻る。編集の自然な終わりとして本文で結果を確認できる。
      tb.bound.dirty = false;
      tb.bound.committed = true; // closeTab 内の確認・onClose をスキップ
      const tabId = tb.id;
      const idx = tabs.findIndex((x) => String(x.id) === String(tabId));
      if (idx !== -1) {
        const closing = tabs[idx];
        if (closing.grid) { closing.grid.dispose(); }
        tabs.splice(idx, 1);
        if (lastActiveTableId === tabId) { lastActiveTableId = null; }
      }
      showBody();
      return true;
    }
    // 失敗時は表の上に赤字で案内する。タブは閉じない（編集内容を失わせない）。
    const reason = res && res.reason;
    if (reason === 'conflict') {
      showError(t('tb_conflict',
        '本文側でこの表が変更されているため、更新できません。\n'
        + 'この表ビルダーの内容が必要な場合は、表を全選択（左上の角をクリック）してコピーし、別の場所へ退避してください。\n'
        + 'その後この編集タブを閉じ、本文の最新の表をもう一度開いて編集し直してください。'));
    } else if (reason === 'gone') {
      showError(t('tb_gone',
        '書き戻し先の表が本文から見つかりません（削除された可能性があります）。\n'
        + 'この編集タブを閉じ、必要なら本文へ新規に挿入し直してください。'));
    }
    return false;
  }

  // ============================================================
  // 公開 API
  // ============================================================

  // 表ビルダーボタン押下時の入口。
  function open() {
    if (!panel) {
      panel = buildPanel();
      ctx.wrapper.appendChild(panel);
      addTableTab(); // 最初の表タブ（表1）
      return;
    }
    if (!tabs.length) { addTableTab(); return; }
    // 最後に開いていた表タブ（無効なら末尾）へ戻る
    const target = tabs.some((tb) => String(tb.id) === String(lastActiveTableId))
      ? lastActiveTableId
      : tabs[tabs.length - 1].id;
    switchTo(target);
  }

  function destroy() {
    tabs.forEach((tb) => { if (tb.grid) { tb.grid.dispose(); } });
    tabs.length = 0;
    if (panel && panel.parentNode) { panel.parentNode.removeChild(panel); }
    panel = null; tabBar = null; gridHost = null; activeId = null;
    btnUpdate = null; btnCopy = null; btnUndo = null; btnRedo = null; errorBanner = null;
  }

  // ============================================================
  // 既存表をバインドして開く（glyph margin のアイコンから呼ばれる）
  //   text   : 元の表ブロックのテキスト（Markdown or Textile）
  //   format : 'markdown' | 'textile'
  //   commit : (newText:string) => boolean   書き戻しコールバック
  //            （元の行範囲を newText で差し替える。成功なら true）
  //
  // 既に同じ範囲にバインドしたタブが開いていれば、それを再利用してそこへ
  // 切り替える（同じ表のタブが量産されないように）。バインドの一意キーは
  // ホスト側から渡される key（decoration の ID 等）を使う。
  // ============================================================
  function openForText(text, format, commit, key, onClose) {
    if (!panel) {
      panel = buildPanel();
      ctx.wrapper.appendChild(panel);
    }
    // 既存の同一バインドタブがあれば再利用する（同じ表は1タブに集約）。
    // commit / onClose は最新のものに差し替える（追跡 decoration が作り直されて
    // いる可能性があるため、古いコールバックを使い続けない）。
    if (key != null) {
      const exist = tabs.find((x) => x.bound && x.bound.key === key);
      if (exist) {
        exist.bound.commit = commit;
        exist.bound.onClose = onClose;
        switchTo(exist.id);
        return;
      }
    }

    const matrix = textToMatrix(text, format);
    seq += 1;
    const id = String(seq);
    matrix.name = t('tb_table_name', '表') + seq;
    const bound = { format: format, commit: commit, dirty: false, key: key, onClose: onClose };
    tabs.push({ id, matrix, grid: null, bound });
    switchTo(id);
  }

  // テキスト（Markdown/Textile表）→ matrix へ変換。
  // 1行目をヘッダとして扱う。パースできなければ空表を返す。
  // Markdown は太字・斜体、Textile は背景色・太字・斜体・下線の装飾を復元する。
  function textToMatrix(text, format) {
    if (format === 'textile') {
      const parsed = parseTextileWithStyles(text);
      if (parsed && parsed.rows.length) { return textileParsedToMatrix(parsed); }
      // フォールバック: Markdown としてパース（Textile装飾は失われるが、太字・斜体は復元）
      const mdParsed = parseMarkdownWithStyles(text);
      if (mdParsed && mdParsed.rows.length) { return markdownParsedToMatrix(mdParsed); }
      return createMatrix('表');
    }
    // Markdown 経路: 太字・斜体の装飾を復元する
    const mdParsed = parseMarkdownWithStyles(text);
    if (mdParsed && mdParsed.rows.length) { return markdownParsedToMatrix(mdParsed); }
    // フォールバック: Textile としてパース
    const tx = parseTextileWithStyles(text);
    if (tx && tx.rows.length) { return textileParsedToMatrix(tx); }
    return createMatrix('表');
  }

  // parseMarkdownWithStyles の結果から、装飾入りの matrix を作る。
  function markdownParsedToMatrix(parsed) {
    const columns = parsed.rows[0].slice();
    const headerStyles = parsed.styles[0].map((s) => s);
    const data = [];
    const cellStyles = [];
    for (let i = 1; i < parsed.rows.length; i++) {
      const row = parsed.rows[i].slice();
      const styleRow = parsed.styles[i].slice();
      while (row.length < columns.length) { row.push(''); styleRow.push(null); }
      data.push(row.slice(0, columns.length));
      cellStyles.push(styleRow.slice(0, columns.length));
    }
    if (!data.length) {
      data.push(columns.map(() => ''));
      cellStyles.push(columns.map(() => null));
    }
    const anyHeader = headerStyles.some((s) => s);
    const anyCell = cellStyles.some((row) => row.some((s) => s));
    return {
      name: '表',
      columns,
      data,
      cellStyles: anyCell ? cellStyles : null,
      headerStyles: anyHeader ? headerStyles : null,
    };
  }

  // parseTextileWithStyles の結果から、装飾入りの matrix を作る。
  function textileParsedToMatrix(parsed) {
    const columns = parsed.rows[0].slice();
    const headerStyles = parsed.styles[0].map((s) => s);
    const data = [];
    const cellStyles = [];
    const cellMerges = [];
    // 1行目はヘッダ行なので、結合のインデックスもデータ行ベース（i-1）にずらす。
    // ヘッダ自体は結合対象外（一般的にヘッダ行を縦結合に巻き込まない運用）。
    for (let i = 1; i < parsed.rows.length; i++) {
      const row = parsed.rows[i].slice();
      const styleRow = parsed.styles[i].slice();
      const mergeRow = (parsed.merges && parsed.merges[i]) ? parsed.merges[i].slice() : columns.map(() => null);
      while (row.length < columns.length) { row.push(''); styleRow.push(null); mergeRow.push(null); }
      data.push(row.slice(0, columns.length));
      cellStyles.push(styleRow.slice(0, columns.length));
      cellMerges.push(mergeRow.slice(0, columns.length));
    }
    // mergedBy の参照行番号を「データ行ベース」にずらす（パース時はヘッダ込みの行番号）
    cellMerges.forEach((row) => {
      row.forEach((m, ci) => {
        if (m && m.mergedBy) { m.mergedBy = { r: m.mergedBy.r - 1, c: m.mergedBy.c }; }
      });
    });
    if (!data.length) {
      data.push(columns.map(() => ''));
      cellStyles.push(columns.map(() => null));
      cellMerges.push(columns.map(() => null));
    }
    const anyHeader = headerStyles.some((s) => s);
    const anyCell = cellStyles.some((row) => row.some((s) => s));
    const anyMerge = cellMerges.some((row) => row.some((m) => m));
    return {
      name: '表',
      columns,
      data,
      cellStyles: anyCell ? cellStyles : null,
      headerStyles: anyHeader ? headerStyles : null,
      cellMerges: anyMerge ? cellMerges : null,
    };
  }

  return { open, showBody, destroy, openForText };
}

// テスト・再利用のため変換関数も名前付きエクスポート
export { toMarkdown, toTextile, parseMarkdown, parseTsv, parseTextile, parseTextileWithStyles, parseMarkdownWithStyles };
