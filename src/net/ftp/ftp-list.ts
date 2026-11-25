// FTP 응답·목록 해석(순수 — 소켓 무접근). 클라이언트(ftp-client.ts)와 NAS 색인(net/nas)이 같이 쓴다.
//
// ── 경로는 «바이트 그대로» 들고 다닌다 ──────────────────────────────────────────────────────────
//  NAS(vsftpd)는 파일명을 바이트로만 다룬다. 올린 클라이언트에 따라 같은 서버에 UTF-8 이름과 EUC-KR(CP949) 이름이
//   섞일 수 있다. 사람에게 보일 이름만 디코드하고, 다시 서버에 보낼 경로(CWD·RETR)는 받은 바이트를 그대로 보내야 한다 —
//   디코드했다가 UTF-8 로 다시 인코딩하면 EUC-KR 이름 파일은 «없는 파일»이 된다.
//   그래서 원본 경로는 latin1 문자열(1바이트 = 1글자)로 들고 다니고, 보낼 땐 Buffer.from(raw, "latin1") 로 되돌린다.

/** 목록 한 줄을 푼 결과. name 은 원본 바이트(latin1 문자열)다 — 사람에게 보일 땐 displayName 을 쓴다. */
export interface FtpListEntry {
  type: "file" | "dir" | "link" | "other";
  name: string;
  size: number;
  /** 서버가 준 시각을 `YYYY-MM-DD` 또는 `YYYY-MM-DD HH:MM` 로. 시간대는 서버 설정을 따른다(vsftpd 기본 GMT). */
  mtime: string;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// `ls -l` 꼴 한 줄: 종류+권한 · 링크수 · 소유자 · 그룹 · 크기 · 월 · 일 · 시각|연도 · 이름(공백 포함 가능).
const LS_LINE = /^([-dlbcps])[-rwxsStTl]{9}\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s(.+)$/;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * LIST 응답 한 줄 → 항목. 못 읽는 줄(`total 12` 등)과 `.`·`..` 는 null.
 *  연도 없이 시각만 온 줄은 `ls` 규약상 최근 6개월 안 파일이다 — now 기준 올해로 두되, 미래가 되면 작년으로 내린다.
 */
export function parseListLine(raw: string, now: Date = new Date()): FtpListEntry | null {
  const line = raw.replace(/\r$/, "");
  const m = LS_LINE.exec(line);
  if (!m) return null;
  const [, kind, sizeStr, monStr, dayStr, timeOrYear, rest] = m;
  const month = MONTHS[monStr!.toLowerCase()];
  if (!month) return null;
  let name = rest!;
  const type: FtpListEntry["type"] = kind === "d" ? "dir" : kind === "-" ? "file" : kind === "l" ? "link" : "other";
  if (type === "link") {
    const arrow = name.indexOf(" -> ");
    if (arrow >= 0) name = name.slice(0, arrow);
  }
  if (name === "." || name === "..") return null;
  const day = Number(dayStr);
  let mtime: string;
  if (timeOrYear!.includes(":")) {
    let year = now.getUTCFullYear();
    const [hh, mm] = timeOrYear!.split(":");
    const candidate = Date.UTC(year, month - 1, day);
    if (candidate > now.getTime() + 86_400_000) year -= 1;
    mtime = `${year}-${pad2(month)}-${pad2(day)} ${pad2(Number(hh))}:${mm}`;
  } else {
    mtime = `${timeOrYear}-${pad2(month)}-${pad2(day)}`;
  }
  return { type, name, size: Number(sizeStr), mtime };
}

/** LIST 응답 본문 전체 → 항목 목록(못 읽는 줄은 건너뛴다). */
export function parseListing(body: string, now: Date = new Date()): FtpListEntry[] {
  const out: FtpListEntry[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const e = parseListLine(line, now);
    if (e) out.push(e);
  }
  return out;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const EUCKR = new TextDecoder("euc-kr");

/** 원본 바이트(latin1 문자열) → 사람이 읽을 이름. UTF-8 로 안 읽히면 EUC-KR(CP949)로 읽는다. */
export function displayName(raw: string): string {
  const bytes = Buffer.from(raw, "latin1");
  let s: string;
  try { s = UTF8.decode(bytes); } catch { s = EUCKR.decode(bytes); }
  return s.normalize("NFC");
}

/** 원본 경로(latin1) 의 마디마다 displayName 을 적용한다. */
export function displayPath(raw: string): string {
  return raw.split("/").map(displayName).join("/");
}

/**
 * FTP 명령 인자로 보내도 되는 원본 경로인가. CR·LF·NUL 이 섞이면 제어 채널에 명령을 끼워 넣을 수 있다(명령 주입).
 *  `..` 마디도 받지 않는다 — 서버 chroot 가 막더라도 우리 쪽 링크·색인이 그런 경로를 만들 일이 없다.
 */
export function isSafeRawPath(raw: string): boolean {
  if (!raw.startsWith("/")) return false;
  if (/[\r\n\0]/.test(raw)) return false;
  return !raw.split("/").some((seg) => seg === "..");
}

/** 사람이 읽는 경로(UTF-8)를 원본 경로로 — 서버가 UTF-8 이름을 쓰는 경우(OPTS UTF8 ON). / 로 시작하지 않으면 붙인다. */
export function rawOfDisplayPath(path: string): string {
  const p = String(path ?? "").trim() || "/";
  return Buffer.from(p.startsWith("/") ? p : `/${p}`, "utf8").toString("latin1");
}

/**
 * 부모 원본 경로 아래에 새로 만들 이름(UTF-8) 하나의 원본 경로. 새 이름은 UTF-8 로 쓴다(서버에 OPTS UTF8 ON).
 *  이름이 비었거나 구분자(/)·제어문자(CR·LF·NUL)·`.`·`..` 이거나 UTF-8 255바이트를 넘으면 null.
 */
export function childRawPath(parentRaw: string, name: string): string | null {
  const n = String(name ?? "").normalize("NFC");
  if (!n || n === "." || n === ".." || /[/\r\n\0]/.test(n)) return null;
  const bytes = Buffer.from(n, "utf8");
  if (bytes.length > 255) return null;
  if (!isSafeRawPath(parentRaw)) return null;
  const raw = `${parentRaw.replace(/\/+$/, "")}/${bytes.toString("latin1")}`;
  return isSafeRawPath(raw) ? raw : null;
}

/** 원본 경로의 부모(맨 위는 /). */
export function parentRawPath(raw: string): string {
  const i = raw.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : raw.slice(0, i);
}

/** PASV 응답(`227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)`) → 포트. 주소는 쓰지 않는다(아래 클라이언트 주석). */
export function parsePasvPort(reply: string): number | null {
  const m = /\((\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})\)/.exec(reply);
  if (!m) return null;
  const n = m.slice(1).map(Number);
  if (n.some((x) => x > 255)) return null;
  return n[4]! * 256 + n[5]!;
}

/** 원본 경로를 링크에 싣는 꼴(base64url) ↔ 원본. */
export function encodeRawPath(raw: string): string {
  return Buffer.from(raw, "latin1").toString("base64url");
}
export function decodeRawPath(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(token)) return null;
  return Buffer.from(token, "base64url").toString("latin1");
}
