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
      ol:          { type: 'line', prefix: '1. ', exact: false },
      blockquote:  { type: 'line', prefix: '> ',  exact: false },
      codeBlock:   { type: 'mdfence' },
      image:       function (filename, alt) { return '![' + (alt || '') + '](' + filename + ')'; }
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
      image:       function (filename) { return '!' + filename + '!'; }
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
        done();
      }, function () {
        // 一部失敗しても続行（存在しない言語があっても無視）
        registerLanguageAliases();
        registerMarkdownOutline(window.monaco);
        registerTextileLanguage(window.monaco);
        registerCustomThemes(window.monaco);
        registerMentionCompletion(window.monaco);
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

    monacoInstance.languages.registerCompletionItemProvider('markdown', {
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
        var users = collectProjectUsers();
        var modelUri = model.uri ? model.uri.toString() : '';

        var range = {
          startLineNumber: position.lineNumber, startColumn: startCol,
          endLineNumber: position.lineNumber, endColumn: position.column
        };

        var suggestions = users.map(function (u) {
          return {
            label: '@' + u.name,                   // 候補表示は @表示名
            kind: monacoInstance.languages.CompletionItemKind.User,
            detail: 'メンション',
            // filterText を "@表示名" にする。ユーザーが @Ochi と打つと
            // Monacoのあいまい一致で "@Suguru Ochiai" にマッチする
            // （@,O,c,h,i が順に含まれる）。
            filterText: '@' + u.name,
            insertText: '@' + u.name,              // 一旦表示名を入れる（後でログインIDに置換）
            range: range,
            // 確定後にログインIDへ置換するためのコマンドを呼ぶ
            command: {
              id: MENTION_RESOLVE_CMD,
              title: 'resolve mention',
              arguments: [modelUri, u.id, position.lineNumber, startCol]
            }
          };
        });

        return { suggestions: suggestions };
      }
    });
  }

  // 補完確定後に呼ばれるコマンドID（ログインIDへの置換用）
  var MENTION_RESOLVE_CMD = 'monacoEditor.resolveMention';


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
        var loginEl = doc.querySelector('.user');
        var nameEl = doc.querySelector('h2');
        var info = {
          login: loginEl ? loginEl.textContent.trim() : '',
          name: nameEl ? nameEl.textContent.trim() : ''
        };
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

  // ログインIDから情報を解決する。
  // キャッシュに無ければ、担当者セレクトの全ユーザーを順に引いて
  // 一致するものを探す（初回のみ。以降はキャッシュヒット）。
  function resolveUserByLogin(login) {
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

        // 位置決め: #数字 の少し上に出す（page座標 = viewport + scroll）
        el.style.display = 'block';
        var top = rect.top + coord.top + window.scrollY;
        var left = rect.left + coord.left + window.scrollX;

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
      document.body.appendChild(popup);

      // トリガーボタンの直下に配置
      var rect = btn.getBoundingClientRect();
      var left = rect.left + window.scrollX;
      popup.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
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
  var ICON_IMAGE       = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="6" r="1.5" stroke="currentColor" stroke-width="1.1"/><polyline points="1,12 5,8 8,11 11,8 15,12" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>';
  // ツールバーの「ファイルリンク」ボタン用（クリップ/添付アイコン）
  var ICON_ATTACH      = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13 7l-5.5 5.5a2.5 2.5 0 01-3.5-3.5L9 3.5a1.5 1.5 0 012 2L5.5 11a0.5 0.5 0 01-.7-.7L9.5 5.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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

    // 順序: 編集・分割・縦分割・プレビュー・アウトライン
    modeGroup.appendChild(btnEdit);
    modeGroup.appendChild(btnSplit);
    modeGroup.appendChild(btnSplitV);
    modeGroup.appendChild(btnPreview);
    modeGroup.appendChild(btnOutline);

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
      { key: 'table',      icon: ICON_TABLE,       title: t('table_tip', 'Insert table') },
      { key: 'image',      icon: ICON_IMAGE,       title: t('image_tip', 'Insert image') },
      { key: 'fileLink',   icon: ICON_ATTACH,      title: t('file_link_tip', 'Insert file link') }
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

    // ツールバーに組み立て
    toolbar.appendChild(modeGroup);
    toolbar.appendChild(groupSep);
    toolbar.appendChild(decoToolbar);

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
      wordWrap: 'on',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 14,
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
      // ホバー等のオーバーレイをbody直下に固定配置する。
      // エディタコンテナの幅・スクロール位置に起因する
      // ツールチップの配置ズレ（左に余白が空く現象）を回避する。
      fixedOverflowWidgets: true,
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
        showWords: false
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

    // Monaco の変更をtextareaに反映（フォーム送信時に値が送られるよう）
    editor.onDidChangeModelContent(function () {
      textarea.value = editor.getValue();
    });

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

    // ---- スクロール同期（エディタ → プレビュー、一方向）----
    setupScrollSync(editor, previewPane, body, textFormat);

    // ---- ボタンのstate管理 ----
    function setMode(mode) {
      // mode: 'edit' | 'split' | 'split-v' | 'preview'
      body.classList.remove('split-view', 'split-vertical', 'preview-only');
      btnEdit.classList.remove('active');
      btnSplit.classList.remove('active');
      btnSplitV.classList.remove('active');
      btnPreview.classList.remove('active');

      // スプリッターのドラッグで付いたインライン値をリセット（CSS既定の50:50に戻す）
      editorContainer.style.flex = '';
      previewPane.style.flex = '';

      if (mode === 'split') {
        // 左右分割
        body.classList.add('split-view');
        btnSplit.classList.add('active');
        updatePreview();
      } else if (mode === 'split-v') {
        // 上下分割（split-view + split-vertical）
        body.classList.add('split-view', 'split-vertical');
        btnSplitV.classList.add('active');
        updatePreview();
      } else if (mode === 'preview') {
        body.classList.add('preview-only');
        btnPreview.classList.add('active');
        updatePreview();
      } else {
        btnEdit.classList.add('active');
      }

      // プレビューのみモードでは装飾ツールバーを無効化
      var isPreviewOnly = (mode === 'preview');
      decoToolbar.querySelectorAll('button.monaco-deco-btn').forEach(function (btn) {
        btn.disabled = isPreviewOnly;
      });
      decoToolbar.classList.toggle('monaco-decoration-toolbar--disabled', isPreviewOnly);

      // Monacoのレイアウトをリフレッシュ
      setTimeout(function () { editor.layout(); }, 50);
    }

    btnEdit.addEventListener('click', function () { setMode('edit'); });
    btnSplit.addEventListener('click', function () { setMode('split'); });
    btnSplitV.addEventListener('click', function () { setMode('split-v'); });
    btnPreview.addEventListener('click', function () { setMode('preview'); });

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

    // @メンションの補完確定→ログインID置換 と ツールチップをセットアップ
    setupMention(editor, monacoInstance);

    // 装飾ツールバーのクリックハンドラを登録
    // decoBtns は { bold: <button>, italic: <button>, ... } のマップ。
    // setupDecoToolbar はこのキーで各ボタンにハンドラを結線する。
    setupDecoToolbar(editor, decoBtns, textarea);
  }

  // ============================================================
  // @メンションの確定処理＆ツールチップ
  // ============================================================
  // 補完確定後にログインIDへ置換するコマンドをグローバル登録する。
  // CompletionItem.command から呼べるのは registerCommand で登録した
  // コマンドのみ（addActionのアクションIDでは "not found" になる）。
  // 一度だけ登録すればよい。
  var mentionCommandRegistered = false;
  function registerMentionResolveCommand(monacoInstance) {
    if (mentionCommandRegistered) { return; }
    mentionCommandRegistered = true;

    monacoInstance.editor.registerCommand(
      MENTION_RESOLVE_CMD,
      function (accessor, modelUri, numericId, lineNumber, atCol) {
        // modelUri から対象エディタを特定する
        var editors = monacoInstance.editor.getEditors();
        var ed = null;
        for (var i = 0; i < editors.length; i++) {
          var m = editors[i].getModel();
          if (m && m.uri && m.uri.toString() === modelUri) { ed = editors[i]; break; }
        }
        if (!ed) { return; }

        fetchUserById(numericId).then(function (info) {
          if (!info || !info.login) { return; }
          var model = ed.getModel();
          if (!model) { return; }
          var pos = ed.getPosition();
          var endCol = pos ? pos.column : (model.getLineContent(lineNumber).length + 1);
          ed.executeEdits('mention-resolve', [{
            range: {
              startLineNumber: lineNumber, startColumn: atCol,
              endLineNumber: lineNumber, endColumn: endCol
            },
            text: '@' + info.login + ' ',
            forceMoveMarkers: true
          }]);
          // カーソルを置換後の末尾へ
          var newCol = atCol + ('@' + info.login + ' ').length;
          ed.setPosition({ lineNumber: lineNumber, column: newCol });
        });
      }
    );
  }

  function setupMention(editor, monacoInstance) {
    // グローバルコマンド（置換処理）を登録（初回のみ）
    registerMentionResolveCommand(monacoInstance);

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
    mentionTooltipEl.style.top = (top + window.scrollY) + 'px';
    mentionTooltipEl.style.left = (left + window.scrollX) + 'px';
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
  function setupDecoToolbar(editor, btns, textarea) {
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
    // spec: { prefix, exact, textile }
    //   exact=true  : 見出しなど（Markdown "## " / Textile "h2. "）
    //   exact=false : リスト・引用（先頭一致で除去）
    //   textile=true: Textile見出し（"h2." の後に半角スペース1つ。Markdownの "##" とは付与形が異なる）
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
    setupImagePicker(btns.image, editor, textarea);
    setupFileLinkPicker(btns.fileLink, editor, textarea);

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
  // 画像挿入ピッカー
  // ============================================================
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
        : '![' + alt + '](' + filename + ')';

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

  // Redmineはturblinksライクなページ遷移を使う場合があるので一応対応
  document.addEventListener('ajax:complete', function () {
    setTimeout(initEditors, 100);
  });

})();
