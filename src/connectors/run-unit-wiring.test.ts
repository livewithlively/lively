// 수집 판(#3994 T3)의 **배선** — 소스를 읽어 못박는다. 사양 spec-run-unit 의 P5·P7·P12·P13·P14 중 순서·배선 행.
//
//  왜 소스인가: 이 배선의 고장은 단위 시험으로는 안 보이고, 실 DB 시험(job-entry.pg-test)으로도 «우연히 통과» 할 수 있다.
//   ① 판 엔트리가 env 를 싣기 **전에** db/client 를 불러오면 판의 모든 조회가 테넌트 없이 나간다(RLS 가 자기 run 행을 숨긴다)
//      — 바인딩이 꺼진 시험 DB 에선 초록이다.
//   ② 게이트웨이가 행을 판보다 먼저 만들면 자리 없음(busy)마다 빈 실행 행이 쌓이고, 락 밖에서 하면 같은 수집기가 두 판을 띄운다.
//   ③ 취소가 판을 먼저 멈추면 판 추적기의 끝 기록이 canceled 를 error 로 덮을 창이 생긴다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const raw = (p: string): string => readFileSync(new URL(p, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
const ENTRY = code(raw("./job-entry.ts"));
const UNIT = code(raw("./run-unit.ts"));
const TRACKER = code(raw("./run-tracker.ts"));
const CRON = code(raw("../scheduler/actions/connector.ts"));
const fn = (s: string, head: string): string => {
  const i = s.indexOf(head);
  assert.ok(i >= 0, `함수 없음: ${head}`);
  const j = s.indexOf("\n}\n", i);
  return s.slice(i, j < 0 ? undefined : j);
};
/** a 가 b 보다 앞에 있다 — 둘 다 **있어야** 한다(indexOf -1 이 «앞» 으로 읽히는 헛시험 방지). */
const before = (s: string, a: string, b: string, why: string): void => {
  const i = s.indexOf(a), j = s.indexOf(b);
  assert.ok(i >= 0, `없음: ${a}`);
  assert.ok(j >= 0, `없음: ${b}`);
  assert.ok(i < j, why);
};

test("[W1] ★ 판 엔트리의 정적 import 는 node 내장과 순수 모듈(run-unit)뿐 — db/client 는 env 를 실은 뒤 동적으로", () => {
  const statics = [...ENTRY.matchAll(/^import\s[^;]*?from\s+"([^"]+)";?$/gms)].map((m) => m[1]).sort();
  assert.deepEqual(statics, ["./run-unit.js", "node:child_process", "node:fs", "node:url"]);
  before(ENTRY, "applyJobEnv(", 'await import("../db/client.js")', "env 를 싣기 전에 db/client 를 불렀다 — 고정 바인딩·DB 주소가 비어 있는 채로 풀이 선다");
  before(ENTRY, "applyJobEnv(", 'await import("./run-tracker.js")', "env 를 싣기 전에 run-tracker(→ db/client)를 불렀다");
  before(ENTRY, "parseJobArgs(", "applyJobEnv(", "인자를 먼저 거른다(인자가 틀리면 env 문서도 안 읽는다)");
});

test("[W2] 판 엔트리 — 자기 행을 본 뒤에만 수집 · 정지 신호를 먼저 잡고 · 끝 기록은 running 행에만", () => {
  before(ENTRY, "SELECT status FROM connector_run WHERE id=$1", "spawn(process.execPath", "행을 보기 전에 수집을 띄웠다(고아 수집)");
  assert.match(ENTRY, /if \(status === null\) \{[\s\S]*?process\.exit\(JOB_EXIT_NOROW\);/);
  assert.match(ENTRY, /if \(status !== "running"\) \{[\s\S]*?process\.exit\(0\);/);
  before(ENTRY, 'process.on("SIGTERM", onSignal)', "await trackRunChild(", "신호 처리를 늦게 걸면 그 사이 정지는 끝 기록 없이 죽는다");
  assert.match(ENTRY, /trackRunChild\(job\.runId, child, \{ isCanceled: \(\) => false, echo, guardFinal: true \}\)/);
  assert.match(ENTRY, /appendRunLog\([\s\S]*?\{ onlyRunning: true \}\)/, "정지 사유 줄도 닫힌 행에는 안 쓴다");
  assert.doesNotMatch(ENTRY, /cwd: process\.cwd\(\)/, "cwd 는 물려받는다(상태 폴더 가드 — state-dir.test)");
});

test("[W3b] 판 띄우기 대기는 짧다 — 게이트웨이가 트랜잭션(풀 연결)을 쥔 채 기다리는 시간이다", () => {
  const m = /export const JOB_LAUNCH_TIMEOUT_MS = ([\d_]+);/.exec(UNIT);
  assert.ok(m, "상한 상수가 없다");
  const ms = Number(m![1]!.replace(/_/g, ""));
  assert.ok(ms > 10_000 && ms <= 20_000, `op 기동 대기(10초)보다 길고 20초 이하여야 한다: ${ms}`);
  assert.match(fn(UNIT, "export async function launchRunUnit("), /callTaskOp\(header, \{ creds \}, \{ timeoutMs: JOB_LAUNCH_TIMEOUT_MS \}\)/);
});

test("[W3] run-unit 의 최상위는 순수 — 값 import 가 없다(판 엔트리가 env 를 싣기 전에 부른다)", () => {
  const imports = [...UNIT.matchAll(/^import\s(?!type\s)[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
  assert.deepEqual(imports, [], `값 import 가 있다: ${imports.join(", ")}`);
  assert.match(UNIT, /await import\("\.\.\/node\/sandbox-task\.js"\)/, "op 는 동적으로");
});

test("[W4] ★ 게이트웨이 — 경로를 먼저 정하고, 판 경로는 락 안에서 «판 먼저 · 행 나중»", () => {
  const start = fn(TRACKER, "export async function startConnectorRun(");
  before(start, "decideRunRoute(system, opts.collectorId)", "startRunInUnit(", "경로 판정 없이 판을 띄운다");
  before(start, "startRunInUnit(", "startRunAsChild(system, opts, note)", "판을 먼저 시도하고, 안 서면 자식으로");
  assert.match(start, /if \(viaUnit\.kind === "started"\) return viaUnit\.result;/);
  const unit = fn(TRACKER, "async function startRunInUnit(");
  before(unit, "pg_advisory_xact_lock(", "SELECT id FROM connector_run WHERE ${scope.scopeSql} AND status='running'", "락을 잡고 나서 «이미 도는가» 를 다시 본다");
  before(unit, "SELECT id FROM connector_run WHERE ${scope.scopeSql} AND status='running'", "nextval(pg_get_serial_sequence('connector_run','id'))", "도는 수집이 있으면 id 도 안 받는다");
  before(unit, "nextval(pg_get_serial_sequence('connector_run','id'))", "u.launchRunUnit(", "판은 받은 id 로 선다");
  before(unit, "u.launchRunUnit(", "await insert(\"running\"", "★ 행은 판이 선 **뒤에** 만든다(busy 에 빈 행이 안 쌓인다)");
  assert.match(unit, /withTx\(async \(client\)/, "락·행 삽입이 한 트랜잭션");
  assert.match(unit, /case "busy":\s*throw new RunCapacityError\(/, "busy → 행 없이 RunCapacityError");
  //  분기 구간은 case 라벨로 자른다 — 라벨이 없으면 indexOf 가 -1 이라 구간이 조용히 틀어진다(그래서 먼저 확인한다).
  const at = (k: string): number => { const i = unit.indexOf(k); assert.ok(i >= 0, `분기 라벨이 없다: ${k}`); return i; };
  const busy = unit.slice(at('case "busy":'), at('case "fallback":'));
  assert.doesNotMatch(busy, /insert\(/, "busy 에 행을 만들었다");
  const fb = unit.slice(at('case "fallback":'), at('case "fail":'));
  assert.doesNotMatch(fb, /insert\(/, "fallback 은 행을 안 만든다(자식 길이 만든다)");
  const fail = unit.slice(at('case "fail":'));
  before(fail, "launchMayHaveStarted(", 'await insert("error"', "섰을 수 있는 판은 실패 행보다 먼저 멈추라고 전한다");
  assert.doesNotMatch(unit, /\bdefault:/, "응답 분류는 망라한다 — default 로 받으면 새 분류가 조용히 실패 길로 간다");
  assert.match(unit, /watchRunUnit\(runId, slug\)/, "판 실행의 done 은 감시");
  assert.match(unit, /jobEnvDoc\(childEnv\(system\)\)/, "판 env = 자식 길 env 에서 뺀 것(같은 입력)");
});

test("[W5] 유령 정리 · 취소 · 부팅 입양 — pid 없는 행은 판으로 다룬다", () => {
  const start = fn(TRACKER, "export async function startConnectorRun(");
  assert.match(start, /if \(g\.pid\) \{[\s\S]*?killIfRunSync\(g\.pid, system\)[\s\S]*?\} else ghostUnits\.push/);
  assert.match(start, /u\.stopRunUnit\(ctx\.slug, id\)/, "판 유령에 정지를 전하지 않는다");
  const cancel = fn(TRACKER, "export async function cancelConnectorRun(");
  before(cancel, "SET status='canceled'", "stopRunUnit(ctx.slug, id)", "★ 행을 먼저 닫고 판을 멈춘다(끝 기록이 canceled 를 덮지 않게)");
  assert.match(cancel, /if \(!row\.pid\) \{/);
  //  되돌림 스위치를 켠 뒤에도 이미 뜬 판은 멈추고·치우고·입양해야 한다 — 관리 경로는 소켓만 본다.
  assert.match(start, /const ctx = await unitContext\(\{ manage: true \}\);/, "유령 정리가 스위치에 막힌다");
  assert.match(cancel, /const ctx = await unitContext\(\{ manage: true \}\);/, "취소가 스위치에 막힌다");
  const route = fn(TRACKER, "async function decideRunRoute(");
  assert.match(route, /unitContext\(\)\]/, "새 판 경로는 스위치(sandboxAvailable)를 따른다");
  const boot = fn(TRACKER, "export async function recoverOrphanConnectorRuns(");
  assert.match(boot, /unitContext\(\{ manage: true \}\)/, "부팅 입양이 스위치에 막힌다");
  assert.match(boot, /unitRunAlive\(\{ quietMs, staleMs: HEARTBEAT_STALE_MS, unitLive \}\)/);
  assert.match(boot, /orphanVerdict\(\{ pid: g\.pid, aliveAndOurs \}\)/, "판정 규율은 그대로 한 곳");
  assert.match(boot, /if \(g\.pid\) aliveAndOurs = await isOurRunSync\(g\.pid, g\.system\);/, "pid 행은 종전 판정");
});

test("[W6] 추적은 한 벌 — 자식 길은 종전(무조건 끝 기록), 판 엔트리만 running 가드", () => {
  const child = fn(TRACKER, "async function startRunAsChild(");
  assert.match(child, /trackRunChild\(runId, child, \{/);
  assert.doesNotMatch(child, /guardFinal/, "자식 길의 끝 기록을 바꾸면 종전 취소(canceled 플래그) 경로가 달라진다");
  const track = fn(TRACKER, "export function trackRunChild(");
  assert.match(track, /WHERE id=\$1\$\{o\.guardFinal \? " AND status='running'" : ""\}/);
  assert.match(track, /o\.echo\?\.\(c\)/);
});

test("[W7] 크론 — 판 자리 없음은 배압(ok · skipped capacity)", () => {
  assert.match(CRON, /if \(e instanceof RunCapacityError\) \{ out\.push\(\{[^}]*ok: true, skipped: "capacity"/);
  assert.match(CRON, /syncBatchStatus\(out\)/);
});
