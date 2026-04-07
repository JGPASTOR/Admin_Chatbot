'use client';
import { useState, useEffect, useRef } from 'react';
import Header from '../../components/Header';
import TrainingTabs from '../../components/TrainingTabs';

const FILE_ICONS = { pdf: '📄', docx: '📝', doc: '📝', xlsx: '📊', xls: '📊' };

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const card = (extra = {}) => ({
    background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.07)',
    border: '1px solid #e2e8f0', ...extra,
});

const btn = (color = '#1a5c37', disabled = false) => ({
    padding: '7px 16px', borderRadius: 7, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    background: disabled ? '#cbd5e1' : color, color: '#fff', fontWeight: 600, fontSize: 12,
    opacity: disabled ? 0.7 : 1, transition: 'all 0.15s',
});

const STATUS_COLORS = {
    pending:  { bg: '#fef9c3', color: '#854d0e', label: 'Pending' },
    approved: { bg: '#dcfce7', color: '#16a34a', label: 'Approved' },
    rejected: { bg: '#fee2e2', color: '#dc2626', label: 'Rejected' },
};

export default function AITrainingPage() {
    // Stats
    const [stats, setStats] = useState({ docs: 0, faqs: 0, pending: 0 });

    // Documents
    const [docs, setDocs] = useState([]);
    const [docsLoading, setDocsLoading] = useState(true);
    const [expandedDoc, setExpandedDoc] = useState(null);

    // Upload
    const [uploading, setUploading] = useState(false);
    const [uploadMsg, setUploadMsg] = useState('');
    const fileRef = useRef(null);
    const [dragOver, setDragOver] = useState(false);

    // Pending FAQs
    const [pending, setPending] = useState([]);
    const [pendingLoading, setPendingLoading] = useState(true);
    const [selected, setSelected] = useState(new Set());
    const [editedQ, setEditedQ] = useState({});
    const [filterDoc, setFilterDoc] = useState('');
    const [working, setWorking] = useState(false);

    // Rebuild
    const [rebuilding, setRebuilding] = useState(false);

    // Flash messages
    const [flash, setFlash] = useState('');
    const [flashErr, setFlashErr] = useState('');
    const showFlash = (msg, err = false) => {
        if (err) { setFlashErr(msg); setTimeout(() => setFlashErr(''), 5000); }
        else { setFlash(msg); setTimeout(() => setFlash(''), 4000); }
    };

    const loadDocs = () => {
        setDocsLoading(true);
        fetch('/api/general-documents')
            .then(r => r.json())
            .then(res => { setDocs(res.data || []); setDocsLoading(false); })
            .catch(() => setDocsLoading(false));
    };

    const loadPending = () => {
        setPendingLoading(true);
        fetch('/api/pending-faqs?status=pending')
            .then(r => r.json())
            .then(res => { setPending(res.data || []); setPendingLoading(false); })
            .catch(() => setPendingLoading(false));
    };

    const loadStats = () => {
        Promise.all([
            fetch('/api/general-documents').then(r => r.json()),
            fetch('/api/faq').then(r => r.json()),
            fetch('/api/pending-faqs?status=pending').then(r => r.json()),
        ]).then(([d, f, p]) => {
            setStats({
                docs: d.data?.length ?? 0,
                faqs: f.entries?.length ?? 0,
                pending: p.data?.length ?? 0,
            });
        }).catch(() => {});
    };

    useEffect(() => { loadDocs(); loadPending(); loadStats(); }, []);

    // ── Upload ──
    const handleUpload = async (file) => {
        if (!file) return;
        const ext = file.name.split('.').pop().toLowerCase();
        if (!['pdf', 'docx', 'doc', 'xlsx', 'xls'].includes(ext)) {
            return showFlash('Unsupported file type.', true);
        }
        if (file.size > 30 * 1024 * 1024) return showFlash('File exceeds 30 MB.', true);

        setUploading(true);
        setUploadMsg(`Uploading "${file.name}" and extracting knowledge…`);

        const fd = new FormData();
        fd.append('file', file);

        try {
            const res = await fetch('/api/general-documents', { method: 'POST', body: fd });
            const json = await res.json();
            if (json.success) {
                setUploadMsg(`"${file.name}" uploaded! Keywords extracted + FAQ proposals generated.`);
                loadDocs(); loadPending(); loadStats();
                setTimeout(() => setUploadMsg(''), 5000);
            } else {
                showFlash(json.error || 'Upload failed.', true);
                setUploadMsg('');
            }
        } catch (err) {
            showFlash(err.message, true);
            setUploadMsg('');
        }
        setUploading(false);
    };

    const onDrop = (e) => {
        e.preventDefault(); setDragOver(false);
        handleUpload(e.dataTransfer.files[0]);
    };

    // ── Pending FAQ actions ──
    const visiblePending = filterDoc
        ? pending.filter(p => String(p.doc_id) === filterDoc)
        : pending;

    const toggleSelect = (id) => {
        setSelected(prev => {
            const n = new Set(prev);
            n.has(id) ? n.delete(id) : n.add(id);
            return n;
        });
    };

    const toggleAll = () => {
        if (selected.size === visiblePending.length) setSelected(new Set());
        else setSelected(new Set(visiblePending.map(p => p.id)));
    };

    const handleApproveSelected = async () => {
        if (selected.size === 0) return showFlash('Select entries to approve.', true);
        setWorking(true);
        const edits = {};
        for (const id of selected) {
            if (editedQ[id] !== undefined) edits[id] = { question: editedQ[id] };
        }
        try {
            const res = await fetch('/api/pending-faqs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: [...selected], edits }),
            });
            const data = await res.json();
            if (data.success) {
                showFlash(`${data.approved} FAQ entries approved and added to the bot's knowledge!`);
                setSelected(new Set());
                setEditedQ({});
                loadPending(); loadStats();
            } else {
                showFlash(data.error || 'Failed to approve.', true);
            }
        } catch (err) { showFlash(err.message, true); }
        setWorking(false);
    };

    const handleRejectSelected = async () => {
        if (selected.size === 0) return showFlash('Select entries to reject.', true);
        if (!confirm(`Reject ${selected.size} selected proposal(s)?`)) return;
        setWorking(true);
        try {
            await fetch('/api/pending-faqs', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: [...selected] }),
            });
            showFlash(`${selected.size} proposals rejected.`);
            setSelected(new Set());
            loadPending(); loadStats();
        } catch (err) { showFlash(err.message, true); }
        setWorking(false);
    };

    const handleSingleApprove = async (item) => {
        setWorking(true);
        try {
            const res = await fetch(`/api/pending-faqs/${item.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'approve',
                    question: editedQ[item.id] ?? item.question,
                }),
            });
            const data = await res.json();
            if (data.success) {
                showFlash('FAQ entry approved and added to the bot!');
                loadPending(); loadStats();
            } else {
                showFlash(data.error || 'Failed.', true);
            }
        } catch (err) { showFlash(err.message, true); }
        setWorking(false);
    };

    const handleSingleReject = async (item) => {
        setWorking(true);
        try {
            await fetch(`/api/pending-faqs/${item.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'reject' }),
            });
            loadPending(); loadStats();
        } catch { /* */ }
        setWorking(false);
    };

    // ── Rebuild RAG ──
    const handleRebuild = async () => {
        if (!confirm('Resync the full knowledge base with the AI Engine? This re-indexes all documents.')) return;
        setRebuilding(true);
        try {
            const res = await fetch('/api/general-documents/rebuild', { method: 'POST' });
            const data = await res.json();
            if (data.success) showFlash(`Knowledge base resynced! ${data.total_chunks ?? ''} chunks indexed.`);
            else showFlash(data.error || 'Resync failed.', true);
        } catch (err) { showFlash(err.message, true); }
        setRebuilding(false);
    };

    // Unique docs in pending list (for filter dropdown)
    const pendingDocs = [...new Map(pending.map(p => [p.doc_id, { id: p.doc_id, name: p.doc_name }])).values()];

    return (
        <>
            <Header
                title="AI Training Hub"
                subtitle="Upload documents, review auto-generated Q&A proposals, and train the bot"
            />
            <main style={{ padding: '24px 28px', flex: 1, maxWidth: 1100 }}>
                <TrainingTabs />

                {/* Flash */}
                {flash && (
                    <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '10px 16px', marginBottom: 16, color: '#16a34a', fontSize: 13 }}>
                        {flash}
                    </div>
                )}
                {flashErr && (
                    <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 16px', marginBottom: 16, color: '#dc2626', fontSize: 13 }}>
                        {flashErr}
                    </div>
                )}

                {/* ── Stats Row ── */}
                <div style={{ display: 'flex', gap: 14, marginBottom: 24, flexWrap: 'wrap' }}>
                    {[
                        { label: 'Documents', value: stats.docs, icon: '📚', color: '#1a5c37' },
                        { label: 'FAQ Entries (Active)', value: stats.faqs, icon: '💬', color: '#2563eb' },
                        { label: 'Pending Proposals', value: stats.pending, icon: '⏳', color: stats.pending > 0 ? '#d97706' : '#64748b' },
                    ].map(s => (
                        <div key={s.label} style={{ ...card({ padding: '18px 24px', flex: '1 1 200px', borderLeft: `4px solid ${s.color}` }) }}>
                            <div style={{ fontSize: 24, marginBottom: 4 }}>{s.icon}</div>
                            <div style={{ fontSize: 28, fontWeight: 800, color: s.color }}>{s.value}</div>
                            <div style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>{s.label}</div>
                        </div>
                    ))}
                    <div style={{ ...card({ padding: '18px 24px', flex: '1 1 200px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 8 }) }}>
                        <button
                            onClick={handleRebuild}
                            disabled={rebuilding}
                            style={btn('#0ea5e9', rebuilding)}
                        >
                            {rebuilding ? 'Resyncing...' : '🔄 Resync AI Knowledge Base'}
                        </button>
                        <div style={{ fontSize: 11, color: '#64748b', textAlign: 'center' }}>
                            Use after bulk uploads or deletions
                        </div>
                    </div>
                </div>

                {/* ── Upload Zone ── */}
                <div style={{ ...card({ padding: 0, marginBottom: 24, overflow: 'hidden' }) }}>
                    <div style={{ background: '#14472c', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 16 }}>📤</span>
                        <span style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>Upload New Document</span>
                        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginLeft: 4 }}>Keywords + FAQ proposals are generated automatically</span>
                    </div>
                    <div
                        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={onDrop}
                        onClick={() => !uploading && fileRef.current?.click()}
                        style={{
                            padding: '32px 24px', textAlign: 'center', cursor: uploading ? 'wait' : 'pointer',
                            background: dragOver ? 'rgba(34,197,94,0.05)' : '#fafafa',
                            border: `2px dashed ${dragOver ? '#16a34a' : '#e2e8f0'}`,
                            borderTop: 'none',
                            transition: 'all 0.2s',
                        }}
                    >
                        <input ref={fileRef} type="file" accept=".pdf,.docx,.doc,.xlsx,.xls" hidden onChange={e => handleUpload(e.target.files[0])} />
                        <div style={{ fontSize: 22, fontWeight: 600, color: '#1e293b', marginBottom: 6 }}>
                            {uploading ? 'Processing document...' : 'Drag & drop or click to upload'}
                        </div>
                        <div style={{ fontSize: 13, color: '#64748b' }}>
                            Supports <strong>.pdf</strong>, <strong>.docx</strong>, <strong>.xlsx</strong> — Max 30 MB
                        </div>
                        {uploadMsg && (
                            <div style={{ marginTop: 12, padding: '8px 16px', borderRadius: 8, background: '#f0fdf4', color: '#16a34a', fontSize: 13, fontWeight: 500, display: 'inline-block' }}>
                                {uploadMsg}
                            </div>
                        )}
                    </div>
                </div>

                {/* ── Document Library ── */}
                <div style={{ ...card({ marginBottom: 24, overflow: 'hidden' }) }}>
                    <div style={{ background: '#1a5c37', padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div>
                            <span style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>Document Library</span>
                            <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, marginLeft: 10 }}>{docs.length} files</span>
                        </div>
                    </div>

                    {docsLoading ? (
                        <div style={{ padding: 32, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Loading...</div>
                    ) : docs.length === 0 ? (
                        <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
                            No documents yet. Upload your first file above.
                        </div>
                    ) : (
                        <div>
                            {docs.map((doc, idx) => {
                                let keywords = [];
                                try { keywords = doc.keywords ? (typeof doc.keywords === 'string' ? JSON.parse(doc.keywords) : doc.keywords) : []; } catch { keywords = []; }

                                return (
                                    <div key={doc.id}
                                        style={{ borderBottom: idx < docs.length - 1 ? '1px solid #e2e8f0' : 'none', padding: '14px 20px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
                                                <span style={{ fontSize: 22 }}>{FILE_ICONS[doc.file_type] || '📄'}</span>
                                                <div>
                                                    <div style={{ fontWeight: 600, fontSize: 14, color: '#1e293b' }}>{doc.original_name}</div>
                                                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                                                        {doc.file_type.toUpperCase()} · {formatSize(doc.file_size)} · {formatDate(doc.created_at)}
                                                    </div>
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => setExpandedDoc(expandedDoc === doc.id ? null : doc.id)}
                                                style={{ ...btn('#64748b'), padding: '5px 12px' }}
                                            >
                                                {expandedDoc === doc.id ? 'Hide Keywords' : 'Show Keywords'}
                                            </button>
                                        </div>

                                        {expandedDoc === doc.id && (
                                            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f1f5f9' }}>
                                                <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                                                    Auto-Extracted Keywords
                                                </div>
                                                {keywords.length > 0 ? (
                                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                                        {keywords.map((kw, ki) => (
                                                            <span key={ki} style={{
                                                                background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0',
                                                                borderRadius: 20, padding: '3px 10px', fontSize: 12, fontWeight: 500,
                                                            }}>{kw}</span>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <span style={{ fontSize: 12, color: '#94a3b8' }}>No keywords extracted yet.</span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* ── Pending FAQ Proposals ── */}
                <div style={card({ overflow: 'hidden' })}>
                    <div style={{ background: '#1e3a5f', padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                        <div>
                            <span style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>Pending FAQ Proposals</span>
                            <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, marginLeft: 10 }}>
                                Auto-generated from uploaded documents — review and approve to train the bot
                            </span>
                        </div>
                        {pending.length > 0 && (
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                {/* Filter by doc */}
                                <select
                                    value={filterDoc}
                                    onChange={e => { setFilterDoc(e.target.value); setSelected(new Set()); }}
                                    style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.25)', background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: 12 }}
                                >
                                    <option value="">All documents</option>
                                    {pendingDocs.map(d => (
                                        <option key={d.id} value={String(d.id)}>{d.name}</option>
                                    ))}
                                </select>
                                <button style={{ ...btn('#475569'), padding: '5px 12px' }} onClick={toggleAll}>
                                    {selected.size === visiblePending.length && visiblePending.length > 0 ? 'Deselect All' : 'Select All'}
                                </button>
                                <button
                                    style={btn('#16a34a', working || selected.size === 0)}
                                    onClick={handleApproveSelected}
                                    disabled={working || selected.size === 0}
                                >
                                    {working ? 'Working...' : `Approve (${selected.size})`}
                                </button>
                                <button
                                    style={btn('#dc2626', working || selected.size === 0)}
                                    onClick={handleRejectSelected}
                                    disabled={working || selected.size === 0}
                                >
                                    Reject ({selected.size})
                                </button>
                            </div>
                        )}
                    </div>

                    {pendingLoading ? (
                        <div style={{ padding: 32, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Loading proposals...</div>
                    ) : visiblePending.length === 0 ? (
                        <div style={{ padding: 48, textAlign: 'center' }}>
                            <div style={{ fontSize: 36, marginBottom: 12 }}>🎉</div>
                            <div style={{ fontWeight: 600, color: '#1e293b', fontSize: 15, marginBottom: 6 }}>
                                {pending.length === 0 ? 'No pending proposals' : 'No proposals for this document'}
                            </div>
                            <div style={{ color: '#94a3b8', fontSize: 13 }}>
                                {pending.length === 0
                                    ? 'Upload a document above — Q&A proposals will appear here automatically.'
                                    : 'All proposals for this document have been reviewed.'}
                            </div>
                        </div>
                    ) : (
                        <div>
                            {/* Info bar */}
                            <div style={{ padding: '10px 20px', background: '#fefce8', borderBottom: '1px solid #fde68a', fontSize: 12, color: '#92400e' }}>
                                <strong>Tip:</strong> Edit the question text if needed, check the ones that are useful, then click Approve to add them to the bot's knowledge base.
                            </div>

                            {visiblePending.map((item, idx) => (
                                <div key={item.id} style={{
                                    borderBottom: idx < visiblePending.length - 1 ? '1px solid #f1f5f9' : 'none',
                                    padding: '14px 20px',
                                    background: selected.has(item.id) ? '#f0fdf4' : '#fff',
                                    transition: 'background 0.15s',
                                }}>
                                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                                        {/* Checkbox */}
                                        <input
                                            type="checkbox"
                                            checked={selected.has(item.id)}
                                            onChange={() => toggleSelect(item.id)}
                                            style={{ marginTop: 4, flexShrink: 0, width: 16, height: 16, accentColor: '#16a34a', cursor: 'pointer' }}
                                        />

                                        <div style={{ flex: 1 }}>
                                            {/* Source doc + section + confidence badges */}
                                            <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                                <span style={{ background: '#dbeafe', color: '#1d4ed8', borderRadius: 4, padding: '2px 8px', fontSize: 10, fontWeight: 600 }}>
                                                    {item.doc_name}
                                                </span>
                                                {item.section && (
                                                    <span style={{ background: '#dcfce7', color: '#15803d', borderRadius: 4, padding: '2px 8px', fontSize: 10, fontWeight: 600 }}>
                                                        {item.section}
                                                    </span>
                                                )}
                                                {item.confidence_score > 0 && (() => {
                                                    const s = item.confidence_score;
                                                    const [bg, color, label] =
                                                        s >= 8 ? ['#bbf7d0', '#15803d', `AI ${s}/10`] :
                                                        s >= 5 ? ['#fef08a', '#854d0e', `AI ${s}/10`] :
                                                                 ['#fecaca', '#991b1b', `AI ${s}/10`];
                                                    return (
                                                        <span style={{ background: bg, color, borderRadius: 4, padding: '2px 8px', fontSize: 10, fontWeight: 700 }}>
                                                            {label}
                                                        </span>
                                                    );
                                                })()}
                                            </div>

                                            {/* Editable question */}
                                            <div style={{ marginBottom: 8 }}>
                                                <label style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Question</label>
                                                <input
                                                    value={editedQ[item.id] ?? item.question}
                                                    onChange={e => setEditedQ(prev => ({ ...prev, [item.id]: e.target.value }))}
                                                    onClick={e => e.stopPropagation()}
                                                    style={{
                                                        display: 'block', width: '100%', marginTop: 4, padding: '7px 10px',
                                                        borderRadius: 7, border: '1.5px solid #e2e8f0', fontSize: 13,
                                                        fontWeight: 500, color: '#1e293b', outline: 'none',
                                                        background: selected.has(item.id) ? '#fff' : '#f8fafc',
                                                    }}
                                                />
                                            </div>

                                            {/* Answer preview */}
                                            <div style={{ background: '#f8fafc', borderRadius: 7, padding: '8px 12px', fontSize: 12, color: '#475569', lineHeight: 1.6, maxHeight: 80, overflow: 'hidden', position: 'relative' }}>
                                                {item.answer?.slice(0, 220)}{item.answer?.length > 220 ? '…' : ''}
                                            </div>
                                        </div>

                                        {/* Per-item action buttons */}
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                                            <button
                                                onClick={() => handleSingleApprove(item)}
                                                disabled={working}
                                                style={{ ...btn('#16a34a', working), padding: '5px 12px', fontSize: 11 }}
                                            >
                                                Approve
                                            </button>
                                            <button
                                                onClick={() => handleSingleReject(item)}
                                                disabled={working}
                                                style={{ background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 11, fontWeight: 600, cursor: working ? 'not-allowed' : 'pointer' }}
                                            >
                                                Reject
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

            </main>
        </>
    );
}
