// 앱 × 보는 사람 개인 설정 capability (#4601) — REST 전용(앱 화면 다리 lively.prefs.get/set 이 부른다).
//  병합·크기 규칙은 apps/app-prefs.ts(순수), 저장은 org/store/apps.ts getMemberPref/setMemberPref. 쓰기는 POST(RestMount 는 GET/POST 만).
//  동의(grant)를 묻지 않는다 — 머리말(apps/app-prefs.ts) 참조. 앱이 있기만 하면 구성원 누구나 자기 설정을 읽고 쓴다.
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import { getApp, getMemberPref, setMemberPref } from "../org/store/apps.js";
import { mergePrefs, serializePrefs } from "../apps/app-prefs.js";

const who = (user: LivelyUser | undefined): string => {
  const id = user?.userId || "";
  if (!id) throw new HttpError(401, "인증이 필요합니다");
  return id;
};
const appIdOf = (input: Record<string, unknown>): string => {
  const id = String(input.app_id ?? "").trim();
  if (!id) throw new HttpError(400, "app_id 가 필요합니다");
  return id;
};

const appPrefsGet: Capability = {
  name: "app_prefs_get",
  title: "앱 개인 설정 읽기",
  description: "이 앱에 대한 **나의** 설정(배치·글자·접기 등 — 앱이 정한 작은 JSON). 없으면 {}. REST 전용.",
  scope: null,
  input: { app_id: z.string() },
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/apps/:id/prefs"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser | undefined) => {
    const member = who(user);
    const id = appIdOf(input);
    if (!(await getApp(id))) throw new HttpError(404, `앱 없음: ${id}`);
    return { app_id: id, prefs: await getMemberPref(id, member) };
  },
};

const appPrefsSet: Capability = {
  name: "app_prefs_set",
  title: "앱 개인 설정 저장",
  description: "이 앱에 대한 나의 설정을 얕게 병합해 저장한다(patch 의 키만 바뀜 · 값 null 은 그 키 삭제). 16KB 상한(초과 413). 병합 뒤 전체를 돌려준다. REST 전용.",
  scope: null,
  input: { app_id: z.string(), patch: z.record(z.unknown()) },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/prefs"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, patch: b.patch };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser | undefined) => {
    const member = who(user);
    const id = appIdOf(input);
    if (!(await getApp(id))) throw new HttpError(404, `앱 없음: ${id}`);
    const merged = mergePrefs(await getMemberPref(id, member), input.patch);
    const json = serializePrefs(merged);
    await setMemberPref(id, member, json);
    return { app_id: id, prefs: merged };
  },
};

export const appPrefsCapabilities: Capability[] = [appPrefsGet, appPrefsSet];
