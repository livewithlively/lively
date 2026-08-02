// delivery ▸ box-status — 박스 상태 창구: 경보 알림 채널(#813) + 저장소·로그 상태.
import type { Capability } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
// 저장소·로그(#813) — 관리탭이 박스 디스크·로그를 보는 창구(고객 박스엔 우리가 SSH 로 못 들어간다).
import { checkDisks } from "../../ops/health.js";
import { listLogs } from "../../ops/log-janitor.js";
import { stateRoot, logRoot } from "../../ops/state-dir.js";
import { ROOTS as TERMINAL_ROOTS, SHARED_ROOT as TERMINAL_SHARED_ROOT, listSessionsRaw } from "../../terminal/terminal-sessions.js";
import { sharedCacheRoot, sessionCacheEnv, dirSize } from "../../ops/build-cache.js";
// 경보 알림(#813) — 웹훅 URL 은 시크릿이라 값이 응답·감사에 절대 나가지 않는다(alerts.ts 머리주석 참조).
import { loadAlertChannel, saveAlertChannel, removeAlertChannel, sendTestAlert } from "../../ops/alerts.js";
import { memAvailableMb, memTotalMb, swapUsageMb } from "../../ops/host-mem.js"; // #1059 G1 — 박스 메모리·스왑 status
import { readEarlyoomKills } from "../../ops/earlyoom-log.js"; // #1240 — earlyoom kill 관측
import { ptyUsage, selfPtmxFdCount } from "../../terminal/host-pty.js"; // #687 후속 — PTY 슬롯 status
import { liveAttachCount, scanAttachProcs } from "../../terminal/terminal-pty.js"; // #687 후속 — 장부 vs 실제(누수 판별)·고아·관측창
import {
  getRuntimeConfig, getStoragePolicySource, getSessionMemoryPolicySource, getSessionReclaimPolicySource, getDelegatePolicySource
} from "../../org/store.js";
import { restOnly, str } from "./shared.js";

// #1059 G1 — Ollama 로드 모델 프로브(best-effort). 급성 스파이크(임베딩 모델 3.3GB)의 가시화용.
//  임베딩 provider 가 http 이고 base_url 이 있을 때만, 그 host 의 /api/ps(Ollama 전용)를 짧게 찔러 로드 모델·용량을 본다.
//  Ollama 가 아니거나(404 등)·미도달·타임아웃이면 null(무해) — 메모리 available 숫자 자체가 이미 스파이크를 반영하므로 부가정보.
//  base_url 은 관리자 설정(신뢰) 이라 직접 fetch(사용자 입력 SSRF 아님). 응답 파싱은 방어적.
async function probeOllama(baseUrl: string | null | undefined): Promise<{ loaded: boolean; models: string[]; mb: number } | null> {
  if (!baseUrl) return null;
  let origin: string;
  try { const u = new URL(baseUrl); origin = `${u.protocol}//${u.host}`; } catch { return null; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(`${origin}/api/ps`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json() as { models?: Array<{ name?: unknown; model?: unknown; size?: unknown }> };
    const models = Array.isArray(j?.models) ? j.models : [];
    const names = models.map((m) => (typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : "")).filter(Boolean);
    const mb = Math.round(models.reduce((s, m) => s + (Number(m.size) || 0), 0) / 1048576);
    return { loaded: models.length > 0, models: names, mb };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export const boxStatusCapabilities: Capability[] = [
  // ── 저장소·로그(#813) 상태 — 박스 디스크 사용률 + 로그 크기 + 유효 정책·출처. ──
  //  왜 필요한가: 고객 박스는 우리가 SSH 로 못 들어간다. 디스크가 차면 Postgres 가 죽고 전 기능이 500 이 되는데
  //  (2026-07-13 사고) 그걸 볼 창구가 없었다. 관리탭이 그 창구다.
  // ── 경보 알림 채널(#813) — 박스가 위험해졌을 때 **사람에게 실제로 닿는** 경로. ──
  //  T5 로 가드는 넣었지만 그 사실을 아무도 모른다(로그는 안 보고, 관리탭·/readyz 는 가서 봐야 안다).
  //  ⚠ 웹훅 URL 은 시크릿이다 — **값을 응답에 절대 싣지 않는다**(configured 불리언만). 저장은 암호화(alerts.ts).
  restOnly("org_alert_status", "경보 알림 설정",
    "박스 경보(디스크 위험·DB 다운)를 보낼 웹훅 설정 상태. **URL 값은 반환하지 않는다**(설정 여부만). admin 전용.",
    [{ method: "GET", paths: ["/api/ui/org/alert"], parse: () => ({}) }],
    async () => loadAlertChannel()),

  restOnly("org_alert_set", "경보 알림 설정 저장",
    "경보 웹훅을 등록/변경한다(슬랙·디스코드 incoming webhook 또는 임의 JSON 웹훅). url 을 비워 보내면 **미변경**(기존 유지). min_severity=warn|critical. admin 전용.",
    [{ method: "POST", paths: ["/api/ui/org/alert"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      // ⚠ url 은 감사·로그에 남기지 않는다(시크릿). redactDeep 은 URL 패턴을 안 잡으므로 감사 스냅샷에 넣으면 그대로 샌다.
      const url = input.url === undefined || input.url === null ? "" : str(input.url, "url", 2000);
      const label = input.label === undefined || input.label === null ? null : str(input.label, "label", 100);
      try {
        return { alert: await saveAlertChannel({ url, min_severity: input.min_severity, label }, user.userId) };
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : "경보 설정을 저장하지 못했습니다");
      }
    }, {
      url: z.string().optional().describe("웹훅 주소(슬랙·디스코드 incoming webhook 또는 임의 JSON 웹훅). **비워 보내면 미변경**(기존 유지) — 시크릿이라 조회로는 안 돌려준다"),
      min_severity: z.enum(["warn", "critical"]).optional().describe("이 등급 이상만 발송(기본 warn)"),
      label: z.string().optional().describe("채널 라벨(메모용)"),
    }),

  restOnly("org_alert_delete", "경보 알림 해제",
    "등록된 경보 웹훅을 삭제한다. admin 전용.",
    [{ method: "POST", paths: ["/api/ui/org/alert/delete"], parse: () => ({}) }],
    async () => ({ removed: await removeAlertChannel(), alert: await loadAlertChannel() })),

  restOnly("org_alert_test", "경보 알림 테스트 전송",
    "지금 등록된 웹훅으로 테스트 경보를 1건 보낸다. **설정이 실제로 닿는지 확인하는 유일한 방법** — 저장만 하고 안 보내보면 정작 장애 때 안 온다. admin 전용.",
    [{ method: "POST", paths: ["/api/ui/org/alert/test"], parse: () => ({}) }],
    async () => {
      const ch = await loadAlertChannel();
      if (!ch.configured) throw new HttpError(400, "웹훅이 등록돼 있지 않습니다");
      // min_severity 게이트를 우회해 **무조건** 보낸다 — 테스트인데 임계 때문에 안 가면 확인이 안 된다.
      const r = await sendTestAlert({
        severity: "ok",
        title: "테스트 경보 — 라이블리 게이트웨이",
        text: "이 메시지가 보이면 경보 채널이 정상입니다. 실제 경보는 디스크 위험·DB 다운 등 상태가 바뀔 때만 옵니다(같은 상태를 반복 발송하지 않습니다).",
        detail: { test: true },
      });
      if (!r.sent) throw new HttpError(502, `전송 실패 — ${r.reason ?? "알 수 없는 오류"}`);
      return { sent: true };
    }),

  restOnly("org_storage_status", "저장소·로그 상태",
    "박스 디스크 사용률(경고/위험 판정 포함) + 로그 파일 크기 + 저장소 정책(로그 상한·디스크 임계치) + per-session 메모리 캡 정책(#1059 D)·idle 회수 정책(#1059 F)과 각 출처 + 라이브 메모리 status(#1059 G1 — available/total·세션수·Ollama). admin 전용.",
    [{ method: "GET", paths: ["/api/ui/org/storage"], parse: () => ({}) }],
    async () => {
      const cfg = await getRuntimeConfig();
      const p = cfg.storage_policy;
      const disks = await checkDisks(
        [stateRoot(), logRoot(), ...TERMINAL_ROOTS.map((r) => r.base)],
        { warnPct: p.disk_warn_pct, criticalPct: p.disk_critical_pct },
      );
      const files = await listLogs(logRoot());
      // 공유 빌드 캐시(#813 T3) — 지금 얼마나 쌓였나 + 어떤 env 를 세션에 주입 중인가(관리자가 눈으로 확인).
      const cacheOpts = { enabled: p.shared_cache_enabled, relocateHome: p.shared_cache_relocate_home };
      const cacheRoot = sharedCacheRoot(TERMINAL_SHARED_ROOT.base);
      // #1059 G1 — 박스 메모리 status(가시화). #1059 다운의 두 축(만성 세션 baseline·급성 Ollama 스파이크)을 한 화면에.
      //  available/total = OOM 근접도(회수 가능 캐시 포함, host-mem) · session_count = baseline 드라이버(중앙 세션 수) ·
      //  ollama = 급성 스파이크(로드 모델·용량, best-effort). 전부 비파괴 조회. 실패해도 status 전체를 막지 않게 방어.
      const availMb = await memAvailableMb().catch(() => 0);
      const totalMb = memTotalMb();
      const swap = await swapUsageMb().catch(() => null);
      const sessionCount = (await listSessionsRaw().catch(() => [])).length;
      const ollama = cfg.embedding_config.provider === "http" ? await probeOllama(cfg.embedding_config.base_url).catch(() => null) : null;
      // #687 후속 — PTY 슬롯 status. 웹터미널 attach 1개 = PTY 1개이고 OS 전역 한도가 있다. 고갈되면 ssh 접속까지
      //  막혀 원격 복구가 불가능해지므로 메모리·디스크와 나란히 보여준다.
      //  누수 판정은 **시스템 사용량과의 차이가 아니라** 장부(liveTerms) 대비 실제(fd·자식 프로세스)로 한다 —
      //  시스템 값에는 tmux pane·ssh·멤버 pty 가 섞여 baseline 이 박스마다 다르고(맥미니 53 vs 고객사 A 106),
      //  그걸로는 상수 임계를 못 잡아 실제로 오탐이 났다. 이 두 값은 0 이 정상이고 0 이 아니면 곧 누수다.
      //  누수 0 은 **관측창과 함께** 봐야 뜻이 있다: 재시작 직후엔 누수 코드여도 0 이 나온다. 그래서 게이트웨이
      //  가동시간과 '가장 오래된 attach 나이'를 같이 싣는다 — 가동 21h 인데 최고령 attach 3h37m 이면 그 사이
      //  것들이 실제로 회수됐다는 직접 증거고, 가동 5분에 0 이면 아직 아무것도 증명하지 못한 것이다.
      //  고아(PPID=1)는 자식 게이트에 원리적으로 안 잡히므로 따로 센다(#687 버그B 축 — 안 세면 0 으로 보인다).
      // #1240 — earlyoom 이 최근 무엇을 죽였나(저널). 이 관측이 없어서 "세션이 주기적으로 회수된다"는 신고에
      //  운영자 journalctl 로그를 받아서야 범인을 짚었다(2026-07-28).
      //  '최근'이라 부르려면 시간창이 있어야 한다 — 건수로만 자르면 몇 달 전 것이 계속 '최근'으로 남는다.
      const earlyoom = await readEarlyoomKills({ limit: 20, sinceMs: Date.now() - 7 * 24 * 3600_000 })
        .catch(() => ({ readable: false, kills: [] }));
      const pty = await ptyUsage().catch(() => null);
      const ptyAttach = liveAttachCount();
      const ptyFdActual = selfPtmxFdCount();
      const ptyProcs = await scanAttachProcs().catch(() => null);
      const ptyLeakOf = (actual: number | null): number | null => (actual === null ? null : Math.max(0, actual - ptyAttach));
      return {
        policy: p,
        policy_source: await getStoragePolicySource(), // db(관리탭) · env(.env 시드) · default(코드 기본값)
        // #1059 G1 — 라이브 메모리 사용량. 관리탭이 저장소(디스크) status 와 나란히 '박스 운영 대시보드'로.
        memory: {
          available_mb: availMb,
          total_mb: totalMb,
          used_pct: totalMb > 0 ? Math.round(((totalMb - availMb) / totalMb) * 100) : 0,
          session_count: sessionCount,
          ollama, // {loaded, models, mb} | null(비-Ollama·미도달)
          // 스왑(#1059 급성 축) — 물리 가용이 넉넉해 보여도 스왑이 바닥이면 스파이크 한 번에 OOM 이다.
          //  total 0 = 스왑 없는 박스, null = 못 잼(둘을 구분해 화면이 '없다'와 '모른다'를 섞지 않게).
          swap_total_mb: swap ? swap.totalMb : null,
          swap_free_mb: swap ? swap.freeMb : null,
          // #1240 — earlyoom kill 이력. ⚠ `readable:false` 는 '**kill 이 없다**'가 아니라 '**못 봤다**'
          //  (서비스 유저가 systemd-journal 그룹이 아니거나 비-Linux). 화면이 둘을 반드시 구분해야 한다 —
          //  관측 실패를 '이상 없음'으로 읽히게 두면 정작 사고 때 사람이 화면을 믿고 엉뚱한 데를 판다.
          earlyoom_readable: earlyoom.readable,
          earlyoom_kills: earlyoom.kills,
        },
        // #687 후속 — PTY 슬롯. null = 못 재는 플랫폼/커널(감시도 skip). attach_count 는 이 게이트웨이가 붙들고 있는 몫.
        pty: pty
          ? {
            used: pty.used, max: pty.max, used_pct: pty.usedPct,
            attach_count: ptyAttach,          // 장부(liveTerms)
            fd_leak: ptyLeakOf(ptyFdActual),                       // 회수 안 된 PTY master fd (0=정상, null=못 잼)
            proc_leak: ptyLeakOf(ptyProcs ? ptyProcs.children : null), // 죽지 않은 attach 자식 프로세스 (0=정상, null=못 잼)
            orphan_attach: ptyProcs ? ptyProcs.orphans : null,     // 이전 인스턴스가 남긴 고아(PPID=1) — 자식 게이트엔 안 잡힌다
            oldest_attach_sec: ptyProcs ? ptyProcs.oldestChildSec : null, // 관측창 ①: 가장 오래된 attach 나이
            uptime_sec: Math.round(process.uptime()),              // 관측창 ②: 이 게이트웨이가 떠 있는 시간 = 누수 0 의 유효기간
          }
          : null,
        // per-session 메모리 캡(#1059 D) — 세션당 MemoryHigh/Max(MB, 0=무제한). 정책값·출처 노출(설정은 org_runtime_update POST).
        session_memory_policy: cfg.session_memory_policy,
        session_memory_policy_source: await getSessionMemoryPolicySource(),
        // idle 세션 자동 회수 정책(#1059 F) — idle TTL(분, 0=끔). 라이브 세션 수·메모리 status(G1)는 후속(#1064)이 얹는다.
        session_reclaim_policy: cfg.session_reclaim_policy,
        session_reclaim_policy_source: await getSessionReclaimPolicySource(),
        // 위탁 무출력 stall 상한(#1101) — ms, 0=가드 끔. 스케줄러가 30s 캐시로 읽는다(저장 즉시 무효화).
        delegate_policy: cfg.delegate_policy,
        delegate_policy_source: await getDelegatePolicySource(),
        disks,
        logs: {
          dir: logRoot(),
          files,
          totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
          // 정책상 로그가 최대 얼마까지 자랄 수 있나 — '설정이 뭘 뜻하는지'를 UI 가 계산 없이 그대로 보여줄 수 있게.
          capBytes: p.log_max_mb * 1024 * 1024 * (p.log_keep + 1),
        },
        cache: {
          root: cacheRoot,
          // 세션에 실제로 주입되는 변수 이름들(값=경로는 안 민감하지만 이름만으로 충분히 설명된다).
          vars: Object.keys(sessionCacheEnv(TERMINAL_SHARED_ROOT.base, cacheOpts)).sort(),
          bytes: await dirSize(cacheRoot),
        },
      };
    }),
];
