'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
    { href: '/ai-training', label: 'Upload & Review' },
    { href: '/faq',         label: 'FAQ Manager' },
    { href: '/faq/browse',  label: 'FAQ Browser' },
];

export default function TrainingTabs() {
    const pathname = usePathname();

    const active = (href) => {
        if (href === '/faq') return pathname === '/faq' || pathname === '/faq/';
        if (href === '/faq/browse') return pathname === '/faq/browse' || pathname.startsWith('/faq/browse/');
        return pathname === href || pathname.startsWith(href + '/');
    };

    return (
        <div style={{
            display: 'flex', gap: 0,
            borderBottom: '2px solid var(--border)',
            marginBottom: 24,
        }}>
            {TABS.map(tab => {
                const isActive = active(tab.href);
                return (
                    <Link
                        key={tab.href}
                        href={tab.href}
                        style={{
                            padding: '10px 20px',
                            fontWeight: isActive ? 700 : 500,
                            fontSize: 13,
                            color: isActive ? 'var(--primary)' : 'var(--text-2)',
                            textDecoration: 'none',
                            borderBottom: isActive ? '2px solid var(--primary)' : '2px solid transparent',
                            marginBottom: -2,
                            transition: 'all 0.15s',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {tab.label}
                    </Link>
                );
            })}
        </div>
    );
}
