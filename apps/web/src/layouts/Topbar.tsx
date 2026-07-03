import { useState } from 'react';
import { useNavigate } from 'react-router';
import { LogOut, Menu } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetHeader } from '@/components/ui/sheet';
import { useAuth } from '@/hooks/useAuth';
import { SidebarContent } from './SidebarContent';

/** Top app bar: title (links home), sign-out, and a mobile menu toggle that opens the nav in a Sheet drawer. */
export function Topbar() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const handleSignOut = async () => {
    try {
      await signOut();
      navigate('/');
    } catch {
      toast.error('Failed to sign out. Please try again.');
    }
  };

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-background px-4">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        aria-label="Open menu"
        onClick={() => setMobileNavOpen(true)}
      >
        <Menu className="size-5" />
      </Button>

      <button
        type="button"
        onClick={() => navigate('/dashboard')}
        className="text-lg font-semibold tracking-tight"
      >
        Smash Tracker
      </button>

      <div className="flex-1" />

      <Button variant="ghost" size="icon" aria-label="Sign out" onClick={handleSignOut}>
        <LogOut className="size-5" />
      </Button>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <SidebarContent onNavigate={() => setMobileNavOpen(false)} />
        </SheetContent>
      </Sheet>
    </header>
  );
}
