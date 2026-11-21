// 我的项目：所有可见项目，按组分区；新建项目跳到 /new 向导，新建组用对话框。
// 外层是应用外壳（图标栏 + 内容区），这一页没有侧面板。
import type { GroupInfo, GroupList, Me, ProjectListItem } from '@dowel/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { FolderPlus, Plus, Users, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api.ts';
import { GroupDialog } from '../components/Dialogs.tsx';
import { AppShell, PageHeader } from '../components/Shell.tsx';
import { Banner, Empty } from '../components/ui.tsx';
import { formatTime } from '../format.ts';

export const Projects = ({ me }: { me: Me }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const nav = useNavigate();
  // 命令面板的“新建项目 / 新建组”通过 ?new=project|group 传过来（见 routes.tsx 的 validateSearch）
  const { new: newFromPalette } = useSearch({ from: '/' });
  const groups = useQuery({
    queryKey: ['groups'],
    queryFn: () => api<GroupList>('GET', '/api/groups'),
  });
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<ProjectListItem[]>('GET', '/api/projects'),
  });
  const [groupDialog, setGroupDialog] = useState(false);

  // 命令面板里的“新建组”：打开对话框，然后把参数用 replace 清掉，
  // 免得刷新或前进后退时又弹一次（已经在 / 时也会因为 search 变化触发这个 effect）。
  const openNewGroup = newFromPalette === 'group';
  const [prevOpenNewGroup, setPrevOpenNewGroup] = useState(false);
  if (openNewGroup !== prevOpenNewGroup) {
    setPrevOpenNewGroup(openNewGroup);
    if (openNewGroup) setGroupDialog(true);
  }
  useEffect(() => {
    if (!openNewGroup) return;
    void nav({ to: '/', search: {}, replace: true });
  }, [openNewGroup, nav]);

  // 能在这个组建项目：实例管理员、组管理员，或 project_creation=members 时的组成员
  const canCreateIn = (g: GroupInfo) =>
    me.role === 'admin' || g.role === 'admin' || (g.role === 'member' && g.projectCreation === 'members');
  const creatable = groups.data?.groups.filter(canCreateIn) ?? [];
  const byGroup = new Map<string, ProjectListItem[]>();
  for (const p of projects.data ?? []) byGroup.set(p.group.id, [...(byGroup.get(p.group.id) ?? []), p]);
  const sections = (groups.data?.groups ?? [])
    .filter((g) => byGroup.has(g.id) || g.role)
    .map((g) => ({ group: g, list: byGroup.get(g.id) ?? [] }));
  // 图标栏只显示我是成员的组；其他组在这里浏览（组本身对所有人可见）
  const allGroups = [...(groups.data?.groups ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const total = projects.data?.length ?? 0;

  return (
    <AppShell me={me}>
      <PageHeader
        crumbs={[{ label: t('nav.myProjects') }]}
        actions={
          <>
            {groups.data?.canCreate && (
              <button type="button" className="btn" onClick={() => setGroupDialog(true)}>
                <Users size={16} aria-hidden="true" />
                {t('groups.new')}
              </button>
            )}
            {/* 新建项目走四步向导（/new），不再在这一页放表单 */}
            <Link to="/new" className="btn primary" aria-disabled={!creatable.length}>
              <Plus size={16} aria-hidden="true" />
              {t('projects.new')}
            </Link>
          </>
        }
      />
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[1000px] space-y-6 px-6 py-6">
          <div className="flex items-center gap-3">
            <h2 className="section-title">
              {t('projects.title')}
              {total > 0 && <span className="count">{total}</span>}
            </h2>
          </div>
          {groups.data && !creatable.length && <Banner kind="info">{t('projects.needGroup')}</Banner>}
          {!groups.isLoading && total === 0 && (
            <Empty
              icon={<FolderPlus size={28} strokeWidth={1.5} aria-hidden="true" />}
              title={t('projects.emptyTitle')}
              action={
                creatable.length ? (
                  <Link to="/new" className="btn primary">
                    <Plus size={16} aria-hidden="true" />
                    {t('projects.new')}
                  </Link>
                ) : undefined
              }
            >
              {t('projects.empty')}
            </Empty>
          )}
          {sections.length > 0 && (
            <div className="space-y-6">
              {sections.map(({ group, list }) => (
                <section key={group.id} aria-label={group.name} className="space-y-2">
                  <header className="flex items-center gap-2">
                    <h2 className="section-title">
                      <Link
                        to="/group/$slug"
                        params={{ slug: group.slug }}
                        className="text-text no-underline hover:underline"
                      >
                        {group.name}
                      </Link>
                    </h2>
                    <span className="font-mono text-xs text-text-3">{group.slug}</span>
                    <span className="chip">{t('groups.memberCount', { count: group.memberCount })}</span>
                    {group.role && <span className="chip">{t(`groups.role.${group.role}`)}</span>}
                  </header>
                  {list.length === 0 ? (
                    <p className="hint">{t('groups.noProjects')}</p>
                  ) : (
                    <ul className="m-0 list-none overflow-hidden rounded-md border border-border bg-panel p-0">
                      {list.map((p) => (
                        <li key={p.id} className="not-first:border-t not-first:border-border">
                          <Link
                            to="/project/$owner/$project"
                            params={{ owner: p.group.slug, project: p.slug }}
                            className="flex items-center gap-3 px-4 py-3 text-text no-underline hover:bg-surface-hover"
                          >
                            <Workflow size={16} aria-hidden="true" className="text-text-3" />
                            <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                            <span className="text-xs text-text-3">{formatTime(p.createdAt)}</span>
                            <span className="chip">{t(`projects.role.${p.role}`)}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          )}
          {allGroups.length > 0 && (
            <section aria-label={t('projects.allGroups')} className="space-y-2">
              <header className="flex items-center gap-2">
                <h2 className="section-title">
                  {t('projects.allGroups')}
                  <span className="count">{allGroups.length}</span>
                </h2>
              </header>
              <p className="hint">{t('projects.allGroupsHint')}</p>
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {allGroups.map((g) => (
                  <li key={g.id}>
                    <Link
                      to="/group/$slug"
                      params={{ slug: g.slug }}
                      className="flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-1.5 text-sm text-text no-underline hover:bg-surface-hover"
                    >
                      <span className="font-medium">{g.name}</span>
                      <span className="chip">
                        {g.role ? t(`groups.role.${g.role}`) : t('groups.notMember')}
                      </span>
                      <span className="text-xs text-text-3">
                        {t('projects.projectCount', { count: g.projectCount })}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </main>
      <GroupDialog
        open={groupDialog}
        onClose={() => {
          setGroupDialog(false);
          void qc.invalidateQueries({ queryKey: ['groups'] });
        }}
      />
    </AppShell>
  );
};
