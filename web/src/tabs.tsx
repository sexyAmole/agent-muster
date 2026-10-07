import { useId, useRef } from 'react';
import type { ReactNode } from 'react';

type TabsProps<T extends string> = {
  value: T;
  onChange: (value: T) => void;
  items: { value: T; label: ReactNode }[];
  children: ReactNode;
  'aria-label': string;
};

export function Tabs<T extends string>({ value, onChange, items, children, 'aria-label': label }: TabsProps<T>) {
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);

  return <div className="tabs">
    <div ref={listRef} className="tabs-list" role="tablist" aria-label={label}>
      {items.map((item, index) => <button key={item.value} id={`${id}-tab-${item.value}`} type="button" className="tabs-trigger" role="tab" aria-selected={item.value === value} aria-controls={`${id}-panel-${item.value}`} tabIndex={item.value === value ? 0 : -1}
        onClick={() => onChange(item.value)}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
          onChange(items[next].value);
          listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next].focus();
        }}>{item.label}</button>)}
    </div>
    {items.map(item => <div key={item.value} id={`${id}-panel-${item.value}`} role="tabpanel" aria-labelledby={`${id}-tab-${item.value}`} hidden={item.value !== value} tabIndex={0}>
      {item.value === value && children}
    </div>)}
  </div>;
}
