/* ============================================================
   Redmine Monaco Editor Plugin
   ============================================================
   RedmineのテキストエリアをMonaco Editor（VS Codeのエンジン）に
   置き換えるプラグイン。完全オフライン（Monaco同梱・外部API不使用）。

   このファイルの構成（上から順に）:
     1. Monacoローダー / フォーマット判定 / 見出し解析    … 基盤ユーティリティ
     2. 言語登録（フェンス言語・Textile簡易・エイリアス）  … シンタックスハイライト
     3. アウトライン用シンボル / @メンション補完           … Monaco言語機能
     4. チケット・ユーザー情報の取得（HTMLスクレイプ）     … #1010 / @mention 用
     5. キャレット連動ツールチップ                         … #1010 ホバー
     6. 共通ポップアップコントローラ / SVGアイコン定義      … UI部品
     7. プレビュー取得（Redmine純正APIへ委譲）
     8. replaceTextarea                                    … エディタ本体の組み立て（中核）
     9. メンション確定・アウトライン・スクロール同期        … エディタ付随機能
    10. スプリッター / 高さリサイズ / 純正UI非表示
    11. 装飾ツールバー / 表・画像・ファイルリンクの各ピッカー
    12. 添付ファイル収集（ピッカー共通）/ 各種フォーマッタ
    13. initEditors                                        … エントリポイント

   設計メモ:
   - 記法はMarkdown/Textile両対応。判定は textarea の
     data-(list-)autofill-text-formatting-param を読む（detectFormat）。
     挿入記法は SYNTAX テーブルで一元管理し、各ボタンはテーブル経由で出し分ける。
   - REST API(.json)は使わず、画面内DOMや通常HTMLページから情報を取る
     （セキュリティ方針。トークン露出やAPI権限への依存を避ける）。
   ============================================================ */

(function () {
  'use strict';

  // ============================================================
  // i18n（多言語対応）
  // ============================================================
  // サーバ側（init.rb のビューフック）が、現在のユーザー言語で解決した
  // 翻訳辞書を window.MONACO_EDITOR_I18N に埋め込んでいる。
  // t(key) はそのキーを引く。辞書が無い／キーが無い場合は、
  // 第2引数のフォールバック文字列（または key 自体）を返す。
  var I18N = (typeof window !== 'undefined' && window.MONACO_EDITOR_I18N) || {};
  function t(key, fallback) {
    if (Object.prototype.hasOwnProperty.call(I18N, key)) {
      return I18N[key];
    }
    return (fallback !== undefined) ? fallback : key;
  }

  // ユーザー個人設定（init.rb が window.MONACO_EDITOR_PREFS に埋め込む）。
  //   { enabled: bool, theme: string, font_size: number, ... }
  // サーバ側で無効ユーザーにはそもそもこのJSを読み込ませないが、
  // キャッシュ等でJSだけ読まれた場合の保険として、ここでも参照する。
  // 将来 theme / font_size をMonacoのoptionへ反映する際もここを使う。
  var PREFS = (typeof window !== 'undefined' && window.MONACO_EDITOR_PREFS) || {};
  function prefEnabled() {
    // 設定が無い（旧来どおり）場合は true（後方互換：従来は常に有効だった）
    if (!Object.prototype.hasOwnProperty.call(PREFS, 'enabled')) { return true; }
    return [true, 'true', '1', 1].indexOf(PREFS.enabled) !== -1 || PREFS.enabled === true;
  }

  // 個人設定のフォントサイズを取得する。
  // 不正値（数値でない・極端な値）は既定14pxにフォールバックし、
  // 安全な範囲（8〜40px）にクランプする（エディタが壊れないように）。
  function prefFontSize() {
    var DEFAULT = 14, MIN = 8, MAX = 40;
    var v = parseInt(PREFS.font_size, 10);
    if (isNaN(v)) { return DEFAULT; }
    if (v < MIN) { return MIN; }
    if (v > MAX) { return MAX; }
    return v;
  }

  // ============================================================
  // Monaco ローダー（public直下に配置したvsを参照）
  // ============================================================
  // Monacoは内部で vs/loader.js → vs/editor/... と素のパスで大量の
  // サブファイルを動的ロードする。Redmine 6のPropshaftはアセットを
  // ハッシュ付きURL(/assets/...-<hash>.js)でしか配信しないため、
  // Monacoのローダーとは相性が悪い（素パスは404になる）。
  // そこで vs/ だけは public 直下（/monaco_assets/vs/）に配置し、
  // Railsの静的ファイル配信で素パスのまま返す。
  // この配置は entrypoint.sh が起動時に自動で行う。
  function getMonacoBase() {
    return '/monaco_assets/vs';
  }

  // ============================================================
  // オーバーフローウィジェットの配置先ノード（エディタ毎・wrapper内）
  // ============================================================
  // fixedOverflowWidgets: true のとき、Monacoはホバー・補完・詳細パネルを
  // この要素の中に絶対配置する。
  //
  // 配置先を「そのエディタの wrapper の中」に作るのが要点:
  //   - body直下だと、ネイティブFullscreen API が全画面化した wrapper の
  //     子孫しか描画しないため、フルスクリーン中に補完/ツールチップが
  //     まったく出なくなる。wrapper内なら一緒に全画面表示される。
  //   - position:fixed + inset:0 でビューポートに重ね、Monacoが書き込む
  //     top/left をビューポート座標に一致させる（詳細パネルが画面外へ
  //     飛ぶ問題の解消）。
  //   - .monaco-editor クラスを付けてウィジェットCSSのスコープを確保する
  //     （無いと二重表示・透け等の崩れが出る）。
  function createOverflowWidgetsNode(wrapper, themeName) {
    var el = document.createElement('div');
    el.className = 'monaco-editor monaco-overflow-widgets-root';
    // 配置先ノードにもテーマのベースクラス(vs / vs-dark)を付ける。
    // 補完候補の色などテーマ別CSSは .monaco-editor.vs-dark ... で
    // スコープしているため、このノードに vs-dark が無いと、ウィジェットが
    // ここへ配置されたとき色が当たらない（暗背景で暗文字になる）。
    var isDark = /dark/i.test(themeName || '');
    el.classList.add(isDark ? 'vs-dark' : 'vs');
    el.style.position = 'fixed';
    el.style.top = '0';
    el.style.left = '0';
    el.style.zIndex = '50000';
    // pointer-events は CSS 側で制御（コンテナ none / 子 auto）。

    wrapper.appendChild(el);

    // --- Monaco v0.52 の座標系ズレ補正（詳細パネルのみ） ---
    // この配置先ノードの中で、Monacoは用途別に2つの入れ物を作る:
    //   .overflowingContentWidgets … 補完リスト本体・ホバー（ビューポート座標。正しい）
    //   .overflowingOverlayWidgets … 補完の詳細パネル(.suggest-details-container)
    //                                 こちらだけ top にページ絶対座標(スクロール込み)が
    //                                 入り、fixed基準とズレて画面外(例 top:5001px)へ飛ぶ。
    // そこで overlay 側の入れ物だけを top:-scrollY ぶん持ち上げて相殺する。
    //   子の実画面位置 = overlay top(-scrollY) + パネル top(ページ絶対)
    //                  = ページ絶対 - scrollY = ビューポート座標 ✓
    // content 側（補完本体・ホバー）には触れないので、それらの位置は不変。
    function syncOverlayOffset() {
      var overlay = el.querySelector('.overflowingOverlayWidgets');
      if (!overlay) { return; }
      // 入れ物自体は元々 top:0/relative 等。fixedなノード内で transform を
      // 使って持ち上げる（レイアウトに影響しない・GPU合成で軽い）。
      var y = window.scrollY || window.pageYOffset || 0;
      overlay.style.transform = 'translateY(' + (-y) + 'px)';
    }
    // overlay は遅延生成されるので、スクロール/リサイズの度に補正し、
    // 初回生成タイミングを取りこぼさないよう軽いポーリングでも追従する。
    window.addEventListener('scroll', syncOverlayOffset, { passive: true });
    window.addEventListener('resize', syncOverlayOffset, { passive: true });
    // 補完が開くたびに overlay が作られる/位置が変わるため、こまめに同期。
    setInterval(syncOverlayOffset, 150);

    return el;
  }

  // ============================================================
  // テキストフォーマット判定（Markdown / Textile）
  // ============================================================
  // Redmineのtextareaは data-autofill-text-formatting-param に
  // "markdown" / "common_mark" / "textile" のいずれかを持つ。
  // これを読んでフォーマットを判定する。取得できなければ markdown 扱い。
  function detectFormat(textarea) {
    if (!textarea) { return 'markdown'; }

    // フォーマット情報を持つ data 属性は画面によって名前が異なる。
    //   チケット/wiki本文 : data-list-autofill-text-formatting-param
    //   管理画面等         : data-autofill-text-formatting-param
    // 両方を順に試し、取れた値で判定する。
    var fmt =
      (textarea.dataset.listAutofillTextFormattingParam ||
       textarea.dataset.autofillTextFormattingParam ||
       textarea.getAttribute('data-list-autofill-text-formatting-param') ||
       textarea.getAttribute('data-autofill-text-formatting-param') ||
       '').toLowerCase();

    if (fmt.indexOf('textile') !== -1) { return 'textile'; }
    // markdown / common_mark / その他はすべて markdown として扱う
    return 'markdown';
  }

  // 画像/添付記法のパス部分をエスケープ。
  // スペースを含むファイル名はMarkdownでは ![](a b.png) のように解釈が壊れ
  // (最初のスペース以降がタイトル扱いになる)、Textileの !a b.png! も成立しない。
  // ファイル名全体をencodeURIComponentするとスラッシュや日本語まで壊れるため、
  // 記法を壊す文字だけを最小限エスケープする。Redmineのattachment解決は
  // デコード後のファイル名で照合されるため %20 等にしても表示・リンクは成立する。
  function encodeImagePath(filename) {
    return String(filename)
      .replace(/%/g, '%25')   // 先に % を退避（二重エンコード防止）
      .replace(/ /g, '%20')
      .replace(/\(/g, '%28')  // Markdownの ](...) 閉じ括弧との衝突回避
      .replace(/\)/g, '%29');
  }

  // フォーマット別の挿入記法テーブル。
  // 装飾ツールバーの各操作は、このテーブルを介して記法を出し分ける。
  var SYNTAX = {
    markdown: {
      bold:        { type: 'wrap', prefix: '**', suffix: '**', placeholder: t('placeholder_text', 'text') },
      italic:      { type: 'wrap', prefix: '*',  suffix: '*',  placeholder: t('placeholder_text', 'text') },
      underline:   { type: 'wrap', prefix: '<u>', suffix: '</u>', placeholder: t('placeholder_text', 'text') },
      strike:      { type: 'wrap', prefix: '~~', suffix: '~~', placeholder: t('placeholder_text', 'text') },
      codeInline:  { type: 'wrap', prefix: '`',  suffix: '`',  placeholder: t('placeholder_code', 'code') },
      h1:          { type: 'line', prefix: '#',    exact: true },
      h2:          { type: 'line', prefix: '##',   exact: true },
      h3:          { type: 'line', prefix: '###',  exact: true },
      h4:          { type: 'line', prefix: '####', exact: true },
      ul:          { type: 'line', prefix: '- ',  exact: false },
      ol:          { type: 'line', prefix: '1. ', exact: false, ordered: true },
      blockquote:  { type: 'line', prefix: '> ',  exact: false },
      codeBlock:   { type: 'mdfence' },
      image:       function (filename, alt) { return '![' + (alt || '') + '](' + encodeImagePath(filename) + ')'; }
    },
    textile: {
      bold:        { type: 'wrap', prefix: '*',  suffix: '*',  placeholder: t('placeholder_text', 'text') },
      italic:      { type: 'wrap', prefix: '_',  suffix: '_',  placeholder: t('placeholder_text', 'text') },
      underline:   { type: 'wrap', prefix: '+',  suffix: '+',  placeholder: t('placeholder_text', 'text') },
      strike:      { type: 'wrap', prefix: '-',  suffix: '-',  placeholder: t('placeholder_text', 'text') },
      codeInline:  { type: 'wrap', prefix: '@',  suffix: '@',  placeholder: t('placeholder_code', 'code') },
      h1:          { type: 'line', prefix: 'h1.', exact: true, textile: true },
      h2:          { type: 'line', prefix: 'h2.', exact: true, textile: true },
      h3:          { type: 'line', prefix: 'h3.', exact: true, textile: true },
      h4:          { type: 'line', prefix: 'h4.', exact: true, textile: true },
      ul:          { type: 'line', prefix: '* ',  exact: false },
      ol:          { type: 'line', prefix: '# ',  exact: false },
      blockquote:  { type: 'line', prefix: 'bq. ', exact: false },
      codeBlock:   { type: 'pretag' },   // <pre><code>...</code></pre>
      image:       function (filename) { return '!' + encodeImagePath(filename) + '!'; }
    }
  };

  function syntaxFor(format) {
    return SYNTAX[format] || SYNTAX.markdown;
  }

  // ============================================================
  // 見出し行の解析（Markdown / Textile 両対応）
  // ============================================================
  // 1行を見出しとして解析し、{ level, text } を返す。見出しでなければ null。
  //   markdown: "## タイトル"        → level=2
  //   textile : "h2. タイトル"        → level=2
  // format省略時は両方の記法を試す（どちらでも拾えるようにする）。
  function parseHeadingLine(line, format) {
    // Markdown: # 〜 ######
    if (format !== 'textile') {
      var mdm = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (mdm) { return { level: mdm[1].length, text: mdm[2] }; }
      if (format === 'markdown') { return null; }
    }
    // Textile: h1. 〜 h6.（行頭、ドットの後にスペース）
    var txm = /^h([1-6])\.\s+(.+?)\s*$/.exec(line);
    if (txm) { return { level: parseInt(txm[1], 10), text: txm[2] }; }
    return null;
  }


  function loadMonaco(callback) {
    if (window.monaco) {
      callback();
      return;
    }

    var vsBase = getMonacoBase();

    // AMD loader（同梱のloader.js）
    var loaderScript = document.createElement('script');
    loaderScript.src = vsBase + '/loader.js';
    loaderScript.onload = function () {
      require.config({ paths: { vs: vsBase } });
      require(['vs/editor/editor.main'], function () {
        // コードフェンス（```bash 等）内を言語別にハイライトするため、
        // よく使う言語のトークナイザを事前ロードしておく。
        // editor.main が basic-languages の全言語を「登録」済みなので、
        // markdownの埋め込みハイライトはフェンス言語を解釈できる。
        preloadFenceLanguages(function () {
          callback();
        });
      });
    };
    document.head.appendChild(loaderScript);
  }

  // ============================================================
  // コードフェンス用に主要言語のトークナイザを事前ロード
  // ============================================================
  function preloadFenceLanguages(done) {
    // basic-languages 配下のモジュールを require して登録を確定させる。
    // パスは vs/basic-languages/<lang>/<lang>
    var langs = [
      'shell', 'sql', 'yaml', 'python', 'perl', 'ruby',
      'typescript', 'javascript', 'cpp', 'java', 'go', 'rust',
      'html', 'css', 'ini', 'dockerfile', 'xml', 'php', 'powershell',
      'lua', 'scala', 'kotlin', 'swift', 'r', 'dart'
    ];
    var modules = langs.map(function (l) {
      return 'vs/basic-languages/' + l + '/' + l;
    });

    try {
      require(modules, function () {
        registerLanguageAliases();
        registerMarkdownOutline(window.monaco);
        registerTextileLanguage(window.monaco);
        registerCustomThemes(window.monaco);
        registerMentionCompletion(window.monaco);
        registerMacroCompletion(window.monaco);
        registerWikiLinkCompletion(window.monaco);
        done();
      }, function () {
        // 一部失敗しても続行（存在しない言語があっても無視）
        registerLanguageAliases();
        registerMarkdownOutline(window.monaco);
        registerTextileLanguage(window.monaco);
        registerCustomThemes(window.monaco);
        registerMentionCompletion(window.monaco);
        registerMacroCompletion(window.monaco);
        registerWikiLinkCompletion(window.monaco);
        done();
      });
    } catch (e) {
      done();
    }
  }

  // ============================================================
  // カスタムテーマ（GitHub Light / Quiet Light / GitHub Dark）
  // ============================================================
  // 個人設定の theme 値で選択する。値とMonacoテーマ名の対応:
  //   "github-light" → mco-github-light
  //   "quiet-light"  → mco-quiet-light
  //   "github-dark"  → mco-github-dark
  //   （上記以外/未設定 → 'vs'（Monaco組み込みの標準ライト））
  // 配色は GitHub 公式テーマ(primer/github-vscode-theme)等を基にした近似。
  var customThemesRegistered = false;
  function registerCustomThemes(monaco) {
    if (!monaco || customThemesRegistered) { return; }
    customThemesRegistered = true;

    // --- GitHub Light ---
    // 背景 #ffffff / 文字 #24292f。GitHubのコード表示でおなじみの配色。
    monaco.editor.defineTheme('mco-github-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: '',         foreground: '24292f' },
        { token: 'comment',  foreground: '6e7781', fontStyle: 'italic' },
        { token: 'keyword',  foreground: 'cf222e' },
        { token: 'string',   foreground: '0a3069' },
        { token: 'number',   foreground: '0550ae' },
        { token: 'regexp',   foreground: '116329' },
        { token: 'type',     foreground: '953800' },
        { token: 'class',    foreground: '953800' },
        { token: 'function', foreground: '8250df' },
        { token: 'variable', foreground: '24292f' },
        { token: 'constant', foreground: '0550ae' },
        { token: 'operator', foreground: 'cf222e' },
        { token: 'tag',      foreground: '116329' },
        { token: 'attribute.name', foreground: '0550ae' },
        // Markdown
        { token: 'keyword.md',   foreground: '0550ae' }, // 見出し等
        { token: 'string.link.md', foreground: '0a3069' },
        // Textile（自前Monarch: keyword=見出し, strong/emphasis 等）
        { token: 'strong',   foreground: '24292f', fontStyle: 'bold' },
        { token: 'emphasis', foreground: '24292f', fontStyle: 'italic' }
      ],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#24292f',
        'editorLineNumber.foreground': '#8c959f',
        'editorLineNumber.activeForeground': '#24292f',
        'editor.selectionBackground': '#0969da33',
        'editor.lineHighlightBackground': '#f6f8fa',
        'editorCursor.foreground': '#24292f',
        'editorIndentGuide.background': '#eaecef',
        'editorWhitespace.foreground': '#d0d7de'
      }
    });

    // --- Quiet Light ---
    // 背景 #f5f5f5 のやや暖色。主張控えめで落ち着いた配色。
    monaco.editor.defineTheme('mco-quiet-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: '',         foreground: '333333' },
        { token: 'comment',  foreground: 'aaaaaa', fontStyle: 'italic' },
        { token: 'keyword',  foreground: '4b69c6' },
        { token: 'string',   foreground: '448c27' },
        { token: 'number',   foreground: 'ab6526' },
        { token: 'regexp',   foreground: '4b69c6' },
        { token: 'type',     foreground: '7a3e9d' },
        { token: 'class',    foreground: '7a3e9d' },
        { token: 'function', foreground: 'aa3731' },
        { token: 'variable', foreground: '333333' },
        { token: 'constant', foreground: 'ab6526' },
        { token: 'operator', foreground: '777777' },
        { token: 'tag',      foreground: '4b69c6' },
        { token: 'attribute.name', foreground: 'aa3731' },
        { token: 'keyword.md',   foreground: '7a3e9d' },
        { token: 'string.link.md', foreground: '448c27' },
        { token: 'strong',   foreground: '333333', fontStyle: 'bold' },
        { token: 'emphasis', foreground: '333333', fontStyle: 'italic' }
      ],
      colors: {
        'editor.background': '#f5f5f5',
        'editor.foreground': '#333333',
        'editorLineNumber.foreground': '#b3b3b3',
        'editorLineNumber.activeForeground': '#333333',
        'editor.selectionBackground': '#c9d0d9',
        'editor.lineHighlightBackground': '#ececec',
        'editorCursor.foreground': '#54494b',
        'editorIndentGuide.background': '#e0e0e0',
        'editorWhitespace.foreground': '#d6d6d6'
      }
    });

    // --- GitHub Dark ---
    // 背景 #25292E / 文字 #c9d1d9。GitHubのダーク表示の配色（背景は調整版）。
    monaco.editor.defineTheme('mco-github-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: '',         foreground: 'E1E4E8' },
        { token: 'comment',  foreground: '6A9955', fontStyle: 'italic' },
        { token: 'keyword',  foreground: 'ff7b72' },
        { token: 'string',   foreground: 'a5d6ff' },
        { token: 'number',   foreground: '79c0ff' },
        { token: 'regexp',   foreground: '7ee787' },
        { token: 'type',     foreground: 'ffa657' },
        { token: 'class',    foreground: 'ffa657' },
        { token: 'function', foreground: 'd2a8ff' },
        { token: 'variable', foreground: 'E1E4E8' },
        { token: 'constant', foreground: '79c0ff' },
        { token: 'operator', foreground: 'ff7b72' },
        { token: 'tag',      foreground: '7ee787' },
        { token: 'attribute.name', foreground: '79c0ff' },
        // keyword.md は Markdown の見出し/リストマーカー等に使われる。
        // Monaco標準のMarkdownトークナイザでは見出しとリストが同じ
        // keyword.md トークンになり区別できないため、両方を同色にする。
        // （分離するにはトークナイザの上書きが必要だが、コードフェンス内
        //   ハイライト等の標準機能を損なうリスクがあるため見送り）
        { token: 'keyword.md',   foreground: '82B9FF' },
        { token: 'string.link.md', foreground: 'a5d6ff' },
        { token: 'strong',   foreground: 'E1E4E8', fontStyle: 'bold' },
        { token: 'emphasis', foreground: 'E1E4E8', fontStyle: 'italic' }
      ],
      colors: {
        'editor.background': '#25292E',
        'editor.foreground': '#E1E4E8',
        'editorLineNumber.foreground': '#6e7681',
        'editorLineNumber.activeForeground': '#c9d1d9',
        'editor.selectionBackground': '#3392ff44',
        'editor.lineHighlightBackground': '#2C3036',
        'editorCursor.foreground': '#c9d1d9',
        'editorIndentGuide.background': '#21262d',
        'editorWhitespace.foreground': '#484f58'
      }
    });
  }

  // 個人設定の theme 値 → 実際に setTheme へ渡すMonacoテーマ名へ変換。
  // 未知の値や未設定は 'vs'（標準ライト）にフォールバック。
  function resolveThemeName(themeValue) {
    switch (themeValue) {
      case 'github-light': return 'mco-github-light';
      case 'quiet-light':  return 'mco-quiet-light';
      case 'github-dark':  return 'mco-github-dark';
      default:             return 'vs';
    }
  }

  // ============================================================
  // Textile用の簡易シンタックスハイライト（Monarch）
  // ============================================================
  // Monacoに組み込みTextileモードが無いため、主要記法だけを色付けする
  // 簡易トークナイザを 'textile' 言語として登録する。
  // （コードブロック内の中身の言語別色分けは対象外）
  var textileRegistered = false;
  function registerTextileLanguage(monaco) {
    if (!monaco || textileRegistered) { return; }
    textileRegistered = true;

    monaco.languages.register({ id: 'textile' });

    monaco.languages.setMonarchTokensProvider('textile', {
      defaultToken: '',
      tokenizer: {
        root: [
          // 見出し h1. 〜 h6.（行頭）
          [/^h[1-6]\.\s.*$/, 'keyword'],
          // 引用 bq. / コードブロック行 bc.
          [/^(bq|bc)\.\s?.*$/, 'string'],
          // 表のヘッダセル区切り |_.
          [/\|_\./, 'type'],
          // 表の行区切り |
          [/\|/, 'type'],
          // リスト（行頭の * または # の後にスペース）
          [/^\s*[*#]\s+/, 'number'],
          // 画像 !filename!
          [/![^!\s][^!]*!/, 'regexp'],
          // リンク "text":url
          [/"[^"]+":\S+/, 'regexp'],
          // 太字 *x*
          [/\*[^*\n]+\*/, 'strong'],
          // 斜体 _x_
          [/_[^_\n]+_/, 'emphasis'],
          // 下線 +x+
          [/\+[^+\n]+\+/, 'emphasis'],
          // インラインコード @x@
          [/@[^@\n]+@/, 'string'],
          // 取消線 -x-（前後が空白のときのみ。マイナス記号との誤検出を避ける）
          [/(^|\s)-[^-\n]+-(\s|$)/, 'comment']
        ]
      }
    });

    // 太字・斜体などにそれっぽい色を与えるための最小テーマ拡張は行わず、
    // 既定テーマ(vs)のトークン色をそのまま使う（keyword=青, string=赤茶 等）。
  }

  // ============================================================
  // 言語エイリアスの補完
  // ============================================================
  // Monacoに無い別名（```bash 等）を、既存言語のトークナイザに割り当てる。
  // 例: bash/zsh/console → shell と同じ扱いにする
  function registerLanguageAliases() {
    var monaco = window.monaco;
    if (!monaco || aliasesRegistered) { return; }
    aliasesRegistered = true;

    // { 新しい言語ID: コピー元の既存言語ID }
    var aliasMap = {
      'bash': 'shell',
      'zsh': 'shell',
      'console': 'shell',
      'sh-session': 'shell',
      'shell-session': 'shell',
      'yml': 'yaml',
      'py': 'python',
      'rb': 'ruby',
      'ts': 'typescript',
      'js': 'javascript',
      'c++': 'cpp',
      'golang': 'go',
      'conf': 'ini',
      'cfg': 'ini',
      'dockerfile': 'dockerfile'
    };

    Object.keys(aliasMap).forEach(function (alias) {
      var src = aliasMap[alias];

      // すでに登録済みの言語IDならスキップ
      var existing = monaco.languages.getLanguages().some(function (l) {
        return l.id === alias;
      });
      if (existing) { return; }

      try {
        // 新しい言語IDを登録（拡張子等は付けず、フェンス言語名としてのみ使う）
        monaco.languages.register({ id: alias });

        // コピー元言語のMonarchトークナイザ設定を取得して同じものを適用する。
        // 設定の直接取得APIは無いため、コピー元モジュールを require して
        // そのlanguage/conf定義をセットする。
        require(['vs/basic-languages/' + src + '/' + src], function (mod) {
          try {
            if (mod && mod.language) {
              monaco.languages.setMonarchTokensProvider(alias, mod.language);
            }
            if (mod && mod.conf) {
              monaco.languages.setLanguageConfiguration(alias, mod.conf);
            }
          } catch (e) { /* 失敗は無視 */ }
        });
      } catch (e) { /* 失敗は無視 */ }
    });
  }

  var aliasesRegistered = false;

  // ============================================================
  // Markdown見出しのアウトライン（DocumentSymbolProvider）
  // ============================================================
  // # 見出し を解析してシンボルツリーを返す。これを登録すると
  // Monaco標準機能が使えるようになる:
  //   - Ctrl+Shift+O      見出し一覧をポップアップしてジャンプ
  //   - パンくず(breadcrumb) エディタ上部に現在の見出し階層
  //   - 折りたたみ          見出し単位でセクションを畳む
  var symbolProviderRegistered = false;

  // ============================================================
  // @メンション 入力補完（CompletionItemProvider）
  // ============================================================
  // @ を打つと担当者セレクトのユーザー表示名を候補に出す。
  // 候補確定時に /users/<id> を1件引いてログインIDを取得し、
  // @<ログインID> を挿入する（RedmineはログインID基準でメンション解決）。
  // wordBasedSuggestions(既存単語補完)はoff のままで、これは別系統なので両立する。
  var mentionProviderRegistered = false;

  function registerMentionCompletion(monacoInstance) {
    if (mentionProviderRegistered) { return; }
    mentionProviderRegistered = true;

    // ユーザー一覧をエンドポイントから先読み（id/login/name）
    prefetchUsers();

    // markdown / textile 両方で効かせる。
    // Textileでも @ログインID はRedmineがメンションとして解決するため、
    // 挿入文字列・候補生成ロジックは共通でよい（言語IDだけが違う）。
    ['markdown', 'textile'].forEach(function (lang) {
    monacoInstance.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['@'],
      provideCompletionItems: function (model, position) {
        var lineText = model.getValueInRange({
          startLineNumber: position.lineNumber, startColumn: 1,
          endLineNumber: position.lineNumber, endColumn: position.column
        });

        // カーソル直前の @<入力中文字> を検出
        var m = /@([^\s@]*)$/.exec(lineText);
        if (!m) { return { suggestions: [] }; }

        var typed = m[1];                          // @の後ろに打った文字
        var startCol = position.column - typed.length - 1; // @ の位置

        var range = {
          startLineNumber: position.lineNumber, startColumn: startCol,
          endLineNumber: position.lineNumber, endColumn: position.column
        };

        // 候補母集団はエンドポイント（プロジェクトメンバー）。
        // 取得前なら、フォールバックで担当者セレクトの表示名を出す
        //（この場合 login が不明なので表示名のみ。通常はプリフェッチで間に合う）。
        var source = (userListCache && userListCache.length)
          ? userListCache
          : collectProjectUsers().map(function (u) {
              return { id: u.id, login: '', name: u.name };
            });

        var suggestions = source.map(function (u) {
          // 挿入は @ログインID を直接入れる（Redmineはlogin基準で解決）。
          // login が不明なフォールバック時のみ表示名を入れる。
          var insertCore = u.login ? ('@' + u.login) : ('@' + u.name);
          return {
            label: '@' + u.name,                   // 候補表示は @表示名
            kind: monacoInstance.languages.CompletionItemKind.User,
            detail: u.login ? ('@' + u.login) : 'メンション',
            // ユーザーが @Ochi と打つと "@Suguru Ochiai" にあいまい一致する
            filterText: '@' + u.name,
            // 確定で @ログインID を直接挿入。末尾にスペースを足す。
            // スクレイプも後追い置換コマンドも不要（別行の複数メンションでも安全）。
            insertText: insertCore + ' ',
            range: range
          };
        });

        return { suggestions: suggestions };
      }
    });
    });
  }


  // ============================================================
  // {{マクロ}} 入力補完（CompletionItemProvider）
  // ============================================================
  // {{ を打つと、このRedmineインスタンスで使えるマクロ（本体組込み＋
  // 他プラグインが追加したカスタムマクロ）を候補に出す。
  //
  // 候補情報は起動時に1回だけ /monaco_editor/macros から取得して
  // メモリにキャッシュする（タイピングのたびに通信しない）。
  // エンドポイントは {{macro_list}} と同じ available_macros を返すため、
  // dmsf・drawio・自作の tip/note 等もすべて自動で候補に乗る。
  //
  // 表示の住み分け:
  //   detail        … descの1行目（候補リスト右の短い説明）
  //   documentation … descの全文（候補が絞られると右に展開。長文OK）
  //
  // メンション補完と別系統なので両立する（triggerCharactersが違う）。

  // マクロ一覧のキャッシュ。null=未取得 / [] =取得済み(空) / [...]=取得済み。
  var macroListCache = null;
  var macroFetchStarted = false;

  // 起動時に1回だけ取得を試みる。失敗しても黙って諦める（補完が出ないだけ）。
  function prefetchMacros() {
    if (macroFetchStarted) { return; }
    macroFetchStarted = true;

    // REST API(.json) 無効環境でも通るよう、拡張子なしのプラグイン
    // 独自ルートを叩く。Acceptで JSON を要求する。
    fetch('/monaco_editor/macros', {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin'
    })
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json();
      })
      .then(function (list) {
        macroListCache = Array.isArray(list) ? list : [];
      })
      .catch(function () {
        // 取得失敗時は空配列にしておく（再取得はしない）。
        macroListCache = [];
      });
  }

  // ============================================================
  // DMSF文書一覧のキャッシュと先読み（{{dmsf(id)}} 引数補完用）
  // ============================================================
  // {{dmsf( の括弧内で、現在のプロジェクトのDMSF文書を候補に出す。
  // 表示はフォルダパス込みのファイル名、挿入は文書ID。
  // 取得は /monaco_editor/dmsf_files。DMSF未導入環境では空配列が返り、
  // 補完が出ないだけで何も壊れない。
  var dmsfFileListCache = null;
  var dmsfFetchStarted = false;

  function prefetchDmsfFiles() {
    if (dmsfFetchStarted) { return; }
    dmsfFetchStarted = true;

    // 現在のプロジェクトに絞って取得（候補を膨らませない・権限評価を軽く）。
    var proj = detectCurrentProject();
    var url = '/monaco_editor/dmsf_files' +
      (proj ? ('?project_id=' + encodeURIComponent(proj)) : '');

    fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin'
    })
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json();
      })
      .then(function (list) {
        dmsfFileListCache = Array.isArray(list) ? list : [];
      })
      .catch(function () {
        dmsfFileListCache = [];
      });
  }

  // {{dmsf( … の括弧内でDMSF文書候補を返す。
  // 挿入は文書ID。閉じ ")" と "}}" はマクロ側の構造が既に持つため、
  // ここではIDだけを挿入する（providePageArg と同じ方針）。
  // typed は ( 以降に打った文字（IDの数字 or 絞り込み文字列）。
  function provideDmsfArg(model, position, typed) {
    if (!dmsfFileListCache || dmsfFileListCache.length === 0) {
      return { suggestions: [] };
    }
    var startCol = position.column - typed.length; // ID開始位置（(の直後）
    var range = {
      startLineNumber: position.lineNumber, startColumn: startCol,
      endLineNumber: position.lineNumber, endColumn: position.column
    };

    var suggestions = dmsfFileListCache.map(function (f) {
      return {
        label: f.path,                                   // フォルダパス込みの表示名
        kind: window.monaco.languages.CompletionItemKind.File,
        detail: '#' + f.id + (f.project_name ? ('  ' + f.project_name) : ''),
        insertText: String(f.id),                        // 挿入は文書ID
        // パスでもIDでも絞り込めるように両方をfilterTextへ。
        filterText: f.path + ' ' + f.id,
        range: range
      };
    });
    return { suggestions: suggestions };
  }

  // ページ名（Wikiページ）を引数に取るマクロ。括弧内でWikiページ補完を出す。
  // 小文字で比較する。必要に応じてここに追記すれば対応マクロを増やせる。
  var WIKI_PAGE_ARG_MACROS = ['include', 'child_pages'];

  // ID（DMSF文書ID）を引数に取るマクロ。括弧内でDMSF文書補完を出す。
  var DMSF_ID_ARG_MACROS = ['dmsf'];

  // ============================================================
  // Badge key list cache and prefetch (for {{badge(key)}} arg completion)
  // ============================================================
  // Inside {{badge( parentheses, suggest badge keys provided by the
  // redmine_starside plugin. Source: /starside/badges (its completion API).
  //
  // When redmine_starside is not installed, this endpoint does not exist and
  // the fetch fails (404 etc.). In that case the cache stays an empty array,
  // and completion simply does not appear -- nothing breaks (same policy as
  // when DMSF is absent). So this completion has no dependency on whether
  // redmine_starside is present, and is safe to bundle.
  var badgeListCache = null;
  var badgeFetchStarted = false;

  function prefetchBadges() {
    if (badgeFetchStarted) { return; }
    badgeFetchStarted = true;

    // Fetch all keys once and filter on the client side.
    // limit=0 means unlimited (redmine_starside spec).
    fetch('/starside/badges?limit=0', {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin'
    })
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json();
      })
      .then(function (data) {
        var items = data && data.items;
        badgeListCache = Array.isArray(items) ? items : [];
      })
      .catch(function () {
        // redmine_starside not installed or endpoint missing. Just no completion.
        badgeListCache = [];
      });
  }

  function toAbsoluteBadgeUrl(url) {
    var u = String(url || '').trim();
    if (u === '') { return u; }
    // Already absolute (http://, https://, data:, blob:, etc.) or protocol-relative.
    if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.indexOf('//') === 0) {
      return u;
    }
    try {
      // Resolves both "/badge/..." (root-relative) and "badge/..." (relative).
      return new URL(u, window.location.origin).href;
    } catch (e) {
      return u;
    }
  }

  // Return badge key candidates inside {{badge( parentheses.
  // Insert the key string only; the closing ")" and "}}" are already part of
  // the macro structure (same policy as provideDmsfArg).
  // typed is the text typed after "(" (the filter string for the key).
  //
  // Note: we intentionally DO show candidates right after {{badge( (typed
  // empty), returning the full list ordered by key. This is required because
  // "(" is a trigger char but the following letters are not; if we returned
  // an empty list at "(", Monaco would close the widget and never re-open it
  // as you keep typing. By returning the full list at "(", the widget stays
  // open and Monaco narrows it down live as you type (e.g. {{badge(d).
  function provideBadgeArg(model, position, typed) {
    if (!badgeListCache || badgeListCache.length === 0) {
      return { suggestions: [] };
    }

    var q = (typed || '').toLowerCase();
    var startCol = position.column - (typed ? typed.length : 0); // key start (right after "(")
    var range = {
      startLineNumber: position.lineNumber, startColumn: startCol,
      endLineNumber: position.lineNumber, endColumn: position.column
    };

    var matched;
    if (q.length === 0) {
      // Right after "(": show all keys, ordered by key name.
      matched = badgeListCache.slice().sort(function (a, b) {
        return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
      });
    } else {
      // Filter by substring, ordering prefix matches first.
      matched = badgeListCache.filter(function (b) {
        return b && b.key && b.key.indexOf(q) !== -1;
      });
      matched.sort(function (a, b) {
        var ap = a.key.indexOf(q) === 0 ? 0 : 1;
        var bp = b.key.indexOf(q) === 0 ? 0 : 1;
        if (ap !== bp) { return ap - bp; }
        return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
      });
    }

    var suggestions = matched.map(function (b, idx) {
      return {
        label: b.key,
        kind: window.monaco.languages.CompletionItemKind.Color,
        detail: b.label || '',
        // Selecting a candidate shows a preview image (the badge). url is
        // same-origin or shields.io. Embed as a Markdown image.
        documentation: b.url ? { value: '![' + (b.label || b.key) + '](' + toAbsoluteBadgeUrl(b.url) + ')' } : undefined,
        insertText: String(b.key),
        filterText: b.key,
        // Keep ordering via sortText (prefix match -> substring match).
        sortText: ('000' + idx).slice(-4),
        range: range
      };
    });
    return { suggestions: suggestions };
  }

  // Macros that take a key (badge key) as argument; show badge key completion.
  var BADGE_ARG_MACROS = ['badge'];

  // {{include( … や {{child_pages( … の括弧内でWikiページ候補を返す。
  // 挿入はWikiリンクCompletionと同じ方針:
  //   同一プロジェクト → ページ名のみ / 別プロジェクト → 識別子:ページ名
  // 閉じ ")" と "}}" はマクロ側の構造（{{name()}}）が既に持つため、ここでは
  // ページ名だけを挿入する（重複を避ける）。typed は ( 以降に打った文字。
  function providePageArg(model, position, typed) {
    if (!wikiPageListCache || wikiPageListCache.length === 0) {
      return { suggestions: [] };
    }
    var startCol = position.column - typed.length; // ページ名開始位置（(の直後）
    var range = {
      startLineNumber: position.lineNumber, startColumn: startCol,
      endLineNumber: position.lineNumber, endColumn: position.column
    };
    var cur = detectCurrentProject();

    var suggestions = wikiPageListCache.map(function (pg) {
      var sameProject = cur && pg.project_identifier === cur;
      var linkText = sameProject
        ? pg.title
        : (pg.project_identifier + ':' + pg.title);
      return {
        label: linkText,
        kind: window.monaco.languages.CompletionItemKind.Reference,
        detail: pg.project_name || pg.project_identifier || '',
        insertText: linkText,
        filterText: pg.title + ' ' + (pg.project_identifier || ''),
        range: range
      };
    });
    return { suggestions: suggestions };
  }

  var macroProviderRegistered = false;

  function registerMacroCompletion(monacoInstance) {
    if (macroProviderRegistered) { return; }
    macroProviderRegistered = true;

    // 取得を開始（非同期。候補が出るまでに間に合わなければ次回入力で出る）
    prefetchMacros();
    // {{dmsf( 引数補完のためのDMSF文書一覧も先読みする。
    prefetchDmsfFiles();
    // Prefetch the badge key list for {{badge( argument completion.
    // When redmine_starside is absent this becomes an empty array, so
    // completion just does not appear (harmless).
    prefetchBadges();

    // markdown / textile 両方で効かせる。
    ['markdown', 'textile'].forEach(function (lang) {
      monacoInstance.languages.registerCompletionItemProvider(lang, {
        // { で発火（{{ の検出はprovide側）。( でも発火させ、ページ名を
        // 引数に取るマクロ（include/child_pages 等）の括弧内でWikiページ補完を出す。
        triggerCharacters: ['{', '('],
        provideCompletionItems: function (model, position) {
          if (!macroListCache || macroListCache.length === 0) {
            // まだ取得できていない場合は何も出さない（次の入力で再評価される）
            return { suggestions: [] };
          }

          var lineText = model.getValueInRange({
            startLineNumber: position.lineNumber, startColumn: 1,
            endLineNumber: position.lineNumber, endColumn: position.column
          });

          // --- 先に「ページ名を取るマクロの括弧内か」を判定する ---
          // 例: {{include(  /  {{child_pages(Foo  のように、対象マクロの
          // ( の後ろにカーソルがある場合は、Wikiページ候補を出す。
          // WIKI_PAGE_ARG_MACROS に含まれるマクロ名のときだけ有効。
          //   pm[1] = マクロ名, pm[2] = ( 以降に打った文字（ページ名の途中）
          var pm = /\{\{([a-zA-Z0-9_]+)\(([^()]*)$/.exec(lineText);
          if (pm && WIKI_PAGE_ARG_MACROS.indexOf(pm[1].toLowerCase()) !== -1) {
            return providePageArg(model, position, pm[2]);
          }
          // {{dmsf( … の括弧内なら、DMSF文書ID補完を出す。
          //   pm[1] = マクロ名, pm[2] = ( 以降に打った文字（IDの途中等）
          if (pm && DMSF_ID_ARG_MACROS.indexOf(pm[1].toLowerCase()) !== -1) {
            return provideDmsfArg(model, position, pm[2]);
          }
          // Inside {{badge( parentheses, show badge key completion.
          //   When pm[2] is empty (right after {{badge() show nothing; filter after 1 char.
          if (pm && BADGE_ARG_MACROS.indexOf(pm[1].toLowerCase()) !== -1) {
            return provideBadgeArg(model, position, pm[2]);
          }

          // カーソル直前の {{<入力中のマクロ名> を検出。
          // 既に開き括弧の後（{{macro( ... ）に入っている場合は出さない。
          var m = /\{\{([a-zA-Z0-9_]*)$/.exec(lineText);
          if (!m) { return { suggestions: [] }; }

          var typed = m[1];                              // {{ の後ろに打った文字
          var startCol = position.column - typed.length; // マクロ名の開始位置（{{の直後）

          var range = {
            startLineNumber: position.lineNumber, startColumn: startCol,
            endLineNumber: position.lineNumber, endColumn: position.column
          };

          // カーソル直後のテキストを見て、既に閉じ "}}" があるか判定する。
          // ある場合は挿入側の "}}" を付けない（"}}}}" の二重化を防ぐ）。
          // 例: {{dm|}}  ← | がカーソル。ここで dmsf を選ぶと {{dmsf}} に
          //     したいが、素朴に "}}" を足すと {{dmsf}}}} になってしまう。
          var lineMax = model.getLineMaxColumn(position.lineNumber);
          var after = model.getValueInRange({
            startLineNumber: position.lineNumber, startColumn: position.column,
            endLineNumber: position.lineNumber, endColumn: lineMax
          });
          // 直後が "}}"（前後の空白は許容しない・厳密に直後）で始まるか
          var hasClosing = /^\}\}/.test(after);

          var suggestions = macroListCache.map(function (macro) {
            // 引数を取りそうなマクロは ( ) を補い、カーソルを括弧内へ。
            // 取らなそうなマクロ（toc等）はそのまま閉じる。
            // documentation 内に "(" を含むかどうかで簡易判定する。
            var hasArgs = /\(/.test(macro.documentation || '');
            // 閉じ "}}" は、直後に既に "}}" がある場合は付けない。
            var closing = hasClosing ? '' : '}}';
            var insert = hasArgs
              ? macro.name + '(${1})' + closing
              : macro.name + closing;

            return {
              label: '{{' + macro.name + '}}',
              kind: monacoInstance.languages.CompletionItemKind.Function,
              // 候補リスト右の短い説明（descの1行目）
              detail: macro.detail || '',
              // 候補を選ぶと右に展開される詳細（descの全文）。
              // IMarkdownString は { value } 形式。isTrusted は付けない
              // （一部バージョンで false 指定がレンダリングを抑制するため）。
              documentation: { value: buildMacroDoc(macro) },
              // {{ は既に入力済みなので、マクロ名以降だけ挿入する
              insertText: insert,
              insertTextRules:
                monacoInstance.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              // typed が空でも全候補を出しつつ、入力に応じて絞り込む
              filterText: macro.name,
              range: range
            };
          });

          return { suggestions: suggestions };
        }
      });
    });
  }

  // ============================================================
  // [[Wikiリンク]] 入力補完（CompletionItemProvider）
  // ============================================================
  // [[ を打つと、閲覧可能な全プロジェクトのWikiページ名を候補に出す。
  // 候補は起動時に1回だけ /monaco_editor/wiki_pages から取得しキャッシュ。
  //
  // Redmineの記法:
  //   [[ページ名]]                  … 同一プロジェクト内のページ
  //   [[ページ名|表示名]]            … 別名表示
  //   [[プロジェクト識別子:ページ名]] … 別プロジェクトのページ
  // 全プロジェクト対象なので、現在のプロジェクト以外は project:title 形式で
  // 挿入する（同一プロジェクトのページは title のみ）。

  // Wikiページ一覧のキャッシュ。null=未取得 / [] =取得済み(空) / [...]=取得済み。
  var wikiPageListCache = null;
  var wikiFetchStarted = false;
  // 現在のプロジェクト識別子（挿入形を project:title にするか title のみかの判定用）
  var currentProjectIdentifier = null;

  // 現在のプロジェクト識別子を推定する。
  // チケット編集画面は /issues/123/edit のように URL に /projects/<id> を
  // 含まないことがあるため、複数の手段で順に試す:
  //   1) URL の /projects/<id>
  //   2) パンくず等の /projects/<id> へのリンク href（識別子を正確に含む）
  //   3) body の "project-<id>" クラス（Redmine標準。最後の保険）
  function detectCurrentProject() {
    if (currentProjectIdentifier !== null) { return currentProjectIdentifier; }

    var id = '';

    // 1) URL から
    var m = /\/projects\/([^\/?#]+)/.exec(window.location.pathname || '');
    if (m) { id = decodeURIComponent(m[1]); }

    // 2) ページ内の /projects/<id> リンクから（パンくず・ヘッダ等）
    if (!id) {
      var link = document.querySelector('a[href*="/projects/"]');
      if (link) {
        var lm = /\/projects\/([^\/?#]+)/.exec(link.getAttribute('href') || '');
        if (lm) { id = decodeURIComponent(lm[1]); }
      }
    }

    // 3) body の project-<id> クラス（保険）。
    //    識別子はハイフンを含み得るので、project- 以降を末尾まで取る。
    if (!id) {
      var bm = /(?:^|\s)project-([a-z0-9_-]+)/i.exec(document.body.className || '');
      if (bm) { id = bm[1]; }
    }

    currentProjectIdentifier = id || '';
    return currentProjectIdentifier;
  }

  function prefetchWikiPages() {
    if (wikiFetchStarted) { return; }
    wikiFetchStarted = true;

    var proj = detectCurrentProject();
    var url = '/monaco_editor/wiki_pages' +
      (proj ? ('?project_id=' + encodeURIComponent(proj)) : '');

    fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin'
    })
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json();
      })
      .then(function (list) {
        wikiPageListCache = Array.isArray(list) ? list : [];
      })
      .catch(function () {
        wikiPageListCache = [];
      });
  }

  var wikiProviderRegistered = false;

  function registerWikiLinkCompletion(monacoInstance) {
    if (wikiProviderRegistered) { return; }
    wikiProviderRegistered = true;

    prefetchWikiPages();

    ['markdown', 'textile'].forEach(function (lang) {
      monacoInstance.languages.registerCompletionItemProvider(lang, {
        // 2文字目の [ で発火（[[ の検出は provide 側で行う）
        triggerCharacters: ['['],
        provideCompletionItems: function (model, position) {
          if (!wikiPageListCache || wikiPageListCache.length === 0) {
            return { suggestions: [] };
          }

          var lineText = model.getValueInRange({
            startLineNumber: position.lineNumber, startColumn: 1,
            endLineNumber: position.lineNumber, endColumn: position.column
          });

          // カーソル直前の [[<入力中> を検出。
          // 既に | が入っている（[[page|...）場合は表示名入力中なので出さない。
          var m = /\[\[([^\[\]\|]*)$/.exec(lineText);
          if (!m) { return { suggestions: [] }; }

          var typed = m[1];
          var startCol = position.column - typed.length;

          var range = {
            startLineNumber: position.lineNumber, startColumn: startCol,
            endLineNumber: position.lineNumber, endColumn: position.column
          };

          // カーソル直後に既に "]]" があるか（重複挿入の防止）
          var lineMax = model.getLineMaxColumn(position.lineNumber);
          var after = model.getValueInRange({
            startLineNumber: position.lineNumber, startColumn: position.column,
            endLineNumber: position.lineNumber, endColumn: lineMax
          });
          var hasClosing = /^\]\]/.test(after);

          var cur = detectCurrentProject();

          var suggestions = wikiPageListCache.map(function (pg) {
            // 同一プロジェクトのページは title のみ、別プロジェクトは
            // project_identifier:title 形式で挿入する。
            var sameProject = cur && pg.project_identifier === cur;
            var linkText = sameProject
              ? pg.title
              : (pg.project_identifier + ':' + pg.title);

            var closing = hasClosing ? '' : ']]';
            var insert = linkText + closing;

            // ラベルは [[...]] で見せる。別プロジェクトは識別子つき。
            var label = '[[' + linkText + ']]';
            // 候補右の説明にプロジェクト名を出す（どのプロジェクトのページか）
            var detail = pg.project_name || pg.project_identifier || '';

            return {
              label: label,
              kind: monacoInstance.languages.CompletionItemKind.Reference,
              detail: detail,
              // [[ は入力済みなので、リンク本体以降だけ挿入する
              insertText: insert,
              // 入力中文字での絞り込み対象（ページ名＋プロジェクト識別子）
              filterText: pg.title + ' ' + (pg.project_identifier || ''),
              range: range
            };
          });

          return { suggestions: suggestions };
        }
      });
    });
  }

  // マクロの documentation 文字列を Markdown として組み立てる。
  // 1行目を見出し的に、残りをコードブロックで囲んで使用例を読みやすくする。
  function buildMacroDoc(macro) {
    var name = macro.name || '';
    var full = (macro.documentation || '').trim();

    // 全文が1行だけ（短い説明のみ）ならそのまま返す。
    var lines = full.split('\n');
    if (lines.length <= 1) {
      return '**{{' + name + '}}**\n\n' + full;
    }

    // 1行目を説明、2行目以降を本文として扱う。
    var firstLine = lines[0].trim();
    var rest = lines.slice(1).join('\n').trim();

    var doc = '**{{' + name + '}}**';
    if (firstLine) { doc += '\n\n' + firstLine; }
    if (rest) {
      // 残りはそのまま（使用例の {{...}} 等を等幅で見せるためコードブロック化）
      doc += '\n\n```\n' + rest + '\n```';
    }
    return doc;
  }

  // ============================================================
  // 補完候補の詳細パネル（documentation）を自動展開させる
  // ============================================================
  // Monacoの補完ウィジェットは詳細パネル（候補右の説明）を既定で畳む。
  // このバージョンには 'toggleSuggestionDetails' アクションが無いため、
  // suggest widget の toggleDetails() を直接呼ぶ。
  // むやみに呼ぶと開いているものを閉じてしまうので、ウィジェットの
  // ルートDOMに 'shows-details' クラスが無い（=畳まれている）ときだけ
  // 呼んで開く。
  function setupSuggestDetailsExpand(editor) {
    var suggestController =
      editor.getContribution('editor.contrib.suggestController');
    if (!suggestController) { return; }

    var widgetRef = suggestController.widget;
    var w = (widgetRef && widgetRef.value) ? widgetRef.value : widgetRef;
    if (!w || typeof w.onDidShow !== 'function') { return; }

    function widgetDom() {
      return (w.element && w.element.domNode) ||
             w.domNode ||
             document.querySelector('.suggest-widget');
    }

    function ensureDetailsVisible() {
      var dom = widgetDom();
      if (!dom || !dom.classList) { return; }
      // 既に展開済み（shows-details あり）なら何もしない
      if (dom.classList.contains('shows-details')) { return; }

      // 詳細を開く。実装差異に備え toggleDetails / showDetails を順に試す。
      try {
        if (typeof w.toggleDetails === 'function') {
          w.toggleDetails();
        } else if (typeof w.showDetails === 'function') {
          w.showDetails(true);
        }
      } catch (e) { /* no-op */ }
    }

    w.onDidShow(function () {
      // 描画とクラス付与の完了を待ってから判定する
      setTimeout(ensureDetailsVisible, 0);
    });
  }


  function registerMarkdownOutline(monacoInstance) {
    if (symbolProviderRegistered) { return; }
    symbolProviderRegistered = true;

    monacoInstance.languages.registerDocumentSymbolProvider('markdown', {
      provideDocumentSymbols: function (model) {
        var lines = model.getLinesContent();
        var symbols = [];
        // コードフェンス内の # を見出しと誤認しないようフェンス状態を追跡
        var inFence = false;
        var fenceRe = /^\s*(```|~~~)/;
        var headingRe = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];

          if (fenceRe.test(line)) { inFence = !inFence; continue; }
          if (inFence) { continue; }

          var m = headingRe.exec(line);
          if (!m) { continue; }

          var level = m[1].length;      // # の数（1〜6）
          var text = m[2];
          var lineNumber = i + 1;       // 1-indexed

          symbols.push({
            name: text,
            detail: '',
            // 見出しレベルに応じてアイコンを変える（H1=String, H2=Number…等は任意）
            kind: headingKind(monacoInstance, level),
            tags: [],
            range: {
              startLineNumber: lineNumber, startColumn: 1,
              endLineNumber: lineNumber, endColumn: line.length + 1
            },
            selectionRange: {
              startLineNumber: lineNumber, startColumn: 1,
              endLineNumber: lineNumber, endColumn: line.length + 1
            },
            _level: level // 階層構築用の一時情報
          });
        }

        // フラットな見出しリストを、レベルに基づいて親子ツリーに組み立てる
        return buildSymbolTree(symbols);
      }
    });
  }

  // 見出しレベルごとのシンボル種別（アイコン）。見た目の区別用。
  function headingKind(monacoInstance, level) {
    var K = monacoInstance.languages.SymbolKind;
    // レベルが浅いほど目立つ種別にする（任意のマッピング）
    switch (level) {
      case 1: return K.Class;
      case 2: return K.Field;
      case 3: return K.Constant;
      default: return K.String;
    }
  }

  // フラットな見出し配列を、#の数（_level）でネストしたツリーに変換
  function buildSymbolTree(flat) {
    var root = [];
    var stack = []; // { level, node }

    flat.forEach(function (sym) {
      var node = sym;
      node.children = [];

      // 自分より深い（level値が大きい）親が残っていれば戻る
      while (stack.length > 0 && stack[stack.length - 1].level >= node._level) {
        stack.pop();
      }

      if (stack.length === 0) {
        root.push(node);
      } else {
        stack[stack.length - 1].node.children.push(node);
      }
      stack.push({ level: node._level, node: node });
    });

    return root;
  }


  // ============================================================
  // チケット情報のキャッシュ付き取得（#1010 ホバー用）
  // ============================================================
  // セキュリティ上 REST API(.json) は使わず、通常のHTMLページを取得して
  // DOMパースでタイトル等を抽出する（セッションCookieでそのまま読める）。
  // 同じチケットへの再ホバーで再取得しないようキャッシュする。
  var issueCache = {};

  // ============================================================
  // ユーザー情報（@メンション補完・ツールチップ用）
  // ============================================================
  // セキュリティ上 REST API は使わない。ユーザー一覧は画面内の
  // 「担当者」セレクトから取得する（追加通信ゼロ。表示名＋数値ID）。
  // ログインID は必要になった時だけ /users/<数値ID> を1件取得して
  // 抽出する（.user=ログインID, h2=表示名）。全員分を事前取得しない。

  // 担当者セレクトからユーザー一覧 [{id, name}] を取得（重複・特殊項目除外）
  function collectProjectUsers() {
    var sel = document.querySelector(
      'select#issue_assigned_to_id, select[name*="assigned_to"]'
    );
    if (!sel) { return []; }
    var seen = {};
    var users = [];
    Array.prototype.forEach.call(sel.options, function (o) {
      var v = (o.value || '').trim();
      var name = (o.textContent || '').trim();
      if (/^\d+$/.test(v) && !seen[v] && !/^<<.*>>$/.test(name)) {
        seen[v] = true;
        users.push({ id: v, name: name });
      }
    });
    return users;
  }

  // ============================================================
  // メンション候補ユーザー（プラグイン独自エンドポイントから取得）
  // ============================================================
  // /monaco_editor/users が、プロジェクトメンバーを id/login/name で返す。
  // これを起動時に1回取得してキャッシュし、@補完の候補・ログインID解決・
  // ツールチップの全てに使う。
  //
  // 以前は /users/<id> ページをスクレイプして login を得ていたが、
  // ヘッダーの .user が「ログイン中の自分」を指すため誤った login（自分）に
  // 解決される不具合があった。サーバが User.login を直接返すことで解消。
  //
  // userListCache: [{id, login, name}, ...]
  // userByIdMap  : { id(String) -> {id, login, name} }
  // userByLoginMap: { login -> {id, login, name} }
  var userListCache = null;
  var userByIdMap = {};
  var userByLoginMap = {};
  var usersFetchStarted = false;

  function prefetchUsers() {
    if (usersFetchStarted) { return; }
    usersFetchStarted = true;

    var proj = detectCurrentProject();
    var url = '/monaco_editor/users' +
      (proj ? ('?project_id=' + encodeURIComponent(proj)) : '');

    fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin'
    })
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json();
      })
      .then(function (list) {
        userListCache = Array.isArray(list) ? list : [];
        userListCache.forEach(function (u) {
          userByIdMap[String(u.id)] = u;
          if (u.login) { userByLoginMap[u.login] = u; }
        });
      })
      .catch(function () {
        userListCache = [];
      });
  }

  // 数値ID → { login, name } を取得（キャッシュ付き）
  var userByIdCache = {};
  function fetchUserById(numericId) {
    if (Object.prototype.hasOwnProperty.call(userByIdCache, numericId)) {
      return Promise.resolve(userByIdCache[numericId]);
    }
    return fetch('/users/' + numericId, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');

        // ログインIDの取得:
        // ヘッダー/サイドバーにある .user は「ログイン中の自分」を指すため、
        // そこを拾うと常に自分のログインIDになってしまう（別ユーザーを
        // 引いても自分が返る不具合の原因）。
        // ユーザー詳細の本文には「ログインID: xxx」(英語UIは "Login: xxx")
        // というラベルがあるので、本文(#content)からそれを抽出する。
        var login = '';
        var content = doc.querySelector('#content') || doc.body;
        if (content) {
          var bodyText = content.textContent || '';
          // 「ログインID: xxx」「Login: xxx」「Username: xxx」等に対応。
          // 値は空白・改行までを1トークンとして取る。
          var lm = /(?:ログインID|ログイン名|Login|Username)\s*[:：]\s*([^\s\n\r]+)/.exec(bodyText);
          if (lm) { login = lm[1].trim(); }
        }
        // フォールバック: 本文から取れない場合のみ、従来の .user を使う。
        if (!login) {
          var loginEl = (content && content.querySelector('.user')) ||
                        doc.querySelector('.user');
          if (loginEl) { login = loginEl.textContent.trim(); }
        }

        // 表示名: 本文の h2 を優先。先頭にアバター文字（spanのテキスト）が
        // 混ざることがあるので、avatar要素を除いたテキストを使う。
        var name = '';
        var h2 = (content && content.querySelector('h2')) || doc.querySelector('h2');
        if (h2) {
          var clone = h2.cloneNode(true);
          // アバター（.avatar）を取り除いてから本文テキストを得る
          clone.querySelectorAll('.avatar, .gravatar, img').forEach(function (n) { n.remove(); });
          name = clone.textContent.replace(/\s+/g, ' ').trim();
        }

        var info = { login: login, name: name };
        userByIdCache[numericId] = info;
        // ログインID→情報の逆引きキャッシュも同時に作る
        if (info.login) { userByLoginCache[info.login] = info; }
        return info;
      })
      .catch(function () {
        userByIdCache[numericId] = null;
        return null;
      });
  }

  // ログインID → { login, name } の逆引きキャッシュ（ツールチップ用）
  var userByLoginCache = {};

  // ログインIDから情報を解決する（ツールチップ用）。
  // まずエンドポイント由来の userByLoginMap を見る（正しい login→name）。
  // 無ければ従来のスクレイプ解決にフォールバックする。
  function resolveUserByLogin(login) {
    // エンドポイントのキャッシュを最優先（多言語・自分混入の問題が無い）
    if (userByLoginMap && Object.prototype.hasOwnProperty.call(userByLoginMap, login)) {
      return Promise.resolve(userByLoginMap[login]);
    }
    // まだ未取得ならプリフェッチを起動しておく（次回以降のヒット用）
    if (!usersFetchStarted) { prefetchUsers(); }

    if (Object.prototype.hasOwnProperty.call(userByLoginCache, login)) {
      return Promise.resolve(userByLoginCache[login]);
    }
    var users = collectProjectUsers();
    // 未取得のユーザーを順番に解決していき、一致したら返す
    var idx = 0;
    function next() {
      if (idx >= users.length) {
        userByLoginCache[login] = null;
        return Promise.resolve(null);
      }
      var u = users[idx++];
      return fetchUserById(u.id).then(function (info) {
        if (info && info.login === login) { return info; }
        return next();
      });
    }
    return next();
  }


  function fetchIssue(id) {
    if (Object.prototype.hasOwnProperty.call(issueCache, id)) {
      return Promise.resolve(issueCache[id]);
    }

    return fetch('/issues/' + id, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin'
    })
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');

        // タイトル（件名）: .subject h3
        var subjectEl = doc.querySelector('.subject h3');
        var subject = subjectEl ? subjectEl.textContent.trim() : '';

        // プロジェクト名 + #番号: h2（例 "ナレッジ #89"）→ プロジェクト名だけ取り出す
        var h2El = doc.querySelector('h2');
        var project = '';
        if (h2El) {
          project = h2El.textContent.replace(/#\d+/, '').trim();
        }

        // ステータス: .status（例 "ステータス:終了"）→ ラベルを除去
        var statusEl = doc.querySelector('.attributes .status') || doc.querySelector('.status');
        var status = '';
        if (statusEl) {
          status = statusEl.textContent.replace(/^.*[:：]/, '').trim();
        }

        // 件名が取れなければ存在しない/想定外ページとみなす
        if (!subject) {
          issueCache[id] = null;
          return null;
        }

        var info = { id: id, subject: subject, project: project, status: status };
        issueCache[id] = info;
        return info;
      })
      .catch(function () {
        issueCache[id] = null; // 失敗もキャッシュ
        return null;
      });
  }

  // ============================================================
  // #1010 キャレット連動ツールチップ
  // ============================================================
  // マウスホバーではなく、テキストカーソル（キャレット）が #数字 の上に
  // 来たときに、自前のツールチップDOMをエディタ上に表示する。
  // Monaco標準のHoverウィジェットを使わないので配置を完全に自前制御できる。

  // 全エディタで共有する単一のツールチップ要素
  var caretTooltipEl = null;

  // ============================================================
  // ツールチップの配置先をフルスクリーン状態に追従させる
  // ============================================================
  // ツールチップは通常 body 直下に置くが、ネイティブFullscreen API は
  // 全画面化した要素（このプラグインでは .monaco-editor-wrapper）の
  // 子孫しか描画しない。そのため body 直下のままだとフルスクリーン中に
  // ツールチップが見えない（#チケットや@メンションのツールチップが
  // 出ない原因）。
  //
  // 表示直前にこの関数を呼び、フルスクリーン中なら全画面要素の中へ、
  // そうでなければ body 直下へツールチップを移し替える。
  // 戻り値: フルスクリーン中ならその要素、そうでなければ null。
  //   呼び出し側はこれを見て座標計算を切り替える
  //   （body基準=ページ座標 / 全画面要素基準=ビューポート座標）。
  function ensureTooltipParent(el) {
    if (!el) { return null; }
    var fsEl = document.fullscreenElement ||
               document.webkitFullscreenElement ||
               document.mozFullScreenElement ||
               document.msFullscreenElement ||
               // 擬似全画面（API非対応時のフォールバック）にも対応
               document.querySelector('.monaco-editor-wrapper.monaco-fullscreen');
    var desiredParent = fsEl || document.body;
    if (el.parentNode !== desiredParent) {
      desiredParent.appendChild(el);
    }
    return fsEl || null;
  }

  function getCaretTooltipEl() {
    if (caretTooltipEl) { return caretTooltipEl; }
    caretTooltipEl = document.createElement('div');
    caretTooltipEl.className = 'monaco-issue-tooltip';
    caretTooltipEl.style.display = 'none';
    document.body.appendChild(caretTooltipEl);
    return caretTooltipEl;
  }

  function hideCaretTooltip() {
    if (caretTooltipEl) { caretTooltipEl.style.display = 'none'; }
  }

  // カーソル位置の行から、カーソルに重なる #数字 を見つける
  function findIssueAtPosition(model, position) {
    var line = model.getLineContent(position.lineNumber);
    // #数字 に加えて #数字-数字（注記リンク。例 #89-3）も検出する
    var re = /#(\d+)(?:-(\d+))?/g;
    var match;
    while ((match = re.exec(line)) !== null) {
      var startCol = match.index + 1;            // 1-indexed
      var endCol = startCol + match[0].length;   // exclusive
      if (position.column >= startCol && position.column <= endCol) {
        return {
          id: match[1],          // チケット番号
          note: match[2] || null, // 注記番号（無ければnull）
          startCol: startCol,
          endCol: endCol
        };
      }
    }
    return null;
  }

  function setupCaretTooltip(editor, monacoInstance) {
    var currentId = null; // 今表示中のチケットID（連続表示の重複防止）

    function update() {
      var position = editor.getPosition();
      if (!position) { hideCaretTooltip(); currentId = null; return; }

      var hit = findIssueAtPosition(editor.getModel(), position);
      if (!hit) { hideCaretTooltip(); currentId = null; return; }

      // #数字 の開始位置の画面座標を求める
      var startPos = { lineNumber: position.lineNumber, column: hit.startCol };
      var coord = editor.getScrolledVisiblePosition(startPos);
      if (!coord) { hideCaretTooltip(); return; }

      var editorDom = editor.getDomNode();
      if (!editorDom) { return; }
      var rect = editorDom.getBoundingClientRect();

      // チケット情報を取得して表示
      fetchIssue(hit.id).then(function (info) {
        // 取得完了までにカーソルが別の #参照 に移動していたら何もしない
        var nowPos = editor.getPosition();
        var nowHit = nowPos && findIssueAtPosition(editor.getModel(), nowPos);
        if (!nowHit || nowHit.id !== hit.id || nowHit.note !== hit.note) { return; }

        var el = getCaretTooltipEl();
        // 表示ラベル: #89 または #89-3（注記付き）
        var label = '#' + hit.id + (hit.note ? '-' + hit.note : '');
        if (!info) {
          el.innerHTML = '<span class="tip-id">' + label + '</span> ' +
                         escapeHtml(t('ticket_not_found', 'ticket not found'));
        } else {
          var html = '<span class="tip-id">' + label + '</span> ' +
                     escapeHtml(info.subject);
          var meta = [];
          if (hit.note) { meta.push('💬 ' + t('note_prefix', 'Note #') + hit.note); }
          if (info.project) { meta.push('📁 ' + escapeHtml(info.project)); }
          if (info.status) { meta.push('🏷️ ' + escapeHtml(info.status)); }
          if (meta.length) {
            html += ' <span class="tip-meta">' + meta.join('　｜　') + '</span>';
          }
          el.innerHTML = html;
        }

        // 位置決め: #数字 の少し上に出す。
        // 配置先をフルスクリーン状態に追従させ、座標系を合わせる。
        //   - 通常(body直下/absolute): ページ座標 = viewport + scroll
        //   - 全画面要素内: 全画面要素はビューポート固定なので scroll は足さない
        var fsEl = ensureTooltipParent(el);
        el.style.display = 'block';
        var top, left;
        if (fsEl) {
          top = rect.top + coord.top;
          left = rect.left + coord.left;
        } else {
          top = rect.top + coord.top + window.scrollY;
          left = rect.left + coord.left + window.scrollX;
        }

        // まず表示してサイズを測り、上に出す（行の上に被せない）
        var th = el.offsetHeight;
        el.style.top = (top - th - 6) + 'px';
        el.style.left = left + 'px';
      });
    }

    // カーソル移動で更新
    editor.onDidChangeCursorPosition(function () { update(); });
    // スクロールしたら隠す（位置がズレるため）
    editor.onDidScrollChange(function () { hideCaretTooltip(); });
    // フォーカスが外れたら隠す
    editor.onDidBlurEditorText(function () { hideCaretTooltip(); });
  }

  // HTMLエスケープ（自前DOM挿入のため）
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ============================================================
  // 共通ポップアップコントローラ
  // ============================================================
  // ツールバーの各ピッカー（表グリッド・画像・ファイルリンク）は、
  // 「ボタン直下にポップアップを開く / 外クリックで閉じる / トグルする」
  // という共通の振る舞いを持つ。その重複を1つにまとめたヘルパー。
  //
  // 使い方:
  //   var pop = createPopupController(btn, {
  //     build: function () { return 要素; },  // ポップアップ本体を生成して返す
  //     clampToViewport: true                 // 右端はみ出し補正の有無（任意・既定false）
  //   });
  //   btn.addEventListener('click', pop.toggle);
  //
  // build() は開くたびに呼ばれる（最新の添付一覧などを反映するため）。
  function createPopupController(btn, opts) {
    var popup = null;
    var isOpen = false;
    var clamp = !!(opts && opts.clampToViewport);

    function onOutsideClick(e) {
      // ポップアップ外かつトリガーボタン外のクリックで閉じる
      if (popup && !popup.contains(e.target) && e.target !== btn) {
        close();
      }
    }

    function open() {
      popup = opts.build();
      if (!popup) { return; }

      // 配置先をフルスクリーン状態に追従させる。
      // ネイティブFullscreen API は全画面要素の子孫しか描画しないため、
      // body直下のままだとフルスクリーン中にポップアップが見えない。
      // ensureTooltipParent が全画面要素を返したら、座標系も
      // ページ座標→ビューポート座標に切り替える（scrollを足さない）。
      var fsEl = ensureTooltipParent(popup);

      // トリガーボタンの直下に配置
      var rect = btn.getBoundingClientRect();
      var left, top;
      if (fsEl) {
        left = rect.left;
        top  = rect.bottom + 4;
      } else {
        left = rect.left + window.scrollX;
        top  = rect.bottom + window.scrollY + 4;
      }
      popup.style.top  = top + 'px';
      popup.style.left = left + 'px';

      // 画面右端からはみ出す場合は左へずらす（要素幅確定後に補正）
      if (clamp) {
        requestAnimationFrame(function () {
          if (!popup) { return; }
          var overflow = (left + popup.offsetWidth) - (window.innerWidth - 8);
          if (overflow > 0) {
            popup.style.left = Math.max(8, left - overflow) + 'px';
          }
        });
      }

      isOpen = true;
      // 直後の同一クリックで即閉じしないよう、リスナ登録を次フレームへ遅延
      setTimeout(function () {
        document.addEventListener('mousedown', onOutsideClick);
      }, 0);
    }

    function close() {
      if (popup) { popup.remove(); popup = null; }
      isOpen = false;
      document.removeEventListener('mousedown', onOutsideClick);
    }

    function toggle() {
      if (isOpen) { close(); } else { open(); }
    }

    return { open: open, close: close, toggle: toggle };
  }

  // ============================================================
  // SVGアイコン
  // ============================================================
  var ICON_SPLIT = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2" width="6" height="12" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="2" width="6" height="12" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>';
  var ICON_SPLIT_V = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="1" width="12" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="2" y="9" width="12" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>';
  var ICON_PREVIEW = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 3C4.5 3 1.5 8 1.5 8s3 5 6.5 5 6.5-5 6.5-5-3-5-6.5-5z" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2"/></svg>';
  var ICON_EDIT = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 12.5V14h1.5l7-7-1.5-1.5-7 7zM13.3 3.7a1 1 0 000-1.4l-1.6-1.6a1 1 0 00-1.4 0l-1.1 1.1 3 3 1.1-1.1z" fill="currentColor"/></svg>';
  var ICON_OUTLINE = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="3.5" x2="13" y2="3.5" stroke="currentColor" stroke-width="1.2"/><line x1="5" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="1.2"/><line x1="5" y1="10.5" x2="13" y2="10.5" stroke="currentColor" stroke-width="1.2"/><line x1="8" y1="14" x2="13" y2="14" stroke="currentColor" stroke-width="1.2"/></svg>';
  // 変更履歴アイコン: 時計回りの矢印 + 時計の針(VS Code の history アイコン風)
  var ICON_HISTORY = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2.5a5.5 5.5 0 1 1-5.196 7.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><polyline points="2,5 2,2 5,2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/><polyline points="8,5 8,8.5 10.5,10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
  // 全画面（展開）アイコン: 四隅に向かう矢印
  var ICON_FULLSCREEN = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // 全画面解除（縮小）アイコン: 中央に集まる矢印
  var ICON_FULLSCREEN_EXIT = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // ---- 装飾ツールバー用SVGアイコン ----
  var ICON_BOLD        = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="2" y="13" font-size="13" font-weight="900" font-family="serif" fill="currentColor">B</text></svg>';
  var ICON_ITALIC      = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="3" y="13" font-size="13" font-style="italic" font-weight="600" font-family="serif" fill="currentColor">I</text></svg>';
  var ICON_UNDERLINE   = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="2" y="11" font-size="11" font-weight="600" font-family="sans-serif" fill="currentColor">U</text><line x1="2" y1="14" x2="13" y2="14" stroke="currentColor" stroke-width="1.5"/></svg>';
  var ICON_STRIKE      = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="2" y="13" font-size="12" font-weight="600" font-family="sans-serif" fill="currentColor">S</text><line x1="1" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="1.2"/></svg>';
  var ICON_CODE_INLINE = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><polyline points="5,4 1,8 5,12" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/><polyline points="11,4 15,8 11,12" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg>';
  var ICON_H1          = '<svg viewBox="0 0 20 16" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="0" y="13" font-size="12" font-weight="700" font-family="sans-serif" fill="currentColor">H1</text></svg>';
  var ICON_H2          = '<svg viewBox="0 0 20 16" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="0" y="13" font-size="12" font-weight="700" font-family="sans-serif" fill="currentColor">H2</text></svg>';
  var ICON_H3          = '<svg viewBox="0 0 20 16" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="0" y="13" font-size="12" font-weight="700" font-family="sans-serif" fill="currentColor">H3</text></svg>';
  var ICON_H4          = '<svg viewBox="0 0 20 16" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="0" y="13" font-size="12" font-weight="700" font-family="sans-serif" fill="currentColor">H4</text></svg>';
  var ICON_UL          = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="2.5" cy="4.5" r="1.2" fill="currentColor"/><line x1="6" y1="4.5" x2="14" y2="4.5" stroke="currentColor" stroke-width="1.3"/><circle cx="2.5" cy="8.5" r="1.2" fill="currentColor"/><line x1="6" y1="8.5" x2="14" y2="8.5" stroke="currentColor" stroke-width="1.3"/><circle cx="2.5" cy="12.5" r="1.2" fill="currentColor"/><line x1="6" y1="12.5" x2="14" y2="12.5" stroke="currentColor" stroke-width="1.3"/></svg>';
  var ICON_OL          = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="1" y="6" font-size="5" font-family="sans-serif" fill="currentColor">1.</text><line x1="6" y1="4.5" x2="14" y2="4.5" stroke="currentColor" stroke-width="1.3"/><text x="1" y="10" font-size="5" font-family="sans-serif" fill="currentColor">2.</text><line x1="6" y1="8.5" x2="14" y2="8.5" stroke="currentColor" stroke-width="1.3"/><text x="1" y="14" font-size="5" font-family="sans-serif" fill="currentColor">3.</text><line x1="6" y1="12.5" x2="14" y2="12.5" stroke="currentColor" stroke-width="1.3"/></svg>';
  var ICON_BLOCKQUOTE  = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2" width="3" height="12" rx="1.5" fill="currentColor" opacity="0.35"/><line x1="7" y1="5" x2="14" y2="5" stroke="currentColor" stroke-width="1.3"/><line x1="7" y1="8" x2="14" y2="8" stroke="currentColor" stroke-width="1.3"/><line x1="7" y1="11" x2="14" y2="11" stroke="currentColor" stroke-width="1.3"/></svg>';
  var ICON_CODE_BLOCK  = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/><polyline points="5,6 3,8 5,10" stroke="currentColor" stroke-width="1.2" fill="none"/><polyline points="11,6 13,8 11,10" stroke="currentColor" stroke-width="1.2" fill="none"/><line x1="7" y1="6" x2="9" y2="10" stroke="currentColor" stroke-width="1.2"/></svg>';
  var ICON_TABLE       = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="1" y1="6" x2="15" y2="6" stroke="currentColor" stroke-width="1.2"/><line x1="6" y1="2" x2="6" y2="14" stroke="currentColor" stroke-width="1"/><line x1="11" y1="2" x2="11" y2="14" stroke="currentColor" stroke-width="1"/></svg>';
  // 表ビルダー（Excelライクな表編集UIを開く）ボタン用アイコン。
  // 既存の「表挿入(ICON_TABLE)」とは別機能。罫線入りの表に編集ペン先を重ねた形。
  var ICON_TABLE_BUILDER = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="1" y1="6" x2="15" y2="6" stroke="currentColor" stroke-width="1.2"/><line x1="6" y1="2" x2="6" y2="14" stroke="currentColor" stroke-width="1"/><line x1="11" y1="2" x2="11" y2="14" stroke="currentColor" stroke-width="1"/><rect x="7" y="7.5" width="6.5" height="6.5" rx="1" fill="var(--mte-toolbar-bg, #fff)"/><path d="M9 12.5l3-3 1 1-3 3H9v-1z" fill="currentColor"/></svg>';

  var ICON_IMAGE       = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="6" r="1.5" stroke="currentColor" stroke-width="1.1"/><polyline points="1,12 5,8 8,11 11,8 15,12" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>';
  // ツールバーの「ファイルリンク」ボタン用（クリップ/添付アイコン）
  var ICON_ATTACH      = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13 7l-5.5 5.5a2.5 2.5 0 01-3.5-3.5L9 3.5a1.5 1.5 0 012 2L5.5 11a0.5 0.5 0 01-.7-.7L9.5 5.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // ツールバーの「マクロ挿入」ボタン用（二重波括弧 {{ }} を象ったアイコン）
  var ICON_MACRO       = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 2.5C4.5 2.5 4.5 5 3 5c1.5 0 1.5 2.5 1.5 4.5S4.5 13.5 3 13.5" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 2.5c1.5 0 1.5 2.5 3 2.5-1.5 0-1.5 2.5-1.5 4.5s0 4 1.5 4" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="translate(0,0)"/></svg>';
  // ツールバーの「Wikiリンク挿入」ボタン用（二重角括弧 [[ ]] を象ったアイコン）
  var ICON_WIKILINK    = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><polyline points="6,3 3,3 3,13 6,13" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><polyline points="5,3 4.5,3 4.5,13 5,13" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="translate(1.5,0)"/><polyline points="10,3 13,3 13,13 10,13" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><polyline points="11,3 11.5,3 11.5,13 11,13" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="translate(-1.5,0)"/></svg>';

  // ---- ファイル種別アイコン（ファイルリンクのリスト用、24x24 width=18） ----
  // 各種別を色分けしたバッジ風アイコンで視認性を上げる
  function fileTypeBadge(label, bg) {
    return '<svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">' +
           '<rect x="3" y="2" width="18" height="20" rx="2" fill="' + bg + '"/>' +
           '<text x="12" y="16" font-size="7.5" font-weight="700" font-family="sans-serif" fill="#fff" text-anchor="middle">' + label + '</text>' +
           '</svg>';
  }
  var FICON_EXCEL = fileTypeBadge('XLS', '#1d7044');
  var FICON_WORD  = fileTypeBadge('DOC', '#2b5797');
  var FICON_PDF   = fileTypeBadge('PDF', '#c0392b');
  var FICON_PPT   = fileTypeBadge('PPT', '#d24726');
  var FICON_IMG   = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="2" stroke="#888" stroke-width="1.6"/><circle cx="9" cy="9" r="1.8" fill="#888"/><polyline points="4,18 9,12 13,16 17,11 20,15" stroke="#888" stroke-width="1.6" fill="none" stroke-linejoin="round"/></svg>';
  var FICON_CODE  = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><polyline points="9,7 4,12 9,17" stroke="#555" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><polyline points="15,7 20,12 15,17" stroke="#555" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var FICON_CONF  = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="3" stroke="#666" stroke-width="1.6"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" stroke="#666" stroke-width="1.6" stroke-linecap="round"/></svg>';
  var FICON_ARCHIVE = fileTypeBadge('ZIP', '#7f8c8d');
  var FICON_GENERIC = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 2h8l4 4v16a0 0 0 01 0 0H6a0 0 0 01 0 0V2z" stroke="#999" stroke-width="1.5" fill="none"/><polyline points="14,2 14,6 18,6" stroke="#999" stroke-width="1.5" fill="none"/></svg>';

  // ============================================================
  // プレビュー取得（Redmine純正のプレビューURLを流用）
  // ============================================================
  // Redmineは各編集画面のプレビュータブ <a class="tab-preview"> に
  // 正規のプレビューURLを data-url 属性で埋め込んでいる。
  //   例: data-url="/issues/preview?issue_id=89&project_id=geekknowledge"
  // 自前でパスを組み立てず、この data-url をそのまま使うのが最も確実で、
  // 純正プレビューと完全に同一のHTML（章番号・テーマCSS適用済み）が得られる。
  function getPreviewUrl(textarea) {
    // 1) 同じフォーム内のプレビュータブを探す
    var form = textarea.closest('form');
    var scope = form || document;

    var tab = scope.querySelector('a.tab-preview[data-url]') ||
              document.querySelector('a.tab-preview[data-url]');
    if (tab && tab.getAttribute('data-url')) {
      return tab.getAttribute('data-url');
    }

    // 2) jsToolBarが data-url を別要素に持つ場合のフォールバック
    var anyPreview = document.querySelector('[data-url*="preview"]');
    if (anyPreview) {
      return anyPreview.getAttribute('data-url');
    }

    return null;
  }

  // ============================================================
  // プレビュー取得（Redmine preview API）
  // ============================================================
  function fetchPreview(text, previewUrl, callback, textarea) {
    if (!previewUrl) {
      callback(new Error(t('preview_url_missing', 'Preview URL not found')), null);
      return;
    }

    // CSRF トークンを取得
    var csrfToken = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';

    var params = new URLSearchParams();
    // 検証の結果、"text" パラメータでMarkdownが正しくレンダリングされる
    params.append('text', text);

    // 保存前の添付ファイル（アップロード中）を画像プレビューで解決させるため、
    // フォーム内の attachments[N][token] / [filename] / [description] も送る。
    // Redmine純正プレビューはフォーム全体を送ることで一時ファイルを解決している。
    // 同名の name 属性をそのまま引き継ぐことで、サーバ側が一時添付を認識できる。
    if (textarea) {
      var form = textarea.closest('form');
      if (form) {
        form.querySelectorAll(
          '.attachments_fields input[name^="attachments["]'
        ).forEach(function (inp) {
          if (inp.name && inp.value) {
            params.append(inp.name, inp.value);
          }
        });
      }
    }

    fetch(previewUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': csrfToken,
        'X-Requested-With': 'XMLHttpRequest'
      },
      credentials: 'same-origin',
      body: params.toString()
    })
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.text();
      })
      .then(function (html) { callback(null, html); })
      .catch(function (err) { callback(err, null); });
  }

  // ============================================================
  // 単一のtextareaをMonacoに変換
  // ============================================================
  function replaceTextarea(textarea, monacoInstance) {
    // エディタの初期高さ（px）。下端ハンドルでドラッグ変更可能。
    var originalHeight = 460;

    // テキストフォーマット（markdown / textile）を判定
    var textFormat = detectFormat(textarea);

    // プロジェクトIDをURLから取得
    // Redmine純正のプレビューURLを取得（data-url属性から）
    var previewUrl = getPreviewUrl(textarea);

    // ---- DOM構築 ----
    var wrapper = document.createElement('div');
    wrapper.className = 'monaco-editor-wrapper';
    wrapper.style.height = originalHeight + 'px';

    // ==== 単一ツールバー（モード切替 + 装飾ボタンを1段に） ====
    // 左: モードボタン群（編集・分割・縦分割・プレビュー・アウトライン）
    // 右: 装飾ボタン群（B/I/U/S/コード | 見出し | リスト | 引用/コードブロック | 表/画像）
    // 幅が狭いと装飾ボタン群は右から順に隠れる（overflow:hidden）。
    var toolbar = document.createElement('div');
    toolbar.className = 'monaco-editor-toolbar';

    // ---- モードボタン群（左・固定で隠れない） ----
    var modeGroup = document.createElement('div');
    modeGroup.className = 'monaco-toolbar-modes';

    // 編集ボタン（アイコン+テキスト）
    var btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'monaco-preview-btn active';
    btnEdit.innerHTML = ICON_EDIT + ' ' + escapeHtml(t('mode_edit', 'Edit'));
    btnEdit.title = t('mode_edit_tip', 'Show editor only');

    // 分割ボタン（左右・アイコン+テキスト）
    var btnSplit = document.createElement('button');
    btnSplit.type = 'button';
    btnSplit.className = 'monaco-preview-btn';
    btnSplit.innerHTML = ICON_SPLIT + ' ' + escapeHtml(t('mode_split', 'Split'));
    btnSplit.title = t('mode_split_tip', 'Editor + preview (side by side)');

    // 縦分割ボタン（上下・アイコンのみ）
    var btnSplitV = document.createElement('button');
    btnSplitV.type = 'button';
    btnSplitV.className = 'monaco-preview-btn monaco-icon-only';
    btnSplitV.innerHTML = ICON_SPLIT_V;
    btnSplitV.title = t('mode_split_v_tip', 'Editor + preview (stacked)');

    // プレビューボタン（アイコンのみ）
    var btnPreview = document.createElement('button');
    btnPreview.type = 'button';
    btnPreview.className = 'monaco-preview-btn monaco-icon-only';
    btnPreview.innerHTML = ICON_PREVIEW;
    btnPreview.title = t('mode_preview_tip', 'Show preview only');

    // アウトライン トグルボタン（アイコンのみ）
    var btnOutline = document.createElement('button');
    btnOutline.type = 'button';
    btnOutline.className = 'monaco-preview-btn monaco-outline-btn monaco-icon-only';
    btnOutline.innerHTML = ICON_OUTLINE;
    btnOutline.title = t('outline_tip', 'Toggle heading outline');

    // 変更履歴ボタン（アイコンのみ）。クリックでドロップダウン展開。
    // 履歴データ(window.MONACO_EDITOR_DIFF.versions)が空の場合は非表示。
    var btnHistory = document.createElement('button');
    btnHistory.type = 'button';
    btnHistory.className = 'monaco-preview-btn monaco-icon-only monaco-history-btn';
    btnHistory.innerHTML = ICON_HISTORY;
    btnHistory.title = t('history_btn_tip', 'Show diff between past versions');
    btnHistory.setAttribute('aria-haspopup', 'true');
    btnHistory.setAttribute('aria-expanded', 'false');

    // 順序: 編集・分割・縦分割・プレビュー・アウトライン・変更履歴
    modeGroup.appendChild(btnEdit);
    modeGroup.appendChild(btnSplit);
    modeGroup.appendChild(btnSplitV);
    modeGroup.appendChild(btnPreview);
    modeGroup.appendChild(btnOutline);
    modeGroup.appendChild(btnHistory);

    // モードと装飾の境界セパレータ
    var groupSep = document.createElement('span');
    groupSep.className = 'monaco-deco-sep monaco-group-sep';

    // ---- 装飾ボタン群（右・幅が足りなければ右から隠れる） ----
    var decoToolbar = document.createElement('div');
    decoToolbar.className = 'monaco-decoration-toolbar';

    // ヘルパー: 装飾ボタンを作成
    function makeDecoBtn(icon, title) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'monaco-deco-btn';
      btn.innerHTML = icon;
      btn.title = title;
      return btn;
    }
    // ヘルパー: 区切り線
    function makeDecoSep() {
      var sep = document.createElement('span');
      sep.className = 'monaco-deco-sep';
      return sep;
    }

    // 装飾ボタンの定義（データ駆動）。
    //   key   : setupDecoToolbar へ渡す識別子
    //   icon  : SVGアイコン
    //   title : ホバー時のツールチップ
    //   wide  : H1〜H4のように横長アイコンのボタンか（任意）
    //   sepAfter: このボタンの後に区切り線を入れるか（任意）
    var DECO_BUTTON_DEFS = [
      { key: 'bold',       icon: ICON_BOLD,        title: t('bold_tip', 'Bold (Ctrl+B)') },
      { key: 'italic',     icon: ICON_ITALIC,      title: t('italic_tip', 'Italic (Ctrl+I)') },
      { key: 'underline',  icon: ICON_UNDERLINE,   title: t('underline_tip', 'Underline') },
      { key: 'strike',     icon: ICON_STRIKE,      title: t('strike_tip', 'Strikethrough') },
      { key: 'codeInline', icon: ICON_CODE_INLINE, title: t('code_inline_tip', 'Inline code'), sepAfter: true },
      { key: 'h1',         icon: ICON_H1,          title: t('h1_tip', 'Heading 1'), wide: true },
      { key: 'h2',         icon: ICON_H2,          title: t('h2_tip', 'Heading 2'), wide: true },
      { key: 'h3',         icon: ICON_H3,          title: t('h3_tip', 'Heading 3'), wide: true },
      { key: 'h4',         icon: ICON_H4,          title: t('h4_tip', 'Heading 4'), wide: true, sepAfter: true },
      { key: 'ul',         icon: ICON_UL,          title: t('ul_tip', 'Bulleted list') },
      { key: 'ol',         icon: ICON_OL,          title: t('ol_tip', 'Numbered list'), sepAfter: true },
      { key: 'blockquote', icon: ICON_BLOCKQUOTE,  title: t('blockquote_tip', 'Quote') },
      { key: 'codeBlock',  icon: ICON_CODE_BLOCK,  title: t('code_block_tip', 'Code block'), sepAfter: true },
      { key: 'table',        icon: ICON_TABLE,         title: t('table_tip', 'Insert table') },
      { key: 'tableBuilder', icon: ICON_TABLE_BUILDER, title: t('table_builder_tip', 'Open table builder') },
      { key: 'image',      icon: ICON_IMAGE,       title: t('image_tip', 'Insert image') },
      { key: 'fileLink',   icon: ICON_ATTACH,      title: t('file_link_tip', 'Insert file link'), sepAfter: true },
      { key: 'macro',      icon: ICON_MACRO,       title: t('macro_tip', 'Insert macro {{ }}') },
      { key: 'wikiLink',   icon: ICON_WIKILINK,    title: t('wiki_link_tip', 'Insert wiki link [[ ]]') }
    ];

    // 定義から実ボタンを生成し、key→要素 のマップ（decoBtns）に格納しつつ
    // decoToolbar へ順に追加する。区切り線も定義に従って挿入する。
    var decoBtns = {};
    DECO_BUTTON_DEFS.forEach(function (def) {
      var b = makeDecoBtn(def.icon, def.title);
      if (def.wide) { b.classList.add('monaco-deco-btn-wide'); }
      decoBtns[def.key] = b;
      decoToolbar.appendChild(b);
      if (def.sepAfter) { decoToolbar.appendChild(makeDecoSep()); }
    });

    // 全画面トグルボタン（ツールバー最右端に固定）。
    // 装飾ボタン群は幅が狭いと右から隠れるが、このボタンは別要素として
    // 最右端に固定するため、常に表示される。
    var btnFullscreen = document.createElement('button');
    btnFullscreen.type = 'button';
    btnFullscreen.className = 'monaco-preview-btn monaco-icon-only monaco-fullscreen-btn';
    btnFullscreen.innerHTML = ICON_FULLSCREEN;
    btnFullscreen.title = t('fullscreen_tip', 'Toggle fullscreen');

    // 装飾群と全画面ボタンの間を押し広げるスペーサー（全画面ボタンを右端へ）
    var toolbarSpacer = document.createElement('span');
    toolbarSpacer.className = 'monaco-toolbar-spacer';

    // ツールバーに組み立て
    toolbar.appendChild(modeGroup);
    toolbar.appendChild(groupSep);
    toolbar.appendChild(decoToolbar);
    toolbar.appendChild(toolbarSpacer);
    toolbar.appendChild(btnFullscreen);

    // ボディ
    var body = document.createElement('div');
    body.className = 'monaco-editor-body';
    // 高さは CSS の flex:1 で wrapper 内の残り領域を埋める（固定pxにしない）。

    // アウトラインパネル（左端・デフォルト非表示）
    var outlinePane = document.createElement('div');
    outlinePane.className = 'monaco-outline-pane';

    // Monacoコンテナ
    var editorContainer = document.createElement('div');
    editorContainer.className = 'monaco-editor-container';

    // プレビューペイン
    // 純正プレビューと同じ class "wiki wiki-preview" を付けることで、
    // Redmineテーマ（章番号の自動採番やフォント等）のCSSをそのまま継承する。
    var previewPane = document.createElement('div');
    previewPane.className = 'monaco-preview-pane wiki wiki-preview';

    // 分割スプリッター（エディタとプレビューの境界。ドラッグで割合変更）
    var splitter = document.createElement('div');
    splitter.className = 'monaco-splitter';

    // ペインラッパー（エディタ・スプリッター・プレビューを内包）
    // アウトラインは body 直下・左に固定し、このラッパーがその右側を占める。
    // 縦分割（split-vertical）時はこのラッパーだけを column 方向にすることで、
    // アウトライン表示の有無に関わらずスプリッターの割合計算が安定する。
    var paneWrap = document.createElement('div');
    paneWrap.className = 'monaco-pane-wrap';

    paneWrap.appendChild(editorContainer);
    paneWrap.appendChild(splitter);
    paneWrap.appendChild(previewPane);

    body.appendChild(outlinePane);
    body.appendChild(paneWrap);
    wrapper.appendChild(toolbar);
    wrapper.appendChild(body);

    // textareaの直前に挿入し、textareaは隠す
    textarea.parentNode.insertBefore(wrapper, textarea);
    textarea.classList.add('monaco-replaced');

    // ---- Monaco インスタンス生成 ----
    var editor = monacoInstance.editor.create(editorContainer, {
      value: textarea.value,
      // Markdownは組み込みmarkdownモード（コードフェンス内も色分け）。
      // Textileは自前の簡易Monarch言語 'textile' で主要記法を色付け。
      language: (textFormat === 'textile') ? 'textile' : 'markdown',
      theme: resolveThemeName(PREFS.theme),
      lineNumbers: 'off',
      // 表ブロックの先頭行に「表ビルダーで開く」アイコンを置くため、
      // 行番号の左の余白（glyph margin）を有効化する。
      glyphMargin: true,
      wordWrap: 'on',
      // 'auto'だとChromeがスクリーンリーダを誤検出し、折り返し行でIME位置がズレる
      // (候補が右端やスクロールバー外に出る)。'off'で通常挙動に戻る。
      accessibilitySupport: 'off',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: prefFontSize(),
      lineHeight: 0, // 0 = 自動計算（VSCode同様 fontSize×1.5 ≒ 21px）
      renderLineHighlight: 'line',
      scrollbar: {
        vertical: 'auto',
        horizontal: 'auto',
        // ホイールイベントを常時奪わない。
        // エディタ内にスクロール余地が無い時はページ側へスクロールを流す
        // （textareaに近い挙動になる）
        alwaysConsumeMouseWheel: false
      },
      padding: { top: 8, bottom: 8 },
      // Monaco標準のサイズ自動追従。ResizeObserverと併用で確実にする
      automaticLayout: true,
      // 見出し単位の折りたたみを有効化（DocumentSymbolProviderと連動）
      folding: true,
      foldingStrategy: 'auto',
      showFoldingControls: 'mouseover',
      // ホバー・補完・詳細パネルなどのオーバーレイの配置先を明示する。
      // 【重要】配置先を「このエディタの wrapper の中」に作る点がミソ。
      //   - body直下に置くと、ブラウザのネイティブFullscreen API は
      //     全画面化した wrapper の子孫しか描画しないため、フルスクリーン中に
      //     補完(@/#含む)やツールチップが一切出なくなる（既存の不具合の原因）。
      //   - wrapper 内に置けば、フルスクリーンでもエディタと一緒に表示される。
      // ノードは position:fixed + inset:0 でビューポートに重ね、Monacoが
      // 書き込む top/left がビューポート座標と一致するようにする
      //（詳細パネルが画面外に飛ぶ問題も同時に解消）。
      fixedOverflowWidgets: true,
      overflowWidgetsDomNode: createOverflowWidgetsNode(wrapper, resolveThemeName(PREFS.theme)),
      // ---- 補完の方針 ----
      // 既存単語の補完(abc候補)は出さないが、@メンションの補完は出したい。
      // suggestOnTriggerCharacters を true にすると @ などのトリガー文字で
      // 補完が出る。wordBasedSuggestions:off と quickSuggestions:false を
      // 維持することで「通常入力では補完なし・@の時だけ補完」を実現する。
      wordBasedSuggestions: 'off',
      quickSuggestions: false,
      suggestOnTriggerCharacters: true,
      acceptSuggestionOnEnter: 'on',
      tabCompletion: 'off',
      parameterHints: { enabled: false },
      suggest: {
        showWords: false,
        // 補完候補の右側に説明（documentation / detail）パネルを表示する。
        // 既定ではユーザー操作で畳まれていることがあるため明示的に開く。
        showStatusBar: true,
        // 各種マクロのアイコン横に出す説明（detail）を有効化
        showInlineDetails: true
      }
    });

    // 生成直後はコンテナサイズが未確定で中身が描画されないことがあるため、
    // 複数の手段で layout() を確実に呼んで初期表示を確定させる。
    requestAnimationFrame(function () {
      editor.layout();
    });
    setTimeout(function () { editor.layout(); }, 100);
    setTimeout(function () { editor.layout(); }, 300);

    // ResizeObserver でコンテナのサイズ変化を監視し、その都度 layout する。
    // これが初期表示の空白・分割切り替え・手動リサイズすべての保険になる。
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () {
        editor.layout();
      });
      ro.observe(editorContainer);
    }

    // ---- 貼り付けメニューの抑止 ----
    // Monaco のツールバー/右クリックメニューの「貼り付け」は内部で
    // navigator.clipboard.readText() を使う。自己署名証明書などで
    // セキュアコンテキストとして完全に信頼されていない環境では readText が
    // NotAllowedError になり、メニューから貼り付けても無反応＋コンソールに
    // エラーが出る。Ctrl+V は paste イベント経由で readText を使わず常に動くので、
    // メニューの貼り付けは一律で隠して Ctrl+V に一本化する（詳細は関数定義側）。
    suppressPasteMenu(editor, monacoInstance);

    // 補完候補の説明パネル（documentation）を最初から展開させる。
    // Monacoは詳細パネルの開閉状態を内部に保持しており、初期状態だと
    // 畳まれていて documentation が見えないことがある。補完ウィジェットが
    // 開いた直後に「詳細を展開」コマンドを1回だけ実行して開いた状態にする。
    setupSuggestDetailsExpand(editor);

    // Monaco の変更をtextareaに反映（フォーム送信時に値が送られるよう）
    // syncingフラグで逆方向同期との相互ループを防ぐ。
    var syncing = false;
    editor.onDidChangeModelContent(function () {
      if (syncing) { return; }
      // 自分の書き戻しであることを示すフラグを立てて代入する。
      // （value setter フックがこれを外部代入と誤検知しないように）
      syncing = true;
      textarea.value = editor.getValue();
      syncing = false;
    });

    // ---- 逆方向同期: textarea → Monaco ----
    // Issue Template プラグイン等の外部スクリプトは、隠れている元textareaの
    // value を直接書き換えることがある（テンプレート挿入など）。
    // その変更にMonacoが気づけるよう、textarea側の値が変わっていたら
    // Monacoへ取り込む。
    //
    // force=false の場合、ユーザーがMonacoを編集中（フォーカス保持中）は
    // setValueでカーソルが飛ぶのを避けるため取り込まない。
    // force=true（フォーカス取得時）は、触り始めの瞬間なので取り込む。
    function pullFromTextarea(force) {
      var tv = textarea.value;
      if (tv === editor.getValue()) { return; }
      if (!force && editor.hasTextFocus()) { return; }
      syncing = true;
      editor.setValue(tv);
      syncing = false;
    }

    // (1) textarea が input/change イベントを発火するタイプに対応
    textarea.addEventListener('input', function () { pullFromTextarea(false); });
    textarea.addEventListener('change', function () { pullFromTextarea(false); });

    // (2) value 直接代入（イベントを出さないタイプ）に対応するため、
    //     Monacoエディタがフォーカスを得た瞬間に値を突き合わせる。
    //     テンプレ挿入後にユーザーがエディタを触った時点で最新化される。
    editor.onDidFocusEditorText(function () {
      pullFromTextarea(true);
    });

    // (3) さらに確実にするため、フォーム要素の変化（トラッカー変更など）後にも
    //     突き合わせる。Issue Template はセレクト変更で挿入することが多い。
    var form = textarea.closest('form');
    if (form) {
      form.addEventListener('change', function () {
        // セレクト変更などの直後、テンプレ挿入が走る時間を少し待ってから取り込む
        setTimeout(function () { pullFromTextarea(false); }, 50);
      });
    }

    // (4) value プロパティへの直接代入を検知する（決定打）。
    //     Issue Templates 等のプラグインは textarea.value = '...' で
    //     直接書き込み、input/changeイベントを発火しないことがある。
    //     その場合 (1)〜(3) では拾えないため、value の setter をフックして
    //     「誰がどんな方法で代入しても」検知できるようにする。
    //     ネイティブの getter/setter は保持して本来の動作を壊さない。
    try {
      var proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
      var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.get && desc.set) {
        Object.defineProperty(textarea, 'value', {
          configurable: true,
          get: function () { return desc.get.call(this); },
          set: function (v) {
            desc.set.call(this, v); // 本来の代入を実行
            // 自分(Monaco→textarea)の書き戻し中は無視。
            // それ以外（外部からの代入）はMonacoへ取り込む。
            if (!syncing) {
              // 同期実行だとsetValue中に他処理と競合しうるため次tickで
              setTimeout(function () { pullFromTextarea(false); }, 0);
            }
          }
        });
      }
    } catch (e) {
      // defineProperty が失敗しても (1)〜(3) で可能な範囲はカバーする
    }

    // ---- クリップボード画像ペースト ----
    // 純正(attachments.js)の copyImageFromClipboard 相当。アップロードは
    // 純正へ委譲し、本文記法はMonacoのカーソル位置に挿入する。
    // これらは付加機能なので、万一例外が出てもエディタ全体の初期化を
    // 巻き込まない（=純正textareaに戻らない）よう個別に保護する。
    try {
      setupClipboardImagePaste(editor, textarea, textFormat);
    } catch (e) {
      if (window.console) { console.error('[monaco_editor] setupClipboardImagePaste failed:', e); }
    }

    // ---- 画像記法ホバーでサムネイルツールチップ ----
    try {
      setupImageTooltip(editor, textarea, textFormat);
    } catch (e) {
      if (window.console) { console.error('[monaco_editor] setupImageTooltip failed:', e); }
    }

    // ---- プレビュー更新 ----
    var previewTimer = null;
    var previewInitialized = false; // 初回ロードか判定

    function updatePreview() {
      // 初回のみ「読み込み中」を表示（2回目以降は出さずチラつき防止）
      if (!previewInitialized) {
        previewPane.innerHTML = '<div class="monaco-preview-loading">' + escapeHtml(t('preview_loading', 'Loading...')) + '</div>';
      }

      // 再描画でスクロール位置がリセットされないよう、更新前に保存しておく
      var prevScrollTop = previewPane.scrollTop;
      var prevScrollLeft = previewPane.scrollLeft;

      fetchPreview(editor.getValue(), previewUrl, function (err, html) {
        if (err) {
          previewPane.innerHTML = '<div style="color:red">' + escapeHtml(t('preview_failed', 'Failed to load preview')) + '</div>';
          return;
        }
        previewPane.innerHTML = html;
        previewInitialized = true;
        // スクロール位置を復元（編集箇所を見失わないように）
        previewPane.scrollTop = prevScrollTop;
        previewPane.scrollLeft = prevScrollLeft;
      }, textarea);
    }

    // 分割表示時はdebounceしてプレビュー更新
    editor.onDidChangeModelContent(function () {
      if (!body.classList.contains('split-view')) return;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(updatePreview, 600);
    });

    // ---- プレビュー内サムネイルのライトボックス表示 ----
    // {{thumbnail}} で生成されるサムネイルは <a href="...元画像"> でラップ
    // されており、素のままクリックすると元画像URLへページ遷移してしまう
    // （Monacoで編集中だと「変更が保存されない可能性…」の離脱警告が出る）。
    // プレビューペインにイベント委譲を1回だけ張り、サムネイルのクリックを
    // 横取りして画面内モーダルで拡大表示する（遷移しない）。
    setupThumbnailLightbox(previewPane);

    // ---- スクロール同期（エディタ → プレビュー、一方向）----
    setupScrollSync(editor, previewPane, body, textFormat);

    // ---- ボタンのstate管理 ----
    // diff モード(変更履歴の差分表示)用の状態。setMode('diff', payload) で起動、
    // payload = { fromText, toText, fromLabel, toLabel } を受ける。
    // teardownDiff() で完全に元の状態へ戻す。
    var diffState = null; // { container, leftEditor, rightEditor, closeBtn, ... }

    function teardownDiff() {
      if (!diffState) return;
      try {
        if (diffState.leftEditor) diffState.leftEditor.dispose();
        if (diffState.rightEditor) diffState.rightEditor.dispose();
      } catch (e) { /* ignore */ }
      if (diffState.container && diffState.container.parentNode) {
        diffState.container.parentNode.removeChild(diffState.container);
      }
      // diff モード起動中に仕込んだ ESC リスナーを解除
      if (diffState.escHandler) {
        document.removeEventListener('keydown', diffState.escHandler, true);
      }
      diffState = null;
      // 元のエディタコンテナを再表示
      editorContainer.style.display = '';
    }

    function setMode(mode, payload) {
      // mode: 'edit' | 'split' | 'split-v' | 'preview' | 'diff'
      // diff モードを終了するため、別モードに移る時は必ず teardown する
      if (diffState && mode !== 'diff') teardownDiff();

      body.classList.remove('split-view', 'split-vertical', 'preview-only', 'diff-mode');
      btnEdit.classList.remove('active');
      btnSplit.classList.remove('active');
      btnSplitV.classList.remove('active');
      btnPreview.classList.remove('active');

      // スプリッターのドラッグで付いたインライン値をリセット（CSS既定の50:50に戻す）
      editorContainer.style.flex = '';
      previewPane.style.flex = '';

      if (mode === 'split') {
        body.classList.add('split-view');
        btnSplit.classList.add('active');
        updatePreview();
      } else if (mode === 'split-v') {
        body.classList.add('split-view', 'split-vertical');
        btnSplitV.classList.add('active');
        updatePreview();
      } else if (mode === 'preview') {
        body.classList.add('preview-only');
        btnPreview.classList.add('active');
        updatePreview();
      } else if (mode === 'diff') {
        // diff モード: 左右に過去版差分を並列表示(両方読み取り専用)。
        // 既存の分割レイアウトを流用するため split-view も付ける。
        body.classList.add('split-view', 'diff-mode');
        // ペインの中身は専用 Monaco で埋めるため、元 editor は隠す。
        editorContainer.style.display = 'none';
        setupDiffMode(payload || {});
      } else {
        btnEdit.classList.add('active');
      }

      // diff/プレビュー専用モードでは装飾ツールバーを無効化
      var disableDeco = (mode === 'preview' || mode === 'diff');
      decoToolbar.querySelectorAll('button.monaco-deco-btn').forEach(function (btn) {
        btn.disabled = disableDeco;
      });
      decoToolbar.classList.toggle('monaco-decoration-toolbar--disabled', disableDeco);

      // Monacoのレイアウトをリフレッシュ
      setTimeout(function () { editor.layout(); }, 50);
    }

    // ----- diff モード本体 -----
    // payload: { fromText, toText, fromLabel, toLabel }
    //   fromText: 左側に出す変更前テキスト
    //   toText:   右側に出す変更後テキスト
    //   fromLabel / toLabel: ヘッダに出すラベル(任意)
    function setupDiffMode(payload) {
      var monacoInstance = window.monaco;
      if (!monacoInstance) { return; }
      teardownDiff();

      var fromText = String(payload.fromText == null ? '' : payload.fromText);
      var toText   = String(payload.toText   == null ? '' : payload.toText);
      var fromLabel = payload.fromLabel || '';
      var toLabel   = payload.toLabel   || '';

      // 差分計算
      var diff = gitDiffForSideBySide(fromText, toText);

      // diff モードのコンテナを paneWrap 内に作成する(既存の分割レイアウトを利用)
      var diffContainer = document.createElement('div');
      diffContainer.className = 'monaco-diff-container';
      diffContainer.style.display = 'flex';
      diffContainer.style.flex = '1 1 auto';
      diffContainer.style.minHeight = '0';
      diffContainer.style.width = '100%';

      // 左ペイン(変更前)のラッパー
      var leftWrap = document.createElement('div');
      leftWrap.className = 'monaco-diff-pane monaco-diff-left';
      var leftHeader = document.createElement('div');
      leftHeader.className = 'monaco-diff-header';
      leftHeader.textContent = fromLabel;
      var leftHost = document.createElement('div');
      leftHost.className = 'monaco-diff-host';
      leftWrap.appendChild(leftHeader);
      leftWrap.appendChild(leftHost);

      // 右ペイン(変更後)のラッパー
      var rightWrap = document.createElement('div');
      rightWrap.className = 'monaco-diff-pane monaco-diff-right';
      var rightHeader = document.createElement('div');
      rightHeader.className = 'monaco-diff-header';
      var rightHeaderTitle = document.createElement('span');
      rightHeaderTitle.className = 'monaco-diff-header-title';
      rightHeaderTitle.textContent = toLabel;
      rightHeader.appendChild(rightHeaderTitle);
      // 閉じるボタン(右ヘッダの右端)
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'monaco-diff-close';
      closeBtn.setAttribute('aria-label', 'close diff view');
      closeBtn.setAttribute('title', 'close diff view');
      closeBtn.textContent = '\u00D7';
      closeBtn.addEventListener('mousedown', function (ev) {
        ev.stopPropagation(); ev.preventDefault();
        setMode('edit');
      });
      closeBtn.addEventListener('click', function (ev) {
        ev.stopPropagation(); ev.preventDefault();
      });
      rightHeader.appendChild(closeBtn);
      var rightHost = document.createElement('div');
      rightHost.className = 'monaco-diff-host';
      rightWrap.appendChild(rightHeader);
      rightWrap.appendChild(rightHost);

      diffContainer.appendChild(leftWrap);
      diffContainer.appendChild(rightWrap);

      // paneWrap に挿入(editorContainer の前あたり)
      paneWrap.insertBefore(diffContainer, editorContainer);

      // 両側に Monaco を生成
      var commonOpts = {
        value: '',
        language: detectMonacoLanguage(textFormat),
        readOnly: true,
        domReadOnly: true,
        renderLineHighlight: 'none',
        scrollBeyondLastLine: false,
        // メインエディタと同じく、エディタ内のスクロール余地が無いときは
        // ホイールイベントをページに渡す。これが無いと diff モードの上で
        // ホイールしてもページ全体がスクロールできなくなる。
        scrollbar: {
          vertical: 'auto',
          horizontal: 'auto',
          alwaysConsumeMouseWheel: false
        },
        automaticLayout: true,
        glyphMargin: true,
        wordWrap: 'on',
        minimap: { enabled: false },
        theme: (editor.getRawOptions && editor.getRawOptions().theme) || 'vs',
        fontSize: (editor.getOption && editor.getOption(monacoInstance.editor.EditorOption.fontSize)) || 13
      };
      var leftEditor = monacoInstance.editor.create(leftHost, Object.assign({}, commonOpts, { value: fromText }));
      var rightEditor = monacoInstance.editor.create(rightHost, Object.assign({}, commonOpts, { value: toText }));

      // 行装飾を適用
      applyDiffSideDecorations(monacoInstance, leftEditor, 'left', diff);
      applyDiffSideDecorations(monacoInstance, rightEditor, 'right', diff);

      // 行対応スクロール同期
      var syncingLR = false, syncingRL = false;
      leftEditor.onDidScrollChange(function () {
        if (syncingRL) return;
        var top = leftEditor.getScrollTop();
        // 左の上端行 → 対応する右の行 → 右の scrollTop
        var leftLine = leftEditor.getTopForLineNumber
          ? approxTopLineFromScroll(leftEditor, top, diff.leftTotal)
          : 1;
        var rightLine = diff.leftToRight[leftLine] || leftLine;
        var rightTop = rightEditor.getTopForLineNumber(rightLine);
        syncingLR = true;
        rightEditor.setScrollTop(rightTop);
        syncingLR = false;
      });
      rightEditor.onDidScrollChange(function () {
        if (syncingLR) return;
        var top = rightEditor.getScrollTop();
        var rightLine = rightEditor.getTopForLineNumber
          ? approxTopLineFromScroll(rightEditor, top, diff.rightTotal)
          : 1;
        var leftLine = diff.rightToLeft[rightLine] || rightLine;
        var leftTop = leftEditor.getTopForLineNumber(leftLine);
        syncingRL = true;
        leftEditor.setScrollTop(leftTop);
        syncingRL = false;
      });

      // ESC キーで diff モードを閉じる。
      // capture phase (true) で登録するので、他のリスナー
      // (例: フルスクリーン解除の Esc)より先に処理される。
      // stopImmediatePropagation で他のリスナーへは伝播させない。
      // → フルスクリーン中に diff を開いてた場合、最初のEscは
      //   diff だけを閉じ、次のEscでフルスクリーン解除、という
      //   階層的な挙動になる。
      var escHandler = function (ev) {
        if (ev.key !== 'Escape') return;
        ev.stopImmediatePropagation();
        ev.preventDefault();
        setMode('edit');
      };
      document.addEventListener('keydown', escHandler, true);

      diffState = {
        container: diffContainer,
        leftEditor: leftEditor,
        rightEditor: rightEditor,
        closeBtn: closeBtn,
        escHandler: escHandler
      };
    }

    // エディタの scrollTop からおおよその先頭行番号を推定。
    // getTopForLineNumber を逆算する関数が無いので、行ごとの top を線形検索。
    // 100行規模なら十分早い。
    function approxTopLineFromScroll(ed, scrollTop, totalLines) {
      var lo = 1, hi = Math.max(1, totalLines);
      // 二分探索
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        var t = ed.getTopForLineNumber(mid);
        if (t < scrollTop) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    // 言語ID解決(本体の detectFormat に揃える)
    function detectMonacoLanguage(fmt) {
      if (fmt === 'textile') return 'plaintext';
      return 'markdown';
    }

    // 左右どちらかのエディタに、diff の装飾(背景色+行頭マーカー)を貼る。
    // side: 'left' = 削除/旧側、'right' = 追加/新側
    //
    // 装飾の2層構造:
    //   1. 行全体の薄い赤/緑背景 + 行頭 -/+ マーカー (leftDeco/rightDeco)
    //   2. linePairs (変更行ペア) に対する文字レベルの濃い赤/緑ハイライト
    //      → 「行のどの文字が実際に変わったか」を VS Code Diff Editor 同様
    //         一目で分かるように強調する
    function applyDiffSideDecorations(mn, ed, side, diff) {
      var set = (side === 'left') ? diff.leftDeco : diff.rightDeco;
      var bgCls = (side === 'left') ? 'mte-diff-side-removed' : 'mte-diff-side-added';
      var marginCls = (side === 'left') ? 'mte-diff-glyph-minus' : 'mte-diff-glyph-plus';
      var tokenCls = (side === 'left') ? 'mte-diff-token-removed' : 'mte-diff-token-added';
      var model = ed.getModel();
      if (!model) return;
      var lineCount = model.getLineCount();
      var decos = [];

      // 1) 行全体の薄い背景
      set.forEach(function (ln) {
        if (ln < 1 || ln > lineCount) return;
        decos.push({
          range: new mn.Range(ln, 1, ln, 1),
          options: {
            isWholeLine: true,
            className: bgCls,
            glyphMarginClassName: marginCls
          }
        });
      });

      // 2) 変更行ペアに対する文字レベル装飾
      // linePairs の各ペアで、左テキストと右テキストを文字レベル diff し、
      // 削除/追加された文字範囲に濃い色装飾を貼る。
      if (diff.linePairs) {
        diff.linePairs.forEach(function (pair) {
          var ln = (side === 'left') ? pair.leftLine : pair.rightLine;
          if (ln < 1 || ln > lineCount) return;
          var ranges = computeIntraLineDiffRanges(pair.leftText, pair.rightText, side);
          ranges.forEach(function (r) {
            // r = { start, end } 1始まりの文字位置 (Monacoのcolumn基準)
            decos.push({
              range: new mn.Range(ln, r.start, ln, r.end),
              options: {
                className: tokenCls,
                inlineClassName: tokenCls
              }
            });
          });
        });
      }

      if (typeof ed.createDecorationsCollection === 'function') {
        ed.createDecorationsCollection(decos);
      } else {
        ed.deltaDecorations([], decos);
      }
    }

    // 行内の文字レベル diff を計算して、装飾を貼るべき range を返す。
    // side='left' なら削除文字 (del op)、side='right' なら追加文字 (ins op)。
    // 戻り値の start/end は Monaco の column 値 (1始まり)。
    //
    // サロゲートペア対応: Array.from(str) で「コードポイント単位」に分解した
    // 配列を gitMyersDiff に渡す。1コードポイントは UTF-16 で 1 or 2 ユニット
    // だが、Monaco の column は UTF-16 ユニット単位なので、各 op の文字の
    // .length を加算してカーソルを進める。
    function computeIntraLineDiffRanges(leftText, rightText, side) {
      var leftChars = Array.from(String(leftText || ''));
      var rightChars = Array.from(String(rightText || ''));
      var ops = gitMyersDiff(leftChars, rightChars);
      var ranges = [];
      // Monaco column (UTF-16 単位、1始まり)
      var col = 1;
      // ハンク蓄積用 (連続する del/ins をまとめて1つのrangeに)
      var curStart = -1, curEnd = -1;

      function flush() {
        if (curStart !== -1) {
          ranges.push({ start: curStart, end: curEnd });
          curStart = -1; curEnd = -1;
        }
      }

      // ops は a (=leftChars), b (=rightChars) を比較した結果。
      // op.line には eq/del は a 側の文字、ins は b 側の文字が入る。
      // side='left' のときは a 側 (eq + del) を走査して del 部分の column を集める。
      // side='right' のときは b 側 (eq + ins) を走査して ins 部分の column を集める。
      for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        var ch = op.line == null ? '' : op.line;
        var u16len = String(ch).length || 1;

        if (op.op === 'eq') {
          flush();
          col += u16len;
        } else if (op.op === 'del') {
          if (side === 'left') {
            // 削除文字 = 左側に存在する文字 → column を集める
            if (curStart === -1) { curStart = col; curEnd = col + u16len; }
            else { curEnd = col + u16len; }
            col += u16len;
          } else {
            // 右側にとっては del は無関係。col は進めない
            // (b 側を走査してるので、a 側の文字は飛ばすだけ)
          }
        } else if (op.op === 'ins') {
          if (side === 'right') {
            // 追加文字 = 右側に存在する文字 → column を集める
            if (curStart === -1) { curStart = col; curEnd = col + u16len; }
            else { curEnd = col + u16len; }
            col += u16len;
          } else {
            // 左側にとっては ins は無関係。col は進めない
          }
        }
      }
      flush();
      return ranges;
    }

    btnEdit.addEventListener('click', function () { setMode('edit'); });
    btnSplit.addEventListener('click', function () { setMode('split'); });
    btnSplitV.addEventListener('click', function () { setMode('split-v'); });
    btnPreview.addEventListener('click', function () { setMode('preview'); });

    // 外部(setupHistoryDropdown 等)から diff モードへ切り替えるための公開フック。
    editor.__mteOpenDiff = function (payload) { setMode('diff', payload); };

    // ウィンドウリサイズ時にレイアウト更新
    window.addEventListener('resize', function () { editor.layout(); });

    // 既存の「プレビュー」タブ（Redmineデフォルト）を非表示にする
    hideDefaultPreviewTab(textarea);

    // 純正 jsToolBar（Redmineデフォルトのツールバー）を非表示にする
    hideJsToolBar(textarea);

    // 縦リサイズハンドルを追加
    addVerticalResizer(wrapper, editor);

    // 分割スプリッター（ペイン境界のドラッグ）を追加
    addSplitter(splitter, paneWrap, editorContainer, previewPane, editor);

    // #1010 キャレット連動ツールチップをセットアップ
    setupCaretTooltip(editor, monacoInstance);

    // アウトラインパネルをセットアップ（トグル）
    setupOutline(editor, monacoInstance, body, outlinePane, btnOutline, textFormat);

    // 全画面トグルをセットアップ
    setupFullscreen(wrapper, btnFullscreen, editor);

    // @メンションの補完確定→ログインID置換 と ツールチップをセットアップ
    setupMention(editor, monacoInstance);

    // 装飾ツールバーのクリックハンドラを登録
    // decoBtns は { bold: <button>, italic: <button>, ... } のマップ。
    // setupDecoToolbar はこのキーで各ボタンにハンドラを結線する。
    // wrapper は表ビルダーのオーバーレイパネルの配置先として渡す。
    setupDecoToolbar(editor, decoBtns, textarea, wrapper);

    // 編集差分マーカー: 開いた時点の本文を基準に、編集中の
    // 追加(緑)・変更(青)・削除(赤三角)を gutter に出す。
    setupChangeDiff(editor, textarea);

    // 変更履歴ドロップダウン: 過去版同士の diff を選んで開く。
    // データ(window.MONACO_EDITOR_DIFF)が無い/空ならボタン自体を隠す。
    setupHistoryDropdown(btnHistory, editor, textarea);

    // カーソル行に「著者・日付・#注記」をうっすら表示する Blame ヒント。
    // 履歴データが無ければ何もしない。
    setupBlameHint(editor, textarea);
  }

  // ============================================================
  // @メンションの確定処理＆ツールチップ
  function setupMention(editor, monacoInstance) {
    // @ログインID のツールチップ（キャレット連動。#xxx のユーザー版）
    setupMentionTooltip(editor, monacoInstance);
  }

  // @ログインID にキャレットを合わせると「ログインID: 表示名」を表示する
  function setupMentionTooltip(editor, monacoInstance) {
    var currentLogin = null;

    function isSuggestWidgetOpen() {
      // 補完ウィジェットがDOMに見えているか
      var node = editor.getDomNode();
      if (!node) { return false; }
      var w = node.querySelector('.suggest-widget.visible');
      return !!w;
    }

    function update() {
      var position = editor.getPosition();
      if (!position) { hideMentionTooltip(); currentLogin = null; return; }

      // 補完候補が出ている最中はツールチップを出さない（邪魔になるため）
      if (isSuggestWidgetOpen()) { hideMentionTooltip(); currentLogin = null; return; }

      var hit = findMentionAtPosition(editor.getModel(), position);
      if (!hit) { hideMentionTooltip(); currentLogin = null; return; }
      if (hit.login === currentLogin) { return; } // 同じ対象なら何もしない
      currentLogin = hit.login;

      resolveUserByLogin(hit.login).then(function (info) {
        // 解決中にキャレットが移動していたら中止
        var nowPos = editor.getPosition();
        var nowHit = nowPos && findMentionAtPosition(editor.getModel(), nowPos);
        if (!nowHit || nowHit.login !== hit.login) { return; }

        // 補完が開いたら出さない（解決中に開いた場合の保険）
        if (isSuggestWidgetOpen()) { hideMentionTooltip(); return; }

        // 完全一致するユーザーが居る時だけ表示。
        // 入力途中（ochi 等、確定前）や不一致では何も出さない（邪魔防止）。
        if (!info || !info.name || info.login !== hit.login) {
          hideMentionTooltip();
          return;
        }

        var el = getMentionTooltipEl();
        el.innerHTML = '<span class="tip-id">' + escapeHtml(info.login) +
                       '</span>: ' + escapeHtml(info.name);
        positionMentionTooltip(editor, hit);
      });
    }

    editor.onDidChangeCursorPosition(update);
    editor.onDidBlurEditorText(function () {
      hideMentionTooltip(); currentLogin = null;
    });
  }

  // 行内で @ログインID を検出（キャレットがその範囲内にあるか）
  function findMentionAtPosition(model, position) {
    if (!model) { return null; }
    var line = model.getLineContent(position.lineNumber);
    var re = /@([A-Za-z0-9_.-]+)/g;
    var match;
    while ((match = re.exec(line)) !== null) {
      var startCol = match.index + 1;
      var endCol = startCol + match[0].length;
      if (position.column >= startCol && position.column <= endCol) {
        return { login: match[1], startCol: startCol, endCol: endCol };
      }
    }
    return null;
  }

  // メンションツールチップDOM（body直下に1つ使い回す）
  var mentionTooltipEl = null;
  function getMentionTooltipEl() {
    if (!mentionTooltipEl) {
      mentionTooltipEl = document.createElement('div');
      mentionTooltipEl.className = 'monaco-issue-tooltip'; // #xxxと同じスタイル流用
      document.body.appendChild(mentionTooltipEl);
    }
    mentionTooltipEl.style.display = 'block';
    return mentionTooltipEl;
  }
  function hideMentionTooltip() {
    if (mentionTooltipEl) { mentionTooltipEl.style.display = 'none'; }
  }
  function positionMentionTooltip(editor, hit) {
    if (!mentionTooltipEl) { return; }
    var pos = { lineNumber: editor.getPosition().lineNumber, column: hit.startCol };
    var coord = editor.getScrolledVisiblePosition(pos);
    if (!coord) { return; }
    var node = editor.getDomNode();
    if (!node) { return; }
    var rect = node.getBoundingClientRect();
    var top = rect.top + coord.top - mentionTooltipEl.offsetHeight - 6;
    var left = rect.left + coord.left;
    // 上に出す余白が無ければ下に出す
    if (top < 0) { top = rect.top + coord.top + 20; }
    // 配置先をフルスクリーン状態に追従させ、座標系を合わせる
    // （全画面要素内ではビューポート基準のため scroll を足さない）。
    var fsEl = ensureTooltipParent(mentionTooltipEl);
    if (fsEl) {
      mentionTooltipEl.style.top = top + 'px';
      mentionTooltipEl.style.left = left + 'px';
    } else {
      mentionTooltipEl.style.top = (top + window.scrollY) + 'px';
      mentionTooltipEl.style.left = (left + window.scrollX) + 'px';
    }
  }


  // ============================================================
  // アウトラインパネル（自前ツリー・トグル表示）
  // ============================================================
  function setupOutline(editor, monacoInstance, body, outlinePane, btnOutline, textFormat) {
    var visible = false;
    var rebuildTimer = null;
    var fmt = textFormat || 'markdown';

    // 見出しを解析してフラットなリストで返す（Markdown/Textile両対応）
    function parseHeadings() {
      var model = editor.getModel();
      if (!model) { return []; }
      var lines = model.getLinesContent();
      var result = [];
      var inFence = false;
      var fenceRe = /^\s*(```|~~~)/;

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        // Markdownのコードフェンスのみフェンス追跡（Textileに```概念は無いが無害）
        if (fmt !== 'textile' && fenceRe.test(line)) { inFence = !inFence; continue; }
        if (inFence) { continue; }
        var h = parseHeadingLine(line, fmt);
        if (!h) { continue; }
        result.push({
          level: h.level,
          text: h.text,
          lineNumber: i + 1
        });
      }
      return result;
    }

    // ツリーを描画
    function render() {
      var headings = parseHeadings();
      outlinePane.innerHTML = '';

      if (headings.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'monaco-outline-empty';
        empty.textContent = t('outline_empty', 'No headings');
        outlinePane.appendChild(empty);
        return;
      }

      // 最小レベルを基準にインデント量を決める（H2始まりでも左端から見えるよう正規化）
      var minLevel = Math.min.apply(null, headings.map(function (h) { return h.level; }));

      headings.forEach(function (h) {
        var item = document.createElement('div');
        item.className = 'monaco-outline-item level-' + h.level;
        // レベルに応じてインデント（最小レベルを0段目とする）
        item.style.paddingLeft = (8 + (h.level - minLevel) * 14) + 'px';
        item.textContent = h.text;
        item.title = h.text;

        item.addEventListener('click', function () {
          // クリックした見出しの行へジャンプ＆カーソル移動
          editor.revealLineNearTop(h.lineNumber);
          editor.setPosition({ lineNumber: h.lineNumber, column: 1 });
          editor.focus();
        });

        outlinePane.appendChild(item);
      });
    }

    function setVisible(v) {
      visible = v;
      if (v) {
        body.classList.add('outline-visible');
        btnOutline.classList.add('active');
        render();
      } else {
        body.classList.remove('outline-visible');
        btnOutline.classList.remove('active');
      }
      setTimeout(function () { editor.layout(); }, 50);
    }

    btnOutline.addEventListener('click', function () {
      setVisible(!visible);
    });

    // 編集に追従してツリーを更新（表示中のみ、debounce）
    editor.onDidChangeModelContent(function () {
      if (!visible) { return; }
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(render, 400);
    });
  }

  // ============================================================
  // プレビュー内サムネイルのライトボックス（拡大表示）
  // ============================================================
  // {{thumbnail(image.png)}} はプレビューHTML上では概ね
  //   <a href="/attachments/123/image.png" ...>
  //     <img src="/attachments/thumbnail/123/..." class="thumbnail" ...>
  //   </a>
  // のような構造になる。このリンクを素でクリックすると元画像URLへ
  // 遷移してしまい、編集中だと離脱警告ダイアログが出る。
  //
  // そこでプレビューペインにクリックを委譲で受け、サムネイル相当の
  // クリックなら preventDefault してページ内モーダルで拡大表示する。
  // 委譲なので再描画でDOMが入れ替わっても張り直し不要（ペイン自体に1回だけ）。

  // 全エディタで共有する単一のライトボックス要素
  var lightboxEl = null;
  var lightboxImg = null;

  function getLightbox() {
    if (lightboxEl) { return lightboxEl; }

    lightboxEl = document.createElement('div');
    lightboxEl.className = 'monaco-lightbox';
    lightboxEl.style.display = 'none';

    lightboxImg = document.createElement('img');
    lightboxImg.className = 'monaco-lightbox-img';
    lightboxImg.alt = '';

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'monaco-lightbox-close';
    closeBtn.setAttribute('aria-label', 'close');
    closeBtn.innerHTML = '×';

    lightboxEl.appendChild(lightboxImg);
    lightboxEl.appendChild(closeBtn);
    document.body.appendChild(lightboxEl);

    // 背景クリック・×ボタンで閉じる（画像本体クリックでは閉じない）
    lightboxEl.addEventListener('click', function (e) {
      if (e.target === lightboxImg) { return; }
      hideLightbox();
    });

    // ESCで閉じる
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && lightboxEl && lightboxEl.style.display !== 'none') {
        hideLightbox();
      }
    });

    return lightboxEl;
  }

  function showLightbox(src, alt) {
    var box = getLightbox();
    // フルスクリーン中は全画面要素の中へ移す（body直下だと隠れるため）。
    // ライトボックスは fixed/inset:0 で全面を覆うので座標調整は不要。
    ensureTooltipParent(box);
    lightboxImg.src = src;
    lightboxImg.alt = alt || '';
    box.style.display = 'flex';
  }

  function hideLightbox() {
    if (lightboxEl) {
      lightboxEl.style.display = 'none';
      // メモリ解放と次回チラつき防止のため src を空にする
      if (lightboxImg) { lightboxImg.src = ''; }
    }
  }

  // プレビューペインにサムネイルクリックの委譲を1回だけ張る。
  function setupThumbnailLightbox(previewPane) {
    if (!previewPane || previewPane._monacoLightboxBound) { return; }
    previewPane._monacoLightboxBound = true;

    previewPane.addEventListener('click', function (e) {
      // クリック地点から最も近い <a> を辿る
      var link = e.target.closest ? e.target.closest('a') : null;
      if (!link) { return; }

      // サムネイル判定:
      //   (1) リンク内に img.thumbnail がある（{{thumbnail}}の典型）
      //   (2) もしくはリンク直下が画像で、hrefが画像系拡張子
      var img = link.querySelector('img');
      var href = link.getAttribute('href') || '';
      var looksImage = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.test(href);
      var isThumb = img && (
        img.classList.contains('thumbnail') ||
        looksImage ||
        /\/attachments\//.test(href)
      );

      if (!isThumb) { return; }

      // ページ遷移（＝離脱警告）を止めて、画面内で拡大表示する
      e.preventDefault();
      e.stopPropagation();

      // 拡大に使うURLは「元画像（リンク先）」を優先。
      // href が画像でなければサムネイル画像のsrcで代替する。
      var fullSrc = looksImage ? href : (img ? img.src : href);
      showLightbox(fullSrc, img ? img.alt : '');
    });
  }

  // ============================================================
  // スクロール同期（エディタ → プレビュー、一方向）
  // ============================================================
  // 方式: 見出しアンカー同期。
  //   エディタで今見えている一番上の見出しを特定し、プレビュー側の
  //   対応する見出しが同じ高さに来るようプレビューをスクロールする。
  //   見出し単位で位置を合わせるため、画像やコードブロックで高さがズレても
  //   次の見出しで必ず帳尻が合う。
  // 制約:
  //   - 同期はエディタ→プレビューの一方向のみ。
  //   - プレビューを手動操作している間は同期しない（独立）。
  function setupScrollSync(editor, previewPane, body, textFormat) {
    var fmt = textFormat || 'markdown';
    // プレビュー手動操作中フラグ（操作後しばらくは同期を抑制）
    var previewInteracting = false;
    var interactTimer = null;

    function markPreviewInteract() {
      previewInteracting = true;
      clearTimeout(interactTimer);
      interactTimer = setTimeout(function () {
        previewInteracting = false;
      }, 800); // 最後の操作から800msは同期を止める
    }

    // プレビュー側の操作を検知（ホイール・ドラッグ・タッチ）
    previewPane.addEventListener('wheel', markPreviewInteract, { passive: true });
    previewPane.addEventListener('mousedown', markPreviewInteract);
    previewPane.addEventListener('touchstart', markPreviewInteract, { passive: true });

    // エディタ側で見えている見出し → プレビューの同じ見出しへ合わせる
    function sync() {
      // 分割表示中のみ動作。プレビュー操作中はスキップ。
      if (!body.classList.contains('split-view')) { return; }
      if (previewInteracting) { return; }

      var model = editor.getModel();
      if (!model) { return; }

      // エディタで今見えている最上部の行番号
      var visibleRanges = editor.getVisibleRanges();
      if (!visibleRanges || visibleRanges.length === 0) { return; }
      var topLine = visibleRanges[0].startLineNumber;

      // ---- 終端の特別扱い ----
      // エディタが最下部付近まで来たら、見出し位置ではなくプレビューも
      // 最下部へ合わせる。最後の見出し以降をスクロールしても追従するように。
      var edScrollTop = editor.getScrollTop();
      var edMaxScroll = editor.getScrollHeight() - editor.getLayoutInfo().height;
      if (edMaxScroll > 0 && edScrollTop >= edMaxScroll - 4) {
        previewPane.scrollTop = previewPane.scrollHeight - previewPane.clientHeight;
        return;
      }

      // ---- 先頭の特別扱い ----
      // エディタが最上部付近なら、プレビューも完全な先頭(0)へ。
      // 見出しのoffsetTop合わせだと先頭見出しが少し隠れるのを防ぐ。
      if (edScrollTop <= 4) {
        previewPane.scrollTop = 0;
        return;
      }

      // エディタ側の見出しを収集（行番号・テキスト。Markdown/Textile両対応）
      var lines = model.getLinesContent();
      var inFence = false;
      var fenceRe = /^\s*(```|~~~)/;
      var headings = [];
      for (var i = 0; i < lines.length; i++) {
        if (fmt !== 'textile' && fenceRe.test(lines[i])) { inFence = !inFence; continue; }
        if (inFence) { continue; }
        var h = parseHeadingLine(lines[i], fmt);
        if (h) {
          headings.push({ line: i + 1, text: h.text.trim() });
        }
      }
      if (headings.length === 0) {
        // 見出しが無い場合は比率ベースにフォールバック
        ratioSync();
        return;
      }

      // topLine 以前で一番近い見出しと、その次の見出しを特定
      var curIdx = -1;
      for (var j = 0; j < headings.length; j++) {
        if (headings[j].line <= topLine) { curIdx = j; } else { break; }
      }

      if (curIdx === -1) {
        // 最初の見出しより上 → プレビューを先頭へ
        previewPane.scrollTop = 0;
        return;
      }

      var cur = headings[curIdx];

      // プレビュー側で対応する見出し要素を探す（テキスト一致）
      var pvHeading = findPreviewHeading(previewPane, cur.text, curIdx);
      if (!pvHeading) { return; }

      // エディタ側で「現在の見出しから次の見出しまで」のどこにいるか割合を出し、
      // プレビュー側の対応区間に同じ割合で当てはめる（見出し間の補間）
      var next = headings[curIdx + 1];
      var pvNext = next ? findPreviewHeading(previewPane, next.text, curIdx + 1) : null;

      var frac = 0;
      if (next) {
        var span = next.line - cur.line;
        if (span > 0) { frac = (topLine - cur.line) / span; }
        frac = Math.max(0, Math.min(1, frac));
      }

      var curTop = pvHeading.offsetTop;
      var targetTop;
      if (pvNext) {
        targetTop = curTop + (pvNext.offsetTop - curTop) * frac;
      } else {
        targetTop = curTop;
      }

      // プレビューの見出しがペイン上部に来るようスクロール
      previewPane.scrollTop = targetTop - 8;
    }

    // 比率ベースのフォールバック（見出しが無い文書用）
    function ratioSync() {
      var model = editor.getModel();
      var total = model.getLineCount();
      var visibleRanges = editor.getVisibleRanges();
      if (!visibleRanges || visibleRanges.length === 0) { return; }
      var topLine = visibleRanges[0].startLineNumber;
      var ratio = total > 1 ? (topLine - 1) / (total - 1) : 0;
      var max = previewPane.scrollHeight - previewPane.clientHeight;
      previewPane.scrollTop = max * ratio;
    }

    // プレビュー内の見出し要素を、テキスト一致で探す。
    // 同じテキストの見出しが複数ある場合に備え、出現順インデックスも考慮する。
    function findPreviewHeading(pane, text, occurrenceIndex) {
      var target = normalizeHeading(text);
      var hs = pane.querySelectorAll('h1, h2, h3, h4, h5, h6');
      var matches = [];
      for (var i = 0; i < hs.length; i++) {
        if (normalizeHeading(hs[i].textContent) === target) {
          matches.push(hs[i]);
        }
      }
      if (matches.length === 0) {
        // 完全一致が無ければ前方一致で緩く探す
        for (var k = 0; k < hs.length; k++) {
          var tt = normalizeHeading(hs[k].textContent);
          if (tt && (tt.indexOf(target) === 0 || target.indexOf(tt) === 0)) {
            return hs[k];
          }
        }
        return null;
      }
      return matches[0];
    }

    // 見出しテキストの正規化。
    // Redmineはプレビュー見出しに ¶（アンカーマーカー）を付けたり、
    // 章番号を自動採番することがあるため、それらを除去して比較する。
    function normalizeHeading(s) {
      return String(s || '')
        .replace(/¶/g, '')                 // アンカーマーカー
        .replace(/^\s*[\d.]+\s+/, '')       // 先頭の章番号 "2.4. " 等
        .replace(/\s+/g, ' ')               // 連続空白を1つに
        .trim();
    }

    // エディタのスクロールに追従（throttleでパフォーマンス確保）
    var rafPending = false;
    editor.onDidScrollChange(function () {
      if (rafPending) { return; }
      rafPending = true;
      requestAnimationFrame(function () {
        rafPending = false;
        sync();
      });
    });
  }


  // ============================================================
  // 分割スプリッター（エディタ／プレビューの境界をドラッグして割合変更）
  // ============================================================
  // 左右分割: 横方向にドラッグ → 各ペインの幅(flex-basis)を変更
  // 縦分割  : 縦方向にドラッグ → 各ペインの高さ(flex-basis)を変更
  function addSplitter(splitter, measureEl, editorContainer, previewPane, editor) {
    var dragging = false;

    // 分割方向の判定は body のクラスを見る必要があるため、
    // measureEl（paneWrap）から親を辿って .monaco-editor-body を取得する。
    var bodyEl = measureEl.closest('.monaco-editor-body') || measureEl;

    function isVertical() {
      // split-vertical クラスが付いている、または狭い画面で縦並びになっている
      return bodyEl.classList.contains('split-vertical') ||
             window.matchMedia('(max-width: 768px)').matches;
    }

    function onMouseDown(e) {
      dragging = true;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = isVertical() ? 'row-resize' : 'col-resize';
      e.preventDefault();
    }

    function onMouseMove(e) {
      if (!dragging) { return; }

      // 割合計算の基準は paneWrap（エディタ＋プレビューの領域のみ）。
      // アウトライン表示時もこの領域は変わらないため計算が安定する。
      var rect = measureEl.getBoundingClientRect();
      var ratio;

      if (isVertical()) {
        // 上下: マウスのY位置から上ペインの割合を算出
        ratio = (e.clientY - rect.top) / rect.height;
      } else {
        // 左右: マウスのX位置から左ペインの割合を算出
        ratio = (e.clientX - rect.left) / rect.width;
      }

      // 10%〜90%の範囲に制限
      ratio = Math.max(0.1, Math.min(0.9, ratio));

      var pct = (ratio * 100).toFixed(1);
      var rest = (100 - ratio * 100).toFixed(1);
      editorContainer.style.flex = '0 0 ' + pct + '%';
      previewPane.style.flex = '0 0 ' + rest + '%';

      editor.layout();
    }

    function onMouseUp() {
      if (!dragging) { return; }
      dragging = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      editor.layout();
    }

    splitter.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // ============================================================
  // 縦リサイズハンドル（下端をドラッグして高さ変更）
  // ============================================================
  // ============================================================
  // 全画面トグル
  // ============================================================
  // ディスプレイ全体のフルスクリーン（ブラウザのFullscreen API）で
  // エディタ(wrapper)だけを全画面表示する。
  //   - ボタン押下でトグル（Fullscreen APIはユーザー操作起点で発動）
  //   - ESC はブラウザが自動でフルスクリーン解除（fullscreenchangeで検知）
  //   - レイアウトは擬似全画面用の .monaco-fullscreen クラスを流用し、
  //     wrapper を画面いっぱいに広げる
  //   - Fullscreen API が使えない環境では擬似全画面にフォールバック
  function setupFullscreen(wrapper, btn, editor) {
    var pseudo = false; // フォールバック（擬似全画面）中か

    function relayout() {
      requestAnimationFrame(function () {
        try { editor.layout(); } catch (e) { /* no-op */ }
      });
    }

    // クロスブラウザの requestFullscreen / exitFullscreen / 現在の要素
    function reqFull(el) {
      // ユーザー操作コンテキストを確実に引き継ぐため、各APIを直接呼ぶ。
      if (el.requestFullscreen)        { return el.requestFullscreen(); }
      if (el.webkitRequestFullscreen)  { return el.webkitRequestFullscreen(); }
      if (el.mozRequestFullScreen)     { return el.mozRequestFullScreen(); }
      if (el.msRequestFullscreen)      { return el.msRequestFullscreen(); }
      return null;
    }
    function exitFull() {
      var fn = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
      return fn ? fn.call(document) : null;
    }
    function fullEl() {
      return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement || null;
    }
    function apiSupported() {
      return !!(wrapper.requestFullscreen || wrapper.webkitRequestFullscreen || wrapper.mozRequestFullScreen || wrapper.msRequestFullscreen);
    }

    // 見た目（クラス・アイコン）を全画面状態に合わせる
    function applyOn() {
      wrapper.classList.add('monaco-fullscreen');
      document.body.classList.add('monaco-fullscreen-active');
      btn.innerHTML = ICON_FULLSCREEN_EXIT;
      btn.classList.add('active');
      relayout();
    }
    function applyOff() {
      wrapper.classList.remove('monaco-fullscreen');
      document.body.classList.remove('monaco-fullscreen-active');
      btn.innerHTML = ICON_FULLSCREEN;
      btn.classList.remove('active');
      relayout();
    }

    // ---- Fullscreen API 利用時 ----
    // ブラウザのフルスクリーン状態が変わったらクラスを同期する。
    // ESCでの解除もここで拾える。
    function onFsChange() {
      if (fullEl() === wrapper) {
        applyOn();
      } else {
        applyOff();
      }
    }

    // ---- 擬似全画面（フォールバック）用のESCハンドラ ----
    function onKeydown(e) {
      if (e.key === 'Escape' && e.keyCode !== 229) {
        e.preventDefault();
        e.stopPropagation();
        exitPseudo();
      }
    }
    function enterPseudo() {
      if (pseudo) { return; }
      pseudo = true;
      applyOn();
      document.addEventListener('keydown', onKeydown, true);
    }
    function exitPseudo() {
      if (!pseudo) { return; }
      pseudo = false;
      applyOff();
      document.removeEventListener('keydown', onKeydown, true);
    }

    function toggle() {
      if (apiSupported()) {
        // ディスプレイ全体のフルスクリーン
        if (fullEl() === wrapper) {
          exitFull();
        } else {
          // requestFullscreen は必ず click ハンドラから直接呼ぶ
          // （ユーザー操作起点として扱われる必要があるため、
          //   ここで余計なDOM操作やalertを挟まない）。
          // 見た目の更新は fullscreenchange イベント側に任せる。
          var p = reqFull(wrapper);
          if (p && typeof p.catch === 'function') {
            p.catch(function (err) {
              // 失敗時のみ擬似全画面にフォールバック
              if (window.console) { console.warn('[monaco] requestFullscreen failed:', err && err.name, err && err.message); }
              enterPseudo();
            });
          }
        }
      } else {
        // API非対応 → 擬似全画面トグル
        pseudo ? exitPseudo() : enterPseudo();
      }
    }

    // フルスクリーン状態変化イベント（各ベンダープレフィックス）
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    document.addEventListener('mozfullscreenchange', onFsChange);
    document.addEventListener('MSFullscreenChange', onFsChange);

    btn.addEventListener('click', toggle);
  }

  function addVerticalResizer(wrapper, editor) {
    var handle = document.createElement('div');
    handle.className = 'monaco-resize-handle';
    handle.title = t('resize_tip', 'Drag to resize height');
    wrapper.appendChild(handle);

    var startY = 0;
    var startHeight = 0;
    var dragging = false;

    function onMouseDown(e) {
      dragging = true;
      startY = e.clientY;
      startHeight = wrapper.offsetHeight;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ns-resize';
      e.preventDefault();
    }

    function onMouseMove(e) {
      if (!dragging) { return; }
      var newHeight = Math.max(150, startHeight + (e.clientY - startY));
      // wrapper は display:flex/column なので高さだけ決めれば
      // body は flex:1 で自動的に残り領域を埋める（はみ出し防止）。
      wrapper.style.height = newHeight + 'px';
      editor.layout();
    }

    function onMouseUp() {
      if (!dragging) { return; }
      dragging = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      editor.layout();
    }

    handle.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // ============================================================
  // Redmineデフォルトのタブ（編集/プレビュー切り替えUI）を非表示
  // ============================================================
  // 実DOM構造:
  //   span#..._and_toolbar > div.jstBlock > div.jstTabs.tabs > ul
  //     > li > a.tab-edit "編集"
  //     > li > a.tab-preview "プレビュー"   ← 押すと下に純正プレビューが出る
  //     > li.tab-elements > div.jstElements ← B/I等のツールボタン（Monacoには無効）
  // Monacoに置き換え済みなので jstTabs(タブ＋ツールバー) を丸ごと隠す。
  function hideDefaultPreviewTab(textarea) {
    var block = textarea.closest('.jstBlock');
    if (!block) { return; }

    // タブUI（編集/プレビュー）＋旧ツールバーをまとめて非表示
    var tabs = block.querySelector('.jstTabs');
    if (tabs) {
      tabs.style.display = 'none';
    }

    // 念のため、純正プレビューが既に開いていたら畳む
    var openedPreview = document.querySelector('#preview');
    if (openedPreview) {
      openedPreview.style.display = 'none';
    }
  }

  // ============================================================
  // 純正 jsToolBar（Redmineデフォルトのツールバー）を非表示
  // ============================================================
  // hideDefaultPreviewTab で .jstTabs を隠すと B/I等の旧ボタンも消えるが、
  // テーマによっては .jstElements が .jstTabs の外に出ることがあるため念のため。
  function hideJsToolBar(textarea) {
    // jstBlock 内の jstElements（旧ツールボタン群）を非表示
    var block = textarea.closest('.jstBlock');
    if (!block) { return; }
    var elements = block.querySelector('.jstElements');
    if (elements) { elements.style.display = 'none'; }
  }

  // ============================================================
  // 装飾ツールバーのクリック処理
  // ============================================================
  // 選択テキストがあれば「囲む」、なければカーソル位置に挿入する。
  // 行頭系（見出し・リスト・引用・コードブロック）は選択行全体を変換する。
  function setupDecoToolbar(editor, btns, textarea, wrapper) {
    // このエディタのフォーマットに対応した記法テーブル
    var fmt = detectFormat(textarea);
    var syntax = syntaxFor(fmt);

    // ---- 共通ユーティリティ ----

    // 選択テキストを prefix/suffix で囲む（選択なしはプレースホルダを挿入）
    function wrapInline(prefix, suffix, placeholder) {
      var sel = editor.getSelection();
      var model = editor.getModel();
      if (!sel || !model) { return; }

      var selectedText = model.getValueInRange(sel);
      var isEmpty = (sel.startLineNumber === sel.endLineNumber &&
                     sel.startColumn === sel.endColumn);
      var text = isEmpty ? placeholder : selectedText;
      var replacement = prefix + text + suffix;

      editor.executeEdits('deco-wrap', [{
        range: sel,
        text: replacement,
        forceMoveMarkers: true
      }]);

      // プレースホルダのみの場合: プレースホルダ部分を選択
      if (isEmpty) {
        var newCol = sel.startColumn + prefix.length;
        editor.setSelection({
          startLineNumber: sel.startLineNumber,
          startColumn: newCol,
          endLineNumber: sel.startLineNumber,
          endColumn: newCol + placeholder.length
        });
      }
      editor.focus();
    }

    // wrap系操作を記法テーブルから実行
    function applyWrap(key) {
      var s = syntax[key];
      if (!s) { return; }
      wrapInline(s.prefix, s.suffix, s.placeholder);
    }

    // 選択行（複数行対応）の行頭をトグル変換する。
    // spec: { prefix, exact, textile, ordered }
    //   exact=true   : 見出しなど（Markdown "## " / Textile "h2. "）
    //   exact=false  : リスト・引用（先頭一致で除去）
    //   textile=true : Textile見出し（"h2." の後に半角スペース1つ。Markdownの "##" とは付与形が異なる）
    //   ordered=true : Markdown番号付きリスト（"1. " 固定ではなく行ごとに連番。
    //                  解除は /^\d+\.\s/ で任意の番号に対応する。Textileの "# " は
    //                  記号固定なので ordered 不要＝従来パスで正しく動く）
    function toggleLineSpec(spec) {
      var sel = editor.getSelection();
      var model = editor.getModel();
      if (!sel || !model) { return; }

      var prefix = spec.prefix;
      var exactMatch = spec.exact;
      var isTextileHeading = !!spec.textile;

      var startLine = sel.startLineNumber;
      var endLine = sel.endLineNumber;
      if (endLine > startLine && sel.endColumn === 1) { endLine--; }

      // ---- Markdown番号付きリスト専用パス ----
      // 行頭の "数字 + . + 空白" を1セットとして扱う。固定文字列マッチだと
      // "1. " しか外せず連番が崩れるため、正規表現で判定・除去する。
      if (spec.ordered) {
        var ORDERED_RE = /^\d+\.\s/;

        // 全行がすでに番号付きなら解除、1行でも未付与があれば連番を振り直す。
        var allOrdered = true;
        for (var c = startLine; c <= endLine; c++) {
          if (!ORDERED_RE.test(model.getLineContent(c))) { allOrdered = false; break; }
        }

        var orderedEdits = [];
        var counter = 1;
        for (var j = startLine; j <= endLine; j++) {
          var lc = model.getLineContent(j);
          var nc;
          if (allOrdered) {
            // 解除: 既存の "N. " を除去
            nc = lc.replace(ORDERED_RE, '');
          } else {
            // 付与: 既存番号があれば一旦剥がしてから連番を振る（二重番号・番号ズレ防止）
            nc = (counter++) + '. ' + lc.replace(ORDERED_RE, '');
          }
          orderedEdits.push({
            range: {
              startLineNumber: j, startColumn: 1,
              endLineNumber: j, endColumn: lc.length + 1
            },
            text: nc,
            forceMoveMarkers: true
          });
        }

        editor.executeEdits('deco-line-prefix', orderedEdits);
        editor.focus();
        return;
      }

      // Textile見出しは "h2. " で1セット（付与時に必ず末尾スペース）。
      // Markdown見出しは "##" + スペースで付与。
      var addPrefix, hasPrefixStr;
      if (isTextileHeading) {
        addPrefix = prefix + ' ';        // "h2. "
        hasPrefixStr = prefix + ' ';     // 判定も "h2. "
      } else if (exactMatch) {
        addPrefix = prefix + ' ';        // "## "
        hasPrefixStr = prefix + ' ';
      } else {
        addPrefix = prefix;              // "- " など（すでに末尾スペース込み）
        hasPrefixStr = prefix;
      }

      var edits = [];
      for (var i = startLine; i <= endLine; i++) {
        var lineContent = model.getLineContent(i);
        var hasPrefix = lineContent.startsWith(hasPrefixStr) ||
                        (exactMatch && lineContent === prefix);

        var newContent;
        if (hasPrefix) {
          newContent = lineContent.startsWith(hasPrefixStr)
            ? lineContent.slice(hasPrefixStr.length)
            : lineContent.slice(prefix.length);
        } else {
          newContent = addPrefix + lineContent;
        }

        edits.push({
          range: {
            startLineNumber: i, startColumn: 1,
            endLineNumber: i, endColumn: lineContent.length + 1
          },
          text: newContent,
          forceMoveMarkers: true
        });
      }

      editor.executeEdits('deco-line-prefix', edits);
      editor.focus();
    }

    function applyLine(key) {
      var s = syntax[key];
      if (!s) { return; }
      toggleLineSpec(s);
    }

    // コードブロック挿入。フォーマットにより記法が異なる。
    //   markdown: ```lang ... ```
    //   textile : <pre><code> ... </code></pre>
    function applyCodeBlock() {
      var sel = editor.getSelection();
      var model = editor.getModel();
      if (!sel || !model) { return; }

      var mode = (syntax.codeBlock && syntax.codeBlock.type) || 'mdfence';
      var isEmpty = (sel.startLineNumber === sel.endLineNumber &&
                     sel.startColumn === sel.endColumn);

      var open, close, caretLineOffset, caretCol;
      if (mode === 'pretag') {
        open = '<pre><code>';
        close = '</code></pre>';
      } else {
        open = '```';
        close = '```';
      }

      if (isEmpty) {
        var line = sel.startLineNumber;
        var lineContent = model.getLineContent(line);
        var atLineEnd = (sel.startColumn > lineContent.length);
        var insertText = (atLineEnd ? '\n' : '') + open + '\n\n' + close;
        editor.executeEdits('deco-code-block', [{
          range: {
            startLineNumber: line, startColumn: sel.startColumn,
            endLineNumber: line, endColumn: sel.startColumn
          },
          text: insertText
        }]);
        // 中身の空行にカーソルを置く
        var insertLine = (atLineEnd ? line + 1 : line) + 1;
        editor.setPosition({ lineNumber: insertLine, column: 1 });
      } else {
        var startLine = sel.startLineNumber;
        var selectedText = model.getValueInRange(sel);
        editor.executeEdits('deco-code-block', [{
          range: sel,
          text: open + '\n' + selectedText + '\n' + close
        }]);
        // markdownはlang入力のため ``` 行末、textileは先頭行
        if (mode === 'pretag') {
          editor.setPosition({ lineNumber: startLine + 1, column: 1 });
        } else {
          editor.setPosition({ lineNumber: startLine, column: open.length + 1 });
        }
      }
      editor.focus();
    }

    // ---- ハンドラ登録（すべて記法テーブル経由） ----
    btns.bold.addEventListener('click', function () { applyWrap('bold'); });
    btns.italic.addEventListener('click', function () { applyWrap('italic'); });
    btns.underline.addEventListener('click', function () { applyWrap('underline'); });
    btns.strike.addEventListener('click', function () { applyWrap('strike'); });
    btns.codeInline.addEventListener('click', function () { applyWrap('codeInline'); });
    btns.h1.addEventListener('click', function () { applyLine('h1'); });
    btns.h2.addEventListener('click', function () { applyLine('h2'); });
    btns.h3.addEventListener('click', function () { applyLine('h3'); });
    btns.h4.addEventListener('click', function () { applyLine('h4'); });
    btns.ul.addEventListener('click', function () { applyLine('ul'); });
    btns.ol.addEventListener('click', function () { applyLine('ol'); });
    btns.blockquote.addEventListener('click', function () { applyLine('blockquote'); });
    btns.codeBlock.addEventListener('click', applyCodeBlock);
    setupTableGridPicker(btns.table, editor, textarea);
    setupTableBuilder(btns.tableBuilder, editor, textarea, wrapper);
    setupImagePicker(btns.image, editor, textarea);
    setupFileLinkPicker(btns.fileLink, editor, textarea);

    // マクロ / Wikiリンク挿入ボタン:
    // カーソル位置にトリガー文字（{{ または [[）を挿入し、すぐ補完を開く。
    // 補完プロバイダ側が {{ / [[ を検出して候補を出すので、ボタン1つで
    // 「トリガー入力 → 候補表示」までを一気に行える。
    function insertTriggerAndSuggest(openText) {
      var sel = editor.getSelection();
      // 選択範囲（無ければカーソル位置）へ openText を挿入する。
      editor.executeEdits('monaco-insert-trigger', [{
        range: sel,
        text: openText,
        forceMoveMarkers: true
      }]);
      editor.focus();
      // 挿入直後の位置で補完を起動。executeEdits 後にカーソルは
      // 挿入文字列の末尾へ移動しているので、そのまま triggerSuggest でよい。
      // 描画完了を待ってから起動すると確実。
      setTimeout(function () {
        editor.trigger('monaco-toolbar', 'editor.action.triggerSuggest', {});
      }, 0);
    }
    btns.macro.addEventListener('click', function () {
      insertTriggerAndSuggest('{{');
    });
    btns.wikiLink.addEventListener('click', function () {
      insertTriggerAndSuggest('[[');
    });

    // Ctrl+B / Ctrl+I のキーボードショートカット
    editor.addCommand(
      window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyB,
      function () { applyWrap('bold'); }
    );
    editor.addCommand(
      window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyI,
      function () { applyWrap('italic'); }
    );
  }
  // ============================================================
  // 表グリッド選択ピッカー
  // ============================================================
  // ボタンクリックでグリッドポップアップを表示。
  // セルにホバーすると選択範囲をハイライト＆サイズ表示。
  // クリックでその行×列のMarkdown表を挿入する。
  function setupTableGridPicker(btn, editor, textarea) {
    var MAX_ROWS = 8;
    var MAX_COLS = 8;
    var fmt = detectFormat(textarea);
    // 開閉はすべて共通コントローラに委譲する
    var pop = createPopupController(btn, { build: buildPopup });

    function buildPopup() {
      var el = document.createElement('div');
      el.className = 'monaco-table-picker';

      var grid = document.createElement('div');
      grid.className = 'monaco-table-grid';
      grid.style.gridTemplateColumns = 'repeat(' + MAX_COLS + ', 1fr)';

      var label = document.createElement('div');
      label.className = 'monaco-table-label';
      label.textContent = t('table_insert', 'Insert table');

      // セルを生成
      for (var r = 1; r <= MAX_ROWS; r++) {
        for (var c = 1; c <= MAX_COLS; c++) {
          var cell = document.createElement('div');
          cell.className = 'monaco-table-cell';
          cell.dataset.row = r;
          cell.dataset.col = c;
          grid.appendChild(cell);
        }
      }

      // ホバーでハイライト更新
      grid.addEventListener('mousemove', function (e) {
        var cell = e.target.closest('.monaco-table-cell');
        if (!cell) { return; }
        var hoverRow = parseInt(cell.dataset.row, 10);
        var hoverCol = parseInt(cell.dataset.col, 10);
        updateHighlight(hoverRow, hoverCol);
        label.textContent = hoverRow + ' × ' + hoverCol;
      });

      grid.addEventListener('mouseleave', function () {
        updateHighlight(0, 0);
        label.textContent = t('table_insert', 'Insert table');
      });

      // クリックで確定
      grid.addEventListener('click', function (e) {
        var cell = e.target.closest('.monaco-table-cell');
        if (!cell) { return; }
        var rows = parseInt(cell.dataset.row, 10);
        var cols = parseInt(cell.dataset.col, 10);
        pop.close();
        insertTable(rows, cols);
      });

      function updateHighlight(maxRow, maxCol) {
        var cells = grid.querySelectorAll('.monaco-table-cell');
        cells.forEach(function (c) {
          var r = parseInt(c.dataset.row, 10);
          var col = parseInt(c.dataset.col, 10);
          if (r <= maxRow && col <= maxCol) {
            c.classList.add('selected');
          } else {
            c.classList.remove('selected');
          }
        });
      }

      el.appendChild(label);
      el.appendChild(grid);
      return el;
    }

    // 表を挿入（フォーマットにより記法が異なる）
    //   markdown: | 列1 | 列2 |   ＋ 区切り行 | --- | --- |
    //   textile : |_. 列1 |_. 列2 |（ヘッダ行は _. 修飾、区切り行なし）
    function insertTable(rows, cols) {
      var lines = [];
      var c;

      if (fmt === 'textile') {
        // ヘッダ行（|_. で各セルを見出し化）
        var theader = '|';
        for (c = 1; c <= cols; c++) { theader += '_. ' + t('table_col_prefix', 'Col') + c + ' |'; }
        lines.push(theader);
        // データ行（区切り行は不要）
        for (var tr = 1; tr <= rows; tr++) {
          var trow = '|';
          for (c = 1; c <= cols; c++) { trow += '     |'; }
          lines.push(trow);
        }
      } else {
        // Markdown: ヘッダ + 区切り + データ
        var header = '|';
        for (c = 1; c <= cols; c++) { header += ' ' + t('table_col_prefix', 'Col') + c + ' |'; }
        lines.push(header);

        var sep = '|';
        for (c = 1; c <= cols; c++) { sep += ' --- |'; }
        lines.push(sep);

        for (var r = 1; r <= rows; r++) {
          var row = '|';
          for (c = 1; c <= cols; c++) { row += '     |'; }
          lines.push(row);
        }
      }

      var tableText = '\n' + lines.join('\n') + '\n';

      var sel = editor.getSelection();
      var model = editor.getModel();
      if (!sel || !model) { return; }

      editor.executeEdits('insert-table', [{
        range: sel,
        text: tableText,
        forceMoveMarkers: true
      }]);

      // ヘッダ行付近にカーソルを移動
      var insertLine = sel.startLineNumber + 1;
      editor.setPosition({ lineNumber: insertLine, column: 3 });
      editor.focus();
    }

    btn.addEventListener('click', pop.toggle);
  }

  // ============================================================
  // 表ビルダー（Table Builder）
  // ============================================================
  // ツールバーの「表ビルダー」ボタン押下で、エディタ wrapper 上に
  // Excelライクな表編集パネルをオーバーレイ表示する。
  //
  //   - 本体は public_dist/table-builder/index.js（ESM）。初回押下時に
  //     動的 import で遅延ロードする（編集画面を開いただけでは読み込まない）。
  //   - パネル/タブ管理・表データの保持はすべてモジュール側が担う。本体は
  //     「開く」入口と「エディタへ挿入する」コールバックだけを提供する。
  //   - 「本文」タブで編集画面へ戻り、再度ボタンを押すと最後に開いていた
  //     表タブが復元される（モジュール側 open() のロジック）。
  // ============================================================
  // 表ビルダーの操作結果を画面右下に短時間表示する軽量トースト。
  // コピー完了など、モーダルにするほどでない通知に使う。
  var _tbToastTimer = null;
  function showTableBuilderToast(message) {
    var el = document.getElementById('mte-tb-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mte-tb-toast';
      el.className = 'mte-tb-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('mte-tb-toast-show');
    if (_tbToastTimer) { clearTimeout(_tbToastTimer); }
    _tbToastTimer = setTimeout(function () {
      el.classList.remove('mte-tb-toast-show');
    }, 2600);
  }

  function setupTableBuilder(btn, editor, textarea, wrapper) {
    var fmt = detectFormat(textarea);
    var apiPromise = null; // initTableBuilder の戻り値（{ open, showBody, destroy, openForText }）

    // 表テキストをクリップボードへコピーする。挿入だと出力先が分かりづらい
    // ため、コピーにしてユーザーが本文の好きな位置へ貼れるようにする。
    // navigator.clipboard を第一に、使えない環境では execCommand にフォールバック。
    function copyToClipboard(text) {
      function done() {
        showTableBuilderToast(t('tb_copied', '表をコピーしました。本文の貼り付けたい位置で Ctrl+V してください。'));
      }
      function fallback() {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          done();
        } catch (e) {
          if (window.console) { console.error('[monaco_editor] clipboard copy failed:', e); }
          window.alert(t('tb_copy_failed', 'コピーに失敗しました。表を範囲選択して手動でコピーしてください。'));
        }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
      } else {
        fallback();
      }
    }

    // モジュールを遅延ロードして API を初期化する（初回のみ）。
    function ensureApi() {
      if (apiPromise) { return apiPromise; }
      // getMonacoBase() は '/monaco_assets/vs' を返すので、その親が
      // アセットのルート。表ビルダーは /monaco_assets/textgrid/src/ に置く。
      var assetRoot = getMonacoBase().replace(/\/vs$/, '');
      var moduleUrl = assetRoot + '/textgrid/src/index.js';
      apiPromise = import(moduleUrl).then(function (mod) {
        return mod.initTableBuilder({
          wrapper: wrapper,
          format: fmt,
          t: t,
          copy: copyToClipboard,
          // 本文タブ/挿入で編集画面へ戻すとき、エディタの再レイアウトを促す。
          showEditor: function () {
            setTimeout(function () { editor.layout(); editor.focus(); }, 0);
          }
        });
      }).catch(function (err) {
        // 読み込み失敗時はボタンを無効化せず、コンソールに出すだけに留める
        // （他のツールバー機能は生かす）。
        apiPromise = null;
        if (window.console) { console.error('[monaco_editor] table-builder load failed:', err); }
        throw err;
      });
      return apiPromise;
    }

    // ツールバーボタン: 新規の表ビルダーを開く（従来どおり）。
    if (btn) {
      btn.addEventListener('click', function () {
        ensureApi().then(function (api) { api.open(); }).catch(function () { /* ログ済み */ });
      });
    }

    // ============================================================
    // 既存表の glyph アイコン → クリックで表ビルダー（バインド）で開く
    // ============================================================
    setupExistingTableGlyphs(editor, textarea, fmt, ensureApi);
  }


  // ============================================================
  // このtextareaが「変更履歴(diff)データの持ち主」かどうかを判定する
  // ============================================================
  // 変更履歴ドロップダウン(時計マーク)とBlameヒントは、過去履歴を持つ
  // 説明欄だけの機能。ページ内の全textareaがMonaco化されるため、
  // コメント欄(#issue_notes)等の他エディタにも window.MONACO_EDITOR_DIFF
  // が見えてしまい、放置すると無関係なエディタに説明欄の履歴が出る。
  //
  // 「どのDOM要素がこのdiffの持ち主か」はサーバ側(DescriptionHistory)が
  // owner_selector として宣言する。フロントはそれに一致するtextareaに
  // だけ機能を許可する。JS側に説明欄判定をハードコードしないことで、
  // 将来の対象拡張をサーバ側1箇所の変更で済ませられる。
  //
  // owner_selector が無い古いデータ形式のときは、後方互換として
  // 標準の説明欄id(#issue_description)にフォールバックする。
  function isDiffOwner(textarea) {
    if (!textarea || typeof textarea.matches !== 'function') { return false; }
    var DIFF = (typeof window !== 'undefined' && window.MONACO_EDITOR_DIFF) || null;
    var selector = (DIFF && DIFF.owner_selector) || '#issue_description';
    try {
      return textarea.matches(selector);
    } catch (e) {
      // 不正なセレクタ等で matches が例外を投げた場合は安全側(=対象外)に倒す。
      return false;
    }
  }

  // ============================================================
  // 変更履歴ドロップダウン（Phase 2: UI のみ、Phase 3 で diff モード起動を実装）
  // ============================================================
  // 押すとボタンの下に「過去版同士の差分」を選べるドロップダウンが出る。
  // 各項目は #N → #M (次の版) / #N → 現在 のペア形式で並ぶ。
  //
  // データソース: window.MONACO_EDITOR_DIFF (Ruby側 view hook で埋め込み済み)。
  // データが無い or 履歴ゼロ or このエディタが持ち主でないときはボタンを隠す。
  //
  // Phase 2 ではユーザーが項目を選んだら console.log するだけ。
  // Phase 3 でここを「diff モード起動」に差し替える。
  function setupHistoryDropdown(btn, editor, textarea) {
    var DIFF = (typeof window !== 'undefined' && window.MONACO_EDITOR_DIFF) || null;

    // 説明欄(diffの持ち主)以外のエディタでは、時計マーク自体を出さない。
    // コメント欄などはここで弾かれる。
    if (!isDiffOwner(textarea)) {
      btn.style.display = 'none';
      return;
    }

    // データが無い・履歴が空のときはボタン自体を非表示
    if (!DIFF || !DIFF.versions || DIFF.versions.length === 0) {
      btn.style.display = 'none';
      return;
    }

    var I = (typeof window !== 'undefined' && window.MONACO_EDITOR_I18N) || {};
    function t(k, fallback) { return (I[k] != null && I[k] !== '') ? I[k] : fallback; }

    // ドロップダウン要素を作る(初回のみ・以後 toggle)
    var menu = null;
    var menuOpen = false;

    function buildMenu() {
      var m = document.createElement('div');
      m.className = 'monaco-history-menu';
      m.setAttribute('role', 'menu');

      var header = document.createElement('div');
      header.className = 'monaco-history-menu-header';
      header.textContent = t('history_dropdown_title', 'Select a diff to compare');
      m.appendChild(header);

      // truncated 注記
      if (DIFF.truncated) {
        var trunc = document.createElement('div');
        trunc.className = 'monaco-history-menu-trunc';
        trunc.textContent = t('history_truncated_note', 'Older entries are omitted');
        m.appendChild(trunc);
      }

      // 各 version に対し、「#N → 次の版」と「#N → 現在」の2項目を並べる。
      // 最後の version は「次の版」が無い(直後 = current)ので「→ 現在」のみ。
      var versions = DIFF.versions;
      for (var i = 0; i < versions.length; i++) {
        var v = versions[i];
        var labelLeft = formatVersionLabel(v);

        if (i < versions.length - 1) {
          var next = versions[i + 1];
          appendItem(m,
            labelLeft + '  →  ' + formatVersionLabel(next) + ' (' + t('history_to_next', 'next version') + ')',
            { from: v, to: next });
        }
        appendItem(m,
          labelLeft + '  →  ' + t('history_to_current', 'current'),
          { from: v, to: null /* null = current */ });
      }
      return m;
    }

    function formatVersionLabel(v) {
      if (!v) return t('history_to_current', 'current');
      var idxLabel;
      if (v.index === 0) {
        idxLabel = t('history_creation', 'Creation');
      } else {
        idxLabel = '#' + v.index;
      }
      var author = v.author ? v.author : '';
      var date = formatDate(v.created_on);
      // "#N  著者  日付" のスペース区切り
      return [idxLabel, author, date].filter(function (s) { return s && s.length > 0; }).join('  ');
    }

    function formatDate(iso) {
      if (!iso) return '';
      try {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        var y = d.getFullYear();
        var mo = ('0' + (d.getMonth() + 1)).slice(-2);
        var da = ('0' + d.getDate()).slice(-2);
        var h = ('0' + d.getHours()).slice(-2);
        var mi = ('0' + d.getMinutes()).slice(-2);
        return y + '/' + mo + '/' + da + ' ' + h + ':' + mi;
      } catch (e) { return ''; }
    }

    function appendItem(parent, label, payload) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'monaco-history-menu-item';
      item.setAttribute('role', 'menuitem');
      item.textContent = label;
      item.addEventListener('mousedown', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
      });
      item.addEventListener('click', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        closeMenu();
        // diff モードを開く。
        //   payload.from: 選んだ "変更前" の版オブジェクト(versions[i])
        //   payload.to:   "変更後"。null なら現在の保存版を使う。
        var fromText = payload.from ? payload.from.text : '';
        var toText, toLabel;
        if (payload.to === null) {
          toText = DIFF.current || '';
          toLabel = formatCurrentLabel();
        } else {
          toText = payload.to.text || '';
          toLabel = formatVersionLabel(payload.to);
        }
        var fromLabel = formatVersionLabel(payload.from);
        if (typeof editor.__mteOpenDiff === 'function') {
          editor.__mteOpenDiff({
            fromText: fromText,
            toText: toText,
            fromLabel: fromLabel,
            toLabel: toLabel
          });
        }
      });
      parent.appendChild(item);
    }

    function formatCurrentLabel() {
      var meta = DIFF.current_meta || {};
      var date = formatDate(meta.created_on);
      var author = meta.author || '';
      var idxLabel = t('history_to_current', 'current');
      return [idxLabel, author, date].filter(function (s) { return s && s.length > 0; }).join('  ');
    }

    function openMenu() {
      if (!menu) menu = buildMenu();
      // ボタンの直下に配置するため、ボタンの親(モードバー)の末尾に挿入し、
      // CSS で position: absolute で位置決めする(親が position: relative)。
      var host = btn.parentNode;
      if (!host) return;
      if (!host.contains(menu)) host.appendChild(menu);

      // ボタンの位置を基準にメニュー位置を決める
      var btnRect = btn.getBoundingClientRect();
      var hostRect = host.getBoundingClientRect();
      menu.style.left = (btnRect.left - hostRect.left) + 'px';
      menu.style.top  = (btnRect.bottom - hostRect.top + 4) + 'px';
      menu.style.display = 'block';

      menuOpen = true;
      btn.setAttribute('aria-expanded', 'true');
      btn.classList.add('active');

      // 外側クリックで閉じる
      setTimeout(function () {
        document.addEventListener('mousedown', onDocMouseDown, true);
        document.addEventListener('keydown', onDocKeyDown, true);
      }, 0);
    }

    function closeMenu() {
      if (!menuOpen) return;
      menuOpen = false;
      if (menu) menu.style.display = 'none';
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('active');
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onDocKeyDown, true);
    }

    function onDocMouseDown(ev) {
      if (!menu) return closeMenu();
      if (menu.contains(ev.target) || btn.contains(ev.target)) return;
      closeMenu();
    }
    function onDocKeyDown(ev) {
      if (ev.key === 'Escape') closeMenu();
    }

    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      ev.preventDefault();
      if (menuOpen) closeMenu();
      else openMenu();
    });
  }

  // ============================================================
  // 行末 Blame ヒント (VS Code の Git blame "うっすら表示" 相当)
  // ============================================================
  // カーソルがある行の末尾に「著者・相対日付・#注記番号」を薄く出す。
  // 「行の作者」は VS Code Git blame と同じく「その行が最初に登場した
  // 時点の著者」と定義する(=その行を最初に書いた人)。同じ文字列の行は
  // 同じ行とみなす(シンプル)。
  //
  // データソース: window.MONACO_EDITOR_DIFF (versions[古い順] + current)。
  // 履歴が無いときは何もしない。
  //
  // 描画: Monaco の inline decoration の `after` プロパティで行末に
  // 擬似テキストを足す。専用 CSS クラスで薄い色 + イタリック。
  //
  // 編集中の追従: マップのキーは「行文字列」なので、編集で行内容が
  // 変わったら自動的に別の(あるいは無い)エントリを引くだけ。
  // 編集で新しく書いた行は map に無い → 何も出さない(VS Code 流)。
  function setupBlameHint(editor, textarea) {
    var monaco = window.monaco;
    if (!monaco) return;
    // Blameヒントも過去履歴由来の機能。説明欄(diffの持ち主)以外では出さない。
    if (!isDiffOwner(textarea)) return;
    var DIFF = (typeof window !== 'undefined' && window.MONACO_EDITOR_DIFF) || null;
    if (!DIFF || !DIFF.versions || DIFF.versions.length === 0) return;

    // 行文字列 → 最古登場メタ情報 のマップを構築。
    // 入力: versions[古い順] + current。古い順に流して、初出のときだけ
    // セットするので、後から同じ文字列が出ても上書きされない(=最古優先)。
    function buildOldestLineMap() {
      var map = new Map();
      var pushVersion = function (text, meta) {
        if (!text || !meta) return;
        var lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        for (var i = 0; i < lines.length; i++) {
          var ln = lines[i];
          if (!map.has(ln)) map.set(ln, meta);
        }
      };
      DIFF.versions.forEach(function (v) {
        pushVersion(v.text, {
          author: v.author || '',
          created_on: v.created_on || null,
          index: v.index,
          journal_id: v.journal_id
        });
      });
      // current は最後。current にしか無い行(=最新版で初登場)は
      // current_meta(最終更新者)に紐づく。
      if (DIFF.current_meta) {
        pushVersion(DIFF.current, {
          author: DIFF.current_meta.author || '',
          created_on: DIFF.current_meta.created_on || null,
          index: DIFF.current_meta.index,
          journal_id: DIFF.current_meta.journal_id
        });
      }
      return map;
    }

    var oldestMap = buildOldestLineMap();

    // ----------------------------------------------------------
    // Content Widget による描画
    // ----------------------------------------------------------
    // Monaco の公式 API である Content Widget を使う。装飾の after を
    // 動的 CSS で書き換える方式に比べて、DOM が綺麗・複数エディタが
    // 衝突しない・テキストエスケープが不要、という利点がある。
    var widgetDom = document.createElement('div');
    widgetDom.className = 'mte-blame-hint';
    var widgetId = 'mte-blame-hint-' + Math.random().toString(36).slice(2, 10);
    var widget = {
      getId: function () { return widgetId; },
      getDomNode: function () { return widgetDom; },
      // 位置はカーソル行の末尾。preference は EXACT を第一候補にすることで
      // 「指定行・指定列のすぐ後ろ」に出る(Monaco 内座標)。
      // 行末より右に出すため、column は lineMaxColumn を使う(行内コンテンツの直後)。
      _position: null,
      getPosition: function () {
        if (!this._position) return null;
        return {
          position: this._position,
          preference: [
            monaco.editor.ContentWidgetPositionPreference.EXACT
          ]
        };
      }
    };
    var widgetAttached = false;

    function attachWidget() {
      if (widgetAttached) return;
      editor.addContentWidget(widget);
      widgetAttached = true;
    }
    function detachWidget() {
      if (!widgetAttached) return;
      editor.removeContentWidget(widget);
      widgetAttached = false;
    }
    function clearWidget() {
      widgetDom.textContent = '';
      widget._position = null;
      detachWidget();
    }

    function renderForCursor() {
      var pos = editor.getPosition();
      if (!pos) { clearWidget(); return; }
      var model = editor.getModel();
      if (!model) { clearWidget(); return; }
      var ln = pos.lineNumber;
      if (ln < 1 || ln > model.getLineCount()) { clearWidget(); return; }
      var lineText = model.getLineContent(ln);
      // 空行は出さない(うるさいので)
      if (lineText === '') { clearWidget(); return; }
      var meta = oldestMap.get(lineText);
      if (!meta) { clearWidget(); return; }

      var label = formatBlameLabel(meta);
      if (!label) { clearWidget(); return; }

      // エディタの実 lineHeight に合わせて widget の line-height を動的に
      // セットする。フォントサイズ変更にも追従する。
      // Content Widget は行下端基準で配置されるため、行高に合わせて中央
      // 寄せにすることで「カーソル行の中央」に文字が来る。
      var lh = editor.getOption(monaco.editor.EditorOption.lineHeight) || 19;
      widgetDom.style.lineHeight = lh + 'px';
      widgetDom.style.height = lh + 'px';

      // Content Widget にラベルを書いてカーソル行の末尾に表示
      widgetDom.textContent = label;
      widget._position = { lineNumber: ln, column: model.getLineMaxColumn(ln) };
      attachWidget();
      // 既に attach 済みでも位置情報を反映するため layoutContentWidget を呼ぶ
      editor.layoutContentWidget(widget);
    }

    function formatBlameLabel(meta) {
      var parts = [];
      if (meta.author) parts.push(meta.author);
      var rel = formatRelative(meta.created_on);
      if (rel) parts.push(rel);
      if (meta.index != null) {
        if (meta.index === 0) {
          parts.push(blameT('history_creation', 'Creation'));
        } else {
          parts.push('#' + meta.index);
        }
      }
      return parts.join(' \u00B7 '); // ' ・ '
    }

    function blameT(k, fallback) {
      var I = (typeof window !== 'undefined' && window.MONACO_EDITOR_I18N) || {};
      return (I[k] != null && I[k] !== '') ? I[k] : fallback;
    }

    function formatRelative(iso) {
      if (!iso) return '';
      var d;
      try { d = new Date(iso); } catch (e) { return ''; }
      if (!d || isNaN(d.getTime())) return '';
      var now = Date.now();
      var diffSec = Math.max(0, Math.floor((now - d.getTime()) / 1000));
      if (diffSec < 60)   return blameT('rel_just_now', 'just now');
      var diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60)   return diffMin + ' ' + blameT('rel_minutes_ago', 'minutes ago');
      var diffHour = Math.floor(diffMin / 60);
      if (diffHour < 24)  return diffHour + ' ' + blameT('rel_hours_ago', 'hours ago');
      var diffDay = Math.floor(diffHour / 24);
      if (diffDay < 30)   return diffDay + ' ' + blameT('rel_days_ago', 'days ago');
      var diffMonth = Math.floor(diffDay / 30);
      if (diffMonth < 12) return diffMonth + ' ' + blameT('rel_months_ago', 'months ago');
      var diffYear = Math.floor(diffMonth / 12);
      return diffYear + ' ' + blameT('rel_years_ago', 'years ago');
    }

    // ----------------------------------------------------------
    // ホバーツールチップ
    // ----------------------------------------------------------
    // widgetDom にマウスホバー1秒以上で、もう少し詳しいカードを表示。
    //   - 著者名
    //   - 相対日付 + 絶対日付
    //   - #注記番号
    //   - その journal で +N行 / -M行 の要約
    //   - 「差分を見る」ボタン (クリックで diff モードへ)
    var tooltipDom = document.createElement('div');
    tooltipDom.className = 'mte-blame-tooltip';
    tooltipDom.style.display = 'none';

    // Blame ツールチップは Monaco の Content Widget として登録する。
    // body 直下に置くとネイティブ Fullscreen API の制約で全画面中に
    // 描画されない問題があるため、Monaco の overflow-widgets-root を
    // 経由して描画させる(@メンション や #xxx と同じ作法)。
    // fixedOverflowWidgets: true により wrapper 内に出るので、
    // フルスクリーン中も追従して表示される。
    var tooltipWidgetId = 'mte-blame-tooltip-' + Math.random().toString(36).slice(2, 10);
    var tooltipWidget = {
      getId: function () { return tooltipWidgetId; },
      getDomNode: function () { return tooltipDom; },
      _position: null,
      getPosition: function () {
        if (!this._position) return null;
        return {
          position: this._position,
          preference: [
            monaco.editor.ContentWidgetPositionPreference.ABOVE,
            monaco.editor.ContentWidgetPositionPreference.BELOW
          ]
        };
      },
      // 補完候補等と一緒に overflow-widgets-root へ出すよう要求
      allowEditorOverflow: true
    };
    var tooltipAttached = false;
    function attachTooltip() {
      if (tooltipAttached) return;
      editor.addContentWidget(tooltipWidget);
      tooltipAttached = true;
    }
    function detachTooltip() {
      if (!tooltipAttached) return;
      editor.removeContentWidget(tooltipWidget);
      tooltipAttached = false;
    }

    widgetDom.style.pointerEvents = 'auto';

    var hoverTimer = null;
    var hideTimer = null;
    var currentMetaForTip = null; // ツールチップ表示中のメタ情報

    function scheduleShow(meta) {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () {
        showTooltip(meta);
      }, 1000);
    }
    function cancelShow() {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    }
    function scheduleHide() {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        tooltipDom.style.display = 'none';
        detachTooltip();
        currentMetaForTip = null;
      }, 200);
    }
    function cancelHide() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    }

    function showTooltip(meta) {
      // 差分要約が無い or 変更行数 0 のときはツールチップ自体を出さない。
      // (creation / 説明欄を触ってない journal の場合がこれに該当)
      var summary = computeJournalSummary(meta);
      if (!summary || (summary.added === 0 && summary.removed === 0)) {
        return;
      }

      currentMetaForTip = meta;
      tooltipDom.innerHTML = ''; // クリア(textContent で safe な要素を組み立てる)

      // 1段目: 著者名 + 相対日付 + 絶対日付 + #注記番号
      var headerRow = document.createElement('div');
      headerRow.className = 'mte-blame-tooltip-header';

      var authorSpan = document.createElement('span');
      authorSpan.className = 'mte-blame-tooltip-author';
      authorSpan.textContent = meta.author || '';
      headerRow.appendChild(authorSpan);

      var dateSpan = document.createElement('span');
      dateSpan.className = 'mte-blame-tooltip-date';
      var rel = formatRelative(meta.created_on);
      var abs = formatAbsolute(meta.created_on);
      dateSpan.textContent = (rel ? rel : '') + (abs ? '  (' + abs + ')' : '');
      headerRow.appendChild(dateSpan);

      var noteSpan = document.createElement('span');
      noteSpan.className = 'mte-blame-tooltip-note';
      noteSpan.textContent = (meta.index === 0)
        ? blameT('history_creation', 'Creation')
        : ('#' + meta.index);
      headerRow.appendChild(noteSpan);

      tooltipDom.appendChild(headerRow);

      // 2段目: その journal の説明欄変更要約 (+N行 / -M行)
      var sumRow = document.createElement('div');
      sumRow.className = 'mte-blame-tooltip-summary';
      if (summary.added > 0) {
        var addSpan = document.createElement('span');
        addSpan.className = 'mte-blame-tooltip-added';
        addSpan.textContent = '+' + summary.added + blameT('lines_suffix', '');
        sumRow.appendChild(addSpan);
      }
      if (summary.removed > 0) {
        var delSpan = document.createElement('span');
        delSpan.className = 'mte-blame-tooltip-removed';
        delSpan.textContent = '-' + summary.removed + blameT('lines_suffix', '');
        sumRow.appendChild(delSpan);
      }
      tooltipDom.appendChild(sumRow);

      // 3段目: diff モードへジャンプするボタン
      var actionRow = document.createElement('div');
      actionRow.className = 'mte-blame-tooltip-actions';
      var jumpBtn = document.createElement('button');
      jumpBtn.type = 'button';
      jumpBtn.className = 'mte-blame-tooltip-jump';
      jumpBtn.textContent = blameT('show_diff', 'Show diff');
      jumpBtn.addEventListener('mousedown', function (ev) {
        ev.stopPropagation(); ev.preventDefault();
        jumpToDiff(meta);
      });
      jumpBtn.addEventListener('click', function (ev) {
        ev.stopPropagation(); ev.preventDefault();
      });
      actionRow.appendChild(jumpBtn);
      tooltipDom.appendChild(actionRow);

      // 位置決め: Monaco Content Widget としてカーソル行末に attach
      // (allowEditorOverflow=true で overflow-widgets-root 配下に出る
      //  ためフルスクリーンでも追従して描画される)
      // テーマクラスを動的付与: tooltipDom は overflow-widgets-root 配下に
      // 出るため、Monaco の vs-dark クラスが効くが、念のため自前クラスも付ける。
      var themeOpt = '';
      try {
        themeOpt = (editor.getRawOptions && editor.getRawOptions().theme) || '';
      } catch (e) {}
      tooltipDom.classList.remove('mte-blame-tooltip--dark');
      if (/dark|night/i.test(themeOpt)) {
        tooltipDom.classList.add('mte-blame-tooltip--dark');
      }

      // カーソル行の末尾を基準位置にする
      var pos = editor.getPosition();
      if (!pos) return;
      var model2 = editor.getModel();
      if (!model2) return;
      tooltipWidget._position = {
        lineNumber: pos.lineNumber,
        column: model2.getLineMaxColumn(pos.lineNumber)
      };
      tooltipDom.style.display = 'block';
      attachTooltip();
      // 位置の再計算をリクエスト
      editor.layoutContentWidget(tooltipWidget);
    }

    function formatAbsolute(iso) {
      if (!iso) return '';
      try {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        var y = d.getFullYear();
        var mo = ('0' + (d.getMonth() + 1)).slice(-2);
        var da = ('0' + d.getDate()).slice(-2);
        var h = ('0' + d.getHours()).slice(-2);
        var mi = ('0' + d.getMinutes()).slice(-2);
        return y + '/' + mo + '/' + da + ' ' + h + ':' + mi;
      } catch (e) { return ''; }
    }

    // その journal で説明欄に対して +N行 / -M行 の変更があったかを
    // 自前 git Myers で計算する。journal_id を versions 配列の位置に
    // マッピングして「直前の text → その時点の text」を diff する。
    function computeJournalSummary(meta) {
      if (!DIFF || !DIFF.versions) return null;
      var versions = DIFF.versions;
      // 版を一意に引くキーは meta.index を使う。
      //   - チケット説明欄: index=注記番号(creation は 0)
      //   - Wikiページ本文: index=version番号(1始まり、0は無い)
      // 以前は journal_id をキーにしていたが、Wiki には journal が無く
      // journal_id が常に null になるため、null 同士が誤って最古版に
      // マッチして要約が出せなくなる不具合があった。index は両方で
      // 版ごとにユニークなため、共通キーとして安全に使える。
      var foundIdx = -1;
      var isCurrent = false;
      if (DIFF.current_meta && DIFF.current_meta.index != null
        && meta.index === DIFF.current_meta.index) {
        isCurrent = true;
      } else {
        for (var i = 0; i < versions.length; i++) {
          if (versions[i].index === meta.index) { foundIdx = i; break; }
        }
        // creation(index=0) の場合は直前の版が無いため要約は出せない。
        // (チケット説明欄のみ。Wiki に index=0 は存在しない)
        if (foundIdx === -1 && meta.index === 0) {
          return null;
        }
      }

      var beforeText, afterText;
      if (isCurrent) {
        if (versions.length === 0) return null;
        beforeText = versions[versions.length - 1].text || '';
        afterText = DIFF.current || '';
      } else {
        if (foundIdx === -1) return null;
        // versions[foundIdx] = この版自体。
        // ただし「この版で何が変わったか」を見たいので、
        // 「直前の版」と「この版」を diff する。
        var prevText;
        if (foundIdx === 0) {
          // 最古版。直前の版が無いので要約は省略する。
          //   - チケット: 最古版=creation の手前は無い
          //   - Wiki: 最古版=version 1 の手前は無い
          return null;
        }
        prevText = versions[foundIdx - 1].text || '';
        beforeText = prevText;
        afterText = versions[foundIdx].text || '';
      }

      // 自前 Myers + compact で diff、+N/-M を集計
      try {
        var a = gitDiffNormLines(beforeText);
        var b = gitDiffNormLines(afterText);
        var ops = gitMyersDiff(a, b);
        ops = gitChangeCompact(a, b, ops);
        var added = 0, removed = 0;
        ops.forEach(function (op) {
          if (op.op === 'ins') added++;
          else if (op.op === 'del') removed++;
        });
        return { added: added, removed: removed, beforeText: beforeText, afterText: afterText };
      } catch (e) {
        return null;
      }
    }

    function jumpToDiff(meta) {
      var summary = computeJournalSummary(meta);
      if (!summary) return;
      if (typeof editor.__mteOpenDiff === 'function') {
        var fromLabel, toLabel;
        // 版照合は index で行う(computeJournalSummary と同じ理由。
        // Wiki は journal_id が常に null のため index を共通キーにする)。
        if (DIFF.current_meta && DIFF.current_meta.index != null
          && meta.index === DIFF.current_meta.index) {
          // current。手前 = versions の最後
          if (DIFF.versions.length === 0) return;
          var prevV = DIFF.versions[DIFF.versions.length - 1];
          fromLabel = formatVersionLabelShort(prevV);
          toLabel = blameT('history_to_current', 'current');
        } else {
          var foundIdx = -1;
          for (var i = 0; i < DIFF.versions.length; i++) {
            if (DIFF.versions[i].index === meta.index) { foundIdx = i; break; }
          }
          if (foundIdx <= 0) return;
          fromLabel = formatVersionLabelShort(DIFF.versions[foundIdx - 1]);
          toLabel = formatVersionLabelShort(DIFF.versions[foundIdx]);
        }
        editor.__mteOpenDiff({
          fromText: summary.beforeText,
          toText: summary.afterText,
          fromLabel: fromLabel,
          toLabel: toLabel
        });
      }
      // ツールチップは閉じる
      tooltipDom.style.display = 'none';
      detachTooltip();
      currentMetaForTip = null;
    }

    function formatVersionLabelShort(v) {
      if (!v) return '';
      var idx = (v.index === 0) ? blameT('history_creation', 'Creation') : ('#' + v.index);
      var parts = [idx];
      if (v.author) parts.push(v.author);
      var rel = formatRelative(v.created_on);
      if (rel) parts.push(rel);
      return parts.join(' \u00B7 ');
    }

    // widget へのホバー/離脱
    widgetDom.addEventListener('mouseenter', function () {
      cancelHide();
      // 現在の meta は renderForCursor で最後にセットされたもの
      // ここで取り直す必要がある→ lastMeta を保持しておく
      if (lastRenderedMeta) scheduleShow(lastRenderedMeta);
    });
    widgetDom.addEventListener('mouseleave', function () {
      cancelShow();
      scheduleHide();
    });
    // ツールチップ自体へのホバー/離脱(入ってる間は開いたまま)
    tooltipDom.addEventListener('mouseenter', function () {
      cancelHide();
    });
    tooltipDom.addEventListener('mouseleave', function () {
      scheduleHide();
    });

    // renderForCursor が最後に使った meta を保持
    var lastRenderedMeta = null;
    var origRender = renderForCursor;
    renderForCursor = function () {
      origRender();
      // 描画完了後の meta を取り直す: pos の行が変わってるかも
      var pos = editor.getPosition();
      if (!pos) { lastRenderedMeta = null; return; }
      var model = editor.getModel();
      if (!model) { lastRenderedMeta = null; return; }
      var ln = pos.lineNumber;
      if (ln < 1 || ln > model.getLineCount()) { lastRenderedMeta = null; return; }
      var lineText = model.getLineContent(ln);
      lastRenderedMeta = lineText ? (oldestMap.get(lineText) || null) : null;
      // カーソル行が変わったらツールチップは閉じる(別行の情報を出してしまうため)
      if (currentMetaForTip && lastRenderedMeta !== currentMetaForTip) {
        tooltipDom.style.display = 'none';
        detachTooltip();
        currentMetaForTip = null;
        cancelShow();
      }
    };

    editor.onDidChangeCursorPosition(function () { renderForCursor(); });
    editor.onDidChangeModelContent(function () { renderForCursor(); });
    renderForCursor();
  }

  // ============================================================
  // 編集差分マーカー（gutter）
  // ============================================================
  // 要件:
  //   - エディタを開いた瞬間の本文(textarea.value)を「基準(base)」として固定保持。
  //   - 編集するたびに base ↔ 現在値 を diff し、行装飾マージン(gutter)に出す:
  //       追加行   → 緑の縦線
  //       変更行   → 青の縦線
  //       削除位置 → 赤い三角（行間）
  //   - 開いた直後は base===現在なので何も出ない。
  //   - サーバ側のデータは一切使わない（フロントだけで完結）。
  //
  // diff エンジン:
  //   自前の git 互換 Myers 実装(gitMyersDiff)。VS Code の Git gutter は内部で
  //   git diff の結果を見ているため、Monaco 内蔵の diff エンジン（linesDiff-
  //   Computers）ではなく git と同じ Myers アルゴリズムで計算する。
  //   後段でハンクを gutter 表示用 {lineClass, deletedAt} に変換する。
  function setupChangeDiff(editor, textarea) {
    var monaco = window.monaco;
    if (!monaco) { return; }

    var model = editor.getModel();
    if (!model) { return; }

    // 基準テキスト = 開いた瞬間の本文（編集前）。以後は固定。
    var baseText = (textarea && typeof textarea.value === 'string')
      ? textarea.value
      : editor.getValue();

    // 装飾コレクション（既存表glyphと同じ作法で両対応）。
    var collection = null;
    var decoIds = [];
    if (typeof editor.createDecorationsCollection === 'function') {
      collection = editor.createDecorationsCollection([]);
    }
    function setDecos(decos) {
      if (collection) { collection.set(decos); }
      else { decoIds = editor.deltaDecorations(decoIds, decos); }
    }

    // 直近の diff 結果(ハンク含む)を保持。クリック時に該当ハンクを特定するため。
    var currentHunks = [];
    var currentLineClass = {};
    var currentDeletedAt = new Set();

    function render() {
      var curr = editor.getValue();
      var lineCount = model.getLineCount();
      var d = gitDiffForGutter(baseText, curr);
      currentHunks = d.hunks || [];
      currentLineClass = d.lineClass;
      currentDeletedAt = d.deletedAt;

      var decos = [];

      Object.keys(d.lineClass).forEach(function (lnStr) {
        var ln = parseInt(lnStr, 10);
        if (ln < 1 || ln > lineCount) { return; }
        var kind = d.lineClass[lnStr];
        var cls = (kind === 'added') ? 'mte-diff-added'
                : (kind === 'modified') ? 'mte-diff-modified'
                : null;
        if (!cls) { return; }
        decos.push({
          range: new monaco.Range(ln, 1, ln, 1),
          options: { isWholeLine: true, linesDecorationsClassName: cls }
        });
      });

      d.deletedAt.forEach(function (ln) {
        if (ln < 1 || ln > lineCount) { return; }
        decos.push({
          range: new monaco.Range(ln, 1, ln, 1),
          options: { linesDecorationsClassName: 'mte-diff-removed' }
        });
      });

      setDecos(decos);

      // 本文が編集で変わったときは、開いてるパネルを閉じる（中身が古くなるため）
      closePeekPanel();
    }

    // 開いた直後は base===現在なので無色。以後は編集追従。
    render();
    editor.onDidChangeModelContent(function () { render(); });

    // ------------------------------------------------------------
    // gutter クリックで該当ハンクの「変更前」をパネル展開する (Peek 風UI)
    // ------------------------------------------------------------
    // VS Code の dirty diff gutter のように、色のついた装飾(緑/青の縦線、
    // 赤三角)をクリックすると、その変更箇所の上に「変更前テキスト」を
    // 並べた読み取り専用パネルが開く。同時に開けるパネルは1つだけ。
    //
    // 実装:
    //   - view zone でエディタ行間にスペースを確保
    //   - overlay widget でそのスペースに HTML を乗せる
    //     (view zone 単体だと内容を埋められないので overlay と組み合わせる)
    //   - クリック検知は editor.onMouseDown を使い、
    //     target.type === GUTTER_LINE_DECORATIONS かつ要素が mte-diff-* かで判定
    var peekState = null; // { viewZoneId, overlayWidget, line }

    function findHunkAtLine(lineNumber) {
      // 行番号 ln を含むハンクを返す。
      //   1) 通常ハンク: newStart <= ln <= newStart+newCount-1 に含まれる
      //   2) 純削除ハンク(newCount=0): 「削除位置」が lineClass 上 deletedAt に
      //      addされた行(=h.newStart の補正後)。赤三角の行クリックを拾う。
      for (var i = 0; i < currentHunks.length; i++) {
        var h = currentHunks[i];
        if (h.newCount > 0) {
          if (lineNumber >= h.newStart && lineNumber < h.newStart + h.newCount) {
            return h;
          }
        } else {
          // 純削除: deletedAt は h.newStart (補正後) を加える
          // 補正は gitHunksToLineClass と揃える(1..newTotal)
          var ln = h.newStart;
          if (ln < 1) ln = 1;
          if (lineNumber === ln) return h;
        }
      }
      return null;
    }

    editor.onMouseDown(function (e) {
      if (!e.target) return;
      // 行装飾レーン(linesDecorationsClassName で出した要素)のクリックを判定
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
      var dom = e.target.element;
      if (!dom || !dom.classList) return;
      var isDiff = dom.classList.contains('mte-diff-added') ||
                   dom.classList.contains('mte-diff-modified') ||
                   dom.classList.contains('mte-diff-removed');
      if (!isDiff) return;
      var pos = e.target.position;
      if (!pos) return;
      var h = findHunkAtLine(pos.lineNumber);
      if (!h) return;
      openPeekPanel(h);
    });

    // パネルを開く。同時に1個だけ。
    function openPeekPanel(hunk) {
      closePeekPanel();
      // 変更前テキスト(全行)。純削除ハンクでも dels は持ってる。
      var beforeLines = (hunk.dels || []).map(function (d) { return d.line; });
      // パネルを出す行: 通常ハンクなら newStart の直前(=その行の上に展開)、
      // 純削除ハンクなら「削除位置」の上に展開する。
      var anchorLine = hunk.newStart;
      // newStart は1始まり。view zone の afterLineNumber は0以上、その行の「下」に
      // 出る。なので afterLineNumber = anchorLine - 1 にすれば、anchorLine の上に
      // パネルが出る(行の手前に挿入される)。
      var afterLn = anchorLine - 1;
      if (afterLn < 0) afterLn = 0;

      // パネル DOM を組み立てる
      var panel = document.createElement('div');
      panel.className = 'mte-diff-peek';

      var header = document.createElement('div');
      header.className = 'mte-diff-peek-header';
      var title = document.createElement('span');
      title.className = 'mte-diff-peek-title';
      if (beforeLines.length === 0) {
        // 純追加: 変更前は無い
        title.textContent = '変更前: (なし)';
      } else if (beforeLines.length === 1) {
        title.textContent = '変更前 (1行)';
      } else {
        title.textContent = '変更前 (' + beforeLines.length + '行)';
      }
      // ヘッダ右側のアクションボタン群
      var actions = document.createElement('div');
      actions.className = 'mte-diff-peek-actions';

      // 戻すボタン: ハンクの変更を1個だけ取り消す (新側を旧側に戻す)。
      // 純追加(beforeLines.length === 0) では「戻す」の意味が「追加分を消す」
      // になり、それも対応する。
      var revertBtn = document.createElement('button');
      revertBtn.type = 'button';
      revertBtn.className = 'mte-diff-peek-action mte-diff-peek-revert';
      revertBtn.setAttribute('aria-label', '元に戻す');
      revertBtn.setAttribute('title', '元に戻す');
      revertBtn.textContent = '\u21B6'; // ↶
      revertBtn.addEventListener('mousedown', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        revertHunk(hunk);
      });
      revertBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
      });

      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'mte-diff-peek-action mte-diff-peek-close';
      closeBtn.setAttribute('aria-label', '閉じる');
      closeBtn.setAttribute('title', '閉じる');
      closeBtn.textContent = '\u00D7'; // ×
      // Monaco の view zone 内に置いた要素は、エディタ本体の onMouseDown に
      // クリックを奪われることがある(Monaco がエディタ領域内のイベントを掴む)。
      // mousedown 段階で stopPropagation + preventDefault し、その場で閉じる。
      closeBtn.addEventListener('mousedown', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        closePeekPanel();
      });
      closeBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        closePeekPanel();
      });

      actions.appendChild(revertBtn);
      actions.appendChild(closeBtn);
      header.appendChild(title);
      header.appendChild(actions);

      var body = document.createElement('div');
      body.className = 'mte-diff-peek-body';
      if (beforeLines.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'mte-diff-peek-empty';
        empty.textContent = 'この箇所は新規追加です（変更前のテキストはありません）';
        body.appendChild(empty);
      } else {
        beforeLines.forEach(function (line) {
          var row = document.createElement('div');
          row.className = 'mte-diff-peek-line';
          // 空行も表示に出すため、空でも高さを確保する
          row.textContent = line === '' ? '\u00A0' : line;
          body.appendChild(row);
        });
      }
      panel.appendChild(header);
      panel.appendChild(body);

      // 高さ計算: 行高 × (内容行 + ヘッダ分)。最低1行ぶん。
      // 内容行は beforeLines.length (純追加なら 1=メッセージ行)
      var lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight) || 19;
      var contentLines = beforeLines.length === 0 ? 1 : beforeLines.length;
      var headerPx = 28;
      var paddingPx = 8;
      var panelHeightPx = headerPx + contentLines * lineHeight + paddingPx;

      // view zone を追加してスペース確保。
      // domNode に panel を直接入れるので、行間にそのままパネルが描画される
      // (overlay widget は不要)。
      var zoneId = null;
      editor.changeViewZones(function (accessor) {
        zoneId = accessor.addZone({
          afterLineNumber: afterLn,
          heightInPx: panelHeightPx,
          domNode: panel
        });
      });

      peekState = { viewZoneId: zoneId, line: anchorLine };
    }

    // ----------------------------------------------------------
    // ハンク1つぶんの変更を元に戻す
    // ----------------------------------------------------------
    // 「変更後(新側)の行範囲」を「変更前(旧側)のテキスト」で置き換える。
    // Monaco の executeEdits を使うことで Undo 履歴に1つの編集として記録され、
    // Ctrl+Z で取り消せる。
    //
    // ケース分け:
    //   通常ハンク(newCount > 0): エディタの newStart..newStart+newCount-1 を
    //     旧テキスト(dels の line を改行で連結)で置換。
    //   純削除ハンク(newCount === 0): newStart の「行の手前」に旧テキストを
    //     挿入する。
    //   純追加ハンク(oldCount === 0): エディタの newStart..newStart+newCount-1
    //     を空に置換(行ごと消す)。
    function revertHunk(hunk) {
      if (!hunk) return;
      var beforeLines = (hunk.dels || []).map(function (d) { return d.line; });
      var lineCount = model.getLineCount();

      var range, replacement;
      if (hunk.newCount === 0) {
        // 純削除: newStart の行の手前に挿入。
        // 挿入テキストは「行を改行で繋いだ + 末尾改行」(挿入後にもう1行ぶん下がるため)。
        var insertAtLine = hunk.newStart;
        if (insertAtLine < 1) insertAtLine = 1;
        // ファイル末尾を超える場合は最終行の末尾に挿入する
        if (insertAtLine > lineCount) {
          // ファイル末尾(最終行の末尾)に「改行 + 旧テキスト」を追加
          var lastLine = lineCount;
          var lastCol = model.getLineMaxColumn(lastLine);
          range = new monaco.Range(lastLine, lastCol, lastLine, lastCol);
          replacement = '\n' + beforeLines.join('\n');
        } else {
          // 行の手前(列1)に挿入。 旧テキスト + 改行 を入れる。
          range = new monaco.Range(insertAtLine, 1, insertAtLine, 1);
          replacement = beforeLines.join('\n') + '\n';
        }
      } else if (hunk.oldCount === 0) {
        // 純追加: 新の newStart..newStart+newCount-1 行を丸ごと消す。
        // 「行ごと消す」=「次の行頭まで含めて削除」する必要がある。
        var firstLine = hunk.newStart;
        var lastLine2 = hunk.newStart + hunk.newCount - 1;
        if (firstLine < 1) firstLine = 1;
        if (lastLine2 > lineCount) lastLine2 = lineCount;
        if (lastLine2 < lineCount) {
          // 末尾行の次行頭まで含めて消す(末尾の改行ごと削除)
          range = new monaco.Range(firstLine, 1, lastLine2 + 1, 1);
          replacement = '';
        } else {
          // 末尾が最終行: 前の行の末尾から最終行の末尾まで消す
          // (これで「前の行の改行も消える」状態になる)
          if (firstLine > 1) {
            var prevLine = firstLine - 1;
            var prevCol = model.getLineMaxColumn(prevLine);
            range = new monaco.Range(prevLine, prevCol, lastLine2, model.getLineMaxColumn(lastLine2));
            replacement = '';
          } else {
            // ファイル全体を消す
            range = new monaco.Range(1, 1, lastLine2, model.getLineMaxColumn(lastLine2));
            replacement = '';
          }
        }
      } else {
        // 通常ハンク: 新側の newStart..newStart+newCount-1 行を、
        // 旧テキストで置き換える(行ごとに改行を入れる)。
        var fLine = hunk.newStart;
        var lLine = hunk.newStart + hunk.newCount - 1;
        if (fLine < 1) fLine = 1;
        if (lLine > lineCount) lLine = lineCount;
        // 行範囲を「行頭から行末まで」で取る。改行は含めない。
        range = new monaco.Range(fLine, 1, lLine, model.getLineMaxColumn(lLine));
        replacement = beforeLines.join('\n');
      }

      // Undo 履歴に乗る形で編集を実行
      editor.executeEdits('mte-diff-revert', [
        { range: range, text: replacement, forceMoveMarkers: true }
      ]);

      // 戻したらパネルを閉じる
      closePeekPanel();
    }

    function closePeekPanel() {
      if (!peekState) return;
      try {
        var zoneId = peekState.viewZoneId;
        editor.changeViewZones(function (accessor) {
          if (zoneId !== null) accessor.removeZone(zoneId);
        });
      } catch (e) { /* ignore */ }
      peekState = null;
    }
  }

  // ------------------------------------------------------------
  // git 互換 行diff (Myers, O(ND))
  // ------------------------------------------------------------
  // 入力: 2文字列(before, after)
  // 出力: { lineClass:{currの行番号:'added'|'modified'}, deletedAt:Set<curr行番号> }
  //
  // VS Code の Git gutter は内部で git diff を実行してその結果を装飾している。
  // Monaco の内蔵 diff エンジンとは別物のため、git と同じ Myers アルゴリズムを
  // 自前で実装することで挙動を一致させる。indent-heuristic は今のところ
  // 未実装(現状のテストケースでは結果が変わらない)。
  function gitDiffForGutter(beforeText, afterText) {
    var a = gitDiffNormLines(beforeText);
    var b = gitDiffNormLines(afterText);
    var ops = gitMyersDiff(a, b);
    // 変更ブロックを compact 化(git 互換): 隣接 eq に空行を吸わせて、
    // 削除と挿入を一つのハンクにまとめる。これにより VS Code の Git gutter と
    // 同じ「変更扱い」表示になる。
    ops = gitChangeCompact(a, b, ops);
    var hunks = gitOpsToHunks(ops);
    var lc = gitHunksToLineClass(hunks, b.length);
    return { lineClass: lc.lineClass, deletedAt: lc.deletedAt, hunks: hunks };
  }

  // ============================================================
  // diff モード(左右並列表示)用の差分計算
  // ============================================================
  // 左(変更前) と 右(変更後) の Monaco エディタに、それぞれ:
  //   leftDeco:  Set<行番号> 削除/変更された左の行(赤背景・行頭 -)
  //   rightDeco: Set<行番号> 追加/変更された右の行(緑背景・行頭 +)
  // を表示するためのデータを返す。
  // また、スクロール同期用に左↔右の行対応マップを返す:
  //   leftToRight: Array(leftTotal+1) → 対応する右の行番号
  //   rightToLeft: Array(rightTotal+1) → 対応する左の行番号
  //   ※ 0インデックスは未使用、leftToRight[lineNum] でアクセス
  //   ※ ハンク内の対応行は「ハンク先頭の対応点」を指す(VS Code 流の挙動)
  function gitDiffForSideBySide(beforeText, afterText) {
    var a = gitDiffNormLines(beforeText);
    var b = gitDiffNormLines(afterText);
    var ops = gitMyersDiff(a, b);
    ops = gitChangeCompact(a, b, ops);

    var leftTotal = a.length;
    var rightTotal = b.length;
    var leftDeco = new Set();
    var rightDeco = new Set();
    var leftToRight = new Array(leftTotal + 2);
    var rightToLeft = new Array(rightTotal + 2);
    // 「変更扱い」の行ペア。VS Code の Diff Editor 同様、連続する del/ins の
    // ブロック内で類似度の高い行同士をマッチングしてペアにする。
    // ペアの行同士には、後段で文字レベル diff を当てて「行内のどの文字が
    // 変わったか」を濃い色でハイライトする。
    // 形式: [{ leftLine, rightLine, leftText, rightText }, ...]
    var linePairs = [];

    // ops を走査して、左右の行装飾と行対応を作る。
    // ops は eq/del/ins の列。左の行番号(li)と右の行番号(ri)を1始まりで進める。
    var li = 1, ri = 1;
    // ハンク開始時点のスナップショット(行対応の基準点として使う)
    var hunkLiStart = null;
    var hunkRiStart = null;
    // 現在のハンクの del/ins バッファ。{idx, line, lineNumber} の配列。
    // idx は gitPairLinesBySimilarity に渡すための配列内連番。
    var hunkDels = [];
    var hunkInss = [];

    function flushHunkMappingIfAny() {
      // ハンク中は「ハンク開始点」を共通の対応先として扱う
      // (個別行同士の対応は曖昧なため、ハンク先頭で揃える)
      if (hunkLiStart !== null) {
        var targetRight = hunkRiStart;
        var targetLeft = hunkLiStart;
        for (var l = hunkLiStart; l < li; l++) leftToRight[l] = targetRight;
        for (var r = hunkRiStart; r < ri; r++) rightToLeft[r] = targetLeft;
      }

      // このハンクで発生した del/ins を類似度マッチして linePairs に積む。
      if (hunkDels.length > 0 && hunkInss.length > 0) {
        var paired = gitPairLinesBySimilarity(hunkDels, hunkInss);
        paired.pairs.forEach(function (p) {
          // p = [delIdx, insIdx] = [hunkDels内インデックス, hunkInss内インデックス]
          var d = hunkDels[p[0]];
          var s = hunkInss[p[1]];
          linePairs.push({
            leftLine: d.lineNumber,
            rightLine: s.lineNumber,
            leftText: d.line,
            rightText: s.line
          });
        });
      }
      hunkLiStart = null;
      hunkRiStart = null;
      hunkDels = [];
      hunkInss = [];
    }

    for (var k = 0; k < ops.length; k++) {
      var op = ops[k];
      if (op.op === 'eq') {
        flushHunkMappingIfAny();
        leftToRight[li] = ri;
        rightToLeft[ri] = li;
        li++; ri++;
      } else if (op.op === 'del') {
        if (hunkLiStart === null) { hunkLiStart = li; hunkRiStart = ri; }
        leftDeco.add(li);
        hunkDels.push({ idx: hunkDels.length, line: a[li - 1], lineNumber: li });
        li++;
      } else if (op.op === 'ins') {
        if (hunkLiStart === null) { hunkLiStart = li; hunkRiStart = ri; }
        rightDeco.add(ri);
        hunkInss.push({ idx: hunkInss.length, line: b[ri - 1], lineNumber: ri });
        ri++;
      }
    }
    flushHunkMappingIfAny();

    // 端の番兵: 範囲外アクセス時のフォールバック
    leftToRight[0] = 0;
    rightToLeft[0] = 0;
    leftToRight[leftTotal + 1] = rightTotal + 1;
    rightToLeft[rightTotal + 1] = leftTotal + 1;

    return {
      leftTotal: leftTotal,
      rightTotal: rightTotal,
      leftDeco: leftDeco,
      rightDeco: rightDeco,
      leftToRight: leftToRight,
      rightToLeft: rightToLeft,
      linePairs: linePairs
    };
  }

  function gitDiffNormLines(text) {
    var s = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (s === '') return [];
    var lines = s.split('\n');
    // 末尾改行を持つテキスト("a\nb\n" → ["a","b",""])は末尾の空要素を捨てる。
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  // Myers O(ND): James Coglan 流の実装。
  // 前進フェーズで各 d の前進完了時の V を trace[d] に保存し、
  // 復元フェーズで (N,M) から逆向きに1ステップずつ辿る。
  function gitMyersDiff(a, b) {
    var N = a.length, M = b.length;
    var MAX = N + M;
    if (N === 0 && M === 0) return [];

    var sz = 2 * MAX + 1;
    var V = new Array(sz).fill(0);
    V[MAX + 1] = 0;

    var trace = [];
    var dEnd = -1;

    outer:
    for (var d = 0; d <= MAX; d++) {
      for (var k = -d; k <= d; k += 2) {
        var x;
        if (k === -d || (k !== d && V[MAX + k - 1] < V[MAX + k + 1])) {
          x = V[MAX + k + 1];
        } else {
          x = V[MAX + k - 1] + 1;
        }
        var y = x - k;
        while (x < N && y < M && a[x] === b[y]) { x++; y++; }
        V[MAX + k] = x;
        if (x >= N && y >= M) { dEnd = d; trace.push(V.slice()); break outer; }
      }
      trace.push(V.slice());
    }

    var ops = [];
    var xi = N, yi = M;
    for (var d2 = dEnd; d2 > 0; d2--) {
      var prevV = trace[d2 - 1];
      var k2 = xi - yi;
      var prevK;
      if (k2 === -d2 || (k2 !== d2 && prevV[MAX + k2 - 1] < prevV[MAX + k2 + 1])) {
        prevK = k2 + 1;
      } else {
        prevK = k2 - 1;
      }
      var prevX = prevV[MAX + prevK];
      var prevY = prevX - prevK;
      while (xi > prevX && yi > prevY) {
        ops.push({ op: 'eq', line: a[xi - 1] });
        xi--; yi--;
      }
      if (xi === prevX) {
        ops.push({ op: 'ins', line: b[yi - 1] });
        yi--;
      } else {
        ops.push({ op: 'del', line: a[xi - 1] });
        xi--;
      }
    }
    while (xi > 0 && yi > 0) {
      ops.push({ op: 'eq', line: a[xi - 1] });
      xi--; yi--;
    }
    while (xi > 0) { ops.push({ op: 'del', line: a[xi - 1] }); xi--; }
    while (yi > 0) { ops.push({ op: 'ins', line: b[yi - 1] }); yi--; }
    ops.reverse();
    return ops;
  }

  // ============================================================
  // git の xdl_change_compact 相当のロジック（JS 移植）
  // ============================================================
  // Myers の出力した編集スクリプトは、削除と挿入の境界が改行などで
  // 分断されることがあり、ハンク数が増えがち（例: 削除1行→空行→挿入2行 を
  // 「削除ハンク + 追加ハンク」に分けてしまう）。
  // git は change group を上下にスライドして、もう片方のファイルの change
  // と並ぶ位置に揃えることで、これを1つのハンクにまとめる。これによって
  // VS Code の Git gutter と同じ「削除+追加 → 変更扱い」表示になる。
  //
  // 入出力: ops 配列を ops 配列に変換(同じ編集内容、行配置だけ最適化)。
  function gitChangeCompact(a, b, ops) {
    // ops → 2つの changed ビット配列
    var lenA = a.length, lenB = b.length;
    var changedA = new Array(lenA + 1).fill(false);
    var changedB = new Array(lenB + 1).fill(false);
    var ai = 0, bi = 0;
    ops.forEach(function (op) {
      if (op.op === 'eq') { ai++; bi++; }
      else if (op.op === 'del') { changedA[ai++] = true; }
      else if (op.op === 'ins') { changedB[bi++] = true; }
    });

    // 旧側を主・新側を従でスライド → 新側を主・旧側を従でスライド
    gitCompactOneSide(changedA, a, changedB, b);
    gitCompactOneSide(changedB, b, changedA, a);

    // changed → ops を再構築（del を先、ins を後の順で並べる）
    var out = [];
    var ia = 0, ib = 0;
    while (ia < lenA || ib < lenB) {
      while (ia < lenA && ib < lenB && !changedA[ia] && !changedB[ib]) {
        out.push({ op: 'eq', line: a[ia] });
        ia++; ib++;
      }
      if (ia >= lenA && ib >= lenB) break;
      while (ia < lenA && changedA[ia]) {
        out.push({ op: 'del', line: a[ia] });
        ia++;
      }
      while (ib < lenB && changedB[ib]) {
        out.push({ op: 'ins', line: b[ib] });
        ib++;
      }
    }
    return out;
  }

  // 1方向の compact: changedX 側を主としてスライドする。
  // changedO は対応する「もう片方」のビット配列で、スライドに同期して
  // 同じ index 位置のグループを辿る。
  function gitCompactOneSide(changedX, recsX, changedO, recsO) {
    var nrecX = recsX.length, nrecO = recsO.length;
    var g = gitGroupInit(changedX);
    var go = gitGroupInit(changedO);

    while (true) {
      if (g.end === g.start) {
        if (gitGroupNext(changedX, nrecX, g) === -1) break;
        gitGroupNext(changedO, nrecO, go);
        continue;
      }

      var earliestEnd, endMatchingOther, groupsize;

      do {
        groupsize = g.end - g.start;
        endMatchingOther = -1;

        // 上にスライドできる限り
        while (gitGroupSlideUp(changedX, recsX, g) === 0) {
          if (gitGroupPrevious(changedO, go) === -1) break;
        }
        earliestEnd = g.end;
        if (go.end > go.start) endMatchingOther = g.end;

        // 下にスライドできる限り
        while (true) {
          if (gitGroupSlideDown(changedX, recsX, nrecX, g) !== 0) break;
          if (gitGroupNext(changedO, nrecO, go) === -1) break;
          if (go.end > go.start) endMatchingOther = g.end;
        }
      } while (groupsize !== (g.end - g.start));

      // 並ぶ位置に戻す（これが「削除+挿入を変更にまとめる」効果）
      if (g.end === earliestEnd) {
        // スライドできなかった
      } else if (endMatchingOther !== -1) {
        while (go.end === go.start) {
          if (gitGroupSlideUp(changedX, recsX, g) !== 0) break;
          if (gitGroupPrevious(changedO, go) === -1) break;
        }
      }
      // indent-heuristic は未実装

      if (gitGroupNext(changedX, nrecX, g) === -1) break;
      gitGroupNext(changedO, nrecO, go);
    }
  }

  function gitGroupInit(changed) {
    var g = { start: 0, end: 0 };
    while (changed[g.end]) g.end++;
    return g;
  }
  function gitGroupNext(changed, nrec, g) {
    if (g.end === nrec) return -1;
    g.start = g.end + 1;
    g.end = g.start;
    while (changed[g.end]) g.end++;
    return 0;
  }
  function gitGroupPrevious(changed, g) {
    if (g.start === 0) return -1;
    g.end = g.start - 1;
    g.start = g.end;
    while (g.start > 0 && changed[g.start - 1]) g.start--;
    return 0;
  }
  function gitGroupSlideDown(changed, recs, nrec, g) {
    if (g.end < nrec && recs[g.start] === recs[g.end]) {
      changed[g.start] = false;
      g.start++;
      changed[g.end] = true;
      g.end++;
      while (changed[g.end]) g.end++;
      return 0;
    }
    return -1;
  }
  function gitGroupSlideUp(changed, recs, g) {
    if (g.start > 0 && recs[g.start - 1] === recs[g.end - 1]) {
      g.start--;
      changed[g.start] = true;
      g.end--;
      changed[g.end] = false;
      while (g.start > 0 && changed[g.start - 1]) g.start--;
      return 0;
    }
    return -1;
  }

  // ops配列をハンクにまとめる。eq境界で del/ins の塊を1ハンクに。
  function gitOpsToHunks(ops) {
    var hunks = [];
    var oldLine = 1, newLine = 1;
    var i = 0;
    while (i < ops.length) {
      while (i < ops.length && ops[i].op === 'eq') {
        oldLine++; newLine++; i++;
      }
      if (i >= ops.length) break;
      var hOldStart = oldLine, hNewStart = newLine;
      var dels = [], inss = [];
      while (i < ops.length && ops[i].op !== 'eq') {
        if (ops[i].op === 'del') {
          dels.push({ idx: oldLine, line: ops[i].line });
          oldLine++;
        } else if (ops[i].op === 'ins') {
          inss.push({ idx: newLine, line: ops[i].line });
          newLine++;
        }
        i++;
      }
      hunks.push({
        oldStart: hOldStart, oldCount: oldLine - hOldStart,
        newStart: hNewStart, newCount: newLine - hNewStart,
        dels: dels, inss: inss
      });
    }
    return hunks;
  }

  // ============================================================
  // hunks → gutter表示用 {lineClass, deletedAt}
  // ------------------------------------------------------------
  // ハンク内の振り分け戦略:
  //   newCount===0  → 純削除(赤三角)
  //   oldCount===0  → 純追加(全てadded)
  //   oldCount===newCount → 「位置で1対1 modified」(1文字変更等を青で出す)
  //   行数違い → 「類似度ペアリング」: 削除行と追加行のうち類似度の高い
  //               組を modified、残った追加=added、残った削除=赤三角。
  //
  // この振り分けにより、VS Code Git gutter と同じ
  // 「削除と追加のうち、似てる方がペア=変更」表示になる。
  //
  // ロールバック: GIT_DIFF_USE_PAIRING を false にすれば旧ロジック(先頭から
  // min(old,new)を modified)に戻る。
  var GIT_DIFF_USE_PAIRING = true;     // VS Code流ペアリングON/OFF
  var GIT_DIFF_PAIR_THRESHOLD = 0.5;   // 類似度しきい値(未満ならペアにしない)

  function gitHunksToLineClass(hunks, newTotal) {
    var lineClass = {};
    var deletedAt = new Set();
    hunks.forEach(function (h) {
      if (h.newCount === 0 && h.oldCount > 0) {
        var ln = h.newStart;
        if (ln < 1) ln = 1;
        if (ln > newTotal) ln = newTotal;
        deletedAt.add(ln);
        return;
      }
      if (h.oldCount === 0) {
        for (var ai = 0; ai < h.newCount; ai++) {
          var lna = h.newStart + ai;
          if (lna >= 1 && lna <= newTotal) lineClass[lna] = 'added';
        }
        return;
      }

      // ペアリングOFF or 行数が同じ → 位置で1対1 modified
      if (!GIT_DIFF_USE_PAIRING || h.oldCount === h.newCount) {
        var common = Math.min(h.oldCount, h.newCount);
        for (var i = 0; i < h.newCount; i++) {
          var ln = h.newStart + i;
          if (ln < 1 || ln > newTotal) continue;
          lineClass[ln] = (i < common) ? 'modified' : 'added';
        }
        if (h.oldCount > h.newCount && h.newCount > 0) {
          var anchor = h.newStart + h.newCount;
          if (anchor > newTotal) anchor = newTotal;
          if (anchor < 1) anchor = 1;
          deletedAt.add(anchor);
        }
        return;
      }

      // 行数違い → 類似度ペアリング
      // VS Code流: 削除超過分は赤三角を出さない（変更マークだけで表現）。
      // 「何行か減った」事実は gutter には出ず、modified の表示に吸収される。
      var r = gitPairLinesBySimilarity(h.dels, h.inss, GIT_DIFF_PAIR_THRESHOLD);
      r.pairs.forEach(function (p) {
        var ln = p[1];
        if (ln >= 1 && ln <= newTotal) lineClass[ln] = 'modified';
      });
      r.unpairedIns.forEach(function (ln) {
        if (ln >= 1 && ln <= newTotal) lineClass[ln] = 'added';
      });
      // unpairedDels は赤三角を出さない（VS Code流）。
      // 純削除(newCount===0)のときだけ赤三角を出す（上の分岐で処理済み）。
    });
    return { lineClass: lineClass, deletedAt: deletedAt };
  }

  // ------------------------------------------------------------
  // 削除行と追加行を文字列類似度でペアリングする (VS Code流)
  // ------------------------------------------------------------
  // バイグラム Dice 係数で類似度を計算し、各削除行に対して最も似ている
  // 追加行をペアにする。閾値未満ならペアにしない。
  function gitPairLinesBySimilarity(dels, inss, threshold) {
    if (threshold == null) threshold = 0.5;
    var pairs = [];
    var usedIns = new Set();
    var unpairedDels = [];
    dels.forEach(function (d) {
      var bestSim = -1, bestJ = -1;
      inss.forEach(function (ins, j) {
        if (usedIns.has(j)) return;
        var s = gitLineSimilarity(d.line, ins.line);
        if (s > bestSim) { bestSim = s; bestJ = j; }
      });
      if (bestJ >= 0 && bestSim >= threshold) {
        pairs.push([d.idx, inss[bestJ].idx]);
        usedIns.add(bestJ);
      } else {
        unpairedDels.push(d.idx);
      }
    });
    var unpairedIns = [];
    inss.forEach(function (ins, j) {
      if (!usedIns.has(j)) unpairedIns.push(ins.idx);
    });
    return { pairs: pairs, unpairedDels: unpairedDels, unpairedIns: unpairedIns };
  }

  // バイグラム Dice 係数。0.0〜1.0。完全一致=1.0、無関係=0.0。
  function gitLineSimilarity(s1, s2) {
    if (s1 === s2) return 1.0;
    if (!s1 || !s2) return 0.0;
    function bigrams(s) {
      var m = new Map();
      if (s.length < 2) { m.set(s, 1); return m; }
      for (var i = 0; i < s.length - 1; i++) {
        var bg = s.substr(i, 2);
        m.set(bg, (m.get(bg) || 0) + 1);
      }
      return m;
    }
    var b1 = bigrams(s1), b2 = bigrams(s2);
    var inter = 0;
    b1.forEach(function (cnt, bg) {
      var c2 = b2.get(bg) || 0;
      inter += Math.min(cnt, c2);
    });
    var total = 0;
    b1.forEach(function (c) { total += c; });
    b2.forEach(function (c) { total += c; });
    return total === 0 ? 0 : (2 * inter) / total;
  }


  // ============================================================
  // 本文中の表ブロックを検出し、その先頭行の glyph margin にアイコンを置く。
  // アイコンクリックで、その表をパースして表ビルダーへバインド表示する。
  // 編集確定（「更新」/タブを閉じる）でその表ブロックを丸ごと差し替える。
  // ============================================================
  function setupExistingTableGlyphs(editor, textarea, fmt, ensureApi) {
    var monaco = window.monaco;
    if (!monaco) { return; }
    var model = editor.getModel();
    if (!model) { return; }

    // 表アイコンの装飾コレクション。再計算のたびに set し直す。
    // 古いMonaco（createDecorationsCollection非対応）では deltaDecorations で代替。
    var collection = null;
    var glyphIds = [];
    if (typeof editor.createDecorationsCollection === 'function') {
      collection = editor.createDecorationsCollection([]);
    }
    function setGlyphDecos(decos) {
      if (collection) { collection.set(decos); }
      else { glyphIds = editor.deltaDecorations(glyphIds, decos); }
    }

    // 1行が表の行か（| を含み、コードフェンス内でない簡易判定）。
    // 行が表行（| を含む）か。
    function isTableLine(line) {
      return /^\s*\|/.test(line);
    }

    // モデル全体を走査して表ブロック（連続する表行）を検出する。
    // 戻り値: [{ startLine, endLine }]（1-based、両端含む）
    //
    // ※ Textile はセル内に生の改行を含めるため、表の論理行が物理行を
    //   またぐことがある。例えば結合 \2/3. のセル内に "a\nb\nc" を入れると:
    //     行1: |\2/3. a       ← | で始まるが | で終わっていない（継続）
    //     行2: b              ← | を含まないただのテキスト（継続）
    //     行3: c |  |         ← | で閉じる
    //   この場合、行2は単独では表行に見えないが、直前が「| で終わっていない
    //   表行」なら、セル内改行の継続として表の一部とみなす。
    function detectBlocks() {
      var total = model.getLineCount();
      var result = [];
      var inFence = false;
      var start = -1;
      var inMultiLineCell = false; // 直前の表行が | で閉じていないか
      for (var ln = 1; ln <= total; ln++) {
        var text = model.getLineContent(ln);
        // コードフェンス内は表とみなさない（``` で開閉）。
        if (/^\s*```/.test(text)) {
          inFence = !inFence;
          if (start !== -1) { pushBlock(result, start, ln - 1); start = -1; inMultiLineCell = false; }
          continue;
        }
        if (inFence) {
          if (start !== -1) { pushBlock(result, start, ln - 1); start = -1; inMultiLineCell = false; }
          continue;
        }

        var trimmed = text.trim();
        var isTable = isTableLine(text);
        // セル内改行の継続中なら、| を含まない行も表の一部とみなす。
        // 終端 | が現れるまで継続。
        var isContinuation = inMultiLineCell && !isTable;

        if (isTable || isContinuation) {
          if (start === -1) { start = ln; }
          // 継続フラグの更新: この行が | で閉じていないなら、継続中。
          if (trimmed.endsWith('|')) {
            inMultiLineCell = false;
          } else if (trimmed.startsWith('|') || isContinuation) {
            // | で始まるが | で終わっていない → 継続セル
            // または既に継続中の行 → 継続セル
            inMultiLineCell = true;
          }
        } else {
          if (start !== -1) { pushBlock(result, start, ln - 1); start = -1; }
          inMultiLineCell = false;
        }
      }
      if (start !== -1) { pushBlock(result, start, total); }
      return result;
    }

    // ブロックを確定登録（最低でもデータ行が1行ある＝2行以上のものだけ表とみなす）。
    function pushBlock(arr, s, e) {
      if (e - s + 1 < 2) { return; } // 1行だけはヘッダのみ等。表として扱わない
      arr.push({ startLine: s, endLine: e });
    }

    // ブロックのテキストを取得（Markdownの区切り行も含めそのまま）。
    function blockText(startLine, endLine) {
      var lines = [];
      for (var ln = startLine; ln <= endLine; ln++) { lines.push(model.getLineContent(ln)); }
      return lines.join('\n');
    }

    // 競合比較用の正規化。各行の末尾空白と、文字列全体の末尾改行の揺れを
    // 吸収する（見た目に影響しない差異で誤検出しないため）。
    function normalizeForCompare(s) {
      if (s == null) { return ''; }
      return s.replace(/[ \t]+(\r?\n)/g, '$1').replace(/\s+$/,'');
    }

    // 装飾を貼り直す。テキスト変更のたびに呼ぶ（デバウンス付き）。
    function refresh() {
      var found = detectBlocks();
      var decos = found.map(function (b) {
        return {
          range: new monaco.Range(b.startLine, 1, b.startLine, 1),
          options: {
            isWholeLine: false,
            glyphMarginClassName: 'mte-tb-glyph',
            glyphMarginHoverMessage: { value: t('tb_glyph_tip', '表ビルダーで編集') },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
          }
        };
      });
      setGlyphDecos(decos);
    }

    // テキスト変更で貼り直し（軽いデバウンス）。
    var debounceTimer = null;
    editor.onDidChangeModelContent(function () {
      if (debounceTimer) { clearTimeout(debounceTimer); }
      debounceTimer = setTimeout(refresh, 200);
    });
    // 初期表示
    setTimeout(refresh, 60);

    // glyph margin クリックを検出して、その行を含む表ブロックを開く。
    // 主判定は MouseTargetType.GUTTER_GLYPH_MARGIN。環境によって種別が
    // 取りづらい場合の保険として、クリック要素が表アイコン(.mte-tb-glyph)
    // かどうかでも拾う。
    editor.onMouseDown(function (e) {
      if (!e.target) { return; }
      var isGlyphType = (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN);
      var dom = e.target.element;
      var isGlyphDom = dom && dom.classList && dom.classList.contains('mte-tb-glyph');
      if (!isGlyphType && !isGlyphDom) { return; }
      var pos = e.target.position;
      if (!pos) { return; }
      openBlockAtLine(pos.lineNumber);
    });

    // 開いた表ブロックを追跡する decoration の管理。
    //   - 表を開くたびに新しい trackId を作ると「同じ表」と判定できず別タブが
    //     量産される。そこで、開いた表ごとに追跡 decoration を1つ持ち続け、
    //     その ID をバインドの一意キー（key）として使う。
    //   - 再度同じ表（その追跡レンジに重なる行）を開いたら、既存の追跡を
    //     再利用するので、モジュール側で同じタブが再利用される。
    var openTracks = []; // [{ trackId }]

    // 指定行を含む「既存の追跡」を探す。あればその trackId を返す。
    // 新方式では追跡 decoration は1点（アンカー行）なので、アンカー行を含む
    // 表ブロックに lineNumber が入っていれば「同じ表」とみなす。
    function findTrackAtLine(lineNumber) {
      var blocks = detectBlocks();
      for (var i = 0; i < openTracks.length; i++) {
        var range = model.getDecorationRange(openTracks[i].trackId);
        var anchor = range ? range.startLineNumber : openTracks[i].openLine;
        if (anchor == null) { continue; }
        for (var j = 0; j < blocks.length; j++) {
          if (anchor >= blocks[j].startLine && anchor <= blocks[j].endLine
              && lineNumber >= blocks[j].startLine && lineNumber <= blocks[j].endLine) {
            return openTracks[i].trackId;
          }
        }
      }
      return null;
    }

    // 追跡を破棄する（更新完了やタブクローズ時にホストから呼ばれる）。
    function disposeTrack(trackId) {
      editor.deltaDecorations([trackId], []);
      openTracks = openTracks.filter(function (x) { return x.trackId !== trackId; });
    }

    // 指定行を含む表ブロックを、表ビルダーへバインドして開く。
    function openBlockAtLine(lineNumber) {
      // 最新の状態で再検出（装飾のデバウンス前でも確実に当てる）。
      var found = detectBlocks();
      var blk = null;
      for (var i = 0; i < found.length; i++) {
        if (lineNumber >= found[i].startLine && lineNumber <= found[i].endLine) { blk = found[i]; break; }
      }
      if (!blk) { return; }

      var text = blockText(blk.startLine, blk.endLine);

      // 既にこの表を開いている（追跡がある）なら、その trackId を再利用する。
      // 無ければ新規に追跡 decoration を作る。
      //
      // ※ この追跡 decoration は「クリックした表のアンカー行」を Monaco の
      //   行追従で覚えるためだけに使う。書き戻し範囲の決定には使わない。
      //   （貼り付け直後などに getDecorationRange が一時的に安定しないことが
      //     あり、それを範囲決定に使うと gone 誤検出の原因になるため。）
      //   更新時は本文を再スキャンし、アンカー行を含む実在の表ブロックへ
      //   書き戻す。
      var trackId = findTrackAtLine(lineNumber);
      if (!trackId) {
        var trackIds = editor.deltaDecorations([], [{
          range: new monaco.Range(blk.startLine, 1, blk.startLine, 1),
          options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges }
        }]);
        trackId = trackIds[0];
        // 開いた時点のブロックテキストをスナップショットとして保持する。
        // 更新時に「現在のブロックテキスト」と比べ、食い違えば本文側が変更
        // されたとみなして書き戻しを拒否する（本文が常に正）。
        // 併せて、追従が失われた場合のフォールバック用に開始行も覚えておく。
        openTracks.push({ trackId: trackId, snapshot: text, openLine: blk.startLine });
      }

      // 追跡情報を引く。
      function trackInfoOf(id) {
        for (var i = 0; i < openTracks.length; i++) {
          if (openTracks[i].trackId === id) { return openTracks[i]; }
        }
        return null;
      }

      // 現在のアンカー行を返す。decoration が追従していればその行、
      // 取れなければ開いた時の行番号にフォールバックする。
      function anchorLineOf(id) {
        var range = model.getDecorationRange(id);
        if (range) { return range.startLineNumber; }
        var info = trackInfoOf(id);
        return info ? info.openLine : null;
      }

      // 書き戻しコールバック（再スキャン方式）。
      // 戻り値: { ok:true } 成功 / { ok:false, reason:'gone'|'conflict' }
      //   gone     … アンカー行を含む表ブロックが本文に見つからない（表が削除された）
      //   conflict … 開いている間に本文側の該当ブロックが変更された
      function commit(newText) {
        var info = trackInfoOf(trackId);
        var anchor = anchorLineOf(trackId);
        if (anchor == null) { disposeTrack(trackId); return { ok: false, reason: 'gone' }; }

        // 更新の瞬間に本文を再スキャンし、アンカー行を含む表ブロックを特定する。
        var blocks = detectBlocks();
        var target = null;
        for (var i = 0; i < blocks.length; i++) {
          if (anchor >= blocks[i].startLine && anchor <= blocks[i].endLine) { target = blocks[i]; break; }
        }
        if (!target) { disposeTrack(trackId); return { ok: false, reason: 'gone' }; }

        // 競合検出: 現在のブロックテキストが、開いた時のスナップショットと
        // 違っていたら本文側が編集されている。上書きは本文の変更を壊すので拒否。
        var nowText = blockText(target.startLine, target.endLine);
        if (info && info.snapshot != null
            && normalizeForCompare(nowText) !== normalizeForCompare(info.snapshot)) {
          return { ok: false, reason: 'conflict' };
        }

        var range = new monaco.Range(
          target.startLine, 1,
          target.endLine, model.getLineMaxColumn(target.endLine));
        editor.executeEdits('table-builder-update', [{
          range: range,
          text: newText.replace(/\n$/, ''),
          forceMoveMarkers: true
        }]);
        disposeTrack(trackId);
        setTimeout(function () { editor.layout(); editor.focus(); }, 0);
        return { ok: true };
      }

      // タブが閉じられた（破棄）ときに追跡も後始末するためのコールバック。
      function onClose() { disposeTrack(trackId); }

      ensureApi().then(function (api) {
        if (api.openForText) {
          // key に安定した trackId を渡す → 同じ表は1タブに集約される。
          api.openForText(text, fmt, commit, trackId, onClose);
        } else {
          api.open();
        }
      }).catch(function () { /* ログ済み */ });
    }
  }
  // フォーム内の添付ファイルリストから画像を収集し、サムネイル付きで
  // ポップアップ表示する。クリックで ![ファイル名](ファイル名) を挿入。
  // 添付が0件の場合はフォールバックとしてファイル名入力ダイアログを表示。
  // ============================================================
  // 添付ファイル情報の収集（画像ピッカー / ファイルリンクピッカー共通）
  // ============================================================
  // Redmineフォーム/詳細DOMから添付ファイルを収集する。
  // 返り値: [{ filename, previewUrl, attachedAt, description }]
  //   previewUrl  : サムネイルURL（取得できなければ null）
  //   attachedAt  : Unixタイムスタンプ（取得できなければ null）
  //   description : アップロード時の説明文（無ければ ''）
  // 重複ファイル名は attachedAt が新しい方を優先する。
  function collectAttachmentsCommon() {
    var files = [];
    var seen = {};

    function addEntry(filename, thumbnailUrl, attachedAt, description) {
      if (!filename) { return; }
      var existing = seen[filename];
      if (existing) {
        // 新しい方の情報で補完・上書き
        if (attachedAt && (!existing.attachedAt || attachedAt > existing.attachedAt)) {
          existing.previewUrl  = thumbnailUrl || existing.previewUrl;
          existing.attachedAt  = attachedAt;
          if (description) { existing.description = description; }
        } else {
          // 既存が新しくても、空欄だけは埋める
          if (!existing.previewUrl && thumbnailUrl) { existing.previewUrl = thumbnailUrl; }
          if (!existing.description && description) { existing.description = description; }
        }
        return;
      }
      var entry = {
        filename: filename,
        previewUrl: thumbnailUrl || null,
        attachedAt: attachedAt || null,
        description: description || ''
      };
      seen[filename] = entry;
      files.push(entry);
    }

    // ---- ソース1: 既存添付（#existing-attachments .existing-attachment）----
    document.querySelectorAll('#existing-attachments .existing-attachment').forEach(function (span) {
      var filenameInput = span.querySelector('input.filename');
      var deletedInput  = span.querySelector('input.deleted_attachment');
      if (!filenameInput) { return; }
      var filename = filenameInput.value.trim();
      if (!filename) { return; }
      var id = deletedInput ? deletedInput.value.trim() : null;
      var thumbnailUrl = id ? '/attachments/thumbnail/' + id + '/200' : null;
      addEntry(filename, thumbnailUrl, null, '');
    });

    // ---- ソース2: 新規アップロード済み（.attachments_fields span[id^="attachments_"]）----
    // DOM: <span id="attachments_1">
    //        <input class="filename" value="bar.png">
    //        <input class="description" value="説明文">  ← 説明
    //        <input class="token" value="122.xxx">       ← 先頭がID
    //      </span>
    document.querySelectorAll('.attachments_fields span[id^="attachments_"]').forEach(function (span) {
      var filenameInput = span.querySelector('input.filename');
      var tokenInput    = span.querySelector('input.token');
      var descInput     = span.querySelector('input.description');
      if (!filenameInput) { return; }
      var filename = filenameInput.value.trim();
      if (!filename) { return; }
      var id = null;
      if (tokenInput) {
        var tokenVal = tokenInput.value.trim();
        var dotIdx = tokenVal.indexOf('.');
        id = dotIdx > 0 ? tokenVal.slice(0, dotIdx) : null;
      }
      var thumbnailUrl = id ? '/attachments/thumbnail/' + id + '/200' : null;
      var desc = descInput ? descInput.value.trim() : '';
      // 新規アップロードは「今」が準備完了時刻
      addEntry(filename, thumbnailUrl, Date.now(), desc);
    });

    // ---- ソース3: div.attachments テーブル（チケット詳細画面の添付セクション）----
    // DOM: <tr>
    //        <td><a class="icon icon-attachment"><span class="icon-label">foo.png</span></a>
    //            <span class="size">(251 KB)</span></td>
    //        <td><span class="description">説明文</span></td>  ← 説明（テーマにより有無）
    //        <td><span class="author">名前, 2026/05/27 17:26</span></td>
    //      </tr>
    var attachmentsDiv = document.querySelector('div.attachments');
    if (attachmentsDiv) {
      var thumbMap = {};
      attachmentsDiv.querySelectorAll('.thumbnail').forEach(function (thumb) {
        var title = thumb.getAttribute('title') || '';
        var img   = thumb.querySelector('img');
        if (title && img) { thumbMap[title] = img.getAttribute('src') || null; }
      });

      attachmentsDiv.querySelectorAll('table tbody tr').forEach(function (tr) {
        var a = tr.querySelector('a.icon.icon-attachment');
        if (!a) { return; }
        var label = a.querySelector('.icon-label');
        var filename = label ? label.textContent.trim() : '';
        if (!filename) { return; }

        // 説明: td内の .description（無ければ空）
        var descEl = tr.querySelector('.description');
        var desc = descEl ? descEl.textContent.trim() : '';

        // 日付: span.author の "YYYY/MM/DD HH:MM" をパース
        var authorSpan = tr.querySelector('span.author');
        var attachedAt = null;
        if (authorSpan) {
          var text = authorSpan.textContent.trim();
          var m = text.match(/(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2})/);
          if (m) {
            var d = new Date(m[1].replace(/\//g, '-'));
            if (!isNaN(d.getTime())) { attachedAt = d.getTime(); }
          }
        }

        addEntry(filename, thumbMap[filename] || null, attachedAt, desc);
      });
    }

    return files;
  }

  // ファイル拡張子→種別アイコンのマッピング
  function fileIconFor(filename) {
    var ext = (filename.split('.').pop() || '').toLowerCase();
    if (/^(xls|xlsx|xlsm|xlsb|csv)$/.test(ext)) { return FICON_EXCEL; }
    if (/^(doc|docx|rtf)$/.test(ext)) { return FICON_WORD; }
    if (ext === 'pdf') { return FICON_PDF; }
    if (/^(ppt|pptx|pps|ppsx)$/.test(ext)) { return FICON_PPT; }
    if (/^(png|jpe?g|gif|webp|svg|bmp|ico|tiff?|heic)$/.test(ext)) { return FICON_IMG; }
    if (/^(zip|tar|gz|tgz|bz2|7z|rar|xz)$/.test(ext)) { return FICON_ARCHIVE; }
    // 設定ファイル関連 → 歯車
    if (/^(conf|cfg|ini|env|yml|yaml|toml|properties|plist)$/.test(ext)) { return FICON_CONF; }
    // 各種コード → <>
    if (/^(js|mjs|cjs|ts|tsx|jsx|go|rs|py|rb|php|java|kt|c|h|cpp|cc|hpp|cs|swift|sh|bash|zsh|sql|pl|lua|r|scala|clj|ex|exs|erl|hs|dart|vue|svelte|json|xml|html|htm|css|scss|less|md|markdown)$/.test(ext)) { return FICON_CODE; }
    return FICON_GENERIC;
  }

  // attachapble記法用にファイル名をエスケープ。
  // スペースを含む場合は attachment:"name with space.pdf" の形にする（Redmine仕様）。
  function formatAttachmentRef(filename) {
    if (/\s/.test(filename)) {
      return 'attachment:"' + filename + '"';
    }
    return 'attachment:' + filename;
  }

  // attachedAt(ms) → "YYYY/MM/DD HH:MM" 文字列
  function formatAttachedAt(ms) {
    if (!ms) { return ''; }
    var d = new Date(ms);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ============================================================
  // 貼り付けメニューの抑止
  // ============================================================
  // Monacoのコンテキストメニューの「貼り付け(Paste)」は内部で
  // navigator.clipboard.readText() を使う。自己署名証明書などで
  // セキュアコンテキストとして完全に信頼されていない環境では readText が
  // NotAllowedError になり、メニューから貼り付けても無反応＋コンソールに
  // エラーが出る（permission状態が 'denied' とは限らず、呼び出し時に初めて
  // 失敗するため事前判定が効きにくい）。
  //
  // 一方 Ctrl+V は paste イベント経由で readText を使わず常に動作し、
  // テキスト・画像ともこのプラグインのpasteハンドラで処理できる。
  // よってメニューの貼り付けは機能的に冗長なので隠す。
  //
  // 実装メモ: Monaco 0.52 では addAction で組み込みアクションIDを上書きしても
  // コンテキストメニュー寄与は差し替わらない。そこでメニューDOMが生成される
  // たびに該当項目(Paste/貼り付け)を消す。メニューは body 直下に毎回作られる
  // ので MutationObserver で監視する。監視はページ全体で1つだけ設置する。
  function suppressPasteMenu(editor, monacoInstance) {
    if (suppressPasteMenu.installed) { return; }
    suppressPasteMenu.installed = true;

    // メニュー項目のラベル(英語/日本語)で Paste 行を特定する。
    // Monacoのコンテキストメニュー項目はおおむね
    //   <li class="action-item"> ... <span class="action-label">Paste</span> ... </li>
    // の形。ラベル文字列の完全一致で判定し、誤爆を避ける。
    var PASTE_LABELS = ['Paste', '貼り付け', '貼り付け(P)', '貼り付け (P)'];

    function hidePasteItems(root) {
      var labels = root.querySelectorAll('.action-label, .action-menu-item .label, a.action-label');
      labels.forEach(function (el) {
        var txt = (el.textContent || '').trim();
        if (PASTE_LABELS.indexOf(txt) === -1) { return; }
        // 項目本体(li.action-item など)まで遡って非表示にする。
        var item = el.closest('li.action-item') ||
                   el.closest('.action-item') ||
                   el.closest('li') || el;
        if (item) { item.style.display = 'none'; }
      });
    }

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) { continue; } // 要素のみ
          // コンテキストメニューのコンテナか、その内側にメニューを含むか
          if (node.classList && (node.classList.contains('monaco-menu-container') ||
                                 node.classList.contains('context-view') ||
                                 node.querySelector)) {
            // メニュー本体が含まれていれば Paste を消す
            if (node.querySelector && node.querySelector('.monaco-menu')) {
              hidePasteItems(node);
            } else if (node.classList && node.classList.contains('monaco-menu')) {
              hidePasteItems(node);
            }
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }
  suppressPasteMenu.installed = false;

  // ============================================================
  // 画像記法ホバー時のサムネイルツールチップ
  // ============================================================
  // 本文中の画像記法にマウスを載せると、その添付ファイルのサムネイル画像と
  // ファイル名・日付をツールチップ表示する。サムネイルURL・日付は
  // collectAttachmentsCommon() の結果(画像ピッカーと同じソース)から引く。
  //
  // 対象とする画像記法:
  //   Markdown : ![alt](filename)  /  <img ... src="filename" ...>
  //   Textile  : !filename!  /  !{width: Npx}.filename!  (修飾子付き)
  function setupImageTooltip(editor, textarea, fmt) {
    var tooltipEl = null;
    var currentFile = null; // 表示中のファイル名(重複再描画防止)

    function getTooltipEl() {
      if (tooltipEl) { return tooltipEl; }
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'monaco-image-tooltip';
      tooltipEl.style.display = 'none';
      document.body.appendChild(tooltipEl);
      return tooltipEl;
    }

    function hide() {
      if (tooltipEl) { tooltipEl.style.display = 'none'; }
      currentFile = null;
    }

    // 記法中のパス表記を実ファイル名に戻す。
    // ペースト挿入時に encodeURIComponent + !()の%xx化、あるいは
    // encodeImagePath(%20等)されているため、デコードして突き合わせる。
    function decodeName(raw) {
      var s = raw.trim();
      try { s = decodeURIComponent(s); } catch (e) { /* 不正な%列はそのまま */ }
      return s;
    }

    // 行内の画像記法を列挙し、与えられた column を含むものの「ファイル名」を返す。
    // 見つからなければ null。
    function findImageNameAtPosition(model, position) {
      if (!model) { return null; }
      var line = model.getLineContent(position.lineNumber);
      var col = position.column;

      // 検査する記法パターン。各 re は match[grpIndex] にファイル名相当を持つ。
      var patterns;
      if (fmt === 'textile') {
        patterns = [
          // !{修飾子}.filename!  例: !{width: 680px}.clipboard-...png!
          { re: /!\{[^}]*\}\.([^!\s]+?)!/g, grp: 1 },
          // !filename!  （style修飾子なし）
          { re: /!([^!\s{][^!\s]*?)!/g,     grp: 1 }
        ];
      } else {
        patterns = [
          // ![alt](filename)
          { re: /!\[[^\]]*\]\(([^)\s]+)\)/g, grp: 1 },
          // <img ... src="filename" ...>
          { re: /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi, grp: 1 }
        ];
      }

      for (var p = 0; p < patterns.length; p++) {
        var re = patterns[p].re;
        var grp = patterns[p].grp;
        var m;
        re.lastIndex = 0;
        while ((m = re.exec(line)) !== null) {
          var startCol = m.index + 1;               // 1-indexed
          var endCol = startCol + m[0].length;      // exclusive
          if (col >= startCol && col <= endCol) {
            return { name: decodeName(m[grp]), startCol: startCol };
          }
        }
      }
      return null;
    }

    // ファイル名→添付エントリ(previewUrl/attachedAt)を引く。
    function lookupAttachment(name) {
      var list = collectAttachmentsCommon();
      for (var i = 0; i < list.length; i++) {
        if (list[i].filename === name) { return list[i]; }
      }
      return null;
    }

    function isImageName(name) {
      return /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i.test(name);
    }

    function show(hit, clientX) {
      var att = lookupAttachment(hit.name);
      // 添付一覧に該当が無い、またはサムネイルURLが無ければ出さない
      if (!att || !att.previewUrl) { hide(); return; }

      var el = getTooltipEl();
      var html = '<div class="monaco-image-tooltip-img">' +
                 '<img src="' + escapeHtml(att.previewUrl) + '" alt="">' +
                 '</div>' +
                 '<div class="monaco-image-tooltip-name">' + escapeHtml(att.filename) + '</div>';
      if (att.attachedAt) {
        var d = new Date(att.attachedAt);
        var p = function (n) { return String(n).padStart(2, '0'); };
        var ds = d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
                 ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
        html += '<div class="monaco-image-tooltip-date">' + escapeHtml(ds) + '</div>';
      }
      el.innerHTML = html;

      // 位置決め: 記法の開始位置の少し上に出す。
      var startPos = { lineNumber: editor.getPosition() ? editor.getPosition().lineNumber : 1, column: hit.startCol };
      // hover対象行を使うため、position から行番号を取り直す
      startPos.lineNumber = hit.lineNumber;
      var coord = editor.getScrolledVisiblePosition(startPos);
      var node = editor.getDomNode();
      if (!coord || !node) { hide(); return; }
      var rect = node.getBoundingClientRect();

      var fsEl = ensureTooltipParent(el);
      el.style.display = 'block';
      var top, left;
      if (fsEl) {
        top = rect.top + coord.top;
        left = rect.left + coord.left;
      } else {
        top = rect.top + coord.top + window.scrollY;
        left = rect.left + coord.left + window.scrollX;
      }
      // まず表示してサイズを測り、行の上に被せて出す
      var th = el.offsetHeight;
      var placedTop = top - th - 6;
      // 上に余白が無ければ行の下に出す
      if ((fsEl ? placedTop : placedTop - window.scrollY) < 0) {
        placedTop = top + 20;
      }
      el.style.top = placedTop + 'px';
      el.style.left = left + 'px';
    }

    // Monacoのマウス移動で、テキスト上の位置を取得して判定する。
    editor.onMouseMove(function (e) {
      var t = e.target;
      if (!t || !t.position) { hide(); return; }

      // 実際の文字の上にいる時だけ判定する。
      // 行末より右の余白や行内の空白部分でも Monaco は position に
      // 「その行の最終カラム」を返すため、CONTENT_TEXT 以外は対象外にする。
      // （CONTENT_TEXT = MouseTargetType.CONTENT_TEXT。enumが取れなければ 6 を使う）
      var CONTENT_TEXT = (window.monaco && window.monaco.editor &&
                          window.monaco.editor.MouseTargetType &&
                          window.monaco.editor.MouseTargetType.CONTENT_TEXT);
      if (CONTENT_TEXT === undefined || CONTENT_TEXT === null) { CONTENT_TEXT = 6; }
      if (t.type !== CONTENT_TEXT) { hide(); return; }

      var pos = t.position;
      var hit = findImageNameAtPosition(editor.getModel(), pos);
      if (!hit) { hide(); return; }
      if (!isImageName(hit.name)) { hide(); return; }
      if (hit.name === currentFile) { return; } // 同じ対象なら再描画しない
      currentFile = hit.name;
      hit.lineNumber = pos.lineNumber;
      show(hit, e.event && e.event.posx);
    });

    editor.onMouseLeave(function () { hide(); });
    editor.onDidScrollChange(function () { hide(); });
    editor.onDidBlurEditorText(function () { hide(); });
  }

  // ============================================================
  // クリップボード画像ペースト
  // ============================================================
  // Redmine純正(attachments.js)の copyImageFromClipboard 相当を、Monaco上で
  // 再現する。アップロード(/uploads へのPOST・添付フォームへのtoken登録)は
  // 純正のグローバル関数 addFile()/ajaxUpload()/uploadBlob() に完全委譲し、
  // 本文への記法挿入だけをMonaco側でカーソル位置に対して行う。
  //
  // 純正の addInlineAttachmentMarkup は隠れた元textareaの selectionStart(=0)に
  // 挿入してしまい、Monacoのカーソル位置と食い違う。これを避けるため、純正の
  // 自動挿入は handleFileDropEvent.target を非wiki-edit要素に向けて無効化し、
  // 記法生成ロジック(getInlineAttachmentMarkup相当)はこちらで持つ。
  // ============================================================
  // クリップボード画像ペースト（document レベル・純正方式）
  // ============================================================
  // 純正Redmine(attachments.js)は paste イベントの clipboardData.files から
  // 画像を受け取る「受け身」方式で、navigator.clipboard の権限を必要としない。
  // そのため自己署名証明書やVivaldiでも動作する。本実装もこれに倣う。
  //
  // Monaco は Ctrl+V を内部処理するが、検証の結果ブラウザの native paste は
  // document まで伝播しており、画像は clipboardData.files (types=['Files']) に
  // 載ることが確認できた。そこで document に capture で paste を1つだけ張り、
  // 「今フォーカスしているMonacoエディタ」に対して添付＋記法挿入する。
  // 複数エディタ(説明欄/注記)があっても、フォーカス中のものだけを対象にするため
  // 混線しない。

  // 各Monacoエディタの登録簿（editor/textarea/fmt/node）。
  var clipboardPasteEditors = [];

  // 純正と同じファイル名: clipboard-YYYYMMDDHHmm-xxxxx.ext
  function makeClipboardName(origName, type) {
    var d = new Date();
    var p = function (n) { return ('0' + n).slice(-2); };
    var stamp = d.getFullYear() +
                p(d.getMonth() + 1) + p(d.getDate()) +
                p(d.getHours()) + p(d.getMinutes());
    var ext = (origName && origName.indexOf('.') !== -1)
      ? origName.split('.').pop()
      : ((type && type.split('/')[1]) || 'png');
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var key = '';
    for (var i = 0; i < 5; i++) {
      key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return 'clipboard-' + stamp + '-' + key + '.' + ext;
  }

  // 画像の表示幅(px)。純正同様 naturalWidth / devicePixelRatio。
  function resolveImageWidth(file) {
    return new Promise(function (resolve) {
      if (!file.type || file.type.indexOf('image/') !== 0) { resolve(0); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img.naturalWidth || img.width || 0); };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(0); };
      img.src = url;
    });
  }

  // ファイル名を記法用にエスケープ(純正 getInlineAttachmentMarkup と同等)。
  function inlineFilename(name) {
    var sanitized = name.replace(/[\/\?\%\*\:\|\"\'<>\n\r]+/g, '_');
    return encodeURIComponent(sanitized).replace(/[!()]/g, function (m) {
      return '%' + m.charCodeAt(0).toString(16);
    });
  }

  // フォーマット別の記法。Markdownはサイズ指定なし、Textileは幅修飾子を付与可。
  function buildImageMarkup(fmt, name, widthPx) {
    var fname = inlineFilename(name);
    if (fmt === 'textile') {
      return widthPx > 0 ? ('!{width: ' + widthPx + 'px}.' + fname + '!')
                         : ('!' + fname + '!');
    }
    return '![](' + fname + ')';
  }

  // 指定エディタのカーソル位置に記法を挿入(前後に必要な改行を補う)。
  function insertMarkupAtCursor(editor, markup) {
    var sel = editor.getSelection();
    var model = editor.getModel();
    if (!sel || !model) { return; }
    var lineContent = model.getLineContent(sel.startLineNumber);
    var before = lineContent.substring(0, sel.startColumn - 1);
    var after = lineContent.substring(sel.startColumn - 1);
    var prefix = (before.length > 0) ? '\n' : '';
    var suffix = (after.length > 0) ? '\n' : '';
    editor.executeEdits('paste-image', [{
      range: sel, text: prefix + markup + suffix, forceMoveMarkers: true
    }]);
    editor.focus();
  }

  // クリップボードから画像Fileを集める(files と items の両対応・重複除外)。
  function collectClipboardImages(cd) {
    var out = [];
    var seen = {};
    function push(f) {
      if (!f || !f.type || f.type.indexOf('image') === -1) { return; }
      var key = f.type + ':' + (f.size || 0);
      if (seen[key]) { return; }
      seen[key] = true;
      out.push(f);
    }
    if (cd.files) {
      for (var i = 0; i < cd.files.length; i++) { push(cd.files[i]); }
    }
    if (cd.items) {
      for (var j = 0; j < cd.items.length; j++) {
        var it = cd.items[j];
        if (it && it.kind === 'file' && it.type && it.type.indexOf('image') === 0) {
          var f = it.getAsFile();
          if (f) { push(f); }
        }
      }
    }
    return out;
  }

  // 1枚の画像を、指定エディタ文脈に対して処理する。
  // アップロードは純正(addFile)へ委譲し、記法は当該エディタのカーソル位置へ挿入。
  function processClipboardImage(ctx, file) {
    if (!file || !file.type || file.type.indexOf('image') === -1) { return; }
    var filename = makeClipboardName(file.name, file.type);
    var renamed = new File([file], filename, { type: file.type });

    // アップロードは純正に委譲（当該エディタのフォーム内 filedrop を使う）。
    var form = ctx.textarea.closest('form');
    var inputEl = form ? form.querySelector('input[type=file].filedrop') : null;
    if (typeof window.addFile === 'function' && inputEl) {
      // 純正 addInlineAttachmentMarkup は「アップロード完了後(.done)」に
      // handleFileDropEvent.target が wiki-edit のとき先頭挿入する。記法挿入は
      // こちらで行うため、純正の自動挿入を抑止したい。
      //
      // target を wiki-edit でない中立な要素(document.body)に向けることで、
      // 純正の挿入条件(hasClass('wiki-edit'))を外して抑止する。
      // ・自エディタのDOMではなく document.body にするのは、グローバル変数に
      //   エディタ参照を残さない(ダングリング回避)ため。
      // ・純正のドラッグ&ドロップ/クリップボード処理は、それぞれの開始時に
      //   handleFileDropEvent.target = e.target を自分で再設定するため、
      //   ここで document.body を残しても純正機能には影響しない。
      // ・アップロードは非同期(.done)で完了するため、ここで即座に元値へ戻すと
      //   .done 時点で抑止が外れて二重挿入になる。よって戻さず、中立値のままにする。
      if (typeof window.handleFileDropEvent !== 'undefined') {
        window.handleFileDropEvent.target = document.body;
      }
      window.addFile(inputEl, renamed, true);
    } else if (window.console) {
      console.warn('[monaco_editor] native addFile/filedrop not found; cannot upload pasted image');
    }

    // 記法挿入。Textileのみ表示幅を解決して付与、それ以外は即挿入。
    if (ctx.fmt === 'textile') {
      resolveImageWidth(renamed).then(function (w) {
        var widthPx = w > 0 ? Math.round(w / (window.devicePixelRatio || 1)) : 0;
        insertMarkupAtCursor(ctx.editor, buildImageMarkup(ctx.fmt, filename, widthPx));
      });
    } else {
      insertMarkupAtCursor(ctx.editor, buildImageMarkup(ctx.fmt, filename, 0));
    }
  }

  // 登録済みエディタのうち、今フォーカスしているものを返す。
  function focusedPasteEditor() {
    for (var i = 0; i < clipboardPasteEditors.length; i++) {
      var ctx = clipboardPasteEditors[i];
      if (ctx.editor && ctx.editor.hasTextFocus && ctx.editor.hasTextFocus()) {
        return ctx;
      }
    }
    return null;
  }

  // 当該エディタが「ファイル添付できる場所」か判定する。
  // クリップボード画像ペーストは、純正のアップロード先(filedrop input)が
  // 存在するフォーム=チケット説明/コメント/Wiki等でのみ機能すべき。
  // プロジェクト説明やウェルカムメッセージ等、添付フォームが無い画面では
  // アップロードできないため、記法だけが挿入される不整合を避けて無効化する。
  function hasAttachmentTarget(ctx) {
    var form = ctx.textarea.closest('form');
    if (!form) { return false; }
    return !!form.querySelector('input[type=file].filedrop');
  }

  // document レベルの paste ハンドラ（ページに1つだけ設置）。
  function onDocumentPaste(e) {
    var cd = e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData);
    if (!cd) { return; }

    // フォーカス中のMonacoエディタが無ければ素通し（通常のフォーム入力等）。
    var ctx = focusedPasteEditor();
    if (!ctx) { return; }

    // 添付フォームが無い画面（プロジェクト説明/ウェルカムメッセージ等）では
    // クリップボード画像ペーストを無効化する。preventDefault もしないので、
    // 通常のペースト挙動を妨げない。
    if (!hasAttachmentTarget(ctx)) { return; }

    var images = collectClipboardImages(cd);
    if (images.length === 0) { return; } // テキスト等はMonacoの通常処理に任せる

    for (var i = 0; i < images.length; i++) {
      processClipboardImage(ctx, images[i]);
    }
    // 画像がMonacoにテキストとして貼られるのを防ぐ。
    e.preventDefault();
    e.stopPropagation();
  }

  function setupClipboardImagePaste(editor, textarea, fmt) {
    var node = editor.getDomNode();
    if (!node) { return; }

    // このエディタを登録簿へ（重複登録は避ける）。
    var exists = false;
    for (var i = 0; i < clipboardPasteEditors.length; i++) {
      if (clipboardPasteEditors[i].editor === editor) { exists = true; break; }
    }
    if (!exists) {
      clipboardPasteEditors.push({ editor: editor, textarea: textarea, fmt: fmt, node: node });
    }

    // document レベルの paste リスナーはページに1度だけ張る。
    if (!setupClipboardImagePaste._docListenerAttached) {
      setupClipboardImagePaste._docListenerAttached = true;
      document.addEventListener('paste', onDocumentPaste, true);
    }
  }
  function setupImagePicker(btn, editor, textarea) {
    var fmt = detectFormat(textarea);
    // 開閉は共通コントローラに委譲（画面右端のはみ出し補正あり）
    var pop = createPopupController(btn, { build: buildPopup, clampToViewport: true });

    // 画像拡張子チェック
    var IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i;

    // 画像ファイルかどうか判定
    function isImage(filename) {
      return IMAGE_EXT.test(filename);
    }

    // ポップアップを構築（開くたびに最新の添付一覧を取得）
    function buildPopup() {
      var attachments = collectAttachmentsCommon();
      var el = document.createElement('div');
      el.className = 'monaco-image-picker';

      var images = attachments.filter(function (a) { return isImage(a.filename); });
      var others = attachments.filter(function (a) { return !isImage(a.filename); });

      if (attachments.length === 0) {
        // 添付ゼロ → フォールバックUI（ファイル名入力）
        el.appendChild(buildFallback());
        return el;
      }

      var title = document.createElement('div');
      title.className = 'monaco-image-picker-title';
      title.textContent = t('image_from_attachments', 'Insert from attachments');
      el.appendChild(title);

      // 画像ファイルのサムネイルグリッド
      if (images.length > 0) {
        var grid = document.createElement('div');
        grid.className = 'monaco-image-grid';
        images.forEach(function (att) {
          grid.appendChild(buildImageThumb(att));
        });
        el.appendChild(grid);
      }

      // 画像以外のファイル一覧
      if (others.length > 0) {
        var sep = document.createElement('div');
        sep.className = 'monaco-image-picker-sep';
        sep.textContent = t('image_other_files', 'Other files');
        el.appendChild(sep);

        var list = document.createElement('div');
        list.className = 'monaco-image-file-list';
        others.forEach(function (att) {
          list.appendChild(buildFileRow(att));
        });
        el.appendChild(list);
      }

      // 手動入力欄（常に末尾に表示）
      var manualSep = document.createElement('div');
      manualSep.className = 'monaco-image-picker-sep';
      manualSep.textContent = t('image_manual_label', 'Enter a file name directly');
      el.appendChild(manualSep);
      el.appendChild(buildFallback());

      return el;
    }

    // サムネイルカード（画像ファイル用）
    function buildImageThumb(att) {
      var card = document.createElement('div');
      card.className = 'monaco-image-thumb';

      // title属性: "ファイル名\n2026/05/27 17:26" の形式
      var titleStr = att.filename;
      if (att.attachedAt) {
        var d = new Date(att.attachedAt);
        var pad = function (n) { return String(n).padStart(2, '0'); };
        titleStr += '\n' + d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) +
                    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      }
      card.title = titleStr;

      var imgWrap = document.createElement('div');
      imgWrap.className = 'monaco-image-thumb-img';

      if (att.previewUrl) {
        var img = document.createElement('img');
        img.src = att.previewUrl;
        img.alt = att.filename;
        img.onerror = function () {
          // 読み込み失敗時はアイコン表示
          imgWrap.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="2" y="3" width="20" height="18" rx="2" stroke="#aaa" stroke-width="1.5"/><circle cx="8" cy="9" r="2" stroke="#aaa" stroke-width="1.5"/><polyline points="2,19 8,13 12,17 16,12 22,18" stroke="#aaa" stroke-width="1.5" fill="none"/></svg>';
        };
        imgWrap.appendChild(img);
      } else {
        imgWrap.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="2" y="3" width="20" height="18" rx="2" stroke="#aaa" stroke-width="1.5"/><circle cx="8" cy="9" r="2" stroke="#aaa" stroke-width="1.5"/><polyline points="2,19 8,13 12,17 16,12 22,18" stroke="#aaa" stroke-width="1.5" fill="none"/></svg>';
      }

      var name = document.createElement('div');
      name.className = 'monaco-image-thumb-name';
      name.textContent = att.filename;

      card.appendChild(imgWrap);
      card.appendChild(name);

      card.addEventListener('click', function () {
        insertImageMarkdown(att.filename);
        pop.close();
      });

      return card;
    }

    // ファイル行（非画像ファイル用）
    function buildFileRow(att) {
      var row = document.createElement('div');
      row.className = 'monaco-image-file-row';

      var icon = document.createElement('span');
      icon.className = 'monaco-image-file-icon';
      icon.innerHTML = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14"><path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2"/><polyline points="10,2 10,5 13,5" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>';

      var label = document.createElement('span');
      label.className = 'monaco-image-file-label';
      label.textContent = att.filename;

      row.appendChild(icon);
      row.appendChild(label);

      row.addEventListener('click', function () {
        insertImageMarkdown(att.filename);
        pop.close();
      });

      return row;
    }

    // フォールバック: ファイル名手動入力欄
    function buildFallback() {
      var wrap = document.createElement('div');
      wrap.className = 'monaco-image-fallback';

      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'monaco-image-input';
      input.placeholder = t('image_manual_placeholder', 'Enter a file name (e.g. image.png)');

      var insertBtn = document.createElement('button');
      insertBtn.type = 'button';
      insertBtn.className = 'monaco-image-insert-btn';
      insertBtn.textContent = t('insert', 'Insert');

      insertBtn.addEventListener('click', function () {
        var val = input.value.trim();
        if (!val) { return; }
        insertImageMarkdown(val);
        pop.close();
      });

      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { insertBtn.click(); }
      });

      wrap.appendChild(input);
      wrap.appendChild(insertBtn);
      return wrap;
    }

    // Markdown画像記法を挿入
    function insertImageMarkdown(filename) {
      var sel = editor.getSelection();
      var model = editor.getModel();
      if (!sel || !model) { return; }

      var isEmpty = sel.startLineNumber === sel.endLineNumber &&
                    sel.startColumn === sel.endColumn;
      var alt = isEmpty ? '' : model.getValueInRange(sel);

      // 記法テーブルから画像記法を生成
      //   markdown: ![alt](filename)
      //   textile : !filename!
      var syntax = syntaxFor(fmt);
      var code = (typeof syntax.image === 'function')
        ? syntax.image(filename, alt)
        : '![' + alt + '](' + encodeImagePath(filename) + ')';

      editor.executeEdits('insert-image', [{
        range: sel,
        text: code,
        forceMoveMarkers: true
      }]);

      // Markdownのalt位置（[]内）にカーソルを置く（textileは末尾）
      if (isEmpty && fmt !== 'textile') {
        editor.setSelection({
          startLineNumber: sel.startLineNumber,
          startColumn: sel.startColumn + 2,
          endLineNumber: sel.startLineNumber,
          endColumn: sel.startColumn + 2
        });
      }
      editor.focus();
    }

    btn.addEventListener('click', pop.toggle);
  }

  // ============================================================
  // ファイルリンク挿入ピッカー
  // ============================================================
  // 添付ファイルを一覧表示し、選んだものを attachment:ファイル名 として挿入。
  // リストの各行はファイル種別アイコン＋ファイル名。
  // ホバー時のツールチップ(title)に「ファイル名／説明／日付」を表示する。
  function setupFileLinkPicker(btn, editor, textarea) {
    // attachment: 記法はMarkdown/Textile共通のためフォーマット判定は不要
    // 開閉は共通コントローラに委譲（画面右端のはみ出し補正あり）
    var pop = createPopupController(btn, { build: buildPopup, clampToViewport: true });

    function buildPopup() {
      var attachments = collectAttachmentsCommon();
      var el = document.createElement('div');
      el.className = 'monaco-image-picker monaco-filelink-picker';

      if (attachments.length === 0) {
        el.appendChild(buildFallback());
        return el;
      }

      var title = document.createElement('div');
      title.className = 'monaco-image-picker-title';
      title.textContent = t('filelink_title', 'Insert a link to an attachment');
      el.appendChild(title);

      var list = document.createElement('div');
      list.className = 'monaco-filelink-list';
      attachments.forEach(function (att) {
        list.appendChild(buildFileRow(att));
      });
      el.appendChild(list);

      // 手動入力欄
      var manualSep = document.createElement('div');
      manualSep.className = 'monaco-image-picker-sep';
      manualSep.textContent = t('filelink_manual_label', 'Enter a file name directly');
      el.appendChild(manualSep);
      el.appendChild(buildFallback());

      return el;
    }

    // ファイル1件の行（アイコン＋ファイル名、titleにメタ情報）
    function buildFileRow(att) {
      var row = document.createElement('div');
      row.className = 'monaco-filelink-row';

      // ツールチップ: ファイル名 / 説明 / 日付（複数行）
      var tipLines = [att.filename];
      if (att.description) { tipLines.push(t('filelink_desc_label', 'Description: ') + att.description); }
      var dateStr = formatAttachedAt(att.attachedAt);
      if (dateStr) { tipLines.push(t('filelink_date_label', 'Date: ') + dateStr); }
      row.title = tipLines.join('\n');

      var icon = document.createElement('span');
      icon.className = 'monaco-filelink-icon';
      icon.innerHTML = fileIconFor(att.filename);

      var main = document.createElement('span');
      main.className = 'monaco-filelink-main';

      var name = document.createElement('span');
      name.className = 'monaco-filelink-name';
      name.textContent = att.filename;
      main.appendChild(name);

      // 説明があれば副次行として薄く表示
      if (att.description) {
        var desc = document.createElement('span');
        desc.className = 'monaco-filelink-desc';
        desc.textContent = att.description;
        main.appendChild(desc);
      }

      row.appendChild(icon);
      row.appendChild(main);

      row.addEventListener('click', function () {
        insertFileLink(att.filename);
        pop.close();
      });

      return row;
    }

    // フォールバック: ファイル名手動入力欄
    function buildFallback() {
      var wrap = document.createElement('div');
      wrap.className = 'monaco-image-fallback';

      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'monaco-image-input';
      input.placeholder = t('filelink_manual_placeholder', 'Enter a file name (e.g. design.pdf)');

      var insertBtn = document.createElement('button');
      insertBtn.type = 'button';
      insertBtn.className = 'monaco-image-insert-btn';
      insertBtn.textContent = t('insert', 'Insert');

      insertBtn.addEventListener('click', function () {
        var val = input.value.trim();
        if (!val) { return; }
        insertFileLink(val);
        pop.close();
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { insertBtn.click(); }
      });

      wrap.appendChild(input);
      wrap.appendChild(insertBtn);
      return wrap;
    }

    // attachment:ファイル名 を挿入（選択テキストは無視して置換）
    function insertFileLink(filename) {
      var sel = editor.getSelection();
      var model = editor.getModel();
      if (!sel || !model) { return; }

      var ref = formatAttachmentRef(filename);
      editor.executeEdits('insert-filelink', [{
        range: sel,
        text: ref,
        forceMoveMarkers: true
      }]);

      // 挿入末尾にカーソルを移動
      editor.focus();
    }

    btn.addEventListener('click', pop.toggle);
  }

  function initEditors() {
    // 個人設定で無効化されている場合は何もしない（純正エディタのまま）。
    if (!prefEnabled()) { return; }

    loadMonaco(function () {
      // Redmineのwikiエディタtextarea
      // issue description, wiki pages, notes など
      var selectors = [
        'textarea.wiki-edit',
        'textarea#issue_description',
        'textarea#content_text',
        'textarea.description'
      ];

      var found = [];
      selectors.forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (el) {
          if (!el.classList.contains('monaco-replaced') && !found.includes(el)) {
            found.push(el);
          }
        });
      });

      found.forEach(function (textarea) {
        replaceTextarea(textarea, window.monaco);
      });
    });
  }

  // ============================================================
  // DOM ready 後に起動
  // ============================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEditors);
  } else {
    initEditors();
  }

  // ---- 動的に差し替わる textarea への追従 ----
  // Redmineは新規チケット作成時にトラッカー/プロジェクトを変更すると、
  // フォームの一部（説明欄を含む）をAjaxで再描画する。このとき置換済みの
  // Monacoが捨てられ、純正textareaに戻ってしまう。
  // イベント（ajax:complete等）は仕組みによって発火しないことがあるため、
  // MutationObserver でDOMの追加を監視し、未置換のtextareaが現れたら
  // 初期化し直す。これでどの差し替え方式でも確実に追従できる。
  var reinitTimer = null;
  function scheduleReinit() {
    // 短時間に多数の変更が来てもまとめて1回だけ実行（デバウンス）
    if (reinitTimer) { clearTimeout(reinitTimer); }
    reinitTimer = setTimeout(function () {
      reinitTimer = null;
      initEditors();
    }, 150);
  }

  if (typeof MutationObserver !== 'undefined') {
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) { continue; } // 要素ノードのみ
          // Monaco自身が生成したDOM（wrapper配下）は無視する。
          // これを拾うと replaceTextarea → DOM追加 → 再発火 の
          // 無限ループになりうるため。
          if (node.closest && node.closest('.monaco-editor-wrapper')) { continue; }
          // 対象は Redmine の編集用 textarea（特定クラス）のみ。
          // Monaco内部の隠しtextarea(.inputarea)等は class が異なり拾わない。
          var sel = 'textarea.wiki-edit, textarea#issue_description, textarea#content_text, textarea.description';
          if (node.matches && node.matches(sel)) { scheduleReinit(); return; }
          if (node.querySelector && node.querySelector(sel)) { scheduleReinit(); return; }
        }
      }
    });
    // body全体の子孫の追加を監視
    var startObserve = function () {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserve);
    } else {
      startObserve();
    }
  }

  // 旧来のイベントベースの再初期化も保険として残す
  document.addEventListener('ajax:complete', scheduleReinit);

})();
