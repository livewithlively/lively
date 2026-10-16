#!/usr/bin/env node
// 일하는 중에 보낸 말이 다시 열면 대화창에서 사라지던 것 (#4850, 런타임) — 다시 열기 · 위로 더 · 발자취.
//
//  신고 맥락(상민님 2026-10-16, 프로젝트 #4850): 하네스(Claude Code)가 일하는 동안 대화창에서 보낸 말은 기록에 사람 말 줄(type:user)이
//   아니라 끼워 넣기 줄(attachment · queued_command)로만 남는다. 대화창은 그 줄 가운데 작업 끝 알림만 그려, 세션을 다시 열면 그 말이
//   대화에서 사라졌다 — AI 의 답은 그 말을 받아 이어지는데 사람이 한 말이 화면에 없다.
//  터미널(Claude Code 2.1.301 tmux 실측)은 그 줄을 첫 지시와 똑같은 `❯ 말` 로 파일의 그 자리(도구 결과 다음 · 답 앞)에 그린다 — 라이브도,
//   다시 열기(--resume)도. 대기 중(아직 안 끼워 넣음)엔 맨 아래에 두고 하던 일의 출력은 그 위로 쌓는다.
//
//  엣지 표(행마다 장면 하나 — 지식 queued-say-chat-render-4850 §사양 의 R 행):
//   R1 다시 열기 · A → 도구 → B(끼워 넣기, 사람) → 답 → 턴 끝 (tui · desktop 두 문법) → B 가 내 말로 한 번 · 순서 A < 도구 < B < 답 · 답은 B 턴
//   R2 작업 끝 알림 끼워 넣기 → tui 한 줄 알림(`finished`)으로 남는다 · 내 말 아님(종전 그대로)
//   R3 사람이 아닌 끼워 넣기(하위 에이전트 보고 · 채널 중계 · 코디네이터) → 내 말로 안 그린다
//   R4 같은 정체성(사람 말 줄 uuid X 와 끼워 넣기 source_uuid X)이 두 번 → 한 번 · 사람이 같은 글을 다시 보냄(정체성 다름) → 두 번(터미널과 같다)
//   R9 위로 더 불러오기 · 끼워 넣은 말이 이전 창에 있다 → 그 자리에 한 번 · 발자취의 장 열쇠 = 그 줄의 uuid(얇은 판과 같은 열쇠)
//   R10 발자취 · 얇은 판 되감기(replayTrail)가 끼워 넣은 사람 말을 장 머리로 세운다(열쇠 = 그 줄 uuid) · 사람이 아닌 끼워 넣기는 아니다 ·
//       라이브(대화창)도 같은 열쇠로 세운다
//
//  장면·가짜 서버는 queued-say-harness.mjs 한 벌(두 시험 파일이 묶음 하나씩 돌린다). 세션 화면은 실제 모듈을 싣는다.
//  fail-first: `SRC_ROOT=<옛 트리>`(web/ · public/styles 가 있는 곳)로 옛 코드를 물린다. 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import path from "node:path";
import { findChrome } from "./headless-chrome.mjs";
import { runQueuedSayScenes } from "./queued-say-harness.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 다시 열기 · 위로 더 · 발자취 런타임 검증 미실행"); process.exit(0); }
const R = await runQueuedSayScenes(chrome, "reopen", ROOT);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${JSON.stringify(got)}`); } };
if (R.fatal || R.err) { fail++; console.error(`FAIL  페이지가 던졌다: ${String(R.fatal || R.err).split("\n").slice(0, 3).join(" | ")}`); }
const B1 = "B 일하는 중에 보낸 말 — 이것도 같이 봐 줘";

for (const k of ["r1t", "r1d"]) {
  const r = R[k] || {};
  const look = k === "r1t" ? "tui" : "desktop";
  check(r.b === 1 && JSON.stringify(r.asks) === JSON.stringify(["A 첫 지시 — 로그 정리해 줘", B1]),
    `R1 ${look} — 다시 연 화면에 일하는 중 보낸 말이 내 말로 한 번 선다(A 다음 · 두 번째 사람 말)`, r);
  check(r.tool && r.tool.ask === "A 첫 지시 — 로그 정리해 줘" && r.ans && r.ans.ask === B1 && r.tool.i < r.ans.i,
    `R1 ${look} — 순서가 터미널과 같다: 도구 결과는 A 턴, 그 말 뒤의 답은 B 턴`, { tool: r.tool, ans: r.ans });
}
check((R.r1t || {}).trail && R.r1t.trail.includes("turn:q-b"), "R1/R10 라이브 발자취 — 끼워 넣은 말도 장 머리로 선다(열쇠 = 그 줄 uuid · 얇은 판과 같다)", (R.r1t || {}).trail);

const r2 = R.r2 || {};
check(JSON.stringify(r2.asks) === JSON.stringify(["A 지시"]) && (r2.notices || []).some((n) => /기록: 정리" finished/.test(n)) && !r2.raw,
  "R2 작업 끝 알림 끼워 넣기는 종전처럼 한 줄 알림 — 내 말로 안 선다 · 꼬리표 원문이 안 보인다", r2);

const r3 = R.r3 || {};
check(JSON.stringify(r3.asks) === JSON.stringify(["A 지시"]) && !r3.p && !r3.c && !r3.k,
  "R3 사람이 아닌 끼워 넣기(하위 에이전트 보고 · 채널 중계 · 코디네이터)는 내 말로 안 그린다", r3);

check((R["box-r4a"] || {}).x === 1, "R4 같은 정체성(사람 말 줄 uuid = 끼워 넣기 source_uuid)이 두 번 적혀도 한 번만", R["box-r4a"]);
check((R["box-r4b"] || {}).y === 2, "R4 사람이 같은 글을 다시 보냄(정체성 다름 — 로그인 오류 뒤) → 두 번(터미널도 두 번 보인다)", R["box-r4b"]);

const r9 = R.r9 || {};
check(r9.size > 1_600_000, "R9 전제 — 기록이 한 창(1.5MB)보다 길다", r9.size);
check(r9.b === 1 && r9.tool && r9.ans && r9.tool.ask === "A 오래전 지시" && r9.ans.ask === "B 오래전에 끼워 넣은 말" && JSON.stringify(r9.asks) === JSON.stringify(["A 오래전 지시", "B 오래전에 끼워 넣은 말", "C 최근 지시"]),
  "R9 위로 더 불러온 창의 끼워 넣은 말이 그 자리에 한 번 선다", r9);
check(r9.trail && r9.trail.includes("turn:q-b9") && r9.trail.includes("turn:u-a9"),
  "R9 위로 더 불러온 장 머리의 열쇠 = 그 말 줄의 uuid(라이브·얇은 판과 같은 열쇠)", r9.trail);

const r10 = R.r10 || {};
check(r10.says && JSON.stringify(r10.says) === JSON.stringify(["turn:u-a10", "turn:q-b10"]) && (r10.labels || []).some((l) => String(l).includes("B 끼워 넣은 말 R10")),
  "R10 얇은 판 되감기가 끼워 넣은 사람 말을 장 머리로 세운다(열쇠 = 그 줄 uuid) · 사람이 아닌 끼워 넣기는 아니다", r10);

check(!(R.pageErrors || []).length, "페이지 오류 없음", R.pageErrors);
console.log(`\n${pass} passed, ${fail} failed — 일하는 중 보낸 말 화면 · 다시 열기 · 위로 더 · 발자취(#4850)`);
process.exit(fail ? 1 : 0);
