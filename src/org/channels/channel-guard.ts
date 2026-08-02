// 대화 채널별 개인 열람/발송 정책 집행(#1226 · 기본값 재설계 #1262) — 순수 로직(DB·네트워크 없음, 단위테스트 대상).
//
// 왜 게이트웨이가 거르나:
//  슬랙 OAuth 에는 **채널 단위 권한이 없다.** 워크스페이스에 한 번 동의하면 그 사람이 볼 수 있는 대화
//  전체(공개·비공개·그룹DM·DM)가 통째로 열린다 — "이 채널만 빼고" 를 슬랙에 요구할 방법이 없다.
//  그래서 채널 단위 통제는 **우리 프록시가 상류 호출을 가로채는 자리**에서만 가능하다. 2중 방벽:
//
//   ① 인자 게이트(checkChannelCall) — 호출이 지목한 대화가 허용되지 않으면 상류로 보내지 않는다.
//   ② 응답 필터(filterChannelContent) — 대화를 안 고르는 툴(전역 검색)의 결과에서 허용되지 않은 항목을 지운다.
//
// ── #1262 전환: '전부 허용 + 끈 것만 저장'(deny-list) → '종류별 기본값 + 다른 것만 저장'(override) ──
//  #1226 은 기본이 전부 허용이라, **슬랙을 연결한 순간 비공개 채널·DM 이 통째로 AI 에게 열렸다**
//  (실측으로 확인: 사람이 아무것도 안 건드린 상태에서 비공개 채널 대화가 검색 결과에 그대로 나왔다).
//  사람이 손대기 전의 상태는 '닫힘' 이어야 한다 → 기본값을 대화 종류의 함수로 바꾼다:
//    · 공개 채널        → 열람·발송 허용
//    · 비공개·그룹DM·DM → 열람·발송 거부  (사람이 관리탭에서 켜야 열린다)
//  그래서 '행이 없다 = 허용' 이 아니라 '행이 없다 = 그 종류의 기본값' 이고, 새로 생긴 대화도 자동으로 이 규칙을 탄다.
//
// ⚠⚠ 이 전환의 가장 위험한 함정 — **deny 판정과 allow 판정은 오탐의 방향이 반대다.**
//  #1226 처럼 '비허용 목록에 걸리면 막는' 판정에서는 채널 참조를 **넓게** 잡을수록 안전했다(더 많이 막으니까).
//  그런데 '허용이 확인된 것만 통과' 로 뒤집으면 넓게 잡는 것이 곧 **오차단**이 된다 — 발송 본문에 우연히
//  `CI1234567` 같은 토큰이 섞이면 그게 '모르는 대화' 로 읽혀 멀쩡한 공개채널 발송이 막힌다.
//  그래서 참조 추출을 두 축으로 나눈다:
//   · extractChannelRefs(넓게)    — 맨 id 까지 전부. **비허용 대화가 섞였는지** 볼 때만 쓴다(언급만으로도 새면 안 되므로).
//   · extractChannelTargets(좁게) — 힌트 키 아래의 값 · <#C…> · permalink · #이름. **이 호출/항목이 지목한 대화**다.
//  허용 판정은 반드시 좁은 쪽으로 한다. 지목과 언급은 다르다.

// 슬랙 대화 id — C(공개)·G(구 비공개)·D(DM). permalink(/archives/C0XXXX/p17…)·<#C0XXXX|name> 안에서도 잡히게 경계 매칭.
//  ⚠ **prefix 로 공개/비공개를 가릴 수는 없다** — 비공개 채널도 C 로 시작한다(실측: private=C0BL393EKCP,
//   public=C0BLJKT7534). 공개↔비공개 전환 시 id 가 유지되기 때문이고, 슬랙 공식 문서도 첫 글자 휴리스틱
//   대신 is_private 를 보라고 못박는다. 종류는 member_channel_meta 가 해소해서 이 파일에 넘겨준다.
const ID_RE = /\b([CGD][A-Z0-9]{6,20})\b/g;
// #채널명 참조 — 슬랙 채널명은 소문자·숫자·하이픈·언더스코어 + 유니코드(한글) 허용.
const HASH_RE = /#([a-z0-9À-￿._-]{1,80})/gi;
// 명시적 대화 표기 — 이것들은 '언급' 이 아니라 '지목' 이다(슬랙이 채널을 가리키려고 쓰는 문법).
const LINK_RE = /<#([CGD][A-Z0-9]{6,20})(?:\|[^>]*)?>/g;      // <#C0XXXX|name>
const ARCHIVE_RE = /\/archives\/([CGD][A-Z0-9]{6,20})\b/g;    // permalink
// 인자 키가 '채널을 지목한다'는 힌트 — 이 키 아래의 문자열은 # 없이도 채널명으로 읽는다.
const CHANNEL_KEY_RE = /^(channel|channel_id|channelid|channel_ids|channels|channel_name|channel_names|conversation|conversation_id|conversations|conversation_ids)$/i;
const MAX_DEPTH = 8;

/** 대화 종류 — 기본 허용 여부를 가르는 축. 'unknown' 은 '아직 못 알아냈다'(→ 안전측으로 비공개 취급). */
export type ChannelType = "public" | "private" | "group_dm" | "dm" | "unknown";

// 대화 종류별 기본값(#1262) — **공개 채널만 열려 있다.**
//  비공개·그룹DM·DM 은 사람이 명시적으로 켜기 전까지 열람·발송 모두 거부한다. unknown 도 같다:
//  종류를 못 알아낸 대화를 '일단 보여준다' 고 하면, 캐시가 비었을 때 이 기능 전체가 무력해진다(fail-closed).
export function channelDefaults(type: ChannelType): { read: boolean; write: boolean } {
  return type === "public" ? { read: true, write: true } : { read: false, write: false };
}

export interface ChannelPolicyRowLike {
  channel_id: string;
  channel_name?: string | null;
  /** DM 일 때 상대의 slack user_id(U…) — 슬랙이 DM 을 user_id 로도 열기 때문에 함께 대조해야 한다. */
  peer_id?: string | null;
  allow_read: boolean;
  allow_write: boolean;
  /** #1226 시절(기본 전부 허용)에 저장된 행인가 — true 의 뜻이 다르다. overrideOf 참조. */
  legacy?: boolean;
}

/** 한 행이 실제로 '명시한' 것 — 미지정(undefined)은 그 종류의 기본값을 따른다. */
export interface ChannelOverride { read?: boolean; write?: boolean }

// 행 → 명시 설정. **구 모델 행(legacy)은 false 만 뜻이 있다.**
//  #1226 은 기본이 전부 허용이라, 그 화면에서 '발송만 끄기' 를 하면 열람 칸은 손대지 않아도 true 로 저장됐다.
//  즉 그 시절 true 는 '허용을 선택함' 이 아니라 **'기본값을 안 건드림'** 이다. #1262 로 비공개 기본값이
//  '거부' 가 된 뒤 그 true 를 명시 허용으로 읽으면, 사람이 결정한 적 없는 비공개 열람이 열린다 —
//  재설계를 라이브에 올린 직후 실측으로 확인했다(`#lively-비공개` 가 그대로 읽혔다. 유닛은 못 잡았다).
//  사람이 새 화면에서 한 번 저장하면 legacy 가 벗겨져 true 도 '명시 허용' 으로 제대로 산다.
export function overrideOf(r: ChannelPolicyRowLike): ChannelOverride {
  if (!r.legacy) return { read: r.allow_read, write: r.allow_write };
  return { read: r.allow_read ? undefined : false, write: r.allow_write ? undefined : false };
}

/** 대화 종류 캐시 한 줄(member_channel_meta) — 기본값을 가르는 데 쓴다. */
export interface ChannelMetaLike {
  channel_id: string;
  channel_name?: string | null;
  peer_id?: string | null;
  channel_type: ChannelType | string;
}

// 정책 = 종류별 기본값(types) + 사람이 그와 다르게 정한 것(override).
export interface ChannelPolicy {
  /** 사람이 명시 설정한 대화 — 정규화 키 → 허용 여부. 기본값을 이긴다(미지정 항목은 기본값을 따른다). */
  override: Map<string, ChannelOverride>;
  /** 해소된 대화 종류 — 정규화 키 → 종류. 없으면 unknown(= 비공개 취급). */
  types: Map<string, ChannelType>;
  /** 키 → 사람에게 보일 이름(#general · DM 은 상대 이름) */
  label: Map<string, string>;
}

export const EMPTY_POLICY: ChannelPolicy = { override: new Map(), types: new Map(), label: new Map() };

// 대화 식별자 — C(공개)·G(구 비공개)·D(DM) + **U(사람)**.
//  U 를 넣는 이유: 슬랙은 DM 을 **상대의 user_id 로도** 연다 — `slack_read_channel(channel_id:"U…")`,
//  `slack_send_message(channel_id:"U…")`(툴 설명 실측). 정책은 D… 로 저장되므로 U… 로 부르면 대조가
//  안 돼 **열람 차단이 그대로 뚫린다.** 그래서 정책 행에 상대 user_id(peer_id)를 함께 담고 여기서 인식한다.
//  ⚠ 단 U 는 **채널 힌트 키 아래에서만** 채널로 읽는다(ID_RE 는 U 를 안 잡는다) — 응답 본문에는 작성자·멘션
//   user id 가 널려 있어서, 본문 스캔으로 U 를 잡으면 "그 사람과의 DM 을 껐다"는 이유로 그 사람이 쓴 모든
//   메시지가 사라진다. 지목(인자)과 언급(본문)은 다르다.
function isChannelId(v: string): boolean {
  return /^[CGDU][A-Z0-9]{6,20}$/.test(v);
}

// 채널 참조 1개를 대조용 키로 — id 는 원형 그대로, 이름은 '#소문자'. 빈 값/형식 밖은 null.
export function channelKey(raw: string | null | undefined): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  if (isChannelId(v)) return v;
  const name = v.replace(/^#/, "").trim().toLowerCase();
  if (!name || name.length > 80) return null;
  return `#${name}`;
}

function normalizeType(v: unknown): ChannelType {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "public" || s === "private" || s === "group_dm" || s === "dm" ? s : "unknown";
}

// 한 대화가 불릴 수 있는 모든 키(id·이름·DM 상대 id) — 툴이 어느 쪽으로 부르든 같은 판정에 닿게.
function keysOf(r: { channel_id: string; channel_name?: string | null; peer_id?: string | null }): string[] {
  return [channelKey(r.channel_id), channelKey(r.channel_name), channelKey(r.peer_id)]
    .filter((k): k is string => !!k);
}

// 표시명 — 채널은 '#이름', **DM·그룹DM 은 사람 이름 그대로**. '#윤상민' 은 채널처럼 읽혀 어색하다.
function displayOf(r: { channel_id: string; channel_name?: string | null }, type: ChannelType): string {
  const isPerson = type === "dm" || type === "group_dm" || /^D/.test(String(r.channel_id));
  if (!r.channel_name) return String(r.channel_id);
  const bare = String(r.channel_name).replace(/^#/, "");
  return isPerson ? bare : `#${bare}`;
}

// 정책 구축 — 종류 캐시(metas)가 기본값을 정하고, 사람이 정한 것(overrides)이 그걸 이긴다.
//  metas 에 없는 대화는 types 에도 없어 unknown → 기본 거부다(캐시를 못 채웠으면 닫히는 쪽으로 샌다).
export function buildChannelPolicy(overrides: ChannelPolicyRowLike[], metas: ChannelMetaLike[] = []): ChannelPolicy {
  const p: ChannelPolicy = { override: new Map(), types: new Map(), label: new Map() };
  for (const m of metas ?? []) {
    const type = normalizeType(m.channel_type);
    const display = displayOf(m, type);
    for (const k of keysOf(m)) { p.types.set(k, type); p.label.set(k, display); }
  }
  for (const r of overrides ?? []) {
    const keys = keysOf(r);
    if (!keys.length) continue;
    // 사람이 설정한 대화의 종류는 캐시가 알고 있으면 그걸 쓰고, 모르면 표시만 id 로 떨어진다.
    const type = p.types.get(keys[0]) ?? "unknown";
    const display = r.channel_name ? displayOf(r, type) : (p.label.get(keys[0]) ?? String(r.channel_id));
    const ov = overrideOf(r);
    for (const k of keys) {
      p.override.set(k, ov);
      p.label.set(k, display);
    }
  }
  return p;
}

/** 이 키의 대화가 허용되는가 — 사람이 명시한 게 있으면 그걸, 없으면 종류별 기본값(모르면 거부). */
export function channelAllows(policy: ChannelPolicy, key: string, kind: "read" | "write"): boolean {
  const ov = policy.override.get(key);
  const d = channelDefaults(policy.types.get(key) ?? "unknown");
  const explicit = kind === "write" ? ov?.write : ov?.read;
  return explicit ?? (kind === "write" ? d.write : d.read);
}

/** 이 키가 '명시적으로 차단된' 대화인가 — 종류를 알거나 사람이 정했고, 그 결과가 거부. */
//  unknown(=모르는 대화)은 여기서 false 다. 모르는 것을 '차단됨' 으로 세면 우연히 id 처럼 생긴 토큰 하나가
//  멀쩡한 응답을 통째로 막는다. 모르는 대화는 '허용 확인' 쪽(아래 allow 판정)에서 걸러진다.
//  ⚠ 구 모델 행이 그 항목을 **미지정**으로 남겼고 종류도 모르면 근거가 없는 것과 같다 → 차단으로 세지 않는다.
function knownBlocked(policy: ChannelPolicy, key: string, kind: "read" | "write"): boolean {
  const ov = policy.override.get(key);
  const explicit = kind === "write" ? ov?.write : ov?.read;
  if (explicit === undefined && !policy.types.has(key)) return false;
  return !channelAllows(policy, key, kind);
}

// ── 참조 추출 — 넓게(언급 포함) ─────────────────────────────────────────────
// 임의 구조가 '스치기라도 한' 채널 키 전부. **비허용 대화가 섞였는지** 확인할 때만 쓴다.
export function extractChannelRefs(node: unknown, keyHint = false, depth = 0): Set<string> {
  const out = new Set<string>();
  collect(node, keyHint, depth, out);
  return out;
}
function collect(node: unknown, keyHint: boolean, depth: number, out: Set<string>): void {
  if (depth > MAX_DEPTH || node === null || node === undefined) return;
  if (typeof node === "string") {
    for (const m of node.matchAll(ID_RE)) out.add(m[1]);
    for (const m of node.matchAll(HASH_RE)) out.add(`#${m[1].toLowerCase()}`);
    if (keyHint) { const k = channelKey(node); if (k) out.add(k); }
    return;
  }
  if (Array.isArray(node)) { for (const v of node) collect(v, keyHint, depth + 1, out); return; }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collect(v, keyHint || CHANNEL_KEY_RE.test(k), depth + 1, out);
    }
  }
}

// ── 참조 추출 — 좁게(지목만) ────────────────────────────────────────────────
// 이 호출/항목이 **지목한** 대화. 허용 판정(오탐이 곧 오차단인 자리)은 반드시 이쪽을 쓴다.
//  포함: 채널 힌트 키 아래의 값(id·맨이름 — 툴이 대화를 고르는 자리) · <#C…|name> · permalink.
//  제외 ①: 본문에 흩어진 맨 id — 언급이지 지목이 아니다(`빌드 CI1234567 실패` 를 대화로 읽으면 안 된다).
//  제외 ②: **힌트 키 밖의 `#이름`** — 이게 없으면 멀쩡한 발송이 막힌다. `text:"#1262 진행 공유합니다"` 의
//   `#1262` 가 '모르는 대화' 로 읽혀 fail-closed 에 걸리기 때문이다(이슈번호·해시태그는 실제로 흔하다).
//   대신 `channel:"#general"` 처럼 툴이 대화를 고르는 자리의 이름은 keyHint 경로로 그대로 잡힌다.
//   검색 쿼리의 `in:#general` 도 여기선 안 잡히는데, 그건 read 라 응답 필터(②)가 받으므로 구멍이 아니다.
export function extractChannelTargets(node: unknown, keyHint = false, depth = 0): Set<string> {
  const out = new Set<string>();
  collectTargets(node, keyHint, depth, out);
  return out;
}
function collectTargets(node: unknown, keyHint: boolean, depth: number, out: Set<string>): void {
  if (depth > MAX_DEPTH || node === null || node === undefined) return;
  if (typeof node === "string") {
    for (const m of node.matchAll(LINK_RE)) out.add(m[1]);
    for (const m of node.matchAll(ARCHIVE_RE)) out.add(m[1]);
    if (keyHint) { const k = channelKey(node); if (k) out.add(k); }
    return;
  }
  if (Array.isArray(node)) { for (const v of node) collectTargets(v, keyHint, depth + 1, out); return; }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectTargets(v, keyHint || CHANNEL_KEY_RE.test(k), depth + 1, out);
    }
  }
}

// 응답(content 블록들)이 지목한 대화 키 — 종류를 미리 해소해 두려고 뽑는다(집행 배선용).
//  ⚠ text 블록이 JSON 문자열이면 **파싱해서 구조로** 읽어야 한다. 그냥 문자열로 스캔하면
//   `{"channel":"C0PRIV…"}` 의 힌트 키가 안 보여 지목을 놓치고, 그 항목은 '귀속 불명' 으로 잘려 나간다.
export function extractResponseTargets(content: unknown[]): Set<string> {
  const out = new Set<string>();
  for (const b of content ?? []) {
    const blk = b as { type?: string; text?: string };
    let node: unknown = b;
    if (blk?.type === "text" && typeof blk.text === "string") {
      try { node = JSON.parse(blk.text); } catch { node = blk.text; }
    }
    for (const k of extractChannelTargets(node)) out.add(k);
  }
  return out;
}

// 이 툴은 '발송'인가 '열람'인가 '메타 조회'인가.
//  · write — 등급(classifyToolLevel: 쓰기동사=L2)이 1차 판정이고, 그 동사표에 없는 대화 특유의
//    내보내기 동작을 여기서 보탠다(초안·답글·초대·업로드·예약). 애매하면 발송(엄격)으로 본다.
//  · meta  — **채널·사용자 목록/검색은 대화 내용이 아니다.** 사람이 끈 것은 "이 대화의 *내용*을 AI 에게
//    안 보여준다"이지 "그런 채널이 있다는 사실을 숨긴다"가 아니다(공개채널 이름은 워크스페이스 멤버면
//    이미 알고, 비공개도 내가 속했으니 안다). 여기를 막았더니 실사용에서 두 가지가 터졌다(#1226 실박스):
//      ① 쿼리에 비허용 채널명이 스치기만 해도 **허용 채널 결과까지** 통째로 사라졌다.
//      ② 차단 안내가 비허용 채널 이름을 알려줘, 가리려던 것을 되레 노출했다.
//    내용 접근은 인자 게이트가 이미 막으므로 메타는 통과시킨다.
//    ⚠ #1262 로 기본값이 '비공개는 거부' 가 된 뒤 이 예외는 **더 중요해졌다** — 메타까지 정책을 태우면
//     사람이 아무것도 안 켠 초기 상태에서 채널 목록 조회조차 전멸해, 무엇을 켜야 할지도 알 수 없게 된다.
//  ⚠ 판정 순서는 write → meta → read. 쓰기로 분류될 것이 meta 로 새면 안 된다(안전측).
//  ⚠ meta 패턴은 **끝 앵커**다 — `get_channel_history` 처럼 뒤에 내용이 붙는 이름을 메타로 오인하면
//    그게 곧 내용 누출이다. 확실한 메타만 빼고 애매하면 read(엄격)로 남긴다.
const CONVERSATION_WRITE_RE = /(?:^|[-_.:/ ])(draft|reply|respond|invite|join|leave|pin|unpin|schedule|share|upload|kick|react)/i;
const CHANNEL_META_RE = /(?:^|[-_.:/ ])(?:(?:list|search|lookup|find)_(?:channels|conversations|users|emojis|teams)|(?:channels|conversations|users|emojis|teams)_(?:list|search))$/i;
export type ChannelToolKind = "read" | "write" | "meta";
export function channelToolKind(toolName: string, level: "L0" | "L1" | "L2" | null | undefined): ChannelToolKind {
  const n = String(toolName || "");
  if (level === "L2" || CONVERSATION_WRITE_RE.test(n)) return "write";
  if (CHANNEL_META_RE.test(n)) return "meta";
  return "read";
}

export interface GuardVerdict {
  allowed: boolean;
  reason?: string;          // 거부 사유(호출자에게 그대로 보여 줄 안내문)
  blocked?: string[];       // 걸린 채널 표시명
}

function labelsOf(policy: ChannelPolicy, keys: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const k of keys) seen.add(policy.label.get(k) ?? k);
  return [...seen];
}

// ① 인자 게이트 — 이 호출을 상류로 보내도 되는가.
//  호출이 **지목한** 대화(좁은 축)가 전부 허용이어야 통과한다. 비공개·DM 은 사람이 켜기 전엔 기본 거부이고,
//  종류를 못 알아낸 대화도 거부다(fail-closed).
//  read : 대화를 안 고르는 호출(전역 검색)은 통과시키고 ②에 맡긴다 — 여기서 막으면 "비공개 하나 때문에
//         슬랙 검색이 통째로 죽는" 꼴이 된다. 허용 채널의 결과는 살려야 한다.
//  write: 지목이 하나도 없으면 거부(fail-closed) — 어디로 나가는지 모르는 발송을 통과시키면 정책이 무의미하다.
export function checkChannelCall(
  toolName: string, args: unknown, policy: ChannelPolicy, kind: "read" | "write",
): GuardVerdict {
  const targets = extractChannelTargets(args);
  const hit = [...targets].filter((r) => !channelAllows(policy, r, kind));
  if (hit.length) {
    const names = labelsOf(policy, hit);
    const act = kind === "write" ? "발송" : "열람";
    // 왜 막혔는지에 따라 안내가 달라야 한다 — 실환경에서 **공개 채널**(사람이 직접 끈 것)에
    //  "비공개 채널·DM 은 기본이 거부라" 는 설명이 붙어, 원인을 완전히 오인시켰다.
    const allExplicit = hit.every((k) => {
      const ov = policy.override.get(k);
      return (kind === "write" ? ov?.write : ov?.read) === false;
    });
    const tail = allExplicit
      ? `[관리 ▸ 외부 서비스 관리 ▸ Slack]에서 이 대화의 ${act}을 다시 켜면 쓸 수 있습니다.`
      : `비공개 채널·그룹DM·DM 은 기본이 '거부'입니다 — [관리 ▸ 외부 서비스 관리 ▸ Slack]에서 그 대화의 ${act}을 켜야 쓸 수 있습니다.`;
    return { allowed: false, blocked: names, reason: `${act}이 허용되지 않은 대화입니다: ${names.join(", ")} — ${tail}` };
  }
  if (kind === "write" && !targets.size) {
    return {
      allowed: false,
      reason: `발송 대상 대화를 인자에서 확인하지 못해 막았습니다(${toolName}). 어디로 나가는지 확인되지 않는 발송은 보내지 않습니다.`,
    };
  }
  return { allowed: true };
}

// 항목(응답의 한 조각) 하나가 남아도 되는가.
//  1) **명시적으로 차단된** 대화가 섞였으면(넓은 축) 무조건 아웃 — 언급만으로도 내용이 새면 안 된다.
//  2) allowOnly(전역 검색 응답)면 여기에 더해 **허용이 확인돼야** 남는다 — 지목(좁은 축) 중 허용된 것이
//     하나도 없으면 제거한다. 귀속을 못 읽는 항목은 '모르는 대화' 이므로 안전측으로 뺀다.
function itemAllowed(node: unknown, policy: ChannelPolicy, allowOnly: boolean): boolean {
  for (const k of extractChannelRefs(node)) if (knownBlocked(policy, k, "read")) return false;
  if (!allowOnly) return true;
  for (const k of extractChannelTargets(node)) if (channelAllows(policy, k, "read")) return true;
  return false;
}

// 상류가 결과를 **배열이 아니라 마크다운 한 덩어리**로 주는 경우 — 슬랙 MCP 실측(2026-07-29):
//   {"results":"# Search Results for: lively\n\n## Channels (3 results)\n### Result 1 of 3\nName: #lively-전체\n
//    Permalink: [link](https://…/archives/C0BLJKT7534)\n\n---\n\n### Result 2 of 3\n…"}
//  배열이 없으니 원소 단위 도려내기가 성립하지 않아 통째 차단으로 떨어졌고, 그래서 **비허용 채널명이 쿼리에
//  스치기만 해도 허용 채널 결과까지 사라졌다**(사용자 지적). `### ` 헤딩이 항목 경계이므로 그 단위로 자른다.
//  첫 조각(제목·`## Channels (N results)`)은 항목이 아니라 머리말이라 항상 보존한다 —
//  도려낸 뒤 그 N 은 실제 개수와 어긋나지만, 결과를 통째로 잃는 것보다 낫다.
// 도려낸 뒤엔 **도려냈다는 사실 자체를 알린다.** 상류 머리말의 개수(`## Messages (6 results)`)와 항목 번호
//  (Result 1·3·5…)는 원본 그대로라, 안내가 없으면 읽는 쪽이 "6개랬는데 3개뿐? 페이지네이션인가?" 하고
//  헤맨다(실측). 어떤 대화가 빠졌는지는 여전히 말하지 않는다 — 가리는 게 목적이니까.
export const OMITTED_NOTE = "[일부 항목은 이 계정의 개인 설정(열람이 허용되지 않은 대화)으로 제외됐습니다 — 어떤 대화인지는 표시하지 않습니다. 위에 표시된 전체 개수·번호는 제외 전 기준입니다.]";

const MD_ITEM_SPLIT = /(?=(?:^|\n)###\s)/;
export function pruneMarkdownItems(
  text: string, policy: ChannelPolicy, allowOnly: boolean,
): { text: string; removed: number } | null {
  if (!/(?:^|\n)###\s/.test(text)) return null; // 항목 구조가 아니면 이 방법으로는 못 자른다
  const parts = text.split(MD_ITEM_SPLIT);
  const head = parts[0] ?? "";
  const items = parts.slice(1);
  if (!items.length) return null;
  const kept = items.filter((p) => itemAllowed(p, policy, allowOnly));
  const removed = items.length - kept.length;
  if (!removed) return { text, removed: 0 };
  return { text: `${head}${kept.join("")}\n${OMITTED_NOTE}\n`, removed };
}

//  noted — 이 하위에서 이미 안내문을 본문에 붙였는가. 마크다운 경로가 붙였으면 최상위 필드는 생략한다
//   (안 그러면 본문 끝과 _omitted_by_policy 양쪽에 같은 문장이 두 번 실린다 — 실환경에서 확인).
interface PruneResult { node: unknown; removed: number; noted?: boolean }
// 배열 원소 단위로 도려낸다 — 검색 결과·메시지 목록이 배열로 오는 구조를 정확히 겨냥.
//  배열이 아니라 마크다운 덩어리로 오는 상류(슬랙)를 위해 문자열도 항목 단위로 자른다.
function prune(node: unknown, policy: ChannelPolicy, allowOnly: boolean, depth = 0): PruneResult {
  if (typeof node === "string") {
    const md = pruneMarkdownItems(node, policy, allowOnly);
    return md ? { node: md.text, removed: md.removed, noted: md.removed > 0 } : { node, removed: 0 };
  }
  if (depth > MAX_DEPTH || node === null || typeof node !== "object") return { node, removed: 0 };
  if (Array.isArray(node)) {
    const kept: unknown[] = [];
    let removed = 0, noted = false;
    for (const el of node) {
      if (el !== null && typeof el === "object" && !itemAllowed(el, policy, allowOnly)) { removed++; continue; }
      const r = prune(el, policy, allowOnly, depth + 1);
      removed += r.removed;
      noted = noted || !!r.noted;
      kept.push(r.node);
    }
    return { node: kept, removed, noted };
  }
  const out: Record<string, unknown> = {};
  let removed = 0, noted = false;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const r = prune(v, policy, allowOnly, depth + 1);
    removed += r.removed;
    noted = noted || !!r.noted;
    out[k] = r.node;
  }
  // 배열에서 도려낸 경우(구조형 응답)에도 같은 안내를 남긴다 — 최상위에서만(중첩마다 붙으면 시끄럽다).
  if (removed && depth === 0 && !noted) out._omitted_by_policy = OMITTED_NOTE;
  return { node: out, removed, noted };
}

export interface FilterResult {
  content: unknown[];
  removed: number;    // 도려낸 항목 수
  blocked: number;    // 통째로 막은 블록 수(구조를 못 읽어 안전측 처리)
}

// ② 응답 필터 — 상류가 돌려준 content 블록에서 허용되지 않은 대화의 흔적을 지운다.
//
// **모드가 둘이다**(#1262). 무엇을 기본으로 삼느냐가 갈린다:
//  · allowOnly=false — 호출이 대화를 지목했고 인자 게이트를 이미 통과한 경우. 그 대화의 정상 응답이므로
//    '명시적으로 차단된 대화가 섞였을 때만' 도려낸다. 여기서 '허용 확인'을 요구하면 방금 허용한 채널의
//    본문(귀속 표시가 없는 메시지들)까지 전부 지워버린다.
//  · allowOnly=true  — 대화를 안 고른 호출(전역 검색). 결과에 무엇이 섞여 올지 모르므로 **허용이 확인된
//    항목만 남긴다.** 귀속을 못 읽는 항목은 뺀다 — #1226 이 남긴 L1 한계('응답에 채널이 안 드러나면 못 거른다')를
//    닫는 자리다. 기본이 '거부' 로 바뀐 이상, 못 읽는 항목을 통과시키면 그 구멍으로 비공개 내용이 샌다.
export function filterChannelContent(content: unknown[], policy: ChannelPolicy, allowOnly: boolean): FilterResult {
  if (!Array.isArray(content)) return { content, removed: 0, blocked: 0 };
  let removed = 0, blocked = 0;
  const out = content.map((b) => {
    const blk = b as { type?: string; text?: string };
    if (!blk || blk.type !== "text" || typeof blk.text !== "string") {
      // 텍스트가 아닌 블록(이미지 등)은 채널 귀속을 읽을 수 없다 → 차단된 흔적이 있으면 막는다.
      //  allowOnly 여도 여기선 '허용 확인'을 요구하지 않는다 — 이미지·리소스는 원래 귀속을 안 싣는다.
      if (!itemAllowed(b, policy, false)) { blocked++; return { type: "text" as const, text: BLOCK_NOTE }; }
      return b;
    }
    // 채널 참조가 아예 없는 텍스트는 손대지 않는다 — 지울 근거도, 남길 근거도 없다.
    //  (#1226 L1 한계: 상류가 귀속을 전혀 안 실으면 이 방벽으로는 못 거른다. 항목 구조가 있으면 아래에서 항목별로 본다.)
    const hasAnyRef = extractChannelRefs(blk.text).size > 0 || /(?:^|\n)###\s/.test(blk.text);
    if (!hasAnyRef) return b;
    if (!allowOnly && itemAllowed(blk.text, policy, false)) return b;   // 차단된 흔적이 없다
    let parsed: unknown;
    try { parsed = JSON.parse(blk.text); } catch { parsed = undefined; }
    if (parsed !== undefined && parsed !== null && typeof parsed === "object") {
      const r = prune(parsed, policy, allowOnly);
      removed += r.removed;
      // 도려내고도 차단 대상이 남았으면(최상위 자체가 그 대화이거나 구조가 예상 밖) 막는다.
      if (itemAllowed(r.node, policy, false)) return { ...blk, text: JSON.stringify(r.node) };
    } else {
      // JSON 이 아닌 마크다운/평문 — 항목 구조면 항목 단위로 자른다.
      const md = pruneMarkdownItems(blk.text, policy, allowOnly);
      if (md) {
        removed += md.removed;
        if (itemAllowed(md.text, policy, false)) return { ...blk, text: md.text };
      } else if (itemAllowed(blk.text, policy, false)) {
        // 항목 구조가 없는 평문은 allowOnly 여도 '허용 확인' 을 요구하지 않는다. 골라낼 항목이 없어
        //  통째 차단밖에 못 하는데, 그러면 **허용된 공개 채널 이름이 스치기만 해도 응답이 통째로 사라진다** —
        //  #1226 이 실사용에서 정확히 이 실패를 겪었다("허용 채널 결과까지 통째로 사라졌다"). 차단된 대화의
        //  흔적이 있으면 위 itemAllowed 가 여전히 막는다.
        return b;
      }
    }
    blocked++;
    return { ...blk, text: BLOCK_NOTE };
  });
  return { content: out, removed, blocked };
}

// ⚠ **어떤 대화가 걸렸는지 말하지 않는다.** 처음엔 친절하려고 비허용 채널 이름을 적었는데, 그건
//  (a) 가리려던 대상을 되레 알려주는 자기모순이었고 (b) 실제로는 그 응답에 걸린 것이 아니라 **저장된
//  deny 목록 전부**를 나열해, 이 검색과 무관한 채널까지 새어 나갔다(#1226 실박스에서 사용자가 지적).
//  이름이 필요한 자리는 인자 게이트뿐이다 — 거기선 호출자가 이미 그 채널을 지목했으니 새 정보가 아니고,
//  왜 막혔는지 알려줘야 한다.
const BLOCK_NOTE = "[열람이 허용되지 않은 대화가 섞여 있어 이 응답을 전달하지 않았습니다. 항목별로 걸러낼 수 없는 형식이라 통째로 막았습니다 — 어떤 대화인지는 알려드리지 않습니다(그걸 가리는 것이 이 설정의 목적입니다). 비공개 채널·그룹DM·DM 은 기본이 '거부'이며, 무엇을 열어 둘지는 본인이 [관리 ▸ 외부 서비스 관리 ▸ Slack]에서 정할 수 있습니다.]";
