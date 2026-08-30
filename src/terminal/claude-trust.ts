// 우리가 만든 세션 폴더를 **미리 신뢰해 둔다**(#1631) — 첫 실행 프롬프트가 첫 지시를 삼키던 것.
//
//  ── 무엇이 죽었나 (실측 2026-08-31, dev) ──
//  대화형 세션은 라이블리가 **방금 만든** 빈 폴더에서 `claude` 를 띄운다. 그러면 Claude Code 의 첫 실행
//   «Is this a project you trust?» 가 뜨는데, 그 화면은 stdin 으로 밀어 넣은 **첫 지시를 삼키고** 사람이
//   Enter 를 칠 때까지 기다리다 CLI 가 그대로 끝난다. 게이트웨이에는 `agentState=exited` 로만 보이고
//   대화 id 가 없어 화면은 트랜스크립트 404 를 무한히 되묻는다.
//  실측 사슬: 온보딩 완주 → 킥오프 세션 즉사 → **리브가 서랍마다 만들어 둔 증류기가 꺼진 채로 남는다**
//   (설계상 그걸 켜는 것이 리브다) → 온보딩을 끝까지 한 사람이 지식을 하나도 못 얻는다.
//  헤드리스(`claude -p`)엔 이 프롬프트가 없다 — 그래서 서랍 분석만 성공하는 «절반만 되는» 모양이 됐고,
//   API 층 점검으로는 영원히 안 보였다(터미널 pane 안의 일이라).
//
//  ── 경계 ──
//  ⚠ **우리가 만든 폴더만** 신뢰한다. 호출자가 «이 경로는 라이블리가 방금 만든 세션 작업 폴더다» 라고
//   보증할 때만 부른다 — 사람이 고른 임의 경로를 대신 신뢰해 주면 그건 보안 결정을 사람 대신 내리는 것이다.
//  ⚠ 로그인 상태는 **쓰지 않는다**(#2232 에서 보류된 판단 그대로 — 미리 쓰면 로그인 흐름 없이
//   «Not logged in» 입력칸에 떨어진다). 여기서 없애는 물음은 «폴더 신뢰» 하나뿐이다.
//  비치명이어야 한다 — 실패해도 세션은 떠야 한다(같은 부류의 선례: ensureGitSafeDirectory(#522)).

/** 신뢰 표식 키 — Claude Code 가 `~/.claude.json`(또는 CLAUDE_CONFIG_DIR/.claude.json)에 쓰는 이름. */
export const TRUST_KEY = "hasTrustDialogAccepted";

/** 판정 결과. `write:false` = 이미 신뢰돼 있거나 할 일이 없다(파일을 건드리지 않는다). */
export type TrustPatch = { write: false } | { write: true; text: string };

/**
 * 신뢰 표식을 넣은 새 파일 내용을 만든다(**순수** — 파일시스템 무접촉).
 *
 * @param current 지금 파일 내용. 없으면 null 을 넘긴다.
 * @param dir     신뢰할 절대 경로(= 세션 작업 폴더)
 *
 * 규칙:
 *  · 이미 true 면 `{write:false}` — 멱등(같은 세션을 다시 열어도 파일 mtime 이 안 바뀐다).
 *  · 다른 프로젝트 항목·같은 항목의 다른 키·최상위 다른 키는 **그대로 보존**한다.
 *  · 읽을 수 없는 내용(깨진 JSON·배열·문자열)이면 새로 만든다 — 그 파일은 claude 도 못 읽으므로 잃을 것이 없다.
 */
export function planTrustPatch(current: string | null, dir: string): TrustPatch {
  const target = String(dir ?? "").trim();
  if (!target) return { write: false };   // 경로가 없으면 할 일이 없다

  let root: Record<string, unknown> = {};
  if (current != null && current.trim()) {
    try {
      const parsed: unknown = JSON.parse(current);
      // 배열도 typeof 'object' 다 — 객체가 아닌 최상위는 «읽을 수 없음» 으로 접는다.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) root = parsed as Record<string, unknown>;
    } catch { /* 깨졌다 — 아래에서 새로 만든다 */ }
  }

  const projectsRaw = root.projects;
  const projects: Record<string, unknown> =
    projectsRaw && typeof projectsRaw === "object" && !Array.isArray(projectsRaw)
      ? { ...(projectsRaw as Record<string, unknown>) }
      : {};

  const entryRaw = projects[target];
  const entry: Record<string, unknown> =
    entryRaw && typeof entryRaw === "object" && !Array.isArray(entryRaw)
      ? { ...(entryRaw as Record<string, unknown>) }
      : {};

  if (entry[TRUST_KEY] === true) return { write: false };   // 이미 신뢰됨 — 쓰지 않는다

  entry[TRUST_KEY] = true;
  projects[target] = entry;
  return { write: true, text: `${JSON.stringify({ ...root, projects }, null, 2)}\n` };
}

/** 파일 접근 seam — 비격리는 직접 fs, 격리·중계(매니지드)는 멤버 uid 로 도는 구현을 넘긴다. */
export interface TrustIo {
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
}

/**
 * 세션이 실제로 쓸 설정 파일에 신뢰를 심는다. **비치명** — 던지지 않는다(호출자가 세션을 막으면 안 된다).
 * @returns 실제로 썼으면 true
 */
export async function ensureFolderTrusted(io: TrustIo, configFile: string, dir: string): Promise<boolean> {
  try {
    const patch = planTrustPatch(await io.read(configFile), dir);
    if (!patch.write) return false;
    await io.write(configFile, patch.text);
    return true;
  } catch {
    return false;   // 신뢰를 못 심었다고 세션을 막지 않는다 — 그때는 종전대로 프롬프트가 뜬다
  }
}
