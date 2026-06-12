// 컨테이너→도메인/프로젝트 맵 (D2/P3) — config-driven, curatable (DESIGN §7).
// 키 형식: `${prov_system}:${container_ref}` (예 'discord:1471507104052281365').
// env MAPPING_CONTAINER_JSON 으로 코드 변경 없이 큐레이션. 미설정이면 빈 기본값.
// 현재 라이브의 유일 채널('#회의')은 의도적으로 미매핑 — 잡담이라 강제 매핑하지 않는다.

interface ContainerMaps {
  domain: Record<string, string[]>;
  project: Record<string, string[]>;
}

function load(): ContainerMaps {
  const raw = process.env.MAPPING_CONTAINER_JSON?.trim();
  if (!raw) return { domain: {}, project: {} };
  try {
    const parsed = JSON.parse(raw) as { domain?: Record<string, string[]>; project?: Record<string, string[]> };
    return { domain: parsed.domain ?? {}, project: parsed.project ?? {} };
  } catch {
    // 설정 파싱 실패는 조용히 빈 맵(매핑이 빠지는 건 안전 — 미매핑은 신호).
    return { domain: {}, project: {} };
  }
}

const MAPS = load();
export const CONTAINER_DOMAIN_MAP: Record<string, string[]> = MAPS.domain;
export const CONTAINER_PROJECT_MAP: Record<string, string[]> = MAPS.project;

function keyOf(system: string, ref: string | null | undefined): string | null {
  if (!system || !ref) return null;
  return `${system}:${ref}`;
}

// D2 — 컨테이너→도메인 lookup.
export function containerDomains(system: string, ref: string | null | undefined): string[] {
  const k = keyOf(system, ref);
  return k && CONTAINER_DOMAIN_MAP[k] ? CONTAINER_DOMAIN_MAP[k] : [];
}

// P3 — 컨테이너→프로젝트 lookup.
export function containerProjects(system: string, ref: string | null | undefined): string[] {
  const k = keyOf(system, ref);
  return k && CONTAINER_PROJECT_MAP[k] ? CONTAINER_PROJECT_MAP[k] : [];
}
