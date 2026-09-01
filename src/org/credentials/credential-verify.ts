// 자격 연결 확인 (#1881 F9) — 붙여넣은 토큰이 **실제로 되는지** 그 자리에서 한 번 쳐 본다.
//
// ── 왜 필요한가 ────────────────────────────────────────────────────────────────────────
//  컴맹의 실패는 "못 하는 것"이 아니라 **"틀렸는지 모른 채 넘어가는 것"** 이다. 토큰은 붙여넣는 순간
//  형식 검사도 없이 저장되고, 오타·잘린 값·만료·허용범위 누락은 **한참 뒤 수집이 조용히 실패할 때** 드러난다.
//  실측(2026-08-26): 피그마 PAT 에 허용범위 하나가 빠져 팀 열거가 403 이었는데, 저장은 성공했고 화면은 멀쩡했다.
//  그런데 상류는 대개 **무엇이 잘못됐는지 정확히 말해 준다** — 피그마는 응답 본문에 빠진 스코프 이름을 적어 준다.
//  그 문장을 사람 말로 옮겨 저장 직후에 보여주면, 사용자는 남에게 묻지 않고 혼자 고친다.
//
// ── 규약 ───────────────────────────────────────────────────────────────────────────────
//  · 확인 호출은 **읽기 전용·부작용 없음**만 쓴다(/v1/me 처럼). 저장 검증이 남의 데이터를 건드리면 안 된다.
//  · 표에 없는 kind 는 'unsupported' — 저장은 정상이고 확인만 건너뛴다(모르는 것을 실패로 보이게 하지 않는다).
//  · 진단 문구는 **다음 행동**까지 말한다("다시 만들 때 그 항목을 켜 주세요"). 증상만 말하면 사용자는 멈춘다.

export interface VerifyResult {
  /** true=상류가 이 토큰을 받아들였다. false=거부. null=확인 경로가 없는 kind(=건너뜀). */
  ok: boolean | null;
  /** 사람이 읽는 한 줄. 성공이면 누구인지, 실패면 무엇을 어떻게 고치는지. */
  message: string;
  /** 성공 시 연결된 계정 표시(있으면). */
  who?: string | null;
}

/** 상류가 본문에 적어 준 '빠진 스코프' 이름들 — 피그마는 `Invalid scope(s): a, b. This endpoint requires the X scope` 로 준다. */
export function missingScopesFrom(text: string): string[] {
  const m = /requires? the ([a-z_:]+) scope/i.exec(text);
  return m ? [m[1]] : [];
}

/**
 * 피그마 응답 → 사람 말. **순수 함수**라 테스트가 상태코드×본문 표를 그대로 돈다.
 *  200 은 호출부가 다루고, 여기는 실패만 옮긴다.
 */
export function diagnoseFigma(status: number, text: string): string {
  if (status === 401 || /invalid_token|not_valid/i.test(text)) {
    return "토큰이 거부됐어요 — 만료됐거나 삭제된 토큰입니다. Figma 에서 새로 만들어 다시 붙여넣어 주세요.";
  }
  const missing = missingScopesFrom(text);
  if (missing.length) {
    return `토큰에 허용범위 ${missing.join(", ")} 가 없어요 — Figma 에서 토큰을 새로 만들 때 그 항목을 켜 주세요(기존 토큰은 범위를 나중에 바꿀 수 없습니다).`;
  }
  if (status === 403) {
    return "토큰이 이 계정 정보를 읽을 권한이 없어요 — 토큰을 만들 때 current_user:read 를 켰는지 확인해 주세요.";
  }
  if (status === 429) return "Figma 가 잠시 요청을 제한하고 있어요 — 잠깐 뒤 다시 시도해 주세요.";
  return `Figma 가 응답을 거부했어요(${status}). 토큰을 다시 확인해 주세요.`;
}

interface Verifier {
  label: string;
  url: string;
  headers: (token: string) => Record<string, string>;
  /** 200 응답 → 표시할 계정 이름(없으면 null). */
  who: (body: unknown) => string | null;
  diagnose: (status: number, text: string) => string;
}

// 확장 지점 — kind 를 늘릴 땐 여기 한 줄. ⚠ 실제로 쳐 보고 넣어라(문서만 보고 넣으면 이 기능이 거짓말을 한다).
const VERIFIERS: Record<string, Verifier> = {
  figma_token: {
    label: "Figma",
    url: "https://api.figma.com/v1/me",   // current_user:read 만 필요한 최소 호출(부작용 없음)
    headers: (t) => ({ "X-Figma-Token": t }),
    who: (b) => {
      const o = (b ?? {}) as { handle?: unknown; email?: unknown };
      const handle = typeof o.handle === "string" && o.handle ? o.handle : null;
      const email = typeof o.email === "string" && o.email ? o.email : null;
      if (handle && email) return `${handle} (${email})`;
      return handle ?? email;
    },
    diagnose: diagnoseFigma,
  },
};

/** ClickUp 응답 → 사람 말. 실측(2026-08-28): 틀린 토큰은 401 {"err":"Token invalid","ECODE":"OAUTH_0xx"}. */
export function diagnoseClickup(status: number, text: string): string {
  if (status === 401 || /token invalid|OAUTH_0/i.test(text)) {
    return "토큰이 거부됐어요 — 앞뒤가 잘렸거나 다시 만든 토큰입니다. ClickUp ▸ Settings ▸ Apps 에서 API Token 을 복사해 다시 붙여넣어 주세요.";
  }
  if (status === 429) return "ClickUp 이 잠시 요청을 제한하고 있어요 — 잠깐 뒤 다시 시도해 주세요.";
  return `ClickUp 이 응답을 거부했어요(${status}). 토큰을 다시 확인해 주세요.`;
}
VERIFIERS.clickup_token = {
  label: "ClickUp",
  url: "https://api.clickup.com/api/v2/user",   // 토큰의 주인 — 읽기 전용·부작용 없음
  headers: (t) => ({ Authorization: t }),         // ClickUp 개인 토큰은 Bearer 접두 없이 그대로
  who: (b) => {
    const u = ((b ?? {}) as { user?: { username?: unknown; email?: unknown } }).user ?? {};
    const name = typeof u.username === "string" && u.username ? u.username : null;
    const email = typeof u.email === "string" && u.email ? u.email : null;
    if (name && email) return `${name} (${email})`;
    return name ?? email;
  },
  diagnose: diagnoseClickup,
};

export function verifierExists(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(VERIFIERS, String(kind ?? "").toLowerCase());
}

/**
 * 토큰 한 개를 상류에 실제로 물어본다. 네트워크 실패는 **거부와 구분**한다 —
 *  "우리가 못 물어본 것"을 "토큰이 틀린 것"으로 말하면 사용자가 멀쩡한 토큰을 지운다.
 */
export async function verifyCredential(kind: string, token: string): Promise<VerifyResult> {
  const v = VERIFIERS[String(kind ?? "").toLowerCase()];
  if (!v) return { ok: null, message: "이 종류는 자동 확인을 지원하지 않아요 — 저장은 정상입니다." };
  if (!token) return { ok: false, message: "저장된 토큰이 없어요." };

  let res: Response;
  try {
    res = await fetch(v.url, { headers: v.headers(token), signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    return { ok: null, message: `${v.label} 에 연결하지 못했어요(네트워크) — 토큰 문제는 아닙니다. 잠시 뒤 다시 확인해 주세요.` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, message: v.diagnose(res.status, text) };
  }
  const body = await res.json().catch(() => null);
  const who = v.who(body);
  return { ok: true, who, message: who ? `${who} 계정으로 연결됐어요.` : `${v.label} 에 연결됐어요.` };
}
