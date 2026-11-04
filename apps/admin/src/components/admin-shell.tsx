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
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import { fetchInquiries } from "@/lib/inquiries";
import {
  receivedCountKnown,
  setReceivedCount,
  useReceivedCount,
} from "@/lib/inquiry-badge";
import { fill, messages } from "@/lib/messages";
import { roleLabel } from "@/lib/roles";
import { SessionGuard, SessionNotices } from "./session-guard";

// 운영자 화면 공통 틀 (BRD-171, 화면 설계서 6장 '공통 틀', 캔버스 4차 V24)
// - PC(1024px 이상): 왼쪽 메뉴 232px 고정
// - 태블릿(768~1023px): 아이콘 레일 72px. 포커스·마우스 올림 때 이름 말풍선(useRailTip), 펼치기 버튼으로 이름까지 보임
// - 모바일(767px 이하): 위 앱 바(메뉴 · 화면 이름 · 계정) + 왼쪽 서랍(포커스 가둠, Esc·바깥 누르기로 닫음, 배경 스크롤 잠금)
// 지금 화면은 강조 + aria-current="page". 판단 상태를 바꾸는 메뉴는 없음(G1)

const t = messages.nav;

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

const GROUPS: readonly { label: string | null; items: readonly NavItem[] }[] = [
  { label: null, items: [{ href: "/", label: t.home, icon: House }] },
  {
    label: t.groupStatus,
    items: [
      { href: "/stats/", label: t.stats, icon: BarChart3 },
      { href: "/collection/", label: t.collection, icon: Activity },
    ],
  },
  {
    label: t.groupData,
    items: [
      { href: "/sources/", label: t.sources, icon: Database },
      { href: "/beaches/", label: t.beaches, icon: Waves },
      { href: "/publish/", label: t.publish, icon: Upload },
    ],
  },
  {
    label: t.groupOps,
    items: [
      { href: "/notices/", label: t.notices, icon: Megaphone },
      { href: "/inquiries/", label: t.inquiries, icon: MessageSquare },
      { href: "/policies/", label: t.policies, icon: FileText },
      { href: "/audit/", label: t.audit, icon: History },
    ],
  },
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
  const received = useReceivedCount();
  return (
    <nav aria-label={t.label} className="flex flex-col gap-4">
      {GROUPS.map((group, i) => (
        <div key={group.label ?? i} className="flex flex-col gap-0.5">
          {group.label && (
            <p
              className={`px-2 pb-1 text-caption font-medium text-text-muted ${compact ? "sr-only" : ""}`}
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
                className={`relative flex min-h-touch items-center gap-2.5 rounded-admin-control px-2 text-body whitespace-nowrap hover:bg-bg-page lg:min-h-admin-control ${
                  compact ? "justify-center" : ""
                } ${
                  // 지금 화면: 시안처럼 배경 없이 파란 글자·아이콘. 색만으로 구분하지 않게 굵기도 바꿈(aria-current도 둠)
                  current
                    ? "font-semibold text-brand-default"
                    : "font-medium text-text-body"
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
                    className={`min-w-5 rounded-full bg-brand-default px-1.5 text-center text-caption font-semibold text-brand-on tabular-nums ${
                      // 레일: 아이콘 오른쪽 위(항목이 기준 위치)
                      compact ? "absolute top-0.5 right-0.5" : "ml-auto"
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
  const signedIn = snapshot.status === "signed_in";
  useEffect(() => {
    if (!signedIn || receivedCountKnown()) return;
    let live = true;
    void fetchInquiries(() => session.accessToken(), { limit: 1 }).then(
      (result) => {
        if (live && result.ok && result.body.counts) {
          setReceivedCount(result.body.counts.received);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [session, signedIn]);
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
          className={`sticky top-0 hidden h-dvh shrink-0 flex-col gap-4 border-r border-border-default bg-bg-surface px-3 py-3.5 md:flex lg:w-admin-sidebar ${
            railOpen ? "md:w-admin-sidebar" : "md:w-admin-rail"
          }`}
        >
          <div className="hidden lg:block">
            <BrandLink compact={false} />
          </div>
          <div className="lg:hidden">
            <BrandLink compact={!railOpen} />
          </div>
          <div className="flex-1 overflow-y-auto" onScroll={rail.hide}>
            <div className="hidden lg:block">
              <NavList />
            </div>
            <div className="lg:hidden">
              <NavList {...(railTip ? { tip: railTip } : {})} />
            </div>
          </div>
          <div className="hidden lg:block">
            <AccountBlock />
          </div>
          <div className="lg:hidden">
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
          <RailTip tip={railOpen ? null : rail.tip} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
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
          <main id="main" tabIndex={-1} className="flex-1 outline-none">
            <SessionNotices />
            {children}
          </main>
        </div>
      </div>
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </SessionGuard>
  );
}
