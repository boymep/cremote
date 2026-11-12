// Видимая область для оболочки сессии: высота и сдвиг visualViewport в CSS-переменных.
// --vvh — высота видимой области (без клавиатуры), --vvt — на сколько iOS сдвинул видимую область вниз
// при фокусе поля (offsetTop). Класс kb-open и --kb-safe-bottom: 0px, пока открыта клавиатура:
// поле ввода сидит прямо над ней, без отступа под полоску «домой».

const KB_THRESHOLD = 120;

export function startViewportTracking(): void {
  const root = document.documentElement;
  const vv = window.visualViewport;
  if (!vv) return;
  let maxH = vv.height;
  let lastW = vv.width;
  let raf = 0;

  const apply = () => {
    raf = 0;
    // Поворот экрана: сбрасываем максимум, иначе клавиатура «откроется» в альбомной ориентации.
    if (Math.abs(vv.width - lastW) > 1) {
      lastW = vv.width;
      maxH = vv.height;
    }
    maxH = Math.max(maxH, vv.height);
    const kbOpen = window.innerHeight - vv.height > KB_THRESHOLD || maxH - vv.height > KB_THRESHOLD;
    root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    root.style.setProperty('--vvt', `${Math.max(0, Math.round(vv.offsetTop))}px`);
    root.classList.toggle('kb-open', kbOpen);
    if (kbOpen) root.style.setProperty('--kb-safe-bottom', '0px');
    else root.style.removeProperty('--kb-safe-bottom');
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(apply);
  };
  apply();
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);
}
