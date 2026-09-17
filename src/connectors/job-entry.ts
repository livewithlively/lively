// 수집 판 엔트리 — 매니지드 CP 박스의 일시 유닛(판) 안에서 돈다 (#3994 T3).
//
//  lvly-task-op 이 `gateway-job` 프로필로 띄운다: 일회용 uid · 허용목록 루트 · 게이트웨이 코드 읽기 전용(/opt/lvly/app) ·
//   사설망은 DB 주소 하나만 열림. 이 파일이 게이트웨이의 수집 추적기를 **판 안에서** 대신한다 — 로그·박동·끝 기록을
//   자기 run 행에 직접 쓴다(run-tracker.trackRunChild, 게이트웨이 자식 길과 같은 함수). 그래서 게이트웨이가 교대·재시작해도
//   수집과 그 기록이 끊기지 않는다. 게이트웨이 쪽은 run-unit.ts 머리말.
//
//  사용: node dist/connectors/job-entry.js connector-sync <system> --run <id> [--collector <id>] [--full]
//  입력: $CREDENTIALS_DIRECTORY/env — 게이트웨이가 수집 자식에게 주던 env(JSON). DB 접속이 들어 있어 env·명령줄로는 안 받는다.
//  종료: 수집 자식의 종료코드 · 64 인자 · 70 env 문서 · 75 자기 run 행 없음(게이트웨이가 접수를 못 마쳤다).
//
//  ⚠ 정적 import 는 **순수 모듈만**(run-unit). db/client 는 처음 로드될 때 ITEMS_DATABASE_URL·테넌트 고정 바인딩을
//   env 에서 읽으므로(db/client.ts «고정 바인딩은 여기서 자가 설치»), env 문서를 실은 **뒤에** 동적으로 부른다.
//   순서가 뒤집히면 판의 모든 조회가 테넌트 없이 나가 자기 run 행조차 못 찾는다(RLS).
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  JOB_ECHO_CAP, JOB_EXIT_NOENV, JOB_EXIT_NOROW, JOB_EXIT_USAGE, JOB_ROW_WAIT_MS,
  applyJobEnv, parseJobArgs, parseJobEnvDoc, syncChildArgv, type JobSpec,
} from "./run-unit.js";

const say = (msg: string): void => { process.stderr.write(`[job-entry] ${msg}\n`); };

let job: JobSpec;
try {
  job = parseJobArgs(process.argv.slice(2));
} catch (e) {
  say(`인자 오류 — ${(e as Error).message}`);
  process.exit(JOB_EXIT_USAGE);
}

try {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir) throw new Error("CREDENTIALS_DIRECTORY 가 없다 — op 가 띄운 판이 아니다");
  const n = applyJobEnv(process.env, parseJobEnvDoc(fs.readFileSync(`${dir}/env`, "utf8")));
  say(`env ${n}개를 실었다 — ${job.system} run ${job.runId}`);
} catch (e) {
  say(`env 문서 오류 — ${(e as Error).message}`);
  process.exit(JOB_EXIT_NOENV);
}
for (const d of [process.env.HOME, process.env.LIVELY_STATE_DIR, process.env.LIVELY_LOG_DIR]) {
  try { if (d) fs.mkdirSync(d, { recursive: true }); } catch { /* 쓰기 자리가 없어도 수집은 돈다 — DB 에 쓴다 */ }
}

const { itemsPool } = await import("../db/client.js");
const { trackRunChild, appendRunLog } = await import("./run-tracker.js");

//  자기 run 행을 기다린다 — 게이트웨이는 판이 선 **뒤에** 행을 커밋한다. 끝내 안 보이면 수집하지 않는다(고아 수집 0).
const waitMs = Number(process.env.LIVELY_JOB_ROW_WAIT_MS) > 0 ? Math.min(Number(process.env.LIVELY_JOB_ROW_WAIT_MS), 120_000) : JOB_ROW_WAIT_MS;
const deadline = Date.now() + waitMs;
let status: string | null = null;
for (;;) {
  try {
    const r = await itemsPool.query(`SELECT status FROM connector_run WHERE id=$1`, [job.runId]);
    status = r.rows[0] ? String((r.rows[0] as { status: string }).status) : null;
  } catch (e) {
    say(`run 행 조회 실패 — ${(e as Error).message}`);
  }
  if (status !== null || Date.now() > deadline) break;
  await new Promise((r) => setTimeout(r, 250));
}
if (status === null) {
  say(`run ${job.runId} 행이 ${Math.round(waitMs / 1000)}초 안에 안 보인다 — 게이트웨이가 접수를 마치지 못했다. 수집하지 않는다`);
  process.exit(JOB_EXIT_NOROW);
}
if (status !== "running") {
  say(`run ${job.runId} 은 이미 ${status} — 수집하지 않는다`);
  process.exit(0);
}

const runSync = fileURLToPath(new URL("./run-sync.js", import.meta.url));
//  cwd 는 물려받는다 — 판의 작업 디렉터리(op 프로필 workDir = 게이트웨이 코드 자리)가 곧 게이트웨이 자식의 cwd 와 같은 자리다.
const child = spawn(process.execPath, syncChildArgv(job, runSync), { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
say(`수집 자식 시작 pid=${child.pid ?? "?"}`);

//  출력 사본 — 판 결과 폴더(stdout = out/stream.jsonl)에도 남긴다. DB 에 못 닿는 날의 사후 진단용. 상한을 넘으면 그만 쓴다.
let echoed = 0;
let echoCapped = false;
const echo = (c: Buffer): void => {
  if (echoCapped) return;
  if (echoed + c.length > JOB_ECHO_CAP) {
    echoCapped = true;
    process.stdout.write(`\n[job-entry] 출력 사본이 상한(${JOB_ECHO_CAP}B)에 닿았다 — 이후 출력은 run 로그에만 남는다\n`);
    return;
  }
  echoed += c.length;
  process.stdout.write(c);
};

//  판을 멈추는 신호(사용자 중지 · 시간 상한 · 운영 정지) — 기본 동작(즉시 종료)이면 끝 기록을 못 남긴다.
//   자식을 멈추고, 자식이 닫히면 추적기가 끝을 적는다. 사용자 중지는 게이트웨이가 행을 **먼저** canceled 로 닫았으므로
//   추적기의 끝 기록(running 행에만 쓴다)이 그것을 덮지 않는다.
let stopping = false;
const onSignal = (sig: NodeJS.Signals): void => {
  if (stopping) return;
  stopping = true;
  say(`${sig} 받음 — 수집 자식을 멈춘다`);
  void appendRunLog(job.runId,
    `\n[tracker] 판 정지 신호(${sig}) — 시간 상한·운영 정지 중 하나. 커서 미전진이라 다음 run 이 재수집합니다.`, { onlyRunning: true });
  try { child.kill("SIGTERM"); } catch { /* 이미 종료 */ }
  setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 이미 종료 */ } }, 10_000).unref();
};
process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);

const r = await trackRunChild(job.runId, child, { isCanceled: () => false, echo, guardFinal: true });
say(`수집 자식 끝 — ${r.ok ? "성공" : `실패(exit ${r.exitCode ?? "신호"})`}`);
process.exit(r.ok ? 0 : typeof r.exitCode === "number" && r.exitCode > 0 ? r.exitCode : 1);
