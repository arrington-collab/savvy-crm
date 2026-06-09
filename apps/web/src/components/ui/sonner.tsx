"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

// Minimal Toaster wrapper (no next-themes / icon-lib dependency in Phase 0).
const Toaster = (props: ToasterProps) => (
  <Sonner
    className="toaster group"
    style={
      {
        "--normal-bg": "var(--popover)",
        "--normal-text": "var(--popover-foreground)",
        "--normal-border": "var(--border)",
      } as React.CSSProperties
    }
    {...props}
  />
);

export { Toaster };
