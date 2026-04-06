export default function StatsCard({ label, value, icon, color = 'var(--primary)', bg = '#f0fdf6' }) {
    return (
        <div className="card" style={{ padding: '20px 24px', display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{
                width: 48, height: 48, borderRadius: 12,
                background: bg, display: 'flex', alignItems: 'center',
                justifyContent: 'center', flexShrink: 0,
            }}>
                <span style={{ color, fontSize: 22 }}>{icon}</span>
            </div>
            <div>
                <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--text)', lineHeight: 1 }}>{value}</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4, fontWeight: 500 }}>{label}</div>
            </div>
        </div>
    );
}
