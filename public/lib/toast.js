export function showToast(msg, type = 'info') {
  const existing = document.getElementById('study-toast');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.id = 'study-toast';
  el.textContent = msg;
  Object.assign(el.style, {
    position:     'fixed',
    bottom:       '1.5rem',
    left:         '50%',
    transform:    'translateX(-50%)',
    background:   type === 'error' ? 'oklch(0.25 0.10 15)' : 'var(--surface-2)',
    border:       `1px solid ${type === 'error' ? 'var(--red)' : 'var(--border-2)'}`,
    color:        type === 'error' ? 'var(--red)' : 'var(--t1)',
    padding:      '0.75rem 1.25rem',
    borderRadius: '0.75rem',
    fontSize:     '0.875rem',
    maxWidth:     '90vw',
    zIndex:       '9999',
    boxShadow:    '0 4px 24px rgba(0,0,0,0.3)',
    animation:    'fadeIn 0.25s ease',
  });

  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.4s';
    setTimeout(() => el.remove(), 400);
  }, 6000);
}
