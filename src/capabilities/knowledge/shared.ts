// 지식 표면 공용 유틸(#1313 R57) — knowledge.ts 도메인 분할 시 op 파일들이 함께 쓰던 가드·경고·상수를
//  여기 한 벌만 둔다(복제 금지 — 판정이 갈라지면 공개범위 게이트가 파일마다 달라진다).
//   · 공개범위(#1291) 게이트: assertKnowledgeVisible/Writable · filterVisibleByName
//   · 저장 응답 부가정보: classificationInfo(#1153) · seedSyncWarning(#846) · wikiLinkInfo(#907)
//   · 방어 상한/임계: BODY_MD_MAX(#534) · DEDUP_WARN_SIMILARITY(#172)
//  ⚠ members 지식 존재여부 캐시(restrictedKAt/restrictedK)는 모듈 전역 mutable 이라 그 유일 소비자
//   (anyRestrictedKnowledge)와 반드시 동거한다 — 다른 파일로 나누면 ESM import 바인딩이 재할당 불가다.
import { HttpError } from "../rest-util.js";
import type { WikiLinkResult } from "../../v6/knowledge-store.js";
import { checkKnowledgeClassification } from "../../v6/category-store.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_KNOWLEDGE } from "../../org/delivery/default-content.js";
import { canSeeKnowledge, type Viewer } from "../../v6/visibility.js";
import { anyRestrictedKnowledge } from "../../v6/knowledge-store.js";

// 공개범위(#1291) — name 을 가진 행 배열에서 안 보이는 것을 걸러낸다. 목록 표면 공용.
//  대부분의 조직에서 members 지식은 0건이라 첫 조회에서 바로 통과한다(문서마다 판정하지만 값싼 경로).
// members 지식이 하나라도 있나 — 목록 필터의 단축 판정용(5초 캐시).
let restrictedKAt = 0, restrictedK = false;
async function anyRestrictedKnowledgeCached(): Promise<boolean> {
  const now = Date.now();
  if (now - restrictedKAt < 5_000) return restrictedK;
  try {
    restrictedK = await anyRestrictedKnowledge(); restrictedKAt = now;
  } catch { restrictedK = true; }   // 판정 불가면 개별 판정으로(닫는 쪽)
  return restrictedK;
}

// 쓰기 전 게이트 — 안 보이는 문서는 고칠 수도, 지울 수도, 옮길 수도 없다.
//  ⚠ **신규 생성은 막지 않는다**: name 은 조직 전체에서 하나뿐이라 "그 이름을 쓸 수 있나"가 곧 존재 여부가 된다.
//   그래서 이름 충돌 사실 자체는 감추지 않되(=전역 유일 네임스페이스는 비밀이 아니다), 안 보이는 문서를
//   덮어쓰는 것만은 확실히 막는다 — 그게 진짜 피해(비가시 본문 파괴·탈취)다.
// 읽기 게이트 — 문서의 **곁가지**(댓글·유사도 기준점 등 이름으로 여는 하위 표면)도 본문과 같은 판정을 탄다.
//  본문만 막고 곁가지를 열어두면 "댓글로 내용을 되읽는" 우회로가 생긴다. 문구는 없는 문서와 동일(존재 은닉).
export async function assertKnowledgeVisible(name: unknown, viewer: Viewer): Promise<void> {
  if (viewer === null || !name) return;
  if (!(await canSeeKnowledge(String(name), viewer))) throw new HttpError(404, `지식 '${String(name)}' 없음`);
}
// 쓰기 게이트 = 읽기 게이트와 **같은 판정**이다(볼 수 없으면 고칠 수도 없다). 이름을 나눠 둔 건 호출부에서
//  '왜 막는가'가 드러나게 하려는 것뿐 — 판정이 갈라지지 않도록 구현은 위 하나에 위임한다.
export const assertKnowledgeWritable = assertKnowledgeVisible;

export async function filterVisibleByName<T extends { name?: unknown }>(rows: T[], viewer: Viewer): Promise<T[]> {
  if (viewer === null || !rows.length) return rows;
  // 조직에 대상 제한 지식이 하나도 없으면(대부분의 조직) 행마다 판정할 필요가 없다 — 한 번 물어보고 끝낸다.
  if (!(await anyRestrictedKnowledgeCached())) return rows;
  const out: T[] = [];
  for (const r of rows) {
    if (!r?.name || await canSeeKnowledge(String(r.name), viewer)) out.push(r);
  }
  return out;
}

// 저장-시 중복감지(#172) — 신규 지식이 이 코사인 유사도 이상의 기존 지식과 겹치면 응답에 경고(비차단).
//  bge-m3 코사인 기준 보수적 임계(오탐 억제). 프로젝트 규칙 "새로 만들기 전 비슷한 거 찾기" 의 자동화.
export const DEDUP_WARN_SIMILARITY = 0.6;

// 저장 본문 방어 상한 — zod(신규·교체 입력)와 append 결과에 같은 값을 쓴다(불변식 "저장된 본문 ≤ 이 값").
//  append 가 이 상한을 결과에도 걸어야 하는 이유: zod 는 append 에선 '조각'만 재니, 안 걸면 base 199k + chunk 200k 가
//  그대로 저장되고 — 그 문서는 그 순간부터 replace 로도 웹 편집기로도 저장 불가가 된다(되보내면 zod 가 튕김).
//  즉 상한 초과는 문서를 '더 키우는 것 말곤 손댈 수 없는' 상태로 잠그는 one-way door 라 결과에서 막는다.
export const BODY_MD_MAX = 200_000;

// ── 시딩 지식 편집 경고(#846) — 고객 박스에 시딩되는 런북을 이 WIKI 에서 고치면, 고객이 받는 본문은
//  여기가 아니라 src/org/delivery/seed-knowledge/<name>.md 의 각색 스냅샷이다(#846 이후 분리). 그 파일을 함께
//  갱신하라고 저장 응답으로 알린다(정방향 드리프트 방지). seed 는 이제 DB 캡처가 아니라 파일이 SoT 라
//  자동 동기화되지 않는다 — 사람 리마인더가 유일한 연결고리다.
const SEEDED_KNOWLEDGE_NAMES = new Set(DEFAULT_KNOWLEDGE.map((k) => k.name));
//  경고는 seed 소스가 실재하는 곳(우리 canonical 체크아웃 — src/ 포함)에서만 뜬다. 고객 릴리스 번들엔
//  src/ 가 없으므로(release.yml: dist·public·kit…만 실림) 고객 박스에선 이 경고가 뜨지 않는다 —
//  안 그러면 고객에게 없는 내부 경로를 노출하게 된다(유출 방지하려다 유출하는 역설 회피).
//  ⚠ 상대깊이는 **컴파일 산출물 기준**이다(dist/capabilities/knowledge/shared.js → ".."×3 = 레포루트).
//   #1313 R57 에서 capabilities/ → capabilities/knowledge/ 로 한 층 깊어지며 ".." 를 하나 더 얹었다.
//   이 파일이 또 옮겨지면 여기도 함께 고쳐라 — 어긋나도 예외 없이 조용히 false 가 되어 경고만 사라진다.
const SEED_SOURCE_PRESENT = fs.existsSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "org", "delivery", "seed-knowledge"));
// 저장 응답의 분류 점검(#1153) — 오분류를 저장하는 그 순간에 잡는다.
//  ⚠ 절대 저장을 깨뜨리지 않는다(best-effort). 임베딩 off·미분류·조회 실패면 필드 자체를 생략한다 —
//   빈 객체를 실어 "점검했는데 문제 없음"으로 오해하게 만들지 않는다.
export async function classificationInfo(name: string | null | undefined): Promise<{ classification?: unknown }> {
  if (!name) return {};
  try {
    const c = await checkKnowledgeClassification(name);
    return c ? { classification: c } : {};
  } catch { return {}; }
}

export function seedSyncWarning(name: string | null | undefined): { seed_warning?: string } {
  if (!SEED_SOURCE_PRESENT || !name || !SEEDED_KNOWLEDGE_NAMES.has(name)) return {};
  return { seed_warning: `⚠ '${name}' 은 신규 고객 게이트웨이에 시딩되는 런북입니다(#713). 고객이 받는 본문은 이 WIKI 가 아니라 src/org/delivery/seed-knowledge/${name}.md 의 각색 스냅샷이라 — 이 편집은 고객 박스에 자동 반영되지 않습니다. 절차가 바뀌었다면 그 파일도 갱신하세요(내부 [[링크]]·이슈번호·사내 명칭·타 고객사명은 빼고 고객 맥락으로) → 편집 후 \`node scripts/sync-seed-knowledge.mjs\`. 미갱신 시 고객은 옛 절차를 봅니다.` };
}

// ── #907 본문 [[위키링크]] 자동 엣지 결과 → 응답. 저장은 이미 성공했다 — 미매칭은 **경고**지 실패가 아니다(목표2).
//  링크가 하나도 없으면 아무것도 싣지 않는다(대부분의 저장에 잡음을 더하지 않게).
export function wikiLinkInfo(w: WikiLinkResult | undefined): Record<string, unknown> {
  if (!w || (!w.linked.length && !w.unmatched.length)) return {};
  const info: Record<string, unknown> = { wikilinks: { linked: w.linked, unmatched: w.unmatched } };
  if (w.unmatched.length) {
    info.wikilink_warning = `⚠ 본문의 [[링크]] 중 ${w.unmatched.length}건이 실재하지 않는 지식을 가리켜 엣지를 만들지 못했습니다: ${w.unmatched.map((n) => `[[${n}]]`).join(", ")}. 저장은 정상 완료됐습니다 — 오타면 본문을 고치고, 아직 없는 지식이면 그대로 두세요(대상이 생기면 다음 스윕이 자동으로 잇습니다). 문법 예시로 적은 거라면 코드펜스·인라인코드 안에 넣으면 링크로 안 잡힙니다.`;
  }
  return info;
}

// ── 한 줄 요지(summary)와 짧은 제목(short_title)은 **사람 화면 전용**이다(#1600) ──
//  12살도 알아듣게 범위를 넓혀 쓴 문장이라, AI 가 그걸 원문 대신 근거로 삼으면 과일반화가 그대로 번진다
//  (요약을 지식 스토어에 저장한 제품들이 겪은 재귀 오염). 그래서 **MCP 응답에서는 벗겨서** 내보낸다.
//  임베딩 입력에서도 같은 이유로 빠져 있다(v6/embedding-provider.ts embeddingInputText).
//  웹(REST)은 그대로 받는다 — 목록·카드에 그 줄을 그리는 게 이 필드의 유일한 용도다.
export function stripLedeForAgent<T>(payload: T, ctx?: { source?: string }): T {
  if (ctx?.source !== "mcp") return payload;
  const one = (r: unknown): unknown => {
    if (!r || typeof r !== "object") return r;
    const o = r as Record<string, unknown>;
    if (!("summary" in o) && !("short_title" in o)) return r;
    return { ...o, summary: undefined, short_title: undefined };
  };
  if (Array.isArray(payload)) return payload.map(one) as unknown as T;
  return one(payload) as T;
}
