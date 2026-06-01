Redmine::Plugin.register :redmine_monaco_editor do
  name        'Redmine Monaco Editor'
  author      'Suguru Ochiai'
  description 'Replaces the default Redmine text editor with Monaco Editor (VS Code engine) with Markdown syntax highlighting and side-by-side preview.'
  version     '1.0.0'
  requires_redmine version_or_higher: '6.0.0'
end

# ViewHook は init.rb 内に直接定義する
# （require_dependency で別ファイルを読む方式だと環境によって効かないため）
module RedmineMonacoEditor
  class ViewHook < Redmine::Hook::ViewListener
    # monaco_editor 名前空間配下の翻訳キー一覧。
    # ここに挙げたキーを現在のロケールで解決し、JS に window.MONACO_EDITOR_I18N
    # として渡す。新しいUI文字列を足すときは locales の yml とこの配列に追記する。
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
      # 現在のユーザー言語で各キーを解決して辞書を作る。
      # l() は Redmine のヘルパー。キーは "monaco_editor.<key>" 形式。
      dict = I18N_KEYS.each_with_object({}) do |key, h|
        h[key] = l("monaco_editor.#{key}")
      end

      # JSへ辞書を渡す（XSS対策として JSON を escape_javascript せず、
      # to_json で安全にシリアライズしたうえで <script> に埋め込む）。
      i18n_script =
        "<script>window.MONACO_EDITOR_I18N = #{dict.to_json};</script>".html_safe

      stylesheet_link_tag('monaco_editor', plugin: 'redmine_monaco_editor') +
      i18n_script +
      javascript_include_tag('monaco_editor', plugin: 'redmine_monaco_editor')
    end
  end
end
