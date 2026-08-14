// 저장소 관리 ▸ '선택 정리' 의 **대상 집합 계산** — DOM 을 안 쓰는 순수 판정.
//
//  여기 따로 뺀 이유: 서버의 `remove_worktree` 는 **요청 단위** 플래그라 한 배치에 섞을 수 없다.
//  그래서 선택을 두 묶음(파생물만 / 워크트리까지)으로 갈라야 하는데, 이 가르기가 조용히 틀리면
//  **아무 에러 없이 대상이 빠진다** — 실제로 그랬다(아래 ⚠). 렌더 함수 안에 두면 테스트가 불가능하니
//  전역·DOM 의존 없는 모듈로 분리해 node 에서 직접 import 해 검증한다.
/**
 * 이 폴더에 '제거 가능'으로 판정된 워크트리가 하나라도 있나.
 * 서버 판정(`worktree_removable`)을 그대로 쓴다 — 그 값은 활성 세션·더티·원격 미도달을 이미 반영했다.
 * UI 가 같은 판단을 다시 하면 두 곳이 어긋나는 순간 안전선이 갈린다.
 */
export function wtRemovable(pr) {
    return !!pr && (pr.results || []).some((r) => !!r.worktree_removable);
}
/**
 * 선택 상태 → 서버로 보낼 두 묶음.
 *
 * ⚠ **파생물이 0이어도 워크트리 옵트인만으로 대상이 된다.** 종전 코드는 `reclaimable_bytes > 0` 으로만
 *   걸러서, 파생물을 이미 회수해 둔 폴더(= 정확히 워크트리만 남은 폴더)를 영영 선택하지 못했다.
 *   이 박스 실측으로 그런 폴더가 164개·5.01GB 였다 — 화면에 '제거 가능'이라 띄우면서 버튼은 안 먹는 상태.
 *
 * ⚠ 둘 다 켜진 폴더는 **워크트리 묶음에만** 넣는다. 서버가 파생물→워크트리 순으로 처리하므로 한 번이면
 *   충분하고, 양쪽에 넣으면 같은 폴더를 두 번 정리한다.
 */
export function planReclaimBatches(selected, wtSelected, analyzed) {
    const selFolders = [...selected].filter((f) => (analyzed.get(f)?.reclaimable_bytes ?? 0) > 0);
    const selBytes = selFolders.reduce((s, f) => s + (analyzed.get(f)?.reclaimable_bytes ?? 0), 0);
    // 스테일 옵트인 방어 — 재분석으로 판정이 뒤집혔거나 아직 분석 안 된 폴더는 버린다.
    const wtFolders = [...wtSelected].filter((f) => wtRemovable(analyzed.get(f)));
    const wtSet = new Set(wtFolders);
    const actFolders = [...new Set([...selFolders, ...wtFolders])];
    const derivedOnly = actFolders.filter((f) => !wtSet.has(f));
    return { selFolders, wtFolders, actFolders, derivedOnly, selBytes };
}
