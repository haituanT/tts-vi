'use client';

import { useEffect } from 'react';
import { playErrorSound } from '../lib/audioFeedback';

export default function ErrorSoundListener() {
  useEffect(() => {
    const onError = () => playErrorSound();

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onError);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onError);
    };
  }, []);

  return null;
}
