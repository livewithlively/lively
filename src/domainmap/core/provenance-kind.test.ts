// P-V3-4b project '붕뜸' 해소 — provenance_kind 분리(initiative vs code_grouping) + 네임스페이스 가드(M-나) 통합 테스트.
//  실행: npm run build && node --env-file-if-exists=.env dist/domainmap/core/provenance-kind.test.js
//  DOMAINMAP_DATABASE_URL 미설정이면 graceful skip(빌드 게이트 통과).
//  **비파괴**: 합성 repo('pkindtest-…' 무작위 접미)만 만들고 finally 에서 그 repo·project·change_log·scan_run 을
//  전부 정리 — 라이브 repo(lively/productivity/e2e-sandbox)·실 project 49행 무영향(읽기 단언만 한다).
//  커버: (1) syncProject(PM provenance) → provenance_kind='initiative' (2) ingest(doc-derived) → 'code_grouping'
//        (3) 네임스페이스 가드: doc-derived 신규 key 가 'clickup-' 접두면 400 거부 (4) 백필 휴리스틱이 라이브
//        49행에서 measured 5 initiative(4 PM source + 1 human) / 44 code_grouping 와 일치 (5) CHECK 제약 존재.
import assert from "node:assert/strict";
import { dmPool, endPool } from "../db.js";
import { init } from "./schema.js";
import { syncProject } from "./projects.js";
import { ingest } from "./reconcile.js";
import { isReservedProvenanceKey } from "./types.js";
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

const AGENT: Actor = { type: "agent", id: "pkindtest-agent" };

async function main(): Promise<void> {
  if (!process.env.DOMAINMAP_DATABASE_URL) {
    console.log("skip  DOMAINMAP_DATABASE_URL 미설정 — P-V3-4b provenance_kind 통합 체크 건너뜀(빌드 게이트는 통과)");
    return;
  }
  await init();
  const pool = dmPool();
  const REPO = "pkindtest-" + Math.random().toString(36).slice(2, 8);
  let repoId = -1;

  const cleanup = async (): Promise<void> => {
    if (repoId > 0) {
      await pool.query("DELETE FROM project_touch WHERE repo_id=$1", [repoId]);
      await pool.query("DELETE FROM project WHERE repo_id=$1", [repoId]);
      await pool.query("DELETE FROM mapping WHERE repo_id=$1", [repoId]);
      await pool.query("DELETE FROM code_unit WHERE repo_id=$1", [repoId]);
      await pool.query("DELETE FROM domain WHERE repo_id=$1", [repoId]);
      await pool.query("DELETE FROM change_log WHERE repo_id=$1", [repoId]);
      await pool.query("DELETE FROM scan_run WHERE repo_id=$1", [repoId]);
      await pool.query("DELETE FROM repo WHERE id=$1", [repoId]);
    }
  };

  try {
    // 합성 repo 생성(ingest 가 upsertRepo 로 만들지만, syncProject 는 기존 repo 를 요구하므로 먼저 만든다).
    const r = await pool.query(
      "INSERT INTO repo(name,detected_stack,state,created_at,last_scan_at) VALUES($1,'{}','active',now(),now()) RETURNING id", [REPO]);
    repoId = r.rows[0].id;

    // ── (1) syncProject(PM provenance) → provenance_kind='initiative' ──
    await t("syncProject → provenance_kind='initiative'", async () => {
      const res: any = await syncProject(REPO, {
        prov_system: "clickup", prov_instance: "pkind-inst", external_id: "pkind-901", name: "테스트 이니셔티브",
        state: "active", external_url: "https://example.test/901",
      }, AGENT);
      assert.equal(res.action, "insert");
      const row = (await pool.query("SELECT key, provenance_kind, origin FROM project WHERE id=$1", [res.id])).rows[0];
      assert.equal(row.provenance_kind, "initiative", "PM provenance 는 initiative");
      assert.equal(row.origin, "source");
      assert.ok(row.key.startsWith("clickup-"), `key 는 PM 접두('clickup-…'): ${row.key}`);
    });

    // ── (2) ingest(doc-derived) → provenance_kind='code_grouping' ──
    await t("ingest(doc-derived) → provenance_kind='code_grouping'", async () => {
      await ingest({
        repo: { name: REPO },
        run: { actor_type: "agent", actor_id: "pkindtest-agent", runbook: "bootstrap-domains" },
        projects: [{ key: "doc-derived-grp", name: "문서파생 그룹" }],
      });
      const row = (await pool.query("SELECT provenance_kind, origin FROM project WHERE repo_id=$1 AND key=$2", [repoId, "doc-derived-grp"])).rows[0];
      assert.equal(row.provenance_kind, "code_grouping", "doc-derived 는 code_grouping");
      assert.equal(row.origin, "agent");
    });

    // ── (3) 네임스페이스 가드(M-나): doc-derived 신규 key 가 PM 접두면 400 거부 ──
    await t("네임스페이스 가드: doc-derived 'clickup-' 접두 key INSERT 400 거부", async () => {
      await expectErr(() => ingest({
        repo: { name: REPO },
        run: { actor_type: "agent", actor_id: "pkindtest-agent" },
        projects: [{ key: "clickup-deadbeef", name: "침범 시도" }],
      }), 400, "reserved PM-provenance prefix");
      // 거부됐으므로 그 key 의 행은 적재되지 않았다.
      const n = (await pool.query("SELECT count(*)::int n FROM project WHERE repo_id=$1 AND key=$2", [repoId, "clickup-deadbeef"])).rows[0].n;
      assert.equal(n, 0, "거부된 key 행 미적재");
    });
    await t("isReservedProvenanceKey 단언", async () => {
      assert.equal(isReservedProvenanceKey("clickup-123"), true);
      assert.equal(isReservedProvenanceKey("Jira-XYZ"), true, "대소문자 무관");
      assert.equal(isReservedProvenanceKey("infra-cicd"), false);
      assert.equal(isReservedProvenanceKey("mcp-gateway-build"), false);
    });

    // ── (4) 백필 휴리스틱이 라이브 49행 measured 분류와 일치(읽기 단언만, 비파괴) ──
    await t("라이브 49행 measured 분류 일치(5 initiative / 44 code_grouping)", async () => {
      // 합성 repo 제외(라이브 repo 만 본다).
      const rows = (await pool.query(
        `SELECT provenance_kind, count(*)::int n FROM project WHERE repo_id<>$1 GROUP BY provenance_kind ORDER BY provenance_kind`,
        [repoId])).rows;
      const m: Record<string, number> = {};
      for (const x of rows) m[x.provenance_kind ?? "NULL"] = x.n;
      // 라이브 데이터가 변할 수 있으므로 합/관계로 단언(부풀린 하드코딩 회피):
      //  - NULL 은 0(백필 완료) - initiative 는 PM-provenance(external_id NOT NULL) + human origin 합과 동치.
      assert.equal(m.NULL ?? 0, 0, "백필 후 NULL 없음");
      const detail = (await pool.query(
        `SELECT
           count(*) FILTER (WHERE external_id IS NOT NULL) AS ext,
           count(*) FILTER (WHERE external_id IS NULL AND origin='human') AS human_noext,
           count(*) FILTER (WHERE external_id IS NULL AND origin='agent') AS agent_noext
         FROM project WHERE repo_id<>$1`, [repoId])).rows[0];
      const expectedInit = Number(detail.ext) + Number(detail.human_noext);
      const expectedCode = Number(detail.agent_noext);
      assert.equal(m.initiative ?? 0, expectedInit, `initiative = ext(${detail.ext}) + human_noext(${detail.human_noext})`);
      assert.equal(m.code_grouping ?? 0, expectedCode, `code_grouping = agent_noext(${detail.agent_noext})`);
      console.log(`    measured: initiative=${m.initiative ?? 0}(ext ${detail.ext}+human ${detail.human_noext}) code_grouping=${m.code_grouping ?? 0}`);
    });

    // ── (5) CHECK 제약 존재 + enum 밖 값 거부 ──
    await t("project_provenance_kind_chk 제약 존재 + enum 밖 값 거부", async () => {
      const c = (await pool.query(
        `SELECT 1 FROM pg_constraint WHERE conrelid='project'::regclass AND conname='project_provenance_kind_chk'`)).rowCount;
      assert.equal(c, 1, "CHECK 제약 존재");
      await assert.rejects(
        () => pool.query("UPDATE project SET provenance_kind='bogus' WHERE repo_id=$1", [repoId]),
        /provenance_kind_chk|check constraint/i, "enum 밖 값은 CHECK 위반");
    });

    console.log(`\nP-V3-4b provenance_kind 테스트 전부 통과 (${pass}건)`);
  } finally {
    await cleanup();
    await endPool();
  }
}

main().catch(async (e) => { console.error(e); try { await endPool(); } catch {} process.exit(1); });
