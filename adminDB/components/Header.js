'use client';
export default function Header({ title, subtitle }) {
    return (
        <header style={{
            height: 'var(--header-h)',
            background: 'var(--surface)',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 28px',
            position: 'sticky',
            top: 0,
            zIndex: 50,
            boxShadow: 'var(--shadow)',
        }}>
            <div>
                <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{title}</h2>
                {subtitle && <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 1 }}>{subtitle}</p>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                    width: 34, height: 34, borderRadius: '50%',
                    background: '#000000',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13, fontWeight: 700, color: '#fff',
                }}>Super Admin</div>
            </div>
        </header>
    );
}
