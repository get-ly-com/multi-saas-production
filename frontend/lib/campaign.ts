// Campaign tracking. Social posts share links with utm_ tags; public pages read the campaign back
// from the link people came in by and save it with the lead, contact or chat.

const read = (search: string) => {
  const params = new URLSearchParams(search);
  return (params.get('utm_campaign') || params.get('campaign') || '').trim().slice(0, 100);
};

// The campaign in this page's link, or (for a chat box on someone's website) the page around it
export const campaignFromUrl = () => {
  if (typeof window === 'undefined') return '';
  try {
    const own = read(window.location.search);
    if (own) return own;
    if (window.self !== window.top && document.referrer) return read(new URL(document.referrer).search);
  } catch {
    // No campaign
  }
  return '';
};

// The post's link with utm_source=<platform>&utm_medium=social&utm_campaign=<campaign>. Only when
// there is a link and a campaign; other query parts stay, and a link already tagged is left alone.
export const withTracking = (link: string | null | undefined, platform: string, campaign: string | null | undefined) => {
  const name = (campaign || '').trim();
  if (!link || !name) return link || '';
  try {
    const url = new URL(link);
    if (!/^https?:$/.test(url.protocol)) return link;
    if (url.searchParams.has('utm_source') || url.searchParams.has('utm_campaign')) return link;
    url.searchParams.set('utm_source', platform);
    url.searchParams.set('utm_medium', 'social');
    url.searchParams.set('utm_campaign', name);
    return url.toString();
  } catch {
    return link;
  }
};
