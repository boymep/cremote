// Тактильный отклик. В iOS нет navigator.vibrate, но с iOS 18 переключение
// <input type="checkbox" switch> даёт системный «тик». Нажимаем на скрытый label
// такого переключателя; элемент создаём один раз. Там, где vibrate есть (Android), — он.

let label: HTMLLabelElement | null = null;

function switchLabel(): HTMLLabelElement {
  if (label) return label;
  label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  // display: none: переключатель нельзя увидеть и сфокусировать, клавиатура не закрывается.
  label.style.display = 'none';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.tabIndex = -1;
  label.appendChild(input);
  document.body.appendChild(label);
  return label;
}

export function haptic(): void {
  try {
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(10);
      return;
    }
    switchLabel().click();
  } catch {
    /* отклик необязателен */
  }
}
