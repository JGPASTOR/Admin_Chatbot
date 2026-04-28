'use client';
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import Header from '../../components/Header';
import StatusBadge from '../../components/StatusBadge';
import Modal from '../../components/Modal';
import { deriveStatus, currentOffice, currentAccountable } from '../../lib/helpers';

const OFFICES_LIST = [
    "City Mayor's Office", "City Treasury Office", "City Accounting Office",
    "City Health Office", "City Budget Office", "City Social Welfare and Development Office",
    "City Administrator's Office", "Bids and Awards Committee(City Mayor's Office)",
    "Office of the City Engineer(City Engineering Office)",
];
const TITLES = ["PURCHASE REQUEST", "TRAVEL ORDER", "MEMORANDUM", "RESOLUTION", "ORDINANCE", "LETTER", "REPORT", "DISBURSEMENT VOUCHER", "OTHER"];

const EMPTY = {
    title: 'PURCHASE REQUEST',
    agency: 'City Government of Surigao',
    office: "City Health Office",
    subject: '',
    created_by: '',
    document_completed_status: false,
    details: { routes: [] },
};

export default function DocumentsPage() {
    const [docs, setDocs] = useState([]);
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState('all');
    const [modal, setModal] = useState(false);
    const [editDoc, setEditDoc] = useState(null);
    const [form, setForm] = useState(EMPTY);
    const [saving, setSaving] = useState(false);
    const [deleting, setDel] = useState(null);
    const [jsonModal, setJsonModal] = useState(false);
    const [jsonText, setJsonText] = useState('');
    const [importing, setImporting] = useState(false);

    const load = useCallback(() => {
        fetch('/api/documents')
            .then(r => r.json())
            .then(data => setDocs(Array.isArray(data) ? data : []))
            .catch(() => setDocs([]));
    }, []);

    useEffect(() => { load(); }, [load]);

    const openAdd = () => { setEditDoc(null); setForm(EMPTY); setModal(true); };
    const openEdit = (doc) => {
        setEditDoc(doc);
        setForm({
            title: doc.title,
            agency: doc.agency,
            office: doc.office,
            subject: doc.subject,
            created_by: doc.created_by,
            document_completed_status: doc.document_completed_status,
            details: doc.details,
        });
        setModal(true);
    };

    const handleImportJson = async () => {
        try {
            const parsed = JSON.parse(jsonText);
            let docsArray;
            if (Array.isArray(parsed)) {
                docsArray = parsed;
            } else if (parsed.data && Array.isArray(parsed.data)) {
                docsArray = parsed.data;
            } else if (parsed.data && typeof parsed.data === 'object') {
                docsArray = [parsed.data];
            } else {
                docsArray = [parsed];
            }

            setImporting(true);
            const now = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

            for (const doc of docsArray) {
                const payload = {
                    title: doc.title || 'OTHER',
                    agency: doc.agency || 'City Government of Surigao',
                    office: doc.office || "City Administrator's Office",
                    subject: doc.subject || '',
                    created_by: doc.created_by || '',
                    document_completed_status: doc.document_completed_status || false,
                    details: doc.details || { routes: [] },
                    created_at: doc.created_at || now,
                    validated_at: doc.validated_at || now,
                    validated_by: doc.validated_by || doc.created_by || '',
                    slug: doc.slug || `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                    overall_days_onprocess: doc.overall_days_onprocess || '—',
                    user_retention: doc.user_retention || '—',
                    office_retention: doc.office_retention || '—'
                };
                await fetch('/api/documents', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            }
            setJsonModal(false);
            setJsonText('');
            load();
            alert(`Successfully imported ${docsArray.length} document(s)!`);
        } catch (e) {
            alert('Invalid JSON format or import failed: ' + e.message);
        } finally {
            setImporting(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const now = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
            const payload = editDoc
                ? { ...editDoc, ...form }
                : {
                    ...form, created_at: now, validated_at: now, validated_by: form.created_by,
                    slug: `${Date.now()}-${form.title.toLowerCase().replace(/ /g, '-')}`,
                    overall_days_onprocess: '—', user_retention: '—', office_retention: '—'
                };

            if (editDoc) {
                await fetch(`/api/documents/${editDoc.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            } else {
                await fetch('/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            }
            setModal(false);
            load();
        } finally { setSaving(false); }
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this document?')) return;
        setDel(id);
        await fetch(`/api/documents/${id}`, { method: 'DELETE' });
        setDel(null);
        load();
    };

    const filtered = docs.filter(d => {
        const st = deriveStatus(d);
        const q = search.toLowerCase();
        const matchSearch = (d.title || '').toLowerCase().includes(q)
            || (d.subject || '').toLowerCase().includes(q)
            || (d.slug || '').toLowerCase().includes(q)
            || (d.created_by || '').toLowerCase().includes(q);
        const matchFilter = filter === 'all' || st === filter;
        return matchSearch && matchFilter;
    });

    return (
        <>
            <Header title="Documents" />
            <main style={{ padding: '28px 28px', flex: 1 }}>

                {/* Toolbar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
                    <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
                        <svg width="15" height="15" fill="none" stroke="var(--text-3)" strokeWidth="2" viewBox="0 0 24 24"
                            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }}>
                            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                        </svg>
                        <input className="form-control" placeholder="Search title, subject, slug, or created by…"
                            value={search} onChange={e => setSearch(e.target.value)} style={{ paddingLeft: 32, width: '100%' }} />
                    </div>
                    <select className="form-control" style={{ width: 160 }} value={filter} onChange={e => setFilter(e.target.value)}>
                        <option value="all">All Status</option>
                        <option value="creation">Creation</option>
                        <option value="in_progress">In Progress</option>
                        <option value="completed">Completed</option>
                    </select>
                    <button className="btn btn-secondary" onClick={() => setJsonModal(true)} style={{ backgroundColor: '#28a745', color: '#fff', borderColor: '#28a745' }}>
                        <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" style={{ marginRight: 6 }}>
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        Import JSON
                    </button>
                    <button className="btn btn-primary" onClick={openAdd}>
                        <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        Add Document
                    </button>
                </div>

                {/* Table */}
                <div className="card" style={{ overflowX: 'auto' }}>
                    <table className="tbl">
                        <thead>
                            <tr>
                                <th style={{ width: 40 }}>#</th>
                                <th>Document Title</th>
                                <th>Subject / Description</th>
                                <th>Origin Office</th>
                                <th>Current Office</th>
                                <th>Current Accountable</th>
                                <th>Status</th>
                                <th>Overall on Process</th>
                                <th>Date Created</th>
                                <th style={{ textAlign: 'center', width: 110 }}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((doc, i) => {
                                const st = deriveStatus(doc);
                                return (
                                    <tr key={doc.id}>
                                        <td style={{ color: 'var(--text-3)', fontWeight: 600 }}>{i + 1}.</td>
                                        <td>
                                            <Link href={`/documents/${doc.id}`} style={{ fontWeight: 700, color: 'var(--primary)', textDecoration: 'none', fontSize: 12 }}>
                                                {doc.title}
                                            </Link>
                                            <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'monospace', marginTop: 2 }}>
                                                {doc.slug?.slice(0, 30)}…
                                            </div>
                                        </td>
                                        <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>
                                            {doc.subject?.split('\n')[0]}
                                        </td>
                                        <td style={{ fontSize: 12, textTransform: 'uppercase', color: '#1a65c8', fontWeight: 600 }}>
                                            {doc.office}
                                        </td>
                                        <td style={{ fontSize: 12, textTransform: 'uppercase', color: '#1a65c8', fontWeight: 600 }}>
                                            {currentOffice(doc)}
                                        </td>
                                        <td style={{ color: 'var(--text-2)', fontSize: 12 }}>{currentAccountable(doc)}</td>
                                        <td><StatusBadge status={st} /></td>
                                        <td style={{ fontSize: 11, color: '#16843a', fontWeight: 500, whiteSpace: 'nowrap' }}>
                                            {doc.overall_days_onprocess}
                                        </td>
                                        <td style={{ color: 'var(--text-2)', fontSize: 12 }}>{doc.created_at}</td>
                                        <td style={{ textAlign: 'center' }}>
                                            <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                                                <Link href={`/documents/${doc.id}`} className="btn btn-ghost btn-sm" title="View Tracking">
                                                    <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                                                    </svg>
                                                </Link>
                                                <button className="btn btn-ghost btn-sm" onClick={() => openEdit(doc)} title="Edit">
                                                    <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                                    </svg>
                                                </button>
                                                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(doc.id)}
                                                    disabled={deleting === doc.id} title="Delete">
                                                    <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                                        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                                                    </svg>
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                            {filtered.length === 0 && (
                                <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 40 }}>No documents found</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
                    Showing {filtered.length} of {docs.length} documents
                </div>
            </main>

            {/* JSON Import Modal */}
            <Modal isOpen={jsonModal} onClose={() => setJsonModal(false)} title="Import Documents from JSON"
                footer={
                    <>
                        <button className="btn btn-ghost" onClick={() => setJsonModal(false)}>Cancel</button>
                        <button className="btn btn-primary" onClick={handleImportJson} disabled={importing} style={{ backgroundColor: '#28a745', borderColor: '#28a745' }}>
                            {importing ? 'Importing…' : 'Import JSON'}
                        </button>
                    </>
                }>
                <div className="form-group">
                    <label>Upload JSON File</label>
                    <input type="file" accept=".json" className="form-control" onChange={(e) => {
                        const file = e.target.files[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = (evt) => {
                            setJsonText(evt.target.result);
                        };
                        reader.readAsText(file);
                    }} style={{ marginBottom: 15 }} />
                </div>
            </Modal>

            {/* Add / Edit Modal */}
            <Modal isOpen={modal} onClose={() => setModal(false)} title={editDoc ? 'Edit Document' : 'Add New Document'}
                footer={
                    <>
                        <button className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
                        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                            {saving ? 'Saving…' : editDoc ? 'Save Changes' : 'Add Document'}
                        </button>
                    </>
                }>
                <div className="form-group">
                    <label>Document Title</label>
                    <select className="form-control" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}>
                        {TITLES.map(t => <option key={t}>{t}</option>)}
                    </select>
                </div>
                <div className="form-group">
                    <label>Agency</label>
                    <input className="form-control" value={form.agency} onChange={e => setForm(f => ({ ...f, agency: e.target.value }))} placeholder="e.g. City Government of Surigao" />
                </div>
                <div className="form-group">
                    <label>Origin Office</label>
                    <select className="form-control" value={form.office} onChange={e => setForm(f => ({ ...f, office: e.target.value }))}>
                        {OFFICES_LIST.map(o => <option key={o}>{o}</option>)}
                    </select>
                </div>
                <div className="form-group">
                    <label>Subject / Description</label>
                    <textarea className="form-control" rows={3} value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} placeholder="Detailed description of the document…" style={{ resize: 'vertical' }} />
                </div>
                <div className="form-group">
                    <label>Created By</label>
                    <input className="form-control" value={form.created_by} onChange={e => setForm(f => ({ ...f, created_by: e.target.value }))} placeholder="Last, First" />
                </div>
                <div className="form-group" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <input type="checkbox" id="completed" checked={form.document_completed_status}
                        onChange={e => setForm(f => ({ ...f, document_completed_status: e.target.checked }))} />
                    <label htmlFor="completed" style={{ margin: 0, cursor: 'pointer' }}>Mark as Completed</label>
                </div>
            </Modal>
        </>
    );
}
