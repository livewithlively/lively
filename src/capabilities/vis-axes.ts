// #1291 — 맥락 유형별 공개범위 켜기/끄기 (관리탭). 조직이 "우리는 이 축은 안 쓴다"를 고를 수 있게 한다.
//
//  ⚠ 이 capability 의 핵심은 토글 자체가 아니라 **끄기가 정보 공개 사건이라는 것을 사용자에게 알리는 일**이다.
//   잠긴 항목이 있는 축을 끄면 지금까지 일부만 보던 내용이 그 순간 전원에게 열린다. 그래서:
//   ① 먼저 무엇이 몇 건 공개되는지 보여주고(vis_axis_list) ② 끌 때 confirm 을 요구하고
//   ③ 무슨 일이 있었는지 작업기록에 남긴다. 확인 없이 끄면 400 + 공개될 목록을 응답에 실어 돌려준다.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import { VIS_AXES, AXIS_LABEL, axisLockSummary, setVisAxes, type VisAxis } from "../v6/visibility-axes.js";
import { PROJECT_ACCESS_MODES, PROJECT_ACCESS_LABEL, projectAccessInfo, projectAccessMode, setProjectAccessMode, type ProjectAccessMode } from "../v6/project-access.js";
import { logActivity } from "../activity/store.js";
import { logger } from "../log.js";
import { reconcileAllDerived } from "../v6/derived-visibility.js";

const visAxisList: Capability = {
  name: "vis_axis_list",
  title: "맥락 공개범위 — 유형별 사용 여부",
  description:
    "맥락 유형별(프로젝트·지식·자료·공유폴더·세션 기록범위) 공개범위 기능의 켜짐/꺼짐과, 각 유형에서 지금 " +
    "공개범위가 걸려 있는 항목 수를 돌려준다. 끄면 그 항목들이 전원에게 공개되므로 vis_axis_set 전에 이걸로 확인한다.",
  scope: "admin",
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/vis/axes"], parse: () => ({}) }] },
  handler: async () => ({ axes: await axisLockSummary() }),
};

const visAxisSet: Capability = {
  name: "vis_axis_set",
  title: "맥락 공개범위 — 유형별 사용 여부 설정",
  description:
    "맥락 유형의 공개범위 기능을 켜거나 끈다. **끄면 그 유형에 걸려 있던 공개범위가 전부 무효가 되어 " +
    "조직 전원에게 공개된다** — 잠긴 항목이 있는 축을 끌 때는 confirm:true 가 필요하고, 그 사실이 작업기록에 남는다. " +
    "켜는 것은 확인이 필요 없다(좁히는 방향이라 새로 공개되는 것이 없다). " +
    "⚠ 자료·지식 축이 둘 다 켜지는 순간(또는 이미 켜진 자료·지식 축을 다시 켜기로 부르면) 잠긴 자료에서 나온 지식(derived_from)을 " +
    "그 자료를 볼 수 있는 사람만 보도록 **좁힌다** — 지금 그 지식을 보던 사람이 못 보게 될 수 있고, 지식을 다시 넓히는 도구는 없다. " +
    "응답의 derived_narrowed 가 좁힌 지식 수다. 바뀐 지식마다 감사(set_visibility · reason axis_on)가 남는다.",
  scope: "admin",
  input: {
    axis: z.enum(VIS_AXES).describe("project|knowledge|source|shared_folder|session_cap"),
    on: z.boolean().describe("true=공개범위 사용, false=사용 안 함(전원 공개)"),
    confirm: z.boolean().optional().describe("잠긴 항목이 있는 축을 끌 때 필수 — 공개에 동의한다는 표시"),
    reason: z.string().max(500).optional().describe("왜 끄는지(작업기록에 남는다)"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/vis/axes"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const axis = String(b.axis ?? "");
        if (!(VIS_AXES as readonly string[]).includes(axis)) throw new HttpError(400, `axis 는 ${VIS_AXES.join("|")}`);
        return { axis, on: b.on !== false, confirm: b.confirm === true, reason: b.reason ? String(b.reason) : undefined };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const axis = input.axis as VisAxis;
    const summary = await axisLockSummary();
    const cur = summary.find((s) => s.axis === axis)!;

    if (!input.on && cur.locked > 0 && !input.confirm) {
      // 확인 없이 끄려 함 — 무엇이 공개되는지 돌려주고 멈춘다. 이 응답이 곧 확인 화면의 재료다.
      throw new HttpError(400, JSON.stringify({
        error: "확인이 필요합니다",
        message: `'${AXIS_LABEL[axis]}' 를 끄면 지금 공개범위가 걸린 ${cur.locked}건이 조직 전원에게 공개됩니다. ` +
          "계속하려면 confirm:true 로 다시 요청하세요.",
        axis, locked: cur.locked, samples: cur.samples,
      }));
    }
    //  #4824 — 이미 켜진 자료·지식 축을 다시 «켜기» 로 부르면 잠긴 자료에서 나온 지식 맞추기만 다시 돈다(멱등 · 다시 돌리는 입구).
    if (cur.on === input.on) {
      if (input.on && (axis === "source" || axis === "knowledge")) {
        const again = await reconcileAllDerived({ actor: user?.userId ?? null, source: ctx?.source ?? "web" })
          .catch((e) => ({ error: (e as Error)?.message ?? String(e) }));
        return { axis, on: input.on, changed: false, derived_narrowed: again, axes: summary };
      }
      return { axis, on: input.on, changed: false, axes: summary };
    }

    await setVisAxes({ [axis]: input.on });
    //  #4824 — 자료·지식 축이 둘 다 켜지는 순간, 축이 꺼져 있던 동안 이은 연결(상속을 건너뛴 것)을 맞춘다. 안 하면 «잠긴 자료에서
    //   나온 지식이 연결이 있는데도 공개» 로 남는다. 좁히는 방향이라 확인은 필요 없다(켜기와 같은 성격). 실패해도 축은 켜진 채다 —
    //   다음 연결·자료 좁히기 때 그 지식이 다시 맞춰지고, 이 응답에 실패를 싣는다.
    let derivedNarrowed: number | { error: string } | null = null;
    if (input.on && (axis === "source" || axis === "knowledge")) {
      const wctx = { actor: user?.userId ?? null, source: ctx?.source ?? "web" };
      derivedNarrowed = await reconcileAllDerived(wctx)
        .catch((e) => {
          logger.error({ axis, err: (e as Error)?.message }, "[vis-axes] 잠긴 자료에서 나온 지식 맞추기 실패 — 축은 켜졌다");
          return { error: (e as Error)?.message ?? String(e) };
        });
      //  축 설정은 프로세스마다 30초 보관된다(visibility-axes.ts) — 다른 프로세스가 아직 «꺼짐» 으로 보고 이은 연결을 그 창이
      //   지난 뒤 한 번 더 맞춘다. 실패는 기록만(축은 켜졌고, 같은 입구로 다시 돌릴 수 있다).
      setTimeout(() => {
        reconcileAllDerived(wctx).catch((e) => logger.warn({ axis, err: (e as Error)?.message }, "[vis-axes] 두 번째 맞추기 실패"));
      }, 35_000).unref?.();
    }
    // 되돌리기 어려운 조직 단위 변경이라 반드시 흔적을 남긴다(누가·언제·무엇이 공개됐나).
    // ⚠ type 은 activity_type_chk 허용값이어야 한다 — 'config' 는 없는 값이라 INSERT 가 깨졌고,
    //  아래 .catch 가 그걸 **조용히 삼켜** 감사 기록이 설계에만 있고 실제로는 안 남았다(고객사 A에서 실제로 그랬다).
    //  'decision' 은 허용값이고 의미도 맞다 — 조직이 공개 정책을 바꾼 결정이다.
    await logActivity({
      type: "decision",
      title: input.on
        ? `공개범위 사용: '${AXIS_LABEL[axis]}' 켬`
        : `공개범위 사용: '${AXIS_LABEL[axis]}' 끔 — 잠겨 있던 ${cur.locked}건이 전원 공개됨`,
      summary: input.reason ?? null,
      body: JSON.stringify({ axis, on: input.on, unlocked: cur.locked, samples: cur.samples, ...(derivedNarrowed !== null ? { derived_narrowed: derivedNarrowed } : {}) }),
    }, user?.userId ?? null).catch((e) => {
      // 설정은 이미 저장됐으니 되돌리지 않는다. 다만 **삼키지도 않는다** — 이건 공개 사건의 감사 기록이고,
      //  조용히 실패하면 "남는다"는 약속이 거짓이 된다(실제로 그렇게 놓쳤다). 최소한 로그로는 남긴다.
      logger.error({ axis, on: input.on, unlocked: cur.locked, err: (e as Error)?.message },
        "[vis-axes] 공개범위 축 변경을 작업기록에 남기지 못했다 — 설정은 적용됨");
    });

    return {
      axis, on: input.on, changed: true, unlocked: input.on ? 0 : cur.locked,
      ...(derivedNarrowed !== null ? { derived_narrowed: derivedNarrowed } : {}),
      axes: await axisLockSummary(),
    };
  },
};

// ── #5598 새 프로젝트 공개 방식(초대제 | 전체 공개) ────────────────────────────────
//  축 켜기/끄기와 달리 **이 설정을 바꾸는 것은 공개 사건이 아니다** — 새로 만드는 프로젝트의 기본값만 바뀌고, 이미 있는
//  프로젝트는 그대로다(v6/project-access.ts 머리말). 그래서 확인 절차 없이 바꾸되, 조직 정책이 바뀐 것이라 작업기록에는 남긴다.
//  읽기는 구성원 누구나 — 화면이 «새 프로젝트는 나만 봅니다» 를 사실대로 말하려면 이 값이 필요하다.
//  enforced = 프로젝트 공개범위 축이 켜져 있나. 꺼져 있으면 초대제 표시가 아무것도 가리지 않으므로, 화면은 그때
//   «나만 봅니다» 라고 말하면 안 된다(거짓 안심).
const projectAccessGet: Capability = {
  name: "project_access_get",
  title: "새 프로젝트 공개 방식 조회",
  description: "이 워크스페이스에서 새로 만드는 프로젝트의 공개 방식 — invite(초대제: 만든 사람과 초대한 사람만 본다 · 기본값) | open(전체 공개: 전원이 본다. 세션 첫 지시로 생긴 초안만 만든 사람이 보다가 작업을 남기면 공개된다). enforced=false 면 프로젝트 공개범위 축이 꺼져 있어 모든 프로젝트가 전원에게 보인다.",
  scope: "memory",
  input: {},
  expose: { mcp: false, rest: [{ method: "GET", paths: ["/api/ui/v6/project-access"], parse: () => ({}) }] },
  handler: async () => {
    const info = await projectAccessInfo();
    return { mode: info.mode, label: PROJECT_ACCESS_LABEL[info.mode], enforced: info.enforced };
  },
};

const projectAccessSet: Capability = {
  name: "project_access_set",
  title: "새 프로젝트 공개 방식 설정",
  description:
    "이 워크스페이스에서 새로 만드는 프로젝트의 공개 방식을 정한다 — invite(초대제 · 기본값) | open(전체 공개). " +
    "**이미 있는 프로젝트의 공개 범위는 바뀌지 않는다** — 새 프로젝트의 기본값만 바뀐다. 프로젝트 하나를 열거나 닫는 것은 project_set_access_v6(만든 사람만).",
  scope: "admin",
  input: {
    mode: z.enum(PROJECT_ACCESS_MODES).describe("invite=초대제(만든 사람과 초대한 사람만) | open=전체 공개(초안만 닫혔다가 작업을 남기면 전원)"),
  },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/project-access"],
      parse: (req) => {
        const mode = String(((req.body ?? {}) as Record<string, unknown>).mode ?? "");
        if (!(PROJECT_ACCESS_MODES as readonly string[]).includes(mode)) throw new HttpError(400, `mode 는 ${PROJECT_ACCESS_MODES.join("|")}`);
        return { mode };
      } }],
  },
  handler: async (input: any, user: any) => {
    const next = input.mode as ProjectAccessMode;
    const cur = await projectAccessMode();
    const enforced = (await projectAccessInfo()).enforced;
    if (cur === next) return { mode: cur, label: PROJECT_ACCESS_LABEL[cur], enforced, changed: false };
    await setProjectAccessMode(next);
    await logActivity({
      type: "decision",
      title: `새 프로젝트 공개 방식: '${PROJECT_ACCESS_LABEL[cur]}' → '${PROJECT_ACCESS_LABEL[next]}'`,
      summary: "새로 만드는 프로젝트의 기본값만 바뀐다 — 이미 있는 프로젝트의 공개 범위는 그대로다.",
      body: JSON.stringify({ project_access: { from: cur, to: next } }),
    }, user?.userId ?? null).catch((e) => {
      logger.error({ from: cur, to: next, err: (e as Error)?.message },
        "[project-access] 새 프로젝트 공개 방식 변경을 작업기록에 남기지 못했다 — 설정은 적용됨");
    });
    return { mode: next, label: PROJECT_ACCESS_LABEL[next], enforced, changed: true };
  },
};

export const visAxesCapabilities: Capability[] = [visAxisList, visAxisSet, projectAccessGet, projectAccessSet];
