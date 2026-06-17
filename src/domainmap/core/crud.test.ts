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
import { createRepo, renameRepo, setRepoState, getRepo } from "./repos.js";
import { createDomain, renameDomain } from "./domains.js";
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

    console.log(`\nP-V3-4a CRUD 테스트 전부 통과 (${pass}건)`);
  } finally {
    await cleanup();
    await endPool();
  }
}

main().catch(async (e) => { console.error(e); try { await endPool(); } catch {} process.exit(1); });
