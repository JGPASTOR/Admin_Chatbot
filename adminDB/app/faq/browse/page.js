'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import Header from '../../../components/Header';

function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function FAQBrowsePage() {
    const [grouped, setGrouped] = useState({});
    const [loading, setLoading] = useState(true);
    const [open, setOpen] = useState({});       // which folders are expanded
    const [search, setSearch] = useState('');
    const [deleting, setDeleting] = useState(null);
    const [msg, setMsg] = useState('');

    const load = () => {
        setLoading(true);
        fetch('/api/faq')
            .then(r => r.json())
            .then(res => {
                // Group by section; entries with no section go under "General"
                const groups = {};
                for (const e of (res.entries || [])) {
                    const key = e.section?.trim() || 'General';
                    if (!groups[key]) groups[key] = [];
                    groups[key].push(e);
                }
                setGrouped(groups);
                // Open all folders by default
                const allOpen = {};
                Object.keys(groups).forEach(k => { allOpen[k] = true; });
                setOpen(allOpen);
                setLoading(false);
            })
            .catch(() => setLoading(false));
    };

    useEffect(() => { load(); }, []);

    const toggle = (key) => setOpen(prev => ({ ...prev, [key]: !prev[key] }));

    const handleDelete = async (id, section) => {
        if (!confirm('Delete this FAQ entry?')) return;
        setDeleting(id);
        try {
            const res = await fetch(`/api/faq/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setMsg('Entry deleted.');
                setTimeout(() => setMsg(''), 3000);
                load();
            }
        } finally { setDeleting(null); }
    };

    // Filter entries by search
    const filterEntry = (e) => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        return e.question.toLowerCase().includes(q) || e.answer.toLowerCase().includes(q) || (e.section || '').toLowerCase().includes(q);
    };

    const totalEntries = Object.values(grouped).flat().length;
    const sortedKeys = Object.keys(grouped).sort((a, b) => {
        // Sort section numbers naturally, "General" last
        if (a === 'General') return 1;
        if (b === 'General') return -1;
        const na = parseInt(a.match(/\d+/)?.[0] ?? '999');
        const nb = parseInt(b.match(/\d+/)?.[0] ?? '999');
        return na !== nb ? na - nb : a.localeCompare(b);
    });

    return (
        <div style={{ marginLeft: 'var(--sidebar-w)', minHeight: '100vh', background: 'var(--bg)' }}>
            <Header title="FAQ Browser" />
            <main style={{ padding: '24px 32px', maxWidth: 900 }}>

                {/* Top bar */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
                    <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
                        <strong style={{ color: 'var(--text)' }}>{totalEntries}</strong> entries across <strong style={{ color: 'var(--text)' }}>{sortedKeys.length}</strong> folders
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <input
                            style={{
                                padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)',
                                fontSize: 13, outline: 'none', width: 240, background: 'var(--surface)',
                            }}
                            placeholder="Search questions or answers..."
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                        />
                        <Link href="/faq" style={{
                            padding: '8px 16px', borderRadius: 8, background: 'var(--primary)',
                            color: '#fff', fontWeight: 600, fontSize: 13, textDecoration: 'none',
                        }}>
                            + Add FAQ
                        </Link>
                    </div>
                </div>

                {msg && <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '10px 14px', marginBottom: 14, color: '#16a34a', fontSize: 13 }}>{msg}</div>}

                {loading ? (
                    <div style={{ textAlign: 'center', color: 'var(--text-3)', padding: 48 }}>Loading...</div>
                ) : totalEntries === 0 ? (
                    <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-3)' }}>
                        <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
                        <div>No FAQ entries yet.</div>
                        <Link href="/faq" style={{ color: 'var(--primary)', fontWeight: 600, fontSize: 13 }}>Go add some →</Link>
                    </div>
                ) : (
                    sortedKeys.map(sectionKey => {
                        const entries = grouped[sectionKey].filter(filterEntry);
                        if (search && entries.length === 0) return null;

                        const isOpen = open[sectionKey] ?? true;
                        const allEntries = grouped[sectionKey];

                        return (
                            <div key={sectionKey} style={{
                                background: 'var(--surface)', borderRadius: 'var(--radius)',
                                boxShadow: 'var(--shadow)', marginBottom: 12,
                                border: '1px solid var(--border)', overflow: 'hidden',
                            }}>
                                {/* Folder header */}
                                <button
                                    onClick={() => toggle(sectionKey)}
                                    style={{
                                        width: '100%', padding: '14px 20px', background: 'none', border: 'none',
                                        cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                                        textAlign: 'left',
                                    }}
                                >
                                    <span style={{ fontSize: 18, lineHeight: 1 }}>{isOpen ? '📂' : '📁'}</span>
                                    <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', flex: 1 }}>
                                        {sectionKey}
                                    </span>
                                    <span style={{
                                        background: '#dcfce7', color: 'var(--primary)', borderRadius: 20,
                                        padding: '2px 10px', fontSize: 11, fontWeight: 600,
                                    }}>
                                        {allEntries.length} {allEntries.length === 1 ? 'entry' : 'entries'}
                                    </span>
                                    <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{isOpen ? '▲' : '▼'}</span>
                                </button>

                                {/* Entries */}
                                {isOpen && (
                                    <div style={{ borderTop: '1px solid var(--border)' }}>
                                        {entries.length === 0 ? (
                                            <div style={{ padding: '12px 20px', color: 'var(--text-3)', fontSize: 13 }}>No matches in this folder.</div>
                                        ) : (
                                            entries.map((entry, i) => (
                                                <div key={entry.id} style={{
                                                    padding: '14px 20px',
                                                    borderBottom: i < entries.length - 1 ? '1px solid var(--border)' : 'none',
                                                    background: i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)',
                                                }}>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                                                        <div style={{ flex: 1 }}>
                                                            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 6 }}>
                                                                Q: {entry.question}
                                                            </div>
                                                            <div style={{
                                                                fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6,
                                                                background: '#f8fafc', borderRadius: 6, padding: '8px 12px',
                                                                whiteSpace: 'pre-wrap',
                                                            }}>
                                                                {entry.answer}
                                                            </div>
                                                            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-3)' }}>
                                                                ID #{entry.id} · Added {formatDate(entry.created_at)}
                                                            </div>
                                                        </div>
                                                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                                                            <Link href="/faq" style={{
                                                                padding: '5px 12px', borderRadius: 6, background: '#f1f5f9',
                                                                color: 'var(--text-2)', fontWeight: 500, fontSize: 12,
                                                                textDecoration: 'none',
                                                            }}>Edit</Link>
                                                            <button
                                                                onClick={() => handleDelete(entry.id, sectionKey)}
                                                                disabled={deleting === entry.id}
                                                                style={{
                                                                    padding: '5px 12px', borderRadius: 6, border: 'none',
                                                                    background: '#fee2e2', color: '#dc2626',
                                                                    fontWeight: 500, fontSize: 12, cursor: 'pointer',
                                                                }}
                                                            >
                                                                {deleting === entry.id ? '...' : 'Delete'}
                                                            </button>
                                                        </div>
                                                    </div>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </main>
        </div>
    );
}
