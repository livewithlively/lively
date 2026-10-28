// 지식 표면 공용 유틸(#1313 R57) — knowledge.ts 도메인 분할 시 op 파일들이 함께 쓰던 가드·경고·상수를
//  여기 한 벌만 둔다(복제 금지 — 판정이 갈라지면 공개범위 게이트가 파일마다 달라진다).
//   · 공개범위(#1291) 게이트: assertKnowledgeVisible/Writable · filterVisibleByName
//   · 저장 응답 부가정보: classificationInfo(#1153) · seedSyncWarning(#846) · wikiLinkInfo(#907)
//   · 방어 상한/임계: BODY_MD_MAX(#534) · DEDUP_WARN_SIMILARITY(#172)
//  ⚠ members 지식 존재여부 캐시(restrictedKAt/restrictedK)는 모듈 전역 mutable 이라 그 유일 소비자
//   (anyRestrictedKnowledge)와 반드시 동거한다 — 다른 파일로 나누면 ESM import 바인딩이 재할당 불가다.
import { HttpError } from "../rest-util.js";
import type { WikiLinkResult } from "../../v6/knowledge-store.js";
import { checkKnowledgeClassification, getCategory, getCategoryByKey } from "../../v6/category-store.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_KNOWLEDGE } from "../../org/delivery/default-content.js";
import { canSeeKnowledge, type Viewer } from "../../v6/visibility.js";
import { anyRestrictedKnowledge } from "../../v6/knowledge-store.js";
import { slugify } from "../../v6/knowledge-common.js";
import { readScopeFor, outsideReadScope } from "../../v6/read-scope.js";   // #5100 앱 맥락 범위
import { appContextDenied } from "../../apps/app-context.js";
import type { LivelyUser } from "../../context.js";
import type { CapabilityCtx } from "../types.js";

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
// 쓰기 게이트 = 읽기 게이트와 **같은 판정**이다(볼 수 없으면 고칠 수도 없다) — 판정은 위 하나에 위임한다.
//  다른 점은 **보는 이름이 하나 더** 있다는 것뿐이다: 저장 경로 일부(upsertKnowledge · resolveKnowledgeGate)는
//  받은 이름을 slugify(소문자 · 구분자 통일 · 64자 절단)한 이름의 행을 고친다. 게이트가 받은 이름만 보면
//  «그 이름의 문서는 없다 → 통과» 인데 실제로는 정규화된 이름의 문서가 고쳐진다 — 대소문자만 바꾸거나 64자를
//  넘긴 이름으로 안 보이는 문서를 고칠 수 있게 된다. 그래서 두 이름 중 하나라도 안 보이면 막는다.
//  문구는 받은 이름으로 낸다(없는 문서와 같은 문구 — 존재 은닉). 정규화해도 같은 이름이면(대부분) 조회는 한 번이다.
export async function assertKnowledgeWritable(name: unknown, viewer: Viewer): Promise<void> {
  await assertKnowledgeVisible(name, viewer);
  if (viewer === null || !name) return;
  const normalized = slugify(String(name));
  if (normalized !== String(name) && !(await canSeeKnowledge(normalized, viewer))) {
    throw new HttpError(404, `지식 '${String(name)}' 없음`);
  }
}

/**
 * 앱 맥락 범위(#5100) 밖 문서를 이름으로 열었나 — 공개범위로는 보이는데 이 앱이 선언한 범위 밖이면 거절(403)하고 기록한다.
 *  «없음» 과 문구를 가르는 까닭: 앱 제작자가 범위를 잘못 적었는지 바로 알게(그 사람은 공개범위로 이미 보는 문서다 — 새는 것이 없다).
 *  공개범위로도 안 보이는 문서 · 없는 문서 · 범위 안 문서는 아무것도 안 한다(호출부의 종전 판정 — «없음» 존재 은닉 — 이 이어진다).
 */
export async function assertKnowledgeInAppContext(name: string, viewer: Viewer, user: LivelyUser, ctx: CapabilityCtx | undefined, tool: string): Promise<void> {
  const scope = await readScopeFor(viewer);
  if (!scope || !name) return;
  if (await canSeeKnowledge(name, viewer)) return;
  //  범위 없이 보였나만 본다(내용을 읽지 않는다 — read-scope.ts outsideReadScope 의 쓰임 ⓐ).
  if (!(await outsideReadScope(() => canSeeKnowledge(name, viewer)))) return;
  throw appContextDenied({ appId: scope.appId, actor: user?.userId ?? null, tool, target: `knowledge:${name}`, source: ctx?.source,
    message: `지식 '${name}' 은(는) 이 앱이 읽을 수 있는 맥락 범위(매니페스트 context.knowledge_categories) 밖입니다` });
}

/** 지식 검색 도구의 category 인자 설명(#5100) — grep · search · similar 가 같은 글을 쓴다. */
export const CATEGORY_ARG_DESC = "카테고리 key(category_list 의 key — 예: runtime-ops) 또는 숫자 id — 그 카테고리에 든 지식만 찾는다. 없는 카테고리면 오류";

/**
 * category 인자(#5100) → 카테고리 id 목록. 비었으면 null(거르지 않는다). 없는(또는 합쳐진) 카테고리는 400 — 빈 결과로 두면 «그런 지식이 없다» 로 읽힌다.
 *  key 를 먼저 찾는다 — key 도 숫자만으로 될 수 있어서(categories.ts KEY_RE · 예 «2024»), 숫자를 곧바로 id 로 읽으면 그 key 를 못 찾는다. 없을 때만 숫자를 id 로.
 */
export async function categoryArg(raw: string | undefined): Promise<number[] | null> {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  const row = (await getCategoryByKey(v.toLowerCase())) ?? (/^\d+$/.test(v) ? await getCategory(Number(v)) : undefined);
  if (!row || row.state === "merged") throw new HttpError(400, `카테고리 '${v}' 이(가) 없습니다 — category_list 의 key 를 적으세요`);
  return [Number(row.id)];
}

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
