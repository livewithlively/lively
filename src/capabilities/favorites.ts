// 멤버 즐겨찾기 capability(#670) — 사용자별 사이드바 핀(리스트·카테고리). 개인 UI 상태라 REST 전용(mcp:false),
//  scope:null(인증만 — 프로젝트 탭 'memory'·WIKI 'context' 어느 쪽 사용자든 접근). 경로 prefix=/api/ui/v6/favorites.
import { z } from "zod";
import { HttpError, parseId } from "./rest-util.js";
import type { Capability } from "./types.js";
import { listFavorites, setFavorite, type FavoriteKind } from "../v6/favorite-store.js";

const KINDS = ["project_list", "category"] as const;
function parseKind(v: unknown): FavoriteKind {
  const s = String(v ?? "");
  if (!(KINDS as readonly string[]).includes(s)) throw new HttpError(400, "kind 는 project_list 또는 category 여야 합니다");
  return s as FavoriteKind;
}

// ── 내 즐겨찾기 목록 ──
const favoritesIndex: Capability = {
  name: "favorites_index",
  title: "내 즐겨찾기",
  description: "로그인한 멤버의 즐겨찾기(핀)한 리스트·카테고리 id 목록. 프로젝트 탭/WIKI 사이드바가 맨 위 '⭐ 즐겨찾기' 구역 렌더에 사용.",
  scope: null,
  input: {},
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/v6/favorites"], parse: () => ({}) }],
  },
  handler: async (_input, user) => await listFavorites(user?.userId ?? ""),
};

// ── 즐겨찾기 토글 ──
const favoritesSet: Capability = {
  name: "favorites_set",
  title: "즐겨찾기 설정",
  description: "리스트/카테고리를 즐겨찾기에 추가(on)하거나 제거(off). 갱신된 전체 즐겨찾기 집합을 반환.",
  scope: null,
  input: { kind: z.enum(KINDS), id: z.number().int().positive(), on: z.boolean() },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/favorites"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { kind: parseKind(b.kind), id: parseId(b.id), on: b.on !== false && b.on !== "false" && b.on != null };
      } }],
  },
  handler: async (input: any, user) => await setFavorite(user?.userId ?? "", input.kind, input.id, !!input.on),
};

export const favoritesCapabilities: Capability[] = [favoritesIndex, favoritesSet];
