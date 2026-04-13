'use client';
import { useState, useEffect, useCallback } from 'react';

const STATUS_TABS = ['pending', 'resolved', 'dismissed'];

export default function NeedsReviewPage() {
    const [activeTab, setActiveTab] = useState('pending');
    const [entries, setEntries] = useState([]);
    const [loading, setLoading] = useState(true);
    const [resolving, setResolving] = useState(null); // id being resolved
    const [answerDrafts, setAnswerDrafts] = useState({}); // { [id]: { answer, section } }
    const [sectionDrafts, setSectionDrafts] = useState({});
    const [expandedId, setExpandedId] = useState(null);
    const [toast, setToast] = useState(null);

    const showToast = (msg, type = 'success') => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), 3500);
    };

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/flagged-queries?status=${activeTab}`);
            const data = await res.json();
            setEntries(data.entries || []);
        } catch {
            showToast('Failed to load flagged queries.', 'error');
        } finally {
            setLoading(false);
        }
    }, [activeTab]);

    useEffect(() => { load(); }, [load]);

    const resolve = async (id) => {
        const answer = (answerDrafts[id] || '').trim();
        if (!answer) { showToast('Please write an answer before resolving.', 'error'); return; }
        setResolving(id);
        try {
            const section = (sectionDrafts[id] || '').trim() || null;
            const entry   = entries.find(e => e.id === id);

            const res = await fetch(`/api/flagged-queries/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ answer, section }),
            });
            const data = await res.json();

            if (data.success) {
                // Also save to Admin DB faq_entries so knowledge graph shows it
                try {
                    await fetch('/api/faq', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ question: entry?.question, answer, section }),
                    });
                } catch { /* non-fatal */ }

                showToast('Resolved! Answer added to bot FAQ memory.');
                setEntries(prev => prev.filter(e => e.id !== id));
                setAnswerDrafts(prev => { const d = { ...prev }; delete d[id]; return d; });
                setSectionDrafts(prev => { const d = { ...prev }; delete d[id]; return d; });
                setExpandedId(null);
            } else {
                // data.detail can be a string or FastAPI validation array — always stringify
                const msg = typeof data.detail === 'string'
                    ? data.detail
                    : Array.isArray(data.detail)
                        ? data.detail.map(e => e.msg || String(e)).join(', ')
                        : (data.error || 'Failed to resolve.');
                showToast(msg, 'error');
            }
        } catch {
            showToast('Network error — check AI Engine connection.', 'error');
        } finally {
            setResolving(null);
        }
    };

    const dismiss = async (id) => {
        if (!confirm('Dismiss this query? It will be marked as not needing an answer.')) return;
        try {
            const res = await fetch(`/api/flagged-queries/${id}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                showToast('Query dismissed.');
                setEntries(prev => prev.filter(e => e.id !== id));
            } else {
                showToast(data.detail || 'Failed to dismiss.', 'error');
            }
        } catch {
            showToast('Network error.', 'error');
        }
    };

    const confidenceColor = (c) => {
        if (c < 0.2) return '#ef4444';
        if (c < 0.4) return '#f97316';
        return '#eab308';
    };

    return (
        <div style={{ padding: '28px 32px', maxWidth: 900 }}>
            {/* Toast */}
            {toast && (
                <div style={{
                    position: 'fixed', top: 20, right: 24, zIndex: 9999,
                    background: toast.type === 'error' ? '#ef4444' : '#22c55e',
                    color: '#fff', padding: '12px 20px', borderRadius: 8,
                    fontWeight: 600, fontSize: 14, boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                }}>
                    {toast.msg}
                </div>
            )}

            {/* Header */}
            <div style={{ marginBottom: 24 }}>
                <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                    Needs Review
                </h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: 6 }}>
                    Questions the bot couldn't confidently answer. Provide an answer to teach the bot, or dismiss if not relevant.
                </p>
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border)' }}>
                {STATUS_TABS.map(tab => (
                    <button key={tab} onClick={() => setActiveTab(tab)} style={{
                        padding: '8px 18px',
                        border: 'none', background: 'none', cursor: 'pointer',
                        fontSize: 13, fontWeight: activeTab === tab ? 700 : 500,
                        color: activeTab === tab ? 'var(--primary-accent)' : 'var(--text-secondary)',
                        borderBottom: activeTab === tab ? '2px solid var(--primary-accent)' : '2px solid transparent',
                        textTransform: 'capitalize',
                    }}>
                        {tab}
                    </button>
                ))}
            </div>

            {/* Content */}
            {loading ? (
                <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-secondary)', fontSize: 14 }}>
                    Loading...
                </div>
            ) : entries.length === 0 ? (
                <div style={{
                    textAlign: 'center', padding: '60px 0',
                    color: 'var(--text-secondary)', fontSize: 14,
                }}>
                    {activeTab === 'pending'
                        ? 'No pending questions to review. The bot is handling everything!'
                        : `No ${activeTab} queries.`}
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {entries.map(entry => {
                        const isExpanded = expandedId === entry.id;
                        return (
                            <div key={entry.id} style={{
                                background: 'var(--card-bg)',
                                border: '1px solid var(--border)',
                                borderRadius: 10,
                                overflow: 'hidden',
                            }}>
                                {/* Question row */}
                                <div
                                    onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                                    style={{
                                        padding: '14px 18px',
                                        display: 'flex', alignItems: 'flex-start', gap: 12,
                                        cursor: 'pointer',
                                    }}
                                >
                                    {/* Confidence badge */}
                                    <div style={{
                                        flexShrink: 0, marginTop: 2,
                                        background: confidenceColor(entry.confidence) + '22',
                                        color: confidenceColor(entry.confidence),
                                        border: `1px solid ${confidenceColor(entry.confidence)}55`,
                                        borderRadius: 6, padding: '2px 8px',
                                        fontSize: 11, fontWeight: 700,
                                        whiteSpace: 'nowrap',
                                    }}>
                                        {Math.round(entry.confidence * 100)}% conf
                                    </div>

                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4 }}>
                                            {entry.question}
                                        </div>
                                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                                            {entry.topic ? <span style={{ marginRight: 10 }}>Topic: <strong>{entry.topic}</strong></span> : null}
                                            Asked: {new Date(entry.asked_at).toLocaleString()}
                                        </div>
                                        {entry.status === 'resolved' && entry.admin_answer && (
                                            <div style={{
                                                marginTop: 8, padding: '8px 12px',
                                                background: '#22c55e11', border: '1px solid #22c55e33',
                                                borderRadius: 6, fontSize: 13, color: '#166534',
                                            }}>
                                                <strong>Answer:</strong> {entry.admin_answer}
                                            </div>
                                        )}
                                    </div>

                                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                                        {isExpanded ? '▲' : '▼'}
                                    </div>
                                </div>

                                {/* Expand — answer form (only for pending) */}
                                {isExpanded && activeTab === 'pending' && (
                                    <div style={{
                                        padding: '0 18px 16px 18px',
                                        borderTop: '1px solid var(--border)',
                                        paddingTop: 14,
                                    }}>
                                        <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                                            Write the correct answer:
                                        </div>
                                        <textarea
                                            placeholder="Type the answer to this question..."
                                            value={answerDrafts[entry.id] || ''}
                                            onChange={e => setAnswerDrafts(prev => ({ ...prev, [entry.id]: e.target.value }))}
                                            rows={4}
                                            style={{
                                                width: '100%', boxSizing: 'border-box',
                                                padding: '10px 12px', borderRadius: 7,
                                                border: '1px solid var(--border)',
                                                background: 'var(--input-bg)', color: 'var(--text-primary)',
                                                fontSize: 13, resize: 'vertical', fontFamily: 'inherit',
                                            }}
                                        />
                                        <input
                                            placeholder="Section label (optional, e.g. 'Surigaonon FAQ')"
                                            value={sectionDrafts[entry.id] || ''}
                                            onChange={e => setSectionDrafts(prev => ({ ...prev, [entry.id]: e.target.value }))}
                                            style={{
                                                width: '100%', boxSizing: 'border-box',
                                                padding: '8px 12px', borderRadius: 7, marginTop: 8,
                                                border: '1px solid var(--border)',
                                                background: 'var(--input-bg)', color: 'var(--text-primary)',
                                                fontSize: 13, fontFamily: 'inherit',
                                            }}
                                        />
                                        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                                            <button
                                                onClick={() => resolve(entry.id)}
                                                disabled={resolving === entry.id}
                                                style={{
                                                    padding: '8px 18px', borderRadius: 7,
                                                    background: 'var(--primary-accent)', color: '#fff',
                                                    border: 'none', cursor: resolving === entry.id ? 'not-allowed' : 'pointer',
                                                    fontWeight: 600, fontSize: 13, opacity: resolving === entry.id ? 0.7 : 1,
                                                }}
                                            >
                                                {resolving === entry.id ? 'Saving...' : 'Resolve & Add to Bot'}
                                            </button>
                                            <button
                                                onClick={() => dismiss(entry.id)}
                                                style={{
                                                    padding: '8px 16px', borderRadius: 7,
                                                    background: 'transparent', color: '#ef4444',
                                                    border: '1px solid #ef444455', cursor: 'pointer',
                                                    fontWeight: 600, fontSize: 13,
                                                }}
                                            >
                                                Dismiss
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
