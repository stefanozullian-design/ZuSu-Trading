import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  CandlestickChart,
  LogOut,
  Radar,
  ScrollText,
  Wallet,
  LineChart,
  ShieldAlert,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from '@/lib/api';
import { BuildBadge } from '@/components/BuildBadge';
import { ENVIRONMENTS } from '@zusu/shared';
import { EnvironmentBanner } from '@/components/EnvironmentBanner';
import { usePortfolios } from '@/hooks/usePortfolios';
import { useSelectedPortfolio } from '@/hooks/useSelectedPortfolio';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useLiveEvents } from '@/hooks/useLiveEvents';
import { AuditPage } from '@/pages/AuditPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { HoldingsPage } from '@/pages/HoldingsPage';
import { LoginPage } from '@/pages/LoginPage';
import { MarketPage } from '@/pages/MarketPage';
import { ScannerPage } from '@/pages/ScannerPage';
import { PerformancePage } from '@/pages/PerformancePage';
import { RiskPage } from '@/pages/RiskPage';
import { cn } from '@/lib/utils';
import type { EnvironmentInfo } from '@/lib/types';

export function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!user) return <LoginPage />;

  return <Shell />;
}

function Shell() {
  const { user, logout, can } = useAuth();
  const { status } = useLiveEvents(true);
  const { portfolios } = usePortfolios();
  const { selectedId } = useSelectedPortfolio(portfolios);
  const selected = portfolios?.find((p) => p.id === selectedId);

  const { data: environment } = useQuery({
    queryKey: ['environment'],
    queryFn: () => api<EnvironmentInfo>('/api/system/environment'),
    staleTime: 5 * 60_000,
  });

  /**
   * The banner describes the book you are in, not the deployment.
   *
   * Portfolios each carry their own environment, so one installation can hold
   * a practice book and a paper one at once. A banner fixed to the deployment
   * default then says "synthetic market data" over a portfolio priced from the
   * real market — false, on the one element that exists precisely so the
   * environment can never be mistaken. It falls back to the deployment when no
   * portfolio is selected, the only time there is nothing more specific to say.
   */
  const shownEnvironment: EnvironmentInfo | undefined =
    environment && selected
      ? { ...environment, ...ENVIRONMENTS[selected.environment], environment: selected.environment }
      : environment;

  return (
    <div className="min-h-dvh bg-background">
      {shownEnvironment && <EnvironmentBanner environment={shownEnvironment} />}

      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-3 py-2 sm:px-6">
          <span className="text-sm font-semibold tracking-tight">ZuSu Trading</span>

          <nav className="flex items-center gap-1">
            <NavItem to="/" icon={<Activity className="h-4 w-4" aria-hidden />} label="Dashboard" />
            {can('position:read') && (
              <NavItem
                to="/holdings"
                icon={<Wallet className="h-4 w-4" aria-hidden />}
                label="Holdings"
              />
            )}
            {can('market_data:read') && (
              <NavItem
                to="/market"
                icon={<CandlestickChart className="h-4 w-4" aria-hidden />}
                label="Market"
              />
            )}
            {can('market_data:read') && (
              <NavItem
                to="/scanner"
                icon={<Radar className="h-4 w-4" aria-hidden />}
                label="Scanner"
              />
            )}
            {can('performance:read') && (
              <NavItem
                to="/performance"
                icon={<LineChart className="h-4 w-4" aria-hidden />}
                label="Performance"
              />
            )}
            {can('risk:read') && (
              <NavItem
                to="/risk"
                icon={<ShieldAlert className="h-4 w-4" aria-hidden />}
                label="Risk"
              />
            )}
            {can('audit:read') && (
              <NavItem
                to="/audit"
                icon={<ScrollText className="h-4 w-4" aria-hidden />}
                label="Audit"
              />
            )}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <span
              className="hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex"
              title={`Live updates: ${status}`}
            >
              {status === 'open' ? (
                <Wifi className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
              ) : (
                <WifiOff className="h-3.5 w-3.5 text-amber-400" aria-hidden />
              )}
              {status === 'open' ? 'live' : status}
            </span>
            <BuildBadge />
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {user?.displayName} · {user?.role}
            </span>
            <Button variant="ghost" size="icon" onClick={() => void logout()} aria-label="Sign out">
              <LogOut className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      </header>

      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route
          path="/holdings"
          element={can('position:read') ? <HoldingsPage /> : <Navigate to="/" />}
        />
        <Route
          path="/market"
          element={can('market_data:read') ? <MarketPage /> : <Navigate to="/" />}
        />
        <Route
          path="/scanner"
          element={can('market_data:read') ? <ScannerPage /> : <Navigate to="/" />}
        />
        <Route
          path="/performance"
          element={can('performance:read') ? <PerformancePage /> : <Navigate to="/" />}
        />
        <Route path="/risk" element={can('risk:read') ? <RiskPage /> : <Navigate to="/" />} />
        <Route path="/audit" element={can('audit:read') ? <AuditPage /> : <Navigate to="/" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

function NavItem({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
          isActive ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60',
        )
      }
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </NavLink>
  );
}
