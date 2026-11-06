// org_distiller_requeue — 고른 «성공한» 배치의 판정 기록만 지우고, 그 자료가 레인 잔량으로 실제로 돌아오는가.
//  실제 Postgres 필요(기본 유닛 체인 밖). CI 의 pg-test 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=... node src/org/distill/requeue-seen.pg-test.mjs
//
//  왜 이 계층인가: 유닛(requeue-seen.test.ts)은 org_task 고르기 SQL 을 평가하지 못한다(페이크가 WHERE 를 안 본다).
//   삭제 대상을 고르는 술어(status·의뢰자·기간·레인 key)와 지식 보호 배제절이 실제 DB 에서 맞는지, 그리고 지운 뒤
//   인박스 술어가 그 자료를 다시 집는지는 실 DB 로만 보인다.
//
//  사양 엣지 표(행마다 단언):
//   R1 dry_run — 의뢰자+기간으로 고르면 done 배치만 대상이고(running 제외), 지식 없는 기록만 세며, 아무것도 지우지 않는다
//   R2 실행 — 대상 배치의 레인·방치 기록만 지운다. 지식 연결 자료·다른 의뢰자 배치·진행 중 배치의 기록은 남는다
//   R3 재등장 — 지운 자료가 레인 잔량(countDistillerBacklog)에 다시 잡힌다
//   R4 레인 key 정확 일치 — key 의 `_` 가 다른 레인(`X` 자리)의 배치를 고르지 않는다
//   R5 기간 — since 이전·until 이후에 접수된 배치는 고르지 않는다
//   R6 재판정 — 뒤 배치가 같은 자료를 다시 판정했으면 옛 배치를 되돌려도 그 판정은 남는다
import assert from "node:assert/strict";
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
await (await import(`${DIST}/boot/schemas.js`)).initAllSchemas();
const { requeueDistillerSeen, getDistiller, listDistillers, countDistillerBacklog, markDistillerSeen } = await import(`${DIST}/org/distill/distiller.js`);
const { upsertDistiller } = await import(`${DIST}/org/store.js`);

let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const q = async (sql, v = []) => (await itemsPool.query(sql, v)).rows;

const KIND = "rqpg-test";
const LANE = "rq_pg-lane";             // `_` 가 들어간 레인 key — LIKE 였다면 `rqXpg-lane` 도 고른다
const KNAME = "rq-pg-test-knowledge";
const ME = "rq-pg-req";

// ── 준비 ──
await q(`DELETE FROM org_task WHERE requester IN ($1,'rq-pg-other')`, [ME]);
await q(`DELETE FROM source WHERE kind=$1`, [KIND]);
await q(`DELETE FROM knowledge WHERE name=$1`, [KNAME]);
await upsertDistiller({ key: LANE, enabled: true, priority: 100000, match_kinds: [KIND], exclude_bots: false, min_chars: 0, prefilter_level: 0, thread_aware: false, lookback_days: null }, "rq-pg-test", "test");
const lane = await getDistiller(LANE);
await q(`DELETE FROM org_distiller_seen WHERE distiller_id=$1`, [lane.id]);   // 앞 실행이 중간에 죽어 남긴 기록
const src = [];
for (let i = 1; i <= 6; i++) {
  const [r] = await q(`INSERT INTO source(kind, title, body_md, occurred_at) VALUES ($1, $2, $3, now() - interval '3 hours') RETURNING id`, [KIND, `rq-pg ${i}`, `본문 ${i} — 증류 대상이 될 만큼 충분히 긴 내용이다.`]);
  src.push(Number(r.id));
}
const [S1, S2, S3, S4, S5, S6] = src;
const task = async (requester, status, session) => Number((await q(
  `INSERT INTO org_task(requester, requester_session, prompt, status, created_at) VALUES ($1,$2,'p',$3, now() - interval '1 hour') RETURNING id`,
  [requester, session, status]))[0].id);
const T1 = await task(ME, "done", `cron:distill-sources-headless#${LANE}`);        // 도구 없이 done 으로 끝난 배치
const T2 = await task("rq-pg-other", "done", `cron:distill-sources-headless#${LANE}`); // 다른 의뢰자
const T3 = await task(ME, "running", `cron:distill-sources-headless#${LANE}`);     // 아직 도는 배치
const T5 = await task(ME, "done", `cron:distill-sources-headless#rqXpg-lane`);      // 다른 레인(LIKE 였다면 섞인다)
const seen = async (s, t) => q(`INSERT INTO org_distiller_seen(distiller_id, source_id, task_id) VALUES ($1,$2,$3)`, [lane.id, s, t]);
await seen(S1, T1); await seen(S2, T1); await seen(S3, T2); await seen(S4, T3); await seen(S5, T5);
await q(`INSERT INTO org_stranded_seen(source_id, task_id) VALUES ($1,$2)`, [S6, T1]);   // S6 은 새 자료라 충돌 없음
await q(`INSERT INTO knowledge(name, title, body_md) VALUES ($1,'rq pg','b')`, [KNAME]);
await q(`INSERT INTO knowledge_source(name, source_id) VALUES ($1,$2)`, [KNAME, S2]);   // S2 는 지식이 이미 나왔다

const laneSeen = async () => (await q(`SELECT source_id FROM org_distiller_seen WHERE distiller_id=$1 ORDER BY source_id`, [lane.id])).map((r) => Number(r.source_id));
const strandedHas = async (s) => (await q(`SELECT 1 FROM org_stranded_seen WHERE source_id=$1`, [s])).length > 0;
const sel = { requester: ME, since: new Date(Date.now() - 2 * 3600e3).toISOString() };
const backlogBefore = await countDistillerBacklog(lane, await listDistillers(true));

// R1
{
  const r = await requeueDistillerSeen(sel, true);
  assert.equal(r.tasks, 2, "R1 done 배치(T1·T5)만 대상이어야 한다 — running(T3)·다른 의뢰자(T2) 제외");
  assert.deepEqual(r.by_task, [{ task_id: T1, requeued: 2 }, { task_id: T5, requeued: 1 }], "R1 T1 은 S1(레인)+S6(방치), T5 는 S5 — S2 는 지식이 있어 빠진다");
  assert.equal(r.kept_with_knowledge, 1, "R1 지식 연결 자료는 S2 하나");
  assert.deepEqual(await laneSeen(), [S1, S2, S3, S4, S5].sort((a, b) => a - b), "R1 dry_run 이 지웠다");
  assert.ok(await strandedHas(S6), "R1 dry_run 이 방치 기록을 지웠다");
  ok("R1 dry_run — done 배치만, 지식 없는 기록만 세고 지우지 않는다");
}
// R4 — 레인 key 정확 일치(T5 는 다른 레인)
{
  const r = await requeueDistillerSeen({ ...sel, distillerKey: LANE }, true);
  assert.deepEqual(r.by_task.map((x) => x.task_id), [T1], "R4 레인 key 의 `_` 가 rqXpg-lane 배치까지 골랐다");
  ok("R4 레인 key 정확 일치 — `_` 가 다른 레인을 고르지 않는다");
}
// R2
{
  const r = await requeueDistillerSeen({ ...sel, distillerKey: LANE }, false);
  assert.equal(r.requeued, 2, "R2 T1 의 S1·S6 두 기록");
  assert.deepEqual(await laneSeen(), [S2, S3, S4, S5].sort((a, b) => a - b), "R2 지워야 할 S1 만 사라지고 나머지(S2 지식·S3 다른 의뢰자·S4 진행 중·S5 다른 레인)는 남아야 한다");
  assert.ok(!(await strandedHas(S6)), "R2 방치 기록 S6 이 남았다");
  ok("R2 실행 — 대상 배치의 기록만 지우고 지식·타인·진행 중·타 레인은 남긴다");
}
// R3
{
  const after = await countDistillerBacklog(lane, await listDistillers(true));
  assert.equal(after, backlogBefore + 1, `R3 되돌린 S1 이 레인 잔량에 다시 잡혀야 한다(before ${backlogBefore}, after ${after})`);
  ok("R3 재등장 — 지운 자료가 레인 잔량에 다시 잡힌다");
}

// R5 — 기간(since·until) 밖 배치는 고르지 않는다. (메인테이너 리뷰: 시험 배치가 전부 «1시간 전» 이라 기간 조건을 지워도 초록이었다.)
const srcAt = async (label, ago) => {
  const [r] = await q(`INSERT INTO source(kind, title, body_md, occurred_at) VALUES ($1, $2, $3, now() - $4::interval) RETURNING id`,
    [KIND, `rq-pg ${label}`, `본문 ${label} — 증류 대상이 될 만큼 충분히 긴 내용이다.`, ago]);
  src.push(Number(r.id));
  return Number(r.id);
};
const taskAt = async (ago) => Number((await q(
  `INSERT INTO org_task(requester, requester_session, prompt, status, created_at) VALUES ($1,$2,'p','done', now() - $3::interval) RETURNING id`,
  [ME, `cron:distill-sources-headless#${LANE}`, ago]))[0].id);
{
  const S7 = await srcAt("7", "3 days"), S8 = await srcAt("8", "1 hour");
  const T6 = await taskAt("3 days"), T7 = await taskAt("1 hour");
  await seen(S7, T6); await seen(S8, T7);
  const recent = await requeueDistillerSeen({ ...sel, distillerKey: LANE }, true);   // since = 2시간 전
  assert.ok(!recent.by_task.some((x) => x.task_id === T6), `R5 since 이전(3일 전)에 접수된 배치를 골랐다: ${JSON.stringify(recent.by_task)}`);
  assert.ok(recent.by_task.some((x) => x.task_id === T7), "R5 기간 안 배치(1시간 전)를 놓쳤다");
  const old = await requeueDistillerSeen({
    requester: ME, since: new Date(Date.now() - 4 * 86400e3).toISOString(), until: new Date(Date.now() - 2 * 86400e3).toISOString(), distillerKey: LANE,
  }, true);
  assert.deepEqual(old.by_task.map((x) => x.task_id), [T6], `R5 until 이후(1시간 전) 배치까지 골랐거나 기간 안 배치를 놓쳤다: ${JSON.stringify(old.by_task)}`);
  ok("R5 기간 — since 이전·until 이후 배치는 고르지 않는다");
}
// R6 — 같은 자료를 뒤 배치가 다시 판정했으면(markDistillerSeen 이 task_id 를 새 배치로 덮는다) 옛 배치를 되돌려도 그 판정은 남는다.
{
  const S9 = await srcAt("9", "1 hour");
  const T8 = await taskAt("50 minutes"), T9 = await taskAt("20 minutes");
  await seen(S9, T8);
  await markDistillerSeen(lane.id, [S9], T9);   // 재판정 — 운영 경로 그대로
  const r = await requeueDistillerSeen({ taskIds: [T8] }, false);
  assert.equal(r.requeued, 0, "R6 옛 배치에 남은 기록이 없어야 한다(task_id 가 새 배치로 옮겨졌다)");
  assert.ok((await laneSeen()).includes(S9), "R6 옛 배치를 되돌리다 뒤 배치의 판정까지 지웠다 — 그 자료가 다시 증류된다");
  ok("R6 재판정 — 옛 배치 되돌리기가 뒤 배치의 판정을 지우지 않는다");
}

// ── 정리 ──
await q(`DELETE FROM org_distiller_seen WHERE distiller_id=$1`, [lane.id]);
await q(`DELETE FROM org_stranded_seen WHERE source_id = ANY($1::int[])`, [src]);
await q(`DELETE FROM knowledge WHERE name=$1`, [KNAME]);
await q(`DELETE FROM source WHERE kind=$1`, [KIND]);
await q(`DELETE FROM org_task WHERE requester IN ($1,'rq-pg-other')`, [ME]);
await q(`DELETE FROM org_distiller WHERE id=$1`, [lane.id]);
console.log(`\nrequeue-seen.pg-test: ${pass} passed`);
await itemsPool.end().catch(() => {});
process.exit(0);
