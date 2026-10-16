// 검색 실패 보조 안내 · 단위 찾기(#4213 T12 #4744)의 **판정만** — 순수(DB·시계·네트워크 없음). 조회는 unit-find.ts.
//
//  ── 확정(상민님 2026-10-15) ──
//   지식 → 원문 자료 순으로 찾고, 둘 다 없거나 약하면 **질문한 사람이 다 볼 수 있는 단위만** 2~3개를 마지막 수집 시각과 함께
//   «가져올 곳» 으로 알려 준다(«2시간 전 수집 — 그 뒤 새 글이 필요하면 찾아보세요»). 세션이 직접 찾는 것은 약한 권유다 —
//   정상 주기라면 가치 있는 것은 이미 모였고, 새로 얻을 것은 «마지막 수집 이후의 새 글» 정도다. 백그라운드 대기열은 없다.
//
//  여기서 정하는 것:
//   ① 지식이 약한가 — 결과가 없거나, 질의 낱말이 다 든 지식이 없고 의미도 멀다(코사인 최고값 < WEAK_TOP_SIM · 못 재면 약한 쪽).
//   ② 단위가 이 주제와 맞나 — 이름·설명·연결된 맥락에 질의 낱말이 드나(조사를 뗀 꼴 · 같은 뜻 표기까지) + 설명 벡터의 의미 거리.
//   ③ 단위 한 줄의 안내 문구 — 마지막 수집 시각을 사람 말로.
import { parseQueryTerms, type QueryTerm } from "../../v6/query-terms.js";

/**
 * 지식 결과의 의미 거리 문턱 — 이보다 멀면(코사인 유사도가 낮으면) «약하다». bge-m3 기준이다. 세션 recall 훅의 게이트가 0.6 이고
 *  그 언저리(0.6~0.65)에 무관한 지식이 걸리는 것이 실측됐다(2026-10-17 세션 recall 표시 «유사도 61~62%» 의 무관 지식) — 안내가 붙는
 *  비용은 몇 줄이라 문턱을 조금 높여 약한 쪽으로 기운다.
 */
export const WEAK_TOP_SIM = 0.65;
/** 단위 설명 벡터의 의미 거리 문턱 — 설명이 짧아 지식보다 낮다. 이보다 멀면 낱말이 맞을 때만 고른다. */
export const UNIT_MIN_SIM = 0.5;
/** «가져올 곳» 으로 붙이는 단위 수(설계 «2~3개»). */
export const HINT_UNITS = 3;
/** 원문 자료 후보 수. */
export const HINT_SOURCES = 3;

/** ① 지식이 약한가. topSim 이 null(임베딩이 꺼졌거나 못 물었다)이면 낱말이 맞은 지식이 있어야 강하다. */
export function knowledgeWeak(input: { count: number; topSim: number | null; lexical: boolean }): { weak: boolean; reason: "empty" | "weak" | null } {
  if (input.count <= 0) return { weak: true, reason: "empty" };
  if (input.lexical) return { weak: false, reason: null };
  if (input.topSim != null && input.topSim >= WEAK_TOP_SIM) return { weak: false, reason: null };
  return { weak: true, reason: "weak" };
}

/** 단위의 «찾을 글» — 이름 · 설명 · 연결된 맥락(meta.context: 글이거나 글 목록 · 객체면 글 값만). 소문자. */
export function unitHaystack(u: { name: string | null; description: string | null; meta?: Record<string, unknown> | null; ref?: string | null }): string {
  const ctx = u.meta?.context;
  const ctxText = typeof ctx === "string" ? ctx
    : Array.isArray(ctx) ? ctx.filter((x) => typeof x === "string").join(" ")
      : ctx && typeof ctx === "object" ? Object.values(ctx as Record<string, unknown>).flatMap((v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === "string") : [])).join(" ")
        : "";
  return [u.name, u.description, ctxText].filter((x): x is string => typeof x === "string" && !!x).join("\n").toLowerCase();
}

/**
 * ② 낱말 맞춤 — 질의의 (군말이 아닌) 낱말 가운데 단위 글에 든 비율(0~1). 낱말은 친 그대로 · 조사를 뗀 꼴 · 같은 뜻 표기 중 하나가 들면 맞다.
 *  낱말이 전부 군말이면 군말도 센다(query-terms 규칙과 같다). 낱말이 없으면 0.
 *  맞음으로 치는 것은 둘 중 하나다 — 질의 낱말이 **단위 이름**(채널·페이지·라벨 이름 — 사람이 붙인 주제 이름표)에 들었거나, 이름 · 설명 ·
 *  맥락 전체에서 맞은 낱말이 문턱(termsNeeded — 둘 이하면 전부, 그보다 많으면 절반 이상) 이상이거나. 설명에 «일정» 같은 흔한 낱말 하나만
 *  스친 단위는 «가져올 곳» 으로 권하지 않는다(원문 자료와 같은 문턱). 이름에 든 낱말 하나로 맞은 단위는 비율이 낮아 점수도 낮다.
 */
export function textMatchScore(query: string, haystack: string, name?: string | null): number {
  const terms = parseQueryTerms(query);
  const must = terms.filter((t) => !t.optional);
  const use = must.length ? must : terms;
  if (!use.length) return 0;
  const inside = (text: string) => (t: QueryTerm) => [t.t, t.stem, ...(t.alts ?? [])].some((w) => w.length >= 2 && text.includes(w));
  const hit = use.filter(inside(haystack)).length;
  const nameHit = !!name && use.some(inside(name.toLowerCase()));
  return hit && (nameHit || hit >= termsNeeded(use.length)) ? hit / use.length : 0;
}

/**
 * 맞음 점수 — 의미(문턱 이상일 때만 그 값)와 낱말(맞은 비율이 있으면 0.5 + 0.4 × 비율 — 다 맞으면 0.9) 중 큰 값. 0 이면 안 맞는다.
 *  by = 무엇으로 맞았나(화면·세션이 «왜 이 단위인가» 를 말할 수 있게).
 */
export function unitMatch(sim: number | null, text: number): { score: number; by: "vector" | "text" | "both" | null } {
  const v = sim != null && sim >= UNIT_MIN_SIM ? sim : 0;
  const t = text > 0 ? 0.5 + 0.4 * Math.min(1, text) : 0;
  const score = Math.round(Math.max(v, t) * 1000) / 1000;
  return { score, by: v > 0 && t > 0 ? "both" : v > 0 ? "vector" : t > 0 ? "text" : null };
}

/**
 * 맞음으로 치려면 맞아야 하는 낱말 수(원문 자료 · 단위 공통) — 둘 이하면 전부, 그보다 많으면 절반 이상(올림). 자연어 질의(낱말 다섯)도 핵심
 *  낱말 몇 개가 든 곳을 잡되, 낱말 하나만 스친 곳으로 «원문이 있다» · «여기서 가져오라» 고 하지 않게.
 */
export function termsNeeded(terms: number): number {
  const n = Math.max(0, Math.floor(terms));
  return n <= 2 ? n : Math.ceil(n / 2);
}

const APP_LABEL: Record<string, string> = {
  slack: "슬랙", gmail: "지메일", notion: "노션", gdrive: "구글 드라이브", outlook: "아웃룩", github: "깃허브", gitlab: "깃랩",
  linear: "리니어", discord: "디스코드", figma: "피그마",
};
const KIND_LABEL: Record<string, string> = {
  channel: "채널", private_channel: "비공개 채널", group_dm: "여러 사람 대화", dm: "개인 대화", page: "페이지", database: "데이터베이스",
  mailbox: "메일함", label: "메일 라벨", repo: "저장소", project: "프로젝트", team: "팀", folder: "폴더", file: "파일",
};

/**
 * 단위의 «설명 벡터» 로 임베딩하는 글(설계 §3 — 설명을 임베딩한 것) — «앱 종류 이름» 머리 + 설명 + 연결된 맥락. 처음엔 설명이 비어
 *  이름만이지만(리브가 첫 수집 뒤 설명을 쓴다), 이름(«#결제-출시»)만으로도 주제가 어느 정도 맞는다. 8,000자에서 자른다(임베딩 입력 상한).
 */
export function unitEmbeddingText(u: { app: string; kind: string; name: string | null; description: string | null; meta?: Record<string, unknown> | null }): string {
  const head = [APP_LABEL[u.app] ?? u.app, KIND_LABEL[u.kind] ?? "", u.name ?? ""].map((x) => String(x).trim()).filter(Boolean).join(" ");
  const ctx = unitHaystack({ name: null, description: null, meta: u.meta ?? null });
  return [head, (u.description ?? "").trim(), ctx].filter(Boolean).join("\n\n").slice(0, 8000);
}

/** 몇 분·시간·일 전 — 사람 말로(«방금» · «12분 전» · «3시간 전» · «2일 전»). */
export function agoText(iso: string | null, nowMs: number): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

/**
 * ③ 단위 한 줄의 안내 — 마지막 수집 시각이 있으면 «N 전 수집 — 그 뒤 새 글이 필요하면 찾아보세요», 아직 안 모은 단위면
 *  «아직 모으지 않은 곳 — 필요하면 직접 찾아보세요». 문장은 세션이 사람에게 그대로 옮겨도 되게 끝맺는다.
 */
export function unitHintText(u: { read_at: string | null; state: string }, nowMs: number): string {
  const ago = agoText(u.read_at, nowMs);
  if (ago) return `${ago} 수집했습니다 — 그 뒤 새 글이 필요하면 이 커넥터로 직접 찾아보세요.`;
  return u.state === "active"
    ? "아직 첫 수집 전입니다 — 필요하면 이 커넥터로 직접 찾아보세요."
    : "아직 모으지 않는 곳입니다 — 필요하면 이 커넥터로 직접 찾아보세요.";
}
