// 실행 토폴로지 — 사양 기반 시험 (사양 출처: #2599 T2 사양서 §1~§5·§7 / 프로젝트 #2599 본문 + 태스크 #2603 + T0 조사 `exec-topology-branch-map-2601`)
//
//  ── 이 파일이 지키는 불변식 ────────────────────────────────────────────────
//  ① **한 벌의 앎**: 프로세스가 «자기 세션이 어디서 도는지»를 여섯 축(세션호스트·tmux 자리·격리·attach·저장·노드
//     인증값)으로 한 번에 답한다. 축마다 판정 규칙이 있고, 그 규칙은 서로 독립이다(§2).
//  ② **표면 다섯이 표를 채운다**: 셀프호스트 primary / registry secondary / 리눅스 격리 / 매니지드 / 멤버 노드 —
//     이 다섯의 축별 값이 §1 표와 한 칸도 어긋나면 안 된다.
//  ③ **엣지가 곧 사양이다**: 노드 토큰 «공백 하나»는 있음 · 워크스페이스 모드는 대소문자·공백 무시 ·
//     중계 설정이 «공백뿐»이면 없음 · 격리 킬스위치는 «정확히 off» 만 끔(secure-by-default) ·
//     워커 풀 값 표의 모든 칸.
//  ④ **컨텍스트를 잃으면 조용히 폴백하지 않고 오류로 드러난다**: 중계 명령에 `{slug}` 가 있는데 워크스페이스가
//     없으면 던진다(§3 마지막 줄). 로컬 tmux 로 접으면 남의 세션이 목록에 보인다.
//  ⑤ **확정되면 프로세스 수명 동안 안 변한다**(§4). 같은 질문에 두 답이 나오는 창을 없애는 것이 존재 이유다.
//  ⑥ **노드 등록 모순은 판정하고 사유를 만든다**(§5). 증거는 밖에서 받고, «같은 호스트» 가 아니면 성립하지 않으며,
//     증거 음성은 «판정 보류» 를 포함한 «아님» 이다.
//  ⑦ **무회귀**(§7): 설정 없는 배포는 종전과 100% 같고, 매니지드 argv·registry 소켓 이름·킬스위치 의미·
//     wrapper 기본 경로 문자열이 바이트 단위로 같다.
//
//  ⚠ §6(구조 불변식 — 설정값 직독 파일이 하나뿐 · import 0개)은 **다른 시험 파일이 담당**한다. 여기서 다루지 않는다.
//
//  ── 시험 방식 ──────────────────────────────────────────────────────────────
//  기본은 `computeExecTopology(env)` 에 env 를 직접 준다(프로세스 env 오염 없음 · 순수 함수 계약도 함께 검증).
//  process.env 를 흔드는 것은 env 인자가 없는 표면(`tmuxArgvFor`·`onNode`·`execTopology`)과 §4 수명 시험뿐이며,
//  `withEnv` 가 토폴로지 관련 키 **전부**를 깨끗이 비운 뒤 반드시 원복한다. 확정 상태도 매번 되돌린다.
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeExecTopology,
  execTopology,
  freezeExecTopology,
  nodeSelfConflict,
  onNode,
  parseWorkerK,
  tmuxArgvFor,
  unfreezeExecTopology,
  type ExecTopology,
} from "./exec-topology.js";

// ── 도구 ────────────────────────────────────────────────────────────────────

/** 토폴로지가 보는 설정값 전부. withEnv 는 여기 있는 키를 «주지 않으면 미설정» 으로 만든다(주변 환경 차단). */
const TOPO_KEYS = [
  "LIVELY_NODE_TOKEN",
  "LIVELY_TMUX_EXEC",
  "LIVELY_TENANCY_MODE",
  "LIVELY_SESSION_ENSURE",
  "LIVELY_SESSION_EXEC",
  "LIVELY_MEMBER_EXEC",
  "LIVELY_SESSION_SPAWN",
  "LIVELY_MEMBER_ISOLATION",
  "LIVELY_BOX_SPAWN",
  "LIVELY_BOX_CGSPAWN",
  "LIVELY_ATTACH_WORKER_K",
] as const;

/** 시험용 env 한 벌 — 적지 않은 키는 «미설정»이다. */
const E = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({ ...over });

/** process.env 를 이 한 벌로 갈아끼우고 **반드시 원복**한다(같은 파일 안 다음 시험 오염 방지). */
const withEnv = (over: Record<string, string | undefined>, fn: () => void): void => {
  const keep: Record<string, string | undefined> = {};
  for (const k of TOPO_KEYS) {
    keep[k] = process.env[k];
    const v = over[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    unfreezeExecTopology();
    for (const k of TOPO_KEYS) {
      const prev = keep[k];
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
};

/** §1 표의 다섯 칸만 뽑는다(hooks·토큰·K 는 별도 시험). */
const axes = (t: ExecTopology) => ({
  sessionHost: t.sessionHost,
  tmux: t.tmux,
  isolation: t.isolation,
  attachTransport: t.attachTransport,
  storage: t.storage,
});

/** tmux 자리가 «어느 소켓인가» 를 유니온 좁히기로 읽는다. null = 기본 소켓, 문자열 = 이름 템플릿(전용 소켓). */
const socketOf = (t: ExecTopology): string | null => {
  assert.equal(t.tmux.kind, "socket", "tmux 자리가 소켓이어야 한다");
  return t.tmux.kind === "socket" ? t.tmux.socket : "<소켓이 아님>";
};

const MANAGED = {
  LIVELY_TMUX_EXEC: "docker exec lvly-tmux-{slug} tmux",
  LIVELY_SESSION_ENSURE: "/opt/lively/libexec/session-ensure",
  LIVELY_SESSION_EXEC: "node /opt/lively/libexec/session-exec-relay.cjs {slug}",
  LIVELY_MEMBER_EXEC: "node /opt/lively/libexec/member-exec-relay.cjs {slug}",
};

// ════════════════════════════════════════════════════════════════════════════
// §1. 표면 다섯 — 각 축이 어떤 값이어야 하나 (표 한 줄 = 시험 하나)
// ════════════════════════════════════════════════════════════════════════════

test("§1-1 셀프호스트 primary(아무 설정 없음) — 같은 호스트·기본 소켓·OS 계정·이 프로세스 안·저장 있다", () => {
  assert.deepEqual(axes(computeExecTopology(E())), {
    sessionHost: "local",
    tmux: { kind: "socket", socket: null },
    isolation: "os-user",
    attachTransport: "inproc",
    storage: "colocated",
  });
});

test("§1-2 셀프호스트 registry secondary(워크스페이스 모드=registry) — 워크스페이스 전용 소켓만 달라진다", () => {
  const t = computeExecTopology(E({ LIVELY_TENANCY_MODE: "registry" }));
  assert.equal(t.sessionHost, "local");
  assert.notEqual(socketOf(t), null, "registry 는 기본 소켓이 아니라 워크스페이스 전용 소켓이다");
  assert.equal(t.isolation, "os-user");
  assert.equal(t.attachTransport, "inproc");
  assert.equal(t.storage, "colocated");
});

test("§1-3 셀프호스트 리눅스 격리(멤버 uid 강하 wrapper 경로) — 축은 primary 와 같고 wrapper 경로만 실린다", () => {
  const t = computeExecTopology(E({ LIVELY_BOX_SPAWN: "/usr/local/libexec/box-spawn" }));
  assert.deepEqual(axes(t), {
    sessionHost: "local",
    tmux: { kind: "socket", socket: null },
    isolation: "os-user",
    attachTransport: "inproc",
    storage: "colocated",
  });
  assert.equal(t.hooks.boxSpawn, "/usr/local/libexec/box-spawn");
});

test("§1-4 매니지드(tmux 중계+세션 확보 훅+세션 경계 중계+멤버 파일 중계) — 중계 너머·중계 명령·컨테이너·이 프로세스 안(워커 미설정)·저장 없다", () => {
  const t = computeExecTopology(E(MANAGED));
  assert.equal(t.sessionHost, "relay");
  assert.equal(t.tmux.kind, "exec");
  assert.equal(t.isolation, "container");
  assert.equal(t.attachTransport, "inproc", "워커 풀을 안 켰으면 매니지드라도 이 프로세스 안이다");
  assert.equal(t.storage, "detached");
});

test("§1-5 멤버 노드(노드 토큰) — 노드·기본 소켓·OS 계정·노드 중계·저장 있다", () => {
  const t = computeExecTopology(E({ LIVELY_NODE_TOKEN: "nt-abc123" }));
  assert.deepEqual(axes(t), {
    sessionHost: "node",
    tmux: { kind: "socket", socket: null },
    isolation: "os-user",
    attachTransport: "node-relay",
    storage: "colocated",
  });
  assert.equal(t.nodeToken, "nt-abc123", "노드 인증값은 그대로 실려야 한다");
});

// ════════════════════════════════════════════════════════════════════════════
// §2-1. 세션 호스트
// ════════════════════════════════════════════════════════════════════════════

test("§2-1 노드 인증값이 있으면 노드 — 다른 어떤 설정보다 우선한다(중계가 설정돼 있어도)", () => {
  const t = computeExecTopology(E({ ...MANAGED, LIVELY_TMUX_EXEC: "ssh box tmux", LIVELY_NODE_TOKEN: "nt-1" }));
  assert.equal(t.sessionHost, "node", "「내가 노드다」가 더 강한 사실이다");
});

test("§2-1 노드가 아니고 tmux 중계가 설정됐으면 중계 너머", () => {
  assert.equal(computeExecTopology(E({ LIVELY_TMUX_EXEC: "ssh box tmux" })).sessionHost, "relay");
});

test("§2-1 노드도 중계도 아니면 같은 호스트", () => {
  assert.equal(computeExecTopology(E()).sessionHost, "local");
  assert.equal(computeExecTopology(E({ LIVELY_TENANCY_MODE: "registry" })).sessionHost, "local");
  assert.equal(computeExecTopology(E({ LIVELY_MEMBER_EXEC: "relay" })).sessionHost, "local");
});

test("★ §2-1 노드 인증값이 «공백 하나» 여도 있음으로 본다 — 여기서 트림하면 극단값에서 동작이 갈린다", () => {
  const t = computeExecTopology(E({ LIVELY_NODE_TOKEN: " " }));
  assert.equal(t.sessionHost, "node");
  assert.equal(t.attachTransport, "node-relay", "노드면 attach 도 노드 중계여야 한다(공백 토큰도 예외 없다)");
});

test("§2-1 노드 인증값이 빈 문자열이면 «없음» — 중계/로컬 판정으로 내려간다", () => {
  assert.equal(computeExecTopology(E({ LIVELY_NODE_TOKEN: "" })).sessionHost, "local");
  assert.equal(computeExecTopology(E({ LIVELY_NODE_TOKEN: "", LIVELY_TMUX_EXEC: "ssh box tmux" })).sessionHost, "relay");
});

// ════════════════════════════════════════════════════════════════════════════
// §2-2. tmux 자리
// ════════════════════════════════════════════════════════════════════════════

test("§2-2 tmux 중계가 설정됐으면 중계 자리 — 워크스페이스 모드보다 우선한다", () => {
  const t = computeExecTopology(E({ LIVELY_TMUX_EXEC: "ssh box tmux", LIVELY_TENANCY_MODE: "registry" }));
  assert.equal(t.tmux.kind, "exec");
});

test("§2-2 중계 명령의 앞뒤 공백은 무시한다 — 값이 있으면 중계 자리다", () => {
  const t = computeExecTopology(E({ LIVELY_TMUX_EXEC: "  ssh box tmux  " }));
  assert.equal(t.tmux.kind, "exec");
  assert.equal(t.sessionHost, "relay");
  if (t.tmux.kind === "exec") assert.equal(t.tmux.command.trim(), "ssh box tmux");
});

test("★ §2-2 중계 설정이 «공백뿐» 이면 없음 — 소켓으로 내려가고 세션 호스트도 같은 호스트다", () => {
  for (const blank of [" ", "   ", "\t", "\n", " \t\n "]) {
    const t = computeExecTopology(E({ LIVELY_TMUX_EXEC: blank }));
    assert.equal(t.tmux.kind, "socket", `공백뿐인 중계는 없음이어야 한다: ${JSON.stringify(blank)}`);
    assert.equal(socketOf(t), null, "중계도 registry 도 없으면 기본 소켓");
    assert.equal(t.sessionHost, "local", `공백뿐인 중계로 «중계 너머» 가 되면 안 된다: ${JSON.stringify(blank)}`);
  }
});

test("★ §2-2 중계가 공백뿐이고 워크스페이스 모드가 registry 면 워크스페이스 전용 소켓으로 간다", () => {
  const t = computeExecTopology(E({ LIVELY_TMUX_EXEC: "   ", LIVELY_TENANCY_MODE: "registry" }));
  assert.equal(t.tmux.kind, "socket");
  assert.notEqual(socketOf(t), null);
});

test("★ §2-2 워크스페이스 모드 비교는 대소문자·앞뒤 공백을 무시한다", () => {
  for (const mode of ["registry", "REGISTRY", "Registry", "ReGiStRy", " registry ", "\tregistry\n", "  REGISTRY  "]) {
    const t = computeExecTopology(E({ LIVELY_TENANCY_MODE: mode }));
    assert.notEqual(socketOf(t), null, `registry 로 읽혀야 한다: ${JSON.stringify(mode)}`);
  }
});

test("§2-2 registry 가 아닌 모드 값·미설정은 기본 소켓", () => {
  for (const mode of [undefined, "", "single", "primary", "registryx", "xregistry", "reg istry", "registries"]) {
    const t = computeExecTopology(E({ LIVELY_TENANCY_MODE: mode }));
    assert.equal(socketOf(t), null, `기본 소켓이어야 한다: ${JSON.stringify(mode)}`);
  }
});

test("§2-2 축 독립 — 노드여도 tmux 중계가 설정됐으면 tmux 자리는 중계다", () => {
  const t = computeExecTopology(E({ LIVELY_NODE_TOKEN: "nt-1", LIVELY_TMUX_EXEC: "ssh box tmux" }));
  assert.equal(t.sessionHost, "node");
  assert.equal(t.tmux.kind, "exec");
});

// ════════════════════════════════════════════════════════════════════════════
// §2-3. 격리 방식 — secure-by-default
// ════════════════════════════════════════════════════════════════════════════

test("§2-3 킬스위치가 정확히 off 면 안 가름 — 세션 컨테이너 확보 훅이 있어도 그렇다", () => {
  assert.equal(computeExecTopology(E({ LIVELY_MEMBER_ISOLATION: "off" })).isolation, "none");
  assert.equal(
    computeExecTopology(E({ ...MANAGED, LIVELY_MEMBER_ISOLATION: "off" })).isolation,
    "none",
    "킬스위치가 컨테이너 훅을 이긴다",
  );
});

test("★ §2-3 킬스위치가 off 가 아닌 값·미설정은 전부 «켠 것» — 훅이 없으면 OS 계정", () => {
  for (const v of [undefined, "", " ", "os", "on", "true", "1", "container", "none", "no", "disabled"]) {
    const t = computeExecTopology(E({ LIVELY_MEMBER_ISOLATION: v }));
    assert.notEqual(t.isolation, "none", `secure-by-default: 끄면 안 된다: ${JSON.stringify(v)}`);
    assert.equal(t.isolation, "os-user", `훅이 없으니 OS 계정: ${JSON.stringify(v)}`);
  }
});

test("★ §2-3 킬스위치는 «정확히» off — 대소문자·앞뒤 공백이 다르면 끄지 않는다", () => {
  for (const v of ["OFF", "Off", "oFF", " off", "off ", " off ", "off\n", "\toff"]) {
    assert.equal(
      computeExecTopology(E({ LIVELY_MEMBER_ISOLATION: v })).isolation,
      "os-user",
      `「정확히 off」가 아니면 켠 것이다: ${JSON.stringify(v)}`,
    );
  }
});

test("§2-3 킬스위치가 안 걸렸고 세션 컨테이너 확보 훅이 있으면 컨테이너", () => {
  assert.equal(computeExecTopology(E({ LIVELY_SESSION_ENSURE: "/opt/lively/libexec/session-ensure" })).isolation, "container");
});

test("§2-3 세션 컨테이너 확보 훅이 빈 문자열이면 «없음» — OS 계정", () => {
  assert.equal(computeExecTopology(E({ LIVELY_SESSION_ENSURE: "" })).isolation, "os-user");
});

// ════════════════════════════════════════════════════════════════════════════
// §2-4. attach 전송 + 워커 풀 설정값 표
// ════════════════════════════════════════════════════════════════════════════

test("§2-4 노드면 노드 중계 — 워커 풀이 켜져 있어도 노드가 먼저다", () => {
  const t = computeExecTopology(E({ LIVELY_NODE_TOKEN: "nt-1", LIVELY_ATTACH_WORKER_K: "4" }));
  assert.equal(t.attachTransport, "node-relay");
});

test("§2-4 노드가 아니고 워커 풀이 켜져 있으면 워커 프로세스", () => {
  assert.equal(computeExecTopology(E({ LIVELY_ATTACH_WORKER_K: "4" })).attachTransport, "worker-fd");
  assert.equal(computeExecTopology(E({ ...MANAGED, LIVELY_ATTACH_WORKER_K: "2" })).attachTransport, "worker-fd");
  assert.equal(computeExecTopology(E({ LIVELY_ATTACH_WORKER_K: "inf" })).attachTransport, "worker-fd");
});

test("§2-4 워커 풀이 꺼져 있으면 이 프로세스 안", () => {
  for (const v of [undefined, "", "0", "off", "false", "no", "-1", "abc"]) {
    assert.equal(
      computeExecTopology(E({ LIVELY_ATTACH_WORKER_K: v })).attachTransport,
      "inproc",
      `꺼진 값이다: ${JSON.stringify(v)}`,
    );
  }
});

test("§2-4 attachWorkerK 는 파싱 결과를 그대로 실어 나른다", () => {
  assert.equal(computeExecTopology(E({ LIVELY_ATTACH_WORKER_K: " 3 " })).attachWorkerK, 3);
  assert.equal(computeExecTopology(E({ LIVELY_ATTACH_WORKER_K: "2.7" })).attachWorkerK, 2);
  assert.equal(computeExecTopology(E()).attachWorkerK, 0);
});

test("§2-4 워커 풀 표 — 미설정·빈값·0·off·false·no 는 꺼짐(0)", () => {
  for (const raw of [undefined, "", "0", "off", "false", "no"]) {
    assert.equal(parseWorkerK(raw), 0, `꺼짐이어야 한다: ${JSON.stringify(raw)}`);
  }
});

test("§2-4 워커 풀 표 — inf·infinity·∞·all 은 무제한(네 철자가 같은 값이고, 어떤 유한 설정보다 크다)", () => {
  const unlimited = parseWorkerK("inf");
  for (const raw of ["inf", "infinity", "∞", "all"]) {
    assert.equal(parseWorkerK(raw), unlimited, `무제한 철자는 모두 같은 값: ${raw}`);
  }
  assert.ok(unlimited > 0, "무제한은 «켜짐» 이어야 한다");
  assert.ok(unlimited > parseWorkerK("1000000"), "무제한은 어떤 유한 상한보다 커야 한다(워커 1개에 전부)");
});

test("§2-4 워커 풀 표 — 양의 정수 문자열은 그 수", () => {
  assert.equal(parseWorkerK("1"), 1);
  assert.equal(parseWorkerK("4"), 4);
  assert.equal(parseWorkerK("64"), 64);
  assert.equal(parseWorkerK("1000000"), 1000000);
});

test("§2-4 워커 풀 표 — 소수는 내림한 정수(2.7→2, 0.5→0=꺼짐)", () => {
  assert.equal(parseWorkerK("2.7"), 2);
  assert.equal(parseWorkerK("1.9"), 1);
  assert.equal(parseWorkerK("8.0"), 8);
  assert.equal(parseWorkerK("0.5"), 0, "내림하면 0 — 곧 꺼짐이다");
});

test("§2-4 워커 풀 표 — 음수·숫자가 아닌 문자열은 꺼짐", () => {
  for (const raw of ["-1", "-4", "-2.7", "-0.5", "abc", "쓰레기", "x4", "NaN", "??", "-"]) {
    assert.equal(parseWorkerK(raw), 0, `꺼짐이어야 한다: ${JSON.stringify(raw)}`);
  }
});

test("§2-4 워커 풀 표 — 숫자로 «시작만» 하는 쓰레기도 숫자가 아닌 문자열이다(부분 파싱 금지)", () => {
  for (const raw of ["4x", "12abc", "3 4", "2,7"]) {
    assert.equal(parseWorkerK(raw), 0, `숫자가 아니니 꺼짐이어야 한다: ${JSON.stringify(raw)}`);
  }
});

test("★ §2-4 워커 풀 표 — 앞뒤 공백·대문자는 무시하고 위 규칙대로 읽는다", () => {
  const unlimited = parseWorkerK("inf");
  assert.equal(parseWorkerK(" 4 "), 4);
  assert.equal(parseWorkerK("\t8\n"), 8);
  assert.equal(parseWorkerK(" 2.7 "), 2);
  assert.equal(parseWorkerK("OFF"), 0);
  assert.equal(parseWorkerK(" Off "), 0);
  assert.equal(parseWorkerK("FALSE"), 0);
  assert.equal(parseWorkerK(" No "), 0);
  assert.equal(parseWorkerK("  "), 0, "공백뿐이면 빈값과 같다");
  assert.equal(parseWorkerK(" INF "), unlimited);
  assert.equal(parseWorkerK("Infinity"), unlimited);
  assert.equal(parseWorkerK("ALL"), unlimited);
});

// ════════════════════════════════════════════════════════════════════════════
// §2-5. 저장 지역성
// ════════════════════════════════════════════════════════════════════════════

test("§2-5 멤버 파일 op 중계가 설정됐으면 저장이 이 호스트에 없다", () => {
  assert.equal(computeExecTopology(E({ LIVELY_MEMBER_EXEC: "node relay.cjs acme" })).storage, "detached");
});

test("§2-5 멤버 파일 op 중계가 없으면 저장은 있다", () => {
  assert.equal(computeExecTopology(E()).storage, "colocated");
  assert.equal(computeExecTopology(E({ LIVELY_MEMBER_EXEC: "" })).storage, "colocated");
});

test("★ §2-5 멤버 파일 op 중계가 «공백뿐» 이면 없음 — 저장은 있다", () => {
  for (const blank of [" ", "   ", "\t", "\n"]) {
    assert.equal(
      computeExecTopology(E({ LIVELY_MEMBER_EXEC: blank })).storage,
      "colocated",
      `공백뿐인 중계는 없음이어야 한다: ${JSON.stringify(blank)}`,
    );
  }
});

test("§2-5 멤버 파일 op 중계의 앞뒤 공백은 무시 — 값이 있으면 없다", () => {
  assert.equal(computeExecTopology(E({ LIVELY_MEMBER_EXEC: "  node relay.cjs acme  " })).storage, "detached");
});

// ════════════════════════════════════════════════════════════════════════════
// §3. tmux 명령 접두사 — 부팅 상수(자리) × 테넌트 컨텍스트(워크스페이스). 표 7행 전부.
//     (env 인자가 없는 표면이라 process.env 를 흔든다 — withEnv 가 원복·확정해제까지 한다.)
// ════════════════════════════════════════════════════════════════════════════

const TMUX = "/usr/bin/tmux";

test("§3-1 기본 소켓 + 워크스페이스 무엇이든 → 빈 조각(접두사 없이 tmux 를 그냥 부른다)", () => {
  withEnv({}, () => {
    for (const slug of [null, "primary", "acme", "other-tenant"]) {
      assert.deepEqual(tmuxArgvFor(slug, TMUX), [], `기본 소켓은 접두사가 없다: ${String(slug)}`);
    }
  });
});

test("§3-2 워크스페이스 전용 소켓 + 컨텍스트 밖(없음) → 빈 조각", () => {
  withEnv({ LIVELY_TENANCY_MODE: "registry" }, () => {
    assert.deepEqual(tmuxArgvFor(null, TMUX), []);
  });
});

test("★ §3-3 워크스페이스 전용 소켓 + primary → 빈 조각 (primary 는 기본 소켓을 쓴다 — 기존 세션 무회귀)", () => {
  withEnv({ LIVELY_TENANCY_MODE: "registry" }, () => {
    assert.deepEqual(tmuxArgvFor("primary", TMUX), []);
  });
});

test("★ §3-4 워크스페이스 전용 소켓 + 그 밖(acme) → `<tmux> -L lvly-acme`", () => {
  withEnv({ LIVELY_TENANCY_MODE: "registry" }, () => {
    assert.deepEqual(tmuxArgvFor("acme", TMUX), [TMUX, "-L", "lvly-acme"]);
    assert.deepEqual(tmuxArgvFor("zeta", "tmux"), ["tmux", "-L", "lvly-zeta"]);
  });
});

test("§3-5 중계(자리표시 없음) + 워크스페이스 무엇이든 → 중계 명령을 공백으로 쪼갠 것", () => {
  withEnv({ LIVELY_TMUX_EXEC: "ssh lvly-box tmux" }, () => {
    for (const slug of [null, "primary", "acme"]) {
      assert.deepEqual(tmuxArgvFor(slug, TMUX), ["ssh", "lvly-box", "tmux"], `자리표시가 없으면 그대로다: ${String(slug)}`);
    }
  });
});

test("§3-5 중계 명령의 앞뒤 공백은 argv 에 빈 조각을 남기지 않는다", () => {
  withEnv({ LIVELY_TMUX_EXEC: "  ssh lvly-box tmux  " }, () => {
    assert.deepEqual(tmuxArgvFor("acme", TMUX), ["ssh", "lvly-box", "tmux"]);
  });
});

test("★ §3-6 중계(자리표시 있음) + 워크스페이스 있음 → 자리표시를 워크스페이스로 바꾼 뒤 공백으로 쪼갠다", () => {
  withEnv({ LIVELY_TMUX_EXEC: "docker exec lvly-tmux-{slug} tmux" }, () => {
    assert.deepEqual(tmuxArgvFor("acme", TMUX), ["docker", "exec", "lvly-tmux-acme", "tmux"]);
  });
});

test("§3-6 중계(자리표시 있음) + primary 도 치환된다 — 소켓 쪽의 primary 예외는 여기 적용되지 않는다", () => {
  withEnv({ LIVELY_TMUX_EXEC: "docker exec lvly-tmux-{slug} tmux" }, () => {
    assert.deepEqual(tmuxArgvFor("primary", TMUX), ["docker", "exec", "lvly-tmux-primary", "tmux"]);
  });
});

test("★★ §3-7 중계(자리표시 있음) + 워크스페이스 **없음** → 오류를 던진다 (조용한 폴백은 남의 세션을 노출한다)", () => {
  withEnv({ LIVELY_TMUX_EXEC: "docker exec lvly-tmux-{slug} tmux" }, () => {
    assert.throws(
      () => tmuxArgvFor(null, TMUX),
      (e: unknown) => e instanceof Error && e.message.trim().length > 0,
      "컨텍스트를 잃은 것은 배선 버그다 — 로컬 tmux 로 접으면 안 된다",
    );
  });
});

test("★ §3 자리표시가 명령에 두 번 나오면 첫 번째만 바뀐다(종전 동작 보존)", () => {
  withEnv({ LIVELY_TMUX_EXEC: "relay {slug} --peer {slug}" }, () => {
    assert.deepEqual(tmuxArgvFor("acme", TMUX), ["relay", "acme", "--peer", "{slug}"]);
  });
});

test("§3 중계 자리에서는 tmux 바이너리 경로가 접두사에 끼어들지 않는다", () => {
  withEnv({ LIVELY_TMUX_EXEC: "ssh lvly-box tmux" }, () => {
    assert.equal(tmuxArgvFor("acme", "/nonexistent/tmux").includes("/nonexistent/tmux"), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §4. 언제 정해지고, 언제까지 안 변하나 (여기만 process.env 를 흔든다 — 반드시 원복 + 확정 해제)
// ════════════════════════════════════════════════════════════════════════════

test("§4 확정하지 않은 프로세스에서는 물을 때마다 지금 설정에서 파생한다", () => {
  withEnv({}, () => {
    unfreezeExecTopology();
    assert.equal(execTopology().sessionHost, "local");
    process.env.LIVELY_NODE_TOKEN = "nt-1";
    assert.equal(execTopology().sessionHost, "node", "확정 전이면 지금 설정을 따라간다");
    delete process.env.LIVELY_NODE_TOKEN;
    assert.equal(execTopology().sessionHost, "local");
  });
});

test("★ §4 확정하면 프로세스 수명 동안 답이 안 변한다 — 뒤에 설정값이 바뀌어도 그렇다", () => {
  withEnv({}, () => {
    unfreezeExecTopology();
    const frozen = freezeExecTopology();
    assert.equal(frozen.sessionHost, "local");
    process.env.LIVELY_NODE_TOKEN = "nt-1";
    process.env.LIVELY_TMUX_EXEC = "ssh box tmux";
    process.env.LIVELY_MEMBER_EXEC = "relay";
    process.env.LIVELY_ATTACH_WORKER_K = "4";
    assert.equal(execTopology().sessionHost, "local", "확정 뒤 env 변경은 답을 바꾸지 못한다");
    assert.equal(execTopology().tmux.kind, "socket");
    assert.equal(execTopology().storage, "colocated");
    assert.equal(execTopology().attachTransport, "inproc");
  });
});

test("★ §4 확정을 되돌리면 다시 지금 설정에서 파생한다(시험이 표면을 갈아가며 잰다)", () => {
  withEnv({}, () => {
    unfreezeExecTopology();
    freezeExecTopology();
    process.env.LIVELY_NODE_TOKEN = "nt-1";
    assert.equal(execTopology().sessionHost, "local", "아직 확정 상태다");
    unfreezeExecTopology();
    assert.equal(execTopology().sessionHost, "node", "확정 해제 뒤에는 다시 변한다");
  });
});

test("§4 freezeExecTopology 는 확정한 값을 돌려주고, 명시 env 로도 확정할 수 있다", () => {
  withEnv({}, () => {
    unfreezeExecTopology();
    const frozen = freezeExecTopology(E({ ...MANAGED }));
    assert.equal(frozen.sessionHost, "relay");
    assert.equal(frozen.storage, "detached");
    assert.deepEqual(execTopology(), frozen, "확정 뒤 execTopology() 는 확정한 그 값이다");
  });
});

test("★ §4 computeExecTopology 는 순수 — 확정 상태와 무관하게 준 env 로만 파생한다", () => {
  withEnv({}, () => {
    unfreezeExecTopology();
    freezeExecTopology(E({ LIVELY_NODE_TOKEN: "nt-1" }));
    assert.equal(execTopology().sessionHost, "node");
    assert.equal(computeExecTopology(E()).sessionHost, "local", "준 env 만 본다 — 확정값을 돌려주면 안 된다");
    assert.equal(computeExecTopology(E({ LIVELY_TMUX_EXEC: "ssh box tmux" })).sessionHost, "relay");
  });
});

test("§4 확정은 onNode()·tmuxArgvFor() 에도 함께 적용된다 — 표면마다 답이 갈리면 안 된다", () => {
  withEnv({ LIVELY_TENANCY_MODE: "registry" }, () => {
    unfreezeExecTopology();
    assert.equal(onNode(), false);
    assert.deepEqual(tmuxArgvFor("acme", TMUX), [TMUX, "-L", "lvly-acme"]);
    freezeExecTopology();
    process.env.LIVELY_NODE_TOKEN = "nt-1";
    delete process.env.LIVELY_TENANCY_MODE;
    assert.equal(onNode(), false, "확정 뒤 노드 토큰이 생겨도 답은 그대로다");
    assert.deepEqual(tmuxArgvFor("acme", TMUX), [TMUX, "-L", "lvly-acme"], "확정 뒤 모드가 사라져도 자리는 그대로다");
  });
});

test("§4 부팅 순서 — 확정 뒤에 워크스페이스 모드를 써 넣어도 tmux 자리는 안 변한다(확정은 그 단계 뒤여야 한다)", () => {
  withEnv({}, () => {
    unfreezeExecTopology();
    freezeExecTopology();
    process.env.LIVELY_TENANCY_MODE = "registry";
    assert.equal(execTopology().tmux.kind, "socket");
    assert.deepEqual(tmuxArgvFor("acme", TMUX), [], "확정 시점에 registry 가 아니었으면 기본 소켓 그대로다");
  });
});

test("§4 onNode() 는 노드 인증값의 유무를 그대로 답한다(공백 하나도 있음)", () => {
  withEnv({}, () => {
    unfreezeExecTopology();
    assert.equal(onNode(), false);
  });
  withEnv({ LIVELY_NODE_TOKEN: "nt-1" }, () => {
    unfreezeExecTopology();
    assert.equal(onNode(), true);
  });
  withEnv({ LIVELY_NODE_TOKEN: " " }, () => {
    unfreezeExecTopology();
    assert.equal(onNode(), true, "공백 하나여도 노드다");
  });
  withEnv({ LIVELY_NODE_TOKEN: "" }, () => {
    unfreezeExecTopology();
    assert.equal(onNode(), false, "빈 문자열은 없음이다");
  });
});

test("§4 computeExecTopology() 를 인자 없이 부르면 지금 process.env 에서 파생한다", () => {
  withEnv({ LIVELY_NODE_TOKEN: "nt-1" }, () => {
    unfreezeExecTopology();
    assert.equal(computeExecTopology().sessionHost, "node");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §5. 노드 등록 모순 — 게이트웨이 박스 위의 노드 (세션호스트 3값 × 증거 2값)
// ════════════════════════════════════════════════════════════════════════════

const LOCAL_T = computeExecTopology(E());
const RELAY_T = computeExecTopology(E({ LIVELY_TMUX_EXEC: "ssh box tmux" }));
const NODE_T = computeExecTopology(E({ LIVELY_NODE_TOKEN: "nt-1" }));

test("★ §5 같은 호스트 + 증거 양성 → 모순이고, 사람이 읽을 사유가 함께 온다", () => {
  const got = nodeSelfConflict({ sharesGatewayTmux: true }, LOCAL_T);
  assert.notEqual(got, null, "게이트웨이 박스 위의 노드는 모순이다");
  assert.equal(typeof got?.reason, "string");
  assert.ok((got?.reason ?? "").trim().length > 0, "사유가 비어 있으면 안 된다");
  assert.ok((got?.reason ?? "").trim().length >= 8, "사유는 사람이 읽고 무엇을 해야 하는지 알 수 있어야 한다");
});

test("§5 같은 호스트 + 증거 음성 → 모순 아님 (여기서의 «아님» 은 판정 보류를 포함한다)", () => {
  assert.equal(
    nodeSelfConflict({ sharesGatewayTmux: false }, LOCAL_T),
    null,
    "겹침이 없다는 것을 «자기 자신이 아니다» 로 뒤집으면 안 된다 — 세션이 0개면 볼 것이 없을 뿐이다",
  );
});

test("★ §5 중계 너머 + 증거 양성 → 모순 아님 (게이트웨이의 tmux 가 이 호스트에 없다)", () => {
  assert.equal(nodeSelfConflict({ sharesGatewayTmux: true }, RELAY_T), null);
});

test("§5 중계 너머 + 증거 음성 → 모순 아님", () => {
  assert.equal(nodeSelfConflict({ sharesGatewayTmux: false }, RELAY_T), null);
});

test("★ §5 노드 + 증거 양성 → 모순 아님 (세션 호스트가 «같은 호스트» 가 아니면 성립하지 않는다)", () => {
  assert.equal(nodeSelfConflict({ sharesGatewayTmux: true }, NODE_T), null);
});

test("§5 노드 + 증거 음성 → 모순 아님", () => {
  assert.equal(nodeSelfConflict({ sharesGatewayTmux: false }, NODE_T), null);
});

test("§5 토폴로지를 안 주면 이 프로세스의 토폴로지로 판정한다", () => {
  withEnv({}, () => {
    unfreezeExecTopology();
    assert.notEqual(nodeSelfConflict({ sharesGatewayTmux: true }), null, "설정 없는 배포는 같은 호스트다");
    assert.equal(nodeSelfConflict({ sharesGatewayTmux: false }), null);
  });
  withEnv({ LIVELY_NODE_TOKEN: "nt-1" }, () => {
    unfreezeExecTopology();
    assert.equal(nodeSelfConflict({ sharesGatewayTmux: true }), null, "노드에서는 성립하지 않는다");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §7. 무회귀 — 이 변경으로 동작이 바뀌면 안 되는 것
// ════════════════════════════════════════════════════════════════════════════

test("★ §7 설정이 아무것도 없는 배포의 값 한 벌 — 종전과 100% 같다(골든)", () => {
  assert.deepEqual(computeExecTopology(E()), {
    sessionHost: "local",
    tmux: { kind: "socket", socket: null },
    isolation: "os-user",
    attachTransport: "inproc",
    storage: "colocated",
    hooks: {
      sessionEnsure: "",
      sessionExec: "",
      memberExec: "",
      sessionSpawn: "",
      boxSpawn: "/opt/lively/libexec/box-spawn",
      boxCgspawn: "/opt/lively/libexec/box-cgspawn",
    },
    nodeToken: "",
    attachWorkerK: 0,
  });
});

test("★ §7 멤버 uid 강하 wrapper·cgroup wrapper 의 기본 설치 경로 문자열이 같다", () => {
  const hooks = computeExecTopology(E()).hooks;
  assert.equal(hooks.boxSpawn, "/opt/lively/libexec/box-spawn");
  assert.equal(hooks.boxCgspawn, "/opt/lively/libexec/box-cgspawn");
});

test("§7 wrapper 경로는 설정으로 덮어쓸 수 있다", () => {
  const hooks = computeExecTopology(E({
    LIVELY_BOX_SPAWN: "/usr/local/libexec/box-spawn",
    LIVELY_BOX_CGSPAWN: "/usr/local/libexec/box-cgspawn",
  })).hooks;
  assert.equal(hooks.boxSpawn, "/usr/local/libexec/box-spawn");
  assert.equal(hooks.boxCgspawn, "/usr/local/libexec/box-cgspawn");
});

test("§7 훅 문자열은 설정값을 그대로 실어 나른다(«» = 없음)", () => {
  const hooks = computeExecTopology(E({ ...MANAGED, LIVELY_SESSION_SPAWN: "/opt/lively/libexec/session-spawn" })).hooks;
  assert.equal(hooks.sessionEnsure, MANAGED.LIVELY_SESSION_ENSURE);
  assert.equal(hooks.sessionExec, MANAGED.LIVELY_SESSION_EXEC);
  assert.equal(hooks.memberExec, MANAGED.LIVELY_MEMBER_EXEC);
  assert.equal(hooks.sessionSpawn, "/opt/lively/libexec/session-spawn");
});

test("★ §7 매니지드의 tmux 중계 argv 조립 결과가 같다", () => {
  withEnv(MANAGED, () => {
    assert.deepEqual(tmuxArgvFor("acme", TMUX), ["docker", "exec", "lvly-tmux-acme", "tmux"]);
  });
});

test("★ §7 registry secondary 의 소켓 이름이 같다 — `-L lvly-<워크스페이스>`", () => {
  withEnv({ LIVELY_TENANCY_MODE: "registry" }, () => {
    assert.deepEqual(tmuxArgvFor("acme", TMUX), [TMUX, "-L", "lvly-acme"]);
    assert.deepEqual(tmuxArgvFor("primary", TMUX), [], "primary 만은 기본 소켓 그대로다");
  });
});

test("★ §7 격리 킬스위치의 의미가 같다 — off 만 끄고 나머지는 전부 켠다", () => {
  assert.equal(computeExecTopology(E({ LIVELY_MEMBER_ISOLATION: "off" })).isolation, "none");
  for (const v of [undefined, "", "on", "os", "1", "OFF"]) {
    assert.notEqual(computeExecTopology(E({ LIVELY_MEMBER_ISOLATION: v })).isolation, "none");
  }
});
