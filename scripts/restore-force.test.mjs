// 복원이 «모른다» 로 멈췄을 때 **어느 화면에서든** 사람이 고를 수 있어야 한다 (#3870, 원준님 신고 2026-09-12).
//
//  무엇이 문제였나: 서버가 409 로 «이 세션이 있는 컨테이너의 상태를 확인하지 못했습니다 — … 화면의
//   [강제로 되살리기] 를 눌러 주세요» 라고 답한다. 그런데 그 버튼을 실제로 그리던 화면은 **대화창 하나뿐**이었고,
//   복원을 부르는 나머지 자리(단독 터미널 부팅 게이트·판 목록·세션 목록·대시보드 카드·일괄 복원)는 그 문장을
//   그대로 토스트했다 — 사람은 **없는 버튼을 누르라는 안내**를 받았다(실측: 서버 원문이 그대로 화면에 떴다).
//  그리고 그 대화창의 판정마저 `e.status === 409` 였다. 같은 라우트의 409 중 노드 오프라인·노드 무응답·노드
//   직접생성(좌표 없음)은 force 로 **안** 풀리므로, 그 셋에도 버튼을 내밀어 눌러도 같은 거절이 돌아왔다.
//  규칙: 서버가 «force 로 풀린다»(canForce)를 응답에 싣고, 화면은 상태코드가 아니라 그것만 본다.
//
//  사양·엣지 표: 스크래치패드 spec-3870-r409.md 의 P·E·S·C 행 — 아래 이름의 번호가 그 행이다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importTerminalModule } from "./standalone-terminal-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, `${name}${detail ? " — " + detail : ""}`); pass++; console.log(`ok  ${name}`); };
const show = (v) => JSON.stringify(v);

const tmp = mkdtempSync(path.join(tmpdir(), "restore-force-"));
try {
  execFileSync(path.join(root, "node_modules/.bin/tsc"),
    [path.join(root, "web/lib/restore-force.ts"), "--outDir", tmp, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
    { stdio: "inherit" });
  const lib = await import(path.join(tmp, "restore-force.js"));
  //  단독 터미널 번들은 SPA 와 분리된 tsconfig(rootDir 가 그 폴더)라 web/lib 을 import 할 수 없어 **같은 규칙의
  //   사본**을 들고 있다. 여기서 둘을 같은 표에 태워, 한쪽만 고쳐 갈리는 일을 막는다.
  const term = await importTerminalModule();

  // ── 배선 — 관측 장치가 살아 있나(죽은 채로 통과하는 것이 vacuous test 의 가장 흔한 모양) ──
  ok(typeof lib.canForceRestore === "function" && typeof term.canForceRestore === "function",
    "W1 두 사본이 실제로 export 돼 이 시험이 무언가를 보고 있다");
  ok(lib.canForceRestore !== term.canForceRestore,
    "W2 둘은 서로 다른 구현이다 — 같은 객체면 파리티를 재는 의미가 없다");

  // ── P — canForceRestore 판정 표 (두 사본이 같은 답) ─────────────────────
  const err = (status, body) => Object.assign(new Error("요청 실패"), { status, body });   // web/lib/net.ts api() 가 만드는 모양
  const P = [
    ["P1 서버가 canForce 를 실은 409 는 강제 복원을 고를 수 있다", err(409, { canForce: true }), true],
    ["P2 canForce 없는 409(노드 오프라인·좌표없음)는 고를 수 없다 — 눌러도 같은 거절이다", err(409, {}), false],
    ["P3 body 가 없는 409(canForce 를 안 싣는 옛 서버)는 없는 길을 약속하지 않는다", Object.assign(new Error("x"), { status: 409 }), false],
    ["P4 상태코드가 다르면(403) canForce 가 있어도 아니다", err(403, { canForce: true }), false],
    ["P5 끊김(500)은 재시도 사다리(restore-retry) 몫이지 강제 복원이 아니다", err(500, { canForce: true }), false],
    ["P6a 오류 객체가 null 이면 근거가 없다", null, false],
    ["P6b 오류 객체가 undefined 면 근거가 없다", undefined, false],
    ["P6c 문자열은 오류 객체가 아니다", "409", false],
    ["P6d 숫자는 오류 객체가 아니다", 409, false],
    ["P7 status 가 문자열 '409' 로 와도 같은 답이다", err("409", { canForce: true }), true],
    ["P8 참값 흉내(canForce:'true')는 승격하지 않는다", err(409, { canForce: "true" }), false],
    ["P8b 참값 흉내(canForce:1)도 승격하지 않는다", err(409, { canForce: 1 }), false],
    ["P9 body 가 null 이어도 터지지 않고 아니다", err(409, null), false],
    ["P9b body 가 문자열이어도 터지지 않고 아니다", err(409, "canForce"), false],
  ];
  for (const [name, input, want] of P) {
    ok(lib.canForceRestore(input) === want, `${name} [web/lib]`, show(input));
    ok(term.canForceRestore(input) === want, `${name} [standalone 사본]`, show(input));
  }

  // ── P10 — 이번에 새로 만든 헬퍼(restorePath)가 만드는 주소 ──────────────
  //  force 는 «옛 것이 살아 있을 수도 있음을 알고 새로 만든다» 는 선언이라 **기본값이 아니다**: 안 주면 안 붙어야 한다.
  ok(lib.restorePath("box-a-1") === "/api/ui/terminal/sessions/box-a-1/restore", "P10a force 를 안 주면 질의가 안 붙는다");
  ok(lib.restorePath("box-a-1", false) === "/api/ui/terminal/sessions/box-a-1/restore", "P10b force=false 도 안 붙는다");
  ok(lib.restorePath("box-a-1", true) === "/api/ui/terminal/sessions/box-a-1/restore?force=1", "P10c force=true 면 ?force=1");
  ok(lib.restorePath("a/b?c").includes("a%2Fb%3Fc"), "P10d 세션 id 는 이스케이프한다(경로를 벗어나지 않게)");
  ok(lib.RESTORE_FORCE_LABEL === "강제로 되살리기", "P10e 버튼 글자는 서버 안내 문구가 지목하는 그 이름이다");

  // ── E — HttpError 구조화 본문이 응답에 실린다 ───────────────────────────
  execFileSync(path.join(root, "node_modules/.bin/tsc"),
    [path.join(root, "src/http-error.ts"), "--outDir", tmp, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
    { stdio: "inherit" });
  const { HttpError } = await import(path.join(tmp, "http-error.js"));
  //  wrap() 이 응답을 만드는 그 식과 같은 조립 — 라우트 전체를 띄우지 않고 규칙만 값으로 고정한다.
  //  (그 식이 실제로 wrap 에 있는지는 아래 S7 이 따로 본다 — 여기만 맞고 wrap 이 옛 식이면 둘 다 통과해 버린다.)
  const bodyOf = (e) => ({ ...(e.body ?? {}), error: e.message });
  ok(show(bodyOf(new HttpError(409, "못 봤습니다", { body: { canForce: true } }))) === show({ canForce: true, error: "못 봤습니다" }),
    "E1 body 를 준 HttpError 는 그 필드가 응답에 함께 실린다");
  ok(show(bodyOf(new HttpError(404, "없습니다"))) === show({ error: "없습니다" }),
    "E2 body 가 없으면 종전과 같은 {error} 하나다(무회귀)");
  ok(bodyOf(new HttpError(409, "진짜 안내", { body: { error: "덮어쓰기 시도" } })).error === "진짜 안내",
    "E3 body 에 error 가 섞여 와도 사용자 안내문이 이긴다");
  ok(new HttpError(409, "x", { body: { canForce: true } }).status === 409 && new HttpError(500, "y").body === undefined,
    "E4 status 계약은 그대로고 body 는 선택이다");
  {
    const cause = new Error("원인");
    ok(new HttpError(500, "x", { cause }).cause === cause, "E5 cause 계약(#1278 로그)이 안 깨졌다");
  }

  // ── S — 서버가 어느 409 에 canForce 를 싣나 (라우트 안의 throw 배치) ────
  const routes = readFileSync(path.join(root, "src/terminal/routes.ts"), "utf8");
  ok(/function stateUnknownRestore\([\s\S]*?body: \{ canForce: true \}/.test(routes),
    "S0 «모른다» 로 멈추는 409 는 한 자리(stateUnknownRestore)에서 만들고 canForce 를 싣는다");
  for (const [n, what] of [
    ["S1", "이 세션이 있는 컨테이너의 상태를 확인하지 못했습니다"],
    ["S2", "이 대화를 이어 도는 세션이 있는지 확인하지 못했습니다"],
    ["S3", "이 대화를 이어 도는 세션의 상태를 확인하지 못했습니다"],
  ]) {
    ok(routes.includes(`throw stateUnknownRestore("${what}")`), `${n} «${what.slice(0, 16)}…» 는 그 자리를 쓴다`);
  }
  //  force 로 **안** 풀리는 409 가 그 자리를 쓰면 눌러도 같은 거절이 돌아오는 버튼이 선다 — 안 쓰는 것을 못박는다.
  for (const [n, what] of [
    ["S4", "그 세션이 있던 컴퓨터(노드)가 지금 연결돼 있지 않아"],
    ["S5", "그 컴퓨터(노드)가 응답하지 않아"],
    ["S6", "이 세션은 그 컴퓨터에서 직접 만들어진 것이라"],
  ]) {
    const line = routes.split("\n").find((l) => l.includes(what)) ?? "";
    ok(line.includes("new HttpError(409") && !line.includes("stateUnknownRestore"),
      `${n} 노드 갈래 409 는 force 선택지를 주지 않는다`, line.trim().slice(0, 60));
  }
  //  E 표가 고정한 조립 규칙이 **실제 응답 경로에도** 있어야 한다(여기가 비면 서버는 canForce 를 절대 안 보낸다).
  ok(/res\.status\(err\.status\)\.json\(\{ \.\.\.\(err\.body \?\? \{\}\), error: err\.message \}\)/.test(
    readFileSync(path.join(root, "src/http/rest-util.ts"), "utf8")),
    "S7 wrap() 이 err.body 를 응답에 펼치고 error 를 뒤에 둔다");

  // ── C — 화면 배선(순수 판정으로 못 잡는 자리) ──────────────────────────
  const srcOf = (p) => readFileSync(path.join(root, p), "utf8");
  for (const [name, file] of [
    ["C1 대화창", "web/session-chat.ts"],
    ["C2 판 목록", "web/v2/panes-parts.ts"],
    ["C3 세션 목록", "web/terminal/session-list.ts"],
    ["C4 대시보드 카드", "web/dash/widget-sessions.ts"],
    ["C5 단독 터미널 부팅 게이트", "web/standalone/terminal.ts"],
    ["C6 세션 목록 일괄 복원", "web/terminal/routes.ts"],
  ]) {
    ok(srcOf(file).includes("canForceRestore"), `${name}(${file}) 은 서버가 말한 canForce 를 본다`);
  }
  //  ⚠ 종전의 과대 판정이 되살아나지 않게 **force 게이트 그 자체**를 못박는다 — 상태코드만 보고 버튼을 세우면
  //   노드 갈래 409 에도 헛 버튼이 선다. (이 파일의 다른 409 검사(대화 파일이 그 컴퓨터에 있다는 #1744 응답)는
  //   복원과 무관하므로 건드리지 않는다 — 그래서 파일 전체가 아니라 이 게이트만 본다.)
  {
    const s = srcOf("web/session-chat.ts");
    ok(/if \(canForceRestore\(e\) && !pd\.forceRestore\)/.test(s) && !/status\s*===\s*409\s*&&\s*!pd\.forceRestore/.test(s),
      "C1b 대화창의 force 게이트가 상태코드가 아니라 canForce 를 본다");
  }
  //  단독 터미널은 배너가 그 선택지를 나른다 — 라벨과 force 전달이 함께 있어야 실제로 눌린다.
  {
    const s = srcOf("web/standalone/terminal.ts");
    ok(s.includes("restoreLabel: '강제로 되살리기'") && s.includes("restoreForce: true")
      && s.includes("restoreThisSession(o.restoreForce)"),
      "C5b 단독 터미널 배너의 [강제로 되살리기] 가 실제로 force 를 싣고 복원을 부른다");
  }
  //  확인창 없이 force 로 새지 않는다 — force 는 사람이 고른 것이어야 한다(#3752 ④).
  for (const [name, file] of [
    ["C2c 판 목록", "web/v2/panes-parts.ts"],
    ["C3c 세션 목록", "web/terminal/session-list.ts"],
    ["C4c 대시보드 카드", "web/dash/widget-sessions.ts"],
  ]) {
    ok(srcOf(file).includes("confirmForceRestore"), `${name} 은 force 전에 사람에게 묻는다`);
  }
  //  일괄은 force 를 **대신 고르지 않는다**(건별 선언이라) — 대신 몇 건이 그랬는지 말한다.
  for (const [name, file] of [["C6b", "web/terminal/routes.ts"], ["C7 대시보드 일괄", "web/dash/widget-sessions.ts"]]) {
    const s = srcOf(file);
    ok(s.includes("상태 확인 못함"), `${name} 일괄 복원이 «상태 확인 못함» 을 실패와 따로 센다`);
  }
  ok(!/restorePath\([^)]*,\s*true\)/.test(srcOf("web/terminal/routes.ts")),
    "C6c 일괄 복원은 force 를 자동으로 붙이지 않는다");

  console.log(`\n${pass} checks passed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
