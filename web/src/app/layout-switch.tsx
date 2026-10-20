import { Select } from '../shared/components/select';

export type Layout = 'single' | 'double' | 'quad';
export function LayoutSwitch({ layout, onChange }: { layout: Layout; onChange: (layout: Layout) => void }) {
  return <div className="layout-switch">
    <Select aria-label="窗口布局" value={layout} onChange={value => onChange(value as Layout)} triggerLabel={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" />{layout !== 'single' && <path d="M12 3v18" />}{layout === 'quad' && <path d="M3 12h18" />}</svg>}>
      <option value="single">单窗</option>
      <option value="double">双栏</option>
      <option value="quad">四宫格</option>
    </Select>
  </div>;
}
