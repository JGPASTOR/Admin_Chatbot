'use client';
import { useState, useEffect, useCallback } from 'react';
import Header from '../../../components/Header';

// ── constants ──────────────────────────────────────────────────────────────
const AI_ENGINE_URL = process.env.NEXT_PUBLIC_AI_ENGINE_URL || 'http://localhost:8000';

const METRIC_CONFIG = {
    faq_coverage_rate:      { label: 'FAQ Coverage Rate',        target: 60,   unit: '%',  higher: true,  icon: '🎯', desc: '% of queries answered by FAQ cache' },
    rag_hit_rate:           { label: 'RAG Hit Rate',             target: 80,   unit: '%',  higher: true,  icon: '📚', desc: '% of queries served without LLM' },
    llm_usage_per_100:      { label: 'LLM Usage / 100 Queries',  target: 30,   unit: '%',  higher: false, icon: '🤖', desc: 'Lower is better — target <30%' },
    flagged_resolution_rate:{ label: 'Flagged Resolution Rate',  target: 90,   unit: '%',  higher: true,  icon: '✅', desc: '% of flagged queries resolved in 48h' },
    avg_response_ms:        { label: 'Avg Response Time',        target: 2000, unit: 'ms', higher: false, icon: '⚡', desc: 'Target <2 000 ms end-to-end' },
};

function getScoreColor(score, max = 20) {
    const ratio = score / max;
    if (ratio >= 0.85) return '#16a34a';   // green
    if (ratio >= 0.60) return '#d97706';   // amber
    return '#dc2626';                       // red
}

function getOverallGrade(score) {
    if (score >= 90) return { grade: 'A+', label: 'Excellent',    color: '#16a34a' };
    if (score >= 80) return { grade: 'A',  label: 'Very Good',    color: '#22c55e' };
    if (score >= 70) return { grade: 'B',  label: 'Good',         color: '#84cc16' };
    if (score >= 55) return { grade: 'C',  label: 'Needs Work',   color: '#d97706' };
    if (score >= 40) return { grade: 'D',  label: 'Poor',         color: '#f97316' };
    return                  { grade: 'F',  label: 'Critical',     color: '#dc2626' };
}

// ── Circular gauge ─────────────────────────────────────────────────────────
function CircleGauge({ score, max = 20, size = 80, strokeWidth = 8 }) {
    const r = (size - strokeWidth) / 2;
    const circ = 2 * Math.PI * r;
    const fill = (score / max) * circ;
    const color = getScoreColor(score, max);
    return (
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none"
                stroke="#e2e8f0" strokeWidth={strokeWidth} />
            <circle cx={size / 2} cy={size / 2} r={r} fill="none"
                stroke={color} strokeWidth={strokeWidth}
                strokeDasharray={`${fill} ${circ}`}
                strokeLinecap="round"
                style={{ transition: 'stroke-dasharray 0.8s ease' }} />
        </svg>
    );
}

// ── Mini bar chart for daily trend ────────────────────────────────────────
function TrendBar({ trend }) {
    if (!trend || trend.length === 0) {
        return <div style={{ color: 'var(--text-3)', fontSize: 12, textAlign: 'center', padding: 16 }}>No trend data yet</div>;
    }
    const maxV = Math.max(...trend.map(t => t.queries), 1);
    return (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 80, padding: '0 4px' }}>
            {trend.map((t, i) => {
                const h = Math.max(4, (t.queries / maxV) * 72);
                return (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                        <div title={`${t.day}: ${t.queries} queries`} style={{
                            width: '100%', height: h,
                            background: 'linear-gradient(180deg, #22c55e, #1a5c37)',
                            borderRadius: '3px 3px 0 0',
                            transition: 'height 0.6s ease',
                        }} />
                        <span style={{ fontSize: 9, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                            {t.day?.slice(5)}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

// ── Tier Donut ───────────────────────────────────────────────────────────
function TierDonut({ faq, rag, llm, total }) {
    if (!total) return <div style={{ color: 'var(--text-3)', fontSize: 12, textAlign: 'center', padding: 16 }}>No data yet</div>;
    const tiers = [
        { label: 'FAQ Cache',     value: faq, color: '#22c55e' },
        { label: 'RAG Template',  value: rag, color: '#3b82f6' },
        { label: 'LLM (Qwen3)',   value: llm, color: '#f97316' },
    ];
    return (
        <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flexShrink: 0 }}>
                <svg width={120} height={120} viewBox="0 0 42 42">
                    <circle cx="21" cy="21" r="15.91549430918954" fill="transparent"
                        stroke="#e2e8f0" strokeWidth="3" />
                    {(() => {
                        let offset = 0;
                        const circ = 100;
                        return tiers.map((t, i) => {
                            const slice = (t.value / total) * circ;
                            const el = (
                                <circle key={i} cx="21" cy="21" r="15.91549430918954" fill="transparent"
                                    stroke={t.color} strokeWidth="3"
                                    strokeDasharray={`${slice} ${circ - slice}`}
                                    strokeDashoffset={100 - offset}
                                    style={{ transition: 'stroke-dasharray 0.8s ease' }}
                                />
                            );
                            offset += slice;
                            return el;
                        });
                    })()}
                </svg>
                <div style={{
                    position: 'absolute', inset: 0, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    flexDirection: 'column',
                }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{total}</span>
                    <span style={{ fontSize: 9, color: 'var(--text-3)' }}>queries</span>
                </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {tiers.map((t, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 10, height: 10, borderRadius: 2, background: t.color, flexShrink: 0 }} />
                        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{t.label}</span>
                        <span style={{ marginLeft: 'auto', fontWeight: 700, fontSize: 12, color: 'var(--text)', paddingLeft: 12 }}>
                            {total > 0 ? `${Math.round(t.value / total * 100)}%` : '—'}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function KnowledgeHealthPage() {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [days, setDays] = useState(7);
    const [lastRefresh, setLastRefresh] = useState(null);

    const fetchHealth = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`${AI_ENGINE_URL}/api/admin/knowledge-health?days=${days}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            setData(json);
            setLastRefresh(new Date());
        } catch (e) {
            setError(`Could not load metrics: ${e.message}`);
        } finally {
            setLoading(false);
        }
    }, [days]);

    useEffect(() => { fetchHealth(); }, [fetchHealth]);

    // Auto-refresh every 60 s
    useEffect(() => {
        const t = setInterval(fetchHealth, 60_000);
        return () => clearInterval(t);
    }, [fetchHealth]);

    const grade = data ? getOverallGrade(data.overall_score) : null;

    return (
        <>
            <Header title="Knowledge Health Score" />
            <main style={{ padding: '28px', flex: 1 }}>

                {/* ── Page header ── */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28, flexWrap: 'wrap', gap: 12 }}>
                    <div>
                        <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>
                            Knowledge Health Score
                        </h1>
                        <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
                            Real-time AI pipeline health — measures FAQ coverage, retrieval accuracy, and latency.
                            {lastRefresh && (
                                <span style={{ marginLeft: 8 }}>
                                    Updated {lastRefresh.toLocaleTimeString()}
                                </span>
                            )}
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        {/* Day selector */}
                        <select
                            id="health-period-select"
                            value={days}
                            onChange={e => setDays(Number(e.target.value))}
                            className="form-control"
                            style={{ width: 140, fontSize: 13 }}
                        >
                            <option value={1}>Last 24 hours</option>
                            <option value={7}>Last 7 days</option>
                            <option value={14}>Last 14 days</option>
                            <option value={30}>Last 30 days</option>
                        </select>
                        <button
                            id="health-refresh-btn"
                            onClick={fetchHealth}
                            className="btn btn-primary"
                            disabled={loading}
                            style={{ gap: 6 }}
                        >
                            {loading ? '⟳ Loading…' : '↺ Refresh'}
                        </button>
                    </div>
                </div>

                {/* ── Error state ── */}
                {error && (
                    <div style={{
                        background: '#fee2e2', border: '1px solid #fca5a5',
                        borderRadius: 12, padding: '16px 20px', marginBottom: 24,
                        color: '#dc2626', fontSize: 13,
                    }}>
                        ⚠️ {error} — Check that the AI Engine is running at <code>{AI_ENGINE_URL}</code>
                    </div>
                )}

                {/* ── Hero score card ── */}
                {data && grade && (
                    <div style={{
                        background: `linear-gradient(135deg, ${grade.color}18, ${grade.color}08)`,
                        border: `1px solid ${grade.color}40`,
                        borderRadius: 16, padding: '28px 32px',
                        display: 'flex', alignItems: 'center', gap: 32,
                        marginBottom: 28, flexWrap: 'wrap',
                    }}>
                        {/* Big grade circle */}
                        <div style={{
                            width: 110, height: 110, borderRadius: '50%',
                            background: `linear-gradient(135deg, ${grade.color}, ${grade.color}bb)`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            flexDirection: 'column', boxShadow: `0 8px 24px ${grade.color}44`,
                            flexShrink: 0,
                        }}>
                            <span style={{ fontSize: 36, fontWeight: 900, color: '#fff', lineHeight: 1 }}>{grade.grade}</span>
                        </div>

                        <div style={{ flex: 1, minWidth: 200 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: grade.color, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 4 }}>
                                Overall Health — {grade.label}
                            </div>
                            <div style={{ fontSize: 48, fontWeight: 900, color: 'var(--text)', lineHeight: 1 }}>
                                {data.overall_score}<span style={{ fontSize: 20, color: 'var(--text-3)' }}>/100</span>
                            </div>
                            <div style={{ marginTop: 14, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                                <Stat label="Total Queries" value={data.totals.total_queries_in_period} />
                                <Stat label="Total FAQs" value={data.totals.total_faqs} />
                                <Stat label="Chunks Stored" value={data.totals.total_chunks} />
                                <Stat label="Flagged (Pending)" value={data.totals.flagged_pending} alert={data.totals.flagged_pending > 10} />
                            </div>
                        </div>

                        {/* Queue progress */}
                        {data.totals.queue_total > 0 && (
                            <div style={{ minWidth: 160 }}>
                                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8 }}>
                                    FAQ Generation Queue
                                </div>
                                <div style={{ position: 'relative', height: 8, background: '#e2e8f0', borderRadius: 4, marginBottom: 6 }}>
                                    <div style={{
                                        position: 'absolute', left: 0, top: 0, bottom: 0,
                                        width: `${data.totals.queue_progress_pct}%`,
                                        background: 'linear-gradient(90deg, #22c55e, #16a34a)',
                                        borderRadius: 4,
                                        transition: 'width 0.8s ease',
                                    }} />
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                                    {data.totals.queue_total - data.totals.queue_pending}/{data.totals.queue_total} chunks processed
                                    ({data.totals.queue_progress_pct}%)
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* ── Metric cards grid ── */}
                {data && (
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                        gap: 16,
                        marginBottom: 28,
                    }}>
                        {Object.entries(METRIC_CONFIG).map(([key, cfg]) => {
                            const metric = data.metrics[key];
                            if (!metric) return null;
                            const scorePct = (metric.score / 20) * 100;
                            const hitting = cfg.higher
                                ? metric.value >= cfg.target
                                : metric.value <= cfg.target;
                            const valueColor = hitting ? '#16a34a' : metric.score >= 10 ? '#d97706' : '#dc2626';

                            return (
                                <div key={key} className="card" style={{ padding: 20 }}>
                                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
                                        <div>
                                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
                                                {cfg.icon} {cfg.label}
                                            </div>
                                            <div style={{ fontSize: 28, fontWeight: 900, color: valueColor, lineHeight: 1 }}>
                                                {cfg.unit === 'ms'
                                                    ? metric.value >= 1000 ? `${(metric.value / 1000).toFixed(1)}s` : `${metric.value}ms`
                                                    : `${metric.value}%`
                                                }
                                            </div>
                                        </div>
                                        <div style={{ position: 'relative', width: 56, height: 56 }}>
                                            <CircleGauge score={metric.score} max={20} size={56} strokeWidth={5} />
                                            <div style={{
                                                position: 'absolute', inset: 0,
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                fontSize: 11, fontWeight: 700, color: getScoreColor(metric.score, 20),
                                            }}>
                                                {metric.score}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Progress bar */}
                                    <div style={{ height: 5, background: '#e2e8f0', borderRadius: 3, marginBottom: 8 }}>
                                        <div style={{
                                            height: '100%',
                                            width: `${Math.min(scorePct, 100)}%`,
                                            background: getScoreColor(metric.score, 20),
                                            borderRadius: 3,
                                            transition: 'width 0.8s ease',
                                        }} />
                                    </div>

                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-3)' }}>
                                        <span>{cfg.desc}</span>
                                        <span style={{ fontWeight: 600 }}>
                                            target: {cfg.higher ? '>' : '<'}{cfg.target}{cfg.unit}
                                        </span>
                                    </div>

                                    {/* Status badge */}
                                    <div style={{ marginTop: 10 }}>
                                        <span style={{
                                            display: 'inline-block',
                                            padding: '2px 10px', borderRadius: 999, fontSize: 10, fontWeight: 700,
                                            background: hitting ? '#dcfce7' : metric.score >= 10 ? '#fef3c7' : '#fee2e2',
                                            color: hitting ? '#16a34a' : metric.score >= 10 ? '#d97706' : '#dc2626',
                                        }}>
                                            {hitting ? '✓ ON TARGET' : metric.score >= 10 ? '△ IMPROVING' : '✗ NEEDS ATTENTION'}
                                        </span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* ── Bottom grid: trend + tier split ── */}
                {data && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 28 }}>
                        {/* Daily trend */}
                        <div className="card" style={{ padding: 20 }}>
                            <div style={{ marginBottom: 16 }}>
                                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>Daily Query Volume</div>
                                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Bot responses per day (last {days}d)</div>
                            </div>
                            <TrendBar trend={data.trend} />
                        </div>

                        {/* Request tier split */}
                        <div className="card" style={{ padding: 20 }}>
                            <div style={{ marginBottom: 16 }}>
                                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>Request Tier Distribution</div>
                                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                                    LLM should handle &lt;30% of all requests
                                </div>
                            </div>
                            <TierDonut
                                faq={data.totals.faq_hits}
                                rag={data.totals.rag_hits}
                                llm={data.totals.llm_hits}
                                total={data.totals.total_queries_in_period}
                            />
                        </div>
                    </div>
                )}

                {/* ── Score breakdown table ── */}
                {data && (
                    <div className="card" style={{ marginBottom: 28 }}>
                        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
                            <h3 style={{ fontWeight: 700, fontSize: 14 }}>Score Breakdown</h3>
                            <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                                Each metric contributes up to 20 points toward the overall health score.
                            </p>
                        </div>
                        <div style={{ overflowX: 'auto' }}>
                            <table className="tbl">
                                <thead>
                                    <tr>
                                        <th>Metric</th>
                                        <th>Current Value</th>
                                        <th>Target</th>
                                        <th>Points (/ 20)</th>
                                        <th>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {Object.entries(METRIC_CONFIG).map(([key, cfg]) => {
                                        const metric = data.metrics[key];
                                        if (!metric) return null;
                                        const hitting = cfg.higher ? metric.value >= cfg.target : metric.value <= cfg.target;
                                        return (
                                            <tr key={key}>
                                                <td style={{ fontWeight: 600, fontSize: 13 }}>{cfg.icon} {cfg.label}</td>
                                                <td style={{ fontWeight: 700, color: hitting ? '#16a34a' : '#dc2626' }}>
                                                    {metric.value}{cfg.unit}
                                                </td>
                                                <td style={{ color: 'var(--text-2)' }}>
                                                    {cfg.higher ? '>' : '<'}{cfg.target}{cfg.unit}
                                                </td>
                                                <td>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                        <div style={{ flex: 1, height: 6, background: '#e2e8f0', borderRadius: 3 }}>
                                                            <div style={{
                                                                height: '100%', width: `${(metric.score / 20) * 100}%`,
                                                                background: getScoreColor(metric.score, 20),
                                                                borderRadius: 3, transition: 'width 0.8s ease',
                                                            }} />
                                                        </div>
                                                        <span style={{ fontWeight: 700, minWidth: 30, color: getScoreColor(metric.score, 20) }}>
                                                            {metric.score}
                                                        </span>
                                                    </div>
                                                </td>
                                                <td style={{ textAlign: 'center' }}>
                                                    <span style={{
                                                        padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                                                        background: hitting ? '#dcfce7' : '#fee2e2',
                                                        color: hitting ? '#16a34a' : '#dc2626',
                                                    }}>
                                                        {hitting ? '✓ OK' : '✗ MISS'}
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                    {/* Total row */}
                                    <tr style={{ background: '#f8fafc' }}>
                                        <td colSpan={3} style={{ fontWeight: 800, fontSize: 14 }}>Overall Score</td>
                                        <td colSpan={2}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                                <div style={{ flex: 1, height: 8, background: '#e2e8f0', borderRadius: 4 }}>
                                                    <div style={{
                                                        height: '100%', width: `${data.overall_score}%`,
                                                        background: getScoreColor(data.overall_score, 100),
                                                        borderRadius: 4, transition: 'width 0.8s ease',
                                                    }} />
                                                </div>
                                                <span style={{ fontWeight: 900, fontSize: 18, color: getScoreColor(data.overall_score, 100), minWidth: 60 }}>
                                                    {data.overall_score}/100
                                                </span>
                                                <span style={{
                                                    padding: '3px 12px', borderRadius: 999, fontSize: 12, fontWeight: 700,
                                                    background: grade?.color + '22', color: grade?.color,
                                                }}>
                                                    {grade?.grade} — {grade?.label}
                                                </span>
                                            </div>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* ── Loading skeleton ── */}
                {loading && !data && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
                        {[...Array(5)].map((_, i) => (
                            <div key={i} className="card" style={{ padding: 20, height: 140 }}>
                                <div style={{ background: '#f0f4f8', borderRadius: 8, height: '100%', animation: 'pulse 1.5s ease infinite' }} />
                            </div>
                        ))}
                    </div>
                )}

            </main>

            <style>{`
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }
            `}</style>
        </>
    );
}

// Tiny helper component
function Stat({ label, value, alert }) {
    return (
        <div>
            <div style={{ fontSize: 10, color: 'rgba(0,0,0,0.45)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: alert ? '#dc2626' : 'var(--text)' }}>{value ?? '—'}</div>
        </div>
    );
}
