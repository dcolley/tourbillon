import { load } from 'cheerio';

export interface ParsedUserSearchResult {
  username: string;
  displayName: string;
  profileUrl: string;
  avatarUrl: string;
  bio: string;
}

export interface ParsedUserSearchPage {
  users: ParsedUserSearchResult[];
  nextCursor: string | null;
}

function toAbsoluteUrl(baseUrl: string, maybeRelativeUrl: string): string {
  if (!maybeRelativeUrl) return '';

  try {
    return new URL(maybeRelativeUrl, baseUrl).toString();
  } catch {
    return maybeRelativeUrl;
  }
}

function parseCursorFromHref(href: string): string | null {
  if (!href) return null;

  try {
    const maybeAbsolute = href.startsWith('http')
      ? href
      : `https://placeholder.local${href}`;
    const url = new URL(maybeAbsolute);
    return url.searchParams.get('cursor');
  } catch {
    return null;
  }
}

export function parseUsersSearchHtml(
  html: string,
  nitterBaseUrl: string,
): ParsedUserSearchPage {
  const $ = load(html);

  const users: ParsedUserSearchResult[] = $('.timeline-item')
    .map((_, element) => {
      const node = $(element);
      const dataUsername = (node.attr('data-username') ?? '').trim();
      const usernameText = (node.find('.username').first().text() ?? '')
        .trim()
        .replace(/^@/, '');

      const username = dataUsername || usernameText;
      const displayName = (node.find('.fullname').first().text() ?? '').trim();
      const profileHref =
        node.find('.username').first().attr('href') ??
        node.find('.tweet-link').first().attr('href') ??
        '';
      const avatarSrc = node.find('img.avatar').first().attr('src') ?? '';
      const bio = (node.find('.tweet-content').first().text() ?? '')
        .replace(/\s+/g, ' ')
        .trim();

      return {
        username,
        displayName,
        profileUrl: toAbsoluteUrl(nitterBaseUrl, profileHref),
        avatarUrl: toAbsoluteUrl(nitterBaseUrl, avatarSrc),
        bio,
      };
    })
    .get()
    .filter((user) => Boolean(user.username));

  const nextHref = $('.show-more a').first().attr('href') ?? '';
  const nextCursor = parseCursorFromHref(nextHref);

  return { users, nextCursor };
}
