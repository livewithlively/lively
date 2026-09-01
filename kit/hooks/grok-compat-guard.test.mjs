#!/usr/bin/env node
// grok compat 이중발화 가드 사양테스트(#1701) — isForeignGrokInvocation 단위 + **러너 5종 실스폰** 통합.
//  왜: grok 은 ~/.claude/settings.json 의 우리 훅을 기본값으로 그대로 실행한다(compat). 가드가 없으면 같은
//  러너가 grok 네이티브 배선과 두 번 돌고 camelCase 페이로드를 오파싱한다. 가드가 **너무 넓으면** 반대로
//  grok 안에서 띄운 중첩 claude 세션의 훅이 전멸한다(GG5 가 그 경계다).
//  실행: node kit/hooks/grok-compat-guard.test.mjs   (kit/**/*.test.mjs 라 npm test 체인에 자동 포함)
//
//  엣지 표(GG1~GG6b)는 <스크래치패드>/spec-grok-wiring.md — 케이스 이름의 [GG#] 가 그 행 번호다.
//  단언은 문구가 아니라 **부작용**으로: exit0 + stdout 빈 + 파일 지문(플래그 생성 유무).
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isForeignGrokInvocation } from "./harness-registry.mjs";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// ── 단위 (GG1~GG5) — 순수 함수라 env 를 인자로 주입한다 ───────────────────────
eq("GG1 claude 세션(마커 없음) → false", isForeignGrokInvocation([], {}), false);
eq("GG2 GROK_HOOK_EVENT + 하네스 미지정 → true(compat 사본)", isForeignGrokInvocation([], { GROK_HOOK_EVENT: "stop" }), true);
eq("GG3 GROK_HOOK_EVENT + LIVELY_HARNESS=grok → false(어댑터 경로)", isForeignGrokInvocation([], { GROK_HOOK_EVENT: "stop", LIVELY_HARNESS: "grok" }), false);
eq("GG4 GROK_HOOK_EVENT + argv --harness grok → false", isForeignGrokInvocation(["--harness", "grok"], { GROK_HOOK_EVENT: "stop" }), false);
// [GG5] (경계) grok 세션 안에서 띄운 **중첩 claude** — 툴 서브프로세스에 GROK_SESSION_ID 류가 상속될 수 있지만
//  GROK_HOOK_EVENT 는 훅 프로세스에만 주입된다(#1701 실측). 세션 id 만으로 가드가 발동하면 그 claude 의 훅이 전멸한다.
eq("GG5 GROK_SESSION_ID 만(훅 컨텍스트 아님) → false", isForeignGrokInvocation([], { GROK_SESSION_ID: "x" }), false);
// 다른 하네스 명시(코드가 grok 훅 안에서 codex 러너를 부르는 기형 경로)도 사본 취급 — 정본은 grok 경로뿐.
eq("GG2b GROK_HOOK_EVENT + LIVELY_HARNESS=codex → true", isForeignGrokInvocation([], { GROK_HOOK_EVENT: "stop", LIVELY_HARNESS: "codex" }), true);

// ── 통합 (GG6·GG6b) — 러너를 **실제로 스폰**해 가드의 부작용 차단을 지문으로 본다 ──
const SB = mkdtempSync(join(tmpdir(), "grok-guard-test-"));
const HOME = join(SB, "home");
const TMP = join(SB, "tmp");                       // os.tmpdir() 리다이렉트(FLAG_DIR 격리)
const FLAGS = join(TMP, "lively-hooks");           // work-flag 의 플래그 디렉터리(tmpdir 파생)
mkdirSync(join(HOME, ".lively"), { recursive: true });
mkdirSync(TMP, { recursive: true });
writeFileSync(join(HOME, ".lively", "gateway-url"), "http://127.0.0.1:9\n");   // 토큰 없음 = 네트워크 fail-soft

const treeList = (d) => {
  if (!existsSync(d)) return [];
  const out = [];
  const walk = (p) => { for (const f of readdirSync(p, { withFileTypes: true })) { const q = join(p, f.name); f.isDirectory() ? walk(q) : out.push(q.slice(SB.length)); } };
  walk(d);
  return out.sort();
};
const runRunner = (script, extraEnv, payload) => spawnSync(process.execPath, [join(HOOKS_DIR, script)], {
  input: JSON.stringify(payload), encoding: "utf8", timeout: 20000, killSignal: "SIGKILL",
  // ⚠ tmpdir 리다이렉트는 세 변수 전부 — POSIX 는 TMPDIR 를 보지만 **Windows 의 os.tmpdir() 는 TMPDIR 를
  //  무시하고 TEMP→TMP 를 본다**(CI 윈도우 실측: TMPDIR 만 주면 러너가 실 TEMP 에 플래그를 써서 GG6b 가
  //  '플래그 0개'로 오판 — 런북 ⑥⑦과 같은 '윈도우에서만 조용히 빗나가는' 부류).
  // ⚠ LIVELY_SESSION_ID·LIVELY_TOKEN 을 비운다 — 이 테스트가 **웹터미널 박스 안에서** 돌면(개발자가 세션에서 npm test) 러너가
  //  process.env 의 박스 id 를 물려받고, work-flag 는 토큰을 실 홈(~/.lively/token — LIVELY_HOME 아님)에서 읽어 **실 게이트웨이에**
  //  `session_id: "ggsid-open"` 을 그 박스의 대화 UUID 로 보고한다(2026-08-18 실측: dev 박스 3개의 claude_session_id 가 ggsid-open 으로
  //  덮여 정밀 복원·세션 대화창(#1719)이 기록을 못 찾았다). 박스 밖(CI)에서는 원래 없던 값이라 무해하다.
  env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME, TMPDIR: TMP, TEMP: TMP, TMP: TMP, GROK_HOOK_EVENT: "stop", LIVELY_HARNESS: "", LIVELY_SESSION_ID: "", LIVELY_TOKEN: "", ...extraEnv },
});

// [GG6] 가드 발동 — 러너 5종: exit0 + stdout 빈 + 샌드박스( .lively + tmp ) 무변화.
{
  const TEMPTING = { hook_event_name: "PostToolUse", session_id: "ggsid-guarded", tool_name: "lively__knowledge_save", tool_input: {}, cwd: SB };
  for (const script of ["session-preload.mjs", "work-flag.mjs", "stop-writeback-gate.mjs", "run-custom.mjs", "sync-harness-assets.mjs"]) {
    const before = JSON.stringify([treeList(join(HOME, ".lively")), treeList(TMP)]);
    const r = runRunner(script, {}, TEMPTING);
    const after = JSON.stringify([treeList(join(HOME, ".lively")), treeList(TMP)]);
    const silent = String(r.stdout || "").trim() === "";
    (r.status === 0 && silent && before === after)
      ? ok(`GG6 ${script} — compat 사본 가드(exit0·무출력·부작용 0)`)
      : bad(`GG6 ${script}`, `exit=${r.status} silent=${silent} 무변화=${before === after}`);
  }
}

// [GG6b] 정본 경로(LIVELY_HARNESS=grok) — 가드를 통과해 **실제 부작용**(플래그 파일)이 생긴다.
//  vacuous 방지의 배선 단언을 겸한다: 위 GG6 의 '부작용 0' 이 관측 장치 고장이 아니라 가드 덕임을 증명.
{
  const r = runRunner("work-flag.mjs", { LIVELY_HARNESS: "grok" },
    { hook_event_name: "PostToolUse", session_id: "ggsid-open", tool_name: "lively__knowledge_save", tool_input: {}, cwd: SB });
  const flags = treeList(FLAGS).filter((f) => f.includes("ggsid-open"));
  (r.status === 0 && flags.some((f) => f.endsWith("ggsid-open.lively")))
    ? ok(`GG6b work-flag 정본 경로 — 가드 통과·플래그 생성(${flags.length}개)`)
    : bad("GG6b 정본 경로", `exit=${r.status} flags=${JSON.stringify(flags)} dir=${JSON.stringify(treeList(FLAGS))}`);
}

rmSync(SB, { recursive: true, force: true });
console.log(`\n${fail ? "✗" : "✓"} grok-compat-guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
