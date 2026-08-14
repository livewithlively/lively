// admin-storage.ts — [컴퓨팅 리소스] 패널 (#1313 R39, admin.ts 에서 verbatim 분리).
//  서브탭 4개(메모리 · PTY 슬롯 · 저장소 · 경보 알림) + 워크스페이스 정리(분석 → 정리) 영역이 한 몸이다.
//  왜 한 파일인가: 네 탭이 **같은 GET /api/ui/org/storage 응답 한 벌**(st)과 같은 입력 요소들을 공유하고,
//   경보 탭의 옵션 문구는 저장소 탭이 채우는 alertPolicy 를 읽는다. 탭 단위로 더 쪼개면 그 한 벌을 넘기는
//   배선이 새로 생긴다 — 이번 이동의 목적(셸에서 떼기)과 무관한 구조 변경이라 하지 않는다.
//  뮤터블 상태(alertPolicy · analyzed · selected · wsList)는 전부 storageEditor 지역이라 모듈 전역이 없다.
import { api, busy, cardHead, el, relTime, secretInput, secretRow, toast, uiText } from './core.js';
import { fmtBytes, fmtElapsed, sectionHead, segTabs } from './admin-widgets.js';
import { planReclaimBatches, wtRemovable } from './admin-storage-plan.js';

function storageEditor(detail, data) {
  const canEdit = !!data.canEdit;
  const body = el('div');
  detail.replaceChildren(
    // 문구는 화면이 실제로 다루는 것과 맞춘다 — 로그는 별도 메뉴로 빠졌고(#1059), 메모리·PTY 가 들어왔다.
    sectionHead('컴퓨팅 리소스', '이 서버가 쓰는 자원 — 메모리 · PTY 슬롯 · 디스크 — 를 한 화면에서 보고, 바닥나기 전에 알림을 받도록 임계를 정합니다. 어느 하나가 고갈되면 로그인·세션·터미널이 함께 멈추고, PTY 는 고갈되면 ssh 접속까지 막혀 원격으로 고칠 수도 없게 됩니다.'),
    el('div', { class: 'card' }, cardHead('메모리 · PTY 슬롯 · 디스크 · 경보 알림'), body));
  body.append(el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));

  async function load() {
    let st;
    try { st = await api('/api/ui/org/storage'); }
    catch (e: any) { body.replaceChildren(el('p', { class: 'admin-hint', text: '상태를 불러오지 못했습니다: ' + e.message })); return; }
    build(st);
  }

  function build(st) {
    const p = st.policy || {};
    alertPolicy = p;   // 경보 알림 옵션 문구가 실제 임계값을 표기하도록 공유

    // ── 위험 배너(#813 T5) — 무엇이 이미 막히고 있는지 먼저 말한다. 숫자보다 '지금 무슨 일이 벌어지나'가 급하다. ──
    const worst = (st.disks || []).reduce((w, d) => (!w || d.usedPct > w.usedPct ? d : w), null);
    const banner = worst && worst.level === 'critical'
      ? el('div', { class: 'storage-banner storage-banner-critical' },
        el('strong', { text: `⚠ 디스크 위험 (${worst.usedPct}%) — 새 세션 · 레포 클론 · 파일 업로드가 차단되고 있습니다.` }),
        el('p', {}, ...uiText('아래 워크스페이스에서 [분석] → [정리]로 공간을 확보하세요. 100%에 닿으면 DB가 중단되어 로그인을 포함한 모든 기능이 멈추고, 공간을 비워도 수동 재시작이 필요합니다.')))
      : worst && worst.level === 'warn'
        ? el('div', { class: 'storage-banner storage-banner-warn' },
          el('strong', { text: `디스크 경고 (${worst.usedPct}%) — 아직 정상 동작하지만 정리가 필요합니다.` }),
          el('p', { text: `${p.disk_critical_pct ?? 95}%를 넘으면 새 세션·클론·업로드가 자동으로 차단됩니다.` }))
        : null;

    // ── ① 지금 상태 — 디스크 게이지 ──
    const LV = { ok: ['여유', 'ok'], warn: ['경고', 'warn'], critical: ['위험', 'critical'] };
    const diskRows = (st.disks || []).map((d) => {
      const [lvLabel, lvKey] = LV[d.level] || LV.ok;
      const fill = el('div', { class: 'gauge-fill gauge-' + lvKey });
      fill.style.width = Math.min(100, Math.max(2, d.usedPct)) + '%';
      return el('div', { class: 'storage-item' },
        el('div', { class: 'storage-head' },
          el('code', { text: d.path }),
          el('span', { class: 'storage-lv storage-lv-' + lvKey, text: '사용 ' + d.usedPct + '% · ' + lvLabel })),
        el('div', { class: 'gauge' }, fill),
        el('p', { class: 'storage-calc', text: `전체 ${fmtBytes(d.totalBytes)} 중 ${fmtBytes(d.availBytes)} 남음` }));
    });
    if (!diskRows.length) diskRows.push(el('p', { class: 'admin-hint' }, ...uiText('디스크 정보를 읽지 못했습니다.')));

    // ── ① 지금 상태 — 메모리 게이지(#1059 G1) ── 만성(세션 baseline)·급성(Ollama 스파이크)을 한 눈에.
    const mem = st.memory || null;
    let memBlock: any = null;
    if (mem) {
      const usedPct = Math.min(100, Math.max(0, Number(mem.used_pct) || 0));
      const mlvKey = usedPct >= 90 ? 'critical' : usedPct >= 75 ? 'warn' : 'ok';
      const mlvLabel = mlvKey === 'critical' ? '위험' : mlvKey === 'warn' ? '경고' : '여유';
      const mfill = el('div', { class: 'gauge-fill gauge-' + mlvKey });
      mfill.style.width = Math.min(100, Math.max(2, usedPct)) + '%';
      const oll = mem.ollama;
      const ollLine = oll
        ? (oll.loaded
          ? `Ollama 로드 ${oll.mb ? fmtBytes(oll.mb * 1024 * 1024) : ''}${(oll.models || []).length ? ' (' + oll.models.slice(0, 3).join(', ') + ')' : ''}`
          : 'Ollama 로드 모델 없음')
        : '';
      // 스왑 — 물리 가용과 **따로** 봐야 한다. 가용이 넉넉해 보여도 스왑이 바닥이면 스파이크 한 번에 OOM 이다
      //  (2026-07-28 고객사 A 실측: 가용 4.2GB 인데 스왑 여유 454MB). null=못 잼, 0=스왑 없는 박스 — 둘을 구분한다.
      const swTotal = mem.swap_total_mb, swFree = mem.swap_free_mb;
      const swapLine = typeof swTotal === 'number' && typeof swFree === 'number'
        ? (swTotal > 0
          ? `스왑 ${fmtBytes(swTotal * 1024 * 1024)} 중 ${fmtBytes(swFree * 1024 * 1024)} 남음`
            + (swFree / swTotal < 0.1 ? ' ⚠ 거의 소진(물리 가용과 무관하게 위험)' : '')
          : '스왑 없음')
        : '';
      memBlock = el('div', { class: 'storage-item' },
        el('div', { class: 'storage-head' },
          el('strong', { text: '메모리' }),
          el('span', { class: 'storage-lv storage-lv-' + mlvKey, text: '사용 ' + usedPct + '% · ' + mlvLabel })),
        el('div', { class: 'gauge' }, mfill),
        el('p', { class: 'storage-calc', text: `전체 ${fmtBytes((mem.total_mb || 0) * 1024 * 1024)} 중 ${fmtBytes((mem.available_mb || 0) * 1024 * 1024)} 가용 · 세션 ${mem.session_count ?? 0}개${swapLine ? ' · ' + swapLine : ''}${ollLine ? ' · ' + ollLine : ''}` }));
    }

    // ── #1240 earlyoom 강제 종료 이력 ──
    //  earlyoom 의 SIGTERM 은 `exec claude` 구조상 세션까지 없애는데, 지금까지 게이트웨이가 그걸 몰라서
    //  "세션이 주기적으로 회수된다"는 신고에 운영자 journalctl 로그를 받아서야 범인을 짚었다(2026-07-28).
    //  ⚠ **'기록 없음'과 '못 봄'을 절대 같게 그리지 않는다** — 관측 실패를 '이상 없음'으로 읽히게 두면
    //   정작 사고 때 사람이 이 화면을 믿고 엉뚱한 데를 판다(#1220 의 "한 소스만 보고 단정"의 UI 판).
    let killBlock: any = null;
    if (mem) {
      const eoReadable = mem.earlyoom_readable;
      const eoKills: any[] = Array.isArray(mem.earlyoom_kills) ? mem.earlyoom_kills : [];
      const recent = eoKills.slice().sort((a: any, b: any) => (b.at || 0) - (a.at || 0)).slice(0, 10);
      killBlock = el('div', { class: 'storage-block' },
        el('strong', { text: '최근 강제 종료 (earlyoom)' }),
        ...(eoReadable === false
          ? [el('p', { class: 'admin-hint' }, ...uiText('시스템 저널을 읽을 권한이 없어 **확인할 수 없습니다** — 강제 종료가 없었다는 뜻이 아닙니다. 최신 버전으로 재배포하면 설치가 게이트웨이 계정을 systemd-journal 그룹(읽기 전용)에 넣어 이 목록이 채워집니다.'))]
          : recent.length === 0
            ? [el('p', { class: 'storage-calc', text: '기록 없음 — OS 보호장치가 프로세스를 강제 종료한 적이 없습니다.' })]
            : [
              el('p', { class: 'storage-calc', text: `${eoKills.length}건. 메모리가 임계에 닿아 OS 가 죽인 프로세스입니다 — claude 가 죽었다면 그 멤버의 웹터미널 세션이 사라진 것입니다(작업 내용은 보존돼 “복원 가능”으로 뜹니다).` }),
              ...recent.map((k: any) => el('p', {
                class: 'storage-calc',
                text: `· ${k.at ? new Date(k.at).toLocaleString() : '시각 미상'} — ${k.name} (${k.signal}) · 회수 ${k.vmRssMb}MB · uid ${k.uid}`,
              })),
            ]),
        el('p', { class: 'admin-hint' }, ...uiText('기록이 쌓인다면 아래 “메모리 압박 회수”를 켜세요 — 이 지경에 이르기 전에 게이트웨이가 먼저 idle 세션을 **복원 가능한 방식으로** 정리합니다. 회수량이 건당 작은데 건수가 많다면, 죽여도 압박이 안 풀려 연쇄로 죽는 상태입니다.')));
    }

    // ── PTY 슬롯 게이지(#687 후속) ── 웹터미널 attach 1개 = PTY 1개이고 OS 전역 한도가 있다. 고갈되면 웹터미널은
    //  물론 **ssh 접속까지** 막혀 박스에 들어가 고칠 수 없다 → 디스크·메모리보다 이른 단계(70/85)로 본다.
    //  attach(우리 몫)와 시스템 사용량의 갭이 곧 누수 지표라 함께 보여준다.
    const ptyS = st.pty || null;
    let ptyBlock: any = null;
    if (ptyS) {
      const pUsed = Number(ptyS.used) || 0, pMax = Number(ptyS.max) || 0;
      const pPct = Number(ptyS.used_pct) || 0;
      const plvKey = pPct >= 85 ? 'critical' : pPct >= 70 ? 'warn' : 'ok';
      const plvLabel = plvKey === 'critical' ? '위험' : plvKey === 'warn' ? '경고' : '여유';
      const pfill = el('div', { class: 'gauge-fill gauge-' + plvKey });
      pfill.style.width = Math.min(100, Math.max(2, pPct)) + '%';
      const att = Number(ptyS.attach_count) || 0;
      // 누수 판정은 '시스템 사용량 − attach' 차이가 **아니라** 장부(liveTerms) 대비 실제(fd·자식 프로세스)로 한다.
      //  차이 지표는 tmux pane·ssh·멤버 pty 가 섞여 baseline 이 박스마다 달라(맥미니 53 vs 고객사 A 106)
      //  상수 임계로 상시 오탐이 났다. 서버 판정(box-watch ptyLeakHint)과 같은 기준을 쓴다 — 두 곳이 어긋나면 안 된다.
      const fdLeak = ptyS.fd_leak, procLeak = ptyS.proc_leak, orphan = ptyS.orphan_attach;
      const leaks: string[] = [];
      if (typeof fdLeak === 'number' && fdLeak > 0) leaks.push(`PTY fd ${fdLeak}개`);
      if (typeof procLeak === 'number' && procLeak > 0) leaks.push(`attach 프로세스 ${procLeak}개`);
      // 고아(PPID=1)는 위 둘과 출처가 다르다 — 부모가 죽어 장부에도, 자식 카운트에도 안 잡힌다(#687 버그B 축).
      //  안 세면 "0" 으로 보여 사람을 안심시키므로 별도 항목으로 노출한다.
      if (typeof orphan === 'number' && orphan > 0) leaks.push(`고아 attach ${orphan}개(이전 인스턴스 잔재)`);
      const gapHint = leaks.length
        ? ` · ⚠ 누수 ${leaks.join(' · ')} — 게이트웨이 재시작으로 즉시 회수`
        : (fdLeak == null && procLeak == null && orphan == null ? '' : ' · 누수 없음(장부와 실제 일치)');
      // 관측창 — "누수 없음"의 **유효기간**. 재시작 직후엔 누수 코드여도 0 이 나오므로, 가동시간 없이 0 만 보여주면
      //  화면이 실제보다 안심시킨다. 가동 21시간인데 최고령 attach 3시간이면 그 사이 것들이 회수됐다는 직접 증거다.
      const upSec = Number(ptyS.uptime_sec) || 0;
      const oldest = ptyS.oldest_attach_sec;
      const winParts: string[] = [];
      if (upSec > 0) winParts.push(`게이트웨이 가동 ${fmtElapsed(upSec)}`);
      if (typeof oldest === 'number') winParts.push(`최고령 attach ${fmtElapsed(oldest)}`);
      else if (att === 0 && upSec > 0) winParts.push('열린 attach 없음');
      const shortWindow = upSec > 0 && upSec < 3600 && !leaks.length;
      const windowHint = winParts.length
        ? ` · 관측창: ${winParts.join(' · ')}${shortWindow ? ' — 아직 짧아 ‘누수 없음’의 근거가 약합니다' : ''}`
        : '';
      ptyBlock = el('div', { class: 'storage-item' },
        el('div', { class: 'storage-head' },
          el('strong', { text: 'PTY 슬롯' }),
          el('span', { class: 'storage-lv storage-lv-' + plvKey, text: '사용 ' + pPct + '% · ' + plvLabel })),
        el('div', { class: 'gauge' }, pfill),
        el('p', { class: 'storage-calc', text: `한도 ${pMax} 중 ${pUsed} 사용 · 이 게이트웨이의 웹터미널 attach ${att}개${gapHint}${windowHint}` }));
    }

    // ── ② 정책 ── (로그 status·보관정책은 별도 '로그' 메뉴 = logsEditor 로 분리 — #1059 사용자 피드백)
    const numIn = (val, min, max) => {
      const i = el('input', { class: 'input input-num', type: 'number', min: String(min), max: String(max) });
      i.value = String(val); i.disabled = !canEdit;
      return i;
    };
    const warnIn = numIn(p.disk_warn_pct ?? 85, 1, 99);
    const critIn = numIn(p.disk_critical_pct ?? 95, 1, 100);

    // ── ② 정책 — 공유 빌드 캐시(#813 T3) ──
    const cache = st.cache || { root: '', vars: [], bytes: 0, partial: false };
    const cacheChk = el('input', { type: 'checkbox' });
    cacheChk.checked = p.shared_cache_enabled !== false; cacheChk.disabled = !canEdit;
    const homeChk = el('input', { type: 'checkbox' });
    homeChk.checked = !!p.shared_cache_relocate_home; homeChk.disabled = !canEdit;
    const cacheState = el('p', { class: 'storage-calc' });
    const syncCacheState = () => {
      homeChk.disabled = !canEdit || !cacheChk.checked;
      cacheState.textContent = cacheChk.checked
        ? `현재 ${fmtBytes(cache.bytes)}${cache.partial ? '+' : ''} 사용 · 세션에 주입되는 변수 ${cache.vars.length}개 (${(cache.vars || []).slice(0, 4).join(', ')}…)`
        : '꺼짐 — 세션마다 의존성을 새로 내려받습니다(디스크·시간 낭비).';
    };
    cacheChk.addEventListener('change', syncCacheState);
    syncCacheState();

    const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '정책 저장' });
    saveBtn.disabled = !canEdit;
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        // 저장소 정책 = 디스크 임계 + 공유 캐시만. 로그(로그 메뉴)·메모리 임계(메모리 탭)는 각자 저장 —
        //  updateRuntimeConfig 가 storage_policy 를 **병합**하므로 여기서 안 보낸 필드(log_*·mem_*)는 보존된다.
        const storage_policy = {
          disk_warn_pct: Number(warnIn.value),
          disk_critical_pct: Number(critIn.value),
          shared_cache_enabled: cacheChk.checked,
          shared_cache_relocate_home: homeChk.checked,
        };
        await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ storage_policy }) });
        toast('저장됨 — 즉시 반영됩니다(재시작 불필요).');
        load();
      } catch (e: any) { toast(e.message, true); saveBtn.disabled = false; }
    });

    // 설정 출처 안내 — .env 시드로 도는지, 관리탭 저장값인지(혼동 방지, #688 임베딩과 같은 관례).
    const srcNote = st.policy_source === 'env'
      ? el('p', { class: 'admin-hint' }, ...uiText('현재 값은 서버 환경변수(.env) 시드입니다 — 여기서 저장하면 관리탭 설정이 우선합니다.'))
      : st.policy_source === 'default'
        ? el('p', { class: 'admin-hint' }, ...uiText('아직 설정한 적이 없어 기본값으로 동작 중입니다.'))
        : null;

    // 정책 출처 한 줄(#688 관례) — db(관리탭)·env(.env 시드)·default(기본값).
    const srcHint = (source: string): any => source === 'env'
      ? el('p', { class: 'admin-hint' }, ...uiText('현재 값은 서버 환경변수(.env) 시드입니다 — 여기서 저장하면 관리탭 설정이 우선합니다.'))
      : source === 'default'
        ? el('p', { class: 'admin-hint' }, ...uiText('아직 설정한 적이 없어 기본값으로 동작 중입니다.'))
        : null;

    // ── ② 정책 — 세션 메모리 상한(#1059 D) ── per-session cgroup(box-cgspawn) 캡. 0=무제한(무회귀). 배포+캡 설정 시 세션이 scope 격리.
    const smp = st.session_memory_policy || {};
    const memHighIn = numIn(smp.per_session_high_mb ?? 0, 0, 1048576);
    const memMaxIn = numIn(smp.per_session_max_mb ?? 0, 0, 1048576);
    const memPolBtn = el('button', { class: 'btn btn-primary btn-sm', text: '세션 메모리 정책 저장' }); memPolBtn.disabled = !canEdit;
    memPolBtn.addEventListener('click', async () => {
      memPolBtn.disabled = true;
      try {
        await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ session_memory_policy: { per_session_high_mb: Number(memHighIn.value), per_session_max_mb: Number(memMaxIn.value) } }) });
        toast('저장됨 — 새 세션부터 적용됩니다(기존 세션은 재생성 시).'); load();
      } catch (e: any) { toast(e.message, true); memPolBtn.disabled = false; }
    });

    // ── ② 정책 — idle 세션 자동 회수(#1059 F) ── 그 시간 넘게 idle 인 세션을 회수(desired-state 보존→복원 가능). 0=끔(무회귀).
    const srp = st.session_reclaim_policy || {};
    const idleTtlIn = numIn(srp.idle_ttl_minutes ?? 0, 0, 43200);
    // #1220 압박 회수 — 사용률이 임계를 넘으면 평시 TTL 을 안 기다리고 걷는다(earlyoom 이 예고 없이 죽이기 전에).
    const pressurePctIn = numIn(srp.pressure_used_pct ?? 0, 0, 99);
    const pressureIdleIn = numIn(srp.pressure_idle_minutes ?? 60, 0, 43200);
    const reclaimBtn = el('button', { class: 'btn btn-primary btn-sm', text: 'idle 회수 정책 저장' }); reclaimBtn.disabled = !canEdit;
    reclaimBtn.addEventListener('click', async () => {
      reclaimBtn.disabled = true;
      try {
        await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ session_reclaim_policy: { idle_ttl_minutes: Number(idleTtlIn.value) } }) });
        toast('저장됨 — 다음 회수 주기(5분)부터 적용됩니다.'); load();
      } catch (e: any) { toast(e.message, true); reclaimBtn.disabled = false; }
    });
    // 같은 정책(session_reclaim_policy)의 다른 축이라 버튼을 나눈다 — 저장은 patch 병합이라 안 보낸 필드는 보존된다.
    const pressureBtn = el('button', { class: 'btn btn-primary btn-sm', text: '압박 회수 정책 저장' }); pressureBtn.disabled = !canEdit;
    pressureBtn.addEventListener('click', async () => {
      pressureBtn.disabled = true;
      try {
        await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ session_reclaim_policy: {
          pressure_used_pct: Number(pressurePctIn.value),
          pressure_idle_minutes: Number(pressureIdleIn.value),
        } }) });
        toast('저장됨 — 다음 회수 주기(5분)부터 적용됩니다.'); load();
      } catch (e: any) { toast(e.message, true); pressureBtn.disabled = false; }
    });

    // ── ③ 정책 — 위탁 작업 무응답 상한(#1101) ── 무출력으로 매달린 작업을 제한시간(1h)까지 안 기다리고 끊는다.
    //  자유입력이 아니라 셀렉트인 게 의도다 — 너무 짧게 잡으면 멀쩡한 작업을 죽인다(서버도 0 초과면 1분 미만을 올려 막는다).
    const dp = st.delegate_policy || {};
    const STALL_PRESETS = [
      ['0', '끔 — 작업 제한시간까지 기다림'],
      ['60000', '1분'],
      ['180000', '3분'],
      ['300000', '5분 (기본·권장)'],
      ['600000', '10분'],
      ['1800000', '30분'],
    ];
    const curStall = String(dp.stall_ms ?? 300000);
    const stallSel = el('select', {}, ...STALL_PRESETS.map(([v, label]) => el('option', { value: v, text: label })));
    if (!STALL_PRESETS.some(([v]) => v === curStall)) stallSel.append(el('option', { value: curStall, text: `현재 설정: ${curStall}ms` }));
    stallSel.value = curStall;
    stallSel.disabled = !canEdit;
    const stallBtn = el('button', { class: 'btn btn-primary btn-sm', text: '무응답 상한 저장' }); stallBtn.disabled = !canEdit;
    stallBtn.addEventListener('click', async () => {
      stallBtn.disabled = true;
      try {
        await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ delegate_policy: { stall_ms: Number(stallSel.value) } }) });
        toast('저장됨 — 다음 감시 주기부터 적용됩니다.'); load();
      } catch (e: any) { toast(e.message, true); stallBtn.disabled = false; }
    });

    // ── 메모리 경보 임계(#1059) — 디스크처럼 사용%가 임계 넘으면 경보 웹훅. 0=끔. 채널은 [경보 알림] 탭 공용. ──
    const memWarnIn = numIn(p.mem_warn_pct ?? 0, 0, 99);
    const memCritIn = numIn(p.mem_critical_pct ?? 0, 0, 100);
    const memAlertBtn = el('button', { class: 'btn btn-primary btn-sm', text: '메모리 경보 임계 저장' }); memAlertBtn.disabled = !canEdit;
    memAlertBtn.addEventListener('click', async () => {
      memAlertBtn.disabled = true;
      try {
        await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ storage_policy: { mem_warn_pct: Number(memWarnIn.value), mem_critical_pct: Number(memCritIn.value) } }) });
        toast('저장됨 — 다음 감시 주기(5분)부터 적용됩니다.'); load();
      } catch (e: any) { toast(e.message, true); memAlertBtn.disabled = false; }
    });

    // ── PTY 경보 임계(#687 후속) — 메모리·디스크와 같은 웹훅 채널. 다른 점은 **기본 켬**(70/85)이라는 것. ──
    const ptyWarnIn = numIn(p.pty_warn_pct ?? 70, 0, 99);
    const ptyCritIn = numIn(p.pty_critical_pct ?? 85, 0, 100);
    const ptyAlertBtn = el('button', { class: 'btn btn-primary btn-sm', text: 'PTY 경보 임계 저장' }); ptyAlertBtn.disabled = !canEdit;
    ptyAlertBtn.addEventListener('click', async () => {
      ptyAlertBtn.disabled = true;
      try {
        await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify({ storage_policy: { pty_warn_pct: Number(ptyWarnIn.value), pty_critical_pct: Number(ptyCritIn.value) } }) });
        toast('저장됨 — 다음 감시 주기(5분)부터 적용됩니다.'); load();
      } catch (e: any) { toast(e.message, true); ptyAlertBtn.disabled = false; }
    });

    // ── 서브탭: [메모리] · [PTY 슬롯] · [저장소] (#1059 — 메모리를 저장소 하위에서 꺼내 대등한 탭으로) ──
    const memoryTab = (host: any) => host.replaceChildren(
      el('h3', { class: 'storage-h', text: '지금 상태' }),
      ...(memBlock
        ? [el('div', { class: 'storage-block' }, memBlock,
          el('p', { class: 'admin-hint' }, ...uiText('가용 = 회수 가능한 캐시 포함(지금 새 작업에 내줄 수 있는 양). #1059 다운은 만성(세션 baseline)+급성(Ollama 임베딩 스파이크)이 겹쳐 물리 초과로 일어났습니다 — 세션 수와 Ollama 로드를 함께 봅니다.')))]
        : [el('div', { class: 'storage-block' }, el('p', { class: 'admin-hint' }, ...uiText('메모리 정보를 읽지 못했습니다.')))]),
      ...(killBlock ? [killBlock] : []),

      el('h3', { class: 'storage-h', text: '메모리 경보' }),
      el('div', { class: 'storage-block' },
        el('strong', { text: '메모리 경보 임계' }),
        el('div', { class: 'storage-fields' },
          el('label', {}, el('span', { text: '경고 임계(사용%, 0=끔)' }), memWarnIn),
          el('label', {}, el('span', { text: '위험 임계(사용%, 0=끔)' }), memCritIn)),
        el('p', { class: 'storage-calc', text: '디스크처럼, 메모리 사용%가 이 값을 넘으면 경보 웹훅으로 알립니다(OOM 임박 사전 경고). 위험 임계는 경고보다 커야 합니다. 0=끔. 제안: 경고 85 · 위험 95.' }),
        el('p', { class: 'admin-hint' }, ...uiText('경보를 받을 웹훅 채널은 [경보 알림] 탭에서 설정합니다(디스크·DB·메모리·PTY 공용). 위 게이지의 현재 사용%를 보고 임계를 정하세요.')),
        el('div', { class: 'storage-actions' }, memAlertBtn)),

      // ── 세션 메모리·회수(#1059) — 박스 다운(OOM) 재발 방지의 두 축을 관리탭에서 조절 ──
      el('h3', { class: 'storage-h', text: '세션 메모리 · 회수' }),
      el('div', { class: 'storage-block' },
        el('strong', { text: '세션 메모리 상한 (per-session)' }),
        ...(srcHint(st.session_memory_policy_source) ? [srcHint(st.session_memory_policy_source)] : []),
        el('div', { class: 'storage-fields' },
          el('label', {}, el('span', { text: 'MemoryHigh(MB, 0=무제한)' }), memHighIn),
          el('label', {}, el('span', { text: 'MemoryMax(MB, 0=무제한)' }), memMaxIn)),
        el('p', { class: 'storage-calc', text: 'MemoryMax 를 넘은 세션은 그 세션 안에서만 OOM-kill 되고 박스는 생존합니다(폭주 1개만 죽음). MemoryHigh 는 그 아래 소프트 스로틀. High ≤ Max.' }),
        el('p', { class: 'admin-hint' }, ...uiText('claude 는 네이티브라 힙제한이 안 통해 cgroup 이 유일 수단입니다. 0/0=무제한(무회귀). 캡을 걸면 새 세션이 격리 scope 로 뜹니다(박스에 격리 인프라 배포 필요 — 미설치면 종전대로 무제한). 예: 16GB 박스 High 3072 · Max 4096.')),
        el('div', { class: 'storage-actions' }, memPolBtn)),
      el('div', { class: 'storage-block' },
        el('strong', { text: 'idle 세션 자동 회수' }),
        ...(srcHint(st.session_reclaim_policy_source) ? [srcHint(st.session_reclaim_policy_source)] : []),
        el('div', { class: 'storage-fields' },
          el('label', {}, el('span', { text: 'idle 임계(분, 0=끔)' }), idleTtlIn)),
        el('p', { class: 'storage-calc', text: '이 시간 넘게 idle 인 세션을 5분 주기로 회수합니다. 작업내용(대화·설정)은 보존돼 목록에 “복원 가능”으로 남고, 열면 이어집니다(admission control 대신 채택).' }),
        el('p', { class: 'admin-hint' }, ...uiText('0=끔(무회귀, 기본). 상시(managed)·접속 중·작업 중·확인 대기 세션은 절대 회수하지 않습니다. 예: 16GB 박스 180~1440분.')),
        el('div', { class: 'storage-actions' }, reclaimBtn)),
      el('div', { class: 'storage-block' },
        el('strong', { text: '메모리 압박 회수' }),
        el('div', { class: 'storage-fields' },
          el('label', {}, el('span', { text: '발동 임계(사용%, 0=끔)' }), pressurePctIn),
          el('label', {}, el('span', { text: '압박 시 idle 하한(분)' }), pressureIdleIn)),
        el('p', { class: 'storage-calc', text: '사용률이 발동 임계를 넘으면 위 idle 임계를 기다리지 않고, 실제 점유(RSS)가 큰 세션부터 걷어 임계 밑으로 내려가면 멈춥니다 — 필요한 만큼만 회수합니다.' }),
        el('p', { class: 'admin-hint' }, ...uiText('왜 필요한가: 이 자리를 종전엔 earlyoom 이 맡았는데, 그건 예고도 복원 신호도 없는 강제 종료라 사용자 눈엔 세션이 그냥 사라집니다. 게이트웨이가 먼저 개입하면 같은 메모리를 “복원 가능”한 방식으로 확보합니다. 0=끔(기본). 평시 회수를 꺼 둔 채(위 0) 이것만 켜도 됩니다. 제안: 경보 경고(85)와 위험(95) 사이 — 90 · 압박 하한 60분.')),
        el('div', { class: 'storage-actions' }, pressureBtn)),

      // ── 위탁 작업 무응답 상한(#1101) — 세션 회수와 같은 결(언제 끊을지)이라 같은 섹션에 둔다. ──
      el('div', { class: 'storage-block' },
        el('strong', { text: '위탁 작업 무응답 상한' }),
        ...(srcHint(st.delegate_policy_source) ? [srcHint(st.delegate_policy_source)] : []),
        el('div', { class: 'storage-fields' },
          el('label', {}, el('span', { text: '이 시간 무응답이면 실패 처리' }), stallSel)),
        el('p', { class: 'storage-calc', text: '위탁한 작업이 시작된 뒤 이 시간 동안 출력을 한 줄도 내지 않으면 멈춘 것으로 보고 실패로 끝냅니다. 왜 멈췄는지 짐작되는 원인도 함께 남깁니다.' }),
        el('p', { class: 'admin-hint' }, ...uiText('가장 흔한 원인은 의뢰자의 Claude 토큰이 없거나 만료된 경우입니다(그러면 작업이 오류도 없이 멈춰 섭니다). 이 상한이 없으면 작업 제한시간(기본 1시간)까지 아무 단서 없이 매달립니다. 정상 작업은 시작하자마자 출력을 내므로 5분이면 넉넉합니다 — 레포 준비가 오래 걸리는 박스라면 늘려 잡으세요.')),
        el('div', { class: 'storage-actions' }, stallBtn)),
    );

    // ── [PTY 슬롯] 탭(#687 후속) — 메모리 탭과 동형(지금 상태 게이지 + 경보 임계). ──
    const ptyTab = (host: any) => host.replaceChildren(
      el('h3', { class: 'storage-h', text: '지금 상태' }),
      ...(ptyBlock
        ? [el('div', { class: 'storage-block' }, ptyBlock,
          el('p', { class: 'admin-hint' }, ...uiText('웹터미널 탭 하나가 PTY 1개를 씁니다. 게이지는 시스템 전체 포화도(tmux 세션·ssh·멤버 세션 포함)이고, 누수 판정은 그것과 별개로 이 게이트웨이의 장부와 실제(열린 PTY fd · 살아있는 attach 프로세스)를 대조해서 합니다 — 그래서 박스 규모와 무관하게 0이 정상입니다. 누수가 잡히면 게이트웨이 재시작이 즉시 전부 회수합니다(머신 재부팅 불필요, tmux 세션도 안 죽습니다).')))]
        : [el('div', { class: 'storage-block' }, el('p', { class: 'admin-hint' }, ...uiText('이 플랫폼에서는 PTY 사용량을 읽지 못합니다 — 경보 감시도 건너뜁니다.')))]),

      el('h3', { class: 'storage-h', text: 'PTY 경보' }),
      el('div', { class: 'storage-block' },
        el('strong', { text: 'PTY 경보 임계' }),
        el('div', { class: 'storage-fields' },
          el('label', {}, el('span', { text: '경고 임계(사용%, 0=끔)' }), ptyWarnIn),
          el('label', {}, el('span', { text: '위험 임계(사용%, 0=끔)' }), ptyCritIn)),
        el('p', { class: 'storage-calc', text: 'PTY 사용%가 이 값을 넘으면 경보 웹훅으로 알립니다. 디스크·메모리와 달리 기본으로 켜 둡니다(70/85) — 고갈되면 웹터미널뿐 아니라 ssh 접속까지 막혀 원격으로 고칠 수 없게 되기 때문입니다.' }),
        el('p', { class: 'admin-hint' }, ...uiText('경보를 받을 웹훅 채널은 [경보 알림] 탭에서 설정합니다(디스크·DB·메모리·PTY 공용).')),
        el('div', { class: 'storage-actions' }, ptyAlertBtn)),
    );

    const storageTab = (host: any) => {
      host.replaceChildren(
        ...(banner ? [banner] : []),
        el('h3', { class: 'storage-h', text: '지금 상태' }),
        el('div', { class: 'storage-block' }, ...diskRows),

        el('h3', { class: 'storage-h', text: '정책' }),
        ...(srcNote ? [srcNote] : []),
        el('div', { class: 'storage-block' },
          el('strong', { text: '디스크 경고' }),
          el('div', { class: 'storage-fields' },
            el('label', {}, el('span', { text: '경고 임계(%)' }), warnIn),
            el('label', {}, el('span', { text: '위험 임계(%)' }), critIn)),
          el('p', { class: 'storage-calc', text: '경고 → /readyz 가 degraded 로 알립니다(서비스는 정상 동작). 위험 → 신규 세션·클론을 막습니다.' }),
          el('p', { class: 'admin-hint' }, ...uiText('경고 임계는 위험 임계보다 낮아야 합니다.'))),
        el('div', { class: 'storage-block' },
          el('strong', { text: '공유 빌드 캐시' }),
          el('label', { class: 'storage-toggle' }, cacheChk,
            el('span', { text: ' 의존성 캐시를 서버의 공유 위치 한 곳에 모읍니다 (권장)' })),
          cacheState,
          el('p', { class: 'admin-hint' }, ...uiText('npm·pnpm·pip·uv·Go·Maven·Yarn·NuGet·Composer 의 다운로드 캐시를 세션마다 따로 받지 않고 공유합니다. 빌드가 빨라지고, 나중에 프로젝트의 빌드 산출물을 정리해도 금방 복구됩니다. 새로 만드는 세션부터 적용됩니다.')),
          el('label', { class: 'storage-toggle' }, homeChk,
            el('span', { text: ' Gradle · Cargo 홈까지 공유 (주의)' })),
          el('p', { class: 'admin-hint storage-warn' }, ...uiText('⚠ 이 옵션을 켜면 캐시뿐 아니라 설정·자격증명도 공유 위치로 옮겨갑니다 — ~/.gradle/gradle.properties(서명키·저장소 인증)와 ~/.cargo/credentials.toml(레지스트리 토큰)이 무시됩니다. 그 파일에 의존하는 빌드가 실패할 수 있으니, 해당 파일을 쓰지 않는 것이 확실할 때만 켜세요.')),
          el('div', { class: 'storage-actions' }, saveBtn)),

        el('h3', { class: 'storage-h', text: '워크스페이스' }),
        wsRegion,
      );
      loadWorkspace();
    };

    // ── [경보 알림] 탭 — 이 채널은 디스크·DB·메모리·PTY 가 **공용으로 쓴다.** 특정 자원 탭(저장소) 밑에 두면
    //  "저장소 경보만 설정하는 곳"으로 읽혀서, 메모리·PTY 임계를 켜 둔 사람이 채널이 없는 줄 모르고 지나친다.
    //  대등한 탭으로 뺀다.
    const alertTab = (host: any) => {
      host.replaceChildren(
        el('h3', { class: 'storage-h', text: '경보 알림' }),
        el('p', { class: 'admin-hint' }, ...uiText('디스크 · DB · 메모리 · PTY 슬롯 경보가 모두 이 채널로 나갑니다. 각 임계는 해당 탭에서 정합니다.')),
        alertRegion,
      );
      loadAlert();
    };

    body.replaceChildren(segTabs('storage', [
      { key: 'memory', label: '메모리', render: memoryTab },
      { key: 'pty', label: 'PTY 슬롯', render: ptyTab },
      { key: 'storage', label: '저장소', render: storageTab },
      { key: 'alert', label: '경보 알림', render: alertTab },
    ]));
  }

  // ── 경보 알림(#813) ──
  // 2026-07-13 사고의 본질은 "디스크가 찼다"가 아니라 **"아무도 몰랐다"** 였다. 가드가 있어도 사람에게 닿지 않으면
  //  똑같이 늦게 발견된다. 이 화면은 그 마지막 구멍을 막는다.
  // ⚠ 웹훅 URL 은 시크릿이라 서버가 값을 돌려주지 않는다 → 레포 관례대로 항상 빈칸 + '설정됨' 표시 + 빈 제출=미변경.
  const alertRegion = el('div');
  let alertPolicy: any = {};
  async function loadAlert() {
    busy(alertRegion, el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));
    let a;
    try { a = await api('/api/ui/org/alert'); }
    catch (e: any) { alertRegion.replaceChildren(el('p', { class: 'admin-hint', text: '불러오지 못했습니다: ' + e.message })); return; }

    const urlIn = secretInput({    // 시크릿이지만 계정 비밀번호는 아니다 — type=password 금지(#1250)
      class: 'input', value: '',
      placeholder: a.configured ? '● 설정됨 — 변경할 때만 입력' : 'https://hooks.slack.com/services/…  (슬랙·디스코드 웹훅 또는 임의 JSON 웹훅)',
    });
    urlIn.disabled = !canEdit || !a.encryption_ready;

    const minSel = el('select', { class: 'input' },
      el('option', { value: 'warn', text: `경고부터 (경고 임계 ${alertPolicy.disk_warn_pct ?? 85}% 도달 시 알림)` }),
      el('option', { value: 'critical', text: `위험만 (위험 임계 ${alertPolicy.disk_critical_pct ?? 95}% 도달·DB 연결 불가 시 알림)` }));
    minSel.value = a.min_severity || 'warn';
    minSel.disabled = !canEdit;

    const labelIn = el('input', { class: 'input', type: 'text', placeholder: '예: #ops' });
    labelIn.value = a.label || ''; labelIn.disabled = !canEdit;

    const saveA = el('button', { class: 'btn btn-primary btn-sm', text: a.configured ? '설정 저장' : '웹훅 등록' });
    saveA.disabled = !canEdit || !a.encryption_ready;
    saveA.addEventListener('click', async () => {
      saveA.disabled = true;
      try {
        await api('/api/ui/org/alert', {
          method: 'POST',
          body: JSON.stringify({ url: urlIn.value, min_severity: minSel.value, label: labelIn.value }),
        });
        toast('저장됨 — [테스트 전송]으로 실제로 닿는지 꼭 확인하세요.');
        loadAlert();
      } catch (e: any) { toast(e.message, true); saveA.disabled = false; }
    });

    // 테스트 전송 — 이게 없으면 "저장은 됐는데 정작 장애 때 안 오는" 상황을 못 잡는다(오타·만료·권한).
    const testA = el('button', { class: 'btn btn-sm', text: '테스트 전송' });
    testA.disabled = !canEdit || !a.configured;
    testA.addEventListener('click', async () => {
      testA.disabled = true; testA.textContent = '보내는 중…';
      try {
        await api('/api/ui/org/alert/test', { method: 'POST', body: JSON.stringify({}) });
        toast('보냈습니다 — 채널에 도착했는지 확인하세요.');
      } catch (e: any) { toast(e.message, true); }
      testA.disabled = false; testA.textContent = '테스트 전송';
    });

    const delA = el('button', { class: 'btn btn-sm btn-danger', text: '해제' });
    delA.disabled = !canEdit || !a.configured;
    delA.addEventListener('click', async () => {
      if (!confirm('경보 웹훅을 해제합니다. 디스크가 위험해져도 알림이 오지 않습니다. 계속할까요?')) return;
      delA.disabled = true;
      try { await api('/api/ui/org/alert/delete', { method: 'POST', body: JSON.stringify({}) }); toast('해제됨'); loadAlert(); }
      catch (e: any) { toast(e.message, true); delA.disabled = false; }
    });

    const status = a.configured
      ? el('p', { class: 'storage-calc', text: `설정됨${a.label ? ' · ' + a.label : ''} — 상태가 바뀔 때만 알립니다(같은 상태를 반복 발송하지 않습니다). 복구되면 해제 알림도 갑니다.` })
      : el('p', { class: 'storage-calc storage-warn', text: '⚠ 미설정 — 디스크가 위험 단계에 들어가거나 DB가 중단되어도 알림이 전송되지 않습니다(로그와 이 화면에서만 확인할 수 있습니다).' });

    const keyNote = a.encryption_ready ? null
      : el('p', { class: 'admin-hint storage-warn' }, ...uiText('⚠ 시크릿 암호화 키(CONNECTOR_SECRET_KEY)가 설정되지 않아 웹훅을 저장할 수 없습니다. 웹훅 주소는 그 URL만 알면 누구나 글을 쓸 수 있어 평문으로 저장하지 않습니다.'));

    alertRegion.replaceChildren(
      el('div', { class: 'storage-block' },
        status,
        ...(keyNote ? [keyNote] : []),
        el('div', { class: 'storage-fields' },
          el('label', { style: 'flex:1 1 320px' }, el('span', { text: '웹훅 주소' }), secretRow(urlIn)),
          el('label', {}, el('span', { text: '알림 기준' }), minSel),
          el('label', {}, el('span', { text: '이름(선택)' }), labelIn)),
        el('p', { class: 'admin-hint' }, ...uiText('슬랙·디스코드의 incoming webhook 주소를 그대로 넣으면 됩니다. 전송되는 알림: 디스크 경고/위험 진입, DB 연결 불가, 그리고 각각의 복구. 저장된 주소는 암호화되어 다시 표시되지 않습니다(변경할 때만 다시 입력).')),
        el('div', { class: 'ws-actions' }, a.configured ? el('span', {}, testA, ' ', delA) : el('span', {}), saveA)),
    );
  }

  // ── 워크스페이스(#813 T3-2 백스톱) ──
  // 프로젝트 마무리 루틴이 정리를 하지만 그건 best-effort 다 — 에이전트가 건너뛰거나, 사람이 웹UI 에서 바로 done
  //  처리하거나, 프로젝트가 방치되면 아무도 안 치운다. 여기서 관리자가 보고 **직접** 정리한다.
  //  ⚠ 자동 삭제는 없다. 반드시 [분석](dry-run) → 내용 확인 → [정리] 순서로만 지워진다.
  // ── 워크스페이스 정리 (reclaim — #813 백스톱 · #845 UX 수정) ────────────────────
  //  화면에선 '회수'라 부르지 않는다(#859) — 되돌릴 수 없는 접속 해제·재부여 가능한 권한 해제·아무것도
  //  안 지우는 지식 검색이 전부 '회수'라 불려 파괴성이 안 읽혔다. 여기는 재생성 가능한 파생물만 지운다.
  //  #845 전에는 **목록의 78% 가 눌러봐야 에러**였다(307개 중 레포 없는 껍데기 184 + 고아 57).
  //  그래서 세 가지를 지킨다:
  //   ① **못 하는 일에 버튼을 주지 않는다** — 레포 없는 폴더는 접어두고 [분석] 버튼 자체를 안 만든다.
  //   ② **일괄** — 8GB 가 어디 있는지 알려고 123번 클릭하게 두지 않는다.
  //   ③ **청크로 끊어 부른다** — 한 요청에 전부 넣으면 du 가 수십 초를 먹고 프록시가 504 로 끊는다(#600).
  const wsRegion = el('div');
  // ⚠ 키는 **folder** 다(project_id 아님). 폴더명이 숫자가 아닌 옛 규칙(project/<프로젝트 이름>)이 74개 있고,
  //  그중 12개는 지금도 살아있는 프로젝트다 — id 로 키를 잡으면 이것들이 화면에서 통째로 사라진다.
  const analyzed = new Map<string, any>(); // folder → 분석 결과(dry-run). 정리는 여기 담긴 것만 대상으로 한다.
  const selected = new Set<string>();
  // 워크트리까지 제거할 폴더 — 파생물 선택(selected)과 **별도**다.
  //  ⚠ 절대 자동으로 켜지 않는다(전체 분석에서도). 워크트리는 보존 자산이고, 제거는 사람의 명시 승인으로만 한다.
  //   서버는 remove_worktree=true 를 받아도 푸시 완료·클린·세션 없음을 실행 직전에 다시 확인하고 아니면 남긴다.
  const wtSelected = new Set<string>();
  let wsList: any = null;

  const ANALYZE_CHUNK = 10; // 요청당 프로젝트 수 — du 비용이 크므로 작게. 서버 상한은 40.

  async function runBatch(path: string, folders: string[], body: any, onProgress: (done: number) => void) {
    const out: any[] = [];
    for (let i = 0; i < folders.length; i += ANALYZE_CHUNK) {
      const part = folders.slice(i, i + ANALYZE_CHUNK);
      const res = await api(path, { method: 'POST', body: JSON.stringify({ ...body, folders: part }) });
      out.push(...(res.projects || []));
      onProgress(Math.min(i + ANALYZE_CHUNK, folders.length));
    }
    return out;
  }

  async function loadWorkspace() {
    wsRegion.replaceChildren(el('p', { class: 'admin-hint' }, ...uiText('워크스페이스 계산 중… (프로젝트가 많으면 몇 초 걸립니다)')));
    analyzed.clear(); selected.clear(); wtSelected.clear();
    try { wsList = await api('/api/ui/org/workspace'); }
    catch (e: any) { wsRegion.replaceChildren(el('p', { class: 'admin-hint', text: '불러오지 못했습니다: ' + e.message })); return; }
    renderWorkspace();
  }

  function renderWorkspace() {
    const all = (wsList.projects || []).filter((p) => p.folder);
    // 레포(워크트리)가 있는 것만 정리 대상 — 나머지는 '정리할 것이 없는' 정상 폴더다(에러가 아니다).
    const targets = all.filter((p) => p.repos > 0);
    const empties = all.filter((p) => !p.repos);
    const emptyBytes = empties.reduce((s, p) => s + (p.bytes ?? 0), 0);

    // 이 프로젝트의 워크트리 중 하나라도 작업 중인 세션이 붙어 있나 — 붙어 있으면 정리 대상으로 고르지 않는다.
    const hasActive = (pr) => (pr.results || []).some((r) => r.active_session);

    // ── 상단: 일괄 분석 ──
    const progress = el('span', { class: 'storage-calc', text: '' });
    const analyzeAllBtn = el('button', { class: 'btn btn-sm', text: `전체 분석 (${targets.length}개)` });
    analyzeAllBtn.disabled = !canEdit || !targets.length;
    analyzeAllBtn.addEventListener('click', async () => {
      analyzeAllBtn.disabled = true;
      const folders = targets.map((p) => p.folder);
      try {
        const res = await runBatch('/api/ui/org/workspace/analyze', folders, {},
          (done) => { progress.textContent = `  분석 중… ${done}/${folders.length}`; });
        for (const pr of res) if (pr.folder) analyzed.set(pr.folder, pr);
        // 정리할 게 있는 것만 미리 골라둔다 — 관리자가 끄는 게 하나씩 켜는 것보다 빠르다.
        // 작업 중인 세션이 붙은 건 **켜지 않는다**(서버도 거부하지만, 애초에 고르지 않는 게 정직하다).
        for (const pr of res) if (pr.reclaimable_bytes > 0 && !hasActive(pr)) selected.add(pr.folder);
        renderWorkspace();
      } catch (e: any) { toast(e.message, true); analyzeAllBtn.disabled = false; progress.textContent = ''; }
    });

    // ── 상단: 선택 정리 ──
    //  두 갈래를 한 버튼으로 처리한다 — 파생물만 지울 폴더와, 워크트리까지 지울 폴더.
    //  ⚠ remove_worktree 는 **요청 단위** 플래그라 한 배치에 섞을 수 없다 → 두 번 나눠 부른다.
    const { selFolders, wtFolders, actFolders, derivedOnly, selBytes } =
      planReclaimBatches(selected, wtSelected, analyzed);

    const btnLabel = wtFolders.length
      ? `선택 정리 (${actFolders.length}개 · 파생물 ${fmtBytes(selBytes)} + 워크트리 ${wtFolders.length}개)`
      : `선택 정리 (${selFolders.length}개 · ${fmtBytes(selBytes)})`;
    const reclaimSelBtn = el('button', { class: 'btn btn-primary btn-sm', text: btnLabel });
    reclaimSelBtn.disabled = !canEdit || !actFolders.length;
    reclaimSelBtn.addEventListener('click', async () => {
      const wtNames = wtFolders.map((f) => analyzed.get(f)?.name || f);
      const msg = [
        `${actFolders.length}개 프로젝트에서 파생물 ${fmtBytes(selBytes)} 를 지웁니다.`,
        '',
        'node_modules·빌드 산출물 등 다시 만들 수 있는 것만 지웁니다. 소스·커밋·.env·data/ 는 건드리지 않습니다.',
        ...(wtFolders.length ? [
          '',
          `⚠ 아래 ${wtFolders.length}개는 워크트리(체크아웃 폴더)까지 지웁니다:`,
          wtNames.map((n) => `  · ${n}`).join('\n'),
          '',
          '커밋은 원격에 다 올라가 있어 provision 으로 되살릴 수 있습니다. 원격에 없는 커밋이나 미커밋 변경이',
          '남아 있으면 서버가 그 폴더의 워크트리를 남깁니다.',
        ] : ['', '워크트리는 유지합니다.']),
        '',
        '계속할까요?',
      ].join('\n');
      if (!confirm(msg)) return;
      reclaimSelBtn.disabled = true;
      try {
        const res: any[] = [];
        let done = 0;
        const tick = () => { progress.textContent = `  정리 중… ${done}/${actFolders.length}`; };
        // ① 파생물만
        if (derivedOnly.length) {
          res.push(...await runBatch('/api/ui/org/workspace/reclaim', derivedOnly, { remove_worktree: false },
            (n) => { done = n; tick(); }));
        }
        // ② 워크트리까지 — 서버가 실행 직전에 재검사하고, 거부되면 사유를 담아 돌려준다.
        if (wtFolders.length) {
          const base = derivedOnly.length;
          res.push(...await runBatch('/api/ui/org/workspace/reclaim', wtFolders, { remove_worktree: true },
            (n) => { done = base + n; tick(); }));
        }
        const freed = res.reduce((s, pr) => s + (pr.freed_bytes || 0), 0);
        const applied = res.flatMap((pr) => (pr.results || []).map((r) => r.applied)).filter(Boolean);
        const wtDone = applied.filter((a) => a.worktreeRemoved).length;
        // 옵트인했는데 서버가 남긴 것 — 조용히 넘기지 않는다(왜 안 지워졌는지가 사용자가 알아야 할 정보다).
        const wtKept = applied.map((a) => a.worktreeSkippedReason).filter(Boolean);
        toast(`정리 완료 — ${fmtBytes(freed)} 확보 (${res.length}개 프로젝트)${wtDone ? ` · 워크트리 ${wtDone}개 제거` : ''}`);
        if (wtKept.length) toast(`워크트리 ${wtKept.length}개는 남았습니다 — ${wtKept[0]}`, true);
        loadWorkspace();
      } catch (e: any) { toast(e.message, true); reclaimSelBtn.disabled = false; progress.textContent = ''; }
    });

    // ── 정리 대상 행 ──
    const rows = targets.map((p) => {
      const pr = analyzed.get(p.folder);
      const detail = el('div');
      const right: any[] = [];

      if (p.active_session) right.push(el('span', { class: 'storage-lv storage-lv-warn', text: '작업 중' }));
      if (p.orphan) right.push(el('span', { class: 'storage-lv storage-lv-warn', text: '고아' }));
      if (p.kind === 'archived') right.push(el('span', { class: 'storage-lv storage-lv-ok', text: '완료 보관' }));

      let head: any;
      if (!pr) {
        const btn = el('button', { class: 'btn btn-sm', text: '분석' });
        btn.disabled = !canEdit;
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          detail.replaceChildren(el('p', { class: 'storage-calc', text: '확인 중…' }));
          try {
            const res = await api('/api/ui/org/workspace/analyze', { method: 'POST', body: JSON.stringify({ folders: [p.folder] }) });
            const one = (res.projects || [])[0];
            if (one) analyzed.set(p.folder, one);
            if (one?.reclaimable_bytes > 0 && !hasActive(one)) selected.add(p.folder);
            renderWorkspace();
          } catch (e: any) {
            detail.replaceChildren(el('p', { class: 'storage-calc', text: '실패: ' + e.message }));
            btn.disabled = false;
          }
        });
        right.push(btn);
        head = el('span', { class: 'storage-calc', text: `  ${fmtBytes(p.bytes ?? 0)} · ${p.last_used ? relTime(p.last_used * 1000) : '—'}` });
      } else {
        const chk = el('input', { type: 'checkbox' }) as HTMLInputElement;
        chk.checked = selected.has(p.folder);
        chk.disabled = !canEdit || !(pr.reclaimable_bytes > 0) || hasActive(pr);
        chk.addEventListener('change', () => {
          if (chk.checked) selected.add(p.folder); else selected.delete(p.folder);
          renderWorkspace(); // 상단 [선택 정리] 합계를 다시 그린다
        });
        right.unshift(chk);

        // 워크트리 옵트인 — **제거 가능으로 판정된 폴더에만** 내준다. 기본은 꺼짐(자동 선택 없음).
        if (wtRemovable(pr)) {
          const wtChk = el('input', { type: 'checkbox', title: '워크트리(체크아웃 폴더)까지 제거' }) as HTMLInputElement;
          wtChk.checked = wtSelected.has(p.folder);
          wtChk.disabled = !canEdit;
          wtChk.addEventListener('change', () => {
            if (wtChk.checked) wtSelected.add(p.folder); else wtSelected.delete(p.folder);
            renderWorkspace(); // 상단 버튼 라벨·합계를 다시 그린다
          });
          right.unshift(el('label', { class: 'ws-wt-opt', title: '워크트리(체크아웃 폴더)까지 제거 — 푸시 완료·변경 없음으로 확인된 것만' },
            wtChk, el('span', { text: '워크트리' })));
        }

        head = el('span', { class: 'storage-calc', text: `  ${fmtBytes(p.bytes ?? 0)} · 정리 가능 ${fmtBytes(pr.reclaimable_bytes || 0)}` });

        for (const r of pr.results || []) {
          const derived = r.derived || [];
          detail.append(el('div', { class: 'ws-plan' },
            el('p', { class: 'storage-calc', text: `${derived.map((d) => d.path + ' ' + fmtBytes(d.bytes)).join(' · ') || '정리할 파생물 없음'}` }),
            el('p', { class: 'storage-calc', text: r.worktree_removable
              ? (wtSelected.has(p.folder)
                ? '워크트리: 제거합니다(푸시 완료·변경 없음) — provision 으로 되살릴 수 있습니다'
                : '워크트리: 제거 가능(푸시 완료·변경 없음) — 지우려면 [워크트리] 를 켜세요')
              : `워크트리: 유지 — ${r.worktree_reason}` })));
        }
      }

      return el('div', { class: 'storage-item' },
        el('div', { class: 'storage-head' },
          el('span', {}, el('strong', { text: p.name || p.folder }), head),
          el('span', { class: 'ws-badges' }, ...right)),
        detail);
    });

    // ── 레포 없는 폴더: 접어두고 버튼도 주지 않는다 ──
    const emptyBox = el('div');
    const emptyToggle = el('button', { class: 'btn btn-ghost btn-sm', text: `레포 없는 폴더 ${empties.length}개 보기 (${fmtBytes(emptyBytes)})` });
    let emptyOpen = false;
    emptyToggle.addEventListener('click', () => {
      emptyOpen = !emptyOpen;
      emptyToggle.textContent = emptyOpen ? `레포 없는 폴더 접기` : `레포 없는 폴더 ${empties.length}개 보기 (${fmtBytes(emptyBytes)})`;
      emptyBox.replaceChildren(...(emptyOpen ? empties.map((p) => el('div', { class: 'storage-item' },
        el('div', { class: 'storage-head' },
          el('span', {}, el('strong', { text: p.name || p.folder }),
            el('span', { class: 'storage-calc', text: `  ${fmtBytes(p.bytes ?? 0)} · ${p.last_used ? relTime(p.last_used * 1000) : '—'}` })),
          el('span', { class: 'ws-badges' }, ...(p.orphan ? [el('span', { class: 'storage-lv storage-lv-warn', text: '고아' })] : []))))) : []));
    });

    wsRegion.replaceChildren(
      el('p', { class: 'storage-calc', text: `${all.length}개 폴더 · 합계 ${fmtBytes(wsList.total_bytes)} — ${wsList.root}` }),
      el('div', { class: 'ws-actions' }, analyzeAllBtn, reclaimSelBtn, progress),
      el('p', { class: 'admin-hint' }, ...uiText('[전체 분석]은 아무것도 지우지 않습니다 — 무엇을 정리할 수 있는지만 계산합니다. 정리 대상은 다시 만들 수 있는 것뿐입니다(node_modules·빌드 산출물 등). 소스·커밋·설정(.env)·데이터는 절대 지우지 않고, 워크트리도 유지합니다. 작업 중인 세션이 있는 프로젝트는 선택되지 않습니다.')),
      ...(rows.length ? rows : [el('p', { class: 'admin-hint' }, ...uiText('정리할 워크트리가 있는 프로젝트가 없습니다.'))]),
      ...(empties.length ? [
        el('p', { class: 'admin-hint', text: `아래는 git 레포(워크트리)가 없는 폴더입니다 — 정리할 파생물이 없어 정상이며, 지울 것도 없습니다(대부분 12KB 안팎).` }),
        emptyToggle, emptyBox,
      ] : []));
  }

  load();
}

export {
  storageEditor,
};
