// 노드 프로토콜(#869) 단위 테스트 — 채널 프레임 인코딩/디코딩 왕복 + 제어 파싱 + 가시성 판정.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { encodeChanFrame, decodeChanFrame, parseMsg, nodeSessionVisible, nodeCaps, agentIsLatest, NODE_OPS, NODE_BASELINE_OPS, FRAME_PTY } from "./protocol.js";

// 프레임 왕복 — 멀티바이트(UTF-8 쪼개짐 경계 포함)도 바이트 그대로 보존돼야 한다(무디코드 릴레이 불변식).
{
  const payload = Buffer.concat([Buffer.from("한글𝔘"), Buffer.from([0x00, 0xff, 0x1b]), Buffer.from("e")]);
  const f = decodeChanFrame(encodeChanFrame(7, payload));
  assert.ok(f);
  assert.equal(f.kind, FRAME_PTY);
  assert.equal(f.chan, 7);
  assert.ok(f.payload.equals(payload));
}
// 채널 id 32비트 경계.
{
  const f = decodeChanFrame(encodeChanFrame(0xfffffffe, Buffer.from("x")));
  assert.ok(f && f.chan === 0xfffffffe);
}
// 짧은 프레임 = null(크래시 금지).
assert.equal(decodeChanFrame(Buffer.from([1, 0])), null);

// 제어 파싱 — t 없는/깨진 JSON 은 null.
assert.deepEqual(parseMsg('{"t":"res","id":1,"ok":true}'), { t: "res", id: 1, ok: true });
assert.equal(parseMsg("{"), null);
assert.equal(parseMsg('{"id":1}'), null);

// 가시성 — 소유자·초대만(개인 세션 규칙). 프로젝트 전체공개 규칙은 노드 세션에 미적용(D2).
assert.equal(nodeSessionVisible({ owner: "yoon", invites: [] }, "yoon"), true);
assert.equal(nodeSessionVisible({ owner: "yoon", invites: ["jang"] }, "jang"), true);
assert.equal(nodeSessionVisible({ owner: "yoon", invites: [] }, "jang"), false);

// ── 노드 capability 선언(#905 C4) — 게이트웨이가 "이 노드가 무엇을 할 수 있나"에 답하는 근거. ──
//  이게 없으면 미지원 노드에 op 를 던지고 `unknown op: x` 라는 **문자열**을 받는다 — "미지원"과 "실패"가 구별 불가.
{
  // 🔴 구 노드 무회귀 — caps 를 안 보내는 에이전트(현재 라이브 2대 전부)는 v1 기준선 전량을 할 수 있어야 한다.
  //  여기가 깨지면 기존 노드의 세션 CRUD·attach 가 통째로 멈춘다.
  for (const missing of [undefined, null]) {
    const caps = nodeCaps(missing);
    for (const op of NODE_BASELINE_OPS) {
      assert.ok(caps.has(op), `🔴 caps 미전송 구 노드가 기준선 op '${op}' 를 못 하는 것으로 판정됨 — 기존 노드가 죽는다`);
    }
  }

  // 선언한 노드는 선언한 것만 — 기준선이라고 얹어주면 안 된다(선언은 그 빌드의 진실이다).
  const only = nodeCaps(["list", "provision"]);
  assert.ok(only.has("provision"));
  assert.ok(only.has("list"));
  assert.equal(only.has("create"), false, "선언 목록에 없는 op 를 기준선에서 끌어다 붙였다");

  // 빈 배열 = "아무것도 못 한다"는 **선언**이다. 미전송(모름)과 다르다 — 기준선으로 되살리면 안 된다.
  assert.equal(nodeCaps([]).size, 0, "빈 caps 선언을 '미전송'으로 오해해 기준선을 붙였다");

  // 🔒 기준선은 얼어 있다 — 새 op 를 여기 끼우면 **구 노드가 못 하는 걸 한다고 주장**하게 된다.
  //  NODE_OPS 는 늘어나도 되지만 기준선은 v1 그대로여야 한다. 늘리려는 diff 는 여기서 걸린다.
  assert.equal(NODE_BASELINE_OPS.length, 14, "v1 기준선이 바뀌었다 — 새 op 는 NODE_OPS_NEW 로만 넣어야 한다");
  assert.deepEqual([...NODE_BASELINE_OPS].sort(),
    ["create", "edit", "fsLs", "fsMkdir", "fsRead", "fsWrite", "gone", "kill", "label", "list", "prompts", "runTask", "tailTask", "watchTask"]);

  // 기준선 ⊆ NODE_OPS — 이 빌드가 기준선을 전부 안다(구 노드와 최소한 같은 일은 한다).
  for (const op of NODE_BASELINE_OPS) assert.ok((NODE_OPS as readonly string[]).includes(op), `NODE_OPS 에서 기준선 op '${op}' 가 사라졌다`);
}

// ── caps 로 선언한 op 는 **에이전트가 실제로 구현**해야 한다(선언과 구현의 드리프트 방지). ──
//  runOp 는 tmux 를 실제로 띄우므로 호출해서 확인할 수 없다 → 디스패치에 case 가 있는지 본다.
//  대상은 **실제로 노드에 배포되는 산출물**(같은 디렉터리의 컴파일된 agent.js) — 소스가 아니라 나가는 바이트를 본다.
//  ⚠ 모양 검사라 완벽하진 않지만, 여기서 어긋나면 **게이트웨이가 못 하는 걸 한다고 믿고 보내게 된다**.
{
  const src = readFileSync(new URL("./agent.js", import.meta.url), "utf8");
  for (const op of NODE_OPS) {
    assert.ok(src.includes(`case "${op}"`), `🔴 caps 에 '${op}' 를 선언하는데 agent.ts 에 구현(case)이 없다 — 게이트웨이가 믿고 보낸다`);
  }
}

// ── 에이전트 최신 판정은 **3상**(#905 C4) — 모르는 걸 '구버전'이라 단정하지 않는다. ──
{
  assert.equal(agentIsLatest("abc123", "abc123"), true);
  assert.equal(agentIsLatest("old999", "abc123"), false, "다른 바이트인데 최신이라 했다");

  // 🔴 판정 불가는 null 이어야 한다. 지금 라이브 노드 2대가 정확히 이 상태(구 번들 → agentVer 미전송)라,
  //  false 로 뭉개면 관리탭이 근거 없이 전원 "구버전 · 업데이트 필요"라고 거짓말한다.
  assert.equal(agentIsLatest(null, "abc123"), null, "🔴 agentVer 를 안 보낸 구 노드를 '구버전'이라 단정했다");
  assert.equal(agentIsLatest(undefined, "abc123"), null);
  assert.equal(agentIsLatest("abc123", null), null, "🔴 번들이 없어 서빙본을 모르는데 노드를 '구버전'이라 단정했다");
  assert.equal(agentIsLatest(null, null), null);
  assert.equal(agentIsLatest("", "abc123"), null, "빈 문자열은 '모름'이다 — 최신 아님으로 단정하면 안 된다");
}

console.log("node/protocol.test OK");
