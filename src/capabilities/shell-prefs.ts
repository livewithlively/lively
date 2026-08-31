// 새 셸(v2) 개인화 capability(#2460) — 멤버별 고정·치움·묶는 축·접힘·레일 순서·최근 앱.
//  개인 UI 상태라 REST 전용(mcp:false), scope:null(인증만 — 대시보드·구 셸 사이드바 개인화와 동형).
//  경로 prefix=/api/ui/v6/shell-prefs.
//  REST 는 input(zod) 을 안 쓰고 mount.parse 가 검증한다(types.ts) — parse 는 body 를 그대로 넘기고
//  정규화·허용목록·상한은 shell-pref-store 가 전담(normalizeShellPrefs). 저장은 POST(RestMount 는 GET/POST 만 허용).
import { z } from "zod";
import type { Capability } from "./types.js";
import { getShellPrefs, setShellPrefs } from "../v6/shell-pref-store.js";

// ── 내 새 셸 개인화 조회 ──
const shellPrefsIndex: Capability = {
  name: "shell_prefs_index",
  title: "내 셸 개인화",
  description: "로그인한 멤버의 새 셸 개인화(앱·프로젝트 고정, 치운 행, 묶는 축, 접힘/펼침, 레일 순서, 최근 앱). 진입 시 서버에서 불러와 적용.",
  scope: null,
  input: {},
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/v6/shell-prefs"], parse: () => ({}) }],
  },
  handler: async (_input, user) => await getShellPrefs(user?.userId ?? ""),
};

// ── 새 셸 개인화 저장(전체 덮어쓰기) ──
const shellPrefsSet: Capability = {
  name: "shell_prefs_set",
  title: "셸 개인화 저장",
  description: "새 셸 개인화를 멤버별로 저장(전체 덮어쓰기). 허용목록 밖의 키는 버린다. 갱신된 값을 반환.",
  scope: null,
  input: { prefs: z.record(z.unknown()).optional() },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/shell-prefs"],
      parse: (req) => ({ prefs: (req.body ?? {} as Record<string, unknown>).prefs }) }],
  },
  handler: async (input: any, user) => await setShellPrefs(user?.userId ?? "", input?.prefs),
};

export const shellPrefsCapabilities: Capability[] = [shellPrefsIndex, shellPrefsSet];
