import type { ComponentChildren, JSX } from "preact";

type ButtonTone = "primary" | "secondary" | "success" | "danger" | "quiet";

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  children: ComponentChildren;
  icon?: ComponentChildren;
  tone?: ButtonTone;
  loading?: boolean;
}

export function Button({
  children,
  icon,
  tone = "secondary",
  loading = false,
  class: className,
  disabled,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      class={`button button--${tone}${className ? ` ${className}` : ""}`}
      disabled={disabled || loading}
      aria-busy={loading}
      type={type}
    >
      <span class="button__icon" aria-hidden="true">{loading ? <span class="spinner" /> : icon}</span>
      <span>{children}</span>
    </button>
  );
}
