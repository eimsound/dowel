// 画布复制粘贴的剪贴板传输层（ADR 0013 第 2 节）。
// 载荷是版本化 JSON（@dowel/core 的 ClipboardPayload），同时写到三处：
// 1. 系统剪贴板 text/plain：键盘 ⌘C 走 `copy` 事件（同步、无权限弹窗），按钮走 navigator.clipboard.writeText；
// 2. localStorage 镜像：同源的其他标签页 / 项目可读（系统剪贴板读权限受限或无头 E2E 时兜底）；
// 3. 内存：本标签页最快路径，也兜底 localStorage 不可用（隐私模式、超配额）。
// 读取优先级：系统剪贴板里是 Dowel 载荷就用它（除非镜像更新、且那次复制没能写进系统剪贴板）；
// 系统剪贴板为空或读不到时用镜像；系统剪贴板里是别的非空文本（用户之后复制了别的东西）时不粘贴旧镜像，避免贴出过期内容。
import {
  ClipboardError,
  type ClipboardPayload,
  CLIPBOARD_FORMAT,
  parseClipboard,
  serializeClipboard,
} from '@dowel/core';

const MIRROR_KEY = 'dowel.clipboard';
/** 最近一次复制是否已写进系统剪贴板（按钮复制时写入可能被拒） */
const MIRROR_OS_KEY = 'dowel.clipboard.os';

let memory: { text: string; payload: ClipboardPayload; osOk: boolean } | null = null;

const writeMirrorOs = (ok: boolean) => {
  try {
    localStorage.setItem(MIRROR_OS_KEY, ok ? '1' : '0');
  } catch {
    /* 忽略 */
  }
};

const readMirrorOs = (): boolean => {
  try {
    const v = localStorage.getItem(MIRROR_OS_KEY);
    if (v !== null) return v === '1';
  } catch {
    /* 忽略 */
  }
  return memory?.osOk ?? true;
};

const writeMirror = (text: string) => {
  try {
    localStorage.setItem(MIRROR_KEY, text);
  } catch {
    // 超配额或存储不可用：只留内存副本
    try {
      localStorage.removeItem(MIRROR_KEY);
    } catch {
      /* 忽略 */
    }
  }
};

const readMirror = (): ClipboardPayload | null => {
  let text: string | null = null;
  try {
    text = localStorage.getItem(MIRROR_KEY);
  } catch {
    text = null;
  }
  if (text) {
    if (memory?.text === text) return memory.payload;
    try {
      const p = parseClipboard(text);
      if (p) return p;
    } catch {
      /* 镜像损坏或版本不认识：当作没有 */
    }
  }
  return memory?.payload ?? null;
};

/** 序列化并记到镜像与内存；返回要写进系统剪贴板的文本。载荷过大抛 ClipboardError('too_large') */
export const stage = (payload: ClipboardPayload): string => {
  const text = serializeClipboard(payload);
  memory = { text, payload, osOk: true };
  writeMirror(text);
  writeMirrorOs(true);
  return text;
};

const markOsWrite = (ok: boolean) => {
  if (memory) memory.osOk = ok;
  writeMirrorOs(ok);
};

/**
 * 按钮触发的复制：同步序列化并写镜像（载荷过大时在这里同步抛 ClipboardError），
 * 再尽力写系统剪贴板（失败不影响同源粘贴）。返回的 Promise 永不 reject。
 */
export const writeClipboard = (payload: ClipboardPayload): Promise<void> => {
  const text = stage(payload);
  const os = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
    } catch {
      // 系统剪贴板写权限被拒（非安全上下文、无用户手势等）：镜像已写好，同源粘贴仍可用；
      // 记下“没写进去”，粘贴时镜像优先于系统剪贴板里更早的 Dowel 内容
      markOsWrite(false);
    }
  };
  return os();
};

/** 键盘 ⌘C 的 `copy` 事件里同步写入（调用方负责 preventDefault） */
export const writeClipboardEvent = (e: ClipboardEvent, payload: ClipboardPayload) => {
  const text = stage(payload);
  e.clipboardData?.setData('text/plain', text);
};

export type ReadResult =
  | { ok: true; payload: ClipboardPayload }
  | { ok: false; reason: 'empty' | 'foreign' | 'unsupported_version' | 'invalid_payload' };

/** 根据系统剪贴板文本（null = 读不到）决定用哪份载荷 */
export const resolveClipboard = (osText: string | null): ReadResult => {
  if (osText !== null && osText.trim() !== '') {
    try {
      const p = memory?.text === osText ? memory.payload : parseClipboard(osText);
      if (!p) return { ok: false, reason: 'foreign' };
      if (!readMirrorOs()) {
        const mirror = readMirror();
        if (mirror && mirror.copiedAt > p.copiedAt) return { ok: true, payload: mirror };
      }
      return { ok: true, payload: p };
    } catch (e) {
      if (e instanceof ClipboardError && e.code === 'unsupported_version') {
        return { ok: false, reason: 'unsupported_version' };
      }
      return { ok: false, reason: 'invalid_payload' };
    }
  }
  const mirror = readMirror();
  return mirror ? { ok: true, payload: mirror } : { ok: false, reason: 'empty' };
};

/** 键盘 ⌘V 的 `paste` 事件：同步读 text/plain */
export const readClipboardEvent = (e: ClipboardEvent): ReadResult =>
  resolveClipboard(e.clipboardData?.getData('text/plain') ?? null);

/** 按钮触发的粘贴：尽力读系统剪贴板（可能弹权限或被拒），读不到退回镜像 */
export const readClipboard = async (): Promise<ReadResult> => {
  let text: string | null = null;
  try {
    text = (await navigator.clipboard?.readText()) ?? null;
  } catch {
    text = null;
  }
  return resolveClipboard(text);
};

/** 文本看起来像 Dowel 载荷（用于不解析就判断） */
export const looksLikeDowel = (text: string) => text.includes(`"${CLIPBOARD_FORMAT}"`);

/**
 * 键盘复制 / 粘贴是否应交给浏览器默认行为：焦点在输入框、文本域、下拉框、可编辑区域或 CodeMirror 里，
 * 或者页面上有选中的文字（复制时），或者有打开的模态对话框 / 弹出层。
 */
const EDITABLE = 'input, textarea, select, .cm-editor, dialog[open]';
const OPEN_POPOVER = '[popover]:is(:popover-open, .\\:popover-open)';

/** 元素是否处在可编辑区域、编辑器、对话框或打开的弹出层（通知区除外）里 */
const inEditable = (node: Element | null): boolean => {
  if (!node) return false;
  if (node instanceof HTMLElement && node.isContentEditable) return true;
  if (node.closest(EDITABLE)) return true;
  try {
    const pop = node.closest(OPEN_POPOVER);
    if (pop && !pop.closest('[data-toasts]')) return true;
  } catch {
    /* 不认识 :popover-open 的浏览器：忽略 */
  }
  return false;
};

export const shouldIgnoreClipboardKey = (e: Event, kind: 'copy' | 'paste'): boolean => {
  const el = e.target instanceof Element ? e.target : null;
  if (inEditable(el) || inEditable(document.activeElement)) return true;
  if (document.querySelector('dialog[open]')) return true;
  if (kind === 'copy') {
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim() !== '') return true;
  }
  return false;
};
