// 사람에게 묻지 않는 형식 정리의 저장 경로 — 홈 경로 정리를 실제 Postgres 로 본다.
//  CI 의 pg-test 잡에서, 또는 로컬에서 수동 실행:
//    node --max-old-space-size=1600 node_modules/typescript/bin/tsc -p tsconfig.json && ITEMS_DATABASE_URL=... node src/capabilities/knowledge/style-resolve.pg-test.mjs
//
//  사양 엣지 표(행마다 단언):
//   S1 에이전트 저장의 개인 홈 경로(/Users/<계정>/)는 $HOME 으로 저장되고 ~/ 는 그대로다 · 사람의 웹 저장은 쓴 그대로
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { knowledgeSave } = await import(`${DIST}/capabilities/knowledge/authoring.js`);
//  형식 조회는 워크스페이스별로 캐시된다(runtime-config getWritingFormat) — DB 를 직접 고친 뒤엔 비워야 새 형식이 보인다.
const { invalidateWritingFormatCache } = await import(`${DIST}/org/store/runtime-config.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const P = "srpg-";
const AGENT = "__srpg__agent";
const CAT = "srpg-cat";
const LIMIT = 8000;

const mcp = { actor: AGENT, source: "mcp", viewer: AGENT };
const save = (input) => knowledgeSave.handler(input, { userId: AGENT }, mcp);
const saveHuman = (input) => knowledgeSave.handler(input, { userId: AGENT, tokenSource: "session" }, { actor: AGENT, source: "web", viewer: AGENT });
const attempt = async (fn) => {
  try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, status: e?.status, msg: String(e?.message ?? e) }; }
};
const rowOf = async (name) => (await itemsPool.query(
  `SELECT name, title, body_md, version, visibility, lifecycle, parent_name FROM knowledge WHERE name=$1`, [name])).rows[0];
async function cleanup() {
  await itemsPool.query(`DELETE FROM org_content_audit WHERE entity='knowledge' AND left(entity_key, $2) = $1`, [P, P.length]);
  await itemsPool.query(`DELETE FROM knowledge_category WHERE left(name, $2) = $1`, [P, P.length]);
  await itemsPool.query(`DELETE FROM knowledge WHERE left(name, $2) = $1`, [P, P.length]);
}

let prevFormat = null;
try {
  await (await import(`${DIST}/boot/schemas.js`)).initAllSchemas();
  await cleanup();
  await itemsPool.query(`INSERT INTO category(key, name) VALUES($1,$1) ON CONFLICT DO NOTHING`, [CAT]);
  // 조직 형식 — 서술 형식을 켜고 본문 길이를 거부 규칙으로 둔다. 끝나면 되돌린다.
  if (!(await itemsPool.query(`SELECT 1 FROM org_runtime_config WHERE id=1`)).rowCount) await itemsPool.query(`INSERT INTO org_runtime_config(id) VALUES(1)`);
  prevFormat = (await itemsPool.query(`SELECT writing_format FROM org_runtime_config WHERE id=1`)).rows[0]?.writing_format ?? null;
  await itemsPool.query(`UPDATE org_runtime_config SET writing_format=$1 WHERE id=1`,
    [JSON.stringify({ enabled: true, rules: { body_length: "reject" }, limits: { body_max_chars: LIMIT } })]); invalidateWritingFormatCache();

  // ── S1 홈 경로 ──
  {
    const body = "로컬 스크립트 위치를 적는다.\n\n`/Users/someone/work/run.sh` 와 ~/work/notes 를 쓴다.";
    await save({ name: `${P}paths`, title: "로컬 스크립트 위치", body_md: body, category: CAT, type: "reference" });
    const r = await rowOf(`${P}paths`);
    //  ~/ 는 바꾸지 않는다 — 탐지가 위반으로 보지 않는 관례 표기다(writing-resolve 홈 경로 머리말).
    chk("S1 에이전트 저장의 홈 경로는 $HOME 으로 바뀌고 ~/ 는 그대로다", r.body_md.includes("`$HOME/work/run.sh`") && r.body_md.includes("~/work/notes") && !r.body_md.includes("/Users/someone"), r.body_md);
    await saveHuman({ name: `${P}paths-human`, title: "로컬 스크립트 위치", body_md: body, category: CAT, type: "reference" });
    chk("S1 사람의 웹 저장은 쓴 그대로다", (await rowOf(`${P}paths-human`)).body_md === body);
    const r1 = await save({ name: `${P}paths-2`, title: "로컬 스크립트 위치", body_md: body, category: CAT, type: "reference" });
    chk("S1 응답 home_paths 에 바꾼 건수가 실린다", r1.home_paths?.replaced === 1, JSON.stringify(r1.home_paths));
    await itemsPool.query(`UPDATE knowledge SET body_md = $2 WHERE name=$1`, [`${P}paths-2`, "기존 줄은 /Users/old/keep.sh 다."]);
    await save({ name: `${P}paths-2`, mode: "append", body_md: "새 줄은 /Users/new/add.sh 다." });
    const ap = (await rowOf(`${P}paths-2`)).body_md;
    chk("S1 append 는 보낸 조각만 바꾸고 기존 본문은 그대로 둔다", ap.includes("/Users/old/keep.sh") && ap.includes("$HOME/add.sh"), ap);
    const prev = (await itemsPool.query(`SELECT writing_format FROM org_runtime_config WHERE id=1`)).rows[0].writing_format;
    await itemsPool.query(`UPDATE org_runtime_config SET writing_format=$1 WHERE id=1`, [JSON.stringify({ ...prev, rules: { ...(prev.rules ?? {}), local_path: "off" } })]); invalidateWritingFormatCache();
    await save({ name: `${P}paths-off`, title: "로컬 스크립트 위치", body_md: body, category: CAT, type: "reference" });
    await itemsPool.query(`UPDATE org_runtime_config SET writing_format=$1 WHERE id=1`, [JSON.stringify(prev)]); invalidateWritingFormatCache();
    chk("S1 조직이 local_path 규칙을 끄면 바꾸지 않는다", (await rowOf(`${P}paths-off`)).body_md === body);
  }

  // ── S2 치환 범위 — 이번 저장이 바꾼 줄만, 펜스·관찰 기록·주입 문서·계정 둘은 그대로, 응답은 저장된 꼴을 알린다 ──
  {
    const ADMIN = { userId: AGENT, scopes: ["items", "context", "db", "memory", "code", "admin"] };
    // S2a replace 는 전문을 다시 보내지만, 원문에 있던 줄(사람이 쓴 경로)은 이번 저장이 쓴 글이 아니다 — 새로 생긴 줄만 바꾼다.
    const humanBody = "로컬 스크립트 위치를 적는다.\n\n옛 줄은 /Users/alice/old.sh 다.";
    await saveHuman({ name: `${P}s2-replace`, title: "로컬 스크립트 위치", body_md: humanBody, category: CAT, type: "reference" });
    await save({ name: `${P}s2-replace`, body_md: `${humanBody}\n\n새 줄은 /Users/alice/new.sh 다.` });
    const a = (await rowOf(`${P}s2-replace`)).body_md;
    chk("S2a replace 는 원문에 있던 줄의 경로를 그대로 두고 새 줄만 바꾼다", a.includes("/Users/alice/old.sh") && a.includes("$HOME/new.sh"), a);
    // S2b edit 는 바꾼 글만 바꾼다(손대지 않은 줄의 경로는 그대로).
    await save({ name: `${P}s2-replace`, mode: "edit", edits: [{ old: "새 줄은 $HOME/new.sh 다.", new: "새 줄은 /Users/alice/newer.sh 다." }] });
    const b = (await rowOf(`${P}s2-replace`)).body_md;
    chk("S2b edit 는 바꾼 글의 경로만 바꾼다", b.includes("/Users/alice/old.sh") && b.includes("$HOME/newer.sh"), b);
    // S2c 형식 정리 저장(style_fix)은 손대지 않은 줄의 경로도 함께 바꾼다(에이전트 본인의 마지막 저장이라 보호 창에 안 걸린다).
    const v = (await rowOf(`${P}s2-replace`)).version;
    await save({ name: `${P}s2-replace`, mode: "edit", style_fix: true, expected_version: Number(v), edits: [{ old: "로컬 스크립트 위치를 적는다.", new: "로컬 스크립트 위치를 적는다(형식 정리)." }] }).catch((e) => bad("S2c 저장", e?.message));
    const c = (await rowOf(`${P}s2-replace`)).body_md;
    chk("S2c style_fix 는 원문에 있던 줄의 경로도 바꾼다", !c.includes("/Users/alice/") && c.includes("$HOME/old.sh"), c);

    // S2d 펜스 안 경로는 글자 그대로다(로그·설정 파일·PowerShell) — 사람 확인 항목으로 남는다.
    const fencedBody = "실행 명령을 적는다.\n\n```\ncat /Users/bob/app.conf\n```";
    const rd = await save({ name: `${P}s2-fence`, title: "실행 명령", body_md: fencedBody, category: CAT, type: "reference" });
    chk("S2d 펜스 안 경로는 바꾸지 않는다", (await rowOf(`${P}s2-fence`)).body_md === fencedBody, (await rowOf(`${P}s2-fence`)).body_md);
    const lp = rd.style?.findings?.find((f) => f.rule === "local_path");
    chk("S2d 펜스 안 경로는 사람 확인(ask_human)으로 남는다", lp?.ask_human === true, JSON.stringify(rd.style?.findings));

    // S2e 계정이 둘이면 다른 사람 경로가 같은 $HOME 으로 합쳐지므로 바꾸지 않는다.
    const twoBody = "복사 경로를 적는다.\n\n/Users/alice/data/a.csv 에서 /Users/bob/data/a.csv 로 복사한다.";
    const re = await save({ name: `${P}s2-two`, title: "복사 경로", body_md: twoBody, category: CAT, type: "reference" });
    chk("S2e 계정이 둘이면 바꾸지 않는다", (await rowOf(`${P}s2-two`)).body_md === twoBody && !re.home_paths, (await rowOf(`${P}s2-two`)).body_md);

    // S2f 외부 관찰 기록(저장된 provenance)은 쓴 그대로 둔다.
    await save({ name: `${P}s2-obs`, title: "관찰 기록", body_md: "관찰 기록이다.", category: CAT, type: "reference" });
    await itemsPool.query(`UPDATE knowledge SET provenance='observed' WHERE name=$1`, [`${P}s2-obs`]);
    const obsBody = "관찰 기록이다.\n\n경로는 /Users/bob/x/a.txt 다.";
    await save({ name: `${P}s2-obs`, body_md: obsBody }).catch((e) => bad("S2f 저장", e?.message));
    chk("S2f 관찰 기록은 바꾸지 않는다", (await rowOf(`${P}s2-obs`)).body_md === obsBody, (await rowOf(`${P}s2-obs`)).body_md);

    // S2g 항상 주입 문서는 서버가 고쳐 쓰지 않는다(#1680 결정 — 재작성 대상에서 뺀다). 관리자 에이전트의 저장도 그대로다.
    await save({ name: `${P}s2-inj`, title: "주입 규칙", body_md: "주입 규칙이다.", category: CAT, type: "reference" });
    await itemsPool.query(`UPDATE knowledge SET injection='always' WHERE name=$1`, [`${P}s2-inj`]);
    const injBody = "주입 규칙이다.\n\n경로는 /Users/bob/x/a.txt 다.";
    await knowledgeSave.handler({ name: `${P}s2-inj`, body_md: injBody }, ADMIN, mcp).catch((e) => bad("S2g 저장", e?.message));
    chk("S2g 항상 주입 문서는 바꾸지 않는다", (await rowOf(`${P}s2-inj`)).body_md === injBody, (await rowOf(`${P}s2-inj`)).body_md);

    // S2h 응답이 «저장된 글이 보낸 글과 다르다» 와 이후 edit 의 old 에 쓸 꼴을 알린다.
    const rh = await save({ name: `${P}s2-note`, title: "로컬 스크립트 위치", body_md: "로컬 스크립트를 적는다.\n\n/Users/bob/work/run.sh 를 쓴다.", category: CAT, type: "reference" });
    chk("S2h home_paths 가 이후 edit 의 old 에 저장된 꼴을 쓰라고 알린다", /old/.test(rh.home_paths?.note ?? "") && /\$HOME/.test(rh.home_paths?.note ?? ""), JSON.stringify(rh.home_paths));
  }
} catch (e) {
  bad("실행", e?.stack ?? String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.query(`UPDATE org_runtime_config SET writing_format=$1 WHERE id=1`, [prevFormat == null ? null : JSON.stringify(prevFormat)]).catch(() => {}); invalidateWritingFormatCache();
  await itemsPool.end().catch(() => {});
}
console.log(`style-resolve pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
