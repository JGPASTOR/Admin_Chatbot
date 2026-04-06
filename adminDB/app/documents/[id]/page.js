'use client';
import { useState, useEffect, Fragment } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Header from '../../../components/Header';
import TrackingTimeline from '../../../components/TrackingTimeline';
import StatusBadge from '../../../components/StatusBadge';
import { deriveStatus, currentAccountable } from '../../../lib/helpers';

function stripNum(name) { return (name || '').replace(/^\d+\.\s*/, ''); }

/* ── tiny style constants ── */
const TH = { padding: '9px 12px', color: '#fff', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap', borderRight: '1px solid rgba(255,255,255,0.15)', textAlign: 'left' };
const TD = { padding: '9px 12px', fontSize: 12, borderRight: '1px solid #e0e7ef', color: '#334155', verticalAlign: 'middle' };
const TH2 = { ...TH, fontSize: 11, background: '#1e6b3c', padding: '7px 12px' };
const TD2 = { ...TD, fontSize: 11, padding: '7px 12px', background: '#fff' };

export default function DocumentDetailPage() {
    const { id } = useParams();
    const [doc, setDoc] = useState(null);
    const [loading, setLoading] = useState(true);
    const [expandedRoute, setER] = useState(null);   // route rowNum
    const [expandedEmp, setEE] = useState({});      // { routeNum_empNo: bool }
    const [addModal, setAddModal] = useState(false);
    const [trackForm, setTF] = useState({ office: '', received_at: '', date_out: '', age: '', received_by: '', current_operation: '' });
    const [saving, setSaving] = useState(false);

    const OFFICES = [
        "City Mayor's Office", "City Treasury Office", "City Accounting Office", "City Health Office",
        "City Budget Office", "City Social Welfare and Development Office", "City Administrator's Office",
        "Bids and Awards Committee(City Mayor's Office)", "Office of the City Engineer(City Engineering Office)",
    ];

    const load = () => {
        setLoading(true);
        fetch(`/api/documents/${id}`).then(r => r.json()).then(d => { setDoc(d); setLoading(false); });
    };
    useEffect(() => { load(); }, [id]);

    const toggleEmp = (routeNum, empNo) => {
        const key = `${routeNum}_${empNo}`;
        setEE(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const handleAddTracking = async () => {
        setSaving(true);
        const routes = doc.details?.routes || [];
        const num = routes.length + 1;
        const newRoute = {
            age: trackForm.age, office: `${num}. ${trackForm.office}`,
            date_out: trackForm.date_out || null, received_at: trackForm.received_at,
            staff_operation: {
                employee: [{
                    'no.': 1, tat: trackForm.age, remarks: null,
                    date_out: trackForm.date_out || null, received_at: trackForm.received_at,
                    received_by: trackForm.received_by, current_operation: trackForm.current_operation,
                    received_by_photopath: '', isreturn: null,
                    processing: {
                        process: [{
                            'no.': 1, action: trackForm.current_operation,
                            started: trackForm.received_at, ended: trackForm.date_out || null,
                            tat: trackForm.age, isreturn: false, remarks: null
                        }]
                    }
                }]
            },
        };
        await fetch(`/api/documents/${id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...doc, details: { ...doc.details, routes: [...routes, newRoute] } })
        });
        setAddModal(false);
        setTF({ office: '', received_at: '', date_out: '', age: '', received_by: '', current_operation: '' });
        setSaving(false);
        load();
    };

    if (loading) return (<><Header title="Document Detail" /><main style={{ padding: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}><div style={{ color: '#94a3b8' }}>Loading…</div></main></>);
    if (!doc || doc.error) return (<><Header title="Not Found" /><main style={{ padding: 28 }}><div className="card" style={{ padding: 40, textAlign: 'center' }}><p style={{ color: '#94a3b8' }}>Document not found.</p><Link href="/documents" className="btn btn-primary" style={{ marginTop: 16 }}>← Back</Link></div></main></>);

    const routes = doc.details?.routes || [];
    const status = deriveStatus(doc);
    const acct = currentAccountable(doc);
    const overall = doc.overall_days_onprocess || '—';

    return (
        <>
            <Header title={doc.title} subtitle={doc.agency} />
            <main style={{ padding: '22px 28px', flex: 1 }}>

                {/* Back */}
                <Link href="/documents" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#64748b', fontWeight: 500, textDecoration: 'none', marginBottom: 16 }}>
                    <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6" /></svg>
                    Back to Documents
                </Link>

                {/* Stepper */}
                <div className="card" style={{ padding: '20px 28px', marginBottom: 14 }}>
                    <TrackingTimeline status={status} />
                </div>

                {/* Info bar */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, padding: '12px 18px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, marginBottom: 12, boxShadow: '0 1px 4px rgba(0,0,0,.06)', fontSize: 13 }}>
                    <div style={{ fontWeight: 700 }}>TRACKING NO:&nbsp;<span style={{ fontFamily: 'monospace', color: 'var(--primary)', fontSize: 13 }}>{doc.slug}</span></div>
                    <div><span style={{ fontWeight: 700 }}>Current Accountable:</span>&nbsp;<span style={{ color: '#1a65c8' }}>{acct}</span></div>
                    <div style={{ textAlign: 'right', fontSize: 12 }}><span style={{ fontWeight: 700 }}>Overall on process:</span>&nbsp;<span style={{ color: '#dc2626', fontWeight: 600 }}>{overall}</span></div>
                </div>

                {/* Meta chips */}
                <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                    {[['Origin Office', doc.office, '#1a65c8'], ['Created by', doc.created_by, '#334155'], ['Date Created', doc.created_at, '#334155']].map(([k, v, c]) => (
                        <div key={k} style={{ display: 'flex', gap: 6, alignItems: 'center', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 13px', fontSize: 12 }}>
                            <span style={{ color: '#94a3b8' }}>{k}:</span><span style={{ fontWeight: 600, color: c, textTransform: k === 'Origin Office' ? 'uppercase' : 'none' }}>{v}</span>
                        </div>
                    ))}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 13px', fontSize: 12 }}>
                        <span style={{ color: '#94a3b8' }}>Status:</span><StatusBadge status={status} />
                    </div>
                </div>

                {/* ════════════ SUMMARY TABLE ════════════ */}
                <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,.07)', marginBottom: 14 }}>

                    {/* Table header bar */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#14472c', padding: '13px 20px' }}>
                        <span style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>Summary</span>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => setAddModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 14px', borderRadius: 6, border: 'none', background: 'rgba(255,255,255,0.15)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>+ Add Entry</button>
                            <button onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 14px', borderRadius: 6, border: 'none', background: '#22c55e', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>🖨 Print</button>
                        </div>
                    </div>

                    {/* Column headers — outer route table */}
                    <div style={{ display: 'grid', gridTemplateColumns: '54px 1fr 1fr 1fr 1fr 46px', background: '#1a5c37' }}>
                        {['#', 'Office', 'Date Received', 'Turnaround Time', 'Out', ''].map((h, i) => (
                            <div key={i} style={{ ...TH, borderRight: i < 5 ? '1px solid rgba(255,255,255,0.12)' : 'none' }}>{h}</div>
                        ))}
                    </div>

                    {/* Route rows */}
                    {[...routes].reverse().map((route, idx) => {
                        const rowNum = routes.length - idx;
                        const isCurrent = !route.date_out;
                        const isExp = expandedRoute === rowNum;
                        const employees = route.staff_operation?.employee || [];
                        const rowBg = isCurrent ? 'rgba(34,197,94,0.06)' : (idx % 2 === 0 ? '#fff' : '#f8fafc');

                        return (
                            <div key={rowNum} style={{ borderBottom: isExp ? 'none' : '1px solid #e2e8f0' }}>

                                {/* ── Outer route row ── */}
                                <div style={{ display: 'grid', gridTemplateColumns: '54px 1fr 1fr 1fr 1fr 46px', background: rowBg }}
                                    onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = '#f0fdf6'; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = rowBg; }}>

                                    {/* # badge */}
                                    <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', borderRight: '1px solid #e2e8f0' }}>
                                        <span style={{
                                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: '50%',
                                            background: isCurrent ? '#e53e3e' : 'transparent', color: isCurrent ? '#fff' : '#64748b',
                                            fontWeight: 700, fontSize: 12, border: isCurrent ? 'none' : '1.5px solid #cbd5e1'
                                        }}>
                                            {rowNum}.
                                        </span>
                                    </div>
                                    {/* Office */}
                                    <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', fontSize: 12, fontWeight: 700, color: '#1a65c8', textTransform: 'uppercase', letterSpacing: '0.4px', borderRight: '1px solid #e2e8f0' }}>
                                        {stripNum(route.office)}
                                    </div>
                                    {/* Date Received */}
                                    <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', fontSize: 12, color: '#475569', borderRight: '1px solid #e2e8f0' }}>
                                        {route.received_at}
                                    </div>
                                    {/* Turnaround */}
                                    <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', fontSize: 12, color: route.date_out ? '#16843a' : '#d97706', fontWeight: 500, borderRight: '1px solid #e2e8f0' }}>
                                        {route.age}
                                    </div>
                                    {/* Out */}
                                    <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', fontSize: 12, color: '#1a65c8', borderRight: '1px solid #e2e8f0' }}>
                                        {route.date_out || '—'}
                                    </div>
                                    {/* Toggle */}
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                        <button onClick={() => setER(isExp ? null : rowNum)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 14, padding: '0 8px' }}>{isExp ? '▲' : '▽'}</button>
                                    </div>
                                </div>

                                {/* ══ EXPANDED — Employee sub-table, matches image ══ */}
                                {isExp && (
                                    <div style={{ borderLeft: '4px solid #1a5c37', marginLeft: 0, borderBottom: '1px solid #e2e8f0' }}>

                                        {/* Employee table */}
                                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                            <thead>
                                                <tr style={{ background: '#1a5c37' }}>
                                                    <th style={{ ...TH, width: 36 }}>#</th>
                                                    <th style={TH}>Received</th>
                                                    <th style={TH}>Accountable</th>
                                                    <th style={TH}>Current Operation</th>
                                                    <th style={TH}>Is Return</th>
                                                    <th style={TH}>Remarks</th>
                                                    <th style={TH}>Out</th>
                                                    <th style={TH}>Turnaround Time</th>
                                                    <th style={{ ...TH, borderRight: 'none', width: 36 }}></th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {employees.map((emp) => {
                                                    const ek = `${rowNum}_${emp['no.']}`;
                                                    const empExp = !!expandedEmp[ek];
                                                    const procs = emp.processing?.process || [];
                                                    return (
                                                        <Fragment key={ek}>
                                                            <tr style={{ background: emp['no.'] % 2 === 0 ? '#f8fafc' : '#fff', borderBottom: '1px solid #e2e8f0' }}
                                                                onMouseEnter={e => e.currentTarget.style.background = '#f0fdf6'}
                                                                onMouseLeave={e => e.currentTarget.style.background = emp['no.'] % 2 === 0 ? '#f8fafc' : '#fff'}>
                                                                <td style={{ ...TD, textAlign: 'center' }}>
                                                                    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: '#1a5c37', color: '#fff', fontWeight: 700, fontSize: 11 }}>
                                                                        {emp['no.']}
                                                                    </span>
                                                                </td>
                                                                <td style={TD}>
                                                                    <div style={{ fontSize: 11, color: '#475569', lineHeight: 1.4 }}>{emp.received_at}</div>
                                                                </td>
                                                                <td style={TD}>
                                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                                                        {/* Silhouette avatar */}
                                                                        <div style={{ width: 30, height: 30, borderRadius: '50%', background: '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                                                                            {emp.received_by_photopath ? (
                                                                                <img src={`/${emp.received_by_photopath}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { e.target.style.display = 'none'; }} />
                                                                            ) : (
                                                                                <svg width="16" height="16" fill="#94a3b8" viewBox="0 0 24 24"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" /></svg>
                                                                            )}
                                                                        </div>
                                                                        <div>
                                                                            <div style={{ fontWeight: 700, fontSize: 12, color: '#1e293b', textTransform: 'uppercase' }}>{emp.received_by}</div>
                                                                        </div>
                                                                    </div>
                                                                </td>
                                                                <td style={{ ...TD, color: '#1a65c8', fontWeight: 500, textTransform: 'uppercase' }}>{emp.current_operation}</td>
                                                                <td style={{ ...TD, textAlign: 'center' }}>
                                                                    <span style={{ padding: '2px 10px', borderRadius: 4, background: emp.isreturn ? '#fee2e2' : '#f0fdf4', color: emp.isreturn ? '#dc2626' : '#16a34a', fontWeight: 700, fontSize: 11 }}>
                                                                        {emp.isreturn ? 'YES' : 'NO'}
                                                                    </span>
                                                                </td>
                                                                <td style={{ ...TD, color: '#94a3b8', fontStyle: emp.remarks ? 'normal' : 'italic' }}>
                                                                    {emp.remarks || 'NONE'}
                                                                </td>
                                                                <td style={{ ...TD, color: '#1a65c8' }}>
                                                                    {emp.date_out || <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>—</span>}
                                                                </td>
                                                                <td style={TD}>{emp.tat}</td>
                                                                <td style={{ ...TD, borderRight: 'none', textAlign: 'center' }}>
                                                                    {procs.length > 0 && (
                                                                        <button onClick={() => toggleEmp(rowNum, emp['no.'])} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 13, padding: '0 4px' }}>
                                                                            {empExp ? '▲' : '▽'}
                                                                        </button>
                                                                    )}
                                                                </td>
                                                            </tr>

                                                            {/* ── Processing steps sub-table ── */}
                                                            {empExp && procs.length > 0 && (
                                                                <tr key={`${ek}-proc`}>
                                                                    <td colSpan={9} style={{ padding: 0, borderBottom: '1px solid #e2e8f0' }}>
                                                                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                                                            <thead>
                                                                                <tr style={{ background: '#2d7a4f' }}>
                                                                                    <th style={{ ...TH2, width: '35%' }}>Action</th>
                                                                                    <th style={TH2}>Started</th>
                                                                                    <th style={TH2}>Ended</th>
                                                                                    <th style={{ ...TH2, borderRight: 'none' }}>Remarks</th>
                                                                                </tr>
                                                                            </thead>
                                                                            <tbody>
                                                                                {procs.map((p, pi) => (
                                                                                    <tr key={pi} style={{ background: pi % 2 === 0 ? '#f0fdf6' : '#fff', borderBottom: '1px dashed #e2e8f0' }}>
                                                                                        <td style={{ ...TD2, fontWeight: 500, color: '#1e293b' }}>
                                                                                            {p['no.']}. {p.action}
                                                                                        </td>
                                                                                        <td style={{ ...TD2, color: '#475569' }}>{p.started || '—'}</td>
                                                                                        <td style={{ ...TD2, color: '#475569' }}>{p.ended || <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>Ongoing</span>}</td>
                                                                                        <td style={{ ...TD2, color: '#94a3b8', fontStyle: p.remarks ? 'normal' : 'italic', borderRight: 'none' }}>
                                                                                            {p.remarks || 'NONE'}
                                                                                        </td>
                                                                                    </tr>
                                                                                ))}
                                                                            </tbody>
                                                                        </table>
                                                                    </td>
                                                                </tr>
                                                            )}
                                                        </Fragment>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {routes.length === 0 && (
                        <div style={{ padding: '40px 20px', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
                            No tracking history yet — click <strong>+ Add Entry</strong> to begin.
                        </div>
                    )}
                </div>

                {/* Subject */}
                {doc.subject && (
                    <div className="card" style={{ padding: '16px 20px', marginBottom: 10 }}>
                        <h4 style={{ fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Subject / Description</h4>
                        <pre style={{ fontSize: 13, color: '#475569', lineHeight: 1.7, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{doc.subject}</pre>
                    </div>
                )}

                {/* Retention chips */}
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {[['User Retention', doc.user_retention], ['Office Retention', doc.office_retention], ['Validated By', doc.validated_by], ['Validated At', doc.validated_at]].filter(([, v]) => v).map(([k, v]) => (
                        <div key={k} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 13px', fontSize: 12 }}>
                            <span style={{ color: '#94a3b8' }}>{k}:</span>&nbsp;<span style={{ fontWeight: 600 }}>{v}</span>
                        </div>
                    ))}
                </div>

            </main>

            {/* Add Tracking Modal */}
            {addModal && (
                <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setAddModal(false); }}>
                    <div className="modal-box">
                        <div className="modal-header">
                            <h2>Add Tracking Entry</h2>
                            <button onClick={() => setAddModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', display: 'flex' }}>
                                <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                        </div>
                        <div className="modal-body">
                            <div className="form-group">
                                <label>Office</label>
                                <select className="form-control" value={trackForm.office} onChange={e => setTF(f => ({ ...f, office: e.target.value }))}>
                                    <option value="">— Select Office —</option>
                                    {OFFICES.map(o => <option key={o}>{o}</option>)}
                                </select>
                            </div>
                            <div className="form-group">
                                <label>Received By</label>
                                <input className="form-control" value={trackForm.received_by} onChange={e => setTF(f => ({ ...f, received_by: e.target.value }))} placeholder="Last, First" />
                            </div>
                            <div className="form-group">
                                <label>Current Operation</label>
                                <input className="form-control" value={trackForm.current_operation} onChange={e => setTF(f => ({ ...f, current_operation: e.target.value }))} placeholder="e.g. For Signature" />
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                <div className="form-group">
                                    <label>Date Received</label>
                                    <input className="form-control" value={trackForm.received_at} onChange={e => setTF(f => ({ ...f, received_at: e.target.value }))} placeholder="Oct 24, 2024 09:44:23 AM" />
                                </div>
                                <div className="form-group">
                                    <label>Date Out <span style={{ color: '#94a3b8', fontSize: 11 }}>(blank if still in office)</span></label>
                                    <input className="form-control" value={trackForm.date_out} onChange={e => setTF(f => ({ ...f, date_out: e.target.value }))} placeholder="Oct 24, 2024 11:37:08 AM" />
                                </div>
                            </div>
                            <div className="form-group">
                                <label>Turnaround Time</label>
                                <input className="form-control" value={trackForm.age} onChange={e => setTF(f => ({ ...f, age: e.target.value }))} placeholder="00 Mon/s, 01 Day/s, 52 min., & 44 sec." />
                            </div>
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-ghost" onClick={() => setAddModal(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={handleAddTracking} disabled={saving}>{saving ? 'Saving…' : 'Add Entry'}</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
