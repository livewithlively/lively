// #4783 — 세션 화면 안의 터미널은 **끝난 세션에 대해 정하지 않는다** · «조작했다» 는 사람이 친 것만 센다 · 혼자 연 창의 배너는 사실대로.
//  사양: 스크래치패드 spec.md 표 G·H·I. 판정 함수는 tsc 산출 모듈(dist/standalone/terminal.js)을 그대로 import 한다(standalone-terminal-env).
//  배선(무엇이 무엇보다 먼저 도나)은 소스 텍스트로 본다 — 순수 함수 시험으로는 못 잡는 자리다.
//  틀리면 티가 크다(상민님 2026-10-16 신고 그대로):
//   🔴 세션 화면 안의 터미널이 «방금 끝났습니다» 배너로 머물면 — 셸은 액자를 못 걷고, 사람은 조작할 수 없는 터미널을 본다.
//   🔴 마우스 위치 보고를 «조작» 으로 세면 — 터미널 위로 마우스만 지나가도 «직접 종료한 것이면 그대로 두시면 됩니다» 가 뜬다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { importTerminalModule } from "./standalone-terminal-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "web/standalone/terminal.ts"), "utf8");
const T = await importTerminalModule();

/** 함수 하나의 본문(다음 최상위 선언 전까지) — 배선 단언용. */
function body(name) {
  const re = new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${name}\\(`);
  const m = re.exec(src);
  assert.ok(m, `[배선] ${name} 를 소스에서 찾았다`);
  const rest = src.slice(m.index + m[0].length);
  const end = rest.search(/\n(?:export )?(?:async )?function |\n\/\*\*\n|\nlet |\nconst /);
  return rest.slice(0, end < 0 ? undefined : end);
}

test("G 사람 입력인가 — 터미널이 저절로 내보낸 것(마우스·초점·자동 응답)은 아니다 · 키·붙여넣기는 사람 입력", () => {
  assert.equal(typeof T.isAutoReply, "function", "[배선] isAutoReply 를 모듈에서 가져왔다");
  const auto = [
    "\x1b[<35;10;5M", "\x1b[<0;3;4m", "\x1b[M !!",          // 마우스(SGR 이동·놓기, X10)
    "\x1b[I", "\x1b[O",                                     // 초점 보고
    "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[=0c",             // 장치 속성
    "\x1b[0n", "\x1b[12;40R", "\x1b[?12;40;1R",             // 상태·커서 위치
    "\x1b[?2026;2$y", "\x1b[4;1$y",                         // 모드 보고
    "\x1b[8;40;120t",                                       // 창 보고
    "\x1b]11;rgb:1e1e/1e1e/1e1e\x07", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",   // 색 응답(BEL · ST)
    "\x1bP1$r0m\x1b\\",                                     // DCS 응답
  ];
  for (const d of auto) assert.equal(T.isAutoReply(d), true, JSON.stringify(d));
  const human = ["a", "가", "\r", "\x03", "\x1b", "\x1b[A", "\x1bOA", "\x1b[15~", "\x1b[1;5C", "hello world", "/exit\r", "\x7f"];
  for (const d of human) assert.equal(T.isAutoReply(d), false, JSON.stringify(d));
  assert.equal(T.isAutoReply(""), false);
  assert.equal(T.isAutoReply(undefined), false);
});

test("H 혼자 연 창의 «방금 끝남» 배너 — 서버가 적은 사유로 말하고, 모르면 «누가» 를 말하지 않는다", () => {
  const c = (f) => T.askBannerCopy(f);
  assert.match(c({ exitedByUser: true }).body, /직접 끝낸 세션/);
  assert.match(c({ endWhy: "stop" }).body, /직접 끝낸 세션/);
  assert.match(c({ endWhy: "harness_exit" }).body, /직접 끝낸 세션/);
  assert.match(c({ endWhy: "harness_crash", endCode: 137 }).body, /오류로 끝났어요\(종료 코드 137\)/);
  assert.match(c({ endWhy: "launch_fail" }).body, /뜨자마자/);
  assert.match(c({ endWhy: "lost" }).body, /끝난 이유를 알 수 없어요/, "사라짐은 원인을 단정하지 않는다");
  assert.match(c({ oomKilled: true }).body, /메모리가 모자라/);
  assert.match(c({ stopWhy: "asking" }).body, /답을 기다리다 자동으로 껐어요/);
  assert.match(c({ endWhy: "reclaim" }).body, /시스템이 자동으로 껐어요/, "회수만으로는 «작업이 끝나» 를 단정하지 않는다");
  assert.match(c({ endWhy: "reclaim", stopWhy: "done" }).body, /작업이 끝나 자동으로 껐어요/);
  assert.match(c({ stopWhy: "done" }).body, /작업이 끝나 자동으로 껐어요/);
  for (const f of [{}, null, { endWhy: "nope" }]) {
    const x = c(f);
    assert.doesNotMatch(x.title + x.body, /직접|조작/, "🔴 모르면 «직접 종료» 를 단정하지 않는다 — " + JSON.stringify(f));
  }
  for (const f of [{ exitedByUser: true }, { endWhy: "lost" }, { endWhy: "reclaim" }, {}]) assert.match(c(f).body, /다시 열 수 있습니다\.$/, "문장은 끝맺는다");
  //  endFactsOf — 메타가 실어 온 것만 옮긴다
  assert.deepEqual(T.endFactsOf({ exitedByUser: true, oomKilled: false, endNote: { why: "harness_crash", code: 3, at: 1 }, stopWhy: "done", junk: 1 }),
    { exitedByUser: true, oomKilled: false, endWhy: "harness_crash", endCode: 3, stopWhy: "done" });
  assert.deepEqual(T.endFactsOf(null), { exitedByUser: false, oomKilled: false, endWhy: "", endCode: null, stopWhy: "" });
});

test("I1 붙어 있다 끝남(4410) — 세션 화면 안이면 **어떤 판정보다 먼저** 셸에 넘긴다(방금 끝남·남의 세션·곧 다시 끝남·그냥 끝남 모두)", () => {
  const b = body("onSessionGone");
  const iEmb = b.indexOf("embeddedInShell()");
  const iOld = b.indexOf("if (sessionEnded || restoreTried)");
  const iMode = b.indexOf("goneMode(");
  assert.ok(iEmb >= 0, "🔴 세션 화면 안인지 묻지 않는다");
  assert.ok(iOld > iEmb && iMode > iEmb, "🔴 넘기기가 종전 판정(복원 시도 소진 · goneMode)보다 뒤에 있다");
  const emb = b.slice(iEmb, iOld);
  assert.match(emb, /handOffToShell\(/, "세션 화면 안이면 handOffToShell");
  assert.match(emb, /movedTo[\s\S]*goToMoved\(/, "이어진 세션이면 옮긴다");
  assert.doesNotMatch(emb, /endSession\(/, "🔴 세션 화면 안에서 혼자 끝 배너를 띄운다");
});

test("I2 열 때 이미 끝남 — 세션 화면 안이면 판정 없이 넘긴다(이어졌으면 옮긴다)", () => {
  const b = body("maybeRestoreOnOpen");
  const iEmb = b.indexOf("embeddedInShell()");
  const iMode = b.indexOf("goneMode(");
  assert.ok(iEmb >= 0 && iMode > iEmb, "🔴 부팅 게이트가 세션 화면 안인지보다 판정을 먼저 한다");
  assert.match(b.slice(iEmb, iMode), /goToMoved\([\s\S]*handOffToShell\(/);
});

test("I3 넘길 때 끝난 사실을 싣는다 · 되살릴 수 있다는 약속은 메타가 한 만큼만", () => {
  const b = body("handOffToShell");
  assert.match(b, /end: endFactsOf\(meta\) \}/, "끝난 사실(endFactsOf)을 싣는다 — 셸이 안 읽는 칸(typed)은 싣지 않는다");
  assert.doesNotMatch(b, /restorable: true/, "🔴 메타가 아니라고 해도 «되살릴 수 있다» 를 박아 보낸다");
  assert.match(b, /restorable = !!\(meta && meta\.restorable\)/);
});

test("I4 «조작했다» 는 사람 입력에서만 — handleTermData 가 자동 응답을 거른 뒤에만 켠다", () => {
  const b = body("handleTermData");
  assert.match(b, /if \(!isAutoReply\(d\)\) userTyped = true;/);
  assert.doesNotMatch(b.split("\n").slice(0, 4).join("\n"), /^\s*userTyped = true;/m, "🔴 첫 줄에서 무조건 켠다");
});

test("I5 혼자 연 창의 ask 배너는 사유로 고른 말 — «이 탭에서 조작한 뒤 끝났어요» 단정은 없다", () => {
  const b = body("onSessionGone");
  assert.match(b, /askBannerCopy\(endFactsOf\(meta\)\)/);
  assert.doesNotMatch(src, /이 탭에서 조작한 뒤 끝났어요/);
});

test("I6 혼자 연 창 — 서버가 «사람이 끝냈다» 고 적었으면 이 탭에서 안 쳤어도 저절로 되살리지 않는다(ask)", () => {
  assert.equal(T.userEndedFacts({ exitedByUser: true }), true);
  assert.equal(T.userEndedFacts({ endWhy: "stop" }), true);
  assert.equal(T.userEndedFacts({ endWhy: "harness_exit" }), true);
  for (const f of [{ endWhy: "reclaim" }, { endWhy: "lost" }, { endWhy: "harness_crash" }, {}, null]) assert.equal(T.userEndedFacts(f), false, JSON.stringify(f));
  //  판정표 쪽 — 그 값이 typed 자리로 들어가면 ask 다(종전 표 ㉜ 와 같은 칸).
  assert.equal(T.goneMode({ restorable: true, canRestore: true }, false, false, T.userEndedFacts({ endWhy: "stop" })), "ask");
  assert.equal(T.goneMode({ restorable: true, canRestore: true }, false, false, T.userEndedFacts({ endWhy: "reclaim" })), "auto");
  const b = body("onSessionGone");
  assert.match(b, /goneMode\(meta, !!NODE_ID, RESTORED, userTyped \|\| userEndedFacts\(endFactsOf\(meta\)\)\)/, "🔴 4410 판정에 서버의 «사람이 끝냈다» 를 안 싣는다");
});
