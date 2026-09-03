import "./globals.css";
import PWARegister from "./pwa-register";

export const metadata = {
  title: "フランス語 会話練習",
  description: "教材をアップロードして、AIとフランス語の会話練習をするアプリ",
  manifest: "/manifest.json",
  themeColor: "#1c2b4a",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "仏語会話練習"
  },
  icons: {
    icon: "/icon.svg",
    apple: "/apple-touch-icon.svg"
  }
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#1c2b4a"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="仏語会話練習" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body>
        <PWARegister />
        {children}
      </body>
    </html>
  );
}
