// 수집(connector_run)을 게이트웨이 **밖** 일시 유닛(판)에서 — 코어 쪽 (#3994 T3).
//
// ── 왜 ──────────────────────────────────────────────────────────────────────
// 매니지드 중앙 게이트웨이는 청/녹 교대(하루 약 10회)마다 옛 슬롯을 `systemctl stop` 한다. 슬롯 유닛의 KillMode 가
//  기본값(control-group)이라 **그 자식인 수집(run-sync)이 같이 죽는다** — 12시간짜리 첫 백필이 교대 한 번에 처음부터다.
//  #4012 가 세운 root 소켓 op(lvly-task-op)에 lvly-cloud 가 `gateway-job` 프로필을 더했고, 코어는 그 프로필로
//  수집을 게이트웨이 cgroup 밖 일시 유닛에 맡긴다. 판은 게이트웨이의 자식도 op 의 자식도 아니다.
//
// ── 누가 무엇을 적나 ────────────────────────────────────────────────────────
//  · 판 안 엔트리(job-entry)가 게이트웨이의 수집 추적기 역할을 **그대로** 한다 — 로그·하트비트·끝 기록을 자기 run 행에
//    직접 쓴다(run-tracker.trackRunChild 를 판 안에서 부른다). 게이트웨이가 몇 번 재시작해도 기록이 안 끊긴다.
//  · 게이트웨이는 띄우고(launch) · 기다리고(watch) · 멈추고(stop) · 치운다(reap). 메모리 상태가 없다.
//  · 유닛 이름은 (slug, run id) 에서 **결정적**으로 나온다 — 표에 칸을 더하지 않고도 취소·유령 정리·부팅 입양이 판을 찾는다.
//    run 행의 `pid` 가 비어 있으면 판 실행이다(자식 실행은 띄우자마자 pid 를 적는다).
//
// ── 쓰지 않는 경우(종전 자식 길) ────────────────────────────────────────────
//  op 소켓이 없다(셀프호스트) · 내 코드 뿌리를 모른다(LIVELY_CODE_ROOT — CP 가 호스트 슬롯에 심는다) · 워크스페이스 slug 가
//  없다 · 꺼 두었다(LIVELY_GATEWAY_JOB=off) · 커넥터가 게이트웨이 디스크에 기댄다(Connector.needsGatewayDisk).
//
// ⚠ 이 파일의 **최상위**는 순수하다(DB·op 모듈을 정적으로 끌지 않는다) — 판 엔트리가 env 를 싣기 **전에** 이 파일을
//  불러 인자·env 문서를 해석하기 때문이다(db/client 는 import 되는 순간 ITEMS_DATABASE_URL 을 읽는다).
//  DB·op 를 쓰는 함수는 안에서 동적으로 불러온다.
import type { TaskOpPart, TaskOpReply } from "../node/sandbox-task.js";   // 타입만 — 컴파일에서 지워진다

export const GATEWAY_JOB_PROFILE = "gateway-job";
export const JOB_KIND_CONNECTOR_SYNC = "connector-sync";
/** 유닛 이름의 회차 표지 — lvly-cloud `TASK_PROFILES["gateway-job"].unitMark` 와 같아야 한다(context 는 `a`). */
export const JOB_UNIT_MARK = "j";
/** 수집 판은 run 행 하나에 한 번만 뜬다 — 재시도는 새 run 행이다. */
export const JOB_ATTEMPT = 1;
/** 판 런타임 상한(초) — 판 안 추적기의 하드캡(12시간)에 10분 여유. op 프로필 상한과 같다. */
export const JOB_RUNTIME_SEC = 12 * 3600 + 600;
/** 판 안 추적기가 수집 출력을 자기 stdout(판 결과 폴더)에도 남기는 상한 — 판의 LimitFSIZE(1GB)보다 한참 아래. */
export const JOB_ECHO_CAP = 64 * 1024 * 1024;
/** 게이트웨이가 넘기는 env 문서 상한 — op 의 자격 한 칸 상한(64KB)과 같다. */
export const JOB_ENV_MAX_BYTES = 64 * 1024;
/** 판 안 추적기가 자기 run 행이 생기기를 기다리는 한도 — 게이트웨이는 판이 선 **뒤에** 행을 커밋한다. */
export const JOB_ROW_WAIT_MS = 30_000;
/**
 * 판 띄우기 응답 대기 상한 — 게이트웨이는 이 동안 **트랜잭션(풀 연결 하나)을 쥐고** 기다린다(run-tracker.startRunInUnit).
 *  op 가 매달리면 테넌트마다 연결을 붙잡아 풀(20)이 마를 수 있어 짧게 둔다. 수집 판은 본문이 작고 op 의 기동 대기는 10초다.
 *  이보다 늦게 선 판은 안전하다 — 게이트웨이가 실패 행을 커밋하고(정지도 전한다), 판 추적기는 행이 running 이 아니면 수집하지 않는다.
 */
export const JOB_LAUNCH_TIMEOUT_MS = 20_000;
/** 판 안 규약 종료코드. */
export const JOB_EXIT_USAGE = 64;
export const JOB_EXIT_NOENV = 70;
export const JOB_EXIT_NOROW = 75;

// ── 경로 판정(순수) ───────────────────────────────────────────────────────────

export interface JobRouteInput {
  /** 이 박스에 판 op 소켓이 있다(sandboxAvailable — `LIVELY_TASK_SANDBOX=off` 도 여기서 이미 꺼진다). */
  sandbox: boolean;
  /** env LIVELY_CODE_ROOT — 이 게이트웨이가 도는 이미지 rootfs. */
  codeRoot: string | null | undefined;
  /** 지금 워크스페이스의 slug(tenantSlug). */
  slug: string | null | undefined;
  /** env LIVELY_GATEWAY_JOB — `off` 면 수집만 종전 길로 되돌린다. */
  switchValue: string | null | undefined;
  /** 커넥터의 needsGatewayDisk. null = 커넥터를 못 가렸다(프리셋 해소 실패 등). */
  needsGatewayDisk: boolean | null;
}

export type JobRoute = { unit: true } | { unit: false; why: JobRouteWhy };
export type JobRouteWhy = "no_op" | "switch_off" | "no_code_root" | "no_slug" | "unknown_connector" | "gateway_disk";

/**
 * 이 수집을 판에서 돌릴 것인가(순수).
 *  판을 못 쓰는 까닭 중 `no_op` 만 «정상적인 종전 길» 이다(셀프호스트). 나머지는 op 가 있는 박스에서 판을 안 쓰는 것이라
 *  run 로그에 그 사실을 한 줄 남긴다(jobRouteNote) — 조용히 교대에 끊기는 길로 가지 않게.
 */
export function jobRoute(i: JobRouteInput): JobRoute {
  if (!i.sandbox) return { unit: false, why: "no_op" };
  if (String(i.switchValue ?? "").trim().toLowerCase() === "off") return { unit: false, why: "switch_off" };
  if (!String(i.codeRoot ?? "").trim()) return { unit: false, why: "no_code_root" };
  if (!String(i.slug ?? "").trim()) return { unit: false, why: "no_slug" };
  if (i.needsGatewayDisk === null) return { unit: false, why: "unknown_connector" };
  if (i.needsGatewayDisk) return { unit: false, why: "gateway_disk" };
  return { unit: true };
}

const WHY_TEXT: Readonly<Record<Exclude<JobRouteWhy, "no_op">, string>> = Object.freeze({
  switch_off: "판 실행이 꺼져 있다(LIVELY_GATEWAY_JOB=off)",
  no_code_root: "이 게이트웨이의 코드 자리를 모른다(LIVELY_CODE_ROOT 없음 — CP 가 슬롯을 다시 세우면 생긴다)",
  no_slug: "워크스페이스 slug 를 모른다",
  unknown_connector: "커넥터를 가리지 못했다(프리셋 해소 실패)",
  gateway_disk: "이 커넥터는 게이트웨이 디스크에 기댄다(첨부 저장·로컬 레포)",
});

/** run 로그에 남길 한 줄(순수). 셀프호스트(no_op)는 null — 종전 그대로라 알릴 것이 없다. */
export function jobRouteNote(r: JobRoute): string | null {
  if (r.unit || r.why === "no_op") return null;
  return `[tracker] 게이트웨이 자식으로 실행 — ${WHY_TEXT[r.why]}. 게이트웨이 교대에 끊길 수 있습니다.`;
}

// ── 좌표(순수) ─────────────────────────────────────────────────────────────────

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function assertRunId(runId: number): number {
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error(`run id 형식이 아니다: ${runId}`);
  return runId;
}

/** 판 유닛 이름(순수) — lvly-cloud `taskUnitName(slug, id, 1, "j")` 와 같은 모양. */
export function jobUnitName(slug: string, runId: number): string {
  if (!SAFE_SLUG.test(slug)) throw new Error(`워크스페이스 slug 형식이 아니다: ${JSON.stringify(slug)}`);
  return `lvly-task-${slug}-${assertRunId(runId)}-${JOB_UNIT_MARK}${JOB_ATTEMPT}`;
}

/** 판 작업 폴더의 이름(`<id>-j1`) — 결과 폴더 청소가 이 모양만 집는다. */
const JOB_DIR_RE = new RegExp(`^([1-9][0-9]{0,15})-${JOB_UNIT_MARK}${JOB_ATTEMPT}$`);
export function runIdOfJobDir(name: string): number | null {
  const m = JOB_DIR_RE.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

// ── 판에 넘길 env(순수) ────────────────────────────────────────────────────────

/**
 * 판에 **넘기지 않는** 키 — 게이트웨이 호스트의 자리를 가리키거나(판에는 그 경로가 없다), systemd·op 가 판에 따로 주거나,
 *  수집이 쓰지 않는 중계 비밀이다. 나머지는 게이트웨이가 수집 자식에게 주던 그대로 넘긴다(자식 길과 같은 입력).
 *  ⚠ 비밀을 여기서 더 빼려면 **수집 경로가 안 읽는다는 근거**가 있어야 한다 — 빠진 키는 조용히 다른 동작을 낳는다
 *   (예: LIVELY_TENANT_HEADER_SECRET 은 매니지드 판정 `managedMode()` 의 근거라 못 뺀다).
 */
export const JOB_ENV_DROP: ReadonlySet<string> = new Set([
  //  호스트 자리 — 판은 자기 것(HOME=/task/work/home · PATH · TMPDIR)을 op 에게서 받는다.
  "PATH", "HOME", "PWD", "OLDPWD", "TMPDIR", "SHELL", "USER", "LOGNAME",
  "LIVELY_STATE_DIR", "LIVELY_LOG_DIR", "LIVELY_CODE_ROOT",
  //  게이트웨이 전용 중계 — 호스트의 rootfs 절대경로를 가리키고, 수집은 부르지 않는다.
  "LIVELY_TMUX_EXEC", "LIVELY_MEMBER_EXEC", "LIVELY_SESSION_EXEC", "LIVELY_SESSION_ENSURE",
  //  허브(루프백) — 코어 src 는 이 비밀을 읽지 않는다(#2600 T3-a 로 허브 전송을 걷었다). 판에서는 닿지도 않는다.
  "LVLY_HUB_SECRET", "LVLY_HUB_URL",
  //  판 op 손잡이 — 판 안에서는 의미가 없다(소켓이 안 보인다).
  "LIVELY_TASK_OP_SOCK", "LIVELY_TASK_DATA_ROOT", "LIVELY_TASK_SANDBOX", "LIVELY_GATEWAY_JOB",
  //  systemd 가 **그 프로세스에** 주는 것 — 판에는 판의 것이 따로 있다.
  "INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "MEMORY_PRESSURE_WATCH", "MEMORY_PRESSURE_WRITE",
  "CREDENTIALS_DIRECTORY", "NOTIFY_SOCKET", "LISTEN_FDS", "LISTEN_PID", "LISTEN_FDNAMES", "WATCHDOG_PID", "WATCHDOG_USEC",
  "RUNTIME_DIRECTORY", "STATE_DIRECTORY", "CACHE_DIRECTORY", "LOGS_DIRECTORY", "CONFIGURATION_DIRECTORY", "MANAGERPID",
]);

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 판에 넘길 env 문서(순수) — 게이트웨이가 자식에게 주던 env(childEnv) 에서 JOB_ENV_DROP 을 뺀 것. */
export function jobEnvDoc(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(env).sort()) {
    const v = env[k];
    if (typeof v !== "string" || !ENV_KEY.test(k) || JOB_ENV_DROP.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** 직렬화(순수) — 상한을 넘으면 던진다(잘라서 넘기면 판이 **다른 설정**으로 돈다). */
export function serializeJobEnv(doc: Record<string, string>): Buffer {
  const buf = Buffer.from(JSON.stringify(doc), "utf8");
  if (buf.length > JOB_ENV_MAX_BYTES) throw new Error(`판에 넘길 env 가 상한(${JOB_ENV_MAX_BYTES}B)을 넘는다: ${buf.length}B`);
  return buf;
}

/**
 * 판 안에서 env 문서를 읽는다(순수). 형식이 틀리면 던진다 — 틀린 문서로 도는 수집은 남의 워크스페이스에 쓸 수 있다.
 */
export function parseJobEnvDoc(text: string): Record<string, string> {
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error("env 문서가 JSON 이 아니다"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("env 문서가 객체가 아니다");
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!ENV_KEY.test(k)) throw new Error(`env 문서의 키 형식이 아니다: ${JSON.stringify(k).slice(0, 80)}`);
    if (typeof val !== "string") throw new Error(`env 문서의 값이 문자열이 아니다: ${k}`);
    out[k] = val;
  }
  if (!out.ITEMS_DATABASE_URL) throw new Error("env 문서에 ITEMS_DATABASE_URL 이 없다 — 판이 기록할 곳이 없다");
  return out;
}

/**
 * 판 안에서 **env 문서가 덮지 못하는** 키 — op 가 판에 준 것(자리·단위 표지)과 systemd 가 준 것이 이긴다.
 *  문서에 이 키가 있어도(게이트웨이 쪽 JOB_ENV_DROP 이 빠뜨린 날) 판의 자리를 호스트 자리로 바꾸지 못한다.
 */
export const JOB_ENV_PROTECTED: ReadonlySet<string> = new Set([
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "PWD",
  "LVLY_TASK_UNIT", "LVLY_TASK_PROFILE", "LVLY_TENANT_SLUG",
  "CREDENTIALS_DIRECTORY", "INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID",
  "LIVELY_STATE_DIR", "LIVELY_LOG_DIR",
]);

/** 판 안 쓰기 자리 — 판의 tmpfs(`/task/work`, op 프로필 workMb). 게이트웨이의 상태 폴더 대신 여기 쓴다. */
export const JOB_WORK_DIR = "/task/work";

/**
 * 판 프로세스 env 에 문서를 싣는다(순수 — target 을 고친다). 반환 = 실은 키 수.
 *  게이트웨이의 상태·로그 자리는 판에 없으므로 판의 쓰기 자리로 둔다(수집이 stateDir 에 쓰면 판과 함께 사라진다 —
 *  그래서 디스크에 기대는 커넥터는 애초에 판으로 안 온다: needsGatewayDisk).
 */
export function applyJobEnv(target: NodeJS.ProcessEnv, doc: Record<string, string>, workDir: string = JOB_WORK_DIR): number {
  let n = 0;
  for (const [k, v] of Object.entries(doc)) {
    if (JOB_ENV_PROTECTED.has(k) || JOB_ENV_DROP.has(k)) continue;
    target[k] = v;
    n++;
  }
  target.LIVELY_STATE_DIR = `${workDir}/data`;
  target.LIVELY_LOG_DIR = `${workDir}/logs`;
  return n;
}

// ── 판 인자(순수) ──────────────────────────────────────────────────────────────

export interface JobSpec {
  system: string;
  runId: number;
  collectorId: number | null;
  full: boolean;
}

/** 수집 대상 이름 — 코드 레지스트리 이름 또는 프리셋 key(소문자 slug). op 의 인자 형식(TASK_ARG_RE) 안이다. */
const SYSTEM_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ID_RE = /^[1-9][0-9]{0,15}$/;

/** 판 엔트리 인자(순수) — `connector-sync <system> --run <id> [--collector <id>] [--full]`. */
export function jobArgs(j: JobSpec): string[] {
  if (!SYSTEM_RE.test(j.system)) throw new Error(`수집 대상 이름이 형식 밖이다: ${JSON.stringify(j.system)}`);
  const a = [JOB_KIND_CONNECTOR_SYNC, j.system, "--run", String(assertRunId(j.runId))];
  if (j.collectorId !== null) a.push("--collector", String(assertRunId(j.collectorId)));
  if (j.full) a.push("--full");
  return a;
}

/**
 * 판 엔트리 인자 해석(순수) — jobArgs 가 만드는 모양**만** 받는다(순서 고정). 모르는 작업·남는 인자는 던진다.
 *  op 가 인자 형식을 이미 걸렀지만, 엔트리는 op 를 믿지 않는다(허용 작업 목록은 여기서 닫힌다).
 */
export function parseJobArgs(argv: readonly string[]): JobSpec {
  const a = [...argv];
  const kind = a.shift();
  if (kind !== JOB_KIND_CONNECTOR_SYNC) throw new Error(`모르는 판 작업: ${JSON.stringify(kind)}`);
  const system = a.shift() ?? "";
  if (!SYSTEM_RE.test(system)) throw new Error(`수집 대상 이름이 형식 밖이다: ${JSON.stringify(system)}`);
  if (a.shift() !== "--run") throw new Error("--run <id> 가 필요하다");
  const run = a.shift() ?? "";
  if (!ID_RE.test(run)) throw new Error(`run id 형식이 아니다: ${JSON.stringify(run)}`);
  let collectorId: number | null = null;
  if (a[0] === "--collector") {
    a.shift();
    const c = a.shift() ?? "";
    if (!ID_RE.test(c)) throw new Error(`수집기 id 형식이 아니다: ${JSON.stringify(c)}`);
    collectorId = Number(c);
  }
  let full = false;
  if (a[0] === "--full") { a.shift(); full = true; }
  if (a.length) throw new Error(`남는 인자: ${JSON.stringify(a)}`);
  const runId = Number(run);
  if (!Number.isSafeInteger(runId) || (collectorId !== null && !Number.isSafeInteger(collectorId))) throw new Error("id 가 너무 크다");
  return { system, runId, collectorId, full };
}

/**
 * 판 안에서 수집 자식(run-sync)에 줄 인자(순수) — 게이트웨이 자식 길과 **같은 인자**(run-tracker.startConnectorRun).
 *  runSyncPath 는 절대경로(판 안 코드 자리)다.
 */
export function syncChildArgv(j: JobSpec, runSyncPath: string): string[] {
  const args = ["--env-file-if-exists=.env", runSyncPath, j.system, "--run", String(j.runId)];
  if (j.collectorId !== null) args.push("--collector", String(j.collectorId));
  if (j.full) args.push("--full");
  return args;
}

// ── op 응답 분류(순수) ─────────────────────────────────────────────────────────

/**
 * launch 응답을 어떻게 다룰 것인가(순수).
 *  · ok        — 판이 섰다.
 *  · busy      — 박스·프로필 자리가 없다. 기다리면 풀린다(배압) — 행을 만들지 않는다.
 *  · fallback  — **이 박스에서 판 경로가 아직 안 선다**(op 가 없다·프로필을 모른다·코드 자리·DB 경로를 못 정한다).
 *                종전 자식 길로 간다(run 로그에 사유를 남긴다). 수집을 멈추는 것보다 낫다.
 *  · fail      — 그 밖. 판이 섰을 수도 있다(시간초과·깨진 응답) — 호출부는 **멈추라고 전하고** 실패로 적는다.
 */
export type LaunchClass = "ok" | "busy" | "fallback" | "fail";
const FALLBACK_CODES: ReadonlySet<string> = new Set(["op_unreachable", "bad_profile", "bad_version", "bad_code", "bad_route"]);

export function classifyLaunch(r: { ok: boolean; code?: string }): LaunchClass {
  if (r.ok) return "ok";
  if (r.code === "busy") return "busy";
  if (FALLBACK_CODES.has(String(r.code ?? ""))) return "fallback";
  return "fail";
}

/** 판이 섰을 가능성이 있는 실패인가 — 그러면 멈추라고 전한다(고아 판 방지). op 가 거절한 것은 아무것도 안 만들었다. */
export function launchMayHaveStarted(code: string | undefined): boolean {
  return code === "op_timeout" || code === "op_bad_reply" || code === "start_timeout" || code === "internal";
}

// ── 기록 없이 끝난 판의 사유(순수) ─────────────────────────────────────────────

export interface JobUnitState { load: string; active: string; result: string; exec_code: string; exec_status: string }

const EXEC_STATUS_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "200": "작업 폴더로 못 들어갔다(200/CHDIR)",
  "203": "엔트리를 못 띄웠다(203/EXEC — 코드 자리에 job-entry 가 없는 판일 수 있다)",
  "217": "일회용 계정을 못 세웠다(217/USER)",
  "226": "샌드박스를 세우지 못했다(226/NAMESPACE)",
  "243": "자격을 판에 넣지 못했다(243/CREDENTIALS)",
});

/**
 * 판이 **살아 있나**(순수). null(상태를 못 읽음)은 «모름» 이다 — 호출부가 정한다(끝났다고 단정하지 않는다).
 */
export function jobUnitLive(st: JobUnitState | null): boolean | null {
  if (!st) return null;
  return st.active === "active" || st.active === "activating" || st.active === "deactivating" || st.active === "reloading";
}

/** 판 추적기가 끝 기록을 못 남기고 판이 끝났을 때의 사유(순수). */
export function jobGoneReason(st: JobUnitState | null): string {
  if (!st) return "판 상태를 읽지 못했다";
  if (st.load === "not-found") return "판이 끝 기록 없이 사라졌다(박스 재부팅·수동 정리·기록 전 DB 단절 추정)";
  if (st.result === "timeout") return "판이 시간 상한을 넘겨 멈췄다(timeout)";
  if (st.result === "oom-kill") return "판이 메모리 상한을 넘었다(oom-kill)";
  const known = EXEC_STATUS_TEXT[st.exec_status];
  if (known && st.active === "failed") return known;
  if (st.exec_status === String(JOB_EXIT_NOROW)) return `판이 자기 run 행을 못 찾고 끝났다(exit ${JOB_EXIT_NOROW})`;
  if (st.exec_status === String(JOB_EXIT_NOENV)) return `판에 env 문서가 없었다(exit ${JOB_EXIT_NOENV})`;
  return `판이 끝 기록 없이 끝났다(${st.active}/${st.result || "?"} ${st.exec_code}/${st.exec_status})`;
}

// ── op 배선(동적 import) ─────────────────────────────────────────────────────

async function op(): Promise<typeof import("../node/sandbox-task.js")> {
  return await import("../node/sandbox-task.js");
}

export interface LaunchRunUnitInput {
  slug: string;
  codeRoot: string;
  job: JobSpec;
  /** 판 안 수집의 env(jobEnvDoc 결과). DB 접속이 든다 — 자격 본문으로만 흐른다. */
  env: Record<string, string>;
  memMb?: number | null;
}

/** 판을 띄운다. 던지지 않는다 — 응답과 분류를 돌려준다(못 닿음·시간초과도 코드로). */
export async function launchRunUnit(i: LaunchRunUnitInput): Promise<{ cls: LaunchClass; reply: TaskOpReply; unit: string }> {
  const crypto = await import("node:crypto");
  const unit = jobUnitName(i.slug, i.job.runId);
  const creds: TaskOpPart[] = [{ name: "env", data: serializeJobEnv(i.env) }];
  const header = {
    op: "launch", slug: i.slug, task_id: i.job.runId, attempt: JOB_ATTEMPT, profile: GATEWAY_JOB_PROFILE,
    env: { LVLY_TENANT_SLUG: i.slug },
    code_root: i.codeRoot,
    args: jobArgs(i.job),
    nonce: crypto.randomBytes(16).toString("hex"),
    limits: { runtime_sec: JOB_RUNTIME_SEC, ...(i.memMb ? { mem_mb: i.memMb } : {}) },
  };
  const { callTaskOp } = await op();
  const reply = await callTaskOp(header, { creds }, { timeoutMs: JOB_LAUNCH_TIMEOUT_MS });
  return { cls: classifyLaunch(reply), reply, unit };
}

/** 판 상태. 못 읽으면 null. */
export async function runUnitState(slug: string, runId: number): Promise<JobUnitState | null> {
  const { callTaskOp } = await op();
  const r = await callTaskOp({ op: "status", unit: jobUnitName(slug, runId) });
  if (!r.ok) return null;
  return { load: String(r.load ?? ""), active: String(r.active ?? ""), result: String(r.result ?? ""), exec_code: String(r.exec_code ?? ""), exec_status: String(r.exec_status ?? "") };
}

/** 판을 멈추라고 전한다(비대기 · 이미 없으면 성공). 못 닿았으면 false. */
export async function stopRunUnit(slug: string, runId: number): Promise<boolean> {
  const { callTaskOp } = await op();
  const r = await callTaskOp({ op: "stop", unit: jobUnitName(slug, runId) });
  return r.ok;
}

/** 끝난 판을 치운다(유닛 비우기 + 결과 폴더). 살아 있는 판은 op 가 거절한다(false). */
export async function reapRunUnit(slug: string, runId: number): Promise<boolean> {
  const { callTaskOp } = await op();
  const r = await callTaskOp({ op: "reap", unit: jobUnitName(slug, runId), keep_dir: false });
  return r.ok;
}

/** 판 결과 폴더의 stderr 꼬리 — 게이트웨이 그룹이 읽는다. 없으면 빈 문자열. */
export async function runUnitStderrTail(slug: string, runId: number, max = 2048): Promise<string> {
  const [{ sandboxDataRoot }, fsp] = await Promise.all([op(), import("node:fs/promises")]);
  const p = `${sandboxDataRoot()}/${slug}/${runId}-${JOB_UNIT_MARK}${JOB_ATTEMPT}/out/stderr.log`;
  try {
    const fh = await fsp.open(p, "r");
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, max);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      return buf.toString("utf8").trim();
    } finally { await fh.close(); }
  } catch { return ""; }
}

/**
 * 끝난 판의 결과 폴더를 치운다(이 워크스페이스 · 한 번에 limit 개) — 기다리던 게이트웨이가 교대로 사라지면 아무도 안 치운다.
 *  · 행이 아직 running 인 것은 건드리지 않는다(판이 살아 있거나, 유령 정리가 먼저다).
 *  · 막 만든 폴더(launch 가 판을 세우는 중)를 피하려고 minAgeMs 보다 오래된 것만 본다.
 *  · 살아 있는 판은 op 가 거절한다 — 이중 안전.
 */
export async function reapFinishedRunUnits(
  slug: string,
  runningOf: (ids: number[]) => Promise<Set<number>>,
  o: { limit?: number; minAgeMs?: number; now?: number } = {},
): Promise<number> {
  const [{ sandboxDataRoot }, fsp] = await Promise.all([op(), import("node:fs/promises")]);
  const dir = `${sandboxDataRoot()}/${slug}`;
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const now = o.now ?? Date.now();
  const cand: number[] = [];
  for (const n of names) {
    const id = runIdOfJobDir(n);
    if (id === null) continue;
    const st = await fsp.stat(`${dir}/${n}`).catch(() => null);
    if (!st || now - st.mtimeMs < (o.minAgeMs ?? 10 * 60_000)) continue;
    cand.push(id);
    if (cand.length >= (o.limit ?? 20)) break;
  }
  if (!cand.length) return 0;
  const running = await runningOf(cand);
  let n = 0;
  for (const id of cand) {
    if (running.has(id)) continue;
    if (await reapRunUnit(slug, id)) n++;
  }
  return n;
}
