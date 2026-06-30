import { XMLParser } from 'fast-xml-parser';
import { load } from 'cheerio';

export interface ParsedRssItem {
  title: string;
  creator: string;
  descriptionHtml: string;
  descriptionText: string;
  pubDate: string;
  guid: string;
  link: string;
}

export interface ParsedRssChannel {
  title: string;
  link: string;
  description: string;
  language: string;
  ttl: number | null;
  selfLink: string;
}

export interface ParsedRssFeed {
  channel: ParsedRssChannel;
  items: ParsedRssItem[];
}

type ParsedGuid = string | { '#text'?: string };

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  return '';
}

function stripHtml(html: string): string {
  const $ = load(html);
  return $.text().replace(/\s+/g, ' ').trim();
}

function getGuid(guid: ParsedGuid): string {
  if (typeof guid === 'string') return guid;
  return guid?.['#text'] ?? '';
}

export function parseRssFeed(xmlText: string): ParsedRssFeed {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
    trimValues: true,
    attributeNamePrefix: '',
  });

  const parsed = parser.parse(xmlText) as {
    rss?: {
      channel?: {
        title?: string;
        link?: string;
        description?: string;
        language?: string;
        ttl?: number;
        'atom:link'?: { href?: string } | Array<{ href?: string }>;
        item?: Array<{
          title?: string;
          'dc:creator'?: string;
          description?: string;
          pubDate?: string;
          guid?: ParsedGuid;
          link?: string;
        }>;
      };
    };
  };

  const channel = parsed.rss?.channel;
  if (!channel) {
    throw new Error('Invalid RSS payload: missing channel');
  }

  const atomLinks = asArray(channel['atom:link']);
  const selfLink = atomLinks[0]?.href ?? '';

  const items = asArray(channel.item).map((item) => {
    const descriptionHtml = getString(item.description);
    return {
      title: getString(item.title),
      creator: getString(item['dc:creator']),
      descriptionHtml,
      descriptionText: stripHtml(descriptionHtml),
      pubDate: getString(item.pubDate),
      guid: getGuid(item.guid ?? ''),
      link: getString(item.link),
    };
  });

  return {
    channel: {
      title: getString(channel.title),
      link: getString(channel.link),
      description: getString(channel.description),
      language: getString(channel.language),
      ttl: typeof channel.ttl === 'number' ? channel.ttl : null,
      selfLink,
    },
    items,
  };
}
