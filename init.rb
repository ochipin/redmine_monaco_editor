require_relative 'lib/redmine_monaco_editor/settings'
require_relative 'lib/redmine_monaco_editor/my_controller_patch'

Redmine::Plugin.register :redmine_monaco_editor do
  name        'Redmine Monaco Editor'
  author      'Suguru Ochiai'
  description 'Replaces the default Redmine text editor with Monaco Editor (VS Code engine) with Markdown syntax highlighting and side-by-side preview.'
  version     '0.1.0'
  requires_redmine version_or_higher: '6.0.0'
end

# MyController へパッチを適用（個人設定保存時に monaco_settings を反映）。
# prepend で account メソッドをラップする。
#
# 適用タイミングの注意:
#   プラグインの init.rb はRails初期化のかなり後で評価されるため、
#   Rails.application.config.to_prepare にブロックを登録しても初回の
#   to_prepare フックを取りこぼし、本番(eager_load)環境では一度も
#   実行されないことがある。そこで以下の二段構えにする:
#     (1) init.rb 評価時点で MyController をロードして即 prepend
#     (2) 念のため to_prepare にも登録（開発環境の再読み込み追従用）
#
# トップレベルに def を置くと Object にメソッドが生えてしまうため、
# ラムダに包んで名前空間を汚さないようにする。
redmine_monaco_editor_apply_patch = lambda do
  begin
    require_dependency 'my_controller'
    unless MyController.ancestors.include?(RedmineMonacoEditor::MyControllerPatch)
      MyController.send(:prepend, RedmineMonacoEditor::MyControllerPatch)
      Rails.logger.info '[redmine_monaco_editor] MyControllerPatch prepended'
    end
  rescue => e
    Rails.logger.error "[redmine_monaco_editor] failed to apply MyControllerPatch: #{e.class}: #{e.message}"
  end
end

# (1) その場で適用（本番eager_load環境で確実に効かせる）
redmine_monaco_editor_apply_patch.call

# (2) 開発環境のクラス再読み込みにも追従させる
Rails.application.config.to_prepare do
  redmine_monaco_editor_apply_patch.call
end

# ViewHook は init.rb 内に直接定義する
# （require_dependency で別ファイルを読む方式だと環境によって効かないため）
module RedmineMonacoEditor
  class ViewHook < Redmine::Hook::ViewListener
    # monaco_editor 名前空間配下の翻訳キーのうち、
    # 「フロントエンド(JS)に渡すもの」だけをここに列挙する。
    # ここに挙げたキーは現在のロケールで解決し、JSへ
    # window.MONACO_EDITOR_I18N として渡される。
    #
    # 注意: サーバ側(ViewHook)でしか使わない文言（個人設定画面の
    # ラベル等）はここに入れない。それらは yml に置いて l() で直接
    # 引けば済むため、JSへ渡すと無駄になる。新しい言語を足すときは
    # yml を1枚増やすだけでよく、この配列は触らない。
    I18N_KEYS = %w[
      mode_edit mode_edit_tip mode_split mode_split_tip mode_split_v_tip
      mode_preview_tip outline_tip
      bold_tip italic_tip underline_tip strike_tip code_inline_tip
      h1_tip h2_tip h3_tip h4_tip ul_tip ol_tip blockquote_tip code_block_tip
      table_tip image_tip file_link_tip
      placeholder_text placeholder_code
      preview_loading preview_failed preview_url_missing
      outline_empty resize_tip
      table_insert table_col_prefix
      image_from_attachments image_other_files image_manual_label
      image_manual_placeholder insert
      filelink_title filelink_manual_label filelink_manual_placeholder
      filelink_desc_label filelink_date_label
      ticket_not_found note_prefix
    ].freeze

    def view_layouts_base_html_head(context = {})
      user = User.current

      # この機能を無効にしているユーザーには、JS/CSS自体を差し込まない。
      # → textareaは素のまま（純正エディタ）になる。
      return ''.html_safe unless RedmineMonacoEditor::Settings.enabled_for?(user)

      # 現在のユーザー言語で各キーを解決して辞書を作る。
      # l() は Redmine のヘルパー。キーは "monaco_editor.<key>" 形式。
      dict = I18N_KEYS.each_with_object({}) do |key, h|
        h[key] = l("monaco_editor.#{key}")
      end

      # ユーザーのMonaco設定（将来のtheme/font_size含む）をJSへ渡す。
      prefs = RedmineMonacoEditor::Settings.for_user(user)

      # JSへ辞書/設定を渡す（to_json で安全にシリアライズして埋め込む）。
      data_script =
        ("<script>" \
         "window.MONACO_EDITOR_I18N = #{dict.to_json};" \
         "window.MONACO_EDITOR_PREFS = #{prefs.to_json};" \
         "</script>").html_safe

      stylesheet_link_tag('monaco_editor', plugin: 'redmine_monaco_editor') +
      data_script +
      javascript_include_tag('monaco_editor', plugin: 'redmine_monaco_editor')
    end

    # ============================================================
    # 個人設定（My account）画面に「Monaco Editorを使う」チェックボックスを追加
    # ============================================================
    # view_my_account_preferences フックは、個人設定ページの
    # 「設定」セクション内にHTMLを差し込める。
    # チェックボックスは hidden(=0) と組にして、OFF時も必ず値が
    # 送信されるようにする（未チェックだと送られないHTML仕様の回避）。
    def view_my_account_preferences(context = {})
      user = context[:user] || User.current
      settings = RedmineMonacoEditor::Settings.for_user(user)
      checked = RedmineMonacoEditor::Settings.enabled_for?(user)
      current_theme = settings['theme'].to_s
      current_theme = 'github-light' if current_theme.empty? || current_theme == 'vs'

      section_label = l('monaco_editor.pref_section')
      enabled_label = l('monaco_editor.pref_enabled')
      theme_label   = l('monaco_editor.pref_theme')

      checkbox = checked ? 'checked="checked"' : ''

      # テーマの選択肢: [value, ラベルのi18nキー]
      theme_options = [
        ['github-light', 'theme_github_light'],
        ['quiet-light',  'theme_quiet_light'],
        ['github-dark',  'theme_github_dark']
      ]
      options_html = theme_options.map do |value, key|
        sel = (value == current_theme) ? ' selected="selected"' : ''
        label = ERB::Util.html_escape(l("monaco_editor.#{key}"))
        "<option value=\"#{value}\"#{sel}>#{label}</option>"
      end.join

      # Redmineの個人設定フォーム内に差し込まれる前提のHTML。
      # name を monaco_settings[...] にすることで params[:monaco_settings] に入る。
      # チェックボックスは hidden(=0)+checkbox(=1) でOFF時も値が必ず送信される。
      "<fieldset class=\"box tabular\">" \
      "<legend>#{ERB::Util.html_escape(section_label)}</legend>" \
      "<p>" \
      "<label>#{ERB::Util.html_escape(enabled_label)}</label>" \
      "<input type=\"hidden\" name=\"monaco_settings[enabled]\" value=\"0\" />" \
      "<input type=\"checkbox\" name=\"monaco_settings[enabled]\" value=\"1\" #{checkbox} />" \
      "</p>" \
      "<p>" \
      "<label>#{ERB::Util.html_escape(theme_label)}</label>" \
      "<select name=\"monaco_settings[theme]\">#{options_html}</select>" \
      "</p>" \
      "</fieldset>".html_safe
    end
  end
end
