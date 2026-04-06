'use client';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import Header from '../../components/Header';

const FILE_ICONS = {
    pdf: '📄',
    docx: '📝',
    doc: '📝',
    xlsx: '📊',
    xls: '📊',
};

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function UploadGeneralInfoPage() {
    const [docs, setDocs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [isRebuilding, setIsRebuilding] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [uploadProgress, setUploadProgress] = useState('');
    const fileRef = useRef(null);

    const load = () => {
        setLoading(true);
        fetch('/api/general-documents')
            .then(r => r.json())
            .then(res => { setDocs(res.data || []); setLoading(false); })
            .catch(() => setLoading(false));
    };
    useEffect(() => { load(); }, []);

    const handleUpload = async (file) => {
        if (!file) return;
        const ext = file.name.split('.').pop().toLowerCase();
        if (!['pdf', 'docx', 'doc', 'xlsx', 'xls'].includes(ext)) {
            alert('Unsupported file type. Please upload .docx, .pdf, or .xlsx files.');
            return;
        }
        if (file.size > 30 * 1024 * 1024) {
            alert('File exceeds the 30 MB limit.');
            return;
        }

        setUploading(true);
        setUploadProgress(`Uploading "${file.name}"…`);

        const fd = new FormData();
        fd.append('file', file);

        try {
            const res = await fetch('/api/general-documents', { method: 'POST', body: fd });
            const json = await res.json();
            if (json.success) {
                setUploadProgress(`✅ "${file.name}" uploaded and scanned successfully!`);
                load();
            } else {
                setUploadProgress(`❌ Error: ${json.error}`);
            }
        } catch (err) {
            setUploadProgress(`❌ Upload failed: ${err.message}`);
        }
        setUploading(false);
        setTimeout(() => setUploadProgress(''), 4000);
    };

    const handleDelete = async (id, name) => {
        if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
        await fetch(`/api/general-documents/${id}`, { method: 'DELETE' });
        load();
    };

    const handleRebuild = async () => {
        if (!confirm("Force AI Engine to resync all documents? Use this if the conversational AI is missing document information.")) return;
        setIsRebuilding(true);
        setUploadProgress("⏳ Syncing knowledge base with AI Engine...");
        try {
            // Need to route through our own API or directly to AI Engine?
            // The Next.js frontend is running on admin:3005, AI Engine is on ai_engine:8000
            // Since this is client-side, we must call the Next.js API route first if CORS block us, 
            // but we can add a new api/rebuild-rag route.
            // Wait, we can just call our own `api/general-documents/rebuild` route!
            const res = await fetch('/api/general-documents/rebuild', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setUploadProgress(`✅ Knowledge base successfully synced! (${data.total_chunks} chunks indexed)`);
            } else {
                setUploadProgress(`❌ Sync failed: ${data.error || 'Unknown error'}`);
            }
        } catch (err) {
            setUploadProgress(`❌ Sync failed: ${err.message}`);
        }
        setIsRebuilding(false);
        setTimeout(() => setUploadProgress(''), 5000);
    };

    const onDrop = (e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        handleUpload(file);
    };

    return (
        <>
            <Header title="Upload General Information" />
            <main style={{ padding: '22px 28px', flex: 1 }}>

                {/* ── Upload Zone ── */}
                <div
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={onDrop}
                    onClick={() => !uploading && fileRef.current?.click()}
                    style={{
                        border: `2px dashed ${dragOver ? 'var(--primary)' : '#14D62E'}`,
                        borderRadius: 14,
                        padding: '40px 24px',
                        textAlign: 'center',
                        marginBottom: 24,
                        cursor: uploading ? 'wait' : 'pointer',
                        background: dragOver ? 'rgba(34,197,94,0.06)' : '#FFFFFF',
                        transition: 'all 0.25s ease',
                        boxShadow: dragOver ? '0 0 0 4px rgba(34,197,94,0.1)' : 'none',
                    }}
                >
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".pdf,.docx,.doc,.xlsx,.xls"
                        hidden
                        onChange={e => handleUpload(e.target.files[0])}
                    />

                    <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
                        <svg width="48" height="48" fill="none" stroke={dragOver ? 'var(--primary)' : '#94a3b8'} strokeWidth="1.5" viewBox="0 0 24 24" style={{ transition: 'stroke 0.2s' }}>
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                    </div>

                    <div style={{ fontSize: 25, fontWeight: 600, color: 'rgba(0,0,0,0.8)', marginBottom: 6 }}>
                        {uploading ? 'Uploading…' : 'Drag & drop a file here, or click to browse'}
                    </div>
                    <div style={{ fontSize: 15, color: 'rgba(0,0,0,0.8)' }}>
                        Supports <strong>.docx</strong>, <strong>.pdf</strong>, <strong>.xlsx</strong> — Max 30 MB
                    </div>

                    {uploadProgress && (
                        <div style={{
                            marginTop: 14,
                            padding: '8px 16px',
                            borderRadius: 8,
                            background: uploadProgress.startsWith('✅') ? '#f0fdf4' : uploadProgress.startsWith('❌') ? '#fef2f2' : '#f0f9ff',
                            color: uploadProgress.startsWith('✅') ? '#16a34a' : uploadProgress.startsWith('❌') ? '#dc2626' : '#1a65c8',
                            fontSize: 13,
                            fontWeight: 500,
                            display: 'inline-block',
                        }}>
                            {uploadProgress}
                        </div>
                    )}
                </div>

                {/* ── Documents Table ── */}
                <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
                    <div style={{ background: '#14472c', padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div>
                            <span style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>Uploaded Documents</span>
                            <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, marginLeft: 12 }}>{docs.length} file{docs.length !== 1 ? 's' : ''}</span>
                        </div>
                        <button 
                            onClick={handleRebuild}
                            disabled={isRebuilding || loading}
                            style={{
                                background: '#10b981', color: '#fff', border: 'none', borderRadius: 6, 
                                padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: isRebuilding ? 'wait' : 'pointer',
                                opacity: isRebuilding ? 0.7 : 1
                            }}
                        >
                            {isRebuilding ? 'Syncing...' : '🔄 Resync Knowledge Base'}
                        </button>
                    </div>

                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ background: '#1a5c37' }}>
                                {['#', 'File Name', 'Type', 'Size', 'Date Uploaded', 'Actions'].map((h, i) => (
                                    <th key={i} style={{
                                        padding: '10px 14px', color: '#fff', fontWeight: 700, fontSize: 12,
                                        textAlign: i === 5 ? 'center' : 'left',
                                        borderRight: i < 5 ? '1px solid rgba(255,255,255,0.12)' : 'none',
                                    }}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr><td colSpan={6} style={{ padding: 40, textAlign: 'center', color: '#000000', fontSize: 13 }}>Loading…</td></tr>
                            ) : docs.length === 0 ? (
                                <tr><td colSpan={6} style={{ padding: 40, textAlign: 'center', color: '#000000', fontSize: 13 }}>No documents uploaded yet. Drop a file above to get started.</td></tr>
                            ) : docs.map((doc, idx) => (
                                <tr key={doc.id}
                                    style={{ background: idx % 2 === 0 ? '#fff' : '#f8fafc', borderBottom: '1px solid #e2e8f0' }}
                                    onMouseEnter={e => e.currentTarget.style.background = '#f0fdf6'}
                                    onMouseLeave={e => e.currentTarget.style.background = idx % 2 === 0 ? '#fff' : '#f8fafc'}>
                                    <td style={{ padding: '10px 14px', fontSize: 12, color: '#000000', borderRight: '1px solid #e2e8f0' }}>{idx + 1}</td>
                                    <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 600, color: '#000000', borderRight: '1px solid #e2e8f0' }}>
                                        <span style={{ marginRight: 8, fontSize: 16 }}>{FILE_ICONS[doc.file_type] || '📄'}</span>
                                        {doc.original_name}
                                    </td>
                                    <td style={{ padding: '10px 14px', fontSize: 12, borderRight: '1px solid #e2e8f0' }}>
                                        <span style={{
                                            padding: '2px 10px', borderRadius: 4, fontWeight: 700, fontSize: 11, textTransform: 'uppercase',
                                            background: doc.file_type === 'pdf' ? '#fee2e2' : doc.file_type === 'xlsx' || doc.file_type === 'xls' ? '#dcfce7' : '#dbeafe',
                                            color: doc.file_type === 'pdf' ? '#dc2626' : doc.file_type === 'xlsx' || doc.file_type === 'xls' ? '#16a34a' : '#2563eb',
                                        }}>{doc.file_type}</span>
                                    </td>
                                    <td style={{ padding: '10px 14px', fontSize: 12, color: '#000000', borderRight: '1px solid #e2e8f0' }}>{formatSize(doc.file_size)}</td>
                                    <td style={{ padding: '10px 14px', fontSize: 12, color: '#000000', borderRight: '1px solid #e2e8f0' }}>{formatDate(doc.created_at)}</td>
                                    <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                                        <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                                            <Link href={`/upload-general-info/${doc.id}`} style={{
                                                padding: '5px 12px', borderRadius: 6, background: '#1a5c37', color: '#fff',
                                                fontSize: 11, fontWeight: 600, textDecoration: 'none', cursor: 'pointer',
                                            }}>View</Link>
                                            <button onClick={() => handleDelete(doc.id, doc.original_name)} style={{
                                                padding: '5px 12px', borderRadius: 6, background: '#dc2626', color: '#fff',
                                                fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
                                            }}>Delete</button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </main>
        </>
    );
}
