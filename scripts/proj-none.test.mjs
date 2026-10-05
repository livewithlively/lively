// #4551 — 「프로젝트 없음」 묶음 정리 1판 (원준 2026-10-05).
//
//  사양(행위):
//   · 프로젝트에 안 붙은 세션 묶음의 이름은 어디서나 「기타 (미분류)」다([프로젝트] 사이드바의 그 이름과 같다).
//   · 끝난 로그인 세션은 세션 목록에 서지 않는다. 도는 로그인 세션은 선다(지금 로그인 중인 창이다).
//   · 로그인 세션 = 종류가 login 이거나, 이름이 로그인 창이 붙이는 꼴(«AI 로그인 (…)» · «내 계정 로그인 (…)» · 괄호 없는 꼴).
//   · 세션 옮기기 창에는 「프로젝트에서 떼기」가 없다.
//
//  엣지 표(입력 → 기대). 행마다 단언 하나 이상.
//   L1  kind=login, 이름 아무거나                         → 로그인
//   L2  kind 없음, «AI 로그인 (codex)»                    → 로그인(서버 자리가 붙이는 이름)
//   L3  kind=human, «내 계정 로그인 (Claude Code)»        → 로그인(화면에서 연 Claude 로그인은 human 으로 적힌다)
//   L4  «내 계정 로그인»(괄호 없음)                        → 로그인
//   L5  사람 이름에 낱말만 든 것(«AI 로그인 버그 고치기» · «로그인 화면 수정» · «내 계정 로그인 안 됨») → 아님
//   L6  label 이 비고 title 만 로그인 꼴                   → 로그인(이름은 label → title 순으로 본다)
//   L7  null · undefined · 빈 객체                        → 아님(던지지 않는다)
//   L8  kind 대소문자 · 앞뒤 공백 있는 이름                 → 로그인
//   L9  kind=task · managed · app · human 에 보통 이름     → 아님
//   S1  끝난 로그인 → 숨김 / 도는 로그인 → 보임 / 끝난 보통 세션 → 보임 / 도는 보통 세션 → 보임
//   N1  이름 값 = «기타 (미분류)»
//   W1~W5 배선 — 화면이 그 잣대 · 그 이름을 실제로 쓴다(주석은 걷고 본다)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (p) => { try { return readFileSync(path.join(root, p), "utf8"); } catch { return ""; } };
//  주석은 빼고 본다 — 머리말에 적힌 낱말이 단언을 통과시키면 그 시험은 아무것도 안 잡는다. 줄 끝 주석도 걷는다.
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/\s.*$/, "")).join("\n");
let pass = 0, fail = 0;
const ok = (cond, name, why = "") => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${why ? " — " + why : ""}`); } };

let lib = null;
try {
  const out = mkdtempSync(path.join(tmpdir(), "proj-none-"));
  execFileSync(path.join(root, "node_modules/.bin/tsc"),
    [path.join(root, "web/lib/proj-none.ts"), "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"], { stdio: "ignore" });
  lib = await import(path.join(out, "proj-none.js"));
} catch { /* 아래 V0 가 빨간불 */ }
ok(!!lib, "V0 잣대가 잎 모듈(lib/proj-none)에 있다");

if (lib) {
  const { NO_PROJECT_NAME, isLoginSessRow, isSpentLoginSess } = lib;
  ok(NO_PROJECT_NAME === "기타 (미분류)", "N1 묶음 이름 = 「기타 (미분류)」", String(NO_PROJECT_NAME));
  ok(isLoginSessRow({ kind: "login", label: "아무 이름" }) === true, "L1 종류가 login 이면 로그인 세션");
  ok(isLoginSessRow({ label: "AI 로그인 (codex)" }) === true && isLoginSessRow({ label: "AI 로그인 (claude)" }) === true, "L2 종류가 없어도 «AI 로그인 (…)» 은 로그인 세션(옛 서버 · 옛 노드)");
  ok(isLoginSessRow({ kind: "human", label: "내 계정 로그인 (Claude Code)" }) === true, "L3 ★ 종류가 human 이어도 «내 계정 로그인 (…)» 은 로그인 세션");
  ok(isLoginSessRow({ label: "내 계정 로그인" }) === true && isLoginSessRow({ label: "AI 로그인" }) === true, "L4 괄호 없는 꼴도 로그인 세션");
  ok(["AI 로그인 버그 고치기", "로그인 화면 수정", "내 계정 로그인 안 됨", "AI 로그인 (codex) 왜 안 되지", "다시 AI 로그인 (codex)"].every((label) => isLoginSessRow({ label }) === false),
    "L5 ★ 사람이 지은 이름에 그 낱말이 들었을 뿐이면 로그인 세션이 아니다(사람 세션을 숨기지 않는다)");
  ok(isLoginSessRow({ label: "", title: "AI 로그인 (grok)" }) === true && isLoginSessRow({ label: "결제 백오프", title: "AI 로그인 (grok)" }) === false,
    "L6 이름은 label 이 먼저, 비었을 때만 title");
  ok([null, undefined, {}, { label: null, kind: null }].every((r) => isLoginSessRow(r) === false), "L7 빈 값은 로그인 세션이 아니다(던지지 않는다)");
  ok(isLoginSessRow({ kind: "LOGIN" }) === true && isLoginSessRow({ label: "  AI 로그인 (codex)  " }) === true, "L8 종류 대소문자 · 이름 앞뒤 공백을 가리지 않는다");
  ok(["task", "managed", "app", "human", ""].every((kind) => isLoginSessRow({ kind, label: "위탁 #41" }) === false), "L9 다른 종류의 보통 이름은 로그인 세션이 아니다");
  const login = { label: "AI 로그인 (codex)" }, plain = { label: "결제 백오프", kind: "human" };
  ok(isSpentLoginSess(login, false) === true && isSpentLoginSess(login, true) === false && isSpentLoginSess(plain, false) === false && isSpentLoginSess(plain, true) === false,
    "S1 ★★ 끝난 로그인만 숨긴다 — 도는 로그인(지금 로그인 중인 창)과 보통 세션은 그대로 선다");
}

// ───────────────────────── W. 배선 ─────────────────────────
const MAIN = code(read("web/v2/main.ts"));
ok(/const merged = mergeSessions\(lastLive, lastLogs\);\s*const sessions = merged\.filter\(\(s\) => !isSpentLoginSess\(s\.raw, s\.live && s\.alive\)\);/.test(MAIN) && /data = \{ projects, sessions, lists,/.test(MAIN),
  "W1 ★ 셸이 세션 목록을 짤 때 끝난 로그인 세션을 걷는다(사이드바 · 세션 목록 · 카드 접힘이 전부 이 목록을 쓴다)");
ok(/if \(!id\) return NO_PROJECT_NAME;/.test(code(read("web/v2/views.ts"))), "W2 이름 풀이(projName)가 그 이름을 쓴다");
ok(/name: c\.id \? \(first\.project as \{ name: string \}\)\.name : NO_PROJECT_NAME,/.test(code(read("web/v2/side.ts")))
  && /text: NO_PROJECT_NAME \}\), cnt\(plan\.noneN\)/.test(code(read("web/v2/side.ts"))),
  "W3 ★ 홈 카드와 [프로젝트] 사이드바의 리스트 없는 묶음이 **같은 이름 값**을 쓴다");
//  옛 이름이 화면 코드 어디에도 글자로 남아 있지 않다 — 한 곳이라도 남으면 같은 묶음이 두 이름으로 불린다.
const walk = (dir) => readdirSync(path.join(root, dir)).flatMap((f) => { const p = dir + "/" + f; return statSync(path.join(root, p)).isDirectory() ? walk(p) : (/\.ts$/.test(f) ? [p] : []); });
const left = walk("web").filter((p) => /프로젝트 없음/.test(code(read(p))));
ok(left.length === 0, "W4 ★ 화면 코드에 옛 이름(«프로젝트 없음»)이 글자로 남아 있지 않다", left.join(", "));
ok(!/프로젝트 없음/.test(read("public/styles/53-session-history.css")), "W4b 스타일시트가 끼우는 글자에도 옛 이름이 없다");
const PICK = code(read("web/v2/proj-pick.ts"));
ok(PICK.length > 0 && !/pick\(null\)/.test(PICK) && !/프로젝트에서 떼기/.test(PICK) && /onclick: \(\) => \{ if \(!cur\) void pick\(r\.proj\.id\); \}/.test(PICK),
  "W5 ★ 세션 옮기기 창에 「프로젝트에서 떼기」가 없다 — 고를 수 있는 것은 프로젝트뿐이다");

console.log(`\n#4551 「기타 (미분류)」 · 로그인 세션 · 떼기: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
