// 원격 노드 프로젝트 provision 드라이버(#905 C4) — 게이트웨이가 노드에 레포 clone→worktree 를 시키고 완료를 기다린다.
//  왜 별도 모듈인가: provision 은 프로젝트 관심사(project-routes)지 위탁 스케줄러 관심사가 아니다. 순환 import
//  (project-routes → registry)도 피한다.
//
//  ── 비동기 모델 (clone 은 RPC 15s 를 넘긴다) ──
//   노드의 provision op 는 백그라운드 clone 을 **시작만** 하고 즉답한다(startProvision). 여기서 provisionStatus 를
//   폴링해 완료를 기다린다 — 각 폴링 RPC 는 즉답이라 15s 안에 들고, 실제 clone 은 노드 프로세스에서 계속 돈다.
//   대기는 게이트웨이 프로세스 안(WS RPC)에서 일어난다 — HTTP 프록시를 통과하지 않으므로 프록시 504(#522)와 무관.
//   ⚠ 그래도 호출자(라우트)는 이 함수를 **await 로 오래 붙들면 안 된다** — 202+백그라운드나 별도 상태 폴링으로
//    감싸는 건 호출자 몫(현재 라우트는 clone 이 대개 초 단위인 사내 레포 전제로 직접 await, 상한은 아래 CAP).
import { getNode } from "./store.js";
import { nodeOnline, nodeRpc, nodeSupports } from "./registry.js";
import { resolveRepoInject, type RepoSpec, type ProvisionedRepo } from "../project-provision.js";
import { HttpError } from "../capabilities/rest-util.js";
import { logger } from "../log.js";

const POLL_MS = 2_000;                    // provisionStatus 폴링 간격
const DEFAULT_CAP_MS = 8 * 60_000;        // 완료 대기 상한(대형 레포 첫 clone 여유) — 넘으면 노드에선 계속 돌지만 여기선 포기
const POLL_FAIL_MAX = 3;                  // 상태 폴링 연속 실패 허용(일시 네트워크 흔들림) — 넘으면 오프라인 취급

export type ProvisionStatus = { known: boolean; state: "running" | "done" | "error"; result?: unknown; error?: string };

// 폴링 루프의 주입 가능 의존(#905 C4) — registry(nodeRpc/nodeOnline)는 DB·WS 싱글턴이라 못 mock 한다. 그래서 이
//  novel 한 상태기계(known:false 재시작 · 폴 실패 재시도 · 데드라인 · 오프라인)를 fake 로 단위검증할 수 있게 분리한다.
export interface ProvisionPollDeps {
  online: () => boolean;                     // 노드가 아직 붙어 있나(nodeOnline)
  status: () => Promise<ProvisionStatus>;    // provisionStatus RPC
  reprovision: () => Promise<void>;          // known:false(노드 재시작) 시 재-시작 — 멱등이라 안전
  sleep?: (ms: number) => Promise<void>;     // 테스트에서 즉시-resolve 로 대체
  now?: () => number;                        // 테스트에서 결정적 시각
}

// 폴링 루프 본체(순수 — 주입 의존만 쓴다). done→결과 · error→502 · 데드라인→504 · 오프라인→409 · 연속실패→502.
export async function drivePollProvision(
  deps: ProvisionPollDeps, o: { nodeId: string; projectId: number; capMs: number; pollMs?: number },
): Promise<ProvisionedRepo[]> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const pollMs = o.pollMs ?? POLL_MS;
  const deadline = now() + o.capMs;
  let pollFails = 0;
  for (;;) {
    if (now() > deadline) throw new HttpError(504, `노드 '${o.nodeId}' provision 시간 초과(${Math.round(o.capMs / 1000)}s) — 노드에선 계속 진행 중일 수 있습니다.`);
    await sleep(pollMs);
    let st: ProvisionStatus;
    try { st = await deps.status(); pollFails = 0; }
    catch (e) {
      // 노드가 사라졌으면 즉시 포기(clone 도 죽었다), 일시 흔들림이면 몇 번 봐준다.
      if (!deps.online()) throw new HttpError(409, `노드 '${o.nodeId}' 연결이 끊겨 provision 을 확인할 수 없습니다.`);
      if (++pollFails > POLL_FAIL_MAX) throw new HttpError(502, `노드 '${o.nodeId}' provision 상태 조회 실패: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    // known:false = 노드가 재시작돼 작업 기억을 잃음 → 한 번 더 시작시켜 이어간다(멱등). 데드라인이 무한 재시작을 막는다.
    if (!st.known) {
      logger.warn({ node: o.nodeId, projectId: o.projectId }, "노드가 provision 작업을 잊음 — 재시작");
      await deps.reprovision();
      continue;
    }
    if (st.state === "running") continue;
    if (st.state === "error") throw new HttpError(502, `노드 '${o.nodeId}' provision 실패: ${st.error ?? "unknown"}`);
    return Array.isArray(st.result) ? st.result as ProvisionedRepo[] : [];
  }
}

// 노드에 프로젝트 레포들을 provision 시키고 완료까지 기다려 결과(ProvisionedRepo[])를 돌려준다.
//  specs 는 사용자 지정(name·worktree·branch·path). 여기서 각 spec 에 inject(git_url·자격)를 채워 노드에 보낸다
//  — 노드엔 DB 가 없어 스스로 못 해낸다. 자격 정책(member=본인 · worker=조직폴백)은 resolveRepoInject 단일 관문.
export async function provisionProjectOnNode(
  nodeId: string, projectId: number, folder: string, specs: RepoSpec[], requesterId: string,
  opts?: { capMs?: number },
): Promise<ProvisionedRepo[]> {
  if (!nodeOnline(nodeId)) throw new HttpError(409, `노드 '${nodeId}' 가 오프라인입니다 — 그 PC/서버의 lively 노드 연결을 확인하세요.`);
  // 🔴 미지원 노드엔 애초에 보내지 않는다 — 보내면 nodeRpc 가 node-unsupported-op 로 던진다. 여기서 먼저 잡아 사람 말로.
  if (!nodeSupports(nodeId, "provision")) {
    throw new HttpError(409, `노드 '${nodeId}' 의 에이전트가 낡아 프로젝트 provision 을 지원하지 않습니다 — 그 PC/서버에서 노드를 다시 설치·업데이트하세요.`);
  }
  const node = await getNode(nodeId);
  if (!node || !node.enabled) throw new HttpError(409, `노드 '${nodeId}' 가 비활성 상태입니다.`);
  // 🔴 소유권 게이트 — **남의 멤버 노드**엔 provision 하지 않는다. member 노드는 개인 노트북이라, 거기에 provision
  //  하면 요청자 본인 git 자격(leaseGitSecretForNode)이 그 남의 머신으로 나가고 남의 디스크에 내 레포가 클론된다.
  //  위탁 스케줄러도 같은 규율(리스 없으면 owner===requester 노드만 후보). worker 노드는 조직 공용 실행기라 개방.
  if (node.kind === "member" && node.owner_member !== requesterId) {
    throw new HttpError(403, `노드 '${nodeId}' 는 본인 소유의 멤버 노드가 아닙니다 — 남의 노드엔 provision 할 수 없습니다.`);
  }

  // 각 spec 에 inject 채우기 — 자격은 노드 종류가 가른다(member/worker). resolveRepoInject 안에 정책이 갇혀 있다.
  const injected: RepoSpec[] = [];
  for (const s of specs) {
    const name = String(s?.name ?? "").trim();
    if (!name) throw new HttpError(400, "provision spec 에 레포 이름이 없습니다");
    injected.push({ ...s, inject: await resolveRepoInject(name, requesterId, node.kind) });
  }

  // provision 디스패치(초기·재시작 공용) — 네트워크 오류를 사람 말 409 로 매핑(래핑 없으면 bare 500 로 샌다).
  const dispatch = async (): Promise<{ started: boolean }> => {
    try { return await nodeRpc<{ started: boolean }>(nodeId, "provision", { projectId, folder, specs: injected, memberId: requesterId, clone: true }); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "node-offline" || !nodeOnline(nodeId)) throw new HttpError(409, `노드 '${nodeId}' 연결이 끊겨 provision 을 시작하지 못했습니다.`);
      throw new HttpError(502, `노드 '${nodeId}' provision 시작 실패: ${msg}`);
    }
  };

  const first = await dispatch();
  // started:false = 이미 그 프로젝트 provision 이 노드에서 돌고 있다(coalesce). 이 요청의 specs 는 그 작업에 안 반영될 수
  //  있으니 남긴다 — 조용히 다른 specs 로 끝나는 오해를 막는다(대개는 같은 요청 재시도라 무해).
  if (!first.started) logger.warn({ node: nodeId, projectId }, "노드에 provision 이 이미 진행 중 — 이 요청 specs 는 무시될 수 있음");

  const capMs = Math.max(30_000, opts?.capMs ?? DEFAULT_CAP_MS);
  return drivePollProvision(
    { online: () => nodeOnline(nodeId), status: () => nodeRpc<ProvisionStatus>(nodeId, "provisionStatus", { projectId }), reprovision: async () => { await dispatch(); } },
    { nodeId, projectId, capMs },
  );
}

function realSleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
