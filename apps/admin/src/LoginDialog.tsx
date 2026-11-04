import { useEffect, useRef, type ReactNode, type RefObject, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';

export default function LoginDialog({ children, onClose, trigger }: { children: ReactNode; onClose: () => void; trigger: RefObject<HTMLButtonElement | null> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = trigger.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.showModal();
    return () => {
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  }, [trigger]);
  function containFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'));
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  return <dialog ref={dialog} className="login-dialog" aria-labelledby="remote-login-title" onKeyDown={containFocus} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="surface-header"><h2 id="remote-login-title">CSDN 登录</h2><button type="button" aria-label="关闭登录弹窗" onClick={onClose}><X size={18} aria-hidden="true" /></button></div>
    <div className="login-dialog-body">{children}</div>
  </dialog>;
}
