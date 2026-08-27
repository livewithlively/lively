// delivery ▸ welcome — 처음 설정(#/welcome)이 쓰는 서버 문 (#1813).
//
//  왜 서버로 올렸나: 온보딩 화면이 지금까지 **연출만** 했다. 자료 수는 하드코딩 41,
//   갈래 이름은 상수 표, 사람이 고른 답은 localStorage, 끝났다는 표식도 localStorage 였다.
//   그래서 기기를 바꾸면 온보딩이 다시 뜨고, "이대로 나눠 주세요"를 눌러도 워크스페이스엔
//   아무 일도 일어나지 않았다. 여기 셋을 두어 그 세 가지를 전부 실물로 바꾼다.
//
//   ① GET  /api/ui/me/welcome          — 실측 조회(내가 올린 자료·종류별 집계·지금 갈래·끝냈는지)
//   ② POST /api/ui/me/welcome/analyze  — 올린 자료를 **LLM 에게 실제로 보여** 갈래를 제안받는다
//      GET  /api/ui/me/welcome/analyze/:id — 그 판정을 읽는다(끝났으면 파싱된 갈래 목록)
//   ③ POST /api/ui/me/welcome          — 사람이 승인한 것을 **진짜로 반영**(갈래 생성·프로필·완료)
//
//  ⚠ LLM 은 이 제품에서 **사람의 AI 구독으로 헤드리스 세션을 띄우는 것**이 유일한 길이다
//   (박스에 API 키가 없다 — 그게 설계다). 그래서 ②는 리브 턴과 같은 spawnTaskSession 을 쓰고,
//   AI 가 아직 안 붙었으면 **실패를 감추지 않고** 그대로 알린다. 화면은 그때 ①의 결정적 집계로
//   내려앉는다 — 그 숫자도 가짜가 아니라 **그 사람이 방금 올린 파일을 실제로 센 것**이다.

import crypto from "node:crypto";
import { z } from "zod";
import type { Capability } from "../types.js";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { restRead } from "./shared.js";

/** 갈래 후보 상한 — 서랍이 열 개를 넘으면 고르는 일이 일이 된다. */
const MAX_DRAWERS = 10;
/** 집계·목록에 쓰는 자료 표본 상한. */
const SAMPLE_CAP = 200;
/** LLM 에게 **보여 줄** 파일 이름 수·길이 상한.
 *  실측(2026-08-26): 이름 200개(21KB)를 그대로 넣었더니 한 번에 $1.22 가 나갔다. 온보딩 한 번에 그 값은 과하다.
 *  갈래를 정하는 데는 이름 120개면 충분하고, 긴 이름은 앞부분만으로도 무엇인지 드러난다. */
const PROMPT_FILE_CAP = 120;
const PROMPT_NAME_CAP = 80;
const TURN_ID_RE = /^t[0-9a-f]{16}$/;

/**
 * 자료 kind → 사람이 읽는 이름. source.ts 의 SOURCE_KINDS 와 짝이다.
 *  ⚠ 여기에 **없는** kind(= 파일류)는 이름 대신 **확장자**로 가른다 — 아래 tallySources 참조.
 *   `local_file`·`other` 를 여기 넣으면 안 된다: 넣는 순간 올린 파일이 전부 한 서랍이 된다.
 */
const KIND_LABEL: Record<string, string> = {
  transcript: "회의 전사록", minutes: "회의록", email: "메일", slack: "슬랙", discord: "디스코드",
  notion_doc: "노션 문서", clickup_doc: "클릭업 문서", drive_file: "드라이브 파일",
};

/** 갈래 key — 사람이 적은 이름에서 슬러그를 뽑는다. 한글이면 해시로 떨어뜨려도 이름은 그대로 남는다. */
export function drawerKey(name: string): string {
  const ascii = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (ascii) return ascii;
  return `d-${crypto.createHash("sha1").update(name.trim()).digest("hex").slice(0, 10)}`;
}

/**
 * LLM 이 돌려준 말에서 갈래 목록을 꺼낸다. **순수** — 파싱 실패는 예외가 아니라 빈 배열이다
 * (온보딩 한복판에서 500 을 띄우느니 결정적 집계로 내려앉는 편이 낫다).
 *
 * 받아들이는 모양: ```json 펜스 안의 배열/객체, 또는 본문에 그냥 박힌 배열.
 */
export function parseDrawers(text: string): Array<{ name: string; why?: string }> {
  if (!text) return [];
  const blocks: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  for (let m = fence.exec(text); m; m = fence.exec(text)) blocks.push(m[1]!);
  blocks.push(text);   // 펜스가 없으면 본문 자체에서 찾는다
  for (const b of blocks) {
    const start = b.indexOf("[");
    const objStart = b.indexOf("{");
    for (const s of [start, objStart].filter((i) => i >= 0).sort((a, z) => a - z)) {
      const open = b[s]!, close = open === "[" ? "]" : "}";
      const end = b.lastIndexOf(close);
      if (end <= s) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(b.slice(s, end + 1)); } catch { continue; }
      const arr = Array.isArray(parsed) ? parsed
        : (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).drawers))
          ? (parsed as { drawers: unknown[] }).drawers : null;
      if (!arr) continue;
      const out: Array<{ name: string; why?: string }> = [];
      for (const it of arr) {
        const name = typeof it === "string" ? it
          : (it && typeof it === "object" ? String((it as Record<string, unknown>).name ?? "") : "");
        const t = name.trim().slice(0, 60);
        if (!t || out.some((x) => x.name === t)) continue;
        const why = it && typeof it === "object" ? String((it as Record<string, unknown>).why ?? "").trim().slice(0, 200) : "";
        out.push(why ? { name: t, why } : { name: t });
        if (out.length >= MAX_DRAWERS) break;
      }
      if (out.length) return out;
    }
  }
  return [];
}

/** 턴 진행 JSONL 에서 **마지막 assistant 텍스트**만 뽑는다. 하네스 스트림 모양이 조금씩 달라 넓게 받는다. */
export function lastAssistantText(chunk: string): string {
  let out = "";
  for (const line of chunk.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let j: Record<string, unknown>;
    try { j = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
    const msg = (j.message ?? j) as Record<string, unknown>;
    if (j.type && j.type !== "assistant" && msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") { out = content; continue; }
    if (Array.isArray(content)) {
      const text = content.filter((c) => c && typeof c === "object" && (c as Record<string, unknown>).type === "text")
        .map((c) => String((c as Record<string, unknown>).text ?? "")).join("\n").trim();
      if (text) out = text;
    }
  }
  return out;
}

/** 올린 자료를 종류·확장자로 **실제로** 센다(순수). LLM 이 없어도 이 숫자는 진짜다. */
export function tallySources(entries: Array<{ kind?: string | null; title?: string | null }>): Array<{ key: string; name: string; n: number }> {
  const byKind = new Map<string, number>();
  for (const e of entries) {
    const kind = String(e.kind || "other");
    // 이름이 붙은 kind(슬랙·메일 …)는 그대로. **그 밖은 전부 파일류**로 보고 확장자로 한 겹 더 가른다.
    //  ⚠ 실측(2026-08-26): 온보딩 업로드는 `local_file` 로 들어온다. 'other' 만 갈랐더니
    //   올린 파일이 통째로 '그 밖의 자료' 한 서랍에 뭉쳤다 — 그래서 화이트리스트가 아니라 **여집합**으로 판정한다.
    let bucket = KIND_LABEL[kind];
    if (!bucket) {
      const ext = (String(e.title || "").match(/\.([A-Za-z0-9]{1,8})$/)?.[1] || "").toLowerCase();
      bucket = EXT_BUCKET[ext] ?? "그 밖의 자료";
    }
    byKind.set(bucket, (byKind.get(bucket) ?? 0) + 1);
  }
  return [...byKind.entries()]
    .map(([name, n]) => ({ key: drawerKey(name), name, n }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

const EXT_BUCKET: Record<string, string> = {
  doc: "문서", docx: "문서", hwp: "문서", hwpx: "문서", pdf: "문서", txt: "문서", md: "문서", rtf: "문서", odt: "문서",
  xls: "표·수치", xlsx: "표·수치", csv: "표·수치", tsv: "표·수치", numbers: "표·수치",
  ppt: "발표 자료", pptx: "발표 자료", key: "발표 자료",
  png: "이미지", jpg: "이미지", jpeg: "이미지", gif: "이미지", webp: "이미지", svg: "이미지", heic: "이미지",
  zip: "묶음 파일", tar: "묶음 파일", gz: "묶음 파일", "7z": "묶음 파일", rar: "묶음 파일",
  json: "데이터", xml: "데이터", yaml: "데이터", yml: "데이터",
};

/**
 * 올린 파일 이름에서 **같은 꼴이 여러 개**인 묶음을 찾는다(순수).
 *  날짜·번호만 다른 것들(주간회의_2026-08-1주 / -2주 …)이 곧 '주기적으로 만드는 문서'다.
 *  ⚠ 온보딩이 "같은 양식 문서가 여러 달치 있네요" 라고 말하려면 **실제로 본 것**이어야 한다 —
 *   종전엔 그 관찰을 상수 표에서 꺼내 써서, 사람의 파일과 무관한 이름을 대며 단정했다.
 */
export function repeatedForms(names: string[]): Array<{ skel: string; names: string[] }> {
  const groups = new Map<string, { skel: string; names: string[] }>();
  for (const raw of names || []) {
    const base = String(raw).replace(/\.[A-Za-z0-9]{1,8}$/, "");
    // 숫자 자리를 지우고 남는 뼈대가 같으면 같은 꼴이다.
    const skel = base.replace(/\d+/g, "#").replace(/[\s_\-\u2013\u2014.]+/g, " ").trim();
    // 뼈대에 숫자 아닌 글자가 **하나도 없으면** 이름이라 할 것이 없다 —
    //  '1.pdf'·'2.pdf'·'2026-08-01.png' 를 '같은 양식 문서'라고 부르면 그건 지어낸 관찰이다.
    //  ⚠ 두 자 이상을 요구하면 'A 1.md' 같은 한 글자 이름이 통째로 빠진다(테스트 ㉛에서 잡혔다).
    if (skel.replace(/[#\s]/g, "").length < 1) continue;
    const g = groups.get(skel) ?? { skel, names: [] };
    g.names.push(String(raw));
    groups.set(skel, g);
  }
  return [...groups.values()].filter((g) => g.names.length >= 2)
    .sort((a, b) => b.names.length - a.names.length || a.skel.localeCompare(b.skel));
}

/** LLM 에게 줄 지시문. 서버가 만든다 — 화면이 만들면 사람마다 다른 프롬프트가 나간다. */
export function analyzePrompt(files: string[], job: string | null): string {
  return [
    "이 사람이 방금 라이블리에 올린 파일 목록입니다. 이 사람의 **자료함 서랍**을 정해 주세요.",
    job ? `이 사람이 하는 일: ${job}` : "",
    "",
    "규칙",
    `- 서랍은 3~${MAX_DRAWERS}개. 파일 이름에서 **실제로 보이는 것**만 근거로 삼습니다. 없는 종류를 지어내지 마세요.`,
    "- 이름은 한국어 명사구로 짧게(예: 회의록, 월간 보고, 계약·견적).",
    "- 파일 확장자가 아니라 **하는 일**로 가릅니다. pdf·docx 같은 이름은 서랍이 아닙니다.",
    "- 어디에도 안 들어가는 것을 담을 서랍 하나(예: 그 밖의 자료)를 마지막에 둡니다.",
    "",
    "답은 **JSON 배열 하나만** 코드펜스에 담아 주세요. 설명은 펜스 밖에 적으세요.",
    '```json',
    '[{"name":"회의록","why":"주간회의_로 시작하는 파일 12개"}]',
    '```',
    "",
    "파일 목록:",
    ...files.slice(0, PROMPT_FILE_CAP).map((f) => `- ${f.length > PROMPT_NAME_CAP ? f.slice(0, PROMPT_NAME_CAP) + "…" : f}`),
    files.length > PROMPT_FILE_CAP ? `(그 밖에 ${files.length - PROMPT_FILE_CAP}건 더 있습니다)` : "",
  ].filter(Boolean).join("\n");
}

export const welcomeCapabilities: Capability[] = [
  // ── ① 실측 조회 ──────────────────────────────────────────────────────────
  restRead("me_welcome_get", "처음 설정 현황",
    "처음 설정(#/welcome) 화면이 쓰는 실측 — 내가 올린 자료 수와 종류별 집계, 지금 있는 갈래, " +
    "그리고 처음 설정을 끝냈는지. **여기 숫자는 연출이 아니라 조회 결과다.**",
    [{ method: "GET", paths: ["/api/ui/me/welcome"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { getMember, getLivProfile } = await import("../../org/store.js");
      const { listSources, countSources } = await import("../../v6/source-store.js");
      const { listCategories } = await import("../../v6/category-store.js");

      // AI 가 이어져 있나 — **분석을 누르기 전에** 알아야 한다. 안 그러면 사람이 «읽어 주세요» 를 누르고
      //  나서야 거절을 본다.
      //  ⚠ 판정 기준은 **그 사람이 로그인한 하네스**다(setup-token 이 아니다). 매니지드에서 사람은 웹 터미널에서
      //   `claude` 를 한 번 띄워 로그인하고, 그 자격은 자기 프로필(~/.claude/.credentials.json)에 남는다.
      //   헤드리스 실행은 그 프로필로 폴백한다(tasks.ts: "리스가 없으면 노드 로컬 프로필/자격 폴백").
      //   setup-token 리스는 **그 프로필이 없는 자리**(남의 노드 위탁)에서 쓰는 보조 수단이라, 그걸로 판정하면
      //   웹 터미널에서 이미 로그인한 사람을 «AI 안 이었음» 으로 잘못 막는다.
      const { memberLoggedInHarnessesAny } = await import("../../terminal/profiles.js");
      const { HEADLESS_KEYS } = await import("../../node/headless-harness.js");

      const [member, liv, entries, total, cats, loggedIn] = await Promise.all([
        getMember(userId),
        getLivProfile(userId),
        listSources({ limit: SAMPLE_CAP, offset: 0 }, null).catch(() => [] as Array<Record<string, unknown>>),
        countSources({}, null).catch(() => 0),
        listCategories(undefined, null).catch(() => [] as Array<Record<string, unknown>>),
        memberLoggedInHarnessesAny(userId).catch(() => [] as string[]),
      ]);
      // 헤드리스 규약을 아는 하네스로만 센다 — 로그인했어도 헤드리스로 못 돌리면 분석이 안 된다.
      const aiHarnesses = loggedIn.filter((k) => HEADLESS_KEYS.includes(k));
      const rows = (entries as Array<{ kind?: string | null; title?: string | null }>);
      return {
        done: !!(liv.welcome?.done_at || liv.onboarded_at),   // 어느 표식이든 하나면 끝난 것(#2039 와 합류)
        done_at: liv.welcome?.done_at ?? null,
        // 이 사람의 AI 가 이어졌나(분석이 실제로 돌 수 있나) + 무엇으로 도는가. 자격 값은 절대 싣지 않는다.
        ai_ready: aiHarnesses.length > 0,
        ai_harnesses: aiHarnesses,
        profile: {
          display_name: member?.display_name ?? null,
          nickname: member?.nickname ?? null,
          work: liv.work ?? null,
        },
        uploads: {
          total,
          sampled: rows.length,
          kinds: tallySources(rows),
          names: rows.map((r) => String(r.title ?? "")).filter(Boolean).slice(0, SAMPLE_CAP),
          // '주기적으로 만드는 문서' 를 말할 근거 — 실제 파일 이름에서 본 것만 담는다.
          forms: repeatedForms(rows.map((r) => String(r.title ?? "")).filter(Boolean)).slice(0, 5),
        },
        categories: (cats as Array<{ key?: string; name?: string; space?: string }>)
          .map((c) => ({ key: String(c.key ?? ""), name: String(c.name ?? ""), space: String(c.space ?? "") })),
      };
    }),

  // ── ② LLM 분석 ───────────────────────────────────────────────────────────
  restRead("me_welcome_analyze", "올린 자료를 AI 가 본다",
    "방금 올린 자료의 **파일 목록을 실제로 AI 에게 보여** 자료함 서랍을 제안받는다. 리브 턴과 같은 길로 " +
    "헤드리스 세션이 돌고, 진행은 me_welcome_analyze_read 로 읽는다. " +
    "⚠ 이 제품의 LLM 은 **그 사람 본인 AI 구독**으로 돈다 — 아직 AI 를 안 이었으면 여기서 실패한다(감추지 않는다).",
    [{ method: "POST", paths: ["/api/ui/me/welcome/analyze"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { listSources } = await import("../../v6/source-store.js");
      const rows = await listSources({ limit: SAMPLE_CAP, offset: 0 }, null).catch(() => [] as Array<Record<string, unknown>>);
      const files = (rows as Array<{ title?: string | null }>).map((r) => String(r.title ?? "")).filter(Boolean);
      if (!files.length) throw new HttpError(400, "아직 올라온 자료가 없습니다 — 파일을 먼저 올려 주세요");

      const job = input.job == null ? null : String(input.job).trim().slice(0, 200) || null;
      const turnId = `t${crypto.randomBytes(8).toString("hex")}`;
      const { spawnTaskSession } = await import("../../node/tasks.js");
      const { livTurnArgs } = await import("../../org/delivery/liv-turn.js");

      // ── 어느 AI 로 도나 ── 이 사람이 **실제로 로그인한** 하네스로 돈다. 크론·위탁과 같은 함수를 쓴다.
      //  ⚠ `harness: "claude"` 로 박으면 안 된다: codex 로만 로그인한 사람의 잡이 전부 자격 없는 `claude -p`
      //   로 떠서 무출력 hang → stall 종결이 된 사고가 이미 있다(#1884 가 고친 그 자리).
      const { memberLoggedInHarnessesAny } = await import("../../terminal/profiles.js");
      const { HEADLESS_KEYS } = await import("../../node/headless-harness.js");
      const { resolveHeadlessHarness } = await import("../../node/headless-harness.js");
      const loggedIn = (await memberLoggedInHarnessesAny(userId).catch(() => [] as string[]))
        .filter((k) => HEADLESS_KEYS.includes(k));

      // ── 자격 리스(보조) ── 프로필 로그인이 주 경로이고, 이건 그게 없는 자리를 위한 것이다.
      //  위탁과 **같은 함수**를 쓴다(leaseEnvFor): owner 키(`member:<id>`)·active 검사·fail-closed 가 그 안에 있고,
      //  손으로 다시 짜면 그중 하나를 빠뜨려도 아무 오류가 안 난다 — 리스가 조용히 안 붙을 뿐이다(#1289).
      const { leaseEnvFor } = await import("../../node/task-scheduler.js");
      const env = await leaseEnvFor({ requester: userId, harness: "claude" }).catch(() => undefined);

      // ⚠ 자격이 **아무 것도** 없으면 미리 막는다. 격리 컨테이너엔 공유 ~/.claude 폴백이 없어(#1014) 자격 없이
      //  띄우면 fast-fail 이 아니라 **hang** 한다 — 사람은 도는 줄 알고 기다리다 5분 뒤 무출력 사망을 본다(#1101).
      //  단 조건은 '로그인도 없고 리스도 없을 때' 다: 웹 터미널에서 이미 로그인한 사람을 막으면 안 된다.
      if (!loggedIn.length && !env) {
        throw new HttpError(402, "AI 를 아직 잇지 않으셨어요 — 분석은 본인 AI 구독으로 돕니다. 터미널에서 한 번 로그인해 주세요");
      }
      const harness = loggedIn.length ? await resolveHeadlessHarness(userId).catch(() => "claude") : "claude";

      try {
        await spawnTaskSession({
          user, taskId: turnId, rootKey: "personal", subpath: "liv",
          prompt: analyzePrompt(files, job), harness,
          // 온보딩 분석은 **한 번 묻고 끝**이다 — 이어가는 대화가 아니라 새 세션으로 띄운다.
          //  ⚠ livTurnArgs 는 claude 플래그다(--disallowedTools·--include-partial-messages·--session-id).
          //   다른 하네스에 실으면 인자가 안 먹거나 기동이 깨진다 — 실측하지 않은 플래그를 추측해 넣지 않는다.
          extraFlags: harness === "claude" ? livTurnArgs({ sessionId: crypto.randomUUID(), resume: false }) : [],
          bypassPermissions: false,   // ⚠ 리브와 같은 안전선. 승인 우회는 여기서도 쓰지 않는다.
          env,
        });
      } catch (e) {
        throw new HttpError(503, `AI 분석을 시작하지 못했습니다 — ${(e as Error).message}`);
      }
      return { turn_id: turnId, files: files.length, harness };
    }, false, {
      job: z.string().optional().describe("이 사람이 하는 일(있으면 갈래 제안이 그 일에 맞춰진다)"),
    }),

  restRead("me_welcome_analyze_read", "AI 판정 읽기",
    "분석 턴의 진행을 읽는다. 끝났으면 파싱된 갈래 목록(drawers)을 함께 준다. " +
    "AI 가 형식을 안 지켰거나 실패했으면 drawers 는 비고, 화면은 조회로 센 집계로 내려앉는다.",
    [{ method: "GET", paths: ["/api/ui/me/welcome/analyze/:id"], parse: (req) => ({
      id: String(req.params?.id ?? ""), from: req.query?.from ? Number(req.query.from) : 0,
    }) }],
    async (input: { id: string; from: number }, user: LivelyUser) => {
      if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
      if (!TURN_ID_RE.test(input.id)) throw new HttpError(400, "턴 id 형식이 아닙니다");
      const path = await import("node:path");
      const { resolveRootPath, ensureMemberOsUser } = await import("../../terminal/profiles.js");
      const osUser = await ensureMemberOsUser(user).catch(() => null);
      const { abs } = await resolveRootPath(user, "personal", "liv", osUser ?? null);
      const dir = path.join(abs, ".lively-task", input.id);
      const { tailTask } = await import("../../node/tasks.js");
      const from = Number.isFinite(input.from) && input.from >= 0 ? Math.floor(input.from) : 0;
      const t = await tailTask(dir, from) as { chunk?: string; done?: boolean; exit?: number | null; next?: number };
      // ⚠ 판정은 **스트림 전체**에서 읽는다. 화면은 진행을 이어 읽느라 from 을 앞으로 밀어서,
      //  끝났을 때의 조각에는 정작 답이 안 들어 있다(실측 2026-08-26: AI 는 제대로 답했는데
      //  화면은 "판정을 읽지 못했다"로 떨어졌다 — 우리 읽기 쪽 결함이었다).
      //  done 일 때 한 번 더 처음부터 읽는 비용은 턴 하나 분량이라 무시할 만하다.
      if (!t.done) return { ...t, drawers: [] };
      const full = from > 0
        ? await tailTask(dir, 0) as { chunk?: string }
        : t;
      return { ...t, drawers: parseDrawers(lastAssistantText(String(full.chunk ?? ""))) };
    }, false, {
      id: z.string().describe("me_welcome_analyze 가 준 턴 id"),
      from: z.number().optional().describe("이어 읽기 시작할 바이트 오프셋(기본 0)"),
    }),

  // ── ③ 반영 ───────────────────────────────────────────────────────────────
  restRead("me_welcome_apply", "처음 설정 결과 반영",
    "처음 설정에서 사람이 정한 것을 **실제로 반영한다** — 부를 이름, 자료함 갈래 생성, 업무 방식과 결정 기록, " +
    "그리고 처음 설정 완료 표식. 갈래 생성은 이미 있는 key 를 건너뛰므로 다시 눌러도 안전하다.",
    [{ method: "POST", paths: ["/api/ui/me/welcome"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { getMember, upsertMember, appendLivProfile } = await import("../../org/store.js");
      const { assertNoHardSecrets } = await import("../../org/ingest/redact.js");
      const { listCategories, createCategory } = await import("../../v6/category-store.js");

      const s = (v: unknown, max: number): string | null => {
        if (v == null) return null;
        const t = String(v).trim().slice(0, max);
        if (!t) return null;
        assertNoHardSecrets(t, "welcome");   // 온보딩 답도 멤버 레코드에 남는다 — 평문 시크릿 차단
        return t;
      };

      // ── 부를 이름 ──
      const nickname = s(input.name, 80);
      const member = await getMember(userId);
      if (nickname && member) {
        // ⚠ **display_name 도 함께** 넣는다. 화면이 사람 이름을 읽는 자리는 전부 display_name 이고
        //  (rail.ts·side.ts·views.ts 모두 `display_name || email || userId`), nickname 은 활동 로그·알림에서만 쓰인다.
        //  nickname 만 넣으면 「어떻게 불러 드릴까요」에 답해도 사이드바엔 이메일 앞부분이 계속 뜬다(#1813).
        // ⚠ **display_name 만** 넣는다. 「어떻게 불러 드릴까요」의 답은 곧 표시이름이다.
        //  닉네임은 [내 설정 ▸ 프로필]에서 따로 정하고, 「이 닉네임을 내 이름으로 사용」을 켠 사람만 그것으로 불린다
        //  (personName 단일 판정). 여기서 nickname 까지 덮으면 그 사람이 정해 둔 닉네임이 날아간다.
        await upsertMember({ id: userId, display_name: nickname }, { actor: userId, source: "welcome" } as never)
          .catch(() => { /* 이름은 못 바꿔도 온보딩을 막지 않는다 */ });
      }

      // ── 자료함 갈래 ── 사람이 승인한 것만 만든다. 이미 있으면 건너뛴다(다시 눌러도 안전).
      const wanted = Array.isArray(input.drawers) ? input.drawers.slice(0, MAX_DRAWERS) : [];
      const existing = new Set((await listCategories(undefined, null).catch(() => [] as Array<{ key?: string }>)).map((c) => String(c.key ?? "")));
      const created: string[] = [];
      const skipped: string[] = [];
      for (const d of wanted) {
        const name = s(typeof d === "string" ? d : (d as Record<string, unknown>)?.name, 60);
        if (!name) continue;
        const key = drawerKey(name);
        if (existing.has(key)) { skipped.push(name); continue; }
        try {
          await createCategory({
            space: "business", key, name,
            should: s((d as Record<string, unknown>)?.why, 400) ?? `처음 설정에서 만든 갈래입니다. ${name} 에 해당하는 자료가 여기로 모입니다.`,
          } as never, { actor: userId, source: "welcome" } as never);
          created.push(name); existing.add(key);
        } catch { skipped.push(name); }   // 권한이 없거나 경합 — 온보딩을 멈추지 않는다
      }

      // ── 업무 방식과 결정 ── 리브의 기억이 사는 자리에 남긴다(다음 세션의 리브가 이걸 읽는다).
      const job = s(input.job, 200);
      const stage = s(input.stage, 40);
      const nowline = s(input.nowline, 300);
      const firstOrder = s(input.first_order, 400);
      const asis = [stage ? STAGE_LABEL[stage] ?? stage : null, job].filter(Boolean).join(" · ") || null;
      if (asis || nowline) {
        await appendLivProfile(userId, {
          work: { asis: asis ?? undefined, tobe: nowline ? `시간을 가장 많이 쓰는 일: ${nowline}` : undefined, by: "self" },
        }).catch(() => { /* 비치명 */ });
      }
      const decisions: Array<{ what: string; why?: string }> = [];
      if (created.length) decisions.push({ what: `자료함 갈래 ${created.length}개 생성`, why: created.join(" · ") });
      const cadence = s(input.cadence, 20);
      if (cadence && cadence !== "no") decisions.push({ what: cadence === "month" ? "매달 반복하는 문서가 있다" : "매주 반복하는 문서가 있다" });
      const share = s(input.share, 20);
      if (share) decisions.push({ what: `자료를 보는 범위: ${SHARE_LABEL[share] ?? share}` });
      if (firstOrder) decisions.push({ what: "첫 지시", why: firstOrder });
      for (const d of decisions) {
        await appendLivProfile(userId, { decision: { at: new Date().toISOString(), what: d.what, why: d.why, by: "self" } })
          .catch(() => { /* 비치명 */ });
      }

      // ── 완료 표식 ── 서버가 안다. 기기를 바꿔도 온보딩이 다시 뜨지 않는다.
      //  main(#2039)은 같은 사실을 `onboarded_at` 으로 보고 부팅 판정(me.first_run)을 한다 — 두 표식을 **한 번에** 찍는다.
      //   welcome 만 찍으면 다음 부팅에 first_run 이 여전히 true 라 처음 설정이 또 뜬다.
      const profile = await appendLivProfile(userId, {
        welcome: { done_at: new Date().toISOString(), drawers: created, first_order: firstOrder },
        onboarded: true,
      });
      return { ok: true, created, skipped, welcome: profile.welcome ?? null };
    }, false, {
      name: z.string().optional().describe("이렇게 불러 주세요(닉네임)"),
      stage: z.string().optional().describe("company|solo|academy|student"),
      job: z.string().optional().describe("맡은 일"),
      drawers: z.array(z.union([z.string(), z.object({ name: z.string(), why: z.string().optional() })])).optional()
        .describe("승인한 자료함 갈래 — 실제 카테고리로 만든다"),
      cadence: z.string().optional().describe("month|week|no — 정기 문서 주기"),
      share: z.string().optional().describe("me|team|dept|ext — 자료를 보는 범위"),
      nowline: z.string().optional().describe("시간을 가장 많이 쓰는 일"),
      first_order: z.string().optional().describe("첫 지시로 고른 문장"),
    }),
];

const STAGE_LABEL: Record<string, string> = {
  company: "회사·조직에서 팀과 함께 일한다", solo: "1인·프리랜서로 여러 일을 한다",
  academy: "학교·연구실에서 연구한다", student: "학생으로 수업·시험·진로를 준비한다",
};
const SHARE_LABEL: Record<string, string> = {
  me: "나만 본다", team: "우리 팀이 같이 본다", dept: "여러 부서와 나눈다", ext: "고객·외부에 낸다",
};
