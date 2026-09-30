// 아웃바운드 status 결정 — 태스크가 실제로 속한 리스트의 상태셋에서 뽑는다(#177 후속).
//  종전엔 컨테이너 리스트의 스페이스 상태셋 하나로 전 태스크의 status 를 만들었다. 미러는 여러 리스트에
//  걸쳐 있고 리스트마다 상태 어휘가 다르므로(실측: 한 조직에서 `done|complete|planned|in progress` 와
//  `shipped|in review` 가 공존) 그 이름은 다른 리스트에선 유효하지 않다 → ClickUp 이 거부하고 호출부의
//  "status 빼고 1회 재시도"가 삼켜서 **status 만 조용히 유실**된다. 그래서 리스트별로 판정한다.
import { clickUpStatusCategory, clickUpStatusKey, effectiveStatusSource } from "./transform.js";
import type { ClickUpStatus, ClickUpList, ClickUpSpace } from "./types.js";

// 인바운드와 **같은** 상태셋 선택 규칙을 쓴다(effectiveStatusSource 가 단일 출처).
//  여기선 type 을 보존한 원본이 필요하다 — open/custom 구분이 카테고리 역매핑의 근거다.
export function statusesForList(list: ClickUpList | null | undefined, space?: ClickUpSpace | null): ClickUpStatus[] {
  return effectiveStatusSource(list, space);
}

// 정규 카테고리 → 그 상태셋의 상태명(인바운드 clickUpStatusCategory 의 역).
export function buildStatusMap(statuses: ClickUpStatus[]): Record<string, string | undefined> {
  const byType = (t: string) => statuses.find((s) => s.type === t)?.status;
  const open = byType("open"), custom = byType("custom"), done = byType("done") || byType("closed");
  return { backlog: open, unstarted: open, started: custom || open, done, canceled: done };
}

// 상태셋에서 이름(또는 소환키)으로 찾은 상태의 정규 카테고리. 못 찾으면 null.
//  ⚠ 비교를 키로 한다 — external_base.status_raw 는 슬러그(`in-review`)로 들어오는데 ClickUp 라벨은
//   공백형(`in review`)이라 문자열 동등비교가 빗나간다(실측).
export function categoryOfStatusName(statuses: ClickUpStatus[], name: string | null | undefined): string | null {
  if (!name) return null;
  const want = clickUpStatusKey(name);
  const hit = statuses.find((s) => s.status && clickUpStatusKey(s.status) === want);
  return hit ? clickUpStatusCategory(hit.type) : null;
}

/**
 * 이번 푸시에서 ClickUp 에 실을 status. undefined = status 를 보내지 않는다(저쪽 값 그대로 둔다).
 *
 * 🔴 판정 기준은 `theirStatusRaw`(저쪽 현재 상태)이고, **base 의 status_category 가 아니다.**
 *  external_base 는 이 두 칸이 서로 다른 쪽을 가리킨다 — 인바운드 3-way 가 충돌 시 ours 를 채택하면서
 *  `status_category` 엔 우리 값을, `status_raw` 엔 저쪽 값을 남긴다(실측: 드리프트 18건 중 17건이
 *  base.status_category='done' + base.status_raw='backlog'). 그래서 base 카테고리로 "바뀐 게 없다"를
 *  판정하면 **고쳐야 할 드리프트를 전부 skip** 한다. 저쪽 raw 로 판정해야 한다.
 */
export function decidePushStatus(args: {
  ourCategory: string | null | undefined;
  theirStatusRaw: string | null | undefined;
  statuses: ClickUpStatus[];
  // external_base.status_category — 마지막 동기화(인바운드 머지 또는 직전 푸시) 때의 우리 카테고리. 없으면(생략·NULL) 아래 가드만 본다.
  baseCategory?: string | null;
}): string | undefined {
  const { ourCategory, theirStatusRaw, statuses, baseCategory } = args;
  if (!ourCategory) return undefined;
  const target = buildStatusMap(statuses)[ourCategory];
  if (!target) return undefined; // 이 리스트 어휘에 보낼 이름이 없다 — 없는 상태를 PUT 하면 ClickUp 이 거부한다.
  // 마지막 동기화 뒤 **우리 쪽 status 가 바뀌었으면** 같은-카테고리 가드를 건너뛰고 보낸다.
  //  theirStatusRaw 는 인바운드만 전진시킨다 — 직전 푸시가 저쪽을 바꿔도 다음 인바운드 전까지는 푸시 전 라벨이 남는다.
  //  그 구값으로 "이미 같다"를 판정하면 닫았다가(푸시 → 저쪽 complete) 인바운드 전에 다시 연 변경이 나가지 않고,
  //  다음 인바운드가 저쪽 complete 를 채택해 **다시 연 것이 조용히 되돌아간다**(세션=태스크처럼 자동으로 여닫는 경로에서 흔하다).
  //  우리 쪽이 안 바뀌었으면(ours == base) 아래 가드로 판정한다 — theirs 가 구값이어도 결과는 같은 라벨의 재전송(멱등)이다.
  if (baseCategory != null && baseCategory !== ourCategory) return target;
  // 저쪽이 이미 같은 카테고리면 건드리지 않는다 — 커스텀 상태(`보류`·`qa중`·`in review`)를 그 카테고리의
  //  대표 상태로 평탄화하지 않기 위해서다. 카테고리가 같은데 이름만 바꾸는 PUT 은 정보를 잃기만 한다.
  //  ⚠ 비교는 **`target` 의 카테고리** 대 저쪽 카테고리다(`ourCategory` 직접 비교가 아니다) — 우리 카테고리
  //   공간이 더 넓어서(`backlog`·`canceled` 는 ClickUp type 에 대응물이 없어 categoryOfStatusName 이 절대
  //   반환하지 않는다) 직접 비교하면 그 두 값에서 가드가 항상 빗나간다: ours=`canceled`·theirs=`Closed` 가
  //   불일치로 판정돼 `Closed` 를 `Complete` 로 평탄화하고, ours=`backlog`·theirs=`planned` 도 매 틱 덮어쓴다.
  if (categoryOfStatusName(statuses, target) === categoryOfStatusName(statuses, theirStatusRaw)) return undefined;
  return target;
}
