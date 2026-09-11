import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api } from '@/lib/api';
import type { AuthenticatedUser, LoginResponse, MfaEnrolment } from '@/lib/types';

interface AuthState {
  user: AuthenticatedUser | null;
  loading: boolean;
  login(email: string, password: string, totp?: string): Promise<LoginResponse>;
  beginEnrolment(mfaToken: string): Promise<MfaEnrolment>;
  completeMfa(mfaToken: string, totp: string): Promise<void>;
  logout(): Promise<void>;
  can(permission: string): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [loading, setLoading] = useState(true);

  // An existing session survives a page reload: the cookie is still there, so
  // ask the API who we are rather than forcing a fresh sign-in.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await api<AuthenticatedUser>('/api/auth/me');
        if (!cancelled) setUser(me);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string, totp?: string) => {
    const result = await api<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: { email, password, ...(totp ? { totp } : {}) },
    });
    if (result.status === 'AUTHENTICATED') setUser(result.user);
    return result;
  }, []);

  const beginEnrolment = useCallback(
    (mfaToken: string) =>
      api<MfaEnrolment>('/api/auth/mfa/enrol', { method: 'POST', body: { mfaToken } }),
    [],
  );

  const completeMfa = useCallback(async (mfaToken: string, totp: string) => {
    const result = await api<{ user: AuthenticatedUser }>('/api/auth/mfa/verify', {
      method: 'POST',
      body: { mfaToken, totp },
    });
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      // A already-expired session still ends locally.
      if (!(err instanceof ApiError)) throw err;
    }
    setUser(null);
  }, []);

  const can = useCallback(
    (permission: string) => user?.permissions.includes(permission) ?? false,
    [user],
  );

  const value = useMemo<AuthState>(
    () => ({ user, loading, login, beginEnrolment, completeMfa, logout, can }),
    [user, loading, login, beginEnrolment, completeMfa, logout, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider');
  return ctx;
}
