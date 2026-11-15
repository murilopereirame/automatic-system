/** Host pattern matching for the egress allow list. Has no dependencies, so the gateway stays tiny. */

/**
 * True when `host` is covered by one of the patterns:
 *   `*`              everything
 *   `example.com`    exactly that host
 *   `*.example.com`  example.com and all its subdomains
 */
export function hostMatches(host: string, patterns: string[]): boolean {
  const name = host.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) return name === pattern.slice(2) || name.endsWith(pattern.slice(1));
    return name === pattern;
  });
}
