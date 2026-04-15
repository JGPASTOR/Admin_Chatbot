import pool from '../../../../lib/db';
import { NextResponse } from 'next/server';

const AI_ENGINE = process.env.AI_ENGINE_URL || 'http://192.168.254.110:8000';

/* ── DELETE /api/locations/[id] ── */
export async function DELETE(request, { params }) {
    try {
        const { id } = await params;

        const [rows] = await pool.query('SELECT * FROM locations WHERE id = ?', [id]);
        if (rows.length === 0) {
            return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 });
        }

        const loc = rows[0];
        const filename = `location_${loc.id}_${loc.name.replace(/\s+/g, '_')}`;

        // Remove from RAG (non-fatal)
        try {
            await fetch(`${AI_ENGINE}/api/rag/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename }),
                signal: AbortSignal.timeout(5000),
            });
        } catch (e) {
            console.warn('[Locations RAG] Delete warning:', e.message);
        }

        await pool.query('DELETE FROM locations WHERE id = ?', [id]);
        return NextResponse.json({ success: true, message: 'Location deleted.' });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

/* ── PUT /api/locations/[id] ── */
export async function PUT(request, { params }) {
    try {
        const { id } = await params;
        const body = await request.json();
        const {
            name, category, description, address,
            latitude, longitude, contact, operating_hours, google_maps_url,
        } = body;

        if (!name?.trim()) {
            return NextResponse.json({ success: false, error: 'Name is required.' }, { status: 400 });
        }

        await pool.query(
            `UPDATE locations SET
               name=?, category=?, description=?, address=?,
               latitude=?, longitude=?, contact=?, operating_hours=?, google_maps_url=?
             WHERE id=?`,
            [
                name.trim(), category, description || null, address || null,
                latitude || null, longitude || null,
                contact || null, operating_hours || null, google_maps_url || null,
                id,
            ]
        );

        const [rows] = await pool.query('SELECT * FROM locations WHERE id = ?', [id]);
        if (rows.length === 0)
            return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 });

        const loc = rows[0];

        // Re-ingest updated location to RAG (fire-and-forget)
        const AI = process.env.AI_ENGINE_URL || 'http://192.168.254.110:8000';
        const filename = `location_${loc.id}_${loc.name.replace(/\s+/g, '_')}`;
        const lines = [];
        const catLabel = {
            restaurant: 'Restaurant', shop: 'Shop / Store', tourist_spot: 'Tourist Spot',
            hotel: 'Hotel / Accommodation', hospital: 'Hospital / Clinic',
            government: 'Government Office', school: 'School / University', other: 'Place of Interest',
        }[loc.category] ?? 'Place';
        lines.push(`${catLabel}: ${loc.name}`);
        if (loc.address) lines.push(`Address: ${loc.address}`);
        if (loc.description) lines.push(`About: ${loc.description}`);
        if (loc.contact) lines.push(`Contact: ${loc.contact}`);
        if (loc.operating_hours) lines.push(`Operating Hours: ${loc.operating_hours}`);
        if (loc.latitude && loc.longitude) lines.push(`Coordinates: ${loc.latitude}, ${loc.longitude}`);
        if (loc.google_maps_url) lines.push(`Map: ${loc.google_maps_url}`);

        fetch(`${AI}/api/rag/delete`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename }), signal: AbortSignal.timeout(5000),
        }).then(() =>
            fetch(`${AI}/api/rag/ingest`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename, text: lines.join('\n') }),
                signal: AbortSignal.timeout(15000),
            })
        ).catch(() => {});

        return NextResponse.json({ success: true, data: loc });
    } catch (err) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
