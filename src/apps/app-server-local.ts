// 자가호스팅 앱 서버 실행면(#4487 앱 v2-8 2단계 · 결정 #5052) — Lambda 가 없는 박스에서 같은 zip 을 Docker 컨테이너(앱 × 판)로 돌린다.
//
//  흐름(배포 · 멈춤 · 지우기 · 정리 · 상태 점검 · 앱 주소 · 백그라운드 작업)은 Lambda 와 같은 함수 실행면 겉면(LambdaApi)으로 이 모듈을 부른다 — 그래서
//  함수 · 판 · 별칭 · 동시 실행 0 · 흘려 받기 · 비동기 부르기 · 레이어를 박스 디스크와 컨테이너로 흉내 낸다. 흐름의 잠금 · 상한 · 토큰 · 별칭 기록 · 판 정리는
//  그대로 한 벌이다(app-server-host 머리말).
//  자리(stateDir("app-servers") · env LIVELY_APP_SERVER_LOCAL_DIR):
//   zips/<zip 키>                         빌드 결과(zip 저장소 — app-server-config zipKeyFor · 앞자리 없음)
//   fn/<워크스페이스>/<함수>/meta.json      $LATEST 설정 · 태그 · 별칭 · 동시 실행 · 판 번호(0600 — env 에 앱 서버 토큰이 있다)
//   fn/<워크스페이스>/<함수>/latest.zip     코드 올리기 때 zip 저장소에서 복사(Lambda COPY 와 같다 — 그 뒤 zip 이 지워져도 판을 고정할 수 있다)
//   fn/<워크스페이스>/<함수>/v/<판>/        판 고정 때 푼 코드(code/ · 읽기 전용으로 /var/task) · 그 판의 설정(version.json · 0600)
//   layers/<이름>/<판>/files/              레이어(검사 층) — 그 안의 폴더마다 /opt/<폴더> 로 읽기 전용
//   run/<컨테이너>.env                      띄울 때마다 새로 쓰는 env 파일(0600 · 검사 층 열쇠가 매번 다르다 · docker run 이 읽은 직후 지운다)
//   build/<빌드>/out/                       빌드 컨테이너의 /out — 끝나면 zips/ 로 옮기고 지운다
//  Lambda 와 다른 점:
//   · 판은 «판 폴더» 다 — 코드는 판 고정 때 풀고, 판 폴더가 없으면 그 판은 없다(상태 점검 #4887 이 같은 빌드로 다시 올린다). 컨테이너를 띄우다 Docker 가 실패하면
//     그 판을 Failed 로 적는다(점검이 다시 올린다 · 성공하면 걷힌다). 앱이 시작하자마자 끝나는 것은 Lambda 처럼 부르기 실패(Runtime.ExitError)다.
//   · 동시 실행 0(멈춤) = 그 함수의 컨테이너를 모두 내리고 부르기를 TooManyRequestsException 으로 거절한다.
//   · 이 모듈이 웹 어댑터다 — 사건(함수 주소 모양 JSON)을 HTTP 로 풀어 검사 층(:8099)에 보내고 답을 «HTTP 통합 응답» 틀로 되돌린다. 마감은 x-amzn-lambda-context 의
//     deadline(그 판의 Timeout)으로 실어 보낸다(검사 층이 Lambda 에서와 같게 읽는다). REPORT 줄을 지어 게이트웨이 셈(app-server-usage)이 같은 꼴로 읽게 한다.
//   · 재우기 · 깨우기(#1437 Sablier 류 · 결정 ④): 부를 때 컨테이너가 없으면 띄우고(준비 = 검사 층 /_lively/guard/ready 200 · 기본 20초), 한가한 지
//     idle_sleep_min(워크스페이스 기본 10분 · 앱별 값 · 0 = 안 재움)이 지나면 내린다. 이 게이트웨이가 쥔 요청이 있거나 열린 작업이 그 판을 쓰면 안 내린다.
//   · 메모리 예산(결정 ④ · 레인 조율 2026-10-28): 이 워크스페이스의 깨어 있는 컨테이너 메모리 합 ≤ local_memory_mb(관리자 칸 · 기본 2048) · 박스 전체 합 ≤ 박스 천장
//     (env LIVELY_APP_SERVER_LOCAL_MEMORY_MAX_MB · 기본 Docker 메모리의 50%). 넘으면 같은 워크스페이스의 재울 수 있는 컨테이너를 오래 쉰 것부터 내리고, 그래도 넘으면
//     띄우지 않고 TooManyRequestsException(까닭 글) — 책임자 · 관리자에게 알린다(한 시간에 한 번). 안 재움 앱은 내리지 않는다.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ChildProcess } from "node:child_process";
import { logger } from "../log.js";
import { AwsError } from "../net/aws/aws-json.js";
import type * as lam from "../net/aws/lambda-lite.js";
import { stateDir } from "../ops/state-dir.js";
import { blobTenant } from "./app-blob-store.js";
import { HTTP_INTEGRATION_CT } from "./app-server-stream.js";
import { GUARD_READY_PATH } from "./app-server-guard.js";
import {
  DockerDriver, DockerError, GUARD_IN_CONTAINER, appRunPolicy, buildRunPolicy, type AppRunSpec, type BuildRunSpec, type ContainerDriver,
} from "./app-server-docker.js";
import { unzipTo, UnzipRejected } from "./app-server-unzip.js";
import type { LambdaApi, ZipStore } from "./app-server-host.js";
import { LOCAL_ADAPTER_LAYER_ARN, LOCAL_IMAGE_RE, localImage } from "./app-server-config.js";
import {
  LOCAL_BUCKET, NAME_RE, cfgOf, copyZipIn, fnPath, layersOf, notFound, readJson, readMeta, readVersion, versionKeyOf, versionPath, withFnLock, writeJson, writeMeta, zipPathOf,
  type FnMeta, type VersionMeta,
} from "./app-server-local-disk.js";
import { errorOut, preludeOf, reportLine, requestOfEvent, type FnUrlEvent } from "./app-server-local-wire.js";

export { LOCAL_BUCKET, zipPathOf } from "./app-server-local-disk.js";
export { preludeOf, reportLine, requestOfEvent } from "./app-server-local-wire.js";

/** 웹 어댑터 레이어 자리 — 로컬은 이 모듈이 어댑터라 레이어가 없다(이 ARN 은 마운트하지 않는다 · app-server-config 와 같은 값). */
export const LOCAL_ADAPTER_LAYER = LOCAL_ADAPTER_LAYER_ARN;
export const DEFAULT_LOCAL_NETWORK = "lvly-apps";
const LAYER_ARN_RE = /^lively-local:layer:([A-Za-z0-9_-]{1,64}):(\d{1,6})$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** 빌드 결과 zip 상한 — 빌더가 풀린 크기 245MB 에서 먼저 막으니 zip 은 그보다 작다. */
export const LOCAL_BUILD_ZIP_MAX_BYTES = 300 * 1024 * 1024;
/** 판 코드 풀기 상한 — Lambda 풀린 크기 250MB 보다 넉넉히(빌더가 245MB 에서 먼저 막는다). */
const UNZIP_LIMITS = { maxBytes: 512 * 1024 * 1024, maxEntries: 300_000 };

// ── 설정 · 시험 고리 ─────────────────────────────────────────────────────────────────────

export interface LocalDeps {
  driver?: ContainerDriver;
  root?: string;
  now?: () => number;
  /** 이 워크스페이스의 메모리 예산 · 재우기 기본(기본 = app_server_policy). */
  policy?: () => Promise<{ local_memory_mb: number; idle_sleep_min: number }>;
  /** 앱별 재우기 값(null = 워크스페이스 기본 · 기본 = org_app_server.idle_sleep_min). */
  appIdle?: (appId: string) => Promise<number | null>;
  /** 열린 작업이 쓰는 함수 판(그 판은 재우지 않는다 · 기본 = openJobPins). */
  jobPins?: (appId: string) => Promise<string[]>;
  notify?: (appId: string, title: string, body: string) => Promise<void>;
  /** 박스 천장(MB) — 기본 env LIVELY_APP_SERVER_LOCAL_MEMORY_MAX_MB · 없으면 Docker 메모리의 50%. */
  boxCeilingMb?: number;
  readyTimeoutMs?: number;
  /** 컨테이너 사용자 "uid:gid" — 기본 게이트웨이 계정(root 면 nobody). */
  user?: string;
  image?: string;
  network?: string;
}
let testDeps: LocalDeps = {};
/** 시험이 끼운다 — 바꾸면 이 게이트웨이가 기억하던 컨테이너 표도 비운다. */
export function setLocalDepsForTest(d: LocalDeps): void { testDeps = d; live.clear(); starting.clear(); reserved.clear(); prepared.clear(); adopted.clear(); }

interface Resolved {
  driver: ContainerDriver; root: string; now: () => number; image: string; network: string; user: string; readyTimeoutMs: number;
  policy: NonNullable<LocalDeps["policy"]>; appIdle: NonNullable<LocalDeps["appIdle"]>; jobPins: NonNullable<LocalDeps["jobPins"]>;
  notify: NonNullable<LocalDeps["notify"]>; boxCeilingMb: number | null;
}
let defaultDriver: ContainerDriver | null = null;
function resolved(env: NodeJS.ProcessEnv = process.env): Resolved {
  const d = testDeps;
  const uid = typeof process.getuid === "function" ? process.getuid() : 65534;
  const gid = typeof process.getgid === "function" ? process.getgid() : 65534;
  const ceiling = Number(String(env.LIVELY_APP_SERVER_LOCAL_MEMORY_MAX_MB ?? "").trim());
  return {
    driver: d.driver ?? (defaultDriver ??= new DockerDriver()),
    root: d.root ?? localRoot(env),
    now: d.now ?? Date.now,
    image: d.image ?? localImage(env),
    network: d.network ?? (String(env.LIVELY_APP_SERVER_NETWORK ?? "").trim() || DEFAULT_LOCAL_NETWORK),
    //  root 로 도는 게이트웨이면 컨테이너는 nobody 로 — 검사기가 uid 0 을 거절한다.
    user: d.user ?? (uid === 0 ? "65534:65534" : `${uid}:${gid}`),
    readyTimeoutMs: d.readyTimeoutMs ?? 20_000,
    policy: d.policy ?? (async () => { const p = await (await import("./app-server-store.js")).appServerPolicy(); return { local_memory_mb: p.local_memory_mb, idle_sleep_min: p.idle_sleep_min }; }),
    appIdle: d.appIdle ?? (async (appId) => (await (await import("./app-server-store.js")).getServerRow(appId))?.idle_sleep_min ?? null),
    jobPins: d.jobPins ?? (async (appId) => (await (await import("./app-jobs-store.js")).openJobPins(appId)).versions),
    notify: d.notify ?? defaultNotify,
    boxCeilingMb: d.boxCeilingMb ?? (Number.isInteger(ceiling) && ceiling >= 256 ? ceiling : null),
  };
}

/** 로컬 실행면의 뿌리(env LIVELY_APP_SERVER_LOCAL_DIR · 기본 게이트웨이 런타임 폴더 app-servers). */
export const localRoot = (env: NodeJS.ProcessEnv = process.env): string => path.resolve(String(env.LIVELY_APP_SERVER_LOCAL_DIR ?? "").trim() || stateDir("app-servers"));
const imageOf = (runtime: string | undefined, fallback: string): string => (runtime && LOCAL_IMAGE_RE.test(runtime) ? runtime : fallback);

async function defaultNotify(appId: string, title: string, body: string): Promise<void> {
  const [{ getApp }, { listActiveAdminIds }, { notifyAppInstaller }] = await Promise.all([import("../org/store/apps.js"), import("../org/store/members.js"), import("./notify.js")]);
  const app = await getApp(appId).catch(() => null);
  const to = new Set<string>(await listActiveAdminIds().catch(() => [] as string[]));
  if (app?.owner_member) to.add(app.owner_member);
  for (const m of to) await notifyAppInstaller({ appId, memberId: m, title, body, dedupe_key: `app-server-budget:${appId}` }).catch(() => null);
}

// ── 컨테이너 표(이 게이트웨이 · 박스 전체) ──────────────────────────────────────────────

interface Live {
  name: string; tenant: string; fn: string; appId: string; version: string; port: number; memMb: number;
  startedAt: number; lastUsed: number; inflight: number; idleMin: number | null;
}
const live = new Map<string, Live>();
const starting = new Map<string, Promise<{ live: Live; initMs: number | null }>>();
//  아직 떠 있지 않지만 예산을 잡아 둔 컨테이너(띄우는 중) — makeRoom 이 live 와 함께 센다(동시 시작이 예산을 넘지 않게).
const reserved = new Map<string, { tenant: string; memMb: number }>();
const prepared = new Map<string, Promise<void>>();
const adopted = new Set<string>();
const budgetToldAt = new Map<string, number>();
let boxInfo: { at: number; memMb: number; cpus: number } | null = null;

//  예산 판정은 한 줄로(이 게이트웨이) — makeRoom 안에 await(정책·appIdle·jobPins·docker stop)가 있어, 묶지 않으면 두 wake 가 서로 겹쳐 둘 다 «자리 있음» 으로 본다.
let budgetChain: Promise<unknown> = Promise.resolve();
async function withBudgetLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = budgetChain;
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  budgetChain = prev.then(() => mine);
  await prev.catch(() => undefined);
  try { return await fn(); } finally { release(); }
}

export const containerNameOf = (fn: string, version: string): string => `${fn}-v${version}`;
const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 256 });

async function boxOf(r: Resolved): Promise<{ memMb: number; cpus: number }> {
  if (boxInfo && r.now() - boxInfo.at < 5 * 60_000) return boxInfo;
  const i = await r.driver.info();
  boxInfo = { at: r.now(), ...i };
  return i;
}
/** 박스 천장(MB) — env 가 있으면 그것, 없으면 Docker 메모리의 50%. */
async function boxCeilingOf(r: Resolved): Promise<number> {
  if (r.boxCeilingMb) return r.boxCeilingMb;
  return Math.max(512, Math.floor((await boxOf(r)).memMb * 0.5));
}

/** 네트워크 · 이미지 준비 — 이 게이트웨이에서 한 번(실패하면 다음에 다시). */
async function prepare(r: Resolved, image: string): Promise<void> {
  const key = `${r.network}|${image}`;
  let p = prepared.get(key);
  if (!p) {
    p = (async () => { await r.driver.ensureNetwork(r.network); await r.driver.ensureImage(image); })();
    prepared.set(key, p);
    p.catch(() => prepared.delete(key));
  }
  await p;
}

/** 이 게이트웨이가 다시 뜬 뒤 — Docker 에 떠 있는 이 워크스페이스의 앱 서버 컨테이너를 표에 다시 넣는다(마지막으로 쓴 때는 지금으로 본다). 멈춘 것은 지운다. */
async function adoptRunning(r: Resolved, tenant: string): Promise<void> {
  if (adopted.has(tenant)) return;
  const rows = await r.driver.list("lvly.app-server=1");
  for (const c of rows) {
    if (c.labels["lvly.tenant"] !== tenant || live.has(c.name)) continue;
    if (!c.running || !c.port) { await r.driver.remove(c.name).catch(() => { /* 다음에 */ }); continue; }
    live.set(c.name, {
      name: c.name, tenant, fn: c.labels["lvly.fn"] ?? "", appId: c.labels["lvly.app"] ?? "", version: c.labels["lvly.version"] ?? "", port: c.port,
      memMb: Number(c.labels["lvly.mem"]) || 512, startedAt: r.now(), lastUsed: r.now(), inflight: 0, idleMin: null,
    });
  }
  adopted.add(tenant);
}

async function stopContainer(r: Resolved, name: string, graceSec = 5): Promise<void> {
  live.delete(name);
  await r.driver.remove(name, { graceSec }).catch((e) => logger.warn({ err: (e as Error)?.message, name }, "[app-server-local] 컨테이너를 내리지 못했다(다음 정리에서)"));
}
async function stopFunctionContainers(r: Resolved, fn: string, version?: string): Promise<void> {
  const names = new Set([...live.values()].filter((c) => c.fn === fn && c.tenant === blobTenant() && (!version || c.version === version)).map((c) => c.name));
  for (const c of await r.driver.list("lvly.app-server=1").catch(() => [])) {
    if (c.labels["lvly.fn"] === fn && c.labels["lvly.tenant"] === blobTenant() && (!version || c.labels["lvly.version"] === version)) names.add(c.name);
  }
  for (const n of names) await stopContainer(r, n);
}

/**
 * 예산 안에 name 을 띄울 자리를 만들고 그만큼 예약한다(null 이면 reserved 에 name 이 들어간다 — 부르는 쪽이 live.set 하면서 지운다).
 *  같은 워크스페이스의 재울 수 있는 한가한 컨테이너를 오래 쉰 것부터 내린다. 못 만들면 까닭 글(예약 안 함). 판정+예약은 한 잠금 안에서 — 동시 시작이 겹쳐도 합을 넘기지 않는다.
 */
async function makeRoom(r: Resolved, tenant: string, appId: string, needMb: number, name: string): Promise<string | null> {
  return withBudgetLock(async () => {
    const p = await r.policy();
    const ceiling = await boxCeilingOf(r);
    const budget = Math.min(p.local_memory_mb, ceiling);
    if (needMb > budget) return `이 앱 서버의 메모리(${needMb}MB)가 이 박스의 앱 서버 메모리 예산(${budget}MB)보다 큽니다 — web.server.memory_mb 를 줄이거나 관리자가 예산을 올리세요(app_server_limits_set local_memory_mb)`;
    //  쓰는 양 = 떠 있는 것(live) + 예약(띄우는 중) — name 은 뺀다(지금 이것을 띄우는 중).
    const usedExcept = (): { ws: number; box: number } => {
      let ws = 0, box = 0;
      for (const c of live.values()) { if (c.name === name) continue; box += c.memMb; if (c.tenant === tenant) ws += c.memMb; }
      for (const [n, rv] of reserved) { if (n === name) continue; box += rv.memMb; if (rv.tenant === tenant) ws += rv.memMb; }
      return { ws, box };
    };
    for (let guard = 0; guard < 64; guard++) {
      const { ws: wsUsed, box: boxUsed } = usedExcept();
      if (wsUsed + needMb <= budget && boxUsed + needMb <= ceiling) { reserved.set(name, { tenant, memMb: needMb }); return null; }
      //  같은 워크스페이스의 것만 내린다 — 남의 워크스페이스 컨테이너의 열린 작업은 이 문맥에서 볼 수 없다. 예약(아직 안 뜬 것)은 못 내린다.
      let victim: Live | null = null;
      for (const c of [...live.values()].filter((x) => x.name !== name && x.tenant === tenant && x.inflight === 0).sort((a, b) => a.lastUsed - b.lastUsed)) {
        const idle = c.idleMin ?? (await r.appIdle(c.appId).catch(() => null)) ?? p.idle_sleep_min;
        if (idle === 0) continue;   // 안 재움 앱은 내리지 않는다
        if ((await r.jobPins(c.appId).catch(() => [c.version])).includes(c.version)) continue;
        victim = c;
        break;
      }
      if (!victim) {
        return `이 박스의 앱 서버 메모리 예산이 다 찼습니다(이 워크스페이스 ${wsUsed}/${budget}MB · 박스 ${boxUsed}/${ceiling}MB · 필요 ${needMb}MB) — ` +
          "깨어 있는 앱 서버가 모두 일하는 중이거나 «안 재움» 입니다. 잠시 뒤 다시 하거나, 관리자가 예산(app_server_limits_set local_memory_mb)을 올리거나 «안 재움» 앱을 줄이세요";
      }
      //  고르는 사이(appIdle · jobPins await)에 그 컨테이너에 요청이 들어왔을 수 있다 — 내리기 직전에 다시 보고, 쓰는 중이면 다시 고른다.
      if (victim.inflight > 0 || live.get(victim.name) !== victim) continue;
      logger.info({ name: victim.name, need: needMb, app: appId }, "[app-server-local] 예산을 맞추려고 오래 쉰 앱 서버를 재웠다(#4487)");
      await stopContainer(r, victim.name);
    }
    return "예산을 맞추지 못했습니다";
  });
}

/** 시작 실패 — 부르는 쪽은 Lambda 와 같은 꼴(오류 본문 + REPORT)로 받는다. */
class StartFailure extends Error {
  constructor(readonly errorType: string, message: string, readonly log: string) { super(message); }
}

/** env 파일 — KEY=VALUE 한 줄씩(Docker --env-file 꼴 · 따옴표를 풀지 않는다). 줄바꿈 든 값은 받지 않는다. */
function envFileText(vars: Record<string, string>): string {
  return Object.entries(vars).map(([k, v]) => {
    if (!ENV_KEY_RE.test(k) || /[\r\n\0]/.test(v)) throw new AwsError(400, "InvalidParameterValueException", `환경 변수 ${k.slice(0, 40)} 를 컨테이너에 넘길 수 없습니다(이름 꼴 · 줄바꿈)`);
    return `${k}=${v}\n`;
  }).join("");
}

/** 검사 층이 준비됐나(/_lively/guard/ready → 200 + x-lively-guard: ready). */
function probeReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const q = http.get({ host: "127.0.0.1", port, path: GUARD_READY_PATH, timeout: 1000, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 && res.headers["x-lively-guard"] === "ready");
    });
    q.on("timeout", () => q.destroy());
    q.on("error", () => resolve(false));
  });
}

/** 그 판의 컨테이너를 깨운다(이미 깨어 있으면 그것) — 없으면 예산을 맞추고 띄운 뒤 준비를 기다린다. 처음 띄웠으면 initMs. */
async function wake(r: Resolved, m: FnMeta, vm: VersionMeta): Promise<{ live: Live; initMs: number | null }> {
  const tenant = blobTenant();
  const name = containerNameOf(m.name, vm.version);
  const have = live.get(name);
  if (have) return { live: have, initMs: null };
  const pending = starting.get(name);
  if (pending) return pending;
  const p = (async (): Promise<{ live: Live; initMs: number | null }> => {
    await adoptRunning(r, tenant).catch((e) => logger.warn({ err: (e as Error)?.message }, "[app-server-local] 떠 있는 컨테이너 목록을 못 읽었다"));
    const again = live.get(name);
    if (again) return { live: again, initMs: null };
    const t0 = r.now();
    const appId = m.tags["lvly:app"] ?? "";
    const memMb = vm.config.MemorySize ?? 512;
    //  이미지 = 그 판의 런타임(배포가 env 의 이미지를 적는다 — 이미지를 바꾸면 빌드 지문이 바뀌어 새 판이 된다 · 옛 판은 제 이미지로 돈다).
    const image = imageOf(vm.config.Runtime, r.image);
    await prepare(r, image);
    const room = await makeRoom(r, tenant, appId, memMb, name);
    if (room) {
      //  같은 박스의 다른 워크스페이스에 같은 id 앱이 있을 수 있어 키에 워크스페이스를 넣는다(한쪽 알림이 다른 쪽을 한 시간 막지 않게).
      const toldKey = `${tenant}/${appId}`;
      const last = budgetToldAt.get(toldKey) ?? 0;
      if (r.now() - last > 60 * 60_000) {
        budgetToldAt.set(toldKey, r.now());
        void r.notify(appId, `앱 「${appId}」 의 서버를 띄우지 못했습니다 — 메모리 예산`, room).catch(() => { /* 알림 실패는 거절을 바꾸지 않는다 */ });
      }
      throw new AwsError(429, "TooManyRequestsException", room);
    }
    //  여기부터는 예약(makeRoom)을 잡은 상태다 — 떠서 live 에 들어가거나(그때 예약을 지운다 · live 가 대신 센다) 실패하면 반드시 예약을 푼다.
    try {
    await r.driver.remove(name).catch(() => { /* 지난 컨테이너가 남았으면 걷는다 */ });
    const dir = versionPath(r.root, m.name, vm.version);
    //  레이어 — 판 설정의 로컬 레이어마다 그 안의 폴더를 /opt/<폴더> 로(검사 층 = /opt/lively).
    const ro: AppRunSpec["ro"] = [{ host: path.join(dir, "code"), target: "/var/task" }];
    for (const arn of (vm.config.Layers ?? []).map((l) => l.Arn)) {
      const lm = LAYER_ARN_RE.exec(arn);
      if (!lm) continue;
      const files = path.join(r.root, "layers", lm[1]!, lm[2]!, "files");
      for (const ent of await fsp.readdir(files, { withFileTypes: true }).catch(() => [])) {
        if (ent.isDirectory() && /^[A-Za-z0-9_-]{1,64}$/.test(ent.name)) ro.push({ host: path.join(files, ent.name), target: `/opt/${ent.name}` });
      }
    }
    if (!ro.some((x) => x.target === "/opt/lively")) throw new StartFailure("Runtime.InvalidEntrypoint", "검사 층 레이어가 판에 없습니다", "검사 층(/opt/lively)이 없어 띄우지 않았습니다");
    const runDir = path.join(r.root, "run");
    await fsp.mkdir(runDir, { recursive: true, mode: 0o700 });
    const envFile = path.join(runDir, `${name}.env`);
    const vars = {
      ...(vm.config.Environment?.Variables ?? {}),
      LIVELY_GUARD_HOST: "0.0.0.0", LIVELY_GUARD_PORT: String(GUARD_IN_CONTAINER), LAMBDA_TASK_ROOT: "/var/task", _HANDLER: vm.config.Handler || "lively-run.sh", HOME: "/tmp",
      //  검사 층 열쇠(#4487 · #5108 전의 막이) — 검사 층이 앱으로 넘길 때 x-lively-guard-key 로 싣고, SDK livelyMember 가 같은 값인지 본다.
      //   박스 위 다른 프로세스가 컨테이너 IP 의 앱 포트로 바로 보낸 요청엔 이 값이 없다. 띄울 때마다 새로 짓는다.
      LIVELY_GUARD_KEY: crypto.randomBytes(24).toString("base64url"),
    };
    await fsp.writeFile(envFile, envFileText(vars), { mode: 0o600 });
    const box = await boxOf(r).catch(() => ({ memMb: 0, cpus: 1 }));
    const cpus = Math.max(0.5, Math.min(box.cpus || 1, Math.round((memMb / 1769) * 100) / 100));
    const apiUrl = vm.config.Environment?.Variables?.LIVELY_API_URL ?? "";
    const spec: AppRunSpec = {
      name, image, network: r.network, memoryMb: memMb, tmpMb: vm.config.EphemeralStorage?.Size ?? 512, cpus, pids: 512, user: r.user, ro, envFile,
      guardPort: GUARD_IN_CONTAINER, hostGateway: /^https?:\/\/host\.docker\.internal(?::\d+)?(\/|$)/.test(apiUrl),
      labels: { "lvly.app-server": "1", "lvly.tenant": tenant, "lvly.app": appId || "unknown", "lvly.fn": m.name, "lvly.version": vm.version, "lvly.mem": String(memMb) },
      command: ["/bin/sh", "/opt/lively/bootstrap"],
    };
    let port: number;
    try {
      try { ({ port } = await r.driver.runApp(spec, appRunPolicy(r.root, image, r.network))); }
      catch (e) {
        //  네트워크 · 이미지가 (운영자가 docker network rm · prune 로) 사라졌을 수 있다 — prepared 캐시는 지난 성공을 기억해 prepare 가 그냥 지나가므로, 지우고 한 번 다시 준비해 다시 띄운다.
        //  네트워크 · 이미지가 사라진 오류만 좁게 본다(«not found» 단독은 OCI 실행 오류에도 들어가 엉뚱하게 재시도하면 이름 충돌로 진짜 원인을 가린다).
        if (!/No such network|No such image|network [^ ]* ?not found|manifest [^ ]* ?not found/i.test((e as Error)?.message ?? "")) throw e;
        prepared.delete(`${r.network}|${image}`);
        await r.driver.remove(name).catch(() => { /* 첫 시도가 컨테이너를 만들었으면 이름 충돌을 막으려 걷는다 */ });
        await prepare(r, image);
        ({ port } = await r.driver.runApp(spec, appRunPolicy(r.root, image, r.network)));
      }
    }
    catch (e) {
      //  Docker 가 띄우지 못했다(앱 탓이 아니다) — 그 판을 Failed 로 적어 상태 점검이 같은 빌드로 다시 올리게 한다.
      const reason = (e as Error)?.message ?? String(e);
      await markVersionFailed(r, m.name, vm.version, reason).catch(() => { /* 다음 점검이 다시 본다 */ });
      await r.driver.remove(name).catch(() => { /* 남은 것 */ });
      throw new AwsError(503, "ServiceException", `앱 서버 컨테이너를 띄우지 못했습니다: ${reason.slice(0, 400)}`);
    } finally {
      //  docker run 은 env 파일을 띄울 때 한 번 읽는다(다시 띄우지 않는다 — --restart no) — 곧바로 지워 열쇠 · 토큰을 디스크에 남기지 않는다.
      await fsp.rm(envFile, { force: true }).catch(() => { /* 남으면 정비가 걷는다 */ });
    }
    const until = r.now() + r.readyTimeoutMs;
    let nextState = 0;
    for (;;) {
      if (port && await probeReady(port)) break;   // 0 = 포트를 내기 전에 끝났다(아래 상태 보기가 까닭을 읽는다)
      if (r.now() >= nextState) {
        nextState = r.now() + 500;
        const st = await r.driver.state(name).catch(() => null);
        if (!st || !st.running) {
          const logs = await r.driver.logs(name, 80);
          await r.driver.remove(name).catch(() => { /* 다음에 */ });
          const oom = st?.oomKilled ? `\n메모리 상한(${memMb}MB · web.server.memory_mb)을 넘어 멈췄습니다` : "";
          throw new StartFailure("Runtime.ExitError", `Runtime exited with error: exit status ${st?.exitCode ?? "?"}`, `${logs}${oom}`);
        }
      }
      if (r.now() >= until) {
        const logs = await r.driver.logs(name, 80);
        await r.driver.remove(name).catch(() => { /* 다음에 */ });
        throw new StartFailure("Extension.Crash", "exit status 1",
          `${logs}\nError: "web application did not become ready within ${Math.round(r.readyTimeoutMs / 1000)}s (AWS_LWA_READINESS_CHECK_TIMEOUT_SECONDS); failing initialization"`);
      }
      await new Promise((ok) => setTimeout(ok, 100));
    }
    if (vm.failed) await markVersionFailed(r, m.name, vm.version, null).catch(() => { /* 다음에 */ });
    const now = r.now();
    const l: Live = { name, tenant, fn: m.name, appId, version: vm.version, port, memMb, startedAt: now, lastUsed: now, inflight: 0, idleMin: null };
    live.set(name, l);
    logger.info({ name, app: appId, ms: now - t0, port }, "[app-server-local] 앱 서버 컨테이너를 띄웠다(#4487)");
    return { live: l, initMs: now - t0 };
    } finally {
      //  live.set 과 이 사이에는 await 가 없어 그 틈에 다른 makeRoom 이 끼어들지 못한다 — 예약과 live 가 겹쳐 세지도, 둘 다 빠지지도 않는다.
      reserved.delete(name);
    }
  })();
  starting.set(name, p);
  try { return await p; } finally { starting.delete(name); }
}

async function markVersionFailed(r: Resolved, fn: string, v: string, reason: string | null): Promise<void> {
  await withFnLock(`${blobTenant()}/${fn}`, async () => {
    const file = path.join(versionPath(r.root, fn, v), "version.json");
    const vm = await readJson<VersionMeta>(file);
    if (!vm) return;
    vm.failed = reason ? { at: new Date(r.now()).toISOString(), reason: reason.slice(0, 500) } : null;
    await writeJson(file, vm);
  });
}

/** 이름 · 판(또는 별칭) → 함수 · 그 판. 없으면 404 · 멈춤이면 429(Lambda 동시 실행 0 과 같은 글). */
async function target(r: Resolved, fn: string, qualifier: string): Promise<{ m: FnMeta; vm: VersionMeta }> {
  const m = await readMeta(r.root, fn);
  if (!m) throw notFound(fn);
  if (m.concurrency === 0) throw new AwsError(429, "TooManyRequestsException", "Rate Exceeded. — 이 앱 서버는 멈춰 있습니다(동시 실행 0)");
  const version = m.aliases[qualifier]?.version ?? qualifier;
  const vm = await readVersion(r.root, fn, version);
  if (!vm) throw notFound(`${fn}:${qualifier}`);
  return { m, vm };
}

async function invokeStreamLocal(r: Resolved, fn: string, qualifier: string, payloadJson: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<lam.StreamInvokeOut> {
  const { m, vm } = await target(r, fn, qualifier);
  let ev: FnUrlEvent;
  try { ev = JSON.parse(payloadJson) as FnUrlEvent; } catch { throw new AwsError(400, "InvalidRequestContentException", "사건 JSON 을 읽지 못했습니다"); }
  const id = crypto.randomUUID();
  const t0 = r.now();
  let woke: { live: Live; initMs: number | null };
  try { woke = await wake(r, m, vm); }
  catch (e) {
    if (e instanceof StartFailure) return errorOut(vm.version, e.errorType, e.message, `${e.log}\n${reportLine(id, r.now() - t0, vm.config.MemorySize ?? 512, r.now() - t0, "error", e.errorType)}`);
    throw e;
  }
  const memMb = vm.config.MemorySize ?? 512;
  const fnDeadline = t0 + (vm.config.Timeout ?? 900) * 1000;
  for (let attempt = 0; ; attempt++) {
    const l = woke.live;
    const req = requestOfEvent(ev, fnDeadline, `lively-local:function:${fn}:${vm.version}`, id);
    l.inflight++;
    l.lastUsed = r.now();
    let released = false;
    const release = (): void => { if (released) return; released = true; l.inflight = Math.max(0, l.inflight - 1); l.lastUsed = r.now(); };
    try {
      return await sendStream(r, l, req, { id, t0, memMb, initMs: woke.initMs, fnDeadline, timeoutMs: opts.timeoutMs, signal: opts.signal, version: vm.version, release });
    } catch (e) {
      release();
      //  컨테이너가 그 사이 죽었다(연결 거부 — 요청은 앱에 안 닿았다) · 한 번만 다시 깨워 다시 보낸다.
      if ((e as NodeJS.ErrnoException)?.code === "ECONNREFUSED" && attempt === 0) {
        if (live.get(l.name) === l) live.delete(l.name);   // 그사이 누가 다시 띄운 새 항목은 지우지 않는다
        try { woke = await wake(r, m, vm); continue; }
        catch (e2) {
          if (e2 instanceof StartFailure) return errorOut(vm.version, e2.errorType, e2.message, `${e2.log}\n${reportLine(id, r.now() - t0, memMb, null, "error", e2.errorType)}`);
          throw e2;
        }
      }
      if (e instanceof AwsError) throw e;
      throw new AwsError(0, "NetworkError", `앱 서버 컨테이너를 부르지 못했습니다: ${(e as Error)?.message ?? e}`);
    }
  }
}

/** 검사 층에 보내고 답을 흘려 받기 꼴로 — 앞머리를 받으면 돌려주고, 본문은 events 로 이어진다. 끝에 REPORT. */
function sendStream(r: Resolved, l: Live, req: ReturnType<typeof requestOfEvent>, o: {
  id: string; t0: number; memMb: number; initMs: number | null; fnDeadline: number; timeoutMs: number; signal?: AbortSignal; version: string; release: () => void;
}): Promise<lam.StreamInvokeOut> {
  return new Promise((resolve, reject) => {
    let why: "gateway" | "fn" | null = null;
    let answered = false;
    const hreq = http.request({ host: "127.0.0.1", port: l.port, method: req.method, path: req.path, headers: req.headers, agent: keepAlive });
    const cut = (w: "gateway" | "fn"): void => { if (!why) { why = w; hreq.destroy(new Error(w === "fn" ? "함수 시간 초과" : "게이트웨이 기다림 초과")); } };
    const tGate = setTimeout(() => cut("gateway"), Math.max(1, o.timeoutMs));
    const tFn = setTimeout(() => cut("fn"), Math.max(1, o.fnDeadline - r.now()));
    const onAbort = (): void => cut("gateway");
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (): void => { clearTimeout(tGate); clearTimeout(tFn); o.signal?.removeEventListener("abort", onAbort); o.release(); };
    hreq.on("error", (e) => {
      if (answered) return;   // 본문 도중 — events 가 맡는다
      answered = true;
      done();
      if (why === "gateway") reject(new AwsError(0, "Timeout", `앱 서버가 ${Math.round(o.timeoutMs / 1000)}초 안에 답하지 않았습니다`));
      else if (why === "fn") resolve(errorOut(o.version, "Sandbox.Timedout", "Task timed out", reportLine(o.id, r.now() - o.t0, o.memMb, o.initMs, "timeout", "Sandbox.Timedout")));
      //  연결 거부는 부르는 쪽이 다시 띄워 다시 보낸다(요청이 앱에 안 닿았다). 그 밖에 끊겼으면 컨테이너가 도중에 죽었는지 본다.
      else if ((e as NodeJS.ErrnoException).code === "ECONNREFUSED") reject(e);
      else void diedDuring(r, l, o).then((out) => (out ? resolve(out) : reject(e)), () => reject(e));
    });
    hreq.on("response", (res) => {
      answered = true;
      async function* events(): AsyncGenerator<lam.StreamEvent> {
        let status: "ok" | "error" | "timeout" = "ok";
        try {
          yield { type: "chunk", data: preludeOf(res.statusCode ?? 502, res.headers) };
          try {
            for await (const c of res) yield { type: "chunk", data: c as Buffer };
            if (!res.complete) status = "error";
          } catch {
            if (why === "gateway") throw new AwsError(0, "Timeout", "앱 서버 응답을 다 받기 전에 시간이 지났습니다");
            status = why === "fn" ? "timeout" : "error";
          }
          yield { type: "complete", errorCode: null, errorDetails: null, log: reportLine(o.id, r.now() - o.t0, o.memMb, o.initMs, status, status === "timeout" ? "Sandbox.Timedout" : null) };
        } finally {
          if (!res.complete) res.destroy();
          done();
        }
      }
      resolve({ status: 200, executedVersion: o.version, contentType: HTTP_INTEGRATION_CT, events: events() });
    });
    hreq.end(req.body);
  });
}

/**
 * 부르는 도중 컨테이너가 죽었나(메모리 상한 · 앱이 끝남) — 죽었으면 Lambda 와 같은 꼴의 함수 오류(Runtime.OutOfMemory · Runtime.ExitError)로 돌려주고
 *  죽은 컨테이너를 걷는다(다음 부르기가 새로 띄운다). 끊긴 직후엔 Docker 가 아직 «도는 중» 이라 할 수 있어 2초까지 다시 본다. 살아 있으면 null(망 오류).
 */
async function diedDuring(r: Resolved, l: Live, o: { id: string; t0: number; memMb: number; initMs: number | null; version: string }): Promise<lam.StreamInvokeOut | null> {
  let st = await r.driver.state(l.name).catch(() => null);
  for (let i = 0; i < 20 && st?.running; i++) { await new Promise((ok) => setTimeout(ok, 100)); st = await r.driver.state(l.name).catch(() => null); }
  if (st?.running) return null;
  const logs = await r.driver.logs(l.name, 80).catch(() => "");
  if (live.get(l.name) === l) live.delete(l.name);   // 그사이 누가 다시 띄운 새 항목은 지우지 않는다
  await r.driver.remove(l.name).catch(() => { /* 다음 정비 */ });
  const oom = !!st?.oomKilled;
  const type = oom ? "Runtime.OutOfMemory" : "Runtime.ExitError";
  const msg = oom ? "Runtime exited with error: signal: killed" : `Runtime exited with error: exit status ${st?.exitCode ?? "?"}`;
  const note = oom ? `\n메모리 상한(${o.memMb}MB · web.server.memory_mb)을 넘어 멈췄습니다` : "";
  logger.warn({ name: l.name, oom, exit: st?.exitCode ?? null }, "[app-server-local] 부르는 도중 앱 서버 컨테이너가 멈췄다(#4487)");
  return errorOut(o.version, type, msg, `${logs}${note}\n${reportLine(o.id, r.now() - o.t0, o.memMb, o.initMs, "error", type)}`);
}

/** 비동기로 부르기 — 받아 두고 곧바로 돌려준다(202). 깨우기 · 보내기는 뒤에서 — 결과는 검사 층이 게이트웨이에 보고한다(못 닿으면 감시가 다시 부른다). */
async function invokeAsyncLocal(r: Resolved, fn: string, qualifier: string, payload: unknown): Promise<{ status: number; requestId: string | null }> {
  const { m, vm } = await target(r, fn, qualifier);
  const ev = (payload && typeof payload === "object" ? payload : {}) as FnUrlEvent;
  const id = crypto.randomUUID();
  const tenantCtx = (await import("../org/tenant-context.js"));
  const ctx = tenantCtx.currentTenant();
  const run = async (): Promise<void> => {
    const t0 = r.now();
    const fnDeadline = t0 + (vm.config.Timeout ?? 900) * 1000;
    const req = requestOfEvent(ev, fnDeadline, `lively-local:function:${fn}:${vm.version}`, id);
    for (let attempt = 0; ; attempt++) {
      const { live: l } = await wake(r, m, vm);
      l.inflight++;
      l.lastUsed = r.now();
      let connRefused = false;
      try {
        await new Promise<void>((resolve, reject) => {
          const hreq = http.request({ host: "127.0.0.1", port: l.port, method: req.method, path: req.path, headers: req.headers, agent: keepAlive });
          //  함수 시간 + 여유 뒤엔 끊는다(검사 층이 그 앞에서 결과를 보고하고 답한다 · 이것은 마지막 울타리).
          const t = setTimeout(() => hreq.destroy(new Error("함수 시간 초과")), Math.max(1, fnDeadline - r.now()) + 30_000);
          hreq.on("response", (res) => {
            res.resume();
            res.on("end", () => { clearTimeout(t); resolve(); });
            res.on("error", () => { clearTimeout(t); resolve(); });
            if ((res.statusCode ?? 0) >= 300) logger.warn({ fn, version: vm.version, status: res.statusCode, guard: res.headers["x-lively-guard"] }, "[app-server-local] 비동기 부르기를 검사 층이 받지 않았다");
          });
          //  연결 거부 = 컨테이너가 그 사이 죽었다(요청이 앱에 안 닿았다) — 동기 길처럼 한 번만 다시 띄워 다시 보낸다. 그 밖에 끊긴 것은 검사 층이 결과를 보고한다(여기선 놓아준다).
          hreq.on("error", (e) => {
            clearTimeout(t);
            if ((e as NodeJS.ErrnoException).code === "ECONNREFUSED") { connRefused = true; reject(e); return; }
            logger.warn({ fn, version: vm.version, err: e.message }, "[app-server-local] 비동기 부르기가 끊겼다"); resolve();
          });
          hreq.end(req.body);
        });
        return;
      } catch (e) {
        if (connRefused && attempt === 0) { if (live.get(l.name) === l) live.delete(l.name); continue; }   // 죽은 컨테이너는 wake 가 걷고 새로 띄운다(그사이 새 항목은 안 지움)
        throw e;
      } finally {
        l.inflight = Math.max(0, l.inflight - 1);
        l.lastUsed = r.now();
      }
    }
  };
  const go = (): void => { run().catch((e) => logger.warn({ fn, version: vm.version, err: (e as Error)?.message ?? e }, "[app-server-local] 비동기 부르기 실패 — 감시가 다시 부른다")); };
  //  뒤에서 도는 일도 그 워크스페이스 문맥으로(설정 · 작업 판 조회가 테넌트 표를 읽는다).
  if (ctx) tenantCtx.withTenant(ctx, go); else go();
  return { status: 202, requestId: id };
}

// ── 함수 실행면(LambdaApi) ────────────────────────────────────────────────────────────────

/** 로컬 함수 실행면 — Lambda API 와 같은 꼴(app-server-host appServerApi 가 local 이면 이것을 준다). */
export function localLambdaApi(env: NodeJS.ProcessEnv = process.env): LambdaApi {
  const r = (): Resolved => resolved(env);
  const lockKey = (fn: string): string => `${blobTenant()}/${fn}`;
  return {
    getFunction: async (fn, q) => {
      const x = r();
      const m = await readMeta(x.root, fn);
      if (!m) return null;
      const conc = m.concurrency != null ? { Concurrency: { ReservedConcurrentExecutions: m.concurrency } } : {};
      if (!q || q === "$LATEST") return { Configuration: cfgOf(m), Code: { RepositoryType: "S3" }, Tags: { ...m.tags }, ...conc };
      const vm = await readVersion(x.root, fn, m.aliases[q]?.version ?? q);
      if (!vm) return null;
      const cfg: lam.FnConfiguration = { ...vm.config, ...(vm.failed ? { State: "Failed", StateReason: vm.failed.reason, StateReasonCode: "LocalStartFailed" } : {}) };
      return { Configuration: cfg, Code: { RepositoryType: "S3" }, Tags: { ...m.tags }, ...conc };
    },
    getFunctionConfiguration: async (fn, q) => {
      const x = r();
      const m = await readMeta(x.root, fn);
      if (!m) return null;
      if (!q || q === "$LATEST") return cfgOf(m);
      const vm = await readVersion(x.root, fn, m.aliases[q]?.version ?? q);
      return vm ? { ...vm.config, ...(vm.failed ? { State: "Failed", StateReason: vm.failed.reason } : {}) } : null;
    },
    createFunction: async (i) => {
      const x = r();
      return withFnLock(lockKey(i.FunctionName), async () => {
        const dir = fnPath(x.root, i.FunctionName);
        if (await readMeta(x.root, i.FunctionName)) throw new AwsError(409, "ResourceConflictException", `Function already exist: ${i.FunctionName}`);
        const z = await copyZipIn(x.root, i.Code, dir);
        const m: FnMeta = {
          v: 1, name: i.FunctionName, tenant: blobTenant(), tags: { ...(i.Tags ?? {}) }, aliases: {}, concurrency: null, seq: 0,
          config: {
            FunctionName: i.FunctionName, FunctionArn: `lively-local:function:${i.FunctionName}`, Runtime: i.Runtime, Role: i.Role, Handler: i.Handler,
            MemorySize: i.MemorySize, Timeout: i.Timeout, EphemeralStorage: { Size: i.EphemeralStorage?.Size ?? 512 }, Architectures: [...i.Architectures],
            Layers: layersOf(i.Layers).map((Arn) => ({ Arn })), Environment: { Variables: { ...i.Environment.Variables } },
            CodeSha256: z.sha, CodeSize: z.size, State: "Active", LastUpdateStatus: "Successful", Version: "$LATEST",
          },
        };
        await writeMeta(x.root, m);
        return cfgOf(m);
      });
    },
    updateFunctionCode: async (fn, code) => {
      const x = r();
      return withFnLock(lockKey(fn), async () => {
        const m = await readMeta(x.root, fn);
        if (!m) throw notFound(fn);
        const z = await copyZipIn(x.root, code, fnPath(x.root, fn));
        Object.assign(m.config, { CodeSha256: z.sha, CodeSize: z.size, State: "Active", LastUpdateStatus: "Successful" });
        delete m.config.LastUpdateStatusReason;
        await writeMeta(x.root, m);
        return cfgOf(m);
      });
    },
    updateFunctionConfiguration: async (fn, i) => {
      const x = r();
      return withFnLock(lockKey(fn), async () => {
        const m = await readMeta(x.root, fn);
        if (!m) throw notFound(fn);
        const c = m.config;
        if (i.Role !== undefined) c.Role = i.Role;
        if (i.Handler !== undefined) c.Handler = i.Handler;
        if (i.Runtime !== undefined) c.Runtime = i.Runtime;
        if (i.MemorySize !== undefined) c.MemorySize = i.MemorySize;
        if (i.Timeout !== undefined) c.Timeout = i.Timeout;
        if (i.EphemeralStorage !== undefined) c.EphemeralStorage = { Size: i.EphemeralStorage.Size };
        if (i.Layers !== undefined) c.Layers = layersOf(i.Layers).map((Arn) => ({ Arn }));
        if (i.Environment !== undefined) c.Environment = { Variables: { ...i.Environment.Variables } };
        c.LastUpdateStatus = "Successful";
        await writeMeta(x.root, m);
        return cfgOf(m);
      });
    },
    publishVersion: async (fn, i) => {
      const x = r();
      return withFnLock(lockKey(fn), async () => {
        const m = await readMeta(x.root, fn);
        if (!m) throw notFound(fn);
        if (i.CodeSha256 && i.CodeSha256 !== m.config.CodeSha256) throw new AwsError(412, "PreconditionFailedException", "CodeSha256 가 지금 코드와 다릅니다");
        //  Lambda 처럼 — 코드 · 설정이 마지막 판과 같으면 새 판을 만들지 않고 그 판을 돌려준다.
        if (m.seq > 0) {
          const last = await readVersion(x.root, fn, String(m.seq));
          if (last && versionKeyOf(last.config) === versionKeyOf(m.config)) return { ...last.config };
        }
        const v = String(m.seq + 1);
        const dir = versionPath(x.root, fn, v);
        await fsp.rm(dir, { recursive: true, force: true });
        await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
        try {
          await unzipTo(path.join(fnPath(x.root, fn), "latest.zip"), path.join(dir, "code"), UNZIP_LIMITS);
        } catch (e) {
          await fsp.rm(dir, { recursive: true, force: true }).catch(() => { /* 다음 정리 */ });
          if (e instanceof UnzipRejected) throw new AwsError(400, "InvalidParameterValueException", e.message);
          throw e;
        }
        //  판 폴더는 컨테이너가 게이트웨이 계정으로 읽는다(0700 — 박스의 다른 계정은 못 읽는다).
        const config: lam.FnConfiguration = { ...cfgOf(m), Version: v, State: "Active", LastUpdateStatus: "Successful", FunctionArn: `lively-local:function:${fn}:${v}` };
        const vm: VersionMeta = { v: 1, version: v, config, published_at: new Date(x.now()).toISOString(), failed: null };
        await writeJson(path.join(dir, "version.json"), vm);
        m.seq = Number(v);
        await writeMeta(x.root, m);
        return { ...config };
      });
    },
    listVersions: async (fn) => {
      const x = r();
      const m = await readMeta(x.root, fn);
      if (!m) throw notFound(fn);
      const out: lam.FnConfiguration[] = [{ ...cfgOf(m), Version: "$LATEST" }];
      const vdir = path.join(fnPath(x.root, fn), "v");
      const nums = (await fsp.readdir(vdir).catch(() => [] as string[])).filter((n) => /^\d{1,9}$/.test(n)).sort((a, b) => Number(a) - Number(b));
      for (const n of nums) { const vm = await readVersion(x.root, fn, n); if (vm) out.push({ ...vm.config }); }
      return out;
    },
    putAlias: async (fn, alias, version, description) => {
      const x = r();
      return withFnLock(lockKey(fn), async () => {
        const m = await readMeta(x.root, fn);
        if (!m) throw notFound(fn);
        if (!(await readVersion(x.root, fn, version))) throw notFound(`${fn}:${version}`);
        m.aliases[alias] = { version, description };
        await writeMeta(x.root, m);
        return { AliasArn: `lively-local:function:${fn}:${alias}`, Name: alias, FunctionVersion: version, Description: description };
      });
    },
    invokeStream: (fn, q, payload, o) => invokeStreamLocal(r(), fn, q, payload, o),
    invokeAsync: (fn, q, payload) => invokeAsyncLocal(r(), fn, q, payload),
    listLayerVersions: async (layer) => {
      const x = r();
      if (!NAME_RE.test(layer)) return [];
      const dir = path.join(x.root, "layers", layer);
      const out: lam.LayerVersion[] = [];
      for (const n of await fsp.readdir(dir).catch(() => [] as string[])) {
        const meta = /^\d{1,6}$/.test(n) ? await readJson<lam.LayerVersion>(path.join(dir, n, "layer.json")) : null;
        if (meta) out.push(meta);
      }
      return out.sort((a, b) => a.Version - b.Version);
    },
    publishLayerVersion: async (layer, i) => {
      const x = r();
      if (!NAME_RE.test(layer)) throw new AwsError(400, "InvalidParameterValueException", `레이어 이름 꼴이 틀렸습니다: ${layer.slice(0, 64)}`);
      return withFnLock(`layer/${layer}`, async () => {
        const dir = path.join(x.root, "layers", layer);
        await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
        const have = (await fsp.readdir(dir).catch(() => [] as string[])).filter((n) => /^\d{1,6}$/.test(n)).map(Number);
        const v = (have.length ? Math.max(...have) : 0) + 1;
        const vdir = path.join(dir, String(v));
        await fsp.mkdir(vdir, { recursive: true, mode: 0o700 });
        const zip = path.join(vdir, "layer.zip");
        await fsp.writeFile(zip, i.zip, { mode: 0o600 });
        try { await unzipTo(zip, path.join(vdir, "files"), { maxBytes: 16 * 1024 * 1024, maxEntries: 64 }); }
        catch (e) { await fsp.rm(vdir, { recursive: true, force: true }).catch(() => undefined); throw e; }
        const meta: lam.LayerVersion = { LayerVersionArn: `lively-local:layer:${layer}:${v}`, Version: v, Description: i.description, CreatedDate: new Date(x.now()).toISOString() };
        await writeJson(path.join(vdir, "layer.json"), meta);
        return meta;
      });
    },
    deleteFunction: async (fn, q) => {
      const x = r();
      await withFnLock(lockKey(fn), async () => {
        const m = await readMeta(x.root, fn);
        if (!m) return;
        if (q) {
          if (Object.values(m.aliases).some((a) => a.version === q)) throw new AwsError(409, "ResourceConflictException", `별칭이 가리키는 판은 지우지 않습니다: ${fn}:${q}`);
          await stopFunctionContainers(x, fn, q);
          await fsp.rm(versionPath(x.root, fn, q), { recursive: true, force: true });
          return;
        }
        await stopFunctionContainers(x, fn);
        await fsp.rm(fnPath(x.root, fn), { recursive: true, force: true });
      });
    },
    putConcurrency: async (fn, n) => {
      const x = r();
      await withFnLock(lockKey(fn), async () => {
        const m = await readMeta(x.root, fn);
        if (!m) throw notFound(fn);
        m.concurrency = n;
        await writeMeta(x.root, m);
      });
      if (n === 0) await stopFunctionContainers(x, fn);
    },
    deleteConcurrency: async (fn) => {
      const x = r();
      await withFnLock(lockKey(fn), async () => {
        const m = await readMeta(x.root, fn);
        if (!m) return;
        m.concurrency = null;
        await writeMeta(x.root, m);
      });
    },
    //  기록은 Docker 가 컨테이너마다 쥔다(json-file · 10MB × 2) — 로그 그룹은 없다.
    ensureLogGroup: async () => { /* 없음 */ },
    deleteLogGroup: async () => { /* 없음 */ },
  };
}

// ── zip 저장소 ─────────────────────────────────────────────────────────────────────────

/** 로컬 zip 저장소 — zips/<키>. 판 번호는 없다(versionId 는 늘 null · 같은 키를 다시 쓰면 그 바이트가 지금 것이다). */
export function localZipStore(env: NodeJS.ProcessEnv = process.env): ZipStore {
  const root = (): string => resolved(env).root;
  return {
    bucket: LOCAL_BUCKET,
    prefix: "",
    head: async (key) => {
      try { const s = await fsp.stat(zipPathOf(root(), key)); return { size: s.size, versionId: null }; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    },
    remove: async (key) => { await fsp.rm(zipPathOf(root(), key), { force: true }); },
    uploadUrl: async () => { throw new Error("로컬 실행면의 빌드는 결과를 파일로 받습니다(localBuildRunner)"); },
  };
}

// ── 빌드 ──────────────────────────────────────────────────────────────────────────────

let buildSlots = 0;
const buildWaiters: Array<() => void> = [];
const buildConcurrency = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Number(String(env.LIVELY_APP_SERVER_BUILD_CONCURRENCY ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 1;
};
async function takeBuildSlot(env: NodeJS.ProcessEnv): Promise<() => void> {
  while (buildSlots >= buildConcurrency(env)) await new Promise<void>((ok) => buildWaiters.push(ok));
  buildSlots++;
  let given = false;
  return () => { if (given) return; given = true; buildSlots--; buildWaiters.shift()?.(); };
}

/** 빌드 한 번의 자리 — app-server-build runBuild 가 쓴다(세션 컨테이너 대신 자격 없는 일회용 컨테이너 · 결과는 파일로). */
export interface LocalBuildRunner {
  uploadUrl: string;
  /** 빌더를 띄운다 — 박스에 동시에 LIVELY_APP_SERVER_BUILD_CONCURRENCY(기본 1)개만(그 자리를 기다린다). */
  spawn(argv: string[]): Promise<ChildProcess>;
  /** 빌더가 성공한 뒤 — 결과 zip 을 zip 저장소 자리로 옮기고 코어가 잰 크기 · 지문을 돌려준다. */
  collect(): Promise<{ bytes: number; sha256_b64: string }>;
  kill(): Promise<void>;
  cleanup(): Promise<void>;
  memFloorMb: number;
}
export async function localBuildRunner(i: { appId: string; buildKey: string; zipKey: string; image: string }, env: NodeJS.ProcessEnv = process.env): Promise<LocalBuildRunner> {
  const r = resolved(env);
  //  빌드 이미지 = 빌드 지문에 든 런타임(app-server-config runtime) — 실행 컨테이너와 같은 이미지라 네이티브 모듈이 맞다.
  const image = imageOf(i.image, r.image);
  const buildRoot = path.join(r.root, "build");
  const work = path.join(buildRoot, crypto.randomBytes(8).toString("hex"));
  const outDir = path.join(work, "out");
  await fsp.mkdir(outDir, { recursive: true, mode: 0o700 });
  const tenant = blobTenant();
  const name = `lvly-build-${tenant.slice(0, 8)}-${i.appId}-${i.buildKey.slice(0, 12)}`;
  const memMb = (() => { const n = Number(String(env.LIVELY_APP_SERVER_BUILD_MEMORY_MB ?? "").trim()); return Number.isInteger(n) && n >= 512 && n <= 65_536 ? n : 2048; })();
  let release: (() => void) | null = null;
  const box = await boxOf(r).catch(() => ({ memMb: 0, cpus: 1 }));
  const spec: BuildRunSpec = {
    name, image, network: r.network, memoryMb: memMb, cpus: Math.max(1, Math.min(2, box.cpus || 1)), pids: 4096, user: r.user, outDir,
    labels: { "lvly.app-build": "1", "lvly.tenant": tenant, "lvly.app": i.appId },
    env: { HOME: "/tmp", npm_config_cache: "/tmp/.lively-npm-cache", CI: "1" }, hostGateway: false, command: [],
  };
  return {
    uploadUrl: `file://${r.driver.buildOutInContainer(spec)}/${i.buildKey}.zip`,
    memFloorMb: 0,   // 컨테이너 안 /proc/meminfo 는 박스 전체라 세션식 감시를 끈다 — 메모리는 컨테이너 상한(--memory)이 막는다
    spawn: async (argv) => {
      release = await takeBuildSlot(env);
      await prepare(r, image);
      await r.driver.remove(name).catch(() => { /* 지난 빌드가 남았으면 */ });
      return r.driver.spawnBuild({ ...spec, command: argv }, buildRunPolicy(buildRoot, image, r.network));
    },
    collect: async () => {
      //  빌드 컨테이너는 남의 설치 스크립트(npm)가 도는 곳이라 결과 자리(/out/<키>.zip)를 심링크 · FIFO · 큰 파일로 바꿔 둘 수 있다.
      //   그래서 ① 보통 파일만(lstat — 심링크를 안 따라간다) ② 상한 안 ③ 열 때도 심링크를 안 따라가고(O_NOFOLLOW) FIFO 에 매달리지 않게(O_NONBLOCK)
      //   ④ 연 fd 를 다시 fstat 로 확인(그 사이 바뀜) ⑤ fd 에서 임시 이름으로 흘려 담으며 크기를 센다. 적는 크기 · 지문은 빌더의 말이 아니라 코어가 잰 값이다.
      const from = path.join(outDir, `${i.buildKey}.zip`);
      const lst = await fsp.lstat(from).catch(() => null);
      if (!lst || !lst.isFile()) throw new Error("빌드 결과(zip)가 보통 파일이 아닙니다");
      if (lst.size > LOCAL_BUILD_ZIP_MAX_BYTES) throw new Error(`빌드 결과(zip)가 상한(${Math.round(LOCAL_BUILD_ZIP_MAX_BYTES / 1048576)}MB)을 넘습니다`);
      //  열기 오류(ELOOP · EACCES 등)의 원문엔 박스 경로가 들어간다 — 사용자에게 가는 글엔 싣지 않고 기록에만(빌드를 시킬 수 있는 구성원이 상태 조회로 경로를 읽지 않게 · #4801 규칙).
      const fh = await fsp.open(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
        .catch((e) => { logger.warn({ err: (e as Error)?.message, appId: i.appId }, "[app-server-local] 빌드 결과(zip)를 열지 못했다(#4487)"); throw new Error("빌드 결과(zip)를 읽지 못했습니다"); });
      try {
        const fst = await fh.stat();
        if (!fst.isFile()) throw new Error("빌드 결과(zip)가 보통 파일이 아닙니다");
        if (fst.size > LOCAL_BUILD_ZIP_MAX_BYTES) throw new Error(`빌드 결과(zip)가 상한(${Math.round(LOCAL_BUILD_ZIP_MAX_BYTES / 1048576)}MB)을 넘습니다`);
        const to = zipPathOf(r.root, i.zipKey);
        await fsp.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
        const tmp = `${to}.tmp-${crypto.randomBytes(6).toString("hex")}`;
        const h = crypto.createHash("sha256");
        let bytes = 0;
        const out = fs.createWriteStream(tmp, { flags: "wx", mode: 0o600 });
        try {
          const count = new Transform({
            transform(chunk: Buffer, _enc, done) {
              bytes += chunk.length;
              if (bytes > LOCAL_BUILD_ZIP_MAX_BYTES) return done(new Error(`빌드 결과(zip)가 상한(${Math.round(LOCAL_BUILD_ZIP_MAX_BYTES / 1048576)}MB)을 넘습니다`));
              h.update(chunk);
              done(null, chunk);
            },
          });
          await pipeline(fh.createReadStream({ autoClose: false }), count, out);
          await fsp.rename(tmp, to);   // 안쪽 try 라 rename 이 실패해도 아래 catch 가 임시 파일을 지운다
        } catch (e) {
          await fsp.rm(tmp, { force: true }).catch(() => { /* 다음 정비 */ });
          throw e;
        }
        const d = h.digest();
        return { bytes, sha256_b64: d.toString("base64") };
      } finally {
        await fh.close().catch(() => { /* 이미 닫힘 */ });
      }
    },
    kill: async () => { await r.driver.remove(name).catch(() => { /* 이미 끝 */ }); },
    cleanup: async () => {
      release?.();
      await fsp.rm(work, { recursive: true, force: true }).catch(() => { /* 다음 정리 */ });
    },
  };
}

// ── 재우기 · 상태 ──────────────────────────────────────────────────────────────────────

/**
 * 재우기 한 바퀴(이 워크스페이스) — 한가한 지 그 앱의 재우기 시간(앱별 값 > 워크스페이스 기본 · 0 = 안 재움)이 지난 컨테이너를 내린다.
 *  이 게이트웨이가 쥔 요청이 있거나(inflight) 열린 작업이 그 판을 쓰면 내리지 않는다. 내린 이름들.
 */
export async function sleepIdleLocalServers(env: NodeJS.ProcessEnv = process.env): Promise<{ slept: string[]; awake: number }> {
  const r = resolved(env);
  const tenant = blobTenant();
  await adoptRunning(r, tenant).catch((e) => logger.warn({ err: (e as Error)?.message }, "[app-server-local] 떠 있는 컨테이너 목록을 못 읽었다"));
  const p = await r.policy();
  const slept: string[] = [];
  const mine = [...live.values()].filter((c) => c.tenant === tenant);
  for (const c of mine) {
    const idle = (await r.appIdle(c.appId).catch(() => c.idleMin)) ?? p.idle_sleep_min;
    c.idleMin = idle;
    if (idle === 0 || c.inflight > 0 || r.now() - c.lastUsed < idle * 60_000) continue;
    if ((await r.jobPins(c.appId).catch(() => [c.version])).includes(c.version)) { c.lastUsed = r.now(); continue; }
    //  위 검사 사이의 await 동안 요청이 들어와 이 컨테이너를 쓰기 시작했을 수 있다 — 내리기 직전에 다시 본다(처리 중인 요청을 끊지 않게).
    if (c.inflight > 0 || live.get(c.name) !== c) continue;
    await stopContainer(r, c.name);
    slept.push(c.name);
    logger.info({ name: c.name, app: c.appId, idle_min: idle }, "[app-server-local] 한가한 앱 서버를 재웠다(#4487)");
  }
  return { slept, awake: mine.length - slept.length };
}

/**
 * 로컬 정비(이 워크스페이스 · 하우스키핑 5분) — 주인 없는 앱 서버 컨테이너(함수 · 판 폴더가 없음 — 지우다 게이트웨이가 멈춘 경우) · 멈춘 채 남은 컨테이너 ·
 *  시한(빌드 시간 + 10분)을 넘긴 빌드 컨테이너를 걷고, 띄우다 남은 env 파일(검사 층 열쇠 · 토큰)을 지운다. 걷은 수.
 */
export async function localHousekeeping(buildTimeoutS: number, env: NodeJS.ProcessEnv = process.env): Promise<{ removed: string[]; env_files: number }> {
  const r = resolved(env);
  const tenant = blobTenant();
  const removed: string[] = [];
  const rows = await r.driver.list("lvly.app-server=1");
  for (const c of rows) {
    if (c.labels["lvly.tenant"] !== tenant || starting.has(c.name)) continue;
    const fn = c.labels["lvly.fn"] ?? "", v = c.labels["lvly.version"] ?? "";
    const ok = c.running && NAME_RE.test(fn) && !!(await readMeta(r.root, fn).catch(() => null)) && !!(await readVersion(r.root, fn, v).catch(() => null));
    if (ok) continue;
    await stopContainer(r, c.name, 0);
    removed.push(c.name);
  }
  for (const c of await r.driver.list("lvly.app-build=1")) {
    if (c.labels["lvly.tenant"] !== tenant) continue;
    const st = await r.driver.state(c.name).catch(() => null);
    const age = st?.startedAt ? r.now() - Date.parse(st.startedAt) : Infinity;
    if (!st?.running || age > (buildTimeoutS + 600) * 1000) { await r.driver.remove(c.name).catch(() => { /* 다음 틱 */ }); removed.push(c.name); }
  }
  //  env 파일은 띄운 직후 지운다 — 남은 것은 띄우다 게이트웨이가 멈춘 것뿐이다(지금 띄우는 중인 것은 건드리지 않는다).
  let envFiles = 0;
  const runDir = path.join(r.root, "run");
  for (const f of await fsp.readdir(runDir).catch(() => [] as string[])) {
    if (!f.endsWith(".env") || starting.has(f.slice(0, -4))) continue;
    await fsp.rm(path.join(runDir, f), { force: true }).catch(() => { /* 다음 틱 */ });
    envFiles++;
  }
  return { removed, env_files: envFiles };
}

/** 이 함수의 깨어 있는 컨테이너(상태 보기) — 판 · 마지막으로 쓴 때 · 처리 중 수 · 메모리. */
export function localContainersOf(fn: string): Array<{ version: string; last_used: string; inflight: number; memory_mb: number; started_at: string }> {
  return [...live.values()].filter((c) => c.fn === fn && c.tenant === blobTenant())
    .map((c) => ({ version: c.version, last_used: new Date(c.lastUsed).toISOString(), inflight: c.inflight, memory_mb: c.memMb, started_at: new Date(c.startedAt).toISOString() }));
}

/** 시험 · 진단 — 이 게이트웨이가 기억하는 컨테이너(이름 · 처리 중 · 마지막으로 쓴 때). */
export function localLiveForTest(): Array<{ name: string; inflight: number; lastUsed: number; port: number }> {
  return [...live.values()].map((c) => ({ name: c.name, inflight: c.inflight, lastUsed: c.lastUsed, port: c.port }));
}
export { DockerError };
