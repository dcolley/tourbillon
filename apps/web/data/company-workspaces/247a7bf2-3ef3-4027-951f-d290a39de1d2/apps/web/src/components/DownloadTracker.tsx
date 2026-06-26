'use client';

import { trackDocumentDownload } from '@/gtag';

interface DownloadLinkProps {
  href: string;
  name: string;
  type?: 'pdf' | 'doc' | 'zip' | 'other';
}

/**
 * Helper to extract file extension from URL
 */
function getExtension(href: string): string {
  return href.split('.').pop() || '';
}

/**
 * Download link component that tracks document_download events
 */
export function DownloadTracker({ href, name, type = 'pdf' }: DownloadLinkProps) {
  const extension = getExtension(href);
  
  const handleDownload = (e: React.MouseEvent<HTMLAnchorElement>) => {
    trackDocumentDownload({
      file_name: name,
      file_extension: extension,
      file_type: `application/${type}`,
    });
  };

  return (
    <a 
      href={href}
      onClick={handleDownload}
      className="text-blue-500 hover:underline block py-1"
    >
      {name}{extension ? `.${extension}` : ''}
    </a>
  );
}

/**
 * Download list component with tracking for all documents
 */
export function DownloadList() {
  const downloads = [
    { href: '/docs/quality-guide', name: 'Quality Guide (Web)', type: 'other' as const },
    { href: '/docs/api-reference', name: 'API Reference (Web)', type: 'other' as const },
  ];

  return (
    <ul className="space-y-2">
      {downloads.map((dl) => (
        <li key={dl.name}>
          <DownloadTracker 
            href={dl.href}
            name={dl.name}
            type={dl.type}
          />
        </li>
      ))}
    </ul>
  );
}
