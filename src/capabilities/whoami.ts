// 현재 로그인 신원(whoami, #1072) — "지금 이 세션에서 라이블리를 호출하는 사람은 누구인가"의 단일 창구.
//  계기: 하네스에 주입되는 조직 맥락에는 사람의 **식별자**가 없었다(개인 규칙·호칭뿐). 그래서 AI 는 "내가 맡은 프로젝트"
//   같은 요청에서 project_list_v6 {mine:true} 나 assignee 에 쓸 member_id 를 몰라 추측하거나 사람에게 되물어야 했다.
//  기존 me(index.ts)를 그대로 MCP 에 여는 길은 막혀 있다 — me 응답엔 avatar(base64 data URL 이미지)가 들어 있어
//   하네스 컨텍스트에 수십~수백 KB 이미지가 실린다. 그래서 별도 capability 로 분리하고 여기선 **텍스트 식별자만** 반환한다
//   (아바타·개인 규칙 본문 등 표시용·대용량 필드 제외). 웹 게이트(me)는 지금 형태 그대로 둔다.
//  scope=null(인증만) — 남의 신원은 절대 반환하지 않는다(principal = bearer 토큰 주체로 고정, 입력 인자 없음).
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "./rest-util.js";
import { getMember, getOrgProfile } from "../org/store.js";
import { gatewayUrl } from "../gateway-url.js";
import { memberTeams, memberCategories, memberCategoryIds } from "../v6/team-store.js";
import { visAxes } from "../v6/visibility-axes.js";

// ── me — 토큰 게이트 확인(스코프 불요, REST 전용). 핸들러가 partial user 에서 null-default 구성. ──
//  ⚠ MCP 로 열지 않는다(expose.mcp:false 유지) — 응답의 avatar 가 base64 data URL 이미지라 하네스 컨텍스트를 잡아먹는다.
//   하네스용 신원 창구는 아래 whoami(#1072) — 같은 사람 축을 텍스트 식별자만으로 반환한다.
//  (#1313 R25: 조립자 index.ts 에 인라인으로 있던 정의를 같은 신원 축인 여기로 옮겼다 — 등록 순서는 불변.)
const me: Capability = {
  name: "me",
  title: "인증 확인",
  description: "bearer 토큰의 principal 확인 — {userId, email, scopes}. 웹 토큰 게이트 전용.",
  scope: null,
  input: {},
  expose: { mcp: false, rest: [{ method: "GET", paths: ["/api/ui/me"], parse: () => ({}) }] },
  handler: async (_input, user, ctx) => {
    const u = (user ?? {}) as Partial<LivelyUser>;
    const memberId = u.userId ?? "";
    // 소속 팀 + '우리 팀' 카테고리 id(소유 ∪ 이해관계) — 프론트 사이드바 '우리 팀' 우선노출의 단일 소스.
    //  실패해도 게이트 확인은 막지 않는다(팀 미설정/스키마 초기 등 — 빈 배열 폴백).
    const [teams, cats, member, org] = memberId
      ? await Promise.all([
          memberTeams(memberId).catch(() => []),
          memberCategoryIds(memberId).catch(() => ({ all: [], owner: [] })),
          getMember(memberId).catch(() => null), // 표시 이름 — 우측 상단 '내 프로필' 라벨(이메일보다 우선)
          getOrgProfile().catch(() => null),     // 상단 워드마크 태그라인('for <조직명>') — 미설정이면 태그라인 자체를 숨긴다
        ])
      : [[], { all: [], owner: [] }, null, null];
    return {
      userId: u.userId ?? null, email: u.email ?? null, scopes: u.scopes ?? [],
      display_name: member?.display_name ?? null,
      // 조직 표시명 — 상단 로고 옆 'for <조직명>'. 관리탭 [조직 정보] 미설정이면 null 이고 프론트는 태그라인을 렌더하지 않는다.
      org_name: org?.display_name ?? org?.name ?? null,
      avatar: member?.avatar ?? null, // 우측 상단 '내 프로필' 아바타(없으면 이니셜+색상 폴백)
      avatar_char: member?.avatar_char ?? null, avatar_color: member?.avatar_color ?? null, // 이미지 없을 때 커스텀 글자/배경색

      teams: teams.map((t) => ({ id: t.id, key: t.key, name: t.name })),
      team_category_ids: cats.all, team_owner_category_ids: cats.owner,
      // 실행 모드(#1007+) — 이 요청이 어느 모드로 게이트되는가(단일 x-lively-mode 헤더 파생, 어댑터가 ctx 에 주입).
      //  웹/AI 가 '모드가 실제로 켜졌는지' 확인하는 관측 지점. read_only 는 하위호환 유지.
      mode: ctx?.incognito ? "incognito" : ctx?.readOnly ? "readonly" : "normal",
      read_only: ctx?.readOnly ?? false,
      // 맥락 공개범위 축(#1291) — **화면이 설정 UI 를 그릴지 말지 판단하는 근거.** 꺼진 축의 폼·자물쇠를
      //  계속 그리면 "설정했는데 안 걸린다" / "자물쇠가 붙었는데 전원이 본다"가 된다(둘 다 화면이 거짓말하는 것).
      //  모든 화면이 부팅 때 me 를 부르므로 여기 실어 보내면 축마다 별도 조회가 필요 없다.
      vis_axes: await visAxes().catch(() => null),
      incognito: ctx?.incognito ?? false,
    };
  },
};

const whoami: Capability = {
  name: "whoami",
  title: "나는 누구인가(현재 로그인 신원)",
  description:
    "지금 이 세션이 라이블리에 접속한 신원을 반환한다(whoami — 현재 로그인한 사람이 누구인지). " +
    "member_id·표시이름·닉네임·이메일·권한(scopes)·소속 팀·우리 팀 카테고리·외부 시스템 계정(클릭업·슬랙·깃랩 등 external_id) " +
    "+ 이 요청의 하네스(AI)·터미널 세션·실행 모드. " +
    "⭐ member_id 가 라이블리 전 표면의 사람 축 키다 — 내가 맡은 프로젝트는 project_list_v6 {mine:true}, " +
    "태스크 담당자(assignee)·프로젝트 팀원(project_set_members_v6)·작업 기록(activity_log)의 사람도 전부 이 값. " +
    "'내가 누구지 / 내 프로젝트 뭐지 / 나한테 할당된 거' 류 요청은 이름을 추측하지 말고 여기서 시작한다. 남의 신원은 조회되지 않는다(인자 없음). " +
    "⭐ org.gateway_url 은 **사람에게 링크를 줄 때 붙일 절대 base** 다 — 상대경로를 그 앞에 붙여 곧바로 클릭되는 주소로 만든다" +
    "(화면 `<base>/ui/#/projects/123` · 미리보기 `<base>/preview/<id>/ui/`). 상대경로만 적어 보내지 마라(사람이 못 누른다).",
  scope: null,
  input: {},
  // 회수 진입점 — 세션 첫 동작에서 신원을 물을 수 있어야 하므로 deferred 금지(입력 스키마가 빈 객체라 상시 로드 비용도 최소).
  meta: { "anthropic/alwaysLoad": true },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/me/whoami"], parse: () => ({}) }],
  },
  handler: async (_input, user, ctx) => {
    const memberId = user?.userId ?? "";
    if (!memberId) throw new HttpError(401, "인증이 필요합니다");
    // 신원 보강은 전부 fail-open — 조회가 실패해도 "너는 누구다"(토큰 principal)는 반드시 답한다.
    const [member, teams, cats, org, gwUrl] = await Promise.all([
      getMember(memberId).catch(() => null),
      memberTeams(memberId).catch(() => []),
      memberCategories(memberId).catch(() => []),
      getOrgProfile().catch(() => null),
      gatewayUrl().catch(() => null),
    ]);
    const scopes = Array.isArray(user?.scopes) ? user.scopes : [];
    const cat = (c: { category_id: number; space: string; key: string; name: string | null }) =>
      ({ id: Number(c.category_id), space: c.space, key: c.key, name: c.name });
    return {
      // ── 사람 축 식별자 ── (member_id = org_member.id. lively 전 표면의 조인 키)
      member_id: memberId,
      display_name: member?.display_name ?? null,
      nickname: member?.nickname ?? null,
      email: member?.email ?? user?.email ?? null,
      kind: member?.kind ?? null,       // human | agent | system
      state: member?.state ?? null,     // active | inactive
      // 토큰 principal 이 org_member 에 없는 경우(정적 토큰 등) false — 이때 이름·팀은 전부 null/빈 배열이다.
      registered: !!member,
      // ── 권한 ── scopes = 이 요청 토큰의 **실효** 권한(멤버 정의와 교집합일 수 있다 — 다르면 member_scopes 와 대조).
      scopes,
      is_admin: scopes.includes("admin"),
      member_scopes: member?.scopes ?? null,
      // ── 외부 시스템에서 나를 가리키는 키(클릭업 assignee·슬랙 user·깃랩 계정 …) ──
      identities: (member?.identities ?? []).map((i) => ({
        system: i.system, instance: i.instance ?? null, external_id: i.external_id,
        email: i.email ?? null, display_name: i.display_name ?? null,
      })),
      // ── 소속(오너십은 우선순위 신호일 뿐 접근제한이 아니다 — 다른 팀 맥락도 열람·검색 가능) ──
      teams: teams.map((t) => ({ id: t.id, key: t.key, name: t.name })),
      categories: {
        owner: cats.filter((c) => c.owner).map(cat),
        stakeholder: cats.filter((c) => !c.owner).map(cat),
      },
      // ── 이 요청의 접속 신원(게이트웨이가 헤더에서 본 것이 권위 — 자기보고 아님) ──
      session: {
        harness: ctx?.agent ?? null,        // x-lively-harness / User-Agent → claude-code·codex …(#182)
        session_id: ctx?.session ?? null,   // x-lively-session → box-<slug>-<8hex>(#852). 세션 밖이면 null
        mode: ctx?.incognito ? "incognito" : ctx?.readOnly ? "readonly" : "normal", // #1007
        channel: ctx?.source ?? null,       // mcp | web
        token_source: user?.tokenSource ?? null, // static(회수불가) | db | session
      },
      // ── 이 게이트웨이 ── org 프로필이 없어도(등록 전) gateway_url 은 PUBLIC_URL 로 잡힐 수 있어 따로 판단한다.
      org: (org || gwUrl) ? {
        name: org?.display_name ?? org?.name ?? null,
        timezone: org?.timezone ?? null,
        // 사람에게 줄 링크의 **절대 base**(#1169). 상대경로를 이 앞에 붙여 곧바로 클릭되는 주소로 만든다 —
        //  화면은 `<base>/ui/#/projects/123`, 미리보기는 `<base>/preview/<id>/ui/`.
        //  값의 권위는 관리탭 [조직 정보]의 게이트웨이 주소 > PUBLIC_URL(gateway-url.ts). 미설정이면 null.
        gateway_url: gwUrl,
      } : null,
    };
  },
};

// ⚠ 배열 2개로 나눠 내보낸다 — index.ts 의 등록 순서(me → whoami → …)가 tools/list·REST 마운트 순이자
//  표면 스냅샷이라, 한 배열로 합치면 조립자가 그 자리를 표현할 수 없다.
export const meCapabilities: Capability[] = [me];
export const whoamiCapabilities: Capability[] = [whoami];
