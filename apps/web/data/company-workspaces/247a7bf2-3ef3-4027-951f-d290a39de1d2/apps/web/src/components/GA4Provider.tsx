'use client';

import { useEffect, ReactNode } from 'react';
import Script from 'next/script';
import { GA_TRACKING_ID, initGA, pageview } from '@/gtag';
import { usePathname } from 'next/navigation';

export function GA4Provider({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  useEffect(() => {
    // Initialize GA on mount
    initGA();

    // Track page view on load
    const currentPath = window.location.pathname;
    pageview(currentPath);
  }, []);

  // Track page views on route change (for App Router)
  useEffect(() => {
    if (pathname) {
      pageview(pathname);
    }
  }, [pathname]);

  return (
    <>
      {/* GA4 Global Tag */}
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_TRACKING_ID}`}
        strategy="afterInteractive"
      />
      <Script id="gtag-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GA_TRACKING_ID}', {
            page_location: window.location.pathname,
          });
        `}
      </Script>
      {children}
    </>
  );
}
