import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
type Size = "default" | "sm" | "lg" | "icon";

const variants: Record<Variant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  outline: "border border-input bg-background hover:bg-muted",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "hover:bg-muted",
  destructive: "bg-destructive text-white hover:bg-destructive/90",
  link: "text-primary underline-offset-4 hover:underline",
};
const sizes: Record<Size, string> = {
  default: "h-9 px-4 py-2",
  sm: "h-8 px-3 text-sm",
  lg: "h-10 px-6",
  icon: "size-9",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Render as the child element instead of a <button>. */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", asChild = false, children, ...props }, ref) => {
    const baseClass = cn(
      "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
      variants[variant],
      sizes[size],
      className,
    );
    if (asChild && React.isValidElement(children)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const child = children as React.ReactElement<any>;
      return React.cloneElement(child, {
        ...props,
        ref,
        className: cn(baseClass, child.props.className),
      });
    }
    return (
      <button
        ref={ref}
        data-slot="button"
        className={baseClass}
        {...props}
      >
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
