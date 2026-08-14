#!/usr/bin/env node
// reconcileExtPullWiring 유닛테스트 — 사양 #959("자체설치 MCP 커버 배선 회수") 기반 블랙박스.
//   순수 함수: (settings.hooks 객체, { extPullCmd, pullTools }) → hooks 제자리 수정 + boolean 반환.
//   ext 엔트리 = hook 명령이 sentinel 인자 `--ext-pull` 로 끝나는(=우리 소유) PostToolUse 엔트리.
//   실행: node kit/hooks/session-preload.test.mjs  (exit 0=통과, 1=실패). 오프라인·순수(파일 I/O·네트워크 불요).
//   ⚠ 구현을 재진술하지 않는다 — 관찰 가능한 입출력/상태변화만 단언한다(사양의 각 §행위·§엣지).
import { reconcileExtPullWiring, applyExtPullWiring } from "./session-preload.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandboxEnv, applySandboxEnv } from "../testlib/os-sandbox.mjs";   // HOME 만으론 윈도우 격리가 안 된다(#1510)

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why = "") => { cond ? ok(n) : bad(n, why); };
// 시나리오 단위 try — reconcile 가 예기치 않게 throw 하면 그 라벨로 실패 기록(파일 전체는 계속).
const run = (n, fn) => { try { fn(); } catch (e) { bad(n, `threw: ${(e && e.message) || e}`); } };

// ── 픽스처 ──
// ext 엔트리 명령: 끝이 `--ext-pull` sentinel 이기만 하면 됨(사양 §용어).
const CMD = 'node "/repo/kit/hooks/work-flag.mjs" --ext-pull';

// ── ext 엔트리 식별(사양 근거): PostToolUse 엔트리 중 hook 명령에 `--ext-pull` 이 든 것 ──
const isExt = (e) => Array.isArray(e && e.hooks) &&
  e.hooks.some((h) => h && typeof h.command === "string" && h.command.includes("--ext-pull"));
const post = (hooks) => (Array.isArray(hooks && hooks.PostToolUse) ? hooks.PostToolUse : []);
const extEntries = (hooks) => post(hooks).filter(isExt);
const nonExt = (hooks) => post(hooks).filter((e) => !isExt(e));
const extMatcher = (hooks) => {
  const e = extEntries(hooks);
  return e.length === 1 ? e[0].matcher : `<ext 엔트리 ${e.length}개>`;
};
const extCmdIsVerbatim = (hooks) => {
  const e = extEntries(hooks)[0];
  return !!e && Array.isArray(e.hooks) && e.hooks.some((h) => h.command === CMD);
};

// 순서 무관 다중집합 비교(사양 §행위5 "개수·내용 보존" — 순서는 명시 대상 아님)
const bag = (arr) => arr.map((x) => JSON.stringify(x)).sort();
const bagEq = (a, b) => { const A = bag(a), B = bag(b); return A.length === B.length && A.every((v, i) => v === B[i]); };

// 매 테스트 새 객체(교차 오염 방지). sentinel 없는 사용자/기타 엔트리 3개 + SessionStart 1개.
function baseHooks() {
  return {
    PostToolUse: [
      { matcher: "mcp__lively__.*", hooks: [{ type: "command", command: 'node "/repo/kit/hooks/work-flag.mjs"' }] },
      { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: 'node "/repo/kit/hooks/writeback-flag.mjs"' }] },
      { matcher: "Bash", hooks: [{ type: "command", command: 'node "/repo/kit/hooks/bash-note.mjs"' }] },
    ],
    SessionStart: [
      { hooks: [{ type: "command", command: 'node "/repo/kit/hooks/session-preload.mjs"' }] },
    ],
  };
}
const apply = (hooks, pullTools) => reconcileExtPullWiring(hooks, { extPullCmd: CMD, pullTools });

// ══════════════════════════════════════════════════════════════════════════
// §행위 2 + 기본값: 비-lively prefix 0개(기본값 lively-only) → ext 안 생김, false, 무변경
run("행위2 기본값(lively-only) 신규 적용", () => {
  const h = baseHooks();
  const snap = JSON.stringify(h);
  const r = apply(h, ["mcp__lively__ext__"]);
  check("행위2 기본값 → 반환 false", r === false, `return=${JSON.stringify(r)}`);
  check("행위2 기본값 → ext 엔트리 0개(안 생김)", extEntries(h).length === 0, `count=${extEntries(h).length}`);
  check("행위2 기본값 → hooks 무변경", JSON.stringify(h) === snap, "hooks 가 변형됨");
});

// §행위 1: 단일 비-lively prefix → matcher '<prefix>.*', command=extPullCmd 그대로, PostToolUse 배치, true
run("행위1 단일 비-lively prefix 파생", () => {
  const h = baseHooks();
  const nonBefore = nonExt(h);
  const ssBefore = JSON.stringify(h.SessionStart);
  const r = apply(h, ["mcp__notion__"]);
  check("행위1 단일 → 반환 true", r === true, `return=${JSON.stringify(r)}`);
  check("행위1 단일 → ext 정확히 1개", extEntries(h).length === 1, `count=${extEntries(h).length}`);
  check("행위1 단일 → matcher = 'mcp__notion__.*'", extMatcher(h) === "mcp__notion__.*", `matcher=${extMatcher(h)}`);
  check("행위1 단일 → command = extPullCmd 그대로", extCmdIsVerbatim(h), "ext 명령이 extPullCmd 와 불일치");
  check("행위1 단일 → 비-ext 엔트리 개수·내용 보존", bagEq(nonExt(h), nonBefore), "비-ext 엔트리 변형됨");
  check("행위1 단일 → SessionStart 불침", JSON.stringify(h.SessionStart) === ssBefore, "SessionStart 변형됨");
});

// §행위 1: 복수 비-lively prefix → '.*' 접미 + '|' 결합
run("행위1 복수 비-lively prefix 파생", () => {
  const h = baseHooks();
  const r = apply(h, ["mcp__notion__", "mcp__figma__"]);
  check("행위1 복수 → 반환 true", r === true, `return=${JSON.stringify(r)}`);
  check("행위1 복수 → ext 1개", extEntries(h).length === 1, `count=${extEntries(h).length}`);
  check("행위1 복수 → matcher = 'mcp__notion__.*|mcp__figma__.*'",
    extMatcher(h) === "mcp__notion__.*|mcp__figma__.*", `matcher=${extMatcher(h)}`);
});

// §엣지: alternation 순서는 입력 pullTools 의 비-lively 항목 순서를 따른다
run("엣지 matcher alternation = 입력 순서 유지", () => {
  const h = baseHooks();
  apply(h, ["mcp__figma__", "mcp__notion__"]);
  check("엣지 순서 → matcher = 'mcp__figma__.*|mcp__notion__.*'",
    extMatcher(h) === "mcp__figma__.*|mcp__notion__.*", `matcher=${extMatcher(h)}`);
});

// §행위 2: 혼합 목록에서 lively prefix 만 제외(비-lively 만 파생)
run("행위2 혼합 목록 → lively prefix 제외", () => {
  const h = baseHooks();
  const r = apply(h, ["mcp__lively__ext__", "mcp__notion__"]);
  check("행위2 혼합 → 반환 true", r === true, `return=${JSON.stringify(r)}`);
  check("행위2 혼합 → ext 1개", extEntries(h).length === 1, `count=${extEntries(h).length}`);
  check("행위2 혼합 → matcher = 'mcp__notion__.*'(lively 빠짐)",
    extMatcher(h) === "mcp__notion__.*", `matcher=${extMatcher(h)}`);
});

// §행위 2 + §엣지: lively 가 중간에 껴도 제외되며 나머지 순서 유지
run("행위2 중간 lively 제외 & 나머지 순서", () => {
  const h = baseHooks();
  apply(h, ["mcp__notion__", "mcp__lively__ext__", "mcp__figma__"]);
  check("행위2 중간 제외 → matcher = 'mcp__notion__.*|mcp__figma__.*'",
    extMatcher(h) === "mcp__notion__.*|mcp__figma__.*", `matcher=${extMatcher(h)}`);
});

// §행위 3: 빈 목록 → 기존 ext 엔트리 제거, true
run("행위3 빈 목록 → 기존 ext 제거", () => {
  const h = baseHooks();
  const nonBefore = nonExt(h);
  const a = apply(h, ["mcp__notion__"]);              // 먼저 ext 생성
  check("행위3 사전조건: ext 1개 생성됨", a === true && extEntries(h).length === 1, `count=${extEntries(h).length}`);
  const r = apply(h, []);                              // 빈 목록으로 끄기
  check("행위3 빈 목록 → 반환 true", r === true, `return=${JSON.stringify(r)}`);
  check("행위3 빈 목록 → ext 0개(제거됨)", extEntries(h).length === 0, `count=${extEntries(h).length}`);
  check("행위3 빈 목록 → 비-ext 보존", bagEq(nonExt(h), nonBefore), "비-ext 엔트리 변형됨");
});

// §행위 3: lively-only 재적용(비-lively 0개)도 기존 ext 제거
run("행위3 lively-only 재적용 → 기존 ext 제거", () => {
  const h = baseHooks();
  apply(h, ["mcp__notion__"]);
  const r = apply(h, ["mcp__lively__ext__"]);
  check("행위3 lively-only → 반환 true", r === true, `return=${JSON.stringify(r)}`);
  check("행위3 lively-only → ext 0개", extEntries(h).length === 0, `count=${extEntries(h).length}`);
});

// §엣지: undefined pullTools + 기존 ext 있음 → 0개 취급으로 제거, true
run("엣지 undefined pullTools(기존 ext 있음) → 제거", () => {
  const h = baseHooks();
  apply(h, ["mcp__notion__"]);
  const r = apply(h, undefined);
  check("엣지 undefined → 반환 true", r === true, `return=${JSON.stringify(r)}`);
  check("엣지 undefined → ext 0개(제거)", extEntries(h).length === 0, `count=${extEntries(h).length}`);
});

// §행위 4(핵심): 교체(회수) — 기존 ext 있는 상태에 다른 pullTools → ext 정확히 1개 + 새 matcher
run("행위4 교체(회수) — 정확히 1개, 새 matcher", () => {
  const h = baseHooks();
  apply(h, ["mcp__notion__"]);                         // 세션 N
  const r = apply(h, ["mcp__linear__"]);               // 세션 N+1: 다른 pullTools
  check("행위4 교체 → 반환 true", r === true, `return=${JSON.stringify(r)}`);
  check("행위4 교체 → ext 정확히 1개(2개면 훅 중복 → 실패)", extEntries(h).length === 1, `count=${extEntries(h).length}`);
  check("행위4 교체 → matcher = 새 값 'mcp__linear__.*'",
    extMatcher(h) === "mcp__linear__.*", `matcher=${extMatcher(h)}`);
});

// §행위 4: prefix 개수가 변해도(1→2) 여전히 ext 1개 + 새 matcher
run("행위4 교체 — prefix 개수 변화에도 1개", () => {
  const h = baseHooks();
  apply(h, ["mcp__notion__"]);
  const r = apply(h, ["mcp__linear__", "mcp__slack__"]);
  check("행위4 교체(1→2) → 반환 true", r === true, `return=${JSON.stringify(r)}`);
  check("행위4 교체(1→2) → ext 1개", extEntries(h).length === 1, `count=${extEntries(h).length}`);
  check("행위4 교체(1→2) → matcher = 'mcp__linear__.*|mcp__slack__.*'",
    extMatcher(h) === "mcp__linear__.*|mcp__slack__.*", `matcher=${extMatcher(h)}`);
});

// §행위 6: 멱등 — 같은 pullTools 재적용 → false + 무변경
run("행위6 멱등 — 같은 pullTools 재적용", () => {
  const h = baseHooks();
  const r1 = apply(h, ["mcp__notion__"]);
  const snap = JSON.stringify(h);
  const r2 = apply(h, ["mcp__notion__"]);
  check("행위6 1차 → true", r1 === true, `return=${JSON.stringify(r1)}`);
  check("행위6 2차 동일 → 반환 false", r2 === false, `return=${JSON.stringify(r2)}`);
  check("행위6 2차 → hooks 무변경", JSON.stringify(h) === snap, "hooks 가 변형됨");
  check("행위6 2차 → ext 여전히 1개", extEntries(h).length === 1, `count=${extEntries(h).length}`);
});

// §행위 3 + §엣지: 빈 배열 신규 적용(기존 ext 없음) → 무변경, false
run("행위3/엣지 빈 배열 신규(기존 ext 없음) → 무변경", () => {
  const h = baseHooks();
  const snap = JSON.stringify(h);
  const r = apply(h, []);
  check("빈 배열 신규 → 반환 false", r === false, `return=${JSON.stringify(r)}`);
  check("빈 배열 신규 → ext 0개", extEntries(h).length === 0, `count=${extEntries(h).length}`);
  check("빈 배열 신규 → hooks 무변경", JSON.stringify(h) === snap, "hooks 가 변형됨");
});

// §엣지: 비배열 pullTools(문자열·숫자·객체·null·불리언) → 0개 취급 → 무변경, false
run("엣지 비배열 pullTools → 0개 취급(무변경/false)", () => {
  for (const v of ["mcp__notion__", 42, {}, null, true]) {
    const h = baseHooks();
    const snap = JSON.stringify(h);
    const r = apply(h, v);
    const tag = JSON.stringify(v);
    check(`엣지 비배열(${tag}) → 반환 false`, r === false, `return=${JSON.stringify(r)}`);
    check(`엣지 비배열(${tag}) → ext 0개`, extEntries(h).length === 0, `count=${extEntries(h).length}`);
    check(`엣지 비배열(${tag}) → hooks 무변경`, JSON.stringify(h) === snap, "hooks 가 변형됨");
  }
});

// §행위 5: 사용자/기타 엔트리 불침 — 생성→교체→제거 전 구간에서 개수·내용·SessionStart 보존
run("행위5 사용자/기타 엔트리 불침(전 구간)", () => {
  const h = baseHooks();
  const nonBase = nonExt(h);
  const ssBase = JSON.stringify(h.SessionStart);
  apply(h, ["mcp__notion__"]);                                  // 생성
  check("행위5 생성 후 → 비-ext 개수 유지", nonExt(h).length === nonBase.length, `count=${nonExt(h).length}`);
  check("행위5 생성 후 → 비-ext 내용 보존", bagEq(nonExt(h), nonBase), "비-ext 변형");
  apply(h, ["mcp__linear__", "mcp__slack__"]);                  // 교체
  check("행위5 교체 후 → 비-ext 보존", bagEq(nonExt(h), nonBase), "비-ext 변형");
  apply(h, []);                                                 // 제거
  check("행위5 제거 후 → 비-ext 보존", bagEq(nonExt(h), nonBase), "비-ext 변형");
  check("행위5 전 구간 → SessionStart 불침", JSON.stringify(h.SessionStart) === ssBase, "SessionStart 변형");
});

// §엣지: PostToolUse 부재 + 생성 필요 → PostToolUse 만들어 ext 배치(행위1은 ext 를 PostToolUse 에 둔다)
run("엣지 PostToolUse 부재 + 생성 → ext 를 PostToolUse 에 배치", () => {
  const h = { SessionStart: [{ hooks: [{ type: "command", command: "x" }] }] };
  const ssBefore = JSON.stringify(h.SessionStart);
  const r = apply(h, ["mcp__notion__"]);
  check("엣지 부재+생성 → 반환 true", r === true, `return=${JSON.stringify(r)}`);
  check("엣지 부재+생성 → PostToolUse 에 ext 1개", extEntries(h).length === 1, `count=${extEntries(h).length}`);
  check("엣지 부재+생성 → matcher = 'mcp__notion__.*'", extMatcher(h) === "mcp__notion__.*", `matcher=${extMatcher(h)}`);
  check("엣지 부재+생성 → SessionStart 불침", JSON.stringify(h.SessionStart) === ssBefore, "SessionStart 변형");
});

// §엣지: PostToolUse 부재 + 비-lively 0개 → 다룰 ext 없음 → 무해 no-op, false
run("엣지 PostToolUse 부재 + 비-lively 0개 → no-op", () => {
  const h = { SessionStart: [{ hooks: [{ type: "command", command: "x" }] }] };
  const ssBefore = JSON.stringify(h.SessionStart);
  const r = apply(h, ["mcp__lively__ext__"]);
  check("엣지 부재+lively-only → 반환 false", r === false, `return=${JSON.stringify(r)}`);
  check("엣지 부재+lively-only → ext 0개", extEntries(h).length === 0, `count=${extEntries(h).length}`);
  check("엣지 부재+lively-only → SessionStart 불침", JSON.stringify(h.SessionStart) === ssBefore, "SessionStart 변형");
});

// §엣지: PostToolUse 비배열 + 빈 목록 → 크래시 없이 false
run("엣지 PostToolUse 비배열 + 빈 목록 → 크래시 없이 false", () => {
  const h = { PostToolUse: null, SessionStart: [] };
  const r = apply(h, []);
  check("엣지 비배열 PostToolUse + [] → 반환 false", r === false, `return=${JSON.stringify(r)}`);
  check("엣지 비배열 PostToolUse + [] → ext 0개", extEntries(h).length === 0, `count=${extEntries(h).length}`);
});

// ── applyExtPullWiring (I/O wrapper) — 샌드박스 ~/.claude/settings.json, 게이트웨이 불요 ──
//  메인 work-flag 엔트리를 찾아 그 command 를 미러(+ --ext-pull)해 배선하고, pull_tools 변경 시 회수하는 파일 왕복.
run("wrapper: 메인 엔트리 미러 + 배선/회수", () => {
  const SB = mkdtempSync(join(tmpdir(), "sp-wrap-"));
  const restoreHome = applySandboxEnv({ home: SB });   // HOME 만 대입하면 윈도우는 안 따라온다(#1510)
  try {
    mkdirSync(join(SB, ".claude"), { recursive: true });
    const sp = join(SB, ".claude", "settings.json");
    const mainCmd = `"node" "${join(SB, ".lively", "hooks", "work-flag.mjs")}"`; // .lively/hooks 경로(kitHookId 매칭)
    const seed = { hooks: { PostToolUse: [
      { matcher: "mcp__lively__.*", hooks: [{ type: "command", command: mainCmd }] },
      { matcher: "Bash", hooks: [{ type: "command", command: mainCmd }] }, // 사용자 훅
    ] } };
    writeFileSync(sp, JSON.stringify(seed));
    const read = () => JSON.parse(readFileSync(sp, "utf8")).hooks.PostToolUse;
    const extOf = (ptu) => ptu.filter((e) => (e.hooks || []).some((h) => /--ext-pull/.test(h.command)));

    // 기본값(lively-only) → 배선 없음, 파일 무변경.
    const c0 = applyExtPullWiring(["mcp__lively__ext__"]);
    check("wrapper 기본값 → 변경 false", c0 === false, `c0=${c0}`);
    check("wrapper 기본값 → ext 0개", extOf(read()).length === 0, "");

    // notion 추가 → ext 엔트리 1개, matcher mcp__notion__.*, command 가 메인 미러(+--ext-pull).
    const c1 = applyExtPullWiring(["mcp__lively__ext__", "mcp__notion__"]);
    const e1 = extOf(read());
    check("wrapper notion → 변경 true", c1 === true, `c1=${c1}`);
    check("wrapper notion → ext 1개 · matcher mcp__notion__.*", e1.length === 1 && e1[0].matcher === "mcp__notion__.*", JSON.stringify(e1));
    check("wrapper notion → command = 메인 미러 + --ext-pull", e1[0].hooks[0].command === `${mainCmd} --ext-pull`, e1[0].hooks[0].command);
    check("wrapper notion → 사용자 Bash 훅 보존", read().some((e) => e.matcher === "Bash"), "");

    // linear 로 교체 → ext 여전히 1개(회수됨), 새 matcher.
    applyExtPullWiring(["mcp__linear__"]);
    const e2 = extOf(read());
    check("wrapper 교체 → ext 정확히 1개(회수)", e2.length === 1 && e2[0].matcher === "mcp__linear__.*", JSON.stringify(e2));

    // 비움 → ext 제거.
    applyExtPullWiring(["mcp__lively__ext__"]);
    check("wrapper 비움 → ext 0개(제거)", extOf(read()).length === 0, "");

    // 메인 엔트리가 없으면(비정상) 손대지 않음.
    writeFileSync(sp, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "tmux x" }] }] } }));
    const cN = applyExtPullWiring(["mcp__notion__"]);
    check("wrapper 메인 부재 → 무동작(false)", cN === false, `cN=${cN}`);

    // ★matcher pin★ — 사용자가 work-flag 를 mcp__lively__.* 가 아닌 matcher(Bash)로 직접 단 것뿐이면, 그걸 '메인'으로
    //  오인해 미러하지 않는다(정체성 = matcher mcp__lively__.* + 무인자). → mainCmd 못 찾음 → 무동작(false).
    //  (matcher 조건이 없으면 이 Bash work-flag 를 메인으로 착각해 엉뚱한 ext 엔트리를 만든다.)
    writeFileSync(sp, JSON.stringify({ hooks: { PostToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: mainCmd }] }, // 진짜 work-flag 지만 matcher 가 다름
    ] } }));
    const cB = applyExtPullWiring(["mcp__notion__"]);
    check("wrapper Bash-matcher work-flag 만 있음 → 메인 아님(무동작 false)", cB === false && extOf(read()).length === 0, `cB=${cB} ext=${extOf(read()).length}`);
  } finally {
    restoreHome();
    rmSync(SB, { recursive: true, force: true });
  }
});

// ── main-guard 무결성 — 파일을 직접 실행하면 main() 이 실제로 돌아야 한다(내가 최상위를 main() 으로 감쌌으니 확인 필수) ──
//  게이트웨이 죽음(오프라인) → main 의 catch 가 로컬 STATIC(=~/.lively/context.md)을 stdout 으로 내보낸다.
//  ⚠ exit 0 만 보면 약하다(guard 가 깨져 main 이 아예 안 돌아도 자연 exit 0). 그래서 context.md 에 마커를 심고
//   **stdout 에 그 마커가 나오는지**로 main() 실행을 입증한다(import 안전은 위 77단언이 돈 것으로 이미 입증).
run("main-guard: 직접 실행 시 main() 이 STATIC 을 주입(마커 출력)", () => {
  const HOOK = join(fileURLToPath(import.meta.url), "..", "session-preload.mjs");
  const SB = mkdtempSync(join(tmpdir(), "sp-main-"));
  mkdirSync(join(SB, ".lively"), { recursive: true });
  const MARK = "LIVELY_MAIN_GUARD_PROBE_959";
  writeFileSync(join(SB, ".lively", "context.md"), `# ${MARK}\n`);
  let out = "", code = -1;
  try {
    out = execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
      env: { ...process.env, ...sandboxEnv({ home: SB }), LIVELY_GATEWAY_URL: "http://127.0.0.1:9", LIVELY_TOKEN: "x", LIVELY_OFF: "", LIVELY_HOOKS_OFF: "" },
      timeout: 20000, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    });
    code = 0;
  } catch (e) { code = typeof e.status === "number" ? e.status : `sig:${e.signal || e.code}`; out = e.stdout || ""; }
  rmSync(SB, { recursive: true, force: true });
  check("main-guard: exit 0", code === 0, `exit=${code}`);
  check("main-guard: main() 실행 입증(stdout 에 STATIC 마커)", out.includes(MARK), `stdout=${JSON.stringify(out.slice(0, 120))}`);
});

console.log(`session-preload tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);
