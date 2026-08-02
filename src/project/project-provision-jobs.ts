// 게이트웨이(중앙 박스)측 provision 작업 큐(#1180) — "시작만 하고 즉답, 상태는 폴링".
//  왜: 웹 '세션 만들기'가 clone 이 끝날 때까지 브라우저 요청을 붙들고 있었다(대형 레포 첫 clone 이면 분 단위 +
//   프록시 타임아웃 위험). 세션 cwd 는 레포가 아니라 프로젝트 폴더라(#918) 워크트리가 뒤늦게 생겨도 안전하다 →
//   세션을 먼저 열고 코드는 뒤따르게 한다. 그 사이 세션이 '오는 중'임은 마커(repos_pending)→프리로드가 알린다(#1155 레일).
//  ⚠ 이 모듈은 **노드 agent.ts 의 startProvision/provisionStatus 와 같은 모양**이다(맵·coalesce·TTL·상태 3종).
//   두 실행 위치(중앙/노드)가 같은 계약을 갖게 해서 라우트가 분기 하나로 끝나게 하려는 것 — 한쪽만 고치지 말 것.
import { provisionProjectRepos, markProvisionPending, type ProvisionResult, type RepoSpec } from "./project-provision.js";
import { logger } from "../log.js";

type JobState = "running" | "done" | "error";
interface Job { state: JobState; result?: ProvisionResult; error?: string; at: number }

const jobs = new Map<number, Job>();
const JOB_TTL_MS = 60 * 60 * 1000;   // 종료된 작업은 1시간 뒤 정리(프로젝트 수는 적다 — 무한증식 방지용)

export interface ProvisionJobStatus {
  known: boolean; state: JobState; provisioned: ProvisionResult["provisioned"]; failed: ProvisionResult["failed"]; error?: string; at: number;
}

// started:false = 이미 이 프로젝트 provision 이 돌고 있어 **이 요청의 specs 를 받지 않았다**(coalesce).
//  노드측과 같은 시맨틱 — 호출자가 로그·안내에 쓴다. 멱등이라 대개는 같은 요청 재시도라 무해하다.
export async function startProjectProvision(
  projectId: number, folder: string, specs: RepoSpec[], opts?: { clone?: boolean; memberId?: string | null },
): Promise<{ started: boolean }> {
  for (const [k, j] of jobs) if (j.state !== "running" && Date.now() - j.at > JOB_TTL_MS) jobs.delete(k);
  const cur = jobs.get(projectId);
  if (cur?.state === "running") return { started: false };
  // ⚠ 순서 보장(#1180) — '준비 중' 마커를 **응답 전에** 확정한다. 호출자는 이 함수가 돌아오자마자 세션을 열고,
  //  그 세션의 프리로드는 곧바로 마커를 읽는다. 여기서 안 기다리면 "코드도 없고 안내도 없는" 창이 열려
  //  AI 가 빈 폴더를 보고 제멋대로 clone 한다 — 이 기능이 막으려던 바로 그 사고다.
  //  입력 검증도 여기서 끝나므로 잘못된 spec 은 백그라운드로 새지 않고 호출자에게 그대로 4xx 로 나간다.
  await markProvisionPending(projectId, folder, specs);
  const job: Job = { state: "running", at: Date.now() };
  jobs.set(projectId, job);
  // 백그라운드 실행 — await 하지 않는다(즉답). failOpen: 레포 하나 못 받았다고 세션을 못 열게 하지 않는다(#1155).
  void provisionProjectRepos(projectId, folder, specs, { clone: opts?.clone !== false, memberId: opts?.memberId ?? null, failOpen: true })
    .then((result) => {
      job.state = "done"; job.result = result; job.at = Date.now();
      if (result.failed.length) logger.warn({ projectId, failed: result.failed.map((f) => f.name) }, "provision 일부 실패 — 세션엔 마커로 안내됨(#1155)");
    })
    .catch((e) => {
      // failOpen 이라 여기 오는 건 환경 실패가 아니라 계약 위반(폴더 없음·입력 형식 등)이다.
      job.state = "error"; job.error = e instanceof Error ? e.message : String(e); job.at = Date.now();
      logger.warn({ projectId, err: job.error }, "provision 작업 실패");
    });
  return { started: true };
}

// known:false = 이 게이트웨이가 그 작업을 모른다(재시작했거나 애초에 시작 안 됨) → 호출자가 재시작을 결정한다.
export function projectProvisionStatus(projectId: number): ProvisionJobStatus {
  const j = jobs.get(projectId);
  if (!j) return { known: false, state: "error", provisioned: [], failed: [], error: "no-provision-job", at: 0 };
  return {
    known: true, state: j.state, at: j.at, error: j.error,
    provisioned: j.result?.provisioned ?? [], failed: j.result?.failed ?? [],
  };
}
