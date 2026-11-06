// 증류기 «카테고리 붙이기» 레인(저장소 org_classifier — #4194)의 커버리지·배타 배정·'봤다' 해제 **의미** PG 통합 테스트
//  — 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/org/store/classifier-lanes.pg-test.mjs
//
//  왜 이 계층인가: 여기서 잠그는 것은 전부 SQL 조건이다 — 목으로는 검증 대상 자체가 빠진다.
//   ① 사각지대는 **스코프**로 센다(인박스로 세면 레인이 이미 보고 넘긴 지식까지 «영영 못 받는다» 로 센다 — 거짓 경보).
//      일하는 레인이 없으면 0(크론이 기본 기준 하나로 전부 본다).
//   ② 폐지된 재분류 모드(target=low_confidence)는 «켜짐» 이어도 일하지 않는다 — 커버리지·배타 배정에서 빠진다.
//   ③ 잔량은 상한 없이 센다(종전엔 표본 500 을 세어 500 에서 멈췄다).
//   ④ 카테고리를 잃은 지식(제안 반려·카테고리 삭제·휴지통 복원)은 '봤다' 기록이 지워진다 — 안 지우면 그 레인은 영영 안 본다.
//      아직 카테고리가 남은 지식의 기록은 그대로다.
//   ⑤ 부팅 이관 — 옛 기본 이름(«기본 분류»·«미분류 지식 분류 (헤드리스)» …)은 새 말로 바뀌고, 사람이 고친 이름은 그대로다.
//   ⑥ 레인의 confirm_threshold 가 서버 판정에 실제로 쓰인다(#5235 — T 번호는 사양의 행). 레인은 배치 기록(org_classifier_seen)으로 찾는다.
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const cls = await import(`${DIST}/org/store/classifiers.js`);
const ks = await import(`${DIST}/v6/knowledge-store.js`);
const cs = await import(`${DIST}/v6/category-store.js`);
const { forgetClassifierSeen } = await import(`${DIST}/v6/knowledge-common.js`);
const { initClassifierRegistry } = await import(`${DIST}/org/schema/connectors-ingest.js`);
const { initSessionsInfra } = await import(`${DIST}/org/schema/sessions-infra.js`);
const { classifiersCapabilities } = await import(`${DIST}/capabilities/delivery/classifiers.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const TAG = "__cls4194__";               // 이 테스트만의 접두 — 남의 지식·축·레인과 절대 안 섞인다
const SYS_A = TAG + "notion";            // 레인 스코프로 쓸 출처(external_system)
const SYS_B = TAG + "wiki";
const n = (s) => TAG + s;

const mkKnowledge = async (name, system) => {
  await itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, provenance, lifecycle, external_system)
     VALUES($1, $1, '본문', 'observed', 'active', $2)`, [name, system]);
};
const mkCategory = async (key) => (await itemsPool.query(
  `INSERT INTO category(key, name, origin) VALUES($1, $1, 'agent') RETURNING id`, [key])).rows[0].id;
const seenRows = async (laneId, name) => Number((await itemsPool.query(
  `SELECT count(*)::int AS n FROM org_classifier_seen WHERE classifier_id=$1 AND knowledge_name=$2`, [laneId, name])).rows[0].n);
const covOf = async () => cls.classifierCoverage();
const laneCov = (cov, id) => cov.classifiers.find((x) => Number(x.id) === Number(id));
/** 우리 레인 밖의 미분류 지식 수 — 전역 수치(total·uncovered)를 남의 행이 있어도 판정할 수 있게 델타로 본다. */
const unmappedWhere = async (extra, params = []) => Number((await itemsPool.query(
  `SELECT count(*)::int AS n FROM knowledge k WHERE k.lifecycle='active'
     AND NOT EXISTS (SELECT 1 FROM knowledge_category kc WHERE kc.name=k.name) ${extra}`, params)).rows[0].n);

const CRON_H = "classify-knowledge-headless", CRON_S = "classify-unmapped-knowledge";
let cronSnap = null;          // 이 테스트가 이관을 재려고 잠시 바꾼 기본 잡 행 — 끝나면 원래대로 되돌린다
const cronMade = [];          // 없어서 이 테스트가 만든 기본 잡 — 끝나면 지운다
let madeDefault = false;      // 없어서 이 테스트가 만든 default 레인 — 끝나면 지운다(남의 default 는 안 건드린다)
async function cleanup() {
  if (cronSnap) for (const r of cronSnap) await itemsPool.query(`UPDATE org_cron SET label=$2, note=$3 WHERE id=$1`, [r.id, r.label, r.note]);
  for (const id of cronMade) await itemsPool.query(`DELETE FROM org_cron WHERE id=$1`, [id]);
  if (madeDefault) await itemsPool.query(`DELETE FROM org_classifier WHERE key='default'`);
  await itemsPool.query(`DELETE FROM org_classifier WHERE key LIKE $1`, [TAG + "%"]);
  await itemsPool.query(`DELETE FROM org_classifier_seen WHERE knowledge_name LIKE $1`, [TAG + "%"]);
  await itemsPool.query(`DELETE FROM knowledge WHERE name LIKE $1`, [TAG + "%"]);
  await itemsPool.query(`DELETE FROM category WHERE key LIKE $1`, [TAG + "%"]);
}

try {
  await cleanup();
  //  전제: 남의 «일하는» 레인이 없다(있으면 ①의 «레인 없음 = 사각지대 0» 판정이 이 테스트의 것이 아니게 된다).
  const foreign = Number((await itemsPool.query(
    `SELECT count(*)::int AS n FROM org_classifier WHERE enabled AND target <> 'low_confidence' AND key NOT LIKE $1`, [TAG + "%"])).rows[0].n);
  if (foreign) throw new Error(`테스트 DB 에 남의 켜진 레인 ${foreign}개 — 이 테스트는 레인이 없는 상태에서 시작해야 한다`);

  await mkKnowledge(n("a1"), SYS_A);        // 미분류 · 출처 A
  await mkKnowledge(n("b1"), SYS_B);        // 미분류 · 출처 B
  await mkKnowledge(n("a-mapped"), SYS_A);  // 카테고리 있음 · 출처 A
  const cat = await mkCategory(n("cat"));
  await ks.linkKnowledgeCategory(n("a-mapped"), cat, "confirmed");

  // ── ① 일하는 레인이 없으면 사각지대 0 — 기본 기준 하나가 전부 본다 ──
  {
    const cov = await covOf();
    chk("①-1 레인이 없으면 사각지대 0", cov.uncovered === 0, `uncovered=${cov.uncovered}`);
    chk("①-2 미분류 총수엔 우리 두 건이 들어 있다", cov.total_unclassified >= 2, `total=${cov.total_unclassified}`);
  }

  // ── ② 폐지 모드 레인만 켜져 있으면 «일하는 레인 없음» 과 같다 ──
  const retired = await cls.upsertClassifier({ key: n("retired"), enabled: true, target: "low_confidence", priority: 100 }, "test", "test");
  {
    const cov = await covOf();
    chk("②-1 폐지 레인은 커버리지 목록에 없다", !laneCov(cov, retired.id), JSON.stringify(cov.classifiers));
    chk("②-2 폐지 레인만 있으면 사각지대 0", cov.uncovered === 0, `uncovered=${cov.uncovered}`);
    const inbox = await cls.classifierInbox(retired, 50);
    chk("②-3 폐지 레인의 인박스는 비었다", inbox.length === 0, `inbox=${inbox.length}`);
  }

  // ── ③ 출처 A 만 맡는 레인 — 잔량·사각지대는 스코프로 ──
  const laneA = await cls.upsertClassifier({ key: n("lane-a"), enabled: true, match_systems: [SYS_A], priority: 10 }, "test", "test");
  {
    const cov = await covOf();
    const la = laneCov(cov, laneA.id);
    chk("③-1 레인 A 는 미분류 출처 A 한 건을 맡는다(카테고리 있는 건 제외)", la && la.backlog === 1, JSON.stringify(la));
    const expectUncovered = await unmappedWhere(`AND k.external_system IS DISTINCT FROM $1`, [SYS_A]);
    chk("③-2 사각지대 = 스코프 밖 미분류(출처 A 가 아닌 것)", cov.uncovered === expectUncovered, `uncovered=${cov.uncovered} expect=${expectUncovered}`);
    chk("③-3 우리 출처 B 건이 사각지대에 들어 있다", cov.uncovered >= 1, `uncovered=${cov.uncovered}`);
    chk("③-4 앞선 폐지 레인(우선순위 100)이 레인 A 몫을 빼앗지 않았다", la && la.backlog === 1, JSON.stringify(la));

    // '봤다' 를 찍으면 잔량은 줄지만 사각지대는 그대로다(스코프로 세니까) — 인박스로 세던 종전엔 여기서 사각지대가 늘었다.
    await cls.markClassifierSeen(laneA.id, [n("a1")], null);
    const cov2 = await covOf();
    const la2 = laneCov(cov2, laneA.id);
    chk("③-5 본 뒤 잔량 0 · 본 수 1", la2 && la2.backlog === 0 && la2.reviewed === 1, JSON.stringify(la2));
    chk("③-6 본 뒤에도 사각지대는 그대로", cov2.uncovered === cov.uncovered, `before=${cov.uncovered} after=${cov2.uncovered}`);
    await itemsPool.query(`DELETE FROM org_classifier_seen WHERE classifier_id=$1`, [laneA.id]);
  }

  // ── ③-b 잔량은 상한 없이 센다(표본 500 을 세던 종전 방식이면 여기서 막힌다 — 구조 검증이라 몇 건이면 충분) ──
  {
    for (let i = 0; i < 3; i++) await mkKnowledge(n(`a-extra-${i}`), SYS_A);
    const la = laneCov(await covOf(), laneA.id);
    chk("③-7 추가 3건까지 잔량 4", la && la.backlog === 4, JSON.stringify(la));
    const sample = await cls.classifierInbox(laneA, 2);
    chk("③-8 표본은 요청한 수만(잔량과 별개)", sample.length === 2, `sample=${sample.length}`);
  }

  // ── ③-c 앞선 **일하는** 넓은 레인은 뒤 레인 몫을 가져간다(배타 배정은 그대로) ──
  {
    const wide = await cls.upsertClassifier({ key: n("wide"), enabled: true, priority: 50 }, "test", "test");
    const la = laneCov(await covOf(), laneA.id);
    chk("③-9 앞선 catch-all 레인이 켜지면 레인 A 잔량 0", la && la.backlog === 0, JSON.stringify(la));
    const cov = await covOf();
    chk("③-10 catch-all 이 있으면 사각지대 0", cov.uncovered === 0, `uncovered=${cov.uncovered}`);
    await cls.removeClassifier(Number(wide.id), "test", "test");
  }

  // ── ④ 카테고리를 잃은 지식은 '봤다' 기록이 지워진다 ──
  {
    // (a) 제안 반려 = unlink
    await ks.linkKnowledgeCategory(n("a1"), cat, "confirmed");
    await cls.markClassifierSeen(laneA.id, [n("a1")], null);
    chk("④-a0 준비: 기록 1", (await seenRows(laneA.id, n("a1"))) === 1);
    await ks.unlinkKnowledgeCategory(n("a1"), cat, { actor: "test", source: "test" });
    chk("④-a 반려(unlink)로 카테고리를 잃으면 기록이 지워진다", (await seenRows(laneA.id, n("a1"))) === 0);

    // (b) 카테고리가 남은 지식의 기록은 그대로
    await cls.markClassifierSeen(laneA.id, [n("a-mapped")], null);
    await forgetClassifierSeen([n("a-mapped")]);
    chk("④-b 카테고리가 남아 있으면 기록을 안 지운다", (await seenRows(laneA.id, n("a-mapped"))) === 1);

    // (c) 카테고리 삭제. #4233 부터 지식이 붙은 분류는 지울 수 없다(409, category-store assertDeletable).
    //     그래서 지식이 삭제로 카테고리를 잃는 길 자체가 없다. 지식은 그 칸에 남고 '봤다' 기록도 그대로다.
    const cat2 = await mkCategory(n("cat2"));
    await ks.linkKnowledgeCategory(n("b1"), cat2, "confirmed");
    await cls.markClassifierSeen(laneA.id, [n("b1")], null);
    let delStatus = 0;
    try { await cs.deleteCategory(cat2, { actor: "test", source: "test" }); } catch (e) { delStatus = e && e.status; }
    chk("④-c 지식이 붙은 분류는 지울 수 없다(409) · 기록은 그대로", delStatus === 409 && (await seenRows(laneA.id, n("b1"))) === 1);

    // (d) 휴지통 복원 — 링크 없이 돌아온다
    await mkKnowledge(n("restore"), SYS_A);
    await ks.linkKnowledgeCategory(n("restore"), cat, "confirmed");
    await cls.markClassifierSeen(laneA.id, [n("restore")], null);
    const before = await ks.deleteKnowledge(n("restore"), { actor: "test", source: "test" });
    await ks.restoreKnowledge(before, { actor: "test", source: "test" });
    chk("④-d 휴지통 복원(링크 미복원)이면 기록이 지워진다", (await seenRows(laneA.id, n("restore"))) === 0);
  }

  // ── ⑤ 부팅 이관 — 옛 기본 이름만 새 말로(사람이 고친 것은 그대로) ──
  {
    const hadDefault = Number((await itemsPool.query(`SELECT count(*)::int AS n FROM org_classifier WHERE key='default'`)).rows[0].n);
    if (hadDefault) {
      ok("⑤-a 건너뜀 — 테스트 DB 에 남의 default 레인이 있다(덮지 않는다)");
    } else {
      await cls.upsertClassifier({ key: "default", label: "기본 분류", enabled: false }, "test", "test");
      madeDefault = true;
      await cls.upsertClassifier({ key: n("custom"), label: "기본 분류", enabled: false }, "test", "test");   // default 가 아니면 안 바꾼다
      await initClassifierRegistry(itemsPool);
      const lbl = async (key) => (await itemsPool.query(`SELECT label FROM org_classifier WHERE key=$1`, [key])).rows[0]?.label;
      chk("⑤-a 컨트롤플레인이 심은 default 의 옛 이름 → «기본 카테고리 붙이기»", (await lbl("default")) === "기본 카테고리 붙이기", String(await lbl("default")));
      chk("⑤-b default 가 아닌 레인은 이름이 같아도 안 바꾼다", (await lbl(n("custom"))) === "기본 분류", String(await lbl(n("custom"))));
      await itemsPool.query(`UPDATE org_classifier SET label='우리 기본' WHERE key='default'`);
      await initClassifierRegistry(itemsPool);
      chk("⑤-c 사람이 고친 이름은 그대로", (await lbl("default")) === "우리 기본", String(await lbl("default")));
      await itemsPool.query(`DELETE FROM org_classifier WHERE key='default'`);
      madeDefault = false;
    }
    // 크론 기본 잡 두 행 — 스키마 시드가 넣었을 수도(세션주입판), 새 워크스페이스 시드가 넣었을 수도(헤드리스판) 있다.
    //  있으면 값을 잠시 옛 기본으로 바꿨다가 되돌리고, 없으면 만들었다가 지운다.
    //  ⚠ ON CONFLICT (id) 는 쓰지 않는다 — 테넌트 레이어가 PK 를 (tenant_id, id) 로 재작성해 컬럼 추론이 42P10 으로 죽는다.
    cronSnap = (await itemsPool.query(`SELECT id, label, note FROM org_cron WHERE id = ANY($1::text[])`, [[CRON_H, CRON_S]])).rows;
    const OLD_NOTE = "켜진 분류기별로 미분류 지식 배치를 헤드리스 AI 세션에 접수. 분류기가 없으면 전역 기본 분류.";
    const put = async (id, label, action, note) => {
      if (cronSnap.some((r) => r.id === id)) await itemsPool.query(`UPDATE org_cron SET label=$2, note=$3 WHERE id=$1`, [id, label, note]);
      else { await itemsPool.query(`INSERT INTO org_cron(id, label, action, interval_sec, enabled, note) VALUES($1,$2,$3,3600,false,$4)`, [id, label, action, note]); cronMade.push(id); }
    };
    await put(CRON_H, "미분류 지식 분류 (헤드리스)", "classify_knowledge_headless", OLD_NOTE);
    await put(CRON_S, "미분류 지식 LLM 분류 (상시 세션 주입, #982)", "classify_knowledge", "옛 설명");
    await initSessionsInfra(itemsPool);
    const row = async (id) => (await itemsPool.query(`SELECT label, note FROM org_cron WHERE id=$1`, [id])).rows[0] || {};
    const h = await row(CRON_H), sInj = await row(CRON_S);
    chk("⑤-d 헤드리스 잡의 옛 기본 이름 → 새 이름", h.label === "카테고리 붙이기 (미분류 지식→카테고리, 헤드리스)", String(h.label));
    chk("⑤-e 헤드리스 잡의 옛 기본 설명 → 새 설명", /카테고리 붙이기 증류기별로/.test(String(h.note)), String(h.note));
    chk("⑤-f 세션주입 잡의 옛 기본 이름 → 새 이름", sInj.label === "카테고리 붙이기 (상시 세션 주입, #982)", String(sInj.label));
    await itemsPool.query(`UPDATE org_cron SET label='우리 분류 잡' WHERE id=$1`, [CRON_H]);
    await initSessionsInfra(itemsPool);
    chk("⑤-g 사람이 고친 잡 이름은 그대로", (await row(CRON_H)).label === "우리 분류 잡", String((await row(CRON_H)).label));
  }

  // ── ⑥ 레인 문턱이 서버 판정에 쓰인다(#5235) — 상태는 응답이 아니라 저장된 행으로 잰다 ──
  {
    const stateOf = async (name) => (await itemsPool.query(`SELECT state FROM knowledge_category WHERE name=$1`, [name])).rows[0]?.state;
    const seq = { n: 0 };
    /** 미분류 지식 하나를 만들고, 레인들이 차례로 배치로 낸 뒤, 제안한다. */
    const propose = async (lanes, opts) => {
      const name = n(`t${++seq.n}`);
      await mkKnowledge(name, TAG + "threshold");
      for (const [i, lane] of lanes.entries()) {
        await cls.markClassifierSeen(lane.id, [name], null);
        //  한 트랜잭션 안의 now() 가 같아질 수 있어 순서를 명시한다 — 뒤에 낸 레인이 «가장 최근 배치» 다.
        await itemsPool.query(`UPDATE org_classifier_seen SET seen_at = now() + ($3 || ' seconds')::interval WHERE classifier_id=$1 AND knowledge_name=$2`, [lane.id, name, i]);
      }
      const r = await ks.proposeKnowledgeCategory(name, cat, { evidence: "근거", ...opts }, { actor: "test", source: "test" });
      return { name, r, saved: await stateOf(name) };
    };
    const mkLane = (key, th) => cls.upsertClassifier({ key: n(key), enabled: false, confirm_threshold: th }, "test", "test");
    const low = await mkLane("th-low", 0.4), strict = await mkLane("th-strict", 0.9), zero = await mkLane("th-zero", 0);

    let x = await propose([low], { confidence: 0.7 });
    chk("⑥-T1 문턱 0.4 레인이 낸 지식 · 0.7 → confirmed(프로젝트 재현)", x.saved === "confirmed" && x.r.state === "confirmed", JSON.stringify(x));
    chk("⑥-T1b 응답이 쓰인 문턱을 말한다", Math.abs(x.r.threshold - 0.4) < 1e-6, JSON.stringify(x.r));
    x = await propose([low], { confidence: 0.39 });
    chk("⑥-T2 문턱 0.4 · 0.39 → proposed", x.saved === "proposed", JSON.stringify(x));
    x = await propose([low], { confidence: 0.4 });
    chk("⑥-T3 경계 — 정확히 문턱이면 confirmed", x.saved === "confirmed", JSON.stringify(x));
    x = await propose([strict], { confidence: 0.85 });
    chk("⑥-T4 더 엄격한 문턱 0.9 도 듣는다 · 0.85 → proposed", x.saved === "proposed", JSON.stringify(x));
    x = await propose([], { confidence: 0.8 });
    chk("⑥-T5 낸 레인 없음 · 기본 문턱 경계 0.8 → confirmed", x.saved === "confirmed" && x.r.threshold === 0.8, JSON.stringify(x));
    x = await propose([], { confidence: 0.79 });
    chk("⑥-T6 낸 레인 없음 · 0.79 → proposed", x.saved === "proposed", JSON.stringify(x));
    x = await propose([strict], { confidence: 0.1, state: "confirmed" });
    chk("⑥-T7 state 를 명시하면 그 뜻이 앞선다(문턱을 안 쓴다)", x.saved === "confirmed" && x.r.threshold === undefined, JSON.stringify(x));
    x = await propose([strict, low], { confidence: 0.7 });
    chk("⑥-T8 두 레인이 봤으면 가장 최근 배치의 레인(0.9 다음 0.4) → confirmed", x.saved === "confirmed", JSON.stringify(x));
    x = await propose([low, strict], { confidence: 0.7 });
    chk("⑥-T8b 순서를 뒤집으면 결과도 뒤집힌다(0.4 다음 0.9) → proposed", x.saved === "proposed", JSON.stringify(x));
    x = await propose([zero], {});
    chk("⑥-T9 확신도가 없으면 문턱 0 이어도 자동 확정하지 않는다", x.saved === "proposed", JSON.stringify(x));
    x = await propose([zero], { confidence: 0 });
    chk("⑥-T10 경계 — 문턱 0 · 확신도 0 → confirmed", x.saved === "confirmed", JSON.stringify(x));

    //  T11 — 레인이 사라지면 '봤다' 기록이 함께 사라져(FK CASCADE) 기본 문턱으로 돌아간다.
    const gone = await mkLane("th-gone", 0.4);
    const goneName = n("t-gone");
    await mkKnowledge(goneName, TAG + "threshold");
    await cls.markClassifierSeen(gone.id, [goneName], null);
    await cls.removeClassifier(gone.id, "test", "test");
    const g = await ks.proposeKnowledgeCategory(goneName, cat, { evidence: "근거", confidence: 0.7 }, { actor: "test", source: "test" });
    chk("⑥-T11 레인이 사라지면 기본 문턱 → 0.7 은 proposed", (await stateOf(goneName)) === "proposed" && g.threshold === 0.8, JSON.stringify(g));

    //  삭제 도구가 실제로 지우는지(#5235 — 위 T11 을 쓰다 드러났다). id 는 BIGSERIAL 이라 런타임에 문자열이고, 그걸 그대로 넘기면
    //   key 로 찾다 못 찾아 아무것도 안 지운 채 { ok: true } 를 돌려줬다. 화면엔 «삭제했습니다» 가 떴다. 행으로 잰다.
    const removeOp = classifiersCapabilities.find((c) => c.name === "org_distiller_category_remove");
    const rows = async (key) => Number((await itemsPool.query(`SELECT count(*)::int AS n FROM org_classifier WHERE key=$1`, [key])).rows[0].n);
    await mkLane("rm-by-key", 0.5);
    await removeOp.handler({ key: n("rm-by-key") }, { userId: "test" }, {});
    chk("⑥-삭제 key 로 지우면 행이 실제로 사라진다", (await rows(n("rm-by-key"))) === 0, `rows=${await rows(n("rm-by-key"))}`);
    const byId = await mkLane("rm-by-id", 0.5);
    await removeOp.handler({ id: Number(byId.id) }, { userId: "test" }, {});
    chk("⑥-삭제 id 로 지워도 행이 실제로 사라진다", (await rows(n("rm-by-id"))) === 0, `rows=${await rows(n("rm-by-id"))}`);

    //  같은 뿌리 — 수정 저장이 고친 레인을 돌려준다. 종전엔 문자열 id 로 다시 찾다 null 이 되어 응답의 레인이 비었다.
    const edited = await cls.upsertClassifier({ key: n("th-low"), label: "이름 고침" }, "test", "test");
    chk("⑥-수정 저장소가 고친 행을 돌려준다", edited?.label === "이름 고침" && typeof edited?.id === "number", JSON.stringify(edited));
    const upsertOp = classifiersCapabilities.find((c) => c.name === "org_distiller_category_upsert");
    const viaTool = await upsertOp.handler({ key: n("th-low"), label: "한 번 더" }, { userId: "test" }, {});
    chk("⑥-수정 도구 응답에 레인이 있다", viaTool?.classifier?.label === "한 번 더" && viaTool?.lane?.key === n("th-low"), JSON.stringify(viaTool).slice(0, 160));
    chk("⑥-id 목록의 id 도 숫자다", (await cls.listClassifiers()).every((c) => typeof c.id === "number"), "");

    //  이미 카테고리가 있으면 건드리지 않는다 — 문턱을 낮춰도 기존 판정 불가침은 그대로다.
    const skip = await ks.proposeKnowledgeCategory(n("t1"), cat, { evidence: "다시", confidence: 0.1 }, { actor: "test", source: "test" });
    chk("⑥-불가침 이미 카테고리가 있으면 건너뛴다", skip.applied === false && skip.skipped === "already_has_category", JSON.stringify(skip));
  }
} catch (e) {
  bad("예외", (e && e.stack) || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
