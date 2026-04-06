export default function StatusBadge({ status }) {
    const map = {
        creation: { label: 'Creation', cls: 'badge-creation' },
        in_progress: { label: 'In Progress', cls: 'badge-progress' },
        completed: { label: 'Completed', cls: 'badge-completed' },
        pending: { label: 'Pending', cls: 'badge-pending' },
    };
    const { label, cls } = map[status] || map.pending;
    return <span className={`badge ${cls}`}>{label}</span>;
}
