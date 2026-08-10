// 프리뷰 WS 중계(#1541) — 경로 분해 + 101 응답 재구성의 계약.
//
// 계기(실측): 프리뷰에 등록한 윈도우 노드가 `wss://…/preview/p1541-lively/node/ws` 로 붙으려다
//  {"err":"Opening handshake has timed out"} 로 5초마다 무한 재시도했다. 게이트웨이 로그엔 아무것도 없었다 —
//  업그레이드가 Express 를 통과하지 않아 **어떤 핸들러에도 닿지 않았기** 때문이다. 그 침묵이 진단을 가장 어렵게 했다.
import { strict as assert } from "node:assert";
import { parsePreviewWsPath, rebuildUpgradeResponse } from "./ws-proxy.js";

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

console.log("preview/ws-proxy.test OK");
