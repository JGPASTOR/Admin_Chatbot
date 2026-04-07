'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import Header from '../../../components/Header';

function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Strip file extension for display
function docLabel(name) {
    if (!name) return 'Manual Entries';
    return name.replace(/\.[^.]+$/, '');
}

export default function FAQBrowsePage() {
    const [grouped, setGrouped] = useState({});   // { docKey: { label, entries[] } }
    const [loading, setLoading] = useState(true);
    const [open, setOpen] = useState({});
    const [search, setSearch] = useState('');
    const [deleting, setDeleting] = useState(null);
    const [msg, setMsg] = useState('');

    const load = () => {
        setLoading(true);
        fetch('/api/faq')
            .then(r => r.json())
            .then(res => {
                // Group by doc_name; entries with no doc_name go under "Manual Entries"
                const groups = {};
                for (const e of (res.entries || [])) {
                    const key = e.doc_name?.trim() || '__manual__';
                    if (!groups[key]) groups[key] = { label: docLabel(e.doc_name), entries: [] };
                    groups[key].entries.push(e);
                }
                setGrouped(groups);
                const allOpen = {};
                Object.keys(groups).forEach(k => { allOpen[k] = true; });
                setOpen(allOpen);
                setLoading(false);
            })
            .catch(() => setLoading(false));
    };

    useEffect(() => { load(); }, []);

    const toggle = (key) => setOpen(prev => ({ ...prev, [key]: !prev[key] }));

    const handleDelete = async (id) => {
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

    const filterEntry = (e) => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        return (
            e.question.toLowerCase().includes(q) ||
            e.answer.toLowerCase().includes(q) ||
            (e.section || '').toLowerCase().includes(q) ||
            (e.doc_name || '').toLowerCase().includes(q)
        );
    };

    const totalEntries = Object.values(grouped).reduce((s, g) => s + g.entries.length, 0);

    // Sort: Manual Entries last, documents alphabetically
    const sortedKeys = Object.keys(grouped).sort((a, b) => {
        if (a === '__manual__') return 1;
        if (b === '__manual__') return -1;
        return grouped[a].label.localeCompare(grouped[b].label);
    });

    // File type icon helper
    const docIcon = (key) => {
        if (key === '__manual__') return '✏️';
        const name = (grouped[key]?.entries[0]?.doc_name || '').toLowerCase();
        if (name.endsWith('.pdf')) return '📄';
        if (name.endsWith('.docx') || name.endsWith('.doc')) return '📝';
        if (name.endsWith('.xlsx') || name.endsWith('.xls')) return '📊';
        return '📁';
    };

    return (
        <div style={{ marginLeft: 'var(--sidebar-w)', minHeight: '100vh', background: 'var(--bg)' }}>
            <Header title="FAQ Browser" />
            <main style={{ padding: '24px 32px', maxWidth: 960 }}>

                {/* Top bar */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
                    <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
                        <strong style={{ color: 'var(--text)' }}>{totalEntries}</strong> entries across{' '}
                        <strong style={{ color: 'var(--text)' }}>{sortedKeys.length}</strong> document{sortedKeys.length !== 1 ? 's' : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <input
                            style={{
                                padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)',
                                fontSize: 13, outline: 'none', width: 260, background: 'var(--surface)',
                            }}
                            placeholder="Search questions, answers, or document…"
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

                {msg && (
                    <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '10px 14px', marginBottom: 14, color: '#16a34a', fontSize: 13 }}>
                        {msg}
                    </div>
                )}

                {loading ? (
                    <div style={{ textAlign: 'center', color: 'var(--text-3)', padding: 48 }}>Loading...</div>
                ) : totalEntries === 0 ? (
                    <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-3)' }}>
                        <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
                        <div>No FAQ entries yet.</div>
                        <Link href="/faq" style={{ color: 'var(--primary)', fontWeight: 600, fontSize: 13 }}>Go add some →</Link>
                    </div>
                ) : (
                    sortedKeys.map(docKey => {
                        const { label, entries } = grouped[docKey];
                        const visible = entries.filter(filterEntry);
                        if (search && visible.length === 0) return null;

                        const isOpen = open[docKey] ?? true;
                        const icon = docIcon(docKey);

                        // Sub-group entries by section within this document folder
                        const bySection = {};
                        for (const e of visible) {
                            const sec = e.section?.trim() || 'General';
                            if (!bySection[sec]) bySection[sec] = [];
                            bySection[sec].push(e);
                        }
                        const sectionKeys = Object.keys(bySection).sort((a, b) => {
                            if (a === 'General') return 1;
                            if (b === 'General') return -1;
                            const na = parseInt(a.match(/\d+/)?.[0] ?? '999');
                            const nb = parseInt(b.match(/\d+/)?.[0] ?? '999');
                            return na !== nb ? na - nb : a.localeCompare(b);
                        });

                        return (
                            <div key={docKey} style={{
                                background: 'var(--surface)', borderRadius: 'var(--radius)',
                                boxShadow: 'var(--shadow)', marginBottom: 14,
                                border: '1px solid var(--border)', overflow: 'hidden',
                            }}>
                                {/* Document folder header */}
                                <button
                                    onClick={() => toggle(docKey)}
                                    style={{
                                        width: '100%', padding: '14px 20px', background: 'none', border: 'none',
                                        cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                                        textAlign: 'left',
                                    }}
                                >
                                    <span style={{ fontSize: 20, lineHeight: 1 }}>{isOpen ? '📂' : '📁'}</span>
                                    <span style={{ fontSize: 11, marginRight: 2 }}>{icon}</span>
                                    <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', flex: 1 }}>
                                        {label}
                                    </span>
                                    <span style={{
                                        background: '#dbeafe', color: '#1d4ed8', borderRadius: 20,
                                        padding: '2px 10px', fontSize: 11, fontWeight: 600, marginRight: 6,
                                    }}>
                                        {sectionKeys.length} section{sectionKeys.length !== 1 ? 's' : ''}
                                    </span>
                                    <span style={{
                                        background: '#dcfce7', color: 'var(--primary)', borderRadius: 20,
                                        padding: '2px 10px', fontSize: 11, fontWeight: 600,
                                    }}>
                                        {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
                                    </span>
                                    <span style={{ color: 'var(--text-3)', fontSize: 12, marginLeft: 4 }}>{isOpen ? '▲' : '▼'}</span>
                                </button>

                                {/* Sections inside the document folder */}
                                {isOpen && (
                                    <div style={{ borderTop: '1px solid var(--border)' }}>
                                        {visible.length === 0 ? (
                                            <div style={{ padding: '12px 20px', color: 'var(--text-3)', fontSize: 13 }}>No matches.</div>
                                        ) : (
                                            sectionKeys.map((sec, si) => {
                                                const secEntries = bySection[sec];
                                                return (
                                                    <div key={sec}>
                                                        {/* Section sub-header */}
                                                        <div style={{
                                                            padding: '8px 20px 6px 32px',
                                                            background: '#f8fafc',
                                                            borderBottom: '1px solid #e2e8f0',
                                                            borderTop: si > 0 ? '1px solid #e2e8f0' : 'none',
                                                            display: 'flex', alignItems: 'center', gap: 8,
                                                        }}>
                                                            <span style={{ fontSize: 13 }}>📑</span>
                                                            <span style={{ fontWeight: 600, fontSize: 12, color: '#475569' }}>{sec}</span>
                                                            <span style={{ fontSize: 11, color: '#94a3b8' }}>({secEntries.length})</span>
                                                        </div>

                                                        {secEntries.map((entry, i) => (
                                                            <div key={entry.id} style={{
                                                                padding: '13px 20px 13px 40px',
                                                                borderBottom: i < secEntries.length - 1 ? '1px solid #f1f5f9' : 'none',
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
                                                                            onClick={() => handleDelete(entry.id)}
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
                                                        ))}
                                                    </div>
                                                );
                                            })
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
