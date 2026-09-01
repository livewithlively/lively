// 작업 도크(#2439 ③) — **화면이 무엇을 접고 무엇을 남기는가**를 값으로 지킨다.
//
//  ⚠ 왜 화면 로직에 테스트가 필요한가: 서버는 끝난 작업을 **안 지운다**(스냅샷 머지 — 지우면 방금 끝난
//   것의 제목·종류를 잃고 뒤이은 델타가 유령 행을 만든다, 2026-08-31 실측). 그래서 «언제 접나» 가
//   화면 몫이 됐고, 그 규칙이 틀리면 목록이 무한히 자라거나 결과를 볼 틈 없이 사라진다.
//  그리고 배선도 함께 본다 — 규칙이 맞아도 **안 부르면** 화면은 그대로다(sess-face.test.mjs 와 같은 규율).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

const { DONE_LINGER_MS, dockHead, elapsed, visibleTasks } = await import(join(root, "public/app/session-tasks-view.js"));

const NOW = 1_000_000;
const task = (o) => ({ id: "t", kind: "shell", title: "작업", status: "running", ...o });

// ── 무엇을 보여주나 ──────────────────────────────────────────────────────────────
{
  ok(visibleTasks([task({ status: "running" })], NOW).length === 1, "① 도는 작업은 보인다");
  ok(visibleTasks([task({ status: "completed", endedAt: NOW - 1000 })], NOW).length === 1,
    "② 방금 끝난 작업은 남는다 — 결과를 볼 틈을 준다");
  ok(visibleTasks([task({ status: "completed", endedAt: NOW - DONE_LINGER_MS - 1 })], NOW).length === 0,
    "③ 오래 전에 끝난 작업은 접는다 — 서버가 안 지우므로 여기서 접지 않으면 무한히 자란다");
  ok(visibleTasks([task({ status: "completed" })], NOW).length === 1,
    "④ 끝났다는데 시각이 없으면 남긴다(모른다고 지우지 않는다)");
  //  ★ 오래 걸리는 작업을 «오래됐다» 고 접으면 안 된다 — 판정은 **끝난 시각**이지 시작 시각이 아니다.
  ok(visibleTasks([task({ status: "running", startedAt: NOW - 3_600_000 })], NOW).length === 1,
    "⑤ 한 시간째 도는 작업도 보인다(판정은 끝난 시각으로 한다)");
}

// ── 머리줄 ──────────────────────────────────────────────────────────────────────
{
  ok(dockHead([task({ status: "running" }), task({ status: "running" })]) === "작업 2개 도는 중", "⑥ 도는 개수를 센다");
  ok(dockHead([task({ status: "completed", endedAt: NOW })]) === "방금 끝난 작업", "⑦ 끝난 것만 남으면 그렇게 말한다");
  ok(dockHead([task({ status: "running" }), task({ status: "completed" })]) === "작업 1개 도는 중",
    "⑧ 섞여 있으면 **도는 것**을 센다(끝난 것을 세면 사람이 진행 중으로 오해한다)");
}

// ── 경과 시간 ───────────────────────────────────────────────────────────────────
{
  ok(elapsed(task({ startedAt: NOW - 5000 }), NOW) === "5초", "⑨ 초");
  ok(elapsed(task({ startedAt: NOW - 125_000 }), NOW) === "2분 5초", "⑩ 분+초");
  ok(elapsed(task({ startedAt: NOW - 3_725_000 }), NOW) === "1시간 2분", "⑪ 시간+분");
  ok(elapsed(task({ startedAt: NOW - 10_000, endedAt: NOW - 4000 }), NOW) === "6초",
    "⑫ 끝난 작업은 **걸린 시간**이지 지금까지가 아니다");
  ok(elapsed(task({}), NOW) === "", "⑬ 시작 시각을 모르면 아무 말도 안 한다(0초라고 거짓말하지 않는다)");
}

// ── 배선 — 규칙이 맞아도 안 부르면 화면은 그대로다 ────────────────────────────────
{
  const chat = read("web/session-chat.ts");
  ok(/function ensureTasksDock\(\)/.test(chat), "⑭ 도크를 붙이는 자리가 있다");
  ok(/runtimeMode.*!==\s*'chat'.*return|!==\s*'chat'\)\s*return/.test(chat),
    "⑮ chat 런타임 세션에서만 연다 — 올 것이 없는 SSE 를 세션마다 열지 않는다");
  //  두 자리가 얼마나 떨어져 있든 상관없다 — **부르는 자리가 둘 이상**인지만 본다(정의 1 + 호출 2).
  ok((chat.match(/ensureTasksDock\(\)/g) || []).length >= 3,
    "⑯ 열 때와 갱신 때 **둘 다** 두드린다(방금 만든 세션은 행이 얇아 runtimeMode 를 모른다)");
  ok(/tasksDock\?\.destroy\(\)/.test(chat), "⑰ 화면이 닫히면 스트림도 닫는다");
  const dock = read("web/session-tasks.ts");
  ok(/tasks\.snapshot/.test(dock) && !/task\.updated/.test(dock),
    "⑱ 화면은 **스냅샷만** 본다 — 접기를 다시 하지 않는다(두 벌이면 갈린다)");
  ok(/SILENCE_MS/.test(dock), "⑲ 말 없는 연결을 살아 있다고 착각하지 않는다(하트비트 침묵 감시)");
}

console.log(`\n${pass}건 통과`);
