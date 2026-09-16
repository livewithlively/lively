// 노드 접근 정책(#1540) — "이 사람이 이 노드를 쓸 수 있나"의 단일 술어. 위탁 배치·provision·세션생성·목록이
//  전부 여기만 본다(표면마다 제 나름의 규칙을 두면 한쪽만 새는 불일치가 난다 — 실제로 그랬다, 아래).
//
//  ── 두 축을 분리한다 ──
//   · shared (관리자 전용) = **개방 여부**. '공유 노드'의 유일한 근거.
//   · kind (member|worker) = git 자격 정책(resolveRepoInject)·슬롯 용량. 개방 여부와 무관 — 과적재 금지.
//
//  종전엔 개방이 kind==='worker' 에 암묵적으로 얹혀 있었고(assertNodeUsable), 위탁은 그마저 우회했다:
//  `hasLease || owner === requester` 라서 **의뢰자가 셋업토큰만 등록해 두면 남의 멤버 노드까지 후보**였다
//  (게다가 delegate_run 의 node 지정은 존재검사만 했다) — 멤버 A가 멤버 B의 노트북에서 임의 프롬프트,
//  즉 임의 코드를 돌릴 수 있는 상태. 이 모듈이 그 경계를 하나로 모은다.
//
//  admin 우회는 두지 않는다 — 관리자는 공유 토글을 켜면 되고, 그게 감사 가능한 경로다(권한으로 몰래 넘는 것보다).
export interface NodeAccessFacts {
  owner_member: string | null | undefined;  // 이 노드를 등록한 사람
  shared?: boolean | null;                  // 관리자가 공유 노드로 지정했나(구 스키마 행 = undefined → 비공유)
}

// 소유 또는 공유 — provision·노드 세션생성·노드 지정·목록 노출의 기본 판정.
// #1541 — 이 노드 세션이 '그 PC 주인의 네이티브 하네스 설정'(CLAUDE_CONFIG_DIR 미주입)을 써도 되는가.
//  member(개인 PC) 노드 && 생성자가 곧 등록자일 때만 — 공유(shared) 노드·타인 세션은 종전 프로필 주입 유지
//  (여러 사람이 한 OS 계정을 쓰는 자리라 #1014 신원 유출 방어가 그대로 필요하다).
export function nodeHostProfile(node: { kind?: string | null; owner_member?: string | null }, requesterId: string): boolean {
  return node.kind === "member" && !!requesterId && node.owner_member === requesterId;
}

export function nodeOpenTo(node: NodeAccessFacts, requesterId: string): boolean {
  if (!requesterId) return false;                  // 신원 없음 → fail-closed(빈 owner 와 우연히 같아지는 것도 막는다)
  return node.owner_member === requesterId || node.shared === true;
}

// 위탁(delegate) 후보 판정 — 개방(위) 위에 **의뢰자 자격이 그 머신에 실재하는가**를 더 본다.
//  · 본인 노드: 그 머신에 본인 하네스 로그인이 있으니 리스 없이도 실제로 돈다.
//  · 공유 노드: 조직 실행기(격리 박스)라 의뢰자 프로필이 없다 → 셋업토큰 리스(env) 없이 보내면 워커가
//    auth 에서 무출력으로 매달리고 stall 가드가 5분 뒤 죽인다(#1101). 그래서 애초에 후보에서 뺀다.
//    (이 조건은 종전 `hasLease || owner===requester` 의 리스 요구를 그대로 승계한 것 — 회귀가 아니다.)
export function remoteDelegateAllowed(node: NodeAccessFacts, requesterId: string, hasLease: boolean): boolean {
  if (!requesterId) return false;
  if (node.owner_member === requesterId) return true;
  return node.shared === true && hasLease;
}

// 공유 전환(#4004) — "이 사람이 이 노드의 공유를 켜거나 끌 수 있나". POST /api/ui/nodes/:id/share 의 판정 전부.
//
//  #1558 은 이 동작을 **해제 전용**으로 좁혔었다. 그때 막으려던 것은 두 가지다:
//   ① 구성원이 붙여 둔 개인 노트북이 (본인 의사와 무관하게) 조직 공용이 되는 것
//   ② 그걸 하려면 관리 화면이 남의 개인 컴퓨터 목록을 늘어놔야 하는 것(프라이버시)
//  둘 다 **주인이 자기 것을 여는 경우엔 성립하지 않는다** — 동의한 사람이 주인 본인이고, 그 화면은 자기 목록
//  ([내 설정 ▸ 내 컴퓨터])이다. 그래서 켜기를 **주인 본인 노드에 한해** 되연다(상민님 2026-09-16).
//  남의 노드를 올리는 경로는 관리자에게도 없다 — 거기선 ①②가 그대로 살아 있다.
//
//  ⚠ 이 판정이 «공유는 관리자만, 소유자도 못 켠다»(#1540)를 대체한다. 기본값은 여전히 비공유이고, 켜는 것은
//   주인의 명시적 행위다 — '기본은 본인 것'이라는 #1540 의 골자는 그대로다(바뀐 건 '누가 켜나'뿐).
//
//  판정 순서가 계약의 일부다: 신원 없음·남의 노드(비관리자) → 403 이 **켜기 차단(400)보다 먼저**다.
//   권한 없는 사람에게 내부 규칙을 알리지 않기 위해서다(#1558 이 세운 순서를 그대로 잇는다).
//  해제는 넓게 둔다(주인 ∪ 관리자) — 좁히는 방향이라, 잘못 열린 것을 관리자가 즉시 닫을 수 있어야 한다.
export type ShareChangeVerdict =
  | { ok: true; shared: boolean }
  | { ok: false; status: 400 | 403; message: string };

const NOT_MINE = "본인 노드가 아닙니다";
const NOT_YOURS_TO_SHARE =
  "남의 컴퓨터를 공유로 올릴 수는 없습니다 — 그 컴퓨터를 연결한 사람이 [내 설정 ▸ 내 컴퓨터]에서 직접 전환해야 합니다"
  + "(아직 연결되지 않은 공용 서버라면 [관리 ▸ 컴퓨터(노드) ▸ 공유 컴퓨터 등록]).";

export function shareChangeVerdict(
  node: NodeAccessFacts, requesterId: string, admin: boolean, wantShared: boolean,
): ShareChangeVerdict {
  // 신원 없음 → fail-closed. 빈 owner 와 우연히 같아져 '내 노드'가 되는 자리를 막는다(nodeOpenTo 와 같은 규율).
  if (!requesterId) return { ok: false, status: 403, message: NOT_MINE };
  const mine = node.owner_member === requesterId;
  if (!mine && !admin) return { ok: false, status: 403, message: NOT_MINE };
  if (wantShared && !mine) return { ok: false, status: 400, message: NOT_YOURS_TO_SHARE };
  return { ok: true, shared: wantShared };
}
