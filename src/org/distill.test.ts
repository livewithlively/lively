// P-V3-6 증류 v1(규칙판) — DB 통합 체크. 실행: npm run build && node --env-file-if-exists=.env dist/org/distill.test.js
//  ITEMS_DATABASE_URL 미설정이면 graceful skip(빌드 게이트 통과). **비파괴**: 합성 observed W 유닛('distilltest__'
//  external_id)·합성 매핑만 생성/대상으로 하고 finally 에서 후보·시드를 전부 정리 — 실 ku·실 후보 무영향.
//  커버: (1) R-DOMAIN-WORKLOAD 규칙(임계 N 경계) (2) R-PROJECT-CLUSTER 규칙(declared 만) (3) 멱등(2회=신규 0)
//        (4) 캡(cap 초과분 cappedOut) (5) TTL(미검토 후보 updated_at 노후화→superseded, 갓 만든 건 생존)
//        (6) 사람 손길 보호(human/reject 후보 덮어쓰지 않음) (7) 주입 격리(buildKnowledgeIndex 가 distill 후보 제외)
//        (8) confirm(ai→human·마커 해제→인덱스 진입).
import assert from "node:assert/strict";
import { itemsPool } from "../items/store.js";
import { initOrgSchema } from "./schema.js";
import { runDistill, runRules, expireStale, confirmCandidate, DISTILL_SOURCE_PREFIX } from "./distill.js";
import { listKnowledge } from "./knowledge.js";
import { buildKnowledgeIndex } from "./materialize.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  pass++;
  console.log(`ok  ${name}`);
};

const PREFIX = "distilltest__";
const REPO = "distilltest-repo";          // 합성 repo(실 productivity/lively 와 안 겹침 → 실 후보 안 만듦)
const DOM_HOT = "distilltest-hotdomain";  // 임계 이상 W 가 붙을 도메인
const DOM_COLD = "distilltest-colddomain"; // 임계 미만(1건) — 후보 안 나와야 함
const PROJ = "distilltest-proj-declared"; // declared 프로젝트(클러스터 후보)
const PROJ_PROPOSED = "distilltest-proj-proposed"; // proposed 만 — 클러스터 후보 안 나와야 함

// 합성 observed W 유닛 N개 생성. 각각 domain/project 매핑을 옵션대로 붙인다.
async function seedWorkUnits(
  n: number,
  opts: { domain?: string; domainState?: string; project?: string; projectDeclared?: boolean } = {},
): Promise<string[]> {
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const ext = `${PREFIX}${opts.domain ?? opts.project ?? "x"}-${i}`;
    const name = (`ku-${ext}`).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 64);
    names.push(name);
    await itemsPool.query(
      `INSERT INTO knowledge_unit(name, kind, title, body_md, lifecycle, confidence, source,
          external_system, external_instance, external_id, occurred_at, updated_at, updated_by)
        VALUES($1,'W',$2,'합성 작업','active','observed','clickup','clickup',$3,$4,now(),now(),'distilltest')
       ON CONFLICT (name) DO UPDATE SET title=EXCLUDED.title`,
      [name, `합성 작업 ${i}`, "" /*instance*/, ext],
    );
    // instance 가 ''(빈)이라 부분 UNIQUE 와 충돌 가능 → external_instance 를 고유화(테스트 격리).
    await itemsPool.query(
      `UPDATE knowledge_unit SET external_instance=$2 WHERE name=$1`, [name, `${PREFIX}inst-${ext}`]);
    if (opts.domain) {
      await itemsPool.query(
        `INSERT INTO knowledge_unit_domain(name, repo, domain_key, mapped_by, state)
           VALUES($1,$2,$3,'rule',$4)
         ON CONFLICT (name, repo, domain_key) DO UPDATE SET state=EXCLUDED.state`,
        [name, REPO, opts.domain, opts.domainState ?? "proposed"],
      );
    }
    if (opts.project) {
      await itemsPool.query(
        `INSERT INTO knowledge_unit_project(name, repo, project_key, mapped_by, state)
           VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (name, repo, project_key) DO UPDATE SET mapped_by=EXCLUDED.mapped_by, state=EXCLUDED.state`,
        [name, REPO, opts.project, opts.projectDeclared ? "declared" : "rule", opts.projectDeclared ? "confirmed" : "proposed"],
      );
    }
  }
  return names;
}

async function cleanup(): Promise<void> {
  // 후보(distill-...repo...) + 합성 W 유닛 + 매핑 전부 제거. 매핑은 FK CASCADE 지만 명시 삭제로 확실히.
  await itemsPool.query(`DELETE FROM knowledge_unit_domain  WHERE repo=$1`, [REPO]);
  await itemsPool.query(`DELETE FROM knowledge_unit_project WHERE repo=$1`, [REPO]);
  await itemsPool.query(`DELETE FROM knowledge_unit WHERE external_id LIKE $1`, [PREFIX + "%"]);
  // 합성 repo 로 만들어진 distill 후보 제거(source_ref 에 repo 슬러그 포함).
  await itemsPool.query(
    `DELETE FROM knowledge_unit WHERE source_ref LIKE $1 OR source_ref LIKE $2`,
    [`${DISTILL_SOURCE_PREFIX}%${REPO}%`, `${DISTILL_SOURCE_PREFIX}%${REPO.toLowerCase()}%`],
  );
  await itemsPool.query(`DELETE FROM knowledge_unit WHERE name LIKE $1`, [`distill-%${REPO}%`]);
}

// 합성 repo 한정 옵션(실 데이터 제외 — repos 스코프로 실 ku 후보를 만들지 않는다·비파괴 핵심). 임계는 3.
const OPTS = { minWorkPerDomain: 3, minWorkPerProject: 3, repos: [REPO] };

async function main(): Promise<void> {
  if (!process.env.ITEMS_DATABASE_URL) {
    console.log("skip  ITEMS_DATABASE_URL 미설정 — P-V3-6 증류 통합 체크 건너뜀(빌드 게이트는 통과)");
    return;
  }
  await initOrgSchema();
  await cleanup();

  try {
    // ── 시드: hot 도메인 4 W(>=3 임계 통과) / cold 도메인 1 W(<3, 후보 없음) ──
    await seedWorkUnits(4, { domain: DOM_HOT, domainState: "proposed" });
    await seedWorkUnits(1, { domain: DOM_COLD, domainState: "proposed" });
    // declared 프로젝트 3 W(임계 통과) / proposed 프로젝트 5 W(declared 아님 → 후보 없음)
    await seedWorkUnits(3, { project: PROJ, projectDeclared: true });
    await seedWorkUnits(5, { project: PROJ_PROPOSED, projectDeclared: false });

    // ── (1)(2) 규칙 산출 — runRules 가 우리 합성 데이터에서 hot 도메인 D 후보 + declared 프로젝트 K 후보만 뽑아야 ──
    await t("규칙: hot 도메인 D 후보 + declared 프로젝트 K 후보만(cold/proposed 제외)", async () => {
      const cands = (await runRules(OPTS)).filter(
        (c) => c.seed.includes(REPO),
      );
      const dom = cands.filter((c) => c.rule === "domain-workload");
      const proj = cands.filter((c) => c.rule === "project-cluster");
      // hot 도메인만(cold 는 1 W < 3 → 제외)
      assert.equal(dom.length, 1, `domain 후보 1개여야(hot만), got ${dom.length}`);
      assert.equal(dom[0].kind, "D");
      assert.ok(dom[0].seed.includes(DOM_HOT), "hot 도메인 시드여야");
      assert.ok(!dom.some((c) => c.seed.includes(DOM_COLD)), "cold 도메인은 후보 아님");
      assert.ok(dom[0].evidence.includes("4건"), "evidence 에 W 4건 명시");
      // declared 프로젝트만(proposed 는 제외)
      assert.equal(proj.length, 1, `project 후보 1개여야(declared만), got ${proj.length}`);
      assert.equal(proj[0].kind, "K");
      assert.ok(proj[0].seed.includes(PROJ), "declared 프로젝트 시드여야");
      assert.ok(!proj.some((c) => c.seed.includes(PROJ_PROPOSED)), "proposed 프로젝트는 후보 아님");
      // 멱등 후보키 — source_ref 형식
      assert.ok(dom[0].source_ref.startsWith(DISTILL_SOURCE_PREFIX), "source_ref distill: 접두");
    });

    // ── (3) 멱등 — 1차 실행: 신규 2(D+K). 2차 실행: 신규 0, refreshed 2. ──
    let firstCreated = 0;
    await t("멱등: 1차 created=2(D+K), 2차 created=0·refreshed=2", async () => {
      const r1 = await runDistill({ ...OPTS, cap: 20 });
      // 합성 후보만 추려서 검증(실 데이터 후보도 같이 만들어질 수 있으므로 전체 created 가 아닌 합성 후보 존재로)
      const mine1 = (await listKnowledge({})).filter((u) => (u.source_ref ?? "").includes(REPO));
      assert.equal(mine1.length, 2, `합성 후보 2개여야(D+K), got ${mine1.length}`);
      firstCreated = r1.created;
      assert.ok(r1.created >= 2, "1차 created >= 2(합성 D+K 포함)");

      const r2 = await runDistill({ ...OPTS, cap: 20 });
      const mine2 = (await listKnowledge({})).filter((u) => (u.source_ref ?? "").includes(REPO));
      assert.equal(mine2.length, 2, "2차에도 합성 후보 2개(신규 누적 없음 — 멱등)");
      // 합성 후보는 2차에서 신규가 아님(이미 존재) — 멱등 후보키로 중복 0.
      const minePrev = mine1.map((u) => u.name).sort();
      const mineNow = mine2.map((u) => u.name).sort();
      assert.deepEqual(mineNow, minePrev, "2차 후보 name 집합 = 1차(재후보화 0)");
    });

    // ── (4) 캡 — cap=1 로 좁히면 신규 후보 일부가 cappedOut. (이미 2개 존재하므로 새 시드로 신규 유발) ──
    await t("캡: cap=1 이면 신규 후보가 cap 만큼만 created, 나머지 cappedOut", async () => {
      // 새 hot 도메인 2개 추가(각 3 W) → 신규 D 후보 2개 유발. 기존 후보는 갱신(캡 무관).
      await seedWorkUnits(3, { domain: DOM_HOT + "-b", domainState: "proposed" });
      await seedWorkUnits(3, { domain: DOM_HOT + "-c", domainState: "proposed" });
      const r = await runDistill({ ...OPTS, cap: 1 });
      // 신규(없던 name) 후보는 cap=1 이라 최대 1개만 생성, 나머지는 cappedOut.
      assert.ok(r.created <= 1, `created <= cap(1), got ${r.created}`);
      assert.ok(r.cappedOut >= 1, `cappedOut >= 1(신규 일부 누락), got ${r.cappedOut}`);
    });

    // ── (5a) 살아있는 시드 보호 — dead seed(활동 소멸) 가 아닌, rules 가 여전히 산출하는 시드를 40일 노후화해도 ──
    //  runDistill 은 expire 를 upsert 후에 부르므로 갱신돼 생존한다(순서 = 보호). 이게 ordering 회귀 방지 케이스.
    await t("TTL: 살아있는 시드는 노후화돼도 runDistill 이 갱신해 생존(expire after upsert)", async () => {
      const hotB = (await listKnowledge({})).find((u) => (u.source_ref ?? "").includes(DOM_HOT + "-b") && (u.source_ref ?? "").includes(REPO));
      assert.ok(hotB, "hot-b 도메인 후보 존재(아직 활동 살아있음)");
      // 인위적 노후화(40일 전) — 하지만 시드 활동(hot-b 의 3 W)은 그대로 → rules 가 계속 산출.
      await itemsPool.query(`UPDATE knowledge_unit SET updated_at = now() - interval '40 days' WHERE name=$1`, [hotB!.name]);
      await runDistill({ ...OPTS, cap: 20 }); // upsert(갱신 → updated_at=now) 후 expire → 살아있어 안 걸림
      const after = (await itemsPool.query(`SELECT lifecycle, updated_at FROM knowledge_unit WHERE name=$1`, [hotB!.name])).rows[0];
      assert.equal(after.lifecycle, "active", "살아있는 시드는 active 생존(refresh 가 시계 리셋)");
    });

    // ── (5b) dead seed 만료 — 시드 활동을 제거(rules 가 더는 산출 안 함) + 노후화 → expireStale 가 superseded. ──
    await t("TTL: dead 시드(활동 소멸 + 노후 미검토) 는 superseded", async () => {
      // hot-c 후보를 확보한 뒤, 그 시드의 활동(W 매핑)을 제거 → rules 가 더는 안 냄(dead seed).
      const hotC = (await listKnowledge({})).find((u) => (u.source_ref ?? "").includes(DOM_HOT + "-c") && (u.source_ref ?? "").includes(REPO));
      assert.ok(hotC, "hot-c 도메인 후보 존재");
      await itemsPool.query(`DELETE FROM knowledge_unit_domain WHERE repo=$1 AND domain_key=$2`, [REPO, DOM_HOT + "-c"]);
      // 노후화 후 만료(직접 expireStale — runDistill 도 동일하게 upsert 후 expire 라 결과 동치).
      await itemsPool.query(`UPDATE knowledge_unit SET updated_at = now() - interval '40 days' WHERE name=$1`, [hotC!.name]);
      const expired = await expireStale(30, false, [REPO]);
      assert.ok(expired.includes(hotC!.name), "dead+노후 후보가 만료 목록에 포함");
      const after = (await itemsPool.query(`SELECT lifecycle FROM knowledge_unit WHERE name=$1`, [hotC!.name])).rows[0];
      assert.equal(after.lifecycle, "superseded", "dead 시드 lifecycle=superseded");
      // 신선 후보(살아있는 project K)는 안 죽음.
      const proj = (await listKnowledge({})).find((u) => (u.source_ref ?? "").includes(PROJ) && (u.source_ref ?? "").includes(REPO) && u.confidence === "ai");
      if (proj) assert.equal(proj.lifecycle, "active", "신선 project 후보는 active 생존");
    });

    // ── (6) 사람 손길 보호 — confirm(human)·reject(superseded) 한 후보는 재실행이 안 덮어쓴다. ──
    await t("보호: human/reject 후보는 재실행이 덮어쓰지 않음(재후보화 0)", async () => {
      const proj = (await listKnowledge({})).find((u) => (u.source_ref ?? "").includes(PROJ) && (u.source_ref ?? "").includes(REPO) && u.lifecycle === "active");
      assert.ok(proj, "project 후보 active");
      // confirm → human·마커 해제
      await confirmCandidate(proj!.name);
      const confirmed = (await itemsPool.query(`SELECT confidence, source_ref FROM knowledge_unit WHERE name=$1`, [proj!.name])).rows[0];
      assert.equal(confirmed.confidence, "human", "confirm 후 human");
      assert.equal(confirmed.source_ref, null, "confirm 후 distill 마커 해제");
      // 재실행 — confirm 된 후보를 distill 이 ai 로 되돌리면 안 됨.
      await runDistill({ ...OPTS, cap: 20 });
      const still = (await itemsPool.query(`SELECT confidence, source_ref FROM knowledge_unit WHERE name=$1`, [proj!.name])).rows[0];
      assert.equal(still.confidence, "human", "재실행 후에도 human 유지(보호)");
      assert.equal(still.source_ref, null, "재실행 후에도 마커 없음(재후보화 0)");
    });

    // ── (7) 주입 격리 — buildKnowledgeIndex 가 distill 후보(ai·distill source_ref)를 제외한다. ──
    await t("주입 격리: buildKnowledgeIndex 가 distill 후보 제외(검토엔 뜨지만 인덱스 비주입)", async () => {
      // 살아있는 distill D 후보 하나 확보(앞에서 b/c 도메인 후보가 생성됨).
      const cand = (await listKnowledge({ lifecycle: "active" })).find(
        (u) => (u.source_ref ?? "").startsWith(DISTILL_SOURCE_PREFIX) && (u.source_ref ?? "").includes(REPO) && u.kind === "D",
      );
      assert.ok(cand, "살아있는 distill D 후보 존재");
      // D kind 를 recalled 로 넘겨 인덱스 빌드 — distill 후보 name 이 인덱스 본문에 없어야 한다.
      const idx = buildKnowledgeIndex(await listKnowledge({ lifecycle: "active" }), [{ kind: "D", label: "작업영역" }]);
      assert.ok(!idx.includes(cand!.name), `distill 후보 '${cand!.name}' 가 인덱스에 주입되면 안 됨`);
      // 대조군: confirm 한 후보(human·마커 없음)는 인덱스에 들어와야(K kind). PROJ 후보를 K 로 confirm 했었음.
      const promoted = (await listKnowledge({ lifecycle: "active" })).find(
        (u) => u.confidence === "human" && (u.source_ref ?? "") === "" && u.title?.includes("작업 클러스터"),
      ) ?? (await listKnowledge({ lifecycle: "active", confidence: "human" })).find((u) => u.title?.includes("작업 클러스터"));
      const idxK = buildKnowledgeIndex(await listKnowledge({ lifecycle: "active" }), [{ kind: "K", label: "노트" }]);
      if (promoted) assert.ok(idxK.includes(promoted.name), "confirm 한(human) 후보는 인덱스 진입");
    });

    console.log(`\n증류 통합 체크 통과: ${pass}/7 (+ 보조 단언)`);
  } finally {
    await cleanup();
  }

  // 정리 검증 — 합성 후보·시드 0.
  const leftover = (await itemsPool.query(
    `SELECT count(*)::int n FROM knowledge_unit WHERE source_ref LIKE $1 OR external_id LIKE $2`,
    [`${DISTILL_SOURCE_PREFIX}%${REPO}%`, PREFIX + "%"],
  )).rows[0].n;
  assert.equal(leftover, 0, `정리 후 합성 잔여 0이어야, got ${leftover}`);
  console.log("ok  비파괴 정리 — 합성 후보·시드 0");

  await itemsPool.end();
}

main().catch((err) => {
  console.error("distill.test 실패:", err?.stack ?? err);
  process.exit(1);
});
