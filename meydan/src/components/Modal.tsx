import {
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
  type KeyboardEvent,
  type SyntheticEvent,
} from "react";
import { X } from "lucide-react";

type ModalProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  focusKey?: string | number;
};

export function Modal({ open, title, onClose, children, initialFocusRef, returnFocusRef, focusKey }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const previousFocusKeyRef = useRef<string | number | undefined>(undefined);
  const titleId = useId();

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || !dialog.isConnected) {
      return;
    }

    if (open) {
      const opening = !dialog.open;
      if (opening) {
        const activeElement = document.activeElement;
        openerRef.current = activeElement instanceof HTMLElement &&
          activeElement !== document.body &&
          activeElement !== document.documentElement
          ? activeElement
          : null;
        dialog.showModal();
      }
      if (opening || previousFocusKeyRef.current !== focusKey) {
        (initialFocusRef?.current ?? titleRef.current)?.focus({ preventScroll: true });
      }
      previousFocusKeyRef.current = focusKey;
      return;
    }

    if (!dialog.open) {
      previousFocusKeyRef.current = focusKey;
      return;
    }
    dialog.close();

    const opener = openerRef.current;
    openerRef.current = null;
    const openerCanRestore = opener?.isConnected === true &&
      !opener.matches(":disabled") &&
      opener.getClientRects().length > 0;
    const restoreTarget = openerCanRestore ? opener : returnFocusRef?.current;
    window.requestAnimationFrame(() => {
      if (restoreTarget?.isConnected && !restoreTarget.matches(":disabled") && restoreTarget.getClientRects().length > 0) {
        restoreTarget.focus({ preventScroll: true });
      }
      if (document.activeElement !== restoreTarget) {
        returnFocusRef?.current?.focus({ preventScroll: true });
      }
    });
    previousFocusKeyRef.current = focusKey;
  }, [focusKey, initialFocusRef, open, returnFocusRef]);

  function handleCancel(event: SyntheticEvent<HTMLDialogElement>): void {
    event.preventDefault();
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>): void {
    if (event.key !== "Tab") {
      return;
    }

    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }

    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }

    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog"
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={handleCancel}
      onKeyDown={handleKeyDown}
    >
      <div className="modal-frame">
        <header className="modal-header">
          <h2 className="modal-title" id={titleId} ref={titleRef} tabIndex={-1}>
            {title}
          </h2>
          <button
            className="modal-close"
            type="button"
            aria-label="Close dialog"
            title="Close dialog"
            onClick={onClose}
          >
            <X size={18} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </div>
    </dialog>
  );
}
