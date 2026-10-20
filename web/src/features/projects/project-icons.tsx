export function ProjectFolderIcon({ open }: { open: boolean }) {
  return <svg className="project-folder" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-state={open ? 'open' : 'closed'}>
    <path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z" />
    {open && <path d="M2 10h20" />}
  </svg>;
}
