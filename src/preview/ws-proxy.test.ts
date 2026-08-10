// 프리뷰 WS 중계(#1541) — 경로 분해 + 101 응답 재구성의 계약.
//
// 계기(실측): 프리뷰에 등록한 윈도우 노드가 `wss://…/preview/p1541-lively/node/ws` 로 붙으려다
//  {"err":"Opening handshake has timed out"} 로 5초마다 무한 재시도했다. 게이트웨이 로그엔 아무것도 없었다 —
//  업그레이드가 Express 를 통과하지 않아 **어떤 핸들러에도 닿지 않았기** 때문이다. 그 침묵이 진단을 가장 어렵게 했다.
import { strict as assert } from "node:assert";
import { parsePreviewWsPath, rebuildUpgradeResponse } from "./ws-proxy.js";
import { rePathCookie } from "./routes.js";

// ── 경로 분해 ──────────────────────────────────────────────────────────────
{
  assert.deepEqual(parsePreviewWsPath("/preview/p1541-lively/node/ws"),
    { id: "p1541-lively", rest: "node/ws", search: "" });
  // 웹터미널은 쿼리(세션·노드 지정)가 의미를 가진다 — 잃으면 엉뚱한 세션에 붙는다.
  assert.deepEqual(parsePreviewWsPath("/preview/p1/terminal/ws?session=box-a&node=hammurabi"),
    { id: "p1", rest: "terminal/ws", search: "?session=box-a&node=hammurabi" });
  // 중복 슬래시가 있어도 자식에겐 정규화된 경로로 간다.
  assert.equal(parsePreviewWsPath("/preview/p1//node/ws")?.rest, "node/ws");
}
// 우리 소관이 아닌 업그레이드는 **null** — 여기서 삼키면 본체의 /terminal/ws·/node/ws 가 죽는다.
{
  for (const u of ["/node/ws", "/terminal/ws?session=x", "/preview/p1", "/previews/p1/node/ws", "", "/"]) {
    assert.equal(parsePreviewWsPath(u), null, `프리뷰 경로가 아닌데 가로챘다: ${u}`);
  }
  // id 문법은 라우트(ID_CAP)와 같아야 한다 — 여기만 느슨하면 프록시가 라우트와 다른 대상을 잡는다.
  assert.equal(parsePreviewWsPath("/preview/P1541/node/ws"), null, "대문자 id 는 라우트가 안 받는다");
  assert.equal(parsePreviewWsPath("/preview/-bad/node/ws"), null, "첫 글자 하이픈은 라우트가 안 받는다");
}

// ── 101 응답 재구성 ────────────────────────────────────────────────────────
{
  const raw = ["Upgrade", "websocket", "Connection", "Upgrade", "Sec-WebSocket-Accept", "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="];
  const out = rebuildUpgradeResponse(101, "Switching Protocols", raw);
  assert.ok(out.startsWith("HTTP/1.1 101 Switching Protocols\r\n"), out);
  // 🔴 Sec-WebSocket-Accept 는 클라이언트 키에서 파생된 값이다 — 한 글자만 달라도 브라우저가 연결을 거부한다.
  assert.ok(out.includes("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), out);
  assert.ok(out.endsWith("\r\n\r\n"), "헤더 종료(빈 줄)가 없으면 클라이언트가 계속 헤더를 기다린다");
  // 헤더 이름의 대소문자는 원문 그대로(rawHeaders 를 쓰는 이유).
  assert.ok(out.includes("Upgrade: websocket"));
}
{
  // statusMessage 가 비어도 유효한 상태줄을 만든다(일부 스택은 안 준다).
  assert.ok(rebuildUpgradeResponse(101, "", []).startsWith("HTTP/1.1 101 Switching Protocols\r\n"));
  // 홀수 rawHeaders(값 없는 꼬리)에서 undefined 를 흘리지 않는다.
  assert.ok(!rebuildUpgradeResponse(101, "x", ["A", "1", "B"]).includes("undefined"));
}

// ── Set-Cookie Path 되돌리기 — WS 가 붙어도 **쿠키가 안 실리면** 소용없다 ─────────────────────
// 실측(#1541): 티켓 쿠키가 Path=/terminal 로 내려와 `/preview/<id>/terminal/ws` 요청에 실리지 않았다.
//  게이트웨이는 티켓을 못 찾아 소켓을 그냥 끊고(→502) 화면은 "재연결 중…" 만 반복했다.
//  ⚠ raw 소켓 프로브로는 재현되지 않는다(도구가 Path 를 무시하고 쿠키를 싣는다) — 그래서 오래 헤맸다.
{
  const P = "/preview/p1541-lively";
  assert.equal(rePathCookie("lively_term=abc; HttpOnly; Path=/terminal; SameSite=Lax; Max-Age=43200", P),
    "lively_term=abc; HttpOnly; Path=/preview/p1541-lively/terminal; SameSite=Lax; Max-Age=43200");
  assert.equal(rePathCookie("a=1; Path=/", P), "a=1; Path=/preview/p1541-lively/");
  assert.equal(rePathCookie("a=1; path=/x", P), "a=1; path=/preview/p1541-lively/x", "속성 이름은 대소문자 무관");
  // Path 가 없으면 건드리지 않는다 — 브라우저 기본값(요청 경로 기준)이 이미 프리뷰 안이다.
  assert.equal(rePathCookie("a=1; HttpOnly", P), "a=1; HttpOnly");
  // 라이브(접두사 없음)에선 **무변화** — 이 함수가 live 동작을 바꾸면 안 된다.
  assert.equal(rePathCookie("lively_term=abc; Path=/terminal", ""), "lively_term=abc; Path=/terminal");
  // 이미 접두사가 붙어 있으면 두 번 붙이지 않는다(재프록시·중복 호출 안전).
  assert.equal(rePathCookie("a=1; Path=/preview/p1541-lively/terminal", P), "a=1; Path=/preview/p1541-lively/terminal");
  assert.equal(rePathCookie("a=1; Path=/preview/p1541-livelyX", P), "a=1; Path=/preview/p1541-lively/preview/p1541-livelyX",
    "접두사가 '이름의 앞부분만' 같은 건 다른 경로다 — 접두사를 붙여야 한다");
}

console.log("preview/ws-proxy.test OK");
