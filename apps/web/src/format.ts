// 时间格式（DESIGN.md：Voice & Content Strategy）：一天内用相对时间，更早用 YYYY-MM-DD HH:mm（本地时区）。
import i18n from './i18n.ts';

export const formatTime = (iso: string | undefined, now = Date.now()) => {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (d.getTime() - now) / 1000;
  if (Math.abs(diff) < 86_400) {
    const rtf = new Intl.RelativeTimeFormat(i18n.language === 'zh' ? 'zh-CN' : 'en', { numeric: 'auto' });
    if (Math.abs(diff) < 60) return rtf.format(0, 'second');
    if (Math.abs(diff) < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    return rtf.format(Math.round(diff / 3600), 'hour');
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
