#!/usr/bin/env node
// 위로 올리면 긴 턴의 내용이 사라지던 것 (#5809, 런타임).
//
//  신고(상민님 2026-11-26): «세션 끝나고 하네스 종료한 세션을 웹 화면으로 보면 이전 내역이 안 보인다. 마지막 대화 몇 개만 보인다 —
//   처음에 딱 들어갔을 땐 이전 것이 보이다가 스크롤을 올리다 보면 맨 마지막 것만 남고 사라진다».
//  원인: 대화창은 기록을 창(1.5MB) 단위로 꼬리부터 읽고, 위 창을 붙일 때 화면 맨 위의 «사람 말 없는 이어짐» 턴을 지우고 그 턴에 적어 둔
//   줄 목록(evs)으로 새 턴에 다시 그린다. 그런데 위 창을 붙이며 만든 턴은 그 목록을 채우지 않았다 — 한 턴이 창 셋 이상에 걸치면
//   둘째로 붙일 때부터 «지우고 빈 목록으로 다시 그리기» 가 되어, 그 턴에는 마지막에 붙인(가장 오래된) 창의 내용만 남았다.
//
//  엣지 표(행마다 단언 하나):
//   L1-0 전제 — 기록이 창 셋보다 길다(한 턴이 꼬리 창 + 위 창 셋에 걸친다)
//   L1-2 위로 끝까지 올린 뒤 — 사람 말이 머리로 서고, 머리·가운데 둘·끝 답이 모두 그 턴에 있다
//   L1-3 위로 끝까지 올린 뒤 — 네 창의 도구 호출이 모두 그 턴에 있다
//   L1-4 위로 끝까지 올린 뒤 — 글·도구 호출이 저마다 한 번씩만 있고(겹쳐 그리지 않는다) 기록 순서대로 선다
//   L1-5 위로 끝까지 올린 화면 = 같은 대화 줄을 한 번에 연 화면(턴 끝 줄 · 완료 알림 턴까지 같다)
//   L1-6 도는 동안 끼워 넣은 완료 알림(턴 안의 알림 줄)도 합친 턴에 남는다
//
//  장면·가짜 서버는 queued-say-harness.mjs(묶음 "longturn"). 세션 화면은 실제 모듈을 싣는다.
//  fail-first: `SRC_ROOT=<옛 트리>`(web/ · public/styles 가 있는 곳)로 옛 코드를 물린다. 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import path from "node:path";
import { findChrome } from "./headless-chrome.mjs";
import { runQueuedSayScenes } from "./queued-say-harness.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 긴 턴 위로 더 런타임 검증 미실행"); process.exit(0); }
const R = await runQueuedSayScenes(chrome, "longturn", ROOT);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${JSON.stringify(got)}`); } };
if (R.fatal || R.err) { fail++; console.error(`FAIL  페이지가 던졌다: ${String(R.fatal || R.err).split("\n").slice(0, 3).join(" | ")}`); }
if (R.pageErrors && R.pageErrors.length) { fail++; console.error(`FAIL  페이지 오류: ${R.pageErrors.slice(0, 3).join(" | ")}`); }

const A = "A 긴 지시 L1";
const TEXTS = ["머리 창 글 L1-H", "가운데 창 글 L1-M1", "가운데 창 글 L1-M2", "끝 답 L1-T"];
const CMDS = ["echo head-cmd-L1", "echo mid1-cmd-L1", "echo mid2-cmd-L1", "echo tail-cmd-L1"];
const l1 = R.l1 || {};
const full = l1.full || {}, whole = l1.whole || {};
const inA = (snap, m) => !!(snap.where && snap.where[m] && snap.where[m].ask === A);

check(l1.size > 3 * 1_500_000 && full.older === false, "L1-0 전제 — 기록이 창 셋보다 길고, 머리까지 다 불러왔다(위 표지가 걷혔다)", { size: l1.size, older: full.older });
check((full.asks || [])[0] === A && TEXTS.every((m) => inA(full, m)),
  "L1-2 위로 끝까지 올린 뒤 — 머리·가운데 둘·끝 답이 모두 그 턴에 있다", { asks: full.asks, where: full.where });
check(CMDS.every((m) => inA(full, m)),
  "L1-3 위로 끝까지 올린 뒤 — 네 창의 도구 호출이 모두 그 턴에 있다", full.where);
check(full.count && [...TEXTS, ...CMDS, "알림 뒤 글 L1-N"].every((m) => full.count[m] === whole.count?.[m] && full.count[m] >= 1)
  && full.pos && full.pos.every((p, i) => p >= 0 && (i === 0 || p > full.pos[i - 1])),
  "L1-4 위로 끝까지 올린 뒤 — 글·도구 호출이 한 번에 연 화면과 같은 횟수로, 기록 순서대로 선다", { count: full.count, whole: whole.count, pos: full.pos });
check(full.sig && whole.sig && JSON.stringify(full.sig) === JSON.stringify(whole.sig),
  "L1-5 위로 끝까지 올린 화면 = 같은 대화 줄을 한 번에 연 화면", { full: full.sig, whole: whole.sig });
check(whole.notices === 2 && full.notices === 2,
  "L1-6 도는 동안 끼워 넣은 완료 알림도 합친 턴에 남는다(알림 줄 둘 — 턴 안의 것 · 턴을 연 것)", { full: full.notices, whole: whole.notices });

console.log(`\n${pass} passed, ${fail} failed — 긴 턴 위로 더(#5809)`);
process.exit(fail ? 1 : 0);
