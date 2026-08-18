// 요청마다 테넌트 컨텍스트를 여는 미들웨어 — 공유 게이트웨이의 입구. (#1437 v1 5단계)
//
// ── 이 파일이 지키는 명제 ───────────────────────────────────────────────────
// 공유 게이트웨이에서는 **컨텍스트 없이 지나가는 요청이 하나도 없어야 한다.** 하나라도 새면 그
//  요청은 "테넌트를 모르는 상태"로 DB·파일에 닿는데, 그때 나오는 값은 0행이 아니라
//  **다른 테넌트의 것**일 수 있다(단일 테넌트 폴백 경로가 그대로 살아 있으므로).
//
// 그래서 이 미들웨어는 **앱의 가장 바깥**에 선다. 라우터마다 붙이면 새로 만든 라우터가 빠지고,
//  빠뜨림이 곧 유출인 구조는 사람 규율로 못 지킨다.
//
// ── 켜지는 조건 = 단 하나 ───────────────────────────────────────────────────
// `LIVELY_TENANT_HEADER_SECRET` 이 있어야만 동작한다(resolveTenantFromHeaders). 없으면 이
//  미들웨어는 **아무것도 하지 않고 통과시킨다** — 자가호스팅은 종전과 완전히 같다.
//
// ── 왜 헤더인가(호스트명이 아니라) ──────────────────────────────────────────
// 호스트명으로 테넌트를 정하면 **Host 헤더를 위조하는 것만으로 남의 워크스페이스가 된다.**
//  앞단(CP 라우터)이 이미 인증된 매핑을 갖고 있으므로, 그 매핑을 공유 비밀로 서명해 넘긴다.
//  게이트웨이는 그 비밀을 상수시간 비교로 확인한다(resolveTenantFromHeaders).
//
// ⚠ 그래서 **게이트웨이는 절대 인터넷에 직접 노출되면 안 된다.** 노출되면 누구나 헤더를 지어낼
//  수 있고, 비밀 하나만 알면 임의 테넌트가 된다. 이 전제가 깨지는 배포에서는 이 기능을 켜지 마라.

import type { RequestHandler } from "express";
import { resolveTenantFromHeaders, withTenant, type TenantContext } from "./tenant-context.js";

/** 셀프호스트 다중 워크스페이스(#1750 S1)의 요청 헤더 — 프론트 api()/하네스가 선택한 워크스페이스 slug. */
export const WORKSPACE_HEADER = "x-lively-workspace";
/** 헤더를 못 싣는 표면(EventSource·iframe·WS URL)용 등가 신호 — apiUrl() 이 붙인다. */
export const WORKSPACE_QUERY = "lvly_ws";
/** registry 모드에서 미들웨어가 쓰는 slug→워크스페이스 해석기(부팅이 주입 — org/tenancy/registry.lookupWorkspace). */
export type WorkspaceLookup = (slug: string) => Promise<{ id: string; slug: string } | null>;
/** 세션 id→워크스페이스 해석기(부팅이 주입 — org/tenancy/registry.workspaceForSession). 맵 부재 = null = primary. */
export type SessionWorkspaceLookup = (sessionId: string) => Promise<{ id: string; slug: string } | null>;

const SESSION_ID_CHARS = /^[A-Za-z0-9._-]{4,64}$/;

/**
 * 요청에서 **세션 축 신호**를 뽑는다(순수) — 명시 워크스페이스 신호가 없을 때의 폴백 재료.
 *
 * ★ 워크스페이스 신호를 클라이언트 헤더에만 의존하면 헤더를 못/안 싣는 표면 전부가 조용히 primary 로
 *  떨어진다(dev 실측 — SSE·iframe·구 번들). 세션을 참조하는 요청은 그 세션의 소속이 서버 정본
 *  (gw_session_map)에 있으므로, 여기서 세션 id 만 뽑으면 컨텍스트를 되찾을 수 있다:
 *   · `x-lively-session` 헤더 — 하네스 MCP 프록시·훅이 #852 부터 실어 온 **기존 계약**(구 kit 도 이미 보낸다).
 *   · URL 경로 `/api/ui/terminal/sessions/<id>…` · `/api/ui/v6/sessions/<id>…` — SSE·iframe 의 fetch 가
 *     헤더 없이도 세션을 URL 로 가리킨다(캡처 훅의 watermark 경로도 이 꼴).
 */
export function sessionIdFromRequest(headers: Record<string, string | string[] | undefined>, url: string): string | null {
  const h = headers["x-lively-session"];
  const fromHeader = (Array.isArray(h) ? h[0] : h || "").trim();
  if (fromHeader && SESSION_ID_CHARS.test(fromHeader)) return fromHeader;
  const m = /^\/api\/ui\/(?:terminal|v6)\/sessions\/([A-Za-z0-9._-]{4,64})(?:[/?#]|$)/.exec((url || "").split("?")[0] ?? "");
  return m ? m[1]! : null;
}

/** 거절 사유별 HTTP 상태 — 운영이 로그만 보고 원인을 가를 수 있게 서로 다른 코드를 준다. */
export function statusForReason(reason: string): number {
  switch (reason) {
    // 앞단이 헤더를 안 붙였거나 비밀이 틀렸다 → 배선 문제. 401 로 드러낸다.
    case "unauthenticated": return 401;
    // 인증은 됐는데 식별 정보가 모자라다 → 앞단의 매핑이 깨졌다.
    case "missing": return 400;
    // ★ 내 샤드가 아니다 → 앞단의 샤드 지도가 낡았다. 502 로 준다(클라이언트 잘못이 아니다).
    //  조용히 처리하면 두 게이트웨이가 같은 테넌트를 만져 크론·tmux 옵션이 경합한다.
    case "not-owned": return 502;
    default: return 500;
  }
}

/**
 * 테넌트와 무관한 경로 — 컨텍스트 없이 통과시킨다(순수).
 *
 * ⚠ 목록을 **아주 좁게** 유지한다. 여기 들어간 경로는 "테넌트를 모르는 상태"로 앱에 들어가므로,
 *  그 경로가 DB 를 만지면 그 순간 단일 테넌트 폴백으로 떨어진다. 헬스체크처럼 **아무 데이터도
 *  안 만지는** 것만 넣는다.
 *  (실측: 이게 없으면 기동 스크립트·모니터링의 healthz 가 전부 401 이라 컨테이너가 죽은 것처럼 보인다.)
 */
export function isTenantAgnosticPath(path: string): boolean {
  const p = (path || "").split("?")[0];
  return p === "/healthz" || p === "/__router/healthz";
}

/**
 * 컨텍스트를 여는 미들웨어.
 *
 * ⚠ `withTenant` 안에서 `next()` 를 부른다 — 그래야 **그 뒤의 모든 핸들러**가 같은 비동기 체인에
 *  들어와 컨텍스트를 본다. `next()` 를 밖에서 부르면 컨텍스트가 이 미들웨어에서 끝난다.
 */
export function tenantContextMiddleware(env: NodeJS.ProcessEnv = process.env, lookup?: WorkspaceLookup, sessionLookup?: SessionWorkspaceLookup): RequestHandler {
  // ── registry 모드(#1750 S1, 셀프호스트 다중 워크스페이스) ──────────────────
  //  CP 헤더 모드와 **배타**다: 앞단(CP 라우터)이 있는 배포는 서명 헤더가 권위이고, 셀프호스트는 앞단이
  //  없어 **선택 헤더 + 등록부**가 권위다. 두 모드가 겹치면(둘 다 설정) CP 쪽이 이긴다 — 서명이 더 강한
  //  권위라서가 아니라, 겹침 자체가 배선 오류이고 그때 안전한 쪽(요청을 위조 못 하는 쪽)이 서명이라서다.
  //
  //  판정: 헤더 없음/'primary' → 컨텍스트 없이 통과(= primary. 바인딩 리졸버의 primary 폴백이 받는다 —
  //   구 클라이언트·하네스·크론 전부 종전 그대로). 헤더 있음 → 등록부에서 slug 해석: 있으면 그 컨텍스트,
  //   없으면 404(조용히 primary 로 떨어뜨리지 않는다 — 오타·삭제된 워크스페이스로의 쓰기가 남의 자리(primary)에
  //   꽂히는 것이 최악이다).
  //  ⚠ 여기는 "어느 워크스페이스인가"만 정한다. "이 사람이 거기 멤버인가"는 인증이 끝나야 알 수 있으므로
  //   **인증 계층의 게이트**(org/tenancy/gate.ts — userFromSession·BearerVerifier)가 담당한다. 게이트가
  //   빠진 신규 인증 경로가 생기면 새는 것 아니냐 — 아니다: 인증 자체가 그 두 함수로 수렴한다(구조 테스트로 잠근다).
  if ((env.LIVELY_TENANCY_MODE || "").trim().toLowerCase() === "registry" && lookup
      && !(env.LIVELY_TENANT_HEADER_SECRET || "").trim()) {
    return (req, res, next) => {
      if (isTenantAgnosticPath(req.url || "")) { next(); return; }
      // 신호 우선순위: ① 명시 slug(헤더 > lvly_ws 쿼리 — 쿼리는 헤더를 못 싣는 SSE·iframe·WS URL 용,
      //  apiUrl() 이 붙인다) ② 세션 축(x-lively-session 헤더·/sessions/<id> 경로 → gw_session_map 정본)
      //  ③ 없음 = primary. ①의 miss 는 404(오타·삭제가 primary 로 조용히 꽂히지 않게), ②의 맵 부재는
      //  primary(구 세션·primary 세션 = 행 없음이 정상).
      const raw = req.headers[WORKSPACE_HEADER];
      let slug = (Array.isArray(raw) ? raw[0] : raw || "").trim().toLowerCase();
      if (!slug) {
        const q = /[?&]lvly_ws=([^&#]+)/.exec(req.url || "");
        if (q) { try { slug = decodeURIComponent(q[1]!).trim().toLowerCase(); } catch { slug = ""; } }
      }
      if (slug && slug !== "primary") {
        if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) { res.status(400).json({ message: "워크스페이스 이름 형식이 올바르지 않습니다" }); return; }
        lookup(slug).then((w) => {
          if (!w) { res.status(404).json({ message: `워크스페이스 '${slug}' 가 없습니다` }); return; }
          withTenant({ id: w.id, slug: w.slug }, () => next());
        }).catch((e) => {
          console.warn(`[tenant] 워크스페이스 해석 실패 — ${e instanceof Error ? e.message : e}`);
          res.status(500).json({ message: "워크스페이스를 확인하지 못했습니다" });
        });
        return;
      }
      if (slug === "primary") { next(); return; }
      const sid = sessionLookup ? sessionIdFromRequest(req.headers as Record<string, string | string[] | undefined>, req.url || "") : null;
      if (!sid) { next(); return; }
      sessionLookup!(sid).then((w) => {
        if (!w) { next(); return; } // 맵 없음 = primary 세션(구 세션 포함) — 종전 그대로
        withTenant({ id: w.id, slug: w.slug }, () => next());
      }).catch((e) => {
        // 세션 축 해석 실패 — primary 로 넘기지 않는다(그 순간이 곧 오귀속). 시끄럽게 막는다.
        console.warn(`[tenant] 세션 소속 해석 실패 — ${e instanceof Error ? e.message : e}`);
        res.status(500).json({ message: "세션의 워크스페이스를 확인하지 못했습니다" });
      });
    };
  }
  return (req, res, next) => {
    if (isTenantAgnosticPath(req.url || "")) { next(); return; }
    const r = resolveTenantFromHeaders(req.headers as Record<string, string | string[] | undefined>, env);
    if (!r.ok) {
      // `disabled` = 단일 테넌트 배포. 유일하게 그냥 통과시키는 경우다.
      if (r.reason === "disabled") { next(); return; }
      const status = statusForReason(r.reason);
      // 로그에 slug 는 남기되 비밀은 절대 남기지 않는다(헤더 전체를 찍지 않는 이유).
      console.warn(`[tenant] 요청 거절 ${status} — ${r.detail}`);
      res.status(status).json({ message: r.detail });
      return;
    }
    withTenant(r.tenant, () => next());
  };
}

/** 테스트·도구용 — 컨텍스트를 강제로 열고 한 번 돌린다. */
export function runAsTenant<T>(t: TenantContext, fn: () => T): T {
  return withTenant(t, fn);
}
