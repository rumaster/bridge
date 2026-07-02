import type { ButtonHTMLAttributes, PropsWithChildren } from "react";

// TODO(SVC-CHAT M1): заменить локальные примитивы на @bridge/ui-kit,
// когда пакет начнет экспортировать общие React-компоненты.
export function WidgetShell({ children }: PropsWithChildren) {
  return <section className="bridge-chat-shell">{children}</section>;
}

export function IconButton({
  children,
  ...props
}: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
  return (
    <button className="bridge-chat-icon-button" type="button" {...props}>
      {children}
    </button>
  );
}

export function PrimaryButton({
  children,
  ...props
}: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
  return (
    <button className="bridge-chat-primary-button" type="submit" {...props}>
      {children}
    </button>
  );
}
