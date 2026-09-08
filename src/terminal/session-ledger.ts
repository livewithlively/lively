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
//  desired  = org_session_state 전 행(id · superseded_by · node_id) + 상시세션 id(DB 행이 없는 것이 설계다 — #1059 E)
//  observed = 지금 tmux 에 있는 box-* 세션 id. **못 봤으면 null** — «없다» 와 «모른다» 를 섞지 않는다(#835).
//  판정(원한다/은퇴했다/모른다)은 소비자(브로커 sessionledger.ts)가 한다 — 여기는 사실만 준다.
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
import crypto from "node:crypto";
import type express from "express";
import { wrap, HttpError } from "../http/rest-util.js";
import { resolveTenantFromHeaders } from "../org/tenant-context.js";
import { listSessionLedgerRows, type SessionLedgerRow } from "../sessions/session-state.js";
import { listManagedSessions } from "../sessions/managed-sessions.js";
import { listLiveSessionIds } from "./terminal-sessions.js";

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
}

/**
 * 장부 조립. desired(DB) 를 못 읽으면 **던진다**(500) — 브로커는 비200 을 «못 받음» 으로 읽어 오늘의 경로로 간다.
 *  빈 desired 로 답하면 모든 세션이 «행 없음» 이 되는데, 그건 사실이 아니라 우리 장애다.
 */
export async function buildSessionLedger(d: LedgerDeps): Promise<SessionLedgerBody> {
  const [desired, managed] = await Promise.all([d.listRows(), d.listManaged()]);
  let live: string[] | null;
  try { live = await d.listLive(); }
  catch { live = null; }   // 못 봤다 — 관측 없음(빈 집합이 아니다)
  return {
    authoritative: true,
    observed: live !== null,
    desired,
    managed: managed.map((m) => m.session_id).filter((x): x is string => !!x),
    live,
  };
}

export const LEDGER_AUTH_HEADER = "x-lvly-ledger-auth";

/** 장부 서명(순수) — 브로커(lvly-cloud sessionledger.ts)가 **같은 식**으로 만든다. 한쪽만 바꾸면 401 이 된다. */
export function ledgerAuthToken(secret: string, slug: string): string {
  return crypto.createHmac("sha256", secret).update(`ledger:${slug}`).digest("hex");
}

/**
 * 접근 판정(순수) — 비밀 미설정이면 404(경로가 없는 것과 같다), 테넌트 헤더가 비밀과 안 맞거나 **장부 서명이
 *  없거나 틀리면** 401. 실패 사유를 가르지 않는다(«비밀은 맞는데 서명이 없다» 를 밖에 말할 이유가 없다).
 */
export function ledgerAccess(
  headers: Record<string, string | string[] | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): { status: 200 | 401 | 404; why: string } {
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
  return { status: 200, why: "ok" };
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
      listLive: () => listLiveSessionIds({ strict: true }),
    }));
  }));
}
