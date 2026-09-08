// 대화 파일 감시자 — «파일이 오프셋 N 까지 자랐다» 를 **밀어 준다** (#3699).
//
//  ── 무엇을 바꾸나 ────────────────────────────────────────────────────────────────
//  대화창은 대화 파일을 0.7초마다 **되물었다**(`web/session-chat.ts` POLL_RUN_MS). 폴 1회는 매니지드에서
//   멤버 실행환경 중계 exec 2~3회(stat + 구간읽기)이고, 활성 대화창 하나당 초당 3~4.3회다(노드 저널 실측
//   3.5/s). 1000 테넌트·동시 관람 100명이면 초당 200~430 op — op 당 프로세스 스폰(gVisor 안 node 한 줄
//   실측 70ms)으로는 **구조가 안 선다**([[fs-container-after-tenant-unpin-3668]] §8-2·§9).
//  그래서 되묻기를 **통보**로 바꾼다: 파일이 자라면 그 사실을 화면에 밀고, 화면은 그때 한 번 읽는다.
//
//  ── 왜 «자랐다» 만 보내나(내용을 안 싣나) ────────────────────────────────────────
//  대화의 **정본은 파일**이다(`web/session-codex-live.ts` 머리말 교리) — 새로고침 복원·스트림 유실 내성이
//   거기 걸려 있다. 내용을 이 통로로도 그리면 같은 말이 두 번 뜨고, 줄 경계 정렬·압축(uuid) 전환·
//   압축 전 사슬(`chat-routes` 가 쥔 규약)을 여기서 **두 벌째** 구현하게 된다. 통보만 보내면 읽기는
//   종전 한 통로 그대로고, 이 층이 죽어도 대화는 안 끊긴다(폴링이 안전망으로 남는다).
//
//  ── 어디서 도나 — 쓰는 쪽 옆이다 ────────────────────────────────────────────────
//  ★ 감시자는 **쓰는 쪽에 있어야 한다.** JuiceFS 같은 분산 FUSE 는 다른 클라이언트(노드)의 쓰기를
//   inotify 로 전파하지 않는 것이 통상이라, 게이트웨이 박스에서 거는 감시는 안 잡힌다(#3668 §10-3 경고).
//   대화 파일을 쓰는 하네스는 **세션 컨테이너 안**에서 돈다 — 그래서 감시도 거기서 돈다(같은 마운트를
//   지나는 쓰기라 커널이 이벤트를 낸다). 매니지드가 아니면 파일이 게이트웨이와 같은 호스트라 로컬 감시다.
//
//  ── 수명 ─────────────────────────────────────────────────────────────────────────
//  열린 대화창당 1개가 아니라 **세션당 1개**를 참조계수로 공유한다(같은 세션을 두 탭에서 봐도 하나).
//   `/events` SSE 구독이 참조를 쥐고, 마지막 구독이 떠나면 유예 뒤 접는다(새로고침에 매번 다시 띄우지 않게).
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../log.js";
import { emitSessionEvent } from "./harness-io/runtime-bus.js";
import { resolveTranscript } from "./transcript-locate.js";
import { sessionExecConfigured, sessionSpawnArgv } from "./session-exec.js";
import { currentTenant, withTenant, type TenantContext } from "../org/tenant-context.js";
import { nodeOfSession } from "../node/registry.js";
import { sessionGone } from "./terminal-sessions.js";

/**
 * 이벤트와 **별개로** 직접 보는 주기 — inotify 가 안 오는 배포의 상한이다.
 *  값의 근거: 종전 폴은 0.7초였다. 이벤트가 하나도 안 와도 그보다 크게 안 밀려야 «자원을 아끼려다
 *  대화를 느리게 한» 것이 안 된다. 컨테이너 판의 원문(WATCH_JS)도 같은 값을 쓴다 — 두 갈래가
 *  다른 주기를 쓰면 «어느 배포에서 더 느린가» 가 코드에 안 적힌 사실이 된다.
 */
export const LOOK_MS = 2_000;

/**
 * 세션 컨테이너(또는 멤버 자리) 안에서 도는 감시자 원문 — **고정 리터럴**이다(값은 argv 로만 들어온다 →
 *  인젝션 없음. `terminal-member-fs.ts` 의 LS_JS·STAT_JS 와 같은 계약).
 *
 *  · 파일이 **담긴 폴더**를 지켜본다 — 파일 자체를 지켜보면 압축 롤오버(새 uuid = 새 파일)에서 감시가
 *    죽은 inode 에 남는다. 폴더 감시는 그 생성도 본다(첫 대화 전에 띄워도 된다).
 *  · inotify 를 **믿되 기대지 않는다**: 이벤트마다 stat 하되 150ms 로 뭉치고, 그와 별개로 2초마다 한 번
 *    직접 본다. gVisor·분산 FUSE 에서 이벤트가 오는지는 **아직 실측 안 했다** — 안 오더라도 지연이
 *    종전 폴링(0.7초)보다 크게 나빠지면 «자원을 아끼려다 대화를 느리게 한» 것이 된다. 2초는 그 상한이다.
 *    ⚠ 이 관측은 **컨테이너 안 stat 한 번**이다(종전 폴 1회 = 허브를 건너간 gVisor 프로세스 스폰 2~3회).
 *     같은 «1초에 몇 번» 이라도 비용이 두 자릿수 배 다르다 — 그래서 촘촘해도 된다.
 *  · stdout 이 끊기면(게이트웨이가 죽었거나 중계가 끊겼다) **스스로 끝난다** — 30초 박동이 EPIPE 를
 *    만들어 준다. 이게 없으면 컨테이너 안에 유령이 남는다(#2625 «exec 이 자기 클라이언트의 죽음을 못 본다»).
 */
export const WATCH_JS =
  "const fs=require('fs'),p=require('path');const f=process.argv[1],d=p.dirname(f);let last=-1,t=null;" +
  "const w=(o)=>{try{process.stdout.write(JSON.stringify(o)+'\\n')}catch{}};" +
  "const look=()=>{fs.stat(f,(e,s)=>{if(e||!s.isFile())return;if(s.size!==last){last=s.size;w({size:s.size})}})};" +
  "const bump=()=>{if(t)return;t=setTimeout(()=>{t=null;look()},150)};" +
  "process.stdout.on('error',()=>process.exit(0));" +
  "w({ready:1});look();" +
  "try{fs.watch(d,bump)}catch{}" +
  `setInterval(look,${LOOK_MS});setInterval(()=>w({beat:1}),30000);`;

/** 감시자가 한 줄로 보내는 말 — `ready`(떴다) · `size`(여기까지 자랐다) · `beat`(살아 있다). */
export interface WatchMsg { ready?: number; size?: number; beat?: number }

/** 줄바꿈 없는 쓰레기가 무한히 쌓이지 않게 하는 상한 — 정상 줄은 이보다 한참 짧다. */
export const MAX_ACC_BYTES = 4096;

/**
 * (순수) 자식 stdout 누적 버퍼 → **온전한 줄들**의 말 + 남은 꼬리.
 *
 *  ★ 떼어 둔 이유는 `web/sse-frames.ts` 와 같다 — **틀려도 조용하기 때문이다.** 청크는 항상 줄
 *   한가운데서 끊기는데(파이프의 성질), 잘못 이어 붙인 조각은 JSON 파싱에서 버려지고 증상은
 *   «가끔 통보가 빠진다» 로만 나타난다. 신고되지 않고 원인도 안 보인다.
 *
 *  계약: 경계는 `\n`. 마지막 조각은 `rest` 로 돌려 다음 청크 앞에 붙인다. 깨진 JSON 한 줄은
 *   **그 줄만** 버린다(나머지는 계속 해석한다). 경계 없이 상한을 넘으면 꼬리를 버린다 —
 *   줄바꿈이 영영 안 오는 입력에 메모리를 내주지 않는다.
 */
export function takeWatchLines(acc: string): { msgs: WatchMsg[]; rest: string } {
  const msgs: WatchMsg[] = [];
  let rest = String(acc ?? "");
  for (;;) {
    const at = rest.indexOf("\n");
    if (at < 0) break;
    const line = rest.slice(0, at).trim();
    rest = rest.slice(at + 1);
    if (!line) continue;
    try { msgs.push(JSON.parse(line) as WatchMsg); } catch { /* 깨진 줄 한 장은 넘긴다 */ }
  }
  if (rest.length > MAX_ACC_BYTES) rest = "";
  return { msgs, rest };
}

/** 화면이 새로 붙은 뒤 참조가 0 이 돼도 이만큼은 들고 있는다 — 새로고침마다 다시 띄우지 않으려고. */
export const LINGER_MS = 20_000;
/** 아직 파일이 없다(첫 대화 전)·중계가 잠깐 답을 안 한다 — 다시 걸어 보는 간격(상한까지 늘린다). */
const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 30_000;
/** 자란 사실을 **뭉쳐서** 보낸다 — 한 턴에 수십 줄이 붙어도 화면은 한 번 읽으면 된다. */
export const COALESCE_MS = 200;

interface Watch {
  refs: number;
  tenant: TenantContext | null;
  child: ChildProcess | null;
  local: fs.FSWatcher | null;
  localTimer: NodeJS.Timeout | null;
  retry: NodeJS.Timeout | null;
  retryMs: number;
  linger: NodeJS.Timeout | null;
  coalesce: NodeJS.Timeout | null;
  /** 마지막으로 알린 크기 — 같은 값을 두 번 알리지 않는다. */
  sent: number;
  /** 지금 자란 사실을 밀 수 있나. 화면은 이 값이 참일 때만 폴을 안전망 주기로 늦춘다. */
  live: boolean;
  /** 이 세션의 파일이 **저쪽 컴퓨터**에 있나. `null` = 아직 안 물어봤다(판정은 세션당 한 번이면 된다). */
  onNode: boolean | null;
  file: string;
  uuid: string;
  stopped: boolean;
}

const watches = new Map<string, Watch>();
/** 지금 «밀 수 있는» 세션 수 — 전이 로그에 함께 실어, 한 줄만 봐도 이 기능이 살아 있는지 알 수 있게 한다. */
let liveCount = 0;

/** 이 세션의 감시가 **지금 실제로 돌고 있나**. 화면이 폴 주기를 늦춰도 되는지의 유일한 근거다. */
export function transcriptWatchLive(sessionId: string): boolean {
  return !!watches.get(sessionId)?.live;
}

function setLive(id: string, w: Watch, live: boolean, reason?: string): void {
  if (w.live === live) return;
  w.live = live;
  if (live) liveCount++; else liveCount = Math.max(0, liveCount - 1);
  //  ⚠ **참을 못 알리면 느려질 뿐이지만, 거짓을 못 알리면 대화가 30초씩 밀린다.** 두 방향 다 보낸다.
  emitSessionEvent(id, { t: "transcript.watch", live, ...(reason ? { reason } : {}) });
  //  ★ **전이는 info 로 남긴다** — 이게 없으면 이 기능은 프로덕션에서 **보이지 않는다**(2026-09-08 실측).
  //   실패 경로가 debug 였는데 게이트웨이 최소 레벨이 info 라, 감시자가 통째로 안 떠도 로그에 한 줄도 안 남았다.
  //   그런데 증상도 없다 — 폴링이 안전망이라 대화는 멀쩡히 돌기 때문이다. 즉 «죽어 있어도 아무도 모른다» 였고,
  //   그건 [[green-deploy-dead-product-2258]] 이 모은 «판정이 보는 것이 진실이 아니다» 계열 그대로다.
  //  ⚠ 전이에서만 찍는다(이 함수는 값이 바뀔 때만 여기까지 온다) — 매 통보마다 찍으면 그게 새 소음이 된다.
  logger.info({ sessionId: id, live, reason: reason ?? null, liveCount }, "대화 파일 감시 상태가 바뀌었다");
}

function clearTimers(w: Watch): void {
  if (w.retry) { clearTimeout(w.retry); w.retry = null; }
  if (w.coalesce) { clearTimeout(w.coalesce); w.coalesce = null; }
  if (w.localTimer) { clearInterval(w.localTimer); w.localTimer = null; }
}

function teardown(w: Watch): void {
  clearTimers(w);
  if (w.child) { try { w.child.kill("SIGTERM"); } catch { /* 이미 죽음 */ } w.child = null; }
  if (w.local) { try { w.local.close(); } catch { /* 이미 닫힘 */ } w.local = null; }
}

/** 자란 사실을 알린다 — COALESCE_MS 로 뭉치고, 같은 크기는 다시 안 보낸다. */
function grew(id: string, w: Watch, size: number): void {
  if (!Number.isFinite(size) || size <= w.sent) return;
  w.sent = size;
  if (w.coalesce) return;
  w.coalesce = setTimeout(() => {
    w.coalesce = null;
    if (w.stopped) return;
    emitSessionEvent(id, { t: "transcript.grew", size: w.sent, ...(w.uuid ? { uuid: w.uuid } : {}) });
  }, COALESCE_MS);
}

function scheduleRetry(id: string, w: Watch): void {
  if (w.stopped || w.retry) return;
  const ms = w.retryMs;
  w.retryMs = Math.min(Math.round(w.retryMs * 2), RETRY_MAX_MS);
  //  ⚠ 재시도는 **요청 밖에서** 깨어난다 — 붙잡아 둔 테넌트 안에서 돌려야 세션 경계를 다시 계산할 수 있다.
  w.retry = setTimeout(() => { w.retry = null; inTenant(w, () => { void start(id, w); }); }, ms);
}

/** 감시자를 띄운다(또는 다시 띄운다). 실패는 던지지 않는다 — 폴링이 안전망이므로 조용히 다시 건다. */
async function start(id: string, w: Watch): Promise<void> {
  if (w.stopped || w.child || w.local) return;
  //  ★ 노드(멤버 PC) 세션의 대화 파일은 **그 컴퓨터에** 있다 — 여기서 지켜볼 수 없고, 화면도 중앙 기록으로
  //   물러나 있다(`chat-routes` gateRead 의 409 `node` 와 같은 판정). 안 가르면 그 세션마다 3~30초 간격으로
  //   찾지도 못할 파일을 되묻는 재시도가 돈다 — 줄이려던 바로 그 부하를 다른 이름으로 만드는 일이다.
  //  ⚠ **노드 등록 여부만으로 가르면 안 된다**: 게이트웨이 박스가 노드로도 등록된 배포에서는 이 박스의
  //   로컬 세션까지 노드로 잡힌다(#2055 실측 함정). 배달과 같은 기준을 쓴다 — «이 박스의 tmux 에 있나».
  if (w.onNode === null) {
    const nid = nodeOfSession(id);
    w.onNode = nid ? await sessionGone(id).catch(() => false) : false;
  }
  if (w.onNode) { setLive(id, w, false, "node"); return; }
  let target;
  try {
    target = await resolveTranscript(id);
  } catch (err) {
    logger.debug({ sessionId: id, err: (err as Error)?.message }, "대화 파일 감시 — 위치를 못 정했다(다시 시도)");
    setLive(id, w, false, "locate-failed");
    scheduleRetry(id, w);
    return;
  }
  if (w.stopped) return;
  if (!target.ok) {
    setLive(id, w, false, target.why);
    //  ★ 못 읽는 하네스는 **포기한다** — 파일이 생길 일이 없는데 영원히 되거는 것은 폴링을 없애려다
    //   같은 낭비를 다른 이름으로 만드는 일이다. 나머지(아직 없음)는 첫 대화가 오가면 생긴다.
    if (target.why !== "unreadable") scheduleRetry(id, w);
    return;
  }
  w.file = target.found.file;
  w.uuid = target.uuid;
  w.retryMs = RETRY_MIN_MS;   // 자리를 찾았다 — 다음에 죽어도 30초부터 다시 세지 않는다
  //  첫 관측치는 «자랐다» 가 아니라 **기준선**이다 — 화면은 이미 그만큼 읽고 있다(붙자마자 전체를 되읽게 하지 않는다).
  if (w.sent < target.found.size) w.sent = target.found.size;

  // ── 매니지드·격리: 파일을 **쓰는 쪽**(세션 컨테이너) 안에서 지켜본다. ──
  if (sessionExecConfigured()) {
    let argv: string[];
    try {
      argv = sessionSpawnArgv(id, ["node", "-e", WATCH_JS, w.file]);
    } catch (err) {
      //  테넌트 컨텍스트가 없다 = 이 자리에서 남의 컨테이너에 exec 할 뻔했다(fail-closed). 되걸지 않는다.
      logger.warn({ sessionId: id, err: (err as Error)?.message }, "대화 파일 감시 — 세션 경계를 못 정해 접는다");
      setLive(id, w, false, "no-tenant");
      return;
    }
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    w.child = child;
    let acc = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      //  자르기 계약은 순수 함수가 쥔다(takeWatchLines) — 조용히 틀리는 종류라 시험 가능한 자리에 둔다.
      const cut = takeWatchLines(acc + chunk.toString("utf8"));
      acc = cut.rest;
      for (const msg of cut.msgs) {
        if (msg.ready) { setLive(id, w, true); continue; }
        if (typeof msg.size === "number") grew(id, w, msg.size);
      }
    });
    //  stderr 는 진단용으로만 — 감시자가 못 떠도 대화는 폴링으로 돈다.
    child.stderr?.on("data", (c: Buffer) => logger.debug({ sessionId: id, err: c.toString("utf8").slice(0, 200) }, "대화 파일 감시 stderr"));
    child.on("error", (err) => {
      logger.debug({ sessionId: id, err: err?.message }, "대화 파일 감시자를 못 띄웠다");
      w.child = null;
      setLive(id, w, false, "spawn-failed");
      scheduleRetry(id, w);
    });
    child.on("close", () => {
      if (w.child !== child) return;                  // 이미 갈아탔다
      w.child = null;
      setLive(id, w, false, "exited");
      scheduleRetry(id, w);                           // 살아 있는 화면이 있으면 다시 띄운다
    });
    return;
  }

  // ── 셀프호스트·로컬 격리: 파일이 게이트웨이와 같은 호스트다(transcript-fs 머리말 — 그 배포는 로컬 구현). ──
  const look = (): void => {
    fs.stat(w.file, (err, st) => {
      if (err || !st.isFile()) return;
      grew(id, w, st.size);
    });
  };
  if (w.localTimer) clearInterval(w.localTimer);   // 앞선 시도가 이벤트 감시만 실패했을 수 있다(타이머만 남는다)
  try {
    //  폴더를 지켜보는 이유는 컨테이너 판과 같다 — 압축 롤오버로 파일이 갈려도 감시가 안 죽는다.
    w.local = fs.watch(path.dirname(w.file), () => look());
    w.local.on("error", () => {
      //  ⚠ 여기서 «못 민다» 만 알리고 끝내면 그 화면은 유예가 끝날 때까지 통보 없이 남는다.
      //   감시를 접고 처음부터 다시 건다 — 폴링이 안전망이라 그 사이에도 대화는 돈다.
      try { w.local?.close(); } catch { /* 이미 닫힘 */ }
      w.local = null;
      setLive(id, w, false, "watch-error");
      scheduleRetry(id, w);
    });
  } catch { /* 감시 불가 플랫폼 — 주기 관측만으로 돈다(그래도 통보는 간다) */ }
  w.localTimer = setInterval(look, LOOK_MS);
  setLive(id, w, true);
  look();
}

/**
 * 이 세션의 대화 파일 감시를 **한 참조 쥔다**. 반환값을 부르면 놓는다(마지막이면 유예 뒤 접힌다).
 *
 *  ⚠ 반드시 요청 컨텍스트 안에서 부른다 — 여기서 테넌트를 붙잡아 두고, 뒤늦은 재시도·재기동을
 *   그 컨텍스트 안에서 돌린다(`sessionSpawnArgv` 가 슬러그를 요구하고, 없으면 fail-closed 로 던진다).
 */
export function acquireTranscriptWatch(sessionId: string): () => void {
  let w = watches.get(sessionId);
  if (!w) {
    w = {
      refs: 0, tenant: currentTenant(), child: null, local: null, localTimer: null,
      retry: null, retryMs: RETRY_MIN_MS, linger: null, coalesce: null,
      sent: -1, live: false, onNode: null, file: "", uuid: "", stopped: false,
    };
    watches.set(sessionId, w);
  }
  const cur = w;
  cur.refs++;
  if (cur.linger) { clearTimeout(cur.linger); cur.linger = null; }
  cur.stopped = false;
  if (!cur.child && !cur.local && !cur.retry) inTenant(cur, () => { void start(sessionId, cur); });

  let released = false;
  return () => {
    if (released) return;                            // 같은 구독이 두 번 놓아도 남의 참조를 깎지 않는다
    released = true;
    cur.refs = Math.max(0, cur.refs - 1);
    if (cur.refs > 0) return;
    cur.linger = setTimeout(() => {
      cur.linger = null;
      if (cur.refs > 0) return;                      // 유예 중에 누가 다시 붙었다
      cur.stopped = true;
      //  ⚠ 접기 전에 live 를 내린다 — 안 그러면 `liveCount` 가 영영 안 줄어 «살아 있는 감시 수» 가 거짓말이 된다.
      setLive(sessionId, cur, false, "released");
      teardown(cur);
      watches.delete(sessionId);
    }, LINGER_MS);
  };
}

/** 붙잡아 둔 테넌트 컨텍스트 안에서 돌린다 — 재시도는 요청 밖에서 깨어난다. */
function inTenant(w: Watch, fn: () => void): void {
  if (!w.tenant) { fn(); return; }
  withTenant(w.tenant, fn);
}

/** 테스트 seam — 세션 하나의 감시를 통째로 접는다. */
export function resetTranscriptWatch(sessionId: string): void {
  const w = watches.get(sessionId);
  if (!w) return;
  w.stopped = true;
  if (w.linger) clearTimeout(w.linger);
  setLive(sessionId, w, false, "reset");   // 계수를 되돌린다(위 release 와 같은 이유)
  teardown(w);
  watches.delete(sessionId);
}
