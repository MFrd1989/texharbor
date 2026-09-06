type BrandLogoProps = {
  className?: string;
  compact?: boolean;
  inverse?: boolean;
};

export function HarborMark({ className = '', inverse = false }: { className?: string; inverse?: boolean }) {
  return <svg className={`harbor-mark ${className}`} viewBox="0 0 48 48" role="img" aria-label="TeXHarbor">
    <rect x="1" y="1" width="46" height="46" rx="14" className="harbor-mark-background" />
    <path d="M15 12.5v22M33 12.5v22M15 23h18" className="harbor-mark-letter" />
    <path d="M10.5 33.5c4.5-3.2 9-3.2 13.5 0s9 3.2 13.5 0" className="harbor-mark-wave" />
    {inverse && <rect x="1" y="1" width="46" height="46" rx="14" className="harbor-mark-outline" />}
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
