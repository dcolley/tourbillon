'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import {
  Activity,
  Bot,
  CheckCircle2,
  FolderKanban,
  LayoutDashboard,
  ListTodo,
  Server,
  Settings,
  Target,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Logo } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar';

const navItems: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/agent', label: 'Agents', icon: Bot },
  { href: '/issue', label: 'Issues', icon: ListTodo },
  { href: '/goal', label: 'Goals', icon: Target },
  { href: '/project', label: 'Projects', icon: FolderKanban },
  { href: '/approval', label: 'Approvals', icon: CheckCircle2 },
  { href: '/activity', label: 'Activity', icon: Activity },
  { href: '/jobs', label: 'Jobs', icon: Server },
  { href: '/settings', label: 'Settings', icon: Settings },
];

function isActive(href: string, pathname: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SidebarCookieSync() {
  const { setOpen } = useSidebar();

  useEffect(() => {
    const match = document.cookie.match(/(?:^|;\s*)sidebar_state=([^;]+)/);
    if (match) setOpen(match[1] === 'true');
  }, [setOpen]);

  return null;
}

export function DashboardSidebar() {
  const pathname = usePathname();

  return (
    <>
      <SidebarCookieSync />
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                render={<Link href="/dashboard" />}
                className="data-[slot=sidebar-menu-button]:!p-1.5"
              >
                <Logo size={28} />
                <span className="text-base font-semibold tracking-tight">Tourbillon</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => {
                  const active = isActive(item.href, pathname);
                  const Icon = item.icon;
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        render={<Link href={item.href} />}
                        isActive={active}
                        tooltip={item.label}
                      >
                        <Icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <div className="flex items-center justify-between gap-2 px-2 py-1 group-data-[collapsible=icon]:justify-center">
                <span className="truncate text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                  LM Studio — Local
                </span>
                <ThemeToggle />
              </div>
            </SidebarMenuItem>
          </SidebarMenu>
          <SidebarSeparator />
        </SidebarFooter>

        <SidebarRail />
      </Sidebar>
    </>
  );
}
