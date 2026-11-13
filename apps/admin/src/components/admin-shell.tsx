"use client";

import {
  Activity,
  BarChart3,
  ChevronsLeft,
  ChevronsRight,
  Database,
  FileText,
  History,
  House,
  LogOut,
  Megaphone,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Search,
  Upload,
  UserRound,
  Waves,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import { fetchInquiries } from "@/lib/inquiries";
import {
  badgeOwner,
  receivedCountKnown,
  setReceivedCount,
  useReceivedCount,
} from "@/lib/inquiry-badge";
import { fill, messages } from "@/lib/messages";
import { roleLabel } from "@/lib/roles";
import { useShellStatus, type ShellStatus } from "@/lib/shell-status";
import { CommandPalette } from "./command-palette";
import { SessionGuard, SessionNotices } from "./session-guard";

// 운영자 화면 공통 틀 (BRD-171, 화면 설계서 6장 '공통 틀', 캔버스 4차 V24)
// - PC(1024px 이상): 왼쪽 메뉴 220px 고정(GH-450, 시안 4차 V1 aside)
//   작업 공간 상자 · ⌘K 찾기 · 메뉴(위 묶음 이름 없음 + '기록') · 아래 상태 칸 · 사용자 칸(이메일 + '…' 메뉴에 내 계정·로그아웃)
// - 태블릿(768~1023px): 아이콘 레일 72px. 포커스·마우스 올림 때 이름 말풍선(useRailTip), 펼치기 버튼으로 이름까지 보임
// - 모바일(767px 이하): 위 앱 바(메뉴 · 화면 이름 · 계정) + 왼쪽 서랍(포커스 가둠, Esc·바깥 누르기로 닫음, 배경 스크롤 잠금)
// 지금 화면은 강조 + aria-current="page". 판단 상태를 바꾸는 메뉴는 없음(G1)

const t = messages.nav;

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

// 시안 V1: 위 묶음은 이름 없이 일하는 화면, 아래 '기록' 묶음은 운영 정책·변경 이력
const GROUPS: readonly { label: string | null; items: readonly NavItem[] }[] = [
  {
    label: null,
    items: [
      { href: "/", label: t.home, icon: House },
      { href: "/stats/", label: t.stats, icon: BarChart3 },
      { href: "/collection/", label: t.collection, icon: Activity },
      { href: "/sources/", label: t.sources, icon: Database },
      { href: "/beaches/", label: t.beaches, icon: Waves },
      { href: "/publish/", label: t.publish, icon: Upload },
      { href: "/notices/", label: t.notices, icon: Megaphone },
      { href: "/inquiries/", label: t.inquiries, icon: MessageSquare },
    ],
  },
  {
    label: t.groupRecords,
    items: [
      { href: "/policies/", label: t.policies, icon: FileText },
      { href: "/audit/", label: t.audit, icon: History },
    ],
  },
];

// ⌘K 찾기 대상: 메뉴 화면 + 내 계정
const PALETTE_ITEMS = [
  ...GROUPS.flatMap((g) => g.items),
  { href: "/account/", label: t.account, icon: UserRound },
];

// 레일 말풍선: 메뉴 목록이 세로 스크롤 상자 안이라 absolute로 띄우면 레일 밖이 잘림 → 화면 기준(fixed)으로 띄움
// 마우스 올림·키보드 포커스(:focus-visible) 때만 보임. 이름은 aria-label로도 읽히므로 말풍선은 aria-hidden
interface Tip {
  readonly label: string;
  readonly top: number;
  readonly left: number;
}

type TipTarget = (label: string) => {
  onMouseEnter: (e: MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
  onFocus: (e: FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
};

function useRailTip(): {
  tip: Tip | null;
  target: TipTarget;
  hide: () => void;
} {
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (label: string, el: HTMLElement) => {
    // 세로는 그 항목 가운데, 가로는 레일 오른쪽 가장자리 바깥
    const r = el.getBoundingClientRect();
    const edge = el.closest("aside")?.getBoundingClientRect().right ?? r.right;
    setTip({ label, top: r.top + r.height / 2, left: edge + 8 });
  };
  const hide = () => setTip(null);
  return {
    tip,
    hide,
    target: (label) => ({
      onMouseEnter: (e) => show(label, e.currentTarget),
      onMouseLeave: hide,
      onFocus: (e) => {
        if (e.currentTarget.matches(":focus-visible"))
          show(label, e.currentTarget);
      },
      onBlur: hide,
    }),
  };
}

function RailTip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <span
      aria-hidden="true"
      data-rail-tip=""
      style={{ top: tip.top, left: tip.left }}
      className="pointer-events-none fixed z-30 -translate-y-1/2 rounded-admin-control bg-text-default px-2 py-1 text-label-s whitespace-nowrap text-bg-surface"
    >
      {tip.label}
    </span>
  );
}

// 정적 내보내기는 trailingSlash라 주소 끝 / 를 맞춰 비교함
function isCurrent(pathname: string, href: string): boolean {
  const path = pathname.endsWith("/") ? pathname : `${pathname}/`;
  return href === "/" ? path === "/" : path.startsWith(href);
}

function NavList({
  tip,
  onNavigate,
}: {
  // 레일: 아이콘만 보이고 이름은 말풍선
  tip?: TipTarget;
  onNavigate?: () => void;
}) {
  const compact = tip !== undefined;
  const pathname = usePathname();
  const received = useReceivedCount(badgeOwner(useSessionSnapshot()));
  return (
    <nav aria-label={t.label} className="flex flex-col gap-4 lg:gap-5">
      {GROUPS.map((group, i) => (
        <div key={group.label ?? i} className="flex flex-col gap-0.5">
          {group.label && (
            <p
              className={`px-2 text-caption leading-6 font-medium text-text-muted ${compact ? "sr-only" : ""}`}
            >
              {group.label}
            </p>
          )}
          {group.items.map(({ href, label: name, icon: Icon }) => {
            const current = isCurrent(pathname, href);
            // '문의'에 접수 수 배지(0이면 없음). 이름에도 넣어 화면 읽기로도 들림
            const badge =
              href === "/inquiries/" && received !== null && received > 0
                ? received
                : null;
            const label =
              badge === null
                ? name
                : fill(messages.inquiries.navBadge, { count: badge });
            return (
              <Link
                key={href}
                href={href}
                {...(onNavigate ? { onClick: onNavigate } : {})}
                aria-current={current ? "page" : undefined}
                aria-label={compact || badge !== null ? label : undefined}
                {...(tip ? tip(label) : {})}
                className={`relative flex min-h-touch items-center gap-2.5 rounded-admin-control px-2 text-body font-medium whitespace-nowrap hover:bg-bg-page lg:min-h-0 lg:py-1.5 lg:leading-normal ${
                  compact ? "justify-center" : ""
                } ${
                  // 지금 화면: 시안처럼 배경·굵기 없이 파란 글자·아이콘만(GH-450). 화면 읽기는 aria-current로 앎
                  current ? "text-brand-default" : "text-text-body"
                }`}
              >
                <Icon
                  aria-hidden="true"
                  className={`size-4 shrink-0 ${current ? "text-brand-default" : "text-text-muted"}`}
                />
                {!compact && name}
                {badge !== null && (
                  <span
                    aria-hidden="true"
                    className={`text-caption tabular-nums ${
                      // 레일: 아이콘 오른쪽 위 둥근 배지(항목이 기준 위치). 펼친 메뉴: 시안처럼 파란 숫자 글자만
                      compact
                        ? "absolute top-0.5 right-0.5 min-w-5 rounded-full bg-brand-default px-1.5 text-center font-semibold text-brand-on"
                        : "ml-auto font-medium text-brand-default"
                    }`}
                  >
                    {badge}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function AccountBlock({
  tip,
  onNavigate,
}: {
  tip?: TipTarget;
  onNavigate?: () => void;
}) {
  const compact = tip !== undefined;
  const router = useRouter();
  const pathname = usePathname();
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  if (snapshot.status === "signed_out") return null;
  const role = roleLabel(snapshot.pool, snapshot.groups);
  const linkClass = `flex min-h-touch items-center gap-2.5 rounded-admin-control px-2 text-body whitespace-nowrap hover:bg-bg-page lg:min-h-admin-control ${compact ? "justify-center" : ""}`;
  // 내 계정 화면이면 메뉴 항목과 같게 파란 글자·굵게(aria-current와 함께)
  const accountCurrent = isCurrent(pathname, "/account/");
  return (
    <div className="flex flex-col gap-0.5 border-t border-border-default pt-3">
      {!compact && (
        <div className="mb-1 px-2 text-label-s leading-snug">
          <p className="truncate font-medium text-text-default">
            {snapshot.email}
          </p>
          {role && <p className="text-text-muted">{role}</p>}
        </div>
      )}
      <Link
        href="/account/"
        {...(onNavigate ? { onClick: onNavigate } : {})}
        aria-label={compact ? t.account : undefined}
        {...(tip ? tip(t.account) : {})}
        aria-current={accountCurrent ? "page" : undefined}
        className={`${linkClass} ${accountCurrent ? "font-semibold text-brand-default" : "font-medium text-text-body"}`}
      >
        <UserRound
          aria-hidden="true"
          className={`size-4 shrink-0 ${accountCurrent ? "text-brand-default" : "text-text-muted"}`}
        />
        {!compact && t.account}
      </Link>
      <button
        type="button"
        aria-label={compact ? t.logout : undefined}
        {...(tip ? tip(t.logout) : {})}
        className={`${linkClass} font-medium text-text-body`}
        onClick={() => {
          void session.logout();
          router.replace(snapshot.pool === "demo" ? "/login/demo/" : "/login/");
        }}
      >
        <LogOut
          aria-hidden="true"
          className="size-4 shrink-0 text-text-muted"
        />
        {!compact && t.logout}
      </button>
    </div>
  );
}

function BrandLink({ compact }: { compact: boolean }) {
  return (
    <Link
      href="/"
      className={`flex items-center gap-2.5 rounded-admin-control p-1 ${compact ? "justify-center" : ""}`}
      aria-label={
        compact ? `${messages.brand.name} ${messages.brand.sub}` : undefined
      }
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-admin-badge bg-brand-default text-caption font-medium text-brand-on"
      >
        {messages.brand.mark}
      </span>
      {!compact && (
        <span className="flex flex-col leading-tight whitespace-nowrap">
          <span className="text-body font-medium text-text-default">
            {messages.brand.name}
          </span>
          <span className="text-caption text-text-muted">
            {messages.brand.sub}
          </span>
        </span>
      )}
    </Link>
  );
}

// ---- PC 왼쪽 메뉴(1024px 이상, 시안 4차 V1 aside) ----

// 작업 공간 상자: 서비스 이름 + '운영 · 권한'. 바꿀 작업 공간이 없어 시안의 위아래 화살표(전환)는 두지 않음
function Workspace() {
  const snapshot = useSessionSnapshot();
  const role =
    snapshot.status === "signed_out"
      ? null
      : roleLabel(snapshot.pool, snapshot.groups);
  return (
    <Link
      href="/"
      className="flex items-center gap-2.5 rounded-admin-control border border-border-default bg-bg-surface px-2.5 py-2 shadow-card hover:bg-bg-page"
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-admin-badge bg-brand-default text-caption font-medium text-brand-on"
      >
        {messages.brand.mark}
      </span>
      {/* 시안 줄 높이 1.35(맞는 토큰 없음) */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body leading-[1.35] font-medium text-text-default">
          {messages.brand.name}
        </span>
        <span className="truncate text-caption leading-[1.35] text-text-body">
          {role
            ? fill(t.workspace, { sub: messages.brand.sub, role })
            : messages.brand.sub}
        </span>
      </span>
    </Link>
  );
}

// ⌘K 찾기 단추(시안 .w-in 34px). 누르거나 ⌘K·Ctrl+K로 찾기 창을 엶
function SearchButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K"
      className="flex h-segment w-full items-center gap-2 rounded-admin-control border border-border-strong bg-bg-surface px-2.5 text-body-s text-text-muted shadow-card hover:bg-bg-page"
    >
      <Search aria-hidden="true" className="size-[15px] shrink-0" />
      <span className="flex-1 text-left">{t.search}</span>
      <span aria-hidden="true" className="text-caption">
        {t.searchShortcut}
      </span>
    </button>
  );
}

// 빌드 때 넣은 커밋 날짜·해시(next.config env). 비어 있으면 '버전 확인 못 함'
const VERSION_DATE = process.env.ADMIN_VERSION_DATE ?? "";
const VERSION_SHA = process.env.ADMIN_VERSION_SHA ?? "";

// 상태 칸: 판단 출처 · 앱 게시본 시각 · 운영 화면 버전(시안 .w-sys)
// 점 색만으로 뜻을 나누지 않게 글자가 상태를 말함. 못 읽으면 '확인 못 함'(정상으로 두지 않음)
function StatusBlock({ status }: { status: ShellStatus }) {
  const dot =
    status.kind === "ok"
      ? "bg-success-icon"
      : status.kind === "problem"
        ? "bg-danger-text"
        : "bg-status-unknown-border";
  const head =
    status.kind === "ok"
      ? t.statusOk
      : status.kind === "problem"
        ? fill(t.statusProblem, { count: status.problems })
        : status.kind === "loading"
          ? t.statusLoading
          : t.statusUnknown;
  return (
    <div
      role="group"
      aria-label={t.statusLabel}
      className="flex flex-col gap-1 border-t border-border-default pt-3.5 text-label-s text-text-body"
    >
      <p className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${dot}`}
        />
        <span
          className={
            status.kind === "problem" ? "font-semibold text-danger-text" : ""
          }
        >
          {head}
        </span>
      </p>
      {status.kind !== "loading" && (
        <p className="text-text-muted tabular-nums">
          {status.kind !== "unknown" && status.published !== null
            ? fill(t.publishedAt, { time: status.published })
            : t.publishedUnknown}
        </p>
      )}
      <p className="text-label-xs text-text-muted tabular-nums">
        {VERSION_DATE && VERSION_SHA
          ? fill(t.version, { date: VERSION_DATE, sha: VERSION_SHA })
          : t.versionUnknown}
      </p>
    </div>
  );
}

// 사용자 칸: 아바타 + 이메일 + '…' 메뉴(내 계정·로그아웃). 이름 칸이 없어 이메일로 보임(11/13 결정)
// 메뉴는 단추 위로 펼침. Esc·바깥 누르기로 닫고, Esc면 단추로 포커스를 돌려줌
function UserRow() {
  const router = useRouter();
  const pathname = usePathname();
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  if (snapshot.status === "signed_out") return null;
  const email = snapshot.email ?? "";
  const accountCurrent = isCurrent(pathname, "/account/");
  const item =
    "flex min-h-admin-control items-center gap-2.5 rounded-admin-control px-2 text-body font-medium whitespace-nowrap hover:bg-bg-page";
  return (
    <div
      ref={box}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      {open && (
        <div
          id={menuId}
          className="absolute right-0 bottom-full left-0 z-20 mb-1 flex flex-col gap-0.5 rounded-admin-box border border-border-default bg-bg-surface p-1 shadow-floating"
        >
          <Link
            href="/account/"
            onClick={() => setOpen(false)}
            aria-current={accountCurrent ? "page" : undefined}
            className={`${item} ${accountCurrent ? "text-brand-default" : "text-text-body"}`}
          >
            <UserRound
              aria-hidden="true"
              className={`size-4 shrink-0 ${accountCurrent ? "text-brand-default" : "text-text-muted"}`}
            />
            {t.account}
          </Link>
          <button
            type="button"
            className={`${item} text-text-body`}
            onClick={() => {
              setOpen(false);
              void session.logout();
              router.replace(
                snapshot.pool === "demo" ? "/login/demo/" : "/login/",
              );
            }}
          >
            <LogOut
              aria-hidden="true"
              className="size-4 shrink-0 text-text-muted"
            />
            {t.logout}
          </button>
        </div>
      )}
      <div className="flex items-center gap-2.5 px-2 py-1.5 text-body font-medium text-text-body">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border-strong text-caption"
        >
          {email.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate" title={email}>
          {email}
        </span>
        <button
          ref={button}
          type="button"
          aria-label={t.userMenu}
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((v) => !v)}
          className="-mr-1 flex size-7 shrink-0 items-center justify-center rounded-admin-control text-text-muted hover:bg-bg-page"
        >
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </button>
      </div>
    </div>
  );
}

function DesktopSide({ onSearch }: { onSearch: () => void }) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const owner = snapshot.status === "signed_in" ? badgeOwner(snapshot) : null;
  const status = useShellStatus(owner, () => session.accessToken());
  return (
    <div className="hidden h-full flex-col gap-5 lg:flex">
      <Workspace />
      <SearchButton onOpen={onSearch} />
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        <NavList />
      </div>
      <div className="flex flex-col gap-3">
        <StatusBlock status={status} />
        <UserRow />
      </div>
    </div>
  );
}

// 모바일 서랍: <dialog>의 모달이 포커스를 가두고 Esc로 닫힘. 바깥(배경) 누르기도 닫음. 열린 동안 배경 스크롤을 잠금
function Drawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!open) {
      if (el.open) el.close();
      return;
    }
    if (!el.open) el.showModal();
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = "";
    };
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={t.label}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="m-0 h-dvh max-h-dvh w-admin-drawer max-w-[85vw] bg-bg-surface p-0 text-text-default backdrop:bg-[rgb(11_26_44/0.4)]"
    >
      <div className="flex h-full flex-col gap-4 px-3 py-3">
        <div className="flex items-center justify-between">
          <BrandLink compact={false} />
          <button
            type="button"
            onClick={onClose}
            aria-label={t.closeMenu}
            className="flex size-touch items-center justify-center rounded-admin-control hover:bg-bg-page"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <NavList onNavigate={onClose} />
        </div>
        <AccountBlock onNavigate={onClose} />
      </div>
    </dialog>
  );
}

// 처음 연 화면에서 한 번만 접수 수를 읽음(문의 목록 첫 쪽의 상태별 수). 실패하면 배지만 없음(목록 화면은 따로 실패를 알림)
function useReceivedCountOnce(): void {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const owner = snapshot.status === "signed_in" ? badgeOwner(snapshot) : null;
  useEffect(() => {
    if (owner === null || receivedCountKnown(owner)) return;
    let live = true;
    void fetchInquiries(() => session.accessToken(), { limit: 1 }).then(
      (result) => {
        if (live && result.ok && result.body.counts) {
          setReceivedCount(owner, result.body.counts.received);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [session, owner]);
}

export function AdminShell({
  title,
  children,
}: {
  // 모바일 앱 바에 보이는 화면 이름
  title: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  useReceivedCountOnce();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 태블릿 레일 펼침(이 탭 메모리만)
  const [railOpen, setRailOpen] = useState(false);
  const rail = useRailTip();
  const railTip = railOpen ? undefined : rail.target;
  const [paletteOpen, setPaletteOpen] = useState(false);
  // ⌘K·Ctrl+K: 어느 화면에서든 찾기 창을 엶(입력 중인 칸이 있어도 같음, 시안 V7)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <SessionGuard>
      <a
        href="#main"
        className="sr-only z-50 rounded-admin-control bg-bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t.skip}
      </a>
      <div className="flex min-h-dvh">
        {/* PC 메뉴 · 태블릿 레일 */}
        <aside
          className={`sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-border-default bg-bg-surface px-3 py-3.5 md:flex lg:w-admin-sidebar ${
            railOpen ? "md:w-admin-sidebar" : "md:w-admin-rail"
          }`}
        >
          <DesktopSide onSearch={() => setPaletteOpen(true)} />
          <div className="flex h-full flex-col gap-4 lg:hidden">
            <BrandLink compact={!railOpen} />
            <div className="flex-1 overflow-y-auto" onScroll={rail.hide}>
              <NavList {...(railTip ? { tip: railTip } : {})} />
            </div>
            <div>
              <AccountBlock {...(railTip ? { tip: railTip } : {})} />
              <button
                type="button"
                onClick={() => {
                  rail.hide();
                  setRailOpen((v) => !v);
                }}
                aria-label={railOpen ? t.collapse : t.expand}
                aria-expanded={railOpen}
                className="mt-1 flex min-h-touch w-full items-center justify-center rounded-admin-control text-text-muted hover:bg-bg-page"
              >
                {railOpen ? (
                  <ChevronsLeft aria-hidden="true" className="size-4" />
                ) : (
                  <ChevronsRight aria-hidden="true" className="size-4" />
                )}
              </button>
            </div>
          </div>
          <RailTip tip={railOpen ? null : rail.tip} />
        </aside>

        {/* 본문 바탕은 시안처럼 면 색(흰색, 다크는 면 색). 화면 제목(h1)은 시안 20px/600 · 줄 높이 1.4 · 자간 -0.01em
            크기·굵기는 화면의 text-title-l·font-semibold, 줄 높이·자간은 맞는 토큰이 없어 여기서 한 번에 맞춤 */}
        <div className="flex min-w-0 flex-1 flex-col bg-bg-surface">
          {/* 모바일 앱 바 */}
          <header className="sticky top-0 z-10 flex h-topbar items-center gap-1 border-b border-border-default bg-bg-surface px-2 md:hidden">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label={t.openMenu}
              aria-expanded={drawerOpen}
              className="flex size-touch items-center justify-center rounded-admin-control hover:bg-bg-page"
            >
              <Menu aria-hidden="true" className="size-5" />
            </button>
            <p className="min-w-0 flex-1 truncate text-title-card font-semibold">
              {title}
            </p>
            <Link
              href="/account/"
              aria-label={t.account}
              aria-current={
                isCurrent(pathname, "/account/") ? "page" : undefined
              }
              className="flex size-touch items-center justify-center rounded-admin-control hover:bg-bg-page"
            >
              <UserRound aria-hidden="true" className="size-5" />
            </Link>
          </header>
          <main
            id="main"
            tabIndex={-1}
            className="flex-1 outline-none [&_h1]:leading-[1.4] [&_h1]:tracking-[-0.01em]"
          >
            <SessionNotices />
            {children}
          </main>
        </div>
      </div>
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={PALETTE_ITEMS}
      />
    </SessionGuard>
  );
}
