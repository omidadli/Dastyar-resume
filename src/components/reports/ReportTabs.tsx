import { Segmented } from '../ui';
import { navigate, useLocation } from '../../lib/router';

const TABS = [
  { id: 'screening', label: 'غربالگری', to: '/app/reports' },
  { id: 'team', label: 'عملکرد تیم', to: '/app/reports/team' },
  { id: 'cost', label: 'هزینهٔ استخدام', to: '/app/reports/cost' },
] as const;

export type ReportTabId = (typeof TABS)[number]['id'];

/**
 * The three reports answer three different questions, so they are three pages —
 * but they share the range, and switching between them must not reset it.
 */
export function ReportTabs({ active }: { active: ReportTabId }) {
  const { query } = useLocation();
  const range = query.get('range');
  return (
    <Segmented<ReportTabId>
      value={active}
      items={TABS.map((t) => ({ id: t.id, label: t.label }))}
      onChange={(id) => {
        const target = TABS.find((t) => t.id === id);
        if (!target || id === active) return;
        navigate(range ? `${target.to}?range=${encodeURIComponent(range)}` : target.to);
      }}
      className="mb-4 overflow-x-auto hv-scroll"
    />
  );
}
