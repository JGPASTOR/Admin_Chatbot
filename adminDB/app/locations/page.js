'use client';
import { useState, useEffect } from 'react';
import Header from '../../components/Header';

const CATEGORIES = [
    { value: 'restaurant', label: 'Restaurant / Food' },
    { value: 'shop', label: 'Shop / Store' },
    { value: 'tourist_spot', label: 'Tourist Spot' },
    { value: 'hotel', label: 'Hotel / Accommodation' },
    { value: 'hospital', label: 'Hospital / Clinic' },
    { value: 'government', label: 'Government Office' },
    { value: 'school', label: 'School / University' },
    { value: 'other', label: 'Other' },
];

const CAT_COLORS = {
    restaurant: { bg: '#fef3c7', color: '#d97706', dot: '#f59e0b' },
    shop: { bg: '#dbeafe', color: '#1d4ed8', dot: '#3b82f6' },
    tourist_spot: { bg: '#d1fae5', color: '#065f46', dot: '#10b981' },
    hotel: { bg: '#ede9fe', color: '#5b21b6', dot: '#8b5cf6' },
    hospital: { bg: '#fee2e2', color: '#991b1b', dot: '#ef4444' },
    government: { bg: '#e0f2fe', color: '#0369a1', dot: '#0ea5e9' },
    school: { bg: '#fce7f3', color: '#9d174d', dot: '#ec4899' },
    other: { bg: '#f3f4f6', color: '#374151', dot: '#9ca3af' },
};

const CAT_ICONS = {
    restaurant: '🍽️',
    shop: '🛍️',
    tourist_spot: '🏛️',
    hotel: '🏨',
    hospital: '🏥',
    government: '🏛️',
    school: '🎓',
    other: '📍',
};

const EMPTY_FORM = {
    name: '', category: 'restaurant', description: '', address: '',
    latitude: '', longitude: '', contact: '', operating_hours: '', google_maps_url: '',
};

function catLabel(value) {
    return CATEGORIES.find(c => c.value === value)?.label ?? value;
}

function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function LocationsPage() {
    const [locations, setLocations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState('');
    const [form, setForm] = useState(EMPTY_FORM);
    const [editId, setEditId] = useState(null);
    const [showForm, setShowForm] = useState(false);
    const [filterCat, setFilterCat] = useState('all');
    const [search, setSearch] = useState('');
    const [deleteConfirm, setDeleteConfirm] = useState(null);
    const [syncing, setSyncing] = useState(false);

    const load = () => {
        setLoading(true);
        fetch('/api/locations')
            .then(r => r.json())
            .then(res => { setLocations(res.data || []); setLoading(false); })
            .catch(() => setLoading(false));
    };

    useEffect(() => { load(); }, []);

    const showMsg = (text) => {
        setMsg(text);
        setTimeout(() => setMsg(''), 5000);
    };

    const handleChange = (e) => {
        const { name, value } = e.target;
        setForm(f => ({ ...f, [name]: value }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!form.name.trim()) { showMsg('❌ Name is required.'); return; }
        setSaving(true);

        const url = editId ? `/api/locations/${editId}` : '/api/locations';
        const method = editId ? 'PUT' : 'POST';

        try {
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...form,
                    latitude: form.latitude ? parseFloat(form.latitude) : null,
                    longitude: form.longitude ? parseFloat(form.longitude) : null,
                }),
            });
            const json = await res.json();
            if (json.success) {
                showMsg(editId ? '✅ Location updated and re-indexed in AI!' : '✅ Location saved and indexed in AI!');
                setForm(EMPTY_FORM);
                setEditId(null);
                setShowForm(false);
                load();
            } else {
                showMsg(`❌ ${json.error}`);
            }
        } catch (err) {
            showMsg(`❌ ${err.message}`);
        }
        setSaving(false);
    };

    const handleEdit = (loc) => {
        setForm({
            name: loc.name || '',
            category: loc.category || 'restaurant',
            description: loc.description || '',
            address: loc.address || '',
            latitude: loc.latitude ?? '',
            longitude: loc.longitude ?? '',
            contact: loc.contact || '',
            operating_hours: loc.operating_hours || '',
            google_maps_url: loc.google_maps_url || '',
        });
        setEditId(loc.id);
        setShowForm(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const handleDelete = async (id) => {
        try {
            const res = await fetch(`/api/locations/${id}`, { method: 'DELETE' });
            const json = await res.json();
            if (json.success) { showMsg('✅ Location deleted.'); load(); }
            else showMsg(`❌ ${json.error}`);
        } catch (err) {
            showMsg(`❌ ${err.message}`);
        }
        setDeleteConfirm(null);
    };

    const cancelForm = () => {
        setForm(EMPTY_FORM);
        setEditId(null);
        setShowForm(false);
    };

    const handleSyncRAG = async () => {
        setSyncing(true);
        try {
            const res = await fetch('/api/rag/sync-locations', { method: 'POST' });
            const json = await res.json();
            if (json.success) showMsg(`✅ RAG synced — ${json.total_chunks ?? 0} new chunk(s) added.`);
            else showMsg(`❌ Sync failed: ${json.message || 'Unknown error'}`);
        } catch (err) {
            showMsg(`❌ Sync failed: ${err.message}`);
        }
        setSyncing(false);
    };

    const filtered = locations.filter(l => {
        const matchCat = filterCat === 'all' || l.category === filterCat;
        const q = search.toLowerCase();
        const matchSearch = !q || l.name.toLowerCase().includes(q) || (l.address || '').toLowerCase().includes(q) || (l.description || '').toLowerCase().includes(q);
        return matchCat && matchSearch;
    });

    const countByCat = (cat) => locations.filter(l => l.category === cat).length;

    return (
        <>
            <Header title="Places & Spots" />
            <main style={{ padding: '28px', flex: 1 }}>

                {/* Message banner */}
                {msg && (
                    <div style={{
                        marginBottom: 16, padding: '12px 16px', borderRadius: 8,
                        background: msg.startsWith('✅') ? '#f0fdf4' : '#fef2f2',
                        color: msg.startsWith('✅') ? '#15803d' : '#dc2626',
                        border: `1px solid ${msg.startsWith('✅') ? '#bbf7d0' : '#fecaca'}`,
                        fontWeight: 500, fontSize: 13,
                    }}>{msg}</div>
                )}

                {/* Header row */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                    <div>
                        <h2 style={{ fontWeight: 700, fontSize: 18, margin: 0 }}>Shops, Restaurants & Tourist Spots</h2>
                        <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '4px 0 0' }}>
                            Locations added here are indexed in the AI so tourists can ask where to find them, including map links.
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button
                            onClick={handleSyncRAG}
                            disabled={syncing}
                            title="Re-sync all locations into the AI chatbot knowledge base"
                            style={{
                                padding: '9px 14px', background: syncing ? '#e5e7eb' : '#f0fdf4',
                                color: syncing ? '#9ca3af' : '#15803d',
                                border: '1.5px solid ' + (syncing ? '#d1d5db' : '#bbf7d0'),
                                borderRadius: 8, fontWeight: 600, fontSize: 13,
                                cursor: syncing ? 'not-allowed' : 'pointer',
                                display: 'flex', alignItems: 'center', gap: 6,
                            }}>
                            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24"
                                style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }}>
                                <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            {syncing ? 'Syncing…' : 'Sync to AI'}
                        </button>
                        {!showForm && (
                            <button
                                onClick={() => setShowForm(true)}
                                style={{
                                    padding: '9px 18px', background: 'var(--primary)', color: '#fff',
                                    border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13,
                                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                                }}>
                                <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                                </svg>
                                Add Location
                            </button>
                        )}
                    </div>
                </div>

                {/* Category summary pills */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                    {CATEGORIES.map(c => {
                        const n = countByCat(c.value);
                        if (n === 0 && filterCat !== c.value) return null;
                        const col = CAT_COLORS[c.value];
                        return (
                            <button key={c.value}
                                onClick={() => setFilterCat(filterCat === c.value ? 'all' : c.value)}
                                style={{
                                    padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                                    border: `1.5px solid ${filterCat === c.value ? col.dot : 'transparent'}`,
                                    background: filterCat === c.value ? col.bg : '#f3f4f6',
                                    color: filterCat === c.value ? col.color : '#6b7280',
                                    cursor: 'pointer',
                                }}>
                                {CAT_ICONS[c.value]} {c.label} {n > 0 && `(${n})`}
                            </button>
                        );
                    })}
                    {filterCat !== 'all' && (
                        <button onClick={() => setFilterCat('all')} style={{
                            padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                            border: '1.5px solid #d1d5db', background: '#fff', color: '#374151', cursor: 'pointer',
                        }}>✕ Clear</button>
                    )}
                </div>

                {/* Add / Edit Form */}
                {showForm && (
                    <div className="card" style={{ marginBottom: 24 }}>
                        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <h3 style={{ fontWeight: 700, fontSize: 14, margin: 0 }}>
                                {editId ? '✏️ Edit Location' : '📍 Add New Location'}
                            </h3>
                            <button onClick={cancelForm} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 18 }}>✕</button>
                        </div>
                        <form onSubmit={handleSubmit} style={{ padding: 20 }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                {/* Name */}
                                <div style={{ gridColumn: '1 / -1' }}>
                                    <label style={labelStyle}>Name *</label>
                                    <input name="name" value={form.name} onChange={handleChange} required
                                        placeholder="e.g. Jollibee SM City, Mount Apo Viewpoint"
                                        style={inputStyle} />
                                </div>

                                {/* Category */}
                                <div>
                                    <label style={labelStyle}>Category *</label>
                                    <select name="category" value={form.category} onChange={handleChange} style={inputStyle}>
                                        {CATEGORIES.map(c => (
                                            <option key={c.value} value={c.value}>{c.label}</option>
                                        ))}
                                    </select>
                                </div>

                                {/* Contact */}
                                <div>
                                    <label style={labelStyle}>Contact / Phone</label>
                                    <input name="contact" value={form.contact} onChange={handleChange}
                                        placeholder="e.g. 09XX-XXX-XXXX"
                                        style={inputStyle} />
                                </div>

                                {/* Address */}
                                <div style={{ gridColumn: '1 / -1' }}>
                                    <label style={labelStyle}>Address</label>
                                    <input name="address" value={form.address} onChange={handleChange}
                                        placeholder="e.g. Km. 5, Buhangin, Davao City"
                                        style={inputStyle} />
                                </div>

                                {/* Description */}
                                <div style={{ gridColumn: '1 / -1' }}>
                                    <label style={labelStyle}>Description</label>
                                    <textarea name="description" value={form.description} onChange={handleChange}
                                        rows={3} placeholder="Brief description of the place…"
                                        style={{ ...inputStyle, resize: 'vertical' }} />
                                </div>

                                {/* Operating Hours */}
                                <div>
                                    <label style={labelStyle}>Operating Hours</label>
                                    <input name="operating_hours" value={form.operating_hours} onChange={handleChange}
                                        placeholder="e.g. Mon–Sat 8am–8pm"
                                        style={inputStyle} />
                                </div>

                                {/* Google Maps URL */}
                                <div>
                                    <label style={labelStyle}>Google Maps Link</label>
                                    <input name="google_maps_url" value={form.google_maps_url} onChange={handleChange}
                                        placeholder="https://maps.google.com/..."
                                        style={inputStyle} />
                                </div>

                                {/* Coordinates */}
                                <div>
                                    <label style={labelStyle}>Latitude <span style={{ color: '#9ca3af', fontWeight: 400 }}>(optional)</span></label>
                                    <input name="latitude" value={form.latitude} onChange={handleChange}
                                        type="number" step="any" placeholder="e.g. 7.0732"
                                        style={inputStyle} />
                                </div>
                                <div>
                                    <label style={labelStyle}>Longitude <span style={{ color: '#9ca3af', fontWeight: 400 }}>(optional)</span></label>
                                    <input name="longitude" value={form.longitude} onChange={handleChange}
                                        type="number" step="any" placeholder="e.g. 125.6128"
                                        style={inputStyle} />
                                </div>
                            </div>

                            <div style={{ marginTop: 18, display: 'flex', gap: 10, alignItems: 'center' }}>
                                <button type="submit" disabled={saving}
                                    style={{
                                        padding: '9px 22px', background: 'var(--primary)', color: '#fff',
                                        border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13,
                                        cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
                                    }}>
                                    {saving ? (editId ? 'Updating…' : 'Saving…') : (editId ? 'Update Location' : 'Save & Index in AI')}
                                </button>
                                <button type="button" onClick={cancelForm}
                                    style={{
                                        padding: '9px 16px', background: '#f3f4f6', color: '#374151',
                                        border: '1px solid #d1d5db', borderRadius: 8, fontWeight: 500, fontSize: 13,
                                        cursor: 'pointer',
                                    }}>
                                    Cancel
                                </button>
                                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                                    Location will be automatically available to the AI chatbot after saving.
                                </span>
                            </div>
                        </form>
                    </div>
                )}

                {/* Search bar */}
                <div style={{ marginBottom: 16, position: 'relative' }}>
                    <svg style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', opacity: 0.4 }}
                        width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input value={search} onChange={e => setSearch(e.target.value)}
                        placeholder="Search by name, address, or description…"
                        style={{ ...inputStyle, paddingLeft: 36, maxWidth: 400 }} />
                </div>

                {/* Locations Table */}
                <div className="card">
                    <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                            <h3 style={{ fontWeight: 700, fontSize: 14, margin: 0 }}>All Locations</h3>
                            <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                                {filtered.length} of {locations.length} location{locations.length !== 1 ? 's' : ''}
                            </p>
                        </div>
                    </div>

                    {loading ? (
                        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>Loading…</div>
                    ) : filtered.length === 0 ? (
                        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-3)' }}>
                            <div style={{ fontSize: 32, marginBottom: 8 }}>📍</div>
                            <div style={{ fontSize: 14, fontWeight: 600 }}>No locations yet</div>
                            <div style={{ fontSize: 12, marginTop: 4 }}>Add shops, restaurants, and tourist spots so the AI can answer location questions.</div>
                        </div>
                    ) : (
                        <div style={{ overflowX: 'auto' }}>
                            <table className="tbl" style={{ width: '100%' }}>
                                <thead>
                                    <tr>
                                        <th style={{ width: 40 }}>#</th>
                                        <th>Name</th>
                                        <th>Category</th>
                                        <th>Address</th>
                                        <th>Hours</th>
                                        <th>Map</th>
                                        <th>Added</th>
                                        <th style={{ width: 90 }}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map((loc, i) => {
                                        const col = CAT_COLORS[loc.category] || CAT_COLORS.other;
                                        return (
                                            <tr key={loc.id}>
                                                <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{i + 1}</td>
                                                <td>
                                                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                                                        {CAT_ICONS[loc.category] || '📍'} {loc.name}
                                                    </div>
                                                    {loc.description && (
                                                        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                            {loc.description}
                                                        </div>
                                                    )}
                                                    {loc.contact && (
                                                        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1 }}>📞 {loc.contact}</div>
                                                    )}
                                                </td>
                                                <td>
                                                    <span style={{
                                                        display: 'inline-block', padding: '3px 10px', borderRadius: 12,
                                                        fontSize: 11, fontWeight: 600,
                                                        background: col.bg, color: col.color,
                                                    }}>
                                                        {catLabel(loc.category)}
                                                    </span>
                                                </td>
                                                <td style={{ fontSize: 12, color: 'var(--text-2)', maxWidth: 200 }}>
                                                    {loc.address || <span style={{ color: 'var(--text-3)' }}>—</span>}
                                                </td>
                                                <td style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>
                                                    {loc.operating_hours || <span style={{ color: 'var(--text-3)' }}>—</span>}
                                                </td>
                                                <td>
                                                    {loc.google_maps_url ? (
                                                        <a href={loc.google_maps_url} target="_blank" rel="noopener noreferrer"
                                                            style={{
                                                                display: 'inline-flex', alignItems: 'center', gap: 4,
                                                                fontSize: 11, color: '#2563eb', fontWeight: 600,
                                                                textDecoration: 'none', padding: '3px 8px',
                                                                background: '#eff6ff', borderRadius: 6,
                                                            }}>
                                                            <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                                                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                                                                <circle cx="12" cy="10" r="3" />
                                                            </svg>
                                                            Map
                                                        </a>
                                                    ) : (
                                                        <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>
                                                    )}
                                                </td>
                                                <td style={{ fontSize: 12, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                                                    {formatDate(loc.created_at)}
                                                </td>
                                                <td>
                                                    <div style={{ display: 'flex', gap: 6 }}>
                                                        <button onClick={() => handleEdit(loc)}
                                                            style={{
                                                                padding: '4px 10px', fontSize: 11, fontWeight: 600,
                                                                background: '#f0fdf4', color: '#15803d',
                                                                border: '1px solid #bbf7d0', borderRadius: 6, cursor: 'pointer',
                                                            }}>Edit</button>
                                                        {deleteConfirm === loc.id ? (
                                                            <div style={{ display: 'flex', gap: 4 }}>
                                                                <button onClick={() => handleDelete(loc.id)}
                                                                    style={{
                                                                        padding: '4px 8px', fontSize: 11, fontWeight: 600,
                                                                        background: '#fee2e2', color: '#dc2626',
                                                                        border: '1px solid #fecaca', borderRadius: 6, cursor: 'pointer',
                                                                    }}>Yes</button>
                                                                <button onClick={() => setDeleteConfirm(null)}
                                                                    style={{
                                                                        padding: '4px 8px', fontSize: 11,
                                                                        background: '#f3f4f6', color: '#374151',
                                                                        border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer',
                                                                    }}>No</button>
                                                            </div>
                                                        ) : (
                                                            <button onClick={() => setDeleteConfirm(loc.id)}
                                                                style={{
                                                                    padding: '4px 10px', fontSize: 11, fontWeight: 600,
                                                                    background: '#fef2f2', color: '#dc2626',
                                                                    border: '1px solid #fecaca', borderRadius: 6, cursor: 'pointer',
                                                                }}>Delete</button>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </main>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </>
    );
}

const inputStyle = {
    width: '100%',
    padding: '8px 12px',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
    background: '#fff',
    color: 'var(--text-1)',
};

const labelStyle = {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-2)',
    marginBottom: 5,
};
