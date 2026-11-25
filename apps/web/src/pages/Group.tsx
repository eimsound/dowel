// 组首页：主区域是组信息、成员、组设置（组管理员）；组内项目列表在全局侧边栏中展示。
// 组对所有人可见；成员和组管理员名单对所有人可见，修改需要组管理员（规则在服务端 authz.ts）。
import type { GroupInfo, GroupMember } from '@dowel/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { FolderTree, Plus, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api.ts';
import { Confirm } from '../components/Modal.tsx';
import { PolicyLayerPanel } from '../components/PolicyEditor.tsx';
import { Row, Rows, Section } from '../components/ProjectPage.tsx';
import { PageHeader } from '../components/Shell.tsx';
import { useToast } from '../components/Toasts.tsx';
import { TokenPolicyPanel } from '../components/TokenSettings.tsx';
import { Avatar, Banner, IconButton } from '../components/ui.tsx';
import { WebhookSettings } from '../components/WebhookSettings.tsx';
import { useMe } from '../session.ts';

export const GroupPage = () => {
  const { t } = useTranslation();
  const { slug } = useParams({ from: '/group/$slug' });
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe().data;
  const group = useQuery({
    queryKey: ['group', slug],
    queryFn: () => api<GroupInfo>('GET', `/api/groups/${slug}`),
  });
  const members = useQuery({
    queryKey: ['group', slug, 'members'],
    queryFn: () => api<GroupMember[]>('GET', `/api/groups/${slug}/members`),
  });
  const isAdmin = me?.role === 'admin' || group.data?.role === 'admin';
  const [confirm, setConfirm] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['group', slug] });
    void qc.invalidateQueries({ queryKey: ['groups'] });
    void qc.invalidateQueries({ queryKey: ['projects'] });
    void qc.invalidateQueries({ queryKey: ['project'] });
    void qc.invalidateQueries({ queryKey: ['token-policy'] });
    void qc.invalidateQueries({ queryKey: ['ci-tokens'] });
  };

  const addMember = useMutation({
    mutationFn: (body: { username: string; role: 'admin' | 'member' }) =>
      api('POST', `/api/groups/${slug}/members`, body),
    onSuccess: (_r, body) => {
      toast(t('gp.memberAdded', { name: body.username }));
      setForm({ username: '', role: 'member' });
      refresh();
    },
  });
  const changeMember = useMutation({
    mutationFn: (x: { userId: string; name: string; role: 'admin' | 'member' }) =>
      api('PATCH', `/api/groups/${slug}/members/${x.userId}`, { role: x.role }),
    onSuccess: (_r, x) => {
      toast(t('gp.memberUpdated', { name: x.name }));
      refresh();
    },
  });
  const removeMember = useMutation({
    mutationFn: (x: { userId: string; name: string }) =>
      api('DELETE', `/api/groups/${slug}/members/${x.userId}`),
    onSuccess: (_r, x) => {
      toast(t('gp.memberRemoved', { name: x.name }));
      refresh();
    },
  });
  const save = useMutation({
    mutationFn: (body: Partial<GroupInfo>) => api<GroupInfo>('PATCH', `/api/groups/${slug}`, body),
    onSuccess: () => {
      toast(t('gp.saved'));
      setSettings(null);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/api/groups/${slug}`),
    onSuccess: () => {
      toast(t('gp.deleted'));
      void qc.invalidateQueries({ queryKey: ['groups'] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void nav({ to: '/' });
    },
  });

  const [form, setForm] = useState({ username: '', role: 'member' as 'admin' | 'member' });
  const [settings, setSettings] = useState<Partial<GroupInfo> | null>(null);
  const s = settings ?? group.data ?? {};
  const setS = (patch: Partial<GroupInfo>) => setSettings({ ...s, ...patch });
  const memberError = addMember.error ?? changeMember.error ?? removeMember.error;

  if (group.error)
    return (
      <>
        <PageHeader crumbs={[{ label: t('nav.myProjects'), to: '/' }, { label: slug }]} />
        <main className="grid flex-1 place-items-center">
          <p className="text-sm text-text-2">{group.error.message}</p>
        </main>
      </>
    );

  return (
    <>
      <PageHeader
        crumbs={[{ label: t('nav.myProjects'), to: '/' }, { label: group.data?.name ?? slug }]}
        actions={
          group.data?.role ? <span className="chip">{t(`groups.role.${group.data.role}`)}</span> : null
        }
      />
      <main
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 只读视图内所有控件可能被禁用，可滚动主区域需要能用键盘滚动
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto focus-visible:outline-offset-[-2px]"
      >
        <div className="mx-auto max-w-[960px] space-y-6 px-6 py-6">
          <div className="space-y-1">
            <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-2">
              <span className="font-mono text-xs text-text-3">{slug}</span>
              <span className="chip">
                <Users size={12} aria-hidden="true" />
                {t('groups.memberCount', { count: group.data?.memberCount ?? 0 })}
              </span>
              <span className="chip">
                <FolderTree size={12} aria-hidden="true" />
                {group.data?.projectCount ?? 0}
              </span>
            </p>
            {group.data?.description && <p className="m-0 text-sm text-text-2">{group.data.description}</p>}
          </div>

          <Section title={t('gp.members')} count={members.data?.length}>
            {!isAdmin && <p className="hint">{t('gp.readonly')}</p>}
            {members.data?.some((m) => m.role === 'admin') && (
              <p className="hint">
                {t('gp.adminsList', {
                  names: members.data
                    .filter((m) => m.role === 'admin')
                    .map((m) => m.name)
                    .join('、'),
                })}
              </p>
            )}
            <Rows>
              {(members.data ?? []).map((m) => (
                <Row key={m.id}>
                  <Avatar name={m.name} color="var(--me)" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base">{m.name}</span>
                    <span className="block truncate font-mono text-xs text-text-3">{m.username}</span>
                  </span>
                  {isAdmin ? (
                    <>
                      <select
                        aria-label={t('dlg.roleOf', { name: m.name })}
                        className="select w-32"
                        value={m.role}
                        disabled={changeMember.isPending}
                        onChange={(e) =>
                          changeMember.mutate({
                            userId: m.id,
                            name: m.name,
                            role: e.target.value as 'admin' | 'member',
                          })
                        }
                      >
                        <option value="member">{t('groups.role.member')}</option>
                        <option value="admin">{t('groups.role.admin')}</option>
                      </select>
                      <IconButton
                        label={t('gp.removeMember', { name: m.name })}
                        className="hover:!text-danger"
                        onClick={() => removeMember.mutate({ userId: m.id, name: m.name })}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </IconButton>
                    </>
                  ) : (
                    <span className="chip">{t(`groups.role.${m.role}`)}</span>
                  )}
                </Row>
              ))}
              {members.data?.length === 0 && (
                <li className="px-3 py-4 text-center text-sm text-text-3">{t('dlg.noDefaultMembers')}</li>
              )}
            </Rows>
            {memberError && (
              <Banner kind="danger" role="alert">
                {memberError.message}
              </Banner>
            )}
            {isAdmin && (
              <form
                className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-panel p-3.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  addMember.mutate(form);
                }}
              >
                <label className="field w-56">
                  <span className="label">{t('gp.username')}</span>
                  <input
                    className="input font-mono"
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    aria-label={t('gp.username')}
                    required
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </label>
                <label className="field w-40">
                  <span className="label">{t('dlg.role')}</span>
                  <select
                    className="select"
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'member' })}
                  >
                    <option value="member">{t('groups.role.member')}</option>
                    <option value="admin">{t('groups.role.admin')}</option>
                  </select>
                </label>
                <button type="submit" className="btn primary" disabled={addMember.isPending}>
                  <Plus size={16} aria-hidden="true" />
                  {t('gp.addMember')}
                </button>
              </form>
            )}
          </Section>

          {isAdmin && group.data && (
            <Section title={t('gp.settings')}>
              <form
                className="space-y-3 rounded-md border border-border bg-panel p-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  save.mutate({
                    name: s.name,
                    description: s.description,
                    defaultRole: s.defaultRole,
                    projectCreation: s.projectCreation,
                  });
                }}
              >
                <p className="hint mt-0">{t('gp.settingsHint')}</p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 max-[800px]:grid-cols-1">
                  <label className="field">
                    <span className="label">{t('gp.name')}</span>
                    <input
                      className="input"
                      aria-label={t('gp.name')}
                      value={s.name ?? ''}
                      onChange={(e) => setS({ name: e.target.value })}
                      required
                    />
                  </label>
                  <label className="field">
                    <span className="label">{t('gp.description')}</span>
                    <input
                      className="input"
                      aria-label={t('gp.description')}
                      value={s.description ?? ''}
                      onChange={(e) => setS({ description: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span className="label">{t('gp.defaultRole')}</span>
                    <select
                      className="select"
                      value={s.defaultRole ?? 'editor'}
                      onChange={(e) => setS({ defaultRole: e.target.value as GroupInfo['defaultRole'] })}
                    >
                      {(['none', 'viewer', 'editor', 'admin'] as const).map((r) => (
                        <option key={r} value={r}>
                          {t(`projects.defaultRole.${r}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span className="label">{t('gp.projectCreation')}</span>
                    <select
                      className="select"
                      value={s.projectCreation ?? 'members'}
                      onChange={(e) =>
                        setS({ projectCreation: e.target.value as GroupInfo['projectCreation'] })
                      }
                    >
                      <option value="members">{t('gp.creationMembers')}</option>
                      <option value="admins">{t('gp.creationAdmins')}</option>
                    </select>
                  </label>
                </div>
                {save.error && (
                  <Banner kind="danger" role="alert">
                    {save.error.message}
                  </Banner>
                )}
                <div className="flex justify-end">
                  <button
                    type="submit"
                    className="btn primary"
                    disabled={save.isPending}
                    aria-busy={save.isPending}
                  >
                    {t('pset.save')}
                  </button>
                </div>
              </form>
            </Section>
          )}

          {group.data && (
            // 组层的执行策略（P5a）：所有人可看（组本来就对所有人可见），组管理员可改
            <Section title={t('pol.title')}>
              <PolicyLayerPanel
                path={`/api/groups/${encodeURIComponent(slug)}/exec-policy`}
                queryKey={['exec-policy', 'group', slug]}
              />
            </Section>
          )}

          {group.data && (
            // 组层的“谁能创建 CI 令牌”（P6 T2）：所有人可看，组管理员可改
            <Section title={t('tok.policy.title')}>
              <TokenPolicyPanel
                path={`/api/groups/${encodeURIComponent(slug)}/token-policy`}
                queryKey={['token-policy', 'group', slug]}
              />
            </Section>
          )}

          {isAdmin && group.data && (
            // 组级 Webhook（P5b）：只对组管理员 / 实例管理员显示（接口也只允许他们）
            <WebhookSettings slug={slug} />
          )}

          {isAdmin && (
            <Section title={t('gp.delete')}>
              <div className="flex items-center gap-3 rounded-md border border-border bg-panel p-4">
                <p className="hint mt-0 flex-1">{t('gp.deleteHint')}</p>
                <button type="button" className="btn danger" onClick={() => setConfirm(true)}>
                  <Trash2 size={16} aria-hidden="true" />
                  {t('gp.delete')}
                </button>
              </div>
            </Section>
          )}
        </div>
      </main>

      <Confirm
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t('gp.deleteTitle', { name: group.data?.name ?? slug })}
        confirmLabel={t('gp.delete')}
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() => remove.mutate()}
      >
        {t('gp.deleteHint')}
      </Confirm>
    </>
  );
};
