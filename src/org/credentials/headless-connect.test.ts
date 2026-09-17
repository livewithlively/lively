// 헤드리스 자격 — 저장 · 기본 실행 멤버 · 실패 표시 · 실패 알림의 계약 (#4051). DB 없이 주입 seam 으로 잰다.
//  행 번호(S1… P1… N1…)는 스크래치패드 spec.md 의 엣지 표다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decideRunnerFill, validateHeadlessSecret, storeHeadlessCredential, pickFailures, headlessNotice,
  notifyHeadlessCredentialProblem, HEADLESS_NOTICE_COOLDOWN_MS, HEADLESS_NOTICE_HREF, HEADLESS_NOTICE_APP,
  isActiveAdminMember, memberIsAdminNow, headlessAdminFor, claimRunnerFromScreen, hasHeadlessCredential, headlessCredentialRow,
  type StoreDeps, type ClaimDeps,
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

// ── 관리자 판정 · 화면에서 실행 멤버 정하기 (M — 2026-09-17 실측 뒤) ──

await t("★ M1·M2·M3 관리자 판정은 구성원의 실제 역할 — 활성 + admin(로그인 토큰의 권한이 아니다)", async () => {
  assert.equal(isActiveAdminMember({ state: "active", scopes: ["items", "admin"] }), true, "M1");
  assert.equal(isActiveAdminMember({ state: "active", scopes: ["items", "context", "runtime"] }), false, "M2 역할에 admin 이 없다");
  assert.equal(isActiveAdminMember({ state: "disabled", scopes: ["admin"] }), false, "M3 비활성");
  assert.equal(isActiveAdminMember(null), false, "M3 없음");
  assert.equal(isActiveAdminMember({ state: "active", scopes: "admin" }), false, "모르는 모양은 아니다");
  const seen: string[] = [];
  const lookup = async (id: string) => {
    seen.push(id);
    return id === "boss" ? { state: "active", scopes: ["admin"] } : id === "staff" ? { state: "active", scopes: ["items"] } : null;
  };
  assert.equal(await memberIsAdminNow("boss", lookup), true);
  assert.equal(await memberIsAdminNow("staff", lookup), false);
  assert.equal(await memberIsAdminNow("ghost", lookup), false);
  assert.deepEqual(seen, ["boss", "staff", "ghost"], "배선 — 그 멤버의 기록을 실제로 읽었다");
});

await t("★ M4 구성원을 못 읽으면 관리자가 아니다(닫힌 쪽)", async () => {
  assert.equal(await memberIsAdminNow("x", async () => { throw new Error("db down"); }), false);
});

await t("★ M1·M2 헤드리스 경로의 관리자 판정 한 벌 — 토큰 admin 이거나 구성원 역할 admin · 정적·앱 토큰은 안 된다", async () => {
  const seen: string[] = [];
  const lookup = async (id: string) => { seen.push(id); return id === "boss" ? { state: "active", scopes: ["admin"] } : { state: "active", scopes: ["items"] }; };
  assert.equal(await headlessAdminFor({ tokenSource: "db", scopes: ["items", "code"] }, "boss", lookup), true,
    "M1 데스크톱 기기 토큰(admin 없음)이어도 구성원이 관리자면 관리자");
  assert.equal(await headlessAdminFor({ tokenSource: "db", scopes: ["items"] }, "staff", lookup), false, "M2 둘 다 아니면 아니다");
  assert.deepEqual(seen, ["boss", "staff"], "배선 — 토큰에 admin 이 없을 때 구성원 기록을 실제로 읽었다");
  seen.length = 0;
  assert.equal(await headlessAdminFor({ tokenSource: "session", scopes: ["admin"] }, "ghost", lookup), true,
    "토큰(세션) admin 이면 관리자 — 구성원 조회가 비어 오는 자리(보조 워크스페이스)에서도 종전보다 좁아지지 않는다");
  assert.deepEqual(seen, [], "토큰이 이미 관리자면 묻지 않는다");
  assert.equal(await headlessAdminFor({ tokenSource: "static", scopes: ["admin"] }, "boss", lookup), false,
    "회수할 수 없는 정적 토큰은 정책을 못 쓴다(web.ts B5 와 같은 선)");
  assert.equal(await headlessAdminFor({ tokenSource: "db", scopes: ["admin"], appId: "some-app" }, "boss", lookup), false,
    "앱 세션 토큰도 못 쓴다(requireAppTool 과 같은 선)");
  assert.equal(await headlessAdminFor({ scopes: "admin" }, "staff", lookup), false, "모르는 모양의 토큰 권한은 권한이 아니다");
});

await t("★ M6·M8 «연결됨» 한 벌 — 화면의 버튼 조건과 서버의 409 가 같은 규칙", () => {
  const row = (kind: string, o: { scope_key?: string | null; has_secret?: boolean } = {}) => ({ kind, scope_key: "", has_secret: true, ...o });
  assert.equal(hasHeadlessCredential([row("claude_setup_token")]), true);
  assert.equal(hasHeadlessCredential([row("codex_auth_json")]), true, "codex 만 있어도 판은 돈다");
  assert.equal(hasHeadlessCredential([row("claude_setup_token", { has_secret: false })]), false, "행만 있고 값이 없다");
  assert.equal(hasHeadlessCredential([row("claude_setup_token", { scope_key: "repo-x" })]), false, "기본 칸이 아니다(판은 기본 칸을 빌린다)");
  assert.equal(hasHeadlessCredential([row("anthropic_api_key")]), false, "판이 빌리는 종류가 아니다");
  assert.equal(hasHeadlessCredential([]), false);
  assert.equal(headlessCredentialRow([row("claude_setup_token", { scope_key: null })], "claude")?.kind, "claude_setup_token", "칸이 비어 온 행도 기본 칸이다");
  assert.equal(headlessCredentialRow([row("claude_setup_token")], "codex"), undefined);
});

/** 화면 정하기의 가짜 의존성 — 무엇이 불렸나를 센다. */
function claimDeps(o: { cred?: boolean; policy?: { current: string | null; source: "db" | "env" | "default" }; fillResult?: boolean } = {}) {
  const calls = { hasCredential: [] as string[], policy: 0, fill: [] as unknown[][] };
  const deps: ClaimDeps = {
    hasCredential: async (id) => { calls.hasCredential.push(id); return o.cred ?? true; },
    policy: async () => { calls.policy++; return o.policy ?? { current: null, source: "default" }; },
    fillRunner: async (...a) => { calls.fill.push(a); return o.fillResult ?? true; },
  };
  return { deps, calls };
}

await t("★ M6·M10 화면에서 정하기 — 관리자 · 자격 있음 · 미지정 → 요청한 본인으로 채운다", async () => {
  const { deps, calls } = claimDeps();
  assert.deepEqual(await claimRunnerFromScreen({ memberId: "boss", actor: "boss", isAdmin: true }, deps), { ok: true, runner: "filled" });
  assert.deepEqual(calls.fill, [["boss", "boss"]], "M10 대상은 요청한 본인");
  assert.deepEqual(calls.hasCredential, ["boss"], "배선 — 그 멤버의 자격을 실제로 물었다");
});

await t("★ M7·M8 비관리자는 403 · 자격이 없으면 409 — 둘 다 아무것도 바꾸지 않는다", async () => {
  const a = claimDeps();
  const r1 = await claimRunnerFromScreen({ memberId: "staff", actor: "staff", isAdmin: false }, a.deps);
  assert.equal(r1.ok === false && r1.status, 403);
  assert.deepEqual([a.calls.hasCredential.length, a.calls.policy, a.calls.fill.length], [0, 0, 0], "M7 아무것도 묻지도 쓰지도 않는다");
  const b = claimDeps({ cred: false });
  const r2 = await claimRunnerFromScreen({ memberId: "boss", actor: "boss", isAdmin: true }, b.deps);
  assert.equal(r2.ok === false && r2.status, 409);
  assert.match(r2.ok === false ? r2.error : "", /연결해 주세요/, "무엇을 하면 되는지 말한다");
  assert.deepEqual([b.calls.policy, b.calls.fill.length], [0, 0], "M8 자격 없는 멤버를 앉히면 모든 맥락 잡이 멈춘다");
});

await t("★ M9 관리자가 비워 둔 자리 · 이미 정해진 자리는 그대로 — 결과로 말한다", async () => {
  const claim = (d: ClaimDeps) => claimRunnerFromScreen({ memberId: "boss", actor: "boss", isAdmin: true }, d);
  const cleared = claimDeps({ policy: { current: null, source: "db" } });
  assert.deepEqual(await claim(cleared.deps), { ok: true, runner: "cleared" });
  assert.equal(cleared.calls.fill.length, 0, "비운 것은 결정이다");
  const taken = claimDeps({ policy: { current: "other", source: "db" } });
  assert.deepEqual(await claim(taken.deps), { ok: true, runner: "already-set" });
  assert.equal(taken.calls.fill.length, 0);
  const raced = claimDeps({ fillResult: false });
  assert.deepEqual(await claim(raced.deps), { ok: true, runner: "already-set" }, "동시에 누가 먼저 채웠다");
});

await t("★ 배선 M1·M5·M10·M12 — 헤드리스 경로 셋이 판정 한 벌만 쓰고 · 정하기는 본인만 · 저장 결과를 로그에", () => {
  const r = code(src("../../terminal/routes.ts"));
  const from = r.indexOf('"/api/ui/me/headless-login/start"');
  const to = r.indexOf('app.post("/api/ui/me/ai-accounts/logout"');
  assert.ok(from > 0 && to > from, "헤드리스 경로 묶음을 찾았다");
  const block = r.slice(from, to);
  assert.equal((block.match(/await headlessAdminFor\((user|userOf\(req\)), me\)/g) || []).length, 3, "저장 · 상태 · 정하기 세 자리 모두 한 벌");
  assert.ok(!/isAdmin\(|\.scopes\b|memberIsAdminNow\(/.test(block), "헤드리스 경로가 판정을 따로 만들지 않는다(토큰 권한·구성원 조회 직접 사용 금지)");
  assert.match(block, /secret: got\.captured, actor: me, isAdmin: await headlessAdminFor\(user, me\)/, "M1 저장");
  assert.match(block, /headlessStatusFor\(\{ memberId: me, isAdmin: await headlessAdminFor\(userOf\(req\), me\) \}\)/, "M5 상태");
  const at = block.indexOf('app.post("/api/ui/me/headless/runner"');
  assert.ok(at > 0, "정하기 경로가 있다");
  const claim = block.slice(at, block.indexOf("}));", at));
  assert.match(claim, /claimRunnerFromScreen\(\{ memberId: me, actor: me, isAdmin: await headlessAdminFor\(userOf\(req\), me\) \}\)/);
  assert.ok(!/req\.(body|query|params)/.test(claim), "M10 요청에서 멤버를 읽지 않는다 — 대상은 인증된 본인");
  assert.match(claim, /throw new HttpError\(out\.status, out\.error\)/, "거절은 그 상태코드로");
  assert.match(block, /logger\.info\(\{ member: me, harness: h, stored: r\.ok, runner: r\.ok \? r\.runner : null \}/, "M12");
  const hc = code(src("./headless-connect.ts"));
  assert.match(hc, /fillContextJobRunnerIfUnset\(memberId, actor, "headless-claim"\)/, "정하기의 감사 출처는 자동 채우기와 가른다");
  assert.match(hc, /fillContextJobRunnerIfUnset\(memberId, actor, "headless-connect"\)/);
  assert.match(hc, /hasCredential: async \(id\) => hasHeadlessCredential\(/, "409 판정은 «연결됨» 한 벌");
  assert.match(hc, /const c = headlessCredentialRow\(creds, h\);/, "화면의 «연결됨» 도 같은 한 벌");
});

console.log(`\n${pass} passed`);
