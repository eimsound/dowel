// 认领确认对话框：说明后果（原实例之后执行会被拒绝；只读的漂移检查和读历史不受影响；认领会写进目标库的 dowel 历史），
// 只有实例管理员能确认。向导里的接手、环境页的“认领”、添加环境时接入由别的实例认领的库，都用它。
import { useTranslation } from 'react-i18next';

import { Modal } from './Modal.tsx';
import { Banner } from './ui.tsx';

export const ClaimDialog = ({
  open,
  onClose,
  onConfirm,
  pending,
  error,
  instanceId,
  isAdmin,
  confirmLabel,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  pending?: boolean;
  error?: string;
  /** 当前认领的实例（已知时显示） */
  instanceId?: string | null;
  /** 当前用户是不是实例管理员：不是就只能看说明，不能确认 */
  isAdmin: boolean;
  confirmLabel?: string;
}) => {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={t('tk.claimTitle')}
      footer={
        <>
          <span className="flex-1" />
          <button type="button" className="btn" onClick={onClose}>
            {t('dlg.cancel')}
          </button>
          <button
            type="button"
            className="btn danger solid"
            aria-disabled={!isAdmin || pending || undefined}
            aria-busy={pending || undefined}
            onClick={() => isAdmin && !pending && onConfirm()}
          >
            {confirmLabel ?? t('tk.claimConfirm')}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {error && (
          <Banner kind="danger" role="alert">
            {error}
          </Banner>
        )}
        {!isAdmin && (
          <Banner kind="warn" role="status">
            {t('tk.claimNeedAdminShort')}
          </Banner>
        )}
        <p className="m-0 text-text-2">{t('tk.claimIntro')}</p>
        <ul className="m-0 list-disc space-y-1 pl-5 text-text-2">
          <li>{t('tk.claimEffect1')}</li>
          <li>{t('tk.claimEffect2')}</li>
          <li>{t('tk.claimEffect3')}</li>
        </ul>
        {instanceId && <p className="hint m-0 font-mono">{t('tk.claimWho', { id: instanceId })}</p>}
      </div>
    </Modal>
  );
};
