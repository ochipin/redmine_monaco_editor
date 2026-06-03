# ============================================================
# Monaco Editor 用 メンション候補ユーザー一覧エンドポイント
# ============================================================
# @メンション補完のために、対象プロジェクトのメンバー（ユーザー）を
# id / login / name で返す。
#
# 背景:
#   従来はクライアントで /users/<id> ページをスクレイプして login を
#   取得していたが、ユーザーページのヘッダーにある .user 要素は
#   「ログイン中の自分」を指すため、どのユーザーを引いても自分の login が
#   返る不具合があった。さらにラベル文言は多言語化されており、テキスト
#   依存の抽出は脆い。
#   そこでサーバ側で User.login を直接返す。スクレイプもラベル依存も不要。
#
# 母集団:
#   Redmine標準のメンション候補に倣い「プロジェクトのメンバー（principals
#   のうち User）」を返す。担当者になれるか(assignable)とは無関係。
#   実際に通知が届くかは Redmine 側が閲覧権限で判定するため、ここでは
#   候補としてメンバーを広く返す。
#
# 返却形式:
#   [ { "id": 6, "login": "testman", "name": "テスト 太郎" }, ... ]
class MonacoUsersController < ApplicationController
  before_action :require_login
  before_action :find_project

  def index
    users = collect_members
    respond_to do |format|
      format.json { render json: users }
      format.any  { render json: users, content_type: 'application/json' }
    end
  end

  private

  def find_project
    identifier = params[:project_id].presence
    @project = identifier ? Project.find_by(identifier: identifier) : nil
    # プロジェクトが特定でき、かつ閲覧可能な場合のみ続行。
    if @project && !@project.visible?(User.current)
      @project = nil
    end
  end

  def collect_members
    return [] unless @project

    # プロジェクトのメンバーである User を集める。
    # Member -> principal が User のものだけを対象（Group は除外）。
    members =
      begin
        @project.members.includes(:user).map(&:user).compact
      rescue => e
        Rails.logger.error "[redmine_monaco_editor] members error: #{e.class}: #{e.message}"
        []
      end

    # User 以外（Group等）を除外し、かつ active なユーザーだけに絞る。
    # ロック済み(STATUS_LOCKED)や登録待ち(STATUS_REGISTERED)のユーザーは
    # ログインできず、メンションしても通知が届かないため候補から外す。
    members.select! { |u| u.is_a?(User) && u.active? }

    # 重複排除して id/login/name を返す。
    seen = {}
    result = []
    members.each do |u|
      next if seen[u.id]
      seen[u.id] = true
      result << {
        id: u.id,
        login: u.login.to_s,
        name: u.name.to_s
      }
    end

    # 表示名でソート（安定した並び）。
    result.sort_by { |h| h[:name] }
  end
end
