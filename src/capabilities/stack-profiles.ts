// 스택 프로필 capability — org_stack_profile CRUD('어떻게 띄우나'). throwaway backing 프리뷰가 참조한다.
//  #1313 R25: preview-env.ts 에 얹혀 있던 3종을 분리했다 — 미리보기 '인스턴스'(org_preview_env)와
//  '띄우는 법 정의'(org_stack_profile)는 수명도 권한도 다른 축이다.
//  ⚠ **권한이 갈린다.** 조회(list)는 `code` — 미리보기를 만들 때 프로필을 골라야 하는 건 작업자다.
//   정의(set/delete)는 `admin` — start_cmd·build_cmd 는 셸 명령이라 아무나 만들면 그게 곧 임의 코드 실행이다.
//  등록은 index.ts 의 all[] 이 preview_env_* → repo_branch_list 다음 자리에 그대로 concat 한다(표면 순서 불변).
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import { listStackProfiles, upsertStackProfile, deleteStackProfile } from "../preview/preview-envs.js";

// id 슬러그 가드 — preview-env.ts 의 pid 와 **문구까지 동일**해야 한다(에러 표면 불변).
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function pid(v: unknown): string {
  const id = String(v ?? "").trim().toLowerCase();
  if (!ID_RE.test(id)) throw new HttpError(400, "id 는 소문자 슬러그(a-z0-9_-, 64자 이내)여야 합니다");
  return id;
}

const spList: Capability = {
  name: "stack_profile_list",
  title: "스택 프로필 목록",
  description: "스택 프로필(org_stack_profile) 목록 — '어떻게 띄우나'(build_cmd·start_cmd·port_env·env·healthcheck). 미리보기를 만들 때 고르거나, 비우면 레포로 자동 매칭된다.",
  scope: "code", // 조회는 작업자도 필요(만들 때 고른다). 정의(set/delete)는 셸 명령을 담으므로 admin.
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/stack-profiles"], parse: () => ({}) }] },
  handler: async () => ({ profiles: await listStackProfiles() }),
};

const spSet: Capability = {
  name: "stack_profile_set",
  title: "스택 프로필 생성/수정",
  description:
    "스택 프로필 upsert(id 기준). static_only=true 면 정적(shared-proxy 용, start_cmd 불요). false 면 start_cmd 를 워크트리에서 실행하고 " +
    "port_env(기본 PORT)로 할당 포트를 주입, env_json 을 추가 env 로 넣는다. build_cmd 는 띄우기 전 빌드. healthcheck_path 로 기동 확인.",
  scope: "admin", // start_cmd·build_cmd = 셸 명령 → **정의는 관리자만**(사용은 code).
  input: {
    id: z.string(),
    label: z.string().max(200).optional(),
    repo: z.string().max(100).optional(),
    static_only: z.boolean().optional(),
    start_cmd: z.string().max(1000).optional(),
    // build_cmd — 스토어·DB·목록 응답엔 처음부터 있었는데 **입구만 빠져 있었다**(#2143). 그 탓에 빌드가 필요한
    //  레포의 프로필을 에이전트도 관리자도 못 고쳐, 프리뷰가 깨진 채로 손댈 자리가 없었다(시드된 값만 유효).
    build_cmd: z.string().max(1000).optional(),
    port_env: z.string().max(64).optional(),
    env_json: z.record(z.string()).optional(),
    healthcheck_path: z.string().max(200).optional(),
    note: z.string().max(2000).optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/stack-profiles"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return {
        id: b.id, label: b.label, repo: b.repo, start_cmd: b.start_cmd, build_cmd: b.build_cmd, port_env: b.port_env,
        healthcheck_path: b.healthcheck_path, note: b.note,
        static_only: typeof b.static_only === "boolean" ? b.static_only : undefined,
        env_json: (b.env_json && typeof b.env_json === "object" && !Array.isArray(b.env_json)) ? b.env_json : undefined,
      };
    } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const actor = ctx?.actor ?? user?.userId ?? null;
    return { profile: await upsertStackProfile({ ...input, id: pid(input.id) }, actor) };
  },
};

const spDel: Capability = {
  name: "stack_profile_delete",
  title: "스택 프로필 삭제",
  description: "스택 프로필 삭제. 이 프로필을 쓰는 throwaway 프리뷰는 다음 띄우기에서 오류가 난다(프로필 재지정 필요).",
  scope: "admin",
  input: { id: z.string() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/stack-profiles/:id/delete"], parse: (req) => ({ id: req.params?.id }) }] },
  handler: async (input: any) => deleteStackProfile(pid(input.id)),
};

export const stackProfileCapabilities: Capability[] = [spList, spSet, spDel];
