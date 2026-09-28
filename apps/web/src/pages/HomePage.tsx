import { useQuery } from '@tanstack/react-query';
import { meQuery } from '../api/auth';
import { card } from '../components/styles';

export function HomePage() {
  const { data: me } = useQuery(meQuery);
  if (!me) return null;
  return (
    <section className={card}>
      <h1 data-testid="home-welcome" className="text-2xl font-semibold tracking-tight">
        Welcome, {me.displayName}
      </h1>
      <p className="mt-2 text-sm text-muted">Channels are coming soon.</p>
    </section>
  );
}
