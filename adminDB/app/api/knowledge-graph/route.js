import { NextResponse } from 'next/server';
import pool from '../../../lib/db';

// Known intent categories (from AI Engine's intent classifier)
const INTENT_HUBS = [
    { id: 'intent::document_status', label: 'Document Tracking',  keywords: ['status','track','document','pdid','tracking'] },
    { id: 'intent::lgu_query',       label: 'LGU Services',       keywords: ['ordinance','service','office','government','city'] },
    { id: 'intent::help',            label: 'Help & Guidance',    keywords: ['help','assist','what can','how to use'] },
    { id: 'intent::complaint',       label: 'Complaints',         keywords: ['complaint','problem','issue','delay','concern'] },
    { id: 'intent::follow_up',       label: 'Follow-Up',          keywords: ['follow','update','check','again','still'] },
];

export async function GET() {
    try {
        // Read FAQ entries from Admin DB (the source of truth for approved FAQs)
        const [faqRows] = await pool.query(`
            SELECT fe.id, fe.question, fe.answer, fe.section,
                   COALESCE(fe.doc_name, gd.original_name) AS doc_name,
                   fe.created_at
            FROM faq_entries fe
            LEFT JOIN general_documents gd ON fe.doc_id = gd.id
            ORDER BY fe.section, fe.id
        `);

        const nodes = [];
        const edges = [];
        const nodeIds = new Set();

        // ── Section hub nodes ───────────────────────────────────────────────
        const sectionMap = {};
        for (const row of faqRows) {
            const sec = (row.section || 'General').trim();
            if (!sectionMap[sec]) sectionMap[sec] = [];
            sectionMap[sec].push(row);
        }

        for (const [sec, faqs] of Object.entries(sectionMap)) {
            const nid = `sec::${sec}`;
            nodes.push({ id: nid, label: sec, type: 'section', size: 16, color: '#3b82f6', faq_count: faqs.length });
            nodeIds.add(nid);
        }

        // ── Intent hub nodes ────────────────────────────────────────────────
        for (const intent of INTENT_HUBS) {
            nodes.push({ id: intent.id, label: intent.label, type: 'intent', size: 12, color: '#a855f7' });
            nodeIds.add(intent.id);
        }

        // ── FAQ nodes + edges ───────────────────────────────────────────────
        for (const row of faqRows) {
            const sec  = (row.section || 'General').trim();
            const nid  = `faq::${row.id}`;
            nodes.push({
                id:         nid,
                label:      (row.question || '').slice(0, 80),
                answer:     (row.answer   || '').slice(0, 300),
                section:    sec,
                doc_name:   row.doc_name || null,
                type:       'faq',
                size:       7,
                color:      '#22c55e',
            });
            nodeIds.add(nid);

            // Section → FAQ edge
            edges.push({ source: `sec::${sec}`, target: nid, weight: 1.5 });

            // Intent → FAQ edge (keyword heuristic)
            const qLower = (row.question || '').toLowerCase();
            for (const intent of INTENT_HUBS) {
                if (intent.keywords.some(kw => qLower.includes(kw))) {
                    edges.push({ source: intent.id, target: nid, weight: 0.5 });
                    break;
                }
            }
        }

        return NextResponse.json({
            success: true,
            nodes,
            edges,
            stats: {
                total_nodes:  nodes.length,
                total_edges:  edges.length,
                sections:     Object.keys(sectionMap).length,
                faqs:         faqRows.length,
                intents:      INTENT_HUBS.length,
            },
        });
    } catch (err) {
        console.error('[Knowledge Graph]', err);
        return NextResponse.json({ success: false, error: err.message, nodes: [], edges: [] }, { status: 500 });
    }
}
