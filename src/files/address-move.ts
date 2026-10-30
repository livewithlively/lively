// 옛 주소 → 지금 자리(#4822) — 파일 주소(files/address)가 웹 · API 로 이름을 바꾸거나 옮긴 파일의 옛 주소일 때 «옛 경로 → 새 경로»
//  기록(#4688)을 따라간다. 웹 공유 링크는 #4688 이 이미 새 자리로 연다(terminal-files browse/moved). 같은 옛 주소가 다른 입구 —
//  파일 주소 도구(file_url 받기 · file_path)로 와도 끊기지 않게 하는 것이 이 모듈이다. 규칙은 browse/moved 와 같다:
//   · 기록은 공유 자리(shared)에만 있다 — 앱 폴더는 웹에서 옮기지 않는다(앱이 쓴다). 그래서 앱 폴더 주소는 따라가지 않는다.
//   · 옛 주소를 이 사람이 **지금** 볼 수 있어야 한다. 못 보면 null — 부르는 쪽이 종전대로 답한다(기록이 있는지 새지 않는다).
//   · 옛 자리에 지금 실제로 무엇이 있으면 그것이 이긴다(null — 옛 자리에 새 파일이 생긴 경우).
//   · 닿은 자리는 이 사람 기준으로 **다시** 판정한다 — 안 보이면 null(옮긴 곳이 잠긴 폴더면 그 이름도 새지 않는다).
//   · 따라가기 상한 · 도착 시각 규칙 · 글자 꼴 너그러움은 files/file-move-core(followMovedPath) 그대로다.
//   · 닿은 자리는 주소가 될 수 있어야 한다 — 점으로 시작하는 마디(숨김 자리)로 옮겨졌으면 따라가지 않는다(주소로 건넬 수 없는 자리다).
//  ★ 순서 — 판정 → 기록 → 디스크. 이 함수는 받기 주소 · 세션 경로 변환마다 불린다(화면은 그림마다 받기 주소를 받는다). 대부분은 «파일이 그대로
//   있고 기록도 없는» 경우라 디스크(매니지드면 멤버 경계 중계 — 한 번에 수백 ms)부터 보면 그 비용을 매번 치른다. 기록(DB 한 번)을 먼저 보고
//   기록이 있을 때만 옛 자리를 본다 — 결과는 같다(옛 자리에 파일이 있으면 기록을 따라가도 버린다). 판정이 맨 앞인 것은 그대로다 — 못 보는
//   옛 주소는 기록도 디스크도 보지 않는다(기록이 있는지 새지 않게).
//  순수(deps 주입) — 판정 · 디스크 · 기록 조회는 부르는 쪽(capabilities/files.ts)이 꽂는다. 시험은 같은 함수에 가짜를 꽂는다. 배관이 던지면
//   그대로 던진다 — 따라가기를 최선 노력으로 감싸는 것(실패하면 종전대로 답하기)은 부르는 쪽의 몫이다.
import { followMovedPath, type MoveRecord } from "./file-move-core.js";
import { parseAddress, formatAddress, type FileAddress } from "./address.js";

export interface AddressMoveDeps {
  /** 이 사람이 이 주소를 읽을 수 있나(권한표 — files/file-access authorizeFileAccess read 가 통과하나). */
  canRead(a: FileAddress): Promise<boolean>;
  /** 그 자리에 지금 무엇이 있나. null = 판정 불가(자리 밖을 가리키는 링크 등) — 옛 주소에서 null 이면 따라가지 않는다. */
  exists(a: FileAddress): Promise<boolean | null>;
  /** 공유 자리의 «옛 경로 → 새 경로» 기록(v6/file-move-store findFileMove 의 공유 자리). */
  lookup(rel: string, since: string | null): Promise<MoveRecord | null>;
}

/**
 * 옛 주소면 지금 자리, 아니면 null. alsoVisible — 닿은 자리에 더 거는 판정(file_path: 그 세션에서 보이는 자리여야 한다).
 *  null 의 뜻은 하나다: «따라가지 않는다» — 부르는 쪽은 받은 주소 그대로 종전처럼 답한다.
 */
export async function movedAddress(a: FileAddress, d: AddressMoveDeps, alsoVisible?: (to: FileAddress) => boolean): Promise<FileAddress | null> {
  if (a.root !== "shared" || !a.rel) return null;
  if (!(await d.canRead(a))) return null;
  const hit = await followMovedPath(a.rel, {
    lookup: (rel, since) => d.lookup(rel, since),
    exists: async (rel) => (await d.exists({ root: "shared", rel })) === true,
    visible: async (rel) => {
      const to: FileAddress = { root: "shared", rel };
      return addressable(to) && (await d.canRead(to)) && (alsoVisible ? alsoVisible(to) : true);
    },
  });
  if (!hit) return null;
  //  옛 자리에 지금 무엇이 있으면 그것이 이긴다 — 판정 불가(null)여도 따라가지 않는다.
  if ((await d.exists(a)) !== false) return null;
  return { root: "shared", rel: hit.path };
}

/** 주소로 건넬 수 있는 자리인가 — 주소 규칙(files/address parseAddress)을 그대로 지나는가. */
function addressable(a: FileAddress): boolean {
  try { parseAddress(formatAddress(a)); return true; } catch { return false; }
}
