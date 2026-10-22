// 노드 tmux **세대** — «이 tmux 명령을 어느 서버(소켓·바이너리)로 보내나» (#4931).
//
// ── 왜 세대인가 ──────────────────────────────────────────────────────────────────
//  판을 고정하면(terminal/mux-pin) 판을 바꾸는 날이 온다. tmux 서버는 뜰 때의 판으로 끝까지 돌고, 떠 있는 서버를 새 판으로
//  바꾸는 길은 서버를 죽이는 것뿐이다(= 그 PC 의 세션 전멸 — #209·#3545 가 실제로 그랬다). 그래서 **판마다 서버를 따로** 둔다:
//  소켓 이름에 판을 넣어(`tmux -L lively-mux-3.7c`) 판 ↔ 서버를 한 쌍으로 묶고, 떠 있는 서버는 옛 판으로 그 세션들이 끝날 때까지
//  두며, 새 세션만 새 판 서버에 띄운다. 기존 노드가 쓰던 기본 소켓(사람의 brew tmux)도 같은 방식의 «레거시 세대» 다 —
//  새 세션은 안 가고, 있던 세션만 끝까지 다룬다. 이렇게 하면 판 교체도 첫 이행도 세션을 하나도 끊지 않는다.
//  전용 소켓은 덤으로 사람의 개인 tmux(기본 소켓)와 우리 서버를 가른다 — 이 맥미니 기본 서버엔 노드 세션·olddev 게이트웨이
//  세션·사람의 개인 세션이 한 서버에 섞여 있었다(2026-10-20 실측).
//
// ── 판정 규율: 세션은 세대를 옮기지 않는다 ─────────────────────────────────────────
//  그래서 «X 는 어디 있나» 를 한 번 배우면(만들 때 · 세대가 답한 목록에서) 그 뒤 X 에 관한 답은 **X 의 세대 하나**가 낸다.
//  ★ 다른 세대의 상태로 X 를 판정하지 않는다 — 옛 서버 하나가 먹통이면 멀쩡한 세대의 세션까지 «모른다» 가 되고, 그러면
//   죽은 세션의 복원이 `already` 로 막힌다(#4917 이 17시간 겪은 그 모양). 단일 서버 시절엔 «다른 서버» 가 없어 없던 위험이다.
//  모르는 X(배우기 전)만 모든 세대에 묻고, 그때는 **모든 세대가 답했을 때만** «없다» 고 말한다(#835).
//
// ── 라우팅 ───────────────────────────────────────────────────────────────────────
//  · `new-session -s X` → 현재 세대(새 세션이 설 서버). 다른 세대에 살아 있다고 배운 X 면 tmux 문구 그대로 거절한다.
//  · 세션 지목(`-t X`) → X 의 세대. 모르면 현재 세대부터 `has-session` 으로 찾는다.
//  · 지목 없는 **목록** 동사(list-sessions·list-panes·…) → 모든 세대에 뿌려 이어 붙인다. 서버 없는 세대는 0행. 판정 불가인
//    세대는 직전 답(60초 이내)으로 메우고, 그것도 없으면 목록을 통째로 못 봤다고 던진다(#1251 — 한 세대만 빠진 목록은 그 세대
//    세션이 «죽었다» 로 읽힌다). 전부 서버 없음이면 서버 없음 오류(= 세션 0 — 단일 서버 시절과 같은 모양이라 소비자가 그대로 읽는다).
//  · 그 밖의 지목 없는 명령(`set-option -g default-terminal` 등) → 현재 세대.
//
// ⚠ **켜지는 자리는 노드(멤버 PC)뿐이다** — 노드 에이전트가 부팅에서 `configureMuxGenerations` 를 부를 때만 켜진다
//  (node/mux-install · exec-topology `nodeMuxGenerationsApply`). 게이트웨이·매니지드 세션 호스트(중계)·윈도우(psmux)는 꺼진 채라
//  tmux-exec 의 종전 경로가 한 바이트도 안 바뀐다.
// ⚠ 이 모듈은 tmux-exec 의 **아래**다(tmux-exec 가 이걸 부른다) — tmux-exec 를 import 하면 순환이 된다. 서버 부재·세션 없음
//  문구 판정은 그래서 여기가 정본이고 tmux-exec(`isNoTmuxServer`·`isSessionGoneError`)가 이걸 쓴다.
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmuxSessionOf, isServerWideList } from "./tmux-route.js";
import { MUX_SOCKET_PREFIX, muxSocketVersion, tmuxKnowsNoStartFlag } from "./mux-pin.js";

const execFileAsync = promisify(execFile);

/**
 * 옛 에이전트(세대를 모르는 번들)로 내려가도 되는지 자가 갱신이 확인하는 표식(#4931). 번들 안에 이 문자열이 있으면 세대를 안다.
 *  ⚠ 바꾸지 마라 — 판이 오르면 «/2» 를 **더하되** 이 값도 번들에 남겨야 옛 표식을 찾는 노드가 내려가기를 막지 않는다.
 */
export const MUX_GENERATIONS_MARK = "lively-mux-generations/1";

/** tmux 서버 하나 = 세대 하나. */
export interface MuxGeneration {
  /** 세대 이름 — 레거시는 `default`, 전용은 소켓 이름 그대로(`lively-mux-3.7c`). */
  key: string;
  /** `tmux -L` 소켓 이름 — null 이면 플래그를 안 붙인다(레거시 = 종전 그대로의 기본 소켓). */
  socket: string | null;
  /** 이 세대에 말할 실행 파일. */
  bin: string;
  /** 이 바이너리가 `-N`(서버를 새로 띄우지 않는다)을 아나 — attach 에 붙인다(#4605 소켓 탈취 방지). */
  noStart: boolean;
}

/** 노드 에이전트가 부팅에서 정하는 세대 구성. */
export interface MuxSetup {
  /** 새 세션이 설 세대. */
  current: MuxGeneration;
  /** 종전 기본 소켓 — 새 세션은 안 가고, 있던 세션만 다룬다. `LIVELY_MUX_PIN=off` 면 current 와 같은 것이다. */
  legacy: MuxGeneration;
  /** tmux 소켓 디렉터리 — 지난 전용 세대를 여기서 찾는다(node/mux-install `muxSocketDir` — tmux 와 같은 규칙). */
  socketDir: string;
  /** 지난 전용 세대(판)에 말할 바이너리 — 없으면 null(현재 세대 바이너리로 말한다. 클라이언트-서버 프로토콜이 같다 — 실측 3.6a↔3.7c). */
  binFor: (version: string) => string | null;
}

/** 세대별 마지막 목록 답 — 신원 파일 걷기·기억 정리가 «그 세대가 답했나» 를 본다. */
type Answer = { kind: "ok" | "absent" | "unknown"; at: number; since: number };

interface MuxState {
  setup: MuxSetup | null;
  /** 세션 id → 세대 key. 만들 때와 세대가 답한 목록에서 배운다(프로세스 수명). */
  where: Map<string, string>;
  answers: Map<string, Answer>;
  /** (세대 key + argv) → 마지막 성공 목록 — 판정 불가 세대를 잠깐 메우는 데만 쓴다. */
  lastList: Map<string, { stdout: string; at: number }>;
}

const state: MuxState = { setup: null, where: new Map(), answers: new Map(), lastList: new Map() };
const WHERE_MAX = 5_000;            // 기억이 끝없이 크지 않게 — 넘치면 비우고 다시 배운다(찾기 한 번씩이면 된다)
/** 판정 불가 세대를 직전 목록으로 메울 수 있는 나이 — 그보다 오래 모르면 «못 봤다» 를 드러낸다. */
export const MUX_STALE_LIST_MS = 60_000;
/** 이만큼 서버가 없던 세대의 기억은 지운다(그 세대 세션의 신원 파일도 그때부터 걷힌다). */
export const MUX_ABSENT_FORGET_MS = 10 * 60_000;

/** 노드 에이전트 부팅에서 한 번(고정판을 나중에 얻으면 한 번 더). null 이면 끈다 — tmux-exec 가 종전 경로로 돈다. */
export function configureMuxGenerations(s: MuxSetup | null): void {
  //  현재 세대만 바뀌는 재구성(고정판을 늦게 얻었다)에선 배운 것을 지우지 않는다 — 세션은 세대를 옮기지 않는다.
  if (!s) { state.where.clear(); state.answers.clear(); state.lastList.clear(); }
  state.setup = s;
}
export function muxGenerationsActive(): boolean { return state.setup !== null; }
export function muxSetup(): MuxSetup | null { return state.setup; }
/** 시험 전용 — 배운 것까지 전부 비운다. */
export function resetMuxGenerationsForTest(): void { configureMuxGenerations(null); }

/** 이 세대로 보낼 tmux 서버 옵션 — `-L <소켓>` 이거나 없음(레거시). */
export function generationFlags(g: MuxGeneration): string[] {
  return g.socket ? ["-L", g.socket] : [];
}

// ── 문구 판정(정본) ─────────────────────────────────────────────────────────────
//  ⚠ tmux-exec 의 `isNoTmuxServer`·`isSessionGoneError` 가 같은 자를 쓴다 — 여기서 고치면 거기도 바뀐다(두 벌 금지).
const NO_SERVER_RE = /no server running|error connecting/i;
const NO_SUCH_SESSION_RE = /can't find session|session not found/i;
/**
 * «서버가 없다» 의 **확답** — 스테일 소켓("no server running" = ECONNREFUSED) · 소켓 파일 없음(ENOENT). 그 밖의 접속 오류(권한 등)는
 *  확답이 아니다. ⚠ 목록의 «세션 0» 자(NO_SERVER_RE)보다 좁다 — gone 은 화면의 자동 복원으로 이어지는 파괴적 판정이라 종전 노드
 *  판정(tmux-exec `isTmuxServerAbsentError`)·관리형 중계 판정이 쓰던 자를 그대로 쓴다. tmux-exec 가 이 정의를 가져다 쓴다(두 벌 금지).
 */
export const TMUX_SERVER_GONE_RE = /\bno server running\b|error connecting to .+\((?:No such file or directory|Connection refused)\)/i;
function stderrOf(e: unknown): string { return String((e as { stderr?: unknown })?.stderr ?? ""); }
function answered(e: unknown): boolean {
  const x = e as { killed?: boolean; signal?: string | null } | null;
  return !!x && typeof x === "object" && !x.killed && !x.signal;   // 타임아웃·시그널로 끝난 호출은 tmux 의 답이 아니다
}
/** tmux 가 «이 소켓엔 서버가 없다» 고 답했나(스테일 소켓 · 소켓 파일 없음). 목록에선 «세션 0» 이다. */
export function muxServerAbsent(e: unknown): boolean { return NO_SERVER_RE.test(stderrOf(e)); }
/** tmux 가 «그런 세션 없다» 고 답했나. */
export function muxNoSuchSession(e: unknown): boolean { return answered(e) && NO_SUCH_SESSION_RE.test(stderrOf(e)); }
function absentAnswer(e: unknown): boolean { return answered(e) && muxServerAbsent(e); }
/** 확답으로 «서버 없음»(TMUX_SERVER_GONE_RE) — 세션 찾기·gone 판정용. */
function goneServer(e: unknown): boolean { return answered(e) && TMUX_SERVER_GONE_RE.test(stderrOf(e)); }

function tmuxError(stderr: string): Error {
  const e = new Error(`tmux exited 1: ${stderr}`) as Error & { code: number; stdout: string; stderr: string };
  e.code = 1; e.stdout = ""; e.stderr = `${stderr}\n`;
  return e;
}

/**
 * 지금 살아 있을 수 있는 세대들 — **현재 세대가 맨 앞**, 그다음 레거시, 그다음 소켓 디렉터리의 지난 전용 세대(이름순).
 *  ⚠ 소켓 **파일**이 있다고 서버가 있는 것은 아니다(tmux 는 끝날 때 소켓 파일을 남긴다 — 실측). 서버가 없으면 호출이
 *   "no server running" 으로 곧바로 끝나고, 아래 규칙이 그걸 «세션 0» 으로 접는다.
 */
export function liveGenerations(s: MuxSetup | null = state.setup): MuxGeneration[] {
  if (!s) return [];
  const out: MuxGeneration[] = [s.current];
  const add = (g: MuxGeneration): void => { if (!out.some((x) => x.key === g.key)) out.push(g); };
  add(s.legacy);
  for (const name of muxSocketsIn(s.socketDir)) {
    const v = muxSocketVersion(name);
    if (!v) continue;
    //  `-N` 은 **클라이언트** 쪽 옵션이다 — 그 판의 바이너리로 말하면 그 판이 아는지, 현재 바이너리로 말하면 현재 판이 아는지다.
    const own = s.binFor(v);
    add({ key: name, socket: name, bin: own ?? s.current.bin, noStart: own ? tmuxKnowsNoStartFlag(v) : s.current.noStart });
  }
  return out;
}

/** 소켓 디렉터리의 우리 소켓 이름들(이름순). 못 읽으면 빈 목록 — 현재·레거시 세대는 그래도 남는다. */
export function muxSocketsIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name.startsWith(MUX_SOCKET_PREFIX) && e.isSocket())
      .map((e) => e.name).sort();
  } catch { return []; }
}

/** 실행기 — 이 세대에 이 tmux argv 를 보내 stdout 을 받는다. 실패는 execFile 오류(code·stdout·stderr)로 던진다. */
export type MuxRun = (g: MuxGeneration, args: readonly string[]) => Promise<string>;

export interface MuxRouteDeps {
  /** 이번 호출이 볼 세대들 — 맨 앞이 현재 세대(liveGenerations). */
  gens: readonly MuxGeneration[];
  run: MuxRun;
  /** 배운 것(시험은 자기 상태를 넘긴다). */
  state: Pick<MuxState, "where" | "answers" | "lastList">;
  now?: () => number;
}

/** (순수 — 넘겨받은 상태만 쓴다) 이 tmux argv 를 세대 규칙대로 실행한다. 머리말의 «라우팅» 그대로. */
export async function routeTmux(args: readonly string[], d: MuxRouteDeps): Promise<string> {
  const current = d.gens[0];
  if (!current) throw tmuxError("no server running (세대 없음)");
  const { verb, ref } = tmuxSessionOf(args);
  const sid = ref.kind === "session" ? ref.sid : ref.kind === "unparsed" ? sessionPartOf(args) : null;
  if (sid) {
    if (verb === "new-session" || verb === "new") return createOn(current, sid, args, d);
    const known = recordedGen(sid, d);
    if (known) return runOn(known, sid, args, d);
    const found = await locate(sid, d);
    if ("err" in found) throw found.err;
    if (verb === "has-session" || verb === "has") return "";   // 찾기가 곧 그 답이었다
    return runOn(found.g, sid, args, d);
  }
  if (isServerWideList(verb, ref)) return fanout(args, d);
  return d.run(current, args);
}

/**
 * `-t box-x:0.1` · `-t =box-x` 처럼 세션 이름 뒤(앞)에 창·판 지목이 붙은 대상에서 세션 이름만 — 없으면 null.
 *  tmux-route 의 파서는 그런 값을 «형식 밖» 으로 두는데(브로커와 같은 답을 내야 하는 자리라 그대로 둔다), 세대 선택은 세션만
 *  알면 된다. ⚠ `%3`(판 id)·`@1`(창 id)은 서버마다 번호가 따로라 어느 세대인지 알 수 없다 → null(현재 세대로 간다).
 */
function sessionPartOf(args: readonly string[]): string | null {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "-t" && args[i] !== "-s") continue;
    const m = /^=?([a-z0-9][a-z0-9_-]{0,62})(?:[:.].*)?$/.exec(args[i + 1]!);
    if (m) return m[1]!;
  }
  return null;
}

function recordedGen(sid: string, d: MuxRouteDeps): MuxGeneration | null {
  const key = d.state.where.get(sid);
  return key ? d.gens.find((g) => g.key === key) ?? null : null;
}
function remember(d: MuxRouteDeps, sid: string, g: MuxGeneration): void {
  if (d.state.where.size >= WHERE_MAX) d.state.where.clear();
  d.state.where.set(sid, g.key);
}

async function runOn(g: MuxGeneration, sid: string, args: readonly string[], d: MuxRouteDeps): Promise<string> {
  try { return await d.run(g, args); }
  catch (e) {
    //  그 세대가 «그런 세션 없다» 고 답했으면 끝난 것이다(세션은 세대를 옮기지 않는다). 기억만 지우고 답은 그대로 올린다.
    //  ⚠ «서버 없음» 으로는 지우지 않는다 — 과부하의 연결 거부도 같은 문구다(#4605). 끝남 확답은 gone 판정(muxGoneOnNode)이 한 번 더 재서 낸다.
    if (muxNoSuchSession(e)) d.state.where.delete(sid);
    throw e;
  }
}

/** 이 세션이 어느 세대에 있나 — 현재 세대부터 차례로 `has-session`. 못 찾으면 «확답만» 낸다(머리말). */
async function locate(sid: string, d: MuxRouteDeps): Promise<{ g: MuxGeneration } | { err: unknown }> {
  let noSuch: unknown = null, absent: unknown = null, unknown: unknown = null;
  for (const g of d.gens) {
    try { await d.run(g, ["has-session", "-t", sid]); remember(d, sid, g); return { g }; }
    catch (e) {
      if (muxNoSuchSession(e)) noSuch ??= e;
      else if (goneServer(e)) absent ??= e;
      else unknown ??= e;   // 권한 같은 접속 오류도 여기 — 그 세대에 그 세션이 있을 수 있다
    }
  }
  //  ★ 순서가 판정이다 — 한 세대라도 못 봤으면 그 세션이 거기 있을 수 있다. «없다» 는 모든 세대가 답했을 때만이다.
  return { err: unknown ?? noSuch ?? absent ?? tmuxError("no server running") };
}

async function createOn(current: MuxGeneration, sid: string, args: readonly string[], d: MuxRouteDeps): Promise<string> {
  //  다른 세대에 **살아 있다고 배운** id 면 세우지 않는다(한 서버 안이었다면 tmux 자신이 했을 거절). 묻지는 않는다 —
  //   노드 세션 id 는 게이트웨이가 무작위로 정하고 노드 복원은 새 id 를 쓰므로(실측 확인), 확인 왕복은 생성만 느리게 한다.
  const known = recordedGen(sid, d);
  if (known && known.key !== current.key && d.state.answers.get(known.key)?.kind === "ok") throw tmuxError(`duplicate session: ${sid}`);
  const out = await d.run(current, args);
  remember(d, sid, current);
  return out;
}

async function fanout(args: readonly string[], d: MuxRouteDeps): Promise<string> {
  const now = (d.now ?? Date.now)();
  const parts = await Promise.all(d.gens.map((g) => d.run(g, args).then(
    (stdout) => ({ g, ok: true as const, stdout }),
    (err: unknown) => ({ g, ok: false as const, err }),
  )));
  const argKey = args.join("\u0000");
  const learn = learnsNames(args);
  const seen = new Set<string>();   // 답한 세대들의 세션 이름(배우기·잊기용)
  let out = "";
  let rows = false;
  let absent: unknown = null;
  for (const p of parts) {
    const cacheKey = `${p.g.key}\u0000${argKey}`;
    let stdout: string;
    if (p.ok) {
      stdout = p.stdout;
      d.state.lastList.set(cacheKey, { stdout, at: now });
      if (learn) mark(d, p.g, "ok", now);
    } else if (absentAnswer(p.err)) {
      d.state.lastList.delete(cacheKey);
      if (learn) mark(d, p.g, "absent", now);
      absent ??= p.err;
      continue;
    } else {
      //  판정 불가 — 직전 답이 신선하면 그걸로 메운다(그 세대 세션을 «죽었다» 로 보이지 않게). 아니면 목록을 통째로 못 봤다(#1251).
      if (learn) mark(d, p.g, "unknown", now);
      const last = d.state.lastList.get(cacheKey);
      if (!last || now - last.at > MUX_STALE_LIST_MS) throw p.err;
      stdout = last.stdout;
    }
    rows = true;
    if (stdout) out += stdout.endsWith("\n") ? stdout : `${stdout}\n`;
    if (learn && p.ok) {
      for (const line of stdout.split("\n")) { const n = line.split("\t")[0]!.trim(); if (n) { remember(d, n, p.g); seen.add(n); } }
    }
  }
  if (!rows) throw absent ?? tmuxError("no server running");   // 전부 서버 없음 = 세션 0 확답(단일 서버 시절의 그 오류 그대로)
  if (learn) forgetEnded(d, parts.filter((p) => p.ok).map((p) => p.g.key), seen, now);
  return out;
}

function mark(d: MuxRouteDeps, g: MuxGeneration, kind: Answer["kind"], now: number): void {
  const prev = d.state.answers.get(g.key);
  d.state.answers.set(g.key, { kind, at: now, since: prev && prev.kind === kind ? prev.since : now });
}

/**
 * 답한 세대의 목록에 없는 기억은 지운다(그 세션은 끝났다). 서버가 오래(MUX_ABSENT_FORGET_MS) 없던 세대의 기억도 지운다.
 *  ⚠ 잠깐 «서버 없음» 인 세대의 기억은 남긴다 — 연결 거부(과부하)도 같은 문구라 그 세대 세션이 살아 있을 수 있다(#4605).
 */
function forgetEnded(d: MuxRouteDeps, okKeys: readonly string[], seen: ReadonlySet<string>, now: number): void {
  const ok = new Set(okKeys);
  for (const [sid, key] of d.state.where) {
    if (ok.has(key) && !seen.has(sid)) { d.state.where.delete(sid); continue; }
    const a = d.state.answers.get(key);
    if (a && a.kind === "absent" && now - a.since > MUX_ABSENT_FORGET_MS) d.state.where.delete(sid);
  }
}

/** `list-sessions -F "#{session_name}…"` 처럼 줄머리가 세션 이름인 목록이면 그걸로 기억을 배운다. */
function learnsNames(args: readonly string[]): boolean {
  const { verb } = tmuxSessionOf(args);
  if (verb !== "list-sessions" && verb !== "ls") return false;
  const i = args.indexOf("-F");
  return i >= 0 && String(args[i + 1] ?? "").startsWith("#{session_name}");
}

/**
 * (순수) 노드의 «gone» 답 — **그 세션의 세대 하나**로 판정한다(머리말 «판정 규율»). true 끝남 · false 살아 있음(모름 포함 — 종전 접기).
 *  · 배운 세대가 있으면: has-session 성공 → false · «그런 세션 없다» → true · «서버 없음» → 그 세대에 list 로 한 번 더 물어 또 없으면 true
 *    (#4917 의 이중 확인을 세대 하나로 좁힌 것 — 다른 세대가 살아 있다고 «서버가 있다» 로 읽지 않는다) · 그 밖 → false.
 *  · 모르는 세션이면: 모든 세대에 묻는다 — 어디서든 찾으면 false · 모든 세대가 «없다/서버 없음» 이면 true · 하나라도 모르면 false.
 */
export async function goneByGeneration(sid: string, d: MuxRouteDeps): Promise<boolean> {
  const g = recordedGen(sid, d);
  if (g) {
    try { await d.run(g, ["has-session", "-t", sid]); return false; }
    catch (e) {
      if (muxNoSuchSession(e)) { d.state.where.delete(sid); return true; }
      if (!goneServer(e)) return false;
      try { await d.run(g, ["list-sessions", "-F", "#{session_name}"]); return false; }   // 서버는 있다 — 일시 거절이었다
      catch (e2) { return goneServer(e2); }
    }
  }
  const found = await locate(sid, d);
  if ("g" in found) return false;
  return muxNoSuchSession(found.err) || goneServer(found.err);
}

// ── 프로덕션 배선 ───────────────────────────────────────────────────────────────

/**
 * tmux 클라이언트에 넘길 env — 부르는 쪽 env 에서 셋을 뺀다.
 *  · `LIVELY_NODE_TOKEN` — 전용 세대 서버는 언제나 에이전트가 `new-session` 으로 띄우고, tmux 서버는 처음 띄운 클라이언트의 env 를
 *    전역으로 굳혀 **모든 새 판(pane)에 물려준다**. 그대로 두면 노드 토큰이 모든 세션의 AI 에게 보인다(맥미니 기본 서버 실측: 이미 들어 있었다).
 *  · `TMUX`·`TMUX_PANE` — 레거시 세대(플래그 없음)는 `$TMUX` 를 따라간다(`-L` 만 그걸 이긴다 — 실측). 노드를 tmux 판 안에서 띄우면
 *    레거시가 기본 소켓이 아니라 그 판의 서버가 된다.
 */
const clientEnvCache = new WeakMap<NodeJS.ProcessEnv, NodeJS.ProcessEnv>();
export function muxClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let out = clientEnvCache.get(env);
  if (!out) {
    out = { ...env };
    delete out.LIVELY_NODE_TOKEN; delete out.TMUX; delete out.TMUX_PANE;
    clientEnvCache.set(env, out);
  }
  return out;
}

function productionRun(opts: { timeoutMs: number; env: NodeJS.ProcessEnv }): MuxRun {
  const env = muxClientEnv(opts.env);
  return async (g, a) => {
    const call = (bin: string) => execFileAsync(bin, [...generationFlags(g), ...a], { timeout: opts.timeoutMs, env }).then((r) => r.stdout);
    try { return await call(g.bin); }
    catch (e) {
      //  그 세대 바이너리가 사라졌다(brew 제거·판별 폴더 정리) — 현재 세대 바이너리로 다시 말한다(클라이언트-서버 프로토콜이 같다).
      //   안 그러면 «실행 실패» 가 판정 불가로 읽혀 그 세대 세션이 영영 «모른다» 가 된다.
      const code = (e as { code?: unknown })?.code;
      const cur = state.setup?.current.bin;
      if ((code === "ENOENT" || code === "EACCES") && cur && cur !== g.bin) return call(cur);
      throw e;
    }
  };
}
function productionDeps(opts: { timeoutMs: number; env: NodeJS.ProcessEnv }): MuxRouteDeps {
  return { gens: liveGenerations(), run: productionRun(opts), state };
}

/** 세대 규칙으로 tmux 를 부른다 — 노드에서 tmux-exec·node/tasks 가 이걸 탄다. env·상한은 부르는 쪽 규약 그대로 받는다. */
export async function muxTmux(args: readonly string[], opts: { timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<string> {
  return routeTmux(args, productionDeps(opts));
}

/** 노드의 gone 답(세대판) — tmux-exec `sessionGoneOnNode` 가 세대가 켜져 있을 때 이걸 쓴다. */
export async function muxGoneOnNode(sid: string, opts: { timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<boolean> {
  return goneByGeneration(sid, productionDeps(opts));
}

/**
 * attach 를 띄울 접두 — `[bin, -L 소켓, -N]` 와 그 env. 세대 구성이 꺼져 있으면 null(종전 경로).
 *  세션을 어느 세대에서도 못 찾으면 현재 세대로 붙는다 — 거기서 tmux 가 «없다» 고 답하고 종전처럼 닫힌다. `-N` 이 있어
 *  그 실패가 빈 서버를 띄우지 않는다(#4605 — 연결 거부 한 번에 attach 가 소켓을 갈아치운 사고).
 */
export async function muxAttachPrefix(id: string, opts: { timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<{ argv: string[]; env: NodeJS.ProcessEnv } | null> {
  if (!state.setup) return null;
  const d = productionDeps(opts);
  let g = recordedGen(id, d);
  if (!g) { const found = await locate(id, d); g = "g" in found ? found.g : d.gens[0]!; }
  return { argv: [g.bin, ...generationFlags(g), ...(g.noStart ? ["-N"] : [])], env: muxClientEnv(opts.env) };
}

/**
 * 신원 파일 걷기(#4135)가 지우면 안 되는 세션 — **그 세대가 지난 목록에 답하지 못한**(서버 없음·판정 불가) 세션들.
 *  목록이 세대별로 빠질 수 있게 되면서 «빈 목록이면 안 걷는다» 가드만으론 모자라다: 한 세대가 잠깐 연결을 거부하면 그 세대
 *  세션만 목록에서 빠지고 목록은 비지 않는다. 오래(MUX_ABSENT_FORGET_MS) 없던 세대의 기억은 fanout 이 지우므로 여기서도 빠진다.
 */
export function muxUnansweredSessionIds(): Set<string> {
  const out = new Set<string>();
  for (const [sid, key] of state.where) {
    const a = state.answers.get(key);
    if (a && a.kind !== "ok") out.add(sid);
  }
  return out;
}

/** 전용 세대에 살아 있는 세션이 있나(옛 번들로 내려가기 전 확인). 모르면 «있다» — 내려가지 않는 쪽이 안전하다. */
export async function muxDedicatedSessionsAlive(opts: { timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<boolean> {
  if (!state.setup) return false;
  const run = productionRun(opts);
  for (const g of liveGenerations()) {
    if (!g.socket) continue;
    try { if ((await run(g, ["list-sessions", "-F", "#{session_name}"])).split("\n").some((l) => l.startsWith("box-"))) return true; }
    catch (e) { if (!goneServer(e)) return true; }
  }
  return false;
}

/**
 * 부팅 빈 서버 정리(#869)의 세대판 — **전용 세대**와, 레거시가 현재 세대일 때(off·고정판 대기)의 레거시만 본다.
 *  레거시가 현재 세대가 아니면 기본 소켓은 이제 사람의 개인 tmux 이거나 남의 게이트웨이 서버일 수 있어(맥미니 실측) 안 죽인다.
 *  정리 규약은 종전 그대로: tmux 가 **답해서** 세션이 0 일 때만(못 봤다 ≠ 비었다).
 * @returns 죽인 세대 key
 */
export async function killEmptyMuxServers(opts: { timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<string[]> {
  const s = state.setup;
  if (!s) return [];
  const run = productionRun(opts);
  const killed: string[] = [];
  for (const g of liveGenerations()) {
    if (!g.socket && g.key !== s.current.key) continue;
    let raw: string;
    try { raw = await run(g, ["list-sessions", "-F", "#{session_name}"]); }
    catch { continue; }   // 서버 없음이면 할 일이 없고, 그 밖의 실패는 못 본 것이다 — 어느 쪽도 죽이지 않는다
    if (raw.split("\n").some((l) => l.trim() !== "")) continue;
    try { await run(g, ["kill-server"]); killed.push(g.key); } catch { /* 이미 끝났다 */ }
  }
  return killed;
}
