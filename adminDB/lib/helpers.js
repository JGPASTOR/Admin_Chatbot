export function deriveStatus(doc) {
    if (doc.document_completed_status) return 'completed';
    const routes = doc.details?.routes || [];
    if (routes.length <= 1) return 'creation';
    return 'in_progress';
}

export function currentOffice(doc) {
    const routes = doc.details?.routes || [];
    if (!routes.length) return doc.office || '—';
    return routes[routes.length - 1].office.replace(/^\d+\.\s*/, '');
}

export function currentAccountable(doc) {
    const routes = doc.details?.routes || [];
    if (!routes.length) return doc.created_by || '—';
    const emps = routes[routes.length - 1].staff_operation?.employee || [];
    return emps.length ? emps[emps.length - 1].received_by : (doc.created_by || '—');
}
