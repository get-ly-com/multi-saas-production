import { Head, Html, Main, NextScript } from 'next/document';
import { THEME_COLOURS, THEME_SCRIPT } from '@/lib/theme';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" type="image/svg+xml" href="/icons/favicon.svg" />
        <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content={THEME_COLOURS.light} />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content={THEME_COLOURS.dark} />
        <meta name="color-scheme" content="light dark" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Get-ly" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        {/* Sets the light or dark theme before anything paints, so there is no flash */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
