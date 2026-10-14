// 수집 판(gateway-job) — 코어 쪽 판정·op 배선 (#3994 T3). 사양 spec-run-unit 의 E-R·E-D·E-E·E-A·E-C·E-L·E-G·E-J 표.
//
//  왜 표로 재나: 전부 조용히 틀린다 — 호스트 자리가 판에 새면 판이 없는 경로에 쓰고, 판을 못 쓰는 사유가 안 남으면
//   교대에 끊기는 수집이 «판에서 도는 줄» 로 보이고, busy 를 실패로 적으면 서킷브레이커가 멀쩡한 수집기를 끈다.
//  ★ op 는 가짜 유닉스 소켓으로 흉내 낸다 — 무엇이 실제로 도착했는지를 서버 쪽에서 기록해 단언한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  JOB_ENV_DROP, JOB_ENV_MAX_BYTES, JOB_ENV_PROTECTED, JOB_EXIT_NOENV, JOB_EXIT_NOROW, JOB_RUNTIME_SEC, JOB_UNIT_MARK,
  applyJobEnv, classifyLaunch, jobArgs, jobEnvDoc, jobGoneReason, jobRoute, jobRouteNote, jobUnitLive, jobUnitName,
  launchMayHaveStarted, launchRunUnit, parseJobArgs, parseJobEnvDoc, reapFinishedRunUnits, runIdOfJobDir, runUnitState,
  serializeJobEnv, stopRunUnit, syncChildArgv, type JobRouteInput, type JobSpec, type JobUnitState,
} from "./run-unit.js";
import { connectors } from "./index.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "run-unit-"));
const ROOTFS = "/var/lib/lvly/images/flat-core-abc/rootfs";
const base: JobRouteInput = { sandbox: true, codeRoot: ROOTFS, slug: "acme", switchValue: undefined, needsGatewayDisk: false };

// ── E-R 경로 ─────────────────────────────────────────────────────────────────
test("[E-R] 경로 — 판은 op·코드 자리·slug 가 다 있고, 꺼지지 않았고, 커넥터가 디스크에 안 기댈 때만", () => {
  assert.deepEqual(jobRoute(base), { unit: true });
  //  op 없음이 최우선 — 셀프호스트는 나머지를 묻지 않는다
  assert.deepEqual(jobRoute({ sandbox: false, codeRoot: null, slug: null, switchValue: "off", needsGatewayDisk: null }), { unit: false, why: "no_op" });
  for (const v of ["off", " OFF ", "Off"]) assert.deepEqual(jobRoute({ ...base, switchValue: v }), { unit: false, why: "switch_off" }, v);
  for (const v of ["on", "", "0", "false", null]) assert.deepEqual(jobRoute({ ...base, switchValue: v }), { unit: true }, `«off» 만 끈다: ${v}`);
  for (const cr of [undefined, null, "", "  "]) assert.deepEqual(jobRoute({ ...base, codeRoot: cr }), { unit: false, why: "no_code_root" }, String(cr));
  for (const s of [undefined, null, ""]) assert.deepEqual(jobRoute({ ...base, slug: s }), { unit: false, why: "no_slug" }, String(s));
  assert.deepEqual(jobRoute({ ...base, needsGatewayDisk: true }), { unit: false, why: "gateway_disk" });
  assert.deepEqual(jobRoute({ ...base, needsGatewayDisk: null }), { unit: false, why: "unknown_connector" }, "모르는 커넥터를 판으로 보내지 않는다");
});

test("[E-R2] 판을 못 쓰는 사유는 run 로그에 남는다 — 셀프호스트(no_op)만 조용하다", () => {
  assert.equal(jobRouteNote({ unit: true }), null);
  assert.equal(jobRouteNote({ unit: false, why: "no_op" }), null);
  const seen = new Set<string>();
  for (const why of ["switch_off", "no_code_root", "no_slug", "unknown_connector", "gateway_disk"] as const) {
    const n = jobRouteNote({ unit: false, why });
    assert.ok(n && n.startsWith("[tracker] 게이트웨이 자식으로 실행") && n.includes("교대에 끊길 수"), `${why}: ${n}`);
    seen.add(n!);
  }
  assert.equal(seen.size, 5, "사유마다 다른 문장이어야 무엇을 고칠지 안다");
});

// ── E-N 이름 (P9) ────────────────────────────────────────────────────────────
test("[E-N] 판 이름·폴더 — op 의 gateway-job 규칙(`-j1`)이고 context 판(`-a<n>`)과 안 겹친다 · 형식 밖은 던진다", () => {
  assert.equal(JOB_UNIT_MARK, "j");
  assert.equal(jobUnitName("lively-46e3", 2622), "lvly-task-lively-46e3-2622-j1");
  assert.equal(jobUnitName("a", Number.MAX_SAFE_INTEGER), `lvly-task-a-${Number.MAX_SAFE_INTEGER}-j1`);
  assert.notEqual(jobUnitName("acme", 12), "lvly-task-acme-12-a1");
  for (const slug of ["Acme", "acme/x", "", "-acme", "a".repeat(64)]) assert.throws(() => jobUnitName(slug, 1), slug);
  assert.equal(jobUnitName("a".repeat(63), 1), `lvly-task-${"a".repeat(63)}-1-j1`, "slug 63자 경계");
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) assert.throws(() => jobUnitName("acme", bad), String(bad));
  assert.equal(runIdOfJobDir("2622-j1"), 2622);
  assert.equal(runIdOfJobDir("9007199254740991-j1"), Number.MAX_SAFE_INTEGER);
  for (const n of ["2622-a1", "2622-j2", "0-j1", "02-j1", "x-j1", "2622-j1.tmp", "12345678901234567-j1", "9999999999999999-j1", ""]) {
    assert.equal(runIdOfJobDir(n), null, n);
  }
});

// ── E-D 디스크 표지 ───────────────────────────────────────────────────────────
test("[E-D] 게이트웨이 디스크에 기대는 커넥터는 notion·domain-wiki 둘뿐이다(표지 부재 = 안 기댐)", () => {
  const leaning = Object.entries(connectors).filter(([, c]) => c.needsGatewayDisk === true).map(([k]) => k).sort();
  assert.deepEqual(leaning, ["domain-wiki", "notion"]);
  for (const [k, c] of Object.entries(connectors)) {
    assert.ok(c.needsGatewayDisk === undefined || typeof c.needsGatewayDisk === "boolean", `${k} 표지 형식`);
  }
});

// ── E-E env ──────────────────────────────────────────────────────────────────
const GW_ENV: NodeJS.ProcessEnv = {
  ITEMS_DATABASE_URL: "postgres://app:s3cret@db.internal:5432/lively",
  LIVELY_TENANT_BINDING: "rls", LIVELY_TENANT_ID: "0f5a5c1e-1111-4222-8333-944455556666",
  LIVELY_SKIP_SCHEMA_INIT: "1", CONNECTOR_SECRET_KEY: "k", LIVELY_TENANT_HEADER_SECRET: "h", PUBLIC_URL: "https://app.lvly.io",
  TZ: "Asia/Seoul", LVLY_EMBED_KEY: "e",
  PATH: "/var/lib/lvly/images/x/rootfs/usr/local/bin:/usr/bin", HOME: "/var/lib/lvly/gw/lvly-gw-central", TMPDIR: "/tmp/gw",
  LIVELY_STATE_DIR: "/var/lib/lvly/gw/lvly-gw-central/data", LIVELY_LOG_DIR: "/var/lib/lvly/gw/lvly-gw-central/logs",
  LIVELY_CODE_ROOT: "/var/lib/lvly/images/x/rootfs",
  LIVELY_TMUX_EXEC: "/x/node /x/tmux-relay.cjs {slug}", LIVELY_MEMBER_EXEC: "/usr/bin/node /srv/x.mjs {slug}",
  LIVELY_SESSION_EXEC: "/x", LIVELY_SESSION_ENSURE: "/y",
  LVLY_HUB_SECRET: "hub", LVLY_HUB_URL: "http://127.0.0.1:9093",
  LIVELY_TASK_OP_SOCK: "/run/lvly/task/op.sock", LIVELY_GATEWAY_JOB: "on",
  INVOCATION_ID: "abc", JOURNAL_STREAM: "8:1", CREDENTIALS_DIRECTORY: "/run/credentials/x", SYSTEMD_EXEC_PID: "7",
  "BAD-KEY": "x",
};

test("[E-E1] 판에 넘길 env — 수집 입력은 그대로, 호스트 자리·중계·허브·op 손잡이·systemd 것은 뺀다", () => {
  const doc = jobEnvDoc(GW_ENV);
  for (const k of ["ITEMS_DATABASE_URL", "LIVELY_TENANT_BINDING", "LIVELY_TENANT_ID", "LIVELY_SKIP_SCHEMA_INIT", "CONNECTOR_SECRET_KEY",
    "LIVELY_TENANT_HEADER_SECRET", "PUBLIC_URL", "TZ", "LVLY_EMBED_KEY"]) {
    assert.equal(doc[k], GW_ENV[k], `${k} 가 빠졌다 — 판 수집이 자식 길과 다른 입력으로 돈다`);
  }
  for (const k of ["PATH", "HOME", "TMPDIR", "LIVELY_STATE_DIR", "LIVELY_LOG_DIR", "LIVELY_CODE_ROOT", "LIVELY_TMUX_EXEC", "LIVELY_MEMBER_EXEC",
    "LIVELY_SESSION_EXEC", "LIVELY_SESSION_ENSURE", "LVLY_HUB_SECRET", "LVLY_HUB_URL", "LIVELY_TASK_OP_SOCK", "LIVELY_GATEWAY_JOB",
    "INVOCATION_ID", "JOURNAL_STREAM", "CREDENTIALS_DIRECTORY", "SYSTEMD_EXEC_PID", "BAD-KEY"]) {
    assert.ok(!(k in doc), `${k} 가 판에 넘어갔다`);
  }
  assert.equal(Object.keys(doc).length, 9, "남는 키는 수집 입력 9개뿐");
  assert.deepEqual(Object.keys(doc), [...Object.keys(doc)].sort(), "키 순서가 결정적이다");
});

test("[E-E2] 직렬화 상한 — 정확히 64KB 는 통과, 1바이트 넘으면 던진다(잘라 보내지 않는다)", () => {
  const skeleton = JSON.stringify({ ITEMS_DATABASE_URL: "p", PAD: "" }).length;
  const exact = { ITEMS_DATABASE_URL: "p", PAD: "a".repeat(JOB_ENV_MAX_BYTES - skeleton) };
  assert.equal(serializeJobEnv(exact).length, JOB_ENV_MAX_BYTES);
  assert.deepEqual(JSON.parse(serializeJobEnv(exact).toString("utf8")), exact);
  assert.throws(() => serializeJobEnv({ ...exact, PAD: exact.PAD + "a" }), /상한/);
  //  바이트로 센다 — 한글 한 자는 3바이트
  const kor = { ITEMS_DATABASE_URL: "p", PAD: "가".repeat(Math.floor((JOB_ENV_MAX_BYTES - skeleton) / 3) + 1) };
  assert.throws(() => serializeJobEnv(kor), /상한/);
});

test("[E-E3] 판 안 env 문서 해석 — 객체·문자열 값·키 형식·DB 주소(비지 않음) 필수, 하나라도 어기면 전체 거부", () => {
  assert.deepEqual(parseJobEnvDoc('{"ITEMS_DATABASE_URL":"postgres://x","A_1":""}'), { ITEMS_DATABASE_URL: "postgres://x", A_1: "" });
  for (const bad of ["", "nope", "[]", "null", "42", '"s"', '{"A":1,"ITEMS_DATABASE_URL":"p"}', '{"A":null,"ITEMS_DATABASE_URL":"p"}',
    '{"bad-key":"x","ITEMS_DATABASE_URL":"p"}', '{"1A":"x","ITEMS_DATABASE_URL":"p"}', '{"A":"x"}', '{"ITEMS_DATABASE_URL":""}']) {
    assert.throws(() => parseJobEnvDoc(bad), bad);
  }
});

test("[E-E4] 판 env 싣기 — op·systemd 가 준 자리는 문서가 못 덮고, 빼기 키는 안 싣고, 상태·로그 자리는 판 쓰기 자리로", () => {
  const target: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin", HOME: "/task/work/home", TMPDIR: "/tmp", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    LVLY_TASK_UNIT: "lvly-task-acme-12-j1", LVLY_TASK_PROFILE: "gateway-job", LVLY_TENANT_SLUG: "acme",
    CREDENTIALS_DIRECTORY: "/run/credentials/u", INVOCATION_ID: "mine",
  };
  const before = { ...target };
  //  게이트웨이 쪽 빼기(JOB_ENV_DROP)를 누가 빠뜨린 날을 흉내 낸다 — 판 쪽 보호가 이긴다.
  const doc: Record<string, string> = {
    ...jobEnvDoc(GW_ENV),
    PATH: "/host/bin", HOME: "/var/lib/lvly/gw/x", TMPDIR: "/host/tmp", LANG: "ko_KR", LC_ALL: "ko_KR",
    LVLY_TASK_UNIT: "lvly-task-other-1-j1", LVLY_TASK_PROFILE: "context", LVLY_TENANT_SLUG: "other",
    CREDENTIALS_DIRECTORY: "/etc", INVOCATION_ID: "gw", LIVELY_STATE_DIR: "/var/lib/lvly/gw/x/data", LIVELY_LOG_DIR: "/var/log/gw",
    LVLY_HUB_SECRET: "leak", LIVELY_TMUX_EXEC: "/host/relay",
  };
  const n = applyJobEnv(target, doc, "/task/work");
  for (const k of Object.keys(before)) assert.equal(target[k], before[k], `판이 받은 ${k} 가 문서에 덮였다`);
  assert.equal(target.LIVELY_STATE_DIR, "/task/work/data");
  assert.equal(target.LIVELY_LOG_DIR, "/task/work/logs");
  assert.equal(target.LVLY_HUB_SECRET, undefined, "빼기 목록의 키가 판 env 에 실렸다");
  assert.equal(target.LIVELY_TMUX_EXEC, undefined);
  for (const k of ["ITEMS_DATABASE_URL", "LIVELY_TENANT_BINDING", "LIVELY_TENANT_ID", "CONNECTOR_SECRET_KEY", "LIVELY_TENANT_HEADER_SECRET"]) {
    assert.equal(target[k], GW_ENV[k], `${k} 가 안 실렸다`);
  }
  assert.equal(n, 9, "실은 키 수 = 수집 입력 9개");
  //  두 목록이 판의 자리를 둘 다 막는다(한쪽만 막으면 다른 쪽이 새는 날이 온다)
  for (const k of ["PATH", "HOME", "TMPDIR", "CREDENTIALS_DIRECTORY", "LIVELY_STATE_DIR", "LIVELY_LOG_DIR", "INVOCATION_ID"]) {
    assert.ok(JOB_ENV_PROTECTED.has(k) && JOB_ENV_DROP.has(k), k);
  }
});

// ── E-A 인자 ─────────────────────────────────────────────────────────────────
/** lvly-cloud control/src/taskop.ts 의 TASK_ARG_RE·gateway-job argsMax — op 가 이 모양·개수 밖 인자를 거절한다(두 레포 계약). */
const OP_ARG_RE = /^[A-Za-z0-9._:@+=,-]{1,128}$/;
const OP_ARGS_MAX = 8;
const spec = (o: Partial<JobSpec> = {}): JobSpec => ({ system: "slack", runId: 12, collectorId: null, full: false, ...o });

test("[E-A1] 판 인자 왕복 4조합 · 경계(system 64자 · 최대 safe id) · op 형식·개수 안", () => {
  const cases: JobSpec[] = [
    spec(), spec({ collectorId: 7 }), spec({ full: true }), spec({ collectorId: 7, full: true }),
    spec({ system: "a".repeat(64) }), spec({ system: "notion-2.team_a" }),
    spec({ system: "clickup", runId: Number.MAX_SAFE_INTEGER, collectorId: Number.MAX_SAFE_INTEGER }),
  ];
  for (const j of cases) {
    const a = jobArgs(j);
    assert.deepEqual(parseJobArgs(a), j, JSON.stringify(j));
    assert.ok(a.length <= OP_ARGS_MAX, `인자 ${a.length}개 — op 상한 ${OP_ARGS_MAX} 초과`);
    for (const x of a) assert.match(x, OP_ARG_RE, x);
  }
  assert.deepEqual(jobArgs(spec({ collectorId: 7, full: true })), ["connector-sync", "slack", "--run", "12", "--collector", "7", "--full"]);
});

test("[E-A2] 판 인자 거부 — 작업·system·id 형식, 경계 밖, 순서·중복·남는 인자·옵션 주입", () => {
  const ok = ["connector-sync", "slack", "--run", "1"];
  for (const bad of [
    [], ["connector-push", "slack", "--run", "1"], ["connector-sync"], ["Connector-sync", "slack", "--run", "1"],
    ["connector-sync", "Slack", "--run", "1"], ["connector-sync", "../x", "--run", "1"], ["connector-sync", "", "--run", "1"],
    ["connector-sync", "a".repeat(65), "--run", "1"], ["connector-sync", "-slack", "--run", "1"],
    ["connector-sync", "slack"], ["connector-sync", "slack", "--run"], ["connector-sync", "slack", "--id", "1"],
    [...ok.slice(0, 3), "0"], [...ok.slice(0, 3), "01"], [...ok.slice(0, 3), "1x"], [...ok.slice(0, 3), "-1"],
    [...ok.slice(0, 3), "12345678901234567"], [...ok.slice(0, 3), "9999999999999999"],
    [...ok, "--collector"], [...ok, "--collector", "a"], [...ok, "--collector", "0"],
    [...ok, "--full", "--collector", "2"], [...ok, "--full", "--full"], [...ok, "--collector", "2", "--collector", "3"],
    [...ok, "--env-file=/etc/passwd"], [...ok, "extra"],
  ]) {
    assert.throws(() => parseJobArgs(bad), JSON.stringify(bad));
  }
  for (const j of [spec({ system: "Bad Name" }), spec({ system: "a".repeat(65) }), spec({ runId: 0 }), spec({ runId: 1.5 }),
    spec({ runId: Number.MAX_SAFE_INTEGER + 1 }), spec({ collectorId: 0 }), spec({ collectorId: -3 })]) {
    assert.throws(() => jobArgs(j), JSON.stringify(j));
  }
});

test("[E-A3] 판 안 수집 자식 인자 = 게이트웨이 자식 길과 같은 인자(스크립트 경로만 절대)", () => {
  assert.deepEqual(syncChildArgv(spec({ collectorId: 7, full: true }), "/opt/lvly/app/dist/connectors/run-sync.js"),
    ["--env-file-if-exists=.env", "/opt/lvly/app/dist/connectors/run-sync.js", "slack", "--run", "12", "--collector", "7", "--full"]);
  assert.deepEqual(syncChildArgv(spec(), "/r.js"), ["--env-file-if-exists=.env", "/r.js", "slack", "--run", "12"]);
  //  게이트웨이 자식 길의 조립과 대조 — 한쪽만 바뀌면 판과 자식이 다른 수집을 한다.
  const src = fs.readFileSync(new URL("./run-tracker.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
  assert.match(src, /const args = \["--env-file-if-exists=\.env", "dist\/connectors\/run-sync\.js", system, "--run", String\(runId\)\];/);
  assert.match(src, /if \(opts\.collectorId\) args\.push\("--collector", String\(opts\.collectorId\)\);/);
  assert.match(src, /if \(opts\.full\) args\.push\("--full"\);/);
});

// ── E-C 분류 ─────────────────────────────────────────────────────────────────
test("[E-C] launch 응답 분류 — busy 는 배압 · 판 경로가 아직 안 서면 자식으로 · 그 밖은 실패 · 섰을 수 있으면 정지", () => {
  assert.equal(classifyLaunch({ ok: true }), "ok");
  assert.equal(classifyLaunch({ ok: true, code: "busy" }), "ok", "ok 가 이긴다");
  assert.equal(classifyLaunch({ ok: false, code: "busy" }), "busy");
  for (const c of ["op_unreachable", "bad_profile", "bad_version", "bad_code", "bad_route"]) {
    assert.equal(classifyLaunch({ ok: false, code: c }), "fallback", c);
    assert.equal(launchMayHaveStarted(c), false, c);
  }
  for (const c of ["op_timeout", "op_bad_reply", "start_timeout", "internal"]) {
    assert.equal(classifyLaunch({ ok: false, code: c }), "fail", c);
    assert.equal(launchMayHaveStarted(c), true, c);
  }
  for (const c of ["spawn_failed", "exists", "no_group", "bad_args", "bad_cred", "bad_env", "bad_request", "bad_body", "bad_harness", undefined, ""]) {
    assert.equal(classifyLaunch({ ok: false, code: c }), "fail", String(c));
    assert.equal(launchMayHaveStarted(c), false, String(c));
  }
  assert.equal(launchMayHaveStarted("busy"), false);
});

// ── E-G 사유·생존 ────────────────────────────────────────────────────────────
const st = (o: Partial<JobUnitState>): JobUnitState => ({ load: "loaded", active: "inactive", result: "success", exec_code: "exited", exec_status: "0", ...o });
test("[E-G] 판 생존 · 끝 사유 — 모름은 «모름», 재부팅·시간·메모리·기동 실패·엔트리 규약을 사람 말로", () => {
  assert.equal(jobUnitLive(null), null);
  for (const a of ["active", "activating", "deactivating", "reloading"]) assert.equal(jobUnitLive(st({ active: a })), true, a);
  for (const a of ["inactive", "failed", "maintenance", ""]) assert.equal(jobUnitLive(st({ active: a })), false, a);
  assert.equal(jobUnitLive(st({ load: "not-found", active: "inactive" })), false);
  const rows: Array<[JobUnitState | null, RegExp]> = [
    [null, /읽지 못했다/],
    [st({ load: "not-found" }), /사라졌다/],
    [st({ active: "failed", result: "timeout" }), /시간 상한/],
    [st({ active: "failed", result: "oom-kill" }), /메모리/],
    [st({ active: "failed", result: "exit-code", exec_code: "1", exec_status: "200" }), /200\/CHDIR/],
    [st({ active: "failed", result: "exit-code", exec_code: "1", exec_status: "203" }), /203\/EXEC/],
    [st({ active: "failed", result: "exit-code", exec_code: "1", exec_status: "217" }), /217\/USER/],
    [st({ active: "failed", result: "exit-code", exec_code: "1", exec_status: "226" }), /226\/NAMESPACE/],
    [st({ active: "failed", result: "exit-code", exec_code: "1", exec_status: "243" }), /243\/CREDENTIALS/],
    [st({ active: "failed", result: "exit-code", exec_status: String(JOB_EXIT_NOROW) }), /run 행/],
    [st({ active: "failed", result: "exit-code", exec_status: String(JOB_EXIT_NOENV) }), /env 문서/],
    [st({ active: "failed", result: "exit-code", exec_status: "1" }), /끝 기록 없이 끝났다\(failed\/exit-code exited\/1\)/],
    //  203 이 와도 실패 상태가 아니면(끝나서 치워지는 중) 기동 실패로 단정하지 않는다
    [st({ active: "inactive", result: "success", exec_status: "203" }), /끝 기록 없이 끝났다/],
  ];
  for (const [s, re] of rows) assert.match(jobGoneReason(s), re, JSON.stringify(s));
});

// ── 가짜 op 서버 ────────────────────────────────────────────────────────────
interface Req { head: Record<string, unknown>; body: Buffer }
function fakeOp(reply: (req: Req) => Record<string, unknown>): Promise<{ sock: string; reqs: Req[]; close: () => Promise<void> }> {
  const sock = path.join(TMP, `op-${Math.random().toString(16).slice(2, 8)}.sock`);
  const reqs: Req[] = [];
  const srv = net.createServer({ allowHalfOpen: true }, (c) => {
    const chunks: Buffer[] = [];
    c.on("data", (d) => chunks.push(d));
    c.on("end", () => {
      const all = Buffer.concat(chunks);
      const nl = all.indexOf(0x0a);
      const req: Req = { head: JSON.parse(all.subarray(0, nl).toString("utf8")), body: all.subarray(nl + 1) };
      reqs.push(req);
      c.end(JSON.stringify(reply(req)) + "\n");
    });
  });
  return new Promise((resolve) => srv.listen(sock, () => resolve({ sock, reqs, close: () => new Promise((r) => srv.close(() => r())) })));
}

// ── E-L 머리말 ───────────────────────────────────────────────────────────────
test("[E-L1] ★ launch — gateway-job · task_id=run id · 회차 1 · 코드 자리·인자 · env 는 slug 하나 · DB 주소는 자격 본문으로만", async () => {
  const op = await fakeOp(() => ({ ok: true, unit: "lvly-task-acme-12-j1", task_dir: "/var/lib/lvly/tasks/acme/12-j1", state: "active" }));
  process.env.LIVELY_TASK_OP_SOCK = op.sock;
  try {
    const env = jobEnvDoc(GW_ENV);
    const r = await launchRunUnit({ slug: "acme", codeRoot: ROOTFS, job: spec({ collectorId: 7 }), env });
    assert.equal(r.cls, "ok");
    assert.equal(r.unit, "lvly-task-acme-12-j1");
    assert.equal(op.reqs.length, 1, "op 를 한 번 불렀다");
    const { head, body } = op.reqs[0]!;
    assert.deepEqual({ ...head, nonce: "N" }, {
      v: 1, op: "launch", slug: "acme", task_id: 12, attempt: 1, profile: "gateway-job",
      env: { LVLY_TENANT_SLUG: "acme" }, code_root: ROOTFS,
      args: ["connector-sync", "slack", "--run", "12", "--collector", "7"],
      nonce: "N", limits: { runtime_sec: JOB_RUNTIME_SEC },
      files: [], creds: [{ name: "env", size: body.length }],
    });
    assert.match(String(head.nonce), /^[a-f0-9]{32}$/);
    assert.deepEqual(JSON.parse(body.toString("utf8")), env);
    //  ★ DB 주소·비밀은 머리말 어디에도 없다(머리말은 op 로그·오류 문장에 실릴 수 있다)
    const h = JSON.stringify(head);
    for (const secret of ["s3cret", "postgres://", "CONNECTOR_SECRET_KEY", "LIVELY_TENANT_HEADER_SECRET"]) assert.ok(!h.includes(secret), secret);
  } finally {
    delete process.env.LIVELY_TASK_OP_SOCK;
    await op.close();
  }
});

test("[E-L2] 메모리는 지정할 때만 싣는다(없음·0·null 은 op 기본)", async () => {
  const op = await fakeOp(() => ({ ok: true }));
  process.env.LIVELY_TASK_OP_SOCK = op.sock;
  try {
    const one = (memMb: number | null | undefined) =>
      launchRunUnit({ slug: "acme", codeRoot: ROOTFS, job: spec({ full: true }), env: { ITEMS_DATABASE_URL: "p" }, memMb });
    await one(1024);
    await one(undefined);
    await one(null);
    await one(0);
    assert.deepEqual(op.reqs.map((r) => r.head.limits), [
      { runtime_sec: JOB_RUNTIME_SEC, mem_mb: 1024 },
      { runtime_sec: JOB_RUNTIME_SEC }, { runtime_sec: JOB_RUNTIME_SEC }, { runtime_sec: JOB_RUNTIME_SEC },
    ]);
    assert.deepEqual(op.reqs[0]!.head.args, ["connector-sync", "slack", "--run", "12", "--full"]);
  } finally {
    delete process.env.LIVELY_TASK_OP_SOCK;
    await op.close();
  }
});

test("[E-L3] 답 분류가 op 답을 따른다 · 못 닿음은 던지지 않고 fallback · status·stop 은 결정적 이름으로", async () => {
  const replies: Record<string, unknown>[] = [
    { ok: false, code: "busy", error: "gateway-job 판이 가득 찼다(2/2)" },
    { ok: false, code: "bad_profile", error: "모르는 프로필" },
    { ok: false, code: "spawn_failed", error: "boom" },
  ];
  const op = await fakeOp((req) => {
    if (req.head.op === "status") return { ok: true, load: "loaded", active: "failed", result: "oom-kill", exec_code: "2", exec_status: "9" };
    if (req.head.op === "stop") return { ok: true, already_gone: true };
    return replies.shift()!;
  });
  process.env.LIVELY_TASK_OP_SOCK = op.sock;
  try {
    const one = (runId: number) => launchRunUnit({ slug: "acme", codeRoot: "/c", job: spec({ runId }), env: { ITEMS_DATABASE_URL: "p" } });
    assert.equal((await one(1)).cls, "busy");
    assert.equal((await one(2)).cls, "fallback");
    const f = await one(3);
    assert.equal(f.cls, "fail");
    assert.equal(f.reply.error, "boom");
    assert.deepEqual(await runUnitState("acme", 5), { load: "loaded", active: "failed", result: "oom-kill", exec_code: "2", exec_status: "9" });
    assert.equal(await stopRunUnit("acme", 5), true);
    assert.deepEqual(op.reqs.slice(3).map((r) => [r.head.op, r.head.unit]), [["status", "lvly-task-acme-5-j1"], ["stop", "lvly-task-acme-5-j1"]]);
  } finally { await op.close(); }
  process.env.LIVELY_TASK_OP_SOCK = path.join(TMP, "gone.sock");
  try {
    const r = await launchRunUnit({ slug: "acme", codeRoot: "/c", job: spec({ runId: 4 }), env: { ITEMS_DATABASE_URL: "p" } });
    assert.equal(r.cls, "fallback");
    assert.equal(r.reply.code, "op_unreachable");
    assert.equal(await runUnitState("acme", 4), null, "못 읽음은 null(모름)");
    assert.equal(await stopRunUnit("acme", 4), false);
  } finally { delete process.env.LIVELY_TASK_OP_SOCK; }
});

// ── E-J 청소 ─────────────────────────────────────────────────────────────────
test("[E-J] 끝난 판 결과 폴더 청소 — `<id>-j1` 만 · minAge 이상(경계 포함) · running 행 제외 · 거절은 안 셈 · 상한 · 폴더 없음", async () => {
  const root = path.join(TMP, "tasks");
  const slugDir = path.join(root, "acme");
  fs.mkdirSync(slugDir, { recursive: true });
  const NOW_S = 1_800_000_000;
  const MIN_AGE_S = 600;
  const ages: Record<string, number> = {
    "10-j1": 3600, "11-j1": 3600, "12-j1": 3600, "15-j1": MIN_AGE_S,   // 15 = 정확히 경계 → 대상
    "14-j1": MIN_AGE_S - 1,                                               // 1초 모자람 → 막 만든 폴더(판이 서는 중일 수 있다)
    "13-a1": 3600, "16-j2": 3600, junk: 3600,                             // 다른 모양
  };
  for (const [n, age] of Object.entries(ages)) {
    fs.mkdirSync(path.join(slugDir, n), { recursive: true });
    fs.utimesSync(path.join(slugDir, n), NOW_S - age, NOW_S - age);
  }
  const op = await fakeOp((req) => (req.head.unit === "lvly-task-acme-12-j1" ? { ok: false, code: "active" } : { ok: true }));
  process.env.LIVELY_TASK_OP_SOCK = op.sock;
  process.env.LIVELY_TASK_DATA_ROOT = root;
  try {
    const asked: number[][] = [];
    const o = { now: NOW_S * 1000, minAgeMs: MIN_AGE_S * 1000 };
    const n = await reapFinishedRunUnits("acme", async (ids) => { asked.push([...ids].sort((a, b) => a - b)); return new Set([11]); }, o);
    assert.deepEqual(asked, [[10, 11, 12, 15]], "행 상태는 후보만 묻는다");
    assert.deepEqual(op.reqs.map((r) => [r.head.op, r.head.unit, r.head.keep_dir]).sort(),
      [["reap", "lvly-task-acme-10-j1", false], ["reap", "lvly-task-acme-12-j1", false], ["reap", "lvly-task-acme-15-j1", false]],
      "running 행(11)은 안 건드린다");
    assert.equal(n, 2, "op 가 거절한(살아 있는) 판은 센 수에서 빠진다");
    op.reqs.length = 0;
    assert.equal(await reapFinishedRunUnits("acme", async () => new Set(), { ...o, limit: 1 }), 1);
    assert.equal(op.reqs.length, 1, "상한만큼만");
    op.reqs.length = 0;
    assert.equal(await reapFinishedRunUnits("nobody", async () => { throw new Error("묻지 말아야 한다"); }, o), 0);
    assert.equal(op.reqs.length, 0);
  } finally {
    delete process.env.LIVELY_TASK_OP_SOCK;
    delete process.env.LIVELY_TASK_DATA_ROOT;
    await op.close();
  }
});

// ── E-P 일부 — 판 엔트리의 DB 앞단(인자·env 문서) ─────────────────────────────
//  행 대기·수집·끝 기록은 실 DB 가 필요하다(job-entry.pg-test.mjs). 여기서는 **DB 에 닿기 전에** 멈추는 두 갈래만 잰다 —
//   DB 주소가 가리키는 곳에 연결이 시도되면 안 된다(닫힌 포트 대신 **듣기만 하는 소켓**으로 접속 시도 자체를 센다).
test("[E-P1] 판 엔트리 — 인자 틀림 64 · env 문서 없음/깨짐/DB 주소 없음 70 · 둘 다 DB 에 안 닿는다", async () => {
  const { spawnSync } = await import("node:child_process");
  const entry = new URL("./job-entry.js", import.meta.url).pathname;
  const hits: number[] = [];
  const trap = net.createServer((c) => { hits.push(1); c.destroy(); });
  await new Promise<void>((r) => trap.listen(0, "127.0.0.1", r));
  const port = (trap.address() as net.AddressInfo).port;
  const credDir = fs.mkdtempSync(path.join(TMP, "cred-"));
  const run = (args: string[], env: NodeJS.ProcessEnv): number | null => spawnSync(process.execPath, [entry, ...args], {
    env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 20_000,
  }).status;
  try {
    const dsn = `postgres://u:p@127.0.0.1:${port}/x`;
    fs.writeFileSync(path.join(credDir, "env"), JSON.stringify({ ITEMS_DATABASE_URL: dsn }));
    assert.equal(run(["connector-push", "slack", "--run", "1"], { CREDENTIALS_DIRECTORY: credDir }), 64);
    assert.equal(run([], { CREDENTIALS_DIRECTORY: credDir }), 64);
    const good = ["connector-sync", "slack", "--run", "1"];
    assert.equal(run(good, {}), 70, "CREDENTIALS_DIRECTORY 없음");
    assert.equal(run(good, { CREDENTIALS_DIRECTORY: path.join(TMP, "nope") }), 70, "env 파일 없음");
    fs.writeFileSync(path.join(credDir, "env"), "{broken");
    assert.equal(run(good, { CREDENTIALS_DIRECTORY: credDir }), 70, "깨진 문서");
    fs.writeFileSync(path.join(credDir, "env"), JSON.stringify({ PUBLIC_URL: "x" }));
    assert.equal(run(good, { CREDENTIALS_DIRECTORY: credDir, ITEMS_DATABASE_URL: dsn }), 70, "문서에 DB 주소 없음(프로세스 env 에 있어도)");
    assert.equal(hits.length, 0, "DB 앞단에서 멈춰야 할 판이 DB 에 연결을 시도했다");
  } finally {
    await new Promise<void>((r) => trap.close(() => r()));
  }
});
