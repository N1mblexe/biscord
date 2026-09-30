// First: configures zod before any schema is built (see the module).
import './zodJitless';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { initLocale } from './i18n/store';
import { installFileDropGuard } from './lib/fileDropGuard';
import { queryClient } from './queryClient';
import { router } from './router';
import './index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}

// The UI language before login (CONTRACTS B.11 rule 3), also set on <html lang>, before the first render.
initLocale();

// A file dropped outside the channel view's drop zone must never replace the app with the file.
installFileDropGuard();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
