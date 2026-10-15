import {
  Calculator,
  Code2,
  Factory,
  FlaskConical,
  Headset,
  LayoutGrid,
  Megaphone,
  ShieldCheck,
  ShoppingCart,
  Truck,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  sales: ShoppingCart,
  marketing: Megaphone,
  finance: Calculator,
  hr: Users,
  it: Code2,
  manufacturing: Factory,
  engineering: Wrench,
  logistics: Truck,
  qc: ShieldCheck,
  support: Headset,
  rd: FlaskConical,
};

export function departmentIcon(id: string): LucideIcon {
  return ICONS[id] || LayoutGrid;
}
