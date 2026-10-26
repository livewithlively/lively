// 원격 PC 하네스 종료 규칙의 **한 걸음**을 그 PC 에서 실행한다 (#5043) — 왜 노드가 하나: node/protocol.ts `stopStep` 머리말.
//
//  판정·정책은 게이트웨이가 한다(sessions/node-stop-rule.ts). 여기는 그 PC 의 tmux·프로세스·대화 파일로만 답할 수 있는 재료를 준다(F7 —
//   정책은 게이트웨이, 실행은 노드). 매니지드 규칙(session-stop-rule.ts defaultDeps)이 게이트웨이 tmux 로 하던 일을 한 걸음씩 옮긴 것이고,
//   판별자는 **같은 함수**를 쓴다(두 벌이면 매니지드와 원격 PC 의 판정이 갈린다):
//    · capture — 끄기 직전 화면 재확인·쪽지(쓰다 만 글·질문)의 재료. 색을 싣는다(-e): 흐림·굵게로 안내문과 사람 글을 가른다(stop-capture.ts).
//    · keys    — 질문 탭 넘기기(→). 그 밖의 키는 받지 않는다 — 이 표면으로 하네스에 아무 입력이나 넣을 수 있게 열지 않는다.
//    · jobs    — 하네스가 띄운 작업(셸·빌드)이 살아 있나 · 판정 불가(session-rss localJobVerdicts — session-reaper 와 같은 판별자 · 노드에선
//                list-panes -a 가 tmux 세대마다 퍼진다).
//    · viewers — 그 PC 터미널에서 사람이 **직접** 붙은 클라이언트 수(웹 화면이 붙인 것은 뺀다). 있으면 마지막 열람을 지금으로 새긴다 —
//                떼고 난 뒤의 시계가 «마지막 열람» 에서 시작하게(그러지 않으면 몇 시간 붙어 보던 세션이 떼는 순간 «오래 안 봄» 이 된다).
//    · quota   — claude 한도 자동 이어감 대기(#4810). 대화 기록은 이 PC 에 있다 — 게이트웨이는 그 파일을 못 본다(transcript-locate 머리말).
//    · seen    — 안 본 결과가 남은 채 끄는지(끝난 사유의 seen 칸 — sessions.ts reapCentralSession 과 같은 재료).
//  ⚠ 실패는 던진다 — 게이트웨이가 «판정 불가» 로 받아 그 세션(또는 그 컴퓨터)을 이번 판에 끄지 않는다(모르면 안 끈다).
//  ⚠ 노드 번들엔 DB 가 없다(번들 가드 — scripts/node-agent-allowed-modules.json). 그래서 판별자는 DB 를 안 끄는 자리에서 가져온다:
//   작업 판정 = session-rss localJobVerdicts(session-reaper 의 첫 단계와 같은 판별자) · 한도 대기 = session-quota-scan(session-quota-wait 의 몸통).
import { tmux, listSessionPanePids } from "../terminal/tmux-exec.js";
import { attachOwnerPids } from "../terminal/terminal-pty.js";
import { listSessionsRaw } from "../terminal/sessions.js";
import { markSessionSeen } from "../terminal/phase.js";
import { harnessIo } from "../terminal/harness-io/adapter.js";
import { locateTranscript } from "../terminal/harness-io/locate.js";
import { localTranscriptFs } from "../terminal/harness-io/transcript-fs.js";
import type { ReadableAdapter, TranscriptTarget } from "../terminal/transcript-locate.js";
import type { QuotaWait } from "../terminal/harness-io/quota-wait.js";
import { localJobVerdicts, readProcTable } from "../sessions/session-rss.js";
import { readQuotaWaitFrom } from "../sessions/session-quota-scan.js";
import { LAST_RESULT_SEEN_FMT, lastResultSeenFrom } from "../sessions/session-end.js";

export const STOP_STEPS = ["capture", "keys", "jobs", "viewers", "quota", "seen"] as const;
export type StopStep = (typeof STOP_STEPS)[number];
/** 한 번에 묻는 세션 수 상한 — 게이트웨이는 한 컴퓨터의 세션을 한 번에 묻는다(실측 맥미니 40여 개). 큰 배열로 판정 비용을 밀어 넣지 못하게. */
export const STOP_STEP_IDS_MAX = 200;
/** 받는 키 — 질문 탭 넘기기 하나뿐(session-stop-rule.ts readQuestion). */
export const STOP_STEP_KEYS: ReadonlySet<string> = new Set(["Right"]);
const ID_RE = /^box-[A-Za-z0-9._-]{1,120}$/;

function idOf(v: unknown): string {
  const id = String(v ?? "");
  if (!ID_RE.test(id)) throw new Error("세션 id 형식 오류");
  return id;
}
function idsOf(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error("ids 는 배열이어야 한다");
  if (v.length > STOP_STEP_IDS_MAX) throw new Error(`ids 는 ${STOP_STEP_IDS_MAX}개까지`);
  return [...new Set(v.map(idOf))];
}

/**
 * (순수) tmux 클라이언트 목록(`#{client_pid}\t#{session_name}`) → 세션별 **직접 붙은** 클라이언트 수.
 *  우리 웹 화면이 붙인 클라이언트는 부모가 이 프로세스(또는 attach 워커)다 — 그 밖의 부모를 가진 클라이언트가 사람이 직접 붙은 것이다.
 *  부모를 모르는 클라이언트(표에 없음 — 그새 끝났다)는 세지 않는다. 표를 아예 못 읽었으면 부르는 쪽이 이 함수를 부르지 않는다(던진다).
 */
export function localViewerCounts(
  clientsRaw: string, ppidOf: (pid: number) => number | undefined, owned: ReadonlySet<number>, ids: ReadonlySet<string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of clientsRaw.split("\n")) {
    const [pidRaw, sid] = line.trim().split("\t");
    if (!sid || !ids.has(sid)) continue;
    const pid = Number(pidRaw);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const ppid = ppidOf(pid);
    if (ppid === undefined || owned.has(ppid)) continue;
    out[sid] = (out[sid] ?? 0) + 1;
  }
  return out;
}

export interface StopStepDeps {
  tmux: (args: string[]) => Promise<string>;
  jobs: (ids: ReadonlySet<string>) => Promise<{ jobs: ReadonlySet<string>; unknown: ReadonlySet<string> }>;
  procTable: () => Promise<Map<number, { ppid: number }>>;
  owned: () => number[];
  markSeen: (id: string) => Promise<void>;
  quota: (args: { id: string; threadId: string; launchedAtMs: number; nowMs: number }) => Promise<QuotaWait | null>;
}

const defaultDeps = (): StopStepDeps => ({
  tmux: (args) => tmux(args),
  jobs: async (ids) => localJobVerdicts(ids, await listSessionPanePids(), await readProcTable()),
  procTable: () => readProcTable(),
  owned: () => attachOwnerPids(),
  markSeen: (id) => markSessionSeen(id),
  quota: (a) => localQuotaWait(a),
});

/** 한 걸음을 실행한다. 인자는 게이트웨이가 만든 봉투 그대로(node/protocol.ts ReqMsg.args). */
export async function runStopStep(args: Record<string, unknown>, d: StopStepDeps = defaultDeps()): Promise<unknown> {
  const step = String(args.step ?? "");
  switch (step as StopStep) {
    case "capture": return d.tmux(["capture-pane", "-t", idOf(args.id), "-p", "-e"]);
    case "keys": {
      const key = String(args.key ?? "");
      if (!STOP_STEP_KEYS.has(key)) throw new Error(`받지 않는 키: ${key}`);
      await d.tmux(["send-keys", "-t", idOf(args.id), key]);
      return { ok: true };
    }
    case "jobs": {
      const ids = new Set(idsOf(args.ids));
      const v = await d.jobs(ids);
      //  물은 세션만 돌려준다 — 판별자가 다른 세션을 덧붙여도 게이트웨이 판정에 새지 않게.
      return { jobs: [...v.jobs].filter((x) => ids.has(x)), unknown: [...v.unknown].filter((x) => ids.has(x)) };
    }
    case "viewers": {
      const ids = new Set(idsOf(args.ids));
      if (!ids.size) return { local: {} };
      const raw = await d.tmux(["list-clients", "-F", "#{client_pid}\t#{session_name}"]);
      const table = await d.procTable();
      //  ps 를 못 읽으면(빈 표) 웹 화면 클라이언트와 사람 클라이언트를 못 가른다 — 모르는 채 «없다» 고 답하지 않는다.
      if (raw.trim() && !table.size) throw new Error("프로세스 표를 못 읽어 직접 붙은 클라이언트를 가를 수 없다");
      const local = localViewerCounts(raw, (pid) => table.get(pid)?.ppid, new Set(d.owned()), ids);
      for (const id of Object.keys(local)) await d.markSeen(id).catch(() => undefined);   // 새기기 실패는 판정을 막지 않는다
      return { local };
    }
    case "quota": {
      const id = idOf(args.id);
      const threadId = String(args.threadId ?? "");
      const launchedAtMs = Number(args.launchedAtMs) || 0;
      const nowMs = Number(args.nowMs) || Date.now();
      return d.quota({ id, threadId, launchedAtMs, nowMs });
    }
    case "seen": return lastResultSeenFrom(await d.tmux(["display-message", "-p", "-t", idOf(args.id), LAST_RESULT_SEEN_FMT])) ?? null;
    default: throw new Error(`모르는 걸음: ${step}`);
  }
}

/**
 * 이 PC 의 대화 기록으로 한도 자동 이어감 대기를 판정한다 — 판정 규칙은 게이트웨이와 **같은 함수**(readQuotaWait)이고, 파일 찾기만 이 PC 의 것으로
 *  바꿔 끼운다(노드엔 DB 가 없어 세션의 작업 폴더·주인·하네스는 이 PC 의 tmux 행에서, 대화 id 는 게이트웨이가 실어 준 것으로).
 *  대화 id 가 없거나 파일을 못 찾으면 null(대기 재료 없음 — 매니지드와 같은 뜻), 세션이 이 PC 에 없으면 던진다(판정 불가).
 */
export async function localQuotaWait(a: { id: string; threadId: string; launchedAtMs: number; nowMs: number }): Promise<QuotaWait | null> {
  const session = (await listSessionsRaw({ strict: true })).find((s) => s.id === a.id);
  if (!session) throw new Error("이 PC 에 그 세션이 없다");
  const resolve = async (): Promise<TranscriptTarget> => {
    if (!a.threadId) return { ok: false, why: "no-uuid" };
    const io = harnessIo(session.harness);
    if (!io?.parse) return { ok: false, why: "unreadable", label: io?.label || session.harness || "이 하네스" };
    const readable = io as ReadableAdapter;
    const found = await locateTranscript(readable, { cwd: session.dir, convId: a.threadId, owner: session.owner }, localTranscriptFs.stat);
    if (!found) return { ok: false, why: "not-found" };
    return { ok: true, uuid: a.threadId, mapped: a.threadId, io: readable, cwd: session.dir, tfs: localTranscriptFs, found };
  };
  return readQuotaWaitFrom(a.id, { launchedAtMs: a.launchedAtMs, nowMs: a.nowMs }, resolve);
}
