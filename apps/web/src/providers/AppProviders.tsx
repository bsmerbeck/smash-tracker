import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';

/** Top-level providers: TanStack Query + Firebase auth context + global analytics filter + sonner toaster. */
export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AnalyticsFilterProvider>
          {children}
          <Toaster richColors position="top-right" />
        </AnalyticsFilterProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
