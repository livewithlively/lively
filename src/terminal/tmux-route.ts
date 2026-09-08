// tmux 해석기 — «이 tmux 호출을 어느 세션 컨테이너에서, 어떻게 돌리나» (#2600 T2 (d) d2). **순수** — 런타임 import 0.
//
// ⚠ `session-ops.ts`(T1 #2606 — attach 소유 살림: create/kill/attach/sendKeys)와 **다른 모듈**이다. 그쪽은 «세션 op 를 누가
//  소유하나», 여기는 «tmux argv 하나가 어느 컨테이너로 가나» 다(브로커 `resolveTmuxTarget`·`runTmuxFanout` 의 자리).
//
// ── 무엇을 옮겨 왔나 ────────────────────────────────────────────────────────────
// 매니지드 브로커의 `/lvly/tmux` 가 하던 일이다: argv 를 tmux 처럼 읽어 «어느 세션인가» 를 뽑고(`tmuxSessionOf`),
//  세션 지목이 있으면 그 세션 컨테이너 하나로, 지목 없는 **목록** 동사면 세션 컨테이너 전부로 뿌려 합치고(팬아웃·병합),
//  갈 곳이 없으면 tmux 자신의 확답 문구(`can't find session` · `no server running`)를 합성한다. 코어의 소비자
//  (`isSessionGoneError`·`isNoTmuxServer`)가 **그 문구**를 읽어 «끝났다»·«세션 0» 을 확정하므로 문구는 바이트 단위로 같아야 한다.
//
// ── 왜 코어로 ─────────────────────────────────────────────────────────────────
// 세션을 소유하는 프로세스가 한 벌이어야 한다(프로젝트 #2600). 브로커에 남는 것은 컨테이너 배관(ensure·회수·자원)뿐이고,
//  «세션 의미» 는 그 세션을 소유하는 코어(세션 호스트)가 갖는다. 이 모듈은 그 의미를 **전송과 떼어** 든다 — 실제 목록은
//  `GET /lvly/sessions`(d1) 가, 실행은 범용 exec API 가 하고(broker-client), 여기는 «무엇을 어디로» 만 정한다.
//
// ⚠ **플래그 뒤**다(exec-topology `tmuxRoute` — `LIVELY_TMUX_ROUTE`). 켜지 않으면 이 모듈은 불리지 않는다 — 옛 경로(중계 → `/lvly/tmux`)가
//  한 바이트도 안 바뀐다. 켜는 것은 d3(그림자 대조)의 일이다.
// ⚠ 브로커의 순수 함수(`sessionbroker.ts` 의 tmuxSessionOf·isServerWideList·mergeTmuxFanout…)와 **같은 답**을 내야 한다 —
//  d3 이 두 답을 견준다. 둘째 사본이 잠시 생기는 것은 설계된 이행이고, d4 가 브로커 것을 지운다.

/** 브로커와 같은 세션 이름 규격 — argv 에서 뽑은 값이 이걸 못 지나면 «형식 밖»(가지 않는다). */
const SAFE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** 어느 세션인가 — 파싱 결과. */
export type TmuxSessionRef =
  | { kind: "session"; sid: string }
  | { kind: "none" }                        // 지목 없음(list-sessions·kill-server…) — 서버 전체 명령
  | { kind: "unparsed"; why: string };      // 지목은 있는데 세션 이름 형식이 아니다

/** 동사 앞에서 값을 하나 먹는 tmux 서버 옵션. */
const TMUX_SERVER_OPTS_WITH_VALUE = new Set(["-c", "-f", "-L", "-S", "-T"]);

/**
 * tmux argv 에서 동사와 세션 지목을 읽는다(순수) — 브로커 `tmuxSessionOf` 와 같은 규칙.
 *  ① 서버 옵션(`-L x`·`-f /dev/null`…)을 건너뛰어 첫 비옵션 인자가 동사다.
 *  ② new-session·detach-client 는 `-s` 가 세션, 나머지는 `-t`. 붙여 쓴 `-t<sid>` 도 읽는다. 마지막 것이 이긴다(tmux args_get).
 *  ③ 그 밖의 플래그는 값을 안 먹는 것으로 본다 — `set-option -t <sid> @box_label "라벨 -t 는 값"` 처럼 옵션 구간이 끝난 뒤의
 *     `-t` 는 안 본다(첫 비옵션에서 멈춘다).
 */
export function tmuxSessionOf(args: readonly string[]): { verb: string | null; ref: TmuxSessionRef } {
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (!a.startsWith("-") || a === "-") break;
    if (a === "--") { i++; break; }
    i += TMUX_SERVER_OPTS_WITH_VALUE.has(a) ? 2 : 1;
  }
  const verb = i < args.length ? args[i]! : null;
  if (verb === null) return { verb, ref: { kind: "none" } };
  const flag = verb === "new-session" || verb === "new" || verb === "detach-client" || verb === "detach" ? "-s" : "-t";
  let value: string | null = null;
  for (let j = i + 1; j < args.length; j++) {
    const a = args[j]!;
    if (a === "--" || !a.startsWith("-") || a === "-") break;
    if (a === flag) {
      if (j + 1 >= args.length) return { verb, ref: { kind: "unparsed", why: `${flag} 뒤에 값이 없다` } };
      value = args[++j]!;
    } else if (a.startsWith(flag)) {
      value = a.slice(flag.length);
    }
  }
  if (value === null) return { verb, ref: { kind: "none" } };
  if (!SAFE.test(value)) return { verb, ref: { kind: "unparsed", why: `세션 이름 형식이 아니다: ${JSON.stringify(value.slice(0, 64))}` } };
  return { verb, ref: { kind: "session", sid: value } };
}

/**
 * 서버 전체 **목록** 동사 — 세션 컨테이너 전부에 팬아웃해 합친다. 코어가 실제로 보내는 것은 `list-sessions -F`(목록 정본·장부)와
 *  `list-panes -a`(회수·OOM 귀속)다. 서버 전역 **쓰기**(kill-server·set-option -g)는 세션 지목이 없어 갈 곳이 없다 —
 *  세션 서버는 `-f /dev/null` 로 뜨고 코어가 필요한 옵션은 `-t <sid>` 로 세션마다 건다(브로커와 같은 답: gone).
 */
export const SERVER_WIDE_LIST_VERBS: ReadonlySet<string> = new Set([
  "list-sessions", "ls", "list-panes", "lsp", "list-windows", "lsw", "list-clients", "lsc",
]);
export function isServerWideList(verb: string | null, ref: TmuxSessionRef): boolean {
  return ref.kind === "none" && verb !== null && SERVER_WIDE_LIST_VERBS.has(verb);
}

/** `GET /lvly/sessions` 의 한 줄(d1) — 여기서 쓰는 칸만. */
export interface SessionRow {
  sid: string;
  container: string;
  /** 번들에 «tmux 안쪽» 표식이 있나 — 팬아웃 대상은 참인 것뿐이다(옛 경로 잔재를 가른다). */
  inside: boolean;
}

/** 세션 컨테이너 이름 — 브로커 `sessionContainerName` 과 같은 규칙. 슬러그·sid 가 형식 밖이면 던진다(조용히 다른 이름을 만들지 않는다). */
export function sessionContainerName(slug: string, sid: string): string {
  if (!SAFE.test(slug)) throw new Error(`잘못된 테넌트 slug: ${slug}`);
  if (!SAFE.test(sid)) throw new Error(`잘못된 세션 id: ${sid}`);
  return `lvly-s-${slug}-${sid}`;
}

/** 이 호출을 어떻게 돌리나 — 계획. */
export type TmuxPlan =
  /** ★ 목록을 못 봤고(observed:false) 아는 세션도 0 인데 세션을 지목했다 — «없다» 로 확정하지 않는다(#835). */
  | { kind: "unobserved" }
  /** 세션 지목이 있고 그 세션 컨테이너가 있다 — 거기 한 번. */
  | { kind: "one"; sid: string; container: string; verb: string | null }
  /** 지목 없는 목록 동사 — 표식 있는 세션 컨테이너 전부(sid 순)에 뿌려 합친다. */
  | { kind: "fanout"; containers: string[]; verb: string | null }
  /** 갈 곳이 없다 — 지목한 세션이 없거나(이미 회수됨·옛 경로), 지목 없는 비-목록 동사, 형식 밖. tmux 확답 문구를 합성한다. */
  | { kind: "gone"; sid: string | null; container: string | null; verb: string | null };

/**
 * 계획(순수) — 브로커 `resolveTmuxTarget` + `isServerWideList` 분기와 같은 답.
 *  ⚠ 목록(`sessions`)은 **이 노드가 아는 것**이다(d1 은 다른 노드 것을 담지 않는다). 오늘의 `/lvly/tmux` 팬아웃도 로컬만이라
 *   동작이 같다 — 그림자 대조가 성립하는 근거다.
 */
export function planTmux(slug: string, args: readonly string[], sessions: ReadonlyArray<SessionRow>, observed = true): TmuxPlan {
  const { verb, ref } = tmuxSessionOf(args);
  if (ref.kind === "session") {
    //  단일 지목도 팬아웃과 같은 규율: 목록을 통째로 못 봤고 아는 세션이 하나도 없으면 «그 세션이 없다» 고 답할 근거가 없다.
    //   (아는 세션이 있으면 그 목록으로 답한다 — 브로커 색인 규율과 같다.) 블라인드 리뷰 지적 ⑥-3.
    if (!observed && sessions.length === 0) return { kind: "unobserved" };
    const hit = sessions.find((s) => s.sid === ref.sid && s.inside);
    if (hit) return { kind: "one", sid: ref.sid, container: hit.container, verb };
    //  «있었을 자리» — 로그·문구용. sid 는 SAFE 를 지났다.
    return { kind: "gone", sid: ref.sid, container: sessionContainerName(slug, ref.sid), verb };
  }
  if (isServerWideList(verb, ref)) {
    const containers = sessions.filter((s) => s.inside).map((s) => ({ sid: s.sid, c: s.container }))
      .sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0)).map((x) => x.c);
    return { kind: "fanout", containers, verb };
  }
  return { kind: "gone", sid: null, container: null, verb };
}

/** 한 번의 tmux 실행 결과 — 코어 `tmux()` 의 execFile 규약과 같은 세 칸. `gone` 은 «그 컨테이너가 없다» 의 표식(병합이 0행으로 접는다). */
export interface TmuxOutcome { code: number; stdout: string; stderr: string; gone?: boolean }

/**
 * 컨테이너가 사라진 세션에 대한 답(순수) — tmux 자신의 확답 문구로 낸다. 코어 `isSessionGoneError` 가 `can't find session` 을
 *  읽어 «끝났다» 로 확정한다. ⚠ «no server running» 류로 위장하지 않는다 — 그건 서버(테넌트 전체) 부재의 뜻이다.
 */
export function sessionGoneResult(sid: string | null, container: string | null): TmuxOutcome {
  return { code: 1, stdout: "", stderr: `can't find session: ${sid ?? "?"} (session container ${container ?? "(없음)"} is gone)`, gone: true };
}

/** tmux 자신의 «서버 없음» 확답 — 세션 컨테이너가 하나도 없는 테넌트의 서버 전체 목록 답. 코어 `isNoTmuxServer` 가 «세션 0» 으로 읽는다. */
export const TMUX_NO_SERVER: TmuxOutcome = { code: 1, stdout: "", stderr: "no server running" };

/**
 * ★ «못 봤다» 의 답 — 목록 조회가 비관측(`observed:false`)이고 아는 세션도 0 일 때. 브로커는 이 자리에서 `no server running`
 *  을 냈지만(색인이 비었으니), 그 문구는 코어가 «세션 0 확답» 으로 읽어 `killEmptyTmuxServer` 가 서버를 죽이고 목록이
 *  «복원 가능» 으로 그려진다 — 2026-09-03 장애의 모양이다. 여기는 그 문구를 **안 쓴다**: `isNoTmuxServer` 가 거짓이라
 *  strict 호출은 던지고 목록은 desired 폴백으로 간다(#2616 · #835 «모르면 없다고 말하지 않는다»).
 *  ⚠ 그림자 대조에서 이 자리는 브로커와 **의도적으로** 다르다 — 설명되는 불일치다(d3 이 그 이유로 통과시킨다).
 */
export const TMUX_UNOBSERVED: TmuxOutcome = { code: 1, stdout: "", stderr: "세션 목록을 못 봤다(observed:false) — «세션 0» 이 아니다" };

/** runsc exec 이 «그 컨테이너가 없다/안 돈다» 로 실패한 문구 — 브로커 `RUNSC_EXEC_GONE_RE` 와 같다. exec 의 stderr 에 그대로 실려 온다. */
export const RUNSC_EXEC_GONE_RE = /loading container: file does not exist|container does not exist|cannot exec in a (?:stopped|non-running) container|cannot execute in container .* in state (?:stopped|created|paused)|container .* is not running/i;

/** 세션 컨테이너 안 tmux 서버가 **없다** 는 확답 문구(kill-session 뒤·컨테이너 없음) — 병합이 그 세션을 0행으로 접는 근거. 브로커 `TMUX_SERVER_ABSENT_RE` 와 같다. */
export const TMUX_SERVER_ABSENT_RE = /no server running|error connecting to .+\(No such file or directory\)|Container .+ is not running|No such container/i;

/** exec 한 번의 결과를 세션 관점으로 다듬는다(순수) — 컨테이너가 사라져 실패한 것은 gone 으로. 그 밖은 그대로. */
export function classifyExecOutcome(o: TmuxOutcome, sid: string | null, container: string | null): TmuxOutcome {
  //  실행기(broker-client)가 «컨테이너 없음/정지»(404/409)에 싣는 gone 표식을 존중한다 — 목록에 있던 세션이 exec 직전 회수되면
  //   그 답이 «can't find session» 이어야 상위가 «끝났다» 로 읽는다(404 본문 «No such container» 는 tmux 문구가 아니다). 리뷰 지적 ⑥-2.
  if (o.gone) return sessionGoneResult(sid, container);
  if (o.code !== 0 && RUNSC_EXEC_GONE_RE.test(o.stderr)) return sessionGoneResult(sid, container);
  return o;
}

/**
 * 팬아웃 결과 병합(순수) — 코어의 목록 계약(한 호출에 전량, 0 아닌 종료코드는 «못 봤다»)을 지킨다. 브로커 `mergeTmuxFanout` 과 같다.
 *  · 세션 컨테이너가 0 이면 «서버 없음» 확답(TMUX_NO_SERVER) — 단 목록을 못 본 경우는 TMUX_UNOBSERVED(위 머리말).
 *  · 세션 컨테이너의 «서버 없음»(kill-session 뒤)·«컨테이너 없음»(gone)은 그 세션 0행. 그 밖의 실패는 **통째로** 못 봤다 —
 *    한 세션만 빼고 내보내면 살아 있는 세션이 죽은 것처럼 보인다(#835).
 */
export function mergeFanout(parts: ReadonlyArray<TmuxOutcome>, observed = true): TmuxOutcome {
  if (parts.length === 0) return observed ? TMUX_NO_SERVER : TMUX_UNOBSERVED;
  let out = "";
  const add = (s: string): void => { if (s) out += s.endsWith("\n") ? s : `${s}\n`; };
  for (const p of parts) {
    if (p.code === 0) { add(p.stdout); continue; }
    if (p.gone || TMUX_SERVER_ABSENT_RE.test(p.stderr)) continue;
    return { code: 1, stdout: "", stderr: `세션 컨테이너 tmux 조회 실패(목록을 통째로 못 봤다): ${p.stderr.slice(0, 300)}` };
  }
  return { code: 0, stdout: out, stderr: "" };
}

/** `tmux()` seam 이 던질 오류 — execFile 오류와 같은 필드(code·stdout·stderr). 코어의 소비자는 이 필드로 갈린다. */
export interface TmuxExecError extends Error { code: number; stdout: string; stderr: string }
export function outcomeToError(o: TmuxOutcome): TmuxExecError {
  const e = new Error(`tmux exited ${o.code}: ${o.stderr.trim().split("\n")[0] ?? ""}`) as TmuxExecError;
  e.code = o.code; e.stdout = o.stdout; e.stderr = o.stderr;
  return e;
}

/**
 * 실행(순수 조립) — 계획을 받아 실행기(`exec`)에 시킨다. 실행기는 «이 컨테이너에서 이 argv 를 돌려 세 칸을 다오» 만 안다
 *  (broker-client 가 그것이다). 세션 서버 소켓·설정 없음은 브로커 `runSessionTmux` 와 같은 접두(`-L lvly-<slug> -f /dev/null`).
 */
export async function runPlan(
  plan: TmuxPlan, slug: string, args: readonly string[], observed: boolean,
  exec: (container: string, argv: string[]) => Promise<TmuxOutcome>,
): Promise<TmuxOutcome> {
  const argv = ["tmux", "-L", `lvly-${slug}`, "-f", "/dev/null", ...args];
  switch (plan.kind) {
    case "one":
      return classifyExecOutcome(await exec(plan.container, argv), plan.sid, plan.container);
    case "fanout": {
      const parts = await Promise.all(plan.containers.map(async (c) => classifyExecOutcome(await exec(c, argv), null, c)));
      return mergeFanout(parts, observed);
    }
    case "gone":
      return sessionGoneResult(plan.sid, plan.container);
    case "unobserved":
      return TMUX_UNOBSERVED;
  }
}
