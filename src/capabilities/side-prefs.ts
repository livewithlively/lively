// 프로젝트 사이드바 개인화 capability(#1227) — 멤버별 폴더 접힘/펼침 상태.
//  개인 UI 상태라 REST 전용(mcp:false), scope:null(인증만 — 즐겨찾기·대시보드 개인화와 동형). 경로 prefix=/api/ui/v6/side-prefs.
//  REST 는 input(zod) 을 안 쓰고 mount.parse 가 검증한다(types.ts) — parse 에서 body 를 그대로 넘기고
//  정규화·방어는 side-pref-store 가 전담(toIdArr). 저장은 POST(RestMount 는 GET/POST 만 허용).
import { z } from "zod";
import type { Capability } from "./types.js";
import { getSidePrefs, setSidePrefs } from "../v6/side-pref-store.js";

const intArr = z.array(z.number().int()).optional();

// ── 내 사이드바 개인화 조회 ──
const sidePrefsIndex: Capability = {
  name: "side_prefs_index",
  title: "내 프로젝트 사이드바 개인화",
  description: "로그인한 멤버의 프로젝트 사이드바 개인화(폴더·스페이스 접힘/펼침). 진입 시 서버에서 불러와 적용.",
  scope: null,
  input: {},
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/v6/side-prefs"], parse: () => ({}) }],
  },
  handler: async (_input, user) => await getSidePrefs(user?.userId ?? ""),
};

// ── 사이드바 개인화 저장(전체 덮어쓰기) ──
const sidePrefsSet: Capability = {
  name: "side_prefs_set",
  title: "프로젝트 사이드바 개인화 저장",
  description: "프로젝트 사이드바에서 접어둔/펼쳐둔 폴더를 멤버별로 저장(전체 덮어쓰기). 갱신된 값을 반환.",
  scope: null,
  input: { folder_closed: intArr, folder_open: intArr },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/side-prefs"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { folder_closed: b.folder_closed, folder_open: b.folder_open };
      } }],
  },
  handler: async (input: any, user) => await setSidePrefs(user?.userId ?? "", input),
};

export const sidePrefsCapabilities: Capability[] = [sidePrefsIndex, sidePrefsSet];
