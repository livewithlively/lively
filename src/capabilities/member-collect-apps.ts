// 토글 하나로 켜지는 «모아 두기» 앱 표(#2247) — 피그마·ClickUp. 슬랙·노션·구글은 각자 파일(OAuth 동의·봇 등 앱 고유 흐름).
//  새 앱을 붙일 때: ① CONNECTOR_SPECS 에 token_source 필드 ② config.ts 에 해소 훅 ③ 여기 표 한 줄 ④ 웹 카드.
import { makeMemberTokenCollect } from "./member-collect.js";
import { ensureFigmaCommentsDistiller } from "../org/distill/figma-preset.js";
import { FIGMA_TOKEN_KIND } from "../org/credentials/figma-token-source.js";
import { CLICKUP_TOKEN_KIND } from "../org/credentials/plain-token-source.js";
import { GITHUB_TOKEN_KIND } from "../org/credentials/github-token-source.js";
import { ensureGithubIssuesDistiller } from "../org/distill/github-preset.js";
import { listInstallationRepos } from "../org/credentials/github-app-git.js";
import { GITLAB_TOKEN_KIND, pickGitlabSlot } from "../org/credentials/gitlab-token-source.js";
import { listMemberSecretsPublic, memberOwner } from "../org/credentials/member-secret-store.js";

/** 토글이 만드는 인스턴스 키 — 관리탭에서 손으로 만든 것('_' 등)과 겹치지 않게 고정 이름. */
export const MEMBER_INSTANCE = "lively-member";

export const figmaCollectCapabilities = makeMemberTokenCollect({
  system: "figma", preset: "figma", instance: MEMBER_INSTANCE, credKind: FIGMA_TOKEN_KIND, appLabel: "Figma",
  label: "Figma — 내 파일의 코멘트",
  note: "[Figma 모아 두기] 토글로 만들어진 수집기 — 켠 사람의 Figma 토큰으로 고른 파일의 코멘트를 모읍니다(#2247). 토큰 칸은 비워 두세요.",
  connectHint: "[외부 앱 연결 ▸ Figma]에서 개인 액세스 토큰을 저장하세요",
  scopeKeys: ["file_keys", "team_ids"], requireScope: true,
  scopeHint: "모을 피그마 파일 링크(또는 팀 id)를 하나는 넣어 주세요 — 피그마엔 목록이 없어서 링크로 범위를 정합니다.",
  outcome: "고른 파일의 코멘트가 자료함에 들어오고, 코멘트 증류기가 꺼진 채로 함께 준비된다.",
  // #1881 F8 과 같은 이유 — 자료만 쌓이고 증류기가 0개면 지식이 한 줄도 안 는다. 꺼진 채로 만들어 두기만 한다.
  onEnabled: async ({ actor, source }) => { await ensureFigmaCommentsDistiller({ actor, source: `collect-toggle:${source}` }); },
});

export const clickupCollectCapabilities = makeMemberTokenCollect({
  system: "clickup", preset: "clickup", instance: MEMBER_INSTANCE, credKind: CLICKUP_TOKEN_KIND, appLabel: "ClickUp",
  label: "ClickUp — 내 워크스페이스",
  note: "[ClickUp 모아 두기] 토글로 만들어진 수집기 — 켠 사람의 ClickUp 토큰으로 워크스페이스의 작업·댓글을 가져옵니다(#2247). API Token 칸은 비워 두세요.",
  connectHint: "[외부 앱 연결 ▸ ClickUp]에서 API 토큰을 저장하세요",
  // ClickUp 은 구조 엔티티(스페이스·리스트·작업)라 자료함이 아니라 **프로젝트 탭의 미러**로 들어온다 — 문구가 그것을 말해야 한다.
  scopeKeys: ["include_list_ids", "exclude_list_ids"],
  outcome: "작업·댓글·시간기록이 프로젝트 탭의 미러로 들어온다(자료함이 아니다 — 구조 엔티티는 output_mode 로 못 바꾼다).",
});

export const githubCollectCapabilities = makeMemberTokenCollect({
  system: "github", preset: "github", instance: MEMBER_INSTANCE, credKind: GITHUB_TOKEN_KIND, credAnyScope: true, appLabel: "GitHub",
  label: "GitHub — 고른 저장소의 이슈·PR",
  note: "[GitHub 모아 두기] 토글로 만들어진 수집기 — 켠 사람의 GitHub 연결로 고른 저장소의 이슈·PR 대화와 릴리스를 모읍니다(#2247). 토큰 칸은 비워 두세요.",
  connectHint: "[외부 앱 연결 ▸ GitHub]에서 계정을 연결하거나 토큰을 저장하세요",
  scopeKeys: ["repos"], requireScope: true,
  scopeHint: "모을 저장소(owner/repo)를 하나는 넣어 주세요 — [GitHub 연결] 화면에서 저장소를 골랐다면 그게 기본값이 됩니다.",
  // [GitHub 연결]의 저장소 고르기가 곧 범위 — 설치에 열린 저장소를 기본값으로(그 화면이 없는 PAT 연결은 손으로 넣는다).
  defaultScope: async (): Promise<Record<string, string>> => { const open = await listInstallationRepos(); return open?.length ? { repos: open.join(" ") } : {}; },
  outcome: "이슈·PR 본문과 댓글, 릴리스 노트가 자료함에 들어오고, 이슈·PR 증류기가 꺼진 채로 함께 준비된다.",
  onEnabled: async ({ actor, source }) => { await ensureGithubIssuesDistiller({ actor, source: `collect-toggle:${source}` }); },
});

export const gitlabCollectCapabilities = makeMemberTokenCollect({
  system: "gitlab", preset: "gitlab", instance: MEMBER_INSTANCE, credKind: GITLAB_TOKEN_KIND, credAnyScope: true, appLabel: "GitLab",
  label: "GitLab — 고른 프로젝트의 이슈·MR",
  note: "[GitLab 모아 두기] 토글로 만들어진 수집기 — 켠 사람의 개인 토큰(read_api)으로 고른 프로젝트의 이슈·MR 대화와 릴리스를 모읍니다(#2247). 토큰 칸은 비워 두세요.",
  connectHint: "[외부 앱 연결 ▸ GitLab]에서 개인 액세스 토큰(read_api)을 저장하세요 — 계정 로그인 토큰으로는 GitLab 이 자료 읽기를 막습니다",
  scopeKeys: ["projects"], requireScope: true,
  scopeHint: "모을 프로젝트 경로(group/project)를 하나는 넣어 주세요 — GitLab 주소를 그대로 붙여넣어도 됩니다.",
  // 호스트는 그 사람 토큰의 scope_key(회사 GitLab)를 따른다 — 두 번 적게 하지 않는다.
  extraConfig: async (actor): Promise<Record<string, string>> => {
    const rows = await listMemberSecretsPublic(memberOwner(actor)).catch(() => []);
    const slot = pickGitlabSlot(rows, undefined);
    return { host: (slot?.scope_key || "gitlab.com").toLowerCase() };
  },
  outcome: "이슈·MR 본문과 노트, 릴리스 노트가 자료함에 들어오고, 코드 호스트 이슈 증류기가 꺼진 채로 함께 준비된다.",
  onEnabled: async ({ actor, source }) => { await ensureGithubIssuesDistiller({ actor, source: `collect-toggle:${source}` }); },
});

export const memberCollectAppCapabilities = [...figmaCollectCapabilities, ...clickupCollectCapabilities, ...githubCollectCapabilities, ...gitlabCollectCapabilities];
