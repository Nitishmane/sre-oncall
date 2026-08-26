import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "SRE-Oncall console",
  description: "An AI on-call engineer: alert triage, approval-gated remediation, postmortems.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
