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
import { getNode, type OrgNode } from "./store.js";
import { nodeOpenTo } from "./node-access.js";
import { nodeOnline, nodeRpc, nodeSupports, nodeSessionsFor, type NodeSessionInfo } from "./registry.js";
import type { NodeOp } from "./protocol.js";
import { resolveRepoInject, type RepoSpec, type ProvisionedRepo, type ProvisionResult } from "../project/project-provision.js";
import type { CreateInput, SessionInfo } from "../terminal/terminal-sessions.js"; // type-only — 런타임 순환 없음(erased)
import { HttpError } from "../http-error.js";
import { translateNodeRpcError } from "./rpc-error.js";
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
): Promise<ProvisionResult> {
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
    return normalizeProvisionResult(st.result);
  }
}

// 노드가 돌려준 provision 결과 정규화(#1155) — 구 번들 노드는 **배열**(ProvisionedRepo[])만 돌려준다.
//  새 번들은 {provisioned, failed}. 게이트웨이가 노드보다 먼저 업데이트되는 게 정상이라(키트 자가 업데이트는
//  노드마다 시차) 두 모양을 모두 받는다 — 구 노드면 failed 는 빈 배열(그 노드는 실패 시 error 상태로 온다).
export function normalizeProvisionResult(raw: unknown): ProvisionResult {
  if (Array.isArray(raw)) return { provisioned: raw as ProvisionedRepo[], failed: [] };
  const o = (raw ?? {}) as Partial<ProvisionResult>;
  return { provisioned: Array.isArray(o.provisioned) ? o.provisioned : [], failed: Array.isArray(o.failed) ? o.failed : [] };
}

// 노드 사용 게이트(#905 C4) — "이 요청자가 이 노드에 프로젝트 작업(provision·세션생성)을 시킬 수 있는가"의 단일 판정.
//  provision·create 두 경로가 **같은 게이트**를 써야 한쪽만 통과하는 불일치(provision 됐는데 세션 못 열기, 그 반대)가
//  안 난다. 레지스트리(online/supports)·DB(getNode)는 싱글턴이라 못 mock → 주입형으로 분리해 판정을 단위검증한다
//  (drivePollProvision 과 같은 이유). 실경로는 아래 liveNodeDeps.
export interface NodeUsableDeps {
  online: (nodeId: string) => boolean;
  supports: (nodeId: string, op: NodeOp) => boolean;
  getNode: (nodeId: string) => Promise<OrgNode | null | undefined>;
}
const liveNodeDeps: NodeUsableDeps = { online: nodeOnline, supports: nodeSupports, getNode };

// 정책(🔴 트립와이어): **등록한 사람 것 · 관리자가 공유로 지정한 노드만 개방**(#1540 — nodeOpenTo 단일 술어).
//  종전엔 개방 근거가 `kind==='worker'` 였다. 그게 두 축(개방 / git 자격·용량)을 한 컬럼에 얹은 것이어서,
//  admin 이 등록한 워커는 무조건 전원 개방이고 '개방을 끄는 손잡이'가 아예 없었다. 이제 개방은 shared 뿐이고
//  kind 는 자격 주입(member=본인 git 자격·worker=조직 폴백, resolveRepoInject)에만 남는다.
//  이게 무너지면 남의 노트북에 세션이 열리거나(격리 깨짐·자격 유출) 공유 실행기를 못 쓴다.
//  requireProvision=true 는 provision 능력까지 요구(세션생성=create 는 v1 기본 능력이라 false — 모든 노드가 가짐).
export async function assertNodeUsable(
  deps: NodeUsableDeps, nodeId: string, requesterId: string, opts?: { requireProvision?: boolean },
): Promise<OrgNode> {
  if (!deps.online(nodeId)) throw new HttpError(409, `노드 '${nodeId}' 가 오프라인입니다 — 그 PC/서버의 lively 노드 연결을 확인하세요.`);
  // 미지원(구 번들) 노드엔 애초에 안 보낸다 — 보내면 nodeRpc 가 node-unsupported-op 로 던진다. 여기서 먼저 사람 말로.
  if (opts?.requireProvision && !deps.supports(nodeId, "provision")) {
    throw new HttpError(409, `노드 '${nodeId}' 의 에이전트가 낡아 프로젝트 provision 을 지원하지 않습니다 — 그 PC/서버에서 노드를 다시 설치·업데이트하세요.`);
  }
  const node = await deps.getNode(nodeId);
  if (!node || !node.enabled) throw new HttpError(409, `노드 '${nodeId}' 가 비활성 상태입니다.`);
  // 🔴 소유·공유 게이트 — 남의 노드엔 아무것도 안 한다(격리·본인 git 자격 유출 차단). 관리자가 공유로 지정한
  //  노드만 예외. 위탁 스케줄러도 같은 술어를 쓴다(remoteDelegateAllowed — 거기에 자격 리스 조건이 하나 더 붙는다).
  //  admin 우회는 없다 — 관리자가 남의 노드를 쓰려면 공유를 켜야 한다(감사 가능한 경로).
  if (!nodeOpenTo(node, requesterId)) {
    throw new HttpError(403, `노드 '${nodeId}' 는 본인이 등록한 노드가 아니고 공유 노드도 아닙니다 — 관리자가 공유 노드로 지정한 노드만 함께 쓸 수 있습니다.`);
  }
  return node;
}

// 노드에 프로젝트 레포들을 provision 시키고 완료까지 기다려 결과(ProvisionedRepo[])를 돌려준다.
//  specs 는 사용자 지정(name·worktree·branch·path). 여기서 각 spec 에 inject(git_url·자격)를 채워 노드에 보낸다
//  — 노드엔 DB 가 없어 스스로 못 해낸다. 자격 정책(member=본인 · worker=조직폴백)은 resolveRepoInject 단일 관문.
export async function provisionProjectOnNode(
  nodeId: string, projectId: number, folder: string, specs: RepoSpec[], requesterId: string,
  opts?: { capMs?: number; waitForCompletion?: boolean },
): Promise<ProvisionResult> {
  // 게이트(online·provision 능력·enabled·소유권) — provision 은 능력까지 요구. node.kind 로 자격 정책이 갈린다.
  const node = await assertNodeUsable(liveNodeDeps, nodeId, requesterId, { requireProvision: true });

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
      // (#1313 R46) ⚠ 이 사이트는 **timeout·unsupported 분기가 없다** — node-rpc-timeout 도 502 로 나가는 게 현행
      //  동작이다. 케이스를 보태면 동작 변경이므로 map 에 timeout/unsupported 를 주지 않는다(원문 그대로 2분기).
      throw translateNodeRpcError(msg, {
        offline: `노드 '${nodeId}' 연결이 끊겨 provision 을 시작하지 못했습니다.`,
        offlineWhen: () => !nodeOnline(nodeId),
        failed: (m) => `노드 '${nodeId}' provision 시작 실패: ${m}`,
      });
    }
  };

  const first = await dispatch();
  // started:false = 이미 그 프로젝트 provision 이 노드에서 돌고 있다(coalesce). 이 요청의 specs 는 그 작업에 안 반영될 수
  //  있으니 남긴다 — 조용히 다른 specs 로 끝나는 오해를 막는다(대개는 같은 요청 재시도라 무해).
  if (!first.started) logger.warn({ node: nodeId, projectId }, "노드에 provision 이 이미 진행 중 — 이 요청 specs 는 무시될 수 있음");
  // 비동기 모드(#1180) — 시작만 하고 즉시 돌아간다. 완료 확인은 호출자가 provisionStatusOnNode 로 폴링한다
  //  (노드는 원래부터 '시작만 하고 즉답'하는 구조라, 여기서 안 기다리면 그 설계가 브라우저까지 그대로 이어진다).
  if (opts?.waitForCompletion === false) return { provisioned: [], failed: [] };

  const capMs = Math.max(30_000, opts?.capMs ?? DEFAULT_CAP_MS);
  return drivePollProvision(
    { online: () => nodeOnline(nodeId), status: () => nodeRpc<ProvisionStatus>(nodeId, "provisionStatus", { projectId }), reprovision: async () => { await dispatch(); } },
    { nodeId, projectId, capMs },
  );
}

// 노드 provision 상태 1회 조회(#1180) — 비동기 모드에서 게이트웨이 라우트가 브라우저 폴링을 그대로 릴레이한다.
//  drivePollProvision 과 달리 기다리지 않는다(즉답). known:false(노드 재시작으로 작업 기억 상실)면 호출자가
//  재-provision 을 결정한다 — 여기서 몰래 재시작하면 폴링이 무한루프가 된다.
export async function provisionStatusOnNode(nodeId: string, projectId: number): Promise<ProvisionStatus & { provisioned: ProvisionResult["provisioned"]; failed: ProvisionResult["failed"] }> {
  if (!nodeOnline(nodeId)) throw new HttpError(409, `노드 '${nodeId}' 연결이 끊겨 provision 상태를 확인할 수 없습니다.`);
  const st = await nodeRpc<ProvisionStatus>(nodeId, "provisionStatus", { projectId });
  const norm = normalizeProvisionResult(st.result);
  return { ...st, provisioned: norm.provisioned, failed: norm.failed };
}

// 노드에서 프로젝트 세션을 연다(#905 C4) — provision 과 **같은 게이트**(assertNodeUsable) 뒤 create op 을 릴레이한다.
//  create 는 v1 기본 능력이라 requireProvision=false(단 UI 는 provision 미지원 노드를 애초에 안 보여준다). 세션 입력의
//  rootKey/subpath 의미는 게이트웨이 로컬과 동일 — ROOTS["shared"].base 가 노드·게이트웨이 모두 PROJECT_SHARED_BASE
//  라 같은 프로젝트 폴더로 해소된다. invites 는 게이트웨이가 프로젝트 멤버로 검증한 스냅샷을 넘긴다(노드는 프로젝트
//  무지 — DB 없음 → createSession 내부 검증이 빈 배열이 되므로, 노드 create 핸들러가 이 별도 invites 를 적용한다).
export async function createProjectSessionOnNode(
  nodeId: string, requesterId: string, input: CreateInput, invites: string[],
): Promise<SessionInfo> {
  await assertNodeUsable(liveNodeDeps, nodeId, requesterId);
  try {
    return await nodeRpc<SessionInfo>(nodeId, "create", {
      user: { userId: requesterId }, input: { ...input, invites: [] }, invites,
    });
  } catch (e) {
    // 네트워크·미지원을 사람 말로(래핑 없으면 bare 500 로 샌다) — relayNodeOp 와 같은 **분기 구성**(문구는 이 사이트 것).
    //  (#1313 R46) relayNodeOp 와 달리 offline 에 `|| !nodeOnline(nodeId)` 추가조건이 있고, unsupported 문구는 op 을
    //  끼우지 않는 고정 문구다 — 그 차이를 map 으로 표현한다.
    const msg = e instanceof Error ? e.message : String(e);
    throw translateNodeRpcError(msg, {
      offline: `노드 '${nodeId}' 연결이 끊겨 세션을 열지 못했습니다.`,
      offlineWhen: () => !nodeOnline(nodeId),
      timeout: `노드 '${nodeId}' 응답 시간 초과 — 세션 생성을 확인하지 못했습니다.`,
      unsupported: () => `노드 '${nodeId}' 의 에이전트가 낡아 세션 생성을 지원하지 않습니다 — 그 PC/서버에서 노드를 다시 설치·업데이트하세요.`,
      failed: (m) => `노드 '${nodeId}' 세션 생성 실패: ${m}`,
    });
  }
}

// 이 프로젝트에 속한, 이 사용자에게 보이는 노드 세션들(#905 C4) — 프로젝트 세션 목록 병합용. 노드에서 연 프로젝트
//  세션도 프로젝트 탭 목록에 보이게 한다. 가시성(owner∪invites 스냅샷)은 nodeSessionsFor 가 판정하므로, 여기선
//  projectId 로만 좁힌다. 각 항목은 .node({id,name,online}) 를 달고 있어 프론트가 &node= 로 입장/삭제를 릴레이한다.
export function nodeProjectSessions(viewerId: string, projectId: number): NodeSessionInfo[] {
  return nodeSessionsFor(viewerId).filter((s) => s.projectId === projectId);
}

function realSleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
