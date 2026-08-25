// 시드 훅 잠금 — **우리가 배포하는 훅은 코드가 단일 출처(SoT)이고, 조직은 켜고 끄는 것만 정한다** (#1836).
//
//  왜(실측 2026-08-20): `seedDefaultContent` 는 기존 행을 `updated_by='system'`(심은 뒤 아무도 안 건드린 시드)일
//   때만 갱신한다. 그런데 우리 dev 의 시드 훅 **13개 전부 `updated_by='yoon'`** 이라 갱신이 **하나도 안 닿았고**,
//   실제로 5건이 코드보다 한 달 가까이 낡아 있었다(그중 knowledge-recall 은 #1750 의 워크스페이스 스코프 헤더
//   픽스가 빠진 채 돌고 있었다 — 없으면 secondary 세션의 훅 호출이 조용히 primary 데이터를 읽고 쓴다).
//   원인은 구조다: 편집이 열려 있으니 **모든 동기화가 손으로** 이뤄지고, 한 번 손대는 순간 그 행은 시드 갱신에서
//   영구 제외된다. 그래서 '편집 가능'을 없애 그 갈래 자체를 지운다.
//
//  선례: 세션 주입 가이드 섹션(#1245)이 같은 병("편집 실사용이 전부 코드 동기화 채널", "DB행>코드폴백 이원화가
//   4주간 사고 3건의 단일 원인")에 같은 처방(편집 불가·토글만·릴리스가 곧 갱신)을 이미 확정했다. 훅은 실행
//   코드라 드리프트 비용이 텍스트보다 크다.
//
//  ⚠ 잠기는 건 **시드 훅뿐**이다. 조직이 만든 커스텀 훅은 종전대로 자유롭게 CRUD 한다(잠금은 id 집합으로 판정).
//   시드 훅을 고치고 싶으면 ⓐ 끄고 ⓑ **새 id 로 커스텀 훅**을 만든다(우리 자신의 훅 개발·실험도 이 경로다 —
//   확정본만 레포 `kit/hooks/examples/` → `sync-seed-hooks` → 배포로 올린다).
import { DEFAULT_HOOKS } from "./default-content.js";
import { sha256 } from "../store/audit.js";

/** 시드로 배포되는 훅 id 집합 — 코드가 SoT 이므로 별도 컬럼·플래그를 두지 않는다. */
const SEED_HOOKS = new Map(DEFAULT_HOOKS.map((h) => [h.id, h]));

export function isSeedHook(id: string): boolean {
  return SEED_HOOKS.has(id);
}

export function seedHookIds(): string[] {
  return [...SEED_HOOKS.keys()];
}

/** 조직이 정할 수 있는 것 — 그 외 필드는 코드가 소유한다. */
export const SEED_HOOK_MUTABLE_FIELDS = ["enabled", "target_members", "sort"] as const;

// 코드가 소유하는 필드 → 입력 키 매핑. upsert 입력에 이 키가 실려 오고 값이 코드 기본값과 다르면 거부한다.
//  (같은 값이면 통과시킨다 — 시딩·동기화 스크립트가 전체 페이로드를 보내도 막히지 않게. 멱등 재전송은 무해하다.)
const LOCKED_FIELDS: Array<{ key: string; of: (h: (typeof DEFAULT_HOOKS)[number]) => unknown }> = [
  { key: "source_code", of: (h) => h.source_code },
  { key: "event", of: (h) => h.event },
  { key: "matcher", of: (h) => h.matcher },
  { key: "harness", of: (h) => h.harness },
  { key: "timeout_sec", of: (h) => h.timeout_sec },
  { key: "label", of: (h) => h.label },
  { key: "note", of: (h) => h.note },
  { key: "summary", of: (h) => h.summary },
];

/** 시드 훅에 잠긴 필드를 바꾸려는 입력인가 — 위반 필드 이름들(없으면 빈 배열). 순수. */
export function lockedFieldViolations(id: string, input: Record<string, unknown>): string[] {
  const seed = SEED_HOOKS.get(id);
  if (!seed) return [];
  const out: string[] = [];
  for (const f of LOCKED_FIELDS) {
    if (!(f.key in input) || input[f.key] === undefined) continue;   // 미전송 = 변경 의사 없음
    const want = f.of(seed);
    const got = input[f.key];
    // matcher 는 null·"" 이 같은 뜻(전체 매칭)이라 정규화해 비교한다.
    const norm = (v: unknown) => (v === "" || v === null || v === undefined ? null : v);
    if (f.key === "matcher" ? norm(want) !== norm(got) : want !== got) out.push(f.key);
  }
  return out;
}

/** 잠긴 필드 변경 시도에 대한 사람이 읽는 사유 — 거부 메시지·감사에 그대로 쓴다. */
export function seedHookLockMessage(id: string, fields: string[]): string {
  return `'${id}' 는 라이블리가 배포하는 기본 훅이라 ${fields.join("·")} 를 조직에서 바꿀 수 없습니다 `
    + `— 본문은 제품 코드가 단일 출처이고 업데이트마다 자동으로 갱신됩니다. `
    + `켜고 끄는 것(enabled)과 대상 구성원(target_members)만 조직이 정합니다. `
    + `동작을 바꾸고 싶으면 이 훅을 끄고 **새 id 로 커스텀 훅**을 만드세요.`;
}

/** 실행·표시에 쓰이는 '유효 훅' — 시드 훅이면 DB 행이 무엇이든 코드 본문으로 덮는다(#1245 effectiveSectionTemplate 동형).
 *  DB 행은 지우지 않는다(비파괴 — 롤백은 코드 리버트). enabled·target_members 등 조직의 결정은 DB 값을 그대로 둔다. */
//  반환 타입에 content_hash 를 명시한다 — 입력 행에 그 필드가 없어도(부분 프로젝션) 교체되면 지문이 생기기 때문.
//   T 만 돌려주면 "본문은 바뀌었는데 지문은 타입상 존재하지 않는" 계약이 되어 호출부가 지문을 못 읽는다.
export function effectiveHook<T extends { id: string; source_code: string; content_hash?: string | null }>(row: T): T & { content_hash?: string | null } {
  const seed = SEED_HOOKS.get(row.id);
  if (!seed || seed.source_code === row.source_code) return row;
  // content_hash 도 함께 덮는다 — 런너(run-custom.mjs)가 이 해시로 본문 무결성을 게이팅하므로 둘이 어긋나면 훅이 죽는다.
  return { ...row, source_code: seed.source_code, content_hash: sha256(seed.source_code) };
}

export function effectiveHooks<T extends { id: string; source_code: string; content_hash?: string | null }>(rows: T[]): Array<T & { content_hash?: string | null }> {
  return rows.map(effectiveHook);
}
