// 数据库连接整块组件：支持连接串与主机/端口/库名/用户名/密码/参数（或 SQLite 文件路径）双向同步，并内置测试按钮与检查结果展示。
import type { TargetInfo } from '@dowel/api';
import type { Dialect } from '@dowel/core';
import { CircleCheck, Database, Eye, EyeOff, PlugZap, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type DbUrlFields,
  DIALECT_URL_DEFAULTS,
  emptyDbUrlFields,
  formatDbUrl,
  parseDbUrl,
} from '../db-url.ts';
import { dialectUiSpec } from '../dialects.ts';
import { Banner } from './ui.tsx';

/** 连接检查的结果：版本、账号、权限、schema（每个带表数） */
export const ConnectionCheckResult = ({ info, dialect }: { info: TargetInfo; dialect: Dialect }) => {
  const { t } = useTranslation();
  const uiSpec = dialectUiSpec(dialect);
  const yesNo = (v: boolean) => (v ? t('wiz.yes') : t('wiz.no'));
  return (
    <div className="space-y-2 rounded-sm border border-border bg-surface-2 p-3 text-xs">
      <p className="flex items-center gap-1.5 font-medium">
        <CircleCheck size={14} aria-hidden="true" className="text-ok" />
        {t('wiz.checkOk')}
        <span className="text-text-2">
          {t('wiz.checkVersionGeneric', { dialect: uiSpec.name, version: info.version })}
        </span>
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {uiSpec.requiresExternalShadow && (
          <>
            <dt className="text-text-2">{t('wiz.checkUser')}</dt>
            <dd className="m-0 font-mono">{info.currentUser}</dd>
            <dt className="text-text-2">{t('wiz.checkSuper')}</dt>
            <dd className="m-0">
              {yesNo(info.superuser)}
              {!info.superuser && (
                <span className="ml-3 text-text-2">
                  {t('wiz.checkCreateDb')}：{yesNo(info.canCreateDb)}
                  {uiSpec.schemas && (
                    <>
                      {' · '}
                      {t('wiz.checkCreateSchema')}：{yesNo(info.canCreateSchema)}
                    </>
                  )}
                </span>
              )}
            </dd>
          </>
        )}
        <dt className="text-text-2">{uiSpec.schemas ? t('wiz.schemasTitle') : t('wiz.databaseTitle')}</dt>
        <dd className="m-0 flex flex-wrap items-center gap-1.5">
          {info.schemas.length === 0 && <span className="text-text-2">{t('wiz.noSchemas')}</span>}
          {info.schemas.map((s) => (
            <span key={s.name} className="chip font-mono">
              {s.name} · {t('wiz.tables', { count: s.tables })}
            </span>
          ))}
          {info.dowelSchema && (
            <span className="chip flex items-center gap-1 font-mono" title={t('wiz.schemasHint')}>
              <TriangleAlert size={12} aria-hidden="true" />
              dowel
              {info.dowelMeta && <Database size={12} aria-hidden="true" />}
            </span>
          )}
        </dd>
      </dl>
    </div>
  );
};

export const DbConnectionBlock = ({
  dialect,
  url,
  onUrlChange,
  required,
  onTest,
  testPending = false,
  testDisabled = false,
  testError,
  testResult,
}: {
  dialect: Dialect;
  url: string;
  onUrlChange: (url: string) => void;
  required?: boolean;
  onTest?: () => void;
  testPending?: boolean;
  testDisabled?: boolean;
  testError?: string;
  testResult?: TargetInfo | null;
}) => {
  const { t } = useTranslation();
  const id = useId();
  const uiSpec = dialectUiSpec(dialect);
  const urlSpec = DIALECT_URL_DEFAULTS[dialect];

  const [showPw, setShowPw] = useState(false);
  const [synced, setSynced] = useState<{ url: string; dialect: Dialect }>({ url, dialect });
  const [fields, setFields] = useState<DbUrlFields>(
    () => parseDbUrl(url, dialect) ?? emptyDbUrlFields(dialect),
  );

  // 外部重置表单、切换方言或外部注入新 URL 时同步更新结构化字段
  if (synced.url !== url || synced.dialect !== dialect) {
    setSynced({ url, dialect });
    const parsed = parseDbUrl(url, dialect);
    if (parsed) {
      setFields(parsed);
    } else if (!url.trim() || synced.dialect !== dialect) {
      setFields(emptyDbUrlFields(dialect));
    }
  }

  const handleUrlInput = (nextUrl: string) => {
    setSynced({ url: nextUrl, dialect });
    const parsed = parseDbUrl(nextUrl, dialect);
    if (parsed) {
      setFields(parsed);
    } else if (!nextUrl.trim()) {
      setFields(emptyDbUrlFields(dialect));
    }
    onUrlChange(nextUrl);
  };

  const updateField = <K extends keyof DbUrlFields>(key: K, value: DbUrlFields[K]) => {
    const nextFields = { ...fields, [key]: value };
    const nextUrl = formatDbUrl(nextFields, dialect);
    setFields(nextFields);
    setSynced({ url: nextUrl, dialect });
    onUrlChange(nextUrl);
  };

  return (
    <fieldset className="m-0 min-w-0 overflow-hidden rounded-md border border-border bg-bg p-0">
      <legend className="float-left flex w-full items-center justify-between gap-2 border-b border-border bg-panel/60 px-3 py-1.5 text-xs font-medium text-text-2">
        <span>{t('conn.title')}</span>
        <span className="font-mono text-text-3">{uiSpec.name}</span>
      </legend>
      <div className="clear-both space-y-3 p-3">
        <div className="field">
          <label className="label" htmlFor={`${id}-url`}>
            {t('wiz.envUrl')}
          </label>
          <div className="flex items-center gap-2">
            <input
              id={`${id}-url`}
              className="input flex-1 font-mono"
              value={url}
              placeholder={urlSpec.scheme ? uiSpec.urlPlaceholder : ''}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required={required}
              onChange={(e) => handleUrlInput(e.target.value)}
            />
            {onTest && (
              <button
                type="button"
                className="btn shrink-0"
                disabled={testPending || testDisabled || !url.trim()}
                aria-busy={testPending || undefined}
                onClick={onTest}
              >
                <PlugZap size={14} aria-hidden="true" />
                {testPending ? t('conn.testing') : t('conn.test')}
              </button>
            )}
          </div>
        </div>

        <div className="space-y-2.5 border-t border-border/70 pt-3">
          {dialect === 'sqlite' ? (
            <div className="field">
              <label className="label" htmlFor={`${id}-file`}>
                {t('conn.filePath')}
              </label>
              <input
                id={`${id}-file`}
                className="input font-mono"
                value={fields.filePath}
                placeholder="/data/app.db"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => updateField('filePath', e.target.value)}
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)] gap-x-2.5 gap-y-2 max-[640px]:grid-cols-1">
                <div className="field">
                  <label className="label" htmlFor={`${id}-host`}>
                    {t('conn.host')}
                  </label>
                  <input
                    id={`${id}-host`}
                    className="input font-mono"
                    value={fields.host}
                    placeholder={urlSpec.hostPlaceholder}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => updateField('host', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor={`${id}-port`}>
                    {t('conn.port')}
                  </label>
                  <input
                    id={`${id}-port`}
                    type="text"
                    inputMode="numeric"
                    className="input font-mono"
                    value={fields.port}
                    placeholder={urlSpec.port}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => updateField('port', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor={`${id}-db`}>
                    {t('conn.database')}
                  </label>
                  <input
                    id={`${id}-db`}
                    className="input font-mono"
                    value={fields.database}
                    placeholder="db"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => updateField('database', e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-x-2.5 gap-y-2 max-[640px]:grid-cols-1">
                <div className="field">
                  <label className="label" htmlFor={`${id}-user`}>
                    {t('conn.user')}
                  </label>
                  <input
                    id={`${id}-user`}
                    className="input font-mono"
                    value={fields.user}
                    placeholder="user"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => updateField('user', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor={`${id}-pw`}>
                    {t('conn.password')}
                  </label>
                  <div className="relative flex items-center">
                    <input
                      id={`${id}-pw`}
                      type={showPw ? 'text' : 'password'}
                      className="input pr-8 font-mono"
                      value={fields.password}
                      placeholder="password"
                      autoComplete="new-password"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => updateField('password', e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn ghost icon sm absolute right-1"
                      aria-label={showPw ? t('conn.hidePassword') : t('conn.showPassword')}
                      aria-pressed={showPw}
                      onClick={() => setShowPw((v) => !v)}
                    >
                      {showPw ? (
                        <EyeOff size={14} aria-hidden="true" />
                      ) : (
                        <Eye size={14} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>
                <div className="field">
                  <label className="label" htmlFor={`${id}-params`}>
                    {t('conn.params')}
                  </label>
                  <input
                    id={`${id}-params`}
                    className="input font-mono"
                    value={fields.params}
                    placeholder={urlSpec.paramsPlaceholder}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => updateField('params', e.target.value)}
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {testError && (
          <Banner kind="danger" role="alert">
            {testError}
          </Banner>
        )}
        {testResult && <ConnectionCheckResult info={testResult} dialect={dialect} />}
      </div>
    </fieldset>
  );
};
