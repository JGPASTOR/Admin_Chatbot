'use client';
import { useState, useEffect, useCallback } from 'react';
import Header from '../../components/Header';
import Modal from '../../components/Modal';

const EMPTY_FORM = { code: '', name: '', head: '' };

export default function OfficesPage() {
    const [offices, setOffices] = useState([]);
    const [modal, setModal] = useState(false);
    const [editOffice, setEditOffice] = useState(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [search, setSearch] = useState('');

    const load = useCallback(() => {
        fetch('/api/offices')
            .then(r => r.json())
            .then(data => setOffices(Array.isArray(data) ? data : []))
            .catch(() => setOffices([]));
    }, []);

    useEffect(() => { load(); }, [load]);

    const openAdd = () => { setEditOffice(null); setForm(EMPTY_FORM); setModal(true); };
    const openEdit = (o) => { setEditOffice(o); setForm({ code: o.code, name: o.name, head: o.head }); setModal(true); };

    const handleSave = async () => {
        setSaving(true);
        try {
            if (editOffice) {
                await fetch(`/api/offices/${editOffice.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
            } else {
                await fetch('/api/offices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
            }
            setModal(false);
            load();
        } finally { setSaving(false); }
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this office?')) return;
        await fetch(`/api/offices/${id}`, { method: 'DELETE' });
        load();
    };

    const filtered = offices.filter(o =>
        o.name.toLowerCase().includes(search.toLowerCase()) ||
        o.code.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <>
            <Header title="Offices" />
            <main style={{ padding: '28px 28px', flex: 1 }}>

                {/* Toolbar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                    <div style={{ position: 'relative', flex: 1, maxWidth: 340 }}>
                        <svg width="15" height="15" fill="none" stroke="var(--text-3)" strokeWidth="2" viewBox="0 0 24 24"
                            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }}>
                            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                        </svg>
                        <input className="form-control" placeholder="Search offices…" value={search}
                            onChange={e => setSearch(e.target.value)} style={{ paddingLeft: 32, width: '100%' }} />
                    </div>
                    <button className="btn btn-primary" onClick={openAdd}>
                        <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        Add Office
                    </button>
                </div>

                {/* Table */}
                <div className="card" style={{ overflowX: 'auto' }}>
                    <table className="tbl">
                        <thead>
                            <tr>
                                <th style={{ width: 40 }}>#</th>
                                <th style={{ width: 100 }}>Code</th>
                                <th>Office Name</th>
                                <th>Office Head</th>
                                <th style={{ textAlign: 'center', width: 120 }}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((o, i) => (
                                <tr key={o.id}>
                                    <td style={{ color: 'var(--text-3)', fontWeight: 600 }}>{i + 1}.</td>
                                    <td>
                                        <span style={{ fontWeight: 700, fontFamily: 'monospace', color: 'var(--primary)', background: '#f0fdf6', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>
                                            {o.code}
                                        </span>
                                    </td>
                                    <td style={{ fontWeight: 500 }}>{o.name}</td>
                                    <td style={{ color: 'var(--text-2)' }}>{o.head}</td>
                                    <td style={{ textAlign: 'center' }}>
                                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                                            <button className="btn btn-ghost btn-sm" onClick={() => openEdit(o)}>
                                                <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                                </svg>
                                                Edit
                                            </button>
                                            <button className="btn btn-danger btn-sm" onClick={() => handleDelete(o.id)}>
                                                <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                                    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                                                </svg>
                                                Delete
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {filtered.length === 0 && (
                                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 40 }}>No offices found</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
                    {filtered.length} office{filtered.length !== 1 ? 's' : ''}
                </div>
            </main>

            <Modal isOpen={modal} onClose={() => setModal(false)} title={editOffice ? 'Edit Office' : 'Add New Office'}
                footer={
                    <>
                        <button className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
                        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                            {saving ? 'Saving…' : editOffice ? 'Save Changes' : 'Add Office'}
                        </button>
                    </>
                }>
                <div className="form-group">
                    <label>Office Code</label>
                    <input className="form-control" value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} placeholder="e.g. CMO" />
                </div>
                <div className="form-group">
                    <label>Office Name</label>
                    <input className="form-control" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. City Mayor's Office" />
                </div>
                <div className="form-group">
                    <label>Office Head</label>
                    <input className="form-control" value={form.head} onChange={e => setForm(f => ({ ...f, head: e.target.value }))} placeholder="e.g. Mayor Jose Santos" />
                </div>
            </Modal>
        </>
    );
}
