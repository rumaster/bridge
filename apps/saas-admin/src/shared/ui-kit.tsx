import { forwardRef } from "react";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ComponentPropsWithoutRef,
  ElementType,
  InputHTMLAttributes,
  PropsWithChildren
} from "react";
import { Link } from "react-router-dom";

type ButtonVariant = "primary" | "secondary" | "ghost";

type NativeButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  asLink?: false;
  variant?: ButtonVariant;
};

type LinkButtonProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  asLink: true;
  to: string;
  variant?: ButtonVariant;
};

export type ButtonProps = NativeButtonProps | LinkButtonProps;

export function Button(props: ButtonProps) {
  const className = `button ${props.variant ?? "primary"} ${props.className ?? ""}`;

  if (props.asLink) {
    const { asLink: _asLink, variant: _variant, className: _className, to, ...rest } = props;
    return <Link className={className} to={to} {...rest} />;
  }

  const { variant: _variant, className: _className, ...rest } = props;
  return <button className={className} {...rest} />;
}

interface BadgeProps extends PropsWithChildren {
  tone?: "neutral" | "success" | "warning";
}

export function Badge({ children, tone = "neutral" }: BadgeProps) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

type PanelProps<TElement extends ElementType> = PropsWithChildren<
  {
    as?: TElement;
    className?: string;
  } & Omit<ComponentPropsWithoutRef<TElement>, "as" | "className">
>;

export function Panel<TElement extends ElementType = "div">({
  as,
  children,
  className,
  ...rest
}: PanelProps<TElement>) {
  const Component = as ?? "div";

  return (
    <Component className={`panel ${className ?? ""}`} {...rest}>
      {children}
    </Component>
  );
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { id, label, className, ...props },
  ref
) {
  const inputId = id ?? label.toLowerCase().replaceAll(" ", "-");

  return (
    <label className={`text-input ${className ?? ""}`} htmlFor={inputId}>
      <span>{label}</span>
      <input id={inputId} ref={ref} {...props} />
    </label>
  );
});
