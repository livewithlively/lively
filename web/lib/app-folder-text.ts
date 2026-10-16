// 앱빌더 «배포 설정» 의 앱 폴더 줄(#4785 앱 v2-20) — 순수 규칙: 서버 칸 읽기 · 줄 문장 · 입력 검사 · 저장 알림 글.
//  화면(web/v2/builder.ts folderRow)이 그리고, scripts/app-folder-text.test.mjs 가 상태 조합을 본다.
//  서버 칸은 apps/app-folder-quota.folderFields — 원하는 상한 · 걸린 상한 · 쓰는 양 · 잰 때 · 낡았나 · 단계 · 바꿀 수 있나 · 거나.

/** 앱 폴더 상한의 최댓값(GiB) — 서버 apps/app-folder-quota.APP_FOLDER_LIMIT_MAX_GB · CP appfolderquota 와 같은 자. */
export const FOLDER_LIMIT_MAX_GB = 1000;

export interface FolderView {
  /** 원하는 상한(GiB, null = 없음). */
  limitGb: number | null;
  /** 매니지드 쿼터 정비가 잰 쓰는 양(null = 아직 안 잼). */
  usedBytes: number | null;
  /** 잰 때 걸려 있던 상한(GiB, null = 없음). */
  appliedGb: number | null;
  /** 잰 때(ms, 0 = 모름). */
  measuredAt: number;
  /** 서버 시계로 30분보다 오래된 값인가 — 정비가 멎었을 수 있다. */
  stale: boolean;
  /** 단계 0 · 80 · 100(걸린 상한 기준). */
  level: number;
  canSet: boolean;
  /** 이 워크스페이스가 상한을 거나(매니지드만). */
  enforced: boolean;
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 서버 칸(folder) → 화면 값. 모르는 모양이면 «안 잼 · 셀프호스트» 쪽으로 읽힌다. */
export function folderView(f: any): FolderView {
  const t = Date.parse(String((f && f.measured_at) || ''));
  return {
    limitGb: numOrNull(f && f.limit_gb), usedBytes: numOrNull(f && f.used_bytes), appliedGb: numOrNull(f && f.applied_limit_gb),
    measuredAt: Number.isFinite(t) ? t : 0, stale: !!(f && f.stale),
    level: Number(f && f.level) || 0, canSet: !!(f && f.can_set), enforced: !!(f && f.enforced),
  };
}

/** 1024 단위 크기 — JuiceFS 쿼터와 같은 자(GiB · MiB · KiB). */
export function sizeText(b: number): string {
  return b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + 'GiB' : b >= 1024 ** 2 ? (b / 1024 ** 2).toFixed(1) + 'MiB' : Math.round(b / 1024) + 'KiB';
}

/**
 * 줄 문장 — when 은 잰 때(ms)를 사람 말로 바꾼다(화면이 넘긴다).
 *  · 셀프호스트는 «걸리지 않는다» 만 말한다.
 *  · 낡은 값이면 단계 · «5분 안에 적용» 을 말하지 않는다 — 정비가 멎었을 수 있어 그 약속이 거짓일 수 있다.
 *  · 정한 상한과 걸린 상한이 다르면 아직 정비가 돌지 않은 것이다 — «5분 안에 적용돼요».
 */
export function folderLine(f: FolderView, when: (ms: number) => string): string {
  if (!f.enforced) return '이 워크스페이스에서는 앱 폴더 상한이 걸리지 않아요. 상한은 매니지드 워크스페이스에서만 걸려요.';
  if (f.usedBytes == null) return '쓰는 양은 아직 재지 않았어요. 5분 안에 보여요.' + (f.limitGb ? ' 상한은 ' + f.limitGb + 'GiB로 정해 두었어요.' : '');
  if (f.stale) {
    return '마지막으로 잰 때(' + when(f.measuredAt) + ') ' + sizeText(f.usedBytes) + '를 쓰고 있었어요. '
      + (f.appliedGb ? '그때 상한은 ' + f.appliedGb + 'GiB였어요.' : '그때 상한은 없었어요.');
  }
  const now = '지금 ' + sizeText(f.usedBytes) + '를 쓰고 있어요. ' + (f.appliedGb ? '상한은 ' + f.appliedGb + 'GiB예요.'
    + (f.level >= 100 ? ' 가득 차서 이 앱 폴더에 더 쓸 수 없어요.' : f.level >= 80 ? ' 상한의 80%를 넘었어요.' : '') : '상한은 없어요.');
  if ((f.limitGb ?? null) === (f.appliedGb ?? null)) return now;
  return now + (f.limitGb == null ? ' 상한을 없앤 것은 5분 안에 적용돼요.' : ' 새 상한 ' + f.limitGb + 'GiB는 5분 안에 적용돼요.');
}

/** 입력 칸 값 — 빈 값은 상한 없음(null), 1 ~ 최댓값의 정수(GiB). 틀리면 그 까닭. */
export function parseFolderInput(raw: string): { gb: number | null } | { error: string } {
  const s = String(raw ?? '').trim();
  if (s === '') return { gb: null };
  const gb = Number(s);
  if (!(Number.isInteger(gb) && gb >= 1 && gb <= FOLDER_LIMIT_MAX_GB)) {
    return { error: '상한은 1에서 ' + FOLDER_LIMIT_MAX_GB + ' 사이의 정수(GiB)로 적어 주세요. 비워 두면 상한이 없어요.' };
  }
  return { gb };
}

/** 저장 뒤 알림 글 — over = 서버가 «지금 쓰는 양이 새 상한 이상» 이라고 했다(값은 저장됐다). */
export function folderSavedText(gb: number | null, over: boolean): string {
  if (gb === null) return '앱 폴더 상한을 없앴어요. 5분 안에 적용돼요.';
  return '앱 폴더 상한을 ' + gb + 'GiB로 바꿨어요. 5분 안에 적용돼요.'
    + (over ? ' 지금 쓰는 양이 새 상한보다 많아서, 적용되면 이 앱 폴더에 더 쓸 수 없어요.' : '');
}
