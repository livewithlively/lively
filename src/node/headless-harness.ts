// 헤드리스 하네스 선택(#1884) — 위탁·크론(증류·분류·관리·agent_headless)·delegate_run 이 **어느 CLI 로 돌지** 정한다.
//
// 왜 필요한가: 헤드리스 잡은 여태 org_task.harness 를 안 쓰고 DB 기본값 'claude' 로 떴다. 매니지드 테넌트에서
//  **codex 로만** 로그인한 멤버가 파이프라인을 켜면(T9 관문은 #1884 로 codex 로그인도 인정한다) 모든 잡이 자격 없는
//  `claude -p` 로 떠서 무출력 hang(#1101 부류) → stall 종결이 됐다. 로그인 판정과 실행 하네스가 어긋나 있었다.
//
// 규칙(순서가 전부다):
//  ① 명시(잡 params.harness · delegate_run harness) — 유효하면 그대로, 헤드리스 불가 하네스면 **던진다**(조용히 바꾸지 않는다).
//  ② 의뢰자가 로그인한 하네스 ∩ 헤드리스 규약을 아는 하네스(tasks.ts HEADLESS 표) [∩ 노드가 띄울 수 있는 것]
//     — 둘 이상이면 claude 우선(claude 사용자는 종전과 바이트 동일), 아니면 HEADLESS 표 순(로그인 나열 순이 아니다 — 결정적).
//  ③ 아무것도 모르면 claude(종전 기본 — 프로브 실패·미프로비저닝·비격리 박스의 '모름'을 전부 여기로 접는다).
//
// ⚠ 게이트웨이 전용이다 — profiles(DB·drop-priv)를 읽는다. 노드 번들(tasks.ts 가 끌려가는 쪽)에서 import 하지 말 것.
import { HEADLESS } from "./tasks.js";
import { memberUsableHarnesses } from "../terminal/profiles.js";   // #1631 — 자격 파일 없는 하네스(제미나이)를 잃지 않는다
import { logger } from "../log.js";

/** 헤드리스 규약을 아는 하네스 — 표 순서가 곧 동률 판정 순서다(claude, codex, antigravity, grok). */
export const HEADLESS_KEYS: readonly string[] = Object.keys(HEADLESS);

/** (순수 — 테스트 seam) 선택 규칙 그 자체. 프로브는 하지 않는다. */
export function pickHeadlessHarness(i: { explicit?: string | null; loggedIn: readonly string[]; nodeSupports?: readonly string[] | null }): string {
  const explicit = String(i.explicit ?? "").trim();
  if (explicit) {
    if (!HEADLESS_KEYS.includes(explicit)) {
      throw new Error(`위탁을 지원하지 않는 하네스입니다: ${explicit}(지원: ${HEADLESS_KEYS.join(", ")})`);
    }
    return explicit;
  }
  const logged = new Set(i.loggedIn);
  const node = i.nodeSupports == null ? null : new Set(i.nodeSupports);
  const candidates = HEADLESS_KEYS.filter((k) => logged.has(k) && (!node || node.has(k)));
  if (!candidates.length) return "claude";
  return candidates.includes("claude") ? "claude" : candidates[0];
}

/**
 * 맥락 잡 **샌드박스 판**의 실행 하네스(#4052 후속) — 대화형 로그인을 재지 않고 **저장된 헤드리스 자격**으로 고른다.
 *
 *  왜: 샌드박스 판은 멤버의 대화형 로그인이 아니라 멤버 비밀(sandbox-credentials SANDBOX_CREDS)로 돈다(#4012 T2).
 *   그런데 종전엔 이 판도 resolveHeadlessHarness → memberUsableHarnesses 를 거쳤고, 로그인 파일이 없으면 **프로브**가 돌아
 *   그 멤버 자리에 «AI 로그인 (antigravity)» 세션을 띄웠다(ai-login-run.ensureHarnessSeat). 크론이 주기마다 부르니 사람이
 *   한 번도 안 들어온 새 워크스페이스에도 그 세션이 «일하는 중» 으로 남아 관리 서버가 테넌트를 재우지 못했다
 *   (실측 2026-09-17 sangmin-yoon-37de: 분류 잡이 돈 05:09·06:13 에 하나씩 · 절전 «busy» 보류). 자리 기억이 게이트웨이
 *   메모리라 교대마다 새 자리가 또 생긴다. 프로브의 전제(«사람이 AI 연결을 하려는 순간») 가 크론에선 성립하지 않는다.
 *  규칙: 명시가 있으면 종전처럼 검증만 한다. 없으면 자격이 있는 하네스 중 claude 우선, 하나도 없으면 claude —
 *   그 경우 배정이 no_credential 로 정직하게 끝나고 멤버에게 알린다(task-scheduler, 종전과 같은 끝).
 *  자격 조회가 실패하면 그 하네스는 «자격 없음» 으로 본다(던지지 않는다 — 잡이 멈추지 않게).
 */
export async function resolveSandboxHarness(
  memberId: string,
  explicit?: string | null,
  hasCred: (memberId: string, harness: string) => Promise<boolean> = defaultHasSandboxCred,
): Promise<string> {
  const ex = String(explicit ?? "").trim();
  if (ex) return pickHeadlessHarness({ explicit: ex, loggedIn: [] });
  const { SANDBOX_CREDS } = await import("./sandbox-credentials.js");
  const withCred: string[] = [];
  for (const h of Object.keys(SANDBOX_CREDS)) {
    if (await hasCred(memberId, h).catch(() => false)) withCred.push(h);
  }
  const picked = pickHeadlessHarness({ loggedIn: withCred });
  logger.debug({ member: memberId, harness: picked, withCred }, `샌드박스 판 하네스 선택: ${picked} — 저장된 자격 [${withCred.join(",")}]`);
  return picked;
}

async function defaultHasSandboxCred(memberId: string, harness: string): Promise<boolean> {
  const { sandboxLeaseFor } = await import("./sandbox-credentials.js");
  return !!(await sandboxLeaseFor({ requester: memberId, harness }));
}

/**
 * 의뢰자(멤버 id/이메일) 기준으로 실행 하네스를 정한다. 명시가 있으면 프로브 없이 검증만 한다(무효면 던진다).
 *  프로브(로그인 확인)가 실패해도 던지지 않는다 — 종전 기본(claude)으로 접어 잡이 멈추지 않게 한다.
 */
export async function resolveHeadlessHarness(memberId: string, explicit?: string | null): Promise<string> {
  const ex = String(explicit ?? "").trim();
  if (ex) return pickHeadlessHarness({ explicit: ex, loggedIn: [] });
  let loggedIn: string[] = [];
  let why: string;
  try {
    loggedIn = await memberUsableHarnesses(memberId);
    why = loggedIn.length ? `로그인 [${loggedIn.join(",")}]` : "로그인 확인된 하네스 없음 → 기본";
  } catch (e) {
    why = `로그인 프로브 실패(${(e as Error)?.message ?? String(e)}) → 기본`;
  }
  const picked = pickHeadlessHarness({ loggedIn });
  logger.debug({ member: memberId, harness: picked, loggedIn }, `헤드리스 하네스 선택: ${picked} — ${why}`);
  return picked;
}
