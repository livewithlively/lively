// #2600 T2 d5 — 자격 창구의 **문**(접근 판정)과 발급 의사 읽기.
//  엣지 표(스크래치패드 spec-d5-lively.md)의 A1~A7 · W1~W4.
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  SESSION_HOST_AUTH_HEADER, sessionHostAccess, sessionHostAuthToken, wantsIssue, wantsRelease,
} from "./session-host-route.js";

/** 라우터·MCP 프록시가 붙이는 그 셋 — 인터넷에서 온 요청도 이 모양으로 게이트웨이에 닿는다. */
const T = {
  "x-lvly-tenant-auth": "s3cret",
  "x-lvly-tenant": "acme",
  "x-lvly-tenant-id": "11111111-1111-1111-1111-111111111111",
};
const H = { ...T, [SESSION_HOST_AUTH_HEADER]: sessionHostAuthToken("s3cret", "acme") };
const ENV = { LIVELY_TENANT_HEADER_SECRET: "s3cret" };

test("A1·A2·A3 — 비밀 미설정(셀프호스팅)=404 · 틀린 비밀=401 · 헤더 없음=401", () => {
  assert.equal(sessionHostAccess(H, {}).status, 404, "비밀이 없는 배포엔 이 경로가 없다");
  assert.equal(sessionHostAccess(H, { LIVELY_TENANT_HEADER_SECRET: "other" }).status, 401);
  assert.equal(sessionHostAccess({}, ENV).status, 401);
});

test("★★ A4·A5 — 테넌트 헤더만으로는 **노드 토큰을 못 받는다**", () => {
  //  이 행이 지키는 것: 로그인 없는 인터넷 요청(라우터가 테넌트 헤더를 붙여 준다)이 자격을 발급받지 못한다.
  //  장부(#2544)에서 새던 것은 «세션 id 목록» 이었고, 여기서 새면 **자격 그 자체**다.
  assert.equal(sessionHostAccess(T, ENV).status, 401, "테넌트 헤더 셋만 — 라우터 경유 요청의 모양");
  assert.equal(
    sessionHostAccess({ ...T, [SESSION_HOST_AUTH_HEADER]: sessionHostAuthToken("s3cret", "other") }, ENV).status,
    401, "다른 slug 의 서명은 이 slug 의 문을 못 연다",
  );
});

test("A7 — 테넌트 식별 정보가 반쪽이면 401(사유를 밖에 가르지 않는다)", () => {
  assert.equal(sessionHostAccess({ ...H, "x-lvly-tenant-id": "" }, ENV).status, 401);
});

test("★ A6 — 전부 맞으면 200 이고 **그 slug 를 돌려준다**(노드 id 가 여기서 나온다)", () => {
  const a = sessionHostAccess(H, ENV);
  assert.equal(a.status, 200);
  assert.equal(a.slug, "acme", "헤더의 slug 가 그대로 노드 id 유도의 입력이 된다");
});

test("★ 거절할 때는 slug 를 안 싣는다 — 거절된 요청의 값이 뒤 단계로 새지 않게", () => {
  assert.equal(sessionHostAccess(T, ENV).slug, "");
  assert.equal(sessionHostAccess(H, {}).slug, "");
});

test("★ W1~W4 — 발급은 **정확히 true** 일 때만(관대하게 읽어 주면 조회가 회전이 된다)", () => {
  assert.equal(wantsIssue({ issue: true }), true);
  assert.equal(wantsIssue({ issue: "true" }), false, "문자열 'true' 는 발급 의사가 아니다");
  assert.equal(wantsIssue({ issue: 1 }), false);
  assert.equal(wantsIssue({}), false);
  assert.equal(wantsIssue(null), false);
  assert.equal(wantsIssue(undefined), false);
});

// ── 해제(release) — 내릴 때 게이트웨이에 알린다 (#2600 T2 d5-b · 2026-09-09 실측) ──────
//  목록 소유 판정은 «선언한 호스트가 **전부** 자격일 때만» 이다(#3797 T7). 그래서 내려간 호스트의
//  선언이 남으면 그 규칙이 스스로를 막는다. 실측: 카나리아 테넌트의 죽은 선언 행 둘이 **조정기가
//  우아하게 내린 것**이었고(«세션 호스트를 내렸다» 시각 = last_seen), 그때 판정이 `offline` 이었다.
test("★★ RL1 — 해제 의사는 **정확히 true 일 때만**(관대하게 읽으면 켜려던 요청이 끄는 요청이 된다)", () => {
  assert.equal(wantsRelease({ release: true }), true);
  assert.equal(wantsRelease({ release: "true" }), false, "문자열 'true' 는 해제 의사가 아니다");
  assert.equal(wantsRelease({ release: 1 }), false);
  assert.equal(wantsRelease({}), false);
  assert.equal(wantsRelease(null), false);
  assert.equal(wantsRelease(undefined), false);
});

test("★★ RL2 — 해제와 발급은 **서로 배타**다(같은 본문이 둘 다일 수 없다)", () => {
  //  둘 다 참인 본문이 오면 라우트가 해제를 먼저 본다 — 아래 RL3 이 그 순서를 소스로 못박는다.
  assert.equal(wantsRelease({ release: true, issue: true }), true);
  assert.equal(wantsIssue({ release: true, issue: true }), true);
});

test("★★ RL3 — 라우트가 **해제를 먼저** 본다(내렸다는 요청에 자격을 발급하면 도로 세운다)", () => {
  const src = readFileSync(new URL("./session-host-route.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
  const rel = src.indexOf("wantsRelease(req.body)");
  const iss = src.indexOf("wantsIssue(req.body)");
  assert.ok(rel > 0 && iss > 0, "두 갈래가 다 있어야 한다");
  assert.ok(rel < iss, "🔴 발급이 먼저 걸리면 방금 내린 세션 호스트를 그 요청이 도로 세운다");
});

test("★★ RL4 — 해제는 DB 와 **메모리 둘 다** 내린다", () => {
  //  DB 만 내리면 판정이 읽는 것은 메모리 스냅샷이라 게이트웨이 재시작 전까지 그대로 «선언» 이다.
  const src = readFileSync(new URL("./session-host-route.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
  const body = src.slice(src.indexOf("wantsRelease(req.body)"), src.indexOf("const issue = wantsIssue"));
  assert.match(body, /releaseSessionHostNode\(a\.slug, node\)/, "🔴 DB 선언을 안 내리면 재부팅 뒤 되살아난다");
  assert.match(body, /undeclareSessionHostState\(/, "🔴 메모리를 안 내리면 이 프로세스가 사는 동안 계속 막는다");
});
