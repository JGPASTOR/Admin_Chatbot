'use client';
import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Header from '../../../components/Header';

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ── Renders extracted spreadsheet data as tables ── */
function SpreadsheetView({ sheets }) {
    const sheetNames = Object.keys(sheets);
    const [activeSheet, setActiveSheet] = useState(sheetNames[0] || '');

    const rows = sheets[activeSheet] || [];
    const headerRow = rows[0] || [];
    const dataRows = rows.slice(1);

    return (
        <div>
            {/* Sheet tabs */}
            {sheetNames.length > 1 && (
                <div style={{ display: 'flex', gap: 4, marginBottom: 14, flexWrap: 'wrap' }}>
                    {sheetNames.map(name => (
                        <button key={name} onClick={() => setActiveSheet(name)} style={{
                            padding: '6px 16px', borderRadius: 6, border: '1px solid #e2e8f0',
                            background: activeSheet === name ? '#1a5c37' : '#fff',
                            color: activeSheet === name ? '#fff' : '#334155',
                            fontSize: 12, fontWeight: 600, cursor: 'pointer',
                            transition: 'all 0.15s',
                        }}>{name}</button>
                    ))}
                </div>
            )}

            <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: 10 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 600 }}>
                    <thead>
                        <tr style={{ background: '#1a5c37' }}>
                            {headerRow.map((cell, i) => (
                                <th key={i} style={{
                                    padding: '10px 14px', color: '#fff', fontWeight: 700, fontSize: 12,
                                    textAlign: 'left', borderRight: i < headerRow.length - 1 ? '1px solid rgba(255,255,255,0.12)' : 'none',
                                    whiteSpace: 'nowrap',
                                }}>{cell ?? ''}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {dataRows.length === 0 ? (
                            <tr><td colSpan={headerRow.length || 1} style={{ padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>No data rows in this sheet.</td></tr>
                        ) : dataRows.map((row, ri) => (
                            <tr key={ri}
                                style={{ background: ri % 2 === 0 ? '#fff' : '#f8fafc', borderBottom: '1px solid #e2e8f0' }}
                                onMouseEnter={e => e.currentTarget.style.background = '#f0fdf6'}
                                onMouseLeave={e => e.currentTarget.style.background = ri % 2 === 0 ? '#fff' : '#f8fafc'}>
                                {headerRow.map((_, ci) => (
                                    <td key={ci} style={{
                                        padding: '9px 14px', fontSize: 12, color: '#334155',
                                        borderRight: ci < headerRow.length - 1 ? '1px solid #e2e8f0' : 'none',
                                    }}>{row[ci] ?? ''}</td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: '#94a3b8' }}>
                {dataRows.length} row{dataRows.length !== 1 ? 's' : ''} × {headerRow.length} column{headerRow.length !== 1 ? 's' : ''}
            </div>
        </div>
    );
}

/* ── Renders Word HTML content ── */
function WordView({ html, text }) {
    if (html) {
        return (
            <div
                style={{
                    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '24px 28px',
                    fontSize: 13, lineHeight: 1.8, color: '#334155',
                }}
                dangerouslySetInnerHTML={{ __html: html }}
            />
        );
    }
    return (
        <pre style={{
            background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '24px 28px',
            fontSize: 13, lineHeight: 1.8, color: '#334155', whiteSpace: 'pre-wrap', fontFamily: 'inherit',
        }}>{text || 'No content extracted.'}</pre>
    );
}

/* ── Renders PDF text content ── */
function PdfView({ text, pages }) {
    return (
        <div>
            {pages && (
                <div style={{ marginBottom: 12, fontSize: 12, color: '#64748b', fontWeight: 500 }}>
                    📄 {pages} page{pages !== 1 ? 's' : ''}
                </div>
            )}
            <pre style={{
                background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '24px 28px',
                fontSize: 13, lineHeight: 1.8, color: '#334155', whiteSpace: 'pre-wrap', fontFamily: 'inherit',
                maxHeight: 800, overflowY: 'auto',
            }}>{text || 'No content extracted.'}</pre>
        </div>
    );
}

export default function GeneralDocDetailPage() {
    const { id } = useParams();
    const [doc, setDoc] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch(`/api/general-documents/${id}`)
            .then(r => r.json())
            .then(res => { setDoc(res.data || null); setLoading(false); })
            .catch(() => setLoading(false));
    }, [id]);

    if (loading) return (
        <>
            <Header title="Document Detail" />
            <main style={{ padding: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
                <div style={{ color: '#94a3b8' }}>Loading…</div>
            </main>
        </>
    );

    if (!doc) return (
        <>
            <Header title="Not Found" />
            <main style={{ padding: 28 }}>
                <div className="card" style={{ padding: 40, textAlign: 'center' }}>
                    <p style={{ color: '#94a3b8' }}>Document not found.</p>
                    <Link href="/upload-general-info" className="btn btn-primary" style={{ marginTop: 16 }}>← Back</Link>
                </div>
            </main>
        </>
    );

    const extracted = doc.extracted_data || {};

    return (
        <>
            <Header title={doc.original_name} subtitle="General Document Detail" />
            <main style={{ padding: '22px 28px', flex: 1 }}>

                {/* Back */}
                <Link href="/upload-general-info" style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12,
                    color: '#64748b', fontWeight: 500, textDecoration: 'none', marginBottom: 16,
                }}>
                    <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6" /></svg>
                    Back to Uploads
                </Link>

                {/* Meta bar */}
                <div style={{
                    display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap',
                }}>
                    {[
                        ['File Name', doc.original_name, '#1e293b'],
                        ['Type', (doc.file_type || '').toUpperCase(), doc.file_type === 'pdf' ? '#dc2626' : doc.file_type === 'xlsx' ? '#16a34a' : '#2563eb'],
                        ['Size', formatSize(doc.file_size), '#334155'],
                        ['Uploaded', formatDate(doc.created_at), '#334155'],
                    ].map(([k, v, c]) => (
                        <div key={k} style={{
                            display: 'flex', gap: 6, alignItems: 'center', background: '#fff',
                            border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 14px', fontSize: 12,
                        }}>
                            <span style={{ color: '#94a3b8' }}>{k}:</span>
                            <span style={{ fontWeight: 600, color: c }}>{v}</span>
                        </div>
                    ))}

                    {doc.file_path && (
                        <a href={doc.file_path} download={doc.original_name} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px',
                            borderRadius: 8, background: '#1a5c37', color: '#fff', fontSize: 12,
                            fontWeight: 600, textDecoration: 'none', cursor: 'pointer',
                        }}>
                            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="7 10 12 15 17 10" />
                                <line x1="12" y1="15" x2="12" y2="3" />
                            </svg>
                            Download Original
                        </a>
                    )}
                </div>

                {/* ── Extracted Content ── */}
                <div className="card" style={{ padding: '20px 24px' }}>
                    <h3 style={{
                        fontSize: 14, fontWeight: 700, color: '#14472c', marginBottom: 16,
                        paddingBottom: 10, borderBottom: '2px solid #e2e8f0',
                    }}>
                        📋 Extracted Content
                    </h3>

                    {extracted.type === 'spreadsheet' && extracted.sheets && (
                        <SpreadsheetView sheets={extracted.sheets} />
                    )}

                    {extracted.type === 'word' && (
                        <WordView html={extracted.html} text={extracted.text} />
                    )}

                    {extracted.type === 'pdf' && (
                        <PdfView text={extracted.text} pages={extracted.pages} />
                    )}

                    {extracted.error && (
                        <div style={{ padding: 20, textAlign: 'center', color: '#dc2626', fontSize: 13 }}>
                            ⚠ {extracted.error}
                        </div>
                    )}

                    {!extracted.type && !extracted.error && (
                        <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
                            No extracted content available.
                        </div>
                    )}
                </div>
            </main>
        </>
    );
}
