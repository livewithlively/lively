#!/usr/bin/env node
// 일하는 중에 보낸 말이 다시 열면 대화창에서 사라지던 것 (#4850, 런타임) — 라이브 보내기.
//
//  신고 맥락(상민님 2026-10-16, 프로젝트 #4850): 하네스(Claude Code)가 일하는 동안 대화창에서 보낸 말은 기록에 사람 말 줄(type:user)이
//   아니라 끼워 넣기 줄(attachment · queued_command)로만 남는다. 대화창은 그 줄 가운데 작업 끝 알림만 그려, 세션을 다시 열면 그 말이
//   대화에서 사라졌다 — AI 의 답은 그 말을 받아 이어지는데 사람이 한 말이 화면에 없다.
//  터미널(Claude Code 2.1.301 tmux 실측)은 그 줄을 첫 지시와 똑같은 `❯ 말` 로 파일의 그 자리(도구 결과 다음 · 답 앞)에 그린다 — 라이브도,
//   다시 열기(--resume)도. 대기 중(아직 안 끼워 넣음)엔 맨 아래에 두고 하던 일의 출력은 그 위로 쌓는다.
//
//  엣지 표(행마다 장면 하나 — 지식 queued-say-chat-render-4850 §사양 의 R 행):
//   R5 라이브 · A 가 도는 중 대화창에서 B 를 보냄 → B 는 맨 아래 · 그 뒤 도착한 A 의 출력은 B 위(A 턴) · 하네스에 넣어지면 상태 줄이 «다음 틈»
//      → B 의 끼워 넣기 줄 → 말풍선이 그 줄에 이어진다(한 번 · 상태 줄 걷힘) · 이후 답은 B 아래 · 최종 화면 = 같은 기록을 새로 연 화면
//   R6 라이브 · A 가 도는 중 B 를 보냄 → A 턴이 먼저 끝나고 B 는 사람 말 줄로 들어감 → 최종 화면 = 새로 연 화면(A 의 끝 줄은 A 턴)
//   R7 라이브 · 쉬는 중 B 를 보냄 → 곧장 지금 턴(도는 표시가 B 턴에 — 종전 그대로)
//   R8 라이브 · A 도는 중 B1 · B2 를 보냄 → 둘 다 맨 아래(보낸 순서) → 같은 틈에 둘 다 끼워 넣어짐 → B1 < B2 < 답 · = 새로 연 화면
//   R11 A 가 도는 중 B 의 보내기가 실패(POST 500) → A 의 도는 표시·«작업 중» 상태는 그대로 · B 엔 실패를 남긴다
//   R12 B 가 붙들린 동안 A 턴이 끝나고 작업 끝 알림이 새 턴을 연다 → 그 턴은 B 위 · B 가 들어가면 알림 턴 다음 · = 새로 연 화면
//   R13 B1 · B2 를 보냄 → B1 은 전달 실패 · B2 가 먼저 들어감 → B2 는 B1 위로 · B1 은 맨 아래에 실패로 남는다 · = 새로 연 화면
//   R14 도는 중 보낸 말이 전달 안 됨 → [다시 보내기] 를 눌러도 하던 턴의 도는 표시를 뺏지 않는다
//   R15 쉬는 중 보낸 말(지금 턴)이 전달 안 됨 → [지우기] → 그 뒤 온 답은 지운 턴이 아니라 화면에 선다
//   R16 쉬는 중 슬래시 명령(`/compact`)을 보냄 → 기록에 사람 말로 안 남는다 → 붙들지 않는다: 보낸 자리에 남고 압축 구분선·답은 그 아래
//
//  장면·가짜 서버는 queued-say-harness.mjs 한 벌(두 시험 파일이 묶음 하나씩 돌린다). 세션 화면은 실제 모듈을 싣는다.
//  fail-first: `SRC_ROOT=<옛 트리>`(web/ · public/styles 가 있는 곳)로 옛 코드를 물린다. 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import path from "node:path";
import { findChrome } from "./headless-chrome.mjs";
import { runQueuedSayScenes } from "./queued-say-harness.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 라이브 보내기 런타임 검증 미실행"); process.exit(0); }
const R = await runQueuedSayScenes(chrome, "live", ROOT);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${JSON.stringify(got)}`); } };
if (R.fatal || R.err) { fail++; console.error(`FAIL  페이지가 던졌다: ${String(R.fatal || R.err).split("\n").slice(0, 3).join(" | ")}`); }

const r5 = R.r5 || {};
check(r5.sent && r5.sent.last === "B 도는 중에 보낸 말" && r5.sent.spin === "A 도는 지시",
  "R5 전제 — 도는 중에 보낸 말은 맨 아래에 서고, 도는 표시는 하던 턴(A)에 남는다", r5.sent);
check(r5.waiting && r5.waiting.last === "B 도는 중에 보낸 말" && r5.waiting.mid && r5.waiting.mid.ask === "A 도는 지시",
  "R5 그 뒤 도착한 하던 일의 출력은 내 말 위(A 턴)에 쌓이고 내 말은 맨 아래에 머문다", r5.waiting);
check(r5.waiting && r5.waiting.state === "전달했어요 — 하던 작업의 다음 틈에 들어갑니다",
  "R5 하네스에 넣어졌는데 아직 안 끼워 넣어졌다 → 상태 줄이 «다음 틈» 을 말한다", r5.waiting && r5.waiting.state);
check(r5.after && r5.after.b === 1 && r5.after.state === null && r5.after.res && r5.after.res.ask === "A 도는 지시" && r5.after.ans && r5.after.ans.ask === "B 도는 중에 보낸 말",
  "R5 끼워 넣기 줄이 오면 말풍선이 그 줄에 이어진다 — 한 번 · 상태 줄 걷힘 · 도구 결과는 A 턴 · 답은 B 턴", r5.after);
check(r5.after && r5.fresh && JSON.stringify(r5.after.sig) === JSON.stringify(r5.fresh.sig),
  "R5 라이브로 쌓인 화면 = 같은 기록을 새로 연 화면", { live: r5.after && r5.after.sig, fresh: r5.fresh && r5.fresh.sig });
check(r5.after && r5.after.trail && r5.after.trail.includes("turn:q-b5"), "R5 라이브 발자취에도 그 말이 장 머리로 선다", r5.after && r5.after.trail);

const r6 = R.r6 || {};
check(r6.mid && r6.mid.last === "B 턴 끝에 들어갈 말" && r6.mid.fin && r6.mid.fin.ask === "A 마무리 지시",
  "R6 하던 턴이 먼저 끝난다 — 그 끝 출력은 A 턴, 기다리는 말은 맨 아래", r6.mid);
check(r6.after && r6.after.b === 1 && r6.after.ans && r6.after.ans.ask === "B 턴 끝에 들어갈 말" && r6.fresh && JSON.stringify(r6.after.sig) === JSON.stringify(r6.fresh.sig),
  "R6 사람 말 줄로 들어가면 그 자리에 이어진다(한 번) · 라이브 화면 = 새로 연 화면", { after: r6.after, fresh: r6.fresh });

const r7 = R.r7 || {};
check(r7.last === "B 쉬는 중에 보낸 말" && r7.spin === "B 쉬는 중에 보낸 말",
  "R7 쉬는 중에 보낸 말은 곧장 지금 턴 — 도는 표시가 그 말 아래(종전 그대로)", r7);

const r8 = R.r8 || {};
check(r8.waiting && JSON.stringify(r8.waiting.asks) === JSON.stringify(["A 긴 지시", "B1 첫째 말", "B2 둘째 말"]) && r8.waiting.mid && r8.waiting.mid.ask === "A 긴 지시",
  "R8 도는 중에 둘을 보내면 둘 다 맨 아래(보낸 순서) · 하던 일의 출력은 그 위", r8.waiting);
check(r8.after && r8.after.b1 === 1 && r8.after.b2 === 1 && r8.after.ans && r8.after.ans.ask === "B2 둘째 말" && r8.fresh && JSON.stringify(r8.after.sig) === JSON.stringify(r8.fresh.sig),
  "R8 같은 틈에 둘 다 끼워 넣어지면 B1 < B2 < 답 · 라이브 화면 = 새로 연 화면", { after: r8.after, fresh: r8.fresh });

const r11 = R.r11 || {};
check(r11.before === "A 도는 지시 R11" && r11.spin === "A 도는 지시 R11" && r11.busyBefore === true && r11.busy === true && r11.failText,
  "R11 도는 중 보내기가 실패해도 하던 턴의 도는 표시·«작업 중» 상태(멈춤 단추)는 그대로 · 그 말엔 실패를 남긴다", r11);

const r12 = R.r12 || {};
check(r12.mid && r12.mid.last === "B 알림 뒤에 들어갈 말" && r12.mid.note && r12.mid.note.ask === null && r12.mid.note.i < r12.mid.bIdx && r12.mid.fin && r12.mid.fin.ask === "A 지시 R12",
  "R12 붙들린 말풍선이 있는 동안 새로 선 턴(작업 끝 알림)은 그 위에 선다 — 내 말은 맨 아래에 머문다", r12.mid);
check(r12.after && r12.after.b === 1 && r12.after.ans && r12.after.ans.ask === "B 알림 뒤에 들어갈 말" && r12.fresh && JSON.stringify(r12.after.sig) === JSON.stringify(r12.fresh.sig),
  "R12 그 뒤 내 말이 들어가면 알림 턴 다음 자리 · 라이브 화면 = 새로 연 화면", { after: r12.after, fresh: r12.fresh });

const r13 = R.r13 || {};
check(r13.asks && JSON.stringify(r13.asks) === JSON.stringify(["A 지시 R13", "B2 들어간 말 R13", "B1 못 들어간 말 R13"]) && r13.ans && r13.ans.ask === "B2 들어간 말 R13" && /전달 안 됨/.test(String(r13.failed || "")),
  "R13 나중에 보낸 말이 먼저 들어가면 그 말은 아직 붙들린 앞 말 위로 간다 — 못 들어간 말은 맨 아래에 실패로 남는다", r13);
check(r13.fresh && JSON.stringify(r13.sig) === JSON.stringify(r13.fresh.sig), "R13 라이브 화면 = 새로 연 화면", { live: r13.sig, fresh: r13.fresh && r13.fresh.sig });

const r14 = R.r14 || {};
check(r14.before && r14.before.spin === "A 지시 R14" && /전달 안 됨/.test(String(r14.before.state || "")), "R14 전제 — 도는 중 보낸 말이 전달 안 됨 · 도는 표시는 A", r14.before);
check(r14.clicked && JSON.stringify(r14.acts) === JSON.stringify(["retry"]) && r14.spin === "A 지시 R14",
  "R14 [다시 보내기] 를 눌러도 하던 턴(A)의 도는 표시를 뺏지 않는다", r14);

const r15 = R.r15 || {};
check(r15.clicked && JSON.stringify(r15.acts) === JSON.stringify(["discard"]) && JSON.stringify(r15.asks) === JSON.stringify(["A 끝난 지시 R15"]) && r15.orphan,
  "R15 지금 턴이던 말풍선을 [지우기] 한 뒤에 온 답은 지운 턴이 아니라 화면에 선다", r15);

const r16 = R.r16 || {};
check(r16.order && r16.order.indexOf("/compact") >= 0 && r16.order.indexOf("/compact") < r16.order.indexOf("divider") && r16.after && r16.after.ask === null,
  "R16 슬래시 명령(기록에 사람 말로 안 남는다)은 붙들지 않는다 — 보낸 자리에 남고 그 뒤의 압축 구분선·답은 그 아래", r16);

check(!(R.pageErrors || []).length, "페이지 오류 없음", R.pageErrors);
console.log(`\n${pass} passed, ${fail} failed — 일하는 중 보낸 말 화면 · 라이브 보내기(#4850)`);
process.exit(fail ? 1 : 0);
