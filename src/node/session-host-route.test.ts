// #2600 T2 d5 — 자격 창구의 **문**(접근 판정)과 발급 의사 읽기.
//  엣지 표(스크래치패드 spec-d5-lively.md)의 A1~A7 · W1~W4.
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  SESSION_HOST_AUTH_HEADER, sessionHostAccess, sessionHostAuthToken, wantsIssue,
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
