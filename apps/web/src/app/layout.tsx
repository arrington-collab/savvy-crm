import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Savvy",
  description: "AI-driven roofing operations",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const body = (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {children}
        <Toaster />
      </body>
    </html>
  );
  // In TEST_MODE skip ClerkProvider so e2e needs no Clerk keys.
  return process.env.TEST_MODE === "1" ? body : <ClerkProvider>{body}</ClerkProvider>;
}
