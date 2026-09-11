// 새 셸(v2) 개인화 capability(#2460) — 멤버별 고정·치움·묶는 축·접힘/펼침·레일 순서·최근 앱.
//  개인 UI 상태라 REST 전용(mcp:false), scope:null(인증만 — 대시보드·구 셸 사이드바 개인화와 동형).
//  경로 prefix=/api/ui/v6/shell-prefs.
//  REST 는 input(zod) 을 안 쓰고 mount.parse 가 검증한다(types.ts) — parse 는 body 를 그대로 넘기고
//  정규화·허용목록·상한은 shell-pref-store 가 전담(normalizeShellPrefs). 저장은 POST(RestMount 는 GET/POST 만 허용).
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { getShellPrefs, patchShellPrefs, setShellPrefs } from "../v6/shell-pref-store.js";

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

// ── 새 셸 개인화 저장 ──
//  #3887 — `patch` 가 있으면 **그 저장소만** 병합하고(null·빈 값 = 그 저장소 지움), 없으면 종전대로 `prefs` 로 통째 교체한다.
//   새 화면은 둘을 **함께** 보낸다: 옛 서버는 `patch` 를 모르고 `prefs` 로 교체한다(종전과 같다). `patch` 만 보내면
//   옛 서버는 `prefs` 가 없는 요청을 «빈 문서로 교체» 로 읽어 계정의 정리를 통째로 지운다.
//   ⚠ patch 로 한 번이라도 쓴 행에는 통째 교체(옛 번들 탭)를 **409 로 거절**한다 — 낡은 캐시의 통째 교체 한 번이 다른
//    기기의 정리를 덮고, 새 화면은 덮인 저장소를 다시 보내지 않아 그대로 굳는다(shell-pref-store.ts PATCHED_KEY).
const shellPrefsSet: Capability = {
  name: "shell_prefs_set",
  title: "셸 개인화 저장",
  description: "새 셸 개인화를 멤버별로 저장. patch 가 있으면 거기 든 저장소만 병합(null·빈 값은 그 저장소 삭제), 없으면 prefs 로 전체 덮어쓰기. 허용목록 밖의 키는 버리고, 상한·형식으로 버린 개수는 dropped 로 알린다. 저장 뒤 서버 문서 전체를 반환.",
  scope: null,
  input: { prefs: z.record(z.unknown()).optional(), patch: z.record(z.unknown()).optional() },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/shell-prefs"],
      parse: (req) => { const b = (req.body ?? {}) as Record<string, unknown>; return { prefs: b.prefs, patch: b.patch }; } }],
  },
  handler: async (input: any, user) => {
    const uid = user?.userId ?? "";
    const patch = input?.patch;
    if (patch && typeof patch === "object" && !Array.isArray(patch)) return await patchShellPrefs(uid, patch);
    const out = await setShellPrefs(uid, input?.prefs);
    if (!out) throw new HttpError(409, "이 계정의 셸 설정은 새 화면이 관리합니다 — 페이지를 새로 고친 뒤 다시 해 주세요");
    return out;
  },
};

export const shellPrefsCapabilities: Capability[] = [shellPrefsIndex, shellPrefsSet];
