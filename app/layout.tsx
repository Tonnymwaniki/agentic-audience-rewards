import type { Metadata, Viewport } from "next";
import { Fraunces, Inter, JetBrains_Mono, Geist, Geist_Mono } from "next/font/google";
import { ThirdwebProvider } from "thirdweb/react";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-display",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500"],
  variable: "--font-mono",
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Notice — Audience Intelligence On-Chain",
  description: "Notice reads every comment, understands what matters, and rewards the people who do — automatically, on-chain.",
};

// viewportFit: 'cover' is what makes env(safe-area-inset-*) resolve to real values
// on notched phones — without it the browser reports 0px and the mobile tab bar
// would sit underneath the home indicator. Next's default viewport tag omits it.
// The matching left/right insets are applied to <body> in globals.css so that
// letting content reach the screen edges doesn't push it under the notch in
// landscape.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${inter.variable} ${jetbrainsMono.variable} ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThirdwebProvider>
          {children}
        </ThirdwebProvider>
      </body>
    </html>
  );
}
