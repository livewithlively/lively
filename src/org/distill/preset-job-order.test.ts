// 프리셋이 잡을 증류기보다 먼저 만드는가 (#2415 후속) — 순서가 뒤바뀌면 잡이 둘이 되어 배치가 두 번 나간다.
//  실측(2026-08-30 온보딩): distill-lanes{} 와 distill-local-files{local-files} 가 공존해 local-files 가 이중 처리됐다.
//  여기서는 순수 판정(planDistillJob)으로 그 순서의 결과를 재현한다 — DB 없이 경계를 잰다.
import test from "node:test";
import assert from "node:assert/strict";
import { planDistillJob, ALL_LANES_JOB_ID, type DistillJobRow } from "./ensure-job.js";
import { LOCAL_DISTILLER_KEY, LOCAL_DISTILL_JOB_ID } from "./local-preset.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pinned: DistillJobRow = { id: LOCAL_DISTILL_JOB_ID, enabled: true, params: { distiller: LOCAL_DISTILLER_KEY } };

test("① 잡을 먼저 만든 뒤 local-files 를 켜면 — 아무것도 더 만들지 않는다(잡 1개)", () => {
  const p = planDistillJob([pinned], LOCAL_DISTILLER_KEY);
  assert.equal(p.action, "none");
});

test("② 잡 없이 local-files 를 먼저 켜면 — 전체 접수 잡이 새로 생긴다(그래서 둘이 된다)", () => {
  const p = planDistillJob([], LOCAL_DISTILLER_KEY);
  assert.equal(p.action, "create");
  assert.equal((p as { jobId: string }).jobId, ALL_LANES_JOB_ID);
});

test("③ 그 뒤 리브가 첫 레인을 켜면 묶음이 풀려 하나로 수렴한다", () => {
  const p = planDistillJob([pinned], "liv-d-abc");
  assert.equal(p.action, "widen");
  assert.equal((p as { jobId: string }).jobId, LOCAL_DISTILL_JOB_ID);
});

test("④ 풀린 뒤에는 레인을 더 켜도 잡을 안 만든다", () => {
  const widened: DistillJobRow = { id: LOCAL_DISTILL_JOB_ID, enabled: true, params: {} };
  assert.equal(planDistillJob([widened], "liv-d-def").action, "none");
});

// ── ★ 순서 자체를 지키는 가드 ──────────────────────────────────────────────
//  위 판정 테스트는 "순서가 틀리면 어떻게 되는지"를 적어 둘 뿐, 순서가 되돌아가도 통과한다.
//  실제 회귀는 **호출 순서**에서 나므로 소스에서 그것을 직접 단언한다
//  (이 레포의 선례: v6/…/workspace-tenant-1to1.test.ts 가 같은 방식으로 DELETE 순서를 지킨다).
test("⑤ local-preset 은 잡을 증류기 upsert 보다 먼저 만든다 — 순서가 곧 계약이다", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist 에서 돌므로 소스는 레포 루트 기준으로 찾는다.
  const src = path.resolve(here, "../../../src/org/distill/local-preset.ts");
  const body = fs.readFileSync(src, "utf8");
  const fn = body.indexOf("export async function ensureLocalFilesDistiller");
  assert.ok(fn > 0, "ensureLocalFilesDistiller 를 못 찾았다");
  const job = body.indexOf("upsertCronJob(", fn);
  const dist = body.indexOf("upsertDistiller(", fn);
  assert.ok(job > 0 && dist > 0, "두 호출을 못 찾았다");
  assert.ok(job < dist,
    `잡 생성(${job})이 증류기 upsert(${dist}) 뒤에 있다 — 켜는 순간 ensureJobForEnabled 가 전체 접수 잡을 따로 만들어 배치가 두 번 나간다`);
});
