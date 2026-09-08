// 복원 시 프로젝트 귀속 판정(순수, #2549) — 프로젝트가 사라진 세션은 «프로젝트 없이» 되살린다.
//
// 왜: 복원은 desired-state 의 project_id 를 그대로 createSession 에 넘겼고, createSession 은 v6 프로젝트 세션의 DB current
//  기록(execution_session.desired_project_id) 실패를 «세션 생성 취소(503)» 로 다룬다 — 신규 세션엔 맞는 규율이다(삼키면
//  첫 훅이 미연결로 보고 프로젝트를 중복 생성한다). 그런데 그 프로젝트가 **완전 삭제**된 뒤의 복원은 FK 위반으로 반드시
//  죽는다(실측 2026-09-02 매니지드: «프로젝트 소속을 기록하지 못해 세션 생성을 취소했습니다 … desired_project_id_fkey»).
//  복원은 «있던 대화를 되살리는 것» 이다 — 프로젝트가 없어졌다고 대화까지 막다른 길이 되면 안 된다.
//
// 규칙: project_id 없음 → 그대로 · org 출처 → DB 기록이 없으니 확인 없이 통과 · v6 는 존재를 묻는다 —
//  없으면 id 를 떼고 dropped=true(호출자가 경고를 남긴다) · **확인 자체가 실패하면 떼지 않는다**(모르면 종전 동작).
export interface RestoreProjectRef { projectId?: number; projectSrc: "org" | "v6"; dropped: boolean }

export async function restoreProjectRef(
  st: { project_id?: number | null; project_src?: string | null },
  exists: (projectId: number) => Promise<boolean>,
): Promise<RestoreProjectRef> {
  const projectSrc: "org" | "v6" = st.project_src === "org" ? "org" : "v6";
  const pid = st.project_id ? Number(st.project_id) : undefined;
  if (!pid) return { projectId: undefined, projectSrc, dropped: false };
  if (projectSrc === "org") return { projectId: pid, projectSrc, dropped: false };
  let ok = true;
  try { ok = await exists(pid); } catch { ok = true; }
  return ok ? { projectId: pid, projectSrc, dropped: false } : { projectId: undefined, projectSrc, dropped: true };
}
