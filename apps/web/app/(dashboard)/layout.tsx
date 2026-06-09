import Link from 'next/link';

const navItems = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/dashboard/agents', label: 'Agents' },
  { href: '/dashboard/issues', label: 'Issues' },
  { href: '/dashboard/goals', label: 'Goals' },
  { href: '/dashboard/approvals', label: 'Approvals' },
  { href: '/dashboard/activity', label: 'Activity' },
  { href: '/dashboard/settings', label: 'Settings' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 border-r bg-card flex flex-col shrink-0">
        <div className="p-4 border-b">
          <span className="font-bold text-lg tracking-tight">Paperclip</span>
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center px-3 py-2 rounded-md text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="p-4 border-t text-xs text-muted-foreground">
          LM Studio — Local
        </div>
      </aside>
      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-background">
        {children}
      </main>
    </div>
  );
}
