// 세션 = 태스크(#4084) — 순수 규칙. DB 를 타는 흐름(한 번만 만든다·경합·다른 프로젝트 거부·완료·이동 시 해제)은
//  session-task.pg-test.mjs 가 실제 Postgres 로 본다(조건이 전부 SQL 이라 목으로는 조건 하나를 지워도 초록이다).
//
//  엣지 표(행마다 단언 하나):
//   P1 빈 이름·공백 이름 → 태스크를 만들지 않는다(null)
//   P2 세션 이름 → 태스크 이름은 그대로, 본문은 «자동으로 만든»·세션 id 를 말한다
//   P3 200자 넘는 이름 → 200자에서 자른다(task_create_v6 상한)
//   P4 잇는 순간 상태 — 이미 진행 중이면 쓰지 않는다(null), 그 밖(할 일·완료·미러 active·비어 있음)은 진행 중
//   P5 태스크에서 연 세션의 첫 지시 — 본문이 없으면 한 줄(«#id» + 이름)
//   P6 본문이 있으면 «## 태스크 본문» 아래에 싣는다
//   P7 본문이 3000자를 넘으면 자르고 «task_detail_v6» 으로 전문을 보라고 말한다
//   P8 프로젝트 문맥 절 — 태스크가 없으면 빈 문자열, 있으면 번호·이름·상태와 완료 방법(session_task done)
//   P10 이름 다듬기 — 규칙 이름이 달고 오는 앞 목록기호·뒤 말줄임을 뗀다(숫자 목록은 건드리지 않는다)
//   P9 이름 승계 판정 — «그때 우리가 넣은 이름 그대로»일 때만 바꾼다(사람이 손댔으면 물러난다 · 같은 이름이면 쓰지 않는다)
//   W1 배선 — 태스크를 **만드는 자리**가 관문(session-launch)에 있고, 두 입구(중앙·노드)가 모두 그것을 부른다.
//      이 줄이 왜 필요한가: 2026-09-20 이전엔 이 자리가 이름짓기(session_rename)에 있었고, 그건 «AI 가 불러 주면»
//      이라 프로젝트 세션의 절반에만 태스크가 생겼다(실측 6개 중 3개). 호출이 조용히 빠지면 같은 고장이 되돌아온다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sessionTaskSpec, shouldRenameSessionTask, statusOnBind, taskKickoffPrompt, sessionTaskSection, tidyTaskName } from "./session-task.js";

let pass = 0;
const ok = (name: string): void => { pass++; console.log(`ok  ${name}`); };

// P1
assert.equal(sessionTaskSpec("", "box-1"), null);
assert.equal(sessionTaskSpec("   ", "box-1"), null);
ok("P1 빈·공백 이름이면 태스크를 만들지 않는다");

// P2
{
  const s = sessionTaskSpec("  결제 백오프 ", "box-abc");
  assert.ok(s);
  assert.equal(s.name, "결제 백오프");
  assert.match(s.description, /자동으로 만든/);
  assert.match(s.description, /box-abc/);
  ok("P2 세션 이름이 곧 태스크 이름 · 본문이 자동 생성과 세션 id 를 말한다");
}

// P3 — 경계: 200 은 그대로, 201 부터 자른다
{
  assert.equal(sessionTaskSpec("가".repeat(200), "box-1")?.name.length, 200);
  assert.equal(sessionTaskSpec("가".repeat(250), "box-1")?.name.length, 200);
  ok("P3 200자 넘는 이름은 200자에서 자른다(200자는 그대로)");
}

// P4
assert.equal(statusOnBind("in_progress"), null);
for (const st of ["todo", "done", "active", "backlog", "", null, undefined]) assert.equal(statusOnBind(st), "in_progress", String(st));
ok("P4 이미 진행 중이면 쓰지 않고, 그 밖(완료 포함 — 다시 하겠다는 뜻)은 진행 중으로");

// P5
{
  const p = taskKickoffPrompt({ id: 101, name: "환불 버튼", description: null });
  assert.equal(p, "태스크 #101 «환불 버튼» 을(를) 진행해 주세요.");
  assert.equal(taskKickoffPrompt({ id: 101, name: "환불 버튼", description: "   " }), p);
  ok("P5 본문이 없으면 번호·이름 한 줄");
}

// P6
{
  const p = taskKickoffPrompt({ id: 7, name: "영수증 메일", description: "완료 조건: 메일이 발송된다" });
  assert.match(p, /^태스크 #7 «영수증 메일»/);
  assert.match(p, /## 태스크 본문\n\n완료 조건: 메일이 발송된다$/);
  ok("P6 본문이 있으면 «## 태스크 본문» 아래에 싣는다");
}

// P7 — 경계: 3000자는 그대로(자름 표시 없음), 3500자는 3000에서 자른다
{
  const exact = taskKickoffPrompt({ id: 7, name: "딱 맞음", description: "y".repeat(3000) });
  assert.ok(exact.endsWith("y".repeat(3000)));
  assert.doesNotMatch(exact, /task_detail_v6/);
  const p = taskKickoffPrompt({ id: 7, name: "긴 본문", description: "x".repeat(3500) });
  assert.ok(p.includes("x".repeat(3000)));
  assert.ok(!p.includes("x".repeat(3001)));
  assert.match(p, /task_detail_v6/);
  ok("P7 3000자 넘는 본문은 자르고 전문 조회 방법을 말한다(3000자는 그대로)");
}

// P8
{
  assert.equal(sessionTaskSection(null), "");
  const s = sessionTaskSection({ id: 12, name: "세션=태스크 자동화", status: "in_progress", level: "task", project_id: 4084 });
  assert.match(s, /^## 이 세션의 태스크/);
  assert.match(s, /\[#12\] 세션=태스크 자동화 \(in_progress\)/);
  assert.match(s, /session_task \{status:"done"\}/);
  ok("P8 문맥 절 — 없으면 빈 문자열, 있으면 번호·이름·상태 + 완료 방법");
}

// P9 — 이름 승계
{
  assert.equal(shouldRenameSessionTask("사이드바 검색창 제거", "사이드바 검색창 제거", "검색창 제거"), true);
  assert.equal(shouldRenameSessionTask("사람이 고친 이름", "사이드바 검색창 제거", "검색창 제거"), false, "사람이 손댄 태스크는 그대로 둔다");
  assert.equal(shouldRenameSessionTask("검색창 제거", "검색창 제거", "검색창 제거"), false, "같은 이름이면 쓰지 않는다");
  for (const [cur, exp, nx] of [["", "a", "b"], ["a", "", "b"], ["a", "b", ""], [null, null, "b"]] as Array<[string | null, string | null, string]>) {
    assert.equal(shouldRenameSessionTask(cur, exp, nx), false, JSON.stringify([cur, exp, nx]));
  }
  ok("P9 이름 승계는 «직전 이름 그대로인 태스크» 에만 — 빈 값·동일 이름은 쓰지 않는다");
}

// P10 — 이름 다듬기
{
  assert.equal(tidyTaskName("- AI 세션 탭 = 전체 세션 풀스크린 조회"), "AI 세션 탭 = 전체 세션 풀스크린 조회");
  assert.equal(tidyTaskName("우리 옛날에 회의해가지고 UI 개편 되게 많이 얘…"), "우리 옛날에 회의해가지고 UI 개편 되게 많이 얘");
  assert.equal(tidyTaskName("사이드바 검색창 제거..."), "사이드바 검색창 제거");
  assert.equal(tidyTaskName("2. 구현·PR — LVLY_GW_MODE"), "2. 구현·PR — LVLY_GW_MODE", "숫자 목록은 사람이 붙인 이름이다 — 건드리지 않는다");
  assert.equal(tidyTaskName("  · 결제 백오프 "), "결제 백오프");
  assert.equal(tidyTaskName("-"), "-", "기호 하나뿐이면 뗄 것이 없다(빈 이름을 만들지 않는다)");
  assert.equal(sessionTaskSpec("- 사이드바 검색창 제거…", "box-1")?.name, "사이드바 검색창 제거");
  ok("P10 규칙 이름의 앞 목록기호·뒤 말줄임을 뗀다(숫자 목록·기호 단독은 그대로)");
}

// W1 — 배선(소스 대조)
{
  const launch = readFileSync(new URL("../../src/terminal/session-launch.ts", import.meta.url), "utf8");
  const calls = launch.match(/attachLaunchTask\(/g) || [];
  assert.ok(calls.length >= 3, `관문이 태스크를 붙이는 호출이 사라졌다(정의 1 + 두 입구 2 = 3 이상, 지금 ${calls.length})`);
  assert.match(launch, /ensureSessionTask\(\{ sessionId: session\.id, owner, name: label \}\)/, "세션 이름으로 만드는 자리가 없다");
  assert.match(launch, /if \(!isWorkSession\(input\.kind\) \|\| input\.readOnly \|\| input\.incognito\) return;/, "기계 세션·읽기전용·인코그니토 가드가 없다");
  assert.match(launch, /if \(!label \|\| label === session\.id\) return;/, "이름 없는 세션(첫 지시 없음) 가드가 없다");
  const relabel = readFileSync(new URL("../../src/terminal/session-relabel.ts", import.meta.url), "utf8");
  assert.ok(relabel.indexOf("const prevLabel") < relabel.indexOf("claimSessionLabel(id"), "직전 이름을 걸쇠 뒤에 읽으면 승계가 영영 안 된다");
  assert.match(relabel, /renameSessionTaskForLabel\(\{ sessionId: id, owner: me, name: label, expectName: prevLabel \}\)/, "이름 승계 호출이 없다");
  ok("W1 배선 — 관문의 두 입구가 태스크를 붙이고, 이름 승계는 직전 이름을 걸쇠 전에 읽는다");
}

console.log(`\n${pass} passed`);
