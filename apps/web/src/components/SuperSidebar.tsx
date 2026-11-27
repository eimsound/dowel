// GitLab Super Sidebar 风格的单层上下文侧边栏：
// 顶部工具条（品牌、新建、收件箱、账户菜单、收起按钮）+ 搜索或跳转 + 上下文导航（我的工作 / 组 / 项目 / 个人设置 / 管理后台）+ 底部页脚。
import type { GroupInfo, GroupList, Me, ProjectListItem } from '@dowel/api';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Activity,
  ArrowLeft,
  Bookmark,
  Bot,
  ChevronsUpDown,
  Database,
  FolderKanban,
  Gauge,
  HelpCircle,
  Inbox,
  KeyRound,
  Layers,
  LayoutDashboard,
  Link2,
  LogOut,
  MailPlus,
  MonitorSmartphone,
  Palette,
  PanelLeftClose,
  Plus,
  ScrollText,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  UserCog,
  UserRound,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api.ts';
import { groupColor, groupInitial } from '../avatar.ts';
import { driftWarnings, useEnvs } from '../envs.ts';
import i18n, { setLang } from '../i18n.ts';
import { getRecentProjects } from '../recent-projects.ts';
import { useInboxStream, useUnread } from '../requests.ts';
import { useSignOut } from '../session.ts';
import { getScheme, type Scheme, setScheme } from '../theme.ts';
import { driftLabel } from './EnvBits.tsx';
import type { ShellPage, ShellProject } from './Shell.tsx';
import { Avatar, canHint, cx, IconButton, Menu, type MenuItem } from './ui.tsx';

export const PROJECT_NAV: { key: ShellPage; label: string; icon: typeof Workflow; section?: 'manage' }[] = [
  { key: 'overview', label: 'nav.overview', icon: LayoutDashboard },
  { key: 'model', label: 'nav.model', icon: Workflow },
  { key: 'versions', label: 'nav.versions', icon: Bookmark },
  { key: 'environments', label: 'nav.environments', icon: Database },
  { key: 'activity', label: 'nav.activity', icon: Activity },
  { key: 'members', label: 'nav.members', icon: Users, section: 'manage' },
  { key: 'settings', label: 'nav.settings', icon: Settings, section: 'manage' },
];

export const ACCOUNT_NAV = [
  { to: '/account', label: 'acc.profile', icon: UserRound },
  { to: '/account/password', label: 'acc.password', icon: KeyRound },
  { to: '/account/identities', label: 'acc.identities', icon: Link2 },
  { to: '/account/sessions', label: 'acc.sessions', icon: MonitorSmartphone },
  { to: '/account/mcp', label: 'mcp.title', icon: Bot },
  { to: '/account/preferences', label: 'acc.preferences', icon: Palette },
] as const;

export const ADMIN_NAV = [
  { to: '/admin', label: 'adm.navUsers', icon: Users },
  { to: '/admin/invites', label: 'adm.navInvites', icon: MailPlus },
  { to: '/admin/sign-in', label: 'adm.navSignIn', icon: KeyRound },
  { to: '/admin/settings', label: 'adm.navSettings', icon: Settings },
  { to: '/admin/grants', label: 'adm.navGrants', icon: ShieldCheck },
  { to: '/admin/policy', label: 'pol.title', icon: Gauge },
  { to: '/admin/audit', label: 'adm.navAudit', icon: ScrollText },
] as const;

const anchorSupported = typeof CSS !== 'undefined' && CSS.supports('position-area', 'block-end');

/** 品牌标志图形：复用原 Logo 几何，供 SuperSidebar 顶部工具条显示 */
const BrandMark = () => (
  <span aria-hidden="true" className="relative inline-block size-[20px] shrink-0 rounded-[5px] bg-primary">
    <span className="absolute inset-x-[8px] inset-y-[5px] rounded-[2px] bg-chrome" />
  </span>
);

/** 收件箱按钮：未读数叠在图标右上角，文本说明通过 aria-describedby 关联到链接外部 */
const InboxButton = ({ active }: { active: boolean }) => {
  const { t } = useTranslation();
  const tipId = useId();
  const unreadId = useId();
  useInboxStream();
  const unread = useUnread().data ?? 0;
  return (
    <div className="sb-inbox-wrap">
      <Link
        to="/inbox"
        aria-label={t('nav.inbox')}
        aria-current={active ? 'page' : undefined}
        aria-describedby={unread > 0 ? unreadId : undefined}
        title={canHint ? undefined : t('nav.inbox')}
        {...(canHint ? { interestfor: tipId } : {})}
        className="btn icon ghost sb-util-btn"
      >
        <Inbox size={16} aria-hidden="true" />
      </Link>
      {unread > 0 && (
        <span aria-hidden="true" className="sb-inbox-badge" data-testid="inbox-unread">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
      {unread > 0 && (
        <span id={unreadId} className="sr-only">
          {t('nav.inboxUnread', { count: unread })}
        </span>
      )}
      {canHint && (
        <div id={tipId} popover="hint" className="tooltip">
          {t('nav.inbox')}
        </div>
      )}
    </div>
  );
};

/** 账户菜单：个人设置、管理后台（仅管理员）、语言、配色、退出 */
const UserMenu = ({ me }: { me: Me }) => {
  const { t } = useTranslation();
  const nav = useNavigate();
  const signOut = useSignOut();
  const [scheme, setS] = useState(getScheme());
  const pick = (s: Scheme) => {
    setScheme(s);
    setS(s);
  };
  const items: MenuItem[] = [
    {
      label: t('nav.accountSettings'),
      icon: <UserCog size={16} aria-hidden="true" />,
      onSelect: () => void nav({ to: '/account' }),
    },
    ...(me.role === 'admin'
      ? [
          {
            label: t('nav.admin'),
            icon: <Settings size={16} aria-hidden="true" />,
            onSelect: () => void nav({ to: '/admin' }),
          },
        ]
      : []),
    ...(['zh', 'en'] as const).map((lng, i) => ({
      label: lng === 'zh' ? '中文' : 'English',
      checked: i18n.language === lng,
      separatorBefore: i === 0,
      onSelect: () => setLang(lng),
    })),
    ...(['auto', 'light', 'dark'] as const).map((s, i) => ({
      label: t(`settings.scheme.${s}`),
      checked: scheme === s,
      separatorBefore: i === 0,
      onSelect: () => pick(s),
    })),
    {
      label: t('auth.logout'),
      icon: <LogOut size={16} aria-hidden="true" />,
      danger: true,
      separatorBefore: true,
      onSelect: () => void signOut(),
    },
  ];
  return (
    <Menu
      label={t('nav.account')}
      heading={`${me.name} · ${me.username}`}
      trigger={<Avatar name={me.name} color="var(--me)" className="sb-user-av" />}
      triggerClassName="btn icon ghost sb-util-btn"
      align="start"
      items={items}
    />
  );
};

/** 可折叠导航分组：原生 <details>（标题不套 heading，操作按钮放 <details> 外侧兄弟位避免嵌套交互元素） */
const NavSection = ({
  title,
  count,
  action,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cx('sb-section-wrap', !!action && 'has-action')}>
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="sb-section">
        <summary className="sb-section-summary">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {count !== undefined && <span className="count">{count}</span>}
        </summary>
        <div className="sb-section-body">{children}</div>
      </details>
      {action}
    </div>
  );
};

/** 上下文切换器浮层：非菜单导航链接浮层（不使用 role="menu" / focusgroup，保留 popover="auto"、Esc 与焦点恢复） */
const ContextSwitcher = ({ me, myGroups }: { me: Me; myGroups: GroupInfo[] }) => {
  const { t } = useTranslation();
  const id = useId();
  const popId = `${id}-pop`;
  const anchor = `--ctx-${id.replace(/[^a-zA-Z0-9]/g, '')}`;
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const restoreOnClose = useRef(false);
  const skipRestore = useRef(false);

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<ProjectListItem[]>('GET', '/api/projects'),
    enabled: open,
  });

  useEffect(() => {
    const p = popRef.current;
    if (!p) return;
    const onBeforeToggle = (e: Event) => {
      const next = (e as ToggleEvent).newState === 'open';
      if (!next && !skipRestore.current && p.contains(document.activeElement)) {
        restoreOnClose.current = true;
      }
      skipRestore.current = false;
    };
    const onToggle = (e: Event) => {
      const next = (e as ToggleEvent).newState === 'open';
      setOpen(next);
      if (!next && restoreOnClose.current) {
        restoreOnClose.current = false;
        btnRef.current?.focus();
      }
    };
    p.addEventListener('beforetoggle', onBeforeToggle);
    p.addEventListener('toggle', onToggle);
    return () => {
      p.removeEventListener('beforetoggle', onBeforeToggle);
      p.removeEventListener('toggle', onToggle);
    };
  }, []);

  useLayoutEffect(() => {
    if (!open || anchorSupported) return;
    const btn = btnRef.current;
    const pop = popRef.current;
    if (!btn || !pop) return;
    const b = btn.getBoundingClientRect();
    const m = pop.getBoundingClientRect();
    const below = b.bottom + m.height + 4 <= innerHeight;
    pop.style.top = `${below ? b.bottom + 4 : Math.max(4, b.top - m.height - 4)}px`;
    pop.style.left = `${Math.max(4, Math.min(b.left, innerWidth - m.width - 4))}px`;
  }, [open, projects.data, myGroups.length]);

  const recentItems = useMemo(() => {
    if (!open) return [];
    const stored = getRecentProjects();
    const visible = projects.data;
    if (!visible) return stored.slice(0, 5);
    const byId = new Map(visible.map((p) => [p.id, p]));
    const bySlug = new Map(visible.map((p) => [`${p.group.slug}/${p.slug}`, p]));
    const matched = stored
      .map((item) => {
        const hit = (item.pid && byId.get(item.pid)) || bySlug.get(`${item.owner}/${item.slug}`);
        return hit
          ? { owner: hit.group.slug, slug: hit.slug, name: hit.name, groupName: hit.group.name, pid: hit.id }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (matched.length > 0) return matched.slice(0, 5);
    return visible.slice(0, 5).map((p) => ({
      owner: p.group.slug,
      slug: p.slug,
      name: p.name,
      groupName: p.group.name,
      pid: p.id,
    }));
  }, [open, projects.data]);

  const closeFromLink = () => {
    skipRestore.current = true;
    popRef.current?.hidePopover();
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={t('nav.switchContext')}
        aria-expanded={open}
        aria-controls={popId}
        title={t('nav.switchContext')}
        className="btn icon ghost sm shrink-0"
        style={{ anchorName: anchor } as CSSProperties}
        onClick={() => popRef.current?.togglePopover()}
      >
        <ChevronsUpDown size={14} aria-hidden="true" />
      </button>
      <div
        ref={popRef}
        id={popId}
        popover="auto"
        className="sb-popover"
        style={{ positionAnchor: anchor } as CSSProperties}
      >
        {open && (
          <div className="sb-popover-body">
            <div className="sb-popover-group">
              <div className="sb-popover-label">{t('nav.work')}</div>
              <Link to="/" className="sb-popover-link" onClick={closeFromLink}>
                <FolderKanban size={15} aria-hidden="true" className="shrink-0 text-text-3" />
                <span className="min-w-0 flex-1 truncate">{t('nav.myProjects')}</span>
              </Link>
              <Link to="/account" className="sb-popover-link" onClick={closeFromLink}>
                <UserCog size={15} aria-hidden="true" className="shrink-0 text-text-3" />
                <span className="min-w-0 flex-1 truncate">{t('nav.accountSettings')}</span>
              </Link>
              {me.role === 'admin' && (
                <Link to="/admin" className="sb-popover-link" onClick={closeFromLink}>
                  <ShieldCheck size={15} aria-hidden="true" className="shrink-0 text-text-3" />
                  <span className="min-w-0 flex-1 truncate">{t('nav.admin')}</span>
                </Link>
              )}
            </div>
            {recentItems.length > 0 && (
              <>
                <hr />
                <div className="sb-popover-group">
                  <div className="sb-popover-label">{t('nav.recentProjects')}</div>
                  {recentItems.map((p) => (
                    <Link
                      key={`${p.owner}/${p.slug}`}
                      to="/project/$owner/$project"
                      params={{ owner: p.owner, project: p.slug }}
                      className="sb-popover-link"
                      onClick={closeFromLink}
                    >
                      <Workflow size={15} aria-hidden="true" className="shrink-0 text-text-3" />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <span className="max-w-[110px] truncate font-mono text-[length:var(--fs-xs)] text-text-3">
                        {p.owner}/{p.slug}
                      </span>
                    </Link>
                  ))}
                </div>
              </>
            )}
            {myGroups.length > 0 && (
              <>
                <hr />
                <div className="sb-popover-group">
                  <div className="sb-popover-label">{t('nav.myGroups')}</div>
                  {myGroups.map((g) => (
                    <Link
                      key={g.id}
                      to="/group/$slug"
                      params={{ slug: g.slug }}
                      className="sb-popover-link"
                      onClick={closeFromLink}
                    >
                      <span
                        className="sb-org-av sb-org-av-sm"
                        aria-hidden="true"
                        style={{ background: groupColor(g.slug), color: 'var(--text)' }}
                      >
                        {groupInitial(g.name)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{g.name}</span>
                    </Link>
                  ))}
                </div>
              </>
            )}
            <hr />
            <Link to="/" className="sb-popover-link text-primary-text" onClick={closeFromLink}>
              <span className="min-w-0 flex-1 truncate">{t('nav.browseAll')}</span>
            </Link>
          </div>
        )}
      </div>
    </>
  );
};

/** 底部快捷键说明浮层 */
const ShortcutsPopover = ({ inProject }: { inProject: boolean }) => {
  const { t } = useTranslation();
  const id = useId();
  const popId = `${id}-pop`;
  const anchor = `--sc-${id.replace(/[^a-zA-Z0-9]/g, '')}`;
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const restoreOnClose = useRef(false);

  useEffect(() => {
    const p = popRef.current;
    if (!p) return;
    const onBeforeToggle = (e: Event) => {
      if ((e as ToggleEvent).newState !== 'open' && p.contains(document.activeElement)) {
        restoreOnClose.current = true;
      }
    };
    const onToggle = (e: Event) => {
      const next = (e as ToggleEvent).newState === 'open';
      setOpen(next);
      if (!next && restoreOnClose.current) {
        restoreOnClose.current = false;
        btnRef.current?.focus();
      }
    };
    p.addEventListener('beforetoggle', onBeforeToggle);
    p.addEventListener('toggle', onToggle);
    return () => {
      p.removeEventListener('beforetoggle', onBeforeToggle);
      p.removeEventListener('toggle', onToggle);
    };
  }, []);

  useLayoutEffect(() => {
    if (!open || anchorSupported) return;
    const btn = btnRef.current;
    const pop = popRef.current;
    if (!btn || !pop) return;
    const b = btn.getBoundingClientRect();
    const m = pop.getBoundingClientRect();
    const above = b.top - m.height - 4 >= 4;
    pop.style.top = `${above ? b.top - m.height - 4 : Math.min(b.bottom + 4, innerHeight - m.height - 4)}px`;
    pop.style.left = `${Math.max(4, Math.min(b.right - m.width, innerWidth - m.width - 4))}px`;
  }, [open, inProject]);

  const goKeys = [
    ['G O', t('nav.overview')],
    ['G M', t('nav.model')],
    ['G V', t('nav.versions')],
    ['G E', t('nav.environments')],
    ['G A', t('nav.activity')],
    ['G P', t('nav.members')],
    ['G S', t('nav.settings')],
  ] as const;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={t('nav.shortcuts')}
        aria-expanded={open}
        aria-controls={popId}
        title={t('nav.shortcuts')}
        className="btn icon ghost sm"
        style={{ anchorName: anchor } as CSSProperties}
        onClick={() => popRef.current?.togglePopover()}
      >
        <HelpCircle size={15} aria-hidden="true" />
      </button>
      <div
        ref={popRef}
        id={popId}
        popover="auto"
        className="sb-popover sb-shortcuts-popover"
        style={{ positionAnchor: anchor } as CSSProperties}
      >
        {open && (
          <div className="sb-popover-body space-y-2 p-2">
            <div className="sb-popover-label px-1">{t('nav.shortcuts')}</div>
            <dl className="m-0 space-y-1.5 px-1 text-xs">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-text-2">{t('nav.shortcutPalette')}</dt>
                <dd className="m-0">
                  <kbd>⌘K</kbd>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-text-2">{t('nav.shortcutSidebar')}</dt>
                <dd className="m-0">
                  <kbd>Ctrl+\</kbd>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-text-2">{t('nav.shortcutPanel')}</dt>
                <dd className="m-0">
                  <kbd>[</kbd>
                </dd>
              </div>
            </dl>
            {inProject && (
              <>
                <hr />
                <div className="sb-popover-label px-1">{t('nav.shortcutGo')}</div>
                <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1 px-1 text-xs">
                  {goKeys.map(([k, label]) => (
                    <div key={k} className="flex items-center justify-between gap-1.5">
                      <dt className="truncate text-text-2">{label}</dt>
                      <dd className="m-0 shrink-0">
                        <kbd>{k}</kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
};

/** 组上下文的组内项目子导航 */
const GroupProjectsSubNav = ({ groupSlug }: { groupSlug: string }) => {
  const { t } = useTranslation();
  const projects = useQuery({
    queryKey: ['group', groupSlug, 'projects'],
    queryFn: () => api<ProjectListItem[]>('GET', `/api/groups/${groupSlug}/projects`),
  });
  const list = projects.data ?? [];
  return (
    <nav aria-label={t('gp.projects')} className="sb-subnav">
      <NavSection
        title={t('gp.projects')}
        count={list.length}
        action={
          <Link
            to="/new"
            search={{ group: groupSlug }}
            aria-label={t('nav.newProjectInGroup')}
            title={t('nav.newProjectInGroup')}
            className="sb-section-action btn icon ghost sm"
          >
            <Plus size={14} aria-hidden="true" />
          </Link>
        }
      >
        {list.length === 0 ? (
          <p className="sb-empty">{t('gp.noProjects')}</p>
        ) : (
          <ul className="sb-list">
            {list.map((p) => (
              <li key={p.id}>
                <Link
                  to="/project/$owner/$project"
                  params={{ owner: groupSlug, project: p.slug }}
                  className="sb-link"
                >
                  <Workflow size={15} aria-hidden="true" className="shrink-0 text-text-3" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="chip">{t(`projects.role.${p.role}`)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </NavSection>
    </nav>
  );
};

/** 项目上下文的环境列表子导航 */
const EnvSubNav = ({
  project,
  envs,
  activeEid,
}: {
  project: ShellProject;
  envs: NonNullable<ReturnType<typeof useEnvs>['data']>;
  activeEid?: string;
}) => {
  const { t } = useTranslation();
  const params = { owner: project.owner, project: project.slug };
  return (
    <nav aria-label={t('envp.list')} className="sb-subnav">
      <NavSection
        title={t('envp.list')}
        count={envs.length}
        action={
          <Link
            to="/project/$owner/$project/environments"
            params={params}
            aria-label={t('envp.add')}
            title={t('envp.add')}
            className="sb-section-action btn icon ghost sm"
          >
            <Plus size={14} aria-hidden="true" />
          </Link>
        }
      >
        {envs.length === 0 ? (
          <p className="sb-empty">{t('ov.noEnv')}</p>
        ) : (
          <ul className="sb-list">
            {envs.map((e) => (
              <EnvSubLink key={e.id} e={e} params={params} active={e.id === activeEid} />
            ))}
          </ul>
        )}
      </NavSection>
    </nav>
  );
};

const EnvSubLink = ({
  e,
  params,
  active,
}: {
  e: NonNullable<ReturnType<typeof useEnvs>['data']>[number];
  params: { owner: string; project: string };
  active: boolean;
}) => {
  const { t } = useTranslation();
  const descId = useId();
  const warn = driftLabel(t, e.drift);
  return (
    <li>
      <Link
        to="/project/$owner/$project/environments/$eid"
        params={{ ...params, eid: e.id }}
        aria-current={active ? 'page' : undefined}
        aria-describedby={warn ? descId : undefined}
        className="sb-link font-mono"
      >
        <Database size={15} aria-hidden="true" className="shrink-0 text-text-3" />
        <span className="min-w-0 flex-1 truncate">{e.name}</span>
        {warn && (
          <ShieldAlert
            size={14}
            aria-hidden="true"
            className={e.drift.status === 'drifted' ? 'shrink-0 text-danger' : 'shrink-0 text-warn'}
          />
        )}
        {e.production && <span className="badge danger font-sans">{t('envp.production')}</span>}
      </Link>
      {warn && (
        <span id={descId} className="sr-only">
          {warn}
        </span>
      )}
    </li>
  );
};

export const SuperSidebar = ({
  me,
  path,
  groupSlug,
  project,
  page,
  drawer = false,
  asideRef,
  closeBtnRef,
  onClose,
  onOpenPalette,
}: {
  me: Me;
  path: string;
  groupSlug?: string;
  project?: ShellProject;
  page: ShellPage | null;
  drawer?: boolean;
  asideRef?: Ref<HTMLElement>;
  closeBtnRef?: Ref<HTMLButtonElement>;
  onClose: () => void;
  onOpenPalette: () => void;
}) => {
  const { t } = useTranslation();
  const nav = useNavigate();
  const warnId = useId();

  const groups = useQuery({
    queryKey: ['groups'],
    queryFn: () => api<GroupList>('GET', '/api/groups'),
  });
  const envs = useEnvs(project?.pid);
  const envList = envs.data ?? [];
  const envWarn = driftWarnings(envs.data).length > 0;

  const isAccount = path === '/account' || path.startsWith('/account/');
  const isAdmin = path === '/admin' || path.startsWith('/admin/');
  const isGroupRoute = path.startsWith('/group/');
  const context = project
    ? 'project'
    : isGroupRoute && groupSlug
      ? 'group'
      : isAccount
        ? 'account'
        : isAdmin
          ? 'admin'
          : 'work';

  const allGroups = groups.data?.groups ?? [];
  const myGroups = allGroups.filter((g) => g.role !== null);
  const activeGroupSlug = project?.owner ?? (isGroupRoute ? groupSlug : undefined);
  const viewingGroup = activeGroupSlug ? allGroups.find((g) => g.slug === activeGroupSlug) : undefined;
  const tempGroup = viewingGroup && viewingGroup.role === null ? viewingGroup : undefined;

  const createItems: MenuItem[] = [
    {
      label: t('projects.new'),
      icon: <Plus size={16} aria-hidden="true" />,
      onSelect: () =>
        void nav({
          to: '/new',
          search: groupSlug ? { group: groupSlug } : {},
        }),
    },
    ...(groups.data?.canCreate
      ? [
          {
            label: t('groups.new'),
            icon: <Users size={16} aria-hidden="true" />,
            onSelect: () => void nav({ to: '/', search: { new: 'group' } }),
          },
        ]
      : []),
  ];

  const base = project ? `/project/${project.owner}/${project.slug}` : null;
  const projectParams = project ? { owner: project.owner, project: project.slug } : undefined;
  const envPrefix = base ? `${base}/environments/` : '';
  const activeEid =
    envPrefix && path.startsWith(envPrefix) ? path.slice(envPrefix.length).split('/')[0] : undefined;
  const groupName = project?.groupName ?? viewingGroup?.name ?? groupSlug ?? project?.owner ?? '';

  const primaryProjectNav = PROJECT_NAV.filter((n) => !n.section);
  const manageProjectNav = PROJECT_NAV.filter((n) => n.section === 'manage');

  return (
    <aside
      ref={asideRef}
      aria-label={t('nav.sidebar')}
      role={drawer ? 'dialog' : undefined}
      aria-modal={drawer ? true : undefined}
      className={cx('super-sidebar', drawer && 'is-drawer')}
    >
      {/* 顶部工具条 */}
      <div className="sb-top">
        <Link to="/" className="sb-brand">
          <BrandMark />
          <span className="truncate font-semibold">{t('app.name')}</span>
        </Link>
        <div className="flex items-center gap-0.5">
          <Menu
            label={t('nav.createNew')}
            trigger={<Plus size={16} aria-hidden="true" />}
            triggerClassName="btn icon ghost sb-util-btn"
            align="start"
            items={createItems}
          />
          <InboxButton active={path === '/inbox'} />
          <UserMenu me={me} />
          <IconButton
            ref={closeBtnRef}
            label={drawer ? t('nav.closeSidebar') : t('nav.collapseSidebar')}
            className="sb-util-btn"
            onClick={onClose}
          >
            {drawer ? <X size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
          </IconButton>
        </div>
      </div>

      {/* 搜索或跳转触发条 */}
      <div className="sb-search">
        <button type="button" className="sb-search-btn" onClick={onOpenPalette}>
          <Search size={14} aria-hidden="true" className="shrink-0 text-text-3" />
          <span className="min-w-0 flex-1 truncate text-left">{t('nav.searchOrGoTo')}</span>
          <kbd aria-hidden="true" className="sb-kbd">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* 主滚动导航区 */}
      <div className="sb-scroll">
        {context === 'work' && (
          <nav aria-label={t('nav.rail')} className="sb-nav">
            <div className="sb-context-header">
              <div className="sb-context">
                <span className="sb-context-icon" aria-hidden="true">
                  <Layers size={15} />
                </span>
                <span className="min-w-0 flex-1 truncate font-semibold text-text">{t('nav.work')}</span>
                <ContextSwitcher me={me} myGroups={myGroups} />
              </div>
            </div>
            <ul className="sb-list">
              <li>
                <Link to="/" aria-current={path === '/' ? 'page' : undefined} className="sb-link">
                  <FolderKanban size={16} aria-hidden="true" className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{t('nav.myProjects')}</span>
                </Link>
              </li>
              <li>
                <Link to="/new" aria-current={path === '/new' ? 'page' : undefined} className="sb-link">
                  <Plus size={16} aria-hidden="true" className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{t('projects.new')}</span>
                </Link>
              </li>
            </ul>
            <NavSection title={t('nav.myGroups')} count={myGroups.length}>
              {myGroups.length === 0 ? (
                <p className="sb-empty">{t('nav.noGroups')}</p>
              ) : (
                <ul className="sb-list">
                  {myGroups.map((g) => (
                    <li key={g.id}>
                      <Link to="/group/$slug" params={{ slug: g.slug }} className="sb-link">
                        <span
                          className="sb-org-av"
                          aria-hidden="true"
                          style={{ background: groupColor(g.slug), color: 'var(--text)' }}
                        >
                          {groupInitial(g.name)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{g.name}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </NavSection>
          </nav>
        )}

        {context === 'group' && groupSlug && (
          <>
            <div className="sb-context-header">
              <Link to="/" className="sb-back-link">
                <ArrowLeft size={13} aria-hidden="true" />
                <span>{t('nav.backToWork')}</span>
              </Link>
              <div className="sb-context">
                <span
                  className="sb-org-av sb-org-av-lg"
                  aria-hidden="true"
                  data-temp={tempGroup ? '' : undefined}
                  style={tempGroup ? undefined : { background: groupColor(groupSlug), color: 'var(--text)' }}
                >
                  {groupInitial(groupName)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-text">{groupName}</div>
                  {tempGroup && (
                    <div className="truncate text-[length:var(--fs-xs)] text-text-3">
                      {t('nav.tempGroup')}
                    </div>
                  )}
                </div>
                <ContextSwitcher me={me} myGroups={myGroups} />
              </div>
            </div>
            <GroupProjectsSubNav groupSlug={groupSlug} />
            <nav aria-label={t('nav.rail')} className="sb-nav">
              <NavSection title={t('nav.myGroups')} count={myGroups.length}>
                {myGroups.length === 0 ? (
                  <p className="sb-empty">{t('nav.noGroups')}</p>
                ) : (
                  <ul className="sb-list">
                    {myGroups.map((g) => {
                      const active = groupSlug === g.slug;
                      return (
                        <li key={g.id}>
                          <Link
                            to="/group/$slug"
                            params={{ slug: g.slug }}
                            aria-current={active ? 'page' : undefined}
                            data-current={active ? '' : undefined}
                            className="sb-link"
                          >
                            <span
                              className="sb-org-av"
                              aria-hidden="true"
                              style={
                                active ? undefined : { background: groupColor(g.slug), color: 'var(--text)' }
                              }
                            >
                              {groupInitial(g.name)}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{g.name}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {tempGroup && (
                  <>
                    <hr className="sb-sep" />
                    <ul className="sb-list">
                      <li>
                        <Link
                          to="/group/$slug"
                          params={{ slug: tempGroup.slug }}
                          aria-current="page"
                          data-current=""
                          data-temp=""
                          title={`${tempGroup.name} · ${t('nav.tempGroup')}`}
                          className="sb-link"
                        >
                          <span className="sb-org-av" aria-hidden="true">
                            {groupInitial(tempGroup.name)}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{tempGroup.name}</span>
                        </Link>
                      </li>
                    </ul>
                  </>
                )}
              </NavSection>
            </nav>
          </>
        )}

        {context === 'project' && project && base && (
          <>
            <nav aria-label={t('nav.rail')} className="sb-nav">
              <div className="sb-context-header">
                <Link
                  to="/group/$slug"
                  params={{ slug: project.owner }}
                  aria-current="true"
                  data-current=""
                  data-temp={tempGroup ? '' : undefined}
                  className="sb-parent-link"
                >
                  <span
                    className="sb-org-av sb-org-av-sm"
                    aria-hidden="true"
                    style={
                      tempGroup ? undefined : { background: groupColor(project.owner), color: 'var(--text)' }
                    }
                  >
                    {groupInitial(groupName)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{groupName}</span>
                </Link>
                <div className="sb-context">
                  <span className="sb-context-icon is-project" aria-hidden="true">
                    <Workflow size={15} />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-semibold text-text">{project.name}</span>
                  <ContextSwitcher me={me} myGroups={myGroups} />
                </div>
              </div>
              <ul className="sb-list">
                {primaryProjectNav.map((n) => {
                  const Icon = n.icon;
                  const active = page === n.key;
                  const warn = n.key === 'environments' && envWarn ? t('nav.driftWarn') : undefined;
                  return (
                    <li key={n.key}>
                      <Link
                        to={n.key === 'overview' ? base : `${base}/${n.key}`}
                        params={projectParams}
                        aria-current={active ? 'page' : undefined}
                        aria-describedby={warn ? warnId : undefined}
                        className="sb-link"
                      >
                        <Icon size={16} aria-hidden="true" className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{t(n.label)}</span>
                        {warn && <span aria-hidden="true" className="sb-dot" />}
                      </Link>
                      {warn && (
                        <span id={warnId} className="sr-only">
                          {warn}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <NavSection title={t('nav.manage')}>
                <ul className="sb-list">
                  {manageProjectNav.map((n) => {
                    const Icon = n.icon;
                    const active = page === n.key;
                    return (
                      <li key={n.key}>
                        <Link
                          to={`${base}/${n.key}`}
                          params={projectParams}
                          aria-current={active ? 'page' : undefined}
                          className="sb-link"
                        >
                          <Icon size={16} aria-hidden="true" className="shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{t(n.label)}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </NavSection>
            </nav>
            {(envList.length > 0 || page === 'environments') && (
              <EnvSubNav project={project} envs={envList} activeEid={activeEid} />
            )}
          </>
        )}

        {context === 'account' && (
          <nav aria-label={t('nav.rail')} className="sb-nav">
            <div className="sb-context-header">
              <Link to="/" className="sb-back-link">
                <ArrowLeft size={13} aria-hidden="true" />
                <span>{t('nav.backToWork')}</span>
              </Link>
              <div className="sb-context">
                <Avatar name={me.name} color="var(--me)" className="sb-user-av-lg" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-text">{t('acc.title')}</div>
                  <div className="truncate font-mono text-[length:var(--fs-xs)] text-text-3">
                    {me.username}
                  </div>
                </div>
                <ContextSwitcher me={me} myGroups={myGroups} />
              </div>
            </div>
            <ul className="sb-list">
              {ACCOUNT_NAV.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      aria-current={path === item.to ? 'page' : undefined}
                      className="sb-link"
                    >
                      <Icon size={16} aria-hidden="true" className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{t(item.label)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        {context === 'admin' && me.role === 'admin' && (
          <nav aria-label={t('nav.rail')} className="sb-nav">
            <div className="sb-context-header">
              <Link to="/" className="sb-back-link">
                <ArrowLeft size={13} aria-hidden="true" />
                <span>{t('nav.backToWork')}</span>
              </Link>
              <div className="sb-context">
                <span className="sb-context-icon is-admin" aria-hidden="true">
                  <ShieldCheck size={15} />
                </span>
                <span className="min-w-0 flex-1 truncate font-semibold text-text">{t('nav.admin')}</span>
                <ContextSwitcher me={me} myGroups={myGroups} />
              </div>
            </div>
            <ul className="sb-list">
              {ADMIN_NAV.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      aria-current={path === item.to ? 'page' : undefined}
                      className="sb-link"
                    >
                      <Icon size={16} aria-hidden="true" className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{t(item.label)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </div>

      {/* 底部页脚 */}
      <div className="sb-footer">
        {me.role === 'admin' && context !== 'admin' ? (
          <Link to="/admin" className="sb-footer-link">
            <ShieldCheck size={15} aria-hidden="true" />
            <span className="truncate">{t('nav.admin')}</span>
          </Link>
        ) : context !== 'work' ? (
          <Link to="/" className="sb-footer-link">
            <FolderKanban size={15} aria-hidden="true" />
            <span className="truncate">{t('nav.myProjects')}</span>
          </Link>
        ) : (
          <span className="flex-1" />
        )}
        <ShortcutsPopover inProject={context === 'project'} />
      </div>
    </aside>
  );
};
