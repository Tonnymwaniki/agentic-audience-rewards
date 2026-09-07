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

// PWA wiring goes through Next's metadata API rather than hand-written <head>
// tags. In the App Router a literal <head> in a layout is not merged with the
// metadata Next already emits, so writing both would produce duplicate
// <meta name="theme-color"> and manifest links. These fields render exactly the
// tags the install prompt needs — verified against the served HTML.
export const metadata: Metadata = {
  title: "Notice — Audience Intelligence On-Chain",
  description: "Notice reads every comment, understands what matters, and rewards the people who do — automatically, on-chain.",
  applicationName: "Notice",
  manifest: "/manifest.json",
  icons: {
    icon: "/icon-192.png",
    apple: "/icon-192.png",
  },
  // Emits apple-mobile-web-app-capable / -status-bar-style / -title. iOS ignores
  // most of manifest.json, so these are what actually make an installed icon open
  // full-screen instead of in a Safari tab.
  appleWebApp: {
    capable: true,
    title: "Notice",
    statusBarStyle: "black-translucent",
  },
  other: {
    // appleWebApp.capable above emits only the modern `mobile-web-app-capable`
    // in Next 16 — it no longer writes the apple-prefixed tag. Older iOS versions
    // still read that one, so it's added here by hand. Verified against the served
    // HTML that this produces exactly one of each, not a duplicate.
    "apple-mobile-web-app-capable": "yes",
  },
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
  // Colours the Android status bar / task-switcher chrome to match the app ground.
  themeColor: "#0A0A1F",
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
