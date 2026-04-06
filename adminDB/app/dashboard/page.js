'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import Header from '../../components/Header';
import StatsCard from '../../components/StatsCard';
import StatusBadge from '../../components/StatusBadge';
import { deriveStatus, currentOffice, currentAccountable } from '../../lib/helpers';

export default function DashboardPage() {
    const [docs, setDocs] = useState([]);

    useEffect(() => {
        fetch('/api/documents')
            .then(r => r.json())
            .then(data => setDocs(Array.isArray(data) ? data : []))
            .catch(() => setDocs([]));
    }, []);

    const total = docs.length;
    const inProgress = docs.filter(d => deriveStatus(d) === 'in_progress').length;
    const completed = docs.filter(d => deriveStatus(d) === 'completed').length;
    const creation = docs.filter(d => deriveStatus(d) === 'creation').length;

    return (
        <>
            <Header title="Dashboard" />
            <main style={{ padding: '28px 28px', flex: 1 }}>

                {/* Stats */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 28 }}>
                    <StatsCard label="Total Documents" value={total} bg="#f0fdf6" color="var(--primary)"
                        icon={<svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>} />
                    <StatsCard label="In Progress" value={inProgress} bg="#fef3c7" color="#d97706"
                        icon={<svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>} />
                    <StatsCard label="Completed" value={completed} bg="#dcfce7" color="#16a34a"
                        icon={<svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>} />
                    <StatsCard label="New / Creation" value={creation} bg="#dbeafe" color="#1d4ed8"
                        icon={<svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" /></svg>} />
                </div>

                {/* Recent Documents */}
                <div className="card">
                    <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div>
                            <h3 style={{ fontWeight: 700, fontSize: 14 }}>Recent Documents</h3>
                            <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>Latest tracked documents in the system</p>
                        </div>
                        <Link href="/documents" style={{ fontSize: 12, color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
                            View all →
                        </Link>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                        <table className="tbl">
                            <thead>
                                <tr>
                                    <th style={{ width: 40 }}>#</th>
                                    <th>Title</th>
                                    <th>Subject</th>
                                    <th>Current Office</th>
                                    <th>Accountable</th>
                                    <th>Status</th>
                                    <th>Created</th>
                                    <th style={{ textAlign: 'center' }}>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {docs.slice(0, 5).map((doc, i) => (
                                    <tr key={doc.id}>
                                        <td style={{ color: 'var(--text-3)', fontWeight: 600 }}>{i + 1}.</td>
                                        <td style={{ fontWeight: 700, color: 'var(--primary)', fontSize: 12 }}>{doc.title}</td>
                                        <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                                            {doc.subject?.split('\n')[0]}
                                        </td>
                                        <td style={{ color: 'var(--primary)', fontWeight: 500, fontSize: 12 }}>{currentOffice(doc)}</td>
                                        <td style={{ color: 'var(--text-2)', fontSize: 12 }}>{currentAccountable(doc)}</td>
                                        <td><StatusBadge status={deriveStatus(doc)} /></td>
                                        <td style={{ color: 'var(--text-2)', fontSize: 12 }}>{doc.created_at}</td>
                                        <td style={{ textAlign: 'center' }}>
                                            <Link href={`/documents/${doc.id}`} className="btn btn-ghost btn-sm">View</Link>
                                        </td>
                                    </tr>
                                ))}
                                {docs.length === 0 && (
                                    <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 32 }}>No documents found</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

            </main>
        </>
    );
}
