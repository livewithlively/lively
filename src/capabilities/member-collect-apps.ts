// 토글 하나로 켜지는 «모아 두기» 앱 표(#2247) — 피그마·ClickUp. 슬랙·노션·구글은 각자 파일(OAuth 동의·봇 등 앱 고유 흐름).
//  새 앱을 붙일 때: ① CONNECTOR_SPECS 에 token_source 필드 ② config.ts 에 해소 훅 ③ 여기 표 한 줄 ④ 웹 카드.
import { makeMemberTokenCollect } from "./member-collect.js";
import { ensureFigmaCommentsDistiller } from "../org/distill/figma-preset.js";
import { FIGMA_TOKEN_KIND } from "../org/credentials/figma-token-source.js";
import { CLICKUP_TOKEN_KIND } from "../org/credentials/plain-token-source.js";
import { GITHUB_TOKEN_KIND } from "../org/credentials/github-token-source.js";
import { ensureGithubIssuesDistiller } from "../org/distill/github-preset.js";
import { GITLAB_TOKEN_KIND, pickGitlabSlot } from "../org/credentials/gitlab-token-source.js";
import { listMemberSecretsPublic, memberOwner } from "../org/credentials/member-secret-store.js";
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { LINEAR_APP_KIND } from "../org/credentials/linear-oauth.js";
import { startLinearAppConsent, completeLinearAppInstall, linearAppReady } from "../org/credentials/oauth-broker.js";
import { collectScopeOptions, scopeOptionsSupported } from "../org/collect-scope-options.js";

/** 토글이 만드는 인스턴스 키 — 관리탭에서 손으로 만든 것('_' 등)과 겹치지 않게 고정 이름. */
export const MEMBER_INSTANCE = "lively-member";

export const figmaCollectCapabilities = makeMemberTokenCollect({
  system: "figma", preset: "figma", instance: MEMBER_INSTANCE, credKind: FIGMA_TOKEN_KIND, appLabel: "Figma",
  label: "Figma — 내 파일의 코멘트",
  note: "[Figma 자료 가져오기] 토글로 만들어진 가져오기 — 켠 사람의 Figma 토큰으로 고른 파일의 코멘트를 모읍니다(#2247). 토큰 칸은 비워 두세요.",
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
  note: "[ClickUp 자료 가져오기] 토글로 만들어진 가져오기 — 켠 사람의 ClickUp 토큰으로 워크스페이스의 작업·댓글을 가져옵니다(#2247). API Token 칸은 비워 두세요.",
  connectHint: "[외부 앱 연결 ▸ ClickUp]에서 API 토큰을 저장하세요",
  // ClickUp 은 구조 엔티티(스페이스·리스트·작업)라 자료함이 아니라 **프로젝트 탭의 미러**로 들어온다 — 문구가 그것을 말해야 한다.
  scopeKeys: ["include_list_ids", "exclude_list_ids"],
  outcome: "작업·댓글·시간기록이 프로젝트 탭의 미러로 들어온다(자료함이 아니다 — 구조 엔티티는 output_mode 로 못 바꾼다).",
});

export const githubCollectCapabilities = makeMemberTokenCollect({
  system: "github", preset: "github", instance: MEMBER_INSTANCE, credKind: GITHUB_TOKEN_KIND, credAnyScope: true, appLabel: "GitHub",
  label: "GitHub — 내 저장소의 이슈·PR",
  note: "[GitHub 자료 가져오기] 토글로 만들어진 가져오기 — 켠 사람의 GitHub 연결로 고른 저장소의 이슈·PR 대화와 릴리스를 모읍니다(#2247). 토큰 칸은 비워 두세요.",
  connectHint: "[외부 앱 연결 ▸ GitHub]에서 계정을 연결하거나 토큰을 저장하세요",
  //  #2232 — requireScope 를 걷었다: 범위가 비면 커넥터가 «이 토큰이 보는 전부»를 열거한다(비공개 포함).
  //  고르기는 옵션이다 — 화면은 org_collect_scope_options 목록으로 좁히기를 «원하는 사람에게만» 보여 준다.
  scopeKeys: ["repos"],
  //  #2243 3차 — 사람이 정하는 «무엇을·언제부터». 범위(repos)와 달리 비어 있어도 켜진다(커넥터 기본값 = 전부 켬).
  optionKeys: ["include_prs", "include_releases", "backfill_since"],
  scopeHint: "비워 두면 이 연결이 볼 수 있는 저장소 전부를 가져옵니다 — 좁히려면 owner/repo 를 넣으세요.",
  //  #2232 — defaultScope(설치에 열린 저장소로 자동 채움)를 걷었다: «비면 전체»가 기본이 된 뒤로 이 자동 채움은
  //  오히려 범위를 몰래 좁히는 손이 된다(조직 설치의 선택이 개인 PAT 수집을 제한할 이유가 없다). 좁히기는 사람이 목록에서 한다.
  outcome: "이슈·PR 본문과 댓글, 릴리스 노트가 자료함에 들어오고, 이슈·PR 증류기가 꺼진 채로 함께 준비된다.",
  onEnabled: async ({ actor, source }) => { await ensureGithubIssuesDistiller({ actor, source: `collect-toggle:${source}` }); },
});

export const gitlabCollectCapabilities = makeMemberTokenCollect({
  system: "gitlab", preset: "gitlab", instance: MEMBER_INSTANCE, credKind: GITLAB_TOKEN_KIND, credAnyScope: true, appLabel: "GitLab",
  label: "GitLab — 내 프로젝트의 이슈·MR",
  note: "[GitLab 자료 가져오기] 토글로 만들어진 가져오기 — 켠 사람의 개인 토큰(read_api)으로 고른 프로젝트의 이슈·MR 대화와 릴리스를 모읍니다(#2247). 토큰 칸은 비워 두세요.",
  connectHint: "[외부 앱 연결 ▸ GitLab]에서 개인 액세스 토큰(read_api)을 저장하세요 — 계정 로그인 토큰으로는 GitLab 이 자료 읽기를 막습니다",
  scopeKeys: ["projects"],   // #2232 — github 와 같은 결정: 비면 전체(membership=true 열거)
  optionKeys: ["include_mrs", "include_releases", "backfill_since"],
  scopeHint: "비워 두면 내 계정이 구성원인 프로젝트 전부를 가져옵니다 — 좁히려면 group/project 를 넣으세요(주소 그대로도 됩니다).",
  // 호스트는 그 사람 토큰의 scope_key(회사 GitLab)를 따른다 — 두 번 적게 하지 않는다.
  extraConfig: async (actor): Promise<Record<string, string>> => {
    const rows = await listMemberSecretsPublic(memberOwner(actor)).catch(() => []);
    const slot = pickGitlabSlot(rows, undefined);
    return { host: (slot?.scope_key || "gitlab.com").toLowerCase() };
  },
  outcome: "이슈·MR 본문과 노트, 릴리스 노트가 자료함에 들어오고, 코드 호스트 이슈 증류기가 꺼진 채로 함께 준비된다.",
  onEnabled: async ({ actor, source }) => { await ensureGithubIssuesDistiller({ actor, source: `collect-toggle:${source}` }); },
});

export const linearCollectCapabilities = makeMemberTokenCollect({
  system: "linear", preset: "linear", instance: MEMBER_INSTANCE, credKind: LINEAR_APP_KIND, appLabel: "Linear",
  label: "Linear — 워크스페이스 이슈·문서",
  note: "[Linear 자료 가져오기] 토글로 만들어진 수집기 — 켠 사람의 라이블리 Linear 앱 연결로 이슈·댓글·문서를 모읍니다(#2247). 토큰 칸은 비워 두세요.",
  connectHint: "[외부 앱 연결 ▸ Linear ▸ 자료 가져오기]를 켜서 Linear 화면에서 [허용]하세요",
  scopeKeys: ["teams"],
  optionKeys: ["include_documents", "backfill_since"],
  outcome: "이슈·댓글·문서가 자료함에 들어오고, 이슈 대화 증류기가 꺼진 채로 함께 준비된다. 자격이 없으면 needs_connect 와 함께 Linear 동의 URL 을 준다(토글이 곧 연결).",
  connectStart: async (actor) => { const c = await startLinearAppConsent(actor); return { authorization_url: c.authorizationUrl ?? "" }; },
  // 라이블리 Linear 앱(client id/secret)이 아직 없으면 화면이 «앱 등록 칸»을 먼저 보여 준다 — 그게 없으면 [허용] 화면조차 못 연다.
  extraState: async () => ({ app_ready: await linearAppReady() }),
  onEnabled: async ({ actor, source }) => { await ensureGithubIssuesDistiller({ actor, source: "collect-toggle:" + source }); },
});

// Linear 동의 시작(재연결·토큰 교체) + 매니지드 릴레이 완료 — 노션·구글의 connect/oauth_complete 와 같은 모양.
const orgLinearCollectConnect: Capability = {
  name: "org_linear_collect_connect", title: "Linear 연결(라이블리 앱 동의) 시작",
  description: "라이블리 Linear 앱 동의를 시작한다(admin) — 반환된 authorization_url 을 열어 [허용]하면 내 금고(linear_app)에 저장되고, org_linear_collect_set 으로 켜면 그 연결로 수집기가 돈다. 이미 연결돼 있어도 다시 동의할 수 있다(토큰 교체).",
  scope: "admin", input: {},
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/linear/collect/connect"], parse: () => ({}) }] },
  handler: async (_input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    try {
      const c = await startLinearAppConsent(user.userId);
      return { ok: true, authorization_url: c.authorizationUrl, ready: await linearAppReady(), message: "이 URL 의 Linear 화면에서 [허용]하세요 — 완료되면 자동으로 저장됩니다." };
    } catch (err) { throw new HttpError(409, (err as Error).message); }
  },
};
const orgLinearOauthComplete: Capability = {
  name: "org_linear_oauth_complete", title: "Linear OAuth 릴레이 완료(CP 전용)",
  description: "라이블리 컨트롤플레인이 Linear 와 교환한 토큰 응답을 이 게이트웨이의 서명 state 와 함께 넣는다. 연결자의 금고 슬롯(linear_app)에 저장한다. 사람이 직접 부를 일은 없다.",
  scope: "admin",
  input: { state: z.string().describe("이 게이트웨이가 발급한 서명 state"), token: z.record(z.unknown()).describe("Linear 토큰 엔드포인트 응답 JSON 원문") },
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/org/linear/oauth-complete"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user) => {
    const i = (input ?? {}) as { state?: unknown; token?: unknown };
    if (typeof i.state !== "string" || !i.state) throw new HttpError(400, "state 는 필수입니다");
    if (!i.token || typeof i.token !== "object") throw new HttpError(400, "token(Linear 응답)은 필수입니다");
    try { const r = await completeLinearAppInstall(i.state, i.token, user?.userId ?? "cp-relay"); return { ok: true, member: r.memberId }; }
    catch (err) { throw new HttpError(400, (err as Error).message); }
  },
};

// 범위 선택지(#2243) — «외부 앱에 들어가지 않고» 우리 화면에서 토글로 고르게 하는 목록.
//  그 사람의 자격으로 조회하고, 실패는 freeform 으로 떨어뜨린다(막다른 길 금지 — collect-scope-options.ts 머리말).
const orgCollectScopeOptions: Capability = {
  name: "org_collect_scope_options", title: "가져올 자료 범위 선택지 조회",
  description:
    "그 앱에서 «고를 수 있는 것»(저장소·프로젝트·팀·파일·리스트·채널)을 **호출자 본인의 연결**로 조회한다 — 화면이 토글 목록으로 그린다. " +
    "지원: github(저장소) · gitlab(프로젝트) · linear(팀) · figma(파일, 팀 id 를 넣은 경우) · clickup(리스트) · slack(공개 채널). " +
    "읽기 전용이고 권한을 넓히지 않는다. 목록을 못 만들면 에러가 아니라 freeform=true + note 로 답한다(화면은 텍스트 입력으로 떨어진다).",
  scope: "admin",
  //  #923 — REST 는 :system 경로 파라미터로 싣지만, 스키마에 안 적으면 zod 가 strip 해 MCP 로는 부를 수 없다.
  input: {
    system: z.enum(["github", "gitlab", "linear", "figma", "clickup", "slack"]).describe("어느 앱의 «고를 수 있는 것»을 볼지"),
    //  #2232 — 피그마 전용: 팀 주소를 저장하기 «전에» 그 팀의 파일 목록을 미리 보려면 팀 id 를 실어 보낸다.
    team_id: z.string().optional().describe("figma 전용 — 이 팀의 파일을 나열(저장 전 미리보기)"),
  },
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/org/:system/collect/options"], parse: (req) => ({
    system: String((req.params as Record<string, string>)?.system ?? ""),
    team_id: String((req.query as Record<string, unknown>)?.team_id ?? "") || undefined,
  }) }] },
  handler: async (input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const i = input as { system?: unknown; team_id?: unknown };
    const system = String(i?.system ?? "").toLowerCase();
    if (!scopeOptionsSupported(system)) throw new HttpError(404, `'${system}' 은 범위 목록 조회를 지원하지 않습니다`);
    return collectScopeOptions(system, user.userId, typeof i?.team_id === "string" ? i.team_id : undefined);
  },
};

export const memberCollectAppCapabilities = [...figmaCollectCapabilities, ...clickupCollectCapabilities, ...githubCollectCapabilities, ...gitlabCollectCapabilities, ...linearCollectCapabilities, orgLinearCollectConnect, orgLinearOauthComplete, orgCollectScopeOptions];
