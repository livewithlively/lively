// 세션 호스트 번들 갱신 — **배선** 계약 (#3720).
//
// ── 무엇을 지키나 ────────────────────────────────────────────────────────────
// 매니지드 세션 호스트는 테넌트 uid 로 돌고 코드 디렉터리는 root 소유다(#3711 판단). 그래서
//  자가 갱신이 구조적으로 막혀 있고, 갱신은 노드의 root updater 가 한다(lvly-cloud
//  `deploy/lvly-sesshost-update.timer`). 그 updater 는 **5분마다** 게이트웨이에 «지금 서빙하는
//  지문이 뭐냐» 를 묻는데, 그 물음이 `HEAD /node/agent-bundle` 이다.
//
// ⚠ 판정(무엇이 «영영 막힘» 인가)은 순수 술어로 `protocol.test.ts` 가 시험한다. 여기서 지키는 것은
//  **그 술어가 실제로 불리는가**와 **HEAD 가 tar 를 안 띄우는가** — 술어가 맞아도 진입점이 안 부르면
//  그만이고, 그 상태는 «통과하는데 아무것도 안 하는» 모양이다(agent-boot-tenant.test.ts 의 같은 규율).
//
// ⚠ 왜 소스를 읽나: 이 둘은 순수부로 뺄 수 없는 자리다(하나는 라우트 핸들러의 **순서**, 하나는
//  진입점 모듈의 상태). 읽는 것은 **컴파일된 dist 사본**이다(주석이 아니라 실제로 도는 코드).
//  대신 **부분일치를 피하고 문장 단위로** 앵커한다 — 부분일치 배선 단언은
//  「배선이 있다」가 아니라 「그 글자가 있다」를 재고, 그건 `false &&` 하나로 뚫린다(실측: lvly-cloud
//  쪽 같은 시험이 mutation 에서 초록이었다).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("[3720-W1] HEAD 는 지문만 준다 — tar 를 띄우기 **전에** 끊는다", () => {
  const s = src("./routes.js");
  const route = s.slice(s.indexOf('app.get("/node/agent-bundle"'));
  assert.ok(route, "번들 라우트를 못 찾았다");
  const verIdx = route.indexOf('res.setHeader("X-Agent-Ver"');
  const headIdx = route.indexOf('if (req.method === "HEAD")');
  const tarIdx = route.indexOf('spawn("tar"');
  assert.ok(verIdx >= 0, "X-Agent-Ver 헤더가 없다 — updater 가 판정할 값을 못 받는다");
  assert.ok(headIdx >= 0, "HEAD 단축이 없다 — 매 틱 26MB(node-pty)를 압축해 버린다");
  assert.ok(verIdx < headIdx,
    "🔴 헤더를 세우기 전에 끊는다 — HEAD 응답에 지문이 안 실린다(updater 가 영영 판정을 못 한다)");
  assert.ok(headIdx < tarIdx,
    "🔴 tar 를 띄운 뒤에 끊는다 — 본문은 버려지지만 압축 비용은 그대로 든다");
});

test("[3720-W2] 자가 갱신 진입점이 «영영 막힘» 술어를 실제로 부른다", () => {
  const s = src("./agent.js");
  assert.match(s, /if \(selfUpdateBlockedForever\(code\)\) \{/,
    "술어를 안 부른다 — 판정이 맞아도 진입점이 안 쓰면 그만이다");
  assert.match(s, /selfUpdateDisabled = true;/, "접는 자리가 없다");
  //  ⚠ 접었으면 **다시 안 들어와야** 한다. 이 가드가 없으면 로그만 한 줄 바뀌고 재시도는 그대로다
  //   (그게 고치려던 증상 자체다 — 24시간에 25건).
  assert.match(s, /if \(selfUpdating \|\| selfUpdateDisabled \|\|/,
    "🔴 접어 놓고 가드를 안 걸었다 — 재접속마다 다시 시도한다");
});

test("[3720-W3] 접는 것은 «시도» 이지 «보고» 가 아니다 — agentVer 는 계속 올라가야 한다", () => {
  //  낡았다는 사실이 안 올라가면 롤의 되읽기가 볼 값이 사라진다. 접기와 보고는 다른 축이다.
  const s = src("./agent.js");
  assert.match(s, /agentVer: AGENT_VER/,
    "🔴 자가 갱신을 접으면서 보고까지 끊으면, 낡은 것을 아무도 모른다");
});
