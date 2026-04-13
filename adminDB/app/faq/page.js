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
    const [search, setSearch] = useState('');

    // Multi-edit: Map of id → { question, answer, section }
    const [editData, setEditData] = useState({});

    // Multi-select
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [bulkDeleting, setBulkDeleting] = useState(false);

    const loadEntries = () => {
        setLoading(true);
        fetch('/api/faq')
            .then(r => r.json())
            .then(res => { setEntries(res.entries || []); setLoading(false); })
            .catch(() => setLoading(false));
    };

    useEffect(() => { loadEntries(); }, []);

    const flash = (msg, isError = false) => {
        if (isError) { setError(msg); setTimeout(() => setError(''), 5000); }
        else { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); }
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

    const filteredEntries = search.trim()
        ? entries.filter(e =>
            e.question.toLowerCase().includes(search.toLowerCase()) ||
            e.answer.toLowerCase().includes(search.toLowerCase()) ||
            (e.section || '').toLowerCase().includes(search.toLowerCase())
          )
        : entries;

    const toggleSelectAll = () => {
        if (selectedIds.size === filteredEntries.length && filteredEntries.length > 0) setSelectedIds(new Set());
        else setSelectedIds(new Set(filteredEntries.map(e => e.id)));
    };

    const openAllEdits = () => {
        const next = {};
        filteredEntries.forEach(e => { next[e.id] = { question: e.question, answer: e.answer, section: e.section || '' }; });
        setEditData(next);
    };

    const closeAllEdits = () => setEditData({});

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

    const openEditCount = Object.keys(editData).length;
    const allEditsOpen = filteredEntries.length > 0 && openEditCount === filteredEntries.length;

    return (
        <div style={{ marginLeft: 'var(--sidebar-w)', minHeight: '100vh', background: 'var(--bg)' }}>
            <Header title="FAQ Manager" />
            <main style={{ padding: '24px 32px', maxWidth: 960 }}>
                <TrainingTabs />

                {/* Alerts */}
                {error && <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, padding: '12px 16px', marginBottom: 16, color: '#dc2626', fontSize: 13 }}>{error}</div>}
                {success && <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '12px 16px', marginBottom: 16, color: '#16a34a', fontSize: 13 }}>{success}</div>}

                {/* Header row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {filteredEntries.length > 0 && (
                            <input
                                type="checkbox"
                                checked={selectedIds.size === filteredEntries.length && filteredEntries.length > 0}
                                ref={el => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < filteredEntries.length; }}
                                onChange={toggleSelectAll}
                                style={{ accentColor: 'var(--primary)', cursor: 'pointer', width: 15, height: 15 }}
                            />
                        )}
                        <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>
                            FAQ Entries ({entries.length})
                        </span>
                        <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
                            — trained from uploaded documents
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                            style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13, outline: 'none', width: 220, background: 'var(--surface)' }}
                            placeholder="Search…"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                        />
                        {openEditCount > 0 && (
                            <button style={btnSave} onClick={handleSaveAll} disabled={saving}>
                                {saving ? 'Saving...' : `Save All (${openEditCount})`}
                            </button>
                        )}
                        {filteredEntries.length > 0 && (
                            <button style={btnSecondary} onClick={allEditsOpen ? closeAllEdits : openAllEdits}>
                                {allEditsOpen ? 'Close All' : 'Edit All'}
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
                            <button style={{ ...btnSecondary, fontSize: 12 }} onClick={() => setSelectedIds(new Set())}>Cancel</button>
                        </div>
                    </div>
                )}

                {/* Entry list */}
                {loading ? (
                    <div style={{ color: 'var(--text-3)', fontSize: 13, padding: 24, textAlign: 'center' }}>Loading...</div>
                ) : filteredEntries.length === 0 ? (
                    <div style={{ ...card, textAlign: 'center', color: 'var(--text-3)', padding: 40 }}>
                        <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
                        <div>
                            {entries.length === 0
                                ? 'No FAQ entries yet. Upload a document in AI Training Hub to generate them automatically.'
                                : 'No entries match your search.'}
                        </div>
                        {entries.length === 0 && (
                            <a href="/ai-training" style={{ color: 'var(--primary)', fontWeight: 600, fontSize: 13, marginTop: 8, display: 'inline-block' }}>
                                Go to AI Training Hub →
                            </a>
                        )}
                    </div>
                ) : (
                    filteredEntries.map(entry => {
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
                                                    ID #{entry.id}{entry.doc_name ? ` · ${entry.doc_name}` : ''} · Added {formatDate(entry.created_at)}
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
