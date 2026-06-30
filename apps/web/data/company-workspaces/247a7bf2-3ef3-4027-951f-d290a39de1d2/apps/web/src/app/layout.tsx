import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import '../styles/globals.css'
import { usePHUTMTracking } from '@/lib/ph-tracking'
import GA4Provider from '@/components/GA4Provider'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Tourbillon - Tour Planning Platform',
  description: 'Plan your perfect tour with Tourbillon',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Track Product Hunt referral traffic on every page load
  usePHUTMTracking();

  return (
    <html lang="en">
      <body className={inter.className}>
        <GA4Provider>
          {children}
        </GA4Provider>
      </body>
    </html>
  )
}
