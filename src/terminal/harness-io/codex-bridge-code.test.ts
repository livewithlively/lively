// 세션 컨테이너로 보내는 **다리 코드**의 계약 (#2055 P3) — 문자열을 실제로 파싱해 본다.
//
//  ── 왜 이 테스트가 있나 ──
//  이 코드는 우리 레포에서 **한 번도 실행되지 않는다**: 문자열로 조립돼 `node -e` 로 남의 컨테이너에서
//  돈다. 그래서 타입체커도 린터도 번들러도 안 본다 — 깨져도 우리 쪽은 전부 초록불이고, 증상은
//  매니지드에서 "대화가 안 된다" 하나로만 나타난다. 실제로 두 번 깨졌다(둘 다 롤 전에 잡았다):
//   ① 생 TCP(`net.connect`)로 붙었다 — `--listen ws://` 는 WebSocket 이라 서버가 400 을 돌려준다.
//   ② 개행 이스케이프가 한 겹 모자랐다 — 템플릿이 `\n` 을 **진짜 개행**으로 바꿔 문자열 리터럴이
//      줄바꿈에서 끊겼다(생성된 JS 가 SyntaxError). 파일만 읽어서는 눈에 안 보인다.
//  그래서 여기서는 **생성된 문자열을 node 에게 파싱시킨다**(new Function). 그게 유일한 진짜 검사다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// 제품 코드가 실제로 만들어 내는 문자열을 꺼낸다(컴파일 산출에서 — 소스 이스케이프를 그대로 통과한 값).
const here = path.dirname(fileURLToPath(import.meta.url));
const js = readFileSync(path.join(here, "codex-chat-runtime.js"), "utf8");
const m = /const BRIDGE = \[([\s\S]*?)\]\.join\(""\);/.exec(js);
assert.ok(m, "BRIDGE 조립을 못 찾았다 — 이 테스트가 헛돌고 있다(vacuous)");
const bridge: string = new Function("port", `return [${m![1]}];`)(39_777).join("");

t("★ B1 생성된 코드가 **파싱된다** — 문자열 조립은 컴파일러가 안 봐 준다", () => {
  new Function(bridge);          // 던지면 곧 매니지드 대화가 통째로 안 되는 것이다
});

t("★ B2 WebSocket 으로 붙는다 — 생 TCP 면 서버가 400 Bad Request 를 돌려준다(실측)", () => {
  assert.match(bridge, /new WebSocket\("ws:\/\/127\.0\.0\.1:39777"\)/);
  assert.ok(!/require\("net"\)/.test(bridge), "net.connect 로 돌아가면 안 된다");
});

t("★ B3 개행 이스케이프가 살아 있다 — 한 겹 모자라면 문자열이 줄바꿈에서 끊긴다", () => {
  assert.match(bridge, /endsWith\("\\n"\)/, '생성된 코드에 `"\\n"` 리터럴이 있어야 한다');
  assert.ok(!/\n/.test(bridge), "다리 코드는 한 줄이다 — 진짜 개행이 섞이면 그게 곧 ②의 증상이다");
});

t("B4 줄 단위로 주고받는다 — 받는 쪽(CodexAppServer)이 줄로 자른다", () => {
  assert.match(bridge, /indexOf\("\\n"\)/, "stdin 을 줄로 잘라 보낸다");
  assert.match(bridge, /process\.stdout\.write/, "받은 것을 stdout 으로 흘린다");
});

t("★ B5 열리기 전에 온 것을 버리지 않는다 — 첫 메시지(initialize)가 사라지면 아무것도 시작 안 된다", () => {
  assert.match(bridge, /q\.push\(l\)/, "열리기 전엔 큐에 담는다");
  assert.match(bridge, /onopen=\(\)=>\{open=true;for\(const m of q\.splice\(0\)\)ws\.send\(m\);\}/, "열리면 담아 둔 것을 순서대로 보낸다");
});

t("B6 연결이 닫히면 다리도 끝난다(고아 프로세스 금지)", () => {
  assert.match(bridge, /onclose=\(\)=>process\.exit\(0\)/);
});

console.log(`\n${pass} passed`);
