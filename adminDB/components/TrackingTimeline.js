export default function TrackingTimeline({ status }) {
    const steps = [
        { key: 'creation', label: 'Creation' },
        { key: 'in_progress', label: 'In Progress' },
        { key: 'completed', label: 'Completed' },
    ];
    const activeIdx = steps.findIndex(s => s.key === status);

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 24 }}>
            {steps.map((step, i) => {
                const done = i < activeIdx;
                const active = i === activeIdx;
                const future = i > activeIdx;
                return (
                    <div key={step.key} style={{ display: 'flex', alignItems: 'center', flex: i < steps.length - 1 ? 1 : 0 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                            <div style={{
                                width: 40, height: 40, borderRadius: '50%',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: done ? 'var(--primary-accent)' : active ? 'var(--primary)' : '#e2e8f0',
                                color: done || active ? '#fff' : '#94a3b8',
                                fontWeight: 700, fontSize: 14,
                                boxShadow: active ? '0 0 0 4px rgba(26,92,55,0.2)' : 'none',
                                transition: 'all 0.2s',
                            }}>
                                {done ? (
                                    <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                                        <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                ) : active ? (
                                    <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                                        <circle cx="12" cy="12" r="4" fill="white" />
                                    </svg>
                                ) : (
                                    <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                                        <circle cx="12" cy="12" r="5" />
                                        <path d="M12 8v4l3 3" />
                                    </svg>
                                )}
                            </div>
                            <span style={{
                                fontSize: 11, fontWeight: active ? 700 : 500,
                                color: active ? 'var(--primary)' : done ? 'var(--primary-accent)' : 'var(--text-3)',
                                whiteSpace: 'nowrap',
                            }}>{step.label}</span>
                        </div>
                        {i < steps.length - 1 && (
                            <div style={{
                                flex: 1, height: 2, margin: '-14px 4px 0',
                                background: done ? 'var(--primary-accent)' : 'var(--border)',
                                transition: 'background 0.3s',
                            }} />
                        )}
                    </div>
                );
            })}
        </div>
    );
}
