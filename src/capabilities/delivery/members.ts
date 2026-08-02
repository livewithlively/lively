// delivery ▸ members — 구성원 명부 조회/추가·수정/제거·비밀번호 재설정.
import type { Capability } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import { SCOPES_ALLOWED } from "../scopes.js";
import type { LivelyUser } from "../../context.js";
import { MEANING } from "../../org/delivery/meaning.js";
import { assertNoHardSecrets } from "../../org/ingest/redact.js";
import { listMembers, getMember, memberIdByEmail, upsertMember, removeMember, memberHasActiveToken, type MemberIdentity } from "../../org/store.js";
import { unbindMemberIdentities } from "../../org/store/members.js";
import { itemsPool } from "../../db/client.js";
import { generateInitialPassword, setMemberPassword, hasCredential, membersWithCredentials } from "../../auth/local-accounts.js";
// #697 매핑 소급 — 관리탭 멤버 매핑(person_identity) 변경을 이미 미러된 데이터에 즉시 재해소.
import { reresolveMirrorMembers } from "../../v6/connector-mirror.js";
import { logger } from "../../log.js";
import { actorOf, assertEmail, restOnly, restRead, slug, str } from "./shared.js";

function parseIdentities(raw: unknown): MemberIdentity[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "identities 는 배열이어야 합니다");
  return raw.map((e, i) => {
    const o = (e ?? {}) as Record<string, unknown>;
    if (typeof o.system !== "string" || !o.system.trim()) throw new HttpError(400, `identities[${i}].system 필수`);
    if (typeof o.external_id !== "string" || !o.external_id.trim()) throw new HttpError(400, `identities[${i}].external_id 필수`);
    const idn: MemberIdentity = { system: o.system.trim(), external_id: o.external_id.trim() };
    if (typeof o.email === "string" && o.email.trim()) idn.email = o.email.trim();
    if (typeof o.instance === "string" && o.instance.trim()) idn.instance = o.instance.trim();
    if (typeof o.display_name === "string" && o.display_name.trim()) idn.display_name = o.display_name.trim();
    return idn;
  });
}

// 멤버 아이디 = **불변 내부키**(auth_token·web_session·member_credential·project_member·activity·person·터미널세션·감사가
//  전부 참조). 이메일은 가변(변경 시 전 참조 깨짐)·agent/system 은 null → 내부키로 부적합. 그래서 별도 surrogate.
//  단 관리자가 직접 만들 필요는 없으므로 신규는 이메일 로컬파트(없으면 표시이름)에서 자동·유니크 생성한다.
const slugifyId = (s: string): string =>
  (s || "").toLowerCase().replace(/[^a-z0-9가-힣_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "member";
async function uniqueMemberId(base: string): Promise<string> {
  const b = slugifyId(base);
  if (!(await getMember(b))) return b;
  for (let i = 2; i < 1000; i++) { const c = `${b}-${i}`; if (!(await getMember(c))) return c; } // 충돌 시 -2,-3…
  return `${b}-${Math.floor(performance.now())}`;
}

// 구성원 명부 — 비-admin 은 이름/종류/상태만(이메일·신원·개인레이어 redact), admin 은 접속 열쇠·중앙박스 계정 보유 여부까지.
export async function membersPayload(isAdmin: boolean) {
  const members = await listMembers();
  if (!isAdmin) {
    return members.map((m) => ({ id: m.id, kind: m.kind, display_name: m.display_name, email: null, identities: [], body_md: "", state: m.state, scopes: [] }));
  }
  const credSet = await membersWithCredentials();
  return Promise.all(members.map(async (m) => ({ ...m, hasToken: await memberHasActiveToken(m.id), hasAccount: credSet.has(m.id) })));
}

export const membersReadCapabilities: Capability[] = [
  restRead("org_members", "구성원 명부 조회",
    "관리탭 [구성원·팀] — 구성원 목록. admin 은 이메일·외부시스템 신원·scopes·개인 레이어 + hasToken(접속 열쇠 보유)·hasAccount(중앙박스 계정 보유)까지, " +
    "비-admin 은 이름·종류(human|agent|system)·상태만(민감 필드 redact). 팀 소속은 team_list/team_get. 수정은 org_member_upsert.",
    [{ method: "GET", paths: ["/api/ui/org/members"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const isAdmin = !!(user?.scopes && user.scopes.includes("admin"));
      return { members: await membersPayload(isAdmin), canEdit: isAdmin, meaning: MEANING["member"] };
    }, true),
];

export const membersCapabilities: Capability[] = [
  // ── 구성원 upsert/remove ──
  restOnly("org_member_upsert", "구성원 추가·수정",
    "구성원 신원(표시명·이메일·외부계정 연결·개인레이어)을 저장한다. person/person_identity 로도 동기화.",
    [{ method: "POST", paths: ["/api/ui/org/member"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const kind = input.kind == null ? undefined : str(input.kind, "kind", 10) as "human" | "agent" | "system";
      if (kind && !["human", "agent", "system"].includes(kind)) throw new HttpError(400, "kind 는 human|agent|system");
      const displayName = input.display_name == null ? undefined : str(input.display_name, "display_name", 200).trim();
      // 닉네임(#762): 미전송=보존, 빈 문자열=지움(→ display_name 폴백). 정규화는 upsertMember 담당. 개인 프로필(self) 저장과 동일 처리 — 관리자도 편집 가능하게(#1025).
      const nickname = input.nickname == null ? undefined : str(input.nickname, "nickname", 80).trim();
      // 이메일 = 로그인 아이디 → 형식 검증(생성·로그인 일관). 빈 값은 허용(로그인 불요 멤버 — 계정 미발급).
      const email = input.email == null ? undefined : str(input.email, "email", 200).trim();
      if (email) assertEmail(email);
      // 아이디: 명시되면 그대로(편집·고급), 없으면 신규 생성 → 이메일/표시이름에서 자동·유니크(관리자 비관여, 불변 내부키).
      const hasExplicitId = input.id !== undefined && String(input.id).trim() !== "";
      const id = hasExplicitId ? slug(input.id, "id") : await uniqueMemberId(email ? email.split("@")[0] : (displayName || "member"));
      const existed = hasExplicitId ? await getMember(id) : null; // 자동 id 는 항상 신규
      // 이메일 = 로그인 키 → 유일해야 한다(다른 멤버가 같은 이메일이면 거부, 대소문자 무시). 본인(편집)은 허용.
      if (email) {
        const taken = await memberIdByEmail(email);
        if (taken && taken !== id) throw new HttpError(400, "이미 사용 중인 이메일입니다 — 다른 이메일을 쓰세요");
      }
      let scopes: string[] | undefined;
      if (input.scopes !== undefined) {
        if (!Array.isArray(input.scopes)) throw new HttpError(400, "scopes 는 배열이어야 합니다");
        scopes = input.scopes.map((s) => str(s, "scopes[]", 20));
        for (const s of scopes) if (!SCOPES_ALLOWED.has(s)) throw new HttpError(400, `허용되지 않은 scope: ${s}`);
      }
      // 개인레이어 본문(body_md)은 합성 컨텍스트에 실리는 자유텍스트 — 평문 시크릿 hard-block(ctx_save 와 동일 choke-point).
      const memberBody = input.body_md == null ? undefined : str(input.body_md, "body_md", 20000);
      if (memberBody !== undefined) assertNoHardSecrets(memberBody, "body_md"); // P8
      const member = await upsertMember({
        id, kind,
        display_name: displayName,
        nickname,
        email,
        identities: input.identities === undefined ? undefined : parseIdentities(input.identities),
        body_md: memberBody,
        state: input.state === undefined ? undefined : (str(input.state, "state", 10) as "active" | "inactive"),
        scopes,
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
      }, actorOf(user), "web");
      // 신원 '해제' 동기(#541) — identities 에서 뺀 행은 person_identity 에서도 지워야 커넥터 액터/어사이니
      //  해소(person_identity JOIN org_member)에 실제 반영된다. 삭제 가드(소유·origin)와 해제 감사는 store 소관.
      if (existed && input.identities !== undefined) {
        await unbindMemberIdentities(id, existed.identities, member.identities, actorOf(user));
      }
      // #697 매핑 소급 — clickup 신원 매핑(person_identity)이 **실제로 바뀌었을 때만**, 이미 미러된 데이터(어사이니/
      //  작성자/멤버)의 raw 값을 방금 갱신된 매핑으로 재해소한다(관리탭 매핑을 과거 미러에 즉시 반영 — 증분 싱크가
      //  미변경 태스크를 재수집 안 해 생기던 소급 누락 수정). 가드가 '변경 시에만'이라 display_name/scopes 만 바꾼
      //  저장에는 안 돈다(full sweep 비용 회피). 재해소는 raw→member_id 단방향이라 해제 시 기존 치환을 되돌리진
      //  않는다(다음 미러가 raw 재도입, 다음 싱크가 수렴). best-effort — 실패해도 매핑 저장은 성립(healPmMirror 가
      //  동일 함수로 수렴). PM 미러 대상 = 현재 clickup 만.
      const cuKey = (idns: MemberIdentity[]): string =>
        idns.filter((i) => i.system === "clickup").map((i) => `${i.external_id}|${i.email ?? ""}`).sort().join(",");
      if (input.identities !== undefined && cuKey(member.identities) !== cuKey(existed?.identities ?? [])) {
        const rc = await itemsPool.connect();
        try {
          const rr = await reresolveMirrorMembers(rc, "clickup");
          if (rr.assignee || rr.surfaces) logger.info({ member: id, ...rr }, "#697 매핑 소급 재해소");
        } catch (e) {
          logger.warn({ err: (e as Error)?.message ?? String(e) }, "#697 재해소 실패(무시 — 다음 싱크 수렴)");
        } finally { rc.release(); }
      }
      // 신규 human 멤버 → 로컬 로그인 계정 자동 발급(초기 비번 1회 반환 — 관리자가 멤버에게 전달).
      //  로그인이 이메일 기준이라 **유효 이메일이 있을 때만** 발급(없으면 못 쓰는 계정 → 발급 안 함).
      //  agent/system·기존 멤버·이미 계정 있음도 제외.
      let initialPassword: string | undefined;
      if (!existed && member.kind === "human" && member.email && !(await hasCredential(id))) {
        initialPassword = generateInitialPassword();
        await setMemberPassword(id, initialPassword, { mustChange: true, actor: actorOf(user) });
      }
      return { member, initialPassword };
    }, {
      id: z.string().optional().describe("멤버 id(불변 내부키) — 생략 시 이메일 로컬파트에서 자동 생성"),
      kind: z.enum(["human", "agent", "system"]).optional().describe("멤버 종류(기본 human)"),
      display_name: z.string().optional().describe("표시 이름"),
      nickname: z.string().optional().describe("닉네임(활동 로그 등 캐주얼 표기 · 비우면 표시 이름 폴백)"),
      email: z.string().optional().describe("이메일=로그인 아이디. 신규 human 이면 초기 비번 자동 발급(initialPassword 1회 반환)"),
      identities: z.array(z.object({ system: z.string(), external_id: z.string(), email: z.string().optional(), instance: z.string().optional(), display_name: z.string().optional() })).optional().describe("외부 계정 연결(slack/clickup 등)"),
      body_md: z.string().optional().describe("개인 레이어(세션 컨텍스트에 실림)"),
      state: z.enum(["active", "inactive"]).optional(),
      scopes: z.array(z.string()).optional().describe("권한 scope: items|context|memory|db|code|admin|runtime"),
      sort: z.number().optional(),
    }),
  // ── 구성원 비밀번호 재설정 — 임시 비번 1회 반환(관리자가 멤버에게 전달). 첫 로그인 후 변경 권장(must_change). ──
  restOnly("org_member_reset_password", "구성원 비밀번호 재설정",
    "구성원의 로컬 로그인 비밀번호를 임시 비번으로 재설정한다(1회 반환). 멤버는 이 비번으로 로그인 후 변경한다.",
    [{ method: "POST", paths: ["/api/ui/org/member/reset-password"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = slug(input.id, "id");
      const m = await getMember(id);
      if (!m) throw new HttpError(404, "구성원을 찾을 수 없습니다");
      if (m.kind !== "human") throw new HttpError(400, "사람(human) 구성원만 로그인 계정을 가질 수 있습니다");
      if (!m.email) throw new HttpError(400, "이메일이 없어 로그인 계정을 만들 수 없습니다 — 먼저 구성원에 이메일을 설정하세요");
      const password = generateInitialPassword();
      await setMemberPassword(id, password, { mustChange: true, actor: actorOf(user) });
      return { id, password };
    }, {
      id: z.string().describe("구성원 id(불변 내부키) — human 이고 이메일이 있어야 로그인 계정이 성립"),
    }),
  restOnly("org_member_remove", "구성원 제거",
    "org_member 에서 구성원을 제거한다(person 행은 참조무결성 위해 보존).",
    [{ method: "POST", paths: ["/api/ui/org/member/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      await removeMember(slug(input.id, "id"), actorOf(user), "web");
      return { ok: true };
    }, {
      id: z.string().describe("제거할 구성원 id(불변 내부키) — person 행은 참조무결성 위해 보존된다"),
    }),

  // (레거시 org_memory 쓰기 엔드포인트 org_memory_upsert/org_memory_remove 는 #536 에서 제거 —
  //  knowledge_* 로 대체된 죽은 표면. 읽기(listMemory→org_overview/org_sections)도 #1256 에서 제거 —
  //  소비자가 없는데 응답의 79~100%(4.3MB)를 차지했고 #1247 과 같은 LIMIT-후-필터였다. store.upsertMemory 만 유지
//  (그 소비자였던 일회성 migrate 는 scripts/archive/org-migrate.ts 로 보관 — #1313 R5).)
];
