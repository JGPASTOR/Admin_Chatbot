'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import Header from '../../components/Header';

const NODE_COLORS = {
    section: '#3b82f6',   // blue  — section hubs
    intent:  '#a855f7',   // purple — intent hubs
    faq:     '#22c55e',   // green  — FAQ entries
};

const NODE_SIZES = {
    section: 16,
    intent:  13,
    faq:     7,
};

const LINK_COLOR       = 'rgba(255,255,255,0.12)';
const LINK_COLOR_HOVER = 'rgba(255,255,255,0.45)';
const BG               = '#0d1117';

// ── Force simulation (pure JS, no D3) ────────────────────────────────────────
function createSimulation(nodes, edges, width, height) {
    // Initialize positions randomly around center
    nodes.forEach(n => {
        if (n.x === undefined) {
            const angle = Math.random() * 2 * Math.PI;
            const r = Math.random() * Math.min(width, height) * 0.3;
            n.x = width / 2 + Math.cos(angle) * r;
            n.y = height / 2 + Math.sin(angle) * r;
            n.vx = 0;
            n.vy = 0;
        }
    });

    const nodeMap = {};
    nodes.forEach(n => { nodeMap[n.id] = n; });

    function tick(alpha) {
        const k = alpha * 0.1;

        // Repulsion between all node pairs (O(n²), fine for < 400 nodes)
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i];
                const b = nodes[j];
                const dx = b.x - a.x || 0.01;
                const dy = b.y - a.y || 0.01;
                const dist2 = dx * dx + dy * dy;
                const dist  = Math.sqrt(dist2) || 0.01;
                // Stronger repulsion for hub nodes
                const strength = 1200 * (a.size + b.size) / dist2;
                const fx = (dx / dist) * strength * k;
                const fy = (dy / dist) * strength * k;
                a.vx -= fx; a.vy -= fy;
                b.vx += fx; b.vy += fy;
            }
        }

        // Attraction along edges
        edges.forEach(e => {
            const a = nodeMap[e.source];
            const b = nodeMap[e.target];
            if (!a || !b) return;
            const dx   = b.x - a.x;
            const dy   = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const target_dist = 80 + (a.size + b.size) * 3;
            const force = (dist - target_dist) * 0.04 * (e.weight || 1) * alpha;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx += fx; a.vy += fy;
            b.vx -= fx; b.vy -= fy;
        });

        // Center gravity
        nodes.forEach(n => {
            n.vx += (width  / 2 - n.x) * 0.01 * alpha;
            n.vy += (height / 2 - n.y) * 0.01 * alpha;
        });

        // Integrate + damping
        nodes.forEach(n => {
            if (n.pinned) return;
            n.vx *= 0.82;
            n.vy *= 0.82;
            n.x  += n.vx;
            n.y  += n.vy;
        });
    }

    return { tick, nodeMap };
}

// ── Canvas renderer ───────────────────────────────────────────────────────────
function draw(ctx, nodes, edges, nodeMap, hoveredId, selectedId, width, height) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);

    // Draw edges
    edges.forEach(e => {
        const a = nodeMap[e.source];
        const b = nodeMap[e.target];
        if (!a || !b) return;
        const isHighlighted = a.id === hoveredId || b.id === hoveredId ||
                              a.id === selectedId || b.id === selectedId;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = isHighlighted ? LINK_COLOR_HOVER : LINK_COLOR;
        ctx.lineWidth   = isHighlighted ? 1.5 : 0.8;
        ctx.stroke();
    });

    // Draw nodes (back to front: faq → intent → section)
    ['faq', 'intent', 'section'].forEach(type => {
        nodes.filter(n => n.type === type).forEach(n => {
            const isHov  = n.id === hoveredId;
            const isSel  = n.id === selectedId;
            const r      = (n.size || 7) + (isSel ? 4 : isHov ? 2 : 0);
            const color  = NODE_COLORS[n.type] || '#94a3b8';

            // Glow for hovered/selected
            if (isHov || isSel) {
                ctx.beginPath();
                ctx.arc(n.x, n.y, r + 8, 0, 2 * Math.PI);
                const grad = ctx.createRadialGradient(n.x, n.y, r, n.x, n.y, r + 10);
                grad.addColorStop(0, color + '55');
                grad.addColorStop(1, color + '00');
                ctx.fillStyle = grad;
                ctx.fill();
            }

            // Node circle
            ctx.beginPath();
            ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();

            // Dim ring for selected
            if (isSel) {
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
            }

            // Label for hubs or hovered
            if (n.type !== 'faq' || isHov || isSel) {
                const label = n.label.length > 22 ? n.label.slice(0, 22) + '…' : n.label;
                ctx.font      = n.type === 'faq' ? '10px sans-serif' : '11px sans-serif';
                ctx.fillStyle = '#e2e8f0';
                ctx.textAlign = 'center';
                ctx.fillText(label, n.x, n.y + r + 12);
            }
        });
    });
}

// ── Hit-test ──────────────────────────────────────────────────────────────────
function hitTest(nodes, mx, my) {
    let closest = null;
    let minDist = Infinity;
    nodes.forEach(n => {
        const dx   = n.x - mx;
        const dy   = n.y - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < (n.size + 8) && dist < minDist) {
            minDist = dist;
            closest = n;
        }
    });
    return closest;
}

// ── Page component ────────────────────────────────────────────────────────────
export default function KnowledgeMapPage() {
    const canvasRef   = useRef(null);
    const stateRef    = useRef({ nodes: [], edges: [], nodeMap: {}, sim: null, animId: null, alpha: 1 });
    const [loading, setLoading]     = useState(true);
    const [error, setError]         = useState('');
    const [stats, setStats]         = useState(null);
    const [selected, setSelected]   = useState(null);   // selected node data
    const [hovered, setHovered]     = useState(null);   // hovered node id
    const [dragging, setDragging]   = useState(null);   // node being dragged
    const [zoom, setZoom]           = useState(1);
    const [pan, setPan]             = useState({ x: 0, y: 0 });
    const panStartRef               = useRef(null);

    // Load data
    useEffect(() => {
        setLoading(true);
        fetch('/api/knowledge-graph')
            .then(r => r.json())
            .then(data => {
                if (!data.success) throw new Error(data.error || 'Failed to load');
                setStats(data.stats);
                const canvas = canvasRef.current;
                if (!canvas) return;
                const W = canvas.width;
                const H = canvas.height;
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

    // Canvas size
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const resize = () => {
            canvas.width  = canvas.offsetWidth;
            canvas.height = canvas.offsetHeight;
        };
        resize();
        window.addEventListener('resize', resize);
        return () => window.removeEventListener('resize', resize);
    }, []);

    // Animation loop
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const s   = stateRef.current;

        const loop = () => {
            if (s.nodes.length > 0) {
                if (s.alpha > 0.001) {
                    s.sim?.tick(s.alpha);
                    s.alpha *= 0.995;
                }
                ctx.save();
                ctx.translate(pan.x, pan.y);
                ctx.scale(zoom, zoom);
                draw(ctx, s.nodes, s.edges, s.nodeMap, hovered, selected?.id, canvas.width / zoom, canvas.height / zoom);
                ctx.restore();
            }
            s.animId = requestAnimationFrame(loop);
        };
        s.animId = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(s.animId);
    }, [hovered, selected, zoom, pan]);

    // Convert mouse → canvas coords (accounting for zoom/pan)
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
            dragging.x = x;
            dragging.y = y;
            dragging.vx = 0;
            dragging.vy = 0;
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
        const s   = stateRef.current;
        const hit = hitTest(s.nodes, x, y);
        if (hit) {
            hit.pinned = true;
            setDragging(hit);
        } else {
            panStartRef.current = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y };
            canvasRef.current.style.cursor = 'grabbing';
        }
    }, [toCanvas, pan]);

    const onMouseUp = useCallback(() => {
        if (dragging) {
            dragging.pinned = false;
            setDragging(null);
        }
        panStartRef.current = null;
        canvasRef.current.style.cursor = 'grab';
    }, [dragging]);

    const onClick = useCallback((e) => {
        const { x, y } = toCanvas(e);
        const hit = hitTest(stateRef.current.nodes, x, y);
        setSelected(hit || null);
    }, [toCanvas]);

    const onWheel = useCallback((e) => {
        e.preventDefault();
        setZoom(z => Math.max(0.3, Math.min(4, z * (e.deltaY < 0 ? 1.1 : 0.9))));
    }, []);

    const reheat = () => { stateRef.current.alpha = 1; };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: BG }}>
            <Header />

            {/* Top bar */}
            <div style={{
                display: 'flex', alignItems: 'center', gap: 16,
                padding: '10px 20px', background: '#161b22',
                borderBottom: '1px solid #21262d', flexShrink: 0,
            }}>
                <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 15 }}>
                    AI Knowledge Brain
                </div>
                <div style={{ color: '#64748b', fontSize: 12 }}>
                    Force-directed map of trained knowledge
                </div>
                {stats && (
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 20 }}>
                        {[
                            { label: 'FAQs',     val: stats.faqs,     color: '#22c55e' },
                            { label: 'Sections', val: stats.sections, color: '#3b82f6' },
                            { label: 'Intents',  val: stats.intents,  color: '#a855f7' },
                            { label: 'Edges',    val: stats.total_edges, color: '#64748b' },
                        ].map(s => (
                            <div key={s.label} style={{ textAlign: 'center' }}>
                                <div style={{ color: s.color, fontWeight: 700, fontSize: 16 }}>{s.val}</div>
                                <div style={{ color: '#64748b', fontSize: 10 }}>{s.label}</div>
                            </div>
                        ))}
                    </div>
                )}
                <button onClick={reheat} style={{
                    padding: '5px 14px', borderRadius: 6, border: '1px solid #21262d',
                    background: '#21262d', color: '#e2e8f0', cursor: 'pointer', fontSize: 12,
                }}>
                    Reheat
                </button>
            </div>

            {/* Legend */}
            <div style={{
                display: 'flex', gap: 20, padding: '6px 20px',
                background: '#0d1117', borderBottom: '1px solid #161b22', flexShrink: 0,
            }}>
                {[
                    { color: '#3b82f6', label: 'Section Hub' },
                    { color: '#a855f7', label: 'Intent Hub' },
                    { color: '#22c55e', label: 'FAQ Entry' },
                ].map(l => (
                    <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 10, height: 10, borderRadius: '50%', background: l.color }} />
                        <span style={{ color: '#94a3b8', fontSize: 11 }}>{l.label}</span>
                    </div>
                ))}
                <div style={{ marginLeft: 'auto', color: '#475569', fontSize: 10 }}>
                    Scroll to zoom · Drag to pan · Click node for details
                </div>
            </div>

            {/* Main area */}
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
                {/* Canvas */}
                <canvas
                    ref={canvasRef}
                    style={{ flex: 1, display: 'block', cursor: 'grab' }}
                    onMouseMove={onMouseMove}
                    onMouseDown={onMouseDown}
                    onMouseUp={onMouseUp}
                    onClick={onClick}
                    onWheel={onWheel}
                />

                {/* Loading / empty */}
                {loading && (
                    <div style={{
                        position: 'absolute', inset: 0, display: 'flex',
                        alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12,
                    }}>
                        <div style={{
                            width: 40, height: 40, borderRadius: '50%',
                            border: '3px solid #22c55e', borderTopColor: 'transparent',
                            animation: 'spin 0.8s linear infinite',
                        }} />
                        <div style={{ color: '#64748b', fontSize: 13 }}>Loading knowledge graph…</div>
                    </div>
                )}
                {!loading && !error && stats?.faqs === 0 && (
                    <div style={{
                        position: 'absolute', inset: 0, display: 'flex',
                        alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8,
                    }}>
                        <div style={{ fontSize: 40 }}>🧠</div>
                        <div style={{ color: '#64748b', fontSize: 14 }}>No knowledge yet</div>
                        <div style={{ color: '#475569', fontSize: 12 }}>Upload documents and approve FAQs in Bot Training first</div>
                    </div>
                )}
                {error && (
                    <div style={{
                        position: 'absolute', inset: 0, display: 'flex',
                        alignItems: 'center', justifyContent: 'center',
                    }}>
                        <div style={{ color: '#ef4444', fontSize: 13 }}>Error: {error}</div>
                    </div>
                )}

                {/* Detail panel */}
                {selected && (
                    <div style={{
                        position: 'absolute', top: 12, right: 12, width: 300,
                        background: '#161b22', border: '1px solid #21262d',
                        borderRadius: 10, padding: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                            <span style={{
                                fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                                letterSpacing: '0.6px', padding: '2px 8px', borderRadius: 4,
                                background: selected.type === 'section' ? '#1d4ed8'
                                          : selected.type === 'intent'  ? '#7e22ce'
                                          : '#15803d',
                                color: '#fff',
                            }}>
                                {selected.type}
                            </span>
                            <button onClick={() => setSelected(null)} style={{
                                background: 'none', border: 'none', color: '#64748b',
                                cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0,
                            }}>×</button>
                        </div>

                        <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 13, marginBottom: 8, lineHeight: 1.4 }}>
                            {selected.label}
                        </div>

                        {selected.type === 'section' && (
                            <div style={{ color: '#64748b', fontSize: 12 }}>
                                {selected.faq_count} FAQ{selected.faq_count !== 1 ? 's' : ''} in this section
                            </div>
                        )}
                        {selected.type === 'intent' && (
                            <div style={{ color: '#64748b', fontSize: 12 }}>
                                {selected.sample_count} training samples
                            </div>
                        )}
                        {selected.type === 'faq' && (
                            <>
                                <div style={{
                                    color: '#94a3b8', fontSize: 11,
                                    background: '#0d1117', borderRadius: 6,
                                    padding: '8px 10px', lineHeight: 1.5,
                                }}>
                                    {selected.answer}
                                </div>
                                {selected.section && (
                                    <div style={{ color: '#3b82f6', fontSize: 10, marginTop: 8 }}>
                                        {selected.section}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>

            <style>{`
                @keyframes spin { to { transform: rotate(360deg); } }
            `}</style>
        </div>
    );
}
