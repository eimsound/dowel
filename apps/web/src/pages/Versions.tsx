// 版本：列表与详情。版本是链上的不可变快照，发布时冻结它的迁移（升级 / 回滚脚本）；
// 详情显示冻结的迁移和验证报告，链上最新的版本可以逐步编辑脚本并重新验证。
// 发布动作在列表页和模型页顶栏都能用（VersionDialog）。
import type {
  ScriptStepInfo,
  VersionDetail as VersionDetailData,
  VersionInfo,
  VersionVerifyResponse,
} from '@dowel/api';
import { type Dialect, isNontransactionalSql } from '@dowel/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowRight, BookmarkPlus, Download, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, apiText } from '../api.ts';
import { StepList, VersionDialog } from '../components/Dialogs.tsx';
import { EmptyHint, ProjectPage, Row, Rows, Section } from '../components/ProjectPage.tsx';
import { SqlView } from '../components/SqlView.tsx';
import { useToast } from '../components/Toasts.tsx';
import { Banner, IconButton, Sql } from '../components/ui.tsx';
import {
  RiskNote,
  useVersionName,
  VerifyBanner,
  VersionBadges,
  VersionNumber,
} from '../components/VersionStatus.tsx';
import { formatTime } from '../format.ts';
import { useProject } from '../project.tsx';

const useVersions = (pid: string) =>
  useQuery({
    queryKey: ['versions', pid],
    queryFn: () => api<VersionInfo[]>('GET', `/api/projects/${pid}/versions`),
  });

export const Versions = () => {
  const { t } = useTranslation();
  const { pid, project } = useProject();
  const params = { owner: project.group.slug, project: project.slug };
  const versions = useVersions(pid);
  const versionName = useVersionName();
  const [publish, setPublish] = useState(false);
  const canPublish = project.role !== 'viewer';

  return (
    <ProjectPage
      title={t('versions.title')}
      actions={
        canPublish ? (
          <button type="button" className="btn primary" onClick={() => setPublish(true)}>
            <BookmarkPlus size={16} aria-hidden="true" />
            {versions.data?.length ? t('versions.publish') : t('versions.publishFirst')}
          </button>
        ) : null
      }
    >
      <div className="space-y-3">
        {versions.data && versions.data.length === 0 ? (
          <EmptyHint>{t('versions.empty')}</EmptyHint>
        ) : (
          <Rows>
            {(versions.data ?? []).map((v) => (
              <Row key={v.id}>
                <VersionNumber number={v.number} />
                <Link
                  to="/project/$owner/$project/versions/$vid"
                  params={{ ...params, vid: v.id }}
                  className="min-w-0 flex-1 truncate font-mono font-medium no-underline"
                >
                  {versionName(v)}
                </Link>
                <VersionBadges v={v} />
                <span className="w-32 shrink-0 text-right text-xs text-text-2">{v.createdBy ?? '—'}</span>
                <time dateTime={v.createdAt} className="w-40 shrink-0 text-right text-xs text-text-3">
                  {formatTime(v.createdAt)}
                </time>
              </Row>
            ))}
          </Rows>
        )}
      </div>
      <VersionDialog pid={pid} open={publish} onClose={() => setPublish(false)} />
    </ProjectPage>
  );
};

/**
 * 编辑中的一步：key 只用于 React 列表的稳定标识（步骤会被删除、插入）。
 * “非事务”= 用户手动勾选 || 语句本身不能进事务（isNontransactionalSql，与服务端保存时的规则相同）：
 * 后者输入时自动勾选并且不能取消，保存时服务端同样会强制。
 */
interface EditStep {
  key: number;
  sql: string;
  manualNonTx: boolean;
}

const nonTx = (s: EditStep, dialect: Dialect) => s.manualNonTx || isNontransactionalSql(s.sql, dialect);

/**
 * 逐步编辑冻结的迁移：每一步一个 SQL 编辑器，可以切换“非事务”（例如 CREATE INDEX CONCURRENTLY 不能放进事务）、
 * 删除、在末尾添加。保存时整体替换 up 和 down；保存后版本回到未验证，需要重新验证。
 */
const StepsEditor = ({ detail, onDone }: { detail: VersionDetailData; onDone: () => void }) => {
  const { t } = useTranslation();
  const { pid, project } = useProject();
  const dialect = project.dialect as Dialect;
  const qc = useQueryClient();
  const toast = useToast();
  const blankId = useId();
  const [dir, setDir] = useState<'up' | 'down'>('up');
  const [steps, setSteps] = useState<Record<'up' | 'down', EditStep[]>>(() => {
    let nextKey = 0;
    const init = (list: ScriptStepInfo[]): EditStep[] =>
      list.map((s) => ({
        key: nextKey++,
        sql: s.sql,
        // 原来标为非事务、但语句本身判断不出来的（人工标的），保留为手动勾选
        manualNonTx: !s.transactional && !isNontransactionalSql(s.sql, dialect),
      }));
    return {
      up: init(detail.upSteps),
      down: init(detail.downSteps),
    };
  });
  const counter = useRef(detail.upSteps.length + detail.downSteps.length);
  const save = useMutation({
    mutationFn: () =>
      api<VersionDetailData>('PATCH', `/api/projects/${pid}/versions/${detail.id}/steps`, {
        up: steps.up.map((x) => ({ sql: x.sql, transactional: !nonTx(x, dialect) })),
        down: steps.down.map((x) => ({ sql: x.sql, transactional: !nonTx(x, dialect) })),
      }),
    onSuccess: (d) => {
      qc.setQueryData(['version', pid, detail.id], d);
      void qc.invalidateQueries({ queryKey: ['versions', pid] });
      toast(t('versions.stepsSaved'));
      onDone();
    },
  });
  const set = (next: EditStep[]) => setSteps((s) => ({ ...s, [dir]: next }));
  const list = steps[dir];
  const label = t(`dlg.${dir}`);
  // 升级和回滚两边都要检查：空步骤保存不了，并指出在哪一边、第几步
  const blanks = (['up', 'down'] as const).flatMap((d) =>
    steps[d].flatMap((x, i) =>
      x.sql.trim() ? [] : [t('versions.stepLabel', { dir: t(`dlg.${d}`), n: i + 1 })],
    ),
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="seg" role="tablist" aria-label={t('dlg.direction')}>
          {(['up', 'down'] as const).map((d) => (
            <button key={d} type="button" role="tab" aria-selected={dir === d} onClick={() => setDir(d)}>
              {t(`dlg.${d}Short`)}
              <span className="count">{steps[d].length}</span>
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button type="button" className="btn" onClick={onDone} disabled={save.isPending}>
          {t('dlg.cancel')}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={save.isPending}
          // 有空步骤时不用 disabled（会把按钮移出 Tab 顺序）：aria-disabled 仍然可聚焦，点击什么都不做，
          // 原因通过 aria-describedby 关联到上面的提示
          aria-disabled={blanks.length > 0 || undefined}
          aria-describedby={blanks.length > 0 ? blankId : undefined}
          aria-busy={save.isPending}
          onClick={() => {
            if (blanks.length === 0) save.mutate();
          }}
        >
          {t('versions.saveSteps')}
        </button>
      </div>
      <p className="hint">
        {t(
          dialect === 'pg'
            ? 'versions.editHint'
            : dialect === 'mysql'
              ? 'versions.editHintMysql'
              : 'versions.editHintGeneric',
        )}
      </p>
      {/* 普通提示（不是 alert：刚点“添加一步”就会出现，不该打断读屏）；保存按钮用 aria-describedby 关联它 */}
      {blanks.length > 0 && (
        <p id={blankId} className="hint error">
          {t('versions.blankSteps', { list: blanks.join('、') })}
        </p>
      )}
      {save.error && (
        <Banner kind="danger" role="alert">
          {save.error.message}
        </Banner>
      )}
      <ol aria-label={label} className="m-0 list-none space-y-3 p-0">
        {list.map((s, i) => (
          <li key={s.key} className="space-y-1.5">
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-text-3">{t('versions.stepN', { n: i + 1 })}</span>
              <label className="check text-xs">
                <input
                  type="checkbox"
                  checked={nonTx(s, dialect)}
                  disabled={isNontransactionalSql(s.sql, dialect)}
                  onChange={(e) =>
                    set(list.map((x) => (x.key === s.key ? { ...x, manualNonTx: e.target.checked } : x)))
                  }
                />
                <span>{t('versions.nonTxToggle')}</span>
              </label>
              <span className="flex-1" />
              <IconButton
                label={t('versions.removeStep', { n: i + 1 })}
                size="sm"
                onClick={() => set(list.filter((x) => x.key !== s.key))}
              >
                <Trash2 size={14} aria-hidden="true" />
              </IconButton>
            </div>
            <div className="overflow-hidden rounded-sm border border-border bg-[var(--code-bg)]">
              <SqlView
                text={s.sql}
                dialect={dialect}
                label={t('versions.stepLabel', { dir: label, n: i + 1 })}
                className="min-h-0 overflow-hidden"
                onChange={(sql) => set(list.map((x) => (x.key === s.key ? { ...x, sql } : x)))}
              />
            </div>
          </li>
        ))}
      </ol>
      {list.length === 0 && <EmptyHint>{t('dlg.noSteps')}</EmptyHint>}
      <button
        type="button"
        className="btn"
        onClick={() => set([...list, { sql: '', manualNonTx: false, key: counter.current++ }])}
      >
        <Plus size={16} aria-hidden="true" />
        {t('versions.addStep')}
      </button>
    </div>
  );
};

const VersionDetailView = ({ vid }: { vid: string }) => {
  const { t } = useTranslation();
  const { pid, project } = useProject();
  const qc = useQueryClient();
  const toast = useToast();
  const params = { owner: project.group.slug, project: project.slug };
  const versionName = useVersionName();
  const versions = useVersions(pid);
  const [dir, setDir] = useState<'up' | 'down'>('up');
  const [editing, setEditing] = useState(false);
  const detailKey = ['version', pid, vid];
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: () => api<VersionDetailData>('GET', `/api/projects/${pid}/versions/${vid}`),
    retry: false,
  });
  const ddl = useQuery({
    queryKey: ['ddl', pid, vid],
    queryFn: () => apiText(`/api/projects/${pid}/ddl?version=${encodeURIComponent(vid)}`),
    enabled: !!detail.data,
  });
  const verify = useMutation({
    mutationFn: () => api<VersionVerifyResponse>('POST', `/api/projects/${pid}/versions/${vid}/verify`),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: detailKey });
      void qc.invalidateQueries({ queryKey: ['versions', pid] });
      toast(
        t(
          r.report.ok
            ? 'versions.verifyPassed'
            : r.report.missingTargetMajor != null
              ? 'versions.verifyMissingTarget'
              : 'versions.verifyFailed',
        ),
      );
    },
  });

  if (detail.isLoading || versions.isLoading) return null;
  const version = detail.data;
  if (!version)
    return (
      <ProjectPage title={t('versions.detail')}>
        <Banner kind="danger" title={t('versions.notFound')}>
          <Link to="/project/$owner/$project/versions" params={params} className="btn mt-2">
            {t('versions.backToList')}
          </Link>
        </Banner>
      </ProjectPage>
    );

  const prev = versions.data?.find((v) => v.id === version.parentId);
  const canEdit = project.role !== 'viewer';
  const steps = dir === 'up' ? version.upSteps : version.downSteps;
  const report = version.verifyReport;
  const isBaseline = version.number === 0;
  return (
    <ProjectPage
      title={t('versions.detail')}
      actions={
        <>
          <Link to="/project/$owner/$project/versions" params={params} className="btn">
            {t('versions.backToList')}
          </Link>
          <a
            className="btn"
            download={`${versionName(version)}.sql`}
            href={`/api/projects/${pid}/ddl?version=${encodeURIComponent(vid)}`}
          >
            <Download size={16} aria-hidden="true" />
            {t('versions.downloadDdl')}
          </a>
        </>
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <VersionNumber number={version.number} />
          <h2 className="m-0 font-mono text-[length:var(--fs-headline)] font-semibold">
            {versionName(version)}
          </h2>
          <VersionBadges v={version} />
          <span className="text-xs text-text-3">
            {t('versions.publishedAt', {
              time: formatTime(version.createdAt),
              name: version.createdBy ?? '—',
            })}
          </span>
          <span className="font-mono text-xs text-text-3" title={version.checksum}>
            {t('versions.checksum', { sum: version.checksum.slice(0, 12) })}
          </span>
        </div>

        <Section
          title={t('versions.migration')}
          action={
            <div className="flex items-center gap-2">
              {!editing && canEdit && (
                <button
                  type="button"
                  className="btn"
                  disabled={verify.isPending}
                  aria-busy={verify.isPending}
                  onClick={() => verify.mutate()}
                >
                  <ShieldCheck
                    size={16}
                    aria-hidden="true"
                    className={verify.isPending ? 'animate-pulse' : ''}
                  />
                  {verify.isPending ? t('dlg.verifying') : t('versions.reverify')}
                </button>
              )}
              {!editing && canEdit && version.latest && (
                <button type="button" className="btn" onClick={() => setEditing(true)}>
                  <Pencil size={16} aria-hidden="true" />
                  {t('versions.editSteps')}
                </button>
              )}
              {!editing && (
                <div className="seg" role="tablist" aria-label={t('dlg.direction')}>
                  {(['up', 'down'] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      role="tab"
                      aria-selected={dir === d}
                      onClick={() => setDir(d)}
                    >
                      {t(`dlg.${d}Short`)}
                      <span className="count">
                        {(d === 'up' ? version.upSteps : version.downSteps).length}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          }
        >
          {prev ? (
            <p className="hint">
              {t('versions.prev')} <span className="font-mono">v{prev.number}</span>
              <ArrowRight size={12} aria-hidden="true" />
              <span className="font-mono">v{version.number}</span>
            </p>
          ) : (
            <Banner kind="info">{isBaseline ? t('versions.baselineHint') : t('versions.noPrev')}</Banner>
          )}
          {!version.latest && canEdit && <p className="hint">{t('versions.notLatest')}</p>}
          {verify.error && (
            <Banner kind="danger" role="alert">
              {verify.error.message}
            </Banner>
          )}
          {report ? (
            <VerifyBanner report={report} dialect={project.dialect} />
          ) : (
            !version.verifiedAt && (
              <Banner kind="warn" title={t('versions.unverified')}>
                {version.edited ? t('versions.unverifiedEdited') : t('versions.unverifiedHint')}
              </Banner>
            )
          )}
          {report && <p className="hint">{t('versions.verifiedAtHint', { time: formatTime(report.at) })}</p>}
          {!editing && dir === 'up' && <RiskNote report={report} />}
          {editing ? (
            <StepsEditor detail={version} onDone={() => setEditing(false)} />
          ) : steps.length ? (
            <StepList
              steps={steps}
              risks={dir === 'up' && report?.ok ? report.risks : undefined}
              label={t(`dlg.${dir}`)}
            />
          ) : (
            <EmptyHint>
              {dir === 'down' && isBaseline ? t('versions.noRollback') : t('dlg.noSteps')}
            </EmptyHint>
          )}
        </Section>

        <Section title={t('versions.ddl')}>
          {ddl.error ? (
            <Banner kind="danger" role="alert">
              {ddl.error.message}
            </Banner>
          ) : (
            <pre className="code max-h-[520px] text-xs">
              <Sql text={ddl.data ?? ''} />
            </pre>
          )}
        </Section>
      </div>
    </ProjectPage>
  );
};

export const VersionDetail = () => {
  const { vid } = useParams({ from: '/project/$owner/$project/versions/$vid' });
  // 从一个版本跳到另一个版本时重新挂载，方向和编辑状态不带到下一个版本
  return <VersionDetailView key={vid} vid={vid} />;
};
