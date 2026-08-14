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
 * 컨텍스트를 여는 미들웨어.
 *
 * ⚠ `withTenant` 안에서 `next()` 를 부른다 — 그래야 **그 뒤의 모든 핸들러**가 같은 비동기 체인에
 *  들어와 컨텍스트를 본다. `next()` 를 밖에서 부르면 컨텍스트가 이 미들웨어에서 끝난다.
 */
export function tenantContextMiddleware(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  return (req, res, next) => {
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
