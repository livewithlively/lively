// #4007 개인 업로드 자동 잠금 소급 해제 — PG 통합 테스트 (**실제 Postgres 필요**, 기본 npm test 체인 밖).
//  실행: npm run build && node --env-file=.env src/v6/vis-personal-unlock.pg-test.mjs
//   (visibility.pg-test.mjs 와 같은 패턴 — dist 에서 컴파일된 모듈을 import 한다.)
//
//  왜 PG 통합인가: 이 조정기는 **여는 쪽**으로 움직인다 — 틀리면 잘못 여는 것이고 되돌릴 수 없다.
//   그 판정이 전부 SQL 술어(자료 술어 2개 · 정책 NOT EXISTS · 지식 재계산의 EXISTS/NOT EXISTS 쌍)에 살아서
//   목으로는 «근거 하나가 아직 잠겨 있으면 지식을 안 연다» 같은 조합이 실제로 걸리는지 볼 수 없다.
import crypto from "node:crypto";
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const { reconcilePersonalUploadVisibility } = await import(`${DIST}/v6/vis-personal-unlock.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const TAG = `__pu_${crypto.randomBytes(3).toString("hex")}__`;
const MEMBER = `${TAG}_up`;

async function cleanup() {
  await itemsPool.query(`DELETE FROM knowledge WHERE name LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM source WHERE external_id LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM org_source_vis_policy WHERE note LIKE $1`, [`${TAG}%`]);
}

/** 잠긴 자료 1건(대상=MEMBER). system·root 를 바꿔 가며 «자동 잠금이 만든 행» 과 그 밖을 만든다. */
async function mkLockedSource(key, system, root) {
  const r = await itemsPool.query(
    `INSERT INTO source(kind, title, body_md, fields, provenance, external_system, external_instance, external_id, visibility)
     VALUES('local_file', $1, 'body', $2::jsonb, 'observed', $3, 'default', $4, 'members') RETURNING id`,
    [key, JSON.stringify({ root, path: `uploads/${key}` }), system, `${TAG}${key}`]);
  const id = Number(r.rows[0].id);
  await itemsPool.query(
    `INSERT INTO source_member(source_id, subject_kind, member_id) VALUES($1,'member',$2)`, [id, MEMBER]);
  return id;
}

/** 잠긴 지식 1건 + 근거 링크들. links = [[sourceId, relation], …] */
async function mkLockedKnowledge(name, links) {
  await itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, visibility) VALUES($1,$1,'body','members')`, [`${TAG}${name}`]);
  await itemsPool.query(
    `INSERT INTO knowledge_member(name, subject_kind, member_id) VALUES($1,'member',$2)`, [`${TAG}${name}`, MEMBER]);
  for (const [sid, rel] of links) {
    await itemsPool.query(
      `INSERT INTO knowledge_source(name, source_id, relation) VALUES($1,$2,$3)`, [`${TAG}${name}`, sid, rel]);
  }
}

const visOf = async (t, col, v) =>
  (await itemsPool.query(`SELECT visibility FROM ${t} WHERE ${col}=$1`, [v])).rows[0]?.visibility;
const grantsOf = async (t, col, v) =>
  Number((await itemsPool.query(`SELECT count(*)::int n FROM ${t} WHERE ${col}=$1`, [v])).rows[0].n);

try {
  await cleanup();

  // ── 라운드 1: 정책이 없는 조직 — 자동 잠금이 남긴 것만 열린다 ──────────────────
  const sPersonal = await mkLockedSource("personal", "local", "personal");   // 자동 잠금이 만든 행
  const sProject  = await mkLockedSource("project",  "local", "project");    // 프로젝트 루트 — 자동 잠금 대상이 아니었다
  const sSlack    = await mkLockedSource("slack",    "slack", null);         // 커넥터 정책이 잠근 것

  await mkLockedKnowledge("k-only", [[sPersonal, "derived_from"]]);             // 근거가 전부 열린다 → 열림
  await mkLockedKnowledge("k-mixed", [[sPersonal, "derived_from"], [sSlack, "derived_from"]]); // 슬랙이 남는다 → 잠김
  await mkLockedKnowledge("k-none", []);                                        // 근거 없음 → 상속 산물이 아니다
  await mkLockedKnowledge("k-cites", [[sPersonal, "cites"]]);                    // 참조뿐 → 상속 산물이 아니다

  const r1 = await reconcilePersonalUploadVisibility();

  chk("S1 개인 루트 로컬 업로드가 열린다", await visOf("source", "id", sPersonal) === "open",
    `visibility=${await visOf("source", "id", sPersonal)}`);
  chk("S1b 그 자료의 대상 행도 사라진다", await grantsOf("source_member", "source_id", sPersonal) === 0);
  chk("S2 프로젝트 루트 업로드는 건드리지 않는다", await visOf("source", "id", sProject) === "members");
  chk("S3 커넥터(슬랙) 자료는 건드리지 않는다", await visOf("source", "id", sSlack) === "members");

  chk("K1 근거가 전부 열린 지식은 열린다", await visOf("knowledge", "name", `${TAG}k-only`) === "open",
    `visibility=${await visOf("knowledge", "name", `${TAG}k-only`)}`);
  chk("K1b 그 지식의 대상 행도 사라진다", await grantsOf("knowledge_member", "name", `${TAG}k-only`) === 0);
  chk("K2 ★근거 하나라도 잠겨 있으면 지식은 잠긴 채로 둔다", await visOf("knowledge", "name", `${TAG}k-mixed`) === "members",
    "슬랙 근거가 남았는데 지식을 열었다 — 유출");
  chk("K3 근거 없는 지식은 건드리지 않는다(상속 산물이 아니다)", await visOf("knowledge", "name", `${TAG}k-none`) === "members");
  chk("K4 cites(참조)뿐인 지식은 건드리지 않는다", await visOf("knowledge", "name", `${TAG}k-cites`) === "members");

  chk("C1 집계가 실제 변경분과 맞다", r1.sources === 1 && r1.knowledge === 1, JSON.stringify(r1));

  // ── 라운드 2: 멱등 — 다시 돌려도 더 열지 않는다 ──────────────────────────────
  const r2 = await reconcilePersonalUploadVisibility();
  chk("I1 두 번째 실행은 아무것도 바꾸지 않는다", r2.sources === 0 && r2.knowledge === 0, JSON.stringify(r2));
  chk("I2 두 번째 실행이 남은 잠금을 풀지 않는다",
    await visOf("source", "id", sSlack) === "members" && await visOf("knowledge", "name", `${TAG}k-mixed`) === "members");

  // ── 라운드 3: 로컬 대상 정책이 생기면 손을 뗀다(사람이 정한 잠금을 되돌리지 않는다) ──
  const sPersonal2 = await mkLockedSource("personal2", "local", "personal");
  await itemsPool.query(
    `INSERT INTO org_source_vis_policy(match_system, match_channel, visibility, priority, enabled, note)
     VALUES('local', NULL, 'members', 0, true, $1)`, [`${TAG}policy`]);
  const r3 = await reconcilePersonalUploadVisibility();
  chk("P1 ★로컬 정책이 있는 테넌트에서는 아무것도 열지 않는다", r3.sources === 0, JSON.stringify(r3));
  chk("P1b 그 자료는 잠긴 채로 남는다", await visOf("source", "id", sPersonal2) === "members");
} finally {
  await cleanup();
  await itemsPool.end().catch(() => {});
}

console.log(`\n${fail ? "✗" : "✓"} vis-personal-unlock: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
