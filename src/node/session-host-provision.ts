// 매니지드 세션 호스트의 **자격을 게이트웨이가 스스로 만든다** (#2600 T2 (d) d5)
//
// ★★ 축 정정 (#3797 T7, 2026-09-09): 세션 호스트는 **(노드, 테넌트)** 별로 하나다 — 테넌트당 하나가
//  아니다. 그 근거와 사연은 `sessionHostNodeId` 머리말에 있다.
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

/** 노드 id 접두 — `sesshost-<slug>-<node>`. (노드, 테넌트) 한 쌍이 곧 한 행이다(#3797 T7). */
export const SESSION_HOST_NODE_PREFIX = "sesshost-";
/** store.normalizeNodeId 의 상한(2~64자)과 같은 값 — 여기서 먼저 걸러 400 대신 «못 한다»를 말한다. */
const NODE_ID_MAX = 64;
/** 슬러그·노드 이름에 공통으로 쓰는 모양 — 소문자 슬러그(정규화 없이 그대로 id 에 들어간다). */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * 이 **(노드, 테넌트)** 의 세션 호스트 노드 id(순수). 만들 수 없으면 **null** — 지어내지 않는다.
 *
 * ── ★★ 왜 노드 성분이 들어가나 (#3797 T7 — 축 정정) ─────────────────────────
 * d5 의 유도는 `sesshost-<slug>` 였다. 그건 «세션 호스트는 테넌트당 하나» 를 전제하는데, 그 전제가
 *  2026-09-09 아침 사고의 뿌리였다([[sesshost-node-scalein-orphan-3776]] §5):
 *   · 호스트가 **한 노드에만** 서니 그 노드는 오토스케일 계수에 «세션 0» 으로 보여 우선 회수됐고,
 *     회수되는 순간 그 테넌트의 주인이 통째로 사라졌다(세션은 멀쩡한데 들어가는 문만 부서졌다).
 *   · 그리고 조정기(브로커 sesshost.ts)는 **그 테넌트를 서빙하는 노드마다** 돈다 — 유도에 노드
 *     성분이 없으면 두 노드가 **같은 등록 행 하나**를 두고 토큰을 서로 회전시켜 죽인다.
 * 축을 (노드, 테넌트)로 옮기면 «세션 0 인 노드엔 호스트가 없다» 가 되어 그 사고가 **원리적으로**
 *  불가능해지고, 회수 계수에 세션 호스트를 반영하는 우회(26.9MiB 릴레이 하나 때문에 노드를 못 줄이는
 *  거래)도 필요 없어진다.
 *
 * ★ 슬러그를 빼지 않는다: 이 id 는 그 테넌트의 `org_node` 행 이름이고, 운영이 CP 로그·노드 목록에서
 *  «어느 테넌트의 어느 노드» 를 이름만으로 읽어야 한다. 노드 성분만으로도 행은 유일하지만 이름이
 *  그 사실을 말해 주지는 않는다.
 * ★ **잘라서 만들지 않는다**: 자른 이름은 다른 노드·다른 테넌트와 겹칠 수 있고, 그러면 두 브로커가
 *  같은 노드 행(=같은 토큰)을 쓰게 된다. 격리가 조용히 사라지는 부류라 «못 한다»가 맞는 답이다.
 *  (실측 좌표는 슬러그 11자 + 노드 19자 = 40자로 상한 안에 넉넉히 든다.)
 */
export function sessionHostNodeId(slug: string, node: string): string | null {
  const s = (slug || "").trim();
  const n = (node || "").trim();
  //  ⚠ 노드 성분이 **없으면 null** 이다. 여기서 관대하게 `sesshost-<slug>` 로 떨어지면 그게 곧 옛 축이고,
  //   옛 브로커(노드를 안 보내는)가 그 행을 만들어 두 노드가 다시 한 행을 두고 싸운다.
  if (!NAME_RE.test(s) || !NAME_RE.test(n)) return null;
  const id = `${SESSION_HOST_NODE_PREFIX}${s}-${n}`;
  return id.length <= NODE_ID_MAX ? id : null;
}

/** 후보를 고르기 위해 필요한 최소한의 노드 모양 — 시험이 전체 행을 지어내지 않게 좁혀 둔다. */
export interface SessionHostCandidate {
  id: string;
  session_host: boolean;
}

/**
 * **어느 노드의 것도 아닌** 세션 호스트 등록들(순수) — 선언은 켜져 있는데 `sesshost-<slug>-…` 모양이
 *  아닌 행. 옛 축의 잔재(`sesshost-<slug>` — 노드 성분 없음)나 사람이 손으로 만든 이름이 여기 걸린다.
 *
 * ── 왜 «찾아서 물려받기» 를 버렸나 (d5 §② 규율의 재작성) ────────────────────
 * d5 는 «이름이 아니라 **선언**으로 찾아 물려받는다» 였다. 그 규칙은 «이 테넌트의 세션 호스트는
 *  하나» 를 전제한다 — (노드, 테넌트) 축에서는 같은 동작이 정확히 **남의 노드의 주인을 빼앗는** 일이
 *  된다(주인을 옮기고 토큰을 회전시키므로, 그 순간 저쪽 노드의 호스트가 인증을 잃는다).
 *  그래서 물려받지 않고 **내 정규 id 하나만** 본다.
 *
 * ⚠ **형제는 «남의 것» 이 아니다.** 같은 테넌트의 다른 노드가 세운 `sesshost-<slug>-<다른노드>` 는
 *  새 축의 **정상**이다. 그걸 여기서 걸면 노드가 N 대일 때 매 조정(5분)마다 N-1 건의 경고가
 *  전 노드에서 돈다 — 반복되는 줄은 아무도 안 본다(이 모듈의 `once` 규율과 같은 이유).
 *
 * 걸리는 것은 **어느 노드도 조정하지 않을 행**이다. 그런 행은 영영 오프라인이고, 목록 소유 판정
 *  (`self-node.sessionHostVerdict` — T7 에서 «선언한 호스트가 전부 자격일 때만» 으로 바뀌었다)이
 *  그 행 때문에 하루(SESSION_HOST_DEAD_MS) 동안 거짓이 된다. 이름이 로그에 남아야 사람이 지운다.
 */
export function legacySessionHostNodes<T extends SessionHostCandidate>(nodes: readonly T[], slug: string): string[] {
  const mine = `${SESSION_HOST_NODE_PREFIX}${slug}-`;
  return nodes.filter((n) => n.session_host && !n.id.startsWith(mine)).map((n) => n.id);
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
export async function ensureSessionHostNode(slug: string, node: string, issue: boolean): Promise<SessionHostEnsureResult> {
  const nodeId = sessionHostNodeId(slug, node);
  if (!nodeId) throw new Error(`세션 호스트 노드 id 를 만들 수 없습니다: slug=${JSON.stringify(slug)} node=${JSON.stringify(node)}`);
  await ensureSessionHostMember();

  //  ★ 찾는 것은 **내 정규 id 하나**다(#3797 T7). d5 는 «선언으로 찾아 물려받았지만», (노드, 테넌트)
  //   축에서 그건 남의 노드의 주인을 빼앗는 동작이다(foreignSessionHostNodes 머리말).
  const nodes = await listNodes();
  const existing = nodes.find((n) => n.id === nodeId) ?? null;
  const action = decideSessionHostNode({ existing, issue });

  //  옛 축의 잔재는 **말만 한다.** 어느 노드도 그 행을 조정하지 않으므로 영영 오프라인이고,
  //   그 행이 있는 동안 목록 소유 판정이 거짓이다(«선언한 호스트가 전부 자격일 때만»).
  //   ⚠ 형제(`sesshost-<slug>-<다른노드>`)는 여기 안 걸린다 — 새 축의 정상이다.
  const legacy = legacySessionHostNodes(nodes, slug);
  if (legacy.length) {
    logger.warn({ slug, node, mine: nodeId, legacy },
      "이 테넌트에 (노드, 테넌트) 축이 아닌 세션 호스트 등록이 남아 있다 — 물려받지 않는다(지워야 목록 소유가 넘어간다)");
  }

  if (action === "create") {
    const { node: row, token } = await createNode(
      { id: nodeId, name: nodeId, kind: "worker", owner: SESSION_HOST_MEMBER_ID, sessionHost: true },
      SESSION_HOST_MEMBER_ID,
    );
    logger.info({ node: row.id, slug }, "세션 호스트 노드 등록(자기 프로비저닝)");
    return view(row, action, token);
  }

  const cur = existing as OrgNode;
  if (action === "keep") return view(cur, action, null);

  //  ★ 순서가 있다: **먼저 주인을 고치고** 회전한다. rotateNodeToken 은 그 시점의
  //   `node.owner_member` 명의로 발행하므로, 반대로 하면 새 토큰이 옛 주인(사람) 명의로 남는다.
  if (action === "fix-and-rotate") {
    await setNodeOwnerAndSessionHost(cur.id, SESSION_HOST_MEMBER_ID);
    logger.info({ node: cur.id, from: cur.owner_member, to: SESSION_HOST_MEMBER_ID },
      "세션 호스트 노드의 주인을 시스템 구성원으로 옮겼다(사람 계정 비활성이 세션을 끊지 않게)");
  }
  const { node: row, token } = await rotateNodeToken(cur.id, SESSION_HOST_MEMBER_ID);
  logger.info({ node: row.id, slug }, "세션 호스트 노드 토큰 재발급(브로커가 자격을 잃었다고 알려 왔다)");
  return view(row, action, token);
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
