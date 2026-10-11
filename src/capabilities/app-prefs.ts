// 앱 × 보는 사람 개인 설정 capability (#4601) — REST 전용(앱 화면 다리 lively.prefs.get/set 이 부른다).
//  병합·크기·NUL 규칙은 apps/app-prefs.ts(순수), 저장은 org/store/apps.ts updateMemberPref(한 트랜잭션 · FOR UPDATE). 쓰기는 POST(RestMount 는 GET/POST 만).
//  동의(grant)를 묻지 않는다 — 머리말(apps/app-prefs.ts) 참조. 앱이 있기만 하면 구성원 누구나 자기 설정을 읽고 쓴다.
//  쓰기 빈도 (테넌트, 사람, 앱) 분당 60 — 앱 코드가 입력마다 저장하다 DB 를 두드리지 못하게(사람의 설정 변경은 분당 몇 번이다).
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import { getApp, getMemberPref, updateMemberPref } from "../org/store/apps.js";
import { PREFS_WRITES_PER_MINUTE, assertPatch, mergePrefs, serializePrefs } from "../apps/app-prefs.js";
import { RateWindow } from "../apps/app-chat-send.js";
import { appSqlTenantId } from "../apps/app-sql-exec.js";

const writeRate = new RateWindow(PREFS_WRITES_PER_MINUTE);

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
  description: "이 앱에 대한 나의 설정을 얕게 병합해 저장한다(patch 의 키만 바뀜 · 값 null 은 그 키 삭제). 16KB 상한(초과 413) · NUL 문자 400 · 분당 60회. 병합 뒤 전체를 돌려준다. REST 전용.",
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
    assertPatch(input.patch);                       // 잠그기 전에 거를 수 있는 것(모양·NUL)은 먼저 — 트랜잭션을 헛되이 열지 않는다
    if (!(await getApp(id))) throw new HttpError(404, `앱 없음: ${id}`);
    if (!writeRate.take(`${appSqlTenantId()}\0${member}\0${id}`, Date.now())) {
      throw new HttpError(429, `개인 설정 저장이 너무 잦습니다(분당 ${PREFS_WRITES_PER_MINUTE}회) — 입력마다 저장하지 말고 바뀐 뒤 한 번 저장하세요`);
    }
    const patch = input.patch;
    const prefs = await updateMemberPref(id, member, (cur) => { const merged = mergePrefs(cur, patch); return { prefs: merged, json: serializePrefs(merged) }; });
    return { app_id: id, prefs };
  },
};

export const appPrefsCapabilities: Capability[] = [appPrefsGet, appPrefsSet];
