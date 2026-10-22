import type { OptionHTMLAttributes, ReactNode } from 'react';
import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type SelectVariant = 'default' | 'ghost';

type SelectProps = {
  value: string;
  onChange: (value: string) => void;
  onOpen?: () => void;
  children: ReactNode;
  triggerLabel?: ReactNode;
  menuMinWidth?: number;
  fixedLastOption?: boolean;
  renderIcon?: (value: string) => ReactNode;
  title?: string;
  disabled?: boolean;
  variant?: SelectVariant;
  roundedFull?: boolean;
  'aria-label': string;
};

export function Select({ value, onChange, onOpen, children, triggerLabel, menuMinWidth = 160, fixedLastOption = false, renderIcon, title, disabled, variant = 'default', roundedFull = false, 'aria-label': label }: SelectProps) {
  const options = Children.toArray(children).filter(isValidElement<OptionHTMLAttributes<HTMLOptionElement>>).map(option => ({
    value: String(option.props.value),
    label: option.props.children,
    disabled: Boolean(option.props.disabled),
  }));
  const selectedIndex = options.findIndex(option => option.value === value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const expanded = open && !disabled;

  function showMenu() {
    onOpen?.();
    setActiveIndex(selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : options.findIndex(option => !option.disabled));
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  useLayoutEffect(() => {
    if (!expanded || !triggerRef.current || !menuRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, menuMinWidth), window.innerWidth - 16);
    const height = menuRef.current.offsetHeight;
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: rect.bottom + height + 6 <= window.innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - height - 6),
      width,
    });
  }, [expanded, position.width, options.length, menuMinWidth]);

  useEffect(() => {
    if (!expanded) return;
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    }
    function closeOnLayoutChange(event: Event) {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('resize', closeOnLayoutChange);
    window.addEventListener('scroll', closeOnLayoutChange, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('resize', closeOnLayoutChange);
      window.removeEventListener('scroll', closeOnLayoutChange, true);
    };
  }, [expanded]);

  useEffect(() => {
    if (fixedLastOption && activeIndex === options.length - 1) return;
    if (expanded) menuRef.current?.querySelector<HTMLElement>(`[id="${menuId}-${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, expanded, menuId, fixedLastOption, options.length]);

  const optionButtons = options.map((option, index) => <button key={option.value} id={`${menuId}-${index}`} type="button" role="option" tabIndex={-1} aria-selected={option.value === value} disabled={option.disabled} className={`select-option${activeIndex === index ? ' active' : ''}`} onPointerMove={() => !option.disabled && setActiveIndex(index)} onClick={() => choose(index)}>
    {renderIcon && <span className="select-icon">{renderIcon(option.value)}</span>}
    <span>{option.label}</span>
    {option.value === value && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>}
  </button>);

  const controlClass = `select-control${variant === 'ghost' ? ' select-ghost' : ''}${roundedFull ? ' select-rounded-full' : ''}`;
  return <span className={controlClass}>
    <button ref={triggerRef} type="button" className="select-input" title={title} disabled={disabled} role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={expanded} aria-controls={expanded ? menuId : undefined} aria-activedescendant={expanded && activeIndex >= 0 ? `${menuId}-${activeIndex}` : undefined}
      onClick={() => expanded ? setOpen(false) : showMenu()}
      onBlur={() => setOpen(false)}
      onKeyDown={event => {
        if (event.key === 'Escape' || event.key === 'Tab') { setOpen(false); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          if (!expanded) { showMenu(); return; }
          const enabled = options.flatMap((option, index) => option.disabled ? [] : [index]);
          const current = enabled.indexOf(activeIndex);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
          if (enabled.length) setActiveIndex(enabled[next]);
        } else if (expanded && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          choose(activeIndex);
        }
      }}>
      {renderIcon && <span className="select-icon">{renderIcon(value)}</span>}
      <span className="select-value">{triggerLabel ?? options[selectedIndex]?.label}</span>
      <svg className="select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {expanded && createPortal(<div ref={menuRef} id={menuId} className={`select-menu${fixedLastOption ? ' select-menu-fixed-footer' : ''}`} role="listbox" aria-label={label} style={position} onMouseDown={event => event.preventDefault()}>
      {fixedLastOption ? <>
        <div className="select-menu-options">{optionButtons.slice(0, -1)}</div>
        <div className="select-menu-footer">{optionButtons.slice(-1)}</div>
      </> : optionButtons}
    </div>, document.body)}
  </span>;
}
