// 분산 노드 에이전트(#869) — 멤버 PC/워커에서 도는 단일 프로세스. DB·웹 UI 없이 부팅한다.
// 연결은 항상 아웃바운드(노드 → 게이트웨이 WSS /node/ws, Bearer 노드토큰) — 포트를 열지 않는다(F1).
// 역할: 게이트웨이의 타입드 ops(list/create/kill/edit/gone/label — 임의 셸 없음)를 로컬 tmux 에 실행하고,
//  3s 주기로 세션 상태 스냅샷을 push 하며, attach 채널을 로컬 tmux -CC(node-pty)로 브리지한다.
// 실행(설치 스크립트가 데몬으로 등록) — **게이트웨이가 서빙하는 단일 번들**을 돌린다:
//   LIVELY_GATEWAY_URL=https://gw LIVELY_NODE_TOKEN=lvk_... node dist/node-agent/agent.mjs
//   (tsc 원본 dist/node/agent.js 를 돌리면 자기해시 agentVer 가 서빙 번들과 영영 안 맞아 '구버전' 오판 — #905 C4)
import WebSocket from "ws";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";   // #1713 자가 갱신 — 받은 tar.gz 해제
import { linkIsStale, LINK_CHECK_MS, LINK_STALE_MS } from "./link-liveness.js";   // #1541 — 클라이언트 쪽 생존 감시
import { reconnectDelayMs } from "./reconnect-delay.js";   // #1865 — 재연결 지연(두 구간)
import {
  listSessionsRaw, createSession, killSession, editSession, applyValidatedInvites,
  sessionGone, getSessionLabel, killEmptyTmuxServer, sessionDir, sharedRoot,
  markSessionActive, isReportedPhase, type CreateInput,
} from "../terminal/terminal-sessions.js";
import { attachSession, killAttachedPtys, type AttachSocket } from "../terminal/terminal-pty.js";
import { sendKeysToSession } from "../terminal/send-keys.js";
import { injectFirstPrompt } from "../terminal/session-first-prompt.js";
import { applySessionProject } from "../terminal/session-project.js";   // #1719 세션 프로젝트 소속(노드 로컬 적용)
import { sessionPrompts } from "../terminal/terminal-transcript.js";
import type { LivelyUser } from "../context.js";
import {
  nodeWsUrl, PROTO_VER, NODE_OPS, encodeChanFrame, decodeChanFrame, parseMsg,
  type GwToNodeMsg, type NodeToGwMsg, type ReqMsg,
} from "./protocol.js";
// 위탁 태스크(P2) — 러너/리소스 샘플러는 중앙(게이트웨이 내장 노드)과 공유(node/tasks.ts).
import { sampleResources, detectDocker, detectHarnesses, spawnTaskSession, checkTask, tailTask, type TaskWatch, type RunTaskInput } from "./tasks.js";
import { provisionProjectRepos, markProvisionPending, type RepoSpec as ProvisionRepoSpec } from "../project/project-provision.js";
import { logger } from "../log.js";
import { WorkerHost, WorkerBundleStager, type WorkerStartSpec, type WorkerStopReason } from "../apps/worker-host.js";

const GW_URL = process.env.LIVELY_GATEWAY_URL || "";
const TOKEN = process.env.LIVELY_NODE_TOKEN || "";
const NODE_ID = process.env.LIVELY_NODE_ID || ""; // 표시용 — 신원은 서버가 토큰으로 특정한다
let workerStateSocket: WebSocket | null = null;
const nodeWorkerHost = new WorkerHost({ onSnapshot: (snapshot) => {
  const ws = workerStateSocket;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "workerState", snapshot } satisfies NodeToGwMsg));
} });

// 도는 번들 자신의 지문(#905 C4) — 키트 kit-version 과 같은 모델: **실행 중인 바이트가 곧 버전**이라
//  사람이 숫자를 올릴 필요도, 빠뜨릴 일도 없다. 게이트웨이가 서빙본 지문과 비교해 이 노드가 최신인지 안다.
//  argv[1] = 이 파일(esbuild 단일 번들 agent.mjs). 읽기 실패는 치명이 아니다 — 그냥 '모름'(null)으로 보고한다.
//  ⚠ null 이면 게이트웨이는 최신 여부를 판정하지 않는다(모르면 안 건드림). agent_ver 가 NULL 로 남던 게 이 과업의 발단이다.
const AGENT_VER: string | null = (() => {
  try {
    const self = process.argv[1];
    if (!self) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(self)).digest("hex").slice(0, 12);
  } catch { return null; }
})();
// ── 자가 갱신(#1713) ─────────────────────────────────────────────────────────────────
// 왜: 런처(launchd KeepAlive · systemd Restart)는 `lively node` CLI 가 아니라 **받아 둔 agent.mjs 를 직접**
//  실행한다 → 재시작해도 번들 pull 이 일어나지 않아 노드가 영원히 옛 바이트로 돈다. 실측(2026-08-14):
//  라이브 노드 4대가 전부 옛 번들이라, 게이트웨이가 지원하는 하네스(antigravity)를 **그 PC 에서만** 못 골랐다
//  (세션 생성이 502 "허용되지 않은 하네스"). 사람이 눈치채기도 어렵다 — 노드는 멀쩡히 '연결됨'이니까.
// 그래서 게이트웨이가 hello 응답(helloOk)으로 서빙 지문을 알려주고, 다르면 여기서 스스로 받아 교체한 뒤
//  종료한다. 런처가 즉시 되살리므로 다음 프로세스는 새 바이트로 뜬다(tmux 세션은 별도 프로세스라 보존된다).
// 안전장치 — 자가 갱신은 잘못 만들면 재시작 스톰이 된다:
//  ① 지문이 같거나 모르면 아무것도 안 한다  ② 받은 바이트를 **해시로 검증**하고 다르면 교체하지 않는다
//  ③ 시도 쿨다운 10분(플래그 mtime) — 서버가 계속 다른 지문을 줘도 재시작이 분당 반복되지 않는다
//  ④ 교체는 임시파일 → rename(원자적). node_modules/node-pty 는 **건드리지 않는다**(네이티브 로드 중 교체 위험).
const SELF_UPDATE_COOLDOWN_MS = 10 * 60 * 1000;
let selfUpdating = false;
async function maybeSelfUpdate(latest: string | null | undefined): Promise<void> {
  if (selfUpdating || !latest || !AGENT_VER || latest === AGENT_VER) return;
  const self = process.argv[1];
  if (!self) return;
  const tryFlag = `${self}.update-try`;
  try {
    const st = fs.statSync(tryFlag);
    if (Date.now() - st.mtimeMs < SELF_UPDATE_COOLDOWN_MS) return;   // 최근에 시도했다 — 스톰 방지
  } catch { /* 첫 시도 */ }
  selfUpdating = true;
  try {
    fs.writeFileSync(tryFlag, "");
    logger.info({ have: AGENT_VER, want: latest }, "노드 프로그램이 낡았다 — 새 번들을 받는다");
    const res = await fetch(`${GW_URL.replace(/\/$/, "")}/node/agent-bundle`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) { logger.warn({ status: res.status }, "번들 다운로드 실패 — 다음 연결에 다시 시도"); return; }
    const tgz = Buffer.from(await res.arrayBuffer());
    const tmpDir = fs.mkdtempSync(path.join(path.dirname(self), ".update-"));
    try {
      const tar = spawnSync("tar", ["-xzf", "-", "-C", tmpDir], { input: tgz });
      if (tar.status !== 0) { logger.warn({ status: tar.status }, "번들 해제 실패 — 교체하지 않는다"); return; }
      const got = path.join(tmpDir, path.basename(self));
      const ver = crypto.createHash("sha256").update(fs.readFileSync(got)).digest("hex").slice(0, 12);
      if (ver !== latest) { logger.warn({ got: ver, want: latest }, "받은 번들 지문이 다르다 — 교체하지 않는다"); return; }
      fs.renameSync(got, self);   // 같은 파일시스템 → 원자적
      logger.info({ ver }, "노드 프로그램 갱신 완료 — 다시 시작한다(런처가 되살린다)");
      setTimeout(() => { void nodeWorkerHost.shutdown().finally(() => process.exit(0)); }, 300); // worker 회수 뒤 런처가 되살린다
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "자가 갱신 실패 — 다음 연결에 다시 시도");
  } finally { selfUpdating = false; }
}

if (!GW_URL || !TOKEN) {
  console.error("LIVELY_GATEWAY_URL / LIVELY_NODE_TOKEN 이 필요합니다");
  process.exit(2);
}

const STATE_PUSH_MS = 3_000;
// 재연결 지연은 reconnect-delay.ts 가 계산한다(#1865) — 왜 두 구간(촘촘/느슨)으로 갈랐는지는 그 파일 머리말.
//  ⚠ 상수를 여기 다시 두지 마라: 종전엔 여기 하나뿐이라 '재배포 직후'와 '오래 죽어 있음'을 같은 곡선으로 다뤘고,
//   그래서 게이트웨이가 살아난 뒤에도 노드가 8~16초를 더 기다렸다.

// ── attach 채널 어댑터 — 게이트웨이행 단일 WSS 위의 가상 채널을 AttachSocket 으로 위장해
//    terminal-pty.attachSession(tmux -CC · 큐잉 · 정리)을 그대로 재사용한다. ──
class ChanSocket implements AttachSocket {
  private listeners = new Map<string, Array<(...args: any[]) => void>>();
  private closed = false;
  constructor(private readonly ws: WebSocket, private readonly chan: number, private readonly onGone: (chan: number) => void) {}
  send(data: Buffer | string): void {
    if (this.closed) return;
    // attachSession 은 raw Buffer(pty 출력)만 send 한다 — 채널 프레임으로 감싸 무디코드 릴레이.
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    try { this.ws.send(encodeChanFrame(this.chan, buf)); } catch { /* 게이트웨이 끊김 — close 에서 정리 */ }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.send(JSON.stringify({ t: "close", chan: this.chan } satisfies NodeToGwMsg)); } catch { /* noop */ }
    this.emit("close");
    this.onGone(this.chan);
  }
  on(event: string, listener: (...args: any[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(event) ?? []) { try { fn(...args); } catch { /* listener 오류는 채널만 */ } }
  }
  // 게이트웨이발 제어(ctl)/종료(close) 주입.
  feedControl(m: Record<string, unknown>): void { this.emit("message", JSON.stringify(m)); }
  feedClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close"); // attachSession cleanup(term.kill) 경로
    this.onGone(this.chan);
  }
}

// 위탁 태스크 감시 목록(P2) — 상태 push 주기에 exit 파일을 확인해 taskdone 을 보고한다.
//  에이전트 재시작 시 비워지지만, 게이트웨이가 재연결 때 watchTask 로 재장전한다(복구 경로).
const trackedTasks = new Map<number, TaskWatch>();

// ── 프로젝트 provision 백그라운드 작업(#905 C4) — projectId 로 키잉. clone 은 분 단위라 RPC 로 못 기다린다. ──
//  provision op 는 여기 등록만 하고 즉답 → 게이트웨이가 provisionStatus 로 폴링. 멱등: 이미 있는 클론/워크트리는
//  재사용이라 재시작(맵 소실) 후 재-provision 도 안전하고 빠르다.
type ProvisionJob = { state: "running" | "done" | "error"; result?: unknown; error?: string; at: number };
const provisionJobs = new Map<number, ProvisionJob>();
const PROVISION_JOB_TTL_MS = 60 * 60 * 1000;   // done/error 는 1시간 뒤 정리(맵 무한증식 방지 — 프로젝트 수는 적다)

const workerBundleStages = new WorkerBundleStager();

// started:true = 새로 시작 · false = 이미 진행 중이라 이 요청 specs 를 안 받음(coalesce). 게이트웨이가 이 구분을 로그에 쓴다.
async function startProvision(args: Record<string, unknown>): Promise<{ started: boolean }> {
  const projectId = Number(args.projectId);
  const folder = String(args.folder ?? "");
  const specs = Array.isArray(args.specs) ? args.specs as ProvisionRepoSpec[] : [];
  const memberId = args.memberId ? String(args.memberId) : null;
  if (!projectId || !folder) throw new Error("provision: projectId·folder 필수");
  // 정리 — 오래된 종료 작업 제거.
  for (const [k, j] of provisionJobs) if (j.state !== "running" && Date.now() - j.at > PROVISION_JOB_TTL_MS) provisionJobs.delete(k);
  const cur = provisionJobs.get(projectId);
  // 🔴 started:false = 이미 돌고 있어 **이 요청의 specs 를 안 받았다**(coalesce). 게이트웨이가 로그로 알 수 있게 구분한다
  //  (항상 true 면 "다른 specs 로 조용히 끝남"을 아무도 모른다).
  if (cur?.state === "running") return { started: false };   // 진행 중이면 중복 시작 안 함(idempotent)
  // ⚠ 순서 보장(#1180) — 게이트웨이는 이 응답 직후 세션을 연다. '준비 중' 마커를 먼저 확정해야 그 세션의
  //  프리로드가 "받는 중"을 본다(중앙 startProjectProvision 과 같은 규율).
  await markProvisionPending(projectId, folder, specs).catch(() => { /* 마커 실패가 provision 을 막지 않는다 */ });
  const job: ProvisionJob = { state: "running", at: Date.now() };
  provisionJobs.set(projectId, job);
  // 백그라운드 실행 — await 하지 않는다(즉답). 결과/실패를 job 에 적어 폴링이 회수한다.
  //  failOpen(#1155) — 레포 하나 못 받았다고 세션 자체를 못 열면 사람이 그 자리에서 고칠 기회조차 없다. 실패는
  //   이 노드의 프로젝트 마커(repos_failed)에 남고, 그 폴더에서 뜨는 세션의 프리로드 훅이 AI 에게 알린다.
  void provisionProjectRepos(projectId, folder, specs, { clone: args.clone !== false, memberId, failOpen: true })
    .then((result) => { job.state = "done"; job.result = result; job.at = Date.now(); })
    .catch((e) => { job.state = "error"; job.error = e instanceof Error ? e.message : String(e); job.at = Date.now(); });
  return { started: true };
}

function provisionStatus(projectId: number): ProvisionJob & { known: boolean } {
  const j = provisionJobs.get(projectId);
  //  맵에 없음 = 이 노드가 재시작됐거나 애초에 안 받음 → known:false 로 알려 게이트웨이가 재-provision 하게 한다.
  if (!j) return { known: false, state: "error", error: "no-provision-job", at: 0 };
  return { known: true, ...j };
}

// 세션 작업폴더(@box_dir) 기준 안전 경로(#875) — .. 탈출 거부. requireSub 면 base 자체(빈 경로)는 파일 op 대상 불가로 거부.
// ⚠ 여기는 **tmux 가 유일한 진실**이다 — 게이트웨이 쪽은 desired(DB) 우선으로 바뀌었지만(session-desired.ts),
//  노드에는 DB 가 없다(설계: 노드에 DB 자격을 주지 않는다). resolveSessionDir 로 "통일"하지 마라 — 노드에서 그건 못 돈다.
async function nodeSessionAbs(id: string, sub: string, requireSub = false): Promise<{ base: string; abs: string }> {
  const base = path.resolve(await sessionDir(id));
  const rel = String(sub || "").replace(/^[/\\]+/, "");
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error("허용 경로를 벗어났습니다");
  if (requireSub && (rel === "" || abs === base)) throw new Error("경로가 필요합니다");
  return { base, abs };
}

// ── ops 디스패치 — 게이트웨이가 이미 정책(소유·초대 검증)을 끝냈다는 전제의 기계적 실행. ──
//  user 는 게이트웨이가 넘긴 신원 그대로 tmux 메타(@box_owner)·소유자 확인(assertManage)에 쓰인다.
async function runOp(op: string, args: Record<string, unknown>): Promise<unknown> {
  const user = (args.user ?? {}) as LivelyUser;
  switch (op) {
    case "stageWorkerChunk": return workerBundleStages.stage(args);
    case "startWorker": {
      const runId = String(args.runId ?? "");
      const codeHash = String(args.codeHash ?? "");
      const spec: WorkerStartSpec = {
        runId, appId: String(args.appId ?? ""), instanceId: String(args.instanceId ?? ""),
        entry: String(args.entry ?? ""), code: workerBundleStages.take(runId, codeHash), codeHash,
        memoryMb: Number(args.memoryMb), idleTimeoutSec: Number(args.idleTimeoutSec),
        allowedHosts: Array.isArray(args.allowedHosts) ? args.allowedHosts.map(String) : [],
        selfHosts: Array.isArray(args.selfHosts) ? args.selfHosts.map(String) : [],
        // 조직 예산(#1780 Stage B) — 구 게이트웨이는 이 필드를 안 보내므로 부재 시 0(감시 끔)이다.
        //  숫자가 아니면 0으로 접는다: 감시를 못 켜는 것이 멀쩡한 worker 를 잘못된 값으로 죽이는 것보다 낫다.
        cpuPercentMax: Number.isFinite(Number(args.cpuPercentMax)) ? Math.max(0, Number(args.cpuPercentMax)) : 0,
        maxWallSec: Number.isFinite(Number(args.maxWallSec)) ? Math.max(0, Number(args.maxWallSec)) : 0,
      };
      return nodeWorkerHost.start(spec);
    }
    case "workerStatus": return nodeWorkerHost.status(String(args.runId ?? ""));
    case "stopWorker": {
      const runId = String(args.runId ?? "");
      workerBundleStages.delete(runId);
      return nodeWorkerHost.stop(runId, String(args.reason ?? "explicit") as WorkerStopReason);
    }
    case "runTask": {
      const input = args as unknown as RunTaskInput;
      const r = await spawnTaskSession(input);
      // 노드가 받는 runTask 는 **위탁뿐**이고 그 id 는 org_task 의 숫자다(리브 대화 턴은 이 op 를 안 탄다 —
      //  게이트웨이 로컬에서 spawnTaskSession 을 직접 부른다). 추적 맵은 그 숫자 계약 위에 있으므로 여기서 좁힌다.
      const taskId = Number(input.taskId);
      trackedTasks.set(taskId, { taskId, sessionId: r.sessionId, taskDir: r.taskDir, harness: input.harness });   // #1710 — 결과 스키마가 하네스별이라함께 들고 있어야 요약을 뽑는다
      return r;
    }
    case "watchTask": {
      const w = { taskId: Number(args.taskId), sessionId: String(args.sessionId), taskDir: String(args.taskDir), harness: args.harness ? String(args.harness) : undefined };   // #1710
      if (w.taskId && w.taskDir) trackedTasks.set(w.taskId, w);
      return { ok: true };
    }
    case "tailTask": return tailTask(String(args.taskDir), Number(args.from) || 0);
    // 프로젝트 레포 provision(#905 C4) — clone 은 RPC 15s 를 넘기므로 **백그라운드로 시작만 하고 즉답**한다.
    //  게이트웨이가 provisionStatus 로 폴링해 완료를 기다린다. 게이트웨이가 레지스트리 git_url·자격을 spec.inject 로
    //  실어 보내므로(노드엔 DB 없음) provisionProjectRepos 가 그대로 돈다 — 경로모델(PROJECT_SHARED_BASE·
    //  confineToWorkspace·assertDiskWritable)은 노드 자기 workspace 기준으로 동작한다.
    case "provision": return startProvision(args);
    case "provisionStatus": return provisionStatus(Number(args.projectId));
    case "list": return listSessionsRaw();
    // #1221 — 게이트웨이가 릴레이한 하네스 보고(활동 시각 + 실행단계)를 이 노드 tmux 에 새긴다. 인가(소유자
    //  확인)는 게이트웨이가 이미 끝냈다(F7 — runOp 는 기계적 실행만). 모르는 state 는 무시하고 활동 시각만 갱신.
    case "markActive": {
      const st = args.state;
      // #1842 — 전이(prev→phase)를 게이트웨이에 **돌려준다**. 노드 세션의 tmux 는 이 PC 에 있어 게이트웨이가
      //  직접 볼 수 없으므로, 이 응답이 없으면 다른 PC 에서 도는 세션만 실시간 알림에서 빠져 30초 폴링에 묶인다.
      //  구 게이트웨이는 이 필드를 모르고 무시한다(무회귀).
      const change = await markSessionActive(String(args.id), isReportedPhase(st) ? st : undefined);
      return { ok: true, change: change ?? null };
    }
    // #1664 — 게이트웨이가 이 노드의 세션 PTY 에 프롬프트를 넣는다(크론 주입·리브). 인가(소유·초대)는
    //  게이트웨이가 끝냈다는 전제(F7). mux 표면 분기(tmux `-l` vs psmux 코드포인트)와 flush 지연 규약은
    //  terminal/send-keys 안에 갇혀 있어 게이트웨이 로컬 주입과 **같은 코드**로 돈다.
    case "sendKeys": {
      await sendKeysToSession(String(args.id), String(args.text ?? ""));
      return { ok: true };
    }
    // 세션 프로젝트 소속(붙이기·떼기). 게이트웨이가 소유권·공개범위를 검증하고 DB desired를 먼저 기록한다.
    // 노드는 tmux 실행 캐시만 갱신하며 cwd나 프로젝트 표현 파일을 만들지 않는다.
    case "setProject": {
      const b = args.bind as { projectId: number; folder: string; name?: string | null; src?: "v6" | "org" } | null | undefined;
      return applySessionProject(user, String(args.id), b && Number(b.projectId) > 0 ? b : null);
    }
    case "injectFirstPrompt": {
      const id = String(args.id);
      const harness = String(args.harness || "claude");
      const prompt = String(args.text || "");
      // 신뢰 대화상자 자동 수락 여부는 **게이트웨이가 판정해 실어 보낸다**(#1867 autoTrustWorkspace) — 노드엔 프로젝트 폴더 규약이 없다.
      if (prompt.trim()) void injectFirstPrompt(id, harness, prompt, { trustOk: args.trustOk === true })
        .catch((e) => console.warn(`[node] 첫 지시 주입 실패(${id}):`, (e as Error)?.message ?? e));
      return { ok: true };
    }
    case "create":
    case "createAppSession": {
      const session = await createSession(user, args.input as CreateInput);
      // 초대는 게이트웨이가 구성원 디렉터리로 검증해 넘긴다 — 노드엔 DB 가 없어 createSession 내부 검증이 빈 배열이 됨.
      const invites = Array.isArray(args.invites) ? (args.invites as string[]) : [];
      if (invites.length) { await applyValidatedInvites(user, session.id, invites); session.invites = invites; }
      return session;
    }
    case "kill": await killSession(user, String(args.id)); return { ok: true };
    case "edit": {
      const patch = (args.patch ?? {}) as { label?: string };
      if (patch.label !== undefined) await editSession(user, String(args.id), { label: patch.label });
      if (args.invites !== undefined) await applyValidatedInvites(user, String(args.id), args.invites);
      return { ok: true };
    }
    case "gone": return sessionGone(String(args.id));
    case "label": return getSessionLabel(String(args.id));
    // 노드 세션 파일 릴레이(#875) — @box_dir 봉쇄(.. 탈출 거부). 노드는 멤버 본인 머신(단일 유저)이라 OS-유저 격리 없이
    //  plain fs. 인가는 게이트웨이(nodeCanAttach)가 이미 끝냈다는 전제(F7 — runOp 는 기계적 실행만).
    case "fsLs": {
      const { base, abs } = await nodeSessionAbs(String(args.id), String(args.sub ?? ""));
      let ents; try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch { throw new Error("디렉터리 없음"); }
      // 심링크는 **따라가서** 실효 종류를 정한다(#1744 — 게이트웨이 terminal-files.readDirItems 와 같은 규칙).
      //  dirent.isDirectory() 는 링크에 언제나 false 라, 그대로 두면 폴더 링크(./project 등)가 '파일'로 나와 탐색기가 못 들어간다.
      const items: Array<{ name: string; type: "dir" | "file"; size: number; link?: boolean; linkTarget?: string }> = [];
      for (const e of ents) {
        if (e.name.startsWith(".")) continue;
        const link = e.isSymbolicLink();
        const full = path.join(abs, e.name);
        let isDir = e.isDirectory(); let size = 0; let linkTarget = "";
        try { const st = await fsp.stat(full); if (link) isDir = st.isDirectory(); if (!isDir) size = st.size; } catch { /* 끊어진 링크 — 아는 만큼만 */ }
        if (link) { try { linkTarget = await fsp.readlink(full); } catch { /* 목적지 생략 */ } }
        items.push({ name: e.name, type: isDir ? "dir" : "file", size, ...(link ? { link: true, linkTarget } : {}) });
      }
      items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      const rel = path.relative(base, abs);
      return { path: rel, parent: rel ? (path.dirname(rel) === "." ? "" : path.dirname(rel)) : null, items };
    }
    case "fsRead": { // len=0 → stat만(크기 프리체크). 아니면 offset 부터 len 바이트 base64.
      const { abs } = await nodeSessionAbs(String(args.id), String(args.path ?? ""), true);
      let st; try { st = await fsp.stat(abs); } catch { throw new Error("파일 없음"); }
      if (!st.isFile()) throw new Error("파일이 아닙니다");
      const len = Number(args.len) || 0, offset = Number(args.offset) || 0;
      if (len === 0) return { size: st.size, eof: st.size === 0, data: "" };
      const fh = await fsp.open(abs, "r");
      try {
        const want = Math.min(len, Math.max(0, st.size - offset));
        const buf = Buffer.alloc(want);
        const { bytesRead } = want > 0 ? await fh.read(buf, 0, want, offset) : { bytesRead: 0 };
        return { size: st.size, data: buf.subarray(0, bytesRead).toString("base64"), eof: offset + bytesRead >= st.size };
      } finally { await fh.close(); }
    }
    case "fsWrite": { // 순차 청크 — offset 0=truncate write, >0=append.
      const { abs } = await nodeSessionAbs(String(args.id), String(args.path ?? ""), true);
      const buf = Buffer.from(String(args.data ?? ""), "base64");
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      if ((Number(args.offset) || 0) === 0) await fsp.writeFile(abs, buf); else await fsp.appendFile(abs, buf);
      return { ok: true, path: abs };
    }
    case "fsMkdir": {
      const { abs } = await nodeSessionAbs(String(args.id), String(args.sub ?? ""), true);
      await fsp.mkdir(abs, { recursive: true });
      return { ok: true };
    }
    case "prompts": // '내 질문'(#875 ③) — 노드 세션의 tmux 트랜스크립트에서 사용자 프롬프트 추출(노드 로컬 ~/.claude 등).
      return sessionPrompts(await sessionDir(String(args.id)));
    default: throw new Error(`unknown op: ${op}`);
  }
}

let attempt = 0;
function connect(): void {
  const url = nodeWsUrl(GW_URL);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${TOKEN}` }, handshakeTimeout: 10_000 });
  const chans = new Map<number, ChanSocket>();
  let pusher: NodeJS.Timeout | null = null;
  let lastPushed = "";
  // 링크 생존 감시(#1541 · link-liveness.ts 머리말) — 게이트웨이는 10초마다 ping 한다. 그게(또는 어떤 메시지든) LINK_STALE_MS
  //  동안 안 오면 **우리가 먼저 끊는다**(terminate → close → 아래 teardown 의 재연결). 안 그러면 PC 절전 뒤 소켓이
  //  '연결됨' 인 채 영영 남아 게이트웨이엔 오프라인, 앱엔 실행 중, 런처는 살아 있으니 안 살리는 좀비가 된다(실측: 나흘).
  let lastBeat = Date.now();
  let watch: NodeJS.Timeout | null = null;
  ws.on("ping", () => { lastBeat = Date.now(); });
  ws.on("pong", () => { lastBeat = Date.now(); });

  const pushState = async (force = false): Promise<void> => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      // 리소스 상시 노출(§10) + 세션 스냅샷. res 는 매 push 변하므로 dedup 은 세션 부분만 본다.
      const [sessions, res] = await Promise.all([listSessionsRaw(), sampleResources(sharedRoot().base)]);
      const sesKey = JSON.stringify(sessions);
      const skip = !force && sesKey === lastPushed && trackedTasks.size === 0;
      lastPushed = sesKey;
      if (!skip) ws.send(JSON.stringify({ t: "state", sessions, res } satisfies NodeToGwMsg));
      // 위탁 태스크 완료 감지(P2) — exit 파일 등장 시 1회 보고 후 감시 해제(세션 정리는 게이트웨이 지시).
      for (const w of [...trackedTasks.values()]) {
        const out = await checkTask(w).catch(() => null);
        if (!out) continue;
        trackedTasks.delete(w.taskId);
        ws.send(JSON.stringify({ t: "taskdone", taskId: out.taskId, ok: out.ok, exit: out.exit, summary: out.summary, error: out.error } satisfies NodeToGwMsg));
      }
    } catch (err) {
      // 다음 주기에 재시도 — 조용히 삼키면 배치 불가 원인을 못 찾는다(e2e 교훈: freemem 과소보고 진단 지연).
      logger.warn({ err: (err as Error)?.message }, "상태 push 실패(비치명)");
    }
  };

  ws.on("open", () => {
    attempt = 0;
    workerStateSocket = ws;
    lastBeat = Date.now();
    // 소켓 keepalive — 절전이 아니라 NAT 만료 같은 조용한 단절도 OS 가 알아채게(belt and braces).
    try { (ws as unknown as { _socket?: { setKeepAlive?: (on: boolean, ms: number) => void } })._socket?.setKeepAlive?.(true, 15_000); } catch { /* noop */ }
    if (watch) clearInterval(watch);
    watch = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!linkIsStale(lastBeat, Date.now(), LINK_STALE_MS)) return;
      logger.warn({ silentMs: Date.now() - lastBeat }, "게이트웨이 heartbeat 끊김 — 링크를 끊고 다시 잇는다");
      try { ws.terminate(); } catch { /* noop */ }
    }, LINK_CHECK_MS);
    logger.info({ url }, "게이트웨이 연결됨");
    void (async () => {
      const hasDocker = await detectDocker();
      const harnesses = await detectHarnesses();   // #1713 — 이 PC 에 실제로 있는 하네스(폼이 이걸로 선택지를 거른다)
      ws.send(JSON.stringify({
        t: "hello", ver: PROTO_VER, node: NODE_ID, platform: process.platform, host: os.hostname(), hasDocker,
        // agentVer = 이 번들의 지문 · caps = **이 빌드가 실제로 구현한 op**(protocol.NODE_OPS — 목록과 타입이 한 출처).
        //  둘 다 없으면 게이트웨이는 "이 노드가 무엇인지·무엇을 하는지" 알 방법이 없어, 미지원을 실패와 구별 못 한다.
        ...(AGENT_VER ? { agentVer: AGENT_VER } : {}), caps: [...NODE_OPS], harnesses,
      } satisfies NodeToGwMsg));
      await pushState(true);
      pusher = setInterval(() => { void pushState(); }, STATE_PUSH_MS);
    })();
  });

  ws.on("message", (raw, isBinary) => {
    lastBeat = Date.now();
    if (isBinary) { decodeChanFrame(raw as Buffer); return; } // 현재 게이트웨이→노드 바이너리는 없음(제어는 ctl)
    const m = parseMsg<GwToNodeMsg>(raw);
    if (!m) return;
    // #1713 — 게이트웨이가 알려준 서빙 지문. 내가 낡았으면 스스로 받아 교체하고 종료한다(런처가 되살린다).
    if (m.t === "helloOk") { void maybeSelfUpdate(m.agentVerLatest); return; }
    if (m.t === "req") {
      const req = m as ReqMsg;
      void runOp(req.op, req.args ?? {})
        .then((data) => { ws.send(JSON.stringify({ t: "res", id: req.id, ok: true, data } satisfies NodeToGwMsg)); void pushState(true); })
        .catch((e) => { try { ws.send(JSON.stringify({ t: "res", id: req.id, ok: false, error: (e as Error)?.message ?? String(e) } satisfies NodeToGwMsg)); } catch { /* noop */ } });
      return;
    }
    if (m.t === "open") {
      const sock = new ChanSocket(ws, m.chan, (chan) => chans.delete(chan));
      chans.set(m.chan, sock);
      try {
        attachSession(sock, m.session);
        ws.send(JSON.stringify({ t: "opened", chan: m.chan } satisfies NodeToGwMsg));
      } catch (e) {
        chans.delete(m.chan);
        ws.send(JSON.stringify({ t: "openfail", chan: m.chan, code: 4403, reason: (e as Error)?.message ?? "attach-failed" } satisfies NodeToGwMsg));
      }
      return;
    }
    if (m.t === "ctl") { chans.get(m.chan)?.feedControl(m.m); return; }
    if (m.t === "close") { chans.get(m.chan)?.feedClose(); return; }
  });

  const teardown = (): void => {
    if (workerStateSocket === ws) workerStateSocket = null;
    if (pusher) { clearInterval(pusher); pusher = null; }
    if (watch) { clearInterval(watch); watch = null; }
    for (const sock of chans.values()) sock.feedClose(); // attach pty 정리(#687 — 고아 방지)
    chans.clear();
    // 제어 링크가 끊긴 동안에는 앱 disable/grant 회수를 받을 수 없다. 옛 권한 봉투로 계속 HTTP broker를 쓰지 못하게
    // remote worker를 전부 fail-closed 정지한다. 재연결 뒤 명시 open이 같은 run 계약으로 다시 시작한다.
    void nodeWorkerHost.shutdown();
    workerBundleStages.clear();
    const delay = reconnectDelayMs(attempt++);
    logger.warn({ delay }, "게이트웨이 연결 끊김 — 재연결 예약");
    // ⚠ unref 금지(#1541 실기기 로그로 확정): teardown 뒤엔 이 타이머가 이벤트 루프를 지탱하는 유일한 핸들이라,
    //  unref 면 **재연결이 실행되기 전에 프로세스가 끝난다**. hammurabi 로그의 모든 "연결 끊김 — 재연결 예약" 뒤에
    //  재연결이 아니라 +5초에 새 pid(런처 재기동)가 온다 — 예약된 재연결이 단 한 번도 돈 적이 없다.
    //  데몬은 런처가 우연히 가려 주지만, 포그라운드(lively node — 런처 없음)는 끊김 한 번에 노드가 통째로 죽는다.
    setTimeout(connect, delay);
  };
  ws.once("close", teardown);
  ws.once("error", (err) => { logger.warn({ err: (err as Error)?.message }, "노드 WSS 오류"); try { ws.terminate(); } catch { /* noop */ } });
}

// 종료 시 attach pty 일괄 회수(#687 — 게이트웨이와 동일 불변식: 자식이 init 로 재부모화돼 PTY 점유하지 않게).
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    try { killAttachedPtys(); } catch { /* noop */ }
    void nodeWorkerHost.shutdown().finally(() => setTimeout(() => process.exit(0), 50));
    setTimeout(() => process.exit(0), 1_500).unref();
  });
}

logger.info({ gw: GW_URL, node: NODE_ID || "(token-derived)" }, "노드 에이전트 시작");
// 부팅 자가치유(#869) — 과거 최소 PATH 로 뜬 stale tmux 서버가 빈 채 남아 있으면 죽인다(세션 0개일 때만 = 무손실).
//  이래야 첫 new-session 이 이 데몬의 PATH(env 파일에 baked 된 사용자 로그인 PATH)로 새 서버를 띄워 pane 이 claude 등을 찾는다.
await killEmptyTmuxServer();
connect();
