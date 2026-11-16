// domain-wiki «경로 식별 모드» 의 라우팅(#1670) PG 통합 테스트 — 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 services:postgres 잡에서(스키마 체인 스텝 뒤), 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/v6/mirror/domain-wiki-path.pg-test.mjs
//
//  왜 이 계층인가: 경로 모드의 핵심 보장은 «같은 이름의 남의 지식(사람이 쓴 것)을 덮지 않는다» 다. 슬러그 모드는 이름 키
//   upsert(ON CONFLICT (tenant_id, name))라 같은 이름이면 덮고 provenance 를 observed 로 바꾼다 — 경로 모드 항목은 그 길을
//   타면 안 되고 외부 좌표 upsert 로 가야 한다(connector-mirror isDomainWikiSlugItem). 갈림은 fields.domain_wiki.id_mode
//   한 칸이라, 그 키 이름이 바뀌거나 판정이 깨지면 조용히 종전 길로 샌다. 실제 행을 깔고 mirrorExternalToV6 를 부른 뒤 다시 읽는다.
//  모든 행은 이 시험만의 external_instance 와 이름 접두(`dwpg-`)에 둔다.
//
//  사양 엣지 표(행마다 단언):
//   C1 사람이 쓴 지식 X 가 있고 경로 모드 항목의 이름 제안이 X → 적재 실패(예외) · X 의 본문 · provenance · 판 · 좌표 그대로
//   C2 경로 모드 항목 신규(이름 제안 Y) → 이름 Y · external_id = 경로 · observed · domain-wiki 좌표
//   C3 C2 재싱크 — 이름 제안을 바꿔 보내고 본문도 바꿈 → 같은 행 하나 · 이름 Y 그대로 · 본문 바뀜
//   C4 슬러그 모드 항목(id_mode 없음) · 같은 이름의 외부 좌표 없는 기존 행 Z → Z 를 채택(본문 갱신 · 좌표 부여) — 종전 동작
//   C5 id_mode = slug 명시 → C4 와 같음
//  (C6 판정이 깨지면 C1 · C2 가 빨강 — 판정을 «늘 슬러그» 로 바꾼 변이로 확인했다.)
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { mirrorExternalToV6 } = await import(`${DIST}/v6/connector-mirror.js`);

delete process.env.ANTHROPIC_API_KEY; // 신규 적재 분류기(LLM) 호출 금지 — 정책 축만

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const P = "dwpg-";
const INST = "dwpg-inst";
const HUMAN = `${P}human`, PATH_NAME = `${P}docs-b-0123456789`, SLUG_Z = `${P}slug-z`, SLUG_Z2 = `${P}slug-z2`;

const pathItem = (rel, nameHint, body = "본문 경로") => ({
  type: "doc",
  provenance: { category: "vcs", system: "domain-wiki", instance: INST, external_id: rel, external_url: `https://git.example.com/wiki/-/blob/main/${rel}` },
  title: rel, body, occurred_at: "2026-11-01T00:00:00.000Z",
  fields: { domain_wiki: { relpath: rel, id_mode: "path" } },
  name_hint: nameHint, path: rel,
});
const slugItem = (slug, idMode, body = "본문 슬러그") => ({
  type: "doc",
  provenance: { category: "vcs", system: "domain-wiki", instance: INST, external_id: slug, external_url: `https://git.example.com/wiki/-/blob/main/${slug}.md` },
  title: slug, body, occurred_at: "2026-11-01T00:00:00.000Z",
  fields: idMode ? { domain_wiki: { relpath: `${slug}.md`, id_mode: idMode } } : { domain_wiki: { relpath: `${slug}.md` } },
});
async function mirror(it) {
  const c = await itemsPool.connect();
  try { return await mirrorExternalToV6(c, it); } finally { c.release(); }
}
const attempt = async (fn) => { try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, msg: String(e?.message ?? e) }; } };
const byName = async (name) => (await itemsPool.query(
  `SELECT name, title, body_md, version, provenance, external_system, external_instance, external_id FROM knowledge WHERE name=$1`, [name])).rows[0];
const byExt = async (rel) => (await itemsPool.query(
  `SELECT name, body_md, provenance, external_system, external_id FROM knowledge
    WHERE external_system='domain-wiki' AND external_instance=$1 AND external_id=$2`, [INST, rel])).rows;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function cleanup() {
  const names = (await itemsPool.query(
    `SELECT name FROM knowledge WHERE left(name, $2) = $1 OR external_instance = $3`, [P, P.length, INST])).rows.map((r) => r.name);
  if (names.length) await itemsPool.query(`DELETE FROM org_content_audit WHERE entity='knowledge' AND entity_key = ANY($1::text[])`, [names]);
  if (names.length) await itemsPool.query(`DELETE FROM knowledge WHERE name = ANY($1::text[])`, [names]);
}
const human = (name) => itemsPool.query(
  `INSERT INTO knowledge(name, title, body_md, injection, provenance, lifecycle, confidence, source, visibility)
   VALUES($1, '사람 문서', '사람이 쓴 본문', 'recalled', 'authored', 'active', 'human', 'authored', 'open')`, [name]);

try {
  await cleanup();
  // C1
  await human(HUMAN);
  const before = await byName(HUMAN);
  const c1 = await attempt(() => mirror(pathItem("Docs/a.md", HUMAN)));
  chk("C1 이름 제안이 사람 지식과 같으면 적재 실패", !c1.ok, JSON.stringify(c1));
  chk("C1 사람 지식 그대로(본문 · provenance · 판 · 좌표)", same(await byName(HUMAN), before), JSON.stringify(await byName(HUMAN)));
  chk("C1 그 경로로 들어간 행 없음", (await byExt("Docs/a.md")).length === 0, JSON.stringify(await byExt("Docs/a.md")));
  // C2
  const c2 = await attempt(() => mirror(pathItem("Docs/b.md", PATH_NAME)));
  const r2 = await byExt("Docs/b.md");
  chk("C2 경로 모드 신규 적재", c2.ok && c2.v === true, JSON.stringify(c2));
  chk("C2 이름 = 이름 제안 · external_id = 경로 · observed", r2.length === 1 && r2[0].name === PATH_NAME && r2[0].provenance === "observed", JSON.stringify(r2));
  // C3
  const c3 = await attempt(() => mirror(pathItem("Docs/b.md", `${P}other-name`, "본문 경로 2")));
  const r3 = await byExt("Docs/b.md");
  chk("C3 재싱크 성공", c3.ok, JSON.stringify(c3));
  chk("C3 같은 행 하나 · 이름 그대로 · 본문 바뀜", r3.length === 1 && r3[0].name === PATH_NAME && r3[0].body_md === "본문 경로 2", JSON.stringify(r3));
  chk("C3 바꿔 보낸 이름의 행은 없음", !(await byName(`${P}other-name`)));
  // C4 · C5 — 슬러그 모드는 종전처럼 같은 이름의 좌표 없는 행을 채택한다
  for (const [label, name, idMode] of [["C4 id_mode 없음", SLUG_Z, undefined], ["C5 id_mode=slug", SLUG_Z2, "slug"]]) {
    await human(name);
    const r = await attempt(() => mirror(slugItem(name, idMode)));
    const row = await byName(name);
    chk(`${label} 적재 성공`, r.ok, JSON.stringify(r));
    chk(`${label} 같은 이름의 행을 채택 — 본문 갱신 · 좌표 부여 · observed`,
      row?.body_md === "본문 슬러그" && row.external_system === "domain-wiki" && row.external_id === name && row.provenance === "observed",
      JSON.stringify(row));
  }
} catch (e) {
  fail++; console.error("FAIL 예외 —", e);
} finally {
  try { await cleanup(); } catch (e) { console.error("정리 실패:", e?.message ?? e); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await itemsPool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}
