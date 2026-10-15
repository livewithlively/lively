// 행 하나의 영구 거절이 push-clickup 크론 전체를 세우지 않는다 — 판정·파킹·경보·배선.
//
//  배경: run-push 는 실패가 하나라도 있으면 exit 1 이고 연속 실패 브레이커(기본 5회)가 크론을 정지시킨다.
//   같은 행이 매 틱 같은 4xx 를 받는 것만으로 조직 전체 반출이 두 번 멈췄다(2026-09-22 404, 2026-10-06 ITEM_137).
//
// 실행: npm run build && node dist/connectors/push-failure.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyPushFailure, isRowRejectMessage, parksAfter, isParkedRow, parkedSql, parkedParams,
  parkedAlert, notifyParked, PARK_AFTER, ROW_REJECT_RE, SYSTEMIC_4XX_RE, type ParkedRow,
  isMassRejection, MASS_REJECT_MIN, MASS_REJECT_MARK,
} from "./push-failure.js";
import { childDrainSummary } from "./sync-outcome.js";

const DRAIN = readFileSync(new URL("./clickup-push.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");

// clickupFetch 가 던지는 모양 그대로(clickup/api.ts: `ClickUp ${status} ${path}: ${text}` · 429 소진 · 네트워크).
const TABLE: Array<[string, unknown, "rejected" | "systemic"]> = [
  ["400 ITEM_137", new Error('ClickUp 400 /list/9/task: {"err":"Parent not child of list","ECODE":"ITEM_137"}'), "rejected"],
  ["404", new Error('ClickUp 404 /task/abc: {"err":"Task not found","ECODE":"ITEM_013"}'), "rejected"],
  ["409", new Error("ClickUp 409 /task/abc: conflict"), "rejected"],
  ["422", new Error("ClickUp 422 /task/abc: unprocessable"), "rejected"],
  ["401 토큰", new Error('ClickUp 401 /task/abc: {"err":"Token invalid"}'), "systemic"],
  ["403 권한", new Error("ClickUp 403 /task/abc: forbidden"), "systemic"],
  ["429 소진", new Error("ClickUp 429 재시도 초과(5회): /task/abc"), "systemic"],
  ["500", new Error("ClickUp 500 /task/abc: oops"), "systemic"],
  ["502 경로에 404", new Error("ClickUp 502 /task/x404y: upstream 400 bad"), "systemic"],
  ["네트워크", new Error("ClickUp 네트워크/타임아웃 실패(재시도 소진) /task/abc: aborted"), "systemic"],
  ["DB", new Error("connection terminated unexpectedly"), "systemic"],
  ["상태셋 로드", new Error("list 9 상태셋 로드 실패 — 치유 좌표는 기록됨, 다음 틱 재시도"), "systemic"],
  ["본문에만 ClickUp 400", new Error("wrapped: ClickUp 400 /x: y"), "systemic"],
  ["Error 아님", "ClickUp 400 /x: y", "systemic"],
  ["null", null, "systemic"],
];

test("표 — 행 고유 거절(4xx 중 401·403·429 제외)과 시스템성을 가른다", () => {
  for (const [label, e, want] of TABLE) assert.equal(classifyPushFailure(e), want, label);
});

test("JS 판정과 SQL 파라미터가 같은 정규식이다 — 갈리면 파킹 SQL 이 다른 행을 뺀다", () => {
  const [, re1, re2] = parkedParams();
  assert.equal(re1, ROW_REJECT_RE);
  assert.equal(re2, SYSTEMIC_4XX_RE);
  for (const [label, e] of TABLE) {
    if (!(e instanceof Error)) continue;
    const sqlLike: boolean = new RegExp(re1).test(e.message) && !new RegExp(re2).test(e.message);
    assert.equal(sqlLike, classifyPushFailure(e) === "rejected", label);
    assert.equal(isRowRejectMessage(e.message), sqlLike, label);
  }
});

test("표 — 파킹은 거절이 PARK_AFTER 번째일 때만", () => {
  assert.equal(PARK_AFTER, 3);
  assert.equal(parksAfter(0, "rejected"), false);
  assert.equal(parksAfter(1, "rejected"), false);
  assert.equal(parksAfter(2, "rejected"), true, "세 번째 거절에서 파킹하지 않는다 — 매 틱 같은 호출이 계속된다");
  assert.equal(parksAfter(7, "rejected"), true);
  assert.equal(parksAfter(9, "systemic"), false, "시스템성 실패를 파킹했다 — 토큰 사망 같은 전역 장애가 큐에서 조용히 빠진다");
});

test("표 — 파킹 술어(JS)", () => {
  const rej = "ClickUp 400 /list/9/task: ITEM_137";
  assert.equal(isParkedRow({ attempts: 3, last_error: rej }), true);
  assert.equal(isParkedRow({ attempts: 2, last_error: rej }), false);
  assert.equal(isParkedRow({ attempts: 9, last_error: "ClickUp 401 /x: Token invalid" }), false);
  assert.equal(isParkedRow({ attempts: 9, last_error: "ClickUp 503 /x: down" }), false);
  assert.equal(isParkedRow({ attempts: 9, last_error: null }), false);
});

test("파킹 SQL — 도출식·NULL 방어·파라미터 순서", () => {
  const s = parkedSql(3);
  assert.match(s, /o\.attempts >= \$3/);
  assert.match(s, /COALESCE\(o\.last_error, ''\) ~ \$4/, "last_error NULL 이면 술어가 NULL 이 되어 NOT(…) 가 정상 행까지 뺀다");
  assert.match(s, /COALESCE\(o\.last_error, ''\) !~ \$5/);
  assert.deepEqual(parkedParams(), [PARK_AFTER, ROW_REJECT_RE, SYSTEMIC_4XX_RE]);
});

test("배선 — 드레인 SELECT 가 파킹 행을 빼고, 파라미터가 $3 부터 실린다", () => {
  assert.match(DRAIN, /AND NOT \$\{parkedSql\(3\)\}[\s\S]{0,80}LIMIT \$1`, \[opts\?\.limit \?\? 200, containerId !== "", \.\.\.parkedParams\(\)\]/,
    "드레인이 파킹 행을 계속 뽑는다 — 같은 거절이 매 틱 반복된다");
  assert.match(DRAIN, /countParked\(\)/, "요약에 parked 수가 안 실린다 — 파킹 행이 어떤 수치에도 안 잡힌다");
});

test("배선 — 시스템성만 failed, 거절은 rejected(exit 판정 밖)", () => {
  const block = DRAIN.match(/\} catch \(e\) \{\n\s*const msg[\s\S]*?\n {4}\}\n {2}\}/);
  assert.ok(block, "행 실패 catch 블록을 못 찾았다");
  const b = block[0];
  assert.match(b, /markErr\(ob\.id, msg\)/, "거절 행의 attempts·last_error 를 안 남긴다 — 파킹 술어가 영영 참이 안 된다");
  assert.match(b, /if \(kind === "systemic"\) \{ failed\+\+;/);
  assert.equal((b.match(/failed\+\+/g) ?? []).length, 1, "거절 경로에서도 failed 를 센다 — 행 하나가 크론을 세운다");
  assert.match(b, /rejected\+\+/);
  assert.match(b, /parksAfter\(ob\.attempts, kind\)/);
});

test("배선 — 경보는 루프 밖에서 실행당 한 번", () => {
  const calls = DRAIN.match(/notifyParked\(/g) ?? [];
  assert.equal(calls.length, 1);
  const loopEnd = DRAIN.indexOf("for (const ob of rows)");
  const at = DRAIN.indexOf("notifyParked(parkedRows, sendBoxAlert)");
  const remainingAt = DRAIN.indexOf("const remaining = await countPending()");
  assert.ok(loopEnd > 0 && at > loopEnd && at < remainingAt, "경보가 루프 밖·요약 전에 있지 않다");
});

test("경보 — 없으면 안 보내고, 있으면 warn 한 번, 발송 실패는 삼킨다", async () => {
  const sent: unknown[] = [];
  const send = async (a: unknown) => { sent.push(a); };
  assert.equal(await notifyParked([], send), false);
  assert.equal(sent.length, 0, "파킹이 없는데 경보를 보냈다");
  const rows: ParkedRow[] = [1, 2, 3].map((i) => ({ outboxId: i, entityId: 100 + i, error: "ClickUp 400 /x: ITEM_137" }));
  assert.equal(await notifyParked(rows, send), true);
  assert.equal(sent.length, 1, "행마다 경보를 보냈다 — 실행당 한 번이어야 한다");
  assert.equal((sent[0] as { severity: string }).severity, "warn");
  assert.match((sent[0] as { title: string }).title, /3건/);
  assert.equal(await notifyParked(rows, async () => { throw new Error("webhook down"); }), false);
  assert.equal(parkedAlert([]), null);
});

test("시뮬레이션 — 같은 행이 매 틱 거절당해도 경보는 파킹 순간 한 번, 그 뒤엔 선택되지 않는다", async () => {
  const row = { id: 1, entity_id: 11, attempts: 0, last_error: null as string | null };
  const err = new Error('ClickUp 400 /list/9/task: {"ECODE":"ITEM_137"}');
  let alerts = 0, tries = 0;
  for (let tick = 0; tick < 6; tick++) {
    const selected = isParkedRow(row) ? [] : [row];
    const parkedRows: ParkedRow[] = [];
    let failed = 0;
    for (const ob of selected) {
      tries++;
      const kind = classifyPushFailure(err);
      const before = ob.attempts;
      ob.attempts++; ob.last_error = err.message;
      if (kind === "systemic") { failed++; continue; }
      if (parksAfter(before, kind)) parkedRows.push({ outboxId: ob.id, entityId: ob.entity_id, error: err.message });
    }
    await notifyParked(parkedRows, async () => { alerts++; });
    assert.equal(failed, 0, `tick ${tick}: 거절을 failed 로 셌다`);
  }
  assert.equal(tries, PARK_AFTER, "파킹 뒤에도 같은 호출을 반복한다");
  assert.equal(alerts, 1, "파킹 경보가 한 번이 아니다");
});

test("요약 — childDrainSummary 가 parked 를 싣고, 없으면 종전 모양 그대로", () => {
  assert.deepEqual(childDrainSummary('{"remaining":5,"budgetStopped":false,"parked":2}'), { remaining: 5, budgetStopped: false, parked: 2 });
  assert.deepEqual(childDrainSummary('{"remaining":5,"budgetStopped":false}'), { remaining: 5, budgetStopped: false });
});


test("표 — 일괄 거절(거절 여럿·반출 0)은 설정 문제로 본다", () => {
  assert.equal(isMassRejection({ rejected: MASS_REJECT_MIN, pushed: 0 }), true, "설정 오류로 전 행이 거절돼도 하나씩 파킹된다 — 설정을 고쳐도 항목마다 재편집해야 풀린다");
  assert.equal(isMassRejection({ rejected: MASS_REJECT_MIN - 1, pushed: 0 }), false, "행 몇 건의 진짜 거절에도 크론이 선다");
  assert.equal(isMassRejection({ rejected: 50, pushed: 1 }), false, "반출이 된 실행을 설정 문제로 본다");
});

test("일괄 거절 표식이 붙은 last_error 는 파킹 술어에서 빠진다 — 설정을 고치면 다음 틱에 다시 반출된다", () => {
  const msg = MASS_REJECT_MARK + 'ClickUp 404 /list/9/task: {"err":"List not found"}';
  assert.equal(isRowRejectMessage(msg), false, "표식이 붙어도 행 거절로 읽혀 파킹된다");
  assert.equal(isParkedRow({ attempts: 9, last_error: msg }), false);
});

test("배선 — 일괄 거절이면 표식을 붙이고 실패로 올리며 파킹 경보를 내지 않는다", () => {
  assert.match(DRAIN, /if \(isMassRejection\(\{ rejected, pushed \}\)\) \{[\s\S]{0,700}failed \+= rejected; rejected = 0; parkedRows = \[\];/,
    "일괄 거절을 실패로 안 올려 브레이커가 안 돈다");
  assert.match(DRAIN, /SET last_error = \$2 \|\| COALESCE\(last_error, ''\) WHERE id = ANY\(\$1::bigint\[\]\)/, "표식을 안 붙여 다음 틱에 파킹된다");
  assert.ok(DRAIN.indexOf("isMassRejection({ rejected, pushed })") < DRAIN.indexOf("await notifyParked(parkedRows"), "파킹 경보가 일괄 판정보다 먼저 나간다");
});

// 부모 detach 뒤 아직 안 올라간 자식은 기다리지 않고 닫힌다(아래 시험) — 로그가 «자식은 부모가 다시 생긴 뒤» 라고 하면
//  운영자는 자식이 저절로 올라갈 줄 알고 기다린다. 갱신 경로 detach 문구가 실제 동작을 말하는지 잠근다.
test("문구 — 갱신 경로 detach 로그가 자식 반출이 닫힌다고 말한다", () => {
  const i = DRAIN.indexOf('if (r === "detached") {');
  assert.ok(i > 0, "갱신 경로 detach 분기를 못 찾았다");
  const block = DRAIN.slice(i, DRAIN.indexOf("detached++; continue;", i));
  assert.ok(!/자식은 부모가 다시 생긴 뒤/.test(block), "detach 로그가 자식이 저절로 올라간다고 한다 — 실제로는 자식 반출이 닫힌다");
  assert.match(block, /자식의 반출은 닫힌다/, "detach 로그가 자식 반출이 닫힌다는 사실을 말하지 않는다");
});

// 부모가 반출 대기도 아니고 ClickUp 에도 없으면 자식을 닫는다 — 기다리게 두면 영영 deferred 로 남는다.
test("부모가 반출 대상이 아니면 자식은 기다리지 않고 닫힌다", () => {
  const i = DRAIN.indexOf('par.external_system !== "clickup" || !par.external_id');
  assert.ok(i > 0, "부모 미푸시 분기를 못 찾았다");
  const block = DRAIN.slice(i, i + 2000);
  assert.match(block, /FROM external_outbox WHERE system='clickup' AND entity_id=\$1 AND done_at IS NULL/, "부모가 큐에 있는지 안 본다");
  assert.match(block, /if \(parentQueued\) \{ deferred\+\+; continue; \}/, "부모가 큐에 있을 때만 기다려야 한다");
  assert.match(block, /await markDone\(ob\.id\); skipped\+\+; continue;/, "부모가 반출 대상이 아니면 자식을 닫아야 한다");
  //  묻는 행이 **부모**여야 한다 — 자식 자신(p.id)을 물으면 자기 행은 언제나 pending 이라 영원히 기다린다
  //   (이 분기가 없던 때로 조용히 돌아간다). 문자열 SQL 만 보면 인자를 바꿔도 초록이라 인자까지 잠근다.
  assert.match(block, /AND done_at IS NULL LIMIT 1`, \[par\.id\]\)/, "부모가 아닌 행의 큐를 묻는다 — 자식 자신을 물으면 영원히 defer 다");
  //  par.id 는 조상 조회가 id 를 실어야 값이 있다 — 빠지면 undefined 로 물어 «큐에 없음» 이 되고 자식이 늘 닫힌다.
  assert.match(DRAIN, /SELECT d, id, external_id, external_system, list_ext FROM anc ORDER BY d/, "조상 조회가 id 를 안 싣는다 — 부모 큐를 못 찾아 자식이 늘 닫힌다");
});

// 런북의 파킹 조회·해제 SQL 이 parkedParams() 와 같은 조건인가 — 갈리면 사람이 런북대로 풀었는데 파킹이 안 풀리거나
//  (임계·정규식이 다르면) 파킹 안 된 행까지 건드린다. 런북엔 «같아야 한다» 는 문장뿐이라 두 언어 런북을 읽어 대조한다.
test("런북 — 두 언어 런북의 파킹 SQL 조건이 parkedParams() 와 같다", () => {
  const [after, rowRe, sysRe] = parkedParams();
  for (const name of ["clickup-sync.md", "clickup-sync.ko.md"]) {
    const md = readFileSync(new URL(`../../runbooks/${name}`, import.meta.url), "utf8");
    //  파킹 술어(last_error ~)를 쓰는 인라인 SQL 만 — 런북의 다른 external_outbox 조회(pending 전체 보기)는 대상이 아니다.
    const sqls = [...md.matchAll(/`((?:UPDATE|SELECT)\b[^`]*external_outbox[^`]*last_error ~[^`]*)`/g)].map((m) => m[1]);
    assert.ok(sqls.length >= 2, `${name}: 파킹 해제·조회 SQL 을 못 찾았다(${sqls.length}건) — 런북 문구가 바뀌었으면 이 시험도 맞춘다`);
    for (const sql of sqls) {
      assert.match(sql, /system='clickup' AND done_at IS NULL/, `${name}: 다른 시스템·이미 끝난 행까지 건드린다 — ${sql}`);
      assert.equal(sql.match(/attempts>=(\d+)/)?.[1], String(after), `${name}: 임계가 PARK_AFTER 와 다르다 — ${sql}`);
      assert.equal(sql.match(/last_error ~ '([^']+)'/)?.[1], rowRe, `${name}: 행 거절 정규식이 ROW_REJECT_RE 와 다르다 — ${sql}`);
      assert.equal(sql.match(/last_error !~ '([^']+)'/)?.[1], sysRe, `${name}: 시스템성 4xx 정규식이 SYSTEMIC_4XX_RE 와 다르다 — ${sql}`);
    }
  }
});
