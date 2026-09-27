import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import './EditContextMenu.css';

export interface EditContextMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export interface EditContextMenuProps {
  position: { x: number; y: number };
  items: EditContextMenuItem[];
  onAction: (id: string) => void;
  onClose: () => void;
}

const VIEWPORT_MARGIN = 8;

export function EditContextMenu({ position, items, onAction, onClose }: EditContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const originalFocusRef = useRef<HTMLElement | null>(null);
  const capturedFocusRef = useRef(false);
  const closedRef = useRef(false);
  const onActionRef = useRef(onAction);
  const onCloseRef = useRef(onClose);
  const [offset, setOffset] = useState(position);

  onActionRef.current = onAction;
  onCloseRef.current = onClose;

  const close = (restoreFocus: boolean) => {
    if (closedRef.current) return;
    closedRef.current = true;
    if (restoreFocus && originalFocusRef.current?.isConnected) originalFocusRef.current.focus();
    onCloseRef.current();
  };

  const clampToViewport = () => {
    const menu = menuRef.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
    setOffset({
      x: Math.min(Math.max(position.x, VIEWPORT_MARGIN), maxX),
      y: Math.min(Math.max(position.y, VIEWPORT_MARGIN), maxY),
    });
  };

  useLayoutEffect(() => {
    if (!capturedFocusRef.current) {
      originalFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      capturedFocusRef.current = true;
    }
    setOffset(position);
    clampToViewport();
    const firstEnabled = items.findIndex((item) => !item.disabled);
    if (firstEnabled >= 0) itemRefs.current[firstEnabled]?.focus();
    else menuRef.current?.focus();
  }, [position.x, position.y]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const observer = new ResizeObserver(clampToViewport);
    observer.observe(menu);
    window.addEventListener('resize', clampToViewport);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', clampToViewport);
    };
  }, [position.x, position.y]);

  useLayoutEffect(() => {
    const handleOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) close(false);
    };
    const handleWindowBlur = () => close(false);
    document.addEventListener('pointerdown', handleOutsidePointer, true);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer, true);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, []);

  const enabledIndices = items.flatMap((item, index) => item.disabled ? [] : [index]);
  const moveFocus = (key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End') => {
    if (!enabledIndices.length) return;
    if (key === 'Home') { itemRefs.current[enabledIndices[0]]?.focus(); return; }
    if (key === 'End') { itemRefs.current[enabledIndices.at(-1)!]?.focus(); return; }
    const current = itemRefs.current.findIndex((button) => button === document.activeElement);
    const currentEnabled = enabledIndices.indexOf(current);
    const delta = key === 'ArrowDown' ? 1 : -1;
    const next = enabledIndices[(currentEnabled + delta + enabledIndices.length) % enabledIndices.length];
    itemRefs.current[next]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      moveFocus(event.key);
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  const handleAction = (item: EditContextMenuItem) => {
    if (item.disabled) return;
    try {
      onActionRef.current(item.id);
    } finally {
      close(true);
    }
  };

  return <div
    ref={menuRef}
    className="edit-context-menu"
    role="menu"
    tabIndex={-1}
    aria-label="时间轴编辑菜单"
    style={{ left: offset.x, top: offset.y }}
    onKeyDown={handleKeyDown}
    onMouseDown={(event: MouseEvent<HTMLDivElement>) => { if (event.button === 2) event.preventDefault(); }}
    onContextMenu={(event) => event.preventDefault()}
  >
    {items.map((item, index) => <div className="edit-context-menu-entry" key={item.id}>
      {item.separatorBefore && <div className="edit-context-menu-separator" role="separator" />}
      <button
        ref={(element) => { itemRefs.current[index] = element; }}
        type="button"
        role="menuitem"
        tabIndex={-1}
        disabled={item.disabled}
        onClick={() => handleAction(item)}
      >{item.label}</button>
    </div>)}
  </div>;
}
