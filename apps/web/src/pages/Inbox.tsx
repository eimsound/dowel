// 收件箱（P5b，E7）：待我处理（当前环节我能批 / 已通过等我执行）、通知（我的申请结果、紧急执行……）、我提交的申请。
// 未读数在图标栏，实时更新（SSE）；点开一条通知就标为已读，也可以全部标为已读。
import type { ExecRequestSummary, InboxItem } from '@dowel/api';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Inbox as InboxIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api.ts';
import { PageHeader } from '../components/Shell.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { Banner, Empty } from '../components/ui.tsx';
import { formatTime } from '../format.ts';
import { useInbox, useMyRequests, usePending } from '../requests.ts';
import { StatusBadge } from './Request.tsx';

type Tab = 'pending' | 'notices' | 'mine';

const RequestLink = ({ r, children }: { r: ExecRequestSummary; children: React.ReactNode }) => (
  <Link
    to="/project/$owner/$project/requests/$rid"
    params={{ owner: r.project.groupSlug, project: r.project.slug, rid: r.id }}
  >
    {children}
  </Link>
);

const RequestRow = ({ r, extra }: { r: ExecRequestSummary; extra?: string }) => {
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm not-first:border-t not-first:border-border">
      <StatusBadge status={r.status} />
      <RequestLink r={r}>
        {t(
          r.kind === 'rollback'
            ? 'req.rowRollback'
            : r.kind === 'switch'
              ? 'req.rowSwitch'
              : 'req.rowExecute',
          {
            project: r.project.name,
            env: r.environment.name,
            to: r.to.number,
          },
        )}
      </RequestLink>
      {extra && <span className="badge warn">{extra}</span>}
      <span className="flex-1" />
      <span className="text-xs text-text-3">
        {r.requestedBy?.name ?? '?'} · {formatTime(r.createdAt)}
      </span>
    </li>
  );
};

const NoticeRow = ({ n, onRead }: { n: InboxItem; onRead: (id: string) => void }) => {
  const { t } = useTranslation();
  const unread = !n.readAt;
  const p = n.data.params ?? {};
  const title =
    n.data.event && t(`req.notice.${n.data.event}`, { defaultValue: '' })
      ? t(`req.notice.${n.data.event}`, {
          project: p.project ?? n.project?.name ?? '',
          env: p.env ?? n.environment?.name ?? '',
          to: p.to ?? '',
        })
      : n.data.title;
  const link =
    n.project && n.requestId ? (
      <Link
        to="/project/$owner/$project/requests/$rid"
        params={{ owner: n.project.groupSlug, project: n.project.slug, rid: n.requestId }}
        onClick={() => unread && onRead(n.id)}
      >
        {title}
      </Link>
    ) : n.project && n.environment ? (
      <Link
        to="/project/$owner/$project/environments/$eid"
        params={{ owner: n.project.groupSlug, project: n.project.slug, eid: n.environment.id }}
        onClick={() => unread && onRead(n.id)}
      >
        {title}
      </Link>
    ) : (
      <span>{title}</span>
    );
  return (
    <li
      className="space-y-0.5 px-3 py-2 text-sm not-first:border-t not-first:border-border"
      data-unread={unread ? '' : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        {unread && <span className="badge warn">{t('inbox.unread')}</span>}
        {n.kind === 'token_execution' && <span className="chip">{t('inbox.tokenBadge')}</span>}
        <span className={unread ? 'font-medium' : ''}>{link}</span>
        <span className="flex-1" />
        <span className="text-xs text-text-3">{formatTime(n.createdAt)}</span>
        {unread && (
          <button type="button" className="btn sm" onClick={() => onRead(n.id)}>
            {t('inbox.markRead')}
          </button>
        )}
      </div>
      {n.data.body && <p className="text-xs whitespace-pre-wrap text-text-2">{n.data.body}</p>}
    </li>
  );
};

export const InboxPage = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('pending');
  const inbox = useInbox();
  const pending = usePending();
  const mine = useMyRequests();
  const refresh = (unread: number) => {
    qc.setQueryData(['inbox-unread'], unread);
    void qc.invalidateQueries({ queryKey: ['inbox'] });
  };
  const read = useMutation({
    mutationFn: (id: string) => api<{ unread: number }>('POST', `/api/me/inbox/${id}/read`),
    onSuccess: (r) => refresh(r.unread),
  });
  const readAll = useMutation({
    mutationFn: () => api<{ unread: number }>('POST', '/api/me/inbox/read-all'),
    onSuccess: (r) => refresh(r.unread),
  });
  const unread = inbox.data?.unread ?? 0;
  return (
    <>
      <PageHeader
        crumbs={[{ label: t('nav.inbox') }]}
        actions={
          <button
            type="button"
            className="btn"
            disabled={!unread || readAll.isPending}
            onClick={() => readAll.mutate()}
          >
            {t('inbox.readAll')}
          </button>
        }
      />
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[960px] space-y-4 px-6 py-6">
          <Tabs
            label={t('nav.inbox')}
            value={tab}
            onChange={setTab}
            tabs={[
              { key: 'pending', title: t('inbox.tabs.pending', { count: pending.data?.length ?? 0 }) },
              { key: 'notices', title: t('inbox.tabs.notices', { count: unread }) },
              { key: 'mine', title: t('inbox.tabs.mine') },
            ]}
          >
            {(k) => {
              const q = k === 'pending' ? pending : k === 'mine' ? mine : inbox;
              if (q.error)
                return (
                  <Banner kind="danger" role="alert">
                    {q.error.message}
                  </Banner>
                );
              if (k === 'notices') {
                const items = inbox.data?.items ?? [];
                return items.length ? (
                  <ul className="mt-3 list-none overflow-hidden rounded-md border border-border p-0">
                    {items.map((n) => (
                      <NoticeRow key={n.id} n={n} onRead={(id) => read.mutate(id)} />
                    ))}
                  </ul>
                ) : (
                  <Empty icon={<InboxIcon size={20} aria-hidden="true" />} title={t('inbox.emptyNotices')} />
                );
              }
              const rows = (k === 'pending' ? pending.data : mine.data) ?? [];
              return rows.length ? (
                <ul className="mt-3 list-none overflow-hidden rounded-md border border-border p-0">
                  {rows.map((r) => (
                    <RequestRow
                      key={r.id}
                      r={r}
                      extra={
                        'myAction' in r && (r as { myAction: string }).myAction === 'execute'
                          ? t('inbox.toExecute')
                          : undefined
                      }
                    />
                  ))}
                </ul>
              ) : (
                <Empty
                  icon={<InboxIcon size={20} aria-hidden="true" />}
                  title={t(k === 'pending' ? 'inbox.emptyPending' : 'inbox.emptyMine')}
                />
              );
            }}
          </Tabs>
        </div>
      </main>
    </>
  );
};
