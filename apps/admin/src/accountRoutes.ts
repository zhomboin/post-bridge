const accountQueryKeys = new Set(['q', 'status', 'page', 'tab']);

export function accountArticlesHref(raw?: string | null) {
  if (!raw || !/^\/(?:account|articles)(?:\?|$)/.test(raw) || raw.includes('#')) return '/account';
  const params = new URLSearchParams(raw.split('?')[1]);
  if ([...params.keys()].some((key) => !accountQueryKeys.has(key) || params.getAll(key).length > 1))
    return '/account';
  params.delete('tab');
  return '/account' + (params.size ? '?' + params : '');
}
