// 대시보드 개인화 capability(#1129) — 멤버별 '내 프로젝트' 위젯 개요 카드 정리(리스트 순서·숨김·핀).
//  개인 UI 상태라 REST 전용(mcp:false), scope:null(인증만 — 즐겨찾기와 동형). 경로 prefix=/api/ui/v6/dash-prefs.
//  REST 는 input(zod) 을 안 쓰고 mount.parse 가 검증한다(types.ts) — parse 에서 body 를 그대로 넘기고
//  정규화·방어는 dash-pref-store 가 전담(toIntArr). 저장은 POST(RestMount 는 GET/POST 만 허용).
import { z } from "zod";
import type { Capability } from "./types.js";
import { getDashPrefs, setDashPrefs } from "../v6/dash-pref-store.js";

const intArr = z.array(z.number().int()).optional();

// ── 내 대시보드 개인화 조회 ──
const dashPrefsIndex: Capability = {
  name: "dash_prefs_index",
  title: "내 대시보드 개인화",
  description: "로그인한 멤버의 대시보드 '내 프로젝트' 위젯 개인화(개요 리스트 순서·숨김·직접 추가 핀). 진입 시 서버에서 불러와 적용.",
  scope: null,
  input: {},
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/v6/dash-prefs"], parse: () => ({}) }],
  },
  handler: async (_input, user) => await getDashPrefs(user?.userId ?? ""),
};

// ── 대시보드 개인화 저장(전체 덮어쓰기) ──
const dashPrefsSet: Capability = {
  name: "dash_prefs_set",
  title: "대시보드 개인화 저장",
  description: "대시보드 '내 프로젝트' 위젯 개인화(리스트 순서·숨김·핀)를 멤버별로 저장(전체 덮어쓰기). 갱신된 값을 반환.",
  scope: null,
  input: { list_order: intArr, ov_hidden: intArr, ov_pinned: intArr },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/dash-prefs"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { list_order: b.list_order, ov_hidden: b.ov_hidden, ov_pinned: b.ov_pinned };
      } }],
  },
  handler: async (input: any, user) => await setDashPrefs(user?.userId ?? "", input),
};

export const dashPrefsCapabilities: Capability[] = [dashPrefsIndex, dashPrefsSet];
