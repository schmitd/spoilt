import { X } from "lucide-preact";
import type { ComponentChildren } from "preact";

interface ToastProps {
  children: ComponentChildren;
  action?: { label: string; onClick: () => void };
  onDismiss: () => void;
}

export function Toast({ children, action, onDismiss }: ToastProps) {
  return (
    <div class="toast" role="status">
      <span>{children}</span>
      {action && <button class="toast__action" type="button" onClick={action.onClick}>{action.label}</button>}
      <button class="icon-button" type="button" aria-label="Dismiss message" onClick={onDismiss}>
        <X size={18} />
      </button>
    </div>
  );
}
