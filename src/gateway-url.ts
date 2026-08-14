// 게이트웨이 공개 주소(절대 base) 확정 — **단일 소스**. org 프로필 > PUBLIC_URL > 요청 헤더.
//  원래 web.ts 의 CLI 부트스트랩 전용 로컬 함수(selfUrl)였다. 같은 값을 필요로 하는 자리가 셋으로 늘어
//  공용 모듈로 뺐다: ① kit/cli 부트스트랩(셸 스크립트에 굽는다) ② whoami(에이전트가 사람에게 줄 링크의 base)
//  ③ 미리보기 주소(preview-envs — 상대경로 '/preview/<id>/…' 만 주면 에이전트가 클릭 가능한 링크를 못 만든다).
//
//  ⚠ req.protocol 을 못 믿는 이유 — Caddy 가 TLS 를 종단해 게이트웨이는 http 로 받는다(auth/sessions.ts:68 과 같은 사정).
//   그래서 공개 스킴은 org 프로필/PUBLIC_URL 이 권위고, 헤더는 최후 폴백이다.
//  ⚠ 형태 검증(SAFE_GATEWAY_URL)은 값싸고 필수다 — 이 값은 실행되는 셸/PowerShell 스크립트의 문자열 리터럴
//   안으로 들어간다. 헤더 폴백은 요청자가 통제할 수 있으니(Host), `"`·`$(…)`·백틱이 섞이면 자기 자신에게
//   셸 인젝션이 된다. 실사용에선 org 프로필/PUBLIC_URL 이 먼저 잡혀 폴백이 거의 안 쓰이지만 방어는 유지한다.
import type express from "express";
import { getOrgProfile } from "./org/store.js";

export const SAFE_GATEWAY_URL = /^https?:\/\/[A-Za-z0-9._-]+(:\d{1,5})?$/;

// 저장된 값의 표기 편차 흡수 — 앞뒤 공백, 끝의 '/mcp'(사람이 MCP 엔드포인트를 붙여 저장하는 흔한 실수), 말미 슬래시.
//  ⚠ 순서: 말미 슬래시를 **먼저** 벗겨야 '/mcp/' 로 복붙된 값도 '/mcp$' 매칭에 걸린다. 먼저 '/mcp$' 를
//   떼면 말미 슬래시에 막혀 '/mcp' 가 살아남고 SAFE_GATEWAY_URL(경로 불허)에서 통째로 탈락한다.
//   kit/cli 의 normGw(lively.mjs·lively-mcp-local.mjs)와 **글자 그대로 같은 체인**이다(trim 포함) — 한쪽만
//   흡수하는 편차가 있으면 같은 값이 CLI 에선 살고 게이트웨이에선 죽는다. 고칠 땐 양쪽을 같이 고칠 것.
export const normalizeGatewayUrl = (u: string): string =>
  u.trim().replace(/\/+$/, "").replace(/\/mcp$/, "").replace(/\/+$/, "");

const safe = (u: string | null | undefined): string | null => {
  if (!u) return null;
  const c = normalizeGatewayUrl(String(u));
  return SAFE_GATEWAY_URL.test(c) ? c : null;
};

// 요청 없이 확정 — MCP/백그라운드 경로용(헤더가 없다). 못 정하면 null(호출자가 fail-open 할 수 있게).
export async function gatewayUrl(): Promise<string | null> {
  // DB 가 아예 구성되지 않은 실행(테스트·DB 없는 배포)에서는 연결 시도 자체를 건너뛴다 —
  //  verifyDbToken 이 쓰는 것과 같은 가드. 없으면 매 호출이 커넥션 실패를 기다린다.
  if (process.env.ITEMS_DATABASE_URL) {
    try {
      const p = await getOrgProfile();
      const fromProfile = safe(p.gateway_url);
      if (fromProfile) return fromProfile;
    } catch { /* DB 미가동 등 — env 폴백 */ }
  }
  return safe(process.env.PUBLIC_URL);
}

// 요청 맥락까지 동원해 확정 — 웹/REST 경로용. org 프로필·PUBLIC_URL 이 비어 있을 때만 헤더를 본다.
export async function gatewayUrlForRequest(req: express.Request): Promise<string | null> {
  const known = await gatewayUrl();
  if (known) return known;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  return safe(`${proto}://${req.get("host") ?? ""}`);
}

// 상대경로를 절대 URL 로 — base 를 못 정하면 상대경로를 그대로 돌려준다(링크가 없어지는 것보다 낫다).
export async function absoluteUrl(pathAbs: string): Promise<string> {
  const base = await gatewayUrl();
  return base ? base + pathAbs : pathAbs;
}
