// 현재 로그인 신원(whoami, #1072) — "지금 이 세션에서 라이블리를 호출하는 사람은 누구인가"의 단일 창구.
//  계기: 하네스에 주입되는 조직 맥락에는 사람의 **식별자**가 없었다(개인 규칙·호칭뿐). 그래서 AI 는 "내가 맡은 프로젝트"
//   같은 요청에서 project_list_v6 {mine:true} 나 assignee 에 쓸 member_id 를 몰라 추측하거나 사람에게 되물어야 했다.
//  기존 me(index.ts)를 그대로 MCP 에 여는 길은 막혀 있다 — me 응답엔 avatar(base64 data URL 이미지)가 들어 있어
//   하네스 컨텍스트에 수십~수백 KB 이미지가 실린다. 그래서 별도 capability 로 분리하고 여기선 **텍스트 식별자만** 반환한다
//   (아바타·개인 규칙 본문 등 표시용·대용량 필드 제외). 웹 게이트(me)는 지금 형태 그대로 둔다.
//  scope=null(인증만) — 남의 신원은 절대 반환하지 않는다(principal = bearer 토큰 주체로 고정, 입력 인자 없음).
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { getMember, getOrgProfile } from "../org/store.js";
import { memberTeams, memberCategories } from "../v6/team-store.js";

const whoami: Capability = {
  name: "whoami",
  title: "나는 누구인가(현재 로그인 신원)",
  description:
    "지금 이 세션이 라이블리에 접속한 신원을 반환한다(whoami — 현재 로그인한 사람이 누구인지). " +
    "member_id·표시이름·닉네임·이메일·권한(scopes)·소속 팀·우리 팀 카테고리·외부 시스템 계정(클릭업·슬랙·깃랩 등 external_id) " +
    "+ 이 요청의 하네스(AI)·터미널 세션·실행 모드. " +
    "⭐ member_id 가 라이블리 전 표면의 사람 축 키다 — 내가 맡은 프로젝트는 project_list_v6 {mine:true}, " +
    "태스크 담당자(assignee)·프로젝트 팀원(project_set_members_v6)·작업 기록(activity_log)의 사람도 전부 이 값. " +
    "'내가 누구지 / 내 프로젝트 뭐지 / 나한테 할당된 거' 류 요청은 이름을 추측하지 말고 여기서 시작한다. 남의 신원은 조회되지 않는다(인자 없음).",
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
    const [member, teams, cats, org] = await Promise.all([
      getMember(memberId).catch(() => null),
      memberTeams(memberId).catch(() => []),
      memberCategories(memberId).catch(() => []),
      getOrgProfile().catch(() => null),
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
      org: org ? { name: org.display_name ?? org.name ?? null, timezone: org.timezone ?? null } : null,
    };
  },
};

export const whoamiCapabilities: Capability[] = [whoami];
