import { useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import type { MfaEnrolment } from '@/lib/types';

type Step =
  | { kind: 'CREDENTIALS' }
  | { kind: 'MFA'; mfaToken: string }
  | { kind: 'ENROL'; mfaToken: string; enrolment: MfaEnrolment };

export function LoginPage() {
  const { login, beginEnrolment, completeMfa } = useAuth();
  const [step, setStep] = useState<Step>({ kind: 'CREDENTIALS' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (err: unknown) =>
    setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');

  const submitCredentials = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(email, password);
      if (result.status === 'MFA_REQUIRED') {
        setStep({ kind: 'MFA', mfaToken: result.mfaToken });
      } else if (result.status === 'MFA_ENROLMENT_REQUIRED') {
        const enrolment = await beginEnrolment(result.mfaToken);
        setStep({ kind: 'ENROL', mfaToken: result.mfaToken, enrolment });
      }
      // On AUTHENTICATED the auth context swaps this page for the dashboard.
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const submitTotp = async (event: FormEvent) => {
    event.preventDefault();
    if (step.kind === 'CREDENTIALS') return;
    setBusy(true);
    setError(null);
    try {
      await completeMfa(step.mfaToken, totp);
    } catch (err) {
      fail(err);
      setTotp('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">ZuSu Trading</h1>
          <p className="text-sm text-muted-foreground">Day-trading automation control centre</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>
              {step.kind === 'CREDENTIALS'
                ? 'Sign in'
                : step.kind === 'MFA'
                  ? 'Authenticator code'
                  : 'Set up two-factor authentication'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {step.kind === 'CREDENTIALS' && (
              <form onSubmit={submitCredentials} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                {error && <p className="text-sm text-loss">{error}</p>}
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? 'Signing in…' : 'Sign in'}
                </Button>
              </form>
            )}

            {step.kind === 'ENROL' && (
              <div className="space-y-4">
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  Administrators must use a second factor. Scan this with an authenticator app, then
                  enter the six-digit code it shows.
                </p>
                <img
                  src={step.enrolment.qrDataUrl}
                  alt="Two-factor authentication QR code"
                  className="mx-auto rounded-md bg-white p-2"
                  width={200}
                  height={200}
                />
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Enter the key manually instead</summary>
                  <code className="mt-1 block break-all font-mono text-[11px]">
                    {step.enrolment.secret}
                  </code>
                </details>
                <form onSubmit={submitTotp} className="space-y-3">
                  <TotpField value={totp} onChange={setTotp} />
                  {error && <p className="text-sm text-loss">{error}</p>}
                  <Button type="submit" className="w-full" disabled={busy || totp.length !== 6}>
                    {busy ? 'Verifying…' : 'Activate and sign in'}
                  </Button>
                </form>
              </div>
            )}

            {step.kind === 'MFA' && (
              <form onSubmit={submitTotp} className="space-y-4">
                <TotpField value={totp} onChange={setTotp} />
                {error && <p className="text-sm text-loss">{error}</p>}
                <Button type="submit" className="w-full" disabled={busy || totp.length !== 6}>
                  {busy ? 'Verifying…' : 'Verify'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Trading involves risk of loss. This software is a tool, not investment advice.
        </p>
      </div>
    </main>
  );
}

function TotpField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="totp">Six-digit code</Label>
      <Input
        id="totp"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        placeholder="000000"
        className="text-center font-mono text-lg tracking-[0.4em]"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        autoFocus
      />
    </div>
  );
}
