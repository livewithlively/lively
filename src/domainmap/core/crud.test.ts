// P-V3-4a 도메인/repo 통제어휘 CRUD + soft-alias(H3) + 권한(M-마) 통합 테스트.
//  실행: npm run build && node --env-file-if-exists=.env dist/domainmap/core/crud.test.js
//  DOMAINMAP_DATABASE_URL 미설정이면 graceful skip(빌드 게이트 통과).
//  **비파괴**: 합성 repo('crudtest__…' 무작위 접미)만 만들고 finally 에서 그 repo·도메인·별칭·change_log 를
//  전부 정리 — 라이브 repo(lively/productivity/e2e-sandbox)·실 도메인 무영향. 보호 리포 가드는 'lively' 로 검증.
//  커버: (1) repo create/rename/deprecate + 멱등 no-op (2) domain create(중복/별칭충돌 409) (3) domain rename
//        soft-alias: 물리 key 불변·별칭 적재·resolveDomainKey 해소(체인·사이클 가드) (4) name-only rename(별칭 무적재)
//        (5) 권한: 보호 리포(lively) create/rename/deprecate 403, agent→human-origin 도메인 rename 403.
import assert from "node:assert/strict";
import { dmPool, endPool } from "../db.js";
import { init } from "./schema.js";
import { createRepo, renameRepo, setRepoState, getRepo, hardDeleteRepo } from "./repos.js";
import { createDomain, renameDomain, domainDeleteRefs, hardDeleteDomain } from "./domains.js";
import { resolveDomainKey } from "./domain-alias.js";
import type { Actor } from "./types.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn(); pass++; console.log(`ok  ${name}`);
};
const expectErr = async (fn: () => Promise<unknown>, status: number, substr: string): Promise<void> => {
  try { await fn(); assert.fail(`expected throw (status ${status})`); }
  catch (e: any) {
    if (e?.message?.startsWith("expected throw")) throw e;
    assert.equal(e.status, status, `status: ${e.status} ≠ ${status} (msg: ${e.message})`);
    assert.ok(String(e.message).includes(substr), `'${substr}' not in: ${e.message}`);
  }
};

const HUMAN: Actor = { type: "human", id: "crudtest" };
const AGENT: Actor = { type: "agent", id: "crudtest-agent" };

async function main(): Promise<void> {
  if (!process.env.DOMAINMAP_DATABASE_URL) {
    console.log("skip  DOMAINMAP_DATABASE_URL 미설정 — P-V3-4a CRUD 통합 체크 건너뜀(빌드 게이트는 통과)");
    return;
  }
  await init();
  const pool = dmPool();
  const REPO = "crudtest-" + Math.random().toString(36).slice(2, 8);
  const REPO2 = REPO + "-renamed";
  let repoId = -1;

  const cleanup = async (): Promise<void> => {
    // 합성 repo 가 어떤 이름으로 끝나든(rename 가능) id 로 자식 전부 제거 — 비파괴 보증.
    if (repoId > 0) {
      await pool.query("DELETE FROM domain_alias WHERE repo_id=$1", [repoId]);
      await pool.query("DELETE FROM domain WHERE repo_id=$1", [repoId]);
      await pool.query("DELETE FROM change_log WHERE repo_id=$1", [repoId]);
      await pool.query("DELETE FROM repo WHERE id=$1", [repoId]);
    }
  };

  try {
    // ── repo CRUD ──
    await t("repo_create — 신규 repo active 착지", async () => {
      const r = await createRepo(REPO, HUMAN);
      repoId = r.id;
      assert.ok(r.id > 0 && r.name === REPO && r.change_id > 0);
      const row = await pool.query("SELECT state FROM repo WHERE id=$1", [r.id]);
      assert.equal(row.rows[0].state, "active");
    });
    await t("repo_create — 형식/중복 검증", async () => {
      await expectErr(() => createRepo("bad name!", HUMAN), 400, "bad repo name");
      await expectErr(() => createRepo(REPO, HUMAN), 409, "already exists");
    });
    await t("권한: 보호 리포(lively) create 403", async () => {
      await expectErr(() => createRepo("lively", HUMAN), 403, "reserved");
    });

    // ── domain CRUD ──
    let dId = -1;
    await t("domain_create — 신규 도메인 confirmed", async () => {
      const d = await createDomain(REPO, { key: "billing", name: "결제" }, HUMAN);
      dId = d.id;
      assert.ok(d.id > 0 && d.key === "billing" && d.status === "confirmed");
    });
    await t("domain_create — 중복 key 409", async () => {
      await expectErr(() => createDomain(REPO, { key: "billing", name: "x" }, HUMAN), 409, "already exists");
      await expectErr(() => createDomain(REPO, { key: "BAD KEY", name: "x" }, HUMAN), 400, "bad key");
    });

    // ── domain rename = soft-alias(H3) ──
    await t("domain_rename — soft-alias: 물리 key 불변 + 별칭 적재 + name 갱신", async () => {
      const r = await renameDomain(dId, { newKey: "payments", newName: "결제·정산" }, HUMAN);
      assert.equal(r.aliased, true);
      assert.equal(r.key, "billing", "물리 key 는 불변이어야 함");
      assert.equal(r.new_key, "payments");
      // 물리 domain.key 가 정말 안 바뀌었는지 직접 확인(cross-DB 회피의 핵심 불변식).
      const dom = await pool.query("SELECT key, name FROM domain WHERE id=$1", [dId]);
      assert.equal(dom.rows[0].key, "billing", "DB 물리 key 불변");
      assert.equal(dom.rows[0].name, "결제·정산", "표시명만 갱신");
      // 별칭 행 적재됨(payments → billing).
      const al = await pool.query("SELECT new_key FROM domain_alias WHERE repo_id=$1 AND old_key=$2", [repoId, "payments"]);
      assert.equal(al.rows[0].new_key, "billing");
    });
    await t("resolveDomainKey — 새 슬러그·옛 슬러그 모두 canonical 로 해소", async () => {
      assert.equal(await resolveDomainKey(repoId, "payments"), "billing", "새 슬러그 → 물리 key");
      assert.equal(await resolveDomainKey(repoId, "billing"), "billing", "물리 key → 그대로");
      assert.equal(await resolveDomainKey(repoId, "nonexistent-xyz"), "nonexistent-xyz", "별칭 없으면 입력 그대로");
    });
    await t("domain_create — rename 별칭 old_key(payments→billing) 재사용 거부 409", async () => {
      // payments 는 billing 의 별칭 → resolveDomainKey 가 canonical 'billing' 으로 접고,
      // billing 도메인이 살아 있으므로 'already exists' 로 막힌다(중복 차단 자체가 목적).
      await expectErr(() => createDomain(REPO, { key: "payments", name: "x" }, HUMAN), 409, "already exists");
    });
    await t("domain_rename — 체인(payments→billing 위에 다시 fee 추가) + 사이클 가드", async () => {
      const r = await renameDomain(dId, { newKey: "fee" }, HUMAN);
      assert.equal(r.aliased, true);
      assert.equal(await resolveDomainKey(repoId, "fee"), "billing", "fee → billing(물리)");
      // 사이클 시도: billing → fee 별칭을 강제 적재 후 해소가 무한루프 대신 종료하는지.
      await pool.query("INSERT INTO domain_alias(repo_id,old_key,new_key,created_at) VALUES($1,'billing','fee',now()) ON CONFLICT DO NOTHING", [repoId]);
      const resolved = await resolveDomainKey(repoId, "fee"); // fee→billing→fee(사이클) — 가드가 멈춤
      assert.ok(resolved === "billing" || resolved === "fee", `사이클 가드 종료: ${resolved}`);
      await pool.query("DELETE FROM domain_alias WHERE repo_id=$1 AND old_key='billing'", [repoId]); // 사이클 정리
    });
    await t("domain_rename — name-only(newKey 없음): 별칭 무적재", async () => {
      const r = await renameDomain(dId, { newName: "결제(개명)" }, HUMAN);
      assert.equal(r.aliased, false, "newKey 없으면 별칭 적재 안 함");
      const dom = await pool.query("SELECT key, name FROM domain WHERE id=$1", [dId]);
      assert.equal(dom.rows[0].key, "billing");
      assert.equal(dom.rows[0].name, "결제(개명)");
    });
    await t("domain_rename — 빈 변경 400", async () => {
      await expectErr(() => renameDomain(dId, {}, HUMAN), 400, "nothing to rename");
    });

    // ── 권한(M-마) ──
    await t("권한: agent → human-origin 도메인 rename 403", async () => {
      // billing 은 HUMAN 이 만들어 origin='human' → agent rename 거부.
      await expectErr(() => renameDomain(dId, { newName: "agent 시도" }, AGENT), 403, "human-curated");
    });
    await t("권한: agent 자기소유(origin=agent) 도메인 rename 허용", async () => {
      const ad = await createDomain(REPO, { key: "agentdom", name: "에이전트 도메인" }, AGENT);
      const r = await renameDomain(ad.id, { newName: "에이전트 개명" }, AGENT);
      assert.equal(r.after.name, "에이전트 개명");
    });
    await t("권한: 보호 리포(lively) domain create/rename 403", async () => {
      await expectErr(() => createDomain("lively", { key: "x", name: "x" }, HUMAN), 403, "write-protected");
    });

    // ── domain hard-delete(영구삭제) — domainmap-DB cascade/guard. 원 REPO 비파괴(전용 도메인만 생성·삭제). ──
    await t("domain_delete — 매핑 없는 도메인 cascade 삭제 + 별칭 정리", async () => {
      const d = await createDomain(REPO, { key: "deldom", name: "삭제대상" }, HUMAN);
      // 별칭 적재(deldom-alias → deldom) — hard-delete 가 물리key 별칭을 함께 지우는지 확인.
      await renameDomain(d.id, { newKey: "deldom-alias" }, HUMAN);
      const refs = await domainDeleteRefs(d.id);
      assert.equal(refs.key, "deldom");
      assert.equal(refs.liveMappings, 0, "매핑 없음");
      const res = await hardDeleteDomain(d.id, HUMAN);
      assert.ok("deleted" in res && res.deleted === true);
      assert.equal(res.removed.aliases, 1, "물리key 가리키던 별칭 1행 삭제");
      const gone = await pool.query("SELECT id FROM domain WHERE id=$1", [d.id]);
      assert.equal(gone.rows.length, 0, "도메인 행 영구삭제");
      const al = await pool.query("SELECT id FROM domain_alias WHERE repo_id=$1 AND old_key='deldom-alias'", [repoId]);
      assert.equal(al.rows.length, 0, "별칭 행도 삭제");
    });
    await t("domain_delete — merged 도메인 400 / 없는 id 404", async () => {
      await expectErr(() => domainDeleteRefs(999999999), 404, "no such domain");
      // merged 시뮬: 새 도메인 만들어 state='merged' 강제 후 거부 확인.
      const md = await createDomain(REPO, { key: "mergeddel", name: "x" }, HUMAN);
      await pool.query("UPDATE domain SET state='merged' WHERE id=$1", [md.id]);
      await expectErr(() => domainDeleteRefs(md.id), 400, "merged");
      await expectErr(() => hardDeleteDomain(md.id, HUMAN), 400, "merged");
      await pool.query("DELETE FROM domain WHERE id=$1", [md.id]); // 정리
    });

    // ── repo hard-delete(영구삭제) — 자식 가드 + force cascade. **전용 2차 repo**(원 REPO 비파괴) ──
    await t("repo_delete — 자식 가드/force cascade(전용 합성 repo, 원 REPO 무영향)", async () => {
      const REPO_DEL = "crudtest-del-" + Math.random().toString(36).slice(2, 8);
      const r2 = await createRepo(REPO_DEL, HUMAN);
      try {
        const dr = await createDomain(REPO_DEL, { key: "guarddom", name: "가드" }, HUMAN);
        // 자식 있으면 blocked(무삭제).
        const blocked = await hardDeleteRepo(REPO_DEL, false, HUMAN);
        assert.ok("blocked" in blocked && blocked.blocked === true, "자식 도메인 있으니 blocked");
        assert.ok(blocked.refs.domains >= 1, "도메인 카운트 안내");
        const still = await pool.query("SELECT id FROM domain WHERE id=$1", [dr.id]);
        assert.equal(still.rows.length, 1, "blocked 면 무삭제");
        // force cascade — repo+자식 전삭제.
        const res = await hardDeleteRepo(REPO_DEL, true, HUMAN);
        assert.ok("deleted" in res && res.deleted === true);
        assert.ok(res.removed.domains >= 1, "도메인 cascade 삭제");
        const goneRepo = await pool.query("SELECT id FROM repo WHERE id=$1", [r2.id]);
        assert.equal(goneRepo.rows.length, 0, "repo 행 영구삭제");
        const goneDom = await pool.query("SELECT id FROM domain WHERE repo_id=$1", [r2.id]);
        assert.equal(goneDom.rows.length, 0, "repo 하위 도메인 전삭제");
      } finally {
        // 혹시 cascade 전 단계에서 실패하면 합성 2차 repo 잔여 정리(비파괴 보증).
        await pool.query("DELETE FROM domain WHERE repo_id=$1", [r2.id]);
        await pool.query("DELETE FROM change_log WHERE repo_id=$1", [r2.id]);
        await pool.query("DELETE FROM repo WHERE id=$1", [r2.id]);
      }
    });
    await t("repo_delete — 보호 리포(lively) 403", async () => {
      await expectErr(() => hardDeleteRepo("lively", false, HUMAN), 403, "write-protected");
    });

    // ── repo rename/deprecate ──
    await t("repo_rename — 이름변경(물리, soft-alias 불요)", async () => {
      const r = await renameRepo(REPO, REPO2, HUMAN);
      assert.equal(r.new_name, REPO2);
      const got = await getRepo(REPO2);
      assert.equal(got.id, repoId, "같은 repo id 유지");
    });
    await t("권한: 보호 리포(lively) rename 403", async () => {
      await expectErr(() => renameRepo("lively", "lively2", HUMAN), 403, "write-protected");
    });
    await t("repo_deprecate — state 전환 + 멱등 no-op", async () => {
      const r1 = await setRepoState(REPO2, "deprecated", HUMAN);
      assert.equal((r1 as any).state, "deprecated");
      const r2 = await setRepoState(REPO2, "deprecated", HUMAN); // no-op
      assert.equal((r2 as any).action, "unchanged");
      assert.ok(!("change_id" in r2), "no-op 은 change_id 키 부재가 계약");
      const r3 = await setRepoState(REPO2, "active", HUMAN); // undo
      assert.equal((r3 as any).state, "active");
    });
    await t("권한: 보호 리포(lively) deprecate 403", async () => {
      await expectErr(() => setRepoState("lively", "deprecated", HUMAN), 403, "write-protected");
    });

    console.log(`\nP-V3-4a CRUD + hard-delete 테스트 전부 통과 (${pass}건)`);
  } finally {
    await cleanup();
    await endPool();
  }
}

main().catch(async (e) => { console.error(e); try { await endPool(); } catch {} process.exit(1); });
