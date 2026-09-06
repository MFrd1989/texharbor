type BrandLogoProps = {
  className?: string;
  compact?: boolean;
  inverse?: boolean;
};

export function HarborMark({ className = '', inverse = false }: { className?: string; inverse?: boolean }) {
  return <svg className={`harbor-mark ${className}`} viewBox="0 0 64 64" role="img" aria-label="TeXHarbor">
    <rect x="1" y="1" width="62" height="62" rx="18" className="harbor-mark-background" />
    <path d="M16 7v5M32 11v6M48 6v5" className="harbor-rain-trail" />
    <text x="11" y="25" className="harbor-letter">T</text>
    <text x="27" y="32" className="harbor-letter">e</text>
    <text x="43" y="24" className="harbor-letter">X</text>
    <path d="M7 43.5h13.5l7 7M57 43.5H43.5l-7 7" className="harbor-breakwater" />
    <path d="M9 55c4-2.7 8-2.7 12 0s8 2.7 12 0 8-2.7 12 0 8 2.7 12 0" className="harbor-mark-wave" />
    {inverse && <rect x="1" y="1" width="62" height="62" rx="18" className="harbor-mark-outline" />}
  </svg>;
}

export function BrandLogo({ className = '', compact = false, inverse = false }: BrandLogoProps) {
  return <span className={`brand-logo ${inverse ? 'inverse' : ''} ${className}`}>
    <HarborMark inverse={inverse} />
    {!compact && <span className="brand-wordmark"><strong>TeX</strong>Harbor</span>}
  </span>;
}

export function TexDocumentIcon() {
  return <svg className="project-file-icon" viewBox="0 0 48 56" aria-hidden="true">
    <path d="M8 2.5h22l10 10V53.5H8z" className="project-file-paper" />
    <path d="M30 2.5v11h10" className="project-file-fold" />
    <path d="M15 22h18M15 27h12" className="project-file-lines" />
    <text x="24" y="43" textAnchor="middle" className="project-file-label">TeX</text>
  </svg>;
}
