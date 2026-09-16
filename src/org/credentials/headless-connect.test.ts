// 헤드리스 자격 — 저장 · 기본 실행 멤버 · 실패 표시 · 실패 알림의 계약 (#4051). DB 없이 주입 seam 으로 잰다.
//  행 번호(S1… P1… N1…)는 스크래치패드 spec.md 의 엣지 표다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decideRunnerFill, validateHeadlessSecret, storeHeadlessCredential, pickFailures, headlessNotice,
  notifyHeadlessCredentialProblem, HEADLESS_NOTICE_COOLDOWN_MS, HEADLESS_NOTICE_HREF, HEADLESS_NOTICE_APP,
  type StoreDeps,
} from "./headless-connect.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const TOKEN = "sk-ant-oat01-" + "Qq7_-".repeat(18) + "endAA";
const CODEX = JSON.stringify({ tokens: { access_token: "a", refresh_token: "r", account_id: "acc-9" }, last_refresh: "2026-09-17T00:00:00Z" });

/** 기록하는 가짜 의존성 — 무엇이 **실제로 불렸나**로 단언한다. */
function fakeDeps(o: {
  current?: { label: string | null; meta: Record<string, unknown> } | null;
  policy?: { current: string | null; source: "db" | "env" | "default" } | (() => never);
  fillResult?: boolean;
  storeThrows?: Error;
} = {}) {
  const calls = { store: [] as unknown[][], fill: [] as unknown[][], policy: 0 };
  const deps: StoreDeps = {
    current: async () => o.current ?? null,
    store: async (...a) => { calls.store.push(a); if (o.storeThrows) throw o.storeThrows; },
    policy: async () => {
      calls.policy++;
      if (typeof o.policy === "function") return o.policy();
      return o.policy ?? { current: null, source: "default" };
    },
    fillRunner: async (...a) => { calls.fill.push(a); return o.fillResult ?? true; },
    now: () => new Date("2026-09-17T01:02:03.000Z"),
  };
  return { deps, calls };
}

await t("★ S1 관리자 · 정해진 적 없음 → 그 사람 비밀로 저장하고 실행 멤버로 채운다(기존 이름·부속 보존)", async () => {
  const { deps, calls } = fakeDeps({ current: { label: "내 토큰", meta: { note: "keep" } } });
  const r = await storeHeadlessCredential({ memberId: "kim", harness: "claude", secret: `  ${TOKEN}\n`, actor: "kim", isAdmin: true }, deps);
  assert.deepEqual(r, { ok: true, kind: "claude_setup_token", runner: "filled" });
  assert.equal(calls.store.length, 1);
  const [owner, kind, secret, label, meta, actor] = calls.store[0] as [string, string, string, string | null, Record<string, unknown>, string];
  assert.equal(owner, "member:kim", "판이 찾는 주인 이름(member:<실행 멤버 id>)");
  assert.equal(kind, "claude_setup_token");
  assert.equal(secret, TOKEN, "앞뒤 공백은 걷고 저장한다");
  assert.equal(label, "내 토큰", "사람이 붙인 이름을 지우지 않는다");
  assert.deepEqual(meta, { note: "keep", issued_via: "screen", issued_at: "2026-09-17T01:02:03.000Z" });
  assert.equal(actor, "kim");
  assert.deepEqual(calls.fill, [["kim", "kim"]]);
});

await t("★ S2 관리자가 아니면 워크스페이스 기본값을 건드리지 않는다(저장은 한다)", async () => {
  const { deps, calls } = fakeDeps();
  const r = await storeHeadlessCredential({ memberId: "lee", harness: "claude", secret: TOKEN, actor: "lee", isAdmin: false }, deps);
  assert.deepEqual(r, { ok: true, kind: "claude_setup_token", runner: "not-admin" });
  assert.equal(calls.store.length, 1);
  assert.equal(calls.fill.length, 0, "채우기를 부르지 않는다");
});

await t("★ S3 관리자가 비워 둔 것(명시 null)은 결정이다 — 되살리지 않는다", async () => {
  const { deps, calls } = fakeDeps({ policy: { current: null, source: "db" } });
  const r = await storeHeadlessCredential({ memberId: "kim", harness: "claude", secret: TOKEN, actor: "kim", isAdmin: true }, deps);
  assert.equal(r.ok && r.runner, "cleared");
  assert.equal(calls.fill.length, 0);
});

await t("★ S4 이미 정해져 있으면(누구든) 그대로 둔다", async () => {
  for (const policy of [{ current: "park", source: "db" as const }, { current: "kim", source: "db" as const }, { current: "env-man", source: "env" as const }]) {
    const { deps, calls } = fakeDeps({ policy });
    const r = await storeHeadlessCredential({ memberId: "kim", harness: "claude", secret: TOKEN, actor: "kim", isAdmin: true }, deps);
    assert.equal(r.ok && r.runner, "already-set", JSON.stringify(policy));
    assert.equal(calls.fill.length, 0);
  }
});

await t("★ S5 동시에 채우다 지면(원자적 쓰기가 0행) «이미 정해짐» 으로 말한다", async () => {
  const { deps, calls } = fakeDeps({ fillResult: false });
  const r = await storeHeadlessCredential({ memberId: "kim", harness: "claude", secret: TOKEN, actor: "kim", isAdmin: true }, deps);
  assert.equal(r.ok && r.runner, "already-set");
  assert.equal(calls.fill.length, 1);
});

await t("★ S6·S10 모양이 틀린 값은 저장하지 않는다", async () => {
  for (const [harness, secret] of [["claude", "sk-ant-api03-" + "x".repeat(90)], ["claude", ""], ["claude", `${TOKEN} extra`],
    ["codex", "{not json"], ["codex", JSON.stringify({ hello: 1 })]] as const) {
    const { deps, calls } = fakeDeps();
    const r = await storeHeadlessCredential({ memberId: "kim", harness, secret, actor: "kim", isAdmin: true }, deps);
    assert.equal(r.ok, false, `${harness}:${secret.slice(0, 20)}`);
    assert.equal(calls.store.length, 0, "저장을 부르지 않는다");
    assert.equal(calls.fill.length, 0);
  }
  assert.equal(validateHeadlessSecret("claude", TOKEN).ok, true);
  assert.equal(validateHeadlessSecret("codex", CODEX).ok, true);
});

await t("★ S7 저장이 실패하면 한 줄로 말하되 값은 싣지 않는다", async () => {
  const { deps, calls } = fakeDeps({ storeThrows: new Error(`encryption key missing near ${TOKEN.slice(0, 5)}`) });
  const r = await storeHeadlessCredential({ memberId: "kim", harness: "claude", secret: TOKEN, actor: "kim", isAdmin: true }, deps);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && !r.error.includes(TOKEN), "비밀값이 문장에 없다");
  assert.ok(!r.ok && r.error.length > 0);
  assert.equal(calls.fill.length, 0, "저장 못 했으면 실행 멤버도 채우지 않는다");
});

await t("★ S8 설정을 못 읽어도 저장 성공은 뒤집지 않는다", async () => {
  const { deps } = fakeDeps({ policy: () => { throw new Error("db down"); } });
  const r = await storeHeadlessCredential({ memberId: "kim", harness: "claude", secret: TOKEN, actor: "kim", isAdmin: true }, deps);
  assert.deepEqual(r, { ok: true, kind: "claude_setup_token", runner: "error" });
});

await t("★ S9 codex 는 codex_auth_json 으로 저장한다", async () => {
  const { deps, calls } = fakeDeps();
  const r = await storeHeadlessCredential({ memberId: "kim", harness: "codex", secret: CODEX, actor: "kim", isAdmin: false }, deps);
  assert.equal(r.ok && r.kind, "codex_auth_json");
  assert.equal((calls.store[0] as unknown[])[1], "codex_auth_json");
  assert.equal((calls.store[0] as unknown[])[2], CODEX);
});

await t("★ S(표) 채울지 판정 — 네 갈래", () => {
  assert.equal(decideRunnerFill({ current: null, source: "default", isAdmin: true }), "fill");
  assert.equal(decideRunnerFill({ current: null, source: "default", isAdmin: false }), "not-admin");
  assert.equal(decideRunnerFill({ current: null, source: "db", isAdmin: true }), "cleared");
  assert.equal(decideRunnerFill({ current: "x", source: "default", isAdmin: true }), "already-set");
  assert.equal(decideRunnerFill({ current: "x", source: "db", isAdmin: false }), "already-set");
});

await t("★ P1~P6 실패 표시 — 하네스별 최신 1건, 다시 연결하면 지운다, 경계는 연결이 이긴다", () => {
  const rows = [
    { id: 9, harness: "claude", finished_at: "2026-09-17T05:00:00Z", reason: "no_credential", auth_label: null },
    { id: 8, harness: "claude", finished_at: "2026-09-17T04:00:00Z", reason: null, auth_label: "토큰 폐기(revoked)" },
    { id: 7, harness: "codex", finished_at: "2026-09-16T10:00:00Z", reason: null, auth_label: "401" },
    { id: 6, harness: "grok", finished_at: "2026-09-17T06:00:00Z", reason: "no_credential", auth_label: null },
    { id: 5, harness: "codex", finished_at: null, reason: "no_credential", auth_label: null },
  ];
  //  P1·P3 — 연결 기록이 없으면 최신 1건씩.
  const a = pickFailures(rows, {});
  assert.equal(a.claude?.task_id, 9);
  assert.equal(a.claude?.reason, "no_credential");
  assert.equal(a.codex?.task_id, 7, "시각 없는 행(P5)은 건너뛰고 그 다음 행");
  assert.equal(a.codex?.reason, "auth_failure");
  assert.ok(!("grok" in a), "모르는 하네스(P5)는 건너뛴다");
  //  P2 — 실패 뒤에 다시 연결했으면 사라진다(claude 는 05:00 실패, 06:00 연결).
  const b = pickFailures(rows, { claude: "2026-09-17T06:00:00Z", codex: "2026-09-16T09:00:00Z" });
  assert.equal(b.claude, undefined);
  assert.equal(b.codex?.task_id, 7, "연결 뒤에 난 실패는 남는다(P3)");
  //  P4 — 경계: 실패 시각 == 연결 시각이면 연결이 이긴다.
  const c = pickFailures(rows, { claude: "2026-09-17T05:00:00Z" });
  assert.equal(c.claude, undefined);
  //  P6 — 사유별 문장.
  assert.match(String(a.claude?.message), /연결돼 있지 않아/);
  const d = pickFailures([rows[1]], {});
  assert.match(String(d.claude?.message), /인증에 실패/);
  assert.match(String(d.claude?.message), /토큰 폐기\(revoked\)/, "인증 실패는 그 이름표를 함께 말한다");
});

await t("★ N1 알림 한 건 — 창 주소 · 하네스×사유 중복키 · 반나절 억제 · 알림 권한 빌트인", async () => {
  const sent: Record<string, unknown>[] = [];
  const ok = await notifyHeadlessCredentialProblem({ memberId: "kim", harness: "claude", reason: "no_credential" },
    async (i) => { sent.push(i); return { ok: true }; });
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].memberId, "kim");
  assert.equal(sent[0].appId, HEADLESS_NOTICE_APP);
  assert.equal(sent[0].href, "#/me/ai");
  assert.equal(sent[0].href, HEADLESS_NOTICE_HREF);
  assert.equal(sent[0].dedupe_key, "headless-cred:claude:no_credential");
  assert.equal(sent[0].cooldownMs, 12 * 60 * 60_000);
  assert.equal(HEADLESS_NOTICE_COOLDOWN_MS, 12 * 60 * 60_000);
  const n2 = headlessNotice({ harness: "codex", reason: "auth_failure", label: "401" });
  assert.equal(n2.dedupe_key, "headless-cred:codex:auth_failure", "사유가 다르면 따로 울린다");
  assert.match(n2.body, /401/);
  assert.ok(n2.title.length <= 120 && n2.body.length <= 400, "앱 알림 길이 상한 안");
  //  빌트인 매니페스트가 실제로 알림 권한을 선언하나(안 하면 조용히 거부된다).
  const manifest = JSON.parse(readFileSync(new URL(`../../../apps/builtin/${HEADLESS_NOTICE_APP}/lively-app.json`, import.meta.url).pathname.replace("/dist/", "/"), "utf8"));
  assert.equal(manifest.permissions?.notifications, true);
});

await t("★ N2·N3 알림은 던지지 않고, 받을 사람이 없으면 부르지 않는다", async () => {
  let called = 0;
  const boom = async () => { called++; throw new Error("down"); };
  assert.equal(await notifyHeadlessCredentialProblem({ memberId: "kim", harness: "claude", reason: "auth_failure" }, boom), false);
  assert.equal(called, 1);
  assert.equal(await notifyHeadlessCredentialProblem({ memberId: "", harness: "claude", reason: "no_credential" }, boom), false);
  assert.equal(called, 1, "빈 멤버에게는 호출 0");
  const denied = async () => ({ ok: false });
  assert.equal(await notifyHeadlessCredentialProblem({ memberId: "kim", harness: "claude", reason: "no_credential" }, denied), false);
});

// ── 배선(소스 계약) — DB·스케줄러를 띄우지 않고 «그 자리에 그 호출이 있나» 를 본다 ──
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

await t("★ N4·N5 스케줄러 — 판 자격 표에 있는 하네스만 · 맥락 잡의 인증 실패만 멤버에게 알린다", () => {
  const s = code(src("../../node/task-scheduler.ts"));
  const i = s.indexOf('reason: "no_credential", last_assign');
  assert.ok(i > 0, "자격 없음 종결 자리를 찾았다");
  const branch = s.slice(i, i + 600);
  assert.match(branch, /if \(cred\) await notifyHeadless\(\{ memberId: t\.requester, harness: t\.harness, reason: "no_credential" \}\)/);
  assert.match(s, /if \(auth && isContextJob\(t\)\) await notifyHeadless\(\{ memberId: t\.requester, harness: t\.harness, reason: "auth_failure", label: auth\.label \}\)/);
  assert.match(s, /async function notifyHeadless[^]*?try \{[^]*?notifyHeadlessCredentialProblem\(o\)[^]*?\} catch/, "알림 실패가 tick 을 깨지 않는다");
});

await t("★ N6 앱 토큰 알림은 서버 전용 칸을 넘기지 못한다 · 서버 호출은 억제 간격을 넘긴다", () => {
  const cap = code(src("../../capabilities/app-notifications.ts"));
  assert.ok(!/notifyMember\(\{[^}]*\.\.\.input/.test(cap), "입력을 통째로 펼치지 않는다");
  assert.match(cap, /title: input\.title, body: input\.body, href: input\.href, dedupe_key: input\.dedupe_key/);
  const n = code(src("../../apps/notify.ts"));
  assert.match(n, /shouldSuppressDuplicate\(norm\.value\.dedupeKey, last, now, input\.cooldownMs\)/);
});

await t("★ S(원자성) 실행 멤버 채우기는 한 문장 — 이 워크스페이스 행 · 키가 없을 때만 · env 시드가 있으면 안 함", () => {
  const s = code(src("../store/runtime-config.ts"));
  const i = s.indexOf("export async function fillContextJobRunnerIfUnset");
  assert.ok(i > 0);
  const body = s.slice(i, i + 1200);
  assert.match(body, /WHERE id = 1 AND tenant_id = \$\{TENANT_DEFAULT_EXPR\}/);
  assert.match(body, /NOT \(COALESCE\(context_job_policy, '\{\}'::jsonb\) \? 'runner_member'\)/);
  assert.match(body, /contextJobPolicySource\(\{\}\) === "env"\) return false/);
  assert.match(body, /if \(!r\.rowCount\) return false/);
  assert.match(body, /await audit\(/, "바꿨으면 감사 기록을 남긴다");
});

console.log(`\n${pass} passed`);
