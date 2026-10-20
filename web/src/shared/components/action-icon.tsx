export function ActionIcon({ type }: { type: 'add' | 'edit' | 'delete' }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {type === 'add' ? <path d="M12 5v14M5 12h14" /> : type === 'edit' ? <path d="m16 3 5 5M4 16 16 4a3.5 3.5 0 0 1 5 5L9 21H4v-5Z" /> : <><path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M5 6l1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7M14 10v7" /></>}
  </svg>;
}
