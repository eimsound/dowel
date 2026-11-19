// 通知：一个 popover="manual" 的容器（不会被点击外部关闭）放在顶层右下角，里面堆叠多条消息。
// 错误（如冲突）一直保留到用户关闭；成功提示 4 秒后消失，焦点在通知里时暂停（DESIGN.md：反馈）。
// 对话框里的结果和错误显示在对话框内，不用通知（模态框打开时通知会被遮住）。
import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { IconButton } from './ui.tsx';

type Toast = { id: number; text: string; kind: 'error' | 'info' };
const Ctx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(Ctx);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const region = useRef<HTMLElement>(null);
  const live = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, kind }]);
    // 播报给读屏软件：有 ariaNotify 用它，否则写入 live region
    const doc = document as Document & { ariaNotify?: (s: string) => void };
    if (doc.ariaNotify) doc.ariaNotify(text);
    else if (live.current) live.current.textContent = text;
  }, []);
  const remove = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  useEffect(() => {
    const el = region.current!;
    const open = el.matches(':popover-open') || el.classList.contains(':popover-open');
    if (toasts.length && !open) el.showPopover();
    if (!toasts.length && open) el.hidePopover();
  }, [toasts.length]);

  return (
    <Ctx.Provider value={push}>
      {children}
      <div ref={live} aria-live="polite" className="sr-only" />
      <section
        ref={region}
        popover="manual"
        aria-label="通知"
        className="fixed inset-auto right-4 bottom-10 w-[min(340px,90vw)] space-y-2 overflow-visible bg-transparent p-0"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onClose={() => remove(t.id)} />
        ))}
      </section>
    </Ctx.Provider>
  );
};

const ToastItem = ({ toast, onClose }: { toast: Toast; onClose: () => void }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (toast.kind === 'error') return;
    const timer = setInterval(() => {
      if (!ref.current?.contains(document.activeElement)) onClose();
    }, 4000);
    return () => clearInterval(timer);
  }, [toast.kind, onClose]);
  const Icon = toast.kind === 'error' ? CircleAlert : CircleCheck;
  return (
    <div
      ref={ref}
      className="flex items-start gap-2.5 rounded-md border border-border bg-surface py-2.5 pr-2 pl-3 text-sm shadow-[var(--shadow-pop)]"
    >
      <Icon
        size={16}
        aria-hidden="true"
        className={`mt-px ${toast.kind === 'error' ? 'text-danger' : 'text-ok'}`}
      />
      <p className="flex-1 break-words">{toast.text}</p>
      <IconButton label="关闭通知" size="sm" onClick={onClose}>
        <X size={14} aria-hidden="true" />
      </IconButton>
    </div>
  );
};
