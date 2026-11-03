// 수집 가림(#5308) 배선 — PG 통합 테스트 (**실제 Postgres 필요**, 기본 npm test 체인 밖).
//  실행: npm run build && ITEMS_DATABASE_URL=… node src/v6/mirror/mirror-scrub.pg-test.mjs
//
//  왜 PG 통합인가: 판정이 전부 «무엇이 실제로 저장됐나» 에 산다 — 미러가 쓴 행(제목·본문·fields·원장), 변경 이력(org_content_audit)의
//   before/after, 수집기 표식(sync_state.seen_by), 소급 스윕이 고른 행(SQL 술어)과 건드리지 않은 행. 목으로는 «이력에서 값이 사라졌나»
//   «남의 몫은 그대로인가» 를 볼 수 없다. 미러 진입점(mirrorExternalToV6)과 스윕을 부르고 DB 를 되읽어 판정한다.
//  값은 전부 지어낸 것이다(실 고객 값 없음).
//
//  사양 엣지 표(스크래치 spec.md «배선» 과 같은 번호):
//   W1 가림 켠 수집기 + 노션 지식 미러 → 제목·본문·fields 가림 · 원장 블록/속성 원문 없음 · 표시=판 · 원장 시각 남음 · 업무 문장 남음
//   W2 바인딩 없음 / piiScrub 미지정 → 종전 그대로(원문·표시 없음·원장 블록 있음)
//   W3 가림 켠 수집기 + 자료 미러 → 가림 · 보낸 사람 메일 가림 · 이름 남음 · 수집기 표식
//   W4 가리지 않은 옛 행을 가림 켠 수집기가 다시 씀 → 그 행의 옛 이력까지 가림 · 새 이력의 before 도 가림(지식·자료)
//   W5 가린 결과가 직전과 같은 재싱크 → 새 이력 없음
//   W6 소급 스윕 → 내 표식 행 · 같은 인스턴스 주인 없는 행을 가림+표시+이력 가림 · 지식 임베딩 리셋 · 자료 updated_at 그대로
//   W7 소급 스윕 → 다른 수집기 표식 행 · 다른 인스턴스 · 사람이 쓴 지식은 그대로
//   W8 소급 스윕 재실행 → 0건 · 쓰기 없음
//   W9 가림 켠 수집기 + 클릭업 작업(되쓰는 미러) → 가리지 않음
//   W10 수집기 저장 → pii_scrub 켬 · output_config 만 바꿔도 유지 · 끄면 꺼짐
//   W11 소급 스윕 시간 상한 0 → 아무것도 안 하고 남은 수를 돌려준다
//   W12 표식이 한 번도 없던 옛 자료(이 변경 전 적재분, 새 글 없음) → legacySystem 을 주면 가림 · 안 주면 그대로
//   W13 가림 켠 메일함 수집(지메일 꼴) → 원장 payload 없음 · 보낸 사람 id(메일) 가림 · person 신원층에 고객 메일 없음
//   W14 클릭업 수집기에 가림 켜기 → 거절
import crypto from "node:crypto";
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { mirrorExternalToV6 } = await import(`${DIST}/v6/connector-mirror.js`);
const { withCollector } = await import(`${DIST}/connectors/config.js`);
const { sweepScrubBacklog, SCRUB_MARK } = await import(`${DIST}/v6/mirror/mirror-scrub.js`);
const { SCRUB_LABELS: M } = await import(`${DIST}/org/ingest/content-scrub.js`);
const { upsertCollector, listCollectors } = await import(`${DIST}/org/store/collectors.js`);
const { ingestItems } = await import(`${DIST}/items/store.js`);

delete process.env.ANTHROPIC_API_KEY;   // 미러의 LLM 분류를 끈다(본문을 밖으로 보내지 않는다 · 결정적)

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const TAG = `scr${crypto.randomBytes(3).toString("hex")}`;
const INST = `${TAG}-ws`;               // 이 시험의 외부 인스턴스(워크스페이스)
const INST2 = `${TAG}-ws2`;             // 다른 워크스페이스
const INST3 = `${TAG}-ws3`;             // 표식이 한 번도 없던 옛 자료의 워크스페이스(W12)
const LEGACY_SYS = `${TAG}chat`;        // W12 전용 앱 이름 — 다른 시험·실데이터의 옛 행을 건드리지 않게
const CLAIM = `notion:${TAG}`;          // 이 시험 수집기의 표식(collectorClaimKey 꼴 = 프리셋:인스턴스)
const SCLAIM = `slack:${TAG}`;
const OTHER = `notion:${TAG}-other`;
const ON = { id: 990_501, presetKey: "notion", instanceKey: TAG, piiScrub: true };
const ON_SLACK = { id: 990_502, presetKey: "slack", instanceKey: TAG, piiScrub: true };
const OFF = { id: 990_503, presetKey: "notion", instanceKey: TAG };   // piiScrub 미지정 — 새 칸이 비어 있는 경우

// 지어낸 민감값 — 저장된 어디에도(행 JSON 전체) 남으면 안 된다.
const PW = "qwer1234zz", MAIL = "kim.cust@example-test.io", PHONE = "010-9876-5432", PHONE2 = "+82 10 9876 5432";
const leaks = (obj) => [PW, MAIL, "9876-5432", "9876 5432"].filter((v) => JSON.stringify(obj).includes(v));

let seq = 0;
function notionItem(id, o = {}) {
  return {
    type: "doc",
    provenance: { category: "collab_tool", system: "notion", instance: o.instance ?? INST, external_id: id, external_url: `https://www.notion.so/${id}` },
    title: o.title ?? `고객 김 ${PHONE}`,
    body: o.body ?? ["| 속성 | 값 |", "| --- | --- |", `| 비밀번호 | ${PW} |`, `| 이메일 | ${MAIL} |`, "", "업무 메모: 다음 주 미팅에서 견적 확정"].join("\n"),
    occurred_at: "2026-10-01T00:00:00.000Z",
    updated_at: o.updated_at ?? "2026-11-01T00:00:00.000Z",
    fields: {
      archived: false, in_trash: false,
      notion: {
        kind: "db_row", url: `https://www.notion.so/${id}`,
        properties: {
          비밀번호: { type: "rich_text", text: PW, value: PW },
          담당: { type: "phone_number", text: PHONE2, value: PHONE2 },
          회사: { type: "rich_text", text: "예시상사", value: "예시상사" },
        },
      },
    },
    raw: {
      page: { id, last_edited_time: o.updated_at ?? "2026-11-01T00:00:00.000Z", properties: { 비밀번호: { type: "rich_text", rich_text: [{ plain_text: PW }] } } },
      blocks: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "PW: " }, { plain_text: PW }] } }],
      comments: [], property_items: {},
    },
  };
}
function slackItem(id, o = {}) {
  const text = o.body ?? `고객 문의 ${MAIL} ${PHONE} 예약 https://x.io/book?token=abcdef1234567890&x=1`;
  return {
    type: "message",
    provenance: { category: "chat", system: "slack", instance: o.instance ?? INST, external_id: id, external_url: `https://x.slack.com/archives/C1/p${id}` },
    title: o.title ?? "#9999_도입문의",
    body: text,
    occurred_at: "2026-10-01T00:00:00.000Z",
    actor: { external_id: `U${TAG}`, display_name: "고객", email: MAIL },
    container_ref: "C1", container_name: "9999_도입문의",
    fields: {},
    raw: { text, blocks: [{ type: "rich_text", elements: [{ type: "text", text: "PW: " }, { type: "text", text: PW, style: { code: true } }] }], ts: "1785377560.030869" },
  };
}

const mirror = async (it, binding, claimKey) => {
  const c = await itemsPool.connect();
  try {
    const run = () => mirrorExternalToV6(c, it, claimKey ? { claimKey } : undefined);
    return binding ? await withCollector(binding, run) : await run();
  } finally { c.release(); }
};
const kRow = async (extId, inst = INST) => (await itemsPool.query(
  `SELECT name, title, body_md, fields, raw, sync_state, version, updated_at::text AS updated_at, embedding_model FROM knowledge
    WHERE external_system='notion' AND external_instance=$1 AND external_id=$2`, [inst, extId])).rows[0];
const sRow = async (extId) => (await itemsPool.query(
  `SELECT id, title, body_md, fields, raw, sync_state, updated_at::text AS updated_at FROM source
    WHERE external_system='slack' AND external_instance=$1 AND external_id=$2`, [INST, extId])).rows[0];
const audits = async (entity, key) => (await itemsPool.query(
  `SELECT op, before, after FROM org_content_audit WHERE entity=$1 AND entity_key=$2 ORDER BY at, id`, [entity, key])).rows;

async function cleanup() {
  const ks = (await itemsPool.query(`SELECT name FROM knowledge WHERE external_instance = ANY($1::text[]) OR name LIKE $2`, [[INST, INST2, INST3], `${TAG}%`])).rows.map((r) => r.name);
  const ss = (await itemsPool.query(`SELECT id::text AS id FROM source WHERE external_instance = ANY($1::text[])`, [[INST, INST2, INST3]])).rows.map((r) => r.id);
  const ps = (await itemsPool.query(`SELECT id::text AS id FROM project WHERE external_instance = ANY($1::text[])`, [[INST, INST2]])).rows.map((r) => r.id);
  await itemsPool.query(`DELETE FROM org_content_audit WHERE (entity='knowledge' AND entity_key = ANY($1::text[])) OR (entity='source' AND entity_key = ANY($2::text[])) OR (entity='project' AND entity_key = ANY($3::text[]))`, [ks, ss, ps]);
  await itemsPool.query(`DELETE FROM knowledge WHERE name = ANY($1::text[])`, [ks]);
  await itemsPool.query(`DELETE FROM source WHERE id = ANY($1::int[])`, [ss.map(Number)]);
  await itemsPool.query(`DELETE FROM project WHERE id = ANY($1::int[])`, [ps.map(Number)]);
  const cs = (await itemsPool.query(`SELECT id FROM org_collector WHERE key LIKE $1`, [`${TAG}%`])).rows.map((r) => Number(r.id));
  for (const id of cs) await itemsPool.query(`DELETE FROM org_cron WHERE id=$1`, [`collector-${id}`]).catch(() => {});
  await itemsPool.query(`DELETE FROM org_collector WHERE key LIKE $1`, [`${TAG}%`]);
  const pids = (await itemsPool.query(`SELECT person_id FROM person_identity WHERE system='gmail' AND instance=$1`, [INST])).rows.map((r) => r.person_id);
  await itemsPool.query(`DELETE FROM person_identity_audit WHERE system='gmail' AND person_id = ANY($1::text[])`, [pids]).catch(() => {});
  await itemsPool.query(`DELETE FROM person_identity WHERE system='gmail' AND instance=$1`, [INST]);
  await itemsPool.query(`DELETE FROM person WHERE id = ANY($1::text[])`, [pids]).catch(() => {});
}

try {
  await cleanup();

  // ── W1 가림 켠 노션 지식 미러 ──
  {
    const stored = await mirror(notionItem(`${TAG}-p1`), ON, CLAIM);
    const r = await kRow(`${TAG}-p1`);
    const au = r ? await audits("knowledge", r.name) : [];
    chk("W1 배선 — 행이 적재됐고 이력 행이 있다", stored === true && !!r && au.length === 1, JSON.stringify({ stored, r: !!r, au: au.length }));
    chk("W1 ★행 어디에도(제목·본문·fields·원장) 민감값이 없다", r && leaks(r).length === 0, JSON.stringify(r && leaks(r)));
    chk("W1 ★이력(insert after)에도 없다", leaks(au).length === 0, JSON.stringify(leaks(au)));
    chk("W1 가린 자리에 종류가 남는다", r && r.title.includes(M.phone) && r.body_md.includes(`| 비밀번호 | ${M.password} |`) && r.body_md.includes(M.email)
      && r.fields.notion.properties.비밀번호.value === M.password && r.fields.notion.properties.담당.value === M.phone, JSON.stringify(r && { t: r.title, b: r.body_md }));
    chk("W1 업무 문장·뼈대는 남는다(원장 시각 · kind · 회사 칸)", r && r.body_md.includes("업무 메모: 다음 주 미팅에서 견적 확정")
      && r.raw.page.last_edited_time === "2026-11-01T00:00:00.000Z" && r.fields.notion.kind === "db_row"
      && r.fields.notion.properties.회사.value === "예시상사", JSON.stringify(r && { raw: r.raw, kind: r.fields?.notion?.kind }));
    chk("W1 원장에서 내용 사본(블록·댓글·속성 원문)이 빠진다", r && r.raw.blocks === undefined && r.raw.comments === undefined
      && r.raw.property_items === undefined && r.raw.page.properties === undefined, JSON.stringify(r && r.raw));
    chk("W1 가림 표시 = 규칙 판 · 수집기 표식", r && r.fields._pii_scrub === SCRUB_MARK && !!r.sync_state?.seen_by?.[CLAIM], JSON.stringify(r && { f: r.fields._pii_scrub, s: r.sync_state }));
  }

  // ── W2 바인딩 없음 / piiScrub 미지정 → 종전 그대로 ──
  {
    await mirror(notionItem(`${TAG}-p2a`), null);
    await mirror(notionItem(`${TAG}-p2b`), OFF);
    const a = await kRow(`${TAG}-p2a`), b = await kRow(`${TAG}-p2b`);
    chk("W2 바인딩 없음 → 원문 그대로 · 표시 없음 · 원장 블록 있음", a && a.body_md.includes(PW) && a.fields._pii_scrub === undefined && Array.isArray(a.raw.blocks),
      JSON.stringify(a && { mark: a.fields._pii_scrub, blocks: !!a.raw.blocks }));
    chk("W2 piiScrub 미지정 수집기 → 원문 그대로 · 표시 없음", b && b.body_md.includes(PW) && b.title.includes(PHONE) && b.fields._pii_scrub === undefined,
      JSON.stringify(b && { mark: b.fields._pii_scrub }));
  }

  // ── W3 가림 켠 자료 미러 ──
  {
    await mirror(slackItem(`${TAG}.3`), ON_SLACK, SCLAIM);
    const s = await sRow(`${TAG}.3`);
    chk("W3 배선 — 자료가 적재됐다", !!s, "");
    chk("W3 ★행 어디에도 민감값이 없다(본문·보낸 사람 메일·원장)", s && leaks(s).length === 0, JSON.stringify(s && leaks(s)));
    chk("W3 보낸 사람 메일은 가리고 이름은 남긴다 · 예약 링크 토큰만 가린다", s && s.fields.author_email === M.email && s.fields.author_name === "고객"
      && s.body_md.includes(`token=${M.secret}&x=1`) && s.fields.container_name === "9999_도입문의", JSON.stringify(s && { f: s.fields, b: s.body_md }));
    chk("W3 원장 blocks 는 빠지고 ts·text(가림)는 남는다", s && s.raw.blocks === undefined && s.raw.ts === "1785377560.030869" && s.raw.text.includes(M.email), JSON.stringify(s && s.raw));
    chk("W3 자료에도 수집기 표식 · 가림 표시", s && !!s.sync_state?.seen_by?.[SCLAIM] && s.fields._pii_scrub === SCRUB_MARK, JSON.stringify(s && { s: s.sync_state, m: s.fields._pii_scrub }));
  }

  // ── W4 가리지 않은 옛 행 → 가림 켠 수집기가 다시 씀 ──
  {
    await mirror(notionItem(`${TAG}-p4`), null, CLAIM);                       // 가림 없이 쌓인 행(+이력)
    const before = await kRow(`${TAG}-p4`);
    const au0 = await audits("knowledge", before.name);
    chk("W4 전제 — 옛 행과 그 이력엔 원문이 있다", before.body_md.includes(PW) && leaks(au0).length > 0, "");
    await mirror(notionItem(`${TAG}-p4`, { body: `${notionItem("x").body}\n\n추가 메모` }), ON, CLAIM);   // 본문이 바뀐 재싱크
    const after = await kRow(`${TAG}-p4`);
    const au1 = await audits("knowledge", after.name);
    chk("W4 배선 — 갱신 이력이 하나 더 생겼다", au1.length === au0.length + 1 && au1[au1.length - 1].op === "update", JSON.stringify(au1.map((a) => a.op)));
    chk("W4 ★옛 이력(insert after)까지 가렸다 · 새 이력 before 도 가린 판", leaks(au1).length === 0, JSON.stringify(leaks(au1)));
    chk("W4 이력 행 수·op 는 그대로(지우지 않는다)", au1[0].op === "insert" && au1[0].after?.body_md?.includes(M.password), JSON.stringify(au1[0]));
    // 자료도 같다
    await mirror(slackItem(`${TAG}.4`), null, SCLAIM);
    const s0 = await sRow(`${TAG}.4`);
    await mirror(slackItem(`${TAG}.4`, { body: `${slackItem("x").body} 추가` }), ON_SLACK, SCLAIM);
    const sa = await audits("source", String(s0.id));
    chk("W4 ★자료 이력도 가렸다", sa.length === 2 && leaks(sa).length === 0, JSON.stringify({ n: sa.length, leaks: leaks(sa) }));
  }

  // ── W5 가린 결과가 같은 재싱크 → 새 이력 없음 ──
  {
    const r = await kRow(`${TAG}-p1`);
    const n0 = (await audits("knowledge", r.name)).length;
    await mirror(notionItem(`${TAG}-p1`), ON, CLAIM);
    const n1 = (await audits("knowledge", r.name)).length;
    chk("W5 노이즈 게이트 — 같은 결과면 이력이 늘지 않는다", n1 === n0, JSON.stringify({ n0, n1 }));
  }

  // ── W11 → W6 → W7 → W8 소급 스윕 ──
  {
    // 준비: 가림 없이 쌓인 내 행(지식·자료) + 같은 인스턴스의 주인 없는 행 + 남의 행 + 다른 인스턴스 + 사람이 쓴 지식
    await mirror(notionItem(`${TAG}-p6`), null, CLAIM);
    await mirror(slackItem(`${TAG}.6`), null, CLAIM);
    await itemsPool.query(
      `INSERT INTO knowledge(name, title, body_md, provenance, lifecycle, external_system, external_instance, external_id, sync_state, fields)
       VALUES($1, '버린 문서', $2, 'observed', 'archived', 'notion', $3, $4, '{"unclaimed_since":"2026-11-01T00:00:00Z"}'::jsonb, '{}'::jsonb),
             ($5, '남의 문서', $2, 'observed', 'active', 'notion', $3, $6, jsonb_build_object('seen_by', jsonb_build_object($7::text, now())), '{}'::jsonb),
             ($8, '다른 워크스페이스', $2, 'observed', 'active', 'notion', $9, $10, '{}'::jsonb, '{}'::jsonb)`,
      [`${TAG}-orphan`, `PW: ${PW}`, INST, `${TAG}-po`, `${TAG}-theirs`, `${TAG}-pt`, OTHER, `${TAG}-inst2`, INST2, `${TAG}-pi`]);
    await itemsPool.query(`INSERT INTO knowledge(name, title, body_md, provenance, lifecycle) VALUES($1, '사람이 쓴 문서', $2, 'authored', 'active')`, [`${TAG}-human`, `PW: ${PW}`]);
    const k6 = await kRow(`${TAG}-p6`);
    await itemsPool.query(`UPDATE knowledge SET embedding_model='test-model' WHERE name=$1`, [k6.name]);
    const s6 = await sRow(`${TAG}.6`);

    // W11 — 시간 상한 0
    const z = await sweepScrubBacklog(itemsPool, { claimKey: CLAIM, budgetMs: 0 });
    const k6z = await kRow(`${TAG}-p6`);
    chk("W11 시간 상한 0 → 아무것도 안 바꾸고 남은 수를 돌려준다", z.knowledge === 0 && z.source === 0 && z.stopped === "budget" && z.remaining >= 3
      && k6z.body_md.includes(PW), JSON.stringify(z));

    // W6 — 소급
    const r = await sweepScrubBacklog(itemsPool, { claimKey: CLAIM });
    const k6a = await kRow(`${TAG}-p6`), s6a = await sRow(`${TAG}.6`);
    const orphan = (await itemsPool.query(`SELECT body_md, fields FROM knowledge WHERE name=$1`, [`${TAG}-orphan`])).rows[0];
    chk("W6 배선 — 스윕이 지식·자료를 가렸다고 보고한다", r.knowledge >= 2 && r.source >= 1 && r.stopped === "done", JSON.stringify(r));
    chk("W6 ★내 지식 행 — 민감값 없음 · 표시 · 원장 줄임", leaks(k6a).length === 0 && k6a.fields._pii_scrub === SCRUB_MARK && k6a.raw.blocks === undefined
      && k6a.raw.page.last_edited_time === "2026-11-01T00:00:00.000Z", JSON.stringify(leaks(k6a)));
    chk("W6 지식 — 본문이 바뀌었으니 임베딩을 비우고 판·updated_at 을 올린다", k6a.embedding_model === null && k6a.version > k6.version && k6a.updated_at > k6.updated_at,
      JSON.stringify({ em: k6a.embedding_model, v0: k6.version, v1: k6a.version }));
    chk("W6 ★지식 이력도 가렸다", leaks(await audits("knowledge", k6a.name)).length === 0, "");
    chk("W6 ★내 자료 행 — 민감값 없음 · 표시 · 이력 가림", leaks(s6a).length === 0 && s6a.fields._pii_scrub === SCRUB_MARK
      && leaks(await audits("source", String(s6a.id))).length === 0, JSON.stringify(leaks(s6a)));
    chk("W6 자료 updated_at 은 그대로(증류 인박스를 다시 돌리지 않는다)", s6a.updated_at === s6.updated_at, JSON.stringify({ a: s6.updated_at, b: s6a.updated_at }));
    chk("W6 같은 인스턴스의 주인 없는 행(수집 제외로 풀린 옛 행)도 가린다", orphan && !orphan.body_md.includes(PW) && orphan.fields._pii_scrub === SCRUB_MARK, JSON.stringify(orphan));

    // W7 — 그대로여야 하는 것
    const theirs = (await itemsPool.query(`SELECT body_md FROM knowledge WHERE name=$1`, [`${TAG}-theirs`])).rows[0];
    const inst2 = (await itemsPool.query(`SELECT body_md FROM knowledge WHERE name=$1`, [`${TAG}-inst2`])).rows[0];
    const human = (await itemsPool.query(`SELECT body_md FROM knowledge WHERE name=$1`, [`${TAG}-human`])).rows[0];
    chk("W7 ★다른 수집기가 맡은 행은 그대로", theirs.body_md.includes(PW), theirs.body_md);
    chk("W7 ★다른 인스턴스의 행은 그대로", inst2.body_md.includes(PW), inst2.body_md);
    chk("W7 ★사람이 쓴 지식은 그대로", human.body_md.includes(PW), human.body_md);

    // W8 — 다시 돌리면 0건 · 쓰기 없음
    const r2 = await sweepScrubBacklog(itemsPool, { claimKey: CLAIM });
    const k6b = await kRow(`${TAG}-p6`);
    chk("W8 재실행 → 0건 · 남은 것 0 · 행 그대로", r2.knowledge === 0 && r2.source === 0 && r2.remaining === 0 && k6b.version === k6a.version && k6b.updated_at === k6a.updated_at,
      JSON.stringify(r2));
  }

  // ── W9 클릭업 작업(되쓰는 미러)은 가리지 않는다 ──
  {
    const it = {
      type: "task", level: "project",
      provenance: { category: "pm", system: "clickup", instance: INST, external_id: `${TAG}-t9`, external_url: "https://app.clickup.com/t/x" },
      title: `고객 ${PHONE}`, body: `담당 ${MAIL} / PW: ${PW}`,
      occurred_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
      fields: { status: "open", status_category: "unstarted" }, raw: { id: `${TAG}-t9` },
    };
    await mirror(it, { ...ON, presetKey: "clickup" }, `clickup:${TAG}`);
    const p = (await itemsPool.query(`SELECT name, description, fields FROM project WHERE external_system='clickup' AND external_instance=$1 AND external_id=$2`, [INST, `${TAG}-t9`])).rows[0];
    chk("W9 ★클릭업 작업 설명은 원문 그대로(가린 설명이 원본을 덮지 않게)", p && p.description.includes(PW) && p.name.includes(PHONE) && p.fields._pii_scrub === undefined,
      JSON.stringify(p && { d: p.description }));
  }

  // ── W12 표식이 한 번도 없던 옛 자료 ──
  {
    const ins = await itemsPool.query(
      `INSERT INTO source(kind, title, body_md, fields, provenance, external_system, external_instance, external_id, sync_state)
       VALUES('other', '옛 메시지', $1, '{}'::jsonb, 'observed', $2, $3, $4, '{}'::jsonb) RETURNING id, updated_at::text AS updated_at`,
      [`고객 ${MAIL} ${PHONE}`, LEGACY_SYS, INST3, `${TAG}-legacy`]);
    const id = ins.rows[0].id;
    const claim = `${LEGACY_SYS}:${TAG}`;              // 이 수집기는 아직 아무 행에도 표식을 안 남겼다(조용한 채널)
    const a = await sweepScrubBacklog(itemsPool, { claimKey: claim });
    const s0 = (await itemsPool.query(`SELECT body_md FROM source WHERE id=$1`, [id])).rows[0];
    chk("W12 legacySystem 없이는 그대로(누구 것인지 모르는 옛 행)", a.source === 0 && s0.body_md.includes(MAIL), JSON.stringify(a));
    const b = await sweepScrubBacklog(itemsPool, { claimKey: claim, legacySystem: LEGACY_SYS });
    const s1 = (await itemsPool.query(`SELECT body_md, fields, updated_at::text AS updated_at FROM source WHERE id=$1`, [id])).rows[0];
    chk("W12 ★legacySystem 을 주면 새 글이 없어도 옛 자료를 가린다(updated_at 그대로)", b.source === 1 && leaks(s1).length === 0
      && s1.fields._pii_scrub === SCRUB_MARK && s1.updated_at === ins.rows[0].updated_at, JSON.stringify({ b, leaks: leaks(s1) }));
  }

  // ── W13 메일함 수집(지메일 꼴) — 신원층(person)까지 보려면 적재 입구(ingestItems)로 넣어야 한다(미러 직행은 신원 해소를 안 탄다) ──
  {
    const MAIL2 = "lee.ctrl@example-test.io";
    const gmailItem = (id, from) => ({
      type: "message",
      provenance: { category: "messenger", system: "gmail", instance: INST, external_id: id, external_url: "https://mail.google.com/mail/u/0/#all/x" },
      actor: { external_id: from, display_name: "고객", email: from },
      title: "문의", body: "본문", occurred_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z", fields: {}, raw: { id },
    });
    //  대조군 — 가림을 끈 적재는 보낸 사람을 신원층에 남긴다(관측 장치가 살아 있는지: 아니면 아래 «0건» 은 아무것도 안 본 것이다)
    await ingestItems([gmailItem(`${TAG}-g0`, MAIL2)], { claimKey: `gmail:${TAG}` });
    const ctrl = (await itemsPool.query(`SELECT count(*)::int AS n FROM person_identity WHERE system='gmail' AND (external_id=$1 OR email=$1)`, [MAIL2])).rows[0].n;
    chk("W13 배선 — 가림을 끈 적재는 보낸 사람을 신원층에 남긴다(대조군)", ctrl === 1, `person_identity ${ctrl}건`);
    const it = {
      type: "message",
      provenance: { category: "messenger", system: "gmail", instance: INST, external_id: `${TAG}-g1`, external_url: "https://mail.google.com/mail/u/0/#all/x" },
      actor: { external_id: MAIL, display_name: "고객 김", email: MAIL },
      title: "견적 문의", body: `안녕하세요. 연락처 ${PHONE} 입니다.`,
      occurred_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
      fields: { threadId: "t1", labelIds: ["INBOX"], snippet: `연락처 ${PHONE}` },
      raw: { id: `${TAG}-g1`, threadId: "t1", labelIds: ["INBOX"], snippet: `연락처 ${PHONE}`,
             payload: { headers: [{ name: "From", value: MAIL }], parts: [{ body: { data: Buffer.from(`PW: ${PW}`).toString("base64url") } }] } },
    };
    await withCollector({ ...ON, presetKey: "gmail" }, () => ingestItems([it], { claimKey: `gmail:${TAG}` }));
    const r = (await itemsPool.query(`SELECT body_md, fields, raw FROM source WHERE external_system='gmail' AND external_instance=$1 AND external_id=$2`, [INST, `${TAG}-g1`])).rows[0];
    const b64 = Buffer.from(`PW: ${PW}`).toString("base64url");
    const person = (await itemsPool.query(`SELECT count(*)::int AS n FROM person_identity WHERE system='gmail' AND (external_id=$1 OR email=$1)`, [MAIL])).rows[0].n;
    chk("W13 배선 — 메일이 자료로 적재됐다", !!r, "");
    chk("W13 ★원장 payload(머리·base64 본문)가 없다", r && r.raw.payload === undefined && !JSON.stringify(r).includes(b64), JSON.stringify(r && r.raw));
    chk("W13 ★보낸 사람 id·메일을 가리고 이름은 남긴다 · 행 어디에도 민감값 없음", r && r.fields.author_external_id === M.email && r.fields.author_email === M.email
      && r.fields.author_name === "고객 김" && leaks(r).length === 0, JSON.stringify(r && { f: r.fields, leaks: leaks(r) }));
    chk("W13 ★person 신원층에 고객 메일이 남지 않는다", person === 0, `person_identity ${person}건`);
  }

  // ── W14 클릭업 수집기에 가림 켜기 → 거절 ──
  {
    let err = null;
    try { await upsertCollector({ preset_key: "clickup", key: `${TAG}-cu`, instance_key: `${TAG}-cu`, enabled: false, pii_scrub: true }, "test", "test"); }
    catch (e) { err = String(e?.message ?? e); }
    const made = (await itemsPool.query(`SELECT count(*)::int AS n FROM org_collector WHERE key=$1`, [`${TAG}-cu`])).rows[0].n;
    chk("W14 ★클릭업에 가림을 켜면 거절되고 수집기도 안 생긴다", !!err && made === 0, JSON.stringify({ err, made }));
  }

  // ── W10 수집기 저장 ──
  {
    const c1 = await upsertCollector({ preset_key: "notion", key: `${TAG}-c`, instance_key: `${TAG}-c`, enabled: false, pii_scrub: true }, "test", "test");
    const c2 = await upsertCollector({ id: c1.id, output_config: { target_category: "x" } }, "test", "test");
    const c3 = await upsertCollector({ id: c1.id, label: "이름만" }, "test", "test");
    const c4 = await upsertCollector({ id: c1.id, pii_scrub: false }, "test", "test");
    const listed = (await listCollectors()).find((c) => c.id === c1.id);
    chk("W10 켜서 만든다", c1.pii_scrub === true, JSON.stringify(c1.pii_scrub));
    chk("W10 ★output_config 만 바꿔도 가림은 켜진 채", c2.pii_scrub === true && c2.output_config?.target_category === "x", JSON.stringify(c2.pii_scrub));
    chk("W10 다른 칸만 바꿔도 켜진 채(미전송 = 유지)", c3.pii_scrub === true, JSON.stringify(c3.pii_scrub));
    chk("W10 끄면 꺼진다 · 목록도 같다", c4.pii_scrub === false && listed?.pii_scrub === false, JSON.stringify({ c4: c4.pii_scrub, l: listed?.pii_scrub }));
  }
} catch (e) {
  bad("예외", e?.stack ?? String(e));
} finally {
  await cleanup().catch((e) => bad("정리", String(e)));
  await itemsPool.end();
}
console.log(`\nmirror-scrub pg: ${pass} ok · ${fail} fail`);
process.exit(fail ? 1 : 0);
