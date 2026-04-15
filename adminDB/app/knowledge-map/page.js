'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import Header from '../../components/Header';

// ── Design tokens ─────────────────────────────────────────────────────────────
const BG           = '#070b14';
const GRID_COLOR   = 'rgba(255,255,255,0.03)';
const PANEL_BG     = '#0d1424';

const NODE = {
    section: { color: '#3b82f6', glow: '#3b82f688', size: 18, ringColor: '#60a5fa' },
    intent:  { color: '#a855f7', glow: '#a855f788', size: 14, ringColor: '#c084fc' },
    faq:     { color: '#22c55e', glow: '#22c55e55', size:  7, ringColor: '#4ade80' },
};


// ── Force simulation ──────────────────────────────────────────────────────────
function createSimulation(nodes, edges, W, H) {
    nodes.forEach(n => {
        if (n.x === undefined) {
            const angle = Math.random() * 2 * Math.PI;
            const r = Math.random() * Math.min(W, H) * 0.3;
            n.x = W / 2 + Math.cos(angle) * r;
            n.y = H / 2 + Math.sin(angle) * r;
            n.vx = 0; n.vy = 0;
        }
    });
    const nodeMap = {};
    nodes.forEach(n => { nodeMap[n.id] = n; });

    function tick(alpha) {
        const k = alpha * 0.1;
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i], b = nodes[j];
                const dx = b.x - a.x || 0.01, dy = b.y - a.y || 0.01;
                const d2 = dx * dx + dy * dy;
                const d  = Math.sqrt(d2) || 0.01;
                const s  = 1400 * (a.size + b.size) / d2;
                const fx = (dx / d) * s * k, fy = (dy / d) * s * k;
                a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
            }
        }
        edges.forEach(e => {
            const a = nodeMap[e.source], b = nodeMap[e.target];
            if (!a || !b) return;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const td = 90 + (a.size + b.size) * 3;
            const f = (d - td) * 0.04 * (e.weight || 1) * alpha;
            const fx = (dx / d) * f, fy = (dy / d) * f;
            a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        });
        nodes.forEach(n => {
            n.vx += (W / 2 - n.x) * 0.008 * alpha;
            n.vy += (H / 2 - n.y) * 0.008 * alpha;
        });
        nodes.forEach(n => {
            if (n.pinned) return;
            n.vx *= 0.82; n.vy *= 0.82;
            n.x += n.vx; n.y += n.vy;
        });
    }
    return { tick, nodeMap };
}

// ── Grid background ───────────────────────────────────────────────────────────
function drawGrid(ctx, W, H, pan, zoom) {
    const step = 40 * zoom;
    const ox = pan.x % step;
    const oy = pan.y % step;
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;
    for (let x = ox; x < W; x += step) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = oy; y < H; y += step) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
}

// ── Canvas renderer ───────────────────────────────────────────────────────────
function draw(ctx, nodes, edges, nodeMap, hoveredId, selectedId, W, H, pulse, pan, zoom) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    drawGrid(ctx, W, H, pan, zoom);

    // Edges
    edges.forEach(e => {
        const a = nodeMap[e.source], b = nodeMap[e.target];
        if (!a || !b) return;
        const hi = a.id === hoveredId || b.id === hoveredId ||
                   a.id === selectedId || b.id === selectedId;
        const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        const ca = NODE[a.type]?.color || '#94a3b8';
        const cb = NODE[b.type]?.color || '#94a3b8';
        grad.addColorStop(0, hi ? ca + 'aa' : ca + '22');
        grad.addColorStop(1, hi ? cb + 'aa' : cb + '11');
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = grad;
        ctx.lineWidth = hi ? 1.2 : 0.6;
        ctx.stroke();
    });

    // Nodes: faq → intent → section (back to front)
    ['faq', 'intent', 'section'].forEach(type => {
        nodes.filter(n => n.type === type).forEach(n => {
            const cfg  = NODE[n.type] || NODE.faq;
            const isHov = n.id === hoveredId;
            const isSel = n.id === selectedId;
            const r = cfg.size + (isSel ? 5 : isHov ? 3 : 0);

            // Pulsating ring for hubs
            if (type !== 'faq') {
                const ringR = r + 6 + Math.sin(pulse * 0.05 + (n.id.charCodeAt(5) || 0)) * 3;
                ctx.beginPath();
                ctx.arc(n.x, n.y, ringR, 0, 2 * Math.PI);
                ctx.strokeStyle = cfg.ringColor + '33';
                ctx.lineWidth = 1;
                ctx.stroke();
            }

            // Glow
            if (isHov || isSel || type !== 'faq') {
                const glowR = r + (isSel ? 20 : isHov ? 14 : 10);
                const grad = ctx.createRadialGradient(n.x, n.y, r * 0.3, n.x, n.y, glowR);
                grad.addColorStop(0, cfg.glow);
                grad.addColorStop(1, cfg.color + '00');
                ctx.beginPath();
                ctx.arc(n.x, n.y, glowR, 0, 2 * Math.PI);
                ctx.fillStyle = grad;
                ctx.fill();
            }

            // Node body with gradient
            const bodyGrad = ctx.createRadialGradient(n.x - r * 0.3, n.y - r * 0.3, 0, n.x, n.y, r);
            bodyGrad.addColorStop(0, cfg.ringColor);
            bodyGrad.addColorStop(1, cfg.color);
            ctx.beginPath();
            ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = bodyGrad;
            ctx.fill();

            // Selection ring
            if (isSel) {
                ctx.beginPath();
                ctx.arc(n.x, n.y, r + 4, 0, 2 * Math.PI);
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([4, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Labels
            if (type !== 'faq' || isHov || isSel) {
                const label = n.label.length > 24 ? n.label.slice(0, 24) + '…' : n.label;
                ctx.font = type === 'section' ? '700 11px system-ui' : '10px system-ui';
                ctx.fillStyle = type !== 'faq' ? '#e2e8f0' : '#94a3b8';
                ctx.textAlign = 'center';
                ctx.shadowColor = BG;
                ctx.shadowBlur = 4;
                ctx.fillText(label, n.x, n.y + r + 13);
                ctx.shadowBlur = 0;
            }
        });
    });
}

function hitTest(nodes, mx, my) {
    let best = null, bestD = Infinity;
    nodes.forEach(n => {
        const d = Math.sqrt((n.x - mx) ** 2 + (n.y - my) ** 2);
        if (d < (n.size + 10) && d < bestD) { bestD = d; best = n; }
    });
    return best;
}

// ── Stat pill ─────────────────────────────────────────────────────────────────
function StatPill({ label, value, color, icon }) {
    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: color + '15', border: `1px solid ${color}30`,
            borderRadius: 8, padding: '6px 14px',
        }}>
            <span style={{ fontSize: 16 }}>{icon}</span>
            <div>
                <div style={{ fontSize: 18, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
                <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
            </div>
        </div>
    );
}

// ── Node type badge ────────────────────────────────────────────────────────────
function TypeBadge({ type }) {
    const cfg = {
        section: { bg: '#1d4ed8', label: 'Section Hub' },
        intent:  { bg: '#7e22ce', label: 'Intent Hub' },
        faq:     { bg: '#15803d', label: 'FAQ Entry'  },
    }[type] || { bg: '#374151', label: type };
    return (
        <span style={{
            display: 'inline-block', padding: '2px 10px', borderRadius: 5,
            background: cfg.bg, color: '#fff',
            fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px',
        }}>
            {cfg.label}
        </span>
    );
}

// ── Detail breakdown panel ─────────────────────────────────────────────────────
function DetailPanel({ node, allNodes, onClose }) {
    if (!node) return null;

    const faqsInSection = node.type === 'section'
        ? allNodes.filter(n => n.type === 'faq' && n.section === node.label)
        : [];

    const faqsForIntent = node.type === 'intent'
        ? allNodes.filter(n => n.type === 'faq')
        : [];

    return (
        <div style={{
            position: 'absolute', top: 0, right: 0, bottom: 0,
            width: 340,
            background: PANEL_BG,
            borderLeft: '1px solid rgba(255,255,255,0.07)',
            display: 'flex', flexDirection: 'column',
            boxShadow: '-8px 0 32px rgba(0,0,0,0.6)',
            zIndex: 10,
        }}>
            {/* Panel header */}
            <div style={{
                padding: '16px 18px',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                background: 'rgba(255,255,255,0.02)',
                flexShrink: 0,
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <TypeBadge type={node.type} />
                    <button onClick={onClose} style={{
                        background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                        color: '#94a3b8', cursor: 'pointer',
                        width: 26, height: 26, borderRadius: 6,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 14, fontWeight: 700,
                    }}>×</button>
                </div>
                <div style={{
                    marginTop: 10, fontSize: 15, fontWeight: 700,
                    color: '#e2e8f0', lineHeight: 1.4,
                }}>
                    {node.label}
                </div>

                {/* Node-type specific meta */}
                {node.type === 'section' && (
                    <div style={{ marginTop: 6, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11, color: '#3b82f6', background: '#3b82f615', padding: '2px 8px', borderRadius: 4 }}>
                            {faqsInSection.length} FAQ{faqsInSection.length !== 1 ? 's' : ''}
                        </span>
                    </div>
                )}
                {node.type === 'intent' && (
                    <div style={{ marginTop: 6, fontSize: 11, color: '#94a3b8' }}>
                        Intent classifier hub · {faqsForIntent.length} connected entries
                    </div>
                )}
                {node.type === 'faq' && node.section && (
                    <div style={{ marginTop: 6 }}>
                        <span style={{ fontSize: 11, color: '#3b82f6', background: '#3b82f615', padding: '2px 8px', borderRadius: 4 }}>
                            {node.section}
                        </span>
                    </div>
                )}
            </div>

            {/* Panel body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>

                {/* ── FAQ node: full answer ── */}
                {node.type === 'faq' && (
                    <div>
                        <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                            Answer
                        </div>
                        <div style={{
                            background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.18)',
                            borderRadius: 8, padding: '12px 14px',
                            fontSize: 13, color: '#cbd5e1', lineHeight: 1.65,
                            whiteSpace: 'pre-wrap',
                        }}>
                            {node.answer || 'No answer stored.'}
                        </div>
                        {node.doc_name && (
                            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontSize: 11, color: '#64748b' }}>Source:</span>
                                <span style={{ fontSize: 11, color: '#60a5fa', fontWeight: 600 }}>{node.doc_name}</span>
                            </div>
                        )}
                    </div>
                )}

                {/* ── Section node: FAQ list breakdown ── */}
                {node.type === 'section' && (
                    <div>
                        <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
                            Knowledge Entries ({faqsInSection.length})
                        </div>
                        {faqsInSection.length === 0 ? (
                            <div style={{ color: '#475569', fontSize: 13, textAlign: 'center', paddingTop: 20 }}>No FAQs in this section</div>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {faqsInSection.map((faq) => (
                                    <div key={faq.id} style={{
                                        background: 'rgba(255,255,255,0.03)',
                                        border: '1px solid rgba(255,255,255,0.07)',
                                        borderRadius: 8, padding: '10px 12px',
                                        borderLeft: '3px solid #22c55e',
                                    }}>
                                        <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', lineHeight: 1.4, marginBottom: 4 }}>
                                            {faq.label}
                                        </div>
                                        <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.4 }}>
                                            {(faq.answer || '').slice(0, 100)}{faq.answer?.length > 100 ? '…' : ''}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* ── Intent node: intent info ── */}
                {node.type === 'intent' && (
                    <div>
                        <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
                            Intent Classifier Hub
                        </div>
                        <div style={{
                            background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.18)',
                            borderRadius: 8, padding: '12px 14px', marginBottom: 12,
                        }}>
                            <div style={{ fontSize: 12, color: '#c084fc', fontWeight: 600, marginBottom: 6 }}>
                                Intent ID
                            </div>
                            <div style={{ fontSize: 12, color: '#94a3b8', fontFamily: 'monospace' }}>
                                {node.id}
                            </div>
                        </div>
                        <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                            Connected FAQ Entries
                        </div>
                        <div style={{ fontSize: 13, color: '#a855f7', fontWeight: 700 }}>
                            {faqsForIntent.length} total knowledge entries
                        </div>
                        <div style={{ marginTop: 8, fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>
                            This intent hub routes user queries about{' '}
                            <span style={{ color: '#c084fc' }}>{node.label.toLowerCase()}</span>{' '}
                            to the appropriate knowledge entries.
                        </div>
                    </div>
                )}
            </div>

            {/* Panel footer */}
            <div style={{
                padding: '10px 18px',
                borderTop: '1px solid rgba(255,255,255,0.06)',
                flexShrink: 0,
            }}>
                <div style={{ fontSize: 10, color: '#374151', textAlign: 'center' }}>
                    Click another node to explore · Drag to reposition
                </div>
            </div>
        </div>
    );
}

// ── Brain overview overlay (shows when nothing is selected) ───────────────────
function BrainOverlay({ stats }) {
    if (!stats) return null;
    return (
        <div style={{
            position: 'absolute', bottom: 20, left: 20,
            background: 'rgba(13,20,36,0.92)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 12, padding: '14px 18px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            minWidth: 220,
        }}>
            <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
                Knowledge Structure
            </div>
            {[
                { label: 'Section Hubs',  val: stats.sections,    color: '#3b82f6' },
                { label: 'Intent Hubs',   val: stats.intents,     color: '#a855f7' },
                { label: 'FAQ Entries',   val: stats.faqs,        color: '#22c55e' },
                { label: 'Neural Edges',  val: stats.total_edges, color: '#64748b' },
            ].map(s => (
                <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: '#94a3b8', flex: 1 }}>{s.label}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: s.color }}>{s.val}</span>
                </div>
            ))}
            <div style={{ marginTop: 10, fontSize: 10, color: '#374151', textAlign: 'center' }}>
                Click any node to explore
            </div>
        </div>
    );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function KnowledgeMapPage() {
    const canvasRef = useRef(null);
    const stateRef  = useRef({ nodes: [], edges: [], nodeMap: {}, sim: null, animId: null, alpha: 1, pulse: 0 });
    const [loading, setLoading]   = useState(true);
    const [error, setError]       = useState('');
    const [stats, setStats]       = useState(null);
    const [allNodes, setAllNodes] = useState([]);
    const [selected, setSelected] = useState(null);
    const [hovered, setHovered]   = useState(null);
    const [dragging, setDragging] = useState(null);
    const [zoom, setZoom]         = useState(1);
    const [pan, setPan]           = useState({ x: 0, y: 0 });
    const panStartRef             = useRef(null);
    const pulseRef                = useRef(0);

    // Load graph data
    useEffect(() => {
        setLoading(true);
        fetch('/api/knowledge-graph')
            .then(r => r.json())
            .then(data => {
                if (!data.success) throw new Error(data.error || 'Failed to load');
                setStats(data.stats);
                setAllNodes(data.nodes);
                const canvas = canvasRef.current;
                if (!canvas) return;
                const W = canvas.width, H = canvas.height;
                const s = stateRef.current;
                s.nodes = data.nodes;
                s.edges = data.edges;
                s.sim   = createSimulation(s.nodes, s.edges, W, H);
                s.nodeMap = s.sim.nodeMap;
                s.alpha = 1;
                setLoading(false);
            })
            .catch(e => { setError(e.message); setLoading(false); });
    }, []);

    // Canvas sizing
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const resize = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; };
        resize();
        window.addEventListener('resize', resize);
        return () => window.removeEventListener('resize', resize);
    }, []);

    // Animation loop
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const s = stateRef.current;

        const loop = () => {
            pulseRef.current += 1;
            if (s.nodes.length > 0) {
                if (s.alpha > 0.001) { s.sim?.tick(s.alpha); s.alpha *= 0.995; }
                ctx.save();
                ctx.translate(pan.x, pan.y);
                ctx.scale(zoom, zoom);
                draw(
                    ctx, s.nodes, s.edges, s.nodeMap,
                    hovered, selected?.id,
                    canvas.width / zoom, canvas.height / zoom,
                    pulseRef.current, { x: 0, y: 0 }, 1,
                );
                ctx.restore();
            }
            s.animId = requestAnimationFrame(loop);
        };
        s.animId = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(s.animId);
    }, [hovered, selected, zoom, pan]);

    const toCanvas = useCallback((e) => {
        const rect = canvasRef.current.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left - pan.x) / zoom,
            y: (e.clientY - rect.top  - pan.y) / zoom,
        };
    }, [zoom, pan]);

    const onMouseMove = useCallback((e) => {
        const { x, y } = toCanvas(e);
        const s = stateRef.current;
        if (dragging) {
            dragging.x = x; dragging.y = y;
            dragging.vx = 0; dragging.vy = 0;
            stateRef.current.alpha = Math.max(stateRef.current.alpha, 0.3);
            return;
        }
        if (panStartRef.current) {
            const dx = e.clientX - panStartRef.current.mx;
            const dy = e.clientY - panStartRef.current.my;
            setPan({ x: panStartRef.current.px + dx, y: panStartRef.current.py + dy });
            return;
        }
        const hit = hitTest(s.nodes, x, y);
        setHovered(hit ? hit.id : null);
        canvasRef.current.style.cursor = hit ? 'pointer' : 'grab';
    }, [dragging, toCanvas]);

    const onMouseDown = useCallback((e) => {
        const { x, y } = toCanvas(e);
        const hit = hitTest(stateRef.current.nodes, x, y);
        if (hit) { hit.pinned = true; setDragging(hit); }
        else {
            panStartRef.current = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y };
            canvasRef.current.style.cursor = 'grabbing';
        }
    }, [toCanvas, pan]);

    const onMouseUp = useCallback(() => {
        if (dragging) { dragging.pinned = false; setDragging(null); }
        panStartRef.current = null;
        if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
    }, [dragging]);

    const onClick = useCallback((e) => {
        const { x, y } = toCanvas(e);
        const hit = hitTest(stateRef.current.nodes, x, y);
        setSelected(hit || null);
    }, [toCanvas]);

    const onWheel = useCallback((e) => {
        e.preventDefault();
        setZoom(z => Math.max(0.25, Math.min(5, z * (e.deltaY < 0 ? 1.12 : 0.9))));
    }, []);

    const reheat = () => { stateRef.current.alpha = 1; };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: BG, overflow: 'hidden' }}>
            <Header />

            {/* ── Top bar ── */}
            <div style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 20px',
                background: 'rgba(255,255,255,0.03)',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                flexShrink: 0, flexWrap: 'wrap',
            }}>
                {/* Brain title */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 8 }}>
                    <div style={{
                        width: 32, height: 32, borderRadius: '50%',
                        background: 'linear-gradient(135deg, #3b82f6, #a855f7)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 16, boxShadow: '0 0 12px #3b82f655',
                    }}>🧠</div>
                    <div>
                        <div style={{ fontSize: 14, fontWeight: 800, color: '#e2e8f0', letterSpacing: '-0.2px' }}>
                            AI Knowledge Brain
                        </div>
                        <div style={{ fontSize: 10, color: '#475569' }}>Neural knowledge graph — trained memory</div>
                    </div>
                </div>

                {/* Stat pills */}
                {stats && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <StatPill icon="📚" label="FAQs"     value={stats.faqs}        color="#22c55e" />
                        <StatPill icon="🗂️"  label="Sections" value={stats.sections}    color="#3b82f6" />
                        <StatPill icon="🎯" label="Intents"  value={stats.intents}     color="#a855f7" />
                        <StatPill icon="🔗" label="Edges"    value={stats.total_edges} color="#64748b" />
                    </div>
                )}

                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                    <button onClick={() => setSelected(null)} style={{
                        padding: '5px 12px', borderRadius: 6,
                        background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
                        color: '#94a3b8', cursor: 'pointer', fontSize: 11, fontWeight: 600,
                    }}>
                        Reset View
                    </button>
                    <button onClick={reheat} style={{
                        padding: '5px 14px', borderRadius: 6,
                        background: 'linear-gradient(135deg, #1d4ed8, #7e22ce)',
                        border: 'none', color: '#fff', cursor: 'pointer',
                        fontSize: 11, fontWeight: 700, boxShadow: '0 0 10px #3b82f644',
                    }}>
                        ⚡ Reheat
                    </button>
                </div>
            </div>

            {/* ── Legend bar ── */}
            <div style={{
                display: 'flex', gap: 20, padding: '6px 20px',
                background: 'rgba(0,0,0,0.2)',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                flexShrink: 0, alignItems: 'center',
            }}>
                {[
                    { color: '#3b82f6', ring: '#60a5fa', label: 'Section Hub',  desc: 'knowledge topic' },
                    { color: '#a855f7', ring: '#c084fc', label: 'Intent Hub',   desc: 'classifier node' },
                    { color: '#22c55e', ring: '#4ade80', label: 'FAQ Entry',    desc: 'trained answer'  },
                ].map(l => (
                    <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <div style={{
                            width: 11, height: 11, borderRadius: '50%',
                            background: `radial-gradient(circle at 35% 35%, ${l.ring}, ${l.color})`,
                            boxShadow: `0 0 6px ${l.color}66`,
                        }} />
                        <div>
                            <span style={{ color: '#94a3b8', fontSize: 11, fontWeight: 600 }}>{l.label}</span>
                            <span style={{ color: '#374151', fontSize: 10, marginLeft: 4 }}>({l.desc})</span>
                        </div>
                    </div>
                ))}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, color: '#374151', fontSize: 10 }}>
                    <span>🖱 Scroll — zoom</span>
                    <span>✋ Drag — pan</span>
                    <span>👆 Click — breakdown</span>
                </div>
            </div>

            {/* ── Main canvas area ── */}
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                <canvas
                    ref={canvasRef}
                    style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }}
                    onMouseMove={onMouseMove}
                    onMouseDown={onMouseDown}
                    onMouseUp={onMouseUp}
                    onClick={onClick}
                    onWheel={onWheel}
                />

                {/* Loading */}
                {loading && (
                    <div style={{
                        position: 'absolute', inset: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexDirection: 'column', gap: 14, background: BG,
                    }}>
                        <div style={{
                            width: 48, height: 48, borderRadius: '50%',
                            border: '3px solid transparent',
                            borderTopColor: '#3b82f6', borderRightColor: '#a855f7',
                            animation: 'spin 0.9s linear infinite',
                        }} />
                        <div style={{ color: '#475569', fontSize: 13 }}>Loading knowledge graph…</div>
                    </div>
                )}

                {/* Empty state */}
                {!loading && !error && stats?.faqs === 0 && (
                    <div style={{
                        position: 'absolute', inset: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexDirection: 'column', gap: 10,
                    }}>
                        <div style={{ fontSize: 48, filter: 'grayscale(1) opacity(0.4)' }}>🧠</div>
                        <div style={{ color: '#475569', fontSize: 14, fontWeight: 600 }}>No knowledge stored yet</div>
                        <div style={{ color: '#374151', fontSize: 12 }}>Upload documents and approve FAQs in Bot Training first</div>
                    </div>
                )}

                {/* Error */}
                {error && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div style={{
                            background: '#1c0a0a', border: '1px solid #7f1d1d',
                            borderRadius: 10, padding: '16px 24px',
                            color: '#fca5a5', fontSize: 13,
                        }}>
                            ⚠ {error}
                        </div>
                    </div>
                )}

                {/* Brain structure overlay (when nothing selected) */}
                {!loading && !selected && stats && <BrainOverlay stats={stats} />}

                {/* Zoom indicator */}
                <div style={{
                    position: 'absolute', bottom: 20, right: selected ? 360 : 20,
                    background: 'rgba(13,20,36,0.85)', backdropFilter: 'blur(8px)',
                    border: '1px solid rgba(255,255,255,0.07)',
                    borderRadius: 8, padding: '6px 12px',
                    fontSize: 11, color: '#64748b', fontWeight: 600,
                    transition: 'right 0.25s ease',
                }}>
                    {Math.round(zoom * 100)}%
                </div>

                {/* Detail breakdown panel */}
                {selected && (
                    <DetailPanel
                        node={selected}
                        allNodes={allNodes}
                        onClose={() => setSelected(null)}
                    />
                )}
            </div>

            <style>{`
                @keyframes spin { to { transform: rotate(360deg); } }
            `}</style>
        </div>
    );
}
