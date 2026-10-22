// 세션 장부 (#2544 · #2258 이동 2 의 2단계) — 매니지드 인프라(세션 브로커)가 «이 테넌트의 세션이 무엇이고 지금
//  살아 있나» 를 **tmux 에 묻지 않고 게이트웨이에 묻는** 창구.
//
// ── 왜 ──────────────────────────────────────────────────────────────────────
// 브로커의 고아 회수는 테넌트 tmux 의 `list-sessions` 를 확답으로 삼았다. 그 집계는 tmux 서버가 **하나**일 때만
//  성립하고, 그게 «세션마다 tmux»(3단계)의 유일한 장애물이었다. 그리고 dtach 이후 «tmux 에 없음 ≠ 죽음» 이라
//  2026-09-02 에 살아 있는 `claude` 세션 둘을 회수 대상에 올렸다. 정본은 이미 여기(DB desired-state, #1791)에
//  있다 — 브로커가 그것을 볼 통로만 없었다. CP 는 이미 REST 로 세션 신호를 받는다(idle) — 회수만 tmux 를 봤다.
//
// ── 무엇을 주나 ─────────────────────────────────────────────────────────────
//  desired  = org_session_state 전 행(id · superseded_by · node_id · exited_at · exit_reason) + 상시세션 id(DB 행이 없는 것이 설계다 — #1059 E)
//             ★ exited_at = 끝난 세션 — 사람이 /exit·logout 으로 끝냈거나(#3822) 게이트웨이가 도달 불가로 판정했다(#4939,
//               exit_reason='unreachable'). 소비자는 이것을 «끝났다» 로 읽어 컨테이너를 걷되 행은 남긴다(복원 좌표 보존).
//  observed = 지금 tmux 에 있는 box-* 세션 id. **못 봤으면 null** — «없다» 와 «모른다» 를 섞지 않는다(#835).
//             #2600 T2 d6 — 브로커가 자기 노드를 실어 보내면 그 노드 **세션 호스트의 관측**으로 답한다(ledgerLiveFrom).
//  ★ #4939 — 세션이 살았나·끝났나는 **게이트웨이가 판정**하고 이 장부가 그 최종 판정이다(buildSessionLedger): 지금 보이는 세션은
//   끝남으로 내지 않고, 도달 불가로 적힌 상시 세션은 «끝남» 행으로 덧붙인다. 브로커(sessionledger.ts)는 gateway 모드에서 그대로 집행하고,
//   종전 모드(legacy·shadow)에선 여전히 이 사실 위에서 스스로 판정한다.
//
// ── 누가 부르나 · 어떻게 여나 ───────────────────────────────────────────────
//  브로커에는 사람 세션도 ops 토큰도 없다. 있는 것은 CP↔코어가 이미 공유하는 테넌트 헤더 비밀
//  (LIVELY_TENANT_HEADER_SECRET — MCP 프록시·me-account-delete 가 같은 열쇠를 쓴다)뿐이다. 그래서 이 라우트는
//  사용자 auth 를 붙이지 않고 그 비밀로 문을 연다: 미들웨어(tenantContextMiddleware)가 이미 비밀을 상수시간 비교로
//  확인했지만 여기서 한 번 더 본다(방어 심층화 — 미들웨어 배선이 바뀌어도 이 문은 닫혀 있다).
//  비밀이 없는 배포(셀프호스팅)에선 이 경로가 **없다**(404) — 무회귀.
//
// ★★ 테넌트 비밀 헤더만으로는 **부족하다.** CP 라우터는 인터넷에서 온 모든 요청에 그 헤더를 붙여 게이트웨이로
//  넘기고(router.ts «이 접두는 우리만 만든다»), 세션 컨테이너의 MCP 프록시(mcpsock)도 같은 헤더를 붙인다. 사용자
//  auth 가 없는 이 라우트가 그 헤더만 보면 **로그인 없이 누구나** `<slug>.app.lvly.io/api/ui/terminal/session-ledger`
//  로 세션 id 목록을 읽는다. 그래서 라우터·프록시는 붙이지 않고 **비밀을 아는 쪽만 계산할 수 있는 서명**을
//  하나 더 요구한다 — `x-lvly-ledger-auth = HMAC-SHA256(비밀, "ledger:<slug>")` (brokernet 의 hubClientToken 과
//  같은 꼴). 인터넷 클라이언트도 세션도 비밀을 모르므로 못 만든다. 새 env 는 없다.
//  ⓘ `?node=` 는 서명 밖이다 — 서명을 통과한 요청이 «자기 테넌트의 어느 노드 관측을 쓸지» 를 고를 뿐이라 여는 범위가
//   넓어지지 않는다(다른 노드 이름을 대도 같은 테넌트의 세션 id 다).
import crypto from "node:crypto";
import type express from "express";
import { wrap, HttpError } from "../http/rest-util.js";
import { resolveTenantFromHeaders } from "../org/tenant-context.js";
import { listSessionLedgerRows, type SessionLedgerRow } from "../sessions/session-state.js";
import { listManagedSessions } from "../sessions/managed-sessions.js";
import { listLiveSessionIds } from "./terminal-sessions.js";
import { sessionHostNodeId } from "../node/session-host-provision.js";   // #2600 T2 d6 — (테넌트, 노드) → 세션 호스트 id 는 한 벌
import { sessionHostLiveIds, sessionHostLiveUnion } from "../node/registry.js";
import { unreachableManagedMarks } from "../sessions/session-unreachable-sweep.js";   // #4939 — 도달 불가로 적힌 상시 세션(메모리 표식)

export interface SessionLedgerBody {
  authoritative: true;
  /** tmux 를 봤나. false 면 live 는 null. */
  observed: boolean;
  desired: SessionLedgerRow[];
  managed: string[];
  live: string[] | null;
}

export interface LedgerDeps {
  listRows: () => Promise<SessionLedgerRow[]>;
  listManaged: () => Promise<Array<{ session_id: string | null }>>;
  /** strict — «못 봤다» 면 throw, 서버 부재(세션 0 확답)는 빈 배열. */
  listLive: () => Promise<string[]>;
  /**
   * #4939 — 지금 **어느** 세션 호스트 목록에든 보이는 세션(신선한 호스트만). 호스트가 목록을 쥐지 않은 배포면 null(이 칸은 아무것도 안 바꾼다).
   *  장부의 최종 판정에 쓴다: 끝남 표식이 있어도 지금 살아 있으면 «끝남» 으로 내지 않는다(종전엔 브로커가 tmux 로 이걸 뒤집었다).
   */
  liveAnywhere?: () => ReadonlySet<string> | null;
  /** #4939 — 도달 불가로 적힌 상시 세션(DB 행이 없어 메모리 표식) → 적은 시각(ms). 장부가 상시 목록에서 빼고 «끝남» 행으로 싣는다. */
  unreachableManaged?: () => ReadonlyMap<string, number>;
}

/**
 * 장부 조립. desired(DB) 를 못 읽으면 **던진다**(500) — 브로커는 비200 을 «못 받음» 으로 읽어 오늘의 경로로 간다.
 *  빈 desired 로 답하면 모든 세션이 «행 없음» 이 되는데, 그건 사실이 아니라 우리 장애다.
 */
export async function buildSessionLedger(d: LedgerDeps): Promise<SessionLedgerBody> {
  const [rows, managedRows] = await Promise.all([d.listRows(), d.listManaged()]);
  let live: string[] | null;
  try { live = await d.listLive(); }
  catch { live = null; }   // 못 봤다 — 관측 없음(빈 집합이 아니다)
  //  #4939 — 장부의 **최종 판정**(판정 한 곳). 끝남 표식이 있어도 지금 어느 세션 호스트 목록에든 보이면 끝남으로 내지 않는다 —
  //   훅이 먼저 보고하고 하네스가 아직 안 죽은 창 · 같은 id 로 다시 띄운 직후. 종전엔 이걸 브로커가 tmux 로 뒤집었다(sessionledger orphanPlan).
  //   이어짐(superseded)은 관측과 무관하다 — 새 id 쪽이 산 세션이다.
  const alive = d.liveAnywhere?.() ?? null;
  //   새 배열이다 — 아래에서 상시 세션 행을 덧붙이므로 listRows 가 준 배열을 건드리지 않는다.
  const desired = rows.map((r) => (alive && r.exited_at && !r.superseded_by && alive.has(r.id) ? { ...r, exited_at: null, exit_reason: null } : r));
  //  #4939 H6 — 도달 불가로 적힌 상시 세션은 상시 목록에서 빼고 «끝남» 행으로 싣는다(DB 행이 없는 것이 설계라 이 자리에서 만든다).
  //   그 사이 다시 보이면(정비가 표식을 지우기 전 창) 위와 같은 까닭으로 끝남으로 내지 않는다.
  const marks = d.unreachableManaged?.() ?? new Map<string, number>();
  const managed: string[] = [];
  for (const id of managedRows.map((m) => m.session_id).filter((x): x is string => !!x)) {
    const at = marks.get(id);
    if (at === undefined || alive?.has(id)) { managed.push(id); continue; }
    desired.push({ id, superseded_by: null, node_id: null, exited_at: new Date(at).toISOString(), exit_reason: "unreachable" });
  }
  return { authoritative: true, observed: live !== null, desired, managed, live };
}

/**
 * 장부 `live` 의 출처를 고른다(순수 조립) — 그 브로커 노드의 **세션 호스트가 지금 본 것**이 있으면 그것,
 *  아니면 종전 게이트웨이 tmux (#2600 T2 d6).
 *
 * ── 왜 (2026-09-11 계수 실측) ───────────────────────────────────────────────
 * 브로커는 노드마다·테넌트마다 회수 틱마다 이 장부를 부른다. 그때마다 게이트웨이가 `list-sessions` 를 쳤다 —
 *  노드 5 × 테넌트 6 으로 분당 35번(그 테넌트에 세션 호스트가 전부 서 있는데도).
 *
 * ── 왜 노드 **하나**의 스냅샷으로 충분한가 ─────────────────────────────────────
 * 소비자인 회수 ②(`sessionledger.reapPlan`)는 **그 브로커 노드의 컨테이너만** 훑는다. 세션 호스트는
 *  (노드, 테넌트) 축이라 자기 노드의 세션만 보고한다(`LIVELY_TMUX_LIST_SCOPE=node`, #3797). 그러니 그 노드
 *  호스트의 스냅샷이 곧 «그 브로커가 판정할 세션 전량» 이고, 다른 노드 호스트의 신선도를 기다릴 이유가 없다.
 *  ⚠ 여분의 id 는 무해하지만 **빠진 id 는 곧 회수 후보**다. 그래서 그 노드 하나에 대해서는 빠짐이 없어야 하고,
 *   그 근거는 둘이다: 호스트 스냅샷은 strict 로만 올라온다(«못 봤으면 안 올린다» — 가드 S11) · 12초 신선도.
 *   (그리고 회수 ②는 desired 가 원하는 세션을 tmux 와 무관하게 남기고, 나머지도 «안이 비었을 때만» 걷는다.)
 *
 * ── 종전 경로로 떨어지는 경우 (fail-closed) ─────────────────────────────────────
 *  노드를 안 실어 보낸 브로커(옛 판) · 슬러그·노드 모양이 틀림 · 그 노드에 선언된 호스트가 없음·끊김·낡음.
 *  ⚠ 호스트가 자격이 있고 스냅샷이 **빈 목록**이면 그대로 쓴다 — strict 관측의 «0개» 는 확답이다(모름이 아니다).
 */
export function ledgerLiveFrom(o: {
  slug: string | null | undefined;
  /** 브로커가 실어 보낸 자기 노드 이름(`?node=`) — 요청값이라 모양을 믿지 않는다 */
  node: unknown;
  /** 그 세션 호스트가 자격이 있을 때만 id 목록, 아니면 null(`registry.sessionHostLiveIds`) */
  hostLive: (nodeId: string) => string[] | null;
  tmuxLive: () => Promise<string[]>;
}): () => Promise<string[]> {
  const node = typeof o.node === "string" ? o.node.trim() : "";
  const hostId = o.slug && node ? sessionHostNodeId(o.slug, node) : null;
  const ids = hostId ? o.hostLive(hostId) : null;
  return ids ? async () => ids : o.tmuxLive;
}

export const LEDGER_AUTH_HEADER = "x-lvly-ledger-auth";

/** 장부 서명(순수) — 브로커(lvly-cloud sessionledger.ts)가 **같은 식**으로 만든다. 한쪽만 바꾸면 401 이 된다. */
export function ledgerAuthToken(secret: string, slug: string): string {
  return crypto.createHmac("sha256", secret).update(`ledger:${slug}`).digest("hex");
}

/**
 * 접근 판정(순수) — 비밀 미설정이면 404(경로가 없는 것과 같다), 테넌트 헤더가 비밀과 안 맞거나 **장부 서명이
 *  없거나 틀리면** 401. 실패 사유를 가르지 않는다(«비밀은 맞는데 서명이 없다» 를 밖에 말할 이유가 없다).
 *  200 이면 **서명이 묶인 슬러그**를 함께 준다 — 라우트가 그 테넌트의 세션 호스트를 찾을 때 같은 값을 쓰게.
 */
export function ledgerAccess(
  headers: Record<string, string | string[] | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): { status: 200 | 401 | 404; why: string; slug?: string } {
  const secret = (env.LIVELY_TENANT_HEADER_SECRET || "").trim();
  if (!secret) return { status: 404, why: "매니지드 배포가 아니다" };
  const r = resolveTenantFromHeaders(headers, env);
  if (!r.ok) return { status: 401, why: r.detail };
  const raw = headers[LEDGER_AUTH_HEADER];
  const got = (Array.isArray(raw) ? raw[0] : raw || "").trim();
  const want = ledgerAuthToken(secret, r.tenant.slug);
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
    return { status: 401, why: "장부 서명 없음/불일치" };
  }
  return { status: 200, why: "ok", slug: r.tenant.slug };
}

export function registerSessionLedgerRoute(app: express.Express): void {
  // ⚠ 사용자 auth 없음 — 머리말. 기계(브로커)가 테넌트 비밀로 연다.
  app.get("/api/ui/terminal/session-ledger", wrap(async (req, res) => {
    const a = ledgerAccess(req.headers as Record<string, string | string[] | undefined>);
    if (a.status !== 200) throw new HttpError(a.status, a.status === 404 ? "not found" : "테넌트 헤더 인증 실패");
    res.setHeader("Cache-Control", "no-store");
    res.json(await buildSessionLedger({
      listRows: listSessionLedgerRows,
      listManaged: listManagedSessions,
      listLive: ledgerLiveFrom({
        slug: a.slug,
        node: req.query.node,
        hostLive: sessionHostLiveIds,
        tmuxLive: () => listLiveSessionIds({ strict: true }),
      }),
      liveAnywhere: () => sessionHostLiveUnion(),
      unreachableManaged: () => unreachableManagedMarks(),
    }));
  }));
}
