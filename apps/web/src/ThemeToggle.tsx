import { useState } from 'react';

type Theme = 'light' | 'dark';

export function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    try { localStorage.setItem('texharbor-theme', next); } catch { /* Theme still applies for this tab. */ }
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', next === 'dark' ? '#071820' : '#0b1f2a');
    setTheme(next);
  };
  return <button type="button" className={`theme-toggle ${className}`} onClick={toggle} aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}><span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span></button>;
}
