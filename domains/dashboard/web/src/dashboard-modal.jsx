import { t } from './dashboard-i18n.js';
import { useDashboardLanguage } from './dashboard-language.jsx';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Button, Modal, Tooltip } from 'antd';
import { CloseOutlined, FullscreenExitOutlined, FullscreenOutlined } from '@ant-design/icons';

const DashboardPortalContext = createContext(null);

export function DashboardPortalProvider({ container, children }) {
  useDashboardLanguage();
  return (
    <DashboardPortalContext.Provider value={container}>{children}</DashboardPortalContext.Provider>
  );
}

export function useDashboardModalState(open) {
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      fullscreenRef.current = false;
      setFullscreen(false);
    }
  }, [open]);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((value) => {
      const next = !value;
      fullscreenRef.current = next;
      return next;
    });
  }, []);
  const requestClose = useCallback((onClose) => {
    if (fullscreenRef.current) {
      fullscreenRef.current = false;
      setFullscreen(false);
      return;
    }
    onClose();
  }, []);

  return { fullscreen, toggleFullscreen, requestClose };
}

function DashboardModalTitle({
  title,
  subtitle,
  description,
  fullscreen,
  onToggleFullscreen,
  showFullscreen,
  showCloseButton,
  onClose,
}) {
  useDashboardLanguage();
  return (
    <div className="dashboard-modal-title dashboard-settings-modal-title">
      <div className="dashboard-modal-title-copy dashboard-settings-modal-title-copy">
        <div>
          <div className="dashboard-settings-modal-title-row">
            <strong>{title}</strong>
            {subtitle && <span className="dashboard-tool-counter">{subtitle}</span>}
          </div>
          {description && <p>{description}</p>}
        </div>
      </div>
      {showFullscreen && (
        <Tooltip title={fullscreen ? t('退出全屏') : t('全屏展示')} placement="bottom">
          <Button
            className="dashboard-modal-expand dashboard-settings-modal-expand"
            type="text"
            icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            aria-label={fullscreen ? t('退出全屏') : t('全屏展示')}
            aria-pressed={fullscreen}
            onClick={onToggleFullscreen}
            onKeyDown={(event) => {
              if (fullscreen && event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }
            }}
          />
        </Tooltip>
      )}
      {showCloseButton && (
        <Button
          className="dashboard-modal-expand dashboard-modal-close"
          type="text"
          icon={<CloseOutlined />}
          aria-label={t('关闭窗口')}
          onClick={onClose}
        />
      )}
    </div>
  );
}

export function DashboardModal({
  open,
  title,
  subtitle,
  description,
  ariaLabel,
  width = 720,
  className = '',
  rootClassName = '',
  footer,
  onClose,
  showFullscreen = true,
  showCloseButton = false,
  children,
  ...modalProps
}) {
  useDashboardLanguage();
  const portalContainer = useContext(DashboardPortalContext);
  const { fullscreen, toggleFullscreen, requestClose } = useDashboardModalState(open);
  const modalClassName = ['dashboard-modal', className, fullscreen ? 'is-fullscreen' : '']
    .filter(Boolean)
    .join(' ');
  const modalRootClassName = [
    'dashboard-modal-root',
    rootClassName,
    fullscreen ? 'is-fullscreen' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Modal
      {...modalProps}
      getContainer={modalProps.getContainer ?? portalContainer ?? undefined}
      rootClassName={modalRootClassName}
      className={modalClassName}
      centered
      width={fullscreen ? '100vw' : width}
      open={open}
      keyboard
      mask={{ closable: true }}
      destroyOnHidden
      closeIcon={null}
      aria-label={ariaLabel}
      onCancel={() => requestClose(onClose)}
      title={
        <DashboardModalTitle
          title={title}
          subtitle={subtitle}
          description={description}
          fullscreen={fullscreen}
          onToggleFullscreen={toggleFullscreen}
          showFullscreen={showFullscreen}
          showCloseButton={showCloseButton}
          onClose={() => requestClose(onClose)}
        />
      }
      footer={footer}
    >
      {typeof children === 'function' ? children({ fullscreen }) : children}
    </Modal>
  );
}
