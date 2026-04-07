'use client';
import { usePathname } from 'next/navigation';
import Sidebar from './Sidebar';

export default function AppShell({ children }) {
    const pathname = usePathname();
    const isOnboarding = pathname === '/onboarding';

    if (isOnboarding) {
        return <>{children}</>;
    }

    return (
        <div style={{ display: 'flex', minHeight: '100vh' }}>
            <Sidebar />
            <div style={{
                marginLeft: 'var(--sidebar-w)',
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                minHeight: '100vh',
                background: 'var(--bg)',
            }}>
                {children}
            </div>
        </div>
    );
}
