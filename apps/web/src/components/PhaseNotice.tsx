import { Hammer } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Props {
  title: string;
  phase: string;
  children: string;
}

/**
 * A panel for a capability that is not built yet.
 *
 * The dashboard deliberately does not render an empty "Active signals" or
 * "Pending approvals" table that could be mistaken for "nothing happening".
 * Where a panel has no engine behind it, it says so and names the phase that
 * brings it (build rule 1: never put a finished UI in front of nothing).
 */
export function PhaseNotice({ title, phase, children }: Props) {
  return (
    <Card className="border-dashed">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {phase}
        </span>
      </CardHeader>
      <CardContent className="flex items-start gap-2">
        <Hammer className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{children}</p>
      </CardContent>
    </Card>
  );
}
