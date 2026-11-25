// 게이트웨이 로컬 디스크에서 «워크스페이스마다 따로» 둬야 하는 자리의 폴더 조각.
//
//  왜: 게이트웨이가 레포를 받아 두는 자리(작업 base `<공유 루트>/repos/<이름>` · 스캐너 클론 `<상태 루트>/repos/<이름>`)는
//   **레포 이름만으로** 정해졌다. DB 는 워크스페이스로 갈리는데(RLS) 디스크는 안 갈려서, 게이트웨이 하나가 여러 워크스페이스를
//   서비스하는 배포(매니지드 공유 게이트웨이 · 셀프호스트 다중 워크스페이스)에서는 다른 워크스페이스가 같은 이름으로 레포를
//   등록하면 먼저 받아 둔 쪽의 클론을 그대로 썼다 — 자격 없이 남의 비공개 코드를 읽고(판 읽기 · 워크트리 · 위키 수집),
//   주소가 달라도 엉뚱한 코드를 제 것으로 읽었다.
//
//  규칙: 워크스페이스 열쇠가 있으면 그 자리 밑에 `@ws/<워크스페이스 id>/` 를 끼운다.
//   · 열쇠 = 워크스페이스(테넌트) id(UUID). 이름(slug)이 아니다 — id 는 바뀌지 않고 다시 쓰이지 않는다.
//   · 열쇠 없음 = 종전 자리 그대로: 단일 워크스페이스 배포 · 셀프호스트 다중 워크스페이스의 primary(기존 박스 워크스페이스) ·
//     노드(구성원 PC · 워커 · 테넌트별 세션 호스트 — 그 디스크는 이미 한 워크스페이스의 것이다). 이미 받아 둔 클론 · 워크트리가 그대로 쓰인다.
//   · `@` 는 레포 이름(영문 · 숫자 · . _ -)에 올 수 없어 `@ws` 가 레포 이름과 겹치지 않는다.
//   · 열쇠가 UUID 꼴이 아니면 **던진다** — 조용히 종전(공용) 자리로 떨어지면 그게 곧 남의 자리다.
//
//  잎 모듈이다(import 없음) — 노드 에이전트 번들에도 실린다(project/project-provision 이 쓴다). 누가 열쇠를 답하는지는 부팅 배선이
//   꽂는다(db/tenant-binding-boot.ts — 요청 컨텍스트의 워크스페이스). 안 꽂으면 언제나 종전 자리다.

export type WorkspaceDirKeyResolver = () => string | null;
let resolver: WorkspaceDirKeyResolver = () => null;

/** 부팅 배선이 한 번 꽂는다. 안 꽂으면 열쇠 없음(종전 자리). */
export function installWorkspaceDirKeyResolver(fn: WorkspaceDirKeyResolver): void {
  resolver = fn;
}

/** 워크스페이스별 자리의 표지 폴더 — 레포 이름 꼴 밖의 글자(@)로 시작한다. */
export const WORKSPACE_DIR_MARK = "@ws";

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 지금 이 호출의 워크스페이스 열쇠(소문자 UUID) — 없으면 null(종전 자리). 꼴이 틀리면 던진다. */
export function workspaceDirKey(): string | null {
  const raw = resolver();
  if (raw == null || raw === "") return null;
  const key = String(raw).toLowerCase();
  if (!KEY_RE.test(key)) {
    throw new Error("워크스페이스 열쇠가 UUID 꼴이 아닙니다 — 워크스페이스별 자리를 정할 수 없어 멈춥니다(공용 자리로 떨어뜨리지 않는다)");
  }
  return key;
}

/** base 밑에 끼울 폴더 조각 — 열쇠가 없으면 [], 있으면 ["@ws", "<id>"]. */
export function workspaceDirSegments(): string[] {
  const key = workspaceDirKey();
  return key ? [WORKSPACE_DIR_MARK, key] : [];
}
