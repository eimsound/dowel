// 路由：根布局（登录 / 强制改密检查）→ 登录前页面 / 已登录外壳 → 组页面、项目布局 → 项目子页面。
// 未登录跳登录页并带 next；临时密码登录强制跳 /change-password。
import type { ProjectInfo, ResolvedProject } from '@dowel/api';
import { useQuery } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
  useNavigate,
} from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api } from './api.ts';
import { AccountMcp } from './components/McpTokens.tsx';
import { AppShell } from './components/Shell.tsx';
import { ChangePassword, ForgotPassword, Invite, OidcConfirm, Reset } from './pages/Account.tsx';
import {
  AccountIdentities,
  AccountLayout,
  AccountPassword,
  AccountPreferences,
  AccountProfile,
  AccountSessions,
} from './pages/AccountSettings.tsx';
import { ActivityPage } from './pages/Activity.tsx';
import {
  AdminAudit,
  AdminGrants,
  AdminInvites,
  AdminLayout,
  AdminPolicy,
  AdminSettings,
  AdminSignIn,
  AdminUsers,
} from './pages/Admin.tsx';
import { EnvironmentDetail, Environments } from './pages/Environments.tsx';
import { GroupPage } from './pages/Group.tsx';
import { InboxPage } from './pages/Inbox.tsx';
import { Login } from './pages/Login.tsx';
import { Members } from './pages/Members.tsx';
import { NewProject } from './pages/NewProject.tsx';
import { Overview } from './pages/Overview.tsx';
import { Projects } from './pages/Projects.tsx';
import { ProjectSettings } from './pages/ProjectSettings.tsx';
import { RequestDetail } from './pages/Request.tsx';
import { VersionDetail, Versions } from './pages/Versions.tsx';
import { Model } from './pages/Workspace.tsx';
import { ProjectProvider } from './project.tsx';
import { AUTH_NEXT_EXCLUDES, safeNextPath } from './safe-next.ts';
import { fetchMe, useMe } from './session.ts';

/** 不需要登录的页面（登录、忘记密码、邀请、重置、OIDC 首次开户确认） */
const PUBLIC = ['/login', '/forgot-password', '/invite/', '/reset/', '/oidc/confirm'];
const isPublic = (path: string) => PUBLIC.some((p) => path === p || path.startsWith(p));

const rootRoute = createRootRoute({
  beforeLoad: async ({ location }) => {
    if (location.pathname === '/setup') throw redirect({ to: '/login', replace: true });
    const me = await fetchMe();
    if (!me && !isPublic(location.pathname))
      throw redirect({
        to: '/login',
        search: { next: safeNextPath(location.href, AUTH_NEXT_EXCLUDES) ?? '/' },
      });
    if (me?.mustChangePassword && location.pathname !== '/change-password') {
      const next = safeNextPath(location.href, AUTH_NEXT_EXCLUDES);
      throw redirect({
        to: '/change-password',
        search: next && next !== '/' ? { next } : {},
        replace: true,
      });
    }
    if (me && !me.mustChangePassword && location.pathname === '/change-password') {
      const rawNext = new URLSearchParams(location.searchStr ?? '').get('next') ?? undefined;
      const target = safeNextPath(rawNext, AUTH_NEXT_EXCLUDES) ?? '/';
      if (target === '/') throw redirect({ to: '/', replace: true });
      throw redirect({ href: target, replace: true });
    }
    return { me };
  },
  component: () => <Outlet />,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: typeof search.next === 'string' ? search.next : undefined,
  }),
  component: Login,
});

const changePasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/change-password',
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: typeof search.next === 'string' ? search.next : undefined,
  }),
  component: ChangePassword,
});

/** 项目不存在或看不到（G4：没有权限时一律当作不存在） */
const Missing = () => {
  const { t } = useTranslation();
  return (
    <div className="grid h-dvh place-items-center">
      <div className="space-y-3 text-center">
        <p className="text-lg font-medium">{t('projects.notFound')}</p>
        <Link to="/" className="btn">
          {t('nav.myProjects')}
        </Link>
      </div>
    </div>
  );
};

/** 404 之外的项目加载错误：显示原因和重试按钮，不再是一片空白 */
const LoadError = ({
  message,
  onRetry,
  pending,
}: {
  message: string;
  onRetry: () => void;
  pending: boolean;
}) => {
  const { t } = useTranslation();
  return (
    <div className="grid h-dvh place-items-center px-4">
      <div className="max-w-[440px] space-y-3 text-center">
        <p className="text-lg font-medium">{t('projects.loadErrorTitle')}</p>
        <p className="font-mono text-xs break-words text-text-2">{message}</p>
        <div className="flex justify-center gap-2">
          <button
            type="button"
            className="btn primary"
            disabled={pending}
            aria-busy={pending}
            onClick={onRetry}
          >
            {t('projects.retry')}
          </button>
          <Link to="/" className="btn">
            {t('nav.myProjects')}
          </Link>
        </div>
      </div>
    </div>
  );
};

/** 项目布局：按 /project/:owner/:project 解析成项目 ID，旧路径替换到新地址，然后提供外壳和项目上下文 */
const ProjectLayout = () => {
  const { owner, project } = projectRoute.useParams();
  const nav = useNavigate();
  const me = useMe().data;
  const resolved = useQuery({
    queryKey: ['resolve', owner, project],
    queryFn: () =>
      api<ResolvedProject>('GET', `/api/resolve/${encodeURIComponent(owner)}/${encodeURIComponent(project)}`),
  });
  const data = resolved.data;
  useEffect(() => {
    // 用旧路径访问时，用 resolve 的结果替换地址（replace，不留下历史记录）
    if (data?.redirected)
      void nav({
        to: '/project/$owner/$project',
        params: { owner: data.owner, project: data.slug },
        replace: true,
      });
  }, [data, nav]);
  const projectInfo = useQuery({
    queryKey: ['project', data?.id],
    queryFn: () => api<ProjectInfo>('GET', `/api/projects/${data!.id}`),
    enabled: !!data?.id && !data.redirected,
  });
  const projectInfoData = projectInfo.data;
  // 传给外壳的 project 对象必须稳定：稳定后 AppShell 里 G 键等 effect 不会每次渲染都重建
  const shellProject = useMemo(
    () =>
      projectInfoData
        ? {
            owner: projectInfoData.group.slug,
            slug: projectInfoData.slug,
            name: projectInfoData.name,
            groupName: projectInfoData.group.name,
            pid: projectInfoData.id,
          }
        : undefined,
    [projectInfoData],
  );
  const value = useMemo(
    () => (projectInfoData && me ? { pid: data!.id, project: projectInfoData, me } : null),
    [projectInfoData, me, data],
  );
  if (resolved.error)
    return resolved.error instanceof ApiError && resolved.error.status === 404 ? (
      <Missing />
    ) : (
      <LoadError
        message={resolved.error.message}
        pending={resolved.isFetching}
        onRetry={() => void resolved.refetch()}
      />
    );
  if (projectInfo.error)
    return projectInfo.error instanceof ApiError && projectInfo.error.status === 404 ? (
      <Missing />
    ) : (
      <LoadError
        message={projectInfo.error.message}
        pending={projectInfo.isFetching}
        onRetry={() => void projectInfo.refetch()}
      />
    );
  if (!data || data.redirected || !projectInfoData || !me || !value) return null;
  return (
    <ProjectProvider key={projectInfoData.id} value={value}>
      <AppShell me={me} groupSlug={projectInfoData.group.slug} project={shellProject}>
        <Outlet />
      </AppShell>
    </ProjectProvider>
  );
};

const ProjectIndex = () => {
  const me = useMe().data;
  return me ? <Overview /> : null;
};

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/project/$owner/$project',
  component: ProjectLayout,
});

const projectChildren = [
  createRoute({ getParentRoute: () => projectRoute, path: '/', component: ProjectIndex }),
  createRoute({ getParentRoute: () => projectRoute, path: 'model', component: Model }),
  createRoute({ getParentRoute: () => projectRoute, path: 'versions', component: Versions }),
  createRoute({ getParentRoute: () => projectRoute, path: 'versions/$vid', component: VersionDetail }),
  createRoute({ getParentRoute: () => projectRoute, path: 'environments', component: Environments }),
  createRoute({
    getParentRoute: () => projectRoute,
    path: 'environments/$eid',
    component: EnvironmentDetail,
  }),
  createRoute({ getParentRoute: () => projectRoute, path: 'requests/$rid', component: RequestDetail }),
  createRoute({ getParentRoute: () => projectRoute, path: 'activity', component: ActivityPage }),
  createRoute({ getParentRoute: () => projectRoute, path: 'members', component: Members }),
  createRoute({ getParentRoute: () => projectRoute, path: 'settings', component: ProjectSettings }),
];

/** 组页面的外壳：图标栏高亮当前组，侧面板由 GroupPage 提供 */
const GroupLayout = () => {
  const { slug } = groupRoute.useParams();
  const me = useMe().data;
  if (!me) return null;
  return (
    <AppShell me={me} groupSlug={slug}>
      <GroupPage key={slug} />
    </AppShell>
  );
};

/** 收件箱（P5b）：在外壳里，没有侧面板 */
const InboxLayout = () => {
  const me = useMe().data;
  if (!me) return null;
  return (
    <AppShell me={me}>
      <InboxPage />
    </AppShell>
  );
};

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  component: InboxLayout,
});

const groupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/group/$slug',
  component: GroupLayout,
});

/** 旧地址 /p/:pid（P1b 之前）：用项目信息跳到 /project/:owner/:project */
const LegacyProject = () => {
  const { pid } = legacyRoute.useParams();
  const nav = useNavigate();
  const info = useQuery({
    queryKey: ['project', pid],
    queryFn: () => api<ProjectInfo>('GET', `/api/projects/${pid}`),
  });
  const data = info.data;
  useEffect(() => {
    if (data)
      void nav({
        to: '/project/$owner/$project',
        params: { owner: data.group.slug, project: data.slug },
        replace: true,
      });
  }, [data, nav]);
  if (info.error) return <Missing />;
  return null;
};

const legacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/p/$pid',
  component: LegacyProject,
});

const ProjectsRoute = () => {
  const me = useMe().data;
  if (!me) return null;
  return <Projects me={me} />;
};

/**
 * 我的项目：`?new=group` 是命令面板传过来的意图（打开新建组对话框）。
 * 页面看到之后用 replace 清掉参数，所以它不会留在一个“可以刷新重复触发”的地址里。
 * 新建项目走 `/new` 向导（P3），不再用这一页的表单。
 */
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): { new?: 'group' } =>
    search.new === 'group' ? { new: 'group' } : {},
  component: ProjectsRoute,
});

/** 新建项目向导：`?group=` 预选组（从组页 / 命令面板进来时带上） */
const newProjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/new',
  validateSearch: (search: Record<string, unknown>): { group?: string } => ({
    group: typeof search.group === 'string' ? search.group : undefined,
  }),
  component: NewProject,
});

/** 个人设置（/account）：布局在 AccountLayout，六个分区是嵌套路由（含 M3-C 的 MCP 访问） */
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account',
  component: AccountLayout,
});

/** 管理后台（/admin）：AdminLayout 里检查实例管理员，其他人看到 404 */
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: AdminLayout,
});

const routes = [
  loginRoute,
  createRoute({ getParentRoute: () => rootRoute, path: '/forgot-password', component: ForgotPassword }),
  changePasswordRoute,
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/setup',
    beforeLoad: () => {
      throw redirect({ to: '/login', replace: true });
    },
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/invite/$token', component: Invite }),
  createRoute({ getParentRoute: () => rootRoute, path: '/reset/$token', component: Reset }),
  createRoute({ getParentRoute: () => rootRoute, path: '/oidc/confirm', component: OidcConfirm }),
  projectsRoute,
  newProjectRoute,
  inboxRoute,
  groupRoute,
  projectRoute.addChildren(projectChildren),
  legacyRoute,
  accountRoute.addChildren([
    createRoute({ getParentRoute: () => accountRoute, path: '/', component: AccountProfile }),
    createRoute({ getParentRoute: () => accountRoute, path: 'password', component: AccountPassword }),
    createRoute({
      getParentRoute: () => accountRoute,
      path: 'identities',
      component: AccountIdentities,
    }),
    createRoute({ getParentRoute: () => accountRoute, path: 'sessions', component: AccountSessions }),
    createRoute({ getParentRoute: () => accountRoute, path: 'mcp', component: AccountMcp }),
    createRoute({
      getParentRoute: () => accountRoute,
      path: 'preferences',
      component: AccountPreferences,
    }),
  ]),
  adminRoute.addChildren([
    createRoute({ getParentRoute: () => adminRoute, path: '/', component: AdminUsers }),
    createRoute({ getParentRoute: () => adminRoute, path: 'invites', component: AdminInvites }),
    createRoute({ getParentRoute: () => adminRoute, path: 'sign-in', component: AdminSignIn }),
    createRoute({ getParentRoute: () => adminRoute, path: 'settings', component: AdminSettings }),
    createRoute({ getParentRoute: () => adminRoute, path: 'grants', component: AdminGrants }),
    createRoute({ getParentRoute: () => adminRoute, path: 'policy', component: AdminPolicy }),
    createRoute({ getParentRoute: () => adminRoute, path: 'audit', component: AdminAudit }),
  ]),
];

export const router = createRouter({ routeTree: rootRoute.addChildren(routes) });

// TanStack Router 的类型注册：让 Link 的 to / params 在整棵树里是类型安全的
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
