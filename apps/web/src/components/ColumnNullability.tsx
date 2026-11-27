// 列可空性展示与交互子组件（ADR 0019）：复选框只绑显式 notNull，列表 NN 徽标按有效可空性显示，
// 只由引擎推断为非空时显示虚线框 NN 与只读提示。独立小组件便于无 DOM 环境下用 renderToStaticMarkup 直接测试。
import type { Column, Model } from '@dowel/core';

import { columnNullability, notNullCheckboxDisabled } from '../nullability.ts';

export const ColumnNotNullBadge = ({
  model,
  column,
  inferredTitle,
}: {
  model: Model;
  column: Column;
  inferredTitle: string;
}) => {
  const nn = columnNullability(model, column);
  if (!nn.effective) return null;
  return (
    <b
      className={nn.inferredOnly ? 'flag inferred' : 'flag'}
      title={nn.inferredOnly ? inferredTitle : undefined}
    >
      NN
    </b>
  );
};

export const ColumnNotNullCheckbox = ({
  model,
  column,
  hintId,
  label,
  onChange,
}: {
  model: Model;
  column: Column;
  hintId: string;
  label: string;
  onChange: (notNull: boolean) => void;
}) => {
  const nn = columnNullability(model, column);
  return (
    <label>
      <input
        type="checkbox"
        checked={nn.explicit}
        aria-describedby={nn.inferredOnly ? hintId : undefined}
        disabled={notNullCheckboxDisabled(model, column)}
        onChange={(e) => {
          const on = e.target.checked;
          if (on && model.dialect === 'mssql' && !!column.ext?.mssql?.sparse) return;
          onChange(on);
        }}
      />
      {label}
    </label>
  );
};

export const ColumnNotNullInferredHint = ({
  model,
  column,
  id,
  text,
}: {
  model: Model;
  column: Column;
  id: string;
  text: string;
}) => {
  const nn = columnNullability(model, column);
  if (!nn.inferredOnly) return null;
  return (
    <p id={id} className="hint m-0">
      {text}
    </p>
  );
};
