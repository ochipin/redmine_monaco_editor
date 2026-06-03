# ============================================================
# Redmine Monaco Editor — ルーティング
# ============================================================
# プラグイン独自のトップレベルルート。
#   GET /monaco_editor/macros        → JSON でマクロ一覧
#   GET /monaco_editor/wiki_pages    → JSON で閲覧可能なWikiページ一覧
#   GET /monaco_editor/users         → JSON でプロジェクトメンバー一覧（@補完用）
#
# Redmine 本体や他プラグインのルートと衝突しないよう、
# /monaco_editor/ 名前空間配下にまとめる。
RedmineApp::Application.routes.draw do
  get 'monaco_editor/macros', to: 'monaco_macros#index', as: 'monaco_editor_macros'
  get 'monaco_editor/wiki_pages', to: 'monaco_wiki_pages#index', as: 'monaco_editor_wiki_pages'
  get 'monaco_editor/users', to: 'monaco_users#index', as: 'monaco_editor_users'
end
