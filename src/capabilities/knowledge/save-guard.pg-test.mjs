// knowledge_save 의 덮어쓰기 안전장치(save-guard) — 판 대조(expected_version)와 형식 정리 저장(style_fix)이 **실제 핸들러·DB** 에서
//  걸리는가. 실제 Postgres 필요(기본 유닛 체인 밖). CI 의 pg-test 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=... node src/capabilities/knowledge/save-guard.pg-test.mjs
//
//  왜 이 계층인가: save-guard.test.ts 는 판정 함수만 본다. 핸들러가 그 함수를 부르는지, 판 대조가 «읽은 판» 이 아니라 «쓰는 순간의
//   판» 에 걸리는지는 실제 트랜잭션·행 잠금으로만 보인다. 경합은 이렇게 만든다 — 다른 연결이 행을 고친 채(커밋 전) 잡고 있는 동안
//   핸들러를 부르고, 핸들러가 그 잠금을 기다리는 것을 pg_stat_activity 로 본 뒤 커밋한다. 핸들러의 조기 대조는 커밋 전 판을 읽어
//   통과하고 쓰기는 끼어든 저장 뒤에 온다 — «대조와 쓰기 사이에 낀 저장» 을 타이밍에 기대지 않고 재현한다.
//
//  사양 엣지 표(행마다 단언):
//   V1 expected_version 이 지금 판과 다르면 409(conflict=version · expected_version · current_version) · 행 그대로
//   V2 맞으면 저장(version+1)
//   V3 빼면 종전대로 저장(version+1 · 본문 교체)
//   V4 없는 이름에 보내면 409(current_version=null) · 행이 생기지 않는다
//   W1 조기 대조 뒤 다른 저장이 끼면(replace) 409(current_version=끼어든 판) · 끼어든 저장의 본문이 남는다
//   W2 같은 경합을 edit 로(읽은 본문 위에 계산한 저장) — 409 · 끼어든 본문이 남는다
//   W3 같은 경합을 derived_from 저장으로 — 같은 모양의 409 · 끼어든 본문이 남고 연결도 생기지 않는다
//   W4 스토어 — upsertKnowledge(expectedVersion)가 어긋나면 KnowledgeVersionConflictError(지금 판) · 행 그대로 ·
//      없는 이름이면 행을 만들지 않는다 · 맞으면 쓴다
//   D1 derived_from 저장에 맞는 expected_version — 저장되고 연결된다
//   G1 인입 허용선 stage·review 에서 낡은 expected_version → 409 · 제안이 생기지 않고 본문 그대로
//   G2 stage 에서 맞는 expected_version → 제안의 base_version 이 그 판 · 라이브 본문 그대로
//   S1 에이전트 style_fix edit 가 수치를 바꾸면 422(invariant:numbers) · 행 그대로
//   S2 style_fix + mode:"append" → 400 · 행 그대로
//   S3 형식만 고친 style_fix 는 저장된다
//   T1 에이전트 저장 뒤 같은 계정의 사람이 웹에서 제목만 고치면(knowledge_set_title) 그 계정 에이전트의 style_fix 는 보호 창에 막힌다
//   T2 사람이 오래전에 쓴 글의 제목을 에이전트가 knowledge_set_title 로 고친 뒤 자기 style_fix 는 통과한다(도구 설명이 안내하는 흐름)
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { knowledgeSave, knowledgeSetTitle } = await import(`${DIST}/capabilities/knowledge/authoring.js`);
const store = await import(`${DIST}/v6/knowledge-store.js`);
const { registerEnterprise, _resetEnterpriseForTest } = await import(`${DIST}/enterprise/registry.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n}. ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const P = "sg-pg-test-";
const AGENT = "__sg_pg_test__bob";
const OTHER = "__sg_pg_test__carol";
const CAT = `${P}cat`;
const SYS = `${P}sys`;                 // 자료의 external_system(정리용 표식)
const BODY = "배포는 **3회** 재시도한 뒤 멈춘다.\n\n- 대기 시간은 30초다.\n- 근거는 [[deploy-runbook]] 이다.";
const OTHER_BODY = "다른 저장이 끼어들어 고친 본문이다.";

const agentUser = { userId: AGENT };
const agentCtx = { actor: AGENT, source: "mcp", viewer: AGENT };
const humanUser = { userId: AGENT, tokenSource: "session" };   // 같은 계정의 사람(웹 세션)
const humanCtx = { actor: AGENT, source: "web", viewer: AGENT };
const settle = (p) => p.then((res) => ({ threw: false, res }), (e) => ({ threw: true, status: e?.status, body: e?.body, msg: String(e?.message ?? e) }));
const save = (input) => settle(knowledgeSave.handler(input, agentUser, agentCtx));
const brief = (r) => JSON.stringify({ ...r, res: r.res && { version: r.res.knowledge?.version, gate: r.res.gate?.action }, msg: r.msg?.slice(0, 160) });
const row = async (name) => (await itemsPool.query(
  `SELECT title, body_md, version, confidence, updated_by FROM knowledge WHERE name=$1`, [name])).rows[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isVersionConflict = (r, expected, current) => r.threw && r.status === 409 && r.body?.conflict === "version"
  && r.body?.expected_version === expected && r.body?.current_version === current;

async function cleanup() {
  await itemsPool.query(`DELETE FROM knowledge_revision WHERE name LIKE $1`, [`${P}%`]);
  await itemsPool.query(`DELETE FROM org_content_audit WHERE entity='knowledge' AND entity_key LIKE $1`, [`${P}%`]);
  await itemsPool.query(`DELETE FROM knowledge WHERE name LIKE $1`, [`${P}%`]);   // 연결·카테고리 매핑은 FK CASCADE
  await itemsPool.query(`DELETE FROM source WHERE external_system=$1`, [SYS]);
  await itemsPool.query(`DELETE FROM category WHERE key=$1`, [CAT]);
}
/** 지식 1건 — 기본은 다른 사람이 사흘 전에 웹에서 쓴 글(보호 창 밖). */
async function mk(name, { version = 1, confidence = "human", updatedBy = OTHER, daysAgo = 3 } = {}) {
  await itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, provenance, lifecycle, visibility, type, confidence, updated_by, updated_at, version)
     VALUES($1, $1, $2, 'authored', 'active', 'open', 'reference', $3, $4, now() - make_interval(days => $5::int), $6)`,
    [name, BODY, confidence, updatedBy, daysAgo, version]);
}
async function mkSource(tag) {
  const r = await itemsPool.query(
    `INSERT INTO source(kind, title, body_md, fields, provenance, external_system, external_instance, external_id, visibility)
     VALUES('other', $1, $1, '{}'::jsonb, 'observed', $2, 'default', $1, 'open') RETURNING id`, [`${P}${tag}`, SYS]);
  return Number(r.rows[0].id);
}

/**
 * 다른 저장(B)이 행을 고친 채(커밋 전) 잡고 있는 동안 run 을 시작하고, run 이 그 잠금을 기다리는 것을 본 뒤 B 를 커밋한다.
 *  run 의 조기 대조는 B 커밋 전의 판을 읽어 통과하고, 쓰기는 B 뒤에 온다. waited 가 false 면 run 이 쓰기에 닿기 전에 끝난 것이다.
 */
async function interleave(name, run) {
  const b = await itemsPool.connect();
  try {
    await b.query("BEGIN");
    const bPid = (await b.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    await b.query(`UPDATE knowledge SET body_md=$2, version=version+1, updated_at=now(), updated_by=$3 WHERE name=$1`, [name, OTHER_BODY, OTHER]);
    let done = false;
    const p = settle(run()).finally(() => { done = true; });
    let waited = false;
    //  B 에게 막힌 세션만 센다(pg_blocking_pids) — 같은 DB 의 다른 대기(뒤로 미룬 색인 등)를 «핸들러가 기다린다» 로 오인하지 않게.
    for (let i = 0; i < 400 && !waited && !done; i++) {
      const r = await itemsPool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`, [bPid]);
      if (r.rows[0].n > 0) waited = true; else await sleep(25);
    }
    await b.query("COMMIT");
    return { waited, ...(await p) };
  } catch (e) {
    await b.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    b.release();
  }
}

const DOC_V = `${P}v`, DOC_W1 = `${P}w1`, DOC_W2 = `${P}w2`, DOC_W3 = `${P}w3`, DOC_ST = `${P}store`, DOC_D = `${P}d`;
const DOC_G = `${P}g`, DOC_S = `${P}s`, DOC_T1 = `${P}t1`, DOC_T2 = `${P}t2`;

try {
  await (await import(`${DIST}/boot/schemas.js`)).initAllSchemas();
  await cleanup();
  await itemsPool.query(`INSERT INTO category(key, name) VALUES($1, $1)`, [CAT]);
  await mk(DOC_V, { version: 5 });
  for (const d of [DOC_W1, DOC_W2, DOC_W3]) await mk(d, { version: 3 });
  await mk(DOC_ST, { version: 2 });
  await mk(DOC_D, { version: 2 });
  await mk(DOC_G, { version: 4 });
  await mk(DOC_S);
  await mk(DOC_T1);
  await mk(DOC_T2);
  const SRC1 = await mkSource("s1");
  const SRC2 = await mkSource("s2");

  // ── V: 순차 판 대조 ──
  {
    const r = await save({ name: DOC_V, body_md: "V1 본문이다.", expected_version: 4 });
    chk("V1 낡은 expected_version → 409(conflict=version · expected 4 · current 5)", isVersionConflict(r, 4, 5), brief(r));
    const after = await row(DOC_V);
    chk("V1 행 그대로", after.body_md === BODY && Number(after.version) === 5, JSON.stringify(after));
  }
  {
    const r = await save({ name: DOC_V, body_md: "V2 본문이다.", expected_version: 5 });
    const after = await row(DOC_V);
    chk("V2 맞는 expected_version → 저장(version 6)", !r.threw && Number(r.res.knowledge?.version) === 6
      && after.body_md === "V2 본문이다." && Number(after.version) === 6, brief(r));
  }
  {
    const r = await save({ name: DOC_V, body_md: "V3 본문이다." });
    const after = await row(DOC_V);
    chk("V3 expected_version 없이 → 종전대로 저장(version 7)", !r.threw && Number(r.res.knowledge?.version) === 7
      && after.body_md === "V3 본문이다." && Number(after.version) === 7, brief(r));
  }
  {
    const NOPE = `${P}nope`;
    const r = await save({ name: NOPE, body_md: "없는 지식이다.", category: CAT, type: "reference", expected_version: 1 });
    chk("V4 없는 이름에 expected_version → 409(current_version=null)", isVersionConflict(r, 1, null), brief(r));
    chk("V4 행이 생기지 않는다", !(await row(NOPE)));
  }

  // ── W: 조기 대조와 쓰기 사이에 낀 저장 ──
  {
    const r = await interleave(DOC_W1, () => knowledgeSave.handler({ name: DOC_W1, body_md: "A 의 본문이다.", expected_version: 3 }, agentUser, agentCtx));
    chk("W1 핸들러가 끼어든 저장의 잠금을 기다렸다(경합 재현)", r.waited, brief(r));
    chk("W1 replace — 쓰는 순간 판이 어긋나면 409(current 4)", isVersionConflict(r, 3, 4), brief(r));
    const after = await row(DOC_W1);
    chk("W1 끼어든 저장의 본문이 남는다", after.body_md === OTHER_BODY && Number(after.version) === 4, JSON.stringify(after));
  }
  {
    const r = await interleave(DOC_W2, () => knowledgeSave.handler(
      { name: DOC_W2, mode: "edit", edits: [{ old: "30초", new: "60초" }], expected_version: 3 }, agentUser, agentCtx));
    chk("W2 핸들러가 끼어든 저장의 잠금을 기다렸다", r.waited, brief(r));
    chk("W2 edit — 쓰는 순간 판이 어긋나면 409(current 4)", isVersionConflict(r, 3, 4), brief(r));
    const after = await row(DOC_W2);
    chk("W2 끼어든 저장의 본문이 남는다", after.body_md === OTHER_BODY && Number(after.version) === 4, JSON.stringify(after));
  }
  {
    const r = await interleave(DOC_W3, () => knowledgeSave.handler(
      { name: DOC_W3, body_md: "A 의 증류 본문이다.", derived_from: [SRC2], expected_version: 3 }, agentUser, agentCtx));
    chk("W3 핸들러가 끼어든 저장의 잠금을 기다렸다", r.waited, brief(r));
    chk("W3 derived_from — 같은 모양의 409(current 4)", isVersionConflict(r, 3, 4), brief(r));
    const after = await row(DOC_W3);
    const links = (await itemsPool.query(`SELECT 1 FROM knowledge_source WHERE name=$1`, [DOC_W3])).rowCount;
    chk("W3 끼어든 본문이 남고 연결이 생기지 않는다", after.body_md === OTHER_BODY && Number(after.version) === 4 && links === 0,
      JSON.stringify({ after, links }));
  }
  {
    const Conflict = store.KnowledgeVersionConflictError;
    const conflictOf = (r) => (r.threw && typeof Conflict === "function" && r.err instanceof Conflict
      ? { expected: r.err.expectedVersion, current: r.err.currentVersion } : null);
    const ctx = { actor: AGENT, source: "mcp" };
    const tryUpsert = (input, expectedVersion) => store.upsertKnowledge(input, ctx, { expectedVersion })
      .then((res) => ({ threw: false, res }), (err) => ({ threw: true, err, msg: String(err?.message ?? err).slice(0, 160) }));
    const r1 = await tryUpsert({ name: DOC_ST, body_md: "스토어 본문이다." }, 1);
    chk("W4 스토어 — 판이 어긋나면 KnowledgeVersionConflictError(expected 1 · current 2)",
      JSON.stringify(conflictOf(r1)) === JSON.stringify({ expected: 1, current: 2 }), JSON.stringify({ threw: r1.threw, msg: r1.msg, v: r1.res?.version }));
    const after1 = await row(DOC_ST);
    chk("W4 그때 행 그대로", after1.body_md === BODY && Number(after1.version) === 2, JSON.stringify(after1));
    const GHOST = `${P}ghost`;
    const r2 = await tryUpsert({ name: GHOST, body_md: "유령이다.", category: CAT, type: "reference" }, 1);
    chk("W4 없는 이름 — KnowledgeVersionConflictError(current null) · 행을 만들지 않는다",
      JSON.stringify(conflictOf(r2)) === JSON.stringify({ expected: 1, current: null }) && !(await row(GHOST)),
      JSON.stringify({ threw: r2.threw, msg: r2.msg, v: r2.res?.version }));
    const r3 = await tryUpsert({ name: DOC_ST, body_md: "스토어 본문이다." }, 2);
    chk("W4 판이 맞으면 쓴다(version 3)", !r3.threw && Number(r3.res?.version) === 3 && (await row(DOC_ST)).body_md === "스토어 본문이다.",
      JSON.stringify({ threw: r3.threw, msg: r3.msg, v: r3.res?.version }));
  }

  // ── D: derived_from 저장 + 맞는 판 ──
  {
    const r = await save({ name: DOC_D, body_md: "증류 본문이다.", derived_from: [SRC1], expected_version: 2 });
    const after = await row(DOC_D);
    const links = (await itemsPool.query(`SELECT 1 FROM knowledge_source WHERE name=$1 AND source_id=$2`, [DOC_D, SRC1])).rowCount;
    chk("D1 derived_from + 맞는 expected_version → 저장·연결", !r.threw && Number(after.version) === 3
      && after.body_md === "증류 본문이다." && links === 1, brief(r));
  }

  // ── G: 인입 허용선 stage·review ──
  {
    const policy = (update) => {
      _resetEnterpriseForTest();
      registerEnterprise({ ingestPolicy: {
        resolveIngestPolicy: () => ({ create: "auto", update, create_rule_id: null, update_rule_id: update === "auto" ? null : 7 }),
        getIngestPolicyRules: async () => [], invalidateIngestPolicyCache() {},
      } });
    };
    const revisions = async () => (await itemsPool.query(
      `SELECT base_version FROM knowledge_revision WHERE name=$1 AND status='pending'`, [DOC_G])).rows;
    try {
      for (const update of ["stage", "review"]) {
        policy(update);
        const r = await save({ name: DOC_G, body_md: `${update} 제안 본문이다.`, expected_version: 3 });
        const after = await row(DOC_G);
        chk(`G1 update=${update} 낡은 expected_version → 409 · 제안 없음 · 본문 그대로`, isVersionConflict(r, 3, 4)
          && (await revisions()).length === 0 && after.body_md === BODY && Number(after.version) === 4, brief(r));
      }
      policy("stage");
      const r = await save({ name: DOC_G, body_md: "stage 제안 본문이다.", expected_version: 4 });
      const revs = await revisions();
      const after = await row(DOC_G);
      chk("G2 stage + 맞는 expected_version → 제안(base_version 4) · 라이브 그대로", !r.threw && r.res.gate?.action === "stage"
        && revs.length === 1 && Number(revs[0].base_version) === 4 && after.body_md === BODY && Number(after.version) === 4,
      JSON.stringify({ r: brief(r), revs }));
    } finally {
      _resetEnterpriseForTest();
    }
  }

  // ── S: style_fix 의미 보존 ──
  {
    const r = await save({ name: DOC_S, mode: "edit", edits: [{ old: "**3회**", new: "**5회**" }], style_fix: true });
    chk("S1 style_fix edit 가 수치를 바꾸면 422(invariant:numbers)", r.threw && r.status === 422 && r.body?.style_fix?.rejected === "invariants"
      && (r.body?.style_fix?.violations ?? []).some((v) => v.kind === "invariant:numbers"), brief(r));
    const after = await row(DOC_S);
    chk("S1 행 그대로", after.body_md === BODY && Number(after.version) === 1, JSON.stringify(after));
  }
  {
    const r = await save({ name: DOC_S, mode: "append", body_md: "덧붙인 문단이다.", style_fix: true });
    chk("S2 style_fix + append → 400", r.threw && r.status === 400, brief(r));
    const after = await row(DOC_S);
    chk("S2 행 그대로", after.body_md === BODY && Number(after.version) === 1, JSON.stringify(after));
  }
  {
    const r = await save({ name: DOC_S, mode: "edit", edits: [{ old: "**3회**", new: "3회" }], style_fix: true, expected_version: 1 });
    const after = await row(DOC_S);
    chk("S3 형식만 고친 style_fix 는 저장된다", !r.threw && Number(after.version) === 2 && after.body_md === BODY.replace("**3회**", "3회"), brief(r));
  }

  // ── T: 제목 갱신(knowledge_set_title)이 남기는 저장 출처 ──
  {
    const s = await save({ name: DOC_T1, body_md: `${BODY}\n\n에이전트가 덧붙인 문단이다.` });
    const t = await settle(knowledgeSetTitle.handler({ name: DOC_T1, title: "사람이 고친 제목" }, humanUser, humanCtx));
    const mid = await row(DOC_T1);
    chk("T1 사람의 웹 제목 갱신은 confidence=human 을 남긴다", !s.threw && !t.threw && mid.confidence === "human" && mid.updated_by === AGENT,
      JSON.stringify({ s: brief(s), t: brief(t), mid: { ...mid, body_md: undefined } }));
    const r = await save({ name: DOC_T1, mode: "edit", edits: [{ old: "**3회**", new: "3회" }], style_fix: true });
    chk("T1 그 뒤 같은 계정 에이전트의 style_fix 는 보호 창에 막힌다(409 recently_edited)", r.threw && r.status === 409
      && r.body?.style_fix?.rejected === "recently_edited", brief(r));
    chk("T1 제목·본문 그대로", (await row(DOC_T1)).title === "사람이 고친 제목" && (await row(DOC_T1)).body_md.includes("**3회**"));
  }
  {
    const t = await settle(knowledgeSetTitle.handler({ name: DOC_T2, title: "에이전트가 고친 제목" }, agentUser, agentCtx));
    const mid = await row(DOC_T2);
    chk("T2 에이전트의 제목 갱신은 confidence=ai 를 남긴다", !t.threw && mid.confidence === "ai" && mid.updated_by === AGENT,
      JSON.stringify({ t: brief(t), mid: { ...mid, body_md: undefined } }));
    const r = await save({ name: DOC_T2, mode: "edit", edits: [{ old: "**3회**", new: "3회" }], style_fix: true, expected_version: Number(mid.version) });
    chk("T2 제목을 먼저 고친 에이전트의 자기 style_fix 는 통과한다", !r.threw && (await row(DOC_T2)).body_md === BODY.replace("**3회**", "3회"), brief(r));
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
