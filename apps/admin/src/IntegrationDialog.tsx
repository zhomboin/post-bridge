import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { integrationStatuses } from './integration-types';
export function IntegrationModal({
  title,
  children,
  onClose,
  closeLabel = '关闭',
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.showModal();
    close.current?.focus();
    const hide = () => {
      if (document.visibilityState === 'hidden') latestClose.current();
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('visibilitychange', hide);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  function trap(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
    const controls = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
      ),
    ];
    if (event.shiftKey && document.activeElement === controls[0]) {
      event.preventDefault();
      controls.at(-1)?.focus();
    } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
      event.preventDefault();
      controls[0]?.focus();
    }
  }
  return (
    <dialog
      className={'integration-modal ' + className}
      ref={dialog}
      aria-labelledby="integration-modal-title"
      onKeyDown={trap}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="surface-header">
        <h2 id="integration-modal-title">{title}</h2>
        <button ref={close} type="button" onClick={onClose}>
          {closeLabel}
        </button>
      </div>
      <div className="surface-body">{children}</div>
    </dialog>
  );
}
export function IntegrationState({ value }: { value: string }) {
  return (
    <span className={'status integration-state ' + value}>
      {integrationStatuses[value] || '未知状态'}
    </span>
  );
}
