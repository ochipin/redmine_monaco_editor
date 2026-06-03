# ============================================================
# Monaco Editor 用 Wikiページ一覧エンドポイント
# ============================================================
# [[ Wikiリンク補完のために、ユーザーが閲覧可能な全プロジェクトの
# Wikiページ名を返す。REST API(.json) が無効な環境でも使えるよう、
# プラグイン独自のトップレベルルート（/monaco_editor/wiki_pages）を使う。
#
# 設計方針:
#   - ログインユーザーのみ（require_login）。
#   - 権限を尊重し、ユーザーが :view_wiki_pages 権限を持つプロジェクトの
#     ページだけを返す（見えないプロジェクトのページ名は漏らさない）。
#   - 全プロジェクト横断のため、補完の挿入形は project:title 形式にできる
#     よう、プロジェクト識別子と表示名も併せて返す。
#
# 返却形式:
#   [
#     { "project_identifier": "sco",
#       "project_name": "SCO",
#       "title": "Proxmoxの論理ボリューム変更方法",  # Wikiページのタイトル
#       "is_current": true                            # 現在のプロジェクトか
#     }, ...
#   ]
class MonacoWikiPagesController < ApplicationController
  before_action :require_login

  def index
    pages = collect_wiki_pages
    respond_to do |format|
      format.json { render json: pages }
      format.any  { render json: pages, content_type: 'application/json' }
    end
  end

  private

  def collect_wiki_pages
    # 現在のプロジェクト（補完の絞り込み・現プロジェクト優先表示に使う）。
    # params[:project_id] が来ていれば優先。
    current_identifier = params[:project_id].presence

    # ユーザーが Wiki を閲覧できるプロジェクトを特定する。
    # Project.allowed_to は指定権限を持つプロジェクトscopeを返す。
    allowed_projects =
      begin
        Project.allowed_to(User.current, :view_wiki_pages)
      rescue => e
        Rails.logger.error "[redmine_monaco_editor] allowed_to error: #{e.class}: #{e.message}"
        Project.none
      end

    # 該当プロジェクトの Wiki ページを一括取得（N+1を避けるため includes）。
    pages =
      WikiPage
        .joins(:wiki)
        .where(wikis: { project_id: allowed_projects.select(:id) })
        .includes(wiki: :project)

    result = pages.map do |page|
      project = page.wiki.project
      next nil unless project
      {
        project_identifier: project.identifier,
        project_name: project.name,
        title: page.title,
        is_current: (current_identifier.present? &&
                     project.identifier == current_identifier)
      }
    end.compact

    # 現在のプロジェクトを先頭へ、その後はプロジェクト名→ページ名で安定ソート。
    result.sort_by do |h|
      [h[:is_current] ? 0 : 1, h[:project_name].to_s, h[:title].to_s]
    end
  end
end
