// delivery ▸ connect-session — 외부 앱 연결 세션 열기(#4970).
//
//  처음 설정의 마지막 물음 «외부 앱을 연결하시겠어요?» 에 [연결할게요]를 누른 사람, 그리고 [외부 앱 연결] 화면의 [연결 도와줘]를
//   누른 사람에게 **보통 세션 하나**를 열어 준다. 첫 지시는 연결 스킬(liv-connect)을 부르는 말이고, 그 말은 사람에게 그대로 보인다
//   (종전 리브 킥오프의 첫 지시는 숨김 턴이었다 — 숨길 이유가 없고, 사람이 같은 말을 나중에 자기 AI 에서 다시 쓸 수 있다).
//
//  ── 왜 리브 킥오프를 버렸나 ──
//  처음 설정이 «Claude 로그인 → 리브 세션» 에 묶여 있어서, 로그인된 서버 AI 가 없거나(커서만 쓰는 사람) Claude 가 아니면 막다른 길이었다.
//   이제 갈림은 «AI 가 있나» 하나다: 있으면 이 문이 세션을 열고, 없으면 `{ai:false}` 를 돌려 화면이 «쓰는 AI 에서 하기» 를 그린다.
//   매니지드·셀프호스트의 연결법 차이와 관리 권한 갈림은 세션 안의 연결 스킬이 서비스마다 상태 × 권한으로 정한다.
//
//  ── 규칙 ──
//  · 세션 종류는 task — 첫 지시가 서버가 정한 말이라 이름 짓기·첫 지시 프로젝트 자동 생성(과 그 승인 질문)을 건너뛴다(#1979 항목4).
//  · 작업 폴더는 개인 루트 그 자체 — 라이블리 자리라 신뢰 대화상자를 세션 생성이 대신 넘긴다(session-create-guards autoTrustWorkspace).
//    리브 폴더(liv)가 아니다: 거기서 열면 리브 부팅 훅이 리브 정체성·현황을 넣어 연결 대화가 점검 대화로 샌다.
//  · 하네스는 그 사람이 로그인한 것 가운데 첫 번째 — 특정 하네스를 우대하지 않는다(종전 킥오프의 claude 우선을 뺐다).
//  · 멱등 — 좌표(liv_profile.connect_session, 워크스페이스 층)를 남겨 다시 눌러도 같은 세션으로 간다. 그 세션이 휴지통에 있거나
//    남의 것이면 새로 연다. 복원으로 id 가 바뀌었으면 이정표를 따라가 고쳐 적는다(리브 좌표와 같은 판정 — pickLivSession).
//  · ⚠ 좌표를 welcome.session_id 에 넣지 않는다 — 거기 있으면 리브 2턴(증류 지시) 후보가 돼 연결 대화 한복판에 서버 지시가 끼어든다.
import type { Capability } from "../types.js";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { restRead } from "./shared.js";

/** 세션 이름 — 세션 목록에서 이 대화를 알아보는 이름이다. */
export const CONNECT_SESSION_LABEL = "외부 앱 연결";
/** 첫 지시 — 사람에게 보이는 말 그대로다. 스킬 이름을 넣어 자동 호출이 빗나가도 사람이 알아본다. */
export const CONNECT_FIRST_PROMPT = "liv-connect 스킬로 이 워크스페이스의 외부 앱 연결을 도와줘.";

/** (순수) 세션을 띄울 하네스 — 로그인된 것(usable 순서) 가운데 세션으로 띄울 수 있는 첫 번째. 없으면 null. */
export function pickConnectHarness(usable: readonly string[], launchable: readonly string[]): string | null {
  for (const k of usable) if (k && k !== "shell" && launchable.includes(k)) return k;
  return null;
}

export type ConnectOpenResult =
  | { ai: true; session_id: string; href: string; reused: true }
  | { ai: true; session_id: string; href: string; reused: false; harness: string; session: unknown; initialPrompt: string }
  | { ai: false; reason: "ai-not-connected" };

/** 화면이 갈 곳 — 세션 화면. */
export const connectSessionHref = (id: string): string => `#/s/${encodeURIComponent(id)}`;

/** 의존(시험 seam) — 실제 구현은 아래 realDeps. */
export interface ConnectOpenDeps {
  /** 남겨 둔 좌표가 가리키는 지금의 세션(없거나 버렸으면 null). */
  current: (userId: string) => Promise<string | null>;
  /** 이 사람이 로그인한 하네스(순서 그대로). */
  usable: (userId: string) => Promise<string[]>;
  /** 세션으로 띄울 수 있는 하네스. */
  launchable: () => Promise<readonly string[]>;
  /** 세션을 연다. */
  launch: (user: LivelyUser, harness: string) => Promise<{ id: string; session: unknown }>;
  /** 좌표를 남긴다. */
  remember: (userId: string, sessionId: string) => Promise<unknown>;
}

/** 연결 세션 열기 — 판정 순서: 남은 세션 → AI 확인 → 새로 열기. 좌표 기록 실패는 세션을 막지 않는다(다음 클릭이 하나 더 열 뿐이다). */
export async function openConnectSession(user: LivelyUser, d: ConnectOpenDeps): Promise<ConnectOpenResult> {
  const userId = String(user?.userId ?? "");
  if (!userId) throw new HttpError(401, "인증이 필요합니다");
  const cur = await d.current(userId).catch(() => null);
  if (cur) return { ai: true, session_id: cur, href: connectSessionHref(cur), reused: true };
  //  로그인 확인은 비싸다(자격 파일이 없을 때 프로브 — 실측 4.3초·상한 25초). 남은 세션이 있으면 묻지 않는다(위).
  const [usable, launchable] = await Promise.all([d.usable(userId).catch(() => [] as string[]), d.launchable()]);
  const harness = pickConnectHarness(usable, launchable);
  if (!harness) return { ai: false, reason: "ai-not-connected" };
  const made = await d.launch(user, harness);
  await d.remember(userId, made.id).catch(() => { /* 비치명 — 위 머리말 */ });
  return { ai: true, session_id: made.id, href: connectSessionHref(made.id), reused: false, harness, session: made.session, initialPrompt: CONNECT_FIRST_PROMPT };
}

const realDeps: ConnectOpenDeps = {
  current: async (userId) => {
    const { getLivProfile, setConnectSession } = await import("../../org/store.js");
    const prof = await getLivProfile(userId).catch(() => null);
    const stored = String(prof?.connect_session?.id ?? "").trim() || null;
    if (!stored) return null;
    const { getSessionState, resolveSessionSuccessor } = await import("../../sessions/session-state.js");
    const { trashMarkedIds } = await import("../../sessions/session-trash.js");
    const { pickLivSession } = await import("../../org/liv/session.js");
    const [state, trashedIds] = await Promise.all([
      getSessionState(stored).catch(() => undefined),
      trashMarkedIds(userId, [stored]).catch(() => [] as string[]),
    ]);
    const alive = !!state && !state.superseded_by;
    const successor = alive ? null : await resolveSessionSuccessor(stored).catch(() => null);
    //  판정은 리브 좌표와 같다(버린 세션·남의 세션은 없다 · 이어졌으면 사슬의 끝).
    const id = pickLivSession({ stored, state: state ?? null, successor, trashed: trashedIds.length > 0, me: userId });
    if (id && id !== stored) await setConnectSession(userId, { id, at: new Date().toISOString() }).catch(() => { /* 비치명 */ });
    return id;
  },
  usable: async (userId) => {
    const { memberUsableHarnesses } = await import("../../terminal/profiles.js");
    return memberUsableHarnesses(userId);
  },
  launchable: async () => {
    const { HARNESSES } = await import("../../terminal/catalog.js");
    return HARNESSES.map((h) => h.key).filter((k) => k !== "shell");
  },
  launch: async (user, harness) => {
    const { launchSession } = await import("../../terminal/session-launch.js");
    const session = await launchSession(user, {
      kind: "task",
      label: CONNECT_SESSION_LABEL,
      rootKey: "personal", subpath: "",
      harness, flags: {}, autoApprove: false,
      initialPrompt: CONNECT_FIRST_PROMPT,
    }, { nodeId: "", invites: [] });
    return { id: session.id, session };
  },
  remember: async (userId, sessionId) => {
    const { setConnectSession } = await import("../../org/store.js");
    return setConnectSession(userId, { id: sessionId, at: new Date().toISOString() });
  },
};

export const connectSessionCapabilities: Capability[] = [
  restRead("me_connect_session_open", "외부 앱 연결 세션 열기",
    "외부 앱 연결을 도와줄 보통 세션을 연다(로그인한 AI 로, 첫 지시 = liv-connect 스킬 호출). 이미 연 세션이 있으면 그 세션을 돌려준다. " +
    "로그인한 AI 가 없으면 세션을 열지 않고 ai:false 를 돌려준다 — 그때 화면은 «쓰는 AI 에서 하기»(데스크톱 앱 설치 후 그 AI 에 말하기)를 안내한다. " +
    "사람이 처음 설정·[외부 앱 연결] 화면에서 누르는 문이다.",
    [{ method: "POST", paths: ["/api/ui/me/connect-session"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => openConnectSession(user, realDeps),
    false, {}),
];
