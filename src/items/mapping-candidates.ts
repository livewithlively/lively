// domainmap 후보 캐시 — 매핑 검증/추출 vocab 의 단일 소스.
// IO 는 읽기 전용(core queries) 만. resolveRepo 1회 + domains/entities 각 1회 조회 후 인메모리 맵 구성.
// 매퍼 run(추출)과 propose write-path(검증)가 같은 Candidates 를 공유해 vocab 불일치를 막는다.
// Stage⑥ 직결: 구 dmGet(HTTP) → core 직호출.
import { resolveRepo, type DomainListItem, type EntityListItem } from "../domainmap/core/types.js";
import { listDomainsApi, listEntitiesApi } from "../domainmap/core/queries.js";

// domainmap 코어의 리스트 타입에서 우리가 쓰는 필드만 Pick 으로 좁힌다 —
// 같은 이름·다른 shape 의 중복 선언 금지(코어 types.ts 가 단일 소스).
export type DomainRow = Pick<DomainListItem, "key" | "name" | "description">;
type EntityRow = Pick<EntityListItem, "name" | "domain">;

export interface Candidates {
  repo: string;
  domainsByKey: Map<string, DomainRow>;
  domainKeys: string[];
  domainNames: string[];
  // 엔티티명(PascalCase 모델명) → 그 엔티티가 속한 domain_key. domain 이 null 인 엔티티는 제외.
  entityToDomainKey: Map<string, string>;
}

export async function loadCandidates(repo?: string): Promise<Candidates> {
  const r = resolveRepo(repo);
  const [domainsRaw, entitiesRaw] = await Promise.all([
    listDomainsApi(r),
    listEntitiesApi(r),
  ]);

  const domainsByKey = new Map<string, DomainRow>();
  const domainKeys: string[] = [];
  const domainNames: string[] = [];
  for (const d of asArray<DomainRow>(domainsRaw)) {
    if (!d?.key) continue;
    domainsByKey.set(d.key, d);
    domainKeys.push(d.key);
    if (d.name) domainNames.push(d.name);
  }

  const entityToDomainKey = new Map<string, string>();
  for (const e of asArray<EntityRow>(entitiesRaw)) {
    const dk = e?.domain?.key;
    if (e?.name && dk) entityToDomainKey.set(e.name, dk); // domain null 엔티티는 스킵
  }

  return { repo: r, domainsByKey, domainKeys, domainNames, entityToDomainKey };
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

// 검증: 후보 vocab 멤버십. propose write-path 가 쓰기 전 호출.
export function validateDomainKey(c: Candidates, key: string): boolean {
  return c.domainsByKey.has(key);
}
