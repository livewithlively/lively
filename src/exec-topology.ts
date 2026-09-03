// 실행 토폴로지 — **«이 프로세스의 세션이 어디서 도나»를 한 곳에서 정한다** (#2599 T2 · #2258 이동 2).
//
// ── 왜 ──────────────────────────────────────────────────────────────────────
// 같은 질문을 23개 파일 30자리가 각자 env 로 되물었다(T0 실측 — 프로젝트 본문의 «15파일 25곳»은
//  테넌시/DB 축을 뺀 수였다). `LIVELY_TMUX_EXEC` 유무로 «매니지드인가»,
//  `LIVELY_NODE_TOKEN` 유무로 «노드 안인가», `LIVELY_SESSION_ENSURE` 유무로 «배포 종류», `LIVELY_MEMBER_EXEC`
//  유무로 «파일이 이 호스트에 없나». 답이 **한 벌이 아니라 자리마다 재도출**되니, 규율이 반쪽만 적용됐다 —
//  `LIVELY_NODE_TOKEN` 은 4곳이 모듈 로드 시점에 얼고 2곳이 호출 시점에 읽어, 같은 질문에 두 답이 나오는
//  창이 구조적으로 있었다(조사: 지식 `exec-topology-branch-map-2601` 함정 1).
// 여기서 한 번 정하고, 다른 코드는 **env 를 직접 읽지 않는다.** 그 불변식은 grep 이 아니라
//  `scripts/exec-topology-single-source.test.mjs` 가 소스로 못박는다.
//
// ── 언제 정해지나 ───────────────────────────────────────────────────────────
//  · 게이트웨이·노드 진입점이 부팅 때 `freezeExecTopology()` 를 부른다 → 그 뒤 값은 **안 변한다**.
//    ⚠ 부팅 순서 제약: `boot/tenancy-env.ts` 가 부팅 중에 `LIVELY_TENANCY_MODE` 를 **쓴다.** 그보다 먼저
//     얼면 틀린 값이 굳는다. ESM 은 import 를 전부 실행한 뒤 본문을 돌리므로 index.ts **본문**에서 부르면 안전하다.
//  · 안 얼린 프로세스(테스트·스크립트·도구)에서는 호출 시점 env 에서 파생한다 — 종전 함수들의
//    «호출 시점에 읽는다» 규약이 그대로 산다(그래서 env 를 흔드는 기존 시험 20종이 한 줄도 안 바뀐다).
//
// ── 여기 없는 것 ────────────────────────────────────────────────────────────
//  **테넌시/DB 바인딩 축**(`LIVELY_TENANT_BINDING` · `LIVELY_TENANCY_MODE` 의 DB 쪽 파생)은 이 모듈이
//  안 가진다. 그 축이 답하는 질문은 «이 프로세스가 DB 를 어떻게 보나»이지 «세션이 어디서 도나»가 아니고,
//  섞으면 부팅 순서가 얽힌다(위 제약이 그 이유다). `LIVELY_TENANCY_MODE` 는 두 축에 걸쳐 있어 —
//  여기서는 **tmux 소켓 파생값만** 소유하고 DB 쪽(`db/tenant-binding-boot` · `org/tenancy/state` ·
//  `org/tenant-middleware`)과 파일 루트(`terminal/catalog`)는 손대지 않는다.
//
// ── 이름 붙은 술어를 «얇은 별칭» 이라 부르지 마라 (#2599 T3) ────────────────────────────────────
// T2 가 종전 판정 함수들의 **몸통**을 이 모듈 조회로 바꿨다(`isolationEnabled` → `isolation !== "none"`,
//  `memberExecConfigured` → `storage === "detached"`, `sessionExecConfigured`·`sessionSpawnPath` …).
//  T3 이 그것들을 지우고 호출부마다 `execTopology().X === "y"` 를 인라인할 수도 있었지만 **안 했다** —
//  그러면 «필드 값이 무슨 뜻인가» 의 판정이 1곳에서 N곳(memberExecConfigured 만 8자리)으로 늘어난다.
//  이 프로젝트가 없애려는 것이 정확히 그 모양이라, 인라인은 «두 벌» 을 되만드는 일이다.
//  ⇒ 규율은 **«env 는 여기서만 읽는다»(S1 이 지킨다) + «한 질문에 이름 하나»** 다. 이름이 남아 있는 것은
//   빚이 아니라 그 두 번째 규율의 실행이다. 이름이 **두 질문**에 답하고 있으면 그때가 가를 때다 —
//   T3 이 `tmuxRelayManaged()` 를 `tmuxServerAbsenceIsFinal` / `tmuxViaRelay` 로 가른 것이 그 사례다
//   (조사 함정 4 가 T2 까지 안 고쳐진 이유가 바로 «한 이름이 두 답을 붙들고 있었다» 였다).
//
// ⚠ 이 모듈은 **런타임 import 가 없다**(순수 잎). 노드 에이전트 번들에 실리므로 무엇도 끌어오면 안 된다
//  (#2165 의 교훈 — 간선 하나가 11개를 끌었다). 그 불변식은 node-agent-bundle-boundary 시험이 지킨다.

/** 세션 프로세스가 **이 프로세스 호스트 기준으로** 어디서 도나. */
export type SessionHost =
  /** 같은 호스트(셀프호스트 primary·registry secondary·리눅스 격리) */
  | "local"
  /** 중계 너머(매니지드 — tmux·세션이 테넌트 컨테이너 안) */
  | "relay"
  /** 이 프로세스가 노드 에이전트다(세션은 여기 로컬이지만 DB 가 없고 게이트웨이는 원격) */
  | "node";

/** 세션을 무엇으로 가르나. 실제 격리 성립은 멤버별 게이트(`resolveMemberOsUser`)가 따로 본다 — 여기는 **배포가 고른 방식**이다. */
export type IsolationMode = "none" | "os-user" | "container";

/** 세션 파일이 이 프로세스 호스트에 있나(= 게이트웨이와 같은 저장소인가). */
export type StorageLocality = "colocated" | "detached";

/**
 * tmux 서버의 자리 — **부팅 상수**. 테넌트 의존 값의 결합은 `tmuxArgvFor(slug, bin)` 이 한다.
 *
 * ⚠ 기획 초안은 `{kind:'exec', argv: string[]}` 였는데 **원문 문자열로 둔다.** `{slug}` 치환이
 *  `String.replace(문자열 패턴)` = **첫 번째 하나만** 바꾸는 의미라, 먼저 쪼개고 토큰마다 치환하면
 *  «두 번째 {slug} 도 바뀐다»로 동작이 갈린다. 종전과 바이트 단위로 같으려면 «치환 → split» 순서여야 한다.
 */
export type TmuxPlacement =
  /** 이 호스트의 tmux 소켓. `socket: null` = tmux 기본 소켓 · `"lvly-{slug}"` = 테넌트 전용 소켓(registry secondary). */
  | { kind: "socket"; socket: string | null }
  /** 중계 프로그램 명령줄(원문). `{slug}` 가 있으면 테넌트 컨텍스트가 필요하다. */
  | { kind: "exec"; command: string };

/** 배포자 훅·중계의 **해소된 값**. 판정은 위 필드가, 조립은 각 호출부가 한다(여기는 값만 든다). */
export interface TopologyHooks {
  /** 세션 컨테이너 확보 훅(`LIVELY_SESSION_ENSURE`). "" = 없음(셀프호스트). */
  sessionEnsure: string;
  /** 대화 런타임 세션 경계 중계(`LIVELY_SESSION_EXEC`). "" = 로컬에서 직접 띄운다. */
  sessionExec: string;
  /** 멤버 파일 op 중계(`LIVELY_MEMBER_EXEC`). "" = 로컬 uid 강하. */
  memberExec: string;
  /** 세션을 무엇에 담아 띄울지 갈아끼우는 확장점(`LIVELY_SESSION_SPAWN`). "" = 없음. */
  sessionSpawn: string;
  /** 멤버 uid 강하 wrapper 설치 경로(`LIVELY_BOX_SPAWN`). sudoers Cmnd 와 문자열 일치가 불변식. */
  boxSpawn: string;
  /** per-session cgroup root wrapper 설치 경로(`LIVELY_BOX_CGSPAWN`). */
  boxCgspawn: string;
}

export interface ExecTopology {
  sessionHost: SessionHost;
  tmux: TmuxPlacement;
  isolation: IsolationMode;
  storage: StorageLocality;
  hooks: TopologyHooks;
  /** 노드 에이전트의 자기 인증값(`LIVELY_NODE_TOKEN`). "" = 게이트웨이. `sessionHost==="node"` 의 근거이기도 하다. */
  nodeToken: string;
  /** attach 워커 풀 K(0 = 비활성 = 게이트웨이 안에서 attach). */
  attachWorkerK: number;
}

/**
 * `LIVELY_ATTACH_WORKER_K` 파서 (#2228). 미설정/0/off = 비활성 · 정수 = 워커당 세션 수 · inf = 워커 1개.
 *  여기 두는 이유: 이 값의 **유일한 출처**가 이 모듈이고, 파서가 다른 파일에 있으면 그 파일도 env 를
 *  읽는 자리가 되기 쉽다. `terminal/attach-router.ts` 가 종전 이름으로 재수출한다(호출부 무변경).
 */
export function parseWorkerK(raw: string | undefined): number {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "" || s === "0" || s === "off" || s === "false" || s === "no") return 0;
  if (s === "inf" || s === "infinity" || s === "∞" || s === "all") return Infinity;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.floor(n);
}

/** registry 모드의 테넌트 전용 소켓 이름 템플릿 — `tmux -L lvly-<slug>`(#1750 S3). */
const TENANT_SOCKET = "lvly-{slug}";

/**
 * (순수) env 한 벌에서 토폴로지를 파생한다. **종전 판정과 바이트 단위로 같아야 한다** — 각 줄이
 *  어느 함수를 대체하는지 주석으로 달아 두었다(그 대응이 깨지면 무회귀가 깨진 것이다).
 */
export function computeExecTopology(env: NodeJS.ProcessEnv = process.env): ExecTopology {
  // ⚠ 트림하지 않는다 — 종전 판별자가 `!!process.env.LIVELY_NODE_TOKEN` 이었다(공백 하나도 «노드»였다).
  //  여기서 트림하면 그 극단값에서 동작이 갈린다. 값 자체는 노드 에이전트가 인증에 그대로 쓴다.
  const nodeToken = env.LIVELY_NODE_TOKEN || "";
  const relayTmux = (env.LIVELY_TMUX_EXEC || "").trim();                      // ← tmuxExecArgv · tmuxViaRelay/tmuxServerAbsenceIsFinal
  const registryMode = (env.LIVELY_TENANCY_MODE || "").trim().toLowerCase() === "registry";
  const hooks: TopologyHooks = {
    sessionEnsure: (env.LIVELY_SESSION_ENSURE || "").trim(),                  // ← sessionEnsureConfigured · sessionEnsureArgv
    sessionExec: (env.LIVELY_SESSION_EXEC || "").trim(),                      // ← sessionExecConfigured · sessionExecArgv
    memberExec: (env.LIVELY_MEMBER_EXEC || "").trim(),                        // ← memberExecConfigured · memberExecArgv
    sessionSpawn: env.LIVELY_SESSION_SPAWN || "",                             // ← sessionSpawnPath
    boxSpawn: env.LIVELY_BOX_SPAWN || "/opt/lively/libexec/box-spawn",        // ← BOX_SPAWN
    boxCgspawn: env.LIVELY_BOX_CGSPAWN || "/opt/lively/libexec/box-cgspawn",  // ← BOX_CGSPAWN
  };
  const attachWorkerK = parseWorkerK(env.LIVELY_ATTACH_WORKER_K);

  // ── sessionHost ──
  //  노드 판별이 **먼저**다: 노드 프로세스엔 중계 env 가 없지만, 있더라도 «내가 노드다»가 더 강한 사실이다.
  const sessionHost: SessionHost = nodeToken ? "node" : relayTmux ? "relay" : "local";

  // ── tmux ──  종전 tmuxExecArgv 의 분기를 그대로 옮긴 것: 중계 > registry 전용소켓 > 기본소켓.
  const tmux: TmuxPlacement = relayTmux
    ? { kind: "exec", command: relayTmux }
    : { kind: "socket", socket: registryMode ? TENANT_SOCKET : null };

  // ── isolation ──
  //  **정확히** `off` 만 하드 비활성(킬스위치). 대소문자·공백을 안 봐준다 — 종전 판정이 그랬고
  //  (`process.env.LIVELY_MEMBER_ISOLATION !== "off"`), 킬스위치는 «관대하게 읽어 주는» 쪽이 더 위험하다
  //  (`" off"` 를 끔으로 읽으면 격리가 조용히 꺼진다). 워커 풀 K 만 대소문자·공백을 무시하는데, 그건
  //  사람이 손으로 넣는 노브라 관대함이 맞고 잘못 읽어도 성능만 달라진다 — 비대칭은 의도다.
  //  그 외에는 «세션 컨테이너 확보 훅이 있으면 컨테이너»다 — #2546 4단계가 글롭 게이트를 없앤 뒤로
  //  이 훅 하나가 «이 배포가 매니지드인가»를 사실상 정의해 왔고, T2 는 그 사후 추론을 **필드 이름으로
  //  끌어올렸다**(조사 함정 6).
  //  ⚠ **`isolation === "container"` 와 `sessionHost === "relay"` 는 같은 질문이 아니다.** 앞은 «세션을
  //   무엇으로 가르나»(컨테이너 경계), 뒤는 «세션이 이 호스트에서 도나»(tmux 의 자리)다. 오늘의 매니지드가
  //   둘을 함께 켤 뿐 서로 파생되지 않는다 — 컨테이너로 가르되 tmux 는 이 호스트에 두는 배포가 성립한다.
  //   그래서 두 축을 하나로 접지 않았다. «매니지드인가»를 묻고 싶으면 **무엇을 알고 싶은지**를 먼저
  //   정해야 한다(격리 기제인가, 세션의 자리인가) — 그게 이 두 필드가 존재하는 이유다.
  const isolation: IsolationMode =
    env.LIVELY_MEMBER_ISOLATION === "off" ? "none" : hooks.sessionEnsure ? "container" : "os-user";

  // ── attachTransport 는 없다 (#2599 T3 에서 제거) ──
  //  T2 가 `inproc|worker-fd|node-relay` 를 두고 «소비처를 옮기거나 지워라» 로 기한을 걸었다. 옮길 수
  //   없어서 지웠다 — 소비처가 없어서가 아니라 **축이 다르기 때문이다.** 그 셋을 실제로 고르는 자리는
  //   `terminal-pty-upgrade` 의 업그레이드 핸들러인데, 거기서 node-relay 는 **요청의 `?node=<id>`** 로
  //   갈린다(같은 게이트웨이가 어떤 요청은 워커로, 어떤 요청은 노드로 보낸다). 프로세스 한 벌로 얼린
  //   값은 그 분기를 못 대표한다 — 게이트웨이에서 이 필드는 영영 `node-relay` 가 아니므로, 그 이름을
  //   보고 `=== "node-relay"` 를 쓰면 **항상 거짓인 분기**가 된다. 남겨 두는 편이 위험했다.
  //  ⇒ 프로세스 축의 노브인 `attachWorkerK` 만 남는다(`attach-worker-host` 가 그 하나만 읽는다).

  // ── storage ──
  //  «세션 파일이 이 호스트에 있나». 종전엔 `memberExecConfigured()` 가 이 질문을 이름 없이 답했다
  //  (중계가 설정됐다 = 파일이 여기 없다). 그 추론을 필드로 끌어올린 것 — 값의 출처는 같다.
  //  ⚠ 세션 **컨테이너 안**의 같은 질문은 브로커가 `LVLY_STORAGE_LOCALITY` 로 싣고 공유폴더 훅 3종이
  //   읽는다(별 프로세스라 이 모듈을 import 할 수 없다 — `storage-locality-decision-2258` §3).
  //   그건 폴더가 아니라 **프로세스**의 지역성이라 같은 축이고, 두 자리가 같은 낱말을 쓰는 것이 의도다.
  const storage: StorageLocality = hooks.memberExec ? "detached" : "colocated";

  return { sessionHost, tmux, isolation, storage, hooks, nodeToken, attachWorkerK };
}

let frozen: ExecTopology | null = null;

/**
 * 부팅 때 **한 번** 토폴로지를 확정한다.
 *
 * ⚠ **확정 뒤에는 env 를 바꿔도 답이 안 변한다** — 프로세스를 다시 띄워야 한다. 종전 함수 몇몇은
 *  「호출 시점에 읽는다」고 적혀 있었고 `isolationEnabled()` 는 스스로를 «긴급 롤백 킬스위치» 라 불렀지만,
 *  그 말이 «도는 프로세스의 env 를 바꿔 끈다» 를 뜻한 적은 없다(그럴 코드가 없다 — 단일출처 시험 S6 가
 *  그 «없음»을 지킨다). 실질은 종전과 같고 **약속만 정직해졌다**: 스위치를 돌리는 방법은 재시작이다. 게이트웨이(`src/index.ts`)·노드 에이전트(`src/node/agent.ts`)의
 *  진입점이 부른다. ⚠ `boot/tenancy-env.ts` 가 env 를 쓴 **뒤**여야 한다(모듈 머리말 참조).
 *  두 번 불러도 안전하다(마지막 값으로 갈린다) — 다만 정상 배선에선 한 번만 불린다.
 */
export function freezeExecTopology(env: NodeJS.ProcessEnv = process.env): ExecTopology {
  frozen = computeExecTopology(env);
  return frozen;
}

/**
 * 이 프로세스의 실행 토폴로지.
 *  부팅에서 얼렸으면 **그 값**(프로덕션 — 프로세스 수명 내내 안 변한다), 안 얼렸으면 지금 env 에서 파생한다
 *  (시험·스크립트 — 종전 함수들의 «호출 시점에 읽는다» 규약을 그대로 유지한다).
 */
export function execTopology(): ExecTopology {
  return frozen ?? computeExecTopology(process.env);
}

/** 시험 전용 — 얼린 값을 푼다(다음 조회부터 다시 env 에서 파생). */
export function unfreezeExecTopology(): void { frozen = null; }

/** 이 프로세스가 노드 에이전트인가 — 흩어져 있던 `ON_NODE`/`onNode` 6벌의 단일 출처. */
export function onNode(): boolean { return execTopology().sessionHost === "node"; }

/**
 * **이 호출**의 tmux 서버가 그 워크스페이스 전용인가 (#2599 T3).
 *
 * ⚠ 이건 **프로세스 축이 아니라 요청 축**이다. `tmux.socket` 이 있다는 것은 «이 배포가 registry 모드로 떴다» 일
 *  뿐이고, 그런 게이트웨이도 **primary 워크스페이스를 무컨텍스트로 함께 서비스한다**(`org/tenant-middleware`:
 *  «헤더 없음/primary → 컨텍스트 없이 통과», `db/tenant-binding-boot`: «primary 는 남이 아니라 종전의 그
 *  워크스페이스 자신»). 그 호출은 아래 `tmuxArgvFor` 가 **기본(공용) 소켓**으로 보낸다. 그러니 부팅 상수만 보고
 *  «전용 서버다» 라고 답하면 primary 트래픽까지 전용으로 오분류된다.
 *  ⇒ **슬러그를 함께 받아야 한다.** 같은 함정을 T3 이 `attachTransport` 에서 필드째 지운 적이 있다
 *   (프로세스 한 벌로 얼린 값이 요청마다 갈리는 분기를 대표하지 못한다).
 *
 * 쓰는 곳 둘 — argv 조립(`tmuxArgvFor`)과 «서버 부재 = 세션 소실 확답» 판정(`terminal/tmux-exec`).
 *  **둘이 반드시 같은 답을 봐야** 「전용 소켓으로 보냈는데 확답은 공용 규약으로 준다」 같은 어긋남이 안 생긴다.
 */
export function tmuxServerIsDedicated(slug: string | null, t: TmuxPlacement = execTopology().tmux): boolean {
  if (t.kind === "exec") return true;   // 테넌트별 중계 = 그 테넌트만의 tmux 컨테이너
  return !!t.socket && !!slug && slug !== "primary";
}

/**
 * tmux argv 접두사 — **부팅 상수(placement) × 테넌트 컨텍스트(slug)** 의 결합을 이 모듈이 소유한다.
 *  종전 `tmuxExecArgv()` 안에 숨어 있던 결합을 그대로 옮긴 것이라 결과가 바이트 단위로 같다.
 *
 *  빈 배열 = «접두사 없음» = 호출자가 tmux 를 직접 부른다(기본 소켓).
 *
 * ⚠ 중계인데 슬러그가 없으면 **던진다.** 로컬 tmux 로 폴백하면 ⓐ 세션이 엉뚱한 자리에 생기고
 *  ⓑ 모든 테넌트가 같은 tmux 서버를 공유한다(= 남의 세션이 목록에 보인다). 컨텍스트를 잃은 건
 *  배선 버그이고, 배선 버그는 오류로 드러나야 한다.
 *
 * @param slug 요청 컨텍스트의 테넌트 슬러그(없으면 null). primary(무컨텍스트 단일 테넌트)는 기본 소켓이다.
 * @param tmuxBin tmux 실행 파일 경로(`terminal/catalog.TMUX_BIN`) — 전용 소켓 접두사에만 쓴다.
 */
export function tmuxArgvFor(slug: string | null, tmuxBin: string): string[] {
  const t = execTopology().tmux;
  if (t.kind === "socket") {
    // ── 셀프호스트 registry(#1750 S3) — 같은 호스트에서 워크스페이스마다 tmux 서버를 가른다. ──
    //  secondary 면 `-L lvly-<slug>` 전용 소켓: 목록·옵션·attach 가 전부 그 서버 안이라 **다른 워크스페이스의
    //  세션이 목록에 뜨는 일 자체가 없다**(이름 규약이 아니라 서버 격리). primary·무컨텍스트는 기본 소켓 = 종전 그대로.
    //  ⚠ 그 «전용이냐» 판정은 아래 `tmuxServerIsDedicated` 가 소유한다 — 여기서 조건을 다시 쓰면 두 벌이 된다(#2599 T3).
    if (!t.socket || !tmuxServerIsDedicated(slug, t)) return [];
    return [tmuxBin, "-L", t.socket.replace("{slug}", slug!)];
  }
  // ── 테넌트별 중계(#1437 v1 5단계) — 게이트웨이 하나가 여러 워크스페이스를 서비스하면 tmux 서버도 워크스페이스마다 다르다.
  if (!t.command.includes("{slug}")) return t.command.split(/\s+/);
  if (!slug) throw new Error("tmux 중계에 테넌트 컨텍스트가 필요합니다 — 컨텍스트 밖에서 호출됐습니다");
  return t.command.replace("{slug}", slug).split(/\s+/);
}

/**
 * 이 배포에서 «게이트웨이 박스 위의 노드»(#2592)가 **성립할 수 있나** — 토폴로지가 답하는 **선결 조건**.
 *
 * 게이트웨이의 tmux 가 이 프로세스 호스트에 없으면(매니지드 중계 · 이 프로세스 자체가 노드) 노드가 그것을
 *  공유하는 일이 원천적으로 불가능하다. 그러면 증거를 재는 일(tmux 겹침 조회)도 의미가 없다 —
 *  #2592 의 집행 지점(`node/registry.looksLikeGatewayBox`)이 이 값으로 먼저 물러난다.
 *
 * ⚠ **판정도 사유 문구도 여기서 만들지 않는다.** 둘 다 #2592 가 이미 한 벌로 갖고 있다 —
 *  증거 규칙은 `node/self-node.sharesGatewayTmux`(«양성일 때만 참» 이라는 비대칭 규율이 붙어 있어
 *  증거와 한 파일에 있어야 산다), 사람에게 할 말은 `node/self-node.selfNodeMessage()`(등록 409·close
 *  사유·관리 배지·CLI 가 **같은 문장**을 쓰게 만든 자리). 여기서 두 번째 문장을 만들면 같은 상황을 겪은
 *  두 사람이 서로 다른 원인을 짚게 된다 — 이 프로젝트가 없애려는 바로 그 «두 벌»이다.
 *  토폴로지가 더하는 것은 그 판정이 **애초에 성립하는 자리인가** 하나다.
 */
export function selfNodePossible(t: ExecTopology = execTopology()): boolean {
  return t.sessionHost === "local";
}
