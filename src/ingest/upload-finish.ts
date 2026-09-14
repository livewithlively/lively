// 업로드 **마무리** 한 자리 (#3787 D) — 바이트가 목적지에 놓인 뒤부터 응답까지.
//
// ── 왜 한 자리여야 하는가 ────────────────────────────────────────────────────
//  업로드 입구는 인가·좌표 해석이 서로 달라 갈라질 수밖에 없다(브라우즈 루트 게이트 vs 프로젝트 게이트).
//  그런데 **그 뒤는 전부 같아야 한다** — 그룹 rw, 자료 등록, 좌표(ref), 결과 도장(mtime/size).
//  실제로 갈라져 있었다(2026-09-14 실측):
//   · `PUT /terminal/browse/file` — grantSharedGroupWrite 없음(공유 루트로 올린 파일을 격리 세션이 못 고침),
//                                   mtime/size 없음(up-sync 훅이 기준선을 못 적음)
//   · `PUT /v6/projects/:id/file` — skipped 없음(자료 등록 실패가 화면에서 조용히 사라짐),
//                                   심링크 봉쇄(assertJailed) 없음
//  둘 다 «한쪽에만 있는 것»이지 설계된 차이가 아니다. 입구가 늘 때마다 이 표가 한 칸씩 더 비므로,
//  마무리를 함수 하나로 못 박는다 — 새 입구는 이걸 부르기만 하면 전부 갖춘다.
import fsp from "node:fs/promises";
import path from "node:path";
import { localExternalId } from "./local-file-core.js";
import type { LocalRoot } from "./local-file-core.js";
import { ingestLocalUpload } from "./local-file.js";
import { grantSharedGroupWrite } from "../project/project-fs.js";
import { memberStat } from "../terminal/terminal-member-fs.js";   // 격리 멤버(#524) 개인 폴더는 그 uid 로만 stat 된다
import { logger } from "../log.js";

/** 업로드가 놓인 **좌표** — localRootForBrowse 의 반환과 같은 모양(프로젝트 라우트는 직접 만든다). */
export interface UploadCoord {
  root: LocalRoot;
  /** 좌표의 기준 절대경로(상대경로 = path.relative(base, abs)) */
  base: string;
  folder?: string | null;
  channelFallback: string;
}

export interface UploadFinished {
  ok: true; path: string;
  ref?: string; source_id?: number; skipped?: string;
  mtime?: number; size?: number;
}

/**
 * 업로드 마무리 — 그룹 rw → 자료 등록 → 좌표·도장. **어떤 실패도 던지지 않는다**(바이트는 이미 놓였다).
 *  coord 가 null 이면(모르는 루트) 좌표·자료 없이 경로와 도장만 돌려준다 — 좌표를 **지어내지 않는다**.
 */
export async function finishUpload(o: {
  coord: UploadCoord | null;
  abs: string;
  osUser: string | null;
  uploader: { id: string | null; name: string | null };
  /** #1631 — 자기 개인 루트 업로드를 «올린 사람만» 으로 잠그지 않는다. 개인 루트에서만 의미가 있다. */
  shareWithTeam?: boolean;
}): Promise<UploadFinished> {
  const { coord, abs, osUser } = o;
  // ① 공유 그룹 rw — 게이트웨이(lively)가 쓴 644 파일을 격리 세션의 box_ 사용자가 고칠 수 있게(#1246).
  //   개인 루트는 **uid 로 격리**된 자리라 그룹을 열면 격리가 무너진다 — 거기엔 절대 걸지 않는다.
  if (coord && coord.root.kind !== "personal") {
    await grantSharedGroupWrite(abs, coord.base, "file")
      .catch((e) => logger.warn({ err: e, abs }, "[upload] 그룹 rw 부여 실패 — 세션이 이 파일을 못 고칠 수 있다"));
  }
  // ② 자료 1건(#1881 L1) — 실패해도 업로드는 성공이다(사유는 skipped 로 사람에게 사실대로 말한다).
  let ing: Awaited<ReturnType<typeof ingestLocalUpload>> | null = null;
  if (coord) {
    ing = await ingestLocalUpload({
      root: coord.root, folder: coord.folder ?? null, base: coord.base, abs, osUser,
      uploader: o.uploader, channelFallback: coord.channelFallback, shareWithTeam: o.shareWithTeam,
    }).catch((e) => { logger.warn({ err: e, abs }, "[local-ingest] 자료 등록 실패"); return null; });
  }
  // ③ 도장 — up-sync 훅이 **로컬 mtime 을 이 값으로 맞추고 원장 기준선으로 적어야** 다음 pull 이
  //   「내가 올린 것」과 「남이 고친 것」을 구별한다. 없으면 크기·시각 추측으로 남의 최신본을 덮는다(#905 C3).
  //  ⚠ 격리 멤버(#524)의 개인 폴더는 700 이라 **게이트웨이가 직접 stat 못 한다** — 그 uid 로 물어야 한다.
  //   종전엔 여기가 fsp.stat 하나뿐이라 개인 폴더 업로드만 조용히 도장이 비었다(#3787 E2E 실측 2026-09-14).
  const st = osUser
    ? await memberStat(osUser, abs)
      .then((r) => (r && r.file && r.mtime ? { mtimeMs: r.mtime, size: r.size } : null))   // mtime 없으면 도장 생략(0 은 epoch 이라 더 나쁘다)
      .catch(() => null)
    : await fsp.stat(abs).catch(() => null);
  return {
    ok: true, path: abs,
    // ④ 좌표 — 자료 external_id 와 **같은 문자열**. 절대경로(`path`)는 이 게이트웨이 것이라 세션이 다른
    //   기계면 존재하지 않는다. 그걸 지시문에 실어 AI 가 «있다»고 믿은 것이 #3787 이다.
    ...(coord ? { ref: localExternalId(coord.root, path.relative(coord.base, abs)) } : {}),
    ...(st ? { mtime: Math.floor(st.mtimeMs), size: st.size } : {}),
    ...(ing?.ingested ? { source_id: ing.source_id } : {}),
    ...(ing && !ing.ingested ? { skipped: ing.reason ?? ing.kind ?? "unknown" } : {}),
  };
}
