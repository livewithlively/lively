// 분산 노드(#869) — 게이트웨이 ↔ 노드 에이전트 단일 WSS 위의 멀티플렉스 프로토콜.
// 연결 방향은 항상 노드 → 게이트웨이(아웃바운드 전용 — 노드는 포트를 열지 않는다, F1).
// 프레임 2종:
//  - 텍스트 프레임 = JSON 제어 메시지(아래 NodeMsg/GwMsg).
//  - 바이너리 프레임 = attach 채널의 PTY 데이터: [1B kind=0x01][4B BE chan][payload...]
//    (tmux -CC 출력은 멀티바이트가 프레임 경계에서 쪼개질 수 있어 서버가 디코드하지 않고
//     바이트 그대로 릴레이한다 — terminal-pty 와 동일 원칙.)
import type { SessionInfo } from "../terminal/terminal-sessions.js";
import type { WorkerRunSnapshot } from "../apps/worker-host.js";
import type { KeepAwakeStatus } from "./keep-awake.js";   // #1849 — hello 로 보고하는 잠자기 억제 상태(타입만)

export const NODE_WS_PATH = "/node/ws";
export const PROTO_VER = 1;

// 게이트웨이 주소 → 노드 채널 WSS. 에이전트가 쓰지만 **여기** 두는 이유: agent.ts 는 임포트 즉시
//  환경변수를 검사하고 종료하는 실행 스크립트라 테스트가 못 붙는다(그래서 이 규칙이 오래 안 지켜졌다).
//  ⚠ pathname 을 **덮어쓰면 안 된다**(실측 #1541): 서브패스로 서비스되는 게이트웨이
//   (프리뷰 `https://호스트/preview/<env>`, 리버스프록시 하위 마운트)의 접두사가 통째로 날아가
//   전혀 다른 게이트웨이에 붙는다. 실제로 프리뷰에 등록한 윈도우 노드가 `wss://dev.lvly.io/node/ws`
//   (운영)로 연결돼, 브라우저(프리뷰)에선 그 노드가 영영 안 보이고 attach 가 무한 재시도했다.
//   등록한 곳과 붙는 곳은 **같은 오리진 + 같은 베이스경로**여야 한다.
export function nodeWsUrl(base: string): string {
  const u = new URL(base);
  u.protocol = u.protocol === "http:" ? "ws:" : u.protocol === "https:" ? "wss:" : u.protocol;
  u.pathname = u.pathname.replace(/\/+$/, "") + NODE_WS_PATH;   // 베이스경로를 보존하고 이어붙인다
  u.search = "";
  u.hash = "";
  return u.toString();
}

// 바이너리 채널 프레임 kind. 현재 PTY 데이터 하나 — 추후 파일 스트림 등 확장 여지.
export const FRAME_PTY = 0x01;

export function encodeChanFrame(chan: number, payload: Buffer | Uint8Array): Buffer {
  const head = Buffer.allocUnsafe(5);
  head.writeUInt8(FRAME_PTY, 0);
  head.writeUInt32BE(chan >>> 0, 1);
  return Buffer.concat([head, Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]);
}

export function decodeChanFrame(buf: Buffer): { kind: number; chan: number; payload: Buffer } | null {
  if (buf.length < 5) return null;
  return { kind: buf.readUInt8(0), chan: buf.readUInt32BE(1), payload: buf.subarray(5) };
}

// 노드 리소스 스냅샷(P2 §10) — 상시 노출(상태 push 에 동봉). 스케줄러의 리소스-적합 배치 입력.
export interface NodeResources {
  cpus: number; load1: number;            // 논리 코어 수 · 1분 로드애버리지
  mem_total_mb: number; mem_free_mb: number;
  disk_total_mb: number; disk_free_mb: number; // 공유 워크스페이스 루트 기준
}

// ── 제어 메시지(JSON 텍스트 프레임) ──
// 노드 → 게이트웨이
// hello — 노드가 붙자마자 자기 신원을 밝힌다.
//  ver     = 프로토콜 버전(PROTO_VER). 게이트웨이가 대조한다 — 다르면 프레임 해석이 어긋나므로 붙이면 안 된다.
//  agentVer= **도는 번들 자신의 지문**(sha256 12hex — 키트의 kit-version 과 같은 모델: "설치가 반영하는 바이트가 곧
//            버전"이라 사람이 숫자를 올릴 필요도, 빠뜨릴 일도 없다). 게이트웨이가 서빙본 지문과 비교해 최신 여부를 안다.
//  caps    = **이 빌드가 실제로 구현한 op 목록**(NODE_OPS). 버전은 '어떤 바이트냐'지 '무엇을 할 수 있냐'가 아니다 —
//            그 질문엔 노드가 직접 답해야 한다. 없으면 구 노드 → v1 기준선으로 간주(nodeCaps).
//  harnesses = **이 PC 에서 실제로 세션을 띄울 수 있는 하네스**(#1713) = 이 번들의 카탈로그 ∩ PATH 에 있는 실행 파일.
//            caps 와 같은 이유로 노드가 직접 답한다 — 게이트웨이는 남의 PC 에 무엇이 깔렸는지 알 방법이 없고,
//            번들이 낡았는지도 이 값이 스스로 말한다(옛 빌드는 이 필드를 안 보낸다 → nodeHarnesses 가 기준선으로).
//  keepAwake = **이 PC 가 자지 않게 붙잡고 있나**(#1849). 노드가 붙어 있어야 원격 세션이 열리는데, 노트북은
//            전원이 꽂혀 있어도 유휴 잠자기에 들어가 링크가 끊긴다(실측: 1시간에 한 번, 60초씩만 연결).
//            에이전트가 스스로 억제를 걸고 그 결과를 여기로 보고한다 — 자동으로 못 막는 구멍(gaps: 뚜껑 닫기·
//            배터리·modern standby)까지 함께 보내야 화면이 "왜 아직 끊기는지"와 "무엇을 더 해야 하는지"를 말한다.
//            구 번들은 이 필드를 안 보낸다 → '모름'(undefined)이지 '안 걸림'이 아니다(그 구분은 UI 가 해야 한다).
export interface HelloMsg {
  t: "hello"; ver: number; node: string; platform: string;
  agentVer?: string; caps?: string[]; harnesses?: string[]; host?: string; hasDocker?: boolean;
  keepAwake?: KeepAwakeStatus;
}
export interface StateMsg { t: "state"; sessions: SessionInfo[]; res?: NodeResources }
export interface ResMsg { t: "res"; id: number; ok: boolean; data?: unknown; error?: string }
export interface OpenedMsg { t: "opened"; chan: number }
export interface OpenFailMsg { t: "openfail"; chan: number; code: number; reason: string }
// 위탁 태스크 종결 보고(P2) — 노드가 exit 파일 감지·결과 수집 후 1회 push. summary 는 상한 잘라 전송.
export interface TaskDoneMsg { t: "taskdone"; taskId: number; ok: boolean; exit: number | null; summary?: string; error?: string }
export interface WorkerStateMsg { t: "workerState"; snapshot: WorkerRunSnapshot }
// 게이트웨이 → 노드
export interface ReqMsg { t: "req"; id: number; op: NodeOp; args?: Record<string, unknown> }
export interface OpenMsg { t: "open"; chan: number; session: string }
export interface CtlMsg { t: "ctl"; chan: number; m: Record<string, unknown> } // 브라우저 제어(i/r/cap) 포워딩
// 양방향
export interface CloseChanMsg { t: "close"; chan: number }
// 게이트웨이 → 노드, hello 직후 1회(#1713) — "지금 서빙 중인 번들은 이 지문이다".
//  노드는 자기 AGENT_VER 와 비교해 다르면 스스로 새 번들을 받아 교체하고 종료한다(런처가 되살린다).
//  ⚠ 이게 없으면 노드는 자기가 낡았다는 걸 알 방법이 없다 — 실측(#1713): launchd 는 `lively node` CLI 가 아니라
//   받아 둔 agent.mjs 를 **직접** 실행하므로 재시작해도 pull 이 일어나지 않아, 노드가 영원히 옛 번들로 돈다.
export interface HelloOkMsg { t: "helloOk"; agentVerLatest?: string | null }

// runTask = 위탁 태스크 실행(P2) · watchTask = 노드 재연결 시 진행중 태스크 감시 재장전(에이전트 재시작 복구)
//  · tailTask = 진행 로그(stream.jsonl) 오프셋 tail 릴레이(§11 CLI 미러링).
// fs* = 노드 세션 파일 릴레이(#875) — 세션 작업폴더(@box_dir) 기준. 바이트는 base64 청크(maxPayload 1MB 회피),
//  게이트웨이가 nodeCanAttach 로 인가 후 위임(정책=게이트웨이, 실행=노드 F7). fsRead(len=0)=stat.
//
// ── 🔒 v1 기준선(#905 C4) — **이 배열은 절대 늘리지 않는다.** ──
//  구 노드는 hello 에 caps 를 안 싣는다(그 필드가 없던 빌드다). 그때 게이트웨이가 "이 노드는 무엇을 할 수 있나"를
//  물으면 답할 근거가 이 목록뿐이다 — "ver=1 로 붙은 노드는 최소한 이건 다 한다"는 사실. 여기에 새 op 를 끼워넣으면
//  **구 노드가 못 하는 걸 한다고 주장하게 되고**, 게이트웨이는 그걸 믿고 디스패치해 정체불명의 문자열 에러를 받는다
//  (그게 정확히 이 과업이 없애려는 상태다). 새 op 는 반드시 NODE_OPS_NEW 로만 들어간다.
const NODE_OPS_V1 = ["list", "create", "kill", "edit", "gone", "label", "runTask", "watchTask", "tailTask",
  "fsLs", "fsRead", "fsWrite", "fsMkdir", "prompts"] as const;
// v1 이후 추가된 op — 이걸 지원하는 노드는 hello.caps 로 **스스로 선언한다**. 선언 없으면 게이트웨이가 안 보낸다.
//  provision = 프로젝트 레포를 노드에 clone→worktree(#905 C4, 비동기 — clone 이 RPC 15s 를 넘겨 백그라운드로 돈다).
//  provisionStatus = 그 백그라운드 작업 상태 폴링(즉답 — RPC 안에 든다). 이 둘이 "노드에서 프로젝트 provision"의 실체다.
//  markActive = 하네스 훅이 게이트웨이에 보고한 활동·실행단계(#1221)를 **그 세션의 tmux 를 가진 노드**로 넘긴다.
//   노드 세션의 상태 메타(@box_last_busy·@box_state)는 노드 tmux 에 사니 게이트웨이가 직접 못 쓴다.
//  sendKeys = 그 세션의 PTY 에 프롬프트를 넣고 제출한다(#1664). 게이트웨이의 주입(크론·리브)은 여태
//   **로컬 tmux 를 직접** 불렀기에 노드 세션엔 닿지 못했다 — 사람이 웹터미널에 붙어 손으로 치는 수밖에.
//   Windows 노드는 mux 가 psmux 라 입력 표면이 다른데, 그 인코딩은 terminal/send-keys 가 흡수한다.
//  setProject = 그 세션의 프로젝트 소속을 바꾼다. DB current는 게이트웨이가 먼저 기록하고,
//   노드는 tmux @box_project 실행 캐시만 적용한다(cwd·project.json·링크·셔틀은 건드리지 않는다).
//  injectFirstPrompt = 프로젝트 세션 create와 첫 지시를 둘로 나눠, 게이트웨이가 DB current를 기록한 뒤에만
//   노드의 입력창 대기·주입을 시작한다. 즉답 후 백그라운드 실행이라 90초 폴링이 RPC 상한을 잡아먹지 않는다.
//  markSeen = 사람이 **그 세션 화면을 보고 있다**는 도장(#1954 3차, @box_last_seen). markActive 와 같은 이유로 릴레이가
//   필요하다 — 노드 세션의 tmux 는 그 PC 에 있어 게이트웨이가 직접 못 쓴다. 이 op 를 모르는 구 노드에서는
//   그 세션만 종전 동작(attach 시각만으로 판정)으로 남는다 — 안 보내면 그만이라 무회귀다.
const NODE_OPS_NEW = ["provision", "provisionStatus", "markActive", "markSeen", "sendKeys", "setProject", "createAppSession", "stageWorkerChunk", "startWorker", "workerStatus", "stopWorker", "injectFirstPrompt"] as const;

// 이 빌드가 아는 op 전량. **타입이 이 배열에서 파생**되므로 목록과 타입이 어긋날 수 없다.
export const NODE_OPS = [...NODE_OPS_V1, ...NODE_OPS_NEW] as const;
export type NodeOp = typeof NODE_OPS[number];
export const NODE_BASELINE_OPS: readonly NodeOp[] = NODE_OPS_V1;

// 이 노드가 실제로 할 수 있는 op 집합. caps 를 안 보낸 구 노드는 v1 기준선으로 본다.
//  ⚠ "모르면 못 한다고 본다"가 원칙 — 기준선 밖의 op 는 **선언한 노드에만** 보낸다.
export function nodeCaps(caps: readonly string[] | null | undefined): Set<string> {
  return new Set(Array.isArray(caps) ? caps : NODE_BASELINE_OPS);
}

// ── 이 노드에서 실제로 열 수 있는 하네스(#1713) ──────────────────────────────────────
// 왜 필요한가: 노드 세션은 게이트웨이가 하네스를 검증하지 않고 그대로 릴레이하고, 판정은 **그 PC 에서 도는 번들**이
//  한다. 번들은 `lively node` 실행 시점에 pull 한 것이라 데몬이 도는 동안 갱신되지 않는다 — 그래서 게이트웨이가
//  antigravity 를 지원해도 노드가 옛 번들이면 "허용되지 않은 하네스입니다"(502)로 튕긴다. 실측(2026-08-14):
//  라이브 노드 4대가 전부 옛 번들이라 claude·codex·shell 만 알았다. 사용자는 그걸 **[생성하기]를 누른 뒤에야** 알았다.
//  여기에 바이너리 부재까지 겹친다 — 번들이 최신이어도 그 PC 에 `agy` 가 없으면 세션이 뜨자마자 죽는다.
//  두 문제의 답은 같다: **노드가 자기가 띄울 수 있는 것을 스스로 말한다.**
//
// 기준선(구 노드가 harnesses 를 안 보낼 때) = 옛 번들이 실제로 알던 것. 이것도 caps 와 같은 원칙이다 —
//  "모르면 못 한다고 본다". 여기에 새 하네스를 끼워넣으면 구 노드가 못 하는 걸 한다고 주장하게 된다.
export const NODE_BASELINE_HARNESSES: readonly string[] = ["claude", "codex", "shell"];
export function nodeHarnesses(reported: readonly string[] | null | undefined): string[] {
  const list = Array.isArray(reported) ? reported.filter((h) => typeof h === "string" && h) : null;
  return list && list.length ? [...new Set(list)] : [...NODE_BASELINE_HARNESSES];
}

// 이 노드가 최신 번들을 도는가 — **3상**이다(#905 C4). 순수 함수로 둬 라우트 없이 검증한다.
//  · true  = 서빙본과 같은 바이트
//  · false = 다른 바이트(업데이트 필요)
//  · null  = **판정 불가** — 노드가 agentVer 를 안 보냈거나(구 에이전트) 게이트웨이에 번들이 없다.
//    🔴 null 을 false 로 뭉개면 근거 없이 "업데이트하세요"를 띄운다. 라이브 노드 2대가 지금 정확히 이 상태다
//    (구 번들이라 agentVer 미전송) — 뭉갰다면 첫 화면부터 전원 '구버전'이라는 거짓말을 보게 된다.
export function agentIsLatest(nodeVer: string | null | undefined, servedVer: string | null | undefined): boolean | null {
  if (!nodeVer || !servedVer) return null;
  return nodeVer === servedVer;
}

export type NodeToGwMsg = HelloMsg | StateMsg | ResMsg | OpenedMsg | OpenFailMsg | CloseChanMsg | TaskDoneMsg | WorkerStateMsg;
export type GwToNodeMsg = ReqMsg | OpenMsg | CtlMsg | CloseChanMsg | HelloOkMsg;

export function parseMsg<T>(raw: unknown): T | null {
  try {
    const s = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    const m = JSON.parse(s) as T & { t?: string };
    return m && typeof m.t === "string" ? (m as T) : null;
  } catch { return null; }
}

// 노드 세션 뷰어 판정(정책은 게이트웨이 소유 — F7 정책/실행 분리). 노드 세션은 v1 에서 전부
//  '개인 세션' 규칙(소유자 또는 초대 멤버)만 적용한다 — 프로젝트 폴더 전체공개 규칙(#452)은
//  게이트웨이 로컬 dir 판정이라 원격 경로에 적용하지 않는다(멤버 PC 프라이버시 기본, D2).
export function nodeSessionVisible(s: Pick<SessionInfo, "owner" | "invites">, viewer: string): boolean {
  return s.owner === viewer || (s.invites || []).includes(viewer);
}
