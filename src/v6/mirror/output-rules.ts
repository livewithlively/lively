// 수집기 산출 규칙 중 «항목 하나에 무엇을 붙이나» 를 정하는 순수 함수 — 미러(mirror-knowledge)와 커넥터 로그가 같은 판정을 쓴다.
//  DB 를 모르는 모듈로 따로 둔 이유: 미러 모듈은 인입 정책 · 분류기까지 끌어와서, 이 판정만 단위시험하기 어렵다.
import { GlobSet, toPosixRel } from "../../connectors/path-glob.js";

/** output_config.category_rules 한 줄 — match(패턴 하나 또는 여럿)에 맞는 경로면 category(카테고리 key). */
export interface CategoryRule { match: string | string[]; category: string }

interface CompiledRule { set: GlobSet; category: string }
const compiled = new WeakMap<object, CompiledRule[]>();

/** 규칙 읽기 — 형식이 틀린 줄은 건너뛴다(오타 하나로 수집 전체를 멈추지 않는다 · target_category 와 같은 규율). */
function rulesOf(outputConfig: Record<string, unknown> | null | undefined): CompiledRule[] {
  const raw = outputConfig?.category_rules;
  if (!Array.isArray(raw) || !outputConfig) return [];
  const hit = compiled.get(outputConfig);
  if (hit) return hit;
  const out: CompiledRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { match, category } = r as Partial<CategoryRule>;
    const key = typeof category === "string" ? category.trim() : "";
    const pats = (Array.isArray(match) ? match : [match]).filter((x): x is string => typeof x === "string" && !!x.trim());
    if (!key || !pats.length) continue;
    out.push({ set: new GlobSet(pats), category: key });
  }
  compiled.set(outputConfig, out);
  return out;
}

/**
 * 이 항목에 붙일 카테고리 key — 경로 규칙의 **첫 일치**, 없으면 target_category, 그것도 없으면 null.
 *  경로(item.path)가 없는 항목(다른 커넥터)은 규칙을 건너뛰고 target_category 만 본다 — 종전 동작 그대로.
 */
export function collectorCategoryFor(outputConfig: Record<string, unknown> | null | undefined, itemPath?: string | null): string | null {
  if (itemPath) {
    const p = toPosixRel(itemPath);
    for (const r of rulesOf(outputConfig)) if (r.set.matches(p)) return r.category;
  }
  const t = typeof outputConfig?.target_category === "string" ? outputConfig.target_category.trim() : "";
  return t || null;
}

/** 경로 규칙이 하나라도 있나 — 커넥터가 «어느 규칙에도 안 걸린 파일» 을 셀지 정할 때. */
export function hasCategoryRules(outputConfig: Record<string, unknown> | null | undefined): boolean {
  return rulesOf(outputConfig).length > 0;
}

/** 경로 규칙에만 비춰 본 카테고리(target_category 폴백 없이) — «미분류로 들어갈 파일» 을 세는 용도. */
export function ruleCategoryOnly(outputConfig: Record<string, unknown> | null | undefined, itemPath: string): string | null {
  const p = toPosixRel(itemPath);
  for (const r of rulesOf(outputConfig)) if (r.set.matches(p)) return r.category;
  return null;
}

/** 커넥터가 준 이름 제안(RawItem.name_hint)을 그대로 써도 되나 — 지식 이름 규칙(slugify)의 고정점이어야 한다.
 *  아니면 knowledge_get · knowledge_save 가 이름을 정규화하다 다른 행을 가리킨다. 64자는 slugify 의 상한이다. */
export function acceptableNameHint(hint: unknown): string | null {
  if (typeof hint !== "string") return null;
  return hint.length <= 64 && /^[a-z0-9가-힣]+(?:-[a-z0-9가-힣]+)*$/.test(hint) ? hint : null;
}
