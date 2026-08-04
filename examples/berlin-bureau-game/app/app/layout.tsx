import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Berlin Bureau — The Hollow King",
  description:
    "A Cold War intelligence puzzle. Grade your sources, corroborate before you name, and hold the contradictions open. A playable demo of daftari discipline.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
