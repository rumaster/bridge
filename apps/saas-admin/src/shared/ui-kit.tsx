import { forwardRef } from "react";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ComponentPropsWithoutRef,
  ElementType,
  InputHTMLAttributes,
  PropsWithChildren,
  SelectHTMLAttributes,
  TextareaHTMLAttributes
} from "react";
import { Link } from "react-router-dom";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

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
  error?: string;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { error, id, label, className, ...props },
  ref
) {
  const inputId = id ?? label.toLowerCase().replaceAll(" ", "-");
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div className={`text-input ${className ?? ""}`}>
      <label htmlFor={inputId}>{label}</label>
      <input aria-describedby={errorId} aria-invalid={Boolean(error)} id={inputId} ref={ref} {...props} />
      {error ? (
        <span className="field-error" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
});

export interface TextAreaInputProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  error?: string;
}

export const TextAreaInput = forwardRef<HTMLTextAreaElement, TextAreaInputProps>(
  function TextAreaInput({ error, id, label, className, ...props }, ref) {
    const inputId = id ?? label.toLowerCase().replaceAll(" ", "-");
    const errorId = error ? `${inputId}-error` : undefined;

    return (
      <div className={`text-input ${className ?? ""}`}>
        <label htmlFor={inputId}>{label}</label>
        <textarea
          aria-describedby={errorId}
          aria-invalid={Boolean(error)}
          id={inputId}
          ref={ref}
          {...props}
        />
        {error ? (
          <span className="field-error" id={errorId}>
            {error}
          </span>
        ) : null}
      </div>
    );
  }
);

export interface SelectOption {
  label: string;
  value: string;
}

export interface SelectInputProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  error?: string;
  options: SelectOption[];
}

export const SelectInput = forwardRef<HTMLSelectElement, SelectInputProps>(function SelectInput(
  { error, id, label, options, className, ...props },
  ref
) {
  const inputId = id ?? label.toLowerCase().replaceAll(" ", "-");
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div className={`text-input ${className ?? ""}`}>
      <label htmlFor={inputId}>{label}</label>
      <select
        aria-describedby={errorId}
        aria-invalid={Boolean(error)}
        id={inputId}
        ref={ref}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <span className="field-error" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
});

export interface CheckboxInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

export function CheckboxInput({ id, label, className, ...props }: CheckboxInputProps) {
  const inputId = id ?? label.toLowerCase().replaceAll(" ", "-");

  return (
    <label className={`checkbox-input ${className ?? ""}`} htmlFor={inputId}>
      <input id={inputId} type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
}
