// codex 세션의 모델·추론강도 바꾸기 — **그 자리에서 치나, 새 설정으로 이어 여나** (#5332).
//
//  ── 왜 갈래가 둘인가 (실측 2026-11-06) ─────────────────────────────────────────────
//  · 0.166.0 은 입력칸에 `/model <모델> --reasoning=<강도>` 한 줄을 치면 그 자리에서 바뀐다(다음 턴부터).
//  · 0.157.1 — 테넌트 이미지가 싣는 판(lvly-cloud tenant-image CODEX_VERSION)이고 중앙 박스의 판이다 — 은 `/model` 뒤의 인자를
//    **모른다.** `/model gpt-6-luna` 조차 명령이 아니라 **사람의 말로 AI 에게 보낸다**(실측: «› /model gpt-6-luna» 가 대화에 올라가고
//    «Working» 이 돈다). 드롭다운을 한 번 바꾸면 엉뚱한 턴이 돌고, 화면은 «바꿨어요» 라고 말한다 — «드롭다운 바꾸면 뻑난다» 의 정체다.
//    인자 없는 `/model` 은 번호 목록을 띄우는데, 그 목록을 화면 읽기로 몰고 가는 것은 판마다 깨진다.
//  그래서 판을 보고 고른다: 인자를 아는 판(≥ CODEX_INLINE_SWITCH_MIN)이면 그 자리에서, 아니면(또는 판을 모르면) **같은 대화를
//  새 플래그로 이어 연다**(세션 보관 → 복원 — 복원이 `codex resume <대화> --model … --config model_reasoning_effort=…` 로 띄운다).
//  이어 열기는 모든 판에서 맞는 길이라, 모를 때 그쪽으로 기우는 것이 안전한 실패 방향이다(느릴 뿐 틀리지 않는다).
//
//  ── 판은 어디서 읽나 ─────────────────────────────────────────────────────────────
//  그 세션의 대화 파일(rollout) 첫 줄 session_meta 의 `cli_version` — **그 대화를 연 프로세스의 판**이다(실측: 첫 600바이트 안).
//  `codex --version` 은 그 세션이 도는 기계(세션 컨테이너·노드)에서 돌려야 해 게이트웨이가 바로 못 하고, 화면의 머리 배너는
//  긴 세션에서 스크롤백 밖으로 밀린다. 대화 파일이 아직 없으면(첫 턴 전) 모른다 → 이어 열기(잃을 대화가 없다).
//  ⚠ 이어 연 대화는 같은 파일에 덧붙는다 — 첫 줄은 처음 연 판이다. 판이 올라간 뒤라면 «옛 판» 으로 읽혀 이어 열기로 가는데,
//   그건 느릴 뿐 맞다. 내려간 경우(새 판으로 연 대화를 옛 판이 이어 쓰는)만 틀리고, 이미지 핀은 올라가기만 한다.

/** 입력칸 한 줄로 두 축을 바꿀 수 있는 첫 판 — 실측으로 확인한 판이다(0.157.1 은 못 한다). 사이 판은 재지 않아 보수적으로 둔다. */
export const CODEX_INLINE_SWITCH_MIN = "0.166.0";

/** 대화 파일 머리에서 `cli_version` 을 꺼낸다(순수). 못 찾으면 null. */
export function cliVersionFromRolloutHead(head: string): string | null {
  const m = /"cli_version"\s*:\s*"(\d+(?:\.\d+){1,3})[^"]*"/.exec(String(head || ""));
  return m ? m[1]! : null;
}

/** 점으로 나눈 숫자 판 비교(순수) — v ≥ min 이면 참. 숫자가 아닌 조각은 0 으로 본다. */
export function versionAtLeast(v: string, min: string): boolean {
  const a = String(v).split(".").map((x) => Number.parseInt(x, 10) || 0);
  const b = String(min).split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

export type CodexSwitchPlan = "inline" | "relaunch";

/** 판으로 갈래를 고른다(순수) — 모르면 이어 열기(머리말 «모를 때 그쪽으로 기우는 것이 안전»). */
export function codexSwitchPlan(version: string | null | undefined): CodexSwitchPlan {
  return version && versionAtLeast(version, CODEX_INLINE_SWITCH_MIN) ? "inline" : "relaunch";
}

/** 대화 파일 머리에서 읽는 바이트 — cli_version 은 실측 첫 600바이트 안이다(session_meta 줄 자체는 18~23KB). */
export const ROLLOUT_HEAD_BYTES = 4096;

export interface CodexVersionDeps {
  /** 이 게이트웨이가 읽을 수 있는 세션(중앙·세션 호스트)의 대화 파일 머리. 못 읽으면 null. */
  localHead: (sessionId: string) => Promise<string | null>;
  /** 노드 세션의 대화 파일 머리(그 컴퓨터의 chatTranscript op). 못 읽으면 null. */
  nodeHead: (nodeId: string, sessionId: string) => Promise<string | null>;
}

/** 그 세션의 codex 판 — 못 읽으면 null(호출자는 이어 열기로 간다). 던지지 않는다. */
export async function codexSessionCliVersion(sessionId: string, nodeId: string, deps?: Partial<CodexVersionDeps>): Promise<string | null> {
  const d: CodexVersionDeps = { localHead: deps?.localHead ?? localRolloutHead, nodeHead: deps?.nodeHead ?? nodeRolloutHead };
  try {
    const head = nodeId ? await d.nodeHead(nodeId, sessionId) : await d.localHead(sessionId);
    return head ? cliVersionFromRolloutHead(head) : null;
  } catch { return null; }
}

async function localRolloutHead(sessionId: string): Promise<string | null> {
  const { resolveTranscript } = await import("./transcript-locate.js");
  const t = await resolveTranscript(sessionId);
  if (!t.ok) return null;
  const { file, size } = t.found;
  const buf = await t.tfs.read(file, size, (r) => r.read(0, Math.min(size, ROLLOUT_HEAD_BYTES)));
  return Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf ?? "");
}

async function nodeRolloutHead(nodeId: string, sessionId: string): Promise<string | null> {
  const { getSessionState } = await import("../sessions/session-state.js");
  const st = await getSessionState(sessionId).catch(() => undefined);
  const threadId = String(st?.claude_session_id || "");
  if (!threadId) return null;
  const { nodeRpc } = await import("../node/registry.js");
  const r = await nodeRpc<{ found?: boolean; data?: string }>(nodeId, "chatTranscript", { id: sessionId, threadId, offset: 0, len: ROLLOUT_HEAD_BYTES });
  if (!r?.found || !r.data) return null;
  return Buffer.from(String(r.data), "base64").toString("utf8");
}
