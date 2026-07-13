#!/usr/bin/env node
// safeMergeUserSettings 유닛테스트 — dedup 정체성(스크립트 파일명+인자) · 구표기 회수 · 사용자 훅 보존.
//  오프라인·fs-only: 샌드박스 HOME(LIVELY_HOME)/CLAUDE_CONFIG_DIR 에서만 동작, 실제 ~/.claude 무접촉.
//  실행: node kit/setup/user-install.test.mjs  (npm test 체인에 포함)
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "ui-test-"));
process.env.LIVELY_HOME = SANDBOX;                       // HOME 리다이렉트(설치기 샌드박스 계약)
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, ".claude"); // settings.json 위치
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
// env 설정 후 동적 import — 모듈 상수(HOME/CLAUDE_DIR/NODEBIN)가 샌드박스 기준으로 굳는다.
const { safeMergeUserSettings, mergeBlocks, userLevelHooksBlock, runnerHooksBlock } = await import("./user-install.mjs");

const SP = join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
const readS = () => JSON.parse(readFileSync(SP, "utf8"));
const countHooks = (s) => Object.values(s.hooks || {}).reduce((n, arr) => n + arr.reduce((m, e) => m + (e.hooks || []).length, 0), 0);
const FULL = () => mergeBlocks(userLevelHooksBlock(), runnerHooksBlock());
const FULL_N = countHooks({ hooks: FULL() }); // 현행 kit 풀세트 크기(전용 5 + run-custom 이벤트 러너)

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };
const bad = (name, why) => { fail++; console.error(`FAIL ${name} — ${why}`); };

// ① 신규 설치 — 빈 settings 에 풀세트가 깔린다.
writeFileSync(SP, "{}\n");
safeMergeUserSettings(FULL());
let s = readS();
countHooks(s) === FULL_N ? ok(`① 신규 설치 → ${FULL_N}개 배선`) : bad("① 신규 설치", `count=${countHooks(s)}≠${FULL_N}`);

// ② 같은 세대 재설치 — 멱등(개수 불변).
safeMergeUserSettings(FULL());
s = readS();
countHooks(s) === FULL_N ? ok("② 동세대 재설치 멱등") : bad("② 멱등", `count=${countHooks(s)}`);

// ③ 구표기 회수 — 맥미니 실측 레이아웃 재현: 구세대(무인용 node, sync 없음 = pre-#636) + 사용자 tmux 훅.
//   재설치 후: 구세대 lively 항목은 전부 최신형으로 교체(중복 0), tmux 는 보존.
const oldGen = {};
for (const [ev, entries] of Object.entries(FULL())) {
  oldGen[ev] = entries
    .filter((e) => !JSON.stringify(e).includes("sync-harness-assets")) // 구세대엔 sync 배선 없음
    .map((e) => ({ ...e, hooks: e.hooks.map((h) => ({ ...h, command: h.command.replace(/^"node"/, "node") })) }));
}
oldGen.Stop = [{ hooks: [{ type: "command", command: 'tmux display-message "done" || true' }] }, ...(oldGen.Stop || [])];
writeFileSync(SP, JSON.stringify({ hooks: oldGen }, null, 2) + "\n");
safeMergeUserSettings(FULL());
s = readS();
const cmds = Object.values(s.hooks).flatMap((arr) => arr.flatMap((e) => (e.hooks || []).map((h) => h.command)));
const oldForm = cmds.filter((c) => /^node "/.test(c) && c.includes(".lively/hooks")).length;
const tmuxKept = cmds.some((c) => c.startsWith("tmux "));
if (oldForm === 0 && tmuxKept && countHooks(s) === FULL_N + 1) ok(`③ 구표기 ${FULL_N - 1}개 회수·교체 + 사용자 훅 보존 (${FULL_N}+tmux)`);
else bad("③ 구표기 회수", `oldForm=${oldForm} tmux=${tmuxKept} count=${countHooks(s)}≠${FULL_N + 1}`);

// ④ 이미 중복 누적된 상태(구+신 공존) — 재설치가 구세대만 걷어내고 한 벌로 수렴.
const doubled = {};
for (const [ev, entries] of Object.entries(FULL())) {
  doubled[ev] = [...(oldGen[ev] || []).filter((e) => (e.hooks || []).every((h) => !h.command.startsWith("tmux"))), ...entries];
}
doubled.Stop.unshift({ hooks: [{ type: "command", command: 'tmux display-message "done" || true' }] });
writeFileSync(SP, JSON.stringify({ hooks: doubled }, null, 2) + "\n");
safeMergeUserSettings(FULL());
s = readS();
countHooks(s) === FULL_N + 1 ? ok("④ 기중복 상태 → 한 벌로 수렴(+사용자 훅)") : bad("④ 기중복 수렴", `count=${countHooks(s)}≠${FULL_N + 1}`);

// ⑤ 사용자가 같은 스크립트를 다른 matcher 로 직접 배선한 항목 — 정체성이 같아도 matcher 가 다르면 불변.
const custom = { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$HOME/.lively/hooks/work-flag.mjs"' }] }] };
writeFileSync(SP, JSON.stringify({ hooks: custom }, null, 2) + "\n");
safeMergeUserSettings(FULL());
s = readS();
const bashKept = (s.hooks.PostToolUse || []).some((e) => e.matcher === "Bash");
bashKept ? ok("⑤ 다른 matcher 의 동일 스크립트 항목 보존") : bad("⑤ matcher 격리", "Bash 항목 소실");

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`user-install tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);
