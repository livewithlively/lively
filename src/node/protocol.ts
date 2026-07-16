// 분산 노드(#869) — 게이트웨이 ↔ 노드 에이전트 단일 WSS 위의 멀티플렉스 프로토콜.
// 연결 방향은 항상 노드 → 게이트웨이(아웃바운드 전용 — 노드는 포트를 열지 않는다, F1).
// 프레임 2종:
//  - 텍스트 프레임 = JSON 제어 메시지(아래 NodeMsg/GwMsg).
//  - 바이너리 프레임 = attach 채널의 PTY 데이터: [1B kind=0x01][4B BE chan][payload...]
//    (tmux -CC 출력은 멀티바이트가 프레임 경계에서 쪼개질 수 있어 서버가 디코드하지 않고
//     바이트 그대로 릴레이한다 — terminal-pty 와 동일 원칙.)
import type { SessionInfo } from "../terminal-sessions.js";

export const NODE_WS_PATH = "/node/ws";
export const PROTO_VER = 1;

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
export interface HelloMsg { t: "hello"; ver: number; node: string; platform: string; agentVer?: string; host?: string; hasDocker?: boolean }
export interface StateMsg { t: "state"; sessions: SessionInfo[]; res?: NodeResources }
export interface ResMsg { t: "res"; id: number; ok: boolean; data?: unknown; error?: string }
export interface OpenedMsg { t: "opened"; chan: number }
export interface OpenFailMsg { t: "openfail"; chan: number; code: number; reason: string }
// 위탁 태스크 종결 보고(P2) — 노드가 exit 파일 감지·결과 수집 후 1회 push. summary 는 상한 잘라 전송.
export interface TaskDoneMsg { t: "taskdone"; taskId: number; ok: boolean; exit: number | null; summary?: string; error?: string }
// 게이트웨이 → 노드
export interface ReqMsg { t: "req"; id: number; op: NodeOp; args?: Record<string, unknown> }
export interface OpenMsg { t: "open"; chan: number; session: string }
export interface CtlMsg { t: "ctl"; chan: number; m: Record<string, unknown> } // 브라우저 제어(i/r/cap) 포워딩
// 양방향
export interface CloseChanMsg { t: "close"; chan: number }

// runTask = 위탁 태스크 실행(P2) · watchTask = 노드 재연결 시 진행중 태스크 감시 재장전(에이전트 재시작 복구)
//  · tailTask = 진행 로그(stream.jsonl) 오프셋 tail 릴레이(§11 CLI 미러링).
// fs* = 노드 세션 파일 릴레이(#875) — 세션 작업폴더(@box_dir) 기준. 바이트는 base64 청크(maxPayload 1MB 회피),
//  게이트웨이가 nodeCanAttach 로 인가 후 위임(정책=게이트웨이, 실행=노드 F7). fsRead(len=0)=stat.
export type NodeOp = "list" | "create" | "kill" | "edit" | "gone" | "label" | "runTask" | "watchTask" | "tailTask"
  | "fsLs" | "fsRead" | "fsWrite" | "fsMkdir";

export type NodeToGwMsg = HelloMsg | StateMsg | ResMsg | OpenedMsg | OpenFailMsg | CloseChanMsg | TaskDoneMsg;
export type GwToNodeMsg = ReqMsg | OpenMsg | CtlMsg | CloseChanMsg;

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
