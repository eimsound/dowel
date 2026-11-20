// 组级 Webhook（P5b，E8）：组首页里的一节，只对组管理员 / 实例管理员显示。
// 列表（名称、格式、遮蔽的 URL、订阅事件、启用状态、最近一次投递）、新建 / 编辑对话框、删除确认、发送测试、投递记录。
// URL 和签名密钥保存后不回显：服务端只返回 urlMasked（协议 + 主机）和 hasSecret，编辑时留空表示不改。
import {
  WEBHOOK_EVENTS,
  type WebhookDelivery,
  type WebhookEventType,
  type WebhookFormat,
  type WebhookInfo,
} from '@dowel/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { History, Pencil, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { formatTime } from '../format.ts';
import { Confirm, Modal } from './Modal.tsx';
import { EmptyHint, Section } from './ProjectPage.tsx';
import { useToast } from './Toasts.tsx';
import { Banner, IconButton } from './ui.tsx';

const FORMATS: WebhookFormat[] = ['json', 'dingtalk', 'feishu', 'wecom', 'slack'];
/** 这两种格式不签名（密钥就在 URL 里），对话框里不显示密钥输入框 */
const UNSIGNED: WebhookFormat[] = ['wecom', 'slack'];

type T = TFunction;

const eventLabel = (t: T, e: WebhookDelivery['event']) => t(`wh.event.${e}`);

const duration = (t: T, ms: number | null) =>
  ms === null ? '—' : ms < 1000 ? t('wh.ms', { n: ms }) : t('wh.sec', { n: (ms / 1000).toFixed(1) });

/** 投递结果：颜色 + 图标位置的文字（成功 / 失败），不只靠颜色 */
const Outcome = ({ d }: { d: WebhookDelivery }) => {
  const { t } = useTranslation();
  return <span className={d.ok ? 'risk low' : 'risk high'}>{d.ok ? t('wh.ok') : t('wh.failed')}</span>;
};

export const WebhookSettings = ({ slug }: { slug: string }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const base = `/api/groups/${encodeURIComponent(slug)}/webhooks`;
  const queryKey = ['group', slug, 'webhooks'];
  const hooks = useQuery({ queryKey, queryFn: () => api<WebhookInfo[]>('GET', base) });
  const [editing, setEditing] = useState<{ hook: WebhookInfo | null } | null>(null);
  const [deleting, setDeleting] = useState<WebhookInfo | null>(null);
  const [logsOf, setLogsOf] = useState<WebhookInfo | null>(null);
  const [tested, setTested] = useState<Record<string, WebhookDelivery>>({});

  const refresh = () => qc.invalidateQueries({ queryKey });

  const test = useMutation({
    mutationFn: (hook: WebhookInfo) => api<WebhookDelivery>('POST', `${base}/${hook.id}/test`),
    onSuccess: (d, hook) => {
      setTested((x) => ({ ...x, [hook.id]: d }));
      void refresh();
      void qc.invalidateQueries({ queryKey: [...queryKey, hook.id, 'deliveries'] });
    },
  });
  const remove = useMutation({
    mutationFn: (hook: WebhookInfo) => api('DELETE', `${base}/${hook.id}`),
    onSuccess: (_r, hook) => {
      setDeleting(null);
      toast(t('wh.deleted', { name: hook.name }));
      void refresh();
    },
  });

  const list = hooks.data ?? [];
  return (
    <Section
      title={t('wh.title')}
      count={hooks.data?.length}
      action={
        <button type="button" className="btn sm" onClick={() => setEditing({ hook: null })}>
          <Plus size={14} aria-hidden="true" />
          {t('wh.add')}
        </button>
      }
    >
      <p className="hint">{t('wh.hint')}</p>
      {hooks.error && (
        <Banner kind="danger" role="alert">
          {hooks.error.message}
        </Banner>
      )}
      {hooks.data && list.length === 0 && <EmptyHint>{t('wh.empty')}</EmptyHint>}
      {list.length > 0 && (
        <ul className="list-none overflow-hidden rounded-md border border-border bg-panel p-0">
          {list.map((h) => {
            const result = tested[h.id];
            const pending = test.isPending && test.variables?.id === h.id;
            return (
              <li key={h.id} className="space-y-2 px-3 py-2.5 not-first:border-t not-first:border-border">
                <div className="flex items-center gap-2.5">
                  <Webhook size={16} aria-hidden="true" className="shrink-0 text-text-3" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-base">{h.name}</span>
                      <span className="chip">{t(`wh.formats.${h.format}`)}</span>
                      {!h.enabled && <span className="chip">{t('wh.disabled')}</span>}
                    </span>
                    <span className="block truncate font-mono text-xs text-text-3">{h.urlMasked}</span>
                    <span className="block truncate text-xs text-text-2">
                      {h.events.map((e) => eventLabel(t, e)).join('、')}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-text-3">
                    {h.lastDelivery ? (
                      <>
                        <Outcome d={h.lastDelivery} />
                        <time dateTime={h.lastDelivery.at}>{formatTime(h.lastDelivery.at)}</time>
                      </>
                    ) : (
                      <span>{t('wh.never')}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={pending}
                    aria-busy={pending}
                    onClick={() => test.mutate(h)}
                  >
                    <Send size={14} aria-hidden="true" />
                    {pending ? t('wh.testing') : t('wh.test')}
                  </button>
                  <IconButton label={t('wh.deliveriesOf', { name: h.name })} onClick={() => setLogsOf(h)}>
                    <History size={16} aria-hidden="true" />
                  </IconButton>
                  <IconButton label={t('wh.edit', { name: h.name })} onClick={() => setEditing({ hook: h })}>
                    <Pencil size={16} aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={t('wh.delete', { name: h.name })}
                    className="hover:!text-danger"
                    onClick={() => setDeleting(h)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </IconButton>
                </div>
                {result && (
                  <Banner kind={result.ok ? 'ok' : 'danger'} role="status">
                    {result.ok
                      ? t('wh.testOk', { status: result.status, time: duration(t, result.durationMs) })
                      : t('wh.testFail', { error: result.error ?? `HTTP ${result.status}` })}
                  </Banner>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {test.error && (
        <Banner kind="danger" role="alert">
          {test.error.message}
        </Banner>
      )}

      {editing && (
        <WebhookDialog
          base={base}
          hook={editing.hook}
          onClose={() => setEditing(null)}
          onSaved={(saved, isNew) => {
            setEditing(null);
            toast(t(isNew ? 'wh.created' : 'wh.saved', { name: saved.name }));
            void refresh();
          }}
        />
      )}
      {logsOf && (
        <DeliveriesDialog base={base} queryKey={queryKey} hook={logsOf} onClose={() => setLogsOf(null)} />
      )}
      <Confirm
        open={deleting !== null}
        onClose={() => {
          setDeleting(null);
          remove.reset();
        }}
        title={t('wh.deleteTitle', { name: deleting?.name ?? '' })}
        confirmLabel={t('wh.deleteConfirm')}
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() => deleting && remove.mutate(deleting)}
      >
        {t('wh.deleteHint')}
      </Confirm>
    </Section>
  );
};

/** 新建 / 编辑对话框：编辑时 URL 和密钥不回显，留空不改；密钥可以单独清除 */
const WebhookDialog = ({
  base,
  hook,
  onClose,
  onSaved,
}: {
  base: string;
  hook: WebhookInfo | null;
  onClose: () => void;
  onSaved: (hook: WebhookInfo, isNew: boolean) => void;
}) => {
  const { t } = useTranslation();
  const [name, setName] = useState(hook?.name ?? '');
  const [format, setFormat] = useState<WebhookFormat>(hook?.format ?? 'json');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [events, setEvents] = useState<WebhookEventType[]>(hook?.events ?? ['request.created']);
  const [enabled, setEnabled] = useState(hook?.enabled ?? true);
  const signed = !UNSIGNED.includes(format);

  const save = useMutation({
    mutationFn: () => {
      // 保持事件的固定顺序（和列表、文档一致）
      const ordered = WEBHOOK_EVENTS.filter((e) => events.includes(e));
      if (!hook)
        return api<WebhookInfo>('POST', base, {
          name,
          format,
          url: url.trim(),
          secret: signed && secret ? secret : null,
          events: ordered,
          enabled,
        });
      return api<WebhookInfo>('PATCH', `${base}/${hook.id}`, {
        name,
        format,
        events: ordered,
        enabled,
        ...(url.trim() ? { url: url.trim() } : {}),
        ...(clearSecret ? { secret: null } : secret ? { secret } : {}),
      });
    },
    onSuccess: (saved) => onSaved(saved, !hook),
  });

  const toggle = (e: WebhookEventType) =>
    setEvents((xs) => (xs.includes(e) ? xs.filter((x) => x !== e) : [...xs, e]));

  return (
    <Modal
      open
      onClose={onClose}
      title={hook ? t('wh.editTitle', { name: hook.name }) : t('wh.createTitle')}
      icon={<Webhook size={16} aria-hidden="true" />}
      footer={
        <>
          <span className="flex-1" />
          <button type="button" className="btn" onClick={onClose}>
            {t('dlg.cancel')}
          </button>
          <button
            type="submit"
            form="webhook-form"
            className="btn primary"
            disabled={save.isPending || events.length === 0}
            aria-busy={save.isPending}
          >
            {hook ? t('wh.save') : t('wh.create')}
          </button>
        </>
      }
    >
      <form
        id="webhook-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 max-[640px]:grid-cols-1">
          <label className="field">
            <span className="label">{t('wh.name')}</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
            />
          </label>
          <label className="field">
            <span className="label">{t('wh.formatLabel')}</span>
            <select
              className="select"
              value={format}
              onChange={(e) => setFormat(e.target.value as WebhookFormat)}
            >
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {t(`wh.formats.${f}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span className="label">{t('wh.url')}</span>
          <input
            className="input font-mono"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required={!hook}
            placeholder={hook ? t('wh.urlKeep', { masked: hook.urlMasked }) : 'https://'}
            spellCheck={false}
            autoComplete="off"
            maxLength={2000}
          />
          <span className="hint">{t('wh.urlHint')}</span>
        </label>
        {signed ? (
          <div className="field">
            <label className="field">
              <span className="label">{t('wh.secret')}</span>
              <input
                className="input font-mono"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                disabled={clearSecret}
                placeholder={hook?.hasSecret ? t('wh.secretSet') : t('wh.secretOptional')}
                autoComplete="new-password"
                spellCheck={false}
                maxLength={500}
              />
              <span className="hint">{t(`wh.secretHint.${format}`)}</span>
            </label>
            {hook?.hasSecret && (
              <label className="check text-sm">
                <input
                  type="checkbox"
                  checked={clearSecret}
                  onChange={(e) => {
                    setClearSecret(e.target.checked);
                    if (e.target.checked) setSecret('');
                  }}
                />
                <span>{t('wh.secretClear')}</span>
              </label>
            )}
          </div>
        ) : (
          <p className="hint">{t(`wh.secretHint.${format}`)}</p>
        )}
        <fieldset className="field">
          <legend className="label mb-1">{t('wh.events')}</legend>
          {/* 复选框组用 .checks（flex + 间距），不用 space-y */}
          <div className="checks flex-col items-start gap-1.5">
            {WEBHOOK_EVENTS.map((e) => (
              <label key={e} className="check">
                <input type="checkbox" checked={events.includes(e)} onChange={() => toggle(e)} />
                <span>{t(`wh.event.${e}`)}</span>
              </label>
            ))}
          </div>
          {events.length === 0 && <span className="hint error">{t('wh.eventsRequired')}</span>}
        </fieldset>
        <label className="check text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{t('wh.enabled')}</span>
        </label>
        {save.error && (
          <Banner kind="danger" role="alert">
            {save.error.message}
          </Banner>
        )}
      </form>
    </Modal>
  );
};

/** 投递记录：最近 50 次尝试（时间、事件、第几次、状态码、耗时、结果和原因） */
const DeliveriesDialog = ({
  base,
  queryKey,
  hook,
  onClose,
}: {
  base: string;
  queryKey: string[];
  hook: WebhookInfo;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const logs = useQuery({
    queryKey: [...queryKey, hook.id, 'deliveries'],
    queryFn: () => api<WebhookDelivery[]>('GET', `${base}/${hook.id}/deliveries`),
  });
  const rows = logs.data ?? [];
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('wh.deliveriesOf', { name: hook.name })}
      icon={<History size={16} aria-hidden="true" />}
    >
      <div className="space-y-3">
        <p className="hint">{t('wh.deliveriesHint')}</p>
        {logs.error && (
          <Banner kind="danger" role="alert">
            {logs.error.message}
          </Banner>
        )}
        <div className="overflow-x-auto rounded-md border border-border" aria-busy={logs.isPending}>
          <table className="data-table">
            <caption className="sr-only">{t('wh.deliveriesOf', { name: hook.name })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('wh.col.time')}</th>
                <th scope="col">{t('wh.col.event')}</th>
                <th scope="col">{t('wh.col.attempt')}</th>
                <th scope="col">{t('wh.col.status')}</th>
                <th scope="col">{t('wh.col.duration')}</th>
                <th scope="col">{t('wh.col.result')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="whitespace-nowrap">
                    <time dateTime={d.at}>{formatTime(d.at)}</time>
                  </td>
                  <td className="whitespace-nowrap">{eventLabel(t, d.event)}</td>
                  <td className="font-mono">{d.attempt}</td>
                  <td className="font-mono">{d.status ?? '—'}</td>
                  <td className="whitespace-nowrap">{duration(t, d.durationMs)}</td>
                  <td>
                    <span className="flex items-start gap-2">
                      <Outcome d={d} />
                      {d.error && <span className="text-xs break-all text-text-2">{d.error}</span>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.data && rows.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-text-3">{t('wh.noDeliveries')}</p>
          )}
        </div>
      </div>
    </Modal>
  );
};
