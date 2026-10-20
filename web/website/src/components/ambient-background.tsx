import { useEffect, useRef } from 'react';

export function AmbientBackground() {
  const backgroundRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const background = backgroundRef.current!;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let pointerX = 0;
    let pointerY = 0;
    let frame = 0;

    function update() {
      frame = 0;
      const scrollRange = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      background.style.setProperty('--pointer-x', `${motion.matches ? 0 : pointerX}px`);
      background.style.setProperty('--pointer-y', `${motion.matches ? 0 : pointerY}px`);
      background.style.setProperty('--scroll-y', `${motion.matches ? 0 : window.scrollY / scrollRange * 240}px`);
    }

    function scheduleUpdate() {
      if (!frame) frame = window.requestAnimationFrame(update);
    }

    function handlePointerMove(event: PointerEvent) {
      if (motion.matches || event.pointerType === 'touch') return;
      pointerX = (event.clientX / window.innerWidth - 0.5) * 100;
      pointerY = (event.clientY / window.innerHeight - 0.5) * 80;
      scheduleUpdate();
    }

    function resetPointer() {
      pointerX = 0;
      pointerY = 0;
      scheduleUpdate();
    }

    function handlePointerOut(event: PointerEvent) {
      if (!event.relatedTarget) resetPointer();
    }

    function handleScroll() {
      if (!motion.matches) scheduleUpdate();
    }

    update();
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointerout', handlePointerOut, { passive: true });
    window.addEventListener('blur', resetPointer);
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
    motion.addEventListener('change', scheduleUpdate);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerout', handlePointerOut);
      window.removeEventListener('blur', resetPointer);
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', scheduleUpdate);
      motion.removeEventListener('change', scheduleUpdate);
    };
  }, []);

  return <div className="ambient-background" ref={backgroundRef} aria-hidden="true">
    <div className="ambient-shape"><span /></div>
    <div className="ambient-shape"><span /></div>
    <div className="ambient-shape"><span /></div>
  </div>;
}

