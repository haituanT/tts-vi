import { Inter } from 'next/font/google'
import './globals.css'
import type { ReactNode } from 'react'
import ErrorSoundListener from '../components/ErrorSoundListener'

const inter = Inter({
  subsets: ['latin', 'vietnamese'],
  fallback: ['Segoe UI', 'Arial', 'sans-serif'],
  display: 'swap',
})

export const metadata = {
  title: 'Reup Studio',
  description: 'Desktop-style video subtitle editor for dubbing and reup workflows',
  keywords: 'reup studio, subtitle editor, dubbing, video, translation',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body className={inter.className}>
        <ErrorSoundListener />
        {children}
      </body>
    </html>
  )
}
