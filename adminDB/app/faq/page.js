'use client';
import { useState, useEffect } from 'react';
import Header from '../../components/Header';

function formatDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

export default function FAQPage() {
    const [entries, setEntries] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    // Form state
    const [question, setQuestion] = useState('');
    const [answer, setAnswer] = useState('');
    const [section, setSection] = useState('');

    // Edit state
    const [editId, setEditId] = useState(null);
    const [editQuestion, setEditQuestion] = useState('');
    const [editAnswer, setEditAnswer] = useState('');
    const [editSection, setEditSection] = useState('');

    const load = () => {
        setLoading(true);
        fetch('/api/faq')
            .then(r => r.json())
            .then(res => { setEntries(res.entries || []); setLoading(false); })
            .catch(() => setLoading(false));
    };

    useEffect(() => { load(); }, []);

    const flash = (msg, isError = false) => {
        if (isError) { setError(msg); setTimeout(() => setError(''), 4000); }
        else { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); }
    };

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!question.trim() || !answer.trim()) return flash('Question and Answer are required.', true);
        setSaving(true);
        try {
            const res = await fetch('/api/faq', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: question.trim(), answer: answer.trim(), section: section.trim() || null }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || data.error || 'Failed to save.');
            flash('FAQ entry saved! The bot will now use this answer.');
            setQuestion(''); setAnswer(''); setSection('');
            load();
        } catch (err) { flash(err.message, true); }
        finally { setSaving(false); }
    };

    const startEdit = (entry) => {
        setEditId(entry.id);
        setEditQuestion(entry.question);
        setEditAnswer(entry.answer);
        setEditSection(entry.section || '');
    };

    const cancelEdit = () => { setEditId(null); };

    const handleUpdate = async (id) => {
        if (!editQuestion.trim() || !editAnswer.trim()) return flash('Question and Answer are required.', true);
        setSaving(true);
        try {
            const res = await fetch(`/api/faq/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: editQuestion.trim(), answer: editAnswer.trim(), section: editSection.trim() || null }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || data.error || 'Failed to update.');
            flash('FAQ entry updated.');
            setEditId(null);
            load();
        } catch (err) { flash(err.message, true); }
        finally { setSaving(false); }
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this FAQ entry? The bot will no longer use this answer.')) return;
        try {
            const res = await fetch(`/api/faq/${id}`, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || data.error || 'Failed to delete.');
            flash('FAQ entry deleted.');
            load();
        } catch (err) { flash(err.message, true); }
    };

    const card = {
        background: 'var(--surface)', borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow)', padding: 24, marginBottom: 16,
    };

    const inputStyle = {
        width: '100%', padding: '10px 12px', borderRadius: 8,
        border: '1px solid var(--border)', fontSize: 13,
        outline: 'none', fontFamily: 'inherit', color: 'var(--text)',
        background: 'var(--surface-2)',
    };

    const btnPrimary = {
        padding: '10px 20px', borderRadius: 8, border: 'none', cursor: 'pointer',
        background: 'var(--primary)', color: '#fff', fontWeight: 600, fontSize: 13,
        opacity: saving ? 0.7 : 1,
    };

    const btnDanger = {
        padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
        background: '#fee2e2', color: '#dc2626', fontWeight: 500, fontSize: 12,
    };

    const btnSecondary = {
        padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
        background: '#f1f5f9', color: 'var(--text-2)', fontWeight: 500, fontSize: 12,
    };

    const btnSave = {
        padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
        background: 'var(--primary)', color: '#fff', fontWeight: 500, fontSize: 12,
    };

    return (
        <div style={{ marginLeft: 'var(--sidebar-w)', minHeight: '100vh', background: 'var(--bg)' }}>
            <Header title="FAQ / Curated Answers" />
            <main style={{ padding: '24px 32px', maxWidth: 900 }}>

                {/* Description */}
                <div style={{ ...card, background: '#f0fdf4', border: '1px solid #bbf7d0', marginBottom: 24 }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                        <span style={{ fontSize: 22 }}>💡</span>
                        <div>
                            <div style={{ fontWeight: 600, color: 'var(--primary)', marginBottom: 4 }}>How this works</div>
                            <div style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.6 }}>
                                Save exact Q&amp;A pairs here to teach the bot precise answers. When a user asks something
                                that matches a saved question (≥72% similarity), the bot returns your curated answer directly —
                                no guessing, no hallucination. Takes effect immediately without restarting.
                            </div>
                        </div>
                    </div>
                </div>

                {/* Alerts */}
                {error && (
                    <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, padding: '12px 16px', marginBottom: 16, color: '#dc2626', fontSize: 13 }}>
                        {error}
                    </div>
                )}
                {success && (
                    <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '12px 16px', marginBottom: 16, color: '#16a34a', fontSize: 13 }}>
                        {success}
                    </div>
                )}

                {/* Create form */}
                <div style={card}>
                    <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 16, color: 'var(--text)' }}>
                        Add New FAQ Entry
                    </div>
                    <form onSubmit={handleCreate}>
                        <div style={{ marginBottom: 12 }}>
                            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                Section / Label <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>(optional)</span>
                            </label>
                            <input
                                style={{ ...inputStyle, width: 260 }}
                                placeholder="e.g. Section 3, LGU Vision, Tourism"
                                value={section}
                                onChange={e => setSection(e.target.value)}
                            />
                        </div>
                        <div style={{ marginBottom: 12 }}>
                            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                Question <span style={{ color: '#dc2626' }}>*</span>
                            </label>
                            <input
                                style={inputStyle}
                                placeholder="e.g. What is Section 3? / Tell me about Section 3"
                                value={question}
                                onChange={e => setQuestion(e.target.value)}
                            />
                            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                                The bot matches user questions to this using semantic similarity. Write it the way users would ask.
                            </div>
                        </div>
                        <div style={{ marginBottom: 16 }}>
                            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                Answer <span style={{ color: '#dc2626' }}>*</span>
                            </label>
                            <textarea
                                style={{ ...inputStyle, minHeight: 120, resize: 'vertical', lineHeight: 1.6 }}
                                placeholder="Write the exact, complete answer the bot should give..."
                                value={answer}
                                onChange={e => setAnswer(e.target.value)}
                            />
                        </div>
                        <button type="submit" style={btnPrimary} disabled={saving}>
                            {saving ? 'Saving...' : '+ Save FAQ Entry'}
                        </button>
                    </form>
                </div>

                {/* List */}
                <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 12, color: 'var(--text)' }}>
                    Saved Entries ({entries.length})
                </div>

                {loading ? (
                    <div style={{ color: 'var(--text-3)', fontSize: 13, padding: 24, textAlign: 'center' }}>Loading...</div>
                ) : entries.length === 0 ? (
                    <div style={{ ...card, textAlign: 'center', color: 'var(--text-3)', padding: 40 }}>
                        <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
                        <div>No FAQ entries yet. Add one above to teach the bot.</div>
                    </div>
                ) : (
                    entries.map(entry => (
                        <div key={entry.id} style={{ ...card, border: editId === entry.id ? '1.5px solid var(--primary-accent)' : '1px solid var(--border)' }}>
                            {editId === entry.id ? (
                                /* Edit mode */
                                <div>
                                    <div style={{ marginBottom: 10 }}>
                                        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase' }}>Section</label>
                                        <input style={{ ...inputStyle, width: 260 }} value={editSection} onChange={e => setEditSection(e.target.value)} placeholder="Section / Label" />
                                    </div>
                                    <div style={{ marginBottom: 10 }}>
                                        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase' }}>Question</label>
                                        <input style={inputStyle} value={editQuestion} onChange={e => setEditQuestion(e.target.value)} />
                                    </div>
                                    <div style={{ marginBottom: 14 }}>
                                        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase' }}>Answer</label>
                                        <textarea style={{ ...inputStyle, minHeight: 100, resize: 'vertical', lineHeight: 1.6 }} value={editAnswer} onChange={e => setEditAnswer(e.target.value)} />
                                    </div>
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <button style={btnSave} onClick={() => handleUpdate(entry.id)} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
                                        <button style={btnSecondary} onClick={cancelEdit}>Cancel</button>
                                    </div>
                                </div>
                            ) : (
                                /* View mode */
                                <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                                        <div style={{ flex: 1 }}>
                                            {entry.section && (
                                                <span style={{
                                                    display: 'inline-block', background: '#dcfce7', color: 'var(--primary)',
                                                    borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600,
                                                    marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.4px',
                                                }}>
                                                    {entry.section}
                                                </span>
                                            )}
                                            <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 8, fontSize: 14 }}>
                                                Q: {entry.question}
                                            </div>
                                            <div style={{
                                                color: 'var(--text-2)', fontSize: 13, lineHeight: 1.65,
                                                background: 'var(--surface-2)', borderRadius: 8,
                                                padding: '10px 14px', whiteSpace: 'pre-wrap',
                                            }}>
                                                {entry.answer}
                                            </div>
                                        </div>
                                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                                            <button style={btnSecondary} onClick={() => startEdit(entry)}>Edit</button>
                                            <button style={btnDanger} onClick={() => handleDelete(entry.id)}>Delete</button>
                                        </div>
                                    </div>
                                    <div style={{ marginTop: 10, color: 'var(--text-3)', fontSize: 11 }}>
                                        ID #{entry.id} · Added {formatDate(entry.created_at)}
                                        {entry.updated_at !== entry.created_at && ` · Updated ${formatDate(entry.updated_at)}`}
                                    </div>
                                </div>
                            )}
                        </div>
                    ))
                )}
            </main>
        </div>
    );
}
