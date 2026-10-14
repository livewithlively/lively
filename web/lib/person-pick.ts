// lib/person-pick.ts — **사람 한 명 고르기**(#4052)의 순수 규칙: 명부 행 정리 · 거르기와 순서 · 지금 값의 이름.
//  화면(lib/person-select.ts)은 이 규칙만 부른다. 테스트는 빌드 산출물(public/app/lib/person-pick.js)을 잰다
//  (scripts/person-pick.test.mjs — 러너가 web/ 를 수집하지 않는다).
//
//  왜 따로 두나: 고르기 칸의 판정이 틀어지면 **엉뚱한 사람의 AI 계정으로 과금**되거나, 명부에 없는 옛 값이
//  «빈 칸» 으로 보여 사람이 모르는 채 지워진다. 조용히 틀어지는 자리라 표로 못박는다.
import { findMatcher } from './find.js';

/** 고르기 후보 한 줄 — 값은 id, 보이는 건 name. */
export interface PickPerson {
  id: string;
  /** 화면에 보일 이름. 명부에 이름이 없으면 id(빈 줄을 내지 않는다). */
  name: string;
  /** 이름 옆 보조 글(예: «AI 구성원 · AI 로그인됨»). 없으면 null. */
  sub?: string | null;
}

/**
 * 명부 응답 → 후보. id 가 비었거나 겹치는 행은 버린다(같은 사람이 두 번 보이면 어느 쪽을 골라도 같은 값인데
 *  사람은 다른 계정인 줄 안다). 순서는 명부 순서 그대로.
 */
export function toPickPeople(rows: ReadonlyArray<{ id?: unknown; name?: unknown; sub?: unknown }>): PickPerson[] {
  const seen = new Set<string>();
  const out: PickPerson[] = [];
  for (const r of rows || []) {
    const id = String(r?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = String(r?.name ?? '').trim() || id;
    const sub = String(r?.sub ?? '').trim();
    out.push({ id, name, sub: sub || null });
  }
  return out;
}

/**
 * 거르고 줄 세운다.
 *  · 검색은 이름과 id 에서 한다(초성·띄어쓰기 무시 — lib/find 의 잣대 그대로). 빈 검색어는 전부.
 *  · **나를 맨 위로** — 실행 계정은 대개 «내 계정» 이다. 나머지는 명부 순서를 지킨다.
 */
export function pickMatches(people: readonly PickPerson[], q: string, meId?: string | null): PickPerson[] {
  const hit = findMatcher(q);
  const out = people.filter((p) => hit(p.name, p.id));
  const me = String(meId ?? '').trim();
  const i = me ? out.findIndex((p) => p.id === me) : -1;
  if (i > 0) out.unshift(out.splice(i, 1)[0]);
  return out;
}

/**
 * 지금 값을 어떻게 보일까. 비었으면 null.
 *  명부에 있으면 그 이름, 없으면 **값 그대로 + known:false** — 모르는 이름을 지어내지 않고, 옛 설정을 빈 칸으로 숨기지도 않는다.
 */
export function pickLabel(people: readonly PickPerson[], id: string | null | undefined): { id: string; name: string; known: boolean } | null {
  const v = String(id ?? '').trim();
  if (!v) return null;
  const p = people.find((x) => x.id === v);
  return p ? { id: v, name: p.name, known: true } : { id: v, name: v, known: false };
}

/**
 * 잡 하나가 **실제로 누구 계정으로 도나** — 화면이 서버와 같은 순서로 말하게 한다.
 *  순서는 scheduler/actions/_headless.resolveJobRunner 그대로: ① 이 자동 실행에 정한 계정 → ② 워크스페이스 실행 멤버
 *  → ③ 자동 실행을 만든 사람. 공백뿐인 값은 정하지 않은 것이다. 셋 다 없으면 null.
 *  (레인이 자기 계정을 정했으면 그 레인은 그 계정으로 돈다 — 그건 레인 칸의 몫이라 여기서 보지 않는다.)
 */
export function effectiveRunner(o: { explicit?: string | null; workspace?: string | null; creator?: string | null }):
  { id: string; from: 'job' | 'workspace' | 'creator' } | null {
  const t = (v: string | null | undefined): string => String(v ?? '').trim();
  if (t(o.explicit)) return { id: t(o.explicit), from: 'job' };
  if (t(o.workspace)) return { id: t(o.workspace), from: 'workspace' };
  if (t(o.creator)) return { id: t(o.creator), from: 'creator' };
  return null;
}
