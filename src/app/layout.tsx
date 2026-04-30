import type { Metadata } from "next";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";

import { ThemeProvider } from "@/components/theme-provider";

import "./globals.css";

const sans = Hanken_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ScienceSwarm — AI-Powered Research Workspace",
  description:
    "Literature review to publication. One workspace for your entire research study.",
};

/**
 * No-flash theme script — runs synchronously before paint, reads the
 * persisted theme preference from localStorage, and sets data-theme on
 * <html> so the first paint is already in the correct theme. Keep this
 * script minimal; it ships into every HTML document.
 */
const themeInitScript = `
(function(){
  try {
    var stored = localStorage.getItem('scienceswarm.theme');
    // Fresh installs default to light. A saved Settings > Appearance
    // choice still wins and is not inferred from OS preference.
    var theme = stored === 'light' || stored === 'dark' ? stored : 'light';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full flex flex-col font-sans">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
