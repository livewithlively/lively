// 격리 배포의 app-server 자리 계약 (#2055) — **경계가 노브가 아니라 파일 권한으로 선다**는 것이 요점이다.
//  이 분기는 box_ OS 유저가 깔린 리눅스에서만 실제로 도는데, 틀렸을 때 증상이 조용하다
//  (대화는 되는 것처럼 보이고 남이 붙을 수 있을 뿐이다). 그래서 순수 조각을 계약으로 못박는다.
import assert from "node:assert/strict";
import { SUPERVISOR_JS, sessionSockName, supervisorStartSh } from "./codex-as-supervisor.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("★ 소켓 이름은 짧다 — SUN_LEN(리눅스 108)을 넘으면 bind 가 실패한다(실측으로 밟았다)", () => {
  const longest = sessionSockName("box-e2e-b-20260827-012744-3bac08e3-and-then-some-more-padding");
  assert.ok(longest.length <= 24, `소켓 파일명이 길다: ${longest}`);
  // 최악의 홈 경로(/home/box_<24자 슬러그>/.codex/)를 얹어도 여유가 있어야 한다.
  assert.ok(`/home/box_${"x".repeat(24)}/.codex/${longest}`.length < 100);
});

t("소켓 이름은 결정론적이다 — 게이트웨이가 재기동돼도 같은 세션이면 같은 자리에 다시 붙는다", () => {
  assert.equal(sessionSockName("s1"), sessionSockName("s1"));
  assert.notEqual(sessionSockName("s1"), sessionSockName("s2"));
});

t("★ 감독자는 소켓을 0600 으로 좁힌다 — 이 한 줄이 곧 격리 경계다", () => {
  assert.match(SUPERVISOR_JS, /chmodSync\(sock,0o600\)/);
});

t("★ 감독자는 app-server 를 stdio 로 붙든다 — 포트를 열지 않는다", () => {
  assert.match(SUPERVISOR_JS, /spawn\("codex",\["app-server"\]/);
  assert.ok(!/--listen|127\.0\.0\.1/.test(SUPERVISOR_JS), "감독자에 listen·loopback 이 없다");
});

t("감독자는 클라이언트를 하나만 둔다 — codex 는 스레드당 writer 가 하나다", () => {
  assert.match(SUPERVISOR_JS, /if\(client\)client\.destroy\(\)/);
});

t("★ 기동을 **확인해서** 말한다 — `&` 는 즉시 0 을 돌려주므로 그것만으로는 아무것도 안 본 것이다", () => {
  const sh = supervisorStartSh({ script: "/h/s.cjs", sock: "/h/a.sock", log: "/h/a.log" });
  assert.match(sh, /echo started/);
  assert.match(sh, /nohup node/);
  assert.match(sh, /tail -n 5/, "실패하면 로그 꼬리를 남긴다");
  assert.match(sh, /exit 1/);
});

t("이미 살아 있으면 두 번 띄우지 않는다 — 서버 둘이 같은 스레드를 노리면 writer 충돌이 난다", () => {
  assert.match(supervisorStartSh({ script: "/h/s.cjs", sock: "/h/a.sock", log: "/h/a.log" }), /echo already/);
});

t("codex 가 없으면 그렇게 말한다(127)", () => {
  assert.match(supervisorStartSh({ script: "/h/s.cjs", sock: "/h/a.sock", log: "/h/a.log" }), /codex 없음/);
});

t("세션 신원 env 를 싣는다 — 훅이 대화 파일 경로를 그 값으로 보고한다", () => {
  const sh = supervisorStartSh({ script: "/h/s.cjs", sock: "/h/a.sock", log: "/h/a.log", env: { LIVELY_SESSION_ID: "s1" } });
  assert.match(sh, /LIVELY_SESSION_ID='s1' nohup node/);
});

console.log(`\n${pass} passed`);
