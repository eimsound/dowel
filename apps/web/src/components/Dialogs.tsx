// 导入 SQL、保存版本、迁移、成员、环境 五个对话框（DESIGN.md：迁移对话框、反馈）。
// 对话框里的结果和错误显示在对话框内（模态框打开时不弹通知）。
import type {
  EnvInfo,
  GroupInfo,
  MigrationResult,
  MigrationStep,
  ModelUpdate,
  PublishRejected,
  StepRisk,
  VerifyResponse,
  VersionCreated,
  VersionInfo,
} from '@dowel/api';
import { formatScript } from '@dowel/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  BookmarkPlus,
  Check,
  Copy,
  Database,
  Download,
  FileInput,
  FileUp,
  GitCompareArrows,
  Info,
  ShieldCheck,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api } from '../api.ts';
import { dialectUiSpec } from '../dialects.ts';
import { useProject } from '../project.tsx';
import { Modal } from './Modal.tsx';
import { useToast } from './Toasts.tsx';
import { Banner, cx, Sql } from './ui.tsx';
import { RiskNote, useVersionName, VerifyBanner } from './VersionStatus.tsx';

type Base = { pid: string; open: boolean; onClose: () => void };

export const ImportDialog = ({ pid, open, onClose }: Base) => {
  const { t } = useTranslation();
  const { project } = useProject();
  const toast = useToast();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const dialect = project.dialect;
  const run = useMutation({
    mutationFn: () => api<ModelUpdate>('POST', `/api/projects/${pid}/import`, { sql: text }),
    onSuccess: (r) => {
      setText('');
      setError('');
      onClose();
      toast(t('dlg.imported', { count: r.objects }));
    },
    onError: (e) => setError(e.message),
  });
  const hintKey =
    dialect === 'sqlite'
      ? 'dlg.importHintSqlite'
      : dialect === 'mysql'
        ? 'dlg.importHintMysql'
        : dialect === 'mssql'
          ? 'dlg.importHintMssql'
          : 'dlg.importHint';
  const placeholderKey =
    dialect === 'sqlite'
      ? 'wiz.sqlPlaceholderSqlite'
      : dialect === 'mysql'
        ? 'wiz.sqlPlaceholderMysql'
        : dialect === 'mssql'
          ? 'wiz.sqlPlaceholderMssql'
          : 'wiz.sqlPlaceholderPg';
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('dlg.importTitle')}
      icon={<FileInput size={16} aria-hidden="true" />}
      size="lg"
      footer={
        <>
          <label className="btn ghost cursor-pointer">
            <FileUp size={16} aria-hidden="true" />
            {t('dlg.importFile')}
            <input
              type="file"
              accept=".sql,text/plain"
              className="sr-only"
              onChange={async (e) => setText(await e.target.files![0]!.text())}
            />
          </label>
          <span className="flex-1" />
          <button type="button" className="btn" onClick={onClose}>
            {t('dlg.cancel')}
          </button>
          <button
            type="submit"
            form="import-form"
            className="btn primary"
            disabled={!text.trim() || run.isPending}
            aria-busy={run.isPending}
          >
            {t('dlg.importRun')}
          </button>
        </>
      }
    >
      <form
        id="import-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <p className="text-sm text-text-2">{t(hintKey)}</p>
        <textarea
          aria-label="SQL"
          className="textarea h-80 font-mono text-xs"
          spellCheck={false}
          placeholder={t(placeholderKey)}
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
        {error && (
          <Banner kind="danger" title={t('dlg.importFailed')} role="alert">
            <span className="font-mono whitespace-pre-wrap">{error}</span>
          </Banner>
        )}
      </form>
    </Modal>
  );
};

export const VersionDialog = ({ pid, open, onClose }: Base) => {
  const { t } = useTranslation();
  const { project } = useProject();
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  // 发布成功但用户需要知道一件事——没有验证（影子库不可用），或者验证通过但风险分析没有完成：
  // 对话框留着，用醒目的横幅说明原因，而不是一闪而过的通知
  const [notice, setNotice] = useState<VersionCreated | null>(null);
  const close = () => {
    setNotice(null);
    onClose();
  };
  // 请求还在进行时对话框可能已经被关掉、甚至重新打开：回调要知道“现在”是不是开着
  const openRef = useRef(open);
  const pendingRef = useRef(false);
  // 发布 = 冻结迁移：服务端先在影子库里闭环验证，通过才写入版本；验证可能要几秒到几十秒
  const run = useMutation({
    mutationFn: () => api<VersionCreated>('POST', `/api/projects/${pid}/versions`, { name }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: ['versions', pid] });
      void qc.invalidateQueries({ queryKey: ['published-tables', pid] });
      setName('');
      const args = {
        name: v.name,
        number: v.number,
        reason: v.unverifiedReason ?? '',
        riskError: v.riskError ?? '',
      };
      if (v.verified && !v.riskError) {
        toast(t('dlg.versionSaved', args));
        if (openRef.current) onClose();
      } else if (openRef.current) {
        // 对话框还开着：说明用常驻的横幅显示，不再弹通知（同一句话出现两次）
        setNotice(v);
      } else {
        // 发布期间用户把对话框关了：横幅没人看，改用通知给出同样的内容（整句由 i18n 生成）
        toast(
          t(
            !v.verified
              ? v.unverifiedReason
                ? 'dlg.versionSavedUnverifiedReason'
                : 'dlg.versionSavedUnverified'
              : 'dlg.versionSavedRiskError',
            args,
          ),
        );
      }
    },
    onError: (e) => {
      if (openRef.current) return; // 对话框开着时错误显示在对话框里
      // 发布期间对话框被关了：失败也要告诉用户；验证没通过（422 + 报告）要说明是验证没有通过
      const report = e instanceof ApiError ? (e.body as PublishRejected | undefined)?.report : undefined;
      toast(
        report
          ? t('dlg.versionFailedVerify', {
              detail: report.error?.message ?? [...report.upDiff, ...report.downDiff][0] ?? e.message,
            })
          : t('dlg.versionFailed', { message: e.message }),
      );
    },
  });
  // 每次打开都从干净的状态开始：清掉上次留下的“未验证”结果和错误报告（reset 的引用是稳定的）。
  // 请求还没完成时重新打开：不重置，继续显示“正在发布”，按钮保持禁用，避免重复提交
  useLayoutEffect(() => {
    openRef.current = open;
    pendingRef.current = run.isPending;
  });
  const { reset } = run;
  useEffect(() => {
    if (open && !pendingRef.current) {
      setNotice(null);
      reset();
    }
  }, [open, reset]);
  // 验证失败时服务端返回 422 和报告：显示在对话框里，版本没有发布
  const rejected =
    run.error instanceof ApiError ? (run.error.body as PublishRejected | undefined)?.report : undefined;
  return (
    <Modal
      open={open}
      onClose={close}
      title={t('dlg.versionTitle')}
      icon={<BookmarkPlus size={16} aria-hidden="true" />}
      size={rejected ? 'lg' : 'sm'}
      footer={
        notice ? (
          <Fragment key="done">
            <span className="flex-1" />
            <button type="button" className="btn primary" onClick={close}>
              {t('dlg.close')}
            </button>
          </Fragment>
        ) : (
          <Fragment key="form">
            <span className="flex-1" />
            <button type="button" className="btn" onClick={close}>
              {t('dlg.cancel')}
            </button>
            <button
              type="submit"
              form="version-form"
              className="btn primary"
              disabled={!name.trim() || run.isPending}
              aria-busy={run.isPending}
            >
              {run.isPending ? t('dlg.versionPublishing') : t('dlg.versionSave')}
            </button>
          </Fragment>
        )
      }
    >
      {notice ? (
        notice.verified ? (
          // 已发布、已通过验证，但风险分析没有完成：别让用户以为“没有风险”
          <Banner
            kind="warn"
            title={t('dlg.versionPublishedVerified', { name: notice.name, number: notice.number })}
            role="status"
          >
            {t('dlg.riskFailedBody', { reason: notice.riskError ?? '' })}
          </Banner>
        ) : (
          <Banner kind="warn" title={t('versions.unavailableTitle')} role="status">
            {t('dlg.versionSavedUnverified', { name: notice.name, number: notice.number })}
            {notice.unverifiedReason && <strong className="mt-1.5 block">{notice.unverifiedReason}</strong>}
          </Banner>
        )
      ) : (
        <form
          id="version-form"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            run.mutate();
          }}
        >
          <label className="field">
            <span className="label">{t('dlg.versionName')}</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="v1"
              required
              autoFocus
              disabled={run.isPending}
            />
          </label>
          <p className="hint">{t('dlg.versionHint')}</p>
          {run.isPending && (
            <Banner kind="info" role="status">
              <span className="animate-pulse">{t('dlg.versionVerifying')}</span>
            </Banner>
          )}
          {run.error && (
            <Banner kind="danger" role="alert">
              {run.error.message}
            </Banner>
          )}
          {rejected && <VerifyBanner report={rejected} dialect={project.dialect} />}
        </form>
      )}
    </Modal>
  );
};

export const StepList = ({
  steps,
  risks,
  label,
}: {
  /** transactional 为 false 的步骤显示“非事务”标记（冻结的迁移里才有这个字段） */
  steps: (Pick<MigrationStep, 'sql'> & { transactional?: boolean })[];
  risks?: StepRisk[];
  label: string;
}) => {
  const { t } = useTranslation();
  return (
    <ol
      aria-label={label}
      className="list-none overflow-hidden rounded-sm border border-border bg-[var(--code-bg)] p-0"
    >
      {steps.map((s, i) => {
        const r = risks?.[i];
        const reasons = r?.note
          ? [t(`dlg.riskNote.${r.note}`)]
          : r
            ? [
                ...(r.rewrites.length ? [t('dlg.rewrites', { t: r.rewrites.join(', ') })] : []),
                ...(r.scans.length ? [t('dlg.scans', { t: r.scans.join(', ') })] : []),
                ...(r.level !== 'low' && r.locks.length
                  ? [
                      t('dlg.locks', {
                        l: [...new Set(r.locks.map((l) => `${l.relation} ${l.mode}`))].join(', '),
                      }),
                    ]
                  : []),
              ]
            : [];
        return (
          <li
            key={i}
            className="grid grid-cols-[22px_auto_minmax(0,1fr)] items-baseline gap-x-2 px-3 py-2 not-first:border-t not-first:border-border"
          >
            <span className="text-right font-mono text-[11px] text-text-3">{i + 1}</span>
            {r && !r.note ? (
              <span className={cx('risk', r.level)}>{t(`dlg.risk.${r.level}`)}</span>
            ) : (
              <span />
            )}
            <code className="text-sm break-words whitespace-pre-wrap">
              <Sql text={s.sql} />
              {s.transactional === false && (
                <span className="risk low ml-2 align-middle">{t('versions.nonTx')}</span>
              )}
            </code>
            {reasons.length > 0 && (
              <div className="col-start-3 mt-1 flex items-start gap-1.5 text-xs text-text-2">
                {r?.level === 'high' ? (
                  <TriangleAlert size={14} aria-hidden="true" className="mt-px text-danger" />
                ) : (
                  <Info size={14} aria-hidden="true" className="mt-px" />
                )}
                <span>{reasons.join('；')}</span>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
};

export const MigrationDialog = ({ pid, open, onClose }: Base) => {
  const { t } = useTranslation();
  const { project } = useProject();
  const uiSpec = dialectUiSpec(project.dialect);
  const versions = useQuery({
    queryKey: ['versions', pid],
    queryFn: () => api<VersionInfo[]>('GET', `/api/projects/${pid}/versions`),
    enabled: open,
  });
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState('head');
  const [dir, setDir] = useState<'up' | 'down'>('up');
  const envs = useQuery({
    queryKey: ['envs', pid],
    queryFn: () => api<EnvInfo[]>('GET', `/api/projects/${pid}/environments`),
    enabled: open && uiSpec.requiresExternalShadow,
  });
  const [env, setEnv] = useState('');
  const [copied, setCopied] = useState(false);
  // 默认和活跃链头比较（ADR 0013：编号最大的版本可能已作废）
  const effFrom = from ?? versions.data?.find((v) => v.latest)?.id ?? 'empty';
  const mig = useQuery({
    queryKey: ['migration', pid, effFrom, to],
    queryFn: () => api<MigrationResult>('GET', `/api/projects/${pid}/migration?from=${effFrom}&to=${to}`),
    enabled: open && !!versions.data,
  });
  const verify = useMutation({
    mutationFn: () =>
      api<VerifyResponse>('POST', `/api/projects/${pid}/verify`, {
        from: effFrom,
        to,
        env: uiSpec.requiresExternalShadow ? env || undefined : undefined,
      }),
  });
  const steps = mig.data?.[dir] ?? [];
  const text = formatScript(steps, project.dialect);
  const versionName = useVersionName();
  const versionOptions = (withEmpty: boolean, withHead: boolean) => (
    <>
      {withEmpty && <option value="empty">{t('dlg.empty')}</option>}
      {withHead && <option value="head">{t('dlg.head')}</option>}
      {versions.data?.map((v) => (
        <option key={v.id} value={v.id}>
          v{v.number} {versionName(v)}
          {v.retiredAt ? t('dlg.retiredSuffix') : ''}
        </option>
      ))}
    </>
  );
  const r = verify.data;
  const noEnv = uiSpec.requiresExternalShadow && envs.data?.length === 0;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('dlg.migTitle')}
      icon={<GitCompareArrows size={16} aria-hidden="true" />}
      size="lg"
      footer={
        <>
          <button
            type="button"
            className="btn ghost"
            disabled={!steps.length}
            onClick={async () => {
              await navigator.clipboard.writeText(text).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            {copied ? t('dlg.copied') : t('dlg.copy')}
          </button>
          <a
            className="btn ghost"
            download="migration.sql"
            href={`/api/projects/${pid}/migration?from=${effFrom}&to=${to}&format=sql`}
          >
            <Download size={16} aria-hidden="true" />
            {t('dlg.download')}
          </a>
          <span className="flex-1" />
          <button type="button" className="btn" onClick={onClose}>
            {t('dlg.close')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={verify.isPending || !steps.length || noEnv}
            aria-busy={verify.isPending}
            onClick={() => verify.mutate()}
          >
            <ShieldCheck size={16} aria-hidden="true" className={verify.isPending ? 'animate-pulse' : ''} />
            {verify.isPending ? t('dlg.verifying') : t('dlg.verify')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-text-2">{t('dlg.from')}</span>
            <select
              className="select w-48"
              value={effFrom}
              onChange={(e) => {
                setFrom(e.target.value);
                verify.reset();
              }}
            >
              {versionOptions(true, false)}
            </select>
          </label>
          <ArrowRight size={16} aria-hidden="true" className="text-text-3" />
          <label className="flex items-center gap-2 text-sm">
            <span className="text-text-2">{t('dlg.to')}</span>
            <select
              className="select w-48"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                verify.reset();
              }}
            >
              {versionOptions(false, true)}
            </select>
          </label>
          <span className="flex-1" />
          <div className="seg" role="tablist" aria-label={t('dlg.direction')}>
            {(['up', 'down'] as const).map((d) => (
              <button key={d} type="button" role="tab" aria-selected={dir === d} onClick={() => setDir(d)}>
                {t(`dlg.${d}Short`)}
                <span className="count">{mig.data?.[d].length ?? 0}</span>
              </button>
            ))}
          </div>
        </div>

        {!uiSpec.requiresExternalShadow ? (
          <p className="flex items-center gap-2 text-sm text-text-2">
            <Database size={14} aria-hidden="true" className="text-text-3" />
            <span>{t('dlg.verifyInMemory')}</span>
          </p>
        ) : noEnv ? (
          <Banner kind="info">{t('dlg.noEnv', { dialect: uiSpec.name })}</Banner>
        ) : (
          <label className="flex items-center gap-2 text-sm">
            <Database size={14} aria-hidden="true" className="text-text-3" />
            <span className="text-text-2">{t('dlg.verifyOnShort')}</span>
            <select
              aria-label={t('dlg.verifyOn')}
              className="select w-56"
              value={env || envs.data?.[0]?.id || ''}
              onChange={(e) => {
                setEnv(e.target.value);
                verify.reset();
              }}
            >
              {envs.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {r && <VerifyBanner report={r} dialect={project.dialect} />}
        {verify.error && (
          <Banner kind="danger" title={t('dlg.verifyFail')} role="alert">
            {verify.error.message}
          </Banner>
        )}
        {mig.error && (
          <Banner kind="danger" role="alert">
            {mig.error.message}
          </Banner>
        )}

        {dir === 'up' && <RiskNote report={r} />}
        {mig.data && !steps.length ? (
          <p className="rounded-sm border border-dashed border-border-strong p-6 text-center text-sm text-text-3">
            {t('dlg.noSteps')}
          </p>
        ) : (
          <StepList
            steps={steps}
            risks={r?.ok && dir === 'up' ? r.risks : undefined}
            label={t(`dlg.${dir}`)}
          />
        )}
      </div>
    </Modal>
  );
};

export const GroupDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api<GroupInfo>('POST', '/api/groups', {
        slug,
        name,
        description: description.trim(),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('groups.new')}
      icon={<Users size={16} aria-hidden="true" />}
      size="sm"
      footer={
        <>
          <span className="flex-1" />
          <button type="button" className="btn" onClick={onClose}>
            {t('dlg.cancel')}
          </button>
          <button type="submit" form="group-form" className="btn primary" disabled={create.isPending}>
            {t('groups.create')}
          </button>
        </>
      }
    >
      <form
        id="group-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label className="field">
          <span className="label">{t('groups.name')}</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="field">
          <span className="label">{t('groups.slug')}</span>
          <input
            className="input font-mono"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
            autoCapitalize="none"
            spellCheck={false}
          />
          <span className="hint">{t('groups.slugHint')}</span>
        </label>
        <label className="field">
          <span className="label">{t('groups.description')}</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {create.error && (
          <Banner kind="danger" role="alert">
            {create.error.message}
          </Banner>
        )}
      </form>
    </Modal>
  );
};
