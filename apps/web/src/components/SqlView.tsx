// SQL 视图（CodeMirror）：默认只读；给了 onChange 就是可编辑的（版本详情里逐步编辑冻结的迁移）。
// 语法颜色用 DESIGN.md 的 syn-* token，与迁移步骤里的高亮一致。
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { useEffect, useLayoutEffect, useRef } from 'react';

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syn-kw)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-str)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-num)' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--syn-ty)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--text-3)' },
  { tag: [tags.operator, tags.punctuation, tags.paren, tags.separator], color: 'var(--text-2)' },
]);

export const SqlView = ({
  text,
  label,
  onChange,
  className,
}: {
  text: string;
  label: string;
  /** 给了就可编辑：每次内容变化时回调完整文本 */
  onChange?: (text: string) => void;
  className?: string;
}) => {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = onChange !== undefined;
  const change = useRef(onChange);
  // 编辑器因 label / 可编辑状态变化重建时，用当时最新的文本作初始内容
  const latest = useRef(text);
  useLayoutEffect(() => {
    change.current = onChange;
    latest.current = text;
  });
  useEffect(() => {
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current,
        extensions: [
          basicSetup,
          sql({ dialect: PostgreSQL }),
          syntaxHighlighting(highlight),
          EditorState.readOnly.of(!editable),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) change.current?.(u.state.doc.toString());
          }),
          EditorView.theme({ '.cm-scroller': { overflow: 'auto' } }),
          // 可编辑的编辑器随内容增高、长行折行：不出现需要键盘才能滚动的区域（axe: scrollable-region-focusable）
          ...(editable ? [EditorView.lineWrapping] : []),
        ],
      }),
    });
    return () => view.current?.destroy();
  }, [label, editable]);
  useEffect(() => {
    const v = view.current!;
    if (v.state.doc.toString() !== text)
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  }, [text]);
  return <div ref={host} className={className ?? 'h-full min-h-0 overflow-hidden'} />;
};
