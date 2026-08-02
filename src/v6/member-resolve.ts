// 미러 멤버 재해소 — 순수 결정 로직(#697). DB 불요 → 유닛테스트(member-resolve.test.ts). SQL 표면 치환은
//  connector-mirror.reresolveMirrorMembers 가 이 맵/치환을 써서 수행한다. 뒤늦게 건 멤버 매핑을 이미 미러된
//  데이터(raw=이메일/외부id)에 소급 적용하는 핵심 로직이라 별도 순수 모듈로 분리(external-identity 패턴).

// 재해소 맵 — resolveMemberId(①person_identity ②org_member.email) 규칙에 **person_identity.email 역매칭**을 더한다
//  (#697 핵심): 관리탭 매핑은 external_id=ClickUp 숫자 id 로 person_identity 를 만들되 그 행의 email 컬럼에 ClickUp
//  이메일을 함께 저장하므로(delivery→store.syncMemberToPerson), raw 가 이메일이어도 그 email 로 매핑 주인을 찾을 수
//  있다 — via='identity' 유저(org_member.email≠ClickUp 이메일이라 ②로 안 잡히는 바로 그 케이스)를 해소하는 경로다.
//  key(외부 id 또는 소문자 이메일) → org_member.id. 우선순위: person_identity > org_member.email(먼저 넣은 키 유지).
export function buildMemberResolver(
  identities: Array<{ external_id: string; email: string | null; member_id: string }>,
  memberEmails: Array<{ email: string; id: string }>,
): (raw: string) => string {
  const idMap = new Map<string, string>();
  for (const it of identities) {
    if (it.external_id) idMap.set(it.external_id, it.member_id);            // 숫자 id 키
    const ek = (it.email ?? "").trim().toLowerCase();
    if (ek && !idMap.has(ek)) idMap.set(ek, it.member_id);                  // 이메일 역매칭 키
  }
  const emailMap = new Map<string, string>();
  for (const m of memberEmails) {
    const ek = (m.email ?? "").trim().toLowerCase();
    if (ek && !emailMap.has(ek)) emailMap.set(ek, m.id);
  }
  return (raw: string): string => {
    if (!raw) return raw;
    const lo = raw.toLowerCase();
    return idMap.get(raw) ?? idMap.get(lo) ?? emailMap.get(lo) ?? raw;      // 매칭 없으면 raw 그대로(불변)
  };
}

// JSON 어사이니 배열 재해소 + 순서보존 dedup. 바뀐 게 없으면 null(no-op 스킵용).
export function reresolveMemberList(values: string[], resolve: (v: string) => string): string[] | null {
  const out: string[] = [];
  let changed = false;
  for (const v of values) {
    const r = resolve(v) || v;
    if (r !== v) changed = true;         // 치환 발생
    if (!out.includes(r)) out.push(r);
    else changed = true;                  // 중복 축약 발생
  }
  return changed ? out : null;
}
