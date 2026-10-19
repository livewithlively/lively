// 리브 «처음 연결» 1턴의 사실 묶기(#4213 T13) — 순수. 조회는 capabilities/delivery/welcome.ts connectTurnFacts 가 하고, 여기서 줄인다.
//
//  ⚠ 프라이버시가 이 파일의 일이다 — 1턴 프롬프트는 그 사람의 리브 세션 화면에 그대로 남는다.
//   · 수집 단위는 이 사람에게 보이는 것(listUnitsFor)의 앱별 **개수**만 낸다 — 이름·설명은 내보내지 않는다(남의 비공개 대화 이름이 실리지 않게).
//   · 합류자의 «팀이 쓰는 앱» 은 다른 구성원이 Claude 로 **연결해 둔**(connected) 앱의 사람 수와, 이 사람에게 보이는 구성원 경로
//     단위(member_ai · 모으는 중)의 수뿐이다. 나 자신은 세지 않는다(내 것은 따로 «내 커넥터» 로 간다).
//   · 라이블리 수집기로 모으는 앱은 팀 앱에 넣지 않는다 — 합류자가 Claude 에 연결하지 않아도 수집기가 모은다(넣으면 필요 없는 연결을 권한다).

export interface FactsMemberIn {
  member_id: string;
  scan: { ok: boolean; error: string | null } | null;
  connectors: Array<{ app: string; status: string }>;
}
export interface FactsUnitIn {
  app: string;
  state: "candidate" | "active" | "excluded";
  route: string;
  connector?: string | null;
}
export interface UnitCount { app: string; candidate: number; active: number; excluded: number }
export interface TeamApp { app: string; members: number; units: number }

/** 이 사람에게 보이는 단위의 앱별 개수(상태별) — 앱 이름순. */
export function unitCountsByApp(units: readonly FactsUnitIn[]): UnitCount[] {
  const by = new Map<string, UnitCount>();
  for (const u of units) {
    if (u.state !== "candidate" && u.state !== "active" && u.state !== "excluded") continue;
    const row = by.get(u.app) ?? { app: u.app, candidate: 0, active: 0, excluded: 0 };
    row[u.state] += 1;
    by.set(u.app, row);
  }
  return [...by.values()].sort((a, b) => a.app.localeCompare(b.app));
}

/** 내 커넥터 — 마지막 확인(없으면 null)과 앱 이름·상태. */
export function myConnectorFacts(me: string, records: readonly FactsMemberIn[]): { scan: { ok: boolean; error: string | null } | null; apps: Array<{ app: string; status: string }> } {
  const mine = records.find((m) => m.member_id === me) ?? null;
  return {
    scan: mine?.scan ? { ok: mine.scan.ok, error: mine.scan.error } : null,
    apps: (mine?.connectors ?? []).map((c) => ({ app: c.app, status: c.status })),
  };
}

/** 합류자의 «팀이 쓰는 앱» — 커넥터 이름 단위(대소문자 무시)로 합친다. 연결한 사람 많은 순 → 단위 많은 순 → 이름순. */
export function teamAppsFor(me: string, everyone: readonly FactsMemberIn[], units: readonly FactsUnitIn[], connectorOfApp: (app: string) => string): TeamApp[] {
  const team = new Map<string, TeamApp>();
  const key = (app: string): string => app.trim().toLowerCase();
  for (const m of everyone) {
    if (m.member_id === me) continue;
    for (const c of m.connectors) {
      if (c.status !== "connected") continue;
      const t = team.get(key(c.app)) ?? { app: c.app, members: 0, units: 0 };
      t.members += 1;
      team.set(key(c.app), t);
    }
  }
  for (const u of units) {
    if (u.route !== "member_ai" || u.state !== "active") continue;
    const name = u.connector || connectorOfApp(u.app);
    const t = team.get(key(name)) ?? { app: name, members: 0, units: 0 };
    t.units += 1;
    team.set(key(name), t);
  }
  return [...team.values()].sort((a, b) => b.members - a.members || b.units - a.units || a.app.localeCompare(b.app));
}
