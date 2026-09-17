// 새 워크스페이스의 증류·분류 자동 실행 기본값(#4052) — 사양 엣지 표 C·E.
//
//  이 계약이 깨지면 조용히 틀어진다: 기본값이 사람이 꺼 둔 잡을 되살리거나(C2·C7), 화면이 만드는 잡과 id 가 갈려
//  같은 단계가 두 번 돌거나(C5), 운영 계정이 기본 실행 계정으로 앉아 아무도 모르게 실패한다(E).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { DEFAULT_CONTEXT_JOBS, seedDefaultContextJobs } from "./default-jobs.js";
import { CRON_ACTION_ALLOWLIST } from "../schema/sessions-infra.js";
import type { CronJobInsert, CronJobRow } from "../cron-store.js";
import { runnerFillRefusal } from "../../capabilities/delivery/runtime-config.js";

// dist/org/pipeline/ → 레포 루트
const read = (rel: string): string => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
const code = (s: string): string => s.split("\n").filter((l) => {
  const t = l.trim();
  return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
}).join("\n");

/** 삽입 대역 — 이미 있는 id 는 null(삽입 안 됨), 없는 id 는 행. 호출 인자를 모두 남긴다. */
function fakeInsert(existing: string[]) {
  const calls: CronJobInsert[] = [];
  const fn = async (v: CronJobInsert): Promise<CronJobRow | null> => {
    calls.push(v);
    return existing.includes(v.id) ? null : { id: v.id, enabled: v.enabled };
  };
  return { calls, fn };
}

const run = async (): Promise<void> => {
  const ids = DEFAULT_CONTEXT_JOBS.map((j) => j.id);
  assert.deepEqual(ids, ["distill-sources-headless", "classify-knowledge-headless"], "기본 잡은 증류·분류 둘");

  // ★ C1 둘 다 없음 → 둘 다 **켠 채로**, 계정은 박지 않고, 만든 사람을 남긴다.
  {
    const f = fakeInsert([]);
    const out = await seedDefaultContextJobs("maker", f.fn);
    assert.deepEqual(out, ids, "C1 만든 id 둘");
    assert.equal(f.calls.length, 2, "C1 배선 — 삽입이 실제로 두 번 불렸다");
    for (const c of f.calls) {
      assert.equal(c.enabled, true, `C1 ${c.id} 는 켠 채로`);
      assert.deepEqual(JSON.parse(c.params), {}, `C1 ${c.id} 의 params 에 실행 계정을 박지 않는다(워크스페이스 실행 멤버를 따른다)`);
      assert.equal(c.actor, "maker", "C1 만든 사람");
      assert.equal(c.cron_expr, null, "C1 주기(interval)로 돈다");
      assert.ok(!c.run_once, "C1 한 번만 돌고 꺼지는 잡이 아니다");
    }
  }
  // C2 둘 다 이미 있음 → 아무것도 만들지 않는다(삽입 전용이라 기존 행은 그대로).
  {
    const f = fakeInsert(ids);
    assert.deepEqual(await seedDefaultContextJobs("maker", f.fn), [], "C2 이미 있으면 없음");
  }
  // C3 하나만 있음 → 없는 것만.
  {
    const f = fakeInsert(["distill-sources-headless"]);
    assert.deepEqual(await seedDefaultContextJobs("maker", f.fn), ["classify-knowledge-headless"], "C3 없는 것만");
  }
  // C4 만든 사람을 모르면 지어내지 않는다.
  {
    const f = fakeInsert([]);
    await seedDefaultContextJobs(null, f.fn);
    assert.ok(f.calls.every((c) => c.actor === null), "C4 actor null 그대로");
  }

  // ★ C5 화면의 [자동 실행 켜기] 명세와 id·action·주기가 같다 — 갈리면 같은 단계의 잡이 둘 생긴다.
  const spec = (src: string): { id: string; action: string; interval: number } => {
    //  명세 안에 `params: {}` 가 있어 `[^}]` 로는 못 건넌다 — 거리를 묶은 [\s\S] 로 같은 명세 안에서만 잇는다.
    const m = /create:\s*\{\s*id:\s*'([^']+)'[\s\S]{0,300}?action:\s*'([^']+)'[\s\S]{0,120}?interval_sec:\s*(\d+)/.exec(code(src));
    assert.ok(m, "화면 명세를 찾지 못했다(vacuous 방지)");
    return { id: m[1], action: m[2], interval: Number(m[3]) };
  };
  const screens: Record<string, { id: string; action: string; interval: number }> = {
    "distill-sources-headless": spec(read("web/distillers.ts")),
    "classify-knowledge-headless": spec(read("web/context-classify.ts")),
  };
  for (const j of DEFAULT_CONTEXT_JOBS) {
    const s = screens[j.id];
    assert.ok(s, `C5 ${j.id} 의 화면 명세`);
    assert.deepEqual({ id: j.id, action: j.action, interval: j.interval_sec }, s, `C5 ${j.id} 가 화면 명세와 같다`);
    // C6 크론 허용목록 안 — 밖이면 저장이 제약 위반으로 죽는다(#1419).
    assert.ok((CRON_ACTION_ALLOWLIST as readonly string[]).includes(j.action), `C6 ${j.action} 허용목록`);
  }

  // ★ C7 삽입은 **덮지 않는다** — 사람이 꺼 둔 잡·주기를 바꾼 잡을 되살리면 안 된다.
  {
    const cron = code(read("src/org/cron-store.ts"));
    const i = cron.indexOf("export async function insertCronJobIfAbsent");
    assert.ok(i >= 0, "C7 insertCronJobIfAbsent 가 있다");
    const body = cron.slice(i, cron.indexOf("export async function", i + 10));
    assert.match(body, /ON CONFLICT DO NOTHING/, "C7 충돌 시 아무것도 안 한다");
    assert.ok(!/DO UPDATE/.test(body), "C7 DO UPDATE 가 없다");
    assert.match(code(read("src/org/pipeline/default-jobs.ts")), /insert: typeof insertCronJobIfAbsent = insertCronJobIfAbsent/, "C7 기본 삽입기가 그 함수다");
  }

  // ★ C8 셀프호스트 workspace_create — 새 워크스페이스 문맥 안에서 기본 잡을 심고, 만든 사람을 실행 멤버로(정해진 적 없을 때만).
  {
    const ws = code(read("src/capabilities/delivery/workspace-registry.ts"));
    const i = ws.indexOf('restWork("workspace_create"');
    const j = ws.indexOf("restWork(", i + 10);
    assert.ok(i >= 0 && j > i, "C8 workspace_create 를 찾았다");
    const body = ws.slice(i, j);
    const inTenant = body.slice(body.indexOf("await withTenant("));
    assert.match(inTenant, /await seedDefaultContextJobs\(actorOf\(user\)\)\.catch\(/, "C8 기본 잡 — 테넌트 문맥 안 · 비치명");
    assert.match(inTenant, /await fillContextJobRunnerIfUnset\(id, actorOf\(user\), "workspace_create"\)\.catch\(/, "C8 실행 멤버 — 조건부 · 비치명");
    // 매니지드 갈래는 CP 가 워크스페이스를 만든다 — 그 갈래에서 코어가 심으면 엉뚱한(지금) 테넌트에 심는다.
    const managed = body.slice(body.indexOf("if (managedMode())"), body.indexOf("requireRegistry();"));
    assert.ok(managed.length > 0 && !/seedDefaultContextJobs|fillContextJobRunnerIfUnset/.test(managed), "C8 매니지드 갈래에서는 심지 않는다");
  }

  // ── E 조건부 실행 멤버 채우기 — 사람만 ──
  assert.ok(runnerFillRefusal("x", null), "E1 없는 구성원 거절");
  assert.ok(runnerFillRefusal("x", { state: "inactive", kind: "human" }), "E2 비활성 사람 거절");
  assert.ok(runnerFillRefusal("x", { state: "active", kind: "agent" }), "E3 AI 구성원 거절");
  assert.ok(runnerFillRefusal("admin", { state: "active", kind: "system" }), "★ E4 운영 계정(system) 거절");
  assert.ok(runnerFillRefusal("x", { state: "active", kind: null }), "E4' 종류 모름 거절");
  assert.equal(runnerFillRefusal("x", { state: "active", kind: "human" }), null, "E5 활성 사람 허용");
  {
    const rc = code(read("src/capabilities/delivery/runtime-config.ts"));
    const i = rc.indexOf('name: "org_context_job_runner_fill"');
    assert.ok(i >= 0, "E6 op 가 있다");
    const body = rc.slice(i, rc.indexOf("\n  },\n", i));
    assert.match(body, /scope: "admin"/, "E6 admin 전용");
    assert.match(body, /mcp: false/, "E6 MCP 비노출");
    assert.match(body, /"POST", paths: \["\/api\/ui\/org\/context-job-runner\/fill"\]/, "E6 REST 경로");
    // 거절이 채우기보다 **먼저** 온다 — 순서가 뒤집히면 운영 계정이 먼저 앉는다.
    const refuse = body.indexOf("runnerFillRefusal(id, m)");
    const fill = body.indexOf("fillContextJobRunnerIfUnset(m.id");
    assert.ok(refuse > 0 && fill > refuse, "E6 거절 판정 → 채우기 순서");
    assert.match(body.slice(refuse, fill), /throw new HttpError\(400/, "E6 거절이면 던진다");
  }

  console.log("✓ default-jobs — 새 워크스페이스 증류·분류 기본 켬 (C1~C8) · 조건부 실행 멤버 채우기 (E1~E6)");
};

await run();
