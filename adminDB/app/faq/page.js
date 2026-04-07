'use client';
import { useState, useEffect } from 'react';
import Header from '../../components/Header';
import TrainingTabs from '../../components/TrainingTabs';

function formatDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

const inputStyle = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1px solid var(--border)', fontSize: 13,
    outline: 'none', fontFamily: 'inherit', color: 'var(--text)',
    background: 'var(--surface-2)',
};

const card = {
    background: 'var(--surface)', borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow)', padding: 24, marginBottom: 16,
};

const btnPrimary = (disabled) => ({
    padding: '10px 20px', borderRadius: 8, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    background: 'var(--primary)', color: '#fff', fontWeight: 600, fontSize: 13,
    opacity: disabled ? 0.6 : 1,
});

const btnGreen = (disabled) => ({
    padding: '8px 16px', borderRadius: 8, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    background: '#16a34a', color: '#fff', fontWeight: 600, fontSize: 13,
    opacity: disabled ? 0.6 : 1,
});

const btnSecondary = {
    padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
    background: '#f1f5f9', color: 'var(--text-2)', fontWeight: 500, fontSize: 12,
};

const btnDanger = {
    padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
    background: '#fee2e2', color: '#dc2626', fontWeight: 500, fontSize: 12,
};

const btnSave = {
    padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
    background: 'var(--primary)', color: '#fff', fontWeight: 500, fontSize: 12,
};

export default function FAQPage() {
    const [entries, setEntries] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    // Manual form
    const [question, setQuestion] = useState('');
    const [answer, setAnswer] = useState('');
    const [section, setSection] = useState('');

    // Multi-edit: Map of id → { question, answer, section }
    const [editData, setEditData] = useState({});

    // Multi-select
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [bulkDeleting, setBulkDeleting] = useState(false);

    // Generate-from-document state
    const [docs, setDocs] = useState([]);
    const [selectedDocId, setSelectedDocId] = useState('');
    const [selectedDocName, setSelectedDocName] = useState('');   // filename for doc grouping
    const [generating, setGenerating] = useState(false);
    const [usedLLM, setUsedLLM] = useState(false);
    const [proposals, setProposals] = useState([]);
    const [selectedProposals, setSelectedProposals] = useState(new Set());
    const [savingProposals, setSavingProposals] = useState(false);
    const [editedQuestions, setEditedQuestions] = useState({});

    const loadEntries = () => {
        setLoading(true);
        fetch('/api/faq')
            .then(r => r.json())
            .then(res => { setEntries(res.entries || []); setLoading(false); })
            .catch(() => setLoading(false));
    };

    const loadDocs = () => {
        fetch('/api/general-documents')
            .then(r => r.json())
            .then(res => setDocs(res.data || []))
            .catch(() => {});
    };

    useEffect(() => { loadEntries(); loadDocs(); }, []);

    const flash = (msg, isError = false) => {
        if (isError) { setError(msg); setTimeout(() => setError(''), 5000); }
        else { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); }
    };

    // ── Manual create ──
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
            loadEntries();
        } catch (err) { flash(err.message, true); }
        finally { setSaving(false); }
    };

    // ── Multi-edit helpers ──
    const startEdit = (entry) => {
        setEditData(prev => ({
            ...prev,
            [entry.id]: { question: entry.question, answer: entry.answer, section: entry.section || '' },
        }));
    };

    const cancelEdit = (id) => {
        setEditData(prev => { const next = { ...prev }; delete next[id]; return next; });
    };

    const updateField = (id, field, value) => {
        setEditData(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
    };

    const handleUpdate = async (id) => {
        const d = editData[id];
        if (!d?.question?.trim() || !d?.answer?.trim()) return flash('Question and Answer are required.', true);
        setSaving(true);
        try {
            const res = await fetch(`/api/faq/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: d.question.trim(), answer: d.answer.trim(), section: d.section?.trim() || null }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || data.error || 'Failed to update.');
            flash('FAQ entry updated.');
            cancelEdit(id);
            loadEntries();
        } catch (err) { flash(err.message, true); }
        finally { setSaving(false); }
    };

    // Save all open edits at once
    const handleSaveAll = async () => {
        const ids = Object.keys(editData);
        if (ids.length === 0) return;
        setSaving(true);
        let savedCount = 0;
        for (const id of ids) {
            const d = editData[id];
            if (!d?.question?.trim() || !d?.answer?.trim()) continue;
            try {
                const res = await fetch(`/api/faq/${id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ question: d.question.trim(), answer: d.answer.trim(), section: d.section?.trim() || null }),
                });
                if (res.ok) { savedCount++; cancelEdit(Number(id)); }
            } catch { /* skip */ }
        }
        flash(`${savedCount} entry${savedCount !== 1 ? 's' : ''} updated.`);
        loadEntries();
        setSaving(false);
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this FAQ entry? The bot will no longer use this answer.')) return;
        try {
            const res = await fetch(`/api/faq/${id}`, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || data.error || 'Failed to delete.');
            flash('FAQ entry deleted.');
            cancelEdit(id);
            setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n; });
            loadEntries();
        } catch (err) { flash(err.message, true); }
    };

    // ── Multi-select ──
    const toggleSelect = (id) => {
        setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
    };

    const toggleSelectAll = () => {
        if (selectedIds.size === entries.length) setSelectedIds(new Set());
        else setSelectedIds(new Set(entries.map(e => e.id)));
    };

    const openAllEdits = () => {
        const next = {};
        entries.forEach(e => { next[e.id] = { question: e.question, answer: e.answer, section: e.section || '' }; });
        setEditData(next);
    };

    const closeAllEdits = () => setEditData({});

    // ── Bulk delete selected ──
    const handleBulkDelete = async () => {
        if (selectedIds.size === 0) return;
        if (!confirm(`Delete ${selectedIds.size} selected FAQ entr${selectedIds.size !== 1 ? 'ies' : 'y'}? This cannot be undone.`)) return;
        setBulkDeleting(true);
        try {
            const res = await fetch('/api/faq', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: [...selectedIds] }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Bulk delete failed.');
            flash(`${data.deleted} entr${data.deleted !== 1 ? 'ies' : 'y'} deleted.`);
            setSelectedIds(new Set());
            setEditData(prev => {
                const next = { ...prev };
                selectedIds.forEach(id => delete next[id]);
                return next;
            });
            loadEntries();
        } catch (err) { flash(err.message, true); }
        finally { setBulkDeleting(false); }
    };

    // ── Generate from document ──
    const handleGenerate = async () => {
        if (!selectedDocId) return flash('Please select a document first.', true);
        setGenerating(true);
        setProposals([]);
        setSelectedProposals(new Set());
        setUsedLLM(false);
        try {
            const sugRes = await fetch('/api/faq/suggest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ doc_id: Number(selectedDocId) }),
            });
            const sugData = await sugRes.json();
            if (!sugData.success) throw new Error(sugData.error || 'Failed to extract sections.');

            if (sugData.proposals.length === 0) {
                flash('No sections found in this document. Make sure it has SECTION headers.', true);
            } else {
                setProposals(sugData.proposals);
                setUsedLLM(!!sugData.llm);
                setEditedQuestions({});
                setSelectedProposals(new Set());
            }
        } catch (err) { flash(err.message, true); }
        finally { setGenerating(false); }
    };

    const toggleProposal = (idx) => {
        setSelectedProposals(prev => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx); else next.add(idx);
            return next;
        });
    };

    const toggleAllProposals = () => {
        if (selectedProposals.size === proposals.length) setSelectedProposals(new Set());
        else setSelectedProposals(new Set(proposals.map((_, i) => i)));
    };

    const handleSaveProposals = async () => {
        const toSave = proposals.filter((_, i) => selectedProposals.has(i));
        if (toSave.length === 0) return flash('Select at least one entry to save.', true);
        setSavingProposals(true);
        let saved = 0;
        // Always resolve doc_name — fall back to the docs list if state is somehow stale
        const resolvedDocName =
            selectedDocName ||
            docs.find(d => String(d.id) === String(selectedDocId))?.original_name ||
            null;
        for (const p of toSave) {
            try {
                const q = editedQuestions[p.index] ?? p.question;
                // Skip if this question is already saved (prevents duplicates)
                const alreadyExists = entries.some(
                    e => e.question.toLowerCase().trim() === q.toLowerCase().trim()
                );
                if (alreadyExists) { saved++; continue; }
                const res = await fetch('/api/faq', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        question: q,
                        answer: p.answer,
                        section: p.section,
                        doc_id: selectedDocId ? Number(selectedDocId) : null,
                        doc_name: resolvedDocName,
                    }),
                });
                if (res.ok) saved++;
            } catch { /* skip */ }
        }
        flash(`Saved ${saved} FAQ entries. The bot can now answer these questions.`);
        setProposals([]);
        setSelectedProposals(new Set());
        setEditedQuestions({});
        loadEntries();
        setSavingProposals(false);
    };

    const openEditCount = Object.keys(editData).length;
    const allEditsOpen = entries.length > 0 && openEditCount === entries.length;

    return (
        <div style={{ marginLeft: 'var(--sidebar-w)', minHeight: '100vh', background: 'var(--bg)' }}>
            <Header title="FAQ Manager" />
            <main style={{ padding: '24px 32px', maxWidth: 960 }}>
                <TrainingTabs />

                {/* Info banner */}
                <div style={{ ...card, background: '#f0fdf4', border: '1px solid #bbf7d0', marginBottom: 24, padding: '16px 20px' }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                        <span style={{ fontSize: 20 }}>💡</span>
                        <div style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.6 }}>
                            <strong style={{ color: 'var(--primary)' }}>How this works: </strong>
                            Save exact Q&A pairs to teach the bot precise answers. When a user's question matches a saved entry
                            (≥72% similarity), the bot returns your answer directly. Use <strong>Extract from Document</strong> below to
                            re-extract FAQs from an existing document with AI assistance and save them directly.
                            For new uploads and bulk review, use the <a href="/ai-training" style={{ color: 'var(--primary)', fontWeight: 600 }}>AI Training Hub</a>.
                        </div>
                    </div>
                </div>

                {/* Alerts */}
                {error && <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, padding: '12px 16px', marginBottom: 16, color: '#dc2626', fontSize: 13 }}>{error}</div>}
                {success && <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '12px 16px', marginBottom: 16, color: '#16a34a', fontSize: 13 }}>{success}</div>}

                {/* ── Extract from Document ── */}
                <div style={{ ...card, border: '1.5px solid #bfdbfe' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                        <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>
                            Extract from Document
                        </div>
                        <a href="/ai-training" style={{ fontSize: 11, color: 'var(--primary)', fontWeight: 600, textDecoration: 'none', marginTop: 2 }}>
                            Bulk upload &amp; review → AI Training Hub
                        </a>
                    </div>
                    <div style={{ color: 'var(--text-2)', fontSize: 12, marginBottom: 14 }}>
                        Re-extract from an already-uploaded document with <strong>AI assistance</strong> (LLM-powered when the AI Engine is online, rule-based fallback otherwise). Select only the entries you want and save them directly — no pending queue. Use the <a href="/ai-training" style={{ color: 'var(--primary)' }}>AI Training Hub</a> for new document uploads and bulk proposal review.
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <select
                            style={{ ...inputStyle, width: 320 }}
                            value={selectedDocId}
                            onChange={e => {
                                const id = e.target.value;
                                const doc = docs.find(d => String(d.id) === id);
                                setSelectedDocId(id);
                                setSelectedDocName(doc?.original_name || '');
                                setProposals([]);
                                setSelectedProposals(new Set());
                                setUsedLLM(false);
                            }}
                        >
                            <option value="">— Select a document —</option>
                            {docs.map(d => (
                                <option key={d.id} value={d.id}>{d.original_name}</option>
                            ))}
                        </select>
                        <button style={btnGreen(generating || !selectedDocId)} onClick={handleGenerate} disabled={generating || !selectedDocId}>
                            {generating ? 'Extracting with AI...' : 'Extract & Propose FAQs'}
                        </button>
                    </div>

                    {proposals.length > 0 && (
                        <div style={{ marginTop: 20 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <span style={{ fontWeight: 600, fontSize: 13 }}>
                                        {proposals.length} entries extracted
                                    </span>
                                    {usedLLM ? (
                                        <span style={{ background: '#dbeafe', color: '#1d4ed8', borderRadius: 20, padding: '2px 10px', fontSize: 11, fontWeight: 700 }}>
                                            🤖 AI-assisted
                                        </span>
                                    ) : (
                                        <span style={{ background: '#f3f4f6', color: '#6b7280', borderRadius: 20, padding: '2px 10px', fontSize: 11, fontWeight: 600 }}>
                                            📐 Rule-based
                                        </span>
                                    )}
                                </div>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <button style={btnSecondary} onClick={toggleAllProposals}>
                                        {selectedProposals.size === proposals.length ? 'Deselect All' : 'Select All'}
                                    </button>
                                    <button
                                        style={btnGreen(savingProposals || selectedProposals.size === 0)}
                                        onClick={handleSaveProposals}
                                        disabled={savingProposals || selectedProposals.size === 0}
                                    >
                                        {savingProposals ? 'Saving...' : `Save Selected (${selectedProposals.size})`}
                                    </button>
                                </div>
                            </div>

                            {proposals.map((p, idx) => (
                                <div key={idx} style={{
                                    border: `1.5px solid ${selectedProposals.has(idx) ? 'var(--primary-accent)' : 'var(--border)'}`,
                                    borderRadius: 8, padding: 14, marginBottom: 8,
                                    background: selectedProposals.has(idx) ? '#f0fdf4' : 'var(--surface-2)',
                                }}>
                                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                                        <input
                                            type="checkbox"
                                            checked={selectedProposals.has(idx)}
                                            onChange={() => toggleProposal(idx)}
                                            style={{ marginTop: 4, flexShrink: 0, accentColor: 'var(--primary)', cursor: 'pointer' }}
                                        />
                                        <div style={{ flex: 1 }}>
                                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
                                                {p.section && (
                                                    <span style={{
                                                        background: '#dcfce7', color: 'var(--primary)',
                                                        borderRadius: 5, padding: '1px 8px', fontSize: 10, fontWeight: 600,
                                                        textTransform: 'uppercase',
                                                    }}>{p.section}</span>
                                                )}
                                                {p.confidence != null && (() => {
                                                    const s = p.confidence;
                                                    const [bg, col] = s >= 8 ? ['#bbf7d0', '#15803d'] : s >= 5 ? ['#fef08a', '#854d0e'] : ['#fecaca', '#991b1b'];
                                                    return (
                                                        <span style={{ background: bg, color: col, borderRadius: 4, padding: '1px 7px', fontSize: 10, fontWeight: 700 }}>
                                                            AI {s}/10
                                                        </span>
                                                    );
                                                })()}
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', flexShrink: 0 }}>Q:</span>
                                                <input
                                                    style={{ ...inputStyle, padding: '5px 8px', fontSize: 12, background: '#fff' }}
                                                    value={editedQuestions[p.index] ?? p.question}
                                                    onChange={e => setEditedQuestions(prev => ({ ...prev, [p.index]: e.target.value }))}
                                                    onClick={e => e.stopPropagation()}
                                                />
                                            </div>
                                            <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
                                                {p.preview}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* ── Manual create ── */}
                <div style={card}>
                    <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4, color: 'var(--text)' }}>Add Entry Manually</div>
                    <div style={{ color: 'var(--text-2)', fontSize: 12, marginBottom: 14 }}>
                        Write your own question and answer for anything not covered by a document.
                    </div>
                    <form onSubmit={handleCreate}>
                        <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                            <div style={{ flex: '0 0 260px' }}>
                                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                    Section / Label <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>(optional)</span>
                                </label>
                                <input style={inputStyle} placeholder="e.g. Section 3" value={section} onChange={e => setSection(e.target.value)} />
                            </div>
                        </div>
                        <div style={{ marginBottom: 12 }}>
                            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                Question <span style={{ color: '#dc2626' }}>*</span>
                            </label>
                            <input style={inputStyle} placeholder="e.g. What is Section 3? / Tell me about Section 3" value={question} onChange={e => setQuestion(e.target.value)} />
                            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>Write it the way users would ask.</div>
                        </div>
                        <div style={{ marginBottom: 16 }}>
                            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                Answer <span style={{ color: '#dc2626' }}>*</span>
                            </label>
                            <textarea style={{ ...inputStyle, minHeight: 120, resize: 'vertical', lineHeight: 1.6 }}
                                placeholder="Write the exact, complete answer the bot should give..."
                                value={answer} onChange={e => setAnswer(e.target.value)} />
                        </div>
                        <button type="submit" style={btnPrimary(saving)} disabled={saving}>
                            {saving ? 'Saving...' : '+ Save FAQ Entry'}
                        </button>
                    </form>
                </div>

                {/* ── Saved entries header ── */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, marginTop: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {entries.length > 0 && (
                            <input
                                type="checkbox"
                                checked={selectedIds.size === entries.length && entries.length > 0}
                                ref={el => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < entries.length; }}
                                onChange={toggleSelectAll}
                                style={{ accentColor: 'var(--primary)', cursor: 'pointer', width: 15, height: 15 }}
                            />
                        )}
                        <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text)' }}>
                            Saved Entries ({entries.length})
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        {openEditCount > 0 && (
                            <button
                                style={btnSave}
                                onClick={handleSaveAll}
                                disabled={saving}
                            >
                                {saving ? 'Saving...' : `Save All Edits (${openEditCount})`}
                            </button>
                        )}
                        {entries.length > 0 && (
                            <button
                                style={btnSecondary}
                                onClick={allEditsOpen ? closeAllEdits : openAllEdits}
                            >
                                {allEditsOpen ? 'Close All Edits' : 'Edit All'}
                            </button>
                        )}
                    </div>
                </div>

                {/* Bulk action bar */}
                {selectedIds.size > 0 && (
                    <div style={{
                        background: '#fef9c3', border: '1px solid #fde047', borderRadius: 8,
                        padding: '10px 16px', marginBottom: 12,
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#854d0e' }}>
                            {selectedIds.size} entr{selectedIds.size !== 1 ? 'ies' : 'y'} selected
                        </span>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button
                                style={{ ...btnSecondary, fontSize: 12 }}
                                onClick={() => {
                                    const next = {};
                                    entries.filter(e => selectedIds.has(e.id)).forEach(e => {
                                        next[e.id] = { question: e.question, answer: e.answer, section: e.section || '' };
                                    });
                                    setEditData(prev => ({ ...prev, ...next }));
                                }}
                            >
                                Edit Selected
                            </button>
                            <button
                                style={{ ...btnDanger, fontSize: 12, opacity: bulkDeleting ? 0.6 : 1, cursor: bulkDeleting ? 'not-allowed' : 'pointer' }}
                                onClick={handleBulkDelete}
                                disabled={bulkDeleting}
                            >
                                {bulkDeleting ? 'Deleting...' : `Delete Selected (${selectedIds.size})`}
                            </button>
                            <button style={{ ...btnSecondary, fontSize: 12 }} onClick={() => setSelectedIds(new Set())}>
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Entry list ── */}
                {loading ? (
                    <div style={{ color: 'var(--text-3)', fontSize: 13, padding: 24, textAlign: 'center' }}>Loading...</div>
                ) : entries.length === 0 ? (
                    <div style={{ ...card, textAlign: 'center', color: 'var(--text-3)', padding: 40 }}>
                        <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
                        <div>No FAQ entries yet. Generate from a document or add one manually.</div>
                    </div>
                ) : (
                    entries.map(entry => {
                        const isEditing = Boolean(editData[entry.id]);
                        const isSelected = selectedIds.has(entry.id);
                        const d = editData[entry.id] || {};

                        return (
                            <div key={entry.id} style={{
                                ...card,
                                border: isEditing
                                    ? '1.5px solid var(--primary-accent)'
                                    : isSelected
                                        ? '1.5px solid #fde047'
                                        : '1px solid var(--border)',
                                padding: 20,
                                background: isSelected && !isEditing ? '#fefce8' : 'var(--surface)',
                            }}>
                                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                                    {/* Checkbox */}
                                    <input
                                        type="checkbox"
                                        checked={isSelected}
                                        onChange={() => toggleSelect(entry.id)}
                                        style={{ marginTop: 4, flexShrink: 0, accentColor: 'var(--primary)', cursor: 'pointer', width: 15, height: 15 }}
                                    />

                                    <div style={{ flex: 1 }}>
                                        {isEditing ? (
                                            <div>
                                                <div style={{ marginBottom: 10 }}>
                                                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase' }}>Section</label>
                                                    <input style={{ ...inputStyle, width: 260 }} value={d.section} onChange={e => updateField(entry.id, 'section', e.target.value)} placeholder="Section / Label" />
                                                </div>
                                                <div style={{ marginBottom: 10 }}>
                                                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase' }}>Question</label>
                                                    <input style={inputStyle} value={d.question} onChange={e => updateField(entry.id, 'question', e.target.value)} />
                                                </div>
                                                <div style={{ marginBottom: 14 }}>
                                                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase' }}>Answer</label>
                                                    <textarea style={{ ...inputStyle, minHeight: 100, resize: 'vertical', lineHeight: 1.6 }} value={d.answer} onChange={e => updateField(entry.id, 'answer', e.target.value)} />
                                                </div>
                                                <div style={{ display: 'flex', gap: 8 }}>
                                                    <button style={btnSave} onClick={() => handleUpdate(entry.id)} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
                                                    <button style={btnSecondary} onClick={() => cancelEdit(entry.id)}>Cancel</button>
                                                    <button style={btnDanger} onClick={() => handleDelete(entry.id)}>Delete</button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                                                    <div style={{ flex: 1 }}>
                                                        {entry.section && (
                                                            <span style={{ display: 'inline-block', background: '#dcfce7', color: 'var(--primary)', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                                                                {entry.section}
                                                            </span>
                                                        )}
                                                        <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 8, fontSize: 14 }}>
                                                            Q: {entry.question}
                                                        </div>
                                                        <div style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.65, background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px', whiteSpace: 'pre-wrap' }}>
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
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })
                )}
            </main>
        </div>
    );
}
