// 사람에게 묻지 않는 형식 정리의 저장 경로 — 기준 날짜(감사 기록)·홈 경로 정리·본문 길이 자동 분리를 실제 Postgres 로 본다.
//  CI 의 pg-test 잡에서, 또는 로컬에서 수동 실행:
//    node --max-old-space-size=1600 node_modules/typescript/bin/tsc -p tsconfig.json && ITEMS_DATABASE_URL=... node src/capabilities/knowledge/style-resolve.pg-test.mjs
//
//  사양 엣지 표(행마다 단언):
//   S1 에이전트 저장의 개인 홈 경로(/Users/<계정>/)는 $HOME 으로 저장되고 ~/ 는 그대로다 · 사람의 웹 저장은 쓴 그대로
//   S2 상한을 넘는 append(표 행을 쌓는 원장) → 거부 없이 저장, 행은 하위 지식으로 원문 그대로 옮겨지고 원래 지식엔 표 머리와 링크가 남는다
//   S3 S2 뒤 다음 append 행은 머리 있는 표에 붙는다 · 응답 split 에 하위 지식이 실린다
//   S4 상한을 넘는 신규 저장(절 여러 개) → 이력류 절이 먼저 옮겨지고 원래 지식은 상한 안
//   S5b 검토 대기 초안·보관된 지식·자료에서 증류된 지식·검색 제외 지식은 나누지 않는다(하위 지식 0건) · 직접 나누는 절차 대신 사람 확인을 안내한다
//   S5d 분리 하위 지식은 새로 만들 때만 저장한다 — 같은 이름이 이미 있으면 409, 기존 지식은 그대로
//   S5c 하위 지식 저장이 중간에 실패하면 이번 호출이 만든 하위 지식을 지우고 원래 지식은 그대로다
//   S5 원문 그대로 나눌 계획이 서지 않으면 거부(422)하고 메시지가 자동 분리 실패 사유와 절차를 싣는다 · 행 그대로
//   S6 읽기: 이미 있던 상태 서술 줄의 기준 날짜는 그 줄이 처음 저장된 판의 날이다
//   S7 그 기준 날짜를 적는 style_fix 저장은 통과하고, 다른 날짜를 적으면 422
//   S7b 굵게만 벗긴 style_fix 뒤에도 그 줄의 기준 날짜는 처음 판의 날이고, 형식 정리한 날을 적으면 422
//   S8 저장 응답의 시점 위반에 기준 날짜(anchors)와 고치는 법(fix)이 실리고 ask_human 은 없다(기준 날짜를 찾았으므로)
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { knowledgeSave } = await import(`${DIST}/capabilities/knowledge/authoring.js`);
const { knowledgeGet } = await import(`${DIST}/capabilities/knowledge/read.js`);
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
const cp = (s) => [...String(s ?? "")].length;
const lineBag = (texts) => {
  const m = new Map();
  for (const t of texts) for (const l of String(t).split("\n")) { const k = l.trim(); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
};
const covers = (orig, texts) => {
  const have = lineBag(texts);
  for (const [k, n] of lineBag([orig])) if ((have.get(k) ?? 0) < n) return k;
  return null;
};

async function cleanup() {
  await itemsPool.query(`DELETE FROM org_content_audit WHERE entity='knowledge' AND left(entity_key, $2) = $1`, [P, P.length]);
  await itemsPool.query(`DELETE FROM knowledge_category WHERE left(name, $2) = $1`, [P, P.length]);
  await itemsPool.query(`DELETE FROM knowledge WHERE left(name, $2) = $1`, [P, P.length]);
}

const row = (i) => `| 2026-11-${String((i % 28) + 1).padStart(2, "0")} | repo-${i} | src/main/${"x".repeat(40)}-${i}.kt | cochange-rule-${i} | non-blocking |`;
const LEDGER_HEAD = [
  "규칙이 발동할 때마다 한 행씩 쌓는 관측 로그다.",
  "",
  "## 기록 방식",
  "",
  "리뷰에서 규칙이 발동하면 아래 표에 한 행을 덧붙인다.",
  "",
  "## 발동 로그",
  "",
  "| date | repo | trigger | rule | verdict |",
  "|---|---|---|---|---|",
];

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

  // ── S2·S3 원장 append ──
  {
    const name = `${P}ledger`;
    let rows = [];
    let i = 0;
    while (cp([...LEDGER_HEAD, ...rows].join("\n")) < LIMIT - 300) rows.push(row(i++));
    const plain = [...LEDGER_HEAD, ...rows].join("\n");
    await save({ name, title: "규칙 발동 관측 로그", body_md: plain, category: CAT, type: "reference" });
    // 홈 경로가 든 기존 행 — 에이전트 저장을 거치지 않은 옛 본문이라 DB 에 직접 둔다.
    const seed = plain.replace("src/main/", "/Users/legacy/src/main/");
    await itemsPool.query(`UPDATE knowledge SET body_md=$2 WHERE name=$1`, [name, seed]);
    const beforeLen = cp((await rowOf(name)).body_md);
    const fragment = [row(i++), row(i++), row(i++), row(i++), row(i++)].join("\n");
    const r = await attempt(() => save({ name, mode: "append", body_md: fragment }));
    chk("S2 상한을 넘는 append 가 거부되지 않는다", r.ok, r.msg);
    const parent = await rowOf(name);
    const children = (await itemsPool.query(`SELECT name, body_md, lifecycle, visibility, parent_name, title FROM knowledge WHERE parent_name=$1 ORDER BY name`, [name])).rows;
    chk("S2 하위 지식이 생겼고 원래 지식 아래·공개·활성이다", children.length >= 1 && children.every((c) => c.lifecycle === "active" && c.visibility === "open" && c.parent_name === name),
      JSON.stringify(children.map((c) => [c.name, c.lifecycle, c.visibility, c.parent_name])));
    chk("S2 원래 지식은 상한 안이다", cp(parent.body_md) <= LIMIT, `${cp(parent.body_md)}자 (전 ${beforeLen})`);
    const lost = covers([seed, fragment].join("\n"), [parent.body_md, ...children.map((c) => c.body_md)]);
    chk("S2 무손실 — 원래 본문과 덧붙인 행이 원래 지식과 하위 지식 어딘가에 그대로 있다", lost == null, `빠진 줄: ${lost}`);
    chk("S2 옮긴 기존 행의 홈 경로는 글자 그대로다(이번 저장이 보내지 않은 글)", children.some((c) => c.body_md.includes("/Users/legacy/src/main/")), "");
    chk("S2 원래 지식엔 표 머리와 하위 지식 링크가 남는다",
      parent.body_md.trimEnd().endsWith("|---|---|---|---|---|") && children.every((c) => parent.body_md.includes(`[[${c.name}]]`)), parent.body_md.slice(-400));
    chk("S2 하위 지식 제목은 형식 규칙을 지킨다(60자·날짜 없음)", children.every((c) => cp(c.title) <= 60 && !/20\d{2}-\d{2}/.test(c.title)), JSON.stringify(children.map((c) => c.title)));
    chk("S2 한 절이 여러 조각이면 제목에 순번이 붙는다", children.length < 2 || children.every((c) => /절 \d+$/.test(c.title)), JSON.stringify(children.map((c) => c.title)));
    chk("S3 응답 split 에 하위 지식이 실린다", (r.v?.split?.children ?? []).length === children.length, JSON.stringify(r.v?.split));
    const next = row(i++);
    await save({ name, mode: "append", body_md: next });
    const p2 = await rowOf(name);
    chk("S3 다음 행은 머리 있는 표에 붙는다", p2.body_md.trimEnd().endsWith(`|---|---|---|---|---|\n\n${next}`) || p2.body_md.trimEnd().endsWith(`|---|---|---|---|---|\n${next}`), p2.body_md.slice(-300));
  }

  // ── S4 신규 저장, 절 여러 개 ──
  {
    const name = `${P}design`;
    const para = (tag, n) => Array.from({ length: n }, (_, k) => `${tag} 문단 ${k} 은 설계 근거를 설명한다. ${"근거 ".repeat(60)}`).join("\n\n");
    const body = [
      "이 설계는 예약 발효를 배치로 한다.",
      "",
      "## 설계",
      "",
      para("설계", 25),
      "",
      "## 변경 이력",
      "",
      para("이력", 25),
      "",
      "## 운영",
      "",
      para("운영", 8),
    ].join("\n");
    const r = await attempt(() => save({ name, title: "예약 발효 설계", body_md: body, category: CAT, type: "decision" }));
    chk("S4 상한을 넘는 신규 저장이 거부되지 않는다", r.ok, r.msg);
    const parent = await rowOf(name);
    const kids = (await itemsPool.query(`SELECT name, title, body_md FROM knowledge WHERE body_md LIKE $1 AND name <> $2`, [`%[[${name}]]%`, name])).rows;
    chk("S4 서로 다른 절을 옮긴 하위 지식 제목엔 순번이 붙지 않는다", kids.length >= 1 && kids.every((k) => !/절 \d+$/.test(k.title)), JSON.stringify(kids.map((k) => k.title)));
    chk("S4 원래 지식은 상한 안이고 결론 첫 줄이 남는다", parent && cp(parent.body_md) <= LIMIT && parent.body_md.startsWith("이 설계는 예약 발효를 배치로 한다."), parent && cp(parent.body_md));
    chk("S4 이력 절이 먼저 옮겨진다", kids.some((k) => k.body_md.includes("## 변경 이력")) && parent.body_md.includes("## 변경 이력\n\n이 절은 [["), parent.body_md.slice(0, 600));
    const lost = covers(body, [parent.body_md, ...kids.map((k) => k.body_md)]);
    chk("S4 무손실", lost == null, `빠진 줄: ${lost}`);
  }

  // ── S5 원문 그대로 나눌 계획이 서지 않는 글(상한을 넘는 코드 블록 하나) ──
  {
    const name = `${P}codeblob`;
    await save({ name, title: "덤프 보관", body_md: "덤프를 보관한다.\n\n```\nx\n```", category: CAT, type: "reference" });
    const before = await rowOf(name);
    const blob = "덤프를 보관한다.\n\n```\n" + Array.from({ length: 400 }, (_, k) => `line ${k} ${"y".repeat(20)}`).join("\n") + "\n```";
    const r = await attempt(() => save({ name, body_md: blob }));
    chk("S5 나누지 못하면 422 로 거부한다", !r.ok && r.status === 422, `${r.status} ${r.msg?.slice(0, 200)}`);
    chk("S5 거부 메시지에 자동 분리 실패 사유와 나누는 순서가 있고 사람에게 묻게 하지 않는다",
      /자동으로 나누지 못했습니다\(본문 구조상/.test(r.msg ?? "") && /이력·로그·기록·경과/.test(r.msg ?? "") && !/사람에게 확인/.test(r.msg ?? ""), r.msg?.slice(0, 400));
    const after = await rowOf(name);
    chk("S5 행 그대로", after.version === before.version && after.body_md === before.body_md);
  }

  // ── S5b 나누면 안 되는 지식: 검토 대기 초안 · 보관된 지식 · 자료에서 증류된 지식 ──
  {
    const big = () => { const r = []; let i = 500; while (cp(r.join("\n")) < LIMIT) r.push(row(i++)); return r.join("\n"); };
    const childCount = async (name) => Number((await itemsPool.query(`SELECT count(*) FROM knowledge WHERE name LIKE $1`, [`${name}-archive-%`])).rows[0].count);

    const pend = `${P}pending`;
    const rp = await attempt(() => save({ name: pend, title: "검토 대기 원장", body_md: [...LEDGER_HEAD, big()].join("\n"), category: CAT, type: "reference", lifecycle: "pending" }));
    chk("S5b 검토 대기 초안은 나누지 않고 거부한다", !rp.ok && rp.status === 422 && /활성 지식이 아님/.test(rp.msg ?? "") && await childCount(pend) === 0, `${rp.status} ${rp.msg?.slice(0, 160)}`);
    chk("S5b 서버가 나누지 않는 지식의 거부는 직접 나누는 절차 대신 사람 확인을 안내한다",
      !/직접 나누세요/.test(rp.msg ?? "") && !/본문 길이 거부 처리/.test(rp.msg ?? "") && /사람에게 확인/.test(rp.msg ?? ""), rp.msg?.slice(0, 400));

    const arch = `${P}archived`;
    await save({ name: arch, title: "보관 원장", body_md: [...LEDGER_HEAD, row(1)].join("\n"), category: CAT, type: "reference" });
    await itemsPool.query(`UPDATE knowledge SET lifecycle='archived' WHERE name=$1`, [arch]);
    const ra = await attempt(() => save({ name: arch, mode: "append", body_md: big() }));
    chk("S5b 보관된 지식은 나누지 않는다", await childCount(arch) === 0, `${ra.status} ${ra.msg?.slice(0, 160)}`);

    const der = `${P}derived`;
    await save({ name: der, title: "자료 증류 원장", body_md: [...LEDGER_HEAD, row(1)].join("\n"), category: CAT, type: "reference" });
    const src = (await itemsPool.query(`INSERT INTO source(title, body_md) VALUES('srpg 자료', '원문') RETURNING id`).catch(() => ({ rows: [] }))).rows[0];
    if (src) {
      await itemsPool.query(`INSERT INTO knowledge_source(name, source_id, relation) VALUES($1,$2,'derived_from')`, [der, src.id]);
      const rd = await attempt(() => save({ name: der, mode: "append", body_md: big() }));
      chk("S5b 자료에서 증류된 지식은 나누지 않고 거부한다", !rd.ok && rd.status === 422 && /자료에서 증류한 지식/.test(rd.msg ?? "") && await childCount(der) === 0, `${rd.status} ${rd.msg?.slice(0, 160)}`);
      await itemsPool.query(`DELETE FROM source WHERE id=$1`, [src.id]);
    } else bad("S5b 자료 행을 만들지 못했다", "source 스키마 확인");

    const hidden = `${P}unsearchable`;
    await save({ name: hidden, title: "검색 제외 원장", body_md: [...LEDGER_HEAD, row(1)].join("\n"), category: CAT, type: "reference" });
    await itemsPool.query(`UPDATE knowledge SET searchable=false WHERE name=$1`, [hidden]);
    const rh = await attempt(() => save({ name: hidden, mode: "append", body_md: big() }));
    chk("S5b 검색 제외 지식은 나누지 않고 거부한다(옮긴 사본이 검색되지 않게)",
      !rh.ok && rh.status === 422 && /검색 제외 지식/.test(rh.msg ?? "") && await childCount(hidden) === 0, `${rh.status} ${rh.msg?.slice(0, 160)}`);
  }

  // ── S5d 분리 하위 지식은 새로 만들 때만 저장한다(동시 분리로 같은 이름이 생겼을 때 남의 지식을 덮지 않는다) ──
  {
    const { markSplitChild } = await import(`${DIST}/capabilities/knowledge/style-resolve.js`);
    const name = `${P}taken-archive-2026-01-01`;
    await save({ name, title: "이미 있는 지식", body_md: "이미 있는 본문이다.", category: CAT, type: "reference" });
    const before = await rowOf(name);
    const input = { name, title: "옮긴 조각", body_md: "옮긴 원문이다.", category: CAT, type: "reference", provenance: "authored" };
    markSplitChild(input, "옮긴 원문이다.");
    const r = await attempt(() => save(input));
    const after = await rowOf(name);
    chk("S5d 같은 이름이 이미 있으면 분리 하위 지식 저장은 409 이고 기존 지식은 그대로다",
      !r.ok && r.status === 409 && after.version === before.version && after.body_md === before.body_md, `${r.status} ${r.msg?.slice(0, 160)}`);
  }

  // ── S5c 하위 지식 저장이 중간에 실패하면 이번 호출이 만든 하위 지식을 지운다 ──
  {
    const name = `${P}rollback`;
    const childCount = async () => Number((await itemsPool.query(`SELECT count(*) FROM knowledge WHERE name LIKE $1`, [`${name}-archive-%`])).rows[0].count);
    let rows = [];
    let i = 900;
    while (cp([...LEDGER_HEAD, ...rows].join("\n")) < LIMIT - 300) rows.push(row(i++));
    await save({ name, title: "롤백 원장", body_md: [...LEDGER_HEAD, ...rows].join("\n"), category: CAT, type: "reference" });
    //  옛 본문 끝 행에 시크릿 모양을 둔다(에이전트 저장을 거치지 않은 본문) — 그 행이 든 뒤쪽 조각의 저장만 거부된다.
    const key = "AKIA" + "QWERTYUIOPASDFGH";
    const seeded = [...LEDGER_HEAD, ...rows.slice(0, -1), rows[rows.length - 1].replace("non-blocking", key)].join("\n");
    await itemsPool.query(`UPDATE knowledge SET body_md=$2 WHERE name=$1`, [name, seeded]);
    const before = await rowOf(name);
    const r = await attempt(() => save({ name, mode: "append", body_md: [row(i++), row(i++), row(i++), row(i++), row(i++)].join("\n") }));
    chk("S5c 조각 저장이 실패하면 422 로 거부하고 자동 분리 실패 사유를 싣는다", !r.ok && r.status === 422 && /자동으로 나누지 못했습니다/.test(r.msg ?? ""), `${r.status} ${r.msg?.slice(0, 200)}`);
    chk("S5c 앞서 저장된 하위 지식은 지워진다", await childCount() === 0, String(await childCount()));
    const after = await rowOf(name);
    chk("S5c 원래 지식은 그대로다", after.version === before.version && after.body_md === before.body_md);
  }

  // ── S6·S7 기준 날짜 ──
  {
    const name = `${P}status`;
    const body = "배포 절차를 정한다.\n\n- 신한 연동은 아직 배포 대기 중이다.\n- 재시도는 3회다.";
    await save({ name, title: "배포 절차", body_md: body, category: CAT, type: "how-to" });
    // 그 판이 2026-09-05(KST)에 저장된 것으로 감사 기록과 행 시각을 옮긴다.
    await itemsPool.query(`UPDATE org_content_audit SET at = '2026-09-05T03:00:00Z' WHERE entity='knowledge' AND entity_key=$1`, [name]);
    await itemsPool.query(`UPDATE knowledge SET updated_at = '2026-09-05T03:00:00Z' WHERE name=$1`, [name]);
    const got = await knowledgeGet.handler({ name }, { userId: AGENT }, mcp);
    const und = got.style?.findings?.find((f) => f.rule === "undated_status");
    chk("S6 읽기: 상태 서술 줄의 기준 날짜는 그 줄이 처음 저장된 판의 날이다",
      und?.anchors?.[0]?.date === "2026-09-05" && und.anchors[0].basis === "first_version" && und.fix && !("ask_human" in und), JSON.stringify(und));
    const v = (await rowOf(name)).version;
    const wrong = await attempt(() => save({ name, mode: "edit", style_fix: true, expected_version: v,
      edits: [{ old: "아직 배포 대기 중이다.", new: "배포 대기 중이다(2026-09-07 기준)." }] }));
    chk("S7 기준 날짜가 아닌 날짜를 적은 style_fix 저장은 422", !wrong.ok && wrong.status === 422, `${wrong.status} ${wrong.msg?.slice(0, 200)}`);
    const right = await attempt(() => save({ name, mode: "edit", style_fix: true, expected_version: v,
      edits: [{ old: "아직 배포 대기 중이다.", new: "배포 대기 중이다(2026-09-05 기준)." }] }));
    chk("S7 기준 날짜를 적은 style_fix 저장은 통과한다", right.ok, right.msg);
  }

  // ── S7b 형식만 고친 style_fix 가 시점 줄의 기준 날짜를 오늘로 바꾸지 않는다 ──
  {
    const name = `${P}status-fmt`;
    const body = "배포 절차를 정한다.\n\n- **결제 연동**은 아직 배포 대기 중이다.\n- 재시도는 3회다.";
    await save({ name, title: "결제 배포 절차", body_md: body, category: CAT, type: "how-to" });
    await itemsPool.query(`UPDATE org_content_audit SET at = '2026-09-05T03:00:00Z' WHERE entity='knowledge' AND entity_key=$1`, [name]);
    await itemsPool.query(`UPDATE knowledge SET updated_at = '2026-09-05T03:00:00Z' WHERE name=$1`, [name]);
    const v1 = (await rowOf(name)).version;
    const r1 = await attempt(() => save({ name, mode: "edit", style_fix: true, expected_version: v1,
      edits: [{ old: "- **결제 연동**은", new: "- 결제 연동은" }] }));
    const und = r1.v?.style?.findings?.find((f) => f.rule === "undated_status");
    chk("S7b 굵게만 벗긴 줄의 기준 날짜는 이번 저장일이 아니라 처음 판의 날이다",
      r1.ok && und?.anchors?.[0]?.date === "2026-09-05" && und.anchors[0].basis === "first_version", `${r1.msg ?? ""} ${JSON.stringify(und)}`);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const v2 = (await rowOf(name)).version;
    const wrong = await attempt(() => save({ name, mode: "edit", style_fix: true, expected_version: v2,
      edits: [{ old: "아직 배포 대기 중이다.", new: `배포 대기 중이다(${today} 기준).` }] }));
    chk("S7b 다음 style_fix 가 형식 정리한 날을 기준 날짜로 적으면 422", today === "2026-09-05" || (!wrong.ok && wrong.status === 422), `${wrong.status} ${wrong.msg?.slice(0, 200)}`);
    const right = await attempt(() => save({ name, mode: "edit", style_fix: true, expected_version: v2,
      edits: [{ old: "아직 배포 대기 중이다.", new: "배포 대기 중이다(2026-09-05 기준)." }] }));
    chk("S7b 처음 판의 날을 적은 style_fix 는 통과한다", right.ok, right.msg);
  }

  // ── S8 저장 응답 ──
  {
    const r = await save({ name: `${P}fresh`, title: "새 규칙", body_md: "새 규칙을 정한다.\n\n오늘 정했고 머지 대기 중이다.", category: CAT, type: "decision" });
    const rel = r.style?.findings?.find((f) => f.rule === "relative_time");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    chk("S8 새 줄의 기준 날짜는 오늘이고 고치는 법이 있다", rel?.anchors?.[0]?.basis === "this_save" && rel.fix && !r.style.findings.some((f) => "ask_human" in f), JSON.stringify(r.style?.findings));
    chk("S8 기준 날짜는 조직 시간대의 오늘 또는 UTC 오늘이다", [today, new Date().toISOString().slice(0, 10)].includes(rel?.anchors?.[0]?.date), rel?.anchors?.[0]?.date);
    chk("S8 기준 날짜를 찾은 위반은 안내문이 사람에게 묻게 하지 않는다", !/사람에게 확인/.test(r.style?.note ?? "") && /anchors 의 기준 날짜/.test(r.style?.note ?? ""), r.style?.note);
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
