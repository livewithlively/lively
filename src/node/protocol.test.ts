// 노드 프로토콜(#869) 단위 테스트 — 채널 프레임 인코딩/디코딩 왕복 + 제어 파싱 + 가시성 판정.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { encodeChanFrame, decodeChanFrame, parseMsg, nodeSessionVisible, projectNodeSession, nodeCaps, agentIsLatest, nodeHarnesses, NODE_BASELINE_HARNESSES, nodeWsUrl, NODE_OPS, NODE_BASELINE_OPS, FRAME_PTY } from "./protocol.js";

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
  assert.ok((NODE_OPS as readonly string[]).includes("injectFirstPrompt"), "프로젝트 DB 바인딩 뒤 첫 지시를 넣는 노드 op가 필요하다");
  for (const op of ["stageWorkerChunk", "startWorker", "workerStatus", "stopWorker"]) {
    assert.ok((NODE_OPS as readonly string[]).includes(op), `worker op '${op}' 가 capability 목록에 없다`);
    assert.ok(!(NODE_BASELINE_OPS as readonly string[]).includes(op), `구 노드가 못 하는 worker op '${op}' 를 기준선에 넣었다`);
  }
}

// ── caps 로 선언한 op 는 **에이전트가 실제로 구현**해야 한다(선언과 구현의 드리프트 방지). ──
//  runOp 는 tmux 를 실제로 띄우므로 호출해서 확인할 수 없다 → 디스패치에 case 가 있는지 본다.
//  대상은 **실제로 노드에 배포되는 산출물**(컴파일된 .js) — 소스가 아니라 나가는 바이트를 본다.
//  ⚠ 모양 검사라 완벽하진 않지만, 여기서 어긋나면 **게이트웨이가 못 하는 걸 한다고 믿고 보내게 된다**.
//
//  ★ #2600 T1 — 디스패치가 **두 파일**로 갈렸다. `agent.js` 는 전송 어댑터라 노드 전용 op(파일·위탁
//   태스크·앱 워커·provision·대화)만 갖고, 세션 op 는 `terminal/session-ops.js` 한 곳이 갖는다
//   (매니지드 세션 호스트 #2600 T2 가 같은 표를 쓴다). 둘 다 노드 번들에 실리므로 **합집합**을 본다 —
//   불변식은 «선언한 op 는 노드에 실려 나가는 바이트 안에 구현이 있다» 로 그대로다.
{
  const shipped = [
    new URL("./agent.js", import.meta.url),
    new URL("../terminal/session-ops.js", import.meta.url),
  ].map((u) => readFileSync(u, "utf8")).join("\n");
  for (const op of NODE_OPS) {
    assert.ok(shipped.includes(`case "${op}"`),
      `🔴 caps 에 '${op}' 를 선언하는데 노드에 실려 나가는 코드에 구현(case)이 없다 — 게이트웨이가 믿고 보낸다`);
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

// ── 노드가 띄울 수 있는 하네스(#1713) — caps 와 같은 원칙: **모르면 못 한다고 본다.** ──
//  이 값이 없어서 생긴 실제 증상: 게이트웨이가 antigravity 를 지원해도, 그 PC 의 노드가 옛 번들이면
//  세션 만들기가 502("허용되지 않은 하네스")로 튕겼고 사용자는 [생성하기]를 누른 뒤에야 알았다.
{
  assert.deepEqual(nodeHarnesses(["claude", "antigravity"]), ["claude", "antigravity"], "보고한 목록을 그대로 쓴다");
  assert.deepEqual(nodeHarnesses(["claude", "claude"]), ["claude"], "중복은 접는다");

  // 🔴 미보고 = 구 번들이다. 그 빌드가 실제로 알던 것(기준선)으로 봐야 한다 — 최신 목록으로 넘겨짚으면
  //  그 노드가 못 여는 하네스를 폼에 띄우고, 사용자는 다시 [생성하기] 뒤에 502 를 본다.
  assert.deepEqual(nodeHarnesses(undefined), [...NODE_BASELINE_HARNESSES], "🔴 미보고를 최신 목록으로 넘겨짚었다");
  assert.deepEqual(nodeHarnesses(null), [...NODE_BASELINE_HARNESSES]);
  assert.deepEqual(nodeHarnesses([]), [...NODE_BASELINE_HARNESSES], "빈 배열도 '모름'이다(보고 실패)");
  assert.deepEqual(nodeHarnesses([null, 1, ""] as unknown as string[]), [...NODE_BASELINE_HARNESSES], "잡값만 오면 기준선");

  // 🔴 기준선은 **옛 빌드가 실제로 알던 것**이다. 여기에 새 하네스를 끼워 넣으면 구 노드가 못 하는 걸
  //  한다고 주장하게 된다(caps 의 NODE_OPS_V1 과 같은 함정 — 그쪽 주석 참조).
  assert.deepEqual([...NODE_BASELINE_HARNESSES], ["claude", "codex", "shell"], "🔴 기준선을 늘렸다 — 구 노드가 못 여는 하네스를 주장하게 된다");
}

// ── 노드 WSS 주소 — **베이스경로를 보존**해야 한다(#1541 실측 회귀). ──
//  프리뷰(서브패스)에 등록한 노드가 운영으로 붙어버린 사고의 재발 방지. 등록한 곳과 붙는 곳이 갈리면
//  노드는 "연결됨" 을 찍는데 브라우저에선 안 보이고 attach 가 무한 재시도한다 — 가장 진단하기 어려운 실패다.
{
  assert.equal(nodeWsUrl("https://dev.lvly.io"), "wss://dev.lvly.io/node/ws");
  assert.equal(nodeWsUrl("https://dev.lvly.io/"), "wss://dev.lvly.io/node/ws", "루트 슬래시가 //node/ws 를 만들면 안 된다");
  assert.equal(nodeWsUrl("http://127.0.0.1:8080"), "ws://127.0.0.1:8080/node/ws", "평문은 ws: 로");
  // 🔴 이게 그 버그다 — pathname 을 덮어써 접두사가 날아가면 다른 게이트웨이에 붙는다.
  assert.equal(nodeWsUrl("https://dev.lvly.io/preview/p1541-lively"), "wss://dev.lvly.io/preview/p1541-lively/node/ws",
    "🔴 서브패스 게이트웨이의 베이스경로가 날아갔다 — 프리뷰 노드가 운영에 붙는다");
  assert.equal(nodeWsUrl("https://dev.lvly.io/preview/p1541-lively/"), "wss://dev.lvly.io/preview/p1541-lively/node/ws");
  // 쿼리·프래그먼트는 붙이지 않는다(업그레이드 요청에 의미 없고, 토큰이 실릴 여지를 남기지 않는다).
  assert.equal(nodeWsUrl("https://dev.lvly.io/preview/x?a=1#f"), "wss://dev.lvly.io/preview/x/node/ws");
}

// ─────────────────────────────────────────────────────────────────────────────
// projectNodeSession — 노드 세션 스냅샷의 목록 행 투영 규칙
// ─────────────────────────────────────────────────────────────────────────────

// [규칙 1] owned 는 s.owner === viewer 로 계산 — 스냅샷에 박힌 owned 값보다 이긴다
{
  const stale = {
    id: "s-owned-1",
    owner: "alice",
    invites: [],
    owned: true, // 스냅샷에 남아 있는 남의 기준 값 — bob 이 보면 거짓이어야 한다
  } as unknown as Parameters<typeof projectNodeSession>[0];
  const row = projectNodeSession(stale, true, "bob") as unknown as Record<string, unknown>;
  assert.equal(
    row.owned,
    false,
    "🔴 스냅샷에 owned=true 가 박혀 있어도 owner!==viewer 면 owned=false 로 재계산돼야 한다"
  );

  const mine = {
    id: "s-owned-2",
    owner: "bob",
    invites: [],
    owned: false, // 반대 방향: 스냅샷 owned=false 도 뷰어 기준 계산이 이긴다
  } as unknown as Parameters<typeof projectNodeSession>[0];
  const row2 = projectNodeSession(mine, true, "bob") as unknown as Record<string, unknown>;
  assert.equal(
    row2.owned,
    true,
    "🔴 owner===viewer 면 스냅샷에 owned=false 가 있어도 owned=true 로 재계산돼야 한다"
  );
}

// [규칙 2] 온라인이면 라이브 신호 넷(agentState·attached·working·awaiting)을 스냅샷 값 그대로 싣는다
{
  const s = {
    id: "s-live",
    owner: "alice",
    invites: [],
    agentState: "busy",
    attached: true,
    working: true,
    awaiting: true,
  } as unknown as Parameters<typeof projectNodeSession>[0];
  const row = projectNodeSession(s, true, "alice") as unknown as Record<string, unknown>;
  assert.equal(row.agentState, "busy", "온라인 노드의 agentState 는 스냅샷 값 그대로여야 한다");
  assert.equal(row.attached, true, "온라인 노드의 attached 는 스냅샷 값 그대로여야 한다");
  assert.equal(row.working, true, "온라인 노드의 working 은 스냅샷 값 그대로여야 한다");
  assert.equal(
    row.awaiting,
    true,
    "🔴 온라인 노드의 awaiting=true 를 접으면 진짜 '확인 필요' 세션이 숨는다 — 그대로 실려야 한다"
  );

  // 온라인 + 거짓/한산한 값도 발명 없이 그대로
  const idle = {
    id: "s-live-idle",
    owner: "alice",
    invites: [],
    agentState: "idle",
    attached: false,
    working: false,
    awaiting: false,
  } as unknown as Parameters<typeof projectNodeSession>[0];
  const idleRow = projectNodeSession(idle, true, "alice") as unknown as Record<string, unknown>;
  assert.equal(idleRow.agentState, "idle", "온라인이면 agentState 를 다른 값으로 바꾸면 안 된다");
  assert.equal(idleRow.attached, false, "온라인 attached=false 도 그대로여야 한다");
  assert.equal(idleRow.working, false, "온라인 working=false 도 그대로여야 한다");
  assert.equal(idleRow.awaiting, false, "온라인 awaiting=false 도 그대로여야 한다");
}

// [규칙 3] 오프라인이면 라이브 신호 넷을 전부 접는다 — 하나라도 살아남으면 사고 재발
{
  const frozen = {
    id: "s-frozen",
    owner: "alice",
    invites: [],
    agentState: "busy",
    attached: true,
    working: true,
    awaiting: true,
  } as unknown as Parameters<typeof projectNodeSession>[0];
  const row = projectNodeSession(frozen, false, "alice") as unknown as Record<string, unknown>;
  assert.equal(
    row.agentState,
    "offline",
    '🔴 오프라인이면 agentState 는 원래 값이 무엇이었든 "offline" 로 강제돼야 한다'
  );
  assert.equal(row.attached, false, "🔴 오프라인이면 attached 는 false 로 접혀야 한다");
  assert.equal(row.working, false, "🔴 오프라인이면 working 은 false 로 접혀야 한다");
  assert.equal(
    row.awaiting,
    false,
    "🔴 오프라인이면 awaiting 은 false 로 접혀야 한다 — 얼어붙은 awaiting 이 '지금 볼 것'에 영구 고정되면 안 된다"
  );
}

// [규칙 4] 라이브 신호 넷과 owned 를 제외한 모든 필드는 온라인/오프라인 무관 무변 통과
{
  const base = {
    id: "s-pass",
    owner: "alice",
    invites: ["bob", "carol"],
    label: "야간 배치 세션",
    harness: "claude-code",
    lastActive: 1725100000000,
    cwd: "/home/alice/work", // 사양에 열거되지 않은 임의 통과 필드
    agentState: "waiting",
    attached: false,
    working: false,
    awaiting: false,
  };
  for (const online of [true, false]) {
    const s = { ...base, invites: [...base.invites] } as unknown as Parameters<
      typeof projectNodeSession
    >[0];
    const row = projectNodeSession(s, online, "bob") as unknown as Record<string, unknown>;
    assert.equal(row.id, "s-pass", `id 는 무변 통과여야 한다 (online=${online})`);
    assert.equal(row.label, "야간 배치 세션", `label 은 무변 통과여야 한다 (online=${online})`);
    assert.equal(row.harness, "claude-code", `harness 는 무변 통과여야 한다 (online=${online})`);
    assert.equal(
      row.lastActive,
      1725100000000,
      `🔴 lastActive 는 무변 통과여야 한다 — 오프라인 접기가 다른 필드까지 갈아엎으면 안 된다 (online=${online})`
    );
    assert.equal(
      row.cwd,
      "/home/alice/work",
      `사양에 없는 임의 필드(cwd)도 무변 통과여야 한다 (online=${online})`
    );
    assert.equal(row.owner, "alice", `owner 는 무변 통과여야 한다 (online=${online})`);
    assert.deepEqual(
      row.invites,
      ["bob", "carol"],
      `invites 는 무변 통과여야 한다 (online=${online})`
    );
  }
}

// [규칙 5] 입력 불변 — s 를 제자리 변형하지 않고 새 객체를 돌려준다 (스냅샷은 게이트웨이 공유 상태)
{
  // (a) 오프라인 접기가 일어나는 경우: 접힌 값이 입력으로 역류하면 다른 소비자가 오염된다
  const s = {
    id: "s-shared",
    owner: "alice",
    invites: ["bob"],
    agentState: "busy",
    attached: true,
    working: true,
    awaiting: true,
    label: "공유 스냅샷",
  } as unknown as Parameters<typeof projectNodeSession>[0];
  const before = JSON.parse(JSON.stringify(s));
  const row = projectNodeSession(s, false, "bob");
  assert.notEqual(
    row as unknown,
    s as unknown,
    "🔴 반환 행은 입력과 다른 새 객체여야 한다 — 공유 스냅샷 제자리 변형 금지"
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(s)),
    before,
    "🔴 호출 후에도 입력 스냅샷 s 는 한 필드도 바뀌지 않아야 한다"
  );
  const sAny = s as unknown as Record<string, unknown>;
  assert.equal(
    sAny.awaiting,
    true,
    "🔴 입력 s.awaiting 은 여전히 true 여야 한다 — 접기는 반환 행에서만 일어난다"
  );
  assert.equal(sAny.agentState, "busy", '입력 s.agentState 는 여전히 "busy" 여야 한다');
  assert.equal(sAny.attached, true, "입력 s.attached 는 여전히 true 여야 한다");
  assert.equal(sAny.working, true, "입력 s.working 은 여전히 true 여야 한다");

  // (b) 온라인 + 스냅샷에 owned 없음: owned 계산 결과를 입력에 써넣으면 안 된다
  const noOwned = {
    id: "s-no-owned",
    owner: "bob",
    invites: [],
  } as unknown as Parameters<typeof projectNodeSession>[0];
  const row2 = projectNodeSession(noOwned, true, "bob") as unknown as Record<string, unknown>;
  assert.equal(row2.owned, true, "반환 행에는 계산된 owned 가 실려야 한다");
  assert.ok(
    !("owned" in (noOwned as unknown as Record<string, unknown>)),
    "🔴 owned 계산 결과가 입력 스냅샷 객체에 써넣어지면 안 된다(입력 불변)"
  );
}

// [엣지 1] 오프라인 + awaiting=true — 실증 사고의 핵심 케이스: 반드시 false 로 접힌다
{
  const s = {
    id: "s-accident",
    owner: "alice",
    invites: [],
    awaiting: true,
  } as unknown as Parameters<typeof projectNodeSession>[0];
  const row = projectNodeSession(s, false, "alice") as unknown as Record<string, unknown>;
  assert.equal(
    row.awaiting,
    false,
    "🔴 잠든 노드의 얼어붙은 awaiting=true 가 살아남으면 아무도 답할 수 없는 세션이 '확인 필요'로 「지금 볼 것」에 영구 고정된다"
  );
}

// [엣지 2] 오프라인 + working=true → working=false
{
  const s = {
    id: "s-working",
    owner: "alice",
    invites: [],
    working: true,
  } as unknown as Parameters<typeof projectNodeSession>[0];
  const row = projectNodeSession(s, false, "alice") as unknown as Record<string, unknown>;
  assert.equal(
    row.working,
    false,
    "🔴 잠든 노드의 얼어붙은 working=true 가 살아남으면 죽은 세션이 '작업 중'으로 잘못 분류된다"
  );
}

// [엣지 3] 오프라인인데 스냅샷 agentState 가 이미 "offline" → 그대로 "offline" (무해·멱등)
{
  const s = {
    id: "s-already-off",
    owner: "alice",
    invites: [],
    agentState: "offline",
    attached: false,
    working: false,
    awaiting: false,
  } as unknown as Parameters<typeof projectNodeSession>[0];
  const row = projectNodeSession(s, false, "alice") as unknown as Record<string, unknown>;
  assert.equal(
    row.agentState,
    "offline",
    'agentState 가 이미 "offline" 인 스냅샷은 그대로 "offline" 이어야 한다(무해)'
  );
  assert.equal(row.attached, false, "이미 접힌 attached=false 도 false 유지");
  assert.equal(row.working, false, "이미 접힌 working=false 도 false 유지");
  assert.equal(row.awaiting, false, "이미 접힌 awaiting=false 도 false 유지");
}

// [엣지 4] viewer 가 owner 도 초대자도 아님 — 함수는 가리지 않는다(가시성 필터는 호출자 소관), owned=false 로만 표시
{
  const s = {
    id: "s-visible",
    owner: "alice",
    invites: ["bob"],
    label: "남의 세션",
    agentState: "busy",
    working: true,
  } as unknown as Parameters<typeof projectNodeSession>[0];
  const row = projectNodeSession(s, true, "mallory") as unknown as Record<string, unknown>;
  assert.ok(
    row !== null && row !== undefined && typeof row === "object",
    "🔴 뷰어가 owner 도 초대자도 아니어도 함수는 행을 그대로 돌려줘야 한다 — 가시성 필터는 호출자 소관"
  );
  assert.equal(row.id, "s-visible", "행 내용은 가시성과 무관하게 그대로 투영돼야 한다");
  assert.equal(row.owned, false, "owner 가 아니므로 owned=false 로만 표시된다");
  assert.equal(row.agentState, "busy", "가시성과 무관하게 온라인 라이브 신호는 그대로 실린다");
  assert.equal(row.working, true, "가시성과 무관하게 온라인 working 도 그대로 실린다");
}

// [엣지 5a] 라이브 신호 필드가 스냅샷에 아예 없음 + 온라인 — undefined 유지 허용:
// 참(true)으로 발명하거나 "offline" 로 접으면 안 된다
{
  const s = {
    id: "s-undef-on",
    owner: "alice",
    invites: [],
    // agentState / attached / working / awaiting 전부 없음
  } as unknown as Parameters<typeof projectNodeSession>[0];
  const row = projectNodeSession(s, true, "alice") as unknown as Record<string, unknown>;
  assert.notEqual(
    row.agentState,
    "offline",
    '🔴 온라인인데 agentState 없음을 "offline" 로 접으면 살아있는 세션이 죽은 것처럼 보인다'
  );
  assert.ok(
    row.attached !== true,
    "온라인 + 스냅샷에 attached 없음 → attached 를 true 로 발명하면 안 된다(undefined 유지 허용)"
  );
  assert.ok(
    row.working !== true,
    "온라인 + 스냅샷에 working 없음 → working 을 true 로 발명하면 안 된다(undefined 유지 허용)"
  );
  assert.ok(
    row.awaiting !== true,
    "🔴 온라인 + 스냅샷에 awaiting 없음 → awaiting 을 true 로 발명하면 가짜 '확인 필요'가 생긴다"
  );
}

// [엣지 5b] 라이브 신호 필드가 스냅샷에 아예 없음 + 오프라인 — 규칙 3 의 강제값(false/"offline")으로 채운다
{
  const s = {
    id: "s-undef-off",
    owner: "alice",
    invites: [],
    // agentState / attached / working / awaiting 전부 없음
  } as unknown as Parameters<typeof projectNodeSession>[0];
  const row = projectNodeSession(s, false, "alice") as unknown as Record<string, unknown>;
  assert.equal(
    row.agentState,
    "offline",
    '🔴 오프라인 + agentState 없음 → undefined 로 두지 말고 "offline" 로 채워져야 한다'
  );
  assert.equal(row.attached, false, "오프라인 + attached 없음 → false 로 강제돼야 한다");
  assert.equal(row.working, false, "오프라인 + working 없음 → false 로 강제돼야 한다");
  assert.equal(row.awaiting, false, "🔴 오프라인 + awaiting 없음 → false 로 강제돼야 한다");
}

console.log("node/protocol.test OK");
