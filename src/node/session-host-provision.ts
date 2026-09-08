// 매니지드 세션 호스트의 **자격을 게이트웨이가 스스로 만든다** (#2600 T2 (d) d5)
//
// ── 왜 이 모듈이 있나 ───────────────────────────────────────────────────────
// d4 는 카나리아 테넌트 한 곳에 세션 호스트를 **수기 5단계**로 세웠다(노드 등록 → 토큰 발급 →
//  번들 → env → 유닛). 노드는 ASG 가 소유하고(빈 노드는 종료·준비 실패는 교체·테넌트는 통합으로
//  옮겨 다닌다) **노드에 손으로 심은 것은 그 노드와 함께 사라진다** — 실측(2026-09-08)에서 `nodes`
//  3행 중 2행이 48시간 안에 생겼다. 그래서 그 다섯 단계가 제품 경로로 와야 한다.
//
// 그중 **토큰만은 브로커가 만들 수 없다.** 노드 인증은 평문 `lvk_…` 의 해시가 `auth_token` 행과
//  맞고 그 토큰이 노드 등록 발급물이어야 하는데(store.authNodeTokenDetailed · #2215), 브로커는
//  **일부러 DB 자격이 없다**(#1437 D안 — 노드 한 대가 털렸을 때 전 테넌트 컨트롤플레인으로 번지는
//  경로를 안 만든다). 그래서 «게이트웨이가 자기 세션 호스트를 등록·발급한다»가 이 모듈이다.
//  DB 는 이미 게이트웨이 것이고, 「정책=게이트웨이, 실행=노드」 축과 같은 방향이다.
//
// ── ★ 자격의 주인은 **시스템 구성원**이다 (대표 판정 2026-09-08) ───────────
// 오늘 카나리아의 `sesshost-46e3` 소유자는 사람(윤상민)이다. 노드 인증은 매번
//  `org_member.state='active'` 를 확인하고 아니면 `owner-inactive` 로 거절한다 — 즉 **그 사람이
//  비활성되면 그 테넌트 세션이 안 붙는다.** 오늘은 게이트웨이 인프로세스 폴백이 받아 주지만
//  #2608 이 그 폴백을 걷기로 확정했다. 그리고 이 경로는 그 모양을 **모든 신규 테넌트에 복제**하므로,
//  고객사마다 «프로비저닝 당시 관리자였던 직원»에게 세션 호스트가 매달리게 된다.
//  ⇒ 테넌트마다 `kind='system'` 구성원 하나를 두고 **그 명의로** 발급한다. 새 개념이 아니다 —
//   스키마에 `org_member_kind_chk: kind IN ('human','agent','system')` 가 이미 있고, 이 테넌트에서
//   `notion-docs-sync` 가 그 종류로 돈다. 사람 목록·멘션·폴더 ACL 은 이미 `kind==='system'` 을
//   건너뛴다(terminal/routes.ts 188·344 · v6/folder-acl-sync.ts 35).
//
// ⚠ 평문 토큰은 **발급 응답 1회성**이다. 로그·태스크·지식 어디에도 남기지 않는다.
import { getMember, upsertMember } from "../org/store/members.js";   // #2165 — 배럴 대신 좁은 모듈(노드 번들 경계)
import { createNode, listNodes, rotateNodeToken, setNodeOwnerAndSessionHost, type OrgNode } from "./store.js";
import { logger } from "../log.js";

/** 세션 호스트 자격의 주인 — 테넌트마다 하나. 사람 계정에 묶지 않는다(머리말 ★). */
export const SESSION_HOST_MEMBER_ID = "session-host";
export const SESSION_HOST_MEMBER_NAME = "세션 호스트";

/** 노드 id 접두 — `sesshost-<slug>`. 이 규칙이 «그 테넌트의 세션 호스트가 어느 행인가»의 유일한 답이다. */
export const SESSION_HOST_NODE_PREFIX = "sesshost-";
/** store.normalizeNodeId 의 상한(2~41자)과 같은 값 — 여기서 먼저 걸러 400 대신 «못 한다»를 말한다. */
const NODE_ID_MAX = 41;

/**
 * 이 테넌트의 세션 호스트 노드 id(순수). 만들 수 없으면 **null** — 지어내지 않는다.
 *
 * ★ 잘라서 만들지 않는다: 자른 이름은 다른 테넌트와 충돌할 수 있고, 그러면 두 테넌트가 같은 노드
 *  행(=같은 토큰)을 쓰게 된다. 격리가 조용히 사라지는 부류라 «못 한다»가 맞는 답이다.
 *  (실제로는 노드 박스의 OS 계정 이름이 `lvlyt-<slug>` 를 32자로 자르므로 slug 는 26자 이하다 —
 *   그 아래에서 이 함수가 null 을 줄 일은 없다. 그래도 가정에 기대지 않고 여기서 막는다.)
 */
export function sessionHostNodeId(slug: string): string | null {
  const s = (slug || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(s)) return null;
  const id = `${SESSION_HOST_NODE_PREFIX}${s}`;
  return id.length <= NODE_ID_MAX ? id : null;
}

/** 후보를 고르기 위해 필요한 최소한의 노드 모양 — 시험이 전체 행을 지어내지 않게 좁혀 둔다. */
export interface SessionHostCandidate {
  id: string;
  session_host: boolean;
  created_at: string;
}

/**
 * 이 테넌트의 세션 호스트 등록을 **찾는다**(순수). 없으면 null → 호출부가 정규 id 로 만든다.
 *
 * ── 왜 이름으로 안 찾고 «선언» 으로 찾나 ────────────────────────────────────
 * d4 가 수기로 세운 카나리아 노드 이름은 `sesshost-46e3` 인데, 슬러그에서 유도하면
 *  `sesshost-lively-46e3` 이다 — 이름으로만 찾으면 **같은 테넌트에 세션 호스트가 둘**이 된다.
 *  둘이 동시에 온라인이면 두 스냅샷이 같은 세션을 주장하고, 그때 목록·attach 라우팅이 갈린다
 *  (대표 워크스페이스에서 그 일이 나면 그게 곧 장애다).
 * 「이 테넌트의 세션 호스트는 하나」는 **선언 컬럼**(`session_host`, admin 만 켠다)이 이미 표현하고
 *  있으므로, 그 선언을 찾아 **물려받는다**(주인만 시스템 구성원으로 옮긴다). 그러면 수기 설치가
 *  자동 경로로 **넘어가지 대체되지 않는다** — 고아가 안 생긴다.
 *
 * ⚠ 둘 이상이면 «아무거나» 고르지 않는다: 정규 id 가 있으면 그것, 없으면 **가장 먼저 만들어진 것**.
 *  결정론이 필요한 이유는 노드마다·틱마다 다른 답을 고르면 토큰이 서로를 회전시켜 죽이기 때문이다.
 */
export function pickSessionHostNode<T extends SessionHostCandidate>(nodes: readonly T[], slug: string): T | null {
  const declared = nodes.filter((n) => n.session_host);
  if (!declared.length) return null;
  if (declared.length === 1) return declared[0]!;
  const canonical = sessionHostNodeId(slug);
  const exact = canonical ? declared.find((n) => n.id === canonical) : undefined;
  if (exact) return exact;
  return [...declared].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.id < b.id ? -1 : 1)))[0]!;
}

/** 노드 등록 행에 대해 지금 할 일(순수 — 유닛테스트 대상). */
export type SessionHostNodeAction = "create" | "fix-and-rotate" | "rotate" | "keep";

/**
 * 등록 행을 어떻게 할 것인가(순수).
 *
 * ── 왜 `issue` 가 갈림길인가 ────────────────────────────────────────────────
 * 회전은 **구 토큰을 그 자리에서 죽인다.** 브로커가 «지금 도는 세션 호스트가 있고 토큰도 있다»고
 *  말하는데 회전하면, 그 순간 그 호스트가 인증을 잃는다. 그래서 회전은 **브로커가 토큰이 없다고
 *  말할 때만**(issue=true) 한다 — 조회(issue=false)는 아무것도 바꾸지 않는다.
 *
 * ── `enabled=false` 는 고치지 않는다 ────────────────────────────────────────
 * 그건 사람이 그 테넌트의 세션 호스트를 **끈** 것이다(운영 킬스위치). 조정 루프가 되켜면
 *  끄는 방법이 없어진다. 사실만 돌려주고 브로커가 안 띄운다.
 */
export function decideSessionHostNode(o: {
  existing: { owner_member: string; session_host: boolean } | null;
  issue: boolean;
}): SessionHostNodeAction {
  if (!o.existing) return "create";
  const misowned = o.existing.owner_member !== SESSION_HOST_MEMBER_ID || !o.existing.session_host;
  if (!o.issue) return "keep";
  return misowned ? "fix-and-rotate" : "rotate";
}

export interface SessionHostEnsureResult {
  nodeId: string;
  owner: string;
  enabled: boolean;
  sessionHost: boolean;
  action: SessionHostNodeAction;
  /** 평문 노드 토큰 — **이 응답 1회만**. issue=false 거나 회전하지 않았으면 null. */
  token: string | null;
}

/**
 * 「세션 호스트」 시스템 구성원을 보장한다(멱등).
 *
 * ⚠ **이미 있으면 손대지 않는다.** 특히 `state` 를 매번 `active` 로 밀지 않는다 — 관리자가
 *  비활성으로 내린 것을 조정 루프가 되돌리면 «끄는 방법»이 사라진다(위 enabled 와 같은 판단).
 *  대신 비활성이면 **경고**한다: 그 상태에서는 노드 인증이 `owner-inactive` 로 거절되므로,
 *  «세션 호스트가 안 붙는다»의 원인이 로그에 이름으로 남아야 한다.
 */
export async function ensureSessionHostMember(): Promise<{ created: boolean; active: boolean }> {
  const cur = await getMember(SESSION_HOST_MEMBER_ID);
  if (cur) {
    const active = cur.state !== "inactive";
    if (!active) {
      logger.warn({ member: SESSION_HOST_MEMBER_ID },
        "세션 호스트 구성원이 비활성이다 — 이 테넌트의 세션 호스트는 노드 인증에 실패한다(owner-inactive)");
    }
    return { created: false, active };
  }
  await upsertMember({
    id: SESSION_HOST_MEMBER_ID,
    kind: "system",
    display_name: SESSION_HOST_MEMBER_NAME,
    state: "active",
    //  scope 는 **공집합**이다. 노드 토큰 자체가 `scopes: []` 로 발급되므로(store.createNode) 이
    //   구성원에게 권한을 줄 이유가 없다 — 세션 호스트는 노드 채널만 쓴다.
    scopes: [],
    body_md: "매니지드 세션 호스트의 노드 자격이 매달리는 자리입니다. 사람 계정에 묶지 않으려고 둡니다(#2600 T2 d5).",
  }, SESSION_HOST_MEMBER_ID, "session-host-provision");
  logger.info({ member: SESSION_HOST_MEMBER_ID }, "세션 호스트 시스템 구성원 생성");
  return { created: true, active: true };
}

/**
 * 이 테넌트의 세션 호스트 노드 등록을 보장한다(멱등). `issue` 면 평문 토큰을 함께 준다.
 *
 * ⚠ REST 등록 라우트(`POST /api/ui/nodes`)를 쓰지 않는다 — 거긴 `sessionHost` 에 admin 게이트가
 *  걸려 있고(#2592 셀프 노드 방어를 아무나 못 끄게), 이 경로엔 사람이 없다. 내부 함수로 부른다.
 */
export async function ensureSessionHostNode(slug: string, issue: boolean): Promise<SessionHostEnsureResult> {
  const nodeId = sessionHostNodeId(slug);
  if (!nodeId) throw new Error(`세션 호스트 노드 id 를 만들 수 없는 슬러그입니다: ${JSON.stringify(slug)}`);
  await ensureSessionHostMember();

  //  ① 선언된 세션 호스트를 찾는다(이름이 아니라 선언 — pickSessionHostNode 머리말).
  //  ② 없으면 **정규 id 가 이미 다른 용도로 쓰이고 있나**를 본다. 안 보면 createNode 가 409 로
  //   죽는데, 그 409 는 브로커에게 «영영 못 선다» 로 보인다(사람이 그 이름을 쓴 죄로 그 테넌트에
  //   세션 호스트가 안 생긴다). 있으면 선언을 켜고 물려받는 편이 맞다.
  const nodes = await listNodes();
  const existing = pickSessionHostNode(nodes, slug) ?? nodes.find((n) => n.id === nodeId) ?? null;
  const action = decideSessionHostNode({ existing, issue });

  if (action === "create") {
    const { node, token } = await createNode(
      { id: nodeId, name: nodeId, kind: "worker", owner: SESSION_HOST_MEMBER_ID, sessionHost: true },
      SESSION_HOST_MEMBER_ID,
    );
    logger.info({ node: node.id, slug }, "세션 호스트 노드 등록(자기 프로비저닝)");
    return view(node, action, token);
  }

  const cur = existing as OrgNode;
  if (action === "keep") return view(cur, action, null);

  //  ⚠ **물려받은 행의 id 로 부른다**(정규 id 가 아니다). d4 의 수기 노드는 `sesshost-46e3` 인데
  //   정규 id 는 `sesshost-lively-46e3` 이라, 여기서 정규 id 를 쓰면 «노드 없음» 으로 죽는다.
  //  ★ 순서가 있다: **먼저 주인을 고치고** 회전한다. rotateNodeToken 은 그 시점의
  //   `node.owner_member` 명의로 발행하므로, 반대로 하면 새 토큰이 옛 주인(사람) 명의로 남는다.
  if (action === "fix-and-rotate") {
    await setNodeOwnerAndSessionHost(cur.id, SESSION_HOST_MEMBER_ID);
    logger.info({ node: cur.id, from: cur.owner_member, to: SESSION_HOST_MEMBER_ID },
      "세션 호스트 노드의 주인을 시스템 구성원으로 옮겼다(사람 계정 비활성이 세션을 끊지 않게)");
  }
  const { node, token } = await rotateNodeToken(cur.id, SESSION_HOST_MEMBER_ID);
  logger.info({ node: node.id, slug }, "세션 호스트 노드 토큰 재발급(브로커가 자격을 잃었다고 알려 왔다)");
  return view(node, action, token);
}

function view(node: OrgNode, action: SessionHostNodeAction, token: string | null): SessionHostEnsureResult {
  return {
    nodeId: node.id,
    owner: node.owner_member,
    enabled: node.enabled,
    sessionHost: node.session_host,
    action,
    token,
  };
}
