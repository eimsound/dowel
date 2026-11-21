// 模态对话框：原生 <dialog> + showModal()。浏览器负责焦点、Esc、背景不可操作和关闭后焦点返回。
import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Banner, IconButton } from './ui.tsx';

const outside = (e: PointerEvent, d: HTMLDialogElement) => {
  const r = d.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};

/** 确认破坏性操作：按钮重复动作（DESIGN.md：按钮用“动词 + 对象”） */
export const Confirm = ({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  onConfirm,
  pending,
  error,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  /** 操作失败时显示在对话框里（对话框还没关，用户马上能看到原因） */
  error?: string;
}) => {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={title}
      footer={
        <>
          <span className="flex-1" />
          <button type="button" className="btn" autoFocus onClick={onClose}>
            {t('dlg.cancel')}
          </button>
          <button type="button" className="btn danger solid" disabled={pending} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error && (
          <Banner kind="danger" role="alert">
            {error}
          </Banner>
        )}
        <p className="text-sm text-text-2">{children}</p>
      </div>
    </Modal>
  );
};

export const Modal = ({
  open,
  onClose,
  title,
  children,
  icon,
  size = 'md',
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  icon?: ReactNode;
  /** sm 440px、md 600px、lg 900px（DESIGN.md：dialog-width） */
  size?: 'sm' | 'md' | 'lg';
  /** 底部操作区：左侧辅助操作，右侧取消 / 主按钮 */
  footer?: ReactNode;
}) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  // closedby="any" 不支持时（Safari）补上点击外部关闭：按下和松开都在外部才关闭
  useEffect(() => {
    const d = ref.current!;
    if ('closedBy' in HTMLDialogElement.prototype) return;
    let pressedOutside = false;
    const down = (e: PointerEvent) => {
      pressedOutside = outside(e, d);
    };
    const up = (e: PointerEvent) => {
      if (pressedOutside && outside(e, d)) d.close();
    };
    d.addEventListener('pointerdown', down);
    d.addEventListener('pointerup', up);
    return () => {
      d.removeEventListener('pointerdown', down);
      d.removeEventListener('pointerup', up);
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      {...({ closedby: 'any' } as object)}
      className={`m-auto max-h-[88vh] flex-col overflow-hidden rounded-lg border border-border bg-panel p-0 text-text shadow-[var(--shadow-lg)] open:flex ${
        size === 'lg' ? 'w-[min(900px,94vw)]' : size === 'sm' ? 'w-[min(440px,94vw)]' : 'w-[min(600px,94vw)]'
      }`}
    >
      <header className="flex items-center gap-2 border-b border-border py-2.5 pr-2.5 pl-4">
        {icon && <span className="text-text-3">{icon}</span>}
        <h2 id={titleId} className="flex-1 text-[length:var(--fs-lg)] font-semibold">
          {title}
        </h2>
        <IconButton label="关闭" onClick={() => ref.current!.close()}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </header>
      {open && (
        <>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3.5">{children}</div>
          {footer && (
            <footer className="flex items-center gap-2 border-t border-border px-4 py-3">{footer}</footer>
          )}
        </>
      )}
    </dialog>
  );
};
