"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

export type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(({ className, ...props }, ref) => (
  <input ref={ref} type="checkbox"
    className={cn("size-4 rounded border-input accent-primary disabled:opacity-50", className)} {...props} />
));
Checkbox.displayName = "Checkbox";
