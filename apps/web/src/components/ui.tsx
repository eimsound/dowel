// 通用组件：样式见 styles.css 的 @layer components，规范见 DESIGN.md 的 Components 一节。
// 都建立在原生能力上：悬停提示是 interestfor + popover="hint"（不支持时退回 title），菜单是 popover + focusgroup。
import { COMMON_TYPES } from '@dowel/core';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
} from 'react';

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

/** 浏览器同时支持 interest invoker 和 anchor positioning 时，才把 title 升级成样式化的悬停提示 */
export const canHint =
  typeof HTMLButtonElement !== 'undefined' &&
  'interestForElement' in HTMLButtonElement.prototype &&
  CSS.supports('position-area', 'block-end');

/** 只有图标的按钮：必须有名字（aria-label），悬停时显示同样的文字 */
export const IconButton = ({
  label,
  children,
  className,
  variant = 'ghost',
  size,
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  variant?: 'ghost' | 'secondary';
  size?: 'sm';
  /** 需要把焦点还给它时用（窄屏抽屉关闭后回到“打开侧面板”） */
  ref?: Ref<HTMLButtonElement>;
}) => {
  const id = useId();
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={canHint ? undefined : label}
        {...(canHint ? { interestfor: id } : {})}
        className={cx('btn icon', variant === 'ghost' && 'ghost', size, className)}
        {...rest}
      >
        {children}
      </button>
      {canHint && (
        // 提示文字与按钮名字相同，不需要额外的 ARIA（见 modern-web-guidance：interest-triggered-tooltips）
        <div id={id} popover="hint" className="tooltip">
          {label}
        </div>
      )}
    </>
  );
};

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  checked?: boolean;
  separatorBefore?: boolean;
}

const nativeFocusgroup = typeof HTMLElement !== 'undefined' && 'focusGroup' in HTMLElement.prototype;
const anchorSupported = typeof CSS !== 'undefined' && CSS.supports('position-area', 'block-end');

/**
 * 弹出菜单：触发按钮 + popover="auto"（点外部、Esc 关闭）。方向键在菜单项之间移动：
 * 原生 focusgroup="menu"；不支持时自己处理并补上 role（modern-web-guidance：menu）。
 */
export const Menu = ({
  label,
  trigger,
  triggerClassName,
  items,
  align = 'end',
  heading,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  items: MenuItem[];
  align?: 'start' | 'end';
  heading?: string;
}) => {
  const id = useId();
  const anchor = `--menu-${id.replace(/[^a-zA-Z0-9]/g, '')}`;
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const enterOnOpen = useRef(false);
  const fromPointer = useRef(false);

  const itemEls = () => [...(pop.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
  const isOpen = () => !!pop.current?.matches(':popover-open, .\\:popover-open');
  const close = () => {
    btn.current?.focus({ focusVisible: !fromPointer.current } as FocusOptions);
    pop.current?.hidePopover();
  };

  useEffect(() => {
    const p = pop.current!;
    const onToggle = (e: Event) => {
      const open = (e as ToggleEvent).newState === 'open';
      btn.current?.setAttribute('aria-expanded', String(open));
      if (!open) return;
      if (!anchorSupported) {
        // 没有 anchor positioning：按触发按钮的位置放在它下方，放不下就放上方
        const t = btn.current!.getBoundingClientRect();
        const m = p.getBoundingClientRect();
        const below = t.bottom + m.height + 4 <= innerHeight;
        p.style.top = `${below ? t.bottom + 4 : t.top - m.height - 4}px`;
        const left = align === 'end' ? t.right - m.width : t.left;
        p.style.left = `${Math.max(4, Math.min(left, innerWidth - m.width - 4))}px`;
      }
      if (enterOnOpen.current) itemEls()[0]?.focus();
      enterOnOpen.current = false;
    };
    p.addEventListener('toggle', onToggle);
    return () => p.removeEventListener('toggle', onToggle);
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      pop.current?.hidePopover();
      return;
    }
    if (nativeFocusgroup || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const els = itemEls();
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? els.length - 1
          : (i + (e.key === 'ArrowUp' ? -1 : 1) + els.length) % els.length;
    els[next]!.focus();
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded="false"
        aria-label={typeof trigger === 'string' ? undefined : label}
        title={typeof trigger === 'string' ? undefined : label}
        className={triggerClassName ?? 'btn icon ghost'}
        style={{ anchorName: anchor } as CSSProperties}
        onPointerDown={() => {
          fromPointer.current = true;
        }}
        onKeyDown={(e) => {
          fromPointer.current = false;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (isOpen()) itemEls()[0]?.focus();
            else {
              enterOnOpen.current = true;
              pop.current?.showPopover();
            }
          }
        }}
        onClick={(e) => {
          if (isOpen()) return pop.current?.hidePopover();
          enterOnOpen.current = e.detail === 0; // 键盘触发的点击（Enter / 空格）进入菜单
          pop.current?.showPopover();
        }}
      >
        {trigger}
      </button>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 键盘事件从菜单项冒泡上来，菜单本身不可聚焦 */}
      <div
        ref={pop}
        popover="auto"
        className={cx('menu', 'menu-popover', align === 'start' && 'align-start')}
        style={{ positionAnchor: anchor } as CSSProperties}
        onKeyDown={onKeyDown}
      >
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: focusgroup="menu" 让浏览器推断出 menu 角色；不支持时显式加上 */}
        <div
          {...({ focusgroup: 'menu nomemory' } as object)}
          aria-label={label}
          role={nativeFocusgroup ? undefined : 'menu'}
        >
          {heading && <div className="menu-label">{heading}</div>}
          {items.map((it) => (
            <MenuButton key={it.label} item={it} onDone={close} />
          ))}
        </div>
      </div>
    </>
  );
};

const MenuButton = ({ item, onDone }: { item: MenuItem; onDone: () => void }) => {
  const props = {
    type: 'button' as const,
    tabIndex: nativeFocusgroup ? undefined : -1,
    className: cx(item.danger && 'danger'),
    onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) =>
      e.currentTarget.focus({ focusVisible: false } as FocusOptions),
    onClick: () => {
      onDone();
      item.onSelect();
    },
  };
  const content = (
    <>
      {item.icon}
      {item.label}
    </>
  );
  return (
    <>
      {item.separatorBefore && <hr />}
      {item.checked === undefined ? (
        <button {...props} role={nativeFocusgroup ? undefined : 'menuitem'}>
          {content}
        </button>
      ) : (
        // 单选项：focusgroup 不会推断 menuitemradio，显式写出（modern-web-guidance：menu）
        <button {...props} role="menuitemradio" aria-checked={item.checked}>
          {content}
          {item.checked && (
            <span className="check-mark" aria-hidden="true">
              ✓
            </span>
          )}
        </button>
      )}
    </>
  );
};

const BANNER_ICON = { ok: CircleCheck, warn: TriangleAlert, danger: CircleAlert, info: Info };

/** 嵌在页面里的提示条：图标 + 结论 + 说明，可带一个操作 */
export const Banner = ({
  kind,
  title,
  children,
  action,
  role,
}: {
  kind: keyof typeof BANNER_ICON;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  role?: 'status' | 'alert';
}) => {
  const Icon = BANNER_ICON[kind];
  return (
    <div className={cx('banner', kind)} role={role}>
      <Icon size={16} aria-hidden="true" />
      <div className="body">
        {title && <strong>{title}</strong>}
        {title && children ? '：' : null}
        {children}
      </div>
      {action}
    </div>
  );
};

export const Empty = ({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) => (
  <div className="empty">
    {icon}
    <strong>{title}</strong>
    {children && <p>{children}</p>}
    {action && <div className="mt-1.5">{action}</div>}
  </div>
);

/** 协作者颜色：按出现顺序分配 peer-1 … peer-8，自己用 me */
export const peerColor = (i: number) => `var(--peer-${(i % 8) + 1})`;

export const Avatar = ({ name, color, title }: { name: string; color: string; title?: string }) => (
  <span className="avatar" style={{ background: color }} title={title ?? name}>
    {name.slice(0, 1)}
  </span>
);

const KEYWORDS = new Set(
  `ADD ALTER AND AS ASC BY CASCADE CHECK COLUMN COMMENT CONSTRAINT CREATE DATA DEFAULT DELETE DESC DROP
   ENUM EXISTS EXTENSION FOREIGN FROM GENERATED IDENTITY IF IN INDEX IS KEY NOT NULL ON OR PARTITION
   PRIMARY REFERENCES RENAME RESTRICT SCHEMA SEQUENCE SET TABLE TO TYPE UNIQUE USING VALUE VALUES VIEW
   WHERE WITH ALWAYS ATTACH OF FOR INCREMENT START MINVALUE MAXVALUE CACHE CYCLE OWNED NONE ACTION
   INCLUDE NULLS DISTINCT CONCURRENTLY LIKE BEFORE AFTER RETURNS FUNCTION TRIGGER STORED`.split(/\s+/),
);
const TYPES = new Set(
  [...COMMON_TYPES, 'serial', 'bigserial', 'int', 'int4', 'int8', 'regclass'].map((t) => t.toLowerCase()),
);

/** 轻量 SQL 高亮（迁移步骤、DDL 片段）：关键字、字符串、数字、类型、注释 */
export const Sql = ({ text }: { text: string }) => {
  const out: ReactNode[] = [];
  const re = /(--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|("(?:[^"]|"")*"|[A-Za-z_][\w$]*)|(\s+|.)/g;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const [s, cmt, str, num, word] = m;
    const k = i++;
    if (cmt)
      out.push(
        <span key={k} className="cmt">
          {cmt}
        </span>,
      );
    else if (str)
      out.push(
        <span key={k} className="str">
          {str}
        </span>,
      );
    else if (num)
      out.push(
        <span key={k} className="num">
          {num}
        </span>,
      );
    else if (word && KEYWORDS.has(word))
      out.push(
        <span key={k} className="kw">
          {word}
        </span>,
      );
    else if (word && TYPES.has(word.toLowerCase()))
      out.push(
        <span key={k} className="ty">
          {word}
        </span>,
      );
    else out.push(s);
  }
  return <>{out}</>;
};
