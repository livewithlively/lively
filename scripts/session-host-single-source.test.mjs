#!/usr/bin/env node
// ★구조 불변식 — **세션을 소유하는 살림은 한 곳이고, 어댑터는 전송만 갖는다** (#2600 T1).
//
//  이 시험이 없으면 무엇이 되돌아오나: 어댑터가 «조금만» 자기 살림을 다시 갖기 시작한다. 종전이 정확히
//   그랬다 — `attach-worker-entry` 에만 유휴 자진 종료가 있고 `node/agent` 엔 없었는데, 그게 «노드는
//   상주해야 한다»는 판단인지 그냥 안 적은 것인지 **코드로 구별할 수 없었다.** 완료 조건의 «grep 으로
//   보인다» 를 사람 눈이 아니라 시험으로 옮긴 것이 이 파일이다.
//
//  실행: node scripts/session-host-single-source.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/**
 * 주석을 걷어낸 **코드만**. 이 레포는 주석이 두껍고(그게 규율이다) 그 안에서 함수 이름을 그대로
 *  인용한다 — `attachSession(tmux -CC …)을 재사용한다` 같은 문장이 실제 호출로 잡히면 이 시험은
 *  «산문을 읽고» 빨간불을 낸다. 구조 시험은 코드를 봐야 한다.
 *  (문자열 안의 `//` 을 주석으로 오인하지 않도록 따옴표 상태를 따라간다.)
 *
 * ⚠ **한계를 알고 쓴다**(정교한 척하지 않는다): 블록 주석을 먼저 지우므로 문자열 안의 `/*` 가 코드를
 *  먹고, 따옴표 상태를 **줄 단위로** 초기화하므로 여러 줄 템플릿 리터럴·정규식 리터럴 안의 `//` 를
 *  주석으로 오인한다. 그리고 아래 S2~S4 는 전부 **부정 grep** 이라 `import { attachSession as raw }`
 *  같은 재명명 한 줄이면 조용히 통과한다. 이건 «되돌아오는 것을 막는 울타리» 지 증명이 아니다 —
 *  대상 파일들이 그런 모양을 안 쓰기 때문에 오늘은 정확하다.
 */
function code(rel) {
  const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, " ");   // 블록 주석
  return src.split("\n").map((line) => {
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
    }
    return line;
  }).join("\n");
}

const HOST = "src/terminal/session-host.ts";
const OPS = "src/terminal/session-ops.ts";
const FD_ADAPTER = "src/terminal/attach-worker-entry.ts";   // 같은 호스트 — fd 이관
const WS_ADAPTER = "src/node/agent.ts";                     // 다른 호스트 — WS 중계
const REGISTRY = "src/node/registry.ts";                    // 게이트웨이 — 노드 연결·스냅샷 캐시
const GW_INPROC = "src/terminal/terminal-pty-upgrade.ts";   // 게이트웨이 인프로세스(워커 실패 시 폴백)
//  ⚠ 이 파일은 «구현이 한 곳인가» 만 본다. «그 구현이 노드에 실제로 실려 나가는가» 는 다른 가드의 몫이다
//   (`scripts/node-agent-allowed-modules.json` + `scripts/node-agent-bundle-boundary.test.mjs`, 그리고
//   `src/node/protocol.test.ts` 의 «선언한 op 는 구현이 있다»). op 를 셋째 파일로 또 쪼개면 **그 셋을 함께**
//   고쳐야 한다 — 서로를 모르는 가드라 하나만 고치면 조용히 어긋난다.
//  attach 를 소유하는 **세 자리**. 셋 다 같은 모듈을 써야 «마지막 소켓» 판정이 한 벌이 된다 —
//   게이트웨이 폴백이 빠지면 그 세션의 장부가 라우터에 안 이어져 sticky 가 깨진다(불변식 3ᵍ).
const ADAPTERS = [FD_ADAPTER, WS_ADAPTER, GW_INPROC];

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

// ── S1: 두 어댑터가 세션 호스트를 통해서만 attach 를 소유한다 ────────────────
t("[S1] attach 를 소유하는 세 자리가 전부 세션 호스트를 쓴다", () => {
  for (const f of ADAPTERS) {
    assert.match(read(f), /from "\.\.?\/(terminal\/)?session-host\.js"/,
      `${f} 가 세션 호스트를 안 쓴다 — 살림을 자기가 다시 갖고 있다는 뜻이다`);
  }
});

t("[S2] 세 자리 어디도 attach 본체(attachSession)를 직접 부르지 않는다", () => {
  for (const f of ADAPTERS) {
    assert.ok(!/\battachSession\s*\(/.test(code(f)),
      `${f} 가 attachSession 을 직접 부른다 — 그러면 장부(마지막 소켓·유휴·회수)가 그 파일로 새어 나간다`);
  }
});

t("[S3] 어댑터는 PTY 일괄 회수(killAttachedPtys)를 직접 부르지 않는다", () => {
  for (const f of ADAPTERS) {
    assert.ok(!/\bkillAttachedPtys\s*\(/.test(code(f)),
      `${f} 가 PTY 회수를 직접 한다 — 종료 불변식이 두 벌이 된다(#687)`);
  }
});

// ── S4: 세션 op 구현이 한 곳이다 ────────────────────────────────────────────
//  게이트웨이(HTTP 라우트)는 정책 판정을 얹어 코어 함수를 직접 부른다 — 그건 «호스트가 실행하는 op» 가
//  아니라 «정책 경로» 라 이 표의 대상이 아니다. 여기서 막는 것은 **전송 어댑터**가 op 를 다시 구현하는 것이다.
//  ⚠ `listSessionsRaw` 는 **일부러 뺐다** — 세션 op(`list`)의 구현이면서 동시에 WS 중계 어댑터가
//   3초 상태 push(`pushState`)에 **정당하게** 쓴다. 넣으면 그 정당한 사용까지 빨간불이 된다.
//   나머지 11 종은 어댑터가 부를 이유가 없다.
const OP_IMPLS = [
  "createSession", "killSession", "editSession", "applyValidatedInvites",
  "sendKeysToSession", "injectFirstPrompt", "applySessionProject",
  "markSessionActive", "markSessionSeen", "getSessionLabel", "sessionGone",
];

t("[S4] WS 중계 어댑터가 세션 op 를 다시 구현하지 않는다", () => {
  const src = code(WS_ADAPTER);
  const leaked = OP_IMPLS.filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(src));
  assert.deepEqual(leaked, [],
    `${WS_ADAPTER} 가 세션 op 를 직접 부른다: ${leaked.join(", ")} — 표는 ${OPS} 한 곳이다`);
});

t("[S5] 세션 op 구현은 session-ops.ts 안에 있다", () => {
  const src = code(OPS);
  for (const fn of OP_IMPLS) {
    assert.ok(new RegExp(`\\b${fn}\\s*\\(`).test(src), `${OPS} 에 ${fn} 호출이 없다 — 표가 비었다`);
  }
});

// ── S6: 층을 가른 이유가 유지된다(워커의 import 최소 규율) ──────────────────
//  attach 워커의 존재 이유는 «이벤트루프에 attach 말고 아무 일도 없게» 다(#2228). 세션 op 층은 DB 표면을
//  끌어오므로 워커가 그걸 import 하는 순간 그 규율이 깨진다 — 그래서 층이 둘이다.
t("[S6] fd 어댑터는 세션 op 층을 import 하지 않는다", () => {
  assert.ok(!/session-ops\.js/.test(code(FD_ADAPTER)),
    `${FD_ADAPTER} 가 세션 op 층을 끌어왔다 — 워커가 DB 표면을 상속한다(#2228 격리 취지)`);
});

t("[S7] 세션 호스트는 테넌시를 import 하지 않는다(어댑터가 실어 준다)", () => {
  assert.ok(!/tenant-context\.js/.test(code(HOST)),
    `${HOST} 가 테넌시를 끌어왔다 — 노드 번들과 워커가 그 무게를 함께 진다`);
});

// ── S7b: 승인 조건 B① — 세션 호스트는 **정본을 만들지 않는다** ─────────────
//  세션 수명주기의 정본은 게이트웨이 DB(desired) 이고 세션 호스트가 만드는 것은 observed 뿐이다
//  (`sessions/session-desired.ts` 머리말의 두 축). 그래서 이 층에 DB 표면이 있으면 안 된다 —
//  #2600 T2 가 이 호스트를 «DB 자격이 없는» 노드 박스에 올리므로, 여기서 DB 를 쓰기 시작하면
//  그 배치가 성립하지 않는다. 「grep 으로 보인다」를 시험으로 옮긴 것.
t("[S7b] 세션 호스트 층에 DB 표면이 없다(정본은 게이트웨이 DB)", () => {
  const imports = code(HOST).split("\n").filter((l) => /^import\s/.test(l)).join("\n");
  assert.ok(!/["']\.\.\/(db|items|v6)\//.test(imports),
    `${HOST} 가 DB 표면을 끌어왔다 — 세션 호스트는 observed 만 보고한다(승인 조건 B①)`);
});

// ── S8: fail-open 안전판이 남아 있다(T0 중단 기준 6) ────────────────────────
//  «전송 둘» 로 줄이면서 인프로세스 폴백을 지우면 매니지드 공유 게이트웨이의 폭발 반경이 커진다.
//  T1 은 그 갈래를 건드리지 않는다 — 이 시험이 그 약속이다.
t("[S8] 게이트웨이의 인프로세스 attach 폴백(fail-open)이 그대로 있다", () => {
  const src = code(GW_INPROC);
  assert.match(src, /attachWorkerHost\.handoff/, "fd 이관 갈래가 사라졌다");
  assert.match(src, /\bgatewayHost\.attach\s*\(/,
    "인프로세스 폴백이 사라졌다 — 워커 실패 시(K=0·상한·fork 실패) attach 가 통째로 깨진다");
});

// ── S8b: 불변식 3ᵍ — 폴백도 sticky 다 ───────────────────────────────────────
//  실측 결함(2026-09-03): 같은 세션이 워커와 게이트웨이에 나뉘어 붙으면, `attachRefs` 가 프로세스마다
//  따로라 양쪽이 «내가 마지막» 으로 오판한다 → 먼저 닫힌 쪽이 `detach-client -s` 를 쏴 **살아 있는 다른
//  화면까지 끊는다**(워커1+게이트웨이1 = tmux 클라 2 → 게이트웨이만 닫으니 0). 배선 셋이 다 있어야 막힌다.
t("[S8b] 폴백이 sticky 하다 — 게이트웨이 소유 표시·거절·해제 셋이 다 이어져 있다", () => {
  const host = code("src/terminal/attach-worker-host.ts");
  assert.match(host, /isGatewayOwned\([^)]*\)\s*\)\s*return false/,
    "게이트웨이 소유 세션을 워커로 보내면 장부가 갈린다");
  assert.match(host, /claimForGateway\(/, "폴백했는데 소유 표시를 안 하면 다음 attach 가 워커로 간다");
  const gw = code(GW_INPROC);
  assert.match(gw, /onSessionEmpty[\s\S]{0,80}releaseSession/,
    "세션이 비어도 소유가 안 풀리면 그 세션은 영영 워커로 못 간다");
});

// ── S9: shutdown 은 **끝나는 길에서만** 부른다 ──────────────────────────────
//  ⚠ 이건 T1 이 **새로 만든** 위험이다. 종전 `killAttachedPtys()` 는 몇 번을 불러도 무해했지만
//   `SessionHost.shutdown()` 은 «영구 정지» 다(그 뒤 도착한 소켓을 즉시 닫는다 — 시험 9행).
//   그래서 WS 중계 어댑터의 **재연결 경로**(링크가 끊겼다 다시 붙는 정상 흐름)에서 이걸 부르면,
//   그 PC 의 노드는 첫 끊김 이후 **영영 attach 를 안 받는다.** 로그도 안 남고 프로세스는 살아 있어
//   가장 진단하기 어려운 종류의 고장이 된다.
//   ⇒ 규칙: `shutdown()` 뒤 몇 줄 안에 `process.exit(` 가 있어야 한다(= 끝나는 길이다).
t("[S9] WS 중계 어댑터의 shutdown() 은 종료 경로에서만 불린다", () => {
  const src = code(WS_ADAPTER);
  // 인스턴스 이름을 **소스에서 읽는다** — 이름을 박아 두면 rename 한 번에 이 시험이 «호출이 없다» 로
  //  거짓 통과/실패한다(실제로 그렇게 한 번 잡혔다). 같은 파일의 `nodeWorkerHost.shutdown()` 과도 섞이면 안 된다.
  const inst = (src.match(/const\s+(\w+)\s*=\s*new SessionHost\(/) ?? [])[1];
  assert.ok(inst, `${WS_ADAPTER} 에 SessionHost 인스턴스가 없다 — 어댑터가 살림을 자기가 갖고 있다`);
  const lines = src.split("\n");
  const calls = lines.map((l, i) => [l, i]).filter(([l]) => new RegExp(`\\b${inst}\\.shutdown\\s*\\(`).test(l));
  assert.ok(calls.length > 0, "shutdown 호출이 아예 없다 — 종료 시 PTY 가 고아로 남는다(#687)");
  for (const [, i] of calls) {
    // 6줄 = 오늘 두 종료 블록의 최대 길이(shutdown → keepAwake.stop → worker shutdown → exit)에 여유 하나.
    //  종료 블록이 더 길어지면 이 시험이 거짓 실패하는데, 그때는 창을 넓히기보다 **exit 를 shutdown 가까이**
    //  두는 쪽이 맞다 — 둘 사이가 멀어질수록 «종료 경로가 맞나» 가 사람 눈으로도 안 보이게 된다.
    const near = lines.slice(i, i + 6).join("\n");
    assert.match(near, /process\.exit\s*\(/,
      `${WS_ADAPTER}:${i + 1} 의 shutdown() 뒤에 process.exit 이 없다 — 재연결 경로에서 불리면 `
      + "그 노드는 첫 끊김 이후 영영 attach 를 안 받는다");
  }
});

// ── S10: 「답 기다림」 알림 스윕의 **목록 출처**를 호출부가 정하지 않는다 (#2600 T2 d4) ──
//  실측 사고(2026-09-08): 이 스윕은 **두 자리에서** 돈다 — 하우스키핑 30초 타이머와 매니지드의 요청
//   정비표(`sessions/outbox-request-sweep.ts`, 같은 30초 간격). 「세션 호스트가 있으면 노드 스냅샷에서
//   읽는다」를 **호출부에** 심었더니 한 자리만 고쳐졌고, 나머지가 종전대로 게이트웨이 tmux 를 계속 읽었다.
//   계수는 줄지 않았는데 커밋 메시지에는 «64% 가 사라진다» 고 적혀 있었다.
//  ⇒ 규칙: 출처 판정은 `sweepAwaitingNotifications` **안**에 있고, 호출부는 인자를 안 넘긴다.
//   (시험은 `deps` 로 주입한다 — 그래서 `*.test.ts` 는 대상이 아니다.)
const NOTIFIER = "src/sessions/awaiting-notifier.ts";

t("[S10] 알림 스윕의 목록 출처 판정이 스윕 안에 있다", () => {
  const src = code(NOTIFIER);
  assert.match(src, /gatewayDefersHere\(/,
    `${NOTIFIER} 가 출처를 스스로 정하지 않는다 — 그러면 호출부마다 판정이 갈린다`);
});

// ── S10c: «놓나» 판정의 **조립**도 한 곳이다 (#2600 T2 d6) ──────────────────
//  `gatewayDefersToSessionHost(sessionHostsInScope(), NODE_STATE_STALE_MS)` 라는 똑같은 한 줄이 세 곳에
//   있었다(목록 라우트·프로젝트 라우트·알림 스윕). 술어가 순수해도 **재료를 모으는 줄이 세 벌이면** 신선도
//   자를 하나만 바꿔도 셋이 갈린다. 그래서 조립은 `registry.gatewayDefersHere()` 한 곳이고, 거기서만
//   순수 술어를 부른다(그 자리가 판정 계수도 함께 낸다 — 어긋남을 로그로 볼 수 있어야 한다).
t("[S10c] 판정 조립(술어 + 스코프 수집)은 registry 한 곳뿐이다", () => {
  const files = readdirSync(join(ROOT, "src"), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join("src", f));
  //  술어 이름이 둘이다(`gatewayDefersToSessionHost` = 불리언 · `sessionHostVerdict` = 사유 포함) —
  //   둘 중 어느 것에 `sessionHostsInScope()` 를 물리든 그게 «조립» 이다.
  //  ⚠ 여기서 `code()` 를 쓰면 **안 된다**(실측 2026-09-08): 그 헬퍼는 블록주석을 먼저 지우는데
  //   `terminal/routes.ts` 안의 문자열에 `/*` 가 있어 그 뒤 코드가 통째로 먹혔고, 이 시험이 **변이를
  //   통과시켰다**(장식이 될 뻔했다 — 일부러 되돌려 보고 잡았다). 그래서 **줄 단위**로 본다:
  //   주석으로 시작하는 줄만 빼면 이 패턴에는 충분하다(한 줄짜리 표현식이다).
  const assemble = /\b(gatewayDefersToSessionHost|sessionHostVerdict)\s*\(\s*sessionHostsInScope\s*\(/;
  const assemblesIn = (rel) => read(rel).split("\n")
    .some((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && assemble.test(l));
  const assemblers = files.filter(assemblesIn);
  assert.deepEqual(assemblers, ["src/node/registry.ts"],
    `조립이 여러 곳이다: ${assemblers.join(", ") || "(한 곳도 없다 — 이름이 바뀌었나)"}`);
});

t("[S10b] 알림 스윕 호출부는 출처를 안 넘긴다(호출부가 둘 이상이다)", () => {
  const files = readdirSync(join(ROOT, "src"), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join("src", f))
    .filter((f) => f !== NOTIFIER);
  const callers = [];
  for (const f of files) {
    const src = code(f);
    for (const m of src.matchAll(/\bsweepAwaitingNotifications\s*\(([^)]*)/g)) {
      callers.push(f);
      assert.equal(m[1].trim(), "",
        `${f} 가 알림 스윕에 출처를 넘긴다 — 판정이 호출부로 새면 다른 호출부가 조용히 옛 경로로 남는다`);
    }
  }
  assert.ok(callers.length >= 2,
    `호출부를 ${callers.length}곳밖에 못 찾았다 — 이 시험이 지키려는 «두 자리» 가 사라졌거나 이름이 바뀌었다`);
});

// ── S11: 세션 호스트의 스냅샷은 «못 봤다» 를 «없다» 로 올리지 않는다 (#2600 T2 d6) ────────
//  왜: 게이트웨이가 «이 테넌트를 이 호스트에게 맡겨도 되나» 를 **선언·온라인·신선한 스냅샷** 셋으로 판정한다
//   (`gatewayDefersToSessionHost`). 그런데 `listSessionsRaw()` 를 strict 없이 부르면 `collectSessions` 가
//   «못 봤다»(중계 끊김·소켓 부재·타임아웃)를 **빈 배열로 접어** 올리고, 게이트웨이는 그 빈 스냅샷을
//   «신선하다» 고 읽어 목록 소유를 넘긴다 — 그 순간 그 테넌트 목록이 통째로 빈다.
//  ⇒ strict 여야 «못 봤다» 가 예외로 떨어져 **아무것도 안 올리고**, 스냅샷이 낡아 게이트웨이가 소유를 되찾는다.
//   (서버 부재 = «확답으로 없음» 은 strict 여도 빈 배열이라, 세션이 정말 0개인 노드는 종전 그대로다.)
//  ⚠ `code()` 를 안 쓴다 — 그 헬퍼는 문자열 속 `/*` 에 걸려 뒤쪽 코드를 통째로 먹는다(오늘 S10c 가 그래서
//   장식이 될 뻔했다). 줄 단위로 본다.
t("[S11] 노드 에이전트의 상태 push 는 strict 로 센다(«못 봤다» 를 빈 목록으로 올리지 않는다)", () => {
  const line = read(WS_ADAPTER).split("\n")
    .find((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /listSessionsRaw\s*\(/.test(l));
  assert.ok(line, `${WS_ADAPTER} 에 상태 push 의 listSessionsRaw 호출이 없다 — 이름이 바뀌었나`);
  assert.match(line, /strict:\s*true/,
    `${WS_ADAPTER} 의 상태 push 가 strict 가 아니다 — «못 봤다» 가 빈 스냅샷으로 올라가면 `
    + "게이트웨이가 그 테넌트 목록 소유를 빈 호스트에게 넘긴다");
});

// ── S12: 관측에 성공한 주기는 **침묵하지 않는다** (#2600 T2 d6) ──────────────
//  왜: 게이트웨이의 목록 소유 판정은 스냅샷의 **나이**를 본다(`STATE_STALE_MS` 12초). 종전 에이전트는 세션
//   목록이 지난번과 같으면 아무것도 보내지 않아, 한가한 테넌트에서는 그 나이가 늘 12초를 넘겼다 —
//   카나리아 실측(2026-09-09): 게이트웨이가 살아 있고 호스트도 붙어 있는데 정본이 133초째 멈춰 있었고
//   판정 인구조사는 `stale` 5 · `ok` 0 이었다. 그래서 «봤는데 그대로다» 는 박동으로 보낸다.
//  ⇒ 이 가드가 지키는 것은 «보낼 내용이 없으면 안 보낸다» 로 되돌아가지 않는 것이다.
//  ⚠ 줄 단위로 본다(S11 과 같은 이유 — `code()` 는 문자열 속 `/*` 에 걸린다).
t("[S12] 상태 push 는 변화가 없어도 박동을 보낸다(관측한 주기에 침묵하지 않는다)", () => {
  const lines = read(WS_ADAPTER).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.ok(lines.some((l) => /statePushKind\s*\(/.test(l)),
    `${WS_ADAPTER} 가 statePushKind 를 안 쓴다 — 무엇을 보낼지 판정이 인라인으로 돌아왔나`);
  assert.ok(lines.some((l) => /t:\s*"beat"/.test(l)),
    `${WS_ADAPTER} 가 박동을 안 보낸다 — 한가한 테넌트에서 스냅샷이 12초 만에 낡아 목록 소유가 영영 안 넘어간다`);
  assert.ok(!lines.some((l) => /if\s*\(!skip\)/.test(l)),
    `${WS_ADAPTER} 에 «보낼 게 없으면 안 보낸다» 조건이 되살아났다 — 그게 정확히 이 결함이다`);
});

// ── S13: 박동은 **스냅샷이 있을 때만** 나이를 되돌린다 (#2600 T2 d6) ─────────
//  왜: 박동은 «지난번에 보낸 그 목록이 지금도 그대로» 라는 뜻이다. 보낸 적이 없는 노드에 항목을 새로 만들면
//   «본 적 없는 노드»가 세션 0개짜리 신선한 스냅샷을 갖게 되고, 판정이 그 빈 스냅샷으로 소유를 넘긴다 —
//   S11 이 막는 사고와 같은 모양이라 여기서도 같은 술어(`beatRefreshes`)로 fail-closed 를 박아 둔다.
t("[S13] 게이트웨이는 박동을 받아 나이만 되돌리고, 스냅샷이 없으면 무시한다", () => {
  const lines = read(REGISTRY).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.ok(lines.some((l) => /m\.t === "beat"/.test(l)),
    `${REGISTRY} 가 박동을 처리하지 않는다 — 에이전트가 보내도 나이가 안 되돌아온다`);
  assert.ok(lines.some((l) => /beatRefreshes\s*\(/.test(l)),
    `${REGISTRY} 의 박동 처리가 fail-closed 술어(beatRefreshes)를 안 부른다 — 빈 스냅샷이 신선해질 수 있다`);
});

// ── S14: «지금 중앙 tmux 에 무엇이 있나» 의 출처는 `listCentralSessions` 한 곳이다 (#2600 T2 d6) ────────
//  왜: 2026-09-11 계수 — 목록 라우트·알림 스윕을 호스트 스냅샷으로 옮긴 뒤에도 같은 질문을 **다른 이름으로** 묻는
//   자리 셋이 그 테넌트에 분당 ~50번 tmux 를 쳤다(자기노드 판정 34 · CP idle 의 관리자 세션 뷰 12 · 백필 3.4).
//   셋 중 하나라도 `listSessionsRaw()` 로 되돌아가면 «소유가 넘어간 테넌트에 tmux 0» 이 조용히 깨진다.
//  ⚠ 줄 단위로 본다(`code()` 는 문자열 속 `/*` 에 걸린다 — S10c 머리말).
const codeLines = (rel) => read(rel).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
const BACKFILL = "src/sessions/session-state-backfill.ts";
const TERM_ROUTES = "src/terminal/routes.ts";

t("[S14] 자기노드 판정·관리자 세션 뷰·백필은 중앙 세션을 listCentralSessions 로 읽는다", () => {
  const src = read(REGISTRY);
  const at = src.indexOf("function probeSelfNodes(");
  assert.ok(at >= 0, `${REGISTRY} 에서 probeSelfNodes 를 못 찾았다 — 이름이 바뀌었나`);
  const body = src.slice(at, src.indexOf("\n}\n", at)).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.ok(body.length > 10, `probeSelfNodes 본문을 ${body.length}줄밖에 못 잘랐다 — 이 가드가 아무것도 안 보고 있다`);
  assert.ok(body.some((l) => /listCentralSessions\s*\(/.test(l)),
    `probeSelfNodes 가 listCentralSessions 를 안 부른다 — 30초마다 전 세션 capture-pane 이 돌아온다`);
  assert.ok(!body.some((l) => /listSessionsRaw\s*\(/.test(l)),
    `probeSelfNodes 가 listSessionsRaw 를 직접 부른다 — 소유가 넘어간 테넌트에서도 tmux 를 친다`);

  const routes = codeLines(TERM_ROUTES);
  assert.ok(routes.some((l) => /listCentralSessions\s*\(/.test(l)), `${TERM_ROUTES} 의 관리자 세션 뷰가 listCentralSessions 를 안 부른다`);
  assert.ok(!routes.some((l) => /listSessionsRaw\s*\(/.test(l)),
    `${TERM_ROUTES} 에 listSessionsRaw 호출이 되살아났다 — CP idle 이 60초마다 그 테넌트 tmux 를 친다`);

  const backfill = codeLines(BACKFILL);
  assert.ok(backfill.some((l) => /deps\?\.listLive\s*\?\?\s*\(\(\)\s*=>\s*listCentralSessions\(\)\)/.test(l)),
    `${BACKFILL} 의 기본 출처가 listCentralSessions 가 아니다 — 판정이 불리는 함수 안에 있어야 두 호출부가 같이 옮겨간다`);
  assert.ok(!backfill.some((l) => /\blistSessionsRaw\b/.test(l)), `${BACKFILL} 가 listSessionsRaw 를 직접 쓴다`);
});

// ── S15: 장부 `live` 는 그 브로커 노드의 세션 호스트 관측을 먼저 본다 (#2600 T2 d6) ──────────────────
//  왜: 브로커가 노드마다·테넌트마다 회수 틱마다 장부를 부르고, 종전엔 그때마다 게이트웨이가 list-sessions 를 쳤다
//   (노드 5 × 테넌트 6 = 분당 35). 출처 판정(`ledgerLiveFrom`)을 우회해 tmux 를 곧바로 물으면 그게 돌아온다.
const LEDGER = "src/terminal/session-ledger.ts";
t("[S15] 장부 라우트의 live 는 ledgerLiveFrom 을 지난다(tmux 직행 금지)", () => {
  const lines = codeLines(LEDGER);
  assert.ok(lines.some((l) => /listLive:\s*ledgerLiveFrom\s*\(/.test(l)), `${LEDGER} 라우트가 ledgerLiveFrom 을 안 쓴다`);
  assert.ok(!lines.some((l) => /listLive:\s*\(\)\s*=>\s*listLiveSessionIds/.test(l)),
    `${LEDGER} 라우트가 live 를 tmux 로 직행한다 — 세션 호스트가 서 있어도 분당 35번 list-sessions 가 돌아온다`);
});

// ── S16: «이 좌표가 정말 다른 기계인가» 는 `remoteNodeOfSession` 한 곳이다 (#2600 T2 d6) ────────────────
//  왜 둘인가: ① 대화창·감시자가 좌표가 있으면 매번 has-session 을 쳤다(전 테넌트 켜기 뒤 매니지드 세션 **전부**에
//   호스트 좌표가 붙어 분당 10). ② ★ 대화창 키 라우트는 `nodeOfSession(id)` 만 보고 409 를 냈다 — 호스트 좌표가
//   붙은 순간 매니지드 세션의 승인·거부·중단이 전부 막힌다. 둘 다 «좌표가 있다» 를 «저쪽 기계다» 로 읽은 같은 실수다.
const CHAT = "src/terminal/chat-routes.ts";
const WATCH = "src/terminal/transcript-watch.ts";
t("[S16] 대화창·키 라우트·대화 감시자는 remoteNodeOfSession 으로 «저쪽 기계인가» 를 묻는다", () => {
  const chat = codeLines(CHAT);
  assert.ok(chat.filter((l) => /remoteNodeOfSession\s*\(/.test(l)).length >= 2,
    `${CHAT} 의 gateRead·키 라우트 중 remoteNodeOfSession 을 안 쓰는 자리가 있다`);
  assert.ok(!chat.some((l) => /if\s*\(\s*nodeOfSession\s*\(\s*id\s*\)\s*\)\s*throw/.test(l)),
    `${CHAT} 에 «좌표가 있으면 409» 가 되살아났다 — 세션 호스트가 서면 매니지드 세션의 키 입력이 전부 막힌다`);
  assert.ok(!chat.some((l) => /await\s+sessionGone\s*\(\s*id\s*\)/.test(l)),
    `${CHAT} 가 좌표 판정을 위해 tmux 를 직접 묻는다`);
  const watch = codeLines(WATCH);
  assert.ok(watch.some((l) => /remoteNodeOfSession\s*\(\s*id\s*,\s*deps\.sessionGone\s*\)/.test(l)),
    `${WATCH} 가 remoteNodeOfSession(seam 을 거친 판정) 을 안 쓴다`);
  assert.ok(!watch.some((l) => /\bnodeOfSession\s*\(/.test(l)), `${WATCH} 가 좌표만으로 저쪽 기계를 판정한다`);
});

console.log(`\n${pass} passed — 세션 호스트 단일 출처(#2600 T1·T2 d4·d6)`);
