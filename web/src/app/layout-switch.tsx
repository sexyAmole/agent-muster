import { Select } from '../shared/components/select';

export type Layout = 'single' | 'double' | 'quad';
export function LayoutSwitch({ layout, onChange, disabled }: { layout: Layout; onChange: (layout: Layout) => void; disabled?: boolean }) {
  return <div className="layout-switch">
    <Select aria-label="窗口布局" value={layout} disabled={disabled} onChange={value => onChange(value as Layout)} triggerLabel={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>}>
      <option value="single">单窗</option>
      <option value="double">双栏</option>
      <option value="quad">四宫格</option>
    </Select>
  </div>;
}
