// 크론 액션: 관리기 실행(#1419 T5) — 파이프라인 마지막 단계('쌓인 지식을 계속 옳게 유지').
//
//  종류에 따라 여기서 끝나거나 배치로 넘어간다:
//   · mismatch·outdated — 결정적 SQL 판정. **이 틱 안에서** 발견을 쌓고 auto 면 조치까지 한다(LLM 비용 0).
//   · contradiction·code_drift — 후보를 좁혀 헤드리스 배치로 접수. 판정은 AI 가 하고
//     org_manager_finding_report 로 되돌려 적는다.
import { headlessRequester, HEADLESS_REQUESTER_MISSING, headlessFlags, enqueueHeadlessTask } from "./_headless.js";
import { listManagers, getManager, needsLlm } from "../../org/store/managers.js";
import { runManager, type ManagerRunResult } from "../../org/manage/run-manager.js";

export async function runManagers(
  params: Record<string, unknown>, jobId: string, createdBy: string | null,
): Promise<{ status: string; summary: unknown }> {
  // 대상 — params.manager 지정이면 그것만, 아니면 켜진 전부.
  let targets;
  try {
    if (params.manager) {
      const one = await getManager(String(params.manager));
      // 꺼졌거나 사라진 관리기를 가리키는 잡 — 조용히 no-op(수집기·분류기 잡과 같은 규칙).
      if (!one?.enabled) return { status: "ok", summary: { skipped: `관리기 '${String(params.manager)}' 가 없거나 꺼져 있음` } };
      targets = [one];
    } else {
      targets = (await listManagers()).filter((m) => m.enabled);
    }
  } catch (e) { return { status: "error", summary: { error: (e as Error)?.message ?? String(e) } }; }
  if (!targets.length) return { status: "ok", summary: { skipped: "켜진 관리기 없음" } };

  // LLM 이 필요한 관리기가 하나라도 있으면 의뢰자가 있어야 한다 — 결정적 관리기만이면 없어도 돈다
  //  (분류 어긋남·아웃데이티드는 LLM 을 안 쓰므로 과금 귀속이 필요 없다).
  const requester = headlessRequester(params, createdBy);
  if (!requester && targets.some((m) => needsLlm(m.kind))) return HEADLESS_REQUESTER_MISSING;

  const out: ManagerRunResult[] = [];
  for (const m of targets) {
    const enqueue = requester
      ? async (prompt: string, o: { model?: string | null; effort?: string | null; requester?: string | null; repo?: string | null; extra?: Record<string, unknown> }) =>
          enqueueHeadlessTask({
            prompt, requester: o.requester || requester, jobId,
            // repo 를 주면 base clone→worktree 를 자동 준비해 작업 cwd 로 삼는다(#1419 T8) —
            //  지식↔코드 비교는 코드를 실제로 읽어야 판정할 수 있고, 워크트리 없이는 AI 가 추측하게 된다.
            repo: o.repo ?? null,
            flags: headlessFlags({ model: o.model ?? params.model, effort: o.effort ?? params.effort }),
            extra: o.extra,
            // 관리기별로 마커를 갈라 준다 — 한 잡이 여러 관리기를 병렬 접수할 때 첫 관리기가
            //  나머지를 전부 '진행 중'으로 막지 않게(#1289 증류기에서 배운 것과 같은 함정).
            //  레포별로 또 갈라지므로 레포까지 마커에 넣는다(한 관리기가 레포 셋을 동시에 접수할 수 있다).
            marker: `cron:${jobId}#${m.key}${o.repo ? `@${o.repo}` : ""}`,
          })
      : undefined;
    out.push(await runManager(m, enqueue));
  }
  return { status: "ok", summary: { managers: out } };
}
