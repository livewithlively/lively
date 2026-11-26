// 형식 정리 저장(style_fix)의 «본인 마지막 저장» 판정이 **감사 기록의 올바른 행**을 집는가. 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 pg-test 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=... node src/capabilities/knowledge/save-guard-last-write.pg-test.mjs
//
//  왜 이 계층인가: 판정(assertStyleFixSafe)은 순수 함수라 유닛 시험이 있지만, 어느 감사 행을 «지금 판을 만든 저장» 으로
//   볼지는 SQL(lastContentWrite)이 정한다. 판을 올리지 않는 토글도 after 에 지금 판을 싣기 때문에, 행을 잘못 집으면
//   같은 값으로 토글 하나만 불러도 남의 최근 편집 보호가 풀린다 — 목으로는 이 행 고르기가 안 보인다.
//
//  사양 엣지 표(행마다 단언):
//   L1 사람이 웹에서 고친 판 → 그 웹 저장(alice·web)을 돌려준다
//   L2 그 뒤 다른 계정이 MCP 로 판을 안 올리는 토글(set_wiki·set_lifecycle·set_searchable)을 불러도 여전히 alice·web
//   L3 L2 뒤 그 계정의 style_fix 저장은 409(보호 창 유지) · 행 그대로
//   L4 사람이 쓴 지식(confidence human)의 제목을 에이전트가 knowledge_set_title 로 고치면 그 MCP 저장을 돌려준다
//   L5 L4 뒤 같은 계정의 본문 style_fix 저장은 통과한다(종전엔 자기 편집에 409) · 판이 오른다
//   L6 감사 기록이 없는 판 → null(confidence 판정으로 돌아간다)
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { knowledgeSave, knowledgeSetTitle } = await import(`${DIST}/capabilities/knowledge/authoring.js`);
const { lastContentWrite } = await import(`${DIST}/capabilities/knowledge/save-guard.js`);
const { upsertKnowledge, setKnowledgeWiki, setKnowledgeLifecycle, setKnowledgeSearchable } = await import(`${DIST}/v6/knowledge-store.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const P = "sgpg-";
const ALICE = "__sgpg__alice", BOB = "__sgpg__bob";
const WEB_EDITED = `${P}web-edited`, HUMAN_DOC = `${P}human-doc`, NO_AUDIT = `${P}no-audit`;
const BODY = "배포는 **3회** 재시도한 뒤 멈춘다.\n\n- 대기 시간은 30초다.";
const BODY_FIXED = "배포는 3회 재시도한 뒤 멈춘다.\n\n- 대기 시간은 30초다.";

const mcp = (actor) => ({ actor, source: "mcp", viewer: actor });
const save = (actor, input) => knowledgeSave.handler(input, { userId: actor }, mcp(actor));
const attempt = async (fn) => {
  try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, status: e?.status, msg: String(e?.message ?? e) }; }
};
const rowOf = async (name) => (await itemsPool.query(
  `SELECT title, body_md, version, confidence, updated_by FROM knowledge WHERE name=$1`, [name])).rows[0];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function cleanup() {
  await itemsPool.query(`DELETE FROM org_content_audit WHERE entity='knowledge' AND left(entity_key, $2) = $1`, [P, P.length]);
  await itemsPool.query(`DELETE FROM knowledge WHERE left(name, $2) = $1`, [P, P.length]);
}

// 사람이 오래전에 쓴 지식 — 보호 창(24시간) 밖이라 판정은 «마지막 저장» 에만 달린다.
async function seedOld(name) {
  await itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, injection, provenance, lifecycle, confidence, source, visibility, updated_at, updated_by)
     VALUES($1, '배포 규칙', $2, 'recalled', 'authored', 'active', 'human', 'authored', 'open', now() - interval '10 days', $3)`,
    [name, BODY, ALICE]);
}

try {
  await (await import(`${DIST}/boot/schemas.js`)).initAllSchemas();
  await cleanup();
  await seedOld(WEB_EDITED);
  await seedOld(HUMAN_DOC);
  await seedOld(NO_AUDIT);

  {
    await upsertKnowledge({ name: WEB_EDITED, title: "배포 규칙", body_md: BODY + "\n\n- 근거는 런북이다." }, { actor: ALICE, source: "web" });
    const v = (await rowOf(WEB_EDITED)).version;
    const lw = await lastContentWrite(WEB_EDITED, v);
    chk("L1 사람의 웹 저장을 돌려준다", lw?.actor === ALICE && lw?.channel === "web", JSON.stringify(lw));

    await setKnowledgeWiki(WEB_EDITED, false, mcp(BOB));
    await setKnowledgeLifecycle(WEB_EDITED, "active", mcp(BOB));
    await setKnowledgeSearchable(WEB_EDITED, true, mcp(BOB));
    const after = await rowOf(WEB_EDITED);
    // 전제: 토글이 지금 판을 실은 감사 행을 실제로 남겼다 — 안 남기면 아래 L2·L3 은 op 필터를 시험하지 못하고 통과한다.
    const toggles = (await itemsPool.query(
      `SELECT count(*)::int AS n FROM org_content_audit WHERE entity='knowledge' AND entity_key=$1 AND op='set_wiki' AND actor=$2 AND after->>'version' = $3`,
      [WEB_EDITED, BOB, String(after.version)])).rows[0].n;
    chk("L2 전제: 토글이 지금 판을 실은 감사 행을 남겼다", toggles > 0, `set_wiki 행 ${toggles}건`);
    const lw2 = await lastContentWrite(WEB_EDITED, after.version);
    chk("L2 판을 안 올리는 토글 뒤에도 웹 저장을 돌려준다", Number(after.version) === Number(v) && lw2?.actor === ALICE && lw2?.channel === "web",
      `version ${v} → ${after.version} · ${JSON.stringify(lw2)}`);

    const r = await attempt(() => save(BOB, { name: WEB_EDITED, title: "배포 규칙", body_md: after.body_md.replace("**3회**", "3회"),
      style_fix: true, expected_version: Number(after.version) }));
    chk("L3 토글 뒤 남의 최근 편집에 style_fix 는 409", !r.ok && r.status === 409, JSON.stringify(r));
    chk("L3 행 그대로", same(await rowOf(WEB_EDITED), after), JSON.stringify(await rowOf(WEB_EDITED)));
  }

  {
    await knowledgeSetTitle.handler({ name: HUMAN_DOC, title: "배포 재시도 규칙" }, { userId: BOB }, mcp(BOB));
    const titled = await rowOf(HUMAN_DOC);
    const lw = await lastContentWrite(HUMAN_DOC, titled.version);
    chk("L4 set_title 의 MCP 저장을 돌려준다", lw?.actor === BOB && lw?.channel === "mcp",
      `${titled.confidence} · ${JSON.stringify(lw)}`);

    const r = await attempt(() => save(BOB, { name: HUMAN_DOC, title: "배포 재시도 규칙", body_md: BODY_FIXED,
      style_fix: true, expected_version: Number(titled.version) }));
    const fixed = await rowOf(HUMAN_DOC);
    chk("L5 제목을 고친 같은 계정의 본문 style_fix 는 통과한다", r.ok && fixed.body_md === BODY_FIXED
      && Number(fixed.version) === Number(titled.version) + 1, JSON.stringify(r.ok ? fixed : r));
  }

  {
    const v = (await rowOf(NO_AUDIT)).version;
    chk("L6 감사 기록이 없는 판은 null", (await lastContentWrite(NO_AUDIT, v)) === null);
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
