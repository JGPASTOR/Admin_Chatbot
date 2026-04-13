'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';

const navItems = [
    {
        href: '/dashboard',
        label: 'DASHBOARD',
        icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" />
            </svg>
        ),
    },
    {
        href: '/documents',
        label: 'DOCUMENTS',
        icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
            </svg>
        ),
    },
    {
        href: '/offices',
        label: 'OFFICES',
        icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
        ),
    },
    {
        href: '/ai-training',
        label: 'BOT TRAINING',
        matchPaths: ['/ai-training', '/faq'],
        icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M12 2a5 5 0 1 1 0 10A5 5 0 0 1 12 2z" />
                <path d="M12 12v2m0 4v2M8 16l-1.5 1.5M16 16l1.5 1.5M6 12H4m16 0h-2" />
                <circle cx="12" cy="7" r="2" fill="currentColor" stroke="none" />
            </svg>
        ),
    },
    {
        href: '/knowledge-map',
        label: 'AI BRAIN',
        icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <circle cx="12" cy="5"  r="2" /><circle cx="5"  cy="12" r="2" />
                <circle cx="19" cy="12" r="2" /><circle cx="8"  cy="19" r="2" />
                <circle cx="16" cy="19" r="2" /><circle cx="12" cy="12" r="2.5" />
                <line x1="12" y1="7"  x2="12" y2="9.5" />
                <line x1="7"  y1="12" x2="9.5" y2="12" />
                <line x1="14.5" y1="12" x2="17" y2="12" />
                <line x1="9.5"  y1="14" x2="8.5" y2="17" />
                <line x1="14.5" y1="14" x2="15.5" y2="17" />
            </svg>
        ),
    },
    {
        href: '/needs-review',
        label: 'NEEDS REVIEW',
        badge: true,
        icon: (
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
        ),
    },
];

export default function Sidebar() {
    const pathname = usePathname();
    const [pendingCount, setPendingCount] = useState(0);

    useEffect(() => {
        const fetchCount = async () => {
            try {
                const res = await fetch('/api/flagged-queries/count');
                const data = await res.json();
                if (data.success) setPendingCount(data.pending || 0);
            } catch { /* non-fatal */ }
        };
        fetchCount();
        // Refresh every 60 seconds
        const interval = setInterval(fetchCount, 60000);
        return () => clearInterval(interval);
    }, []);

    return (
        <aside style={{
            width: 'var(--sidebar-w)',
            minHeight: '100vh',
            background: 'var(--primary-dark)',
            display: 'flex',
            flexDirection: 'column',
            position: 'fixed',
            left: 0, top: 0, bottom: 0,
            zIndex: 100,
            boxShadow: '4px 0 12px rgba(0,0,0,0.15)',
        }}>
            {/* Logo */}
            <div style={{
                padding: '20px 20px 16px',
                borderBottom: '1px solid rgba(255,255,255,0.1)',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                        width: 38, height: 38, borderRadius: 10,
                        background: 'var(--primary-accent)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                        <svg width="20" height="20" fill="white" viewBox="0 0 24 24">
                            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" stroke="white" strokeWidth="2" fill="none" />
                        </svg>
                    </div>
                    <div>
                        <div style={{ color: '#fff', fontWeight: 700, fontSize: 13, lineHeight: 1.2 }}>DocTrack</div>
                        <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: 500 }}>Admin Portal</div>
                    </div>
                </div>
            </div>

            {/* Nav */}
            <nav style={{ padding: '12px 12px', flex: 1 }}>
                <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: 600, letterSpacing: '0.8px', textTransform: 'uppercase', padding: '8px 8px 6px' }}>
                    Main Menu
                </div>
                {navItems.map(item => {
                    let active = false;
                    const paths = item.matchPaths || [item.href];
                    active = paths.some(p => pathname === p || pathname.startsWith(p + '/'));
                    
                    const badgeCount = item.badge ? pendingCount : 0;
                    return (
                        <Link key={item.href} href={item.href} style={{
                            position: 'relative',
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '10px 12px', borderRadius: 8, marginBottom: 2,
                            color: active ? '#fff' : 'rgba(255,255,255,0.65)',
                            background: active ? 'rgba(255,255,255,0.12)' : 'transparent',
                            textDecoration: 'none', fontWeight: active ? 600 : 400,
                            fontSize: 13, transition: 'all 0.15s ease',
                            overflow: 'hidden'
                        }}>
                            {active && (
                                <div style={{
                                    position: 'absolute',
                                    left: 0, top: 0, bottom: 0, width: 3,
                                    background: 'var(--primary-accent)',
                                }} />
                            )}
                            <span style={{ opacity: active ? 1 : 0.7, paddingLeft: 2 }}>{item.icon}</span>
                            <span style={{ flex: 1 }}>{item.label}</span>
                            {badgeCount > 0 && (
                                <span style={{
                                    background: '#ef4444',
                                    color: '#fff',
                                    borderRadius: 10,
                                    fontSize: 10,
                                    fontWeight: 700,
                                    padding: '1px 6px',
                                    minWidth: 18,
                                    textAlign: 'center',
                                }}>
                                    {badgeCount > 99 ? '99+' : badgeCount}
                                </span>
                            )}
                        </Link>
                    );
                })}
            </nav>

            {/* Footer */}
            <div style={{
                padding: '16px 20px',
                borderTop: '1px solid rgba(255,255,255,0.1)',
                display: 'flex', alignItems: 'center', gap: 10,
            }}>
                <div style={{
                    width: 34, height: 34, borderRadius: '50%',
                    background: 'var(--primary-accent)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13, fontWeight: 700, color: '#fff',
                }}>A</div>
                <div>
                    <div style={{ color: '#fff', fontSize: 12, fontWeight: 600 }}>Admin</div>
                    <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10 }}>Administrator</div>
                </div>
            </div>
        </aside>
    );
}
