'use client';
import { useState, useEffect } from 'react';
import Header from '../../../components/Header';
import TrainingTabs from '../../../components/TrainingTabs';

function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function docLabel(name) {
    if (!name) return 'Manual Entries';
    return name.replace(/\.[^.]+$/, '');
}

const inputStyle = {
    width: '100%', padding: '8px 10px', borderRadius: 7,
    border: '1px solid var(--border)', fontSize: 13,
    outline: 'none', fontFamily: 'inherit', color: 'var(--text)',
    background: 'var(--surface)',
};

const btnSecondary = { padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#f1f5f9', color: 'var(--text-2)', fontWeight: 500, fontSize: 12 };
const btnDanger    = { padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#fee2e2', color: '#dc2626',     fontWeight: 500, fontSize: 12 };
const btnSave      = { padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', background: 'var(--primary)', color: '#fff', fontWeight: 500, fontSize: 12 };

export default function FAQBrowsePage() {
    const [grouped, setGrouped] = useState({});
    const [allEntries, setAllEntries] = useState([]);
    const [loading, setLoading] = useState(true);
    const [open, setOpen] = useState({});
    const [search, setSearch] = useState('');
    const [msg, setMsg] = useState({ text: '', err: false });

    // Inline editing
    const [editData, setEditData] = useState({});
    const [saving, setSaving] = useState(false);

    // Select / bulk
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [bulkDeleting, setBulkDeleting] = useState(false);

    const showMsg = (text, err = false) => {
        setMsg({ text, err });
        setTimeout(() => setMsg({ text: '', err: false }), 3500);
    };

    const load = () => {
        setLoading(true);
        fetch('/api/faq')
            .then(r => r.json())
            .then(res => {
                const seen = new Map();
                for (const e of (res.entries || [])) {
                    const key = e.question.toLowerCase().trim();
                    const existing = seen.get(key);
                    if (!existing || (!existing.doc_name && e.doc_name)) seen.set(key, e);
                }
                const deduped = [...seen.values()];
                setAllEntries(deduped);

                const groups = {};
                for (const e of deduped) {
                    const key = e.doc_name?.trim() || '__manual__';
                    if (!groups[key]) groups[key] = { label: docLabel(e.doc_name), entries: [] };
                    groups[key].entries.push(e);
                }
                setGrouped(groups);
                const allOpen = {};
                Object.keys(groups).forEach(k => { allOpen[k] = true; });
                setOpen(prev => ({ ...allOpen, ...prev }));
                setLoading(false);
            })
            .catch(() => setLoading(false));
    };

    useEffect(() => { load(); }, []);

    const toggle = (key) => setOpen(prev => ({ ...prev, [key]: !prev[key] }));

    // ── Inline edit helpers ──
    const startEdit = (entry) => {
        setEditData(prev => ({
            ...prev,
            [entry.id]: { question: entry.question, answer: entry.answer, section: entry.section || '' },
        }));
    };

    const cancelEdit = (id) => setEditData(prev => { const n = { ...prev }; delete n[id]; return n; });

    const updateField = (id, field, value) => {
        setEditData(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
    };

    const handleUpdate = async (id) => {
        const d = editData[id];
        if (!d?.question?.trim() || !d?.answer?.trim()) return showMsg('Question and Answer are required.', true);
        setSaving(true);
        try {
            const res = await fetch(`/api/faq/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: d.question.trim(), answer: d.answer.trim(), section: d.section?.trim() || null }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || data.error || 'Failed to update.');
            showMsg('Entry updated.');
            cancelEdit(id);
            load();
        } catch (err) { showMsg(err.message, true); }
        finally { setSaving(false); }
    };

    // ── Delete ──
    const handleDelete = async (id) => {
        if (!confirm('Delete this FAQ entry?')) return;
        try {
            const res = await fetch(`/api/faq/${id}`, { method: 'DELETE' });
            if (res.ok) { showMsg('Entry deleted.'); cancelEdit(id); setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n; }); load(); }
        } catch (err) { showMsg(err.message, true); }
    };

    // ── Select / bulk ──
    const visibleEntries = allEntries.filter(filterEntry);
    function filterEntry(e) {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        return (
            e.question.toLowerCase().includes(q) ||
            e.answer.toLowerCase().includes(q) ||
            (e.section || '').toLowerCase().includes(q) ||
            (e.doc_name || '').toLowerCase().includes(q)
        );
    }

    const toggleSelect = (id) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

    const toggleSelectAll = () => {
        const ids = visibleEntries.map(e => e.id);
        if (ids.every(id => selectedIds.has(id))) setSelectedIds(prev => { const n = new Set(prev); ids.forEach(id => n.delete(id)); return n; });
        else setSelectedIds(prev => { const n = new Set(prev); ids.forEach(id => n.add(id)); return n; });
    };

    const allVisibleSelected = visibleEntries.length > 0 && visibleEntries.every(e => selectedIds.has(e.id));
    const someSelected = selectedIds.size > 0 && !allVisibleSelected;

    const handleBulkDelete = async () => {
        if (selectedIds.size === 0) return;
        if (!confirm(`Delete ${selectedIds.size} selected entr${selectedIds.size !== 1 ? 'ies' : 'y'}?`)) return;
        setBulkDeleting(true);
        try {
            const res = await fetch('/api/faq', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: [...selectedIds] }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Delete failed.');
            showMsg(`${data.deleted} entr${data.deleted !== 1 ? 'ies' : 'y'} deleted.`);
            setSelectedIds(new Set());
            setEditData(prev => { const n = { ...prev }; selectedIds.forEach(id => delete n[id]); return n; });
            load();
        } catch (err) { showMsg(err.message, true); }
        finally { setBulkDeleting(false); }
    };

    const totalEntries = allEntries.length;
    const sortedKeys = Object.keys(grouped).sort((a, b) => {
        if (a === '__manual__') return 1;
        if (b === '__manual__') return -1;
        return grouped[a].label.localeCompare(grouped[b].label);
    });

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
            <main style={{ padding: '24px 32px', maxWidth: 980 }}>
                <TrainingTabs />

                {/* Alert */}
                {msg.text && (
                    <div style={{
                        background: msg.err ? '#fee2e2' : '#f0fdf4',
                        border: `1px solid ${msg.err ? '#fca5a5' : '#86efac'}`,
                        borderRadius: 8, padding: '10px 14px', marginBottom: 14,
                        color: msg.err ? '#dc2626' : '#16a34a', fontSize: 13,
                    }}>{msg.text}</div>
                )}

                {/* Top bar */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {/* Select-all checkbox */}
                        {visibleEntries.length > 0 && (
                            <input
                                type="checkbox"
                                checked={allVisibleSelected}
                                ref={el => { if (el) el.indeterminate = someSelected; }}
                                onChange={toggleSelectAll}
                                style={{ accentColor: 'var(--primary)', cursor: 'pointer', width: 15, height: 15 }}
                                title="Select all visible entries"
                            />
                        )}
                        <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
                            <strong style={{ color: 'var(--text)' }}>{totalEntries}</strong> entries across{' '}
                            <strong style={{ color: 'var(--text)' }}>{sortedKeys.length}</strong> document{sortedKeys.length !== 1 ? 's' : ''}
                        </div>
                    </div>
                    <input
                        style={{
                            padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)',
                            fontSize: 13, outline: 'none', width: 260, background: 'var(--surface)',
                        }}
                        placeholder="Search questions, answers, or document…"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                    />
                </div>

                {/* Bulk action bar */}
                {selectedIds.size > 0 && (
                    <div style={{
                        background: '#fef9c3', border: '1px solid #fde047', borderRadius: 8,
                        padding: '10px 16px', marginBottom: 14,
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
                                    allEntries.filter(e => selectedIds.has(e.id)).forEach(e => {
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

                {loading ? (
                    <div style={{ textAlign: 'center', color: 'var(--text-3)', padding: 48 }}>Loading...</div>
                ) : totalEntries === 0 ? (
                    <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-3)' }}>
                        <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
                        <div>No FAQ entries yet. Upload documents in the AI Training Hub to generate them.</div>
                    </div>
                ) : (
                    sortedKeys.map(docKey => {
                        const { label, entries } = grouped[docKey];
                        const visible = entries.filter(filterEntry);
                        if (search && visible.length === 0) return null;

                        const isOpen = open[docKey] ?? true;
                        const icon = docIcon(docKey);

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

                        const visibleIds = visible.map(e => e.id);
                        const allDocSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id));

                        return (
                            <div key={docKey} style={{
                                background: 'var(--surface)', borderRadius: 'var(--radius)',
                                boxShadow: 'var(--shadow)', marginBottom: 14,
                                border: '1px solid var(--border)', overflow: 'hidden',
                            }}>
                                {/* Document folder header */}
                                <div style={{ display: 'flex', alignItems: 'center', padding: '10px 16px 10px 14px', gap: 8 }}>
                                    {/* Doc-level select */}
                                    <input
                                        type="checkbox"
                                        checked={allDocSelected}
                                        ref={el => { if (el) el.indeterminate = visibleIds.some(id => selectedIds.has(id)) && !allDocSelected; }}
                                        onChange={() => {
                                            setSelectedIds(prev => {
                                                const n = new Set(prev);
                                                if (allDocSelected) visibleIds.forEach(id => n.delete(id));
                                                else visibleIds.forEach(id => n.add(id));
                                                return n;
                                            });
                                        }}
                                        style={{ accentColor: 'var(--primary)', cursor: 'pointer', width: 14, height: 14, flexShrink: 0 }}
                                    />
                                    <button
                                        onClick={() => toggle(docKey)}
                                        style={{
                                            flex: 1, background: 'none', border: 'none',
                                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                                            textAlign: 'left', padding: '4px 0',
                                        }}
                                    >
                                        <span style={{ fontSize: 18, lineHeight: 1 }}>{isOpen ? '📂' : '📁'}</span>
                                        <span style={{ fontSize: 11, marginRight: 2 }}>{icon}</span>
                                        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', flex: 1 }}>{label}</span>
                                        <span style={{ background: '#dbeafe', color: '#1d4ed8', borderRadius: 20, padding: '2px 10px', fontSize: 11, fontWeight: 600, marginRight: 4 }}>
                                            {sectionKeys.length} section{sectionKeys.length !== 1 ? 's' : ''}
                                        </span>
                                        <span style={{ background: '#dcfce7', color: 'var(--primary)', borderRadius: 20, padding: '2px 10px', fontSize: 11, fontWeight: 600 }}>
                                            {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
                                        </span>
                                        <span style={{ color: 'var(--text-3)', fontSize: 12, marginLeft: 4 }}>{isOpen ? '▲' : '▼'}</span>
                                    </button>
                                </div>

                                {/* Sections */}
                                {isOpen && (
                                    <div style={{ borderTop: '1px solid var(--border)' }}>
                                        {visible.length === 0 ? (
                                            <div style={{ padding: '12px 20px', color: 'var(--text-3)', fontSize: 13 }}>No matches.</div>
                                        ) : (
                                            sectionKeys.map((sec, si) => {
                                                const secEntries = bySection[sec];
                                                return (
                                                    <div key={sec}>
                                                        <div style={{
                                                            padding: '7px 20px 6px 44px',
                                                            background: '#f8fafc',
                                                            borderBottom: '1px solid #e2e8f0',
                                                            borderTop: si > 0 ? '1px solid #e2e8f0' : 'none',
                                                            display: 'flex', alignItems: 'center', gap: 8,
                                                        }}>
                                                            <span style={{ fontSize: 13 }}>📑</span>
                                                            <span style={{ fontWeight: 600, fontSize: 12, color: '#475569' }}>{sec}</span>
                                                            <span style={{ fontSize: 11, color: '#94a3b8' }}>({secEntries.length})</span>
                                                        </div>

                                                        {secEntries.map((entry, i) => {
                                                            const isEditing = Boolean(editData[entry.id]);
                                                            const isSelected = selectedIds.has(entry.id);
                                                            const d = editData[entry.id] || {};

                                                            return (
                                                                <div key={entry.id} style={{
                                                                    borderBottom: i < secEntries.length - 1 ? '1px solid #f1f5f9' : 'none',
                                                                    padding: '13px 16px 13px 44px',
                                                                    background: isEditing
                                                                        ? '#f0f9ff'
                                                                        : isSelected
                                                                            ? '#fefce8'
                                                                            : i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)',
                                                                    borderLeft: isEditing ? '3px solid var(--primary)' : isSelected ? '3px solid #fde047' : '3px solid transparent',
                                                                }}>
                                                                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={isSelected}
                                                                            onChange={() => toggleSelect(entry.id)}
                                                                            style={{ marginTop: 3, flexShrink: 0, accentColor: 'var(--primary)', cursor: 'pointer', width: 14, height: 14 }}
                                                                        />
                                                                        <div style={{ flex: 1 }}>
                                                                            {isEditing ? (
                                                                                <div>
                                                                                    <div style={{ marginBottom: 8 }}>
                                                                                        <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'var(--text-3)', marginBottom: 3, textTransform: 'uppercase' }}>Section</label>
                                                                                        <input style={{ ...inputStyle, width: 240, fontSize: 12 }} value={d.section} onChange={e => updateField(entry.id, 'section', e.target.value)} placeholder="Section / Label" />
                                                                                    </div>
                                                                                    <div style={{ marginBottom: 8 }}>
                                                                                        <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'var(--text-3)', marginBottom: 3, textTransform: 'uppercase' }}>Question</label>
                                                                                        <input style={{ ...inputStyle, fontSize: 13 }} value={d.question} onChange={e => updateField(entry.id, 'question', e.target.value)} />
                                                                                    </div>
                                                                                    <div style={{ marginBottom: 10 }}>
                                                                                        <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'var(--text-3)', marginBottom: 3, textTransform: 'uppercase' }}>Answer</label>
                                                                                        <textarea style={{ ...inputStyle, minHeight: 90, resize: 'vertical', lineHeight: 1.5 }} value={d.answer} onChange={e => updateField(entry.id, 'answer', e.target.value)} />
                                                                                    </div>
                                                                                    <div style={{ display: 'flex', gap: 6 }}>
                                                                                        <button style={btnSave} onClick={() => handleUpdate(entry.id)} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
                                                                                        <button style={btnSecondary} onClick={() => cancelEdit(entry.id)}>Cancel</button>
                                                                                        <button style={btnDanger} onClick={() => handleDelete(entry.id)}>Delete</button>
                                                                                    </div>
                                                                                </div>
                                                                            ) : (
                                                                                <div>
                                                                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                                                                                        <div style={{ flex: 1 }}>
                                                                                            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 5 }}>
                                                                                                Q: {entry.question}
                                                                                            </div>
                                                                                            <div style={{
                                                                                                fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6,
                                                                                                background: '#f8fafc', borderRadius: 6, padding: '7px 10px',
                                                                                                whiteSpace: 'pre-wrap',
                                                                                            }}>
                                                                                                {entry.answer}
                                                                                            </div>
                                                                                            <div style={{ marginTop: 5, fontSize: 11, color: 'var(--text-3)' }}>
                                                                                                ID #{entry.id} · Added {formatDate(entry.created_at)}
                                                                                            </div>
                                                                                        </div>
                                                                                        <div style={{ display: 'flex', gap: 5, flexShrink: 0, marginTop: 2 }}>
                                                                                            <button style={btnSecondary} onClick={() => startEdit(entry)}>Edit</button>
                                                                                            <button style={btnDanger} onClick={() => handleDelete(entry.id)}>Delete</button>
                                                                                        </div>
                                                                                    </div>
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
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
